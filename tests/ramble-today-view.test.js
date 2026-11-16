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

function copyFrom(table) {
  return function copy(key, values) {
    return fill(table, key, values || {});
  };
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
  const table = options.table || COPY;
  const byId = new Map();
  const host = options.noHost ? null : new MiniEl("div");
  if (host) host.id = "rb-today-view";
  const get = (id) => {
    if (!byId.has(id)) byId.set(id, new MiniEl("div"));
    return byId.get(id);
  };

  const calls = [];
  const spy = { started: [], finished: 0 };
  const state = { running: options.running === true };
  const dayAnswer = options.day || DAY;
  const responses = Object.assign({ "/api/ramble/moves/day": dayAnswer }, options.responses || {});

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
    copy: copyFrom(table),
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
  vm.createContext(sandbox);
  new vm.Script(SRC, { filename: "today.js" }).runInContext(sandbox);

  return {
    host,
    sandbox,
    calls,
    spy,
    get,
    setRunning(value) { state.running = value === true; },
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

  test("a paused day draws no cards", async () => {
    const paused = deep(DAY);
    paused.off = true;
    const booted = boot({ day: paused });
    await flush();

    assert.equal(cardsIn(booted.host).length, 0, "a paused day has no cards");
    assert.equal(booted.host.children.length, 0, "and nothing sits where they would be");
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
  });

  test("today.js carries no backtick, and writes no markup", () => {
    assert.equal((SRC.match(/`/g) || []).length, 0,
      "panel client scripts must not carry a backtick: the tooling treats it as its own delimiter");
    assert.equal(SRC.includes("innerHTML"), false, "every server string is written with textContent");
    assert.ok(SRC.endsWith("\n"), "the file ends with a newline");
    assert.ok(readFileSync(fileURLToPath(import.meta.url), "utf8").endsWith("\n"), "and so does this test file");
  });
});
