/**
 * Moves design P10 Task 10.3 — Today's cards.
 *
 * static/today.js draws the day's cards into #rb-today-view: one card per slot,
 * the day's Now card open and the rest shut, a streak block above them and, in
 * each card, Start -- plus Done on a walk -- and Swap. The words come from the
 * approved copy table through the hooks moves.js exposes; this file runs the
 * script in a vm against a mini DOM and a stub of those hooks built from the
 * real table, so a missing key can be seen to say nothing at all.
 *
 * The routes behind the two actions and the moves client's own hooks are
 * covered by tests/ramble-moves-panel.test.js.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const SRC = readFileSync(resolve(ROOT, "bundles/ramble/panel/static/today.js"), "utf8");
const COPY = JSON.parse(readFileSync(resolve(ROOT, "bundles/ramble/server/moves/player-copy.en.json"), "utf8"));
const MOVES_SRC = readFileSync(resolve(ROOT, "bundles/ramble/panel/static/moves.js"), "utf8");

/* The moves client's own runtime strings live in its STR table, not in the copy
 * JSON (a paused day's two lines are among them), and today.js reads them
 * through the api.text hook. Taken out of the shipped table so the assertions
 * below hold the shipped words, not a second copy of them. */
const MOVES_EN = MOVES_SRC.slice(MOVES_SRC.indexOf("    en: {"), MOVES_SRC.indexOf("    es: {"));

function movesText(key) {
  const hit = new RegExp("\\b" + key + ":\\s*\"([^\"]*)\"").exec(MOVES_EN);
  return hit ? JSON.parse("\"" + hit[1] + "\"") : "";
}

/* ------------------------------------------------------------- the copy table */

/** The table's own line, its {placeholders} filled the way moves.js fills them. */
function fill(table, key, values) {
  const line = typeof table[key] === "string" ? table[key] : "";
  if (line === "") return "";
  return line.replace(/\{([a-z]+)\}/g, (whole, name) => (
    values && Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : whole
  ));
}

function expected(key, values) {
  return fill(COPY, key, values);
}

/* --------------------------------------------------------------- the mini DOM */

class MiniEl {
  constructor(tag) {
    this.tagName = String(tag || "div").toUpperCase();
    this.attrs = Object.create(null);
    this.children = [];
    this.parentNode = null;
    this.listeners = Object.create(null);
    this.style = {};
    this.className = "";
    this.disabled = false;
    this.type = "";
    this.value = "";
    this.checked = false;
    this.name = "";
    this._text = "";
  }

  get firstChild() { return this.children.length > 0 ? this.children[0] : null; }

  get textContent() {
    let out = this._text;
    for (const kid of this.children) out += kid.textContent;
    return out;
  }

  set textContent(value) {
    for (const kid of this.children) kid.parentNode = null;
    this.children = [];
    this._text = value === null || value === undefined ? "" : String(value);
  }

  addEventListener(type, fn) {
    (this.listeners[type] || (this.listeners[type] = [])).push(fn);
  }

  removeEventListener(type, fn) {
    const list = this.listeners[type];
    if (!list) return;
    this.listeners[type] = list.filter((f) => f !== fn);
  }

  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; }
  removeAttribute(name) { delete this.attrs[name]; }
  hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name); }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  insertBefore(child, ref) {
    const at = this.children.indexOf(ref);
    child.parentNode = this;
    if (at === -1) this.children.push(child);
    else this.children.splice(at, 0, child);
    return child;
  }

  removeChild(child) {
    this.children = this.children.filter((c) => c !== child);
    child.parentNode = null;
    return child;
  }

  replaceChild(next, old) {
    const at = this.children.indexOf(old);
    if (at === -1) throw new Error("replaceChild: not a child of this element");
    old.parentNode = null;
    next.parentNode = this;
    this.children[at] = next;
    return old;
  }

  click() {
    for (const fn of (this.listeners.click || []).slice()) fn({ type: "click", target: this });
  }

  /** Fire one listener type, the way a browser would on a user's own change. */
  fire(type) {
    for (const fn of (this.listeners[type] || []).slice()) fn({ type, target: this });
  }

  change() { this.fire("change"); }

  /** Every descendant (not this element itself) the predicate takes. */
  findAll(predicate) {
    const out = [];
    const walk = (parent) => {
      for (const kid of parent.children) {
        if (predicate(kid)) out.push(kid);
        walk(kid);
      }
    };
    walk(this);
    return out;
  }
}

function hasClass(node, name) {
  return String(node.className || "").split(/\s+/).indexOf(name) !== -1;
}

function cardsIn(host) {
  return host.findAll((node) => hasClass(node, "rb-slot-card"));
}

function cardFor(host, slot) {
  return cardsIn(host).find((node) => node.getAttribute("data-slot") === slot) || null;
}

function bodyOf(card) {
  return card.findAll((node) => hasClass(node, "rb-slot-body"))[0] || null;
}

function buttonNamed(node, label) {
  return node.findAll((kid) => kid.tagName === "BUTTON" && kid.textContent === label)[0] || null;
}

function buttonsNamed(node, label) {
  return node.findAll((kid) => kid.tagName === "BUTTON" && kid.textContent === label);
}

/* ------------------------------------------------------------------- fixtures */

const WALK = { id: "walk-10", kind: "walk", title: "A ten minute walk", minutes: 10 };
const CHAIR = { id: "chair-sit", kind: "exercise", title: "Chair sit", minutes: 10 };
const BEND = { id: "side-bend", kind: "pose", title: "Side bend", minutes: 10 };

const DAY = {
  day: "2026-10-30",
  need: 3,
  nowSlot: "morning",
  off: false,
  complete: false,
  outdoor: null,
  bird: null,
  health: { energy: 40, max: 100 },
  hearts: 2,
  steps: { day: "2026-10-30", goal: 6000, steps: 2400, goal_met: false, walked: false },
  streak: { days: 4, doneToday: 1, need: 3 },
  week: { total: 2 },
  setup: { needed: false },
  slots: [
    {
      slot: "morning", entry: WALK, area: "cardio", plannedArea: "cardio", reasons: [],
      why: "A good way to break up the day.", swap: 0, done: false, standIn: false, empty: false,
    },
    {
      slot: "midday", entry: CHAIR, area: "strength", plannedArea: "strength", reasons: [],
      why: "", swap: 1, done: false, standIn: false, empty: false,
    },
    {
      slot: "evening", entry: BEND, area: "mobility", plannedArea: "mobility", reasons: [],
      why: "", swap: 0, done: false, standIn: false, empty: false,
    },
  ],
};

function deep(value) {
  return JSON.parse(JSON.stringify(value));
}

/* ------------------------------------------------------------------ the boot */

async function flush() {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
}

function boot(opts) {
  const options = opts || {};
  const byId = new Map();
  const host = options.noHost ? null : new MiniEl("div");
  if (host) host.id = "rb-today-view";
  const get = (id) => {
    if (!byId.has(id)) byId.set(id, new MiniEl("div"));
    return byId.get(id);
  };

  const calls = [];
  const spy = { started: [], finished: 0 };
  /* The day and the prefs the stubs answer with can change under the script: a
   * test finishes the setup and then reads the day again. */
  const state = { running: options.running === true, day: options.day || DAY };
  const prefsState = { prefs: options.prefs || { cards: 3, windows: [] } };
  const responses = Object.assign({}, options.responses || {});
  /* The words the page carries; a test may hand over a table without them. */
  let table = options.table || COPY;
  /* The day reads a test answers by hand, for the out-of-order case. */
  const pendingDay = [];

  /* The sheet is in the panel markup, hidden, before today.js ever runs. */
  const sheetEl = new MiniEl("div");
  sheetEl.id = "rb-first-run";
  sheetEl.setAttribute("hidden", "");
  byId.set("rb-first-run", sheetEl);

  function answer(body, statusOk) {
    const ok = statusOk !== false;
    return Promise.resolve({
      status: ok ? 200 : 500,
      ok,
      json: () => Promise.resolve(body),
    });
  }

  const fetchStub = (url, init) => {
    const o = init || {};
    const method = o.method || "GET";
    const body = typeof o.body === "string" ? JSON.parse(o.body) : o.body;
    calls.push({ url: String(url), method, body, credentials: o.credentials });
    const u = String(url);
    if (method === "POST" && u === "/api/ramble/moves/slot/swap" && options.swapFails === true) {
      return answer({ error: "no swaps left" }, false);
    }
    if (u === "/api/ramble/moves/day") {
      if (options.deferDay === true) {
        return new Promise((resolve) => {
          pendingDay.push((next) => resolve(answer(next === undefined ? state.day : next)));
        });
      }
      return answer(state.day);
    }
    if (u === "/api/ramble/moves/setup") {
      if (options.setupFails === true) return answer({ error: "refused" }, false);
      return answer({ prefs: prefsState.prefs, day: state.day });
    }
    if (u === "/api/ramble/moves/prefs") {
      if (method === "POST") {
        prefsState.prefs = Object.assign({}, prefsState.prefs, body || {});
        return answer({ prefs: prefsState.prefs });
      }
      return answer({ prefs: prefsState.prefs });
    }
    if (Object.prototype.hasOwnProperty.call(responses, u)) return answer(responses[u]);
    return answer({});
  };

  const sandbox = {
    console,
    fetch: fetchStub,
    document: {
      getElementById: (id) => (id === "rb-today-view" ? host : get(id)),
      createElement: (tag) => new MiniEl(tag),
    },
  };
  sandbox.window = sandbox;
  sandbox.RambleMoves = {
    whenCopy: () => Promise.resolve(table),
    copy: (key, values) => fill(table, key, values || {}),
    text: (key) => movesText(typeof key === "string" ? key : ""),
    startSlot: (item, day) => {
      spy.started.push({ slot: item && item.slot, item, day });
      return Promise.resolve();
    },
    finishWalk: () => {
      spy.finished += 1;
      return Promise.resolve();
    },
    outdoorRunning: () => state.running,
  };
  /* A page whose moves client carries no text hook at all. */
  if (options.noText === true) delete sandbox.RambleMoves.text;
  vm.createContext(sandbox);
  new vm.Script(SRC, { filename: "today.js" }).runInContext(sandbox);

  return {
    host,
    sandbox,
    calls,
    spy,
    get,
    pendingDay,
    setRunning(value) { state.running = value === true; },
    setDay(next) { state.day = next; },
    setPrefs(next) { prefsState.prefs = next; },
    setTable(next) { table = next; },
  };
}

/* -------------------------------------------------------------- the cards */

describe("cards", () => {
  test("one card per slot in the day's order, with only the Now card open", async () => {
    const booted = boot();
    await flush();

    const cards = cardsIn(booted.host);
    assert.deepEqual(cards.map((card) => card.getAttribute("data-slot")), ["morning", "midday", "evening"],
      "a card per slot, in the payload's order");

    assert.equal(bodyOf(cards[0]).hasAttribute("hidden"), false, "the Now card starts open");
    assert.equal(bodyOf(cards[1]).hasAttribute("hidden"), true, "every other card starts shut");
    assert.equal(bodyOf(cards[2]).hasAttribute("hidden"), true);

    const badges = booted.host.findAll((node) => hasClass(node, "rb-slot-now"));
    assert.equal(badges.length, 1, "only the Now card carries the badge");
    assert.equal(badges[0].textContent, expected("today.card.now"));
    const text = booted.host.textContent;
    assert.equal(text.split(expected("today.card.now")).length - 1, 1, "and it appears once on the page");

    assert.ok(cards[0].textContent.includes(expected("settings.slot.morning")), "the header names the slot");
    assert.ok(cards[0].textContent.includes(WALK.title), "and shows the title while the card is shut");

    assert.equal(booted.get("rb-goal-num").textContent, "2,400", "the steps meter reads the day");
    assert.equal(booted.get("rb-goal-max").textContent, "6,000");
  });

  test("the header opens and shuts its own card", async () => {
    const booted = boot();
    await flush();

    const card = cardFor(booted.host, "midday");
    const head = card.findAll((node) => node.tagName === "BUTTON")[0];
    assert.equal(head.getAttribute("aria-expanded"), "false");
    head.click();
    assert.equal(bodyOf(card).hasAttribute("hidden"), false, "the header opens the body");
    assert.equal(head.getAttribute("aria-expanded"), "true");
    head.click();
    assert.equal(bodyOf(card).hasAttribute("hidden"), true, "and shuts it again");
    assert.equal(head.getAttribute("aria-expanded"), "false");
  });

  test("a normal card carries the length line, Start and Swap; a walk carries Done too", async () => {
    const booted = boot();
    await flush();

    for (const card of cardsIn(booted.host)) {
      assert.ok(card.textContent.includes(expected("today.card.length", { minutes: 10 })),
        "the entry's own minutes fill the length line");
      assert.ok(buttonNamed(card, expected("today.card.start")), "every card can start");
      assert.ok(buttonNamed(card, expected("today.card.swap")), "and swap");
    }

    const walkDone = buttonNamed(cardFor(booted.host, "morning"), expected("today.card.done"));
    assert.ok(walkDone, "a walk card has its own Done");
    assert.equal(walkDone.disabled, true, "Done waits for a running walk");

    assert.equal(buttonNamed(cardFor(booted.host, "midday"), expected("today.card.done")), null,
      "a chunk card has no Done");

    const running = boot({ running: true });
    await flush();
    assert.equal(buttonNamed(cardFor(running.host, "morning"), expected("today.card.done")).disabled, false,
      "a running walk's Done can be pressed");
  });

  test("the streak line counts done of need, and says so when the day is done", async () => {
    const two = deep(DAY);
    two.streak = { days: 4, doneToday: 2, need: 3 };
    const booted = boot({ day: two });
    await flush();

    const text = booted.host.textContent;
    assert.ok(text.includes(expected("today.streak.line", { done: 2, total: 3 })), "2 of 3 done");
    assert.ok(text.includes(expected("today.streak.days", { n: 4 })), "and the days in a row");

    const allDone = deep(DAY);
    allDone.streak = { days: 3, doneToday: 3, need: 3 };
    booted.sandbox.RambleToday.paint(allDone);
    const done = booted.host.textContent;
    assert.ok(done.includes(expected("today.streak.allDone")), "the day's own all-done line");
    assert.equal(done.includes(expected("today.streak.line", { done: 3, total: 3 })), false,
      "and not the counting line as well");
    assert.ok(done.includes(expected("today.streak.days", { n: 3 })));

    const noDays = deep(DAY);
    noDays.streak = { days: 0, doneToday: 0, need: 3 };
    booted.sandbox.RambleToday.paint(noDays);
    assert.equal(booted.host.textContent.includes(expected("today.streak.days", { n: 0 })), false,
      "no day line for a streak of none");
  });

  test("an empty slot says so and offers nothing", async () => {
    const day = deep(DAY);
    day.slots[1] = {
      slot: "midday", entry: null, area: null, plannedArea: "strength", reasons: ["no_match"],
      why: "", swap: 0, done: false, standIn: false, empty: true,
    };
    const booted = boot({ day });
    await flush();

    const card = cardFor(booted.host, "midday");
    assert.ok(card.textContent.includes(expected("today.card.emptySlot")));
    assert.equal(buttonNamed(card, expected("today.card.start")), null, "nothing to start");
    assert.equal(buttonNamed(card, expected("today.card.swap")), null, "and nothing to swap to");
  });

  test("a done card says Done today and offers nothing at all", async () => {
    const day = deep(DAY);
    day.slots[0] = Object.assign({}, day.slots[0], { done: true });
    const booted = boot({ day });
    await flush();

    const card = cardFor(booted.host, "morning");
    assert.ok(card.textContent.includes(expected("today.card.isDone")));
    for (const key of ["today.card.start", "today.card.done", "today.card.swap"]) {
      assert.equal(buttonNamed(card, expected(key)), null, "a done card carries no " + key);
    }
    assert.equal(card.hasAttribute("data-stand-in"), false, "a card done by its own entry is no stand-in");
  });

  test("a stand-in card is a done card, marked as one", async () => {
    const day = deep(DAY);
    day.slots[2] = Object.assign({}, day.slots[2], { done: false, standIn: true });
    const booted = boot({ day });
    await flush();

    const card = cardFor(booted.host, "evening");
    assert.equal(card.getAttribute("data-stand-in"), "true");
    assert.ok(card.textContent.includes(expected("today.card.isDone")), "a stand-in is done, whatever else the slot says");
    for (const key of ["today.card.start", "today.card.done", "today.card.swap"]) {
      assert.equal(buttonNamed(card, expected(key)), null, "a stand-in carries no " + key);
    }
  });

  test("Start hands the card's own item to the moves hook", async () => {
    const booted = boot();
    await flush();

    buttonNamed(cardFor(booted.host, "midday"), expected("today.card.start")).click();
    await flush();

    assert.equal(booted.spy.started.length, 1, "the hook was called once");
    assert.equal(booted.spy.started[0].slot, "midday");
    assert.equal(booted.spy.started[0].item.entry.id, CHAIR.id, "with the card's own entry");
    assert.equal(booted.spy.started[0].day, DAY.day, "and the day the payload carries");
  });

  test("a walk's Start asks the day again once the hook settles", async () => {
    const booted = boot();
    await flush();
    const reads = () => booted.calls.filter((call) => call.url === "/api/ramble/moves/day").length;
    const before = reads();

    buttonNamed(cardFor(booted.host, "morning"), expected("today.card.start")).click();
    await flush();

    assert.equal(booted.spy.started.length, 1, "the walk's clock was started");
    assert.equal(reads(), before + 1, "and the day was read again afterwards");
  });

  test("Swap posts the slot and redraws only that card", async () => {
    const next = deep(DAY);
    next.slots[1] = Object.assign({}, next.slots[1], {
      entry: { id: "wall-push", kind: "exercise", title: "Wall push", minutes: 10 },
      swap: 2,
    });
    const booted = boot({ responses: { "/api/ramble/moves/slot/swap": next } });
    await flush();

    const morning = cardFor(booted.host, "morning");
    const evening = cardFor(booted.host, "evening");
    const midday = cardFor(booted.host, "midday");
    const swapButton = buttonNamed(midday, expected("today.card.swap"));
    swapButton.click();
    assert.equal(swapButton.disabled, true, "the Swap button is disabled while the request is in flight");

    await flush();

    const post = booted.calls.find((call) => call.method === "POST" && call.url === "/api/ramble/moves/slot/swap");
    assert.ok(post, "Swap posts the slot route");
    assert.equal(post.credentials, "same-origin");
    assert.deepEqual(post.body, { slot: "midday" }, "naming only the slot");

    assert.equal(cardFor(booted.host, "morning"), morning, "the other cards keep their own elements");
    assert.equal(cardFor(booted.host, "evening"), evening);
    const swapped = cardFor(booted.host, "midday");
    assert.notEqual(swapped, midday, "the swapped card is redrawn");
    assert.ok(swapped.textContent.includes("Wall push"), "and shows the entry the swap answered with");
    assert.equal(bodyOf(swapped).hasAttribute("hidden"), true, "keeping the state it was in");
  });

  test("a refused swap leaves the cards alone and its button pressable again", async () => {
    const booted = boot({ swapFails: true });
    await flush();

    const midday = cardFor(booted.host, "midday");
    const swapButton = buttonNamed(midday, expected("today.card.swap"));
    swapButton.click();
    await flush();

    assert.equal(swapButton.disabled, false, "a failed swap re-enables its button");
    assert.equal(cardFor(booted.host, "midday"), midday, "and the card it belonged to stays put");
  });

  test("a paused day draws its two lines and no cards", async () => {
    const paused = deep(DAY);
    paused.off = true;
    const booted = boot({ day: paused });
    await flush();

    assert.equal(cardsIn(booted.host).length, 0, "a paused day has no cards");
    assert.notEqual(movesText("paused"), "", "the moves client carries the paused line");
    assert.notEqual(movesText("pausedLine"), "", "and the line under it");

    const heading = booted.host.findAll((node) => hasClass(node, "rb-slot-title"));
    assert.equal(heading.length, 1, "one heading-style line");
    assert.equal(heading[0].textContent, movesText("paused"), "saying the day is paused");

    const fine = booted.host.findAll((node) => hasClass(node, "rb-fine"));
    assert.equal(fine.length, 1, "and one quiet line");
    assert.equal(fine[0].textContent, movesText("pausedLine"), "saying how to turn it back on");
    assert.ok(hasClass(fine[0], "rb-muted"), "the quiet line carries the muted class too");

    assert.equal(booted.get("rb-goal-num").textContent, "2,400", "the steps meter is still painted");
    assert.equal(booted.get("rb-goal-max").textContent, "6,000");
  });

  test("a paused day on a page with no text hook draws nothing", async () => {
    const paused = deep(DAY);
    paused.off = true;
    const booted = boot({ day: paused, noText: true });
    await flush();

    assert.equal(booted.host.children.length, 0, "no hook, no line at all");
    assert.equal(booted.get("rb-goal-num").textContent, "2,400", "the meter is still painted");
  });

  test("a card with no swaps left keeps its Swap label and cannot be pressed", async () => {
    const day = deep(DAY);
    day.slots[1] = Object.assign({}, day.slots[1], { swap: 3 });
    const booted = boot({ day });
    await flush();

    const spent = buttonNamed(cardFor(booted.host, "midday"), expected("today.card.swap"));
    assert.ok(spent, "the label stays the table's word");
    assert.equal(spent.textContent, expected("today.card.swap"));
    assert.equal(spent.disabled, true, "a third swap is all the day gives, so a press would go nowhere");

    const left = buttonNamed(cardFor(booted.host, "morning"), expected("today.card.swap"));
    assert.equal(left.disabled, false, "a card with swaps left is still pressable");
  });

  test("the cards the reader opened and shut keep their state across a repaint", async () => {
    const booted = boot();
    await flush();

    const midday = cardFor(booted.host, "midday");
    midday.findAll((node) => node.tagName === "BUTTON")[0].click();
    assert.equal(bodyOf(midday).hasAttribute("hidden"), false, "the reader opened midday");

    const morning = cardFor(booted.host, "morning");
    morning.findAll((node) => node.tagName === "BUTTON")[0].click();
    assert.equal(bodyOf(morning).hasAttribute("hidden"), true, "and shut the Now card");

    await booted.sandbox.RambleToday.refresh();
    await flush();

    assert.notEqual(cardFor(booted.host, "midday"), midday, "the cards were drawn again");
    assert.equal(bodyOf(cardFor(booted.host, "midday")).hasAttribute("hidden"), false,
      "midday is still open");
    assert.equal(bodyOf(cardFor(booted.host, "morning")).hasAttribute("hidden"), true,
      "and the morning card is still shut");

    const fresh = deep(DAY);
    fresh.slots = [Object.assign({}, DAY.slots[0], { slot: "dawn" })];
    fresh.nowSlot = "dawn";
    booted.sandbox.RambleToday.paint(fresh);
    assert.equal(bodyOf(cardFor(booted.host, "dawn")).hasAttribute("hidden"), false,
      "a slot the reader has never seen opens when the day says it is Now");
  });

  test("two refreshes answered out of order paint only the newer day", async () => {
    const booted = boot({ deferDay: true });
    await flush();
    assert.equal(booted.pendingDay.length, 1, "the boot's own read is in flight");
    booted.pendingDay[0](DAY);
    await flush();

    const older = deep(DAY);
    older.streak = { days: 1, doneToday: 0, need: 3 };
    const newer = deep(DAY);
    newer.streak = { days: 9, doneToday: 2, need: 3 };

    const first = booted.sandbox.RambleToday.refresh();
    const second = booted.sandbox.RambleToday.refresh();
    await flush();
    assert.equal(booted.pendingDay.length, 3, "both reads are in flight");

    booted.pendingDay[2](newer);
    await flush();
    booted.pendingDay[1](older);
    await flush();
    await Promise.all([first, second]);

    const text = booted.host.textContent;
    assert.ok(text.includes(expected("today.streak.days", { n: 9 })), "the newer answer is on screen");
    assert.equal(text.includes(expected("today.streak.days", { n: 1 })), false,
      "the answer to the earlier request never painted over it");
  });

  test("a line the copy table does not carry renders nothing", async () => {
    const table = Object.assign({}, COPY);
    delete table["today.card.swap"];
    const booted = boot({ table });
    await flush();

    const swapLabel = COPY["today.card.swap"];
    assert.equal(booted.host.findAll((node) => node.tagName === "BUTTON" && node.textContent === swapLabel).length, 0,
      "no Swap button without its line");
    assert.equal(booted.host.findAll((node) => hasClass(node, "rb-slot-card")).length, 3, "the cards are still drawn");
    assert.ok(buttonNamed(cardFor(booted.host, "midday"), COPY["today.card.start"]),
      "the lines the table does carry are still drawn");
  });

  test("with no host element the script does nothing", async () => {
    const booted = boot({ noHost: true });
    await flush();
    assert.equal(booted.calls.length, 0, "no host, no day to read");
    assert.equal(typeof booted.sandbox.RambleToday.refresh, "function", "the hook is still there to be called");
    assert.equal(typeof booted.sandbox.RambleToday.paint, "function");
    assert.equal(typeof booted.sandbox.RambleToday.loadSlots, "function", "and so is the one that fills the sheet's block");
  });

  test("today.js carries no backtick, and writes no markup", () => {
    assert.equal((SRC.match(/`/g) || []).length, 0,
      "panel client scripts must not carry a backtick: the tooling treats it as its own delimiter");
    assert.equal(SRC.includes("innerHTML"), false, "every server string is written with textContent");
    assert.ok(SRC.endsWith("\n"), "the file ends with a newline");
    assert.ok(readFileSync(fileURLToPath(import.meta.url), "utf8").endsWith("\n"), "and so does this test file");
  });
});

/* ------------------------------------------------------- the first-run sheet */

function inputsOf(root, type) {
  return root.findAll((node) => node.tagName === "INPUT" && (!type || node.type === type));
}

function inputWith(root, value) {
  return inputsOf(root).find((node) => node.value === value) || null;
}

function neededDay() {
  const day = deep(DAY);
  day.setup = { needed: true };
  return day;
}

function firstRunBody(booted) { return booted.get("rb-first-run-body"); }
function firstRunSheet(booted) { return booted.get("rb-first-run"); }

function setupPosts(booted) {
  return booted.calls.filter((call) => call.url === "/api/ramble/moves/setup");
}

function dayReads(booted) {
  return booted.calls.filter((call) => call.url === "/api/ramble/moves/day").length;
}

function titleOf(root) {
  const titles = root.findAll((node) => node.tagName === "H3");
  return titles.length === 1 ? titles[0] : null;
}

const LIMIT_TAGS = [
  "knee", "lower_back", "neck", "shoulder", "wrist",
  "hip", "ankle", "balance", "pregnancy", "high_blood_pressure",
];

describe("first run", () => {
  test("setup.needed true opens the sheet on the equipment screen", async () => {
    const booted = boot({ day: neededDay() });
    await flush();

    assert.equal(firstRunSheet(booted).hasAttribute("hidden"), false, "the sheet is open");
    const body = firstRunBody(booted);
    const title = titleOf(body);
    assert.ok(title, "one title");
    assert.equal(title.textContent, expected("firstRun.equipment.title"));
    assert.equal(title.id, "rb-first-run-title", "the panel names the title by its id");
    assert.ok(body.textContent.includes(expected("firstRun.equipment.hint")), "with the hint under it");

    const boxes = inputsOf(body, "checkbox");
    assert.deepEqual(boxes.map((box) => box.value), ["mat", "band", "chair", "wall"], "a box per thing you may have");
    assert.deepEqual(boxes.map((box) => box.checked), [false, false, false, true], "only the wall starts ticked");
    for (const tag of ["mat", "band", "chair", "wall"]) {
      assert.ok(body.textContent.includes(expected("firstRun.equipment." + tag)), "the line for " + tag);
    }

    assert.ok(buttonNamed(body, expected("firstRun.skip")), "every screen can be skipped");
    assert.ok(buttonNamed(body, expected("firstRun.next")), "and the first two say Next");
    assert.equal(buttonNamed(body, expected("firstRun.done")), null, "the last one finishes, not this one");
  });

  test("Next walks to the limits screen: ten boxes, every one off", async () => {
    const booted = boot({ day: neededDay() });
    await flush();
    buttonNamed(firstRunBody(booted), expected("firstRun.next")).click();

    const body = firstRunBody(booted);
    assert.equal(titleOf(body).textContent, expected("firstRun.limits.title"));
    assert.ok(body.textContent.includes(expected("firstRun.limits.hint")));

    const boxes = inputsOf(body, "checkbox");
    assert.deepEqual(boxes.map((box) => box.value), LIMIT_TAGS, "a box per limit tag");
    assert.equal(boxes.every((box) => box.checked === false), true, "and none of them ticked");
    assert.ok(body.textContent.includes(expected("firstRun.limit.knee")), "Knees");
    assert.ok(body.textContent.includes("Knees"), "a tag reads as its own name");
    assert.equal(inputsOf(body, "radio").length, 0, "the level is not asked here");
    assert.ok(buttonNamed(body, expected("firstRun.next")));
    assert.ok(buttonNamed(body, expected("firstRun.skip")));
  });

  test("Next again walks to the level screen with Steady selected", async () => {
    const booted = boot({ day: neededDay() });
    await flush();
    buttonNamed(firstRunBody(booted), expected("firstRun.next")).click();
    buttonNamed(firstRunBody(booted), expected("firstRun.next")).click();

    const body = firstRunBody(booted);
    assert.equal(titleOf(body).textContent, expected("firstRun.level.title"));
    const radios = inputsOf(body, "radio");
    assert.deepEqual(radios.map((radio) => radio.value), ["1", "2", "3"]);
    assert.equal(new Set(radios.map((radio) => radio.name)).size, 1, "one name group");
    assert.deepEqual(radios.map((radio) => radio.checked), [false, true, false], "Steady is the one selected");
    assert.ok(body.textContent.includes(expected("firstRun.level.1")));
    assert.ok(body.textContent.includes(expected("firstRun.level.3")));
    assert.ok(buttonNamed(body, expected("firstRun.done")), "the last screen finishes");
    assert.equal(buttonNamed(body, expected("firstRun.next")), null, "it does not say Next");
    assert.ok(buttonNamed(body, expected("firstRun.skip")));
  });

  test("the untouched path posts none plus the wall, no limits and the middle level", async () => {
    const booted = boot({ day: neededDay() });
    await flush();
    const before = dayReads(booted);

    buttonNamed(firstRunBody(booted), expected("firstRun.next")).click();
    buttonNamed(firstRunBody(booted), expected("firstRun.next")).click();
    buttonNamed(firstRunBody(booted), expected("firstRun.done")).click();
    await flush();

    const posts = setupPosts(booted);
    assert.equal(posts.length, 1, "one setup request carries all three screens");
    assert.equal(posts[0].method, "POST");
    assert.equal(posts[0].credentials, "same-origin");
    assert.deepEqual(posts[0].body, { equipment: ["none", "wall"], limits: [], level: 2 });
    assert.equal(firstRunSheet(booted).hasAttribute("hidden"), true, "the sheet closes");
    assert.equal(dayReads(booted), before + 1, "and the day is read again");
  });

  test("what is ticked becomes the answer: none first, then the tags in page order", async () => {
    const booted = boot({ day: neededDay() });
    await flush();

    inputWith(firstRunBody(booted), "mat").checked = true;
    buttonNamed(firstRunBody(booted), expected("firstRun.next")).click();
    inputWith(firstRunBody(booted), "knee").checked = true;
    buttonNamed(firstRunBody(booted), expected("firstRun.next")).click();

    const challenging = inputWith(firstRunBody(booted), "3");
    challenging.checked = true;
    challenging.change();
    assert.deepEqual(inputsOf(firstRunBody(booted), "radio").map((radio) => radio.checked), [false, false, true],
      "one level at a time");

    buttonNamed(firstRunBody(booted), expected("firstRun.done")).click();
    await flush();

    assert.deepEqual(setupPosts(booted)[0].body, {
      equipment: ["none", "mat", "wall"],
      limits: ["knee"],
      level: 3,
    });
  });

  test("Skip on the first screen leaves the equipment out of the body", async () => {
    const booted = boot({ day: neededDay() });
    await flush();

    buttonNamed(firstRunBody(booted), expected("firstRun.skip")).click();
    assert.equal(titleOf(firstRunBody(booted)).textContent, expected("firstRun.limits.title"), "Skip moves on");

    buttonNamed(firstRunBody(booted), expected("firstRun.next")).click();
    buttonNamed(firstRunBody(booted), expected("firstRun.done")).click();
    await flush();

    const body = setupPosts(booted)[0].body;
    assert.equal(Object.prototype.hasOwnProperty.call(body, "equipment"), false,
      "a skipped screen states nothing at all");
    assert.deepEqual(body, { limits: [], level: 2 });
  });

  test("skipping every screen sends an empty answer", async () => {
    const booted = boot({ day: neededDay() });
    await flush();

    buttonNamed(firstRunBody(booted), expected("firstRun.skip")).click();
    buttonNamed(firstRunBody(booted), expected("firstRun.skip")).click();
    buttonNamed(firstRunBody(booted), expected("firstRun.skip")).click();
    await flush();

    assert.deepEqual(setupPosts(booted)[0].body, {}, "the defaults are the server's to fill in");
    assert.equal(firstRunSheet(booted).hasAttribute("hidden"), true, "the sheet still closes");
  });

  test("an answer the server refused leaves the sheet open for the next read", async () => {
    const booted = boot({ day: neededDay(), setupFails: true });
    await flush();
    const before = dayReads(booted);

    buttonNamed(firstRunBody(booted), expected("firstRun.skip")).click();
    buttonNamed(firstRunBody(booted), expected("firstRun.skip")).click();
    buttonNamed(firstRunBody(booted), expected("firstRun.skip")).click();
    await flush();

    assert.equal(setupPosts(booted).length, 1, "the answer was sent");
    assert.equal(dayReads(booted), before + 1, "and the day was read again");
    assert.equal(firstRunSheet(booted).hasAttribute("hidden"), false,
      "a refused answer is no answer, so the sheet is open again");
    assert.equal(titleOf(firstRunBody(booted)).textContent, expected("firstRun.equipment.title"),
      "back on the first screen, to be asked again");
  });

  test("a copy table without the sheet's words leaves the sheet shut", async () => {
    const booted = boot({ day: neededDay(), table: {} });
    await flush();

    assert.equal(firstRunSheet(booted).hasAttribute("hidden"), true,
      "no Next and no Skip is no question to ask");
    assert.equal(firstRunBody(booted).children.length, 0, "and no screen was drawn");
    assert.equal(setupPosts(booted).length, 0, "nothing was answered");

    /* The sheet was never marked as shown, so a read that does carry the words
     * asks it. */
    booted.setTable(COPY);
    await booted.sandbox.RambleToday.refresh();
    await flush();
    assert.equal(firstRunSheet(booted).hasAttribute("hidden"), false, "the later read opens it");
    assert.equal(titleOf(firstRunBody(booted)).textContent, expected("firstRun.equipment.title"));
  });

  test("one of the sheet's two words missing is still no question to ask", async () => {
    const half = Object.assign({}, COPY);
    delete half["firstRun.skip"];
    const booted = boot({ day: neededDay(), table: half });
    await flush();

    assert.equal(firstRunSheet(booted).hasAttribute("hidden"), true, "no Skip, no sheet");
    assert.equal(setupPosts(booted).length, 0);
  });

  test("a day that needs nothing never opens the sheet", async () => {
    const off = boot();
    await flush();
    assert.equal(dayReads(off), 1, "the day was read");
    assert.equal(firstRunSheet(off).hasAttribute("hidden"), true, "needed false is no sheet");

    const absent = deep(DAY);
    delete absent.setup;
    const none = boot({ day: absent });
    await flush();
    assert.equal(firstRunSheet(none).hasAttribute("hidden"), true, "an absent setup is no sheet either");
    assert.equal(setupPosts(none).length, 0, "and nothing was answered");
  });

  test("the setup is asked once per page, whatever the day says next", async () => {
    const booted = boot({ day: neededDay() });
    await flush();
    buttonNamed(firstRunBody(booted), expected("firstRun.skip")).click();
    buttonNamed(firstRunBody(booted), expected("firstRun.skip")).click();
    buttonNamed(firstRunBody(booted), expected("firstRun.skip")).click();
    await flush();
    assert.equal(firstRunSheet(booted).hasAttribute("hidden"), true);

    booted.setDay(deep(DAY));
    await booted.sandbox.RambleToday.refresh();
    await flush();
    assert.equal(firstRunSheet(booted).hasAttribute("hidden"), true, "a day that needs nothing keeps it shut");

    booted.setDay(neededDay());
    await booted.sandbox.RambleToday.refresh();
    await flush();
    assert.equal(firstRunSheet(booted).hasAttribute("hidden"), true, "and it is never asked twice");
    assert.equal(setupPosts(booted).length, 1, "no second answer was sent");
  });
});

/* ----------------------------------------------- cards a day and the windows */

function slotsBlock(booted) { return booted.get("rb-pref-slots"); }

function blockInputs(booted, type) { return inputsOf(slotsBlock(booted), type); }

function prefsPosts(booted) {
  return booted.calls.filter((call) => call.method === "POST" && call.url === "/api/ramble/moves/prefs");
}

async function openCustomize(booted) {
  booted.get("rb-customize").click();
  await flush();
  return slotsBlock(booted);
}

describe("settings", () => {
  test("clicking the customize button loads the prefs into the block", async () => {
    const booted = boot({ prefs: { cards: 2, windows: [] } });
    await flush();
    const block = await openCustomize(booted);

    const cards = blockInputs(booted, "radio");
    assert.deepEqual(cards.map((input) => input.value), ["1", "2", "3"]);
    assert.deepEqual(cards.map((input) => input.checked), [false, true, false], "the stored count is the one selected");

    const windows = blockInputs(booted, "checkbox");
    assert.deepEqual(windows.map((input) => input.value), ["morning", "midday", "evening"]);
    assert.deepEqual(windows.map((input) => input.checked), [true, false, true],
      "an empty list means the default windows for two cards");

    assert.ok(block.textContent.includes(expected("settings.cardsPerDay.note")), "the note sits under the count");
  });

  test("the windows are ticked as stored, in slot order", async () => {
    const booted = boot({ prefs: { cards: 3, windows: ["evening", "morning"] } });
    await flush();
    await openCustomize(booted);

    assert.deepEqual(blockInputs(booted, "checkbox").map((input) => input.checked), [true, false, true],
      "the stored pair, and no midday");
  });

  test("choosing two cards posts the count and re-ticks the default windows", async () => {
    const booted = boot({ prefs: { cards: 3, windows: [] } });
    await flush();
    await openCustomize(booted);
    const before = dayReads(booted);

    const two = blockInputs(booted, "radio").find((input) => input.value === "2");
    two.checked = true;
    two.change();
    await flush();

    const posts = prefsPosts(booted);
    assert.equal(posts.length, 1, "one request");
    assert.equal(posts[0].credentials, "same-origin");
    assert.deepEqual(posts[0].body, { cards: 2, windows: [] }, "the windows go back to that count's defaults");

    assert.deepEqual(blockInputs(booted, "checkbox").map((input) => input.checked), [true, false, true],
      "morning and evening are ticked");
    assert.deepEqual(blockInputs(booted, "radio").map((input) => input.checked), [false, true, false],
      "and two is the one selected");
    assert.equal(dayReads(booted), before + 1, "the day is read again");
  });

  test("an untick that leaves fewer windows than cards posts nothing and stays unticked", async () => {
    const booted = boot({ prefs: { cards: 3, windows: [] } });
    await flush();
    await openCustomize(booted);

    const midday = blockInputs(booted, "checkbox").find((input) => input.value === "midday");
    assert.equal(midday.checked, true, "three cards tick all three windows");
    midday.checked = false;
    midday.change();
    await flush();

    assert.equal(prefsPosts(booted).length, 0, "one window short is a change still in progress");
    assert.equal(midday.checked, false, "so the box stays exactly as the player left it");
  });

  test("a tick that goes over the count swaps the earliest other window out", async () => {
    const booted = boot({ prefs: { cards: 2, windows: [] } });
    await flush();
    await openCustomize(booted);
    const boxes = () => blockInputs(booted, "checkbox");
    const box = (value) => boxes().find((input) => input.value === value);
    assert.deepEqual(boxes().map((input) => input.checked), [true, false, true],
      "two cards, the default morning and evening");
    const before = dayReads(booted);

    const midday = box("midday");
    midday.checked = true;
    midday.change();
    await flush();

    let posts = prefsPosts(booted);
    assert.equal(posts.length, 1, "the swap is posted");
    assert.deepEqual(posts[0].body, { windows: ["midday", "evening"] },
      "midday took the place of the earliest other tick, morning");
    assert.deepEqual(boxes().map((input) => input.checked), [false, true, true]);
    assert.equal(dayReads(booted), before + 1, "and the day is read again");

    const evening = box("evening");
    evening.checked = false;
    evening.change();
    await flush();
    assert.equal(prefsPosts(booted).length, 1, "an untick below the count posts nothing");
    assert.equal(evening.checked, false, "and the box is left unticked");

    const morning = box("morning");
    morning.checked = true;
    morning.change();
    await flush();
    posts = prefsPosts(booted);
    assert.equal(posts.length, 2, "the count is back to the cards value");
    assert.deepEqual(posts[1].body, { windows: ["morning", "midday"] }, "in slot order");
  });

  test("with one card a tick swaps the ticked window for the one asked for", async () => {
    const booted = boot({ prefs: { cards: 1, windows: [] } });
    await flush();
    await openCustomize(booted);
    assert.deepEqual(blockInputs(booted, "checkbox").map((input) => input.checked), [false, true, false],
      "one card ticks midday by default");

    const morning = blockInputs(booted, "checkbox").find((input) => input.value === "morning");
    morning.checked = true;
    morning.change();
    await flush();

    const posts = prefsPosts(booted);
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].body, { windows: ["morning"] }, "the one window the day holds is the one asked for");
    assert.deepEqual(blockInputs(booted, "checkbox").map((input) => input.checked), [true, false, false]);
  });

  test("the tick that matches the count posts the windows in slot order", async () => {
    const booted = boot({ prefs: { cards: 3, windows: ["evening", "morning"] } });
    await flush();
    await openCustomize(booted);

    const midday = blockInputs(booted, "checkbox").find((input) => input.value === "midday");
    assert.equal(midday.checked, false);
    midday.checked = true;
    midday.change();
    await flush();

    const posts = prefsPosts(booted);
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].body, { windows: ["morning", "midday", "evening"] });
  });

  test("the block is built from the table's lines and nothing else", async () => {
    const booted = boot({ prefs: { cards: 1, windows: [] } });
    await flush();
    const block = await openCustomize(booted);

    let rest = block.textContent;
    for (const key of [
      "settings.cardsPerDay", "settings.cardsPerDay.note", "settings.windows",
      "settings.slot.morning", "settings.slot.midday", "settings.slot.evening",
    ]) {
      const line = expected(key);
      assert.ok(line !== "", key + " is in the table");
      assert.ok(rest.includes(line), key + " is on screen");
      rest = rest.split(line).join("");
    }
    for (const digit of ["1", "2", "3"]) rest = rest.split(digit).join("");
    assert.equal(rest, "", "no other word is drawn");
  });

  test("the two buttons beside the cards say the table's lines", async () => {
    const booted = boot();
    await flush();
    assert.equal(booted.get("rb-customize").textContent, expected("today.settings"));
    assert.equal(booted.get("rb-something-else").textContent, expected("today.somethingElse"));

    const table = Object.assign({}, COPY);
    delete table["today.settings"];
    const plain = boot({ table });
    await flush();
    assert.equal(plain.get("rb-customize").textContent, "", "a missing line leaves the server's label alone");
  });
});
