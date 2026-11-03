/**
 * Studio panel — the server-rendered shell and the client string it carries.
 *
 * The handler is called the way the dashboard calls it (`{db, layout}`, a
 * `res` that collects the body), with a fake database that answers the project
 * list. The client is a string that gets inlined into a `<script>`, so the
 * protocol rules are asserted on the text itself: no backtick, no `${`, and no
 * dynamic value that reaches the page without escaping.
 *
 * The last four tests are the client running for real: `CLIENT_SCRIPT` against
 * a linkedom document built from the page the handler renders, a real Yjs
 * state frame, and a stubbed socket. They cover what the page draws and what a
 * click sends — everything except the network and audio, which the live
 * browser test covers.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import studioPanel from "../bundles/studio/panel/studio.js";
import { CLIENT_SCRIPT, COMMANDS } from "../bundles/studio/panel/client.js";

/** A database fake: enough of `execute` for the project picker. */
function fakeDb(rows) {
  return {
    async execute() {
      return { rows };
    },
  };
}

/** A response fake with the two properties the handler uses. */
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
function layoutFor({ title, content }) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>MARKER${content}</body></html>`;
}

/** Run the panel handler for one request. */
async function render(query, rows = [{ id: 3, name: "Kitchen songs" }]) {
  const res = fakeRes();
  await studioPanel.handler(
    { method: "GET", query, headers: {}, csrfToken: "test-token" },
    res,
    { db: fakeDb(rows), layout: layoutFor },
  );
  assert.equal(res.headersSent, true, "the handler should have sent a page");
  return res.html;
}

test("the panel declares itself the studio dashboard page", () => {
  assert.equal(studioPanel.id, "studio");
  assert.equal(studioPanel.route, "/dashboard/studio");
  assert.equal(studioPanel.navOrder, 45);
  assert.equal(studioPanel.category, "media");
  assert.equal(studioPanel.icon, "music");
  assert.equal(typeof studioPanel.handler, "function");
});

test("handler renders the library and the studio screen", async () => {
  const library = await render({});
  assert.ok(library.includes("MARKER"), "the page goes through the dashboard layout");
  assert.ok(library.includes('data-studio-library="1"'), "the library page is marked for the client");
  assert.ok(library.includes("Kitchen songs"), "the project picker lists the projects");
  assert.ok(library.includes('data-act="new-song"'), "the new-song form is there");
  assert.ok(library.includes('data-role="songs"'), "the song list is filled in by the client");
  assert.ok(library.includes("Connect a project bot to ask") === false, "the library has no ask box");

  const studio = await render({ song: "song-1" });
  assert.ok(studio.includes('data-studio-song="song-1"'), "the page carries the song id");
  assert.ok(studio.includes('data-role="grid"'), "the session grid host is there");
  assert.ok(studio.includes('data-act="play"'), "the transport is there");
  assert.ok(studio.includes('data-role="history"'), "the history panel is there");
  assert.ok(studio.includes('data-role="presence"'), "the presence row is there");
  assert.ok(studio.includes("Connect a project bot to ask"), "the ask box renders disabled");
  assert.ok(studio.includes("<script>"), "the client script is inlined");
  assert.ok(studio.includes(CLIENT_SCRIPT), "the page carries the whole client");
  assert.equal(studio.includes('data-studio-library'), false, "the studio screen is not the library");
});

test("CLIENT_SCRIPT contains no backtick and no ${", () => {
  assert.equal(typeof CLIENT_SCRIPT, "string");
  assert.ok(CLIENT_SCRIPT.length > 1000, "the client is a whole script");
  assert.equal(CLIENT_SCRIPT.includes("\u0060"), false, "no backtick: the panel rule");
  assert.equal(CLIENT_SCRIPT.includes("$" + "{"), false, "no template interpolation");
  assert.ok(CLIENT_SCRIPT.includes("var COMMANDS = ["), "the script declares the command list");
  assert.ok(COMMANDS.length > 0);
  for (const id of COMMANDS) {
    assert.ok(CLIENT_SCRIPT.includes(`'${id}'`), `the script sends ${id}`);
  }
});

test("the client script is a valid classic script that cannot close the script tag", () => {
  assert.equal(CLIENT_SCRIPT.includes("</script"), false, "the inline script must not end its own tag");
  assert.doesNotThrow(() => new vm.Script(CLIENT_SCRIPT), "CLIENT_SCRIPT must parse as JavaScript");

  // Run the top level against a page with no studio root: the script must
  // decide it has nothing to do and leave every listener untouched.
  const context = vm.createContext({
    document: { querySelector: () => null, addEventListener() {} },
    window: { addEventListener() {} },
    console,
  });
  assert.doesNotThrow(() => new vm.Script(CLIENT_SCRIPT).runInContext(context));
});

test("dynamic text is escaped", async () => {
  const hostileId = '"><script>alert(1)</script>';
  const studio = await render({ song: hostileId });
  assert.equal(studio.includes("<script>alert(1)</script>"), false, "the song id cannot add a script");
  assert.ok(studio.includes("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"), "the id is escaped in the attribute");

  const hostileProject = 'A <b>project</b> & "friends"';
  const library = await render({}, [{ id: 7, name: hostileProject }]);
  assert.equal(library.includes("<b>project</b>"), false, "the project name cannot add markup");
  assert.ok(library.includes("A &lt;b&gt;project&lt;/b&gt; &amp; &quot;friends&quot;"), "it is escaped instead");
});

test("the pages carry a working project list even when the query fails", async () => {
  const res = fakeRes();
  await studioPanel.handler(
    { method: "GET", query: {}, headers: {} },
    res,
    {
      db: {
        async execute() {
          throw new Error("no such table: project_spaces");
        },
      },
      layout: layoutFor,
    },
  );
  assert.ok(res.html.includes('data-studio-library="1"'), "the library still renders");
  assert.ok(res.html.includes("No projects yet"), "the picker says so honestly");
});

test("the studio page carries the import map for Yjs's own imports", async () => {
  const studio = await render({ song: "song-1" });
  assert.ok(studio.includes('type="importmap"'), "an import map is needed for lib0");
  assert.ok(studio.includes("/dashboard/studio/assets/lib0/"), "it points at the served lib0 files");
  assert.ok(CLIENT_SCRIPT.includes("/dashboard/studio/assets/yjs.mjs"), "the script imports Yjs by its asset name");
});

/**
 * Run the real client script against a real DOM (linkedom) and a stubbed
 * browser wire, then look at what it drew and what it sent.
 *
 * This is the half of the panel a browser is not needed for: the page's own
 * script, the document it renders from a real Yjs state frame, the commands a
 * click sends, and the focus a clip editor opens and closes. The live test
 * (tests/studio-panel-live.test.js) covers the networked and audio side.
 *
 * @returns {Promise<{page: object, sent: object[], socket: object, frame: Function, click: Function}>}
 */
async function bootClient() {
  const { parseHTML } = await import("linkedom");
  const { newSongDoc, encodeDocState } = await import("../bundles/studio/server/doc.js");
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  await import("../bundles/studio/server/commands/core.js");

  const doc = newSongDoc({ title: "Test song" });
  runCommand(doc, "track.add", { id: "bass", name: "Bass" });
  runCommand(doc, "scene.add", { id: "verse", name: "Verse" });
  runCommand(doc, "scene.add", { id: "chorus", name: "Chorus" });
  runCommand(doc, "clip.write", {
    clip_id: "c1",
    track_id: "bass",
    scene_id: "verse",
    name: "Bass line",
    length_bars: 1,
    notes: [{ t: 0, d: 1, p: 60, v: 100 }],
  });

  const pageHtml = await render({ song: "song-1" });
  const { document, window } = parseHTML(pageHtml);

  /** Every frame the client sent. */
  const sent = [];
  /** The one socket the client opened. */
  const socket = { readyState: 1, handlers: {}, sent };
  socket.addEventListener = (name, handler) => {
    (socket.handlers[name] ||= []).push(handler);
    // The handshake: a real socket opens after the page registers its
    // handlers, and the client says hello from its `open` handler.
    if (name === "open") Promise.resolve().then(() => handler());
  };
  socket.send = (text) => sent.push(JSON.parse(text));
  socket.close = () => {
    socket.readyState = 3;
  };

  /** Push one server frame into the page. */
  const frame = (message) => {
    for (const handler of socket.handlers.message || []) handler({ data: JSON.stringify(message) });
  };

  const sandbox = {
    document,
    window: {
      crypto: globalThis.crypto,
      location: { protocol: "http:", host: "127.0.0.1:1" },
      atob: globalThis.atob,
      addEventListener() {},
      removeEventListener() {},
    },
    WebSocket: function WebSocketStub() {
      return socket;
    },
    fetch: async (url) => ({
      ok: true,
      status: 200,
      async json() {
        return String(url).includes("module-types")
          ? { generators: ["Analog generator"], modules: { "Analog generator": { kind: "generator", controllers: [] } } }
          : [];
      },
    }),
    crypto: globalThis.crypto,
    atob: globalThis.atob,
    console,
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
  };

  // The page imports Yjs from the dashboard's asset route; here the same
  // module is imported straight from the bundle, so the test needs no server.
  // (The route itself is covered by tests/studio-panel-live.test.js.)
  const yjsUrl = pathToFileURL(
    new URL("../bundles/studio/node_modules/yjs/dist/yjs.mjs", import.meta.url).pathname,
  ).href;
  const scriptText = CLIENT_SCRIPT.replace("'/dashboard/studio/assets/yjs.mjs'", JSON.stringify(yjsUrl));
  assert.notEqual(scriptText, CLIENT_SCRIPT, "the test replaces the Yjs asset URL with the file on disk");
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
  run(
    sandbox.document,
    sandbox.window,
    sandbox.WebSocket,
    sandbox.fetch,
    sandbox.crypto,
    sandbox.atob,
    sandbox.console,
    sandbox.setTimeout,
    sandbox.clearTimeout,
    sandbox.setInterval,
    sandbox.clearInterval,
  );

  const page = document.querySelector(".studio");

  /** Click one element the way a person would. */
  const click = (selector) => {
    const node = document.querySelector(selector);
    assert.ok(node, `nothing matches ${selector}`);
    node.dispatchEvent(new window.Event("click", { bubbles: true }));
    return node;
  };

  /** Let the page's own promises (the Yjs import, a frame) settle. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

  // The Yjs import has to resolve before the state frame can be applied.
  await settle();
  frame({
    type: "state",
    update: Buffer.from(encodeDocState(doc)).toString("base64"),
    history: [
      {
        id: "h3",
        seq: 3,
        command: "clip.write",
        summary: 'Wrote "Bass line" (1 bar) on Bass, Verse',
        author: { kind: "human", id: "local", label: "You" },
        touched: ["clip:c1", "track:bass"],
        undone_by: null,
        created_at: new Date().toISOString(),
      },
    ],
    presence: [],
  });
  await settle();

  return { page, document, window, sent, socket, frame, click, settle };
}

test("the client renders the grid, the history and its own presence", async () => {
  const ui = await bootClient();

  assert.ok(ui.document.querySelector(".st-corner"), "the grid corner (the add buttons) is drawn");
  assert.ok(
    ui.document.querySelector("[data-track-id=bass] .st-name"),
    "the track header is drawn (toast: " + ui.document.querySelector("[data-role=toast]").textContent + ")",
  );
  assert.equal(
    ui.document.querySelector("[data-track-id=bass] .st-name").textContent,
    "Bass",
    "with the track name",
  );
  assert.ok(ui.document.querySelector("[data-track-id=bass] .st-device"), "and its device picker");
  assert.ok(ui.document.querySelector(".st-scene-name"), "the scene row is drawn");

  const clip = ui.document.querySelector("[data-clip-id=c1]");
  assert.ok(clip, "the clip cell is drawn");
  assert.equal(clip.getAttribute("data-author"), "human", "authored by the person by default");
  assert.equal(clip.textContent.startsWith("Bass line"), true, "showing the clip name");

  assert.equal(ui.document.querySelectorAll(".st-entry").length, 1, "the history step is listed");
  assert.ok(
    ui.document.querySelector(".st-entry").textContent.includes("Bass line"),
    "with its summary",
  );
  assert.ok(ui.document.querySelector("[data-act=undo]"), "and an Undo button");
  assert.ok(ui.document.querySelector("[data-role=presence] .st-chip"), "the presence row shows the person");
  assert.equal(ui.document.querySelector("[data-role=title]").textContent, "Test song", "the song title is shown");

  // The socket said hello with the page's song.
  const hello = ui.sent.find((message) => message.type === "hello");
  assert.ok(hello, "the client said hello");
  assert.equal(hello.song_id, "song-1");
  assert.equal(typeof hello.client_id, "string");
  assert.ok(ui.sent.some((message) => message.type === "focus" && message.ref === null), "and joined the presence list");
});

test("a click sends the matching command with a fresh cmd_id", async () => {
  const ui = await bootClient();

  ui.click("[data-act=add-track]");
  const addTrack = ui.sent.find((message) => message.type === "command" && message.command === "track.add");
  assert.ok(addTrack, "+ Track sends track.add");
  assert.equal(typeof addTrack.cmd_id, "string");
  assert.ok(addTrack.cmd_id.length >= 8, "every command carries a client-generated cmd_id");
  assert.equal(addTrack.args.device.type, "Analog generator", "with the first generator from the catalogue");

  ui.click("[data-act=add-scene]");
  assert.ok(
    ui.sent.some((message) => message.command === "scene.add"),
    "+ Scene sends scene.add",
  );

  ui.click("[data-act=new-clip]");
  const newClip = ui.sent.find((message) => message.command === "clip.write");
  assert.ok(newClip, "an empty cell sends clip.write");
  assert.deepEqual(newClip.args.notes, [], "..with no notes: an empty clip");
  assert.equal(newClip.args.length_bars, 1, "..one bar long");

  ui.click("[data-track-id=bass] [data-act=lock]");
  assert.ok(
    ui.sent.some((message) => message.command === "track.lock" && message.args.track_id === "bass"),
    "the lock button sends track.lock",
  );
});

test("opening a clip draws the piano roll and tells the hub what is open", async () => {
  const ui = await bootClient();

  ui.click("[data-clip-id=c1]");
  assert.deepEqual(
    ui.sent.find((message) => message.type === "focus" && message.ref === "clip:c1"),
    { type: "focus", ref: "clip:c1" },
    "the editor announces the clip it has open",
  );
  const roll = ui.document.querySelector("[data-role=editor] .st-roll-svg");
  assert.ok(roll, "the piano roll is drawn");
  const notes = ui.document.querySelectorAll(".st-note");
  assert.equal(notes.length, 1, "one note rect per note");
  assert.equal(notes[0].getAttribute("data-note-index"), "0");

  ui.click("[data-act=close-clip]");
  const last = ui.sent.filter((message) => message.type === "focus").pop();
  assert.equal(last.ref, null, "closing the editor releases the focus");
  assert.equal(ui.document.querySelector("[data-role=editor]").hidden, true, "and hides it");
});

test("an agent's step outlines its clip in the agent colour", async () => {
  const { newSongDoc, encodeDocState } = await import("../bundles/studio/server/doc.js");
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  const ui = await bootClient();

  const doc = newSongDoc({ title: "Test song" });
  runCommand(doc, "track.add", { id: "bass", name: "Bass" });
  runCommand(doc, "scene.add", { id: "verse", name: "Verse" });
  runCommand(doc, "clip.write", {
    clip_id: "c2",
    track_id: "bass",
    scene_id: "verse",
    name: "Agent line",
    length_bars: 1,
    notes: [{ t: 0, d: 0.5, p: 64, v: 100 }],
  });

  ui.frame({
    type: "state",
    update: Buffer.from(encodeDocState(doc)).toString("base64"),
    history: [
      {
        id: "h9",
        seq: 9,
        command: "clip.write",
        summary: 'Wrote "Agent line" (1 bar) on Bass, Verse',
        author: { kind: "agent", id: "agent:mcp", label: "Agent (MCP)" },
        touched: ["clip:c2", "track:bass"],
        undone_by: null,
        created_at: new Date().toISOString(),
      },
    ],
    presence: [
      { client_id: "c", author: { kind: "human", id: "local", label: "You" }, focus: null },
      { client_id: "b", author: { kind: "agent", id: "agent:mcp", label: "Agent (MCP)" }, focus: null },
    ],
  });
  await ui.settle();
  const cell = ui.document.querySelector("[data-clip-id=c2]");
  assert.ok(cell, "the agent's clip is drawn");
  assert.equal(cell.getAttribute("data-author"), "agent", "tagged as the agent's");
  assert.equal(cell.textContent.includes("by the agent"), true, "and says so");
  assert.match(String(cell.getAttribute("style")), /(93|5da9f0)/i, "outlined in the agent colour");
  assert.equal(ui.document.querySelectorAll("[data-role=presence] .st-chip").length, 2, "both people are on the presence row");
});