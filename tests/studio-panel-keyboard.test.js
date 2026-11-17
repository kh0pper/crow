/**
 * Studio panel — the keyboard widget and `view.aimTrackId` (P2a, D2).
 *
 * The real emitted client script (`CLIENT_SCRIPT`) against a linkedom document
 * built from the page the handler renders, with a real Yjs song, a stubbed
 * socket, a fake AudioContext and a fake engine whose `liveNote` records what
 * the page played.
 *
 * Six things are pinned here:
 *
 *   - the aim: tapping a track's name and opening one of its clips both set
 *     `view.aimTrackId`; another song resets it to null and a track that is
 *     gone falls back to the open clip's track;
 *   - a key press sends `liveNote` on with the fixed touch velocity and a lift
 *     (or a cancel) sends exactly one off per key held;
 *   - a note event from the engine lights the key it names on the node already
 *     drawn, and the off takes the light away — painting adds no DOM node;
 *   - only a note track shows the keyboard: a sampler track keeps the host
 *     hidden, which is what shows the widget's own sentence;
 *   - the octave shift moves the drawn pitches by 12 semitones;
 *   - a `keys.play` mapping plays the aimed track at the controller's own pitch
 *     and velocity and lights its key, and its note-off goes to the track the
 *     press started on even after the aim moved (a blur or a hidden page lets
 *     every held note go, once);
 *   - a note's key waits for the frame it is heard on, like a pad hit;
 *   - moving the aim, or hiding the host for a sampler track, clears the lights,
 *     and a track rename redraws the keyboard's title.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import studioPanel from "../bundles/studio/panel/studio.js";
import { CLIENT_SCRIPT } from "../bundles/studio/panel/client.js";
import { MIDI_SCRIPT } from "../bundles/studio/panel/midi.js";
import { MIDI_ROUTE_SCRIPT } from "../bundles/studio/panel/midi-route.js";
import { PAD_INPUT_SCRIPT } from "../bundles/studio/panel/pad-input.js";

const LEAD = "lead";
const KIT = "drums";
const BASS = "bass";
const SCENE = "verse";
const LEAD_CLIP = "c-lead";
const KIT_CLIP = "c-kit";
const BASS_CLIP = "c-bass";

/** The octave the keyboard starts on: C3 is MIDI 48. */
const BASE = 48;

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
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>`
    + `<body>MARKER${content}</body></html>`;
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

/** The command registry, with every command module these cases need. */
async function commandsApi() {
  const registry = await import("../bundles/studio/server/commands/registry.js");
  await import("../bundles/studio/server/commands/core.js");
  await import("../bundles/studio/server/commands/sampler.js");
  await import("../bundles/studio/server/commands/midi.js");
  return registry;
}

// --- the song documents -----------------------------------------------------

/**
 * A song with a note track (a clip in the first scene), a second note track, a
 * sampler track and, when asked, a pattern clip on the sampler.
 * @param {{kitClip?: boolean}} [options]
 * @returns {Promise<object>} a Y.Doc
 */
async function keyboardDoc(options = {}) {
  const { newSongDoc } = await import("../bundles/studio/server/doc.js");
  const { runCommand } = await commandsApi();

  const doc = newSongDoc({ title: "Keyboard song" });
  runCommand(doc, "track.add", { id: LEAD, name: "Lead" });
  runCommand(doc, "track.add", { id: BASS, name: "Bass" });
  runCommand(doc, "track.add", { id: KIT, name: "Kit", kind: "sampler" });
  runCommand(doc, "scene.add", { id: SCENE, name: "Verse" });
  runCommand(doc, "clip.write", {
    clip_id: LEAD_CLIP,
    track_id: LEAD,
    scene_id: SCENE,
    name: "Lead line",
    length_bars: 1,
    notes: [{ t: 0, d: 1, p: 60, v: 100 }],
  });
  runCommand(doc, "clip.write", {
    clip_id: BASS_CLIP,
    track_id: BASS,
    scene_id: SCENE,
    name: "Bass line",
    length_bars: 1,
    notes: [{ t: 0, d: 1, p: 48, v: 100 }],
  });
  if (options.kitClip === true) {
    runCommand(doc, "clip.add_pattern", {
      clip_id: KIT_CLIP,
      track_id: KIT,
      scene_id: SCENE,
      name: "Kit",
      length_steps: 16,
    });
  }
  return doc;
}

/** One live keys.play mapping on a note of the fixture controller. */
async function mapKeysPlay(doc, number = 60) {
  const { runCommand } = await commandsApi();
  const args = {
    id: "m-keys",
    device_name: "FCB1010",
    message: { type: "note", channel: 1, number },
    action: { kind: "keys.play" },
  };
  runCommand(doc, "midi.map", args, { author: { kind: "human" } });
  return args;
}

// --- the page's browser side ------------------------------------------------

/** A bare `AudioContext`: enough of it for the engine's master bus. */
function audioContextClass() {
  class FakeAudioContext {
    constructor() {
      this.destination = { id: "destination" };
      this.sampleRate = 48000;
      this.state = "running";
      this.currentTime = 0;
      this.baseLatency = 0;
      this.outputLatency = 0;
      FakeAudioContext.instances.push(this);
    }
    createGain() {
      return { gain: { value: 1 }, connect() {} };
    }
    resume() {
      return Promise.resolve();
    }
    getOutputTimestamp() {
      const latency = Number(this.outputLatency) || 0;
      return {
        contextTime: Math.max(0, this.currentTime - latency),
        performanceTime: this.currentTime * 1000,
      };
    }
    close() {}
  }
  FakeAudioContext.instances = [];
  return FakeAudioContext;
}

/** A stand-in for the engine client (`window.StudioEngine`). */
function fakeStudioEngine() {
  const calls = { play: 0, stop: 0, songs: 0, reset: 0 };
  const engine = {
    calls,
    node: { connect() {} },
    positionListener: null,
    padEventListener: null,
    song: null,
    /** Every live note the page sent, in order: a key press or a controller's. */
    liveNotes: [],
    liveNote(trackId, p, v, on) {
      engine.liveNotes.push({
        track_id: String(trackId),
        p: Number(p),
        v: Number(v),
        on: on === true,
      });
    },
    play() {
      calls.play += 1;
    },
    stop() {
      calls.stop += 1;
    },
    stopAll() {},
    setSong(song) {
      calls.songs += 1;
      engine.song = song;
    },
    resetLive() {
      calls.reset += 1;
    },
    dispose() {},
    setMode() {},
    setMetronome() {},
    onPosition(listener) {
      engine.positionListener = listener;
    },
    onPadEvent(listener) {
      engine.padEventListener = listener;
    },
    onLaunch() {},
    onError() {},
  };
  return {
    calls,
    engine,
    create() {
      return Promise.resolve(engine);
    },
  };
}

/** A Web MIDI fake: one connected controller the test can send bytes from. */
function fakeMidiAccess() {
  const inputs = new Map();
  const port = {
    id: "port-1",
    name: "FCB1010",
    manufacturer: "test",
    type: "input",
    state: "connected",
    onmidimessage: null,
    send(bytes) {
      if (typeof port.onmidimessage === "function") port.onmidimessage({ data: Uint8Array.from(bytes) });
    },
  };
  inputs.set(port.id, port);
  return {
    access: { inputs, outputs: new Map(), onstatechange: null },
    send(bytes) {
      port.send(bytes);
    },
  };
}

/** A `localStorage` that keeps what it is given. */
function makeStorage() {
  const map = new Map();
  return {
    getItem(key) {
      return map.has(String(key)) ? map.get(String(key)) : null;
    },
    setItem(key, value) {
      map.set(String(key), String(value));
    },
    removeItem(key) {
      map.delete(String(key));
    },
  };
}

// --- the rig ----------------------------------------------------------------

/**
 * Run the real client script against a linkedom page and a stubbed wire.
 * @param {{doc: object}} options
 * @returns {Promise<object>} the page, its document, and the stubs to look at
 */
async function bootSong(options = {}) {
  const { parseHTML } = await import("linkedom");
  const { encodeDocState } = await import("../bundles/studio/server/doc.js");

  const doc = options.doc;
  const pageHtml = await render({ song: "song-1" });
  const { document, window: domWindow } = parseHTML(pageHtml);

  /** Every frame the client sent, across reconnects. */
  const sent = [];
  /** One entry per socket the client opened. */
  const sockets = [];
  /** Timers the page scheduled, run on demand. */
  const timers = [];
  /** The page's window listeners, so a release can be dispatched. */
  const windowListeners = {};
  /** The animation frames the page asked for, run on demand. */
  const frames = [];

  function makeSocket() {
    const socket = { readyState: 1, handlers: {} };
    socket.addEventListener = (name, handler) => {
      (socket.handlers[name] ||= []).push(handler);
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

  const engineApi = fakeStudioEngine();
  const AudioContextStub = audioContextClass();
  const midi = fakeMidiAccess();

  const windowStub = {
    crypto: globalThis.crypto,
    localStorage: makeStorage(),
    AudioContext: AudioContextStub,
    location: { protocol: "http:", host: "127.0.0.1:1", reload() {} },
    atob: globalThis.atob,
    requestAnimationFrame(fn) {
      frames.push(fn);
      return frames.length;
    },
    cancelAnimationFrame() {},
    addEventListener(name, handler) {
      (windowListeners[name] ||= []).push(handler);
    },
    removeEventListener(name, handler) {
      const list = windowListeners[name] || [];
      const at = list.indexOf(handler);
      if (at >= 0) list.splice(at, 1);
    },
  };
  windowStub.StudioEngine = engineApi;

  const scriptText = CLIENT_SCRIPT.replace(
    "'/dashboard/studio/assets/yjs.mjs'",
    JSON.stringify(
      pathToFileURL(
        new URL("../bundles/studio/node_modules/yjs/dist/yjs.mjs", import.meta.url).pathname,
      ).href,
    ),
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

  const navigatorStub = {
    requestMIDIAccess() {
      return Promise.resolve(midi.access);
    },
    locks: null,
    permissions: null,
  };

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
    `${PAD_INPUT_SCRIPT}\n${MIDI_ROUTE_SCRIPT}\n${MIDI_SCRIPT}\n${scriptText}`,
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

  /** Let the page's own promises (the Yjs import, a frame, the engine) settle. */
  const settle = async (rounds = 10) => {
    for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  };

  /** One event, with the properties a pointer handler reads. */
  const event = (type, props) => {
    const made = new domWindow.Event(type, { bubbles: true, cancelable: true });
    for (const [key, value] of Object.entries(props || {})) made[key] = value;
    return made;
  };

  /** The state frame for the song as it is now. */
  const stateFrame = (nextDoc = doc) => ({
    type: "state",
    update: Buffer.from(encodeDocState(nextDoc)).toString("base64"),
    history: [],
    presence: [],
  });

  const page = document.querySelector(".studio");

  await settle();
  frame(stateFrame());
  await settle();

  const ui = {
    doc,
    document,
    page,
    window: windowStub,
    windowListeners,
    engine: engineApi,
    sent,
    sockets,
    current,
    frame,
    stateFrame,
    event,
    settle,
    Ctx: AudioContextStub,
    /** Run the animation frames the page asked for, once. */
    runFrames() {
      const waiting = frames.splice(0, frames.length);
      const list = AudioContextStub.instances;
      const stamped = list.length > 0 ? Number(list[list.length - 1].currentTime) * 1000 : 0;
      for (const fn of waiting) fn(stamped);
      return waiting.length;
    },
    /** Say the page went hidden, or came back, the way a phone reports it. */
    setVisibility(state) {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => String(state),
      });
      document.dispatchEvent(new domWindow.Event("visibilitychange"));
    },
    /** The page's own test handle (see bootStudio). */
    hook() {
      return page.__studioTest;
    },
    /** The track the page's aim reads right now. */
    aim() {
      return ui.hook().aimTrack();
    },
    /** Click one element the way a person would. */
    click(selector) {
      const node = document.querySelector(selector);
      assert.ok(node, `nothing matches ${selector}`);
      node.dispatchEvent(new domWindow.Event("click", { bubbles: true }));
      return node;
    },
    /** A pointer event on a node, with the properties the handlers read. */
    pointerOn(selector, type, props) {
      const node = document.querySelector(selector);
      assert.ok(node, `nothing matches ${selector}`);
      node.dispatchEvent(event(type, props || {}));
      return node;
    },
    /** A pointer event on the window: a lift or a cancel anywhere. */
    windowPointer(type, props) {
      for (const handler of [...(windowListeners[type] || [])]) {
        handler(event(type, props || {}));
      }
    },
    /** Every command of one id the page sent, in order. */
    commands(id) {
      return sent.filter((message) => message.type === "command" && message.command === id);
    },
    /** The keyboard host, asserted to be on the page. */
    keyboard() {
      const host = document.querySelector("[data-role=sampler-keyboard]");
      assert.ok(host, "the keyboard host is on the page");
      return host;
    },
    /** One key by its pitch. */
    key(pitch) {
      return ui.keyboard().querySelector(`[data-act=live-key][data-pitch="${pitch}"]`);
    },
    /** The live notes the page sent, newest last. */
    notes() {
      return engineApi.engine.liveNotes;
    },
    /** Push one report from the engine's pad-event ring. */
    padEvent(report) {
      assert.ok(engineApi.engine.padEventListener, "the page follows the engine's pads");
      engineApi.engine.padEventListener(report);
    },
    /** Click Connect controllers: the gesture Web MIDI wants. */
    connectMidi() {
      ui.click("[data-act=midi-connect]");
    },
    /** Send raw MIDI bytes from the fake controller. */
    pedal(bytes) {
      midi.send(bytes);
    },
    /** Apply a command the page sent to the song, then push the new state. */
    async apply(command, args) {
      const { runCommand } = await commandsApi();
      runCommand(doc, command, args);
      frame(stateFrame());
      await settle();
    },
  };
  return ui;
}

// --- the aim ----------------------------------------------------------------

test("tapping a track name in the grid sets the aim, and opening one of its clips sets it too", async () => {
  const doc = await keyboardDoc();
  const ui = await bootSong({ doc });

  assert.equal(ui.aim(), null, "nothing is aimed before the operator picks a track");

  ui.page.__studioTest.view.aimTrackId = null;
  ui.click(`[data-role=grid] [data-track-id=${LEAD}] .st-name`);
  await ui.settle();
  assert.equal(String(ui.page.__studioTest.view.aimTrackId), LEAD, "the tapped track is aimed");
  assert.equal(String(ui.aim().id), LEAD);
  const aimed = [...ui.document.querySelectorAll(".st-th-aimed")].map((head) => head.getAttribute("data-track-id"));
  assert.deepEqual(aimed, [LEAD], "and its header wears the outline");

  // The clip the tap opened is on that track; opening another track's clip aims
  // that track instead.
  ui.click(`[data-role=grid] [data-act=open-clip][data-clip-id=${BASS_CLIP}]`);
  await ui.settle();
  assert.equal(String(ui.page.__studioTest.view.aimTrackId), BASS, "opening a clip aims its track");
  assert.equal(String(ui.aim().id), BASS);

  ui.click(`[data-role=grid] [data-act=open-clip][data-clip-id=${LEAD_CLIP}]`);
  await ui.settle();
  assert.equal(String(ui.aim().id), LEAD, "and the clip on the other track aims that one");

  const before = ui.sent.filter((message) => message.type === "command").length;
  assert.equal(before, 0, "none of this is a command: the aim is view state");
});

test("a song change resets the aim, and a deleted aimed track falls back to the open clip", async () => {
  const doc = await keyboardDoc();
  const ui = await bootSong({ doc });

  // Open the bass clip, then aim the lead track by hand: the state a track that
  // was deleted while another track's clip stayed open leaves behind.
  ui.click(`[data-role=grid] [data-act=open-clip][data-clip-id=${BASS_CLIP}]`);
  await ui.settle();
  ui.page.__studioTest.view.aimTrackId = LEAD;
  assert.equal(String(ui.aim().id), LEAD, "the aimed track while it exists");

  await ui.apply("track.remove", { track_id: LEAD });
  assert.equal(String(ui.page.__studioTest.view.aimTrackId), LEAD, "the page keeps its aim until the song changes");
  assert.equal(String(ui.aim().id), BASS, "a track that is gone falls back to the open clip's track");

  // Another song starts with no aim at all.
  ui.page.__studioTest.view.aimTrackId = LEAD;
  ui.page.__studioLiveSong = "song-9";
  ui.frame(ui.stateFrame());
  await ui.settle();
  assert.equal(ui.page.__studioTest.view.aimTrackId, null, "another song resets the aim to null");
  assert.equal(String(ui.aim().id), BASS, "which then falls back to the clip the page has open");
});

// --- the keys ---------------------------------------------------------------

test("a key press sends liveNote on, and a lift sends off", async () => {
  const doc = await keyboardDoc();
  const ui = await bootSong({ doc });
  ui.click(`[data-role=grid] [data-track-id=${LEAD}] .st-name`);
  await ui.settle();

  const key = ui.key(BASE);
  assert.ok(key, "C3 is drawn on the two-octave keyboard");
  assert.equal(ui.keyboard().hidden, false, "the keyboard is shown for a note track");

  key.dispatchEvent(ui.event("pointerdown", { button: 0, pointerId: 1 }));
  await ui.settle();
  assert.deepEqual(ui.notes(), [{ track_id: LEAD, p: BASE, v: 100, on: true }], "one note on, at the touch velocity");

  ui.windowPointer("pointerup", { pointerId: 1 });
  await ui.settle();
  assert.deepEqual(ui.notes().map((note) => note.on), [true, false], "and one off on the lift");
  assert.equal(ui.notes()[1].p, BASE);
  assert.equal(ui.notes()[1].track_id, LEAD);
  assert.equal(ui.sent.filter((message) => message.type === "command").length, 0, "a played key writes nothing to the song");
});

test("a cancelled pointer sends one off per key it holds, and nothing twice", async () => {
  const doc = await keyboardDoc();
  const ui = await bootSong({ doc });
  ui.click(`[data-role=grid] [data-track-id=${LEAD}] .st-name`);
  await ui.settle();

  ui.key(BASE).dispatchEvent(ui.event("pointerdown", { button: 0, pointerId: 4 }));
  ui.key(BASE + 4).dispatchEvent(ui.event("pointerdown", { button: 0, pointerId: 5 }));
  await ui.settle();
  assert.equal(ui.notes().filter((note) => note.on).length, 2, "two fingers, two notes");

  ui.windowPointer("pointercancel", { pointerId: 4 });
  await ui.settle();
  const offs = ui.notes().filter((note) => note.on === false);
  assert.deepEqual(offs.map((note) => note.p), [BASE], "the cancelled finger's key is let go");

  ui.windowPointer("pointercancel", { pointerId: 4 });
  await ui.settle();
  assert.equal(ui.notes().filter((note) => note.on === false).length, 1, "the same cancel twice sends nothing more");

  ui.windowPointer("pointerup", { pointerId: 5 });
  await ui.settle();
  assert.equal(ui.notes().filter((note) => note.on === false).length, 2, "and the other finger's lift sends its own off");
});

test("a note event lights its key and clears at the note off, adding no node", async () => {
  const doc = await keyboardDoc();
  const ui = await bootSong({ doc });
  ui.click(`[data-role=grid] [data-track-id=${LEAD}] .st-name`);
  await ui.settle();

  // The page makes its engine on the first sound: one key press is enough, and
  // the note reports below arrive on the listener that engine registers.
  ui.key(BASE).dispatchEvent(ui.event("pointerdown", { button: 0, pointerId: 9 }));
  await ui.settle();
  ui.windowPointer("pointerup", { pointerId: 9 });
  await ui.settle();

  const key = ui.key(BASE);
  const before = ui.keyboard().querySelectorAll("*").length;
  assert.equal(String(key.className).includes("st-key-on"), false, "the key starts dark");

  ui.padEvent({ frame: 0, track_id: LEAD, kind: "note", p: BASE, on: true });
  ui.runFrames();
  assert.equal(String(key.className).includes("st-key-on"), true, "the note lights the key");
  assert.equal(ui.keyboard().querySelectorAll("*").length, before, "painting adds no DOM node");

  ui.padEvent({ frame: 0, track_id: LEAD, kind: "note", p: BASE, on: false });
  ui.runFrames();
  assert.equal(String(key.className).includes("st-key-on"), false, "and its end takes the light away");

  ui.padEvent({ frame: 0, track_id: KIT, kind: "note", p: BASE, on: true });
  ui.runFrames();
  assert.equal(String(key.className).includes("st-key-on"), false, "a note on another track lights nothing here");
  assert.equal(ui.keyboard().querySelectorAll("*").length, before, "still no node added");
});

test("a sampler track shows the keyboard widget's own sentence instead of keys", async () => {
  const doc = await keyboardDoc({ kitClip: true });
  const ui = await bootSong({ doc });

  ui.click(`[data-role=grid] [data-track-id=${KIT}] .st-name`);
  await ui.settle();
  assert.equal(String(ui.page.__studioTest.view.aimTrackId), KIT, "the sampler track is aimed");
  assert.equal(ui.keyboard().hidden, true, "and the keyboard host puts itself away");

  ui.click(`[data-role=grid] [data-act=open-clip][data-clip-id=${LEAD_CLIP}]`);
  await ui.settle();
  assert.equal(ui.keyboard().hidden, false, "a note track brings the keys back");
});

test("the octave shift moves the drawn pitches by 12", async () => {
  const doc = await keyboardDoc();
  const ui = await bootSong({ doc });
  ui.click(`[data-role=grid] [data-track-id=${LEAD}] .st-name`);
  await ui.settle();

  assert.ok(ui.key(BASE), "the first key is C3");
  ui.click("[data-act=keyboard-octave-up]");
  await ui.settle();
  assert.equal(ui.key(BASE), null, "the old octave's keys are gone");
  const shifted = ui.key(BASE + 12);
  assert.ok(shifted, "the same key is now an octave up");

  shifted.dispatchEvent(ui.event("pointerdown", { button: 0, pointerId: 7 }));
  await ui.settle();
  assert.equal(ui.notes().pop().p, BASE + 12, "and it plays the shifted pitch");
  ui.windowPointer("pointerup", { pointerId: 7 });
  await ui.settle();

  ui.click("[data-act=keyboard-octave-down]");
  await ui.settle();
  assert.ok(ui.key(BASE), "the shift comes back down again");
});

test("a keys.play MIDI note plays the aimed track and lights its key", async () => {
  const doc = await keyboardDoc();
  await mapKeysPlay(doc, 60);
  const ui = await bootSong({ doc });
  ui.click(`[data-role=grid] [data-track-id=${LEAD}] .st-name`);
  await ui.settle();
  ui.connectMidi();
  await ui.settle();

  const key = ui.key(60);
  assert.ok(key, "the controller's note is inside the visible octaves");

  ui.pedal([0x90, 60, 96]);
  await ui.settle();
  assert.deepEqual(ui.notes(), [{ track_id: LEAD, p: 60, v: 96, on: true }], "the aimed track plays the controller's note");
  assert.equal(String(key.className).includes("st-key-on"), true, "and its key lights");

  ui.pedal([0x80, 60, 0]);
  await ui.settle();
  assert.equal(ui.notes()[1].on, false, "the note off sends the off");
  assert.equal(ui.notes()[1].p, 60);
  assert.equal(String(key.className).includes("st-key-on"), false, "and the key goes dark");
  assert.equal(ui.sent.filter((message) => message.type === "command").length, 0, "the keys are live state, never a command");
});

test("a keys.play note-off goes to the track its press started on, not the aim it left", async () => {
  const doc = await keyboardDoc();
  await mapKeysPlay(doc, 60);
  const ui = await bootSong({ doc });
  ui.click(`[data-role=grid] [data-track-id=${LEAD}] .st-name`);
  await ui.settle();
  ui.connectMidi();
  await ui.settle();

  ui.pedal([0x90, 60, 96]);
  await ui.settle();
  assert.deepEqual(ui.notes(), [{ track_id: LEAD, p: 60, v: 96, on: true }], "the press sounds the aimed track");

  // The aim moves while the controller's key is still down: the off belongs to
  // the track the note started on.
  ui.click(`[data-role=grid] [data-track-id=${BASS}] .st-name`);
  await ui.settle();
  assert.equal(String(ui.aim().id), BASS, "the other note track is aimed now");

  ui.pedal([0x80, 60, 0]);
  await ui.settle();
  const offs = ui.notes().filter((note) => note.on === false);
  assert.deepEqual(offs.map((note) => note.track_id), [LEAD], "the off goes to the track that started the note");

  // A second release has nothing left to end.
  ui.pedal([0x80, 60, 0]);
  await ui.settle();
  assert.equal(ui.notes().filter((note) => note.on === false).length, 1, "a release with no recorded press is dropped");

  // Aiming a sampler does not swallow the off either: it still goes where the
  // note started.
  ui.pedal([0x90, 62, 80]);
  await ui.settle();
  ui.click(`[data-role=grid] [data-track-id=${KIT}] .st-name`);
  await ui.settle();
  assert.equal(ui.keyboard().hidden, true, "a sampler track is aimed");
  ui.pedal([0x80, 62, 0]);
  await ui.settle();
  const last = ui.notes()[ui.notes().length - 1];
  assert.equal(last.on, false, "the release still ends the note");
  assert.equal(last.p, 62);
  assert.equal(last.track_id, BASS, "on the track it started on");
});

test("a blur or a hidden page lets every note a controller holds go, once each", async () => {
  const doc = await keyboardDoc();
  await mapKeysPlay(doc, 60);
  const ui = await bootSong({ doc });
  ui.click(`[data-role=grid] [data-track-id=${LEAD}] .st-name`);
  await ui.settle();
  ui.connectMidi();
  await ui.settle();

  ui.pedal([0x90, 60, 96]);
  ui.pedal([0x90, 64, 96]);
  await ui.settle();
  assert.equal(ui.notes().filter((note) => note.on).length, 2, "two controller keys are held");

  const offs = () => ui.notes().filter((note) => note.on === false);

  ui.windowPointer("blur", {});
  await ui.settle();
  assert.deepEqual(offs().map((note) => note.p).sort((a, b) => a - b), [60, 64], "the blur sends one off per held note");
  assert.equal(offs().every((note) => note.track_id === LEAD), true, "each on the track it started on");

  ui.windowPointer("blur", {});
  await ui.settle();
  assert.equal(offs().length, 2, "a second blur sends nothing more");

  // The page goes to the background, where no note-off is heard either.
  ui.pedal([0x90, 60, 96]);
  await ui.settle();
  ui.setVisibility("hidden");
  await ui.settle();
  assert.equal(offs().length, 3, "the hidden page lets the held note go");
  assert.equal(offs()[2].p, 60);
  assert.equal(offs()[2].track_id, LEAD);

  ui.setVisibility("visible");
  ui.setVisibility("hidden");
  await ui.settle();
  assert.equal(offs().length, 3, "and only once");
});

test("moving the aim clears the lights the old track left on the keys", async () => {
  const doc = await keyboardDoc();
  const ui = await bootSong({ doc });
  ui.click(`[data-role=grid] [data-track-id=${LEAD}] .st-name`);
  await ui.settle();

  const lit = (pitch) => String(ui.key(pitch).className).includes("st-key-on");
  // The page makes its engine on the first sound: one key press is enough, and
  // the note reports arrive on the listener that engine registers.
  ui.key(BASE).dispatchEvent(ui.event("pointerdown", { button: 0, pointerId: 13 }));
  await ui.settle();
  ui.windowPointer("pointerup", { pointerId: 13 });
  await ui.settle();
  assert.equal(lit(60), false, "the key starts dark");

  ui.padEvent({ frame: 0, track_id: LEAD, kind: "note", p: 60, on: true });
  ui.runFrames();
  assert.equal(lit(60), true, "the tracked note lights its key");

  ui.click(`[data-role=grid] [data-track-id=${BASS}] .st-name`);
  await ui.settle();
  assert.equal(String(ui.aim().id), BASS, "the other note track is aimed now");
  assert.ok(ui.key(60), "pitch 60 is drawn on the new keyboard");
  assert.equal(lit(60), false, "no key wears the old track's light");

  // A sampler hides the host; coming back to a note track draws a dark keyboard.
  ui.click(`[data-role=grid] [data-track-id=${KIT}] .st-name`);
  await ui.settle();
  assert.equal(ui.keyboard().hidden, true, "a sampler track hides the keys");
  ui.click(`[data-role=grid] [data-act=open-clip][data-clip-id=${BASS_CLIP}]`);
  await ui.settle();
  assert.equal(ui.keyboard().hidden, false, "the note track brings them back");
  assert.equal(lit(48), false, "and no light comes back with them");
  assert.equal(lit(60), false);
});

test("a long press on a key or an octave shift is the press it started", async () => {
  const doc = await keyboardDoc();
  const ui = await bootSong({ doc });
  ui.click(`[data-role=grid] [data-track-id=${LEAD}] .st-name`);
  await ui.settle();

  const onKey = ui.event("contextmenu", {});
  ui.key(BASE).dispatchEvent(onKey);
  assert.equal(onKey.defaultPrevented, true, "the menu is cancelled on a key");

  const octave = ui.document.querySelector("[data-act=keyboard-octave-up]");
  assert.ok(octave, "the head carries the octave shift");
  const onOctave = ui.event("contextmenu", {});
  octave.dispatchEvent(onOctave);
  assert.equal(onOctave.defaultPrevented, true, "and on the octave shift");

  // The title that names the track keeps its own long press: only the controls a
  // finger plays cancel the menu.
  const title = ui.keyboard().querySelector(".st-keyboard-title");
  assert.ok(title, "the widget is titled for the track it plays");
  const onTitle = ui.event("contextmenu", {});
  title.dispatchEvent(onTitle);
  assert.equal(onTitle.defaultPrevented, false, "text in the page is left alone");
});

test("a note event waits for the frame it is heard on, like a pad hit", async () => {
  const doc = await keyboardDoc();
  const ui = await bootSong({ doc });
  ui.click(`[data-role=grid] [data-track-id=${LEAD}] .st-name`);
  await ui.settle();

  // The page makes its engine and its context on the first sound.
  ui.key(BASE).dispatchEvent(ui.event("pointerdown", { button: 0, pointerId: 11 }));
  await ui.settle();
  ui.windowPointer("pointerup", { pointerId: 11 });
  await ui.settle();

  const clock = ui.Ctx.instances[ui.Ctx.instances.length - 1];
  assert.ok(clock, "the page made an audio context");
  clock.currentTime = 0;
  clock.outputLatency = 0.05;
  assert.equal(clock.outputLatency, 0.05, "the fake clock has 50 ms of output latency");

  const key = ui.key(BASE);
  assert.equal(String(key.className).includes("st-key-on"), false, "the key starts dark");

  // Frame 4800 at 48 kHz is 0.1 s of context time, and it is heard 50 ms later.
  ui.padEvent({ frame: 4800, track_id: LEAD, kind: "note", p: BASE, on: true });
  assert.equal(ui.window.__crowStudioPadQueue.length, 1, "the note waits in the queue");
  assert.equal(String(key.className).includes("st-key-on"), false, "nothing is painted on arrival");

  clock.currentTime = 0.149;
  ui.runFrames();
  assert.equal(String(key.className).includes("st-key-on"), false, "just short of the latency is still too early");

  clock.currentTime = 0.15;
  ui.runFrames();
  assert.equal(String(key.className).includes("st-key-on"), true, "painted 50 ms after its context time");
  assert.equal(ui.window.__crowStudioPadQueue.length, 0, "and the queue is empty");
});

test("renaming the aimed track redraws the keyboard's title", async () => {
  const doc = await keyboardDoc();
  const ui = await bootSong({ doc });
  ui.click(`[data-role=grid] [data-track-id=${LEAD}] .st-name`);
  await ui.settle();

  const title = () => String(ui.keyboard().querySelector(".st-keyboard-title").textContent);
  assert.equal(title(), "Lead", "the keys are titled for the track they play");

  await ui.apply("track.rename", { track_id: LEAD, name: "Lead guitar" });
  assert.equal(title(), "Lead guitar", "a rename redraws the title");
});