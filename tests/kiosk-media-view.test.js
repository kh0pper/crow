/**
 * The page's media element driver (public/media-view.js), against an <audio> fake that follows the
 * HTML rules the review's simulation used: play() stays PENDING until the element really plays, and
 * a pending play() REJECTS with AbortError when pause() is called or a new src is set.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMediaView, createDucker, DUCK_FACTOR, START_MS, STALL_MS, RESTORE_DELAY_MS, RESTORE_MS } from "../bundles/kiosk/public/media-view.js";

function timers() {
  let t = 0, seq = 0;
  const q = new Map();
  return {
    setTimer: (fn, ms) => { const id = ++seq; q.set(id, { at: t + ms, fn }); return id; },
    clearTimer: (id) => { q.delete(id); },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const next = [...q.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        q.delete(next[0]); t = next[1].at; next[1].fn();
      }
      t = end;
    },
  };
}
function fakeAudio() {
  const ls = new Map();
  let pending = null, src = "";
  const a = {
    volume: 1, paused: true, ended: false, srcSets: 0, plays: 0, block: false,
    addEventListener: (ev, fn) => { if (!ls.has(ev)) ls.set(ev, []); ls.get(ev).push(fn); },
    fire(ev) { if (ev === "playing") { a.paused = false; pending?.resolve(); pending = null; } if (ev === "ended") { a.paused = true; a.ended = true; } for (const fn of ls.get(ev) || []) fn({ type: ev }); },
    abortPending() { if (pending) { const p = pending; pending = null; const e = new Error("aborted"); e.name = "AbortError"; p.reject(e); } },
    get src() { return src; },
    set src(v) { a.abortPending(); src = String(v); a.srcSets += 1; a.ended = false; if (!a.paused) { a.paused = true; a.fire("pause"); } },
    removeAttribute(k) { if (k === "src") { a.abortPending(); src = ""; } },
    load() { if (!a.paused) { a.paused = true; a.fire("pause"); } },
    play() {
      a.plays += 1;
      if (a.block) { const e = new Error("blocked"); e.name = "NotAllowedError"; return Promise.reject(e); }
      if (!a.paused) return Promise.resolve();
      return new Promise((resolve, reject) => { pending = { resolve, reject }; });
    },
    pause() { a.abortPending(); if (!a.paused) { a.paused = true; a.fire("pause"); } },
  };
  return a;
}
function fakeChip() {
  const ls = [];
  return { hidden: true, textContent: "", attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, addEventListener: (ev, fn) => ls.push(fn), click() { for (const fn of ls) fn(); } };
}
const flush = () => new Promise((r) => setImmediate(r));
function setup() {
  const audio = fakeAudio(), chip = fakeChip(), sent = [], states = [], tm = timers();
  const view = createMediaView({ audio, chip, send: (o) => sent.push(o), setTimer: tm.setTimer, clearTimer: tm.clearTimer, onState: (id, s) => states.push(`${id}:${s}`) });
  const load = (id, extra = {}) => view.apply({ type: "media", action: "load", id, form: "audio", url: `/display/t/${id.padEnd(22, "x")}/stream`, title: `Title ${id}`, source: "music", volume: 50, muted: false, ...extra });
  const events = () => sent.filter((m) => m.type === "media_event").map((m) => `${m.id}:${m.state}${m.code ? ":" + m.code : ""}`);
  return { audio, chip, sent, states, tm, view, load, events };
}

test("skip while buffering: each new item aborts the last play() — no failure is reported, only the last item plays", async () => {
  const s = setup();
  s.load("m1"); s.load("m2"); s.load("m3"); s.load("m4");
  await flush();
  assert.deepEqual(s.events(), [], "AbortError from a replaced item is not a stream failure");
  s.audio.fire("playing");
  assert.deepEqual(s.events(), ["m4:playing"]);
  assert.equal(s.chip.textContent, "⏸ Title m4");
});

test("pause while buffering: the server's pause aborts play() — not a failure, and not echoed back as the user's pause", async () => {
  const s = setup();
  s.load("m1");
  s.view.apply({ action: "pause", id: "m1" });
  await flush();
  assert.deepEqual(s.events(), []);
  assert.equal(s.chip.textContent, "▶ Title m1");
  s.view.apply({ action: "play", id: "m1" });
  s.audio.fire("playing");
  s.view.apply({ action: "pause", id: "m1" });           // a server pause of a playing stream
  assert.deepEqual(s.events(), ["m1:playing"], "the element's pause event for a pause the server asked for is swallowed");
  s.view.apply({ action: "play", id: "m1" }); s.audio.fire("playing");
  s.audio.pause();                                      // the user pauses on the device itself (lock screen)
  assert.deepEqual(s.events(), ["m1:playing", "m1:playing", "m1:paused"]);
});

test("blocked autoplay: NotAllowedError reports `blocked` once; the chip shows ▶ and a tap plays and asks the server to resume", async () => {
  const s = setup();
  s.audio.block = true;
  s.load("m1");
  await flush();
  assert.deepEqual(s.events(), ["m1:blocked"]);
  assert.equal(s.chip.hidden, false);
  assert.equal(s.chip.textContent, "▶ Title m1");
  s.tm.advance(START_MS + 1);
  assert.deepEqual(s.events(), ["m1:blocked"], "a blocked autoplay is not a stall");
  s.audio.block = false;
  const plays = s.audio.plays;
  s.chip.click();
  assert.equal(s.audio.plays, plays + 1, "play() is called inside the tap");
  assert.deepEqual(s.sent.at(-1), { type: "media_cmd", do: "resume" });
  s.audio.fire("playing");
  assert.equal(s.chip.textContent, "⏸ Title m1");
  s.chip.click();
  assert.deepEqual(s.sent.at(-1), { type: "media_cmd", do: "pause" });
});

test("a stream that fails: only the element's own error event reports load_failed, once", async () => {
  const s = setup();
  s.load("m1");
  s.audio.fire("error"); s.audio.fire("error");
  assert.deepEqual(s.events(), ["m1:error:load_failed"]);
  s.tm.advance(START_MS + 1);
  assert.deepEqual(s.events(), ["m1:error:load_failed"], "the watchdog does not report it again");
});

test("reconnect: the same item again never reassigns src (no restart from 0:00); only volume and paused are applied", async () => {
  const s = setup();
  s.load("m1"); s.audio.fire("playing");
  assert.equal(s.audio.srcSets, 1);
  s.load("m1", { volume: 70 });
  assert.equal(s.audio.srcSets, 1);
  assert.equal(s.audio.volume, 0.7);
  s.load("m1", { paused: true });
  assert.equal(s.audio.paused, true);
  assert.deepEqual(s.events(), ["m1:playing"], "a snapshot's paused state is not echoed as a user pause");
  s.load("m2");
  assert.equal(s.audio.srcSets, 2, "a different item loads");
});

test("stop clears the chip and the element; events after it are ignored", async () => {
  const s = setup();
  s.load("m1"); s.audio.fire("playing");
  s.view.apply({ action: "stop" });
  assert.equal(s.chip.hidden, true);
  assert.equal(s.audio.src, "");
  assert.equal(s.view.info(), null);
  s.audio.fire("error");
  assert.deepEqual(s.events(), ["m1:playing"]);
});

test("watchdog: no `playing` within 10 s of a load, or `waiting`/`stalled` for 15 s, reports one error `stalled`", async () => {
  const s = setup();
  s.load("m1");
  s.tm.advance(START_MS - 1);
  assert.deepEqual(s.events(), []);
  s.tm.advance(2);
  assert.deepEqual(s.events(), ["m1:error:stalled"]);
  const t = setup();
  t.load("m1"); t.audio.fire("playing");
  t.audio.fire("waiting"); t.tm.advance(STALL_MS - 1);
  t.audio.fire("stalled"); t.tm.advance(1);
  assert.deepEqual(t.events(), ["m1:playing", "m1:error:stalled"], "the stall is timed from its first waiting event");
  const u = setup();
  u.load("m1"); u.audio.fire("playing"); u.audio.fire("waiting"); u.tm.advance(STALL_MS - 100); u.audio.fire("playing"); u.tm.advance(STALL_MS);
  assert.deepEqual(u.events(), ["m1:playing", "m1:playing"], "a stream that recovers is not reported");
});

test("ducker: down to DUCK_FACTOR of the level at once; back 400 ms after release over 300 ms in 30 ms steps", () => {
  const tm = timers(), audio = { volume: 1 };
  const d = createDucker(audio, tm);
  d.setTarget(0.6);
  assert.equal(audio.volume, 0.6);
  d.duck(true);
  assert.equal(audio.volume, 0.6 * DUCK_FACTOR);
  d.setTarget(0.8);
  assert.equal(audio.volume, 0.8 * DUCK_FACTOR, "a volume change while ducked stays ducked");
  d.duck(false);
  tm.advance(RESTORE_DELAY_MS);
  assert.equal(audio.volume, 0.8 * DUCK_FACTOR, "nothing before the delay");
  const seen = [];
  for (let i = 0; i < RESTORE_MS / 30; i++) { tm.advance(30); seen.push(Math.round(audio.volume * 1000)); }
  assert.equal(seen.length, 10);
  assert.ok(seen.every((v, i) => i === 0 || v > seen[i - 1]), "rises in steps");
  assert.equal(audio.volume, 0.8);
  d.duck(false);
  d.duck(true); tm.advance(RESTORE_DELAY_MS + 100); d.duck(true);
  assert.equal(audio.volume, 0.8 * DUCK_FACTOR);
});

test("muted or a volume of zero is silence; the pause-on-listen lever pauses and resumes only what it paused", async () => {
  const s = setup();
  s.load("m1", { muted: true });
  assert.equal(s.audio.volume, 0);
  s.view.apply({ action: "volume", volume: 40, muted: false });
  assert.equal(s.audio.volume, 0.4);
  s.audio.fire("playing");
  s.view.hold(true, true);
  assert.equal(s.audio.paused, true);
  s.view.hold(false, true);
  s.audio.fire("playing");
  assert.deepEqual(s.events(), ["m1:playing", "m1:playing"], "the lever's pause is never reported as the user's");
  s.view.apply({ action: "pause", id: "m1" });
  s.view.hold(true, true); s.view.hold(false, true);
  assert.equal(s.audio.paused, true, "a session that was already paused stays paused");
});

test("a stream that fails while the socket is down (row B6-35): the failure is kept, sent again after ready, and again when the server's snapshot still names the item — the chip never shows playing over silence", async () => {
  const audio = fakeAudio(), chip = fakeChip(), sent = [], tm = timers();
  let up = true;
  const view = createMediaView({ audio, chip, send: (o) => { if (!up) return false; sent.push(o); return true; }, setTimer: tm.setTimer, clearTimer: tm.clearTimer });
  const snap = { type: "media", action: "load", id: "m1", form: "audio", url: "/display/t/m1xxxxxxxxxxxxxxxxxxxx/stream", title: "Station", source: "radio", volume: 50, muted: false };
  view.apply(snap);
  audio.fire("playing"); await flush();
  assert.deepEqual(sent.map((m) => m.state), ["playing"]);
  up = false;                                   // airplane mode: the HTTP stream dies with the network
  audio.fire("error");
  assert.equal(sent.length, 1, "nothing could leave");
  up = true;
  view.flush();                                 // the page's `ready`
  assert.deepEqual(sent.slice(1).map((m) => `${m.id}:${m.state}:${m.code}`), ["m1:error:load_failed"]);
  view.apply(snap);                             // the hello snapshot, sent before the server read the flushed report
  assert.deepEqual(sent.slice(2).map((m) => `${m.id}:${m.state}:${m.code}`), ["m1:error:load_failed"], "the same-id snapshot is answered with the failure, not taken as 'still playing'");
  assert.equal(audio.srcSets, 1, "no restart from 0:00");
  // The server then sends a fresh load (a station reload, or the next item): that plays normally.
  view.apply({ ...snap, id: "m2", url: "/display/t/m2xxxxxxxxxxxxxxxxxxxx/stream" });
  audio.fire("playing"); await flush();
  assert.equal(sent.at(-1).state, "playing");
  // A report that could not leave and is about an item that is gone is never replayed.
  up = false; audio.fire("error"); up = true;
  view.apply({ type: "media", action: "stop" });
  view.flush();
  assert.equal(sent.filter((m) => m.id === "m2" && m.state === "error").length, 0);
});

test("a failure the socket did carry is not repeated by flush()", async () => {
  const s = setup();
  s.load("m1"); s.audio.fire("error");
  s.view.flush();
  assert.deepEqual(s.events(), ["m1:error:load_failed"]);
});
