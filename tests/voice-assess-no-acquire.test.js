/**
 * "Which bot answers voice" (item 20 PR 3, task 1 + review I4): deciding which
 * assistant answers voice, and how well each one fits the quick voice model,
 * NEVER starts or warms a model. The Kiosk panel's 5 s listing and the Bot
 * Builder's card lines both read GET /api/kiosk/admin/displays, so rendering
 * either page must stay a DB + file read.
 *
 * Built on the REAL gateway voice dependencies (defaultVoiceDeps): only
 * acquire / probeReady / createChatAdapter are wrapped to record and throw,
 * and globalThis.fetch throws for the whole file, so any network hop (a model
 * probe, a warm-up, an orchestrator start) fails the test loudly.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { WebSocketServer } from "ws";
import { createClient } from "@libsql/client";
import * as store from "../servers/shared/device-store.js";
import { createVoiceTurnRunner, defaultVoiceDeps } from "../servers/gateway/voice/turn.js";
import { wrapPcmAsWav } from "../servers/gateway/voice/turn-helpers.js";
import { createKioskRuntime } from "../bundles/kiosk/server/runtime.js";

let raw, rt, srv, base, realFetch;
const calls = { acquire: 0, probeReady: 0, chat: 0, fetch: 0, warm: 0, push: 0 };
const db = () => ({ execute: (q) => raw.execute(q), close() {} });
const settings = new Map();

before(async () => {
  raw = createClient({ url: "file::memory:" });
  await raw.execute("CREATE TABLE dashboard_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)");
  await raw.execute("CREATE TABLE pi_bot_defs (bot_id TEXT PRIMARY KEY, display_name TEXT, definition TEXT, enabled INTEGER)");
  await raw.execute("CREATE TABLE providers (id TEXT PRIMARY KEY, models TEXT)");
  await raw.execute({ sql: "INSERT INTO providers VALUES ('voice-test', ?)", args: [JSON.stringify([{ id: "big", contextLen: 32768 }, { id: "small", contextLen: 2048 }])] });
  const add = (id, name, def) => raw.execute({ sql: "INSERT INTO pi_bot_defs VALUES (?,?,?,1)", args: [id, name, JSON.stringify(def)] });
  await add("v-full", "Full", { system_prompt: "You help.", fast_voice_model: "voice-test/big" });
  await add("v-huge", "Huge", { system_prompt: "P".repeat(40_000), fast_voice_model: "voice-test/small" });
  await add("v-unknown", "Unknown", { system_prompt: "You help.", fast_voice_model: "nowhere/none" });
  await store.pairDevice(db(), { id: "kiosk-nm", name: "Kitchen", device_kind: "kiosk" });
  await store.updateDeviceProfiles(db(), "kiosk-nm", { bound_bot_id: "v-full" });

  realFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls.fetch++; throw new Error("no network while deciding who answers voice"); };

  const real = await defaultVoiceDeps();
  const voice = createVoiceTurnRunner({
    ...real,
    acquire: async () => { calls.acquire++; throw new Error("acquire must not run"); },
    probeReady: async () => { calls.probeReady++; throw new Error("probeReady must not run"); },
    createChatAdapter: async () => { calls.chat++; throw new Error("no chat adapter"); },
  });
  rt = createKioskRuntime({
    Router: express.Router, json: express.json, WebSocketServer,
    isAllowedNetwork: () => true,
    csrfMiddleware: (req, res, next) => next(),
    openDb: db, deviceStore: store,
    settings: { readSetting: async (d, k) => settings.get(k) ?? null, writeSetting: async (d, k, v) => { settings.set(k, v); } },
    voice,
    sttWarmup: async () => { calls.warm++; return true; },
    resolveDisplayBird: async () => ({ species: "crow", seed: 0, mood: "happy", outfit: null, source: "default" }),
    themeCss: () => "",
    files: { publicDir: new URL("../bundles/kiosk/public/", import.meta.url).pathname, birdSvgPath: new URL("../bundles/ramble/server/bird-svg.cjs", import.meta.url).pathname },
    announceToken: { validate: async () => false },
    helloTimeoutMs: 300, wrapPcmAsWav, log: () => {},
  });
  const push = rt.hub.pushConfig.bind(rt.hub);
  rt.hub.pushConfig = async (id) => { calls.push++; return push(id); };
  const app = express();
  app.use(rt.router((req, res, next) => next()));
  srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => { globalThis.fetch = realFetch; rt?.stop(); srv?.close(); });

/** A local request that does not go through the (throwing) global fetch. */
function get(path) {
  return new Promise((resolve, reject) => {
    http.get(base + path, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(body || "{}") }));
    }).on("error", reject);
  });
}

test("assessBot on the real voice deps: full / too-large / unknown context, with no model start, probe, chat adapter or network", async () => {
  const voice = createVoiceTurnRunner({ ...(await defaultVoiceDeps()),
    acquire: async () => { calls.acquire++; throw new Error("x"); },
    probeReady: async () => { calls.probeReady++; throw new Error("x"); },
    createChatAdapter: async () => { calls.chat++; throw new Error("x"); } });
  const before = { ...calls };
  const full = await voice.assessBot({ db: db(), botId: "v-full" });
  const huge = await voice.assessBot({ db: db(), botId: "v-huge" });
  const unknown = await voice.assessBot({ db: db(), botId: "v-unknown" });
  assert.equal(full.level, "full");
  assert.equal(huge.level, "too_large");
  assert.equal(unknown.ctx, null, "no context known for that model");
  assert.deepEqual(calls, before, "nothing that could start or reach a model ran");
});

test("the Kiosk listing (what the Kiosk panel polls and the Bot Builder reads) computes fits and the voice bot without starting, warming or pushing anything", async () => {
  const before = { ...calls };
  const r = await get("/api/kiosk/admin/displays");
  assert.equal(r.status, 200);
  const fit = Object.fromEntries(r.json.bots.map((b) => [b.bot_id, b.fit]));
  assert.deepEqual(fit, { "v-full": "full", "v-huge": "too_large", "v-unknown": null });
  assert.equal(r.json.dashboard_voice.effective_bot_id, "v-full");
  assert.equal(r.json.devices[0].bound_bot_id, "v-full");
  assert.deepEqual(calls, before, "no acquire / probe / chat adapter / fetch / STT warm-up / config push on a listing");
  // twice, as the panel's poll does
  await get("/api/kiosk/admin/displays");
  assert.deepEqual(calls, before);
});

test("control: the spies reach the mechanism — a display save that changes its speech profile warms it and pushes its config", async () => {
  const before = { ...calls };
  const status = await new Promise((resolve, reject) => {
    const req = http.request(base + "/api/kiosk/admin/displays/kiosk-nm", { method: "POST", headers: { "Content-Type": "application/json" } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", reject);
    req.end(JSON.stringify({ stt_profile_id: "stt-other" }));
  });
  assert.equal(status, 200);
  for (let i = 0; i < 20 && calls.warm === before.warm; i++) await new Promise((r) => setImmediate(r));
  assert.equal(calls.warm, before.warm + 1, "the warm-up spy is the one the runtime calls");
  assert.equal(calls.push, before.push + 1, "the push spy is the one the runtime calls");
});
