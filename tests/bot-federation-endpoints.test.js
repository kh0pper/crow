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
