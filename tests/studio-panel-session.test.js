/**
 * Studio panel — the session screen's own settings, run for real.
 *
 * `CLIENT_SCRIPT` against a linkedom document built from the page the handler
 * renders, a real Yjs state frame and a stubbed socket — the same rig as
 * tests/studio-panel.test.js, with three additions this file needs: a
 * `localStorage` the page can read and write (or one that refuses), a
 * `navigator.mediaDevices` with outputs to list, and an `AudioContext` class
 * whose `setSinkId` answers are watched (`sinks`), so an output pick can be
 * seen rather than guessed at.
 *
 * What is pinned here:
 *   - the metronome toggle: off at the start, per song in storage, its state
 *     handed to the engine when one exists (and to a newly built one), never a
 *     command, and still working when storage is refused;
 *   - the output picker: outputs only, a pick reaching the context and kept for
 *     the browser, hidden on a browser whose context cannot choose a sink, and
 *     the fall back to the default output, with its sentence, when a device is
 *     gone;
 *   - the session hint: one answer for what the song is missing, the same after
 *     a state frame and after an update frame.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import studioPanel from "../bundles/studio/panel/studio.js";
import { CLIENT_SCRIPT } from "../bundles/studio/panel/client.js";

const YJS_URL = pathToFileURL(
  new URL("../bundles/studio/node_modules/yjs/dist/yjs.mjs", import.meta.url).pathname,
).href;

/** The per-song metronome key the client writes. */
const METRONOME_KEY = "crow.studio.metronome.song-1";
/** The browser-wide output key the client writes. */
const OUTPUT_KEY = "crow.studio.output-device";

// --- the page's server side -------------------------------------------------

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
async function render(query) {
  const res = fakeRes();
  await studioPanel.handler(
    { method: "GET", query, headers: {}, csrfToken: "test-token" },
    res,
    { db: fakeDb([{ id: 3, name: "Kitchen songs" }]), layout: layoutFor },
  );
  assert.equal(res.headersSent, true, "the handler should have sent a page");
  return res.html;
}

// --- storage stand-ins ------------------------------------------------------

/** A `localStorage` that keeps what it is given, the way one in a browser does. */
function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem(key) {
      const name = String(key);
      return map.has(name) ? map.get(name) : null;
    },
    setItem(key, value) {
      map.set(String(key), String(value));
    },
    removeItem(key) {
      map.delete(String(key));
    },
  };
}

/** A `localStorage` that refuses everything: the browser a page must survive. */
function brokenStorage() {
  const refuse = () => {
    throw new Error("this browser keeps nothing");
  };
  return { getItem: refuse, setItem: refuse, removeItem: refuse };
}

// --- the page's browser side ------------------------------------------------

/**
 * A stand-in for the page's AudioContext class.
 *
 * `setSinkId` records every id it is asked for in `Ctx.sinks`, and rejects the
 * one named by `rejectId` — a device that is gone. Options are taken the way
 * the client builds a context (`{latencyHint}`); the properties below are the
 * ones Studio's own code reads.
 */
function audioContextClass(options = {}) {
  const sinks = [];
  class FakeAudioContext {
    constructor() {
      this.destination = { id: "destination" };
      this.sampleRate = 48000;
      this.state = "running";
      this.sinkId = "";
    }
    createGain() {
      return { gain: { value: 1 }, connect() {} };
    }
    setSinkId(deviceId) {
      const wanted = String(deviceId);
      sinks.push(wanted);
      if (wanted === options.rejectId) return Promise.reject(new Error("no such output"));
      this.sinkId = wanted;
      return Promise.resolve();
    }
    resume() {
      return Promise.resolve();
    }
    close() {}
  }
  FakeAudioContext.sinks = sinks;
  return FakeAudioContext;
}

/** The same class on a browser that cannot choose an output at all. */
function audioContextWithoutSink() {
  class NoSinkAudioContext {
    constructor() {
      this.destination = { id: "destination" };
      this.sampleRate = 48000;
      this.state = "running";
    }
    createGain() {
      return { gain: { value: 1 }, connect() {} };
    }
    resume() {
      return Promise.resolve();
    }
    close() {}
  }
  return NoSinkAudioContext;
}

/**
 * A stand-in for the engine client (`window.StudioEngine`): `create` answers a
 * fake engine whose click calls are recorded, so a test can say what the page
 * told it.
 */
function fakeStudioEngine() {
  const calls = { metronome: [], play: 0, songs: 0 };
  return {
    calls,
    create() {
      const engine = {
        node: { connect() {} },
        setMetronome(on) {
          calls.metronome.push(on === true);
        },
        play() {
          calls.play += 1;
        },
        stop() {},
        setSong() {
          calls.songs += 1;
        },
        setMode() {},
        onPosition() {},
        onLaunch() {},
        onError() {},
      };
      return Promise.resolve(engine);
    },
  };
}

// --- the song documents -----------------------------------------------------

/**
 * Register the commands and build a song: the ids given become tracks, scenes.
 * @param {{tracks?: string[], scenes?: string[]}} [shape]
 * @returns {Promise<object>} a Y.Doc
 */
async function docOf(shape = {}) {
  const { newSongDoc } = await import("../bundles/studio/server/doc.js");
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  await import("../bundles/studio/server/commands/core.js");
  const doc = newSongDoc({ title: "Test song" });
  for (const id of shape.tracks || []) {
    runCommand(doc, "track.add", { id, name: id.charAt(0).toUpperCase() + id.slice(1) });
  }
  for (const id of shape.scenes || []) {
    runCommand(doc, "scene.add", { id, name: id.charAt(0).toUpperCase() + id.slice(1) });
  }
  return doc;
}

/** The song the panel tests draw from: one track, two scenes, one clip. */
async function standardDoc() {
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  const doc = await docOf({ tracks: ["bass"], scenes: ["verse", "chorus"] });
  runCommand(doc, "clip.write", {
    clip_id: "c1",
    track_id: "bass",
    scene_id: "verse",
    name: "Bass line",
    length_bars: 1,
    notes: [{ t: 0, d: 1, p: 60, v: 100 }],
  });
  return doc;
}

// --- the rig ----------------------------------------------------------------

/**
 * Run the real client script against a linkedom page and a stubbed wire.
 *
 * @param {object} [options]
 * @param {object} [options.doc] - the Y.Doc to draw instead of the standard song
 * @param {object} [options.storage] - the page's `localStorage` (a stub by default)
 * @param {Array} [options.devices] - what `enumerateDevices` answers
 * @param {boolean} [options.noMedia] - a browser with no `navigator.mediaDevices`
 * @param {Function} [options.Ctx] - the page's AudioContext class
 * @param {boolean} [options.engine] - show the page a `window.StudioEngine`
 * @returns {Promise<object>} the page, its document, and the stubs to look at
 */
async function bootClient(options = {}) {
  const { parseHTML } = await import("linkedom");
  const { encodeDocState } = await import("../bundles/studio/server/doc.js");

  const doc = options.doc || (await standardDoc());
  const storage = options.storage || makeStorage();
  const Ctx = options.Ctx || audioContextClass();
  const engineApi = options.engine ? fakeStudioEngine() : null;

  const pageHtml = await render({ song: "song-1" });
  const { document, window: domWindow } = parseHTML(pageHtml);

  /** Every frame the client sent, across reconnects. */
  const sent = [];
  /** One entry per socket the client opened. */
  const sockets = [];
  /** Timers the page scheduled (a toast's own), so nothing outlives a test. */
  const timers = [];

  function makeSocket() {
    const socket = { readyState: 1, handlers: {} };
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
    sockets.push(socket);
    return socket;
  }

  const current = () => sockets[sockets.length - 1];

  /** Push one server frame into the page's current socket. */
  const frame = (message) => {
    for (const handler of current().handlers.message || []) handler({ data: JSON.stringify(message) });
  };

  const windowStub = {
    crypto: globalThis.crypto,
    localStorage: storage,
    AudioContext: Ctx,
    location: {
      protocol: "http:",
      host: "127.0.0.1:1",
      reload() {},
    },
    atob: globalThis.atob,
    addEventListener() {},
    removeEventListener() {},
  };
  if (engineApi) windowStub.StudioEngine = engineApi;

  const navigatorStub = options.noMedia
    ? {}
    : {
        mediaDevices: {
          async enumerateDevices() {
            return options.devices || [];
          },
        },
      };

  const scriptText = CLIENT_SCRIPT.replace(
    "'/dashboard/studio/assets/yjs.mjs'",
    JSON.stringify(YJS_URL),
  );
  assert.notEqual(scriptText, CLIENT_SCRIPT, "the test replaces the Yjs asset URL with the file on disk");

  const fetchStub = async (url) => ({
    ok: true,
    status: 200,
    async json() {
      return String(url).includes("module-types")
        ? {
            generators: ["Analog generator"],
            modules: { "Analog generator": { kind: "generator", controllers: [] } },
          }
        : [];
    },
  });

  const run = new Function(
    "document",
    "window",
    "WebSocket",
    "fetch",
    "navigator",
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
    function WebSocketStub() {
      return makeSocket();
    },
    fetchStub,
    navigatorStub,
    globalThis.crypto,
    globalThis.atob,
    console,
    (fn) => {
      timers.push(fn);
      return timers.length;
    },
    () => {},
    () => 0,
    () => {},
  );

  /** Let the page's own promises (the Yjs import, a frame) settle. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

  /** Click one element the way a person would. */
  const click = (selector) => {
    const node = document.querySelector(selector);
    assert.ok(node, `nothing matches ${selector}`);
    node.dispatchEvent(new domWindow.Event("click", { bubbles: true }));
    return node;
  };

  /** Pick one value in the output picker, the way choosing a device does. */
  const pickOutput = (value) => {
    const select = document.querySelector("[data-role=output-device]");
    assert.ok(select, "the output picker is on the page");
    const option = [...select.querySelectorAll("option")].find(
      (node) => String(node.value) === String(value),
    );
    assert.ok(option, `the picker lists ${value === "" ? "the default output" : value}`);
    option.selected = true;
    select.dispatchEvent(new domWindow.Event("change", { bubbles: true }));
    return select;
  };

  const ui = {
    document,
    window: domWindow,
    sent,
    sockets,
    engine: engineApi,
    Ctx,
    storage,
    current,
    frame,
    click,
    pickOutput,
    settle,
  };

  await settle();
  frame({
    type: "state",
    update: Buffer.from(encodeDocState(doc)).toString("base64"),
    history: [],
    presence: [],
  });
  await settle();
  return ui;
}

// --- the click toggle -------------------------------------------------------

test("the metronome toggle is off at the start, and its click is this song's own setting", async () => {
  const storage = makeStorage();
  const ui = await bootClient({ storage, engine: true });

  const toggle = ui.document.querySelector("[data-act=metronome]");
  assert.ok(toggle, "the transport carries a Click toggle");
  assert.equal(toggle.textContent, "Click", "with its one-word label");
  assert.equal(toggle.getAttribute("aria-pressed"), "false", "off by default");

  // The engine has to exist before there is a click to switch: Play makes it.
  ui.click("[data-act=play]");
  await ui.settle();
  assert.equal(ui.engine.calls.play, 1, "the fake engine is playing");
  assert.deepEqual(
    ui.engine.calls.metronome,
    [false],
    "a new engine is told the song's setting (off) as it is built",
  );

  const commandsBefore = ui.sent.filter((message) => message.type === "command").length;
  ui.click("[data-act=metronome]");
  await ui.settle();

  assert.equal(toggle.getAttribute("aria-pressed"), "true", "the click is on");
  assert.equal(storage.getItem(METRONOME_KEY), "true", "kept for this song, in this browser");
  assert.deepEqual(ui.engine.calls.metronome, [false, true], "the engine's click was switched on");
  assert.equal(
    ui.sent.filter((message) => message.type === "command").length,
    commandsBefore,
    "the toggle is a local audio setting: it sends no document command",
  );

  ui.click("[data-act=metronome]");
  await ui.settle();
  assert.equal(toggle.getAttribute("aria-pressed"), "false", "a second press turns it off again");
  assert.equal(storage.getItem(METRONOME_KEY), "false", "and that is what the song is left on");
  assert.deepEqual(ui.engine.calls.metronome, [false, true, false], "the engine followed both ways");

  // A page that opens with the stored click on says so, and its own engine is
  // told as it is built.
  storage.setItem(METRONOME_KEY, "true");
  const second = await bootClient({ storage, engine: true });
  const secondToggle = second.document.querySelector("[data-act=metronome]");
  assert.equal(secondToggle.getAttribute("aria-pressed"), "true", "the stored click is drawn");
  second.click("[data-act=play]");
  await second.settle();
  assert.deepEqual(second.engine.calls.metronome, [true], "and handed to the engine it builds");
});

test("a browser that refuses storage still gets a working metronome toggle", async () => {
  const ui = await bootClient({ storage: brokenStorage() });

  const toggle = ui.document.querySelector("[data-act=metronome]");
  assert.equal(toggle.getAttribute("aria-pressed"), "false", "no storage, no choice: off");

  ui.click("[data-act=metronome]");
  await ui.settle();
  assert.equal(toggle.getAttribute("aria-pressed"), "true", "the toggle still works for the session");

  ui.click("[data-act=metronome]");
  await ui.settle();
  assert.equal(toggle.getAttribute("aria-pressed"), "false", "and back again");
});

// --- the output picker ------------------------------------------------------

test("the output picker lists the outputs only, and the pick reaches the context and the browser", async () => {
  const storage = makeStorage();
  const Ctx = audioContextClass();
  const ui = await bootClient({
    storage,
    Ctx,
    devices: [
      { kind: "audiooutput", deviceId: "out-1", label: "Studio monitors" },
      { kind: "audioinput", deviceId: "in-1", label: "Interface input" },
      { kind: "audiooutput", deviceId: "out-2", label: "" },
    ],
  });

  const bar = ui.document.querySelector("[data-role=output-bar]");
  const select = ui.document.querySelector("[data-role=output-device]");
  assert.equal(bar.hidden, false, "the picker is shown on a browser that can choose an output");
  assert.deepEqual(
    [...select.querySelectorAll("option")].map((option) => option.textContent),
    ["Default output", "Studio monitors", "Output 2"],
    "the two outputs and nothing else (an unlabelled one gets its position)",
  );

  // No context is made at page load: browsers need a gesture for that.
  assert.equal(Ctx.sinks.length, 0, "nothing was asked of an output before anything was chosen");

  assert.equal(select.value, "", "the default output is what the page starts on");

  ui.pickOutput("out-1");
  await ui.settle();

  assert.deepEqual(Ctx.sinks, ["out-1"], "the page's context was asked for that output");
  assert.equal(storage.getItem(OUTPUT_KEY), "out-1", "the choice is this browser's, not this song's");
  assert.equal(select.value, "out-1", "and the picker shows it");

  const commands = ui.sent.filter((message) => message.type === "command");
  assert.equal(commands.length, 0, "choosing an output sends no document command");

  // A browser whose context cannot choose a sink is never shown the picker.
  const plain = await bootClient({ storage: makeStorage(), Ctx: audioContextWithoutSink() });
  const plainSelect = plain.document.querySelector("[data-role=output-device]");
  assert.equal(
    plain.document.querySelector("[data-role=output-bar]").hidden,
    true,
    "with no setSinkId the whole control is hidden",
  );
  assert.equal(plainSelect.hidden, true, "the picker itself is hidden too");

  // And a browser with no device list at all is the same story.
  const noMedia = await bootClient({ storage: makeStorage(), noMedia: true });
  assert.equal(
    noMedia.document.querySelector("[data-role=output-bar]").hidden,
    true,
    "with no enumerateDevices there is nothing to list, so it is hidden",
  );
});

test("an output the browser refuses falls back to the default one and says so", async () => {
  const storage = makeStorage();
  const Ctx = audioContextClass({ rejectId: "gone-1" });
  const ui = await bootClient({
    storage,
    Ctx,
    engine: true,
    devices: [
      { kind: "audiooutput", deviceId: "gone-1", label: "Unplugged interface" },
      { kind: "audiooutput", deviceId: "out-1", label: "Studio monitors" },
    ],
  });

  // The context exists first, the way the first Play makes it.
  ui.click("[data-act=play]");
  await ui.settle();
  assert.deepEqual(Ctx.sinks, [], "nothing to ask for yet: no output was stored");

  ui.pickOutput("gone-1");
  await ui.settle();

  const select = ui.document.querySelector("[data-role=output-device]");
  const note = ui.document.querySelector("[data-role=output-note]");
  assert.equal(select.value, "", "the picker is back on the default output");
  assert.equal(note.hidden, false, "the note beside it is shown");
  assert.match(
    String(note.textContent),
    /not available; using the default output/,
    "and says what happened, in visible text",
  );
  assert.equal(storage.getItem(OUTPUT_KEY), null, "a choice that cannot be honoured is forgotten");
  assert.deepEqual(
    Ctx.sinks,
    ["gone-1", ""],
    "the refused device first, then the default output it fell back to",
  );
});

// --- the session hint -------------------------------------------------------

/** The hint's visible sentence, or null when the hint is hidden. */
function hintOf(ui) {
  const hint = ui.document.querySelector("[data-role=hint]");
  assert.ok(hint, "the session view carries a hint");
  return hint.hidden ? null : String(hint.textContent);
}

test("the hint names what the song is missing, and only in the session view", async () => {
  const empty = await bootClient({ doc: await docOf({}) });
  assert.equal(hintOf(empty), "Add a track and a scene to start.", "a song with neither says both");

  const tracksOnly = await bootClient({ doc: await docOf({ tracks: ["bass"] }) });
  assert.equal(hintOf(tracksOnly), "Add a scene to start.", "a track but no scene names the scene");

  const scenesOnly = await bootClient({ doc: await docOf({ scenes: ["verse"] }) });
  assert.equal(hintOf(scenesOnly), "Add a track to start.", "a scene but no track names the track");

  const both = await bootClient();
  assert.equal(hintOf(both), null, "a song with both needs no hint");

  // The hint speaks about the grid: the arrangement's lanes and the mixer are
  // not where it can be acted on, so the same song hides it there.
  empty.click("[data-act=mode-arrangement]");
  await empty.settle();
  assert.equal(hintOf(empty), null, "hidden in the arrangement view");
  empty.click("[data-act=mode-mixer]");
  await empty.settle();
  assert.equal(hintOf(empty), null, "hidden in the mixer view");
  empty.click("[data-act=mode-session]");
  await empty.settle();
  assert.equal(hintOf(empty), "Add a track and a scene to start.", "and back on the view it speaks about");
});

test("the hint follows the song: an update frame and a state frame agree", async () => {
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  const { encodeDocState } = await import("../bundles/studio/server/doc.js");

  const doc = await docOf({ scenes: ["verse"] });
  const ui = await bootClient({ doc });
  assert.equal(hintOf(ui), "Add a track to start.", "a scene alone is named as missing a track");

  // One change, pushed the way the hub pushes one: a track arrives on the same
  // document, so the page's copy gains it and the hint has to follow.
  runCommand(doc, "track.add", { id: "bass", name: "Bass" });
  ui.frame({
    type: "update",
    update: Buffer.from(encodeDocState(doc)).toString("base64"),
  });
  await ui.settle();
  assert.equal(hintOf(ui), null, "with a track and a scene the hint is gone");

  // A whole state frame (the answer to a hello) draws the same answer.
  const rebuilt = await docOf({ tracks: ["bass"] });
  ui.frame({
    type: "state",
    update: Buffer.from(encodeDocState(rebuilt)).toString("base64"),
    history: [],
    presence: [],
  });
  await ui.settle();
  assert.equal(
    hintOf(ui),
    "Add a scene to start.",
    "the state frame draws the hint for what it carries",
  );

  // And a song with neither, rebuilt: both are missing again.
  const nothing = await docOf({});
  ui.frame({
    type: "state",
    update: Buffer.from(encodeDocState(nothing)).toString("base64"),
    history: [],
    presence: [],
  });
  await ui.settle();
  assert.equal(hintOf(ui), "Add a track and a scene to start.", "a rebuilt empty song says both again");
});