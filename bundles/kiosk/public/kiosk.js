/** Crow kiosk page: pairing → session → tap-to-talk. Phone-friendly (D8); Pi agent hooks arrive in K2. */
import { STRINGS } from "./strings.js";
import {
  closeDecision, backoffMs, micDecision, isNight, msToNextMinute,
  displayedBird, tapDecision, followUpDecision, reportDecision, turnMetrics,
} from "./state.js";
import { createVad } from "./vad.js";
import { openMic, createPlayer } from "./audio.js";
import { mountBird } from "./bird-view.js";
import { createWindowView } from "./wm-view.js";

const LS_DEV = "crow.kiosk.device_id";
const LS_TOK = "crow.kiosk.token";
const CAPS = { windows: ["timer", "recipe", "content"], iframe: false, max_windows: 4, agent: false };
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
let ttsSeq = 0;

function banner(key) { const b = $("banner"); b.textContent = key ? t(key) : ""; b.hidden = !key; }
function setBird(s) {
  birdState = s;
  bird?.setState(s);
  $("mic").textContent = t(s === "listening" ? "mic_stop" : s === "speaking" ? "mic_interrupt" : "mic_talk");
}
/** The server's state, held in "speaking" while local audio still plays (ruling F3). */
const renderBird = () => setBird(displayedBird(serverBird, !!player?.playing));
function applyTheme() { document.documentElement.dataset.theme = isNight(new Date(), config.sleep_start, config.sleep_end) ? "dark" : "light"; }
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
  let res;
  try {
    res = await fetch("/api/kiosk/pair/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name_hint: /Mobile|Android|iPhone/.test(navigator.userAgent) ? "Phone" : "Display" }) });
  } catch { setTimeout(pair, 5000); return; }
  if (!res.ok) { $("pair-hint").textContent = t(res.status === 429 ? "pair_busy" : "pair_error"); setTimeout(pair, 15_000); return; }
  const { pair_id, code, poll_secret } = await res.json();
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
  const id = ls.get(LS_DEV), tok = ls.get(LS_TOK);
  if (!id || !tok) { pair(); return; }
  halted = false;
  const sock = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/kiosk/session`);
  ws = sock;
  sock.binaryType = "arraybuffer";
  sock.onopen = () => { if (ws === sock) sock.send(JSON.stringify({ type: "hello", device_id: id, token: tok, caps: CAPS })); };
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
    const d = closeDecision(ev.code, ev.reason);
    if (d.action === "forget_token") { ls.del(LS_DEV); ls.del(LS_TOK); pair(); return; }
    if (d.action === "halt") { halted = true; banner(d.banner); return; }
    scheduleReconnect(backoffMs(attempt++));   // incl. 1011 server_error: the token is kept
  };
}
const send = (o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };

function onText(m) {
  switch (m.type) {
    case "ready":
      attempt = 0; banner(null);
      config = m.display_config || {};
      if (config.lang === "en" || config.lang === "es") lang = config.lang;
      serverOffset = (m.server_now || Date.now()) - Date.now();
      mountUi();
      break;
    case "state":
      serverBird = m.bird;
      renderBird();                                  // idle while our audio still plays stays "speaking" (F3)
      break;
    case "transcript_final": $("cap-user").textContent = m.text || ""; $("cap-bot").textContent = ""; break;
    case "caption_delta": $("cap-bot").textContent += m.text || ""; break;
    case "tts_start":
      ttsSeq++;
      if (turn && turn.ended && !turn.done) { turn.tts = true; turn.ttsSeq = ttsSeq; }   // this turn's own audio
      player?.begin(m.codec, m.sample_rate, ttsSeq);
      break;
    case "wm": wmView?.apply(m); if (m.action === "timer_done") chime(); break;
    case "announce": $("cap-user").textContent = ""; $("cap-bot").textContent = m.text || ""; break;
    case "turn_done":
      if (turn && turn.id === m.turn_id) { turn.done = m; turn.doneAt = performance.now(); settle(turn); }
      break;
    case "error":
      if (m.code === "no_bound_bot") banner("no_bot");
      else if (!m.recoverable) banner("error_generic");
      else $("cap-bot").textContent = t(`err_${m.code}`);
      break;
    default:
  }
}

function mountUi() {
  const b = config.bird || { species: "crow", seed: 0, mood: "happy" };
  const anim = config.animation !== false && !matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.documentElement.classList.toggle("no-anim", !anim);
  bird = mountBird($("bird-art"), b, { animate: anim });
  $("bird").setAttribute("aria-label", t("mic_talk"));
  renderBird();
  if (!wmView) {
    wmView = createWindowView($("windows"), {
      t, now: () => Date.now() + serverOffset,
      onDismiss: (id) => send({ type: "wm_event", id, kind: "dismissed" }),
      onTap: (id) => send({ type: "wm_event", id, kind: "tapped" }),
      onCloseAll: () => send({ type: "wm_event", kind: "close_all" }),
    });
  }
  if (!clockTimer) tickClock();
  if (!$("cap-bot").textContent) $("cap-bot").textContent = t("tap_hint");
}

async function ensureAudio() {
  if (!ctx) ctx = new AudioContext({ latencyHint: "interactive" });
  if (ctx.state === "suspended") { try { await ctx.resume(); } catch {} }
  if (!player) {
    player = createPlayer(ctx, {
      onLevel: (v) => bird?.setLevel(v),
      onFirstPlay: (at, seq) => {
        if (turn && turn.ttsSeq === seq && turn.playAt == null) turn.playAt = at;
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
  if (ws && ws.readyState === 1) ws.send(pcm);
  const r = turn.vad.push(rms, at);
  if (r.end) endTurn(r.reason, r.speechEndAt);
}

async function startTurn(source) {
  if (!ws || ws.readyState !== 1) return;
  if (!(await ensureAudio())) return;
  if (turn) report(turn, true);                  // a pending no-audio wait is cut short: still reported (F9)
  const noSpeechMs = source === "follow_up" ? (config.follow_up_s || 6) * 1000 : 8000;
  const hangoverMs = Number(config.vad_hangover_ms) || 600;   // latency lever 1 (ruling R20)
  turn = { id: `t${Date.now()}`, source, vad: createVad({ noSpeechMs, hangoverMs }), speechEndAt: null, playAt: null, done: null, doneAt: null, reason: null, ended: false, reported: false, tts: false, ttsSeq: null, barged: false, followedUp: false, retry: null };
  send({ type: "turn_start", source: source === "wake" ? "wake" : "tap", turn_id: turn.id });
  mic.start(source === "wake");                   // 1.0 s pre-roll only for a wake word (spec §7.3)
  $("cap-user").textContent = "";
  $("cap-bot").textContent = "";
}
function endTurn(reason, speechEndAt) {
  if (!turn || turn.ended) return;
  turn.ended = true; turn.reason = reason; turn.speechEndAt = speechEndAt;
  mic?.stop();
  send({ type: "turn_end", vad_reason: reason });
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
$("mic").addEventListener("click", onTap);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && !halted && ls.get(LS_TOK)) connect(); });   // connect() is a no-op while a socket is live

$("mic").textContent = t("mic_talk");
connect();
