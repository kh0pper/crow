/**
 * Studio history: entries in the store's shape, selective undo, and redo.
 *
 * Every scenario builds a song in memory and records its steps the way the
 * session hub will — one real registry command inside one `doc.transact(...)`
 * per step. Nothing here touches a database or a running instance.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { newSongDoc, snapshot } from "../bundles/studio/server/doc.js";
import { StudioError, runCommand } from "../bundles/studio/server/commands/registry.js";
import "../bundles/studio/server/commands/core.js";
import {
  REDO_COMMAND,
  UNDO_COMMAND,
  applyPlan,
  makeEntry,
  makeUndoEntry,
  planRedo,
  planUndo,
} from "../bundles/studio/server/history.js";

/** The song every entry in a test belongs to. */
const SONG_ID = "song-1";

/** A GUI command's author, per the plan's attribution rule. */
const HUMAN = { kind: "human", id: "local", label: "You" };

/** An MCP command's author, per the plan's attribution rule. */
const AGENT = { kind: "agent", id: "mcp", label: "Agent (MCP)" };

/** @returns {{t: number, d: number, p: number, v: number}} a note. */
function note(t, d, p, v) {
  return { t, d, p, v };
}

/** @returns {string[]} the track names in song order. */
function trackNames(doc) {
  return snapshot(doc).tracks.map((track) => track.name);
}

/**
 * A scratch song plus the two calls a hub makes: run a command and record its
 * entry, then undo or redo one recorded entry.
 * @param {import("node:test").TestContext} t
 */
function studio(t) {
  const doc = newSongDoc({ title: "History song" });
  t.after(() => doc.destroy());

  const entries = [];
  let seq = 0;
  const nextSeq = () => {
    seq += 1;
    return seq;
  };

  function record(result, author) {
    const entry = makeEntry({
      song_id: SONG_ID,
      seq: nextSeq(),
      command: result.id,
      args: result.args,
      author,
      summary: result.summary,
      touched: result.touched,
      before: result.before,
      after: result.after,
    });
    entries.push(entry);
    return entry;
  }

  return {
    doc,
    entries,
    /** Run one registry command in one transaction and record its history entry. */
    run(id, args, author = HUMAN) {
      const result = doc.transact(() => runCommand(doc, id, args));
      return { result, entry: record(result, author) };
    },
    /** Undo one recorded step, recording the undo itself. */
    undo(entry, author = HUMAN) {
      const plan = planUndo(doc, entry);
      const undoEntry = doc.transact(() => {
        applyPlan(doc, plan);
        return makeUndoEntry({ entry, plan, song_id: entry.song_id, seq: nextSeq(), author });
      });
      entry.undone_by = undoEntry.id;
      entries.push(undoEntry);
      return { plan, entry: undoEntry };
    },
    /** Redo an undo, recording the redo. */
    redo(undoEntry, author = HUMAN) {
      const plan = planRedo(doc, undoEntry);
      const redoEntry = doc.transact(() => {
        applyPlan(doc, plan);
        return makeUndoEntry({
          entry: undoEntry,
          plan,
          song_id: undoEntry.song_id,
          seq: nextSeq(),
          author,
          command: REDO_COMMAND,
        });
      });
      undoEntry.undone_by = redoEntry.id;
      entries.push(redoEntry);
      return { plan, entry: redoEntry };
    },
  };
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

test("undo restores before values", (t) => {
  const s = studio(t);

  const set = s.run("song.set_meta", { bpm: 96 });
  assert.deepEqual(
    Object.keys(set.entry).sort(),
    [
      "id",
      "song_id",
      "seq",
      "command",
      "args",
      "author",
      "summary",
      "touched",
      "inverse",
      "undo_of",
      "undone_by",
      "created_at",
    ].sort(),
  );
  assert.equal(set.entry.song_id, SONG_ID);
  assert.equal(set.entry.command, "song.set_meta");
  assert.deepEqual(set.entry.author, HUMAN);
  assert.equal(set.entry.undo_of, null);
  assert.equal(set.entry.undone_by, null);
  assert.ok(!Number.isNaN(Date.parse(set.entry.created_at)));
  assert.deepEqual(Object.keys(set.entry.inverse).sort(), ["after", "before"]);

  s.run("track.add", { name: "Bass", id: "bass", gain_db: -3, pan: -0.5 });
  const mixed = s.run("track.set_mix", { track_id: "bass", gain_db: 2, pan: 0.25 });

  const { plan, entry } = s.undo(mixed.entry);
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual([...plan.apply.keys()].sort(), ["track:bass|gain_db", "track:bass|pan"]);
  assert.equal(plan.apply.get("track:bass|gain_db"), -3);
  assert.equal(plan.apply.get("track:bass|pan"), -0.5);

  const bass = snapshot(s.doc).tracks.find((track) => track.id === "bass");
  assert.equal(bass.gain_db, -3);
  assert.equal(bass.pan, -0.5);

  // The undo is a step of its own, the swap of what it changed.
  assert.equal(entry.command, UNDO_COMMAND);
  assert.equal(entry.undo_of, mixed.entry.id);
  assert.deepEqual(entry.inverse.after, { "track:bass|gain_db": -3, "track:bass|pan": -0.5 });
  assert.deepEqual(entry.inverse.before, { "track:bass|gain_db": 2, "track:bass|pan": 0.25 });
  assert.deepEqual(entry.touched, ["track:bass"]);

  // A song field comes back the same way.
  const songUndo = s.undo(set.entry);
  assert.deepEqual(songUndo.plan.conflicts, []);
  assert.equal(songUndo.plan.apply.get("song:meta|bpm"), 120);
  assert.equal(snapshot(s.doc).meta.bpm, 120);
});

test("undo of an older step reports conflicts and keeps the newer edit", (t) => {
  // Case one: the two steps touched different fields, so the undo reverts its
  // own field and leaves the newer edit alone, with no conflict to report.
  const first = studio(t);
  const track = first.run("track.add", { name: "Bass", id: "bass" }).result.args.id;
  const scene = first.run("scene.add", { id: "verse", name: "Verse" }).result.args.id;
  const created = first.run("clip.write", {
    clip_id: "bass-verse",
    track_id: track,
    scene_id: scene,
    name: "Verse bass",
    length_bars: 1,
    notes: [note(0, 1, 36, 100)],
  });
  const clipId = created.result.args.clip_id;

  const agentStep = first.run("clip.edit_notes", { clip_id: clipId, add: [note(1, 1, 38, 100)] }, AGENT);
  first.run("clip.rename", { clip_id: clipId, name: "Verse bass 2" });

  const differentFields = first.undo(agentStep.entry);
  assert.deepEqual(differentFields.plan.conflicts, []);
  assert.deepEqual([...differentFields.plan.apply.keys()], [`clip:${clipId}|notes`]);
  assert.deepEqual(snapshot(first.doc).clips[clipId].notes, [note(0, 1, 36, 100)]);
  assert.equal(snapshot(first.doc).clips[clipId].name, "Verse bass 2");

  // Case two: both steps rewrote `notes`. The older step cannot be undone
  // there, so it reports the one conflict and leaves the notes untouched.
  const second = studio(t);
  second.run("track.add", { name: "Bass", id: "bass" });
  second.run("scene.add", { id: "verse", name: "Verse" });
  second.run("clip.write", {
    clip_id: "bass-verse",
    track_id: "bass",
    scene_id: "verse",
    name: "Verse bass",
    length_bars: 1,
    notes: [note(0, 1, 36, 100)],
  });

  const older = second.run("clip.edit_notes", { clip_id: "bass-verse", add: [note(1, 1, 38, 100)] }, AGENT);
  const newer = second.run("clip.edit_notes", { clip_id: "bass-verse", add: [note(2, 1, 41, 100)] }, AGENT);
  const newestNotes = newer.entry.inverse.after["clip:bass-verse|notes"];
  assert.equal(newestNotes.length, 3);

  const sameField = second.undo(older.entry);
  assert.equal(sameField.plan.apply.size, 0);
  assert.equal(sameField.plan.conflicts.length, 1);
  const conflict = sameField.plan.conflicts[0];
  assert.equal(conflict.ref, "clip:bass-verse");
  assert.equal(conflict.field, "notes");
  assert.deepEqual(conflict.expected, older.entry.inverse.after["clip:bass-verse|notes"]);
  assert.deepEqual(conflict.actual, newestNotes);
  assert.deepEqual(snapshot(second.doc).clips["bass-verse"].notes, newestNotes);
});

test("undo of track.add removes track and clips created by it", (t) => {
  const s = studio(t);
  const added = s.run("track.add", { name: "Bass", id: "bass" });
  s.run("scene.add", { id: "verse", name: "Verse" });
  s.run("scene.add", { id: "chorus", name: "Chorus" });
  const verse = s.run("clip.write", {
    clip_id: "bass-verse",
    track_id: "bass",
    scene_id: "verse",
    name: "Verse bass",
    length_bars: 1,
    notes: [note(0, 1, 36, 100)],
  });
  const chorus = s.run("clip.write", {
    clip_id: "bass-chorus",
    track_id: "bass",
    scene_id: "chorus",
    name: "Chorus bass",
    length_bars: 1,
    notes: [note(0, 1, 41, 100)],
  });

  // A clip is a step of its own, so the track and everything written on it
  // come off newest first.
  s.undo(chorus.entry);
  s.undo(verse.entry);

  const { plan, entry } = s.undo(added.entry);
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual([...plan.apply.keys()], ["track:bass|*"]);
  assert.equal(plan.apply.get("track:bass|*"), undefined);
  assert.equal(entry.undo_of, added.entry.id);
  assert.equal(entry.command, UNDO_COMMAND);

  assert.deepEqual(trackNames(s.doc), []);
  assert.deepEqual(snapshot(s.doc).clips, {});
});

test("redo re-applies after undo", (t) => {
  const s = studio(t);
  const set = s.run("song.set_meta", { bpm: 96 });
  const added = s.run("track.add", { name: "Bass", id: "bass" });
  s.run("track.add", { name: "Drums", id: "drums" });

  const songUndo = s.undo(set.entry);
  assert.equal(snapshot(s.doc).meta.bpm, 120);
  const songRedo = s.redo(songUndo.entry);
  assert.equal(songRedo.entry.command, REDO_COMMAND);
  assert.equal(songRedo.entry.undo_of, songUndo.entry.id);
  assert.deepEqual(songRedo.plan.conflicts, []);
  assert.equal(snapshot(s.doc).meta.bpm, 96);

  // A created track comes back at the position it held.
  const trackUndo = s.undo(added.entry);
  assert.deepEqual(trackNames(s.doc), ["Drums"]);
  const trackRedo = s.redo(trackUndo.entry);
  assert.deepEqual(trackRedo.plan.conflicts, []);
  assert.deepEqual(trackNames(s.doc), ["Bass", "Drums"]);
  assert.equal(snapshot(s.doc).tracks[0].id, "bass");
});

test("undoing an already-undone entry is refused", (t) => {
  const s = studio(t);
  const set = s.run("song.set_meta", { bpm: 96 });
  const { entry } = s.undo(set.entry);
  assert.equal(set.entry.undone_by, entry.id);

  const error = refuses(() => planUndo(s.doc, set.entry), "conflict");
  assert.match(error.message, /already undone/);
  assert.equal(snapshot(s.doc).meta.bpm, 120);

  // The undo entry has itself been undone by a redo, so redoing it twice fails
  // the same way.
  s.redo(entry);
  refuses(() => planRedo(s.doc, entry), "conflict");
});

test("undo of track.remove brings back the track and its clips at the same index", (t) => {
  const s = studio(t);
  s.run("track.add", { name: "Keys", id: "keys" });
  s.run("track.add", { name: "Bass", id: "bass", gain_db: -3 });
  s.run("track.add", { name: "Drums", id: "drums" });
  s.run("scene.add", { id: "verse", name: "Verse" });
  s.run("scene.add", { id: "chorus", name: "Chorus" });

  const firstNotes = [note(0, 1, 36, 100), note(1, 1, 38, 100)];
  s.run("clip.write", {
    clip_id: "bass-verse",
    track_id: "bass",
    scene_id: "verse",
    name: "Verse bass",
    length_bars: 1,
    notes: firstNotes,
  });
  s.run("clip.write", {
    clip_id: "bass-chorus",
    track_id: "bass",
    scene_id: "chorus",
    name: "Chorus bass",
    length_bars: 1,
    notes: [note(0, 1, 41, 100)],
  });

  const removed = s.run("track.remove", { track_id: "bass" });
  assert.deepEqual(trackNames(s.doc), ["Keys", "Drums"]);
  assert.deepEqual(snapshot(s.doc).clips, {});

  const { plan } = s.undo(removed.entry);
  assert.deepEqual(plan.conflicts, []);

  // The track is rebuilt before the clips it carries.
  const keys = [...plan.apply.keys()];
  assert.equal(keys[0], "track:bass|*");
  assert.deepEqual(keys.slice(1).sort(), ["clip:bass-chorus|*", "clip:bass-verse|*"]);

  assert.deepEqual(trackNames(s.doc), ["Keys", "Bass", "Drums"]);
  assert.equal(snapshot(s.doc).tracks[1].gain_db, -3);
  assert.deepEqual(snapshot(s.doc).clips["bass-verse"].notes, firstNotes);
  assert.equal(snapshot(s.doc).clips["bass-chorus"].name, "Chorus bass");
});

test("undo of a created clip is refused once the clip has changed", (t) => {
  const s = studio(t);
  s.run("track.add", { name: "Bass", id: "bass" });
  s.run("scene.add", { id: "verse", name: "Verse" });
  const created = s.run("clip.write", {
    clip_id: "bass-verse",
    track_id: "bass",
    scene_id: "verse",
    name: "Verse bass",
    length_bars: 1,
    notes: [note(0, 1, 36, 100)],
  });
  s.run("clip.edit_notes", { clip_id: "bass-verse", add: [note(2, 1, 43, 100)] }, AGENT);

  const { plan } = s.undo(created.entry);
  assert.equal(plan.apply.size, 0);
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].field, "*");
  assert.deepEqual(snapshot(s.doc).clips["bass-verse"].notes, [note(0, 1, 36, 100), note(2, 1, 43, 100)]);
});

test("a whole-object restore is skipped when one of its fields is in conflict", (t) => {
  const s = studio(t);
  s.run("track.add", { name: "Bass", id: "bass" });
  s.run("scene.add", { id: "verse", name: "Verse" });
  s.run("clip.write", {
    clip_id: "bass-verse",
    track_id: "bass",
    scene_id: "verse",
    name: "Verse bass",
    length_bars: 1,
    notes: [note(0, 1, 36, 100)],
  });
  const whole = snapshot(s.doc).clips["bass-verse"];

  // A hand-made entry that both rewrote one field and would have deleted the
  // whole clip. The field moved on, so the whole-object restore is skipped
  // rather than rebuilt around the newer value.
  const entry = makeEntry({
    song_id: SONG_ID,
    seq: 99,
    command: "clip.write",
    args: {},
    author: HUMAN,
    summary: "Hand-made step",
    touched: ["clip:bass-verse"],
    before: { "clip:bass-verse|*": undefined },
    after: { "clip:bass-verse|name": "A name the agent wrote", "clip:bass-verse|*": whole },
  });

  const plan = planUndo(s.doc, entry);
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].ref, "clip:bass-verse");
  assert.equal(plan.conflicts[0].field, "name");
  assert.equal(plan.apply.has("clip:bass-verse|*"), false);
  assert.equal(snapshot(s.doc).clips["bass-verse"].name, "Verse bass");
});