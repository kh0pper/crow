import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  closeDecision, backoffMs, micDecision, isNight, themeFor, msToNextMinute,
  displayedBird, tapDecision, followUpDecision, reportDecision, turnMetrics, NO_AUDIO_WAIT_MS, createStatusRing,
  duckDecision, duckBackstop, DUCK_BACKSTOP_MS, noteEffect, EFFECT_WAIT_MS,
} from "../bundles/kiosk/public/state.js";
import { createPlayer } from "../bundles/kiosk/public/audio.js";

test("4401 unauthorized/unpaired clears the token; 4401 hello_timeout keeps it and reconnects", () => {
  assert.equal(closeDecision(4401, "unauthorized").action, "forget_token");
  assert.equal(closeDecision(4401, "unpaired").action, "forget_token");
  assert.equal(closeDecision(4401, "hello_timeout").action, "reconnect");
  assert.equal(closeDecision(1006, "").action, "reconnect");
});

test("1011 server_error (transient verify/setup failure) reconnects with backoff and KEEPS the token", () => {
  assert.deepEqual(closeDecision(1011, "server_error"), { action: "reconnect" });
  assert.deepEqual(closeDecision(1011, ""), { action: "reconnect" });
  assert.deepEqual(closeDecision(4401, ""), { action: "reconnect" }, "only the named 4401 reasons drop the token");
});

test("4000 superseded → halt (no auto reconnect ping-pong)", () => {
  assert.deepEqual(closeDecision(4000, "superseded"), { action: "halt", banner: "opened_elsewhere" });
});

test("reconnect backoff 1 s → 30 s cap", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map(backoffMs), [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
});

test("mic denied → mic_blocked; no device → no_mic; suspended context → needs_gesture", () => {
  assert.equal(micDecision({ name: "NotAllowedError" }, "running"), "mic_blocked");
  assert.equal(micDecision({ name: "SecurityError" }, "running"), "mic_blocked");
  assert.equal(micDecision({ name: "NotFoundError" }, "running"), "no_mic");
  assert.equal(micDecision(null, "suspended"), "needs_gesture");
  assert.equal(micDecision(null, "running"), "ok");
});

test("night window wraps midnight (default 22:30–06:30, Kevin Q4)", () => {
  const at = (h, m) => new Date(2026, 9, 3, h, m);
  assert.equal(isNight(at(22, 29)), false); assert.equal(isNight(at(22, 30)), true);
  assert.equal(isNight(at(3, 0)), true); assert.equal(isNight(at(6, 30)), false);
  assert.equal(isNight(at(13, 0), "12:00", "14:00"), true);
  assert.equal(msToNextMinute(new Date(2026, 9, 3, 7, 41, 59, 500)), 500);
});

// ---- Ruling F3: the server says idle when it has SENT the audio, not when it has played. ----

test("F3: server idle while local audio still plays → the bird stays speaking until drain", () => {
  assert.equal(displayedBird("idle", true), "speaking");
  assert.equal(displayedBird("idle", false), "idle");
  assert.equal(displayedBird("speaking", false), "speaking", "a gap between sentences mid-turn keeps the server's state");
  assert.equal(displayedBird("listening", false), "listening");
  assert.equal(displayedBird("thinking", false), "thinking");
});

const doneTurn = (over = {}) => ({
  id: "t1", source: "tap", reason: "silence", speechEndAt: 1000, playAt: 2500, tts: true, barged: false, reported: false,
  doneAt: 3000, done: { turn_id: "t1", aborted: false, timings: { tts_first_chunk_ms: 900 } }, ...over,
});

test("F3: the follow-up mic opens from local drain, never from the server's idle", () => {
  const cfg = { follow_up: true };
  assert.equal(followUpDecision(doneTurn(), cfg, { playing: true }), false, "server idle arrived, audio still playing");
  assert.equal(followUpDecision(doneTurn(), cfg, { playing: false }), true, "drained");
  assert.equal(followUpDecision(doneTurn({ done: null }), cfg, { playing: false }), false, "drained between sentences, turn not done");
  assert.equal(followUpDecision(doneTurn({ playAt: null }), cfg, { playing: false }), false, "nothing ever played: no drain, no follow-up");
  assert.equal(followUpDecision(doneTurn({ barged: true }), cfg, { playing: false }), false, "a barge-in is not an invitation");
  assert.equal(followUpDecision(doneTurn({ source: "follow_up" }), cfg, { playing: false }), false, "no follow-up of a follow-up (empty-room loop)");
  assert.equal(followUpDecision(doneTurn({ reason: "no_speech" }), cfg, { playing: false }), false);
  assert.equal(followUpDecision(doneTurn({ done: { aborted: true, timings: {} } }), cfg, { playing: false }), false);
  assert.equal(followUpDecision(doneTurn({ followedUp: true }), cfg, { playing: false }), false, "once per turn");
  assert.equal(followUpDecision(doneTurn(), { follow_up: false }, { playing: false }), false);
});

test("F3: a tap during local playback after turn_done is a barge (flush) even though the server already said idle", () => {
  assert.equal(tapDecision({ halted: false, playing: true, birdState: "speaking", turnOpen: false }), "barge");
  assert.equal(tapDecision({ halted: false, playing: true, birdState: "idle", turnOpen: false }), "barge");
  assert.equal(tapDecision({ halted: false, playing: false, birdState: "speaking", turnOpen: false }), "barge");
  assert.equal(tapDecision({ halted: false, playing: false, birdState: "listening", turnOpen: true }), "stop");
  assert.equal(tapDecision({ halted: false, playing: false, birdState: "thinking", turnOpen: false }), "ignore");
  assert.equal(tapDecision({ halted: false, playing: false, birdState: "idle", turnOpen: false }), "start");
  assert.equal(tapDecision({ halted: true, playing: true, birdState: "speaking", turnOpen: false }), "resume");
});

test("F3: turn_metrics waits for drain; a barge during playback after turn_done reports barged:true", () => {
  const now = 3100;
  assert.deepEqual(reportDecision(doneTurn(), { playing: true, now }), { report: false }, "still playing: wait for drain or barge");
  assert.deepEqual(reportDecision(doneTurn(), { playing: false, now }), { report: true }, "drained");
  const barged = doneTurn({ barged: true });
  assert.deepEqual(reportDecision(barged, { playing: false, now }), { report: true });
  const m = turnMetrics(barged, { outputLatencyMs: 20 });
  assert.equal(m.type, "turn_metrics"); assert.equal(m.turn_id, "t1"); assert.equal(m.barged, true);
  assert.equal(m.e2e_ms, 1500); assert.equal(m.vad_reason, "silence"); assert.equal(m.source, "tap"); assert.equal(m.output_latency_ms, 20);
  assert.equal(turnMetrics(doneTurn(), {}).barged, false);
  assert.deepEqual(reportDecision(doneTurn({ reported: true }), { playing: false, now }), { report: false }, "once");
  assert.deepEqual(reportDecision(doneTurn({ done: null }), { playing: false, now }), { report: false }, "no turn_done yet");
});

// ---- Ruling F9: an audio-expected turn that never plays is a FAILURE, not a silent drop. ----

test("F9: audio expected but nothing played → wait NO_AUDIO_WAIT_MS after turn_done, then report e2e_ms:null", () => {
  assert.equal(NO_AUDIO_WAIT_MS, 3000);
  const t = doneTurn({ playAt: null });
  assert.deepEqual(reportDecision(t, { playing: false, now: 3000 }), { report: false, retryInMs: 3000 });
  assert.deepEqual(reportDecision(t, { playing: false, now: 4000 }), { report: false, retryInMs: 2000 });
  assert.deepEqual(reportDecision(t, { playing: false, now: 6000 }), { report: true });
  assert.equal(turnMetrics(t, {}).e2e_ms, null, "the server counts e2e null on an eligible turn as a failure (R8)");
  // tts_start alone (no timings) marks audio as expected
  assert.deepEqual(reportDecision(doneTurn({ playAt: null, done: { aborted: false, timings: {} } }), { playing: false, now: 3000 }).report, false);
  // a forced finalize (a new turn starts inside the wait) reports at once, still null
  assert.deepEqual(reportDecision(t, { playing: false, now: 3001, force: true }), { report: true });
});

test("F9: a turn that never expected audio (no tts_start, no first chunk) or was aborted reports at once", () => {
  const silent = doneTurn({ playAt: null, tts: false, done: { aborted: false, timings: {} } });
  assert.deepEqual(reportDecision(silent, { playing: false, now: 3000 }), { report: true });
  const aborted = doneTurn({ playAt: null, done: { aborted: true, timings: { tts_first_chunk_ms: 500 } } });
  assert.deepEqual(reportDecision(aborted, { playing: false, now: 3000 }), { report: true });
});

// ---- The player's drain/flush semantics that F3 relies on (fake AudioContext). ----

function fakeCtx() {
  const started = [];
  const ctx = {
    currentTime: 1, outputLatency: 0.01, baseLatency: 0, destination: {},
    createAnalyser: () => ({ fftSize: 0, connect() {}, getByteTimeDomainData(a) { a.fill(128); } }),
    createBuffer: (ch, n, rate) => ({ duration: n / rate, getChannelData: () => new Float32Array(n) }),
    createBufferSource: () => { const s = { buffer: null, onended: null, connect() {}, start(w) { s.when = w; started.push(s); }, stop() { s.stopped = true; if (s.onended) s.onended(); } }; return s; },
    decodeAudioData: async () => ({ duration: 0.5, getChannelData: () => new Float32Array(1) }),
  };
  return { ctx, started };
}
const tick = () => new Promise((r) => setImmediate(r));

test("player: playing covers queued audio; drain fires once when the last source ends; flush never fires drain", async (t) => {
  const { ctx, started } = fakeCtx();
  const ev = { first: [], drained: 0 };
  const p = createPlayer(ctx, { onLevel() {}, onFirstPlay: (at, tag) => ev.first.push(tag), onDrained: () => ev.drained++ });
  t.after(() => p.flush());                      // a failed assertion must not leave the beak sampler interval running
  p.begin("pcm", 24000, 7);
  p.push(new ArrayBuffer(4800)); p.push(new ArrayBuffer(4800));
  assert.equal(p.playing, true, "queued but not yet scheduled still counts as playing (server idle can beat the decode)");
  await tick();
  assert.equal(started.length, 2);
  assert.deepEqual(ev.first, [7], "first-play carries the tts_start tag, once");
  assert.ok(started[1].when > started[0].when, "sentences are queued back to back");
  started[0].onended(); assert.equal(ev.drained, 0, "one source still playing");
  started[1].onended(); assert.equal(ev.drained, 1); assert.equal(p.playing, false);

  p.begin("pcm", 24000, 8);
  p.push(new ArrayBuffer(4800)); await tick();
  p.flush();
  assert.equal(ev.drained, 1, "a barge flush is not a natural drain (no follow-up from a barge)");
  assert.equal(p.playing, false);
  const n = started.length;
  p.push(new ArrayBuffer(4800)); p.flush(); await tick();
  assert.equal(started.length, n, "audio queued before a flush never starts after it");
});

// ---- Fix round 1 ----
import { mock } from "node:test";
import { parseHTML } from "linkedom";
import { releasesMic, ttsStartDecision, pairStartDecision, bannerAfterReady } from "../bundles/kiosk/public/state.js";
import { TURN_GUARD_MS, VAD_DEFAULTS as VD } from "../bundles/kiosk/public/vad.js";
import { mountBird } from "../bundles/kiosk/public/bird-view.js";

test("fix 1: a remount disposes the old bird — no blink timer chain survives dispose()", (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(Math, "random", () => 0);       // blink every 4 s exactly
  t.after(() => { mock.timers.reset(); delete globalThis.window; delete globalThis.document; });
  const { document, window } = parseHTML("<button class=k-bird><span id=a></span></button>");
  globalThis.document = document;
  globalThis.window = Object.assign(window, { RambleBird: { rollGenome: () => ({}), drawBird: () => "<g></g>" } });
  const art = document.getElementById("a");
  const blinkedWithin = (ms) => { let seen = false; for (let i = 0; i < ms; i += 20) { mock.timers.tick(20); seen ||= art.classList.contains("blink"); } return seen; };
  const b1 = mountBird(art, { species: "crow", seed: 0, mood: "happy" });
  assert.equal(blinkedWithin(4100), true, "blinks every 4–9 s");
  mock.timers.tick(3990);                        // just before the next blink
  b1.dispose();
  assert.equal(blinkedWithin(30_000), false, "a disposed bird never blinks again");
  b1.pause(false);
  assert.equal(blinkedWithin(30_000), false, "unpause after dispose does not revive it");
  const b2 = mountBird(art, { species: "crow", seed: 0, mood: "happy" });
  mock.timers.tick(4000); assert.equal(art.classList.contains("blink"), true);
  b2.dispose();
  assert.equal(art.classList.contains("blink"), false, "dispose mid-blink clears the class and the 160 ms un-blink");
});

test("fix 2: halt (4000) and forget_token (4401) release the mic; a reconnect (1006/1011/hello_timeout) keeps it", () => {
  assert.equal(releasesMic(closeDecision(4000, "superseded")), true);
  assert.equal(releasesMic(closeDecision(4401, "unpaired")), true);
  assert.equal(releasesMic(closeDecision(4401, "unauthorized")), true);
  for (const [c, r] of [[1006, ""], [1011, "server_error"], [4401, "hello_timeout"]]) assert.equal(releasesMic(closeDecision(c, r)), false, `${c} ${r}`);
});

test("fix 3: tts_start for a barged turn stays muted and never books playAt; a later announcement unmutes", () => {
  const live = { ended: true, done: null, barged: false };
  assert.deepEqual(ttsStartDecision(live), { play: true, own: true });
  assert.deepEqual(ttsStartDecision({ ...live, barged: true }), { play: false, own: false }, "in-flight tts_start after a barge");
  assert.deepEqual(ttsStartDecision({ ended: true, done: {}, barged: true }), { play: true, own: false }, "speech queued after the barged turn finished");
  assert.deepEqual(ttsStartDecision(null), { play: true, own: false }, "announcement with no turn");
  assert.deepEqual(ttsStartDecision({ ended: false, done: null, barged: false }), { play: true, own: false });
});

test("fix 3: after a barge flush the player drops in-flight PCM until the next begin(); fix 4: the beak sampler restarts after a gap", async (t) => {
  const { ctx, started } = fakeCtx();
  const first = [];
  const p = createPlayer(ctx, { onLevel() {}, onFirstPlay: (at, tag) => first.push(tag), onDrained() {} });
  t.after(() => p.flush());
  p.begin("pcm", 24000, 1);
  p.push(new ArrayBuffer(4800)); await tick();
  assert.equal(p.sampling, true);
  started[0].onended();
  assert.equal(p.sampling, false, "a drained gap stops the sampler");
  p.push(new ArrayBuffer(4800)); await tick();
  assert.equal(p.sampling, true, "the next sentence of the same turn restarts it");
  p.flush();
  const n = started.length;
  p.push(new ArrayBuffer(4800)); p.push(new ArrayBuffer(4800)); await tick();
  assert.equal(started.length, n, "frames the server sent before it saw barge_in never play");
  assert.equal(p.playing, false);
  assert.deepEqual(first, [1], "and never book a first play");
  p.begin("pcm", 24000, 2);
  p.push(new ArrayBuffer(4800)); await tick();
  assert.equal(started.length, n + 1); assert.deepEqual(first, [1, 2]);
  p.flush();
});

test("fix 5: the wall-clock guard ends a turn whose frames stop arriving, just past the VAD cap", () => {
  assert.equal(TURN_GUARD_MS, VD.maxMs + 1000);
});

test("fix 6: pair/start needs a well-formed JSON body; anything else retries with backoff", () => {
  const ok = { pair_id: "p1", code: "123456", poll_secret: "s" };
  assert.deepEqual(pairStartDecision(200, ok, 0), { action: "show" });
  assert.deepEqual(pairStartDecision(200, null, 0), { action: "retry", hint: "pair_error", ms: 1000 }, "non-JSON 200");
  assert.deepEqual(pairStartDecision(200, { code: "12" }, 2), { action: "retry", hint: "pair_error", ms: 4000 });
  assert.deepEqual(pairStartDecision(429, null, 0), { action: "retry", hint: "pair_busy", ms: 15_000 });
  assert.deepEqual(pairStartDecision(0, null, 9), { action: "retry", hint: "pair_error", ms: 30_000 }, "network error");
});

test("fix 7: ready clears only connection banners; a mic prompt survives a reconnect", () => {
  for (const k of ["mic_blocked", "needs_gesture", "no_mic", "mic_error"]) assert.equal(bannerAfterReady(k), k);
  for (const k of ["opened_elsewhere", "error_generic", "no_bot", null]) assert.equal(bannerAfterReady(k), null);
});

test("smoke 2026-10-04 item 7: the status ring keeps the last 20 displayed statuses, newest first, text capped", () => {
  const r = createStatusRing(20);
  for (let i = 0; i < 25; i++) r.push("caption:x", `n${i}`, new Date(2026, 9, 4, 1, 2, 3, i).getTime());
  assert.equal(r.list().length, 20);
  assert.equal(r.list()[0].text, "n5", "oldest five dropped");
  const lines = r.format().split("\n");
  assert.equal(lines.length, 20);
  assert.equal(lines[0], "01:02:03.024 caption:x: n24");
  r.push("banner", "y".repeat(500));
  assert.equal(r.list().at(-1).text.length, 120);
});

test("error frames: no bot → banner; bot_too_large → its own caption (never the generic banner); other fatal → generic banner; recoverable → caption", async () => {
  const { errorDecision } = await import("../bundles/kiosk/public/state.js");
  const { STRINGS } = await import("../bundles/kiosk/server/strings.js");
  assert.deepEqual(errorDecision("no_bound_bot", false), { banner: "no_bot" });
  assert.deepEqual(errorDecision("bot_too_large", false), { caption: "err_bot_too_large" });
  assert.deepEqual(errorDecision("no_tts_profile", false), { banner: "error_generic" });
  assert.deepEqual(errorDecision("turn_failed", true), { caption: "err_turn_failed" });
  for (const L of ["en", "es"]) for (const d of [errorDecision("bot_too_large", false), errorDecision("turn_failed", true)]) assert.ok(STRINGS[L][d.caption], `${L}.${d.caption}`);
  assert.notEqual(STRINGS.en.err_bot_too_large, STRINGS.en.err_turn_failed);
  // "paired" (or no mode) is the paired display; session mode is below.
  assert.deepEqual(errorDecision("bot_too_large", false, "paired"), { caption: "err_bot_too_large" });
  assert.deepEqual(errorDecision("no_bound_bot", false, "paired"), { banner: "no_bot" });
});

test("session mode error frames: no assistant AND assistant-too-large both show the banner that links to the Kiosk panel; the rest is unchanged", async () => {
  const { errorDecision } = await import("../bundles/kiosk/public/state.js");
  const { STRINGS } = await import("../bundles/kiosk/server/strings.js");
  assert.deepEqual(errorDecision("no_bound_bot", false, "session"), { banner: "session_no_bot" });
  assert.deepEqual(errorDecision("bot_too_large", false, "session"), { banner: "session_no_bot" });
  assert.deepEqual(errorDecision("no_tts_profile", false, "session"), { banner: "error_generic" });
  assert.deepEqual(errorDecision("turn_failed", true, "session"), { caption: "err_turn_failed" });
  for (const L of ["en", "es"]) { assert.ok(STRINGS[L].session_no_bot); assert.ok(STRINGS[L].session_bot_link); }
});

// ---- Session mode (the dashboard's Talk to Crow overlay, /display/session) ----

test("session mode: an ended login or a missing assistant halts with its own message — it never forgets a token or starts pairing", () => {
  assert.deepEqual(closeDecision(4401, "unauthorized", "session"), { action: "halt", banner: "session_expired" });
  assert.deepEqual(closeDecision(4403, "no_bot", "session"), { action: "halt", banner: "session_no_bot" });
  assert.deepEqual(closeDecision(4000, "superseded", "session"), { action: "halt", banner: "opened_elsewhere" });
  for (const [code, reason] of [[4401, "hello_timeout"], [1006, ""], [1011, "server_error"], [4403, ""]]) {
    assert.deepEqual(closeDecision(code, reason, "session"), { action: "reconnect" }, `${code} ${reason}`);
  }
  for (const [code, reason] of [[4401, "unauthorized"], [4401, "unpaired"], [4403, "no_bot"], [1006, ""]]) {
    assert.notEqual(closeDecision(code, reason, "session").action, "forget_token", `${code} ${reason}`);
  }
  // The paired page is unchanged, with or without the new argument.
  assert.equal(closeDecision(4401, "unauthorized", "paired").action, "forget_token");
  assert.equal(closeDecision(4403, "no_bot").action, "reconnect");
});

test("toolsLine: the turn's tool outcomes as one debug line — rounds joined by →, plus the display flags; only safe characters survive", async () => {
  const { toolsLine } = await import("../bundles/kiosk/public/state.js");
  assert.equal(toolsLine({ tools: ["crow_wm:unknown_command", "crow_wm:ok"] }), "crow_wm:unknown_command → crow_wm:ok");
  assert.equal(toolsLine({ tools: ["crow_projects:ok+crow_wm:placeholder"], display_corrected: true, display_missed: true, tool_choice: "named" }), "crow_projects:ok+crow_wm:placeholder · tool_choice named · corrected · display missed");
  assert.equal(toolsLine({ tools: [], display_missed: true, display_corrected: true, tool_choice: "none" }), "(no tool call) · tool_choice none · corrected · display missed");
  assert.equal(toolsLine({ tools: ["crow_wm:ok<script>", 7, null] }), "crow_wm:ok_script_");
  assert.equal(toolsLine({}), "");
  assert.equal(toolsLine(null), "");
});

test("theme setting: light/dark pin the page for paired and dashboard displays; auto keeps sleep hours (paired) and the OS scheme (dashboard)", () => {
  for (const session of [false, true]) for (const osDark of [false, true]) for (const night of [false, true]) {
    assert.equal(themeFor("dark", { session, osDark, night }), "dark");
    assert.equal(themeFor("light", { session, osDark, night }), "light");
    const auto = (session ? osDark : night) ? "dark" : "light";
    for (const pref of ["auto", undefined, "bogus"]) assert.equal(themeFor(pref, { session, osDark, night }), auto, `${pref} session=${session} osDark=${osDark} night=${night}`);
  }
});

test("applyTheme reads the theme setting, and a pushed config applies it without waiting for the clock", () => {
  const src = readFileSync(new URL("../bundles/kiosk/public/kiosk.js", import.meta.url), "utf8");
  assert.match(src, /function applyTheme\(\) \{[^\n]*themeFor\(config\.theme,/);
  assert.match(src, /if \(!clockTimer\) tickClock\(\); else applyTheme\(\);/);
});

// ── ducking (review C1): what the page knows after each way a turn can end ─────────────────────
test("duck rule: open while the mic is open, the server's bird is not idle, or TTS plays — never keyed on turn_done", () => {
  const duck = (turn, serverBird, playing = false) => duckDecision({ turnOpen: !!(turn && !turn.ended), serverBird, playing });
  // A tap: the mic opens before the server has said anything.
  assert.equal(duck({ ended: false, done: null }, "idle"), true, "ducked at the tap");
  // Empty turn: the page ended the mic (no speech), the server sends turn_over + state idle and no turn_done.
  assert.equal(duck({ ended: true, done: null }, "idle"), false, "an empty turn restores the music");
  // turn_busy: the server answers turn_over (busy); the page ends its turn; the bird is whatever the server says.
  assert.equal(duck({ ended: true, done: { aborted: true, over: "busy" } }, "idle"), false);
  // Socket closed mid-turn: onclose marks the turn ended and the bird idle.
  assert.equal(duck({ ended: true, done: null }, "idle"), false, "a dropped socket restores the music");
  // Thinking and speaking keep it ducked; the page's own TTS still draining keeps it ducked after the server said idle.
  assert.equal(duck({ ended: true, done: null }, "thinking"), true);
  assert.equal(duck({ ended: true, done: {} }, "idle", true), true);
  // Barge: TTS flushed, the server's speaking turned to idle on the page.
  assert.equal(duck({ ended: true, done: {}, barged: true }, "idle", false), false);
  // Follow-up with nothing said: the follow-up mic opens (ducked), the VAD ends it, the server says idle.
  assert.equal(duck({ ended: false, done: null, source: "follow_up" }, "listening"), true);
  assert.equal(duck({ ended: true, done: null, source: "follow_up" }, "idle"), false);
  assert.equal(duck(null, "idle"), false);
});

test("duck backstop: 30 s ducked with the bird idle and no TTS brings the music back; never while the bird is busy or TTS plays", () => {
  assert.equal(DUCK_BACKSTOP_MS, 30_000);
  assert.equal(duckBackstop({ duckedFor: 30_000, serverBird: "idle", playing: false }), true);
  assert.equal(duckBackstop({ duckedFor: 29_999, serverBird: "idle", playing: false }), false);
  assert.equal(duckBackstop({ duckedFor: 60_000, serverBird: "thinking", playing: false }), false);
  assert.equal(duckBackstop({ duckedFor: 60_000, serverBird: "idle", playing: true }), false);
});

test("effect time: the first wm/media change between turn_end and the turn's close; a load counts when it is heard (≤ 6 s)", () => {
  const t1 = { ended: false, done: null, effectAt: null, effectLoad: null, speechEndAt: 1000 };
  assert.equal(noteEffect(t1, { kind: "wm", at: 900 }), false, "before turn_end: not this turn's effect");
  t1.ended = true;
  assert.equal(noteEffect(t1, { kind: "wm", at: 1400 }), true);
  assert.equal(noteEffect(t1, { kind: "wm", at: 1500 }), false, "only the first");
  assert.equal(turnMetrics(t1).effect_ms, 400);
  // A load waits for its playing event.
  const t2 = { ended: true, done: null, effectAt: null, effectLoad: null, speechEndAt: 1000 };
  assert.equal(noteEffect(t2, { kind: "load", id: "m1", at: 1200 }), false);
  assert.equal(noteEffect(t2, { kind: "wm", at: 1300 }), false, "a window opened after the load does not count instead of the audio");
  t2.done = {};
  assert.equal(noteEffect(t2, { kind: "playing", id: "m2", at: 1500 }), false, "another item");
  assert.equal(noteEffect(t2, { kind: "playing", id: "m1", at: 2600 }), true, "after turn_done too: the audio is the effect");
  assert.equal(turnMetrics(t2).effect_ms, 1600);
  const t3 = { ended: true, done: null, effectAt: null, effectLoad: null, speechEndAt: 0 };
  noteEffect(t3, { kind: "load", id: "m1", at: 100 });
  assert.equal(noteEffect(t3, { kind: "playing", id: "m1", at: 100 + EFFECT_WAIT_MS + 1 }), false, "past the wait: no effect time");
  assert.equal(turnMetrics(t3).effect_ms, null);
  // A turn whose speech end is unknown (manual stop) is timed from turn_end.
  const t4 = { ended: true, done: null, effectAt: null, effectLoad: null, speechEndAt: null, endedAt: 50 };
  noteEffect(t4, { kind: "media", at: 80 });
  assert.equal(turnMetrics(t4).effect_ms, 30);
});

test("report waits for a pending load's playing event (up to 6 s), unless forced", () => {
  const t = { done: { timings: {} }, doneAt: 0, reported: false, tts: false, playAt: null, ended: true, effectAt: null, effectLoad: { id: "m1", at: 0 } };
  assert.deepEqual(reportDecision(t, { playing: false, now: 1000 }), { report: false, retryInMs: EFFECT_WAIT_MS - 1000 });
  assert.equal(reportDecision(t, { playing: false, now: EFFECT_WAIT_MS }).report, true);
  assert.equal(reportDecision(t, { playing: false, now: 10, force: true }).report, true);
  t.effectAt = 900;
  assert.equal(reportDecision(t, { playing: false, now: 1000 }).report, true);
});
