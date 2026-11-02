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

/** The 1a command list: the contract the GUI, the MCP tools and history share. */
const COMMAND_IDS = [
  "clip.edit_notes",
  "clip.remove",
  "clip.rename",
  "clip.set_length",
  "clip.write",
  "scene.add",
  "scene.remove",
  "scene.rename",
  "song.set_meta",
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

test("the registry lists the 1a commands", () => {
  assert.deepEqual(
    listCommands().map((command) => command.id),
    COMMAND_IDS,
  );
  assert.deepEqual(Object.keys(MINIMAL_ARGS).sort(), COMMAND_IDS);
  assert.equal(getCommand("clip.write").humanOnly, false);
  assert.equal(getCommand("track.lock").humanOnly, true);
  assert.equal(getCommand("track.unlock").humanOnly, true);
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
  assert.equal(removed.after[`track:${track}|*`], undefined);

  assert.deepEqual(removed.before[`clip:${first.args.clip_id}|*`].notes, firstNotes);
  assert.equal(removed.before[`clip:${first.args.clip_id}|*`].length_bars, 1);
  assert.equal(removed.after[`clip:${first.args.clip_id}|*`], undefined);
  assert.equal(removed.after[`clip:${second.args.clip_id}|*`], undefined);
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

  const results = [
    runCommand(doc, "song.set_meta", { bpm: 96 }),
    runCommand(doc, "track.add", { name: "Drums", id: "drums" }),
    runCommand(doc, "track.rename", { track_id: track, name: "Bass DI" }),
    runCommand(doc, "track.set_mix", { track_id: track, gain_db: -3, pan: -0.5 }),
    runCommand(doc, "track.set_device", { track_id: track, type: "FM" }),
    runCommand(doc, "track.set_param", { track_id: track, name: "Cutoff", value: 40 }),
    runCommand(doc, "track.lock", { track_id: track }),
    runCommand(doc, "track.unlock", { track_id: track }),
    runCommand(doc, "scene.rename", { scene_id: scene, name: "Intro" }),
    clip,
    runCommand(doc, "clip.set_length", { clip_id: clipId, length_bars: 8 }),
    runCommand(doc, "clip.rename", { clip_id: clipId, name: "Verse bass 2" }),
    runCommand(doc, "clip.edit_notes", { clip_id: clipId, add: [note(2, 1, 43, 90)] }),
    runCommand(doc, "clip.remove", { clip_id: clipId }),
    runCommand(doc, "scene.remove", { scene_id: chorus }),
    runCommand(doc, "track.remove", { track_id: "drums" }),
  ];

  for (const result of results) {
    const touched = new Set(result.touched);
    const beforeKeys = Object.keys(result.before);
    const afterKeys = Object.keys(result.after);

    assert.deepEqual(beforeKeys.sort(), afterKeys.sort(), `${result.id} before/after disagree on the fields`);
    assert.ok(afterKeys.length > 0, `${result.id} reported no changed field`);

    for (const key of afterKeys) {
      assert.ok(touched.has(refOf(key)), `${result.id}: "${key}" is not one of its touched objects`);
    }
    // The command's own target always carries the change. (A clip command
    // also names its track, which it reads for the lock check but does not
    // edit, so that ref may legitimately have no field.)
    const target = result.touched[0];
    assert.ok(afterKeys.some((key) => refOf(key) === target), `${result.id} has no after entry for ${target}`);
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
  assert.equal(readField(doc, "track:drums", "*"), undefined);
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