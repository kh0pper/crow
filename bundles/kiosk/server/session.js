/**
 * Kiosk WebSocket session (spec §4.5). Transport-agnostic: `ws` is anything
 * with send/close/readyState and "message"/"close" events. The token lives
 * ONLY in the first frame (hello); the upgrade URL is never read for it.
 */
import { normalizeCaps } from "./wm.js";

export const HELLO_TIMEOUT_MS = 5000;
export const MAX_TURN_BYTES = 1024 * 1024;
export const MIN_TURN_BYTES = 6400;

export function createSessionHub(deps) {
  const sessions = new Map();
  const setT = deps.setTimeout || setTimeout;
  const clearT = deps.clearTimeout || clearTimeout;
  const sendJson = (ws, obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };

  function attach(ws) {
    let device = null;
    let authing = false;
    let caps = normalizeCaps(null);
    let inTurn = false;
    let frames = [];
    let bytes = 0;
    let turnId = null;
    let abort = null;
    let busy = false;
    const pendingSpeech = [];
    const helloTimer = setT(() => { if (!device) ws.close(4401, "hello_timeout"); }, deps.helloTimeoutMs || HELLO_TIMEOUT_MS);
    const state = (bird) => sendJson(ws, { type: "state", bird });
    const self = { ws, get device() { return device; }, get busy() { return busy; }, queueSpeech: (t) => pendingSpeech.push(t), runSpeech, abortTurn: () => abort?.abort() };

    async function runSpeech(text) {
      const sink = { event: (ev) => sendJson(ws, ev), audio: (b) => { if (ws.readyState === 1) ws.send(b); } };
      try { await deps.speak({ device, text, sink }); } catch (err) { deps.log?.(`[kiosk] speak failed: ${err.message}`); }
    }

    async function onHello(msg) {
      authing = true;
      const d = await deps.verifyKiosk(String(msg.device_id || ""), String(msg.token || ""));
      if (!d) { ws.close(4401, "unauthorized"); return; }
      if (ws.readyState !== 1) return;
      clearT(helloTimer);
      device = d;
      caps = normalizeCaps(msg.caps);
      const prior = sessions.get(d.id);
      sessions.set(d.id, self);
      if (prior && prior.ws !== ws) { try { prior.ws.close(4000, "superseded"); } catch {} }
      sendJson(ws, { type: "ready", server_now: (deps.now || Date.now)(), display_config: await deps.displayConfig(d) });
      sendJson(ws, { type: "wm", action: "snapshot", windows: deps.wm.list(d.id) });
      state("idle");
      Promise.resolve().then(() => deps.warmup(d)).catch(() => {});
    }

    async function onTurnEnd() {
      if (!inTurn) return;
      inTurn = false;
      const pcm = Buffer.concat(frames);
      frames = []; bytes = 0;
      if (pcm.length < MIN_TURN_BYTES) { sendJson(ws, { type: "error", code: "empty_transcript", recoverable: true }); state("idle"); return; }
      busy = true;
      abort = new AbortController();
      const my = abort;
      const id = turnId;
      state("thinking");
      const sink = {
        event: (ev) => {
          if (my.signal.aborted) return;
          sendJson(ws, ev);
          if (ev.type === "tts_start") state("speaking");
        },
        audio: (chunk) => { if (!my.signal.aborted && ws.readyState === 1) ws.send(chunk); },
      };
      let r = null;
      try {
        r = await deps.runTurn({ device: sessions.get(device.id)?.device || device, audio: deps.wrapPcmAsWav(pcm, 16000), sink, signal: my.signal, caps });
      } catch (err) {
        deps.log?.(`[kiosk] turn failed: ${err.message}`);
        sendJson(ws, { type: "error", code: "turn_failed", recoverable: true });
      } finally {
        busy = false;
        abort = null;
        const res = { route: r?.route ?? null, fastPath: !!r?.fastPath, escalated: !!r?.escalated, degraded: r?.degraded ?? null, aborted: my.signal.aborted || !!r?.aborted, timings: r?.timings || {} };
        deps.metrics.serverTurn(device.id, id, res);
        sendJson(ws, { type: "turn_done", turn_id: id, route: res.route, fast_path: res.fastPath, escalated: res.escalated, degraded: res.degraded, aborted: res.aborted, timings: res.timings });
        state("idle");
        while (pendingSpeech.length && ws.readyState === 1 && !busy) await runSpeech(pendingSpeech.shift());
      }
    }

    ws.on("message", (raw, isBinary) => {
      if (!device) {
        if (authing) return;
        if (isBinary) { ws.close(4401, "unauthorized"); return; }
        let msg;
        try { msg = JSON.parse(raw.toString("utf8")); } catch { ws.close(4401, "unauthorized"); return; }
        if (msg?.type !== "hello") { ws.close(4401, "unauthorized"); return; }
        onHello(msg).catch(() => ws.close(4401, "unauthorized"));
        return;
      }
      if (isBinary) {
        if (!inTurn) return;
        bytes += raw.length;
        if (bytes > MAX_TURN_BYTES) {
          inTurn = false; frames = []; bytes = 0;
          sendJson(ws, { type: "error", code: "audio_too_long", recoverable: true });
          state("idle");
          return;
        }
        frames.push(Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
        return;
      }
      let msg;
      try { msg = JSON.parse(raw.toString("utf8")); } catch { return; }
      switch (msg?.type) {
        case "turn_start":
          if (busy) { sendJson(ws, { type: "error", code: "turn_busy", recoverable: true }); return; }
          inTurn = true; frames = []; bytes = 0;
          turnId = String(msg.turn_id || `t${(deps.now || Date.now)()}`).slice(0, 64);
          state("listening");
          return;
        case "turn_end":
          onTurnEnd();
          return;
        case "barge_in":
          if (abort) abort.abort();
          return;
        case "wm_event": {
          const id = String(msg.id || "");
          if (msg.kind === "dismissed") { const w = deps.wm.close(device.id, id); if (w) sendJson(ws, { type: "wm", action: "close", id: w.id }); }
          else if (msg.kind === "tapped") deps.wm.focus(device.id, id);
          else if (msg.kind === "close_all") { deps.wm.closeAll(device.id); sendJson(ws, { type: "wm", action: "close_all" }); }   // long-press (spec §8.5)
          return;
        }
        case "turn_metrics": {
          const merged = deps.metrics.clientTurn(device.id, msg);
          // One greppable line per timed turn: the smoke computes the gate from these (Task 13).
          if (merged) deps.log?.(`[kiosk-metrics] ${JSON.stringify({ device: device.id, ...merged })}`);
          return;
        }
        default:
      }
    });
    ws.on("close", () => {
      clearT(helloTimer);
      if (abort) abort.abort();
      if (device && sessions.get(device.id) === self) sessions.delete(device.id);
    });
    ws.on("error", () => {});
  }

  return {
    attach,
    closeDevice(id, code = 4401, reason = "unpaired") {
      // Unpair also drops the device's server-held windows/timers; supersede and network
      // reconnects never reach here, so they keep them (the snapshot restores the timer).
      if (reason === "unpaired") deps.wm.closeAll(id);
      const s = sessions.get(id);
      if (!s) return false;
      sessions.delete(id);
      try { s.ws.close(code, reason); } catch {}
      return true;
    },
    sendTo(id, obj) { const s = sessions.get(id); if (!s || s.ws.readyState !== 1) return false; s.ws.send(JSON.stringify(obj)); return true; },
    speak(id, text) {
      const s = sessions.get(id);
      if (!s || s.ws.readyState !== 1) return false;
      if (s.busy) s.queueSpeech(text); else s.runSpeech(text);
      return true;
    },
    refreshDevice(id, d) { const s = sessions.get(id); if (s && d) Object.assign(s.device, d); },
    isConnected: (id) => sessions.has(id),
    connectedIds: () => [...sessions.keys()],
  };
}
