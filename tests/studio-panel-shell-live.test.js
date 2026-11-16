/**
 * Studio shell — the whole page in a real browser.
 *
 * The panel's own live half (tests/studio-panel-timeline.test.js) is the model
 * here: a real session hub on a scratch database behind the panel's own routes
 * and WebSocket, and a private headless Chrome
 * (tests/fixtures/headless-chrome.mjs) loading the page the handler renders.
 * No browser: every case skips, unless CROW_REQUIRE_TEST_CHROME=1, which makes
 * the fixture throw instead.
 *
 * What is driven is what a person drives: the mode buttons in the top bar, the
 * transport bar at the bottom of a scrolled page, the phone tab strip, and the
 * timeline's zoom buttons over a section chip. The last case renders the same
 * page through the real dashboard layout
 * (servers/gateway/dashboard/shared/layout.js) and checks the nav sidebar it
 * brings with it.
 *
 * Both bars lay out again while the page is still filling in (the song's title
 * and presence arrive after the first draw), so a control's rectangle read the
 * moment it appears can be stale by the time a mouse event lands on it. Every
 * press of a top-bar or transport-bar control therefore goes through
 * `pressSettled`: it waits until the page is really ready to be pressed (the
 * control is on the page, the song's own title has arrived, the replica has
 * drawn the grid, the page's handlers are attached) and until the control's own
 * rectangle has stopped moving, presses ONCE, and leaves the caller to wait for
 * the state that press should produce.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";
import { AclError } from "../servers/shared/project-acl.js";
import { createHub } from "../bundles/studio/server/hub.js";
import { initStudioTables } from "../bundles/studio/server/init-tables.js";
import { createStudioWeb } from "../bundles/studio/server/web.js";
import studioPanel from "../bundles/studio/panel/studio.js";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";

/** The track and the scene of the fixture song. */
const TRACK = "bass";
const SCENE = "verse";
const CLIP = "c-bass";

/** The section the chip cases measure, and the placement the lanes draw. */
const SECTION = "sec-intro";
const PLACEMENT = "p-notes";

/** The project the song lives in, and its storage prefix. */
const PROJECT = 61;
const PREFIX = "projects/61/";

/** The author a browser command carries (server/web.js's own constant). */
const HUMAN = { kind: "human", id: "local", label: "You" };

/** The bundle directory the asset routes read from. */
const BUNDLE_DIR = new URL("../bundles/studio", import.meta.url).pathname.replace(/\/$/, "");

/** The vendored Turbo the dashboard layout asks for, and its route. */
const TURBO_FILE = new URL(
  "../servers/gateway/public/vendor/turbo-8.0.5.umd.js",
  import.meta.url,
).pathname;

/** The stand-in dashboard layout: a bare document around the panel content. */
function minimalLayout({ title, content }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1.0">`
    + `<title>${title}</title></head><body>${content}</body></html>`;
}

// ---- the hub, the server and the browser ---------------------------------

let chrome = null;
let server = null;
let upgrades = null;
let db = null;
let hub = null;
let base = "";
let songId = "";
let dir = "";

/** One session hub ACL: this project exists and needs no capability check. */
function fakeAcl() {
  async function assertProjectExists(_db, projectId) {
    if (Number(projectId) !== PROJECT) throw new AclError(`Project #${projectId} not found`, "not_found");
    return { id: PROJECT };
  }
  async function assertCapability(database, projectId) {
    return assertProjectExists(database, projectId);
  }
  async function appendAudit() {}
  return { assertProjectExists, assertCapability, appendAudit };
}

/** @returns {string|null} one cookie's value out of a Cookie header. */
function cookieOf(header, name) {
  for (const part of String(header || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

before(async () => {
  chrome = await startHeadlessChrome({ extraArgs: ["--autoplay-policy=no-user-gesture-required"] });
  if (!chrome) return;

  dir = mkdtempSync(join(tmpdir(), "studio-panel-shell-live-"));
  db = createClient({ url: "file:" + join(dir, "crow.db") });
  await db.execute(
    "CREATE TABLE IF NOT EXISTS project_spaces (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, status TEXT, archived_at TEXT, storage_prefix TEXT)",
  );
  await db.execute({
    sql: "INSERT INTO project_spaces (id, name, storage_prefix) VALUES (?, ?, ?)",
    args: [PROJECT, "Studio project", PREFIX],
  });
  await initStudioTables(db);

  const webRef = { web: null };
  hub = createHub({
    db,
    acl: fakeAcl(),
    onBroadcast: (id, payload) => webRef.web?.broadcast(id, payload),
  });

  const web = createStudioWeb({
    hub,
    Router: express.Router,
    WebSocketServer,
    auth: {
      isAllowedNetwork: () => true,
      sessionFromRequest: (req) => cookieOf(req.headers.cookie, "crow_session"),
      verifySession: async (token) => token === "good",
      csrfTokenAccepted: (_req, presented) => presented === "csrf-ok",
      classifyPeer: () => ({ via: "local" }),
    },
    crowHome: join(dir, "home"),
    bundleDir: BUNDLE_DIR,
  });
  webRef.web = web;

  const created = await hub.createSong({ project_id: PROJECT, title: "Shell song", author: HUMAN });
  assert.equal(created.ok, true, `createSong was refused: ${created.error}`);
  songId = created.song_id;

  for (const [command, args] of [
    ["song.set_meta", { bpm: 120 }],
    ["track.add", { id: TRACK, name: "Bass" }],
    ["scene.add", { id: SCENE, name: "Verse" }],
    [
      "clip.write",
      {
        clip_id: CLIP,
        track_id: TRACK,
        scene_id: SCENE,
        name: "Bass line",
        length_bars: 4,
        notes: [{ t: 0, d: 1, p: 60, v: 100 }],
      },
    ],
    ["section.add", { id: SECTION, start_bar: 0, end_bar: 4, name: "Intro" }],
    ["arrangement.place", { id: PLACEMENT, track_id: TRACK, clip_id: CLIP, start_bar: 0, bars: 4 }],
  ]) {
    const result = await hub.runCommand({ song_id: songId, cmd_id: null, command, args, author: HUMAN });
    assert.equal(result.ok, true, `${command} was refused: ${result.error}`);
  }

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  // The gateway's own Content-Security-Policy for the Studio page and its
  // assets, so the engine's worklet and WebAssembly load here.
  app.use((req, res, next) => {
    if (req.path.startsWith("/dashboard/studio")) {
      res.setHeader("Content-Security-Policy", [
        "default-src 'self'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src https://fonts.gstatic.com",
        "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
        "img-src 'self' data: blob:",
        "media-src 'self' https: blob:",
        "connect-src 'self'",
        "frame-src 'self' https:",
      ].join("; "));
    }
    next();
  });
  // The dashboard layout's own Turbo script, served for real.
  app.get("/vendor/turbo-8.0.5.umd.js", (_req, res) => {
    if (!existsSync(TURBO_FILE)) return res.status(404).end();
    res.setHeader("content-type", "application/javascript");
    return res.end(readFileSync(TURBO_FILE));
  });
  app.get("/sw.js", (_req, res) => {
    res.setHeader("content-type", "application/javascript");
    res.end("self.addEventListener('install', function () {});");
  });
  const dashboardAuth = (req, res, next) => {
    if (!cookieOf(req.headers.cookie, "crow_session")) return res.status(401).json({ error: "unauthorized" });
    return next();
  };
  app.use(web.router(dashboardAuth));
  app.get("/dashboard/studio", async (req, res, next) => {
    try {
      await studioPanel.handler(req, res, { db, layout: minimalLayout });
    } catch (err) {
      next(err);
    }
  });
  // The same page inside the real dashboard layout, which is what a person
  // reaches from the dashboard's own navigation.
  app.get("/dashboard/studio-dash", async (req, res, next) => {
    try {
      const { renderLayout } = await import("../servers/gateway/dashboard/shared/layout.js");
      const layout = (options) =>
        renderLayout({ ...options, activePanel: "studio", panels: [], lang: "en" });
      await studioPanel.handler(req, res, { db, layout });
    } catch (err) {
      next(err);
    }
  });

  server = createServer(app);
  upgrades = web.attachUpgrade(server);
  await new Promise((resolve) => server.listen(0, chrome.bindHost ?? "127.0.0.1", resolve));
  base = `http://${chrome.pageHost ?? "127.0.0.1"}:${server.address().port}`;
});

after(async () => {
  if (upgrades) upgrades.close();
  if (server) {
    try {
      server.closeAllConnections?.();
    } catch {
      // Nothing left to close.
    }
    await new Promise((resolve) => server.close(resolve));
  }
  if (chrome) await chrome.close();
  try {
    db?.close?.();
  } catch {
    // Already gone.
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** The song page's URL. */
function songUrl() {
  return `${base}/dashboard/studio?song=${encodeURIComponent(songId)}`;
}

/** The same song page inside the real dashboard layout. */
function dashboardUrl() {
  return `${base}/dashboard/studio-dash?song=${encodeURIComponent(songId)}`;
}

/**
 * Open one page in the private browser at a given viewport, with the
 * dashboard's session cookies, and return its CDP handle.
 * @param {string} url
 * @param {{width?: number, height?: number}} [viewport]
 * @returns {Promise<object>}
 */
async function openPage(url, { width = 1280, height = 900 } = {}) {
  const tab = await (await fetch(chrome.cdp + "/json/new?about:blank", { method: "PUT" })).json();
  const socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.method === "Runtime.exceptionThrown") {
      console.error(
        "PAGE exception:",
        JSON.stringify(
          message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text,
        ).slice(0, 500),
      );
    }
  });
  let nextId = 0;
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mine = (nextId += 1);
      const onMessage = (raw) => {
        const message = JSON.parse(String(raw));
        if (message.id !== mine) return;
        socket.off("message", onMessage);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result || {});
      };
      socket.on("message", onMessage);
      socket.send(JSON.stringify({ id: mine, method, params }));
    });

  const evaluate = async (expression) => {
    const outcome = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (outcome.exceptionDetails) throw new Error(JSON.stringify(outcome.exceptionDetails));
    return outcome.result?.value;
  };

  /**
   * A press a person could make: the element's own rectangle, read after the
   * page has scrolled, and a real mouse press and release at its middle.
   * @returns {Promise<{x: number, y: number, w: number, h: number}>}
   */
  const clickAt = async (selector) => {
    const box = await evaluate(boxExpression(selector));
    assert.ok(box, `${selector} is on the page and has a rectangle`);
    await clickBox(send, box);
    return box;
  };

  await send("Page.enable");
  await send("Network.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    // The page decides its size class from window.innerWidth alone, so the
    // viewport is emulated as a desktop one of that width: a mobile emulation
    // would lay the page out at the 980 px it falls back to without a viewport
    // meta, and the width under test would never reach the page.
    width, height, deviceScaleFactor: 1, mobile: false,
  });
  for (const [name, value] of [["crow_session", "good"], ["crow_csrf", "csrf-ok"]]) {
    await send("Network.setCookie", { name, value, url: `${base}/` });
  }
  await send("Page.navigate", { url });

  return {
    evaluate,
    clickAt,
    send,
    close: async () => {
      try {
        socket.close();
      } catch {
        // Already closed.
      }
      try {
        await fetch(chrome.cdp + "/json/close/" + tab.id);
      } catch {
        // The tab is going away either way.
      }
    },
  };
}

/**
 * Poll a page until `expression` is truthy.
 * @returns {Promise<any>} the last value, or false after the timeout
 */
async function waitFor(page, expression, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last = false;
  while (Date.now() < deadline) {
    try {
      last = await page.evaluate(expression);
    } catch {
      last = false;
    }
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return last;
}

/** The ids of the frames the widget area is showing right now, in page order. */
const VISIBLE_WIDGETS = `(function () {
  var area = document.querySelector('[data-role=studio-widgets]');
  if (!area) return [];
  var ids = [];
  for (var i = 0; i < area.children.length; i += 1) {
    var node = area.children[i];
    var id = node.getAttribute ? node.getAttribute('data-widget') : null;
    if (!id) continue;
    if (node.hasAttribute('hidden')) continue;
    ids.push(id);
  }
  return ids;
})()`;

/** The expression that is true while the MIDI widget is on the page. */
const MIDI_SHOWN = `(function () {
  var ids = ${VISIBLE_WIDGETS};
  return ids.indexOf('midi') >= 0;
})()`;

/** The expression that is true while the session grid is what is open. */
const SESSION_OPEN = `(function () {
  var area = document.querySelector('[data-role=studio-widgets]');
  return !!area && !area.hasAttribute('hidden');
})()`;

/** @returns {Promise<void>} after `ms` milliseconds */
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The expression that reads one element's own rectangle, in page pixels, or
 * null while it has no rectangle to press (absent, or laid out with no size).
 * @param {string} selector
 * @returns {string}
 */
function boxExpression(selector) {
  return `(function () {
    var node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return null;
    var rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      w: rect.width,
      h: rect.height
    };
  })()`;
}

/** @returns {boolean} whether two rectangles are the same place and size */
function sameBox(one, other) {
  const near = (a, b) => Math.abs(a - b) < 0.5;
  return near(one.x, other.x) && near(one.y, other.y)
    && near(one.w, other.w) && near(one.h, other.h);
}

/**
 * A real mouse press and release at one rectangle's middle.
 * @param {(method: string, params?: object) => Promise<any>} send
 * @param {{x: number, y: number}} box
 */
async function clickBox(send, box) {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y, button: "none" });
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1,
  });
}

/**
 * One control's rectangle once it has stopped moving: the same on two reads
 * `settleMs` apart. A rectangle that never stands still in time answers with
 * the last one read (pressing that is what a person's own press would do), and
 * a control that is not on the page answers null.
 * @returns {Promise<{x: number, y: number, w: number, h: number}|null>}
 */
async function settledBox(page, selector, settleMs, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let previous = null;
  let latest = null;
  for (;;) {
    try {
      latest = await page.evaluate(boxExpression(selector));
    } catch {
      latest = null;
    }
    if (latest && previous && sameBox(previous, latest)) return latest;
    previous = latest;
    if (Date.now() + settleMs >= deadline) return latest;
    await pause(settleMs);
  }
}

/**
 * The document's own scroll height once it has stopped changing: the same on
 * two reads `settleMs` apart. The replica keeps rendering on after the first
 * draw, so a height read the moment the page looks ready can still be short,
 * and scrolling to it lands above the bottom the page ends up with. Answers
 * with the last height read when it never stands still in time.
 * @param {object} page
 * @param {number} settleMs
 * @param {number} timeoutMs
 * @returns {Promise<number>} the height in pixels
 */
async function settledScrollHeight(page, settleMs = 250, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let previous = 0;
  for (;;) {
    let latest = 0;
    try {
      latest = await page.evaluate("document.documentElement.scrollHeight");
    } catch {
      latest = 0;
    }
    if (latest > 0 && latest === previous) return latest;
    previous = latest;
    if (Date.now() + settleMs >= deadline) return latest;
    await pause(settleMs);
  }
}

/** @returns {Promise<boolean>} one read of `doneExpression`, false if it throws */
async function isDone(page, expression) {
  try {
    return !!(await page.evaluate(expression));
  } catch {
    return false;
  }
}

/**
 * Wait until the page is ready for a press: the control is on the page, the
 * song's own title has replaced the placeholder the page draws before its first
 * snapshot (`Song`), the replica has drawn the session grid, and the page's own
 * handlers are attached (the client sets `window.__crowStudioLatency` on the
 * line after it adds them).
 * @param {object} page
 * @param {string} selector the control about to be pressed
 * @param {number} timeoutMs
 * @returns {Promise<boolean>} whether the page got there in time
 */
async function waitForPressable(page, selector, timeoutMs) {
  const ready = `(function () {
    if (!document.querySelector(${JSON.stringify(selector)})) return false;
    var title = document.querySelector('[data-role=title]');
    var text = title ? String(title.textContent || '').trim() : '';
    if (text === '' || text === 'Song') return false;
    if (!document.querySelector('[data-role=grid] .st-corner')) return false;
    return !!window.__crowStudioLatency;
  })()`;
  return !!(await waitFor(page, ready, timeoutMs));
}

/**
 * Press a top-bar or transport-bar control once, on a page that is ready for it.
 *
 * Both bars lay out again as the song's own title and presence arrive, so a
 * rectangle measured before that can be stale by the time the mouse event lands,
 * and the event then goes to whatever moved into that place. So the press waits
 * for the page's own conditions (`waitForPressable`) and for the control's
 * rectangle to be the same on two reads `settleMs` apart, and then presses
 * exactly once. What the press should change is the CALLER's to wait for: a
 * control that toggles is never skipped and never pressed twice.
 *
 * A control that is not a toggle (a mode button: Perform, Session,
 * Arrangement) may be handed an `already` expression: when the page is already
 * in the state that press would set, the press is not made.
 * @param {object} page
 * @param {string} selector
 * @param {{already?: string, settleMs?: number, timeoutMs?: number}} [options]
 * @returns {Promise<{x: number, y: number, w: number, h: number}|null>} the box
 *   that was pressed, null when the control never became pressable
 */
async function pressSettled(page, selector, options = {}) {
  const settleMs = options.settleMs ?? 250;
  const timeoutMs = options.timeoutMs ?? 20000;
  if (!(await waitForPressable(page, selector, timeoutMs))) return null;
  const box = await settledBox(page, selector, settleMs, timeoutMs);
  if (!box) return null;
  if (options.already && (await isDone(page, options.already))) return box;
  await clickBox(page.send, box);
  return box;
}

/** Wait until the song page is up: the top bar mounted and the grid drawn. */
async function waitForStudio(page) {
  assert.ok(
    await waitFor(page, "!!document.querySelector('.studio [data-role=studio-top]')", 30000),
    "the studio shell mounted",
  );
  assert.ok(
    await waitFor(page, "!!document.querySelector('[data-role=grid] .st-corner')", 30000),
    "the session grid rendered (the page's Yjs replica did not load)",
  );
  assert.ok(
    await waitFor(page, VISIBLE_WIDGETS + ".length > 0", 20000),
    "the widget area filled in",
  );
}

// ---- laptop: compose, then perform ---------------------------------------

test("at laptop width the page renders compose, and Perform brings the MIDI widget in", async (t) => {
  if (!chrome) return t.skip("no headless Chrome available");

  const page = await openPage(songUrl(), { width: 1280, height: 900 });
  t.after(() => page.close());
  await waitForStudio(page);

  assert.equal(
    await page.evaluate("document.querySelector('[data-role=mode-switch] [data-mode=compose]').getAttribute('aria-pressed')"),
    "true",
    "a device that never chose starts in Compose",
  );
  assert.deepEqual(
    await page.evaluate(VISIBLE_WIDGETS),
    ["scene-grid", "editor", "history"],
    "compose's own widgets are the ones on the page",
  );

  const box = await pressSettled(page, "[data-mode=perform]", {
    already: "document.querySelector('[data-mode=perform]').getAttribute('aria-pressed') === 'true'",
  });
  assert.ok(box, "the Perform button was on the page and was pressed");
  assert.ok(box.w >= 44 && box.h >= 44, `the Perform button is a ${box.w} by ${box.h} target`);

  assert.ok(
    await waitFor(page, MIDI_SHOWN, 20000),
    "the MIDI widget came in with Perform",
  );
  assert.deepEqual(
    await page.evaluate(VISIBLE_WIDGETS),
    ["scene-grid", "editor", "midi", "history"],
    "switching mode changed which widgets the page shows",
  );
  assert.equal(
    await page.evaluate("document.querySelector('[data-role=mode-switch] [data-mode=perform]').getAttribute('aria-pressed')"),
    "true",
    "and the button says which mode the page is in",
  );
});

// ---- the transport bar at the bottom of a scrolled page -------------------

test("Play and Pause work from the transport bar with the page scrolled to the bottom", async (t) => {
  if (!chrome) return t.skip("no headless Chrome available");

  const page = await openPage(songUrl(), { width: 1280, height: 900 });
  t.after(() => page.close());
  await waitForStudio(page);
  assert.ok(
    await waitFor(page, "!!document.querySelector('[data-role=transport-bar] [data-act=play]')", 20000),
    "the transport bar carries Play",
  );

  await settledScrollHeight(page);
  await page.evaluate("window.scrollTo(0, document.documentElement.scrollHeight), true");
  const atBottom = await waitFor(page, `(function () {
    var max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    return window.scrollY >= max - 4 || max === 0;
  })()`, 20000);
  const scrolled = await page.evaluate(`(function () {
    var max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    return { y: window.scrollY, max: max };
  })()`);
  assert.ok(
    atBottom,
    `the window scrolled to the bottom (at ${scrolled.y} of ${scrolled.max})`,
  );

  const before = await page.evaluate("document.querySelector('[data-role=position]').textContent");
  const playing = "document.querySelector('[data-act=play]').getAttribute('aria-pressed') === 'true'";
  const box = await pressSettled(page, "[data-act=play]");
  assert.ok(box, "the Play button was on the page and was pressed");
  assert.ok(box.w >= 44 && box.h >= 44, `Play is a ${box.w} by ${box.h} target`);

  assert.ok(
    await waitFor(page, playing, 20000),
    "the engine was told to play",
  );
  assert.ok(
    await waitFor(page, `(function () {
      var read = document.querySelector('[data-role=position]');
      return !!read && read.textContent !== ${JSON.stringify(before)};
    })()`, 20000),
    "and the position readout moved",
  );

  const pausing = "document.querySelector('[data-act=pause]').getAttribute('aria-pressed') === 'true'";
  const pauseBox = await pressSettled(page, "[data-act=pause]");
  assert.ok(pauseBox, "the Pause button was on the page and was pressed");
  assert.ok(
    await waitFor(page, pausing, 20000),
    "Pause paused the transport",
  );
  assert.equal(
    await page.evaluate("document.querySelector('[data-act=play]').getAttribute('aria-pressed')"),
    "false",
    "and Play is no longer pressed",
  );

  // A paused transport holds the position it was paused at.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const paused = await page.evaluate("document.querySelector('[data-role=position]').textContent");
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(
    await page.evaluate("document.querySelector('[data-role=position]').textContent"),
    paused,
    "the readout stays where Pause left it",
  );
});

// ---- phone: one widget under the tab strip -------------------------------

test("at 500 px wide the phone tab strip shows and exactly one widget is on the page", async (t) => {
  if (!chrome) return t.skip("no headless Chrome available");

  const page = await openPage(songUrl(), { width: 500, height: 900 });
  t.after(() => page.close());
  await waitForStudio(page);

  // The screen a song was last left in is remembered, so come back to the grid
  // the tabs belong to before reading them.
  const sessionBox = await pressSettled(page, "[data-act=mode-session]", { already: SESSION_OPEN });
  assert.ok(sessionBox, "the Session button was on the page and was pressed");
  assert.ok(
    await waitFor(page, SESSION_OPEN, 20000),
    "the session grid is what is open",
  );
  assert.ok(
    await waitFor(page, `(function () {
      var strip = document.querySelector('[data-role=studio-tabs]');
      return !!strip && !strip.hasAttribute('hidden');
    })()`, 20000),
    "the phone tab strip is on the page",
  );
  const tabs = await page.evaluate(
    "Array.from(document.querySelectorAll('[data-role=studio-tabs] [role=tab]')).map(function (n) { return n.textContent; })",
  );
  assert.ok(tabs.length >= 2, `one tab per shown widget (got ${JSON.stringify(tabs)})`);

  const visible = await page.evaluate(VISIBLE_WIDGETS);
  assert.equal(visible.length, 1, `exactly one widget is on the page (got ${JSON.stringify(visible)})`);
  const selected = await page.evaluate(`(function () {
    var tab = document.querySelector('[data-role=studio-tabs] [role=tab][aria-selected=true]');
    return tab ? tab.textContent : null;
  })()`);
  assert.ok(tabs.includes(selected), "the selected tab is one of the strip's own");
});

// ---- the section chip at every zoom step ---------------------------------

test("a section chip measures at least 56 px wide at every zoom step", async (t) => {
  if (!chrome) return t.skip("no headless Chrome available");

  const page = await openPage(songUrl(), { width: 1280, height: 900 });
  t.after(() => page.close());
  await waitForStudio(page);

  const chip = "!!document.querySelector('[data-role=section] [data-act=section-rename]')";
  const arrangementBox = await pressSettled(page, "[data-act=mode-arrangement]", { already: chip });
  assert.ok(arrangementBox, "the Arrangement button was on the page and was pressed");
  assert.ok(
    await waitFor(page, chip, 20000),
    "the arrangement drew the section's chip",
  );

  // Walk down to the lowest zoom the page has, then measure every step up.
  for (let i = 0; i < 6; i += 1) {
    if (await page.evaluate("document.querySelector('[data-act=zoom-out]').disabled")) break;
    await page.clickAt("[data-act=zoom-out]");
    assert.ok(
      await waitFor(page, "document.querySelector('[data-act=zoom-out]').disabled", 10000),
      "the page reached its lowest zoom",
    );
  }

  const steps = [];
  for (const want of [0.5, 1, 2, 4, 8]) {
    assert.ok(
      await waitFor(page, `(function () {
        var read = document.querySelector('[data-role=zoom]');
        if (!read) return false;
        var at = Number(String(read.textContent).replace(/[^0-9.]/g, ''));
        return Math.abs(at - ${want}) < 0.001;
      })()`, 10000),
      `the zoom readout says ${want}`,
    );
    const step = await page.evaluate(`(function () {
      var chip = document.querySelector('[data-role=section] [data-act=section-rename]');
      if (!chip) return null;
      var rect = chip.getBoundingClientRect();
      return { width: Math.round(rect.width * 100) / 100, height: Math.round(rect.height * 100) / 100 };
    })()`);
    assert.ok(step, "the section chip is on the page at this zoom");
    steps.push({ zoom: want, width: step.width });
    if (want !== 8) await page.clickAt("[data-act=zoom-in]");
  }

  assert.deepEqual(
    steps.map((step) => step.zoom),
    [0.5, 1, 2, 4, 8],
    "the five zoom steps were walked",
  );
  for (const step of steps) {
    assert.ok(
      step.width >= 56,
      `the section chip is ${step.width} px wide at ${step.zoom} times`,
    );
  }
});

// ---- the same page through the real dashboard layout ---------------------

test("inside the real dashboard layout the nav sidebar either is absent or collapses", async (t) => {
  if (!chrome) return t.skip("no headless Chrome available");

  const page = await openPage(dashboardUrl(), { width: 1280, height: 900 });
  t.after(() => page.close());
  await waitForStudio(page);

  // The Studio page is the page: its own shell is the only widget shell.
  assert.equal(
    await page.evaluate("document.querySelectorAll('[data-role=studio-top]').length"),
    1,
    "one studio top bar inside the dashboard layout",
  );
  assert.equal(
    await page.evaluate("document.querySelectorAll('[data-role=studio-widgets]').length"),
    1,
    "one widget area",
  );

  const hasSidebar = await page.evaluate("!!document.querySelector('.sidebar')");
  if (!hasSidebar) {
    assert.equal(
      await page.evaluate("!!document.querySelector('#sidebar-collapse-btn')"),
      false,
      "a layout without a nav sidebar carries no collapse button either",
    );
    return;
  }

  assert.ok(
    await waitFor(page, "!!document.querySelector('#sidebar-collapse-btn')", 10000),
    "the nav sidebar carries its collapse button",
  );
  assert.equal(
    await page.evaluate("document.body.classList.contains('sidebar-collapsed')"),
    false,
    "the sidebar starts expanded at this width",
  );

  // The nav's two controls move the layout itself: the collapse button rides
  // away with the sidebar and the hamburger goes from no box to one as the
  // sidebar leaves and the content reclaims its width, so both are pressed the
  // same way every other control here is — once, on a rectangle that has
  // stopped moving — and the state each press should produce is waited for
  // below.
  const collapseBox = await pressSettled(page, "#sidebar-collapse-btn");
  assert.ok(collapseBox, "the collapse button was on the page and was pressed");
  assert.ok(
    await waitFor(page, "document.body.classList.contains('sidebar-collapsed')", 10000),
    "the button collapses the nav",
  );
  assert.equal(
    await page.evaluate("localStorage.getItem('crow-sidebar-collapsed')"),
    "1",
    "and the collapse is remembered on this device",
  );

  const revealBox = await pressSettled(page, "#sidebar-reveal-btn");
  assert.ok(revealBox, "the hamburger was on the page and was pressed");
  assert.ok(
    await waitFor(page, "!document.body.classList.contains('sidebar-collapsed')", 10000),
    "and the hamburger opens it again",
  );

  // The studio page is still whole after both moves of the nav, and the grid
  // the widgets belong to is what is open.
  const backBox = await pressSettled(page, "[data-act=mode-session]", { already: SESSION_OPEN });
  assert.ok(backBox, "the Session button was on the page and was pressed");
  assert.ok(
    await waitFor(page, SESSION_OPEN, 20000),
    "the session grid is what is open",
  );
  const visible = await page.evaluate(VISIBLE_WIDGETS);
  assert.ok(
    visible.includes("scene-grid") && visible.includes("editor"),
    `the widget area still shows the song's layout (got ${JSON.stringify(visible)})`,
  );
});