/**
 * Moves design Task 8 — the Ramble screens (Today, "something else",
 * Customize, Learn, the safety note, and the hand-off to the player).
 *
 * Four layers, like the rest of the Ramble tests:
 *   1. the server-rendered panel (panel/ramble.js) — copy, ids, vocabularies,
 *      the figure/session/player scripts, the player's Start label and the en/es
 *      safety note;
 *   2. the client (panel/static/moves.js) run in a vm against a tiny DOM, so
 *      a real click posts the real route with the day the card carries, and a
 *      chunk opened from Today mounts the player on the day's card;
 *   3. the player's guidance rules as pure functions (the one-pose "first"
 *      level and its memory prompt);
 *   4. the house rules both scripts keep: classic scripts, no backtick.
 *
 * The routes themselves are covered by tests/ramble-moves-routes.test.js and
 * the player itself by tests/ramble-moves-player.test.js; this file pins the
 * wiring those depend on.
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
const PLAYER_SRC = () => readFileSync(resolve(ROOT, "bundles/ramble/panel/static/player.js"), "utf8");
const CSS_SRC = () => readFileSync(resolve(ROOT, "bundles/ramble/panel/static/ramble.css"), "utf8");
const AUDIO_SRC = () => readFileSync(resolve(ROOT, "bundles/ramble/panel/static/player-audio.js"), "utf8");
const PLAYER_CSS_SRC = () => readFileSync(resolve(ROOT, "bundles/ramble/panel/static/player.css"), "utf8");

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
    "rb-entry-figure", "rb-entry-body", "rb-player"]) {
    assert.ok(html.includes('id="' + id + '"'), id);
  }
  // The old flow player's boxes are gone: the player draws its own screen.
  assert.equal(html.includes("rb-flow"), false, "no rb-flow ids survive");
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

test("the client and the player have zero backticks", () => {
  for (const [label, src] of [
    ["moves.js", CLIENT_SRC()],
    ["player.js", PLAYER_SRC()],
    ["player-audio.js", AUDIO_SRC()],
    ["player.css", PLAYER_CSS_SRC()],
  ]) {
    assert.equal((src.match(/`/g) || []).length, 0,
      label + " must contain no backtick: panel client scripts must not carry one, the tooling treats it as its own delimiter");
    assert.ok(src.length > 100, label + " looks empty");
  }
});

test("the client fetches the spoken lines from their own route, once per page", () => {
  const src = CLIENT_SRC();
  assert.ok(src.includes("/api/ramble/moves/voice"), "the lines come over the wire, never baked into the panel");
  assert.ok(src.includes("function loadVoiceLines("), "one helper owns that fetch");
  assert.ok(src.includes("function loadPlayerCopy("), "and the copy keeps its own");
});

test("the panel loads the figure, the session and the player engines before the client", async () => {
  const html = await render("en");
  const at = (needle) => {
    const index = html.indexOf(needle);
    assert.ok(index > 0, needle + " is in the panel");
    return index;
  };
  assert.ok(at("/ramble/static/figure.js") < at("/ramble/static/session.js"),
    "the figure engine loads before the session it draws for");
  assert.ok(at("/ramble/static/session.js") < at("/ramble/static/player.js"),
    "the session engine loads before the player that compiles with it");
  assert.ok(at("/ramble/static/player-audio.js") < at("/ramble/static/player.js"),
    "the voice is defined before the player that reports to it");
  assert.ok(at("/ramble/static/player.js") < at("/ramble/static/moves.js"),
    "the player is defined before the client mounts it");
  assert.ok(at("/ramble/static/ramble.css") < at("/ramble/static/player.css"),
    "the player's stylesheet follows the panel's own");
  assert.ok(html.includes('<link rel="stylesheet" href="/ramble/static/player.css">'),
    "the player stylesheet is linked");
});

/** The panel escapes the Start label for a double-quoted attribute; this is
 * the browser's half of that round trip. */
function attrText(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

test("the player host carries the page's own Start label, not a copy table", async () => {
  const hostTag = (html) => {
    const tag = /<div id="rb-player"[^>]*>/.exec(html);
    assert.ok(tag, "the player host is a div with an id");
    return tag[0];
  };
  const startOf = (tag) => {
    const attr = /data-start="([^"]*)"/.exec(tag);
    assert.ok(attr, "the host carries the page's Start label as data-start");
    const label = attrText(attr[1]);
    assert.ok(label.length > 0, "the Start label is not empty");
    return label;
  };

  const enTag = hostTag(await render("en"));
  assert.equal(/data-copy=/.test(enTag), false, "the copy table is not baked into the page any more");
  assert.equal(startOf(enTag), "Start", "the page's own Start label rides on the host");

  // Spanish has no player table of its own, but its Start is its own word.
  const esTag = hostTag(await render("es"));
  assert.equal(/data-copy=/.test(esTag), false, "nor in Spanish");
  assert.equal(startOf(esTag), "Empezar", "but Start is the page's own word");
});

test("the panel reads no bundle file: the player's words come from the routes", () => {
  const src = PANEL_SRC();
  assert.equal(src.includes("player-copy.en.json"), false, "a single-file panel cannot see server/moves");
  assert.equal(src.includes("readFileSync"), false, "the panel reads no file from the bundle");
  assert.ok(CLIENT_SRC().includes("/api/ramble/moves/copy"), "the client fetches the table from its route");
});

test("the old flow player is gone from the client", () => {
  const src = CLIENT_SRC();
  for (const name of ["createPlayer", "startFlow", "loadFlowPoses", "reportFlow"]) {
    assert.equal(src.includes(name), false, name + " must not survive in moves.js");
  }
  assert.ok(src.includes("RamblePlayer.mount"), "the client mounts the shared player");
  assert.ok(src.includes("flowFrames") && src.includes("parseFallback"), "the pure helpers stay exported");
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

/* The one entry the detail route answers with: today's challenge, a walk of ten
 * minutes, so it is a chunk the player can take. */
const WALK_ENTRY = {
  id: "walk-10",
  kind: "walk",
  title: "A ten minute walk",
  minutes: 10,
  steps: ["Walk at a pace you can talk at."],
};

/* An entry that keeps the page instead of the player: an exercise, with the
 * step objects and the shorthand tags the detail route sends. */
const CORE_ENTRY = {
  id: "hip-lift",
  kind: "exercise",
  title: "Hip lift",
  steps: ["Lie on your back.", { text: "Lift your hips.", cue: "Up", say: "Lift", at: 0 }],
  works: ["Glutes", "Hips", "Core"],
  mistakes: ["Arching the back.", "Holding your breath."],
  skipIf: ["lowerback", "hip"],
};

function bootMoves(beforeRun, search, detail) {
  const answered = detail || WALK_ENTRY;
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
    if (u === "/api/ramble/moves/copy") return json({ copy: { "player.pause": "Pause", "player.next": "Next: {name}" } });
    if (u === "/api/ramble/moves/voice") return json({ lines: { paused: "Paused.", resume: "Carrying on." } });
    if (u === "/api/ramble/moves/library") return json({ entries: [answered] });
    if (u === "/api/ramble/moves/library/" + answered.id) return json({ entry: answered });
    if (u === "/api/ramble/moves/start") return json({ cardKey: "2026-10-30:day", startedAt: 1 });
    if (u === "/api/ramble/moves/progress") return json({ progress: { accepted: 60, done: false, paid: 0 } });
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
  sandbox.location = { pathname: "/dashboard/ramble", search: search || "", hash: "" };
  sandbox.history = { state: null, replaced: [], replaceState(st, t, url) { this.replaced.push(url); } };
  sandbox.URLSearchParams = URLSearchParams;
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
// For You links here with ?moves=start|log|prefs; the panel must act on it.
// A player with no hatched bird cannot reach the pet view, so each of these
// must work straight from the moves client, from any view.

test("?moves=start opens the day's challenge in the Learn view, with no bird needed, and cleans the URL", async () => {
  const { el, calls, sandbox, root } = bootMoves((sb) => sb.localStorage.setItem("ramble.moves.safetySeen", "1"), "?moves=start");
  await flush();
  assert.equal(root.getAttribute("data-view"), "learn", "it left the map for the Learn view");
  assert.ok(calls.some((c) => c.url === "/api/ramble/moves/library/walk-10"), "it opened today's entry");
  assert.deepEqual(sandbox.history.replaced, ["/dashboard/ramble"], "the parameter is removed so a reload does not re-fire");
});

test("?moves=start shows the safety note first when it has not been seen", async () => {
  const { el, calls, root } = bootMoves(null, "?moves=start");
  await flush();
  assert.equal(el("rb-safety-sheet").hasAttribute("hidden"), false, "the safety note opens first");
  assert.equal(calls.some((c) => c.url.startsWith("/api/ramble/moves/library/")), false, "the entry waits for Got it");
  el("rb-safety-gotit").click();
  await flush();
  assert.equal(root.getAttribute("data-view"), "learn");
});

test("?moves=log opens the something-else sheet; ?moves=prefs opens Customize", async () => {
  const log = bootMoves(null, "?moves=log&x=1");
  await flush();
  assert.equal(log.el("rb-else-sheet").hasAttribute("hidden"), false);
  assert.deepEqual(log.sandbox.history.replaced, ["/dashboard/ramble?x=1"], "other parameters survive");

  const prefs = bootMoves(null, "?moves=prefs");
  await flush();
  assert.equal(prefs.el("rb-customize-sheet").hasAttribute("hidden"), false);
  assert.ok(prefs.calls.filter((c) => c.url === "/api/ramble/moves/prefs").length >= 1, "the prefs are loaded");
});

test("no or unknown moves parameter changes nothing", async () => {
  const none = bootMoves(null, "");
  await flush();
  assert.equal(none.root.getAttribute("data-view"), null);
  assert.deepEqual(none.sandbox.history.replaced, []);
  const odd = bootMoves(null, "?moves=bogus");
  await flush();
  assert.equal(odd.root.getAttribute("data-view"), null);
  assert.equal(odd.calls.some((c) => c.url.startsWith("/api/ramble/moves/library/")), false, "nothing was opened");
});

/* --------------------------------------- the hand-off to the player (7.5) */

test("a chunk opened from Today mounts the player on the day's card", async () => {
  const mounted = { count: 0 };
  const booted = bootMoves((sb) => {
    sb.localStorage.setItem("ramble.moves.safetySeen", "1");
    sb.RamblePlayer = {
      mount(host, opts) {
        mounted.count += 1;
        mounted.host = host;
        mounted.opts = opts;
        return { destroy() { mounted.destroyed = true; }, state() { return {}; } };
      },
    };
  }, "?moves=start");
  booted.el("rb-player").setAttribute("data-start", "Start");
  await flush();

  assert.equal(mounted.count, 1, "the player was mounted once");
  assert.equal(mounted.host, booted.el("rb-player"), "it is mounted on #rb-player");
  assert.deepEqual(JSON.parse(JSON.stringify(mounted.opts.chain)), [{ chunkId: "walk-10" }],
    "the whole session is the chunk that was opened");
  assert.equal(mounted.opts.cardSlot, "day", "Today's Start names the day's card");
  assert.ok(mounted.opts.library.some((entry) => entry && entry.id === "walk-10"),
    "the library carries the chunk itself, so its poses can be drawn");
  assert.equal(mounted.opts.copy["player.pause"], "Pause", "the copy is fetched from /api/ramble/moves/copy");
  assert.equal(mounted.opts.copy.start, "Start", "and the page's Start label rides along from data-start");
  assert.equal(mounted.opts.guidance, "full", "the level the detail route answered with is the one played");
  assert.equal(typeof mounted.opts.post, "function");
  assert.equal(typeof mounted.opts.start, "function");
  assert.equal(typeof mounted.opts.onEvent, "function");
  assert.equal(booted.el("rb-player").hasAttribute("hidden"), false, "the player's screen is shown");
  assert.equal(booted.el("rb-entry-body").hasAttribute("hidden"), true, "the entry's static steps step aside");

  await mounted.opts.start({ cardKey: "day", entryId: "walk-10", chain: [{ chunkId: "walk-10" }] });
  assert.ok(booted.calls.some((c) => c.method === "POST" && c.url === "/api/ramble/moves/start"),
    "the player's start posts /api/ramble/moves/start");

  const answer = await mounted.opts.post({ cardKey: "2026-10-30:day", chunkIndex: 0, entryId: "walk-10", activeSeconds: 60 });
  assert.ok(booted.calls.some((c) => c.method === "POST" && c.url === "/api/ramble/moves/progress"),
    "the player's report posts /api/ramble/moves/progress");
  assert.equal(answer.progress.accepted, 60, "jsonFetch's answer reaches the player as it came");
});

test("a Learn-page open passes no card slot", async () => {
  const mounted = { count: 0 };
  const booted = bootMoves((sb) => {
    sb.RamblePlayer = {
      mount(host, opts) {
        mounted.count += 1;
        mounted.opts = opts;
        return { destroy() {}, state() { return {}; } };
      },
    };
  });
  await flush();

  assert.equal(mounted.count, 0, "nothing opens by itself");
  const list = booted.el("rb-learn-list");
  const row = list.children.find((child) => child.listeners && child.listeners.click);
  assert.ok(row, "the Learn list has a row for the one entry");
  row.click();
  await flush();

  assert.equal(mounted.count, 1, "the row opened the entry in the player");
  assert.equal(mounted.opts.cardSlot, undefined, "a Learn-page open names no card slot");
  assert.deepEqual(JSON.parse(JSON.stringify(mounted.opts.chain)), [{ chunkId: "walk-10" }]);
  assert.equal(booted.sandbox.window.RambleMoves.transitionMs, 1200, "the pure helpers are still exported");
});

/* ------------------------------------------------- the voice a chunk gets */

test("the mounted player is given the voice, fed by the lines route, and every step reaches it", async () => {
  const voice = { attaches: [], heard: [] };
  const booted = bootMoves((sb) => {
    sb.localStorage.setItem("ramble.moves.safetySeen", "1");
    sb.RamblePlayer = {
      mount(host, opts) {
        voice.opts = opts;
        return { destroy() {}, state() { return {}; } };
      },
    };
    sb.RamblePlayerAudio = {
      defaultSpeech(win) { voice.speechFrom = win && win.document; return null; },
      defaultAudio(win) { voice.audioFrom = win && win.document; return null; },
      attach(player, opts) {
        assert.equal(player, null, "the voice is attached before there is a player to give it");
        voice.attaches.push(opts);
        return {
          onEvent(ev) { voice.heard.push(ev.type === "segment" ? "segment:" + ev.index : ev.type); },
          destroy() { voice.destroyed = true; },
        };
      },
    };
  }, "?moves=start");
  booted.el("rb-player").setAttribute("data-start", "Start");
  await flush();

  assert.equal(voice.attaches.length, 1, "one voice per mount");
  const opts = voice.attaches[0];
  assert.equal(opts.lines.paused, "Paused.", "the lines are the ones /api/ramble/moves/voice answered");
  assert.equal(opts.copy["player.pause"], "Pause", "the copy is the page's own table");
  assert.equal(opts.copy.start, "Start");
  assert.equal(opts.guidance, "full", "the voice plays the level the player plays");
  assert.equal(opts.doc, booted.sandbox.document);
  assert.equal(voice.speechFrom, booted.sandbox.document, "the platform's own speech is read from the window");
  assert.equal(voice.audioFrom, booted.sandbox.document, "and its own tone factory");
  assert.equal(booted.calls.filter((c) => c.url === "/api/ramble/moves/voice").length, 1,
    "the lines are fetched once per page");

  /* The voice's controls live in a slot of their own, put on the player's host
   * once the player has built its screen there. */
  assert.notEqual(opts.host, booted.el("rb-player"));
  assert.equal(booted.el("rb-player").children.indexOf(opts.host) >= 0, true,
    "the slot is on the player's host");

  /* Every step the player reports reaches the voice. */
  voice.opts.onEvent({ type: "segment", index: 0 });
  voice.opts.onEvent({ type: "pause" });
  assert.deepEqual(voice.heard, ["segment:0", "pause"]);
});

test("leaving the player takes the voice down with it", async () => {
  const voice = { attaches: 0, destroyed: 0 };
  const booted = bootMoves((sb) => {
    sb.localStorage.setItem("ramble.moves.safetySeen", "1");
    sb.RamblePlayer = { mount() { return { destroy() {}, state() { return {}; } }; } };
    sb.RamblePlayerAudio = {
      attach(player, opts) {
        voice.attaches += 1;
        voice.slot = opts.host;
        return { onEvent() {}, destroy() { voice.destroyed += 1; } };
      },
    };
  }, "?moves=start");
  await flush();
  assert.equal(voice.attaches, 1);

  booted.el("rb-learn-back").click();

  assert.equal(voice.destroyed, 1, "the voice is destroyed with the player it spoke for");
  assert.equal(booted.el("rb-player").hasAttribute("hidden"), true, "and the player's host goes away");
});

test("a voice script that throws on attach leaves the player mounted and the page silent", async () => {
  const mounted = { count: 0 };
  const booted = bootMoves((sb) => {
    sb.localStorage.setItem("ramble.moves.safetySeen", "1");
    sb.RamblePlayerAudio = {
      defaultSpeech() { return null; },
      defaultAudio() { return null; },
      attach() { throw new Error("no voice here"); },
    };
    sb.RamblePlayer = {
      mount(host, opts) {
        mounted.count += 1;
        mounted.opts = opts;
        return { destroy() {}, state() { return {}; } };
      },
    };
  }, "?moves=start");
  booted.el("rb-player").setAttribute("data-start", "Start");
  await flush();

  assert.equal(mounted.count, 1, "the player mounts anyway");
  assert.equal(booted.el("rb-player").hasAttribute("hidden"), false, "and its screen is on show");
  assert.equal(typeof mounted.opts.onEvent, "function");
  assert.doesNotThrow(() => mounted.opts.onEvent({ type: "segment", index: 0 }));
  assert.doesNotThrow(() => mounted.opts.onEvent({ type: "pause" }));
});

test("a voice that throws on a step does not take the session with it", async () => {
  const mounted = { count: 0 };
  const booted = bootMoves((sb) => {
    sb.localStorage.setItem("ramble.moves.safetySeen", "1");
    sb.RamblePlayerAudio = {
      attach() {
        return { onEvent() { throw new Error("voice trouble"); }, destroy() {} };
      },
    };
    sb.RamblePlayer = {
      mount(host, opts) {
        mounted.count += 1;
        mounted.opts = opts;
        return { destroy() {}, state() { return {}; } };
      },
    };
  }, "?moves=start");
  await flush();
  assert.equal(mounted.count, 1);
  assert.doesNotThrow(() => mounted.opts.onEvent({ type: "segment", index: 0 }));
  assert.doesNotThrow(() => mounted.opts.onEvent({ type: "ended" }));
});

/* ---------------------------------------------- the fixes from the review */

test("fix: the client puts the player host on screen before it mounts, and names a narrow layout", () => {
  const src = CLIENT_SRC();
  const from = src.indexOf("function mountPlayer(");
  const to = src.indexOf("function openPlayer(");
  assert.ok(from > 0 && to > from, "mountPlayer sits where the client keeps it");
  const body = src.slice(from, to);

  const shownAt = body.indexOf("setHidden(host, false)");
  const mountAt = body.indexOf("Player.mount(host");
  assert.ok(shownAt > 0, "the mount unhides the host");
  assert.ok(mountAt > 0, "and mounts the player on it");
  assert.ok(shownAt < mountAt, "the host is on screen before its width is read and the player mounted");
  assert.ok(body.indexOf("clientWidth") > shownAt, "the width is read once the host is on screen");
  assert.ok(body.includes('options.layout = "phone"'), "a narrow or unmeasured host is played as a phone");
  assert.equal(/options\.layout = "(kiosk|class)"/.test(body), false,
    "a wide host is left to the player to decide");

  assert.ok(src.includes("err.status = res.status"), "a failed route answer carries its status to the caller");
});

/* ---------------------------------------- the entry page's lists (detail) */

/** Every string a FakeEl tree holds, its own and its children's. */
function textsIn(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (typeof node.textContent === "string" && node.textContent !== "") out.push(node.textContent);
  const kids = Array.isArray(node.children) ? node.children : [];
  kids.forEach((kid) => textsIn(kid, out));
  return out;
}

/** The titled blocks of an entry body: the title and the item elements after it. */
function entryBlocks(host) {
  return host.children.map((row) => {
    const txt = row && row.children ? row.children[0] : null;
    if (!txt || !Array.isArray(txt.children) || txt.children.length === 0) return null;
    return { title: txt.children[0].textContent, items: txt.children.slice(1) };
  }).filter(Boolean);
}

function blockNamed(blocks, title) {
  const block = blocks.find((b) => b.title === title);
  assert.ok(block, "the entry body has a " + title + " block");
  return block;
}

test("a step object and every list item read as their own line on the entry page", async () => {
  const booted = bootMoves(null, "", CORE_ENTRY);
  await flush();

  booted.el("rb-learn-btn").click();
  await flush();
  const row = booted.el("rb-learn-list").children.find((child) => child.listeners && child.listeners.click);
  assert.ok(row, "the Learn list has a row for the entry");
  row.click();
  await flush();

  const body = booted.el("rb-entry-body");
  const texts = textsIn(body);
  assert.ok(texts.length > 0, "the entry page drew its lists");
  assert.equal(texts.some((txt) => txt.includes("[object Object]")), false,
    "no list item prints an object as its own string");

  const blocks = entryBlocks(body);
  assert.deepEqual(blockNamed(blocks, "Steps").items.map((i) => i.textContent),
    ["Lie on your back.", "Lift your hips."], "a step object contributes its text, one item each");
  assert.deepEqual(blockNamed(blocks, "Works").items.map((i) => i.textContent),
    ["Glutes", "Hips", "Core"], "one item per work, never run together");
  assert.equal(blockNamed(blocks, "Common mistakes").items.length, 2, "one item per mistake");

  const skip = blockNamed(blocks, "Skip if").items;
  assert.equal(skip.length, 2, "one element per skip-if tag");
  assert.equal(skip.some((i) => i.textContent.includes("[object Object]")), false,
    "the skip-if tags read as their own words");
});

test("each entry-page list item is styled onto a line of its own", () => {
  assert.match(CSS_SRC(), /#ramble \.rb-step-txt > \.rb-fine\s*\{[^}]*display:\s*block/,
    "the list items are block elements, so they never run together");
});
