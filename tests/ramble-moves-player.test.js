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
    finished: false,
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
  assert.equal(pause.hasAttribute("aria-pressed"), false,
    "a button whose label changes carries no pressed state");
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
  assert.equal(byRole(booted.host, "pause").hasAttribute("aria-pressed"), false);
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
  assert.equal(player.state().paused, true, "nothing left hears the hidden tab");
  assert.equal(booted.host.children.length, 0);
});

/* ---------- finish here, the resume record and the end screen ---------- */

/* Fixtures with an exact planned time: a ten minute walk is one stretch of
 * moving time, a ten minute routine is its warm-up, main block and cool-down,
 * and "routine-rounds" carries no cool-down so an added round is main time
 * alone. */
const FINISH_LIB = [
  ...LIB,
  {
    id: "walk-10",
    kind: "walk",
    title: "Loop walk",
    minutes: 10,
    steps: [{ text: "Walk the loop", cue: "Walk the loop", say: "Walk the loop" }],
  },
  {
    id: "walk-14",
    kind: "walk",
    title: "Longer loop",
    minutes: 14,
    steps: [{ text: "Walk the longer loop", cue: "Longer loop", say: "Longer loop" }],
  },
  {
    id: "routine-10",
    kind: "routine",
    title: "Ten minute routine",
    minutes: 10,
    rounds: 1,
    steps: [{ text: "warm-up, main, cool-down", cue: "warm-up", say: "warm-up" }],
    blocks: {
      warmup: [{ id: "pose-fold", seconds: 120 }],
      main: [{ id: "pose-reach", seconds: 450 }],
      cooldown: [{ id: "pose-fold", seconds: 30 }],
    },
  },
  {
    id: "routine-rounds",
    kind: "routine",
    title: "Rounds routine",
    minutes: 10,
    rounds: 1,
    steps: [{ text: "warm-up, main", cue: "warm-up", say: "warm-up" }],
    blocks: {
      warmup: [{ id: "pose-fold", seconds: 120 }],
      main: [{ id: "pose-reach", seconds: 450 }],
    },
  },
  {
    id: "routine-rest",
    kind: "routine",
    title: "Restful routine",
    minutes: 10,
    rounds: 1,
    steps: [{ text: "warm-up, main, cool-down", cue: "warm-up", say: "warm-up" }],
    blocks: {
      warmup: [{ id: "pose-fold", seconds: 120 }],
      main: [{ id: "ex-arms", seconds: 200, restSeconds: 60 }],
      cooldown: [{ id: "pose-reach", seconds: 30 }],
    },
  },
];

function finishTitleOf(id) {
  const entry = FINISH_LIB.find((one) => one.id === id);
  return entry ? entry.title : "";
}

function mountOn(booted, chain, over) {
  const options = {
    chain,
    library: FINISH_LIB,
    copy: PAGE_COPY,
    guidance: "full",
    clock: booted.clock,
    reducedMotion: true,
    ...(over || {}),
  };
  const player = booted.sandbox.RamblePlayer.mount(booted.host, options);
  return { player, options };
}

/* localStorage, as the page would hand it in. */
function fakeStorage(seed) {
  const map = new Map(Object.entries(seed || {}));
  return {
    map,
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(key, String(value)); },
    removeItem(key) { map.delete(key); },
  };
}

/* The local day a moment falls on, named the way the player names it. */
function dayOf(ms) {
  const when = new Date(ms);
  const pad = (value) => (value < 10 ? "0" + value : String(value));
  return when.getFullYear() + "-" + pad(when.getMonth() + 1) + "-" + pad(when.getDate());
}

/* The error a page answers a refused report with: a word and a status. */
function statusError(status) {
  const err = new Error("refused: " + status);
  err.status = status;
  return err;
}

/* The planned seconds of each chunk, straight off the compiled timeline. */
function plannedOfChunks(booted, chain) {
  const timeline = booted.sandbox.RambleSession.compileSession(chain, FINISH_LIB, { guidance: "full" });
  return timeline.chunks.map((chunk) => chunk.plannedSeconds);
}

/* A recording stand-in for the page's posting: the session module's own
 * half-time rule answers Done. */
function postRecorder(booted, chain) {
  const planned = plannedOfChunks(booted, chain);
  const posted = [];
  return {
    posted,
    post(payload) {
      posted.push(payload);
      const done = booted.sandbox.RambleSession.isChunkDone(planned[payload.chunkIndex], payload.activeSeconds);
      return Promise.resolve({ paid: true, total: 1, done, capped: false, accepted: true });
    },
  };
}

/* The player answers a post on its own promises: one macrotask turn is enough
 * for the whole chain to run. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("finish: five active minutes of a ten minute chunk, then Finish here, shows the card done", async () => {
  const booted = boot();
  const chain = [{ chunkId: "routine-10" }];
  const recorder = postRecorder(booted, chain);
  const { player } = mountOn(booted, chain, { post: recorder.post });

  assert.equal(plannedOfChunks(booted, chain)[0], 600, "the fixture chunk plans ten minutes");
  assert.equal(byRole(booted.host, "finish"), null, "no Finish here before Start");

  byRole(booted.host, "start").click();
  advance(booted.clock, 302);

  const finish = byRole(booted.host, "finish");
  assert.ok(finish, "a running session offers Finish here");
  assert.equal(finish.tagName, "BUTTON");
  assert.equal(finish.getAttribute("type"), "button");
  assert.equal(finish.textContent, COPY["player.finishHere"]);
  assert.equal(player.state().finished, false);

  finish.click();
  assert.equal(player.state().finished, true, "Finish here is the end of the visit");
  await settle();

  assert.equal(recorder.posted.length, 1, "a chunk with active time is posted once");
  assert.deepEqual(JSON.parse(JSON.stringify(recorder.posted[0])),
    { chunkIndex: 0, entryId: "routine-10", activeSeconds: 300 });

  const lines = allByRole(booted.host, "chunk-result");
  assert.equal(lines.length, 1);
  assert.equal(lines[0].getAttribute("data-chunk"), "0");
  assert.equal(lines[0].textContent, COPY["today.card.isDone"]);

  assert.equal(byRole(booted.host, "note"), null, "a done chunk needs no note");
  assert.equal(byRole(booted.host, "transport"), null, "the transport goes with the finish");
  assert.equal(byRole(booted.host, "pause"), null);
  assert.equal(byRole(booted.host, "finish"), null);
});

test("finish: 4:59 leaves the chunk undone, saves a resume record and a remount picks up there", async () => {
  const booted = boot();
  const chain = [{ chunkId: "routine-10" }];
  const storage = fakeStorage();
  const recorder = postRecorder(booted, chain);
  mountOn(booted, chain, { post: recorder.post, storage });

  byRole(booted.host, "start").click();
  advance(booted.clock, 301);
  byRole(booted.host, "finish").click();
  await settle();

  assert.equal(recorder.posted.length, 1);
  assert.equal(recorder.posted[0].activeSeconds, 299, "one second short of half the chunk");

  const lines = allByRole(booted.host, "chunk-result");
  assert.equal(lines.length, 1);
  assert.equal(lines[0].textContent, COPY["today.card.resume"], "the chunk is not done yet");
  const note = byRole(booted.host, "note");
  assert.ok(note, "nothing is done, so the note is on screen");
  assert.equal(note.textContent, COPY["player.end.notYet"]);

  const saved = JSON.parse(storage.getItem("ramble.player.resume.routine-10"));
  assert.deepEqual(saved, {
    day: dayOf(301000),
    segmentIndex: 2,
    activeSeconds: [299],
    cardKeys: [null],
  });

  /* The same storage, a fresh player: the line before Start, and the first
   * Start back at the stored segment. */
  const again = boot();
  const againRecorder = postRecorder(again, chain);
  const remount = mountOn(again, chain, { post: againRecorder.post, storage });
  const line = byRole(again.host, "resume-line");
  assert.ok(line, "the resume line is offered before Start");
  assert.equal(line.textContent, COPY["today.card.resume"]);

  byRole(again.host, "start").click();
  assert.equal(byRole(again.host, "resume-line"), null, "the line goes with Start");
  assert.equal(remount.player.state().segmentIndex, 2, "the first Start seeks to the stored segment");
  assert.equal(byRole(again.host, "name").textContent, finishTitleOf("pose-reach"),
    "the main hold the record was saved in");

  advance(again.clock, 5);
  byRole(again.host, "finish").click();
  await settle();
  assert.equal(againRecorder.posted[0].activeSeconds, 304, "the restored seconds count too");
  assert.equal(allByRole(again.host, "chunk-result")[0].textContent, COPY["today.card.isDone"]);
});

test("finish: rests, pauses and skipped steps add no active time", async () => {
  const booted = boot();
  const chain = [{ chunkId: "routine-rest" }];
  const recorder = postRecorder(booted, chain);
  mountOn(booted, chain, { post: recorder.post });

  byRole(booted.host, "start").click();
  advance(booted.clock, 122);
  byRole(booted.host, "pause").click();
  advance(booted.clock, 90);
  byRole(booted.host, "pause").click();
  advance(booted.clock, 20);
  byRole(booted.host, "skip").click();
  advance(booted.clock, 59);
  byRole(booted.host, "skip-rest").click();
  advance(booted.clock, 2);
  advance(booted.clock, 10);

  byRole(booted.host, "finish").click();
  await settle();

  assert.equal(recorder.posted.length, 1);
  assert.equal(recorder.posted[0].activeSeconds, 150,
    "120 of the warm-up, 20 of the reps step and 10 of the close: nothing else");
});

test("finish: the end screen shows three choices, none chosen and nothing ticking", async () => {
  const booted = boot();
  const chain = [{ chunkId: "routine-10" }];
  const recorder = postRecorder(booted, chain);
  const heard = [];
  const { player } = mountOn(booted, chain, {
    post: recorder.post,
    offers: { nextCard: { slot: "morning", chunkId: "walk-10" }, areaChunk: { chunkId: "walk-14" } },
    onEvent: (event) => {
      if (event.type === "ended" || event.type === "left") heard.push(event.type);
    },
  });

  const realFocus = FakeEl.prototype.focus;
  let focused = 0;
  FakeEl.prototype.focus = function () { focused += 1; };
  try {
    byRole(booted.host, "start").click();
    advance(booted.clock, 604);
    await settle();

    const end = byRole(booted.host, "end");
    assert.ok(end, "the session ends on an end screen");
    assert.equal(byRole(booted.host, "end-title").textContent, COPY["player.end.title"]);

    const summaries = allByRole(booted.host, "summary");
    assert.equal(summaries.length, 1, "one line per chunk with active time");
    assert.equal(summaries[0].textContent,
      fillCopy(COPY["player.end.summary"], { minutes: 10, name: finishTitleOf("routine-10") }));

    const choices = end.children
      .map((child) => child.getAttribute("data-role"))
      .filter((role) => role === "one-more-round" || role === "add-ten" || role === "thats-it");
    assert.deepEqual(choices, ["one-more-round", "add-ten", "thats-it"]);

    assert.equal(byRole(booted.host, "one-more-round").textContent, COPY["player.end.oneMoreRound"]);
    assert.equal(byRole(booted.host, "add-ten").textContent, COPY["player.end.addTen"]);
    assert.equal(byRole(booted.host, "thats-it").textContent, COPY["player.end.thatsIt"]);

    for (const role of ["one-more-round", "add-ten", "thats-it"]) {
      const button = byRole(booted.host, role);
      assert.equal(button.getAttribute("aria-pressed"), null, "no choice is pressed");
      assert.equal(button.hasAttribute("data-selected"), false, "no choice is selected");
    }
    assert.equal(focused, 0, "no choice takes the focus");
    assert.equal(booted.clock.intervals.length, 1, "only the session's own beat: no countdown");

    assert.equal(allByRole(booted.host, "chunk-result")[0].textContent, COPY["today.card.isDone"]);
    assert.equal(player.state().ended, true);
    assert.equal(player.state().finished, false, "the end screen waits for the person");
    assert.deepEqual(heard, ["ended"]);
  } finally {
    FakeEl.prototype.focus = realFocus;
  }
});

test("finish: One more round adds main-block time only", async () => {
  const booted = boot();
  const chain = [{ chunkId: "routine-rounds" }];
  const recorder = postRecorder(booted, chain);
  const { player } = mountOn(booted, chain, { post: recorder.post });

  byRole(booted.host, "start").click();
  advance(booted.clock, 572);
  await settle();

  const before = booted.sandbox.RambleSession.compileSession(chain, FINISH_LIB, { guidance: "full" });
  const stripBefore = byRole(booted.host, "strip").children.length;

  const oneMore = byRole(booted.host, "one-more-round");
  assert.ok(oneMore, "a routine with rounds left offers one more");
  assert.equal(oneMore.textContent, COPY["player.end.oneMoreRound"]);
  oneMore.click();

  assert.equal(byRole(booted.host, "end"), null, "the end screen goes when the session goes on");
  assert.equal(player.state().segmentIndex, before.segments.length, "the clock picks up after what was played");
  assert.equal(byRole(booted.host, "name").textContent, finishTitleOf("pose-reach"),
    "the main hold is what comes next");

  const strip = byRole(booted.host, "strip");
  assert.equal(strip.children.length, stripBefore + 1, "one more work step, and no more than that");
  assert.equal(strip.children[strip.children.length - 1].textContent, finishTitleOf("pose-reach"));

  /* The addition itself: main-block time, and never another warm-up. */
  const extended = booted.sandbox.RambleSession.extend(
    before,
    { segmentIndex: before.segments.length - 1 },
    FINISH_LIB,
    { addRound: true },
  );
  const added = extended.segments.slice(before.segments.length);
  assert.ok(added.length > 0, "the round really does add segments");
  assert.equal(added.some((one) => one.block === "warmup"), false, "no warm-up is added");
  assert.equal(added.every((one) => one.block === "main"), true, "the new segments are main-block ones");
  const addedWork = added.filter((one) => one.type === "hold" || one.type === "reps" || one.type === "timed");
  assert.equal(addedWork.length, 1);
  assert.equal(addedWork[0].seconds, 450, "the new round is the main block's own time");
});

test("finish: Add another 10 offers the next card, the area chunk and the chunk again, in that order", async () => {
  const booted = boot();
  const chain = [{ chunkId: "routine-10" }];
  const recorder = postRecorder(booted, chain);
  const offers = { nextCard: { slot: "morning", chunkId: "walk-10" }, areaChunk: { chunkId: "walk-14" } };
  mountOn(booted, chain, { post: recorder.post, offers });

  byRole(booted.host, "start").click();
  advance(booted.clock, 604);
  await settle();

  assert.equal(byRole(booted.host, "add-options"), null, "the options wait for the click");
  byRole(booted.host, "add-ten").click();

  const panel = byRole(booted.host, "add-options");
  assert.ok(panel);
  const options = panel.children;
  assert.deepEqual(options.map((one) => one.getAttribute("data-role")),
    ["add-option", "add-option", "add-option"]);
  assert.deepEqual(options.map((one) => one.textContent), [
    fillCopy(COPY["player.end.addTen.nextCard"], { slot: COPY["settings.slot.morning"] }),
    finishTitleOf("walk-14"),
    finishTitleOf("routine-10"),
  ]);

  byRole(booted.host, "add-ten").click();
  assert.equal(allByRole(booted.host, "add-options").length, 1, "a second click adds no second panel");

  const stripBefore = byRole(booted.host, "strip").children.length;
  options[0].click();
  assert.equal(byRole(booted.host, "end"), null, "the chosen addition sends the session on");
  const strip = byRole(booted.host, "strip");
  assert.equal(strip.children.length, stripBefore + 1, "the next card's own step joins the strip");
  assert.equal(strip.children[strip.children.length - 1].textContent, finishTitleOf("walk-10"));
});

test("finish: a chain stopped at 12 of 20 minutes counts the first chunk done and the second not", async () => {
  const booted = boot();
  const chain = [{ chunkId: "walk-10" }, { chunkId: "walk-10" }];
  const recorder = postRecorder(booted, chain);
  const { player } = mountOn(booted, chain, { post: recorder.post });

  byRole(booted.host, "start").click();
  advance(booted.clock, 720);
  byRole(booted.host, "finish").click();
  await settle();

  assert.equal(recorder.posted.length, 2, "both chunks have active time");
  assert.equal(recorder.posted[0].activeSeconds, 600);
  assert.ok(recorder.posted[1].activeSeconds > 0);
  assert.ok(recorder.posted[1].activeSeconds < 300, "the second chunk is not half done");

  const lines = allByRole(booted.host, "chunk-result");
  assert.deepEqual(lines.map((one) => one.getAttribute("data-chunk")), ["0", "1"]);
  assert.equal(lines[0].textContent, COPY["today.card.isDone"]);
  assert.equal(lines[1].textContent, COPY["today.card.resume"]);
  assert.equal(player.state().finished, true);
});

test("finish: an hour in, nothing more is offered and the cap note shows", async () => {
  const booted = boot();
  const chain = [0, 1, 2, 3, 4, 5].map(() => ({ chunkId: "walk-10" }));
  const recorder = postRecorder(booted, chain);
  const offers = { nextCard: { slot: "evening", chunkId: "walk-10" }, areaChunk: { chunkId: "walk-14" } };
  mountOn(booted, chain, { post: recorder.post, offers });

  byRole(booted.host, "start").click();
  advance(booted.clock, 3625);
  await settle();

  assert.ok(byRole(booted.host, "end"), "the session reached its end");
  assert.equal(byRole(booted.host, "one-more-round"), null, "no round to add");
  assert.equal(byRole(booted.host, "add-ten"), null, "no chunk to add");
  const capNote = byRole(booted.host, "cap-note");
  assert.ok(capNote, "the cap has its own word");
  assert.equal(capNote.textContent, COPY["player.sessionCap"]);
  assert.ok(byRole(booted.host, "thats-it"), "the way out is still there");
  assert.equal(recorder.posted.length, 6);
});

test("finish: the water and rest note shows after thirty active minutes, and not before", async () => {
  const short = boot();
  const shortChain = [{ chunkId: "walk-10" }, { chunkId: "walk-10" }];
  const shortRecorder = postRecorder(short, shortChain);
  mountOn(short, shortChain, { post: shortRecorder.post });
  byRole(short.host, "start").click();
  advance(short.clock, 1205);
  await settle();
  assert.ok(byRole(short.host, "end"));
  assert.equal(byRole(short.host, "water-note"), null, "twenty active minutes is not thirty");

  const long = boot();
  const longChain = [{ chunkId: "walk-10" }, { chunkId: "walk-10" }, { chunkId: "walk-10" }];
  const longRecorder = postRecorder(long, longChain);
  mountOn(long, longChain, { post: longRecorder.post });
  byRole(long.host, "start").click();
  advance(long.clock, 1810);
  await settle();
  const water = byRole(long.host, "water-note");
  assert.ok(water, "thirty active minutes brings the note");
  assert.equal(water.textContent, COPY["player.waterAndRest"]);
});

test("finish: That's it hides the choices, keeps the result lines and drops the resume record", async () => {
  const booted = boot();
  const chain = [{ chunkId: "routine-10" }];
  const storage = fakeStorage({
    "ramble.player.resume.routine-10": JSON.stringify({
      day: dayOf(0), segmentIndex: 0, activeSeconds: [0], cardKeys: [null]
    }),
  });
  const recorder = postRecorder(booted, chain);
  const heard = [];
  const { player } = mountOn(booted, chain, {
    post: recorder.post,
    storage,
    onEvent: (event) => { if (event.type === "left") heard.push(event.type); },
  });

  byRole(booted.host, "start").click();
  advance(booted.clock, 604);
  await settle();
  assert.notEqual(storage.getItem("ramble.player.resume.routine-10"), null,
    "the record is still in storage at the end screen");

  byRole(booted.host, "thats-it").click();

  assert.equal(byRole(booted.host, "end"), null, "the end screen and its choices go");
  assert.equal(byRole(booted.host, "one-more-round"), null);
  assert.equal(allByRole(booted.host, "chunk-result").length, 1, "the result lines stay");
  assert.equal(storage.getItem("ramble.player.resume.routine-10"), null, "nothing is left to pick up");
  assert.deepEqual(heard, ["left"]);
  assert.equal(player.state().finished, true);
});

test("finish: a chunk the clock never reached is not posted", async () => {
  const booted = boot();
  const chain = [{ chunkId: "walk-10" }, { chunkId: "walk-10" }];
  const recorder = postRecorder(booted, chain);
  mountOn(booted, chain, { post: recorder.post });

  byRole(booted.host, "start").click();
  advance(booted.clock, 100);
  byRole(booted.host, "finish").click();
  await settle();

  assert.equal(recorder.posted.length, 1, "a chunk with no active time is never posted");
  assert.deepEqual(JSON.parse(JSON.stringify(recorder.posted[0])),
    { chunkIndex: 0, entryId: "walk-10", activeSeconds: 100 });
  assert.equal(allByRole(booted.host, "chunk-result").length, 1);
});

test("finish: a page with no posting, or a post that rejects, decides Done locally", async () => {
  const chain = [{ chunkId: "routine-10" }];

  const bare = boot();
  mountOn(bare, chain);
  byRole(bare.host, "start").click();
  advance(bare.clock, 302);
  byRole(bare.host, "finish").click();
  await settle();
  assert.equal(allByRole(bare.host, "chunk-result")[0].textContent, COPY["today.card.isDone"],
    "half the chunk is done even with nobody to ask");

  const angry = boot();
  mountOn(angry, chain, { post: () => Promise.reject(new Error("no posting today")) });
  byRole(angry.host, "start").click();
  advance(angry.clock, 301);
  byRole(angry.host, "finish").click();
  await settle();
  assert.equal(allByRole(angry.host, "chunk-result")[0].textContent, COPY["today.card.resume"]);
  assert.ok(byRole(angry.host, "note"));

  /* A storage that throws is a page with none. */
  const stuck = {
    getItem() { throw new Error("no storage here"); },
    setItem() { throw new Error("no storage here"); },
    removeItem() { throw new Error("no storage here"); },
  };
  const throwing = boot();
  assert.doesNotThrow(() => mountOn(throwing, chain, { storage: stuck }));
  assert.equal(byRole(throwing.host, "resume-line"), null);
  byRole(throwing.host, "start").click();
  advance(throwing.clock, 302);
  assert.doesNotThrow(() => byRole(throwing.host, "finish").click());
  await settle();
  assert.equal(allByRole(throwing.host, "chunk-result").length, 1);
});

test("finish: a page whose post answers at once is answered at once", () => {
  const booted = boot();
  const chain = [{ chunkId: "walk-10" }];
  const posted = [];
  const heard = [];
  mountOn(booted, chain, {
    post: (payload) => {
      posted.push(payload);
      return { paid: true, total: 1, done: true, capped: false, accepted: true };
    },
    onEvent: (event) => { if (event.type === "left") heard.push(event.type); },
  });

  byRole(booted.host, "start").click();
  advance(booted.clock, 100);
  byRole(booted.host, "finish").click();

  assert.equal(posted.length, 1);
  const lines = allByRole(booted.host, "chunk-result");
  assert.equal(lines.length, 1);
  assert.equal(lines[0].textContent, COPY["today.card.isDone"],
    "the page's own answer decides Done, not the half-time rule");
  assert.deepEqual(heard, ["left"]);
});

/* ---------- posting a chunk against its own card ---------- */

const QUEUE_KEY = "ramble.player.queue";

/* What the player left in storage for a later visit to retry. */
function queueOf(storage) {
  const raw = storage.getItem(QUEUE_KEY);
  if (raw === null || raw === "") return [];
  return JSON.parse(raw);
}

/* Plain copies of what a recorder collected, so a deep equal reads it. */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("posting: the first Start sends exactly one start call with the slot and the chain", async () => {
  const booted = boot();
  const chain = [{ chunkId: "walk-10" }, { chunkId: "walk-10" }];
  const starts = [];
  const posted = [];
  mountOn(booted, chain, {
    cardSlot: "day",
    start: (body) => {
      starts.push(body);
      return Promise.resolve({ cardKey: "card-for-chunk-" + starts.length });
    },
    post: (payload) => { posted.push(payload); return Promise.resolve({ done: false }); },
  });

  assert.equal(starts.length, 0, "nothing is asked for before Start");
  byRole(booted.host, "start").click();
  await settle();

  assert.equal(starts.length, 1, "the first Start asks for one card, for the first chunk only");
  assert.deepEqual(plain(starts[0]), { cardKey: "day", entryId: "walk-10", chain: chain });

  advance(booted.clock, 5);
  advance(booted.clock, 5);
  await settle();
  assert.equal(starts.length, 1, "a running chunk is asked for its card once");
  assert.deepEqual(posted, [], "nothing leaves the chunk yet, so nothing is posted");
});

test("posting: a chunk boundary posts the chunk the clock left, with that chunk's own seconds", async () => {
  const booted = boot();
  const chain = [{ chunkId: "walk-10" }, { chunkId: "walk-10" }];
  const starts = [];
  const posted = [];
  mountOn(booted, chain, {
    cardSlot: "day",
    start: (body) => {
      starts.push(body);
      return Promise.resolve({ cardKey: body.cardKey === "day" ? "2026-01-01:day" : "2026-01-01:x:walk-10:1" });
    },
    post: (payload) => { posted.push(payload); return Promise.resolve({ done: true }); },
  });

  byRole(booted.host, "start").click();
  await settle();
  advance(booted.clock, 700);
  await settle();

  assert.equal(posted.length, 1, "one report for the chunk the clock left");
  assert.deepEqual(plain(posted[0]), {
    cardKey: "2026-01-01:day",
    chunkIndex: 0,
    entryId: "walk-10",
    activeSeconds: 600,
  });
  assert.equal(starts.length, 1, "the chunk now running has no card yet");

  advance(booted.clock, 100);
  await settle();
  assert.equal(posted.length, 1, "a step inside the next chunk reports nothing");
  assert.equal(posted[0].activeSeconds, 600, "the next chunk's seconds are never added to it");
});

test("posting: Finish here at 12 of 20 minutes posts each chunk on its own card", async () => {
  const booted = boot();
  const chain = [{ chunkId: "walk-10" }, { chunkId: "walk-10" }];
  const starts = [];
  const posted = [];
  mountOn(booted, chain, {
    cardSlot: "day",
    start: (body) => {
      starts.push(body);
      return Promise.resolve({ cardKey: body.cardKey === "day" ? "2026-01-01:day" : "2026-01-01:x:walk-10:1" });
    },
    post: (payload) => {
      posted.push(payload);
      return Promise.resolve({ progress: { done: payload.chunkIndex === 0 } });
    },
  });

  byRole(booted.host, "start").click();
  await settle();
  /* Twelve active minutes of a twenty minute chain: ten in the first chunk,
   * two in the second (the five second break is nobody's active time). */
  advance(booted.clock, 725);
  byRole(booted.host, "finish").click();
  await settle();

  const forChunk = (index) => posted.filter((one) => one.chunkIndex === index);
  assert.equal(forChunk(0).length, 1, "the finished chunk is reported once");
  assert.equal(forChunk(0)[0].activeSeconds, 600);
  assert.equal(forChunk(0)[0].cardKey, "2026-01-01:day");
  assert.equal(forChunk(1).length, 1);
  assert.equal(forChunk(1)[0].activeSeconds, 120, "only the second chunk's own two minutes");
  assert.equal(forChunk(1)[0].cardKey, "2026-01-01:x:walk-10:1");

  assert.equal(starts.length, 2, "the second chunk is started once, when its report needs a card");
  assert.equal(starts[1].cardKey, "extra");
  assert.equal(starts[1].entryId, "walk-10");

  const lines = allByRole(booted.host, "chunk-result");
  assert.equal(lines[0].textContent, COPY["today.card.isDone"]);
  assert.equal(lines[1].textContent, COPY["today.card.resume"], "the page's progress answer decides Done");
});

test("posting: a rejected post waits in storage and is retried on a later tick", async () => {
  const booted = boot();
  const chain = [{ chunkId: "walk-10" }];
  const storage = fakeStorage();
  const posted = [];
  let calls = 0;
  mountOn(booted, chain, {
    storage,
    cardSlot: "day",
    start: () => Promise.resolve({ cardKey: "2026-01-01:day" }),
    post: (payload) => {
      posted.push(payload);
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("offline"));
      return Promise.resolve({ done: true });
    },
  });

  byRole(booted.host, "start").click();
  await settle();
  advance(booted.clock, 120);
  byRole(booted.host, "finish").click();
  await settle();

  assert.equal(posted.length, 1);
  assert.deepEqual(queueOf(storage), [{
    cardKey: "2026-01-01:day",
    chunkIndex: 0,
    entryId: "walk-10",
    activeSeconds: 120,
    visit: "0",
  }], "the report that could not be made waits in storage");

  advance(booted.clock, 12);
  await settle();

  assert.equal(posted.length, 2, "the beat retried it");
  assert.equal(posted[1].activeSeconds, 120);
  assert.deepEqual(queueOf(storage), [], "an item leaves the queue once its post resolves");
});

test("posting: a queued post survives a remount and is retried by the next visit", async () => {
  const chain = [{ chunkId: "walk-10" }];
  const storage = fakeStorage();
  const first = boot();
  const firstPosted = [];
  mountOn(first, chain, {
    storage,
    cardSlot: "day",
    start: () => Promise.resolve({ cardKey: "2026-01-01:day" }),
    post: (payload) => {
      firstPosted.push(payload);
      return Promise.reject(new Error("offline"));
    },
  });

  byRole(first.host, "start").click();
  await settle();
  advance(first.clock, 90);
  byRole(first.host, "finish").click();
  await settle();

  assert.equal(firstPosted.length, 1);
  assert.deepEqual(queueOf(storage), [{
    cardKey: "2026-01-01:day",
    chunkIndex: 0,
    entryId: "walk-10",
    activeSeconds: 90,
    visit: "0",
  }]);

  const second = boot();
  const secondPosted = [];
  mountOn(second, chain, {
    storage,
    cardSlot: "day",
    start: () => Promise.resolve({ cardKey: "2026-01-01:day" }),
    post: (payload) => { secondPosted.push(payload); return Promise.resolve({ done: true }); },
  });
  await settle();

  assert.equal(secondPosted.length, 1, "the new visit retries what the last one could not report");
  assert.deepEqual(plain(secondPosted[0]), {
    cardKey: "2026-01-01:day",
    chunkIndex: 0,
    entryId: "walk-10",
    activeSeconds: 90,
  });
  assert.deepEqual(queueOf(storage), [], "and the item leaves the queue");
});

test("posting: a retry never carries fewer seconds than the acknowledged report", async () => {
  const booted = boot();
  const chain = [{ chunkId: "walk-10" }, { chunkId: "walk-10" }];
  const storage = fakeStorage({
    [QUEUE_KEY]: JSON.stringify([
      { cardKey: "2026-01-01:day", chunkIndex: 1, entryId: "walk-10", activeSeconds: 50 },
    ]),
  });
  const posted = [];
  let calls = 0;
  mountOn(booted, chain, {
    storage,
    cardSlot: "day",
    start: () => Promise.resolve({ cardKey: "2026-01-01:day" }),
    post: (payload) => {
      posted.push(payload);
      calls += 1;
      if (calls <= 2) return Promise.reject(new Error("offline"));
      return Promise.resolve({ done: true });
    },
  });

  await settle();
  assert.equal(posted.length, 1, "the mount retried the item and could not post it");
  assert.equal(posted[0].activeSeconds, 50);

  byRole(booted.host, "start").click();
  await settle();
  advance(booted.clock, 605);
  await settle();

  assert.equal(posted.length, 3, "the retry, then the first chunk's own report");
  assert.equal(posted[2].chunkIndex, 0);
  assert.equal(posted[2].activeSeconds, 600, "the card has now been acknowledged at ten minutes");

  byRole(booted.host, "finish").click();
  await settle();

  const forCard = posted.filter((one) => one.cardKey === "2026-01-01:day");
  for (let i = 1; i < forCard.length; i += 1) {
    assert.ok(forCard[i].activeSeconds >= forCard[i - 1].activeSeconds,
      "a report about a card never carries fewer seconds than one before it");
  }
  assert.equal(posted.filter((one) => one.activeSeconds === 50).length, 2,
    "the waiting item is never sent again with fewer seconds than the card acknowledged");
  assert.deepEqual(queueOf(storage), [], "the acknowledged count already covers it");
});

test("posting: a rejected start is not an error and the next post asks again", async () => {
  const booted = boot();
  const chain = [{ chunkId: "walk-10" }];
  const storage = fakeStorage();
  const starts = [];
  const posted = [];
  mountOn(booted, chain, {
    storage,
    cardSlot: "day",
    start: (body) => {
      starts.push(body);
      if (starts.length === 1) return Promise.reject(new Error("no card today"));
      return Promise.resolve({ cardKey: "2026-01-01:day" });
    },
    post: (payload) => { posted.push(payload); return Promise.resolve({ done: true }); },
  });

  assert.doesNotThrow(() => byRole(booted.host, "start").click());
  await settle();
  assert.equal(starts.length, 1);
  assert.equal(posted.length, 0);

  advance(booted.clock, 200);
  assert.doesNotThrow(() => byRole(booted.host, "finish").click());
  await settle();

  assert.equal(starts.length, 2, "the next report asks for the card again");
  assert.equal(starts[1].cardKey, "day");
  assert.equal(posted.length, 1);
  assert.equal(posted[0].cardKey, "2026-01-01:day");
  assert.equal(posted[0].activeSeconds, 200);
  assert.equal(allByRole(booted.host, "chunk-result")[0].textContent, COPY["today.card.isDone"],
    "the page's answer still decides Done");
});

test("posting: destroy reports the time the beat counted and no post carried", async () => {
  const booted = boot();
  const chain = [{ chunkId: "walk-10" }];
  const posted = [];
  const { player } = mountOn(booted, chain, {
    cardSlot: "day",
    start: () => Promise.resolve({ cardKey: "2026-01-01:day" }),
    post: (payload) => { posted.push(payload); return Promise.resolve({ done: false }); },
  });

  byRole(booted.host, "start").click();
  await settle();
  advance(booted.clock, 100);
  assert.deepEqual(posted, [], "a step inside the chunk says nothing yet");

  player.destroy();
  await settle();

  assert.equal(posted.length, 1);
  assert.deepEqual(plain(posted[0]), {
    cardKey: "2026-01-01:day",
    chunkIndex: 0,
    entryId: "walk-10",
    activeSeconds: 100,
  });
});

/* ---------- the fixes the review asked for ---------- */

test("fix: a queued item with no card asks for a start and posts with the key it answers", async () => {
  const booted = boot();
  const chain = [{ chunkId: "walk-10" }];
  const storage = fakeStorage();
  const starts = [];
  const posted = [];
  let aCardIsOffered = false;
  mountOn(booted, chain, {
    storage,
    cardSlot: "day",
    start: (body) => {
      starts.push(plain(body));
      if (!aCardIsOffered) return Promise.resolve({});
      return Promise.resolve({ cardKey: "card-after-retry" });
    },
    post: (payload) => { posted.push(plain(payload)); return Promise.resolve({ done: false }); },
  });

  byRole(booted.host, "start").click();
  await settle();
  advance(booted.clock, 100);
  byRole(booted.host, "finish").click();
  await settle();

  assert.equal(posted.length, 0, "a chunk with no card of its own is not reported");
  const waiting = queueOf(storage);
  assert.equal(waiting.length, 1, "the report waits in storage");
  assert.equal(waiting[0].cardKey, undefined, "it has no card to be sent against yet");
  assert.equal(waiting[0].activeSeconds, 100);

  /* The start still answers no card: the item stays where it was. */
  const startsBefore = starts.length;
  advance(booted.clock, 12);
  await settle();
  assert.equal(starts.length > startsBefore, true, "the retry asks the page for a card again");
  assert.equal(queueOf(storage).length, 1, "a start that still answers nothing leaves the item queued");
  assert.equal(posted.length, 0);

  aCardIsOffered = true;
  advance(booted.clock, 12);
  await settle();

  assert.equal(posted.length, 1, "the item goes out once a card answers");
  assert.equal(posted[0].cardKey, "card-after-retry", "it is sent against the card the start answered");
  assert.equal(posted[0].activeSeconds, 100);
  assert.deepEqual(queueOf(storage), [], "and it leaves the queue");
});

test("fix: a stored item is sent only with its own card key and leaves once the page has it", async () => {
  const booted = boot();
  const chain = [{ chunkId: "walk-10" }];
  const storage = fakeStorage({
    [QUEUE_KEY]: JSON.stringify([
      { cardKey: "card-from-another-visit", chunkIndex: 0, entryId: "walk-10", activeSeconds: 120, visit: "other" },
    ]),
  });
  const posted = [];
  mountOn(booted, chain, {
    storage,
    cardSlot: "day",
    start: () => Promise.resolve({ cardKey: "2026-01-01:day" }),
    post: (payload) => { posted.push(plain(payload)); return Promise.resolve({ done: false }); },
  });

  await settle();
  assert.equal(posted.length, 1);
  assert.equal(posted[0].cardKey, "card-from-another-visit", "the item keeps the card it was stored for");
  assert.equal(posted[0].activeSeconds, 120);
  assert.deepEqual(queueOf(storage), [], "an acknowledged item leaves the queue");

  byRole(booted.host, "start").click();
  await settle();
  advance(booted.clock, 130);
  byRole(booted.host, "finish").click();
  await settle();

  const own = posted.filter((one) => one.cardKey === "2026-01-01:day");
  assert.equal(own.length, 1, "this visit reports against its own card");
  assert.equal(own[0].activeSeconds, 130, "the other visit's count is no floor for this card");
  assert.equal(posted.some((one) => one.activeSeconds === 120 && one.cardKey === "2026-01-01:day"), false,
    "the other visit's card is never this chunk's card");
});

test("fix: a resumed visit reuses the record's card keys and posts the total under them", async () => {
  const booted = boot();
  const chain = [{ chunkId: "walk-10" }];
  const storage = fakeStorage({
    "ramble.player.resume.walk-10": JSON.stringify({
      day: dayOf(0),
      segmentIndex: 0,
      activeSeconds: [240],
      cardKeys: ["card-from-earlier-today"],
    }),
  });
  const starts = [];
  const posted = [];
  const { player } = mountOn(booted, chain, {
    storage,
    cardSlot: "day",
    start: (body) => { starts.push(plain(body)); return Promise.resolve({ cardKey: "a-fresh-card" }); },
    post: (payload) => { posted.push(plain(payload)); return Promise.resolve({ done: false }); },
  });

  assert.ok(byRole(booted.host, "resume-line"), "today's record is offered before Start");
  byRole(booted.host, "start").click();
  await settle();
  assert.deepEqual(starts, [], "the stored card is used, never asked for again");

  advance(booted.clock, 60);
  byRole(booted.host, "finish").click();
  await settle();

  assert.equal(posted.length, 1);
  assert.equal(posted[0].cardKey, "card-from-earlier-today", "the report goes against the stored card");
  assert.equal(posted[0].activeSeconds, 300, "the stored seconds and this visit's own, counted once");
  assert.equal(player.state().finished, true);
});

test("fix: a resume record from another day is ignored and taken out of storage", async () => {
  const booted = boot();
  const chain = [{ chunkId: "walk-10" }];
  const key = "ramble.player.resume.walk-10";
  const storage = fakeStorage({
    [key]: JSON.stringify({
      day: "1999-01-01",
      segmentIndex: 0,
      activeSeconds: [240],
      cardKeys: ["stale-card"],
    }),
  });
  const posted = [];
  const { player } = mountOn(booted, chain, {
    storage,
    post: (payload) => { posted.push(plain(payload)); return Promise.resolve({ done: false }); },
  });

  assert.equal(byRole(booted.host, "resume-line"), null, "no line for a record of another day");
  assert.equal(storage.getItem(key), null, "the stale record is taken out of storage");

  byRole(booted.host, "start").click();
  assert.equal(player.state().segmentIndex, 0, "the visit starts at the top");
  advance(booted.clock, 60);
  byRole(booted.host, "finish").click();
  await settle();

  assert.equal(posted.length, 1);
  assert.equal(posted[0].activeSeconds, 60, "yesterday's seconds are not counted again");
});

test("fix: the wake lock goes back when the clock ends", async () => {
  const booted = boot();
  const events = [];
  let asked = 0;
  const { player } = mountOn(booted, [{ chunkId: "walk-10" }], {
    wakeLock: {
      request() {
        asked += 1;
        return { release() { events.push("released-" + asked); } };
      },
    },
  });

  byRole(booted.host, "start").click();
  assert.equal(asked, 1);
  assert.deepEqual(events, [], "a running session holds the lock");

  advance(booted.clock, 605);
  await settle();

  assert.equal(player.state().ended, true);
  assert.deepEqual(events, ["released-1"], "the end of the clock hands the lock back");
  assert.equal(byRole(booted.host, "pause"), null, "and the transport with it");
});

test("fix: destroy stops the clock before it reports what the beat counted", async () => {
  const booted = boot();
  const posted = [];
  const { player } = mountOn(booted, [{ chunkId: "walk-10" }], {
    start: () => Promise.resolve({ cardKey: "2026-01-01:day" }),
    post: (payload) => { posted.push(plain(payload)); return Promise.resolve({ done: false }); },
  });

  byRole(booted.host, "start").click();
  await settle();
  advance(booted.clock, 100);
  assert.equal(player.state().paused, false, "the session is running");

  player.destroy();
  await settle();

  assert.equal(player.state().paused, true, "the clock is stopped where it stood");
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0], {
    cardKey: "2026-01-01:day",
    chunkIndex: 0,
    entryId: "walk-10",
    activeSeconds: 100,
  });
});

test("fix: the pause button carries the page's word and no pressed state", () => {
  const booted = boot();
  mountOn(booted, [{ chunkId: "walk-10" }]);

  byRole(booted.host, "start").click();
  const running = byRole(booted.host, "pause");
  assert.equal(running.textContent, COPY["player.pause"]);
  assert.equal(running.hasAttribute("aria-pressed"), false, "the label says what the button does");

  running.click();
  const paused = byRole(booted.host, "pause");
  assert.equal(paused.textContent, COPY["player.keepGoing"], "a paused session offers Keep going");
  assert.equal(paused.hasAttribute("aria-pressed"), false, "and carries no pressed state");

  paused.click();
  const going = byRole(booted.host, "pause");
  assert.equal(going.textContent, COPY["player.pause"]);
  assert.equal(going.hasAttribute("aria-pressed"), false);
});

test("fix: stored seconds are clamped to a chunk's worth and a non-number is dropped", async () => {
  const booted = boot();
  const chain = [{ chunkId: "walk-10" }, { chunkId: "walk-10" }];
  const storage = fakeStorage({
    "ramble.player.resume.walk-10|walk-10": JSON.stringify({
      day: dayOf(0),
      segmentIndex: 0,
      activeSeconds: [-30, 999999],
      cardKeys: [null, null],
    }),
    [QUEUE_KEY]: JSON.stringify([
      { cardKey: "card-below-zero", chunkIndex: 0, entryId: "walk-10", activeSeconds: -5, visit: "old" },
      { cardKey: "card-far-too-long", chunkIndex: 0, entryId: "walk-10", activeSeconds: 999999, visit: "old" },
      { cardKey: "card-not-a-number", chunkIndex: 0, entryId: "walk-10", activeSeconds: "plenty", visit: "old" },
    ]),
  });
  const posted = [];
  mountOn(booted, chain, {
    storage,
    post: (payload) => { posted.push(plain(payload)); return Promise.resolve({ done: false }); },
  });

  await settle();
  const sent = posted.map((one) => [one.cardKey, one.activeSeconds]);
  assert.deepEqual(sent, [["card-below-zero", 0], ["card-far-too-long", 21600]],
    "a stored count is brought inside 0..21600, and one that is no number is dropped");
  assert.deepEqual(queueOf(storage), [], "what was sent leaves the queue");

  posted.length = 0;
  byRole(booted.host, "start").click();
  advance(booted.clock, 60);
  byRole(booted.host, "finish").click();
  await settle();

  const byChunk = posted.map((one) => [one.chunkIndex, one.activeSeconds]);
  assert.deepEqual(byChunk, [[0, 60], [1, 21600]],
    "the record's own counts are clamped the same way");

  /* A record holding something that is no number at all is no record. */
  const odd = boot();
  const oddStorage = fakeStorage({
    "ramble.player.resume.walk-10": JSON.stringify({
      day: dayOf(0), segmentIndex: 0, activeSeconds: ["plenty"], cardKeys: [null]
    }),
  });
  mountOn(odd, [{ chunkId: "walk-10" }], { storage: oddStorage });
  assert.equal(byRole(odd.host, "resume-line"), null);
});

test("fix: a queue item the page refuses outright stops waiting, a timeout and a throttle do not", async () => {
  const booted = boot();
  const chain = [{ chunkId: "walk-10" }];
  const storage = fakeStorage({
    [QUEUE_KEY]: JSON.stringify([
      { cardKey: "card-refused", chunkIndex: 0, entryId: "walk-10", activeSeconds: 60, visit: "old" },
      { cardKey: "card-timed-out", chunkIndex: 0, entryId: "walk-10", activeSeconds: 60, visit: "old" },
      { cardKey: "card-throttled", chunkIndex: 0, entryId: "walk-10", activeSeconds: 60, visit: "old" },
    ]),
  });
  const posted = [];
  const status = { "card-refused": 422, "card-timed-out": 408, "card-throttled": 429 };
  mountOn(booted, chain, {
    storage,
    post: (payload) => {
      posted.push(payload.cardKey);
      return Promise.reject(statusError(status[payload.cardKey]));
    },
  });

  await settle();

  assert.deepEqual(posted.slice().sort(), ["card-refused", "card-throttled", "card-timed-out"],
    "every waiting item was tried once");
  assert.deepEqual(queueOf(storage).map((one) => one.cardKey), ["card-timed-out", "card-throttled"],
    "a refused report is dropped, a timeout and a throttle are kept");
});

test("fix: a queue item with no card left by an earlier visit is dropped, and mount asks for no card", async () => {
  const booted = boot();
  /* A later moment than the visit that stored the item, so the two visits are
   * named differently. */
  booted.clock.time = 5000;
  const chain = [{ chunkId: "walk-10" }];
  const storage = fakeStorage({
    [QUEUE_KEY]: JSON.stringify([
      { chunkIndex: 0, entryId: "walk-10", activeSeconds: 120, visit: "0" },
    ]),
  });
  const starts = [];
  const posted = [];
  mountOn(booted, chain, {
    storage,
    cardSlot: "day",
    start: (body) => {
      starts.push(plain(body));
      return Promise.resolve({ cardKey: "card-of-this-visit" });
    },
    post: (payload) => { posted.push(plain(payload)); return Promise.resolve({ done: false }); },
  });

  await settle();

  assert.deepEqual(starts, [], "the mount-time retry asks for no card at all");
  assert.deepEqual(posted, [], "the other visit's item is not posted");
  assert.deepEqual(queueOf(storage), [], "its card was never opened, so it leaves the queue");

  byRole(booted.host, "start").click();
  await settle();
  advance(booted.clock, 5);
  await settle();

  assert.equal(starts.length, 1, "this visit's own Start is the first thing that asks for a card");
  assert.deepEqual(posted, [], "a dropped item is never posted later either");
  assert.deepEqual(queueOf(storage), [], "and it stays out of the queue");
});

test("fix: a queued post on its way for a card is no promise for a fresh report about it", async () => {
  const booted = boot();
  const chain = [{ chunkId: "walk-10" }];
  const storage = fakeStorage({
    [QUEUE_KEY]: JSON.stringify([
      { cardKey: "card-shared", chunkIndex: 0, entryId: "walk-10", activeSeconds: 700, visit: "older" },
    ]),
  });
  const posted = [];
  const starts = [];
  let queuedTries = 0;
  let releaseQueued = null;
  let releaseOwed = null;
  const { player } = mountOn(booted, chain, {
    storage,
    start: (body) => {
      starts.push(plain(body));
      return Promise.resolve({ cardKey: "card-shared" });
    },
    post: (payload) => {
      posted.push(plain(payload));
      if (payload.activeSeconds === 700) {
        queuedTries += 1;
        if (queuedTries <= 2) return Promise.reject(new Error("offline"));
        return new Promise((resolve) => { releaseQueued = () => resolve({ done: false }); });
      }
      return new Promise((resolve) => { releaseOwed = () => resolve({ done: true }); });
    },
  });

  await settle();
  assert.equal(posted.length, 1, "the stored item is tried and cannot be made yet");
  assert.deepEqual(posted[0], {
    cardKey: "card-shared", chunkIndex: 0, entryId: "walk-10", activeSeconds: 700,
  });

  byRole(booted.host, "start").click();
  await settle();
  assert.equal(starts.length, 1, "this visit's Start asks its chunk for a card once");

  /* The walk ends at ten minutes: the chunk's own count for its card is on its
   * way and still unanswered. */
  advance(booted.clock, 600);
  await settle();
  assert.equal(posted.filter((one) => one.activeSeconds === 600).length, 1,
    "the chunk's own ten minutes are on their way");
  assert.equal(typeof releaseOwed, "function");

  /* Ten seconds on, the beat tries the waiting item again, so it goes out while
   * the ten minute report is still unanswered. */
  advance(booted.clock, 15);
  await settle();
  assert.equal(queuedTries, 3, "the waiting item was tried once more");
  assert.equal(typeof releaseQueued, "function", "and it is on its way again");

  /* A fresh report about the same card now: the item on its way is no promise
   * for the player to wait on, and the visit ends without an error. */
  assert.doesNotThrow(() => player.destroy());
  await settle();

  assert.equal(posted.filter((one) => one.activeSeconds === 600).length, 1,
    "the card carries one ten minute count, said once");
  assert.equal(posted.filter((one) => one.activeSeconds === 700).length, 3,
    "an item already on its way is not sent again while it is out");
  assert.equal(queueOf(storage).length, 1, "the item waits while its post is out");

  releaseOwed();
  await settle();
  releaseQueued();
  await settle();
  assert.deepEqual(queueOf(storage), [], "and it leaves the queue once the page has it");
});

test("fix: a wake lock that lands while another is held hands the older one back", async () => {
  const booted = boot();
  const pending = [];
  const released = [];
  const { player } = mountOn(booted, [{ chunkId: "walk-10" }], {
    wakeLock: {
      request() {
        return new Promise((resolve) => { pending.push(resolve); });
      },
    },
  });

  byRole(booted.host, "start").click();
  assert.equal(pending.length, 1, "the Start asks for a lock");
  byRole(booted.host, "pause").click();
  byRole(booted.host, "pause").click();
  assert.equal(pending.length, 2, "Keep going asks for one again");

  pending[0]({ release() { released.push("older"); } });
  await settle();
  assert.deepEqual(released, [], "the first handle is kept while the session runs");

  pending[1]({ release() { released.push("newer"); } });
  await settle();
  assert.deepEqual(released, ["older"], "the older handle goes back when the newer one lands");

  player.destroy();
  assert.deepEqual(released, ["older", "newer"], "and the newer one goes back with the visit");
});

