import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";
import express from "express";
import { createDbClient } from "../servers/db.js";
import { invalidateRoleContext } from "../servers/shared/model-roles-store.js";
import { clearProviderTaskCache } from "../servers/shared/provider-task.js";
import { speechProfileWhere, speechProfileHost } from "../servers/shared/speech-where.js";
import rolesApiRouter from "../servers/gateway/routes/roles-api.js";

let dir, db;
const origWarn = console.warn;
const OWN = new Set();
const SECRET = "fixture-secret-never-echo-0123456789";

const ins = (id, url, models, disabled = 0) =>
  db.execute({
    sql: "INSERT INTO providers (id, base_url, api_key, host, models, disabled) VALUES (?,?,?,?,?,?)",
    args: [id, url, SECRET, "local", JSON.stringify(models), disabled],
  });
const raw = (key, value) =>
  db.execute({ sql: "INSERT OR REPLACE INTO dashboard_settings (key, value) VALUES (?,?)", args: [key, value] });
const bind = (id, value) => raw(`model_role.${id}`, JSON.stringify(value));
const settingOf = async (key) =>
  (await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: [key] })).rows[0]?.value ?? null;

// The router closes each request's client; the shared test client must survive.
const dbFactory = () => new Proxy(db, { get: (t, k) => (k === "close" ? () => {} : Reflect.get(t, k)) });
const passGate = (req, _res, next) => next();

function startApp(opts = {}) {
  const app = express();
  app.use(express.json());
  app.use(rolesApiRouter({ dbFactory, sessionGate: passGate, env: {}, ownAddrs: OWN, localInstanceId: () => "i-self", ...opts }));
  return new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
}

function call(server, method, path, { body, headers = {} } = {}) {
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port: server.address().port, path, method,
      headers: { ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}), ...headers },
    }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const withServer = async (fn, opts) => {
  const s = await startApp(opts);
  try { return await fn(s); } finally { s.close(); }
};

before(async () => {
  console.warn = () => {};
  dir = mkdtempSync(join(tmpdir(), "roles-api-"));
  db = createDbClient(join(dir, "crow.db"));
  await db.executeMultiple(`
    CREATE TABLE providers (id TEXT PRIMARY KEY, base_url TEXT NOT NULL, api_key TEXT, host TEXT, bundle_id TEXT,
      description TEXT, models TEXT NOT NULL DEFAULT '[]', disabled INTEGER DEFAULT 0, lamport_ts INTEGER DEFAULT 0,
      instance_id TEXT, provider_type TEXT, gpu_policy TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE dashboard_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    CREATE TABLE dashboard_settings_overrides (key TEXT, instance_id TEXT, value TEXT, updated_at TEXT, PRIMARY KEY (key, instance_id));
    CREATE TABLE pi_bot_defs (bot_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, definition TEXT, enabled INTEGER DEFAULT 1);
    CREATE TABLE schedules (id INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL, cron_expression TEXT NOT NULL DEFAULT '* * * * *');
    CREATE TABLE project_spaces (id INTEGER PRIMARY KEY, tasks_db_uri TEXT);
    CREATE TABLE crow_instances (id TEXT PRIMARY KEY, name TEXT, status TEXT, trusted INTEGER DEFAULT 0);
  `);
});
after(() => { console.warn = origWarn; rmSync(dir, { recursive: true, force: true }); });

beforeEach(async () => {
  await db.executeMultiple("DELETE FROM providers; DELETE FROM dashboard_settings; DELETE FROM dashboard_settings_overrides; DELETE FROM pi_bot_defs; DELETE FROM crow_instances;");
  await ins("local-chat", "http://127.0.0.1:8003/v1", [{ id: "m1" }]);
  await ins("local-voice", "http://127.0.0.1:8011/v1", [{ id: "m2" }]);
  // Reserved literals are never cloud: a public address is.
  await ins("cloud-a", "https://8.8.8.8/v1", [{ id: "c1" }]);
  await raw("stt_profiles", JSON.stringify([
    { id: "p1", name: "Local whisper", provider: "fasterwhisper", baseUrl: "http://127.0.0.1:8000", isDefault: true },
    { id: "p3", name: "Deepgram", provider: "deepgram", apiKey: SECRET, isDefault: false },
  ]));
  await raw("tts_profiles", JSON.stringify([
    { id: "p1", name: "Hosted", provider: "elevenlabs", apiKey: SECRET, defaultVoice: "v-hosted", isDefault: true },
    { id: "p2", name: "Kokoro", provider: "kokoro", baseUrl: "http://127.0.0.1:8880", defaultVoice: "af_bella", isDefault: false },
  ]));
  invalidateRoleContext();
  clearProviderTaskCache();
});

test("no session refused", async () => {
  const prev = process.env.CROW_DASHBOARD_PUBLIC;
  process.env.CROW_DASHBOARD_PUBLIC = "true"; // the network layer passes; the session check answers
  try {
    await withServer(async (s) => {
      const r = await call(s, "GET", "/api/roles/voice/picks");
      assert.equal(r.status, 401);
      assert.equal(r.json?.code, "UNAUTHENTICATED");
      const p = await call(s, "POST", "/api/roles/voice/preview", { body: { model: "local-chat/m1" } });
      assert.equal(p.status, 401);
    }, { sessionGate: undefined });
  } finally {
    if (prev === undefined) delete process.env.CROW_DASHBOARD_PUBLIC; else process.env.CROW_DASHBOARD_PUBLIC = prev;
  }
});

test("csrf required", async () => {
  await withServer(async (s) => {
    const cookie = "crow_session=s1; crow_csrf=tok123";
    const body = { model: "local-chat/m1" };
    const no = await call(s, "POST", "/api/roles/quick/preview", { body, headers: { cookie } });
    assert.equal(no.status, 403);
    const bad = await call(s, "POST", "/api/roles/quick/preview", { body, headers: { cookie, "x-crow-csrf": "other" } });
    assert.equal(bad.status, 403);
    const ok = await call(s, "POST", "/api/roles/quick/preview", { body, headers: { cookie, "x-crow-csrf": "tok123" } });
    assert.equal(ok.status, 200);
    for (const path of ["/api/roles/quick", "/api/roles/stt/profile/preview", "/api/roles/stt/profile"]) {
      const r = await call(s, "POST", path, { body: {}, headers: { cookie } });
      assert.equal(r.status, 403, path);
    }
  });
});

test("picks: known role lists picks, unknown role 404, no key in the answer", async () => {
  await withServer(async (s) => {
    const r = await call(s, "GET", "/api/roles/everyday/picks");
    assert.equal(r.status, 200);
    assert.ok(r.json.picks.some((p) => p.key === "local-chat/m1"));
    assert.ok(!r.text.includes(SECRET));
    const u = await call(s, "GET", "/api/roles/nope/picks");
    assert.equal(u.status, 404);
    assert.deepEqual(u.json, { error: "unknown_role" });
    const st = await call(s, "GET", "/api/roles/stt/picks");
    assert.equal(st.status, 200);
    assert.deepEqual(st.json.picks, []);
    assert.deepEqual(st.json.profiles.map((p) => [p.id, p.where, p.isDefault]), [["p1", "here", true], ["p3", "cloud", false]]);
    assert.ok(!st.text.includes(SECRET));
  });
});

test("preview then apply", async () => {
  await db.execute("UPDATE providers SET disabled = 1 WHERE id = 'local-chat'");
  await bind("everyday", { model: "local-chat/m1", fallback: ["quick"] });
  await withServer(async (s) => {
    const p = await call(s, "POST", "/api/roles/quick/preview", { body: { model: "cloud-a/c1" } });
    assert.equal(p.status, 200);
    assert.equal(p.json.needs.ackCloud, true);
    assert.equal(p.json.needs.ackUnattended, true);
    assert.ok(!p.text.includes(SECRET));
    const { previewHash } = p.json;

    const noAck = await call(s, "POST", "/api/roles/quick", { body: { model: "cloud-a/c1", previewHash } });
    assert.equal(noAck.status, 409);
    assert.equal(noAck.json.ok, false);
    assert.equal(noAck.json.reason, "needs_ack_unattended");
    assert.equal(noAck.json.preview.previewHash, previewHash);
    assert.equal(await settingOf("model_role.quick"), null);

    const stale = await call(s, "POST", "/api/roles/quick", { body: { model: "cloud-a/c1", previewHash: "x", ackUnattended: true, ackCloud: true } });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.reason, "preview_changed");

    const ok = await call(s, "POST", "/api/roles/quick", { body: { model: "cloud-a/c1", previewHash, ackUnattended: true, ackCloud: true } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.ok, true);
    const row = JSON.parse(await settingOf("model_role.quick"));
    assert.equal(row.model, "cloud-a/c1");
    assert.equal(row.by, "dashboard:owner");
  });
});

test("preview refuses a malformed model or fallback; media roles are not bound here", async () => {
  await withServer(async (s) => {
    for (const model of ["no-slash", 42, "role:nope", ""]) {
      const r = await call(s, "POST", "/api/roles/quick/preview", { body: { model } });
      assert.equal(r.status, 400, String(model));
      assert.deepEqual(r.json, { error: "invalid_model" });
    }
    const f = await call(s, "POST", "/api/roles/quick/preview", { body: { model: "local-chat/m1", fallback: ["nope"] } });
    assert.equal(f.status, 400);
    assert.deepEqual(f.json, { error: "invalid_fallback" });
    const clear = await call(s, "POST", "/api/roles/quick/preview", { body: { model: null } });
    assert.equal(clear.status, 200);
    const media = await call(s, "POST", "/api/roles/tts/preview", { body: { model: "local-chat/m1" } });
    assert.equal(media.status, 400);
    assert.deepEqual(media.json, { error: "not_bindable" });
    const unknown = await call(s, "POST", "/api/roles/nope/preview", { body: { model: "local-chat/m1" } });
    assert.equal(unknown.status, 404);
  });
});

test("safety refuses a cloud model with 400", async () => {
  await withServer(async (s) => {
    const p = await call(s, "POST", "/api/roles/safety/preview", { body: { model: "cloud-a/c1" } });
    assert.equal(p.status, 200);
    const r = await call(s, "POST", "/api/roles/safety", { body: { model: "cloud-a/c1", previewHash: p.json.previewHash, ackUnattended: true, ackCloud: true } });
    assert.equal(r.status, 400);
    assert.equal(r.json.reason, "cloud_refused");
    assert.equal(await settingOf("model_role.safety"), null);
  });
});

test("speech cloud needs ack", async () => {
  await withServer(async (s) => {
    const pv = await call(s, "POST", "/api/roles/stt/profile/preview", { body: { profileId: "p3" } });
    assert.equal(pv.status, 200);
    assert.equal(pv.json.where, "cloud");
    assert.equal(pv.json.cloud, true);
    assert.equal(pv.json.host, "api.deepgram.com");
    assert.equal(pv.json.paired, false);
    assert.ok(!pv.text.includes(SECRET));
    const { previewHash } = pv.json;

    const no = await call(s, "POST", "/api/roles/stt/profile", { body: { profileId: "p3", previewHash } });
    assert.equal(no.status, 409);
    assert.equal(no.json.reason, "needs_ack_cloud");
    assert.ok(!no.text.includes(SECRET));
    const stale = await call(s, "POST", "/api/roles/stt/profile", { body: { profileId: "p3", previewHash: "x", ackCloud: true } });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.reason, "preview_changed");

    const yes = await call(s, "POST", "/api/roles/stt/profile", { body: { profileId: "p3", previewHash, ackCloud: true } });
    assert.equal(yes.status, 200);
    assert.deepEqual(yes.json, { ok: true });
    const profiles = JSON.parse(await settingOf("stt_profiles"));
    assert.deepEqual(profiles.filter((p) => p.isDefault).map((p) => p.id), ["p3"]);
    assert.equal(profiles.find((p) => p.id === "p3").apiKey, SECRET, "the stored key survives");

    // A local profile needs no ack.
    const lp = await call(s, "POST", "/api/roles/stt/profile/preview", { body: { profileId: "p1" } });
    assert.equal(lp.json.where, "here");
    assert.equal(lp.json.cloud, false);
    const back = await call(s, "POST", "/api/roles/stt/profile", { body: { profileId: "p1", previewHash: lp.json.previewHash } });
    assert.equal(back.status, 200);
    assert.deepEqual(JSON.parse(await settingOf("stt_profiles")).filter((p) => p.isDefault).map((p) => p.id), ["p1"]);

    // A trusted peer: every speech change says it reaches the paired Crows, a local profile too.
    await db.execute("INSERT INTO crow_instances (id, name, status, trusted) VALUES ('i-peer','peer','active',1), ('i-self','self','active',1), ('i-rev','gone','revoked',1)");
    const paired = await call(s, "POST", "/api/roles/stt/profile/preview", { body: { profileId: "p1" } });
    assert.equal(paired.json.paired, true);
    assert.notEqual(paired.json.previewHash, lp.json.previewHash);
    const stalePeer = await call(s, "POST", "/api/roles/stt/profile", { body: { profileId: "p1", previewHash: lp.json.previewHash } });
    assert.equal(stalePeer.json.reason, "preview_changed");
  });
});

test("paired ignores self, untrusted and revoked rows", async () => {
  await db.execute("INSERT INTO crow_instances (id, name, status, trusted) VALUES ('i-self','self','active',1), ('i-rev','gone','revoked',1), ('i-new','new','active',0)");
  await withServer(async (s) => {
    const r = await call(s, "POST", "/api/roles/tts/profile/preview", { body: { profileId: "p2" } });
    assert.equal(r.json.paired, false);
  });
});

test("tts default", async () => {
  await withServer(async (s) => {
    const pv = await call(s, "POST", "/api/roles/tts/profile/preview", { body: { profileId: "p2" } });
    assert.equal(pv.json.where, "here");
    const r = await call(s, "POST", "/api/roles/tts/profile", { body: { profileId: "p2", previewHash: pv.json.previewHash } });
    assert.equal(r.status, 200);
    assert.equal(await settingOf("tts_voice"), "af_bella");
    assert.deepEqual(JSON.parse(await settingOf("tts_profiles")).filter((p) => p.isDefault).map((p) => p.id), ["p2"]);

    const missing = await call(s, "POST", "/api/roles/tts/profile", { body: { profileId: "nope", previewHash: "x" } });
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.json, { error: "unknown_profile" });
    const mp = await call(s, "POST", "/api/roles/tts/profile/preview", { body: { profileId: "nope" } });
    assert.equal(mp.status, 404);

    const chat = await call(s, "POST", "/api/roles/everyday/profile", { body: { profileId: "p2", previewHash: "x" } });
    assert.equal(chat.status, 404);
    const chatPv = await call(s, "POST", "/api/roles/everyday/profile/preview", { body: { profileId: "p2" } });
    assert.equal(chatPv.status, 404);
  });
});

test("custom reserved", async () => {
  await withServer(async (s) => {
    // Task 18: POST /api/roles/custom is the custom-role create route, never a bind of a role named "custom".
    const r = await call(s, "POST", "/api/roles/custom", { body: { model: "local-chat/m1", previewHash: "x" } });
    assert.equal(r.status, 400);
    assert.equal(r.json.reason, "invalid_label");
    assert.equal(await settingOf("model_role.custom"), null);
    const g = await call(s, "GET", "/api/roles/custom/picks");
    assert.equal(g.status, 404);
  });
});

test("speechProfileWhere: hosted adapters are cloud whatever the endpoint; self-host goes through whereItRuns", () => {
  for (const provider of ["elevenlabs", "azure", "openai", "deepgram", "groq", "edge"]) {
    assert.equal(speechProfileWhere({ provider, baseUrl: "http://127.0.0.1:9999" }, { ownAddrs: OWN }), "cloud", provider);
  }
  assert.equal(speechProfileWhere({ provider: "kokoro" }, { ownAddrs: OWN }), "here", "empty endpoint = the adapter's loopback default");
  assert.equal(speechProfileWhere({ provider: "piper", baseUrl: "http://100.64.20.5:5000" }, { ownAddrs: OWN }), "other_box");
  assert.equal(speechProfileWhere({ provider: "whispercpp", baseUrl: "http://box.example.internal:9000" }, { ownAddrs: OWN }), "unproven");
  assert.equal(speechProfileWhere({ provider: "kokoro", baseUrl: "http://8.8.8.8:8880" }, { ownAddrs: OWN }), "cloud");
  assert.equal(speechProfileWhere({ provider: "kokoro", baseUrl: "http://0.0.0.0:8880" }, { ownAddrs: OWN }), "unproven");
  assert.equal(speechProfileWhere(null), "missing");
  assert.equal(speechProfileHost({ provider: "edge", baseUrl: "http://127.0.0.1:1" }), "speech.platform.bing.com");
  assert.equal(speechProfileHost({ provider: "openai" }), "api.openai.com");
});

// --- final fix wave ---------------------------------------------------------

test("F2: the picks rules are enforced on preview and apply", async () => {
  await ins("emb-a", "http://127.0.0.1:8020/v1", [{ id: "e1", task: "embed" }]);
  await withServer(async (s) => {
    const cases = [
      ["safety", { model: "role:quick" }, "safety_no_chain"],
      ["safety", { model: "local-chat/m1", fallback: ["quick"] }, "safety_no_chain"],
      ["everyday", { model: "role:safety" }, "safety_not_followable"],
      ["everyday", { model: "local-chat/m1", fallback: ["safety"] }, "safety_not_followable"],
      ["quick", { model: "role:quick" }, "self_reference"],
      ["quick", { model: "local-chat/m1", fallback: ["quick"] }, "self_reference"],
      ["embed", { model: "local-chat/m1" }, "capability_mismatch"],
      ["everyday", { model: "emb-a/e1" }, "capability_mismatch"],
    ];
    for (const [role, body, code] of cases) {
      const p = await call(s, "POST", `/api/roles/${role}/preview`, { body });
      assert.equal(p.status, 400, `${role} ${JSON.stringify(body)}`);
      assert.deepEqual(p.json, { error: code });
      const a = await call(s, "POST", `/api/roles/${role}`, { body: { ...body, previewHash: "x", ackUnattended: true, ackCloud: true } });
      assert.equal(a.status, 400, `apply ${role} ${JSON.stringify(body)}`);
      assert.deepEqual(a.json, { error: code });
    }
    assert.equal(await settingOf("model_role.safety"), null);
    assert.equal(await settingOf("model_role.quick"), null);
    // The allowed shapes still pass.
    for (const [role, body] of [["everyday", { model: "role:quick" }], ["embed", { model: "emb-a/e1" }], ["safety", { model: "local-chat/m1", fallback: [] }]]) {
      const ok = await call(s, "POST", `/api/roles/${role}/preview`, { body });
      assert.equal(ok.status, 200, `${role} ${JSON.stringify(body)}`);
    }
  });
});

test("F6: picks carry the stored fallback chain so the sheet can keep it", async () => {
  await bind("everyday", { model: "local-chat/m1", fallback: ["expert", "quick"] });
  await withServer(async (s) => {
    const r = await call(s, "GET", "/api/roles/everyday/picks");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.fallback, ["expert", "quick"]);
    const q = await call(s, "GET", "/api/roles/quick/picks");
    assert.equal("fallback" in q.json, false);
  });
});

test("F8: own addresses are probed once per request when not injected", async () => {
  let n = 0;
  const probeOwnAddrs = () => { n++; return new Set(); };
  await withServer(async (s) => {
    const r = await call(s, "GET", "/api/roles/everyday/picks");
    assert.equal(r.status, 200);
    assert.equal(n, 1);
    n = 0;
    const p = await call(s, "POST", "/api/roles/everyday/preview", { body: { model: "cloud-a/c1" } });
    assert.equal(p.status, 200);
    assert.equal(n, 1);
    n = 0;
    const st = await call(s, "GET", "/api/roles/stt/picks");
    assert.equal(st.status, 200);
    assert.equal(n, 1);
  }, { ownAddrs: undefined, probeOwnAddrs });
});

// --- Add a provider (roles phase 2b, Task 12) ---------------------------------

import { Readable } from "node:stream";
import { candidatePick } from "../servers/shared/provider-recommendations.js";
import { checkStamp } from "../servers/shared/pick-checks.js";

const OR_URL = "https://openrouter.ai/api/v1";
const NOW = () => new Date("2026-11-01T12:00:00Z"); // before the file's review_by
const noClassifier = async () => ({ state: "missing" });
const AT = "2026-10-30T10:00:00.000Z";
const insOr = (id, models, description = "OpenRouter") => db.execute({
  sql: "INSERT INTO providers (id, base_url, api_key, host, description, models, disabled) VALUES (?,?,?,?,?,?,0)",
  args: [id, OR_URL, SECRET, "cloud", description, JSON.stringify(models)],
});
const providerCount = async () => Number((await db.execute("SELECT COUNT(*) AS n FROM providers")).rows[0].n);
const csrfHeaders = { cookie: "crow_session=s1; crow_csrf=tok9", "x-crow-csrf": "tok9" };
const addOpts = (extra = {}) => ({ now: NOW, classifierStatusFn: noClassifier, ...extra });
// A stored check carries the stamp of the row it ran against (F3): cloud-or is OR_URL with SECRET.
const OR_STAMP = checkStamp({ apiKey: SECRET, baseUrl: OR_URL });
const orChecks = (byModel) => JSON.stringify({ "cloud-or": Object.fromEntries(Object.entries(byModel).map(([k, c]) => [k, { ...OR_STAMP, ...c }])) });

test("picks: a preset pick whose stored check passed is starred (the route reads the checks)", async () => {
  await insOr("cloud-or", [{ id: "anthropic/claude-haiku-5.5" }]);
  await raw("provider_pick_checks", orChecks({ "anthropic/claude-haiku-5.5|chat": { ok: true, code: "ok", at: AT } }));
  invalidateRoleContext();
  await withServer(async (s) => {
    const r = await call(s, "GET", "/api/roles/quick/picks");
    assert.equal(r.status, 200);
    const pick = r.json.picks.find((p) => p.key === "cloud-or/anthropic/claude-haiku-5.5");
    assert.ok(pick, "the cloud pick is listed");
    assert.equal(pick.recommended, true);
    assert.equal(pick.providerLabel, "OpenRouter");
    assert.equal(r.json.picks.find((p) => p.key === "local-chat/m1")?.recommended, false);
    assert.ok(!r.text.includes(SECRET));
  }, addOpts());
});

test("picks: a failed check gives no star", async () => {
  await insOr("cloud-or", [{ id: "anthropic/claude-haiku-5.5" }]);
  await raw("provider_pick_checks", orChecks({ "anthropic/claude-haiku-5.5|chat": { ok: false, code: "no_tool_call", at: AT } }));
  invalidateRoleContext();
  await withServer(async (s) => {
    const r = await call(s, "GET", "/api/roles/quick/picks");
    assert.equal(r.json.picks.find((p) => p.key === "cloud-or/anthropic/claude-haiku-5.5")?.recommended, false);
  }, addOpts());
});

test("POST /api/providers/test: a rejected key answers 200 with the code, never the key", async () => {
  const seen = [];
  const testFn = async (args) => {
    seen.push(args);
    return { ok: false, code: "key_rejected", status: 401, models: null, host: "openrouter.ai", baseUrl: OR_URL, apiKey: args.apiKey };
  };
  await withServer(async (s) => {
    const r = await call(s, "POST", "/api/providers/test", {
      body: { presetId: "openrouter", apiKey: "fixture-pasted-key-777" }, headers: csrfHeaders,
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.code, "key_rejected");
    assert.equal(r.json.status, 401);
    assert.equal(r.json.host, "openrouter.ai");
    assert.ok(!r.text.includes("fixture-pasted-key-777"), "the key is never echoed");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].apiKey, "fixture-pasted-key-777");
  }, addOpts({ testFn }));
});

test("POST /api/providers/test: a passing key lists models and the recommended ones", async () => {
  const testFn = async () => ({ ok: true, code: "ok", status: 200, models: ["anthropic/claude-haiku-5.5", "x/y"], host: "openrouter.ai", baseUrl: OR_URL });
  await withServer(async (s) => {
    const r = await call(s, "POST", "/api/providers/test", { body: { presetId: "openrouter", apiKey: "fixture-k" }, headers: csrfHeaders });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.models, ["anthropic/claude-haiku-5.5", "x/y"]);
    assert.ok(r.json.recommended.includes("anthropic/claude-haiku-5.5"));
    assert.ok(!r.json.recommended.includes("x/y"));
  }, addOpts({ testFn }));
});

test("POST /api/providers/test: a provider with no model list offers its recommended ids, the picks pre-ticked", async () => {
  const testFn = async () => ({ ok: true, code: "ok", status: 200, models: null, host: "dashscope-intl.aliyuncs.com", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" });
  await withServer(async (s) => {
    const r = await call(s, "POST", "/api/providers/test", { body: { presetId: "modelstudio", apiKey: "fixture-k" }, headers: csrfHeaders });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.noListing, true);
    for (const id of ["qwen3.8-max", "qwen3.8-flash", "qwen3.7-plus", "deepseek-v4-pro-0813", "kimi-k3", "text-embedding-v4"]) {
      assert.ok(r.json.models.includes(id), id);
    }
    assert.equal(new Set(r.json.models).size, r.json.models.length, "each id once");
    assert.deepEqual([...r.json.recommended].sort(), ["deepseek-v4-pro-0813", "qwen3.7-plus", "qwen3.8-flash", "qwen3.8-max", "text-embedding-v4"]);
  }, addOpts({ testFn }));
  // A failed test offers nothing; a preset with a listing never gets the flag.
  const failFn = async () => ({ ok: false, code: "key_rejected", status: 401, models: null, host: "dashscope-intl.aliyuncs.com" });
  await withServer(async (s) => {
    const r = await call(s, "POST", "/api/providers/test", { body: { presetId: "modelstudio", apiKey: "fixture-k" }, headers: csrfHeaders });
    assert.equal(r.json.ok, false);
    assert.equal(r.json.models, null);
    assert.equal(r.json.noListing, undefined);
  }, addOpts({ testFn: failFn }));
  const orNull = async () => ({ ok: true, code: "ok", status: 200, models: null, host: "openrouter.ai", baseUrl: OR_URL });
  await withServer(async (s) => {
    const r = await call(s, "POST", "/api/providers/test", { body: { presetId: "openrouter", apiKey: "fixture-k" }, headers: csrfHeaders });
    assert.equal(r.json.models, null);
    assert.equal(r.json.noListing, undefined);
  }, addOpts({ testFn: orNull }));
});

test("POST /api/providers refuses on a failed test and writes nothing", async () => {
  const before = await providerCount();
  const testFn = async () => ({ ok: false, code: "key_rejected", status: 401, models: null, host: "openrouter.ai" });
  await withServer(async (s) => {
    const r = await call(s, "POST", "/api/providers", {
      body: { presetId: "openrouter", apiKey: "fixture-pasted-key-777", modelIds: ["x/y"] }, headers: csrfHeaders,
    });
    assert.equal(r.status, 400);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.code, "key_rejected");
    assert.ok(!r.text.includes("fixture-pasted-key-777"));
  }, addOpts({ testFn }));
  assert.equal(await providerCount(), before);
});

test("re-review (a): POST /api/providers answers ineligible with the reason for a cloud row the door would refuse", async () => {
  const url = "http://api.example.com/v1";
  const testFn = async () => ({ ok: true, code: "ok", status: 200, models: ["m1"], host: "api.example.com", baseUrl: url });
  await withServer(async (s) => {
    const r = await call(s, "POST", "/api/providers", {
      body: { presetId: "other", baseUrl: url, apiKey: "fixture-pasted-key-778", modelIds: ["m1"] }, headers: csrfHeaders,
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.consent, "ineligible");
    assert.equal(r.json.consentReason, "insecure");
  }, addOpts({ testFn }));
});

test("POST /api/providers saves on a passing test and answers only the id and the consent result", async () => {
  const testFn = async () => ({ ok: true, code: "ok", status: 200, models: ["x/y"], host: "openrouter.ai", baseUrl: OR_URL });
  await withServer(async (s) => {
    const r = await call(s, "POST", "/api/providers", {
      body: { presetId: "openrouter", apiKey: "fixture-pasted-key-777", modelIds: ["x/y"] }, headers: csrfHeaders,
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, providerId: "openrouter", consent: "granted" });
  }, addOpts({ testFn }));
  const row = (await db.execute("SELECT api_key, models FROM providers WHERE id = 'openrouter'")).rows[0];
  assert.equal(row.api_key, "fixture-pasted-key-777");
  assert.deepEqual(JSON.parse(row.models).map((m) => m.id), ["x/y"]);
});

test("the provider routes need a session and CSRF", async () => {
  const prev = process.env.CROW_DASHBOARD_PUBLIC;
  process.env.CROW_DASHBOARD_PUBLIC = "true";
  try {
    await withServer(async (s) => {
      for (const [m, p] of [["POST", "/api/providers/test"], ["POST", "/api/providers"], ["GET", "/api/providers/cloud-a/plan"],
        ["POST", "/api/providers/cloud-a/probe"], ["POST", "/api/providers/cloud-a/recommended/preview"], ["POST", "/api/providers/cloud-a/recommended"]]) {
        const r = await call(s, m, p, m === "POST" ? { body: {} } : {});
        assert.equal(r.status, 401, p);
      }
    }, { sessionGate: undefined, ...addOpts() });
  } finally {
    if (prev === undefined) delete process.env.CROW_DASHBOARD_PUBLIC; else process.env.CROW_DASHBOARD_PUBLIC = prev;
  }
  let tested = 0;
  await withServer(async (s) => {
    for (const p of ["/api/providers/test", "/api/providers", "/api/providers/cloud-a/probe", "/api/providers/cloud-a/recommended/preview", "/api/providers/cloud-a/recommended"]) {
      const r = await call(s, "POST", p, { body: { apiKey: "fixture-pasted-key-777" }, headers: { cookie: "crow_session=s1; crow_csrf=tok9" } });
      assert.equal(r.status, 403, p);
      assert.ok(!r.text.includes("fixture-pasted-key-777"), p);
    }
  }, addOpts({ testFn: async () => { tested++; return { ok: true, code: "ok", models: [], host: "h" }; } }));
  assert.equal(tested, 0);
});

test("a malformed body is refused without echoing or logging it", async () => {
  const { rolesApiBodyErrorHandler } = await import("../servers/gateway/routes/roles-api.js");
  const app = express();
  app.use(express.json());
  app.use(rolesApiRouter({ dbFactory, sessionGate: passGate, env: {}, ownAddrs: OWN, localInstanceId: () => "i-self", ...addOpts() }));
  app.use(["/api/roles", "/api/providers"], rolesApiBodyErrorHandler);
  const logged = [];
  const origErr = console.error;
  console.error = (...a) => logged.push(a.join(" "));
  const s = await new Promise((resolve) => { const x = app.listen(0, "127.0.0.1", () => resolve(x)); });
  try {
    // An unquoted value: V8's message quotes this part of the body, so the
    // default handler would echo and log it.
    const payload = '{"apiKey":fixture-pasted-key-777}';
    const r = await new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: s.address().port, path: "/api/providers/test", method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode, text }));
      });
      req.on("error", reject);
      req.end(payload);
    });
    assert.equal(r.status, 400);
    assert.equal(JSON.parse(r.text).code, "bad_request");
    assert.ok(!r.text.includes("fixture-pas"));
    assert.ok(!logged.join("\n").includes("fixture-pas"));
    // Over the parser's limit: refused the same way, nothing quoted or logged.
    const big = JSON.stringify({ apiKey: "fixture-pasted-key-777", pad: "x".repeat(200_000) });
    const r2 = await new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: s.address().port, path: "/api/providers", method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(big) } }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode, text }));
      });
      req.on("error", reject);
      req.end(big);
    });
    assert.equal(r2.status, 413);
    assert.equal(JSON.parse(r2.text).code, "too_large");
    assert.ok(!r2.text.includes("fixture-pas"));
    assert.ok(!logged.join("\n").includes("fixture-pas"));
  } finally {
    console.error = origErr;
    s.close();
  }
});

test("POST /api/providers/:id/probe calls the probe seam once per distinct pick", async () => {
  const models = ["anthropic/claude-haiku-5.5", "anthropic/claude-sonnet-5.5", "qwen/qwen3-embedding-8b", "cohere/rerank-4-fast"];
  await insOr("cloud-or", models.map((id) => ({ id })));
  invalidateRoleContext();
  const distinct = new Set();
  for (const roleId of ["coordinator", "quick", "deep", "everyday", "expert", "critic", "vision", "voice", "embed", "rerank"]) {
    const p = candidatePick("openrouter", roleId, { liveModelIds: models });
    if (p && (p.kind === "chat" || p.kind === "embed")) distinct.add(`${p.kind}:${p.model_id}`);
  }
  assert.ok(distinct.size >= 2, "the fixture shares a model between roles");
  const calls = [];
  const probeRequestFn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const embed = url.endsWith("/embeddings");
    const body = embed ? { data: [{ embedding: [0.1] }] } : { choices: [{ message: { tool_calls: [{ function: { name: "crow_probe" } }] } }] };
    return { status: 200, headers: {}, stream: Readable.from([Buffer.from(JSON.stringify(body))]) };
  };
  await withServer(async (s) => {
    const r = await call(s, "POST", "/api/providers/cloud-or/probe", { body: {}, headers: csrfHeaders });
    assert.equal(r.status, 200);
    assert.ok(!r.text.includes(SECRET));
    assert.equal(r.json.quick?.ok, true);
    assert.equal(r.json.rerank, undefined, "rerank is never probed");
    const unknown = await call(s, "POST", "/api/providers/nope/probe", { body: {}, headers: csrfHeaders });
    assert.equal(unknown.status, 404);
  }, addOpts({ probeRequestFn }));
  assert.equal(calls.length, distinct.size);
  assert.equal(new Set(calls.map((c) => `${c.url.endsWith("/embeddings") ? "embed" : "chat"}:${c.body.model}`)).size, distinct.size);
});

test("GET /api/providers/:id/plan: each pick with its check, embed read as embed, rerank never tested", async () => {
  const models = ["anthropic/claude-haiku-5.5", "qwen/qwen3-embedding-8b", "cohere/rerank-4-fast"];
  await insOr("cloud-or", models.map((id) => ({ id })));
  await raw("provider_pick_checks", orChecks({
    "anthropic/claude-haiku-5.5|chat": { ok: true, code: "ok", at: AT },
    // A chat check of the embedding model does not count for embed.
    "qwen/qwen3-embedding-8b|chat": { ok: true, code: "ok", at: AT },
    "cohere/rerank-4-fast|chat": { ok: true, code: "ok", at: AT },
  }));
  invalidateRoleContext();
  await withServer(async (s) => {
    const r = await call(s, "GET", "/api/providers/cloud-or/plan");
    assert.equal(r.status, 200);
    assert.ok(!r.text.includes(SECRET));
    const pickOf = (roleId) => r.json.picks.find((p) => p.roleId === roleId);
    assert.equal(pickOf("quick").check.ok, true);
    assert.equal(pickOf("quick").check.at, AT);
    assert.equal(pickOf("quick").providerLabel, "OpenRouter");
    assert.equal(pickOf("embed").check, null);
    assert.equal(pickOf("rerank").check, null);
    assert.ok(Array.isArray(r.json.apply) && Array.isArray(r.json.optIn) && Array.isArray(r.json.skipped));
    assert.equal(r.json.stale, false);
    const none = await call(s, "GET", "/api/providers/nope/plan");
    assert.equal(none.status, 404);
  }, addOpts());
  await raw("provider_pick_checks", orChecks({ "qwen/qwen3-embedding-8b|embed": { ok: true, code: "ok", at: AT } }));
  await withServer(async (s) => {
    const r = await call(s, "GET", "/api/providers/cloud-or/plan");
    assert.equal(r.json.picks.find((p) => p.roleId === "embed").check.ok, true);
  }, addOpts());
});

test("realtime voice models are never recommended, and /plan marks only probeable kinds probed (F1)", async () => {
  const listing = ["gpt-realtime-2.1-mini", "gpt-live-1", "gpt-6-luna", "gpt-6.1-sol", "text-embedding-3-large"];
  const testFn = async () => ({ ok: true, code: "ok", status: 200, models: listing, host: "api.openai.com", baseUrl: "https://api.openai.com/v1" });
  await withServer(async (s) => {
    const r = await call(s, "POST", "/api/providers/test", { body: { presetId: "openai", apiKey: "fixture-k" }, headers: csrfHeaders });
    assert.equal(r.status, 200);
    assert.ok(r.json.recommended.includes("gpt-6-luna"));
    assert.ok(!r.json.recommended.includes("gpt-realtime-2.1-mini"));
    assert.ok(!r.json.recommended.includes("gpt-live-1"));
  }, addOpts({ testFn }));
  await db.execute({
    sql: "INSERT INTO providers (id, base_url, api_key, host, description, models, disabled) VALUES (?,?,?,?,?,?,0)",
    args: ["cloud-o", "https://api.openai.com/v1", SECRET, "cloud", "OpenAI", JSON.stringify(listing.map((id) => ({ id })))],
  });
  await insOr("cloud-or", [{ id: "anthropic/claude-haiku-5.5" }, { id: "cohere/rerank-4-fast" }]);
  invalidateRoleContext();
  await withServer(async (s) => {
    const o = (await call(s, "GET", "/api/providers/cloud-o/plan")).json;
    assert.ok(!o.picks.some((p) => /realtime|live/.test(p.modelId)), "no realtime pick");
    const voice = o.picks.find((p) => p.roleId === "voice");
    assert.equal(voice, undefined, "OpenAI recommends no text model for voice");
    const or = (await call(s, "GET", "/api/providers/cloud-or/plan")).json;
    for (const p of [...o.picks, ...or.picks]) {
      assert.equal(p.probed, p.kind === "chat" || p.kind === "embed", `${p.roleId} ${p.kind}`);
    }
    assert.equal(or.picks.find((p) => p.roleId === "rerank").probed, false);
  }, addOpts());
});

test("recommended: preview then apply fills a role nothing runs today", async () => {
  await insOr("cloud-or", [{ id: "anthropic/claude-opus-5.5" }]);
  await raw("provider_pick_checks", orChecks({ "anthropic/claude-opus-5.5|chat": { ok: true, code: "ok", at: AT } }));
  invalidateRoleContext();
  await withServer(async (s) => {
    const plan = (await call(s, "GET", "/api/providers/cloud-or/plan")).json;
    const roles = plan.apply.map((x) => x.roleId);
    assert.ok(roles.length > 0, "something is pre-ticked");
    const stale = await call(s, "POST", "/api/providers/cloud-or/recommended", {
      body: { roles, previewHash: "nope", ackUnattended: true, ackCloud: true }, headers: csrfHeaders,
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.applied.length, 0);
    const pv = await call(s, "POST", "/api/providers/cloud-or/recommended/preview", { body: { roles }, headers: csrfHeaders });
    assert.equal(pv.status, 200);
    assert.equal(typeof pv.json.previewHash, "string");
    const ap = await call(s, "POST", "/api/providers/cloud-or/recommended", {
      body: { roles, previewHash: pv.json.previewHash, ackUnattended: true, ackCloud: true }, headers: csrfHeaders,
    });
    assert.equal(ap.status, 200);
    assert.deepEqual(ap.json.applied.map((x) => x.roleId).sort(), [...roles].sort());
    assert.ok(Array.isArray(ap.json.stillEmpty));
    assert.ok(!ap.text.includes(SECRET));
  }, addOpts());
  const b = JSON.parse(await settingOf("model_role.expert"));
  assert.equal(b.model, "cloud-or/anthropic/claude-opus-5.5");
});

test("a ticked role the fresh plan no longer offers: preview and apply answer 409 preview_changed with the fresh plan (F9)", async () => {
  await insOr("cloud-or", [{ id: "anthropic/claude-opus-5.5" }]);
  await raw("provider_pick_checks", orChecks({ "anthropic/claude-opus-5.5|chat": { ok: true, code: "ok", at: AT } }));
  invalidateRoleContext();
  await withServer(async (s) => {
    const plan = (await call(s, "GET", "/api/providers/cloud-or/plan")).json;
    const roles = plan.apply.map((x) => x.roleId);
    assert.ok(roles.length > 0);
    const pv = await call(s, "POST", "/api/providers/cloud-or/recommended/preview", { body: { roles }, headers: csrfHeaders });
    assert.equal(pv.status, 200);
    // The check now fails: the plan stops offering those roles.
    await raw("provider_pick_checks", orChecks({ "anthropic/claude-opus-5.5|chat": { ok: false, code: "no_tool_call", at: AT } }));
    invalidateRoleContext();
    const pv2 = await call(s, "POST", "/api/providers/cloud-or/recommended/preview", { body: { roles }, headers: csrfHeaders });
    assert.equal(pv2.status, 409);
    assert.equal(pv2.json.reason, "preview_changed");
    assert.ok(Array.isArray(pv2.json.plan?.apply) && Array.isArray(pv2.json.plan?.skipped));
    assert.ok(!pv2.json.plan.apply.some((x) => roles.includes(x.roleId)));
    const ap = await call(s, "POST", "/api/providers/cloud-or/recommended", {
      body: { roles, previewHash: pv.json.previewHash, ackUnattended: true, ackCloud: true }, headers: csrfHeaders,
    });
    assert.equal(ap.status, 409);
    assert.deepEqual(ap.json.applied, []);
    assert.ok(ap.json.refused.every((x) => x.reason === "preview_changed"));
    assert.ok(Array.isArray(ap.json.plan?.apply));
    for (const r of [pv2, ap]) assert.ok(!r.text.includes(SECRET));
  }, addOpts());
  assert.equal(await settingOf("model_role.expert"), null, "nothing written");
});

test("the gateway mounts the body error handler on both API prefixes", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../servers/gateway/boot/feature-mounts.js", import.meta.url), "utf8");
  assert.ok(src.includes('app.use(["/api/roles", "/api/providers"], rolesApiBodyErrorHandler);'));
  // After the roles router, so a parse error reaching these prefixes meets it.
  assert.ok(src.indexOf("app.use(rolesApiRouter());") < src.indexOf("rolesApiBodyErrorHandler);"));
});

test("a typed address is used only for Other; presets ignore it", async () => {
  const seen = [];
  const testFn = async (args) => { seen.push(args); return { ok: true, code: "ok", status: 200, models: ["x/y"], host: "h", baseUrl: args.baseUrl || OR_URL }; };
  await withServer(async (s) => {
    await call(s, "POST", "/api/providers/test", { body: { presetId: "openrouter", baseUrl: "https://api.example.com/v1", apiKey: "fixture-k" }, headers: csrfHeaders });
    assert.equal(seen.at(-1).baseUrl, undefined);
    await call(s, "POST", "/api/providers/test", { body: { presetId: "other", baseUrl: "https://api.example.com/v1", apiKey: "fixture-k" }, headers: csrfHeaders });
    assert.equal(seen.at(-1).baseUrl, "https://api.example.com/v1");
    const r = await call(s, "POST", "/api/providers", {
      body: { presetId: "openrouter", baseUrl: "https://api.example.com/v1", apiKey: "fixture-k", modelIds: ["x/y"] }, headers: csrfHeaders,
    });
    assert.equal(r.status, 200);
    assert.equal(seen.at(-1).baseUrl, undefined);
  }, addOpts({ testFn }));
  const row = (await db.execute("SELECT base_url FROM providers WHERE id = 'openrouter'")).rows[0];
  assert.equal(row.base_url, OR_URL);
});

test("door and bundle rows are not addable providers here", async () => {
  await insOr("crow-c-peer", [{ id: "anthropic/claude-haiku-5.5" }]);
  await insOr("CROW-C-upper", [{ id: "anthropic/claude-haiku-5.5" }]);
  await insOr("bundled", [{ id: "anthropic/claude-haiku-5.5" }]);
  await db.execute("UPDATE providers SET bundle_id = 'some-bundle' WHERE id = 'bundled'");
  invalidateRoleContext();
  let probes = 0;
  await withServer(async (s) => {
    for (const id of ["crow-c-peer", "CROW-C-upper", "bundled"]) {
      const plan = await call(s, "GET", `/api/providers/${id}/plan`);
      assert.equal(plan.status, 404, id);
      assert.equal(plan.json.error, "not_addable", id);
      for (const p of ["probe", "recommended/preview", "recommended"]) {
        const r = await call(s, "POST", `/api/providers/${id}/${p}`, { body: { roles: ["quick"] }, headers: csrfHeaders });
        assert.equal(r.status, 404, `${id} ${p}`);
      }
    }
  }, addOpts({ probeRequestFn: async () => { probes++; throw new Error("never"); } }));
  assert.equal(probes, 0);
});
