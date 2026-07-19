/**
 * bundle-provider-audit — Task 15 (G-6 bundle audit part 1, PR G-E).
 *
 * Closes the "installed but inert" gap: six chat/LLM bundles
 * (ollama, llamacpp-qwen72b, vllm, vllm-rocm-{kimi,qwen3,qwen3-32b}) shipped
 * with no `providers[]` block, so installing them left a running container
 * with no auto-registered endpoint. Also de-pins three vllm-cuda-* manifests
 * that carried a maintainer-specific paired-instance id in `host` (the #217
 * leak class), and gives the three side-channel bundles (faster-whisper,
 * kokoro-tts, sdxl — wired through STT/TTS profile seeds or a bespoke tool
 * env var, not an LLM `providers[]` entry) an honest `no_auto_provider`
 * reason (the field itself is inert metadata until Task 16 adds contract
 * validation for it).
 *
 * Two of the six originally-flagged bundles (ollama, vllm base) ended up
 * with `no_auto_provider` instead of a `providers[]` block: both have a
 * served model that is genuinely unknowable at manifest-write time (ollama
 * pulls models post-install; vllm's VLLM_MODEL is a required env var with
 * no default), and registering a provider row with an empty models[] list
 * breaks default profile resolution — see resolve-profile.js's
 * firstModelId() returning null with nothing to pick from. See
 * .superpowers/sdd/task-15-report.md for the full investigation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { registerProviderFromManifest, setProviderSyncManager } from "../servers/shared/providers-db.js";

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLES_ROOT = join(APP_ROOT, "bundles");

function manifest(id) {
  return JSON.parse(readFileSync(join(BUNDLES_ROOT, id, "manifest.json"), "utf8"));
}

function compose(id, file = "docker-compose.yml") {
  return readFileSync(join(BUNDLES_ROOT, id, file), "utf8");
}

/** Extract the HOST port from a `ports:` mapping line like `"${VAR}:8003:8000"`. */
function composeHostPort(composeText) {
  const m = composeText.match(/ports:\s*\n\s*-\s*"[^:"]*:(\d+):\d+"/);
  return m ? Number(m[1]) : null;
}

// --- 1. The four bundles with a real, statically-known served model get a
//        providers[] block whose port matches their compose file. ---

const STATIC_PROVIDER_BUNDLES = {
  "llamacpp-qwen72b": { providerId: "crow-swap-qwen72b", modelId: "qwen2.5-72b" },
  "vllm-rocm-kimi": { providerId: "crow-swap-kimi", modelId: "kimi-linear-48b" },
  "vllm-rocm-qwen3": { providerId: "crow-dispatch", modelId: "qwen3-4b" },
  "vllm-rocm-qwen3-32b": { providerId: "crow-mode-a-32b", modelId: "qwen3-32b" },
};

for (const [bundleId, expect] of Object.entries(STATIC_PROVIDER_BUNDLES)) {
  test(`${bundleId}: providers[] block present, port matches compose, model id matches served-model-name/alias`, () => {
    const m = manifest(bundleId);
    assert.ok(Array.isArray(m.providers) && m.providers.length === 1, `${bundleId} must declare exactly one provider`);
    const p = m.providers[0];
    assert.equal(p.id, expect.providerId);
    assert.equal(p.baseUrlTemplate, "http://{host_ip}:{port}/v1");
    assert.ok(Array.isArray(p.models) && p.models.length === 1, `${bundleId} provider must declare exactly one model`);
    assert.equal(p.models[0].id, expect.modelId);

    const hostPort = composeHostPort(compose(bundleId));
    assert.ok(hostPort, `${bundleId} docker-compose.yml must expose a host port`);
    assert.equal(m.port, hostPort, `${bundleId} manifest.port must match the compose-exposed host port`);
  });
}

test("llamacpp-qwen72b / vllm-rocm-kimi share the 8003-swap mutex group and both conflict with crow-chat", () => {
  const qwen72b = manifest("llamacpp-qwen72b").providers[0].models[0];
  const kimi = manifest("vllm-rocm-kimi").providers[0].models[0];
  assert.equal(qwen72b.mutexGroup, "8003-swap");
  assert.equal(kimi.mutexGroup, "8003-swap");
  assert.ok(qwen72b.conflictsWith.includes("crow-chat"));
  assert.ok(kimi.conflictsWith.includes("crow-chat"));
});

// --- 2. ollama + vllm (base): dynamic/unknowable served model → no_auto_provider,
//        NOT an empty providers[] block. ---

for (const bundleId of ["ollama", "vllm"]) {
  test(`${bundleId}: no providers[] block; carries a non-empty no_auto_provider reason`, () => {
    const m = manifest(bundleId);
    assert.equal(m.providers, undefined, `${bundleId} must not ship a providers[] block (served model unknowable at manifest-write time)`);
    assert.equal(typeof m.no_auto_provider, "string");
    assert.ok(m.no_auto_provider.length > 20, `${bundleId} no_auto_provider reason must be a real explanation, not a stub`);
  });
}

// --- 3. Side-channel bundles: non-empty no_auto_provider, no providers[] block. ---

for (const bundleId of ["faster-whisper-server", "kokoro-tts", "sdxl"]) {
  test(`${bundleId}: non-empty no_auto_provider (side-channel wiring, not an LLM providers[] entry)`, () => {
    const m = manifest(bundleId);
    assert.equal(m.providers, undefined, `${bundleId} must not ship an LLM providers[] block`);
    assert.equal(typeof m.no_auto_provider, "string");
    assert.ok(m.no_auto_provider.length > 20, `${bundleId} no_auto_provider reason must be a real explanation, not a stub`);
  });
}

// --- 4. host de-pin: no manifest anywhere under bundles/ still carries the
//        leaked maintainer instance id (#217 leak class, anti-rot). ---

test("no bundle manifest carries the leaked maintainer instance id (49cf71ca878643ba7717f344329266fd)", () => {
  const offenders = [];
  for (const id of readdirSync(BUNDLES_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
    const p = join(BUNDLES_ROOT, id, "manifest.json");
    if (!existsSync(p)) continue;
    if (readFileSync(p, "utf8").includes("49cf71ca878643ba7717f344329266fd")) offenders.push(id);
  }
  assert.deepEqual(offenders, [], `manifests still carrying the leaked instance id: ${offenders.join(", ")}`);
});

test("vllm-cuda-{embed,rerank,vision}: host is 'local', not a pinned instance id", () => {
  for (const id of ["vllm-cuda-embed", "vllm-cuda-rerank", "vllm-cuda-vision"]) {
    assert.equal(manifest(id).host, "local", `${id} manifest.host must be 'local'`);
  }
});

// --- 5. Install-path integration: registerProviderFromManifest (the real
//        seam bundles.js's install() calls after `docker compose up`) writes
//        a provider row with the right base_url — proven against a scratch
//        libsql DB, no docker involved. ---

function freshLibsql() {
  const dir = mkdtempSync(join(tmpdir(), "bundle-provider-audit-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: APP_ROOT,
  });
  const prevDataDir = process.env.CROW_DATA_DIR;
  process.env.CROW_DATA_DIR = dir;
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return {
    db,
    cleanup() {
      setProviderSyncManager(null);
      if (prevDataDir === undefined) delete process.env.CROW_DATA_DIR;
      else process.env.CROW_DATA_DIR = prevDataDir;
      try { db.close(); } catch {}
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function dbRow(db, id) {
  const { rows } = await db.execute({ sql: "SELECT * FROM providers WHERE id = ?", args: [id] });
  return rows[0];
}

test("install path: registering vllm-rocm-qwen3's manifest.providers[0] writes a crow-dispatch row with the right base_url/port/host", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const m = manifest("vllm-rocm-qwen3");
    const providerDef = m.providers[0];
    // Mirrors bundles.js's install-time call exactly: host:"local" (or unset)
    // → hostIp stays the loopback default; port comes from manifest.port.
    const hostIp = "127.0.0.1";
    const result = await registerProviderFromManifest({
      db, manifest: m, providerDef, port: m.port, hostIp,
    });
    assert.equal(result.id, "crow-dispatch");

    const row = await dbRow(db, "crow-dispatch");
    assert.ok(row, "provider row must exist after registration");
    assert.equal(row.base_url, "http://127.0.0.1:8001/v1");
    assert.equal(row.host, "local");
    assert.equal(row.bundle_id, "vllm-rocm-qwen3");
    const models = JSON.parse(row.models);
    assert.equal(models[0].id, "qwen3-4b");
    assert.equal(models[0].priority, "maker_lab");
  } finally { cleanup(); }
});

test("install path: registering vllm-cuda-embed's manifest.providers[0] with host:'local' resolves to loopback, not a peer lookup", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const m = manifest("vllm-cuda-embed");
    assert.equal(m.host, "local", "precondition: host must already be de-pinned");
    const providerDef = m.providers[0];
    const hostIp = "127.0.0.1"; // what bundles.js computes for host:"local" (no getInstance lookup)
    const result = await registerProviderFromManifest({
      db, manifest: m, providerDef, port: m.port, hostIp,
    });
    const row = await dbRow(db, result.id);
    assert.equal(row.base_url, "http://127.0.0.1:9100/v1");
    assert.equal(row.host, "local");
  } finally { cleanup(); }
});

// --- 6. Registry drift: providers/no_auto_provider/host changes must be
//        reflected in the committed registry/add-ons.json (build-registry
//        spreads the full manifest through, no field allowlist). ---

test("committed registry/add-ons.json carries the new providers[]/no_auto_provider fields (no drift)", async () => {
  const { buildRegistry, formatRegistry } = await import("../scripts/build-registry.mjs");
  const { registry } = buildRegistry();
  const generated = formatRegistry(registry);
  const current = readFileSync(join(APP_ROOT, "registry", "add-ons.json"), "utf8");
  assert.equal(current, generated, "registry drift — run `npm run build-registry`");

  const dispatch = registry["add-ons"].find((e) => e.id === "vllm-rocm-qwen3");
  assert.equal(dispatch.providers[0].id, "crow-dispatch");
  const ollama = registry["add-ons"].find((e) => e.id === "ollama");
  assert.equal(typeof ollama.no_auto_provider, "string");
});
