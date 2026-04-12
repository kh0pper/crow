/**
 * Meta Glasses Panel — REST API + /session WebSocket.
 *
 * REST (Express, dashboardAuth-gated under /api/meta-glasses):
 *   GET    /api/meta-glasses/devices            — list paired devices (no tokens)
 *   POST   /api/meta-glasses/pair               — pair a device, returns { device, token }
 *   DELETE /api/meta-glasses/devices/:id        — unpair a device
 *   POST   /api/meta-glasses/devices/:id        — update per-device overrides
 *   POST   /api/meta-glasses/say                — queue text for TTS broadcast
 *   POST   /api/meta-glasses/debug/voice-turn   — simulate a voice turn from a prompt
 *
 * WebSocket (no Express middleware — token-authed at upgrade):
 *   wss://.../api/meta-glasses/session?device_id=X
 *     Authorization: Bearer <token>
 *
 * Protocol envelope (per plan §WebSocket protocol):
 *   client→server text:   { type: hello | turn_start | turn_end }
 *   client→server binary: Opus frames (20ms, 16 kHz mono) during a turn
 *   server→client text:   { type: ready | transcript_partial | transcript_final |
 *                           llm_delta | tts_start | tts_end | error }
 *   server→client binary: TTS audio chunks per tts_start codec
 */

import { Router } from "express";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { WebSocketServer } from "ws";

/* ---------- Bundle path resolution ---------- */

function resolveBundleServer() {
  const installed = join(homedir(), ".crow", "bundles", "meta-glasses", "server");
  if (existsSync(installed)) return installed;
  return join(import.meta.dirname, "..", "server");
}
const serverDir = resolveBundleServer();

function resolveGatewayDir() {
  const fromBundle = join(import.meta.dirname, "..", "..", "..", "servers", "gateway");
  if (existsSync(join(fromBundle, "ai", "tts", "index.js"))) return fromBundle;
  const fromHome = join(homedir(), "crow", "servers", "gateway");
  if (existsSync(join(fromHome, "ai", "tts", "index.js"))) return fromHome;
  throw new Error("Cannot locate Crow gateway directory from meta-glasses bundle.");
}
const gatewayDir = resolveGatewayDir();

async function loadDeviceStore() { return import(pathToFileURL(join(serverDir, "device-store.js")).href); }
async function loadTts()         { return import(pathToFileURL(join(gatewayDir, "ai/tts/index.js")).href); }
async function loadStt()         { return import(pathToFileURL(join(gatewayDir, "ai/stt/index.js")).href); }
async function loadProvider()    { return import(pathToFileURL(join(gatewayDir, "ai/provider.js")).href); }
async function loadDb()          { return import(pathToFileURL(join(gatewayDir, "..", "db.js")).href); }

/* ---------- Shared session state ---------- */

const _sessions = new Map();

function sendText(ws, obj) {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify(obj));
}
function sendBinary(ws, chunk) {
  if (ws.readyState !== 1) return;
  ws.send(chunk);
}

/* ---------- Voice-turn pipeline ---------- */

async function runVoiceTurn(ws, device, audioBuffer, options = {}) {
  const db = (await loadDb()).createDbClient();
  try {
    const { getDefaultSttProfile, createSttAdapter, getSttProfiles } = await loadStt();
    const { getTtsProfiles, createTtsAdapter, getDefaultTtsProfile } = await loadTts();
    const { createAdapterFromProfile, getAiProfiles } = await loadProvider();

    // 1. STT
    const sttProfile = device.stt_profile_id
      ? (await getSttProfiles(db, { includeKeys: true })).find(p => p.id === device.stt_profile_id)
      : await getDefaultSttProfile(db, { includeKeys: true });
    if (!sttProfile) {
      sendText(ws, { type: "error", code: "no_stt_profile", recoverable: false });
      return;
    }
    const { adapter: sttAdapter } = await createSttAdapter(sttProfile);
    const stt = await sttAdapter.transcribe(audioBuffer, {
      filename: options.filename || "turn.opus",
      contentType: options.contentType || "audio/ogg;codecs=opus",
    });
    const transcript = (stt.text || "").trim();
    sendText(ws, { type: "transcript_final", text: transcript, language: stt.language });
    if (!transcript) {
      sendText(ws, { type: "error", code: "empty_transcript", recoverable: true });
      return;
    }

    // 2. BYOAI chat
    const aiProfiles = await getAiProfiles(db, { includeKeys: true });
    const slugOf = (n) => n.toLowerCase().replace(/\s+/g, "_").replace(/\./g, "_");
    const aiProfile = device.ai_profile_slug
      ? aiProfiles.find(p => slugOf(p.name) === device.ai_profile_slug)
      : aiProfiles[0];
    if (!aiProfile) {
      sendText(ws, { type: "error", code: "no_ai_profile", recoverable: false });
      return;
    }
    const { adapter: chatAdapter } = await createAdapterFromProfile(aiProfile, aiProfile.defaultModel);

    // 3. TTS
    const ttsProfile = device.tts_profile_id
      ? (await getTtsProfiles(db, { includeKeys: true })).find(p => p.id === device.tts_profile_id)
      : await getDefaultTtsProfile(db, { includeKeys: true });
    if (!ttsProfile) {
      sendText(ws, { type: "error", code: "no_tts_profile", recoverable: false });
      return;
    }
    const { adapter: ttsAdapter } = await createTtsAdapter(ttsProfile);

    sendText(ws, { type: "tts_start", codec: "mp3", sample_rate: 24000 });

    let textBuffer = "";
    const SENTENCE_END = /[.!?…。]["')\]]?\s|[\n]/;

    async function flushTts(text) {
      const trimmed = text.trim();
      if (!trimmed) return;
      try {
        for await (const chunk of ttsAdapter.synthesize(trimmed, ttsProfile.defaultVoice, {})) {
          sendBinary(ws, chunk);
        }
      } catch (err) {
        sendText(ws, { type: "error", code: "tts_error", recoverable: true, message: err.message });
      }
    }

    const messages = [{ role: "user", content: transcript }];
    for await (const event of chatAdapter.chatStream(messages, [], { temperature: 0.7, maxTokens: 600 })) {
      if (event.type === "content_delta" && event.text) {
        sendText(ws, { type: "llm_delta", text: event.text });
        textBuffer += event.text;
        while (true) {
          const match = SENTENCE_END.exec(textBuffer);
          if (!match) break;
          const end = match.index + match[0].length;
          const sentence = textBuffer.slice(0, end);
          textBuffer = textBuffer.slice(end);
          await flushTts(sentence);
        }
      }
      if (event.type === "done") break;
    }
    if (textBuffer.trim()) await flushTts(textBuffer);
    sendText(ws, { type: "tts_end" });
  } catch (err) {
    sendText(ws, { type: "error", code: "turn_failed", recoverable: true, message: err.message });
  } finally {
    try { db.close(); } catch {}
  }
}

/* ---------- Express router ---------- */

export default function metaGlassesRouter(dashboardAuth) {
  const router = Router();
  router.use("/api/meta-glasses", dashboardAuth);

  router.get("/api/meta-glasses/devices", async (req, res) => {
    const { createDbClient } = await loadDb();
    const { listDevices } = await loadDeviceStore();
    const db = createDbClient();
    try {
      res.json({ devices: await listDevices(db) });
    } finally {
      db.close();
    }
  });

  router.post("/api/meta-glasses/pair", async (req, res) => {
    const { createDbClient } = await loadDb();
    const { pairDevice } = await loadDeviceStore();
    const { id, name, generation, household_profile, stt_profile_id, ai_profile_slug, tts_profile_id } = req.body || {};
    if (!id || typeof id !== "string" || id.length > 128) {
      return res.status(400).json({ ok: false, error: "id required (string, ≤128 chars)" });
    }
    if (generation && !["gen1", "gen2", "unknown"].includes(generation)) {
      return res.status(400).json({ ok: false, error: "generation must be gen1|gen2|unknown" });
    }
    if (generation === "gen1") {
      return res.status(400).json({
        ok: false,
        error: "Gen 1 (Ray-Ban Stories) is not supported. Only Gen 2 (Ray-Ban Meta) exposes the DAT camera primitives we need.",
      });
    }
    const db = createDbClient();
    try {
      const result = await pairDevice(db, {
        id, name, generation: generation || "unknown",
        household_profile: household_profile || null,
        stt_profile_id: stt_profile_id || null,
        ai_profile_slug: ai_profile_slug || null,
        tts_profile_id: tts_profile_id || null,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    } finally {
      db.close();
    }
  });

  router.delete("/api/meta-glasses/devices/:id", async (req, res) => {
    const { createDbClient } = await loadDb();
    const { unpairDevice } = await loadDeviceStore();
    const db = createDbClient();
    try {
      const result = await unpairDevice(db, req.params.id);
      const sess = _sessions.get(req.params.id);
      if (sess?.ws) { try { sess.ws.close(1000, "device_unpaired"); } catch {} _sessions.delete(req.params.id); }
      res.json({ ok: true, ...result });
    } finally {
      db.close();
    }
  });

  router.post("/api/meta-glasses/devices/:id", async (req, res) => {
    const { createDbClient } = await loadDb();
    const { updateDeviceProfiles } = await loadDeviceStore();
    const db = createDbClient();
    try {
      const updated = await updateDeviceProfiles(db, req.params.id, req.body || {});
      if (!updated) return res.status(404).json({ ok: false, error: "device not found" });
      res.json({ ok: true, device: updated });
    } finally {
      db.close();
    }
  });

  router.post("/api/meta-glasses/say", async (req, res) => {
    const { text, device_id } = req.body || {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ ok: false, error: "text required" });
    }
    const { createDbClient } = await loadDb();
    const { findDevice } = await loadDeviceStore();
    const { getDefaultTtsProfile, createTtsAdapter, getTtsProfiles } = await loadTts();
    const db = createDbClient();
    try {
      const targetIds = device_id ? [device_id] : [..._sessions.keys()];
      let delivered = 0;
      for (const id of targetIds) {
        const sess = _sessions.get(id);
        if (!sess?.ws) continue;
        const devRec = await findDevice(db, id);
        const ttsProfile = devRec?.tts_profile_id
          ? (await getTtsProfiles(db, { includeKeys: true })).find(p => p.id === devRec.tts_profile_id)
          : await getDefaultTtsProfile(db, { includeKeys: true });
        if (!ttsProfile) continue;
        const { adapter } = await createTtsAdapter(ttsProfile);
        sendText(sess.ws, { type: "tts_start", codec: "mp3", sample_rate: 24000 });
        try {
          for await (const chunk of adapter.synthesize(text, ttsProfile.defaultVoice, {})) {
            sendBinary(sess.ws, chunk);
          }
          sendText(sess.ws, { type: "tts_end" });
          delivered++;
        } catch (err) {
          sendText(sess.ws, { type: "error", code: "tts_error", recoverable: true, message: err.message });
        }
      }
      res.json({ ok: true, delivered, targeted: targetIds.length });
    } finally {
      db.close();
    }
  });

  return router;
}

/* ---------- WebSocket upgrade handler ---------- */

/**
 * Attach /api/meta-glasses/session WebSocket handler.
 * Call once at gateway startup with the HTTP server instance.
 */
export function setupWebSocket(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", async (req, socket, head) => {
    const url = req.url || "";
    if (!url.startsWith("/api/meta-glasses/session")) return;

    const params = new URL(url, "http://localhost").searchParams;
    const deviceId = params.get("device_id");
    const auth = req.headers["authorization"] || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : params.get("token");

    if (!deviceId || !token) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    const db = (await loadDb()).createDbClient();
    let device = null;
    try {
      const { verifyToken } = await loadDeviceStore();
      device = await verifyToken(db, deviceId, token);
    } finally { try { db.close(); } catch {} }
    if (!device) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const prior = _sessions.get(deviceId);
      if (prior?.ws && prior.ws !== ws) {
        try { prior.ws.close(1000, "superseded"); } catch {}
      }
      _sessions.set(deviceId, { ws, device, openedAt: Date.now() });

      sendText(ws, { type: "ready", session_id: `${deviceId}:${Date.now()}` });

      let inTurn = false;
      let turnBuffer = [];
      let turnOpts = {};

      let alive = true;
      ws.on("pong", () => { alive = true; });
      const pinger = setInterval(() => {
        if (!alive) { try { ws.terminate(); } catch {} clearInterval(pinger); return; }
        alive = false;
        try { ws.ping(); } catch {}
      }, 15000);

      ws.on("message", (raw, isBinary) => {
        if (isBinary) {
          if (inTurn) turnBuffer.push(raw);
          return;
        }
        let msg;
        try { msg = JSON.parse(raw.toString("utf8")); } catch { return; }
        switch (msg.type) {
          case "hello":
            turnOpts = {
              contentType: msg.codec === "pcm" ? "audio/wav" : "audio/ogg;codecs=opus",
              filename: `turn.${msg.codec === "pcm" ? "wav" : "opus"}`,
            };
            break;
          case "turn_start":
            inTurn = true;
            turnBuffer = [];
            break;
          case "turn_end": {
            if (!inTurn) return;
            inTurn = false;
            const audio = Buffer.concat(turnBuffer);
            turnBuffer = [];
            runVoiceTurn(ws, device, audio, turnOpts).catch((err) => {
              sendText(ws, { type: "error", code: "turn_failed", recoverable: true, message: err.message });
            });
            break;
          }
        }
      });

      ws.on("close", () => {
        clearInterval(pinger);
        if (_sessions.get(deviceId)?.ws === ws) _sessions.delete(deviceId);
      });
      ws.on("error", () => { /* close follows */ });
    });
  });

  return { openSessionCount: () => _sessions.size };
}
