/**
 * Model roles Phase 1, Task 6: the consumers with their own default
 * (smart-router tiers, embed, rerank, the bot safety classifier) honour a
 * role only when someone CHOSE it. A seeded binding changes nothing.
 *
 * One scratch init-db DB, read through both clients the real code uses:
 * @libsql/client (gateway) and better-sqlite3 (bridge).
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "roles-jobs-"));
process.env.CROW_DATA_DIR = dir;
delete process.env.CROW_DB_PATH;
for (const v of ["CODE", "FAST", "DEEP", "VISION"]) delete process.env[`CROW_SMART_ROUTER_${v}`];
delete process.env.CROW_EMBED_PROVIDER;
delete process.env.CROW_RERANK_PROVIDER;

let db, conn, OWN, ownAddresses;
let readBotClassifierSync, getClassifierStatus, selectBotClassifier;
let setBinding, invalidateRoleContext;
let chooseProvider, resolveSmartTierKeys;
let resolveDefaultProvider, resolveDefaultRerankProvider;
let pickProviderByTask, EMBED_TASKS, _resetProviderTaskCacheForTest;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: join(import.meta.dirname, ".."),
  });
  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient();
  conn = new Database(join(dir, "crow.db"));
  ({ readBotClassifierSync } = await import("../scripts/pi-bots/bot-classifier.mjs"));
  ({ getClassifierStatus } = await import("../servers/gateway/dashboard/panels/bot-builder/classifier-status.js"));
  ({ selectBotClassifier } = await import("../servers/shared/bot-bash-policy.js"));
  ({ setBinding, invalidateRoleContext } = await import("../servers/shared/model-roles-store.js"));
  ({ chooseProvider, resolveSmartTierKeys } = await import("../servers/gateway/ai/smart-router.js"));
  ({ resolveDefaultProvider } = await import("../servers/memory/embeddings.js"));
  ({ resolveDefaultRerankProvider } = await import("../servers/memory/rerank.js"));
  ({ pickProviderByTask, EMBED_TASKS, _resetProviderTaskCacheForTest } = await import("../servers/shared/provider-task.js"));
  const { getOrCreateLocalInstanceId } = await import("../servers/gateway/instance-registry.js");
  OWN = getOrCreateLocalInstanceId();
  const { getOwnAddresses } = await import("../servers/shared/locality.js");
  try { ownAddresses = getOwnAddresses(); } catch { ownAddresses = null; }
});
after(() => { try { conn.close(); } catch {} try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

beforeEach(() => {
  conn.prepare("DELETE FROM providers").run();
  conn.prepare("DELETE FROM dashboard_settings WHERE (key >= 'model_role' AND key < 'model_rolf') OR key IN ('bot_safety_classifier','embed_provider','rerank_provider','feature_flags')").run();
  invalidateRoleContext();
  _resetProviderTaskCacheForTest();
});

const addProvider = (id, url, models, { instanceId = OWN, host = "local", gpuPolicy = { alwaysResident: true }, disabled = 0 } = {}) => {
  conn.prepare("INSERT INTO providers (id, base_url, host, models, disabled, instance_id, gpu_policy) VALUES (?,?,?,?,?,?,?)")
    .run(id, url, host, JSON.stringify(models), disabled, instanceId, JSON.stringify(gpuPolicy));
  invalidateRoleContext();
};
const setRaw = (key, value) => {
  conn.prepare("INSERT OR REPLACE INTO dashboard_settings (key, value) VALUES (?, ?)").run(key, value);
  invalidateRoleContext();
};
const seed = (roleId, model) => setRaw("model_role." + roleId, JSON.stringify({ model, seeded: true, at: new Date().toISOString() }));
const rawRows = () => conn.prepare("SELECT id, base_url, host, provider_type, models, disabled, gpu_policy, instance_id FROM providers").all();
const autoPick = () => selectBotClassifier({ setting: null, providers: rawRows(), ownAddresses, ownInstanceId: OWN });
const statusOf = (sel) => ({ state: "ready", providerId: sel.providerId || sel.where, model: sel.model, source: sel.source, where: sel.where, here: sel.here });

const CLS = [{ id: "qwen3.5-4b" }];

// ---- classifier ------------------------------------------------------------

test("seeded quick never becomes the classifier", async () => {
  addProvider("local-cls", "http://127.0.0.1:8099/v1", CLS);
  seed("quick", "local-cls/qwen3.5-4b");
  const want = autoPick();
  assert.equal(want.source, "auto");
  assert.deepEqual(readBotClassifierSync(conn), want);
  assert.deepEqual(await getClassifierStatus(db, { probe: false }), statusOf(want));
});

test("chosen safety role takes effect (both readers, distinct from the auto pick)", async () => {
  addProvider("local-cls", "http://127.0.0.1:8099/v1", CLS);
  addProvider("local-cls2", "http://127.0.0.1:8098/v1", CLS);

  const bot0 = readBotClassifierSync(conn);
  const gw0 = await getClassifierStatus(db, { probe: false });
  assert.equal(bot0.providerId, "local-cls"); assert.equal(bot0.source, "auto");
  assert.equal(gw0.providerId, "local-cls"); assert.equal(gw0.source, "auto");

  assert.deepEqual(await setBinding(db, "safety", { model: "local-cls2/qwen3.5-4b" }), { ok: true });
  const bot = readBotClassifierSync(conn);
  assert.equal(bot.ok, true);
  assert.equal(bot.source, "role");
  assert.equal(bot.providerId, "local-cls2");
  assert.equal(bot.url, "http://127.0.0.1:8098/v1");
  const gw = await getClassifierStatus(db, { probe: false });
  assert.equal(gw.state, "ready");
  assert.equal(gw.source, "role");
  assert.equal(gw.providerId, "local-cls2");
  assert.equal(gw.model, "qwen3.5-4b");
});

test("door to cloud refused for classifier", async () => {
  addProvider("local-cls", "http://127.0.0.1:8099/v1", CLS);
  addProvider("door", "http://127.0.0.1:3001/llm/p/cloud-a/v1", CLS, { gpuPolicy: { door_forward: true } });
  addProvider("cloud-a", "https://api.example.com/v1", CLS, { host: "cloud", gpuPolicy: {} });
  assert.deepEqual(await setBinding(db, "safety", { model: "door/qwen3.5-4b" }), { ok: true });
  const want = autoPick();
  const bot = readBotClassifierSync(conn);
  assert.notEqual(bot.source, "role");
  assert.deepEqual(bot, want);
  const gw = await getClassifierStatus(db, { probe: false });
  assert.notEqual(gw.source, "role");
  assert.deepEqual(gw, statusOf(want));
});

test("operator setting beats role", async () => {
  addProvider("local-cls", "http://127.0.0.1:8099/v1", CLS);
  addProvider("local-cls2", "http://127.0.0.1:8098/v1", CLS);
  await setBinding(db, "safety", { model: "local-cls2/qwen3.5-4b" });
  setRaw("bot_safety_classifier", "local-cls/qwen3.5-4b");
  const bot = readBotClassifierSync(conn);
  assert.equal(bot.source, "setting"); assert.equal(bot.providerId, "local-cls");
  const gw = await getClassifierStatus(db, { probe: false });
  assert.equal(gw.source, "setting"); assert.equal(gw.providerId, "local-cls");
});

// Kevin's ruling: safety's fallback is []. A broken chosen classifier falls to
// the automatic pick, never to everyday. `everyday` is bound to a model the
// classifier WOULD accept (local-cls2), so any leak through it shows up.
const PEER = "b".repeat(32);
for (const [name, setup, model] of [
  ["(a) an unconfigured model", () => {}, "local-cls/not-served"],
  ["(b) an own row off the tailnet", () => addProvider("local-lan", "http://192.168.200.7:8099/v1", CLS), "local-lan/qwen3.5-4b"],
  ["(c) a foreign-instance row (host is the peer id)", () => addProvider("peer-cls", "http://127.0.0.1:8097/v1", CLS, { host: PEER, instanceId: PEER }), "peer-cls/qwen3.5-4b"],
  ["(c') a peer-written row (instance_id only)", () => addProvider("peer-cls", "http://127.0.0.1:8097/v1", CLS, { instanceId: PEER }), "peer-cls/qwen3.5-4b"],
]) {
  test(`broken chosen safety falls to the auto pick, never everyday: ${name}`, async () => {
    addProvider("local-cls", "http://127.0.0.1:8099/v1", CLS);
    addProvider("local-cls2", "http://127.0.0.1:8098/v1", CLS);
    setup();
    assert.deepEqual(await setBinding(db, "everyday", { model: "local-cls2/qwen3.5-4b" }), { ok: true });
    assert.deepEqual(await setBinding(db, "safety", { model }), { ok: true });
    const want = autoPick();
    assert.equal(want.providerId, "local-cls");
    const bot = readBotClassifierSync(conn);
    assert.notEqual(bot.source, "role");
    assert.notEqual(bot.providerId, "local-cls2");
    assert.deepEqual(bot, want);
    const gw = await getClassifierStatus(db, { probe: false });
    assert.notEqual(gw.source, "role");
    assert.notEqual(gw.providerId, "local-cls2");
    assert.deepEqual(gw, statusOf(want));
  });
}

// ---- smart-router ----------------------------------------------------------

const routerProviders = () => [
  { id: "crow-voice", models: [{ id: "qwen3.5-4b" }], disabled: false },
  { id: "local-voice", models: [{ id: "m1" }, { id: "m2" }], disabled: false },
];
const fast = async () => chooseProvider({
  db, convId: 1, content: "/fast hi", attachments: null, currentProvider: null, currentModel: null,
  autoRules: null, providers: routerProviders(), tierKeys: await resolveSmartTierKeys(db),
});

test("smart-router ignores a distinct seed, honours the chosen binding", async () => {
  setRaw("feature_flags", JSON.stringify({ smart_chat: true }));
  addProvider("crow-voice", "http://127.0.0.1:8011/v1", [{ id: "qwen3.5-4b" }]);
  addProvider("local-voice", "http://127.0.0.1:8012/v1", [{ id: "m1" }, { id: "m2" }]);
  seed("quick", "local-voice/m2");
  let r = await fast();
  assert.deepEqual({ provider_id: r.provider_id, model_id: r.model_id }, { provider_id: "crow-voice", model_id: "qwen3.5-4b" });
  await setBinding(db, "quick", { model: "local-voice/m2" });
  r = await fast();
  assert.deepEqual({ provider_id: r.provider_id, model_id: r.model_id }, { provider_id: "local-voice", model_id: "m2" });
});

test("CROW_SMART_ROUTER_FAST beats role", async () => {
  addProvider("local-voice", "http://127.0.0.1:8012/v1", [{ id: "m1" }, { id: "m2" }]);
  await setBinding(db, "quick", { model: "local-voice/m2" });
  assert.equal((await resolveSmartTierKeys(db, { env: {} })).fast, "local-voice/m2");
  assert.equal((await resolveSmartTierKeys(db, { env: { CROW_SMART_ROUTER_FAST: "local-chat" } })).fast, null);
});

// ---- embed / rerank --------------------------------------------------------

const embedProviders = () => {
  addProvider("emb-a", "http://127.0.0.1:8201/v1", [{ id: "a1", task: "embed" }]);
  addProvider("emb-b", "http://127.0.0.1:8202/v1", [{ id: "e1", task: "embed" }, { id: "e2", task: "embed" }]);
};
async function withEnv(name, value, fn) {
  const old = process.env[name];
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
  try { return await fn(); } finally { if (old === undefined) delete process.env[name]; else process.env[name] = old; }
}

test("CROW_EMBED_PROVIDER beats role", async () => {
  embedProviders();
  await setBinding(db, "embed", { model: "emb-b/e1" });
  assert.equal(await withEnv("CROW_EMBED_PROVIDER", "emb-a", resolveDefaultProvider), "emb-a");
});

test("embed_provider setting beats role", async () => {
  embedProviders();
  await setBinding(db, "embed", { model: "emb-b/e1" });
  setRaw("embed_provider", "emb-a");
  assert.equal(await resolveDefaultProvider(), "emb-a");
});

test("embed role used; a model the provider would not serve first is logged once", async (t) => {
  embedProviders();
  await setBinding(db, "embed", { model: "emb-b/e1" });
  const warns = [];
  t.mock.method(console, "warn", (...a) => warns.push(a.join(" ")));
  assert.equal(await resolveDefaultProvider(), "emb-b");
  assert.equal(warns.length, 0);

  await setBinding(db, "embed", { model: "emb-b/e2" });
  _resetProviderTaskCacheForTest();
  assert.equal(await resolveDefaultProvider(), "emb-b");
  _resetProviderTaskCacheForTest();
  assert.equal(await resolveDefaultProvider(), "emb-b");
  const hits = warns.filter((w) => w.includes("[roles] embed names e2, but emb-b serves e1 for this task"));
  assert.equal(hits.length, 1, JSON.stringify(warns));
});

test("embed unbound unchanged; a seeded embed is ignored", async () => {
  embedProviders();
  const want = pickProviderByTask(rawRows(), EMBED_TASKS);
  assert.equal(want, "emb-a");
  assert.equal(await resolveDefaultProvider(), want);
  seed("embed", "emb-b/e1");
  _resetProviderTaskCacheForTest();
  assert.equal(await resolveDefaultProvider(), want);
});

test("rerank role used (need score)", async () => {
  addProvider("rr-a", "http://127.0.0.1:8301/v1", [{ id: "r1", task: "rerank" }]);
  addProvider("rr-b", "http://127.0.0.1:8302/v1", [{ id: "r2", task: "rerank" }]);
  assert.equal(await resolveDefaultRerankProvider(), "rr-a");
  await setBinding(db, "rerank", { model: "rr-b/r2" });
  _resetProviderTaskCacheForTest();
  assert.equal(await resolveDefaultRerankProvider(), "rr-b");
});
