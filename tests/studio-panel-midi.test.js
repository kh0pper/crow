/**
 * Studio panel — MIDI devices, Learn and the router.
 *
 * The emitted scripts (the routing rule `panel/midi-route.js`, the controllers
 * module `panel/midi.js` and the client `panel/client.js`, in that order, exactly
 * as the handler emits them) run against a linkedom document built from the page
 * the handler renders, a real Yjs song whose `midi_maps` a real `midi.map`
 * command wrote, a fake `navigator.requestMIDIAccess` with fake ports, a fake
 * Web Locks API shared by the "tabs" of a test, and a fake engine that records
 * what it was asked to do.
 *
 * What they prove: the page and the server route every case the same (one rule,
 * one module, `panel/midi-route.js`), that rule's plain-JS gate accepts exactly
 * what the zod table accepts, Web MIDI is never asked for without a click (and
 * is asked for again on a later load only while the permission is still
 * granted), Learn turns the next program change into one `midi.map` for the
 * control the operator picked, a proposal on the same message is left standing,
 * the rest of the gesture Learn mapped is not also played, a knob waits for a
 * control change, an unplugged controller that comes back by name keeps its
 * mapping, the table says who set each row, a routed pedal runs its action
 * locally and writes no history step, a proposed mapping routes nothing, and a
 * second tab holds no routing lock and so routes nothing at all — asking again
 * on its beat, and letting go of a grant that arrives after the page closed.
 *
 * No browser is needed: nothing here touches audio or Web MIDI for real.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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

/** The fixture song: one sampler track, two scenes and one pattern clip. */
const TRACK = "drums";
const SCENE = "verse";
const CHORUS = "chorus";
const CLIP = "c-beat";
/** The controller the fixture mappings name, as its port names it. */
const DEVICE = "FCB1010";

// ---- the fixture song ------------------------------------------------------

/**
 * The song these tests drive: a sampler track (so a pad can be mapped), the
 * scenes the mappings launch (so a pedal has something to launch, in the order
 * the profile walks them) and a 16-step pattern clip (so the pad-and-steps view
 * has one).
 * @param {{scenes?: Array<[string, string]>}} [options] - the scenes, in order
 * @returns {Promise<import("yjs").Doc>}
 */
async function midiDoc(options = {}) {
  const { newSongDoc } = await import("../bundles/studio/server/doc.js");
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  await import("../bundles/studio/server/commands/core.js");
  await import("../bundles/studio/server/commands/sampler.js");
  await import("../bundles/studio/server/commands/midi.js");

  const doc = newSongDoc({ title: "Pedal song", bpm: 120 });
  runCommand(doc, "track.add", { id: TRACK, name: "Beat box", kind: "sampler" });
  for (const [id, name] of options.scenes || [[SCENE, "Verse"], [CHORUS, "Chorus"]]) {
    runCommand(doc, "scene.add", { id, name });
  }
  runCommand(doc, "clip.add_pattern", {
    clip_id: CLIP,
    track_id: TRACK,
    scene_id: SCENE,
    name: "Beat",
    length_steps: 16,
  });
  return doc;
}

/**
 * One pedal mapping, written the way the operator's or the bot's own command
 * writes it: `author` is who the hub would attribute the step to.
 * @param {object} doc
 * @param {{id: string, number: number, sceneId: string, agent?: boolean,
 *          device?: string}} options
 * @returns {object} the mapping's arguments
 */
async function mapPedal(doc, options) {
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  const args = {
    id: String(options.id),
    device_name: options.device || DEVICE,
    message: { type: "pc", channel: 1, number: Number(options.number) },
    action: { kind: "scene.launch", scene_id: String(options.sceneId) },
  };
  runCommand(doc, "midi.map", args, { author: { kind: options.agent === true ? "agent" : "human" } });
  return args;
}

/** @returns {Promise<object>} the song's `midi_maps` from its snapshot */
async function mappingsOf(doc) {
  const { snapshot } = await import("../bundles/studio/server/doc.js");
  return snapshot(doc).midi_maps || {};
}

// ---- the fakes -------------------------------------------------------------

/** The panel handler's database: no projects to list. */
function panelDb() {
  return {
    async execute() {
      return { rows: [] };
    },
  };
}

/** A bare document around the panel content, as the dashboard layout makes one. */
function minimalLayout({ title, content }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>`
    + `<body>${content}</body></html>`;
}

/** A `localStorage` that keeps what it is given, and nothing across tests. */
function memoryStorage(initial = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem(key) {
      return items.has(String(key)) ? items.get(String(key)) : null;
    },
    setItem(key, value) {
      items.set(String(key), String(value));
    },
    removeItem(key) {
      items.delete(String(key));
    },
  };
}

/** The panel's take store, in memory: every call answers, nothing is kept. */
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

/**
 * The Web MIDI fake: an access whose inputs are ports this test can plug,
 * unplug (same object, state back to disconnected), swap (a FRESH object with
 * the same name, which is what a browser may hand back after a replug) and
 * send raw MIDI bytes from.
 * @param {{names?: string[]}} [options]
 */
function fakeMidiAccess(options = {}) {
  const inputs = new Map();
  const access = { inputs, outputs: new Map(), onstatechange: null };
  const requests = [];
  let made = 0;

  function addPort(name, state = "connected") {
    made += 1;
    const port = {
      id: `${name}-${made}`,
      name,
      manufacturer: "test",
      type: "input",
      state,
      onmidimessage: null,
      send(data) {
        assert.equal(typeof port.onmidimessage, "function", `${name} has a listener`);
        port.onmidimessage({ data: Uint8Array.from(data) });
      },
    };
    inputs.set(port.id, port);
    return port;
  }

  function stateChanged(port) {
    if (typeof access.onstatechange === "function") access.onstatechange({ port });
  }

  for (const name of options.names || [DEVICE]) addPort(name);

  return {
    access,
    requests,
    addPort,
    /** The port one controller is on right now, by name. */
    port(name) {
      for (const port of inputs.values()) {
        if (port.name === name && port.state !== "disconnected") return port;
      }
      return null;
    },
    /** Unplug a controller: its port stays in the map, disconnected. */
    unplug(name) {
      for (const port of inputs.values()) {
        if (port.name !== name) continue;
        port.state = "disconnected";
        stateChanged(port);
      }
    },
    /** Plug it back in as a fresh port object with the same name. */
    swap(name) {
      for (const [id, port] of [...inputs.entries()]) {
        if (port.name !== name) continue;
        inputs.delete(id);
      }
      const port = addPort(name);
      stateChanged(port);
      return port;
    },
  };
}

/**
 * The Web Locks API, in memory, shared by the "tabs" of one test: a name is
 * either held or free, an `ifAvailable` request whose name is held gets null,
 * and a held name stays held until its callback's promise settles.
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

/** The engine stand-in: it records the launches, plays and pads it was given. */
function fakeEngine() {
  const engine = {
    launches: [],
    clips: [],
    pads: [],
    releases: [],
    fx: [],
    looper: [],
    plays: 0,
    stops: 0,
    stopAlls: 0,
    songs: [],
    node: { connect() {} },
    setSong(song) { engine.songs.push(song); },
    setMode() {},
    seek() {},
    play() { engine.plays += 1; },
    stop() { engine.stops += 1; },
    stopAll() { engine.stopAlls += 1; },
    launchScene(id) { engine.launches.push(String(id)); },
    launchClip(id) { engine.clips.push(String(id)); },
    onPosition() { return () => {}; },
    onLaunch() { return () => {}; },
    onError() { return () => {}; },
    onSampleNeeded() { return () => {}; },
    onTap() { return () => {}; },
    tap() {},
    livePad(trackId, bankId, index, v) {
      engine.pads.push({ track_id: String(trackId), bank_id: String(bankId), index: Number(index), v: Number(v) });
    },
    liveRelease(trackId, bankId, index) {
      engine.releases.push({ track_id: String(trackId), bank_id: String(bankId), index: Number(index) });
    },
    fxHold(name, amount) { engine.fx.push({ name: String(name), amount: Number(amount), on: true }); },
    fxRelease(name) { engine.fx.push({ name: String(name), amount: 0, on: false }); },
    looper(action) { engine.looper.push(String(action)); },
    loadSample() { return Promise.resolve(); },
    unloadSample() {},
    loadAudio() {},
    unloadAudio() {},
    async nextBarFrame() { return { frame: 0, bar: 1 }; },
    createRecorder() { return Promise.reject(new Error("these tests record nothing")); },
    dispose() {},
  };
  return engine;
}

// ---- booting one page ------------------------------------------------------

/**
 * Boot the two emitted scripts, in the handler's own order, against the page
 * the handler renders.
 * @param {{doc?: object, locks?: object, midi?: object, workspace?: object,
 *          permissions?: object}} [options]
 */
async function bootMidi(options = {}) {
  const { parseHTML } = await import("linkedom");
  const { encodeDocState } = await import("../bundles/studio/server/doc.js");
  const { CLIENT_SCRIPT } = await import("../bundles/studio/panel/client.js");
  const { MIDI_SCRIPT } = await import("../bundles/studio/panel/midi.js");
  const { MIDI_ROUTE_SCRIPT } = await import("../bundles/studio/panel/midi-route.js");

  const doc = options.doc || (await midiDoc());
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
  assert.ok(res.html.includes('data-act="midi-connect"'), "the header carries Connect controllers");
  assert.ok(res.html.includes('data-act="midi-learn"'), "and the Learn toggle");
  assert.ok(res.html.includes('data-role="midi"'), "the page carries the MIDI section");
  // The scripts travel in the handler's order: the routing rule and then the
  // controllers module first, so window.StudioMidiRoute and window.StudioMidi
  // are there when the client boots.
  assert.ok(
    res.html.indexOf("window.StudioMidiRoute") < res.html.indexOf("window.StudioMidi "),
    "the routing rule is emitted before the controllers module",
  );
  assert.ok(
    res.html.indexOf("window.StudioMidi") < res.html.indexOf("var COMMANDS = ["),
    "the MIDI scripts are emitted before the client",
  );
  assert.ok(res.html.includes(MIDI_ROUTE_SCRIPT), "the page carries the routing script verbatim");
  const { document, window: domWindow } = parseHTML(res.html);

  const midi = options.midi || fakeMidiAccess();
  const engine = fakeEngine();
  const store = fakeTakeStore();
  const sent = [];
  const requests = [];
  const localStorage = options.workspace || memoryStorage();

  const navigatorStub = {
    mediaDevices: null,
    // Task 9's pages are the ones that route, so the fixture advertises MIDI.
    requestMIDIAccess(settings) {
      midi.requests.push(settings);
      return Promise.resolve(midi.access);
    },
    locks: options.locks || null,
    permissions: options.permissions || null,
  };

  const response = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async arrayBuffer() { return new ArrayBuffer(0); },
  });

  const fetchStub = async (url) => {
    const target = String(url);
    requests.push(target);
    if (target.includes("/module-types")) return response(200, { generators: ["Analog generator"], modules: {} });
    if (target.includes("/project-bot")) return response(404, { error: "not_found" });
    if (target.includes("/api/studio/songs")) return response(200, [{ id: "song-1", project_id: 7, title: "Pedal song" }]);
    return response(200, {});
  };

  const socket = { readyState: 1, handlers: {} };
  socket.addEventListener = (name, handler) => {
    (socket.handlers[name] ||= []).push(handler);
    if (name === "open") Promise.resolve().then(() => handler());
  };
  socket.send = (text) => sent.push(JSON.parse(text));
  socket.close = () => { socket.readyState = 3; };

  const windowListeners = {};
  const windowStub = {
    crypto: globalThis.crypto,
    location: { protocol: "http:", host: "127.0.0.1:1", reload() {} },
    atob: globalThis.atob,
    confirm: () => true,
    localStorage,
    AudioContext: function AudioContextStub() {
      return { sampleRate: 48000, state: "running", destination: {}, createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} }), resume: async () => {}, close() {} };
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
  const clientText = CLIENT_SCRIPT.replace("'/dashboard/studio/assets/yjs.mjs'", JSON.stringify(yjsUrl));
  assert.notEqual(clientText, CLIENT_SCRIPT, "the test replaces the Yjs asset URL with the file on disk");

  const timers = [];
  // One scope, four scripts, in the order the page emits them.
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
    `${MIDI_ROUTE_SCRIPT}\n${MIDI_SCRIPT}\n${clientText}`,
  );
  run(
    document,
    windowStub,
    navigatorStub,
    function WebSocketStub() { return socket; },
    fetchStub,
    globalThis.crypto,
    globalThis.atob,
    console,
    (fn) => { timers.push(fn); return timers.length; },
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
    midi,
    engine,
    localStorage,
    sent,
    page,
    click,
    event,
    settle,
    frame,
    stateFrame,
    timers,
    /** Let the page draw the song again from the document as it now stands. */
    async redraw() {
      frame(stateFrame());
      await settle();
    },
    /** Run the real server commands on the fixture song, then redraw the page. */
    async apply(command, args, author) {
      const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
      runCommand(doc, command, args, author ? { author } : {});
      await ui.redraw();
    },
    /** Send raw MIDI bytes from the named controller's port. */
    pedal(name, bytes) {
      const port = midi.port(name);
      assert.ok(port, `${name} is plugged in`);
      port.send(bytes);
    },
    /** The device row the section draws for one controller. */
    deviceRow(name) {
      return document.querySelector(`[data-role=midi] [data-device-name="${name}"]`);
    },
    /** One mapping's row in the table. */
    mappingRow(id) {
      return document.querySelector(`[data-role=midi] [data-mapping-id="${id}"]`);
    },
    /** The header sentence about the routing lock, if any. */
    lockState() {
      const node = document.querySelector("[data-role=midi-state]");
      assert.ok(node, "the header carries the lock state");
      return String(node.textContent || "");
    },
    /** What the page's toast says right now. */
    toastText() {
      const node = document.querySelector("[data-role=toast]");
      assert.ok(node, "the page carries a toast");
      return String(node.textContent || "");
    },
    /** Take this page down the way Turbo does before a visit. */
    teardown() {
      document.dispatchEvent(new domWindow.Event("turbo:before-cache"));
    },
    /**
     * Run every timer the page has scheduled so far (its idle windows, its
     * retry beat, its debounces). The harness keeps them instead of running
     * them, so a test decides when time passes.
     */
    runTimers() {
      const pending = timers.splice(0);
      for (const fn of pending) {
        try {
          fn();
        } catch (err) {
          // A timer that throws is the test's to see, not the next one's.
          assert.fail(`a page timer threw: ${err && err.message}`);
        }
      }
    },
  };
  return ui;
}

/** @returns {object[]} every command frame of one id the page sent, in order. */
function commands(ui, id) {
  return ui.sent.filter((message) => message.type === "command" && message.command === id);
}

/** @returns {object[]} every frame the page sent that would become a history step. */
function historyFrames(ui) {
  return ui.sent.filter((message) => message.type === "command" || message.type === "undo" || message.type === "redo");
}

/**
 * A Web Locks API whose grants arrive when the test says so: a request is
 * recorded, and `grant()` runs its callback the way a browser does — holding the
 * name only until that callback's promise settles.
 */
function gatedLocks() {
  const asked = [];
  const heldNames = new Set();
  return {
    asked,
    heldNames,
    request(name, options, run) {
      const entry = {
        name,
        options,
        /** Grant it now, the way a browser does: hold the name until settled. */
        grant() {
          const callback = typeof options === "function" ? options : run;
          const settings = typeof options === "function" ? {} : options || {};
          if (heldNames.has(name) && settings.ifAvailable) {
            callback(null);
            return;
          }
          heldNames.add(name);
          const settle = () => {
            heldNames.delete(name);
          };
          Promise.resolve(callback({ name })).then(settle, settle);
        },
      };
      asked.push(entry);
      return Promise.resolve(undefined);
    },
    async query() {
      return { held: [...heldNames].map((name) => ({ name })), pending: [] };
    },
  };
}

// ---- the tests -------------------------------------------------------------

test("MIDI is never requested without a click", async () => {
  const { MIDI_SCRIPT } = await import("../bundles/studio/panel/midi.js");
  // The panel's inline-script rule, on the text the page really emits.
  assert.equal(MIDI_SCRIPT.includes("\u0060"), false, "no backtick: the panel rule");
  assert.equal(MIDI_SCRIPT.includes("$" + "{"), false, "no template interpolation");
  assert.equal(MIDI_SCRIPT.includes('"'), false, "no double quote");
  assert.equal(MIDI_SCRIPT.includes("\\"), false, "no backslash either");
  assert.equal(MIDI_SCRIPT.includes("</script"), false, "and it cannot close its own tag");

  const quiet = await bootMidi();
  assert.equal(quiet.midi.requests.length, 0, "a page load asks for nothing");
  assert.match(String(quiet.document.querySelector("[data-role=midi]").textContent),
    /Connect controllers to play this song/, "and says how to open it");

  // The click is the gesture: one request, sysex off, and the device list.
  quiet.click("[data-act=midi-connect]");
  await quiet.settle();
  assert.equal(quiet.midi.requests.length, 1, "the button asks once");
  assert.deepEqual(quiet.midi.requests[0], { sysex: false }, "without sysex");
  assert.ok(quiet.deviceRow(DEVICE), "the controller is in the list");
  assert.match(String(quiet.deviceRow(DEVICE).textContent), /Connected/);

  // Maybe (one page already said yes): a later load asks again — but only while
  // the browser still reports the permission as granted.
  const grantedAccess = fakeMidiAccess();
  const granted = await bootMidi({
    midi: grantedAccess,
    workspace: memoryStorage({ "studio-midi-granted": "yes" }),
    permissions: { async query(descriptor) { return { name: descriptor.name, state: "granted" }; } },
  });
  await granted.settle();
  assert.equal(grantedAccess.requests.length, 1, "a granted permission opens without a click");
  assert.ok(granted.deviceRow(DEVICE), "and its devices are listed");

  const stillPrompt = fakeMidiAccess();
  const prompted = await bootMidi({
    midi: stillPrompt,
    workspace: memoryStorage({ "studio-midi-granted": "yes" }),
    permissions: { async query() { return { state: "prompt" }; } },
  });
  await prompted.settle();
  assert.equal(stillPrompt.requests.length, 0, "a permission that is not granted yet waits for the button");
});

test("learn maps the next program change to a scene launch", async () => {
  const ui = await bootMidi();
  ui.click("[data-act=midi-connect]");
  await ui.settle();

  // Learn on, then the control it should map: the Chorus scene's launch button.
  ui.click("[data-act=midi-learn]");
  const launchButton = ui.document.querySelector(`[data-act=launch-scene][data-scene-id=${CHORUS}]`);
  assert.ok(launchButton, "the Chorus launch button is drawn");
  ui.click(`[data-act=launch-scene][data-scene-id=${CHORUS}]`);

  assert.equal(ui.document.querySelector("[data-act=midi-learn]").getAttribute("aria-pressed"), "true",
    "Learn is on");
  const outlined = ui.document.querySelector(`[data-act=launch-scene][data-scene-id=${CHORUS}]`);
  assert.ok(String(outlined.className).includes("st-learn"), "the control Learn is waiting on is outlined");
  assert.equal(ui.engine.launches.length, 0, "picking a control launches nothing");

  // The next program change is the mapping.
  ui.pedal(DEVICE, [0xc0, 3]);
  await ui.settle();

  const maps = commands(ui, "midi.map");
  assert.equal(maps.length, 1, "one midi.map");
  const args = maps[0].args;
  assert.equal(args.device_name, DEVICE);
  assert.deepEqual(args.message, { type: "pc", channel: 1, number: 3 }, "the program change it heard");
  assert.deepEqual(args.action, { kind: "scene.launch", scene_id: CHORUS }, "the control it was told");
  assert.equal(ui.document.querySelector("[data-act=midi-learn]").getAttribute("aria-pressed"), "false",
    "Learn is off again once it has its message");

  // The arguments are the command's own: the hub accepts exactly what the page
  // built, and the mapping it writes is live (the operator's own).
  await ui.apply("midi.map", args, { kind: "human" });
  const stored = (await mappingsOf(ui.doc))[args.id];
  assert.ok(stored, "the mapping is in the song");
  assert.equal(stored.proposed, false, "the operator's mapping is live at once");
  assert.deepEqual(stored.message, args.message);
  assert.ok(ui.mappingRow(args.id), "and the table draws it");
  assert.match(String(ui.mappingRow(args.id).textContent), /Launch scene Chorus/);
});

test("unplugging and replugging keeps the mapping", async () => {
  const doc = await midiDoc();
  await mapPedal(doc, { id: "m-pedal-3", number: 3, sceneId: CHORUS });
  const ui = await bootMidi({ doc });
  ui.click("[data-act=midi-connect]");
  await ui.settle();
  assert.ok(ui.deviceRow(DEVICE), "the controller is listed");

  ui.midi.unplug(DEVICE);
  await ui.settle();
  assert.match(String(ui.deviceRow(DEVICE).textContent), /Unplugged/, "an unplugged controller says so");
  assert.ok(ui.mappingRow("m-pedal-3"), "its mapping is still the song's");

  // Back in, as a fresh port object with the same name: the mapping is by name,
  // so the pedal drives the same scene again.
  ui.midi.swap(DEVICE);
  await ui.settle();
  assert.match(String(ui.deviceRow(DEVICE).textContent), /Connected/, "the replugged controller is connected");
  ui.pedal(DEVICE, [0xc0, 3]);
  await ui.settle();
  assert.deepEqual(ui.engine.launches, [CHORUS], "its mapping still launches the Chorus");
});

test("the mapping table shows who set each row", async () => {
  const doc = await midiDoc();
  await mapPedal(doc, { id: "m-mine", number: 2, sceneId: SCENE });
  await mapPedal(doc, { id: "m-theirs", number: 4, sceneId: CHORUS, agent: true });
  const ui = await bootMidi({ doc });

  const mine = ui.mappingRow("m-mine");
  const theirs = ui.mappingRow("m-theirs");
  assert.ok(mine, "the operator's row is drawn");
  assert.ok(theirs, "so is the bot's");

  assert.equal(String(mine.querySelector(".st-midi-by").textContent), "you", "the operator's row is yours");
  assert.equal(String(theirs.querySelector(".st-midi-by").textContent), "proposed (by the bot)",
    "the bot's row says it is a proposal, and who proposed it");
  assert.match(String(mine.textContent), /program change 2/, "the row names the message");
  assert.match(String(mine.querySelector(".st-midi-does").textContent), /Launch scene Verse/,
    "and what the message does");

  // A profile run by the operator proposes rows too: those are proposals of
  // YOURS, and only the operator's own yes makes one live.
  await ui.apply("midi.propose_profile", { device: "fcb1010", device_name: DEVICE }, { kind: "human" });
  const proposed = ui.mappingRow("fcb1010-pedal-1");
  assert.ok(proposed, "the operator's own proposal is listed");
  assert.equal(String(proposed.querySelector(".st-midi-by").textContent), "proposed (by you)",
    "a proposal of the operator's says so, in the first person");

  // A bot's row that the operator accepted is live, and says who set it: the
  // bot proposed, the operator said yes (midi.accept is the operator's alone).
  await ui.apply("midi.accept", {
    id: "m-theirs",
    expect: {
      device_name: DEVICE,
      message: { type: "pc", channel: 1, number: 4 },
      action: { kind: "scene.launch", scene_id: CHORUS },
    },
  }, { kind: "human" });
  assert.equal(String(ui.mappingRow("m-theirs").querySelector(".st-midi-by").textContent),
    "the bot (accepted)", "an accepted bot row says it was accepted");
});

test("a routed pedal launches its scene and makes no history step", async () => {
  const doc = await midiDoc();
  await mapPedal(doc, { id: "m-pedal-3", number: 3, sceneId: CHORUS });
  const ui = await bootMidi({ doc });
  ui.click("[data-act=midi-connect]");
  await ui.settle();
  assert.equal(ui.engine.launches.length, 0, "nothing has been launched yet");
  const before = historyFrames(ui).length;

  // The messages Studio has no action for are dropped, not routed: clock, after
  // touch and pitch bend all arrive on the same port first.
  ui.pedal(DEVICE, [0xf8]);
  ui.pedal(DEVICE, [0xd0, 40]);
  ui.pedal(DEVICE, [0xe0, 0, 64]);
  await ui.settle();
  assert.equal(ui.engine.launches.length, 0, "clock, aftertouch and pitch bend do nothing");

  ui.pedal(DEVICE, [0xc0, 3]);
  await ui.settle();

  assert.deepEqual(ui.engine.launches, [CHORUS], "the pedal launched the Chorus");
  assert.equal(ui.engine.plays, 1, "and the stopped transport started");
  assert.equal(historyFrames(ui).length, before, "a routed action is never a history step");
  assert.equal(commands(ui, "midi.map").length, 0, "and it never writes the table");
});

test("a proposed mapping does nothing when its pedal is pressed", async () => {
  const doc = await midiDoc();
  await mapPedal(doc, { id: "m-proposed", number: 5, sceneId: CHORUS, agent: true });
  const ui = await bootMidi({ doc });
  ui.click("[data-act=midi-connect]");
  await ui.settle();

  ui.pedal(DEVICE, [0xc0, 5]);
  await ui.settle();

  assert.deepEqual(ui.engine.launches, [], "the bot's proposal launched nothing");
  assert.equal(ui.engine.plays, 0, "and started no transport");
  assert.equal(historyFrames(ui).length, 0, "every routed action wrote nothing");
  assert.ok(ui.mappingRow("m-proposed"), "the proposal is listed for the operator to decide on");
});

test("a second tab routes nothing", async () => {
  const locks = fakeLocks();
  const doc = await midiDoc();
  await mapPedal(doc, { id: "m-pedal-3", number: 3, sceneId: CHORUS });

  const first = await bootMidi({ doc, locks });
  first.click("[data-act=midi-connect]");
  await first.settle();
  assert.ok(locks.held.has("studio-midi-song-1"), "the first tab holds the song's routing lock");
  assert.equal(first.lockState(), "", "and says nothing about another tab");

  const second = await bootMidi({ doc, locks });
  second.click("[data-act=midi-connect]");
  await second.settle();
  assert.equal(second.lockState(), "Another tab is listening to MIDI for this song.",
    "the second tab says which tab is listening");

  second.pedal(DEVICE, [0xc0, 3]);
  await second.settle();
  assert.deepEqual(second.engine.launches, [], "the second tab routed nothing");
  assert.equal(second.engine.plays, 0, "and started no transport");

  first.pedal(DEVICE, [0xc0, 3]);
  await first.settle();
  assert.deepEqual(first.engine.launches, [CHORUS], "the tab with the lock is the one that plays");
});

// ---- the one routing rule --------------------------------------------------

/**
 * A live mapping as a snapshot holds one: the shape server/commands/midi.js
 * writes, with `accepted_action` copied from the action unless a case moves it
 * on the way a hand-written document can.
 */
function liveMapping(id, action, message, extra = {}) {
  return {
    id,
    device_name: "D",
    message,
    action,
    set_by: "operator",
    proposed: false,
    accepted_action: action === null ? null : JSON.parse(JSON.stringify(action)),
    ...extra,
  };
}

/** The message most cases arrive on: program change 3 on channel 1 of "D". */
const PC3 = { type: "pc", channel: 1, number: 3 };
const NOTE3 = { type: "note", channel: 1, number: 3 };
const NOTE0 = { type: "note", channel: 1, number: 0 };
const CC3 = { type: "cc", channel: 1, number: 3 };

/** @returns {object} an incoming message, program change 3 unless told otherwise. */
function incoming(over = {}) {
  return { device_name: "D", type: "pc", channel: 1, number: 3, ...over };
}

/**
 * Every routing case the review's parity probe ran, plus the ones it named: a
 * malformed scene id, an extra argument, an inherited effect name, a pad field
 * no control sweeps, a range upside down, a pad index past the end, a macro
 * index past the end, a numeric device name, channel 0, an empty device name, a
 * map key that is not the mapping's own id, and the two pairings the message rule
 * refuses (an effect on a program change, a value control on a note).
 */
const ROUTE_CASES = [
  {
    name: "a live mapping",
    maps: { a: liveMapping("a", { kind: "scene.launch", scene_id: "s1" }, PC3) },
    routed: true,
  },
  {
    name: "a proposal",
    maps: { a: liveMapping("a", { kind: "scene.launch", scene_id: "s1" }, PC3, { proposed: true }) },
    routed: false,
  },
  {
    name: "a missing proposed flag",
    maps: { a: liveMapping("a", { kind: "scene.launch", scene_id: "s1" }, PC3, { proposed: undefined }) },
    routed: false,
  },
  {
    name: "an action changed after accept",
    maps: { a: liveMapping("a", { kind: "scene.launch", scene_id: "s1" }, PC3, { accepted_action: { kind: "scene.launch", scene_id: "s2" } }) },
    routed: false,
  },
  {
    name: "a malformed scene id",
    maps: { a: liveMapping("a", { kind: "scene.launch", scene_id: "../x y" }, PC3) },
    routed: false,
  },
  {
    name: "an extra argument",
    maps: { a: liveMapping("a", { kind: "scene.launch", scene_id: "s1", evil: 1 }, PC3) },
    routed: false,
  },
  {
    name: "an inherited effect name",
    maps: { a: liveMapping("a", { kind: "fx.hold", name: "constructor" }, CC3) },
    message: incoming({ type: "cc" }),
    routed: false,
  },
  {
    name: "an effect on a program change",
    maps: { a: liveMapping("a", { kind: "fx.hold", name: "stutter" }, PC3) },
    routed: false,
  },
  {
    name: "a value control on a note",
    maps: { a: liveMapping("a", { kind: "mix.gain", track_id: "t" }, NOTE3) },
    message: incoming({ type: "note" }),
    routed: false,
  },
  {
    name: "a pad field no control sweeps",
    maps: { a: liveMapping("a", { kind: "pad.param", track_id: "t", param: "sample_id", min: 0, max: 5 }, CC3) },
    message: incoming({ type: "cc" }),
    routed: false,
  },
  {
    name: "a range upside down",
    maps: { a: liveMapping("a", { kind: "pad.param", track_id: "t", param: "pitch", min: 5, max: 0 }, CC3) },
    message: incoming({ type: "cc" }),
    routed: false,
  },
  {
    name: "a pad index past the end",
    maps: { a: liveMapping("a", { kind: "pad.play", track_id: "t", bank_id: "b", index: 99 }, NOTE3) },
    message: incoming({ type: "note" }),
    routed: false,
  },
  {
    name: "a macro index past the end",
    maps: { a: liveMapping("a", { kind: "macro.set", index: 99 }, CC3) },
    message: incoming({ type: "cc" }),
    routed: false,
  },
  {
    name: "a pad mapping over the keys mapping",
    maps: {
      k: liveMapping("k", { kind: "keys.play" }, NOTE0),
      p: liveMapping("p", { kind: "pad.play", track_id: "t", bank_id: "b", index: 1 }, NOTE3),
    },
    message: incoming({ type: "note" }),
    routed: true,
  },
  {
    name: "a keys row stored as a control change",
    maps: { k: liveMapping("k", { kind: "keys.play" }, { type: "cc", channel: 1, number: 0 }) },
    message: incoming({ type: "cc" }),
    routed: false,
  },
  {
    name: "a keys row on a note it does not name",
    maps: { k: liveMapping("k", { kind: "keys.play" }, NOTE0) },
    message: incoming({ type: "note", number: 70 }),
    routed: true,
  },
  {
    name: "a named mapping over the keys mapping",
    maps: {
      k: liveMapping("k", { kind: "keys.play" }, NOTE0),
      o: liveMapping("o", { kind: "transport.play" }, NOTE3),
    },
    message: incoming({ type: "note" }),
    routed: true,
  },
  {
    name: "a numeric device name",
    maps: { a: liveMapping("a", { kind: "stop_all" }, PC3, { device_name: 5 }) },
    message: incoming({ device_name: "5" }),
    routed: false,
  },
  {
    name: "numbers stored as strings",
    maps: { a: liveMapping("a", { kind: "stop_all" }, { type: "pc", channel: "1", number: "3" }) },
    routed: true,
  },
  {
    name: "a map key that is not the mapping's id",
    maps: { key1: liveMapping("other-id", { kind: "stop_all" }, PC3) },
    routed: true,
  },
  {
    name: "a null action",
    maps: { a: liveMapping("a", null, PC3, { accepted_action: null }) },
    routed: false,
  },
  {
    name: "an inherited action kind",
    maps: { a: liveMapping("a", { kind: "toString" }, PC3) },
    routed: false,
  },
  {
    name: "channel 0",
    maps: { a: liveMapping("a", { kind: "stop_all" }, { type: "pc", channel: 0, number: 3 }) },
    message: incoming({ channel: 0 }),
    routed: false,
  },
  {
    name: "an empty device name",
    maps: { a: liveMapping("a", { kind: "stop_all" }, PC3, { device_name: "" }) },
    message: incoming({ device_name: "" }),
    routed: false,
  },
  {
    name: "two live mappings on one message",
    maps: {
      a: liveMapping("a", { kind: "stop_all" }, PC3),
      b: liveMapping("b", { kind: "transport.play" }, PC3),
    },
    routed: true,
  },
  {
    name: "a mapping with no message",
    maps: { a: liveMapping("a", { kind: "stop_all" }, null) },
    routed: false,
  },
  {
    name: "a midi_maps that is an array",
    maps: [liveMapping("a", { kind: "stop_all" }, PC3)],
    routed: true,
  },
  { name: "no midi_maps at all", maps: null, message: incoming(), routed: false },
  { name: "no message at all", maps: { a: liveMapping("a", { kind: "stop_all" }, PC3) }, message: null, routed: false },
];

/**
 * The plain-JS gate against the zod table, argument for argument: every kind,
 * a good one and the ways a stored document can spoil it.
 */
const ACTION_CANDIDATES = [
  ["scene.launch", { scene_id: "s1" }],
  ["scene.launch", { scene_id: "" }],
  ["scene.launch", { scene_id: "a b" }],
  ["scene.launch", { scene_id: "x".repeat(40) }],
  ["scene.launch", { scene_id: "x".repeat(41) }],
  ["scene.launch", { scene_id: "s1", extra: 1 }],
  ["scene.launch", {}],
  ["clip.launch", { clip_id: "c1" }],
  ["clip.launch", { clip_id: 5 }],
  ["transport.play", {}],
  ["transport.play", { on: true }],
  ["transport.stop", {}],
  ["record.toggle", {}],
  ["stop_all", {}],
  ["pad.play", { track_id: "t", bank_id: "b", index: 0 }],
  ["pad.play", { track_id: "t", bank_id: "b", index: 15 }],
  ["pad.play", { track_id: "t", bank_id: "b", index: 16 }],
  ["pad.play", { track_id: "t", bank_id: "b", index: -1 }],
  ["pad.play", { track_id: "t", bank_id: "b", index: 1.5 }],
  ["pad.play", { track_id: "t", bank_id: "b", index: "1" }],
  ["pad.play", { track_id: "t", index: 1 }],
  ["pad.param", { track_id: "t", param: "pitch", min: 0, max: 5 }],
  ["pad.param", { track_id: "t", param: "pitch", min: 0, max: 0 }],
  ["pad.param", { track_id: "t", param: "pitch", min: 5, max: 0 }],
  ["pad.param", { track_id: "t", param: "sample_id", min: 0, max: 5 }],
  ["pad.param", { track_id: "t", param: "pitch", min: "0", max: 5 }],
  ["pad.param", { track_id: "t", param: "pitch", min: 0, max: Infinity }],
  ["pad.param", { track_id: "t", param: "pitch", min: 0, max: NaN }],
  ["pad.param", { track_id: "t", param: "pitch" }],
  ["track.macro", { track_id: "t", index: 7 }],
  ["track.macro", { track_id: "t", index: 8 }],
  ["track.macro", { track_id: "t", index: 0.5 }],
  ["fx.hold", { name: "stutter" }],
  ["fx.hold", { name: "reverb_throw" }],
  ["fx.hold", { name: "constructor" }],
  ["fx.hold", { name: "__proto__" }],
  ["fx.hold", { name: 1 }],
  ["looper.cycle", {}],
  ["looper.to_pad", { track_id: "t", bank_id: "b", index: 15 }],
  ["looper.to_pad", { track_id: "t", bank_id: "b", index: 99 }],
  ["mix.gain", { track_id: "t" }],
  ["mix.gain", { track_id: "" }],
  ["keys.play", {}],
  ["keys.play", { channel: 1 }],
  ["macro.set", { index: 0 }],
  ["macro.set", { index: 7 }],
  ["macro.set", { index: 8 }],
  ["macro.set", {}],
];

test("the page and the server route every case the same", async () => {
  const { MIDI_ACTION_KINDS, MIDI_ACTIONS, routeFor } = await import("../bundles/studio/server/commands/midi.js");
  const { MIDI_ROUTE_SCRIPT, validRoutedAction } = await import("../bundles/studio/panel/midi-route.js");

  // The page's copy: the very text the handler inlines, evaluated the way the
  // page's own script tag runs it.
  const page = new Function("window", `${MIDI_ROUTE_SCRIPT}\nreturn window.StudioMidiRoute;`)({});
  assert.equal(typeof page.routeFor, "function", "the inlined script defines the router");

  // The inline-script rules, on the text the page really carries.
  assert.equal(MIDI_ROUTE_SCRIPT.includes("\u0060"), false, "no backtick: the panel rule");
  assert.equal(MIDI_ROUTE_SCRIPT.includes("$" + "{"), false, "no template interpolation");
  assert.equal(MIDI_ROUTE_SCRIPT.includes('"'), false, "no double quote");
  assert.equal(MIDI_ROUTE_SCRIPT.includes("\\"), false, "no backslash either");
  assert.equal(MIDI_ROUTE_SCRIPT.includes("</script"), false, "and it cannot close its own tag");

  for (const one of ROUTE_CASES) {
    const snap = { midi_maps: one.maps };
    const message = one.message === undefined ? incoming() : one.message;
    const server = routeFor(snap, message);
    const client = page.routeFor(snap, message);
    assert.deepEqual(client, server, `${one.name}: the page answers what the server answers`);
    assert.equal(server === null, !one.routed, `${one.name}: ${one.routed ? "routes" : "routes nothing"}`);
  }

  // The case the review called out by name: the answer is the mapping's own id,
  // not the key it is filed under.
  const keyed = routeFor({ midi_maps: { key1: liveMapping("other-id", { kind: "stop_all" }, PC3) } }, incoming());
  assert.equal(keyed.id, "other-id", "the answer names the mapping's own id");

  // The plain-JS gate accepts exactly what the zod table accepts, argument for
  // argument: an action the hub would refuse is never routed, and one the hub
  // accepts is never silently dropped.
  const seen = new Set();
  for (const [kind, args] of ACTION_CANDIDATES) {
    seen.add(kind);
    const zod = MIDI_ACTIONS[kind].safeParse(args).success;
    assert.equal(
      validRoutedAction({ kind, ...args }),
      zod,
      `${kind} ${JSON.stringify(args)}: the plain-JS gate and the schema agree`,
    );
  }
  assert.deepEqual([...seen].sort(), [...MIDI_ACTION_KINDS].sort(),
    "every allow-listed kind is ridden against its own schema");

  // And the router is the thing that runs that gate: a live mapping holding an
  // action the schema refuses routes nothing.
  for (const kind of MIDI_ACTION_KINDS) {
    const action = { kind, extra: 1 };
    const answered = routeFor(
      { midi_maps: { m: liveMapping("m", action, CC3) } },
      incoming({ type: "cc" }),
    );
    assert.equal(answered, null, `${kind} with an argument its schema refuses is not routed`);
  }
});

/** One mapping written by the real command, as the operator or as the bot. */
async function writeMapping(doc, args, agent = false) {
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  runCommand(doc, "midi.map", args, { author: { kind: agent ? "agent" : "human" } });
  return args;
}

test("learning over a message a bot also proposed keeps the proposal and learns", async () => {
  const doc = await midiDoc();
  const message = { type: "pc", channel: 1, number: 3 };
  await writeMapping(doc, {
    id: "m-live",
    device_name: DEVICE,
    message,
    action: { kind: "scene.launch", scene_id: SCENE },
  });
  await writeMapping(doc, {
    id: "m-proposal",
    device_name: DEVICE,
    message,
    action: { kind: "transport.play" },
  }, true);

  const ui = await bootMidi({ doc });
  ui.click("[data-act=midi-connect]");
  await ui.settle();

  // Learn on the Chorus launch button, then the pedal the bot also proposed on.
  ui.click("[data-act=midi-learn]");
  ui.click(`[data-act=launch-scene][data-scene-id=${CHORUS}]`);
  ui.pedal(DEVICE, [0xc0, 3]);
  await ui.settle();

  const removed = commands(ui, "midi.remove");
  assert.equal(removed.length, 1, "the LIVE mapping on that message goes");
  assert.equal(removed[0].args.id, "m-live");
  const first = commands(ui, "midi.map");
  assert.equal(first.length, 1, "and one live mapping is written");
  assert.deepEqual(first[0].args.action, { kind: "scene.launch", scene_id: CHORUS });
  assert.notEqual(first[0].args.id, "m-proposal", "Learn never writes the proposal's id");

  await ui.apply("midi.remove", removed[0].args, { kind: "human" });
  await ui.apply("midi.map", first[0].args, { kind: "human" });
  let stored = await mappingsOf(ui.doc);
  assert.equal(stored["m-proposal"].proposed, true, "the bot's proposal is untouched");
  assert.deepEqual(stored["m-proposal"].action, { kind: "transport.play" });
  assert.equal(stored[first[0].args.id].proposed, false, "Learn's mapping is the operator's, so live");

  // Now the operator learns a control whose action IS the proposal's action:
  // still nothing is accepted silently — a live mapping of their own is written,
  // and the proposal is left for the MIDI page.
  ui.click("[data-act=midi-learn]");
  ui.click("[data-act=play]");
  ui.pedal(DEVICE, [0xc0, 3]);
  await ui.settle();

  const removedAgain = commands(ui, "midi.remove");
  const second = commands(ui, "midi.map");
  assert.equal(removedAgain.length, 2, "the live Chorus mapping goes too");
  assert.equal(removedAgain[1].args.id, first[0].args.id);
  assert.equal(second.length, 2);
  assert.deepEqual(second[1].args.action, { kind: "transport.play" },
    "the answer the operator picked is the one learned");
  assert.notEqual(second[1].args.id, "m-proposal", "and it is not the proposal's row");

  await ui.apply("midi.remove", removedAgain[1].args, { kind: "human" });
  await ui.apply("midi.map", second[1].args, { kind: "human" });
  stored = await mappingsOf(ui.doc);
  assert.equal(stored["m-proposal"].proposed, true, "the proposal is still a proposal");
  assert.equal(stored[second[1].args.id].proposed, false, "and the operator's own row is live");
});

test("the rest of the gesture Learn mapped is not played", async () => {
  const doc = await midiDoc();
  const ui = await bootMidi({ doc });
  ui.click("[data-act=midi-connect]");
  await ui.settle();

  // Learn a scene launch from one pedal press.
  ui.click("[data-act=midi-learn]");
  ui.click(`[data-act=launch-scene][data-scene-id=${CHORUS}]`);
  ui.pedal(DEVICE, [0xc0, 3]);
  await ui.settle();
  const maps = commands(ui, "midi.map");
  assert.equal(maps.length, 1, "the press taught one mapping");

  // The press that taught it is not also played, and neither is another one on
  // the same control until the mapping is in the snapshot.
  ui.pedal(DEVICE, [0xc0, 3]);
  await ui.settle();
  assert.deepEqual(ui.engine.launches, [], "the gesture that taught the mapping launched nothing");

  // The mapping arrives; from then on the pedal is the scene's.
  await ui.apply("midi.map", maps[0].args, { kind: "human" });
  ui.pedal(DEVICE, [0xc0, 3]);
  await ui.settle();
  assert.deepEqual(ui.engine.launches, [CHORUS], "once the mapping is in the song the pedal drives it");

  // A note-on teaches a pad, and the note-off that follows it has no note-on of
  // its own: it is swallowed too.
  ui.click("[data-act=midi-learn]");
  await ui.settle();
  ui.click(`[data-act=open-clip][data-clip-id=${CLIP}]`);
  await ui.settle();
  ui.click("[data-role=sampler] [data-act=pad][data-pad-index=0]");
  await ui.settle();
  ui.pedal(DEVICE, [0x90, 36, 100]);
  await ui.settle();
  const afterNote = commands(ui, "midi.map");
  assert.equal(afterNote.length, 2, "the note taught a pad mapping");
  assert.equal(afterNote[1].args.action.kind, "pad.play");

  ui.pedal(DEVICE, [0x80, 36, 0]);
  await ui.settle();
  assert.deepEqual(ui.engine.pads, [], "the learned note-on played nothing");
  assert.deepEqual(ui.engine.releases, [], "and its note-off reached nothing");
});

test("a mapped trigger fires on the press, not on the release", async () => {
  const doc = await midiDoc();
  await writeMapping(doc, {
    id: "note-launch",
    device_name: DEVICE,
    message: { type: "note", channel: 1, number: 60 },
    action: { kind: "scene.launch", scene_id: SCENE },
  });
  await writeMapping(doc, {
    id: "cc-clip",
    device_name: DEVICE,
    message: { type: "cc", channel: 1, number: 20 },
    action: { kind: "clip.launch", clip_id: CLIP },
  });
  const ui = await bootMidi({ doc });
  ui.click("[data-act=midi-connect]");
  await ui.settle();

  // A note launches on its note-on, and the note-off only lets go.
  ui.pedal(DEVICE, [0x90, 60, 100]);
  await ui.settle();
  assert.deepEqual(ui.engine.launches, [SCENE], "the note-on launches the scene");
  ui.pedal(DEVICE, [0x80, 60, 0]);
  await ui.settle();
  assert.deepEqual(ui.engine.launches, [SCENE], "letting the note go launches nothing");

  // A CC below 64 is the release side; 64 and above is the press.
  ui.pedal(DEVICE, [0xb0, 20, 63]);
  await ui.settle();
  assert.deepEqual(ui.engine.clips, [], "a CC below 64 is not a press");
  ui.pedal(DEVICE, [0xb0, 20, 64]);
  await ui.settle();
  assert.deepEqual(ui.engine.clips, [CLIP], "a CC at 64 launches the clip it names");
});

test("a knob's Learn waits for a control change", async () => {
  const doc = await midiDoc();
  const ui = await bootMidi({ doc });
  ui.click("[data-act=midi-connect]");
  await ui.settle();

  ui.click("[data-act=midi-learn]");
  await ui.settle();
  ui.click(`[data-act=open-clip][data-clip-id=${CLIP}]`);
  await ui.settle();
  const gain = ui.document.querySelector("[data-pad-field=gain_db]");
  assert.ok(gain, "the pad's gain is a control Learn can hold");
  ui.click("[data-pad-field=gain_db]");
  await ui.settle();

  // A pedal's press is not a knob turn: nothing is mapped, and the page names
  // what the control needs instead of mapping the wrong message.
  ui.pedal(DEVICE, [0xc0, 6]);
  await ui.settle();
  assert.equal(commands(ui, "midi.map").length, 0, "a pedal is not a knob");
  assert.match(ui.toastText(), /control change/, "the page names what the control needs");
  assert.equal(ui.document.querySelector("[data-act=midi-learn]").getAttribute("aria-pressed"), "true",
    "Learn is still waiting");

  // The control change it was waiting for maps it, as a pad.param.
  ui.pedal(DEVICE, [0xb0, 6, 64]);
  await ui.settle();
  const maps = commands(ui, "midi.map");
  assert.equal(maps.length, 1, "the knob maps the control");
  assert.equal(maps[0].args.action.kind, "pad.param");
  assert.equal(maps[0].args.action.param, "gain_db");
});

test("learn refuses a program change for an effect", async () => {
  const ui = await bootMidi();
  ui.click("[data-act=midi-connect]");
  await ui.settle();
  ui.click(`[data-act=open-clip][data-clip-id=${CLIP}]`);
  await ui.settle();
  const stutter = ui.document.querySelector("[data-act=fx-hold][data-fx-name=stutter]");
  assert.ok(stutter, "the Stutter button is on the page");

  // Learn on, then the effect: picking it applies nothing, and the next message
  // is the one it should learn from.
  ui.click("[data-act=midi-learn]");
  stutter.dispatchEvent(ui.event("pointerdown", { button: 0 }));
  await ui.settle();
  assert.deepEqual(ui.engine.fx, [], "the press that picks an effect applies nothing");

  // The pedal presses a program change. A held effect has no release for one, so
  // Learn refuses it in the router's own sentence and keeps waiting.
  ui.pedal(DEVICE, [0xc0, 3]);
  await ui.settle();
  assert.equal(commands(ui, "midi.map").length, 0, "a program change cannot hold an effect");
  assert.equal(
    ui.toastText(),
    "A held effect needs a pedal or pad that sends a note or a CC; a program change has no release.",
  );
  assert.equal(
    ui.document.querySelector("[data-act=midi-learn]").getAttribute("aria-pressed"),
    "true",
    "Learn is still waiting",
  );

  // A control change is what it needs, and it is learned as fx.hold.
  ui.pedal(DEVICE, [0xb0, 20, 100]);
  await ui.settle();
  const maps = commands(ui, "midi.map");
  assert.equal(maps.length, 1);
  assert.deepEqual(maps[0].args.action, { kind: "fx.hold", name: "stutter" });
  assert.deepEqual(maps[0].args.message, { type: "cc", channel: 1, number: 20 });
});

test("re-learning a row never removes another controller's mapping", async () => {
  const doc = await midiDoc();
  // Two controllers, both holding program change 3: one row each.
  await mapPedal(doc, { id: "pedal-a", number: 5, sceneId: SCENE });
  await mapPedal(doc, { id: "pad-b", number: 3, sceneId: CHORUS, device: "Pad kit" });

  const midi = fakeMidiAccess({ names: [DEVICE, "Pad kit"] });
  const ui = await bootMidi({ doc, midi });
  ui.click("[data-act=midi-connect]");
  await ui.settle();

  // Re-learn the pedal's own row, then press program change 3 on the PEDAL: the
  // other controller's row holds that message too, and it is not ours to remove.
  ui.click("[data-act=midi-learn-row][data-mapping-id=pedal-a]");
  await ui.settle();
  ui.pedal(DEVICE, [0xc0, 3]);
  await ui.settle();

  assert.equal(commands(ui, "midi.remove").length, 0, "no other controller's row was removed");
  const maps = commands(ui, "midi.map");
  assert.equal(maps.length, 1, "the row keeps its id and its action, with the new message");
  assert.equal(maps[0].args.id, "pedal-a");
  assert.deepEqual(maps[0].args.message, { type: "pc", channel: 1, number: 3 });

  await ui.apply("midi.map", maps[0].args, { kind: "human" });
  const stored = await mappingsOf(ui.doc);
  assert.deepEqual(stored["pedal-a"].message, { type: "pc", channel: 1, number: 3 }, "the pedal's row follows the pedal");
  assert.equal(stored["pedal-a"].device_name, DEVICE);
  assert.deepEqual(stored["pad-b"].message, { type: "pc", channel: 1, number: 3 }, "the other controller's row is untouched");
  assert.equal(stored["pad-b"].device_name, "Pad kit");
});

test("the MIDI lock is let go when the page closes before it is granted", async () => {
  const locks = gatedLocks();
  const doc = await midiDoc();
  await mapPedal(doc, { id: "m-pedal-3", number: 3, sceneId: CHORUS });

  const gone = await bootMidi({ doc, locks });
  gone.click("[data-act=midi-connect]");
  await gone.settle();
  assert.equal(locks.asked.length, 1, "the page asked for the song's routing lock");
  assert.equal(locks.heldNames.has("studio-midi-song-1"), false, "the browser has not answered yet");

  // The page goes (a Turbo visit) before the grant arrives.
  gone.teardown();
  await gone.settle();
  locks.asked[0].grant();
  await gone.settle();
  assert.equal(locks.heldNames.has("studio-midi-song-1"), false,
    "a grant that arrives after the page closed is let go at once");

  // The page that stays keeps its lock, and gives it back on its own teardown.
  const kept = gatedLocks();
  const alive = await bootMidi({ doc, locks: kept });
  alive.click("[data-act=midi-connect]");
  await alive.settle();
  kept.asked[0].grant();
  await alive.settle();
  assert.equal(kept.heldNames.has("studio-midi-song-1"), true, "a live page keeps the lock it was granted");
  alive.teardown();
  await alive.settle();
  assert.equal(kept.heldNames.has("studio-midi-song-1"), false, "and lets go of it on teardown");
});

test("a refused tab asks again for the lock and routes nothing meanwhile", async () => {
  const locks = fakeLocks();
  const doc = await midiDoc();
  await mapPedal(doc, { id: "m-pedal-3", number: 3, sceneId: CHORUS });

  const first = await bootMidi({ doc, locks });
  first.click("[data-act=midi-connect]");
  await first.settle();

  const second = await bootMidi({ doc, locks });
  second.click("[data-act=midi-connect]");
  await second.settle();
  assert.equal(second.lockState(), "Another tab is listening to MIDI for this song.");

  // The tab that had the lock goes; the refused tab asks again on its beat.
  first.teardown();
  await first.settle();
  assert.equal(locks.held.has("studio-midi-song-1"), false, "the first tab gave the lock back");
  second.runTimers();
  await second.settle();
  assert.equal(locks.held.has("studio-midi-song-1"), true, "the refused tab has it now");
  assert.equal(second.lockState(), "", "and stops saying another tab is listening");

  second.pedal(DEVICE, [0xc0, 3]);
  await second.settle();
  assert.deepEqual(second.engine.launches, [CHORUS], "so the pedal plays again");
});

test("a knob's last value is sent when the page goes", async () => {
  const doc = await midiDoc();
  await writeMapping(doc, {
    id: "m-gain",
    device_name: DEVICE,
    message: { type: "cc", channel: 1, number: 7 },
    action: { kind: "mix.gain", track_id: TRACK },
  });
  const ui = await bootMidi({ doc });
  ui.click("[data-act=midi-connect]");
  await ui.settle();

  ui.pedal(DEVICE, [0xb0, 7, 100]);
  await ui.settle();
  assert.equal(commands(ui, "track.set_mix").length, 0, "the 300 ms window is still open");

  ui.teardown();
  const sent = commands(ui, "track.set_mix");
  assert.equal(sent.length, 1, "the last value is sent, not dropped");
  assert.equal(sent[0].args.track_id, TRACK);
  assert.equal(sent[0].args.gain_db, -3.3, "the value the knob was sitting at");
});

test("a routed action is held to what the page can really do", async () => {
  const doc = await midiDoc();
  const ui = await bootMidi({ doc });
  ui.click("[data-act=midi-connect]");
  await ui.settle();

  // The routing rule is the gate, but the page is the last word on what it will
  // touch: an action that reaches it from elsewhere still cannot write a field
  // Studio never offered, spell an effect the engine does not know, or launch a
  // scene the song no longer has.
  const real = ui.window.StudioMidiRoute;
  const handMade = (action) => {
    ui.window.StudioMidiRoute = { routeFor: () => ({ id: "hand-made", action }) };
  };

  handMade({ kind: "pad.param", track_id: TRACK, param: "sample_id", min: 0, max: 16 });
  ui.pedal(DEVICE, [0xb0, 20, 100]);
  await ui.settle();
  ui.runTimers();
  await ui.settle();
  assert.equal(commands(ui, "pad.set").length, 0, "a field outside the lock list is not written");

  handMade({ kind: "fx.hold", name: "nonsense" });
  ui.pedal(DEVICE, [0xb0, 21, 100]);
  await ui.settle();
  assert.deepEqual(ui.engine.fx, [], "only the five known effects reach the engine");

  handMade({ kind: "fx.hold", name: "stutter" });
  ui.pedal(DEVICE, [0xb0, 22, 100]);
  await ui.settle();
  assert.deepEqual(ui.engine.fx, [{ name: "stutter", amount: 1, on: true }], "a known one still holds");

  await ui.apply("scene.remove", { scene_id: CHORUS }, { kind: "human" });
  handMade({ kind: "scene.launch", scene_id: CHORUS });
  ui.pedal(DEVICE, [0xc0, 7]);
  await ui.settle();
  assert.deepEqual(ui.engine.launches, [], "there is nothing left to launch");
  assert.equal(ui.engine.plays, 0, "and no transport starts");
  assert.equal(ui.toastText(), "That pedal’s scene is gone.");

  ui.document.querySelector("[data-role=toast]").textContent = "";
  ui.pedal(DEVICE, [0xc0, 7]);
  await ui.settle();
  assert.equal(ui.toastText(), "", "and it is said once");

  ui.window.StudioMidiRoute = real;
});

// ---- the MIDI page: proposals, accept, and what a row sends -----------------

/** The scenes the FCB1010 profile walks, so its third pedal launches the Chorus. */
const FCB_SCENES = [["intro", "Intro"], [SCENE, "Verse"], [CHORUS, "Chorus"]];

/** The pedal mappings a three-scene song's FCB1010 profile lays out. */
const FCB_PEDALS = ["fcb1010-pedal-1", "fcb1010-pedal-2", "fcb1010-pedal-3"];

test("agent proposes an FCB1010 setup and the operator accepts it", async () => {
  const doc = await midiDoc({ scenes: FCB_SCENES });
  const ui = await bootMidi({ doc });
  ui.click("[data-act=midi-connect]");
  await ui.settle();
  assert.equal(ui.engine.launches.length, 0, "nothing is mapped yet");

  // The bot runs the profile through its own tool's command: every row arrives
  // as a proposal, and the page says what the operator can do with them.
  await ui.apply("midi.propose_profile", { device: "fcb1010", device_name: DEVICE }, { kind: "agent" });
  const notice = ui.document.querySelector("[data-role=midi] .st-midi-proposals");
  assert.ok(notice, "the page carries a notice about the bot's proposals");
  assert.match(
    String(notice.textContent),
    /The bot proposed 4 mappings\. Accept the ones you want, or press Learn and then the pedal or knob you want\./,
    "three pedals and one expression pedal, said in the design's own words",
  );

  for (const id of FCB_PEDALS) {
    const row = ui.mappingRow(id);
    assert.ok(row, `${id} is listed`);
    assert.equal(row.getAttribute("data-proposed"), "true", `${id} is only a proposal`);
    assert.equal(String(row.querySelector(".st-midi-by").textContent), "proposed (by the bot)");
  }
  assert.equal(
    String(ui.mappingRow("fcb1010-pedal-3").querySelector(".st-midi-control").textContent),
    `${DEVICE} pedal 3`,
    "the Control column names the pedal the hardware's own layout puts program change 2 on",
  );
  assert.match(String(ui.mappingRow("fcb1010-pedal-3").textContent), /program change 2/);
  assert.match(String(ui.mappingRow("fcb1010-pedal-3").querySelector(".st-midi-does").textContent), /Chorus/);

  // A proposal routes nothing: the pedal is pressed and plays nothing.
  ui.pedal(DEVICE, [0xc0, 2]);
  await ui.settle();
  assert.deepEqual(ui.engine.launches, [], "a proposal plays nothing");

  // Accept all: one midi.accept per proposal drawn, each carrying its own row's
  // expect.
  ui.click("[data-act=midi-accept-all]");
  const accepts = commands(ui, "midi.accept");
  assert.equal(accepts.length, 4, "one accept per proposal, and no row left out");
  const pedal3 = accepts.find((message) => message.args.id === "fcb1010-pedal-3");
  assert.ok(pedal3, "the third pedal's own accept is there");
  assert.deepEqual(pedal3.args.expect, {
    device_name: DEVICE,
    message: { type: "pc", channel: 1, number: 2 },
    action: { kind: "scene.launch", scene_id: CHORUS },
  }, "the expect is the row as it was drawn");

  // Each yes is the operator's own step, run by the real command.
  for (const accept of accepts) await ui.apply("midi.accept", accept.args, { kind: "human" });
  const maps = await mappingsOf(ui.doc);
  assert.equal(
    Object.values(maps).filter((mapping) => mapping.proposed === true).length,
    0,
    "every proposal the operator accepted is live",
  );
  assert.ok(
    Object.values(maps).every((mapping) => mapping.set_by === "agent"),
    "they are still the bot's rows: the bot proposed and the operator said yes",
  );
  for (const id of FCB_PEDALS) {
    const row = ui.mappingRow(id);
    assert.equal(row.getAttribute("data-proposed"), "false", `${id} is live now`);
    assert.equal(String(row.querySelector(".st-midi-by").textContent), "the bot (accepted)");
  }

  // And the pedalboard plays the song: pedal 3 is the Chorus.
  ui.pedal(DEVICE, [0xc0, 2]);
  await ui.settle();
  assert.deepEqual(ui.engine.launches, [CHORUS], "the accepted pedal 3 launches the Chorus");
});

test("accepted pedal 3 launches the chorus", async () => {
  const doc = await midiDoc({ scenes: FCB_SCENES });
  const ui = await bootMidi({ doc });
  ui.click("[data-act=midi-connect]");
  await ui.settle();

  await ui.apply("midi.propose_profile", { device: "fcb1010", device_name: DEVICE }, { kind: "agent" });
  assert.ok(ui.mappingRow("fcb1010-pedal-3"), "the profile proposed the pedals");

  // One row, accepted on its own: the page builds the expect from the row.
  ui.click("[data-act=midi-accept][data-mapping-id=fcb1010-pedal-3]");
  const accepts = commands(ui, "midi.accept");
  assert.equal(accepts.length, 1, "Accept on one row is one midi.accept");
  assert.equal(accepts[0].args.id, "fcb1010-pedal-3");
  assert.deepEqual(accepts[0].args.expect.action, { kind: "scene.launch", scene_id: CHORUS });
  await ui.apply("midi.accept", accepts[0].args, { kind: "human" });
  assert.equal(ui.mappingRow("fcb1010-pedal-3").getAttribute("data-proposed"), "false");

  // The other pedals are still proposals, so they still play nothing.
  ui.pedal(DEVICE, [0xc0, 1]);
  await ui.settle();
  assert.deepEqual(ui.engine.launches, [], "pedal 2 is still a proposal");

  const before = historyFrames(ui).length;
  ui.pedal(DEVICE, [0xc0, 2]);
  await ui.settle();
  assert.deepEqual(ui.engine.launches, [CHORUS], "program change 2 is pedal 3, and it launches the Chorus");
  assert.equal(historyFrames(ui).length, before, "a routed pedal is never a history step");
});

test("accept sends what the row showed", async () => {
  const doc = await midiDoc();
  await mapPedal(doc, { id: "m-proposed", number: 5, sceneId: CHORUS, agent: true });
  const ui = await bootMidi({ doc });

  // The row as the operator sees it: program change 5 launches the Chorus.
  assert.match(
    String(ui.mappingRow("m-proposed").querySelector(".st-midi-does").textContent),
    /Chorus/,
    "the drawn row says Chorus",
  );

  // The proposal moves after the page drew it: the bot takes it back and proposes
  // the same message for the Verse instead. No state frame is sent, so the page
  // still holds the row it drew — and that is what its Accept must send.
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  const bot = { author: { kind: "agent" } };
  runCommand(doc, "midi.remove", { id: "m-proposed" }, bot);
  runCommand(doc, "midi.map", {
    id: "m-proposed",
    device_name: DEVICE,
    message: { type: "pc", channel: 1, number: 5 },
    action: { kind: "scene.launch", scene_id: SCENE },
  }, bot);

  ui.click("[data-act=midi-accept][data-mapping-id=m-proposed]");
  const accepts = commands(ui, "midi.accept");
  assert.equal(accepts.length, 1, "one midi.accept");
  assert.deepEqual(
    accepts[0].args.expect.action,
    { kind: "scene.launch", scene_id: CHORUS },
    "the expect is what the row showed, not what the snapshot holds now",
  );

  // The hub refuses it, in its own words, and nothing goes live.
  assert.throws(
    () => runCommand(doc, "midi.accept", accepts[0].args, { author: { kind: "human" } }),
    /not the proposal you were shown/,
  );
  const stored = (await mappingsOf(doc))["m-proposed"];
  assert.equal(stored.proposed, true, "the mapping is still a proposal");
  assert.deepEqual(stored.action, { kind: "scene.launch", scene_id: SCENE }, "and still the bot's newer one");
  assert.ok(ui.mappingRow("m-proposed").getAttribute("data-proposed") !== "false", "nothing went live on the page either");
});

// ---- LIVE-HARNESS-BEGIN: a real Chrome against a real hub -------------------

const PROJECT = 62;
const PREFIX = "projects/62/";
const LIVE_BUNDLE_DIR = new URL("../bundles/studio", import.meta.url).pathname.replace(/\/$/, "");
const LIVE_HUMAN = { kind: "human", id: "local", label: "You" };
const LIVE_AGENT = { kind: "agent", id: "mcp", label: "Agent (MCP)" };

let chrome = null;
let server = null;
let upgrades = null;
let db = null;
let hub = null;
let base = "";
let dir = "";
const objects = new Map();

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

  dir = mkdtempSync(join(tmpdir(), "studio-panel-midi-"));
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
  hub = createHub({ db, acl: liveAcl(), onBroadcast: (id, payload) => webRef.web?.broadcast(id, payload) });

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
      throw new Error(`there is no object at ${key}`);
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

/**
 * What runs in the page before any script of its own: a fake Web MIDI with one
 * input, "FCB1010", that page JS can fire messages from (`__fakeMidi.fire`), and
 * a wrap of the engine the client builds that records the calls the tests read
 * (`__engineLog`) and the launch reports the engine sends back.
 */
const PAGE_STUBS = `(function () {
  var log = [];
  window.__engineLog = log;
  window.__pageErrors = [];
  window.addEventListener('error', function (e) { window.__pageErrors.push(String(e.message)); });
  var port = { id: 'fcb-1', name: 'FCB1010', manufacturer: 'Behringer', type: 'input', state: 'connected', connection: 'open', onmidimessage: null };
  var access = { inputs: new Map([[port.id, port]]), outputs: new Map(), onstatechange: null, sysexEnabled: false };
  navigator.requestMIDIAccess = function () { return Promise.resolve(access); };
  window.__fakeMidi = {
    fire: function (bytes) { if (port.onmidimessage) port.onmidimessage({ data: new Uint8Array(bytes), target: port }); }
  };
  var real;
  function wrap(lib) {
    if (!lib || typeof lib.create !== 'function' || lib.__wrapped) return lib;
    var create = lib.create;
    lib.create = function () {
      return create.apply(this, arguments).then(function (engine) {
        ['fxHold', 'fxRelease', 'launchScene', 'launchClip'].forEach(function (name) {
          var original = engine[name];
          engine[name] = function () {
            log.push({ call: name, args: Array.prototype.slice.call(arguments) });
            return original.apply(this, arguments);
          };
        });
        var onLaunch = engine.onLaunch;
        engine.onLaunch = function (callback) {
          return onLaunch.call(this, function (launch) {
            log.push({ call: 'launchReport', args: [launch] });
            return callback(launch);
          });
        };
        return engine;
      });
    };
    lib.__wrapped = true;
    return lib;
  }
  Object.defineProperty(window, 'StudioEngine', {
    configurable: true,
    get: function () { return real; },
    set: function (value) { real = wrap(value); }
  });
})();`;

/** Open one page in the private browser with the dashboard's session cookies. */
async function openPage(url, { viewport = null } = {}) {
  const tab = await (await fetch(chrome.cdp + "/json/new?about:blank", { method: "PUT" })).json();
  const socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const consoleErrors = [];
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.method === "Runtime.exceptionThrown") {
      const text = JSON.stringify(
        message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text,
      ).slice(0, 500);
      consoleErrors.push(text);
      console.error("PAGE exception:", text);
    }
    if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
      const text = message.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" ").slice(0, 500);
      consoleErrors.push(text);
      console.error("PAGE console.error:", text);
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
  if (viewport) {
    await send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: viewport.mobile === true,
    });
  }
  await send("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_STUBS });
  for (const [name, value] of [["crow_session", "good"], ["crow_csrf", "csrf-ok"]]) {
    await send("Network.setCookie", { name, value, url: `${base}/` });
  }
  await send("Page.navigate", { url });

  return {
    evaluate,
    send,
    consoleErrors,
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

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    await pause(25);
  }
  return last;
}

/** Poll the song's document until `check` accepts its snapshot. */
async function waitSnap(id, check, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = (await hub.openSong(id)).snapshot;
    try {
      if (check(last)) return last;
    } catch {
      // Mid-update; look again.
    }
    await pause(50);
  }
  return last;
}

/** The centre of the first node `selector` matches, in page pixels. */
async function centreOf(page, selector) {
  const box = await page.evaluate(`(function () {
    var node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return null;
    node.scrollIntoView({ block: 'center', inline: 'center' });
    var r = node.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, top: r.top, width: r.width, height: r.height };
  })()`);
  assert.ok(box, `nothing matches ${selector}`);
  return box;
}

const mouse = (page, type, x, y, extra = {}) =>
  page.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, ...extra });

/** A real press-and-release on the node, held for `holdMs`. */
async function mousePress(page, selector, holdMs = 0) {
  const { x, y } = await centreOf(page, selector);
  await mouse(page, "mouseMoved", x, y, { button: "none", clickCount: 0 });
  await mouse(page, "mousePressed", x, y, { buttons: 1 });
  if (holdMs) await pause(holdMs);
  await mouse(page, "mouseReleased", x, y, { buttons: 0 });
}

/** A song with the FCB1010 test's scenes and one pattern clip, as the operator. */
async function liveSong(title, scenes = FCB_SCENES) {
  const created = await hub.createSong({ project_id: PROJECT, title, author: LIVE_HUMAN });
  assert.equal(created.ok, true, `createSong was refused: ${created.error}`);
  const id = created.song_id;
  const run = async (command, args, author = LIVE_HUMAN) => {
    const result = await hub.runCommand({ song_id: id, cmd_id: null, command, args, author });
    assert.equal(result.ok, true, `${command} was refused: ${result.error}`);
    return result;
  };
  // createSong opens a new song on a "Scene 1" of its own (a fresh id), which
  // would sit ahead of the fixture's scenes and shift the FCB1010 profile onto
  // it — the fixture must hold exactly `scenes`, so the default one goes.
  const opening = (await hub.openSong(id)).snapshot.scenes.map((scene) => scene.id);
  for (const sceneId of opening) await run("scene.remove", { scene_id: sceneId });
  await run("track.add", { id: TRACK, name: "Beat box", kind: "sampler" });
  for (const [sceneId, name] of scenes) await run("scene.add", { id: sceneId, name });
  await run("clip.add_pattern", { clip_id: CLIP, track_id: TRACK, scene_id: SCENE, name: "Beat", length_steps: 16 });
  return { id, run };
}

const engineLog = (page) => page.evaluate("JSON.parse(JSON.stringify(window.__engineLog))");

// ---- LIVE-HARNESS-END -------------------------------------------------------

test("in Chrome, the operator accepts a bot's FCB1010 proposal and pedal 2 launches the verse", async (t) => {
  if (!chrome) return t.skip("no headless Chrome available");
  const { id, run } = await liveSong("Pedal song");

  // The bot proposes the pedalboard's setup through its own command.
  await run("midi.propose_profile", { device: "fcb1010", device_name: DEVICE }, LIVE_AGENT);
  const proposed = await waitSnap(id, (snap) => Object.keys(snap.midi_maps || {}).length === 4);
  assert.equal(Object.values(proposed.midi_maps).filter((row) => row.proposed === true).length, 4, "four proposals");

  const page = await openPage(`${base}/dashboard/studio?song=${encodeURIComponent(id)}`);
  t.after(() => page.close());
  assert.ok(await waitFor(page, "!!document.querySelector('[data-act=midi-connect]')", 20000), "the page offers Connect controllers");

  await mousePress(page, "[data-act=midi-connect]");
  assert.ok(
    await waitFor(page, "document.querySelector('[data-act=midi-connect]').getAttribute('aria-pressed') === 'true'", 10000),
    "Connect controllers took the fake port",
  );
  assert.ok(
    await waitFor(page, "!!document.querySelector('[data-role=midi] .st-midi-proposals [data-act=midi-accept-all]')", 10000),
    "the page shows the bot's proposals and Accept all",
  );

  // A proposal is not live: the pedal does nothing yet.
  await page.evaluate("window.__fakeMidi.fire([0xc0, 1])");
  await pause(300);
  assert.equal((await engineLog(page)).filter((entry) => entry.call === "launchScene").length, 0, "a proposal launches nothing");

  const historyBefore = (await hub.history(id, { limit: 500 })).length;
  await mousePress(page, "[data-act=midi-accept-all]");
  const live = await waitSnap(id, (snap) => {
    const rows = Object.values(snap.midi_maps || {});
    return rows.length === 4 && rows.every((row) => row.proposed === false);
  });
  assert.ok(Object.values(live.midi_maps).every((row) => row.proposed === false), "the hub shows every row proposed:false");
  assert.ok(
    await waitFor(page, "document.querySelectorAll('[data-role=midi] tr[data-proposed=\"false\"]').length === 4", 10000),
    "and so does the page",
  );
  const historyAccepted = (await hub.history(id, { limit: 500 })).length;

  // Program change 1 on channel 1 is pedal 2, which launches the second scene.
  await page.evaluate("window.__fakeMidi.fire([0xc0, 1])");
  const launched = await waitFor(
    page,
    "window.__engineLog.some(function (e) { return e.call === 'launchScene' && e.args[0] === 'verse'; })",
    10000,
  );
  assert.ok(launched, "the page asked the engine to launch the Verse");
  const calls = (await engineLog(page)).filter((entry) => entry.call === "launchScene");
  assert.deepEqual(calls.map((entry) => entry.args[0]), ["verse"], "and only the Verse");
  assert.ok(
    await waitFor(page, "window.__engineLog.some(function (e) { return e.call === 'launchReport' && e.args[0] && e.args[0].scene_id === 'verse'; })", 10000),
    "the engine reported the Verse launch taking effect",
  );

  await pause(300);
  assert.equal((await hub.history(id, { limit: 500 })).length, historyAccepted, "the pedal added no history entry");
  assert.ok(historyAccepted >= historyBefore, "(the accepts themselves are the operator's steps)");
  assert.deepEqual(page.consoleErrors, [], "no page errors");
});

test("in Chrome, an effect button held with the mouse releases when the pointer leaves it", async (t) => {
  if (!chrome) return t.skip("no headless Chrome available");
  const { id } = await liveSong("Effects song");
  const page = await openPage(`${base}/dashboard/studio?song=${encodeURIComponent(id)}`);
  t.after(() => page.close());
  assert.ok(await waitFor(page, `!!document.querySelector('[data-act=open-clip][data-clip-id=${CLIP}]')`, 20000), "the clip is on the grid");
  await page.evaluate(`document.querySelector('[data-act=open-clip][data-clip-id=${CLIP}]').click()`);
  const STUTTER = "[data-role=sampler] [data-fx-name=stutter]";
  assert.ok(await waitFor(page, `!!document.querySelector('${STUTTER}')`, 10000), "the pad view shows the effects row");

  const fxCalls = async () => (await engineLog(page)).filter((entry) => entry.call === "fxHold" || entry.call === "fxRelease");

  // Press, then slide off the button with the mouse still down.
  const box = await centreOf(page, STUTTER);
  await mouse(page, "mouseMoved", box.x, box.y, { button: "none", clickCount: 0 });
  await mouse(page, "mousePressed", box.x, box.y, { buttons: 1 });
  assert.ok(
    await waitFor(page, "window.__engineLog.some(function (e) { return e.call === 'fxHold'; })", 10000),
    "the press holds the effect",
  );
  const outsideY = box.top - 60 > 0 ? box.top - 60 : box.top + box.height + 60;
  for (let step = 1; step <= 4; step += 1) {
    await mouse(page, "mouseMoved", box.x, box.y + ((outsideY - box.y) * step) / 4, { buttons: 1, clickCount: 0 });
    await pause(20);
  }
  assert.ok(
    await waitFor(page, "window.__engineLog.some(function (e) { return e.call === 'fxRelease'; })", 10000),
    "leaving the button releases the effect, mouse still down",
  );
  await mouse(page, "mouseReleased", box.x, outsideY, { buttons: 0 });
  await pause(200);
  let calls = await fxCalls();
  assert.equal(calls[0].call, "fxHold");
  assert.equal(calls[0].args[0], "stutter");
  assert.equal(typeof calls[0].args[1], "number", "fxHold carries an amount");
  assert.deepEqual(calls.slice(1).map((entry) => [entry.call, entry.args[0]]), [["fxRelease", "stutter"]]);
  assert.equal(
    await page.evaluate(`document.querySelector('${STUTTER}').getAttribute('aria-pressed')`),
    "false",
    "the button looks let go",
  );

  // A plain press and release is one more pair.
  await mousePress(page, STUTTER, 150);
  assert.ok(
    await waitFor(page, "window.__engineLog.filter(function (e) { return e.call === 'fxRelease'; }).length === 2", 10000),
    "a normal release lets the effect go",
  );
  calls = await fxCalls();
  assert.deepEqual(
    calls.map((entry) => [entry.call, entry.args[0]]),
    [["fxHold", "stutter"], ["fxRelease", "stutter"], ["fxHold", "stutter"], ["fxRelease", "stutter"]],
    "two hold/release pairs in all",
  );
  assert.deepEqual(page.consoleErrors, [], "no page errors");
});
