/**
 * Studio history: entries in the store's shape, selective undo, and redo.
 *
 * Every scenario builds a song in memory and records its steps the way the
 * session hub will — one real registry command inside one `doc.transact(...)`
 * per step. Nothing here touches a database or a running instance.
 *
 * The undo plan is dry-run on a clone of the document before it is offered, so
 * several tests below are about what an undo *refuses*: a step whose target is
 * gone, a step that would leave a clip without its track or scene, and a step
 * that would put notes past the end of a clip. A refused plan comes back with
 * an empty `apply` and the reasons in `blocked`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeDocState } from "../bundles/studio/server/doc.js";
import { newSongDoc, snapshot } from "../bundles/studio/server/doc.js";
import { StudioError, runCommand } from "../bundles/studio/server/commands/registry.js";
import "../bundles/studio/server/commands/core.js";
import "../bundles/studio/server/commands/arrangement.js";
import {
  OBJECT_GONE,
  REDO_COMMAND,
  UNDO_COMMAND,
  applyPlan,
  makeEntry,
  makeUndoEntry,
  planRedo,
  planUndo,
  readField,
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
 * The document's whole Yjs state, base64 — a byte-for-byte comparison a
 * refused undo must not change.
 * @param {import("yjs").Doc} doc
 * @returns {string}
 */
function docBytes(doc) {
  return Buffer.from(encodeDocState(doc)).toString("base64");
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
  assert.strictEqual(plan.apply.get("track:bass|*"), null);
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
    before: { "clip:bass-verse|*": null },
    after: { "clip:bass-verse|name": "A name the agent wrote", "clip:bass-verse|*": whole },
  });

  const plan = planUndo(s.doc, entry);
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].ref, "clip:bass-verse");
  assert.equal(plan.conflicts[0].field, "name");
  assert.equal(plan.apply.has("clip:bass-verse|*"), false);
  assert.equal(snapshot(s.doc).clips["bass-verse"].name, "Verse bass");
});

test("entry survives a JSON round trip and still undoes a track.add and a clip.remove", (t) => {
  const s = studio(t);
  s.run("scene.add", { id: "verse", name: "Verse" });
  const added = s.run("track.add", { name: "Bass", id: "bass" });

  // The store keeps an entry as JSON text, and JSON drops `undefined` keys —
  // so "the object did not exist" has to be stored as `null` to survive at
  // all. A dropped key would make the undo below do nothing.
  const storedAdd = JSON.parse(JSON.stringify(added.entry));
  assert.deepEqual(Object.keys(storedAdd.inverse.before), ["track:bass|*"]);
  assert.strictEqual(storedAdd.inverse.before["track:bass|*"], null);

  const addUndo = planUndo(s.doc, storedAdd);
  assert.deepEqual(addUndo.conflicts, []);
  assert.strictEqual(addUndo.apply.get("track:bass|*"), null);
  s.doc.transact(() => applyPlan(s.doc, addUndo));
  assert.deepEqual(trackNames(s.doc), []);

  // The undo entry round trips the same way, so redoing it puts the track back
  // at the index it was created at.
  const undoEntry = makeUndoEntry({ entry: storedAdd, plan: addUndo, song_id: SONG_ID, seq: 10 });
  const addRedo = planRedo(s.doc, JSON.parse(JSON.stringify(undoEntry)));
  assert.deepEqual(addRedo.conflicts, []);
  s.doc.transact(() => applyPlan(s.doc, addRedo));
  assert.deepEqual(trackNames(s.doc), ["Bass"]);
  assert.equal(snapshot(s.doc).tracks[0].id, "bass");

  // A clip removal carries the same marker in its after map.
  s.run("clip.write", {
    clip_id: "bass-verse",
    track_id: "bass",
    scene_id: "verse",
    name: "Verse bass",
    length_bars: 1,
    notes: [note(0, 1, 36, 100)],
  });
  const removal = s.run("clip.remove", { clip_id: "bass-verse" });
  const storedRemove = JSON.parse(JSON.stringify(removal.entry));
  assert.strictEqual(storedRemove.inverse.after["clip:bass-verse|*"], null);
  assert.equal(snapshot(s.doc).clips["bass-verse"], undefined);

  const removeUndo = planUndo(s.doc, storedRemove);
  assert.deepEqual(removeUndo.conflicts, []);
  s.doc.transact(() => applyPlan(s.doc, removeUndo));
  assert.equal(snapshot(s.doc).clips["bass-verse"].name, "Verse bass");
  assert.deepEqual(snapshot(s.doc).clips["bass-verse"].notes, [note(0, 1, 36, 100)]);
});

test("undo of one set_param keeps a later set_param on another controller and reports no conflict", (t) => {
  const s = studio(t);
  s.run("track.add", { name: "Bass", id: "bass" });
  const cutoff = s.run("track.set_param", { track_id: "bass", name: "Cutoff", value: 40 });
  s.run("track.set_param", { track_id: "bass", name: "Resonance", value: 10 });

  // Only the controller the step changed is recorded, so a later change to a
  // different controller is not in its way.
  assert.deepEqual(Object.keys(cutoff.entry.inverse.before), ["track:bass|device.params.Cutoff"]);
  assert.strictEqual(cutoff.entry.inverse.before["track:bass|device.params.Cutoff"], null);
  assert.equal(cutoff.entry.inverse.after["track:bass|device.params.Cutoff"], 40);

  const undone = s.undo(cutoff.entry);
  assert.deepEqual(undone.plan.conflicts, []);
  assert.deepEqual([...undone.plan.apply.keys()], ["track:bass|device.params.Cutoff"]);
  assert.strictEqual(undone.plan.apply.get("track:bass|device.params.Cutoff"), null);

  const device = snapshot(s.doc).tracks[0].device;
  assert.equal(Object.hasOwn(device.params, "Cutoff"), false);
  assert.equal(device.params.Resonance, 10);
  assert.equal(device.type, "Analog generator");

  // The undo is a step of its own, and redoing it restores the controller.
  const redone = s.redo(undone.entry);
  assert.deepEqual(redone.plan.conflicts, []);
  assert.equal(snapshot(s.doc).tracks[0].device.params.Cutoff, 40);
  assert.equal(snapshot(s.doc).tracks[0].device.params.Resonance, 10);
});

test("same controller changed later keeps the later value and reports one conflict", (t) => {
  const s = studio(t);
  s.run("track.add", { name: "Bass", id: "bass" });
  const older = s.run("track.set_param", { track_id: "bass", name: "Cutoff", value: 40 });
  const newer = s.run("track.set_param", { track_id: "bass", name: "Cutoff", value: 70 });

  const olderUndo = s.undo(older.entry);
  assert.equal(olderUndo.plan.apply.size, 0);
  assert.equal(olderUndo.plan.conflicts.length, 1);
  const conflict = olderUndo.plan.conflicts[0];
  assert.equal(conflict.ref, "track:bass");
  assert.equal(conflict.field, "device.params.Cutoff");
  assert.equal(conflict.expected, 40);
  assert.equal(conflict.actual, 70);
  assert.equal(snapshot(s.doc).tracks[0].device.params.Cutoff, 70);

  // The newer step still undoes, back to the value the older one set.
  const newerUndo = s.undo(newer.entry);
  assert.deepEqual(newerUndo.plan.conflicts, []);
  assert.equal(newerUndo.plan.apply.get("track:bass|device.params.Cutoff"), 40);
  assert.equal(snapshot(s.doc).tracks[0].device.params.Cutoff, 40);
});

test("undo of track.add refused while a clip still uses the track", (t) => {
  const s = studio(t);
  const added = s.run("track.add", { name: "Bass", id: "bass" });
  s.run("scene.add", { id: "verse", name: "Verse" });
  s.run("clip.write", {
    clip_id: "bass-verse",
    track_id: "bass",
    scene_id: "verse",
    name: "Verse bass",
    length_bars: 1,
    notes: [note(0, 1, 36, 100)],
  });

  // The step's own field is untouched, so nothing is in conflict — but taking
  // it back would delete the track the clip still plays on.
  const plan = planUndo(s.doc, added.entry);
  assert.deepEqual(plan.conflicts, []);
  assert.equal(plan.apply.size, 0);
  assert.equal(plan.blocked.length, 1);
  assert.match(plan.blocked[0], /without its track/);

  assert.deepEqual(trackNames(s.doc), ["Bass"]);
  assert.deepEqual(Object.keys(snapshot(s.doc).clips), ["bass-verse"]);
});

test("undo of scene.add refused while a clip still uses the scene", (t) => {
  const s = studio(t);
  s.run("track.add", { name: "Bass", id: "bass" });
  const added = s.run("scene.add", { id: "verse", name: "Verse" });
  s.run("clip.write", {
    clip_id: "bass-verse",
    track_id: "bass",
    scene_id: "verse",
    name: "Verse bass",
    length_bars: 1,
    notes: [note(0, 1, 36, 100)],
  });

  const plan = planUndo(s.doc, added.entry);
  assert.deepEqual(plan.conflicts, []);
  assert.equal(plan.apply.size, 0);
  assert.equal(plan.blocked.length, 1);
  assert.match(plan.blocked[0], /without its scene/);

  assert.deepEqual(snapshot(s.doc).scenes.map((scene) => scene.id), ["verse"]);
  assert.deepEqual(Object.keys(snapshot(s.doc).clips), ["bass-verse"]);
});

test("undo of track.remove refused when the clip's scene is gone", (t) => {
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
  const removed = s.run("track.remove", { track_id: "bass" });
  s.run("scene.remove", { scene_id: "verse" });

  // The removal step still matches the document exactly (track and clip are
  // both gone), so the plan would restore the clip into a scene that no longer
  // exists. It comes back empty instead.
  const plan = planUndo(s.doc, removed.entry);
  assert.deepEqual(plan.conflicts, []);
  assert.equal(plan.apply.size, 0);
  assert.equal(plan.blocked.length, 1);
  assert.match(plan.blocked[0], /without its scene/);

  assert.deepEqual(trackNames(s.doc), []);
  assert.deepEqual(snapshot(s.doc).clips, {});
});

test("redo after the track was removed reports the track gone and changes nothing", (t) => {
  const s = studio(t);
  s.run("track.add", { name: "Bass", id: "bass" });
  const param = s.run("track.set_param", { track_id: "bass", name: "Cutoff", value: 40 });
  const undone = s.undo(param.entry);
  s.run("track.remove", { track_id: "bass" });

  // A single field of an object that is no longer there is not "a field that
  // is null": the redo would have nothing to write into.
  assert.strictEqual(readField(s.doc, "track:bass|device.params.Cutoff"), OBJECT_GONE);

  const before = docBytes(s.doc);
  const plan = planRedo(s.doc, undone.entry);
  assert.equal(plan.apply.size, 0);
  assert.deepEqual(plan.blocked, []);
  assert.equal(plan.conflicts.length, 1);
  const conflict = plan.conflicts[0];
  assert.equal(conflict.ref, "track:bass");
  assert.equal(conflict.field, "device.params.Cutoff");
  assert.equal(conflict.expected, null);
  assert.equal(conflict.actual, null);
  assert.equal(conflict.gone, true);

  s.doc.transact(() => applyPlan(s.doc, plan));
  assert.equal(docBytes(s.doc), before);
});

test("partial undo can never leave notes past the clip end", (t) => {
  const s = studio(t);
  s.run("track.add", { name: "Bass", id: "bass" });
  s.run("scene.add", { id: "verse", name: "Verse" });
  const long = [note(0, 32, 36, 100)];
  s.run("clip.write", {
    clip_id: "bass-verse",
    track_id: "bass",
    scene_id: "verse",
    name: "Verse bass",
    length_bars: 8,
    notes: long,
  });
  const shortened = s.run("clip.write", {
    clip_id: "bass-verse",
    track_id: "bass",
    scene_id: "verse",
    name: "Verse bass",
    length_bars: 2,
    notes: [note(0, 1, 36, 100)],
  });
  s.run("clip.set_length", { clip_id: "bass-verse", length_bars: 3 });

  // The name and the notes have not been touched since, but the length has: a
  // per-field undo would take the notes back and leave them running past the
  // three bars the clip has now.
  const plan = planUndo(s.doc, shortened.entry);
  assert.deepEqual(plan.conflicts.map((conflict) => conflict.field), ["length_bars"]);
  assert.equal(plan.apply.size, 0);
  assert.equal(plan.blocked.length, 1);
  assert.match(plan.blocked[0], /past its 3 bars/);

  const clip = snapshot(s.doc).clips["bass-verse"];
  assert.deepEqual(clip.notes, [note(0, 1, 36, 100)]);
  assert.equal(clip.length_bars, 3);
});

test("undo of track.add is not a conflict just because an earlier track was removed", (t) => {
  const s = studio(t);
  s.run("track.add", { name: "Keys", id: "keys" });
  const added = s.run("track.add", { name: "Bass", id: "bass" });
  s.run("track.remove", { track_id: "keys" });

  // The track was recorded at index 1 and now sits at index 0. Where it sits is
  // not part of what the step wrote, so the undo still applies.
  const plan = planUndo(s.doc, added.entry);
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.blocked, []);
  assert.deepEqual([...plan.apply.keys()], ["track:bass|*"]);
  assert.strictEqual(plan.apply.get("track:bass|*"), null);
});

test("undoing two removals restores the original order", (t) => {
  const s = studio(t);
  for (const id of ["a", "b", "c"]) s.run("track.add", { name: id.toUpperCase(), id });
  const removedA = s.run("track.remove", { track_id: "a" });
  const removedC = s.run("track.remove", { track_id: "c" });
  assert.deepEqual(trackNames(s.doc), ["B"]);

  // C was removed while it sat at index 1, so its recorded index alone would
  // put it back in front of B; the neighbour it recorded keeps it behind B,
  // where it was.
  s.undo(removedA.entry);
  assert.deepEqual(trackNames(s.doc), ["A", "B"]);
  s.undo(removedC.entry);
  assert.deepEqual(snapshot(s.doc).tracks.map((track) => track.id), ["a", "b", "c"]);
});

test("undoing two removals in the order they happened restores the original order", (t) => {
  const s = studio(t);
  for (const id of ["a", "b", "c"]) s.run("track.add", { name: id.toUpperCase(), id });

  // A created track records the sibling it followed, and a removed one also
  // records the sibling that followed it (`_before`).
  assert.equal(s.entries[2].inverse.after["track:c|*"]._after, "b");

  const removedB = s.run("track.remove", { track_id: "b" });
  const removedA = s.run("track.remove", { track_id: "a" });
  assert.deepEqual(trackNames(s.doc), ["C"]);

  // B kept a sibling on either side of it; A had nothing in front of it any
  // more, only C behind it.
  assert.equal(removedB.entry.inverse.before["track:b|*"]._after, "a");
  assert.equal(removedB.entry.inverse.before["track:b|*"]._before, "c");
  assert.equal(removedA.entry.inverse.before["track:a|*"]._after, null);
  assert.equal(removedA.entry.inverse.before["track:a|*"]._before, "c");

  // Taking B back first puts it in front of C, and A then goes back in front
  // of B even though the sibling it followed has been gone since its removal.
  const undoB = s.undo(removedB.entry);
  assert.deepEqual(undoB.plan.conflicts, []);
  assert.deepEqual(trackNames(s.doc), ["B", "C"]);

  const undoA = s.undo(removedA.entry);
  assert.deepEqual(undoA.plan.conflicts, []);
  assert.deepEqual(snapshot(s.doc).tracks.map((track) => track.id), ["a", "b", "c"]);

  // The hint is used on the way back in and never left on the song.
  assert.equal(snapshot(s.doc).tracks.some((track) => "_before" in track), false);
});

test("undo of track.remove does not move old clips onto a re-created track with the same id", (t) => {
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
  const removed = s.run("track.remove", { track_id: "bass" });

  // Someone puts a different instrument on the id the removed track had. The
  // removal's track no longer matches the document, and the clip it took with
  // it must not come back onto that new track.
  s.run("track.add", { name: "Keys", id: "bass", device: { type: "SpectraVoice" } });

  const { plan } = s.undo(removed.entry);
  assert.equal(plan.apply.size, 0);
  assert.deepEqual(plan.blocked, []);

  const conflicts = new Map(plan.conflicts.map((conflict) => [conflict.ref, conflict]));
  assert.equal(conflicts.size, 2);

  const track = conflicts.get("track:bass");
  assert.equal(track.field, "*");
  assert.equal(track.expected, null);
  assert.equal(track.actual.name, "Keys");

  // The clip is still absent from the document, so it compared clean — only
  // its owner tells the undo to leave it deleted.
  const clip = conflicts.get("clip:bass-verse");
  assert.equal(clip.field, "*");
  assert.equal(clip.expected, null);
  assert.equal(clip.actual, null);
  assert.equal(clip.owner_changed, true);

  assert.deepEqual(trackNames(s.doc), ["Keys"]);
  assert.deepEqual(snapshot(s.doc).clips, {});
});

test("undo of set_param conflicts after the device was swapped", (t) => {
  const s = studio(t);
  s.run("track.add", { name: "Bass", id: "bass" });
  const cutoff = s.run("track.set_param", { track_id: "bass", name: "Cutoff", value: 40 });

  // The step guards on the device type, and the guard survives the JSON round
  // trip the store puts an entry through.
  assert.deepEqual(cutoff.entry.inverse.guards, { "track:bass|device.type": "Analog generator" });
  const stored = JSON.parse(JSON.stringify(cutoff.entry));
  assert.deepEqual(stored.inverse.guards, { "track:bass|device.type": "Analog generator" });

  // The FM module happens to have the same Cutoff value, so comparing the
  // controller alone would have matched and deleted it from the new device.
  s.run("track.set_device", { track_id: "bass", type: "SpectraVoice", params: { Cutoff: 40 } });

  const plan = planUndo(s.doc, stored);
  assert.equal(plan.apply.size, 0);
  assert.equal(plan.conflicts.length, 1);
  const conflict = plan.conflicts[0];
  assert.equal(conflict.ref, "track:bass");
  assert.equal(conflict.field, "device.type");
  assert.equal(conflict.expected, "Analog generator");
  assert.equal(conflict.actual, "SpectraVoice");

  // A guard is compared, never restored: the FM device is left as it is.
  const device = snapshot(s.doc).tracks[0].device;
  assert.equal(device.type, "SpectraVoice");
  assert.equal(device.params.Cutoff, 40);
});

test("a blocked undo leaves the doc byte-identical", (t) => {
  const s = studio(t);
  const added = s.run("track.add", { name: "Bass", id: "bass" });
  s.run("scene.add", { id: "verse", name: "Verse" });
  s.run("clip.write", {
    clip_id: "bass-verse",
    track_id: "bass",
    scene_id: "verse",
    name: "Verse bass",
    length_bars: 1,
    notes: [note(0, 1, 36, 100)],
  });

  const before = docBytes(s.doc);
  const plan = planUndo(s.doc, added.entry);
  assert.ok(plan.blocked.length > 0);
  s.doc.transact(() => applyPlan(s.doc, plan));
  assert.equal(docBytes(s.doc), before);
  assert.deepEqual(trackNames(s.doc), ["Bass"]);
});

test("redo of an already-redone undo is refused", (t) => {
  const s = studio(t);
  const set = s.run("song.set_meta", { bpm: 96 });
  const undone = s.undo(set.entry);
  const redone = s.redo(undone.entry);

  // Undo of E created U, redo of E created R out of U. E stays undone by U:
  // taking the change out again is undoing R, never redoing U twice.
  assert.equal(set.entry.undone_by, undone.entry.id);
  assert.equal(undone.entry.undone_by, redone.entry.id);
  assert.equal(snapshot(s.doc).meta.bpm, 96);

  const error = refuses(() => planRedo(s.doc, undone.entry), "conflict");
  assert.match(error.message, /already undone/);

  const { plan } = s.undo(redone.entry);
  assert.deepEqual(plan.conflicts, []);
  assert.equal(snapshot(s.doc).meta.bpm, 120);
});

/** A one-track, one-scene, two-bar clip song with an eight-bar placement on it. */
function splitScene(t) {
  const s = studio(t);
  s.run("track.add", { id: "bass", name: "Bass" });
  s.run("scene.add", { id: "verse", name: "Verse" });
  s.run("clip.write", {
    clip_id: "riff",
    track_id: "bass",
    scene_id: "verse",
    name: "Riff",
    length_bars: 2,
    notes: [note(0, 1, 36, 100)],
  });
  s.run("arrangement.place", { id: "p-a", track_id: "bass", clip_id: "riff", start_bar: 0, bars: 8 });
  return s;
}

test("undo of a split after moving one half is refused as a whole", (t) => {
  const s = splitScene(t);
  const split = s.run("arrangement.split", { id: "p-a", at_bar: 3, new_id: "p-b" });
  s.run("arrangement.move", { id: "p-b", start_bar: 20 });

  // The two halves are one edit, so the step as a whole can no longer go back:
  // putting the first half back while the second half has moved would leave a
  // song that never existed.
  const before = docBytes(s.doc);
  const plan = planUndo(s.doc, split.entry);
  assert.equal(plan.apply.size, 0);
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].ref, "placement:p-b");
  assert.deepEqual(plan.blocked, [
    "Part of that split was changed since; undo the later edits first, or move the pieces by hand.",
  ]);

  // A refused undo writes nothing at all.
  s.doc.transact(() => applyPlan(s.doc, plan));
  assert.equal(docBytes(s.doc), before);
  assert.equal(snapshot(s.doc).arrangement.placements["p-a"].bars, 3);
  assert.equal(snapshot(s.doc).arrangement.placements["p-b"].start_bar, 20);
});

test("undo of a split with no later edits restores the placement", (t) => {
  const s = splitScene(t);
  s.run("arrangement.set_fades", { id: "p-a", fade_in_beats: 1, fade_out_beats: 2 });
  const split = s.run("arrangement.split", { id: "p-a", at_bar: 3, new_id: "p-b" });
  assert.deepEqual(Object.keys(snapshot(s.doc).arrangement.placements).sort(), ["p-a", "p-b"]);

  const { plan } = s.undo(split.entry);
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.blocked, []);
  assert.deepEqual(Object.keys(snapshot(s.doc).arrangement.placements), ["p-a"]);
  assert.deepEqual(snapshot(s.doc).arrangement.placements["p-a"], {
    id: "p-a",
    track_id: "bass",
    clip_id: "riff",
    start_bar: 0,
    bars: 8,
    offset_beats: 0,
    fade_in_beats: 1,
    fade_out_beats: 2,
  });
});