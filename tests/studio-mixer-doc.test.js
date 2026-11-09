/**
 * Studio mixer in the document: the effects of a track's, a return's and the
 * master's chain, the sends from a track to a return, the returns themselves and
 * the master — plus the shared history they lean on (each object is one small
 * object, so one edit is one field of one object) and the invariants that keep a
 * chain, a send and a return pointing at things the song still has.
 *
 * Every test builds its own song in memory and records its steps the way the
 * session hub does: one real registry command inside one `doc.transact(...)` per
 * step, undone through `history.js`. Nothing here touches a database or a
 * running instance.
 *
 * The engine half of the task — running the chains at the right place in the
 * signal path, the crossfade and the NaN guard — is Task 9's, and the mixer
 * screen is Task 10's. This file is the document they read.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

// The very module instance `server/doc.js` gets from `import * as Y from "yjs"`:
// the package's ESM build, not the CommonJS one (`require` and `import` resolve
// to different files, and two builds cannot share a document).
import * as Y from "../bundles/studio/node_modules/yjs/dist/yjs.mjs";
import {
  DEFAULT_MASTER,
  EFFECT_KINDS,
  EFFECT_PARAMS,
  LIMITS,
  MIXER_RANGES,
  checkInvariants,
  getInsert,
  getReturn,
  getSend,
  insertMap,
  masterMap,
  masterSettings,
  newSongDoc,
  objectMap,
  parseObjectRef,
  readField,
  returnMap,
  sendMap,
  snapshot,
  songMap,
} from "../bundles/studio/server/doc.js";
import {
  StudioError,
  listCommands,
  runCommand,
} from "../bundles/studio/server/commands/registry.js";
import "../bundles/studio/server/commands/core.js";
import "../bundles/studio/server/commands/takes.js";
import "../bundles/studio/server/commands/arrangement.js";
import "../bundles/studio/server/commands/sampler.js";
import "../bundles/studio/server/commands/library.js";
import "../bundles/studio/server/commands/instruments.js";
import "../bundles/studio/server/commands/mixer.js";
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

/**
 * A scratch song plus the two calls a hub makes: run a command and record its
 * entry, then undo or redo one recorded entry.
 * @param {import("node:test").TestContext} t
 */
function studio(t) {
  const doc = newSongDoc({ title: "Mixer song" });
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
      const result = doc.transact(() => runCommand(doc, id, args, { author }));
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

/** Add a track and return its id. */
function addTrack(doc, name = "Bass") {
  return runCommand(doc, "track.add", { name }).args.id;
}

/** Add a return and return its id. */
function addReturn(doc, name) {
  return runCommand(doc, "return.add", name === undefined ? {} : { name }).args.id;
}

/** Add one effect to a chain and return the command result. */
function addInsert(doc, owner, kind, extra = {}) {
  return runCommand(doc, "insert.add", { owner, kind, ...extra });
}

/** @returns {string} the ref of a track's chain. */
function trackOwner(trackId) {
  return `track:${trackId}`;
}

/** @returns {string} the ref of a return's chain. */
function returnOwner(returnId) {
  return `return:${returnId}`;
}

/** @returns {string[]} the kinds of one chain, in the order the engine runs them. */
function chainOf(doc, owner) {
  return Object.values(snapshot(doc).inserts)
    .filter((insert) => insert.owner === owner)
    .sort((a, b) => (a.order === b.order ? (a.id < b.id ? -1 : 1) : a.order - b.order))
    .map((insert) => insert.kind);
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

test("two peers adding inserts to one track keep both", (t) => {
  const s = studio(t);
  const track = addTrack(s.doc, "Bass");

  // Two peers of the same song, neither of which has seen the other's write: the
  // inserts container already exists on both (a new song makes it), so both
  // effects are two keys of one map rather than two maps racing for one key.
  const { other, sync } = pair(t, s);
  const addOn = (doc, kind) =>
    doc.transact(() => runCommand(doc, "insert.add", { owner: trackOwner(track), kind }));
  addOn(s.doc, "eq");
  addOn(other, "compressor");
  sync();

  const inserts = Object.values(snapshot(s.doc).inserts);
  assert.equal(inserts.length, 2, "both peers' effects survived the merge");
  assert.deepEqual(inserts.map((insert) => insert.kind).sort(), ["compressor", "eq"]);
  assert.deepEqual(chainOf(s.doc, trackOwner(track)).sort(), ["compressor", "eq"]);

  // Each one is a complete object: its parameters are filled with the table's
  // defaults, so the engine never has to guess a value.
  const compressor = inserts.find((insert) => insert.kind === "compressor");
  assert.equal(compressor.owner, trackOwner(track));
  assert.equal(compressor.bypass, false);
  assert.deepEqual(compressor.params, {
    detect: "peak",
    threshold_db: -18,
    ratio: 4,
    knee_db: 6,
    attack_ms: 10,
    release_ms: 100,
    makeup_db: 0,
    sidechain_hp_hz: 0,
  });

  // And both peers see the same song afterwards.
  assert.deepEqual(snapshot(other).inserts, snapshot(s.doc).inserts);
  assert.deepEqual(checkInvariants(s.doc), []);
});

test("an insert param edit is one field and undoes alone", (t) => {
  const s = studio(t);
  const track = addTrack(s.doc, "Bass");
  const ret = addReturn(s.doc);
  const insert = addInsert(s.doc, returnOwner(ret), "reverb").args.id;

  // One parameter is one field of the insert's own params map: the summary names
  // the effect, the field and the chain, and the before/after carry that field
  // and nothing else.
  const mix = s.run("insert.set", { id: insert, params: { mix: 0.4 } });
  assert.equal(mix.result.summary, "Set the reverb's mix on Return A to 0.4");
  assert.deepEqual(Object.keys(mix.result.before), [`insert:${insert}|params.mix`]);
  assert.equal(mix.result.before[`insert:${insert}|params.mix`], 0.25);
  assert.equal(mix.result.after[`insert:${insert}|params.mix`], 0.4);
  assert.equal(readField(s.doc, `insert:${insert}`, "params.mix"), 0.4);

  // A second parameter of the same insert, then the first one is undone: only
  // its own field goes back, and the neighbour keeps the value it was given.
  s.run("insert.set", { id: insert, params: { size: 0.8 } });
  const undone = s.undo(mix.entry);
  assert.deepEqual(undone.plan.conflicts, []);
  assert.deepEqual(undone.plan.blocked, []);
  assert.deepEqual([...undone.plan.apply.keys()], [`insert:${insert}|params.mix`]);
  const params = snapshot(s.doc).inserts[insert].params;
  assert.equal(params.mix, 0.25, "the undone parameter went back");
  assert.equal(params.size, 0.8, "the other parameter kept its value");

  // Two peers editing two parameters of one insert both win: they are two keys
  // of the params map, not two copies of one object.
  const { other, sync } = pair(t, s);
  const setOn = (doc, params) =>
    doc.transact(() => runCommand(doc, "insert.set", { id: insert, params }));
  setOn(s.doc, { damping: 0.9 });
  setOn(other, { predelay_ms: 40 });
  sync();
  const merged = snapshot(s.doc).inserts[insert].params;
  assert.equal(merged.damping, 0.9);
  assert.equal(merged.predelay_ms, 40);
  assert.deepEqual(checkInvariants(s.doc), []);
});

test("undoing one send keeps the others", (t) => {
  const s = studio(t);
  const track = addTrack(s.doc, "Vocals");
  const a = addReturn(s.doc);
  const b = addReturn(s.doc);
  assert.deepEqual(snapshot(s.doc).returns[a].name, "Return A");
  assert.deepEqual(snapshot(s.doc).returns[b].name, "Return B");

  const first = s.run("send.set", { track_id: track, return_id: a, level_db: -12 });
  assert.equal(first.result.summary, "Sent Vocals to Return A at -12 dB, after the fader");
  assert.deepEqual(first.result.after[`send:${track}/${a}|*`], {
    track_id: track,
    return_id: a,
    level_db: -12,
    pre: false,
  });
  // One send is its own object, keyed by the pair it joins.
  assert.deepEqual(Object.keys(snapshot(s.doc).sends), [`${track}/${a}`]);

  // A pre-fader send to a second return, and an update of the first one: one
  // field per write, so undoing any of them leaves the others where they are.
  const second = s.run("send.set", { track_id: track, return_id: b, level_db: -6, pre: true });
  assert.equal(second.result.summary, "Sent Vocals to Return B at -6 dB, before the fader");
  assert.equal(snapshot(s.doc).sends[`${track}/${b}`].pre, true);

  const undoFirst = s.undo(first.entry);
  assert.deepEqual(undoFirst.plan.conflicts, []);
  assert.deepEqual([...undoFirst.plan.apply.keys()], [`send:${track}/${a}|*`]);
  assert.deepEqual(Object.keys(snapshot(s.doc).sends), [`${track}/${b}`], "the second send stayed");

  // Redo puts the first send back exactly as it was.
  s.redo(undoFirst.entry);
  assert.deepEqual(snapshot(s.doc).sends[`${track}/${a}`], {
    track_id: track,
    return_id: a,
    level_db: -12,
    pre: false,
  });

  // A level given no `pre` is a post-fader send: `send.set` sets the whole send,
  // which is what the mixer's one control per send sends.
  const update = s.run("send.set", { track_id: track, return_id: b, level_db: -9 });
  assert.deepEqual(Object.keys(update.result.after).sort(), [
    `send:${track}/${b}|level_db`,
    `send:${track}/${b}|pre`,
  ]);
  assert.equal(snapshot(s.doc).sends[`${track}/${b}`].pre, false);

  // `level_db: null` takes the send away, whole.
  const remove = s.run("send.set", { track_id: track, return_id: b, level_db: null });
  assert.equal(remove.result.summary, "Took Vocals off Return B");
  assert.equal(snapshot(s.doc).sends[`${track}/${b}`], undefined);
  assert.deepEqual(checkInvariants(s.doc), []);
});

test("a 9th insert on a chain is refused", (t) => {
  const s = studio(t);
  const track = addTrack(s.doc, "Bass");
  for (let index = 0; index < LIMITS.insertsPerChain; index += 1) {
    addInsert(s.doc, trackOwner(track), "eq");
  }
  assert.equal(chainOf(s.doc, trackOwner(track)).length, LIMITS.insertsPerChain);

  const before = snapshot(s.doc);
  const refused = refuses(() => s.run("insert.add", { owner: trackOwner(track), kind: "delay" }), "limit");
  assert.match(refused.message, /A chain holds at most 8 effects\./);
  assert.deepEqual(snapshot(s.doc), before, "the refused add wrote nothing");

  // The cap is per chain, not per song: a return's chain has its own room.
  const ret = addReturn(s.doc);
  addInsert(s.doc, returnOwner(ret), "reverb");
  assert.equal(chainOf(s.doc, returnOwner(ret)).length, 1);

  // And so has the master's.
  addInsert(s.doc, "master", "limiter");
  assert.equal(chainOf(s.doc, "master").length, 1);
  assert.deepEqual(checkInvariants(s.doc), []);
});

test("a return in use cannot be removed", (t) => {
  const s = studio(t);
  const track = addTrack(s.doc, "Vocals");
  const ret = addReturn(s.doc);
  const insert = addInsert(s.doc, returnOwner(ret), "reverb").args.id;
  s.run("send.set", { track_id: track, return_id: ret, level_db: -6 });

  const refused = refuses(() => s.run("return.remove", { id: ret }), "conflict");
  assert.equal(refused.message, "Return A is still fed by 1 send; remove it first.");
  assert.ok(getReturn(s.doc, ret), "the return is still there");

  // With the send gone the return may go, and its own effects go with it in the
  // same step: one undo puts the return and its chain back together.
  s.run("send.set", { track_id: track, return_id: ret, level_db: null });
  const removed = s.run("return.remove", { id: ret });
  assert.equal(removed.result.summary, 'Removed the return "Return A"');
  assert.deepEqual(Object.keys(removed.result.before).sort(), [
    `insert:${insert}|*`,
    `return:${ret}|*`,
  ]);
  assert.deepEqual(removed.result.after[`insert:${insert}|*`], null);
  assert.equal(snapshot(s.doc).returns[ret], undefined);
  assert.equal(snapshot(s.doc).inserts[insert], undefined);
  assert.deepEqual(checkInvariants(s.doc), []);

  const undo = s.undo(removed.entry);
  assert.deepEqual(undo.plan.conflicts, []);
  assert.deepEqual(undo.plan.blocked, []);
  assert.equal(snapshot(s.doc).returns[ret].name, "Return A");
  assert.deepEqual(snapshot(s.doc).inserts[insert].params, {
    size: 0.5,
    damping: 0.5,
    predelay_ms: 20,
    mix: 0.25,
  });
  // The send was removed before the return went, so undoing the removal does not
  // bring a send back that the operator took away themselves.
  assert.equal(snapshot(s.doc).sends[`${track}/${ret}`], undefined);
  assert.deepEqual(checkInvariants(s.doc), []);
});

test("returns are not tracks", (t) => {
  const s = studio(t);
  for (let index = 0; index < LIMITS.tracks; index += 1) addTrack(s.doc, `Track ${index + 1}`);

  // The song is full of tracks, and a return still fits: a return is its own
  // mixer channel, counted by its own cap and never by `LIMITS.tracks`.
  const ret = addReturn(s.doc);
  assert.equal(Object.keys(snapshot(s.doc).returns).length, 1);
  assert.equal(snapshot(s.doc).tracks.length, LIMITS.tracks);
  assert.deepEqual(
    snapshot(s.doc).tracks.map((track) => track.id).includes(ret),
    false,
    "a return is never one of the tracks",
  );
  refuses(() => addTrack(s.doc, "Seventeen"), "limit");

  // A return is not a chain owner mistake either: its own effects sit on it, and
  // the song still passes its invariants with 16 tracks and a return.
  addInsert(s.doc, returnOwner(ret), "chorus");
  assert.deepEqual(checkInvariants(s.doc), []);

  // The cap is returns per song, and it refuses by name.
  for (let index = 1; index < LIMITS.returnsPerSong; index += 1) addReturn(s.doc);
  assert.equal(Object.keys(snapshot(s.doc).returns).length, LIMITS.returnsPerSong);
  const full = refuses(() => addReturn(s.doc), "limit");
  assert.match(full.message, /at most 8 returns/);

  // The default names run out letters, and a name may be chosen instead.
  const named = newSongDoc({ title: "Named returns" });
  t.after(() => named.destroy());
  const custom = runCommand(named, "return.add", { name: "Plate" }).args.id;
  assert.equal(snapshot(named).returns[custom].name, "Plate");
  const first = runCommand(named, "return.add", {}).args.id;
  const second = runCommand(named, "return.add", {}).args.id;
  assert.equal(snapshot(named).returns[first].name, "Return A", "the first free letter, not a letter tied to the count");
  assert.equal(snapshot(named).returns[second].name, "Return B");
});

test("an old song opens with empty chains and a default master", (t) => {
  // A song written before the mixer existed: the containers 1a to 1c created
  // and nothing else. It reads exactly like a song with an empty mixer.
  const doc = new Y.Doc();
  t.after(() => doc.destroy());
  const song = doc.getMap("song");
  doc.transact(() => {
    song.set("meta", { title: "An old song", bpm: 110, meter: [4, 4], key: "A minor" });
    const tracks = new Y.Array();
    tracks.push([
      objectMap({
        id: "bass",
        name: "Bass",
        color: "#E8C07A",
        device: { engine: "sunvox", type: "Analog generator", params: {} },
        mute: false,
        solo: false,
        gain_db: 0,
        pan: 0,
        locked: false,
      }),
    ]);
    song.set("tracks", tracks);
    song.set("scenes", new Y.Array());
    song.set("clips", new Y.Map());
    song.set("takes", new Y.Map());
  }, "test:old-song");

  const snap = snapshot(doc);
  assert.deepEqual(snap.inserts, {});
  assert.deepEqual(snap.sends, {});
  assert.deepEqual(snap.returns, {});
  assert.deepEqual(snap.master, DEFAULT_MASTER);
  assert.equal(snap.master.gain_db, 0);
  assert.deepEqual(snap.master.target, { lufs: -14, true_peak_db: -1 });
  assert.deepEqual(checkInvariants(doc), []);

  // Reading it wrote nothing: the four containers are still missing, and the
  // master is still whatever the song had (nothing at all).
  for (const key of ["inserts", "sends", "returns", "master"]) {
    assert.equal(songMap(doc).get(key), undefined, `${key} is not invented by a read`);
  }

  // The first mixer edit makes the container it needs, and the song reads the
  // same way a new one does from then on.
  const inserted = addInsert(doc, trackOwner("bass"), "eq");
  assert.ok(getInsert(doc, inserted.args.id));
  assert.deepEqual(chainOf(doc, trackOwner("bass")), ["eq"]);

  runCommand(doc, "master.set", { gain_db: -3 });
  assert.equal(snapshot(doc).master.gain_db, -3);
  assert.deepEqual(snapshot(doc).master.target, DEFAULT_MASTER.target);
  assert.deepEqual(checkInvariants(doc), []);
});

test("insert params out of range are refused by name", (t) => {
  const s = studio(t);
  const track = addTrack(s.doc, "Bass");
  const insert = addInsert(s.doc, trackOwner(track), "compressor").args.id;
  const before = snapshot(s.doc);

  // A number outside its range names the parameter and the range it runs over.
  const ratio = refuses(() => s.run("insert.set", { id: insert, params: { ratio: 30 } }), "invalid");
  assert.match(ratio.message, /compressor/);
  assert.match(ratio.message, /"ratio" is 30; it runs from 1 to 20\./);

  // A parameter the effect does not have lists the ones it does.
  const unknown = refuses(() => s.run("insert.set", { id: insert, params: { wet: 0.5 } }), "invalid");
  assert.match(unknown.message, /has no parameter "wet"/);
  assert.match(unknown.message, /detect, threshold_db, ratio/);

  // A chooser takes only its own values.
  const mode = refuses(
    () => addInsert(s.doc, trackOwner(track), "filter", { params: { mode: "notch" } }),
    "invalid",
  );
  assert.match(mode.message, /"mode" is "notch"; it is one of lp, hp, bp\./);

  // An add with a bad parameter writes nothing at all.
  const add = refuses(
    () => addInsert(s.doc, trackOwner(track), "reverb", { params: { mix: 2 } }),
    "invalid",
  );
  assert.match(add.message, /"mix" is 2; it runs from 0 to 1\./);
  assert.deepEqual(snapshot(s.doc), before);

  // The allowed value at the edge is still allowed.
  s.run("insert.set", { id: insert, params: { ratio: 20, threshold_db: -60 } });
  assert.equal(snapshot(s.doc).inserts[insert].params.ratio, 20);
  assert.deepEqual(checkInvariants(s.doc), []);
});

test("removing a track removes its inserts and sends in one undo", (t) => {
  const s = studio(t);
  const bass = addTrack(s.doc, "Bass");
  const ret = addReturn(s.doc);
  const first = addInsert(s.doc, trackOwner(bass), "eq").args.id;
  const second = addInsert(s.doc, trackOwner(bass), "compressor").args.id;
  const returnInsert = addInsert(s.doc, returnOwner(ret), "delay").args.id;
  s.run("send.set", { track_id: bass, return_id: ret, level_db: -9 });

  const removed = s.run("track.remove", { track_id: bass });
  assert.equal(removed.result.summary, 'Removed track "Bass"');
  // The track's chain and its sends are recorded under their own refs, in the
  // same step, so one undo brings the whole mix back.
  assert.deepEqual(Object.keys(removed.result.before).sort(), [
    `insert:${first}|*`,
    `insert:${second}|*`,
    `send:${bass}/${ret}|*`,
    `track:${bass}|*`,
  ].sort());
  assert.ok(removed.result.touched.includes(`insert:${first}`));
  assert.ok(removed.result.touched.includes(`send:${bass}/${ret}`));

  const snap = snapshot(s.doc);
  assert.deepEqual(snap.tracks, []);
  assert.equal(snap.inserts[first], undefined);
  assert.equal(snap.inserts[second], undefined);
  assert.equal(snap.sends[`${bass}/${ret}`], undefined);
  assert.ok(snap.inserts[returnInsert], "a return's chain is not the track's to take");
  assert.ok(snap.returns[ret]);
  assert.deepEqual(checkInvariants(s.doc), []);

  const undo = s.undo(removed.entry);
  assert.deepEqual(undo.plan.conflicts, []);
  assert.deepEqual(undo.plan.blocked, []);
  const restored = snapshot(s.doc);
  assert.equal(restored.tracks[0].id, bass);
  assert.equal(restored.inserts[first].kind, "eq");
  assert.equal(restored.inserts[first].params.mid_freq_hz, 1000, "the chain came back with its parameters");
  assert.equal(restored.inserts[second].kind, "compressor");
  assert.deepEqual(restored.sends[`${bass}/${ret}`], {
    track_id: bass,
    return_id: ret,
    level_db: -9,
    pre: false,
  });
  assert.deepEqual(checkInvariants(s.doc), []);

  // The restored chain is still editable one parameter at a time, which is what
  // makes a whole-object restore safe: `params` came back as its own map.
  s.run("insert.set", { id: first, params: { high_gain_db: 3 } });
  assert.equal(snapshot(s.doc).inserts[first].params.high_gain_db, 3);
});

test("master.set validates the target", (t) => {
  const s = studio(t);
  const before = snapshot(s.doc);

  // A target outside its ranges is refused by name and by range, and nothing is
  // written: a mix that claims to aim at -40 LUFS would be a different song.
  const lufs = refuses(() => s.run("master.set", { target: { lufs: -40 } }), "invalid");
  assert.match(lufs.message, /master's target is -40 LUFS; it runs from -30 to -6 LUFS\./);
  const peak = refuses(() => s.run("master.set", { target: { true_peak_db: 1 } }), "invalid");
  assert.match(peak.message, /true-peak ceiling is 1 dBTP; it runs from -6 to -0.1 dBTP\./);
  const gain = refuses(() => s.run("master.set", { gain_db: 20 }), "invalid");
  assert.match(gain.message, /master's gain is 20 dB; it runs from -24 to 12 dB\./);
  assert.deepEqual(snapshot(s.doc), before);

  // A target field left out keeps its value: the target is one field, and each
  // pick writes it whole.
  s.run("master.set", { target: { lufs: -16 } });
  assert.deepEqual(snapshot(s.doc).master.target, { lufs: -16, true_peak_db: -1 });
  const set = s.run("master.set", { gain_db: -3, target: { true_peak_db: -2 } });
  assert.deepEqual(snapshot(s.doc).master, { gain_db: -3, target: { lufs: -16, true_peak_db: -2 } });
  assert.deepEqual(Object.keys(set.result.after).sort(), ["master|gain_db", "master|target"]);
  assert.equal(set.result.summary, "Set the master gain to -3 dB and target to -16 LUFS at -2 dBTP");

  // The master's two fields undo on their own.
  const undo = s.undo(set.entry);
  assert.deepEqual(undo.plan.conflicts, []);
  assert.deepEqual([...undo.plan.apply.keys()].sort(), ["master|gain_db", "master|target"]);
  assert.deepEqual(snapshot(s.doc).master, { gain_db: 0, target: { lufs: -16, true_peak_db: -1 } });

  // A read of the master answers the value every reader sees, defaults included.
  assert.equal(readField(s.doc, "master", "gain_db"), 0);
  assert.deepEqual(readField(s.doc, "master", "target"), { lufs: -16, true_peak_db: -1 });
  assert.deepEqual(parseObjectRef("master"), { kind: "master", id: "master" });
  assert.deepEqual(checkInvariants(s.doc), []);
});

test("an effect joins the end of its chain and moves where it is told", (t) => {
  const s = studio(t);
  const track = addTrack(s.doc, "Bass");
  const eq = addInsert(s.doc, trackOwner(track), "eq").args.id;

  // With no `after`, an effect joins the END of the chain: adding one more
  // effect to a track is the common case, and it belongs after what is there.
  const compressor = addInsert(s.doc, trackOwner(track), "compressor").args.id;
  assert.deepEqual(chainOf(s.doc, trackOwner(track)), ["eq", "compressor"]);
  assert.deepEqual(snapshot(s.doc).inserts[compressor].order, 1);

  // `after` places it right behind the effect it names, between it and the next
  // one: one fractional order, and nothing else in the chain moves.
  const delay = addInsert(s.doc, trackOwner(track), "delay", { after: eq }).args.id;
  assert.deepEqual(chainOf(s.doc, trackOwner(track)), ["eq", "delay", "compressor"]);
  const between = snapshot(s.doc).inserts[delay].order;
  assert.ok(between > snapshot(s.doc).inserts[eq].order && between < snapshot(s.doc).inserts[compressor].order);

  // `insert.move` with `after: null` puts an effect FIRST; the move writes one
  // field of one insert and no other field at all.
  const moved = s.run("insert.move", { id: compressor, after: null });
  assert.deepEqual(Object.keys(moved.result.after), [`insert:${compressor}|order`]);
  assert.deepEqual(chainOf(s.doc, trackOwner(track)), ["compressor", "eq", "delay"]);

  // And `after: <id>` puts it behind that one, at the end when it is the last.
  s.run("insert.move", { id: eq, after: delay });
  assert.deepEqual(chainOf(s.doc, trackOwner(track)), ["compressor", "delay", "eq"]);

  // An `after` that names no effect in this chain is refused by name, and an
  // effect cannot be moved after itself.
  const stranger = refuses(
    () => s.run("insert.move", { id: eq, after: "not-here" }),
    "invalid",
  );
  assert.match(stranger.message, /no insert "not-here"/);
  refuses(() => s.run("insert.move", { id: eq, after: eq }), "invalid");
  refuses(
    () => addInsert(s.doc, trackOwner(track), "reverb", { after: "not-here" }),
    "invalid",
  );

  // Bypass is one field of the insert too, so it undoes on its own.
  const bypass = s.run("insert.bypass", { id: compressor, bypass: true });
  assert.equal(bypass.result.summary, "Bypassed the compressor on Bass");
  assert.equal(snapshot(s.doc).inserts[compressor].bypass, true);
  s.undo(bypass.entry);
  assert.equal(snapshot(s.doc).inserts[compressor].bypass, false);
  assert.deepEqual(checkInvariants(s.doc), []);
});

test("the effect table lists every kind and its ranges", () => {
  assert.deepEqual(EFFECT_KINDS, Object.keys(EFFECT_PARAMS));
  assert.deepEqual(EFFECT_KINDS, [
    "eq",
    "filter",
    "delay",
    "reverb",
    "chorus",
    "phaser",
    "saturation",
    "compressor",
    "limiter",
    "gate",
    "deesser",
  ]);
  // The table is frozen all the way down: one reader cannot edit another's copy,
  // and a range exists in exactly one place.
  assert.equal(Object.isFrozen(EFFECT_PARAMS), true);
  assert.equal(Object.isFrozen(EFFECT_PARAMS.reverb), true);
  assert.equal(Object.isFrozen(EFFECT_PARAMS.reverb.params), true);
  assert.equal(Object.isFrozen(EFFECT_PARAMS.reverb.params.mix), true);
  assert.equal(Object.isFrozen(EFFECT_PARAMS.filter.params.mode.values), true);

  assert.deepEqual(EFFECT_PARAMS.reverb.params.mix, { min: 0, max: 1, default: 0.25, unit: "" });
  assert.deepEqual(EFFECT_PARAMS.limiter.params.ceiling_db, { min: -6, max: -0.1, default: -1, unit: "dB" });
  assert.deepEqual(EFFECT_PARAMS.filter.params.mode, { values: ["lp", "hp", "bp"], default: "lp" });
  assert.deepEqual(EFFECT_PARAMS.compressor.params.detect, { values: ["peak", "rms"], default: "peak" });
  assert.deepEqual(MIXER_RANGES.master.true_peak_db, [-6, -0.1]);
  assert.deepEqual(MIXER_RANGES.master.gain_db, [-24, 12]);
  assert.deepEqual(MIXER_RANGES.return.gain_db, [-60, 12]);
  assert.deepEqual(MIXER_RANGES.send.level_db, [-60, 6]);
  assert.equal(MIXER_RANGES.master.lufs[0], -30);

  // Every kind the panel can add has a label and at least one parameter, and
  // `amp` is PR C's: the table does not hold it, and `insert.add` says so.
  for (const kind of EFFECT_KINDS) {
    assert.equal(typeof EFFECT_PARAMS[kind].label, "string");
    assert.ok(Object.keys(EFFECT_PARAMS[kind].params).length > 0, `${kind} has parameters`);
  }
  assert.equal("amp" in EFFECT_PARAMS, false);
});

test("an amp insert is refused until PR C", (t) => {
  const s = studio(t);
  const track = addTrack(s.doc, "Guitar");
  const refused = refuses(() => addInsert(s.doc, trackOwner(track), "amp"), "invalid");
  assert.equal(refused.message, "Amp inserts arrive in a later Studio version.");
  assert.deepEqual(snapshot(s.doc).inserts, {});
});

test("the mixer commands are in the registry and the master map is one object", (t) => {
  const ids = listCommands().map((command) => command.id);
  for (const id of [
    "insert.add",
    "insert.remove",
    "insert.move",
    "insert.set",
    "insert.bypass",
    "return.add",
    "return.set",
    "return.remove",
    "send.set",
    "master.set",
  ]) {
    assert.ok(ids.includes(id), `${id} is registered`);
  }

  // The master is a Y.Map of its own, one per song, so `readField("master")` by
  // whole ref answers the defaults of a song nobody has touched.
  const doc = newSongDoc({ title: "Master", bpm: 100 });
  t.after(() => doc.destroy());
  assert.ok(masterMap(doc) instanceof Y.Map);
  assert.deepEqual(masterSettings(doc), DEFAULT_MASTER);
  assert.deepEqual(readField(doc, "master"), DEFAULT_MASTER);

  // The three mixer containers are Y.Maps keyed as their interfaces say.
  assert.ok(insertMap(doc) instanceof Y.Map);
  assert.ok(sendMap(doc) instanceof Y.Map);
  assert.ok(returnMap(doc) instanceof Y.Map);
  const ret = addReturn(doc);
  assert.equal(getReturn(doc, ret).get("name"), "Return A");
  const track = addTrack(doc, "Keys");
  runCommand(doc, "send.set", { track_id: track, return_id: ret, level_db: -6 });
  assert.equal(getSend(doc, track, ret).get("level_db"), -6);
});