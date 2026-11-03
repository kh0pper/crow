/**
 * Studio panel — live, in a real browser.
 *
 * A private headless Chrome (tests/fixtures/headless-chrome.mjs) opens the
 * dashboard's Studio page against a real gateway-shaped server: the panel
 * handler rendered through a minimal layout, the studio router with the asset
 * whitelist, the `/api/studio/ws` WebSocket, a real session hub on a scratch
 * database and the agent HTTP API. The tests then prove the three things the
 * page exists for:
 *
 *   1. an agent's command appears in an open page within a second, outlined in
 *      the agent colour (#5DA9F0) rather than the operator's (#F2A541);
 *   2. the Undo button reverts a step and every open page follows;
 *   3. locking a track in the page makes the agent's next write refused with
 *      `locked`.
 *
 * The page loads its Yjs replica from the bundle's own asset route, so a
 * failure there (a file missing from the whitelist, a module a browser cannot
 * resolve) fails these tests rather than passing silently.
 *
 * No browser: the tests skip, unless CROW_REQUIRE_TEST_CHROME=1, which makes
 * the fixture throw instead.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import express, { Router } from "express";
import { WebSocket, WebSocketServer } from "ws";
import { AclError } from "../servers/shared/project-acl.js";
import { createHub } from "../bundles/studio/server/hub.js";
import { initStudioTables } from "../bundles/studio/server/init-tables.js";
import { createStudioWeb, ensureAgentToken } from "../bundles/studio/server/web.js";
import studioPanel from "../bundles/studio/panel/studio.js";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";

/** The project every song in this file belongs to. */
const PROJECT = 21;

/** The author a browser command carries (server/web.js's own constant). */
const HUMAN = { kind: "human", id: "local", label: "You" };

/** The bundle directory the asset routes read from. */
const BUNDLE_DIR = new URL("../bundles/studio", import.meta.url).pathname.replace(/\/$/, "");

let chrome = null;
let server = null;
let upgrades = null;
let db = null;
let hub = null;
let port = 0;
let base = "";
let songId = "";
let crowHome = "";
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

/** The stand-in dashboard layout: a bare document around the panel content. */
function minimalLayout({ title, content }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>`
    + `<body>${content}</body></html>`;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "studio-panel-live-"));
  crowHome = join(dir, "home");
  db = createClient({ url: "file:" + join(dir, "crow.db") });
  // The panel reads its project picker from project_spaces; the scratch
  // database carries exactly the columns that query reads.
  await db.execute(
    "CREATE TABLE IF NOT EXISTS project_spaces (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, status TEXT, archived_at TEXT)",
  );
  await db.execute({ sql: "INSERT INTO project_spaces (id, name) VALUES (?, ?)", args: [PROJECT, "Studio project"] });
  await initStudioTables(db);

  const webRef = { web: null };
  hub = createHub({
    db,
    acl: fakeAcl(),
    onBroadcast: (id, payload) => webRef.web?.broadcast(id, payload),
  });

  const web = createStudioWeb({
    hub,
    Router,
    WebSocketServer,
    auth: {
      isAllowedNetwork: () => true,
      sessionFromRequest: (req) => cookieOf(req.headers.cookie, "crow_session"),
      verifySession: async (token) => token === "good",
      csrfTokenAccepted: (_req, presented) => presented === "csrf-ok",
      classifyPeer: () => ({ via: "local" }),
    },
    crowHome,
    bundleDir: BUNDLE_DIR,
  });
  webRef.web = web;

  const created = await hub.createSong({ project_id: PROJECT, title: "Panel song", author: HUMAN });
  assert.equal(created.ok, true, `createSong was refused: ${created.error}`);
  songId = created.song_id;
  for (const [command, args] of [
    ["track.add", { id: "bass", name: "Bass" }],
    ["scene.add", { id: "verse", name: "Verse" }],
  ]) {
    const result = await hub.runCommand({ song_id: songId, cmd_id: null, command, args, author: HUMAN });
    assert.equal(result.ok, true, `${command} was refused: ${result.error}`);
  }

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  /** The dashboard session check; the page's cookie decides. */
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

  chrome = await startHeadlessChrome();

  server = createServer(app);
  upgrades = web.attachUpgrade(server);
  await new Promise((resolve) => server.listen(0, chrome?.bindHost ?? "127.0.0.1", resolve));
  port = server.address().port;
  base = `http://${chrome?.pageHost ?? "127.0.0.1"}:${port}`;
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

/** The studio page's URL for the seeded song. */
function studioUrl(id = songId) {
  return `${base}/dashboard/studio?song=${encodeURIComponent(id)}`;
}

/**
 * Open one page in the private browser and return its CDP handle.
 * @param {string} url
 * @returns {Promise<{evaluate: Function, close: Function}>}
 */
async function openPage(url) {
  const tab = await (await fetch(chrome.cdp + "/json/new?about:blank", { method: "PUT" })).json();
  const socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  // A page exception is printed, so a failing live test says why.
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.method === "Runtime.exceptionThrown") console.error("PAGE exception:", JSON.stringify(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text).slice(0, 500));
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
    const outcome = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (outcome.exceptionDetails) throw new Error(JSON.stringify(outcome.exceptionDetails));
    return outcome.result?.value;
  };

  await send("Page.enable");
  await send("Network.enable");
  await send("Runtime.enable");
  for (const [name, value] of [["crow_session", "good"], ["crow_csrf", "csrf-ok"]]) {
    await send("Network.setCookie", { name, value, url: `${base}/` });
  }
  await send("Page.navigate", { url });

  return {
    evaluate,
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
async function waitFor(page, expression, timeoutMs = 10000) {
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
  return false;
}

/** Wait until the page has its replica, its grid and the module catalogue. */
async function waitForStudio(page) {
  const ready = await waitFor(page, "!!document.querySelector('[data-role=grid] .st-corner')", 20000);
  assert.ok(ready, "the studio grid never rendered (the page's Yjs replica did not load)");
  // The device picker is filled from /api/studio/module-types; waiting for it
  // keeps the measure below free of the engine's one-off catalogue build.
  await waitFor(
    page,
    "!!document.querySelector('[data-track-id=bass] .st-device') && "
      + "document.querySelector('[data-track-id=bass] .st-device').options.length > 0",
    30000,
  );
}

/** POST one agent command through the Studio MCP HTTP API. */
async function agentCommand(body) {
  const token = ensureAgentToken(crowHome);
  const response = await fetch(`${base}/api/studio/agent/songs/${songId}/command`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-studio-token": token },
    body: JSON.stringify({
      ...body,
      cmd_id: randomUUID(),
      author: { id: "mcp", label: "Studio agent" }, // the operator's MCP session: unscoped (a bot is scoped to its project)
    }),
  });
  return { status: response.status, body: await response.json() };
}

test("the asset route serves Yjs and every lib0 module it imports resolves", async () => {
  const headers = { cookie: "crow_session=good" };
  const yjs = await fetch(`${base}/dashboard/studio/assets/yjs.mjs`, { headers });
  assert.equal(yjs.status, 200, "yjs.mjs is on the asset whitelist");
  assert.match(
    String(yjs.headers.get("content-type")),
    /^text\/javascript/,
    "a module the browser refuses to execute as JavaScript would break the page",
  );
  const source = await yjs.text();
  const direct = [...source.matchAll(/from '([^']+)'/g)].map((found) => found[1]);
  assert.ok(direct.length >= 10, "the Yjs build imports its library by name");

  // The page's import map only maps `lib0/`; anything else a module of the
  // graph imports would fail in the browser, so it fails here first.
  const seen = new Set();
  const queue = [...direct];
  while (queue.length > 0 && seen.size < 80) {
    const specifier = queue.shift();
    if (seen.has(specifier)) continue;
    seen.add(specifier);
    assert.ok(specifier.startsWith("lib0/"), `${specifier} is not covered by the page's import map`);
    const name = specifier.slice("lib0/".length);
    const response = await fetch(`${base}/dashboard/studio/assets/lib0/${name}`, { headers });
    assert.equal(response.status, 200, `lib0 ${name} is not served`);
    assert.match(String(response.headers.get("content-type")), /^text\/javascript/, `lib0 ${name} has the wrong type`);
    const text = await response.text();
    for (const found of text.matchAll(/from '([^']+)'/g)) {
      if (found[1].startsWith(".")) continue;
      assert.ok(found[1].startsWith("lib0/"), `lib0/${name} imports ${found[1]}, which the import map does not map`);
      queue.push(found[1]);
    }
  }
  assert.ok(seen.size >= 10, `the graph should reach the modules Yjs needs (${seen.size})`);

  // A name outside the package is a 404, never a file read.
  for (const bad of ["yjs.cjs", "observable.cjs", "..%2F..%2Fpackage.json"]) {
    const response = await fetch(`${base}/dashboard/studio/assets/lib0/${bad}`, { headers });
    assert.equal(response.status, 404, bad);
  }
});

test("the module-types route answers the panel's device pickers", async () => {
  const response = await fetch(`${base}/api/studio/module-types`, { headers: { cookie: "crow_session=good" } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(Array.isArray(body.generators) && body.generators.length > 0, "the track devices are listed");
  assert.ok(body.generators.includes("Analog generator"), body.generators.join(", "));
  const analog = body.modules["Analog generator"];
  assert.ok(analog, "the catalogue describes the Analog generator");
  assert.ok(Array.isArray(analog.controllers) && analog.controllers.length > 0, "with its controllers");

  const anonymous = await fetch(`${base}/api/studio/module-types`);
  assert.equal(anonymous.status, 401, "the catalogue is behind the dashboard session");
});

test("agent command via agent API appears in an open page within 1000 ms with agent colour", async (t) => {
  if (!chrome) return t.skip("no headless Chrome available");

  const page = await openPage(studioUrl());
  t.after(() => page.close());
  await waitForStudio(page);

  const started = Date.now();
  const written = await agentCommand({
    command: "clip.write",
    args: {
      clip_id: "c-agent",
      track_id: "bass",
      scene_id: "verse",
      name: "Agent line",
      length_bars: 1,
      notes: [{ t: 0, d: 1, p: 60, v: 100 }],
    },
  });
  assert.equal(written.status, 200, `the agent write was refused: ${JSON.stringify(written.body)}`);

  const appeared = await waitFor(page, "!!document.querySelector('[data-clip-id=c-agent]')", 1000);
  const elapsed = Date.now() - started;
  assert.ok(appeared, `the clip did not appear within 1000 ms (waited ${elapsed} ms)`);
  assert.ok(elapsed <= 1000, `the clip took ${elapsed} ms to appear`);

  const author = await page.evaluate(
    "document.querySelector('[data-clip-id=c-agent]').getAttribute('data-author')",
  );
  assert.equal(author, "agent", "the clip is tagged with its author");

  const border = await page.evaluate(
    "getComputedStyle(document.querySelector('[data-clip-id=c-agent]')).borderTopColor",
  );
  assert.equal(border, "rgb(93, 169, 240)", "the clip is outlined in the agent colour");
});

test("undo button reverts the clip and both pages show it", async (t) => {
  if (!chrome) return t.skip("no headless Chrome available");

  const first = await openPage(studioUrl());
  const second = await openPage(studioUrl());
  t.after(() => first.close());
  t.after(() => second.close());
  await waitForStudio(first);
  await waitForStudio(second);

  // Its own scene: the earlier test already filled Bass × Verse, and a cell
  // shows one clip.
  const scene = await agentCommand({ command: "scene.add", args: { id: "undo-scene", name: "Undo scene" } });
  assert.equal(scene.status, 200, `the agent scene was refused: ${JSON.stringify(scene.body)}`);
  const written = await agentCommand({
    command: "clip.write",
    args: {
      clip_id: "c-undo",
      track_id: "bass",
      scene_id: "undo-scene",
      name: "Undoable line",
      length_bars: 1,
      notes: [{ t: 0, d: 1, p: 62, v: 100 }],
    },
  });
  assert.equal(written.status, 200, `the agent write was refused: ${JSON.stringify(written.body)}`);

  assert.ok(await waitFor(first, "!!document.querySelector('[data-clip-id=c-undo]')", 5000), "page A sees the clip");
  assert.ok(await waitFor(second, "!!document.querySelector('[data-clip-id=c-undo]')", 5000), "page B sees the clip");

  const clicked = await first.evaluate(`(function () {
    var cards = document.querySelectorAll('.st-entry');
    for (var i = 0; i < cards.length; i += 1) {
      if (cards[i].textContent.indexOf('Undoable line') < 0) continue;
      var undo = cards[i].querySelector('[data-act=undo]');
      if (!undo) continue;
      undo.click();
      return true;
    }
    return false;
  })()`);
  assert.equal(clicked, true, "page A offers an Undo for the agent's step");

  assert.ok(
    await waitFor(first, "!document.querySelector('[data-clip-id=c-undo]')", 5000),
    "the clip is gone from page A",
  );
  assert.ok(
    await waitFor(second, "!document.querySelector('[data-clip-id=c-undo]')", 5000),
    "the clip is gone from page B too",
  );
});

test("locking a track in page A makes the agent API return locked", async (t) => {
  if (!chrome) return t.skip("no headless Chrome available");

  const page = await openPage(studioUrl());
  t.after(() => page.close());
  await waitForStudio(page);

  const clicked = await page.evaluate(`(function () {
    var lock = document.querySelector('[data-track-id=bass] [data-act=lock]');
    if (!lock) return false;
    lock.click();
    return true;
  })()`);
  assert.equal(clicked, true, "the track header offers a lock button");
  assert.ok(
    await waitFor(page, "!!document.querySelector('[data-track-id=bass] [data-act=unlock]')", 5000),
    "the track is locked in the page",
  );

  const refused = await agentCommand({
    command: "clip.write",
    args: {
      clip_id: "c-locked",
      track_id: "bass",
      scene_id: "verse",
      name: "Refused line",
      length_bars: 1,
      notes: [],
    },
  });
  assert.equal(refused.status, 409, `expected a refusal, got ${refused.status}: ${JSON.stringify(refused.body)}`);
  assert.equal(refused.body.code, "locked");
  assert.match(String(refused.body.error), /locked/i);
});

test("after a Turbo-style teardown and re-run the page reconnects and shows agent edits", async (t) => {
  if (!chrome) return t.skip("no headless Chrome available");

  const page = await openPage(studioUrl());
  t.after(() => page.close());
  await waitForStudio(page);

  // `turbo:before-cache` is where Turbo takes the snapshot it keeps for the
  // Back button. What it caches must be the static shell: no ready flag and no
  // live regions, so a restore draws its own from the hub.
  const shell = await page.evaluate(`(function () {
    var script = document.querySelector('.studio script:not([type])');
    window.__studioScript = script ? script.textContent : '';
    document.dispatchEvent(new Event('turbo:before-cache'));
    var root = document.querySelector('.studio');
    return {
      scripted: window.__studioScript.length,
      ready: root.getAttribute('data-studio-ready'),
      grid: document.querySelector('[data-role=grid]').children.length,
      history: document.querySelector('[data-role=history]').children.length,
      presence: document.querySelector('[data-role=presence]').children.length,
      editorHidden: document.querySelector('[data-role=editor]').hidden
    };
  })()`);
  assert.ok(shell.scripted > 1000, "the page carries the inline client script");
  assert.equal(shell.ready, null, "the ready flag is gone, so a restore boots again");
  assert.equal(shell.grid, 0, "the cached grid is empty");
  assert.equal(shell.history, 0, "the cached history is empty");
  assert.equal(shell.presence, 0, "the cached presence row is empty");
  assert.equal(shell.editorHidden, true, "the editor is closed in the cached shell");

  // Turbo restores the cached body and runs its inline script again.
  const restarted = await page.evaluate(`(function () {
    var node = document.createElement('script');
    node.textContent = window.__studioScript;
    document.querySelector('.studio').appendChild(node);
    return true;
  })()`);
  assert.equal(restarted, true, "the script was put back the way a restore does");

  await waitForStudio(page);
  assert.ok(
    await waitFor(page, "document.querySelector('[data-role=grid] .st-corner') && "
      + "document.querySelectorAll('[data-role=history] .st-entry').length >= 1", 20000),
    "the restored page reconnected and drew the session from the hub again",
  );

  // Its own track: an earlier test leaves the seeded one locked.
  const track = await agentCommand({ command: "track.add", args: { id: "restored-track", name: "Restored" } });
  assert.equal(track.status, 200, `the agent track was refused: ${JSON.stringify(track.body)}`);

  const written = await agentCommand({
    command: "clip.write",
    args: {
      clip_id: "c-restored",
      track_id: "restored-track",
      scene_id: "verse",
      name: "Restored line",
      length_bars: 1,
      notes: [{ t: 0, d: 1, p: 60, v: 100 }],
    },
  });
  assert.equal(written.status, 200, `the agent write was refused: ${JSON.stringify(written.body)}`);
  assert.ok(
    await waitFor(page, "!!document.querySelector('[data-clip-id=c-restored]')", 5000),
    "the reconnected page shows the agent's edit",
  );
});