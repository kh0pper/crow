/**
 * Typing to Crow on the kiosk page (also the phone's Talk to Crow overlay).
 *
 * The page may type instead of speak:
 *   - { type: "text_turn", turn_id, text } runs an ORDINARY operator voice turn with the typed text as the
 *     transcript (no audio, no STT), marked opts.typed = true (the words were not misheard).
 *   - { type: "voice_mode", on } is a per-socket flag, on by default. While off, no audio and no tts_start
 *     leaves the socket and a turn_start is answered with turn_over { turn_id, reason: "voice_off" };
 *     captions still flow, and a line that would have been spoken is sent as { type: "announce", text }
 *     instead (nothing is synthesized for a page that cannot hear it).
 * Control characters and newlines in the text are flattened to one space; the text is trimmed; empty text is
 * turn_over "empty"; text is cut to MAX_TEXT_CHARS.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as kioskSession from "../bundles/kiosk/server/session.js";
import { createMetricsStore } from "../bundles/kiosk/server/metrics.js";
import { createWmStore } from "../bundles/kiosk/server/wm.js";
import { wrapPcmAsWav } from "../servers/gateway/voice/turn-helpers.js";

const { createSessionHub, MAX_TEXT_CHARS } = kioskSession;

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
  const speaks = [];
  const metrics = createMetricsStore();
  const logs = [];
  const wm = createWmStore({ setTimer: () => ({}), clearTimer: () => {} }); // no real timers: a 120 s timer would hold the test process open
  const h = createSessionHub({
    verifyKiosk: over.verifyKiosk || (async (id, tok) => (id === "kiosk-a" && tok === "good" ? { ...DEV } : null)),
    displayConfig: over.displayConfig || (async (d) => ({ name: d.name, bird: { species: "crow", seed: 0, mood: "happy" } })),
    runTurn: over.runTurn || (async (o) => { turns.push(o); o.sink.event({ type: "transcript_final", text: "hi" }); o.sink.event({ type: "tts_start", codec: "pcm", sample_rate: 24000 }); o.sink.audio(Buffer.alloc(4)); o.sink.event({ type: "tts_end" }); return { route: "fast", fastPath: false, escalated: false, aborted: false, degraded: null, timings: { total_ms: 5 } }; }),
    speak: (o) => { speaks.push(o); return (over.speak || (async ({ text, sink }) => { sink.event({ type: "tts_start", codec: "pcm", sample_rate: 24000 }); sink.audio(Buffer.from(text)); sink.event({ type: "tts_end" }); }))(o); },
    wm, metrics, wrapPcmAsWav,
    media: over.media,
    warmup: over.warmup || (async () => {}),
    transcribe: over.transcribe || null,
    ...(over.storeProfile ? { storeProfile: over.storeProfile } : {}),
    setTimeout: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.cleared = true; },
    now: () => 42,
    log: (l) => logs.push(l),
  });
  return { h, timers, turns, speaks, metrics, wm, logs };
}
async function hello(h, ws = new FakeWs(), over = {}) { h.attach(ws); ws.text({ type: "hello", device_id: "kiosk-a", token: "good", caps: { windows: ["timer", "recipe", "content"] }, ...over }); await tick(); return ws; }
const binary = (ws) => ws.sent.filter((d) => Buffer.isBuffer(d));
const states = (ws) => ws.msgs().filter((m) => m.type === "state").map((m) => m.bird);
const overOf = (ws) => ws.msgs().find((m) => m.type === "turn_over");
const announcements = (ws) => ws.msgs().filter((m) => m.type === "announce").map((m) => m.text);

test("MAX_TEXT_CHARS is 500", () => {
  assert.equal(MAX_TEXT_CHARS, 500);
});

test("a typed turn runs operator words: trimmed transcript, typed, no audio, no STT → events, audio, turn_done", async () => {
  const { h, turns } = hub();
  const ws = await hello(h);
  ws.text({ type: "text_turn", turn_id: "x1", text: "  what time is it  " });
  await tick(); await tick();
  assert.equal(turns.length, 1);
  const call = turns[0];
  assert.equal(call.transcript, "what time is it");
  assert.equal(call.typed, true);
  assert.equal(call.audio, undefined, "no audio: the words were typed");
  assert.equal(call.sttEarly?.used, false, "nothing was transcribed early");
  const m = ws.msgs();
  assert.ok(m.some((x) => x.type === "transcript_final"), "the reply is captioned");
  assert.equal(m.find((x) => x.type === "turn_done").turn_id, "x1");
  const birds = states(ws);
  assert.ok(birds.includes("thinking"), JSON.stringify(birds));
  assert.equal(birds.at(-1), "idle");
  assert.ok(birds.indexOf("thinking") < birds.length - 1, "thinking precedes the end of the turn");
});

test("empty or whitespace text is turn_over empty and runs nothing; long text is cut to MAX_TEXT_CHARS", async () => {
  const { h, turns } = hub();
  const ws = await hello(h);
  ["", "   ", "\n\t "].forEach((text, i) => ws.text({ type: "text_turn", turn_id: `e${i}`, text }));
  await tick();
  const over = ws.msgs().filter((m) => m.type === "turn_over");
  assert.deepEqual(over.map((o) => [o.turn_id, o.reason]), [["e0", "empty"], ["e1", "empty"], ["e2", "empty"]]);
  assert.equal(turns.length, 0);
  ws.text({ type: "text_turn", turn_id: "long", text: "a".repeat(MAX_TEXT_CHARS + 100) });
  await tick(); await tick();
  assert.equal(turns.length, 1);
  assert.equal(turns[0].transcript, "a".repeat(MAX_TEXT_CHARS));
  assert.equal(turns[0].transcript.length, 500);
});

test("a typed turn while a turn is running is turn_over busy", async () => {
  let release;
  const { h, turns } = hub({ runTurn: (o) => { turns.push(o); return new Promise((r) => { release = () => r({ route: "fast", timings: {} }); }); } });
  const ws = await hello(h);
  ws.text({ type: "turn_start", turn_id: "s1" }); ws.bin(Buffer.alloc(8000)); ws.text({ type: "turn_end" });
  await tick(); await tick();
  assert.equal(turns.length, 1, "the spoken turn is running");
  ws.text({ type: "text_turn", turn_id: "c1", text: "hello" });
  await tick();
  const over = overOf(ws);
  assert.deepEqual([over?.turn_id, over?.reason], ["c1", "busy"]);
  assert.equal(turns.length, 1);
  release(); await tick();
});

test("a typed turn while the mic is open is turn_over busy", async () => {
  const { h, turns } = hub();
  const ws = await hello(h);
  ws.text({ type: "turn_start", turn_id: "m1" });
  ws.bin(Buffer.alloc(8000));
  ws.text({ type: "text_turn", turn_id: "c2", text: "hello" });
  await tick();
  const over = overOf(ws);
  assert.deepEqual([over?.turn_id, over?.reason], ["c2", "busy"]);
  assert.equal(turns.length, 0);
});

test("a typed turn during speech aborts the speech and then runs", async () => {
  const gates = [];
  const { h, turns } = hub({ speak: ({ text, sink, signal }) => new Promise((res) => { gates.push({ emit: () => sink.audio(Buffer.from(text)), done: res, signal }); }) });
  const ws = await hello(h);
  h.speak("kiosk-a", "one"); await tick();
  gates[0].emit();
  assert.equal(binary(ws).length, 1);
  ws.text({ type: "text_turn", turn_id: "p1", text: "what time is it" });
  assert.equal(gates[0].signal.aborted, true, "the speech in the room stops first");
  gates[0].emit();
  assert.equal(binary(ws).length, 1, "no audio from the aborted speech");
  gates[0].done(); await tick(); await tick();
  assert.equal(turns.length, 1);
  assert.equal(turns[0].transcript, "what time is it");
});

test("voice mode off: a typed turn still captions, with no audio and no tts frames", async () => {
  const { h, turns } = hub();
  const ws = await hello(h);
  ws.text({ type: "voice_mode", on: false });
  ws.text({ type: "text_turn", turn_id: "v1", text: "what time is it" });
  await tick(); await tick();
  assert.equal(turns.length, 1, "the turn runs");
  assert.equal(binary(ws).length, 0, "no audio to a voice-off page");
  const m = ws.msgs();
  assert.ok(!m.some((x) => x.type === "tts_start" || x.type === "tts_end"), "no tts framing either");
  assert.ok(m.some((x) => x.type === "transcript_final"), "captions still flow");
  assert.equal(m.find((x) => x.type === "turn_done").turn_id, "v1");
});

test("voice mode off: a turn_start is answered turn_over voice_off and nothing runs", async () => {
  const { h, turns } = hub();
  const ws = await hello(h);
  ws.text({ type: "voice_mode", on: false });
  ws.text({ type: "turn_start", turn_id: "s9" });
  await tick();
  const over = overOf(ws);
  assert.deepEqual([over?.turn_id, over?.reason], ["s9", "voice_off"]);
  assert.deepEqual(states(ws), ["idle"], "the display never goes listening");
  assert.equal(turns.length, 0);
});

test("voice mode off: hub.speak sends nothing; turning voice back on sends audio again", async () => {
  const { h } = hub();
  const ws = await hello(h);
  ws.text({ type: "voice_mode", on: false });
  h.speak("kiosk-a", "timer done");
  await tick(); await tick();
  assert.equal(binary(ws).length, 0);
  assert.ok(!ws.msgs().some((m) => m.type === "tts_start"));
  ws.text({ type: "voice_mode", on: true });
  h.speak("kiosk-a", "timer done");
  await tick(); await tick();
  assert.equal(Buffer.concat(binary(ws)).toString(), "timer done");
  assert.ok(ws.msgs().some((m) => m.type === "tts_start"));
});

test("voice mode: barge-in and close while off are harmless; a non-boolean on is ignored", async () => {
  const { h } = hub();
  const ws = await hello(h);
  ws.text({ type: "voice_mode", on: false });
  ws.text({ type: "barge_in" });
  ws.text({ type: "voice_mode", on: "off" });
  h.speak("kiosk-a", "still off");
  await tick(); await tick();
  assert.equal(binary(ws).length, 0, "a non-boolean on leaves the flag as it was");
  ws.text({ type: "voice_mode", on: true });
  ws.text({ type: "voice_mode", on: 0 });
  h.speak("kiosk-a", "on again");
  await tick(); await tick();
  assert.equal(Buffer.concat(binary(ws)).toString(), "on again");
  ws.close(1006, "");
  assert.deepEqual(ws.closed, { code: 1006, reason: "" });
});

test("voice mode off ends an open mic turn: turn_over voice_off, idle, no turn run; a typed turn then runs; a late turn_end does nothing", async () => {
  const { h, turns } = hub();
  const ws = await hello(h);
  ws.text({ type: "turn_start", turn_id: "open1" });
  ws.bin(Buffer.alloc(4000)); ws.bin(Buffer.alloc(4000)); ws.bin(Buffer.alloc(4000));
  assert.equal(states(ws).at(-1), "listening", "the mic is open");
  assert.equal(h.isBusy("kiosk-a"), true);
  ws.text({ type: "voice_mode", on: false });
  await tick();
  const over = overOf(ws);
  assert.deepEqual([over?.turn_id, over?.reason], ["open1", "voice_off"], "the open turn is closed as voice_off");
  assert.equal(states(ws).at(-1), "idle", "the display stops listening");
  assert.equal(h.isBusy("kiosk-a"), false, "the mic turn is no longer held open");
  assert.equal(turns.length, 0, "the abandoned mic turn never runs");
  ws.text({ type: "text_turn", turn_id: "t1", text: "what time is it" });
  await tick(); await tick();
  assert.equal(turns.length, 1, "the page is not busy after the mic turn was abandoned");
  assert.equal(turns[0].transcript, "what time is it");
  const runFrames = binary(ws).length;
  ws.text({ type: "turn_end", turn_id: "open1", vad_reason: "silence", voiced_bytes: 12000 });
  await tick(); await tick();
  assert.equal(turns.length, 1, "a late turn_end for the abandoned turn runs nothing");
  assert.equal(binary(ws).length, runFrames, "and sends no audio");
  assert.equal(ws.msgs().filter((m) => m.type === "turn_done").length, 1, "only the typed turn closed");
  assert.equal(ws.msgs().filter((m) => m.type === "turn_over").length, 1, "the late turn_end adds no turn_over");
});

test("voice mode off during a running spoken turn aborts nothing and lets no typed turn run alongside", async () => {
  let release;
  const { h, turns } = hub({ runTurn: (o) => { turns.push(o); return new Promise((r) => { release = () => { o.sink.event({ type: "tts_start", codec: "pcm", sample_rate: 24000 }); o.sink.audio(Buffer.alloc(4)); r({ route: "fast", timings: {} }); }; }); } });
  const ws = await hello(h);
  ws.text({ type: "turn_start", turn_id: "s1" }); ws.bin(Buffer.alloc(8000)); ws.text({ type: "turn_end" });
  await tick(); await tick();
  assert.equal(turns.length, 1, "the spoken turn is running");
  const signal = turns[0].signal;
  ws.text({ type: "voice_mode", on: false });
  await tick();
  assert.equal(signal.aborted, false, "the running turn keeps running");
  assert.equal(h.isBusy("kiosk-a"), true, "still busy while it runs");
  ws.text({ type: "text_turn", turn_id: "c1", text: "hello" });
  await tick();
  const over = overOf(ws);
  assert.deepEqual([over?.turn_id, over?.reason], ["c1", "busy"], "a typed turn is still refused while the turn runs");
  assert.equal(turns.length, 1, "nothing runs alongside the running turn");
  release(); await tick(); await tick();
  assert.equal(binary(ws).length, 0, "only the audio is filtered: nothing audible leaves");
  assert.ok(!ws.msgs().some((m) => m.type === "tts_start"), "no tts framing either");
  assert.equal(ws.msgs().filter((m) => m.type === "turn_done").length, 1, "the running turn still ends on turn_done");
});

test("voice mode on while off with no turn open changes nothing else", async () => {
  const { h, turns } = hub();
  const ws = await hello(h);
  ws.text({ type: "voice_mode", on: false });
  const sent = ws.sent.length;
  ws.text({ type: "voice_mode", on: true });
  await tick(); await tick();
  assert.equal(ws.sent.length, sent, "the flag change sends no frames");
  assert.deepEqual(states(ws), ["idle"], "the display stays idle");
  assert.ok(!ws.msgs().some((m) => m.type === "turn_over"), "no turn is closed");
  assert.equal(turns.length, 0);
});

test("session display: a typed turn re-checks the login first; an ended login closes 4401 and runs nothing", async () => {
  const { h, turns } = hub();
  let checks = 0;
  let live = true;
  const ws = new FakeWs();
  h.attach(ws, { authorize: async () => ({ device: { ...DEV } }), revalidate: async () => { checks++; return live; } });
  ws.text({ type: "hello", mode: "session", csrf: "x", caps: {} });
  await tick();
  assert.ok(ws.msgs().some((m) => m.type === "ready"));
  ws.text({ type: "text_turn", turn_id: "j1", text: "hello" });
  await tick(); await tick();
  assert.equal(checks, 1, "the login is checked before the turn runs");
  assert.equal(turns.length, 1);
  live = false;
  ws.text({ type: "text_turn", turn_id: "j2", text: "again" });
  await tick(); await tick();
  assert.equal(checks, 2);
  assert.deepEqual(ws.closed, { code: 4401, reason: "unauthorized" });
  assert.equal(turns.length, 1, "nothing runs for a login that ended");
});

test("control characters and newlines in typed text are flattened to one space", async () => {
  const { h, turns } = hub();
  const ws = await hello(h);
  ws.text({ type: "text_turn", turn_id: "n1", text: "line1\nline2\u0000x" });
  await tick(); await tick();
  assert.equal(turns.length, 1);
  assert.equal(turns[0].transcript, "line1 line2 x", "no newline or NUL reaches the turn");
  ws.text({ type: "text_turn", turn_id: "n2", text: "\u0001\u0002 \u007f" });
  await tick();
  assert.deepEqual([overOf(ws)?.turn_id, overOf(ws)?.reason], ["n2", "empty"], "control characters alone are no words");
  assert.equal(turns.length, 1);
});

test("an empty typed turn leaves the announcement in the room alone", async () => {
  const gates = [];
  const { h, turns } = hub({ speak: ({ text, signal }) => new Promise((res) => { gates.push({ signal, done: res }); }) });
  const ws = await hello(h);
  h.speak("kiosk-a", "one");
  await tick();
  assert.equal(gates.length, 1, "the line is being spoken");
  ws.text({ type: "text_turn", turn_id: "e9", text: "   " });
  await tick();
  assert.deepEqual([overOf(ws)?.turn_id, overOf(ws)?.reason], ["e9", "empty"]);
  assert.equal(turns.length, 0);
  assert.equal(gates[0].signal.aborted, false, "empty text aborts nothing");
  gates[0].done();
  await tick(); await tick();
});

test("voice mode off: a queued line is shown as text, not spoken — no tts frames, no speech call", async () => {
  const { h, speaks } = hub();
  const ws = await hello(h);
  ws.text({ type: "voice_mode", on: false });
  assert.equal(h.speak("kiosk-a", "Timer timer is done."), true, "the line still reaches the page");
  await tick();
  assert.deepEqual(announcements(ws), ["Timer timer is done."]);
  assert.equal(binary(ws).length, 0, "no audio");
  assert.ok(!ws.msgs().some((m) => m.type === "tts_start" || m.type === "tts_end"), "no tts framing");
  assert.deepEqual(speaks, [], "nothing is synthesized for a page that cannot hear it");
  ws.text({ type: "voice_mode", on: true });
  h.speak("kiosk-a", "Again.");
  await tick(); await tick();
  assert.deepEqual(speaks.map((s) => s.text), ["Again."], "voice back on speaks again");
  assert.equal(Buffer.concat(binary(ws)).toString(), "Again.");
  assert.deepEqual(announcements(ws), ["Timer timer is done."], "the line shown while off is never replayed");
});

test("voice mode off turns lines already queued into announce frames instead of dropping them", async () => {
  const gates = [];
  const { h, speaks } = hub({ speak: ({ text, signal }) => new Promise((res) => { gates.push({ text, signal, done: res }); }) });
  const ws = await hello(h);
  h.speak("kiosk-a", "first");
  await tick();
  assert.equal(gates.length, 1, "the first line is being spoken");
  h.speak("kiosk-a", "second");
  await tick();
  ws.text({ type: "voice_mode", on: false });
  await tick();
  assert.equal(gates[0].signal.aborted, true, "what the room was saying stops");
  assert.deepEqual(announcements(ws), ["second"], "the queued line is shown, once");
  gates[0].done();
  await tick(); await tick();
  assert.deepEqual(speaks.map((s) => s.text), ["first"], "only the line already being spoken was synthesized");
  assert.equal(binary(ws).length, 0);
  ws.text({ type: "voice_mode", on: true });
  await tick(); await tick();
  assert.deepEqual(announcements(ws), ["second"], "and it is not spoken a second time");
  assert.equal(binary(ws).length, 0);
});

test("a hello with voice_off: true starts quiet: a queued line is an announce and a typed turn's tts frames are dropped, with no voice_mode frame at all", async () => {
  const { h, speaks, turns } = hub();
  const ws = await hello(h, new FakeWs(), { voice_off: true });
  assert.ok(ws.msgs().some((m) => m.type === "ready"), "the display is up");
  assert.equal(h.speak("kiosk-a", "Timer timer is done."), true);
  await tick(); await tick();
  assert.deepEqual(announcements(ws), ["Timer timer is done."], "the line is shown, not spoken");
  assert.deepEqual(speaks, [], "nothing is synthesized for a quiet page");
  assert.equal(binary(ws).length, 0, "no audio");
  assert.ok(!ws.msgs().some((m) => m.type === "tts_start" || m.type === "tts_end"), "no tts framing");
  ws.text({ type: "text_turn", turn_id: "h1", text: "what time is it" });
  await tick(); await tick(); await tick();
  assert.equal(turns.length, 1, "the typed turn still runs");
  assert.ok(!ws.msgs().some((m) => m.type === "tts_start" || m.type === "tts_end"), "its tts frames are dropped too");
  assert.equal(binary(ws).length, 0, "and so is its audio");
  assert.ok(ws.msgs().some((m) => m.type === "transcript_final"), "captions still flow");
  assert.equal(ws.msgs().find((m) => m.type === "turn_done")?.turn_id, "h1");
  assert.ok(!ws.msgs().some((m) => m.type === "voice_mode"), "the page never had to say it again on this socket");
  ws.text({ type: "voice_mode", on: true });
  h.speak("kiosk-a", "Again.");
  await tick(); await tick();
  assert.deepEqual(speaks.map((s) => s.text), ["Again."], "a later voice_mode still overrides");
  assert.equal(Buffer.concat(binary(ws)).toString(), "Again.");
});

test("a hello with voice_off: true answers turn_start voice_off before any voice_mode frame", async () => {
  const { h, turns } = hub();
  const ws = await hello(h, new FakeWs(), { voice_off: true });
  ws.text({ type: "turn_start", turn_id: "q1" });
  await tick();
  assert.deepEqual([overOf(ws)?.turn_id, overOf(ws)?.reason], ["q1", "voice_off"]);
  assert.equal(turns.length, 0, "nothing runs");
  assert.ok(!ws.msgs().some((m) => m.type === "voice_mode"));
});

test("a hello without voice_off (or with anything but true) leaves voice on: the first line is spoken as before", async () => {
  for (const over of [{}, { voice_off: false }, { voice_off: "yes" }, { voice_off: 1 }]) {
    const { h, speaks } = hub();
    const ws = await hello(h, new FakeWs(), over);
    h.speak("kiosk-a", "Hello.");
    await tick(); await tick();
    assert.deepEqual(speaks.map((s) => s.text), ["Hello."], JSON.stringify(over));
    assert.equal(Buffer.concat(binary(ws)).toString(), "Hello.", JSON.stringify(over));
    assert.ok(ws.msgs().some((m) => m.type === "tts_start"), JSON.stringify(over));
    assert.deepEqual(announcements(ws), [], JSON.stringify(over));
    ws.text({ type: "turn_start", turn_id: "s1" });
    await tick();
    assert.equal(overOf(ws), undefined, `${JSON.stringify(over)}: the mic opens`);
  }
});

test("voice mode off: a caller that already captioned its line gets no second one", async () => {
  const { h, speaks } = hub();
  const ws = await hello(h);
  ws.text({ type: "voice_mode", on: false });
  h.sendTo("kiosk-a", { type: "announce", text: "Dinner's ready" });
  h.speak("kiosk-a", "Dinner's ready", { shown: true });
  await tick();
  assert.deepEqual(announcements(ws), ["Dinner's ready"], "one caption, not two");
  assert.deepEqual(speaks, []);
});