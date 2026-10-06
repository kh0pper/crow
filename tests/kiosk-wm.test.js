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
  for (const n of [1, 2, 3, 4]) await s.run(`recipe N${n} | x | do it`);
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

test("timers are keyed per device: two devices' timer-1 never collide (close, replace-eviction, close-all)", () => {
  const cleared = []; const handles = [];
  const store = W.createWmStore({
    now: () => 0, setTimer: (fn, ms) => { const h = { fn, ms, id: handles.length }; handles.push(h); return h; },
    clearTimer: (h) => cleared.push(h.id), onTimerDone: () => {}, maxWindows: 2,
  });
  const a = store.open("A", { kind: "timer", name: "A1", title: "A1", seconds: 60 }).window;
  const b = store.open("B", { kind: "timer", name: "B1", title: "B1", seconds: 60 }).window;
  assert.equal(a.id, b.id);
  store.close("A", a.id);
  assert.deepEqual(cleared, [0]);
  store.closeAll("B");
  assert.deepEqual(cleared, [0, 1]);
  // eviction clears the evicted device's own timer only
  store.open("A", { kind: "timer", name: "x", title: "x", seconds: 5 });   // handle 2
  store.open("B", { kind: "timer", name: "y", title: "y", seconds: 5 });   // handle 3
  store.open("A", { kind: "timer", name: "x2", title: "x2", seconds: 5 });  // handle 4
  const r = store.open("A", { kind: "content", title: "c", blocks: [] });   // evicts A's oldest timer (handle 2)
  assert.equal(r.evicted.length, 1);
  assert.deepEqual(cleared.slice(2), [2]);
});

test("timer onTimerDone throwing does not escape the timer callback", () => {
  const ft = fakeTimers();
  const store = W.createWmStore({ ...ft, onTimerDone: () => { throw new Error("boom"); } });
  store.open("k", { kind: "timer", name: "T", title: "T", seconds: 1 });
  const orig = console.error; console.error = () => {};
  try { assert.doesNotThrow(() => ft.advance(1000)); } finally { console.error = orig; }
  assert.equal(store.list("k")[0].done, true);
});

test("compound number words parse correctly; ambiguous input yields null (falls to the LLM)", () => {
  assert.equal(W.parseDuration("forty five minutes").seconds, 2700);
  assert.equal(W.parseDuration("twenty-five minutes").seconds, 1500);
  assert.equal(W.parseDuration("fifteen minutes").seconds, 900);
  assert.equal(W.parseDuration("a minute and a half"), null);
  assert.equal(W.parseDuration("an hour and a half"), null);
  assert.equal(W.parseDuration("seventy minutes").seconds, 4200);
  const s = setup();
  assert.equal(W.matchWmFastPath("set a timer for forty five minutes", s.store, "k").say, "Timer set: 45 minutes.");
  assert.equal(s.store.list("k")[0].ends_at, 2_700_000);
  assert.equal(W.matchWmFastPath("set a timer for a minute and a half", s.store, "k"), null);
  assert.equal(W.matchWmFastPath("set a timer for 5 minutes, and tell me a joke", s.store, "k"), null);
  assert.equal(s.store.list("k").length, 1);
});

test("what's the step reads the step (apostrophe stripped by normalisation)", async () => {
  const s = setup();
  await s.run("recipe R | a | one || two");
  assert.equal(W.matchWmFastPath("What's the step?", s.store, "k").say, "Step 1. one");
});

// ── Live test 2026-10-04 (a small assistant, plain questions): junk cards, placeholder cards, piles of chips ──
test("wantsDisplay: only display/timer/recipe/window intent offers the display tool (en + es); plain questions do not", () => {
  const table = [
    // The live utterances.
    ["Tell me a joke", false],
    ["What time is it?", false],
    ["What's today's date?", false],
    ["set a timer for one minute and label it check", true],
    ["show me the shopping list", true],
    // Plain questions that brush against the word lists.
    ["What is the capital of Portugal?", false],
    ["What's a good TV show to watch tonight?", false],
    ["How close is the moon?", false],
    ["Is the store close by?", false],
    ["Explain photosynthesis step by step", false],
    ["Who put the bins out?", false],
    ["Why is the sky blue", false],
    ["", false],
    // Display intent.
    ["Display the grocery list", true],
    ["Put the recipe up", true],
    ["put that on the screen", true],
    ["can you list the planets on the display", true],
    ["Start a countdown for ten minutes", true],
    ["wake me with an alarm in an hour", true],
    ["How long is left on the timer?", true],
    ["Find me a recipe for pancakes", true],
    ["next step", true],
    ["what's the next step?", true],
    ["read the step again", true],
    ["Close that", true],
    ["Please dismiss it.", true],
    ["close all", true],
    ["clear the screen", true],
    ["pull up my notes", true],
    // Spanish.
    ["Cuéntame un chiste", false],
    ["¿Qué hora es?", false],
    ["¿Cuál es la capital de Portugal?", false],
    ["Pon un temporizador de diez minutos", true],
    ["Muéstrame la lista de la compra", true],
    ["muestrame la receta", true],
    ["ponlo en la pantalla", true],
    ["siguiente paso", true],
    ["Cierra eso", true],
    ["pon una alarma", true],
    ["cuenta atrás de cinco minutos", true],
  ];
  for (const [text, want] of table) assert.equal(W.wantsDisplay(text), want, JSON.stringify(text));
  assert.equal(W.wantsDisplay("[Display] Open windows: none.\n\nTell me a joke"), true, "callers must pass the PLAIN transcript: the context prefix itself reads as display intent");
});

test("the display tool is offered on a turn only for display intent, or while a window is open (follow-ups)", async () => {
  const s = setup();
  assert.equal(s.tool.when("Tell me a joke"), false);
  assert.equal(s.tool.when("What time is it?"), false);
  assert.equal(s.tool.when("set a timer for one minute and label it check"), true);
  assert.equal(s.tool.when("show me the shopping list"), true);
  await s.run("timer 1 minute check");
  assert.equal(s.tool.when("add two minutes"), true, "a window is open: follow-ups keep the tool");
  assert.equal(s.tool.when("Tell me a joke"), true);
  s.ft.advance(60_000);
  assert.equal(s.store.list("k")[0].done, true);
  assert.equal(s.tool.when("Tell me a joke"), false, "a finished timer waiting to be dismissed does not bring the tool back");
  assert.equal(s.tool.when("stop the timer"), true);
  await s.run("display Notes | hi");
  assert.equal(s.tool.when("Tell me a joke"), true);
  s.store.closeAll("k");
  assert.equal(s.tool.when("Tell me a joke"), false);
});

test("the tool's syntax help uses concrete examples — no angle-bracket placeholders anywhere a model could copy them", async () => {
  const s = setup();
  const d = s.tool.definition.description;
  assert.doesNotMatch(d, /[<>]/, d);
  for (const frag of ["timer 10 minutes pasta", "stop timer", "recipe ", "next step", "display ", "close all"]) assert.ok(d.includes(frag), frag);
  assert.ok(d.length <= 700, `description is ${d.length} chars (it is in every prompt that offers the tool)`);
  assert.doesNotMatch(JSON.stringify(s.tool.definition.inputSchema), /[<>]/);
  for (const bad of ["dance", "", "recipe", "timer tea", "recipe X | a"]) {
    const r = await s.run(bad);
    assert.equal(r.action, "error", bad);
    assert.doesNotMatch(r.message, /[<>]/, `error for ${JSON.stringify(bad)}: ${r.message}`);
  }
});

test("placeholders are never rendered: a display/recipe/timer command made of syntax placeholders or nothing is refused and opens nothing", async () => {
  const s = setup();
  const junk = [
    // The live card: the model copied the old syntax line.
    "display <title> | <text> — || starts a paragraph; lines starting '- ' become a list",
    "display <title> | <text>",
    "display <title> | It is three o'clock",
    "display Clock | <text>",
    "display title | text",
    "display Title | Text",
    "display | ",
    "display Notes | ",
    "display Notes |    ",
    "display Info | starts a paragraph; lines starting '- ' become a list",
    "display Shopping list | - milk\\n- eggs (title | text)",
    "recipe <title> | <ingredient>; <ingredient> | <step> || <step>",
    "recipe title | ingredients | steps",
    "recipe Pancakes | flour | <step>",
    "timer 10 minutes <name>",
    "timer <duration> <name>",
    "timer 5 minutes name",
  ];
  for (const c of junk) {
    const r = await s.run(c);
    assert.equal(r.action, "error", c);
    assert.match(r.message, /aloud/i, `${c} → the model is told to answer aloud`);
    assert.doesNotMatch(r.message, /[<>]/);
  }
  assert.deepEqual(s.store.list("k"), [], "nothing was opened");
  assert.equal(s.emitted.length, 0, "nothing was sent to the page");
  // Real content still works, including words that merely contain the placeholder words.
  assert.equal((await s.run("display Text messages | You have two new text messages")).ok, true);
  assert.equal((await s.run("timer 5 minutes name tags")).ok, true);
  assert.equal((await s.run("recipe Title page cake | flour; eggs | Mix || Bake")).ok, true);
  assert.equal((await s.run("display a note with no title")).ok, true);
  // Review: real content that only LOOKS like a placeholder is never refused.
  assert.equal((await s.run("display Ingredients | flour, eggs")).ok, true, "a card may be titled Ingredients");
  assert.equal((await s.run("display Steps | Mix, then bake")).ok, true);
  assert.equal((await s.run("display Math | if a < b and c > d then a < d")).ok, true, "comparison signs are not a placeholder");
  assert.equal((await s.run("recipe Name day cake | flour; eggs | Mix || Bake")).ok, true);
  assert.equal((await s.run("timer 3 minutes text mum")).ok, true);
  assert.equal(W.isPlaceholderText("< b and c >"), false);
  assert.equal(W.isPlaceholderText("<step one>"), true);
  assert.equal(W.isPlaceholderText("<title>"), true);
  assert.equal(W.isPlaceholderText("  "), true);
  assert.equal(W.isPlaceholderText("Shopping list"), false);
  assert.equal(W.isPlaceholderText("2 < 3 and 5 > 4"), false);
});

test("no echo cards: a display card is refused on a turn whose question had no display intent (a timer or recipe is not)", async () => {
  const s = setup();
  await s.run("timer 5 minutes tea");   // a window is open, so the tool is offered on the next plain question
  const run = async (command, transcript) => JSON.parse(await s.tool.execute({ command }, { transcript }));
  const joke = await run("display Info | Why did the crow sit on the wire? To make a long-distance caw.", "Tell me a joke");
  assert.equal(joke.action, "error");
  assert.match(joke.message, /aloud/i);
  assert.deepEqual(s.store.list("k").map((w) => w.kind), ["timer"], "no card was opened");
  assert.equal((await run("display Shopping list | - milk\n- eggs", "show me the shopping list")).ok, true);
  assert.equal((await run("timer 2 minutes eggs", "remind me about the eggs in two minutes")).ok, true, "timers are not echo cards");
  assert.equal((await run("close all", "never mind")).ok, true, "controls always run");
  assert.equal((await s.run("display Notes | hi")).ok, true, "no turn context (MCP show, tests): not guarded");
});

test("content cards do not stack: a new display card replaces the previous one; timers and recipes keep their windows", async () => {
  const s = setup();
  await s.run("timer 9 minutes pasta");
  await s.run("recipe Pancakes | flour | Mix || Cook");
  await s.run("display Info | one");
  s.emitted.length = 0;
  const r = await s.run("display Shopping list | - milk");
  assert.equal(r.ok, true);
  assert.deepEqual(s.store.list("k").map((w) => `${w.kind}:${w.title}`), ["timer:Pasta", "recipe:Pancakes", "content:Shopping list"]);
  assert.deepEqual(s.emitted.map((e) => e.action), ["close", "open"], "the page is told to close the old card, then open the new one");
  assert.equal(s.emitted[0].id, "content-3");
  for (const n of [1, 2, 3, 4, 5]) await s.run(`display Card ${n} | x`);
  assert.equal(s.store.list("k").filter((w) => w.kind === "content").length, 1, "chips stay bounded");
  assert.equal(s.store.list("k").length, 3);
  // The store itself enforces it (the MCP show tool opens content windows too).
  const { evicted } = s.store.open("k", { kind: "content", title: "Direct", blocks: [] });
  assert.deepEqual(evicted.map((w) => w.title), ["Card 5"]);
  // Per device.
  s.store.open("other", { kind: "content", title: "Elsewhere", blocks: [] });
  assert.equal(s.store.list("k").filter((w) => w.kind === "content")[0].title, "Direct");
});

// ── Live re-test 2026-10-04 (kiosk 0.1.7): a claimed display that never happened; a failed command with no retry ──
test("wantsNewDisplay: only a request for NEW content on the screen (show / display / put up / a new timer / a recipe) — never the close and step family, never a question about what is there", () => {
  const table = [
    // The live utterances.
    ["Show me a list of three fruits.", true],
    ["show me a shopping list with milk, eggs and bread", true],
    ["set a timer for one minute and label it check", true],
    // New content.
    ["Display the grocery list", true],
    ["Can you display my notes?", true],
    ["Put the recipe up", true],
    ["put that on the screen", true],
    ["pull up the weather", true],
    ["Start a countdown for ten minutes", true],
    ["Set an alarm for an hour", true],
    ["I need a five minute timer", true],
    ["timer for ten minutes", true],
    ["Show me the recipe for pancakes", true],
    ["Find me a recipe for pancakes", true],
    ["Muéstrame la lista de la compra", true],
    ["muestrame la receta de tortilla", true],
    ["ponlo en la pantalla", true],
    ["Pon un temporizador de diez minutos", true],
    ["pon una alarma en una hora", true],
    // The control family and questions: display intent, but nothing new to put up.
    ["next step", false],
    ["show me the next step", false],
    ["what's the next step?", false],
    ["read the step again", false],
    ["Close that", false],
    ["Please dismiss it.", false],
    ["close all", false],
    ["clear the screen", false],
    ["stop the timer", false],
    ["cancel the alarm", false],
    ["How long is left on the timer?", false],
    ["how much time is left on the countdown", false],
    ["Is the timer still running?", false],
    ["what's on the display?", false],
    ["How do I set a timer on my phone?", false],
    ["I need to stop the timer", false],
    ["I want to cancel the alarm", false],
    ["can you turn off the alarm", false],
    ["how can I display photos on my TV", false],
    ["¿Cómo pongo un temporizador en el móvil?", false],
    ["quiero parar la alarma", false],
    ["siguiente paso", false],
    ["Cierra eso", false],
    ["para el temporizador", false],
    ["cuánto queda del temporizador", false],
    // Not display intent at all.
    ["Tell me a joke", false],
    ["What time is it?", false],
    ["", false],
  ];
  for (const [text, want] of table) {
    assert.equal(W.wantsNewDisplay(text), want, JSON.stringify(text));
    if (want) assert.equal(W.wantsDisplay(text), true, `new display implies display intent: ${text}`);
  }
});

test("the display tool says when a turn MUST end with something on the screen, and carries the note for the corrective round", async () => {
  const s = setup();
  assert.equal(typeof s.tool.must, "function");
  assert.equal(s.tool.must("Show me a list of three fruits."), true);
  assert.equal(s.tool.must("Tell me a joke"), false);
  await s.run("display Shopping list | milk, eggs, bread");
  assert.equal(s.tool.when("Tell me a joke"), true, "offered because a window is open…");
  assert.equal(s.tool.must("Tell me a joke"), false, "…but an open window never makes a display mandatory");
  assert.equal(s.tool.must("close that"), false);
  assert.match(s.tool.mustNote, /nothing/i);
  assert.equal(s.tool.mustDone({ ok: true, code: "ok", action: "open" }), true, "only something newly put up counts");
  assert.equal(s.tool.mustDone({ ok: true, code: "ok", action: "close" }), false);
  assert.equal(s.tool.mustDone({ ok: true, code: "ok", action: "step" }), false);
  assert.equal(s.tool.mustDone({ action: "error", code: "placeholder" }), false);
  assert.equal(s.tool.mustDone(null), false);
  assert.match(s.tool.mustNote, /crow_wm/);
  assert.doesNotMatch(s.tool.mustNote, /[<>]/);
  const timerOnly = setup({ windows: ["timer"] });
  assert.equal(timerOnly.tool.must("Show me a list of three fruits."), false, "a display that cannot show cards is never required to");
  assert.equal(timerOnly.tool.must("set a timer for one minute and label it check"), true);
});

test("every result carries a machine code for the log (never the command or its text): ok, or why nothing happened", async () => {
  const s = setup();
  const code = async (command, transcript) => JSON.parse(await s.tool.execute({ command }, transcript === undefined ? undefined : { transcript })).code;
  assert.equal(await code("display Fruits | apples, bananas, cherries", "show me a list of three fruits"), "ok");
  assert.equal(await code("timer 1 minute check"), "ok");
  assert.equal(await code("close all"), "ok");
  assert.equal(await code("dance"), "unknown_command");
  assert.equal(await code(""), "unknown_command");
  assert.equal(await code("show Fruits | apples"), "unknown_command");
  assert.equal(await code("display <title> | <text>"), "placeholder");
  assert.equal(await code("display Notes | "), "placeholder");
  assert.equal(await code("timer tea"), "bad_timer");
  assert.equal(await code("timer 30 hours"), "bad_timer");
  assert.equal(await code("recipe Pancakes | flour"), "bad_recipe");
  assert.equal(await code("display Info | a joke", "Tell me a joke"), "no_intent");
  assert.equal(await code("next step"), "nothing_open");
  assert.equal(await code("close"), "nothing_open");
  const timerOnly = setup({ windows: ["timer"] });
  assert.equal(JSON.parse(await timerOnly.tool.execute({ command: "display Notes | hi" })).code, "unsupported_window");
  for (const c of ["unknown_command", "placeholder", "bad_timer", "bad_recipe", "no_intent", "nothing_open", "unsupported_window", "ok"]) assert.ok(W.WM_CODES.includes(c), c);
});

test("a failed command names the closest form to use, by example, so one retry can succeed", async () => {
  const s = setup();
  const msg = async (command) => { const r = await s.run(command); assert.equal(r.action, "error", command); assert.doesNotMatch(r.message, /[<>]/); return r.message; };
  // What a model that wants a card tends to send instead of "display Title | text".
  for (const c of ["show Fruits | apples, bananas, cherries", "list apples, bananas, cherries", "add apples, bananas and cherries to Shopping list", "update Shopping list | apples", "Fruits | apples, bananas, cherries", "note buy milk", "content Fruits: apples", "card Fruits"]) {
    const m = await msg(c);
    assert.match(m, /display Shopping list \| milk, eggs, bread/, c);
    assert.doesNotMatch(m, /timer 10 minutes|recipe Pancakes/, `${c}: only the closest form`);
    assert.match(m, /real/i, c);
  }
  for (const c of ["set timer pasta", "countdown 10", "remind me in ten minutes", "alarm 7am", "start a 5 timer"]) {
    const m = await msg(c);
    assert.match(m, /timer 10 minutes pasta/, c);
    assert.doesNotMatch(m, /display Shopping list|recipe Pancakes/, c);
  }
  for (const c of ["cook pancakes", "recipe Pancakes", "recipe Pancakes | flour", "ingredients flour, eggs"]) {
    const m = await msg(c);
    assert.match(m, /recipe Pancakes \| flour; milk; eggs \| Mix the batter \|\| Cook two minutes a side/, c);
  }
  // A placeholder names the form of what was tried.
  assert.match(await msg("display <title> | <text>"), /display Shopping list \| milk, eggs, bread/);
  assert.match(await msg("recipe <title> | <ingredient> | <step>"), /recipe Pancakes/);
  assert.match(await msg("timer 5 minutes <name>"), /timer 10 minutes pasta/);
  // Nothing recognisable: the whole list, as before.
  const all = await msg("dance");
  for (const frag of ["timer 10 minutes pasta", "recipe Pancakes", "display Shopping list", "close all"]) assert.ok(all.includes(frag), frag);
  assert.deepEqual(s.store.list("k"), [], "none of these opened anything");
});

test("a retry in the right form replaces the card; a card with the same title is replaced too (old id closed, new id opened)", async () => {
  const s = setup();
  await s.run("display Shopping list | milk, eggs, bread");
  const first = s.store.list("k")[0].id;
  assert.equal((await s.run("show Fruits | apples, bananas, cherries")).code, "unknown_command");
  assert.equal(s.store.list("k")[0].id, first, "the failed command changed nothing");
  s.emitted.length = 0;
  assert.equal((await s.run("display Fruits | apples, bananas, cherries")).ok, true);
  assert.deepEqual(s.emitted.map((e) => [e.action, e.id || e.window?.id]), [["close", first], ["open", "content-2"]]);
  s.emitted.length = 0;
  assert.equal((await s.run("display Fruits | apples, bananas, cherries, dates")).ok, true);
  assert.deepEqual(s.emitted.map((e) => [e.action, e.id || e.window?.id]), [["close", "content-2"], ["open", "content-3"]], "same title: still a fresh window");
  assert.deepEqual(s.store.list("k").map((w) => [w.title, w.blocks.at(-1).text]), [["Fruits", "apples, bananas, cherries, dates"]]);
});

test("store.put: the same title in the same kind replaces that card or recipe (updated); a new title opens; a timer is never replaced", () => {
  const armed = [];
  const store = W.createWmStore({ now: () => 0, setTimer: (fn, ms) => { armed.push(ms); return {}; }, clearTimer: () => {} });
  const a = store.put("k", { kind: "recipe", title: "Lasagna", ingredients: [], steps: ["a"], step: 0 });
  assert.deepEqual([a.updated, a.evicted.length], [false, 0]);
  const b = store.put("k", { kind: "recipe", title: "lasagna", ingredients: [], steps: ["b"], step: 0 });
  assert.deepEqual([b.updated, b.evicted.map((e) => e.id)], [true, [a.window.id]]);
  assert.equal(store.list("k").length, 1);
  store.put("k", { kind: "timer", name: "Rice", title: "Rice", seconds: 60 });
  const t2 = store.put("k", { kind: "timer", name: "Rice", title: "Rice", seconds: 120 });
  assert.deepEqual([t2.updated, t2.evicted.length], [false, 0], "setting a timer never cancels one that is running");
  assert.deepEqual(armed, [60000, 120000]);
  assert.equal(store.list("k").filter((w) => w.kind === "timer").length, 2);
  const c1 = store.put("k", { kind: "content", title: "Fruits", blocks: [] });
  const c2 = store.put("k", { kind: "content", title: "Vegetables", blocks: [] });
  assert.deepEqual([c2.updated, c2.evicted.map((e) => e.id)], [false, [c1.window.id]], "one content card per display still holds: a new subject replaces, and is not an update");
});
