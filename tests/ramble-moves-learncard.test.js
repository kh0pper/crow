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
  constructor(tag, doc) {
    this.tagName = String(tag || "div").toUpperCase();
    this.attrs = Object.create(null);
    this.listeners = Object.create(null);
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.textContent = "";
    this.innerHTML = "";
    this.className = "";
    /* The document this element belongs to, so focus() can move its
     * activeElement the way a browser would. */
    this.ownerDocument = doc || null;
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
  focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this; }
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
    /* The ids still running, so a test can say an interval was really stopped. */
    active: new Map(),
    cleared: [],
    now() { return this.time; },
    setInterval(fn, ms) {
      this.intervals.push({ fn, ms });
      const id = this.intervals.length;
      this.active.set(id, fn);
      return id;
    },
    clearInterval(id) { this.cleared.push(id); this.active.delete(id); },
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

/* The document the card is handed: element factory, the one activeElement a
 * browser keeps, and the document-level keydown listeners the card can add and
 * remove. */
function fakeDocument() {
  const doc = {
    activeElement: null,
    listeners: Object.create(null),
    createElement(tag) { return new FakeEl(tag, doc); },
    addEventListener(type, fn) {
      const list = this.listeners[type] || (this.listeners[type] = []);
      list.push(fn);
    },
    removeEventListener(type, fn) {
      const list = this.listeners[type] || [];
      this.listeners[type] = list.filter((one) => one !== fn);
    },
    listenerCount(type) { return (this.listeners[type] || []).length; },
    keydown(key) {
      const ev = { key, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      (this.listeners.keydown || []).slice().forEach((fn) => fn(ev));
      return ev;
    },
  };
  return doc;
}

function boot() {
  const host = new FakeEl("div");
  const clock = fakeClock();
  const doc = fakeDocument();
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

/* Whether a node is still inside the host, following parentNode upwards. */
function attachedTo(node, host) {
  let at = node;
  while (at) {
    if (at === host) return true;
    at = at.parentNode;
  }
  return false;
}

/* How long learn-card.js tweens from one step's pose into the next, read out of
 * the script itself so the test names the same span the card uses. */
const TWEEN_SECONDS = Number((CARD_SRC.match(/var TWEEN_SECONDS = ([0-9.]+);/) || [])[1]);

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

/* ---------- motion ---------- */

test("motion: the figure tweens into a step and holds that step's pose once the tween is over", () => {
  assert.ok(Number.isFinite(TWEEN_SECONDS) && TWEEN_SECONDS > 0, "the card's tween span is readable");
  const booted = boot();
  const Figure = booted.sandbox.RambleFigure;
  const realSvg = Figure.poseSvg;
  /* The decoration the card draws with, kept so the comparison uses it too. */
  const optsSeen = [];
  Figure.poseSvg = (pose, opts) => { optsSeen.push(opts); return realSvg(pose, opts); };

  mountCard(booted, SQUAT, { reducedMotion: false });

  /* Step 2 of the squat (index 1) is the one that moves from the standing key
   * position to the squat; step 1 (index 0) holds the standing pose it came from. */
  const steps = allByRole(booted.host, "step");
  steps[1].click();
  const fromPose = fromPoseOf(SQUAT, 1);
  const toPose = toPoseOf(SQUAT, 1);
  const markupFor = (pose, opts) => realSvg(Figure.clampPose(pose), opts);

  advance(booted.clock, TWEEN_SECONDS / 3);
  const midOpts = optsSeen[optsSeen.length - 1];
  const midway = figureMarkup(booted);
  assert.notEqual(midway, markupFor(fromPose, midOpts), "partway in the figure is not the pose it came from");
  assert.notEqual(midway, markupFor(toPose, midOpts), "nor the pose it is heading for");
  assert.equal(midway, realSvg(Figure.tween(fromPose, toPose, 1 / 3), midOpts),
    "it is the tween in between the two");

  /* Past the tween span, on the same step, it holds that step's own pose. */
  advance(booted.clock, TWEEN_SECONDS);
  assert.equal(steps[1].getAttribute("aria-current"), "true",
    "the tween finished inside the same step");
  const endOpts = optsSeen[optsSeen.length - 1];
  assert.equal(figureMarkup(booted), markupFor(toPose, endOpts), "the step's own pose is held");
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

/* ---------- the sheet's focus, and its Escape ---------- */

/* Open the sheet from the anatomy button with focus already on it, the way a
 * reader who tabbed to the button and pressed it arrives. */
function openFromButton(booted) {
  const see = byRole(booted.host, "anatomy");
  booted.doc.activeElement = see;
  see.click();
  return see;
}

test("sheet: opening moves focus into the sheet, to the way out it carries", () => {
  const booted = boot();
  mountCard(booted, SQUAT);
  const see = openFromButton(booted);

  const close = byRole(booted.host, "sheet-close");
  assert.ok(close, "the sheet is up with its close button");
  assert.equal(booted.doc.activeElement, close, "focus is in the sheet, on the button that leaves it");
  assert.notEqual(booted.doc.activeElement, see, "and no longer on the card behind it");
  assert.equal(attachedTo(close, booted.host), true, "the focused node really is on the sheet");
});

test("sheet: Escape closes it, and focus goes back to the button that opened it", () => {
  const booted = boot();
  mountCard(booted, SQUAT);
  const see = openFromButton(booted);
  assert.equal(booted.doc.listenerCount("keydown"), 1, "one keydown listener while the sheet is open");

  booted.doc.keydown("Escape");

  assert.equal(byRole(booted.host, "sheet"), null, "Escape closes the sheet");
  assert.equal(attachedTo(see, booted.host), true, "and leaves the card up");
  assert.equal(booted.doc.activeElement, see, "focus is handed back to the opener");
  assert.equal(booted.doc.listenerCount("keydown"), 0, "the Escape listener goes with the sheet");
});

test("sheet: the close button hands focus back too", () => {
  const booted = boot();
  mountCard(booted, SQUAT);
  const see = openFromButton(booted);

  byRole(booted.host, "sheet-close").click();

  assert.equal(byRole(booted.host, "sheet"), null, "Back closes it");
  assert.equal(booted.doc.activeElement, see, "focus is back on the anatomy button");
  assert.equal(booted.doc.listenerCount("keydown"), 0, "and no Escape listener is left on the document");
});

test("sheet: focus falls back to the anatomy button when the previous element is gone", () => {
  const booted = boot();
  mountCard(booted, SQUAT);
  /* Something that was focused once but is not on the card any more. */
  const stray = new FakeEl("button", booted.doc);
  booted.doc.activeElement = stray;
  byRole(booted.host, "anatomy").click();

  byRole(booted.host, "sheet-close").click();

  assert.equal(booted.doc.activeElement, byRole(booted.host, "anatomy"),
    "the card's own way in takes the focus back");
});

test("keys: with the sheet closed Escape is not listened for, and other keys never close it", () => {
  const booted = boot();
  mountCard(booted, SQUAT);
  assert.equal(booted.doc.listenerCount("keydown"), 0, "no document keydown listener before the sheet opens");

  const see = byRole(booted.host, "anatomy");
  booted.doc.activeElement = see;
  const away = booted.doc.keydown("Escape");
  assert.equal(byRole(booted.host, "sheet"), null, "Escape does not open anything");
  assert.equal(booted.doc.activeElement, see, "nor move focus");
  assert.equal(away.defaultPrevented, false, "the card does not swallow the key");

  openFromButton(booted);
  assert.equal(booted.doc.listenerCount("keydown"), 1);
  for (const key of ["ArrowLeft", "j", " ", "Tab"]) {
    const ev = booted.doc.keydown(key);
    assert.ok(byRole(booted.host, "sheet"), "the sheet stays open on " + JSON.stringify(key));
    assert.equal(ev.defaultPrevented, false, "the card leaves " + JSON.stringify(key) + " alone");
  }

  const escape = booted.doc.keydown("Escape");
  assert.equal(byRole(booted.host, "sheet"), null, "Escape does close it");
  assert.equal(escape.defaultPrevented, false, "and the key is not swallowed either");
});

test("destroy: a card taken down with its sheet open forgets Escape and hands no focus back", () => {
  const booted = boot();
  const card = mountCard(booted, SQUAT);
  const see = openFromButton(booted);
  assert.equal(booted.doc.listenerCount("keydown"), 1, "the open sheet listens for Escape");

  card.destroy();

  assert.equal(booted.doc.listenerCount("keydown"), 0, "the listener goes with the card");
  assert.notEqual(booted.doc.activeElement, see,
    "the card is being removed, so no focus is handed back to the button that opened it");
  assert.equal(booted.host.children.length, 0, "and the host is empty");
  assert.doesNotThrow(() => booted.doc.keydown("Escape"), "a stray Escape finds nothing to close");
  assert.equal(attachedTo(see, booted.host), false);
  assert.equal(booted.clock.active.size, 0, "the beat is off the clock too");
});

test("sheet: the Back label comes from the page's copy when it carries one", () => {
  const booted = boot();
  mountCard(booted, MOUNTAIN, { copy: { back: "Volver" } });
  byRole(booted.host, "anatomy").click();
  assert.equal(byRole(booted.host, "sheet-close").textContent, "Volver");
});

test("sheet: a tick inside the same step leaves the open sheet's nodes where they are", () => {
  const booted = boot();
  mountCard(booted, SQUAT);
  byRole(booted.host, "anatomy").click();

  const why = byRole(booted.host, "why");
  assert.ok(why, "the sheet has its own line");
  const body = why.parentNode;
  assert.ok(attachedTo(why, booted.host), "and it is on the sheet on the host");

  advance(booted.clock, 2);
  assert.equal(allByRole(booted.host, "step")[0].getAttribute("aria-current"), "true", "still the same step");
  assert.equal(why.parentNode, body, "the sheet's body was not rebuilt for a tick");
  assert.ok(attachedTo(why, booted.host), "the same node is still on the sheet");
  assert.equal(byRole(booted.host, "why"), why);

  /* On a step change it is rebuilt, as it must be. */
  advance(booted.clock, 4);
  assert.equal(allByRole(booted.host, "step")[1].getAttribute("aria-current"), "true");
  assert.notEqual(byRole(booted.host, "why"), why, "a new step's sheet is a new body");
  assert.equal(attachedTo(why, booted.host), false, "and the old line is gone with the old one");
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

/* ---------- nothing left behind ---------- */

test("destroy: the beat is off the clock and the host is empty", () => {
  const booted = boot();
  const card = mountCard(booted, MOUNTAIN);
  assert.equal(booted.clock.active.size, 1, "the card runs one beat while it is up");

  card.destroy();

  assert.equal(booted.clock.active.size, 0, "no interval is left running");
  assert.deepEqual(booted.clock.cleared, [1], "the one interval the card started is cleared");
  assert.equal(booted.host.children.length, 0, "nothing is left on the host");
  assert.equal(byRole(booted.host, "figure"), null);
  assert.equal(allByRole(booted.host, "step").length, 0);

  /* A tick that arrives late, after destroy, still changes nothing. */
  advance(booted.clock, 5);
  assert.equal(booted.host.children.length, 0);
});

/* ---------- the words the card can say ---------- */

test("copy: no vocabulary name and no why line promises a cure or a treatment", () => {
  const banned = /\b(cure|cures|treat|treats|treating|treatment|heal|heals|healing|fix your)\b/i;
  /* The guard itself: it has to catch the wording it exists for. */
  assert.equal(banned.test("This movement cures back pain."), true);
  assert.equal(banned.test("It treats the knee."), true);
  assert.equal(banned.test("A gentle way of treating the knee."), true);
  assert.equal(banned.test("A week of healing."), true);
  assert.equal(banned.test("A gentle way to fix your posture."), true);
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