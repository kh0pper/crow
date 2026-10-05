/**
 * The meta-glasses routes as the gateway mounts them: the REAL router and the REAL WebSocket
 * upgrade handler from bundles/meta-glasses/panel/routes.js, a real database built by
 * scripts/init-db.js in the suite's scratch home, real HTTP servers playing the music server,
 * its storage and an attacker. Nothing under test is replaced by a fake.
 *
 * Requests come from loopback, as they do behind Tailscale Serve, so they carry the identity
 * header Serve adds; a test that leaves it out is testing the network rule.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocket } from "ws";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Its own home and database inside the suite's scratch home: another glasses test file pairs
// the same device ids at the same time. (Unset = not run through npm test: refuse.)
if (!process.env.CROW_HOME) throw new Error("run through npm test (scripts/run-suite.mjs), never raw node --test");
const HOME = join(process.env.CROW_HOME, "glasses-routes-security");
mkdirSync(join(HOME, "data"), { recursive: true });
process.env.CROW_HOME = HOME;
process.env.CROW_DATA_DIR = join(HOME, "data");
delete process.env.CROW_DB_PATH;
const PHOTO_DIR = join(HOME, "data", "glasses-photos");
const TAILNET = { "tailscale-user-login": "tester@example.invalid" };
const SESSION = { cookie: "crow_session=test-session; crow_csrf=csrf-abc" };
const ID = "11111111-2222-3333-4444-555555555555";

let srv, base, store, db, routes;
let music, storage, evil, musicMode = "storage";
const seen = { music: [], storage: [], evil: [] };
const tokens = {};

const listen = (handler) => new Promise((res) => { const s = http.createServer(handler); s.listen(0, "127.0.0.1", () => res(s)); });
const urlOf = (s, path = "") => `http://127.0.0.1:${s.address().port}${path}`;
const call = (path, { method = "GET", headers = {}, body, tailnet = true } = {}) =>
  fetch(base + path, { method, headers: { ...(tailnet ? TAILNET : {}), ...headers }, body, redirect: "manual" });

/** Open the session socket. → { ws, messages, binary } once open, or { status } when the upgrade is refused. */
function openSession(deviceId, { headers = {}, query = "", tailnet = true } = {}) {
  return new Promise((res) => {
    const ws = new WebSocket(`${base.replace("http", "ws")}/api/meta-glasses/session?device_id=${deviceId}${query}`, { headers: { ...(tailnet ? TAILNET : {}), ...headers } });
    const messages = [], binary = [];
    ws.on("message", (raw, isBinary) => { if (isBinary) binary.push(raw); else messages.push(JSON.parse(raw.toString("utf8"))); });
    ws.on("open", () => res({ ws, messages, binary }));
    ws.on("unexpected-response", (rq, rs) => { rs.resume(); res({ status: rs.statusCode }); });
    ws.on("error", () => {});
  });
}
const until = async (fn, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); } return fn(); };

before(async () => {
  execFileSync(process.execPath, [join(ROOT, "scripts", "init-db.js")], { env: process.env, stdio: "ignore", timeout: 60_000 });
  mkdirSync(join(HOME, "panels"), { recursive: true });   // where a traversal would land

  storage = await listen((req, res) => { seen.storage.push({ url: req.url, auth: req.headers.authorization || null }); res.writeHead(200, { "content-type": "audio/mpeg" }); res.end("MP3BYTES"); });
  evil = await listen((req, res) => { seen.evil.push({ url: req.url, auth: req.headers.authorization || null }); res.writeHead(200, { "content-type": "audio/mpeg" }); res.end("EVIL"); });
  music = await listen((req, res) => {
    seen.music.push({ url: req.url, auth: req.headers.authorization || null });
    res.writeHead(302, { location: musicMode === "evil" ? urlOf(evil, "/steal") : urlOf(storage, "/obj?sig=abc") }); res.end();
  });
  writeFileSync(join(HOME, "mcp-addons.json"), JSON.stringify({ funkwhale: { env: { FUNKWHALE_URL: urlOf(music), FUNKWHALE_ACCESS_TOKEN: "music-secret", FUNKWHALE_STORAGE_ORIGIN: urlOf(storage) } } }));

  store = await import("../servers/shared/device-store.js");
  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient();
  for (const [key, opts] of Object.entries({
    a: { id: "glasses-a", name: "Test glasses" }, b: { id: "glasses-b", name: "Uploads" }, c: { id: "glasses-c", name: "Brute" },
    kiosk: { id: "kiosk-1", name: "Hall display", device_kind: "kiosk" },
  })) tokens[key] = (await store.pairDevice(db, opts)).token;

  routes = await import("../bundles/meta-glasses/panel/routes.js");
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  // The dashboard session check, reduced to its two rules: the network rule, then a session cookie.
  const { isAllowedNetwork, parseCookies } = await import("../servers/gateway/dashboard/auth.js");
  const dashboardAuth = (req, res, next) => {
    if (!isAllowedNetwork(req)) return res.status(403).send("network");
    return parseCookies(req).crow_session === "test-session" ? next() : res.status(302).set("location", "/dashboard/login").end();
  };
  app.use(routes.default(dashboardAuth));
  srv = http.createServer(app);
  routes.setupWebSocket(srv);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => { for (const s of [srv, music, storage, evil]) { s?.closeAllConnections?.(); s?.close(); } try { db?.close(); } catch {} });

const upload = (key, id, query, body = Buffer.from("JPEGDATA"), headers = {}) =>
  call(`/api/meta-glasses/photo?device_id=${id}${query}`, { method: "POST", headers: { authorization: `Bearer ${tokens[key]}`, "content-type": "image/jpeg", ...headers }, body });

test("photo upload: the file name is made by the server; a request_id or ext that names a path lands nowhere else", async () => {
  const attacks = [
    "&request_id=" + encodeURIComponent("a/../../../panels/evil") + "&ext=js",
    "&request_id=" + encodeURIComponent("../../../../panels/evil2") + "&ext=js",
    "&request_id=" + encodeURIComponent("x/../../../mcp-addons") + "&ext=json",
    "&request_id=" + encodeURIComponent("..%2F..%2Fpanels%2Fevil3") + "&ext=" + encodeURIComponent("../js"),
  ];
  for (const q of attacks) {
    const r = await upload("a", "glasses-a", q);
    assert.equal(r.status, 200, q);
    const j = await r.json();
    assert.match(j.url, /^\/api\/meta-glasses\/photo\/\d+_[0-9a-f-]{36}\.jpg$/, "an unknown extension becomes jpg");
  }
  assert.deepEqual(readdirSync(join(HOME, "panels")), [], "nothing was written beside the photo directory");
  assert.equal(JSON.parse(execFileSync("cat", [join(HOME, "mcp-addons.json")], { encoding: "utf8" })).funkwhale.env.FUNKWHALE_ACCESS_TOKEN, "music-secret", "the add-on file was not overwritten");
  for (const f of readdirSync(PHOTO_DIR)) assert.match(f, /^\d+_[0-9a-f-]{36}\.(jpg|jpeg|png|heic)$/);
  assert.equal(readdirSync(PHOTO_DIR).length, attacks.length);
});

test("photo upload: the token is checked before the body is read; a body is required; heic keeps its type", async () => {
  // 26 MB is over the 25 MB body limit. A server that read the body first answers 413; one that checks the token first answers 401.
  const big = Buffer.alloc(26 * 1024 * 1024, 1);
  const bad = await call("/api/meta-glasses/photo?device_id=glasses-a", { method: "POST", headers: { authorization: "Bearer wrong", "content-type": "image/jpeg" }, body: big }).catch((e) => ({ status: 401, reset: String(e) }));
  assert.equal(bad.status, 401);
  assert.equal((await upload("a", "glasses-a", "", Buffer.alloc(0))).status, 400);
  const heic = await upload("a", "glasses-a", "&ext=heic");
  assert.match((await heic.json()).url, /\.heic$/);
  const row = (await db.execute({ sql: "SELECT mime FROM glasses_photos WHERE disk_path LIKE '%.heic' ORDER BY id DESC LIMIT 1", args: [] })).rows[0];
  assert.equal(row?.mime, "image/heic");
  assert.equal((await upload("kiosk", "kiosk-1", "")).status, 401, "a display's token is not a glasses token");
  assert.equal((await call("/api/meta-glasses/photo?device_id=glasses-a", { method: "POST", tailnet: false, headers: { authorization: `Bearer ${tokens.a}` }, body: Buffer.from("x") })).status, 403, "bare loopback (no tailnet identity) is refused before the token is looked at");
  assert.equal((await call("/api/meta-glasses/photo?device_id=glasses-a", { method: "POST", headers: { authorization: `Bearer ${tokens.a}`, "tailscale-funnel-request": "?1" }, body: Buffer.from("x") })).status, 403, "Funnel is refused");
});

test("photo upload: thirty a minute per device, then 429", async () => {
  let ok = 0, limited = 0;
  for (let i = 0; i < 33; i += 1) { const r = await upload("b", "glasses-b", ""); if (r.status === 200) ok += 1; else if (r.status === 429) limited += 1; await r.arrayBuffer(); }
  assert.deepEqual({ ok, limited }, { ok: 30, limited: 3 });
  assert.equal((await upload("a", "glasses-a", "")).status, 200, "another device is not affected");
});

test("session upgrade: Funnel and non-tailnet callers are refused; the token is read from the header only; a display token is not accepted", async () => {
  const hdr = { authorization: `Bearer ${tokens.a}` };
  assert.equal((await openSession("glasses-a", { headers: { ...hdr, "tailscale-funnel-request": "?1" } })).status, 403);
  assert.equal((await openSession("glasses-a", { headers: hdr, tailnet: false })).status, 403);
  assert.equal((await openSession("glasses-a", { query: `&token=${tokens.a}` })).status, 400, "a token in the query string is not a token");
  assert.equal((await openSession("kiosk-1", { headers: { authorization: `Bearer ${tokens.kiosk}` } })).status, 401);
  const ok = await openSession("glasses-a", { headers: hdr });
  assert.ok(ok.ws, "the header form connects");
  assert.equal((await until(() => ok.messages[0]))?.type, "ready");
  ok.ws.close();
});

test("session-cookie routes: a state-changing call needs the CSRF token; pairing needs a JSON body; the body-less capture trigger is gone", async () => {
  const json = { ...SESSION, "content-type": "application/json" };
  const say = (headers) => call("/api/meta-glasses/say", { method: "POST", headers, body: JSON.stringify({ text: "hello" }) });
  assert.equal((await say(json)).status, 403, "session cookie alone is refused");
  assert.equal((await say({ ...json, "x-crow-csrf": "wrong" })).status, 403);
  const ok = await say({ ...json, "x-crow-csrf": "csrf-abc" });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).delivered, 0);
  assert.equal((await call("/api/meta-glasses/turn", { method: "POST", headers: json, body: JSON.stringify({ action: "begin" }) })).status, 403);
  assert.equal((await call("/api/meta-glasses/media/control", { method: "POST", headers: json, body: JSON.stringify({ device_id: "glasses-a", action: "stop" }) })).status, 403);
  assert.equal((await call("/api/meta-glasses/devices/glasses-a", { method: "DELETE", headers: SESSION })).status, 403);
  assert.equal((await call("/api/meta-glasses/capture", { method: "POST", headers: { ...SESSION, "x-crow-csrf": "csrf-abc" } })).status, 404);
  assert.equal((await call("/api/meta-glasses/devices", { headers: {} })).status, 302, "no session: the login redirect, as before");
  // Pairing: the phone app sends the cookie and JSON, no CSRF header.
  const pair = await call("/api/meta-glasses/pair", { method: "POST", headers: json, body: JSON.stringify({ id: "glasses-new", name: "New", generation: "gen2" }) });
  assert.equal(pair.status, 200);
  assert.equal(typeof (await pair.json()).token, "string");
  assert.equal((await call("/api/meta-glasses/pair", { method: "POST", headers: { ...SESSION, "content-type": "text/plain" }, body: JSON.stringify({ id: "glasses-x" }) })).status, 415, "a form or plain-text post (what another origin can send) is refused");
  // Even with credentialed CORS configured for another origin, a browser marks the request: without the CSRF token it is refused.
  const cross = (h) => call("/api/meta-glasses/pair", { method: "POST", headers: { ...json, ...h }, body: JSON.stringify({ id: "glasses-y", name: "Y" }) });
  assert.equal((await cross({ "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await cross({ "sec-fetch-site": "same-site" })).status, 403);
  assert.equal((await cross({ origin: "https://evil.example.invalid" })).status, 403);
  assert.equal((await cross({ origin: "https://evil.example.invalid", "x-crow-csrf": "csrf-abc" })).status, 200, "with the CSRF token it is an ordinary dashboard call");
  assert.equal((await cross({ "sec-fetch-site": "same-origin", origin: base })).status, 200, "the dashboard page itself");
});

test("the device list and every device route see glasses only; a display's record cannot be re-paired, changed or removed here", async () => {
  const csrf = { ...SESSION, "content-type": "application/json", "x-crow-csrf": "csrf-abc" };
  const list = await (await call("/api/meta-glasses/devices", { headers: SESSION })).json();
  assert.ok(list.devices.some((d) => d.id === "glasses-a"));
  assert.ok(!list.devices.some((d) => d.id === "kiosk-1"), "the display is not listed as glasses");
  const before = await store.findDevice(db, "kiosk-1");
  assert.equal((await call("/api/meta-glasses/pair", { method: "POST", headers: csrf, body: JSON.stringify({ id: "kiosk-1", name: "Mine now" }) })).status, 409);
  assert.equal((await call("/api/meta-glasses/devices/kiosk-1", { method: "POST", headers: csrf, body: JSON.stringify({ name: "Renamed" }) })).status, 404);
  assert.equal((await call("/api/meta-glasses/devices/kiosk-1", { method: "DELETE", headers: csrf })).status, 404);
  assert.deepEqual(await store.findDevice(db, "kiosk-1"), before, "the display's record is byte-for-byte what it was");
  const upd = await call("/api/meta-glasses/devices/glasses-a", { method: "POST", headers: csrf, body: JSON.stringify({ name: "Renamed", device_kind: "companion" }) });
  assert.equal(upd.status, 200);
  assert.equal((await store.findDevice(db, "glasses-a")).device_kind, "glasses", "the kind cannot be changed from this route");
});

test("the audio relay requests only the music server's listen path, sends its credential nowhere else, and never follows a redirect off the storage origin", async () => {
  const csrf = { ...SESSION, "content-type": "application/json", "x-crow-csrf": "csrf-abc" };
  const s = await openSession("glasses-a", { headers: { authorization: `Bearer ${tokens.a}` } });
  await until(() => s.messages[0]);
  const stream = async (body) => (await call("/api/meta-glasses/stream", { method: "POST", headers: csrf, body: JSON.stringify({ device_id: "glasses-a", codec: "mp3", ...body }) })).json();
  const reset = (mode) => { musicMode = mode; for (const k of Object.keys(seen)) seen[k].length = 0; s.messages.length = 0; s.binary.length = 0; };

  reset("storage");
  assert.equal((await stream({ url: urlOf(evil, `/api/v1/listen/${ID}/`), auth: "funkwhale" })).reason, "wrong_origin");
  assert.equal((await stream({ url: urlOf(music, "/api/v1/users/me/"), auth: "funkwhale" })).reason, "wrong_path");
  assert.equal((await stream({ url: urlOf(music, `/api/v1/listen/${ID}/?to=mp3&x=1`), auth: "funkwhale" })).reason, "wrong_query");
  assert.equal((await stream({ url: urlOf(evil, "/any.mp3") })).reason, "auth_required", "no credential rule named: the gateway does not fetch for a device");
  assert.equal((await stream({ url: urlOf(evil, "/any.mp3"), auth: "something-else" })).reason, "auth_required");
  assert.equal((await stream({ url: urlOf(evil, "/audio/stream?cap=funkwhale"), auth: "crow-peer:unknown-instance" })).reason, "peer_not_recognised");
  assert.deepEqual(seen, { music: [], storage: [], evil: [] }, "none of those was requested");

  reset("evil");
  assert.equal((await stream({ url: urlOf(music, `/api/v1/listen/${ID}/`), auth: "funkwhale" })).reason, "redirect_not_storage");
  assert.deepEqual(seen.music.map((x) => x.auth), ["Bearer music-secret"]);
  assert.deepEqual(seen.evil, [], "the redirect target never saw a request or a credential");

  reset("storage");
  const ok = await stream({ url: urlOf(music, `/api/v1/listen/${ID}/?to=mp3`), auth: "funkwhale" });
  assert.equal(ok.ok, true);
  assert.deepEqual(seen.storage, [{ url: "/obj?sig=abc", auth: null }], "the storage hop carries no credential");
  assert.equal((await until(() => s.messages.find((m) => m.type === "audio_stream_end")))?.ok, true);
  assert.equal(Buffer.concat(s.binary).toString(), "MP3BYTES");
  s.ws.close();
});

test("artwork: reachable with the device token it was written for; private addresses and redirects are refused", async () => {
  for (const k of Object.keys(seen)) seen[k].length = 0;
  musicMode = "evil";
  const art = (src, headers = { authorization: `Bearer ${tokens.a}` }) => call(`/api/meta-glasses/artwork?device_id=glasses-a&src=${encodeURIComponent(src)}`, { headers });
  assert.equal((await art(urlOf(music, "/media/cover.png"), {})).status, 401, "no token");
  assert.equal((await art(urlOf(music, "/media/cover.png"), SESSION)).status, 401, "a dashboard session is not what this route takes");
  assert.equal((await art("http://127.0.0.1:1/a.png")).status, 403, "a private address that is not the music server's origin is refused");
  assert.equal((await art("http://0.0.0.0:1/a.png")).status, 403, "the unspecified address reaches local services: refused");
  assert.equal((await art("http://[::1]:1/a.png")).status, 403, "IPv6 loopback: refused");
  assert.equal((await art("file:///etc/passwd")).status, 400);
  const r = await art(urlOf(music, "/media/cover.png"));
  assert.equal(r.status, 502, "the music server answered with a redirect: not followed");
  assert.deepEqual(seen.music.map((x) => x.auth), ["Bearer music-secret"]);
  assert.deepEqual(seen.evil, [], "the redirect target was never requested");
});

test("scheduler hooks: photo retention is claimed once a day in the 03:00 hour, whatever port the gateway listens on", async (t) => {
  const { runSchedulerHooks } = await import("../servers/gateway/scheduler-hooks.js");
  assert.notEqual(process.env.CROW_GATEWAY_PORT, "3002");
  const lines = [];
  const orig = console.log;
  console.log = (m) => { lines.push(String(m)); };
  t.after(() => { console.log = orig; });
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 9, 6, 14, 0, 0) });
  await runSchedulerHooks("tick", db);
  assert.equal(lines.filter((l) => l.includes("[meta-glasses] retention")).length, 0, "not in the afternoon");
  t.mock.timers.setTime(new Date(2026, 9, 6, 3, 10, 0).getTime());
  await runSchedulerHooks("tick", db);
  await runSchedulerHooks("tick", db);
  assert.equal(lines.filter((l) => l.includes("[meta-glasses] retention")).length, 1, "claimed once");
  const claimed = (await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = 'meta_glasses_last_retention_run'", args: [] })).rows[0]?.value;
  assert.match(String(claimed), /^\d{4}-\d{2}-\d{2}$/);
});

test("retention: photos past the device's rule are pruned whether or not object storage holds them; 'never' and newer photos stay; new pairings default to 30 days", async () => {
  await store.updateDeviceProfiles(db, "glasses-b", { photo_retention: "30d" });
  await store.updateDeviceProfiles(db, "glasses-a", { photo_retention: "never" });
  const put = async (deviceId, name, age) => {
    const p = join(PHOTO_DIR, name);
    writeFileSync(p, "JPEG");
    await db.execute({ sql: `INSERT INTO glasses_photos (device_id, disk_path, minio_key, mime, size_bytes, captured_at) VALUES (?, ?, NULL, 'image/jpeg', 4, datetime('now', ?))`, args: [deviceId, p, age] });
    return p;
  };
  const oldB = await put("glasses-b", "1_old-b.jpg", "-40 days");
  const newB = await put("glasses-b", "2_new-b.jpg", "-2 days");
  const oldA = await put("glasses-a", "3_old-a.jpg", "-400 days");
  // A row from before server-made names, pointing outside the photo folder: its row may go, the file must not.
  const outside = join(HOME, "outside-keep.txt");
  writeFileSync(outside, "precious");
  await db.execute({ sql: `INSERT INTO glasses_photos (device_id, disk_path, minio_key, mime, size_bytes, captured_at) VALUES ('glasses-b', ?, NULL, 'image/jpeg', 4, datetime('now', '-90 days'))`, args: [join(PHOTO_DIR, "..", "..", "outside-keep.txt")] });
  const summary = await routes.runPhotoRetention(db, { budgetMs: 5_000 });
  assert.ok(summary.pruned >= 1, JSON.stringify(summary));
  assert.equal(existsSync(oldB), false, "the disk-only photo past 30 days is gone");
  assert.equal(existsSync(newB), true);
  assert.equal(existsSync(oldA), true, "a device set to never keeps everything");
  assert.equal(existsSync(outside), true, "a stored path outside the photo folder is never deleted");
  const left = (await db.execute({ sql: "SELECT disk_path FROM glasses_photos WHERE disk_path IN (?, ?, ?)", args: [oldB, newB, oldA] })).rows.map((r) => r.disk_path).sort();
  assert.deepEqual(left, [newB, oldA].sort());
  assert.equal((await store.findDevice(db, "glasses-new")).photo_retention, "30d", "a device paired through the panel route starts at 30 days");
});

test("the device list: fit, a playable-voice flag, recent turns and the voice pickers' options, all without a token hash", async () => {
  const list = await (await call("/api/meta-glasses/devices", { headers: SESSION })).json();
  const a = list.devices.find((d) => d.id === "glasses-a");
  assert.equal(a.fit, null, "no assistant bound: no fit to show (the panel says so)");
  assert.equal(a.voice, "none", "no voice profile at all on this instance: nothing the app can play");
  assert.ok(Array.isArray(a.recent_turns));
  assert.ok(!("token_hash" in a) && !("kiosk_token_hash" in a));
  assert.deepEqual(list.profiles, { stt: [], tts: [] });
});

test("media control from the dashboard: one implementation with the voice shortcuts; a device that is not connected is a 404", async () => {
  const csrf = { ...SESSION, "content-type": "application/json", "x-crow-csrf": "csrf-abc" };
  const ctl = (device_id, action) => call("/api/meta-glasses/media/control", { method: "POST", headers: csrf, body: JSON.stringify({ device_id, action }) });
  assert.equal((await ctl("glasses-b", "stop")).status, 404);
  assert.equal((await ctl("glasses-a", "explode")).status, 400);
  const s = await openSession("glasses-a", { headers: { authorization: `Bearer ${tokens.a}` } });
  await until(() => s.messages[0]);
  const r = await ctl("glasses-a", "pause");
  assert.deepEqual(await r.json(), { ok: true, state: "paused" });
  assert.deepEqual(await until(() => s.messages.find((m) => m.type === "media_control")), { type: "media_control", action: "pause" });
  s.ws.close();
});

// LAST: this exhausts the failed-token allowance of one caller for glasses-c for a minute.
test("device-token routes: twenty failed tokens from one caller for one device, then 429 for bad tokens; the right token still works, and other devices are untouched", async () => {
  const codes = [];
  for (let i = 0; i < 25; i += 1) { const r = await call(`/api/meta-glasses/photo?device_id=glasses-c`, { method: "POST", headers: { authorization: "Bearer nope" }, body: Buffer.from("x") }); codes.push(r.status); await r.arrayBuffer(); }
  const first429 = codes.indexOf(429);
  assert.ok(first429 >= 1 && first429 <= 20, `refusals start within the allowance (started at ${first429})`);
  assert.ok(codes.slice(0, first429).every((c) => c === 401) && codes.slice(first429).every((c) => c === 429), codes.join(","));
  assert.equal((await upload("c", "glasses-c", "")).status, 200, "a token that verifies is never refused");
  const s = await openSession("glasses-c", { headers: { authorization: `Bearer ${tokens.c}` } });
  assert.ok(s.ws, "the session opens with the right token");
  s.ws.close();
  assert.equal((await openSession("glasses-c", { headers: { authorization: "Bearer nope" } })).status, 429, "bad tokens for that device from that caller stay held off");
  assert.equal((await call(`/api/meta-glasses/photo?device_id=glasses-b`, { method: "POST", headers: { authorization: "Bearer nope" }, body: Buffer.from("x") })).status, 401, "another device id is counted separately (behind Serve every caller is 127.0.0.1)");
  assert.equal((await call(`/api/meta-glasses/photo?device_id=glasses-c`, { method: "POST", headers: { authorization: "Bearer nope", "tailscale-user-login": "other@example.invalid" }, body: Buffer.from("x") })).status, 401, "another tailnet caller is counted separately");
});
