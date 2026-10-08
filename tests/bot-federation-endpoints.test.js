import { test } from "node:test";
import assert from "node:assert/strict";
import { makeBotFederationHandlers } from "../servers/gateway/routes/bot-federation-routes.js";

// In-memory bot store backed by a fake libsql db.
function makeDb({ manageable, def }) {
  const store = { definition: JSON.stringify(def), enabled: 1, project_id: null };
  return {
    _store: store,
    async execute({ sql, args }) {
      if (/dashboard_settings_overrides/.test(sql)) return { rows: [] };
      if (/SELECT value FROM dashboard_settings/.test(sql)) {
        const key = args[0];
        if (key === "feature_flags") return { rows: [{ value: JSON.stringify({ remote_bot_management: true }) }] };
        if (key === "remote_managed_bots") return { rows: [{ value: JSON.stringify(manageable) }] };
        return { rows: [] };
      }
      if (/SELECT definition, project_id FROM pi_bot_defs/.test(sql)) {
        if (args[0] !== "scout") return { rows: [] };
        return { rows: [{ definition: store.definition, project_id: store.project_id }] };
      }
      if (/UPDATE pi_bot_defs SET definition/.test(sql)) { store.definition = args[0]; return { rows: [] }; }
      if (/UPDATE pi_bot_defs SET enabled/.test(sql)) { store.enabled = args[0]; return { rows: [] }; }
      return { rows: [] };
    },
  };
}
const sampleDef = () => ({ system_prompt: "old", models: { default: "m" }, gateways: [{ type: "discord", token: "S" }], tools: { skills: [] } });
function makeRes() {
  return { _status: 200, _json: null, status(c){this._status=c;return this;}, json(o){this._json=o;return this;}, type(){return this;}, send(s){this._json=JSON.parse(s);return this;} };
}

test("GET def: manageable → redacted def (no secret)", async () => {
  const db = makeDb({ manageable: ["scout"], def: sampleDef() });
  const h = makeBotFederationHandlers({ db, regenerateBotMcp: async () => ({}) });
  const res = makeRes();
  await h.getDef({ params: { botId: "scout" }, headers: {} }, res);
  assert.equal(res._status, 200);
  assert.equal(JSON.stringify(res._json).includes('"S"'), false);
  assert.deepEqual(res._json.definition.gateways[0].token, { __redacted: true, set: true });
});

test("GET def: not manageable → 403", async () => {
  const db = makeDb({ manageable: [], def: sampleDef() });
  const h = makeBotFederationHandlers({ db, regenerateBotMcp: async () => ({}) });
  const res = makeRes();
  await h.getDef({ params: { botId: "scout" }, headers: {} }, res);
  assert.equal(res._status, 403);
});

test("GET def: unknown bot → 404", async () => {
  const db = makeDb({ manageable: ["ghost"], def: sampleDef() });
  const h = makeBotFederationHandlers({ db, regenerateBotMcp: async () => ({}) });
  const res = makeRes();
  await h.getDef({ params: { botId: "ghost" }, headers: {} }, res);
  assert.equal(res._status, 404);
});

test("POST patch: merges non-secret field + regenerates mcp", async () => {
  const db = makeDb({ manageable: ["scout"], def: sampleDef() });
  let regen = 0;
  const h = makeBotFederationHandlers({ db, regenerateBotMcp: async () => { regen++; return {}; } });
  const res = makeRes();
  await h.patch({ params: { botId: "scout" }, headers: { "x-crow-source": "peerX" }, body: { patch: { "system_prompt": "new", "tools.skills": ["r"] } } }, res);
  assert.equal(res._status, 200);
  assert.equal(JSON.parse(db._store.definition).system_prompt, "new");
  assert.equal(regen, 1);
});

test("POST patch: secret/disallowed field → 400, no write", async () => {
  const db = makeDb({ manageable: ["scout"], def: sampleDef() });
  const before = db._store.definition;
  const h = makeBotFederationHandlers({ db, regenerateBotMcp: async () => ({}) });
  const res = makeRes();
  await h.patch({ params: { botId: "scout" }, headers: {}, body: { patch: { "gateways": [] } } }, res);
  assert.equal(res._status, 400);
  assert.equal(db._store.definition, before);
});

test("POST patch: not manageable → 403", async () => {
  const db = makeDb({ manageable: [], def: sampleDef() });
  const h = makeBotFederationHandlers({ db, regenerateBotMcp: async () => ({}) });
  const res = makeRes();
  await h.patch({ params: { botId: "scout" }, headers: {}, body: { patch: { "system_prompt": "x" } } }, res);
  assert.equal(res._status, 403);
});

test("POST enabled: manageable → flips column", async () => {
  const db = makeDb({ manageable: ["scout"], def: sampleDef() });
  const h = makeBotFederationHandlers({ db, regenerateBotMcp: async () => ({}) });
  const res = makeRes();
  await h.setEnabled({ params: { botId: "scout" }, headers: {}, body: { enabled: 0 } }, res);
  assert.equal(res._status, 200);
  assert.equal(db._store.enabled, 0);
});

test("POST enabled: not manageable → 403", async () => {
  const db = makeDb({ manageable: [], def: sampleDef() });
  const h = makeBotFederationHandlers({ db, regenerateBotMcp: async () => ({}) });
  const res = makeRes();
  await h.setEnabled({ params: { botId: "scout" }, headers: {}, body: { enabled: 0 } }, res);
  assert.equal(res._status, 403);
});

test("patch success is audited as federation.bot.patch with httpStatus 200", async () => {
  const db = makeDb({ manageable: ["scout"], def: sampleDef() });
  const calls = [];
  const h = makeBotFederationHandlers({ db, regenerateBotMcp: async () => ({}), auditFn: async (_db, row) => { calls.push(row); } });
  await h.patch({ params: { botId: "scout" }, headers: { "x-crow-source": "peerX" }, body: { patch: { "system_prompt": "n" } } }, makeRes());
  const row = calls.find((c) => c.action === "federation.bot.patch");
  assert.ok(row, "expected a federation.bot.patch audit row");
  assert.equal(row.direction, "inbound");
  assert.equal(row.bundleId, "scout");
  assert.equal(row.httpStatus, 200);
  assert.equal(row.sourceInstanceId, "peerX");
});

test("patch denial (not manageable) is audited with httpStatus 403", async () => {
  const db = makeDb({ manageable: [], def: sampleDef() });
  const calls = [];
  const h = makeBotFederationHandlers({ db, regenerateBotMcp: async () => ({}), auditFn: async (_db, row) => { calls.push(row); } });
  await h.patch({ params: { botId: "scout" }, headers: { "x-crow-source": "peerX" }, body: { patch: { "system_prompt": "n" } } }, makeRes());
  const row = calls.find((c) => c.action === "federation.bot.patch");
  assert.ok(row);
  assert.equal(row.httpStatus, 403);
  assert.equal(row.error, "not_manageable");
});

test("setEnabled success is audited as federation.bot.enabled", async () => {
  const db = makeDb({ manageable: ["scout"], def: sampleDef() });
  const calls = [];
  const h = makeBotFederationHandlers({ db, regenerateBotMcp: async () => ({}), auditFn: async (_db, row) => { calls.push(row); } });
  await h.setEnabled({ params: { botId: "scout" }, headers: { "x-crow-source": "peerX" }, body: { enabled: 0 } }, makeRes());
  const row = calls.find((c) => c.action === "federation.bot.enabled");
  assert.ok(row);
  assert.equal(row.httpStatus, 200);
});

// --- permission_policy parity on the federation path (security scan 2026-10-08):
// a trusted peer may only TIGHTEN a bot's permissions, never widen them, and
// every value goes through the same validator the Bot Builder save uses.
const ppDef = () => ({ ...sampleDef(), permission_policy: {
  bash: "deny", bash_allow: ["ls"], write_paths: ["/w"], read_paths: ["/r"], external_send: "draft_only",
  confirm: ["gmail_send"], multi_agent: false, self_authoring: false, skill_learning: "off" } });
async function peerPatch(patch) {
  const db = makeDb({ manageable: ["scout"], def: ppDef() });
  const h = makeBotFederationHandlers({ db, regenerateBotMcp: async () => ({}) });
  const res = makeRes();
  await h.patch({ params: { botId: "scout" }, headers: { "x-crow-source": "peerX" }, body: { patch } }, res);
  return { res, def: JSON.parse(db._store.definition) };
}
for (const [name, patch] of [
  ["bash deny→auto", { "permission_policy.bash": "auto" }],
  ["bash deny→allowlist", { "permission_policy.bash": "allowlist" }],
  ["bash_allow grows", { "permission_policy.bash_allow": ["ls", "curl"] }],
  ["write_paths grows to /", { "permission_policy.write_paths": ["/"] }],
  ["write_paths element", { "permission_policy.write_paths.1": "/etc" }],
  ["read_paths grows", { "permission_policy.read_paths": ["/r", "/home"] }],
  ["external_send → allow", { "permission_policy.external_send": "allow" }],
  ["external_send removed", { "permission_policy.external_send": null }],
  ["confirm shrinks", { "permission_policy.confirm": [] }],
  ["multi_agent on", { "permission_policy.multi_agent": true }],
  ["self_authoring on", { "permission_policy.self_authoring": true }],
  ["skill_learning → auto", { "permission_policy.skill_learning": "auto" }],
  ["classifier set", { "permission_policy.classifier": { url: "http://100.64.20.9/v1", model: "m" } }],
  ["unknown policy key", { "permission_policy.interactive_ask": true }],
  ["relative write path", { "permission_policy.write_paths": ["w"] }],
]) {
  test(`peer patch refused (400, no write): ${name}`, async () => {
    const { res, def } = await peerPatch(patch);
    assert.equal(res._status, 400, JSON.stringify(res._json));
    assert.deepEqual(def.permission_policy, ppDef().permission_policy);
  });
}
for (const [name, patch, check] of [
  ["bash stays deny", { "permission_policy.bash": "deny" }, (d) => d.permission_policy.bash === "deny"],
  ["write_paths shrink", { "permission_policy.write_paths": [] }, (d) => d.permission_policy.write_paths.length === 0],
  ["confirm grows", { "permission_policy.confirm": ["gmail_send", "x"] }, (d) => d.permission_policy.confirm.length === 2],
  ["bash_allow shrinks", { "permission_policy.bash_allow": [] }, (d) => d.permission_policy.bash_allow.length === 0],
]) {
  test(`peer patch allowed (tightening): ${name}`, async () => {
    const { res, def } = await peerPatch(patch);
    assert.equal(res._status, 200, JSON.stringify(res._json));
    assert.ok(check(def));
  });
}

test("peer patch goes through the shared permission guard (its own message reaches the 400)", async () => {
  const { res } = await peerPatch({ "permission_policy.interactive_ask": true });
  assert.equal(res._status, 400);
  assert.match(JSON.stringify(res._json), /set by the bot engine/);
  const { res: r2 } = await peerPatch({ "permission_policy.mystery": 1 });
  assert.match(JSON.stringify(r2._json), /unknown permission key mystery/);
});
