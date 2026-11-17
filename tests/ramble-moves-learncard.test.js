/**
 * Ramble Moves task P16-C -- the Learn card ("B + layers").
 *
 * learn-card.js, session.cjs and figure.cjs are loaded into one vm context with
 * a small fake DOM, the way the panel loads them with plain script tags. The
 * vocabulary is the shipped anatomy/vocab.json and the entries are the shipped
 * library JSON (body-squat, yoga-mountain, yoga-forward-fold), so the card is
 * driven by the same data the panel serves.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const MOVES_DIR = join(ROOT, "bundles", "ramble", "server", "moves");
const LIBRARY_DIR = join(MOVES_DIR, "library");

const SESSION_SRC = readFileSync(join(MOVES_DIR, "session.cjs"), "utf8");
const FIGURE_SRC = readFileSync(join(MOVES_DIR, "figure.cjs"), "utf8");
const CARD_SRC = readFileSync(join(ROOT, "bundles", "ramble", "panel", "static", "learn-card.js"), "utf8");
const VOCAB_FILE = JSON.parse(readFileSync(join(MOVES_DIR, "anatomy", "vocab.json"), "utf8"));
const VOCAB = VOCAB_FILE.vocab;

function entryOf(id) {
  return JSON.parse(readFileSync(join(LIBRARY_DIR, id + ".json"), "utf8"));
}
const SQUAT = entryOf("body-squat");
const MOUNTAIN = entryOf("yoga-mountain");
const FOLD = entryOf("yoga-forward-fold");

/** Every shipped entry that carries anatomy, for the copy guard below. */
const SHIPPED = readdirSync(LIBRARY_DIR)
  .filter((name) => name.endsWith(".json"))
  .map((name) => JSON.parse(readFileSync(join(LIBRARY_DIR, name), "utf8")));

/* The figure engine's own colours, so the assertions name what the drawing
 * says rather than a number copied by hand. */
const BAND_WORKING = "#2f6fdb";
const BAND_LENGTHENING = "#c8423b";

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
    this.className = "";
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
  closest() { return null; }
  click() {
    (this.listeners.click || []).slice().forEach((fn) => fn({ target: this }));
  }
}

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

function byRole(host, role) {
  const all = allByRole(host, role);
  return all.length > 0 ? all[0] : null;
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

const BROKEN_STORAGE = {
  getItem() { throw new Error("no storage here"); },
  setItem() { throw new Error("no storage here"); },
  removeItem() { throw new Error("no storage here"); },
};

/* ---------- loading the three scripts into one context ---------- */

function boot() {
  const host = new FakeEl("div");
  const clock = fakeClock();
  const doc = { createElement: (tag) => new FakeEl(tag) };
  const sandbox = { console, document: doc };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  new vm.Script(SESSION_SRC, { filename: "session.cjs" }).runInContext(sandbox);
  new vm.Script(FIGURE_SRC, { filename: "figure.cjs" }).runInContext(sandbox);
  new vm.Script(CARD_SRC, { filename: "learn-card.js" }).runInContext(sandbox);
  return { host, clock, sandbox, doc };
}

function mountCard(booted, entry, over) {
  const options = {
    entry,
    vocab: VOCAB,
    library: [entry],
    storage: null,
    clock: booted.clock,
    copy: {},
    reducedMotion: true,
    ...(over || {}),
  };
  return booted.sandbox.RambleLearnCard.mount(booted.host, options);
}

function figureMarkup(booted) {
  const node = byRole(booted.host, "figure");
  return node ? node.innerHTML : "";
}

/* Move the injected clock forward and run the card's own interval beat. */
function advance(clock, seconds) {
  clock.time += Math.round(seconds * 1000);
  const latest = clock.intervals[clock.intervals.length - 1];
  assert.ok(latest, "the card must have started its interval");
  latest.fn();
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

/* The pose one step of an exercise holds, and the one it moves from. */
function toPoseOf(entry, index) {
  if (entry.kind === "pose") return entry.pose;
  const at = Number.isInteger(entry.steps[index].at) ? entry.steps[index].at : 0;
  return entry.poses[at] || entry.poses[0];
}
function fromPoseOf(entry, index) {
  const before = (index + entry.steps.length - 1) % entry.steps.length;
  return toPoseOf(entry, before);
}

function vocabRecord(id) {
  return VOCAB.find((one) => one.id === id);
}

/* ---------- the default: colour, and the four chips ---------- */

test("default: the colour band shows, the joints and the names do not, and the four chips say what they are", () => {
  const booted = boot();
  mountCard(booted, MOUNTAIN);

  const markup = figureMarkup(booted);
  assert.ok(markup.includes('stroke="' + BAND_WORKING + '"'), "the working muscles are drawn as a blue band");
  assert.equal(markup.includes('data-layer="skeleton"'), false, "no joint pins until Skeleton is on");
  assert.equal(markup.includes('data-layer="labels"'), false, "no names until Labels is on");
  assert.equal(markup.includes('data-layer="nerves"'), false, "no nerves until Nerves is on");

  const chips = allByRole(booted.host, "chip");
  assert.deepEqual(chips.map((one) => one.textContent), ["Skeleton", "Muscles", "Nerves", "Labels"]);
  for (const chip of chips) assert.equal(chip.tagName, "BUTTON", "a chip is a button");
  assert.deepEqual(chips.map((one) => one.getAttribute("aria-pressed")), ["false", "true", "false", "false"]);

  const see = byRole(booted.host, "anatomy");
  assert.ok(see, "the way to the words is on the card");
  assert.equal(see.textContent, "See the anatomy");
});

test("chips: Skeleton adds the joint pins, and the choice is read back on the next mount", () => {
  const storage = fakeStorage();
  const first = boot();
  const card = mountCard(first, MOUNTAIN, { storage });
  assert.equal(figureMarkup(first).includes('data-layer="skeleton"'), false);

  allByRole(first.host, "chip")[0].click();

  assert.equal(card.chips().skeleton, true);
  assert.ok(figureMarkup(first).includes('data-layer="skeleton"'), "the pins are drawn once Skeleton is on");
  assert.equal(allByRole(first.host, "chip")[0].getAttribute("aria-pressed"), "true");
  const saved = JSON.parse(storage.getItem("ramble.moves.learncard.chips"));
  assert.equal(saved.skeleton, true, "the choice is kept");
  assert.equal(saved.muscles, true, "and the rest with it");

  const again = boot();
  const second = mountCard(again, MOUNTAIN, { storage });
  assert.equal(second.chips().skeleton, true, "a new mount reads the chips back");
  assert.ok(figureMarkup(again).includes('data-layer="skeleton"'));
});

test("chips: a storage that throws still mounts, uses the defaults and takes a click", () => {
  const booted = boot();
  const card = mountCard(booted, MOUNTAIN, { storage: BROKEN_STORAGE });
  assert.ok(card, "a broken storage is no reason to draw nothing");
  assert.deepEqual(plain(card.chips()), { skeleton: false, muscles: true, nerves: false, labels: false });
  assert.doesNotThrow(() => allByRole(booted.host, "chip")[3].click());
  assert.equal(card.chips().labels, true);
  assert.ok(figureMarkup(booted).includes('data-layer="labels"'), "the names are drawn");
});

/* ---------- the steps ---------- */

test("steps: tapping a step moves the figure, the highlight and the lit anatomy together", () => {
  const booted = boot();
  const Figure = booted.sandbox.RambleFigure;
  const realSvg = Figure.poseSvg;
  const drawn = [];
  Figure.poseSvg = (pose, opts) => {
    drawn.push(plain(pose));
    return realSvg(pose, opts);
  };

  const card = mountCard(booted, SQUAT);
  assert.ok(card, "an exercise with anatomy is drawn");
  const steps = allByRole(booted.host, "step");
  assert.equal(steps.length, SQUAT.steps.length, "one button per entry step");
  assert.deepEqual(steps.map((one) => one.textContent), SQUAT.steps.map((one) => one.text));
  assert.equal(steps[0].getAttribute("aria-current"), "true", "the first step is the current one");

  /* Step 2's own key position, as the engine's tween reaches it. */
  steps[2].click();

  const expected = plain(Figure.tween(fromPoseOf(SQUAT, 2), toPoseOf(SQUAT, 2), 1));
  assert.deepEqual(plain(Figure.clampPose(drawn[drawn.length - 1])), expected,
    "the figure holds the pose that step names");
  assert.equal(steps[2].getAttribute("aria-current"), "true", "and the step reads as current");
  assert.equal(steps[0].hasAttribute("aria-current"), false, "the first step no longer does");

  /* The record is lit on the steps whose `at` names it, and on no other. */
  const litExpected = SQUAT.steps.map((step) => step.at === SQUAT.anatomy[0].at);
  for (let index = 0; index < steps.length; index += 1) {
    steps[index].click();
    const markup = figureMarkup(booted);
    assert.equal(markup.includes('stroke="' + BAND_WORKING + '"'), litExpected[index],
      "the colour band follows the record, on step " + index);
    assert.equal(steps[index].getAttribute("aria-current"), "true");
  }
});

test("steps: the clock running past a step moves on, and the last step loops to the first", () => {
  const booted = boot();
  mountCard(booted, SQUAT);
  const steps = allByRole(booted.host, "step");
  assert.equal(steps.length, 4);

  advance(booted.clock, 5);
  assert.equal(steps[1].getAttribute("aria-current"), "true", "the next step is current");
  assert.equal(steps[0].hasAttribute("aria-current"), false);

  advance(booted.clock, 5);
  assert.equal(steps[2].getAttribute("aria-current"), "true");

  advance(booted.clock, 5);
  assert.equal(steps[3].getAttribute("aria-current"), "true");

  advance(booted.clock, 5);
  assert.equal(steps[0].getAttribute("aria-current"), "true", "the last step is followed by the first");
  assert.equal(steps[3].hasAttribute("aria-current"), false);
});

/* ---------- lengthening, and structures the side view cannot draw ---------- */

test("bands: a lengthening part is dashed as well as red", () => {
  const booted = boot();
  mountCard(booted, FOLD);
  const markup = figureMarkup(booted);
  assert.ok(FOLD.anatomy[0].lengthening.length > 0, "the fixture entry lengthens something");
  assert.ok(markup.includes('stroke="' + BAND_LENGTHENING + '"'), "a red band is drawn");
  assert.ok(markup.includes('stroke-dasharray="5 4"'), "and it is dashed, so colour is not the only signal");
});

test("bands: a structure the side view cannot draw is listed on the sheet and never drawn", () => {
  const booted = boot();
  const syntheticVocab = [{
    id: "deep-fixture",
    layer: "muscle",
    name: "Deep fixture part",
    anatomical: "Musculus fixture profundus",
    segments: ["torso"],
    sideView: false,
  }];
  const entry = {
    id: "fixture-side-only",
    kind: "pose",
    title: "Fixture pose",
    pose: MOUNTAIN.pose,
    steps: [{ text: "Hold it", at: 0 }],
    anatomy: [{
      at: 0,
      working: ["deep-fixture"],
      lengthening: [],
      main: "deep-fixture",
      bones: [],
      nerves: [],
      arrows: [],
      why: "A fixture line about the part.",
    }],
  };
  const card = mountCard(booted, entry, { vocab: syntheticVocab, library: [entry] });
  assert.ok(card);

  const markup = figureMarkup(booted);
  assert.equal(markup.includes('data-layer="muscles"'), false, "no band is drawn for it");
  assert.equal(markup.includes(BAND_WORKING), false);
  assert.equal(markup.includes('data-layer="labels"'), false, "and no name beside the figure by default");

  byRole(booted.host, "anatomy").click();
  const names = allByRole(booted.host, "structure-name").map((one) => one.textContent);
  assert.deepEqual(names, ["Deep fixture part"], "it is still listed in words");
  const anatomical = allByRole(booted.host, "structure-anatomical").map((one) => one.textContent);
  assert.deepEqual(anatomical, ["Musculus fixture profundus"]);
});

/* ---------- the sheet ---------- */

test("sheet: the why line, the sections, the common name before the anatomical name, and the current step", () => {
  const booted = boot();
  mountCard(booted, SQUAT);
  const record = SQUAT.anatomy[0];

  byRole(booted.host, "anatomy").click();

  const sheet = byRole(booted.host, "sheet");
  assert.ok(sheet, "the sheet opens");
  assert.equal(sheet.getAttribute("role"), "dialog");
  assert.equal(byRole(booted.host, "why").textContent, record.why, "the entry's own why line");

  const headings = allByRole(booted.host, "section-title").map((one) => one.textContent);
  assert.deepEqual(headings, ["Muscles", "Skeleton"], "the record's own layers, named with the chips' words");

  const names = allByRole(booted.host, "structure-name").map((one) => one.textContent);
  const anatomical = allByRole(booted.host, "structure-anatomical").map((one) => one.textContent);
  const thigh = vocabRecord("quadriceps");
  assert.equal(names[0], thigh.name, "the main part comes first");
  assert.equal(anatomical[0], thigh.anatomical, "with its common name before its anatomical one");

  const rows = allByRole(booted.host, "structure");
  assert.equal(rows[0].children.length >= 2, true);
  assert.equal(rows[0].children[0].getAttribute("data-role"), "structure-name");
  assert.equal(rows[0].children[1].getAttribute("data-role"), "structure-anatomical");

  const close = byRole(booted.host, "sheet-close");
  assert.equal(close.textContent, "Back", "the way out says Back");

  /* The sheet follows the step: the record is the entry's, lit or not. */
  allByRole(booted.host, "step")[3].click();
  assert.ok(byRole(booted.host, "sheet"), "the sheet is still up");
  assert.equal(byRole(booted.host, "why").textContent, record.why, "and still shows the same record");
  assert.deepEqual(allByRole(booted.host, "structure-name").map((one) => one.textContent), names);

  close.click();
  assert.equal(byRole(booted.host, "sheet"), null, "Back closes it");
});

test("sheet: the Back label comes from the page's copy when it carries one", () => {
  const booted = boot();
  mountCard(booted, MOUNTAIN, { copy: { back: "Volver" } });
  byRole(booted.host, "anatomy").click();
  assert.equal(byRole(booted.host, "sheet-close").textContent, "Volver");
});

/* ---------- nothing to draw ---------- */

test("mount: an entry of another kind, or one with no anatomy, draws nothing", () => {
  const booted = boot();
  const flow = { ...MOUNTAIN, id: "fixture-flow", kind: "flow", steps: ["Stand"] };
  assert.equal(mountCard(booted, flow), null);
  assert.equal(booted.host.children.length, 0, "nothing was put on the host");

  const bare = { ...MOUNTAIN, id: "fixture-bare" };
  delete bare.anatomy;
  assert.equal(mountCard(booted, bare), null);
  assert.equal(booted.host.children.length, 0);

  const empty = { ...MOUNTAIN, id: "fixture-empty", anatomy: [] };
  assert.equal(mountCard(booted, empty), null);
  assert.equal(booted.host.children.length, 0);
});

/* ---------- the words the card can say ---------- */

test("copy: no vocabulary name and no why line promises a cure or a treatment", () => {
  const banned = /\b(cure|cures|treat|treats|treatment|heal|heals|fix your)\b/i;
  for (const record of VOCAB) {
    assert.equal(banned.test(record.name), false, "vocabulary name: " + record.id);
    assert.equal(banned.test(record.anatomical), false, "anatomical name: " + record.id);
  }
  for (const entry of SHIPPED) {
    const anatomy = Array.isArray(entry.anatomy) ? entry.anatomy : [];
    for (const record of anatomy) {
      if (typeof record.why !== "string") continue;
      assert.equal(banned.test(record.why), false, "why line of " + entry.id);
    }
  }
});

test("the client script is a classic script, newline-terminated, with no template literals", () => {
  assert.equal(CARD_SRC.includes("`"), false, "learn-card.js carries no backtick");
  assert.equal(CARD_SRC.endsWith("\n"), true, "learn-card.js ends with a newline");
  assert.equal(/\b(import|export)\s/.test(CARD_SRC), false, "learn-card.js is not an ES module");
});