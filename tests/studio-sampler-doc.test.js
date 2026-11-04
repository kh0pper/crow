/**
 * Studio sampler in the document: a sampler track's kit of banks and pads, the
 * samples and slices the pads play, and a pattern clip's patterns, steps,
 * locks and chain — plus the parts of the shared history they depend on.
 *
 * Every test builds its own song in memory and records its steps the way the
 * session hub does: one real registry command inside one `doc.transact(...)`
 * per step, undone through `history.js`. Nothing here touches a database or a
 * running instance.
 *
 * The hub side of the task — the internal-command refusal at the hub, the agent
 * sound guard and the lock mapping of sample writes — needs the real hub and a
 * scratch database, so those tests live beside the hub's.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  LIMITS,
  SAMPLER_DEVICE,
  bankKey,
  checkInvariants,
  isSamplerTrack,
  lengthBarsForSteps,
  newSongDoc,
  padKey,
  patternKey,
  sampleUsers,
  sliceKey,
  snapshot,
  songMap,
  stepKey,
} from "../bundles/studio/server/doc.js";
import {
  StudioError,
  getCommand,
  listCommands,
  runCommand,
} from "../bundles/studio/server/commands/registry.js";
import "../bundles/studio/server/commands/core.js";
import "../bundles/studio/server/commands/takes.js";
import "../bundles/studio/server/commands/arrangement.js";
import "../bundles/studio/server/commands/sampler.js";
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
  const doc = newSongDoc({ title: "Sampler song" });
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

/** Add a scene and return its id. */
function addScene(doc, name = "Verse") {
  return runCommand(doc, "scene.add", { name }).args.id;
}

/** Add a sampler track, and return its id and its one bank's id. */
function addKit(doc, name = "Kit") {
  const trackId = runCommand(doc, "track.add", { name, kind: "sampler" }).args.id;
  const bank = Object.values(snapshot(doc).banks).find((item) => item.track_id === trackId);
  return { trackId, bankId: bank.id };
}

/**
 * A sample object with the shape the gateway's upload finish route builds.
 * @param {object} [overrides]
 * @returns {object}
 */
function sample(overrides = {}) {
  const id = overrides.id ?? randomUUID();
  return {
    id,
    storage_key: `studio/song-1/samples/${id}.wav`,
    rate: 48000,
    channels: 2,
    frames: 96000,
    name: "Drum loop",
    origin: "import",
    author_label: "the operator",
    ...overrides,
  };
}

/** Add a sample and return its id. */
function addSample(doc, overrides = {}) {
  const added = sample(overrides);
  runCommand(doc, "sample.add", { sample: added });
  return added.id;
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

test("a sampler track has one bank of 16 pads", (t) => {
  const s = studio(t);
  const { trackId, bankId } = addKit(s.doc, "Drums");

  const snap = snapshot(s.doc);
  assert.equal(snap.tracks[0].device.engine, "sampler");
  assert.deepEqual(snap.tracks[0].device, SAMPLER_DEVICE);
  assert.equal("params" in snap.tracks[0].device, false);

  const bank = snap.banks[bankKey(trackId, bankId)];
  assert.ok(bank, "the kit should hold its bank");
  assert.equal(bank.name, "A");
  assert.equal(bank.order, 0);
  assert.equal(bank.track_id, trackId);

  const pads = Object.values(snap.pads).filter((pad) => pad.bank_id === bankId);
  assert.equal(pads.length, LIMITS.padsPerBank, "a bank holds 16 pads");
  assert.deepEqual(
    pads.map((pad) => pad.index).sort((a, b) => a - b),
    Array.from({ length: 16 }, (_, index) => index),
  );
  for (const pad of pads) {
    assert.equal(pad.sample_id, null, "a new pad plays nothing");
    assert.equal(pad.slice_id, null);
    assert.equal(pad.mode, "oneshot");
    assert.equal(pad.choke, 0);
    assert.deepEqual(pad.filter, { type: "off", cutoff_hz: 20000, resonance: 0 });
    assert.equal(pad.sustain, 1);
  }

  // The kit is the track's, not its device's: no pad is stored inside the
  // device, so a pad edit can never rewrite it.
  assert.deepEqual(snap.tracks[0].device, { engine: "sampler" });
  assert.equal(isSamplerTrack(songMap(s.doc).get("tracks").get(0)), true);

  // A second bank is one more bank of 16 pads, and the kit stops at 8.
  for (let index = 1; index < LIMITS.banksPerKit; index += 1) {
    s.run("bank.add", { track_id: trackId });
  }
  assert.equal(Object.values(snapshot(s.doc).banks).filter((b) => b.track_id === trackId).length, 8);
  const full = refuses(() => s.run("bank.add", { track_id: trackId }), "limit");
  assert.match(full.message, /8 banks/);

  // A sampler track's device is its kit's engine, not a module: swapping it or
  // setting a SunVox controller on it would be a different sound.
  const swapped = refuses(
    () => s.run("track.set_device", { track_id: trackId, type: "SpectraVoice" }),
    "invalid",
  );
  assert.match(swapped.message, /sampler track/);
  refuses(
    () => s.run("track.set_param", { track_id: trackId, name: "Cutoff", value: 40 }),
    "invalid",
  );
  assert.deepEqual(snapshot(s.doc).tracks[0].device, SAMPLER_DEVICE);

  // Nor does a sampler track take notes or a recording: it plays patterns.
  const verse = addScene(s.doc);
  refuses(
    () => s.run("clip.write", { track_id: trackId, scene_id: verse, name: "Notes", notes: [] }),
    "invalid",
  );
  refuses(
    () => s.run("clip.add_audio", { track_id: trackId, scene_id: verse, length_bars: 1 }),
    "invalid",
  );
  assert.deepEqual(checkInvariants(s.doc), []);
});

test("pad.assign refuses a sample of another song", (t) => {
  const s = studio(t);
  const { trackId, bankId } = addKit(s.doc);
  const mine = addSample(s.doc, { name: "My loop" });

  // A sample id from a different song: nothing in this song's samples holds it.
  const stranger = randomUUID();
  const refused = refuses(
    () => s.run("pad.assign", { track_id: trackId, bank_id: bankId, index: 0, sample_id: stranger }),
    "not_found",
  );
  assert.match(refused.message, new RegExp(stranger));
  assert.equal(snapshot(s.doc).pads[padKey(trackId, bankId, 0)].sample_id, null);

  // Its own sample goes on the pad, and only a slice of that sample may follow.
  const assigned = s.run("pad.assign", { track_id: trackId, bank_id: bankId, index: 0, sample_id: mine });
  assert.equal(assigned.result.after[`pad:${trackId}/${bankId}/0|sample_id`], mine);
  assert.equal(snapshot(s.doc).pads[padKey(trackId, bankId, 0)].sample_id, mine);
  refuses(
    () => s.run("pad.assign", { track_id: trackId, bank_id: bankId, index: 0, sample_id: mine, slice_id: "nope" }),
    "invalid",
  );
  assert.equal(snapshot(s.doc).pads[padKey(trackId, bankId, 0)].slice_id, null);
  assert.deepEqual(checkInvariants(s.doc), []);
});

test("step.toggle adds and removes a step", (t) => {
  const s = studio(t);
  const { trackId, bankId } = addKit(s.doc);
  const scene = addScene(s.doc);
  const clip = addPatternClip(s.doc, trackId, scene, { length_steps: 16 });
  const key = stepKey(clip, "a", 0, bankId, 0);

  const on = s.run("step.toggle", { clip_id: clip, pattern_id: "a", at: 0, bank_id: bankId, index: 0, v: 110 });
  assert.deepEqual(on.result.after[`step:${clip}/a/0/${bankId}.0|*`], {
    clip_id: clip,
    pattern_id: "a",
    at: 0,
    bank_id: bankId,
    index: 0,
    v: 110,
    locks: {},
  });
  assert.equal(snapshot(s.doc).steps[key].v, 110);
  assert.deepEqual(checkInvariants(s.doc), []);

  const off = s.run("step.toggle", { clip_id: clip, pattern_id: "a", at: 0, bank_id: bankId, index: 0 });
  assert.equal(off.result.after[`step:${clip}/a/0/${bankId}.0|*`], null);
  assert.equal(snapshot(s.doc).steps[key], undefined);

  // Its undo puts the step back, and the second undo's step is the one that
  // took it off, so both directions are one step each.
  const undone = s.undo(off.entry);
  assert.deepEqual(undone.plan.conflicts, []);
  assert.equal(snapshot(s.doc).steps[key].v, 110);
  assert.deepEqual(checkInvariants(s.doc), []);
});

test("undo of a lock edit keeps a newer edit on another step", (t) => {
  const s = studio(t);
  const { trackId, bankId } = addKit(s.doc);
  const scene = addScene(s.doc);
  const clip = addPatternClip(s.doc, trackId, scene, { length_steps: 16 });
  for (const at of [0, 4]) {
    s.run("step.toggle", { clip_id: clip, pattern_id: "a", at, bank_id: bankId, index: 0 });
  }

  const edit = (at, cutoff_hz) =>
    s.run("step.set", {
      clip_id: clip,
      pattern_id: "a",
      at,
      bank_id: bankId,
      index: 0,
      locks: { cutoff_hz },
    });

  const first = edit(0, 500);
  // The whole lock is one field of one step, so only that field is written.
  assert.deepEqual(Object.keys(first.result.after), [`step:${clip}/a/0/${bankId}.0|locks.cutoff_hz`]);

  edit(4, 9001);
  const undone = s.undo(first.entry);
  assert.deepEqual(undone.plan.conflicts, [], "the newer edit is on another step, so nothing conflicts");
  assert.deepEqual(undone.plan.blocked, []);

  const steps = snapshot(s.doc).steps;
  assert.deepEqual(steps[stepKey(clip, "a", 0, bankId, 0)].locks, {}, "the older lock went back");
  assert.deepEqual(steps[stepKey(clip, "a", 4, bankId, 0)].locks, { cutoff_hz: 9001 }, "the newer lock stayed");
  assert.deepEqual(checkInvariants(s.doc), []);

  // Redoing it puts the older lock back and leaves the newer one alone.
  const redone = s.redo(undone.entry);
  assert.deepEqual(redone.plan.conflicts, []);
  assert.deepEqual(snapshot(s.doc).steps[stepKey(clip, "a", 0, bankId, 0)].locks, { cutoff_hz: 500 });
  assert.deepEqual(snapshot(s.doc).steps[stepKey(clip, "a", 4, bankId, 0)].locks, { cutoff_hz: 9001 });
});

test("every pad field can be locked on a step, and nothing else", (t) => {
  const s = studio(t);
  const { trackId, bankId } = addKit(s.doc);
  const scene = addScene(s.doc);
  const clip = addPatternClip(s.doc, trackId, scene, { length_steps: 16 });
  s.run("step.toggle", { clip_id: clip, pattern_id: "a", at: 0, bank_id: bankId, index: 0 });
  const at = { clip_id: clip, pattern_id: "a", at: 0, bank_id: bankId, index: 0 };

  s.run("step.set", { ...at, locks: { attack_ms: 12, sustain: 0.25, filter_type: "hp" } });
  assert.deepEqual(snapshot(s.doc).steps[stepKey(clip, "a", 0, bankId, 0)].locks, {
    attack_ms: 12,
    sustain: 0.25,
    filter_type: "hp",
  });

  refuses(() => s.run("step.set", { ...at, locks: { filter_type: "notch" } }), "invalid");
  refuses(() => s.run("step.set", { ...at, locks: { sustain: 2 } }), "invalid");
  refuses(() => s.run("step.set", { ...at, locks: { sample_id: "x" } }), "invalid");
  assert.deepEqual(checkInvariants(s.doc), []);
});

test("undo of one pad's edit keeps a newer edit on another pad", (t) => {
  const s = studio(t);
  const { trackId, bankId } = addKit(s.doc);

  const first = s.run("pad.set", { track_id: trackId, bank_id: bankId, index: 0, fields: { gain_db: -6 } });
  const newer = s.run("pad.set", { track_id: trackId, bank_id: bankId, index: 1, fields: { gain_db: -12 } });

  const undone = s.undo(first.entry);
  assert.deepEqual(undone.plan.conflicts, []);
  assert.deepEqual(undone.plan.blocked, []);
  assert.deepEqual([...undone.plan.apply.keys()], [`pad:${trackId}/${bankId}/0|gain_db`]);

  const pads = snapshot(s.doc).pads;
  assert.equal(pads[padKey(trackId, bankId, 0)].gain_db, 0, "the older pad's edit went back");
  assert.equal(pads[padKey(trackId, bankId, 1)].gain_db, -12, "the newer pad kept its edit");
  assert.equal(newer.result.after[`pad:${trackId}/${bankId}/1|gain_db`], -12);
  assert.deepEqual(checkInvariants(s.doc), []);
});

test("chain refuses an unknown pattern", (t) => {
  const s = studio(t);
  const { trackId } = addKit(s.doc);
  const scene = addScene(s.doc);
  const clip = addPatternClip(s.doc, trackId, scene);

  const refused = refuses(
    () => s.run("chain.set", { clip_id: clip, chain: ["a", randomUUID()] }),
    "invalid",
  );
  assert.match(refused.message, /no pattern/);
  assert.deepEqual(snapshot(s.doc).clips[clip].chain, [], "the refused chain wrote nothing");

  // A chain of this clip's own patterns is fine, and the limit names 64.
  const set = s.run("chain.set", { clip_id: clip, chain: ["a"] });
  assert.deepEqual(set.result.after[`clip:${clip}|chain`], ["a"]);
  const over = refuses(
    () => s.run("chain.set", { clip_id: clip, chain: Array.from({ length: 65 }, () => "a") }),
    "limit",
  );
  assert.match(over.message, /64/);
  assert.deepEqual(snapshot(s.doc).clips[clip].chain, ["a"]);
  assert.deepEqual(checkInvariants(s.doc), []);
});

test("65 steps refused naming 64", (t) => {
  const s = studio(t);
  const { trackId, bankId } = addKit(s.doc);
  const scene = addScene(s.doc);
  const clip = addPatternClip(s.doc, trackId, scene, { length_steps: LIMITS.stepPositions });

  // There is no 65th position: a pattern is 64 steps, numbered 0 to 63.
  const at64 = refuses(
    () => s.run("step.toggle", { clip_id: clip, pattern_id: "a", at: 64, bank_id: bankId, index: 0 }),
    "limit",
  );
  assert.match(at64.message, /64/);
  assert.equal(Object.keys(snapshot(s.doc).steps).length, 0);

  const tooLong = refuses(
    () => s.run("pattern.set_length", { clip_id: clip, length_steps: 65 }),
    "limit",
  );
  assert.match(tooLong.message, /64/);
  assert.equal(snapshot(s.doc).clips[clip].length_steps, 64);

  // The last position that does exist is fine, and the loop is 16 bars of 16ths.
  s.run("step.toggle", { clip_id: clip, pattern_id: "a", at: 63, bank_id: bankId, index: 0 });
  assert.ok(snapshot(s.doc).steps[stepKey(clip, "a", 63, bankId, 0)]);
  assert.equal(lengthBarsForSteps(64, 0.25), 4);
  assert.deepEqual(checkInvariants(s.doc), []);
});

test("sample.add is refused outside Studio", () => {
  // The command exists, and it is Studio's own: no MCP tool is built from it,
  // the panel never sends it, and the hub refuses it unless the call says it
  // comes from Studio (the gateway's upload finish route).
  const command = getCommand("sample.add");
  assert.equal(command.internal, true);
  assert.equal(command.humanOnly, false);
  assert.equal(getCommand("take.add").internal, true, "a sample is internal like a take");
  assert.equal(getCommand("pad.assign").internal, false, "moving a sample onto a pad stays open");
  const publicIds = listCommands({ public: true }).map((item) => item.id);
  assert.equal(publicIds.includes("sample.add"), false, "the public list leaves it out");
  assert.equal(publicIds.includes("pad.assign"), true);
});

test("pad.assign if_empty is internal only", (t) => {
  const s = studio(t);
  const { trackId, bankId } = addKit(s.doc);
  const kick = addSample(s.doc, { name: "Kick" });
  const snare = addSample(s.doc, { name: "Snare" });

  // The empty-only check is a command of Studio's own, not a flag on
  // `pad.assign`: it runs inside the hub's per-song queue, so it sees the pad as
  // it is the moment the assignment lands. No caller outside the process can
  // ask for it — the hub refuses it without `internal: true`, and the panel and
  // the MCP tools are built from the public list, which leaves it out.
  const guard = getCommand("pad.assign_if_empty");
  assert.equal(guard.internal, true);
  assert.equal(getCommand("pad.assign").internal, false, "filling a pad by hand stays open to everyone");
  const publicIds = listCommands({ public: true }).map((item) => item.id);
  assert.equal(publicIds.includes("pad.assign_if_empty"), false);

  // And `pad.assign` has no such argument: its schema is strict, so the flag is
  // refused as an unknown field rather than quietly ignored.
  refuses(
    () =>
      s.run("pad.assign", {
        track_id: trackId,
        bank_id: bankId,
        index: 0,
        sample_id: kick,
        if_empty: true,
      }),
    "invalid",
  );
  assert.equal(snapshot(s.doc).pads[padKey(trackId, bankId, 0)].sample_id, null);

  // An empty pad takes the sound...
  s.run("pad.assign_if_empty", { track_id: trackId, bank_id: bankId, index: 0, sample_id: kick });
  assert.equal(snapshot(s.doc).pads[padKey(trackId, bankId, 0)].sample_id, kick);

  // ...the same sample again is not a change, so a replayed finish is allowed
  // and writes nothing...
  s.run("pad.assign_if_empty", { track_id: trackId, bank_id: bankId, index: 1, sample_id: kick });
  const replayed = s.run("pad.assign_if_empty", {
    track_id: trackId,
    bank_id: bankId,
    index: 1,
    sample_id: kick,
  });
  assert.deepEqual(replayed.result.before, {}, "the same sample on the pad writes nothing");
  assert.deepEqual(replayed.result.after, {});

  // ...and a pad holding another sound is refused by name, and left alone.
  const refused = refuses(
    () => s.run("pad.assign_if_empty", { track_id: trackId, bank_id: bankId, index: 0, sample_id: snare }),
    "conflict",
  );
  assert.equal(refused.message, "That pad already holds a sound.");
  assert.equal(snapshot(s.doc).pads[padKey(trackId, bankId, 0)].sample_id, kick);
  assert.deepEqual(checkInvariants(s.doc), []);
});

test("an old song without samples reads empty", (t) => {
  const doc = newSongDoc({ title: "Older song" });
  t.after(() => doc.destroy());

  // A song written before the sampler existed has none of these containers.
  for (const key of ["samples", "slices", "banks", "pads", "patterns", "steps"]) {
    assert.equal(songMap(doc).get(key), undefined, `${key} should not be there`);
  }
  const snap = snapshot(doc);
  for (const key of ["samples", "slices", "banks", "pads", "patterns", "steps"]) {
    assert.deepEqual(snap[key], {}, `${key} reads as empty`);
  }
  assert.equal(sampleUsers(snap, randomUUID()).length, 0);
  assert.deepEqual(checkInvariants(doc), []);

  // The first sampler track makes whatever it needs, the way any other write
  // to a missing container does.
  const { trackId } = addKit(doc, "Drums");
  const fresh = snapshot(doc);
  assert.equal(Object.values(fresh.banks).filter((bank) => bank.track_id === trackId).length, 1);
  assert.equal(Object.values(fresh.pads).length, 16);
  assert.deepEqual(fresh.samples, {});
  assert.deepEqual(fresh.patterns, {});
  assert.deepEqual(fresh.steps, {});
  assert.deepEqual(checkInvariants(doc), []);
});

test("the engine sees the kit and the patterns from a snapshot", (t) => {
  const s = studio(t);
  const { trackId, bankId } = addKit(s.doc, "Drums");
  const scene = addScene(s.doc);
  const loop = addSample(s.doc, { name: "Break", frames: 48000, rate: 44100, channels: 1, origin: "record" });
  s.run("slice.set", {
    sample_id: loop,
    slices: [
      { id: "verse", start_frame: 0, end_frame: 12000 },
      { id: "fill", start_frame: 12000, end_frame: 24000 },
    ],
  });
  s.run("pad.assign", {
    track_id: trackId,
    bank_id: bankId,
    index: 3,
    sample_id: loop,
    slice_id: "fill",
  });
  s.run("pad.set", {
    track_id: trackId,
    bank_id: bankId,
    index: 3,
    fields: { mode: "gate", pitch: -5, gain_db: -3, choke: 2, reverse: true },
  });

  const clip = addPatternClip(s.doc, trackId, scene, { length_steps: 16 });
  const second = s.run("pattern.add", { clip_id: clip, name: "Fill" }).result.args.id;
  s.run("step.toggle", { clip_id: clip, pattern_id: "a", at: 0, bank_id: bankId, index: 3, v: 127 });
  s.run("step.set", {
    clip_id: clip,
    pattern_id: "a",
    at: 0,
    bank_id: bankId,
    index: 3,
    locks: { cutoff_hz: 2500, decay_ms: 40 },
  });
  s.run("step.toggle", { clip_id: clip, pattern_id: second, at: 12, bank_id: bankId, index: 3 });
  s.run("chain.set", { clip_id: clip, chain: ["a", second] });
  s.run("pattern.set_swing", { clip_id: clip, swing: 0.5 });
  s.run("pattern.set_steps_beat", { clip_id: clip, step_beats: 0.5 });

  const snap = snapshot(s.doc);

  // Samples and slices, keyed by their ref ids.
  assert.deepEqual(snap.samples[loop], {
    id: loop,
    storage_key: `studio/song-1/samples/${loop}.wav`,
    rate: 44100,
    channels: 1,
    frames: 48000,
    name: "Break",
    origin: "record",
    author_label: "the operator",
  });
  assert.deepEqual(snap.slices[sliceKey(loop, "verse")], {
    id: "verse",
    sample_id: loop,
    start_frame: 0,
    end_frame: 12000,
  });
  assert.deepEqual(snap.slices[sliceKey(loop, "fill")], {
    id: "fill",
    sample_id: loop,
    start_frame: 12000,
    end_frame: 24000,
  });

  // The kit, keyed by track and bank, and the pad that plays the slice.
  assert.deepEqual(snap.banks[bankKey(trackId, bankId)], {
    id: bankId,
    track_id: trackId,
    name: "A",
    order: 0,
  });
  const pad = snap.pads[padKey(trackId, bankId, 3)];
  assert.equal(pad.sample_id, loop);
  assert.equal(pad.slice_id, "fill");
  assert.equal(pad.mode, "gate");
  assert.equal(pad.pitch, -5);
  assert.equal(pad.gain_db, -3);
  assert.equal(pad.choke, 2);
  assert.equal(pad.reverse, true);

  // The pattern clip: its loop, its patterns and its chain.
  const patternClip = snap.clips[clip];
  assert.equal(patternClip.kind, "pattern");
  assert.deepEqual(patternClip.notes, []);
  assert.equal(patternClip.length_steps, 16);
  assert.equal(patternClip.step_beats, 0.5);
  assert.equal(patternClip.swing, 0.5);
  // 16 steps of half a beat are 8 beats: two bars, derived from the loop.
  assert.equal(patternClip.length_bars, 2);
  assert.equal(patternClip.length_bars, lengthBarsForSteps(16, 0.5));
  assert.deepEqual(patternClip.chain, ["a", second]);
  assert.deepEqual(snap.patterns[patternKey(clip, "a")], {
    id: "a",
    clip_id: clip,
    name: "A",
    order: 0,
  });
  assert.equal(snap.patterns[patternKey(clip, second)].name, "Fill");

  // The steps, with their velocity and their locks.
  assert.deepEqual(snap.steps[stepKey(clip, "a", 0, bankId, 3)], {
    clip_id: clip,
    pattern_id: "a",
    at: 0,
    bank_id: bankId,
    index: 3,
    v: 127,
    locks: { cutoff_hz: 2500, decay_ms: 40 },
  });
  assert.deepEqual(snap.steps[stepKey(clip, second, 12, bankId, 3)], {
    clip_id: clip,
    pattern_id: second,
    at: 12,
    bank_id: bankId,
    index: 3,
    v: 100,
    locks: {},
  });

  // The lock check and the agent guard read the sample's users from here.
  assert.deepEqual(sampleUsers(snap, loop), [trackId]);
  assert.deepEqual(sampleUsers(snap, randomUUID()), []);
  assert.deepEqual(checkInvariants(s.doc), []);
});

test("shrinking a sample's slices refuses while a pad uses a removed slice", (t) => {
  const s = studio(t);
  const { trackId, bankId } = addKit(s.doc);
  const loop = addSample(s.doc, { frames: 48000 });
  s.run("slice.set", {
    sample_id: loop,
    slices: [
      { id: "s1", start_frame: 0, end_frame: 12000 },
      { id: "s2", start_frame: 12000, end_frame: 24000 },
    ],
  });
  s.run("pad.assign", { track_id: trackId, bank_id: bankId, index: 5, sample_id: loop, slice_id: "s2" });

  const refused = refuses(
    () => s.run("slice.set", { sample_id: loop, slices: [{ id: "s1", start_frame: 0, end_frame: 12000 }] }),
    "invalid",
  );
  assert.match(refused.message, /Pad 6/);
  assert.match(refused.message, /s2/);
  assert.deepEqual(
    Object.values(snapshot(s.doc).slices).map((slice) => slice.id).sort(),
    ["s1", "s2"],
    "the refused chop left both slices",
  );

  // Keeping both slices is fine, and so is moving one: a kept slice changes
  // its own range without touching the slice beside it.
  const moved = s.run("slice.set", {
    sample_id: loop,
    slices: [
      { id: "s1", start_frame: 0, end_frame: 12000 },
      { id: "s2", start_frame: 12000, end_frame: 30000 },
    ],
  });
  assert.deepEqual(Object.keys(moved.result.after), [`slice:${loop}/s2|*`]);
  assert.equal(snapshot(s.doc).slices[sliceKey(loop, "s2")].end_frame, 30000);
  assert.equal(snapshot(s.doc).slices[sliceKey(loop, "s2")].start_frame, 12000);
  assert.deepEqual(checkInvariants(s.doc), []);

  // A slice past the sample's frames is refused too.
  refuses(
    () => s.run("slice.set", { sample_id: loop, slices: [{ start_frame: 0, end_frame: 48001 }] }),
    "invalid",
  );
});

test("removing a sampler track and undoing it brings back its banks, pads, patterns and steps", (t) => {
  const s = studio(t);
  const { trackId, bankId } = addKit(s.doc, "Drums");
  const scene = addScene(s.doc);
  const loop = addSample(s.doc);
  s.run("pad.assign", { track_id: trackId, bank_id: bankId, index: 0, sample_id: loop });
  const clip = addPatternClip(s.doc, trackId, scene);
  s.run("step.toggle", { clip_id: clip, pattern_id: "a", at: 0, bank_id: bankId, index: 0 });

  const removed = s.run("track.remove", { track_id: trackId });
  // 16 pads of bank A, the bank, the clip's pattern and its step.
  assert.equal(Object.values(snapshot(s.doc).banks).length, 0);
  assert.equal(Object.values(snapshot(s.doc).pads).length, 0);
  assert.equal(Object.values(snapshot(s.doc).patterns).length, 0);
  assert.equal(Object.values(snapshot(s.doc).steps).length, 0);
  assert.ok(`bank:${trackId}/${bankId}|*` in removed.result.before);
  assert.ok(`pad:${trackId}/${bankId}/0|*` in removed.result.before);
  assert.ok(`pattern:${clip}/a|*` in removed.result.before);
  assert.ok(`step:${clip}/a/0/${bankId}.0|*` in removed.result.before);

  const undone = s.undo(removed.entry);
  assert.deepEqual(undone.plan.conflicts, []);
  assert.deepEqual(undone.plan.blocked, []);

  const back = snapshot(s.doc);
  assert.equal(back.tracks.find((track) => track.id === trackId)?.name, "Drums");
  assert.equal(Object.values(back.banks).filter((bank) => bank.track_id === trackId).length, 1);
  assert.equal(Object.values(back.pads).filter((pad) => pad.track_id === trackId).length, 16);
  assert.equal(back.pads[padKey(trackId, bankId, 0)].sample_id, loop, "the pad still plays its sample");
  assert.ok(back.patterns[patternKey(clip, "a")], "the clip's pattern came back");
  assert.deepEqual(back.steps[stepKey(clip, "a", 0, bankId, 0)].locks, {});
  // The samples stay in the song either way: a sample belongs to the song, not
  // to the track that plays it.
  assert.ok(back.samples[loop]);
  assert.deepEqual(checkInvariants(s.doc), []);
});