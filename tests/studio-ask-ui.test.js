/**
 * The ask box as a person meets it: their own line the moment they press Send,
 * the working line under it, replies drawn from the markup the SERVER rendered,
 * the render cards those replies offer, and the two notes a disabled box shows.
 *
 * The client is a string emitted into the panel page, so it is tested by
 * running it: the page is the one the panel route renders, the DOM is linkedom,
 * the socket is a stub, and `fetch` reaches this file's express server, where a
 * fake Studio router answers the project-bot, studio-tools and render-info
 * routes and a fake Perch API records the session it is asked to drive. Replies
 * are pushed into a stub `window.EventSource` — linkedom has none — which is the
 * stream the page would read in a browser.
 *
 * What is asserted is the DOM the page produced and the requests it made, never
 * the script text.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import express, { Router } from "express";
import { CLIENT_SCRIPT } from "../bundles/studio/panel/client.js";
import { newSongDoc, encodeDocState } from "../bundles/studio/server/doc.js";
import studioPanel from "../bundles/studio/panel/studio.js";

/** The song the page is opened on. */
const SONG = "song-ask-1";

/** The song's project, and the bot this file's fake route answers for it. */
const PROJECT = 21;
const BOT = Object.freeze({ bot_id: "bassbot", name: "Bass Bot" });

/** The project-bot answer of a bot that can already use Studio. */
const WITH_TOOLS = Object.freeze({
  bot_id: BOT.bot_id,
  name: BOT.name,
  project_id: PROJECT,
  has_studio_tools: true,
  setup_url: null,
});

/** The CSRF token this page's cookie carries, and the fake route accepts. */
const CSRF = "csrf-ok";

/**
 * The Studio routes the page drives, all answering from state the test owns.
 * @returns {object} the recorder, with its `router` attached
 */
function fakeStudio() {
  const state = {
    /** The project-bot answer; a test replaces it. */
    bot: { status: 200, body: { ...WITH_TOOLS } },
    /** Every studio-tools press, with the header it carried. */
    gives: [],
    /** A queue of studio-tools answers; the default grants the tools. */
    giveReplies: [],
    /** Render name -> `{status, body}` for the info route. */
    infos: {},
    /** Every render name the info route was asked about. */
    infoAsks: [],
    /** The bot routes this page reached, in order. */
    hits: [],
  };
  const router = Router();
  router.get("/api/studio/songs/:id/project-bot", (_req, res) => {
    state.hits.push("project-bot");
    res.status(state.bot.status).json(state.bot.body);
  });
  router.post("/api/studio/songs/:id/project-bot/studio-tools", (req, res) => {
    state.hits.push("studio-tools");
    state.gives.push({
      song: String(req.params.id),
      body: req.body,
      csrf: String(req.get("x-crow-csrf") || ""),
    });
    const reply = state.giveReplies.length
      ? state.giveReplies.shift()
      : { status: 200, body: { ok: true, already: false } };
    res.status(reply.status).json(reply.body);
  });
  router.get("/api/studio/songs/:id/renders/:name/info", (req, res) => {
    state.hits.push("render-info");
    const name = String(req.params.name);
    state.infoAsks.push(name);
    const reply = state.infos[name];
    if (!reply) return res.status(404).json({ error: "There is no such render in this song." });
    return res.status(reply.status).json(reply.body);
  });
  state.router = router;
  return state;
}

/**
 * A recorder for the Perch interactive API the box drives: the spawn, the
 * message, and nothing else (the stream is a stub in the page).
 * @returns {object} the recorder, with its `router` attached
 */
function fakePerch() {
  const state = {
    spawns: [],
    messages: [],
    /** A queue of message answers; the default is a 202 with a turn id. */
    messageReplies: [],
  };
  const router = Router();
  router.post("/dashboard/perch-api/bots/:id/interactive", (req, res) => {
    state.spawns.push({ bot_id: String(req.params.id), body: req.body });
    res.status(201).json({ sessionId: "session-1" });
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
 * Boot the two fake APIs on 127.0.0.1:0.
 * @param {import("node:test").TestContext} t
 */
async function boot(t) {
  const perch = fakePerch();
  const studio = fakeStudio();

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(perch.router);
  app.use(studio.router);

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
  return { base: `http://127.0.0.1:${port}`, perch, studio };
}

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
 * A controllable EventSource: linkedom has none, so this is the stream the page
 * opens, and a test pushes frames the way the gateway would.
 * @returns {{FakeEventSource: Function, instances: object[]}}
 */
function makeEventSource() {
  const instances = [];
  class FakeEventSource {
    constructor(url) {
      this.url = String(url);
      this.handlers = {};
      this.closed = false;
      instances.push(this);
    }

    addEventListener(name, handler) {
      (this.handlers[name] ||= []).push(handler);
    }

    close() {
      this.closed = true;
    }

    /** One server frame of the given event name. */
    emit(name, frame) {
      for (const handler of this.handlers[name] || []) handler({ data: JSON.stringify(frame) });
    }
  }
  return { FakeEventSource, instances };
}

/**
 * Run the page's own client script for real.
 *
 * Timers of a second or longer are held rather than scheduled: that is the ask
 * box's silence timer, and holding it is what lets a test fire it. Everything
 * shorter runs as usual.
 *
 * @param {import("node:test").TestContext} t
 * @param {object} options
 * @param {string} options.base - the express app's origin
 * @param {object} options.perch - the fake Perch recorder
 * @param {object} options.studio - the fake Studio recorder
 * @param {Array<[string, string]>} [options.seed] - sessionStorage entries
 * @returns {Promise<object>} the page handle the tests drive
 */
async function bootAskPage(t, { base, perch, studio, seed = [] }) {
  const { parseHTML } = await import("linkedom");

  const html = await songPage(SONG);
  const { document, window: domWindow } = parseHTML(html);

  // The page's own cookie, which the studio-tools press has to send back.
  Object.defineProperty(document, "cookie", {
    configurable: true,
    get: () => `crow_csrf=${CSRF}`,
  });

  const stored = new Map();
  const sessionStorage = {
    getItem: (key) => (stored.has(String(key)) ? stored.get(String(key)) : null),
    setItem: (key, value) => stored.set(String(key), String(value)),
    removeItem: (key) => stored.delete(String(key)),
  };
  for (const [key, value] of seed) sessionStorage.setItem(key, value);

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
  const currentSocket = () => sockets[sockets.length - 1];

  const { FakeEventSource, instances: sources } = makeEventSource();

  /** Held long timers: handle -> `{ms, fn}`. */
  const longTimers = new Set();
  /** Timers that really run, cleared when the test ends. */
  const live = new Set();
  t.after(() => {
    for (const handle of live) clearTimeout(handle);
    live.clear();
    longTimers.clear();
  });

  const windowStub = {
    crypto: globalThis.crypto,
    location: { protocol: "http:", host: "127.0.0.1:1" },
    atob: globalThis.atob,
    addEventListener() {},
    removeEventListener() {},
    sessionStorage,
    EventSource: FakeEventSource,
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
        if (Number(ms) >= 1000) {
          const handle = { ms: Number(ms), fn, long: true };
          longTimers.add(handle);
          return handle;
        }
        const handle = setTimeout(() => {
          live.delete(handle);
          try {
            fn();
          } catch {
            // A page torn down under a timer has nothing left to run.
          }
        }, ms);
        live.add(handle);
        return handle;
      },
      (handle) => {
        if (!handle) return;
        if (handle.long) {
          longTimers.delete(handle);
          return;
        }
        clearTimeout(handle);
        live.delete(handle);
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

  /** Push one server frame into the page's current socket (the document). */
  const frame = (message) => {
    for (const handler of currentSocket().handlers.message || []) handler({ data: JSON.stringify(message) });
  };

  /** Push one Perch frame into the page's EventSource. */
  const sse = (name, payload) => {
    const source = sources[sources.length - 1];
    assert.ok(source, "the page should have opened a Perch stream");
    source.emit(name, payload);
  };

  /** Dispatch a document-level event the way Turbo does. */
  const fire = (name) => document.dispatchEvent(new domWindow.Event(name));

  /** Run every held timer of this duration; answers how many there were. */
  const fireLong = (ms) => {
    const hits = [...longTimers].filter((handle) => handle.ms === ms);
    for (const handle of hits) {
      longTimers.delete(handle);
      handle.fn();
    }
    return hits.length;
  };

  /** How many held timers of this duration are waiting right now. */
  const countLong = (ms) => [...longTimers].filter((handle) => handle.ms === ms).length;

  /** Click a node the way a person would. */
  const click = (node) => node.dispatchEvent(new domWindow.Event("click", { bubbles: true }));

  // The song the page shows.
  await settle();
  frame({
    type: "state",
    update: Buffer.from(encodeDocState(newSongDoc({ title: "Bass song" }))).toString("base64"),
    history: [],
    presence: [],
  });
  await settle();

  const askInput = document.querySelector("#st-ask");
  const askButton = document.querySelector(".st-ask button");
  assert.ok(askInput && askButton, "the page carries the ask box");

  const youLines = () => [...document.querySelectorAll(".st-ask-you")];
  const replyNodes = () => [...document.querySelectorAll(".st-ask-reply")];
  const errorLines = () => [...document.querySelectorAll(".st-ask-error")];
  const working = () => document.querySelector("[data-role=ask-working]");
  const note = (role) => document.querySelector("[data-role=" + role + "]");
  const logText = () => {
    const node = document.querySelector("[data-role=ask-log]");
    return node ? String(node.textContent || "") : "";
  };

  return {
    document,
    page,
    stored,
    studio,
    frame,
    sse,
    fire,
    settle,
    waitFor,
    fireLong,
    countLong,
    click,
    youLines,
    replyNodes,
    errorLines,
    lastReply: () => replyNodes()[replyNodes().length - 1] || null,
    working,
    note,
    logText,
    askInput,
    askButton,
    /** The box is usable once the project-bot answer has arrived. */
    ready: () => waitFor(() => askInput.disabled === false, "the project-bot answer"),
    /** Type a question and press Send, without waiting for anything. */
    send(text) {
      askInput.value = text;
      click(askButton);
    },
    /** Type a question, press Send, and wait for it to reach the fake Perch API. */
    async ask(text) {
      const before = perch.messages.length;
      this.send(text);
      await waitFor(() => perch.messages.length > before, "the question to reach the fake Perch API");
      await settle();
    },
  };
}

// ---- item 10: the message and the working line -------------------------

test("Send draws the person's line and a working line before anything answers", async (t) => {
  const { base, perch, studio } = await boot(t);
  const ui = await bootAskPage(t, { base, perch, studio });

  await ui.ready();
  assert.equal(ui.note("ask-setup"), null, "a bot with the Studio tools needs no note");
  assert.equal(ui.note("ask-give"), null, "and no grant either");

  ui.send("Make the bass line fatter");

  // Nothing has answered yet: the line and the working line are already there.
  assert.equal(perch.messages.length, 0, "no question has reached the bot yet");
  const lines = ui.youLines();
  assert.equal(lines.length, 1, "the person's message is drawn at once");
  assert.equal(lines[0].textContent, "Make the bass line fatter", "exactly what was typed, with no prefix");
  assert.ok(lines[0].classList.contains("st-ask-line"), "the line is a transcript row like the rest");
  assert.equal(ui.askInput.value, "", "and the box is cleared for the next question");

  const working = ui.working();
  assert.ok(working, "a working line is up while the turn runs");
  assert.equal(working.getAttribute("role"), "status", "it is announced as a status");
  assert.equal(working.textContent, "Bass Bot is working\u2026", "it names the bot at work");

  await ui.waitFor(() => perch.messages.length === 1, "the question to reach the bot");
  await ui.settle();
  assert.ok(ui.working(), "still working until the turn's reply frame arrives");

  ui.sse("reply", { type: "reply", text: "Done.", html: "<p>Done.</p>" });
  assert.equal(ui.working(), null, "the reply frame takes the working line down");
});

test("a refused message post leaves an error line and no working line", async (t) => {
  const { base, perch, studio } = await boot(t);
  const ui = await bootAskPage(t, { base, perch, studio });

  await ui.ready();
  perch.messageReplies.push({ status: 500, body: { error: "gateway_down" } });
  await ui.ask("are you there?");

  await ui.waitFor(() => ui.errorLines().length === 1, "the failure line");
  assert.match(ui.errorLines()[0].textContent, /Could not reach Bass Bot\./, "the same sentence as before");
  assert.equal(ui.working(), null, "the working line is gone with the failure");
  assert.equal(ui.youLines().length, 1, "the person's own line stays");
});

test("a silent turn is reported when the 180 s timer runs out", async (t) => {
  const { base, perch, studio } = await boot(t);
  const ui = await bootAskPage(t, { base, perch, studio });

  await ui.ready();
  await ui.ask("anything?");
  assert.ok(ui.working(), "the box is waiting for a frame");

  const fired = ui.fireLong(180000);
  assert.equal(fired, 1, "exactly one timer was waiting, and it was the 180 s one");
  await ui.settle();

  assert.equal(ui.working(), null, "the working line is replaced, not left up");
  assert.match(ui.logText(), /Bass Bot has not answered yet\. Try again in a moment\./, "the box says so");
  assert.equal(ui.errorLines().length, 1, "as an error line");
  assert.equal(ui.fireLong(180000), 0, "and no second timer is left waiting");
});

test("a frame restarts the silence timer instead of letting it run out", async (t) => {
  const { base, perch, studio } = await boot(t);
  const ui = await bootAskPage(t, { base, perch, studio });

  await ui.ready();
  await ui.ask("anything?");
  assert.equal(ui.countLong(180000), 1, "the send armed the timer");

  ui.sse("text", { type: "text", text: "still thinking", html: "<p>still thinking</p>" });
  assert.equal(ui.countLong(180000), 1, "the frame armed a fresh one in place of the one the send armed");
  assert.ok(ui.working(), "a `text` frame alone does not clear the working line");

  ui.sse("reply", { type: "reply", text: "here it is", html: "<p>here it is</p>" });
  assert.equal(ui.countLong(180000), 0, "the answered turn leaves no timer behind");
  assert.equal(ui.working(), null, "nor a working line");
});

test("teardown clears the wait and the working line", async (t) => {
  const { base, perch, studio } = await boot(t);
  const ui = await bootAskPage(t, { base, perch, studio });

  await ui.ready();
  await ui.ask("anything?");
  assert.ok(ui.working(), "the page is waiting");

  ui.fire("turbo:before-cache");

  assert.equal(ui.working(), null, "a cached page carries no working line");
  assert.equal(ui.fireLong(180000), 0, "and no timer that would draw one after the cache");
  assert.equal(ui.note("ask-setup"), null, "nor any note");
  assert.equal(ui.note("ask-give"), null, "of either kind");
});

// ---- item 14: replies as markdown --------------------------------------

test("an html reply is drawn as markup, a reply without html as text", async (t) => {
  const { base, perch, studio } = await boot(t);
  const ui = await bootAskPage(t, { base, perch, studio });

  await ui.ready();
  await ui.ask("how does it look?");
  ui.sse("reply", {
    type: "reply",
    text: "Loudness report",
    html: "<p>Loudness report</p>"
      + "<div class=\"table-scroll\"><table><tbody><tr><th>LUFS</th><td>-14</td></tr></tbody></table></div>"
      + "<ul><li>one</li></ul>"
      + "<p><a href=\"/dashboard/bot-builder\">Bot Builder</a></p>",
  });

  const marked = ui.lastReply();
  assert.ok(marked, "the reply is a transcript row");
  assert.ok(marked.classList.contains("st-ask-line"), "a row like the others");
  assert.equal(marked.querySelectorAll("table").length, 1, "the table the server rendered is there");
  assert.equal(marked.querySelectorAll("ul li").length, 1, "so is the list");
  const link = marked.querySelector("a");
  assert.ok(link, "and the link");
  assert.equal(link.getAttribute("href"), "/dashboard/bot-builder", "with the address the bot wrote");

  // A frame without html is plain text: model output is never markup here.
  ui.sse("text", { type: "text", text: "<img src=x onerror=alert(1)><script>boom()</script>" });
  const plain = ui.lastReply();
  assert.ok(plain && plain !== marked, "the text frame drew its own row");
  assert.equal(plain.querySelectorAll("img").length, 0, "no image element was built");
  assert.equal(plain.querySelectorAll("script").length, 0, "and no script element");
  assert.equal(
    plain.textContent,
    "<img src=x onerror=alert(1)><script>boom()</script>",
    "the text is shown as words, exactly as it arrived",
  );
});

test("a link to this song's render becomes a player card", async (t) => {
  const { base, perch, studio } = await boot(t);
  studio.infos["mix.wav"] = {
    status: 200,
    body: {
      seconds: 3.2,
      lufs: -14.02,
      true_peak_db: -1.04,
      short_term_max_lufs: -12.5,
      target: { lufs: -14, true_peak_db: -1 },
      meets_target: { lufs: true, true_peak: false },
    },
  };
  const ui = await bootAskPage(t, { base, perch, studio });

  await ui.ready();
  await ui.ask("where is the mix?");
  const path = "/api/studio/songs/" + SONG + "/renders/mix.wav";
  ui.sse("reply", {
    type: "reply",
    text: "[mix.wav](" + path + ")",
    html: "<p><a href=\"" + path + "\">mix.wav</a></p>",
  });

  const node = ui.lastReply();
  const card = node.querySelector(".st-ask-render");
  assert.ok(card, "the link became a card");
  const audio = card.querySelector("audio");
  assert.ok(audio, "with a player");
  assert.equal(audio.getAttribute("src"), path, "pointed at the song's own render route");
  assert.equal(audio.getAttribute("preload"), "none", "which loads nothing until asked");
  assert.ok(audio.hasAttribute("controls"), "with the browser's controls");
  const download = card.querySelector("a");
  assert.ok(download, "and a download link");
  assert.equal(download.textContent, "Download mix.wav", "named after the file");
  assert.equal(download.getAttribute("href"), path + "?download=1", "the download form of the route");
  assert.equal(download.getAttribute("download"), "mix.wav", "which the browser saves");
  assert.equal(node.querySelectorAll("a").length, 1, "the pasted link itself is gone");

  await ui.waitFor(() => studio.infoAsks.length === 1, "the info route");
  await ui.settle();
  const table = card.querySelector("table.st-ask-loud");
  assert.ok(table, "the measured figures fill the card");
  const text = String(table.textContent);
  assert.match(text, /Integrated loudness/, "with the integrated loudness row");
  assert.match(text, /-14\.0 LUFS/, "one decimal, the figure the route gave");
  assert.match(text, /True peak/, "the true peak row");
  assert.match(text, /Short-term max/, "the short-term row when the route has one");
  assert.match(text, /Target/, "the target row when the route has one");
  assert.match(text, /Meets target/, "and whether the render met it");
  assert.match(text, /No/, "the bool the route answered");
});

test("a presigned address becomes the same card and is never left in the page", async (t) => {
  const { base, perch, studio } = await boot(t);
  const ui = await bootAskPage(t, { base, perch, studio });

  await ui.ready();
  await ui.ask("where is the render?");
  const presigned = "http://storage.example.invalid:9000/bucket/p/studio/" + SONG
    + "/1700000000000-x.wav?X-Amz-Signature=abc";
  ui.sse("reply", {
    type: "reply",
    text: "the render",
    html: "<p><a href=\"" + presigned + "\">1700000000000-x.wav</a></p>",
  });

  const node = ui.lastReply();
  const card = node.querySelector(".st-ask-render");
  assert.ok(card, "the storage address became a card too");
  const audio = card.querySelector("audio");
  assert.equal(
    audio.getAttribute("src"),
    "/api/studio/songs/" + SONG + "/renders/1700000000000-x.wav",
    "built from the song id and the validated name, never from the pasted address",
  );
  assert.equal(
    card.querySelector("a").getAttribute("href"),
    "/api/studio/songs/" + SONG + "/renders/1700000000000-x.wav?download=1",
    "and the download link is the gateway's own path",
  );

  // The conversation the page rendered, not the whole page: the client script
  // itself names the presign marker it looks for, so only what was drawn is
  // what matters here.
  const rendered = () => String(ui.document.querySelector("[data-role=ask-log]").outerHTML);
  assert.equal(rendered().includes("X-Amz"), false, "no signature is left anywhere in the conversation");
  assert.equal(rendered().includes("storage.example.invalid"), false, "and no storage host");

  // The same rules on the no-html path: the address is not printed as text.
  ui.sse("text", {
    type: "text",
    text: "here it is http://storage.example.invalid:9000/bucket/p/studio/" + SONG + "/1700000000000-y.wav?X-Amz-Signature=def",
  });
  const plain = ui.lastReply();
  assert.ok(plain.querySelector(".st-ask-render"), "a card is built there too");
  assert.equal(rendered().includes("X-Amz"), false, "and the text path leaves no signature behind either");
});

test("another song's storage address is replaced by (link removed)", async (t) => {
  const { base, perch, studio } = await boot(t);
  const ui = await bootAskPage(t, { base, perch, studio });

  await ui.ready();
  await ui.ask("what about that file?");
  const other = "https://storage.example.invalid/bucket/p/studio/other-song/1700000000000-x.wav";
  ui.sse("reply", {
    type: "reply",
    text: "another song",
    html: "<p><a href=\"" + other + "\">x.wav</a></p>",
  });

  const node = ui.lastReply();
  assert.equal(node.querySelectorAll(".st-ask-render").length, 0, "no card for another song's file");
  assert.equal(node.querySelectorAll("a").length, 0, "and no link to it");
  assert.match(String(node.textContent), /\(link removed\)/, "the words take its place");
  assert.equal(
    String(ui.document.querySelector("[data-role=ask-log]").outerHTML).includes("other-song"),
    false,
    "the address is not left in the conversation",
  );
});

test("a render this Crow cannot describe leaves the card without a table", async (t) => {
  const { base, perch, studio } = await boot(t);
  const ui = await bootAskPage(t, { base, perch, studio });

  await ui.ready();
  await ui.ask("where is that render?");
  const path = "/api/studio/songs/" + SONG + "/renders/gone.wav";
  ui.sse("reply", {
    type: "reply",
    text: "gone",
    html: "<p><a href=\"" + path + "\">gone.wav</a></p>",
  });

  const card = ui.lastReply().querySelector(".st-ask-render");
  assert.ok(card, "the card is still built");
  await ui.waitFor(() => studio.infoAsks.length === 1, "the info route");
  await ui.settle();
  assert.equal(card.querySelector("table"), null, "a 404 leaves no table and no error text");
  assert.ok(card.querySelector("audio"), "the player stays");
});

test("a javascript: link and raw HTML in bot text arrive harmless in the rendered frame", async () => {
  // The page only ever assigns innerHTML from a frame's `html`, and the gateway
  // builds that with renderBotMarkdown — so the frame is tested where it is
  // made, with the real module (never a copy of it).
  const { renderBotMarkdown } = await import("../servers/blog/renderer.js");
  const hostile = [
    "[x](javascript:alert(1))",
    "<img src=x onerror=alert(1)>",
    "<script>alert(1)</script>",
  ].join(" ");

  const html = renderBotMarkdown(hostile);
  assert.equal(typeof html, "string", "the frame still carries markup to draw");
  assert.notEqual(html, "", "and it is not silently emptied");
  assert.equal(/javascript:/i.test(html), false, "no javascript: address survives: " + html);
  assert.equal(/onerror/i.test(html), false, "the image's error handler is gone: " + html);
  assert.equal(/<script/i.test(html), false, "no script element survives: " + html);
  // sanitize-html's allow-list keeps an image as a plain picture (src, alt,
  // title, width, height, loading) and carries no event attribute at all, so
  // the hostile img may arrive as an inert <img> — never a runnable one.
  assert.equal(/<[^>]*\son\w+=/i.test(html), false, "no event handler survives inside any tag: " + html);
});

// ---- items 11 and 13: no bot, and a bot without Studio tools -----------

test("a project with no bot leaves the box disabled with a note and a setup link", async (t) => {
  const { base, perch, studio } = await boot(t);
  studio.bot = {
    status: 200,
    body: {
      bot_id: null,
      name: null,
      project_id: PROJECT,
      has_studio_tools: null,
      setup_url: "/dashboard/bot-builder?new=1&project=" + PROJECT,
    },
  };
  const ui = await bootAskPage(t, { base, perch, studio });

  await ui.waitFor(() => ui.note("ask-setup"), "the setup note");
  assert.equal(ui.askInput.disabled, true, "the box stays disabled");
  assert.equal(ui.askInput.getAttribute("placeholder"), "This project has no bot yet", "and says why");
  const note = ui.note("ask-setup");
  assert.match(String(note.textContent), /This project has no bot, so there is nobody to ask\./, "the sentence");
  const link = note.querySelector("a");
  assert.ok(link, "with a link to set one up");
  assert.equal(link.textContent, "Set up a bot", "named for what it does");
  assert.equal(
    link.getAttribute("href"),
    "/dashboard/bot-builder?new=1&project=" + PROJECT,
    "pointing at Bot Builder's new-bot page for this project",
  );
  assert.deepEqual(studio.hits, ["project-bot"], "and nothing else was asked of the Studio routes");
  assert.equal(perch.spawns.length, 0, "no session was spawned");
});

test("a bot without Studio tools offers the grant and posts nothing until it is pressed", async (t) => {
  const { base, perch, studio } = await boot(t);
  studio.bot = {
    status: 200,
    body: { ...WITH_TOOLS, has_studio_tools: false },
  };
  const key = "crow-studio-ask:" + SONG + ":" + BOT.bot_id;
  const ui = await bootAskPage(t, {
    base,
    perch,
    studio,
    seed: [[key, JSON.stringify({ sid: "session-old", briefed: true })]],
  });

  await ui.waitFor(() => ui.note("ask-give"), "the grant note");
  assert.equal(ui.askInput.disabled, true, "the box is disabled until the bot can use Studio");
  assert.equal(
    ui.askInput.getAttribute("placeholder"),
    "Bass Bot needs Studio tools first",
    "and says what it is waiting for",
  );
  const note = ui.note("ask-give");
  assert.match(String(note.textContent), /Bass Bot cannot use Studio yet\./, "the sentence");
  const give = note.querySelector("button");
  assert.ok(give, "with the one action that changes that");
  assert.equal(give.textContent, "Give Bass Bot Studio tools", "named after the bot");
  assert.equal(studio.gives.length, 0, "nothing has been posted yet");
  assert.equal(perch.spawns.length, 0, "and no session was started");

  ui.click(give);
  await ui.waitFor(() => studio.gives.length === 1, "the studio-tools press");
  assert.equal(studio.gives.length, 1, "exactly one press reached the route");
  assert.equal(studio.gives[0].song, SONG, "for this song");
  assert.deepEqual(studio.gives[0].body, { bot_id: BOT.bot_id }, "naming the bot the page shows");
  assert.equal(studio.gives[0].csrf, CSRF, "with the CSRF header the cookie carries");

  await ui.waitFor(() => ui.askInput.disabled === false, "the box to open");
  assert.equal(ui.askInput.getAttribute("placeholder"), "Ask Bass Bot\u2026", "the usual placeholder");
  assert.match(String(ui.note("ask-give").textContent), /Bass Bot can use Studio now\./, "the note says so");
  assert.equal(ui.note("ask-give").querySelector("button"), null, "and offers nothing more");
  assert.equal(ui.stored.has(key), false, "the session that started before the grant is forgotten");
});

test("a refused grant shows the server's sentence and keeps the box disabled", async (t) => {
  const { base, perch, studio } = await boot(t);
  studio.bot = {
    status: 200,
    body: { ...WITH_TOOLS, has_studio_tools: false },
  };
  const refusal = "That is not this song project's bot any more. Reload the page and try again.";
  studio.giveReplies.push({ status: 409, body: { error: refusal } });
  const ui = await bootAskPage(t, { base, perch, studio });

  await ui.waitFor(() => ui.note("ask-give"), "the grant note");
  ui.click(ui.note("ask-give").querySelector("button"));
  await ui.waitFor(() => studio.gives.length === 1, "the studio-tools press");

  await ui.waitFor(() => String(ui.note("ask-give").textContent).includes(refusal), "the refusal sentence");
  assert.equal(
    ui.note("ask-give").querySelector("button").textContent,
    "Give Bass Bot Studio tools",
    "the button comes back",
  );
  assert.equal(ui.askInput.disabled, true, "and the box stays disabled");
  assert.equal(perch.spawns.length, 0, "no session was started");
});