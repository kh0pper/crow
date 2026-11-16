/**
 * Studio panel — the scene grid.
 *
 * Tracks are columns and scenes are rows, and what a cell does depends on the
 * mode the shell shows. Compose (and Record) open a clip in the editor;
 * Perform launches the scene from its header and the clip from a filled cell,
 * and an empty cell there is inert. A tap on a track's name selects the track
 * and opens its editor, and a pattern clip's header can copy it into a scene
 * its own track does not fill.
 *
 * The page is built from what the handler renders, the shell's own three scripts
 * are evaluated first (so the mode switch the client reads is the shell's), and
 * the client (`CLIENT_SCRIPT`) runs against a real Yjs song.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import studioPanel from "../bundles/studio/panel/studio.js";
import { CLIENT_SCRIPT } from "../bundles/studio/panel/client.js";
import { SHELL_LAYOUT_SCRIPT } from "../bundles/studio/panel/shell-layout.js";
import { SHELL_SCRIPT } from "../bundles/studio/panel/shell.js";
import { TRANSPORT_SCRIPT } from "../bundles/studio/panel/transport-bar.js";
import { encodeDocState, newSongDoc } from "../bundles/studio/server/doc.js";

/** The song the page is opened on. */
const SONG = "song-grid";

/** Its four tracks: two note tracks, a kit, and one with nothing on it. */
const BASS = "bass";
const LEAD = "lead";
const KIT = "kit";
const SPARE = "spare";

/** Its three scenes. */
const VERSE = "verse";
const CHORUS = "chorus";
const BRIDGE = "bridge";

/** The clips the fixture song holds. */
const BASS_CLIP = "c-bass";
const LEAD_CLIP = "c-lead";
const BASS_BRIDGE = "c-bass-bridge";
const KIT_VERSE = "c-kit-verse";
const KIT_CHORUS = "c-kit-chorus";

// ---- the fixture song -----------------------------------------------------

/**
 * A song of three scenes: the bass plays in the first and the last, the lead
 * only in the second (and is muted), the kit holds a pattern clip in the first
 * two, and one track holds nothing at all.
 * @returns {Promise<import("yjs").Doc>}
 */
async function songDoc() {
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  await import("../bundles/studio/server/commands/core.js");
  await import("../bundles/studio/server/commands/sampler.js");

  const doc = newSongDoc({ title: "Grid song", bpm: 120 });
  runCommand(doc, "track.add", { id: BASS, name: "Bass" });
  runCommand(doc, "track.add", { id: LEAD, name: "Lead", mute: true });
  runCommand(doc, "track.add", { id: KIT, name: "Kit", kind: "sampler" });
  runCommand(doc, "track.add", { id: SPARE, name: "Spare" });
  runCommand(doc, "scene.add", { id: VERSE, name: "Verse" });
  runCommand(doc, "scene.add", { id: CHORUS, name: "Chorus" });
  runCommand(doc, "scene.add", { id: BRIDGE, name: "Bridge" });
  runCommand(doc, "clip.write", {
    clip_id: BASS_CLIP,
    track_id: BASS,
    scene_id: VERSE,
    name: "Bass line",
    length_bars: 1,
    notes: [{ t: 0, d: 1, p: 60, v: 100 }],
  });
  runCommand(doc, "clip.write", {
    clip_id: LEAD_CLIP,
    track_id: LEAD,
    scene_id: CHORUS,
    name: "Lead line",
    length_bars: 1,
    notes: [{ t: 0, d: 1, p: 64, v: 100 }],
  });
  runCommand(doc, "clip.write", {
    clip_id: BASS_BRIDGE,
    track_id: BASS,
    scene_id: BRIDGE,
    name: "Bridge line",
    length_bars: 1,
    notes: [],
  });
  runCommand(doc, "clip.add_pattern", {
    clip_id: KIT_VERSE,
    track_id: KIT,
    scene_id: VERSE,
    name: "Kit A",
    length_steps: 16,
  });
  runCommand(doc, "clip.add_pattern", {
    clip_id: KIT_CHORUS,
    track_id: KIT,
    scene_id: CHORUS,
    name: "Kit B",
    length_steps: 16,
  });
  return doc;
}

// ---- the page's surroundings ---------------------------------------------

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

/** An in-memory localStorage. */
function memoryStorage() {
  const values = new Map();
  return {
    values,
    getItem(key) {
      return values.has(String(key)) ? String(values.get(String(key))) : null;
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

/** A context stand-in: the nodes the page builds for its clock. */
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

/** The engine stand-in: what the page asked it to play, and its listeners. */
function fakeEngine() {
  const engine = {
    plays: 0,
    stops: 0,
    launched: [],
    launchHandlers: [],
    positionHandlers: [],
    node: { connect() {} },
    setSong() {},
    setMode() {},
    setMetronome() {},
    seek() {},
    play() {
      engine.plays += 1;
    },
    pause() {},
    stop() {
      engine.stops += 1;
    },
    stopAll() {},
    launchScene(id) {
      engine.launched.push(String(id));
    },
    launchClip(id) {
      engine.launched.push(String(id));
    },
    onPosition(handler) {
      engine.positionHandlers.push(handler);
      return () => {};
    },
    onLaunch(handler) {
      engine.launchHandlers.push(handler);
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
  };
  return engine;
}

/** The navigator stand-in: no inputs, and no Web Locks. */
function fakeNavigator() {
  return {
    locks: null,
    mediaDevices: {
      async enumerateDevices() {
        return [];
      },
      async getUserMedia() {
        throw new Error("this page records nothing");
      },
    },
  };
}

/** A controllable EventSource: linkedom has none. */
function makeEventSource() {
  const instances = [];
  class FakeEventSource {
    constructor(url) {
      this.url = String(url);
      this.handlers = {};
      instances.push(this);
    }

    addEventListener(name, handler) {
      (this.handlers[name] ||= []).push(handler);
    }

    close() {}

    emit(name, frame) {
      for (const handler of this.handlers[name] || []) handler({ data: JSON.stringify(frame) });
    }
  }
  return { FakeEventSource, instances };
}

/** An HTTP answer with the two properties the page reads. */
function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async arrayBuffer() {
      return new ArrayBuffer(0);
    },
  };
}

/** The width media queries the shell asks about. */
function matchesFor(width, media) {
  const text = String(media);
  const min = /min-width:\s*(\d+)px/.exec(text);
  if (min) return width >= Number(min[1]);
  const max = /max-width:\s*(\d+)px/.exec(text);
  if (max) return width <= Number(max[1]);
  return false;
}

// ---- booting the whole page ----------------------------------------------

/**
 * Render the song page, evaluate its three shell scripts in page order, and run
 * the client against the same window.
 * @param {object} [options]
 * @returns {Promise<object>}
 */
async function bootPage(options = {}) {
  const { parseHTML } = await import("linkedom");

  const doc = options.doc || (await songDoc());
  const res = {
    html: "",
    send(body) {
      this.html = String(body);
    },
  };
  await studioPanel.handler({ query: { song: SONG }, headers: {} }, res, {
    db: panelDb(),
    layout: minimalLayout,
  });
  assert.ok(res.html.includes(`data-studio-song="${SONG}"`), "the handler rendered the song page");

  const { document, window: domWindow } = parseHTML(res.html);
  const storage = options.storage || memoryStorage();
  const width = options.width === undefined ? 1280 : options.width;
  const engine = options.engine || fakeEngine();
  const sent = [];

  const fetchStub = async (url) => {
    const target = String(url);
    if (target.includes("/layout-template")) return response(200, { template: null });
    if (target.includes("/module-types")) return response(200, { generators: [], modules: {} });
    if (target.includes("/project-bot/studio-tools")) return response(200, { ok: true });
    if (target.includes("/project-bot")) return response(404, { error: "not_found" });
    if (target.includes("/api/studio/songs")) {
      return response(200, [{ id: SONG, project_id: 7, title: "Grid song" }]);
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

  const { FakeEventSource, instances } = makeEventSource();
  const sessionValues = new Map();
  const windowStub = {
    crypto: globalThis.crypto,
    innerWidth: width,
    localStorage: storage,
    sessionStorage: {
      getItem: (key) => (sessionValues.has(String(key)) ? sessionValues.get(String(key)) : null),
      setItem: (key, value) => sessionValues.set(String(key), String(value)),
      removeItem: (key) => sessionValues.delete(String(key)),
    },
    matchMedia: (media) => ({
      media: String(media),
      matches: matchesFor(width, media),
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    }),
    location: { protocol: "http:", host: "127.0.0.1:1", reload() {} },
    atob: globalThis.atob,
    confirm: () => true,
    prompt: () => null,
    EventSource: FakeEventSource,
    AudioContext: function AudioContextStub() {
      return fakeContext();
    },
    StudioTakeStore: fakeTakeStore(),
    StudioEngine: {
      create() {
        return Promise.resolve(engine);
      },
    },
    addEventListener() {},
    removeEventListener() {},
  };

  // The page's own three scripts, in the order the page carries them.
  const shellScripts = new Function(
    "window",
    "document",
    `${SHELL_LAYOUT_SCRIPT}\n${SHELL_SCRIPT}\n${TRANSPORT_SCRIPT}`,
  );
  shellScripts(windowStub, document);
  assert.ok(windowStub.StudioShell, "the shell script is evaluated");
  assert.ok(windowStub.StudioTransport, "the transport bar script is evaluated");
  assert.ok(windowStub.StudioShellLayout, "the layout model script is evaluated");

  const yjsUrl = pathToFileURL(
    new URL("../bundles/studio/node_modules/yjs/dist/yjs.mjs", import.meta.url).pathname,
  ).href;
  const scriptText = CLIENT_SCRIPT.replace(
    "'/dashboard/studio/assets/yjs.mjs'",
    JSON.stringify(yjsUrl),
  );
  assert.notEqual(scriptText, CLIENT_SCRIPT, "the test swaps the Yjs asset URL for the file on disk");

  const timers = new Set();
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
    (fn, ms) => {
      const handle = setTimeout(() => {
        timers.delete(handle);
        try {
          fn();
        } catch {
          // A page torn down under its own timer has nothing left to run.
        }
      }, ms);
      timers.add(handle);
      return handle;
    },
    (handle) => {
      timers.delete(handle);
      clearTimeout(handle);
    },
    () => 0,
    () => {},
  );

  const settle = async (rounds = 8) => {
    for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  };
  const waitFor = async (predicate, what, ms = 4000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("timed out waiting for " + what);
  };
  const frame = (message) => {
    for (const handler of socket.handlers.message || []) handler({ data: JSON.stringify(message) });
  };
  const pushState = () => frame({
    type: "state",
    update: Buffer.from(encodeDocState(doc)).toString("base64"),
    history: [],
    presence: [],
  });

  await settle();
  pushState();
  await settle();

  const page = document.querySelector(".studio");
  assert.ok(page, "the rendered page carries the studio shell");

  return {
    document,
    domWindow,
    window: windowStub,
    page,
    doc,
    engine,
    sent,
    storage,
    sources: instances,
    settle,
    waitFor,
    frame,
    pushState,
    /** Every command the page has sent so far. */
    commands() {
      return sent.filter((message) => message.type === "command");
    },
    /** Click a node the way a person would. */
    click(selector) {
      const node = typeof selector === "string" ? document.querySelector(selector) : selector;
      assert.ok(node, `nothing matches ${selector}`);
      node.dispatchEvent(new domWindow.Event("click", { bubbles: true }));
      return node;
    },
    /** Choose a value in a list box the way a person would. */
    choose(selector, value) {
      const node = document.querySelector(selector);
      assert.ok(node, `nothing matches ${selector}`);
      const option = [...node.querySelectorAll("option")]
        .find((candidate) => String(candidate.value) === String(value));
      assert.ok(option, `${selector} offers no ${value}`);
      option.selected = true;
      node.dispatchEvent(new domWindow.Event("change", { bubbles: true }));
      return node;
    },
    /** Let every timer the page left behind go, and tear the page down. */
    stop() {
      document.dispatchEvent(new domWindow.Event("turbo:before-cache"));
      for (const handle of timers) clearTimeout(handle);
      timers.clear();
    },
  };
}

/** The classes on one node, as a list. */
function classesOf(node) {
  assert.ok(node, "a node to read the classes of");
  return String(node.className || "").split(" ").filter(Boolean);
}

/** The cells of one track, in scene order. */
function cellsOf(ui, trackId) {
  return [...ui.document.querySelectorAll(`.st-cell[data-track-id=${trackId}]`)];
}

// ---- the grid, in each mode ----------------------------------------------

test("compose: a cell click opens the clip and outlines exactly that cell", async () => {
  const ui = await bootPage();
  await ui.settle();

  const editing = () => [...ui.document.querySelectorAll(".st-cell-editing")];
  assert.equal(editing().length, 0, "no cell is being edited until a clip is opened");

  ui.click(`.st-clip[data-clip-id=${BASS_CLIP}]`);
  await ui.settle();

  const open = editing();
  assert.equal(open.length, 1, "exactly one cell carries the editing outline");
  assert.equal(open[0].getAttribute("data-track-id"), BASS, "the clip's own track");
  assert.equal(open[0].getAttribute("data-scene-id"), VERSE, "and its own scene");
  assert.ok(
    ui.document.querySelector("[data-role=editor] .st-roll-svg"),
    "the editor draws that clip's roll",
  );
  assert.equal(
    ui.document.querySelector("[data-role=editor] .st-ed-name").value,
    "Bass line",
    "with the clip's name on it",
  );

  // Another clip takes the outline with it: the previous cell is plain again.
  ui.click(`.st-clip[data-clip-id=${LEAD_CLIP}]`);
  await ui.settle();
  const moved = editing();
  assert.equal(moved.length, 1, "still exactly one cell is outlined");
  assert.equal(moved[0].getAttribute("data-track-id"), LEAD);
  assert.equal(moved[0].getAttribute("data-scene-id"), CHORUS);
  assert.equal(
    classesOf(cellsOf(ui, BASS)[0]).includes("st-cell-editing"),
    false,
    "the clip that was open before is no longer the edit target",
  );

  ui.stop();
});

test("perform: a scene header calls launchScene once, a filled cell calls launchClip, an empty cell does nothing", async () => {
  const engine = fakeEngine();
  const ui = await bootPage({ engine });
  await ui.waitFor(
    () => ui.document.querySelector("[data-role=mode-switch] [data-mode=perform]"),
    "the shell's mode switch",
  );
  await ui.settle();

  ui.click("[data-role=mode-switch] [data-mode=perform]");
  await ui.waitFor(
    () => ui.document.querySelector("[data-mode=perform]").getAttribute("aria-pressed") === "true",
    "Perform to be the pressed mode",
  );
  await ui.settle();

  // A scene header is the launch target, once per tap.
  const header = ui.document.querySelector(`.st-scene[data-scene-id=${VERSE}]`);
  assert.ok(header, "the verse's scene header is drawn");
  assert.equal(header.getAttribute("data-act"), "launch-scene", "the header itself launches in Perform");
  ui.click(header);
  await ui.waitFor(() => engine.launched.length === 1, "the scene launch");
  assert.deepEqual(engine.launched, [VERSE], "one tap is one launch");

  // A filled cell launches its clip, and never opens it.
  ui.click(`.st-clip[data-clip-id=${BASS_CLIP}]`);
  await ui.waitFor(() => engine.launched.length === 2, "the clip launch");
  assert.deepEqual(engine.launched, [VERSE, BASS_CLIP], "the filled cell launched that clip");
  assert.equal(ui.document.querySelectorAll(".st-cell-editing").length, 0, "no cell was opened in Perform");
  assert.equal(
    ui.document.querySelector("[data-role=editor] .st-roll-svg"),
    null,
    "and the editor stayed shut",
  );

  // An empty cell is inert: no clip is made, nothing is launched.
  const before = ui.commands().length;
  const emptyCell = ui.document.querySelector(`.st-cell[data-track-id=${SPARE}][data-scene-id=${BRIDGE}]`);
  assert.ok(emptyCell, "the spare track's bridge cell is drawn");
  assert.equal(classesOf(emptyCell).includes("st-cell-empty"), true, "it says it is empty");
  assert.equal(
    emptyCell.querySelector("[data-act=new-clip]"),
    null,
    "and offers no way to make a clip in Perform",
  );
  ui.click(emptyCell);
  await ui.settle();
  assert.equal(ui.commands().length, before, "an empty cell sends no command");
  assert.deepEqual(engine.launched, [VERSE, BASS_CLIP], "and launches nothing");

  ui.stop();
});

test("a queued scene shows .st-cell-next and clears on the engine launched report", async () => {
  const engine = fakeEngine();
  const ui = await bootPage({ engine });
  await ui.settle();

  const waiting = () => [...ui.document.querySelectorAll(".st-cell-next")];
  assert.equal(waiting().length, 0, "nothing is waiting for a bar yet");

  ui.click(`.st-scene[data-scene-id=${VERSE}] [data-act=launch-scene]`);
  await ui.waitFor(() => waiting().length > 0, "the queued scene's cells");
  const queued = waiting();
  const verseCells = ui.document.querySelectorAll(`.st-cell[data-scene-id=${VERSE}]`).length;
  assert.equal(queued.length, verseCells, "every cell of the queued scene waits for the next bar");
  for (const cell of queued) {
    assert.equal(cell.getAttribute("data-scene-id"), VERSE, "and only that scene's cells do");
  }

  await ui.waitFor(() => engine.launchHandlers.length === 1, "the engine's launch report listener");
  const bassCell = () =>
    ui.document.querySelector(`.st-cell[data-track-id=${BASS}][data-scene-id=${VERSE}]`);
  assert.equal(classesOf(bassCell()).includes("st-cell-playing"), false, "nothing is playing yet");

  engine.launchHandlers[0]({ track_id: BASS, clip_id: BASS_CLIP, scene_id: VERSE, frame: 0, bar: 0 });
  await ui.settle();

  assert.equal(waiting().length, 0, "the applied launch is playing, so nothing waits for a bar");

  // A redraw carries the clip the engine reported playing on that track.
  ui.pushState();
  await ui.settle();
  const playing = [...ui.document.querySelectorAll(".st-cell-playing")];
  assert.equal(playing.length, 1, "one cell is the one playing");
  assert.equal(playing[0].getAttribute("data-track-id"), BASS);
  assert.equal(playing[0].getAttribute("data-scene-id"), VERSE);

  ui.stop();
});

test("muted track cells carry .st-cell-muted", async () => {
  const ui = await bootPage();
  await ui.settle();

  const lead = cellsOf(ui, LEAD);
  assert.equal(lead.length, 3, "one cell for every scene");
  for (const cell of lead) {
    assert.equal(classesOf(cell).includes("st-cell-muted"), true, "a muted track's cells say so");
  }
  for (const cell of cellsOf(ui, BASS)) {
    assert.equal(classesOf(cell).includes("st-cell-muted"), false, "an unmuted track's cells do not");
  }

  // The class follows the document: the mute lifted in the song lifts it here.
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  runCommand(ui.doc, "track.set_mix", { track_id: LEAD, mute: false });
  ui.pushState();
  await ui.settle();
  for (const cell of cellsOf(ui, LEAD)) {
    assert.equal(classesOf(cell).includes("st-cell-muted"), false, "and it goes when the mute does");
  }

  ui.stop();
});

test("a track-name tap sets aimTrackId and opens that track's editor, or shows the no-clip note", async () => {
  const ui = await bootPage();
  await ui.settle();

  const before = ui.commands().length;
  const nameOf = (trackId) => ui.document.querySelector(`[data-track-id=${trackId}] .st-name`);
  const aimed = () =>
    [...ui.document.querySelectorAll(".st-th-aimed")].map((head) => head.getAttribute("data-track-id"));

  // The track whose clip is in the first scene opens that clip.
  ui.click(nameOf(BASS));
  await ui.settle();
  assert.deepEqual(aimed(), [BASS], "the tapped track is the one aimed at");
  const firstOpen = ui.document.querySelector(".st-cell-editing");
  assert.ok(firstOpen, "a cell carries the editing outline");
  assert.equal(firstOpen.getAttribute("data-scene-id"), VERSE, "the clip in the first scene that holds one");
  assert.equal(ui.document.querySelector("[data-role=editor] .st-ed-name").value, "Bass line");

  // A track whose only clip is in the second scene opens THAT clip.
  ui.click(nameOf(LEAD));
  await ui.settle();
  assert.deepEqual(aimed(), [LEAD], "and the aim moved with it");
  assert.equal(
    ui.document.querySelector(".st-cell-editing").getAttribute("data-scene-id"),
    CHORUS,
    "the first scene, in the song's order, that holds a clip on the tapped track",
  );

  // A track with nothing on it says so where the editor would be.
  ui.click(nameOf(SPARE));
  await ui.settle();
  assert.deepEqual(aimed(), [SPARE]);
  const note = ui.document.querySelector("[data-role=no-clip-note]");
  assert.ok(note, "the editor's host carries the note");
  assert.equal(String(note.textContent), "No clip on this track yet.");
  assert.equal(ui.document.querySelector("[data-role=editor]").hidden, false, "and the host is shown");
  assert.equal(ui.document.querySelectorAll(".st-cell-editing").length, 0, "no cell is the edit target");

  // Opening a clip takes the note's place.
  ui.click(`.st-clip[data-clip-id=${BASS_CLIP}]`);
  await ui.settle();
  assert.equal(ui.document.querySelector("[data-role=no-clip-note]"), null, "a clip on screen replaces it");

  assert.equal(ui.commands().length, before, "selecting a track writes nothing to the song");

  ui.stop();
});

test("Copy to scene sends the command and never offers an occupied cell or another track's cell", async () => {
  const ui = await bootPage();
  await ui.settle();

  ui.click(`.st-clip[data-clip-id=${KIT_VERSE}]`);
  await ui.settle();

  const picker = ui.document.querySelector("[data-act=copy-to-scene]");
  assert.ok(picker, "a pattern clip's header carries the picker");
  assert.equal(picker.getAttribute("aria-label"), "Copy to scene");
  assert.equal(picker.disabled, false, "with a free cell on its track, it is usable");

  const options = [...picker.querySelectorAll("option")];
  assert.deepEqual(options.map((option) => String(option.textContent)), ["Copy to scene...", "Bridge"]);
  assert.deepEqual(options.map((option) => option.value), ["", BRIDGE]);
  assert.equal(
    options.some((option) => option.value === CHORUS),
    false,
    "the scene its own track already fills is not offered",
  );
  assert.equal(
    options.some((option) => option.value === VERSE),
    false,
    "nor is its own cell",
  );
  // The bass fills the bridge, and that is the bass's own cell: the kit's copy
  // still goes there.
  assert.equal(
    options.some((option) => option.value === BRIDGE),
    true,
    "another track's occupied cell is not this track's",
  );

  ui.choose("[data-act=copy-to-scene]", BRIDGE);
  await ui.settle();
  const sent = ui.commands().filter((message) => message.command === "clip.copy_to_scene");
  assert.equal(sent.length, 1, "one copy command");
  assert.equal(sent[0].args.clip_id, KIT_VERSE, "of the clip the header belongs to");
  assert.equal(sent[0].args.scene_id, BRIDGE, "into the scene that was picked");
  assert.match(String(sent[0].args.new_clip_id), /^c-/, "with an id this page made");
  assert.equal(picker.value, "", "and the pick goes back to its label");

  // A track every scene is filled on has nowhere to copy to.
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  runCommand(ui.doc, "clip.add_pattern", {
    clip_id: "c-kit-bridge",
    track_id: KIT,
    scene_id: BRIDGE,
    name: "Kit C",
    length_steps: 16,
  });
  ui.pushState();
  await ui.settle();
  const blocked = ui.document.querySelector("[data-act=copy-to-scene]");
  assert.equal(blocked.disabled, true, "a full track's picker is disabled");
  assert.equal(
    blocked.getAttribute("title"),
    "Every scene already has a clip on this track",
    "and says why",
  );
  assert.deepEqual(
    [...blocked.querySelectorAll("option")].map((option) => option.value),
    [""],
    "with no scene to offer",
  );

  ui.stop();
});