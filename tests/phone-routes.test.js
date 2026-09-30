import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { createDbClient } from "../servers/db.js";
import { initPhoneTables } from "../bundles/phone/server/init-tables.js";
import * as store from "../bundles/phone/server/store.js";
import { validatePlan } from "../bundles/phone/server/plan.js";

const s = {};
const saved = { CROW_HOME: process.env.CROW_HOME, CROW_APP_ROOT: process.env.CROW_APP_ROOT, PHONE_RUNNER_SECRET: process.env.PHONE_RUNNER_SECRET };

before(async () => {
  s.home = mkdtempSync(join(tmpdir(), "phone-routes-"));
  process.env.CROW_HOME = s.home;
  process.env.CROW_APP_ROOT = join(import.meta.dirname, "..");
  s.db = createDbClient(join(s.home, "crow.db"));
  await s.db.executeMultiple(`CREATE TABLE dashboard_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
    INSERT INTO dashboard_settings (key, value) VALUES ('phone_tcpa_ack','true'), ('phone_owner_name','Kevin');
    CREATE TABLE providers (id TEXT PRIMARY KEY, base_url TEXT, api_key TEXT, host TEXT, disabled INTEGER DEFAULT 0);
    INSERT INTO providers (id, base_url, host) VALUES ('loc','http://127.0.0.1:1/v1','local'), ('cld','https://x.example/v1','cloud');`);
  await initPhoneTables(s.db);
  s.secret = "f".repeat(48); process.env.PHONE_RUNNER_SECRET = s.secret;
  s.farend = []; s.inits = 0;
  const { default: phoneRouter } = await import("../bundles/phone/panel/routes.js");
  const auth = (req, res, next) => { const sess = req.headers["x-test-session"]; if (!sess) return res.status(401).end(); req.dashboardSession = sess; next(); };
  const router = phoneRouter(auth, {
    db: s.db, startDispatcher: false, onInit: () => { s.inits++; }, csrf: (req, res, next) => next(),
    runner: { farend: async (id, text) => { s.farend.push([id, text]); return { ok: true }; }, stop: async () => ({ ok: true }) },
    authority: { isLocalDashboardSession: async (_db, sess) => sess === "local", stepUpOk: async (code) => code === "123456" },
  });
  const app = express(); app.use(router);
  s.http = app.listen(0); await new Promise((r) => s.http.once("listening", r));
  s.base = `http://127.0.0.1:${s.http.address().port}`;
});

after(async () => {
  await new Promise((r) => s.http.close(r)); try { s.db.close(); } catch {}
  rmSync(s.home, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

async function newPlan() {
  const p = validatePlan({ business_name: "Smile", number: "512-555-0101", goal: "Book", language: "en" });
  return (await store.createPlan(s.db, p, { kind: "bot", id: "bobby" }, null)).call_id;
}
const post = (path, body, session = "local") => fetch(s.base + path, { method: "POST", headers: { "Content-Type": "application/json", ...(session ? { "x-test-session": session } : {}) }, body: JSON.stringify(body || {}) });

test("owner endpoints require a dashboard session", async () => {
  assert.equal((await fetch(s.base + "/api/phone/calls")).status, 401);
});

test("approve refuses SSO sessions, missing TOTP, missing business confirmation", async () => {
  const id = await newPlan();
  assert.equal((await post(`/api/phone/calls/${id}/approve`, { totp: "123456", business_confirmed: true }, "sso")).status, 403);
  assert.equal((await post(`/api/phone/calls/${id}/approve`, { totp: "000000", business_confirmed: true })).status, 403);
  assert.equal((await post(`/api/phone/calls/${id}/approve`, { totp: "123456" })).status, 400);
  const ok = await post(`/api/phone/calls/${id}/approve`, { totp: "123456", business_confirmed: true, allow_cloud: true });
  assert.equal(ok.status, 200);
  const c = await store.getCall(s.db, id);
  assert.equal(c.status, "approved"); assert.equal(c.allow_cloud, true);
});

test("approve refused until the owner acknowledged the AI-call notice", async () => {
  await s.db.execute({ sql: "UPDATE dashboard_settings SET value='false' WHERE key='phone_tcpa_ack'", args: [] });
  const id = await newPlan();
  assert.equal((await post(`/api/phone/calls/${id}/approve`, { totp: "123456", business_confirmed: true })).status, 409);
  await s.db.execute({ sql: "UPDATE dashboard_settings SET value='true' WHERE key='phone_tcpa_ack'", args: [] });
});

test("verify: runner secret required, token single-use", async () => {
  const id = await newPlan();
  const { token } = await store.approveCall(s.db, id, { session: "local", allowCloud: false });
  const v = (auth) => fetch(s.base + "/api/phone/verify", { method: "POST", headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify({ call_id: id, token }) });
  assert.equal((await v(null)).status, 401);
  assert.equal((await v("wrong")).status, 401);
  assert.deepEqual(await (await v(s.secret)).json(), { ok: true });
  assert.deepEqual(await (await v(s.secret)).json(), { ok: false });
});

test("farend relays owner-typed business lines to the runner (interactive FakeLine)", async () => {
  const id = await newPlan();
  await s.db.execute({ sql: "UPDATE phone_calls SET status='live' WHERE id=?", args: [id] });
  assert.equal((await post(`/api/phone/calls/${id}/farend`, { text: "Hello, Smile Dental" })).status, 200);
  assert.deepEqual(s.farend.at(-1), [id, "Hello, Smile Dental"]);
});

test("settings POST requires local session + TOTP and validates model specs", async () => {
  const good = { totp: "123456", localModel: "loc/m1", cloudModel: "cld/m2", dailyCap: 7.9 };
  assert.equal((await post("/api/phone/settings", good, "sso")).status, 403);
  assert.equal((await post("/api/phone/settings", { ...good, totp: "000000" })).status, 403);
  assert.equal((await post("/api/phone/settings", { totp: "123456", localModel: "cld/m2" })).status, 400);
  assert.equal((await post("/api/phone/settings", { totp: "123456", localModel: "nope/m" })).status, 400);
  assert.equal((await post("/api/phone/settings", { totp: "123456", cloudModel: "noslash" })).status, 400);
  assert.equal((await post("/api/phone/settings", good)).status, 200);
  const g = await (await fetch(s.base + "/api/phone/settings", { headers: { "x-test-session": "local" } })).json();
  assert.equal(g.localModel, "loc/m1"); assert.equal(g.cloudModel, "cld/m2"); assert.equal(g.dailyCap, 7);
  assert.equal((await post("/api/phone/settings", { totp: "123456", cloudModel: "" })).status, 200);
});

test("call reads never expose token_hash or approved_by_session", async () => {
  const id = await newPlan();
  await store.approveCall(s.db, id, { session: "local", allowCloud: false });
  const h = { "x-test-session": "local" };
  const list = await (await fetch(s.base + "/api/phone/calls", { headers: h })).json();
  const one = await (await fetch(s.base + `/api/phone/calls/${id}`, { headers: h })).json();
  for (const c of [...list.calls, one.call]) { assert.ok(!("token_hash" in c)); assert.ok(!("approved_by_session" in c)); }
});

test("verify with wrong secret does not burn the token", async () => {
  const id = await newPlan();
  const { token } = await store.approveCall(s.db, id, { session: "local", allowCloud: false });
  const v = (a) => fetch(s.base + "/api/phone/verify", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${a}` }, body: JSON.stringify({ call_id: id, token }) });
  assert.equal((await v("wrong")).status, 401);
  assert.deepEqual(await (await v(s.secret)).json(), { ok: true });
});

test("concurrent first requests share one init", async () => {
  await Promise.all([1, 2, 3].map(() => fetch(s.base + "/api/phone/calls", { headers: { "x-test-session": "local" } })));
  assert.equal(s.inits, 1);
});

test("panel renders in EN and ES with the approval controls and no backticks in the client script", async () => {
  const { default: panel } = await import("../bundles/phone/panel/phone.js");
  const layout = ({ title, content, scripts }) => `<title>${title}</title>${content}<script>${scripts || ""}</script>`;
  for (const lang of ["en", "es"]) {
    const html = await panel.handler({ query: {} }, {}, { db: s.db, layout, appRoot: process.env.CROW_APP_ROOT, lang });
    assert.match(html, /id="phone-pending"/);
    assert.match(html, /id="phone-live"/);
    assert.match(html, /name="business_confirmed"/);
    assert.match(html, /name="allow_cloud"/);
    assert.match(html, /name="totp"/);
    const script = html.split("<script>")[1] || "";
    assert.equal(script.includes("`"), false, "no backticks in client script");
  }
  const es = await panel.handler({ query: {} }, {}, { db: s.db, layout, appRoot: process.env.CROW_APP_ROOT, lang: "es" });
  assert.match(es, /Aprobar/);
});
