/**
 * Studio arrangement in the document: the timeline's placements, markers and
 * sections, the rules they keep, what a clip or a track removal takes with it,
 * and the lock check that keeps an agent off a locked track's lane.
 *
 * Most tests build their own song in memory and record their steps the way the
 * session hub does: one real registry command inside one `doc.transact(...)`
 * per step, undone through `history.js`. The lock test needs the real hub and a
 * scratch database, so it runs one.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { AclError } from "../servers/shared/project-acl.js";
import {
  LIMITS,
  checkInvariants,
  getPlacement,
  newSongDoc,
  placementEntries,
  readField,
  snapshot,
  songMap,
} from "../bundles/studio/server/doc.js";
import { StudioError, runCommand } from "../bundles/studio/server/commands/registry.js";
import "../bundles/studio/server/commands/core.js";
import "../bundles/studio/server/commands/takes.js";
import "../bundles/studio/server/commands/arrangement.js";
import { createHub } from "../bundles/studio/server/hub.js";
import { initStudioTables } from "../bundles/studio/server/init-tables.js";
import {
  REDO_COMMAND,
  applyPlan,
  makeEntry,
  makeUndoEntry,
  planRedo,
  planUndo,
} from "../bundles/studio/server/history.js";

/** The song every entry in a test belongs to. */
const SONG_ID = "song-1";

/** The project the hub test's song belongs to. */
const PROJECT = 21;

/** A GUI command's author, per the plan's attribution rule. */
const HUMAN = { kind: "human", id: "local", label: "You" };

/** An MCP command's author, per the plan's attribution rule. */
const AGENT = { kind: "agent", id: "mcp", label: "Agent (MCP)" };

/**
 * A scratch song plus the two calls a hub makes: run a command and record its
 * entry, then undo or redo one recorded entry.
 * @param {import("node:test").TestContext} t
 */
function studio(t) {
  const doc = newSongDoc({ title: "Arrangement song" });
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

/** Add a SunVox track and return its id. */
function addTrack(doc, name = "Bass") {
  return runCommand(doc, "track.add", { name }).args.id;
}

/** Add a scene and return its id. */
function addScene(doc, name = "Verse") {
  return runCommand(doc, "scene.add", { name }).args.id;
}

/** Write a notes clip and return its id. */
function addClip(doc, trackId, sceneId, lengthBars = 2, name = "Riff") {
  return runCommand(doc, "clip.write", {
    track_id: trackId,
    scene_id: sceneId,
    name,
    length_bars: lengthBars,
    notes: [],
  }).args.clip_id;
}

/** A one-track, one-scene, one-clip song's ids. */
function placeable(doc, { bars = 2 } = {}) {
  const track = addTrack(doc);
  const scene = addScene(doc);
  const clip = addClip(doc, track, scene, bars);
  return { track, scene, clip };
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

/** @returns {object} the placements of the song's arrangement from a snapshot. */
function placementsOf(doc) {
  return snapshot(doc).arrangement.placements;
}

/** @returns {object} the one placement with this id, from a snapshot. */
function placementOf(doc, id) {
  return placementsOf(doc)[id];
}

test("place refuses overlap on a track", (t) => {
  const s = studio(t);
  const { track, clip } = placeable(s.doc);
  s.run("arrangement.place", { id: "p-a", track_id: track, clip_id: clip, start_bar: 0, bars: 2 });
  assert.deepEqual(placementOf(s.doc, "p-a"), {
    id: "p-a",
    track_id: track,
    clip_id: clip,
    start_bar: 0,
    bars: 2,
    offset_beats: 0,
    fade_in_beats: 0,
    fade_out_beats: 0,
  });

  // A clip that starts on top of another one on the same track is refused, and
  // the refusal leaves the arrangement exactly as it was.
  const overlap = refuses(
    () => s.run("arrangement.place", { id: "p-b", track_id: track, clip_id: clip, start_bar: 1, bars: 2 }),
    "invalid",
  );
  assert.match(overlap.message, /cannot overlap/);
  assert.deepEqual(Object.keys(placementsOf(s.doc)), ["p-a"]);

  // Touching is not overlapping: the next bar starts where the last one ends.
  s.run("arrangement.place", { id: "p-c", track_id: track, clip_id: clip, start_bar: 2, bars: 2 });
  assert.deepEqual(Object.keys(placementsOf(s.doc)).sort(), ["p-a", "p-c"]);

  // Moving the first one onto the second is refused for the same reason, and
  // moving it below zero never gets past the schema.
  refuses(() => s.run("arrangement.move", { id: "p-a", start_bar: 3 }), "invalid");
  refuses(() => s.run("arrangement.move", { id: "p-a", start_bar: -1 }), "invalid");
  // A resize that would grow into the next placement is refused too.
  refuses(() => s.run("arrangement.resize", { id: "p-a", bars: 4 }), "invalid");
  assert.deepEqual(placementOf(s.doc, "p-a").bars, 2);

  // Once the way is clear, all three edits land.
  const moved = s.run("arrangement.move", { id: "p-a", start_bar: 10 });
  assert.deepEqual(moved.result.after, { [`placement:p-a|start_bar`]: 10 });
  const resized = s.run("arrangement.resize", { id: "p-a", bars: 4 });
  assert.deepEqual(resized.result.after, { [`placement:p-a|bars`]: 4 });
  assert.deepEqual(checkInvariants(s.doc), []);
});

test("place refuses a clip of another track", (t) => {
  const s = studio(t);
  const bass = addTrack(s.doc, "Bass");
  const keys = addTrack(s.doc, "Keys");
  const scene = addScene(s.doc);
  const bassClip = addClip(s.doc, bass, scene, 2);
  const keysClip = addClip(s.doc, keys, scene, 2);

  const error = refuses(
    () => s.run("arrangement.place", { id: "p-a", track_id: keys, clip_id: bassClip, start_bar: 0 }),
    "invalid",
  );
  assert.match(error.message, /belongs to track/);
  assert.deepEqual(placementsOf(s.doc), {});

  // A placement plays a clip of its own track, so there is nothing that moves
  // it to another lane: `arrangement.move` takes a bar and nothing else.
  s.run("arrangement.place", { id: "p-a", track_id: keys, clip_id: keysClip, start_bar: 0 });
  refuses(() => s.run("arrangement.move", { id: "p-a", track_id: bass, start_bar: 4 }), "invalid");
  assert.equal(placementOf(s.doc, "p-a").track_id, keys);
  assert.equal(placementOf(s.doc, "p-a").start_bar, 0);

  // A placement of a clip whose track it is on moves along that track.
  s.run("arrangement.move", { id: "p-a", start_bar: 8 });
  assert.equal(placementOf(s.doc, "p-a").start_bar, 8);
  assert.equal(placementOf(s.doc, "p-a").track_id, keys);
  assert.deepEqual(checkInvariants(s.doc), []);
});

test("clip.remove also removes its placements and undo brings both back", (t) => {
  const s = studio(t);
  const { track, clip } = placeable(s.doc);
  s.run("arrangement.place", { id: "p-a", track_id: track, clip_id: clip, start_bar: 0 });
  s.run("arrangement.place", { id: "p-b", track_id: track, clip_id: clip, start_bar: 8 });

  const removed = s.run("clip.remove", { clip_id: clip });
  assert.equal(snapshot(s.doc).clips[clip], undefined);
  assert.deepEqual(placementsOf(s.doc), {});
  // Both placements are captured in the same step as the clip, so one undo
  // brings the clip and both blocks back together.
  assert.deepEqual(
    Object.keys(removed.result.before).sort(),
    [`clip:${clip}|*`, "placement:p-a|*", "placement:p-b|*"].sort(),
  );
  assert.ok(removed.result.touched.includes("placement:p-a"));
  assert.deepEqual(checkInvariants(s.doc), []);

  const undone = s.undo(removed.entry);
  assert.deepEqual(undone.plan.conflicts, []);
  assert.deepEqual(undone.plan.blocked, []);
  assert.equal(placementOf(s.doc, "p-a").start_bar, 0);
  assert.equal(placementOf(s.doc, "p-b").start_bar, 8);
  assert.equal(snapshot(s.doc).clips[clip].name, "Riff");
  assert.deepEqual(checkInvariants(s.doc), []);

  // A scene removal takes the clips of that scene and their placements with it.
  const gone = s.run("scene.remove", { scene_id: snapshot(s.doc).clips[clip].scene_id });
  assert.deepEqual(placementsOf(s.doc), {});
  const back = s.undo(gone.entry);
  assert.deepEqual(back.plan.conflicts, []);
  assert.deepEqual(Object.keys(placementsOf(s.doc)).sort(), ["p-a", "p-b"]);
});

test("track.remove removes its placements", (t) => {
  const s = studio(t);
  const { track, clip } = placeable(s.doc);
  const other = addTrack(s.doc, "Keys");
  const scene = snapshot(s.doc).scenes[0].id;
  const otherClip = addClip(s.doc, other, scene, 2);
  s.run("arrangement.place", { id: "p-a", track_id: track, clip_id: clip, start_bar: 0 });
  s.run("arrangement.place", { id: "p-b", track_id: other, clip_id: otherClip, start_bar: 0 });

  const removed = s.run("track.remove", { track_id: track });
  assert.deepEqual(Object.keys(placementsOf(s.doc)), ["p-b"], "the other track's placement stays");
  assert.ok("placement:p-a|*" in removed.result.before);
  assert.ok(removed.result.touched.includes("placement:p-a"));
  assert.deepEqual(checkInvariants(s.doc), []);

  const undone = s.undo(removed.entry);
  assert.deepEqual(undone.plan.conflicts, []);
  assert.deepEqual(undone.plan.blocked, []);
  assert.equal(placementOf(s.doc, "p-a").track_id, track);
  assert.equal(placementOf(s.doc, "p-a").clip_id, clip);
  assert.deepEqual(checkInvariants(s.doc), []);
});

test("split makes two placements that play the same audio", (t) => {
  const s = studio(t);
  const { track, clip } = placeable(s.doc, { bars: 2 });
  const clipBeats = 2 * 4;
  // One long block over a two-bar clip, with a fade at each end.
  const placed = s.run("arrangement.place", { id: "p-a", track_id: track, clip_id: clip, start_bar: 0, bars: 8 });
  s.run("arrangement.set_fades", { id: "p-a", fade_in_beats: 1, fade_out_beats: 1 });

  const split = s.run("arrangement.split", { id: "p-a", at_bar: 3, new_id: "p-a2" });
  const first = placementOf(s.doc, "p-a");
  const second = placementOf(s.doc, "p-a2");
  assert.deepEqual(first, {
    id: "p-a",
    track_id: track,
    clip_id: clip,
    start_bar: 0,
    bars: 3,
    offset_beats: 0,
    fade_in_beats: 1,
    fade_out_beats: 0,
  });
  // Three bars into a two-bar clip is eight beats past its start, which is the
  // clip's own start again — the clip loops.
  assert.equal(second.start_bar, 3);
  assert.equal(second.bars, 5);
  assert.equal(second.offset_beats, (0 + 3 * 4) % clipBeats);
  assert.equal(second.fade_in_beats, 0);
  assert.equal(second.fade_out_beats, 1);

  // The two halves tile the one block exactly: no gap, no repeat, and the
  // second one carries on where the first one stopped.
  assert.equal(second.start_bar, first.start_bar + first.bars);
  assert.equal(first.bars + second.bars, placed.result.after["placement:p-a|*"].bars);
  assert.equal(second.offset_beats, (first.offset_beats + first.bars * 4) % clipBeats);
  assert.deepEqual(split.result.before["placement:p-a|fade_out_beats"], 1);

  // A second split keeps tiling: the offset wraps and the bars add up.
  s.run("arrangement.split", { id: "p-a2", at_bar: 5, new_id: "p-a3" });
  const middle = placementOf(s.doc, "p-a2");
  const last = placementOf(s.doc, "p-a3");
  assert.equal(middle.bars, 2);
  assert.equal(middle.offset_beats, 4);
  assert.equal(last.start_bar, 5);
  assert.equal(last.bars, 3);
  assert.equal(last.offset_beats, (middle.offset_beats + middle.bars * 4) % clipBeats);
  assert.equal(middle.start_bar + middle.bars + last.bars, 8);

  // A split on the edge, or outside, is refused and writes nothing.
  refuses(() => s.run("arrangement.split", { id: "p-a", at_bar: 3 }), "invalid");
  refuses(() => s.run("arrangement.split", { id: "p-a", at_bar: 0 }), "invalid");
  assert.deepEqual(Object.keys(placementsOf(s.doc)).sort(), ["p-a", "p-a2", "p-a3"]);
  assert.deepEqual(checkInvariants(s.doc), []);
});

test("split clamps an outer fade to its half", (t) => {
  const s = studio(t);
  const { track, clip } = placeable(s.doc, { bars: 8 });

  // A twelve-beat fade in on a placement split after one bar: the first half is
  // only four beats long, so it keeps a four-beat fade rather than a fade
  // longer than itself.
  s.run("arrangement.place", { id: "p-a", track_id: track, clip_id: clip, start_bar: 0, bars: 8 });
  s.run("arrangement.set_fades", { id: "p-a", fade_in_beats: 12, fade_out_beats: 4 });
  const splitIn = s.run("arrangement.split", { id: "p-a", at_bar: 1, new_id: "p-b" });
  assert.equal(placementOf(s.doc, "p-a").bars, 1);
  assert.equal(placementOf(s.doc, "p-a").fade_in_beats, 4);
  assert.equal(placementOf(s.doc, "p-a").fade_out_beats, 0);
  assert.equal(placementOf(s.doc, "p-b").fade_out_beats, 4);
  // The clamped value is part of the step, so the undo puts the longer fade back.
  assert.equal(splitIn.result.before["placement:p-a|fade_in_beats"], 12);
  assert.equal(splitIn.result.after["placement:p-a|fade_in_beats"], 4);
  assert.deepEqual(checkInvariants(s.doc), []);

  // The same on the way out: a twelve-beat fade out on a placement whose last
  // half is one bar long keeps four beats of fade, recorded on the second half.
  s.run("arrangement.set_fades", { id: "p-b", fade_in_beats: 0, fade_out_beats: 12 });
  const splitOut = s.run("arrangement.split", { id: "p-b", at_bar: 7, new_id: "p-c" });
  assert.equal(placementOf(s.doc, "p-b").fade_out_beats, 0);
  assert.equal(placementOf(s.doc, "p-c").bars, 1);
  assert.equal(placementOf(s.doc, "p-c").fade_out_beats, 4);
  assert.equal(splitOut.result.after["placement:p-c|*"].fade_out_beats, 4);
  assert.deepEqual(checkInvariants(s.doc), []);
});

test("split names both halves in touched", (t) => {
  const s = studio(t);
  const { track, clip } = placeable(s.doc);
  s.run("arrangement.place", { id: "p-a", track_id: track, clip_id: clip, start_bar: 0, bars: 4 });

  // No `new_id`: the second half's id is decided before the lock and focus
  // checks run, so `touched` names the placement the split creates.
  const split = s.run("arrangement.split", { id: "p-a", at_bar: 2 });
  const secondId = split.result.args.new_id;
  assert.equal(typeof secondId, "string");
  assert.ok(secondId.length > 0);
  assert.deepEqual(split.result.touched, ["placement:p-a", `placement:${secondId}`]);
  assert.deepEqual(Object.keys(split.result.after), ["placement:p-a|bars", `placement:${secondId}|*`]);
  assert.deepEqual(Object.keys(placementsOf(s.doc)).sort(), ["p-a", secondId].sort());
});

test("set_length keeps a split placement editable", (t) => {
  const s = studio(t);
  const { track, clip } = placeable(s.doc, { bars: 2 });
  s.run("arrangement.place", { id: "p-a", track_id: track, clip_id: clip, start_bar: 0, bars: 8 });
  s.run("arrangement.split", { id: "p-a", at_bar: 1, new_id: "p-b" });
  assert.equal(placementOf(s.doc, "p-b").offset_beats, 4);

  // Shrinking the clip to one bar leaves the second half four beats into a
  // four-beat clip: its offset wraps to the clip's start in the same step,
  // instead of leaving the placement unable to move, resize or split at all.
  const shortened = s.run("clip.set_length", { clip_id: clip, length_bars: 1 });
  assert.equal(placementOf(s.doc, "p-b").offset_beats, 0);
  assert.deepEqual(shortened.result.after, {
    [`clip:${clip}|length_bars`]: 1,
    "placement:p-b|offset_beats": 0,
  });
  assert.ok(shortened.result.touched.includes("placement:p-b"));
  assert.deepEqual(checkInvariants(s.doc), []);

  // Every edit the second half can be asked to make now works on it.
  s.run("arrangement.move", { id: "p-b", start_bar: 2 });
  s.run("arrangement.resize", { id: "p-b", bars: 3 });
  s.run("arrangement.set_fades", { id: "p-b", fade_in_beats: 1, fade_out_beats: 1 });
  s.run("arrangement.split", { id: "p-b", at_bar: 3, new_id: "p-c" });
  assert.deepEqual(Object.keys(placementsOf(s.doc)).sort(), ["p-a", "p-b", "p-c"]);
  assert.deepEqual(checkInvariants(s.doc), []);

  // The wrap is part of the length step, so undoing it puts the offset back.
  const undone = s.undo(shortened.entry);
  assert.deepEqual(undone.plan.blocked, []);
  assert.equal(placementOf(s.doc, "p-b").offset_beats, 4);
  assert.equal(snapshot(s.doc).clips[clip].length_bars, 2);
  assert.deepEqual(checkInvariants(s.doc), []);
});

test("record_performance is one undo step", (t) => {
  const s = studio(t);
  const guitar = addTrack(s.doc, "Guitar");
  const bass = addTrack(s.doc, "Bass");
  const scene = addScene(s.doc);
  const guitarClip = addClip(s.doc, guitar, scene, 2);
  const bassClip = addClip(s.doc, bass, scene, 2);

  const performed = s.run("arrangement.record_performance", {
    placements: [
      { id: "perf-1", track_id: guitar, clip_id: guitarClip, start_bar: 0, bars: 2 },
      { id: "perf-2", track_id: bass, clip_id: bassClip, start_bar: 0, bars: 2 },
      { id: "perf-3", track_id: guitar, clip_id: guitarClip, start_bar: 2, bars: 2 },
    ],
  });
  assert.deepEqual(Object.keys(performed.result.after).sort(), [
    "placement:perf-1|*",
    "placement:perf-2|*",
    "placement:perf-3|*",
  ]);
  assert.deepEqual(Object.keys(placementsOf(s.doc)).sort(), ["perf-1", "perf-2", "perf-3"]);
  assert.match(performed.result.summary, /3 placements/);

  // A performance is all-or-nothing: one overlap and nothing is written.
  const before = placementsOf(s.doc);
  const overlap = refuses(
    () =>
      s.run("arrangement.record_performance", {
        placements: [
          { id: "perf-4", track_id: guitar, clip_id: guitarClip, start_bar: 20, bars: 2 },
          { id: "perf-5", track_id: guitar, clip_id: guitarClip, start_bar: 21, bars: 2 },
        ],
      }),
    "invalid",
  );
  assert.match(overlap.message, /overlap/);
  assert.deepEqual(placementsOf(s.doc), before);

  // One undo takes the whole performance back, one redo puts it back.
  const undone = s.undo(performed.entry);
  assert.deepEqual(undone.plan.conflicts, []);
  assert.deepEqual(undone.plan.blocked, []);
  assert.deepEqual(placementsOf(s.doc), {});
  const redone = s.redo(undone.entry);
  assert.deepEqual(redone.plan.conflicts, []);
  assert.deepEqual(Object.keys(placementsOf(s.doc)).sort(), ["perf-1", "perf-2", "perf-3"]);
  assert.deepEqual(checkInvariants(s.doc), []);

  // A performance that names none of its placements gets an id for each one
  // before the lock check runs, so `touched` names every object it creates.
  const unnamed = s.run("arrangement.record_performance", {
    placements: [{ track_id: guitar, clip_id: guitarClip, start_bar: 40, bars: 2 }],
  });
  const generated = unnamed.result.args.placements[0].id;
  assert.equal(typeof generated, "string");
  assert.ok(generated.length > 0);
  assert.ok(unnamed.result.touched.includes(`placement:${generated}`));
  assert.ok(`placement:${generated}|*` in unnamed.result.after);
  assert.deepEqual(Object.keys(placementsOf(s.doc)).sort(), ["perf-1", "perf-2", "perf-3", generated].sort());
  assert.deepEqual(checkInvariants(s.doc), []);
});

test("placement past bar 999 refused naming the limit", (t) => {
  const s = studio(t);
  const { track, clip } = placeable(s.doc);

  // The last bar of the arrangement is bar 999: a placement may end there.
  s.run("arrangement.place", { id: "last", track_id: track, clip_id: clip, start_bar: 998, bars: 1 });
  assert.equal(placementOf(s.doc, "last").start_bar, 998);

  const error = refuses(
    () => s.run("arrangement.place", { id: "past", track_id: track, clip_id: clip, start_bar: 998, bars: 4 }),
    "limit",
  );
  assert.match(error.message, /999/);
  assert.deepEqual(Object.keys(placementsOf(s.doc)), ["last"]);

  // Growing the placement that is already there past the end says the same.
  const grown = refuses(() => s.run("arrangement.resize", { id: "last", bars: 2 }), "limit");
  assert.match(grown.message, /999/);
  assert.equal(placementOf(s.doc, "last").bars, 1);

  // Markers and sections keep the same end, and the marker names the limit.
  const marker = refuses(() => s.run("marker.add", { bar: 1000, name: "Too far" }), "limit");
  assert.match(marker.message, /999/);
  const section = refuses(
    () => s.run("section.add", { start_bar: 990, end_bar: 1000, name: "Too long" }),
    "limit",
  );
  assert.match(section.message, /999/);
  assert.deepEqual(snapshot(s.doc).arrangement.markers, {});
  assert.deepEqual(snapshot(s.doc).arrangement.sections, {});
  assert.deepEqual(checkInvariants(s.doc), []);
});

test("2049th placement refused", (t) => {
  const doc = newSongDoc({ title: "Full arrangement" });
  t.after(() => doc.destroy());
  const scene = addScene(doc);

  // Sixteen tracks, 128 one-bar blocks each: 2048 placements, none overlapping.
  const lanes = [];
  for (let index = 0; index < LIMITS.tracks; index += 1) {
    const trackId = addTrack(doc, `Track ${index + 1}`);
    const clipId = addClip(doc, trackId, scene, 1, `Clip ${index + 1}`);
    lanes.push({ trackId, clipId });
  }
  for (const lane of lanes) {
    for (let bar = 0; bar < 128; bar += 1) {
      runCommand(doc, "arrangement.place", {
        track_id: lane.trackId,
        clip_id: lane.clipId,
        start_bar: bar,
        bars: 1,
      });
    }
  }
  assert.equal(placementEntries(doc).length, LIMITS.placements);
  assert.equal(Object.keys(placementsOf(doc)).length, 2048);
  assert.deepEqual(checkInvariants(doc), []);

  const first = lanes[0];
  const error = refuses(
    () =>
      runCommand(doc, "arrangement.place", {
        track_id: first.trackId,
        clip_id: first.clipId,
        start_bar: 500,
        bars: 1,
      }),
    "limit",
  );
  assert.match(error.message, /2048 placements/);
  assert.equal(placementEntries(doc).length, 2048);
});

test("an old song with no arrangement reads empty", (t) => {
  const doc = newSongDoc({ title: "Older song" });
  t.after(() => doc.destroy());

  // A song written before the timeline existed has no arrangement container at
  // all. Every reader treats that as an empty arrangement instead of failing.
  songMap(doc).delete("arrangement");
  assert.deepEqual(snapshot(doc).arrangement, { placements: {}, markers: {}, sections: {} });
  assert.deepEqual(placementEntries(doc), []);
  assert.equal(getPlacement(doc, "p-a"), null);
  assert.strictEqual(readField(doc, "placement:p-a", "*"), null);
  assert.strictEqual(readField(doc, "marker:m-a", "*"), null);
  assert.strictEqual(readField(doc, "section:s-a", "*"), null);
  assert.deepEqual(checkInvariants(doc), []);

  // The first placement makes the containers, the same way a first take makes
  // the takes map.
  const { track, clip } = placeable(doc);
  runCommand(doc, "arrangement.place", { id: "p-a", track_id: track, clip_id: clip, start_bar: 0, bars: 2 });
  runCommand(doc, "marker.add", { id: "m-a", bar: 2, name: "Chorus" });
  runCommand(doc, "section.add", { id: "s-a", start_bar: 0, end_bar: 2, name: "Verse" });
  assert.deepEqual(Object.keys(snapshot(doc).arrangement.placements), ["p-a"]);
  assert.deepEqual(readField(doc, "marker:m-a", "*"), { id: "m-a", bar: 2, name: "Chorus" });
  assert.deepEqual(readField(doc, "section:s-a", "end_bar"), 2);
  assert.deepEqual(checkInvariants(doc), []);

  // And a song whose arrangement is taken away again simply has none.
  songMap(doc).delete("arrangement");
  assert.deepEqual(snapshot(doc).arrangement, { placements: {}, markers: {}, sections: {} });
  assert.deepEqual(checkInvariants(doc), []);
});

test("sections cannot overlap", (t) => {
  const s = studio(t);
  s.run("section.add", { id: "s-verse", start_bar: 0, end_bar: 8, name: "Verse" });
  assert.deepEqual(readField(s.doc, "section:s-verse", "*"), {
    id: "s-verse",
    start_bar: 0,
    end_bar: 8,
    name: "Verse",
  });

  const error = refuses(
    () => s.run("section.add", { id: "s-chorus", start_bar: 4, end_bar: 12, name: "Chorus" }),
    "invalid",
  );
  assert.match(error.message, /overlap/);
  assert.deepEqual(Object.keys(snapshot(s.doc).arrangement.sections), ["s-verse"]);

  // Touching sections are fine, and so is one that fits in the gap.
  s.run("section.add", { id: "s-chorus", start_bar: 8, end_bar: 16, name: "Chorus" });
  // Moving a section onto its neighbour is refused, as is a backwards range.
  refuses(() => s.run("section.set", { id: "s-chorus", start_bar: 4 }), "invalid");
  refuses(() => s.run("section.set", { id: "s-chorus", end_bar: 8 }), "invalid");
  const renamed = s.run("section.set", { id: "s-chorus", name: "Big chorus" });
  assert.deepEqual(renamed.result.after, { "section:s-chorus|name": "Big chorus" });
  // A move into free space lands, and so does one onto its own old range.
  s.run("section.set", { id: "s-chorus", start_bar: 20, end_bar: 28 });
  assert.equal(readField(s.doc, "section:s-chorus", "start_bar"), 20);

  // A section that ends past the last bar names the limit.
  refuses(() => s.run("section.set", { id: "s-chorus", end_bar: 1000 }), "limit");
  assert.equal(readField(s.doc, "section:s-chorus", "end_bar"), 28);
  assert.deepEqual(checkInvariants(s.doc), []);

  // Removing one leaves the other, and undo puts it back.
  const removed = s.run("section.remove", { id: "s-verse" });
  assert.deepEqual(Object.keys(snapshot(s.doc).arrangement.sections), ["s-chorus"]);
  const undone = s.undo(removed.entry);
  assert.deepEqual(undone.plan.conflicts, []);
  assert.deepEqual(Object.keys(snapshot(s.doc).arrangement.sections).sort(), ["s-chorus", "s-verse"]);
});

/** A scratch libsql client for one test, closed when the test ends. */
function scratchDb(t) {
  const db = createClient({ url: "file:" + join(mkdtempSync(join(tmpdir(), "studio-")), "crow.db") });
  t.after(() => db.close());
  return db;
}

/** A project ACL that knows one project and grants every capability in it. */
function fakeAcl() {
  const known = new Set([PROJECT]);
  return {
    async assertProjectExists(db, projectId) {
      const id = Number(projectId);
      if (!known.has(id)) throw new AclError(`Project #${projectId} not found`, "not_found");
      return { id };
    },
    async assertCapability(db, projectId, contactId, capability) {
      return this.assertProjectExists(db, projectId).then(() => ({
        role: "owner",
        capabilities: { [capability]: true },
      }));
    },
    async appendAudit() {},
  };
}

/** A scratch database with the Studio tables, and a hub on it. */
async function hubSetup(t) {
  const db = scratchDb(t);
  await initStudioTables(db);
  const hub = createHub({ db, acl: fakeAcl() });
  return { db, hub };
}

/** Assert a hub result is a refusal with this code, and return it. */
function refusesResult(result, code) {
  assert.equal(result.ok, false, `expected a refusal, got ${JSON.stringify(result)}`);
  assert.equal(result.code, code, `expected code "${code}", got "${result.code}": ${result.error}`);
  return result;
}

test("a locked track's placements are refused to an agent", async (t) => {
  const { hub } = await hubSetup(t);
  const created = await hub.createSong({ project_id: PROJECT, title: "Locked timeline", author: HUMAN });
  assert.equal(created.ok, true, `createSong was refused: ${created.error}`);
  const song_id = created.song_id;

  const run = (command, args, author, cmd_id) =>
    hub.runCommand({ song_id, cmd_id, command, args, author });

  assert.equal((await run("track.add", { id: "guitar", name: "Guitar", kind: "audio" }, HUMAN, "lock-1")).ok, true);
  assert.equal((await run("scene.add", { id: "verse", name: "Verse" }, HUMAN, "lock-2")).ok, true);
  assert.equal(
    (
      await run(
        "clip.add_audio",
        { clip_id: "gtr-verse", track_id: "guitar", scene_id: "verse", length_bars: 2 },
        HUMAN,
        "lock-3",
      )
    ).ok,
    true,
  );
  assert.equal(
    (
      await run(
        "arrangement.place",
        { id: "p-a", track_id: "guitar", clip_id: "gtr-verse", start_bar: 0, bars: 2 },
        HUMAN,
        "lock-4",
      )
    ).ok,
    true,
  );
  assert.equal((await run("track.lock", { track_id: "guitar" }, HUMAN, "lock-5")).ok, true);

  // Every arrangement command that names the locked track's lane is refused for
  // an agent, and the refusal says which track.
  const refused = refusesResult(
    await run(
      "arrangement.place",
      { id: "p-b", track_id: "guitar", clip_id: "gtr-verse", start_bar: 8, bars: 2 },
      AGENT,
      "lock-6",
    ),
    "locked",
  );
  assert.equal(refused.error, 'Track "Guitar" is locked by the operator.');

  // A placement of the locked track maps to that track for the lock check, so
  // editing it is refused even though the command names only the placement.
  for (const [cmd_id, command, args] of [
    ["lock-7", "arrangement.move", { id: "p-a", start_bar: 4 }],
    ["lock-8", "arrangement.resize", { id: "p-a", bars: 1 }],
    ["lock-9", "arrangement.split", { id: "p-a", at_bar: 1 }],
    ["lock-10", "arrangement.set_fades", { id: "p-a", fade_in_beats: 1, fade_out_beats: 1 }],
    ["lock-11", "arrangement.remove", { id: "p-a" }],
    [
      "lock-12",
      "arrangement.record_performance",
      { placements: [{ track_id: "guitar", clip_id: "gtr-verse", start_bar: 16, bars: 2 }] },
    ],
  ]) {
    refusesResult(await run(command, args, AGENT, cmd_id), "locked");
  }

  // Markers and sections belong to no track, so the lock does not reach them.
  assert.equal((await run("marker.add", { id: "m-a", bar: 4, name: "Bridge" }, AGENT, "lock-13")).ok, true);
  assert.equal(
    (await run("section.add", { id: "s-a", start_bar: 0, end_bar: 8, name: "Verse" }, AGENT, "lock-14")).ok,
    true,
  );

  // The song is exactly as the operator left it, and the agent gets through
  // once the track is unlocked.
  const opened = await hub.openSong(song_id);
  assert.deepEqual(Object.keys(opened.snapshot.arrangement.placements), ["p-a"]);
  assert.equal(opened.snapshot.arrangement.placements["p-a"].start_bar, 0);
  assert.equal((await run("track.unlock", { track_id: "guitar" }, HUMAN, "lock-15")).ok, true);
  assert.equal(
    (await run("arrangement.move", { id: "p-a", start_bar: 4 }, AGENT, "lock-16")).ok,
    true,
  );
  const after = await hub.openSong(song_id);
  assert.equal(after.snapshot.arrangement.placements["p-a"].start_bar, 4);
});