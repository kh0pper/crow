import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";
import { createClient } from "@libsql/client";
import * as store from "../servers/shared/device-store.js";
import { createKioskRuntime, KIOSK_DENY_TOOLS, KIOSK_MAX_TOOL_ROUNDS, KIOSK_FIRST_AUDIO_BUDGET_MS, kioskFallbackText, kioskTooLargeText, kioskDisplayMissedText, pairRequester, createSttWarmup, timerDoneSpeech } from "../bundles/kiosk/server/runtime.js";
import { wantsMemory } from "../bundles/kiosk/server/memory-intent.js";
import { displayPromptSuffix } from "../bundles/kiosk/server/prompt.js";
import { effectiveCaps } from "../bundles/kiosk/server/caps.js";
import { TURN_CHECK, TURN_CHECK_DEVICE, TURN_CHECK_CARD_TRIES } from "../bundles/kiosk/server/runtime.js";
import { createBotFit, FIT_TTL_MS } from "../bundles/kiosk/server/fit.js";
import { STRINGS } from "../bundles/kiosk/server/strings.js";
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
async function connect(id, caps = {}) {
  const { token } = await store.pairDevice(db(), { id, name: id, device_kind: "kiosk" });
  await store.updateDeviceProfiles(db(), id, { bound_bot_id: "household" });
  const ws = new WebSocket(wsUrl(base));
  const msgs = [];
  await new Promise((r) => ws.on("open", r));
  ws.on("message", (d, bin) => { if (!bin) msgs.push(JSON.parse(d.toString())); });
  ws.send(JSON.stringify({ type: "hello", device_id: id, token, caps }));
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
  assert.deepEqual([...KIOSK_DENY_TOOLS].sort(), ["crow_delegate", "crow_delete_bot_schedule", "crow_discover", "crow_job_status", "crow_list_bot_schedules", "crow_schedule_bot"]);
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
  // Lever 2: the per-display model reaches the turn, for a faster-whisper profile only.
  assert.equal(call.sttModel({ provider: "fasterwhisper" }), null, "default → the profile's own model");
  call.device.kiosk_settings = { stt_model: "tiny.en" };
  assert.equal(call.sttModel({ provider: "fasterwhisper" }), "Systran/faster-whisper-tiny.en");
  assert.equal(call.sttModel({ provider: "openai" }), null, "never forced onto another provider");
  ws.close();
});

test("stall fix (wired): every kiosk voice turn carries the 3-round cap, the 12 s first-audio budget and the fallback in the display's language", async () => {
  assert.equal(KIOSK_MAX_TOOL_ROUNDS, 3);
  assert.equal(KIOSK_FIRST_AUDIO_BUDGET_MS, 12_000);
  assert.equal(kioskFallbackText("en"), STRINGS.en.fallback_stuck);
  assert.equal(kioskFallbackText("es"), STRINGS.es.fallback_stuck);
  assert.equal(kioskFallbackText(undefined), STRINGS.en.fallback_stuck);
  const { token } = await store.pairDevice(db(), { id: "kiosk-stall-es2", name: "es2", device_kind: "kiosk", kiosk_settings: { lang: "es" } });
  await store.updateDeviceProfiles(db(), "kiosk-stall-es2", { bound_bot_id: "household" });
  const w = new WebSocket(wsUrl(base));
  const msgs = [];
  await new Promise((r) => w.on("open", r));
  w.on("message", (d, bin) => { if (!bin) msgs.push(JSON.parse(d.toString())); });
  w.send(JSON.stringify({ type: "hello", device_id: "kiosk-stall-es2", token, caps: {} }));
  for (let i = 0; i < 50 && !msgs.some((m) => m.type === "ready"); i++) await new Promise((r) => setTimeout(r, 10));
  const before = turnCalls.length;
  w.send(JSON.stringify({ type: "turn_start", turn_id: "s1" }));
  w.send(Buffer.alloc(8000));
  w.send(JSON.stringify({ type: "turn_end" }));
  for (let i = 0; i < 50 && turnCalls.length === before; i++) await new Promise((r) => setTimeout(r, 10));
  const call = turnCalls.at(-1);
  assert.equal(call.device.id, "kiosk-stall-es2");
  assert.equal(call.maxToolRounds, KIOSK_MAX_TOOL_ROUNDS);
  assert.equal(call.firstAudioBudgetMs, KIOSK_FIRST_AUDIO_BUDGET_MS);
  assert.equal(call.fallbackText, STRINGS.es.fallback_stuck);
  w.close();
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
    getSttProfile: async (d, dev) => (dev.stt_profile_id === "boom" ? (() => { throw new Error("x"); })() : { id: dev.stt_profile_id, provider: "fasterwhisper", language: "en" }),
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
  assert.equal(await warm({ stt_profile_id: "boom" }), false);   // swallowed
});

test("smoke 2026-10-04: warm-up is per profile AND model, retries after a failure, and never bills a cloud STT", async () => {
  let t = 1_000_000, fail = true;
  const calls = [];
  const profiles = { fw: { id: "fw", provider: "fasterwhisper", language: "en" }, cloud: { id: "cloud", provider: "openai" } };
  const warm = createSttWarmup({
    openDb: () => ({ close() {} }),
    getSttProfile: async (d, dev) => profiles[dev.stt_profile_id],
    createSttAdapter: async (p) => ({ transcribe: async (wav, o) => { calls.push({ p: p.id, model: o.model ?? null }); if (fail) throw new Error("ECONNREFUSED"); return { text: "" }; } }),
    wrapPcmAsWav, now: () => t, log: () => {},
  });
  assert.equal(await warm({ stt_profile_id: "fw" }), false, "whisper still starting");
  fail = false;
  assert.equal(await warm({ stt_profile_id: "fw" }), true, "a failure is not remembered as warm");
  assert.equal(await warm({ stt_profile_id: "fw" }), null, "throttled");
  assert.equal(await warm({ stt_profile_id: "fw", kiosk_settings: { stt_model: "tiny.en" } }), true, "a new model warms at once");
  assert.equal(await warm({ stt_profile_id: "cloud" }), null);
  assert.deepEqual(calls, [{ p: "fw", model: null }, { p: "fw", model: null }, { p: "fw", model: "Systran/faster-whisper-tiny.en" }]);
});

test("smoke 2026-10-04: boot warm-up warms every paired display and retries until whisper answers", async () => {
  const timers = [];
  let up = false;
  const warmed = [];
  const r = createKioskRuntime(runtimeDeps({
    sttWarmup: async (d) => { if (!up) return false; warmed.push(d.id); return true; },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; },
  }));
  await store.pairDevice(db(), { id: "kiosk-boot", name: "boot", device_kind: "kiosk" });
  await r.bootWarmup({ tries: 3, everyMs: 30_000 });
  assert.equal(timers.length, 1, "retry scheduled");
  assert.equal(timers[0].ms, 30_000);
  up = true;
  await timers[0].fn();
  assert.ok(warmed.includes("kiosk-boot"));
  assert.equal(timers.length, 1, "no retry after a clean round");
  up = false;
  const r2 = createKioskRuntime(runtimeDeps({ sttWarmup: async () => false, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return {}; } }));
  timers.length = 0;
  await r2.bootWarmup({ tries: 2, everyMs: 1 });
  await timers[0].fn();
  assert.equal(timers.length, 1, "gives up after `tries` rounds");
  r.stop(); r2.stop();
});

test("smoke 2026-10-04: changing a display's speech model warms it at once", async () => {
  const warmed = [];
  const r = createKioskRuntime(runtimeDeps({ sttWarmup: async (d) => { warmed.push(d.kiosk_settings?.stt_model); return true; } }));
  const app = express();
  app.use(r.router((req, res, next) => next()));
  const { s, base: b } = await listen(app, r);
  await store.pairDevice(db(), { id: "kiosk-model", name: "m", device_kind: "kiosk" });
  const res = await fetch(b + "/api/kiosk/admin/displays/kiosk-model", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kiosk_settings: { stt_model: "tiny.en" } }) });
  assert.equal((await res.json()).ok, true);
  for (let i = 0; i < 20 && !warmed.length; i++) await new Promise((x) => setTimeout(x, 5));
  assert.deepEqual(warmed, ["tiny.en"]);
  await fetch(b + "/api/kiosk/admin/displays/kiosk-model", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kiosk_settings: { follow_up: true } }) });
  await new Promise((x) => setTimeout(x, 20));
  assert.deepEqual(warmed, ["tiny.en"], "an unrelated setting does not warm");
  r.stop(); s.close();
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

// Operator request 2026-10-05: a per-display theme, saved from the panel and pushed to the open page.
test("display theme: the open page gets auto first, then the saved theme at once; a bad value keeps the saved one", async () => {
  const { ws, msgs } = await connect("kiosk-live-theme");
  const readies = () => msgs.filter((m) => m.type === "ready");
  const waitFor = async (n) => { for (let i = 0; i < 50 && readies().length < n; i++) await new Promise((res) => setTimeout(res, 10)); };
  assert.equal(readies()[0].display_config.theme, "auto", "default unchanged: auto");
  const save = async (theme) => (await (await j("/api/kiosk/admin/displays/kiosk-live-theme", { method: "POST", body: JSON.stringify({ kiosk_settings: { theme } }) })).json());
  assert.equal((await save("dark")).device.kiosk_settings.theme, "dark");
  await waitFor(2);
  assert.equal(readies()[1].display_config.theme, "dark", "pushed live");
  assert.equal((await save("midnight")).device.kiosk_settings.theme, "dark", "rejected value keeps the prior theme");
  await waitFor(3);
  assert.equal(readies()[2].display_config.theme, "dark");
  assert.equal((await store.findDevice(db(), "kiosk-live-theme")).kiosk_settings.theme, "dark", "stored with the display");
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

test("lever D (wired): speech_pause → voice.transcribe with the display's model; the turn gets the early transcript", async () => {
  const tx = [], runs = [];
  const r = createKioskRuntime(runtimeDeps({
    voice: {
      transcribe: async (o) => { tx.push(o); return { text: "early words" }; },
      runVoiceTurn: async (o) => { runs.push(o); return { route: "fast", timings: {} }; },
      speakText: async () => true,
    },
  }));
  const app = express();
  app.use(r.router((req, res, next) => next()));
  const { s, base: b } = await listen(app, r);
  const { token } = await store.pairDevice(db(), { id: "kiosk-early", name: "e", device_kind: "kiosk" });
  await store.updateDeviceProfiles(db(), "kiosk-early", { bound_bot_id: "household", kiosk_settings: { stt_model: "tiny.en" } });
  const ws = new WebSocket(wsUrl(b));
  const msgs = [];
  await new Promise((x) => ws.on("open", x));
  ws.on("message", (d, bin) => { if (!bin) msgs.push(JSON.parse(d.toString())); });
  ws.send(JSON.stringify({ type: "hello", device_id: "kiosk-early", token, caps: {} }));
  for (let i = 0; i < 50 && !msgs.some((m) => m.type === "ready"); i++) await new Promise((x) => setTimeout(x, 10));
  ws.send(JSON.stringify({ type: "turn_start", turn_id: "w1" }));
  ws.send(Buffer.alloc(8000, 3));
  ws.send(JSON.stringify({ type: "speech_pause" }));
  ws.send(JSON.stringify({ type: "turn_end", vad_reason: "silence", voiced_bytes: 8000 }));
  for (let i = 0; i < 50 && !runs.length; i++) await new Promise((x) => setTimeout(x, 10));
  assert.equal(tx.length, 1);
  assert.equal(tx[0].sttModel({ provider: "fasterwhisper" }), "Systran/faster-whisper-tiny.en");
  assert.equal(runs[0].transcript, "early words");
  assert.equal(runs[0].sttEarly.used, true);
  assert.equal(typeof runs[0].startedAt, "number");
  ws.close(); r.stop(); s.close();
});

// ── Assistant fit (a bound assistant whose prompt does not fit the quick voice model) ─────────────
/** A runtime whose voice runner answers assessBot from a table: bot_id → level, or { off, on } by memory setting. */
async function fitRuntime(levels) {
  const asked = [];
  const voice = {
    runVoiceTurn: async (o) => { turnCalls.push(o); return { route: "fast", timings: {} }; },
    speakText: async () => true,
    assessBot: async (o) => {
      asked.push(o);
      const v = levels[o.botId];
      if (v === undefined) return null;
      if (v instanceof Error) throw v;
      const level = typeof v === "string" ? v : (o.memoryOn ? v.on : v.off);
      return { level, ctx: level === "unknown" ? null : 8192, est_tokens: 1, est_no_skills_tokens: 1, reserve_tokens: 1024, model: "crow-voice/quick" };
    },
  };
  const k = createKioskRuntime(runtimeDeps({ voice }));
  const app = express();
  app.use(k.router((req, res, next) => next()));
  const { s, base: b } = await listen(app, k);
  const post = (path, body) => fetch(b + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { k, b, post, asked, close: () => { k.stop(); s.close(); } };
}
const FIT_BOTS = "('fit-general','General','{}',1),('fit-huge','Huge','{}',1),('fit-edge','Edge','{}',1),('fit-unknown','Unknown','{}',1),('fit-broken','Broken','{}',1)";

test("fit: the listing gives every assistant its fit (with and without memories), computed by the voice runner with the kiosk's own tool list", async () => {
  await raw.execute({ sql: `INSERT INTO pi_bot_defs VALUES ${FIT_BOTS}`, args: [] });
  const f = await fitRuntime({ household: "full", "fit-general": "no_skills", "fit-huge": "too_large", "fit-edge": { off: "no_skills", on: "too_large" }, "fit-unknown": "unknown", "fit-broken": new Error("skills dir unreadable") });
  try {
    const body = await (await fetch(f.b + "/api/kiosk/admin/displays")).json();
    const by = Object.fromEntries(body.bots.map((x) => [x.bot_id, x]));
    assert.deepEqual([by.household.fit, by.household.fit_memory], ["full", "full"]);
    assert.deepEqual([by["fit-general"].fit, by["fit-general"].fit_memory], ["no_skills", "no_skills"]);
    assert.deepEqual([by["fit-huge"].fit, by["fit-huge"].fit_memory], ["too_large", "too_large"]);
    assert.deepEqual([by["fit-edge"].fit, by["fit-edge"].fit_memory], ["no_skills", "too_large"]);
    assert.deepEqual([by["fit-unknown"].fit, by["fit-unknown"].fit_memory], [null, null], "unknown model context: no status");
    assert.deepEqual([by["fit-broken"].fit, by["fit-broken"].fit_memory], [null, null], "a failed check is no status, never a refusal");
    assert.equal(by.household.display_name, "House");
    const q = f.asked.find((o) => o.botId === "fit-general" && o.memoryOn === false);
    assert.deepEqual(q.denyTools, KIOSK_DENY_TOOLS);
    assert.equal(q.promptSuffix, displayPromptSuffix(null));
    assert.deepEqual(q.extraTools.map((x) => x.definition.name), ["crow_show", "crow_wm"]);
    const n = f.asked.length;
    await (await fetch(f.b + "/api/kiosk/admin/displays")).json();
    assert.equal(f.asked.length, n, "the 5 s panel poll does not re-read every skill file: fits are cached");
  } finally { f.close(); await raw.execute({ sql: "DELETE FROM pi_bot_defs WHERE bot_id LIKE 'fit-%'", args: [] }); }
});

test("fit: pairing a display to a too-large assistant is refused (bot_too_large) and the code stays usable; without-skills and unknown fits pair", async () => {
  await raw.execute({ sql: `INSERT INTO pi_bot_defs VALUES ${FIT_BOTS}`, args: [] });
  const f = await fitRuntime({ household: "full", "fit-general": "no_skills", "fit-huge": "too_large", "fit-broken": new Error("x") });
  try {
    const st = await (await f.post("/api/kiosk/pair/start", {})).json();
    const no = await f.post("/api/kiosk/admin/approve", { code: st.code, name: "Kitchen", bot_id: "fit-huge" });
    assert.equal(no.status, 400);
    assert.deepEqual(await no.json(), { error: "bot_too_large" });
    assert.equal(f.k.pairing.listPending().length, 1, "the code was not used up");
    const ok = await (await f.post("/api/kiosk/admin/approve", { code: st.code, name: "Kitchen", bot_id: "fit-general" })).json();
    assert.equal(ok.ok, true);
    assert.equal((await store.findDevice(db(), ok.device_id)).bound_bot_id, "fit-general");
    const st2 = await (await f.post("/api/kiosk/pair/start", {})).json();
    assert.equal((await (await f.post("/api/kiosk/admin/approve", { code: st2.code, name: "Hall", bot_id: "fit-broken" })).json()).ok, true, "a failed fit check never blocks pairing");
  } finally { f.close(); await raw.execute({ sql: "DELETE FROM pi_bot_defs WHERE bot_id LIKE 'fit-%'", args: [] }); }
});

test("fit: rebinding a display to a too-large assistant is refused; other saves on an already-bound display are not; the fit uses the display's memory setting", async () => {
  await raw.execute({ sql: `INSERT INTO pi_bot_defs VALUES ${FIT_BOTS}`, args: [] });
  const f = await fitRuntime({ household: "full", "fit-general": "no_skills", "fit-huge": "too_large", "fit-edge": { off: "no_skills", on: "too_large" } });
  try {
    await store.pairDevice(db(), { id: "kiosk-fit-a", name: "Fit A", device_kind: "kiosk" });
    await store.updateDeviceProfiles(db(), "kiosk-fit-a", { bound_bot_id: "household" });
    const no = await f.post("/api/kiosk/admin/displays/kiosk-fit-a", { bound_bot_id: "fit-huge" });
    assert.equal(no.status, 400);
    assert.deepEqual(await no.json(), { error: "bot_too_large" });
    assert.equal((await store.findDevice(db(), "kiosk-fit-a")).bound_bot_id, "household", "nothing was saved");
    assert.equal((await f.post("/api/kiosk/admin/displays/kiosk-fit-a", { bound_bot_id: "fit-edge" })).status, 200, "fits without skills while memories are off");
    // A display that is ALREADY on a too-large assistant can still save its other settings (and can leave it).
    await store.updateDeviceProfiles(db(), "kiosk-fit-a", { bound_bot_id: "fit-huge" });
    assert.equal((await f.post("/api/kiosk/admin/displays/kiosk-fit-a", { bound_bot_id: "fit-huge", kiosk_settings: { vad_hangover_ms: 600 } })).status, 200);
    assert.equal((await store.findDevice(db(), "kiosk-fit-a")).kiosk_settings.vad_hangover_ms, 600);
    // Memories on: the same assistant no longer fits → refused with the display's own setting.
    await store.updateDeviceProfiles(db(), "kiosk-fit-a", { bound_bot_id: "household", kiosk_settings: { memory_integration: true } });
    assert.equal((await f.post("/api/kiosk/admin/displays/kiosk-fit-a", { bound_bot_id: "fit-edge" })).status, 400);
    assert.equal((await f.post("/api/kiosk/admin/displays/kiosk-fit-a", { bound_bot_id: "fit-edge", kiosk_settings: { memory_integration: false } })).status, 200, "the posted memory setting is the one that counts");
  } finally { f.close(); await raw.execute({ sql: "DELETE FROM pi_bot_defs WHERE bot_id LIKE 'fit-%'", args: [] }); }
});

test("fit (wired): every kiosk voice turn carries the too-large line in the display's language", async () => {
  assert.equal(kioskTooLargeText("en"), STRINGS.en.err_bot_too_large);
  assert.equal(kioskTooLargeText("es"), STRINGS.es.err_bot_too_large);
  assert.equal(kioskTooLargeText(undefined), STRINGS.en.err_bot_too_large);
  for (const L of ["en", "es"]) assert.match(STRINGS[L].err_bot_too_large, /Kiosk/, "the line says where to fix it");
  const { token } = await store.pairDevice(db(), { id: "kiosk-fit-es", name: "es", device_kind: "kiosk", kiosk_settings: { lang: "es" } });
  await store.updateDeviceProfiles(db(), "kiosk-fit-es", { bound_bot_id: "household" });
  const w = new WebSocket(wsUrl(base));
  const msgs = [];
  await new Promise((r) => w.on("open", r));
  w.on("message", (d, bin) => { if (!bin) msgs.push(JSON.parse(d.toString())); });
  w.send(JSON.stringify({ type: "hello", device_id: "kiosk-fit-es", token, caps: {} }));
  for (let i = 0; i < 50 && !msgs.some((m) => m.type === "ready"); i++) await new Promise((r) => setTimeout(r, 10));
  const before = turnCalls.length;
  w.send(JSON.stringify({ type: "turn_start", turn_id: "f1" }));
  w.send(Buffer.alloc(8000));
  w.send(JSON.stringify({ type: "turn_end" }));
  for (let i = 0; i < 50 && turnCalls.length === before; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(turnCalls.at(-1).tooLargeText, STRINGS.es.err_bot_too_large);
  w.close();
});

test("fit cache: one check per assistant and memory setting per 30 s; fresh bypasses it; unknown context and errors are null", async () => {
  let t = 0;
  const calls = [];
  const fit = createBotFit({
    now: () => t, log: () => {},
    assess: async (d, botId, mem) => { calls.push(`${botId}|${mem}`); if (botId === "boom") throw new Error("x"); return botId === "nil" ? null : { level: mem ? "too_large" : "no_skills", ctx: botId === "noctx" ? null : 8192 }; },
  });
  assert.equal(await fit({}, "a", false), "no_skills");
  assert.equal(await fit({}, "a", false), "no_skills");
  assert.equal(await fit({}, "a", true), "too_large");
  assert.deepEqual(calls, ["a|false", "a|true"]);
  assert.equal(await fit({}, "a", false, { fresh: true }), "no_skills");
  assert.equal(calls.length, 3);
  t += FIT_TTL_MS;
  await fit({}, "a", false);
  assert.equal(calls.length, 4, "expired after 30 s");
  assert.equal(await fit({}, "noctx", false), null);
  assert.equal(await fit({}, "nil", false), null);
  assert.equal(await fit({}, "boom", false), null);
});

// ── Live test 2026-10-04: plain questions through the display tool; no idea what time it is ───────
test("live test (wired): a kiosk turn offers crow_wm only when asked, carries the display's date and time on the user message, and answers the clock with no model call", async () => {
  const { token } = await store.pairDevice(db(), { id: "kiosk-clock", name: "clock", device_kind: "kiosk" });
  await store.updateDeviceProfiles(db(), "kiosk-clock", { bound_bot_id: "household" });
  const w = new WebSocket(wsUrl(base));
  const msgs = [];
  await new Promise((r) => w.on("open", r));
  w.on("message", (d, bin) => { if (!bin) msgs.push(JSON.parse(d.toString())); });
  w.send(JSON.stringify({ type: "hello", device_id: "kiosk-clock", token, caps: {}, tz: "Asia/Tokyo" }));
  for (let i = 0; i < 50 && !msgs.some((m) => m.type === "ready"); i++) await new Promise((r) => setTimeout(r, 10));
  const before = turnCalls.length;
  w.send(JSON.stringify({ type: "turn_start", turn_id: "c1" }));
  w.send(Buffer.alloc(8000));
  w.send(JSON.stringify({ type: "turn_end" }));
  for (let i = 0; i < 50 && turnCalls.length === before; i++) await new Promise((r) => setTimeout(r, 10));
  const call = turnCalls.at(-1);
  assert.equal(call.device.id, "kiosk-clock");
  // A: the display tool decides per turn, from the plain transcript.
  assert.deepEqual(call.extraTools.map((x) => x.definition.name), ["crow_show", "crow_wm"]);
  const [showTool, wmTool] = call.extraTools;
  assert.equal(call.familiesOnIntent, true, "other tool families are offered only on intent");
  for (const t of [showTool, wmTool]) {
    assert.equal(t.when("Tell me a joke"), false);
    assert.equal(t.when("What time is it?"), false);
    assert.equal(t.when("set a timer for one minute and label it check"), true);
    assert.equal(t.when("show me the shopping list"), true);
  }
  // D: date, time and zone ride on the turn context (the user message), never the system suffix.
  assert.match(call.turnContext("Tell me a joke"), /^\[Now\] \w+day, \w+ \d{1,2}, \d{4}, \d{1,2}:\d\d [AP]M \(time zone Asia\/Tokyo\)\n\[Display\] Open windows: none\.$/);
  assert.doesNotMatch(call.promptSuffix, /\d{4}|[AP]M\b|Tokyo/, "the system message stays byte-stable");
  assert.equal(call.promptSuffix, displayPromptSuffix(effectiveCaps({}, undefined)));
  assert.match(call.promptSuffix, /\[Now\]/, "the model is told what the bracketed lines are");
  const fp = await call.fastPaths("What time is it?");
  assert.match(fp.say, /^It's \d{1,2}:\d\d [AP]M\.$/);
  assert.match((await call.fastPaths("¿Qué día es hoy?")).say, /^Hoy es \p{L}+, \d{1,2} de \p{L}+ de \d{4}\.$/u, "Spanish day names carry accents (miércoles, sábado)");
  assert.equal(await call.fastPaths("Tell me a joke"), null);
  assert.equal(await call.fastPaths("What time is it in Lisbon?"), null);
  assert.equal(await call.fastPaths("cierra todo"), null, "nothing is open: the phrase does not fire");
  // The timer fast path still wins for the wm family.
  assert.match((await call.fastPaths("set a timer for 2 minutes")).say, /^Timer set/);
  rt.wm.closeAll("kiosk-clock");
  w.close();
});

// ── Live re-test 2026-10-04 (0.1.7): truthful display turns, memory only when asked ───────────────
test("display truth (wired): every kiosk turn carries the must-run display tool, the memory-intent gate and the could-not-show line in the display's language", async () => {
  assert.equal(kioskDisplayMissedText("en"), STRINGS.en.display_missed_say);
  assert.equal(kioskDisplayMissedText("es"), STRINGS.es.display_missed_say);
  assert.equal(kioskDisplayMissedText(undefined), STRINGS.en.display_missed_say);
  const { token } = await store.pairDevice(db(), { id: "kiosk-truth-es", name: "es", device_kind: "kiosk", kiosk_settings: { lang: "es", memory_integration: true } });
  await store.updateDeviceProfiles(db(), "kiosk-truth-es", { bound_bot_id: "household" });
  const w = new WebSocket(wsUrl(base));
  const msgs = [];
  await new Promise((r) => w.on("open", r));
  w.on("message", (d, bin) => { if (!bin) msgs.push(JSON.parse(d.toString())); });
  w.send(JSON.stringify({ type: "hello", device_id: "kiosk-truth-es", token, caps: {} }));
  for (let i = 0; i < 50 && !msgs.some((m) => m.type === "ready"); i++) await new Promise((r) => setTimeout(r, 10));
  const before = turnCalls.length;
  w.send(JSON.stringify({ type: "turn_start", turn_id: "d1" }));
  w.send(Buffer.alloc(8000));
  w.send(JSON.stringify({ type: "turn_end" }));
  for (let i = 0; i < 50 && turnCalls.length === before; i++) await new Promise((r) => setTimeout(r, 10));
  const call = turnCalls.at(-1);
  assert.equal(call.device.id, "kiosk-truth-es");
  assert.equal(call.displayMissedText, STRINGS.es.display_missed_say);
  assert.equal(call.memoryWhen, wantsMemory, "one function decides both the offer and the forced-call gate");
  const wmTool = call.extraTools.find((x) => x.definition.name === "crow_show");
  assert.equal(wmTool.must("Show me a list of three fruits."), true);
  assert.equal(wmTool.must("Tell me a joke"), false);
  assert.match(wmTool.mustNote, /crow_show/);
  assert.equal(wmTool.missedText, undefined, "crow_show uses the display's own could-not-show line");
  // The round cap leaves room for one retry of a failed display command plus the spoken confirmation.
  assert.ok(call.maxToolRounds >= 3);
  w.close();
});

test("WM1a (wired): a turn that asks for new content gets a context with no titles; a turn that changes the open card gets its words; the bind-time fit counts the same tools the turn offers", async () => {
  const { token } = await store.pairDevice(db(), { id: "kiosk-wm1a", name: "wm1a", device_kind: "kiosk" });
  await store.updateDeviceProfiles(db(), "kiosk-wm1a", { bound_bot_id: "household" });
  const w = new WebSocket(wsUrl(base));
  const msgs = [];
  try {
    await new Promise((r) => w.on("open", r));
    w.on("message", (d, bin) => { if (!bin) msgs.push(JSON.parse(d.toString())); });
    w.send(JSON.stringify({ type: "hello", device_id: "kiosk-wm1a", token, caps: {} }));
    for (let i = 0; i < 50 && !msgs.some((m) => m.type === "ready"); i++) await new Promise((r) => setTimeout(r, 10));
    rt.wm.open("kiosk-wm1a", { kind: "content", title: "Fruits", blocks: [{ type: "heading", text: "Fruits" }, { type: "list", items: ["apple", "pear"] }] });
    const before = turnCalls.length;
    w.send(JSON.stringify({ type: "turn_start", turn_id: "w1" }));
    w.send(Buffer.alloc(8000));
    w.send(JSON.stringify({ type: "turn_end" }));
    for (let i = 0; i < 50 && turnCalls.length === before; i++) await new Promise((r) => setTimeout(r, 10));
    const call = turnCalls.at(-1);
    assert.equal(call.device.id, "kiosk-wm1a");
    assert.match(call.turnContext("Now show me a list of vegetables."), /\[Display\] Open windows: 1 card\.$/);
    assert.match(call.turnContext("What is on that card?"), /content 'Fruits'/);
    assert.match(call.turnContext("Add grapes to the fruits list."), /The card "Fruits" now says: apple; pear\./);
    assert.deepEqual(call.extraTools.map((x) => x.definition.name), ["crow_show", "crow_wm"], "play and open are not offered until they have something to play or open");
    assert.equal(call.extraTools[0].definition.inputSchema.properties.kind.enum.length, 4);
    const [showTool, wmTool] = call.extraTools;
    assert.deepEqual([showTool.when("What is the capital of Portugal?"), wmTool.when("What is the capital of Portugal?")], [true, true], "a plain question with a card up: both display tools are offered (revision 4: a follow-up needs no display word)");
    assert.equal(showTool.must("What is the capital of Portugal?"), false, "and nothing is required");
    assert.equal(showTool.must("Add grapes to the fruits list."), true);
  } finally { rt.wm.closeAll("kiosk-wm1a"); w.close(); }
});

test("turn check (wired): loopback and the announce token only; fixed sentences through the same turn options a display uses, on a fixed display id that does not exist, never escalated; no card → not ok, after three tries", async () => {
  assert.deepEqual(TURN_CHECK.en.length, 3);
  assert.equal(TURN_CHECK_CARD_TRIES, 3);
  const noToken = await fetch(base + "/api/kiosk/internal/turn-check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bot_id: "household" }) });
  assert.equal(noToken.status, 401);
  const before = turnCalls.length;
  const r = await fetch(base + "/api/kiosk/internal/turn-check", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer ann-ok" }, body: JSON.stringify({ bot_id: "household" }) });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.version, JSON.parse(readFileSync(new URL("../bundles/kiosk/manifest.json", import.meta.url), "utf8")).version, "the bundle version from its manifest");
  assert.deepEqual(j.turns.map((t) => t.transcript), [TURN_CHECK.en[0], TURN_CHECK.en[1], TURN_CHECK.en[2], TURN_CHECK.en[2], TURN_CHECK.en[2]]);
  assert.deepEqual([j.ok, j.card_tries], [false, 3], "the stub never puts a card up: not ok, after three tries");
  const calls = turnCalls.slice(before);
  assert.equal(calls.length, 5);
  for (const c of calls) {
    assert.equal(c.device.id, TURN_CHECK_DEVICE);
    assert.equal(c.device.bound_bot_id, "household");
    assert.equal(c.noEscalate, true, "never the router, never a model start");
    assert.equal(c.audio, undefined, "a transcript, never audio");
    assert.deepEqual(c.extraTools.map((x) => x.definition.name), ["crow_show", "crow_wm"]);
    assert.equal(c.familiesOnIntent, true);
    assert.equal(typeof c.fastPaths, "function");
  }
  assert.deepEqual(rt.wm.list(TURN_CHECK_DEVICE), [], "nothing is left behind");
  const bad = await fetch(base + "/api/kiosk/internal/turn-check", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer ann-ok" }, body: "{}" });
  assert.equal(bad.status, 400);
});

test("turn check speaks with a real display's voice, never the instance default (a default voice the gateway cannot run failed every line)", async () => {
  await store.pairDevice(db(), { id: "kiosk-tc-a", name: "tc a", device_kind: "kiosk" });
  await store.updateDeviceProfiles(db(), "kiosk-tc-a", { bound_bot_id: "tc-other", tts_profile_id: "voice-other" });
  await store.pairDevice(db(), { id: "kiosk-tc-b", name: "tc b", device_kind: "kiosk" });
  await store.updateDeviceProfiles(db(), "kiosk-tc-b", { bound_bot_id: "tc-bot", tts_profile_id: "voice-bound" });
  try {
    const call = async (bot) => {
      const before = turnCalls.length;
      const j = await (await fetch(base + "/api/kiosk/internal/turn-check", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer ann-ok" }, body: JSON.stringify({ bot_id: bot }) })).json();
      const voices = new Set(turnCalls.slice(before).map((c) => c.device.tts_profile_id));
      assert.equal(voices.size, 1, "one voice for every line of the check");
      assert.equal(j.tts_profile_id, [...voices][0], "and the response says which");
      return j.tts_profile_id;
    };
    assert.equal(await call("tc-bot"), "voice-bound", "the voice of the display bound to this assistant");
    const fallback = await call("tc-nobody");
    assert.ok(fallback, "no display bound to it: a paired display's voice, not the default");
    const paired = (await store.listDevices(db())).filter((d) => d.device_kind === "kiosk" && d.tts_profile_id).map((d) => d.tts_profile_id);
    assert.ok(paired.includes(fallback));
  } finally {
    await store.unpairDevice(db(), "kiosk-tc-a");
    await store.unpairDevice(db(), "kiosk-tc-b");
  }
});

test("turn check: ok only when the clock took the no-model path, the plain question had no tools, and the card is really on the screen (a truthful could-not is NOT a pass)", async () => {
  const mk = (cardOn) => {
    const runs = [];
    const voice = {
      convo: { save: (id, m) => runs.push(`convo:${id}:${m.length}`) },
      runVoiceTurn: async (o) => {
        runs.push(o.transcript);
        if (o.transcript === TURN_CHECK.en[0]) return { route: "fast", fastPath: true, timings: {} };
        if (o.transcript === TURN_CHECK.en[1]) return { route: "fast", failed: null, timings: { tools_offered: 0 } };
        if (cardOn(runs.filter((x) => x === TURN_CHECK.en[2]).length)) {
          await o.extraTools.find((x) => x.definition.name === "crow_show").execute({ kind: "list", title: "Fruits", body: "apples\nbananas" }, { transcript: o.transcript });
          return { route: "fast", failed: null, timings: { tools: ["crow_show:shown"], tools_offered: 2 } };
        }
        return { route: "fast", failed: "display_missed", timings: { tools: [], tools_offered: 2 } };
      },
      speakText: async () => true,
    };
    return { runs, r: createKioskRuntime(runtimeDeps({ voice })) };
  };
  for (const [cardOn, ok, tries] of [[(n) => n === 1, true, 1], [(n) => n === 3, true, 3], [() => false, false, 3]]) {
    const { runs, r } = mk(cardOn);
    const app = express(); app.use(r.router((req, res, next) => next()));
    const { s, base: b } = await listen(app, r);
    try {
      const res = await fetch(b + "/api/kiosk/internal/turn-check", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer ann-ok" }, body: JSON.stringify({ bot_id: "household" }) });
      const j = await res.json();
      assert.deepEqual([j.ok, j.card_tries], [ok, tries]);
      assert.deepEqual(r.wm.list(TURN_CHECK_DEVICE), [], "the card is cleared after the check");
      assert.equal(runs[0], `convo:${TURN_CHECK_DEVICE}:0`, "the check starts from an empty conversation");
    } finally { s.close(); }
  }
});

test("one set of turn options: the runtime's display turn (and so the turn check) is built by displayTurnOptions, the function the evaluation runs", () => {
  const rt = readFileSync(new URL("../bundles/kiosk/server/runtime.js", import.meta.url), "utf8");
  assert.match(rt, /const turnOptions = \(device, caps, tz, emit\) => displayTurnOptions\(/);
  assert.equal((rt.match(/createDisplayTools\(/g) || []).length, 2, "one in displayTurnOptions, one for the bind-time fit");
});

// ── Display tickets (the stream mount) ───────────────────────────────────────────────────────────
/** A local audio upstream, reached through the real relay the only way a private address can be: as a configured service at exactly this origin. */
async function audioUpstream(handler = (req, res) => { res.writeHead(200, { "content-type": "audio/mpeg", "set-cookie": "x=1" }); res.end("0123456789"); }) {
  const { serviceHop } = await import("../bundles/kiosk/server/relay.js");
  const seen = [], sockets = new Set();
  const s = http.createServer((req, res) => { seen.push({ method: req.method, headers: req.headers }); handler(req, res); });
  s.on("connection", (c) => { sockets.add(c); c.on("close", () => sockets.delete(c)); });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${s.address().port}`;
  return { resource: { url: `${origin}/live`, hop: serviceHop({ origin, path: /^\/live$/ }) }, seen, open: () => sockets.size, close: () => { s.closeAllConnections?.(); s.close(); } };
}
const mintStream = (runtime, resource, deviceId = "kiosk-tk") => runtime.tickets.mint({ deviceId, kind: "stream", resource, ttlMs: 60_000 });

test("ticket mount: Funnel and off-tailnet are refused before the ticket is looked at; an unknown or malformed ticket is 404; a live one streams; a revoked one is 404", async () => {
  const up = await audioUpstream();
  try {
    const t = mintStream(rt, up.resource);
    tailnet = false;
    try { const r = await fetch(base + t.path); assert.deepEqual([r.status, (await r.json()).error], [403, "network_refused"], "a VALID ticket off the tailnet"); } finally { tailnet = true; }
    const fun = await fetch(base + t.path, { headers: { "Tailscale-Funnel-Request": "?1" } });
    assert.deepEqual([fun.status, (await fun.json()).error], [403, "funnel_refused"]);
    assert.equal(up.seen.length, 0, "nothing was fetched for a refused request");
    for (const bad of ["nope", "AAAAAAAAAAAAAAAAAAAAAA", t.id.slice(0, 21), `${t.id}A`, "..%2F..%2Fapi"]) assert.equal((await fetch(`${base}/display/t/${bad}/stream`)).status, 404, bad);
    const ok = await fetch(base + t.path, { headers: { Range: "bytes=0-" } });
    assert.deepEqual([ok.status, ok.headers.get("content-type"), ok.headers.get("cache-control"), ok.headers.get("referrer-policy"), ok.headers.get("set-cookie"), await ok.text()], [200, "audio/mpeg", "no-store", "no-referrer", null, "0123456789"]);
    assert.equal(up.seen[0].headers.range, "bytes=0-");
    assert.equal((await fetch(`${base}/display/t/${t.id}/other`)).status, 404, "a stream ticket is a stream, nothing else");
    rt.tickets.revoke(t.id);
    assert.equal((await fetch(base + t.path)).status, 404);
  } finally { up.close(); }
});

test("ticket mount: only GET — HEAD and the rest are 405 and hold no upstream and no ticket slot; a third request at once on one ticket is 429", async () => {
  let release = [];
  const up = await audioUpstream((req, res) => { res.writeHead(200, { "content-type": "audio/mpeg" }); res.write("x"); release.push(() => res.end()); });
  try {
    const t = mintStream(rt, up.resource);
    for (const method of ["HEAD", "POST", "PUT", "DELETE", "OPTIONS"]) {
      const r = await fetch(base + t.path, { method });
      assert.deepEqual([r.status, r.headers.get("allow")], [405, "GET"], method);
    }
    assert.equal((await fetch(`${base}/display/t/nope/stream`, { method: "HEAD" })).status, 405, "whether or not the ticket exists");
    assert.deepEqual([up.seen.length, rt.tickets.get(t.id).open], [0, 0]);
    const a = await fetch(base + t.path), b = await fetch(base + t.path);
    assert.deepEqual([a.status, b.status, rt.tickets.get(t.id).open], [200, 200, 2]);
    assert.equal((await fetch(base + t.path)).status, 429);
    for (const fn of release) fn();
    await a.text(); await b.text();
    for (let i = 0; i < 100 && rt.tickets.get(t.id).open; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(rt.tickets.get(t.id).open, 0, "a finished request gives its slot back");
    // Revoking the ticket cuts a request that is still open, and frees the upstream.
    release = [];
    const c = await fetch(base + t.path);
    const reader = c.body.getReader();
    await reader.read();
    rt.tickets.revoke(t.id);
    await assert.rejects((async () => { for (;;) { const { done } = await reader.read(); if (done) throw new Error("ended"); } })());
    for (let i = 0; i < 100 && up.open(); i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(up.open(), 0);
  } finally { up.close(); }
});

test("ticket mount: a kiosk device token or a dashboard session adds nothing, and the ticket works on no other route", async () => {
  const up = await audioUpstream();
  try {
    const { token } = await store.pairDevice(db(), { id: "kiosk-tk2", name: "TK", device_kind: "kiosk" });
    assert.equal((await fetch(`${base}/display/t/${token.slice(0, 22)}/stream`, { headers: { Authorization: `Bearer ${token}` } })).status, 404, "a device token is not a ticket");
    assert.equal((await fetch(`${base}/display/t/AAAAAAAAAAAAAAAAAAAAAA/stream`, { headers: { Authorization: `Bearer ${token}`, Cookie: "crow_session=anything" } })).status, 404);
    const t = mintStream(rt, up.resource);
    session = false;
    try {
      assert.equal((await fetch(`${base}/api/kiosk/admin/displays?ticket=${t.id}`)).status, 401);
      assert.equal((await fetch(`${base}/api/kiosk/admin/displays`, { headers: { Authorization: `Bearer ${t.id}` } })).status, 401);
    } finally { session = true; }
    assert.equal((await fetch(`${base}/api/kiosk/internal/displays`, { headers: { Authorization: `Bearer ${t.id}` } })).status, 401);
    // And the ticket needs neither: a request with no credentials at all streams (the path is the credential, behind the network gate).
    assert.equal((await fetch(base + t.path)).status, 200);
  } finally { up.close(); }
});

test("ticket mount: a refused upstream is a 502 with the reason in the log by code only; a request that throws never writes the ticket to the log", async () => {
  const logs = [];
  const boom = createKioskRuntime(runtimeDeps({ log: (l) => logs.push(l), relay: { toResponse: async () => { throw new Error("relay blew up"); } } }));
  const app = express();
  app.use(boom.router((req, res, next) => next()));
  const { s, base: b2 } = await listen(app, boom);
  try {
    const t = mintStream(boom, { url: "https://stream.example.invalid/live", hop: {} });
    const r = await fetch(b2 + t.path);
    assert.equal(r.status, 500);
    assert.deepEqual(logs.filter((l) => l.includes("/display/t/")), ["[kiosk] GET /display/t/…/stream: relay blew up"]);
    assert.ok(!logs.join("\n").includes(t.id), "the ticket id is in no log line");
  } finally { boom.stop(); s.close(); }
  // The real relay, an upstream whose policy does not allow it: 502, one log line with a code, no address in it.
  const logs2 = [];
  const real = createKioskRuntime(runtimeDeps({ log: (l) => logs2.push(l) }));
  const app2 = express();
  app2.use(real.router((req, res, next) => next()));
  const { s: s2, base: b3 } = await listen(app2, real);
  try {
    const { publicHop } = await import("../bundles/kiosk/server/relay.js");
    const url = "http://127.0.0.1:9/live";
    const t = mintStream(real, { url, hop: publicHop(url) });
    const r = await fetch(b3 + t.path);
    assert.deepEqual([r.status, await r.text()], [502, "Upstream unavailable"]);
    // 127.0.0.1 is also one of this host's own addresses, which is said first.
    assert.ok(["[kiosk] stream for kiosk-tk not relayed: private_address", "[kiosk] stream for kiosk-tk not relayed: own_address"].includes(logs2.filter((l) => l.includes("not relayed")).join("|")));
    assert.ok(!logs2.join("\n").includes(t.id) && !logs2.join("\n").includes("127.0.0.1"));
  } finally { real.stop(); s2.close(); }
});

test("the gateway builds the kiosk runtime without a relay of its own: the production relay has no test socket", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../bundles/kiosk/panel/routes.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /relay|createConnection|connect:/, "panel/routes.js passes no relay and no socket override to the runtime");
  const rtSrc = readFileSync(new URL("../bundles/kiosk/server/runtime.js", import.meta.url), "utf8");
  assert.match(rtSrc, /const relay = deps\.relay \|\| createRelay\(\);/, "the default relay is built with no options");
});

test("stations (wired): the panel saves presets behind the dashboard session; an invalid row refuses the whole save; the list is local and reaches the play source at once", async () => {
  session = false;
  try { assert.equal((await j("/api/kiosk/admin/stations")).status, 401); } finally { session = true; }
  assert.deepEqual((await (await j("/api/kiosk/admin/stations")).json()).stations, []);
  const bad = await j("/api/kiosk/admin/stations", { method: "POST", body: JSON.stringify({ stations: [{ name: "Morning Mix", url: "https://stream.example.invalid/mix" }, { name: "Inside", url: "http://192.168.1.20:8000/live" }] }) });
  assert.deepEqual([bad.status, (await bad.json()).error], [400, "invalid_station"], "a private address is never a station");
  assert.equal(settings.get("kiosk_stations"), undefined, "nothing was written");
  for (const url of ["https://user:pw@stream.example.invalid/x", "ftp://stream.example.invalid/x", "http://127.0.0.1/x", "http://[::1]/x", "not a url"]) {
    assert.equal((await j("/api/kiosk/admin/stations", { method: "POST", body: JSON.stringify({ stations: [{ name: "X", url }] }) })).status, 400, url);
  }
  const ok = await j("/api/kiosk/admin/stations", { method: "POST", body: JSON.stringify({ stations: [{ name: "Morning Mix", aliases: ["the mix"], url: "https://stream.example.invalid/mix" }] }) });
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(settings.get("kiosk_stations")), [{ name: "Morning Mix", aliases: ["the mix"], url: "https://stream.example.invalid/mix" }]);
  assert.deepEqual((await (await j("/api/kiosk/admin/stations")).json()).stations.map((s) => s.name), ["Morning Mix"]);
  // The source reads the new list now: the play tool is offered on the next turn.
  const before = turnCalls.length;
  const { ws, msgs } = await connect("kiosk-st1");
  try {
    ws.send(JSON.stringify({ type: "turn_start", turn_id: "t-st" }));
    ws.send(Buffer.alloc(16000));
    ws.send(JSON.stringify({ type: "turn_end", turn_id: "t-st" }));
    for (let i = 0; i < 100 && turnCalls.length === before; i++) await new Promise((r) => setTimeout(r, 10));
    const o = turnCalls.at(-1);
    assert.ok(o.extraTools.some((t) => t.definition.name === "crow_play"), "crow_play is offered once a station exists");
    const play = o.extraTools.find((t) => t.definition.name === "crow_play");
    assert.match(JSON.stringify(play.definition), /"radio"/);
    // The model's call plays the station: the page is told to load a ticket path, never the address.
    const r = JSON.parse(await play.execute({ what: "the mix" }, { transcript: "play the mix" }));
    assert.deepEqual([r.ok, r.outcome, r.say], [true, "playing", "Playing Morning Mix."]);
    for (let i = 0; i < 50 && !msgs.some((m) => m.type === "media" && m.action === "load"); i++) await new Promise((r2) => setTimeout(r2, 10));
    const load = msgs.find((m) => m.type === "media" && m.action === "load");
    assert.match(load.url, /^\/display\/t\/[A-Za-z0-9_-]{22}\/stream$/);
    assert.ok(!JSON.stringify(msgs).includes("example.invalid"));
    assert.match(o.turnContext("what is this"), /Playing: Morning Mix \(radio\)\./);
  } finally { ws.close(); }
  await j("/api/kiosk/admin/stations", { method: "POST", body: JSON.stringify({ stations: [] }) });
});

test("stations (wired): Test probes response headers only and refuses a private address before any request", async () => {
  const r = await j("/api/kiosk/admin/stations/test", { method: "POST", body: JSON.stringify({ url: "http://127.0.0.1:9/live" }) });
  assert.deepEqual(await r.json(), { ok: false, error: "private_address" });
  assert.deepEqual(await (await j("/api/kiosk/admin/stations/test", { method: "POST", body: JSON.stringify({ url: "javascript:alert(1)" }) })).json(), { ok: false, error: "bad_url" });
});

test("media (wired): unpairing a display ends its stream and revokes its tickets; a failed stream is said once in the display's language", async () => {
  await j("/api/kiosk/admin/stations", { method: "POST", body: JSON.stringify({ stations: [{ name: "Morning Mix", url: "https://stream.example.invalid/mix" }] }) });
  const { ws, msgs } = await connect("kiosk-st2");
  try {
    const before = speakCalls.length;
    const item = rt.media.play("kiosk-st2", [{ title: "Morning Mix", source: "radio", upstream: { url: "https://stream.example.invalid/mix", hop: {} } }]);
    assert.ok(item && rt.tickets.size() >= 1);
    rt.media.onEvent("kiosk-st2", { id: item.id, state: "error", code: "load_failed" });
    for (let i = 0; i < 50 && speakCalls.length === before; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(speakCalls.at(-1).text, "I couldn't play Morning Mix.");
    assert.equal(rt.media.active("kiosk-st2"), false);
    const again = rt.media.play("kiosk-st2", [{ title: "Morning Mix", source: "radio", upstream: { url: "https://stream.example.invalid/mix", hop: {} } }]);
    const loads = () => msgs.filter((m) => m.type === "media" && m.action === "load");
    for (let i = 0; i < 50 && loads().length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    const path = loads().at(-1).url;
    assert.equal((await j("/api/kiosk/admin/displays/kiosk-st2", { method: "DELETE" })).status, 200);
    assert.equal(rt.media.active("kiosk-st2"), false);
    assert.equal((await fetch(base + path)).status, 404, "the ticket died with the display");
    assert.ok(again);
  } finally { ws.close(); }
  await j("/api/kiosk/admin/stations", { method: "POST", body: JSON.stringify({ stations: [] }) });
});

test("turn check with something to play (WM1b): a fourth sentence names the first station and must start it with no model; the session is gone after the check; a play that does not start fails the check", async () => {
  const st = JSON.stringify([{ name: "Morning Mix", aliases: [], url: "https://stream.example.invalid/mix" }]);
  for (const [starts, ok] of [[true, true], [false, false]]) {
    const local = new Map(settings);
    local.set("kiosk_stations", st);
    const seen = [];
    const voice = {
      convo: { save: () => {} },
      runVoiceTurn: async (o) => {
        seen.push(o.transcript);
        if (o.transcript === TURN_CHECK.en[0]) return { route: "fast", fastPath: true, timings: {} };
        if (o.transcript === TURN_CHECK.en[1]) return { route: "fast", failed: null, timings: { tools_offered: 0 } };
        if (o.transcript === TURN_CHECK.en[2]) { await o.extraTools.find((x) => x.definition.name === "crow_show").execute({ kind: "list", title: "Fruits", body: "apples\nbananas" }, { transcript: o.transcript }); return { route: "fast", failed: null, timings: { tools: ["crow_show:shown"] } }; }
        // The play sentence: the real fast paths (T1 against the station source), as the voice turn would run them.
        const fp = starts ? await o.fastPaths(o.transcript) : null;
        return { route: "fast", fastPath: !!fp, failed: null, timings: {} };
      },
      speakText: async () => true,
    };
    const r = createKioskRuntime(runtimeDeps({ voice, settings: { readSetting: async (d, k) => local.get(k) ?? null, writeSetting: async (d, k, v) => { local.set(k, v); } } }));
    await r.stationsReady;
    const app = express(); app.use(r.router((req, res, next) => next()));
    const { s, base: b } = await listen(app, r);
    try {
      const j = await (await fetch(b + "/api/kiosk/internal/turn-check", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer ann-ok" }, body: JSON.stringify({ bot_id: "household" }) })).json();
      assert.equal(seen.at(-1), "Play Morning Mix.");
      assert.deepEqual([j.ok, j.turns.length, j.card_tries], [ok, 4, 1]);
      assert.equal(r.media.active(TURN_CHECK_DEVICE), false, "the check leaves no media session");
      assert.equal(r.tickets.size(), 0, "and no ticket");
    } finally { r.stop(); s.close(); }
  }
});

test("stations (wired): a home-network station needs the operator's tick (dashboard session + CSRF route); the server checks it before storing and records the address set; loopback, link-local, containers and this host are refused even with it", async () => {
  const { createRelay, readHostNetwork } = await import("../bundles/kiosk/server/relay.js");
  // An injected host: eth0 (the default route) is 192.168.1.0/24, docker0 is a bridge.
  const network = () => readHostNetwork({ interfaces: () => ({ eth0: [{ address: "192.168.1.2", cidr: "192.168.1.2/24" }], docker0: [{ address: "172.17.0.1", cidr: "172.17.0.1/16" }] }), defaults: () => new Set(["eth0"]) });
  const names = { "radio.lan.example.invalid": "192.168.1.30", "box.example.invalid": "172.17.0.5" };
  const relay = createRelay({ network, lookup: async (h) => { if (!names[h]) throw new Error("ENOTFOUND"); return [{ address: names[h], family: 4 }]; } });
  const local = new Map(settings);
  const r = createKioskRuntime(runtimeDeps({ relay, settings: { readSetting: async (d, k) => local.get(k) ?? null, writeSetting: async (d, k, v) => { local.set(k, v); } } }));
  let authed = true;
  const app = express(); app.use(r.router((req, res, next) => (authed ? next() : res.status(401).json({ error: "login" }))));
  const { s: srv, base: b } = await listen(app, r);
  const post = (path, body) => fetch(b + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    authed = false;
    assert.equal((await post("/api/kiosk/admin/stations", { stations: [{ name: "Shed", url: "http://192.168.1.20:8000/live", local: true }] })).status, 401);
    authed = true;
    assert.equal((await post("/api/kiosk/admin/stations", { stations: [{ name: "Shed", url: "http://192.168.1.20:8000/live" }] })).status, 400, "no tick: refused");
    for (const [url, reason] of [["http://127.0.0.1:8000/live", "own_address"], ["http://169.254.169.254/latest/", "private_address"], ["http://[fe80::1]/live", "private_address"],
      ["http://172.17.0.5:9000/live", "private_address"], ["http://box.example.invalid/live", "private_address"], ["http://192.168.1.2:3001/live", "own_address"], ["http://10.9.9.9/live", "private_address"]]) {
      const res = await post("/api/kiosk/admin/stations", { stations: [{ name: "X", url, local: true }] });
      assert.equal(res.status, 400, url);
      const j = await res.json();
      assert.deepEqual([j.error, j.station], ["local_check_failed", "X"], url);
      assert.ok([reason, "own_address", "private_address"].includes(j.reason), `${url}: ${j.reason}`);
    }
    // A client-sent address set is never trusted: the server records what IT resolved.
    const ok = await post("/api/kiosk/admin/stations", { stations: [{ name: "Shed", url: "http://192.168.1.20:8000/live", local: true, addrs: ["10.9.9.9"] }, { name: "Den", url: "http://radio.lan.example.invalid:8000/live", local: true }, { name: "Peer", url: "http://100.64.20.7:8000/live", local: true }] });
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(local.get("kiosk_stations")).map((x) => [x.name, x.local, x.addrs]), [["Shed", true, ["192.168.1.20"]], ["Den", true, ["192.168.1.30"]], ["Peer", true, ["100.64.20.7"]]]);
    // Test with the tick runs the same check before any request.
    assert.deepEqual(await (await post("/api/kiosk/admin/stations/test", { url: "http://172.17.0.5:9000/live", local: true })).json(), { ok: false, error: "private_address" });
  } finally { r.stop(); srv.close(); }
});

const PHONE_CAPS = { v: 2, screen: { w: 412, h: 915, touch: true }, audio: { out: true, in: true }, max_windows: 4, kinds: ["card", "timer", "nowplaying"], mobile: true, pointer: "coarse", platform: "Linux armv81" };
const waitFor = async (pred) => { for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 10)); return pred(); };

test("smoke F3/F6 (wired): a phone's display_config says pause while listening and release the mic after each turn; an audio-first display neither; an operator's stored choice wins", async () => {
  const phone = await connect("kiosk-f3-phone", PHONE_CAPS);
  const bare = await connect("kiosk-f3-bare", {});
  try {
    const cfg = (m) => m.msgs.find((x) => x.type === "ready").display_config;
    assert.deepEqual([cfg(phone).pause_media_on_listen, cfg(phone).mic_per_turn], [true, true]);
    assert.deepEqual([cfg(bare).pause_media_on_listen, cfg(bare).mic_per_turn], [false, false]);
    const row = await store.findDevice(db(), "kiosk-f3-phone");
    assert.equal(Object.hasOwn(row.kiosk_settings, "pause_media_on_listen"), false, "the default is never written");
  } finally { phone.ws.close(); bare.ws.close(); }
  const { audioPolicy } = await import("../bundles/kiosk/server/caps.js");
  assert.deepEqual(audioPolicy({ profile: "phone", pause_media_on_listen: false }, PHONE_CAPS), { pause_media_on_listen: false, mic_per_turn: true });
  // Review M4: an iPhone keeps the open mic until an iPhone smoke row passes (pause-while-listening still applies).
  assert.deepEqual(audioPolicy({ profile: "phone" }, { ...PHONE_CAPS, platform: "iPhone" }), { pause_media_on_listen: true, mic_per_turn: false });
  assert.deepEqual(audioPolicy({ profile: "phone" }, null), { pause_media_on_listen: true, mic_per_turn: false }, "no platform reported: the mic stays open");
  assert.deepEqual(audioPolicy({ profile: "pi3" }, PHONE_CAPS), { pause_media_on_listen: false, mic_per_turn: false }, "a stored type wins over the page's guess");
  assert.deepEqual(audioPolicy({}, PHONE_CAPS), { pause_media_on_listen: true, mic_per_turn: true }, "no stored type (a session display): the page's guess");
  assert.deepEqual(audioPolicy({ profile: "desktop", pause_media_on_listen: true }, null), { pause_media_on_listen: true, mic_per_turn: false });
});

test("smoke F8 (wired): playback starting opens the now-playing window on a display with a screen (after the load), once; the chip's tap brings it forward; an audio-first display gets none", async () => {
  const phone = await connect("kiosk-f8-phone", PHONE_CAPS);
  const bare = await connect("kiosk-f8-bare", {});
  const item = (t) => [{ title: t, source: "radio", upstream: { url: "https://stream.example.invalid/mix", hop: {} } }];
  try {
    rt.media.play("kiosk-f8-phone", item("Morning Mix"));
    rt.media.play("kiosk-f8-bare", item("Morning Mix"));
    const npOpen = (m) => m.msgs.findIndex((x) => x.type === "wm" && x.action === "open" && x.window?.kind === "nowplaying");
    assert.ok(await waitFor(() => npOpen(phone) >= 0), "the window opened");
    const load = phone.msgs.findIndex((x) => x.type === "media" && x.action === "load");
    assert.ok(load >= 0 && load < npOpen(phone), "the load comes first (the effect time is the audio, not the window)");
    rt.media.play("kiosk-f8-phone", item("Evening Mix"));
    await waitFor(() => phone.msgs.filter((x) => x.type === "media" && x.action === "load").length >= 2);
    assert.equal(phone.msgs.filter((x) => x.type === "wm" && x.action === "open").length, 1, "one window, reused");
    phone.ws.send(JSON.stringify({ type: "wm_event", kind: "nowplaying" }));
    assert.ok(await waitFor(() => phone.msgs.some((x) => x.type === "wm" && x.action === "focus")), "the chip's tap brings it forward");
    assert.equal(bare.msgs.some((x) => x.type === "wm" && x.action === "open"), false, "an audio-first display: the chip only");
  } finally { rt.media.closeDevice("kiosk-f8-phone"); rt.media.closeDevice("kiosk-f8-bare"); phone.ws.close(); bare.ws.close(); }
});

test("review L1 (wired): the station names reach the STT prompt of every display turn — except on a Spanish display whose STT profile leaves the language to detection", async () => {
  await j("/api/kiosk/admin/stations", { method: "POST", body: JSON.stringify({ stations: [{ name: "Morning Mix", aliases: ["the mix"], url: "https://stream.example.invalid/mix" }] }) });
  const turn = async (id, settings) => {
    const { token } = await store.pairDevice(db(), { id, name: id, device_kind: "kiosk" });
    await store.updateDeviceProfiles(db(), id, { bound_bot_id: "household", ...(settings ? { kiosk_settings: settings } : {}) });
    const ws = new WebSocket(wsUrl(base));
    const msgs = [];
    await new Promise((r) => ws.on("open", r));
    ws.on("message", (d, bin) => { if (!bin) msgs.push(JSON.parse(d.toString())); });
    ws.send(JSON.stringify({ type: "hello", device_id: id, token, caps: {} }));
    for (let i = 0; i < 50 && !msgs.some((m) => m.type === "ready"); i++) await new Promise((r) => setTimeout(r, 10));
    const before = turnCalls.length;
    ws.send(JSON.stringify({ type: "turn_start", turn_id: `${id}-t` }));
    ws.send(Buffer.alloc(8000));
    ws.send(JSON.stringify({ type: "turn_end" }));
    for (let i = 0; i < 50 && turnCalls.length === before; i++) await new Promise((r) => setTimeout(r, 10));
    ws.close();
    return turnCalls.at(-1);
  };
  try {
    const en = await turn("kiosk-l1-en");
    assert.equal(en.sttPrompt({ language: null }), "Morning Mix, the mix");
    const es = await turn("kiosk-l1-es", { lang: "es" });
    assert.equal(es.device.kiosk_settings.lang, "es");
    assert.equal(es.sttPrompt({ language: null }), "", "a Spanish display, language left to detection: no English prompt");
    assert.equal(es.sttPrompt({ language: "en" }), "Morning Mix, the mix", "a profile that pins the language is safe");
  } finally { await j("/api/kiosk/admin/stations", { method: "POST", body: JSON.stringify({ stations: [] }) }); }
});
