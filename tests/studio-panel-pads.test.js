/**
 * Studio panel — a sampler track's pads, the step the transport is on, and the
 * lock strip's place beside the steps.
 *
 * The real emitted client script (`CLIENT_SCRIPT`) against a linkedom document
 * built from the page the handler renders, with a real Yjs song, a stubbed
 * socket, a fake AudioContext and a fake engine whose position reports the test
 * pushes. Three things are pinned here:
 *
 *   - the grid's way into a sampler track's pads: the header's Open pads button
 *     makes a pattern in the first scene (Scene 1 when the song has none) or
 *     opens the pattern the track already has, and a sampler track this page
 *     just added opens its pads by itself — a track that arrives from elsewhere
 *     only gets the button;
 *   - the step sequencer says where the transport is, on the cells already
 *     drawn, and clears it when the transport stops;
 *   - a queued step paints the position IT was made for, and the queue a page
 *     comes back to drops what went stale while no frames ran;
 *   - lock mode's strip lives with the steps (not in the right column), and the
 *     sentence about locking a step is the visible hint while no lock is on;
 *   - the selected pad's settings, in the SP-404's groups: one pad.set per
 *     control, a whole-bank button that sends one pad.set_bank, the mute group's
 *     eleven options, the sample tempo that reads in BPM, and a pad written
 *     before those fields existed;
 *   - the live state is released (engine.resetLive) only when a DIFFERENT song
 *     opens, never on the snapshot an ordinary edit sends;
 *   - a controller's effect hold outlives a tap on the page, and a rebuilt host
 *     gives the keyboard back to the control it was on.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import studioPanel from "../bundles/studio/panel/studio.js";
import { CLIENT_SCRIPT } from "../bundles/studio/panel/client.js";
import { MIDI_SCRIPT } from "../bundles/studio/panel/midi.js";
import { MIDI_ROUTE_SCRIPT } from "../bundles/studio/panel/midi-route.js";

/** The sampler track, its scene and its pattern clip in the fixture songs. */
const TRACK = "drums";
const SCENE = "verse";
const CLIP = "c-beat";

/** The one sentence about locking a step. */
const HINT = "Hold a step that has a hit to lock it";

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

/** The command registry, with every command module registered. */
async function commandsApi() {
  const registry = await import("../bundles/studio/server/commands/registry.js");
  await import("../bundles/studio/server/commands/core.js");
  await import("../bundles/studio/server/commands/sampler.js");
  return registry;
}

// --- the song documents -----------------------------------------------------

/**
 * Build a song with one sampler track (its kit arrives with bank A and its
 * sixteen pads), the scenes asked for, and — when `pattern` is set — one
 * sixteen-step pattern clip in the first scene.
 * @param {{scenes?: string[], track?: string, pattern?: boolean, hits?: number[]}} [options]
 * @returns {Promise<object>} a Y.Doc
 */
async function samplerDoc(options = {}) {
  const { newSongDoc, snapshot } = await import("../bundles/studio/server/doc.js");
  const { runCommand } = await commandsApi();

  const doc = newSongDoc({ title: "Test song" });
  const trackId = options.track || TRACK;
  runCommand(doc, "track.add", { id: trackId, name: "Beat box", kind: "sampler" });
  for (const [at, id] of (options.scenes || []).entries()) {
    runCommand(doc, "scene.add", { id, name: "Scene " + String(at + 1) });
  }
  if (options.pattern) {
    runCommand(doc, "clip.add_pattern", {
      clip_id: CLIP,
      track_id: trackId,
      scene_id: (options.scenes || [SCENE])[0],
      name: "Beat",
      length_steps: 16,
    });
    // The hits the lock tests need: steps on for the selected pad.
    const bank = Object.values(snapshot(doc).banks || {})[0];
    for (const hit of options.hits || []) {
      runCommand(doc, "step.toggle", {
        clip_id: CLIP,
        pattern_id: "a",
        at: hit,
        bank_id: bank.id,
        index: 0,
        v: 110,
      });
    }
  }
  return doc;
}

/** @returns {Promise<string>} the id of the song's first bank (the one a pad grid shows) */
async function firstBankId(doc) {
  const { snapshot } = await import("../bundles/studio/server/doc.js");
  const bank = Object.values(snapshot(doc).banks || {})[0];
  assert.ok(bank, "the sampler track has a bank");
  return String(bank.id);
}

/**
 * One live fx.hold mapping on a note of the fixture controller: the pedal a
 * MIDI press arrives from.
 * @param {object} doc
 * @param {string} [name] - one of the five effects the engine holds
 * @param {number} [number] - the note the pedal sends
 * @returns {Promise<object>} the mapping's arguments
 */
async function mapFxHold(doc, name = "stutter", number = 60) {
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  await import("../bundles/studio/server/commands/midi.js");
  const args = {
    id: "m-fx",
    device_name: "FCB1010",
    message: { type: "note", channel: 1, number },
    action: { kind: "fx.hold", name },
  };
  runCommand(doc, "midi.map", args, { author: { kind: "human" } });
  return args;
}

// --- the page's browser side ------------------------------------------------

/** A bare `AudioContext`: enough of it for the engine's master bus and the
 * clock the live lights are timed against. */
function audioContextClass() {
  class FakeAudioContext {
    constructor() {
      this.destination = { id: "destination" };
      this.sampleRate = 48000;
      this.state = "running";
      // The clock: a hit is heard one output latency after its context frame,
      // and a test moves currentTime by hand to say when time passes.
      this.currentTime = 0;
      this.baseLatency = 0;
      this.outputLatency = 0.05;
      FakeAudioContext.instances.push(this);
    }
    createGain() {
      return { gain: { value: 1 }, connect() {} };
    }
    resume() {
      return Promise.resolve();
    }
    /**
     * The output timestamp: the context time heard right now, and the
     * performance time (milliseconds) it is heard at. currentTime runs ahead of
     * what the room hears by the output latency, and a test moves both together.
     */
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

/**
 * A stand-in for the engine client (`window.StudioEngine`): the position
 * listener the page registers is kept, so a test can push the reports a real
 * engine sends every 50 ms.
 */
function fakeStudioEngine() {
  const calls = { play: 0, stop: 0, songs: 0, reset: 0 };
  const engine = {
    calls,
    node: { connect() {} },
    positionListener: null,
    padEventListener: null,
    // What the page asked the live voices for, in order: a press, a lift, a
    // latch, a latch let go, a pause. The pads the song has as GATE pads are the
    // engine's own answer to holdPad (M15): every other pad is refused.
    live: [],
    releases: [],
    holds: [],
    heldReleases: [],
    pauses: [],
    gatePads: [],
    // ROLL (C5b): the repeats the page started, the stops it asked for, and how
    // often it ended them all at once. rollPads is the four-pad limit the engine
    // keeps, so a fifth press is refused exactly as the real one refuses it; a
    // pad whose song setting loops is refused before that.
    rolls: [],
    rollStops: [],
    rollStopsAll: 0,
    rollPads: [],
    song: null,
    livePad(trackId, bankId, index, v) {
      engine.live.push({
        track_id: String(trackId), bank_id: String(bankId), index: Number(index), v: Number(v),
      });
    },
    liveRelease(trackId, bankId, index) {
      engine.releases.push({ track_id: String(trackId), bank_id: String(bankId), index: Number(index) });
    },
    holdPad(trackId, bankId, index) {
      const key = `${trackId}|${bankId}|${index}`;
      if (!engine.gatePads.includes(key)) return false;
      engine.holds.push({ track_id: String(trackId), bank_id: String(bankId), index: Number(index) });
      return true;
    },
    releaseHeld(trackId, bankId, index) {
      if (trackId === undefined || trackId === null) {
        engine.heldReleases.push([]);
        return;
      }
      engine.heldReleases.push([String(trackId), String(bankId), Number(index)]);
    },
    pauseVoices(on) {
      engine.pauses.push(on === true);
    },
    rollStart(trackId, bankId, index, interval, v) {
      const key = `${trackId}/${bankId}/${index}`;
      const pad = engine.song && engine.song.pads ? engine.song.pads[key] : null;
      if (pad && (pad.loop === "loop" || pad.loop === "pingpong")) return false;
      if (!engine.rollPads.includes(key) && engine.rollPads.length >= 4) return false;
      if (!engine.rollPads.includes(key)) engine.rollPads.push(key);
      engine.rolls.push({
        track_id: String(trackId),
        bank_id: String(bankId),
        index: Number(index),
        interval: String(interval),
        v: Number(v),
      });
      return true;
    },
    rollStop(trackId, bankId, index) {
      const key = `${trackId}/${bankId}/${index}`;
      engine.rollPads = engine.rollPads.filter((one) => one !== key);
      engine.rollStops.push({ track_id: String(trackId), bank_id: String(bankId), index: Number(index) });
    },
    rollStopAll() {
      engine.rollStopsAll += 1;
      engine.rollPads = [];
    },
    /** Make one pad a Gate pad: the engine latches it and nothing else. */
    gate(trackId, bankId, index) {
      engine.gatePads.push(`${trackId}|${bankId}|${index}`);
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
 *
 * @param {object} [options]
 * @param {object} [options.doc] - the Y.Doc to draw
 * @param {boolean} [options.engine] - show the page a `window.StudioEngine`
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
  /** Timers the page scheduled (a held step's quarter second), run on demand. */
  const timers = [];
  /** The page's window listeners, so a release can be dispatched. */
  const windowListeners = {};

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

  const engineApi = options.engine ? fakeStudioEngine() : null;
  const AudioContextStub = audioContextClass();
  const midi = fakeMidiAccess();
  /** Animation frames the page asked for, run by the test. */
  const frames = [];

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
  if (engineApi) windowStub.StudioEngine = engineApi;

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

  /** A Web MIDI stub: present, but only the Connect click ever opens it. */
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
    `${MIDI_ROUTE_SCRIPT}\n${MIDI_SCRIPT}\n${scriptText}`,
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

  await settle();
  frame(stateFrame());
  await settle();

  /** Click one element the way a person would. */
  const click = (selector) => {
    const node = document.querySelector(selector);
    assert.ok(node, `nothing matches ${selector}`);
    node.dispatchEvent(new domWindow.Event("click", { bubbles: true }));
    return node;
  };

  const ui = {
    doc,
    document,
    window: windowStub,
    windowListeners,
    engine: engineApi,
    sent,
    sockets,
    timers,
    current,
    frame,
    stateFrame,
    click,
    event,
    settle,
    /** Every command of one id the page sent, in order. */
    commands(id) {
      return sent.filter((message) => message.type === "command" && message.command === id);
    },
    /** Run the timers the page queued (a held step's quarter second). */
    runTimers() {
      for (const fn of timers.splice(0, timers.length)) fn();
    },
    /** Release the pointer anywhere: the page hears it on the window. */
    release(props) {
      for (const handler of [...(windowListeners.pointerup || [])]) {
        handler(event("pointerup", props || {}));
      }
    },
    /** Push one transport position, the way the engine reports them. */
    playhead(bar, beat, sixteenth = 1, frame) {
      assert.ok(ui.engine.engine.positionListener, "the page follows the engine's position");
      const position = { bar, beat, sixteenth };
      if (frame !== undefined && frame !== null) position.frame = frame;
      ui.engine.engine.positionListener(position);
    },
    /** The audio context the page built: the clock the lights read. */
    audio() {
      const list = AudioContextStub.instances;
      assert.ok(list.length > 0, "the page made an audio context");
      return list[list.length - 1];
    },
    /** Run the animation frames the page asked for, once. */
    runFrames() {
      const waiting = frames.splice(0, frames.length);
      for (const fn of waiting) fn(ui.audio().currentTime * 1000);
      return waiting.length;
    },
    /** How many animation frames are waiting to run. */
    waitingFrames() {
      return frames.length;
    },
    /** Push one report from the engine's pad-event ring. */
    padEvent(report) {
      assert.ok(ui.engine, "the page was given an engine");
      assert.ok(ui.engine.engine.padEventListener, "the page follows the engine's pads");
      ui.engine.engine.padEventListener(report);
    },
    /** One hit on a pad, at the frame its voice starts on. */
    hit(trackId, bankId, index, v, frame) {
      ui.padEvent({ frame, track_id: trackId, bank_id: bankId, index, kind: "hit", v });
    },
    /** Click Connect controllers: the gesture Web MIDI wants. */
    connectMidi() {
      click("[data-act=midi-connect]");
    },
    /** Send raw MIDI bytes from the fake controller. */
    pedal(bytes) {
      midi.send(bytes);
    },
    /** Press a step and hold it past the long-press threshold. */
    holdStep(at) {
      const node = ui.step(at);
      node.dispatchEvent(event("pointerdown", { button: 0, clientX: 0 }));
      ui.runTimers();
      return node;
    },
    /** The pads host, asserted to be the view on screen. */
    view() {
      const host = document.querySelector("[data-role=sampler-pads]");
      assert.ok(host, "the pads host is on the page");
      assert.equal(host.hidden, false, "the pad-and-steps view is open");
      const box = document.querySelector("[data-role=sampler]");
      assert.equal(box.hidden, false, "and the view says it is open");
      return host;
    },
    /** @returns {object} the step button for one position */
    step(at) {
      const node = document.querySelector(`[data-role=sampler-steps] [data-act=step][data-at="${at}"]`);
      assert.ok(node, `step ${at} is drawn`);
      return node;
    },
    /** @returns {object} the box that holds the step strip and the lock strip */
    stepsBox() {
      const node = document.querySelector("[data-role=sampler-steps] .st-steps");
      assert.ok(node, "the steps box is drawn");
      return node;
    },
    /** @returns {object[]} the cells marked as the transport's own */
    nowCells() {
      return [...document.querySelectorAll("[data-role=sampler-steps] .st-step-now")];
    },
    /** Open a pattern clip: the pad-and-steps view is its editor. */
    async openSampler() {
      click(`[data-role=grid] [data-act=open-clip][data-clip-id=${CLIP}]`);
      await ui.settle();
    },
    /** Apply a command the page sent to the song, then push the new state. */
    async apply(command, args) {
      const { runCommand } = await commandsApi();
      runCommand(doc, command, args);
      frame(stateFrame());
      await ui.settle();
    },
    /**
     * Open another song in the same page element, the way a fresh visit does:
     * the page is taken down, the element names the other song, and it boots
     * again with that song's document.
     */
    async openSong(songId, nextDoc) {
      document.dispatchEvent(event("turbo:before-cache", {}));
      await ui.settle();
      const element = document.querySelector(".studio");
      assert.equal(typeof element.__studioBoot, "function", "the page can boot its element again");
      element.setAttribute("data-studio-song", String(songId));
      element.__studioBoot();
      await ui.settle();
      frame(stateFrame(nextDoc));
      await ui.settle();
    },
  };
  return ui;
}

// --- the grid's way into the pads -------------------------------------------

test("a sampler track's header opens the pads: a pattern in its first scene when it has none", async () => {
  const doc = await samplerDoc({ scenes: [SCENE, "chorus"] });
  const ui = await bootSong({ doc });

  const button = ui.document.querySelector(
    `[data-role=grid] [data-act=open-pads][data-track-id=${TRACK}]`,
  );
  assert.ok(button, "the sampler track's header carries Open pads");
  assert.equal(String(button.textContent), "Open pads", "in those words");
  assert.ok(
    ui.document.querySelector(`[data-role=grid] [data-act=new-pattern][data-track-id=${TRACK}]`),
    "and the cell's + Pattern is untouched",
  );

  ui.click(`[data-role=grid] [data-act=open-pads][data-track-id=${TRACK}]`);
  await ui.settle();

  const sent = ui.commands("clip.add_pattern");
  assert.equal(sent.length, 1, "one clip.add_pattern was sent");
  assert.equal(sent[0].args.track_id, TRACK, "on the sampler track");
  assert.equal(sent[0].args.scene_id, SCENE, "in the song's FIRST scene");
  assert.equal(sent[0].args.length_steps, 16, "sixteen steps long");

  // The song has the pattern now: the view opens on it.
  await ui.apply("clip.add_pattern", sent[0].args);
  const view = ui.view();
  assert.match(String(view.querySelector(".st-sampler-head").textContent), /Beat box/);
  assert.ok(view.querySelector('[data-act=pad][data-pad-index="0"]'), "with its pads drawn");
  assert.ok(ui.document.querySelector('[data-role=sampler-steps] [data-act=step][data-at="0"]'), "and its steps");
});

test("a sampler track that already has a pattern opens it, and sends nothing", async () => {
  const doc = await samplerDoc({ scenes: [SCENE, "chorus"], pattern: true });
  const ui = await bootSong({ doc });

  const before = ui.sent.filter((message) => message.type === "command").length;
  ui.click(`[data-role=grid] [data-act=open-pads][data-track-id=${TRACK}]`);
  await ui.settle();

  assert.equal(
    ui.sent.filter((message) => message.type === "command").length,
    before,
    "nothing was sent: the pattern was already there",
  );
  ui.view();
  assert.ok(
    ui.document.querySelector('[data-role=sampler-steps] [data-act=step][data-at="0"]'),
    "the pattern the track has is the one open",
  );
  const focus = ui.sent.filter((message) => message.type === "focus").pop();
  assert.equal(focus.ref, `clip:${CLIP}`, "and the page says which clip it has open");
});

test("a song with no scene gets Scene 1 before the pattern is made", async () => {
  const doc = await samplerDoc({ scenes: [] });
  const ui = await bootSong({ doc });

  ui.click(`[data-role=grid] [data-act=open-pads][data-track-id=${TRACK}]`);
  await ui.settle();

  const order = ui.sent.filter((message) => message.type === "command").map((message) => message.command);
  assert.deepEqual(
    order.slice(-2),
    ["scene.add", "clip.add_pattern"],
    "the scene is added first, and the pattern after it",
  );

  const scene = ui.commands("scene.add")[0];
  assert.match(String(scene.args.id), /^s-/, "with a fresh scene id");
  assert.equal(scene.args.name, "Scene 1", "named Scene 1");

  const pattern = ui.commands("clip.add_pattern")[0];
  assert.equal(pattern.args.scene_id, scene.args.id, "and the pattern is made in that very scene");
  assert.equal(pattern.args.track_id, TRACK, "on the sampler track");
});

// --- the track this page added ----------------------------------------------

test("a sampler track added here opens its pads; one that arrives from elsewhere does not", async () => {
  const doc = await samplerDoc({ scenes: [SCENE] });
  const ui = await bootSong({ doc });

  ui.click("[data-act=add-sampler-track]");
  await ui.settle();

  const added = ui.commands("track.add");
  assert.equal(added.length, 1, "one track.add was sent");
  assert.equal(added[0].args.kind, "sampler", "for a sampler track");
  assert.equal(
    ui.document.querySelector("[data-role=sampler]").hidden,
    true,
    "nothing opens before the song has the track",
  );

  // The hub's answer: the track is in the song.
  await ui.apply("track.add", added[0].args);

  const patterns = ui.commands("clip.add_pattern");
  assert.equal(patterns.length, 1, "the new track's pads opened: a pattern was made for it");
  assert.equal(patterns[0].args.track_id, added[0].args.id, "on the track this page added");

  await ui.apply("clip.add_pattern", patterns[0].args);
  ui.view();
  assert.ok(
    ui.document.querySelector(`[data-role=grid] [data-act=open-pads][data-track-id="${added[0].args.id}"]`),
    "and the new track has its own Open pads button",
  );

  // The same track arriving from the agent, on a page that did not add it: the
  // button, and nothing else.
  const other = await samplerDoc({ scenes: [SCENE] });
  const second = await bootSong({ doc: other });
  const { runCommand } = await commandsApi();
  runCommand(other, "track.add", { id: "t-agent", name: "Sampler 9", kind: "sampler" });
  second.frame(second.stateFrame(other));
  await second.settle();

  assert.equal(
    second.document.querySelector("[data-role=sampler]").hidden,
    true,
    "a track that arrived from elsewhere opens nothing by itself",
  );
  assert.equal(second.commands("clip.add_pattern").length, 0, "and no pattern was made for it");
  assert.ok(
    second.document.querySelector("[data-role=grid] [data-act=open-pads][data-track-id=t-agent]"),
    "it only has the header's button",
  );
});

// --- the step the transport is on -------------------------------------------

test("the step sequencer marks where the transport is, and clears it on Stop", async () => {
  const doc = await samplerDoc({ scenes: [SCENE], pattern: true });
  const ui = await bootSong({ doc, engine: true });
  await ui.openSampler();

  ui.click("[data-act=play]");
  await ui.settle();
  assert.equal(ui.engine.calls.play, 1, "the fake engine is playing");

  // Bar 1, beat 2, sixteenth 3 of a 16-step pattern at a sixteenth a step.
  ui.playhead(1, 2, 3);
  const first = ui.nowCells();
  assert.equal(first.length, 1, "exactly one cell is where the transport is");
  assert.equal(first[0].getAttribute("data-at"), "6", "bar 1 beat 2 sixteenth 3 is step 6 (0-based)");
  assert.equal(first[0].getAttribute("data-now"), "true", "and it says so on the cell");

  // The next report moves the mark, and leaves nothing behind.
  ui.playhead(1, 1, 1);
  const second = ui.nowCells();
  assert.equal(second.length, 1, "still exactly one cell");
  assert.equal(second[0].getAttribute("data-at"), "0", "back at the top of the loop: step 0");
  assert.equal(ui.step(6).getAttribute("data-now"), "false", "the cell it left says it is no longer it");
  assert.equal(String(ui.step(6).className).includes("st-step-now"), false, "and carries no mark");

  // A stopped transport marks nothing at all.
  ui.click("[data-act=stop]");
  await ui.settle();
  assert.equal(ui.nowCells().length, 0, "the mark goes with the transport");
  for (const cell of ui.document.querySelectorAll("[data-role=sampler-steps] .st-step")) {
    assert.equal(cell.getAttribute("data-now"), "false", "and every cell says it is not the one");
  }
});

// --- where the lock strip lives ---------------------------------------------

test("the lock strip sits beside the steps, and the steps say how to lock one", async () => {
  const doc = await samplerDoc({ scenes: [SCENE], pattern: true, hits: [2] });
  const ui = await bootSong({ doc });
  await ui.openSampler();

  const box = ui.stepsBox();
  const hint = box.querySelector(".st-step-hint");
  assert.ok(hint, "with no lock on, the steps box carries one line of hint");
  assert.equal(String(hint.textContent), HINT, "which is the sentence about locking a step");
  assert.ok(box.querySelector("[data-role=step-lock]") === null, "and no lock strip is drawn");

  const onStep = ui.step(2);
  assert.equal(onStep.getAttribute("data-step-on"), "true", "step 3 has a hit");
  assert.ok(
    String(onStep.getAttribute("title")).startsWith(HINT),
    "an ON step's title starts with the same sentence",
  );
  assert.equal(
    ui.step(0).getAttribute("title"),
    "Click to put a step here",
    "an empty step still says what a click does there",
  );

  // A quarter of a second on the step that has a hit is a lock, not a toggle.
  ui.holdStep(2);
  ui.release();
  await ui.settle();

  const strips = ui.document.querySelectorAll("[data-role=step-lock]");
  assert.equal(strips.length, 1, "holding the step entered lock mode, once");
  const strip = strips[0];
  assert.match(String(strip.textContent), /Locking step 3/, "the strip names the step being locked");
  assert.equal(
    String(strip.querySelector("[data-act=step-lock-done]").textContent),
    "Done",
    "and keeps its way out",
  );

  // Entering lock mode re-rendered the page: the box captured before the hold is
  // detached now, so every assertion after the render reads the live one.
  const liveBox = ui.stepsBox();

  // It is drawn with the steps, in the steps host, and not in the pads or the
  // effects host.
  const holder = ui.document.querySelector("[data-role=sampler-steps] .st-step-strip").parentElement;
  assert.ok(holder.contains(strip), "the strip is inside the box that holds the step strip");
  assert.ok(liveBox.contains(strip), "and that box is the live steps box");
  assert.ok(holder === liveBox, "which is the steps box itself");
  const stepsHost = ui.document.querySelector("[data-role=sampler-steps]");
  assert.ok(stepsHost.contains(liveBox), "the steps box is in the steps widget's own host");
  assert.equal(ui.document.querySelector("[data-role=sampler-pads]").contains(strip), false, "and not in the pads host");

  // With the lock on, the hint gives the place to the strip.
  assert.ok(liveBox.querySelector(".st-step-hint") === null, "the hint gives way to the strip");

  // Done leaves lock mode, and the hint comes back.
  ui.click("[data-act=step-lock-done]");
  await ui.settle();
  assert.ok(ui.document.querySelector("[data-role=step-lock]") === null, "Done leaves lock mode");
  const afterDone = ui.stepsBox();
  assert.equal(
    String(afterDone.querySelector(".st-step-hint").textContent),
    HINT,
    "and the hint is back under the steps",
  );
});

// --- the live lights (G9) ---------------------------------------------------

/** The pad button of the grid on screen, by its index. */
function padAt(ui, index) {
  return ui.document.querySelector(
    `[data-role=sampler-pads] [data-act=pad][data-pad-index="${index}"]`,
  );
}

/** @returns {number} the strength a pad's flash was given (its --hit value) */
function hitStrength(node) {
  return Number(node.style.getPropertyValue("--hit"));
}

test("a hit flashes exactly that pad, and a harder hit is brighter", async () => {
  const doc = await samplerDoc({ scenes: [SCENE], pattern: true });
  const bankId = await firstBankId(doc);
  const ui = await bootSong({ doc, engine: true });
  await ui.openSampler();
  ui.click("[data-act=play]");
  await ui.settle();
  // The clock is long past every frame these hits carry.
  ui.audio().currentTime = 10;

  ui.hit(TRACK, bankId, 3, 127, 48000);
  ui.runFrames();

  const hard = padAt(ui, 3);
  assert.ok(hard, "pad 4 is drawn");
  assert.equal(String(hard.className).includes("st-pad-hit"), true, "the pad the hit names flashes");
  assert.ok(Math.abs(hitStrength(hard) - 127 / 127) < 0.01, "--hit is v/127");
  for (const index of [0, 1, 2, 4, 5, 15]) {
    assert.equal(String(padAt(ui, index).className).includes("st-pad-hit"), false,
      `pad ${index + 1} does not flash`);
  }

  // The same frame rate, a softer hit: a smaller --hit and so a dimmer flash.
  ui.hit(TRACK, bankId, 5, 32, 48000);
  ui.runFrames();
  const soft = padAt(ui, 5);
  assert.equal(String(soft.className).includes("st-pad-hit"), true, "its own pad flashes");
  assert.ok(Math.abs(hitStrength(soft) - 32 / 127) < 0.01, "--hit is that velocity over 127");
  assert.ok(hitStrength(soft) < hitStrength(hard), "a harder hit is brighter");
});

test("a hit waits for the frame it is heard on, output latency included", async () => {
  const doc = await samplerDoc({ scenes: [SCENE], pattern: true });
  const bankId = await firstBankId(doc);
  const ui = await bootSong({ doc, engine: true });
  await ui.openSampler();
  ui.click("[data-act=play]");
  await ui.settle();
  // 48 kHz and 50 ms of output latency: frame 4800 is 0.1 s of context time.
  const clock = ui.audio();
  clock.currentTime = 0;
  assert.equal(clock.outputLatency, 0.05, "the fake clock has 50 ms of output latency");

  ui.hit(TRACK, bankId, 0, 100, 4800);
  assert.equal(ui.window.__crowStudioPadQueue.length, 1, "the hit waits in the queue");
  assert.equal(String(padAt(ui, 0).className).includes("st-pad-hit"), false, "nothing is painted on arrival");

  clock.currentTime = 0.1;
  ui.runFrames();
  assert.equal(String(padAt(ui, 0).className).includes("st-pad-hit"), false,
    "it is not painted at its own context time");
  assert.equal(ui.window.__crowStudioPadQueue.length, 1, "it is still waiting");

  clock.currentTime = 0.149;
  ui.runFrames();
  assert.equal(String(padAt(ui, 0).className).includes("st-pad-hit"), false,
    "just short of the latency is still too early");

  clock.currentTime = 0.15;
  ui.runFrames();
  assert.equal(String(padAt(ui, 0).className).includes("st-pad-hit"), true,
    "painted 50 ms after its context time");
  assert.equal(ui.window.__crowStudioPadQueue.length, 0, "and the queue is empty");
});

test("the playing step and the pads it starts are painted in one animation frame", async () => {
  const doc = await samplerDoc({ scenes: [SCENE], pattern: true });
  const bankId = await firstBankId(doc);
  const ui = await bootSong({ doc, engine: true });
  await ui.openSampler();
  ui.click("[data-act=play]");
  await ui.settle();
  const clock = ui.audio();
  clock.currentTime = 1;

  // One report and the pads its block started share the frame they are heard on.
  // The Play render already marks step 0 (the position a new run starts on), so
  // this report is a step further in: step 6, which no render has marked yet.
  const frame = 48000 * 2;
  ui.playhead(1, 2, 3, frame);
  ui.hit(TRACK, bankId, 0, 110, frame);

  clock.currentTime = 1.99;
  ui.runFrames();
  const before = ui.nowCells();
  assert.equal(before.length, 1, "only the step the Play render marked is marked");
  assert.equal(before[0].getAttribute("data-at"), "0", "the report's step is not painted yet");
  assert.equal(String(padAt(ui, 0).className).includes("st-pad-hit"), false, "and no pad either");

  clock.currentTime = 2.05;
  ui.runFrames();
  const cells = ui.nowCells();
  assert.equal(cells.length, 1, "the step is marked");
  assert.equal(cells[0].getAttribute("data-at"), "6", "step 6 is where the transport is");
  assert.equal(String(padAt(ui, 0).className).includes("st-pad-hit"), true,
    "and the pad it started flashed in that very frame");
});

test("painting sixteen hits adds or removes no node and leaves the pads alone", async () => {
  const doc = await samplerDoc({ scenes: [SCENE], pattern: true });
  const bankId = await firstBankId(doc);
  const ui = await bootSong({ doc, engine: true });
  await ui.openSampler();
  ui.click("[data-act=play]");
  await ui.settle();
  ui.audio().currentTime = 10;

  const pads = [...ui.document.querySelectorAll("[data-role=sampler-pads] [data-act=pad]")];
  assert.equal(pads.length, 16, "sixteen pads are drawn");
  const focused = pads[0];
  let focusCalls = 0;
  focused.focus = function () {
    focusCalls += 1;
  };
  const nodes = ui.document.querySelectorAll("*").length;
  const boxes = ui.view().children.length;

  for (let index = 0; index < 16; index += 1) ui.hit(TRACK, bankId, index, 40 + index, 48000);
  ui.runFrames();

  assert.equal(ui.document.querySelectorAll("*").length, nodes, "no node was added or removed");
  assert.equal(ui.view().children.length, boxes, "the pads host holds the same boxes");
  assert.equal(focusCalls, 0, "painting never focuses a control");
  assert.equal(ui.view().contains(focused), true, "the pad that had the keyboard is the same node");
  for (const pad of pads) {
    assert.equal(String(pad.className).includes("st-pad-hit"), true, "every hit flashed its own pad");
  }
});

test("the queue holds 256 events at most while no animation frame runs", async () => {
  const doc = await samplerDoc({ scenes: [SCENE], pattern: true });
  const bankId = await firstBankId(doc);
  const ui = await bootSong({ doc, engine: true });
  await ui.openSampler();
  ui.click("[data-act=play]");
  await ui.settle();
  ui.audio().currentTime = 0;

  // A hidden page gets no animation frames: everything waits.
  for (let index = 0; index < 300; index += 1) ui.hit(TRACK, bankId, index % 16, 100, 48000 * 60);

  assert.equal(ui.window.__crowStudioPadQueue.length, 256, "the queue is capped at 256");
  assert.equal(ui.waitingFrames(), 1, "one animation frame waits, not one per hit");
});

test("state events set and clear a pad's light, and a redraw keeps it", async () => {
  const doc = await samplerDoc({ scenes: [SCENE], pattern: true });
  const bankId = await firstBankId(doc);
  const ui = await bootSong({ doc, engine: true });
  await ui.openSampler();
  ui.click("[data-act=play]");
  await ui.settle();

  const state = (code) => ui.padEvent({
    frame: 0, track_id: TRACK, bank_id: bankId, index: 0, kind: "state", state: code,
  });

  state(1);
  assert.equal(String(padAt(ui, 0).className).includes("st-pad-on"), true, "state 1 lights the pad as on");
  assert.equal(padAt(ui, 0).getAttribute("data-light"), "1");

  // A pads-host render builds new buttons: the light map puts the class back.
  ui.frame(ui.stateFrame());
  await ui.settle();
  assert.equal(String(padAt(ui, 0).className).includes("st-pad-on"), true, "a redraw keeps the light");

  state(2);
  assert.equal(String(padAt(ui, 0).className).includes("st-pad-loop"), true, "state 2 is a loop");
  assert.equal(String(padAt(ui, 0).className).includes("st-pad-on"), false, "and not the on light");

  state(3);
  assert.equal(String(padAt(ui, 0).className).includes("st-pad-held"), true, "state 3 is held");
  assert.equal(String(padAt(ui, 0).className).includes("st-pad-loop"), false, "and not the loop light");

  state(0);
  assert.equal(String(padAt(ui, 0).className).includes("st-pad-held"), false, "state 0 clears the light");
  assert.equal(padAt(ui, 0).getAttribute("data-light"), "0");
});

test("a MIDI fx.hold press shows the fx button as pressed", async () => {
  const doc = await samplerDoc({ scenes: [SCENE], pattern: true });
  await mapFxHold(doc, "stutter", 60);
  const ui = await bootSong({ doc, engine: true });
  await ui.openSampler();
  ui.connectMidi();
  await ui.settle();

  const button = ui.document.querySelector("[data-role=sampler-fx] [data-act=fx-hold][data-fx-name=stutter]");
  assert.ok(button, "the Stutter button is on the page");
  assert.equal(String(button.className).includes("st-on"), false, "nothing is held yet");

  ui.pedal([0x90, 60, 100]);
  await ui.settle();
  assert.equal(String(button.className).includes("st-on"), true, "the pedal's press shows on its button");
  assert.equal(button.getAttribute("aria-pressed"), "true");

  ui.pedal([0x80, 60, 0]);
  await ui.settle();
  assert.equal(String(button.className).includes("st-on"), false, "letting the note go releases it");
  assert.equal(button.getAttribute("aria-pressed"), "false");
});

test("a reduced-motion browser gets a colour change with no animation", async () => {
  const html = await render({ song: "song-1" });
  const at = html.indexOf("@media (prefers-reduced-motion: reduce)");
  assert.ok(at >= 0, "the page carries a reduced-motion rule");
  const block = html.slice(at, at + 500);
  assert.match(block, /\.st-pad-hit/, "it names the hit flash");
  assert.match(block, /animation: none/, "and takes the animation away");
  assert.match(block, /background: #F2A541/, "leaving a colour change");

  const flashAt = html.indexOf(".studio .st-pad.st-pad-hit");
  assert.ok(flashAt >= 0, "the ordinary rule is there too");
  const flash = html.slice(flashAt, flashAt + 300);
  assert.match(flash, /animation: st-pad-flash/, "which does animate");
  assert.match(html.slice(0, at), /--hit/, "and its strength is --hit");
});

// --- the fx hold a controller is holding ------------------------------------

test("a tap anywhere on the page does not release a controller's effect", async () => {
  const doc = await samplerDoc({ scenes: [SCENE], pattern: true });
  await mapFxHold(doc, "stutter", 60);
  const ui = await bootSong({ doc, engine: true });
  const holds = [];
  const releases = [];
  ui.engine.engine.fxHold = function (name) {
    holds.push(String(name));
  };
  ui.engine.engine.fxRelease = function (name) {
    releases.push(String(name));
  };
  await ui.openSampler();
  ui.connectMidi();
  await ui.settle();

  const fxButton = () => ui.document.querySelector(
    "[data-role=sampler-fx] [data-act=fx-hold][data-fx-name=stutter]",
  );
  assert.ok(fxButton(), "the Stutter button is on the page");

  ui.pedal([0x90, 60, 100]);
  await ui.settle();
  assert.deepEqual(holds, ["stutter"], "the pedal holds the effect in the engine");
  assert.equal(fxButton().getAttribute("aria-pressed"), "true", "and its button shows the hold");

  // A finger's release anywhere on the page: it lets go of what a FINGER holds,
  // and the pedal is still down.
  ui.release();
  await ui.settle();
  assert.deepEqual(releases, [], "nothing was released in the engine");
  assert.equal(fxButton().getAttribute("aria-pressed"), "true", "the pedal's hold is still on the button");

  ui.pedal([0x80, 60, 0]);
  await ui.settle();
  assert.deepEqual(releases, ["stutter"], "letting the note go is what releases it");
  assert.equal(fxButton().getAttribute("aria-pressed"), "false", "and the button says so");
});

// --- the step a queued report was made for ----------------------------------

test("two reports waiting in the queue each paint the step they were made for", async () => {
  const doc = await samplerDoc({ scenes: [SCENE], pattern: true });
  const bankId = await firstBankId(doc);
  const ui = await bootSong({ doc, engine: true });
  await ui.openSampler();
  ui.click("[data-act=play]");
  await ui.settle();
  const clock = ui.audio();
  clock.currentTime = 1;

  // Two reports arrive before either is heard, one report apart: step 4 (bar 1,
  // beat 2) and step 6 (bar 1, beat 2, sixteenth 3), both on the page drawn.
  // Each brings the hit its block started.
  const firstFrame = 48000 * 2;
  const secondFrame = 48000 * 2 + 4800;
  ui.playhead(1, 2, 1, firstFrame);
  ui.hit(TRACK, bankId, 0, 110, firstFrame);
  ui.playhead(1, 2, 3, secondFrame);
  ui.hit(TRACK, bankId, 1, 110, secondFrame);

  clock.currentTime = 2.05;
  ui.runFrames();
  const first = ui.nowCells();
  assert.equal(first.length, 1, "one step is marked");
  assert.equal(first[0].getAttribute("data-at"), "4", "the step the FIRST report named, not the newest");
  assert.equal(String(padAt(ui, 0).className).includes("st-pad-hit"), true, "with the pad that block started");
  assert.equal(String(padAt(ui, 1).className).includes("st-pad-hit"), false, "and not the later block's pad");
  assert.equal(ui.window.__crowStudioPadQueue.length, 2, "the later report and its hit are still waiting");

  clock.currentTime = 2.15;
  ui.runFrames();
  const second = ui.nowCells();
  assert.equal(second.length, 1, "still one step marked");
  assert.equal(second[0].getAttribute("data-at"), "6", "and it is the step the SECOND report named");
  assert.equal(String(padAt(ui, 1).className).includes("st-pad-hit"), true, "with its own pad");
  assert.equal(ui.window.__crowStudioPadQueue.length, 0, "and nothing waits any more");
});

// --- a state's light -------------------------------------------------------

test("a state event lights its pad on arrival, even for a frame still to come", async () => {
  const doc = await samplerDoc({ scenes: [SCENE], pattern: true });
  const bankId = await firstBankId(doc);
  const ui = await bootSong({ doc, engine: true });
  await ui.openSampler();
  ui.click("[data-act=play]");
  await ui.settle();
  ui.audio().currentTime = 1;

  // A pad's light is a state that stays where the engine left it, not a flash
  // landing on an instant: it is drawn when the report arrives, so it can lead
  // the hit it belongs to by up to the output latency.
  ui.padEvent({
    frame: 48000 * 90, track_id: TRACK, bank_id: bankId, index: 0, kind: "state", state: 1,
  });
  assert.equal(String(padAt(ui, 0).className).includes("st-pad-on"), true,
    "the light is on as soon as the report is in");
  assert.equal(ui.window.__crowStudioPadQueue.length, 0, "and nothing about it waits for a frame");
});

// --- the queue a page comes back to ----------------------------------------

test("a page that was not painting drops the hits whose frames are long gone", async () => {
  const doc = await samplerDoc({ scenes: [SCENE], pattern: true });
  const bankId = await firstBankId(doc);
  const ui = await bootSong({ doc, engine: true });
  await ui.openSampler();
  ui.click("[data-act=play]");
  await ui.settle();
  const clock = ui.audio();
  clock.currentTime = 1;

  // One hit painted while the page is painting.
  ui.hit(TRACK, bankId, 2, 100, 48000);
  clock.currentTime = 1.05;
  ui.runFrames();
  assert.equal(String(padAt(ui, 2).className).includes("st-pad-hit"), true, "a hit lands on its frame");

  // The tab is hidden and gets no animation frames: the engine plays on.
  for (let index = 0; index < 8; index += 1) {
    ui.hit(TRACK, bankId, 4, 90, Math.round(48000 * (1 + index * 0.1)));
  }
  // Back in the foreground: the hit that is being heard now, and the backlog
  // behind it.
  clock.currentTime = 3;
  ui.hit(TRACK, bankId, 5, 90, Math.round(2.95 * clock.sampleRate));
  ui.runFrames();

  assert.equal(ui.window.__crowStudioPadQueue.length, 0, "nothing waits afterwards");
  assert.equal(String(padAt(ui, 4).className).includes("st-pad-hit"), false,
    "the backlog's lights are not all painted in one frame");
  assert.equal(String(padAt(ui, 5).className).includes("st-pad-hit"), true,
    "the hit that is being heard now is");
});

// --- a clock that has not started ------------------------------------------

test("a context that answers no timestamp is timed from its output latency", async () => {
  const doc = await samplerDoc({ scenes: [SCENE], pattern: true });
  const bankId = await firstBankId(doc);
  const ui = await bootSong({ doc, engine: true });
  await ui.openSampler();
  ui.click("[data-act=play]");
  await ui.settle();

  // A context that has not started answers 0 for both the context time and the
  // performance time: that pairing maps every frame a latency too early.
  const clock = ui.audio();
  clock.getOutputTimestamp = function () {
    return { contextTime: 0, performanceTime: 0 };
  };
  clock.currentTime = 1;

  // Frame 48000 is 1 s of context time, and it is heard 50 ms after that.
  ui.hit(TRACK, bankId, 0, 100, 48000);
  ui.runFrames();
  assert.equal(String(padAt(ui, 0).className).includes("st-pad-hit"), false,
    "it is not painted at its own context time");
  assert.equal(ui.window.__crowStudioPadQueue.length, 1, "it waits for the latency the fallback adds");

  clock.currentTime = 1.05;
  ui.runFrames();
  assert.equal(String(padAt(ui, 0).className).includes("st-pad-hit"), true,
    "and is painted 50 ms after its context time");
});

// --- the control the keyboard was on ---------------------------------------

test("focus comes back to the effect it was on, not the first one like it", async () => {
  const doc = await samplerDoc({ scenes: [SCENE], pattern: true });
  const ui = await bootSong({ doc, engine: true });
  await ui.openSampler();

  const fxButtons = () => [...ui.document.querySelectorAll("[data-role=sampler-fx] [data-act=fx-hold]")];
  const stutter = ui.document.querySelector(
    "[data-role=sampler-fx] [data-act=fx-hold][data-fx-name=stutter]",
  );
  assert.ok(stutter, "the Stutter button is drawn");
  assert.notEqual(fxButtons()[0], stutter, "and it is not the first of the effects drawn");

  // This document only keeps the focus the page ASKS for, so every focus() is
  // caught here.
  const focused = [];
  const prototype = Object.getPrototypeOf(stutter);
  const original = prototype.focus;
  prototype.focus = function () {
    focused.push(this.getAttribute ? this.getAttribute("data-fx-name") : null);
    return original.call(this);
  };
  try {
    ui.document.activeElement = stutter;
    // A redraw of the song as it is: the effects host is drawn again from it.
    ui.frame(ui.stateFrame());
    await ui.settle();

    assert.notEqual(fxButtons().length, 0, "the effects are drawn again");
    assert.deepEqual(focused, ["stutter"], "the focus went back to the same effect and nowhere else");
  } finally {
    prototype.focus = original;
    ui.document.activeElement = null;
  }
});

// --- the selected pad's settings, in groups ----------------------------------

/** The settings every playback, tuning and envelope control may set on the bank. */
const BANK_FIELDS = [
  "mode", "loop", "reverse", "bpm_sync", "fixed_velocity",
  "pitch", "speed_pct",
  "attack_ms", "hold_ms", "decay_ms", "sustain", "release_ms",
];

/** One control of the selected pad, by the field it writes. */
function padControl(ui, field, index = 0) {
  const node = ui.document.querySelector(
    `[data-role=sampler-pads] [data-pad-field="${field}"][data-pad-index="${index}"]`,
  );
  assert.ok(node, `the ${field} control is drawn`);
  return node;
}

/** The one option a select has selected. */
function selectedOption(select) {
  const chosen = [...select.querySelectorAll("option")].filter((option) => option.selected === true);
  assert.equal(chosen.length, 1, "exactly one option is selected");
  return chosen[0];
}

/** Change one control the way a person does: set it, then let it go. */
async function changeControl(ui, node, value) {
  if (String(node.type) === "checkbox") {
    node.checked = value;
  } else if (String(node.tagName) === "SELECT") {
    // A select's own value is read-only in this document: the option is picked
    // the way a person picks one.
    for (const option of [...node.querySelectorAll("option")]) {
      if (String(option.value) === String(value)) option.selected = true;
    }
    assert.equal(node.value, String(value), `the ${String(node.getAttribute("data-pad-field"))} select took the pick`);
  } else {
    node.value = String(value);
  }
  node.dispatchEvent(ui.event("change", { target: node }));
  await ui.settle();
}

/** The fixture pad as the song stores it (pad 1 of its one bank). */
async function storedPad(doc) {
  const { snapshot } = await import("../bundles/studio/server/doc.js");
  const bankId = await firstBankId(doc);
  return snapshot(doc).pads[`${TRACK}/${bankId}/0`];
}

/**
 * Take the fields a song written before this phase does not carry off the
 * fixture pad, so the page reads it the way it reads an old song.
 * @returns {Promise<string>} the bank id
 */
async function stripNewPadKeys(doc) {
  const bankId = await firstBankId(doc);
  const pads = doc.getMap("song").get("pads");
  const pad = pads.get(`${TRACK}/${bankId}/0`);
  assert.ok(pad, "the fixture pad is in the song");
  for (const key of ["mode", "loop", "bpm_sync", "source_bpm_x10", "speed_pct",
    "fixed_velocity", "hold_ms", "keep_pitch"]) {
    pad.delete(key);
  }
  assert.equal(pad.has("loop"), false, "the loop key is gone from the document");
  return bankId;
}

test("each pad control sends exactly one pad.set with the field and its value", async () => {
  const doc = await samplerDoc({ scenes: [SCENE], pattern: true });
  const ui = await bootSong({ doc });
  const bankId = await firstBankId(ui.doc);
  await ui.openSampler();

  // Every control of the panel, with a value and the one field it must send.
  const table = [
    ["mode", "normal", { mode: "normal" }],
    ["loop", "pingpong", { loop: "pingpong" }],
    ["reverse", true, { reverse: true }],
    ["bpm_sync", true, { bpm_sync: true }],
    ["source_bpm_x10", 1240, { source_bpm_x10: 1240 }],
    ["fixed_velocity", true, { fixed_velocity: true }],
    ["pitch", 7, { pitch: 7 }],
    ["speed_pct", 120, { speed_pct: 120 }],
    ["attack_ms", 40, { attack_ms: 40 }],
    ["hold_ms", 300, { hold_ms: 300 }],
    ["decay_ms", 250, { decay_ms: 250 }],
    ["sustain", 0.4, { sustain: 0.4 }],
    ["release_ms", 120, { release_ms: 120 }],
    ["choke", 10, { choke: 10 }],
    ["gain_db", -3, { gain_db: -3 }],
    ["pan", -0.5, { pan: -0.5 }],
  ];

  let sent = 0;
  for (const [field, value, fields] of table) {
    // The host is drawn again from the song, so the control is a new node.
    await changeControl(ui, padControl(ui, field), value);
    const commands = ui.commands("pad.set");
    assert.equal(commands.length, sent + 1, `${field}: one release, one pad.set`);
    assert.equal(commands[sent].args.track_id, TRACK);
    assert.equal(commands[sent].args.bank_id, bankId);
    assert.equal(commands[sent].args.index, 0, "on the selected pad");
    assert.deepEqual(commands[sent].args.fields, fields, `${field} carries its own value`);
    sent += 1;
  }
  assert.equal(ui.commands("pad.set_bank").length, 0, "no control wrote the bank on its own");
});

test("a checkbox sends a boolean and the loop select sends its string", async () => {
  const doc = await samplerDoc({ scenes: [SCENE], pattern: true });
  const ui = await bootSong({ doc });
  await ui.openSampler();

  await changeControl(ui, padControl(ui, "reverse"), true);
  const first = ui.commands("pad.set");
  assert.equal(first.length, 1);
  assert.equal(typeof first[0].args.fields.reverse, "boolean", "a switch is a boolean");
  assert.equal(first[0].args.fields.reverse, true);

  await changeControl(ui, padControl(ui, "loop"), "loop");
  const second = ui.commands("pad.set");
  assert.equal(second.length, 2);
  assert.equal(typeof second[1].args.fields.loop, "string", "the loop is the word it stores");
  assert.deepEqual(second[1].args.fields, { loop: "loop" });
});

test("a slider held between two steps sends the whole number the field takes", async () => {
  const doc = await samplerDoc({ scenes: [SCENE], pattern: true });
  const ui = await bootSong({ doc });
  await ui.openSampler();

  // A browser hands a range a value between two of its steps: the field is an
  // integer, so the page rounds it instead of being refused.
  await changeControl(ui, padControl(ui, "speed_pct"), "99.6");
  const sent = ui.commands("pad.set");
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].args.fields, { speed_pct: 100 }, "99.6 is sent as 100");

  // And the hub takes it: the song holds the whole number.
  await ui.apply("pad.set", sent[0].args);
  assert.equal((await storedPad(ui.doc)).speed_pct, 100);
});

test("the sample tempo reads in BPM and is sent as a tempo the field takes", async () => {
  const doc = await samplerDoc({ scenes: [SCENE], pattern: true });
  const ui = await bootSong({ doc });
  await ui.openSampler();

  // The control is the sample's own tempo in BPM, and 0 is the pad having none.
  const label = padControl(ui, "source_bpm_x10").parentNode.querySelector(".st-pad-range-label");
  assert.ok(label, "the sample tempo control has its label");
  assert.equal(String(label.textContent), "Sample tempo (BPM)", "which says the unit in words");
  assert.equal(padControl(ui, "source_bpm_x10").min, "0", "0 is not set");
  assert.equal(padControl(ui, "source_bpm_x10").max, "3000", "300.0 BPM is the top, times ten");

  const readout = () => String(
    padControl(ui, "source_bpm_x10").parentNode.querySelector("[data-pad-readout]").textContent,
  );
  assert.equal(readout(), "Not set", "a pad with no tempo of its own says so");

  // The stored field reads 0 (not set) or 20.0-300.0 BPM times ten and refuses
  // the band between. The slider still passes through that band, so a value in
  // it is sent as the reading it is nearest: none below 10.0 BPM, 20.0 from
  // there up. The readout follows the value the field receives.
  const cases = [
    [50, 0, "Not set"],
    [150, 200, "20.0 BPM"],
    [1200, 1200, "120.0 BPM"],
  ];
  let sent = 0;
  for (const [value, field, shown] of cases) {
    await changeControl(ui, padControl(ui, "source_bpm_x10"), value);
    const commands = ui.commands("pad.set");
    assert.equal(commands.length, sent + 1, `${value}: one release, one pad.set`);
    assert.deepEqual(commands[sent].args.fields, { source_bpm_x10: field },
      `${value} is sent as ${field}`);
    assert.equal(readout(), shown, `${value} reads as ${shown}`);
    sent += 1;
  }
});

test("whole bank sends one pad.set_bank with only that field", async () => {
  const doc = await samplerDoc({ scenes: [SCENE], pattern: true });
  const ui = await bootSong({ doc });
  const bankId = await firstBankId(ui.doc);
  await ui.openSampler();

  // Every playback, tuning and envelope control has a whole-bank button.
  for (const field of BANK_FIELDS) {
    assert.ok(
      ui.document.querySelector(`[data-act=pad-bank][data-bank-field="${field}"]`),
      `the ${field} control can be set on the whole bank`,
    );
  }
  // The mute group never does, and neither do the mix, the filter and the
  // sample's own tempo: those are not whole-bank fields.
  for (const field of ["choke", "gain_db", "pan", "filter.type", "filter.cutoff_hz",
    "filter.resonance", "source_bpm_x10"]) {
    assert.equal(
      ui.document.querySelector(`[data-bank-field="${field}"]`),
      null,
      `${field} is not a whole-bank field`,
    );
  }

  // A press sends ONE pad.set_bank, carrying the value the control holds.
  padControl(ui, "speed_pct").value = "130";
  ui.click("[data-act=pad-bank][data-bank-field=speed_pct]");
  await ui.settle();
  const sent = ui.commands("pad.set_bank");
  assert.equal(sent.length, 1, "one press is one pad.set_bank");
  assert.deepEqual(sent[0].args, {
    track_id: TRACK, bank_id: bankId, fields: { speed_pct: 130 },
  }, "only the field its button names, and no other");
  assert.equal(ui.commands("pad.set").length, 0, "the selected pad is not written a second time");

  // A switch reaches the bank as the boolean it is.
  padControl(ui, "bpm_sync").checked = true;
  ui.click("[data-act=pad-bank][data-bank-field=bpm_sync]");
  await ui.settle();
  const both = ui.commands("pad.set_bank");
  assert.equal(both.length, 2, "the second press is one more command");
  assert.deepEqual(both[1].args.fields, { bpm_sync: true }, "and its own field is the only one in it");
});

test("the mute group offers None and A to J, and an older song's group keeps its letter", async () => {
  const doc = await samplerDoc({ scenes: [SCENE], pattern: true });
  const ui = await bootSong({ doc });
  await ui.openSampler();
  const bankId = await firstBankId(ui.doc);

  const select = padControl(ui, "choke");
  const options = [...select.querySelectorAll("option")];
  assert.equal(options.length, 11, "None and ten groups");
  assert.deepEqual(options.map((option) => option.value), ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"],
    "the groups are the stored integers 0 and 1-10");
  assert.deepEqual(options.map((option) => String(option.textContent)),
    ["None", "A", "B", "C", "D", "E", "F", "G", "H", "I", "J"],
    "and they are lettered A to J: A is 1 and J is 10");
  assert.equal(select.value, "0", "an empty pad is in no group");

  // An older song stores 3 for group C, and the panel says so rather than
  // showing no group at all.
  await ui.apply("pad.set", { track_id: TRACK, bank_id: bankId, index: 0, fields: { choke: 3 } });
  const after = padControl(ui, "choke");
  assert.equal(after.value, "3");
  assert.equal(String(selectedOption(after).textContent), "C", "group 3 reads as C");
});

test("a stored oneshot pad reads as One-shot (overlap), and normal reads as Normal", async () => {
  const doc = await samplerDoc({ scenes: [SCENE], pattern: true });
  const ui = await bootSong({ doc });
  await ui.openSampler();
  const bankId = await firstBankId(ui.doc);

  const mode = padControl(ui, "mode");
  assert.equal(mode.value, "oneshot", "every existing pad stores the one-shot");
  assert.equal(String(selectedOption(mode).textContent), "One-shot (overlap)",
    "which says what it does: presses overlap");
  assert.deepEqual([...mode.querySelectorAll("option")].map((option) => option.value),
    ["gate", "normal", "oneshot"], "Gate, Normal and One-shot, in that order");

  await ui.apply("pad.set", { track_id: TRACK, bank_id: bankId, index: 0, fields: { mode: "normal" } });
  const normal = padControl(ui, "mode");
  assert.equal(normal.value, "normal");
  assert.equal(String(selectedOption(normal).textContent), "Normal");
});

test("a pad with no loop key shows Off", async () => {
  const doc = await samplerDoc({ scenes: [SCENE], pattern: true });
  await stripNewPadKeys(doc);
  const ui = await bootSong({ doc });
  await ui.openSampler();

  const loop = padControl(ui, "loop");
  assert.equal(loop.value, "off", "a song with no loop key plays once");
  assert.equal(String(selectedOption(loop).textContent), "Off");
  assert.deepEqual([...loop.querySelectorAll("option")].map((option) => String(option.textContent)),
    ["Off", "Loop", "Ping-pong"], "with the two loop settings beside it");
});

test("the panel draws a pad that carries none of the new keys", async () => {
  const doc = await samplerDoc({ scenes: [SCENE], pattern: true });
  await stripNewPadKeys(doc);
  const ui = await bootSong({ doc });
  await ui.openSampler();

  for (const name of ["playback", "tuning", "envelope", "mute", "level", "filter"]) {
    assert.ok(ui.document.querySelector(`[data-pad-group="${name}"]`), `the ${name} group is drawn`);
  }
  assert.equal(padControl(ui, "speed_pct").value, "100", "a pad with no speed plays at 100 %");
  assert.equal(padControl(ui, "source_bpm_x10").value, "0", "with no tempo of its own");
  assert.equal(padControl(ui, "hold_ms").value, "0", "and no hold");
  assert.equal(padControl(ui, "bpm_sync").checked, false, "no BPM sync");
  assert.equal(padControl(ui, "fixed_velocity").checked, false, "and no fixed velocity");
  assert.equal(padControl(ui, "choke").value, "0", "in no mute group");
  assert.equal(padControl(ui, "gain_db").value, "0", "the pad's own settings are there too");

  // Nothing was written: an old song is never rewritten by opening it.
  assert.equal(ui.commands("pad.set").length, 0, "opening an old song writes nothing");
  assert.equal(ui.commands("pad.set_bank").length, 0, "and nothing to the bank");
});

test("BPM sync says there is no tempo to sync to until the pad has one", async () => {
  const doc = await samplerDoc({ scenes: [SCENE], pattern: true });
  const ui = await bootSong({ doc });
  const bankId = await firstBankId(ui.doc);
  await ui.openSampler();

  const note = () => {
    const node = ui.document.querySelector("[data-pad-note=bpm_sync]");
    assert.ok(node, "the BPM sync row has its note");
    return String(node.textContent);
  };
  assert.match(note(), /set a tempo/i, "with no tempo of its own the row says so");

  // Use song tempo takes the song's own 120 bpm onto this pad, times ten (the
  // integer the field is stored as).
  ui.click("[data-act=use-song-tempo]");
  await ui.settle();
  const sent = ui.commands("pad.set");
  assert.equal(sent.length, 1, "one press is one pad.set");
  assert.deepEqual(sent[0].args, {
    track_id: TRACK, bank_id: bankId, index: 0, fields: { source_bpm_x10: 1200 },
  }, "the song's tempo, times ten");

  await ui.apply("pad.set", sent[0].args);
  assert.match(note(), /120 BPM/, "and once it has one the row names it");
  assert.equal(padControl(ui, "source_bpm_x10").value, "1200", "the tempo control holds the stored value");
});

test("nothing in the panel writes keep_pitch", async () => {
  const doc = await samplerDoc({ scenes: [SCENE], pattern: true });
  const ui = await bootSong({ doc });
  await ui.openSampler();

  // The field is reserved for the later time-stretch: no control offers it, and
  // no whole-bank button sends it.
  const fields = [...ui.document.querySelectorAll("[data-pad-field]")]
    .map((node) => String(node.getAttribute("data-pad-field")));
  const bankFields = [...ui.document.querySelectorAll("[data-bank-field]")]
    .map((node) => String(node.getAttribute("data-bank-field")));
  assert.equal(fields.includes("keep_pitch"), false, "no control writes keep_pitch");
  assert.equal(bankFields.includes("keep_pitch"), false, "and no bank button sends it");
  assert.equal(/keep pitch/i.test(String(ui.view().textContent)), false,
    "the panel does not offer it either");
});

test("an ordinary snapshot never releases the live state; another song releases it once", async () => {
  const doc = await samplerDoc({ scenes: [SCENE], pattern: true });
  const bankId = await firstBankId(doc);
  const ui = await bootSong({ doc, engine: true });
  await ui.openSampler();

  // Play builds the engine and hands it this song.
  ui.click("[data-act=play]");
  await ui.settle();
  assert.equal(ui.engine.calls.songs, 1, "the engine was handed the song it was built for");
  assert.equal(ui.engine.calls.reset, 0, "a new engine has nothing live to release");

  // An ordinary edit — the snapshot every change sends — releases nothing.
  await ui.apply("pad.set", { track_id: TRACK, bank_id: bankId, index: 0, fields: { gain_db: -3 } });
  assert.equal(ui.engine.calls.songs, 2, "the edit handed the song over");
  assert.equal(ui.engine.calls.reset, 0, "and released nothing");
  await ui.apply("pad.set", { track_id: TRACK, bank_id: bankId, index: 0, fields: { gain_db: -6 } });
  assert.equal(ui.engine.calls.reset, 0, "nor did the one after it");

  // Another song opens under the same page element: the live state belongs to
  // the song that went away, so it is released, once.
  const other = await samplerDoc({ scenes: [SCENE], pattern: true });
  await ui.openSong("song-2", other);
  ui.click("[data-act=play]");
  await ui.settle();
  assert.equal(ui.engine.calls.reset, 0, "nothing has been released yet");

  const songs = ui.engine.calls.songs;
  ui.frame(ui.stateFrame(other));
  await ui.settle();
  assert.equal(ui.engine.calls.reset, 1, "opening a different song released the live state once");
  assert.ok(ui.engine.calls.songs > songs, "and the new song was handed over");

  // The next snapshot is an ordinary one again.
  ui.frame(ui.stateFrame(other));
  await ui.settle();
  assert.equal(ui.engine.calls.reset, 1, "an ordinary snapshot after it releases nothing");
});

// --- HOLD and Pause-all (C5a) -----------------------------------------------

/** Press a pad with a finger: the pointerdown its own button hears. */
function pressPad(ui, index) {
  const node = padAt(ui, index);
  assert.ok(node, `pad ${index + 1} is drawn`);
  node.dispatchEvent(ui.event("pointerdown", { button: 0 }));
  return node;
}

/** The live bar's two controls. */
function holdButton(ui) {
  const node = ui.document.querySelector("[data-role=sampler-pads] [data-act=pad-hold]");
  assert.ok(node, "the pads carry a HOLD button");
  return node;
}

function pauseButton(ui) {
  const node = ui.document.querySelector("[data-role=sampler-pads] [data-act=pad-pause]");
  assert.ok(node, "the pads carry a Pause button");
  return node;
}

/** What the page's toast says right now. */
function toastText(ui) {
  const node = ui.document.querySelector("[data-role=toast]");
  assert.ok(node, "the page carries a toast");
  return String(node.textContent || "");
}

/** @returns {string} the class list of a pad button, as one string */
function padClasses(ui, index) {
  return String(padAt(ui, index).className || "");
}

test("press a pad then tap HOLD: holdPad is sent once for that pad", async () => {
  const doc = await samplerDoc({ scenes: [SCENE], pattern: true });
  const bankId = await firstBankId(doc);
  const ui = await bootSong({ doc, engine: true });
  await ui.openSampler();
  ui.engine.engine.gate(TRACK, bankId, 0);

  pressPad(ui, 0);
  await ui.settle();
  assert.deepEqual(ui.engine.engine.live,
    [{ track_id: TRACK, bank_id: bankId, index: 0, v: 100 }], "the press plays the pad");
  assert.deepEqual(ui.engine.engine.holds, [], "with HOLD unarmed nothing is latched");

  // The finger is still on the pad, and HOLD is tapped: that very pad latches.
  ui.click("[data-role=sampler-pads] [data-act=pad-hold]");
  await ui.settle();
  assert.deepEqual(ui.engine.engine.holds,
    [{ track_id: TRACK, bank_id: bankId, index: 0 }], "HOLD latched the pad under the finger, once");
  assert.equal(holdButton(ui).getAttribute("aria-pressed"), "false",
    "the key itself is not left armed: the pad is what was latched");

  // The latch, not the finger, holds the voice: the lift ends nothing.
  ui.release();
  await ui.settle();
  assert.deepEqual(ui.engine.engine.releases, [], "letting go of a latched pad releases nothing");
});

test("arm HOLD then tap two pads: two holds, and a lift releases nothing", async () => {
  const doc = await samplerDoc({ scenes: [SCENE], pattern: true });
  const bankId = await firstBankId(doc);
  const ui = await bootSong({ doc, engine: true });
  await ui.openSampler();
  ui.engine.engine.gate(TRACK, bankId, 0);
  ui.engine.engine.gate(TRACK, bankId, 1);

  ui.click("[data-role=sampler-pads] [data-act=pad-hold]");
  await ui.settle();
  assert.equal(holdButton(ui).getAttribute("aria-pressed"), "true", "a tap on HOLD arms it");
  assert.deepEqual(ui.engine.engine.holds, [], "and latches nothing by itself");

  for (const index of [0, 1]) {
    pressPad(ui, index);
    await ui.settle();
    ui.release();
    await ui.settle();
  }

  assert.deepEqual(ui.engine.engine.holds, [
    { track_id: TRACK, bank_id: bankId, index: 0 },
    { track_id: TRACK, bank_id: bankId, index: 1 },
  ], "each press played its pad and latched it");
  assert.deepEqual(ui.engine.engine.live.map((one) => one.index), [0, 1],
    "and the pads were played, not only latched");
  assert.deepEqual(ui.engine.engine.releases, [], "no lift released a latched pad");
});

test("tapping a held pad lets it go and plays nothing", async () => {
  const doc = await samplerDoc({ scenes: [SCENE], pattern: true });
  const bankId = await firstBankId(doc);
  const ui = await bootSong({ doc, engine: true });
  await ui.openSampler();
  ui.engine.engine.gate(TRACK, bankId, 0);

  ui.click("[data-role=sampler-pads] [data-act=pad-hold]");
  await ui.settle();
  pressPad(ui, 0);
  await ui.settle();
  ui.release();
  await ui.settle();
  assert.equal(ui.engine.engine.holds.length, 1, "the pad is latched");
  const played = ui.engine.engine.live.length;

  // The same pad again: HOLD's own second tap, which lets it go.
  pressPad(ui, 0);
  await ui.settle();
  assert.equal(ui.engine.engine.live.length, played, "a latched pad's tap plays nothing");
  assert.deepEqual(ui.engine.engine.heldReleases, [[TRACK, bankId, 0]], "and it lets that pad go");

  // And the arm is still on: the NEXT press plays the pad as usual.
  pressPad(ui, 0);
  await ui.settle();
  assert.equal(ui.engine.engine.live.length, played + 1, "a pad that is no longer held plays again");
});

test("600 ms on HOLD releases every held pad with no arguments; a 200 ms tap does not", async () => {
  const doc = await samplerDoc({ scenes: [SCENE], pattern: true });
  const bankId = await firstBankId(doc);
  const ui = await bootSong({ doc, engine: true });
  await ui.openSampler();
  ui.engine.engine.gate(TRACK, bankId, 0);

  // One latched pad to let go of.
  ui.click("[data-role=sampler-pads] [data-act=pad-hold]");
  await ui.settle();
  pressPad(ui, 0);
  await ui.settle();
  ui.release();
  await ui.settle();
  assert.equal(ui.engine.engine.holds.length, 1, "the pad is latched");

  // A press that is still down after 600 ms lets every held pad go.
  holdButton(ui).dispatchEvent(ui.event("pointerdown", { button: 0 }));
  ui.runTimers();
  await ui.settle();
  assert.deepEqual(ui.engine.engine.heldReleases, [[]],
    "the long press released every held pad, with no pad named");

  // The lift is what draws the page again (a render waits while a pointer is
  // down), and it takes the arm off.
  ui.release();
  await ui.settle();
  assert.equal(holdButton(ui).getAttribute("aria-pressed"), "false", "and it took the arm off");

  // The click its release makes is not also a tap.
  ui.click("[data-role=sampler-pads] [data-act=pad-hold]");
  await ui.settle();
  assert.equal(holdButton(ui).getAttribute("aria-pressed"), "false",
    "the click after a long press is swallowed");

  // The page forgot the latch too: the pad plays again.
  const played = ui.engine.engine.live.length;
  pressPad(ui, 0);
  await ui.settle();
  assert.equal(ui.engine.engine.live.length, played + 1, "a pad let go of plays again");
  ui.release();
  await ui.settle();

  // A short press IS a tap: it arms HOLD and releases nothing.
  holdButton(ui).dispatchEvent(ui.event("pointerdown", { button: 0 }));
  ui.release();
  await ui.settle();
  ui.click("[data-role=sampler-pads] [data-act=pad-hold]");
  await ui.settle();
  assert.equal(holdButton(ui).getAttribute("aria-pressed"), "true", "a 200 ms press and lift arms it");
  assert.deepEqual(ui.engine.engine.heldReleases, [[]], "and released nothing");
});

test("Pause toggles pauseVoices and its pressed state", async () => {
  const doc = await samplerDoc({ scenes: [SCENE], pattern: true });
  const ui = await bootSong({ doc, engine: true });
  await ui.openSampler();

  assert.equal(pauseButton(ui).getAttribute("aria-pressed"), "false", "Pause starts off");
  assert.deepEqual(ui.engine.engine.pauses, [], "and has told the engine nothing");

  ui.click("[data-role=sampler-pads] [data-act=pad-pause]");
  await ui.settle();
  assert.deepEqual(ui.engine.engine.pauses, [true], "the press pauses every pad voice");
  assert.equal(pauseButton(ui).getAttribute("aria-pressed"), "true", "and the button says so");
  assert.equal(String(pauseButton(ui).className).includes("st-on"), true, "in its pressed look");

  ui.click("[data-role=sampler-pads] [data-act=pad-pause]");
  await ui.settle();
  assert.deepEqual(ui.engine.engine.pauses, [true, false], "the next press lets it all go");
  assert.equal(pauseButton(ui).getAttribute("aria-pressed"), "false");
  assert.equal(String(pauseButton(ui).className).includes("st-on"), false);

  // Stop ends it too — the engine's own Stop lets every pad voice go — so the
  // button follows the stop rather than claiming something is still frozen.
  ui.click("[data-role=sampler-pads] [data-act=pad-pause]");
  await ui.settle();
  assert.equal(pauseButton(ui).getAttribute("aria-pressed"), "true", "paused again");
  ui.click("[data-act=stop]");
  await ui.settle();
  assert.equal(pauseButton(ui).getAttribute("aria-pressed"), "false", "Stop leaves nothing paused");
  assert.deepEqual(ui.engine.engine.pauses, [true, false, true], "and the engine is not told twice");
});

test("HOLD on a pad that is not a Gate pad shows the note and latches nothing", async () => {
  const doc = await samplerDoc({ scenes: [SCENE], pattern: true });
  const bankId = await firstBankId(doc);
  const ui = await bootSong({ doc, engine: true });
  await ui.openSampler();

  ui.click("[data-role=sampler-pads] [data-act=pad-hold]");
  await ui.settle();
  pressPad(ui, 2);
  await ui.settle();

  assert.equal(ui.engine.engine.holds.length, 0, "the engine refused the latch and was asked nothing more");
  assert.equal(toastText(ui), "HOLD works on Gate pads", "and the page says why, in those words");
  assert.deepEqual(ui.engine.engine.live.map((one) => one.index), [2],
    "the press still played the pad");

  // Its lift is an ordinary one: the pad is not held, so nothing keeps it.
  ui.release();
  await ui.settle();
  assert.deepEqual(ui.engine.engine.releases, [{ track_id: TRACK, bank_id: bankId, index: 2 }],
    "and letting go ended the voice");
});

test("a held pad shows st-pad-held and the lock mark, a looping pad st-pad-loop", async () => {
  const doc = await samplerDoc({ scenes: [SCENE], pattern: true });
  const bankId = await firstBankId(doc);
  const ui = await bootSong({ doc, engine: true });
  await ui.openSampler();
  // Play builds the engine, which is what the lights are reported by.
  ui.click("[data-act=play]");
  await ui.settle();

  const state = (index, code) => ui.padEvent({
    frame: 0, track_id: TRACK, bank_id: bankId, index, kind: "state", state: code,
  });

  state(0, 3);
  assert.equal(padClasses(ui, 0).includes("st-pad-held"), true, "state 3 is a held pad");
  assert.ok(padAt(ui, 0).querySelector(".st-pad-lock"), "with the lock mark beside its name");

  state(1, 2);
  assert.equal(padClasses(ui, 1).includes("st-pad-loop"), true, "state 2 is a looping pad");
  assert.equal(padAt(ui, 1).querySelector(".st-pad-lock"), null, "and a loop wears no lock mark");

  state(0, 0);
  state(1, 0);
  assert.equal(padClasses(ui, 0).includes("st-pad-held"), false, "state 0 clears the held light");
  assert.equal(padAt(ui, 0).querySelector(".st-pad-lock"), null, "and the mark goes with it");
  assert.equal(padClasses(ui, 1).includes("st-pad-loop"), false, "state 0 clears the loop light");

  // The engine's own report is what the page's map follows: a pad it says is
  // held is one the next tap lets go, whichever path latched it.
  state(2, 3);
  const played = ui.engine.engine.live.length;
  pressPad(ui, 2);
  await ui.settle();
  assert.equal(ui.engine.engine.live.length, played, "a pad reported as held plays nothing");
  assert.deepEqual(ui.engine.engine.heldReleases, [[TRACK, bankId, 2]], "and its tap lets it go");
  state(2, 0);
});

test("an agent-edit re-render keeps the arm, the held classes and the finger on HOLD", async () => {
  const doc = await samplerDoc({ scenes: [SCENE], pattern: true });
  const bankId = await firstBankId(doc);
  const ui = await bootSong({ doc, engine: true });
  await ui.openSampler();
  ui.click("[data-act=play]");
  await ui.settle();

  ui.click("[data-role=sampler-pads] [data-act=pad-hold]");
  await ui.settle();
  ui.padEvent({ frame: 0, track_id: TRACK, bank_id: bankId, index: 0, kind: "state", state: 3 });
  assert.equal(holdButton(ui).getAttribute("aria-pressed"), "true", "HOLD is armed");

  // This document keeps only the focus the page ASKS for, so every focus() is
  // caught here (as the effect-focus test does).
  const node = holdButton(ui);
  const focused = [];
  const prototype = Object.getPrototypeOf(node);
  const original = prototype.focus;
  prototype.focus = function () {
    focused.push(this.getAttribute ? this.getAttribute("data-act") : null);
    return original.call(this);
  };
  try {
    ui.document.activeElement = node;
    // The song as it is again: every host is drawn from the snapshot once more.
    ui.frame(ui.stateFrame());
    await ui.settle();

    assert.equal(holdButton(ui).getAttribute("aria-pressed"), "true", "the arm survives the redraw");
    assert.equal(padClasses(ui, 0).includes("st-pad-held"), true, "the held class is put back on its pad");
    assert.ok(padAt(ui, 0).querySelector(".st-pad-lock"), "with the lock mark");
    assert.deepEqual(focused, ["pad-hold"], "and the keyboard went back to HOLD and nowhere else");
  } finally {
    prototype.focus = original;
    ui.document.activeElement = null;
  }
});

test("another song's snapshot clears the arm and the pause; an ordinary one keeps them", async () => {
  const doc = await samplerDoc({ scenes: [SCENE], pattern: true });
  const ui = await bootSong({ doc, engine: true });
  await ui.openSampler();

  ui.click("[data-role=sampler-pads] [data-act=pad-hold]");
  await ui.settle();
  ui.click("[data-role=sampler-pads] [data-act=pad-pause]");
  await ui.settle();
  assert.equal(holdButton(ui).getAttribute("aria-pressed"), "true", "HOLD is armed");
  assert.equal(pauseButton(ui).getAttribute("aria-pressed"), "true", "and everything is paused");

  // The snapshot every edit sends is this page's own song: nothing is cleared.
  ui.frame(ui.stateFrame());
  await ui.settle();
  assert.equal(holdButton(ui).getAttribute("aria-pressed"), "true", "an ordinary snapshot keeps the arm");
  assert.equal(pauseButton(ui).getAttribute("aria-pressed"), "true", "and the pause");
  assert.equal(ui.engine.calls.reset, 0, "and released no live state");

  // The page element now says the engine's live state belongs to another song:
  // the arm and the pause go with the song that left.
  ui.document.querySelector(".studio").__studioLiveSong = "song-9";
  ui.frame(ui.stateFrame());
  await ui.settle();
  assert.equal(ui.engine.calls.reset, 1, "the live state was released once");
  assert.equal(holdButton(ui).getAttribute("aria-pressed"), "false", "the arm went with it");
  assert.equal(pauseButton(ui).getAttribute("aria-pressed"), "false", "and so did the pause");
});

test("the live bar's controls are 44 px targets that never select their label", async () => {
  const html = await render({ song: "song-1" });

  const at = html.indexOf(".studio .st-pad-bar .st-toggle");
  assert.ok(at >= 0, "the page carries a rule for the live bar's controls");
  const rule = html.slice(at, at + 300);
  assert.match(rule, /min-width: 44px/, "each is at least 44 px wide");
  assert.match(rule, /min-height: 44px/, "and at least 44 px tall");
  assert.match(rule, /-webkit-user-select: none/, "and never selects its own label");
  assert.match(rule, /-webkit-touch-callout: none/, "nor calls out a menu on a long press");

  // The ROLL key's interval sits on the same bar and is a target of its own.
  const interval = html.indexOf(".studio .st-pad-bar .st-roll-interval");
  assert.ok(interval >= 0, "the page carries a rule for the ROLL interval");
  const picker = html.slice(interval, interval + 300);
  assert.match(picker, /min-width: 44px/, "the picker is at least 44 px wide");
  assert.match(picker, /min-height: 44px/, "and at least 44 px tall");
  assert.match(picker, /-webkit-user-select: none/, "and never selects its own label");
  assert.match(picker, /-webkit-touch-callout: none/, "nor calls out a menu on a long press");

  // A held pad is drawn from the stylesheet alone: a steady glow and the lock
  // mark, with no animation (the mark is the lock's body and shackle).
  const held = html.indexOf(".studio .st-pad.st-pad-held { box-shadow");
  assert.ok(held >= 0, "a held pad wears a steady glow");
  assert.ok(html.includes(".studio .st-pad-lock {"), "the lock mark has a rule of its own");
  assert.ok(html.includes(".studio .st-pad-lock::before"), "drawn as a body and a shackle");
});

// --- ROLL (C5b) ------------------------------------------------------------

/** The live bar's ROLL key, asserted to be drawn. */
function rollButton(ui) {
  const node = ui.document.querySelector("[data-role=sampler-pads] [data-act=pad-roll]");
  assert.ok(node, "the pads carry a ROLL button");
  return node;
}

/** The interval picker beside it. */
function rollInterval(ui) {
  const node = ui.document.querySelector("[data-role=sampler-pads] [data-act=roll-interval]");
  assert.ok(node, "the ROLL interval picker is drawn");
  return node;
}

/** Put a finger on ROLL and leave it there: the key is held, not clicked. */
function holdRoll(ui) {
  const node = rollButton(ui);
  node.dispatchEvent(ui.event("pointerdown", { button: 0 }));
  return node;
}

/** Pick one value of the interval picker the way a person does. */
async function pickInterval(ui, value) {
  const select = rollInterval(ui);
  for (const option of [...select.querySelectorAll("option")]) {
    if (String(option.value) === String(value)) option.selected = true;
  }
  select.dispatchEvent(ui.event("change", { target: select }));
  await ui.settle();
}

/** The window losing the focus, the way a browser sends it. */
function blurWindow(ui) {
  for (const handler of [...(ui.windowListeners.blur || [])]) handler(ui.event("blur", {}));
}

test("holding ROLL and pressing a pad calls rollStart with the chosen interval; lifting calls rollStop", async () => {
  const doc = await samplerDoc({ scenes: [SCENE], pattern: true });
  const bankId = await firstBankId(doc);
  const ui = await bootSong({ doc, engine: true });
  await ui.openSampler();

  assert.deepEqual(
    [...rollInterval(ui).querySelectorAll("option")].map((one) => String(one.value)),
    ["1/4", "1/8", "1/16", "1/32", "1/64"],
    "the five straight intervals, a quarter to a sixty-fourth",
  );
  assert.equal(rollInterval(ui).value, "1/16", "and a sixteenth is the one it starts on");

  // The choice is this page's own live state: nothing is sent for it.
  await pickInterval(ui, "1/8");
  assert.equal(ui.commands("pad.set").length, 0, "choosing an interval sends no command");

  const button = holdRoll(ui);
  await ui.settle();
  assert.equal(button.getAttribute("aria-pressed"), "true", "the key says it is held");

  pressPad(ui, 0);
  await ui.settle();
  assert.deepEqual(ui.engine.engine.rolls,
    [{ track_id: TRACK, bank_id: bankId, index: 0, interval: "1/8", v: 100 }],
    "the press started a roll at the chosen interval and the press's velocity");
  assert.deepEqual(ui.engine.engine.live, [], "a roll is the engine's own clock, not one voice a press");

  ui.release();
  await ui.settle();
  assert.deepEqual(ui.engine.engine.rollStops,
    [{ track_id: TRACK, bank_id: bankId, index: 0 }], "the lift stopped that pad's roll, once");
  assert.deepEqual(ui.engine.engine.releases, [], "and released no voice of its own");
  assert.equal(rollButton(ui).getAttribute("aria-pressed"), "false", "the key came up with the pad");
});

test("a fifth pad shows the toast and starts nothing", async () => {
  const doc = await samplerDoc({ scenes: [SCENE], pattern: true });
  const ui = await bootSong({ doc, engine: true });
  await ui.openSampler();

  holdRoll(ui);
  await ui.settle();
  for (const index of [0, 1, 2, 3]) {
    pressPad(ui, index);
    await ui.settle();
  }
  assert.equal(ui.engine.engine.rolls.length, 4, "four pads roll: the engine's own limit");

  pressPad(ui, 4);
  await ui.settle();
  assert.equal(ui.engine.engine.rolls.length, 4, "the fifth pad starts nothing");
  assert.equal(toastText(ui), "Four pads can roll at once", "and the page says why, in those words");
  assert.deepEqual(ui.engine.engine.live, [], "nothing was played in its place either");
});

test("a looping pad shows the loop toast and starts nothing", async () => {
  const doc = await samplerDoc({ scenes: [SCENE], pattern: true });
  const bankId = await firstBankId(doc);
  const ui = await bootSong({ doc, engine: true });
  await ui.openSampler();

  // The pad's Loop setting is song data: the engine refuses the roll, and the
  // page reads that same pad to say which refusal it was (M19).
  await ui.apply("pad.set", {
    track_id: TRACK, bank_id: bankId, index: 1, fields: { loop: "loop" },
  });

  holdRoll(ui);
  await ui.settle();
  pressPad(ui, 1);
  await ui.settle();

  assert.equal(ui.engine.engine.rolls.length, 0, "a looping pad rolls nothing");
  assert.equal(toastText(ui), "Roll does not work on looping pads", "and the page says which refusal it was");
  assert.deepEqual(ui.engine.engine.live, [], "nothing was played in its place either");

  // Every other pad still rolls: the refusal is that pad's alone.
  pressPad(ui, 2);
  await ui.settle();
  assert.deepEqual(ui.engine.engine.rolls.map((one) => one.index), [2], "a pad that does not loop still rolls");
});

test("leaving the ROLL key and a window blur stop every roll", async () => {
  const doc = await samplerDoc({ scenes: [SCENE], pattern: true });
  const bankId = await firstBankId(doc);
  const ui = await bootSong({ doc, engine: true });
  await ui.openSampler();

  holdRoll(ui);
  await ui.settle();
  for (const index of [0, 1]) {
    pressPad(ui, index);
    await ui.settle();
  }
  assert.equal(ui.engine.engine.rolls.length, 2, "two pads roll");

  // A pointer that leaves the key lets it go, and every roll with it.
  rollButton(ui).dispatchEvent(ui.event("pointerleave", {}));
  await ui.settle();
  assert.deepEqual(ui.engine.engine.rollStops.map((one) => one.index).sort(), [0, 1],
    "leaving the key stopped both rolls");
  ui.release();
  await ui.settle();
  assert.equal(rollButton(ui).getAttribute("aria-pressed"), "false", "and the key is up");

  // The window losing the focus hears no lift at all: the roll that is still
  // running ends with it.
  holdRoll(ui);
  await ui.settle();
  pressPad(ui, 2);
  await ui.settle();
  assert.deepEqual(ui.engine.engine.rolls.map((one) => one.index), [0, 1, 2], "pad 3 rolls");

  blurWindow(ui);
  await ui.settle();
  assert.deepEqual(ui.engine.engine.rollStops.map((one) => one.index), [0, 1, 2],
    "the blur stopped the roll the key was still holding");
  assert.equal(rollButton(ui).getAttribute("aria-pressed"), "false", "and the key went up with it");
  assert.deepEqual(ui.engine.engine.holds, [], "the blur latched nothing");
  assert.equal(ui.engine.engine.rollStops[2].bank_id, bankId, "the stop names that pad's own bank");
});

test("the ROLL key is not a command: the song is never written by it", async () => {
  const doc = await samplerDoc({ scenes: [SCENE], pattern: true });
  const ui = await bootSong({ doc, engine: true });
  await ui.openSampler();
  const before = ui.sent.filter((message) => message.type === "command").length;

  holdRoll(ui);
  await ui.settle();
  pressPad(ui, 0);
  await ui.settle();
  ui.release();
  await ui.settle();

  assert.equal(ui.sent.filter((message) => message.type === "command").length, before,
    "arming, rolling and lifting wrote nothing");
  assert.equal(ui.commands("pad.set").length, 0, "and no pad setting was touched");
});