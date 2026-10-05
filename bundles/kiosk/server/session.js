/**
 * Kiosk WebSocket session (spec §4.5). Transport-agnostic: `ws` is anything
 * with send/close/readyState and "message"/"close" events. The token lives
 * ONLY in the first frame (hello); the upgrade URL is never read for it.
 *
 * attach(ws, opts) — `opts` is given only for a dashboard SESSION display (the
 * caller has already verified the dashboard session on the upgrade request):
 *   authorize(hello) → { device } | { close: { code, reason } } | null
 *       replaces the device-token check; hello's device_id/token are never read.
 *   revalidate() → boolean   asked at every turn_start and by revalidateSessions();
 *       false closes 4401 (the login ended); a throw at a turn closes 1011 (retry).
 *   onClose(device)          the socket closed and was not replaced by a newer one.
 */
import { effectiveCaps } from "./caps.js";
import { validTimeZone } from "./clock.js";

export const HELLO_TIMEOUT_MS = 5000;
export const MAX_TURN_BYTES = 1024 * 1024;
export const MIN_TURN_BYTES = 6400;
/** How long a turn waits for its early transcript before transcribing the audio itself. */
export const EARLY_STT_WAIT_MS = 3000;

export function createSessionHub(deps) {
  const sessions = new Map();
  const setT = deps.setTimeout || setTimeout;
  const clearT = deps.clearTimeout || clearTimeout;
  const sendJson = (ws, obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };

  function attach(ws, opts = {}) {
    let device = null;
    let gone = false;              // closed by us (login ended): frames still in flight are ignored
    let authCheck = null;          // this turn's revalidate() promise (session displays only)
    let authing = false;
    let caps = effectiveCaps(null, null);
    let rawCaps = null;   // what the page reported; kept so a profile change applies without a reconnect
    let tz = null;                 // the page's IANA zone from hello (null = unknown: the server's zone is used)
    let inTurn = false;
    let frames = [];
    let bytes = 0;
    let turnId = null;
    let abort = null;
    let busy = false;
    const pendingSpeech = [];
    let speaking = false;
    let speechAbort = null;
    // Early STT (lever D): {bytes, ctrl, startedAt, promise, done} for the transcription started
    // at the page's speech_pause, over the audio received so far. At most ONE runs at a time:
    // whisper (num_workers 1) cannot cancel a request, so a newer pause while one runs only
    // records `want` and starts when it settles.
    let early = null;
    let earlyWant = null;          // {bytes, n}: the newest pause's snapshot, queued behind a running early STT
    let earlyDiscards = 0;
    let earlyDiscardMs = 0;
    const nowMs = () => (deps.now || Date.now)();
    function dropEarly() { if (early && !early.done) early.ctrl.abort(); early = null; earlyWant = null; }
    /** snap = {bytes, n}: the audio as of the pause (n frames) — a queued restart transcribes THAT slice, never later mid-word audio. */
    function startEarly(snap = { bytes, n: frames.length }) {
      if (!inTurn || !deps.transcribe || snap.bytes < MIN_TURN_BYTES) return;
      if (early && !early.done) { earlyWant = snap; return; }
      if (early && early.bytes >= snap.bytes) return;           // nothing new since the last one
      if (early) { earlyDiscards++; earlyDiscardMs += early.ms || 0; }   // superseded by more speech
      earlyWant = null;
      const e = { bytes: snap.bytes, ctrl: new AbortController(), startedAt: nowMs(), done: false, ms: 0 };
      const audio = deps.wrapPcmAsWav(Buffer.concat(frames.slice(0, snap.n)), 16000);
      e.promise = Promise.resolve()
        .then(() => deps.transcribe({ device, audio, signal: e.ctrl.signal }))
        .then((r) => ({ text: String(r?.text || "").trim(), ms: nowMs() - e.startedAt }), (err) => ({ error: err, ms: nowMs() - e.startedAt }))
        .then((r) => { e.done = true; e.ms = r.ms; if (early === e && earlyWant && inTurn) startEarly(earlyWant); return r; });
      early = e;
    }
    const helloTimer = setT(() => { if (!device) ws.close(4401, "hello_timeout"); }, deps.helloTimeoutMs || HELLO_TIMEOUT_MS);
    const state = (bird) => sendJson(ws, { type: "state", bird });
    const self = { ws, get device() { return device; }, get busy() { return busy || speaking || inTurn; }, queueSpeech: (t) => { pendingSpeech.push(t); drainSpeech(); }, runSpeech: (t) => { pendingSpeech.push(t); drainSpeech(); }, abortTurn: () => abort?.abort(), recap: () => { caps = effectiveCaps(rawCaps, device?.kiosk_settings?.profile); } };

    /**
     * Session displays: is the dashboard login still live? An ended login closes the socket (4401).
     * A check that FAILS (the session store could not be read) fails closed for a turn — 1011, the
     * page reconnects and is verified again at the upgrade — but the idle sweep just tries later.
     */
    async function stillAuthorized(forTurn = true) {
      if (!opts.revalidate) return true;
      let ok = false;
      try { ok = (await opts.revalidate()) === true; }
      catch (err) {
        deps.log?.(`[kiosk] session check failed: ${err?.message}`);
        if (forTurn) { gone = true; ws.close(1011, "server_error"); }
        return false;
      }
      if (!ok) { gone = true; ws.close(4401, "unauthorized"); }
      return ok;
    }
    if (opts.revalidate) self.revalidate = () => stillAuthorized(false);

    // Speech (timer/announce) is serialized: one at a time, never during a turn,
    // with its own abort (barge_in / turn_start / close) and an abort-gated sink.
    async function drainSpeech() {
      if (speaking) return;
      while (pendingSpeech.length && ws.readyState === 1 && !busy && !inTurn) {
        const text = pendingSpeech.shift();
        speaking = true;
        const my = (speechAbort = new AbortController());
        const sink = {
          event: (ev) => { if (!my.signal.aborted) sendJson(ws, ev); },
          audio: (b) => { if (!my.signal.aborted && ws.readyState === 1) ws.send(b); },
        };
        try { await deps.speak({ device, text, sink, signal: my.signal }); } catch (err) { deps.log?.(`[kiosk] speak failed: ${err.message}`); }
        finally { speaking = false; if (speechAbort === my) speechAbort = null; }
      }
    }

    /** `ready` carries display_config; re-sent after a panel save (the page tolerates repeats). */
    async function sendReady() {
      const cfg = await deps.displayConfig(device);
      sendJson(ws, { type: "ready", server_now: (deps.now || Date.now)(), display_config: cfg });
    }
    self.pushReady = sendReady;

    async function onHello(msg) {
      authing = true;
      let d;
      try {
        if (opts.authorize) {
          const r = await opts.authorize(msg);
          if (r?.close) { ws.close(r.close.code, r.close.reason); return; }
          d = r?.device || null;
        } else d = await deps.verifyKiosk(String(msg.device_id || ""), String(msg.token || ""));
      }
      catch (err) { authing = false; deps.log?.(`[kiosk] hello verify failed: ${err.message}`); ws.close(1011, "server_error"); return; }
      if (!d) { ws.close(4401, "unauthorized"); return; }
      if (ws.readyState !== 1) return;
      clearT(helloTimer);
      device = d;
      rawCaps = msg.caps;
      caps = effectiveCaps(rawCaps, d.kiosk_settings?.profile);
      tz = validTimeZone(msg.tz);
      const prior = sessions.get(d.id);
      sessions.set(d.id, self);
      if (prior && prior.ws !== ws) { try { prior.ws.close(4000, "superseded"); } catch {} }
      try {
        await sendReady();
        sendJson(ws, { type: "wm", action: "snapshot", windows: deps.wm.list(d.id) });
      } catch (err) { deps.log?.(`[kiosk] hello setup failed: ${err.message}`); ws.close(1011, "server_error"); return; }
      state("idle");
      Promise.resolve().then(() => deps.warmup(d)).catch(() => {});
    }

    async function onTurnEnd(msg) {
      if (!inTurn) return;
      const turnStartedAt = nowMs();
      // An early transcription is usable only when no voiced frame arrived after its snapshot
      // (the page reports how many bytes it had sent at its last voiced frame).
      const voiced = Number(msg?.voiced_bytes);
      const usable = early && msg?.vad_reason === "silence" && Number.isFinite(voiced) && early.bytes >= voiced ? early : null;
      if (early && !usable) { earlyDiscards++; earlyDiscardMs += early.ms || 0; }
      if (!usable) dropEarly();
      const discards = earlyDiscards, discardMs = earlyDiscardMs;
      early = null; earlyWant = null; earlyDiscards = 0; earlyDiscardMs = 0;
      inTurn = false;
      const pcm = Buffer.concat(frames);
      frames = []; bytes = 0;
      // Nothing said (the page's no-speech timeout): never send room noise to STT —
      // whisper turns it into "Thank you." and a ghost reply. Same path as < 200 ms.
      if (msg?.vad_reason === "no_speech" || pcm.length < MIN_TURN_BYTES) { deps.log?.(`[kiosk] empty turn on ${device.id} (${msg?.vad_reason === "no_speech" ? "no speech" : `${pcm.length} bytes`}): caption only`); sendJson(ws, { type: "error", code: "empty_transcript", recoverable: true }); state("idle"); drainSpeech(); return; }
      busy = true;
      if (authCheck) {
        // The login was re-checked when this turn started; nothing runs for a session that ended.
        const ok = await authCheck;
        authCheck = null;
        if (!ok || ws.readyState !== 1) { busy = false; if (usable) usable.ctrl.abort(); return; }
      }
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
        let transcript = null, sttEarly = null;
        if (usable) {
          // A barge-in / close cancels the early request with the turn; a wedged whisper is capped.
          my.signal.addEventListener("abort", () => usable.ctrl.abort(), { once: true });
          const setT2 = deps.setTimeout || setTimeout, clearT2 = deps.clearTimeout || clearTimeout;
          let cap = null;
          const er = await Promise.race([
            usable.promise,
            new Promise((res) => { if (my.signal.aborted) res({ error: new Error("aborted") }); else my.signal.addEventListener("abort", () => res({ error: new Error("aborted") }), { once: true }); }),
            new Promise((res) => { cap = setT2(() => res({ error: new Error("early STT wait cap"), capped: true }), deps.earlyWaitMs ?? EARLY_STT_WAIT_MS); }),
          ]);
          clearT2(cap);
          if (er.capped) usable.ctrl.abort();
          // An empty early transcript is not trusted (a mid-word snapshot): the full audio is transcribed.
          if (!er.error && er.text && !my.signal.aborted) sttEarly = { used: true, ms: er.ms, discards, discard_ms: discardMs };
          if (sttEarly) transcript = er.text;
          else if (er.error && !my.signal.aborted) deps.log?.(`[kiosk] early STT unusable, transcribing again: ${er.error.message}`);
        }
        if (!sttEarly) sttEarly = { used: false, discards, discard_ms: discardMs };
        if (my.signal.aborted) throw Object.assign(new Error("aborted"), { aborted: true });
        r = await deps.runTurn({ device: sessions.get(device.id)?.device || device, audio: deps.wrapPcmAsWav(pcm, 16000), sink, signal: my.signal, caps, tz, transcript, startedAt: turnStartedAt, sttEarly });
      } catch (err) {
        if (!err?.aborted) {
          deps.log?.(`[kiosk] turn failed: ${err.message}`);
          sendJson(ws, { type: "error", code: "turn_failed", recoverable: true });
        }
      } finally {
        busy = false;
        abort = null;
        const res = { route: r?.route ?? null, fastPath: !!r?.fastPath, escalated: !!r?.escalated, degraded: r?.degraded ?? null, aborted: my.signal.aborted || !!r?.aborted, failed: r ? (r.failed ?? null) : (my.signal.aborted ? null : "error"), timings: r?.timings || {} };
        deps.metrics.serverTurn(device.id, id, res);
        sendJson(ws, { type: "turn_done", turn_id: id, route: res.route, fast_path: res.fastPath, escalated: res.escalated, degraded: res.degraded, aborted: res.aborted, failed: res.failed, timings: res.timings });
        state("idle");
        drainSpeech();
      }
    }

    ws.on("message", (raw, isBinary) => {
      if (gone) return;
      if (!device) {
        if (authing) return;
        if (isBinary) { ws.close(4401, "unauthorized"); return; }
        let msg;
        try { msg = JSON.parse(raw.toString("utf8")); } catch { ws.close(4401, "unauthorized"); return; }
        if (msg?.type !== "hello") { ws.close(4401, "unauthorized"); return; }
        onHello(msg).catch((err) => { deps.log?.(`[kiosk] hello failed: ${err?.message}`); ws.close(1011, "server_error"); });
        return;
      }
      if (isBinary) {
        if (!inTurn) return;
        bytes += raw.length;
        if (bytes > MAX_TURN_BYTES) {
          dropEarly();
          inTurn = false; frames = []; bytes = 0;
          sendJson(ws, { type: "error", code: "audio_too_long", recoverable: true });
          state("idle");
          drainSpeech();   // speech queued while the mic was open must not be stranded
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
          if (speechAbort) speechAbort.abort();
          dropEarly(); earlyDiscards = 0;
          inTurn = true; frames = []; bytes = 0;
          turnId = String(msg.turn_id || `t${(deps.now || Date.now)()}`).slice(0, 64);
          state("listening");
          if (opts.revalidate) authCheck = stillAuthorized();
          return;
        case "speech_pause":
          // A session display transcribes nothing until this turn's login check has passed.
          if (authCheck) { const snap = { bytes, n: frames.length }; authCheck.then((ok) => { if (ok && !gone) startEarly(snap); }); }
          else startEarly();
          return;
        case "turn_end":
          onTurnEnd(msg).catch((err) => deps.log?.(`[kiosk] turn_end failed: ${err?.message}`));
          return;
        case "barge_in":
          if (abort) abort.abort();
          if (speechAbort) speechAbort.abort();
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
      dropEarly();
      if (abort) abort.abort();
      if (speechAbort) speechAbort.abort();
      if (device && sessions.get(device.id) === self) {
        sessions.delete(device.id);
        try { opts.onClose?.(device); } catch (err) { deps.log?.(`[kiosk] close hook failed: ${err?.message}`); }
      }
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
      s.queueSpeech(text);
      return true;
    },
    refreshDevice(id, d) { const s = sessions.get(id); if (s && d) { Object.assign(s.device, d); s.recap?.(); } },
    /** Push a fresh `ready` (display_config) to a live page after its settings change. */
    async pushConfig(id) {
      const s = sessions.get(id);
      if (!s || s.ws.readyState !== 1 || !s.pushReady) return false;
      await s.pushReady();
      return true;
    },
    /** Session displays: close every one whose dashboard login has ended (the runtime's minute sweep). */
    async revalidateSessions() {
      for (const s of [...sessions.values()]) if (s.revalidate) await s.revalidate();
    },
    /** The live session's device row (or null when the display is offline). */
    deviceOf: (id) => sessions.get(id)?.device || null,
    isConnected: (id) => sessions.has(id),
    /** A turn or speech is running on this display (the STT keep-warm skips it). */
    isBusy: (id) => !!sessions.get(id)?.busy,   // turn running, speech playing, or the mic open
    connectedIds: () => [...sessions.keys()],
  };
}
