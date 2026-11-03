/**
 * Studio takes in the document: audio tracks and clips, recorded takes, and
 * the comp that says which take plays over which beats — plus the parts of the
 * shared history a take depends on.
 *
 * Every test builds its own song in memory and records its steps the way the
 * session hub does: one real registry command inside one `doc.transact(...)`
 * per step, undone through `history.js`. Nothing here touches a database or a
 * running instance.
 *
 * The hub side of Task 1 — the `internal` refusal, the agent take-loss guard and
 * the MCP/GUI surface — needs the real hub and a scratch database, so those
 * tests live in `tests/studio-hub.test.js`, `tests/studio-parity.test.js` and
 * `tests/studio-mcp.test.js`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  AUDIO_DEVICE,
  LIMITS,
  checkInvariants,
  newSongDoc,
  readField,
  snapshot,
  songMap,
  takesForClip,
} from "../bundles/studio/server/doc.js";
import { StudioError, runCommand } from "../bundles/studio/server/commands/registry.js";
import "../bundles/studio/server/commands/core.js";
import "../bundles/studio/server/commands/takes.js";
import {
  applyPlan,
  makeEntry,
  makeUndoEntry,
  planRedo,
  planUndo,
  REDO_COMMAND,
} from "../bundles/studio/server/history.js";

/** The song every entry in a test belongs to. */
const SONG_ID = "song-1";

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
  const doc = newSongDoc({ title: "Takes song" });
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

/** Add an audio track and return its id. */
function addAudioTrack(doc, name = "Guitar") {
  return runCommand(doc, "track.add", { name, kind: "audio" }).args.id;
}

/** Add a scene and return its id. */
function addScene(doc, name = "Verse") {
  return runCommand(doc, "scene.add", { name }).args.id;
}

/** Add an audio clip and return its id. */
function addAudioClip(doc, trackId, sceneId, lengthBars = 2) {
  return runCommand(doc, "clip.add_audio", {
    track_id: trackId,
    scene_id: sceneId,
    length_bars: lengthBars,
    name: "Guitar take",
  }).args.clip_id;
}

/**
 * The take object `take.add` accepts, with its id generated the way the
 * recording client does.
 * @param {object} [overrides]
 * @returns {object}
 */
function take(overrides = {}) {
  const id = overrides.id ?? randomUUID();
  return {
    id,
    storage_key: `studio/song-1/takes/${id}.wav`,
    rate: 48000,
    channels: 2,
    frames: 48000,
    offset_frames: 0,
    compensated: false,
    bpm: 120,
    recorded_at: "2026-11-02T12:00:00.000Z",
    author_label: "the operator",
    discarded: false,
    ...overrides,
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

/** @returns {object} the clip from the snapshot. */
function clipOf(doc, clipId) {
  return snapshot(doc).clips[clipId];
}

/** @returns {object} the take from the snapshot. */
function takeOf(doc, takeId) {
  return snapshot(doc).takes[takeId];
}

test("audio track refuses set_device", (t) => {
  const s = studio(t);
  const id = addAudioTrack(s.doc);
  assert.deepEqual(snapshot(s.doc).tracks[0].device, AUDIO_DEVICE);
  assert.equal("params" in snapshot(s.doc).tracks[0].device, false);

  const swapped = refuses(
    () => s.run("track.set_device", { track_id: id, type: "SpectraVoice" }),
    "invalid",
  );
  assert.match(swapped.message, /audio track/);

  const controller = refuses(
    () => s.run("track.set_param", { track_id: id, name: "Cutoff", value: 40 }),
    "invalid",
  );
  assert.match(controller.message, /audio track/);

  // The refusals wrote nothing.
  assert.deepEqual(snapshot(s.doc).tracks[0].device, AUDIO_DEVICE);

  // An audio track with a SunVox device is refused, not quietly ignored.
  refuses(
    () => s.run("track.add", { name: "Keys", kind: "audio", device: { type: "Analog generator" } }),
    "invalid",
  );
});

test("clip.write on an audio clip is refused", (t) => {
  const s = studio(t);
  const track = addAudioTrack(s.doc);
  const scene = addScene(s.doc);
  const clip = addAudioClip(s.doc, track, scene);

  const written = refuses(
    () =>
      s.run("clip.write", {
        clip_id: clip,
        track_id: track,
        scene_id: scene,
        name: "Guitar take",
        notes: [{ t: 0, d: 1, p: 60, v: 100 }],
      }),
    "invalid",
  );
  assert.match(written.message, /recorded takes/);

  // The same goes for a brand-new clip on an audio track, and for notes edits.
  refuses(
    () =>
      s.run("clip.write", {
        track_id: track,
        scene_id: scene,
        name: "Ghost notes",
        notes: [],
      }),
    "invalid",
  );
  refuses(
    () => s.run("clip.edit_notes", { clip_id: clip, add: [{ t: 0, d: 1, p: 60, v: 100 }] }),
    "invalid",
  );

  assert.deepEqual(clipOf(s.doc, clip).notes, []);
  assert.deepEqual(snapshot(s.doc).clips[clip].kind, "audio");
});

test("first take becomes the comp", (t) => {
  const s = studio(t);
  const track = addAudioTrack(s.doc);
  const scene = addScene(s.doc);
  const clip = addAudioClip(s.doc, track, scene, 2);
  const first = take();

  const added = s.run("take.add", { clip_id: clip, take: first });
  assert.deepEqual(added.result.before[`clip:${clip}|comp`], []);
  assert.deepEqual(added.result.after[`clip:${clip}|comp`], [
    { take_id: first.id, from_beat: 0, to_beat: 8 },
  ]);

  assert.deepEqual(clipOf(s.doc, clip).comp, [{ take_id: first.id, from_beat: 0, to_beat: 8 }]);
  assert.deepEqual(takeOf(s.doc, first.id), { ...first, clip_id: clip, discarded: false });

  // A second take leaves the comp alone: the first recording stays audible
  // until somebody comps.
  const second = take();
  const again = s.run("take.add", { clip_id: clip, take: second });
  assert.deepEqual(clipOf(s.doc, clip).comp, [{ take_id: first.id, from_beat: 0, to_beat: 8 }]);
  assert.equal(`clip:${clip}|comp` in again.result.after, false);
  assert.deepEqual(Object.keys(snapshot(s.doc).takes).sort(), [first.id, second.id].sort());
  assert.deepEqual(checkInvariants(s.doc), []);
});

test("take.discard removes its segments and undo restores both", (t) => {
  const s = studio(t);
  const track = addAudioTrack(s.doc);
  const scene = addScene(s.doc);
  const clip = addAudioClip(s.doc, track, scene, 2);
  const first = take();
  const second = take();
  s.run("take.add", { clip_id: clip, take: first });
  s.run("take.add", { clip_id: clip, take: second });
  const comp = [
    { take_id: first.id, from_beat: 0, to_beat: 4 },
    { take_id: second.id, from_beat: 4, to_beat: 8 },
  ];
  s.run("clip.set_comp", { clip_id: clip, segments: comp });

  const discarded = s.run("take.discard", { clip_id: clip, take_id: first.id });
  assert.equal(takeOf(s.doc, first.id).discarded, true);
  assert.deepEqual(clipOf(s.doc, clip).comp, [{ take_id: second.id, from_beat: 4, to_beat: 8 }]);
  assert.deepEqual(discarded.result.after[`clip:${clip}|comp`], [
    { take_id: second.id, from_beat: 4, to_beat: 8 },
  ]);
  assert.deepEqual(discarded.result.after[`take:${first.id}|discarded`], true);

  // Discarding it twice is a refusal, not a second segment removal.
  refuses(() => s.run("take.discard", { clip_id: clip, take_id: first.id }), "invalid");

  const undone = s.undo(discarded.entry);
  assert.deepEqual(undone.plan.conflicts, []);
  assert.deepEqual(undone.plan.blocked, []);
  assert.equal(takeOf(s.doc, first.id).discarded, false);
  assert.deepEqual(clipOf(s.doc, clip).comp, comp);

  // Restoring by hand puts the flag back without the segments.
  s.run("take.discard", { clip_id: clip, take_id: first.id });
  s.run("take.restore", { clip_id: clip, take_id: first.id });
  assert.equal(takeOf(s.doc, first.id).discarded, false);
  assert.deepEqual(clipOf(s.doc, clip).comp, [{ take_id: second.id, from_beat: 4, to_beat: 8 }]);
});

test("clip.set_comp refuses overlapping segments", (t) => {
  const s = studio(t);
  const track = addAudioTrack(s.doc);
  const scene = addScene(s.doc);
  const clip = addAudioClip(s.doc, track, scene, 2);
  const first = take();
  s.run("take.add", { clip_id: clip, take: first });

  const overlap = refuses(
    () =>
      s.run("clip.set_comp", {
        clip_id: clip,
        segments: [
          { take_id: first.id, from_beat: 0, to_beat: 4 },
          { take_id: first.id, from_beat: 3, to_beat: 6 },
        ],
      }),
    "invalid",
  );
  assert.match(overlap.message, /cannot overlap/);

  // Out of order, out of the clip, and a take of another clip are refused too.
  refuses(
    () =>
      s.run("clip.set_comp", {
        clip_id: clip,
        segments: [
          { take_id: first.id, from_beat: 4, to_beat: 6 },
          { take_id: first.id, from_beat: 0, to_beat: 2 },
        ],
      }),
    "invalid",
  );
  const outside = refuses(
    () => s.run("clip.set_comp", { clip_id: clip, segments: [{ take_id: first.id, from_beat: 0, to_beat: 9 }] }),
    "invalid",
  );
  assert.match(outside.message, /outside the 2 bars/);

  const otherTrack = addAudioTrack(s.doc, "Vocal");
  const otherScene = addScene(s.doc, "Chorus");
  const otherClip = addAudioClip(s.doc, otherTrack, otherScene, 1);
  const stranger = take();
  s.run("take.add", { clip_id: otherClip, take: stranger });
  const foreign = refuses(
    () => s.run("clip.set_comp", { clip_id: clip, segments: [{ take_id: stranger.id, from_beat: 0, to_beat: 2 }] }),
    "invalid",
  );
  assert.match(foreign.message, /not a take of that clip/);

  // The refused edits left the comp the first take made.
  assert.deepEqual(clipOf(s.doc, clip).comp, [{ take_id: first.id, from_beat: 0, to_beat: 8 }]);
});

test("clip.set_comp refuses a discarded take", (t) => {
  const s = studio(t);
  const track = addAudioTrack(s.doc);
  const scene = addScene(s.doc);
  const clip = addAudioClip(s.doc, track, scene, 2);
  const first = take();
  s.run("take.add", { clip_id: clip, take: first });
  s.run("take.discard", { clip_id: clip, take_id: first.id });

  const error = refuses(
    () => s.run("clip.set_comp", { clip_id: clip, segments: [{ take_id: first.id, from_beat: 0, to_beat: 4 }] }),
    "invalid",
  );
  assert.match(error.message, /discarded/);
  assert.deepEqual(clipOf(s.doc, clip).comp, []);
});

test("65th take is refused naming 64 takes", (t) => {
  const s = studio(t);
  const track = addAudioTrack(s.doc);
  const scene = addScene(s.doc);
  const clip = addAudioClip(s.doc, track, scene, 2);
  for (let index = 0; index < LIMITS.takesPerClip; index += 1) {
    s.run("take.add", { clip_id: clip, take: take() }, AGENT);
  }
  assert.equal(takesForClip(s.doc, clip).length, LIMITS.takesPerClip);

  const error = refuses(() => s.run("take.add", { clip_id: clip, take: take() }), "limit");
  assert.match(error.message, /64 takes/);
  assert.equal(takesForClip(s.doc, clip).length, 64);
  assert.equal(Object.keys(snapshot(s.doc).takes).length, 64);
});

test("take.add after a concurrent comp edit keeps both", (t) => {
  const s = studio(t);
  const track = addAudioTrack(s.doc);
  const scene = addScene(s.doc);
  const clip = addAudioClip(s.doc, track, scene, 2);
  const first = take();
  s.run("take.add", { clip_id: clip, take: first });

  // Someone comps the clip while a second recording is being uploaded.
  const comp = [{ take_id: first.id, from_beat: 0, to_beat: 2 }];
  s.run("clip.set_comp", { clip_id: clip, segments: comp });

  const second = take();
  const added = s.run("take.add", { clip_id: clip, take: second }, AGENT);
  assert.equal(takeOf(s.doc, second.id).clip_id, clip);
  assert.deepEqual(clipOf(s.doc, clip).comp, comp);
  // The step did not touch the comp, so there is nothing for its undo to fight
  // the concurrent edit over.
  assert.equal(`clip:${clip}|comp` in added.entry.inverse.before, false);

  const undone = s.undo(added.entry);
  assert.deepEqual(undone.plan.conflicts, []);
  assert.equal(takeOf(s.doc, second.id), undefined);
  assert.deepEqual(clipOf(s.doc, clip).comp, comp);
  assert.ok(takeOf(s.doc, first.id));
});

test("undo of an older take.set_offset is not blocked by a newer take", (t) => {
  const s = studio(t);
  const track = addAudioTrack(s.doc);
  const scene = addScene(s.doc);
  const clip = addAudioClip(s.doc, track, scene, 2);
  const first = take();
  s.run("take.add", { clip_id: clip, take: first });
  const offset = s.run(
    "take.set_offset",
    { clip_id: clip, take_id: first.id, offset_frames: 2990, compensated: true },
    AGENT,
  );

  // A newer take lands after the offset was set. Each take is its own object,
  // so it is not in the older step's way.
  const second = take();
  s.run("take.add", { clip_id: clip, take: second }, AGENT);

  const undone = s.undo(offset.entry);
  assert.deepEqual(undone.plan.conflicts, []);
  assert.deepEqual(undone.plan.blocked, []);
  assert.deepEqual([...undone.plan.apply.keys()].sort(), [
    `take:${first.id}|compensated`,
    `take:${first.id}|offset_frames`,
  ]);
  assert.equal(takeOf(s.doc, first.id).offset_frames, 0);
  assert.equal(takeOf(s.doc, first.id).compensated, false);
  assert.ok(takeOf(s.doc, second.id));

  // Redoing it puts the calibrated offset back on the older take only.
  const redone = s.redo(undone.entry);
  assert.deepEqual(redone.plan.conflicts, []);
  assert.equal(takeOf(s.doc, first.id).offset_frames, 2990);
  assert.equal(takeOf(s.doc, first.id).compensated, true);
  assert.equal(takeOf(s.doc, second.id).offset_frames, 0);
});

test("uncompensated take can be re-offset and undone", (t) => {
  const s = studio(t);
  const track = addAudioTrack(s.doc);
  const scene = addScene(s.doc);
  const clip = addAudioClip(s.doc, track, scene, 2);
  const recorded = take({ offset_frames: 0, compensated: false });
  s.run("take.add", { clip_id: clip, take: recorded });
  assert.equal(takeOf(s.doc, recorded.id).compensated, false);
  assert.equal(takeOf(s.doc, recorded.id).offset_frames, 0);

  // Calibrating later corrects the take as one undoable step.
  const fix = s.run(
    "take.set_offset",
    { clip_id: clip, take_id: recorded.id, offset_frames: 2630, compensated: true },
  );
  assert.equal(readField(s.doc, `take:${recorded.id}`, "offset_frames"), 2630);
  assert.equal(readField(s.doc, `take:${recorded.id}`, "compensated"), true);

  // An offset is cut from the take's start, so it cannot reach its end.
  refuses(
    () =>
      s.run("take.set_offset", {
        clip_id: clip,
        take_id: recorded.id,
        offset_frames: recorded.frames,
        compensated: true,
      }),
    "invalid",
  );

  const undone = s.undo(fix.entry);
  assert.deepEqual(undone.plan.conflicts, []);
  assert.equal(takeOf(s.doc, recorded.id).offset_frames, 0);
  assert.equal(takeOf(s.doc, recorded.id).compensated, false);
  assert.deepEqual(checkInvariants(s.doc), []);
});

test("human clip.remove of a clip with takes works and undo restores the takes", (t) => {
  const s = studio(t);
  const track = addAudioTrack(s.doc);
  const scene = addScene(s.doc);
  const clip = addAudioClip(s.doc, track, scene, 2);
  const first = take();
  const second = take();
  s.run("take.add", { clip_id: clip, take: first });
  s.run("take.add", { clip_id: clip, take: second });
  const comp = [
    { take_id: first.id, from_beat: 0, to_beat: 4 },
    { take_id: second.id, from_beat: 4, to_beat: 8 },
  ];
  s.run("clip.set_comp", { clip_id: clip, segments: comp });

  const removed = s.run("clip.remove", { clip_id: clip });
  assert.equal(snapshot(s.doc).clips[clip], undefined);
  assert.deepEqual(Object.keys(snapshot(s.doc).takes), []);
  assert.deepEqual(
    Object.keys(removed.result.before).sort(),
    [`clip:${clip}|*`, `take:${first.id}|*`, `take:${second.id}|*`].sort(),
  );
  assert.ok(removed.result.touched.includes(`take:${second.id}`));

  const undone = s.undo(removed.entry);
  assert.deepEqual(undone.plan.conflicts, []);
  assert.deepEqual(undone.plan.blocked, []);
  assert.deepEqual(clipOf(s.doc, clip).comp, comp);
  assert.deepEqual(takeOf(s.doc, first.id), { ...first, clip_id: clip, discarded: false });
  assert.deepEqual(takeOf(s.doc, second.id), { ...second, clip_id: clip, discarded: false });
  assert.deepEqual(checkInvariants(s.doc), []);

  // Removing the whole track takes the clip and its takes with it, and one
  // undo brings all three back.
  const goneTrack = s.run("track.remove", { track_id: track });
  assert.deepEqual(Object.keys(snapshot(s.doc).takes), []);
  assert.ok(`take:${first.id}|*` in goneTrack.result.before);
  const back = s.undo(goneTrack.entry);
  assert.deepEqual(back.plan.conflicts, []);
  assert.deepEqual(back.plan.blocked, []);
  assert.deepEqual(takeOf(s.doc, first.id).clip_id, clip);
  assert.deepEqual(clipOf(s.doc, clip).comp, comp);
});

test("an old song with no takes container reads empty", (t) => {
  const doc = newSongDoc({ title: "Older song" });
  t.after(() => doc.destroy());

  // A song written before 1b has no takes container at all. Every reader
  // treats that as an empty map instead of failing.
  songMap(doc).delete("takes");
  assert.deepEqual(snapshot(doc).takes, {});
  assert.deepEqual(takesForClip(doc, "any-clip"), []);
  assert.strictEqual(
    readField(doc, "take:6f1c1f7a-8f7e-4a4e-9a1d-2b3c4d5e6f70", "*"),
    null,
  );
  assert.deepEqual(checkInvariants(doc), []);

  // Recording the first take makes the container, the same way any other
  // write to it would.
  const track = addAudioTrack(doc);
  const scene = addScene(doc);
  const clip = addAudioClip(doc, track, scene, 1);
  const fresh = take();
  runCommand(doc, "take.add", { clip_id: clip, take: fresh });
  assert.deepEqual(Object.keys(snapshot(doc).takes), [fresh.id]);
  assert.deepEqual(snapshot(doc).clips[clip].comp, [{ take_id: fresh.id, from_beat: 0, to_beat: 4 }]);
  assert.deepEqual(checkInvariants(doc), []);
});