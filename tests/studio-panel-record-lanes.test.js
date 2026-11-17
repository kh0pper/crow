/**
 * Studio panel — the recording lanes widget (A4a).
 *
 * The emitted client script runs against a linkedom document built from the page
 * the handler renders, with a real Yjs song and a fake engine: what these cases
 * check is the STATIC picture the widget draws — one lane per track on the
 * arrangement's own bar axis, each lane's arm, mute and solo (the grid's and the
 * mixer strip's own controls), the clips the ARRANGEMENT places on it, a ruler
 * with the section bands and the transport's playhead, and the two sentences a
 * song with nothing to draw gets. The record target (the first armed audio
 * track, as `startRecording` reads it) is drawn tall and red and named Armed,
 * and every other armed lane only says Armed; the meter and the live waveform
 * are A4b's, so nothing here draws one.
 *
 * The widget is view state from end to end: no case sends a command except the
 * mute, solo and arm buttons, which are the existing ones.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

/** The note track, whose lane shows a placement and cannot be armed. */
const NOTE_TRACK = "bass";

/** The audio track a take lands on. */
const AUDIO_TRACK = "gtr";

/** A second audio track, so two lanes can be armed at once. */
const SECOND_AUDIO_TRACK = "vox";

/** The song's one scene. */
const SCENE = "verse";

/** The clips the two lanes place. */
const NOTE_CLIP = "c-bass";
const AUDIO_CLIP = "c-gtr";

/** The placements, and the sections the ruler draws. */
const NOTE_PLACEMENT = "p-notes";
const AUDIO_PLACEMENT = "p-audio";

/** The project the page's own song list names (nothing here lists a project). */
const PROJECT = 61;

/** The sentence a song with tracks but nothing on the timeline gets. */
const EMPTY_PLAN_TEXT =
  "Lanes show the arrangement. Place clips on the timeline to see them here; your scenes still play.";

/** The sentence a song with no audio track gets. */
const ADD_TRACK_TEXT = "Add an audio track and arm it to record.";

// ---- the fixture songs -----------------------------------------------------

/** The document editor's own way in: runCommand throws when a command is refused. */
async function commands() {
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  await import("../bundles/studio/server/commands/core.js");
  await import("../bundles/studio/server/commands/takes.js");
  await import("../bundles/studio/server/commands/arrangement.js");
  return runCommand;
}

/**
 * The song the widget draws: a note track and two audio tracks, one scene, a
 * clip on two of the lanes, two sections and a placement on each of those two.
 * @param {{placements?: boolean, audio?: boolean}} [options] `placements: false`
 *   leaves the arrangement empty; `audio: false` leaves the song with one note
 *   track and no audio track at all
 * @returns {Promise<object>}
 */
async function lanesDoc(options = {}) {
  const { newSongDoc } = await import("../bundles/studio/server/doc.js");
  const runCommand = await commands();
  const doc = newSongDoc({ title: "Record lanes song", bpm: 120 });
  runCommand(doc, "track.add", { id: NOTE_TRACK, name: "Bass" });
  if (options.audio !== false) {
    runCommand(doc, "track.add", { id: AUDIO_TRACK, name: "Guitar", kind: "audio" });
    runCommand(doc, "track.add", { id: SECOND_AUDIO_TRACK, name: "Vocal", kind: "audio" });
  }
  runCommand(doc, "scene.add", { id: SCENE, name: "Verse" });
  runCommand(doc, "clip.write", {
    clip_id: NOTE_CLIP,
    track_id: NOTE_TRACK,
    scene_id: SCENE,
    name: "Bass line",
    length_bars: 2,
    notes: [{ t: 0, d: 1, p: 60, v: 100 }],
  });
  if (options.audio !== false) {
    runCommand(doc, "clip.add_audio", {
      clip_id: AUDIO_CLIP,
      track_id: AUDIO_TRACK,
      scene_id: SCENE,
      length_bars: 2,
      name: "Guitar take",
    });
  }
  if (options.placements === false) return doc;
  runCommand(doc, "section.add", { id: "sec-verse", start_bar: 0, end_bar: 4, name: "Verse" });
  runCommand(doc, "section.add", { id: "sec-chorus", start_bar: 4, end_bar: 8, name: "Chorus" });
  runCommand(doc, "arrangement.place", {
    id: NOTE_PLACEMENT,
    track_id: NOTE_TRACK,
    clip_id: NOTE_CLIP,
    start_bar: 4,
    bars: 4,
  });
  if (options.audio !== false) {
    runCommand(doc, "arrangement.place", {
      id: AUDIO_PLACEMENT,
      track_id: AUDIO_TRACK,
      clip_id: AUDIO_CLIP,
      start_bar: 4,
      bars: 2,
    });
  }
  return doc;
}

// ---- the fake browser ------------------------------------------------------

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

/** A context stand-in: the two nodes the page builds for an arm, and its clock. */
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
 * The engine stand-in: it keeps the listeners the page registered, so a case can
 * report a position or end a take from the engine's side, and it builds one
 * recorder per take.
 */
function fakeEngine() {
  const engine = {
    songs: [],
    positions: [],
    launches: [],
    errors: [],
    recorders: [],
    node: { connect() {} },
    setSong(song) {
      engine.songs.push(song);
    },
    setMode() {},
    seek() {},
    play() {},
    pause() {},
    stop() {},
    stopAll() {},
    launchScene() {},
    monitor() {},
    onPosition(listener) {
      engine.positions.push(listener);
      return () => {};
    },
    onLaunch(listener) {
      engine.launches.push(listener);
      return () => {};
    },
    onError(listener) {
      engine.errors.push(listener);
      return () => {};
    },
    async nextBarFrame() {
      return { frame: 48000, bar: 1 };
    },
    now() {
      return 48000;
    },
    async loadAudio() {},
    unloadAudio() {},
    createRecorder() {
      const recorder = {
        armed: null,
        stopped_at: null,
        splits: [],
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
 * fake browser around it, and hand back what it drew and what it sent.
 * @param {{doc?: object, page?: string}} [options] `page` is left for a
 *   library-page case; the lanes cases all use the song page
 * @returns {Promise<object>}
 */
async function bootLanes(options = {}) {
  const { parseHTML } = await import("linkedom");
  const { pathToFileURL } = await import("node:url");
  const { encodeDocState } = await import("../bundles/studio/server/doc.js");
  const { CLIENT_SCRIPT } = await import("../bundles/studio/panel/client.js");
  const { RECORD_VIEW_SCRIPT } = await import("../bundles/studio/panel/record-view.js");
  const { TAKE_STORE_SCRIPT } = await import("../bundles/studio/panel/take-store.js");

  const doc = options.doc || (await lanesDoc());
  const res = {
    html: "",
    send(body) {
      this.html = String(body);
    },
  };
  await (await import("../bundles/studio/panel/studio.js")).default.handler(
    { query: { song: "song-1" }, headers: {} },
    res,
    { db: panelDb(), layout: minimalLayout },
  );
  assert.ok(res.html.includes('data-studio-song="song-1"'), "the handler rendered the song page");
  assert.ok(
    res.html.includes("StudioRecordView"),
    "the page carries the record view's rules before the client",
  );
  const { document, window: domWindow } = parseHTML(res.html);

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
      return response(200, [{ id: "song-1", project_id: PROJECT, title: "Record lanes song" }]);
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
    addEventListener() {},
    removeEventListener() {},
  };

  // The record view's rules are emitted before the client in the page, and they
  // are run in that order here: the lanes ask them for the two labels.
  new Function("window", RECORD_VIEW_SCRIPT)(windowStub);
  new Function("window", "navigator", TAKE_STORE_SCRIPT)(windowStub, fakeNavigator());
  windowStub.StudioTakeStore = store;

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
  const pushState = async () => {
    frame({
      type: "state",
      update: Buffer.from(encodeDocState(doc)).toString("base64"),
      history: [],
      presence: [],
    });
    await settle();
  };

  await settle();
  await pushState();

  const page = document.querySelector(".studio");
  const host = () => document.querySelector("[data-role=rec-lanes]");
  const lane = (trackId) => document.querySelector(`[data-role=rec-lane][data-track-id=${trackId}]`);
  const click = (selector) => {
    const node = document.querySelector(selector);
    assert.ok(node, `nothing matches ${selector}`);
    node.dispatchEvent(new domWindow.Event("click", { bubbles: true }));
    return node;
  };

  return { document, domWindow, doc, store, engine, sent, page, host, lane, click, settle, frame, pushState };
}

/** Hand the engine one position report, the way the processor does. */
async function reportPosition(ui, position) {
  for (const listener of ui.engine.positions) listener(position);
  await ui.settle();
}

/** @returns {string[]} the commands the page sent, in order. */
function commandsSent(ui, name) {
  return ui.sent
    .filter((message) => message.type === "command" && message.command === name)
    .map((message) => message.args);
}

// ---- the cases -------------------------------------------------------------

test("unarmed lanes show their placements, arm, mute and solo and no meter", async () => {
  const ui = await bootLanes();

  const lanes = [...ui.document.querySelectorAll("[data-role=rec-lane]")];
  assert.deepEqual(
    lanes.map((node) => node.getAttribute("data-track-id")),
    [NOTE_TRACK, AUDIO_TRACK, SECOND_AUDIO_TRACK],
    "one lane per track, in the song's own order",
  );

  for (const trackId of [NOTE_TRACK, AUDIO_TRACK, SECOND_AUDIO_TRACK]) {
    const node = ui.lane(trackId);
    assert.ok(node.querySelector("[data-act=arm-audio]"), `${trackId} offers Arm`);
    assert.ok(node.querySelector("[data-act=mute]"), `${trackId} offers Mute`);
    assert.ok(node.querySelector("[data-act=solo]"), `${trackId} offers Solo`);
  }
  assert.equal(
    ui.lane(NOTE_TRACK).querySelector("[data-act=arm-audio]").disabled,
    true,
    "a note track cannot be armed",
  );
  assert.equal(ui.lane(AUDIO_TRACK).querySelector("[data-act=arm-audio]").disabled, false, "an audio track can");

  const block = ui.lane(AUDIO_TRACK).querySelector(`[data-placement-id=${AUDIO_PLACEMENT}]`);
  assert.ok(block, "the audio lane shows the clip the arrangement places on it");
  assert.equal(block.textContent, "Guitar take", "named the way the clip is named");
  assert.ok(
    ui.lane(NOTE_TRACK).querySelector(`[data-placement-id=${NOTE_PLACEMENT}]`),
    "and the note lane shows its own placement",
  );
  assert.equal(
    ui.lane(SECOND_AUDIO_TRACK).querySelectorAll("[data-role=rec-block]").length,
    0,
    "a lane with nothing placed on it is an empty lane",
  );

  // Nothing is armed, so nothing is a target and no meter is drawn anywhere:
  // the meter and the live waveform are A4b's.
  assert.equal(ui.document.querySelectorAll("[data-role=rec-armed]").length, 0);
  assert.equal(ui.document.querySelectorAll("[data-role=rec-meter]").length, 0, "one meter only, and not yet");
  assert.equal(ui.lane(AUDIO_TRACK).getAttribute("class").includes("st-rec-lane-target"), false);

  // Mute and solo are the mixer's own commands, sent from this lane.
  ui.click(`[data-role=rec-lane][data-track-id=${AUDIO_TRACK}] [data-act=mute]`);
  await ui.settle();
  assert.deepEqual(commandsSent(ui, "track.set_mix"), [{ track_id: AUDIO_TRACK, mute: true }], "M mutes the track");
  ui.click(`[data-role=rec-lane][data-track-id=${AUDIO_TRACK}] [data-act=solo]`);
  await ui.settle();
  assert.deepEqual(
    commandsSent(ui, "track.set_mix")[1],
    { track_id: AUDIO_TRACK, solo: true },
    "S solos it",
  );
});

test("the ruler shows section bands and the playhead", async () => {
  const ui = await bootLanes();

  const bands = [...ui.document.querySelectorAll("[data-role=rec-section]")];
  assert.equal(bands.length, 2, "one band per section of the arrangement");
  assert.deepEqual(bands.map((node) => node.textContent), ["Verse", "Chorus"]);
  assert.equal(bands[0].getAttribute("data-section-id"), "sec-verse");
  assert.equal(bands[0].style.left, "0%", "the first section starts on bar 1");
  assert.equal(bands[0].style.width, "12.5%", "and spans four of the ruler's thirty-two bars");
  assert.equal(bands[1].style.left, "12.5%", "the second starts where the first ends");

  const numbers = [...ui.document.querySelectorAll("[data-role=rec-bar-ruler] .st-rec-bar-n")];
  assert.equal(numbers.length, 32, "the ruler numbers every bar of the timeline's own count");
  assert.equal(numbers[0].textContent, "1");

  // A render draws the ruler again (Play is one), so the line is looked up
  // again after it: the widget keeps no node of its own.
  const head = () => ui.document.querySelector("[data-role=rec-playhead]");
  assert.ok(head(), "the ruler carries one playhead");
  assert.equal(head().style.left, "0%", "which starts at bar 1");

  // The playhead follows the TRANSPORT: Play brings the engine up, and its
  // position reports are what move the line.
  ui.click("[data-act=play]");
  await ui.settle(24);
  assert.equal(ui.engine.positions.length > 0, true, "the transport reports its position");

  await reportPosition(ui, { bar: 5, beat: 1, sixteenth: 1 });
  assert.equal(head().style.left, "12.5%", "the position report moves it to bar 5");

  await reportPosition(ui, { bar: 9, beat: 3, sixteenth: 1 });
  assert.equal(head().style.left, "26.563%", "and into a bar: bar 9 and a half of thirty-two");

  // A render draws the ruler again and the playhead is already where the
  // transport is, not back at the top.
  await ui.pushState();
  assert.equal(ui.document.querySelectorAll("[data-role=rec-playhead]").length, 1, "still exactly one playhead");
  assert.equal(
    ui.document.querySelector("[data-role=rec-playhead]").style.left,
    "26.563%",
    "a redrawn ruler keeps the playhead on the transport's bar",
  );
});

test("a session-only song (scenes, no placements) shows empty lanes and the arrangement note", async () => {
  const ui = await bootLanes({ doc: await lanesDoc({ placements: false }) });

  const lanes = [...ui.document.querySelectorAll("[data-role=rec-lane]")];
  assert.equal(lanes.length, 3, "every track still has its lane");
  assert.equal(
    ui.document.querySelectorAll("[data-role=rec-block]").length,
    0,
    "and no lane carries a block, because nothing is placed on the timeline",
  );
  const note = ui.document.querySelector("[data-role=rec-note-empty-plan]");
  assert.ok(note, "the widget says why its lanes are empty");
  assert.equal(note.textContent, EMPTY_PLAN_TEXT, "in the plan's own words");
  assert.equal(ui.document.querySelector("[data-role=rec-note-add-track]"), null, "there is an audio track");
});

test("the widget shows its add-a-track note on a song with no audio track", async () => {
  const ui = await bootLanes({ doc: await lanesDoc({ audio: false }) });

  const note = ui.document.querySelector("[data-role=rec-note-add-track]");
  assert.ok(note, "the widget says what it needs");
  assert.equal(note.textContent, ADD_TRACK_TEXT);
  assert.equal(
    ui.document.querySelector("[data-role=rec-note-empty-plan]"),
    null,
    "one sentence at a time: the missing audio track is the one that matters",
  );
  assert.ok(ui.lane(NOTE_TRACK), "the note track still has its lane");
  assert.equal(ui.document.querySelector("[data-role=rec-lane]").getAttribute("data-track-id"), NOTE_TRACK);
});

test("an audio track removed mid-take does not throw (the lane disappears, rec keeps its own state)", async () => {
  const ui = await bootLanes();

  ui.click(`[data-role=rec-lane][data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await ui.settle();
  ui.click("[data-act=record]");
  await ui.settle(24);
  const recorder = ui.engine.recorders[ui.engine.recorders.length - 1];
  assert.ok(recorder, "the page built a recorder");
  for (const listener of ui.engine.launches) {
    listener({ track_id: AUDIO_TRACK, clip_id: null, scene_id: SCENE, bar: 0, frame: 48000 });
  }
  await ui.settle();
  const status = ui.document.querySelector("[data-role=rec-status]");
  assert.equal(status.getAttribute("data-recording"), "1", "the take is running");

  // The track goes away under the take, the way another view or the agent can
  // take it away: the lane is simply not drawn, and the recording is this
  // page's own state and stays where it is until Stop.
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  runCommand(ui.doc, "track.remove", { track_id: AUDIO_TRACK });
  const { encodeDocState } = await import("../bundles/studio/server/doc.js");
  assert.doesNotThrow(() => {
    ui.frame({
      type: "state",
      update: Buffer.from(encodeDocState(ui.doc)).toString("base64"),
      history: [],
      presence: [],
    });
  }, "a lane whose track went away is not an error");
  await ui.settle();

  assert.equal(ui.lane(AUDIO_TRACK), null, "the lane is gone");
  assert.ok(ui.lane(SECOND_AUDIO_TRACK), "the other lanes are still drawn");
  assert.equal(
    ui.document.querySelector("[data-role=rec-status]").getAttribute("data-recording"),
    "1",
    "the take keeps its own state",
  );
});

test("the record target lane is tall and red and other armed lanes read Armed", async () => {
  const ui = await bootLanes();

  ui.click(`[data-role=rec-lane][data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await ui.settle(24);
  ui.click(`[data-role=rec-lane][data-track-id=${SECOND_AUDIO_TRACK}] [data-act=arm-audio]`);
  await ui.settle(24);

  const targetLane = ui.lane(AUDIO_TRACK);
  const otherLane = ui.lane(SECOND_AUDIO_TRACK);
  assert.equal(
    String(targetLane.getAttribute("class")).includes("st-rec-lane-target"),
    true,
    "the first armed audio track is the record target, drawn as such",
  );
  assert.equal(
    String(otherLane.getAttribute("class")).includes("st-rec-lane-target"),
    false,
    "a second armed track is not the target",
  );

  const targetChip = targetLane.querySelector("[data-role=rec-armed]");
  const otherChip = otherLane.querySelector("[data-role=rec-armed]");
  assert.ok(targetChip, "the target lane says Armed");
  assert.equal(targetChip.textContent, "Armed");
  assert.ok(otherChip, "so does every other armed lane");
  assert.equal(otherChip.textContent, "Armed", "and it says nothing else: the meter and waveform are the target's");

  assert.ok(
    targetLane.querySelector("[data-role=rec-target-info]"),
    "the target lane names where it listens and what it hears",
  );
  assert.equal(otherLane.querySelector("[data-role=rec-target-info]"), null);
  assert.equal(
    targetLane.querySelector("[data-role=rec-source]").textContent,
    "Test input \u00b7 stereo",
    "the input's own name and the channel count by name",
  );
  assert.equal(
    ui.lane(NOTE_TRACK).querySelector("[data-role=rec-armed]"),
    null,
    "a lane that cannot be armed never reads Armed",
  );
  assert.equal(ui.document.querySelectorAll("[data-role=rec-meter]").length, 0, "no meter is drawn here");
});