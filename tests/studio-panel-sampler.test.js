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

import { test } from "node:test";
import assert from "node:assert/strict";
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

// ---- the fixture document --------------------------------------------------

/**
 * The song the client tests draw: one sampler track (whose kit arrives with
 * bank A and its sixteen pads), one scene and one 16-step pattern clip.
 * @param {{extraScene?: boolean}} [options]
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
    length_steps: 16,
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
 */
function fakeContext() {
  const gain = { gain: { value: 1 }, connect() {}, disconnect() {} };
  return {
    sampleRate: RATE,
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
    onPosition() {
      return () => {};
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
      return { frame: 0, bar: 1 };
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
 * fake browser around it, and hand back what it drew, what it sent and what the
 * engine was asked to do.
 * @param {{doc?: object, holdChunks?: boolean}} [options]
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

  const store = fakeTakeStore();
  const engine = fakeEngine();
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
      return response(200, {}, SAMPLE_AUDIO.slice(0).buffer);
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
    store,
    engine,
    sent,
    requests,
    page,
    click,
    event,
    settle,
    frame,
    stateFrame,
    timers,
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
    /** Run the real server commands on the fixture song, then redraw the page. */
    async apply(command, args) {
      const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
      runCommand(doc, command, args);
      frame(stateFrame());
      await settle();
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