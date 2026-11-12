/**
 * Ramble Moves player Task 7.1 — rendering one step from a fixture timeline.
 *
 * player.js, session.cjs and figure.cjs are loaded into one vm context with a
 * small fake DOM, the way the panel loads them with plain script tags. The
 * library below is built in-test from three small fixtures; nothing here reads
 * the shipped moves library.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const MOVES_DIR = join(ROOT, "bundles", "ramble", "server", "moves");

const SESSION_SRC = readFileSync(join(MOVES_DIR, "session.cjs"), "utf8");
const FIGURE_SRC = readFileSync(join(MOVES_DIR, "figure.cjs"), "utf8");
const PLAYER_SRC = readFileSync(join(ROOT, "bundles", "ramble", "panel", "static", "player.js"), "utf8");
const COPY = JSON.parse(readFileSync(join(MOVES_DIR, "player-copy.en.json"), "utf8"));

/* The page supplies the safety note and the Start label; the rest is the
 * shipped copy, handed to the player as one object. */
const PAGE_COPY = { ...COPY, safety: "Safety note from the page", start: "Start" };

/* ---------- fixture library ---------- */

const LIB = [
  {
    id: "pose-reach",
    kind: "pose",
    title: "Reach up",
    minutes: 1,
    pose: { rootAngle: 4, shoulderL: 150, shoulderR: 150 },
    steps: [{ text: "Reach up tall", cue: "Reach up tall", say: "Reach up tall" }],
    anatomy: [{ main: "shoulders" }],
  },
  {
    id: "pose-fold",
    kind: "pose",
    title: "Fold forward",
    minutes: 1,
    pose: { rootAngle: 80, spine: 30, shoulderL: 40, shoulderR: 40 },
    steps: [{ text: "Fold forward", cue: "Fold forward", say: "Fold forward" }],
    anatomy: [{ main: "hamstrings" }],
  },
  {
    id: "ex-arms",
    kind: "exercise",
    title: "Arm circles",
    minutes: 1,
    reps: 8,
    poses: [{ shoulderL: 20, shoulderR: 20 }, { shoulderL: 120, shoulderR: 120 }],
    steps: [{ text: "Small circles", cue: "Small circles", say: "Small circles" }, "Then shake them out"],
    anatomy: [{ main: "shoulders" }],
  },
  {
    id: "chunk-a",
    kind: "routine",
    title: "Fixture routine",
    minutes: 11,
    rounds: 1,
    steps: [{ text: "warm-up, main, cool-down", cue: "warm-up", say: "warm-up" }],
    blocks: {
      warmup: [{ id: "pose-reach", seconds: 60 }],
      main: [{ id: "ex-arms", seconds: 30, restSeconds: 10 }],
      cooldown: [{ id: "pose-fold", seconds: 30 }],
    },
  },
];

const CHAIN = [{ chunkId: "chunk-a" }];

function entryTitle(id) {
  const entry = LIB.find((one) => one.id === id);
  return entry ? entry.title : "";
}

/* ---------- the fake DOM ---------- */

class FakeEl {
  constructor(tag) {
    this.tagName = String(tag || "div").toUpperCase();
    this.attrs = Object.create(null);
    this.listeners = Object.create(null);
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.textContent = "";
    this.innerHTML = "";
    this.clientWidth = 0;
  }
  get firstChild() { return this.children.length > 0 ? this.children[0] : null; }
  addEventListener(type, fn) {
    const list = this.listeners[type] || (this.listeners[type] = []);
    list.push(fn);
  }
  removeEventListener(type, fn) {
    const list = this.listeners[type] || [];
    this.listeners[type] = list.filter((one) => one !== fn);
  }
  listenerCount(type) { return (this.listeners[type] || []).length; }
  setAttribute(name, value) { this.attrs[String(name)] = String(value); }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }
  removeAttribute(name) { delete this.attrs[name]; }
  hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name); }
  appendChild(child) {
    if (child.parentNode && typeof child.parentNode.removeChild === "function") {
      child.parentNode.removeChild(child);
    }
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    this.children = this.children.filter((one) => one !== child);
    if (child && child.parentNode === this) child.parentNode = null;
    return child;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  querySelectorAll() { return []; }
  querySelector() { return null; }
  focus() {}
  blur() {}
  closest() { return null; }
  click() {
    (this.listeners.click || []).slice().forEach((fn) => fn({ target: this }));
  }
}

/* Every element carrying this data-role, in tree order. */
function byRole(host, role) {
  const queue = host.children.slice();
  while (queue.length > 0) {
    const node = queue.shift();
    if (node.getAttribute("data-role") === role) return node;
    if (node.children.length > 0) queue.push(...node.children);
  }
  return null;
}

/* Every element carrying this data-role, all of them. */
function allByRole(host, role) {
  const found = [];
  const queue = host.children.slice();
  while (queue.length > 0) {
    const node = queue.shift();
    if (node.getAttribute("data-role") === role) found.push(node);
    if (node.children.length > 0) queue.push(...node.children);
  }
  return found;
}

function fakeClock() {
  return {
    time: 0,
    intervals: [],
    cleared: [],
    now() { return this.time; },
    setInterval(fn, ms) {
      this.intervals.push({ fn, ms });
      return this.intervals.length;
    },
    clearInterval(id) { this.cleared.push(id); },
  };
}

/* ---------- loading the three scripts into one context ---------- */

function boot(settings) {
  const options = settings || {};
  const host = new FakeEl("div");
  if (typeof options.clientWidth === "number") host.clientWidth = options.clientWidth;
  const clock = fakeClock();
  const docListeners = Object.create(null);
  const doc = {
    hidden: false,
    createElement: (tag) => new FakeEl(tag),
    querySelectorAll: () => [],
    addEventListener(type, fn) {
      const list = docListeners[type] || (docListeners[type] = []);
      list.push(fn);
    },
    removeEventListener(type, fn) {
      const list = docListeners[type] || [];
      docListeners[type] = list.filter((one) => one !== fn);
    },
  };
  const sandbox = {
    console,
    document: doc,
    matchMedia: () => ({ matches: options.prefersReducedMotion === true }),
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  new vm.Script(SESSION_SRC, { filename: "session.cjs" }).runInContext(sandbox);
  new vm.Script(FIGURE_SRC, { filename: "figure.cjs" }).runInContext(sandbox);
  new vm.Script(PLAYER_SRC, { filename: "player.js" }).runInContext(sandbox);
  return { host, clock, sandbox, doc, docListeners };
}

/* A tab going away (or coming back) is one document event. */
function fireVisibility(booted, hidden) {
  booted.doc.hidden = hidden === true;
  (booted.docListeners.visibilitychange || []).slice().forEach((fn) => fn({ type: "visibilitychange" }));
}

function mountPlayer(booted, over) {
  const options = {
    chain: CHAIN,
    library: LIB,
    copy: PAGE_COPY,
    guidance: "full",
    clock: booted.clock,
    reducedMotion: true,
    ...(over || {}),
  };
  const player = booted.sandbox.RamblePlayer.mount(booted.host, options);
  return { player, options };
}

/* The segments the player itself compiles from the same fixtures. */
function segmentsOf(sandbox) {
  return sandbox.RambleSession.compileTimeline("chunk-a", LIB, { guidance: "full" }).segments;
}

/* Move the injected clock forward and run the player's own interval beat. */
function advance(clock, seconds) {
  clock.time += Math.round(seconds * 1000);
  const latest = clock.intervals[clock.intervals.length - 1];
  assert.ok(latest, "the player must have started its interval");
  latest.fn();
}

function fillCopy(template, values) {
  return template.replace(/\{([a-z]+)\}/g, (whole, key) => String(values[key]));
}

/* ---------- tests ---------- */

test("render: after Start the figure, name, cue and next show segment 0, and a boundary moves all four", () => {
  const booted = boot({ clientWidth: 1200 });
  const segments = segmentsOf(booted.sandbox);
  const { player } = mountPlayer(booted);
  const start = byRole(booted.host, "start");
  assert.ok(start, "a start button is offered before the session runs");
  start.click();

  const figure = byRole(booted.host, "figure");
  const name = byRole(booted.host, "name");
  const cue = byRole(booted.host, "cue");
  const next = byRole(booted.host, "next");
  const strip = byRole(booted.host, "strip");

  assert.equal(player.state().segmentIndex, 0);
  const plainState = JSON.parse(JSON.stringify(player.state()));
  assert.deepEqual(plainState, {
    layout: "kiosk", started: true, segmentIndex: 0, paused: false, ended: false, sheetOpen: false,
  });
  assert.equal(segments[0].type, "hold", "the fixture opens on a hold");
  assert.equal(figure.innerHTML, booted.sandbox.RambleFigure.poseSvg(segments[0].toPose));
  assert.equal(name.textContent, entryTitle("pose-reach"));
  assert.equal(cue.textContent, segments[0].cue);
  const firstNext = next.textContent;
  assert.equal(firstNext, fillCopy(COPY["player.next"], { name: entryTitle("ex-arms") }));

  assert.equal(strip.children.length, 3, "one strip child per work segment");
  assert.equal(strip.children[0].getAttribute("data-current"), "1");

  /* Across the hold and its transition, into the reps segment. */
  advance(booted.clock, 63);

  assert.equal(player.state().segmentIndex, 2);
  assert.equal(segments[2].type, "reps");
  assert.equal(figure.innerHTML, booted.sandbox.RambleFigure.poseSvg(segments[2].toPose));
  assert.equal(name.textContent, entryTitle("ex-arms"));
  assert.equal(cue.textContent, segments[2].cue);
  assert.equal(next.textContent, fillCopy(COPY["player.rest.next"], { name: entryTitle("pose-fold") }));
  assert.notEqual(next.textContent, firstNext);
});

test("render: a hold counts down, a reps step shows its reps, a rest shows the next figure", () => {
  const booted = boot();
  const segments = segmentsOf(booted.sandbox);
  mountPlayer(booted);
  const clockFace = byRole(booted.host, "clock");
  const figure = byRole(booted.host, "figure");
  byRole(booted.host, "start").click();

  assert.equal(segments[0].type, "hold");
  assert.equal(clockFace.textContent, "60", "a 60 second hold opens at 60");
  advance(booted.clock, 10);
  assert.equal(clockFace.textContent, "50", "ten seconds in, fifty are left");

  advance(booted.clock, 52);
  assert.equal(segments[2].type, "reps");
  assert.equal(clockFace.textContent, String(segments[2].reps), "a reps step shows its rep count");

  advance(booted.clock, 30);
  assert.equal(segments[3].type, "rest");
  assert.equal(clockFace.textContent, "10", "the rest shows its own seconds left");
  assert.equal(byRole(booted.host, "name").textContent, COPY["player.rest"]);
  assert.equal(figure.innerHTML, booted.sandbox.RambleFigure.poseSvg(segments[4].toPose),
    "a rest rests before the next segment's figure");
});

test("render: reduced motion draws the toPose and never interpolates", () => {
  const booted = boot();
  const segments = segmentsOf(booted.sandbox);
  const Figure = booted.sandbox.RambleFigure;
  const realSvg = Figure.poseSvg;
  const realInterpolate = Figure.interpolate;
  let interpolated = 0;
  const drawn = [];
  Figure.interpolate = (from, to, t) => { interpolated += 1; return realInterpolate(from, to, t); };
  Figure.poseSvg = (pose, opts) => { drawn.push(JSON.parse(JSON.stringify(pose))); return realSvg(pose, opts); };

  mountPlayer(booted, { reducedMotion: true });
  byRole(booted.host, "start").click();
  advance(booted.clock, 0.5);

  assert.equal(interpolated, 0, "reduced motion must not tween");
  assert.equal(drawn.length > 0, true, "a figure was drawn");
  assert.deepEqual(drawn[drawn.length - 1], JSON.parse(JSON.stringify(segments[0].toPose)));
  assert.equal(byRole(booted.host, "figure").innerHTML, realSvg(segments[0].toPose));

  /* The same start without the preference does tween, so the guard is the
   * preference itself. */
  const moving = boot();
  const MovingFigure = moving.sandbox.RambleFigure;
  let movingInterpolated = 0;
  const realMovingInterpolate = MovingFigure.interpolate;
  MovingFigure.interpolate = (from, to, t) => {
    movingInterpolated += 1;
    return realMovingInterpolate(from, to, t);
  };
  mountPlayer(moving, { reducedMotion: false });
  byRole(moving.host, "start").click();
  advance(moving.clock, 0.5);
  assert.equal(movingInterpolated > 0, true, "without the preference the pose tweens in");
});

test("render: the safety note shows before the first Start only", () => {
  const booted = boot();
  mountPlayer(booted);

  const safety = byRole(booted.host, "safety");
  assert.ok(safety, "the page's safety note is on screen before Start");
  assert.equal(safety.textContent, PAGE_COPY.safety);
  assert.equal(byRole(booted.host, "start").textContent, PAGE_COPY.start);

  byRole(booted.host, "start").click();
  assert.equal(byRole(booted.host, "safety"), null, "the safety note goes when the session starts");
  assert.equal(byRole(booted.host, "start"), null, "the start button goes with it");

  /* No safety string from the page, no safety element. */
  const bare = boot();
  mountPlayer(bare, { copy: { ...PAGE_COPY, safety: "" } });
  assert.equal(byRole(bare.host, "safety"), null);
});

test("render: layout comes from the host width unless the caller names one", () => {
  const phone = boot({ clientWidth: 360 });
  const onPhone = mountPlayer(phone);
  assert.equal(phone.host.getAttribute("data-layout"), "phone");
  assert.equal(onPhone.player.state().layout, "phone");

  const kiosk = boot({ clientWidth: 1200 });
  const onKiosk = mountPlayer(kiosk);
  assert.equal(kiosk.host.getAttribute("data-layout"), "kiosk");
  assert.equal(onKiosk.player.state().layout, "kiosk");

  const named = boot({ clientWidth: 360 });
  const onNamed = mountPlayer(named, { layout: "class" });
  assert.equal(named.host.getAttribute("data-layout"), "class");
  assert.equal(onNamed.player.state().layout, "class");
});

test("render: the client script is a classic script, newline-terminated, with no template literals", () => {
  assert.equal(PLAYER_SRC.includes("`"), false, "player.js carries no backtick");
  assert.equal(PLAYER_SRC.endsWith("\n"), true, "player.js ends with a newline");
  assert.equal(/\b(import|export)\s/.test(PLAYER_SRC), false, "player.js is not an ES module");
});

test("render: the player never posts during a session so far", () => {
  const posted = [];
  const booted = boot();
  mountPlayer(booted, { post: (body) => { posted.push(body); } });
  byRole(booted.host, "start").click();
  advance(booted.clock, 5);
  advance(booted.clock, 60);
  advance(booted.clock, 40);
  assert.deepEqual(posted, [], "posting arrives in a later step");
});

test("render: destroy clears the interval, the listener and the host", () => {
  const booted = boot();
  const { player } = mountPlayer(booted);
  const start = byRole(booted.host, "start");
  start.click();
  advance(booted.clock, 5);
  assert.equal(booted.clock.intervals.length, 1);

  player.destroy();

  assert.equal(booted.host.children.length, 0, "the player leaves the host empty");
  assert.deepEqual(booted.clock.cleared, [1], "the interval it started is cleared");
  assert.equal(start.listenerCount("click"), 0, "the start listener is taken off");
});

/* ---------- the controls ---------- */

test("controls: tapping a strip step seeks there and the figure, name, cue and next follow", () => {
  const booted = boot();
  const segments = segmentsOf(booted.sandbox);
  const { player } = mountPlayer(booted);
  byRole(booted.host, "start").click();

  const strip = byRole(booted.host, "strip");
  assert.deepEqual(strip.children.map((one) => one.tagName), ["BUTTON", "BUTTON", "BUTTON"],
    "every strip step is a button");
  assert.deepEqual(strip.children.map((one) => one.getAttribute("data-index")), ["0", "2", "5"]);
  assert.equal(strip.children[0].getAttribute("data-current"), "1");

  strip.children[2].click();

  assert.equal(player.state().segmentIndex, 5);
  assert.equal(byRole(booted.host, "figure").innerHTML,
    booted.sandbox.RambleFigure.poseSvg(segments[5].toPose));
  assert.equal(byRole(booted.host, "name").textContent, entryTitle("pose-fold"));
  assert.equal(byRole(booted.host, "cue").textContent, segments[5].cue);
  assert.equal(byRole(booted.host, "next").textContent, "");
  assert.equal(strip.children[2].getAttribute("data-current"), "1", "the current step moves");
  assert.equal(strip.children[0].hasAttribute("data-current"), false);

  /* The clock runs on from the step that was tapped. */
  advance(booted.clock, 5);
  assert.equal(byRole(booted.host, "clock").textContent, "25");

  /* A step in the middle: the name, cue and next line are that step's own. */
  strip.children[1].click();
  assert.equal(player.state().segmentIndex, 2);
  assert.equal(byRole(booted.host, "name").textContent, entryTitle("ex-arms"));
  assert.equal(byRole(booted.host, "cue").textContent, segments[2].cue);
  assert.equal(byRole(booted.host, "next").textContent,
    fillCopy(COPY["player.rest.next"], { name: entryTitle("pose-fold") }));
});

test("controls: Set done moves a reps segment on", () => {
  const booted = boot();
  const segments = segmentsOf(booted.sandbox);
  const { player } = mountPlayer(booted);
  byRole(booted.host, "start").click();

  assert.equal(segments[0].type, "hold");
  assert.equal(byRole(booted.host, "set-done"), null, "a hold offers no Set done");

  advance(booted.clock, 63);
  assert.equal(segments[2].type, "reps");
  const setDone = byRole(booted.host, "set-done");
  assert.ok(setDone, "a reps step offers Set done");
  assert.equal(setDone.tagName, "BUTTON");
  assert.equal(setDone.getAttribute("type"), "button");
  assert.equal(setDone.textContent, COPY["player.setDone"]);

  setDone.click();

  assert.equal(player.state().segmentIndex, 3);
  assert.equal(segments[3].type, "rest");
  assert.equal(byRole(booted.host, "set-done"), null, "Set done goes with the reps step");
});

test("controls: a rest offers Skip rest and pressing it moves on", () => {
  const booted = boot();
  const segments = segmentsOf(booted.sandbox);
  const { player } = mountPlayer(booted);
  byRole(booted.host, "start").click();

  advance(booted.clock, 63);
  assert.equal(segments[2].type, "reps");
  assert.equal(byRole(booted.host, "skip-rest"), null, "a reps step offers no Skip rest");

  advance(booted.clock, 30);
  assert.equal(segments[3].type, "rest");
  const skipRest = byRole(booted.host, "skip-rest");
  assert.ok(skipRest, "a rest offers Skip rest");
  assert.equal(skipRest.tagName, "BUTTON");
  assert.equal(skipRest.getAttribute("type"), "button");
  assert.equal(skipRest.textContent, COPY["player.rest.skip"]);

  skipRest.click();

  assert.equal(player.state().segmentIndex, 4);
  assert.equal(byRole(booted.host, "skip-rest"), null, "Skip rest goes with the rest");
});

test("controls: Back, Pause, Keep going and Skip work", () => {
  const booted = boot();
  const { player } = mountPlayer(booted);

  assert.equal(byRole(booted.host, "pause"), null, "the pause control waits for Start");
  assert.equal(byRole(booted.host, "status"), null);

  byRole(booted.host, "start").click();
  const pause = byRole(booted.host, "pause");
  assert.ok(pause, "after Start there is a pause control");
  assert.equal(pause.tagName, "BUTTON");
  assert.equal(pause.getAttribute("type"), "button");
  assert.equal(pause.textContent, COPY["player.pause"]);
  assert.equal(pause.getAttribute("aria-pressed"), "false");
  assert.equal(byRole(booted.host, "status"), null, "nothing is paused yet");

  advance(booted.clock, 63);
  assert.equal(player.state().segmentIndex, 2);

  byRole(booted.host, "back").click();
  assert.equal(player.state().segmentIndex, 0, "Back returns to the step before");

  byRole(booted.host, "skip").click();
  assert.equal(player.state().segmentIndex, 1, "Skip moves on one segment");

  byRole(booted.host, "pause").click();
  assert.equal(player.state().paused, true);
  assert.equal(byRole(booted.host, "pause").textContent, COPY["player.keepGoing"]);
  assert.equal(byRole(booted.host, "pause").getAttribute("aria-pressed"), "true");
  assert.equal(byRole(booted.host, "status").textContent, COPY["player.paused"]);

  byRole(booted.host, "pause").click();
  assert.equal(player.state().paused, false, "Keep going runs the clock again");
  assert.equal(byRole(booted.host, "pause").textContent, COPY["player.pause"]);
  assert.equal(byRole(booted.host, "status"), null);

  byRole(booted.host, "skip").click();
  assert.equal(player.state().segmentIndex, 2);
});

test("controls: More opens the sheet and pauses, and closing it does not resume", () => {
  const booted = boot();
  const { player } = mountPlayer(booted);
  byRole(booted.host, "start").click();
  advance(booted.clock, 63);

  assert.equal(player.state().sheetOpen, false);
  assert.equal(byRole(booted.host, "sheet"), null, "the sheet is not on screen until it opens");

  const more = byRole(booted.host, "more");
  assert.ok(more);
  assert.equal(more.textContent, COPY["player.more"]);
  more.click();

  const sheet = byRole(booted.host, "sheet");
  assert.ok(sheet, "the sheet is on screen");
  assert.equal(sheet.getAttribute("role"), "dialog");
  assert.equal(sheet.getAttribute("aria-modal"), "true");
  assert.equal(player.state().sheetOpen, true);
  assert.equal(player.state().paused, true, "opening the sheet pauses the clock");
  assert.equal(byRole(booted.host, "status").textContent, COPY["player.paused"]);

  assert.equal(byRole(booted.host, "sheet-title").textContent, entryTitle("ex-arms"));
  const steps = allByRole(booted.host, "sheet-step");
  const entry = LIB.find((one) => one.id === "ex-arms");
  assert.equal(steps.length, entry.steps.length, "one child per library step");
  assert.equal(steps[0].textContent, entry.steps[0].text);
  assert.equal(steps[1].textContent, entry.steps[1], "a step written as a plain string is its own text");

  const close = byRole(booted.host, "sheet-close");
  assert.ok(close);
  assert.equal(close.textContent, COPY["player.back"]);
  close.click();

  assert.equal(byRole(booted.host, "sheet"), null, "the sheet goes");
  assert.equal(player.state().sheetOpen, false);
  assert.equal(player.state().paused, true, "closing the sheet never starts the clock again");
  assert.equal(player.state().segmentIndex, 2);
});

test("controls: a hidden tab pauses the session", () => {
  const booted = boot();
  const { player } = mountPlayer(booted);
  byRole(booted.host, "start").click();
  assert.equal(player.state().paused, false);

  fireVisibility(booted, true);

  assert.equal(player.state().paused, true, "a tab that goes away is a pause");
  assert.equal(byRole(booted.host, "pause").textContent, COPY["player.keepGoing"]);
  assert.equal(byRole(booted.host, "status").textContent, COPY["player.paused"]);

  fireVisibility(booted, false);
  assert.equal(player.state().paused, true, "coming back never starts the clock by itself");
});

test("controls: the wake lock is asked for on play and handed back on pause", async () => {
  const booted = boot();
  const asked = [];
  const handedBack = [];
  const handle = { release() { handedBack.push("released"); } };
  const { player } = mountPlayer(booted, {
    wakeLock: { request() { asked.push("request"); return handle; } },
  });

  assert.equal(asked.length, 0, "nothing is asked for before Start");
  byRole(booted.host, "start").click();
  assert.equal(asked.length, 1);

  byRole(booted.host, "pause").click();
  assert.equal(handedBack.length, 1, "a pause hands the lock back");

  byRole(booted.host, "pause").click();
  assert.equal(asked.length, 2, "Keep going asks for it again");

  player.destroy();
  assert.equal(handedBack.length, 2, "destroy hands the lock back");

  /* A request that answers with a promise: a lock that lands after the pause is
   * handed straight back, and one that lands while running is released on the
   * next pause. */
  const late = boot();
  const lateEvents = [];
  const lateHandle = { release() { lateEvents.push("late"); } };
  mountPlayer(late, { wakeLock: { request() { return Promise.resolve(lateHandle); } } });
  byRole(late.host, "start").click();
  byRole(late.host, "pause").click();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(lateEvents, ["late"], "a lock that lands after the pause goes back");

  const live = boot();
  const liveEvents = [];
  const liveHandle = { release() { liveEvents.push("live"); } };
  mountPlayer(live, { wakeLock: { request() { return Promise.resolve(liveHandle); } } });
  byRole(live.host, "start").click();
  await Promise.resolve();
  await Promise.resolve();
  byRole(live.host, "pause").click();
  assert.deepEqual(liveEvents, ["live"], "a lock that landed while running is released");
});

test("controls: a missing, a throwing or a rejecting wake lock is not an error", async () => {
  const none = boot();
  const bare = mountPlayer(none);
  assert.doesNotThrow(() => byRole(none.host, "start").click());
  assert.doesNotThrow(() => byRole(none.host, "pause").click());
  bare.player.destroy();

  const throwing = boot();
  const threw = mountPlayer(throwing, { wakeLock: { request() { throw new Error("no lock here"); } } });
  assert.doesNotThrow(() => byRole(throwing.host, "start").click());
  assert.equal(threw.player.state().paused, false, "a lock that cannot be asked for leaves the session running");
  assert.doesNotThrow(() => byRole(throwing.host, "pause").click());
  assert.equal(threw.player.state().paused, true);

  const rejecting = boot();
  const { player } = mountPlayer(rejecting, {
    wakeLock: { request() { return Promise.reject(new Error("no lock here")); } },
  });
  assert.doesNotThrow(() => byRole(rejecting.host, "start").click());
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(player.state().paused, false, "a refused lock leaves the session running");
  assert.doesNotThrow(() => byRole(rejecting.host, "pause").click());
});

test("controls: onEvent hears segment, pause and resume in the order they happened", () => {
  const booted = boot();
  const heard = [];
  mountPlayer(booted, {
    onEvent: (event) => { heard.push(event.type === "segment" ? "segment:" + event.index : event.type); },
  });
  byRole(booted.host, "start").click();
  assert.deepEqual(heard, [], "the first Start is not a resume");

  const strip = byRole(booted.host, "strip");
  strip.children[1].click();
  byRole(booted.host, "pause").click();
  byRole(booted.host, "pause").click();
  byRole(booted.host, "skip").click();
  byRole(booted.host, "back").click();

  assert.deepEqual(heard, ["segment:2", "pause", "resume", "segment:3", "segment:2"]);

  /* A listener that throws is its own problem. */
  const angry = boot();
  mountPlayer(angry, { onEvent: () => { throw new Error("listener trouble"); } });
  byRole(angry.host, "start").click();
  assert.doesNotThrow(() => byRole(angry.host, "strip").children[2].click());
  assert.doesNotThrow(() => byRole(angry.host, "pause").click());
});

test("controls: destroy takes the visibilitychange listener off", () => {
  const booted = boot();
  const { player } = mountPlayer(booted);
  assert.equal((booted.docListeners.visibilitychange || []).length, 1,
    "the player listens for the tab going away");

  byRole(booted.host, "start").click();
  player.destroy();

  assert.equal((booted.docListeners.visibilitychange || []).length, 0);
  fireVisibility(booted, true);
  assert.equal(player.state().paused, false, "nothing hears the hidden tab any more");
  assert.equal(booted.host.children.length, 0);
});
