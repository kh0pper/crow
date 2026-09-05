import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { adoptModel, registerModel, hashFileSha256, AdoptMismatchError } from "../servers/gateway/models/manager.js";
import { loadState, saveState } from "../servers/gateway/models/state.js";
import { setProviderSyncManager } from "../servers/shared/providers-db.js";

function freshLibsql() {
  const dir = mkdtempSync(join(tmpdir(), "models-adopt-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const prevDataDir = process.env.CROW_DATA_DIR;
  process.env.CROW_DATA_DIR = dir;
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return {
    dir, db,
    cleanup() {
      setProviderSyncManager(null);
      if (prevDataDir === undefined) delete process.env.CROW_DATA_DIR;
      else process.env.CROW_DATA_DIR = prevDataDir;
      try { db.close(); } catch {}
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const sha = (buf) => createHash("sha256").update(buf).digest("hex");

function catalogFor(files) {
  // files: { primary: Buffer, mmproj?: Buffer }
  return { version: 1, runtime: { name: "llama.cpp", release: "b10068", assets: {} }, models: [{
    id: "adopt-test", family: "T", lab: "L", hf_repo: "t/adopt-GGUF", license: "apache-2.0", gated: false, task: "chat", context_len: 8192,
    min_runtime_version: "b10068", default_quant: "Q8_0", tags: [], first_run_default: true,
    companions: files.mmproj ? [{ kind: "mmproj", file: "mmproj-F16.gguf", size_mb: files.mmproj.length / 1e6, sha256: sha(files.mmproj) }] : [],
    quants: [{ file: "adopt-test-Q8_0.gguf", quant: "Q8_0", size_mb: files.primary.length / 1e6, min_ram_mb: 1, min_vram_mb: 0, sha256: sha(files.primary) }],
  }] };
}
const OPTS = (h) => ({ db: h.db, dir: h.dir, allocatePortFn: async (s, id) => { s.reservations[id] = { port: 18170, owner: {} }; return 18170; },
  ownInstanceIdFn: () => "inst-A", tailnetIpFn: () => "100.118.41.122", gatewayPortFn: () => 3001 });

test("hashFileSha256 streams a file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "adopt-"));
  try {
    writeFileSync(join(dir, "f"), "hello");
    assert.equal(await hashFileSha256(join(dir, "f")), sha(Buffer.from("hello")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("adoptModel: verified adoption registers with path/adopted/verified and never copies", async () => {
  const h = freshLibsql();
  const weights = mkdtempSync(join(tmpdir(), "weights-"));
  try {
    const primary = Buffer.from("primary-bytes"), mmproj = Buffer.from("mmproj-bytes");
    writeFileSync(join(weights, "big.gguf"), primary); writeFileSync(join(weights, "proj.gguf"), mmproj);
    const r = await adoptModel({ modelId: "adopt-test", quant: "Q8_0", path: join(weights, "big.gguf"), companionPaths: { mmproj: join(weights, "proj.gguf") },
      catalog: catalogFor({ primary, mmproj }), ...OPTS(h) });
    assert.equal(r.adopted, true); assert.equal(r.verified, true);
    const entry = loadState(h.dir).registry["adopt-test@Q8_0"];
    assert.equal(entry.path, join(weights, "big.gguf"));
    assert.equal(entry.adopted, true);
    assert.deepEqual(entry.companions, [{ kind: "mmproj", file: "proj.gguf", path: join(weights, "proj.gguf") }]);
    assert.equal(statSync(join(weights, "big.gguf")).size, primary.length, "file untouched");
  } finally { h.cleanup(); rmSync(weights, { recursive: true, force: true }); }
});

test("adoptModel: sha mismatch refuses, naming the expected quant and file", async () => {
  const h = freshLibsql();
  const weights = mkdtempSync(join(tmpdir(), "weights-"));
  try {
    writeFileSync(join(weights, "big.gguf"), "wrong-bytes");
    await assert.rejects(adoptModel({ modelId: "adopt-test", quant: "Q8_0", path: join(weights, "big.gguf"), catalog: catalogFor({ primary: Buffer.from("primary-bytes") }), ...OPTS(h) }),
      (e) => e instanceof AdoptMismatchError && e.code === "ADOPT_SHA_MISMATCH" && /Q8_0/.test(e.message) && /adopt-test-Q8_0\.gguf/.test(e.message));
    assert.equal(Object.keys(loadState(h.dir).registry).length, 0, "nothing registered");
  } finally { h.cleanup(); rmSync(weights, { recursive: true, force: true }); }
});

test("adoptModel: missing companion path refuses; missing primary refuses", async () => {
  const h = freshLibsql();
  const weights = mkdtempSync(join(tmpdir(), "weights-"));
  try {
    const primary = Buffer.from("primary-bytes"), mmproj = Buffer.from("mmproj-bytes");
    writeFileSync(join(weights, "big.gguf"), primary);
    await assert.rejects(adoptModel({ modelId: "adopt-test", quant: "Q8_0", path: join(weights, "big.gguf"), catalog: catalogFor({ primary, mmproj }), ...OPTS(h) }),
      (e) => e.code === "ADOPT_COMPANION_MISSING" && /mmproj/.test(e.message));
    await assert.rejects(adoptModel({ modelId: "adopt-test", quant: "Q8_0", path: join(weights, "nope.gguf"), catalog: catalogFor({ primary }), ...OPTS(h) }),
      (e) => e.code === "ADOPT_FILE_MISSING");
  } finally { h.cleanup(); rmSync(weights, { recursive: true, force: true }); }
});

test("adoptModel: allowUnverified matches by size (0.5%) and marks verified:false; size mismatch refuses", async () => {
  const h = freshLibsql();
  const weights = mkdtempSync(join(tmpdir(), "weights-"));
  try {
    const primary = Buffer.alloc(10_000, 1);
    writeFileSync(join(weights, "big.gguf"), Buffer.alloc(10_000, 2)); // same size, different bytes
    const r = await adoptModel({ modelId: "adopt-test", quant: "Q8_0", path: join(weights, "big.gguf"), catalog: catalogFor({ primary }), allowUnverified: true, ...OPTS(h) });
    assert.equal(r.verified, false);
    assert.equal(loadState(h.dir).registry["adopt-test@Q8_0"].verified, false);
  } finally { h.cleanup(); rmSync(weights, { recursive: true, force: true }); }
  const h2 = freshLibsql();
  const w2 = mkdtempSync(join(tmpdir(), "weights-"));
  try {
    writeFileSync(join(w2, "big.gguf"), Buffer.alloc(5_000, 2));
    await assert.rejects(adoptModel({ modelId: "adopt-test", quant: "Q8_0", path: join(w2, "big.gguf"), catalog: catalogFor({ primary: Buffer.alloc(10_000, 1) }), allowUnverified: true, ...OPTS(h2) }),
      (e) => e.code === "ADOPT_SIZE_MISMATCH");
  } finally { h2.cleanup(); rmSync(w2, { recursive: true, force: true }); }
});

test("adoptModel: passes providerId/launch/mutexGroup through to registerModel", async () => {
  const h = freshLibsql();
  const weights = mkdtempSync(join(tmpdir(), "weights-"));
  try {
    const primary = Buffer.from("primary-bytes");
    writeFileSync(join(weights, "big.gguf"), primary);
    const r = await adoptModel({ modelId: "adopt-test", quant: "Q8_0", path: join(weights, "big.gguf"), catalog: catalogFor({ primary }),
      providerId: "crow-chat", launch: { ctx: 4096 }, mutexGroup: "crow-strix-vram", defaultMember: true, ...OPTS(h) });
    assert.equal(r.id, "crow-chat");
    assert.equal(r.gpuPolicy.launch.ctx, 4096);
    assert.equal(r.gpuPolicy.mutexGroup, "crow-strix-vram");
  } finally { h.cleanup(); rmSync(weights, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// Final review I2: a re-register must NOT carry the previous registry entry
// over wholesale. Only `registeredAt` and the `wasLive`/`lastStoppedAt`
// runtime markers survive; `path`/`adopted`/`verified`/`companions` are
// re-derived from the call that is registering now.
// ---------------------------------------------------------------------------

test("I2: adopt then re-register (download shape) drops path/adopted and restores blob-dir companions", async () => {
  const h = freshLibsql();
  const weights = mkdtempSync(join(tmpdir(), "weights-"));
  try {
    const primary = Buffer.from("primary-bytes"), mmproj = Buffer.from("mmproj-bytes");
    writeFileSync(join(weights, "big.gguf"), primary); writeFileSync(join(weights, "proj.gguf"), mmproj);
    const catalog = catalogFor({ primary, mmproj });

    await adoptModel({ modelId: "adopt-test", quant: "Q8_0", path: join(weights, "big.gguf"),
      companionPaths: { mmproj: join(weights, "proj.gguf") }, catalog, ...OPTS(h) });
    const adopted = loadState(h.dir).registry["adopt-test@Q8_0"];
    assert.equal(adopted.adopted, true);

    // The same catalogId+quant registered the ordinary (downloaded) way.
    await registerModel({ modelId: "adopt-test", quant: "Q8_0", catalog, ...OPTS(h) });
    const entry = loadState(h.dir).registry["adopt-test@Q8_0"];
    assert.equal(entry.adopted, undefined, "the stale adopted marker is gone");
    assert.equal(entry.path, undefined, "the stale absolute path is gone — these weights live in the blob dir now");
    assert.equal(entry.verified, undefined);
    assert.deepEqual(entry.companions, [{ kind: "mmproj", file: "adopt-test--mmproj-F16.gguf" }], "companions are the planned blob-dir ones, with no absolute path");
    assert.equal(entry.registeredAt, adopted.registeredAt, "the original install date is the one field that carries over");
  } finally { h.cleanup(); rmSync(weights, { recursive: true, force: true }); }
});

test("I2: download then adopt gives path/adopted, and the runtime markers survive both directions", async () => {
  const h = freshLibsql();
  const weights = mkdtempSync(join(tmpdir(), "weights-"));
  try {
    const primary = Buffer.from("primary-bytes"), mmproj = Buffer.from("mmproj-bytes");
    writeFileSync(join(weights, "big.gguf"), primary); writeFileSync(join(weights, "proj.gguf"), mmproj);
    const catalog = catalogFor({ primary, mmproj });

    await registerModel({ modelId: "adopt-test", quant: "Q8_0", catalog, ...OPTS(h) });
    // gpu-orchestrator.js stamps these on the entry while the model is live.
    const seeded = loadState(h.dir);
    seeded.registry["adopt-test@Q8_0"].wasLive = true;
    seeded.registry["adopt-test@Q8_0"].lastStoppedAt = null;
    saveState(h.dir, seeded);

    await adoptModel({ modelId: "adopt-test", quant: "Q8_0", path: join(weights, "big.gguf"),
      companionPaths: { mmproj: join(weights, "proj.gguf") }, catalog, ...OPTS(h) });
    const entry = loadState(h.dir).registry["adopt-test@Q8_0"];
    assert.equal(entry.adopted, true);
    assert.equal(entry.path, join(weights, "big.gguf"));
    assert.equal(entry.wasLive, true, "the orchestrator's runtime marker is preserved across a re-register");
    assert.equal(entry.lastStoppedAt, null);
  } finally { h.cleanup(); rmSync(weights, { recursive: true, force: true }); }
});
