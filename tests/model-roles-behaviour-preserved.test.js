/**
 * Model roles Phase 1, Task 8: the PR's acceptance gate. With only SEEDED
 * bindings (nothing chosen), every runtime consumer resolves exactly as main
 * does. The golden values come from main's code, never from the new code
 * compared with itself: the frozen pre-roles model_resolver copy, and the
 * primitives this branch leaves unchanged (VOICE_ROUTE_DEFAULTS,
 * DEFAULT_ROUTES, selectBotClassifier, pickProviderByTask, EMBED_TASKS,
 * RERANK_TASKS). The seeds are distinct from every default, so a consumer
 * that wrongly honoured a seed would move. A positive control then CHOOSES
 * two bindings and shows the consumers do move.
 *
 * One fresh scratch init-db DB, read through both clients the real code uses;
 * no model server is reached and no pi is spawned.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = join(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "crow-roles-golden-"));
process.env.CROW_DATA_DIR = join(scratch, "data");
process.env.CROW_HOME = join(scratch, "home");
process.env.CROW_APP_ROOT = ROOT;
process.env.PI_MODELS_JSON = join(scratch, "no-such-models.json");
delete process.env.CROW_DB_PATH;
for (const v of ["COMPANION_FAST_MODEL", "COMPANION_ESCALATION_MODEL", "CROW_EMBED_PROVIDER", "CROW_RERANK_PROVIDER",
  ...["CODE", "FAST", "DEEP", "VISION"].map((t) => `CROW_SMART_ROUTER_${t}`)]) delete process.env[v];
execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: ROOT });

const { test, after } = await import("node:test");
const { default: assert } = await import("node:assert/strict");
const { default: Database } = await import("better-sqlite3");
const { createDbClient } = await import("../servers/db.js");
const { getOrCreateLocalInstanceId } = await import("../servers/gateway/instance-registry.js");
const { getOwnAddresses } = await import("../servers/shared/locality.js");
const { listProvidersAll } = await import("../servers/shared/providers-db.js");

// New code under test.
const { seedRoleBindings } = await import("../servers/shared/model-roles-seed.js");
const { setBinding, invalidateRoleContext, resolveRole } = await import("../servers/shared/model-roles-store.js");
const { resolveModel } = await import("../scripts/pi-bots/model_resolver.mjs");
const { resolveVoiceKeys } = await import("../servers/gateway/routes/llm-router.js");
const { chooseProvider, resolveSmartTierKeys, DEFAULT_ROUTES } = await import("../servers/gateway/ai/smart-router.js");
const { resolveDefaultProvider } = await import("../servers/memory/embeddings.js");
const { resolveDefaultRerankProvider } = await import("../servers/memory/rerank.js");
const { readBotClassifierSync } = await import("../scripts/pi-bots/bot-classifier.mjs");
const { getClassifierStatus } = await import("../servers/gateway/dashboard/panels/bot-builder/classifier-status.js");
const { resolveModelSpec } = await import("../bundles/phone/panel/routes.js");

// Main's code: the frozen resolver and the unchanged primitives.
const frozen = await import("./fixtures/model-roles/model_resolver.pre-roles.mjs");
const { VOICE_ROUTE_DEFAULTS } = await import("../servers/shared/voice-route-defaults.js");
const { selectBotClassifier } = await import("../servers/shared/bot-bash-policy.js");
const { pickProviderByTask, EMBED_TASKS, RERANK_TASKS, _resetProviderTaskCacheForTest } = await import("../servers/shared/provider-task.js");

const db = createDbClient();
const conn = new Database(join(process.env.CROW_DATA_DIR, "crow.db"));
conn.pragma("busy_timeout = 10000");
const OWN = getOrCreateLocalInstanceId();
let ownAddresses = null;
try { ownAddresses = getOwnAddresses(); } catch { ownAddresses = null; }

after(() => {
  invalidateRoleContext();
  try { conn.close(); } catch {}
  try { db.close(); } catch {}
  rmSync(scratch, { recursive: true, force: true });
});

// ---- the fixture -------------------------------------------------------------

const VOICE_URL = "http://127.0.0.1:8011/v1";
const PROVIDERS = [
  ["crow-voice", VOICE_URL, [{ id: "qwen3.5-4b" }]],
  ["crow-chat", "http://127.0.0.1:8003/v1", [{ id: "qwen3.6-35b-a3b" }]],
  ["local-voice", "http://127.0.0.1:8012/v1", [{ id: "m1" }, { id: "m2" }]],
  ["local-chat", "http://127.0.0.1:8013/v1", [{ id: "m1" }]],
  ["local-cls", "http://127.0.0.1:8099/v1", [{ id: "qwen3.5-4b" }], OWN],
  ["emb-a", "http://127.0.0.1:8201/v1", [{ id: "e1", task: "embed" }]],
  ["rr-a", "http://127.0.0.1:8301/v1", [{ id: "r1", task: "rerank" }]],
];
for (const [id, url, models, instanceId = null] of PROVIDERS) {
  conn.prepare("INSERT INTO providers (id, base_url, host, models, disabled, instance_id) VALUES (?, ?, 'local', ?, 0, ?)")
    .run(id, url, JSON.stringify(models), instanceId);
}
conn.prepare("INSERT OR REPLACE INTO dashboard_settings (key, value) VALUES ('feature_flags', ?)").run(JSON.stringify({ smart_chat: true }));
invalidateRoleContext();

const BOTS = {
  valid: { models: { default: "local-chat/m1" } },
  invalid: { models: { default: "nope/x" } },
  escalation: { models: { default: "local-chat/m1", escalation: "local-voice/m2" } },
};
const ROUTER_INPUTS = { fast: "/fast hi", code: "/code hi", plain: "hello there" };

// ---- the consumers (the new code) --------------------------------------------

const fresh = () => { invalidateRoleContext(); _resetProviderTaskCacheForTest(); };
const rawRows = () => conn.prepare("SELECT id, base_url, host, provider_type, models, disabled, gpu_policy, instance_id FROM providers").all();
// getClassifierStatus's shape of a selection (probe off), as main's panel reports it.
const statusOf = (sel) => ({ state: "ready", providerId: sel.providerId || sel.where, model: sel.model, source: sel.source, where: sel.where, here: sel.here });

async function consumers() {
  fresh();
  const out = { bots: {}, router: {} };
  for (const [name, def] of Object.entries(BOTS)) {
    for (const escalate of [false, true]) out.bots[`${name}:${escalate}`] = await resolveModel(def, { escalate });
  }
  const vk = await resolveVoiceKeys(db);
  out.voice = { fast: vk.fast, escalate: vk.escalate };
  out.voiceRoles = { fastRole: vk.fastRole, escalateRole: vk.escalateRole };
  const providers = await listProvidersAll(db);
  const tierKeys = await resolveSmartTierKeys(db);
  for (const [name, content] of Object.entries(ROUTER_INPUTS)) {
    const r = await chooseProvider({ db, convId: 1, content, attachments: null, currentProvider: null, currentModel: null, autoRules: null, providers, tierKeys });
    out.router[name] = { provider_id: r.provider_id, model_id: r.model_id };
  }
  out.embed = await resolveDefaultProvider();
  out.rerank = await resolveDefaultRerankProvider();
  out.classifierBot = readBotClassifierSync(conn);
  out.classifierPanel = await getClassifierStatus(db, { probe: false });
  out.phoneLocal = await resolveModelSpec(db, VOICE_ROUTE_DEFAULTS.fast, { local: true });
  out.phoneCloud = await resolveModelSpec(db, VOICE_ROUTE_DEFAULTS.fast);
  return out;
}

// ---- the golden values ("today", from main's code) ---------------------------

async function golden() {
  const out = { bots: {} };
  for (const [name, def] of Object.entries(BOTS)) {
    for (const escalate of [false, true]) out.bots[`${name}:${escalate}`] = await frozen.resolveModel(def, { escalate });
  }
  out.voice = { fast: VOICE_ROUTE_DEFAULTS.fast, escalate: VOICE_ROUTE_DEFAULTS.escalate };
  const chat = { provider_id: DEFAULT_ROUTES.code, model_id: "qwen3.6-35b-a3b" };
  out.router = { fast: { provider_id: DEFAULT_ROUTES.fast, model_id: "qwen3.5-4b" }, code: chat, plain: chat };
  const rows = rawRows();
  out.embed = pickProviderByTask(rows, EMBED_TASKS);
  out.rerank = pickProviderByTask(rows, RERANK_TASKS);
  out.classifier = selectBotClassifier({ setting: null, providers: rows, ownAddresses, ownInstanceId: OWN });
  out.phone = { base_url: VOICE_URL, api_key: "none", model: "qwen3.5-4b", label: "crow-voice/qwen3.5-4b" };
  return out;
}

const SEEDS = {
  voice: "local-voice/m2",
  quick: "local-cls/qwen3.5-4b",
  everyday: "local-chat/m1",
  deep: "local-voice/m1",
  // Knowingly shares everyday's key: chosen-only must hold through a shared seed.
  coordinator: "local-chat/m1",
};

let G;

function assertGolden(now, label) {
  for (const k of Object.keys(G.bots)) {
    assert.deepEqual(now.bots[k], G.bots[k], `${label}: bot ${k}`);
    assert.equal("role" in now.bots[k], false, `${label}: bot ${k} carries no role`);
  }
  assert.deepEqual(now.router, G.router, `${label}: smart-router`);
  assert.equal(now.embed, G.embed, `${label}: embed`);
  assert.equal(now.rerank, G.rerank, `${label}: rerank`);
  assert.deepEqual(now.classifierBot, G.classifier, `${label}: classifier (bot side)`);
  assert.deepEqual(now.classifierPanel, statusOf(G.classifier), `${label}: classifier (panel)`);
  assert.deepEqual(now.phoneLocal, G.phone, `${label}: phone local`);
  assert.deepEqual(now.phoneCloud, G.phone, `${label}: phone cloud slot`);
}

test("golden values are what main gives (sanity of the fixture)", async () => {
  G = await golden();
  assert.deepEqual(G.voice, { fast: "crow-voice/qwen3.5-4b", escalate: "crow-chat/qwen3.6-35b-a3b" });
  assert.deepEqual(G.router.fast, { provider_id: "crow-voice", model_id: "qwen3.5-4b" });
  assert.deepEqual(G.router.code, { provider_id: "crow-chat", model_id: "qwen3.6-35b-a3b" });
  assert.equal(G.embed, "emb-a");
  assert.equal(G.rerank, "rr-a");
  assert.equal(G.classifier.ok, true);
  assert.equal(G.classifier.source, "auto");
  assert.equal(G.bots["valid:false"].key, "local-chat/m1");
  assert.equal(G.bots["invalid:false"].key, frozen.LOCAL_FALLBACK);
  assert.equal(G.bots["escalation:true"].key, "local-voice/m2");
  // Every seed is distinct from the default its consumer would use.
  assert.notEqual(SEEDS.voice, G.voice.fast);
  assert.notEqual(SEEDS.everyday, G.voice.escalate);
  assert.notEqual(SEEDS.quick.split("/")[0], G.router.fast.provider_id);
  assert.notEqual(SEEDS.everyday.split("/")[0], G.router.code.provider_id);
  // Before any seed the new code already matches.
  const now = await consumers();
  assertGolden(now, "unseeded");
  assert.deepEqual(now.voice, G.voice);
});

test("seed changes nothing", async () => {
  const r = await seedRoleBindings(db, { sources: SEEDS, log: () => {} });
  assert.deepEqual([...r.inserted].sort(), Object.keys(SEEDS).sort());
  // Control: the seeds landed as seeded rows, and a full walk would serve them.
  for (const [id, model] of Object.entries(SEEDS)) {
    const row = conn.prepare("SELECT value FROM dashboard_settings WHERE key = ?").get("model_role." + id);
    const v = JSON.parse(row.value);
    assert.equal(v.model, model, id);
    assert.equal(v.seeded, true, id);
  }
  fresh();
  assert.equal((await resolveRole(db, "role:voice")).key, SEEDS.voice);
  assert.equal((await resolveRole(db, "role:quick")).key, SEEDS.quick);
  assert.equal((await resolveRole(db, "role:everyday")).key, SEEDS.everyday);
  assert.equal((await resolveRole(db, "role:quick", { chosenOnly: true })).key, null);

  const now = await consumers();
  assertGolden(now, "seeded");
  assert.deepEqual(now.voice, G.voice, "seeded: voice keys");
  assert.deepEqual(now.voiceRoles, { fastRole: null, escalateRole: null });
});

test("chosen bindings move them (positive control)", async () => {
  assert.deepEqual(await setBinding(db, "voice", { model: "local-voice/m2" }, { actor: "test" }), { ok: true });
  assert.deepEqual(await setBinding(db, "quick", { model: "local-voice/m2" }, { actor: "test" }), { ok: true });
  const now = await consumers();
  assert.equal(now.voice.fast, "local-voice/m2");
  assert.equal(now.voiceRoles.fastRole, "voice");
  assert.equal(now.voice.escalate, G.voice.escalate, "everyday is still only seeded");
  assert.deepEqual(now.router.fast, { provider_id: "local-voice", model_id: "m2" });
  assert.deepEqual(now.router.code, G.router.code);
  assert.deepEqual(now.router.plain, G.router.plain);
  // safety is not chosen: the classifier stays on today's pick.
  assert.deepEqual(now.classifierBot, G.classifier);
  assert.deepEqual(now.classifierPanel, statusOf(G.classifier));
  // Untouched consumers stay put.
  for (const k of Object.keys(G.bots)) assert.deepEqual(now.bots[k], G.bots[k], `bot ${k}`);
  assert.equal(now.embed, G.embed);
  assert.equal(now.rerank, G.rerank);
  assert.deepEqual(now.phoneLocal, G.phone);
});
