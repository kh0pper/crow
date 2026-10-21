/**
 * The glasses' dedicated vision model: the llamacpp-vulkan-qwen3-vl-4b bundle.
 *
 * Guards the shape that keeps it a small, always-on, self-contained
 * specialist:
 *   - one provider (`crow-vision`) whose model is a vision model, so the
 *     vision role's capability check can find it;
 *   - NO mutex group anywhere: the bundle never joins the chat model's VRAM
 *     group, so starting it can never evict the resident chat model and the
 *     chat model's swaps never stop it;
 *   - loopback-only bind (every consumer is this gateway);
 *   - the compose serves exactly the catalog's sha-pinned files, so a later
 *     catalog conversion can adopt the weights in place.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { registerProviderFromManifest, setProviderSyncManager } from "../servers/shared/providers-db.js";

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE_ID = "llamacpp-vulkan-qwen3-vl-4b";
const BUNDLE_DIR = join(APP_ROOT, "bundles", BUNDLE_ID);
const manifest = () => JSON.parse(readFileSync(join(BUNDLE_DIR, "manifest.json"), "utf8"));
const compose = () => readFileSync(join(BUNDLE_DIR, "docker-compose.yml"), "utf8");
const catalogEntry = () => JSON.parse(readFileSync(join(APP_ROOT, "registry", "model-catalog.json"), "utf8"))
  .models.find((m) => m.id === "qwen3-vl-4b-instruct");

/** The value that follows `flag` in the compose `command:` list. */
function commandArg(text, flag) {
  const lines = text.split("\n").map((l) => l.trim());
  const i = lines.findIndex((l) => l === `- ${flag}` || l === `- "${flag}"`);
  if (i === -1) return null;
  return lines[i + 1].replace(/^-\s*/, "").replace(/^"|"$/g, "");
}

test("manifest: one crow-vision provider serving a vision model, versioned, gfx1151-only", () => {
  const m = manifest();
  assert.equal(m.id, BUNDLE_ID);
  assert.equal(m.type, "bundle");
  assert.equal(m.host, "local");
  assert.equal(m.inference, true);
  assert.match(String(m.version), /^\d+\.\d+\.\d+$/);
  assert.deepEqual(m.requires.gpu_arch, ["gfx1151"]);
  assert.equal(m.providers.length, 1);
  const p = m.providers[0];
  assert.equal(p.id, "crow-vision");
  assert.equal(p.baseUrlTemplate, "http://{host_ip}:{port}/v1");
  assert.equal(p.models.length, 1);
  assert.equal(p.models[0].id, "qwen3-vl-4b-instruct");
  assert.equal(p.models[0].task, "vision");
  assert.deepEqual(p.models[0].input, ["text", "image"]);
});

test("manifest + compose: no mutex group anywhere, so it never evicts (or is evicted by) the chat model", () => {
  const m = manifest();
  const text = JSON.stringify(m);
  assert.ok(!/mutexGroup|mutex_group|conflictsWith|defaultMember/.test(text), "the vision bundle must not declare any VRAM group");
  assert.ok(!/crow-strix-vram/.test(compose()), "the compose must not reference the chat group");
});

test("compose: loopback-only port that matches manifest.port, always-on restart policy", () => {
  const c = compose();
  const ports = [...c.matchAll(/^\s*-\s*"([^"]+:\d+:\d+)"\s*$/gm)].map((x) => x[1]);
  assert.deepEqual(ports, ["127.0.0.1:8012:8000"]);
  assert.equal(manifest().port, 8012);
  assert.match(c, /restart:\s*unless-stopped/);
  assert.match(c, /container_name:\s*llamacpp-vulkan-qwen3-vl-4b\b/);
});

test("compose: serves the catalog's Q8_0 file and mmproj companion under the provider's model id", () => {
  const c = compose();
  const entry = catalogEntry();
  assert.ok(entry, "catalog entry qwen3-vl-4b-instruct must exist");
  assert.equal(entry.task, "vision");
  const q8 = entry.quants.find((q) => q.quant === "Q8_0");
  const mmproj = entry.companions.find((x) => x.kind === "mmproj");
  assert.equal(commandArg(c, "-m"), `/models/qwen3-vl-4b-instruct/${q8.file}`);
  assert.equal(commandArg(c, "--mmproj"), `/models/qwen3-vl-4b-instruct/${mmproj.file}`);
  assert.equal(commandArg(c, "--alias"), manifest().providers[0].models[0].id);
  // The sha256s in the compose comment are the catalog's (adopt-in-place later).
  assert.ok(c.includes(q8.sha256), "compose comment must carry the Q8_0 sha256");
  assert.ok(c.includes(mmproj.sha256), "compose comment must carry the mmproj sha256");
});

test("compose: names the host env file, so `crow bundle install` links it as the bundle .env (GIDs, LLM_CACHE)", () => {
  const c = compose();
  assert.match(c, /env_file:\s*\n\s*-\s*\$\{HOME\}\/\.crow\/env\/rocm\.env/);
  for (const v of ["VIDEO_GID", "RENDER_GID", "LLM_CACHE"]) assert.ok(c.includes("${" + v + "}"), v);
});

test("compose: bounded context and image size (one photo + a question fits; a 12 MP photo can't blow the context)", () => {
  const c = compose();
  assert.equal(commandArg(c, "-c"), "8192");
  assert.equal(commandArg(c, "-np"), "1");
  const imageMax = Number(commandArg(c, "--image-max-tokens"));
  assert.ok(imageMax > 0 && imageMax <= 2048, "--image-max-tokens must cap each image");
  assert.ok(imageMax < 8192, "an image must leave room for the prompt and the answer");
});

test("catalog: the vision entry no longer claims grackle/vLLM serves it", () => {
  const notes = catalogEntry().notes;
  assert.ok(!/grackle/i.test(notes), "stale grackle claim in the catalog notes");
  assert.ok(!/vLLM/.test(notes), "stale vLLM claim in the catalog notes");
});

test("port-allocation doc carries the 8012 loopback row", () => {
  const doc = readFileSync(join(APP_ROOT, "docs", "developers", "port-allocation.md"), "utf8");
  assert.match(doc, /^\| 8012 \| 127\.0\.0\.1 \| llamacpp-vulkan-qwen3-vl-4b /m);
});

test("install path: registering the manifest writes crow-vision at loopback with no gpu_policy (no group)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vision-bundle-"));
  const prev = process.env.CROW_DATA_DIR;
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: APP_ROOT });
  process.env.CROW_DATA_DIR = dir;
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  try {
    const m = manifest();
    await registerProviderFromManifest({ db, manifest: m, providerDef: m.providers[0], port: m.port, hostIp: "127.0.0.1" });
    const { rows } = await db.execute({ sql: "SELECT * FROM providers WHERE id = ?", args: ["crow-vision"] });
    const row = rows[0];
    assert.ok(row);
    assert.equal(row.base_url, "http://127.0.0.1:8012/v1");
    assert.equal(row.bundle_id, BUNDLE_ID);
    assert.equal(row.gpu_policy, null, "no gpu_policy → no mutex group, never part of a swap");
    const models = JSON.parse(row.models);
    assert.equal(models[0].task, "vision");
    assert.deepEqual(models[0].input, ["text", "image"]);
  } finally {
    setProviderSyncManager(null);
    if (prev === undefined) delete process.env.CROW_DATA_DIR; else process.env.CROW_DATA_DIR = prev;
    try { db.close(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});
