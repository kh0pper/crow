/**
 * A typed turn through the whole kiosk runtime: the page's `text_turn` frame → `server/session.js` →
 * the runtime's `runTurn` → `deps.voice.runVoiceTurn`, on a paired display (surface "kiosk") and on the
 * dashboard's Talk to Crow overlay (a session display id, surface "phone"). The words arrive as the
 * operator's own: `typed: true`, the typed text as the transcript, NO audio key, and no relay thread.
 * A spoken turn from the same socket carries the same surface.
 *
 * Also here: while voice is off, a line the runtime already captioned itself (`announce()`, which sends
 * its own `{ type: "announce", text }`) is not captioned a second time by the hub, and nothing is
 * synthesized for a page that cannot hear it.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { join } from "node:path";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";
import { createClient } from "@libsql/client";
import * as store from "../servers/shared/device-store.js";
import { createKioskRuntime } from "../bundles/kiosk/server/runtime.js";
import { sessionDisplayId, isSessionDisplayId } from "../bundles/kiosk/server/session-display.js";
import { wrapPcmAsWav } from "../servers/gateway/voice/turn-helpers.js";

const SESSION_TOKEN = "typed-session-token";
const CSRF = "typed-csrf";
const SESSION_WS_PATH = "/api/kiosk/session/dashboard";

let raw, rt, srv, base;
const conns = new Set();
const turnCalls = [];
const speakCalls = [];
const settings = new Map();

const db = () => ({ execute: (q) => raw.execute(q), close() {} });

function deps() {
  return {
    Router: express.Router, json: express.json, WebSocketServer,
    isAllowedNetwork: () => true,
    csrfMiddleware: (req, res, next) => next(),
    // Session mode's three seams, answered here so the overlay's socket needs no dashboard login.
    sessionFromRequest: async () => SESSION_TOKEN,
    verifySession: async () => true,
    csrfTokenAccepted: (req, t) => t === CSRF,
    openDb: db, deviceStore: store,
    settings: { readSetting: async (d, k) => settings.get(k) ?? null, writeSetting: async (d, k, v) => { settings.set(k, v); } },
    voice: {
      runVoiceTurn: async (o) => { turnCalls.push(o); return { route: "fast", timings: {} }; },
      speakText: async (o) => { speakCalls.push(o); return true; },
    },
    crowVoice: { CROW_VOICE_BOT_ID: "crow.voice" },
    sttWarmup: async () => {},
    resolveDisplayBird: async () => ({ species: "crow", seed: 0, mood: "happy", outfit: null, source: "default" }),
    themeCss: () => ":root{--k-sky:#eef1f3}",
    files: { publicDir: new URL("../bundles/kiosk/public/", import.meta.url).pathname, birdSvgPath: new URL("../bundles/ramble/server/bird-svg.cjs", import.meta.url).pathname },
    announceToken: { validate: async () => false },
    helloTimeoutMs: 1000,
    wrapPcmAsWav,
    log: () => {},
  };
}

before(async () => {
  raw = createClient({ url: "file::memory:" });
  await raw.execute("CREATE TABLE dashboard_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)");
  await raw.execute("CREATE TABLE pi_bot_defs (bot_id TEXT PRIMARY KEY, display_name TEXT, definition TEXT, enabled INTEGER)");
  settings.set("stt_profiles", JSON.stringify([{ id: "fw", provider: "fasterwhisper", baseUrl: "http://localhost:8004/v1" }]));
  settings.set("tts_profiles", JSON.stringify([{ id: "kk", provider: "kokoro", name: "Kokoro (local)" }]));
  rt = createKioskRuntime(deps());
  const app = express();
  app.use(rt.router((req, res, next) => next()));
  srv = http.createServer(app);
  rt.attachUpgrade(srv);
  srv.on("connection", (c) => { conns.add(c); c.on("close", () => conns.delete(c)); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${srv.address().port}`;
});

after(() => {
  rt?.stop();
  for (const c of conns) c.destroy();
  srv?.close();
});

const wsUrl = (path) => base.replace("http", "ws") + path;
const until = async (fn, ms = 2000) => { for (let i = 0; i < ms / 10 && !fn(); i++) await new Promise((r) => setTimeout(r, 10)); return fn(); };

function collect(ws) {
  const frames = [];
  ws.on("message", (d, bin) => { if (!bin) frames.push(JSON.parse(d.toString())); });
  return frames;
}

/** A paired kiosk display, token in hello only (the paired socket). */
async function connectPaired(id) {
  const { token } = await store.pairDevice(db(), { id, name: id, device_kind: "kiosk" });
  const ws = new WebSocket(wsUrl("/api/kiosk/session"));
  const frames = collect(ws);
  await new Promise((r, j) => { ws.on("open", r); ws.on("error", j); });
  ws.send(JSON.stringify({ type: "hello", device_id: id, token, caps: {} }));
  assert.ok(await until(() => frames.some((m) => m.type === "ready")), "the paired display is ready");
  return { ws, frames };
}

/** The dashboard's Talk to Crow overlay (a session display, verified by the injected session seams). */
async function connectSession() {
  const ws = new WebSocket(wsUrl(SESSION_WS_PATH), { headers: { Origin: base, Cookie: "crow_session=x" } });
  const frames = collect(ws);
  await new Promise((r, j) => { ws.on("open", r); ws.on("error", j); });
  ws.send(JSON.stringify({ type: "hello", mode: "session", csrf: CSRF, caps: {} }));
  assert.ok(await until(() => frames.some((m) => m.type === "ready")), "the overlay is ready");
  return { ws, frames };
}

/** Send one frame and hand back the deps.voice.runVoiceTurn call it produced. */
async function turn(ws, frames, msg, audio = null) {
  const n = turnCalls.length;
  ws.send(JSON.stringify(msg));
  if (audio) ws.send(audio);
  assert.ok(await until(() => turnCalls.length > n), `the turn ran after ${JSON.stringify(msg)}`);
  assert.ok(await until(() => frames.some((m) => m.type === "turn_done")), "the turn is closed");
  return turnCalls[turnCalls.length - 1];
}

const typedTurn = (ws, frames, text, id = "x1") => turn(ws, frames, { type: "text_turn", turn_id: id, text });
async function spokenTurn(ws, frames, id = "s1") {
  const n = turnCalls.length;
  ws.send(JSON.stringify({ type: "turn_start", turn_id: id }));
  ws.send(Buffer.alloc(8000));
  ws.send(JSON.stringify({ type: "turn_end", vad_reason: "manual" }));
  assert.ok(await until(() => turnCalls.length > n), "the spoken turn ran");
  assert.ok(await until(() => frames.some((m) => m.type === "turn_done")), "the spoken turn is closed");
  return turnCalls[turnCalls.length - 1];
}

test("a typed turn on a paired display reaches the voice turn as the operator's words on the kiosk", async () => {
  const { ws, frames } = await connectPaired("kiosk-type");
  const call = await typedTurn(ws, frames, "what time is it");
  assert.equal(call.surface, "kiosk");
  assert.equal(call.typed, true);
  assert.equal("audio" in call, false, "no audio: the words were typed");
  assert.equal(call.transcript, "what time is it");
  assert.equal(call.relayThreadId, undefined, "the operator's own words, never a relay");
  assert.equal(call.device.id, "kiosk-type");
  ws.close();
});

test("a spoken turn on the same paired display carries the same surface", async () => {
  const { ws, frames } = await connectPaired("kiosk-spoken");
  const call = await spokenTurn(ws, frames);
  assert.equal(call.surface, "kiosk");
  assert.equal(Buffer.isBuffer(call.audio), true, "a spoken turn carries its audio");
  assert.equal(call.typed, undefined);
  ws.close();
});

test("a typed turn on the dashboard overlay reaches the voice turn as phone words", async () => {
  const { ws, frames } = await connectSession();
  const call = await typedTurn(ws, frames, "what time is it");
  assert.equal(isSessionDisplayId(call.device.id), true, "a session display, not a paired one");
  assert.equal(call.device.id, sessionDisplayId(SESSION_TOKEN));
  assert.equal(call.surface, "phone");
  assert.equal(call.typed, true);
  assert.equal("audio" in call, false);
  assert.equal(call.transcript, "what time is it");
  assert.equal(call.relayThreadId, undefined);
  ws.close();
});

test("a spoken turn on the dashboard overlay carries the same surface", async () => {
  const { ws, frames } = await connectSession();
  const call = await spokenTurn(ws, frames);
  assert.equal(call.surface, "phone");
  assert.equal(Buffer.isBuffer(call.audio), true);
  assert.equal(call.typed, undefined);
  ws.close();
});

test("voice off: a line the runtime already captioned is shown once, and nothing is synthesized", async () => {
  const { ws, frames } = await connectPaired("kiosk-announce");
  ws.send(JSON.stringify({ type: "voice_mode", on: false }));
  // A turn_start answered voice_off is when the flag is really set on the socket.
  ws.send(JSON.stringify({ type: "turn_start", turn_id: "probe" }));
  assert.ok(await until(() => frames.some((m) => m.type === "turn_over" && m.reason === "voice_off")), "voice is off");
  const spoken = speakCalls.length;
  const out = await rt.announce("kiosk-announce", { text: "Dinner's ready", speak: true });
  assert.deepEqual(out.delivered, ["kiosk-announce"]);
  assert.ok(await until(() => frames.filter((m) => m.type === "announce").length > 0), "the line is captioned");
  assert.deepEqual(frames.filter((m) => m.type === "announce").map((m) => m.text), ["Dinner's ready"], "one caption, not two");
  assert.equal(speakCalls.length, spoken, "nothing is synthesized for a page that cannot hear it");
  ws.close();
});