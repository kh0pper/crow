import { test } from "node:test";
import assert from "node:assert/strict";
import { createVad, createPreroll, VAD_DEFAULTS } from "../bundles/kiosk/public/vad.js";
import { createDecimator, createFrameGate } from "../bundles/kiosk/public/resample.js";
import { e2eMs, playStartPerfTime } from "../bundles/kiosk/public/metrics.js";

const run = (vad, frames) => { let t = 1000; for (const rms of frames) { t += 20; const r = vad.push(rms, t); if (r.end) return { ...r, t }; } return null; };

test("speech then silence ends after the 450 ms default hangover (smoke lever 1); speechEndAt is the last voiced frame", () => {
  const r = run(createVad(), [...Array(25).fill(0.05), ...Array(40).fill(0.001)]);
  assert.equal(r.reason, "silence");
  assert.equal(r.speechEndAt, 1000 + 25 * 20);
  assert.ok(r.t - r.speechEndAt >= VAD_DEFAULTS.hangoverMs && r.t - r.speechEndAt < VAD_DEFAULTS.hangoverMs + 20, "ends on the first 20 ms frame past the hangover");
  assert.equal(VAD_DEFAULTS.hangoverMs, 450, "smoke 2026-10-04 lever 1: 600 → 450 ms");
});

test("pauses shorter than the hangover do not end the turn", () => {
  const r = run(createVad(), [...Array(10).fill(0.05), ...Array(20).fill(0.001), ...Array(10).fill(0.05), ...Array(40).fill(0.001)]);
  assert.equal(r.speechEndAt, 1000 + 40 * 20);
});

test("15 s cap (a TV in the room) and 8 s no-speech (a tap with nothing said)", () => {
  assert.equal(run(createVad(), Array(1000).fill(0.05)).reason, "max");
  const quiet = run(createVad(), Array(1000).fill(0.001));
  assert.equal(quiet.reason, "no_speech"); assert.equal(quiet.speechEndAt, null);
  assert.equal(run(createVad(), [0.05, 0.05, 0.05, ...Array(1000).fill(0.001)]).reason, "no_speech", "a 60 ms cough is not speech");
  const lever = run(createVad({ hangoverMs: 450 }), [...Array(25).fill(0.05), ...Array(40).fill(0.001)]);
  assert.ok(lever.t - 1500 >= 450 && lever.t - 1500 < 470, "lever 1 (450 ms) is one option; frame granularity is 20 ms");
});

test("pre-roll keeps the last 1.0 s (50 × 20 ms frames)", () => {
  const p = createPreroll();
  for (let i = 0; i < 80; i++) p.push(i);
  const d = p.drain();
  assert.equal(d.length, 50); assert.equal(d[0], 30); assert.equal(p.size, 0);
});

test("frame gate (in the worklet): nothing posted while idle; start(preroll) flushes the last 1.0 s first", () => {
  const posted = [];
  const g = createFrameGate((p) => posted.push(p));
  for (let i = 0; i < 80; i++) g.push(i, 0);
  assert.equal(posted.length, 0, "idle: no main-thread messages");
  assert.equal(g.ringSize, 50);
  g.start(true);
  assert.deepEqual(posted.slice(0, 2), [30, 31]); assert.equal(posted.length, 50);
  g.push(99, 0); assert.equal(posted.at(-1), 99);
  g.stop(); g.push(100, 0); assert.equal(posted.at(-1), 99);
  g.start(false); assert.equal(posted.at(-1), 99, "a tap sends no pre-roll");
});

test("decimator: 48 kHz and 44.1 kHz → 320-sample 16 kHz frames with the right RMS", () => {
  for (const rate of [48000, 44100]) {
    const frames = [];
    const push = createDecimator(rate, (pcm, rms) => frames.push({ n: pcm.length, rms }));
    const s = new Float32Array(rate);
    for (let i = 0; i < rate; i++) s[i] = 0.5 * Math.sin((2 * Math.PI * 200 * i) / rate);
    for (let i = 0; i < rate; i += 128) push(s.subarray(i, i + 128));
    assert.ok(frames.length >= 49 && frames.length <= 50, `${rate}: ${frames.length}`);
    assert.ok(frames.every((f) => f.n === 320));
    assert.ok(Math.abs(frames[10].rms - 0.5 / Math.SQRT2) < 0.03, `${rate}: rms ${frames[10].rms}`);
  }
});

test("latency arithmetic: play start maps audio-clock time to performance time and adds output latency", () => {
  assert.equal(playStartPerfTime({ nowPerf: 5000, ctxCurrentTime: 10, startWhen: 10.05, outputLatency: 0.02 }), 5070);
  assert.equal(e2eMs({ speechEndAt: 3200, playAt: 5070 }), 1870);
  assert.equal(e2eMs({ speechEndAt: null, playAt: 5070 }), null);
});

test("lever D: pause fires ONCE, pauseMs into a silence after real speech; resumed voice re-arms it; never before speech", () => {
  const v = createVad();
  let t = 1000; const out = [];
  const feed = (rms, n) => { for (let i = 0; i < n; i++) { t += 20; const r = v.push(rms, t); out.push(r); if (r.end) return r; } return null; };
  feed(0.001, 20);
  assert.ok(!out.some((r) => r.pause), "silence before any speech never pauses");
  feed(0.05, 15);                                  // 300 ms of speech
  assert.ok(out.slice(-15).every((r) => r.voiced));
  const speechEnd = t;
  feed(0.001, 10);                                 // 200 ms of silence
  const p1 = out.filter((r) => r.pause);
  assert.equal(p1.length, 1);
  assert.equal(p1[0].speechEndAt, speechEnd);
  feed(0.05, 5);                                   // voice resumes before the hangover
  feed(0.001, 10);
  assert.equal(out.filter((r) => r.pause).length, 2, "a new silence pauses again");
  const end = feed(0.001, 40);
  assert.equal(end.reason, "silence");
  assert.equal(VAD_DEFAULTS.pauseMs, 120);
  assert.ok(VAD_DEFAULTS.pauseMs < VAD_DEFAULTS.hangoverMs);
  const off = createVad({ hangoverMs: 100 });      // pause >= hangover: no pause, just the end
  t = 1000; out.length = 0;
  const v2 = off; for (let i = 0; i < 15; i++) { t += 20; v2.push(0.05, t); }
  let r2; for (let i = 0; i < 20 && !(r2 = v2.push(0.001, (t += 20))).end;) { assert.ok(!r2.pause); i++; }
});
