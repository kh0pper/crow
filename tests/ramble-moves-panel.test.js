/**
 * Moves design Task 8 — the Ramble screens (Today, "something else",
 * Customize, Learn, the flow player and the safety note).
 *
 * Three layers, like the rest of the Ramble tests:
 *   1. the server-rendered panel (panel/ramble.js) — copy, ids, vocabularies,
 *      the figure/moves scripts and the en/es safety note;
 *   2. the client (panel/static/moves.js) run in a vm against a tiny DOM, so
 *      a real click posts the real route with the day the card carries;
 *   3. the player's guidance rules as pure functions (the one-pose "first"
 *      level and its memory prompt).
 *
 * The routes themselves are covered by tests/ramble-moves-routes.test.js; this
 * file pins the wiring those routes depend on, plus the house rule that a
 * panel client script carries no backtick.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, "..");
const PANEL_SRC = () => readFileSync(resolve(ROOT, "bundles/ramble/panel/ramble.js"), "utf8");
const CLIENT_SRC = () => readFileSync(resolve(ROOT, "bundles/ramble/panel/static/moves.js"), "utf8");
const CSS_SRC = () => readFileSync(resolve(ROOT, "bundles/ramble/panel/static/ramble.css"), "utf8");

const { default: panel } = await import("../bundles/ramble/panel/ramble.js");
const { ACTIVITY_KINDS, EQUIPMENT, LIMIT_TAGS } = await import("../bundles/ramble/server/moves/library.js");

async function render(lang) {
  let sent = null;
  const res = { send: (html) => { sent = html; } };
  await panel.handler({ query: {} }, res, {
    db: null,
    layout: ({ content }) => content,
    appRoot: ROOT,
    ...(lang ? { lang } : {}),
  });
  assert.ok(sent, "the handler sent nothing");
  return sent;
}

/* ------------------------------------------------------------ the screens */

test("the panel renders the moves screens, not the old chores", async () => {
  const html = await render("en");

  // "Health", not "Energy", everywhere Ramble names the bar. The wire field
  // stays `energy`; only the label changed.
  assert.ok(html.includes(">Health<"), "the bar is labelled Health");
  assert.equal(/\bEnergy\b/.test(html), false, "no Energy label survives");

  // The chore buttons and their route are gone.
  assert.equal(html.includes('class="rb-chore"'), false, "no chore buttons");
  assert.equal(html.includes('data-kind="feed"'), false, "no chore kinds");
  assert.equal(html.includes(">Feed<"), false);
  assert.equal(html.includes(">Preen<"), false);
  assert.equal(html.includes(">Play<"), false);
  assert.equal(html.includes("/api/ramble/pet/chore"), false, "the client must not call the removed route");

  // The Today card: challenge actions, the self-checking step goal, the streak.
  for (const id of ["rb-today", "rb-challenge-title", "rb-challenge-start", "rb-challenge-done", "rb-challenge-swap",
    "rb-goal-meter", "rb-goal-num", "rb-goal-max", "rb-goal-line", "rb-streak-line"]) {
    assert.ok(html.includes('id="' + id + '"'), id);
  }
  for (const label of ["Start", "Done", "Swap"]) {
    assert.match(html, new RegExp("<button[^>]*>(?:" + label + ")</button>"), label + " is a real button");
  }

  // "I did something else": text, the parse button, and the three fallbacks.
  for (const id of ["rb-something-else", "rb-else-sheet", "rb-else-text", "rb-else-say", "rb-else-read",
    "rb-else-reading", "rb-else-pickers", "rb-else-activity", "rb-else-minutes", "rb-else-effort", "rb-else-log"]) {
    assert.ok(html.includes('id="' + id + '"'), id);
  }
  assert.match(html, /id="rb-else-say"[^>]*hidden/, "Say it instead starts hidden unless the page has a dictation hook");

  // Customize: every fixed-vocabulary value as a plain-named checkbox, the
  // level slider, the weather switch, and a calendar that says Later.
  assert.ok(html.includes('id="rb-customize-sheet"'));
  assert.ok(html.includes('id="rb-pref-on"'));
  assert.ok(html.includes('id="rb-pref-level"'));
  assert.ok(html.includes('id="rb-pref-weather"'));
  assert.match(html, /id="rb-pref-calendar"[^>]*disabled[^>]*>Later</, "the calendar is shown disabled with Later");
  for (const value of ACTIVITY_KINDS) {
    assert.ok(html.includes('class="rb-pref-kind" data-value="' + value + '"'), "kind checkbox: " + value);
  }
  for (const value of EQUIPMENT) {
    assert.ok(html.includes('class="rb-pref-equipment" data-value="' + value + '"'), "equipment checkbox: " + value);
  }
  for (const value of LIMIT_TAGS) {
    assert.ok(html.includes('class="rb-pref-limit" data-value="' + value + '"'), "limit checkbox: " + value);
  }
  assert.ok(html.includes(">Lower back<"), "limit tags read as plain names");

  // Learn: the list, the friendly empty state, an entry page and the player.
  assert.ok(html.includes('data-for="learn"'), "learn is a fifth view");
  for (const id of ["rb-learn-btn", "rb-learn-list", "rb-learn-empty", "rb-learn-entry-card", "rb-entry-title",
    "rb-entry-figure", "rb-entry-body", "rb-flow", "rb-flow-figure", "rb-flow-name", "rb-flow-cues",
    "rb-flow-pause", "rb-flow-half", "rb-flow-step", "rb-flow-ask", "rb-flow-smooth", "rb-flow-help"]) {
    assert.ok(html.includes('id="' + id + '"'), id);
  }
  assert.ok(html.includes("The exercise library is being written. Check back soon."),
    "an empty library says so, in words");

  // The one-time safety note, and both assets in the right order.
  assert.ok(html.includes('id="rb-safety-sheet"'));
  assert.ok(html.includes("This is general wellness, not medical advice."));
  assert.ok(html.includes("Stop if anything hurts"));
  assert.ok(html.includes("/ramble/static/figure.js"), "the figure engine is served to the browser");
  assert.ok(html.includes("/ramble/static/moves.js"), "the moves client is loaded");
  assert.ok(html.indexOf("/ramble/static/figure.js") < html.indexOf("/ramble/static/moves.js"),
    "the engine loads before the client that draws with it");

  assert.equal(/[\u{1F300}-\u{1FAFF}]/u.test(html), false, "no emoji anywhere in the panel markup");
});

test("the panel is bilingual: Spanish copy for the new screens, including the safety note", async () => {
  const html = await render("es");
  assert.ok(html.includes('data-lang="es"'));
  assert.ok(html.includes(">Salud<"), "Health is Salud");
  assert.ok(html.includes(">Hoy<"), "Today is Hoy");
  assert.ok(html.includes("Hice otra cosa"));
  assert.ok(html.includes("Personalizar"));
  assert.ok(html.includes("La biblioteca de ejercicios se est&aacute; escribiendo.") ||
            html.includes("La biblioteca de ejercicios se est\u00e1 escribiendo."));
  assert.ok(html.includes("Esto es bienestar general, no consejo m\u00e9dico."), "the safety note is in Spanish too");
  assert.ok(html.includes("Detente si algo duele"));
  assert.ok(html.includes("Entendido"));
});

test("the client script has zero backticks", () => {
  const src = CLIENT_SRC();
  assert.equal((src.match(/`/g) || []).length, 0,
    "panel client scripts must contain no backtick: the tooling treats one as its own delimiter");
  assert.ok(src.length > 1000, "the client looks empty");
});

test("the learn view has a CSS rule, or showView('learn') paints nothing", () => {
  const css = CSS_SRC();
  assert.match(css, /\[data-view="learn"\]\s+\.rb-view\[data-for="learn"\]/);
  assert.match(css, /--rb-tap:\s*44px/);
  assert.match(css, /\.rb-btn\s*\{[^}]*min-height:\s*var\(--rb-tap\)/, "buttons stay at least 44 px tall");
});

test("the figure route is registered above the static catch-all and reads server/moves/figure.cjs", () => {
  const routes = readFileSync(resolve(ROOT, "bundles/ramble/panel/routes.js"), "utf8");
  const figureAt = routes.indexOf('"/ramble/static/figure.js"');
  const catchAllAt = routes.indexOf('"/ramble/static/:file"');
  assert.ok(figureAt > 0, "the figure route exists");
  assert.ok(catchAllAt > figureAt, "it must be registered before the :file catch-all");
  assert.ok(routes.includes('join(SERVER_DIR, "moves", "figure.cjs")'), "it serves the shared engine, not a copy");
  assert.ok(routes.includes("flowLevel(db, entry.id)"), "a flow's detail response carries the server's level");
  assert.equal(routes.includes("/api/ramble/pet/chore"), false, "the chore route is gone");
});

/* ------------------------------------------------------ the client in a vm */

class FakeEl {
  constructor(id) {
    this.id = id;
    this.attrs = Object.create(null);
    this.listeners = Object.create(null);
    this.children = [];
    this.style = {};
    this.textContent = "";
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.options = [];
  }
  addEventListener(type, fn) { (this.listeners[type] || (this.listeners[type] = [])).push(fn); }
  removeEventListener() {}
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
  appendChild(child) { this.children.push(child); return child; }
  removeChild(child) { this.children = this.children.filter((c) => c !== child); }
  querySelectorAll() { return []; }
  focus() {}
  blur() {}
  remove() {}
  closest() { return null; }
  click() { (this.listeners.click || []).slice().forEach((fn) => fn({ target: this })); }
}

const TODAY = {
  challenge: {
    day: "2026-10-30",
    entry: { id: "walk-10", kind: "walk", title: "A ten minute walk", minutes: 10, level: 1, activity: "walk" },
    reasons: [], why: "A good way to break up the day.", done: false, off: false, swap: 0,
  },
  health: { energy: 60, max: 100, mood: "happy" },
  steps: { day: "2026-10-30", goal: 6000, steps: 1200, goal_met: false, walked: false },
  streak: { days: 3, nextHeartAt: 7, todayGood: false },
};

const PREFS = { prefs: { on: true, kinds: [], equipment: ["none"], limits: [], level: 2, weather: true } };

function bootMoves(beforeRun) {
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) els.set(id, new FakeEl(id));
    return els.get(id);
  };
  const calls = [];
  const docListeners = Object.create(null);

  function json(body, status = 200) {
    return Promise.resolve({ status, ok: status < 400, json: () => Promise.resolve(body) });
  }

  const fetchStub = (url, options) => {
    const opts = options || {};
    const method = opts.method || "GET";
    const body = typeof opts.body === "string" ? JSON.parse(opts.body) : opts.body;
    calls.push({ url: String(url), method, body });
    const u = String(url);
    if (u === "/api/ramble/moves/today") return json(TODAY);
    if (u === "/api/ramble/moves/done") return json({ ...TODAY, challenge: { ...TODAY.challenge, done: true }, done: { already: false, paid: 8, points: 8, day: "2026-10-30" } });
    if (u === "/api/ramble/moves/swap") return json({ ...TODAY, challenge: { ...TODAY.challenge, swap: 1 } });
    if (u === "/api/ramble/moves/parse") return json({ ok: false, reason: "no_model" });
    if (u === "/api/ramble/moves/log") return json({ ...TODAY, log: { paid: 5, points: 5, already: false } });
    if (u === "/api/ramble/moves/prefs") return json(PREFS);
    if (u === "/api/ramble/moves/library") return json({ entries: [] });
    return json({ entry: null }, 404);
  };

  const sandbox = {
    console,
    document: {
      hidden: false,
      getElementById: el,
      createElement: (tag) => new FakeEl(tag),
      createElementNS: (ns, tag) => new FakeEl(tag),
      querySelectorAll: () => [],
      addEventListener: (type, fn) => { (docListeners[type] || (docListeners[type] = [])).push(fn); },
    },
    fetch: fetchStub,
    setTimeout,
    clearTimeout,
    Promise,
    Date,
    JSON,
    Object,
    Array,
    Math,
    Number,
    String,
    isFinite,
    encodeURIComponent,
    scrollTo() {},
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
    localStorage: {
      store: Object.create(null),
      getItem(k) { return Object.prototype.hasOwnProperty.call(this.store, k) ? this.store[k] : null; },
      setItem(k, v) { this.store[k] = String(v); },
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  if (typeof beforeRun === "function") beforeRun(sandbox);

  const root = el("ramble");
  root.setAttribute("data-lang", "en");
  const script = new vm.Script(CLIENT_SRC(), { filename: "moves.js" });
  script.runInContext(sandbox);
  return { el, calls, sandbox, root, docListeners };
}

async function flush() {
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r));
}

test("a Done click posts /moves/done with the challenge's own day", async () => {
  const { el, calls, sandbox } = bootMoves();
  sandbox.localStorage.setItem("ramble.moves.safetySeen", "1");
  await flush();

  assert.equal(el("rb-challenge-title").textContent, "A ten minute walk", "the card paints the challenge");
  assert.equal(el("rb-goal-num").textContent, "1,200", "the step goal reads the snapshot");
  assert.equal(el("rb-streak-line").textContent, "3 days \u00b7 4 more to a heart.", "the streak is spelled out");

  el("rb-challenge-done").click();
  await flush();

  const post = calls.find((c) => c.method === "POST" && c.url === "/api/ramble/moves/done");
  assert.ok(post, "the Done button must post /api/ramble/moves/done");
  assert.deepEqual(post.body, { day: "2026-10-30" }, "the day comes from the card, never a fresh local day");
  assert.equal(el("rb-challenge-done").disabled, true, "a Done stays disabled after it lands");
});

test("a parse that answers no_model shows the three manual pickers", async () => {
  const { el, calls, sandbox } = bootMoves();
  sandbox.localStorage.setItem("ramble.moves.safetySeen", "1");
  await flush();

  el("rb-something-else").click();
  el("rb-else-text").value = "a bike ride with a friend";
  el("rb-else-read").click();
  await flush();

  assert.ok(calls.some((c) => c.url === "/api/ramble/moves/parse"), "reading it calls the parse route");
  assert.equal(el("rb-else-pickers").hasAttribute("hidden"), false, "no model: the pickers are shown");
  assert.equal(el("rb-else-reading").hasAttribute("hidden"), true, "and there is no parsed triple to show");
  assert.match(el("rb-else-status").textContent, /pick/i);
});

test("with no dictation hook on the page, Say it instead stays hidden", async () => {
  const without = bootMoves();
  await flush();
  assert.equal(without.el("rb-else-say").hasAttribute("hidden"), true);

  const withHook = bootMoves((sandbox) => { sandbox.crowDictation = function () {}; });
  await flush();
  assert.equal(withHook.el("rb-else-say").hasAttribute("hidden"), false, "a dictation hook reveals the button");
});

test("guidance 'first' plays one pose and asks the memory question", () => {
  const { sandbox } = bootMoves();
  const moves = sandbox.window.RambleMoves;
  assert.ok(moves, "the client exposes its pure helpers");

  const steps = [
    { id: "a", name: "Mountain", holdSeconds: 20 },
    { id: "b", name: "Fold", holdSeconds: 20 },
    { id: "c", name: "Twist", holdSeconds: 20 },
  ];
  assert.deepEqual([...moves.flowFrames("first", steps)].map((s) => s.id), ["a"],
    "the first level shows ONLY the first pose");
  assert.equal(moves.guidance("first").memoryPrompt, true, "then it asks Done from memory?");
  assert.equal(moves.guidance("first").name, true, "the first pose is still named");
  assert.equal(moves.guidance("first").cues, false, "but its cues are not shown");
  assert.deepEqual([...moves.flowFrames("full", steps)].map((s) => s.id), ["a", "b", "c"]);
  assert.deepEqual([...moves.flowFrames("names", steps)].map((s) => s.id), ["a", "b", "c"]);
  assert.equal(moves.guidance("full").cues, true, "full guidance shows cues");
  assert.equal(moves.guidance("names").cues, false, "names shows no cues");
  assert.equal(moves.guidance("memory").name, false, "memory shows the figure alone");
  assert.equal(moves.flowFrames("first", []).length, 0);

  assert.equal(moves.parseFallback("no_model"), true);
  assert.equal(moves.parseFallback("unclear"), true);
  assert.equal(moves.parseFallback("ok"), false);
  assert.equal(moves.transitionMs, 1200, "transitions are 1.2 s, doubled at half speed");
});