/**
 * Crow kiosk page: pairing → session → tap-to-talk. Phone-friendly (D8). A Pi (?agent=1) also gets the speaker chip.
 * Session mode (/display/session, inside the dashboard's Talk to Crow overlay): the viewer is already
 * logged in to the dashboard, so there is no pairing and no stored token — the socket is authorised by
 * the dashboard session cookie and hello echoes the CSRF cookie.
 */
import { STRINGS } from "./strings.js";
import {
  closeDecision, backoffMs, micDecision, isNight, themeFor, msToNextMinute,
  displayedBird, tapDecision, followUpDecision, reportDecision, turnMetrics,
  releasesMic, ttsStartDecision, settleDecision, pairStartDecision, bannerAfterReady, createStatusRing, errorDecision, toolsLine,
  duckDecision, duckBackstop, DUCK_BACKSTOP_MS, noteEffect, micAfterTurn, MEDIA_RECONNECT_CAP_MS, mediaStartGate, releaseForMediaDecision, audioPortLine,
} from "./state.js";
import { createVad, TURN_GUARD_MS, VAD_DEFAULTS } from "./vad.js";
import { openMic, createPlayer, createMicGate } from "./audio.js";
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
/*
 * B3 bar mode: inside the dashboard's Talk to Crow overlay, opened with ?bar=1 (the dashboard does that only when its
 * player bar has the kiosk backend), the media plays in the player bar through a bar link, and outlives the overlay.
 * The tab's owner nonce comes from the bar (it survives a reload of the tab). Anything missing → today's in-page audio.
 */
const BAR_WANTED = SESSION && window.parent !== window && new URLSearchParams(location.search).get("bar") === "1";
let barLink = null, barOwner = null;
if (BAR_WANTED) {
  try {
    barOwner = window.parent.crowPlayer.kioskOwner();
    if (typeof barOwner === "string" && barOwner) {
      const { createBarLink } = await import("./bar-link.js");
      barLink = createBarLink({ parent: window.parent, origin: location.origin, onCommand: (verb) => send({ type: "media_cmd", do: verb }) });
      window.addEventListener("message", barLink.onMessage);
    }
  } catch { barLink = null; }
  if (!barLink) barOwner = null;
}
const BAR = !!barLink;
CAPS.bar = BAR;
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
let mediaView = null, duckSince = null, duckTimer = null, duckOverride = false, micOpenMs = null, starting = false, micReleasedAt = null;
const micGate = createMicGate(() => { captureStarting(); return openMic(ctx, onFrame); });

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
/** Session mode: the fix for "no assistant" is one tap away — Crow's voice editor in Bot Builder, in the dashboard itself. */
function kioskPanelLink() { const a = document.createElement("a"); a.href = "/dashboard/bot-builder?bot=crow.voice"; a.target = "_top"; a.textContent = t("session_bot_link"); return a; }
/*
 * Queue item 21c: the Crow Android app injects window.CrowAudioPort on its paired gateway origin only. Each mic
 * release tells it the capture ended; the app then checks the phone's audio mode (call mode left on sends music
 * to the earpiece) and answers with one line for the debug ring. Elsewhere (a Pi, a browser) there is no port.
 */
const audioPort = globalThis.CrowAudioPort || null;
const captureStarting = () => { try { audioPort?.postMessage('{"op":"captureStarting"}'); } catch {} };
const captureEnded = () => { try { audioPort?.postMessage('{"op":"captureEnded"}'); } catch {} };
/**
 * App only (rev 2, R2.1): an idle AudioContext keeps a call-type stream playing; pause it once the mic is gone. Every play
 * path resumes it. suspend() is async (ctx.state still reads "running" for a while), so the request is tracked, not the state:
 * a resume issued after a pending suspend still wins (control messages run in order).
 */
let outputPaused = false;
function pauseOutput() {
  if (!audioPort || !ctx || outputPaused || ctx.state !== "running" || player?.playing || mic || micGate.opening()) return;
  outputPaused = true;
  try { ctx.suspend().catch(() => {}); } catch {}
  note("audio", "output paused");
}
const outputNeedsResume = () => !!ctx && (outputPaused || ctx.state === "suspended");
const resumeOutput = () => { if (!audioPort || !outputNeedsResume()) return; outputPaused = false; try { ctx.resume().catch(() => {}); } catch {} };
if (audioPort) {
  try {
    audioPort.onmessage = (e) => { const l = audioPortLine(e?.data); if (l) note("audio", l); };
    audioPort.postMessage('{"op":"hello"}');
  } catch {}
}
const cookie = (name) => { for (const c of document.cookie.split(";")) { const [k, ...v] = c.trim().split("="); if (k === name) return v.join("="); } return ""; };
/** Halt / unpaired / page hidden for good: turn the mic off (the phone's indicator); the next tap reopens it. */
function releaseAudio({ keepMedia = false } = {}) {
  if (turn && !turn.ended) endTurn("manual", null);
  if (!keepMedia) mediaView?.apply({ action: "stop" });   // the server's media state comes back with the next hello (bar mode: it plays on in the bar)
  micGate.release(); captureEnded();
  mic = null;
  player?.flush();
  if (audioPort && ctx) outputPaused = true;        // 21c: a play path resumes even mid-suspend (re-review N3)
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
  sock.onopen = () => { opened = true; if (ws === sock) sock.send(JSON.stringify(SESSION ? { type: "hello", mode: "session", csrf: cookie("crow_csrf"), caps: CAPS, tz: TZ, owner: barOwner } : { type: "hello", device_id: id, token: tok, caps: CAPS, tz: TZ })); };
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
    releaseMicAfterTurn("closed");
    mediaView?.offline(true);                       // F9: what plays is shown as not connected
    player?.flush();
    pauseOutput();                                  // 21c: the release above ran while the reply still played
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
    scheduleReconnect(backoffMs(attempt++, mediaView?.current() ? MEDIA_RECONNECT_CAP_MS : undefined));   // incl. 1011 server_error: the token is kept; audio live: every ≤ 5 s (review M3)
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
      mediaView?.offline(false);                      // F9: the server is back; its snapshot follows
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
      resumeOutput();                                // an announcement after pauseOutput (21c)
      player?.begin(m.codec, m.sample_rate, ttsSeq);
      break;
    }
    case "wm": noteEffect(turn, { kind: "wm", at: performance.now() }); note("wm", `${m.action}${m.id ? " " + m.id : ""}${m.windows ? " (" + m.windows.length + ")" : ""}`); wmView?.apply(m); if (m.action === "timer_done") chime(); break;
    case "announce": $("cap-user").textContent = ""; $("cap-bot").textContent = m.text || ""; note("caption:announce", `${(m.text || "").length} chars`); break;
    case "media":
      noteEffect(turn, { kind: m.action === "load" && !m.paused ? "load" : "media", id: m.id, at: performance.now() });
      note("media", `${m.action}${m.id ? " " + m.id : ""}`);
      if ((m.action === "load" && !m.paused) || m.action === "play") { if (turn) turn.mediaLoaded = true; micForMedia(); }   // item 21 (a resume too)
      if (m.action === "load") barLink?.describe(m);   // the bar shows its title etc.
      mediaView?.apply(m);
      break;
    // The closing frame of a turn that never ran (empty, too long, busy): the turn ends here, no metrics.
    case "turn_over":
      if (turn && turn.id === m.turn_id) {
        if (!turn.ended) { turn.ended = true; clearTimeout(turn.guard); turn.guard = null; mic?.stop(); releaseMicAfterTurn("closed"); }
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
  if (outputNeedsResume()) { outputPaused = false; try { await ctx.resume(); } catch {} }
  if (!player) {
    player = createPlayer(ctx, {
      onLevel: (v) => bird?.setLevel(v),
      onFirstPlay: (at, seq) => {
        if (turn && !turn.barged && turn.ttsSeq === seq && turn.playAt == null) turn.playAt = at;
        renderBird();
      },
      // r7b L3: the mic (and its call audio mode) goes before the music is un-held.
      onDrained: () => { if (turn) settle(turn); else micForMedia(); renderBird(); },
      onStall: (info) => { if (turn) { turn.ttsStalled = true; turn.stall ??= { ctx_state: info.ctxState, clock_moved: info.clockMoved === true }; } note("audio", `reply stalled (${info.left} left, ${info.ctxState})`); },
    });
  }
  if (!mic) {
    // One open at a time, shared by every caller (review H3); an open released meanwhile gives null.
    try { mic = await micGate.acquire(); } catch (err) { banner(micDecision(err, ctx.state)); return false; }
    if (!mic) return false;
    micOpenMs = micGate.takeOpenMs();
  }
  const d = micDecision(null, ctx.state);
  if (d !== "ok") {
    banner(d);
    if (config.mic_per_turn) { micGate.release(); captureEnded(); mic = null; micReleasedAt = performance.now(); pauseOutput(); }   // item 21: no turn, so no open mic held
    return false;
  }
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
  if (!ws || ws.readyState !== 1 || starting) return;
  // Review H3: from the tap until the turn exists, a second tap is ignored and the bird shows it heard the first.
  starting = true;
  $("bird").classList.add("is-starting");
  let ok = false;
  try { ok = await ensureAudio(); } finally { starting = false; $("bird").classList.remove("is-starting"); }
  if (!ok) return;
  if (turn) report(turn, true);                  // a pending no-audio wait is cut short: still reported (F9)
  const noSpeechMs = source === "follow_up" ? (config.follow_up_s || 6) * 1000 : 8000;
  const hangoverMs = Number(config.vad_hangover_ms) || VAD_DEFAULTS.hangoverMs;   // latency lever 1 (ruling R20; default 450 ms)
  turn = { id: `t${Date.now()}`, effectAt: null, effectLoad: null, endedAt: null, source, vad: createVad({ noSpeechMs, hangoverMs }), speechEndAt: null, playAt: null, done: null, doneAt: null, reason: null, ended: false, reported: false, tts: false, ttsSeq: null, barged: false, followedUp: false, retry: null, guard: null, sentBytes: 0, voicedBytes: 0 };
  const tn = turn;
  tn.micOpenMs = micOpenMs; micOpenMs = null;     // F6: the reopen cost at this tap (null: it was open)
  tn.pageMediaStart = mediaView?.state() ?? null;   // r7b M3: the page's own media state at the tap
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
/** Item 21: music loaded while an open mic idles (no turn in flight, no TTS: G12) — let it go so the music can start. */
function micForMedia() {
  if (!releaseForMediaDecision({ config, micOpen: !!mic || micGate.opening(), turnOpen: !!(turn && !(turn.ended && turn.done)), playing: !!player?.playing })) return;
  micGate.release(); captureEnded();
  mic = null; micReleasedAt = performance.now();
  note("mic", "released for media");
  pauseOutput();
  mediaView?.kick();
}
/** F6: a phone lets the microphone go (Android leaves voice-call audio mode) once the turn has settled — never mid-reply (r7 G12). */
function releaseMicAfterTurn(phase) {
  if (micAfterTurn(config, { phase }) !== "release" || (!mic && !micGate.opening())) return;
  micGate.release(); captureEnded();
  mic = null; micReleasedAt = performance.now();
  note("mic", "released");
  pauseOutput();
  mediaView?.kick();                              // item 21: a held start now waits only the settle time
}
/** turn_metrics, once per turn, when playback settles (F3) or the no-audio wait runs out (F9). */
function report(tn, force = false) {
  clearTimeout(tn.retry); tn.retry = null;
  const d = reportDecision(tn, { playing: !!player?.playing, now: performance.now(), force });
  if (d.retryInMs != null) { tn.retry = setTimeout(() => report(tn), d.retryInMs); return; }
  if (!d.report) return;
  tn.reported = true;
  send(turnMetrics(tn, { outputLatencyMs: Math.round(((ctx && (ctx.outputLatency || ctx.baseLatency)) || 0) * 1000), ctxState: ctx ? String(ctx.state) : null, pageMedia: mediaView?.state() ?? null }));
}
/** Called on turn_done and on local drain — whichever comes last opens the follow-up mic. */
function settle(tn) {
  if (tn.tts && player) tn.ttsAudioMs = player.audioMs;   // r7b H3: the reply's scheduled audio (counts only)
  report(tn);
  // Review of rev 7 (H1): never on a dry spell mid-reply — only once this turn is done and nothing plays.
  const d = settleDecision(tn, { current: turn, playing: !!player?.playing, config });
  if (d.followUp) { tn.followedUp = true; startTurn("follow_up"); }
  else if (d.release) releaseMicAfterTurn("settled");
}
function chime() {
  if (!ctx) return;
  resumeOutput();
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.frequency.value = 880; g.gain.value = 0.15;
  o.connect(g); g.connect(ctx.destination);
  o.start(); o.stop(ctx.currentTime + 0.6);
}

async function onTap() {
  switch (tapDecision({ halted, playing: !!player?.playing, birdState, turnOpen: !!(turn && !turn.ended), starting })) {
    case "resume": halted = false; banner(null); connect(); return;
    case "barge":
      send({ type: "barge_in" });
      if (turn && !turn.reported) turn.barged = true;   // after turn_done too: the server already said idle (F3)
      releaseMicAfterTurn("closed");                    // a barge ends the conversation: no follow-up comes
      player?.flush();
      pauseOutput();                                    // 21c: the release above ran while the reply still played
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
window.addEventListener("pagehide", () => releaseAudio({ keepMedia: BAR }));
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && !halted && (SESSION || ls.get(LS_TOK))) connect(); });   // connect() is a no-op while a socket is live
if (SESSION) {
  // The dashboard closes the overlay (its own close button, or Escape): it calls this first so the
  // microphone, any playing audio and the socket stop at once, then removes the frame. Bar mode: the
  // audio plays on in the bar, which gets back its un-ducked level and whether to undo a hold.
  window.crowKioskRelease = () => {
    halted = true;
    clearTimeout(reconnectTimer); reconnectTimer = null;
    const keep = BAR ? mediaView?.release() ?? null : undefined;
    releaseAudio({ keepMedia: BAR });
    try { ctx?.close(); } catch {}
    const s = ws; ws = null;
    try { s?.close(1000, "closed"); } catch {}
    return keep;
  };
  // Escape pressed while focus is inside the frame never reaches the dashboard: ask it to close.
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && window.parent !== window) window.parent.postMessage("crow-talk-close", location.origin); });
}

mediaView = createMediaView({
  audio: barLink || $("media"), chip: BAR ? document.createElement("button") : $("np-chip"), send, t, bar: BAR,
  // Item 21: never start over an open capture or within mic_settle_ms of its release; A7's evidence is in the ring.
  // In bar mode too: the parent bar plays, but this frame's open mic is what puts Android in call mode.
  canStart: () => { const g = mediaStartGate({ micOpen: !!mic, micOpening: micGate.opening(), releasedAt: micReleasedAt, now: performance.now(), config }); return g.ok || g.waitMs; },
  onPlay: () => note("media", `start mic=${mic || micGate.opening() ? "open" : "closed"}`),
  onState: (id, state) => { if (state === "playing") noteEffect(turn, { kind: "playing", id, at: performance.now() }); },
  onChange: () => wmView?.refresh(),
  onChipTap: () => send({ type: "wm_event", kind: "nowplaying" }),   // F8: the server opens (or brings forward) the window
});
$("mic").textContent = t("mic_talk");
connect();
// DV13 speaker chip: a Pi (?agent=1) only; one agent link per page load.
if (!SESSION && new URLSearchParams(location.search).get("agent") === "1") Promise.all([import("./agent-link.js"), import("./speaker-view.js")]).then(([{ createAgentLink }, { createSpeakerView }]) => {
  let view = null;
  const link = createAgentLink({ onStatus: (s) => view.status(s), onBtState: (b) => { note("speaker", b.connected ? "on" : b.reason || "off"); view.bt(b); } });
  view = createSpeakerView($("speaker"), { t, link });
  view.start(); link.start();
}).catch(() => {});
