/**
 * Studio panel — the pad-and-steps view, part 1 (entry, pads, pad settings,
 * samples in).
 *
 * The emitted client script against a linkedom document built from the page the
 * handler renders, a real Yjs song with a sampler track and a pattern clip, a
 * fake engine that records the pads it was asked to play, a fake AudioContext
 * that decodes a generated WAV, and a fetch stub that stands in for the take
 * routes and the sample audio route. What they prove is what the page draws and
 * what a press, a key, a control or an imported file sends or plays: the entry
 * from the grid, the sixteen pads of a bank, one pad.set per control release,
 * the keyboards 1-8/Q-I, the local-first sample upload and its pad, and the
 * pattern a sampler track's empty cell makes.
 *
 * No browser is needed: `AudioContext` and the engine are fakes, and no audio
 * is ever rendered.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createClient } from "@libsql/client";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";
import { AclError } from "../servers/shared/project-acl.js";
import { createHub } from "../bundles/studio/server/hub.js";
import { initStudioTables } from "../bundles/studio/server/init-tables.js";
import { createStudioWeb } from "../bundles/studio/server/web.js";
import { createTakeUploads } from "../bundles/studio/server/takes-upload.js";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";
import studioPanel from "../bundles/studio/panel/studio.js";
import { encodeWav24, decodeWav } from "../bundles/studio/server/wav.js";

/** The sampler track of the fixture song, and its one bank. */
const TRACK = "drums";
const SCENE = "verse";
const CLIP = "c-beat";

/** The project the fixture song lives in, and its storage prefix. */
const PROJECT = 61;
const PREFIX = "projects/61/";

/** The rate the fixture's WAV is written at (the fake context's own rate). */
const RATE = 48000;

/** How many frames the fixture WAV holds: 50 ms of a quiet pulse. */
const FRAMES = 2400;

/** The sample audio the stub serves, once a pad points at a sample. */
const SAMPLE_AUDIO = encodeWav24(
  Float32Array.from({ length: FRAMES }, (_, at) => Math.sin((at / RATE) * 2 * Math.PI * 220) * 0.5),
  Float32Array.from({ length: FRAMES }, (_, at) => Math.sin((at / RATE) * 2 * Math.PI * 220) * 0.5),
  RATE,
);

/** The fixture WAV an import test hands the file input. */
const IMPORT_FILE_BYTES = SAMPLE_AUDIO.slice(0);

/** The chop script the page falls back to when a browser has no Worker: the
 * very file `chop-worker.js` imports, loaded the way a Node caller loads it
 * (`engine/package.json` marks that directory CommonJS).
 */
const ENGINE_DIR = new URL("../bundles/studio/engine/", import.meta.url).pathname;
const StudioChop = createRequire(join(ENGINE_DIR, "bundles.js"))(join(ENGINE_DIR, "chop.js"));

/** The sample a chop test puts in the song (a sample id is a UUID). */
const SAMPLE_ID = "6f1c1f7a-8f7e-4a4e-9a1d-2b3c4d5e6f70";

/**
 * A stereo WAV of `frames` frames at the fixture's rate: long enough to need
 * more than one staged chunk (a chunk holds floor(1 MiB / 6) frames).
 * @param {number} frames
 * @returns {Uint8Array}
 */
function longWav(frames) {
  const left = Float32Array.from({ length: frames }, (_, at) => Math.sin((at / RATE) * 2 * Math.PI * 110) * 0.4);
  const right = Float32Array.from({ length: frames }, (_, at) => Math.cos((at / RATE) * 2 * Math.PI * 220) * 0.3);
  return encodeWav24(left, right, RATE);
}

/** The file input stand-in an import test hands its bytes to. */
function fileStub(name, bytes) {
  return {
    name,
    size: bytes.length,
    async arrayBuffer() {
      return bytes.slice(0).buffer;
    },
  };
}

/** A seeded mulberry32: the chop tests' only noise source (no Math.random). */
function seededRandom(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A loop of `hits` decaying noise bursts over a quiet floor: what a drum loop
 * looks like to the transient detector, with the exact frame each hit starts on.
 * @param {number} hits how many bursts
 * @returns {{bytes: Uint8Array, rate: number, frames: number, starts: number[], hz: number}}
 */
function hitsWav(hits) {
  const ms = RATE / 1000;
  const lead = Math.round(20 * ms);
  const spacing = Math.round(100 * ms);
  const burst = Math.round(80 * ms);
  const frames = lead + spacing * (hits - 1) + burst + Math.round(20 * ms);
  const starts = Array.from({ length: hits }, (_, at) => lead + at * spacing);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const attack = Math.max(1, Math.round(1.5 * ms));
  const release = Math.max(1, Math.round(5 * ms));
  for (let channel = 0; channel < 2; channel += 1) {
    const data = channel === 0 ? left : right;
    const random = seededRandom(20261104 + channel * 7919);
    for (let at = 0; at < frames; at += 1) data[at] = (random() * 2 - 1) * 0.003;
    for (const start of starts) {
      for (let at = 0; at < burst; at += 1) {
        const rise = at < attack ? at / attack : 1;
        const fall = at > burst - release ? (burst - at) / release : 1;
        const envelope = rise * fall * Math.exp(-at / (30 * ms));
        data[start + at] += (random() * 2 - 1) * 0.8 * envelope;
      }
    }
  }
  return { bytes: encodeWav24(left, right, RATE), rate: RATE, frames, starts, hz: spacing };
}

/**
 * Put a sample in the fixture song and on one pad of its bank.
 * @param {object} ui a booted page
 * @param {{id?: string, frames?: number, name?: string, index?: number}} [options]
 * @returns {Promise<{sampleId: string, bankId: string}>}
 */
async function putSample(ui, options = {}) {
  const bankId = await bankIdOf(ui.doc);
  const id = options.id || SAMPLE_ID;
  const frames = Math.max(1, Math.round(Number(options.frames) || FRAMES));
  await ui.apply("sample.add", {
    sample: {
      id,
      storage_key: `${PREFIX}studio/song-1/samples/${id}.wav`,
      rate: RATE,
      channels: 2,
      frames,
      name: options.name || "porch-knocks",
      origin: "import",
      author_label: "You",
    },
  });
  await ui.apply("pad.assign", {
    track_id: TRACK,
    bank_id: bankId,
    index: Number(options.index) || 0,
    sample_id: id,
  });
  return { sampleId: id, bankId };
}

/** The step toggle that puts one step of pad `index` on the fixture pattern. */
function stepArgs(bankId, at, index = 0) {
  return { clip_id: CLIP, pattern_id: "a", at, bank_id: bankId, index };
}

// ---- the fixture document --------------------------------------------------

/**
 * The song the client tests draw: one sampler track (whose kit arrives with
 * bank A and its sixteen pads), one scene and one 16-step pattern clip.
 * @param {{extraScene?: boolean, lengthSteps?: number}} [options]
 * @returns {Promise<import("yjs").Doc>}
 */
async function samplerDoc(options = {}) {
  const { newSongDoc } = await import("../bundles/studio/server/doc.js");
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  await import("../bundles/studio/server/commands/core.js");
  await import("../bundles/studio/server/commands/sampler.js");

  const doc = newSongDoc({ title: "Beat box", bpm: 120 });
  runCommand(doc, "track.add", { id: TRACK, name: "Beat box", kind: "sampler" });
  runCommand(doc, "scene.add", { id: SCENE, name: "Verse" });
  if (options.extraScene) runCommand(doc, "scene.add", { id: "chorus", name: "Chorus" });
  runCommand(doc, "clip.add_pattern", {
    clip_id: CLIP,
    track_id: TRACK,
    scene_id: SCENE,
    name: "Beat",
    length_steps: Math.max(1, Math.round(Number(options.lengthSteps) || 16)),
  });
  return doc;
}

/** @returns {Promise<string>} the fixture kit's one bank id */
async function bankIdOf(doc) {
  const { snapshot } = await import("../bundles/studio/server/doc.js");
  const banks = Object.values(snapshot(doc).banks || {});
  assert.equal(banks.length, 1, "a new sampler track has one bank");
  return banks[0].id;
}

// ---- the page's shared fixtures -------------------------------------------

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
function fakeTakeStore(options = {}) {
  const chunks = new Map();
  const pendings = new Map();
  /** Every row the page wrote, in order (a deleted row keeps its history here). */
  const saved = [];
  return {
    chunks,
    pendings,
    saved,
    async putChunk(takeId, index, bytes) {
      if (typeof options.putChunkProblem === "function" && options.putChunkProblem(takeId, index)) {
        throw new Error("This device could not keep that piece.");
      }
      chunks.set(takeId + ":" + index, bytes);
      return true;
    },
    async getChunk(takeId, index) {
      return chunks.get(takeId + ":" + index) || null;
    },
    async countChunks(takeId) {
      let count = 0;
      let bytes = 0;
      while (chunks.has(takeId + ":" + count)) {
        const held = chunks.get(takeId + ":" + count);
        bytes += held && held.byteLength ? held.byteLength : 0;
        count += 1;
      }
      return { count, bytes };
    },
    async getPending(takeId) {
      return pendings.get(takeId) || null;
    },
    async listPending() {
      return [...pendings.values()];
    },
    async putPending(row) {
      pendings.set(row.take_id, row);
      saved.push({ ...row });
      return true;
    },
    async deletePending(takeId) {
      pendings.delete(takeId);
      // The real store drops the chunks with the row (a finished upload leaves
      // nothing behind on this device).
      for (const key of [...chunks.keys()]) {
        if (String(key).indexOf(String(takeId) + ":") === 0) chunks.delete(key);
      }
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

/**
 * A context stand-in: the nodes the page builds, its clock, and a
 * `decodeAudioData` that reads the generated WAV back into float channels.
 * @param {{rate?: number}} [options]
 */
function fakeContext(options = {}) {
  const gain = { gain: { value: 1 }, connect() {}, disconnect() {} };
  return {
    sampleRate: Number(options.rate) || RATE,
    state: "running",
    currentTime: 0,
    destination: {},
    createGain: () => gain,
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
    resume: async () => {},
    close() {},
    decodeAudioData(buffer) {
      const bytes = new Uint8Array(buffer);
      const decoded = decodeWav(bytes);
      return Promise.resolve({
        numberOfChannels: decoded.channels.length,
        sampleRate: decoded.rate,
        length: decoded.channels[0].length,
        getChannelData: (index) => decoded.channels[index],
      });
    },
  };
}

/**
 * The engine stand-in: it records every pad it was asked to play and release,
 * the songs it was handed and the samples it was given.
 */
function fakeEngine() {
  const engine = {
    songs: [],
    livePads: [],
    releases: [],
    samples: [],
    taps: [],
    tapListeners: [],
    /** The frames `nextBarFrame` answers with, in order (then bar 1 at frame 0). */
    barFrames: [],
    /** When set, `createRecorder` waits on this before handing its recorder over. */
    holdRecorder: null,
    node: { connect() {} },
    setSong(song) {
      engine.songs.push(song);
    },
    setMode() {},
    seek() {},
    play() {},
    stop() {},
    stopAll() {},
    launchScene() {},
    onPosition(listener) {
      engine.positionListener = listener;
      return () => {
        engine.positionListener = null;
      };
    },
    onLaunch() {
      return () => {};
    },
    onError() {
      return () => {};
    },
    onSampleNeeded(listener) {
      engine.sampleNeeded = listener;
      return () => {};
    },
    onTap(listener) {
      engine.tapListeners.push(listener);
      return () => {
        const at = engine.tapListeners.indexOf(listener);
        if (at >= 0) engine.tapListeners.splice(at, 1);
      };
    },
    tap(target, on) {
      engine.taps.push({ target: String(target), on: on === true });
    },
    livePad(trackId, bankId, index, v) {
      engine.livePads.push({ track_id: String(trackId), bank_id: String(bankId), index: Number(index), v: Number(v) });
    },
    liveRelease(trackId, bankId, index) {
      engine.releases.push({ track_id: String(trackId), bank_id: String(bankId), index: Number(index) });
    },
    loadSample(sampleId, channels, rate) {
      engine.samples.push({ sample_id: String(sampleId), channels: channels.length, rate: Number(rate) });
      return Promise.resolve();
    },
    unloadSample() {},
    async nextBarFrame() {
      return engine.barFrames.length ? engine.barFrames.shift() : { frame: 0, bar: 1 };
    },
    async loadAudio() {},
    unloadAudio() {},
    recorders: [],
    createRecorder() {
      const recorder = {
        armed: null,
        stopped_at: null,
        chunk: null,
        done: null,
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
        splitAt() {},
        dispose() {
          recorder.disposed = true;
        },
      };
      engine.recorders.push(recorder);
      if (engine.holdRecorder) return engine.holdRecorder.then(() => recorder);
      return Promise.resolve(recorder);
    },
  };
  return engine;
}

/** The navigator stand-in: one raw stereo input, no Web Locks unless given one. */
function fakeNavigator(options = {}) {
  const track = {
    label: "Test input",
    getSettings: () => ({ deviceId: "in-1" }),
    stop() {
      track.stopped = true;
    },
  };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  const stub = {
    track,
    stream,
    locks: options.locks || null,
    mediaDevices: {
      async enumerateDevices() {
        return [{ kind: "audioinput", deviceId: "in-1", label: "Test input" }];
      },
      async getUserMedia() {
        return stream;
      },
    },
  };
  // A permission prompt that is still up: the answer is only given when the
  // test hands it over.
  if (options.holdInput) {
    stub.releaseInput = () => {};
    stub.mediaDevices.getUserMedia = () => new Promise((resolve) => {
      stub.releaseInput = () => resolve(stream);
    });
  }
  return stub;
}

/**
 * The Web Locks API, in memory, shared by the "tabs" of one test: a name is
 * either held or free, an `ifAvailable` request whose name is held gets null,
 * and `query()` reports what some page holds right now.
 * @returns {{request: Function, query: Function, held: Set<string>}}
 */
function fakeLocks() {
  const held = new Set();
  return {
    held,
    async request(name, options, run) {
      const callback = typeof options === "function" ? options : run;
      const settings = typeof options === "function" ? {} : options || {};
      if (held.has(name)) {
        if (settings.ifAvailable && typeof callback === "function") return callback(null);
        return undefined;
      }
      held.add(name);
      try {
        return typeof callback === "function" ? await callback({ name }) : undefined;
      } finally {
        held.delete(name);
      }
    },
    async query() {
      return { held: [...held].map((name) => ({ name })), pending: [] };
    },
  };
}

/**
 * Boot the emitted client script against the page the handler renders, with a
 * fake browser around it, and hand back what it drew, what it sent and what the
 * engine was asked to do.
 * @param {{doc?: object, holdChunks?: boolean, holdRecorder?: boolean, rate?: number,
 *          holdInput?: boolean, store?: object, locks?: object, sampleAudio?: Uint8Array,
 *          putChunkProblem?: (takeId: string, index: number) => boolean}} [options]
 */
async function bootSampler(options = {}) {
  const { parseHTML } = await import("linkedom");
  const { pathToFileURL } = await import("node:url");
  const { encodeDocState } = await import("../bundles/studio/server/doc.js");
  const { CLIENT_SCRIPT } = await import("../bundles/studio/panel/client.js");

  const doc = options.doc || (await samplerDoc());
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
  assert.ok(res.html.includes('data-role="sampler"'), "the page carries the sampler host");
  const { document, window: domWindow } = parseHTML(res.html);

  const store = options.store || fakeTakeStore(options);
  const engine = fakeEngine();
  const navigatorStub = fakeNavigator({ locks: options.locks, holdInput: options.holdInput === true });
  let releaseRecorder = () => {};
  if (options.holdRecorder) {
    engine.holdRecorder = new Promise((resolve) => {
      releaseRecorder = resolve;
    });
  }
  const contexts = [];
  const sent = [];
  const requests = [];
  let heldChunks = null;
  if (options.holdChunks) heldChunks = new Promise(() => {});

  const response = (status, body, bytes) => ({
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async arrayBuffer() {
      return bytes || new ArrayBuffer(0);
    },
  });

  const fetchStub = async (url, init = {}) => {
    const target = String(url);
    const method = init.method || "GET";
    requests.push({
      url: target,
      method,
      body: typeof init.body === "string" ? init.body : null,
      bytes: init.body && typeof init.body.byteLength === "number" ? init.body.byteLength : null,
    });
    if (target.includes("/module-types")) return response(200, { generators: ["Analog generator"], modules: {} });
    if (target.includes("/project-bot")) return response(404, { error: "not_found" });
    if (target.includes("/api/studio/songs") && !target.includes("/takes") && !target.includes("/samples")) {
      return response(200, [{ id: "song-1", project_id: PROJECT, title: "Beat box" }]);
    }
    if (target.includes("/samples/") && target.endsWith("/audio")) {
      const bytes = options.sampleAudio || SAMPLE_AUDIO;
      return response(200, {}, bytes.slice(0).buffer);
    }
    if (target.includes("/api/studio/takes")) {
      if (target.includes("/chunks/") && heldChunks) await heldChunks;
      if (target.includes("/finish")) {
        const id = String(target.split("/takes/")[1] || "").replace("/finish", "");
        return response(200, {
          sample: {
            id,
            storage_key: `${PREFIX}studio/song-1/samples/${id}.wav`,
            rate: RATE,
            channels: 2,
            frames: FRAMES,
            name: "kick",
            origin: "import",
            author_label: "You",
          },
          pad_assigned: true,
        });
      }
      if (target.includes("/chunks/")) return response(200, { sha256: "0".repeat(64) });
      if (method === "PUT") return response(200, { chunk_bytes: 1048576 });
      return response(200, { begun: false, received: [], frames: 0 });
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
      const made = fakeContext({ rate: options.rate });
      contexts.push(made);
      return made;
    },
    StudioTakeStore: store,
    StudioEngine: { create: async () => engine },
    // A browser with a Worker chops off this thread; this one has none, so the
    // page takes its inline fallback through the very same chop.js.
    StudioChop: StudioChop,
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
    navigatorStub,
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

  const settle = async (rounds = 16) => {
    for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  };
  const frame = (message) => {
    for (const handler of socket.handlers.message || []) handler({ data: JSON.stringify(message) });
  };
  const stateFrame = (nextDoc = doc) => ({
    type: "state",
    update: Buffer.from(encodeDocState(nextDoc)).toString("base64"),
    history: [],
    presence: [],
  });
  const event = (type, props) => {
    const made = new domWindow.Event(type, { bubbles: true, cancelable: true });
    for (const [key, value] of Object.entries(props || {})) made[key] = value;
    return made;
  };

  await settle();
  frame(stateFrame());
  await settle();

  const page = document.querySelector(".studio");
  const click = (selector) => {
    const node = document.querySelector(selector);
    assert.ok(node, `nothing matches ${selector}`);
    node.dispatchEvent(new domWindow.Event("click", { bubbles: true }));
    return node;
  };

  const ui = {
    doc,
    document,
    domWindow,
    window: windowStub,
    windowListeners,
    navigator: navigatorStub,
    store,
    engine,
    contexts,
    sent,
    requests,
    page,
    click,
    event,
    settle,
    frame,
    stateFrame,
    timers,
    /** The AudioContext the page built (the latest one). */
    ctx() {
      return contexts.length ? contexts[contexts.length - 1] : null;
    },
    /** Hand the played recorder the one it was waiting for. */
    releaseRecorder() {
      engine.holdRecorder = null;
      releaseRecorder();
    },
    /** Answer a permission prompt that is still up. */
    releaseInput() {
      if (typeof navigatorStub.releaseInput === "function") navigatorStub.releaseInput();
    },
    /** Push one tap block of whole frames, starting at `frame`. */    tapBlock(frames, frame = 0) {
      const channels = [new Float32Array(frames), new Float32Array(frames)];
      for (const listener of [...engine.tapListeners]) listener({ target: "master", frame, channels });
    },
    /** Push `count` tap blocks of `frames` frames each, from `fromFrame` on. */
    tapBlocks(count, frames, fromFrame = 0) {
      for (let at = 0; at < count; at += 1) ui.tapBlock(frames, fromFrame + at * frames);
    },
    /** Open a pattern clip: the pad-and-steps view is its editor. */
    async openSampler() {
      click(`[data-act=open-clip][data-clip-id=${CLIP}]`);
      await settle();
    },
    /** The sampler host, asserted to be the view on screen. */
    view() {
      const host = document.querySelector("[data-role=sampler]");
      assert.ok(host, "the sampler host is on the page");
      assert.equal(host.hidden, false, "the pad-and-steps view is open");
      return host;
    },
    /** @returns {object} one pad's button */
    pad(index) {
      const node = document.querySelector(
        `[data-role=sampler] [data-act=pad][data-pad-index="${index}"]`,
      );
      assert.ok(node, `pad ${index} is drawn`);
      return node;
    },
    /** @returns {string} one pad's visible name */
    padName(index) {
      const node = ui.pad(index).querySelector(".st-pad-name");
      return node ? String(node.textContent) : "";
    },
    /** Press a pad, the way a pointer would. */
    pressPad(index, props) {
      const node = ui.pad(index);
      node.dispatchEvent(event("pointerdown", props || { button: 0 }));
      return node;
    },
    /** Release the pointer anywhere: the page hears it on the window. */
    release(props) {
      for (const handler of [...(windowListeners.pointerup || [])]) {
        handler(event("pointerup", props || {}));
      }
    },
    /** Push one transport position, as the engine's own frames do. */
    playhead(bar, beat, sixteenth = 1) {
      assert.ok(engine.positionListener, "the page follows the engine's position");
      engine.positionListener({ bar, beat, sixteenth });
    },
    /** Run the real server commands on the fixture song, then redraw the page. */
    async apply(command, args) {
      const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
      runCommand(doc, command, args);
      frame(stateFrame());
      await settle();
    },
    /** @returns {object} one of the view's two part-2 hosts */
    slot(role) {
      const node = document.querySelector(`[data-role=${role}]`);
      assert.ok(node, `the ${role} host is on the page`);
      return node;
    },
    /** @returns {object[]} the step buttons drawn right now */
    steps() {
      return [...ui.slot("sampler-steps").querySelectorAll("[data-act=step]")];
    },
    /** @returns {object} the step button for one position */
    step(at) {
      const node = ui.slot("sampler-steps").querySelector(`[data-act=step][data-at="${at}"]`);
      assert.ok(node, `step ${at} is drawn`);
      return node;
    },
    /** @returns {object[]} the pattern tabs drawn right now */
    patternTabs() {
      return [...ui.slot("sampler-steps").querySelectorAll("[data-act=pick-pattern]")];
    },
    /** @returns {object} the chain row */
    chain() {
      const node = ui.slot("sampler-steps").querySelector("[data-role=chain]");
      assert.ok(node, "the chain editor is drawn");
      return node;
    },
    /** @returns {object[]} the slice markers drawn right now */
    markers() {
      return [...ui.slot("sampler-chop").querySelectorAll("[data-act=slice-marker]")];
    },
    /** Press a step, the way a pointer would, and hold it. */
    holdStep(at) {
      const node = ui.step(at);
      node.dispatchEvent(event("pointerdown", { button: 0, clientX: 0 }));
      return node;
    },
    /** Drag a slice marker from one x to another and let go. */
    dragMarker(index, fromX, toX) {
      const node = ui.markers()[index];
      assert.ok(node, `marker ${index} is drawn`);
      node.dispatchEvent(event("pointerdown", { button: 0, clientX: fromX }));
      for (const handler of [...(windowListeners.pointermove || [])]) {
        handler(event("pointermove", { clientX: toX }));
      }
      return node;
    },
  };
  return ui;
}

/** @returns {object[]} every command of one id the page sent, in order. */
function commands(ui, id) {
  return ui.sent.filter((message) => message.type === "command" && message.command === id);
}

/** The begin request a sample upload made: its URL and the body it carried. */
function sampleBegin(ui) {
  const found = ui.requests.filter(
    (request) => request.method === "PUT" && /\/api\/studio\/takes\/[^/]+$/.test(request.url),
  );
  assert.equal(found.length, 1, "one begin request was made");
  return {
    sampleId: String(found[0].url.split("/takes/")[1]),
    body: JSON.parse(found[0].body || "{}"),
  };
}

// ---- entry and pads --------------------------------------------------------

test("the pad grid shows bank A with 16 pads", async () => {
  const ui = await bootSampler();
  const bankId = await bankIdOf(ui.doc);

  await ui.openSampler();
  const view = ui.view();

  // The header names the track, its pattern, the loop's length and its swing.
  const header = String(view.querySelector(".st-sampler-head").textContent);
  assert.match(header, /Beat box/, "the track's name is in the header");
  assert.match(header, /Pattern A/, "so is the pattern's");
  assert.match(header, /16 steps/, "and the length in steps");
  assert.match(header, /swing 0%/, "and the swing");

  // One bank tab, lettered A, and the + Bank button beside it.
  const tabs = view.querySelectorAll("[data-act=pick-bank]");
  assert.equal(tabs.length, 1, "a new kit shows its one bank");
  assert.equal(String(tabs[0].textContent), "A", "named A");
  assert.equal(tabs[0].getAttribute("aria-pressed"), "true", "and it is the bank being shown");
  assert.equal(tabs[0].getAttribute("data-bank-id"), bankId);
  assert.ok(view.querySelector("[data-act=add-bank]"), "with a + Bank button");

  // Sixteen real buttons, labelled A01 to A16, each empty until a sound is put
  // on it.
  const pads = view.querySelectorAll("[data-act=pad]");
  assert.equal(pads.length, 16, "bank A draws sixteen pads");
  for (const pad of pads) {
    assert.equal(String(pad.tagName), "BUTTON", "a pad is a real button");
  }
  const labels = [...pads].map((pad) => String(pad.querySelector(".st-pad-num").textContent));
  assert.deepEqual(
    labels,
    Array.from({ length: 16 }, (_, at) => "A" + String(at + 1).padStart(2, "0")),
    "labelled A01 to A16",
  );
  assert.equal(ui.padName(0), "Empty", "an empty pad says so");

  // The selected pad's settings are drawn, and part 2's hosts are left for it.
  assert.ok(view.querySelector("[data-pad-field=gain_db]"), "the pad's settings are drawn");
  assert.ok(view.querySelector("[data-role=sampler-chop]"), "the chop editor's host is left for part 2");
  assert.ok(view.querySelector("[data-role=sampler-steps]"), "so is the step sequencer's");
});

test("a sampler track gets a pattern from its empty cell", async () => {
  const ui = await bootSampler({ doc: await samplerDoc({ extraScene: true }) });

  const cell = ui.document.querySelector(
    `[data-role=grid] [data-act=new-pattern][data-track-id=${TRACK}][data-scene-id=chorus]`,
  );
  assert.ok(cell, "the sampler track's empty cell offers + Pattern");
  assert.equal(String(cell.textContent), "+ Pattern");

  cell.dispatchEvent(ui.event("click", {}));
  await ui.settle();

  const sent = commands(ui, "clip.add_pattern");
  assert.equal(sent.length, 1, "one clip.add_pattern");
  assert.equal(sent[0].args.track_id, TRACK, "on the sampler track");
  assert.equal(sent[0].args.scene_id, "chorus", "in the empty scene");
  assert.equal(sent[0].args.length_steps, 16, "sixteen steps long");
  assert.equal(typeof sent[0].args.clip_id, "string", "with a client-generated clip id");
  assert.equal(
    commands(ui, "clip.write").length,
    0,
    "a sampler track never gets an empty note clip",
  );
});

// ---- pad settings and the keys --------------------------------------------

test("changing a pad control sends one pad.set", async () => {
  const ui = await bootSampler();
  const bankId = await bankIdOf(ui.doc);
  await ui.openSampler();

  const gain = ui.view().querySelector("[data-pad-field=gain_db]");
  assert.ok(gain, "the pad's gain is a control");
  assert.equal(gain.getAttribute("data-track-id"), TRACK);
  assert.equal(gain.getAttribute("data-bank-id"), bankId);
  assert.equal(gain.getAttribute("data-pad-index"), "0");

  // A drag sends input events all the way; only the release is a command.
  for (const value of ["-2", "-4", "-6"]) {
    gain.dispatchEvent(ui.event("input", { target: gain }));
    gain.value = value;
  }
  gain.value = "-6";
  gain.dispatchEvent(ui.event("change", { target: gain }));
  await ui.settle();

  const sent = commands(ui, "pad.set");
  assert.equal(sent.length, 1, "one pad.set for the whole drag");
  assert.equal(sent[0].args.track_id, TRACK);
  assert.equal(sent[0].args.bank_id, bankId);
  assert.equal(sent[0].args.index, 0);
  assert.deepEqual(sent[0].args.fields, { gain_db: -6 }, "carrying only the field that moved");

  // A filter is one object: changing its cutoff sends the whole filter again.
  const cutoff = ui.view().querySelector("[data-pad-field=filter.cutoff_hz]");
  assert.ok(cutoff, "the pad's filter cutoff is a control too");
  cutoff.value = "800";
  cutoff.dispatchEvent(ui.event("change", { target: cutoff }));
  await ui.settle();
  const filters = commands(ui, "pad.set");
  assert.equal(filters.length, 2, "one more pad.set");
  assert.deepEqual(
    filters[1].args.fields,
    { filter: { type: "off", cutoff_hz: 800, resonance: 0 } },
    "with the whole filter, as the document holds it",
  );
});

test("keys 1 and Q play pads 1 and 9", async () => {
  const ui = await bootSampler();
  const bankId = await bankIdOf(ui.doc);
  await ui.openSampler();

  ui.document.dispatchEvent(ui.event("keydown", { key: "1" }));
  await ui.settle(24);
  assert.equal(ui.engine.livePads.length, 1, "key 1 played a pad");
  assert.deepEqual(
    ui.engine.livePads[0],
    { track_id: TRACK, bank_id: bankId, index: 0, v: 100 },
    "pad 1 of the bank being shown",
  );

  ui.document.dispatchEvent(ui.event("keyup", { key: "1" }));
  await ui.settle();
  assert.deepEqual(ui.engine.releases[0], { track_id: TRACK, bank_id: bankId, index: 0 }, "and let it go");

  ui.document.dispatchEvent(ui.event("keydown", { key: "q" }));
  await ui.settle(24);
  assert.equal(ui.engine.livePads.length, 2, "Q played a pad");
  assert.equal(ui.engine.livePads[1].index, 8, "pad 9: Q is the second row's first key");

  // A repeat is the key being held, not a second press.
  const before = ui.engine.livePads.length;
  ui.document.dispatchEvent(ui.event("keydown", { key: "q", repeat: true }));
  await ui.settle();
  assert.equal(ui.engine.livePads.length, before, "a held key is not played twice");
});

// ---- samples in -----------------------------------------------------------

test("importing a file assigns it to the selected pad", async () => {
  const ui = await bootSampler();
  const bankId = await bankIdOf(ui.doc);
  await ui.openSampler();

  // The pad the file goes on: a press selects it (and auditions it).
  ui.pressPad(2);
  ui.release();
  await ui.settle();
  assert.equal(ui.view().querySelector("[data-act=pad]").getAttribute("aria-pressed"), "false");
  assert.equal(ui.pad(2).getAttribute("aria-pressed"), "true", "pad 3 is the selected one");

  const file = {
    name: "kick.wav",
    size: IMPORT_FILE_BYTES.length,
    async arrayBuffer() {
      return IMPORT_FILE_BYTES.slice(0).buffer;
    },
  };
  const input = ui.view().querySelector("[data-act=sample-import]");
  assert.ok(input, "the view offers Import a sound");
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(ui.event("change", { target: input }));
  await ui.settle(40);

  // The 24-bit PCM the file became was staged in the same store a take uses,
  // in one chunk, and then dropped when the upload finished.
  const begin = sampleBegin(ui);
  assert.equal(begin.body.kind, "sample", "the upload is a sample");
  assert.equal(begin.body.origin, "import");
  assert.equal(begin.body.name, "kick", "named after the file, without its extension");
  assert.equal(begin.body.rate, RATE);
  assert.equal(begin.body.channels, 2);
  assert.deepEqual(begin.body.target, { track_id: TRACK, bank_id: bankId, index: 2 }, "the selected pad");

  // The 24-bit PCM the file became went up in one chunk of the file's own size,
  // through the take routes the takes use.
  const chunkPut = ui.requests.find(
    (request) => request.method === "PUT" && request.url.endsWith("/chunks/0"),
  );
  assert.ok(chunkPut, "the upload's first chunk was sent");
  assert.equal(chunkPut.bytes, FRAMES * 2 * 3, "the whole stereo 24-bit PCM of the file");

  // A finish that returns the sample lets this device forget it.
  assert.equal(ui.requests.filter((request) => request.url.endsWith("/finish")).length, 1, "and it finished");
  assert.equal(ui.store.pendings.size, 0, "the pending row is gone once the sample is in the song");
  assert.equal(ui.store.chunks.has(begin.sampleId + ":0"), false, "a finished upload's chunks are dropped");

  // The gateway puts the sample in the song and on the pad; the pad then says
  // which sound it holds.
  await ui.apply("sample.add", {
    sample: {
      id: begin.sampleId,
      storage_key: `${PREFIX}studio/song-1/samples/${begin.sampleId}.wav`,
      rate: RATE,
      channels: 2,
      frames: FRAMES,
      name: "kick",
      origin: "import",
      author_label: "You",
    },
  });
  await ui.apply("pad.assign", {
    track_id: TRACK,
    bank_id: bankId,
    index: 2,
    sample_id: begin.sampleId,
  });

  assert.equal(ui.padName(2), "kick", "the pad shows the sample's name");
  const loaded = ui.engine.samples.map((entry) => entry.sample_id);
  assert.ok(loaded.includes(begin.sampleId), "and the engine was handed the sample's PCM");
});

test("a pad still uploading says so", async () => {
  const ui = await bootSampler({ holdChunks: true });
  const bankId = await bankIdOf(ui.doc);
  await ui.openSampler();

  ui.pressPad(4);
  ui.release();
  await ui.settle();

  const file = {
    name: "snare.wav",
    size: IMPORT_FILE_BYTES.length,
    async arrayBuffer() {
      return IMPORT_FILE_BYTES.slice(0).buffer;
    },
  };
  const input = ui.view().querySelector("[data-act=sample-import]");
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(ui.event("change", { target: input }));
  // The upload began (its begin answered) and its chunks are still going.
  await ui.settle(40);

  const begin = sampleBegin(ui);
  assert.equal(begin.body.target.index, 4, "the upload is for pad 5");
  assert.equal(ui.padName(4), "Uploading\u2026", "the pad says it is still uploading");

  const before = ui.engine.livePads.length;
  ui.pressPad(4);
  ui.release();
  await ui.settle(24);
  assert.equal(ui.engine.livePads.length, before, "and a pad still uploading auditions nothing");
  assert.deepEqual(ui.engine.livePads.filter((call) => call.index === 4), [], "pad 5 never played");
});

test("an import longer than one chunk uploads in whole-frame chunks", async () => {
  const ui = await bootSampler();
  await ui.openSampler();

  ui.pressPad(3);
  ui.release();
  await ui.settle();

  // Eight seconds of stereo: 384,000 frames, more than two whole chunks.
  const FRAMES_LONG = RATE * 8;
  const input = ui.view().querySelector("[data-act=sample-import]");
  assert.ok(input, "the view offers Import a sound");
  Object.defineProperty(input, "files", {
    value: [fileStub("loop.wav", longWav(FRAMES_LONG))],
    configurable: true,
  });
  input.dispatchEvent(ui.event("change", { target: input }));
  await ui.settle(60);

  // The chunks are whole frames, never raw byte cuts: 24-bit stereo is six
  // bytes a frame, and the recorder's rule is floor(1 MiB / six) frames a chunk.
  const begin = sampleBegin(ui);
  assert.equal(begin.body.channels, 2, "the upload is stereo");
  const chunkPuts = ui.requests.filter(
    (request) => request.method === "PUT" && request.url.includes(begin.sampleId + "/chunks/"),
  );
  assert.ok(chunkPuts.length > 1, "the import went up in more than one chunk");
  for (const put of chunkPuts) {
    assert.equal(put.bytes % 6, 0, `every chunk holds whole stereo frames (${put.bytes} bytes)`);
  }
  assert.equal(
    chunkPuts.reduce((sum, put) => sum + put.bytes, 0),
    FRAMES_LONG * 6,
    "the whole file, in whole frames",
  );
  // The row was written only after every chunk was on this device, and every
  // version of it carried its count: another tab never sees a half import.
  const importRows = ui.store.saved.filter((row) => row.origin === "import");
  assert.ok(importRows.length >= 1, "the import's row was written");
  for (const row of importRows) {
    assert.equal(row.chunk_count, chunkPuts.length, "every write of it carried the chunk count");
  }
  assert.equal(
    ui.store.saved.filter((row) => row.chunk_count === null).length,
    0,
    "no uncounted row was ever left for another tab to recover",
  );
  assert.equal(
    ui.requests.filter((request) => request.url.endsWith("/finish")).length,
    1,
    "and it finished exactly once",
  );
});

test("an import whose chunk cannot be stored leaves nothing behind", async () => {
  const ui = await bootSampler({ putChunkProblem: (_takeId, index) => index === 1 });
  await ui.openSampler();

  ui.pressPad(5);
  ui.release();
  await ui.settle();

  const input = ui.view().querySelector("[data-act=sample-import]");
  Object.defineProperty(input, "files", {
    value: [fileStub("loop.wav", longWav(RATE * 8))],
    configurable: true,
  });
  input.dispatchEvent(ui.event("change", { target: input }));
  await ui.settle(60);

  const toast = ui.document.querySelector("[data-role=toast]");
  assert.equal(toast.hidden, false, "the page says the import failed");
  assert.match(String(toast.textContent), /could not be imported/, "with the import's own sentence");
  assert.equal(ui.store.pendings.size, 0, "the pending row is gone");
  assert.deepEqual([...ui.store.chunks.keys()], [], "and the chunks it did keep went with it");
  assert.equal(
    ui.requests.filter((request) => request.method === "PUT" && /\/takes\/[^/]+$/.test(request.url)).length,
    0,
    "nothing was begun",
  );
  assert.equal(ui.padName(5), "Empty", "the pad is unchanged");
});

test("a second press while record into pad sets up starts no second recorder", async () => {
  const ui = await bootSampler({ holdRecorder: true });
  await ui.openSampler();

  const record = () => {
    const node = ui.view().querySelector("[data-act=pad-record]");
    assert.ok(node, "the pad offers Record into pad");
    return node;
  };
  record().dispatchEvent(ui.event("click", { bubbles: true }));
  await ui.settle();
  assert.equal(ui.engine.recorders.length, 1, "the recorder is being built");
  assert.equal(String(record().textContent), "Stop recording", "the page says it is recording already");

  // A second press while the input and the recorder are still being set up
  // cancels it: the one recorder is disposed instead of being left orphaned.
  record().dispatchEvent(ui.event("click", { bubbles: true }));
  await ui.settle();
  ui.releaseRecorder();
  await ui.settle(24);

  assert.equal(ui.engine.recorders.length, 1, "no second recorder was ever built");
  assert.equal(ui.engine.recorders[0].armed, null, "the cancelled recorder never armed");
  assert.equal(ui.engine.recorders[0].disposed, true, "and it was disposed");
  assert.equal(ui.store.pendings.size, 0, "no pending row was left behind");
  assert.equal(String(record().textContent), "Record into pad", "and the page is back to offering one");
});

test("the input a pad recording opened is closed when it ends", async () => {
  const ui = await bootSampler();
  await ui.openSampler();

  ui.view().querySelector("[data-act=pad-record]").dispatchEvent(ui.event("click", { bubbles: true }));
  await ui.settle(24);

  const recorder = ui.engine.recorders[0];
  assert.ok(recorder, "a recorder was built");
  assert.equal(recorder.armed, 0, "armed on this very frame");
  assert.equal(recorder.stopped_at, 5760000, "it ends by itself at 60 s of mono samples");
  assert.notEqual(ui.navigator.track.stopped, true, "the input is open while it records");

  // One chunk of four mono frames, then the recorder's own done.
  recorder.chunk(new Uint8Array(12), 0);
  recorder.done({ segments: [{ segment: 0, frames: 4 }] });
  await ui.settle(60);

  assert.equal(ui.navigator.track.stopped, true, "the input was closed when the recording ended");
  assert.equal(ui.store.pendings.size, 0, "the sample went up and its row went with it");
});

test("with Web Locks, a pad recording uploads from the page that recorded it", async () => {
  // The recording page holds its take's lock while the row has no count; its
  // own upload must wait for that hold to go, not find the lock taken.
  const locks = fakeLocks();
  const ui = await bootSampler({ locks });
  await ui.openSampler();
  ui.view().querySelector("[data-act=pad-record]").dispatchEvent(ui.event("click", { bubbles: true }));
  await ui.settle(24);
  const recorder = ui.engine.recorders[0];
  recorder.chunk(new Uint8Array(12), 0);
  await ui.settle();
  assert.equal(locks.held.size, 1, "the take's lock is held while it records");
  recorder.done({ segments: [{ segment: 0, frames: 4 }] });
  await ui.settle(80);
  assert.equal(ui.requests.filter((request) => request.url.includes("/finish")).length, 1, "it was finished");
  assert.equal(ui.store.pendings.size, 0, "and nothing is left on this device");
  assert.equal(locks.held.size, 0, "and the lock is let go");
});

test("with Web Locks, a resample uploads from the page that recorded it", async () => {
  const locks = fakeLocks();
  const ui = await bootSampler({ locks });
  await ui.openSampler();
  ui.click("[data-act=play]");
  await ui.settle(24);
  const BAR = RATE * 2;
  ui.engine.barFrames = [{ frame: 0, bar: 0 }, { frame: BAR, bar: 1 }];
  const press = () =>
    ui.view().querySelector("[data-act=pad-resample]").dispatchEvent(ui.event("click", { bubbles: true }));
  press();
  await ui.settle(24);
  ui.tapBlocks(BAR / 2 / 128, 128, 0);
  await ui.settle();
  press();
  await ui.settle();
  ui.tapBlocks(BAR / 128, 128, BAR / 2);
  await ui.settle(80);
  assert.equal(ui.requests.filter((request) => request.url.includes("/finish")).length, 1, "it was finished");
  assert.equal(ui.store.pendings.size, 0, "and nothing is left on this device");
  assert.equal(locks.held.size, 0, "and the lock is let go");
});

test("a late first block that starts on a bar line keeps that bar", async () => {
  const ui = await bootSampler();
  await ui.openSampler();
  ui.click("[data-act=play]");
  await ui.settle(24);
  const BAR = RATE * 2;
  // The press resolved to bar 0, but the first block arrives exactly on bar 1.
  ui.engine.barFrames = [{ frame: 0, bar: 0 }, { frame: BAR * 3, bar: 3 }];
  const press = () =>
    ui.view().querySelector("[data-act=pad-resample]").dispatchEvent(ui.event("click", { bubbles: true }));
  press();
  await ui.settle(24);
  ui.tapBlocks(BAR / 128, 128, BAR);
  await ui.settle();
  press();
  await ui.settle();
  ui.tapBlocks((BAR * 2) / 128, 128, BAR * 2);
  await ui.settle(80);
  const rows = ui.store.saved.filter((row) => row.origin === "resample");
  assert.equal(rows[rows.length - 1].frames, BAR * 2, "bars 1 and 2 were kept: bar 1 was not skipped");
});

test("resample with Snap to bar keeps whole bars", async () => {
  const ui = await bootSampler();
  await ui.openSampler();

  // The transport runs, so Snap to bar (on by default) quantizes the resample.
  ui.click("[data-act=play]");
  await ui.settle(24);

  // The engine's clock: the bar the tap starts on, then the bar after the press.
  const BAR = RATE * 2; // 120 BPM: four beats of half a second each
  const WANT = BAR * 4;
  ui.engine.barFrames = [{ frame: 0, bar: 0 }, { frame: WANT, bar: 4 }];

  const button = () => {
    const node = ui.view().querySelector("[data-act=pad-resample]");
    assert.ok(node, "the pad offers Resample output");
    return node;
  };
  button().dispatchEvent(ui.event("click", { bubbles: true }));
  await ui.settle(24);
  assert.equal(ui.engine.taps.at(-1).on, true, "the tap is on");

  // One and a half bars arrive before the second press, from the bar line the
  // tap started on.
  ui.tapBlocks((BAR * 3) / 2 / 128, 128, 0);
  await ui.settle();

  // The second press asks for the next bar line; the blocks keep coming.
  button().dispatchEvent(ui.event("click", { bubbles: true }));
  await ui.settle();
  ui.tapBlocks(2000, 128, (BAR * 3) / 2);
  await ui.settle(60);

  assert.equal(ui.engine.taps.at(-1).on, false, "the tap went off on the stop bar line");

  const rows = ui.store.saved.filter((row) => row.origin === "resample");
  assert.ok(rows.length >= 2, "the row was written before its chunks");
  assert.equal(rows[0].chunk_count, null, "it carries no chunk count until every chunk is stored");
  const last = rows[rows.length - 1];
  assert.equal(last.frames, WANT, "only the four whole bars between the two presses were kept");
  assert.equal(last.frames % BAR, 0, "a whole number of bars");

  const chunkPuts = ui.requests.filter(
    (request) => request.method === "PUT" && request.url.includes(last.take_id + "/chunks/"),
  );
  assert.ok(chunkPuts.length > 0, "the resample uploaded its chunks");
  for (const put of chunkPuts) assert.equal(put.bytes % 6, 0, "each chunk holds whole stereo frames");
  assert.equal(
    chunkPuts.reduce((sum, put) => sum + put.bytes, 0),
    WANT * 6,
    "the four bars and nothing more",
  );
  assert.equal(ui.requests.filter((request) => request.url.endsWith("/finish")).length, 1, "and it finished once");
});

test("resample with Snap to bar starts on the bar line, not after it", async () => {
  const ui = await bootSampler();
  await ui.openSampler();

  // The transport runs, so Snap to bar (on by default) quantizes the resample.
  ui.click("[data-act=play]");
  await ui.settle(24);

  const BAR = RATE * 2; // 120 BPM in 4/4
  // The first press resolves to the bar line at BAR, but the tap's first block
  // is delivered half a bar BEFORE it: the blocks around the press are late.
  ui.engine.barFrames = [{ frame: BAR, bar: 1 }, { frame: BAR * 2, bar: 2 }];

  const button = () => {
    const node = ui.view().querySelector("[data-act=pad-resample]");
    assert.ok(node, "the pad offers Resample output");
    return node;
  };
  button().dispatchEvent(ui.event("click", { bubbles: true }));
  await ui.settle(24);
  assert.equal(ui.engine.taps.at(-1).on, true, "the tap is on");

  // Blocks from half a bar before the bar line through the bar after it: two
  // bars of them, and the sample may keep only the middle one.
  ui.tapBlocks(((BAR * 3) / 2) / 128, 128, BAR / 2);
  await ui.settle();

  button().dispatchEvent(ui.event("click", { bubbles: true }));
  await ui.settle(60);

  assert.equal(ui.engine.taps.at(-1).on, false, "the tap went off on the stop bar line");
  const rows = ui.store.saved.filter((row) => row.origin === "resample");
  const last = rows[rows.length - 1] || {};
  assert.equal(last.frames, BAR, "exactly one bar, from the bar line the press resolved to");

  const chunkPuts = ui.requests.filter(
    (request) => request.method === "PUT" && request.url.includes(last.take_id + "/chunks/"),
  );
  assert.ok(chunkPuts.length > 0, "the resample uploaded its chunks");
  assert.equal(
    chunkPuts.reduce((sum, put) => sum + put.bytes, 0),
    BAR * 6,
    "not one frame from before the bar line or from the bar that followed it",
  );
});

test("a stop bar reached before the press resolves is not overrun", async () => {
  const ui = await bootSampler();
  await ui.openSampler();
  ui.click("[data-act=play]");
  await ui.settle(24);

  const BAR = RATE * 2;
  // The first press resolves to bar 0, and bar 0 is long gone by the time the
  // first block arrives (it starts on bar 1): the sample starts on bar 1.
  ui.engine.barFrames = [{ frame: 0, bar: 0 }, { frame: BAR * 3, bar: 3 }];
  const button = () => {
    const node = ui.view().querySelector("[data-act=pad-resample]");
    assert.ok(node, "the pad offers Resample output");
    return node;
  };
  button().dispatchEvent(ui.event("click", { bubbles: true }));
  await ui.settle(24);

  // Blocks from bar 1 through the middle of bar 3: the stop bar (bar 3) has
  // already gone past by the time the second press resolves to it.
  ui.tapBlocks(((BAR * 5) / 2) / 128, 128, BAR);
  await ui.settle();

  button().dispatchEvent(ui.event("click", { bubbles: true }));
  await ui.settle(60);

  assert.equal(ui.engine.taps.at(-1).on, false, "the tap went off at once");
  const rows = ui.store.saved.filter((row) => row.origin === "resample");
  const last = rows[rows.length - 1] || {};
  assert.equal(last.frames, BAR * 2, "bars 1 and 2: from the first bar line not yet passed to the stop bar");
  const chunkPuts = ui.requests.filter(
    (request) => request.method === "PUT" && request.url.includes(last.take_id + "/chunks/"),
  );
  assert.equal(
    chunkPuts.reduce((sum, put) => sum + put.bytes, 0),
    BAR * 2 * 6,
    "not one frame past the stop bar",
  );
});

test("stopResample ends on the press's block when the transport stopped mid-resample", async () => {
  const ui = await bootSampler();
  await ui.openSampler();
  ui.click("[data-act=play]");
  await ui.settle(24);

  const BAR = RATE * 2;
  ui.engine.barFrames = [{ frame: BAR, bar: 1 }];
  const button = () => {
    const node = ui.view().querySelector("[data-act=pad-resample]");
    assert.ok(node, "the pad offers Resample output");
    return node;
  };
  button().dispatchEvent(ui.event("click", { bubbles: true }));
  await ui.settle(24);
  assert.equal(ui.engine.taps.at(-1).on, true, "the tap is on");

  // Half a bar is recorded, then the transport stops under the resample.
  ui.tapBlocks((BAR / 2) / 128, 128, BAR);
  await ui.settle();
  ui.click("[data-act=stop]");
  await ui.settle(24);

  // The press resolves on the block it lands in, not on a bar line that a
  // stopped transport will never reach.
  ui.ctx().currentTime = (BAR + BAR / 2) / RATE;
  button().dispatchEvent(ui.event("click", { bubbles: true }));
  await ui.settle(60);

  assert.equal(ui.engine.taps.at(-1).on, false, "the tap went off on the press's block");
  assert.equal(ui.engine.barFrames.length, 0, "no further bar line was asked for");
  const rows = ui.store.saved.filter((row) => row.origin === "resample");
  const last = rows[rows.length - 1] || {};
  assert.equal(last.frames, BAR / 2, "the half bar the tap had already gathered");
});

test("cancelling record into pad during the permission prompt closes the input", async () => {
  const ui = await bootSampler({ holdInput: true });
  await ui.openSampler();

  const record = () => {
    const node = ui.view().querySelector("[data-act=pad-record]");
    assert.ok(node, "the pad offers Record into pad");
    return node;
  };
  record().dispatchEvent(ui.event("click", { bubbles: true }));
  await ui.settle();
  assert.notEqual(ui.navigator.track.stopped, true, "the input has not arrived yet");
  assert.equal(String(record().textContent), "Stop recording", "the page says it is recording");

  // A second press cancels it while the permission prompt is still up.
  record().dispatchEvent(ui.event("click", { bubbles: true }));
  await ui.settle();
  ui.releaseInput();
  await ui.settle(24);

  assert.equal(ui.navigator.track.stopped, true, "the input the page opened was closed when it arrived");
  assert.equal(ui.engine.recorders.length, 0, "no recorder was built for a cancelled recording");
  assert.equal(ui.store.pendings.size, 0, "no pending row was left behind");
  assert.equal(String(record().textContent), "Record into pad", "and the page offers one again");
});

test("another tab does not recover a sample still being recorded", async () => {
  // Two tabs of one device share the take store and the Web Locks of the
  // origin. The page recording a sample has a row with no chunk count yet and
  // holds that take's lock; the other tab must leave the row to it.
  const store = fakeTakeStore();
  const locks = fakeLocks();

  const first = await bootSampler({ store, locks });
  await first.openSampler();
  first.view().querySelector("[data-act=pad-record]").dispatchEvent(first.event("click", { bubbles: true }));
  await first.settle(24);

  const recorder = first.engine.recorders[0];
  assert.ok(recorder, "the first tab is recording into the pad");
  recorder.chunk(new Uint8Array(12), 0);
  await first.settle(24);

  const rows = store.saved.filter((row) => row.chunk_count === null);
  assert.equal(rows.length, 1, "the recording page wrote its uncounted row");
  const takeId = rows[0].take_id;
  assert.equal(locks.held.has("studio-take-" + takeId), true, "and it holds the take's lock");

  // The other tab loads its own page against the same device.
  const second = await bootSampler({ store, locks });
  await second.settle(40);

  assert.equal(locks.held.has("studio-take-" + takeId), true, "the recording page still holds its lock");
  assert.equal(
    store.saved.filter((row) => row.chunk_count === null).length,
    1,
    "the other tab never counted the row it found",
  );
  assert.equal(
    store.saved.filter((row) => row.recovered === true).length,
    0,
    "and recovered nothing from a sample that is still being recorded",
  );
  assert.equal(
    second.requests.filter((request) => request.url.endsWith("/finish")).length,
    0,
    "no upload of half a sample was started",
  );
});

test("an import is refused up front when the device plays at an odd rate", async () => {
  const ui = await bootSampler({ rate: 32000 });
  await ui.openSampler();

  const input = ui.view().querySelector("[data-act=sample-import]");
  Object.defineProperty(input, "files", { value: [fileStub("kick.wav", IMPORT_FILE_BYTES)], configurable: true });
  input.dispatchEvent(ui.event("change", { target: input }));
  await ui.settle(24);

  const toast = ui.document.querySelector("[data-role=toast]");
  assert.equal(
    String(toast.textContent),
    "This device plays at 32000 Hz; a sample is kept at 44.1, 48, 88.2 or 96 kHz.",
    "the page says which rates a sample may have",
  );
  assert.equal(ui.store.pendings.size, 0, "nothing was staged");
  assert.equal(
    ui.requests.filter((request) => request.url.indexOf("/chunks/") >= 0).length,
    0,
    "and no chunk was sent",
  );
});

test("a window blur lets every held pad key go", async () => {
  const ui = await bootSampler();
  const bankId = await bankIdOf(ui.doc);
  await ui.openSampler();

  ui.document.dispatchEvent(ui.event("keydown", { key: "3" }));
  await ui.settle(24);
  assert.equal(ui.engine.livePads.length, 1, "key 3 played a pad");

  // The window lost the focus: the keyup it never sends is not waited for.
  for (const handler of [...(ui.windowListeners.blur || [])]) handler(ui.event("blur", {}));
  await ui.settle();
  assert.deepEqual(
    ui.engine.releases,
    [{ track_id: TRACK, bank_id: bankId, index: 2 }],
    "the held key was let go",
  );
});

// ---- part 2: the steps, the chop editor, the patterns and the chain --------

test("toggling steps sends one step.toggle each", async () => {
  const ui = await bootSampler();
  const bankId = await bankIdOf(ui.doc);
  await ui.openSampler();

  // The selected pad's lane of the shown pattern: sixteen buttons for a
  // sixteen-step pattern, all empty to begin with.
  assert.equal(ui.steps().length, 16, "sixteen step buttons are drawn");
  for (const node of ui.steps()) {
    assert.equal(String(node.tagName), "BUTTON", "a step is a real button");
    assert.equal(node.getAttribute("aria-pressed"), "false", "an empty step says it is off");
  }
  assert.equal(
    ui.slot("sampler-steps").querySelectorAll("[data-act=step-page]").length,
    0,
    "a sixteen-step pattern has no pages to turn",
  );

  // One click, one step.toggle; and the button says it is on from the document.
  ui.step(0).dispatchEvent(ui.event("click", { bubbles: true }));
  await ui.settle();
  let sent = commands(ui, "step.toggle");
  assert.equal(sent.length, 1, "one step.toggle for one click");
  assert.deepEqual(
    sent[0].args,
    { clip_id: CLIP, pattern_id: "a", at: 0, bank_id: bankId, index: 0 },
    "naming the clip, the pattern, the position and the pad's lane",
  );

  await ui.apply("step.toggle", stepArgs(bankId, 0));
  assert.equal(ui.step(0).getAttribute("aria-pressed"), "true", "the step the document holds is on");
  const fill = ui.step(0).querySelector("[data-role=step-fill]");
  assert.ok(fill, "an on step draws its velocity as a fill");
  assert.equal(fill.style.height, "79%", "the default velocity 100 fills 79% of the step");

  // A second position, one more command; and a click on an ON step takes it off.
  ui.step(4).dispatchEvent(ui.event("click", { bubbles: true }));
  await ui.settle();
  assert.equal(commands(ui, "step.toggle").length, 2, "a second click is a second step.toggle");
  assert.equal(commands(ui, "step.toggle")[1].args.at, 4);

  ui.step(4).dispatchEvent(ui.event("click", { bubbles: true }));
  await ui.settle();
  sent = commands(ui, "step.toggle");
  assert.equal(sent.length, 3, "taking a step off is one step.toggle too");
  assert.equal(sent[2].args.at, 4, "on the step that was clicked");
  assert.equal(commands(ui, "pad.set").length, 0, "no pad setting was touched");
});

test("holding a step and turning cutoff sets a lock", async () => {
  const ui = await bootSampler();
  const bankId = await bankIdOf(ui.doc);
  await ui.openSampler();
  await ui.apply("step.toggle", stepArgs(bankId, 2));
  assert.equal(ui.step(2).getAttribute("aria-pressed"), "true", "step 3 is on");

  // The step is held down, and the pad's cutoff is turned while it is.
  ui.holdStep(2);
  await ui.settle();
  const cutoff = ui.view().querySelector("[data-pad-field=filter.cutoff_hz]");
  assert.ok(cutoff, "the pad's filter cutoff is a control");
  cutoff.value = "800";
  cutoff.dispatchEvent(ui.event("input", { target: cutoff }));
  cutoff.dispatchEvent(ui.event("change", { target: cutoff }));
  await ui.settle();

  let locks = commands(ui, "step.set");
  assert.equal(locks.length, 1, "the control's release is one step.set");
  assert.deepEqual(locks[0].args, {
    clip_id: CLIP,
    pattern_id: "a",
    at: 2,
    bank_id: bankId,
    index: 0,
    locks: { cutoff_hz: 800 },
  }, "carrying that one lock on the held step");
  assert.equal(commands(ui, "pad.set").length, 0, "the pad itself is not changed");

  // Letting the step go writes nothing more.
  ui.release();
  await ui.settle();
  assert.equal(commands(ui, "step.set").length, 1, "the release adds no second step.set");

  // The lock lands on the step being played, not on the pad's lane for good.
  await ui.apply("step.set", { ...stepArgs(bankId, 2), locks: { cutoff_hz: 800 } });
  assert.ok(ui.step(2).querySelector(".st-step-lock-dot"), "a locked step shows a dot");

  // Clear locks, on the selected step, is one step.clear_locks.
  const clear = ui.slot("sampler-steps").querySelector("[data-act=step-clear-locks]");
  assert.ok(clear, "the selected step offers Clear locks");
  assert.equal(clear.disabled, false);
  clear.dispatchEvent(ui.event("click", { bubbles: true }));
  await ui.settle();
  const cleared = commands(ui, "step.clear_locks");
  assert.equal(cleared.length, 1, "one step.clear_locks");
  assert.equal(cleared[0].args.at, 2, "on the step that has the lock");

  // A control turned with no step held is the pad's own, as it always was.
  const gain = ui.view().querySelector("[data-pad-field=gain_db]");
  gain.value = "-3";
  gain.dispatchEvent(ui.event("change", { target: gain }));
  await ui.settle();
  assert.equal(commands(ui, "step.set").length, 1, "no lock without a held step");
  assert.equal(commands(ui, "pad.set").length, 1, "the pad takes that change instead");
});

test("auto-chop then assign fills the pads in order", async () => {
  const audio = hitsWav(4);
  const ui = await bootSampler({ sampleAudio: audio.bytes });
  const { sampleId, bankId } = await putSample(ui, { frames: audio.frames });
  await ui.openSampler();
  // The waveform is fetched and decoded once; the chop then runs inline.
  await ui.settle(60);

  const chop = ui.slot("sampler-chop");
  const head = String(chop.querySelector(".st-chop-head").textContent);
  assert.match(head, /porch-knocks/, "the editor names the sample");
  assert.match(head, /0 slices/, "and says it has none yet");
  assert.match(head, /pad A01 = the whole sample/, "and what the pad plays");

  const hits = chop.querySelector("[data-act=chop-hits]");
  assert.ok(hits, "Auto-chop by hits is offered");
  hits.dispatchEvent(ui.event("click", { bubbles: true }));
  await ui.settle(60);

  const sent = commands(ui, "slice.set");
  assert.equal(sent.length, 1, "one chop is one slice.set");
  assert.equal(sent[0].args.sample_id, sampleId);
  const sliced = sent[0].args.slices;
  assert.ok(sliced.length >= 4, `the four hits were found (got ${sliced.length} slices)`);
  for (const slice of sliced) {
    assert.match(String(slice.id), /^sl-/, "a new slice gets an id of its own");
    assert.ok(slice.end_frame > slice.start_frame, "and holds audio");
  }
  assert.equal(new Set(sliced.map((slice) => slice.id)).size, sliced.length, "every id is its own");

  // The document takes the chop, and the editor shows it.
  await ui.apply("slice.set", { sample_id: sampleId, slices: sliced });
  assert.equal(ui.markers().length, sliced.length, "one marker per slice start");
  assert.match(
    String(ui.slot("sampler-chop").querySelector(".st-chop-head").textContent),
    new RegExp(`${sliced.length} slices`),
    "the editor counts the slices the document holds",
  );

  // Assign slices to pads: one pad.assign per pad, from this one on. (The
  // editor is drawn again from the snapshot, so the buttons are looked up
  // afresh each time.)
  const assignButton = () => ui.slot("sampler-chop").querySelector("[data-act=chop-assign]");
  assignButton().dispatchEvent(ui.event("click", { bubbles: true }));
  await ui.settle(20);
  const assigns = commands(ui, "pad.assign");
  assert.equal(assigns.length, sliced.length, "one pad.assign per slice");
  for (let at = 0; at < sliced.length; at += 1) {
    assert.deepEqual(assigns[at].args, {
      track_id: TRACK,
      bank_id: bankId,
      index: at,
      sample_id: sampleId,
      slice_id: sliced[at].id,
    }, `pad ${at + 1} takes slice ${at + 1}`);
  }

  // The document takes them, and assigning again steals nothing: every pad
  // already plays the slice it was given.
  for (const assign of assigns) await ui.apply("pad.assign", assign.args);
  assignButton().dispatchEvent(ui.event("click", { bubbles: true }));
  await ui.settle(20);
  assert.equal(commands(ui, "pad.assign").length, assigns.length, "no pad is assigned twice");

  // A pad that holds a different sound is left alone, and named in one notice.
  await ui.apply("sample.add", {
    sample: {
      id: "0b7f3d1e-1711-4d5f-9d18-2f7f52c9a3b4",
      storage_key: `${PREFIX}studio/song-1/samples/0b7f3d1e.wav`,
      rate: RATE,
      channels: 1,
      frames: FRAMES,
      name: "rim",
      origin: "import",
      author_label: "You",
    },
  });
  await ui.apply("pad.assign", {
    track_id: TRACK, bank_id: bankId, index: 1,
    sample_id: "0b7f3d1e-1711-4d5f-9d18-2f7f52c9a3b4",
  });
  const before = commands(ui, "pad.assign").length;
  assignButton().dispatchEvent(ui.event("click", { bubbles: true }));
  await ui.settle(20);
  assert.equal(commands(ui, "pad.assign").length, before, "a pad holding another sound is skipped");
  const notice = ui.document.querySelector("[data-role=toast]");
  assert.match(String(notice.textContent), /A02/, "and the notice names it");
});

test("chain editor sends one chain.set", async () => {
  const ui = await bootSampler();
  await ui.openSampler();

  // An empty chain plays the clip's first pattern on repeat.
  assert.match(String(ui.chain().textContent), /Chain:/, "the chain is labelled");
  assert.match(
    String(ui.chain().textContent),
    /plays pattern A on repeat/,
    "an empty chain says what it plays instead",
  );

  const add = () => ui.chain().querySelector("[data-act=chain-add]");
  assert.ok(add(), "the shown pattern can be added to the chain");
  add().dispatchEvent(ui.event("click", { bubbles: true }));
  await ui.settle();
  let sent = commands(ui, "chain.set");
  assert.equal(sent.length, 1, "adding is one chain.set");
  assert.deepEqual(sent[0].args, { clip_id: CLIP, chain: ["a"] }, "carrying the whole chain");

  await ui.apply("chain.set", sent[0].args);
  assert.match(String(ui.chain().textContent), /A/, "the chip is drawn");

  // A second add is another whole chain, not a patch of the first.
  add().dispatchEvent(ui.event("click", { bubbles: true }));
  await ui.settle();
  sent = commands(ui, "chain.set");
  assert.equal(sent.length, 2, "one chain.set per change");
  assert.deepEqual(sent[1].args.chain, ["a", "a"], "the whole new chain");
  await ui.apply("chain.set", sent[1].args);
  assert.equal(ui.chain().querySelectorAll(".st-chain-chip").length, 2, "two chips are drawn");
  assert.deepEqual(
    [...ui.chain().querySelectorAll(".st-chain-name")].map((node) => String(node.textContent)),
    ["A", "A"],
    "in the order they play, joined by an arrow",
  );
  assert.match(String(ui.chain().textContent), /\u2192/, "the chips are chained in order");

  // Moving one is one chain.set; so is taking one out.
  ui.chain().querySelectorAll("[data-act=chain-left]")[1]
    .dispatchEvent(ui.event("click", { bubbles: true }));
  await ui.settle();
  sent = commands(ui, "chain.set");
  assert.equal(sent.length, 3, "moving a chip is one chain.set");
  assert.deepEqual(sent[2].args.chain, ["a", "a"], "the whole chain, reordered");

  ui.chain().querySelector("[data-act=chain-remove]")
    .dispatchEvent(ui.event("click", { bubbles: true }));
  await ui.settle();
  sent = commands(ui, "chain.set");
  assert.equal(sent.length, 4, "removing a chip is one chain.set");
  assert.deepEqual(sent[3].args.chain, ["a"], "with that chip gone");
});

test("dragging a slice marker sends one slice.set on release", async () => {
  const audio = hitsWav(4);
  const ui = await bootSampler({ sampleAudio: audio.bytes });
  const { sampleId } = await putSample(ui, { frames: audio.frames });
  // Four slices to begin with: 0…2400, 2400…4800, 4800…7200, 7200…9600.
  const frames = audio.frames;
  const quarter = Math.round(frames / 4);
  const fixed = Array.from({ length: 4 }, (_, at) => ({
    id: `sl-${at + 1}`,
    start_frame: at * quarter,
    end_frame: at === 3 ? frames : (at + 1) * quarter,
  }));
  await ui.apply("slice.set", { sample_id: sampleId, slices: fixed });
  await ui.openSampler();
  await ui.settle(60);
  assert.equal(ui.markers().length, 4, "one marker per slice start");

  // The second marker sits a quarter of the way across the 800-wide viewBox.
  const marker = ui.markers()[1];
  assert.equal(marker.getAttribute("data-slice-id"), "sl-2");
  assert.equal(marker.getAttribute("x1"), "200");

  // A drag moves the marker on screen; nothing is sent while it moves.
  ui.dragMarker(1, 200, 300);
  await ui.settle();
  assert.equal(commands(ui, "slice.set").length, 0, "a drag sends nothing until it ends");
  assert.equal(marker.getAttribute("x1"), "300", "and the marker follows the pointer");

  // The release is where the one command goes.
  ui.release();
  await ui.settle();
  const sent = commands(ui, "slice.set");
  assert.equal(sent.length, 1, "one slice.set for the whole drag");
  assert.equal(sent[0].args.sample_id, sampleId);
  const want = Math.round((300 / 800) * frames);
  const next = sent[0].args.slices;
  assert.equal(next.length, 4, "the whole slice set is sent");
  assert.equal(next[1].start_frame, want, "the dragged slice starts where the marker was let go");
  assert.equal(next[0].end_frame, want, "and the slice before it ends there, so they still tile");
  assert.deepEqual(next.map((slice) => slice.id), ["sl-1", "sl-2", "sl-3", "sl-4"], "every id is kept");
  assert.equal(next[2].start_frame, fixed[2].start_frame, "a slice the drag did not touch is unchanged");
  assert.equal(next[3].end_frame, frames, "the last slice still runs to the end");
});

test("a pattern longer than 16 steps pages its steps", async () => {
  const ui = await bootSampler({ doc: await samplerDoc({ lengthSteps: 32 }) });
  await ui.openSampler();

  // The first page is drawn, and the two page tabs with it.
  assert.equal(ui.steps().length, 16, "one page of sixteen buttons");
  assert.equal(ui.steps()[0].getAttribute("data-at"), "0");
  const tabs = () => [...ui.slot("sampler-steps").querySelectorAll("[data-act=step-page]")];
  assert.equal(tabs().length, 2, "a thirty-two-step pattern has two pages");
  assert.deepEqual(tabs().map((node) => String(node.textContent)), ["1-16", "17-32"]);
  assert.equal(tabs()[0].getAttribute("aria-pressed"), "true", "the first page is the one shown");

  // The second page is positions 17-32, and toggling there names that position.
  tabs()[1].dispatchEvent(ui.event("click", { bubbles: true }));
  await ui.settle();
  assert.equal(tabs()[1].getAttribute("aria-pressed"), "true", "the second page is shown");
  assert.equal(ui.steps().length, 16, "still sixteen buttons");
  assert.equal(ui.steps()[0].getAttribute("data-at"), "16", "starting at position 17");
  assert.equal(ui.steps()[0].textContent, "1", "labelled 1 within its page");

  ui.step(16).dispatchEvent(ui.event("click", { bubbles: true }));
  await ui.settle();
  const sent = commands(ui, "step.toggle");
  assert.equal(sent.length, 1, "one step.toggle");
  assert.equal(sent[0].args.at, 16, "at the position the page shows");

  // Sixty-four positions are four pages, and the last one holds sixteen too.
  await ui.apply("pattern.set_length", { clip_id: CLIP, length_steps: 64 });
  assert.equal(tabs().length, 4, "sixty-four steps are four pages");
  tabs()[3].dispatchEvent(ui.event("click", { bubbles: true }));
  await ui.settle();
  assert.equal(ui.steps().length, 16, "the last page is full");
  assert.equal(ui.steps()[0].getAttribute("data-at"), "48", "and starts at position 49");

  // While the transport runs, the page follows the playhead instead.
  ui.click("[data-act=play]");
  await ui.settle(24);
  ui.playhead(2, 1, 1);
  await ui.settle();
  assert.equal(tabs()[1].getAttribute("aria-pressed"), "true", "the playhead's page is turned to");
  assert.equal(ui.steps()[0].getAttribute("data-at"), "16", "and starts at position 17");
});

test("a refused chop shows the refusal and draws the document's slices", async () => {
  const audio = hitsWav(4);
  const ui = await bootSampler({ sampleAudio: audio.bytes });
  const { sampleId } = await putSample(ui, { frames: audio.frames });
  const quarter = Math.round(audio.frames / 4);
  const fixed = Array.from({ length: 4 }, (_, at) => ({
    id: `sl-${at + 1}`,
    start_frame: at * quarter,
    end_frame: at === 3 ? audio.frames : (at + 1) * quarter,
  }));
  await ui.apply("slice.set", { sample_id: sampleId, slices: fixed });
  await ui.openSampler();
  await ui.settle(60);
  const before = ui.markers().map((marker) => marker.getAttribute("x1"));
  assert.equal(before.length, 4, "four markers to begin with");

  // A pad still plays one of these slices, so the hub refuses the re-chop.
  ui.slot("sampler-chop").querySelector("[data-act=chop-hits]")
    .dispatchEvent(ui.event("click", { bubbles: true }));
  await ui.settle(60);
  const sent = commands(ui, "slice.set");
  assert.equal(sent.length, 1, "the chop went as one slice.set");
  const refusal = "Pad 1 of bank A still plays slice sl-2 of this sample; clear that pad before removing the slice.";
  ui.frame({ type: "result", cmd_id: sent[0].cmd_id, ok: false, error: refusal });
  await ui.settle();

  const toast = ui.document.querySelector("[data-role=toast]");
  assert.equal(String(toast.textContent), refusal, "the hub's sentence is shown");
  assert.match(
    String(ui.slot("sampler-chop").querySelector(".st-chop-error").textContent),
    /still plays slice sl-2/,
    "and the editor keeps it beside the waveform",
  );
  assert.deepEqual(
    ui.markers().map((marker) => marker.getAttribute("x1")),
    before,
    "the markers are drawn again from the document, so no slice a pad plays is gone",
  );
});

test("an agent's step edit appears without a reload", async () => {
  const ui = await bootSampler();
  const bankId = await bankIdOf(ui.doc);
  await ui.openSampler();
  assert.equal(ui.step(1).getAttribute("aria-pressed"), "false", "step 2 starts empty");

  // The hub applies an agent's command and broadcasts the document: the page
  // draws what the document holds, with no reload and no local guess.
  await ui.apply("step.toggle", stepArgs(bankId, 1));
  assert.equal(ui.step(1).getAttribute("aria-pressed"), "true", "the agent's step is drawn");
  assert.ok(ui.step(1).querySelector("[data-role=step-fill]"), "with its velocity");

  // A lock the agent set on another step shows as that step's dot.
  await ui.apply("step.toggle", stepArgs(bankId, 5));
  assert.equal(ui.step(5).getAttribute("aria-pressed"), "true", "the agent's step is drawn");
  await ui.apply("step.set", { ...stepArgs(bankId, 5), locks: { gain_db: -6, pitch: 3 } });
  assert.ok(ui.step(5).querySelector(".st-step-lock-dot"), "the agent's lock shows on the step");

  // And the agent's chain is drawn as the document has it.
  await ui.apply("chain.set", { clip_id: CLIP, chain: ["a"] });
  assert.match(String(ui.chain().textContent), /A/, "the chain the agent set is drawn");

  // Taking both steps off shows on the page as well.
  await ui.apply("step.toggle", stepArgs(bankId, 1));
  assert.equal(ui.step(1).getAttribute("aria-pressed"), "false", "the step is gone again");
  assert.equal(ui.step(1).querySelector("[data-role=step-fill]"), null, "and draws no velocity");
});

// ---- the live half: a real Chrome against a real hub ------------------------

const LIVE_BUNDLE_DIR = new URL("../bundles/studio", import.meta.url).pathname.replace(/\/$/, "");
const LIVE_HUMAN = { kind: "human", id: "local", label: "You" };

let chrome = null;
let server = null;
let upgrades = null;
let db = null;
let hub = null;
let base = "";
let songId = "";
let dir = "";
/** The object store the upload service writes the finished sample into. */
let objects = new Map();

function liveAcl() {
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

function cookieOf(header, name) {
  for (const part of String(header || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

/** The three `storage_files` statements the upload service runs, and nothing else. */
function uploadDb() {
  return {
    async execute(statement) {
      const sql = typeof statement === "string" ? statement : statement.sql;
      if (/storage_prefix/i.test(sql)) return { rows: [{ storage_prefix: PREFIX }] };
      return { rows: [] };
    },
  };
}

before(async () => {
  chrome = await startHeadlessChrome({ extraArgs: ["--autoplay-policy=no-user-gesture-required"] });
  if (!chrome) return;

  dir = mkdtempSync(join(tmpdir(), "studio-panel-sampler-"));
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
    acl: liveAcl(),
    onBroadcast: (id, payload) => webRef.web?.broadcast(id, payload),
  });

  const storage = {
    async putObjectStream(key, stream) {
      const pieces = [];
      for await (const piece of stream) pieces.push(Buffer.from(piece));
      objects.set(key, Buffer.concat(pieces));
    },
    async deleteObject(key) {
      objects.delete(key);
    },
    async getBucketStats() {
      return { fileCount: objects.size, totalSizeBytes: 0 };
    },
    defaultBucket: () => "crow-files",
  };
  const takeStorage = {
    defaultBucket: () => "crow-files",
    storagePrefixFor: async () => PREFIX,
    async getObject(key) {
      const bytes = objects.get(key);
      if (!bytes) throw new Error(`there is no object at ${key}`);
      return { stream: Readable.from([bytes]), stat: { size: bytes.length } };
    },
  };
  const takeUploads = createTakeUploads({
    stagingDir: mkdtempSync(join(dir, "staging-")),
    storage,
    db: uploadDb(),
    acl: liveAcl(),
    hub,
    songs: { projectOf: async () => PROJECT },
    now: () => Date.now(),
    quotaMb: 5120,
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
    bundleDir: LIVE_BUNDLE_DIR,
    takeUploads,
    takeStorage,
    songRowOf: async (id) => (await hub.listSongs({ project_ids: [PROJECT] })).find((row) => row.id === id) ?? null,
    rawBody: (limit) => express.raw({ type: () => true, limit, inflate: false }),
  });
  webRef.web = web;

  const created = await hub.createSong({ project_id: PROJECT, title: "Sampler song", author: LIVE_HUMAN });
  assert.equal(created.ok, true, `createSong was refused: ${created.error}`);
  songId = created.song_id;

  for (const [command, args] of [
    ["track.add", { id: TRACK, name: "Beat box", kind: "sampler" }],
    ["scene.add", { id: SCENE, name: "Verse" }],
    ["clip.add_pattern", { clip_id: CLIP, track_id: TRACK, scene_id: SCENE, name: "Beat", length_steps: 16 }],
  ]) {
    const result = await hub.runCommand({ song_id: songId, cmd_id: null, command, args, author: LIVE_HUMAN });
    assert.equal(result.ok, true, `${command} was refused: ${result.error}`);
  }

  const app = express();
  app.use(express.json({ limit: "1mb" }));
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

/** Open one page in the private browser with the dashboard's session cookies. */
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

/** Poll a page until `expression` is truthy. */
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

/** @returns {object|undefined} pad A01 of the fixture track's one bank */
function padOf(snap) {
  const bank = Object.values(snap.banks || {})[0];
  return bank ? Object.values(snap.pads || {}).find((pad) => pad.track_id === TRACK && pad.bank_id === bank.id && pad.index === 0) : undefined;
}

test("a file imported in Chrome lands on its pad through the real upload", async (t) => {
  if (!chrome) return t.skip("no headless Chrome available");

  const page = await openPage(`${base}/dashboard/studio?song=${encodeURIComponent(songId)}`);
  t.after(() => page.close());
  assert.ok(
    await waitFor(page, `!!document.querySelector('[data-clip-id=${CLIP}]')`, 20000),
    "the song's pattern clip is on the grid (the page's Yjs replica did not load)",
  );

  // Open the pad view and select pad A01.
  assert.equal(
    await page.evaluate(`(function () {
      var open = document.querySelector('[data-act=open-clip][data-clip-id=${CLIP}]');
      if (!open) return false;
      open.click();
      return true;
    })()`),
    true,
    "the pattern clip offers its open button",
  );
  assert.ok(
    await waitFor(
      page,
      "(function () { var host = document.querySelector('[data-role=sampler]'); return !!host && !host.hidden && !!host.querySelector('[data-act=pad][data-pad-index=\"0\"]'); })()",
      10000,
    ),
    "the pad view opened with its pads",
  );
  await page.evaluate("document.querySelector('[data-role=sampler] [data-act=pad][data-pad-index=\"0\"]').click(), true");

  // A WAV made in the page: 0.5 s of 440 Hz at 48 kHz, 16-bit mono, handed to
  // the import input as a real File through a DataTransfer.
  const fed = await page.evaluate(`(function () {
    var input = document.querySelector('[data-role=sampler] input[data-act=sample-import][data-pad-index="0"]');
    if (!input) return 'no import input for pad A01';
    var rate = 48000, frames = rate / 2;
    var bytes = new ArrayBuffer(44 + frames * 2);
    var view = new DataView(bytes);
    var tag = function (at, text) { for (var i = 0; i < text.length; i += 1) view.setUint8(at + i, text.charCodeAt(i)); };
    tag(0, 'RIFF'); view.setUint32(4, 36 + frames * 2, true); tag(8, 'WAVE');
    tag(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    tag(36, 'data'); view.setUint32(40, frames * 2, true);
    for (var n = 0; n < frames; n += 1) {
      view.setInt16(44 + n * 2, Math.round(Math.sin(2 * Math.PI * 440 * n / rate) * 0.5 * 32767), true);
    }
    var file = new File([bytes], 'sine440.wav', { type: 'audio/wav' });
    var transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
  assert.equal(fed, "ok", String(fed));

  // The hub's song gets the sample, and pad A01 points at it.
  const landed = await waitForSong((snap) => {
    const sample = Object.values(snap.samples || {}).find((row) => row.origin === "import");
    if (!sample) return false;
    return padOf(snap)?.sample_id === sample.id;
  });
  const sample = Object.values(landed.samples || {}).find((row) => row.origin === "import");
  assert.ok(sample, "the song holds an imported sample");
  assert.equal(padOf(landed)?.sample_id, sample.id, "pad A01 plays the imported sample");

  // 0.5 s at the rate the panel uploaded (the context's rate, within a frame).
  assert.ok(sample.rate > 0, "the sample carries a rate");
  assert.ok(
    Math.abs(sample.frames - sample.rate * 0.5) <= 1,
    `0.5 s at ${sample.rate} Hz is ${sample.rate * 0.5} frames (got ${sample.frames})`,
  );

  // The page's pad shows the sample's name, and no longer says Uploading.
  const shown = await waitFor(
    page,
    `(function () {
      var node = document.querySelector('[data-role=sampler] [data-act=pad][data-pad-index="0"] .st-pad-name');
      var text = node ? node.textContent : '';
      return text && text.indexOf('Uploading') < 0 && text === ${JSON.stringify(sample.name)} ? text : false;
    })()`,
    15000,
  );
  assert.equal(shown, sample.name, "pad A01 shows the sample's name once the upload is through");

  // One pad assignment in the shared history (the upload's own, empty-only one).
  const entries = await hub.history(songId, { limit: 100 });
  const assigns = entries.filter((entry) => /^pad\.assign/.test(String(entry.command)));
  assert.equal(assigns.length, 1, `exactly one pad assignment (got ${assigns.map((e) => e.command).join(", ")})`);
  assert.equal(assigns[0].args.sample_id, sample.id, "and it is for the imported sample");
});
