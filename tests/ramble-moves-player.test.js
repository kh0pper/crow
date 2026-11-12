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
    steps: [{ text: "Small circles", cue: "Small circles", say: "Small circles" }],
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

/* Every element carrying this data-role, in tree order (first one wins). */
function byRole(host, role) {
  const queue = host.children.slice();
  while (queue.length > 0) {
    const node = queue.shift();
    if (node.getAttribute("data-role") === role) return node;
    if (node.children.length > 0) queue.push(...node.children);
  }
  return null;
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
  const sandbox = {
    console,
    document: {
      hidden: false,
      createElement: (tag) => new FakeEl(tag),
      querySelectorAll: () => [],
      addEventListener() {},
    },
    matchMedia: () => ({ matches: options.prefersReducedMotion === true }),
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  new vm.Script(SESSION_SRC, { filename: "session.cjs" }).runInContext(sandbox);
  new vm.Script(FIGURE_SRC, { filename: "figure.cjs" }).runInContext(sandbox);
  new vm.Script(PLAYER_SRC, { filename: "player.js" }).runInContext(sandbox);
  return { host, clock, sandbox };
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
    layout: "kiosk", started: true, segmentIndex: 0, paused: false, ended: false,
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
