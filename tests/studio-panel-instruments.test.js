/**
 * Studio panel — the instrument picker and your own bank (plan 1d, Task 4).
 *
 * A soundfont track's header is where its instrument is chosen: the presets of
 * the bank it plays (read by the engine and posted to the page), the song's
 * other banks, a CC-BY bank's credit, and the two ways to get a bank — the
 * catalog's default, or the operator's own SF2/SF3 file. What this file pins:
 *
 *   - a pick is ONE command: one `track.set_program` for a preset, and one
 *     `track.set_font` for a bank or for the file the operator brought;
 *   - a file that is not an SF2/SF3 bank, or one past 512 MB, is refused in the
 *     browser before a single request is made;
 *   - a bank that will not parse plays silence and the track says why — the
 *     reason coming from the REAL font host, loaded here in Node, not from a
 *     stand-in;
 *   - `Get the default instruments` downloads once (a second press while it
 *     runs does nothing) and the picker then lists the presets of the bank it
 *     brought;
 *   - in a real browser, a preset picked with a real mouse click sends exactly
 *     one `track.set_program`, the engine having parsed the fixture bank there.
 *
 * The bank is `tests/fixtures/tiny-sf2.mjs`, built in the test process (nothing
 * is downloaded). `+ Instrument`, the header's picker and its actions are driven
 * through a linkedom page whose commands are the fixture song's real ones.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";
import studioPanel from "../bundles/studio/panel/studio.js";
import { TINY_SF2_PRESETS, tinySf2 } from "./fixtures/tiny-sf2.mjs";

/** The fixture song's id (the linkedom page) and its one soundfont track. */
const SONG = "song-1";
const TRACK = "keys";
const SCENE = "verse";

/** The project the fixture song lives in, and its storage prefix. */
const PROJECT = 62;
const PREFIX = "projects/62/";

/** The bank every test plays, the library ids it travels under, and its bytes. */
const FONT_BYTES = tinySf2();
const FONT_ID = "lib-tiny";
const CATALOG_ID = "tiny-bank";
const DOWNLOADED_ID = "lib-musescore-general";
const CREDIT = "Tiny Test Font by the test suite, CC-BY-4.0";

/** The engine's preset list for the fixture bank: what the processor reads. */
const PRESETS = TINY_SF2_PRESETS.map((preset) => ({ bank: preset.bank, program: preset.program, name: preset.name }));

/** The engine sources, read exactly as a Node caller reads them. */
const ENGINE_DIR = new URL("../bundles/studio/engine/", import.meta.url).pathname;
const SPESSA_DIR = new URL("../bundles/studio/vendor/spessasynth/", import.meta.url).pathname;

/** The `sha256` the fixture entry declares (its exact value is not used here). */
const SHA256 = "a".repeat(64);

// ---- the real font host, for the corrupt-bank test -------------------------

/**
 * Load the vendored synth and the real font host into this process, the way the
 * worklet scope has them (two classic scripts, one global each). Done once.
 * @returns {void}
 */
function loadRealFontHost() {
  if (globalThis.StudioFontVoice) return;
  const source = readFileSync(join(SPESSA_DIR, "spessasynth.js"), "utf8")
    + "\n" + readFileSync(join(ENGINE_DIR, "font-voice.js"), "utf8");
  new Function(source)();
  assert.ok(globalThis.StudioFontVoice, "the real font host has to load");
}

/** @param {Float32Array[]} channels @returns {number} the largest absolute sample. */
function peakOfAll(channels) {
  let peak = 0;
  for (const channel of channels) {
    for (let at = 0; at < channel.length; at += 1) {
      const value = Math.abs(channel[at]);
      if (value > peak) peak = value;
    }
  }
  return peak;
}

// ---- the fixture song ------------------------------------------------------

/**
 * One library entry for the fixture bank.
 * @param {string} id
 * @param {object} [overrides]
 * @returns {object}
 */
function libraryEntry(id, overrides = {}) {
  return {
    id: id,
    kind: "font",
    name: "Tiny Test Font",
    source: "catalog",
    catalog_id: CATALOG_ID,
    sha256: SHA256,
    bytes: FONT_BYTES.byteLength,
    licence: "CC-BY-4.0",
    credit: CREDIT,
    ...overrides,
  };
}

/**
 * One song with one soundfont track, and (unless asked otherwise) a bank in its
 * library.
 * @param {{withFont?: boolean, fontId?: string, entry?: object}} [options]
 * @returns {Promise<import("yjs").Doc>}
 */
async function instrumentDoc(options = {}) {
  const { newSongDoc } = await import("../bundles/studio/server/doc.js");
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  await import("../bundles/studio/server/commands/core.js");
  await import("../bundles/studio/server/commands/library.js");
  await import("../bundles/studio/server/commands/instruments.js");

  const withFont = options.withFont !== false;
  const doc = newSongDoc({ title: "Keys", bpm: 120 });
  if (withFont) {
    runCommand(doc, "library.add", { entry: options.entry || libraryEntry(options.fontId || FONT_ID) });
  }
  runCommand(doc, "track.add", {
    id: TRACK,
    name: "Keys",
    kind: "soundfont",
    ...(withFont ? { font_id: options.fontId || FONT_ID } : {}),
  });
  runCommand(doc, "scene.add", { id: SCENE, name: "Verse" });
  return doc;
}

// ---- the page's fakes ------------------------------------------------------

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
  return {
    async listPending() {
      return [];
    },
    async getPending() {
      return null;
    },
    async putPending() {
      return true;
    },
    async deletePending() {
      return true;
    },
    async putChunk() {
      return true;
    },
    async getChunk() {
      return null;
    },
    async countChunks() {
      return { count: 0, bytes: 0 };
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

/** A context stand-in: the nodes the page builds and its clock. */
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
 * The engine stand-in: it records the banks it was asked to load, answers with
 * the fixture bank's presets (or with whatever `answer` says), and lets a test
 * push a `library_needed` as the processor does.
 * @param {Function|object} [answer] one `{status, reason?, presets?}` per load,
 *   or one for every load
 */
function fakeEngine(answer) {
  const engine = {
    libraryLoads: [],
    libraryNeeded: [],
    presetsListeners: [],
    songs: [],
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
    onSampleNeeded() {
      return () => {};
    },
    onLibraryNeeded(listener) {
      engine.libraryNeeded.push(listener);
      return () => {};
    },
    onLibraryPresets(listener) {
      engine.presetsListeners.push(listener);
      return () => {};
    },
    loadLibrary(libraryId, kind, bytes) {
      engine.libraryLoads.push({ library_id: String(libraryId), kind: String(kind), bytes: bytes.byteLength });
      const planned = typeof answer === "function"
        ? answer(String(libraryId))
        : answer || { status: "loaded", presets: PRESETS };
      if (planned && planned.status === "loaded" && planned.presets) {
        for (const listener of [...engine.presetsListeners]) listener(String(libraryId), planned.presets);
      }
      return Promise.resolve(planned);
    },
    unloadLibrary() {},
    loadSample() {
      return Promise.resolve();
    },
    unloadSample() {},
    livePad() {},
    liveRelease() {},
    fxHold() {},
    fxRelease() {},
    looper() {},
    async nextBarFrame() {
      return { frame: 0, bar: 1 };
    },
    async loadAudio() {},
    unloadAudio() {},
    createRecorder() {
      return Promise.resolve(null);
    },
  };
  return engine;
}

/**
 * Boot the emitted client script against the page the handler renders, with a
 * fake browser around it, and hand back what it drew, sent and fetched.
 * @param {{doc?: object, engineAnswer?: Function|object, holdDownload?: boolean,
 *          libraryFile?: {status?: number, bytes?: Uint8Array},
 *          downloadAnswer?: object, history?: object[]}} [options]
 */
async function bootInstrument(options = {}) {
  const { parseHTML } = await import("linkedom");
  const { encodeDocState } = await import("../bundles/studio/server/doc.js");
  const { CLIENT_SCRIPT } = await import("../bundles/studio/panel/client.js");

  const doc = options.doc || (await instrumentDoc());
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
  assert.ok(res.html.includes('data-catalog-default="'), "the page carries the catalog's default entry");
  const { document, window: domWindow } = parseHTML(res.html);

  const engine = fakeEngine(options.engineAnswer);
  const sent = [];
  const requests = [];
  let releaseDownload = () => {};
  const heldDownload = options.holdDownload
    ? new Promise((resolve) => {
        releaseDownload = resolve;
      })
    : null;

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
    requests.push({ url: target, method, body: typeof init.body === "string" ? init.body : null });
    if (target.includes("/module-types")) return response(200, { generators: ["Analog generator"], modules: {} });
    if (target.includes("/project-bot")) return response(404, { error: "not_found" });
    if (target === "/api/studio/songs") return response(200, [{ id: SONG, project_id: PROJECT, title: "Keys" }]);
    if (target.includes("/library/download")) {
      if (heldDownload) await heldDownload;
      return response(200, options.downloadAnswer || {
        entry: libraryEntry(DOWNLOADED_ID, {
          name: "MuseScore General",
          catalog_id: "musescore-general",
          licence: "MIT",
          credit: "MuseScore General, MIT",
        }),
        downloaded: true,
      });
    }
    if (target.includes("/library/") && target.endsWith("/file")) {
      const file = options.libraryFile || {};
      if (Number(file.status) === 404) return response(404, { error: "This instrument is not on this Crow yet." });
      return response(200, {}, (file.bytes || FONT_BYTES).slice(0).buffer);
    }
    if (target.includes("/api/studio/takes")) {
      if (target.includes("/finish")) {
        return response(200, {
          library: libraryEntry("lib-uploaded", { source: "upload", name: "My Bank", catalog_id: null }),
        });
      }
      if (target.includes("/chunks/")) return response(200, { sha256: SHA256 });
      return response(200, { chunk_bytes: 1048576 });
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
    addEventListener() {},
    removeEventListener() {},
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
    { locks: null, mediaDevices: null, hardwareConcurrency: 8 },
    function WebSocketStub() {
      return socket;
    },
    fetchStub,
    globalThis.crypto,
    globalThis.atob,
    console,
    (fn) => setTimeout(fn, 0),
    (id) => clearTimeout(id),
    () => 0,
    () => {},
  );

  const settle = async (rounds = 24) => {
    for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  };
  const frame = (message) => {
    for (const handler of socket.handlers.message || []) handler({ data: JSON.stringify(message) });
  };
  const stateFrame = (nextDoc = doc) => ({
    type: "state",
    update: Buffer.from(encodeDocState(nextDoc)).toString("base64"),
    history: options.history || [],
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

  const ui = {
    doc,
    document,
    domWindow,
    window: windowStub,
    engine,
    sent,
    requests,
    event,
    settle,
    frame,
    stateFrame,
    releaseDownload() {
      releaseDownload();
    },
    /** @returns {object} the track's instrument picker */
    picker() {
      const node = document.querySelector(`[data-role=instrument][data-track-id="${TRACK}"]`);
      assert.ok(node, "the soundfont track's header holds an instrument picker");
      return node;
    },
    /** @returns {object[]} the preset rows drawn right now */
    presetRows() {
      return [...ui.picker().querySelectorAll("[data-act=pick-preset] option")];
    },
    /** Pick one preset, the way a click on its row does. */
    async pickPreset(value) {
      const select = ui.picker().querySelector("[data-act=pick-preset]");
      assert.ok(select, "the picker offers its presets");
      const option = [...select.querySelectorAll("option")].find((row) => row.value === value);
      assert.ok(option, `the picker lists ${value}`);
      option.selected = true;
      select.dispatchEvent(event("change", { target: select }));
      await settle();
    },
    /** @returns {string} the track's own status line under its picker */
    status() {
      const node = ui.picker().querySelector(".st-font-state");
      return node ? String(node.textContent) : "";
    },
    /** @returns {string} the credit line under the picker */
    credit() {
      const node = ui.picker().querySelector(".st-credit");
      return node ? String(node.textContent) : "";
    },
    /** @returns {string} the page's toast */
    toast() {
      const node = document.querySelector("[data-role=toast]");
      return node ? String(node.textContent) : "";
    },
    /** Hand the file input one file, as choosing one does. */
    chooseFile(name, bytes, size) {
      const input = ui.picker().querySelector("[data-act=font-file]");
      assert.ok(input, "the picker offers Add your own bank");
      const data = bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(String(bytes));
      input.files = [{
        name: name,
        size: size === undefined ? data.byteLength : size,
        slice(from, to) {
          return {
            async arrayBuffer() {
              return data.slice(from, to).buffer;
            },
          };
        },
      }];
      input.dispatchEvent(event("change", { target: input }));
      return input;
    },
    click(selector) {
      const node = document.querySelector(selector);
      assert.ok(node, `nothing matches ${selector}`);
      node.dispatchEvent(new domWindow.Event("click", { bubbles: true }));
      return node;
    },
    /** Run the real commands on the fixture song, then redraw the page. */
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

/** @returns {object[]} every request of one method to a URL fragment. */
function requestsTo(ui, method, fragment) {
  return ui.requests.filter((request) => request.method === method && request.url.includes(fragment));
}

// ---- the picker ------------------------------------------------------------

test("picking a preset sends one set_program", async () => {
  const ui = await bootInstrument();
  // The page builds the engine for a song with instruments, so the bank is read
  // (and its presets listed) before anything is played.
  assert.equal(ui.engine.libraryLoads.length, 1, "the bank was handed to the engine once");
  assert.equal(ui.engine.libraryLoads[0].library_id, FONT_ID);
  assert.equal(ui.engine.libraryLoads[0].kind, "font");
  assert.equal(ui.engine.libraryLoads[0].bytes, FONT_BYTES.byteLength, "the whole file route's bytes");

  const rows = ui.presetRows();
  assert.equal(rows.length, PRESETS.length, "every preset of the bank is a row");
  assert.deepEqual(
    rows.slice(0, 3).map((row) => String(row.textContent)),
    ["0:0 Sine 340", "0:1 Sine 420", "0:2 Sine 500"],
    "a row is bank:program Name",
  );
  assert.equal(String(rows[rows.length - 1].textContent), "Drums:0 Drum 220", "bank 128 reads Drums");
  assert.equal(ui.credit(), CREDIT, "a bank's credit sits under its picker");

  await ui.pickPreset("0:1");
  const picks = commands(ui, "track.set_program");
  assert.equal(picks.length, 1, `one pick is one set_program, got ${JSON.stringify(picks)}`);
  assert.deepEqual(picks[0].args, { track_id: TRACK, bank: 0, program: 1 });
  assert.equal(commands(ui, "track.set_font").length, 0, "a preset pick never changes the bank");

  // A drum kit is one more pick, and one more command.
  await ui.pickPreset("128:0");
  const drums = commands(ui, "track.set_program");
  assert.equal(drums.length, 2);
  assert.deepEqual(drums[1].args, { track_id: TRACK, bank: 128, program: 0 });
});

test("+ Instrument adds a soundfont track on the song's first bank", async () => {
  const ui = await bootInstrument();
  assert.ok(
    String(ui.document.querySelector("[data-act=add-instrument-track]").textContent).includes("+ Instrument"),
    "the corner offers + Instrument beside + Sampler",
  );
  ui.click("[data-act=add-instrument-track]");
  await ui.settle();
  const added = commands(ui, "track.add");
  assert.equal(added.length, 1, "one track.add");
  assert.equal(added[0].args.kind, "soundfont");
  assert.equal(added[0].args.font_id, FONT_ID, "pointed at the song's first bank");

  // A song with no bank at all gets a track with no instrument, and its header
  // says where the default instruments come from.
  const bare = await bootInstrument({ doc: await instrumentDoc({ withFont: false }) });
  bare.click("[data-act=add-instrument-track]");
  await bare.settle();
  const lonely = commands(bare, "track.add");
  assert.equal(lonely.length, 1);
  assert.equal(lonely[0].args.kind, "soundfont");
  assert.equal("font_id" in lonely[0].args, false, "no bank to point it at");
  assert.match(String(bare.picker().textContent), /Get the default instruments/);
});

test("a song with more than one bank gets a chooser that sends one set_font", async () => {
  const other = "lib-other";
  const doc = await instrumentDoc();
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  runCommand(doc, "library.add", { entry: libraryEntry(other, { name: "Another Bank" }) });
  const ui = await bootInstrument({ doc });

  const chooser = ui.picker().querySelector("[data-act=pick-font]");
  assert.ok(chooser, "a song with two banks offers the font chooser");
  assert.deepEqual(
    [...chooser.querySelectorAll("option")].map((option) => String(option.textContent)),
    ["Another Bank", "Tiny Test Font"],
    "every bank of the library, by name",
  );
  assert.equal(chooser.value, FONT_ID, "the bank the track plays is the one shown");

  const option = [...chooser.querySelectorAll("option")].find((row) => row.value === other);
  option.selected = true;
  chooser.dispatchEvent(ui.event("change", { target: chooser }));
  await ui.settle();
  const picks = commands(ui, "track.set_font");
  assert.equal(picks.length, 1, `one set_font, got ${JSON.stringify(picks)}`);
  assert.deepEqual(picks[0].args, { track_id: TRACK, font_id: other });
  assert.equal(commands(ui, "track.set_program").length, 0, "choosing a bank leaves the preset alone");
});

test("a bank requested while playing says it loads when you stop", async () => {
  const ui = await bootInstrument({ engineAnswer: { status: "deferred" } });
  assert.equal(ui.status(), "Loads when you stop.", "the plan's sentence, word for word");
  assert.equal(ui.presetRows().length, 0, "a bank that has not parsed lists nothing");
});

test("a bank that is not on this device says so", async () => {
  const ui = await bootInstrument({ libraryFile: { status: 404 } });
  assert.equal(ui.status(), "Get this instrument", "a catalog entry offers the download");
  const download = ui.picker().querySelector("[data-act=get-default-instruments]");
  assert.equal(String(download.textContent), "Get this instrument");
  assert.equal(download.getAttribute("data-catalog-id"), CATALOG_ID, "the entry its own row names");

  // An uploaded bank nobody has is not something the catalog can supply.
  const uploaded = await bootInstrument({
    doc: await instrumentDoc({ entry: libraryEntry(FONT_ID, { source: "upload", catalog_id: undefined, upload_id: "u-1" }) }),
    libraryFile: { status: 404 },
  });
  assert.equal(uploaded.status(), "This bank is not on this device.");
});

test("an agent's instrument change outlines the picker", async () => {
  const ui = await bootInstrument({
    history: [{
      id: "h-1",
      seq: 3,
      command: "track.set_program",
      args: { track_id: TRACK, bank: 0, program: 2 },
      summary: "Set track Keys to program 3",
      author: { kind: "agent", id: "agent:mcp", label: "Agent (MCP)" },
      touched: [`track:${TRACK}`],
      undone_by: null,
    }],
  });
  assert.match(String(ui.picker().className), /st-agent-edit/, "the agent's edit is outlined, as its clips are");
  const human = await bootInstrument();
  assert.doesNotMatch(String(human.picker().className), /st-agent-edit/);
});

// ---- your own bank ---------------------------------------------------------

test("a bank upload is refused before it starts when it is not SF2/SF3", async () => {
  const ui = await bootInstrument();
  const before = ui.requests.length;

  // A file whose bytes are not RIFF...sfbk: refused from the head alone.
  ui.chooseFile("not-a-bank.sf2", "this is not a SoundFont file at all");
  await ui.settle();
  assert.equal(ui.toast(), "That file is not an SF2 or SF3 bank.");
  assert.equal(ui.requests.length, before, "no request is made for a file that is not a bank");

  // A file that is not an SF2/SF3 file at all: refused by its extension.
  ui.chooseFile("piano.wav", FONT_BYTES);
  await ui.settle();
  assert.equal(ui.toast(), "Studio takes SF2 and SF3 banks.");
  assert.equal(ui.requests.length, before, "and none for one of the wrong type");

  // Past the plan's limit: refused by its size, in the server's own words.
  ui.chooseFile("huge.sf3", FONT_BYTES, 600 * 1024 * 1024);
  await ui.settle();
  assert.equal(ui.toast(), "That bank is 600 MB; Studio takes banks up to 512 MB.");
  assert.equal(ui.requests.length, before, "and none for a bank past 512 MB");
});

test("a bank of my own uploads and its track picks it", async () => {
  const ui = await bootInstrument();
  ui.chooseFile("My Bank.SF2", FONT_BYTES);
  await ui.settle(60);

  const begin = requestsTo(ui, "PUT", "/api/studio/takes/").filter((request) => request.body);
  assert.equal(begin.length, 1, `one begin, got ${JSON.stringify(begin)}`);
  const body = JSON.parse(begin[0].body);
  assert.equal(body.kind, "font", "a bank is its own upload kind");
  assert.equal(body.song_id, SONG);
  assert.equal(body.project_id, PROJECT);
  assert.equal(body.name, "My Bank", "the entry is the file's name without its extension");
  assert.equal(body.file_name, "My Bank.SF2", "the extension is the file's own");
  assert.equal(body.bytes, FONT_BYTES.byteLength);
  const head = Uint8Array.from(atob(body.head), (char) => char.charCodeAt(0));
  assert.equal(new TextDecoder().decode(head.slice(0, 4)), "RIFF");
  assert.equal(new TextDecoder().decode(head.slice(8, 12)), "sfbk", "begin is told the magic bytes");

  const chunks = requestsTo(ui, "PUT", "/chunks/");
  assert.equal(chunks.length, Math.ceil(FONT_BYTES.byteLength / 1048576), "the file went up in 1 MiB chunks");
  const finish = requestsTo(ui, "POST", "/finish");
  assert.equal(finish.length, 1, "one finish");
  const hashes = JSON.parse(finish[0].body).chunk_hashes;
  assert.equal(hashes.length, chunks.length, "finish carries every chunk's hash");

  // The track picks the bank it was given: ONE set_font.
  const picks = commands(ui, "track.set_font");
  assert.equal(picks.length, 1, `one set_font, got ${JSON.stringify(picks)}`);
  assert.deepEqual(picks[0].args, { track_id: TRACK, font_id: "lib-uploaded" });
  assert.match(String(ui.picker().querySelector(".st-note").textContent), /responsible for this bank's licence/);
});

// ---- a bank that will not parse -------------------------------------------

test("a corrupt bank plays silence and says why", async () => {
  // The REAL font host, the same file the worklet loads: a bank carrying no
  // preset at all is refused, and the track that wanted it stays silent.
  loadRealFontHost();
  const host = globalThis.StudioFontVoice.create(48000);
  const empty = tinySf2({ presets: [] });
  let reason = "";
  await assert.rejects(
    () => host.load("lib-empty", empty),
    (err) => {
      reason = String(err && err.message ? err.message : err);
      return /no instruments/.test(reason);
    },
  );
  host.assign([{ track_id: TRACK, font_id: "lib-empty", bank: 0, program: 0 }]);
  assert.deepEqual(host.missing(), ["lib-empty"], "the engine says which bank it does not hold");
  const outputs = host.process(128);
  const pair = outputs.get(TRACK);
  assert.ok(pair, "the track still has its own stereo pair");
  assert.equal(peakOfAll([pair.left, pair.right]), 0, "a bank that will not load is silent");
  assert.equal(reason, "This bank has no instruments.", "the engine's own sentence");

  // The page shows that very reason on the track that plays the bank.
  const ui = await bootInstrument({ engineAnswer: { status: "failed", reason: reason } });
  assert.equal(ui.status(), reason, "the track says why its bank plays nothing");
  assert.equal(ui.presetRows().length, 0, "and lists no presets");
});

// ---- the catalog's default ------------------------------------------------

test("get the default instruments downloads once and the picker lists its presets", async () => {
  const ui = await bootInstrument({ doc: await instrumentDoc({ withFont: false }), holdDownload: true });
  // A song with no bank: the header offers the action and nothing else.
  assert.equal(ui.presetRows().length, 0);
  const download = ui.picker().querySelector("[data-act=get-default-instruments]");
  assert.equal(String(download.textContent), "Get the default instruments");

  ui.click("[data-act=get-default-instruments]");
  await ui.settle();
  assert.equal(requestsTo(ui, "POST", "/library/download").length, 1, "one download starts");
  const body = JSON.parse(requestsTo(ui, "POST", "/library/download")[0].body);
  assert.equal(body.song_id, SONG);
  assert.equal(body.catalog_id, "musescore-general", "the catalog entry the page names as its default");
  assert.equal(
    ui.picker().querySelector("[data-act=get-default-instruments]").disabled,
    true,
    "the button is disabled while its download runs",
  );

  // A second press while it runs does nothing at all.
  ui.click("[data-act=get-default-instruments]");
  await ui.settle();
  assert.equal(requestsTo(ui, "POST", "/library/download").length, 1, "a second press downloads nothing");

  ui.releaseDownload();
  await ui.settle(60);
  assert.equal(requestsTo(ui, "POST", "/library/download").length, 1, "one download, once");

  // The track picks the bank it was given — ONE command — and the song now holds
  // that entry (the fixture song runs the real command below).
  const picks = commands(ui, "track.set_font");
  assert.equal(picks.length, 1);
  assert.deepEqual(picks[0].args, { track_id: TRACK, font_id: DOWNLOADED_ID });
  await ui.apply("library.add", {
    entry: libraryEntry(DOWNLOADED_ID, {
      name: "MuseScore General",
      catalog_id: "musescore-general",
      licence: "MIT",
      credit: "MuseScore General, MIT",
    }),
  });
  // The pick the page sent is what the song now holds: the track plays the bank
  // it just brought.
  await ui.apply("track.set_font", { track_id: TRACK, font_id: DOWNLOADED_ID });
  await ui.settle(40);

  // The picker lists the presets of the bank it brought.
  const rows = ui.presetRows();
  assert.equal(rows.length, PRESETS.length, "the downloaded bank's presets are listed");
  assert.deepEqual(
    rows.slice(0, 2).map((row) => String(row.textContent)),
    ["0:0 Sine 340", "0:1 Sine 420"],
  );
  assert.equal(ui.credit(), "MuseScore General, MIT", "its credit sits under the picker");
  assert.equal(ui.status(), "", "a loaded bank has nothing to explain");

  // A pick from the list is one set_program again.
  await ui.pickPreset("0:2");
  assert.deepEqual(commands(ui, "track.set_program").at(-1).args, { track_id: TRACK, bank: 0, program: 2 });
});

// ---- real input events, through the DevTools protocol ----------------------

let chrome = null;
let dir = null;
let db = null;
let hub = null;
let server = null;
let upgrades = null;
let base = "";
let liveSong = "";
let fontPath = "";

/** The `storage_prefix` of the project the live song lives in. */
const LIVE_PREFIX = "projects/63/";

/** The live support: an ACL that allows the one project, over its real tables. */
function fakeAcl() {
  async function assertProjectExists(_db, projectId) {
    if (Number(projectId) !== PROJECT) throw new AclError(`Project #${projectId} not found`, "not_found");
    return { id: PROJECT };
  }
  return {
    assertProjectExists,
    assertCapability: (database, projectId) => assertProjectExists(database, projectId),
    async appendAudit() {},
  };
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
  // No browser means no live half: nothing is started, so a sandbox without
  // Chrome costs this file nothing.
  chrome = await startHeadlessChrome({ extraArgs: ["--autoplay-policy=no-user-gesture-required"] });
  if (!chrome) return;

  dir = mkdtempSync(join(tmpdir(), "studio-panel-instruments-"));
  fontPath = join(dir, "tiny.sf2");
  writeFileSync(fontPath, FONT_BYTES);
  db = createClient({ url: "file:" + join(dir, "crow.db") });
  await db.execute(
    "CREATE TABLE IF NOT EXISTS project_spaces (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, status TEXT, archived_at TEXT, storage_prefix TEXT)",
  );
  await db.execute({
    sql: "INSERT INTO project_spaces (id, name, storage_prefix) VALUES (?, ?, ?)",
    args: [PROJECT, "Studio project", LIVE_PREFIX],
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
    bundleDir: new URL("../bundles/studio/", import.meta.url).pathname,
    // The tiny fixture bank is what the catalog entry "holds" on this Crow.
    libraryStore: {
      entries: () => [],
      entry: async () => null,
      download: async () => ({ fetched: false, entry: null }),
      fileForHash: async () => fontPath,
      fileFor: async () => fontPath,
      holds: async () => true,
      gc: async () => {},
    },
    assertCanWrite: async () => {},
  });
  webRef.web = web;

  const created = await hub.createSong({ project_id: PROJECT, title: "Live instruments", author: { kind: "human", id: "local", label: "You" } });
  assert.equal(created.ok, true, `createSong was refused: ${created.error}`);
  liveSong = created.song_id;
  const run = async (command, args, internal = false) => {
    const result = await hub.runCommand({
      song_id: liveSong,
      cmd_id: null,
      command,
      args,
      author: { kind: "human", id: "local", label: "You" },
      internal,
    });
    assert.equal(result.ok, true, `${command} was refused: ${result.error}`);
  };
  await run("library.add", { entry: libraryEntry(FONT_ID) }, true);
  await run("track.add", { id: TRACK, name: "Keys", kind: "soundfont", font_id: FONT_ID });
  await run("scene.add", { id: SCENE, name: "Verse" });

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

/** The live page's URL for the seeded song. */
function studioUrl() {
  return `${base}/dashboard/studio?song=${encodeURIComponent(liveSong)}`;
}

/**
 * Open one page in the private browser with the dashboard's cookies, and return
 * its CDP handle.
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

/** Poll the live song's document until `check` accepts its snapshot. */
async function waitForSong(check, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = (await hub.openSong(liveSong)).snapshot;
    try {
      if (check(last)) return last;
    } catch {
      // A snapshot mid-update is not an answer; look again.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
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
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height };
  })()`);
  assert.ok(box, `nothing matches ${selector}`);
  return box;
}

/** A real press-and-release on the node, through the browser's own input. */
async function mousePress(page, selector) {
  const { x, y } = await centreOf(page, selector);
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", clickCount: 0 });
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
}

test("picking a preset with real mouse input sends one set_program", async (t) => {
  if (!chrome) return t.skip("no headless Chrome available");
  const page = await openPage(studioUrl());
  t.after(() => page.close());
  assert.ok(
    await waitFor(page, "!!document.querySelector('[data-role=grid] .st-corner')", 20000),
    "the studio grid rendered (the page's Yjs replica did not load)",
  );
  // The engine parses the fixture bank in the browser itself, which is what puts
  // its presets in the picker.
  assert.ok(
    await waitFor(
      page,
      `document.querySelectorAll('[data-role=instrument][data-track-id=${TRACK}] [data-act=pick-preset] option').length > 1`,
      30000,
    ),
    "the picker never listed the bank's presets (the engine did not parse it)",
  );
  const before = await page.evaluate(`(function () {
    var rows = document.querySelectorAll('[data-role=instrument][data-track-id=${TRACK}] [data-act=pick-preset] option');
    var seen = [];
    for (var i = 0; i < rows.length; i += 1) seen.push(rows[i].textContent);
    return { count: rows.length, first: seen.slice(0, 3), drums: seen[seen.length - 1] };
  })()`);
  assert.equal(before.first[1], "0:1 Sine 420", "the bank's own preset names, from the parsed file");
  assert.equal(before.drums, "Drums:0 Drum 220", "bank 128 reads Drums");

  // A REAL mouse press on the second row of the list box. Not element.click().
  await mousePress(page, `[data-role=instrument][data-track-id=${TRACK}] [data-act=pick-preset] option[value="0:1"]`);
  const picked = await waitForSong((snap) => snap.tracks.find((track) => track.id === TRACK)?.device?.program === 1);
  assert.equal(
    picked.tracks.find((track) => track.id === TRACK).device.program,
    1,
    "the pick reached the song's document",
  );
  assert.equal(picked.tracks.find((track) => track.id === TRACK).device.font_id, FONT_ID, "and left the bank alone");
  const entries = await hub.history(liveSong, { limit: 100 });
  const picks = entries.filter((entry) => entry.command === "track.set_program");
  assert.equal(picks.length, 1, `one mouse pick is exactly one set_program (got ${picks.length})`);
  assert.equal(picks[0].args.track_id, TRACK);
  assert.equal(picks[0].args.bank, 0);
  assert.equal(picks[0].args.program, 1);
});