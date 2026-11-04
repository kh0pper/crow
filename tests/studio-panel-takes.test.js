/**
 * Studio panel — the takes lane: which take plays where, keeping and
 * discarding a recording, and this device's own copy of the audio.
 *
 * Four of the five tests run everywhere: the emitted client script against a
 * linkedom document built from the page the handler renders, a real Yjs song
 * with a recorded audio clip, a fake take store and a stubbed socket. What
 * they prove is what the page draws and what a click or a comp drag sends —
 * the GUI half of the plan's take commands.
 *
 * The fifth needs the networked half: a real session hub on a scratch database
 * behind the panel's own WebSocket, and a private headless Chrome driving the
 * page. Keep and Discard are then measured in the song's document, and the undo
 * that brings a discarded take back is the shared history's own step. No
 * browser: it skips, unless CROW_REQUIRE_TEST_CHROME=1, which makes the fixture
 * throw instead.
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

/** The audio track the takes belong to. */
const AUDIO_TRACK = "gtr";

/** The scene the audio clip sits in. */
const SCENE = "verse";

/** The audio clip the takes are recorded into. */
const CLIP = "c-takes";

/** The project the live test's song lives in, and its storage prefix. */
const PROJECT = 47;
const PREFIX = "projects/47/";

/** The author a browser command carries (server/web.js's own constant). */
const HUMAN = { kind: "human", id: "local", label: "You" };

/** The bundle directory the asset routes read from. */
const BUNDLE_DIR = new URL("../bundles/studio", import.meta.url).pathname.replace(/\/$/, "");

/** Three take ids, oldest first: the numbers the lane shows follow them. */
const T1 = "0a1b2c3d-0000-4000-8000-000000000001";
const T2 = "0a1b2c3d-0000-4000-8000-000000000002";
const T3 = "0a1b2c3d-0000-4000-8000-000000000003";

/** The sentence "Remove from this device" asks first (plan Task 8). */
const CLEAR_AUDIO_TEXT =
  "Remove the cached audio of every take from this device? It stays on Crow and downloads again when needed.";

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

/**
 * A take as `take.add` takes it: one 48 kHz stereo recording of the clip.
 * @param {{id: string, at: string, frames: number, compensated?: boolean, author?: string}} take
 * @returns {{clip_id: string, take: object}}
 */
function takeArgs({ id, at, frames, compensated = true, author = "You" }) {
  return {
    clip_id: CLIP,
    take: {
      id,
      storage_key: `${PREFIX}studio/song-1/takes/${id}.wav`,
      rate: 48000,
      channels: 2,
      frames,
      offset_frames: 0,
      compensated,
      bpm: 120,
      recorded_at: at,
      author_label: author,
      discarded: false,
    },
  };
}

/**
 * A song with one audio track, one scene and one audio clip holding three
 * takes: take 2 is 1.5 s, take 3 was never calibrated. The first take became
 * the clip's comp, as `take.add` does for a clip that has none.
 * @returns {Promise<import("yjs").Doc>}
 */
async function takesDoc() {
  const { newSongDoc } = await import("../bundles/studio/server/doc.js");
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  await import("../bundles/studio/server/commands/core.js");
  await import("../bundles/studio/server/commands/takes.js");

  const doc = newSongDoc({ title: "Takes song", bpm: 120 });
  runCommand(doc, "track.add", { id: AUDIO_TRACK, name: "Guitar", kind: "audio" });
  runCommand(doc, "scene.add", { id: SCENE, name: "Verse" });
  runCommand(doc, "clip.add_audio", {
    clip_id: CLIP,
    track_id: AUDIO_TRACK,
    scene_id: SCENE,
    length_bars: 1,
    name: "Guitar",
  });
  runCommand(doc, "take.add", takeArgs({ id: T1, at: "2026-01-01T10:00:00.000Z", frames: 48000 }));
  runCommand(doc, "take.add", takeArgs({ id: T2, at: "2026-01-01T10:05:00.000Z", frames: 72000 }));
  runCommand(doc, "take.add", takeArgs({
    id: T3,
    at: "2026-01-01T10:10:00.000Z",
    frames: 24000,
    compensated: false,
  }));
  return doc;
}

/** A tiny 16-bit PCM WAV, so the page's own reader has something real to decode. */
function wavBytes(frames = 480, rate = 48000, channels = 1) {
  const bytes = Buffer.alloc(44 + frames * channels * 2);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36 + frames * channels * 2, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * channels * 2, 28);
  bytes.writeUInt16LE(channels * 2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(frames * channels * 2, 40);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

/**
 * The panel's take store, in memory: the same API, a log of what it was asked
 * to keep or clear, and the audio cache this device holds.
 * @param {{log?: string[], audio?: Array<[string, ArrayBuffer]>}} [options]
 */
function fakeTakeStore({ log = [], audio = [] } = {}) {
  const chunks = new Map();
  const pendings = new Map();
  const cachedAudio = new Map(audio);
  const state = { cleared: 0 };
  return {
    chunks,
    pendings,
    cachedAudio,
    state,
    log,
    async putChunk(takeId, index, bytes) {
      log.push("putChunk");
      chunks.set(takeId + ":" + index, bytes);
      return true;
    },
    async getChunk(takeId, index) {
      return chunks.get(takeId + ":" + index) || null;
    },
    async countChunks(takeId) {
      let count = 0;
      let bytes = 0;
      for (;;) {
        const chunk = chunks.get(takeId + ":" + count);
        if (!chunk) break;
        bytes += typeof chunk.byteLength === "number" ? chunk.byteLength : 0;
        count += 1;
      }
      return { count, bytes };
    },
    async getPending(takeId) {
      return pendings.get(takeId) || null;
    },
    async listPending() {
      return Array.from(pendings.values());
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
    async getAudio(takeId) {
      return cachedAudio.get(takeId) || null;
    },
    async putAudio(takeId, bytes) {
      cachedAudio.set(takeId, bytes);
      return true;
    },
    async clearAudio() {
      state.cleared += 1;
      log.push("clearAudio");
      cachedAudio.clear();
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

/** The engine stand-in: it records the songs it is given and the takes it loads. */
function fakeEngine() {
  const engine = {
    songs: [],
    loads: [],
    unloads: [],
    launched: [],
    plays: 0,
    node: { connect() {} },
    setSong(song) {
      engine.songs.push(song);
    },
    play() {
      engine.plays += 1;
    },
    stop() {},
    stopAll() {},
    launchScene(scene) {
      engine.launched.push(scene);
    },
    onPosition() {
      return () => {};
    },
    onError() {
      return () => {};
    },
    onLaunch() {
      return () => {};
    },
    async nextBarFrame() {
      return { frame: 48000, bar: 1 };
    },
    async loadAudio(takeId) {
      engine.loads.push(takeId);
    },
    unloadAudio(takeId) {
      engine.unloads.push(takeId);
    },
  };
  return engine;
}

/**
 * Boot the emitted client script against the page the handler renders, with a
 * fake browser around it, and hand back what it drew and what it sent.
 *
 * @param {{doc?: object, store?: object, log?: string[],
 *          pending?: object[], chunks?: Array<[string, number, ArrayBuffer]>,
 *          audio?: Array<[string, ArrayBuffer]>, confirm?: boolean}} [options]
 */
async function bootTakesPanel(options = {}) {
  const { parseHTML } = await import("linkedom");
  const { pathToFileURL } = await import("node:url");
  const { encodeDocState } = await import("../bundles/studio/server/doc.js");
  const { CLIENT_SCRIPT } = await import("../bundles/studio/panel/client.js");

  const doc = options.doc || (await takesDoc());
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

  const log = options.log || [];
  const store = options.store || fakeTakeStore({ log, audio: options.audio || [] });
  for (const row of options.pending || []) store.pendings.set(row.take_id, row);
  for (const [takeId, index, bytes] of options.chunks || []) store.chunks.set(takeId + ":" + index, bytes);
  const engine = fakeEngine();
  const sent = [];
  const requests = [];
  const timers = [];
  const wav = wavBytes();

  const response = (status, body, bytes) => ({
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async arrayBuffer() {
      return bytes === undefined ? wav : bytes;
    },
  });

  const fetchStub = async (url, init = {}) => {
    const target = String(url);
    requests.push({
      url: target,
      method: init.method || "GET",
      body: typeof init.body === "string" ? init.body : null,
    });
    log.push("fetch " + target);
    if (target.includes("/module-types")) {
      return response(200, { generators: ["Analog generator"], modules: {} });
    }
    if (target.includes("/project-bot")) return response(404, { error: "not_found" });
    if (target.includes("/api/studio/songs")) {
      return response(200, [{ id: "song-1", project_id: PROJECT, title: "Takes song" }]);
    }
    // One take's audio, which the page decodes with its own WAV reader.
    if (target.includes("/audio")) return response(200, {}, wav);
    // These tests are not about uploading: every take route refuses, so a
    // pending row stays exactly where it was.
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
    confirm: () => options.confirm !== false,
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

  const yjsUrl = pathToFileURL(
    new URL("../bundles/studio/node_modules/yjs/dist/yjs.mjs", import.meta.url).pathname,
  ).href;
  const scriptText = CLIENT_SCRIPT.replace("'/dashboard/studio/assets/yjs.mjs'", JSON.stringify(yjsUrl));
  assert.notEqual(scriptText, CLIENT_SCRIPT, "the test replaces the Yjs asset URL with the file on disk");

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
    { mediaDevices: null, locks: null },
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
    history: [],
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
    requests,
    log,
    page,
    click,
    event,
    settle,
    frame,
    fireWindow,
    timers,
  };
}

/** @returns {{top:number,left:number,width:number,height:number}} a 160 px 1-bar comp bar */
function compBarBox() {
  return { left: 0, top: 0, width: 160, height: 34, right: 160, bottom: 34, x: 0, y: 0 };
}

/** @returns {object[]} every take row of the lane, in the order it drew them */
function takeRows(ui) {
  return Array.from(ui.document.querySelectorAll("[data-role=take]"));
}

/** @returns {object[]} every clip.set_comp the page sent */
function setCompCommands(ui) {
  return ui.sent.filter((message) => message.type === "command" && message.command === "clip.set_comp");
}

// ---- the tests that need no browser ---------------------------------------

test("the takes lane lists takes newest first with keep, discard and restore", async () => {
  const ui = await bootTakesPanel();
  ui.click(`[data-clip-id=${CLIP}]`);
  await ui.settle();

  const lane = ui.document.querySelector("[data-role=takes-lane]");
  assert.ok(lane, "an audio clip's editor is its takes lane");
  assert.equal(
    ui.document.querySelector("[data-role=editor] .st-roll-svg"),
    null,
    "and the piano roll is not drawn for a clip that holds takes",
  );

  const rows = takeRows(ui);
  assert.equal(rows.length, 3, "one row per take");
  assert.deepEqual(
    rows.map((row) => row.getAttribute("data-take-n")),
    ["3", "2", "1"],
    "newest first, numbered from the oldest recording",
  );
  assert.equal(rows[0].querySelector(".st-take-name").textContent, "Take 3", "each row names its take");
  assert.equal(rows[1].querySelector(".st-take-name").textContent, "Take 2");
  assert.equal(
    rows[1].querySelector(".st-take-meta").textContent,
    "1.5 s \u00b7 You",
    "with its length in seconds and who recorded it",
  );

  // Every live take can be kept or discarded, and none of them restored.
  for (const row of rows) {
    assert.ok(row.querySelector("[data-act=take-keep]"), "a live take offers Keep");
    assert.ok(row.querySelector("[data-act=take-discard]"), "and Discard");
    assert.equal(row.querySelector("[data-act=take-restore]"), null, "and nothing to restore");
    assert.ok(row.querySelector("[data-act=take-play]"), "and a play button");
  }
  assert.equal(
    ui.document.querySelectorAll("[data-act=take-restore]").length,
    0,
    "no live take is offered Restore",
  );

  // Only the take that was never calibrated wears the badge.
  const badges = ui.document.querySelectorAll("[data-role=take-badge]");
  assert.equal(badges.length, 1, "one uncompensated take, one badge");
  assert.equal(badges[0].textContent, "uncompensated");
  assert.ok(
    rows[0].querySelector("[data-role=take-badge]"),
    "and it is on the take that was recorded without a measurement",
  );

  // The comp bar: take 1 over the whole clip, in its own colour.
  const bar = ui.document.querySelector("[data-role=comp-bar]");
  assert.ok(bar, "the lane draws the comp bar");
  const blocks = bar.querySelectorAll("[data-role=comp-seg]");
  assert.equal(blocks.length, 1, "the first take became the comp");
  assert.equal(blocks[0].getAttribute("data-take-n"), "1", "labelled with its take number");
  assert.equal(blocks[0].textContent, "Take 1");
  assert.match(String(blocks[0].getAttribute("style")), /#f2a541/i, "in the take's own colour");

  // A play auditions that take alone: the engine is given a comp of it, and
  // nothing at all goes to the hub.
  const commandsBefore = ui.sent.filter((message) => message.type === "command").length;
  ui.click(`[data-role=take][data-take-n="2"] [data-act=take-play]`);
  await ui.settle(24);
  assert.equal(
    ui.sent.filter((message) => message.type === "command").length,
    commandsBefore,
    "an audition is local: it sends no command",
  );
  const audition = ui.engine.songs[ui.engine.songs.length - 1];
  assert.deepEqual(
    audition.clips[CLIP].comp,
    [{ take_id: T2, from_beat: 0, to_beat: 4 }],
    "the engine plays the auditioned take over the whole clip",
  );
  assert.ok(ui.engine.loads.includes(T2), "and that take's audio was loaded");
});

test("comp drag sends one set_comp", async () => {
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  const doc = await takesDoc();
  // A comp with take 2 at both edges, so a drag in the middle has to merge the
  // range it assigns with the pieces it keeps.
  runCommand(doc, "clip.set_comp", {
    clip_id: CLIP,
    segments: [
      { take_id: T2, from_beat: 0, to_beat: 1 },
      { take_id: T1, from_beat: 1, to_beat: 3 },
      { take_id: T2, from_beat: 3, to_beat: 4 },
    ],
  });

  const ui = await bootTakesPanel({ doc });
  ui.click(`[data-clip-id=${CLIP}]`);
  await ui.settle();

  // With no row selected there is no take to assign a range to.
  let bar = ui.document.querySelector("[data-role=comp-bar]");
  assert.ok(bar, "the audio clip's editor draws the comp bar");
  bar.getBoundingClientRect = () => compBarBox();
  bar.dispatchEvent(ui.event("pointerdown", { button: 0, clientX: 38, shiftKey: false }));
  ui.fireWindow("pointerup", ui.event("pointerup", { button: 0, clientX: 122 }));
  await ui.settle();
  assert.equal(setCompCommands(ui).length, 0, "a drag with no take row selected sends nothing");

  // Clicking a row selects the take a drag assigns to.
  ui.click(`[data-role=take][data-take-n="2"]`);
  await ui.settle();
  const selected = ui.document.querySelector('[data-role=take][data-take-n="2"]');
  assert.match(String(selected.getAttribute("class")), /st-take-sel/, "clicking a row selects it");

  // One drag: 38 px is beat 0.95 and 122 px is beat 3.05 on a 160 px, 4-beat
  // bar, so the release snaps to beats 1 to 3.
  bar = ui.document.querySelector("[data-role=comp-bar]");
  bar.getBoundingClientRect = () => compBarBox();
  bar.dispatchEvent(ui.event("pointerdown", { button: 0, clientX: 38, shiftKey: false }));
  ui.fireWindow("pointermove", ui.event("pointermove", { clientX: 122 }));
  ui.fireWindow("pointerup", ui.event("pointerup", { button: 0, clientX: 122 }));
  await ui.settle();

  const sent = setCompCommands(ui);
  assert.equal(sent.length, 1, "a whole drag is one clip.set_comp");
  assert.deepEqual(
    sent[0].args.segments,
    [{ take_id: T2, from_beat: 0, to_beat: 4 }],
    "the range snaps to whole beats, replaces what it covers and merges the same take",
  );
  assert.equal(sent[0].args.clip_id, CLIP, "against the clip whose bar was dragged");
});

test("remove from this device clears the cache", async () => {
  // A take this device still owes the gateway: its chunks are here, and the
  // take routes refuse, so its row stays where it is.
  const owed = "0a1b2c3d-0000-4000-8000-0000000000ff";
  const pending = {
    take_id: owed,
    song_id: "song-1",
    clip_id: CLIP,
    rate: 48000,
    channels: 2,
    offset_frames: 0,
    compensated: false,
    bpm: 120,
    chunk_count: 1,
    begun: false,
    finished: false,
    created_at: new Date(0).toISOString(),
  };
  const store = fakeTakeStore({
    log: [],
    audio: [
      [T1, wavBytes()],
      [T2, wavBytes()],
    ],
  });
  const ui = await bootTakesPanel({
    store,
    pending: [pending],
    chunks: [[owed, 0, new Uint8Array(24).buffer]],
  });
  await ui.settle(24);
  ui.click(`[data-clip-id=${CLIP}]`);
  await ui.settle();

  assert.equal(store.cachedAudio.size, 2, "this device holds both takes' audio");
  assert.equal(store.pendings.has(owed), true, "and a take it has not uploaded yet");

  ui.click("[data-act=take-clear-audio]");
  await ui.settle(24);

  assert.equal(store.state.cleared, 1, "the cache was cleared once");
  assert.equal(store.cachedAudio.size, 0, "this device no longer holds the takes' audio");
  assert.equal(store.pendings.has(owed), true, "the unuploaded take is untouched");
  assert.ok(
    ui.document.querySelector(`[data-role=recordings] [data-take-id=${owed}]`),
    "and its row is still on the page",
  );

  // A person who says no keeps the cache.
  const declined = fakeTakeStore({ log: [], audio: [[T1, wavBytes()]] });
  const refused = await bootTakesPanel({ store: declined, confirm: false });
  refused.click(`[data-clip-id=${CLIP}]`);
  await refused.settle();
  refused.click("[data-act=take-clear-audio]");
  await refused.settle(24);
  assert.equal(declined.state.cleared, 0, "no yes, nothing cleared");
  assert.equal(declined.cachedAudio.size, 1, "and the audio is still here");
});

test("discarded takes are listed after live ones and dimmed", async () => {
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  const doc = await takesDoc();
  // Take 2 is discarded: its segments leave the comp in the same step.
  runCommand(doc, "take.discard", { clip_id: CLIP, take_id: T2 });

  const ui = await bootTakesPanel({ doc });
  ui.click(`[data-clip-id=${CLIP}]`);
  await ui.settle();

  const rows = takeRows(ui);
  assert.deepEqual(
    rows.map((row) => row.getAttribute("data-take-n")),
    ["3", "1", "2"],
    "every live take first, newest first, and the discarded one after them",
  );
  const discarded = rows[2];
  assert.match(String(discarded.getAttribute("class")), /st-take-off/, "the discarded take is dimmed");
  assert.equal(
    rows[0].getAttribute("class").includes("st-take-off"),
    false,
    "and a live one is not",
  );
  assert.ok(discarded.querySelector("[data-act=take-restore]"), "it offers Restore");
  assert.equal(discarded.querySelector("[data-act=take-discard]"), null, "and not Discard again");
  assert.equal(discarded.querySelector("[data-act=take-keep]"), null, "nor Keep");
});

// ---- the same lane against a real hub, in a real browser -------------------

let chrome = null;
let server = null;
let upgrades = null;
let db = null;
let hub = null;
let base = "";
let songId = "";
let dir = "";
let liveClip = "";

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
  chrome = await startHeadlessChrome();
  if (!chrome) return;

  dir = mkdtempSync(join(tmpdir(), "studio-panel-takes-"));
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

  const created = await hub.createSong({ project_id: PROJECT, title: "Takes song", author: HUMAN });
  assert.equal(created.ok, true, `createSong was refused: ${created.error}`);
  songId = created.song_id;
  liveClip = "c-live";

  const steps = [
    ["track.add", { id: AUDIO_TRACK, name: "Guitar", kind: "audio" }],
    ["scene.add", { id: SCENE, name: "Verse" }],
    [
      "clip.add_audio",
      { clip_id: liveClip, track_id: AUDIO_TRACK, scene_id: SCENE, length_bars: 1, name: "Guitar" },
    ],
  ];
  for (const [command, args] of steps) {
    const result = await hub.runCommand({ song_id: songId, cmd_id: null, command, args, author: HUMAN });
    assert.equal(result.ok, true, `${command} was refused: ${result.error}`);
  }
  // A take is added by Studio's own upload finish route, which is what
  // `internal: true` stands in for here.
  for (const [id, at, frames] of [
    [T1, "2026-02-01T10:00:00.000Z", 48000],
    [T2, "2026-02-01T10:05:00.000Z", 72000],
  ]) {
    const result = await hub.runCommand({
      song_id: songId,
      cmd_id: null,
      command: "take.add",
      args: {
        clip_id: liveClip,
        take: {
          id,
          storage_key: `${PREFIX}studio/${songId}/takes/${id}.wav`,
          rate: 48000,
          channels: 2,
          frames,
          offset_frames: 0,
          compensated: true,
          bpm: 120,
          recorded_at: at,
          author_label: "You",
          discarded: false,
        },
      },
      author: HUMAN,
      internal: true,
    });
    assert.equal(result.ok, true, `take.add was refused: ${result.error}`);
  }

  const app = express();
  app.use(express.json({ limit: "1mb" }));
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
  return false;
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

/** @returns {object[]} the clip's comp in a snapshot */
function compOfClip(snap, clipId) {
  const clip = snap && snap.clips ? snap.clips[clipId] : null;
  return clip && Array.isArray(clip.comp) ? clip.comp : [];
}

test("keep and discard update the comp and are undoable", async (t) => {
  if (!chrome) return t.skip("no headless Chrome available");

  const page = await openPage(`${base}/dashboard/studio?song=${encodeURIComponent(songId)}`);
  t.after(() => page.close());
  const ready = await waitFor(page, "!!document.querySelector('[data-role=grid] .st-corner')", 20000);
  assert.ok(ready, "the studio grid rendered (the page's Yjs replica did not load)");
  assert.ok(
    await waitFor(page, `!!document.querySelector('[data-clip-id=${liveClip}]')`, 20000),
    "the song's audio clip is on the grid",
  );

  await page.evaluate(`document.querySelector('[data-clip-id=${liveClip}]').click(), true`);
  assert.ok(
    await waitFor(page, "!!document.querySelector('[data-role=takes-lane] [data-role=take]')", 15000),
    "opening the audio clip draws its takes lane",
  );

  // Keep: the whole clip plays that take, as one history step.
  await page.evaluate(
    `document.querySelector('[data-role=take][data-take-n="2"] [data-act=take-keep]').click(), true`,
  );
  const kept = await waitForSong(
    (snap) => compOfClip(snap, liveClip).length === 1 && compOfClip(snap, liveClip)[0].take_id === T2,
  );
  assert.deepEqual(
    compOfClip(kept, liveClip),
    [{ take_id: T2, from_beat: 0, to_beat: 4 }],
    "Keep plays that take over the whole clip",
  );

  // Discard: the take is out of the song and its segments out of the comp.
  await page.evaluate(
    `document.querySelector('[data-role=take][data-take-n="2"] [data-act=take-discard]').click(), true`,
  );
  const discarded = await waitForSong((snap) => snap.takes[T2] && snap.takes[T2].discarded === true);
  assert.equal(discarded.takes[T2].discarded, true, "the take is discarded");
  assert.deepEqual(compOfClip(discarded, liveClip), [], "and its segments left the comp");

  // Undo the discard from the history panel: one step brings the take and its
  // comp back together.
  const undone = await waitFor(
    page,
    `(function () {
      var entries = document.querySelectorAll('[data-role=history] .st-entry');
      for (var i = 0; i < entries.length; i += 1) {
        var text = entries[i].textContent || '';
        if (text.indexOf('Discarded') < 0 && text.indexOf('discarded') < 0) continue;
        var button = entries[i].querySelector('[data-act=undo]');
        if (!button) continue;
        button.click();
        return true;
      }
      return false;
    })()`,
    20000,
  );
  assert.ok(undone, "the discard is a step in the shared history, with its Undo");
  const restored = await waitForSong(
    (snap) => snap.takes[T2] && snap.takes[T2].discarded === false && compOfClip(snap, liveClip).length === 1,
  );
  assert.equal(restored.takes[T2].discarded, false, "undoing the discard restored the take");
  assert.deepEqual(
    compOfClip(restored, liveClip),
    [{ take_id: T2, from_beat: 0, to_beat: 4 }],
    "and the comp it was playing",
  );
});