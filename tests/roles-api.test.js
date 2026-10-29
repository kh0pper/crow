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
const SECRET = "sk-test-never-echo-0123456789";

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
    const r = await call(s, "POST", "/api/roles/custom", { body: { model: "local-chat/m1", previewHash: "x" } });
    assert.equal(r.status, 404);
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
