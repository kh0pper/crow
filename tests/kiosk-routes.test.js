import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";
import { createClient } from "@libsql/client";
import * as store from "../servers/shared/device-store.js";
import { createKioskRuntime, KIOSK_DENY_TOOLS, pairRequester, createSttWarmup, timerDoneSpeech } from "../bundles/kiosk/server/runtime.js";
import { resolveDisplayBird, DEFAULT_BIRD } from "../bundles/kiosk/server/bird.js";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { readPortrait, portraitMood } from "../servers/sharing/profile-avatar.js";
import { wrapPcmAsWav } from "../servers/gateway/voice/turn-helpers.js";

let srv, base, rt, raw, tailnet = true, session = true;
const db = () => ({ execute: (q) => raw.execute(q), close() {} });
const settings = new Map();
const turnCalls = [];
const speakCalls = [];

function runtimeDeps(over = {}) {
  return {
    Router: express.Router, json: express.json, WebSocketServer,
    isAllowedNetwork: () => tailnet,
    csrfMiddleware: (req, res, next) => next(),
    openDb: db, deviceStore: store,
    settings: { readSetting: async (d, k) => settings.get(k) ?? null, writeSetting: async (d, k, v) => { settings.set(k, v); } },
    voice: {
      runVoiceTurn: async (o) => { turnCalls.push(o); return { route: "fast", timings: {} }; },
      speakText: async (o) => { speakCalls.push(o); return true; },
    },
    sttWarmup: async () => {},
    resolveDisplayBird: async () => ({ species: "crow", seed: 0, mood: "happy", outfit: null, source: "default" }),
    themeCss: () => ":root{--k-sky:#eef1f3}",
    files: { publicDir: new URL("../bundles/kiosk/public/", import.meta.url).pathname, birdSvgPath: new URL("../bundles/ramble/server/bird-svg.cjs", import.meta.url).pathname },
    announceToken: { validate: async (d, t) => t === "ann-ok" },
    helloTimeoutMs: 300,
    wrapPcmAsWav,
    log: () => {},
    ...over,
  };
}

async function listen(app, runtime) {
  const s = http.createServer(app);
  runtime?.attachUpgrade(s);
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  return { s, base: `http://127.0.0.1:${s.address().port}` };
}

before(async () => {
  raw = createClient({ url: "file::memory:" });
  await raw.execute("CREATE TABLE dashboard_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)");
  await raw.execute("CREATE TABLE pi_bot_defs (bot_id TEXT PRIMARY KEY, display_name TEXT, definition TEXT, enabled INTEGER)");
  await raw.execute({ sql: "INSERT INTO pi_bot_defs VALUES ('household','House','{}',1),('off','Off','{}',0)", args: [] });
  settings.set("stt_profiles", JSON.stringify([{ id: "fw", provider: "fasterwhisper", baseUrl: "http://localhost:8004/v1" }]));
  settings.set("tts_profiles", JSON.stringify([{ id: "kk", provider: "kokoro", name: "Kokoro (local)" }]));
  rt = createKioskRuntime(runtimeDeps());
  const app = express();
  const dashboardAuth = (req, res, next) => (session ? next() : res.status(401).json({ error: "login" }));
  app.use(rt.router(dashboardAuth));
  ({ s: srv, base } = await listen(app, rt));
});
after(() => { rt.stop(); srv.close(); });

const j = (path, opt = {}) => fetch(base + path, { ...opt, headers: { "Content-Type": "application/json", ...(opt.headers || {}) } });
const wsUrl = (b) => b.replace("http", "ws") + "/api/kiosk/session";

/** Pair a kiosk device directly and open a hello'd session. */
async function connect(id) {
  const { token } = await store.pairDevice(db(), { id, name: id, device_kind: "kiosk" });
  await store.updateDeviceProfiles(db(), id, { bound_bot_id: "household" });
  const ws = new WebSocket(wsUrl(base));
  const msgs = [];
  await new Promise((r) => ws.on("open", r));
  ws.on("message", (d, bin) => { if (!bin) msgs.push(JSON.parse(d.toString())); });
  ws.send(JSON.stringify({ type: "hello", device_id: id, token, caps: {} }));
  for (let i = 0; i < 50 && !msgs.some((m) => m.type === "ready"); i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(msgs[0]?.type, "ready");
  return { ws, msgs };
}

test("page: strict CSP, no-store; unknown assets 404; theme + strings generated", async () => {
  const r = await fetch(base + "/display");
  assert.equal(r.status, 200);
  const csp = r.headers.get("content-security-policy");
  for (const d of ["default-src 'self'", "script-src 'self'", "connect-src 'self' ws://127.0.0.1:8770", "frame-ancestors 'none'"]) assert.ok(csp.includes(d), d);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.ok(!(await r.text()).includes("/kiosk/"), "the page never references the maker-lab-owned /kiosk/ path");
  assert.equal((await fetch(base + "/display/assets/../../manifest.json")).status, 404);
  assert.equal((await fetch(base + "/display/assets/nope.js")).status, 404);
  // fetch normalises literal dot segments, so the line above the 'nope' check never reaches
  // the asset handler; these encoded/prototype names DO reach it (review fix 1).
  for (const f of ["..%2F..%2Fmanifest.json", "%2e%2e%2fmanifest.json", "__proto__", "constructor", "hasOwnProperty"]) {
    assert.equal((await fetch(base + "/display/assets/" + f)).status, 404, f);
  }
  assert.match(await (await fetch(base + "/display/assets/theme.css")).text(), /--k-sky/);
  assert.match(await (await fetch(base + "/display/assets/strings.js")).text(), /^export const STRINGS = /);
  assert.match(await (await fetch(base + "/display/assets/bird-svg.js")).text(), /window\.RambleBird/);
  assert.equal((await fetch(base + "/kiosk")).status, 404, "the kiosk bundle no longer answers /kiosk");
});

test("Funnel and off-tailnet are refused on page, pair and session", async () => {
  assert.equal((await fetch(base + "/display", { headers: { "Tailscale-Funnel-Request": "?1" } })).status, 403);
  assert.equal((await fetch(base + "/display/assets/theme.css", { headers: { "Tailscale-Funnel-Request": "?1" } })).status, 403);
  assert.equal((await j("/api/kiosk/pair/start", { method: "POST", body: "{}", headers: { "Tailscale-Funnel-Request": "?1" } })).status, 403);
  {
    const ws = new WebSocket(wsUrl(base), { headers: { "Tailscale-Funnel-Request": "?1" } });
    const code = await new Promise((r) => { ws.on("unexpected-response", (req, res) => r(res.statusCode)); ws.on("error", () => {}); });
    assert.equal(code, 403);
  }
  tailnet = false;
  try {
    assert.equal((await fetch(base + "/display")).status, 403);
    const ws = new WebSocket(wsUrl(base));
    const code = await new Promise((r) => { ws.on("unexpected-response", (req, res) => r(res.statusCode)); ws.on("error", () => {}); });
    assert.equal(code, 403);
  } finally { tailnet = true; }
});

test("full pairing: start → admin approve (bot required) → one-time pickup → session hello works", async () => {
  const s = await (await j("/api/kiosk/pair/start", { method: "POST", body: JSON.stringify({ name_hint: "Phone" }) })).json();
  assert.equal((await j("/api/kiosk/admin/approve", { method: "POST", body: JSON.stringify({ code: s.code, name: "Kitchen", bot_id: "off" }) })).status, 400, "disabled bot refused");
  const pend = await (await fetch(base + "/api/kiosk/admin/displays")).json();
  assert.equal(pend.pending.length, 1);
  assert.ok(!JSON.stringify(pend).includes(s.code), "code never shown in the admin listing");
  const ok = await (await j("/api/kiosk/admin/approve", { method: "POST", body: JSON.stringify({ code: s.code, name: "Kitchen", bot_id: "household" }) })).json();
  assert.equal(ok.ok, true);
  const dev = await store.findDevice(db(), ok.device_id);
  assert.equal(dev.device_kind, "kiosk"); assert.equal(dev.bound_bot_id, "household");
  assert.equal(dev.stt_profile_id, "kiosk-stt-distil-small-en"); assert.equal(dev.tts_profile_id, "kk");
  const p1 = await (await fetch(base + `/api/kiosk/pair/status?pair_id=${s.pair_id}`, { headers: { "X-Kiosk-Poll": s.poll_secret } })).json();
  assert.equal(p1.state, "approved");
  assert.equal((await fetch(base + `/api/kiosk/pair/status?pair_id=${s.pair_id}`, { headers: { "X-Kiosk-Poll": s.poll_secret } })).status, 404);

  const ws = new WebSocket(wsUrl(base));
  const msgs = [];
  await new Promise((r) => ws.on("open", r));
  ws.on("message", (d, bin) => { if (!bin) msgs.push(JSON.parse(d.toString())); });
  ws.send(JSON.stringify({ type: "hello", device_id: p1.device_id, token: p1.token, caps: {} }));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(msgs[0].type, "ready");
  assert.equal(msgs[0].display_config.bird.species, "crow");

  const closed = new Promise((r) => ws.on("close", (code, reason) => r([code, reason.toString()])));
  assert.equal((await fetch(base + `/api/kiosk/admin/displays/${p1.device_id}`, { method: "DELETE" })).status, 200);
  assert.deepEqual(await closed, [4401, "unpaired"]);
  assert.equal(await store.findDevice(db(), p1.device_id), null);
});

test("token in the URL is ignored: no hello → 4401 hello_timeout", async () => {
  const ws = new WebSocket(wsUrl(base) + "?device_id=x&token=y");
  const [code, reason] = await new Promise((r) => ws.on("close", (c, rs) => r([c, rs.toString()])));
  assert.equal(code, 4401); assert.equal(reason, "hello_timeout");
});

test("admin requires the dashboard session", async () => {
  session = false;
  try { assert.equal((await fetch(base + "/api/kiosk/admin/displays")).status, 401); } finally { session = true; }
});

test("a kiosk token is useless anywhere but the session: admin, internal, glasses-style verify", async () => {
  const { token } = await store.pairDevice(db(), { id: "kiosk-z", name: "Z", device_kind: "kiosk" });
  session = false;
  try { assert.equal((await fetch(base + "/api/kiosk/admin/displays", { headers: { Authorization: `Bearer ${token}` } })).status, 401); } finally { session = true; }
  assert.equal((await fetch(base + "/api/kiosk/internal/displays", { headers: { Authorization: `Bearer ${token}` } })).status, 401);
  assert.equal(await store.verifyToken(db(), "kiosk-z", token), null);
});

// If dashboardAuth reads a request field this stub lacks, ADD the field; never loosen the assertion.
test("core dashboardAuth never treats a kiosk token as a credential (spec §13.1, hermetic half)", async () => {
  const { dashboardAuth } = await import("../servers/gateway/dashboard/auth.js");
  const { token } = await store.pairDevice(db(), { id: "kiosk-y", name: "Y", device_kind: "kiosk" });
  let nexted = false;
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, type() { return this; }, send() { return this; }, json() { return this; },
    redirect() { this.statusCode = 302; return this; }, redirectAfterPost() { this.statusCode = 303; return this; }, setHeader() {}, getHeader() {}, cookie() {} };
  await dashboardAuth({ headers: { "tailscale-user-login": "a@b", authorization: `Bearer ${token}` }, ip: "100.64.0.9", connection: { remoteAddress: "100.64.0.9" }, socket: { remoteAddress: "100.64.0.9" }, method: "GET", path: "/dashboard", originalUrl: "/dashboard", url: "/dashboard", query: {} }, res, () => { nexted = true; });
  assert.equal(nexted, false);
  assert.ok([302, 303, 401, 403].includes(res.statusCode), String(res.statusCode));
});

test("internal API: loopback + announce token; any forwarding/Tailscale header is refused", async () => {
  assert.equal((await fetch(base + "/api/kiosk/internal/displays")).status, 401);
  assert.equal((await fetch(base + "/api/kiosk/internal/displays", { headers: { Authorization: "Bearer ann-ok" } })).status, 200);
  for (const h of [{ "X-Forwarded-For": "100.64.0.9" }, { "Tailscale-User-Login": "a@b" }, { Forwarded: "for=1.2.3.4" }, { "X-Forwarded-Host": "evil.example" }]) {
    assert.equal((await fetch(base + "/api/kiosk/internal/displays", { headers: { Authorization: "Bearer ann-ok", ...h } })).status, 403, JSON.stringify(h));
  }
  const r = await (await j("/api/kiosk/internal/announce", { method: "POST", body: JSON.stringify({ text: "Dinner's ready" }), headers: { Authorization: "Bearer ann-ok" } })).json();
  assert.ok(Array.isArray(r.offline));
});

test("resolveDisplayBird: validated portrait, else the default crow (never throws)", async () => {
  assert.deepEqual(await resolveDisplayBird({}, { readPortrait: async () => null }), DEFAULT_BIRD);
  assert.deepEqual(await resolveDisplayBird({}, { readPortrait: async () => { throw new Error("no tables"); } }), DEFAULT_BIRD);
  assert.deepEqual(await resolveDisplayBird({}, { readPortrait: async () => ({ species: "dodo", seed: 1 }) }), DEFAULT_BIRD);
  assert.deepEqual(await resolveDisplayBird({}, { readPortrait: async () => ({ species: "magpie", seed: 77, mood: "weird", outfit: [1] }) }),
    { species: "magpie", seed: 77, mood: "happy", outfit: null, source: "ramble" });
});

test("resolveDisplayBird + the real core readPortrait on Ramble tables: mood (decay-on-read) and outfit", async () => {
  const r = createClient({ url: "file::memory:" });
  await initRambleTables(r);
  const now = Date.now();
  await r.execute({ sql: "INSERT INTO ramble_eggs (egg_id, species, seed, status, created_at, outfit_json) VALUES ('e1','magpie',77,'hatched',1,?)", args: [JSON.stringify({ scarf: "knit" })] });
  await r.execute({ sql: "INSERT INTO ramble_pet (owner, energy, last_fed_at, active_egg_id) VALUES ('self', 40, ?, 'e1') ON CONFLICT(owner) DO UPDATE SET energy = 40, last_fed_at = excluded.last_fed_at, active_egg_id = 'e1'", args: [now] });
  const b = await resolveDisplayBird(r, { readPortrait });
  assert.deepEqual(b, { species: "magpie", seed: 77, mood: portraitMood(40, now), outfit: { scarf: "knit" }, source: "ramble" });
  assert.equal(b.mood, "tired");
});

// ---- Controller rulings (Task 10) -----------------------------------------

// Ruling A (F1): the installed maker-lab bundle owns /kiosk/* and mounts before us.
test("ruling A: with maker-lab's real router mounted first, /display reaches the kiosk page and /kiosk/ still reaches maker-lab", async () => {
  // maker-lab opens its DB lazily on the first /kiosk request via CROW_DB_PATH:
  // point it at a throwaway file so this test never touches any real crow.db.
  const { createDbClient } = await import("../servers/db.js");
  const dir = mkdtempSync(join(tmpdir(), "kiosk-ml-"));
  const dbPath = join(dir, "crow.db");
  const mdb = createDbClient(dbPath);
  try { await mdb.execute("CREATE TABLE IF NOT EXISTS dashboard_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)"); } finally { try { mdb.close(); } catch {} }
  const prevDbPath = process.env.CROW_DB_PATH;
  process.env.CROW_DB_PATH = dbPath;
  const { default: makerLabRouter } = await import("../bundles/maker-lab/panel/routes.js");
  const k = createKioskRuntime(runtimeDeps());
  const app = express();
  const auth = (req, res, next) => next();
  app.use(makerLabRouter(auth));        // panels mount in panels.json order; maker-lab first is the worst case
  app.use(k.router(auth));
  const { s, base: b } = await listen(app, k);
  try {
    const page = await fetch(b + "/display");
    assert.equal(page.status, 200);
    assert.ok(page.headers.get("content-security-policy")?.includes("frame-ancestors 'none'"), "kiosk page served");
    assert.equal((await fetch(b + "/display/assets/theme.css")).status, 200);
    const ml = await fetch(b + "/kiosk/");
    assert.equal(ml.headers.get("content-security-policy"), null, "not the kiosk page");
    assert.match(await ml.text(), /Ask a grown-up/, "maker-lab's no-session screen");
    const ml2 = await fetch(b + "/kiosk");
    assert.equal(ml2.headers.get("content-security-policy"), null, "/kiosk (Express 5 non-strict) is maker-lab's too");
  } finally {
    k.stop(); s.close();
    if (prevDbPath === undefined) delete process.env.CROW_DB_PATH; else process.env.CROW_DB_PATH = prevDbPath;
  }
});

// Ruling C (F4) + review C3: never on a shared display.
test("ruling C: KIOSK_DENY_TOOLS denies cross-bot escapes, and every voice turn carries it", async () => {
  assert.deepEqual([...KIOSK_DENY_TOOLS].sort(), ["crow_delegate", "crow_delete_bot_schedule", "crow_job_status", "crow_list_bot_schedules", "crow_schedule_bot"]);
  assert.ok(Object.isFrozen(KIOSK_DENY_TOOLS));
  const { ws } = await connect("kiosk-deny");
  const before = turnCalls.length;
  ws.send(JSON.stringify({ type: "turn_start", turn_id: "d1" }));
  ws.send(Buffer.alloc(8000));
  ws.send(JSON.stringify({ type: "turn_end" }));
  for (let i = 0; i < 50 && turnCalls.length === before; i++) await new Promise((r) => setTimeout(r, 10));
  const call = turnCalls.at(-1);
  assert.deepEqual(call.denyTools, KIOSK_DENY_TOOLS);
  assert.equal(call.device.id, "kiosk-deny");
  assert.ok(call.signal instanceof AbortSignal);
  ws.close();
});

// Ruling D (Task 7 carry): the login is trusted only when Serve delivered it (loopback socket).
test("ruling D: pairRequester trusts Tailscale-User-Login only over a loopback socket; keys on the socket address, never X-Forwarded-For", () => {
  for (const a of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
    assert.deepEqual(pairRequester({ socket: { remoteAddress: a }, ip: "9.9.9.9", headers: { "tailscale-user-login": "a@b", "x-forwarded-for": "9.9.9.9" } }), { ip: a, login: "a@b" }, a);
  }
  assert.deepEqual(pairRequester({ socket: { remoteAddress: "100.64.0.9" }, ip: "1.2.3.4", headers: { "tailscale-user-login": "forged@x", "x-forwarded-for": "1.2.3.4" } }), { ip: "100.64.0.9", login: null });
  assert.deepEqual(pairRequester({ socket: {}, headers: {} }), { ip: "?", login: null });
});

test("ruling D (wired): pair/start keys by the Serve login over loopback — a second login is not limited by the first", async () => {
  const k = createKioskRuntime(runtimeDeps());
  const app = express();
  app.use(k.router((req, res, next) => next()));
  const { s, base: b } = await listen(app, k);
  const start = (login) => fetch(b + "/api/kiosk/pair/start", { method: "POST", headers: { "Content-Type": "application/json", "Tailscale-User-Login": login }, body: "{}" });
  try {
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await (await start("a@b")).json()).error || "ok");
    assert.deepEqual(codes, ["ok", "ok", "ok", "too_many_pending", "too_many_pending", "rate_limited"]);
    assert.equal((await (await start("c@d")).json()).error, "too_many_pending", "other login has its own rate bucket");
    assert.ok(k.pairing.listPending().every((p) => p.login === "a@b"), "login recorded from the loopback (Serve) request");
  } finally { k.stop(); s.close(); }
});

// Ruling E (Task 9 carry): speech gets the hub's abort signal all the way to speakText.
test("ruling E: announce speech forwards the session's abort signal to speakText", async () => {
  const { ws } = await connect("kiosk-speak");
  const before = speakCalls.length;
  const r = await rt.announce("kiosk-speak", { text: "Dinner's ready", speak: true });
  assert.deepEqual(r.delivered, ["kiosk-speak"]);
  for (let i = 0; i < 50 && speakCalls.length === before; i++) await new Promise((res) => setTimeout(res, 10));
  const call = speakCalls.at(-1);
  assert.equal(call.text, "Dinner's ready");
  assert.ok(call.signal instanceof AbortSignal, "signal forwarded");
  assert.equal(call.device.id, "kiosk-speak");
  ws.close();
});

// Ruling F: WS frames are capped at 256 KiB.
test("ruling F: a WS frame over 256 KiB closes the socket (1009)", async () => {
  const { ws } = await connect("kiosk-big");
  const closed = new Promise((r) => ws.on("close", (c) => r(c)));
  ws.send(Buffer.alloc(256 * 1024 + 1));
  assert.equal(await closed, 1009);
});

// Ruling F (R13): STT warm-up at most once per 10 min per STT profile.
test("ruling F: createSttWarmup transcribes once per profile per 10 min and never throws", async () => {
  let t = 1_000_000;
  const calls = [];
  const warm = createSttWarmup({
    openDb: () => ({ close() {} }),
    getSttProfile: async (d, dev) => (dev.stt_profile_id === "boom" ? (() => { throw new Error("x"); })() : { id: dev.stt_profile_id, language: "en" }),
    createSttAdapter: async (p) => ({ transcribe: async (wav, o) => { calls.push({ p: p.id, len: wav.length, o }); return { text: "" }; } }),
    wrapPcmAsWav, now: () => t, log: () => {},
  });
  await warm({ stt_profile_id: "fw" });
  await warm({ stt_profile_id: "fw" });
  await warm({ stt_profile_id: "other" });
  assert.deepEqual(calls.map((c) => c.p), ["fw", "other"]);
  assert.equal(calls[0].o.contentType, "audio/wav");
  assert.ok(calls[0].o.signal instanceof AbortSignal);
  t += 10 * 60 * 1000 + 1;
  await warm({ stt_profile_id: "fw" });
  assert.deepEqual(calls.map((c) => c.p), ["fw", "other", "fw"]);
  await warm({ stt_profile_id: "boom" });   // swallowed
});

// Review fix 2 (R10): CSRF guards every admin mutation; pairing is not behind it.
test("CSRF: a rejecting csrfMiddleware blocks admin POST/DELETE; pair/start and pair/status are unaffected", async () => {
  const k = createKioskRuntime(runtimeDeps({ csrfMiddleware: (req, res) => res.status(403).json({ error: "csrf" }) }));
  const app = express();
  app.use(k.router((req, res, next) => next()));
  const { s, base: b } = await listen(app, k);
  const req = (path, method, body) => fetch(b + path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  try {
    assert.equal((await req("/api/kiosk/admin/approve", "POST", { code: "123456", name: "K", bot_id: "household" })).status, 403);
    assert.equal((await req("/api/kiosk/admin/displays/kiosk-x", "POST", { name: "Y" })).status, 403);
    assert.equal((await req("/api/kiosk/admin/displays/kiosk-x", "DELETE")).status, 403);
    const st = await req("/api/kiosk/pair/start", "POST", {});
    assert.equal(st.status, 200);
    const { pair_id, poll_secret } = await st.json();
    const ps = await fetch(b + `/api/kiosk/pair/status?pair_id=${pair_id}`, { headers: { "X-Kiosk-Poll": poll_secret } });
    assert.equal(ps.status, 200);
    assert.equal((await ps.json()).state, "pending");
  } finally { k.stop(); s.close(); }
});

// Review fix 3: the MCP server must reach the gateway on the gateway's own port
// (servers/gateway/index.js: PORT || CROW_GATEWAY_PORT || 3001).
test("MCP server: gateway port order matches the gateway (PORT before CROW_GATEWAY_PORT)", async () => {
  const { createKioskServer } = await import("../bundles/kiosk/server/server.js");
  const dir = mkdtempSync(join(tmpdir(), "kiosk-mcp-"));
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(dir, "tok"), "t0k\n");
  const prev = { PORT: process.env.PORT, CROW_GATEWAY_PORT: process.env.CROW_GATEWAY_PORT };
  const urls = [];
  const fetchImpl = async (u, o) => { urls.push([u, o.headers.Authorization]); return { ok: true, json: async () => ({ displays: [] }) }; };
  try {
    process.env.PORT = "3002"; process.env.CROW_GATEWAY_PORT = "3004";
    await createKioskServer({ fetchImpl, tokenPath: join(dir, "tok") })._registeredTools.crow_kiosk_list_displays.handler({}, {});
    delete process.env.PORT;
    await createKioskServer({ fetchImpl, tokenPath: join(dir, "tok") })._registeredTools.crow_kiosk_list_displays.handler({}, {});
    assert.deepEqual(urls, [
      ["http://127.0.0.1:3002/api/kiosk/internal/displays", "Bearer t0k"],
      ["http://127.0.0.1:3004/api/kiosk/internal/displays", "Bearer t0k"],
    ]);
  } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

// Review fix 4: a failure after pairDevice must not leave a paired, unbound device
// whose token is never delivered.
test("approve: a failure binding the bot unpairs the just-created device and releases the code", async () => {
  const failing = { ...store, updateDeviceProfiles: async () => { throw new Error("db busy"); } };
  const k = createKioskRuntime(runtimeDeps({ deviceStore: failing }));
  const app = express();
  app.use(k.router((req, res, next) => next()));
  const { s, base: b } = await listen(app, k);
  try {
    const before = (await store.listDevices(db())).filter((d) => d.device_kind === "kiosk").map((d) => d.id);
    const st = await (await fetch(b + "/api/kiosk/pair/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json();
    const r = await fetch(b + "/api/kiosk/admin/approve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: st.code, name: "Orphan", bot_id: "household" }) });
    assert.equal(r.status, 500);
    const after = (await store.listDevices(db())).filter((d) => d.device_kind === "kiosk").map((d) => d.id);
    assert.deepEqual(after, before, "no orphan kiosk device left behind");
    assert.equal(k.pairing.listPending().length, 1, "pairing released, still pending");
  } finally { k.stop(); s.close(); }
});

// Final-review item 3: a panel save reaches the open page (fresh `ready`).
test("admin display update pushes a fresh ready (display_config) to the live page", async () => {
  const { ws, msgs } = await connect("kiosk-live-cfg");
  assert.equal(msgs.filter((m) => m.type === "ready").length, 1);
  const r = await (await j("/api/kiosk/admin/displays/kiosk-live-cfg", { method: "POST", body: JSON.stringify({ kiosk_settings: { follow_up: true, lang: "es" } }) })).json();
  assert.equal(r.ok, true);
  for (let i = 0; i < 50 && msgs.filter((m) => m.type === "ready").length < 2; i++) await new Promise((res) => setTimeout(res, 10));
  const readies = msgs.filter((m) => m.type === "ready");
  assert.equal(readies.length, 2, "second ready pushed");
  assert.equal(readies[1].display_config.follow_up, true);
  assert.equal(readies[1].display_config.lang, "es");
  assert.equal(readies[1].display_config.bird.species, "crow");
  assert.equal(typeof readies[1].server_now, "number");
  // an omitted field is never cleared by an update
  const dev = await store.findDevice(db(), "kiosk-live-cfg");
  assert.equal(dev.bound_bot_id, "household");
  ws.close();
});

// Final-review item 4: no "Timer timer is done.", and the display's language.
test("timerDoneSpeech: unnamed → Time's up.; named → '<name> timer is done.'; Spanish from strings", () => {
  assert.equal(timerDoneSpeech("Timer", "en"), "Time's up.");
  assert.equal(timerDoneSpeech("", undefined), "Time's up.");
  assert.equal(timerDoneSpeech("Pasta", "en"), "Pasta timer is done.");
  assert.equal(timerDoneSpeech("Pasta", "fr"), "Pasta timer is done.", "unknown lang → en");
  assert.equal(timerDoneSpeech("Timer", "es"), "Se acabó el tiempo.");
  assert.equal(timerDoneSpeech("Pasta", "es"), "Terminó el temporizador Pasta.");
});

test("a finished timer is spoken in the display's language (wired through the runtime)", async () => {
  const { ws } = await connect("kiosk-timer-es");
  await j("/api/kiosk/admin/displays/kiosk-timer-es", { method: "POST", body: JSON.stringify({ kiosk_settings: { lang: "es" } }) });
  const before = speakCalls.length;
  rt.wm.open("kiosk-timer-es", { kind: "timer", name: "Timer", title: "Timer", seconds: 0.02 });
  for (let i = 0; i < 100 && speakCalls.length === before; i++) await new Promise((res) => setTimeout(res, 10));
  assert.equal(speakCalls.at(-1).text, "Se acabó el tiempo.");
  assert.equal(speakCalls.at(-1).device.id, "kiosk-timer-es");
  ws.close();
});
