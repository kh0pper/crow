/**
 * Studio panel — the mixer screen (plan 1d, Task 10).
 *
 * Two halves, in one file because they test one screen:
 *
 *   1. the emitted client script against a linkedom document built from the page
 *      the handler renders, a real Yjs song with two tracks, a return, a send,
 *      a chain of effects and a master, a fake engine that records the songs it
 *      was handed and can report a meter reading, a faulted insert and a loading
 *      one, and a fake socket that answers the page's commands. What they prove
 *      is what the strips draw and what each control sends: ONE command per
 *      gesture (a slider's release, not its drag, and never a value it has just
 *      sent), the agent's mix pass outlined with A/B and Undo pass, the pass
 *      staying whole across an undo and a redo, a loading or faulted effect's
 *      mark going once the engine or the song moves on, and the master's
 *      readings against the song's target;
 *   2. a private headless Chrome (tests/fixtures/headless-chrome.mjs) against a
 *      real gateway-shaped server and a real session hub: a chip dragged with
 *      real mouse input sends exactly one insert.move, an engine report mid-drag
 *      breaks nothing, A/B clicked with real mouse input hands the engine the
 *      song before the pass without writing to it, and the mixer's strips scroll
 *      inside their own box at phone width.
 *
 * No browser: the live half skips, unless CROW_REQUIRE_TEST_CHROME=1.
 */

import { readFileSync } from "node:fs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import express, { Router } from "express";
import { WebSocket, WebSocketServer } from "ws";
import { AclError } from "../servers/shared/project-acl.js";
import { createHub } from "../bundles/studio/server/hub.js";
import { initStudioTables } from "../bundles/studio/server/init-tables.js";
import { createStudioWeb } from "../bundles/studio/server/web.js";
import studioPanel, { MIXER_EFFECTS_SCRIPT } from "../bundles/studio/panel/studio.js";
import { CLIENT_SCRIPT } from "../bundles/studio/panel/client.js";
import { EFFECT_PARAMS, EFFECT_KINDS, AMP_PARAMS } from "../bundles/studio/server/doc.js";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";

/** The rate the fake context runs at. */
const RATE = 48000;

/** Who made a step: the operator, or the agent a mix pass comes from. */
const HUMAN = { kind: "human", id: "local", label: "You" };
const AGENT = { kind: "agent", id: "agent:mcp", label: "Studio agent" };

/**
 * The starter sounds the bundle ships, as the page is handed them
 * (`window.StudioMixer.bundled`): the shape `library/bundled.json` has, narrowed
 * to what a picker and a credit line need.
 */
const BUNDLED_STARTERS = [
  {
    id: "starter-a2",
    kind: "nam",
    name: "Starter capture (NAM example model)",
    licence: "MIT",
    credit: "NAM example A2 model by Steven Atkinson (NeuralAmpModelerCore), MIT",
  },
  {
    id: "cabinet-ampmix",
    kind: "ir",
    name: "Cabinet 1 (AmpMix)",
    licence: "CC-BY-3.0",
    credit: '"Impulse Responses" by David Fau Casquel (archive.org/details/ImpulseResponses), CC BY 3.0',
  },
];

/**
 * A song with one audio track playing an amp: the operator's own capture in the
 * library, their own cabinet, and an amp insert that names both. This is what
 * the amp editor edits (plan 1d, Task 15).
 * @param {{proposal?: boolean}} [options] `proposal` adds the agent's SECOND amp
 *   on that same chain, which arrives as a proposal
 * @returns {Promise<{doc: object, history: object[]}>}
 */
async function ampSong(options = {}) {
  const { newSongDoc } = await import("../bundles/studio/server/doc.js");
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  await import("../bundles/studio/server/commands/core.js");
  await import("../bundles/studio/server/commands/library.js");
  await import("../bundles/studio/server/commands/mixer.js");

  const doc = newSongDoc({ title: "Amp song", bpm: 120 });
  const history = [];
  let seq = 0;

  /** One step, applied for real and recorded as the hub records it. */
  const step = (command, args, author, options = {}) => {
    const result = runCommand(doc, command, args, { author, ...options });
    seq += 1;
    const entry = {
      id: "a" + String(seq),
      song_id: "song-1",
      seq,
      command,
      args: result.args,
      summary: result.summary,
      author,
      touched: result.touched,
      inverse: { before: result.before, after: result.after },
      before: result.before,
      after: result.after,
      undo_of: null,
      undone_by: null,
      created_at: new Date().toISOString(),
    };
    history.push(entry);
    return entry;
  };

  const capture = {
    id: "lib-cap",
    kind: "nam",
    name: "My capture",
    source: "upload",
    upload_id: "cap-upload",
    storage_key: "projects/71/studio/song-1/library/lib-cap-upload.nam",
    sha256: "a".repeat(64),
    bytes: 1024,
    licence: "",
    credit: "My capture by me",
    author_label: "You",
  };
  const cabinet = {
    id: "lib-cab",
    kind: "ir",
    name: "My cabinet",
    source: "upload",
    upload_id: "cab-upload",
    storage_key: "projects/71/studio/song-1/library/lib-cab-upload.wav",
    sha256: "b".repeat(64),
    bytes: 2048,
    licence: "",
    credit: "My cabinet by me",
    author_label: "You",
  };

  step("track.add", { id: "guitar", name: "Guitar", kind: "audio" }, HUMAN);
  // A library entry is Studio's own step, issued by the gateway's upload finish.
  step("library.add", { entry: capture }, HUMAN, { internal: true });
  step("library.add", { entry: cabinet }, HUMAN, { internal: true });
  step(
    "insert.add",
    { id: "ins-amp", owner: "track:guitar", kind: "amp", params: { model_id: "lib-cap", ir_id: "lib-cab" } },
    HUMAN,
  );
  if (options.proposal === true) {
    // The agent's second amp on a chain that already has one: a proposal, which
    // plays nothing until the operator accepts it.
    step(
      "insert.add",
      { id: "ins-amp-2", owner: "track:guitar", kind: "amp", params: { model_id: "lib-cap", ir_id: null } },
      AGENT,
    );
  }
  return { doc, history };
}

/** The stand-in dashboard layout: a bare document around the panel content. */
function minimalLayout({ title, content }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>`
    + `<body>${content}</body></html>`;
}

/** A database fake for the panel handler: no projects to list. */
function panelDb() {
  return {
    async execute() {
      return { rows: [] };
    },
  };
}

// ---- the fixture song and its history --------------------------------------

/**
 * The song the unit tests draw, with the shared history it would have: the
 * operator's own setup steps, then one agent's mix pass of five mixer steps.
 *
 * Every step is applied to the real document through the real command, and the
 * entry keeps what the hub would keep — its summary, the refs it touched, and
 * the before/after pair an undo is made of.
 * @returns {Promise<{doc: object, history: object[], pass: object[],
 *                    undo: function(object): object, entries: object}>}
 */
async function mixerSong() {
  const { newSongDoc } = await import("../bundles/studio/server/doc.js");
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  const { planUndo, applyPlan, makeUndoEntry, REDO_COMMAND } = await import("../bundles/studio/server/history.js");
  await import("../bundles/studio/server/commands/core.js");
  await import("../bundles/studio/server/commands/mixer.js");

  const doc = newSongDoc({ title: "Mix song", bpm: 120 });
  const history = [];
  let seq = 0;

  /** One step: applied for real, recorded as the hub records it. */
  const step = (command, args, author) => {
    const result = runCommand(doc, command, args, { author });
    seq += 1;
    const entry = {
      id: "e" + String(seq),
      song_id: "song-1",
      seq,
      command,
      args: result.args,
      summary: result.summary,
      author,
      touched: result.touched,
      inverse: { before: result.before, after: result.after },
      before: result.before,
      after: result.after,
      undo_of: null,
      undone_by: null,
      created_at: new Date().toISOString(),
    };
    history.push(entry);
    return entry;
  };

  // The operator's own setup, before the pass.
  step("track.add", { id: "bass", name: "Bass" }, HUMAN);
  step("track.add", { id: "keys", name: "Keys" }, HUMAN);
  step("return.add", { id: "plate", name: "Plate" }, HUMAN);
  step("send.set", { track_id: "bass", return_id: "plate", level_db: -12 }, HUMAN);
  step("master.set", { target: { lufs: -14, true_peak_db: -1 } }, HUMAN);

  // The agent's mix pass: consecutive mixer steps by one agent.
  const pass = [
    step("insert.add", { id: "ins-eq", owner: "track:bass", kind: "eq" }, AGENT),
    step("insert.add", { id: "ins-comp", owner: "track:bass", kind: "compressor" }, AGENT),
    step("insert.set", { id: "ins-eq", params: { low_gain_db: 3 } }, AGENT),
    step("insert.add", { id: "ins-verb", owner: "return:plate", kind: "reverb" }, AGENT),
    step("master.set", { target: { lufs: -16, true_peak_db: -1.5 } }, AGENT),
  ];

  /**
   * Undo one step the way the hub does: its plan applied to the document, the
   * step marked undone by the undo that took it back, and that undo recorded
   * above it.
   * @param {object} entry
   * @returns {object} the undo entry
   */
  const undo = (entry) => {
    const plan = planUndo(doc, entry);
    applyPlan(doc, plan);
    seq += 1;
    const made = makeUndoEntry({ entry, plan, song_id: "song-1", seq, author: HUMAN });
    history.push(made);
    entry.undone_by = made.id;
    return made;
  };

  /**
   * Redo one undo the way the hub does: the undo's own plan applied to the
   * document, the redo recorded above it (its undo_of is the undo it takes
   * back), and the undo marked undone by that redo.
   * @param {object} undoEntry
   * @returns {object} the redo entry
   */
  const redo = (undoEntry) => {
    const plan = planUndo(doc, undoEntry);
    applyPlan(doc, plan);
    seq += 1;
    const made = makeUndoEntry({
      entry: undoEntry,
      plan,
      song_id: "song-1",
      seq,
      author: HUMAN,
      command: REDO_COMMAND,
    });
    history.push(made);
    undoEntry.undone_by = made.id;
    return made;
  };

  return {
    doc,
    history,
    pass,
    undo,
    redo,
    entries: { bass: "e1", keys: "e2", plate: "e3", send: "e4", master: "e5" },
  };
}

// ---- the fake engine, context and browser ----------------------------------

/** The engine stand-in: it records the songs it was handed and reports back. */
function fakeEngine() {
  const engine = {
    songs: [],
    modes: [],
    node: { connect() {} },
    setSong(song) {
      engine.songs.push(song);
    },
    setMode(mode) {
      engine.modes.push(String(mode));
    },
    seek() {},
    play() {},
    stop() {},
    stopAll() {},
    launchScene() {},
    launchClip() {},
    onPosition() {
      return () => {};
    },
    onLaunch() {
      return () => {};
    },
    onError() {
      return () => {};
    },
    onSampleNeeded() {
      return () => {};
    },
    onLibraryNeeded() {
      return () => {};
    },
    onLibraryPresets() {
      return () => {};
    },
    onMeter(listener) {
      engine.meter = listener;
      return () => {};
    },
    onMonitorLatency(listener) {
      engine.monitorLatency = listener;
      return () => {};
    },
    onMasterLatency(listener) {
      engine.masterLatency = listener;
      return () => {};
    },
    onInsertFault(listener) {
      engine.insertFault = listener;
      return () => {};
    },
    onInsertLoading(listener) {
      engine.insertLoading = listener;
      return () => {};
    },
    lastMeter() {
      return null;
    },
    loadSample() {
      return Promise.resolve();
    },
    unloadSample() {},
    loadLibrary() {
      return Promise.resolve({ status: "loaded" });
    },
    unloadLibrary() {},
    loadAudio() {
      return Promise.resolve();
    },
    unloadAudio() {},
    tap() {},
    onTap() {
      return () => {};
    },
    nextBarFrame() {
      return Promise.resolve({ frame: 0, bar: 1 });
    },
    createRecorder() {
      return Promise.resolve(null);
    },
    dispose() {},
  };
  return engine;
}

/** The context stand-in: the two nodes the page builds, and nothing else. */
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
  };
}

/** The take store, in memory: nothing is kept, every call answers. */
function fakeTakeStore() {
  return {
    async putChunk() { return true; },
    async getChunk() { return null; },
    async countChunks() { return { count: 0, bytes: 0 }; },
    async getPending() { return null; },
    async listPending() { return []; },
    async putPending() { return true; },
    async deletePending() { return true; },
    async getLatency() { return null; },
    async putLatency() { return true; },
    async getAudio() { return null; },
    async putAudio() { return true; },
    async clearAudio() { return true; },
  };
}

/** The navigator stand-in: no inputs are ever opened by these tests. */
function fakeNavigator() {
  return {
    mediaDevices: {
      async enumerateDevices() {
        return [];
      },
      async getUserMedia() {
        throw new Error("no input in these tests");
      },
    },
  };
}

/**
 * Boot the emitted client script against the page the handler renders, with a
 * fake browser around it, and hand back what it drew and what it sent.
 * @returns {Promise<object>} the page's handles
 */
async function bootMixer(options = {}) {
  const { parseHTML } = await import("linkedom");
  const { pathToFileURL } = await import("node:url");
  const { encodeDocState } = await import("../bundles/studio/server/doc.js");

  const fixture = options.fixture || (await mixerSong());
  const doc = fixture.doc;
  const history = fixture.history;
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
  const { document, window: domWindow } = parseHTML(res.html);

  const engine = fakeEngine();
  const sent = [];
  const requests = [];
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

  // A gate a test can use to hold the gateway's starter route open, so a second
  // pick can be made while the first starter sound is still on its way.
  let starterGate = null;
  let releaseStarter = () => {};
  if (options.holdStarter === true) {
    let release = () => {};
    starterGate = {
      promise: new Promise((resolve) => {
        release = resolve;
      }),
    };
    releaseStarter = () => release();
  }

  const fetchStub = async (url, init = {}) => {
    const target = String(url);
    requests.push({ url: target, method: init.method || "GET", body: init.body || null });
    if (target.includes("/module-types")) return response(200, { generators: ["Analog generator"], modules: {} });    if (target.includes("/project-bot")) return response(404, { error: "not_found" });
    if (target.includes("/api/studio/library/bundled")) {
      // A test can hold the gateway's answer open, to see what a second pick does
      // while the first starter sound is still on its way.
      if (starterGate !== null) await starterGate.promise;
      // The gateway's own route (dashboard session + CSRF): it answers with the
      // library entry the song now holds, whose id IS the bundled row's id.
      const body = init.body ? JSON.parse(String(init.body)) : {};
      const starter = BUNDLED_STARTERS.find((row) => row.id === body.bundled_id) || null;
      if (!starter) return response(404, { error: "This Crow ships no starter sound." });
      return response(200, {
        entry: {
          id: starter.id,
          kind: starter.kind,
          name: starter.name,
          source: "bundled",
          sha256: "c".repeat(64),
          bytes: 1,
          licence: starter.licence,
          credit: starter.credit,
          author_label: "You",
        },
        added: true,
      });
    }
    if (target.includes("/api/studio/songs")) return response(200, [{ id: "song-1", project_id: 71, title: "Mix song" }]);
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
    StudioTakeStore: fakeTakeStore(),
    StudioEngine: { create: async () => engine },
    // The effects table the handler emits beside the client (see
    // MIXER_EFFECTS_SCRIPT): the very same table the document checks against,
    // with the amp's own table and the starter sounds this bundle ships beside it.
    StudioMixer: {
      kinds: EFFECT_KINDS,
      params: EFFECT_PARAMS,
      amp: { kind: "amp", label: AMP_PARAMS.amp.label, params: AMP_PARAMS.amp.params },
      bundled: BUNDLED_STARTERS,
    },
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

  // The page's timers are real enough to be cancelled: a debounce that a
  // release closes must never fire (see sendInsertParam).
  const timers = new Map();
  let timerSeq = 0;
  const setTimeoutStub = (fn, ms) => {
    timerSeq += 1;
    timers.set(timerSeq, { fn, ms: Number(ms) || 0 });
    return timerSeq;
  };
  const clearTimeoutStub = (id) => {
    timers.delete(id);
  };
  const runTimers = () => {
    const due = [...timers.entries()].sort((a, b) => a[1].ms - b[1].ms);
    timers.clear();
    for (const [, timer] of due) timer.fn();
  };

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
    setTimeoutStub,
    clearTimeoutStub,
    () => 0,
    () => {},
  );

  const settle = async (rounds = 16) => {
    for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  };
  const frame = (message) => {
    for (const handler of socket.handlers.message || []) handler({ data: JSON.stringify(message) });
  };
  const stateFrame = () => ({
    type: "state",
    update: Buffer.from(encodeDocState(doc)).toString("base64"),
    history: history.slice(0).sort((a, b) => b.seq - a.seq),
    presence: [],
  });
  const event = (type, props) => {
    const made = new domWindow.Event(type, { bubbles: true, cancelable: true });
    for (const [key, value] of Object.entries(props || {})) made[key] = value;
    return made;
  };
  /**
   * Dispatch one event on the page's window, the way a pointer move or release
   * on a drag reaches it: the script's window is the stub the handlers live on.
   */
  const windowEvent = (type, props) => {
    const made = event(type, props);
    for (const handler of (windowListeners[type] || []).slice()) handler(made);
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

  /**
   * Set a control's value the way a browser does, and tell the page it changed.
   * linkedom's `<select>` reads its value off the selected option (its `value`
   * is a getter with no setter), so a select is chosen through its options and
   * a range or a number is set directly.
   */
  const choose = (node, value) => {
    const options = [...node.querySelectorAll("option")];
    if (options.length) {
      // linkedom keeps a select's choice in the option's ATTRIBUTE, so a choice
      // is made by writing that attribute and clearing the others.
      for (const option of options) {
        if (String(option.value) === String(value)) option.setAttribute("selected", "");
        else option.removeAttribute("selected");
      }
    } else {
      node.value = String(value);
    }
    node.dispatchEvent(new domWindow.Event("change", { bubbles: true }));
    return node;
  };

  const ui = {
    html: res.html,
    doc,
    history,
    fixture,
    document,
    domWindow,
    window: windowStub,
    windowListeners,
    engine,
    sent,
    requests,
    page,
    click,
    choose,
    event,
    windowEvent,
    settle,
    frame,
    stateFrame,
    runTimers,
    /** Let the starter route's held answer through (see `holdStarter`). */
    releaseStarter,
    /** Every message of one command the page sent, in order. */
    commands(id) {
      return sent.filter((message) => message.type === "command" && message.command === id);
    },
    /** Every undo/redo frame the page sent, in order. */
    undos() {
      return sent.filter((message) => message.type === "undo");
    },
    /** Open the mixer screen. */
    async openMixer() {
      click("[data-act=mode-mixer]");
      await settle();
    },
    /** Start the transport, which is what builds the engine. */
    async startEngine() {
      click("[data-act=play]");
      await settle();
    },
    /** The mixer's own host, asserted to be the view on screen. */
    mixer() {
      const host = document.querySelector("[data-role=mixer]");
      assert.ok(host, "the mixer host is on the page");
      assert.equal(host.hidden, false, "the mixer is the view on screen");
      return host;
    },
    /** @returns {object} one strip by its owner ref */
    strip(owner) {
      const node = ui.mixer().querySelector(`[data-strip="${owner}"]`);
      assert.ok(node, `the strip ${owner} is drawn`);
      return node;
    },
    /** @returns {object} one chain's box */
    chain(owner) {
      const node = ui.mixer().querySelector(`[data-chain="${owner}"]`);
      assert.ok(node, `the chain of ${owner} is drawn`);
      return node;
    },
    /** @returns {object} one insert's chip */
    chip(id) {
      const node = ui.mixer().querySelector(`[data-act=insert-chip][data-insert-id="${id}"]`);
      assert.ok(node, `the chip for ${id} is drawn`);
      return node;
    },
    /** Answer one of the page's undo frames with a result and a fresh state. */
    async answerUndo(ok, extra = {}) {
      const pending = ui.undos().pop();
      assert.ok(pending, "the page sent an undo");
      ui.frame({ type: "result", cmd_id: pending.cmd_id, ok, ...extra });
      // The document as the undo left it. A resync frame is the one that does
      // not drop the commands already on the wire — which is what the next
      // step of a pass is.
      ui.frame({ ...stateFrame(), resync: true });
      await settle();
      return pending;
    },
    /** The last song the engine was handed. */
    lastSong() {
      return engine.songs.length ? engine.songs[engine.songs.length - 1] : null;
    },
    /** The banner's text, when the page draws one. */
    bannerText() {
      const node = ui.mixer().querySelector("[data-role=mix-banner] .st-mix-banner-text");
      return node ? String(node.textContent) : "";
    },
  };
  return ui;
}

// ---- the strips ------------------------------------------------------------

test("the page carries the one effects table the mixer reads", async () => {
  const ui = await bootMixer();
  // The handler emits EFFECT_PARAMS as its own classic script, beside the
  // client (MIXER_EFFECTS_SCRIPT). The unit harness hands the page the same
  // table from the document module; this checks the page really carries it.
  assert.match(ui.html, /window\.StudioMixer = /);
  for (const kind of ["eq", "compressor", "limiter", "deesser"]) {
    assert.ok(EFFECT_KINDS.includes(kind), `${kind} is an effect a chain holds`);
    assert.ok(ui.html.includes(`"${kind}"`), `${kind} travels to the page`);
  }
});

test("the mixer draws a strip for every track, the returns and the master", async () => {
  const ui = await bootMixer();
  await ui.openMixer();
  const host = ui.mixer();

  const strips = [...host.querySelectorAll("[data-role=mix-strips] [data-strip]")];
  assert.deepEqual(
    strips.map((node) => node.getAttribute("data-strip")),
    ["track:bass", "track:keys", "return:plate", "master"],
    "tracks first, then the returns, then the master",
  );
  assert.equal(strips[0].querySelector(".st-strip-name").textContent, "Bass", "a strip names its track");
  assert.match(
    String(strips[0].querySelector(".st-color").style.background),
    /^#[0-9a-f]{6}$/i,
    "and wears a colour of its own",
  );
  // The chain is in the order it plays, with a menu after it.
  const chips = [...ui.chain("track:bass").querySelectorAll("[data-act=insert-chip]")];
  assert.deepEqual(chips.map((node) => node.getAttribute("data-insert-id")), ["ins-eq", "ins-comp"]);
  assert.ok(ui.chain("track:bass").querySelector("[data-act=insert-add]"), "a chain offers + effect");
});

test("adding an insert sends one insert.add", async () => {
  const ui = await bootMixer();
  await ui.openMixer();
  assert.equal(ui.commands("insert.add").length, 0, "nothing was added yet");

  const menu = ui.chain("track:bass").querySelector("[data-act=insert-add]");
  assert.ok(menu, "the chain has its + effect menu");
  const labels = [...menu.querySelectorAll("option")].map((option) => String(option.textContent));
  assert.equal(labels[0], "+ effect", "the menu starts at its own label");
  for (const kind of EFFECT_KINDS) {
    assert.ok(
      labels.includes(EFFECT_PARAMS[kind].label),
      `the menu offers the table's word for ${kind}`,
    );
  }

  ui.choose(menu, "delay");
  await ui.settle();

  const added = ui.commands("insert.add");
  assert.equal(added.length, 1, "one pick is one command");
  assert.equal(added[0].args.owner, "track:bass");
  assert.equal(added[0].args.kind, "delay");
  assert.match(String(added[0].args.id), /^ins-/, "Studio makes the insert's id");
  // The menu is drawn again from the document, so it starts at its own label.
  const fresh = ui.chain("track:bass").querySelector("[data-act=insert-add]");
  assert.notEqual(fresh, menu, "the menu was drawn again");
  assert.equal(String(fresh.querySelector("option").textContent), "+ effect");
  assert.equal(fresh.value === undefined || fresh.value === "", true, "and it chose nothing");
});

test("turning a control sends one insert.set", async () => {
  const ui = await bootMixer();
  await ui.openMixer();

  // A chip opens that effect's editor.
  ui.chip("ins-eq").dispatchEvent(ui.event("click"));
  await ui.settle();
  const editor = ui.mixer().querySelector("[data-role=mix-editor]");
  assert.ok(editor, "the insert editor is drawn");
  assert.equal(editor.hidden, false);
  assert.match(String(editor.textContent), /equalizer/, "it names the effect");
  assert.match(String(editor.textContent), /Bass/, "and the chain it sits in");

  const gain = editor.querySelector('[data-param="low_gain_db"]');
  assert.ok(gain, "the equalizer's low_gain_db has a control");
  assert.equal(gain.getAttribute("aria-label"), "low gain of the equalizer", "with its own name and unit");

  // A drag: the pointer moves, the operator PAUSES longer than the page's own
  // debounce (the harness's timers are run, so any timer that was set fires),
  // moves again, pauses again, and then lets go. Nothing is sent while the
  // control is held; the release is the ONE insert.set of the gesture.
  gain.value = "6";
  gain.dispatchEvent(ui.event("input"));
  await ui.settle();
  ui.runTimers();
  await ui.settle();
  assert.equal(ui.commands("insert.set").length, 0, "a held control sends nothing, not even after a pause");

  gain.value = "7";
  gain.dispatchEvent(ui.event("input"));
  await ui.settle();
  ui.runTimers();
  await ui.settle();
  assert.equal(ui.commands("insert.set").length, 0, "and nothing after the second pause");

  gain.dispatchEvent(ui.event("change"));
  await ui.settle();
  ui.runTimers();
  await ui.settle();

  const sets = ui.commands("insert.set");
  assert.equal(sets.length, 1, `one gesture is one command (${sets.length})`);
  assert.deepEqual(sets[0].args, { id: "ins-eq", params: { low_gain_db: 7 } });

  // The same value twice in a row is no gesture at all.
  gain.dispatchEvent(ui.event("change"));
  await ui.settle();
  assert.equal(ui.commands("insert.set").length, 1, "an identical value is never sent twice in a row");

  // A choice control is one insert.set too, and carries the word itself.
  ui.chip("ins-comp").dispatchEvent(ui.event("click"));
  await ui.settle();
  const compressor = ui.mixer().querySelector("[data-role=mix-editor]");
  const detect = compressor.querySelector('[data-param="detect"]');
  assert.ok(detect, "the compressor's detect has a control");
  ui.choose(detect, "rms");
  await ui.settle();
  const chosen = ui.commands("insert.set");
  assert.equal(chosen.length, 2, "a pick is one command");
  assert.deepEqual(chosen[1].args, { id: "ins-comp", params: { detect: "rms" } });
});

test("a send level change sends one send.set", async () => {
  const ui = await bootMixer();
  await ui.openMixer();

  const row = ui.strip("track:bass").querySelector('[data-send="bass/plate"]');
  assert.ok(row, "the track's send to the return is drawn");
  assert.match(String(row.textContent), /Plate/, "named with the return");

  const level = row.querySelector("[data-act=send-level]");
  assert.ok(level, "with its own level");
  ui.choose(level, "-20");
  await ui.settle();

  const sets = ui.commands("send.set");
  assert.equal(sets.length, 1, "one control is one command");
  assert.deepEqual(sets[0].args, { track_id: "bass", return_id: "plate", level_db: -20 });

  // Pre/post is one send.set as well, and it names the level it already has.
  const pre = row.querySelector("[data-act=send-pre]");
  assert.ok(pre);
  pre.dispatchEvent(ui.event("click"));
  await ui.settle();
  const after = ui.commands("send.set");
  assert.equal(after.length, 2);
  assert.deepEqual(after[1].args, { track_id: "bass", return_id: "plate", level_db: -12, pre: true });
});

test("the target picker sends one master.set", async () => {
  const ui = await bootMixer();
  await ui.openMixer();

  const master = ui.mixer().querySelector("[data-role=mix-master]");
  assert.ok(master, "the master's own section is drawn");
  const pick = master.querySelector("[data-act=mix-target]");
  assert.ok(pick, "with the finishing target");
  const labels = [...pick.querySelectorAll("option")].map((option) => String(option.textContent));
  assert.ok(
    labels.some((label) => label.startsWith("\u221214 LUFS") && label.includes("streaming services turn louder songs down")),
    "the streaming reference says what it means",
  );
  assert.ok(labels.includes("\u221216 LUFS \u2014 speech"), "and speech has its own");
  assert.ok(labels.includes("Custom"), "and there is a custom target");
  assert.ok(master.querySelector("[data-act=mix-ceiling]"), "with a true-peak ceiling beside it");

  ui.choose(pick, "-16");
  await ui.settle();

  const sets = ui.commands("master.set");
  assert.equal(sets.length, 1, "a pick is ONE command");
  assert.deepEqual(sets[0].args, { target: { lufs: -16, true_peak_db: -1.5 } });

  // Custom adds its own number of LUFS, and settles as one master.set.
  const custom = ui.mixer().querySelector("[data-act=mix-target]");
  ui.choose(custom, "custom");
  await ui.settle();
  const field = ui.mixer().querySelector("[data-act=mix-target-custom]");
  assert.ok(field, "Custom asks for the number");
  ui.choose(field, "-20");
  await ui.settle();
  const all = ui.commands("master.set");
  assert.equal(all.length, 2);
  assert.deepEqual(all[1].args, { target: { lufs: -20, true_peak_db: -1.5 } });
});

test("a faulted insert shows the engine's message", async () => {
  const ui = await bootMixer();
  await ui.openMixer();
  await ui.startEngine();
  assert.ok(ui.engine.insertFault, "the page follows the engine's insert faults");

  const message = "The compressor on Bass produced an invalid sample; it is bypassed.";
  ui.engine.insertFault({ insert_id: "ins-comp", message });
  await ui.settle();

  const chip = ui.chip("ins-comp");
  assert.equal(String(chip.textContent), message, "the chip says what the engine said, word for word");
  assert.ok(String(chip.className).includes("st-mix-chip-fault"), "in the fault's colour");
  assert.equal(String(ui.chip("ins-eq").textContent), "equalizer", "the other effects are untouched");

  // A load in progress says Loading, and never the engine's sentence.
  ui.engine.insertLoading({ insert_id: "ins-eq", message: "The equalizer is on its way." });
  await ui.settle();
  assert.match(String(ui.chip("ins-eq").textContent), /^Loading/, "a loading effect says Loading");
});

test("a loading mark clears once audio flows", async () => {
  const ui = await bootMixer();
  await ui.openMixer();
  await ui.startEngine();
  await ui.settle();

  ui.engine.insertLoading({ insert_id: "ins-eq", message: "The equalizer is on its way." });
  await ui.settle();
  assert.match(String(ui.chip("ins-eq").textContent), /^Loading/, "the effect says it is on its way");

  // The engine only reports loading while a module is missing, so a meter
  // reading means the chain is built and audio is flowing: the mark goes.
  ui.engine.meter({
    momentary: -14.2,
    short_term: -14.5,
    integrated: -16.8,
    true_peak_db: -1.0,
    latency_ms: 0,
  });
  await ui.settle();
  assert.equal(String(ui.chip("ins-eq").textContent), "equalizer", "and the chip is the effect's name again");
});

test("a fault mark clears when the effect's settings change", async () => {
  const ui = await bootMixer();
  await ui.openMixer();
  await ui.startEngine();
  await ui.settle();

  const message = "The compressor on Bass produced an invalid sample; it is bypassed.";
  ui.engine.insertFault({ insert_id: "ins-comp", message });
  await ui.settle();

  const chip = ui.chip("ins-comp");
  assert.equal(String(chip.textContent), message, "the chip says what the engine said");
  assert.equal(String(chip.getAttribute("title")), message, "and its tooltip carries the whole sentence");

  // The editor says it whole as well, where the chip may cut it short.
  chip.dispatchEvent(ui.event("click"));
  await ui.settle();
  const editor = ui.mixer().querySelector("[data-role=mix-editor]");
  assert.equal(editor.hidden, false, "the chip opened the editor");
  const fault = editor.querySelector("[data-role=mix-editor-fault]");
  assert.ok(fault, "the editor shows the engine's sentence too");
  assert.equal(String(fault.textContent), message);

  // The effect is rebuilt with new settings, so the sentence about the old one
  // goes with it.
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  runCommand(ui.doc, "insert.set", { id: "ins-comp", params: { threshold_db: -24 } }, { author: HUMAN });
  ui.frame(ui.stateFrame());
  await ui.settle();

  const fresh = ui.chip("ins-comp");
  assert.equal(String(fresh.textContent), "compressor", "the fault is gone with the settings that caused it");
  assert.equal(
    String(fresh.getAttribute("title")),
    "Open the compressor: drag it to reorder the chain",
    "and the tooltip is the chip's own again",
  );
  assert.equal(
    ui.mixer().querySelector("[data-role=mix-editor-fault]"),
    null,
    "and the editor's line goes with it",
  );
});

test("an engine report during a chip drag does not break the drag", async () => {
  const ui = await bootMixer();
  await ui.openMixer();
  await ui.startEngine();
  await ui.settle();

  // Two chips with real boxes: the compressor sits below the equalizer, and the
  // drag's drop index is a position among them (linkedom has no layout).
  const eq = ui.chip("ins-eq");
  const comp = ui.chip("ins-comp");
  const boxAt = (top) => () => ({
    top,
    height: 20,
    width: 120,
    left: 0,
    right: 120,
    bottom: top + 20,
    x: 0,
    y: top,
  });
  eq.getBoundingClientRect = boxAt(10);
  comp.getBoundingClientRect = boxAt(40);

  // A real press, then a move above the equalizer's middle: the dragged row is
  // drawn where it would land.
  comp.dispatchEvent(ui.event("pointerdown", { button: 0, clientY: 50 }));
  ui.windowEvent("pointermove", { clientY: 5 });
  await ui.settle();
  assert.equal(comp.parentNode.parentNode.firstChild, comp.parentNode, "the chip is drawn where the drag put it");

  // The engine reports a fault mid-drag: the mixer is NOT rebuilt under the
  // held pointer, so the chip keeps following it.
  ui.engine.insertFault({
    insert_id: "ins-comp",
    message: "The compressor on Bass produced an invalid sample; it is bypassed.",
  });
  await ui.settle();
  assert.ok(ui.mixer().contains(comp), "the chip being dragged is still the one on the page");
  assert.equal(
    comp.parentNode.parentNode.firstChild,
    comp.parentNode,
    "and it is still where the drag put it",
  );

  // The release is the one insert.move of the gesture, naming the front.
  ui.windowEvent("pointerup", { clientY: 5 });
  await ui.settle();
  const moves = ui.commands("insert.move");
  assert.equal(moves.length, 1, `the drop is one command (${moves.length})`);
  assert.deepEqual(moves[0].args, { id: "ins-comp", after: null });
});

test("the master meter shows the target", async () => {
  const ui = await bootMixer();
  await ui.openMixer();
  await ui.startEngine();

  const strip = ui.strip("master");
  assert.match(String(strip.textContent), /Target \u221216 LUFS at \u22121.5 dBTP/, "the song's own target");
  assert.match(String(strip.textContent), /Momentary/, "and the four readings");
  assert.match(String(strip.textContent), /Integrated/);

  // Nothing measured yet: a dash, never a number the engine did not send.
  const momentary = () => strip.querySelector("[data-meter=momentary] .st-mix-read-value").textContent;
  assert.equal(momentary(), "\u2014");

  assert.ok(ui.engine.meter, "the page follows the engine's meter");
  ui.engine.meter({
    momentary: -14.2,
    short_term: -14.5,
    integrated: -16.8,
    true_peak_db: -1.0,
    latency_ms: 1.5,
  });
  await ui.settle();

  assert.equal(momentary(), "\u221214.2", "the reading is drawn as it was measured");
  assert.equal(
    strip.querySelector("[data-meter=integrated] .st-mix-read-value").textContent,
    "\u221216.8",
  );
  const latency = ui.mixer().querySelector("[data-role=mix-latency]");
  assert.ok(latency, "the limiter's delay has its own line");
  assert.equal(latency.hidden, false);
  assert.equal(String(latency.textContent), "Limiter look-ahead: 1.5 ms");
});

// ---- the amp editor (plan 1d, Task 15) -------------------------------------

test("adding an amp from the + effect menu opens the amp editor", async () => {
  const ui = await bootMixer({ fixture: await ampSong() });
  await ui.openMixer();
  assert.equal(ui.commands("insert.add").length, 0, "the fixture's own amp was made before the page opened");

  const menu = ui.chain("track:guitar").querySelector("[data-act=insert-add]");
  assert.ok(menu, "the guitar's chain has its + effect menu");
  const labels = [...menu.querySelectorAll("option")].map((option) => String(option.textContent));
  assert.ok(labels.includes("Amp"), "the menu offers Amp after the effects");
  for (const kind of EFFECT_KINDS) {
    assert.ok(labels.includes(EFFECT_PARAMS[kind].label), `and still offers ${kind}`);
  }

  // An amp needs a sound before it can exist: the pick opens the editor, and
  // nothing is added until a capture is chosen.
  ui.choose(menu, "amp");
  await ui.settle();
  assert.equal(ui.commands("insert.add").length, 0, "picking Amp adds nothing on its own");
  const editor = ui.mixer().querySelector("[data-role=mix-editor]");
  assert.equal(editor.hidden, false, "the amp editor opens");
  const capture = editor.querySelector("[data-act=amp-capture]");
  assert.ok(capture, "with its capture picker");
  assert.ok(editor.querySelector("[data-act=amp-cabinet]"), "and its cabinet picker");

  // The capture pick is the insert.add: one command, with the capture on it.
  ui.choose(capture, "lib-cap");
  await ui.settle();
  const added = ui.commands("insert.add");
  assert.equal(added.length, 1, "a capture pick adds the amp once");
  assert.equal(added[0].args.kind, "amp");
  assert.equal(added[0].args.owner, "track:guitar");
  assert.deepEqual(added[0].args.params, { model_id: "lib-cap" });
  assert.equal(ui.commands("insert.set").length, 0, "and sends no insert.set");
});

test("picking a starter tone sends one insert.set", async () => {
  const ui = await bootMixer({ fixture: await ampSong() });
  await ui.openMixer();

  // The amp's chip opens its own editor: the capture, the cabinet and the three
  // numbers — not one control per effect parameter.
  ui.chip("ins-amp").dispatchEvent(ui.event("click"));
  await ui.settle();
  const editor = ui.mixer().querySelector("[data-role=mix-editor]");
  assert.equal(editor.hidden, false, "the amp's editor is open");
  const capture = editor.querySelector("[data-act=amp-capture]");
  assert.ok(capture, "the amp editor has a capture picker");
  const values = [...capture.querySelectorAll("option")].map((option) => option.value);
  assert.ok(values.includes("lib-cap"), "the song's own capture is offered");
  assert.ok(values.includes("bundled:starter-a2"), "so is the starter capture the bundle ships");
  assert.ok(values.includes("__upload"), "and the way to bring one in");
  // The capture is a library entry: its credit line shows, and the editor says
  // whose choice it is.
  assert.match(String(editor.textContent), /My capture by me/);
  assert.match(String(editor.textContent), /Only you can change this amp's capture\./);
  // The credit line rides on the option itself too — the sound being chosen, not
  // only the one already chosen — for a library entry and for a starter sound.
  const captureOptions = [...capture.querySelectorAll("option")];
  assert.equal(
    String(captureOptions.find((option) => option.value === "lib-cap").title),
    "My capture by me",
    "the song's own capture carries its credit on its own option",
  );
  assert.equal(
    String(captureOptions.find((option) => option.value === "bundled:starter-a2").title),
    BUNDLED_STARTERS[0].credit,
    "and a starter sound carries the bundle's credit line on its own option",
  );
  // The three numbers come from AMP_PARAMS.
  for (const name of ["input_db", "output_db", "ir_mix"]) {
    assert.ok(editor.querySelector(`[data-param="${name}"]`), `the amp editor controls ${name}`);
  }

  const before = ui.commands("insert.set").length;
  ui.choose(capture, "bundled:starter-a2");
  await ui.settle();

  // The starter sound is added to the song through the person's own route...
  const posted = ui.requests.filter(
    (request) => request.method === "POST" && request.url.includes("/api/studio/library/bundled"),
  );
  assert.equal(posted.length, 1, "the starter sound went through the gateway's own route once");
  assert.deepEqual(JSON.parse(posted[0].body), { song_id: "song-1", bundled_id: "starter-a2" });

  // ...and picking it is ONE insert.set naming the capture, once the library has
  // it. It is never an insert.add: the amp is already in the chain.
  const sets = ui.commands("insert.set").slice(before);
  assert.equal(sets.length, 1, `picking a starter tone is one command (${sets.length})`);
  assert.deepEqual(sets[0].args, { id: "ins-amp", params: { model_id: "starter-a2" } });
  assert.equal(ui.commands("insert.add").length, 0, "the chain is unchanged: no amp was added");
});

test("a second starter pick while one is in flight says so and shows the sound it plays", async () => {
  const ui = await bootMixer({ fixture: await ampSong(), holdStarter: true });
  await ui.openMixer();
  ui.chip("ins-amp").dispatchEvent(ui.event("click"));
  await ui.settle();

  const capture = ui.mixer().querySelector("[data-act=amp-capture]");
  ui.choose(capture, "bundled:starter-a2");
  await ui.settle();
  assert.equal(
    ui.requests.filter((request) => request.url.includes("/api/studio/library/bundled")).length,
    1,
    "the first pick asks the gateway for the starter sound",
  );

  // The first add has not answered yet. A second pick must not look applied: it
  // says what is happening, and the picker goes back to the capture the amp
  // really plays.
  const again = ui.mixer().querySelector("[data-act=amp-capture]");
  ui.choose(again, "bundled:starter-a2");
  await ui.settle();
  assert.match(
    String(ui.document.querySelector("[data-role=toast]").textContent),
    /Adding the starter sound/,
    "the page says the starter sound is still being added",
  );
  assert.equal(
    ui.requests.filter((request) => request.url.includes("/api/studio/library/bundled")).length,
    1,
    "a second pick while one is in flight asks the gateway nothing",
  );
  assert.equal(ui.commands("insert.set").length, 0, "and applies nothing");
  const redrawn = ui.mixer().querySelector("[data-act=amp-capture]");
  assert.deepEqual(
    [...redrawn.querySelectorAll("option")].filter((option) => option.selected).map((option) => option.value),
    ["lib-cap"],
    "the picker shows the capture the amp plays, never the choice that was not applied",
  );

  // The first pick still lands: one insert.set naming the starter capture.
  ui.releaseStarter();
  await ui.settle();
  const sets = ui.commands("insert.set");
  assert.equal(sets.length, 1, `the first pick is the one that lands (${sets.length})`);
  assert.deepEqual(sets[0].args, { id: "ins-amp", params: { model_id: "starter-a2" } });
});

test("picking a cabinet sends one insert.set", async () => {
  const ui = await bootMixer({ fixture: await ampSong() });
  await ui.openMixer();
  ui.chip("ins-amp").dispatchEvent(ui.event("click"));
  await ui.settle();
  const editor = ui.mixer().querySelector("[data-role=mix-editor]");
  const cabinet = editor.querySelector("[data-act=amp-cabinet]");
  assert.ok(cabinet, "the amp editor has a cabinet picker");
  const values = [...cabinet.querySelectorAll("option")].map((option) => option.value);
  assert.ok(values.includes(""), "No cabinet is a choice");
  assert.ok(values.includes("lib-cab"), "the song's own cabinet is offered");
  assert.ok(values.includes("bundled:cabinet-ampmix"), "and a starter cabinet");

  // A starter cabinet is added through the person's route, then ONE insert.set.
  ui.choose(cabinet, "bundled:cabinet-ampmix");
  await ui.settle();
  let sets = ui.commands("insert.set");
  assert.equal(sets.length, 1, "a cabinet pick is one command");
  assert.deepEqual(sets[0].args, { id: "ins-amp", params: { ir_id: "cabinet-ampmix" } });

  // No cabinet is a pick too, and it sends `null` — one command.
  ui.chip("ins-amp").dispatchEvent(ui.event("click"));
  await ui.settle();
  const again = ui.mixer().querySelector("[data-role=mix-editor]");
  ui.choose(again.querySelector("[data-act=amp-cabinet]"), "");
  await ui.settle();
  sets = ui.commands("insert.set");
  assert.equal(sets.length, 2);
  assert.deepEqual(sets[1].args, { id: "ins-amp", params: { ir_id: null } });
});

test("a proposed second amp is drawn as a proposal, with Accept and Decline and no bypass", async () => {
  const ui = await bootMixer({ fixture: await ampSong({ proposal: true }) });
  await ui.openMixer();

  // The chain has both amps: the operator's live one and the agent's proposal.
  assert.deepEqual([...ui.chain("track:guitar").querySelectorAll("[data-act=insert-chip]")]
    .map((node) => node.getAttribute("data-insert-id")), ["ins-amp", "ins-amp-2"]);

  const proposed = ui.chip("ins-amp-2");
  assert.equal(String(proposed.textContent), "Proposed amp", "the chip says what it is");
  assert.ok(String(proposed.className).includes("st-mix-chip-proposed"), "and is drawn dimmed as one");
  assert.equal(
    ui.mixer().querySelector('[data-act=insert-bypass][data-insert-id="ins-amp-2"]'),
    null,
    "a proposal is not in the chain, so it has no bypass switch",
  );
  const accept = ui.mixer().querySelector('[data-act=insert-accept][data-insert-id="ins-amp-2"]');
  assert.ok(accept, "the row offers Accept");
  assert.equal(String(accept.textContent), "Accept");
  const decline = ui.mixer().querySelector('[data-act=insert-remove][data-insert-id="ins-amp-2"]');
  assert.ok(decline, "and Decline");
  assert.equal(String(decline.textContent), "Decline");

  // The operator's live amp on the same chain is drawn as it always was.
  const live = ui.chip("ins-amp");
  assert.equal(String(live.textContent), "amp");
  assert.equal(String(live.className).includes("st-mix-chip-proposed"), false);
  assert.ok(
    ui.mixer().querySelector('[data-act=insert-bypass][data-insert-id="ins-amp"]'),
    "a live amp keeps its bypass switch",
  );
  assert.equal(ui.mixer().querySelector('[data-act=insert-accept][data-insert-id="ins-amp"]'), null);
  const remove = ui.mixer().querySelector('[data-act=insert-remove][data-insert-id="ins-amp"]');
  assert.ok(remove, "and its own remove");
  assert.equal(String(remove.textContent), "\u00d7", "which is the chain's own remove, not a Decline");
});

test("Accept sends the proposal the row was drawn with, and Decline removes it", async () => {
  const ui = await bootMixer({ fixture: await ampSong({ proposal: true }) });
  await ui.openMixer();

  // Accept: one insert.accept, carrying the chain, capture and cabinet the row
  // was DRAWN with — never a fresh read of the snapshot.
  ui.click('[data-act=insert-accept][data-insert-id="ins-amp-2"]');
  const accepts = ui.commands("insert.accept");
  assert.equal(accepts.length, 1, "Accept is one insert.accept");
  assert.deepEqual(accepts[0].args, {
    id: "ins-amp-2",
    expect: { owner: "track:guitar", model_id: "lib-cap", ir_id: null },
  });

  // Decline is the chain's ordinary remove, sent for that insert alone.
  ui.click('[data-act=insert-remove][data-insert-id="ins-amp-2"]');
  const removes = ui.commands("insert.remove");
  assert.equal(removes.length, 1, "Decline is one insert.remove");
  assert.deepEqual(removes[0].args, { id: "ins-amp-2" });
  assert.equal(ui.commands("insert.accept").length, 1, "and it is not an accept as well");
});

test("the monitor switch hears the chain while recording", async () => {
  const ui = await bootMixer({ fixture: await ampSong() });
  const monitor = ui.document.querySelector('[data-act=monitor][data-track-id="guitar"]');
  assert.ok(monitor, "an armed-capable audio track offers monitoring");
  assert.equal(String(monitor.textContent), "Hear the chain while recording");
  assert.match(
    String(monitor.getAttribute("title")),
    /through this track's effects and amp/,
    "and says what it sends the input through",
  );
});

// ---- the agent's mix pass --------------------------------------------------

test("A/B compare plays the song before the agent pass without changing it", async () => {
  const ui = await bootMixer();
  await ui.openMixer();
  await ui.startEngine();
  await ui.settle();

  // The pass is named and outlined.
  const banner = ui.bannerText();
  assert.match(banner, /^Crow agent made a mix pass: /, banner);
  assert.match(banner, /Added a reverb to Plate/, "the banner names the pass's steps");
  assert.match(banner, /and 2 more/, "and says how many it does not name");
  const started = ui.sent.length;

  const ab = ui.mixer().querySelector("[data-act=mix-ab]");
  assert.ok(ab, "the banner offers A/B");
  assert.equal(String(ab.textContent), "Hear: before (A/B)");
  ab.dispatchEvent(ui.event("click"));
  await ui.settle();

  const before = ui.lastSong();
  assert.ok(before, "the engine was handed the song");
  assert.equal(before.inserts["ins-eq"], undefined, "the equalizer the pass added is not in it");
  assert.equal(before.inserts["ins-comp"], undefined, "nor the compressor");
  assert.equal(before.inserts["ins-verb"], undefined, "nor the reverb on the return");
  assert.equal(before.master.target.lufs, -14, "the master is back at the target the pass replaced");
  assert.equal(before.master.target.true_peak_db, -1);
  assert.equal(
    String(ui.mixer().querySelector("[data-act=mix-ab]").textContent),
    "Hear: after (A/B)",
    "the button says what is playing",
  );

  // A/B never writes the song: no command left the page, and the document is
  // exactly as the pass left it.
  assert.equal(ui.sent.length, started, "A/B sent nothing");
  assert.equal(ui.commands("insert.remove").length, 0);
  const { snapshot } = await import("../bundles/studio/server/doc.js");
  const live = snapshot(ui.doc);
  assert.ok(live.inserts["ins-eq"], "the equalizer is still in the song");
  assert.equal(live.master.target.lufs, -16, "and the master still has the pass's target");

  // A change to the document while the song before is playing returns the page
  // to the song as it is.
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  runCommand(ui.doc, "master.set", { gain_db: -2 }, { author: HUMAN });
  ui.frame(ui.stateFrame());
  await ui.settle();
  assert.ok(ui.lastSong().inserts["ins-eq"], "the engine went back to the live song");
  assert.equal(
    String(ui.mixer().querySelector("[data-act=mix-ab]").textContent),
    "Hear: before (A/B)",
    "and the button offers the comparison again",
  );
});

test("undo of one insert change keeps the rest of the pass outlined", async () => {
  const ui = await bootMixer();
  await ui.openMixer();

  // The pass outlines the strips and chips it wrote.
  assert.ok(String(ui.strip("track:bass").className).includes("st-agent-edit"), "the bass strip is outlined");
  assert.ok(String(ui.chip("ins-verb").className).includes("st-agent-edit"), "so is the reverb's chip");
  assert.ok(String(ui.strip("track:keys").className).includes("st-agent-edit") === false, "the keys are not");

  // The operator takes ONE step back from its own history row.
  const row = ui.document.querySelector('[data-entry-id="e9"] [data-act=undo]');
  assert.ok(row, "the reverb's step offers its own Undo");
  row.dispatchEvent(ui.event("click"));
  await ui.settle();
  ui.fixture.undo(ui.fixture.pass[3]);
  await ui.answerUndo(true);

  assert.equal(ui.mixer().querySelector('[data-insert-id="ins-verb"]'), null, "the reverb is gone from the song");
  assert.ok(String(ui.strip("track:bass").className).includes("st-agent-edit"), "the bass strip keeps its outline");
  assert.ok(String(ui.chip("ins-comp").className).includes("st-agent-edit"), "and so does the compressor's chip");
  assert.match(ui.bannerText(), /^Crow agent made a mix pass/, "the pass is still the pass");
  assert.equal(
    ui.mixer().querySelector("[data-role=mix-stopped]"),
    null,
    "an undone step is not a stopped pass",
  );
});

test("undo pass stops at a conflict and says so", async () => {
  const ui = await bootMixer();
  await ui.openMixer();

  const button = ui.mixer().querySelector("[data-act=mix-undo-pass]");
  assert.ok(button, "the banner offers Undo pass");
  assert.equal(String(button.textContent), "Undo pass");
  button.dispatchEvent(ui.event("click"));
  await ui.settle();

  assert.equal(ui.undos().length, 1, "the pass takes its newest step back first");
  assert.equal(
    String(ui.mixer().querySelector("[data-act=mix-undo-pass]").textContent),
    "Undoing\u2026",
    "and says it is working while it waits",
  );

  // The newest step goes back; the next one the hub refuses, because it was
  // changed after the pass.
  ui.fixture.undo(ui.fixture.pass[4]);
  await ui.answerUndo(true);
  assert.equal(ui.undos().length, 2, "the pass went on to the next step");

  const refused = ui.fixture.pass[3];
  await ui.answerUndo(false, {
    code: "conflict",
    error: "That step is already undone.",
    conflicts: [{ ref: "insert:ins-verb", field: "*", expected: {}, actual: null, gone: true }],
  });

  assert.equal(ui.undos().length, 2, "a refused step stops the pass: no third undo");
  const stopped = ui.mixer().querySelector("[data-role=mix-stopped]");
  assert.ok(stopped, `the banner says why it stopped: ${ui.mixer().textContent}`);
  assert.equal(
    String(stopped.textContent),
    `Stopped: ${refused.summary} was changed after the pass; the steps before it are undone.`,
  );
});

test("a reconnect during an undo pass stops it with a message", async () => {
  const ui = await bootMixer();
  await ui.openMixer();

  ui.click("[data-act=mix-undo-pass]");
  await ui.settle();
  assert.equal(ui.undos().length, 1, "the pass is waiting on its first step");

  // The socket drops and comes back: the answer to the step that was on the
  // wire died with it, so the pass stops instead of waiting forever.
  ui.frame(ui.stateFrame());
  await ui.settle();

  const stopped = ui.mixer().querySelector("[data-role=mix-stopped]");
  assert.ok(stopped, `the banner says why it stopped: ${ui.mixer().textContent}`);
  assert.equal(
    String(stopped.textContent),
    "Stopped: the connection dropped; the steps before it are undone.",
  );
  assert.equal(
    String(ui.mixer().querySelector("[data-act=mix-undo-pass]").textContent),
    "Undo pass",
    "and the button offers the pass again",
  );
  assert.equal(ui.undos().length, 1, "no further step was sent");
});

test("undo pass stops at a partial undo", async () => {
  const ui = await bootMixer();
  await ui.openMixer();

  ui.click("[data-act=mix-undo-pass]");
  await ui.settle();
  assert.equal(ui.undos().length, 1, "the pass takes its newest step back first");

  // The hub says ok, but names the fields it could not take back: part of the
  // step was changed after the pass, so the pass stops there.
  const partial = ui.fixture.pass[4];
  ui.fixture.undo(partial);
  await ui.answerUndo(true, {
    conflicts: [
      {
        ref: "master",
        field: "target",
        expected: { lufs: -16, true_peak_db: -1.5 },
        actual: { lufs: -14, true_peak_db: -1 },
      },
    ],
  });

  assert.equal(ui.undos().length, 1, "a partial undo stops the pass: no next step");
  const stopped = ui.mixer().querySelector("[data-role=mix-stopped]");
  assert.ok(stopped, `the banner says why it stopped: ${ui.mixer().textContent}`);
  assert.equal(
    String(stopped.textContent),
    `Stopped: ${partial.summary} was changed after the pass; the steps before it are undone.`,
  );
});

test("undo then redo inside a pass keeps the pass whole and A/B includes the redone step", async () => {
  const ui = await bootMixer();

  // One step of the pass is taken back and put back: the newest step is the
  // master's target, so the pass is what the page still shows.
  const step = ui.fixture.pass[4];
  const undoEntry = ui.fixture.undo(step);
  ui.fixture.redo(undoEntry);
  ui.frame(ui.stateFrame());
  await ui.settle();
  await ui.openMixer();
  await ui.startEngine();
  await ui.settle();

  assert.match(ui.bannerText(), /^Crow agent made a mix pass: /, "the pass is still named");
  assert.match(ui.bannerText(), /and 2 more/, "and still holds all five of its steps");
  assert.ok(String(ui.chip("ins-eq").className).includes("st-agent-edit"), "the equalizer's chip is outlined");
  assert.ok(String(ui.chip("ins-verb").className).includes("st-agent-edit"), "and so is the reverb's");

  // A/B hears the song before the pass — including the step that was undone
  // and redone: it is part of the pass again.
  ui.click("[data-act=mix-ab]");
  await ui.settle();
  const before = ui.lastSong();
  assert.ok(before, "the engine was handed the song");
  assert.equal(before.inserts["ins-eq"], undefined, "the effects the pass added are not in it");
  assert.equal(before.inserts["ins-verb"], undefined);
  assert.equal(before.master.target.lufs, -14, "nor is the target the redone step set");
});

// ---- live, in a real browser ----------------------------------------------

/** The project every live song in this file belongs to. */
const PROJECT = 74;

let chrome = null;
let server = null;
let upgrades = null;
let db = null;
let hub = null;
let base = "";
let crowHome = "";
let dir = "";

const BUNDLE_DIR = new URL("../bundles/studio", import.meta.url).pathname.replace(/\/$/, "");

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
  dir = mkdtempSync(join(tmpdir(), "studio-mixer-live-"));
  crowHome = join(dir, "home");
  db = createClient({ url: "file:" + join(dir, "crow.db") });
  await db.execute(
    "CREATE TABLE IF NOT EXISTS project_spaces (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, status TEXT, archived_at TEXT)",
  );
  await db.execute({ sql: "INSERT INTO project_spaces (id, name) VALUES (?, ?)", args: [PROJECT, "Mix project"] });
  await initStudioTables(db);

  const webRef = { web: null };
  hub = createHub({
    db,
    acl: fakeAcl(),
    onBroadcast: (id, payload) => webRef.web?.broadcast(id, payload),
  });

  const web = createStudioWeb({
    hub,
    Router,
    WebSocketServer,
    auth: {
      isAllowedNetwork: () => true,
      sessionFromRequest: (req) => cookieOf(req.headers.cookie, "crow_session"),
      verifySession: async (token) => token === "good",
      csrfTokenAccepted: (_req, presented) => presented === "csrf-ok",
      classifyPeer: () => ({ via: "local" }),
    },
    crowHome,
    bundleDir: BUNDLE_DIR,
  });
  webRef.web = web;

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

  chrome = await startHeadlessChrome({ extraArgs: ["--autoplay-policy=no-user-gesture-required"] });

  server = createServer(app);
  upgrades = web.attachUpgrade(server);
  await new Promise((resolve) => server.listen(0, chrome?.bindHost ?? "127.0.0.1", resolve));
  base = `http://${chrome?.pageHost ?? "127.0.0.1"}:${server.address().port}`;
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
 * A song for one live test: one track, and the agent's two effects on it, made
 * through the real hub so the pass in its history is a real one.
 * @param {{withPass?: boolean}} [options]
 * @returns {Promise<{songId: string}>}
 */
async function liveSong(options = {}) {
  const created = await hub.createSong({ project_id: PROJECT, title: "Mixer live", author: HUMAN });
  assert.equal(created.ok, true, `createSong was refused: ${created.error}`);
  const songId = created.song_id;
  const run = async (command, args, author) => {
    const result = await hub.runCommand({ song_id: songId, cmd_id: null, command, args, author });
    assert.equal(result.ok, true, `${command} was refused: ${result.error}`);
    return result;
  };
  await run("track.add", { id: "bass", name: "Bass" }, HUMAN);
  await run("scene.add", { id: "verse", name: "Verse" }, HUMAN);
  if (options.withPass !== false) {
    await run("insert.add", { id: "ins-eq", owner: "track:bass", kind: "eq" }, AGENT);
    await run("insert.add", { id: "ins-comp", owner: "track:bass", kind: "compressor" }, AGENT);
  }
  return { songId };
}

/** The studio page's URL for one song. */
function studioUrl(songId) {
  return `${base}/dashboard/studio?song=${encodeURIComponent(songId)}`;
}

/**
 * Open one page in the private browser and return its CDP handle.
 * @param {string} url
 * @returns {Promise<{evaluate: Function, send: Function, close: Function}>}
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
        JSON.stringify(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text).slice(0, 500),
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
    const outcome = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
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
    send,
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
async function waitFor(page, expression, timeoutMs = 10000) {
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

/** Wait until the page has its replica and its grid. */
async function waitForStudio(page) {
  const ready = await waitFor(page, "!!document.querySelector('[data-role=grid] .st-corner')", 20000);
  assert.ok(ready, "the studio grid never rendered (the page's Yjs replica did not load)");
}

/** Open the mixer screen and wait for its strips. */
async function openMixer(page) {
  await page.evaluate("document.querySelector('[data-act=mode-mixer]').click(), true");
  const shown = await waitFor(page, "!!document.querySelector('[data-role=mixer] [data-role=mix-strips]')", 10000);
  assert.ok(shown, "the mixer never drew its strips");
}

/** One element's box and the chain's chip ids, measured in the page. */
async function chipBox(page, insertId) {
  return page.evaluate(`(function () {
    var chip = document.querySelector('[data-act=insert-chip][data-insert-id=${JSON.stringify(insertId)}]');
    if (!chip) return null;
    var box = chip.getBoundingClientRect();
    return { x: box.left + box.width / 2, top: box.top, bottom: box.bottom, y: box.top + box.height / 2 };
  })()`);
}

/** The insert ids of one chain, in the order the page draws them. */
async function chainIds(page) {
  return page.evaluate(`(function () {
    var chips = document.querySelectorAll('[data-chain="track:bass"] [data-act=insert-chip]');
    var ids = [];
    for (var i = 0; i < chips.length; i += 1) ids.push(chips[i].getAttribute('data-insert-id'));
    return ids;
  })()`);
}

/** How many history rows the page shows that say one thing. */
async function historyRows(page, text) {
  return page.evaluate(`(function () {
    var rows = document.querySelectorAll('.st-entry-text');
    var count = 0;
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i].textContent.indexOf(${JSON.stringify(text)}) === 0) count += 1;
    }
    return count;
  })()`);
}

test("reordering an effect with a real drag sends one insert.move", async (t) => {
  if (!chrome) return t.skip("no headless Chrome available");
  const { songId } = await liveSong();
  const page = await openPage(studioUrl(songId));
  t.after(() => page.close());
  await waitForStudio(page);
  await openMixer(page);
  // The strips can draw before the song's chain reaches them (a slower runner
  // gets the state frame later): wait for both chips, not just the strip box.
  const drawn = await waitFor(
    page,
    "document.querySelectorAll('[data-chain=\"track:bass\"] [data-act=insert-chip]').length === 2",
    10000,
  );
  assert.ok(drawn, "the bass chain never drew its two effects");

  assert.deepEqual(await chainIds(page), ["ins-eq", "ins-comp"], "the chain starts in the order it was built");
  assert.equal(await historyRows(page, "Moved"), 0, "nothing has been moved yet");
  const menu = await page.evaluate(
    "document.querySelector('[data-chain=\"track:bass\"] [data-act=insert-add]').options.length",
  );
  assert.ok(menu > 3, `the + effect menu lists the effects the page was handed (${menu})`);

  // A real drag: press the second chip, move it above the first one's middle,
  // and let it go. Under load the strips can still be settling (a late meter
  // or state redraw), so wait until both chips hold still for two reads before
  // the press: a press measured against a box that then moves misses the chip.
  let from = null;
  let first = null;
  for (let tries = 0; tries < 50; tries += 1) {
    const a = await chipBox(page, "ins-comp");
    const b = await chipBox(page, "ins-eq");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const a2 = await chipBox(page, "ins-comp");
    const b2 = await chipBox(page, "ins-eq");
    if (a && b && a2 && b2 && JSON.stringify(a) === JSON.stringify(a2) && JSON.stringify(b) === JSON.stringify(b2)) {
      from = a2;
      first = b2;
      break;
    }
  }
  assert.ok(from && from.y > 0, "the chip has a box on screen");
  assert.ok(first && first.y > 0, "so does the one above it");
  const dropY = first.top + 4;
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 });
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: dropY + 12, button: "left", buttons: 1 });
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: dropY, button: "left", buttons: 1 });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: from.x, y: dropY, button: "left", buttons: 0, clickCount: 1 });

  const moved = await waitFor(page, "document.querySelectorAll('[data-chain=\"track:bass\"] [data-act=insert-chip]')[0].getAttribute('data-insert-id') === 'ins-comp'", 10000);
  assert.ok(moved, "the dragged chip is now first in the chain");
  assert.equal(await historyRows(page, "Moved"), 1, "a whole drag is ONE insert.move");

  // The drag swallowed its own click: the editor stayed shut.
  const editorHidden = await page.evaluate("document.querySelector('[data-role=mix-editor]').hidden");
  assert.equal(editorHidden, true, "a drag opens no editor");
});

test("the mixer strips scroll inside their box at phone width", async (t) => {
  if (!chrome) return t.skip("no headless Chrome available");
  const { songId } = await liveSong();
  const page = await openPage(studioUrl(songId));
  t.after(() => page.close());
  await waitForStudio(page);
  await openMixer(page);

  // Every strip, the master's included, lives inside ONE box: that box is what
  // scrolls sideways, so the page itself never does. The draw can happen before
  // the replica carries the track, so the strips are waited for.
  const drawn = await waitFor(page, "document.querySelectorAll('[data-role=mixer] [data-strip]').length > 1", 10000);
  assert.ok(drawn, "the mixer drew its strips");
  const strips = await page.evaluate(`(function () {
    var scroller = document.querySelector('[data-role=mix-strips]');
    if (!scroller) return null;
    var found = document.querySelectorAll('[data-role=mixer] [data-strip]');
    var inside = 0;
    var owners = [];
    for (var i = 0; i < found.length; i += 1) {
      owners.push(String(found[i].getAttribute('data-strip')));
      if (found[i].parentNode === scroller) inside += 1;
    }
    return { total: found.length, inside: inside, owners: owners };
  })()`);
  assert.ok(strips && strips.total > 1, `the strips are drawn (${JSON.stringify(strips)})`);
  assert.equal(strips.inside, strips.total, "every strip is inside the scrolling box");

  // A phone: 375 px wide, as the browser lays the page out.
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 375,
    height: 812,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const measured = await page.evaluate(`(function () {
    var box = document.querySelector('[data-role=mix-strips]');
    var strip = document.querySelector('[data-role=mixer] [data-strip]');
    return {
      inner: window.innerWidth,
      pageScroll: document.documentElement.scrollWidth,
      boxScroll: box.scrollWidth,
      boxClient: box.clientWidth,
      stripWidth: strip.getBoundingClientRect().width
    };
  })()`);
  await page.send("Emulation.clearDeviceMetricsOverride");

  assert.equal(measured.inner, 375, "the page is laid out at phone width");
  assert.ok(
    measured.boxScroll > measured.boxClient,
    `the strips scroll inside their box at 375 px (${measured.boxScroll} > ${measured.boxClient})`,
  );
  assert.ok(
    measured.pageScroll <= measured.inner,
    `the page itself never scrolls sideways (${measured.pageScroll} <= ${measured.inner})`,
  );
  assert.ok(
    measured.stripWidth >= 140 && measured.stripWidth <= 170,
    `a strip is narrower instead of wrapping (${measured.stripWidth})`,
  );
});

test("A/B clicked with real mouse input hands the engine the song before the pass", async (t) => {
  if (!chrome) return t.skip("no headless Chrome available");
  const { songId } = await liveSong();
  const page = await openPage(studioUrl(songId));
  t.after(() => page.close());
  await waitForStudio(page);
  await openMixer(page);

  // The first draw can happen before the replica and the history arrive, so the
  // banner is waited for rather than read once.
  const banner = await waitFor(
    page,
    "(function () { var node = document.querySelector('[data-role=mix-banner]'); return node ? node.textContent : ''; })()",
    10000,
  );
  assert.ok(banner && /Crow agent made a mix pass/.test(banner), `the agent's pass is named (${banner})`);
  const outlined = await page.evaluate("document.querySelector('[data-strip=\"track:bass\"]').className.indexOf('st-agent-edit') >= 0");
  assert.equal(outlined, true, "and its strip wears the agent's colour");

  // The transport runs: a comparison is what the engine is PLAYING, and pressing
  // A/B may neither stop it nor move the playhead.
  await page.evaluate("document.querySelector('[data-act=play]').click(), true");
  const played = await waitFor(
    page,
    "!!document.querySelector('[data-role=position]') && document.querySelector('[data-role=position]').textContent !== '001.1.1'",
    15000,
  );
  assert.ok(played, "the transport never moved: the engine did not start");

  /** What the page last handed the engine, as the test hook recorded it. */
  const lastHanded = () => page.evaluate(`(function () {
    var songs = window.__crowStudioSongs || [];
    var song = songs.length ? songs[songs.length - 1] : null;
    if (!song) return null;
    return {
      count: songs.length,
      inserts: Object.keys(song.inserts || {}).sort(),
      lufs: song.master && song.master.target ? song.master.target.lufs : null
    };
  })()`);
  /** Press one element with a real mouse, at the middle of its box. */
  const mouseClick = async (selector) => {
    const at = await page.evaluate(`(function () {
      var node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return null;
      var box = node.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    })()`);
    assert.ok(at && at.x > 0, `${selector} has a box on screen`);
    await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", buttons: 1, clickCount: 1 });
    await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "left", buttons: 0, clickCount: 1 });
  };

  const steps = await page.evaluate("document.querySelectorAll('.st-entry').length");
  const label = () => page.evaluate("document.querySelector('[data-act=mix-ab]').textContent");

  await mouseClick("[data-act=mix-ab]");
  assert.ok(
    await waitFor(page, "document.querySelector('[data-act=mix-ab]').textContent === 'Hear: after (A/B)'", 5000),
    "the first click plays the song before the pass",
  );
  const before = await lastHanded();
  assert.ok(before, "the engine was handed a song");
  assert.deepEqual(before.inserts, [], "the snapshot it was handed lacks the pass's effects");

  // The playhead was kept: it is not back at the start, and it keeps moving.
  const playhead = await page.evaluate("document.querySelector('[data-role=position]').textContent");
  assert.notEqual(playhead, "001.1.1", `the comparison did not restart the transport (${playhead})`);
  const stillMoving = await waitFor(
    page,
    `document.querySelector('[data-role=position]').textContent !== ${JSON.stringify(playhead)}`,
    5000,
  );
  assert.ok(stillMoving, "and the transport kept running through the comparison");

  await mouseClick("[data-act=mix-ab]");
  assert.ok(
    await waitFor(page, "document.querySelector('[data-act=mix-ab]').textContent === 'Hear: before (A/B)'", 5000),
    "the second click plays it as it is",
  );
  const after = await lastHanded();
  assert.ok(after && after.count > before.count, "the engine was handed the live song again");
  assert.deepEqual(after.inserts, ["ins-comp", "ins-eq"], "and that one has the pass's effects");

  // Neither press wrote anything: the same history, and the same two effects.
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(await page.evaluate("document.querySelectorAll('.st-entry').length"), steps, "A/B added no history step");
  assert.deepEqual(await chainIds(page), ["ins-eq", "ins-comp"], "and left the chain alone");
  assert.equal(await label(), "Hear: before (A/B)");
});

test("the song page carries the effects table beside the client", () => {
  // The handler emits EFFECT_PARAMS as its own classic script, before the
  // client, so the "+ effect" menu and the insert editor read the ONE table the
  // server checks every insert.set against.
  const source = readFileSync(new URL("../bundles/studio/panel/studio.js", import.meta.url), "utf8");
  assert.match(source, /export const MIXER_EFFECTS_SCRIPT/);
  assert.ok(source.includes("${MIXER_EFFECTS_SCRIPT}"), "the song page emits it before the client");

  // The serialised table cannot close the script element or break the statement
  // it sits in: `<`, U+2028 and U+2029 travel as escapes, which JSON reads back
  // to the same characters.
  assert.equal(MIXER_EFFECTS_SCRIPT.includes("<"), false, "no raw < in the emitted JSON");
  assert.equal(MIXER_EFFECTS_SCRIPT.includes("\u2028"), false, "no raw U+2028");
  assert.equal(MIXER_EFFECTS_SCRIPT.includes("\u2029"), false, "no raw U+2029");
  assert.equal(MIXER_EFFECTS_SCRIPT.includes("</script"), false, "the script cannot end its own tag");

  // And it still carries the table itself, word for word.
  const literal = /window\.StudioMixer = (.*);\}\)\(\);$/.exec(MIXER_EFFECTS_SCRIPT);
  assert.ok(literal, `the script assigns the table: ${MIXER_EFFECTS_SCRIPT.slice(0, 120)}`);
  const table = JSON.parse(literal[1]);
  assert.deepEqual(table.kinds, [...EFFECT_KINDS]);
  assert.deepEqual(table.params, EFFECT_PARAMS);
});