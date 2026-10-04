import { test } from "node:test";
import assert from "node:assert/strict";
import {
  closeDecision, backoffMs, micDecision, isNight, msToNextMinute,
  displayedBird, tapDecision, followUpDecision, reportDecision, turnMetrics, NO_AUDIO_WAIT_MS,
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

test("player: playing covers queued audio; drain fires once when the last source ends; flush never fires drain", async () => {
  const { ctx, started } = fakeCtx();
  const ev = { first: [], drained: 0 };
  const p = createPlayer(ctx, { onLevel() {}, onFirstPlay: (at, tag) => ev.first.push(tag), onDrained: () => ev.drained++ });
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
