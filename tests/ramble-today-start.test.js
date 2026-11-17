/**
 * Moves design — Start on a walk card, on the page as it is really rendered.
 *
 * The walk's Start/Done path in static/moves.js was written against the legacy
 * single challenge card (rb-challenge-start / rb-challenge-done) and one global
 * status line (rb-today-status) that sits under ALL the cards. P10 removed that
 * card from the page: Today's cards are drawn by static/today.js into
 * #rb-today-view. The older tests kept clicking ids the page no longer carries,
 * because their mini DOM invented any element by id.
 *
 * So this file is a live-layout test: it renders the real panel HTML, takes
 * every id the page actually carries from it, and boots moves.js THEN today.js
 * in ONE vm sandbox whose document.getElementById answers null for any other id.
 * The removed legacy ids are therefore really absent, exactly as in a browser.
 *
 * Routes stubbed, no network: the day (a walk card as the Now card, a routine
 * card beside it), the copy (/api/ramble/moves/copy, from the real table), and
 * the two outdoor routes, each test answering them as it needs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const MOVES_SRC = readFileSync(resolve(ROOT, "bundles/ramble/panel/static/moves.js"), "utf8");
const TODAY_SRC = readFileSync(resolve(ROOT, "bundles/ramble/panel/static/today.js"), "utf8");
const COPY = JSON.parse(readFileSync(resolve(ROOT, "bundles/ramble/server/moves/player-copy.en.json"), "utf8"));

const { default: panel } = await import("../bundles/ramble/panel/ramble.js");

/* The moves client's own runtime strings (its STR table, not the copy JSON), so
 * an assertion holds the shipped word rather than a second copy of it. */
const MOVES_EN = MOVES_SRC.slice(MOVES_SRC.indexOf("    en: {"), MOVES_SRC.indexOf("    es: {"));

function movesText(key) {
  const hit = new RegExp("\\b" + key + ":\\s*\"([^\"]*)\"").exec(MOVES_EN);
  return hit ? JSON.parse("\"" + hit[1] + "\"") : "";
}

/* The copy table's line, its {placeholders} filled the way moves.js fills them. */
function fill(key, values) {
  const line = typeof COPY[key] === "string" ? COPY[key] : "";
  if (line === "") return "";
  return line.replace(/\{([a-z]+)\}/g, (whole, name) => (
    values && Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : whole
  ));
}

/* The copy lines as one sentence, the way moves.js joins them: a line that does
 * not end itself gets a full stop. */
function sentence(...lines) {
  return lines
    .filter((line) => line !== "")
    .map((line) => (/[.!?]$/.test(line) ? line : line + "."))
    .join(" ");
}

/* ------------------------------------------------------ the rendered page */

async function rendered() {
  let sent = null;
  const res = { send: (html) => { sent = html; } };
  await panel.handler({ query: {} }, res, {
    db: null,
    layout: ({ content }) => content,
    appRoot: ROOT,
    lang: "en",
  });
  assert.ok(sent, "the panel sent nothing");
  return sent;
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
    this.options = [];
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

  addEventListener(type, fn) { (this.listeners[type] || (this.listeners[type] = [])).push(fn); }
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

  fire(type) {
    for (const fn of (this.listeners[type] || []).slice()) fn({ type, target: this });
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

/** Every element the page carries an id for, with the attributes it carries. */
function elementsFromHtml(html) {
  const byId = new Map();
  const tagRe = /<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^<>]*?)?)>/g;
  let tag;
  while ((tag = tagRe.exec(html)) !== null) {
    const parsed = Object.create(null);
    const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:="([^"]*)")?/g;
    let attr;
    while ((attr = attrRe.exec(tag[2] || "")) !== null) {
      parsed[attr[1]] = attr[2] === undefined ? "" : attr[2];
    }
    if (!parsed.id) continue;
    const el = new MiniEl(tag[1]);
    for (const [name, value] of Object.entries(parsed)) el.setAttribute(name, value);
    byId.set(parsed.id, el);
  }
  return byId;
}

function hasClass(node, name) {
  return String(node.className || "").split(/\s+/).indexOf(name) !== -1;
}

function cardFor(host, slot) {
  return host.findAll((node) => hasClass(node, "rb-slot-card") && node.getAttribute("data-slot") === slot)[0] || null;
}

function statusOf(card) {
  return card ? card.findAll((node) => hasClass(node, "rb-slot-status"))[0] || null : null;
}

function buttonNamed(node, label) {
  return node.findAll((kid) => kid.tagName === "BUTTON" && kid.textContent === label)[0] || null;
}

/* --------------------------------------------------------------- fixtures */

const WALK = { id: "walk-10", kind: "walk", title: "A ten minute walk", minutes: 10 };
const ROUTINE = { id: "routine-1", kind: "routine", title: "A short routine", minutes: 10 };
const OTHER_WALK = { id: "walk-20", kind: "walk", title: "A twenty minute walk", minutes: 20 };

function dayFixture() {
  return {
    day: "2026-10-30",
    need: 3,
    nowSlot: "morning",
    off: false,
    complete: false,
    outdoor: null,
    steps: { day: "2026-10-30", goal: 6000, steps: 1200, goal_met: false, walked: false },
    streak: { days: 3, doneToday: 0, need: 3 },
    setup: { needed: false },
    slots: [
      {
        slot: "morning", entry: WALK, area: "cardio", plannedArea: "cardio", reasons: [],
        why: "", swap: 0, done: false, standIn: false, empty: false,
      },
      {
        slot: "midday", entry: ROUTINE, area: "strength", plannedArea: "strength", reasons: [],
        why: "", swap: 0, done: false, standIn: false, empty: false,
      },
    ],
  };
}

/* The same day with a walk in the second card as well, so a walk's own line
 * has two cards to choose between. */
function twoWalkDay() {
  const day = dayFixture();
  day.slots[1] = {
    slot: "midday", entry: OTHER_WALK, area: "cardio", plannedArea: "cardio", reasons: [],
    why: "", swap: 0, done: false, standIn: false, empty: false,
  };
  return day;
}

/* The old single-card snapshot moves.js paints at start-up. Its own card is off
 * the page now, so every write into it must be a no-op. */
const TODAY_SNAPSHOT = {
  challenge: null,
  health: { energy: 40, max: 100, mood: "ok" },
  steps: { day: "2026-10-30", goal: 6000, steps: 1200, goal_met: false, walked: false },
  streak: { days: 3, nextHeartAt: 7, todayGood: false },
};

/* ------------------------------------------------------------------ the boot */

async function flush() {
  for (let i = 0; i < 12; i += 1) await new Promise((r) => setImmediate(r));
}

async function boot(opts) {
  const options = opts || {};
  const html = await rendered();
  const pageEls = elementsFromHtml(html);
  assert.ok(pageEls.has("rb-today-view"), "the page carries the host today.js draws into");
  assert.ok(pageEls.has("ramble"), "the page carries the root moves.js reads");
  assert.equal(pageEls.has("rb-challenge-start"), false,
    "the legacy challenge card is not on the page: the live layout has no such id");

  const now = options.now === undefined ? Date.parse("2026-10-30T10:00:00") : options.now;
  const state = { day: options.day || dayFixture() };
  const routes = Object.assign({}, options.routes || {});
  const calls = [];
  const intervals = [];
  const cleared = [];
  const docListeners = Object.create(null);

  const store = Object.create(null);
  if (options.safetySeen === true) store["ramble.moves.safetySeen"] = "1";

  /* A response the way jsonFetch reads one. */
  function answer(body, status) {
    const code = status === undefined ? 200 : status;
    return Promise.resolve({ status: code, ok: code < 400, json: () => Promise.resolve(body) });
  }

  const fetchStub = (url, init) => {
    const o = init || {};
    const method = o.method || "GET";
    const body = typeof o.body === "string" ? JSON.parse(o.body) : o.body;
    const u = String(url);
    calls.push({ url: u, method, body });
    if (Object.prototype.hasOwnProperty.call(routes, u)) {
      const hit = routes[u];
      return typeof hit === "function" ? hit(body, method, answer) : answer(hit);
    }
    if (u === "/api/ramble/moves/day") return answer(state.day);
    if (u === "/api/ramble/moves/today") return answer(TODAY_SNAPSHOT);
    if (u === "/api/ramble/moves/copy") return answer({ copy: COPY });
    if (u === "/api/ramble/moves/voice") return answer({ lines: {} });
    if (u === "/api/ramble/moves/library") return answer({ entries: [] });
    if (u === "/api/ramble/moves/library/" + ROUTINE.id) {
      return answer({ entry: Object.assign({}, ROUTINE, { steps: ["Stand tall.", "Bend to one side."] }), level: "full" });
    }
    if (u === "/api/ramble/moves/prefs") {
      return answer({ prefs: { on: true, kinds: [], equipment: ["none"], limits: [], level: 2, weather: true } });
    }
    return answer({});
  };

  class FixedDate extends Date {
    constructor(...args) { if (args.length === 0) super(now); else super(...args); }
    static now() { return now; }
  }

  const sandbox = {
    console,
    document: {
      hidden: false,
      /* The one thing this file exists for: an id the rendered page does not
       * carry is not there, no matter what the scripts ask for. */
      getElementById: (id) => (pageEls.has(id) ? pageEls.get(id) : null),
      createElement: (tag) => new MiniEl(tag),
      createElementNS: (ns, tag) => new MiniEl(tag),
      querySelectorAll: () => [],
      addEventListener: (type, fn) => { (docListeners[type] || (docListeners[type] = [])).push(fn); },
    },
    fetch: fetchStub,
    setTimeout,
    clearTimeout,
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval: (id) => { cleared.push(id); },
    Promise,
    JSON,
    Object,
    Array,
    Math,
    Number,
    String,
    isFinite,
    encodeURIComponent,
    Date: FixedDate,
    scrollTo() {},
    localStorage: {
      getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
      setItem(k, v) { store[k] = String(v); },
    },
  };
  sandbox.window = sandbox;
  sandbox.location = { pathname: "/dashboard/ramble", search: "", hash: "" };
  sandbox.history = { state: null, replaced: [], replaceState(st, t, url) { this.replaced.push(url); } };
  sandbox.URLSearchParams = URLSearchParams;
  vm.createContext(sandbox);

  /* The page's own order: the moves client, then the script that draws the
   * cards with its hooks. */
  new vm.Script(MOVES_SRC, { filename: "moves.js" }).runInContext(sandbox);
  new vm.Script(TODAY_SRC, { filename: "today.js" }).runInContext(sandbox);

  return {
    sandbox,
    calls,
    intervals,
    cleared,
    html,
    host: pageEls.get("rb-today-view"),
    root: pageEls.get("ramble"),
    get: (id) => (pageEls.has(id) ? pageEls.get(id) : null),
    startLabel: COPY["today.card.start"],
    doneLabel: COPY["today.card.done"],
  };
}

function startClicks(booted) {
  return booted.calls.filter((c) => c.method === "POST" && c.url === "/api/ramble/moves/outdoor/start");
}

/* ------------------------------------------------------------ the walk card */

test("Start on a walk card posts outdoor/start and the card itself shows the running time", async () => {
  const now = Date.parse("2026-10-30T10:00:00");
  const booted = await boot({
    now,
    safetySeen: true,
    routes: {
      "/api/ramble/moves/outdoor/start": (body, method, answer) =>
        answer({ startedAt: now - 5 * 60000, sessionKey: "2026-10-30:o:1", entryId: "walk-10" }),
    },
  });
  await flush();

  const walk = cardFor(booted.host, "morning");
  assert.ok(walk, "the walk card is drawn");
  assert.ok(buttonNamed(walk, booted.startLabel), "and it carries Start");
  assert.equal(buttonNamed(walk, booted.doneLabel).disabled, true, "Done waits for a running walk");
  assert.equal(statusOf(walk).textContent, "", "the card's own line is empty while nothing is running");
  assert.equal(statusOf(walk).hasAttribute("hidden"), true, "and it is hidden");

  buttonNamed(walk, booted.startLabel).click();
  await flush();

  const start = startClicks(booted)[0];
  assert.ok(start, "a walk's Start opens the outdoor session");
  assert.deepEqual(start.body, { entryId: "walk-10" }, "with the card's own entry");

  const running = fill("outdoor.running", { minutes: 5 });
  const expected = sentence(running, COPY["outdoor.counts"]);
  assert.equal(expected, "5 min so far. Each full 10 minutes counts toward a card.",
    "the running line and the line under it are two sentences");

  const drawn = cardFor(booted.host, "morning");
  const status = statusOf(drawn);
  assert.ok(status, "the card carries a status line of its own");
  assert.equal(status.textContent, expected, "the running text is ON the card, with the full stop between the lines");
  assert.equal(status.hasAttribute("hidden"), false, "and it is visible");
  assert.match(status.getAttribute("role"), /^status$/, "it is a live region, so a reader hears it change");
  assert.equal(status.getAttribute("aria-live"), "polite");
  assert.ok(drawn.textContent.includes(running), "the card's own text carries the running time");

  assert.equal(/so far Each/.test(drawn.textContent), false, "the two lines never run together on the card");
  assert.equal(/so far Each/.test(booted.get("rb-today-status").textContent), false,
    "nor in the day's own line");

  assert.equal(buttonNamed(drawn, booted.startLabel).disabled, true, "a running walk's Start cannot be pressed twice");
  assert.equal(buttonNamed(drawn, booted.doneLabel).disabled, false, "and its Done is live");
  assert.ok(booted.intervals.some((i) => i.ms === 20000), "the timer keeps refreshing");
});

test("a refused start shows the server's own words in the card, visible", async () => {
  const booted = await boot({
    safetySeen: true,
    routes: {
      "/api/ramble/moves/outdoor/start": (body, method, answer) => answer({ error: "nope" }, 500),
    },
  });
  await flush();

  buttonNamed(cardFor(booted.host, "morning"), booted.startLabel).click();
  await flush();

  const status = statusOf(cardFor(booted.host, "morning"));
  assert.equal(status.textContent, "nope", "the refusal is on the card, not off screen");
  assert.equal(status.hasAttribute("hidden"), false, "and visible, not hidden");
  assert.equal(buttonNamed(cardFor(booted.host, "morning"), booted.startLabel).disabled, false,
    "a refused start leaves Start pressable again");
});

test("a start that fails with no words of its own says the moves were not reachable", async () => {
  const booted = await boot({
    safetySeen: true,
    routes: {
      /* The wire said nothing: no body, no message. */
      "/api/ramble/moves/outdoor/start": () => Promise.reject(new Error("")),
    },
  });
  await flush();

  buttonNamed(cardFor(booted.host, "morning"), booted.startLabel).click();
  await flush();

  const offline = movesText("offline");
  assert.ok(offline.length > 0, "the moves client carries an offline line");
  const status = statusOf(cardFor(booted.host, "morning"));
  assert.equal(status.textContent, offline, "the card says the moves were not reachable");
  assert.equal(status.hasAttribute("hidden"), false, "and it is on screen");
});

test("Done on a running walk posts outdoor/done and the card shows the result line", async () => {
  const now = Date.parse("2026-10-30T10:00:00");
  const booted = await boot({
    now,
    safetySeen: true,
    routes: {
      "/api/ramble/moves/outdoor/start": (body, method, answer) =>
        answer({ startedAt: now - 9 * 60000, sessionKey: "2026-10-30:o:1", entryId: "walk-10" }),
      "/api/ramble/moves/outdoor/done": (body, method, answer) =>
        answer({ minutes: 20, filled: ["morning"], paid: 12, needsBalance: true, walkedNew: true, day: dayFixture() }),
    },
  });
  await flush();

  buttonNamed(cardFor(booted.host, "morning"), booted.startLabel).click();
  await flush();
  buttonNamed(cardFor(booted.host, "morning"), booted.doneLabel).click();
  await flush();

  assert.ok(booted.calls.some((c) => c.method === "POST" && c.url === "/api/ramble/moves/outdoor/done"),
    "a running walk finishes through its own route");
  assert.equal(booted.calls.some((c) => c.method === "POST" && c.url === "/api/ramble/moves/done"), false,
    "and never through the indoor Done");

  const expected = sentence(
    fill("outdoor.result", { minutes: 20, done: 1 }),
    COPY["today.balancing"],
  );
  const status = statusOf(cardFor(booted.host, "morning"));
  assert.equal(status.textContent, expected, "the result and the balancing line are on the card");
  assert.equal(status.hasAttribute("hidden"), false, "and on screen");
  assert.equal(/so far Each/.test(status.textContent), false, "no line runs into the next");
  assert.ok(booted.cleared.length >= 1, "the timer is cleared once the walk is finished");
  assert.equal(booted.get("rb-today-status").textContent, expected, "the day's own line says the same thing");
});

test("a refused start says so on the card that was pressed, and on no other walk card", async () => {
  const booted = await boot({
    safetySeen: true,
    day: twoWalkDay(),
    routes: {
      "/api/ramble/moves/outdoor/start": (body, method, answer) => answer({ error: "nope" }, 500),
    },
  });
  await flush();

  assert.ok(statusOf(cardFor(booted.host, "morning")), "the first walk card carries a status line");
  assert.ok(statusOf(cardFor(booted.host, "midday")), "and so does the second");
  assert.equal(statusOf(cardFor(booted.host, "morning")).getAttribute("data-entry"), WALK.id,
    "each status element names the card's own entry");
  assert.equal(statusOf(cardFor(booted.host, "midday")).getAttribute("data-entry"), OTHER_WALK.id);

  buttonNamed(cardFor(booted.host, "morning"), booted.startLabel).click();
  await flush();

  const failed = statusOf(cardFor(booted.host, "morning"));
  assert.equal(failed.textContent, "nope", "the refusal is on the card that was pressed");
  assert.equal(failed.hasAttribute("hidden"), false, "and visible there");

  const quiet = statusOf(cardFor(booted.host, "midday"));
  assert.equal(quiet.textContent, "", "the other walk card is not made to say it");
  assert.equal(quiet.hasAttribute("hidden"), true, "so its own line stays hidden");
  assert.equal(booted.get("rb-today-status").textContent, "nope",
    "the day's own line still carries the refusal");
});

test("two rapid presses of Start open one walk, not two", async () => {
  const now = Date.parse("2026-10-30T10:00:00");
  const booted = await boot({
    now,
    safetySeen: true,
    routes: {
      "/api/ramble/moves/outdoor/start": (body, method, answer) =>
        answer({ startedAt: now - 60000, sessionKey: "2026-10-30:o:1", entryId: "walk-10" }),
    },
  });
  await flush();

  /* Both presses land before the first answer can: the second one joins the
   * request already on the wire instead of opening a session of its own. */
  const start = buttonNamed(cardFor(booted.host, "morning"), booted.startLabel);
  start.click();
  start.click();
  await flush();

  assert.equal(startClicks(booted).length, 1, "a rapid second press posts nothing");
  assert.equal(booted.calls.filter((c) => c.url === "/api/ramble/moves/outdoor/start").length, 1,
    "and asks the route once however it is read");
});

/* ------------------------------------------------------------- every other card */

test("Start on a card that is not a walk opens the Learn view and its entry", async () => {
  const booted = await boot({ safetySeen: true });
  await flush();

  const card = cardFor(booted.host, "midday");
  card.findAll((node) => node.tagName === "BUTTON")[0].click();
  assert.equal(card.findAll((node) => hasClass(node, "rb-slot-body"))[0].hasAttribute("hidden"), false,
    "the card is open");

  buttonNamed(card, booted.startLabel).click();
  await flush();

  assert.equal(startClicks(booted).length, 0, "a routine never opens an outdoor session");
  assert.ok(booted.calls.some((c) => c.url === "/api/ramble/moves/library/" + ROUTINE.id),
    "its library entry is fetched");
  assert.equal(booted.root.getAttribute("data-view"), "learn", "showLearnView put the Learn view on");
  assert.equal(booted.get("rb-learn-entry-card").hasAttribute("hidden"), false, "the entry card is shown");
  assert.equal(booted.get("rb-entry-title").textContent, ROUTINE.title, "with the entry's own title");
  assert.equal(statusOf(card) , null, "a card that is not a walk carries no walk status line");
});

test("with the safety note unseen, Start on another card opens the note first", async () => {
  const booted = await boot({ safetySeen: false });
  await flush();

  const card = cardFor(booted.host, "midday");
  card.findAll((node) => node.tagName === "BUTTON")[0].click();
  buttonNamed(card, booted.startLabel).click();
  await flush();

  assert.equal(booted.get("rb-safety-sheet").hasAttribute("hidden"), false, "the note is open");
  assert.equal(booted.root.getAttribute("data-view"), "today",
    "and Today still has the screen: showLearnView never ran");
  assert.equal(booted.calls.some((c) => c.url.startsWith("/api/ramble/moves/library/")), false,
    "the entry waits for Got it");
  assert.equal(startClicks(booted).length, 0, "and no walk was started");
});