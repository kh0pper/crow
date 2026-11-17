/**
 * Studio MIDI mappings in the document: the allow-list of live actions, the
 * mapping commands, the agent/operator split (a proposal against a live
 * mapping), the two device profiles, and the router that reads them.
 *
 * Every test builds its own song in memory and records its steps the way the
 * session hub does: one real registry command inside one `doc.transact(...)`
 * per step, undone through `history.js`. Nothing here touches a database or a
 * running instance.
 *
 * The hub side of the task — the guard that refuses an agent's command, undo or
 * redo over an accepted mapping — needs the real hub and a scratch database, so
 * that test lives beside the hub's (`agent undo cannot change an accepted
 * mapping`, in tests/studio-hub.test.js).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { LIMITS, midiMap, newSongDoc, snapshot } from "../bundles/studio/server/doc.js";
import {
  StudioError,
  getCommand,
  runCommand,
} from "../bundles/studio/server/commands/registry.js";
import "../bundles/studio/server/commands/core.js";
import "../bundles/studio/server/commands/takes.js";
import "../bundles/studio/server/commands/arrangement.js";
import "../bundles/studio/server/commands/sampler.js";
import {
  FCB1010_PROFILE,
  MIDI_ACTION_KINDS,
  MIDI_ACTIONS,
  MIDI_NEEDS_A_YES,
  MPK_MINI_PROFILE,
  routeFor,
} from "../bundles/studio/server/commands/midi.js";
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
  const doc = newSongDoc({ title: "MIDI song" });
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

/** Add a scene and return its id. */
function addScene(doc, name) {
  return runCommand(doc, "scene.add", { name }).args.id;
}

/** Add a track and return its id. */
function addTrack(doc, name, extra = {}) {
  return runCommand(doc, "track.add", { name, ...extra }).args.id;
}

/** Add a sampler track and return its id and the id of its one bank. */
function addKit(doc, name = "Drums") {
  const trackId = addTrack(doc, name, { kind: "sampler" });
  const bank = Object.values(snapshot(doc).banks).find((item) => item.track_id === trackId);
  return { trackId, bankId: bank.id };
}

/** @returns {{type: string, channel: number, number: number}} a MIDI message. */
function message(type, channel, number) {
  return { type, channel, number };
}

/** @returns {object|null} what one message routes to, from the live document. */
function routed(doc, incoming) {
  return routeFor(snapshot(doc), incoming);
}

test("a mapping to a non-allowed command is refused", (t) => {
  const s = studio(t);
  const scene = addScene(s.doc, "Verse");
  addTrack(s.doc, "Bass");
  const { trackId, bankId } = addKit(s.doc);
  const before = s.entries.length;

  // Every one of these is a command rather than a live action: one edits the
  // song's structure (`track.remove`), two are people-only (`pad.clear`,
  // `track.lock`), one is Studio's own (`sample.add`), one is a kind 1c leaves
  // to the voice work (`voice.talk`), and one does not exist at all.
  const forbidden = [
    { kind: "track.remove", track_id: trackId },
    { kind: "pad.clear", track_id: trackId, bank_id: bankId, index: 0 },
    { kind: "track.lock", track_id: trackId },
    { kind: "sample.add", sample: { id: "not-a-sample" } },
    { kind: "voice.talk" },
    { kind: "scene.launch_now", scene_id: scene },
  ];

  for (const action of forbidden) {
    const error = refuses(
      () =>
        s.run(
          "midi.map",
          { device_name: "MPK Mini", message: message("note", 10, 36), action },
          HUMAN,
        ),
      "invalid",
    );
    // The refusal names the actions a mapping MAY run, so a caller learns the
    // allow-list from being told no.
    assert.match(error.message, /"scene\.launch"/);
    assert.match(error.message, /"pad\.play"/);
    assert.match(error.message, /"keys\.play"/);
    assert.match(error.message, new RegExp(`"${action.kind.replace(/\./g, "\\.")}"`));
  }

  assert.deepEqual(snapshot(s.doc).midi_maps, {}, "nothing was written");
  assert.equal(s.entries.length, before, "a refused mapping is not a history step");

  // The allow-list is one frozen table, and every kind in it has a schema.
  const kinds = Object.keys(MIDI_ACTIONS).sort();
  assert.deepEqual([...MIDI_ACTION_KINDS].sort(), kinds);
  assert.equal(Object.isFrozen(MIDI_ACTIONS), true);
  assert.equal(kinds.includes("voice.talk"), false, "voice.talk is not in 1c");
  assert.equal(kinds.includes("track.remove"), false);
});

test("the agent proposes but cannot apply a mapping", (t) => {
  const s = studio(t);
  const scene = addScene(s.doc, "Verse");
  const pedal = message("pc", 1, 0);
  const action = { kind: "scene.launch", scene_id: scene };

  const mapped = s.run("midi.map", { id: "m1", device_name: "FCB1010", message: pedal, action }, AGENT);
  assert.match(mapped.result.summary, /^Proposed mapping program change 0 on "FCB1010"/);

  const proposal = snapshot(s.doc).midi_maps.m1;
  assert.equal(proposal.proposed, true);
  assert.equal(proposal.set_by, "agent");
  assert.equal(proposal.accepted_action, null, "a proposal has nothing accepted yet");
  assert.deepEqual(proposal.action, action);

  // A proposal is never routed, and the agent cannot make it live...
  assert.equal(routed(s.doc, { device_name: "FCB1010", ...pedal }), null);
  const refuseAccept = refuses(() => s.run("midi.accept", { id: "m1", expect: { device_name: "FCB1010", message: pedal, action } }, AGENT), "human_only");
  assert.equal(refuseAccept.message, MIDI_NEEDS_A_YES);
  // ...nor change the proposal it made a moment ago: it proposes a new one.
  const refuseEdit = refuses(
    () =>
      s.run(
        "midi.map",
        { id: "m1", device_name: "FCB1010", message: pedal, action: { kind: "stop_all" } },
        AGENT,
      ),
    "human_only",
  );
  assert.equal(refuseEdit.message, "An agent proposes a new mapping; it cannot change mapping m1.");

  // The operator's yes is what makes it live, and then it routes at once.
  const accepted = s.run("midi.accept", { id: "m1", expect: { device_name: "FCB1010", message: pedal, action } }, HUMAN);
  assert.match(accepted.result.summary, /^Accepted the mapping program change 0 on "FCB1010"/);
  const live = snapshot(s.doc).midi_maps.m1;
  assert.equal(live.proposed, false);
  assert.deepEqual(live.accepted_action, action);
  assert.deepEqual(routed(s.doc, { device_name: "FCB1010", ...pedal }), { id: "m1", action });

  // Once accepted it is the operator's: an agent may neither take it away...
  const refuseRemove = refuses(() => s.run("midi.remove", { id: "m1" }, AGENT), "human_only");
  assert.equal(refuseRemove.message, MIDI_NEEDS_A_YES);
  // ...nor accept it twice.
  refuses(() => s.run("midi.accept", { id: "m1", expect: { device_name: "FCB1010", message: pedal, action } }, HUMAN), "conflict");
  assert.ok(snapshot(s.doc).midi_maps.m1, "the refused removal left the mapping");

  // The operator removes it, and nothing routes any more.
  s.run("midi.remove", { id: "m1" }, HUMAN);
  assert.deepEqual(snapshot(s.doc).midi_maps, {});
  assert.equal(routed(s.doc, { device_name: "FCB1010", ...pedal }), null);
});

test("an agent's pad.hold, pad.roll and pad.pause_all are proposals; the operator's yes makes them route", (t) => {
  const s = studio(t);
  const cases = [
    { kind: "pad.hold", device: "Pad kit", message: message("note", 10, 36) },
    { kind: "pad.roll", device: "Pad kit", message: message("cc", 10, 20) },
    { kind: "pad.pause_all", device: "FCB1010", message: message("pc", 1, 3) },
  ];

  for (const [at, one] of cases.entries()) {
    const id = `perf-${at}`;
    const action = { kind: one.kind };
    const incoming = { device_name: one.device, ...one.message };

    // The agent proposes: the mapping is stored, and nothing routes.
    s.run("midi.map", { id, device_name: one.device, message: one.message, action }, AGENT);
    const proposal = snapshot(s.doc).midi_maps[id];
    assert.equal(proposal.proposed, true, `${one.kind} from an agent is only a proposal`);
    assert.equal(proposal.set_by, "agent", `${one.kind} still says who proposed it`);
    assert.equal(proposal.accepted_action, null, `${one.kind} has nothing accepted yet`);
    assert.equal(routed(s.doc, incoming), null, `${one.kind} routes nothing while it is a proposal`);

    // The agent cannot say yes for the operator.
    const refuseAccept = refuses(
      () =>
        s.run(
          "midi.accept",
          { id, expect: { device_name: one.device, message: one.message, action } },
          AGENT,
        ),
      "human_only",
    );
    assert.equal(refuseAccept.message, MIDI_NEEDS_A_YES, `${one.kind}: ${MIDI_NEEDS_A_YES}`);

    // The operator's yes is what makes it live, and then it routes.
    s.run("midi.accept", { id, expect: { device_name: one.device, message: one.message, action } }, HUMAN);
    assert.deepEqual(routed(s.doc, incoming), { id, action }, `${one.kind} routes once accepted`);

    // And once live it is the operator's: the agent cannot remove it.
    const refuseRemove = refuses(() => s.run("midi.remove", { id }, AGENT), "human_only");
    assert.equal(refuseRemove.message, MIDI_NEEDS_A_YES, `${one.kind} stays live: ${MIDI_NEEDS_A_YES}`);
    assert.ok(snapshot(s.doc).midi_maps[id], `the refused removal left ${one.kind} in the song`);
  }
});

test("an FCB1010 profile proposes one pedal per scene in order", (t) => {
  const s = studio(t);
  const verse = addScene(s.doc, "Verse");
  const chorus = addScene(s.doc, "Chorus");
  const bridge = addScene(s.doc, "Bridge");
  const bass = addTrack(s.doc, "Bass");
  const padTrack = addTrack(s.doc, "Pad");
  const { trackId: kit, bankId } = addKit(s.doc);

  const proposed = s.run(
    "midi.propose_profile",
    { device: "fcb1010", device_name: "FCB1010" },
    AGENT,
  );
  assert.match(
    proposed.result.summary,
    /^Proposed 3 pedal mappings \(one per scene\) and 2 expression pedal mappings/,
  );

  const snap = snapshot(s.doc);
  const scenes = [verse, chorus, bridge];
  for (const [index, sceneId] of scenes.entries()) {
    const mapping = snap.midi_maps[`fcb1010-pedal-${index + 1}`];
    assert.ok(mapping, `pedal ${index + 1} should be proposed`);
    assert.deepEqual(mapping.message, {
      type: "pc",
      channel: FCB1010_PROFILE.pedal.channel,
      number: index,
    });
    assert.deepEqual(mapping.action, { kind: "scene.launch", scene_id: sceneId });
    assert.equal(mapping.proposed, true, "a profile is never live, even for the operator");
    assert.equal(mapping.set_by, "agent");
    assert.equal(mapping.accepted_action, null);
  }
  assert.equal(Object.keys(snap.midi_maps).filter((id) => id.startsWith("fcb1010-pedal-")).length, 3);

  assert.deepEqual(snap.midi_maps["fcb1010-exp-a"].message, { type: "cc", channel: 1, number: 27 });
  assert.deepEqual(snap.midi_maps["fcb1010-exp-a"].action, { kind: "mix.gain", track_id: bass });
  assert.deepEqual(snap.midi_maps["fcb1010-exp-b"].message, { type: "cc", channel: 1, number: 7 });
  assert.deepEqual(snap.midi_maps["fcb1010-exp-b"].action, { kind: "mix.gain", track_id: padTrack });

  // Not one proposal routes.
  assert.equal(routed(s.doc, { device_name: "FCB1010", ...message("pc", 1, 0) }), null);
  assert.equal(routed(s.doc, { device_name: "FCB1010", ...message("cc", 1, 27) }), null);

  // The MPK Mini's profile, on the same song: its pads play the first sampler
  // track's bank A pads 1-8 and its knobs turn macro knobs 1-8. It proposes no
  // keys row: the page does not play keys yet, so `keys.play` would claim a
  // channel and play nothing.
  s.run("midi.propose_profile", { device: "mpk_mini", device_name: "MPK Mini" }, AGENT);
  const withMpk = snapshot(s.doc);
  for (let index = 0; index < MPK_MINI_PROFILE.pads.count; index += 1) {
    const padMapping = withMpk.midi_maps[`mpk_mini-pad-${index + 1}`];
    assert.deepEqual(padMapping.message, { type: "note", channel: 10, number: 36 + index });
    assert.deepEqual(padMapping.action, { kind: "pad.play", track_id: kit, bank_id: bankId, index });
    const knob = withMpk.midi_maps[`mpk_mini-knob-${index + 1}`];
    assert.deepEqual(knob.message, { type: "cc", channel: 1, number: 70 + index });
    assert.deepEqual(knob.action, { kind: "macro.set", index });
  }
  assert.equal(withMpk.midi_maps["mpk_mini-keys"], undefined, "no keys row is proposed yet");
  assert.equal(
    Object.values(withMpk.midi_maps).filter((mapping) => mapping.action.kind === "keys.play").length,
    0,
    "and nothing else claims the keys",
  );
  assert.equal(
    Object.keys(withMpk.midi_maps).filter((id) => id.startsWith("mpk_mini-")).length,
    MPK_MINI_PROFILE.pads.count + MPK_MINI_PROFILE.knobs.count,
  );

  // A song that already holds one of a profile's rows is refused the whole
  // profile rather than silently rewriting it.
  refuses(
    () => s.run("midi.propose_profile", { device: "fcb1010", device_name: "FCB1010" }, AGENT),
    "conflict",
  );

  // An explicit scene order is what the pedals follow, and only as many pedals
  // as it names.
  const other = studio(t);
  const first = addScene(other.doc, "Verse");
  const second = addScene(other.doc, "Chorus");
  other.run(
    "midi.propose_profile",
    { device: "fcb1010", device_name: "FCB1010", scene_order: [second, first] },
    HUMAN,
  );
  const ordered = snapshot(other.doc);
  assert.deepEqual(ordered.midi_maps["fcb1010-pedal-1"].action, {
    kind: "scene.launch",
    scene_id: second,
  });
  assert.deepEqual(ordered.midi_maps["fcb1010-pedal-2"].action, {
    kind: "scene.launch",
    scene_id: first,
  });
  assert.equal(ordered.midi_maps["fcb1010-pedal-3"], undefined);
  assert.equal(ordered.midi_maps["fcb1010-pedal-1"].set_by, "operator", "the author is recorded either way");
  assert.equal(ordered.midi_maps["fcb1010-pedal-1"].proposed, true);
});

test("257th mapping refused", (t) => {
  const s = studio(t);
  addScene(s.doc, "Verse");

  for (let index = 0; index < LIMITS.midiMaps; index += 1) {
    s.run(
      "midi.map",
      {
        id: `m${index}`,
        device_name: "FCB1010",
        message: message("cc", 1, index % 128),
        action: { kind: "transport.play" },
      },
      AGENT,
    );
  }
  assert.equal(Object.keys(snapshot(s.doc).midi_maps).length, LIMITS.midiMaps);

  const error = refuses(
    () =>
      s.run(
        "midi.map",
        {
          id: "one-too-many",
          device_name: "FCB1010",
          message: message("note", 2, 60),
          action: { kind: "transport.play" },
        },
        AGENT,
      ),
    "limit",
  );
  assert.match(error.message, new RegExp(`${LIMITS.midiMaps}`));
  assert.equal(Object.keys(snapshot(s.doc).midi_maps).length, LIMITS.midiMaps);
});

test("proposed mappings are never routed", (t) => {
  const s = studio(t);
  const bass = addTrack(s.doc, "Bass");
  const pedal = message("cc", 1, 7);

  s.run(
    "midi.map",
    { id: "proposal", device_name: "FCB1010", message: pedal, action: { kind: "transport.play" } },
    AGENT,
  );
  assert.equal(routed(s.doc, { device_name: "FCB1010", ...pedal }), null);

  // The operator's own mapping for the same message is live, and it is the one
  // that answers: a proposal beside a live mapping changes nothing.
  s.run(
    "midi.map",
    {
      id: "live",
      device_name: "FCB1010",
      message: pedal,
      action: { kind: "mix.gain", track_id: bass },
    },
    HUMAN,
  );
  assert.deepEqual(routed(s.doc, { device_name: "FCB1010", ...pedal }), {
    id: "live",
    action: { kind: "mix.gain", track_id: bass },
  });

  // A message only a proposal answers still answers nothing.
  s.run(
    "midi.map",
    {
      id: "proposal-2",
      device_name: "FCB1010",
      message: message("cc", 1, 8),
      action: { kind: "stop_all" },
    },
    AGENT,
  );
  assert.equal(routed(s.doc, { device_name: "FCB1010", ...message("cc", 1, 8) }), null);

  // Nor does another controller's identical message reach it.
  assert.equal(routed(s.doc, { device_name: "MPK Mini", ...pedal }), null);
});

test("a mapping whose action was changed after accept is not routed", (t) => {
  const s = studio(t);
  const scene = addScene(s.doc, "Verse");
  const pedal = message("pc", 1, 2);

  s.run(
    "midi.map",
    {
      id: "m1",
      device_name: "FCB1010",
      message: pedal,
      action: { kind: "scene.launch", scene_id: scene },
    },
    HUMAN,
  );
  assert.ok(routed(s.doc, { device_name: "FCB1010", ...pedal }), "a live mapping routes");

  // A write that moves the action on without the operator's accept: the router
  // compares the action with what was accepted, so it stops answering.
  s.doc.transact(() => {
    midiMap(s.doc).get("m1").set("action", { kind: "stop_all" });
  });
  assert.equal(routed(s.doc, { device_name: "FCB1010", ...pedal }), null);
  const mapping = snapshot(s.doc).midi_maps.m1;
  assert.deepEqual(mapping.accepted_action, { kind: "scene.launch", scene_id: scene });
  assert.deepEqual(mapping.action, { kind: "stop_all" });
  assert.equal(mapping.proposed, false, "it is still not a proposal; it simply is not routed");
});

test("an operator's mapping is live at once and an edit is one step", (t) => {
  const s = studio(t);
  const scene = addScene(s.doc, "Verse");
  const bass = addTrack(s.doc, "Bass");
  // A control change, because the edit below rides a level: a value control
  // needs a CC (panel/midi-route.js says so, and midi.map refuses the rest).
  const pedal = message("cc", 1, 27);

  const created = s.run(
    "midi.map",
    {
      id: "pedal-1",
      device_name: "FCB1010",
      message: pedal,
      action: { kind: "scene.launch", scene_id: scene },
    },
    HUMAN,
  );
  assert.match(created.result.summary, /^Mapped control change 27 on "FCB1010" to launch scene "Verse"/);

  const live = snapshot(s.doc).midi_maps["pedal-1"];
  assert.equal(live.proposed, false, "the operator's mapping is live at once");
  assert.equal(live.set_by, "operator");
  assert.deepEqual(live.accepted_action, { kind: "scene.launch", scene_id: scene });
  assert.equal(routed(s.doc, { device_name: "FCB1010", ...pedal }).id, "pedal-1");

  // The whole edit is one step: one update, one history entry.
  let updates = 0;
  const onUpdate = () => {
    updates += 1;
  };
  s.doc.on("update", onUpdate);
  const edited = s.run(
    "midi.map",
    {
      id: "pedal-1",
      device_name: "FCB1010",
      message: pedal,
      action: { kind: "mix.gain", track_id: bass },
    },
    HUMAN,
  );
  s.doc.off("update", onUpdate);
  assert.equal(updates, 1, "an edit is one update");
  assert.equal(edited.entry.seq, created.entry.seq + 1);
  assert.match(edited.result.summary, /^Changed the mapping/);
  assert.deepEqual(Object.keys(edited.result.before).sort(), [
    "midi:pedal-1|accepted_action",
    "midi:pedal-1|action",
  ]);
  assert.deepEqual(routed(s.doc, { device_name: "FCB1010", ...pedal }), {
    id: "pedal-1",
    action: { kind: "mix.gain", track_id: bass },
  });

  // One undo takes the edit back whole: both the action and what was accepted
  // come back together, because they were one step.
  const undone = s.undo(edited.entry);
  assert.deepEqual(undone.plan.conflicts, []);
  const restored = snapshot(s.doc).midi_maps["pedal-1"];
  assert.deepEqual(restored.action, { kind: "scene.launch", scene_id: scene });
  assert.deepEqual(restored.accepted_action, restored.action);
  assert.equal(routed(s.doc, { device_name: "FCB1010", ...pedal }).id, "pedal-1");

  // A second live mapping for the same message is refused, naming the first.
  const clash = refuses(
    () =>
      s.run(
        "midi.map",
        {
          id: "pedal-1-bis",
          device_name: "FCB1010",
          message: pedal,
          action: { kind: "stop_all" },
        },
        HUMAN,
      ),
    "conflict",
  );
  assert.match(clash.message, /one message has one live action/);
  assert.match(clash.message, /pedal-1/);
});

test("the router prefers a pad mapping over the keys mapping", (t) => {
  const s = studio(t);
  const { trackId: kit, bankId } = addKit(s.doc);

  s.run(
    "midi.map",
    {
      id: "pad-1",
      device_name: "MPK Mini",
      message: message("note", 1, 36),
      action: { kind: "pad.play", track_id: kit, bank_id: bankId, index: 0 },
    },
    HUMAN,
  );
  // `keys.play` claims the channel, but only the notes no pad mapping takes.
  s.run(
    "midi.map",
    {
      id: "keys",
      device_name: "MPK Mini",
      message: message("note", 1, 0),
      action: { kind: "keys.play" },
    },
    HUMAN,
  );

  // A note a pad mapping does not name falls through to the channel's keys row.
  assert.deepEqual(routed(s.doc, { device_name: "MPK Mini", ...message("note", 1, 60) }), {
    id: "keys",
    action: { kind: "keys.play" },
  });
  assert.deepEqual(routed(s.doc, { device_name: "MPK Mini", ...message("note", 1, 36) }), {
    id: "pad-1",
    action: { kind: "pad.play", track_id: kit, bank_id: bankId, index: 0 },
  });
  assert.equal(getCommand("midi.accept").humanOnly, true, "only the operator accepts a proposal");
});
test("an accept is bound to the proposal the operator was shown", (t) => {
  const s = studio(t);
  const verse = addScene(s.doc, "Verse");
  const pedal = message("pc", 1, 0);
  const shown = { kind: "scene.launch", scene_id: verse };
  s.run("midi.map", { id: "p1", device_name: "FCB1010", message: pedal, action: shown }, AGENT);
  // The agent takes its proposal back and proposes something else under the
  // same id before the operator's yes arrives.
  s.run("midi.remove", { id: "p1" }, AGENT);
  s.run("midi.map", { id: "p1", device_name: "FCB1010", message: pedal, action: { kind: "record.toggle" } }, AGENT);

  const refused = refuses(
    () => s.run("midi.accept", { id: "p1", expect: { device_name: "FCB1010", message: pedal, action: shown } }, HUMAN),
    "conflict",
  );
  assert.match(refused.message, /not the proposal you were shown/);
  assert.equal(snapshot(s.doc).midi_maps.p1.proposed, true, "nothing went live");
  assert.equal(routed(s.doc, { device_name: "FCB1010", ...pedal }), null);
});

test("an inherited name is not an action kind", (t) => {
  const s = studio(t);
  for (const kind of ["constructor", "__proto__", "hasOwnProperty", "toString"]) {
    refuses(
      () => s.run("midi.map", { device_name: "FCB1010", message: message("pc", 1, 0), action: { kind } }, HUMAN),
      "invalid",
    );
  }
});

test("the router routes only allow-listed actions, whatever the document holds", (t) => {
  const s = studio(t);
  // A hand-made document with a live mapping no command could have written.
  const maps = midiMap(s.doc);
  s.doc.transact(() => {
    const row = new (maps.constructor)();
    maps.set("bad", row);
    row.set("id", "bad");
    row.set("device_name", "FCB1010");
    row.set("message", { type: "pc", channel: 1, number: 0 });
    row.set("action", { kind: "track.remove", track_id: "x" });
    row.set("accepted_action", { kind: "track.remove", track_id: "x" });
    row.set("set_by", "operator");
    row.set("proposed", false);
  });
  assert.equal(routed(s.doc, { device_name: "FCB1010", type: "pc", channel: 1, number: 0 }), null);
});

test("a program change cannot hold an effect", (t) => {
  const s = studio(t);
  const { trackId } = addKit(s.doc);
  const held = { kind: "fx.hold", name: "stutter" };

  // A held effect is pressed and let go: a program change never comes up, so it
  // has no release to give. The refusal names what the action needs.
  const refused = refuses(
    () =>
      s.run(
        "midi.map",
        { id: "fx-pc", device_name: "FCB1010", message: message("pc", 1, 4), action: held },
        HUMAN,
      ),
    "invalid",
  );
  assert.equal(
    refused.message,
    "Invalid arguments for midi.map: A held effect needs a pedal or pad that sends a note or a CC; a program change has no release.",
  );
  assert.deepEqual(snapshot(s.doc).midi_maps, {}, "nothing was written");
  assert.equal(s.entries.length, 0, "and a refused mapping is not a history step");

  // A CC holds it (the FCB1010's expression pedal) and so does a pad's note.
  s.run(
    "midi.map",
    { id: "fx-cc", device_name: "FCB1010", message: message("cc", 1, 27), action: held },
    HUMAN,
  );
  s.run(
    "midi.map",
    { id: "fx-note", device_name: "Pad kit", message: message("note", 10, 36), action: held },
    HUMAN,
  );
  assert.equal(snapshot(s.doc).midi_maps["fx-cc"].proposed, false, "the CC mapping is live");
  assert.equal(snapshot(s.doc).midi_maps["fx-note"].proposed, false, "and so is the note one");

  // A value control is the other way round: only a CC carries a value.
  const sweep = { kind: "pad.param", track_id: trackId, param: "cutoff_hz", min: 20, max: 2000 };
  const refusedNote = refuses(
    () =>
      s.run(
        "midi.map",
        { id: "sweep-note", device_name: "Pad kit", message: message("note", 10, 40), action: sweep },
        HUMAN,
      ),
    "invalid",
  );
  assert.match(refusedNote.message, /control change/);
  s.run(
    "midi.map",
    { id: "sweep-cc", device_name: "Pad kit", message: message("cc", 1, 74), action: sweep },
    HUMAN,
  );

  // A scene launch is neither: any of the three sets it off, so the pedal's own
  // program change still maps.
  const scene = addScene(s.doc, "Verse");
  s.run(
    "midi.map",
    {
      id: "scene-pc",
      device_name: "FCB1010",
      message: message("pc", 1, 3),
      action: { kind: "scene.launch", scene_id: scene },
    },
    HUMAN,
  );
});

test("one live keys mapping per channel, and only on notes", (t) => {
  const s = studio(t);
  s.run("midi.map", { id: "k1", device_name: "MPK mini", message: message("note", 1, 0), action: { kind: "keys.play" } }, HUMAN);
  refuses(
    () => s.run("midi.map", { id: "k2", device_name: "MPK mini", message: message("note", 1, 5), action: { kind: "keys.play" } }, HUMAN),
    "conflict",
  );
  refuses(
    () => s.run("midi.map", { id: "k3", device_name: "MPK mini", message: message("cc", 2, 5), action: { kind: "keys.play" } }, HUMAN),
    "invalid",
  );
  // Another channel is another set of keys.
  s.run("midi.map", { id: "k4", device_name: "MPK mini", message: message("note", 2, 0), action: { kind: "keys.play" } }, HUMAN);
});

test("an old proposal whose message cannot work is not accepted", (t) => {
  const s = studio(t);
  // A proposal from before the message rules: a program change on a held
  // effect, which has no release. Written straight into the document.
  const maps = midiMap(s.doc);
  s.doc.transact(() => {
    const row = new (maps.constructor)();
    maps.set("old", row);
    row.set("id", "old");
    row.set("device_name", "FCB1010");
    row.set("message", { type: "pc", channel: 1, number: 4 });
    row.set("action", { kind: "fx.hold", name: "stutter" });
    row.set("accepted_action", null);
    row.set("set_by", "agent");
    row.set("proposed", true);
  });
  const refused = refuses(
    () =>
      s.run(
        "midi.accept",
        { id: "old", expect: { device_name: "FCB1010", message: message("pc", 1, 4), action: { kind: "fx.hold", name: "stutter" } } },
        HUMAN,
      ),
    "invalid",
  );
  assert.match(refused.message, /program change has no release/);
  assert.equal(snapshot(s.doc).midi_maps.old.proposed, true);
});

// ---- the pad performance bar: HOLD, ROLL and Pause --------------------------

/**
 * The router's own text with one kind's name swapped, evaluated the way the page
 * runs it: the allow-list as it stood before that kind existed.
 * @param {string} script - the routing script the page inlines
 * @param {string} from
 * @param {string} to
 * @returns {object} that older routing rule
 */
function olderRouteApi(script, from, to) {
  const older = script.split(from).join(to);
  assert.notEqual(older, script, "the copy of the script really changed");
  return new Function("window", `${older}\nreturn window.StudioMidiRoute;`)({});
}

test("HOLD, ROLL and Pause are live actions a control can drive", (t) => {
  const s = studio(t);
  const hold = { kind: "pad.hold" };
  const roll = { kind: "pad.roll" };
  const pause = { kind: "pad.pause_all" };

  // HOLD and ROLL are pressed and let go, so they take a note or a CC, as a held
  // effect does. Pause is a toggle, so a program change is enough for it.
  s.run("midi.map", { id: "hold-note", device_name: "Pad kit", message: message("note", 10, 36), action: hold }, HUMAN);
  s.run("midi.map", { id: "roll-cc", device_name: "Pad kit", message: message("cc", 10, 20), action: roll }, HUMAN);
  s.run("midi.map", { id: "pause-pc", device_name: "FCB1010", message: message("pc", 1, 3), action: pause }, HUMAN);

  const maps = snapshot(s.doc).midi_maps;
  for (const [id, action] of [["hold-note", hold], ["roll-cc", roll], ["pause-pc", pause]]) {
    assert.deepEqual(maps[id].action, action, `${id} is stored as its kind and nothing else`);
    assert.equal(maps[id].proposed, false, `${id} is the operator's, so live`);
    assert.deepEqual(maps[id].accepted_action, action, `${id} is live for what it holds`);
  }
  assert.deepEqual(routed(s.doc, { device_name: "Pad kit", ...message("note", 10, 36) }), {
    id: "hold-note",
    action: hold,
  });
  assert.deepEqual(routed(s.doc, { device_name: "FCB1010", ...message("pc", 1, 3) }), {
    id: "pause-pc",
    action: pause,
  });

  // A program change has no release, so it cannot hold HOLD or ROLL down. The
  // refusal is the router's own sentence, and nothing is written.
  const before = s.entries.length;
  const needs = {
    "pad.hold": "HOLD is a press and a release, so it needs a note or a CC; a program change has no release.",
    "pad.roll": "ROLL is held down, so it needs a note or a CC; a program change has no release.",
  };
  for (const [kind, action, slot] of [["pad.hold", hold, "hold"], ["pad.roll", roll, "roll"]]) {
    const refused = refuses(
      () => s.run("midi.map", { id: `pc-${slot}`, device_name: "FCB1010", message: message("pc", 1, 4), action }, HUMAN),
      "invalid",
    );
    assert.equal(refused.message, `Invalid arguments for midi.map: ${needs[kind]}`);
    assert.equal(snapshot(s.doc).midi_maps[`pc-${slot}`], undefined, `${kind} on a program change wrote nothing`);
  }

  // None of the three takes an argument: the kind IS the whole action.
  for (const [kind, action, slot] of [
    ["pad.hold", { kind: "pad.hold", index: 0 }, "hold"],
    ["pad.roll", { kind: "pad.roll", name: "stutter" }, "roll"],
    ["pad.pause_all", { kind: "pad.pause_all", paused: true }, "pause"],
  ]) {
    const { kind: _kind, ...args } = action;
    assert.equal(MIDI_ACTIONS[kind].safeParse(args).success, false, `${kind} takes no argument`);
    const refused = refuses(
      () => s.run("midi.map", { id: `extra-${slot}`, device_name: "Pad kit", message: message("note", 10, 40), action }, HUMAN),
      "invalid",
    );
    assert.match(refused.message, /wrong arguments/);
  }
  assert.equal(s.entries.length, before, "and a refused mapping is not a history step");
});

test("the router gates HOLD, ROLL and Pause on their own kind and keys", async () => {
  const { MIDI_ROUTE_SCRIPT, acceptsMessageType, messageNeedsText, validRoutedAction } = await import(
    "../bundles/studio/panel/midi-route.js"
  );
  const page = new Function("window", `${MIDI_ROUTE_SCRIPT}\nreturn window.StudioMidiRoute;`)({});

  const note = message("note", 1, 3);
  const cc = message("cc", 1, 3);
  const pc = message("pc", 1, 3);

  /** One live mapping on "D": this action, on this stored message. */
  const live = (action, stored) => ({
    id: "m",
    device_name: "D",
    message: stored,
    action,
    accepted_action: JSON.parse(JSON.stringify(action)),
    set_by: "operator",
    proposed: false,
  });

  /** What the server and the page answer, side by side. */
  const ask = (action, stored) => {
    const snap = { midi_maps: { m: live(action, stored) } };
    const incoming = { device_name: "D", ...stored };
    return [routeFor(snap, incoming), page.routeFor(snap, incoming)];
  };

  // The three kinds, each on every message type, the two sides answering alike.
  const cases = [
    [{ kind: "pad.hold" }, note, true],
    [{ kind: "pad.hold" }, cc, true],
    [{ kind: "pad.hold" }, pc, false],
    [{ kind: "pad.roll" }, note, true],
    [{ kind: "pad.roll" }, cc, true],
    [{ kind: "pad.roll" }, pc, false],
    [{ kind: "pad.pause_all" }, note, true],
    [{ kind: "pad.pause_all" }, cc, true],
    [{ kind: "pad.pause_all" }, pc, true],
  ];
  for (const [action, stored, routes] of cases) {
    const [server, client] = ask(action, stored);
    assert.deepEqual(client, server, `${action.kind} on a ${stored.type}: the page answers what the server answers`);
    assert.equal(server === null, !routes, `${action.kind} on a ${stored.type}: ${routes ? "routes" : "routes nothing"}`);
  }

  // The Learn wording is one sentence per kind, and the same one the refusal uses.
  assert.equal(
    messageNeedsText("pad.hold"),
    "HOLD is a press and a release, so it needs a note or a CC; a program change has no release.",
  );
  assert.equal(
    messageNeedsText("pad.roll"),
    "ROLL is held down, so it needs a note or a CC; a program change has no release.",
  );
  assert.equal(messageNeedsText("pad.pause_all"), "Pausing everything takes a note, a CC or a program change.");
  assert.equal(acceptsMessageType("pad.pause_all", "pc"), true);
  assert.equal(acceptsMessageType("pad.hold", "pc"), false);
  assert.equal(acceptsMessageType("pad.roll", "pc"), false);

  // Exactly the kind and no other key: a field the document added on its own is
  // not part of an action, so a mapping holding one runs nothing.
  for (const action of [
    { kind: "pad.hold", index: 0 },
    { kind: "pad.roll", name: "stutter" },
    { kind: "pad.pause_all", paused: true },
  ]) {
    assert.equal(validRoutedAction(action), false, `${action.kind} with an extra key is not a live action`);
    assert.deepEqual(ask(action, cc), [null, null], "and such a mapping routes nothing on either side");
  }

  // A kind nobody allow-listed runs nothing, inherited names included.
  for (const kind of ["pad.hold_all", "pad.pause", "toString", "__proto__", "hasOwnProperty", "constructor"]) {
    assert.equal(validRoutedAction({ kind }), false, `${kind} is not a live action kind`);
    assert.deepEqual(ask({ kind }, note), [null, null], `a mapping of ${kind} routes nothing`);
  }
  const inherited = Object.create({ kind: "pad.hold" });
  assert.equal(validRoutedAction(inherited), false, "the kind has to be the action's own key");
  assert.deepEqual(ask(inherited, note), [null, null], "and a mapping whose kind is inherited routes nothing");

  // The rules around a mapping are the same for the new kinds: a proposal is
  // never routed, and neither is an action whose accepted copy moved on.
  const proposal = { midi_maps: { m: { ...live({ kind: "pad.pause_all" }, pc), proposed: true } } };
  assert.equal(routeFor(proposal, { device_name: "D", ...pc }), null, "a proposed pause-all routes nothing");
  const moved = {
    midi_maps: { m: { ...live({ kind: "pad.pause_all" }, pc), accepted_action: { kind: "stop_all" } } },
  };
  assert.equal(routeFor(moved, { device_name: "D", ...pc }), null, "a pause-all changed after accept routes nothing");
});

test("an older allow-list ignores a mapping of a kind it never heard of", async (t) => {
  const s = studio(t);
  const incoming = { device_name: "Pad kit", ...message("note", 10, 36) };
  s.run(
    "midi.map",
    { id: "hold", device_name: "Pad kit", message: message("note", 10, 36), action: { kind: "pad.hold" } },
    HUMAN,
  );

  // The song holds the mapping whole, and this build's rule routes it.
  assert.deepEqual(snapshot(s.doc).midi_maps.hold.action, { kind: "pad.hold" });
  assert.deepEqual(routed(s.doc, incoming), { id: "hold", action: { kind: "pad.hold" } });

  // The same script from before the kind was allow-listed: it has no rule for
  // the kind and no branch that accepts it, so the mapping is simply not live.
  const { MIDI_ROUTE_SCRIPT } = await import("../bundles/studio/panel/midi-route.js");
  const older = olderRouteApi(MIDI_ROUTE_SCRIPT, "'pad.hold'", "'pad.hold_legacy'");
  assert.equal(older.acceptsMessageType("pad.hold", "note"), false, "the older rule knows no pad.hold");
  assert.equal(older.validRoutedAction({ kind: "pad.hold" }), false, "nor a branch that accepts it");
  assert.equal(older.routeFor(snapshot(s.doc), incoming), null, "so the mapping answers nothing");

  // Nothing throws and nothing is lost: the song still loads with the mapping in
  // it, and the build that does know the kind routes it again.
  const loaded = snapshot(s.doc);
  assert.deepEqual(Object.keys(loaded.midi_maps), ["hold"], "the song's mapping is still there");
  assert.equal(loaded.midi_maps.hold.proposed, false, "and it is still the operator's");
  assert.deepEqual(routed(s.doc, incoming), { id: "hold", action: { kind: "pad.hold" } });
});
