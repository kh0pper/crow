/**
 * Crow kiosk page: pairing → session → tap-to-talk. Phone-friendly (D8); Pi agent hooks arrive in K2.
 * Session mode (/display/session, inside the dashboard's Talk to Crow overlay): the viewer is already
 * logged in to the dashboard, so there is no pairing and no stored token — the socket is authorised by
 * the dashboard session cookie and hello echoes the CSRF cookie.
 */
import { STRINGS } from "./strings.js";
import {
  closeDecision, backoffMs, micDecision, isNight, themeFor, msToNextMinute,
  displayedBird, tapDecision, followUpDecision, reportDecision, turnMetrics,
  releasesMic, ttsStartDecision, pairStartDecision, bannerAfterReady, createStatusRing, errorDecision, toolsLine,
  duckDecision, duckBackstop, DUCK_BACKSTOP_MS, noteEffect,
} from "./state.js";
import { createVad, TURN_GUARD_MS, VAD_DEFAULTS } from "./vad.js";
import { openMic, createPlayer } from "./audio.js";
import { mountBird } from "./bird-view.js";
import { createWindowView } from "./wm-view.js";
import { createMediaView } from "./media-view.js";

const LS_DEV = "crow.kiosk.device_id";
const LS_TOK = "crow.kiosk.token";
const SESSION = document.documentElement.dataset.mode === "session";
/**
 * Caps v2: what THIS page build can draw and this browser has. The server takes the lesser of this and the display's profile.
 * mobile / pointer / platform only feed the server's guess of the display type for a display nobody has typed yet.
 */
const CAPS = { v: 2, screen: { w: screen.width, h: screen.height, touch: navigator.maxTouchPoints > 0 }, audio: { out: true, in: !!navigator.mediaDevices }, codecs: [], frames: 0, max_windows: 4, input: { wake: false, keyboard: false }, kinds: ["card", "timer", "nowplaying"],
  mobile: navigator.userAgentData ? navigator.userAgentData.mobile === true : /Mobi|Android/i.test(navigator.userAgent), pointer: matchMedia("(pointer: coarse)").matches ? "coarse" : "fine", platform: String(navigator.platform || "").slice(0, 40) };
/** This display's IANA time zone, sent in hello so "what time is it" is answered in local time. */
const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; } })();
const $ = (id) => document.getElementById(id);
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
let lang = (navigator.language || "en").toLowerCase().startsWith("es") ? "es" : "en";
const t = (k) => STRINGS[lang]?.[k] || STRINGS.en?.[k] || "";

let ws = null, attempt = 0, halted = false, config = {}, bird = null, wmView = null, reconnectTimer = null;
let ctx = null, mic = null, player = null, birdState = "idle", serverBird = "idle", turn = null, clockTimer = null, serverOffset = 0;
let ttsSeq = 0, bannerKey = null, pairAttempt = 0;
let mediaView = null, duckSince = null, duckTimer = null, duckOverride = false;

/*
 * Debug ring (smoke 2026-10-04: an unidentified message flashed after silent taps).
 * Every status the page shows — banner, caption, bird state, mic label, wm and
 * socket events — lands in a 20-entry in-memory ring; a long press on the clock
 * shows it. Nothing is sent or stored.
 */
const statuses = createStatusRing(20);
const note = (kind, text) => { statuses.push(kind, text, Date.now()); if (!$("debug").hidden) showDebug(); };
function showDebug() { const d = $("debug"); d.textContent = statuses.format(); d.hidden = false; }
/** Sets the bot caption for a page/system reason (tap hint, error, clear) — fixed strings, so the text is recorded. */
function caption(text, why) { $("cap-bot").textContent = text; note(`caption:${why}`, text); }
function banner(key) { bannerKey = key || null; const b = $("banner"); b.textContent = key ? t(key) : ""; b.hidden = !key; note("banner", key ? `${key}: ${b.textContent}` : "(hidden)"); if (key === "session_no_bot") b.append(" ", kioskPanelLink()); }
/** Session mode: the fix for "no assistant" is one tap away — the Kiosk panel, in the dashboard itself. */
function kioskPanelLink() { const a = document.createElement("a"); a.href = "/dashboard/kiosk"; a.target = "_top"; a.textContent = t("session_bot_link"); return a; }
const cookie = (name) => { for (const c of document.cookie.split(";")) { const [k, ...v] = c.trim().split("="); if (k === name) return v.join("="); } return ""; };
/** Halt / unpaired / page hidden for good: turn the mic off (the phone's indicator); the next tap reopens it. */
function releaseAudio() {
  if (turn && !turn.ended) endTurn("manual", null);
  mediaView?.apply({ action: "stop" });             // the server's media state comes back with the next hello
  try { mic?.close(); } catch {}
  mic = null;
  player?.flush();
  try { ctx?.suspend(); } catch {}
}
function setBird(s) {
  if (s !== birdState) note("bird", `${s} (pill: ${t(s === "listening" ? "mic_stop" : s === "speaking" ? "mic_interrupt" : "mic_talk")})`);
  birdState = s;
  bird?.setState(s);
  $("mic").textContent = t(s === "listening" ? "mic_stop" : s === "speaking" ? "mic_interrupt" : "mic_talk");
}
/** The server's state, held in "speaking" while local audio still plays (ruling F3). */
const renderBird = () => { setBird(displayedBird(serverBird, !!player?.playing)); syncDuck(); };
/**
 * Music is turned down (or paused, with the display's pause_media_on_listen) while a turn is open:
 * the mic, the server's bird, this page's TTS (review C1: never keyed on turn_done). A backstop
 * brings it back after DUCK_BACKSTOP_MS with the bird idle and no TTS, whatever the page thinks.
 */
function syncDuck() {
  if (!mediaView) return;
  const playing = !!player?.playing;
  let on = duckDecision({ turnOpen: !!(turn && !turn.ended), serverBird, playing });
  if (!on) duckOverride = false;
  else if (duckOverride) on = false;
  if (!on) { duckSince = null; clearTimeout(duckTimer); duckTimer = null; }
  else if (duckSince == null) {
    duckSince = performance.now();
    duckTimer = setTimeout(() => {
      duckTimer = null;
      if (duckSince == null) return;
      if (duckBackstop({ duckedFor: performance.now() - duckSince, serverBird, playing: !!player?.playing })) { duckOverride = true; note("media", "duck backstop"); syncDuck(); }
      else { duckSince = null; syncDuck(); }           // still busy (a long turn): check again in another DUCK_BACKSTOP_MS (re-review N8)
    }, DUCK_BACKSTOP_MS);
  }
  mediaView.hold(on, config.pause_media_on_listen === true);
}
/** The display's theme setting pins light/dark; on "auto" a display dims by its sleep hours and the dashboard follows the OS scheme. */
function applyTheme() { document.documentElement.dataset.theme = themeFor(config.theme, { session: SESSION, osDark: SESSION && matchMedia("(prefers-color-scheme: dark)").matches, night: !SESSION && isNight(new Date(), config.sleep_start, config.sleep_end) }); }
function tickClock() {
  const d = new Date();
  $("clock").textContent = d.toLocaleTimeString(lang, { hour: "numeric", minute: "2-digit" });
  $("date").textContent = d.toLocaleDateString(lang, { weekday: "short", month: "short", day: "numeric" });
  applyTheme();
  clockTimer = setTimeout(tickClock, msToNextMinute(d) + 50);
}

async function pair() {
  $("pairing").hidden = false;
  $("pair-label").textContent = t("pair_label");
  $("pair-hint").textContent = t("pair_hint");
  $("pair-code").textContent = "";
  let status = 0, body = null;
  try {
    const res = await fetch("/api/kiosk/pair/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name_hint: /Mobile|Android|iPhone/.test(navigator.userAgent) ? "Phone" : "Display" }) });
    status = res.status;
    body = await res.json().catch(() => null);
  } catch { /* network error: status 0 */ }
  const d = pairStartDecision(status, body, pairAttempt);
  if (d.action !== "show") { pairAttempt++; $("pair-hint").textContent = t(d.hint); setTimeout(pair, d.ms); return; }
  pairAttempt = 0;
  const { pair_id, code, poll_secret } = body;
  $("pair-code").textContent = `${code.slice(0, 3)} ${code.slice(3)}`;
  const deadline = Date.now() + 10 * 60 * 1000;
  const poll = async () => {
    if (Date.now() > deadline) { pair(); return; }
    let r;
    try { r = await fetch(`/api/kiosk/pair/status?pair_id=${encodeURIComponent(pair_id)}`, { headers: { "X-Kiosk-Poll": poll_secret }, cache: "no-store" }); } catch { setTimeout(poll, 2000); return; }
    if (r.status === 404 || r.status === 403) { pair(); return; }
    const j = await r.json().catch(() => ({}));
    if (j.state === "approved" && j.token) { ls.set(LS_DEV, j.device_id); ls.set(LS_TOK, j.token); $("pairing").hidden = true; connect(); return; }
    setTimeout(poll, 2000);
  };
  setTimeout(poll, 2000);
}

function scheduleReconnect(ms) { clearTimeout(reconnectTimer); reconnectTimer = setTimeout(connect, ms); }
/** One socket at a time (review M4): events from any socket that is not the current one are ignored. */
function connect() {
  clearTimeout(reconnectTimer); reconnectTimer = null;
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  const id = SESSION ? null : ls.get(LS_DEV), tok = SESSION ? null : ls.get(LS_TOK);
  if (!SESSION && (!id || !tok)) { pair(); return; }
  halted = false;
  const sock = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/kiosk/session${SESSION ? "/dashboard" : ""}`);
  ws = sock;
  sock.binaryType = "arraybuffer";
  let opened = false;
  sock.onopen = () => { opened = true; if (ws === sock) sock.send(JSON.stringify(SESSION ? { type: "hello", mode: "session", csrf: cookie("crow_csrf"), caps: CAPS, tz: TZ } : { type: "hello", device_id: id, token: tok, caps: CAPS, tz: TZ })); };
  sock.onmessage = (ev) => {
    if (ws !== sock) return;
    if (typeof ev.data !== "string") { player?.push(ev.data); return; }
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    onText(m);
  };
  sock.onclose = (ev) => {
    if (ws !== sock) return;
    ws = null;
    if (turn && !turn.ended) { turn.ended = true; mic?.stop(); }
    player?.flush();
    serverBird = "idle";
    renderBird();
    note("ws", `closed ${ev.code} ${ev.reason || ""}`.trim());
    const d = closeDecision(ev.code, ev.reason, SESSION ? "session" : "paired");
    if (releasesMic(d)) releaseAudio();
    if (d.action === "forget_token") { ls.del(LS_DEV); ls.del(LS_TOK); pair(); return; }
    if (d.action === "halt") { halted = true; banner(d.banner); return; }
    // Session mode: a socket refused before it opened may mean the login ended (the upgrade answers 401,
    // which a page cannot see). Ask the page URL once; 401 there stops the retries with a message.
    if (SESSION && !opened) {
      fetch(location.pathname, { method: "HEAD", cache: "no-store" }).then((r) => {
        if (r.status !== 401 || ws || halted) return;
        clearTimeout(reconnectTimer); reconnectTimer = null; halted = true; releaseAudio(); banner("session_expired");
      }).catch(() => {});
    }
    scheduleReconnect(backoffMs(attempt++));   // incl. 1011 server_error: the token is kept
  };
}
/** → whether the frame left (false while the socket is down: the media view keeps what it could not send). */
const send = (o) => { if (ws && ws.readyState === 1) { ws.send(JSON.stringify(o)); return true; } return false; };

function onText(m) {
  switch (m.type) {
    case "ready":
      attempt = 0; banner(bannerAfterReady(bannerKey));   // a mic prompt survives a reconnect
      config = m.display_config || {};
      if (config.lang === "en" || config.lang === "es") lang = config.lang;
      serverOffset = (m.server_now || Date.now()) - Date.now();
      mountUi();
      mediaView?.flush();                             // a media report the socket could not carry (re-review N3)
      break;
    case "state":
      serverBird = m.bird;
      renderBird();                                  // idle while our audio still plays stays "speaking" (F3)
      break;
    // Privacy (docs: transcripts live only in the 15-min server conversation): the ring keeps LENGTHS of what was said/answered, never the words.
    case "transcript_final": $("cap-user").textContent = m.text || ""; note("transcript", `${(m.text || "").length} chars`); caption("", "clear"); break;
    case "caption_delta": { const was = $("cap-bot").textContent; $("cap-bot").textContent += m.text || ""; if (!was) note("caption:reply", "started"); break; }
    case "tts_start": {
      const d = ttsStartDecision(turn);
      if (!d.play) break;                            // a barged turn's in-flight start: the player stays muted
      ttsSeq++;
      if (d.own) { turn.tts = true; turn.ttsSeq = ttsSeq; }   // this turn's own audio
      player?.begin(m.codec, m.sample_rate, ttsSeq);
      break;
    }
    case "wm": noteEffect(turn, { kind: "wm", at: performance.now() }); note("wm", `${m.action}${m.id ? " " + m.id : ""}${m.windows ? " (" + m.windows.length + ")" : ""}`); wmView?.apply(m); if (m.action === "timer_done") chime(); break;
    case "announce": $("cap-user").textContent = ""; $("cap-bot").textContent = m.text || ""; note("caption:announce", `${(m.text || "").length} chars`); break;
    case "media":
      noteEffect(turn, { kind: m.action === "load" && !m.paused ? "load" : "media", id: m.id, at: performance.now() });
      note("media", `${m.action}${m.id ? " " + m.id : ""}`);
      mediaView?.apply(m);
      break;
    // The closing frame of a turn that never ran (empty, too long, busy): the turn ends here, no metrics.
    case "turn_over":
      if (turn && turn.id === m.turn_id) {
        if (!turn.ended) { turn.ended = true; clearTimeout(turn.guard); turn.guard = null; mic?.stop(); }
        turn.reported = true;
        turn.done = { turn_id: m.turn_id, aborted: true, over: String(m.reason || "") };
        turn.doneAt = performance.now();
      }
      note("turn", `over ${String(m.reason || "").slice(0, 16)}`);
      syncDuck();
      break;
    case "turn_done":
      if (m.timings?.tools || m.timings?.tool_choice) note("tools", toolsLine(m.timings));
      if (turn && turn.id === m.turn_id) { turn.done = m; turn.doneAt = performance.now(); settle(turn); }
      break;
    case "error":
      note("error", `${m.code}${m.recoverable ? "" : " (fatal)"}`);
      { const d = errorDecision(m.code, m.recoverable, SESSION ? "session" : "paired"); if (d.banner) banner(d.banner); else caption(t(d.caption), m.code); }
      syncDuck();
      break;
    default:
  }
}

function mountUi() {
  const b = config.bird || { species: "crow", seed: 0, mood: "happy" };
  const anim = config.animation !== false && !matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.documentElement.classList.toggle("no-anim", !anim);
  bird?.dispose();                                // every ready remounts: never leave the old blink chain running
  bird = mountBird($("bird-art"), b, { animate: anim });
  $("bird").setAttribute("aria-label", t("mic_talk"));
  renderBird();
  if (!wmView) {
    wmView = createWindowView($("windows"), {
      t, now: () => Date.now() + serverOffset,
      onDismiss: (id) => send({ type: "wm_event", id, kind: "dismissed" }),
      onTap: (id) => send({ type: "wm_event", id, kind: "tapped" }),
      onCloseAll: () => send({ type: "wm_event", kind: "close_all" }),
      nowPlaying: () => mediaView?.info() || null,
      onMedia: (verb) => send({ type: "media_cmd", do: verb }),
    });
  }
  if (!clockTimer) tickClock(); else applyTheme();   // a pushed theme setting applies now, not at the next minute
  if (!$("cap-bot").textContent) caption(t("tap_hint"), "tap_hint");
}

async function ensureAudio() {
  if (!ctx) ctx = new AudioContext({ latencyHint: "interactive" });
  if (ctx.state === "suspended") { try { await ctx.resume(); } catch {} }
  if (!player) {
    player = createPlayer(ctx, {
      onLevel: (v) => bird?.setLevel(v),
      onFirstPlay: (at, seq) => {
        if (turn && !turn.barged && turn.ttsSeq === seq && turn.playAt == null) turn.playAt = at;
        renderBird();
      },
      onDrained: () => { renderBird(); if (turn) settle(turn); },
    });
  }
  if (!mic) {
    try { mic = await openMic(ctx, onFrame); } catch (err) { banner(micDecision(err, ctx.state)); return false; }
  }
  const d = micDecision(null, ctx.state);
  if (d !== "ok") { banner(d); return false; }
  banner(null);
  return true;
}

function onFrame(pcm, rms, at) {
  if (!turn || turn.ended) return;               // the worklet only posts during a turn
  if (ws && ws.readyState === 1) { ws.send(pcm); turn.sentBytes += pcm.byteLength || 0; }
  const r = turn.vad.push(rms, at);
  if (r.voiced) turn.voicedBytes = turn.sentBytes;          // the server discards an early STT that ends before this
  if (r.pause) send({ type: "speech_pause" });              // early STT: transcribe now, while the hangover runs (lever D)
  if (r.end) endTurn(r.reason, r.speechEndAt);
}

async function startTurn(source) {
  if (!ws || ws.readyState !== 1) return;
  if (!(await ensureAudio())) return;
  if (turn) report(turn, true);                  // a pending no-audio wait is cut short: still reported (F9)
  const noSpeechMs = source === "follow_up" ? (config.follow_up_s || 6) * 1000 : 8000;
  const hangoverMs = Number(config.vad_hangover_ms) || VAD_DEFAULTS.hangoverMs;   // latency lever 1 (ruling R20; default 450 ms)
  turn = { id: `t${Date.now()}`, effectAt: null, effectLoad: null, endedAt: null, source, vad: createVad({ noSpeechMs, hangoverMs }), speechEndAt: null, playAt: null, done: null, doneAt: null, reason: null, ended: false, reported: false, tts: false, ttsSeq: null, barged: false, followedUp: false, retry: null, guard: null, sentBytes: 0, voicedBytes: 0 };
  const tn = turn;
  tn.guard = setTimeout(() => { if (turn === tn) endTurn("max", null); }, TURN_GUARD_MS);   // frames stopped (phone locked, track ended)
  duckOverride = false;
  syncDuck();                                     // at the tap, before the server answers (spec §9.6)
  send({ type: "turn_start", source: source === "wake" ? "wake" : "tap", turn_id: turn.id });
  mic.start(source === "wake");                   // 1.0 s pre-roll only for a wake word (spec §7.3)
  $("cap-user").textContent = "";
  caption("", `turn_start ${source}`);
}
function endTurn(reason, speechEndAt) {
  if (!turn || turn.ended) return;
  turn.ended = true; turn.reason = reason; turn.speechEndAt = speechEndAt; turn.endedAt = performance.now();
  clearTimeout(turn.guard); turn.guard = null;
  mic?.stop();
  syncDuck();
  send({ type: "turn_end", vad_reason: reason, voiced_bytes: turn.voicedBytes });
}
/** turn_metrics, once per turn, when playback settles (F3) or the no-audio wait runs out (F9). */
function report(tn, force = false) {
  clearTimeout(tn.retry); tn.retry = null;
  const d = reportDecision(tn, { playing: !!player?.playing, now: performance.now(), force });
  if (d.retryInMs != null) { tn.retry = setTimeout(() => report(tn), d.retryInMs); return; }
  if (!d.report) return;
  tn.reported = true;
  send(turnMetrics(tn, { outputLatencyMs: Math.round(((ctx && (ctx.outputLatency || ctx.baseLatency)) || 0) * 1000) }));
}
/** Called on turn_done and on local drain — whichever comes last opens the follow-up mic. */
function settle(tn) {
  report(tn);
  if (tn === turn && followUpDecision(tn, config, { playing: !!player?.playing })) { tn.followedUp = true; startTurn("follow_up"); }
}
function chime() {
  if (!ctx) return;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.frequency.value = 880; g.gain.value = 0.15;
  o.connect(g); g.connect(ctx.destination);
  o.start(); o.stop(ctx.currentTime + 0.6);
}

async function onTap() {
  switch (tapDecision({ halted, playing: !!player?.playing, birdState, turnOpen: !!(turn && !turn.ended) })) {
    case "resume": halted = false; banner(null); connect(); return;
    case "barge":
      send({ type: "barge_in" });
      if (turn && !turn.reported) turn.barged = true;   // after turn_done too: the server already said idle (F3)
      player?.flush();
      if (serverBird === "speaking") serverBird = "idle";
      renderBird();
      if (turn) report(turn);
      return;
    case "stop": endTurn("manual", null); return;
    case "ignore": return;
    default: await startTurn("tap");
  }
}
$("bird").addEventListener("click", onTap);
// Long press (700 ms) on the clock toggles the status ring; a tap anywhere on it closes it.
{
  let hold = null;
  const cancel = () => { clearTimeout(hold); hold = null; };
  $("clock").addEventListener("pointerdown", () => { cancel(); hold = setTimeout(() => { hold = null; if ($("debug").hidden) showDebug(); else $("debug").hidden = true; }, 700); });
  for (const ev of ["pointerup", "pointerleave", "pointercancel"]) $("clock").addEventListener(ev, cancel);
  $("debug").addEventListener("click", () => { $("debug").hidden = true; });
}
$("mic").addEventListener("click", onTap);
window.addEventListener("pagehide", releaseAudio);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && !halted && (SESSION || ls.get(LS_TOK))) connect(); });   // connect() is a no-op while a socket is live
if (SESSION) {
  // The dashboard closes the overlay (its own close button, or Escape): it calls this first so the
  // microphone, any playing audio and the socket stop at once, then removes the frame.
  window.crowKioskRelease = () => {
    halted = true;
    clearTimeout(reconnectTimer); reconnectTimer = null;
    releaseAudio();
    try { ctx?.close(); } catch {}
    const s = ws; ws = null;
    try { s?.close(1000, "closed"); } catch {}
  };
  // Escape pressed while focus is inside the frame never reaches the dashboard: ask it to close.
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && window.parent !== window) window.parent.postMessage("crow-talk-close", location.origin); });
}

mediaView = createMediaView({
  audio: $("media"), chip: $("np-chip"), send, t,
  onState: (id, state) => { if (state === "playing") noteEffect(turn, { kind: "playing", id, at: performance.now() }); },
  onChange: () => wmView?.refresh(),
});
$("mic").textContent = t("mic_talk");
connect();
