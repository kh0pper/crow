/**
 * Studio panel — the timeline (arrangement) view.
 *
 * All but the last test run everywhere: the emitted client script against a
 * linkedom document built from the page the handler renders, a real Yjs song
 * with two tracks, an audio clip holding takes and a small arrangement, and a
 * fake engine that reports positions and records the modes and seeks it was
 * given. What they prove is what the page draws and what a drag, a click or a
 * Stop sends — the GUI half of the timeline's commands — including the review's
 * own cases: a refused performance that can still be placed, a transport that
 * stops some other way, a cancelled or torn-down drag, Delete in the clip
 * editor, an agent moving a placement, the keyboard after a render, and a
 * recording that needs a free scene slot.
 *
 * The last one needs the networked half: a real session hub on a scratch
 * database behind the panel's own WebSocket, and a private headless Chrome
 * playing a scene performance into the timeline and undoing it. No browser:
 * it skips, unless CROW_REQUIRE_TEST_CHROME=1, which makes the fixture throw.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";
import { AclError } from "../servers/shared/project-acl.js";
import { createHub } from "../bundles/studio/server/hub.js";
import { initStudioTables } from "../bundles/studio/server/init-tables.js";
import { createStudioWeb } from "../bundles/studio/server/web.js";
import studioPanel from "../bundles/studio/panel/studio.js";
import { TIMELINE_BASE_PX, zoomedBarX } from "../bundles/studio/panel/client.js";
import { PUNCH_SCRIPT } from "../bundles/studio/panel/punch.js";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";

/** The SunVox track the timeline places a note clip on. */
const NOTE_TRACK = "bass";

/** The audio track, whose lane carries take rows. */
const AUDIO_TRACK = "gtr";

/** The one scene of the fixture song. */
const SCENE = "verse";

/** The note clip on the note track. */
const NOTE_CLIP = "c-bass";

/** The audio clip on the audio track. */
const AUDIO_CLIP = "c-gtr";

/** Two takes of the audio clip, oldest first. */
const T1 = "0a1b2c3d-0000-4000-8000-000000000011";
const T2 = "0a1b2c3d-0000-4000-8000-000000000012";

/** The placements the fixture song starts with. */
const NOTE_PLACEMENT = "p-notes";
const AUDIO_PLACEMENT = "p-audio";

/** The sample track the pattern clip sits on, and the clip itself. */
const PATTERN_TRACK = "drums";
const PATTERN_CLIP = "c-drums";

/** The project the live test's song lives in, and its storage prefix. */
const PROJECT = 53;
const PREFIX = "projects/53/";

/** The author a browser command carries (server/web.js's own constant). */
const HUMAN = { kind: "human", id: "local", label: "You" };

/** The bundle directory the asset routes read from. */
const BUNDLE_DIR = new URL("../bundles/studio", import.meta.url).pathname.replace(/\/$/, "");

/** The Record to timeline notice, word for word from the approved design. */
const REC_TIMELINE_TEXT =
  "Recording to the timeline: launch scenes in Session view as you play. When you press Stop, "
  + "every launch becomes a placement here, as one step you can undo.";

// ---- the fixture document --------------------------------------------------

/**
 * The song the client tests draw: a note track and an audio track, one scene,
 * a two-bar note clip, an audio clip with two takes, and an arrangement with
 * one placement on each lane, one section and one marker.
 * @returns {Promise<import("yjs").Doc>}
 */
async function timelineDoc() {
  const { newSongDoc } = await import("../bundles/studio/server/doc.js");
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  await import("../bundles/studio/server/commands/core.js");
  await import("../bundles/studio/server/commands/takes.js");
  await import("../bundles/studio/server/commands/arrangement.js");

  const doc = newSongDoc({ title: "Timeline song", bpm: 120 });
  runCommand(doc, "track.add", { id: NOTE_TRACK, name: "Bass" });
  runCommand(doc, "track.add", { id: AUDIO_TRACK, name: "Guitar", kind: "audio" });
  runCommand(doc, "scene.add", { id: SCENE, name: "Verse" });
  runCommand(doc, "clip.write", {
    clip_id: NOTE_CLIP,
    track_id: NOTE_TRACK,
    scene_id: SCENE,
    name: "Bass line",
    length_bars: 2,
    notes: [{ t: 0, d: 1, p: 60, v: 100 }],
  });
  runCommand(doc, "clip.add_audio", {
    clip_id: AUDIO_CLIP,
    track_id: AUDIO_TRACK,
    scene_id: SCENE,
    length_bars: 1,
    name: "Guitar",
  });
  for (const [id, at] of [[T1, "2026-03-01T10:00:00.000Z"], [T2, "2026-03-01T10:05:00.000Z"]]) {
    // Studio's own upload finish route adds a take; runCommand is the document
    // editor's way in, and it throws when a command is refused.
    runCommand(doc, "take.add", {
      clip_id: AUDIO_CLIP,
      take: {
        id,
        storage_key: `${PREFIX}studio/song-1/takes/${id}.wav`,
        rate: 48000,
        channels: 2,
        frames: 48000,
        offset_frames: 0,
        compensated: true,
        bpm: 120,
        recorded_at: at,
        author_label: "You",
        discarded: false,
      },
    });
  }
  runCommand(doc, "section.add", { id: "sec-intro", start_bar: 0, end_bar: 4, name: "Intro" });
  runCommand(doc, "marker.add", { id: "m-key", bar: 8, name: "Key change" });
  runCommand(doc, "arrangement.place", {
    id: NOTE_PLACEMENT,
    track_id: NOTE_TRACK,
    clip_id: NOTE_CLIP,
    start_bar: 4,
    bars: 4,
  });
  runCommand(doc, "arrangement.place", {
    id: AUDIO_PLACEMENT,
    track_id: AUDIO_TRACK,
    clip_id: AUDIO_CLIP,
    start_bar: 4,
    bars: 4,
  });
  return doc;
}

// ---- the two pages' shared fixtures ---------------------------------------

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

/**
 * This device's count-in, stored the way a browser stores it.
 * @param {number} bars
 * @returns {object} the storage the page reads it from
 */
function countInStorage(bars) {
  const storage = memoryStorage();
  storage.setItem("crow.studio.countin.v1", String(bars));
  return storage;
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

/** A context stand-in: the nodes the page builds for monitoring and its clock. */
function fakeContext(clock = 0) {
  const secondsOf = () => (typeof clock === "number" ? clock : Number(clock.seconds) || 0);
  const gain = { gain: { value: 1 }, connect() {}, disconnect() {} };
  return {
    sampleRate: 48000,
    state: "running",
    get currentTime() {
      return secondsOf();
    },
    destination: {},
    createGain: () => gain,
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
    resume: async () => {},
    close() {},
  };
}

/**
 * The engine stand-in: it keeps the modes and seeks it was given, the songs it
 * was handed, and the position listener the page registered, so a test can
 * report a position the way the processor would.
 */
function fakeEngine(clock = { seconds: 0 }) {
  const nowOf = () => Math.round((Number(clock.seconds) || 0) * 48000);
  const engine = {
    songs: [],
    modes: [],
    seeks: [],
    plays: 0,
    /** Every `play` the page sent, with its options (`{countInBars}` or none). */
    playCalls: [],
    pauses: 0,
    stops: 0,
    positions: [],
    launches: [],
    node: { connect() {} },
    setSong(song) {
      engine.songs.push(song);
    },
    setMode(mode) {
      engine.modes.push(mode);
    },
    seek(bar) {
      engine.seeks.push(bar);
    },    play(options) {
      engine.plays += 1;
      engine.playCalls.push(options || null);
    },
    pause() {
      engine.pauses += 1;
    },
    stop() {
      engine.stops += 1;
    },
    stopAll() {},
    launched: [],
    launchScene(sceneId) {
      engine.launched.push(String(sceneId));
    },
    onPosition(listener) {
      engine.positions.push(listener);
      return () => {};
    },
    onLaunch(listener) {
      engine.launches.push(listener);
      return () => {};
    },
    // The count-in's own messages: the frame the song will start on, one per
    // click, and the frame it started on. A test posts them in that order, the
    // way the processor does.
    countInListeners: [],
    events: [],
    onCountIn(listener) {
      engine.countInListeners.push(listener);
      return () => {};
    },
    countIn(event) {
      engine.events.push(event && event.type ? String(event.type) : "");
      for (const listener of engine.countInListeners) listener(event);
    },
    /** Walk a count-in of `bars` bars from its start to its downbeat. */
    countBar(bars = 1, playFrame = 96000, beatFrames = 12000) {
      const beats = bars * 4;
      engine.countIn({ type: "count_in_start", play_frame: playFrame });
      for (let beat = 1; beat <= beats; beat += 1) {
        engine.countIn({
          type: "count_in",
          beat,
          beats,
          frame: playFrame - (beats - beat) * beatFrames,
          play_frame: playFrame,
        });
      }
      engine.countIn({ type: "count_in_done", frame: playFrame });
    },
    cancels: 0,
    cancelCountIn() {
      engine.cancels += 1;
    },
    onError() {
      return () => {};
    },
    async nextBarFrame() {
      return { frame: 48000, bar: 1 };
    },
    async loadAudio() {},
    unloadAudio() {},
    /** Every recorder the page built, so a test can end a take from the input side. */
    recorders: [],
    createRecorder() {
      const recorder = {
        armed: null,
        stopped_at: null,
        splits: [],
        chunks: [],
        chunk: null,
        done: null,
        disposals: 0,
        onChunk(listener) {
          recorder.chunk = listener;
        },
        onDone(listener) {
          recorder.done = listener;
        },
        armAt(frame) {
          recorder.armed = frame;
          // The frame the page's own clock stood on as the arm was sent: an arm
          // is always in the future, so this is never past it.
          recorder.armNow = nowOf();
        },
        stopAt(frame) {
          recorder.stopped_at = frame;
        },
        splitAt(list) {
          recorder.splits = list;
        },
        dispose() {
          recorder.disposals += 1;
        },
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
 * @param {{doc?: object, storage?: object, history?: object[], clock?: number}} [options]
 */
async function bootTimeline(options = {}) {
  const { parseHTML } = await import("linkedom");
  const { pathToFileURL } = await import("node:url");
  const { encodeDocState } = await import("../bundles/studio/server/doc.js");
  const { CLIENT_SCRIPT } = await import("../bundles/studio/panel/client.js");

  const doc = options.doc || (await timelineDoc());
  const res = {
    html: "",
    send(body) {
      this.html = String(body);
    },
  };
  await studioPanel.handler({ query: { song: "song-1" }, headers: {} }, res, {
    db: panelDb(),
    layout: minimalLayout,
  });
  assert.ok(res.html.includes('data-studio-song="song-1"'), "the handler rendered the song page");
  const { document, window: domWindow } = parseHTML(res.html);

  // linkedom's focus() does nothing; every call is recorded here instead, so a
  // test can see which button the page handed the keyboard to after a render.
  const focusCalls = [];
  const ElementProto = domWindow.Element && domWindow.Element.prototype;
  if (ElementProto && typeof ElementProto.focus === "function") {
    ElementProto.focus = function focus() {
      focusCalls.push(this);
    };
  }

  const store = fakeTakeStore();
  // The page's own clock: a recorder armed while it stands at `clock` seconds
  // can be checked against the frame it was armed on.
  const clock = { seconds: options.clock || 0 };
  const engine = fakeEngine(clock);
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
      return response(200, [{ id: "song-1", project_id: PROJECT, title: "Timeline song" }]);
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

  const windowListeners = {};
  const windowStub = {
    crypto: globalThis.crypto,
    location: { protocol: "http:", host: "127.0.0.1:1", reload() {} },
    atob: globalThis.atob,
    confirm: () => true,
    prompt: () => null,
    AudioContext: function AudioContextStub() {
      return fakeContext(clock);
    },
    StudioTakeStore: store,
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
  if (options.storage) windowStub.localStorage = options.storage;
  else {
    // This device's count-in: the rig starts with it Off, which is the path a
    // take has always taken (R4), so a launch report or a bar frame arms it.
    const rigStorage = memoryStorage();
    rigStorage.setItem("crow.studio.countin.v1", "0");
    windowStub.localStorage = rigStorage;
  }

  // The page inlines the punch rules before the client script, and the comp
  // drag reads them from there: the stub is given the very same text.
  new Function("window", PUNCH_SCRIPT)(windowStub);
  assert.equal(typeof windowStub.StudioPunch.spliceComp, "function", "the stub holds the page's punch rules");

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
  const event = (type, props) => {
    const made = new domWindow.Event(type, { bubbles: true, cancelable: true });
    for (const [key, value] of Object.entries(props || {})) made[key] = value;
    return made;
  };
  const fireWindow = (name, made) => {
    for (const handler of [...(windowListeners[name] || [])]) handler(made);
  };

  await settle();
  frame({
    type: "state",
    update: Buffer.from(encodeDocState(doc)).toString("base64"),
    history: options.history || [],
    presence: [],
  });
  await settle();

  const page = document.querySelector(".studio");
  const click = (selector) => {
    const node = document.querySelector(selector);
    assert.ok(node, `nothing matches ${selector}`);
    node.dispatchEvent(new domWindow.Event("click", { bubbles: true }));
    return node;
  };

  return {
    doc,
    document,
    domWindow,
    window: windowStub,
    store,
    engine,
    sent,
    page,
    click,
    event,
    settle,
    frame,
    fireWindow,
    timers,
    focusCalls,
    windowListeners,
    /** Press on an element and let the page see it, the way a pointer would. */
    press(selector, props) {
      const node = document.querySelector(selector);
      assert.ok(node, `nothing matches ${selector}`);
      node.dispatchEvent(event("pointerdown", props));
      return node;
    },
    /** Release the pointer anywhere: the page hears it on the window. */
    release(props) {
      fireWindow("pointerup", event("pointerup", props || {}));
    },
    /** Report a transport position, the way the processor posts it. */
    position(props) {
      for (const listener of engine.positions) listener(props);
    },
    /** Report a launch, the way the sequencer posts it. */
    launch(props) {
      for (const listener of engine.launches) listener(props);
    },
  };
}

/** @returns {object[]} every command of one id the page sent, in order. */
function commands(ui, id) {
  return ui.sent.filter((message) => message.type === "command" && message.command === id);
}

/** @returns {object[]} every command of any id the page sent. */
function allCommands(ui) {
  return ui.sent.filter((message) => message.type === "command");
}

/** A 32-bar ruler or lane, 10 px a bar. */
function timelineBox(top = 0) {
  return { left: 0, top, width: 320, height: 54, right: 320, bottom: top + 54, x: 0, y: top };
}

/** Stub the bar ruler's own box: 32 bars, 10 px each. */
function stubRuler(ui) {
  const strip = ui.document.querySelector("[data-role=bar-ruler]");
  assert.ok(strip, "the timeline draws the bar ruler");
  strip.getBoundingClientRect = () => ({
    left: 0, top: 0, width: 320, height: 18, right: 320, bottom: 18, x: 0, y: 0,
  });
  return strip;
}

/** Press the ruler at a point, the way a pointer would. */
function rulerPress(ui, strip, clientX) {
  strip.dispatchEvent(ui.event("pointerdown", { button: 0, clientX }));
}

/** Stub the box of every lane body, the way a laid-out browser would report it. */
function stubLanes(ui) {
  const lanes = ui.document.querySelectorAll("[data-role=lane-body]");
  for (const body of lanes) {
    const group = body.closest("[data-lane-id]");
    const id = group ? group.getAttribute("data-lane-id") : "";
    const top = id === NOTE_TRACK ? 0 : 60;
    body.getBoundingClientRect = () => timelineBox(top);
  }
  return lanes;
}

/** @returns {object} a 160 px comp bar box */
function compBarBox() {
  return { left: 0, top: 0, width: 160, height: 34, right: 160, bottom: 34, x: 0, y: 0 };
}

/** @returns {object} a 160 px, four-bar placement block, 40 px a bar */
function placementBox() {
  return { left: 0, top: 0, width: 160, height: 36, right: 160, bottom: 36, x: 0, y: 0 };
}

/** @returns {object} the piano roll of the fixture's two-bar note clip */
function rollBox() {
  return { left: 0, top: 0, width: 1000, height: KEY_ROLL_HEIGHT, right: 1000, bottom: KEY_ROLL_HEIGHT, x: 0, y: 0 };
}

/** How tall the piano roll is: 128 rows of 12 px, as the client draws it. */
const KEY_ROLL_HEIGHT = 128 * 12;

/**
 * The fixture song with its arrangement emptied: nothing on either lane.
 * @returns {Promise<import("yjs").Doc>}
 */
async function unplacedDoc() {
  const doc = await timelineDoc();
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  runCommand(doc, "arrangement.remove", { id: NOTE_PLACEMENT });
  runCommand(doc, "arrangement.remove", { id: AUDIO_PLACEMENT });
  return doc;
}

/**
 * A song with one sampler track and one pattern clip, so the pad-and-steps view
 * has a clip of its own to offer the timeline.
 * @returns {Promise<import("yjs").Doc>}
 */
async function patternDoc() {
  const { newSongDoc } = await import("../bundles/studio/server/doc.js");
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  await import("../bundles/studio/server/commands/core.js");
  await import("../bundles/studio/server/commands/sampler.js");

  const doc = newSongDoc({ title: "Pattern song", bpm: 120 });
  runCommand(doc, "track.add", { id: PATTERN_TRACK, name: "Drums", kind: "sampler" });
  runCommand(doc, "scene.add", { id: SCENE, name: "Verse" });
  runCommand(doc, "clip.add_pattern", {
    clip_id: PATTERN_CLIP,
    track_id: PATTERN_TRACK,
    scene_id: SCENE,
    name: "Kit loop",
  });
  return doc;
}

/**
 * Drag the fixture's note clip out of the grid to a point, with the lanes drawn
 * under it and their boxes given the way a laid-out browser reports them.
 * @param {object} ui the booted page
 * @param {{clientX: number, clientY: number}} point where the pointer is
 */
async function dragNoteClipTo(ui, point) {
  const clip = ui.document.querySelector(`[data-act=open-clip][data-clip-id=${NOTE_CLIP}]`);
  assert.ok(clip, "the clip is on the session grid");
  clip.dispatchEvent(ui.event("pointerdown", { button: 0, clientX: 100, clientY: 100 }));
  // The first move brings the lanes up, which is when a browser lays them out.
  ui.fireWindow("pointermove", ui.event("pointermove", { clientX: point.clientX, clientY: point.clientY }));
  await ui.settle();
  stubLanes(ui);
  ui.fireWindow("pointermove", ui.event("pointermove", { clientX: point.clientX, clientY: point.clientY }));
  await ui.settle();
}

// ---- the tests that need no browser ---------------------------------------

test("drag from grid places a clip", async () => {
  const ui = await bootTimeline();

  // Session view is where the grid is, and where a drag starts.
  assert.equal(
    ui.document.querySelector("[data-role=timeline]").hidden,
    true,
    "the timeline is not the view yet",
  );
  const clip = ui.document.querySelector(`[data-act=open-clip][data-clip-id=${NOTE_CLIP}]`);
  assert.ok(clip, "the clip is on the session grid");

  clip.dispatchEvent(ui.event("pointerdown", { button: 0, clientX: 100, clientY: 100 }));
  ui.fireWindow("pointermove", ui.event("pointermove", { clientX: 140, clientY: 130 }));
  await ui.settle();

  // The lanes came up under the clip: they are what it is dropped on.
  assert.equal(
    ui.document.querySelector("[data-role=timeline]").hidden,
    false,
    "dragging a clip brings the lanes up",
  );
  const lanes = stubLanes(ui);
  assert.ok(lanes.length >= 2, "one lane per track");

  // 85 px on a 320 px, 32-bar lane is bar 9, which is bar index 8.
  ui.fireWindow("pointerup", ui.event("pointerup", { clientX: 85, clientY: 20 }));
  await ui.settle();

  const placed = commands(ui, "arrangement.place");
  assert.equal(placed.length, 1, "a whole drag is one arrangement.place");
  assert.equal(placed[0].args.track_id, NOTE_TRACK, "on the lane it was let go over");
  assert.equal(placed[0].args.clip_id, NOTE_CLIP, "of the clip that was dragged");
  assert.equal(placed[0].args.start_bar, 8, "at the bar it was dropped on");
  assert.equal(typeof placed[0].cmd_id, "string", "with a client-generated cmd_id");
  assert.equal(
    ui.document.querySelector("[data-role=timeline]").hidden,
    false,
    "and the timeline is the view once the clip is placed",
  );
  assert.equal(
    ui.document.querySelector("[data-role=grid-wrap]").hidden,
    true,
    "with the grid put away, so the new placement is what the operator is looking at",
  );
});

test("dragging shows a ghost with the clip name that follows the pointer", async () => {
  const ui = await bootTimeline();
  const clip = ui.document.querySelector(`[data-act=open-clip][data-clip-id=${NOTE_CLIP}]`);
  assert.ok(clip, "the clip is on the session grid");

  clip.dispatchEvent(ui.event("pointerdown", { button: 0, clientX: 100, clientY: 100 }));
  ui.fireWindow("pointermove", ui.event("pointermove", { clientX: 130, clientY: 140 }));
  await ui.settle();

  const ghost = ui.document.querySelector("[data-role=drag-ghost]");
  assert.ok(ghost, "the drag carries a ghost");
  assert.equal(ghost.textContent, "Bass line", "with the clip's own name on it");
  const firstLeft = Number.parseFloat(ghost.style.left);
  assert.equal(firstLeft, 142, "beside the pointer, twelve pixels to its right");
  assert.equal(Number.parseFloat(ghost.style.top), 152, "and twelve pixels below it");

  ui.fireWindow("pointermove", ui.event("pointermove", { clientX: 200, clientY: 140 }));
  await ui.settle();
  assert.equal(
    ui.document.querySelectorAll("[data-role=drag-ghost]").length,
    1,
    "there is still one ghost, not one per move",
  );
  assert.equal(Number.parseFloat(ghost.style.left), 212, "and it followed the pointer");
});

test("the lane and bar under the pointer carry .st-lane-target and .st-bar-target", async () => {
  const ui = await bootTimeline();
  // 85 px on a 320 px, 32-bar lane is bar index 8, on the note track's lane.
  await dragNoteClipTo(ui, { clientX: 85, clientY: 20 });

  const lane = ui.document.querySelector(`[data-lane-id=${NOTE_TRACK}] [data-role=lane-body]`);
  assert.ok(lane, "the note track has a lane");
  assert.equal(lane.classList.contains("st-lane-target"), true, "the lane it would land on is outlined");
  const bands = lane.querySelectorAll("[data-role=bar-target]");
  assert.equal(bands.length, 1, "and one bar of it is marked");
  assert.equal(bands[0].classList.contains("st-bar-target"), true, "with the bar target's own class");
  assert.equal(bands[0].getAttribute("data-bar"), "8", "the bar under the pointer");
  assert.match(String(bands[0].getAttribute("style")), /left:25%/, "drawn where bar 9 of 32 sits");

  const other = ui.document.querySelector(`[data-lane-id=${AUDIO_TRACK}] [data-role=lane-body]`);
  assert.ok(other, "the audio track has a lane too");
  assert.equal(other.classList.contains("st-lane-target"), false, "a lane the pointer is not on is left alone");
  assert.equal(other.querySelectorAll("[data-role=bar-target]").length, 0, "and marks no bar");

  // Moving onto the other lane moves both marks with the pointer.
  ui.fireWindow("pointermove", ui.event("pointermove", { clientX: 85, clientY: 80 }));
  await ui.settle();
  assert.equal(
    ui.document.querySelector(`[data-lane-id=${AUDIO_TRACK}] [data-role=lane-body]`).classList.contains("st-lane-target"),
    true,
    "the lane under the pointer is the one outlined",
  );
  assert.equal(
    ui.document.querySelector(`[data-lane-id=${NOTE_TRACK}] [data-role=lane-body]`).classList.contains("st-lane-target"),
    false,
    "and the one it left is not",
  );

  // The release takes both marks off the page.
  ui.release({ clientX: 85, clientY: 80 });
  await ui.settle();
  assert.equal(ui.document.querySelector("[data-role=bar-target]"), null, "no bar is marked after the drop");
  assert.equal(ui.document.querySelector(".st-lane-target"), null, "and no lane is outlined");
});

test("one drop sends exactly one arrangement.place; a second pointerup sends none", async () => {
  const ui = await bootTimeline();
  await dragNoteClipTo(ui, { clientX: 85, clientY: 20 });

  ui.release({ clientX: 85, clientY: 20 });
  await ui.settle();
  assert.equal(commands(ui, "arrangement.place").length, 1, "the whole drag is one placement");

  // The release that ended the drag took its listeners off: a second one, from a
  // pointer the drop already finished with, writes nothing.
  ui.release({ clientX: 85, clientY: 20 });
  await ui.settle();
  assert.equal(commands(ui, "arrangement.place").length, 1, "a second pointerup sends no placement");
  assert.equal(allCommands(ui).length, 1, "and nothing else either");
});

test("after a drop the arrangement is the view and the new placement is selected", async () => {
  const ui = await bootTimeline();
  await dragNoteClipTo(ui, { clientX: 85, clientY: 20 });
  ui.release({ clientX: 85, clientY: 20 });
  await ui.settle();

  const placed = commands(ui, "arrangement.place");
  assert.equal(placed.length, 1);
  assert.equal(ui.document.querySelector("[data-role=timeline]").hidden, false, "the lanes are the view");
  assert.equal(ui.document.querySelector("[data-role=grid-wrap]").hidden, true, "and the grid is put away");
  assert.equal(
    ui.document.querySelector("[data-act=mode-arrangement]").getAttribute("aria-pressed"),
    "true",
    "the view switch says which one is on",
  );

  // The hub's answer carries the placement the page sent; it arrives selected.
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  const { encodeDocState } = await import("../bundles/studio/server/doc.js");
  runCommand(ui.doc, "arrangement.place", placed[0].args);
  ui.frame({
    type: "state",
    update: Buffer.from(encodeDocState(ui.doc)).toString("base64"),
    history: [],
    presence: [],
  });
  await ui.settle();

  const block = ui.document.querySelector(`[data-placement-id=${placed[0].args.id}]`);
  assert.ok(block, "the new placement is drawn on its lane");
  assert.equal(
    String(block.getAttribute("class")).includes("st-tl-block-sel"),
    true,
    "and it is the selected block",
  );
  assert.match(
    String(ui.document.querySelector("[data-role=placement-bar]").textContent),
    /Placement: Bass line/,
    "the placement bar names it",
  );
});

test("the toast reads Placed on <track> at bar N, once the hub has taken the place", async () => {
  const ui = await bootTimeline();
  await dragNoteClipTo(ui, { clientX: 85, clientY: 20 });
  ui.release({ clientX: 85, clientY: 20 });
  await ui.settle();

  const placed = commands(ui, "arrangement.place");
  assert.equal(placed.length, 1, "the drop sent its place");
  const toast = ui.document.querySelector("[data-role=toast]");
  assert.equal(toast.hidden, true, "nothing is claimed before the hub answers");
  assert.equal(toast.textContent, "", "and no sentence is on the page yet");

  ui.frame({ type: "result", cmd_id: placed[0].cmd_id, ok: true });
  await ui.settle();
  assert.equal(toast.hidden, false, "the page says where the clip went");
  assert.equal(toast.textContent, "Placed on Bass at bar 9", "the lane's name and the bar it landed on");
});

test("a refused place says why, not where it went", async () => {
  const ui = await bootTimeline();
  await dragNoteClipTo(ui, { clientX: 85, clientY: 20 });
  ui.release({ clientX: 85, clientY: 20 });
  await ui.settle();

  const placed = commands(ui, "arrangement.place");
  assert.equal(placed.length, 1, "the drop sent its place");
  ui.frame({
    type: "result",
    cmd_id: placed[0].cmd_id,
    ok: false,
    code: "refused",
    error: "Bars 9 to 10 are already taken on Bass.",
  });
  await ui.settle();

  const toast = ui.document.querySelector("[data-role=toast]");
  assert.equal(toast.hidden, false, "the refusal is said");
  assert.equal(toast.textContent, "Bars 9 to 10 are already taken on Bass.", "in the hub's own words");
  assert.equal(String(toast.textContent).includes("Placed on"), false, "and never as a placement");
});

test("a drop on no lane sends nothing and returns to the previous view", async () => {
  const ui = await bootTimeline();
  const clip = ui.document.querySelector(`[data-act=open-clip][data-clip-id=${NOTE_CLIP}]`);
  clip.dispatchEvent(ui.event("pointerdown", { button: 0, clientX: 100, clientY: 100 }));
  ui.fireWindow("pointermove", ui.event("pointermove", { clientX: 140, clientY: 130 }));
  await ui.settle();
  stubLanes(ui);
  assert.equal(
    ui.document.querySelector("[data-role=timeline]").hidden,
    false,
    "the drag brought the lanes up to be dropped on",
  );

  // Well below the last lane, where no drop target is.
  ui.release({ clientX: 140, clientY: 400 });
  await ui.settle();

  assert.deepEqual(allCommands(ui), [], "a drop on nothing writes nothing");
  assert.equal(
    ui.document.querySelector("[data-role=timeline]").hidden,
    true,
    "and the view it was dragged from is back",
  );
  assert.equal(ui.document.querySelector("[data-role=drag-ghost]"), null, "the ghost is gone with the drag");
  assert.equal(ui.document.querySelector(".st-lane-target"), null, "and no lane is left outlined");
});

test("a drop while the session is playing leaves the engine's view alone", async () => {
  const storage = memoryStorage();
  const ui = await bootTimeline({ storage });
  ui.click("[data-act=play]");
  await ui.settle(24);
  assert.equal(ui.engine.plays, 1, "the session transport is running");

  await dragNoteClipTo(ui, { clientX: 85, clientY: 20 });
  ui.release({ clientX: 85, clientY: 20 });
  await ui.settle();

  assert.equal(commands(ui, "arrangement.place").length, 1, "the drop still went to the hub");
  assert.equal(
    ui.engine.modes.includes("arrangement"),
    false,
    "the engine was not switched to the timeline, so the session keeps sounding",
  );
  assert.equal(ui.engine.stops, 0, "nothing stopped");
  assert.equal(ui.engine.pauses, 0, "and nothing paused");
  assert.equal(
    storage.getItem("crow-studio-mode:song-1"),
    null,
    "and nothing was stored for the engine to open in",
  );
  assert.equal(
    ui.document.querySelector("[data-role=timeline]").hidden,
    false,
    "the timeline is what the page shows",
  );
  assert.equal(ui.document.querySelector("[data-role=grid-wrap]").hidden, true, "with the grid put away");
});

test("record to timeline turns 3 launches into 3 placements in one step", async () => {
  const ui = await bootTimeline();

  ui.click("[data-act=rec-timeline]");
  assert.equal(
    ui.document.querySelector("[data-act=rec-timeline]").getAttribute("aria-pressed"),
    "true",
    "the toggle shows it is on",
  );
  const notice = ui.document.querySelector("[data-role=timeline-notice]");
  assert.equal(notice.hidden, false, "the design's notice is shown while it is on");
  assert.equal(notice.textContent, REC_TIMELINE_TEXT, "word for word");

  ui.click("[data-act=play]");
  await ui.settle(24);
  assert.equal(ui.engine.plays, 1, "the transport is running");

  // Three launches of the note clip, four bars apart, then Stop two bars after
  // the last one.
  for (const bar of [0, 4, 8]) {
    ui.launch({ track_id: NOTE_TRACK, clip_id: NOTE_CLIP, scene_id: SCENE, bar, frame: bar * 96000 });
  }
  ui.position({ bar: 11, beat: 1, sixteenth: 1 });
  ui.click("[data-act=stop]");
  await ui.settle();

  const sent = commands(ui, "arrangement.record_performance");
  assert.equal(sent.length, 1, "the whole performance is one command");
  assert.deepEqual(
    sent[0].args.placements,
    [
      { track_id: NOTE_TRACK, clip_id: NOTE_CLIP, start_bar: 0, bars: 4 },
      { track_id: NOTE_TRACK, clip_id: NOTE_CLIP, start_bar: 4, bars: 4 },
      { track_id: NOTE_TRACK, clip_id: NOTE_CLIP, start_bar: 8, bars: 2 },
    ],
    "each launch opens a placement and the next one (or the stop bar) closes it",
  );
  assert.equal(
    allCommands(ui).filter((message) => String(message.command).indexOf("arrangement.") === 0).length,
    1,
    "nothing else on the timeline was written",
  );

  // With the toggle off, a launch is not collected and Stop sends nothing.
  const quiet = await bootTimeline();
  quiet.click("[data-act=play]");
  await quiet.settle(24);
  quiet.launch({ track_id: NOTE_TRACK, clip_id: NOTE_CLIP, scene_id: SCENE, bar: 0, frame: 0 });
  quiet.position({ bar: 3, beat: 1, sixteenth: 1 });
  quiet.click("[data-act=stop]");
  await quiet.settle();
  assert.equal(
    commands(quiet, "arrangement.record_performance").length,
    0,
    "Record to timeline off: nothing is written",
  );
});

test("split at playhead makes two placements", async () => {
  const ui = await bootTimeline();
  ui.click("[data-act=mode-arrangement]");
  await ui.settle();

  const block = ui.document.querySelector(`[data-placement-id=${NOTE_PLACEMENT}]`);
  assert.ok(block, "the placement is drawn on its lane");
  assert.match(String(block.getAttribute("style")), /left:12\.5%/, "at bar 5 of 32");

  ui.click(`[data-placement-id=${NOTE_PLACEMENT}]`);
  await ui.settle();

  // The ruler's own box is the ruler: 65 px is bar index 6, inside bars 4-8.
  const strip = ui.document.querySelector("[data-role=bar-ruler]");
  assert.ok(strip, "the timeline draws the bar ruler");
  strip.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    width: 320,
    height: 18,
    right: 320,
    bottom: 18,
  });
  strip.dispatchEvent(ui.event("pointerdown", { button: 0, clientX: 65 }));
  await ui.settle();
  ui.release();
  assert.deepEqual(ui.engine.seeks, [6], "clicking the ruler seeks to the bar under it");
  assert.equal(
    ui.document.querySelector("[data-role=playhead]").style.left,
    "18.75%",
    "and the playhead is drawn there",
  );
  assert.ok(strip, "the ruler is the bar strip");

  ui.click("[data-act=split]");
  await ui.settle();

  const sent = commands(ui, "arrangement.split");
  assert.equal(sent.length, 1, "Split at playhead is one arrangement.split");
  assert.equal(sent[0].args.id, NOTE_PLACEMENT, "of the selected placement");
  assert.equal(sent[0].args.at_bar, 6, "at the playhead bar");
  assert.equal(typeof sent[0].args.new_id, "string", "with an id for the second half");

  // The same command on the song really does make two placements.
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  const { snapshot } = await import("../bundles/studio/server/doc.js");
  runCommand(ui.doc, "arrangement.split", sent[0].args);
  const after = snapshot(ui.doc).arrangement.placements;
  assert.equal(Object.keys(after).length, 3, "one placement became two (plus the audio lane's)");
  assert.equal(after[NOTE_PLACEMENT].start_bar, 4, "the first half keeps the place it had");
  assert.equal(after[NOTE_PLACEMENT].bars, 2, "and ends on the split bar");
  const second = after[sent[0].args.new_id];
  assert.ok(second, "the second half is a placement of its own");
  assert.equal(second.start_bar, 6, "starting on the split bar");
  assert.equal(second.bars, 2, "and filling the rest of the block");
  // The clip is two bars and the placement is four, so two bars in it has
  // looped back to the top: the second half starts the clip again, and the
  // whole block plays what the one placement played.
  assert.equal(second.offset_beats, 0, "continuing the clip where the loop put it");
});

test("comp from the timeline take rows sends set_comp", async () => {
  const ui = await bootTimeline();
  ui.click("[data-act=mode-arrangement]");
  await ui.settle();
  assert.equal(commands(ui, "clip.set_comp").length, 0, "nothing has been comped yet");

  ui.click(`[data-track-id=${AUDIO_TRACK}] [data-act=timeline-takes]`);
  await ui.settle();

  const lane = ui.document.querySelector("[data-role=timeline-takes]");
  assert.ok(lane, "the lane's take rows opened under it");
  assert.equal(
    lane.querySelectorAll("[data-role=take]").length,
    2,
    "one row per take of the lane's clip",
  );
  assert.ok(lane.querySelector("[data-role=comp-bar]"), "and the comp bar that says what plays");

  // Click a row to choose the take, then drag across the comp bar.
  ui.click(`[data-role=timeline-takes] [data-role=take][data-take-n="2"]`);
  await ui.settle();
  const bar = ui.document.querySelector("[data-role=timeline-takes] [data-role=comp-bar]");
  assert.ok(bar, "the comp bar is still there after choosing a take");
  bar.getBoundingClientRect = () => compBarBox();
  bar.dispatchEvent(ui.event("pointerdown", { button: 0, clientX: 2, shiftKey: false }));
  ui.fireWindow("pointermove", ui.event("pointermove", { clientX: 158 }));
  ui.fireWindow("pointerup", ui.event("pointerup", { clientX: 158 }));
  await ui.settle();

  const sent = commands(ui, "clip.set_comp");
  assert.equal(sent.length, 1, "a whole drag is one clip.set_comp");
  assert.equal(sent[0].args.clip_id, AUDIO_CLIP, "against the lane's clip");
  assert.deepEqual(
    sent[0].args.segments,
    [{ take_id: T2, from_beat: 0, to_beat: 4 }],
    "the chosen take over the whole clip",
  );
});

test("arrangement playback follows the playhead", async () => {
  const ui = await bootTimeline();
  ui.click("[data-act=play]");
  await ui.settle(24);
  assert.ok(ui.engine, "the engine was built by Play");
  ui.click("[data-act=stop]");
  await ui.settle();

  ui.click("[data-act=mode-arrangement]");
  await ui.settle();
  assert.equal(
    ui.engine.modes[ui.engine.modes.length - 1],
    "arrangement",
    "the switch tells the engine which view it plays",
  );
  assert.equal(
    ui.document.querySelector("[data-act=mode-arrangement]").getAttribute("aria-pressed"),
    "true",
    "and it shows which view is on",
  );
  assert.equal(
    ui.document.querySelector("[data-act=mode-session]").getAttribute("aria-pressed"),
    "false",
  );

  const strip = ui.document.querySelector("[data-role=bar-ruler]");
  strip.getBoundingClientRect = () => ({
    left: 0, top: 0, width: 320, height: 18, right: 320, bottom: 18,
  });
  strip.dispatchEvent(ui.event("pointerdown", { button: 0, clientX: 45 }));
  await ui.settle();
  ui.release();
  assert.deepEqual(ui.engine.seeks, [4], "a click on the ruler seeks the stopped transport to bar 5");
  assert.equal(
    ui.document.querySelector("[data-role=playhead]").style.left,
    "12.5%",
    "and the playhead sits on bar 5 of 32",
  );

  // The engine reports where it is playing; the playhead follows it.
  ui.position({ bar: 9, beat: 1, sixteenth: 1 });
  assert.equal(
    ui.document.querySelector("[data-role=playhead]").style.left,
    "25%",
    "a position frame moves the playhead to bar 9",
  );
  assert.equal(
    ui.document.querySelectorAll("[data-role=playhead]").length >= 3,
    true,
    "one playhead on the ruler and one across every lane",
  );
});

test("the mode switch keeps the choice per song", async () => {
  const storage = memoryStorage();
  const ui = await bootTimeline({ storage });

  assert.equal(
    ui.document.querySelector("[data-act=mode-session]").getAttribute("aria-pressed"),
    "true",
    "a song with no choice yet opens in Session",
  );
  ui.click("[data-act=mode-arrangement]");
  await ui.settle();

  assert.equal(storage.getItem("crow-studio-mode:song-1"), "arrangement", "the choice is kept for this song");
  assert.equal(ui.document.querySelector("[data-act=mode-arrangement]").getAttribute("aria-pressed"), "true");
  assert.equal(ui.document.querySelector("[data-role=timeline]").hidden, false, "the lanes are the view");
  assert.equal(ui.document.querySelector("[data-role=grid-wrap]").hidden, true, "and the grid is not");

  // A page opened again with that choice starts in Arrangement.
  const again = await bootTimeline({ storage });
  assert.equal(
    again.document.querySelector("[data-act=mode-arrangement]").getAttribute("aria-pressed"),
    "true",
    "the view this song was left in is the one it opens in",
  );
  assert.equal(again.document.querySelector("[data-role=timeline]").hidden, false);

  // A browser that refuses storage still switches; it just keeps nothing.
  const refusing = {
    getItem() {
      throw new Error("this browser keeps no storage");
    },
    setItem() {
      throw new Error("this browser keeps no storage");
    },
  };
  const third = await bootTimeline({ storage: refusing });
  third.click("[data-act=mode-arrangement]");
  await third.settle();
  assert.equal(
    third.document.querySelector("[data-role=timeline]").hidden,
    false,
    "the switch works without storage",
  );
});

// ---- the review's own cases ----------------------------------------------

test("a refused performance can still be placed", async () => {
  const ui = await bootTimeline();
  ui.click("[data-act=rec-timeline]");
  ui.click("[data-act=play]");
  await ui.settle(24);
  for (const bar of [0, 4, 8]) {
    ui.launch({ track_id: NOTE_TRACK, clip_id: NOTE_CLIP, scene_id: SCENE, bar, frame: bar * 96000 });
  }
  ui.position({ bar: 11, beat: 1, sixteenth: 1 });
  ui.click("[data-act=stop]");
  await ui.settle();

  const sent = commands(ui, "arrangement.record_performance");
  assert.equal(sent.length, 1, "Stop sent the performance");
  const cmdId = sent[0].cmd_id;
  assert.equal(typeof cmdId, "string", "under a cmd_id the page keeps");

  // The fixture already plays the note clip over bars 5 to 8, so the hub
  // refuses the whole performance.
  const refusal = 'Placement at bar 5 on "Bass" overlaps the one there.';
  ui.frame({ type: "result", cmd_id: cmdId, ok: false, error: refusal });
  await ui.settle();

  const notice = ui.document.querySelector("[data-role=performance-notice]");
  assert.ok(notice, "the page has somewhere to keep a refused performance");
  assert.equal(notice.hidden, false, "the refusal stays on the page, not in a toast");
  assert.ok(String(notice.textContent).includes(refusal), "with the server's own sentence");
  const fit = notice.querySelector("[data-act=performance-fit]");
  const discard = notice.querySelector("[data-act=performance-discard]");
  assert.ok(fit, "Place what fits is offered");
  assert.equal(String(fit.textContent), "Place what fits");
  assert.ok(discard, "Discard is offered");

  fit.dispatchEvent(ui.event("click", {}));
  await ui.settle();
  const again = commands(ui, "arrangement.record_performance");
  assert.equal(again.length, 2, "Place what fits is one more record_performance");
  assert.deepEqual(
    again[1].args.placements,
    [
      { track_id: NOTE_TRACK, clip_id: NOTE_CLIP, start_bar: 0, bars: 4 },
      { track_id: NOTE_TRACK, clip_id: NOTE_CLIP, start_bar: 8, bars: 2 },
    ],
    "only the bars nothing already plays, in bar order",
  );

  ui.frame({ type: "result", cmd_id: again[1].cmd_id, ok: true });
  await ui.settle();
  assert.equal(notice.hidden, true, "an accepted performance is dropped");

  // Discard drops a refused performance without sending anything else.
  const other = await bootTimeline();
  other.click("[data-act=rec-timeline]");
  other.click("[data-act=play]");
  await other.settle(24);
  other.launch({ track_id: NOTE_TRACK, clip_id: NOTE_CLIP, scene_id: SCENE, bar: 4, frame: 0 });
  other.position({ bar: 7, beat: 1, sixteenth: 1 });
  other.click("[data-act=stop]");
  await other.settle();
  const refused = commands(other, "arrangement.record_performance");
  assert.equal(refused.length, 1);
  other.frame({ type: "result", cmd_id: refused[0].cmd_id, ok: false, error: "It overlaps." });
  await other.settle();
  other.click("[data-act=performance-discard]");
  await other.settle();
  assert.equal(
    commands(other, "arrangement.record_performance").length,
    1,
    "Discard sends nothing more",
  );
  assert.equal(
    other.document.querySelector("[data-role=performance-notice]").hidden,
    true,
    "and the notice goes",
  );
});

test("stopping the transport another way closes the performance", async () => {
  const ui = await bootTimeline();
  ui.click("[data-act=rec-timeline]");
  ui.click("[data-act=play]");
  await ui.settle(24);
  ui.launch({ track_id: NOTE_TRACK, clip_id: NOTE_CLIP, scene_id: SCENE, bar: 0, frame: 0 });
  ui.launch({ track_id: NOTE_TRACK, clip_id: NOTE_CLIP, scene_id: SCENE, bar: 4, frame: 4 * 96000 });
  ui.position({ bar: 7, beat: 1, sixteenth: 1 });

  // A take on the audio track. Its input goes away, so the take ends by
  // itself — and that ends the transport, which is the other way to stop it.
  ui.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await ui.settle();
  ui.click("[data-act=record]");
  await ui.settle(24);
  const recorder = ui.engine.recorders[0];
  assert.ok(recorder, "Record built the recorder");
  assert.notEqual(recorder.armed, null, "and armed it on the next bar");

  recorder.done({ segments: [] });
  await ui.settle();

  const sent = commands(ui, "arrangement.record_performance");
  assert.equal(sent.length, 1, "the transport's stop wrote the performance");
  assert.deepEqual(
    sent[0].args.placements,
    [
      { track_id: NOTE_TRACK, clip_id: NOTE_CLIP, start_bar: 0, bars: 4 },
      { track_id: NOTE_TRACK, clip_id: NOTE_CLIP, start_bar: 4, bars: 2 },
    ],
    "each launch closed by the next one, the last by the stop bar",
  );
});

test("a cancelled drag sends nothing", async () => {
  const ui = await bootTimeline();
  ui.click("[data-act=mode-arrangement]");
  await ui.settle();

  const block = ui.document.querySelector(`[data-placement-id=${NOTE_PLACEMENT}]`);
  block.getBoundingClientRect = () => placementBox();
  block.dispatchEvent(ui.event("pointerdown", { button: 0, clientX: 20 }));
  await ui.settle();
  ui.fireWindow("pointermove", ui.event("pointermove", { clientX: 100 }));
  await ui.settle();
  assert.match(
    String(block.getAttribute("style")),
    /left:18\.75%/,
    "the drag has drawn the block two bars further on",
  );

  // The browser takes the pointer away instead of letting it go.
  ui.fireWindow("pointercancel", ui.event("pointercancel", {}));
  await ui.settle();

  assert.deepEqual(allCommands(ui), [], "a cancelled drag writes nothing");
  const again = ui.document.querySelector(`[data-placement-id=${NOTE_PLACEMENT}]`);
  assert.match(
    String(again.getAttribute("style")),
    /left:12\.5%/,
    "and the block is drawn where the song puts it",
  );
  assert.equal((ui.windowListeners.pointermove || []).length, 0, "the drag's listeners came off");
});

test("teardown during a drag leaves no listeners", async () => {
  const ui = await bootTimeline();
  ui.click("[data-act=mode-arrangement]");
  await ui.settle();

  const block = ui.document.querySelector(`[data-placement-id=${NOTE_PLACEMENT}]`);
  block.getBoundingClientRect = () => placementBox();
  block.dispatchEvent(ui.event("pointerdown", { button: 0, clientX: 20 }));
  await ui.settle();
  assert.ok((ui.windowListeners.pointermove || []).length > 0, "the drag listens on the window");

  // Turbo caches the page (or a visit starts): the session is torn down with
  // the drag still in the air.
  ui.document.dispatchEvent(ui.event("turbo:before-cache"));
  await ui.settle();

  for (const name of ["pointermove", "pointerup", "pointercancel"]) {
    assert.equal((ui.windowListeners[name] || []).length, 0, `no ${name} listener is left behind`);
  }
});

test("delete in the clip editor removes the note, not the placement", async () => {
  const ui = await bootTimeline();
  ui.click("[data-act=mode-arrangement]");
  await ui.settle();

  ui.click(`[data-placement-id=${NOTE_PLACEMENT}]`);
  await ui.settle();
  ui.click("[data-act=open-placement-clip]");
  await ui.settle();
  assert.match(
    String(ui.document.querySelector("[data-role=placement-bar]").textContent),
    /No placement selected/,
    "opening the clip lets go of the placement",
  );

  // A note is selected in the roll.
  const svg = ui.document.querySelector(".st-roll-svg");
  assert.ok(svg, "the note clip's piano roll is open");
  svg.getBoundingClientRect = () => rollBox();
  svg.dispatchEvent(ui.event("pointerdown", { button: 0, clientX: 60, clientY: 810 }));
  await ui.settle();
  ui.release({ clientX: 60, clientY: 810 });
  await ui.settle();
  const removeNote = ui.document.querySelector("[data-act=delete-note]");
  assert.equal(removeNote.disabled, false, "the note is selected");

  // The placement is selected as well now: Delete still means the note.
  ui.click(`[data-placement-id=${NOTE_PLACEMENT}]`);
  await ui.settle();
  ui.document.dispatchEvent(ui.event("keydown", { key: "Delete" }));
  await ui.settle();

  const edits = commands(ui, "clip.edit_notes");
  assert.equal(edits.length, 1, "Delete removed the note");
  assert.deepEqual(edits[0].args.remove, [0]);
  assert.equal(commands(ui, "arrangement.remove").length, 0, "and left the placement alone");
});

test("an agent moving your placement keeps it outlined as yours", async () => {
  const at = "2026-03-01T10:00:00.000Z";
  const ui = await bootTimeline({
    history: [
      {
        id: "h-place",
        seq: 1,
        created_at: at,
        summary: "Placed a clip on Bass",
        author: { kind: "human", id: "local", label: "You" },
        touched: [`placement:${NOTE_PLACEMENT}`],
      },
      {
        id: "h-move",
        seq: 2,
        created_at: at,
        summary: "Moved a placement on Bass",
        author: { kind: "agent", id: "agent:mcp", label: "Agent (MCP)" },
        touched: [`placement:${NOTE_PLACEMENT}`],
      },
    ],
  });
  ui.click("[data-act=mode-arrangement]");
  await ui.settle();

  const block = ui.document.querySelector(`[data-placement-id=${NOTE_PLACEMENT}]`);
  assert.ok(block, "the placement is drawn");
  assert.match(
    String(block.getAttribute("style")),
    /(242|f2a541)/i,
    "outlined in the operator's amber, not the agent's blue",
  );
  assert.match(String(block.textContent), /by you/, "and it says who placed it");

  ui.click(`[data-placement-id=${NOTE_PLACEMENT}]`);
  await ui.settle();
  assert.match(
    String(ui.document.querySelector("[data-role=placement-bar]").textContent),
    /placed by you/,
    "the placement bar says the same",
  );
});

test("arrow keys keep focus on the placement", async () => {
  const ui = await bootTimeline();
  ui.click("[data-act=mode-arrangement]");
  await ui.settle();

  const block = ui.document.querySelector(`[data-placement-id=${NOTE_PLACEMENT}]`);
  block.getBoundingClientRect = () => placementBox();
  block.dispatchEvent(ui.event("pointerdown", { button: 0, clientX: 20 }));
  await ui.settle();
  ui.release({ clientX: 20 });
  await ui.settle();
  assert.equal(ui.focusCalls.length > 0, true, "pressing a block gives it the keyboard");
  assert.equal(
    ui.focusCalls[ui.focusCalls.length - 1].getAttribute("data-placement-id"),
    NOTE_PLACEMENT,
    "on the block that was pressed",
  );

  ui.document.dispatchEvent(ui.event("keydown", { key: "ArrowRight" }));
  await ui.settle();
  const moved = commands(ui, "arrangement.move");
  assert.equal(moved.length, 1, "the arrow key moved the selected placement");
  assert.equal(moved[0].args.start_bar, 5);

  // The hub's answer draws every block again; the keyboard goes back on the
  // button that carries the same data-placement-id.
  const { encodeDocState } = await import("../bundles/studio/server/doc.js");
  ui.frame({
    type: "state",
    update: Buffer.from(encodeDocState(ui.doc)).toString("base64"),
    history: [],
    presence: [],
  });
  await ui.settle();

  const focused = ui.focusCalls[ui.focusCalls.length - 1];
  assert.equal(focused.getAttribute("data-placement-id"), NOTE_PLACEMENT, "the keyboard stayed on the placement");
  assert.equal(
    [...ui.document.querySelectorAll("[data-placement-id]")].includes(focused),
    true,
    "and on the button the page draws now, not the one it threw away",
  );
});

test("recording on the timeline picks a free scene slot", async () => {
  const doc = await timelineDoc();
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  runCommand(doc, "scene.add", { id: "chorus", name: "Chorus" });

  const ui = await bootTimeline({ doc });
  ui.click("[data-act=mode-arrangement]");
  await ui.settle();
  ui.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await ui.settle();
  ui.click("[data-act=record]");
  await ui.settle(24);

  const added = commands(ui, "clip.add_audio");
  assert.equal(added.length, 1, "the recording made its clip");
  assert.equal(added[0].args.track_id, AUDIO_TRACK);
  assert.equal(added[0].args.scene_id, "chorus", "in the first scene whose slot on that track is empty");
  assert.equal(added[0].args.length_bars, 4, "four bars, the empty scene's length");
  assert.equal(commands(ui, "arrangement.place").length, 1, "and it is placed at the playhead");
  assert.notEqual(ui.engine.recorders[0].armed, null, "the take is armed on the next bar");

  // The fixture song has one scene and both its slots are full: there is
  // nowhere for a clip, so nothing is written and nothing is armed.
  const blocked = await bootTimeline();
  blocked.click("[data-act=mode-arrangement]");
  await blocked.settle();
  blocked.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await blocked.settle();
  blocked.click("[data-act=record]");
  await blocked.settle(24);

  assert.equal(commands(blocked, "clip.add_audio").length, 0, "no clip was written");
  assert.equal(commands(blocked, "arrangement.place").length, 0, "and nothing was placed");
  assert.equal(blocked.engine.recorders.length, 1, "the recorder was built");
  assert.equal(blocked.engine.recorders[0].armed, null, "but the take was not armed");
  const toast = blocked.document.querySelector("[data-role=toast]");
  assert.equal(toast.hidden, false, "the page says why");
  assert.equal(
    toast.textContent,
    "There is no free scene slot on this track for a new recording; add a scene first.",
    "word for word",
  );
});

test("session view places a clip at bar 1 and the timeline keeps its playhead", async () => {
  const ui = await bootTimeline();
  ui.click(`[data-act=open-clip][data-clip-id=${NOTE_CLIP}]`);
  await ui.settle();

  const place = ui.document.querySelector("[data-act=place-on-timeline]");
  assert.ok(place, "the clip editor offers the keyboard path onto the timeline");
  assert.equal(
    place.getAttribute("title"),
    "Place this clip on its track at bar 1",
    "Session view has no playhead, and the button says so",
  );

  ui.click("[data-act=place-on-timeline]");
  await ui.settle();
  const sent = commands(ui, "arrangement.place");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].args.start_bar, 0, "bar 1 is start bar 0");
  assert.equal(ui.document.querySelector("[data-role=timeline]").hidden, false, "and the timeline opens");

  // A click on the ruler seeks; pressing Arrangement again keeps that bar.
  const strip = ui.document.querySelector("[data-role=bar-ruler]");
  strip.getBoundingClientRect = () => ({
    left: 0, top: 0, width: 320, height: 18, right: 320, bottom: 18,
  });
  strip.dispatchEvent(ui.event("pointerdown", { button: 0, clientX: 45 }));
  await ui.settle();
  ui.release();
  assert.equal(ui.document.querySelector("[data-role=playhead]").style.left, "12.5%");

  ui.click("[data-act=mode-arrangement]");
  await ui.settle();
  assert.equal(
    ui.document.querySelector("[data-role=playhead]").style.left,
    "12.5%",
    "pressing Arrangement while it is the view keeps the playhead where it was",
  );

  ui.click(`[data-act=open-clip][data-clip-id=${NOTE_CLIP}]`);
  await ui.settle();
  assert.equal(
    ui.document.querySelector("[data-act=place-on-timeline]").getAttribute("title"),
    "Place this clip on its track at the playhead bar",
    "from the timeline the button names the playhead's bar",
  );
});

test("Add to timeline is in the clip editor header and in the sampler header", async () => {
  const ui = await bootTimeline();
  ui.click(`[data-act=open-clip][data-clip-id=${NOTE_CLIP}]`);
  await ui.settle();

  const add = ui.document.querySelector("[data-role=editor] [data-act=place-on-timeline]");
  assert.ok(add, "the clip editor's header offers it");
  assert.equal(String(add.textContent), "Add to timeline", "named for what it does");

  ui.click("[data-role=editor] [data-act=place-on-timeline]");
  await ui.settle();
  const sent = commands(ui, "arrangement.place");
  assert.equal(sent.length, 1, "pressing it places the clip once");
  assert.equal(sent[0].args.track_id, NOTE_TRACK, "on the clip's own track");
  assert.equal(sent[0].args.start_bar, 0, "at bar 1 from Session view, which has no playhead");
  assert.equal(
    ui.document.querySelector("[data-role=timeline]").hidden,
    false,
    "and the timeline is what the page shows",
  );
  // The page says where it went once the hub has taken it.
  ui.frame({ type: "result", cmd_id: sent[0].cmd_id, ok: true });
  await ui.settle();
  assert.equal(
    ui.document.querySelector("[data-role=toast]").textContent,
    "Placed on Bass at bar 1",
    "and the toast says where it went",
  );

  // A pattern clip's own view carries the same button.
  const pattern = await bootTimeline({ doc: await patternDoc() });
  pattern.click(`[data-act=open-clip][data-clip-id=${PATTERN_CLIP}]`);
  await pattern.settle();
  const inSampler = pattern.document.querySelector("[data-role=sampler] [data-act=place-on-timeline]");
  assert.ok(inSampler, "the pad-and-steps view offers it too");
  assert.equal(String(inSampler.textContent), "Add to timeline", "under the same name");

  pattern.click("[data-role=sampler] [data-act=place-on-timeline]");
  await pattern.settle();
  const placed = commands(pattern, "arrangement.place");
  assert.equal(placed.length, 1, "pressing it places the pattern clip once");
  assert.equal(placed[0].args.clip_id, PATTERN_CLIP, "the clip it was pressed on");
  assert.equal(placed[0].args.track_id, PATTERN_TRACK, "on its own track");
  assert.equal(
    pattern.document.querySelector("[data-role=timeline]").hidden,
    false,
    "and the timeline is the view",
  );
  pattern.frame({ type: "result", cmd_id: placed[0].cmd_id, ok: true });
  await pattern.settle();
  assert.equal(
    pattern.document.querySelector("[data-role=toast]").textContent,
    "Placed on Drums at bar 1",
    "with the toast naming the lane",
  );
});

test("the empty timeline says how a first placement is made", async () => {
  const ui = await bootTimeline({ doc: await unplacedDoc() });
  ui.click("[data-act=mode-arrangement]");
  await ui.settle();

  const note = ui.document.querySelector("[data-role=timeline-empty]");
  assert.ok(note, "the empty timeline has something to say");
  assert.equal(
    note.textContent,
    "Drag a clip up here, or press Add to timeline on a clip.",
    "the two ways a first placement is made",
  );
});

test("a marker and a section are renamed and removed from their own buttons", async () => {
  const ui = await bootTimeline();
  ui.click("[data-act=mode-arrangement]");
  await ui.settle();

  const rename = ui.document.querySelector(
    "[data-role=marker][data-marker-id=m-key] [data-act=marker-rename]",
  );
  assert.ok(rename, "the marker's name is a button, so the keyboard can reach it");
  assert.equal(String(rename.tagName), "BUTTON");

  ui.window.prompt = () => "Turnaround";
  rename.dispatchEvent(ui.event("click", {}));
  await ui.settle();
  const renamed = commands(ui, "marker.rename");
  assert.equal(renamed.length, 1, "the marker's button renamed it");
  assert.deepEqual(renamed[0].args, { id: "m-key", name: "Turnaround" });

  ui.click("[data-role=marker][data-marker-id=m-key] [data-act=marker-remove]");
  await ui.settle();
  const removed = commands(ui, "marker.remove");
  assert.equal(removed.length, 1, "its remove button asked marker.remove, after a yes");
  assert.deepEqual(removed[0].args, { id: "m-key" });

  const section = ui.document.querySelector(
    "[data-role=section][data-section-id=sec-intro] [data-act=section-rename]",
  );
  assert.ok(section, "the section's name is a button too");
  ui.click("[data-role=section][data-section-id=sec-intro] [data-act=section-remove]");
  await ui.settle();
  const gone = commands(ui, "section.remove");
  assert.equal(gone.length, 1, "and it can be removed");
  assert.deepEqual(gone[0].args, { id: "sec-intro" });
});

/** @returns {object[]} the count-in `play` calls the page sent */
function countInPlays(ui) {
  return ui.engine.playCalls.filter((options) => options && options.countInBars);
}

/**
 * The fixture song with the audio clip's placement moved to a bar, so a take
 * recorded from the timeline has a placement under the playhead to record into.
 * @param {number} startBar the bar the placement begins on
 * @returns {Promise<import("yjs").Doc>}
 */
async function placedDoc(startBar) {
  const doc = await timelineDoc();
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  runCommand(doc, "arrangement.remove", { id: AUDIO_PLACEMENT });
  runCommand(doc, "arrangement.place", {
    id: AUDIO_PLACEMENT,
    track_id: AUDIO_TRACK,
    clip_id: AUDIO_CLIP,
    start_bar: startBar,
    bars: 4,
  });
  return doc;
}

/**
 * The fixture song with a placement that covers the first four bars, so a split
 * has something under the playhead, and a second scene, so a recording made
 * from the timeline has a free slot for its clip.
 * @returns {Promise<import("yjs").Doc>}
 */
async function coverDoc() {
  const doc = await timelineDoc();
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  runCommand(doc, "arrangement.remove", { id: NOTE_PLACEMENT });
  runCommand(doc, "arrangement.place", {
    id: NOTE_PLACEMENT,
    track_id: NOTE_TRACK,
    clip_id: NOTE_CLIP,
    start_bar: 0,
    bars: 4,
  });
  runCommand(doc, "scene.add", { id: "chorus", name: "Chorus" });
  return doc;
}

/** One lane's bar for bar N of 32, as the percentage the page draws. */
function barLeft(n) {
  return String(Math.round((n / 32) * 100 * 1000) / 1000) + "%";
}

// ---- the playhead, the cut bar and Pause --------------------------------

test("floorBar(2.75) is 2 and floorBar(3) is 3", async () => {
  const ui = await bootTimeline();
  ui.click("[data-act=mode-arrangement]");
  await ui.settle();
  ui.click("[data-act=play]");
  await ui.settle(24);

  // Bar 3 beat 4 is two and three quarter bars: the playhead stands inside
  // bar 3, on the line of bar 2 -- bar 3 to the operator.
  ui.position({ bar: 3, beat: 4, sixteenth: 1 });
  const cuts = [...ui.document.querySelectorAll("[data-role=cut-mark]")];
  assert.ok(cuts.length >= 3, "the cut mark is on the ruler and on every lane");
  for (const mark of cuts) {
    assert.equal(mark.classList.contains("st-cut-mark"), true, "it wears the cut mark's class");
    assert.equal(mark.style.left, barLeft(2), "and stands on bar 2 of 32");
  }
  assert.equal(
    ui.document.querySelector("[data-act=split]").textContent,
    "Split at bar 3",
    "the button names the bar it would cut",
  );
  assert.equal(
    commands(ui, "arrangement.split").length,
    0,
    "and nothing has been cut: the mark and the label are there before any press",
  );

  // A playhead exactly on a bar line is that bar, not the one before.
  ui.position({ bar: 4, beat: 1, sixteenth: 1 });
  assert.equal(
    ui.document.querySelector("[data-role=cut-mark]").style.left,
    barLeft(3),
    "a playhead on a bar line stands on that line",
  );
  assert.equal(
    ui.document.querySelector("[data-act=split]").textContent,
    "Split at bar 4",
    "which the button names too",
  );
});

test("Split, Add to timeline, marker add and Record to timeline send whole bars", async () => {
  const ui = await bootTimeline({ doc: await coverDoc() });
  ui.click("[data-act=mode-arrangement]");
  await ui.settle();
  ui.click("[data-act=play]");
  await ui.settle(24);
  // Two and three quarter bars: the bar line at or before it is bar 2.
  ui.position({ bar: 3, beat: 4, sixteenth: 1 });

  // Split at playhead.
  ui.click("[data-act=split]");
  await ui.settle();
  const split = commands(ui, "arrangement.split");
  assert.equal(split.length, 1, "the split went out");
  assert.equal(Number.isInteger(split[0].args.at_bar), true, "at_bar is a whole bar");
  assert.equal(split[0].args.at_bar, 2, "the bar line the playhead stands on");

  // Add to timeline, from the clip's own editor.
  ui.click(`[data-act=open-clip][data-clip-id=${NOTE_CLIP}]`);
  await ui.settle();
  ui.click("[data-role=editor] [data-act=place-on-timeline]");
  await ui.settle();

  // A marker added on the marker row, inside the same bar.
  const row = ui.document.querySelector("[data-role=marker-row]");
  assert.ok(row, "the ruler draws the marker row");
  row.getBoundingClientRect = () => ({
    left: 0, top: 0, width: 320, height: 18, right: 320, bottom: 18, x: 0, y: 0,
  });
  row.dispatchEvent(ui.event("click", { clientX: 27.5 }));
  await ui.settle();

  // Record to timeline: with the playhead here and an armed audio track, the
  // recording starts its new clip and its placement on this bar.
  ui.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await ui.settle();
  ui.click("[data-act=record]");
  await ui.settle(24);

  const placed = commands(ui, "arrangement.place");
  assert.equal(placed.length, 2, "Add to timeline placed one, and the recording placed its own");
  for (const message of placed) {
    assert.equal(Number.isInteger(message.args.start_bar), true, "every start_bar is a whole bar");
    assert.equal(message.args.start_bar, 2, "on the bar line the playhead stands on");
  }
  const marker = commands(ui, "marker.add");
  assert.equal(marker.length, 1, "the marker went out");
  assert.equal(Number.isInteger(marker[0].args.bar), true, "on a whole bar");
  assert.equal(marker[0].args.bar, 2, "the bar the cut mark stands on");
});

test("a take armed on a fractional playhead starts on the floor bar", async () => {
  const ui = await bootTimeline({ doc: await coverDoc() });
  // Play and Stop first: the engine exists, so a position frame reaches the page.
  ui.click("[data-act=mode-arrangement]");
  await ui.settle();
  ui.click("[data-act=play]");
  await ui.settle(24);
  ui.click("[data-act=stop]");
  await ui.settle();

  // Two and three quarter bars: the playhead stands inside bar 3, on the line
  // of bar 2, which is where the take's placement goes.
  ui.position({ bar: 3, beat: 4, sixteenth: 1 });
  assert.equal(
    ui.document.querySelector("[data-role=playhead]").style.left,
    barLeft(2.75),
    "the playhead is where the position frame put it, a beat into the bar",
  );

  ui.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await ui.settle();
  ui.click("[data-act=record]");
  await ui.settle(24);

  assert.deepEqual(ui.engine.seeks, [2], "the engine was moved to the bar the take's placement is on");
  assert.equal(
    ui.document.querySelector("[data-role=playhead]").style.left,
    barLeft(2),
    "and the page's playhead stands on that same bar",
  );
  const placed = commands(ui, "arrangement.place");
  assert.equal(placed.length, 1, "the new clip's placement went out");
  assert.equal(placed[0].args.start_bar, 2, "on the floor bar");
  const recorder = ui.engine.recorders[0];
  assert.ok(recorder, "the recorder was built");
  assert.equal(recorder.armed, 48000, "and armed on the frame the engine reports from that bar");
});

// ---- recording in the arrangement view (R17) ------------------------------
//
// The plan view records into the placement under the playhead: its clip, and
// the bar that placement begins on, so the take's beat 0 is the clip's beat 0.
// Stopped, the count-in plays the plan from that bar and the take begins on the
// frame the engine announces; a running transport keeps the bar it is playing
// and arms on the next bar line, which is the limit the last case pins.

test("today: arrangement record arms on nextBarFrame and ignores launch reports", async () => {
  const ui = await bootTimeline({ doc: await placedDoc(0) });
  ui.click("[data-act=mode-arrangement]");
  await ui.settle();
  ui.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await ui.settle();

  // A launch report, of the kind the Session view's sequencer posts. The plan
  // plays by itself and launches no scene, so the frame it names has nothing to
  // do with where this take begins.
  ui.launch({ track_id: AUDIO_TRACK, clip_id: AUDIO_CLIP, scene_id: SCENE, bar: 0, frame: 24000 });
  await ui.settle();

  ui.engine.nextBarFrame = async () => ({ frame: 96000, bar: 2 });
  ui.click("[data-act=record]");
  await ui.settle(24);

  const recorder = ui.engine.recorders[0];
  assert.ok(recorder, "Record built the recorder");
  assert.equal(recorder.armed, 96000, "the take armed on the bar frame the engine named");
  assert.notEqual(recorder.armed, 24000, "not on the frame a launch report named");
  assert.equal(ui.engine.plays, 0, "and the page started no transport of its own");

  // A launch report that arrives once the take is armed changes nothing.
  ui.launch({ track_id: AUDIO_TRACK, clip_id: AUDIO_CLIP, scene_id: SCENE, bar: 0, frame: 48000 });
  await ui.settle();
  assert.equal(recorder.armed, 96000, "a launch report never re-anchors an armed take");
});

test("today: arrangement record while playing arms on the next bar", async () => {
  const ui = await bootTimeline({ doc: await placedDoc(3) });
  ui.click("[data-act=mode-arrangement]");
  await ui.settle();
  // The transport runs, and the playhead stands two bars inside the placement
  // that begins on bar 3.
  ui.click("[data-act=play]");
  await ui.settle(24);
  ui.position({ bar: 5, beat: 1, sixteenth: 1 });
  ui.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await ui.settle();

  ui.engine.nextBarFrame = async () => ({ frame: 240000, bar: 6 });
  ui.click("[data-act=record]");
  await ui.settle(24);

  const recorder = ui.engine.recorders[0];
  assert.ok(recorder, "Record built the recorder");
  assert.equal(recorder.armed, 240000, "the take armed on the bar line the engine named");
  assert.deepEqual(ui.engine.seeks, [], "a running transport is not moved to the placement's bar");
  assert.equal(
    ui.document.querySelector("[data-role=playhead]").style.left,
    barLeft(4),
    "the playhead keeps the bar it was playing, one bar into the placement",
  );
  assert.notEqual(
    ui.document.querySelector("[data-role=playhead]").style.left,
    barLeft(3),
    "so the take's beat 0 is not the clip's beat 0 while the plan runs",
  );
});

test("R17: arrangement record from stopped with a playhead inside a placement seeks to the placement start, counts in, and arms on the announced play_frame", async () => {
  const ui = await bootTimeline({ doc: await placedDoc(3), storage: countInStorage(1), clock: 0.5 });
  ui.click("[data-act=mode-arrangement]");
  await ui.settle();
  // 55 px of a 32-bar, 320 px ruler is bar 5: two bars into the placement.
  const strip = stubRuler(ui);
  rulerPress(ui, strip, 55);
  await ui.settle();
  ui.release();
  await ui.settle();
  assert.deepEqual(ui.engine.seeks, [5], "the ruler put the playhead on bar 5");

  ui.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await ui.settle();
  ui.engine.seeks.length = 0;
  ui.click("[data-act=record]");
  await ui.settle(24);

  assert.deepEqual(ui.engine.seeks, [3], "the placement begins on bar 3, and the engine was moved there");
  assert.equal(
    ui.document.querySelector("[data-role=playhead]").style.left,
    barLeft(3),
    "and the page's playhead stands where the take begins",
  );
  assert.equal(countInPlays(ui).length, 1, "the count-in was asked for");
  assert.equal(countInPlays(ui)[0].countInBars, 1, "one bar of it");
  assert.deepEqual(ui.engine.launched, [], "the plan launches no scene, so nothing was queued");

  const recorder = ui.engine.recorders[0];
  assert.ok(recorder, "Record built the recorder");
  assert.equal(recorder.armed, null, "nothing is armed while the clicks run");

  ui.engine.countBar(1, 192000, 24000);
  await ui.settle(24);

  assert.equal(recorder.armed, 192000, "the recorder armed on the frame the count-in announced");
  assert.ok(
    recorder.armed >= recorder.armNow,
    `a frame the engine had not rendered when it was sent (${recorder.armed} vs ${recorder.armNow})`,
  );
  assert.equal(
    ui.document.querySelector("[data-role=rec-status]").textContent,
    "Recording, pass 1",
    "the take is recording from the bar its placement begins on",
  );
});

test("R17: the arrangement take of a placement started at bar 3 has take beat 0 at the placement's clip beat 0", async () => {
  const ui = await bootTimeline({ doc: await placedDoc(3), storage: countInStorage(1) });
  ui.click("[data-act=mode-arrangement]");
  await ui.settle();
  const strip = stubRuler(ui);
  rulerPress(ui, strip, 55);
  await ui.settle();
  ui.release();
  await ui.settle();
  ui.engine.seeks.length = 0;

  ui.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await ui.settle();
  ui.click("[data-act=record]");
  await ui.settle(24);
  ui.engine.countBar(1, 192000, 24000);
  await ui.settle(24);

  assert.deepEqual(ui.engine.seeks, [3], "the plan plays from the bar the placement begins on");
  const recorder = ui.engine.recorders[0];
  assert.equal(recorder.armed, 192000, "the take begins on that bar's frame, the count-in's play_frame");
  // One bar at 120 BPM is 96,000 frames: the clip's own length, from the
  // placement's first frame, so take beat 0 lands on clip beat 0.
  const clipFrames = Math.round(4 * ((48000 * 60) / 120));
  assert.equal(recorder.splits[0] - recorder.armed, clipFrames, "its first pass is exactly one clip long");
  assert.equal(
    ui.page.__studioTest.view.rec.clip_id,
    AUDIO_CLIP,
    "the take records into the placement's clip",
  );
  assert.equal(ui.page.__studioTest.view.rec.length_bars, 1, "whose length is one bar");
  assert.equal(commands(ui, "clip.add_audio").length, 0, "no clip was added for it");
  assert.equal(commands(ui, "arrangement.place").length, 0, "and the plan was not written into");
});

test("R17: arrangement record with count-in Off arms on nextBarFrame as today", async () => {
  // The rig's storage holds the count-in Off, which is the path a timeline take
  // has always had (R4).
  const ui = await bootTimeline({ doc: await placedDoc(0) });
  ui.click("[data-act=mode-arrangement]");
  await ui.settle();
  ui.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await ui.settle();
  ui.click("[data-act=record]");
  await ui.settle(24);

  assert.equal(countInPlays(ui).length, 0, "Off sends no count-in play");
  assert.deepEqual(ui.engine.seeks, [], "the playhead already stood on the placement's first bar");
  assert.equal(ui.engine.playCalls.length, 0, "and no play was sent");
  const recorder = ui.engine.recorders[0];
  assert.equal(recorder.armed, 48000, "the take armed on the frame the engine's bar answer named");
  assert.equal(ui.page.__studioTest.view.rec.clip_id, AUDIO_CLIP, "into the placement's clip");
  assert.equal(commands(ui, "clip.add_audio").length, 0, "which was not replaced");
});

test("R17: the count-in is not in the take", async () => {
  const ui = await bootTimeline({ doc: await placedDoc(0), storage: countInStorage(2), clock: 0.5 });
  ui.click("[data-act=mode-arrangement]");
  await ui.settle();
  ui.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await ui.settle();
  ui.click("[data-act=record]");
  await ui.settle(24);

  assert.equal(countInPlays(ui)[0].countInBars, 2, "two bars were asked for");
  const beatFrames = 24000;
  const playFrame = 384000;
  ui.engine.countBar(2, playFrame, beatFrames);
  await ui.settle(24);

  const recorder = ui.engine.recorders[0];
  assert.equal(recorder.armed, playFrame, "the take begins on the downbeat");
  assert.ok(recorder.armed >= recorder.armNow, "a frame still ahead when the arm was sent");
  // Eight clicks stood before it, the first of them eight beats earlier: none
  // of them is inside the take.
  assert.ok(recorder.armed > playFrame - 8 * beatFrames, "every click stands before the take's first frame");
  assert.equal(
    recorder.splits[0],
    playFrame + Math.round(4 * ((48000 * 60) / 120)),
    "and the first pass is one clip, counted from the downbeat",
  );

  recorder.chunk(new Uint8Array(64).buffer, 0, 0);
  await ui.settle(24);
  const rows = Array.from(ui.store.pendings.values());
  assert.equal(rows.length, 1, "the take is on this device");
  assert.equal(rows[0].clip_id, AUDIO_CLIP, "in the placement's own clip");
});

test("R17: a new clip is written when an arrangement count-in arms, not when it starts", async () => {
  // Nothing under the playhead: this take gets a new clip, and the placement that
  // puts it on the timeline. Neither is written before the take is armed, so a
  // count-in that is cancelled leaves the song exactly as it was (R7).
  const cancelled = await bootTimeline({ doc: await coverDoc(), storage: countInStorage(1) });
  cancelled.click("[data-act=mode-arrangement]");
  await cancelled.settle();
  cancelled.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await cancelled.settle();
  cancelled.click("[data-act=record]");
  await cancelled.settle(24);
  assert.equal(countInPlays(cancelled).length, 1, "the count-in began");
  assert.equal(commands(cancelled, "clip.add_audio").length, 0, "and nothing was written for the take yet");
  assert.equal(commands(cancelled, "arrangement.place").length, 0, "no clip and no placement");

  cancelled.click("[data-act=stop]");
  await cancelled.settle(24);
  assert.equal(commands(cancelled, "clip.add_audio").length, 0, "a cancelled count-in leaves no clip behind");
  assert.equal(commands(cancelled, "arrangement.place").length, 0, "and nothing placed");
  assert.equal(cancelled.store.pendings.size, 0, "and no take row");

  // The same take, counted all the way in: the clip and its placement are
  // written at the arm, on the bar the count-in plays from.
  const armed = await bootTimeline({ doc: await coverDoc(), storage: countInStorage(1) });
  armed.click("[data-act=mode-arrangement]");
  await armed.settle();
  armed.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await armed.settle();
  armed.click("[data-act=record]");
  await armed.settle(24);
  armed.engine.countBar(1, 192000, 24000);
  await armed.settle(24);

  assert.equal(armed.engine.recorders[0].armed, 192000, "the take armed on the announced frame");
  const added = commands(armed, "clip.add_audio");
  assert.equal(added.length, 1, "the new clip is written now");
  assert.equal(added[0].args.scene_id, "chorus", "in the first scene whose slot on that track is empty");
  assert.equal(added[0].args.length_bars, 4, "four bars long");
  const placedNow = commands(armed, "arrangement.place");
  assert.equal(placedNow.length, 1, "with the placement that puts it on the timeline");
  assert.equal(placedNow[0].args.clip_id, added[0].args.clip_id, "the clip it was made with");
  assert.equal(placedNow[0].args.start_bar, 0, "on the bar the playhead stands on");
});

test("R17: Stop during an arrangement count-in cancels and leaves the engine stopped", async () => {
  const ui = await bootTimeline({ doc: await placedDoc(0), storage: countInStorage(1) });
  ui.click("[data-act=mode-arrangement]");
  await ui.settle();
  ui.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await ui.settle();
  ui.click("[data-act=record]");
  await ui.settle(24);
  assert.equal(countInPlays(ui).length, 1, "the count-in had begun");

  // One of its four beats has clicked: nothing is armed yet.
  ui.engine.countIn({ type: "count_in_start", play_frame: 192000 });
  ui.engine.countIn({ type: "count_in", beat: 1, beats: 4, frame: 96000, play_frame: 192000 });
  await ui.settle();
  assert.equal(ui.engine.recorders[0].armed, null, "nothing is armed while the clicks run");
  assert.equal(ui.document.querySelector("[data-act=pause]").disabled, false, "Pause is offered while counting");

  ui.click("[data-act=stop]");
  await ui.settle(24);

  assert.equal(ui.engine.cancels, 1, "the count-in was cancelled");
  assert.ok(ui.engine.stops > 0, "and the transport was stopped");
  assert.equal(ui.page.__studioTest.view.rec, null, "no take is left armed");
  assert.equal(ui.page.__studioTest.view.playing, false, "and nothing runs by itself");
  assert.equal(ui.document.querySelector("[data-role=rec-status]").hidden, true, "the status is gone");
  assert.equal(ui.store.pendings.size, 0, "no take row was made");
  assert.equal(commands(ui, "clip.add_audio").length, 0, "and no clip was made");
  assert.equal(commands(ui, "arrangement.place").length, 0, "and nothing was placed");
  assert.match(
    String(ui.document.querySelector("[data-role=rec-notice]").textContent),
    /Count-in cancelled/,
    "the page says the count-in was cancelled",
  );
});

test("the ruler seeks in Arrangement; the Session view does not seek", async () => {
  const ui = await bootTimeline();
  ui.click("[data-act=mode-arrangement]");
  await ui.settle();
  const strip = stubRuler(ui);

  // 65 px of a 32-bar, 320 px ruler is six and a half bars.
  rulerPress(ui, strip, 65);
  await ui.settle();
  ui.release();
  assert.deepEqual(ui.engine.seeks, [6], "a click seeks the bar under it");
  assert.equal(Number.isInteger(ui.engine.seeks[0] * 4), true, "a whole number of beats");
  assert.equal(
    ui.document.querySelector("[data-role=playhead]").style.left,
    barLeft(6),
    "and the playhead is drawn there",
  );

  // The Session view has no ruler, and the one this page still holds seeks
  // nothing: a session transport is not the timeline's.
  ui.click("[data-act=mode-session]");
  await ui.settle();
  assert.equal(ui.document.querySelector("[data-role=bar-ruler]"), null, "Session draws no ruler");
  rulerPress(ui, strip, 45);
  await ui.settle();
  ui.release();
  assert.deepEqual(ui.engine.seeks, [6], "and a press on the one it held seeks nothing");
});

test("the playhead can be dragged; one seek per pointermove, last position wins", async () => {
  const ui = await bootTimeline();
  ui.click("[data-act=mode-arrangement]");
  await ui.settle();
  const strip = stubRuler(ui);

  rulerPress(ui, strip, 65);
  await ui.settle();
  assert.deepEqual(ui.engine.seeks, [6], "the press seeks the bar under it");

  // 67.5, 70 and 72.5 px are six and three quarters, seven, and seven and a
  // quarter bars: a drag reads the ruler in beats.
  for (const clientX of [67.5, 70, 72.5]) {
    ui.fireWindow("pointermove", ui.event("pointermove", { clientX }));
  }
  await ui.settle();
  assert.deepEqual(ui.engine.seeks.slice(1), [6.75, 7, 7.25], "one seek per move, at beat resolution");
  assert.equal(ui.engine.seeks[ui.engine.seeks.length - 1], 7.25, "the last position is the one that stays");
  assert.equal(
    ui.document.querySelector("[data-role=playhead]").style.left,
    barLeft(7.25),
    "and the playhead was drawn there",
  );

  ui.release();
  await ui.settle();
  assert.equal((ui.windowListeners.pointermove || []).length, 0, "the drag's listeners came off");
});

test("seek is allowed while playing and while paused in Arrangement", async () => {
  const ui = await bootTimeline();
  ui.click("[data-act=mode-arrangement]");
  await ui.settle();
  const strip = stubRuler(ui);
  ui.click("[data-act=play]");
  await ui.settle(24);
  assert.equal(ui.engine.plays, 1, "the transport is running");

  rulerPress(ui, strip, 65);
  await ui.settle();
  ui.release();
  assert.deepEqual(ui.engine.seeks, [6], "a running transport jumps to the bar");
  assert.equal(ui.engine.pauses, 0, "and plays on: nothing paused it");
  assert.equal(ui.engine.stops, 0, "and nothing stopped it");
  assert.equal(ui.document.querySelector("[data-role=toast]").hidden, true, "no refusal is said");

  // Paused: a seek moves the paused transport, and the readout says where the
  // next Play starts.
  ui.position({ bar: 3, beat: 2, sixteenth: 1 });
  ui.click("[data-act=pause]");
  await ui.settle();
  assert.equal(ui.engine.pauses, 1, "Pause paused the transport");
  assert.equal(
    ui.document.querySelector("[data-role=position]").textContent,
    "003.2.1",
    "the readout kept the position it was paused at",
  );

  rulerPress(ui, strip, 45);
  await ui.settle();
  ui.release();
  assert.equal(ui.engine.seeks[ui.engine.seeks.length - 1], 4, "the paused transport was moved to the bar");
  assert.equal(
    ui.document.querySelector("[data-role=position]").textContent,
    "005.1.1",
    "and the readout moved with it",
  );
});

test("Pause calls engine.pause, keeps the position, and Play carries on", async () => {
  const ui = await bootTimeline();
  const pause = ui.document.querySelector("[data-act=pause]");
  assert.ok(pause, "the transport carries a Pause button");
  assert.equal(pause.getAttribute("title"), "Pause");
  assert.equal(pause.getAttribute("aria-label"), "Pause");

  ui.click("[data-act=play]");
  await ui.settle(24);
  ui.position({ bar: 7, beat: 3, sixteenth: 2 });
  assert.equal(ui.document.querySelector("[data-role=position]").textContent, "007.3.2");

  ui.click("[data-act=pause]");
  await ui.settle();
  assert.equal(ui.engine.pauses, 1, "Pause is the engine's own pause");
  assert.equal(ui.engine.stops, 0, "and nothing was stopped");
  assert.equal(ui.engine.plays, 1, "and the transport was not restarted");
  assert.equal(
    ui.document.querySelector("[data-role=position]").textContent,
    "007.3.2",
    "the position stays on the page",
  );
  assert.equal(pause.getAttribute("aria-pressed"), "true", "and the button shows the transport is paused");

  ui.click("[data-act=play]");
  await ui.settle(24);
  assert.equal(ui.engine.plays, 2, "Play carries the paused run on");
  assert.equal(
    ui.document.querySelector("[data-role=position]").textContent,
    "007.3.2",
    "from the position it was paused at",
  );
  assert.equal(pause.getAttribute("aria-pressed"), "false", "and the button shows it is playing again");
});

test("Stop after Pause shows 001.1.1 in session and the seek bar in arrangement", async () => {
  const session = await bootTimeline();
  session.click("[data-act=play]");
  await session.settle(24);
  session.position({ bar: 6, beat: 2, sixteenth: 1 });
  session.click("[data-act=pause]");
  await session.settle();
  session.click("[data-act=stop]");
  await session.settle();
  assert.equal(session.engine.stops, 1, "Stop stopped the transport");
  assert.equal(
    session.document.querySelector("[data-role=position]").textContent,
    "001.1.1",
    "a session run starts at its first bar again",
  );

  const arrangement = await bootTimeline();
  arrangement.click("[data-act=mode-arrangement]");
  await arrangement.settle();
  const strip = stubRuler(arrangement);
  rulerPress(arrangement, strip, 65);
  await arrangement.settle();
  arrangement.release();
  arrangement.click("[data-act=play]");
  await arrangement.settle(24);
  // The run really moves: the playhead follows the engine, so a Stop that only
  // read back where the run had reached would say bar 11.
  arrangement.position({ bar: 11, beat: 2, sixteenth: 1 });
  assert.equal(
    arrangement.document.querySelector("[data-role=position]").textContent,
    "011.2.1",
    "the readout follows the run",
  );
  assert.equal(
    arrangement.document.querySelector("[data-role=playhead]").style.left,
    barLeft(10.25),
    "and so does the playhead",
  );
  arrangement.click("[data-act=pause]");
  await arrangement.settle();
  arrangement.click("[data-act=stop]");
  await arrangement.settle();
  assert.equal(arrangement.engine.stops, 1, "Stop stopped the transport");
  assert.equal(
    arrangement.document.querySelector("[data-role=position]").textContent,
    "007.1.1",
    "the timeline goes back to the bar its last seek put it on, as the engine does",
  );
  assert.equal(
    arrangement.document.querySelector("[data-role=playhead]").style.left,
    barLeft(6),
    "and the playhead stands on that bar again",
  );
  assert.equal(
    arrangement.document.querySelector("[data-role=cut-mark]").style.left,
    barLeft(6),
    "with the cut mark on it, so Split cuts where the next Play starts",
  );
});

test("a view switch and a Stop both let go of Pause", async () => {
  const ui = await bootTimeline();
  const pause = ui.document.querySelector("[data-act=pause]");
  assert.ok(pause, "the transport carries a Pause button");

  ui.click("[data-act=play]");
  await ui.settle(24);
  ui.click("[data-act=pause]");
  await ui.settle();
  assert.equal(pause.getAttribute("aria-pressed"), "true", "Pause shows the transport is paused");

  // A pause belongs to the view it happened in: the engine lets go of it when
  // its mode is set, and the page lets go of it with the engine.
  ui.click("[data-act=mode-arrangement]");
  await ui.settle();
  assert.equal(pause.getAttribute("aria-pressed"), "false", "switching the view clears the button");

  ui.click("[data-act=play]");
  await ui.settle(24);
  ui.click("[data-act=pause]");
  await ui.settle();
  assert.equal(pause.getAttribute("aria-pressed"), "true", "a second pause shows again");
  ui.click("[data-act=stop]");
  await ui.settle();
  assert.equal(pause.getAttribute("aria-pressed"), "false", "and Stop clears it too");
});

test("Pause is disabled while a take records and while Record to timeline collects", async () => {
  const ui = await bootTimeline();
  ui.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await ui.settle();
  ui.click("[data-act=record]");
  await ui.settle(24);

  const pause = ui.document.querySelector("[data-act=pause]");
  assert.equal(ui.engine.recorders.length, 1, "Record built the recorder");
  assert.equal(pause.disabled, true, "a take is only ever ended with Stop");

  ui.click("[data-act=stop]");
  await ui.settle();
  assert.equal(pause.disabled, false, "with the take over, Pause is offered again");

  // Record to timeline collects launches for as long as it is on: the same
  // rule, and Stop still ends it.
  ui.click("[data-act=rec-timeline]");
  await ui.settle();
  assert.equal(pause.disabled, true, "a collected performance is only ever ended with Stop");
  ui.click("[data-act=play]");
  await ui.settle(24);
  assert.equal(pause.disabled, true, "and the transport cannot be paused either");

  ui.click("[data-act=stop]");
  await ui.settle();
  assert.equal(ui.engine.stops, 1, "Stop still works");
});

test("a recording take blocks Pause and Stop still works", async () => {
  const ui = await bootTimeline();
  ui.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await ui.settle();
  ui.click("[data-act=play]");
  await ui.settle(24);
  ui.launch({ track_id: AUDIO_TRACK, clip_id: AUDIO_CLIP, scene_id: SCENE, bar: 0, frame: 0 });
  ui.click("[data-act=record]");
  await ui.settle(24);

  const recorder = ui.engine.recorders[0];
  assert.ok(recorder, "Record built the recorder");
  assert.notEqual(recorder.armed, null, "and the take is armed on the next bar");
  assert.equal(ui.document.querySelector("[data-act=pause]").disabled, true, "a take cannot be paused");

  ui.click("[data-act=pause]");
  await ui.settle();
  assert.equal(ui.engine.pauses, 0, "the press paused nothing");

  ui.click("[data-act=stop]");
  await ui.settle();
  assert.notEqual(recorder.stopped_at, null, "Stop ended the take");
  assert.equal(typeof recorder.stopped_at, "number", "on the frame the take ends on");
});

// ---- zoom (visual) and readable chips ------------------------------------

/** The zoom the page's timeline is drawn at, as its root reports it. */
function timelineZoom(ui) {
  const root = ui.document.querySelector("[data-role=timeline] .st-tl");
  assert.ok(root, "the timeline is drawn");
  return root.getAttribute("data-zoom");
}

/** The timeline root's inline width, in pixels. */
function timelineWidth(ui) {
  const root = ui.document.querySelector("[data-role=timeline] .st-tl");
  assert.ok(root, "the timeline is drawn");
  return Number.parseFloat(root.style.width);
}

/** The fixed track-header column, which the zoom does not change. */
const SIDE_PX = 180;

test("zoomedBarX doubles per step", () => {
  assert.equal(zoomedBarX(4, 1, TIMELINE_BASE_PX), 4 * TIMELINE_BASE_PX, "a bar's x at zoom 1");
  let previous = zoomedBarX(4, 0.5, TIMELINE_BASE_PX);
  for (const zoom of [1, 2, 4, 8]) {
    const next = zoomedBarX(4, zoom, TIMELINE_BASE_PX);
    assert.equal(next, previous * 2, `the step to ${zoom} doubles the bar's x`);
    previous = next;
  }
  assert.equal(zoomedBarX(0, 8, TIMELINE_BASE_PX), 0, "the first bar line stays at the left edge");
});

test("zoom re-anchors the scroll so the playhead's bar keeps its pixel", async () => {
  const ui = await bootTimeline();
  ui.click("[data-act=mode-arrangement]");
  await ui.settle();
  const bars = ui.document.querySelectorAll("[data-role=bar-ruler] .st-tl-bar-n").length;
  assert.equal(bars, 32, "the fixture song's ruler is 32 bars");

  // The bar the pointer seeks is the bar a zoom is anchored on.
  const strip = stubRuler(ui);
  rulerPress(ui, strip, (20.25 / bars) * 320);
  await ui.settle();
  ui.release();
  await ui.settle();
  assert.equal(ui.engine.seeks[ui.engine.seeks.length - 1], 20, "the ruler put the playhead on bar 20");

  // The host scrolls the lanes sideways; this browser's scroll is kept in a
  // local below, so the offset the page writes is readable.
  const host = ui.document.querySelector("[data-role=timeline]");
  assert.ok(host, "the timeline is drawn");
  let scrolled = 0;
  Object.defineProperty(host, "scrollLeft", {
    configurable: true,
    get: () => scrolled,
    set: (value) => {
      scrolled = Number(value) || 0;
    },
  });
  scrolled = 40;
  const pixelOf = (zoom) => SIDE_PX + zoomedBarX(20, zoom, TIMELINE_BASE_PX) - scrolled;
  const kept = pixelOf(1);

  ui.click("[data-act=zoom-in]");
  await ui.settle();
  assert.equal(timelineZoom(ui), "2", "zoom in steps up the scale");
  assert.equal(timelineWidth(ui) - SIDE_PX, 32 * TIMELINE_BASE_PX * 2, "the lane box doubled with the zoom");
  assert.equal(
    scrolled,
    SIDE_PX + zoomedBarX(20, 2, TIMELINE_BASE_PX) - kept,
    "the host is scrolled so bar 20 keeps the pixel it had on screen at 1x",
  );
  assert.equal(pixelOf(2), kept, "which is the pixel it was under before the zoom");

  ui.click("[data-act=zoom-out]");
  await ui.settle();
  assert.equal(timelineZoom(ui), "1", "zoom out steps back down");
  assert.equal(scrolled, 40, "and the host is back where it started");
});

test("zoom persists across reload and a throwing localStorage falls back to 1", async () => {
  const storage = memoryStorage();
  const ui = await bootTimeline({ storage });
  ui.click("[data-act=mode-arrangement]");
  await ui.settle();

  ui.click("[data-act=zoom-in]");
  ui.click("[data-act=zoom-in]");
  await ui.settle();
  assert.equal(storage.getItem("crow.studio.zoom.v1"), "4", "the zoom is kept under its own key");
  assert.equal(timelineZoom(ui), "4", "and the page is drawn at it");

  const again = await bootTimeline({ storage });
  again.click("[data-act=mode-arrangement]");
  await again.settle();
  assert.equal(timelineZoom(again), "4", "a page opened again starts at the zoom it was left at");

  const refusing = {
    getItem() {
      throw new Error("this browser keeps no storage");
    },
    setItem() {
      throw new Error("this browser keeps no storage");
    },
  };
  const third = await bootTimeline({ storage: refusing });
  third.click("[data-act=mode-arrangement]");
  await third.settle();
  assert.equal(timelineZoom(third), "1", "a browser that refuses storage falls back to 1");
  third.click("[data-act=zoom-in]");
  await third.settle();
  assert.equal(timelineZoom(third), "2", "and the buttons still work without storage");
});

test("every section chip, marker and placement carries a title attribute with its full name", async () => {
  const ui = await bootTimeline();
  ui.click("[data-act=mode-arrangement]");
  await ui.settle();

  const section = ui.document.querySelector("[data-role=section][data-section-id=sec-intro]");
  assert.ok(section, "the section is drawn");
  assert.ok(String(section.getAttribute("title")).includes("Intro"), "the section's block names it");
  const sectionChip = section.querySelector("[data-act=section-rename]");
  assert.ok(sectionChip, "the section's name is a chip");
  assert.ok(String(sectionChip.getAttribute("title")).includes("Intro"), "the section's chip names it too");

  const marker = ui.document.querySelector("[data-role=marker][data-marker-id=m-key]");
  assert.ok(marker, "the marker is drawn");
  assert.ok(String(marker.getAttribute("title")).includes("Key change"), "the marker's block names it");
  const markerChip = marker.querySelector("[data-act=marker-rename]");
  assert.ok(markerChip, "the marker's name is a chip");
  assert.ok(String(markerChip.getAttribute("title")).includes("Key change"), "the marker's chip names it too");

  const block = ui.document.querySelector(`[data-placement-id=${NOTE_PLACEMENT}]`);
  assert.ok(block, "the placement is drawn");
  assert.ok(String(block.getAttribute("title")).includes("Bass line"), "the placement names its clip");
});

test("the chip CSS rule sets min-width 56px and ellipsis", () => {
  const source = readFileSync(new URL("../bundles/studio/panel/studio.js", import.meta.url), "utf8");
  const rule = /\.studio \.st-tl-tag-btn \{([^}]*)\}/.exec(source);
  assert.ok(rule, "the chip rule is in the panel's stylesheet");
  assert.match(rule[1], /min-width:\s*56px/, "a chip keeps a readable minimum width");
  assert.match(rule[1], /text-overflow:\s*ellipsis/, "and a long name ends in an ellipsis");
});

test("the placement block CSS rule keeps a readable minimum width", () => {
  const source = readFileSync(new URL("../bundles/studio/panel/studio.js", import.meta.url), "utf8");
  const rule = /\.studio \.st-tl-block \{([^}]*)\}/.exec(source);
  assert.ok(rule, "the placement block rule is in the panel's stylesheet");
  assert.match(rule[1], /min-width:\s*(2[4-9]|3[0-2])px/, "a block keeps a readable minimum width at every zoom");
  assert.match(rule[1], /overflow:\s*hidden/, "and a label too long for the block is cut off");
});

test("at the highest zoom a short placement label is not empty", async () => {
  const doc = await timelineDoc();
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  runCommand(doc, "clip.rename", { clip_id: NOTE_CLIP, name: "A" });

  const ui = await bootTimeline({ doc });
  ui.click("[data-act=mode-arrangement]");
  await ui.settle();
  for (let i = 0; i < 3; i += 1) {
    ui.click("[data-act=zoom-in]");
    await ui.settle();
  }
  assert.equal(timelineZoom(ui), "8", "three steps up from 1 is the highest zoom");
  assert.equal(ui.document.querySelector("[data-act=zoom-in]").disabled, true, "nothing is above it");

  const block = ui.document.querySelector(`[data-placement-id=${NOTE_PLACEMENT}]`);
  assert.ok(block, "the placement is still drawn at the highest zoom");
  const label = block.querySelector(".st-tl-block-name");
  assert.ok(label, "the block carries its label");
  assert.equal(String(label.textContent).trim(), "A", "and a one-letter name is still said");
  assert.ok(String(block.getAttribute("title")).includes("A"), "with the full name in its title");
});

// ---- the same timeline against a real hub, in a real browser ---------------

let chrome = null;
let server = null;
let upgrades = null;
let db = null;
let hub = null;
let base = "";
let songId = "";
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

before(async () => {
  // No browser means no live half: nothing is started, so this file costs a
  // sandbox without Chrome nothing.
  chrome = await startHeadlessChrome({ extraArgs: ["--autoplay-policy=no-user-gesture-required"] });
  if (!chrome) return;

  dir = mkdtempSync(join(tmpdir(), "studio-panel-timeline-"));
  db = createClient({ url: "file:" + join(dir, "crow.db") });
  await db.execute(
    "CREATE TABLE IF NOT EXISTS project_spaces (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, status TEXT, archived_at TEXT, storage_prefix TEXT)",
  );
  await db.execute({
    sql: "INSERT INTO project_spaces (id, name, storage_prefix) VALUES (?, ?, ?)",
    args: [PROJECT, "Studio project", PREFIX],
  });
  await initStudioTables(db);

  const webRef = { web: null };
  hub = createHub({
    db,
    acl: fakeAcl(),
    onBroadcast: (id, payload) => webRef.web?.broadcast(id, payload),
  });

  const web = createStudioWeb({
    hub,
    Router: express.Router,
    WebSocketServer,
    auth: {
      isAllowedNetwork: () => true,
      sessionFromRequest: (req) => cookieOf(req.headers.cookie, "crow_session"),
      verifySession: async (token) => token === "good",
      csrfTokenAccepted: (_req, presented) => presented === "csrf-ok",
      classifyPeer: () => ({ via: "local" }),
    },
    crowHome: join(dir, "home"),
    bundleDir: BUNDLE_DIR,
  });
  webRef.web = web;

  const created = await hub.createSong({ project_id: PROJECT, title: "Timeline song", author: HUMAN });
  assert.equal(created.ok, true, `createSong was refused: ${created.error}`);
  songId = created.song_id;

  // A short bar, so a two-bar performance is two seconds rather than four.
  for (const [command, args] of [
    ["song.set_meta", { bpm: 240 }],
    ["track.add", { id: NOTE_TRACK, name: "Bass" }],
    ["scene.add", { id: SCENE, name: "Verse" }],
    [
      "clip.write",
      {
        clip_id: NOTE_CLIP,
        track_id: NOTE_TRACK,
        scene_id: SCENE,
        name: "Bass line",
        length_bars: 1,
        notes: [{ t: 0, d: 1, p: 60, v: 100 }],
      },
    ],
  ]) {
    const result = await hub.runCommand({ song_id: songId, cmd_id: null, command, args, author: HUMAN });
    assert.equal(result.ok, true, `${command} was refused: ${result.error}`);
  }

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  // The gateway's own Content-Security-Policy for the Studio page and its
  // assets, so the engine's worklet and WebAssembly load here.
  app.use((req, res, next) => {
    if (req.path === "/dashboard/studio" || req.path.startsWith("/dashboard/studio/")) {
      res.setHeader("Content-Security-Policy", [
        "default-src 'self'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src https://fonts.gstatic.com",
        "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
        "img-src 'self' data: blob:",
        "media-src 'self' https: blob:",
        "connect-src 'self'",
        "frame-src 'self' https:",
      ].join("; "));
    }
    next();
  });
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

  server = createServer(app);
  upgrades = web.attachUpgrade(server);
  await new Promise((resolve) => server.listen(0, chrome.bindHost ?? "127.0.0.1", resolve));
  base = `http://${chrome.pageHost ?? "127.0.0.1"}:${server.address().port}`;
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

/**
 * Open one page in the private browser with the dashboard's session cookies,
 * and return its CDP handle.
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
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.method === "Runtime.exceptionThrown") {
      console.error(
        "PAGE exception:",
        JSON.stringify(
          message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text,
        ).slice(0, 500),
      );
    }
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
    const outcome = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
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
async function waitFor(page, expression, timeoutMs = 15000) {
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
  return last;
}

/** Poll the song's document until `check` accepts its snapshot. */
async function waitForSong(check, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = (await hub.openSong(songId)).snapshot;
    try {
      if (check(last)) return last;
    } catch {
      // A snapshot mid-update is not an answer; look again.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return last;
}

/** @returns {object} the song's placements, whatever its arrangement holds */
function placementsOf(snap) {
  const arrangement = snap && snap.arrangement ? snap.arrangement : {};
  return arrangement.placements && typeof arrangement.placements === "object" ? arrangement.placements : {};
}

test("undo of record_performance removes all of them", async (t) => {
  if (!chrome) return t.skip("no headless Chrome available");

  const page = await openPage(`${base}/dashboard/studio?song=${encodeURIComponent(songId)}`);
  t.after(() => page.close());
  assert.ok(
    await waitFor(page, "!!document.querySelector('[data-role=grid] .st-corner')", 20000),
    "the studio grid rendered (the page's Yjs replica did not load)",
  );
  assert.ok(
    await waitFor(page, `!!document.querySelector('[data-clip-id=${NOTE_CLIP}]')`, 20000),
    "the song's clip is on the grid",
  );

  // Record to timeline on, then two launches in Session view, then Stop.
  assert.equal(
    await page.evaluate("document.querySelector('[data-act=rec-timeline]').click(), true"),
    true,
    "the Record to timeline toggle is on the page",
  );
  await page.evaluate("document.querySelector('[data-act=play]').click(), true");
  assert.ok(
    await waitFor(page, "document.querySelector('[data-act=play]') && true", 5000),
    "the transport started",
  );
  const launchAndWait = async (bar) => {
    const clicked = await page.evaluate(`(function () {
      var button = document.querySelector('[data-scene-id=${SCENE}] [data-act=launch-scene]');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    assert.equal(clicked, true, "the scene header offers its launch button");
    const reached = await waitFor(
      page,
      `(function () {
        var host = document.querySelector('[data-role=position]');
        if (!host) return false;
        return Number(String(host.textContent).split('.')[0]) >= ${bar};
      })()`,
      20000,
    );
    assert.ok(reached, `the transport never reached bar ${bar}`);
  };

  await launchAndWait(3);
  await launchAndWait(5);
  // One more bar, so the second launch is closed by the stop bar and not by
  // the bar it started on.
  await waitFor(
    page,
    `(function () {
      var host = document.querySelector('[data-role=position]');
      if (!host) return false;
      return Number(String(host.textContent).split('.')[0]) >= 6;
    })()`,
    20000,
  );
  await page.evaluate("document.querySelector('[data-act=stop]').click(), true");

  const played = await waitForSong((snap) => Object.keys(placementsOf(snap)).length >= 2);
  const placed = placementsOf(played);
  assert.ok(
    Object.keys(placed).length >= 2,
    `the performance became placements (got ${Object.keys(placed).length})`,
  );
  for (const placement of Object.values(placed)) {
    assert.equal(placement.track_id, NOTE_TRACK, "on the lane that was played");
    assert.equal(placement.clip_id, NOTE_CLIP, "playing the clip that was launched");
    assert.ok(placement.bars >= 1, "and lasting at least a bar");
  }

  // One step in the shared history, and one Undo takes all of them back.
  const undone = await waitFor(
    page,
    `(function () {
      var entries = document.querySelectorAll('[data-role=history] .st-entry');
      for (var i = 0; i < entries.length; i += 1) {
        var text = entries[i].textContent || '';
        if (text.indexOf('timeline') < 0) continue;
        var button = entries[i].querySelector('[data-act=undo]');
        if (!button) continue;
        button.click();
        return true;
      }
      return false;
    })()`,
    20000,
  );
  assert.ok(undone, "the performance is one step in the history, with its Undo");

  const after = await waitForSong((snap) => Object.keys(placementsOf(snap)).length === 0);
  assert.deepEqual(
    Object.keys(placementsOf(after)),
    [],
    "undoing the step removed every placement it made",
  );
});