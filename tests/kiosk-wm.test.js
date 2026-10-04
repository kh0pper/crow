import { test } from "node:test";
import assert from "node:assert/strict";
import * as W from "../bundles/kiosk/server/wm.js";

function fakeTimers() {
  let t = 0; const q = [];
  return {
    now: () => t,
    setTimer: (fn, ms) => { const h = { fn, at: t + ms, live: true }; q.push(h); return h; },
    clearTimer: (h) => { if (h) h.live = false; },
    advance(ms) { t += ms; for (const h of q) if (h.live && h.at <= t) { h.live = false; h.fn(); } },
  };
}
function setup(caps) {
  const ft = fakeTimers(); const done = []; const emitted = [];
  const store = W.createWmStore({ ...ft, onTimerDone: (dev, w) => done.push(w) });
  const tool = W.createWmTool({ store, deviceId: "k", caps, emit: (e) => emitted.push(e) });
  return { ft, done, emitted, store, tool, run: async (command) => JSON.parse(await tool.execute({ command })) };
}

test("parseDuration: digits, units, words, an/a, combined; rejects nothing-found", () => {
  assert.equal(W.parseDuration("2 minutes tea").seconds, 120);
  assert.equal(W.parseDuration("1 hour 5 min").seconds, 3900);
  assert.equal(W.parseDuration("90s").seconds, 90);
  assert.equal(W.parseDuration("an hour").seconds, 3600);
  assert.equal(W.parseDuration("ten minutes").seconds, 600);
  assert.equal(W.parseDuration("half an hour").seconds, 1800);
  assert.equal(W.parseDuration("2 minutes called tea").after, "called tea");
  assert.equal(W.parseDuration("tea"), null);
});

test("timer: opens, fires onTimerDone at its end, stays (done) until closed; named stop works", async () => {
  const s = setup();
  const r = await s.run("set a timer for 2 minutes called tea");
  assert.equal(r.ok, true);
  const open = s.emitted.find((e) => e.action === "open");
  assert.equal(open.window.kind, "timer"); assert.equal(open.window.name, "Tea"); assert.equal(open.window.ends_at, 120_000);
  s.ft.advance(119_999); assert.equal(s.done.length, 0);
  s.ft.advance(1); assert.equal(s.done.length, 1); assert.equal(s.done[0].name, "Tea");
  assert.equal(s.store.list("k")[0].done, true);
  await s.run("timer 5 minutes pasta");
  assert.equal((await s.run("stop timer pasta")).ok, true);
  assert.deepEqual(s.store.list("k").map((w) => w.name), ["Tea"]);
});

test("timer bounds and missing duration are errors, not windows", async () => {
  const s = setup();
  assert.equal((await s.run("timer tea")).action, "error");
  assert.equal((await s.run("timer 30 hours")).action, "error");
  assert.equal(s.emitted.length, 0);
});

test("recipe + step navigation; content blocks match the display grammar", async () => {
  const s = setup();
  await s.run("recipe Lasagna | noodles; sauce; cheese | Boil noodles || 2. Layer sauce || Bake 45 minutes");
  const w = s.store.list("k")[0];
  assert.deepEqual(w.ingredients, ["noodles", "sauce", "cheese"]);
  assert.deepEqual(w.steps, ["Boil noodles", "Layer sauce", "Bake 45 minutes"]);
  assert.equal(W.matchWmFastPath("Next step.", s.store, "k").say, "Step 2. Layer sauce");
  assert.equal(W.matchWmFastPath("read the step", s.store, "k").say, "Step 2. Layer sauce");
  assert.equal(W.matchWmFastPath("go back", s.store, "k").say, "Step 1. Boil noodles");
  assert.deepEqual(W.contentBlocks("T", "Intro||- a\n- b"), [{ type: "heading", text: "T" }, { type: "text", text: "Intro" }, { type: "list", items: ["a", "b"] }]);
});

test("side-effect and desktop commands are refused WITHOUT running (ruling R3)", async () => {
  const s = setup();
  for (const c of ["invite Alice", "memo Bob hello", "react Bob 👍", "relay colibri lights", "search news", "open youtube cats", "open browser https://x.y", "open pet", "save workspace a"]) {
    const r = await s.run(c);
    assert.equal(r.action, "error", c);
  }
  assert.equal(s.emitted.length, 0);
});

test("caps filter both the tool description and execution", async () => {
  const s = setup({ windows: ["timer"] });
  assert.match(s.tool.definition.description, /timer/);
  assert.doesNotMatch(s.tool.definition.description, /recipe/);
  assert.equal((await s.run("recipe X | a | b")).action, "error");
  assert.deepEqual(W.normalizeCaps({ windows: ["timer", "youtube", "camera"], iframe: true, max_windows: 9 }), { windows: ["timer"], iframe: false, max_windows: 4 });
});

test("fast paths: only when the target exists; close/close-all/stop timer", async () => {
  const s = setup();
  assert.equal(W.matchWmFastPath("close", s.store, "k"), null);
  await s.run("display Notes | hello");
  await s.run("timer 1 minute tea");
  const fp = W.matchWmFastPath("Hey Crow, close the timer, please", s.store, "k");
  assert.equal(fp.say, "Timer stopped.");
  assert.equal(fp.events[0].action, "close");
  assert.equal(W.matchWmFastPath("close", s.store, "k").say, "Closed.");
  assert.equal(W.matchWmFastPath("what is a close call", s.store, "k"), null);
});

test("timer fast path: a spoken 'set a timer' opens it with no LLM; caps respected", () => {
  const s = setup();
  const fp = W.matchWmFastPath("Set a timer for 2 minutes called tea.", s.store, "k");
  assert.equal(fp.say, "Timer set for Tea: 2 minutes.");
  assert.equal(fp.events.at(-1).action, "open");
  assert.equal(s.store.list("k")[0].ends_at, 120_000);
  assert.equal(W.matchWmFastPath("start a timer for an hour", s.store, "k").say, "Timer set: 1 hour.");
  assert.equal(W.matchWmFastPath("set a timer for 2 minutes", s.store, "k", { windows: ["recipe"] }), null);
  assert.equal(W.matchWmFastPath("how long is a timer", s.store, "k"), null);
});

test("at most 4 windows: the oldest non-timer is evicted and a close is emitted", async () => {
  const s = setup();
  await s.run("timer 9 minutes a");
  for (const n of [1, 2, 3, 4]) await s.run(`display N${n} | x`);
  const kinds = s.store.list("k").map((w) => w.title);
  assert.equal(kinds.length, 4);
  assert.ok(!kinds.includes("N1"));
  assert.ok(s.emitted.some((e) => e.action === "close"));
});

test("idle sweep closes untouched non-timer windows after 10 min; prompt suffix lists windows within budget", async () => {
  const s = setup();
  await s.run("timer 30 minutes pasta");
  await s.run("display Notes | hi");
  s.ft.advance(W.IDLE_CLOSE_MS);
  assert.deepEqual(s.store.sweepIdle("k").map((w) => w.title), ["Notes"]);
  assert.match(W.kioskTurnContext(s.store, "k"), /^\[Display\] Open windows: timer 'Pasta' 20:00 left\.$/);
  const p = W.kioskPromptSuffix();
  assert.ok(p.length <= 1200, `suffix ${p.length} chars`);
  assert.equal(p, W.kioskPromptSuffix(), "static");
});
