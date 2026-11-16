/**
 * The Frigate panel's live-view countdown (panel/frigate.js).
 *
 * Why these assertions: the countdown used to be a flat two minutes from the click, so a viewer
 * who joined a session already running was told it ended in 120 s while the server ended it 30 s
 * later. A clean end of a multipart `<img>` fires no onerror, so the page then sat on a frozen
 * frame with a countdown that never ran out. The client therefore asks /status: once about a
 * second after the stream starts, then every ten seconds while it plays. The server's
 * remaining_seconds replaces the local count (a late viewer sees what is left), and a later
 * answer of 0 ends the view with the usual line.
 *
 * The panel's client is a template literal inside panel/frigate.js, so these run the real script
 * string in a small browser stand-in: a document that records its listeners, the player elements a
 * page really renders, hand-fired timers and a stubbed fetch.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const panel = (await import("../bundles/frigate/panel/frigate.js")).default;

const SCRATCH_HOME = mkdtempSync(join(tmpdir(), "crow-frigate-countdown-home-"));
const ENV_KEYS = [
  "CROW_HOME",
  "FRIGATE_URL",
  "FRIGATE_UI_URL",
  "FRIGATE_USER",
  "FRIGATE_PASSWORD",
  "FRIGATE_SNAPSHOT_DIR",
  "FRIGATE_LIVE_SOURCES",
];
const SAVED_ENV = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

// A CROW_HOME with no installed bundle, so the panel reads this checkout's own client.
process.env.CROW_HOME = SCRATCH_HOME;
process.env.FRIGATE_URL = "http://frigate.invalid:8971";
delete process.env.FRIGATE_UI_URL;
delete process.env.FRIGATE_USER;
delete process.env.FRIGATE_PASSWORD;
delete process.env.FRIGATE_SNAPSHOT_DIR;
delete process.env.FRIGATE_LIVE_SOURCES;

after(() => {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(SCRATCH_HOME, { recursive: true, force: true });
});

/** A response object shaped the way the panel's first paint reads one. */
function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

/** The page's inline client script, exactly as the browser receives it. */
async function clientScript() {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/api/config")) return jsonResponse({ cameras: { front: {} } });
    throw new Error(`unexpected read: ${url}`);
  };
  let html;
  try {
    let content = null;
    const res = { send(value) { content = value; return this; } };
    await panel.handler({ query: {} }, res, { appRoot: ROOT, layout: (opts) => opts.content });
    html = content;
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(typeof html, "string", "the panel sent a page");
  const script = /<script>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(script, "the page carries its client script");
  return script[1];
}

/** An element stub with the handful of properties the live player's client code touches. */
function element(tag) {
  const classes = new Set();
  const node = {
    tagName: String(tag).toUpperCase(),
    style: {},
    attrs: {},
    children: [],
    className: "",
    textContent: "",
    hidden: false,
    onerror: null,
    setAttribute(name, value) { node.attrs[name] = String(value); },
    getAttribute(name) { return Object.hasOwn(node.attrs, name) ? node.attrs[name] : null; },
    removeAttribute(name) { delete node.attrs[name]; },
    appendChild(child) { node.children.push(child); return child; },
    removeChild(child) { node.children = node.children.filter((c) => c !== child); return child; },
    querySelectorAll() { return []; },
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
  };
  Object.defineProperty(node, "firstChild", { get: () => node.children[0] || null });
  // The client sets `img.src = ...` and, to hang up, an empty value plus removeAttribute("src").
  Object.defineProperty(node, "src", {
    get: () => (Object.hasOwn(node.attrs, "src") ? node.attrs.src : ""),
    set: (value) => { node.attrs.src = String(value); },
    configurable: true,
  });
  return node;
}

const PLAYER_IDS = [
  "fg-cameras",
  "fg-live",
  "fg-live-img",
  "fg-live-title",
  "fg-live-count",
  "fg-live-note",
  "fg-live-start",
  "fg-live-stop",
  "fg-live-again",
];

/**
 * Just enough of a browser to run the panel's client script: the elements a page renders, a
 * document that records its listeners, timers the test fires by hand, and a fetch that answers
 * /status from `respond`.
 */
function stubBrowser(respond = () => ({ available: true, remaining_seconds: 30 })) {
  const ids = new Map();
  for (const id of PLAYER_IDS) {
    ids.set(id, element(id === "fg-live-img" ? "img" : id === "fg-cameras" ? "div" : "span"));
  }
  const listeners = new Map();
  const timeouts = new Set();
  const intervals = new Set();
  const fetches = [];
  let seq = 0;

  const document = {
    hidden: false,
    getElementById: (id) => ids.get(id) || null,
    createElement: (tag) => element(tag),
    createTextNode: (text) => ({ textContent: String(text) }),
    addEventListener(type, handler) {
      const list = listeners.get(type) || [];
      if (!list.includes(handler)) list.push(handler);
      listeners.set(type, list);
    },
    removeEventListener(type, handler) {
      const list = listeners.get(type) || [];
      const at = list.indexOf(handler);
      if (at >= 0) list.splice(at, 1);
    },
  };

  const window = {
    addEventListener() {},
    removeEventListener() {},
  };

  function Image() {
    return { src: "", onload: null, onerror: null };
  }

  function fetchStub(url) {
    const target = String(url);
    fetches.push(target);
    if (!target.endsWith("/status")) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    }
    let body = null;
    try {
      body = respond(target);
    } catch (err) {
      return Promise.reject(err);
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => body });
  }

  return {
    window,
    document,
    /** Run the page's client script, the way Turbo re-runs it on a visit. */
    run(src) {
      new Function(
        "window",
        "document",
        "Image",
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "fetch",
        src,
      )(
        window,
        document,
        Image,
        (fn, ms) => { const handle = { id: ++seq, fn, ms }; timeouts.add(handle); return handle; },
        (handle) => { timeouts.delete(handle); },
        (fn, ms) => { const handle = { id: ++seq, fn, ms }; intervals.add(handle); return handle; },
        (handle) => { intervals.delete(handle); },
        fetchStub,
      );
    },
    el: (id) => ids.get(id),
    fetches: () => [...fetches],
    statusFetches: () => fetches.filter((url) => url.endsWith("/status")),
    timeoutDelays: () => [...timeouts].map((handle) => handle.ms),
    intervalDelays: () => [...intervals].map((handle) => handle.ms),
    /** Fire every pending one-shot timer once. */
    fireTimeouts() {
      const due = [...timeouts];
      timeouts.clear();
      for (const handle of due) handle.fn();
    },
    /** Fire the repeating timers, optionally only those with this period. */
    fireIntervals(ms) {
      for (const handle of [...intervals]) {
        if (ms === undefined || handle.ms === ms) handle.fn();
      }
    },
    /** A click on the player or a card button, as the delegated listener sees one. */
    click(selector, attributeName, attributeValue) {
      const hit = { getAttribute: (name) => (name === attributeName ? attributeValue : null) };
      const event = { type: "click", target: { closest: (sel) => (sel === selector ? hit : null) } };
      for (const handler of [...(listeners.get("click") || [])]) handler(event);
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Run the real client script in the stand-in browser. */
async function pageBrowser(respond) {
  const browser = stubBrowser(respond);
  browser.run(await clientScript());
  return browser;
}

/** Click the "Watch live" button of the named camera. */
function start(browser, name = "front_door") {
  browser.click("[data-live]", "data-live", name);
}

// ─── the countdown follows the server ─────────────────────────────────────

test("a late viewer is shown the server's remaining time, not a fresh two minutes", async () => {
  const browser = await pageBrowser(() => ({ available: true, remaining_seconds: 30 }));

  start(browser);
  assert.match(browser.el("fg-live-img").getAttribute("src") || "",
    /^\/api\/frigate\/live\/front_door\/stream\.mjpg\?t=\d+$/, "the click puts one stream on the image");
  assert.equal(browser.el("fg-live-count").textContent, "Live - ends in 120 s",
    "the click starts from the cap the server allows");
  assert.deepEqual(browser.timeoutDelays(), [1000],
    "the first status read is about a second after the stream starts");
  assert.deepEqual(browser.statusFetches(), [], "and nothing is asked before that");

  browser.fireIntervals(1000);
  assert.equal(browser.el("fg-live-count").textContent, "Live - ends in 119 s",
    "the local countdown still ticks every second");

  browser.fireTimeouts();
  await settle();
  assert.deepEqual(browser.statusFetches(), ["/api/frigate/live/front_door/status"],
    "the gateway's own status route for this camera");
  assert.equal(browser.el("fg-live-count").textContent, "Live - ends in 30 s",
    "the server's 30 s wins over the local 119 s");
  assert.deepEqual(browser.timeoutDelays(), [10000], "then it asks again every ten seconds");

  browser.fireIntervals(1000);
  assert.equal(browser.el("fg-live-count").textContent, "Live - ends in 29 s",
    "counting down continues from the server's number");
  assert.equal(browser.el("fg-live-stop").hidden, false, "the view is still running");
});

test("an answer outside the cap is ignored, and Stop still ends the view at once", async () => {
  const browser = await pageBrowser(() => ({ available: true, remaining_seconds: 9999 }));

  start(browser);
  browser.fireTimeouts();
  await settle();
  assert.equal(browser.el("fg-live-count").textContent, "Live - ends in 120 s",
    "a number larger than the cap cannot stretch the local countdown");
  assert.deepEqual(browser.timeoutDelays(), [10000], "and polling carries on");

  browser.click("#fg-live-stop");
  assert.equal(browser.el("fg-live-note").textContent, "Live view ended");
  assert.equal(browser.el("fg-live-count").textContent, "", "the countdown is cleared");
  assert.equal(browser.el("fg-live-stop").hidden, true);
  assert.equal(browser.el("fg-live-again").hidden, false, "Watch again is the next click");
  assert.equal(browser.el("fg-live-img").getAttribute("src"), null, "the stream is hung up");
  assert.deepEqual(browser.timeoutDelays(), [], "Stop stops the status reads too");
  assert.deepEqual(browser.intervalDelays(), [2000], "only the stills timer is left");
});

test("a status answer of 0 after the first check ends the view instead of freezing it", async () => {
  const browser = await pageBrowser(() => ({ available: true, remaining_seconds: 0 }));

  start(browser);
  browser.fireTimeouts();
  await settle();
  assert.equal(browser.el("fg-live-count").textContent, "Live - ends in 120 s",
    "the very first answer is not taken as an end: the session may not have registered yet");
  assert.deepEqual(browser.timeoutDelays(), [10000], "so it asks again");

  browser.fireTimeouts();
  await settle();
  assert.equal(browser.el("fg-live-note").textContent, "Live view ended",
    "a later 0 means the server ended the stream, which fires no onerror on the image");
  assert.equal(browser.el("fg-live-count").textContent, "");
  assert.equal(browser.el("fg-live-stop").hidden, true);
  assert.equal(browser.el("fg-live-again").hidden, false);
  assert.equal(browser.el("fg-live-img").getAttribute("src"), null, "the stream was dropped");
  assert.deepEqual(browser.timeoutDelays(), [], "and nothing polls a view that is over");
  assert.equal(browser.statusFetches().length, 2, "two answers is all it took");
});

test("a status read that fails keeps the local countdown going", async () => {
  let calls = 0;
  const browser = await pageBrowser(() => {
    calls += 1;
    if (calls === 1) throw new Error("the connection dropped");
    return { available: true, remaining_seconds: 45 };
  });

  start(browser);
  browser.fireTimeouts();
  await settle();
  assert.equal(calls, 1, "the first read was attempted and failed");
  assert.equal(browser.el("fg-live-count").textContent, "Live - ends in 120 s",
    "a failed read changes nothing on the page");
  assert.equal(browser.el("fg-live-note").textContent, "Connecting…", "and says nothing extra");
  assert.deepEqual(browser.timeoutDelays(), [10000], "polling carries on after a failure");

  browser.fireTimeouts();
  await settle();
  assert.equal(browser.el("fg-live-count").textContent, "Live - ends in 45 s",
    "the next good answer is taken");
});

// ─── the script itself ────────────────────────────────────────────────────

test("the client script parses, carries no backtick, and asks status on a timer", async () => {
  const src = await clientScript();
  assert.doesNotThrow(() => new Function(src), "the client script parses");
  assert.doesNotMatch(src, /`/, "no backtick inside the template literal");
  assert.doesNotMatch(src, /\$\{/, "and no template substitution");
  assert.match(src, /LIVE_MAX_SECONDS = 120/, "the cap is still the server's two minutes");
  assert.match(src, /LIVE_STATUS_FIRST_MS = 1000/);
  assert.match(src, /LIVE_STATUS_EVERY_MS = 10000/);
  assert.match(src, /remaining_seconds/, "the countdown reads the server's number");
  assert.match(src, /scheduleLiveStatus\(LIVE_STATUS_FIRST_MS\)/, "scheduled once the stream is set");
  assert.match(src, /setInterval\(function \(\) \{[\s\S]*?drawLiveCount\(\);[\s\S]*?\}, 1000\)/,
    "the local countdown still ticks each second");
});