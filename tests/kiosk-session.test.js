import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createSessionHub, HELLO_TIMEOUT_MS, MAX_TURN_BYTES } from "../bundles/kiosk/server/session.js";
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
