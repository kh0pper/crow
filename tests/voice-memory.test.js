/**
 * The per-device voice memory (servers/gateway/voice/voice-memory.js): an idle display's record (its last write's
 * title among it) leaves the heap after the window, without anyone reading it, and the device count is capped.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createVoiceMemory, VOICE_MODE_WINDOW_MS, VOICE_MEMORY_MAX_DEVICES } from "../servers/gateway/voice/voice-memory.js";

function clock(t = 1_000_000) {
  return { now: () => t, tick: (ms) => { t += ms; } };
}
function fakeTimers() {
  const timers = [];
  return {
    timers,
    setInterval: (fn, ms) => { const t = { fn, ms, cleared: false, unref() { t.unrefd = true; return t; } }; timers.push(t); return t; },
    clearInterval: (t) => { t.cleared = true; },
  };
}
const WRITE = { tool: "crow_calendar_add_event", title: "coffee", start: "2026-10-27T09:00:00-05:00", say: "Added coffee.", lang: "en", tz: "UTC" };

test("voice memory: an idle device's record (with its last write) empties on the sweep, with no access", () => {
  const c = clock();
  const ft = fakeTimers();
  const m = createVoiceMemory({ now: c.now, sweepMs: 60_000, setInterval: ft.setInterval, clearInterval: ft.clearInterval });
  assert.equal(ft.timers.length, 0, "no timer before the first note");
  m.noteWrite("d1", WRITE);
  m.noteOwn("d1", ["own:calendar"]);
  assert.equal(ft.timers.length, 1, "the sweep starts on the first note");
  assert.equal(ft.timers[0].ms, 60_000);
  assert.equal(ft.timers[0].unrefd, true, "the sweep never holds the process open");
  m.noteAction("d1");
  assert.equal(ft.timers.length, 1, "one sweep, not one per note");
  assert.equal(m._deviceCount(), 1);
  c.tick(VOICE_MODE_WINDOW_MS + 1);
  ft.timers[0].fn();
  assert.equal(m._deviceCount(), 0, "the map is empty: the title is gone from the heap");
  assert.equal(ft.timers[0].cleared, true, "the sweep stops when nothing is held");
  m.noteAction("d2");
  assert.equal(ft.timers.length, 2, "a later note starts it again");
});

test("voice memory: every note prunes every device", () => {
  const c = clock();
  const m = createVoiceMemory({ now: c.now, sweepMs: 0 });
  m.noteWrite("d1", WRITE);
  c.tick(VOICE_MODE_WINDOW_MS + 1);
  m.noteAction("d2");
  assert.equal(m._deviceCount(), 1, "d1 was dropped by d2's note");
  assert.equal(m.lastWrite("d1"), null);
});

test("voice memory: at most VOICE_MEMORY_MAX_DEVICES devices, least recently noted dropped first", () => {
  const c = clock();
  const m = createVoiceMemory({ now: c.now, sweepMs: 0 });
  assert.equal(VOICE_MEMORY_MAX_DEVICES, 64);
  for (let i = 0; i < 70; i++) m.noteAction(`d${i}`);
  assert.equal(m._deviceCount(), 64);
  assert.equal(m.actionAt("d0"), null, "the oldest is gone");
  assert.notEqual(m.actionAt("d69"), null);
  m.noteAction("d6");   // touched: now the most recent
  m.noteAction("dx");
  assert.equal(m._deviceCount(), 64);
  assert.notEqual(m.actionAt("d6"), null, "a touched device stays");
  assert.equal(m.actionAt("d7"), null, "the least recently noted goes");
});
