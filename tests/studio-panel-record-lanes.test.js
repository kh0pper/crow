/**
 * Studio panel — the recording lanes widget (A4a) and the record target's meter
 * (A4b).
 *
 * The emitted client script runs against a linkedom document built from the page
 * the handler renders — with the shell's own two scripts evaluated first, so the
 * page has modes and a layout — with a real Yjs song and a fake engine: what
 * these cases check is the picture the widget draws — one lane per track on the
 * arrangement's own bar axis, each lane's arm, mute and solo (the grid's and the
 * mixer strip's own controls), the clips the ARRANGEMENT places on it, a ruler
 * with the section bands and the transport's playhead, and the two sentences a
 * song with nothing to draw gets. The record target (the first armed audio
 * track, as `startRecording` reads it) is drawn tall and red and named Armed,
 * and every other armed lane only says Armed.
 *
 * The meter is the DRY input's own reading: one node on the record target, moved
 * when the target changes, off while the lanes widget is not on the page, and
 * disposed with the stream. Its readout is the page's own view state, drawn by
 * `paintArmedMeter` from what the meter posted.
 *
 * The widget is view state from end to end: no case sends a command except the
 * mute, solo and arm buttons, which are the existing ones.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { SHELL_SCRIPT } from "../bundles/studio/panel/shell.js";
import { SHELL_LAYOUT_SCRIPT } from "../bundles/studio/panel/shell-layout.js";

/** The note track, whose lane shows a placement and cannot be armed. */
const NOTE_TRACK = "bass";

/** The audio track a take lands on. */
const AUDIO_TRACK = "gtr";

/** A second audio track, so two lanes can be armed at once. */
const SECOND_AUDIO_TRACK = "vox";

/** The song's one scene. */
const SCENE = "verse";

/** The clips the two lanes place. */
const NOTE_CLIP = "c-bass";
const AUDIO_CLIP = "c-gtr";

/** The placements, and the sections the ruler draws. */
const NOTE_PLACEMENT = "p-notes";
const AUDIO_PLACEMENT = "p-audio";

/** The project the page's own song list names (nothing here lists a project). */
const PROJECT = 61;

/** The sentence a song with tracks but nothing on the timeline gets. */
const EMPTY_PLAN_TEXT =
  "Lanes show the arrangement. Place clips on the timeline to see them here; your scenes still play.";

/** The sentence a song with no audio track gets. */
const ADD_TRACK_TEXT = "Add an audio track and arm it to record.";

// ---- the fixture songs -----------------------------------------------------

/** The document editor's own way in: runCommand throws when a command is refused. */
async function commands() {
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  await import("../bundles/studio/server/commands/core.js");
  await import("../bundles/studio/server/commands/takes.js");
  await import("../bundles/studio/server/commands/arrangement.js");
  await import("../bundles/studio/server/commands/mixer.js");
  await import("../bundles/studio/server/commands/library.js");
  return runCommand;
}

/**
 * The song the widget draws: a note track and two audio tracks, one scene, a
 * clip on two of the lanes, two sections and a placement on each of those two.
 * @param {{placements?: boolean, audio?: boolean}} [options] `placements: false`
 *   leaves the arrangement empty; `audio: false` leaves the song with one note
 *   track and no audio track at all
 * @returns {Promise<object>}
 */
async function lanesDoc(options = {}) {
  const { newSongDoc } = await import("../bundles/studio/server/doc.js");
  const runCommand = await commands();
  const doc = newSongDoc({ title: "Record lanes song", bpm: 120 });
  runCommand(doc, "track.add", { id: NOTE_TRACK, name: "Bass" });
  if (options.audio !== false) {
    runCommand(doc, "track.add", { id: AUDIO_TRACK, name: "Guitar", kind: "audio" });
    runCommand(doc, "track.add", { id: SECOND_AUDIO_TRACK, name: "Vocal", kind: "audio" });
  }
  runCommand(doc, "scene.add", { id: SCENE, name: "Verse" });
  runCommand(doc, "clip.write", {
    clip_id: NOTE_CLIP,
    track_id: NOTE_TRACK,
    scene_id: SCENE,
    name: "Bass line",
    length_bars: 2,
    notes: [{ t: 0, d: 1, p: 60, v: 100 }],
  });
  if (options.audio !== false) {
    runCommand(doc, "clip.add_audio", {
      clip_id: AUDIO_CLIP,
      track_id: AUDIO_TRACK,
      scene_id: SCENE,
      length_bars: 2,
      name: "Guitar take",
    });
  }
  if (options.placements === false) return doc;
  runCommand(doc, "section.add", { id: "sec-verse", start_bar: 0, end_bar: 4, name: "Verse" });
  runCommand(doc, "section.add", { id: "sec-chorus", start_bar: 4, end_bar: 8, name: "Chorus" });
  runCommand(doc, "arrangement.place", {
    id: NOTE_PLACEMENT,
    track_id: NOTE_TRACK,
    clip_id: NOTE_CLIP,
    start_bar: 4,
    bars: 4,
  });
  if (options.audio !== false) {
    runCommand(doc, "arrangement.place", {
      id: AUDIO_PLACEMENT,
      track_id: AUDIO_TRACK,
      clip_id: AUDIO_CLIP,
      start_bar: 4,
      bars: 2,
    });
  }
  return doc;
}

// ---- the fake browser ------------------------------------------------------

/** An in-memory localStorage, so the shell's own layout store has somewhere to read. */
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

/** The width media queries the shell watches, answered from one page width. */
function matchesFor(width, media) {
  const min = /min-width:\s*(\d+)px/.exec(String(media));
  if (min) return width >= Number(min[1]);
  const max = /max-width:\s*(\d+)px/.exec(String(media));
  if (max) return width <= Number(max[1]);
  return false;
}

/**
 * The same song, with an amp on the recording track's chain: what the lane names
 * while the operator hears the chain the take stays dry of.
 * @returns {Promise<object>}
 */
async function lanesDocWithAmp() {
  const doc = await lanesDoc();
  const runCommand = await commands();
  // An amp plays a library file, and an insert is issued behind one.
  runCommand(doc, "library.add", {
    entry: {
      id: "lib-capture",
      kind: "nam",
      name: "My capture",
      source: "upload",
      upload_id: "cap-upload",
      storage_key: "projects/61/studio/song-1/library/lib-capture-upload.nam",
      sha256: "a".repeat(64),
      bytes: 1024,
      licence: "",
      credit: "My capture by me",
      author_label: "You",
    },
  });
  runCommand(doc, "insert.add", {
    id: "ins-amp",
    owner: "track:" + AUDIO_TRACK,
    kind: "amp",
    params: { model_id: "lib-capture" },
  });
  return doc;
}

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

/** The panel's take store, in memory: every call answers, nothing is kept. */
function fakeTakeStore() {
  const chunks = new Map();
  const pendings = new Map();
  return {
    chunks,
    pendings,
    async putChunk(takeId, index, bytes) {
      chunks.set(takeId + ":" + index, bytes);
      return true;
    },
    async getChunk(takeId, index) {
      return chunks.get(takeId + ":" + index) || null;
    },
    async countChunks() {
      return { count: 0, bytes: 0 };
    },
    async getPending(takeId) {
      return pendings.get(takeId) || null;
    },
    async listPending() {
      return [];
    },
    async putPending(row) {
      pendings.set(row.take_id, row);
      return true;
    },
    async deletePending(takeId) {
      pendings.delete(takeId);
      return true;
    },
    async getLatency() {
      return null;
    },
    async putLatency() {
      return true;
    },
    async getAudio() {
      return null;
    },
    async putAudio() {
      return true;
    },
    async clearAudio() {
      return true;
    },
  };
}

/** A context stand-in: the two nodes the page builds for an arm, and its clock. */
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

/**
 * A meter stand-in: it keeps what the page did to it, and lets a case post the
 * level messages the worklet posts.
 */
function fakeMeter() {
  const meter = {
    input: null,
    levels: [],
    active: [],
    cleared: 0,
    disposed: false,
    listeners: [],
    onLevel(listener) {
      meter.listeners.push(listener);
      return () => {};
    },
    setActive(on) {
      meter.active.push(on === true);
    },
    clearClip() {
      meter.cleared += 1;
    },
    dispose() {
      meter.disposed = true;
    },
    /** One level message, shaped the way the worklet posts it. */
    post(level) {
      const full = {
        frame: 0,
        peak: 0,
        rms: 0,
        clipped: false,
        cols: new Float32Array(0),
        ...level,
      };
      meter.levels.push(full);
      for (const listener of meter.listeners) listener(full);
    },
  };
  return meter;
}

/**
 * The engine stand-in: it keeps the listeners the page registered, so a case can
 * report a position or end a take from the engine's side, it builds one recorder
 * per take and one meter per build.
 */
function fakeEngine() {
  const engine = {
    songs: [],
    positions: [],
    launches: [],
    errors: [],
    recorders: [],
    meters: [],
    node: { connect() {} },
    setSong(song) {
      engine.songs.push(song);
    },
    setMode() {},
    seek() {},
    play() {},
    pause() {},
    stop() {},
    stopAll() {},
    launchScene() {},
    monitor() {},
    onPosition(listener) {
      engine.positions.push(listener);
      return () => {};
    },
    onLaunch(listener) {
      engine.launches.push(listener);
      return () => {};
    },
    onError(listener) {
      engine.errors.push(listener);
      return () => {};
    },
    async nextBarFrame() {
      return { frame: 48000, bar: 1 };
    },
    now() {
      return 48000;
    },
    async loadAudio() {},
    unloadAudio() {},
    createInputMeter(options) {
      const meter = fakeMeter();
      meter.input = options ? options.input : null;
      engine.meters.push(meter);
      return Promise.resolve(meter);
    },
    createRecorder() {
      const recorder = {
        armed: null,
        stopped_at: null,
        splits: [],
        onChunk(listener) {
          recorder.chunk = listener;
        },
        onDone(listener) {
          recorder.done = listener;
        },
        armAt(frame) {
          recorder.armed = frame;
        },
        stopAt(frame) {
          recorder.stopped_at = frame;
        },
        splitAt(list) {
          recorder.splits = list;
        },
        dispose() {},
      };
      engine.recorders.push(recorder);
      return Promise.resolve(recorder);
    },
  };
  return engine;
}

/** The navigator stand-in: one raw stereo input, and no Web Locks. */
function fakeNavigator() {
  const track = { label: "Test input", getSettings: () => ({ deviceId: "in-1" }), stop() {} };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  return {
    locks: null,
    mediaDevices: {
      async enumerateDevices() {
        return [{ kind: "audioinput", deviceId: "in-1", label: "Test input" }];
      },
      async getUserMedia() {
        return stream;
      },
    },
  };
}

/**
 * Boot the emitted client script against the page the handler renders, with a
 * fake browser around it, and hand back what it drew and what it sent.
 * @param {{doc?: object, page?: string}} [options] `page` is left for a
 *   library-page case; the lanes cases all use the song page
 * @returns {Promise<object>}
 */
async function bootLanes(options = {}) {
  const { parseHTML } = await import("linkedom");
  const { pathToFileURL } = await import("node:url");
  const { encodeDocState } = await import("../bundles/studio/server/doc.js");
  const { CLIENT_SCRIPT } = await import("../bundles/studio/panel/client.js");
  const { RECORD_VIEW_SCRIPT } = await import("../bundles/studio/panel/record-view.js");
  const { TAKE_STORE_SCRIPT } = await import("../bundles/studio/panel/take-store.js");

  const doc = options.doc || (await lanesDoc());
  const res = {
    html: "",
    send(body) {
      this.html = String(body);
    },
  };
  await (await import("../bundles/studio/panel/studio.js")).default.handler(
    { query: { song: "song-1" }, headers: {} },
    res,
    { db: panelDb(), layout: minimalLayout },
  );
  assert.ok(res.html.includes('data-studio-song="song-1"'), "the handler rendered the song page");
  assert.ok(
    res.html.includes("StudioRecordView"),
    "the page carries the record view's rules before the client",
  );
  const { document, window: domWindow } = parseHTML(res.html);

  // A phone's page reports its visibility, and a case drives it: a hidden page
  // queues what its meter posts.
  let visibility = "visible";
  const visibilityProperty = { configurable: true, get: () => visibility };
  try {
    Object.defineProperty(document, "visibilityState", visibilityProperty);
  } catch (err) {
    Object.defineProperty(Object.getPrototypeOf(document), "visibilityState", visibilityProperty);
  }

  const store = fakeTakeStore();
  const storage = memoryStorage();
  const sessionValues = new Map();
  const engine = fakeEngine();
  const sent = [];

  const response = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async arrayBuffer() {
      return new ArrayBuffer(0);
    },
  });

  const fetchStub = async (url) => {
    const target = String(url);
    if (target.includes("/module-types")) {
      return response(200, { generators: ["Analog generator"], modules: {} });
    }
    if (target.includes("/project-bot")) return response(404, { error: "not_found" });
    if (target.includes("/api/studio/songs")) {
      return response(200, [{ id: "song-1", project_id: PROJECT, title: "Record lanes song" }]);
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

  const windowStub = {
    crypto: globalThis.crypto,
    innerWidth: 1280,
    localStorage: storage,
    sessionStorage: {
      getItem: (key) => (sessionValues.has(String(key)) ? sessionValues.get(String(key)) : null),
      setItem: (key, value) => sessionValues.set(String(key), String(value)),
      removeItem: (key) => sessionValues.delete(String(key)),
    },
    matchMedia: (media) => ({
      media: String(media),
      matches: matchesFor(1280, media),
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    }),
    location: { protocol: "http:", host: "127.0.0.1:1", reload() {} },
    atob: globalThis.atob,
    confirm: () => true,
    prompt: () => null,
    AudioContext: function AudioContextStub() {
      return fakeContext();
    },
    StudioTakeStore: store,
    StudioEngine: { create: async () => engine },
    addEventListener() {},
    removeEventListener() {},
  };

  // The page's own two shell scripts, in the order it carries them: the layout
  // model, then the shell that mounts on it. The modes a case clicks live here.
  const shellScripts = new Function(
    "window",
    "document",
    `${SHELL_LAYOUT_SCRIPT}\n${SHELL_SCRIPT}`,
  );
  shellScripts(windowStub, document);
  assert.ok(windowStub.StudioShell, "the shell script is evaluated");
  assert.ok(windowStub.StudioShellLayout, "the layout model script is evaluated");

  // The record view's rules are emitted before the client in the page, and they
  // are run in that order here: the lanes ask them for the two labels.
  new Function("window", RECORD_VIEW_SCRIPT)(windowStub);
  new Function("window", "navigator", TAKE_STORE_SCRIPT)(windowStub, fakeNavigator());
  windowStub.StudioTakeStore = store;

  const yjsUrl = pathToFileURL(
    new URL("../bundles/studio/node_modules/yjs/dist/yjs.mjs", import.meta.url).pathname,
  ).href;
  const scriptText = CLIENT_SCRIPT.replace("'/dashboard/studio/assets/yjs.mjs'", JSON.stringify(yjsUrl));
  assert.notEqual(scriptText, CLIENT_SCRIPT, "the test replaces the Yjs asset URL with the file on disk");

  const timers = [];
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
    (fn) => {
      timers.push(fn);
      return timers.length;
    },
    () => {},
    () => 0,
    () => {},
  );

  const settle = async (rounds = 12) => {
    for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  };
  const frame = (message) => {
    for (const handler of socket.handlers.message || []) handler({ data: JSON.stringify(message) });
  };
  const pushState = async () => {
    frame({
      type: "state",
      update: Buffer.from(encodeDocState(doc)).toString("base64"),
      history: [],
      presence: [],
    });
    await settle();
  };

  await settle();
  await pushState();

  const page = document.querySelector(".studio");
  const host = () => document.querySelector("[data-role=rec-lanes]");
  const lane = (trackId) => document.querySelector(`[data-role=rec-lane][data-track-id=${trackId}]`);
  const click = (selector) => {
    const node = document.querySelector(selector);
    assert.ok(node, `nothing matches ${selector}`);
    node.dispatchEvent(new domWindow.Event("click", { bubbles: true }));
    return node;
  };
  const waitFor = async (predicate, what, ms = 4000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail("timed out waiting for " + what);
  };
  /** The page's own view state, as the page keeps it. */
  const view = () => page.__studioTest.view;
  /** One of the shell's three modes, the way the operator presses it. */
  const mode = async (which) => {
    const node = document.querySelector(`[data-role=mode-switch] [data-mode=${which}]`);
    assert.ok(node, `the shell offers ${which}`);
    node.dispatchEvent(new domWindow.Event("click", { bubbles: true }));
    await waitFor(
      () => document.querySelector(`[data-mode=${which}]`).getAttribute("aria-pressed") === "true",
      `${which} to be the pressed mode`,
    );
    await settle();
  };
  /** Arm one track from its lane, and wait for the input and its meter. */
  const arm = async (trackId) => {
    click(`[data-role=rec-lane][data-track-id=${trackId}] [data-act=arm-audio]`);
    await settle(24);
  };
  /** The one meter node the page built, or undefined. */
  const meterNode = () => document.querySelector("[data-role=rec-meter]");

  return {
    document,
    domWindow,
    doc,
    store,
    storage,
    engine,
    sent,
    page,
    host,
    lane,
    click,
    settle,
    waitFor,
    frame,
    pushState,
    view,
    mode,
    arm,
    meterNode,
    setVisibility(next) {
      visibility = String(next);
    },
  };
}

/** Hand the engine one position report, the way the processor does. */
async function reportPosition(ui, position) {
  for (const listener of ui.engine.positions) listener(position);
  await ui.settle();
}

/** @returns {string[]} the commands the page sent, in order. */
function commandsSent(ui, name) {
  return ui.sent
    .filter((message) => message.type === "command" && message.command === name)
    .map((message) => message.args);
}

// ---- the cases -------------------------------------------------------------

test("unarmed lanes show their placements, arm, mute and solo and no meter", async () => {
  const ui = await bootLanes();

  const lanes = [...ui.document.querySelectorAll("[data-role=rec-lane]")];
  assert.deepEqual(
    lanes.map((node) => node.getAttribute("data-track-id")),
    [NOTE_TRACK, AUDIO_TRACK, SECOND_AUDIO_TRACK],
    "one lane per track, in the song's own order",
  );

  for (const trackId of [NOTE_TRACK, AUDIO_TRACK, SECOND_AUDIO_TRACK]) {
    const node = ui.lane(trackId);
    assert.ok(node.querySelector("[data-act=arm-audio]"), `${trackId} offers Arm`);
    assert.ok(node.querySelector("[data-act=mute]"), `${trackId} offers Mute`);
    assert.ok(node.querySelector("[data-act=solo]"), `${trackId} offers Solo`);
  }
  assert.equal(
    ui.lane(NOTE_TRACK).querySelector("[data-act=arm-audio]").disabled,
    true,
    "a note track cannot be armed",
  );
  assert.equal(ui.lane(AUDIO_TRACK).querySelector("[data-act=arm-audio]").disabled, false, "an audio track can");

  const block = ui.lane(AUDIO_TRACK).querySelector(`[data-placement-id=${AUDIO_PLACEMENT}]`);
  assert.ok(block, "the audio lane shows the clip the arrangement places on it");
  assert.equal(block.textContent, "Guitar take", "named the way the clip is named");
  assert.ok(
    ui.lane(NOTE_TRACK).querySelector(`[data-placement-id=${NOTE_PLACEMENT}]`),
    "and the note lane shows its own placement",
  );
  assert.equal(
    ui.lane(SECOND_AUDIO_TRACK).querySelectorAll("[data-role=rec-block]").length,
    0,
    "a lane with nothing placed on it is an empty lane",
  );

  // Nothing is armed, so nothing is a target and nothing is metered.
  assert.equal(ui.document.querySelectorAll("[data-role=rec-armed]").length, 0);
  assert.equal(ui.document.querySelectorAll("[data-role=rec-meter]").length, 0, "one meter only, and not yet");
  assert.equal(ui.lane(AUDIO_TRACK).getAttribute("class").includes("st-rec-lane-target"), false);

  // Mute and solo are the mixer's own commands, sent from this lane.
  ui.click(`[data-role=rec-lane][data-track-id=${AUDIO_TRACK}] [data-act=mute]`);
  await ui.settle();
  assert.deepEqual(commandsSent(ui, "track.set_mix"), [{ track_id: AUDIO_TRACK, mute: true }], "M mutes the track");
  ui.click(`[data-role=rec-lane][data-track-id=${AUDIO_TRACK}] [data-act=solo]`);
  await ui.settle();
  assert.deepEqual(
    commandsSent(ui, "track.set_mix")[1],
    { track_id: AUDIO_TRACK, solo: true },
    "S solos it",
  );
});

test("the ruler shows section bands and the playhead", async () => {
  const ui = await bootLanes();

  const bands = [...ui.document.querySelectorAll("[data-role=rec-section]")];
  assert.equal(bands.length, 2, "one band per section of the arrangement");
  assert.deepEqual(bands.map((node) => node.textContent), ["Verse", "Chorus"]);
  assert.equal(bands[0].getAttribute("data-section-id"), "sec-verse");
  assert.equal(bands[0].style.left, "0%", "the first section starts on bar 1");
  assert.equal(bands[0].style.width, "12.5%", "and spans four of the ruler's thirty-two bars");
  assert.equal(bands[1].style.left, "12.5%", "the second starts where the first ends");

  const numbers = [...ui.document.querySelectorAll("[data-role=rec-bar-ruler] .st-rec-bar-n")];
  assert.equal(numbers.length, 32, "the ruler numbers every bar of the timeline's own count");
  assert.equal(numbers[0].textContent, "1");

  // A render draws the ruler again (Play is one), so the line is looked up
  // again after it: the widget keeps no node of its own.
  const head = () => ui.document.querySelector("[data-role=rec-playhead]");
  assert.ok(head(), "the ruler carries one playhead");
  assert.equal(head().style.left, "0%", "which starts at bar 1");

  // The playhead follows the TRANSPORT: Play brings the engine up, and its
  // position reports are what move the line.
  ui.click("[data-act=play]");
  await ui.settle(24);
  assert.equal(ui.engine.positions.length > 0, true, "the transport reports its position");

  await reportPosition(ui, { bar: 5, beat: 1, sixteenth: 1 });
  assert.equal(head().style.left, "12.5%", "the position report moves it to bar 5");

  await reportPosition(ui, { bar: 9, beat: 3, sixteenth: 1 });
  assert.equal(head().style.left, "26.563%", "and into a bar: bar 9 and a half of thirty-two");

  // A render draws the ruler again and the playhead is already where the
  // transport is, not back at the top.
  await ui.pushState();
  assert.equal(ui.document.querySelectorAll("[data-role=rec-playhead]").length, 1, "still exactly one playhead");
  assert.equal(
    ui.document.querySelector("[data-role=rec-playhead]").style.left,
    "26.563%",
    "a redrawn ruler keeps the playhead on the transport's bar",
  );
});

test("a session-only song (scenes, no placements) shows empty lanes and the arrangement note", async () => {
  const ui = await bootLanes({ doc: await lanesDoc({ placements: false }) });

  const lanes = [...ui.document.querySelectorAll("[data-role=rec-lane]")];
  assert.equal(lanes.length, 3, "every track still has its lane");
  assert.equal(
    ui.document.querySelectorAll("[data-role=rec-block]").length,
    0,
    "and no lane carries a block, because nothing is placed on the timeline",
  );
  const note = ui.document.querySelector("[data-role=rec-note-empty-plan]");
  assert.ok(note, "the widget says why its lanes are empty");
  assert.equal(note.textContent, EMPTY_PLAN_TEXT, "in the plan's own words");
  assert.equal(ui.document.querySelector("[data-role=rec-note-add-track]"), null, "there is an audio track");
});

test("the widget shows its add-a-track note on a song with no audio track", async () => {
  const ui = await bootLanes({ doc: await lanesDoc({ audio: false }) });

  const note = ui.document.querySelector("[data-role=rec-note-add-track]");
  assert.ok(note, "the widget says what it needs");
  assert.equal(note.textContent, ADD_TRACK_TEXT);
  assert.equal(
    ui.document.querySelector("[data-role=rec-note-empty-plan]"),
    null,
    "one sentence at a time: the missing audio track is the one that matters",
  );
  assert.ok(ui.lane(NOTE_TRACK), "the note track still has its lane");
  assert.equal(ui.document.querySelector("[data-role=rec-lane]").getAttribute("data-track-id"), NOTE_TRACK);
});

test("an audio track removed mid-take does not throw (the lane disappears, rec keeps its own state)", async () => {
  const ui = await bootLanes();

  ui.click(`[data-role=rec-lane][data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await ui.settle();
  ui.click("[data-act=record]");
  await ui.settle(24);
  const recorder = ui.engine.recorders[ui.engine.recorders.length - 1];
  assert.ok(recorder, "the page built a recorder");
  for (const listener of ui.engine.launches) {
    listener({ track_id: AUDIO_TRACK, clip_id: null, scene_id: SCENE, bar: 0, frame: 48000 });
  }
  await ui.settle();
  const status = ui.document.querySelector("[data-role=rec-status]");
  assert.equal(status.getAttribute("data-recording"), "1", "the take is running");

  // The track goes away under the take, the way another view or the agent can
  // take it away: the lane is simply not drawn, and the recording is this
  // page's own state and stays where it is until Stop.
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  runCommand(ui.doc, "track.remove", { track_id: AUDIO_TRACK });
  const { encodeDocState } = await import("../bundles/studio/server/doc.js");
  assert.doesNotThrow(() => {
    ui.frame({
      type: "state",
      update: Buffer.from(encodeDocState(ui.doc)).toString("base64"),
      history: [],
      presence: [],
    });
  }, "a lane whose track went away is not an error");
  await ui.settle();

  assert.equal(ui.lane(AUDIO_TRACK), null, "the lane is gone");
  assert.ok(ui.lane(SECOND_AUDIO_TRACK), "the other lanes are still drawn");
  assert.equal(
    ui.document.querySelector("[data-role=rec-status]").getAttribute("data-recording"),
    "1",
    "the take keeps its own state",
  );
});

test("the record target lane is tall and red and other armed lanes read Armed", async () => {
  const ui = await bootLanes();

  ui.click(`[data-role=rec-lane][data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await ui.settle(24);
  ui.click(`[data-role=rec-lane][data-track-id=${SECOND_AUDIO_TRACK}] [data-act=arm-audio]`);
  await ui.settle(24);

  const targetLane = ui.lane(AUDIO_TRACK);
  const otherLane = ui.lane(SECOND_AUDIO_TRACK);
  assert.equal(
    String(targetLane.getAttribute("class")).includes("st-rec-lane-target"),
    true,
    "the first armed audio track is the record target, drawn as such",
  );
  assert.equal(
    String(otherLane.getAttribute("class")).includes("st-rec-lane-target"),
    false,
    "a second armed track is not the target",
  );

  const targetChip = targetLane.querySelector("[data-role=rec-armed]");
  const otherChip = otherLane.querySelector("[data-role=rec-armed]");
  assert.ok(targetChip, "the target lane says Armed");
  assert.equal(targetChip.textContent, "Armed");
  assert.ok(otherChip, "so does every other armed lane");
  assert.equal(otherChip.textContent, "Armed", "and it says nothing else: the meter is the target's");

  assert.ok(
    targetLane.querySelector("[data-role=rec-target-info]"),
    "the target lane names where it listens and what it hears",
  );
  assert.equal(otherLane.querySelector("[data-role=rec-target-info]"), null);
  assert.equal(
    targetLane.querySelector("[data-role=rec-source]").textContent,
    "Test input \u00b7 stereo",
    "the input's own name and the channel count by name",
  );
  assert.equal(
    ui.lane(NOTE_TRACK).querySelector("[data-role=rec-armed]"),
    null,
    "a lane that cannot be armed never reads Armed",
  );
  // One meter on the page, on the target lane: the second armed track has none.
  assert.equal(ui.document.querySelectorAll("[data-role=rec-meter]").length, 1, "one meter, on the target");
  assert.ok(targetLane.querySelector("[data-role=rec-meter]"), "the target lane carries it");
  assert.equal(otherLane.querySelector("[data-role=rec-meter]"), null, "and no other lane does");
});

// ---- the record target's meter (A4b) --------------------------------------

test("arming an audio track builds one input meter and disarming disposes it", async () => {
  const ui = await bootLanes();
  await ui.mode("record");

  assert.equal(ui.engine.meters.length, 0, "nothing is metered before a track is armed");
  await ui.arm(AUDIO_TRACK);
  await ui.waitFor(() => ui.engine.meters.length === 1, "the arm's meter");

  const meter = ui.engine.meters[0];
  assert.equal(ui.view().armed[AUDIO_TRACK].meter, meter, "the arm holds its own meter");
  assert.equal(meter.disposed, false, "a live meter is not disposed");
  assert.equal(meter.input, ui.view().armed[AUDIO_TRACK].stream, "built on the input the arm opened");
  assert.equal(ui.document.querySelectorAll("[data-role=rec-meter]").length, 1, "one meter on the page");
  assert.deepEqual(meter.active, [true], "and it listens while its lane is on the page");

  await ui.arm(AUDIO_TRACK);
  assert.equal(meter.disposed, true, "disarming lets the meter go");
  assert.equal(ui.view().armed[AUDIO_TRACK], undefined, "with the arm it belonged to");
  assert.equal(ui.document.querySelectorAll("[data-role=rec-meter]").length, 0, "and the lane draws none");
});

test("two armed tracks build ONE meter, on the first; disarming it moves the meter to the second", async () => {
  const ui = await bootLanes();
  await ui.mode("record");
  await ui.arm(AUDIO_TRACK);
  await ui.waitFor(() => ui.engine.meters.length === 1, "the first arm's meter");
  const first = ui.engine.meters[0];

  await ui.arm(SECOND_AUDIO_TRACK);
  await ui.settle(24);
  assert.equal(ui.engine.meters.length, 1, "a second armed track builds no second meter");
  assert.equal(Boolean(ui.view().armed[SECOND_AUDIO_TRACK].meter), false, "and holds none of its own");
  assert.equal(ui.meterNode().getAttribute("data-track-id"), AUDIO_TRACK, "the meter is the target's");

  await ui.arm(AUDIO_TRACK);
  await ui.waitFor(() => ui.engine.meters.length === 2, "the second arm's meter");
  assert.equal(first.disposed, true, "the old target's meter is disposed, not left listening");
  const moved = ui.engine.meters[1];
  assert.equal(ui.view().armed[SECOND_AUDIO_TRACK].meter, moved, "the second arm holds the one meter now");
  assert.equal(ui.meterNode().getAttribute("data-track-id"), SECOND_AUDIO_TRACK, "and the lane draws it there");
  assert.deepEqual(moved.active, [true], "the moved meter listens on the new target's lane");
});

test("the meter is sent off in Compose and Perform and on again in Record", async () => {
  const ui = await bootLanes();
  await ui.mode("record");
  await ui.arm(AUDIO_TRACK);
  await ui.waitFor(() => ui.engine.meters.length === 1, "the meter");
  const meter = ui.engine.meters[0];
  assert.deepEqual(meter.active, [true], "it listens while the lanes are on the page");

  await ui.mode("compose");
  assert.deepEqual(meter.active, [true, false], "leaving Record turns it off");
  await ui.mode("perform");
  assert.deepEqual(meter.active, [true, false], "and a mode that keeps it off writes nothing again");
  await ui.mode("record");
  assert.deepEqual(meter.active, [true, false, true], "back in Record it listens again");
});

test("forgetStaleArms disposes the meter of a removed track", async () => {
  const ui = await bootLanes();
  await ui.mode("record");
  await ui.arm(AUDIO_TRACK);
  await ui.waitFor(() => ui.engine.meters.length === 1, "the meter");
  const meter = ui.engine.meters[0];

  const runCommand = await commands();
  runCommand(ui.doc, "track.remove", { track_id: AUDIO_TRACK });
  await ui.pushState();

  assert.equal(meter.disposed, true, "a track that is gone takes its meter with it");
  assert.equal(ui.view().armed[AUDIO_TRACK], undefined, "and its arm");
  assert.equal(ui.document.querySelectorAll("[data-role=rec-meter]").length, 0, "no lane draws a meter now");
});

test("a level message moves the meter fill, the peak text and the CLIP chip, and the chip clears it", async () => {
  const ui = await bootLanes();
  await ui.mode("record");
  await ui.arm(AUDIO_TRACK);
  await ui.waitFor(() => ui.engine.meters.length === 1, "the meter");
  const meter = ui.engine.meters[0];

  const fill = () => String(ui.document.querySelector("[data-role=rec-meter-fill]").style.width);
  const peak = () => String(ui.document.querySelector("[data-role=rec-peak]").textContent);
  const clip = () => ui.document.querySelector("[data-role=rec-clip]");

  // Half of full scale is -6 dB, and most of a meter that runs up from -60.
  meter.post({ frame: 48000, peak: 0.5, rms: 0.3 });
  assert.equal(peak(), "-6 dB", "the peak reads the level in whole dB");
  const half = Number.parseFloat(fill());
  assert.equal(half > 85 && half < 95, true, `half scale fills most of the meter (${fill()})`);
  assert.equal(clip().hidden, true, "nothing clipped yet");

  // A full-scale sample latches CLIP, and the louder reading is the held peak.
  meter.post({ frame: 48100, peak: 1, rms: 0.6, clipped: true });
  assert.equal(peak(), "0 dB", "full scale is 0 dB");
  assert.equal(fill(), "100%", "and fills the meter");
  assert.equal(clip().hidden, false, "a clipped sample latches the CLIP chip");

  // The chip is the operator's: the engine's latch is let go and the page's own
  // copy with it, and a later clipped sample latches it again.
  ui.click("[data-role=rec-clip]");
  assert.equal(meter.cleared, 1, "the click lets the engine's latch go");
  assert.equal(clip().hidden, true, "and the chip goes at once");
  meter.post({ frame: 48200, peak: 0.7, rms: 0.4, clipped: false });
  assert.equal(clip().hidden, true, "a sample that did not clip does not bring it back");
  meter.post({ frame: 48300, peak: 1.1, rms: 0.7, clipped: true });
  assert.equal(clip().hidden, false, "a clipped one does");

  // The peak stands still for its hold, then falls towards what the input is
  // doing now (a quiet reading, so the fall is what is drawn).
  meter.post({ frame: 48400, peak: 1, rms: 0.5, clipped: false });
  const held = peak();
  await new Promise((resolve) => setTimeout(resolve, 400));
  meter.post({ frame: 48500, peak: 0.0001, rms: 0.0001, clipped: false });
  assert.equal(peak(), held, "inside the hold the peak stands still");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  meter.post({ frame: 48600, peak: 0.0001, rms: 0.0001, clipped: false });
  const fallen = Number.parseFloat(peak());
  assert.equal(fallen < 0 && fallen >= -12, true, `past the hold it has fallen (${peak()})`);
});

test("before the first level message the meter reads the floor, not NaN", async () => {
  const ui = await bootLanes();
  await ui.mode("record");
  await ui.arm(AUDIO_TRACK);
  await ui.waitFor(() => ui.engine.meters.length === 1, "the meter");

  const fill = ui.document.querySelector("[data-role=rec-meter-fill]");
  const peak = ui.document.querySelector("[data-role=rec-peak]");
  assert.equal(String(fill.style.width), "0%", "nothing has been heard, so the meter fills nothing");
  assert.equal(String(peak.textContent), "-60 dB", "and the peak reads the floor");
  assert.equal(/NaN|Infinity/.test(String(fill.style.width) + String(peak.textContent)), false, "never NaN");

  // The lane says where it listens, that the take is the dry input, and that
  // nothing measured this input and output.
  assert.equal(String(ui.document.querySelector("[data-role=rec-source]").textContent), "Test input \u00b7 stereo");
  assert.equal(String(ui.document.querySelector("[data-role=rec-dry]").textContent), "dry input");
  const calibrate = ui.document.querySelector("[data-role=rec-not-calibrated]");
  assert.ok(calibrate, "an unmeasured input says so in the lane");
  assert.equal(String(calibrate.textContent).indexOf("Not calibrated") === 0, true);

  // Digital silence (a peak of exactly zero) reads as the floor as well: a
  // dynamic level is drawn from a number, and silence is not NaN.
  ui.engine.meters[0].post({ frame: 48000, peak: 0, rms: 0 });
  assert.equal(String(fill.style.width), "0%", "silence fills nothing");
  assert.equal(String(peak.textContent), "-60 dB", "and reads the floor");
});

test("a hidden page keeps at most 256 levels and paints none", async () => {
  const ui = await bootLanes();
  await ui.mode("record");
  await ui.arm(AUDIO_TRACK);
  await ui.waitFor(() => ui.engine.meters.length === 1, "the meter");
  const meter = ui.engine.meters[0];

  const drawn = () => String(ui.document.querySelector("[data-role=rec-meter-fill]").style.width)
    + "|" + String(ui.document.querySelector("[data-role=rec-peak]").textContent);
  const before = drawn();
  assert.equal(before, "0%|-60 dB", "the lane starts at the floor");

  ui.setVisibility("hidden");
  for (let index = 0; index < 1000; index += 1) {
    meter.post({ frame: index * 480, peak: 1, rms: 1, clipped: true });
  }
  assert.equal(ui.view().recMeter.queue.length, 256, "the queue is capped at 256 messages");
  assert.equal(drawn(), before, "and a hidden page paints nothing");
  assert.equal(ui.document.querySelector("[data-role=rec-clip]").hidden, true, "not even the CLIP chip");

  // The page comes back: the queue is drawn and then forgotten. The fill is the
  // newest level's; the peak still holds the loud ones the queue kept.
  ui.setVisibility("visible");
  meter.post({ frame: 0, peak: 0.5, rms: 0.2, clipped: false });
  assert.equal(ui.view().recMeter.queue.length, 0, "a returning page drains what it kept");
  assert.equal(drawn(), "90%|0 dB", "and draws it");
  assert.equal(ui.document.querySelector("[data-role=rec-clip]").hidden, false, "a level that clipped while hidden latched the chip");
});

test("drawing a level message adds or removes no node and moves no focus", async () => {
  const ui = await bootLanes();
  await ui.mode("record");
  await ui.arm(AUDIO_TRACK);
  await ui.waitFor(() => ui.engine.meters.length === 1, "the meter");

  const armButton = ui.document.querySelector(`[data-role=rec-lane][data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  assert.ok(armButton, "the lane's own arm button");
  // Everything the arm set going (the input labels, the stored measurement) has
  // landed by now, so a node count taken here is the page's steady state.
  await ui.settle(48);
  armButton.focus();
  ui.document.activeElement = armButton;
  const nodes = ui.document.querySelectorAll("*").length;

  for (let index = 0; index < 100; index += 1) {
    ui.engine.meters[0].post({ frame: index * 480, peak: index / 100, rms: 0.1 });
  }
  assert.equal(ui.document.querySelectorAll("*").length, nodes, "a level message builds no node");
  assert.equal(ui.document.activeElement, armButton, "and takes the focus from nowhere");
  ui.document.activeElement = null;
});

test("the lane shows the chain's amp only as what the operator hears (amp off, amp on)", async () => {
  const plain = await bootLanes();
  await plain.mode("record");
  await plain.arm(AUDIO_TRACK);
  await plain.waitFor(() => plain.engine.meters.length === 1, "the meter");
  assert.equal(
    plain.document.querySelector("[data-role=rec-chain]"),
    null,
    "a track with no amp says nothing about a chain",
  );

  const ui = await bootLanes({ doc: await lanesDocWithAmp() });
  await ui.mode("record");
  await ui.arm(AUDIO_TRACK);
  await ui.waitFor(() => ui.engine.meters.length === 1, "the meter");
  const chain = () => ui.document.querySelector("[data-role=rec-chain]");
  assert.ok(chain(), "a track with an amp names it");
  assert.equal(String(chain().textContent), "amp off", "off while the chain is not heard");

  ui.click(`[data-act=monitor][data-track-id=${AUDIO_TRACK}]`);
  await ui.settle(24);
  assert.equal(ui.view().monitor.on, true, "Hear the chain is on");
  assert.equal(String(chain().textContent), "amp on", "and the lane says the amp is what is heard");

  ui.click(`[data-act=monitor][data-track-id=${AUDIO_TRACK}]`);
  await ui.settle(24);
  assert.equal(String(chain().textContent), "amp off", "turning it off says so again");
});