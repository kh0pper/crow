/**
 * Studio panel — the shell, mounted on the page the handler renders.
 *
 * The song page is now a page of widgets with one top bar and one transport bar
 * (panel/shell.js and panel/transport-bar.js), and panel/studio.js inlines both,
 * plus the layout model they read, before the client. This file drives that
 * whole page: the three scripts are evaluated into a linkedom window in the
 * order the page carries them, then the client runs against it with a real Yjs
 * song, a fake engine and a socket stub.
 *
 * What is asserted is the page a person meets: every control of the old header
 * still exists exactly once and sits where the placement table puts it, Play in
 * the bar reaches the same engine call, the mode survives a reload, the boot
 * waits for the operator's default template before it seeds a song (and a
 * failed fetch leaves the song unseeded), and everything the ask box grows stays
 * inside the agent widget's own host.
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
const SONG = "song-shell-page";

/** The track and the scene of the fixture song. */
const TRACK = "bass";
const SCENE = "verse";

/** This device's mode key, and the shape of the two layout keys. */
const MODE_KEY = "crow.studio.mode.v1";

/** The operator's default template used by the seeding cases. */
const TEMPLATE = {
  v: 1,
  layouts: {
    "compose.laptop": { v: 1, shown: [{ id: "takes", size: "l" }, { id: "agent", size: "s" }] },
  },
};

/** The bot this file's fake route names when a case asks for one. */
const BOT = Object.freeze({ bot_id: "bassbot", name: "Bass Bot", project_id: 7 });

// ---- the fixture song ------------------------------------------------------

/**
 * A song with one note track, one scene and one clip, which is all the page
 * furniture needs to draw.
 * @returns {Promise<import("yjs").Doc>}
 */
async function songDoc() {
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  await import("../bundles/studio/server/commands/core.js");

  const doc = newSongDoc({ title: "Shell song", bpm: 120 });
  runCommand(doc, "track.add", { id: TRACK, name: "Bass" });
  runCommand(doc, "scene.add", { id: SCENE, name: "Verse" });
  runCommand(doc, "clip.write", {
    clip_id: "c-bass",
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

/** An in-memory localStorage, so a test can read what the page kept. */
function memoryStorage() {
  const values = new Map();
  return {
    values,
    getItem(key) {
      return values.has(String(key)) ? values.get(String(key)) : null;
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
    positions: [],
    launches: [],
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
    launchScene() {},
    onPosition(listener) {
      engine.positions.push(listener);
      return () => {};
    },
    onLaunch(listener) {
      engine.launches.push(listener);
      return () => {};
    },
    onError() {
      return () => {};
    },
    async nextBarFrame() {
      return { frame: 48000, bar: 1 };
    },
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

/**
 * A controllable EventSource: linkedom has none, so this is the stream the page
 * opens for the bot, and a case pushes frames the way Perch would.
 */
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
 * Render the song page, evaluate its scripts in the order it carries them, and
 * hand back the page a person would be looking at.
 *
 * `template` and `bot` are what the fake gateway answers on those two routes:
 * a function returning an HTTP answer (or a promise of one), so a case can
 * delay, refuse or redirect either.
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
  const engine = fakeEngine();
  const sent = [];
  const asks = [];
  const { FakeEventSource, instances: sources } = makeEventSource();

  const templateAnswer = options.template || (() => response(200, { template: null }));
  const botAnswer = options.bot || (() => response(404, { error: "not_found" }));

  const fetchStub = async (url, init) => {
    const target = String(url);
    const method = String((init && init.method) || "GET").toUpperCase();
    if (target.includes("/layout-template")) return templateAnswer(target, method);
    if (target.includes("/module-types")) return response(200, { generators: [], modules: {} });
    if (target.includes("/project-bot/studio-tools")) return response(200, { ok: true });
    if (target.includes("/project-bot")) return botAnswer(target, method);
    if (target.includes("/api/studio/songs")) {
      return response(200, [{ id: SONG, project_id: 7, title: "Shell song" }]);
    }
    if (target.includes("/api/studio/takes")) {
      return response(503, { error: "Studio cannot take recordings on this instance." });
    }
    if (target.includes("/dashboard/perch-api/bots/")) {
      asks.push({ kind: "spawn", url: target });
      return response(201, { sessionId: "session-1" });
    }
    if (target.includes("/interactive/") && target.includes("/message")) {
      asks.push({ kind: "message", url: target });
      return response(202, { turnId: "turn-1" });
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

  const sessionValues = new Map();
  const windowListeners = {};
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
    StudioEngine: { create: async () => engine },
    addEventListener(name, handler) {
      (windowListeners[name] ||= []).push(handler);
    },
    removeEventListener(name, handler) {
      const list = windowListeners[name] || [];
      const at = list.indexOf(handler);
      if (at >= 0) list.splice(at, 1);
    },
  };

  // The page's own three scripts, in the order the page carries them: the
  // layout model, the shell and the transport bar. They land on the SAME window
  // the client is handed, so `window.StudioShell` is what the client mounts.
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

  await settle();
  frame({
    type: "state",
    update: Buffer.from(encodeDocState(doc)).toString("base64"),
    history: [],
    presence: [],
  });
  await settle();

  const page = document.querySelector(".studio");
  assert.ok(page, "the rendered page carries the studio shell");

  return {
    document,
    domWindow,
    window: windowStub,
    page,
    engine,
    sent,
    storage,
    sources,
    asks,
    settle,
    waitFor,
    frame,
    /** Click a node the way a person would. */
    click(selector) {
      const node = typeof selector === "string" ? document.querySelector(selector) : selector;
      assert.ok(node, `nothing matches ${selector}`);
      node.dispatchEvent(new domWindow.Event("click", { bubbles: true }));
      return node;
    },
    /** Let every timer the page left behind go, and tear the page down. */
    stop() {
      document.dispatchEvent(new domWindow.Event("turbo:before-cache"));
      for (const handle of timers) clearTimeout(handle);
      timers.clear();
    },
  };
}

// ---- the page's own helpers ----------------------------------------------

/** One song's stored layout key. */
function layoutKey(songId, mode, sizeClass) {
  return `crow.studio.layout.v2.${songId}.${mode}.${sizeClass}`;
}

/** The marker that a song has already been handed the template. */
function seededKey(songId) {
  return `crow.studio.layoutSeeded.v2.${songId}`;
}

/** The widget ids on the widget area, in page order. */
function shownWidgets(page) {
  const area = page.querySelector("[data-role=studio-widgets]");
  return Array.from(area.children)
    .filter((node) => node.getAttribute && node.getAttribute("data-widget"))
    .map((node) => node.getAttribute("data-widget"));
}

/** How many nodes of the page match one selector. */
function count(document, selector) {
  return document.querySelectorAll(selector).length;
}

/** The one node a selector must match, or a failure naming how many did. */
function only(document, selector) {
  const found = document.querySelectorAll(selector);
  assert.equal(found.length, 1, `${selector} must exist exactly once, found ${found.length}`);
  return found[0];
}

/** Whether a node is inside another one. */
function inside(node, ancestor) {
  let at = node ? node.parentNode : null;
  while (at) {
    if (at === ancestor) return true;
    at = at.parentNode;
  }
  return false;
}

/** The page's own style text. */
function stylesOf(html) {
  const found = /<style>([\s\S]*?)<\/style>/.exec(html);
  assert.ok(found, "the page carries its style block");
  return found[1];
}

// ---- every control of the old header has a home --------------------------

test("every control of the old header exists exactly once, where the placement table puts it", async () => {
  const ui = await bootPage();
  const { document, page } = ui;
  await ui.waitFor(() => page.querySelector("[data-role=studio-top]"), "the shell to mount");
  await ui.settle();

  // Every control the old header carried, once.
  for (const act of [
    "play", "stop", "pause", "record", "metronome",
    "midi-connect", "midi-learn",
    "rec-timeline", "split", "zoom-out", "zoom-in",
    "mode-session", "mode-arrangement", "mode-mixer",
    "layout-menu", "layout-edit", "layout-reset", "layout-save-default", "layout-clear-default",
  ]) {
    only(document, `[data-act=${act}]`);
  }
  for (const role of [
    "title", "presence", "bpm", "position", "rec-status", "output-latency",
    "output-bar", "output-device", "output-note",
    "rec-notice", "timeline-notice", "performance-notice",
    "midi-state", "midi-bar", "zoom", "tl-tools", "toast", "ask",
  ]) {
    only(document, `[data-role=${role}]`);
  }
  only(document, "[data-role=studio-top]");
  only(document, "[data-role=transport-bar]");
  only(document, "[data-role=studio-widgets]");
  only(document, "[data-role=studio-screen]");
  only(document, "#st-ask");

  // The top bar: the way to the song list, the title, the three views, the
  // presence row and the one overflow menu.
  const top = only(document, "[data-role=studio-top]");
  const songs = only(document, ".st-back");
  assert.match(String(songs.textContent), /Songs/, "the back link is the Songs control");
  assert.equal(songs.getAttribute("href"), "/dashboard/studio", "and it goes to the song list");
  assert.equal(inside(songs, top), true, "it is in the top bar");
  assert.equal(inside(only(document, "[data-role=title]"), top), true, "the title is in the top bar");
  assert.equal(inside(only(document, ".st-modes"), top), true, "the three views are in the top bar");
  assert.equal(inside(only(document, "[data-role=presence]"), top), true, "the presence row is in the top bar");
  assert.equal(inside(only(document, "[data-act=layout-menu]"), top), true, "the Layout menu is in the top bar");
  for (const act of ["layout-edit", "layout-reset", "layout-save-default", "layout-clear-default"]) {
    assert.equal(
      inside(only(document, `[data-act=${act}]`), only(document, "[data-role=layout-entries]")),
      true,
      `${act} is one of the Layout menu's entries`,
    );
  }

  // The transport bar: play, stop, pause, record, the readout, the tempo, the
  // click, the output picker, the recording status and the latency reading.
  const bar = only(document, "[data-role=transport-bar]");
  for (const selector of [
    "[data-act=play]", "[data-act=stop]", "[data-act=pause]", "[data-act=record]",
    "[data-act=metronome]", "[data-role=position]", "[data-role=bpm]",
    "[data-role=rec-status]", "[data-role=output-bar]", "[data-role=output-latency]",
  ]) {
    assert.equal(inside(only(document, selector), bar), true, `${selector} is in the transport bar`);
  }

  // The timeline's tools are a strip under the top bar, and the notices sit
  // right beside them.
  const strips = only(document, ".st-strips");
  assert.equal(inside(only(document, "[data-role=tl-tools]"), strips), true, "the tools are under the top bar");
  assert.equal(strips.hasAttribute("hidden"), false);
  assert.equal(
    only(document, "[data-role=tl-tools]").hasAttribute("hidden"),
    true,
    "the timeline's tools are away while the session grid is what is open",
  );
  for (const role of ["rec-notice", "timeline-notice", "performance-notice"]) {
    assert.equal(inside(only(document, `[data-role=${role}]`), strips), true, `${role} is under the top bar`);
  }

  // The agent's host: the wrapper the handler renders, with the Ask label and
  // the box as its direct children.
  const ask = only(document, "[data-role=ask]");
  const label = only(document, ".st-ask-label");
  const box = only(document, ".st-ask");
  assert.equal(label.parentNode, ask, "the label is a direct child of the agent host");
  assert.equal(box.parentNode, ask, "the ask box is a direct child of the agent host");
  assert.equal(only(document, "#st-ask").parentNode, box, "#st-ask keeps its own parent");
  assert.equal(inside(box, only(document, "[data-widget=agent]")), true, "and the host is the agent widget");

  ui.stop();
});

test("the Songs list and its project filter stay on the page they belong to", async () => {
  // The song page reaches the list through its Songs control; the list itself,
  // with the project filter, is the library page's own.
  const library = {
    html: "",
    send(body) {
      this.html = String(body);
    },
  };
  await studioPanel.handler({ query: {}, headers: {} }, library, {
    db: panelDb(),
    layout: minimalLayout,
  });
  const { parseHTML } = await import("linkedom");
  const { document } = parseHTML(library.html);
  only(document, "[data-role=songs]");
  only(document, "[data-role=project-filter]");
});

test("the MIDI controls live in the MIDI widget's header, and in the Layout menu when it is in the tray", async () => {
  const ui = await bootPage();
  const { document, page, domWindow } = ui;
  await ui.waitFor(() => page.querySelector("[data-role=studio-top]"), "the shell to mount");
  await ui.settle();

  // Compose is the default mode, where the MIDI widget is in the tray: its
  // strip is the Layout menu's own entry.
  const enter = only(document, "[data-role=layout-midi]");
  assert.equal(inside(only(document, "[data-act=midi-connect]"), enter), true, "the controls are the menu's entry");
  assert.equal(inside(only(document, "[data-act=midi-learn]"), enter), true);
  assert.equal(inside(only(document, "[data-role=midi-state]"), enter), true);

  // Perform shows the widget, and the strip moves into its frame header.
  ui.click("[data-mode=perform]");
  await ui.settle();
  const frame = only(document, "[data-widget=midi]");
  assert.equal(frame.hasAttribute("hidden"), false, "the MIDI widget is on the page");
  const head = frame.querySelector(".st-widget-head");
  assert.equal(inside(only(document, "[data-act=midi-connect]"), head), true, "the strip is the frame's header");
  assert.equal(inside(only(document, "[data-act=midi-learn]"), head), true);
  assert.equal(inside(only(document, "[data-role=midi-state]"), head), true);

  // And back again.
  ui.click("[data-mode=compose]");
  await ui.settle();
  assert.equal(
    inside(only(document, "[data-act=midi-connect]"), only(document, "[data-role=layout-midi]")),
    true,
    "back in the tray, the controls are the menu's entry again",
  );
  assert.ok(domWindow);
  ui.stop();
});

test("the timeline's tools are on the page only while the arrangement is open", async () => {
  const ui = await bootPage();
  const { document, page } = ui;
  await ui.waitFor(() => page.querySelector("[data-role=studio-top]"), "the shell to mount");
  await ui.settle();

  const tools = only(document, "[data-role=tl-tools]");
  assert.equal(tools.hasAttribute("hidden"), true, "the grid is what is open");

  ui.click("[data-act=mode-arrangement]");
  await ui.settle();
  assert.equal(tools.hasAttribute("hidden"), false, "the lanes came up with their tools");
  assert.equal(only(document, "[data-role=timeline]").hidden, false, "and the lanes are what is open");

  ui.click("[data-act=mode-mixer]");
  await ui.settle();
  assert.equal(tools.hasAttribute("hidden"), true, "the mixer has no timeline tools");

  ui.click("[data-act=mode-session]");
  await ui.settle();
  assert.equal(tools.hasAttribute("hidden"), true, "and neither has the grid");

  ui.stop();
});

test("Play in the transport bar reaches the same engine call as before", async () => {
  const ui = await bootPage();
  await ui.waitFor(() => ui.page.querySelector("[data-role=transport-bar]"), "the transport bar to mount");
  await ui.settle();

  assert.equal(ui.engine.plays, 0, "nothing is playing yet");
  ui.click("[data-act=play]");
  await ui.waitFor(() => ui.engine.plays === 1, "the engine to be told to play");
  assert.equal(ui.engine.plays, 1, "one Play, one engine call");

  ui.click("[data-act=stop]");
  await ui.settle();
  assert.equal(ui.engine.stops > 0, true, "and Stop reaches the engine too");

  ui.stop();
});

test("the transport bar stays on the page with the arrangement and the mixer open", async () => {
  const ui = await bootPage();
  const { document, page } = ui;
  await ui.waitFor(() => page.querySelector("[data-role=transport-bar]"), "the transport bar to mount");
  await ui.settle();

  const bar = only(document, "[data-role=transport-bar]");
  assert.equal(bar.parentNode, page, "the bar is a layer of the page, not of a screen");
  assert.equal(inside(bar, only(document, "[data-role=studio-screen]")), false);
  assert.equal(bar.hasAttribute("hidden"), false);

  ui.click("[data-act=mode-arrangement]");
  await ui.settle();
  assert.equal(only(document, "[data-role=studio-widgets]").hasAttribute("hidden"), true, "the lanes took the page");
  assert.equal(bar.hasAttribute("hidden"), false, "and the transport is still there");
  assert.equal(inside(only(document, "[data-act=play]"), bar), true);

  ui.click("[data-act=mode-mixer]");
  await ui.settle();
  assert.equal(only(document, "[data-role=mixer]").hidden, false, "the mixer is what is open");
  assert.equal(bar.hasAttribute("hidden"), false, "and the transport is still there too");

  ui.stop();
});

test("the studio's mode survives a reload", async () => {
  const storage = memoryStorage();
  const first = await bootPage({ storage });
  await first.waitFor(() => first.page.querySelector("[data-role=studio-top]"), "the shell to mount");
  await first.settle();

  const pressed = (ui, mode) => ui.page.querySelector(`[data-role=mode-switch] [data-mode=${mode}]`)
    .getAttribute("aria-pressed");
  assert.equal(pressed(first, "compose"), "true", "a device that never chose starts in Compose");

  first.click("[data-mode=record]");
  await first.settle();
  assert.equal(storage.getItem(MODE_KEY), "record", "the choice is this device's");
  assert.deepEqual(shownWidgets(first.page), ["scene-grid", "takes", "midi", "history"], "and the page followed it");
  first.stop();

  const second = await bootPage({ storage });
  await second.waitFor(() => second.page.querySelector("[data-role=studio-top]"), "the shell to mount");
  await second.settle();
  assert.equal(pressed(second, "record"), "true", "a reload comes back in the mode it was left in");
  assert.equal(pressed(second, "compose"), "false");
  assert.deepEqual(shownWidgets(second.page), ["scene-grid", "takes", "midi", "history"]);
  second.stop();
});

// ---- the operator's default template -------------------------------------

test("the boot waits for the template, seeds the song from it, and remembers it did", async () => {
  let resolve = null;
  const held = new Promise((done) => {
    resolve = done;
  });
  const ui = await bootPage({ template: () => held });
  const { document, page, storage } = ui;

  await ui.settle();
  assert.equal(page.querySelector("[data-role=studio-top]"), null, "the shell opens only once the song is seeded");
  assert.equal(storage.getItem(seededKey(SONG)), null, "nothing is seeded while the answer is out");

  resolve(response(200, { template: TEMPLATE }));
  await ui.waitFor(() => page.querySelector("[data-role=studio-top]"), "the shell to mount");
  await ui.settle();

  assert.equal(storage.getItem(seededKey(SONG)), "1", "the song is marked as handed the template");
  assert.deepEqual(
    JSON.parse(storage.getItem(layoutKey(SONG, "compose", "laptop"))).shown,
    TEMPLATE.layouts["compose.laptop"].shown,
    "the template's own layout is the song's",
  );
  assert.deepEqual(
    JSON.parse(storage.getItem(layoutKey(SONG, "record", "tablet"))).shown,
    [{ id: "scene-grid", size: "m" }, { id: "takes", size: "l" }, { id: "midi", size: "s" }, { id: "history", size: "s" }],
    "and every other slot is materialized from the built-in default",
  );
  assert.deepEqual(shownWidgets(page), ["takes", "agent"], "the page shows the template's layout");
  assert.ok(document.querySelector("[data-role=studio-top]"));

  ui.stop();
});

test("a failed template fetch leaves the song unseeded", async () => {
  const storage = memoryStorage();
  const ui = await bootPage({
    storage,
    template: () => Promise.reject(new Error("this gateway does not answer")),
  });
  const { document, page } = ui;
  await ui.waitFor(() => page.querySelector("[data-role=studio-top]"), "the shell to open anyway");
  await ui.settle();

  assert.equal(storage.getItem(seededKey(SONG)), null, "no marker: the next boot asks again");
  assert.equal(storage.getItem(layoutKey(SONG, "compose", "laptop")), null, "and no slot was written");
  assert.deepEqual(shownWidgets(page), ["scene-grid", "editor", "history"], "the page fell back to the built-in default");
  assert.ok(document.querySelector("[data-role=transport-bar]"), "the transport bar mounted as well");

  ui.stop();
});

test("a song that was already seeded keeps its own layout when a template exists", async () => {
  const storage = memoryStorage();
  storage.setItem(seededKey(SONG), "1");
  storage.setItem(
    layoutKey(SONG, "compose", "laptop"),
    JSON.stringify({ v: 1, shown: [{ id: "history", size: "s" }, { id: "takes", size: "l" }] }),
  );

  const ui = await bootPage({ storage, template: () => response(200, { template: TEMPLATE }) });
  await ui.waitFor(() => ui.page.querySelector("[data-role=studio-top]"), "the shell to mount");
  await ui.settle();

  assert.deepEqual(shownWidgets(ui.page), ["history", "takes"], "the song's own layout is untouched");
  assert.deepEqual(
    JSON.parse(storage.getItem(layoutKey(SONG, "compose", "laptop"))).shown,
    [{ id: "history", size: "s" }, { id: "takes", size: "l" }],
  );

  ui.stop();
});

// ---- the agent widget ----------------------------------------------------

test("an ask reply and the give-tools offer are descendants of the agent's host", async () => {
  const ui = await bootPage({
    bot: () => response(200, { ...BOT, has_studio_tools: true, setup_url: null }),
  });
  const { document, page } = ui;
  await ui.waitFor(() => page.querySelector("[data-role=studio-top]"), "the shell to mount");
  await ui.waitFor(() => page.querySelector("#st-ask").disabled === false, "the box to be usable");

  const ask = only(document, "[data-role=ask]");
  const input = only(document, "#st-ask");
  input.value = "what is this song";
  ui.click(".st-ask button");
  await ui.settle();

  const log = only(document, "[data-role=ask-log]");
  assert.equal(inside(log, ask), true, "the transcript is inside the agent's host");
  assert.match(String(log.textContent), /what is this song/, "the person's own line is in it");

  // The bot's reply, pushed the way Perch pushes it.
  await ui.waitFor(() => ui.sources.length > 0, "the turn's stream");
  const source = ui.sources[ui.sources.length - 1];
  assert.ok(source, "the page opened a stream for the turn");
  source.emit("reply", { text: "A two-track sketch at 120." });
  await ui.settle();
  const reply = only(document, ".st-ask-reply");
  assert.equal(inside(reply, ask), true, "the reply is inside the agent's host");
  assert.match(String(reply.textContent), /two-track sketch/);

  ui.stop();

  const offer = await bootPage({
    bot: () => response(200, { ...BOT, has_studio_tools: false, setup_url: null }),
  });
  await offer.waitFor(() => offer.page.querySelector("[data-role=studio-top]"), "the shell to mount");
  await offer.waitFor(() => offer.page.querySelector("[data-role=ask-give]"), "the give-tools offer");
  const note = only(offer.document, "[data-role=ask-give]");
  assert.equal(inside(note, only(offer.document, "[data-role=ask]")), true, "the offer is inside the agent's host");
  assert.match(String(only(offer.document, "[data-role=ask-give] button").textContent), /Studio tools/);
  offer.stop();
});

test("with the agent in the tray a reply marks it unread, and showing it clears the mark", async () => {
  const ui = await bootPage({
    bot: () => response(200, { ...BOT, has_studio_tools: true, setup_url: null }),
  });
  const { document, page } = ui;
  await ui.waitFor(() => page.querySelector("[data-role=studio-top]"), "the shell to mount");
  await ui.waitFor(() => page.querySelector("#st-ask").disabled === false, "the box to be usable");

  const agent = only(document, "[data-widget=agent]");
  assert.equal(agent.parentNode, only(document, "[data-role=widget-tray]"), "the agent starts in the tray");
  const dot = only(document, ".st-unread");
  assert.equal(dot.hasAttribute("hidden"), true, "nothing unread yet");

  only(document, "#st-ask").value = "anything";
  ui.click(".st-ask button");
  await ui.settle();

  assert.equal(inside(only(document, "[data-role=ask-log]"), only(document, "[data-role=ask]")), true,
    "the reply landed in the log while the widget was hidden");
  assert.equal(dot.hasAttribute("hidden"), false, "and the widget wears the unread dot");

  // Show the agent through the Layout menu's own editing.
  ui.click("[data-act=layout-menu]");
  ui.click("[data-act=layout-edit]");
  await ui.settle();
  const add = agent.querySelector("[data-act=widget-add]");
  assert.ok(add, "the tray frame offers Add while the layout is edited");
  ui.click(add);
  await ui.settle();

  assert.equal(agent.parentNode, only(document, "[data-role=studio-widgets]"), "the agent is on the page");
  assert.equal(agent.hasAttribute("hidden"), false);
  assert.equal(dot.hasAttribute("hidden"), true, "showing the agent clears the unread dot");

  ui.stop();
});

// ---- the fixed layers ----------------------------------------------------

test("the toast sits above the transport bar and the page ends above it", async () => {
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
  const styles = stylesOf(res.html);

  assert.match(
    styles,
    /\.studio\s*\{\s*padding-bottom:\s*var\(--st-transport-h/,
    "the page reserves the bar's own height at its bottom",
  );
  assert.match(
    styles,
    /\.studio \.st-transport-bar \{[^}]*bottom:\s*calc\(var\(--crow-player-h, 0px\) \+ var\(--shell-tabs-h, 0px\)\)/,
    "the bar ends on the player bar and the shell's tabs",
  );
  assert.match(
    styles,
    /\.studio \.st-toast \{\s*bottom:\s*calc\(var\(--crow-player-h, 0px\) \+ var\(--shell-tabs-h, 0px\) \+ var\(--st-transport-h, 0px\) \+ 24px\)/,
    "the toast rises by the player bar, the shell's tabs and the bar",
  );
  assert.match(styles, /\.studio \.st-transport-bar \{[^}]*z-index:\s*1050/, "the bar's layer");
  assert.match(styles, /\.studio \.st-toast \{[^}]*z-index:\s*1200/, "and the toast is above it");
  assert.match(
    styles,
    /\.studio \{\s*overflow: hidden; overflow: clip;\s*\}/,
    "the page clips without becoming a scroll container, so the top bar can stick",
  );
  assert.match(
    styles,
    /\.studio \.st-chrome\[hidden\] \{\s*display:\s*none/,
    "the emptied header the shell takes out of the page stays out",
  );
  assert.match(
    styles,
    /\.studio \.st-widget-head \{[^}]*touch-action:\s*pan-y/,
    "a swipe that starts on a frame header reaches the handler",
  );

  // One style block: the page carries the shell's rules as well as its own.
  assert.match(styles, /\.studio \.st-widget\b/, "the shell's widget rules are in the page");
  assert.match(styles, /\.studio \.st-widget-tab\b/, "including the phone tabs");
});

test("the song page carries the shell's scripts and the library page does not", async () => {
  const song = {
    html: "",
    send(body) {
      this.html = String(body);
    },
  };
  await studioPanel.handler({ query: { song: SONG }, headers: {} }, song, {
    db: panelDb(),
    layout: minimalLayout,
  });
  const library = {
    html: "",
    send(body) {
      this.html = String(body);
    },
  };
  await studioPanel.handler({ query: {}, headers: {} }, library, {
    db: panelDb(),
    layout: minimalLayout,
  });

  for (const global of ["StudioShellLayout", "StudioShell", "StudioTransport"]) {
    assert.equal(
      song.html.includes("window." + global + " ="),
      true,
      `the song page defines window.${global}`,
    );
    assert.equal(
      library.html.includes("window." + global + " ="),
      false,
      `the library page does not carry window.${global}`,
    );
  }

  // The three come before the client, which mounts them at boot.
  const shellAt = song.html.indexOf("window.StudioShellLayout =");
  const clientAt = song.html.indexOf("'crow-studio-mode:'");
  assert.ok(clientAt > shellAt, "the shell is defined before the client that mounts it");
});