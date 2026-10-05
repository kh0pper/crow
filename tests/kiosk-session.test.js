import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createSessionHub, HELLO_TIMEOUT_MS, MAX_TURN_BYTES, EARLY_STT_WAIT_MS } from "../bundles/kiosk/server/session.js";
import { createMetricsStore } from "../bundles/kiosk/server/metrics.js";
import { createWmStore } from "../bundles/kiosk/server/wm.js";
import { wrapPcmAsWav } from "../servers/gateway/voice/turn-helpers.js";

class FakeWs extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.sent = []; this.closed = null; }
  send(d) { this.sent.push(d); }
  close(code, reason) { if (this.closed) return; this.closed = { code, reason }; this.readyState = 3; this.emit("close"); }
  text(o) { this.emit("message", Buffer.from(JSON.stringify(o)), false); }
  bin(b) { this.emit("message", b, true); }
  msgs() { return this.sent.filter((d) => typeof d === "string").map((d) => JSON.parse(d)); }
}
const tick = () => new Promise((r) => setImmediate(r));
const DEV = { id: "kiosk-a", name: "Kitchen", device_kind: "kiosk", bound_bot_id: "household", kiosk_settings: { lang: "en" } };

function hub(over = {}) {
  const timers = [];
  const turns = [];
  const metrics = createMetricsStore();
  const logs = [];
  const wm = createWmStore({ setTimer: () => ({}), clearTimer: () => {} }); // no real timers: a 120 s timer would hold the test process open
  const h = createSessionHub({
    verifyKiosk: over.verifyKiosk || (async (id, tok) => (id === "kiosk-a" && tok === "good" ? { ...DEV } : null)),
    displayConfig: over.displayConfig || (async (d) => ({ name: d.name, bird: { species: "crow", seed: 0, mood: "happy" } })),
    runTurn: over.runTurn || (async (o) => { turns.push(o); o.sink.event({ type: "transcript_final", text: "hi" }); o.sink.event({ type: "tts_start", codec: "pcm", sample_rate: 24000 }); o.sink.audio(Buffer.alloc(4)); o.sink.event({ type: "tts_end" }); return { route: "fast", fastPath: false, escalated: false, aborted: false, degraded: null, timings: { total_ms: 5 } }; }),
    speak: over.speak || (async ({ text, sink }) => { sink.event({ type: "tts_start", codec: "pcm", sample_rate: 24000 }); sink.audio(Buffer.from(text)); sink.event({ type: "tts_end" }); }),
    wm, metrics, wrapPcmAsWav,
    warmup: over.warmup || (async () => {}),
    transcribe: over.transcribe || null,
    ...(over.storeProfile ? { storeProfile: over.storeProfile } : {}),
    setTimeout: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.cleared = true; },
    now: () => 42,
    log: (l) => logs.push(l),
  });
  return { h, timers, turns, metrics, wm, logs };
}
async function hello(h, ws = new FakeWs()) { h.attach(ws); ws.text({ type: "hello", device_id: "kiosk-a", token: "good", caps: { windows: ["timer", "recipe", "content"] } }); await tick(); return ws; }

test("no hello within 5 s → 4401 hello_timeout", () => {
  const { h, timers } = hub(); const ws = new FakeWs(); h.attach(ws);
  assert.equal(timers[0].ms, HELLO_TIMEOUT_MS);
  timers[0].fn();
  assert.deepEqual(ws.closed, { code: 4401, reason: "hello_timeout" });
});

test("bad token, wrong first frame, or binary before hello → 4401 unauthorized", async () => {
  for (const first of [{ type: "hello", device_id: "kiosk-a", token: "bad" }, { type: "turn_start" }]) {
    const { h } = hub(); const ws = new FakeWs(); h.attach(ws); ws.text(first); await tick();
    assert.deepEqual(ws.closed, { code: 4401, reason: "unauthorized" });
  }
  const { h } = hub(); const ws = new FakeWs(); h.attach(ws); ws.bin(Buffer.alloc(640));
  assert.deepEqual(ws.closed, { code: 4401, reason: "unauthorized" });
});

test("hello → ready (display_config, server_now), wm snapshot, idle; warm-up kicked", async () => {
  let warmed = 0;
  const { h, timers } = hub({ warmup: async () => { warmed++; } });
  const ws = await hello(h);
  const types = ws.msgs().map((m) => m.type);
  assert.deepEqual(types, ["ready", "wm", "state"]);
  assert.equal(ws.msgs()[0].server_now, 42);
  assert.equal(ws.msgs()[1].action, "snapshot");
  assert.equal(timers[0].cleared, true);
  assert.equal(warmed, 1);
  assert.equal(h.isConnected("kiosk-a"), true);
});

test("a turn: frames → one WAV of exactly those frames → events + audio → turn_done → idle", async () => {
  const { h, turns, metrics, logs } = hub();
  const ws = await hello(h);
  ws.text({ type: "turn_start", source: "tap", turn_id: "t1" });
  const f = Buffer.alloc(640, 7);
  for (let i = 0; i < 20; i++) ws.bin(f);
  ws.text({ type: "turn_end", vad_reason: "silence" });
  await tick(); await tick();
  assert.equal(turns.length, 1);
  assert.deepEqual(turns[0].audio, wrapPcmAsWav(Buffer.concat(Array(20).fill(f)), 16000));
  const m = ws.msgs();
  assert.deepEqual(m.filter((x) => x.type === "state").map((x) => x.bird), ["idle", "listening", "thinking", "speaking", "idle"]);
  assert.equal(m.find((x) => x.type === "turn_done").turn_id, "t1");
  assert.equal(ws.sent.filter((d) => Buffer.isBuffer(d)).length, 1);
  ws.text({ type: "turn_metrics", turn_id: "t1", e2e_ms: 1500, vad_reason: "silence", output_latency_ms: 20 });
  assert.equal(metrics.list("kiosk-a")[0].e2e_ms, 1500);
  const line = logs.find((l) => l.startsWith("[kiosk-metrics] "));
  assert.ok(line.includes('"e2e_ms":1500') && line.includes('"route":"fast"'), line);
  assert.equal(metrics.summary("kiosk-a").n, 1);
});

test("over 1 MiB of audio → audio_too_long, no turn; under 200 ms → empty_transcript, no turn", async () => {
  const { h, turns } = hub();
  const ws = await hello(h);
  ws.text({ type: "turn_start", turn_id: "t2" });
  for (let i = 0; i <= MAX_TURN_BYTES / 65536; i++) ws.bin(Buffer.alloc(65536));
  ws.text({ type: "turn_end" });
  await tick();
  assert.ok(ws.msgs().some((m) => m.type === "error" && m.code === "audio_too_long"));
  ws.text({ type: "turn_start", turn_id: "t3" }); ws.bin(Buffer.alloc(640)); ws.text({ type: "turn_end" }); await tick();
  assert.ok(ws.msgs().some((m) => m.type === "error" && m.code === "empty_transcript"));
  assert.equal(turns.length, 0);
});

test("busy: a second turn_start during a turn → turn_busy; barge_in aborts and later audio is dropped", async () => {
  let release;
  const { h } = hub({ runTurn: (o) => new Promise((r) => { release = () => { o.sink.audio(Buffer.alloc(8)); r({ route: "fast", aborted: o.signal.aborted, timings: {} }); }; o.signal.addEventListener("abort", () => {}); }) });
  const ws = await hello(h);
  ws.text({ type: "turn_start", turn_id: "a" }); ws.bin(Buffer.alloc(8000)); ws.text({ type: "turn_end" }); await tick();
  ws.text({ type: "turn_start", turn_id: "b" });
  assert.ok(ws.msgs().some((m) => m.code === "turn_busy"));
  ws.text({ type: "barge_in" });
  release(); await tick();
  assert.equal(ws.sent.filter((d) => Buffer.isBuffer(d)).length, 0, "audio after barge-in never leaves");
  assert.equal(ws.msgs().find((m) => m.type === "turn_done").aborted, true);
});

test("second hello for the same display supersedes the first with 4000", async () => {
  const { h } = hub();
  const a = await hello(h);
  const b = await hello(h);
  assert.deepEqual(a.closed, { code: 4000, reason: "superseded" });
  assert.equal(b.closed, null);
  assert.equal(h.isConnected("kiosk-a"), true, "the new session stays registered after the old one's close");
});

test("close during a turn aborts it; reconnect gets the timer in the snapshot", async () => {
  let seen;
  const { h, wm } = hub({ runTurn: (o) => new Promise((r) => { seen = o.signal; o.signal.addEventListener("abort", () => r({ route: "fast", aborted: true, timings: {} })); }) });
  wm.open("kiosk-a", { kind: "timer", name: "Tea", title: "Tea", seconds: 120 });
  const ws = await hello(h);
  ws.text({ type: "turn_start" }); ws.bin(Buffer.alloc(8000)); ws.text({ type: "turn_end" }); await tick();
  ws.close(1006, "");
  assert.equal(seen.aborted, true);
  const ws2 = await hello(h);
  assert.equal(ws2.msgs().find((m) => m.type === "wm").windows[0].name, "Tea");
});

test("unpair closes the live session 4401 unpaired; wm_event dismissed closes server-side", async () => {
  const { h, wm } = hub();
  const ws = await hello(h);
  const { window } = wm.open("kiosk-a", { kind: "content", title: "N", blocks: [] });
  ws.text({ type: "wm_event", id: window.id, kind: "dismissed" });
  assert.equal(wm.list("kiosk-a").length, 0);
  assert.ok(ws.msgs().some((m) => m.type === "wm" && m.action === "close" && m.id === window.id));
  wm.open("kiosk-a", { kind: "content", title: "A", blocks: [] }); wm.open("kiosk-a", { kind: "content", title: "B", blocks: [] });
  ws.text({ type: "wm_event", kind: "close_all" });
  assert.equal(wm.list("kiosk-a").length, 0, "long-press close-all");
  h.closeDevice("kiosk-a", 4401, "unpaired");
  assert.deepEqual(ws.closed, { code: 4401, reason: "unpaired" });
  assert.equal(h.isConnected("kiosk-a"), false);
});

test("speak while a turn is running is queued and played after the turn", async () => {
  let release;
  const { h } = hub({ runTurn: (o) => new Promise((r) => { release = () => r({ route: "fast", aborted: false, timings: {} }); }) });
  const ws = await hello(h);
  ws.text({ type: "turn_start" }); ws.bin(Buffer.alloc(8000)); ws.text({ type: "turn_end" }); await tick();
  assert.equal(h.speak("kiosk-a", "Tea timer is done."), true);
  assert.equal(ws.sent.filter((d) => Buffer.isBuffer(d)).length, 0);
  release(); await tick(); await tick();
  assert.equal(Buffer.concat(ws.sent.filter((d) => Buffer.isBuffer(d))).toString(), "Tea timer is done.");
});

test("metrics: median/p90 count only fast, non-fast-path, non-escalated, silence-ended, unaborted turns", () => {
  const m = createMetricsStore();
  const add = (id, e2e, r = {}) => { m.serverTurn("d", id, { route: "fast", fastPath: false, escalated: false, aborted: false, timings: {}, ...r }); m.clientTurn("d", { turn_id: id, e2e_ms: e2e, vad_reason: r.vad || "silence" }); };
  [1000, 1200, 1400, 1600, 1800, 2000, 2200, 2400, 2600, 3500].forEach((v, i) => add("t" + i, v));
  add("x1", 9000, { escalated: true }); add("x2", 9000, { fastPath: true }); add("x3", 9000, { vad: "max" }); add("x4", 9000, { route: "escalate" }); add("x5", 900, { degraded: "cold_timeout" });
  const s = m.summary("d");
  assert.equal(s.n, 10); assert.equal(s.median_ms, 1900); assert.equal(s.p90_ms, 2600); assert.equal(s.no_audio, 0);
  add("silent", null);
  const t = m.summary("d", { last: 20 });
  assert.equal(t.n, 11); assert.equal(t.no_audio, 1); assert.equal(t.p90_ms, 3500, "a turn with no audio counts as a failure, not a gap");
});

test("stall fix: a fallback turn reports failed on turn_done and in the [kiosk-metrics] line (tool names ride in timings)", async () => {
  const { h, metrics, logs } = hub({ runTurn: async (o) => ({ route: "fast", fastPath: false, escalated: false, aborted: false, degraded: null, failed: "tool_repeat", timings: { total_ms: 9, failed: "tool_repeat", tools: ["crow_projects", "crow_projects"] } }) });
  const ws = await hello(h);
  ws.text({ type: "turn_start", turn_id: "f1" });
  for (let i = 0; i < 20; i++) ws.bin(Buffer.alloc(640, 7));
  ws.text({ type: "turn_end", vad_reason: "silence" });
  await tick(); await tick();
  assert.equal(ws.msgs().find((x) => x.type === "turn_done").failed, "tool_repeat");
  assert.equal(metrics.list("kiosk-a")[0].failed, "tool_repeat");
  ws.text({ type: "turn_metrics", turn_id: "f1", e2e_ms: 2100, vad_reason: "silence" });
  const line = logs.find((l) => l.startsWith("[kiosk-metrics] "));
  assert.ok(line.includes('"failed":"tool_repeat"') && line.includes('"tools":["crow_projects","crow_projects"]'), line);
  // A normal turn reports failed: null.
  const ok = hub();
  const w2 = await hello(ok.h);
  w2.text({ type: "turn_start", turn_id: "o1" });
  for (let i = 0; i < 20; i++) w2.bin(Buffer.alloc(640, 7));
  w2.text({ type: "turn_end", vad_reason: "silence" });
  await tick(); await tick();
  assert.equal(w2.msgs().find((x) => x.type === "turn_done").failed, null);
});

test("stall fix: a turn that ended on the fallback line is a gate FAILURE even though it played audio", () => {
  const m = createMetricsStore();
  const add = (id, e2e, failed = null) => { m.serverTurn("d", id, { route: "fast", fastPath: false, escalated: false, aborted: false, failed, timings: failed ? { failed } : {} }); m.clientTurn("d", { turn_id: id, e2e_ms: e2e, vad_reason: "silence" }); };
  add("a", 1000); add("b", 1200); add("c", 12500, "budget"); add("d", 1400, "tool_repeat");
  const s = m.summary("d");
  assert.equal(s.n, 4);
  assert.equal(s.no_audio, 2, "both fallback turns count as failures");
  assert.equal(s.p90_ms, Infinity, "a failure, not a fast fallback");
  assert.equal(m.list("d").find((r) => r.turn_id === "d").failed, "tool_repeat");
});

test("metrics: a barged client turn is not gate-eligible; barged is recorded; null e2e stays a failure", () => {
  const m = createMetricsStore();
  const add = (id, e2e, extra = {}) => { m.serverTurn("d", id, { route: "fast", fastPath: false, escalated: false, aborted: false, timings: {} }); return m.clientTurn("d", { turn_id: id, e2e_ms: e2e, vad_reason: "silence", ...extra }); };
  add("a", 1000); add("b", 1200);
  const r = add("c", 9000, { barged: true });
  assert.equal(r.barged, true);
  assert.equal(add("d", 1100).barged, false);
  const s = m.summary("d");
  assert.equal(s.n, 3, "barged turn excluded");
  assert.equal(s.p90_ms, 1200);
  add("e", null);
  assert.equal(m.summary("d").no_audio, 1, "null e2e still counted as a failure");
});

test("unpair clears the device's server windows/timers (even if offline); supersede and reconnect do not", async () => {
  const cleared = [];
  const timers = [];
  const wm = createWmStore({ setTimer: () => { const t = {}; timers.push(t); return t; }, clearTimer: (t) => cleared.push(t) });
  const { h } = hub();
  // rebuild a hub that shares our wm
  const h2 = createSessionHub({
    verifyKiosk: async (id, tok) => (id === "kiosk-a" && tok === "good" ? { ...DEV } : null),
    displayConfig: async () => ({}), runTurn: async () => ({}), speak: async () => {}, wm, metrics: createMetricsStore(), wrapPcmAsWav,
    warmup: async () => {}, setTimeout: () => ({}), clearTimeout: () => {}, now: () => 1, log: () => {},
  });
  wm.open("kiosk-a", { kind: "timer", name: "Tea", title: "Tea", seconds: 120 });
  const a = await hello(h2);
  const b = await hello(h2); // supersede
  assert.deepEqual(a.closed, { code: 4000, reason: "superseded" });
  b.close(1006, ""); // network drop
  assert.equal(wm.list("kiosk-a").length, 1, "supersede + network close keep windows");
  assert.equal(cleared.length, 0);
  h2.closeDevice("kiosk-a", 4401, "unpaired"); // offline now
  assert.equal(wm.list("kiosk-a").length, 0);
  assert.equal(cleared.length, 1, "timer cleared");
  assert.ok(h);
});

test("server errors during hello close 1011 server_error, never 4401; bad token still 4401", async () => {
  for (const over of [{ verifyKiosk: async () => { throw new Error("db locked"); } }, { displayConfig: async () => { throw new Error("boom"); } }]) {
    const { h, logs } = hub(over); const ws = await hello(h);
    assert.deepEqual(ws.closed, { code: 1011, reason: "server_error" });
    assert.ok(logs.some((l) => l.includes("[kiosk]")));
  }
  const { h } = hub(); const ws = new FakeWs(); h.attach(ws); ws.text({ type: "hello", device_id: "kiosk-a", token: "bad" }); await tick();
  assert.deepEqual(ws.closed, { code: 4401, reason: "unauthorized" });
});

function speechHub() {
  const gates = []; const calls = [];
  const r = hub({ speak: ({ text, sink, signal }) => new Promise((res) => {
    calls.push(text);
    gates.push({ emit: () => sink.audio(Buffer.from(text)), done: res, signal });
  }) });
  return { ...r, gates, calls };
}

test("barge_in during speech aborts it: no more audio frames", async () => {
  const { h, gates } = speechHub(); const ws = await hello(h);
  h.speak("kiosk-a", "one"); await tick();
  gates[0].emit();
  ws.text({ type: "barge_in" });
  assert.equal(gates[0].signal.aborted, true);
  gates[0].emit(); gates[0].done(); await tick();
  assert.equal(ws.sent.filter((d) => Buffer.isBuffer(d)).length, 1);
});

test("two concurrent speak() calls are serialized, not interleaved", async () => {
  const { h, gates, calls } = speechHub(); const ws = await hello(h);
  h.speak("kiosk-a", "one"); h.speak("kiosk-a", "two"); await tick();
  assert.deepEqual(calls, ["one"], "second waits");
  gates[0].emit(); gates[0].done(); await tick(); await tick();
  assert.deepEqual(calls, ["one", "two"]);
  gates[1].emit(); gates[1].done(); await tick();
  assert.equal(Buffer.concat(ws.sent.filter((d) => Buffer.isBuffer(d))).toString(), "onetwo");
});

test("turn_start during speech aborts the speech, then the turn runs", async () => {
  const { h, gates, turns } = speechHub(); const ws = await hello(h);
  h.speak("kiosk-a", "one"); await tick();
  ws.text({ type: "turn_start", turn_id: "t9" });
  assert.equal(gates[0].signal.aborted, true);
  gates[0].emit(); // late audio from the aborted speech never leaves
  assert.equal(ws.sent.filter((d) => Buffer.isBuffer(d)).length, 0);
  ws.bin(Buffer.alloc(8000)); ws.text({ type: "turn_end" }); gates[0].done(); await tick(); await tick();
  assert.equal(turns.length, 1);
});

// Task 10 carry: speech queued while the mic was open (inTurn) must not be
// stranded when the turn ends without running (empty / oversize audio).
test("speech queued during listening plays after an empty_transcript or audio_too_long turn end", async () => {
  {
    const { h } = hub(); const ws = await hello(h);
    ws.text({ type: "turn_start", turn_id: "e1" });
    assert.equal(h.speak("kiosk-a", "Tea timer is done."), true);
    assert.equal(ws.sent.filter((d) => Buffer.isBuffer(d)).length, 0, "not spoken while listening");
    ws.bin(Buffer.alloc(640)); ws.text({ type: "turn_end" }); await tick(); await tick();
    assert.ok(ws.msgs().some((m) => m.type === "error" && m.code === "empty_transcript"));
    assert.equal(Buffer.concat(ws.sent.filter((d) => Buffer.isBuffer(d))).toString(), "Tea timer is done.");
  }
  {
    const { h } = hub(); const ws = await hello(h);
    ws.text({ type: "turn_start", turn_id: "e2" });
    assert.equal(h.speak("kiosk-a", "Pasta timer is done."), true);
    for (let i = 0; i <= MAX_TURN_BYTES / 65536; i++) ws.bin(Buffer.alloc(65536));
    await tick(); await tick();
    assert.ok(ws.msgs().some((m) => m.type === "error" && m.code === "audio_too_long"));
    assert.equal(Buffer.concat(ws.sent.filter((d) => Buffer.isBuffer(d))).toString(), "Pasta timer is done.");
  }
});

// Final-review item 1: a tap with nothing said never reaches STT (whisper
// hallucinates "Thank you." on room noise → a ghost reply).
test("turn_end with vad_reason no_speech discards the audio: empty_transcript, idle, no STT turn; queued speech drains", async () => {
  const { h, turns, logs } = hub(); const ws = await hello(h);
  ws.text({ type: "turn_start", turn_id: "ns1" });
  assert.equal(h.speak("kiosk-a", "Tea timer is done."), true);
  for (let i = 0; i < 400; i++) ws.bin(Buffer.alloc(640, 3));   // 8 s of room noise, far over MIN_TURN_BYTES
  ws.text({ type: "turn_end", vad_reason: "no_speech" });
  await tick(); await tick();
  assert.equal(turns.length, 0, "no STT/LLM turn ran");
  const m = ws.msgs();
  assert.ok(m.some((x) => x.type === "error" && x.code === "empty_transcript" && x.recoverable));
  assert.ok(!m.some((x) => x.type === "turn_done"));
  assert.deepEqual(m.filter((x) => x.type === "state").map((x) => x.bird), ["idle", "listening", "idle"]);
  assert.ok(logs.some((l) => /^\[kiosk\] empty turn on kiosk-a \(no speech\): caption only$/.test(l)), "smoke 2026-10-04: the silent-tap path is logged server-side");
  assert.equal(Buffer.concat(ws.sent.filter((d) => Buffer.isBuffer(d))).toString(), "Tea timer is done.", "speech held during listening still plays");
  // and the next real turn is unaffected
  ws.text({ type: "turn_start", turn_id: "ns2" });
  for (let i = 0; i < 20; i++) ws.bin(Buffer.alloc(640, 7));
  ws.text({ type: "turn_end", vad_reason: "silence" });
  await tick(); await tick();
  assert.equal(turns.length, 1);
  assert.equal(turns[0].audio.length, 44 + 20 * 640, "only the second turn's frames");
});

// Final-review item 3: a panel save reaches an open page.
test("pushConfig re-sends ready with fresh display_config to the live session; offline → false", async () => {
  let n = 0;
  const { h } = hub({ displayConfig: async (d) => ({ name: d.name, follow_up: d.kiosk_settings?.follow_up ?? false, n: ++n }) });
  assert.equal(await h.pushConfig("kiosk-a"), false, "offline");
  const ws = await hello(h);
  h.refreshDevice("kiosk-a", { kiosk_settings: { lang: "en", follow_up: true } });
  assert.equal(await h.pushConfig("kiosk-a"), true);
  const readies = ws.msgs().filter((m) => m.type === "ready");
  assert.equal(readies.length, 2);
  assert.deepEqual(readies[1].display_config, { name: "Kitchen", follow_up: true, n: 2 });
  assert.equal(readies[1].server_now, 42);
  assert.equal(h.deviceOf("kiosk-a").kiosk_settings.follow_up, true);
  assert.equal(h.deviceOf("nope"), null);
});

// Lever D (early STT): the page sends speech_pause ~120 ms into a silence; the server transcribes the
// audio so far while the hangover runs, and uses it only if no voiced frame came after the snapshot.
function deferred() { let resolve, reject; const p = new Promise((a, b) => { resolve = a; reject = b; }); return { p, resolve, reject }; }
function earlyHub() {
  const stt = [];
  const t = hub({ transcribe: (o) => { const d = deferred(); stt.push({ ...o, d }); return d.p; } });
  return { ...t, stt };
}
const F = Buffer.alloc(640, 5);   // one 20 ms frame

test("lever D: speech_pause starts STT on the audio so far; a turn_end with no later voice uses it — no second transcription", async () => {
  const { h, turns, stt } = earlyHub(); const ws = await hello(h);
  ws.text({ type: "turn_start", turn_id: "e1" });
  for (let i = 0; i < 30; i++) ws.bin(F);
  ws.text({ type: "speech_pause" });
  await tick();
  assert.equal(stt.length, 1);
  assert.equal(stt[0].audio.length, 44 + 30 * 640, "the snapshot is what had arrived");
  for (let i = 0; i < 17; i++) ws.bin(Buffer.alloc(640));        // the rest of the hangover: silence
  ws.text({ type: "turn_end", vad_reason: "silence", voiced_bytes: 30 * 640 });
  await tick();
  assert.equal(turns.length, 0, "the turn waits for the early transcript");
  stt[0].d.resolve({ text: "What is the capital of Portugal?" });
  await tick(); await tick();
  assert.equal(turns.length, 1);
  assert.equal(turns[0].transcript, "What is the capital of Portugal?");
  assert.deepEqual({ ...turns[0].sttEarly, ms: undefined }, { used: true, ms: undefined, discards: 0, discard_ms: 0 });
  assert.equal(typeof turns[0].startedAt, "number");
  assert.equal(stt[0].signal.aborted, false);
});

test("lever D: speech resumed after the pause → the early transcript is discarded (aborted) and the full audio is transcribed", async () => {
  const { h, turns, stt } = earlyHub(); const ws = await hello(h);
  ws.text({ type: "turn_start", turn_id: "e2" });
  for (let i = 0; i < 20; i++) ws.bin(F);
  ws.text({ type: "speech_pause" });
  await tick();
  for (let i = 0; i < 25; i++) ws.bin(F);                          // "...and Spain?" — voice again
  ws.text({ type: "turn_end", vad_reason: "silence", voiced_bytes: 45 * 640 });
  await tick(); await tick();
  assert.equal(stt[0].signal.aborted, true, "the partial is dropped");
  assert.equal(turns.length, 1);
  assert.equal(turns[0].transcript, null, "the turn transcribes the whole utterance itself");
  assert.equal(turns[0].audio.length, 44 + 45 * 640);
  assert.deepEqual(turns[0].sttEarly, { used: false, discards: 1, discard_ms: 0 });
});

test("lever D: one early STT at a time — a newer pause while one runs waits, then transcribes the newest pause's audio; the newest wins", async () => {
  const { h, turns, stt } = earlyHub(); const ws = await hello(h);
  ws.text({ type: "turn_start", turn_id: "e3" });
  for (let i = 0; i < 20; i++) ws.bin(F);
  ws.text({ type: "speech_pause" });
  await tick();
  for (let i = 0; i < 10; i++) ws.bin(F);
  ws.text({ type: "speech_pause" });
  await tick();
  assert.equal(stt.length, 1, "whisper cannot cancel: never two in flight");
  stt[0].d.resolve({ text: "What is" });
  await tick(); await tick();
  assert.equal(stt.length, 2, "the wanted one starts when the first settles");
  assert.equal(stt[1].audio.length, 44 + 30 * 640);
  ws.text({ type: "turn_end", vad_reason: "silence", voiced_bytes: 30 * 640 });
  stt[1].d.resolve({ text: "What is the time?" });
  await tick(); await tick(); await tick();
  assert.equal(turns[0].transcript, "What is the time?");
  assert.deepEqual({ ...turns[0].sttEarly, ms: undefined }, { used: true, ms: undefined, discards: 1, discard_ms: 0 });
});

test("lever D: a failed early STT falls back to transcribing; no_speech and close abort it; without speech_pause nothing changes", async () => {
  const a = earlyHub(); const wa = await hello(a.h);
  wa.text({ type: "turn_start", turn_id: "f1" });
  for (let i = 0; i < 20; i++) wa.bin(F);
  wa.text({ type: "speech_pause" }); await tick();
  wa.text({ type: "turn_end", vad_reason: "silence", voiced_bytes: 20 * 640 });
  a.stt[0].d.reject(new Error("ECONNRESET"));
  await tick(); await tick(); await tick();
  assert.equal(a.turns[0].transcript, null);
  assert.equal(a.turns[0].sttEarly.used, false);
  assert.ok(a.logs.some((l) => /early STT unusable/.test(l)));

  const b = earlyHub(); const wb = await hello(b.h);
  wb.text({ type: "turn_start", turn_id: "f2" });
  for (let i = 0; i < 20; i++) wb.bin(F);
  wb.text({ type: "speech_pause" }); await tick();
  wb.close(1006, "");
  assert.equal(b.stt[0].signal.aborted, true, "a closed socket drops its early STT");

  const c = earlyHub(); const wc = await hello(c.h);
  wc.text({ type: "turn_start", turn_id: "f3" });
  for (let i = 0; i < 3; i++) wc.bin(F);
  wc.text({ type: "speech_pause" }); await tick();
  assert.equal(c.stt.length, 0, "under MIN_TURN_BYTES: no early STT");
  for (let i = 0; i < 20; i++) wc.bin(F);
  wc.text({ type: "turn_end", vad_reason: "silence", voiced_bytes: 23 * 640 });
  await tick(); await tick();
  assert.equal(c.turns[0].transcript, null);
  assert.deepEqual(c.turns[0].sttEarly, { used: false, discards: 0, discard_ms: 0 });
});

test("review I1: a barge-in while the turn waits for its early transcript ends the turn at once — no LLM turn, no turn_failed, not busy", async () => {
  const { h, turns, stt } = earlyHub(); const ws = await hello(h);
  ws.text({ type: "turn_start", turn_id: "b1" });
  for (let i = 0; i < 20; i++) ws.bin(F);
  ws.text({ type: "speech_pause" }); await tick();
  ws.text({ type: "turn_end", vad_reason: "silence", voiced_bytes: 20 * 640 });
  await tick();
  ws.text({ type: "barge_in" });
  await tick(); await tick();
  assert.equal(stt[0].signal.aborted, true, "the whisper request is cancelled with the turn");
  assert.equal(turns.length, 0);
  const m = ws.msgs();
  assert.ok(!m.some((x) => x.type === "error" && x.code === "turn_failed"));
  assert.equal(m.filter((x) => x.type === "turn_done").at(-1).aborted, true);
  ws.text({ type: "turn_start", turn_id: "b2" });
  assert.ok(!ws.msgs().some((x) => x.code === "turn_busy"), "the next tap is not refused");
});

test("review I1: a wedged early STT is capped — after EARLY_STT_WAIT_MS the turn transcribes the audio itself", async () => {
  const { h, turns, stt, timers } = earlyHub(); const ws = await hello(h);
  ws.text({ type: "turn_start", turn_id: "c1" });
  for (let i = 0; i < 20; i++) ws.bin(F);
  ws.text({ type: "speech_pause" }); await tick();
  ws.text({ type: "turn_end", vad_reason: "silence", voiced_bytes: 20 * 640 });
  await tick();
  const cap = timers.find((t) => t.ms === EARLY_STT_WAIT_MS);
  assert.ok(cap, "a cap timer is armed");
  cap.fn();
  await tick(); await tick();
  assert.equal(stt[0].signal.aborted, true);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].transcript, null);
  assert.equal(turns[0].sttEarly.used, false);
});

test("review minor: an EMPTY early transcript is not trusted — the full audio is transcribed", async () => {
  const { h, turns, stt } = earlyHub(); const ws = await hello(h);
  ws.text({ type: "turn_start", turn_id: "m1" });
  for (let i = 0; i < 20; i++) ws.bin(F);
  ws.text({ type: "speech_pause" }); await tick();
  ws.text({ type: "turn_end", vad_reason: "silence", voiced_bytes: 20 * 640 });
  stt[0].d.resolve({ text: "  " });
  await tick(); await tick(); await tick();
  assert.equal(turns[0].transcript, null);
  assert.equal(turns[0].sttEarly.used, false);
});

test("review I2: a queued early STT transcribes the audio AS OF its pause, not the later mid-word audio", async () => {
  const { h, turns, stt } = earlyHub(); const ws = await hello(h);
  ws.text({ type: "turn_start", turn_id: "q1" });
  for (let i = 0; i < 20; i++) ws.bin(F);
  ws.text({ type: "speech_pause" }); await tick();
  for (let i = 0; i < 10; i++) ws.bin(F);
  ws.text({ type: "speech_pause" }); await tick();                 // snapshot = 30 frames
  for (let i = 0; i < 8; i++) ws.bin(F);                            // more speech while the first STT runs
  stt[0].d.resolve({ text: "What" });
  await tick(); await tick();
  assert.equal(stt.length, 2);
  assert.equal(stt[1].audio.length, 44 + 30 * 640, "exactly the second pause's slice");
  ws.text({ type: "turn_end", vad_reason: "silence", voiced_bytes: 38 * 640 });
  await tick(); await tick();
  assert.equal(stt[1].signal.aborted, true, "speech after that pause → discarded");
  assert.equal(turns[0].transcript, null);
  assert.equal(turns[0].sttEarly.discards, 2);
});

test("hello tz: the page's IANA time zone reaches every turn; a missing or invalid one is null (the server's zone is used)", async () => {
  const run = async (tz) => {
    const { h, turns } = hub();
    const ws = new FakeWs();
    h.attach(ws);
    ws.text({ type: "hello", device_id: "kiosk-a", token: "good", caps: {}, ...(tz === undefined ? {} : { tz }) });
    await tick();
    ws.text({ type: "turn_start", turn_id: "z1" });
    for (let i = 0; i < 20; i++) ws.bin(Buffer.alloc(640, 7));
    ws.text({ type: "turn_end", vad_reason: "silence" });
    await tick(); await tick();
    assert.equal(turns.length, 1);
    return turns[0].tz;
  };
  assert.equal(await run("America/Chicago"), "America/Chicago");
  assert.equal(await run("Europe/Madrid"), "Europe/Madrid");
  assert.equal(await run(undefined), null, "an older page sends none");
  assert.equal(await run("Mars/Olympus"), null);
  assert.equal(await run({ evil: 1 }), null);
  assert.equal(await run("x".repeat(500)), null);
});

// ---- Session displays (the dashboard's Talk to Crow): attach(ws, { authorize, revalidate, onClose }) ----

const SDEV = { id: "dash-0123456789abcdef", name: "Dashboard", device_kind: "kiosk", bound_bot_id: "household", kiosk_settings: { lang: "en" } };
const PCM = Buffer.alloc(8000);

test("session display: authorize replaces the device-token check (verifyKiosk is never asked) and hello's device_id/token are not read", async () => {
  let verified = 0, seen = null;
  const { h } = hub({ verifyKiosk: async () => { verified++; return { ...DEV }; } });
  const ws = new FakeWs();
  h.attach(ws, { authorize: async (msg) => { seen = msg; return { device: { ...SDEV } }; } });
  ws.text({ type: "hello", mode: "session", csrf: "c", device_id: "kiosk-a", token: "good" }); await tick();
  assert.equal(verified, 0);
  assert.equal(seen.csrf, "c");
  assert.equal(ws.msgs()[0].type, "ready");
  assert.equal(h.isConnected(SDEV.id), true);
  assert.equal(h.isConnected("kiosk-a"), false, "the paired display's id is not claimed");
});

test("session display: authorize → null closes 4401; → { close } closes with that code; a throw closes 1011", async () => {
  for (const [authorize, want] of [
    [async () => null, { code: 4401, reason: "unauthorized" }],
    [async () => ({ close: { code: 4403, reason: "no_bot" } }), { code: 4403, reason: "no_bot" }],
    [async () => { throw new Error("db"); }, { code: 1011, reason: "server_error" }],
  ]) {
    const { h } = hub(); const ws = new FakeWs();
    h.attach(ws, { authorize });
    ws.text({ type: "hello", mode: "session" }); await tick();
    assert.deepEqual(ws.closed, want);
    assert.equal(h.connectedIds().length, 0);
  }
});

test("session display: the login is re-checked at every turn — once it has ended nothing is transcribed or run and the socket closes 4401", async () => {
  let live = true, transcribed = 0;
  const { h, turns } = hub({ transcribe: async () => { transcribed++; return { text: "hi" }; } });
  const ws = new FakeWs();
  h.attach(ws, { authorize: async () => ({ device: { ...SDEV } }), revalidate: async () => live });
  ws.text({ type: "hello", mode: "session" }); await tick();
  ws.text({ type: "turn_start", turn_id: "t1" }); ws.bin(PCM); ws.text({ type: "turn_end", vad_reason: "manual" }); await tick(); await tick();
  assert.equal(turns.length, 1, "runs while the login is live");
  live = false;
  ws.text({ type: "turn_start", turn_id: "t2" }); ws.bin(PCM); ws.text({ type: "speech_pause" }); ws.text({ type: "turn_end", vad_reason: "silence", voiced_bytes: 8000 });
  await tick(); await tick();
  assert.deepEqual(ws.closed, { code: 4401, reason: "unauthorized" });
  assert.equal(turns.length, 1, "no turn after the login ended");
  assert.equal(transcribed, 0, "and no speech was transcribed");
  const n = ws.sent.length;
  ws.text({ type: "turn_start", turn_id: "t3" });
  assert.equal(ws.sent.length, n, "frames still in flight after the close are ignored");
});

test("session display: a failing login check closes 1011 (retry), never 4401, and runs nothing", async () => {
  const { h, turns } = hub();
  const ws = new FakeWs();
  h.attach(ws, { authorize: async () => ({ device: { ...SDEV } }), revalidate: async () => { throw new Error("database is locked"); } });
  ws.text({ type: "hello", mode: "session" }); await tick();
  ws.text({ type: "turn_start", turn_id: "t1" }); ws.bin(PCM); ws.text({ type: "turn_end", vad_reason: "manual" }); await tick(); await tick();
  assert.deepEqual(ws.closed, { code: 1011, reason: "server_error" });
  assert.equal(turns.length, 0);
});

test("session display: the idle sweep tolerates a session store it cannot read (no display is dropped for a database blip)", async () => {
  const { h } = hub();
  const ws = new FakeWs();
  h.attach(ws, { authorize: async () => ({ device: { ...SDEV } }), revalidate: async () => { throw new Error("database is locked"); } });
  ws.text({ type: "hello", mode: "session" }); await tick();
  await h.revalidateSessions();
  assert.equal(ws.closed, null);
});

test("session display: revalidateSessions closes only displays whose login ended; paired displays are never asked", async () => {
  const live = { a: true, b: false };
  const { h } = hub();
  const paired = await hello(h);
  const wa = new FakeWs(), wb = new FakeWs();
  h.attach(wa, { authorize: async () => ({ device: { ...SDEV, id: "dash-a" } }), revalidate: async () => live.a });
  h.attach(wb, { authorize: async () => ({ device: { ...SDEV, id: "dash-b" } }), revalidate: async () => live.b });
  wa.text({ type: "hello" }); wb.text({ type: "hello" }); await tick();
  await h.revalidateSessions();
  assert.equal(wa.closed, null);
  assert.deepEqual(wb.closed, { code: 4401, reason: "unauthorized" });
  assert.equal(paired.closed, null);
});

test("session display: onClose fires when the socket goes away, but not for a socket replaced by a newer one of the same login", async () => {
  const closed = [];
  const { h } = hub();
  const opts = { authorize: async () => ({ device: { ...SDEV } }), onClose: (d) => closed.push(d.id) };
  const first = new FakeWs(), second = new FakeWs();
  h.attach(first, opts); first.text({ type: "hello" }); await tick();
  h.attach(second, opts); second.text({ type: "hello" }); await tick();
  assert.deepEqual(first.closed, { code: 4000, reason: "superseded" });
  assert.deepEqual(closed, [], "superseded: the display is still open");
  second.close(1000, "bye");
  assert.deepEqual(closed, [SDEV.id]);
});

test("a paired display (no opts) is untouched by the session hooks: token check as before, no revalidation", async () => {
  const { h, turns } = hub();
  const ws = await hello(h);
  ws.text({ type: "turn_start", turn_id: "t1" }); ws.bin(PCM); ws.text({ type: "turn_end", vad_reason: "manual" }); await tick(); await tick();
  assert.equal(turns.length, 1);
  await h.revalidateSessions();
  assert.equal(ws.closed, null);
});

test("hello: caps go through the display's profile; a K1 page still gets every K1 window; a profile change applies without a reconnect", async () => {
  const V2 = { v: 2, screen: { w: 800, h: 480, touch: true }, audio: { out: true, in: true }, codecs: [], frames: 2, max_windows: 4, input: { wake: false, keyboard: false }, kinds: ["card", "timer", "media", "app"] };
  const { h, turns } = hub({ verifyKiosk: async (id, tok) => (id === "kiosk-a" && tok === "good" ? { ...DEV, kiosk_settings: { lang: "en", profile: "pi3" } } : null) });
  const ws = new FakeWs();
  h.attach(ws);
  ws.text({ type: "hello", device_id: "kiosk-a", token: "good", caps: V2 });
  await tick();
  const turn = async () => { ws.text({ type: "turn_start", turn_id: `t${turns.length}` }); ws.bin(Buffer.alloc(8000)); ws.text({ type: "turn_end" }); for (let i = 0; i < 20; i += 1) await tick(); };
  await turn();
  assert.equal(turns.length, 1);
  assert.deepEqual([turns[0].caps.v, turns[0].caps.video, turns[0].caps.windows], [2, "none", ["timer", "recipe", "content"]]);
  h.refreshDevice("kiosk-a", { kiosk_settings: { lang: "en", profile: "tablet" } });
  await turn();
  assert.equal(turns.length, 2);
  assert.equal(turns[1].caps.video, "hd", "the saved profile is used on the next turn of the same connection");
  const k1 = hub();
  const old = await hello(k1.h);
  old.text({ type: "turn_start", turn_id: "k" }); old.bin(Buffer.alloc(8000)); old.text({ type: "turn_end" });
  for (let i = 0; i < 20; i += 1) await tick();
  assert.deepEqual([k1.turns[0].caps.windows, k1.turns[0].caps.video, k1.turns[0].caps.max_windows], [["timer", "recipe", "content"], "none", 4]);
});

test("hello: a paired display with no type set gets the pairing guess, stored once as guessed; a typed display is never re-guessed; a K1 page gives no guess", async () => {
  const PHONE = { v: 2, screen: { w: 412, h: 915, touch: true }, audio: { out: true, in: true }, codecs: [], frames: 0, max_windows: 4, input: { wake: false, keyboard: false }, kinds: ["card", "timer"], mobile: true, pointer: "coarse", platform: "Linux aarch64" };
  const stored = [];
  const { h, turns } = hub({ storeProfile: async (id, p) => { stored.push([id, p]); } });
  const ws = new FakeWs();
  h.attach(ws);
  ws.text({ type: "hello", device_id: "kiosk-a", token: "good", caps: PHONE });
  for (let i = 0; i < 5; i += 1) await tick();
  assert.deepEqual(stored, [["kiosk-a", "phone"]]);
  ws.text({ type: "turn_start", turn_id: "t" }); ws.bin(Buffer.alloc(8000)); ws.text({ type: "turn_end" });
  for (let i = 0; i < 20; i += 1) await tick();
  assert.deepEqual([turns[0].device.kiosk_settings.profile, turns[0].device.kiosk_settings.profile_source], ["phone", "guessed"]);
  const typed = [];
  const t = hub({ storeProfile: async (id, p) => { typed.push(p); }, verifyKiosk: async () => ({ ...DEV, kiosk_settings: { lang: "en", profile: "pi3", profile_source: "operator" } }) });
  const w2 = new FakeWs(); t.h.attach(w2); w2.text({ type: "hello", device_id: "kiosk-a", token: "good", caps: PHONE });
  for (let i = 0; i < 5; i += 1) await tick();
  assert.deepEqual(typed, [], "the operator's choice stands");
  const k1 = []; const o = hub({ storeProfile: async (id, p) => { k1.push(p); } });
  await hello(o.h);
  assert.deepEqual(k1, [], "a K1 page reports nothing to guess from");
});
