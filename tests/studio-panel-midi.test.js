/**
 * Studio panel — MIDI devices, Learn and the router.
 *
 * The emitted scripts (the controllers module `panel/midi.js` and the client
 * `panel/client.js`, in that order, exactly as the handler emits them) run
 * against a linkedom document built from the page the handler renders, a real
 * Yjs song whose `midi_maps` a real `midi.map` command wrote, a fake
 * `navigator.requestMIDIAccess` with fake ports, a fake Web Locks API shared by
 * the "tabs" of a test, and a fake engine that records what it was asked to do.
 *
 * What they prove: Web MIDI is never asked for without a click (and is asked
 * for again on a later load only while the permission is still granted), Learn
 * turns the next program change into one `midi.map` for the control the
 * operator picked, an unplugged controller that comes back by name keeps its
 * mapping, the table says who set each row, a routed pedal runs its action
 * locally and writes no history step, a proposed mapping routes nothing, and a
 * second tab holds no routing lock and so routes nothing at all.
 *
 * No browser is needed: nothing here touches audio or Web MIDI for real.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
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
 * The song these tests drive: a sampler track (so a pad can be mapped), two
 * scenes (so a pedal has something to launch) and a 16-step pattern clip (so
 * the pad-and-steps view has one).
 * @returns {Promise<import("yjs").Doc>}
 */
async function midiDoc() {
  const { newSongDoc } = await import("../bundles/studio/server/doc.js");
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  await import("../bundles/studio/server/commands/core.js");
  await import("../bundles/studio/server/commands/sampler.js");
  await import("../bundles/studio/server/commands/midi.js");

  const doc = newSongDoc({ title: "Pedal song", bpm: 120 });
  runCommand(doc, "track.add", { id: TRACK, name: "Beat box", kind: "sampler" });
  runCommand(doc, "scene.add", { id: SCENE, name: "Verse" });
  runCommand(doc, "scene.add", { id: CHORUS, name: "Chorus" });
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
  // The scripts travel in the handler's order: the controllers module first, so
  // window.StudioMidi is there when the client boots.
  assert.ok(
    res.html.indexOf("window.StudioMidi") < res.html.indexOf("var COMMANDS = ["),
    "the MIDI script is emitted before the client",
  );
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
  // One scope, two scripts, in the order the page emits them.
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
    `${MIDI_SCRIPT}\n${clientText}`,
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
  assert.equal(String(theirs.querySelector(".st-midi-by").textContent), "the bot (proposed)",
    "the bot's row says it is a proposal");
  assert.match(String(mine.textContent), /program change 2/, "the row names the message");
  assert.match(String(mine.querySelector(".st-midi-does").textContent), /Launch scene Verse/,
    "and what the message does");
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