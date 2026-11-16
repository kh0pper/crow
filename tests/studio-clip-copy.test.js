/**
 * Studio's copy-to-scene: one pattern clip copied into another scene of its own
 * track, with its patterns, steps, locks, motion lanes, chain, swing and loop.
 *
 * Most tests build their own song in memory and record their steps the way the
 * session hub does: one real registry command inside one `doc.transact(...)` per
 * step, undone through `history.js`. Two cases need more than a document: the
 * lock refusal runs the real hub over a scratch database, and the tool-list case
 * opens the MCP server over an in-memory transport.
 *
 * "The copy plays the same steps" reads the sequencer both hosts read the song
 * through — the pure event generator, not a render — and compares the pad
 * triggers of one full chain cycle played from the original and from the copy.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AclError } from "../servers/shared/project-acl.js";

// The very module instance `server/doc.js` gets from `import * as Y from "yjs"`:
// the package's ESM build, not the CommonJS one.
import * as Y from "../bundles/studio/node_modules/yjs/dist/yjs.mjs";
import {
  checkInvariants,
  newSongDoc,
  patternKey,
  snapshot,
  stepKey,
} from "../bundles/studio/server/doc.js";
import { StudioError, listCommands, runCommand } from "../bundles/studio/server/commands/registry.js";
import "../bundles/studio/server/commands/core.js";
import "../bundles/studio/server/commands/takes.js";
import "../bundles/studio/server/commands/arrangement.js";
import "../bundles/studio/server/commands/sampler.js";
import { createHub } from "../bundles/studio/server/hub.js";
import { createStudioServer } from "../bundles/studio/server/mcp.js";
import { initStudioTables } from "../bundles/studio/server/init-tables.js";
import {
  REDO_COMMAND,
  applyPlan,
  makeEntry,
  makeUndoEntry,
  planRedo,
  planUndo,
} from "../bundles/studio/server/history.js";
import { COMMANDS } from "../bundles/studio/panel/client.js";

const require = createRequire(import.meta.url);
const StudioSequencer = require("../bundles/studio/engine/sequencer.js");

/** The song every entry in a test belongs to. */
const SONG_ID = "song-1";

/** The project the hub case's song belongs to. */
const PROJECT = 21;

/** A GUI command's author, per the plan's attribution rule. */
const HUMAN = { kind: "human", id: "local", label: "You" };

/** An MCP command's author, per the plan's attribution rule. */
const AGENT = { kind: "agent", id: "mcp", label: "Agent (MCP)" };

/** The sequencer plays at 48 kHz, and 120 bpm makes one beat 24,000 frames. */
const SAMPLE_RATE = 48000;
const FRAMES_PER_BEAT = 24000;

/**
 * A scratch song plus the two calls a hub makes: run a command and record its
 * entry, then undo or redo one recorded entry.
 * @param {import("node:test").TestContext} t
 * @param {string} [title]
 */
function studio(t, title = "Copy song") {
  const doc = newSongDoc({ title });
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
    run(id, args, author = HUMAN) {
      const result = doc.transact(() => runCommand(doc, id, args));
      return { result, entry: record(result, author) };
    },
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

/** Add a scene and return its id. */
function addScene(doc, name) {
  return runCommand(doc, "scene.add", { name }).args.id;
}

/** Add a sampler track, and return its id and its one bank's id. */
function addKit(doc, name = "Kit") {
  const trackId = runCommand(doc, "track.add", { name, kind: "sampler" }).args.id;
  const bank = Object.values(snapshot(doc).banks).find((item) => item.track_id === trackId);
  return { trackId, bankId: bank.id };
}

/** Add a pattern clip on a sampler track and return its id. */
function addPatternClip(doc, trackId, sceneId, extra = {}) {
  return runCommand(doc, "clip.add_pattern", {
    track_id: trackId,
    scene_id: sceneId,
    name: "Kit loop",
    ...extra,
  }).args.clip_id;
}

/**
 * A second instance of the same song, synced the way two peers are: one shared
 * update at a time, never a whole-document overwrite.
 * @param {import("node:test").TestContext} t
 * @param {{doc: import("yjs").Doc}} s the first peer's studio harness
 * @returns {{other: import("yjs").Doc, sync: function(): void}}
 */
function pair(t, s) {
  const other = new Y.Doc();
  t.after(() => other.destroy());
  const sync = () => {
    Y.applyUpdate(other, Y.encodeStateAsUpdate(s.doc, Y.encodeStateVector(other)));
    Y.applyUpdate(s.doc, Y.encodeStateAsUpdate(other, Y.encodeStateVector(s.doc)));
  };
  sync();
  return { other, sync };
}

/**
 * Play one clip through the sequencer for a number of frames and return the
 * events it emitted, at absolute frames. Only the pad triggers are kept: motion
 * is a descriptor rather than an event (see engine/sequencer.js).
 * @param {object} song - a snapshot
 * @param {string} clipId
 * @param {number} frames
 * @returns {object[]}
 */
function playClip(song, clipId, frames) {
  const seq = StudioSequencer.create({ sampleRate: SAMPLE_RATE });
  seq.setSong(song);
  seq.launchClip(clipId);
  seq.play();
  const out = [];
  let at = 0;
  while (at < frames) {
    const size = Math.min(128, frames - at);
    for (const event of seq.block(at, size)) {
      if (event.type !== "pad") continue;
      out.push({ ...event, frame: at + event.frame });
    }
    at += size;
  }
  return out;
}

/** The ids of the clips a song holds in one track's cell of one scene. */
function clipsInCell(song, trackId, sceneId) {
  return Object.values(song.clips)
    .filter((clip) => clip.track_id === trackId && clip.scene_id === sceneId)
    .map((clip) => clip.id)
    .sort();
}

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

test("the copy is independent of its original", (t) => {
  const s = studio(t);
  const { trackId, bankId } = addKit(s.doc);
  const verse = addScene(s.doc, "Verse");
  const chorus = addScene(s.doc, "Chorus");
  const source = addPatternClip(s.doc, trackId, verse, { length_steps: 16 });
  const second = s.run("pattern.add", { clip_id: source, name: "Fill" }).result.args.id;
  s.run("step.toggle", { clip_id: source, pattern_id: "a", at: 0, bank_id: bankId, index: 0, v: 120 });
  s.run("step.set", {
    clip_id: source,
    pattern_id: "a",
    at: 0,
    bank_id: bankId,
    index: 0,
    locks: { cutoff_hz: 800 },
  });
  s.run("step.toggle", { clip_id: source, pattern_id: second, at: 12, bank_id: bankId, index: 3 });
  s.run("chain.set", { clip_id: source, chain: ["a", second] });
  s.run("pattern.set_swing", { clip_id: source, swing: 0.25 });

  const copied = s.run("clip.copy_to_scene", { clip_id: source, scene_id: chorus, new_clip_id: "copy" });
  assert.equal(copied.result.summary, 'Copied clip "Kit loop" to scene "Chorus"');
  assert.deepEqual(copied.result.touched.slice(0, 3), ["clip:copy", `clip:${source}`, `track:${trackId}`]);

  const song = snapshot(s.doc);
  const original = song.clips[source];
  const copy = song.clips.copy;
  assert.equal(copy.name, original.name, "the copy keeps the source's name");
  assert.equal(copy.track_id, trackId, "the copy stays on the same track");
  assert.equal(copy.scene_id, chorus, "the copy sits in the target scene");
  assert.equal(copy.kind, "pattern");
  assert.deepEqual(copy.notes, []);
  assert.equal(copy.length_bars, original.length_bars);
  assert.equal(copy.length_steps, original.length_steps);
  assert.equal(copy.step_beats, original.step_beats);
  assert.equal(copy.swing, original.swing);
  assert.deepEqual(copy.chain, ["a", second], "the chain is copied verbatim");

  // Pattern ids are kept and re-keyed under the new clip, motion and all.
  assert.deepEqual(Object.keys(song.patterns).sort(), [
    `copy/${second}`,
    `${source}/${second}`,
    "copy/a",
    `${source}/a`,
  ].sort());
  for (const patternId of ["a", second]) {
    const from = song.patterns[patternKey(source, patternId)];
    const to = song.patterns[patternKey("copy", patternId)];
    assert.equal(to.id, patternId, "the pattern keeps its id");
    assert.equal(to.name, from.name);
    assert.equal(to.order, from.order);
    assert.equal(to.clip_id, "copy", "the pattern belongs to the copy");
    assert.deepEqual(to.motion, from.motion);
  }

  // The steps are the source's, in the copy's own patterns.
  assert.ok(song.steps[stepKey("copy", "a", 0, bankId, 0)]);
  assert.deepEqual(song.steps[stepKey("copy", "a", 0, bankId, 0)].locks, { cutoff_hz: 800 });
  assert.deepEqual(song.steps[stepKey("copy", second, 12, bankId, 3)].locks, {});
  assert.deepEqual(Object.keys(song.steps).sort(), [
    stepKey(source, "a", 0, bankId, 0),
    stepKey(source, second, 12, bankId, 3),
    stepKey("copy", "a", 0, bankId, 0),
    stepKey("copy", second, 12, bankId, 3),
  ].sort());
  assert.deepEqual(checkInvariants(s.doc), []);

  // Editing the original leaves the copy alone...
  s.run("step.set", {
    clip_id: source,
    pattern_id: "a",
    at: 0,
    bank_id: bankId,
    index: 0,
    locks: { cutoff_hz: 4000 },
  });
  s.run("step.toggle", { clip_id: source, pattern_id: "a", at: 8, bank_id: bankId, index: 0 });
  s.run("chain.set", { clip_id: source, chain: ["a"] });
  let after = snapshot(s.doc);
  assert.deepEqual(after.steps[stepKey("copy", "a", 0, bankId, 0)].locks, { cutoff_hz: 800 });
  assert.equal(after.steps[stepKey("copy", "a", 8, bankId, 0)], undefined, "no new step reached the copy");
  assert.deepEqual(after.clips.copy.chain, ["a", second], "the copy kept its own chain");
  assert.deepEqual(after.clips[source].chain, ["a"]);

  // ...and editing the copy leaves the original alone.
  s.run("step.toggle", { clip_id: "copy", pattern_id: second, at: 4, bank_id: bankId, index: 1 });
  s.run("pattern.remove", { clip_id: "copy", pattern_id: second });
  after = snapshot(s.doc);
  assert.equal(after.steps[stepKey(source, second, 12, bankId, 3)].at, 12, "the original kept its step");
  assert.ok(after.patterns[patternKey(source, second)], "the original kept its pattern");
  assert.equal(after.patterns[patternKey("copy", second)], undefined);
  assert.deepEqual(checkInvariants(s.doc), []);
});

test("chain, loop, swing, locks and motion lanes are copied and the copy plays the same steps", (t) => {
  const s = studio(t);
  const { trackId, bankId } = addKit(s.doc);
  const verse = addScene(s.doc, "Verse");
  const chorus = addScene(s.doc, "Chorus");
  const source = addPatternClip(s.doc, trackId, verse, { length_steps: 8 });
  const fill = s.run("pattern.add", { clip_id: source, name: "Fill" }).result.args.id;

  s.run("pattern.set_steps_beat", { clip_id: source, step_beats: 0.5 });
  s.run("pattern.set_swing", { clip_id: source, swing: 0.25 });
  s.run("step.toggle", { clip_id: source, pattern_id: "a", at: 0, bank_id: bankId, index: 0, v: 120 });
  s.run("step.toggle", { clip_id: source, pattern_id: "a", at: 4, bank_id: bankId, index: 2, v: 90 });
  s.run("step.set", {
    clip_id: source,
    pattern_id: "a",
    at: 4,
    bank_id: bankId,
    index: 2,
    locks: { pitch: -5, gain_db: -3, filter_type: "lp", reverse: true },
  });
  s.run("step.toggle", { clip_id: source, pattern_id: fill, at: 2, bank_id: bankId, index: 1 });
  s.run("chain.set", { clip_id: source, chain: ["a", fill] });
  s.run("motion.write", {
    clip_id: source,
    pattern_id: "a",
    bank_id: bankId,
    index: 0,
    param: "cutoff_hz",
    points: [
      { step_frac: 0, value: 400 },
      { step_frac: 6, value: 6000 },
    ],
  });

  s.run("clip.copy_to_scene", { clip_id: source, scene_id: chorus, new_clip_id: "copy" });
  const song = snapshot(s.doc);

  assert.equal(song.clips.copy.length_steps, 8);
  assert.equal(song.clips.copy.step_beats, 0.5);
  assert.equal(song.clips.copy.swing, 0.25);
  assert.equal(song.clips.copy.length_bars, song.clips[source].length_bars);
  assert.deepEqual(song.clips.copy.chain, ["a", fill]);
  const fromLocks = song.steps[stepKey(source, "a", 4, bankId, 2)].locks;
  const toLocks = song.steps[stepKey("copy", "a", 4, bankId, 2)].locks;
  assert.deepEqual(toLocks, fromLocks);
  assert.deepEqual(toLocks, { pitch: -5, gain_db: -3, filter_type: "lp", reverse: true });
  assert.deepEqual(
    song.patterns[patternKey("copy", "a")].motion,
    song.patterns[patternKey(source, "a")].motion,
  );
  assert.deepEqual(song.patterns[patternKey("copy", "a")].motion[`${bankId}.0|cutoff_hz`], [
    { step_frac: 0, value: 400 },
    { step_frac: 6, value: 6000 },
  ]);

  // One full chain cycle of each: 8 steps of half a beat is 4 beats, and the
  // chain's two slots make it 8 beats — 192,000 frames at 120 bpm and 48 kHz.
  const cycleFrames = 8 * FRAMES_PER_BEAT;
  const original = playClip(song, source, cycleFrames);
  const duplicated = playClip(song, "copy", cycleFrames);
  assert.ok(original.length >= 3, "the original plays its steps");
  assert.deepEqual(duplicated, original, "the copy triggers the same pads at the same frames");
  // Both chain slots sounded, so the comparison covers the second pattern too.
  assert.ok(original.some((event) => event.frame >= 4 * FRAMES_PER_BEAT));
  assert.deepEqual(checkInvariants(s.doc), []);
});

test("one undo removes the whole copy, one redo restores it", (t) => {
  const s = studio(t);
  const { trackId, bankId } = addKit(s.doc);
  const verse = addScene(s.doc, "Verse");
  const chorus = addScene(s.doc, "Chorus");
  const source = addPatternClip(s.doc, trackId, verse, { length_steps: 16 });
  const second = s.run("pattern.add", { clip_id: source, name: "Fill" }).result.args.id;
  s.run("step.toggle", { clip_id: source, pattern_id: "a", at: 0, bank_id: bankId, index: 0 });
  s.run("step.toggle", { clip_id: source, pattern_id: second, at: 4, bank_id: bankId, index: 1 });
  s.run("chain.set", { clip_id: source, chain: ["a", second] });

  const copied = s.run("clip.copy_to_scene", { clip_id: source, scene_id: chorus, new_clip_id: "copy" });
  // Every object the step made is in its after map, so undo has all of it.
  assert.deepEqual(Object.keys(copied.result.after).sort(), [
    "clip:copy|*",
    "pattern:copy/a|*",
    `pattern:copy/${second}|*`,
    `step:copy/a/0/${bankId}.0|*`,
    `step:copy/${second}/4/${bankId}.1|*`,
  ].sort());
  assert.deepEqual(Object.keys(copied.result.before).sort(), Object.keys(copied.result.after).sort());
  for (const value of Object.values(copied.result.before)) assert.equal(value, null, "none of it existed");

  const undone = s.undo(copied.entry);
  assert.deepEqual(undone.plan.conflicts, []);
  assert.deepEqual(undone.plan.blocked, []);
  let song = snapshot(s.doc);
  assert.equal(song.clips.copy, undefined, "the clip went whole");
  assert.equal(song.patterns["copy/a"], undefined);
  assert.equal(song.patterns[`copy/${second}`], undefined);
  assert.equal(song.steps[stepKey("copy", "a", 0, bankId, 0)], undefined);
  assert.equal(song.steps[stepKey("copy", second, 4, bankId, 1)], undefined);
  assert.ok(song.clips[source], "the source stayed");
  assert.ok(song.steps[stepKey(source, "a", 0, bankId, 0)], "the source's steps stayed");
  assert.deepEqual(checkInvariants(s.doc), []);

  const redone = s.redo(undone.entry);
  assert.deepEqual(redone.plan.conflicts, []);
  song = snapshot(s.doc);
  assert.ok(song.clips.copy, "the copy came back");
  assert.equal(song.clips.copy.scene_id, chorus);
  assert.ok(song.patterns[`copy/${second}`], "and so did its second pattern");
  assert.ok(song.steps[stepKey("copy", second, 4, bankId, 1)], "and its steps");
  assert.deepEqual(song.clips.copy.chain, ["a", second]);
  assert.deepEqual(checkInvariants(s.doc), []);
});

test("the copy refuses an occupied cell, a source that is not a pattern clip, and a missing object", (t) => {
  const s = studio(t);
  const { trackId } = addKit(s.doc);
  const verse = addScene(s.doc, "Verse");
  const chorus = addScene(s.doc, "Chorus");
  const source = addPatternClip(s.doc, trackId, verse);

  // Its own cell is occupied — by itself — so copying in place is refused.
  const sameCell = refuses(
    () => s.run("clip.copy_to_scene", { clip_id: source, scene_id: verse }),
    "invalid",
  );
  assert.match(sameCell.message, /one track plays one clip per scene/);

  // A cell another clip already fills is refused too, and nothing is written.
  const other = addPatternClip(s.doc, trackId, chorus, { name: "Chorus loop" });
  const before = snapshot(s.doc);
  const occupied = refuses(
    () => s.run("clip.copy_to_scene", { clip_id: source, scene_id: chorus, new_clip_id: "copy" }),
    "invalid",
  );
  assert.match(occupied.message, /Chorus loop/);
  assert.deepEqual(snapshot(s.doc), before);

  // Notes clip and audio clip are out of scope, and each refusal names the kind.
  const notesTrack = runCommand(s.doc, "track.add", { name: "Bass" }).args.id;
  const notesClip = runCommand(s.doc, "clip.write", {
    track_id: notesTrack,
    scene_id: verse,
    name: "Verse bass",
    notes: [],
  }).args.clip_id;
  const noteKind = refuses(
    () => s.run("clip.copy_to_scene", { clip_id: notesClip, scene_id: chorus }),
    "invalid",
  );
  assert.match(noteKind.message, /note clip/);
  const audioTrack = runCommand(s.doc, "track.add", { name: "Guitar", kind: "audio" }).args.id;
  const audioClip = runCommand(s.doc, "clip.add_audio", {
    track_id: audioTrack,
    scene_id: verse,
    length_bars: 1,
    name: "Guitar take",
  }).args.clip_id;
  const audioKind = refuses(
    () => s.run("clip.copy_to_scene", { clip_id: audioClip, scene_id: chorus }),
    "invalid",
  );
  assert.match(audioKind.message, /audio clip/);

  // A missing clip, a missing scene and a duplicate id are each refused by name.
  const missingClip = refuses(
    () => s.run("clip.copy_to_scene", { clip_id: "nowhere", scene_id: chorus }),
    "not_found",
  );
  assert.match(missingClip.message, /nowhere/);
  const missingScene = refuses(
    () => s.run("clip.copy_to_scene", { clip_id: source, scene_id: "nowhere" }),
    "not_found",
  );
  assert.match(missingScene.message, /nowhere/);
  const duplicate = refuses(
    () => s.run("clip.copy_to_scene", { clip_id: source, scene_id: verse, new_clip_id: other }),
    "invalid",
  );
  assert.match(duplicate.message, new RegExp(other));

  // A second scene that is free takes the copy, and the generated id is a real
  // one when the caller names none.
  const bridge = addScene(s.doc, "Bridge");
  const generated = s.run("clip.copy_to_scene", { clip_id: source, scene_id: bridge });
  const copyId = generated.result.args.new_clip_id;
  assert.equal(typeof copyId, "string");
  assert.ok(copyId.length > 0);
  assert.equal(snapshot(s.doc).clips[copyId].scene_id, bridge);
  assert.deepEqual(clipsInCell(snapshot(s.doc), trackId, bridge), [copyId]);
  assert.deepEqual(checkInvariants(s.doc), []);
});

test("two peers copying different clips into one cell merge as two clip.add_pattern calls do", (t) => {
  // Case one: two peers copy a different clip into the same empty cell at once.
  const s = studio(t, "Copy race");
  const { trackId } = addKit(s.doc);
  const verse = addScene(s.doc, "Verse");
  const chorus = addScene(s.doc, "Chorus");
  const bridge = addScene(s.doc, "Bridge");
  const first = addPatternClip(s.doc, trackId, verse, { name: "Verse loop" });
  const second = addPatternClip(s.doc, trackId, chorus, { name: "Chorus loop" });

  const { other, sync } = pair(t, s);
  s.run("clip.copy_to_scene", { clip_id: first, scene_id: bridge, new_clip_id: "copy-a" });
  other.transact(() =>
    runCommand(other, "clip.copy_to_scene", { clip_id: second, scene_id: bridge, new_clip_id: "copy-b" }),
  );
  assert.deepEqual(clipsInCell(snapshot(s.doc), trackId, bridge), ["copy-a"]);
  assert.deepEqual(clipsInCell(snapshot(other), trackId, bridge), ["copy-b"]);

  sync();
  assert.deepEqual(snapshot(s.doc), snapshot(other), "both peers converge on one song");
  const merged = clipsInCell(snapshot(s.doc), trackId, bridge);
  assert.deepEqual(merged, ["copy-a", "copy-b"], "both copies are in the cell");
  const song = snapshot(s.doc);
  for (const clipId of merged) {
    assert.equal(song.clips[clipId].track_id, trackId);
    assert.equal(song.clips[clipId].scene_id, bridge);
    assert.ok(song.patterns[patternKey(clipId, "a")], `${clipId} brought its pattern`);
  }
  assert.deepEqual(checkInvariants(s.doc), []);

  // Case two: the same race with two clip.add_pattern calls into one cell, which
  // is what Studio does today. The converged shape is the same: two clips in one
  // cell, each with its own pattern.
  const added = studio(t, "Add race");
  const kit = addKit(added.doc);
  const seed = addScene(added.doc, "Verse");
  const target = addScene(added.doc, "Bridge");
  // One clip first, so the song already holds the patterns container both peers
  // then write into; the copy race is the same: its sources made it long before.
  added.run("clip.add_pattern", {
    clip_id: "seed",
    track_id: kit.trackId,
    scene_id: seed,
    name: "Seed",
  });
  const { other: peer, sync: syncAdded } = pair(t, added);
  added.run("clip.add_pattern", {
    clip_id: "cell-a",
    track_id: kit.trackId,
    scene_id: target,
    name: "One",
  });
  peer.transact(() =>
    runCommand(peer, "clip.add_pattern", {
      clip_id: "cell-b",
      track_id: kit.trackId,
      scene_id: target,
      name: "Two",
    }),
  );
  syncAdded();
  assert.deepEqual(clipsInCell(snapshot(added.doc), kit.trackId, target), ["cell-a", "cell-b"]);
  assert.deepEqual(checkInvariants(added.doc), []);

  // The same two clips in one cell, on one track, each with its own pattern: the
  // copy race and the add race leave the song in the same shape.
  const shapeOf = (raceSong, raceTrack, raceScene) =>
    clipsInCell(raceSong, raceTrack, raceScene).map((clipId) => [
      raceSong.clips[clipId].kind,
      Object.values(raceSong.patterns).filter((pattern) => pattern.clip_id === clipId).length,
    ]);
  const copyShape = shapeOf(song, trackId, bridge);
  assert.equal(copyShape.length, 2);
  assert.deepEqual(
    copyShape,
    shapeOf(snapshot(added.doc), kit.trackId, target),
    "the two races converge on the same shape of cell",
  );
});

test("a copy while another peer edits the source converges", (t) => {
  const s = studio(t);
  const { trackId, bankId } = addKit(s.doc);
  const verse = addScene(s.doc, "Verse");
  const chorus = addScene(s.doc, "Chorus");
  const source = addPatternClip(s.doc, trackId, verse, { length_steps: 16 });
  s.run("step.toggle", { clip_id: source, pattern_id: "a", at: 0, bank_id: bankId, index: 0, v: 110 });
  s.run("step.set", {
    clip_id: source,
    pattern_id: "a",
    at: 0,
    bank_id: bankId,
    index: 0,
    locks: { cutoff_hz: 500 },
  });

  const { other, sync } = pair(t, s);

  // One peer copies the clip; the other edits the source's step and adds a step
  // at another position, neither having seen the other's write.
  s.run("clip.copy_to_scene", { clip_id: source, scene_id: chorus, new_clip_id: "copy" });
  other.transact(() => {
    runCommand(other, "step.set", {
      clip_id: source,
      pattern_id: "a",
      at: 0,
      bank_id: bankId,
      index: 0,
      locks: { cutoff_hz: 9000 },
    });
    runCommand(other, "step.toggle", {
      clip_id: source,
      pattern_id: "a",
      at: 8,
      bank_id: bankId,
      index: 0,
    });
  });
  sync();

  assert.deepEqual(snapshot(s.doc), snapshot(other), "both peers hold the same song");
  const song = snapshot(s.doc);
  assert.deepEqual(
    song.steps[stepKey(source, "a", 0, bankId, 0)].locks,
    { cutoff_hz: 9000 },
    "the source took the newer lock",
  );
  assert.ok(song.steps[stepKey(source, "a", 8, bankId, 0)], "and the newer step");
  assert.deepEqual(
    song.steps[stepKey("copy", "a", 0, bankId, 0)].locks,
    { cutoff_hz: 500 },
    "the copy holds the step its own peer saw",
  );
  assert.equal(
    song.steps[stepKey("copy", "a", 8, bankId, 0)],
    undefined,
    "the edit made after the copy never reached it",
  );
  assert.deepEqual(checkInvariants(s.doc), []);
  assert.ok(playClip(song, "copy", 4 * FRAMES_PER_BEAT).length >= 1, "the copy plays its own steps");
});

test("a locked track refuses the copy to an agent and the person's copy lands", async (t) => {
  const { hub } = await hubSetup(t);
  const created = await hub.createSong({ project_id: PROJECT, title: "Locked copy", author: HUMAN });
  assert.equal(created.ok, true, `createSong was refused: ${created.error}`);
  const song_id = created.song_id;

  const run = (command, args, author, cmd_id) =>
    hub.runCommand({ song_id, cmd_id, command, args, author });

  assert.equal((await run("track.add", { id: "kit", name: "Kit", kind: "sampler" }, HUMAN, "copy-1")).ok, true);
  assert.equal((await run("scene.add", { id: "verse", name: "Verse" }, HUMAN, "copy-2")).ok, true);
  assert.equal((await run("scene.add", { id: "chorus", name: "Chorus" }, HUMAN, "copy-3")).ok, true);
  assert.equal(
    (
      await run(
        "clip.add_pattern",
        { clip_id: "beat", track_id: "kit", scene_id: "verse", name: "Beat", length_steps: 16 },
        HUMAN,
        "copy-4",
      )
    ).ok,
    true,
  );
  assert.equal((await run("track.lock", { track_id: "kit" }, HUMAN, "copy-5")).ok, true);

  const refused = await run(
    "clip.copy_to_scene",
    { clip_id: "beat", scene_id: "chorus", new_clip_id: "copy" },
    AGENT,
    "copy-6",
  );
  assert.equal(refused.ok, false, "an agent may not copy onto a locked track's grid");
  assert.equal(refused.code, "locked");
  assert.equal(refused.error, 'Track "Kit" is locked by the operator.');

  // The person may, and one copy is all there is.
  const copied = await run(
    "clip.copy_to_scene",
    { clip_id: "beat", scene_id: "chorus", new_clip_id: "copy" },
    HUMAN,
    "copy-7",
  );
  assert.equal(copied.ok, true, `the operator's copy was refused: ${copied.error}`);
  const song = (await hub.openSong(song_id)).snapshot;
  const clips = Object.values(song.clips).filter((clip) => clip.scene_id === "chorus");
  assert.deepEqual(clips.map((clip) => clip.id), ["copy"]);
});

test("the registry, the panel and the MCP server all carry clip.copy_to_scene", async (t) => {
  const command = listCommands().find((item) => item.id === "clip.copy_to_scene");
  assert.ok(command, "the registry holds clip.copy_to_scene");
  assert.equal(command.humanOnly, false);
  assert.equal(command.internal, false);
  assert.equal(command.undoWhole, true, "the copy is one all-or-nothing step");
  assert.equal(command.idField, "new_clip_id");
  assert.deepEqual(
    Object.keys(command.schema.shape),
    ["clip_id", "scene_id", "new_clip_id"],
    "the arguments are the clip, the scene and the copy's own id",
  );
  assert.ok(
    COMMANDS.includes("clip.copy_to_scene"),
    "the panel's command list and the registry are the same set",
  );

  const refuseRead = async () => {
    throw new Error("this case only lists tools");
  };
  const server = createStudioServer({
    hub: {
      async listSongs() {
        return [];
      },
      createSong: refuseRead,
      snapshot: refuseRead,
      history: refuseRead,
      command: refuseRead,
      undo: refuseRead,
      redo: refuseRead,
    },
    renderer: {
      async render() {
        throw new Error("this case only lists tools");
      },
    },
    catalogue: async () => ({ modules: {} }),
    env: {},
  });
  const client = new Client({ name: "studio-clip-copy-test", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(names.includes("studio_clip_copy_to_scene"), "the agent has the copy tool");
    assert.equal(
      names.filter((name) => name === "studio_clip_copy_to_scene").length,
      1,
      "and exactly one of it",
    );
  } finally {
    await client.close();
  }
});