// tests/embed-rerank-defaults.test.js
// Host-neutral defaults against a REAL temp libsql DB (never the live one).
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { _resetProviderTaskCacheForTest } from "../servers/shared/provider-task.js";
import { resolveDefaultProvider } from "../servers/memory/embeddings.js";
import { resolveDefaultRerankProvider, rerank } from "../servers/memory/rerank.js";

const dir = mkdtempSync(join(tmpdir(), "embed-rerank-defaults-"));
const dbPath = join(dir, "crow.db");
const prevDb = process.env.CROW_DB_PATH;
process.env.CROW_DB_PATH = dbPath;
const prevModelsJson = process.env.CROW_MODELS_JSON;
process.env.CROW_MODELS_JSON = ""; // hermetic: ignore any real ~/.pi/agent/models.json
const saved = {};
for (const k of ["CROW_EMBED_PROVIDER", "CROW_RERANK_PROVIDER"]) saved[k] = process.env[k];
after(() => {
  if (prevDb === undefined) delete process.env.CROW_DB_PATH; else process.env.CROW_DB_PATH = prevDb;
  if (prevModelsJson === undefined) delete process.env.CROW_MODELS_JSON; else process.env.CROW_MODELS_JSON = prevModelsJson;
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(dir, { recursive: true, force: true });
});

async function seed(rows, settings = {}) {
  const db = createDbClient(dbPath);
  try {
    await db.execute("CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, base_url TEXT, api_key TEXT, models TEXT, gpu_policy TEXT, disabled INTEGER DEFAULT 0)");
    await db.execute("CREATE TABLE IF NOT EXISTS dashboard_settings (key TEXT PRIMARY KEY, value TEXT)");
    await db.execute("DELETE FROM providers");
    await db.execute("DELETE FROM dashboard_settings");
    for (const [id, task, disabled = 0, baseUrl = "http://127.0.0.1:1/v1"] of rows) {
      await db.execute({ sql: "INSERT INTO providers (id, base_url, models, disabled) VALUES (?, ?, ?, ?)", args: [id, baseUrl, JSON.stringify([{ id: "m-" + id, task }]), disabled] });
    }
    for (const [k, v] of Object.entries(settings)) {
      await db.execute({ sql: "INSERT INTO dashboard_settings (key, value) VALUES (?, ?)", args: [k, v] });
    }
  } finally { db.close?.(); }
}

beforeEach(() => {
  _resetProviderTaskCacheForTest();
  delete process.env.CROW_EMBED_PROVIDER;
  delete process.env.CROW_RERANK_PROVIDER;
});

test("embed: two enabled embed rows -> lowest id; disabling it -> the other", async () => {
  await seed([["grackle-embed", "embed"], ["crow-embed", "embed"], ["crow-chat", "chat"]]);
  assert.equal(await resolveDefaultProvider(), "crow-embed");
  _resetProviderTaskCacheForTest();
  await seed([["grackle-embed", "embed"], ["crow-embed", "embed", 1]]);
  assert.equal(await resolveDefaultProvider(), "grackle-embed");
});

test("embed: dashboard_settings.embed_provider wins; whitespace value ignored", async () => {
  await seed([["crow-embed", "embed"]], { embed_provider: "custom-embed" });
  assert.equal(await resolveDefaultProvider(), "custom-embed");
  _resetProviderTaskCacheForTest();
  await seed([["crow-embed", "embed"]], { embed_provider: "  " });
  assert.equal(await resolveDefaultProvider(), "crow-embed");
});

test("embed: no embed-task rows -> null", async () => {
  await seed([["crow-chat", "chat"]]);
  assert.equal(await resolveDefaultProvider(), null);
});

test("rerank: 'score'-tagged row resolves; env override wins", async () => {
  await seed([["zz-rerank", "score"], ["aa-rerank", "rerank"]]);
  assert.equal(await resolveDefaultRerankProvider(), "aa-rerank");
  _resetProviderTaskCacheForTest();
  await seed([["only-score", "score"]]);
  assert.equal(await resolveDefaultRerankProvider(), "only-score");
  process.env.CROW_RERANK_PROVIDER = "env-rerank";
  assert.equal(await resolveDefaultRerankProvider(), "env-rerank");
});

test("rerank: a DB-only task-resolved provider IS called (stubbed fetch) and reorders", async () => {
  await seed([["db-rerank", "score", 0, "http://127.0.0.1:9/v1"]]);
  const origFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push(String(url));
    return new Response(JSON.stringify({ results: [{ index: 2, relevance_score: 0.9 }, { index: 0, relevance_score: 0.5 }, { index: 1, relevance_score: 0.1 }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const out = await rerank("q", [{ id: 1, text: "a" }, { id: 2, text: "b" }, { id: 3, text: "c" }], { topK: 3 });
    assert.equal(seen.length, 1, "reranker endpoint must be called");
    assert.match(seen[0], /127\.0\.0\.1:9\/v1\/rerank$/);
    assert.equal(out[0].id, 3);
  } finally { globalThis.fetch = origFetch; }
});

test("rerank: no provider -> candidates unreranked in original order", async () => {
  await seed([["crow-chat", "chat"]]);
  const out = await rerank("q", [{ id: 1, text: "a" }, { id: 2, text: "b" }, { id: 3, text: "c" }], { topK: 2 });
  assert.deepEqual(out.map((c) => c.id), [1, 2]);
});

test("no named-host literals remain in the memory servers", () => {
  for (const f of ["../servers/memory/embeddings.js", "../servers/memory/rerank.js", "../servers/memory/server.js"]) { // smart-router.js is scanned in Task 3
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    assert.doesNotMatch(src, /grackle-(embed|rerank|vision)/, f);
  }
});
