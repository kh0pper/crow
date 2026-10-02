// tests/providers-reconcile-native-guard.test.js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { upsertProvider, syncProvidersFromModelsJson, seedProvidersFromModelsJson, setProviderSyncManager } from "../servers/shared/providers-db.js";

const dir = mkdtempSync(join(tmpdir(), "reconcile-guard-"));
execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: join(import.meta.dirname, "..") });
const prev = { dd: process.env.CROW_DATA_DIR, mj: process.env.CROW_MODELS_JSON };
process.env.CROW_DATA_DIR = dir;
const file = join(dir, "models.json");
process.env.CROW_MODELS_JSON = file;
const db = createDbClient(join(dir, "crow.db"));
setProviderSyncManager(null);
const OWN = new Set(["127.0.0.1", "100.64.9.1"]);

after(() => {
  for (const [k, v] of [["CROW_DATA_DIR", prev.dd], ["CROW_MODELS_JSON", prev.mj]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

async function row(id) {
  const { rows } = await db.execute({ sql: "SELECT * FROM providers WHERE id = ?", args: [id] });
  return rows[0];
}

test("a converted native row is never rebuilt from models.json", async () => {
  const gp = { runtime: "native", catalogId: "qwen3.6-35b-a3b", quant: "UD-Q5_K_XL", port: 18102, owner: "me", mutexGroup: "crow-strix-vram" };
  await upsertProvider(db, { id: "crow-local", baseUrl: "http://100.64.9.1:3001/llm/v1", host: "local", models: [{ id: "qwen3.6-35b-a3b" }], gpuPolicy: gp });
  writeFileSync(file, JSON.stringify({ providers: { "crow-local": { baseUrl: "http://100.64.9.1:8003/v1", apiKey: "none", models: [{ id: "qwen3.6-35b-a3b" }] } } }));
  const res = await syncProvidersFromModelsJson(db, { ownAddrs: OWN });
  assert.equal(res.skipped_native, 1);
  const r = await row("crow-local");
  assert.equal(r.base_url, "http://100.64.9.1:3001/llm/v1", "door kept");
  assert.equal(JSON.parse(r.gpu_policy).runtime, "native", "still native");
});

test("an id listed in $crowManaged is never imported or asserted", async () => {
  writeFileSync(file, JSON.stringify({
    $crowManaged: ["crow-chat"],
    providers: { "crow-chat": { baseUrl: "http://100.64.9.1:3001/llm/p/crow-chat/v1", apiKey: "none", models: [{ id: "qwen3.6-35b-a3b" }] } },
  }));
  const res = await syncProvidersFromModelsJson(db, { ownAddrs: OWN });
  assert.equal(res.skipped_managed, 1);
  assert.equal(await row("crow-chat"), undefined, "the managed entry was not imported as a new row");
});

test("the first-boot seed never imports $crowManaged entries (a DB restore must not re-import M1's output)", async () => {
  const dir2 = mkdtempSync(join(tmpdir(), "seed-guard-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir2 }, stdio: "pipe", cwd: join(import.meta.dirname, "..") });
  const db2 = createDbClient(join(dir2, "crow.db"));
  try {
    writeFileSync(file, JSON.stringify({
      $crowManaged: ["crow-chat"],
      providers: {
        "crow-chat": { baseUrl: "http://100.64.9.1:3001/llm/p/crow-chat/v1", apiKey: "none", models: [{ id: "qwen3.6-35b-a3b" }] },
        "crow-local": { baseUrl: "http://100.64.9.1:8003/v1", apiKey: "none", models: [{ id: "qwen3.6-35b-a3b" }] },
      },
    }));
    const res = await seedProvidersFromModelsJson(db2);
    assert.equal(res.seeded, 1);
    assert.equal(res.skipped_managed, 1);
    const { rows } = await db2.execute("SELECT id FROM providers ORDER BY id");
    assert.deepEqual(rows.map((r) => r.id), ["crow-local"]);
  } finally { try { db2.close(); } catch {} rmSync(dir2, { recursive: true, force: true }); }
});

test("hand-written owned entries still assert as before (no over-exclusion)", async () => {
  writeFileSync(file, JSON.stringify({ providers: { "crow-local-oss": { baseUrl: "http://100.64.9.1:8005/v1", apiKey: "none", models: [{ id: "gpt-oss-120b" }] } } }));
  const res = await syncProvidersFromModelsJson(db, { ownAddrs: OWN });
  assert.equal(res.upserted + res.unchanged, 1);
  assert.ok(await row("crow-local-oss"));
});
