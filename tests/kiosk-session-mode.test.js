/**
 * Kiosk "session mode": the dashboard's Talk to Crow overlay loads the kiosk
 * page at /display/session for a user who is ALREADY logged in to the
 * dashboard — no pairing code, no stored device.
 *
 * This file runs the kiosk runtime against the REAL core auth (isAllowedNetwork,
 * sessionFromRequest, verifySession, csrfTokenAccepted) on an init-db'd scratch
 * database, because the point of the suite is the new auth path:
 *   - no session cookie            → refused (page and WebSocket)
 *   - Tailscale Funnel header      → refused, even with a valid session
 *   - off the allowed network      → refused, even with a valid session
 *   - cross-origin WebSocket       → refused, even with a valid session
 *   - valid session, no CSRF token → refused at hello
 *   - valid session + CSRF token   → works, and writes NO device record
 *   - the paired-device flow is untouched, and its token opens nothing here
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";

const dir = mkdtempSync(join(tmpdir(), "kiosk-session-mode-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
delete process.env.CROW_DB_PATH;
delete process.env.CROW_DASHBOARD_PUBLIC;
delete process.env.CROW_CSRF_STRICT;
const REPO = new URL("..", import.meta.url).pathname;

const SERVE = { "Tailscale-User-Login": "alex@example.com" };   // what Tailscale Serve adds for a tailnet user
const CSRF = "c5f0c5f0c5f0c5f0c5f0c5f0c5f0c5f0";
const PAGE = "/display/session";
const WS_PATH = "/api/kiosk/session/dashboard";

let auth, csrf, store, registry, createDbClient, kiosk, wrapPcmAsWav;
let rt, srv, base, sessionToken;
const turnCalls = [];
const logs = [];

const open = () => createDbClient();
async function withDb(fn) { const db = open(); try { return await fn(db); } finally { db.close(); } }
const cookie = (tok = sessionToken, c = CSRF) => `crow_session=${tok}; crow_csrf=${c}`;
const wsUrl = (path = WS_PATH) => base.replace("http", "ws") + path;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { cwd: REPO, env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "ignore" });
  auth = await import("../servers/gateway/dashboard/auth.js");
  csrf = await import("../servers/gateway/dashboard/shared/csrf.js");
  store = await import("../servers/shared/device-store.js");
  registry = await import("../servers/gateway/dashboard/settings/registry.js");
  ({ createDbClient } = await import("../servers/db.js"));
  kiosk = await import("../bundles/kiosk/server/runtime.js");
  ({ wrapPcmAsWav } = await import("../servers/gateway/voice/turn-helpers.js"));

  await withDb(async (db) => {
    await db.execute({ sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES ('b-house','House','{}',1),('a-first','First','{}',1),('z-off','Off','{}',0)", args: [] });
    await registry.writeSetting(db, "stt_profiles", JSON.stringify([{ id: "fw", provider: "fasterwhisper", baseUrl: "http://localhost:8004/v1" }]));
    await registry.writeSetting(db, "tts_profiles", JSON.stringify([{ id: "kk", provider: "kokoro", name: "Kokoro (local)" }]));
  });
  ({ token: sessionToken } = await auth.mintSsoSession("test"));

  rt = kiosk.createKioskRuntime({
    Router: express.Router, json: express.json, WebSocketServer,
    isAllowedNetwork: auth.isAllowedNetwork,
    csrfMiddleware: csrf.csrfMiddleware,
    csrfTokenAccepted: csrf.csrfTokenAccepted,
    sessionFromRequest: auth.sessionFromRequest,
    verifySession: auth.verifySession,
    openDb: open, deviceStore: store,
    settings: { readSetting: registry.readSetting, writeSetting: registry.writeSetting },
    voice: {
      runVoiceTurn: async (o) => { turnCalls.push(o); return { route: "fast", timings: {} }; },
      speakText: async () => true,
    },
    sttWarmup: async () => {},
    resolveDisplayBird: async () => ({ species: "crow", seed: 0, mood: "happy", outfit: null, source: "default" }),
    themeCss: () => ":root{--k-sky:#eef1f3}",
    files: { publicDir: join(REPO, "bundles", "kiosk", "public"), birdSvgPath: join(REPO, "bundles", "ramble", "server", "bird-svg.cjs") },
    announceToken: { validate: async () => false },
    helloTimeoutMs: 300,
    wrapPcmAsWav,
    log: (m) => logs.push(m),
  });
  const app = express();
  app.use(rt.router(auth.dashboardAuth));
  srv = http.createServer(app);
  rt.attachUpgrade(srv);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${srv.address().port}`;
});

after(() => {
  rt?.stop();
  srv?.close();
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

/** Upgrade attempt → the HTTP status it was refused with, or "open". */
function upgrade(headers, path = WS_PATH) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl(path), { headers });
    ws.on("unexpected-response", (req, res) => { resolve(res.statusCode); ws.terminate(); });
    ws.on("open", () => { resolve("open"); ws.close(); });
    ws.on("error", () => {});
  });
}

/** A logged-in dashboard tab opening the overlay's WebSocket. */
async function connect({ hello = { type: "hello", mode: "session", csrf: CSRF, caps: {} }, tok = sessionToken, c = CSRF } = {}) {
  const ws = new WebSocket(wsUrl(), { headers: { ...SERVE, Cookie: cookie(tok, c), Origin: base } });
  const msgs = [];
  let closed = null;
  ws.on("message", (d, bin) => { if (!bin) msgs.push(JSON.parse(d.toString())); });
  ws.on("close", (code, reason) => { closed = { code, reason: reason.toString() }; });
  ws.on("error", () => {});
  await new Promise((r, j) => { ws.on("open", r); ws.on("unexpected-response", (q, res) => j(new Error("refused " + res.statusCode))); });
  if (hello) ws.send(JSON.stringify(hello));
  const until = async (fn, ms = 1500) => { for (let i = 0; i < ms / 10 && !fn(); i++) await new Promise((r) => setTimeout(r, 10)); return fn(); };
  await until(() => msgs.some((m) => m.type === "ready") || closed);
  return { ws, msgs, until, get closed() { return closed; } };
}

async function runTurn(c) {
  const n = turnCalls.length;
  c.ws.send(JSON.stringify({ type: "turn_start", turn_id: "t1" }));
  c.ws.send(Buffer.alloc(8000));
  c.ws.send(JSON.stringify({ type: "turn_end", vad_reason: "manual" }));
  await c.until(() => turnCalls.length > n || c.closed);
  return turnCalls.length > n ? turnCalls[turnCalls.length - 1] : null;
}

// ─── the page ───────────────────────────────────────────────────────────────

test("page: no dashboard session → refused, and the kiosk page is not served", async () => {
  for (const headers of [SERVE, { ...SERVE, Cookie: "crow_session=not-a-session; crow_csrf=x" }]) {
    const r = await fetch(base + PAGE, { headers, redirect: "manual" });
    assert.equal(r.status, 401);
    const body = await r.text();
    assert.ok(!body.includes("kiosk.js"), "no page code for an unauthenticated caller");
    assert.equal(r.headers.get("cache-control"), "no-store");
  }
});

test("page: a Funnel request is refused even with a valid session", async () => {
  const r = await fetch(base + PAGE, { headers: { ...SERVE, Cookie: cookie(), "Tailscale-Funnel-Request": "?1" }, redirect: "manual" });
  assert.equal(r.status, 403);
});

test("page: off the allowed network is refused even with a valid session (bare loopback, no Serve identity)", async () => {
  const r = await fetch(base + PAGE, { headers: { Cookie: cookie() }, redirect: "manual" });
  assert.equal(r.status, 403);
});

test("page: a valid session gets the kiosk page in session mode, frameable by the dashboard only", async () => {
  const r = await fetch(base + PAGE, { headers: { ...SERVE, Cookie: cookie() } });
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /<html[^>]*\sdata-mode="session"/);
  assert.match(html, /\/display\/assets\/kiosk\.js/);
  const csp = r.headers.get("content-security-policy");
  assert.ok(csp.includes("frame-ancestors 'self'"), csp);
  assert.ok(!csp.includes("frame-ancestors 'none'"));
  for (const d of ["default-src 'self'", "script-src 'self'", "base-uri 'none'", "form-action 'none'"]) assert.ok(csp.includes(d), d);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.match(r.headers.get("permissions-policy"), /microphone=\(self\)/);
});

test("the paired page is unchanged: /display needs no session, is not in session mode and can never be framed", async () => {
  const r = await fetch(base + "/display", { headers: SERVE });
  assert.equal(r.status, 200);
  assert.ok(r.headers.get("content-security-policy").includes("frame-ancestors 'none'"));
  assert.doesNotMatch(await r.text(), /data-mode=/);
});

// ─── the WebSocket ──────────────────────────────────────────────────────────

test("ws: no session, a bogus session, or a paired-device token instead of a session → 401 before the upgrade", async () => {
  assert.equal(await upgrade({ ...SERVE, Origin: base }), 401);
  assert.equal(await upgrade({ ...SERVE, Origin: base, Cookie: "crow_session=not-a-session; crow_csrf=x" }), 401);
  const { token } = await withDb((db) => store.pairDevice(db, { id: "kiosk-paired", name: "Kitchen", device_kind: "kiosk" }));
  assert.equal(await upgrade({ ...SERVE, Origin: base, Cookie: `crow_session=${token}; crow_csrf=x` }), 401, "a kiosk token is not a dashboard session");
  assert.equal(await upgrade({ ...SERVE, Origin: base, Authorization: `Bearer ${token}` }), 401);
});

test("ws: Funnel and off-network upgrades are refused even with a valid session", async () => {
  assert.equal(await upgrade({ ...SERVE, Origin: base, Cookie: cookie(), "Tailscale-Funnel-Request": "?1" }), 403);
  assert.equal(await upgrade({ Origin: base, Cookie: cookie() }), 403, "bare loopback without a Serve identity");
});

test("ws: a cross-origin page cannot open the session socket, even if the browser sent the cookie", async () => {
  assert.equal(await upgrade({ ...SERVE, Cookie: cookie(), Origin: "https://evil.example" }), 403);
  assert.equal(await upgrade({ ...SERVE, Cookie: cookie(), Origin: "null" }), 403);
  assert.equal(await upgrade({ ...SERVE, Cookie: cookie(), Origin: base, "Sec-Fetch-Site": "cross-site" }), 403);
  // Behind a proxy that forwards the public name in X-Forwarded-Host, that name is the origin.
  assert.equal(await upgrade({ ...SERVE, Cookie: cookie(), Origin: "https://crow.example.ts.net:8444", "X-Forwarded-Host": "crow.example.ts.net:8444" }), "open");
});

test("ws: hello must echo the CSRF cookie (double-submit, same as dashboard POSTs)", async () => {
  for (const hello of [
    { type: "hello", mode: "session", caps: {} },
    { type: "hello", mode: "session", csrf: "wrong", caps: {} },
    { type: "hello", mode: "session", csrf: 12345, caps: {} },
  ]) {
    const c = await connect({ hello });
    await c.until(() => c.closed);
    assert.deepEqual(c.closed, { code: 4401, reason: "unauthorized" }, JSON.stringify(hello));
    assert.ok(!c.msgs.some((m) => m.type === "ready"));
  }
  // A cookie-less CSRF value never passes, whatever the frame says.
  const ws = new WebSocket(wsUrl(), { headers: { ...SERVE, Cookie: `crow_session=${sessionToken}`, Origin: base } });
  const closed = await new Promise((r) => { ws.on("open", () => ws.send(JSON.stringify({ type: "hello", mode: "session", csrf: "", caps: {} }))); ws.on("close", (code, reason) => r({ code, reason: reason.toString() })); });
  assert.deepEqual(closed, { code: 4401, reason: "unauthorized" });
});

test("ws: no hello → 4401 hello_timeout (the session cookie alone starts nothing)", async () => {
  const c = await connect({ hello: null });
  await c.until(() => c.closed);
  assert.deepEqual(c.closed, { code: 4401, reason: "hello_timeout" });
});

test("valid session: ready without pairing, the turn runs on the first enabled assistant with the kiosk tool limits, and NO device is stored", async () => {
  const before = await withDb((db) => store.listDevices(db));
  const c = await connect();
  const ready = c.msgs.find((m) => m.type === "ready");
  assert.ok(ready, "ready");
  assert.equal(ready.display_config.name, "Dashboard");
  assert.equal(ready.display_config.follow_up, false);
  const call = await runTurn(c);
  assert.ok(call, "the turn ran");
  assert.equal(call.device.bound_bot_id, "a-first", "first enabled assistant by id (the bot board's default)");
  assert.equal(call.device.device_kind, "kiosk");
  assert.match(call.device.id, /^dash-[0-9a-f]{16}$/);
  assert.ok(!call.device.id.includes(sessionToken.slice(0, 8)), "the id is a hash, never the session token");
  assert.equal(call.device.stt_profile_id, "kiosk-stt-distil-small-en");
  assert.equal(call.device.tts_profile_id, "kk");
  assert.equal(call.device.kiosk_settings.memory_integration, false);
  assert.deepEqual(call.denyTools, kiosk.KIOSK_DENY_TOOLS);
  assert.equal(call.maxToolRounds, kiosk.KIOSK_MAX_TOOL_ROUNDS);
  const after = await withDb((db) => store.listDevices(db));
  assert.deepEqual(after.map((d) => d.id).sort(), before.map((d) => d.id).sort(), "no paired-device record was created");
  assert.ok(!after.some((d) => d.id.startsWith("dash-")));
  // Nor does the admin listing, the announce targets or a device-id claim see or reach it.
  const admin = await (await fetch(base + "/api/kiosk/admin/displays", { headers: { ...SERVE, Cookie: cookie() } })).json();
  assert.ok(!admin.devices.some((d) => d.id.startsWith("dash-")));
  assert.deepEqual((await rt.announce(undefined, { text: "hi" })).delivered, []);
  c.ws.close();
});

test("a session hello cannot claim a paired display: device_id/token in the frame are ignored", async () => {
  const c = await connect({ hello: { type: "hello", mode: "session", csrf: CSRF, device_id: "kiosk-paired", token: "x", caps: {} } });
  const call = await runTurn(c);
  assert.match(call.device.id, /^dash-/);
  assert.equal(rt.hub.isConnected("kiosk-paired"), false);
  c.ws.close();
});

test("the assistant: the one chosen in the Kiosk panel wins; a disabled or deleted choice falls back to the first enabled one", async () => {
  const post = (body) => fetch(base + "/api/kiosk/admin/dashboard-voice", { method: "POST", headers: { ...SERVE, Cookie: cookie(), "Content-Type": "application/json", "X-Crow-Csrf": CSRF }, body: JSON.stringify(body) });
  assert.equal((await post({ bot_id: "z-off" })).status, 400, "a disabled assistant cannot be chosen");
  assert.equal((await post({ bot_id: "b-house" })).status, 200);
  {
    const c = await connect();
    assert.equal((await runTurn(c)).device.bound_bot_id, "b-house");
    c.ws.close();
  }
  const admin = await (await fetch(base + "/api/kiosk/admin/displays", { headers: { ...SERVE, Cookie: cookie() } })).json();
  assert.equal(admin.dashboard_voice.bot_id, "b-house");
  await withDb((db) => db.execute({ sql: "UPDATE pi_bot_defs SET enabled = 0 WHERE bot_id = 'b-house'", args: [] }));
  try {
    const c = await connect();
    assert.equal((await runTurn(c)).device.bound_bot_id, "a-first");
    c.ws.close();
  } finally {
    await withDb((db) => db.execute({ sql: "UPDATE pi_bot_defs SET enabled = 1 WHERE bot_id = 'b-house'", args: [] }));
  }
  assert.equal((await post({ bot_id: "" })).status, 200, "empty = automatic");
  assert.equal((await (await fetch(base + "/api/kiosk/admin/displays", { headers: { ...SERVE, Cookie: cookie() } })).json()).dashboard_voice.bot_id, null);
});

test("the Kiosk panel setting is a dashboard POST: session + CSRF required", async () => {
  const url = base + "/api/kiosk/admin/dashboard-voice";
  const body = JSON.stringify({ bot_id: "b-house" });
  assert.equal((await fetch(url, { method: "POST", headers: { ...SERVE, Cookie: cookie(), "Content-Type": "application/json" }, body })).status, 403, "no CSRF header");
  const noSession = await fetch(url, { method: "POST", headers: { ...SERVE, "Content-Type": "application/json", "X-Crow-Csrf": CSRF }, body, redirect: "manual" });
  assert.ok([302, 303, 401].includes(noSession.status), String(noSession.status));
  assert.equal(await withDb((db) => registry.readSetting(db, "kiosk_dashboard_bot_id")), "", "neither refused request changed the setting");
});

test("no enabled assistant → 4403 no_bot (the page links to the Kiosk panel); nothing is stored", async () => {
  await withDb((db) => db.execute({ sql: "UPDATE pi_bot_defs SET enabled = 0", args: [] }));
  try {
    const c = await connect();
    await c.until(() => c.closed);
    assert.deepEqual(c.closed, { code: 4403, reason: "no_bot" });
    assert.ok(!c.msgs.some((m) => m.type === "ready"));
  } finally {
    await withDb((db) => db.execute({ sql: "UPDATE pi_bot_defs SET enabled = 1 WHERE bot_id IN ('a-first','b-house')", args: [] }));
  }
});

test("logging out ends the display: the next question is refused and the socket closes 4401", async () => {
  const { token } = await auth.mintSsoSession("test");
  const c = await connect({ tok: token });
  assert.ok(c.msgs.some((m) => m.type === "ready"));
  assert.ok(await runTurn(c), "works while logged in");
  await auth.destroySession(token);
  const n = turnCalls.length;
  assert.equal(await runTurn(c), null, "no turn after logout");
  assert.equal(turnCalls.length, n);
  assert.deepEqual(c.closed, { code: 4401, reason: "unauthorized" });
  assert.equal(await upgrade({ ...SERVE, Origin: base, Cookie: cookie(token) }), 401, "and it cannot reconnect");
});

test("an idle display is closed within a sweep of logout (no turn needed)", async () => {
  const { token } = await auth.mintSsoSession("test");
  const c = await connect({ tok: token });
  assert.ok(c.msgs.some((m) => m.type === "ready"));
  await auth.destroySession(token);
  await rt.hub.revalidateSessions();
  await c.until(() => c.closed);
  assert.deepEqual(c.closed, { code: 4401, reason: "unauthorized" });
});

test("the same login opening the overlay twice supersedes the first; two logins do not disturb each other", async () => {
  const a = await connect();
  const b = await connect();
  await a.until(() => a.closed);
  assert.deepEqual(a.closed, { code: 4000, reason: "superseded" });
  const { token } = await auth.mintSsoSession("test");
  const other = await connect({ tok: token });
  assert.ok(other.msgs.some((m) => m.type === "ready"));
  assert.equal(b.closed, null);
  b.ws.close(); other.ws.close();
  await auth.destroySession(token);
});

test("closing the overlay drops the display's windows and timers after the grace period (nothing outlives the session)", async () => {
  const c = await connect();
  const id = (await runTurn(c)).device.id;
  rt.wm.open(id, { kind: "content", title: "Note", blocks: [] });
  assert.equal(rt.wm.list(id).length, 1);
  c.ws.close();
  await c.until(() => !rt.hub.isConnected(id));
  rt.expireSessionDisplays(Date.now() + 10 * 60 * 1000);
  assert.equal(rt.wm.list(id).length, 0);
});

// ─── the paired-device flow is untouched ────────────────────────────────────

test("paired flow unchanged: code → approve → token → hello on /api/kiosk/session, with no dashboard session on the display", async () => {
  const j = (path, opt = {}) => fetch(base + path, { ...opt, headers: { ...SERVE, "Content-Type": "application/json", ...(opt.headers || {}) } });
  const s = await (await j("/api/kiosk/pair/start", { method: "POST", body: JSON.stringify({ name_hint: "Display" }) })).json();
  assert.match(s.code, /^\d{6}$/);
  const ok = await (await j("/api/kiosk/admin/approve", { method: "POST", headers: { Cookie: cookie(), "X-Crow-Csrf": CSRF }, body: JSON.stringify({ code: s.code, name: "Hall", bot_id: "b-house" }) })).json();
  assert.equal(ok.ok, true);
  const p = await (await fetch(base + `/api/kiosk/pair/status?pair_id=${s.pair_id}`, { headers: { ...SERVE, "X-Kiosk-Poll": s.poll_secret } })).json();
  assert.equal(p.state, "approved");

  const ws = new WebSocket(wsUrl("/api/kiosk/session"), { headers: SERVE });
  const msgs = [];
  ws.on("message", (d, bin) => { if (!bin) msgs.push(JSON.parse(d.toString())); });
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ type: "hello", device_id: p.device_id, token: p.token, caps: {} }));
  for (let i = 0; i < 100 && !msgs.some((m) => m.type === "ready"); i++) await new Promise((r) => setTimeout(r, 10));
  const ready = msgs.find((m) => m.type === "ready");
  assert.ok(ready);
  assert.equal(ready.display_config.name, "Hall");
  ws.close();
});

test("paired path stays token-only: a dashboard session + session hello on /api/kiosk/session is refused", async () => {
  const ws = new WebSocket(wsUrl("/api/kiosk/session"), { headers: { ...SERVE, Cookie: cookie(), Origin: base } });
  const closed = await new Promise((r) => { ws.on("open", () => ws.send(JSON.stringify({ type: "hello", mode: "session", csrf: CSRF, caps: {} }))); ws.on("close", (code, reason) => r({ code, reason: reason.toString() })); });
  assert.deepEqual(closed, { code: 4401, reason: "unauthorized" });
});

test("a paired display's token is refused on the session path's hello too (it is never read there)", async () => {
  const { token } = await withDb((db) => store.pairDevice(db, { id: "kiosk-paired-2", name: "Den", device_kind: "kiosk" }));
  const c = await connect({ hello: { type: "hello", device_id: "kiosk-paired-2", token, caps: {} } });
  await c.until(() => c.closed);
  assert.deepEqual(c.closed, { code: 4401, reason: "unauthorized" }, "no CSRF token → refused, whatever device token it carries");
});

// ─── core helpers the session path relies on ────────────────────────────────

test("core sessionFromRequest: network rule first, then a live dashboard session; returns the token or null", async () => {
  const req = (headers, ip = "100.64.0.5") => ({ headers, ip, connection: { remoteAddress: ip } });
  assert.equal(await auth.sessionFromRequest(req({ cookie: cookie() })), sessionToken);
  assert.equal(await auth.sessionFromRequest(req({})), null);
  assert.equal(await auth.sessionFromRequest(req({ cookie: "crow_session=nope" })), null);
  assert.equal(await auth.sessionFromRequest(req({ cookie: cookie(), "tailscale-funnel-request": "?1" })), null);
  assert.equal(await auth.sessionFromRequest(req({ cookie: cookie() }, "8.8.8.8")), null);
  assert.equal(await auth.sessionFromRequest(req({ cookie: cookie() }, "127.0.0.1")), null);
});

test("core csrfTokenAccepted: constant-time double-submit against the request's own cookie; honours the strict kill-switch", () => {
  const req = (c) => ({ headers: { cookie: c } });
  assert.equal(csrf.csrfTokenAccepted(req("crow_session=s; crow_csrf=abc"), "abc"), true);
  assert.equal(csrf.csrfTokenAccepted(req("crow_session=s; crow_csrf=abc"), "abd"), false);
  assert.equal(csrf.csrfTokenAccepted(req("crow_session=s; crow_csrf=abc"), ""), false);
  assert.equal(csrf.csrfTokenAccepted(req("crow_session=s; crow_csrf=abc"), undefined), false);
  assert.equal(csrf.csrfTokenAccepted(req("crow_session=s; crow_csrf=abc"), ["abc"]), false);
  assert.equal(csrf.csrfTokenAccepted(req("crow_session=s"), ""), false, "no cookie never matches an empty token");
  process.env.CROW_CSRF_STRICT = "0";
  try { assert.equal(csrf.csrfTokenAccepted(req("crow_session=s"), undefined), true); } finally { delete process.env.CROW_CSRF_STRICT; }
});

test("without the core session helpers (an older gateway) the bundle offers no session mode at all", async () => {
  const k = kiosk.createKioskRuntime({
    Router: express.Router, json: express.json, WebSocketServer,
    isAllowedNetwork: () => true, csrfMiddleware: (req, res, next) => next(),
    openDb: open, deviceStore: store,
    settings: { readSetting: registry.readSetting, writeSetting: registry.writeSetting },
    voice: { runVoiceTurn: async () => ({}), speakText: async () => true },
    sttWarmup: async () => {}, resolveDisplayBird: async () => ({}), themeCss: () => "",
    files: { publicDir: join(REPO, "bundles", "kiosk", "public"), birdSvgPath: join(REPO, "bundles", "ramble", "server", "bird-svg.cjs") },
    announceToken: { validate: async () => false }, wrapPcmAsWav, log: () => {},
  });
  const app = express();
  app.use(k.router((req, res, next) => next()));
  const s = http.createServer(app);
  k.attachUpgrade(s);
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const b = `http://127.0.0.1:${s.address().port}`;
  try {
    assert.equal((await fetch(b + PAGE, { headers: { Cookie: cookie() } })).status, 404);
    const code = await new Promise((resolve) => {
      const ws = new WebSocket(b.replace("http", "ws") + WS_PATH, { headers: { Cookie: cookie(), Origin: b } });
      ws.on("unexpected-response", (q, res) => { resolve(res.statusCode); ws.terminate(); });
      ws.on("open", () => { resolve("open"); ws.close(); });
      ws.on("error", () => {});
    });
    assert.equal(code, 404);
  } finally { k.stop(); s.close(); }
});
