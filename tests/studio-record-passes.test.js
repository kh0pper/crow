/**
 * Studio panel — a looped recording split into one take per pass, and where
 * playback puts each take.
 *
 * One test, no browser: the emitted client script runs against a linkedom
 * document built from the page the handler renders, with a real Yjs song, a
 * fake take store, a fake recorder and a fake audio context. A calibrated
 * input measures a 1,200-frame round trip at 48 kHz, the recorder is armed at
 * frame 48,000, and three loop passes are recorded — one chunk per pass, so the
 * page writes a pending row for each pass. The rows the page kept are then read
 * back and placed with the sequencer's own formula, which is what an operator
 * hears.
 *
 * The model: a click played at the start of pass k sits at context frame
 * `arm + round(k * loop)`, and the interface hands it back `rec_offset` frames
 * later, so inside take k it sits at `clickContext - takeFirstFrame`. Playback
 * reads that take frame from the stored `offset_frames`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import studioPanel from "../bundles/studio/panel/studio.js";

/** The audio track recordings go on. */
const AUDIO_TRACK = "gtr";

/** The scene the recording is launched in. */
const SCENE = "verse";

/** The frame the launch reports, and the frame the recorder arms on. */
const ARM_FRAME = 48000;

/** The context's rate. */
const RATE = 48000;

/** The song's tempo: 12,000 frames a beat, so every pass length is exact. */
const BPM = 240;

/** The bars an empty slot's new audio clip gets (four, see sceneLengthBars). */
const BARS = 4;

/** @returns {number} frames per beat at this rate and tempo. */
function framesPerBeat() {
  return (RATE * 60) / BPM;
}

/** @returns {number} one loop pass, in frames: the page's own exact pass length. */
function loopFrames() {
  return BARS * 4 * framesPerBeat();
}

/** The calibrated round trip this test's input reports: 1,200 frames. */
const ROUND_TRIP = 1200;

/** The take store's measurement for the armed input. */
const CALIBRATED = { latency_frames: ROUND_TRIP, rate: RATE, spread_frames: 0 };

/**
 * One pass's single chunk. Its frame count only has to be more than the round
 * trip the take is cut by, or the page drops the row as holding nothing played.
 */
const PASS_FRAMES = 4000;

/** That pass's chunks in bytes: 24-bit stereo. */
const PASS_BYTES = PASS_FRAMES * 3 * 2;

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

/** The document the mock client draws: one audio track and one scene. */
async function recordingDoc(bpm = BPM) {
  const { newSongDoc } = await import("../bundles/studio/server/doc.js");
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  await import("../bundles/studio/server/commands/core.js");
  const doc = newSongDoc({ title: "Recording song", bpm });
  runCommand(doc, "track.add", { id: AUDIO_TRACK, name: "Guitar", kind: "audio" });
  runCommand(doc, "scene.add", { id: SCENE, name: "Verse" });
  return doc;
}

/**
 * The panel's take store, in memory: the same API, and a log of what it was
 * asked to keep.
 * @param {{latency?: object, log?: string[]}} [options]
 */
function fakeTakeStore({ latency = null, log = [] } = {}) {
  const chunks = new Map();
  const pendings = new Map();
  const latencyRows = new Map();
  if (latency) latencyRows.set("any", latency);
  return {
    chunks,
    pendings,
    latencyRows,
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
    async putPending(value) {
      pendings.set(value.take_id, value);
      return true;
    },
    async deletePending(takeId) {
      pendings.delete(takeId);
      for (const key of Array.from(chunks.keys())) {
        if (key.startsWith(takeId + ":")) chunks.delete(key);
      }
      return true;
    },
    async getLatency(key) {
      // A single measurement answers for whatever key the page asks about.
      return latencyRows.get(key) || latencyRows.get("any") || null;
    },
    async putLatency(key, value) {
      latencyRows.set(key, value);
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

/** A context stand-in: the three nodes the panel builds, and its clock. */
function fakeContext(nowSeconds = 0) {
  const gain = { gain: { value: 1 }, connect() {}, disconnect() {} };
  return {
    sampleRate: RATE,
    state: "running",
    currentTime: nowSeconds,
    destination: {},
    createGain: () => gain,
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
    resume: async () => {},
    close() {},
  };
}

/** A MediaStream stand-in whose one track calls itself "Test input". */
function fakeStream() {
  const track = {
    label: "Test input",
    getSettings: () => ({
      deviceId: "test-input",
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    }),
    stop() {},
  };
  return { getTracks: () => [track], getAudioTracks: () => [track] };
}

/** The engine stand-in: one fake recorder the test drives by hand. */
function fakeEngine() {
  const engine = {
    recorders: [],
    launches: [],
    node: { connect() {} },
    setSong() {},
    play() {},
    stop() {},
    stopAll() {},
    unloadAudio() {},
    async loadAudio() {},
    onPosition() {
      return () => {};
    },
    onError() {
      return () => {};
    },
    onLaunch(listener) {
      engine.launches.push(listener);
      return () => {};
    },
    // No master latency is ever announced here, so the delay the page adds to a
    // take is the interface's round trip and nothing else.
    latencyListeners: [],
    onMasterLatency(listener) {
      engine.latencyListeners.push(listener);
      return () => {};
    },
    announceLatency(latency) {
      for (const listener of engine.latencyListeners) listener(latency);
    },
    async nextBarFrame() {
      return { frame: ARM_FRAME, bar: 1 };
    },
    async calibrate() {
      return { latency_frames: ROUND_TRIP, rate: RATE, spread_frames: 0, clicks_heard: 14 };
    },
    async createRecorder() {
      const recorder = {
        armFrame: null,
        stopFrame: null,
        splits: [],
        onChunk(listener) {
          recorder.chunk = listener;
        },
        onDone(listener) {
          recorder.done = listener;
        },
        armAt(frame) {
          recorder.armFrame = frame;
        },
        stopAt(frame) {
          recorder.stopFrame = frame;
        },
        splitAt(frames) {
          recorder.splits = frames;
        },
        dispose() {
          recorder.disposed = true;
        },
      };
      engine.recorders.push(recorder);
      return recorder;
    },
  };
  return engine;
}

/**
 * Boot the emitted client script against the page the handler renders, with a
 * fake browser around it.
 *
 * @param {{latency?: object, bpm?: number, store?: object, gateFinish?: boolean}} [options]
 */
async function bootPanel(options = {}) {
  const { parseHTML } = await import("linkedom");
  const { pathToFileURL } = await import("node:url");
  const { encodeDocState } = await import("../bundles/studio/server/doc.js");
  const { CLIENT_SCRIPT } = await import("../bundles/studio/panel/client.js");
  const { TAKE_STORE_SCRIPT } = await import("../bundles/studio/panel/take-store.js");

  const doc = await recordingDoc(options.bpm);
  const res = {
    html: "",
    headersSent: false,
    send(body) {
      this.html = String(body);
      this.headersSent = true;
    },
  };
  await studioPanel.handler({ query: { song: "song-1" }, headers: {} }, res, {
    db: panelDb(),
    layout: minimalLayout,
  });
  assert.ok(res.html.includes("data-studio-song=\"song-1\""), "the handler rendered the song page");
  const { document, window: domWindow } = parseHTML(res.html);

  const log = [];
  const store = options.store || fakeTakeStore({ latency: options.latency || null, log });
  const engine = fakeEngine();
  const sent = [];
  const requests = [];
  let releaseFinish = () => {};
  const finishGate = new Promise((resolve) => {
    releaseFinish = resolve;
  });

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

  const fetchStub = async (url, init = {}) => {
    const target = String(url);
    requests.push({
      url: target,
      method: init.method || "GET",
      body: typeof init.body === "string" ? init.body : null,
    });
    log.push("fetch " + target);
    if (target.includes("/finish")) {
      // A test may hold the finishes open to look at the rows mid-upload.
      if (options.gateFinish) await finishGate;
      return response(200, { take: { id: "0a1b2c3d-0000-4000-8000-000000000000" } });
    }
    if (target.includes("/chunks/")) return response(200, { sha256: "0".repeat(64) });
    if (target.includes("/audio")) return response(404, { error: "not_found" });
    if (target.includes("/api/studio/takes")) return response(200, { begun: false, received: [], frames: 0 });
    if (target.includes("/api/studio/songs")) {
      return response(200, [{ id: "song-1", project_id: 1, title: "Recording song" }]);
    }
    if (target.includes("/module-types")) return response(200, { generators: ["Analog generator"], modules: {} });
    if (target.includes("/project-bot")) return response(404, { error: "not_found" });
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

  const stream = fakeStream();
  const mediaDevices = {
    async getUserMedia() {
      return stream;
    },
    async enumerateDevices() {
      return [{ kind: "audioinput", deviceId: "test-input", label: "Test input" }];
    },
  };

  const windowStub = {
    crypto: globalThis.crypto,
    location: { protocol: "http:", host: "127.0.0.1:1", reload() {} },
    atob: globalThis.atob,
    confirm: () => true,
    AudioContext: function AudioContextStub() {
      return fakeContext(0);
    },
    StudioTakeStore: store,
    StudioEngine: { create: async () => engine },
    addEventListener() {},
    removeEventListener() {},
  };

  const yjsUrl = pathToFileURL(
    new URL("../bundles/studio/node_modules/yjs/dist/yjs.mjs", import.meta.url).pathname,
  ).href;
  const scriptText = CLIENT_SCRIPT.replace("'/dashboard/studio/assets/yjs.mjs'", JSON.stringify(yjsUrl));
  assert.notEqual(scriptText, CLIENT_SCRIPT, "the test replaces the Yjs asset URL with the file on disk");

  // The take store travels as its own string in the page and is emitted before
  // the client. It is parsed and run here for that reason, and the fake above
  // then takes its place: a sandbox has no IndexedDB for it to use.
  new Function("window", "navigator", TAKE_STORE_SCRIPT)(windowStub, { mediaDevices });
  assert.equal(typeof windowStub.StudioTakeStore.putChunk, "function", "the take store installs its API");
  windowStub.StudioTakeStore = store;

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
    { mediaDevices, locks: null },
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

  return { document, store, engine, sent, requests, log, page, click, settle, frame, releaseFinish, timers };
}

/**
 * Arm the fake panel's audio track, press Record, and launch the scene on the
 * frame given — everything a take needs before its first chunk.
 * @param {object} ui a booted panel
 * @param {number} frame the frame the launch reports
 * @returns {Promise<object>} the fake recorder
 */
async function startFakeRecording(ui, frame = ARM_FRAME) {
  ui.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await ui.settle();
  ui.click("[data-act=record]");
  await ui.settle(24);
  const recorder = ui.engine.recorders[ui.engine.recorders.length - 1];
  assert.ok(recorder, "the panel built a recorder");
  ui.engine.launches.forEach((listener) =>
    listener({ track_id: AUDIO_TRACK, clip_id: null, scene_id: SCENE, bar: 0, frame: frame }),
  );
  await ui.settle();
  return recorder;
}

test("every pass of a looped recording plays back on its own beat 0, not just the first", async () => {
  const store = fakeTakeStore({ latency: CALIBRATED, log: [] });
  // The order the page makes its takes in: one per pass, segment 0 first.
  const created = [];
  const put = store.putPending.bind(store);
  store.putPending = async (value) => {
    if (!created.includes(value.take_id)) created.push(value.take_id);
    return put(value);
  };

  // The finishes are held open, so every pass's row is still on this device
  // when it is read below.
  const ui = await bootPanel({ store, gateFinish: true });
  const recorder = await startFakeRecording(ui, ARM_FRAME);
  assert.equal(recorder.armFrame, ARM_FRAME, "the recorder armed on the launch frame");
  assert.ok(recorder.splits.length >= 3, "the page sent a split for every loop boundary");

  // Three passes, one chunk each. The first chunk of the next pass is what ends
  // the pass before it, so each pass gets its own take.
  for (const segment of [0, 1, 2]) {
    recorder.chunk(new Uint8Array(PASS_BYTES).buffer, 0, segment);
    await ui.settle(24);
  }
  recorder.done({
    segments: [0, 1, 2].map((segment) => ({ segment, start_frame: ARM_FRAME, frames: PASS_FRAMES })),
    frames: PASS_FRAMES * 3,
    start_frame: ARM_FRAME,
  });
  await ui.settle(24);

  assert.equal(created.length, 3, `three passes made three takes (got ${created.length})`);
  const takes = created.map((takeId, pass) => {
    const row = ui.store.pendings.get(takeId);
    assert.ok(row, `pass ${pass} has a pending row on this device`);
    return row;
  });
  assert.equal(ui.store.pendings.size, 3, "one row per pass, and nothing else");

  // The delay the page cut the takes by: the interface's round trip, since the
  // fake engine announces no master latency.
  const recOffset = takes[0].offset_frames;
  assert.ok(recOffset > 0, "the input's round trip is a real delay, so the model below holds something");
  assert.equal(recOffset, ROUND_TRIP, "the takes are cut by the calibrated round trip");

  // The splits the page sent, so the model below is tied to its own output: the
  // arm frame, the sequencer's absolute frame for that bar, and the delay.
  for (let pass = 1; pass < 3; pass += 1) {
    assert.equal(
      recorder.splits[pass - 1],
      ARM_FRAME + Math.round(pass * loopFrames()) + recOffset,
      `pass ${pass} starts on the split frame the page sent`,
    );
  }

  for (let pass = 0; pass < 3; pass += 1) {
    // A click played at the start of this pass, as the interface hands it back:
    // the page's own frame for the pass, one round trip late.
    const clickContext = ARM_FRAME + Math.round(pass * loopFrames()) + recOffset;
    // The take's first frame: the arm frame for pass 0, and for every pass after
    // it the split frame — which already carries the round trip.
    const takeFirst = pass === 0 ? recorder.armFrame : recorder.splits[pass - 1];
    // Where that click sits inside the take.
    const clickIndex = clickContext - takeFirst;
    // What playback reads: bundles/studio/engine/sequencer.js `startAudio` sets
    // `takeFrame = Math.round(clipBeat * framesPerBeat) + take.offsetFrames`, so
    // the take frame that sounds on the pass's own beat 0 (clipBeat 0) is the
    // stored `offset_frames`.
    const stored = takes[pass].offset_frames;
    assert.ok(
      Math.abs(stored - clickIndex) <= 1,
      `pass ${pass}: playback starts its take at frame ${stored}, but the pass's beat 0 `
        + `is at frame ${clickIndex} in it (${stored - clickIndex} frames late)`,
    );
  }
});