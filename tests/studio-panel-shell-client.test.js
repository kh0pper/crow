/**
 * Studio panel — the client's own view state on a phone page.
 *
 * The shell is mounted on the page the handler renders (see
 * tests/studio-panel-shell-page.test.js for that whole page), and this file
 * drives the client against it with a real Yjs song. Three things it pins:
 *
 *   - the editor widget comes forward ONCE when a clip is opened, a later
 *     render never takes a phone's tab back from where the operator put it, and
 *     a clip closed and opened again comes forward a second time;
 *   - a scene launch the engine refused leaves nothing queued for the next bar;
 *   - the client keeps no copy of the shell's mode key.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import studioPanel from "../bundles/studio/panel/studio.js";
import { CLIENT_SCRIPT } from "../bundles/studio/panel/client.js";
import { SHELL_LAYOUT_SCRIPT } from "../bundles/studio/panel/shell-layout.js";
import { SHELL_SCRIPT } from "../bundles/studio/panel/shell.js";
import { TRANSPORT_SCRIPT } from "../bundles/studio/panel/transport-bar.js";
import { encodeDocState, newSongDoc } from "../bundles/studio/server/doc.js";

/** The song the page is opened on. */
const SONG = "song-shell-client";

/** The track and the scene of the fixture song. */
const TRACK = "bass";
const SCENE = "verse";

/** The clip the fixture song carries. */
const CLIP = "c-bass";

/** The width a phone lays out at. */
const PHONE = 500;

// ---- the fixture song ------------------------------------------------------

/**
 * A song with one note track, one scene and one clip.
 * @returns {Promise<import("yjs").Doc>}
 */
async function songDoc() {
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  await import("../bundles/studio/server/commands/core.js");

  const doc = newSongDoc({ title: "Client song", bpm: 120 });
  runCommand(doc, "track.add", { id: TRACK, name: "Bass" });
  runCommand(doc, "scene.add", { id: SCENE, name: "Verse" });
  runCommand(doc, "clip.write", {
    clip_id: CLIP,
    track_id: TRACK,
    scene_id: SCENE,
    name: "Bass line",
    length_bars: 1,
    notes: [{ t: 0, d: 1, p: 60, v: 100 }],
  });
  return doc;
}

// ---- the page's surroundings ---------------------------------------------

/** A database fake for the panel handler: no projects to list. */
function panelDb() {
  return {
    async execute() {
      return { rows: [] };
    },
  };
}

/** The stand-in dashboard layout: a bare document around the panel content. */
function minimalLayout({ title, content }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>`
    + `<body>${content}</body></html>`;
}

/** An in-memory localStorage. */
function memoryStorage() {
  const values = new Map();
  return {
    values,
    getItem(key) {
      return values.has(String(key)) ? String(values.get(String(key))) : null;
    },
    setItem(key, value) {
      values.set(String(key), String(value));
    },
    removeItem(key) {
      values.delete(String(key));
    },
  };
}

/** The panel's take store, in memory: every call answers, nothing is kept. */
function fakeTakeStore() {
  return {
    async putChunk() { return true; },
    async getChunk() { return null; },
    async countChunks() { return { count: 0, bytes: 0 }; },
    async getPending() { return null; },
    async listPending() { return []; },
    async putPending() { return true; },
    async deletePending() { return true; },
    async getLatency() { return null; },
    async putLatency() { return true; },
    async getAudio() { return null; },
    async putAudio() { return true; },
    async clearAudio() { return true; },
  };
}

/** A context stand-in: the nodes the page builds for monitoring and its clock. */
function fakeContext() {
  const gain = { gain: { value: 1 }, connect() {}, disconnect() {} };
  return {
    sampleRate: 48000,
    state: "running",
    currentTime: 0,
    destination: {},
    createGain: () => gain,
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
    resume: async () => {},
    close() {},
  };
}

/** The engine stand-in: what the page asked it to play, and its listeners. */
function fakeEngine() {
  const engine = {
    plays: 0,
    stops: 0,
    launched: [],
    node: { connect() {} },
    setSong() {},
    setMode() {},
    seek() {},
    play() {
      engine.plays += 1;
    },
    pause() {},
    stop() {
      engine.stops += 1;
    },
    stopAll() {},
    launchScene(id) {
      engine.launched.push(String(id));
    },
    launchClip(id) {
      engine.launched.push(String(id));
    },
    onPosition() { return () => {}; },
    onLaunch() { return () => {}; },
    onError() { return () => {}; },
    async nextBarFrame() { return { frame: 48000, bar: 1 }; },
    async loadAudio() {},
    unloadAudio() {},
  };
  return engine;
}

/** The navigator stand-in: no inputs, and no Web Locks. */
function fakeNavigator() {
  return {
    locks: null,
    mediaDevices: {
      async enumerateDevices() {
        return [];
      },
      async getUserMedia() {
        throw new Error("this page records nothing");
      },
    },
  };
}

/** A controllable EventSource: linkedom has none. */
function makeEventSource() {
  const instances = [];
  class FakeEventSource {
    constructor(url) {
      this.url = String(url);
      this.handlers = {};
      instances.push(this);
    }

    addEventListener(name, handler) {
      (this.handlers[name] ||= []).push(handler);
    }

    close() {}

    emit(name, frame) {
      for (const handler of this.handlers[name] || []) handler({ data: JSON.stringify(frame) });
    }
  }
  return { FakeEventSource, instances };
}

/** An HTTP answer with the two properties the page reads. */
function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async arrayBuffer() {
      return new ArrayBuffer(0);
    },
  };
}

/** The width media queries the shell and the pointer check ask about. */
function matchesFor(width, media) {
  const text = String(media);
  const min = /min-width:\s*(\d+)px/.exec(text);
  if (min) return width >= Number(min[1]);
  const max = /max-width:\s*(\d+)px/.exec(text);
  if (max) return width <= Number(max[1]);
  return false;
}

// ---- booting the whole page ----------------------------------------------

/**
 * Render the song page, evaluate its three shell scripts in page order, and run
 * the client against the same window.
 *
 * `width` decides the size class the shell lays out for, and `engineCreate` is
 * the engine module's own factory, so a case can make the engine refuse.
 * @param {object} [options]
 * @returns {Promise<object>}
 */
async function bootPage(options = {}) {
  const { parseHTML } = await import("linkedom");

  const doc = options.doc || (await songDoc());
  const res = {
    html: "",
    send(body) {
      this.html = String(body);
    },
  };
  await studioPanel.handler({ query: { song: SONG }, headers: {} }, res, {
    db: panelDb(),
    layout: minimalLayout,
  });
  assert.ok(res.html.includes(`data-studio-song="${SONG}"`), "the handler rendered the song page");

  const { document, window: domWindow } = parseHTML(res.html);
  const storage = options.storage || memoryStorage();
  const width = options.width === undefined ? 1280 : options.width;
  const engine = options.engine || fakeEngine();
  const engineCreate = options.engineCreate || (async () => engine);
  const sent = [];

  const fetchStub = async (url) => {
    const target = String(url);
    if (target.includes("/layout-template")) return response(200, { template: null });
    if (target.includes("/module-types")) return response(200, { generators: [], modules: {} });
    if (target.includes("/project-bot/studio-tools")) return response(200, { ok: true });
    if (target.includes("/project-bot")) return response(404, { error: "not_found" });
    if (target.includes("/api/studio/songs")) {
      return response(200, [{ id: SONG, project_id: 7, title: "Client song" }]);
    }
    if (target.includes("/api/studio/takes")) {
      return response(503, { error: "Studio cannot take recordings on this instance." });
    }
    return response(200, {});
  };

  const socket = { readyState: 1, handlers: {} };
  socket.addEventListener = (name, handler) => {
    (socket.handlers[name] ||= []).push(handler);
    if (name === "open") Promise.resolve().then(() => handler());
  };
  socket.send = (text) => sent.push(JSON.parse(text));
  socket.close = () => {
    socket.readyState = 3;
  };

  const { FakeEventSource, instances } = makeEventSource();
  const sessionValues = new Map();
  const windowStub = {
    crypto: globalThis.crypto,
    innerWidth: width,
    localStorage: storage,
    sessionStorage: {
      getItem: (key) => (sessionValues.has(String(key)) ? sessionValues.get(String(key)) : null),
      setItem: (key, value) => sessionValues.set(String(key), String(value)),
      removeItem: (key) => sessionValues.delete(String(key)),
    },
    matchMedia: (media) => ({
      media: String(media),
      matches: matchesFor(width, media),
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    }),
    location: { protocol: "http:", host: "127.0.0.1:1", reload() {} },
    atob: globalThis.atob,
    confirm: () => true,
    prompt: () => null,
    EventSource: FakeEventSource,
    AudioContext: function AudioContextStub() {
      return fakeContext();
    },
    StudioTakeStore: fakeTakeStore(),
    StudioEngine: {
      create(ctx, config) {
        return engineCreate(ctx, config);
      },
    },
    addEventListener() {},
    removeEventListener() {},
  };

  // The page's own three scripts, in the order the page carries them.
  const shellScripts = new Function(
    "window",
    "document",
    `${SHELL_LAYOUT_SCRIPT}\n${SHELL_SCRIPT}\n${TRANSPORT_SCRIPT}`,
  );
  shellScripts(windowStub, document);
  assert.ok(windowStub.StudioShell, "the shell script is evaluated");
  assert.ok(windowStub.StudioTransport, "the transport bar script is evaluated");
  assert.ok(windowStub.StudioShellLayout, "the layout model script is evaluated");

  const yjsUrl = pathToFileURL(
    new URL("../bundles/studio/node_modules/yjs/dist/yjs.mjs", import.meta.url).pathname,
  ).href;
  const scriptText = CLIENT_SCRIPT.replace(
    "'/dashboard/studio/assets/yjs.mjs'",
    JSON.stringify(yjsUrl),
  );
  assert.notEqual(scriptText, CLIENT_SCRIPT, "the test swaps the Yjs asset URL for the file on disk");

  const timers = new Set();
  const run = new Function(
    "document",
    "window",
    "navigator",
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
    document,
    windowStub,
    fakeNavigator(),
    function WebSocketStub() {
      return socket;
    },
    fetchStub,
    globalThis.crypto,
    globalThis.atob,
    console,
    (fn, ms) => {
      const handle = setTimeout(() => {
        timers.delete(handle);
        try {
          fn();
        } catch {
          // A page torn down under its own timer has nothing left to run.
        }
      }, ms);
      timers.add(handle);
      return handle;
    },
    (handle) => {
      timers.delete(handle);
      clearTimeout(handle);
    },
    () => 0,
    () => {},
  );

  const settle = async (rounds = 8) => {
    for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  };
  const waitFor = async (predicate, what, ms = 4000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("timed out waiting for " + what);
  };
  const frame = (message) => {
    for (const handler of socket.handlers.message || []) handler({ data: JSON.stringify(message) });
  };
  const pushState = () => frame({
    type: "state",
    update: Buffer.from(encodeDocState(doc)).toString("base64"),
    history: [],
    presence: [],
  });

  await settle();
  pushState();
  await settle();

  const page = document.querySelector(".studio");
  assert.ok(page, "the rendered page carries the studio shell");

  return {
    document,
    domWindow,
    window: windowStub,
    page,
    doc,
    engine,
    sent,
    storage,
    sources: instances,
    settle,
    waitFor,
    frame,
    pushState,
    /** Click a node the way a person would. */
    click(selector) {
      const node = typeof selector === "string" ? document.querySelector(selector) : selector;
      assert.ok(node, `nothing matches ${selector}`);
      node.dispatchEvent(new domWindow.Event("click", { bubbles: true }));
      return node;
    },
    /** Whether one node is the tab the strip has open. */
    tabOpen(id) {
      const tab = document.querySelector(`[data-widget-tab=${id}]`);
      assert.ok(tab, `nothing matches the ${id} tab`);
      return tab.getAttribute("aria-selected") === "true";
    },
    /** Let every timer the page left behind go, and tear the page down. */
    stop() {
      document.dispatchEvent(new domWindow.Event("turbo:before-cache"));
      for (const handle of timers) clearTimeout(handle);
      timers.clear();
    },
  };
}

// ---- the editor widget and a phone's tabs --------------------------------

/** Every widget the shell was asked to bring forward, in order. */
function recordShowCalls(page) {
  const shell = page.__studioShell;
  assert.ok(shell && typeof shell.show === "function", "the shell is mounted on the page");
  const calls = [];
  const show = shell.show;
  shell.show = function (id) {
    calls.push(String(id));
    return show.call(shell, id);
  };
  return calls;
}

test("a clip opened on a phone brings the editor forward once, and a later render leaves the tab alone", async () => {
  const ui = await bootPage({ width: PHONE });
  await ui.waitFor(() => ui.page.querySelector("[data-role=studio-top]"), "the shell to mount");
  await ui.settle();

  const calls = recordShowCalls(ui.page);
  assert.equal(ui.tabOpen("scene-grid"), true, "the grid is the tab the page opens on");
  assert.equal(ui.tabOpen("editor"), false);

  ui.click("[data-act=open-clip]");
  await ui.settle();
  assert.equal(ui.tabOpen("editor"), true, "opening a clip from closed brings the editor forward");
  assert.deepEqual(calls, ["editor"], "and it asks the shell exactly once");

  ui.click("[data-widget-tab=scene-grid]");
  await ui.settle();
  assert.equal(ui.tabOpen("scene-grid"), true, "the operator is on the grid");

  // Any render: here the hub re-sending the song's state.
  await ui.pushState();
  await ui.settle();
  assert.equal(ui.tabOpen("scene-grid"), true, "a render leaves the tab where the operator put it");
  assert.equal(ui.tabOpen("editor"), false);
  assert.deepEqual(calls, ["editor"], "and the shell is not asked again");

  // A second clip still open, still no tab change.
  await ui.pushState();
  await ui.settle();
  assert.equal(ui.tabOpen("scene-grid"), true);
  assert.deepEqual(calls, ["editor"]);

  ui.stop();
});

test("a clip reopened on a phone brings its widget forward again", async () => {
  const ui = await bootPage({ width: PHONE });
  await ui.waitFor(() => ui.page.querySelector("[data-role=studio-top]"), "the shell to mount");
  await ui.settle();

  const calls = recordShowCalls(ui.page);

  ui.click("[data-act=open-clip]");
  await ui.settle();
  assert.equal(ui.tabOpen("editor"), true, "the first open brings the editor forward");
  assert.deepEqual(calls, ["editor"], "and asks the shell once");

  // The operator closes the clip: nothing is open, and the widget that was in
  // front has nothing to show any more.
  ui.click("[data-act=close-clip]");
  await ui.settle();

  // They leave to the grid tab, and tap the very same clip again.
  ui.click("[data-widget-tab=scene-grid]");
  await ui.settle();
  assert.equal(ui.tabOpen("scene-grid"), true, "the operator is on the grid");

  ui.click("[data-act=open-clip]");
  await ui.settle();
  assert.equal(ui.tabOpen("editor"), true, "reopening the clip brings the editor forward again");
  assert.deepEqual(calls, ["editor", "editor"], "and the shell is asked a second time");

  ui.stop();
});

// ---- the transport bar's queued scene ------------------------------------

test("a scene launch the engine refused leaves nothing queued for the next bar", async () => {
  const ui = await bootPage({
    engineCreate: () => Promise.reject(new Error("this page has no engine")),
  });
  await ui.waitFor(() => ui.page.querySelector(".st-scene-next"), "the bar's readout");
  await ui.settle();

  const next = () => ui.document.querySelector(".st-scene-next");
  assert.equal(next().textContent, "-", "nothing is queued yet");

  ui.click("[data-act=launch-scene]");
  await ui.settle();
  assert.equal(next().textContent, "-", "the launch that failed is not waiting for a bar");

  // The bar repaints on the next render, and that is the pass that would carry a
  // scene the failed launch left behind.
  await ui.pushState();
  await ui.settle();
  assert.equal(next().textContent, "-", "and a later render does not name one either");

  ui.stop();
});

test("a scene launch the engine took is what the bar names next", async () => {
  const engine = fakeEngine();
  const ui = await bootPage({ engine });
  await ui.waitFor(() => ui.page.querySelector(".st-scene-next"), "the bar's readout");
  await ui.settle();

  ui.click("[data-act=launch-scene]");
  await ui.waitFor(
    () => ui.document.querySelector(".st-scene-next").textContent === "Next: Verse",
    "the queued scene in the readout",
  );
  assert.deepEqual(engine.launched, [SCENE], "and the engine was asked for that scene");

  ui.stop();
});

// ---- the view state the shell owns ---------------------------------------

test("the client keeps no copy of the shell's mode key", () => {
  assert.equal(CLIENT_SCRIPT.includes("crow.studio.mode"), false, "the mode key is the shell's");
  assert.equal(CLIENT_SCRIPT.includes("studioMode"), false, "and no view field shadows it");
  assert.equal(CLIENT_SCRIPT.includes("storedStudioMode"), false);
});