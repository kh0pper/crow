/**
 * Model roles Phase 1, Task 5: voice resolves roles. The llm-router's fast
 * side follows a CHOSEN `voice` binding and its escalate side a chosen
 * `everyday` (env first, then the chosen binding, then the raw constants);
 * a seeded binding changes nothing. The voice turn (assessBot, abilitiesOf)
 * and the voice bot (fast_voice_model = "role:voice", its cloud flag, the
 * ensure carry-over) resolve the same way. Every DB is a fresh scratch
 * init-db; no model server is ever reached (a local stub answers).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { createClient } from "@libsql/client";
import llmRouterRouter, {
  chooseVoiceRoute, VOICE_ROUTE_KEYS, resolveVoiceKeys, resolveBotVoiceKey, companionModelIds, COMPANION_TURN_MODEL,
} from "../servers/gateway/routes/llm-router.js";
import { setBinding, invalidateRoleContext, resolveRole } from "../servers/shared/model-roles-store.js";
import { seedRoleBindings } from "../servers/shared/model-roles-seed.js";
import { createVoiceTurnRunner } from "../servers/gateway/voice/turn.js";
import { createToolFamilies } from "../servers/gateway/voice/tool-families.js";
import { createVoiceBotLoader } from "../servers/gateway/voice/crow-voice.js";
import { ensureVoiceBot, CROW_VOICE_BOT_ID } from "../servers/shared/voice-bot.js";

const FAST_KEY = VOICE_ROUTE_KEYS.fast;
const ESC_KEY = VOICE_ROUTE_KEYS.escalate;
const FAST_ID = FAST_KEY.slice(FAST_KEY.indexOf("/") + 1);
const NO_ENV = {};

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "roles-voice-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  invalidateRoleContext();
  return { db, cleanup() { invalidateRoleContext(); try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

async function provider(db, id, baseUrl, models, { host = null, gpuPolicy = null, disabled = 0 } = {}) {
  await db.execute({
    sql: "INSERT INTO providers (id, base_url, host, models, gpu_policy, disabled) VALUES (?, ?, ?, ?, ?, ?)",
    args: [id, baseUrl, host, JSON.stringify(models.map((m) => ({ id: m }))), gpuPolicy ? JSON.stringify(gpuPolicy) : null, disabled],
  });
  invalidateRoleContext();
}
const bind = (db, id, model, fallback) => setBinding(db, id, fallback ? { model, fallback } : { model }, { actor: "test" });

/** The fixture every test starts from: local voice m2/m3, local chat m1/m4. */
async function baseProviders(db) {
  await provider(db, "local-voice", "http://127.0.0.1:8011/v1", ["m2", "m3"]);
  await provider(db, "local-chat", "http://127.0.0.1:8003/v1", ["m1", "m4"]);
}

// ---- resolveVoiceKeys --------------------------------------------------------

test("unedited: no binding gives the raw constants and no roles", async () => {
  const { db, cleanup } = fresh();
  try {
    await baseProviders(db);
    assert.deepEqual(await resolveVoiceKeys(db, { env: NO_ENV }), { fast: FAST_KEY, escalate: ESC_KEY, fastRole: null, escalateRole: null });
  } finally { cleanup(); }
});

test("distinct seed is ignored", async () => {
  const { db, cleanup } = fresh();
  try {
    await baseProviders(db);
    assert.notEqual("local-voice/m2", FAST_KEY);
    await seedRoleBindings(db, { sources: { voice: "local-voice/m2", everyday: "local-chat/m1" }, log: () => {} });
    // Control: the seed is configured, so a full walk would land on it.
    assert.equal((await resolveRole(db, "role:voice")).key, "local-voice/m2");
    const k = await resolveVoiceKeys(db, { env: NO_ENV });
    assert.equal(k.fast, FAST_KEY);
    assert.equal(k.fastRole, null);
    assert.equal(k.escalate, ESC_KEY);
    assert.equal(k.escalateRole, null);
  } finally { cleanup(); }
});

test("env beats role", async () => {
  const { db, cleanup } = fresh();
  try {
    await baseProviders(db);
    await bind(db, "voice", "local-voice/m2");
    await bind(db, "everyday", "local-chat/m1");
    const k = await resolveVoiceKeys(db, { env: { COMPANION_FAST_MODEL: "local-voice/m9", COMPANION_ESCALATION_MODEL: "local-chat/m8" } });
    assert.equal(k.fast, "local-voice/m9");
    assert.equal(k.fastRole, null);
    assert.equal(k.escalate, "local-chat/m8");
    assert.equal(k.escalateRole, null);
    // Positive control: without the env the chosen bindings win.
    const c = await resolveVoiceKeys(db, { env: NO_ENV });
    assert.deepEqual(c, { fast: "local-voice/m2", escalate: "local-chat/m1", fastRole: "voice", escalateRole: "everyday" });
  } finally { cleanup(); }
});

test("unresolvable voice role falls to raw (N2: never into quick or everyday)", async () => {
  const { db, cleanup } = fresh();
  const warn = console.warn; console.warn = () => {};
  try {
    await baseProviders(db);
    await bind(db, "quick", "local-chat/m4");
    await bind(db, "everyday", "local-chat/m1");
    await bind(db, "voice", "gone/x");
    // Control: quick and everyday really are configured and chosen.
    assert.equal((await resolveRole(db, "role:quick", { chosenOnly: true })).key, "local-chat/m4");
    assert.equal((await resolveRole(db, "role:everyday", { chosenOnly: true })).key, "local-chat/m1");
    const k = await resolveVoiceKeys(db, { env: NO_ENV });
    assert.equal(k.fast, FAST_KEY);
    assert.equal(k.fastRole, null);
    assert.equal(k.escalate, "local-chat/m1");
  } finally { console.warn = warn; cleanup(); }
});

test("resolveVoiceKeys never throws: a failing resolver gives the raw constants", async () => {
  const k = await resolveVoiceKeys({}, { env: NO_ENV, resolveRoleFn: async () => { throw new Error("boom"); } });
  assert.deepEqual(k, { fast: FAST_KEY, escalate: ESC_KEY, fastRole: null, escalateRole: null });
  const calls = [];
  await resolveVoiceKeys({}, { env: NO_ENV, resolveRoleFn: async (_db, key, opts) => { calls.push([key, opts.need, opts.chosenOnly]); return { key: null, reason: "not_chosen" }; } });
  assert.deepEqual(calls.sort(), [["role:everyday", "chat", true], ["role:voice", "chat", true]]);
});

test("companionModelIds: the default is today's list; a role adds its id and keeps the old ones", () => {
  const ESC_ID = ESC_KEY.slice(ESC_KEY.indexOf("/") + 1);
  assert.deepEqual(companionModelIds(VOICE_ROUTE_KEYS), [FAST_ID, ESC_ID, COMPANION_TURN_MODEL]);
  const ids = companionModelIds({ fast: "local-voice/m2", escalate: "local-chat/m1" });
  for (const id of ["m2", "m1", FAST_ID, ESC_ID, COMPANION_TURN_MODEL]) assert.ok(ids.includes(id), id);
});

// ---- the router --------------------------------------------------------------

let up, upUrl, seen, srv, appUrl, routerDb, routerCleanup, keyLog;

before(async () => {
  up = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      seen.push({ path: req.url, body: raw ? JSON.parse(raw) : null });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  upUrl = `http://127.0.0.1:${up.address().port}/v1`;
  ({ db: routerDb, cleanup: routerCleanup } = fresh());
  await baseProviders(routerDb);
  // The door's provider map: both voice ids are forwardable, so a bare id that
  // is NOT a companion id would be door-forwarded (the negative the test needs).
  const doorProviders = {
    "local-voice": { baseUrl: upUrl, apiKey: "none", bundleId: "b-voice", models: [{ id: "m2" }, { id: "m3" }] },
    [FAST_KEY.split("/")[0]]: { baseUrl: upUrl, apiKey: "none", bundleId: "b-fast", models: [{ id: FAST_ID }] },
  };
  const router = llmRouterRouter({
    acquireFn: async () => true,
    resolveKeyFn: async (key) => ({ baseUrl: upUrl, model: key.split("/")[1], apiKey: null }),
    probeReadyFn: async () => true,
    warmFn: async () => true,
    loadProvidersFn: () => ({ providers: doorProviders }),
    remoteAddressFn: () => "127.0.0.1",
    doorAuthFn: async () => false,
    recordUsageFn: async () => {},
    resolveVoiceKeysFn: async () => { const k = await resolveVoiceKeys(routerDb, { env: NO_ENV }); keyLog.push(k); return k; },
  });
  const app = express();
  app.use(router);
  srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  appUrl = `http://127.0.0.1:${srv.address().port}`;
});
after(() => { srv?.close(); up?.close(); routerCleanup?.(); });

function chat(body) {
  seen = []; keyLog = [];
  return fetch(`${appUrl}/llm/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
const hi = (model) => ({ model, messages: [{ role: "user", content: "What is the capital of Portugal?" }] });

test("chosen binding takes over without restart", async () => {
  // Unedited first: the raw fast model.
  let r = await chat(hi(COMPANION_TURN_MODEL));
  assert.equal(r.status, 200);
  assert.equal(seen[0].body.model, FAST_ID);
  assert.equal(keyLog.length, 1, "resolved once per request");
  assert.equal(keyLog[0].fastRole, null);

  await bind(routerDb, "voice", "local-voice/m2");
  r = await chat(hi(COMPANION_TURN_MODEL));
  assert.equal(r.status, 200);
  assert.equal(seen[0].body.model, "m2");
  assert.equal(keyLog[0].fastRole, "voice");

  await bind(routerDb, "voice", "local-voice/m3");
  r = await chat(hi(COMPANION_TURN_MODEL));
  assert.equal(seen[0].body.model, "m3", "a rebind is seen on the next request");
  await bind(routerDb, "voice", null);
});

test("old and new fast ids are both companion", async () => {
  await bind(routerDb, "voice", "local-voice/m2");
  try {
    for (const model of ["m2", FAST_ID]) {
      const r = await chat(hi(model));
      assert.equal(r.status, 200, model);
      // A companion turn forwards the CHOSEN fast model with thinking off; a door forward would keep the id as sent.
      assert.equal(seen[0].body.model, "m2", model);
      assert.deepEqual(seen[0].body.chat_template_kwargs, { enable_thinking: false }, model);
    }
    // Control: m3 is not a companion id, so it is door-forwarded as sent (no companion heuristics).
    await chat(hi("m3"));
    assert.equal(seen[0].body.model, "m3");
    assert.equal(seen[0].body.chat_template_kwargs, undefined);
  } finally { await bind(routerDb, "voice", null); }
});

test("escalation follows a chosen everyday", async () => {
  await bind(routerDb, "everyday", "local-chat/m1");
  try {
    await chat({ model: COMPANION_TURN_MODEL, messages: [{ role: "user", content: "!escalate explain entropy" }] });
    assert.equal(seen[0].body.model, "m1");
    assert.equal(keyLog[0].escalateRole, "everyday");
  } finally { await bind(routerDb, "everyday", null); }
});

test("/llm/v1/models lists the chosen fast model", async () => {
  await bind(routerDb, "voice", "local-voice/m2");
  try {
    const r = await (await fetch(`${appUrl}/llm/v1/models`)).json();
    const ids = r.data.map((m) => m.id);
    assert.ok(ids.includes("m2"));
  } finally { await bind(routerDb, "voice", null); }
});

// ---- chooseVoiceRoute ---------------------------------------------------------

test("chooseVoiceRoute default unchanged", () => {
  const u = (content) => [{ role: "system", content: "s" }, { role: "user", content }];
  const toolMsgs = [...u("set a timer"), { role: "assistant", content: "", tool_calls: JSON.stringify([{ id: "1", name: "crow_wm" }]) },
    { role: "tool", content: "{}", tool_call_id: "1" }, { role: "assistant", content: "Done." }, { role: "user", content: "thanks" }];
  const fixtures = [
    [u("What is the capital of Portugal?"), { hasTools: true }],
    [u("!escalate explain entropy"), { hasTools: false }],
    [u("play some jazz"), { hasTools: true }],
    [u("play some jazz"), { hasTools: false }],
    [toolMsgs, { hasTools: true }],
    [u("Add a car appointment for Monday to my calendar"), { hasTools: true, actionIntent: true }],
    [u("Add a car appointment for Monday to my calendar"), { hasTools: true }],
    [u("!escalate add it"), { hasTools: true, actionIntent: true }],
  ];
  for (const [msgs, opts] of fixtures) {
    assert.deepEqual(chooseVoiceRoute(msgs, opts), chooseVoiceRoute(msgs, { ...opts, keys: VOICE_ROUTE_KEYS }));
  }
  assert.deepEqual(chooseVoiceRoute(u("What is the capital of Portugal?"), { hasTools: true }), { route: "fast", reason: null, key: FAST_KEY });
  assert.deepEqual(chooseVoiceRoute(u("!escalate x"), {}), { route: "escalate", reason: "manual", key: ESC_KEY });
  // Positive control: given keys are used.
  const keys = { fast: "local-voice/m2", escalate: "local-chat/m1" };
  assert.equal(chooseVoiceRoute(u("hello"), { keys }).key, "local-voice/m2");
  assert.equal(chooseVoiceRoute(u("!escalate x"), { keys }).key, "local-chat/m1");
});

// ---- resolveBotVoiceKey -------------------------------------------------------

test("bot role fast key", async () => {
  const { db, cleanup } = fresh();
  try {
    await baseProviders(db);
    await bind(db, "voice", "local-voice/m2");
    assert.equal(await resolveBotVoiceKey(db, "role:voice", { fallback: "x/y" }), "local-voice/m2");
    assert.equal(await resolveBotVoiceKey(db, "role:nope", { fallback: "x/y" }), "x/y");
    assert.equal(await resolveBotVoiceKey(db, "local-chat/m4", { fallback: "x/y" }), "local-chat/m4");
    assert.equal(await resolveBotVoiceKey(db, undefined, { fallback: "x/y" }), "x/y", "no key: the fallback, as `|| fastKey` did");
    assert.equal(await resolveBotVoiceKey(db, "", { fallback: "x/y" }), "x/y");
  } finally { cleanup(); }
});

test("a seeded voice still serves an explicit role:voice (full walk)", async () => {
  const { db, cleanup } = fresh();
  try {
    await baseProviders(db);
    await seedRoleBindings(db, { sources: { voice: "local-voice/m3" }, log: () => {} });
    assert.equal(await resolveBotVoiceKey(db, "role:voice", { fallback: "x/y" }), "local-voice/m3");
  } finally { cleanup(); }
});

// ---- the voice turn --------------------------------------------------------------

function voiceHarness(db, bot) {
  const calls = { resolved: [], ctxFor: [] };
  const fam = createToolFamilies({ manifests: {}, connected: () => new Map(), listExtensions: () => [] });
  const deps = {
    now: () => 1000,
    loadBotRow: async (_db, id) => (id === "b1" ? { bot_id: "b1", enabled: 1, definition: JSON.stringify({ bot_id: "b1", ...bot }) } : null),
    getChatTools: () => [{ name: "crow_memory", description: "m", inputSchema: { type: "object" } }],
    toolFamilies: fam,
    isMemoryTool: (n) => n === "crow_memory",
    botVoiceScope: () => null,
    connectedAddonTools: () => [],
    fastKey: FAST_KEY,
    escalateKey: ESC_KEY,
    toolEscalationEnabled: () => true,
    resolveKey: async (k) => { calls.resolved.push(k); return { baseUrl: "http://esc" }; },
    resolveVoiceKeys: (d) => resolveVoiceKeys(d, { env: NO_ENV }),
    resolveBotVoiceKey,
    generateSystemPrompt: async () => "P",
    contextLenFor: async (k) => { calls.ctxFor.push(k); return 8192; },
  };
  return { runner: createVoiceTurnRunner(deps), calls };
}

test("abilities follow the escalate role", async () => {
  const { db, cleanup } = fresh();
  try {
    await baseProviders(db);
    let h = voiceHarness(db, {});
    await h.runner.abilitiesOf({ db, botId: "b1" });
    assert.deepEqual(h.calls.resolved, [ESC_KEY], "unedited: the raw escalate key");
    await bind(db, "everyday", "local-chat/m1");
    h = voiceHarness(db, {});
    await h.runner.abilitiesOf({ db, botId: "b1" });
    assert.deepEqual(h.calls.resolved, ["local-chat/m1"]);
  } finally { cleanup(); }
});

test("assessBot measures the model a role:voice bot really uses", async () => {
  const { db, cleanup } = fresh();
  try {
    await baseProviders(db);
    await bind(db, "voice", "local-voice/m2");
    let h = voiceHarness(db, { fast_voice_model: "role:voice" });
    let a = await h.runner.assessBot({ db, botId: "b1" });
    assert.equal(a.model, "local-voice/m2");
    assert.deepEqual(h.calls.ctxFor, ["local-voice/m2"]);
    // A bot with no fast model follows the chosen voice role too (the router's fast side).
    h = voiceHarness(db, {});
    a = await h.runner.assessBot({ db, botId: "b1" });
    assert.equal(a.model, "local-voice/m2");
    // A raw bot key is untouched.
    h = voiceHarness(db, { fast_voice_model: "local-chat/m4" });
    assert.equal((await h.runner.assessBot({ db, botId: "b1" })).model, "local-chat/m4");
  } finally { cleanup(); }
});

test("a turn runner without the role deps behaves as before", async () => {
  const fam = createToolFamilies({ manifests: {}, connected: () => new Map(), listExtensions: () => [] });
  const resolved = [];
  const runner = createVoiceTurnRunner({
    now: () => 1000,
    loadBotRow: async () => ({ bot_id: "b1", enabled: 1, definition: JSON.stringify({ bot_id: "b1" }) }),
    getChatTools: () => [], toolFamilies: fam, isMemoryTool: () => false, botVoiceScope: () => null, connectedAddonTools: () => [],
    fastKey: "a/fast", escalateKey: "a/esc", toolEscalationEnabled: () => true,
    resolveKey: async (k) => { resolved.push(k); return { baseUrl: "http://e" }; },
    generateSystemPrompt: async () => "P", contextLenFor: async () => 8192,
  });
  assert.equal((await runner.assessBot({ db: {}, botId: "b1" })).model, "a/fast");
  await runner.abilitiesOf({ db: {}, botId: "b1" });
  assert.deepEqual(resolved, ["a/esc"]);
});

// ---- the voice bot ------------------------------------------------------------------

async function seedVoiceBot(db, def) {
  await db.execute({
    sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?, 'Crow', ?, 1, NULL)",
    args: [CROW_VOICE_BOT_ID, JSON.stringify(def)],
  });
}

test("voice bot cloud flag via role", async () => {
  const { db, cleanup } = fresh();
  try {
    await provider(db, "cloud-a", "https://api.example.com/v1", ["m9"]);
    await provider(db, "door-a", "http://127.0.0.1:3001/llm/p/cloud-a/v1", ["m9"], { gpuPolicy: { door_forward: true } });
    await baseProviders(db);
    await seedVoiceBot(db, { kind: "voice", fast_voice_model: "role:voice" });
    await bind(db, "voice", "door-a/m9");
    const v = await createVoiceBotLoader()(db);
    assert.equal(v.cloud, true, "a loopback door to a public upstream is cloud");
    // Control: the same role on a local model is not cloud.
    await bind(db, "voice", "local-voice/m2");
    assert.equal((await createVoiceBotLoader()(db)).cloud, false);
    // An unresolvable role is not cloud (false on any doubt, as today).
    await bind(db, "voice", "gone/x");
    assert.equal((await createVoiceBotLoader()(db)).cloud, false);
  } finally { cleanup(); }
});

test("voice bot raw key keeps the host test", async () => {
  const { db, cleanup } = fresh();
  try {
    // The row says host "cloud" though its URL is loopback: the raw key keeps today's answer.
    await provider(db, "hosted", "http://127.0.0.1:9000/v1", ["m1"], { host: "cloud" });
    await seedVoiceBot(db, { kind: "voice", fast_voice_model: "hosted/m1" });
    assert.equal((await createVoiceBotLoader()(db)).cloud, true);
  } finally { cleanup(); }
});

test("voice bot carries a role", async () => {
  const opts = { fastKey: FAST_KEY, readSetting: async () => null, listDevices: async () => [], log: () => {} };
  const run = async (bound) => {
    const { db, cleanup } = fresh();
    try {
      await baseProviders(db);
      if (bound) await bind(db, "voice", "local-voice/m2");
      await db.execute({
        sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES ('helper', 'helper', ?, 1, NULL)",
        args: [JSON.stringify({ fast_voice_model: "role:voice", tools: { crow_mcp: [] } })],
      });
      assert.deepEqual(await ensureVoiceBot(db, opts), { created: true });
      const row = (await db.execute({ sql: "SELECT definition FROM pi_bot_defs WHERE bot_id = ?", args: [CROW_VOICE_BOT_ID] })).rows[0];
      return JSON.parse(row.definition).fast_voice_model;
    } finally { cleanup(); }
  };
  assert.equal(await run(true), "role:voice");
  assert.equal(await run(false), FAST_KEY, "an unresolvable role is not carried");
});
