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
// I4 (spec 2026-10-01): every approval names the plan_hash the owner was shown.
async function approveFresh(d, id, o = {}) {
  return store.approveCall(d, id, { expectedHash: (await store.getCall(d, id)).plan_hash, ...o });
}


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
  s.farend = []; s.inits = 0; s.stops = []; s.runnerActive = true; s.cards = [];
  const { default: phoneRouter } = await import("../bundles/phone/panel/routes.js");
  const auth = (req, res, next) => { const sess = req.headers["x-test-session"]; if (!sess) return res.status(401).end(); req.dashboardSession = sess; next(); };
  const router = phoneRouter(auth, {
    db: s.db, startDispatcher: false, onInit: () => { s.inits++; }, csrf: (req, res, next) => next(),
    runner: { farend: async (id, text) => { s.farend.push([id, text]); return { ok: true }; }, stop: async (id) => { s.stops.push(id); return { ok: true }; },
      events: async () => ({ events: [], done: false, active: s.runnerActive }) },
    authority: { isLocalDashboardSession: async (_db, sess) => sess === "local", stepUpOk: async (code) => code === "123456", totpRequired: async () => s.totpOn === true },
    notifyCard: async (sid, frame, opts) => { s.cards.push([sid, frame, opts]); return { delivered: true, botId: opts && opts.botId }; },
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

const hashOf = async (id) => (await store.getCall(s.db, id)).plan_hash;
let planN = 0; // distinct bot ids keep every test clear of the per-bot plan rate limit
async function newPlan() {
  const p = validatePlan({ business_name: "Smile", number: "512-555-0101", goal: "Book", language: "en" });
  return (await store.createPlan(s.db, p, { kind: "bot", id: "bobby-" + (++planN) }, null)).call_id;
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
  const ok = await post(`/api/phone/calls/${id}/approve`, { totp: "123456", business_confirmed: true, allow_cloud: true, plan_hash: await hashOf(id) });
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
  const { token } = await approveFresh(s.db, id, { session: "local", allowCloud: false });
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
  await approveFresh(s.db, id, { session: "local", allowCloud: false });
  const h = { "x-test-session": "local" };
  const list = await (await fetch(s.base + "/api/phone/calls", { headers: h })).json();
  const one = await (await fetch(s.base + `/api/phone/calls/${id}`, { headers: h })).json();
  for (const c of [...list.calls, one.call]) { assert.ok(!("token_hash" in c)); assert.ok(!("approved_by_session" in c)); }
});

test("verify with wrong secret does not burn the token", async () => {
  const id = await newPlan();
  const { token } = await approveFresh(s.db, id, { session: "local", allowCloud: false });
  const v = (a) => fetch(s.base + "/api/phone/verify", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${a}` }, body: JSON.stringify({ call_id: id, token }) });
  assert.equal((await v("wrong")).status, 401);
  assert.deepEqual(await (await v(s.secret)).json(), { ok: true });
});

test("concurrent first requests share one init", async () => {
  await Promise.all([1, 2, 3].map(() => fetch(s.base + "/api/phone/calls", { headers: { "x-test-session": "local" } })));
  assert.equal(s.inits, 1);
});

test("panel renders in EN and ES with the approval controls and no backticks in the client script", async () => {
  const { default: panel, PHONE_STRINGS } = await import("../bundles/phone/panel/phone.js");
  const layout = ({ title, content, scripts }) => `<title>${title}</title>${content}<script>${scripts || ""}</script>`;
  const enKeys = Object.keys(PHONE_STRINGS.en).sort();
  const esKeys = Object.keys(PHONE_STRINGS.es).sort();
  assert.deepEqual(enKeys, esKeys, "EN and ES have identical key sets");
  for (const lang of ["en", "es"]) {
    const html = await panel.handler({ query: {} }, {}, { db: s.db, layout, appRoot: process.env.CROW_APP_ROOT, lang });
    assert.match(html, /id="phone-pending"/);
    assert.match(html, /id="phone-live"/);
    assert.match(html, /name="business_confirmed"/);
    assert.match(html, /name="allow_cloud"/);
    assert.match(html, /name="totp"/);
    assert.match(html, /class="phone-share-edit"/);
    assert.match(html, /class="phone-cloud-model"/);
    const script = (html.split("<script>")[1] || "").split("</script>")[0];
    assert.equal(script.includes("`"), false, "no backticks in client script");
    assert.equal(script.includes("${"), false, "no dollar-brace in client script");
    assert.doesNotThrow(function () { new Function(script); }, "script is valid JavaScript");
  }
  const en = await panel.handler({ query: {} }, {}, { db: s.db, layout, appRoot: process.env.CROW_APP_ROOT, lang: "en" });
  const script = en.split("<script>")[1].split("</script>")[0];
  assert.match(script, /createElement\('textarea'\)/, "an editable textarea per shareable value");
  assert.match(script, /'share_' \+ k/, "textareas are named share_<key>");
  assert.match(script, /edits = \{ shareable: edited \}/, "approve sends the edited shareable values");
  assert.match(script, /esc\(sh\[k\]\)/, "shareable VALUES are shown, escaped");
  assert.match(script, /var lastPendingKey = null;/, "first empty load renders 'Nothing here yet.'");
  const es = await panel.handler({ query: {} }, {}, { db: s.db, layout, appRoot: process.env.CROW_APP_ROOT, lang: "es" });
  assert.match(es, /Aprobar/);
});

async function sharePlan() {
  const p = validatePlan({ business_name: "Smile", number: "512-555-0101", goal: "Book", language: "en", shareable: { name: "Kevin", date_of_birth: "1980-01-01" } });
  return (await store.createPlan(s.db, p, { kind: "bot", id: "bobby-" + (++planN) }, null)).call_id;
}

test("approve with edits.shareable stores the owner-edited values (cleared field withheld)", async () => {
  const id = await sharePlan();
  const r = await post(`/api/phone/calls/${id}/approve`, { totp: "123456", business_confirmed: true, plan_hash: await hashOf(id), edits: { shareable: { name: "Kev", date_of_birth: "" } } });
  assert.equal(r.status, 200);
  const c = await store.getCall(s.db, id);
  assert.equal(c.status, "approved");
  assert.deepEqual(c.shareable, { name: "Kev" });
});

test("approve requires a non-empty owner name (409 owner_name_required)", async () => {
  await s.db.execute({ sql: "UPDATE dashboard_settings SET value='  ' WHERE key='phone_owner_name'", args: [] });
  try {
    const id = await newPlan();
    const r = await post(`/api/phone/calls/${id}/approve`, { totp: "123456", business_confirmed: true });
    assert.equal(r.status, 409);
    assert.equal((await r.json()).error, "owner_name_required");
    assert.equal((await store.getCall(s.db, id)).status, "awaiting_approval");
  } finally {
    await s.db.execute({ sql: "UPDATE dashboard_settings SET value='Kevin' WHERE key='phone_owner_name'", args: [] });
  }
});

test("reject and edit require a local password session (403 local_login_required)", async () => {
  const id = await newPlan();
  for (const [path, body] of [[`/api/phone/calls/${id}/reject`, {}], [`/api/phone/calls/${id}/edit`, { edits: { goal: "x" } }]]) {
    const r = await post(path, body, "sso");
    assert.equal(r.status, 403, path);
    assert.equal((await r.json()).error, "local_login_required");
  }
  assert.equal((await store.getCall(s.db, id)).status, "awaiting_approval");
  assert.equal((await post(`/api/phone/calls/${id}/reject`, {})).status, 200);
  assert.equal((await store.getCall(s.db, id)).status, "rejected");
});

test("stop on an orphaned call (runner not running it) finalizes it stopped 'stopped by owner'", async () => {
  const id = await newPlan();
  await s.db.execute({ sql: "UPDATE phone_calls SET status='live', started_at=datetime('now') WHERE id=?", args: [id] });
  s.runnerActive = false;
  try {
    assert.equal((await post(`/api/phone/calls/${id}/stop`, {})).status, 200);
  } finally { s.runnerActive = true; }
  assert.ok(s.stops.includes(id));
  const c = await store.getCall(s.db, id);
  assert.equal(c.status, "done"); assert.equal(c.outcome, "stopped"); assert.equal(c.error, "stopped by owner");
});

test("stop on an active call only asks the runner (the runner's result finalizes it)", async () => {
  const id = await newPlan();
  await s.db.execute({ sql: "UPDATE phone_calls SET status='live', started_at=datetime('now') WHERE id=?", args: [id] });
  assert.equal((await post(`/api/phone/calls/${id}/stop`, {})).status, 200);
  assert.equal((await store.getCall(s.db, id)).status, "live");
});

test("call reads, settings read and far-end input require a local password session", async () => {
  const id = await newPlan();
  await s.db.execute({ sql: "UPDATE phone_calls SET status='live' WHERE id=?", args: [id] });
  const get = (path, session) => fetch(s.base + path, { headers: { "x-test-session": session } });
  for (const path of ["/api/phone/calls", `/api/phone/calls/${id}`, "/api/phone/settings"]) {
    const r = await get(path, "sso");
    assert.equal(r.status, 403, path);
    assert.equal((await r.json()).error, "local_login_required");
    assert.equal((await get(path, "local")).status, 200, path);
  }
  const before = s.farend.length;
  const r = await post(`/api/phone/calls/${id}/farend`, { text: "steer" }, "sso");
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, "local_login_required");
  assert.equal(s.farend.length, before);
  assert.equal((await post(`/api/phone/calls/${id}/farend`, { text: "ok" }, "local")).status, 200);
});

test("I4: approve needs the plan_hash that was shown — missing 400, stale 409, SSO still 403", async () => {
  const id = await newPlan();
  const shown = await hashOf(id);
  let r = await post(`/api/phone/calls/${id}/approve`, { totp: "123456", business_confirmed: true });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "plan_hash_required");
  assert.equal((await post(`/api/phone/calls/${id}/approve`, { totp: "123456", business_confirmed: true, plan_hash: shown }, "sso")).status, 403);
  assert.equal((await post(`/api/phone/calls/${id}/edit`, { edits: { goal: "Ask hours" } })).status, 200);
  r = await post(`/api/phone/calls/${id}/approve`, { totp: "123456", business_confirmed: true, plan_hash: shown });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error, "plan_changed");
  assert.equal((await store.getCall(s.db, id)).status, "awaiting_approval");
  assert.equal((await post(`/api/phone/calls/${id}/approve`, { totp: "123456", business_confirmed: true, plan_hash: await hashOf(id) })).status, 200);
});

test("approve run_after: null clears a proposed time; a bad time is 400", async () => {
  const p = validatePlan({ business_name: "Smile", number: "512-555-0101", goal: "Book", language: "en", run_after: "2030-01-01T15:00:00Z" });
  const mk = async () => (await store.createPlan(s.db, p, { kind: "bot", id: "bobby-" + (++planN) }, null)).call_id;
  const a = await mk();
  assert.equal((await post(`/api/phone/calls/${a}/approve`, { totp: "123456", business_confirmed: true, plan_hash: await hashOf(a), run_after: null })).status, 200);
  assert.equal((await store.getCall(s.db, a)).run_after, null);
  const b = await mk();
  const r = await post(`/api/phone/calls/${b}/approve`, { totp: "123456", business_confirmed: true, plan_hash: await hashOf(b), run_after: "next tuesday-ish" });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "invalid_run_after");
  assert.equal((await store.getCall(s.db, b)).status, "awaiting_approval");
});

test("backlog P7: run_after must be null, absent, or a strict ISO-8601 instant with a zone", async () => {
  const p = validatePlan({ business_name: "Smile", number: "512-555-0101", goal: "Book", language: "en" });
  const mk = async () => (await store.createPlan(s.db, p, { kind: "bot", id: "bobby-" + (++planN) }, null)).call_id;
  for (const bad of [0, 1767225600000, false, true, "", "  ", {}, [], "Tue, 6 Oct 2026 15:30:00 GMT", "2030-01-01", "2030-01-01T15:30",
    "2030-01-01T15:30:00", "2030-02-30T15:30:00Z", "2030-13-01T15:30:00Z", "2030-01-01T24:00:00Z", "2030-01-01 15:30:00Z", "  2030-01-01T15:30:00Z"]) {
    const id = await mk();
    const r = await post(`/api/phone/calls/${id}/approve`, { totp: "123456", business_confirmed: true, plan_hash: await hashOf(id), run_after: bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.equal((await r.json()).error, "invalid_run_after", JSON.stringify(bad));
    assert.equal((await store.getCall(s.db, id)).status, "awaiting_approval", JSON.stringify(bad));
  }
  for (const [good, want] of [["2030-01-01T15:30:00.000Z", "2030-01-01T15:30:00.000Z"], ["2030-01-01T15:30Z", "2030-01-01T15:30:00.000Z"],
    ["2030-01-01T09:30:00-06:00", "2030-01-01T15:30:00.000Z"], ["2028-02-29T12:00:00Z", "2028-02-29T12:00:00.000Z"]]) {
    const id = await mk();
    const r = await post(`/api/phone/calls/${id}/approve`, { totp: "123456", business_confirmed: true, plan_hash: await hashOf(id), run_after: good });
    assert.equal(r.status, 200, good);
    assert.equal((await store.getCall(s.db, id)).run_after, want, good);
  }
  const { parseIsoInstant } = await import("../bundles/phone/server/plan.js");
  assert.equal(parseIsoInstant("2027-02-29T12:00:00Z"), null, "not a leap year");
});

test("backlog P13: GET /perch/:sid/calls follows the NEWEST perch-live row — a session now owned by another bot hides the old bot's calls", async () => {
  await s.db.executeMultiple(`CREATE TABLE IF NOT EXISTS bot_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT, gateway_type TEXT, gateway_thread_id TEXT, kind TEXT);
    INSERT INTO bot_sessions (bot_id, gateway_type, gateway_thread_id, kind) VALUES ('hank','perch','perch-R13','perch-live');
    INSERT INTO bot_sessions (bot_id, gateway_type, gateway_thread_id, kind) VALUES ('ivy','perch','perch-R13','perch-live');
    INSERT INTO bot_sessions (bot_id, gateway_type, gateway_thread_id, kind) VALUES ('hank','perch','perch-R13','gateway');`);
  const p = validatePlan({ business_name: "Smile", number: "512-555-0101", goal: "Book", language: "en" });
  await store.createPlan(s.db, p, { kind: "bot", id: "hank" }, { kind: "perch", session_id: "perch-R13" });
  const ivys = (await store.createPlan(s.db, p, { kind: "bot", id: "ivy" }, { kind: "perch", session_id: "perch-R13" })).call_id;
  const j = await (await fetch(s.base + "/api/phone/perch/perch-R13/calls", { headers: { "x-test-session": "local" } })).json();
  assert.deepEqual(j.calls.map((c) => c.id), [ivys], "only the newest perch-live owner's calls; a newer non-perch-live row does not count");
});

test("I4: the Phone panel sends the plan_hash it rendered, sends run_after null for 'now', and re-renders when the hash changes", async () => {
  const { default: panel } = await import("../bundles/phone/panel/phone.js");
  const layout = ({ content, scripts }) => `${content}<script>${scripts || ""}</script>`;
  const html = await panel.handler({ query: {} }, {}, { db: s.db, layout, appRoot: process.env.CROW_APP_ROOT, lang: "en" });
  const script = html.split("<script>")[1].split("</script>")[0];
  assert.match(script, /plan_hash: c\.plan_hash/);
  assert.match(script, /new Date\(f\.run_after\.value\)\.toISOString\(\) : null;/);
  assert.match(script, /return c\.id \+ ':' \+ c\.plan_hash;/);
  assert.match(script, /if \(e\.status === 409 && e\.data && e\.data\.error === 'plan_changed'\) \{ lastPendingKey = null; load\(\); \}/);
  assert.equal(script.includes("`"), false);
  assert.doesNotThrow(function () { new Function(script); });
});

test("m1: the Phone panel shows a bot-proposed run_after and prefills the time field with it (blank still means now)", async () => {
  const { default: panel, PHONE_STRINGS } = await import("../bundles/phone/panel/phone.js");
  assert.equal(PHONE_STRINGS.en.proposed, "Proposed time");
  assert.ok(PHONE_STRINGS.es.proposed);
  const layout = ({ content, scripts }) => `${content}<script>${scripts || ""}</script>`;
  const html = await panel.handler({ query: {} }, {}, { db: s.db, layout, appRoot: process.env.CROW_APP_ROOT, lang: "en" });
  const script = html.split("<script>")[1].split("</script>")[0];
  assert.match(script, /f\.run_after\.value = localInput\(c\.run_after\);/);
  assert.match(script, /c\.run_after \? '<br>' \+ esc\(L\.proposed\) \+ ': ' \+ esc\(fmtWhen\(c\.run_after\)\)/);
  assert.match(script, /var ra = f\.run_after\.value \? new Date\(f\.run_after\.value\)\.toISOString\(\) : null;/);
  // localInput round-trips: the prefilled value submits the same instant the bot proposed.
  const src = script.slice(script.indexOf("function localInput"), script.indexOf("function fmtWhen"));
  const localInput = new Function(src + "; return localInput;")();
  assert.equal(localInput(null), "");
  assert.equal(localInput("garbage"), "");
  const iso = "2030-01-01T15:30:00.000Z";
  assert.equal(new Date(localInput(iso)).toISOString(), iso);
});

test("I5: GET /perch/:sid/calls — local only, this session's bot only, no secrets", async () => {
  await s.db.executeMultiple(`CREATE TABLE IF NOT EXISTS bot_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT, gateway_type TEXT, gateway_thread_id TEXT, kind TEXT);
    INSERT INTO bot_sessions (bot_id, gateway_type, gateway_thread_id, kind) VALUES ('hank','perch','perch-R1','perch-live'), ('ivy','perch','perch-R2','perch-live');`);
  const p = validatePlan({ business_name: "Smile", number: "512-555-0101", goal: "Book", language: "en" });
  const mine = (await store.createPlan(s.db, p, { kind: "bot", id: "hank" }, { kind: "perch", session_id: "perch-R1" })).call_id;
  await store.createPlan(s.db, p, { kind: "bot", id: "ivy" }, { kind: "perch", session_id: "perch-R1" }); // ivy's child forged only the thread
  await store.createPlan(s.db, p, { kind: "bot", id: "ivy" }, { kind: "perch", session_id: "perch-R2" });
  await store.approveCall(s.db, mine, { session: "local", allowCloud: false, expectedHash: await hashOf(mine) });
  const get = (path, session) => fetch(s.base + path, { headers: session ? { "x-test-session": session } : {} });
  assert.equal((await get("/api/phone/perch/perch-R1/calls")).status, 401);
  const sso = await get("/api/phone/perch/perch-R1/calls", "sso");
  assert.equal(sso.status, 403);
  assert.equal((await sso.json()).error, "local_login_required");
  const j = await (await get("/api/phone/perch/perch-R1/calls", "local")).json();
  assert.deepEqual(j.calls.map((c) => c.id), [mine]);
  for (const k of ["plan_hash", "status", "transcript", "allow_cloud", "outcome", "summary", "deliver_to"]) assert.ok(k in j.calls[0], k);
  assert.ok(!("token_hash" in j.calls[0]));
  assert.ok(!("approved_by_session" in j.calls[0]));
  assert.deepEqual((await (await get("/api/phone/perch/no-such-session/calls", "local")).json()).calls, []);
});

test("I-1: GET /perch/:sid/calls — a transient bot_sessions error is a 500, not an empty list", async () => {
  const { default: phoneRouter } = await import("../bundles/phone/panel/routes.js");
  const busyDb = new Proxy(s.db, { get(t, k) {
    if (k === "execute") return async (q) => {
      const sql = typeof q === "string" ? q : q.sql;
      if (/FROM bot_sessions/.test(sql)) throw Object.assign(new Error("SQLITE_BUSY: database is locked"), { code: "SQLITE_BUSY" });
      return t.execute(q);
    };
    const v = t[k]; return typeof v === "function" ? v.bind(t) : v;
  } });
  const auth = (req, res, next) => { req.dashboardSession = req.headers["x-test-session"]; next(); };
  const router = phoneRouter(auth, { db: busyDb, startDispatcher: false, csrf: (req, res, next) => next(),
    runner: { farend: async () => ({ ok: true }), stop: async () => ({ ok: true }), events: async () => ({ events: [], done: false }) },
    authority: { isLocalDashboardSession: async (_db, sess) => sess === "local", stepUpOk: async () => false, totpRequired: async () => false },
    notifyCard: async () => ({ delivered: false }) });
  const app = express(); app.use(router);
  const srv = app.listen(0); await new Promise((r) => srv.once("listening", r));
  try {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/phone/perch/perch-R1/calls`, { headers: { "x-test-session": "local" } });
    assert.equal(r.status, 500);
    assert.equal((await r.json()).error, "SQLITE_BUSY");
  } finally { await new Promise((r) => srv.close(r)); }
});

test("I7: whoami — local/totp/cloud for a password session; nothing for SSO", async () => {
  await s.db.execute({ sql: "INSERT INTO dashboard_settings (key, value) VALUES ('phone_cloud_model','cld/m9') ON CONFLICT(key) DO UPDATE SET value=excluded.value", args: [] });
  try {
    const who = async (sess) => (await fetch(s.base + "/api/phone/whoami", { headers: { "x-test-session": sess } })).json();
    assert.deepEqual(await who("local"), { local: true, totp_required: false, cloud_model: "cld/m9" });
    s.totpOn = true;
    assert.equal((await who("local")).totp_required, true);
    assert.deepEqual(await who("sso"), { local: false, totp_required: false, cloud_model: null });
    assert.equal((await fetch(s.base + "/api/phone/whoami")).status, 401);
  } finally {
    s.totpOn = false;
    await s.db.execute({ sql: "UPDATE dashboard_settings SET value='' WHERE key='phone_cloud_model'", args: [] });
  }
});

const perchPlan = async () => (await store.createPlan(s.db, validatePlan({ business_name: "Smile", number: "512-555-0101", goal: "Book", language: "en" }),
  { kind: "bot", id: "hank-" + (++planN) }, { kind: "perch", session_id: "perch-push" })).call_id;

test("approve, edit and reject push a pointer frame to the requesting Perch chat; a refused action pushes nothing", async () => {
  const botOf = async (id) => (await store.getCall(s.db, id)).created_by.id;
  s.cards.length = 0;
  const a = await perchPlan();
  assert.equal((await post(`/api/phone/calls/${a}/approve`, { totp: "123456", business_confirmed: true, plan_hash: await hashOf(a) })).status, 200);
  const b = await perchPlan();
  assert.equal((await post(`/api/phone/calls/${b}/edit`, { edits: { goal: "Ask hours" } })).status, 200);
  assert.equal((await post(`/api/phone/calls/${b}/reject`, {})).status, 200);
  assert.deepEqual(s.cards.map(([sid, f]) => [sid, f.call_id, f.status]),
    [["perch-push", a, "approved"], ["perch-push", b, "awaiting_approval"], ["perch-push", b, "rejected"]]);
  assert.deepEqual(s.cards[0][2], { botId: await botOf(a) });
  const c = await perchPlan(); const n = s.cards.length;
  assert.equal((await post(`/api/phone/calls/${c}/approve`, { totp: "000000", business_confirmed: true, plan_hash: await hashOf(c) })).status, 403);
  assert.equal((await post(`/api/phone/calls/${c}/reject`, {}, "sso")).status, 403);
  assert.equal(s.cards.length, n);
});

test("stop finalizing an orphaned call pushes the terminal state; a stop the runner handles pushes nothing yet", async () => {
  const a = await perchPlan();
  await s.db.execute({ sql: "UPDATE phone_calls SET status='live', started_at=datetime('now') WHERE id=?", args: [a] });
  s.cards.length = 0;
  assert.equal((await post(`/api/phone/calls/${a}/stop`, {})).status, 200);
  assert.equal(s.cards.length, 0, "runner still has it: its result (via the dispatcher) pushes");
  s.runnerActive = false;
  try { assert.equal((await post(`/api/phone/calls/${a}/stop`, {}, "sso")).status, 200); }
  finally { s.runnerActive = true; }
  assert.deepEqual(s.cards.map(([, f]) => [f.call_id, f.status]), [[a, "done"]]);
});

test("spec 2026-10-02: the Phone panel labels every outcome (stopped included) in EN and ES, shows the summary, and says Hang up", async () => {
  const { OUTCOMES } = await import("../bundles/phone/server/plan.js");
  const { default: panel, PHONE_STRINGS } = await import("../bundles/phone/panel/phone.js");
  for (const lang of ["en", "es"]) assert.deepEqual(Object.keys(PHONE_STRINGS[lang].outcomes).sort(), [...OUTCOMES].sort(), lang);
  assert.equal(PHONE_STRINGS.en.outcomes.stopped, "Stopped by you");
  assert.equal(PHONE_STRINGS.es.outcomes.stopped, "Detenida por ti");
  assert.equal(PHONE_STRINGS.en.stop, "Hang up");
  const layout = ({ content, scripts }) => `${content}<script>${scripts || ""}</script>`;
  const html = await panel.handler({ query: {} }, {}, { db: s.db, layout, appRoot: process.env.CROW_APP_ROOT, lang: "en" });
  const script = html.split("<script>")[1].split("</script>")[0];
  assert.match(script, /esc\(L\.outcomes\[c\.outcome\] \|\| c\.outcome\)/);
  assert.match(script, /c\.summary \? '<br>' \+ esc\(c\.summary\)/);
  assert.doesNotThrow(function () { new Function(script); });
});

// ---- backlog P5/P6/P8 (2026-10-02 phone polish): the Phone panel's client ----

async function panelScript(lang = "en") {
  const { default: panel } = await import("../bundles/phone/panel/phone.js");
  const layout = ({ content, scripts }) => `${content}<script>${scripts || ""}</script>`;
  const html = await panel.handler({ query: {} }, {}, { db: s.db, layout, appRoot: process.env.CROW_APP_ROOT, lang });
  return { html, script: html.split("<script>")[1].split("</script>")[0] };
}

/** Runs the panel script against a stub DOM; /api/phone/calls answers with statusFn(). */
function runPanel(script, statusFn) {
  const els = {}, timers = new Map(); let seq = 1; const alerts = [];
  const el = (id) => (els[id] ??= { id, hidden: id === "phone-lost", innerHTML: "", textContent: "", value: "",
    ownerName: {}, ownerNumber: {}, localModel: {}, cloudModel: {}, dailyCap: {}, tcpaAck: {}, totp: {}, querySelector: () => null });
  const win = {};
  const sandbox = {
    window: win, alert: (m) => alerts.push(m),
    document: { getElementById: el, querySelector: () => null },
    setTimeout: (fn, d) => { const id = seq++; timers.set(id, [fn, d]); return id; },
    clearTimeout: (id) => timers.delete(id), clearInterval: (id) => timers.delete(id),
    fetch: async (url, opts) => {
      const u = String(url);
      if (u.endsWith("/settings")) {
        if (!settings) return { ok: false, status: 500, json: async () => ({ error: "boom" }) };
        return { ok: true, status: 200, json: async () => (opts && opts.method === "POST" ? { ok: true } : settings) };
      }
      const st = u.endsWith("/calls") ? statusFn() : 500;
      return { ok: st >= 200 && st < 300, status: st, json: async () => (st === 200 ? { calls: [] } : { error: "boom" }) };
    },
  };
  let settings = null;
  new Function(...Object.keys(sandbox), script)(...Object.values(sandbox));
  const hops = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
  const fire = async () => { const [[id, [fn, d]]] = [...timers.entries()]; timers.delete(id); fn(); await hops(); return d; };
  return { els, timers, alerts, hops, fire, setSettings: (v) => { settings = v; } };
}

test("backlog P5: the Phone panel poll backs off, stops after five failures in a row, and Retry resumes it", async () => {
  const { script, html } = await panelScript("en");
  assert.match(html, /<p id="phone-lost" hidden>Lost touch with Phone — updates stopped\. <button type="button" id="phone-retry">Retry<\/button><\/p>/);
  let status = 500, gets = 0;
  const p = runPanel(script, () => { gets++; return status; });
  await p.hops();
  assert.equal(gets, 1, "the first load ran at once");
  const delays = [];
  while (p.timers.size) delays.push(await p.fire());
  assert.deepEqual(delays, [3000, 6000, 12000, 24000], "each failure doubles the wait; the fifth stops it");
  assert.equal(gets, 5);
  assert.equal(p.els["phone-lost"].hidden, false, "the panel says it lost touch");
  status = 200;
  p.els["phone-retry"].onclick();
  await p.hops();
  assert.equal(p.els["phone-lost"].hidden, true);
  assert.equal(gets, 6);
  assert.deepEqual([...p.timers.values()].map(([, d]) => d), [1500], "healthy again: 1.5 s");
});

test("backlog P5: a 401 stops the Phone panel poll for good", async () => {
  const { script } = await panelScript("en");
  const p = runPanel(script, () => 401);
  await p.hops();
  assert.equal(p.timers.size, 0);
  assert.notEqual(p.els["phone-lost"]?.hidden, false, "a signed-out page is not 'lost touch'");
});

test("backlog P6/P8: the Phone panel shows refusal codes in the owner's language and only plan_changed re-renders", async () => {
  const { PHONE_STRINGS } = await import("../bundles/phone/panel/phone.js");
  assert.deepEqual(Object.keys(PHONE_STRINGS.es.errors).sort(), Object.keys(PHONE_STRINGS.en.errors).sort());
  for (const code of ["business_confirmation_required", "notice_not_acknowledged", "owner_name_required", "local_login_required",
    "totp_required", "invalid_run_after", "plan_changed", "not_pending", "not_live", "invalid_model"]) {
    assert.ok(PHONE_STRINGS.en.errors[code] && PHONE_STRINGS.es.errors[code], code);
    assert.notEqual(PHONE_STRINGS.en.errors[code], PHONE_STRINGS.es.errors[code], code);
  }
  for (const lang of ["en", "es"]) {
    const { script } = await panelScript(lang);
    const L = JSON.parse(script.slice(script.indexOf("var L = ") + 8, script.indexOf(";  var lastPendingKey")));
    const errText = new Function("L", script.slice(script.indexOf("function errText"), script.indexOf("  function api(")) + "; return errText;")(L);
    assert.equal(errText({ error: "notice_not_acknowledged", message: "Acknowledge the AI-call notice in Phone settings first." }), PHONE_STRINGS[lang].errors.notice_not_acknowledged);
    assert.equal(errText({ error: "brand_new_code", message: "server words" }), "server words");
    assert.equal(errText({ error: "toString" }), "toString", "no prototype keys");
    assert.match(script, /alert\(errText\(j\)\)/);
    assert.ok(!/if \(e\.status === 409\) \{/.test(script), "a bare 409 no longer wipes the typed 2FA");
  }
});

test("review M6: a successful load from outside the poll (here: settings saved, cloud model changed) clears 'lost touch' and resumes", async () => {
  const { script } = await panelScript("en");
  let status = 500;
  const p = runPanel(script, () => status);
  await p.hops();
  while (p.timers.size) await p.fire();
  assert.equal(p.els["phone-lost"].hidden, false);
  status = 200;
  // Settings save → loadSettings → a changed cloud model → load(): a non-poll success.
  p.setSettings({ cloudModel: "cld/m" });
  p.els["phone-settings"].onsubmit({ preventDefault() {}, target: p.els["phone-settings"] });
  await p.hops(10);
  assert.equal(p.els["phone-lost"].hidden, true, "the notice is gone");
  assert.deepEqual([...p.timers.values()].map(([, d]) => d), [1500], "the poll runs again");
});
