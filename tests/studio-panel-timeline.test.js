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
import { mkdtempSync, rmSync } from "node:fs";
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
 * The engine stand-in: it keeps the modes and seeks it was given, the songs it
 * was handed, and the position listener the page registered, so a test can
 * report a position the way the processor would.
 */
function fakeEngine() {
  const engine = {
    songs: [],
    modes: [],
    seeks: [],
    plays: 0,
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
    },
    play() {
      engine.plays += 1;
    },
    stop() {},
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
 * @param {{doc?: object, storage?: object, history?: object[]}} [options]
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
      return fakeContext();
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
    true,
    "and the session view comes back after the drop",
  );
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