/**
 * Studio commands: the 1a registry, its schemas, its refusals, and the
 * before/after maps the shared history and its undo are built on.
 *
 * Every test builds its own document in memory, so nothing here touches a
 * database or a running instance.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LIMITS,
  TRACK_COLORS,
  applyBeforeAfter,
  newSongDoc,
  readField,
  snapshot,
} from "../bundles/studio/server/doc.js";
import {
  StudioError,
  applyCommand,
  getCommand,
  listCommands,
  prepareCommand,
  runCommand,
} from "../bundles/studio/server/commands/registry.js";
import "../bundles/studio/server/commands/core.js";
import "../bundles/studio/server/commands/takes.js";
import "../bundles/studio/server/commands/arrangement.js";
import "../bundles/studio/server/commands/sampler.js";

/** A take id, the way the recording client generates one. */
const TAKE_ID = "6f1c1f7a-8f7e-4a4e-9a1d-2b3c4d5e6f70";

/** A second take id, for the comp cases. */
const OTHER_TAKE_ID = "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d";

/** A sample id, the way the recording or import client generates one. */
const SAMPLE_ID = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";

/** The sample object `sample.add` accepts, as the gateway builds it. */
const SAMPLE_ARGS = {
  storage_key: `studio/song-1/samples/${SAMPLE_ID}.wav`,
  rate: 48000,
  channels: 2,
  frames: 48000,
  name: "Drum loop",
  origin: "import",
  author_label: "the operator",
};

/** The take object `take.add` accepts, as the gateway builds it. */
const TAKE_ARGS = {
  storage_key: `studio/song-1/takes/${TAKE_ID}.wav`,
  rate: 48000,
  channels: 2,
  frames: 48000,
  offset_frames: 0,
  compensated: false,
  bpm: 120,
  recorded_at: "2026-11-02T12:00:00.000Z",
  author_label: "the operator",
  discarded: false,
};

/** Every registered command: the contract the GUI, the MCP tools and history share. */
const COMMAND_IDS = [
  "arrangement.move",
  "arrangement.place",
  "arrangement.record_performance",
  "arrangement.remove",
  "arrangement.resize",
  "arrangement.set_fades",
  "arrangement.split",
  "bank.add",
  "bank.rename",
  "chain.set",
  "clip.add_audio",
  "clip.add_pattern",
  "clip.edit_notes",
  "clip.remove",
  "clip.rename",
  "clip.set_comp",
  "clip.set_length",
  "clip.write",
  "marker.add",
  "marker.remove",
  "marker.rename",
  "pad.assign",
  "pad.assign_if_empty",
  "pad.clear",
  "pad.set",
  "pattern.add",
  "pattern.remove",
  "pattern.rename",
  "pattern.set_length",
  "pattern.set_steps_beat",
  "pattern.set_swing",
  "sample.add",
  "sample.rename",
  "scene.add",
  "scene.remove",
  "scene.rename",
  "section.add",
  "section.remove",
  "section.set",
  "slice.set",
  "song.set_meta",
  "step.clear_locks",
  "step.set",
  "step.toggle",
  "take.add",
  "take.discard",
  "take.keep",
  "take.restore",
  "take.set_offset",
  "track.add",
  "track.lock",
  "track.remove",
  "track.rename",
  "track.set_device",
  "track.set_mix",
  "track.set_param",
  "track.unlock",
];

/** The smallest valid argument object for each command. */
const MINIMAL_ARGS = {
  "song.set_meta": { bpm: 120 },
  "track.add": { name: "Bass" },
  "track.remove": { track_id: "t1" },
  "track.rename": { track_id: "t1", name: "Bass" },
  "track.set_device": { track_id: "t1", type: "Analog generator" },
  "track.set_param": { track_id: "t1", name: "Cutoff", value: 40 },
  "track.set_mix": { track_id: "t1", gain_db: -3 },
  "track.lock": { track_id: "t1" },
  "track.unlock": { track_id: "t1" },
  "scene.add": { name: "Verse" },
  "scene.rename": { scene_id: "s1", name: "Verse" },
  "scene.remove": { scene_id: "s1" },
  "clip.write": { track_id: "t1", scene_id: "s1", name: "Verse bass", notes: [] },
  "clip.edit_notes": { clip_id: "c1", remove: [0] },
  "clip.set_length": { clip_id: "c1", length_bars: 4 },
  "clip.rename": { clip_id: "c1", name: "Verse bass" },
  "clip.remove": { clip_id: "c1" },
  "clip.add_audio": { track_id: "t1", scene_id: "s1", length_bars: 4 },
  "clip.set_comp": { clip_id: "c1", segments: [] },
  "take.add": { clip_id: "c1", take: { id: TAKE_ID, ...TAKE_ARGS } },
  "take.discard": { clip_id: "c1", take_id: TAKE_ID },
  "take.restore": { clip_id: "c1", take_id: TAKE_ID },
  "take.keep": { clip_id: "c1", take_id: TAKE_ID },
  "take.set_offset": { clip_id: "c1", take_id: TAKE_ID, offset_frames: 960, compensated: true },
  "arrangement.place": { track_id: "t1", clip_id: "c1", start_bar: 0 },
  "arrangement.move": { id: "p1", start_bar: 4 },
  "arrangement.resize": { id: "p1", bars: 2 },
  "arrangement.split": { id: "p1", at_bar: 1 },
  "arrangement.set_fades": { id: "p1", fade_in_beats: 0.5, fade_out_beats: 0.5 },
  "arrangement.remove": { id: "p1" },
  "arrangement.record_performance": {
    placements: [{ track_id: "t1", clip_id: "c1", start_bar: 0, bars: 2 }],
  },
  "marker.add": { bar: 4, name: "Bridge" },
  "marker.rename": { id: "m1", name: "Bridge" },
  "marker.remove": { id: "m1" },
  "section.add": { start_bar: 0, end_bar: 8, name: "Verse" },
  "section.set": { id: "s1", name: "Intro" },
  "section.remove": { id: "s1" },
  "bank.add": { track_id: "t1" },
  "bank.rename": { track_id: "t1", bank_id: "b1", name: "A" },
  "pad.set": { track_id: "t1", bank_id: "b1", index: 0, fields: { gain_db: 0 } },
  "pad.assign": { track_id: "t1", bank_id: "b1", index: 0, sample_id: SAMPLE_ID },
  // The operator's own way to empty a pad: no MCP tool, one GUI button.
  "pad.clear": { track_id: "t1", bank_id: "b1", index: 0 },
  // Studio's own empty-only twin: the same arguments, a check that the pad is
  // still free made inside the hub's queue.
  "pad.assign_if_empty": { track_id: "t1", bank_id: "b1", index: 0, sample_id: SAMPLE_ID },
  "sample.add": { sample: { id: SAMPLE_ID, ...SAMPLE_ARGS } },
  "sample.rename": { sample_id: SAMPLE_ID, name: "Loop A" },
  "slice.set": { sample_id: SAMPLE_ID, slices: [{ start_frame: 0, end_frame: 100 }] },
  "pattern.add": { clip_id: "c1" },
  "pattern.rename": { clip_id: "c1", pattern_id: "p1", name: "A" },
  "pattern.remove": { clip_id: "c1", pattern_id: "p1" },
  "pattern.set_length": { clip_id: "c1", length_steps: 16 },
  "pattern.set_steps_beat": { clip_id: "c1", step_beats: 0.25 },
  "pattern.set_swing": { clip_id: "c1", swing: 0 },
  "step.toggle": { clip_id: "c1", pattern_id: "p1", at: 0, bank_id: "b1", index: 0 },
  "step.set": { clip_id: "c1", pattern_id: "p1", at: 0, bank_id: "b1", index: 0, v: 100 },
  "step.clear_locks": { clip_id: "c1", pattern_id: "p1", at: 0, bank_id: "b1", index: 0 },
  "chain.set": { clip_id: "c1", chain: [] },
  "clip.add_pattern": { track_id: "t1", scene_id: "s1" },
};

/** A song document that is destroyed when the test ends. */
function scratchDoc(t) {
  const doc = newSongDoc({ title: "Test song" });
  t.after(() => doc.destroy());
  return doc;
}

/** Add a track and return its id. */
function addTrack(doc, name, extra = {}) {
  return runCommand(doc, "track.add", { name, ...extra }).args.id;
}

/** Add a scene and return its id. */
function addScene(doc, name) {
  return runCommand(doc, "scene.add", { name }).args.id;
}

/** Write a clip and return the whole command result. */
function writeClip(doc, args) {
  return runCommand(doc, "clip.write", args);
}

/** @returns {string} the object ref a before/after key belongs to. */
function refOf(key) {
  return key.slice(0, key.lastIndexOf("|"));
}

/** @returns {{t: number, d: number, p: number, v: number}} a note. */
function note(t, d, p, v) {
  return { t, d, p, v };
}

/**
 * Overwrite every value inside `value` in place, recursively — used to show
 * that a command's before/after/args are copies rather than references into
 * the document.
 * @param {any} value
 */
function scribble(value) {
  if (Array.isArray(value)) {
    for (const item of value) scribble(item);
    value.push("scribbled");
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const key of Object.keys(value)) {
    const item = value[key];
    if (typeof item === "string") value[key] = `${item} scribbled`;
    else if (typeof item === "number") value[key] = item + 1000;
    else if (typeof item === "boolean") value[key] = !item;
    else scribble(item);
  }
  value.scribbled = true;
}

/** Assert that `fn` throws a StudioError with this code, and return it. */
function refuses(fn, code) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof StudioError, `expected a StudioError, got ${error}`);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`expected a refusal with code "${code}", but the call succeeded`);
}

test("the registry lists every command", () => {
  assert.deepEqual(
    listCommands().map((command) => command.id),
    COMMAND_IDS,
  );
  assert.deepEqual(Object.keys(MINIMAL_ARGS).sort(), COMMAND_IDS);
  assert.equal(getCommand("clip.write").humanOnly, false);
  assert.equal(getCommand("track.lock").humanOnly, true);
  assert.equal(getCommand("track.unlock").humanOnly, true);
  assert.equal(getCommand("take.discard").humanOnly, true);
  // Emptying a pad is the operator's alone, like a track's lock.
  assert.equal(getCommand("pad.clear").humanOnly, true);
  // A take only ever arrives through the gateway's upload finish route.
  assert.equal(getCommand("take.add").internal, true);
  // And a sample only ever arrives through the same finish route.
  assert.equal(getCommand("sample.add").internal, true);
  assert.equal(getCommand("clip.write").internal, false);
  assert.deepEqual(
    listCommands({ public: true }).map((command) => command.id),
    COMMAND_IDS.filter(
      (id) => id !== "take.add" && id !== "sample.add" && id !== "pad.assign_if_empty",
    ),
    "the public list is the rest: the upload finish route's own commands are not in it",
  );
  assert.equal(refuses(() => getCommand("clip.explode"), "not_found").code, "not_found");
});

test("every command schema rejects unknown fields", () => {
  for (const command of listCommands()) {
    const valid = command.schema.safeParse(MINIMAL_ARGS[command.id]);
    assert.equal(valid.success, true, `${command.id} rejected its minimal arguments: ${valid.error}`);

    const extra = command.schema.safeParse({ ...MINIMAL_ARGS[command.id], not_a_field: 1 });
    assert.equal(extra.success, false, `${command.id} accepted an unknown field`);
    assert.ok(
      extra.error.issues.some((issue) => issue.code === "unrecognized_keys"),
      `${command.id} rejected the unknown field for the wrong reason: ${extra.error}`,
    );
  }
});

test("track.add refuses a 17th track", (t) => {
  const doc = scratchDoc(t);
  for (let index = 0; index < LIMITS.tracks; index += 1) addTrack(doc, `Track ${index + 1}`);
  const before = snapshot(doc);
  let updates = 0;
  const onUpdate = () => {
    updates += 1;
  };
  doc.on("update", onUpdate);

  const error = refuses(() => addTrack(doc, "Seventeen"), "limit");
  assert.match(error.message, /16 tracks/);
  assert.equal(updates, 0);
  assert.deepEqual(snapshot(doc), before);
});

test("clip.write over 4096 notes is refused and leaves the doc unchanged", (t) => {
  const doc = scratchDoc(t);
  const track = addTrack(doc, "Bass");
  const scene = addScene(doc, "Verse");
  const notes = Array.from({ length: LIMITS.notesPerClip + 1 }, (_, index) =>
    note((index % 4) * 0.25, 0.25, 60, 100));
  const before = snapshot(doc);
  let updates = 0;
  const onUpdate = () => {
    updates += 1;
  };
  doc.on("update", onUpdate);

  const error = refuses(
    () => writeClip(doc, { track_id: track, scene_id: scene, name: "Huge", notes }),
    "limit",
  );
  assert.match(error.message, /4096 notes/);
  assert.equal(updates, 0);
  assert.deepEqual(snapshot(doc), before);
});

test("clip.write stores notes and summary names track and scene", (t) => {
  const doc = scratchDoc(t);
  const track = addTrack(doc, "Bass");
  const scene = addScene(doc, "Verse");
  const notes = [note(0, 1, 36, 100), note(1.5, 0.5, 43, 90)];

  const written = writeClip(doc, { track_id: track, scene_id: scene, name: "Verse bass", length_bars: 8, notes });
  assert.equal(written.summary, 'Wrote "Verse bass" (8 bars) on Bass, Verse');

  const clip = snapshot(doc).clips[written.args.clip_id];
  assert.equal(clip.track_id, track);
  assert.equal(clip.scene_id, scene);
  assert.equal(clip.name, "Verse bass");
  assert.equal(clip.length_bars, 8);
  assert.deepEqual(clip.notes, notes);

  // Writing the same clip id again replaces its notes, it does not pile up clips.
  const rewritten = writeClip(doc, {
    clip_id: written.args.clip_id,
    track_id: track,
    scene_id: scene,
    name: "Verse bass",
    length_bars: 2,
    notes: [note(0, 2, 36, 110)],
  });
  assert.equal(rewritten.summary, 'Wrote "Verse bass" (2 bars) on Bass, Verse');
  assert.equal(Object.keys(snapshot(doc).clips).length, 1);
  assert.deepEqual(snapshot(doc).clips[written.args.clip_id].notes, [note(0, 2, 36, 110)]);

  // A clip's length follows its notes when the caller does not name one.
  const long = writeClip(doc, {
    track_id: track,
    scene_id: scene,
    name: "Long bass",
    notes: [note(0, 1, 36, 100), note(8, 0.5, 36, 100)],
  });
  assert.equal(snapshot(doc).clips[long.args.clip_id].length_bars, 3);
  assert.equal(long.summary, 'Wrote "Long bass" (3 bars) on Bass, Verse');
});

test("track.remove also removes its clips and before/after captures them", (t) => {
  const doc = scratchDoc(t);
  const track = addTrack(doc, "Bass", { gain_db: -3 });
  const verse = addScene(doc, "Verse");
  const chorus = addScene(doc, "Chorus");
  const firstNotes = [note(0, 1, 36, 100), note(1, 1, 38, 100)];
  const first = writeClip(doc, { track_id: track, scene_id: verse, name: "Verse bass", length_bars: 1, notes: firstNotes });
  const second = writeClip(doc, { track_id: track, scene_id: chorus, name: "Chorus bass", length_bars: 1, notes: [note(0, 1, 41, 100)] });

  const removed = runCommand(doc, "track.remove", { track_id: track });
  assert.equal(removed.summary, 'Removed track "Bass" and its 2 clips');

  const goneTrack = removed.before[`track:${track}|*`];
  assert.equal(goneTrack.id, track);
  assert.equal(goneTrack.name, "Bass");
  assert.equal(goneTrack.gain_db, -3);
  assert.equal(goneTrack._index, 0);
  assert.strictEqual(removed.after[`track:${track}|*`], null);

  assert.deepEqual(removed.before[`clip:${first.args.clip_id}|*`].notes, firstNotes);
  assert.equal(removed.before[`clip:${first.args.clip_id}|*`].length_bars, 1);
  assert.strictEqual(removed.after[`clip:${first.args.clip_id}|*`], null);
  assert.strictEqual(removed.after[`clip:${second.args.clip_id}|*`], null);
  assert.ok(`clip:${second.args.clip_id}|*` in removed.before);
  assert.deepEqual(
    [...removed.touched].sort(),
    [`clip:${first.args.clip_id}`, `clip:${second.args.clip_id}`, `track:${track}`].sort(),
  );

  const snap = snapshot(doc);
  assert.deepEqual(snap.tracks, []);
  assert.deepEqual(snap.clips, {});
});

test("apply returns before/after for every touched field", (t) => {
  const doc = scratchDoc(t);
  const track = addTrack(doc, "Bass");
  const scene = addScene(doc, "Verse");
  const clip = writeClip(doc, {
    track_id: track,
    scene_id: scene,
    name: "Verse bass",
    length_bars: 2,
    notes: [note(0, 1, 36, 100)],
  });
  const clipId = clip.args.clip_id;
  const chorus = addScene(doc, "Chorus");

  const tr = `track:${track}`;
  const cl = `clip:${clipId}`;

  // A track that plays recordings and the clip a take lands on, for the 1b
  // take commands below.
  const audioTrack = addTrack(doc, "Guitar", { kind: "audio" });
  const au = "clip:gtr-verse";

  // A sampler track, its kit and a pattern clip, for the 1c sampler commands
  // below. The kit's bank is found from the snapshot, because the track makes
  // it; the pads it holds are then known by index.
  const kitTrack = addTrack(doc, "Kit", { kind: "sampler" });
  const kitBank = Object.values(snapshot(doc).banks).find((bank) => bank.track_id === kitTrack).id;
  const padOf = (bankId, index) => `pad:${kitTrack}/${bankId}/${index}`;
  const bankOf = (bankId) => `bank:${kitTrack}/${bankId}`;
  const kitPads = (bankId) =>
    Array.from({ length: 16 }, (_, index) => `${padOf(bankId, index)}|*`);

  // Every command, in the order they can run, with the exact key set its
  // before and after maps must carry.
  const cases = [
    { id: "song.set_meta", args: { bpm: 96 }, keys: ["song:meta|bpm"] },
    { id: "track.add", args: { name: "Drums", id: "drums" }, keys: ["track:drums|*"] },
    { id: "track.rename", args: { track_id: track, name: "Bass DI" }, keys: [`${tr}|name`] },
    {
      id: "track.set_mix",
      args: { track_id: track, gain_db: -3, pan: -0.5 },
      keys: [`${tr}|gain_db`, `${tr}|pan`],
    },
    { id: "track.set_device", args: { track_id: track, type: "SpectraVoice" }, keys: [`${tr}|device`] },
    {
      id: "track.set_param",
      args: { track_id: track, name: "Cutoff", value: 40 },
      keys: [`${tr}|device.params.Cutoff`],
    },
    { id: "track.lock", args: { track_id: track }, keys: [`${tr}|locked`] },
    { id: "track.unlock", args: { track_id: track }, keys: [`${tr}|locked`] },
    { id: "scene.add", args: { name: "Bridge", id: "bridge" }, keys: ["scene:bridge|*"] },
    { id: "scene.rename", args: { scene_id: scene, name: "Intro" }, keys: [`scene:${scene}|name`] },
    {
      id: "clip.write",
      args: {
        clip_id: clipId,
        track_id: track,
        scene_id: scene,
        name: "Verse bass",
        length_bars: 2,
        notes: [note(0, 1, 36, 100)],
      },
      keys: [`${cl}|name`, `${cl}|length_bars`, `${cl}|notes`],
    },
    { id: "clip.set_length", args: { clip_id: clipId, length_bars: 8 }, keys: [`${cl}|length_bars`] },
    { id: "clip.rename", args: { clip_id: clipId, name: "Verse bass 2" }, keys: [`${cl}|name`] },
    { id: "clip.edit_notes", args: { clip_id: clipId, add: [note(2, 1, 43, 90)] }, keys: [`${cl}|notes`] },
    // The take commands, in the order a recording runs: the clip, its takes,
    // the comp, and the discard/restore pair.
    {
      id: "clip.add_audio",
      args: { clip_id: "gtr-verse", track_id: audioTrack, scene_id: scene, length_bars: 2, name: "Guitar take" },
      keys: [`${au}|*`],
    },
    {
      id: "take.add",
      args: { clip_id: "gtr-verse", take: { id: TAKE_ID, ...TAKE_ARGS } },
      keys: [`${au}|comp`, `take:${TAKE_ID}|*`],
    },
    {
      id: "take.add",
      args: { clip_id: "gtr-verse", take: { id: OTHER_TAKE_ID, ...TAKE_ARGS } },
      keys: [`take:${OTHER_TAKE_ID}|*`],
    },
    {
      id: "take.set_offset",
      args: { clip_id: "gtr-verse", take_id: TAKE_ID, offset_frames: 960, compensated: true },
      keys: [`take:${TAKE_ID}|compensated`, `take:${TAKE_ID}|offset_frames`],
    },
    {
      id: "take.keep",
      args: { clip_id: "gtr-verse", take_id: OTHER_TAKE_ID },
      keys: [`${au}|comp`],
    },
    {
      id: "clip.set_comp",
      args: {
        clip_id: "gtr-verse",
        segments: [
          { take_id: TAKE_ID, from_beat: 0, to_beat: 4 },
          { take_id: OTHER_TAKE_ID, from_beat: 4, to_beat: 8 },
        ],
      },
      keys: [`${au}|comp`],
    },
    {
      id: "take.discard",
      args: { clip_id: "gtr-verse", take_id: OTHER_TAKE_ID },
      keys: [`${au}|comp`, `take:${OTHER_TAKE_ID}|discarded`],
    },
    {
      id: "take.restore",
      args: { clip_id: "gtr-verse", take_id: OTHER_TAKE_ID },
      keys: [`take:${OTHER_TAKE_ID}|discarded`],
    },
    // The timeline commands: one placement that is moved, resized, split,
    // faded and removed again, a performance written in one step, and a marker
    // and a section that come and go.
    {
      id: "arrangement.place",
      args: { id: "gtr-p1", track_id: audioTrack, clip_id: "gtr-verse", start_bar: 0 },
      keys: ["placement:gtr-p1|*"],
    },
    {
      id: "arrangement.move",
      args: { id: "gtr-p1", start_bar: 4 },
      keys: ["placement:gtr-p1|start_bar"],
    },
    {
      id: "arrangement.resize",
      args: { id: "gtr-p1", bars: 4 },
      keys: ["placement:gtr-p1|bars"],
    },
    {
      id: "arrangement.split",
      args: { id: "gtr-p1", at_bar: 6, new_id: "gtr-p1b" },
      keys: ["placement:gtr-p1|bars", "placement:gtr-p1b|*"],
    },
    {
      id: "arrangement.set_fades",
      args: { id: "gtr-p1b", fade_in_beats: 1, fade_out_beats: 1 },
      keys: ["placement:gtr-p1b|fade_in_beats", "placement:gtr-p1b|fade_out_beats"],
    },
    { id: "arrangement.remove", args: { id: "gtr-p1b" }, keys: ["placement:gtr-p1b|*"] },
    {
      id: "arrangement.record_performance",
      args: {
        placements: [
          { id: "gtr-p3", track_id: audioTrack, clip_id: "gtr-verse", start_bar: 20, bars: 2 },
        ],
      },
      keys: ["placement:gtr-p3|*"],
    },
    {
      id: "marker.add",
      args: { id: "m-intro", bar: 8, name: "Verse" },
      keys: ["marker:m-intro|*"],
    },
    { id: "marker.rename", args: { id: "m-intro", name: "Intro" }, keys: ["marker:m-intro|name"] },
    { id: "marker.remove", args: { id: "m-intro" }, keys: ["marker:m-intro|*"] },
    {
      id: "section.add",
      args: { id: "sec-verse", start_bar: 0, end_bar: 8, name: "Verse" },
      keys: ["section:sec-verse|*"],
    },
    { id: "section.set", args: { id: "sec-verse", name: "Intro" }, keys: ["section:sec-verse|name"] },
    { id: "section.remove", args: { id: "sec-verse" }, keys: ["section:sec-verse|*"] },
    // The sampler commands: a second bank, a sample chopped into two slices and
    // put on a pad, a pattern clip with two patterns, a step with a lock, and
    // the chain that loops them.
    {
      id: "bank.add",
      args: { id: "kit-b", track_id: kitTrack, name: "Beats" },
      keys: [`${bankOf("kit-b")}|*`, ...kitPads("kit-b")],
    },
    {
      id: "bank.rename",
      args: { track_id: kitTrack, bank_id: "kit-b", name: "Hits" },
      keys: [`${bankOf("kit-b")}|name`],
    },
    {
      id: "sample.add",
      args: { sample: { id: SAMPLE_ID, ...SAMPLE_ARGS } },
      keys: [`sample:${SAMPLE_ID}|*`],
    },
    {
      id: "sample.rename",
      args: { sample_id: SAMPLE_ID, name: "Loop A" },
      keys: [`sample:${SAMPLE_ID}|name`],
    },
    {
      id: "slice.set",
      args: {
        sample_id: SAMPLE_ID,
        slices: [
          { id: "s1", start_frame: 0, end_frame: 12000 },
          { id: "s2", start_frame: 12000, end_frame: 24000 },
        ],
      },
      keys: [`slice:${SAMPLE_ID}/s1|*`, `slice:${SAMPLE_ID}/s2|*`],
    },
    {
      id: "pad.assign",
      args: { track_id: kitTrack, bank_id: "kit-b", index: 0, sample_id: SAMPLE_ID, slice_id: "s1" },
      keys: [`${padOf("kit-b", 0)}|sample_id`, `${padOf("kit-b", 0)}|slice_id`],
    },
    {
      id: "pad.assign_if_empty",
      args: { track_id: kitTrack, bank_id: "kit-b", index: 5, sample_id: SAMPLE_ID, slice_id: "s1" },
      keys: [`${padOf("kit-b", 5)}|sample_id`, `${padOf("kit-b", 5)}|slice_id`],
    },
    {
      id: "pad.clear",
      args: { track_id: kitTrack, bank_id: "kit-b", index: 5 },
      keys: [`${padOf("kit-b", 5)}|sample_id`, `${padOf("kit-b", 5)}|slice_id`],
    },
    {
      id: "pad.set",
      args: {
        track_id: kitTrack,
        bank_id: "kit-b",
        index: 0,
        fields: { gain_db: -6, filter: { type: "lp", cutoff_hz: 4000, resonance: 0.2 } },
      },
      keys: [`${padOf("kit-b", 0)}|gain_db`, `${padOf("kit-b", 0)}|filter`],
    },
    {
      id: "clip.add_pattern",
      args: { clip_id: "kit-clip", track_id: kitTrack, scene_id: scene, length_steps: 16, name: "Kit loop" },
      keys: ["clip:kit-clip|*", "pattern:kit-clip/a|*"],
    },
    { id: "pattern.add", args: { clip_id: "kit-clip", id: "pb", name: "B" }, keys: ["pattern:kit-clip/pb|*"] },
    {
      id: "pattern.rename",
      args: { clip_id: "kit-clip", pattern_id: "pb", name: "Fill" },
      keys: ["pattern:kit-clip/pb|name"],
    },
    {
      id: "pattern.set_steps_beat",
      args: { clip_id: "kit-clip", step_beats: 0.5 },
      keys: ["clip:kit-clip|step_beats", "clip:kit-clip|length_bars"],
    },
    { id: "pattern.set_swing", args: { clip_id: "kit-clip", swing: 0.5 }, keys: ["clip:kit-clip|swing"] },
    {
      id: "pattern.set_length",
      args: { clip_id: "kit-clip", length_steps: 8 },
      keys: ["clip:kit-clip|length_steps", "clip:kit-clip|length_bars"],
    },
    {
      id: "step.toggle",
      args: { clip_id: "kit-clip", pattern_id: "a", at: 0, bank_id: "kit-b", index: 0, v: 110 },
      keys: ["step:kit-clip/a/0/kit-b.0|*"],
    },
    {
      id: "step.set",
      args: {
        clip_id: "kit-clip",
        pattern_id: "a",
        at: 0,
        bank_id: "kit-b",
        index: 0,
        locks: { cutoff_hz: 900 },
      },
      keys: ["step:kit-clip/a/0/kit-b.0|locks.cutoff_hz"],
    },
    {
      id: "step.clear_locks",
      args: { clip_id: "kit-clip", pattern_id: "a", at: 0, bank_id: "kit-b", index: 0 },
      keys: ["step:kit-clip/a/0/kit-b.0|locks.cutoff_hz"],
    },
    {
      id: "chain.set",
      args: { clip_id: "kit-clip", chain: ["a", "pb"] },
      keys: ["clip:kit-clip|chain"],
    },
    {
      id: "pattern.remove",
      args: { clip_id: "kit-clip", pattern_id: "pb" },
      keys: ["pattern:kit-clip/pb|*", "clip:kit-clip|chain"],
    },
    {
      id: "clip.remove",
      args: { clip_id: "kit-clip" },
      keys: ["clip:kit-clip|*", "pattern:kit-clip/a|*", "step:kit-clip/a/0/kit-b.0|*"],
    },
    { id: "clip.remove", args: { clip_id: clipId }, keys: [`${cl}|*`] },
    { id: "scene.remove", args: { scene_id: chorus }, keys: [`scene:${chorus}|*`] },
    { id: "track.remove", args: { track_id: "drums" }, keys: ["track:drums|*"] },
  ];

  // The list covers the whole contract: a new command cannot slip in without
  // the expected key set being written down.
  assert.deepEqual([...new Set(cases.map((entry) => entry.id))].sort(), COMMAND_IDS);

  for (const { id, args, keys } of cases) {
    const result = runCommand(doc, id, args);
    assert.equal(result.id, id);

    assert.deepEqual(Object.keys(result.before).sort(), [...keys].sort(), `${id} before keys`);
    assert.deepEqual(Object.keys(result.after).sort(), [...keys].sort(), `${id} after keys`);

    // `undefined` would be dropped when the history stores the entry, and the
    // undo would silently do nothing.
    for (const map of [result.before, result.after]) {
      for (const [key, value] of Object.entries(map)) {
        assert.notStrictEqual(value, undefined, `${id}: "${key}" recorded undefined`);
      }
    }

    const touched = new Set(result.touched);
    for (const key of keys) {
      assert.ok(touched.has(refOf(key)), `${id}: "${key}" is not one of its touched objects`);
    }
    // The command's own target always carries the change. (A clip command
    // also names its track, which it reads for the lock check but does not
    // edit, so that ref may legitimately have no field.)
    const target = result.touched[0];
    assert.ok(keys.some((key) => refOf(key) === target), `${id} has no after entry for ${target}`);

    // What the command handed back is a copy: scribbling over it afterwards
    // must leave the document exactly as the command left it.
    const settled = snapshot(doc);
    scribble(result.before);
    scribble(result.after);
    scribble(result.args);
    assert.deepEqual(snapshot(doc), settled, `${id} returned a live reference into the document`);
  }
});

test("schemas reject note pitch 128", () => {
  const write = getCommand("clip.write").schema.safeParse({
    track_id: "t1",
    scene_id: "s1",
    name: "Bad bass",
    notes: [{ t: 0, d: 1, p: 128, v: 100 }],
  });
  assert.equal(write.success, false);
  assert.ok(write.error.issues.some((issue) => issue.path.join(".") === "notes.0.p"));

  const edit = getCommand("clip.edit_notes").schema.safeParse({
    clip_id: "c1",
    add: [{ t: 0, d: 1, p: 128, v: 100 }],
  });
  assert.equal(edit.success, false);
  assert.ok(edit.error.issues.some((issue) => issue.path.join(".") === "add.0.p"));

  // The edges that are allowed stay allowed.
  const edges = getCommand("clip.write").schema.safeParse({
    track_id: "t1",
    scene_id: "s1",
    name: "Edge bass",
    notes: [{ t: 0, d: 0.125, p: 0, v: 1 }, { t: 1, d: 0.125, p: 127, v: 127 }],
  });
  assert.equal(edges.success, true);
});

test("clip on unknown track is not_found", (t) => {
  const doc = scratchDoc(t);
  const scene = addScene(doc, "Verse");
  const track = addTrack(doc, "Bass");

  const missingTrack = refuses(
    () => writeClip(doc, { track_id: "nope", scene_id: scene, name: "Ghost", notes: [] }),
    "not_found",
  );
  assert.match(missingTrack.message, /nope/);

  const missingScene = refuses(
    () => writeClip(doc, { track_id: track, scene_id: "nowhere", name: "Ghost", notes: [] }),
    "not_found",
  );
  assert.match(missingScene.message, /nowhere/);

  assert.deepEqual(snapshot(doc).clips, {});
});

test("prepareCommand changes nothing and one apply is one update", (t) => {
  const doc = scratchDoc(t);
  const track = addTrack(doc, "Bass");
  const scene = addScene(doc, "Verse");
  const before = snapshot(doc);

  const prepared = prepareCommand(doc, "clip.write", {
    track_id: track,
    scene_id: scene,
    name: "Verse bass",
    notes: [note(0, 1, 36, 100)],
  });
  assert.deepEqual(snapshot(doc), before);
  assert.ok(prepared.args.clip_id);
  assert.deepEqual(prepared.touched, [`clip:${prepared.args.clip_id}`, `track:${track}`]);

  let updates = 0;
  doc.on("update", () => {
    updates += 1;
  });
  const applied = doc.transact(() => applyCommand(doc, prepared));
  assert.equal(updates, 1);
  assert.match(applied.summary, /^Wrote "Verse bass"/);
  assert.deepEqual(Object.keys(snapshot(doc).clips), [prepared.args.clip_id]);
});

test("clip.edit_notes adds, moves and removes by index", (t) => {
  const doc = scratchDoc(t);
  const track = addTrack(doc, "Bass");
  const scene = addScene(doc, "Verse");
  const written = writeClip(doc, {
    track_id: track,
    scene_id: scene,
    name: "Verse bass",
    length_bars: 4,
    notes: [note(0, 1, 36, 100), note(1, 1, 38, 100), note(2, 1, 41, 100)],
  });
  const clipId = written.args.clip_id;

  const edited = runCommand(doc, "clip.edit_notes", {
    clip_id: clipId,
    remove: [1],
    move: [{ index: 0, t: 3 }],
    add: [note(0, 0.5, 43, 90)],
  });
  assert.equal(edited.summary, 'Edited "Verse bass": 1 added, 1 removed, 1 moved');
  assert.deepEqual(snapshot(doc).clips[clipId].notes, [
    note(3, 1, 36, 100),
    note(2, 1, 41, 100),
    note(0, 0.5, 43, 90),
  ]);
  assert.deepEqual(edited.before[`clip:${clipId}|notes`], [
    note(0, 1, 36, 100),
    note(1, 1, 38, 100),
    note(2, 1, 41, 100),
  ]);

  const gone = refuses(() => runCommand(doc, "clip.edit_notes", { clip_id: clipId, remove: [9] }), "invalid");
  assert.match(gone.message, /index 9/);

  // 4 bars is 16 beats, so a note starting on beat 16 does not fit.
  const past = refuses(
    () => runCommand(doc, "clip.edit_notes", { clip_id: clipId, add: [note(16, 1, 60, 100)] }),
    "invalid",
  );
  assert.match(past.message, /16 beats|4 bars/);
  assert.deepEqual(snapshot(doc).clips[clipId].notes, [
    note(3, 1, 36, 100),
    note(2, 1, 41, 100),
    note(0, 0.5, 43, 90),
  ]);
});

test("applyBeforeAfter restores a created object at its index", (t) => {
  const doc = scratchDoc(t);
  addTrack(doc, "Bass");
  const added = runCommand(doc, "track.add", { name: "Drums", id: "drums" });
  addTrack(doc, "Keys");
  assert.deepEqual(snapshot(doc).tracks.map((track) => track.name), ["Bass", "Drums", "Keys"]);
  assert.equal(readField(doc, "track:drums", "name"), "Drums");
  assert.deepEqual(readField(doc, "track:drums", "*"), added.after["track:drums|*"]);

  // Undo: before holds the ref with no value, so the object goes away.
  doc.transact(() => applyBeforeAfter(doc, added.before));
  assert.deepEqual(snapshot(doc).tracks.map((track) => track.name), ["Bass", "Keys"]);
  assert.strictEqual(readField(doc, "track:drums", "*"), null);
  assert.equal(readField(doc, "song:meta", "bpm"), 120);

  // Redo: after carries the original position inside the object JSON.
  doc.transact(() => applyBeforeAfter(doc, added.after));
  assert.deepEqual(snapshot(doc).tracks.map((track) => track.name), ["Bass", "Drums", "Keys"]);
  assert.equal(snapshot(doc).tracks[1].id, "drums");
  assert.equal("_index" in snapshot(doc).tracks[1], false);

  // A whole removed clip comes back with its notes, and goes again.
  const scene = addScene(doc, "Verse");
  const written = writeClip(doc, {
    track_id: "drums",
    scene_id: scene,
    name: "Beat",
    length_bars: 1,
    notes: [note(0, 1, 36, 100)],
  });
  const removed = runCommand(doc, "clip.remove", { clip_id: written.args.clip_id });
  doc.transact(() => applyBeforeAfter(doc, removed.before));
  assert.deepEqual(snapshot(doc).clips[written.args.clip_id].notes, [note(0, 1, 36, 100)]);
  doc.transact(() => applyBeforeAfter(doc, removed.after));
  assert.equal(snapshot(doc).clips[written.args.clip_id], undefined);
});

test("a note past the clip's end is refused", (t) => {
  const doc = scratchDoc(t);
  const track = addTrack(doc, "Bass");
  const scene = addScene(doc, "Verse");
  const before = snapshot(doc);

  const error = refuses(
    () => writeClip(doc, {
      track_id: track,
      scene_id: scene,
      name: "Too long",
      length_bars: 1,
      notes: [note(0, 1, 36, 100), note(3.5, 1, 36, 100)],
    }),
    "invalid",
  );
  assert.match(error.message, /1 bar/);
  assert.deepEqual(snapshot(doc), before);
});

test("set_device with 65 params is refused", (t) => {
  const doc = scratchDoc(t);
  const track = addTrack(doc, "Bass");
  const before = snapshot(doc);
  const params = Object.fromEntries(
    Array.from({ length: LIMITS.params + 1 }, (_, index) => [`Param ${index + 1}`, index]),
  );

  const over = refuses(
    () => runCommand(doc, "track.set_device", { track_id: track, type: "SpectraVoice", params }),
    "limit",
  );
  assert.equal(over.message, "A device can have at most 64 parameters.");
  assert.deepEqual(snapshot(doc), before);

  // track.add caps the same record, and refuses before it creates anything.
  const added = refuses(
    () => runCommand(doc, "track.add", { id: "strings", name: "Strings", device: { type: "SpectraVoice", params } }),
    "limit",
  );
  assert.equal(added.message, "A device can have at most 64 parameters.");
  assert.deepEqual(snapshot(doc), before);

  // Exactly 64 is allowed.
  const allowed = Object.fromEntries(Object.entries(params).slice(0, LIMITS.params));
  const set = runCommand(doc, "track.set_device", { track_id: track, type: "SpectraVoice", params: allowed });
  assert.deepEqual(Object.keys(set.after), [`track:${track}|device`]);
  assert.deepEqual(snapshot(doc).tracks[0].device.params, allowed);
});

test("after removing a track the next added track does not repeat an existing colour", (t) => {
  const doc = scratchDoc(t);
  const bass = addTrack(doc, "Bass");
  addTrack(doc, "Drums");
  assert.deepEqual(snapshot(doc).tracks.map((track) => track.color), [TRACK_COLORS[0], TRACK_COLORS[1]]);

  runCommand(doc, "track.remove", { track_id: bass });
  addTrack(doc, "Keys");
  const colors = snapshot(doc).tracks.map((track) => track.color);
  assert.deepEqual(colors, [TRACK_COLORS[1], TRACK_COLORS[0]]);
  assert.equal(new Set(colors).size, colors.length);

  // Once every palette colour is taken the sequence repeats rather than
  // failing to find one.
  const wide = scratchDoc(t);
  for (let index = 0; index < TRACK_COLORS.length; index += 1) addTrack(wide, `Track ${index + 1}`);
  assert.deepEqual(snapshot(wide).tracks.map((track) => track.color), [...TRACK_COLORS]);
  addTrack(wide, "Next");
  assert.equal(snapshot(wide).tracks[TRACK_COLORS.length].color, TRACK_COLORS[0]);
});
test("set_param cannot add a 65th controller and rejects reserved or dotted names", async () => {
  const { newSongDoc } = await import("../bundles/studio/server/doc.js");
  const reg = await import("../bundles/studio/server/commands/registry.js");
  await import("../bundles/studio/server/commands/core.js");
  const doc = newSongDoc({ title: "caps" });
  const run = (command, args) => doc.transact(() => reg.runCommand(doc, command, args));
  run("track.add", { id: "t1", name: "Lead", device: { engine: "sunvox", type: "Analog generator", params: {} } });
  for (let i = 0; i < 64; i++) run("track.set_param", { track_id: "t1", name: "p" + i, value: i });
  assert.throws(() => run("track.set_param", { track_id: "t1", name: "p64", value: 1 }), /at most 64 parameters/);
  run("track.set_param", { track_id: "t1", name: "p3", value: 99 }); // changing an existing one is fine
  for (const bad of ["__proto__", "a.b", "a|b"]) {
    assert.throws(() => run("track.set_param", { track_id: "t1", name: bad, value: 1 }));
  }
});

test("tracks accept only the self-contained SunVox instruments", async () => {
  const { newSongDoc, INSTRUMENT_TYPES } = await import("../bundles/studio/server/doc.js");
  const reg = await import("../bundles/studio/server/commands/registry.js");
  await import("../bundles/studio/server/commands/core.js");
  const doc = newSongDoc({ title: "instruments" });
  const run = (command, args) => doc.transact(() => reg.runCommand(doc, command, args));
  for (const type of INSTRUMENT_TYPES) run("track.add", { name: type.slice(0, 20), device: { engine: "sunvox", type, params: {} } });
  for (const type of ["Input", "Sampler", "Reverb", "Velocity2Ctl"]) {
    assert.throws(() => run("track.add", { name: "x", device: { engine: "sunvox", type, params: {} } }));
  }
});
