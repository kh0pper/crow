/**
 * Studio's "Ask the agent" — the project-bot route and the client's half of it.
 *
 * The route (`GET /api/studio/songs/:id/project-bot`) is exercised against a
 * real session hub on a scratch crow.db, an ephemeral express server, and a
 * fake `projectBotOf` whose answer the test controls: that injection is where
 * the `pi_bot_defs` lookup lives in production (the panel loader owns it, see
 * bundles/studio/panel/routes.js), so this file pins the contract instead —
 * the song's own project is what gets asked about, one bot comes back for a
 * project that has one, `{bot_id: null}` for a project that has none, and the
 * dashboard session gate applies like every other Studio route.
 *
 * The client is a string emitted inline into the panel page, so it is tested by
 * running it: the page is the one the panel route renders, the DOM is linkedom,
 * the socket is a stub (the ask box needs none), and `fetch` reaches this
 * file's express server, where a fake Perch interactive API records every body
 * it receives. What is asserted is therefore what the page SENT — the spawn's
 * `briefing: true`, the Studio context in front of the first message, later
 * messages exactly as typed — not what the script text happens to say.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import express, { Router } from "express";
import { WebSocketServer } from "ws";
import { AclError } from "../servers/shared/project-acl.js";
import { createHub } from "../bundles/studio/server/hub.js";
import { initStudioTables } from "../bundles/studio/server/init-tables.js";
import { createStudioWeb } from "../bundles/studio/server/web.js";
import { newSongDoc, encodeDocState } from "../bundles/studio/server/doc.js";
import { CLIENT_SCRIPT } from "../bundles/studio/panel/client.js";
import studioPanel from "../bundles/studio/panel/studio.js";

/** The project with a bot, and one without. */
const PROJECT = 21;
const BOTLESS_PROJECT = 22;

/** The dashboard's author for a song created through the hub. */
const HUMAN = { kind: "human", id: "local", label: "You" };

/** The bot this file's fake `projectBotOf` answers for PROJECT. */
const BOT = Object.freeze({ bot_id: "bassbot", name: "Bass Bot" });

/** The title the song page shows, and therefore what the context names. */
const SONG_TITLE = "Bass song";

/** A scratch libsql client for one test, closed when the test ends. */
function scratchDb(t) {
  const db = createClient({ url: "file:" + join(mkdtempSync(join(tmpdir(), "studio-")), "crow.db") });
  t.after(() => db.close());
  return db;
}

/**
 * A project ACL that allows the two projects here and swallows the audit rows.
 * @returns {{assertProjectExists: Function, assertCapability: Function, appendAudit: Function}}
 */
function fakeAcl() {
  const projects = new Set([PROJECT, BOTLESS_PROJECT]);
  async function assertProjectExists(_db, projectId) {
    const id = Number(projectId);
    if (!projects.has(id)) throw new AclError(`Project #${id} not found`, "not_found");
    return { id };
  }
  async function assertCapability(db, projectId) {
    return assertProjectExists(db, projectId);
  }
  async function appendAudit() {}
  return { assertProjectExists, assertCapability, appendAudit };
}

/**
 * A recorder for the Perch interactive API, plus the two routes the ask box
 * drives. Every request body is kept verbatim; a reply can be overridden per
 * test so a refusal can be exercised too.
 * @returns {object} the recorder (`spawns`, `messages`, `spawnReply`,
 *   `messageReplies`), with its `router` attached
 */
function fakePerch() {
  const state = {
    spawns: [],
    messages: [],
    /** Overrides the spawn answer when set: `{status, body}`. */
    spawnReply: null,
    /** A queue of message answers; the default is a 202 with a turn id. */
    messageReplies: [],
  };
  const router = Router();
  router.post("/dashboard/perch-api/bots/:id/interactive", (req, res) => {
    state.spawns.push({ bot_id: String(req.params.id), body: req.body });
    const reply = state.spawnReply || { status: 201, body: { sessionId: "session-1" } };
    res.status(reply.status).json(reply.body);
  });
  router.post("/dashboard/perch-api/interactive/:sid/message", (req, res) => {
    state.messages.push({ sid: String(req.params.sid), body: req.body });
    const reply = state.messageReplies.length
      ? state.messageReplies.shift()
      : { status: 202, body: { turnId: "turn-1" } };
    res.status(reply.status).json(reply.body);
  });
  state.router = router;
  return state;
}

/**
 * Boot the Studio router on 127.0.0.1:0 with one song per project, and a fake
 * Perch API beside it.
 *
 * @param {import("node:test").TestContext} t
 * @param {{session?: boolean, perch?: object}} [options] - `session: false`
 *   installs a dashboard gate that refuses every request, the way an ended
 *   session answers; `perch` injects the fake Perch recorder (a fresh one is
 *   made otherwise)
 */
async function boot(t, { session = true, perch } = {}) {
  const db = scratchDb(t);
  await initStudioTables(db);
  const hub = createHub({ db, acl: fakeAcl(), onBroadcast: () => {} });

  const botSong = await hub.createSong({ project_id: PROJECT, title: SONG_TITLE, author: HUMAN });
  assert.equal(botSong.ok, true, `createSong was refused: ${botSong.error}`);
  const otherSong = await hub.createSong({ project_id: BOTLESS_PROJECT, title: "Other song", author: HUMAN });
  assert.equal(otherSong.ok, true, `createSong was refused: ${otherSong.error}`);

  /** Every project id the route asked the injected lookup about. */
  const asked = [];
  const web = createStudioWeb({
    hub,
    Router,
    WebSocketServer,
    auth: {
      isAllowedNetwork: () => true,
      sessionFromRequest: () => "good",
      verifySession: async () => ({}),
      csrfTokenAccepted: (_req, presented) => presented === "csrf-ok",
      classifyPeer: () => ({ via: "local" }),
    },
    crowHome: mkdtempSync(join(tmpdir(), "studio-home-")),
    bundleDir: null,
    projectBotOf: async (projectId) => {
      asked.push(Number(projectId));
      return Number(projectId) === PROJECT ? { ...BOT } : null;
    },
  });

  const dashboardAuth = session
    ? (_req, _res, next) => next()
    : (_req, res) => res.status(401).json({ error: "unauthorized" });

  const app = express();
  // The gateway parses JSON for every route before the panel router.
  app.use(express.json({ limit: "1mb" }));
  const fake = perch || fakePerch();
  app.use(fake.router);
  app.use(web.router(dashboardAuth));

  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    try {
      server.closeAllConnections?.();
    } catch {
      // Nothing left to close.
    }
    server.close(() => resolve());
  }));

  const { port } = server.address();
  return {
    hub,
    asked,
    perch: fake,
    botSong: botSong.song_id,
    otherSong: otherSong.song_id,
    base: `http://127.0.0.1:${port}`,
  };
}

/** GET one project-bot answer; returns the status and the parsed body. */
async function projectBot(base, songId) {
  const response = await fetch(`${base}/api/studio/songs/${encodeURIComponent(songId)}/project-bot`);
  return { status: response.status, body: await response.json() };
}

test("project-bot route returns the song project's bot, and null without one", async (t) => {
  const { base, asked, botSong, otherSong } = await boot(t);

  const found = await projectBot(base, botSong);
  assert.equal(found.status, 200, "a song of the bot's project answers 200");
  assert.equal(found.body.bot_id, BOT.bot_id, "the enabled bot of that project is named");
  assert.equal(found.body.name, BOT.name, "with its display name");
  assert.equal(found.body.project_id, PROJECT, "and the project the page files its session under");
  assert.deepEqual(asked, [PROJECT], "the lookup was asked about the song's own project");

  const none = await projectBot(base, otherSong);
  assert.equal(none.status, 200, "a project with no bot is still a valid answer");
  assert.equal(none.body.bot_id, null, "and says so instead of naming a bot");
  assert.equal(none.body.name, null, "there is no name to show either");
});

test("an unknown song has no project bot", async (t) => {
  const { base, asked } = await boot(t);

  const missing = await projectBot(base, "no-such-song");
  assert.equal(missing.status, 404, "a song that is not there is not found");
  assert.deepEqual(asked, [], "and no bot lookup is made for it");
});

test("the project-bot route needs a dashboard session", async (t) => {
  const { base, asked, botSong } = await boot(t, { session: false });

  const refused = await projectBot(base, botSong);
  assert.equal(refused.status, 401, "without a session the route answers like the rest of the dashboard");
  assert.deepEqual(asked, [], "and nothing behind it is read or asked about");
});

test("the client script drives the Perch interactive session for the project bot", () => {
  // The two calls that make a session and drive it, and the stream its replies
  // arrive on. They are built from the one ASK_API constant, so the text
  // carries the paths with the session id in between.
  assert.ok(CLIENT_SCRIPT.includes("'/dashboard/perch-api'"), "the client knows the Perch API prefix");
  assert.ok(CLIENT_SCRIPT.includes("'/bots/'"), "it spawns the bot's interactive session");
  assert.ok(
    CLIENT_SCRIPT.includes("'/interactive/' + encodeURIComponent(sid) + '/message'"),
    "it sends each question to that session",
  );
  assert.ok(
    CLIENT_SCRIPT.includes("'/interactive/' + encodeURIComponent(sid) + '/events'"),
    "and reads the replies from the session's SSE stream",
  );
  assert.ok(
    CLIENT_SCRIPT.includes("'/api/studio/songs/' + encodeURIComponent(activeSongId) + '/project-bot'"),
    "it asks the project-bot route first",
  );

  // The three sentences a person sees when the bot cannot be reached.
  assert.ok(CLIENT_SCRIPT.includes("'The bot engine is not running.'"), "engine_required has its own sentence");
  assert.ok(
    CLIENT_SCRIPT.includes("' is not set up for chat yet (Bot Builder "),
    "perch_not_attached names the bot and where to fix it",
  );
  assert.ok(CLIENT_SCRIPT.includes("'Could not reach '"), "anything else is a plain could-not-reach");
  // The disabled box's own text belongs to the handler's markup, which is why
  // the script reads that placeholder back instead of carrying it.
  assert.ok(
    CLIENT_SCRIPT.includes("askInput.setAttribute('placeholder', askPlaceholder)"),
    "the ask box's resting text is the handler's own placeholder",
  );
});

// ---- the page, running -------------------------------------------------

/** A response fake with the two properties the panel handler uses. */
function fakeRes() {
  return {
    headersSent: false,
    html: "",
    send(body) {
      this.html = String(body);
      this.headersSent = true;
    },
    type() {
      return this;
    },
  };
}

/** The dashboard layout stand-in: the body surrounded by a marker. */
function layoutFor({ content }) {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>MARKER${content}</body></html>`;
}

/**
 * The song page exactly as the panel route renders it, client script included.
 * @param {string} songId
 * @returns {Promise<string>} the page HTML
 */
async function songPage(songId) {
  const res = fakeRes();
  await studioPanel.handler(
    { method: "GET", query: { song: songId }, headers: {} },
    res,
    { db: { async execute() { return { rows: [] }; } }, layout: layoutFor },
  );
  assert.equal(res.headersSent, true, "the panel route should have sent a page");
  return res.html;
}

/**
 * Run the page's own client script for real: the rendered page, linkedom for
 * the DOM, a stub socket (the ask box needs none) and a `fetch` that really
 * reaches the server `boot()` started, so the fake Perch API records what the
 * browser would have sent.
 *
 * @param {import("node:test").TestContext} t
 * @param {object} options
 * @param {string} options.base - the express app's origin
 * @param {string} options.songId - the song the page is opened on
 * @param {object} options.perch - the fake Perch recorder, used to know when a
 *   question has landed
 * @returns {Promise<object>} the page handle the tests drive
 */
async function bootAskPage(t, { base, songId, perch }) {
  const { parseHTML } = await import("linkedom");

  const html = await songPage(songId);
  const { document, window: domWindow } = parseHTML(html);

  // One sessionStorage for this page, shared across a teardown and reboot, so
  // a test can prove the session survives the page being restored.
  const stored = new Map();
  const sessionStorage = {
    getItem: (key) => (stored.has(String(key)) ? stored.get(String(key)) : null),
    setItem: (key, value) => stored.set(String(key), String(value)),
    removeItem: (key) => stored.delete(String(key)),
  };

  const sockets = [];
  function makeSocket() {
    const socket = { readyState: 1, handlers: {} };
    socket.addEventListener = (name, handler) => {
      (socket.handlers[name] ||= []).push(handler);
      if (name === "open") Promise.resolve().then(() => handler());
    };
    socket.send = () => {};
    socket.close = () => {
      socket.readyState = 3;
    };
    sockets.push(socket);
    return socket;
  }
  /** The socket the page holds now (it opens a new one after a reboot). */
  const current = () => sockets[sockets.length - 1];

  /** Timers the page scheduled, cleared when the test ends. */
  const pending = new Set();
  t.after(() => {
    for (const handle of pending) clearTimeout(handle);
    pending.clear();
  });

  const windowStub = {
    crypto: globalThis.crypto,
    location: { protocol: "http:", host: "127.0.0.1:1" },
    atob: globalThis.atob,
    addEventListener() {},
    removeEventListener() {},
    sessionStorage,
  };

  // The page imports Yjs from the dashboard's asset route; here the same module
  // is imported straight from the bundle, so this test needs no server for it.
  const yjsUrl = pathToFileURL(
    new URL("../bundles/studio/node_modules/yjs/dist/yjs.mjs", import.meta.url).pathname,
  ).href;
  const scriptText = CLIENT_SCRIPT.replace(
    "'/dashboard/studio/assets/yjs.mjs'",
    JSON.stringify(yjsUrl),
  );
  assert.notEqual(scriptText, CLIENT_SCRIPT, "the test swaps the Yjs asset URL for the file on disk");

  const run = new Function(
    "document",
    "window",
    "WebSocket",
    "fetch",
    "crypto",
    "atob",
    "console",
    "setTimeout",
    "clearTimeout",
    "setInterval",
    "clearInterval",
    scriptText,
  );
  const start = () =>
    run(
      document,
      windowStub,
      function WebSocketStub() {
        return makeSocket();
      },
      (url, init) => {
        const target = String(url);
        return fetch(target.startsWith("/") ? base + target : target, init);
      },
      globalThis.crypto,
      globalThis.atob,
      console,
      (fn, ms) => {
        const handle = setTimeout(() => {
          pending.delete(handle);
          try {
            fn();
          } catch {
            // A page that was torn down under a timer has nothing left to run.
          }
        }, ms);
        pending.add(handle);
        return handle;
      },
      (handle) => {
        if (handle != null) clearTimeout(handle);
        pending.delete(handle);
      },
      () => 0,
      () => {},
    );
  start();

  const page = document.querySelector(".studio");
  assert.ok(page, "the rendered page carries the studio shell");

  /** Let the page's own promises (the Yjs import, a fetch) settle. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

  /** Wait for something the page does asynchronously. */
  const waitFor = async (predicate, what, ms = 4000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("timed out waiting for " + what);
  };

  /** Push one server frame into the page's current socket. */
  const frame = (message) => {
    for (const handler of current().handlers.message || []) handler({ data: JSON.stringify(message) });
  };

  /** Dispatch a document-level event the way Turbo does. */
  const fire = (name) => document.dispatchEvent(new domWindow.Event(name));

  // The song the page shows: the title the ask box puts in front of the first
  // question comes out of this document.
  await settle();
  frame({
    type: "state",
    update: Buffer.from(encodeDocState(newSongDoc({ title: SONG_TITLE }))).toString("base64"),
    history: [],
    presence: [],
  });
  await settle();

  const askInput = document.querySelector("#st-ask");
  const askButton = document.querySelector(".st-ask button");
  assert.ok(askInput && askButton, "the page carries the ask box");

  /** The transcript the page drew under the box. */
  const askLog = () => {
    const node = document.querySelector("[data-role=ask-log]");
    return node ? String(node.textContent || "") : "";
  };

  return {
    document,
    page,
    stored,
    frame,
    fire,
    settle,
    waitFor,
    askLog,
    rerun: start,
    /** The box is usable once the project-bot answer has arrived. */
    ready: () => waitFor(() => askInput.disabled === false, "the project-bot answer"),
    /** Type a question and press Send. */
    async ask(text) {
      const before = perch.messages.length;
      askInput.value = text;
      askButton.dispatchEvent(new domWindow.Event("click", { bubbles: true }));
      await waitFor(() => perch.messages.length > before, "the question to reach the fake Perch API");
      await settle();
    },
  };
}

test("the first ask carries the song context in the message and briefing:true on spawn", async (t) => {
  const { base, perch, botSong } = await boot(t);
  const ui = await bootAskPage(t, { base, songId: botSong, perch });

  await ui.ready();
  await ui.ask("Make the bass line fatter");

  assert.equal(perch.spawns.length, 1, "one session was spawned");
  assert.equal(perch.spawns[0].bot_id, BOT.bot_id, "for the song project's bot");
  assert.deepEqual(
    perch.spawns[0].body,
    { project_id: PROJECT, briefing: true },
    "the spawn asks for the server-built briefing: the boolean true, and no client text",
  );

  assert.equal(perch.messages.length, 1, "one message was sent");
  assert.equal(perch.messages[0].sid, "session-1", "to the session the spawn returned");
  assert.equal(
    perch.messages[0].body.message,
    '[Crow Studio] You are helping on the song "Bass song" (song id ' + botSong + "). "
      + "Use the studio_* tools; the operator sees every edit live and can undo it. "
      + "Never edit locked tracks; never start or stop the operator's playback."
      + "\n\nMake the bass line fatter",
    "the song context goes in front of the operator's question",
  );
});

test("one session per song: later asks are sent exactly as typed", async (t) => {
  const { base, perch, botSong } = await boot(t);
  const ui = await bootAskPage(t, { base, songId: botSong, perch });

  await ui.ready();
  await ui.ask("first question");
  await ui.ask("second question");

  assert.equal(perch.spawns.length, 1, "the session was spawned once");
  assert.equal(perch.messages.length, 2, "both questions reached it");
  assert.equal(perch.messages[0].sid, perch.messages[1].sid, "on the same session");
  assert.equal(perch.messages[1].body.message, "second question", "a later question carries no context");

  const remembered = JSON.parse(ui.stored.get("crow-studio-ask:" + botSong));
  assert.equal(remembered.sid, "session-1", "the session is remembered under the song");
  assert.equal(remembered.briefed, true, "and it is remembered that it has the context");
});

test("coming back to the song reuses the remembered session", async (t) => {
  const { base, perch, botSong } = await boot(t);
  const ui = await bootAskPage(t, { base, songId: botSong, perch });

  await ui.ready();
  await ui.ask("first question");

  // Turbo caches the page and restores it: the page is torn down and booted
  // again, and the chat must carry on in the same session.
  ui.fire("turbo:before-cache");
  ui.rerun();
  await ui.ready();
  await ui.ask("after the reload");

  assert.equal(perch.spawns.length, 1, "no second session was spawned");
  assert.equal(perch.messages[1].sid, "session-1", "the same session answered");
  assert.equal(perch.messages[1].body.message, "after the reload", "and the context is not repeated");
});

test("a turn still running is reported as the bot still answering", async (t) => {
  const { base, perch, botSong } = await boot(t);
  const ui = await bootAskPage(t, { base, songId: botSong, perch });

  await ui.ready();
  perch.messageReplies.push({ status: 409, body: { error: "turn_in_progress" } });
  await ui.ask("are you there?");

  assert.match(ui.askLog(), /Bass Bot is still answering/, "the box says what is happening");
  assert.equal(perch.spawns.length, 1, "the session is kept: nothing is respawned");
  assert.equal(
    JSON.parse(ui.stored.get("crow-studio-ask:" + botSong)).sid,
    "session-1",
    "and it is still remembered for the next question",
  );
});