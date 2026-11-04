/**
 * Studio sequencer: the pure event generator both hosts (the worklet in a
 * browser and Node's offline render) read the song through.
 *
 * The sequencer is a classic script, so it is loaded here with `require()` —
 * `bundles/studio/engine/package.json` marks the engine directory CommonJS for
 * exactly that reason. Nothing here touches a database, a network or a clock:
 * the tests hand it plain snapshots in the shape `bundles/studio/server/doc.js`
 * writes, and read the events back.
 *
 * At 120 bpm and 48 kHz one beat is 24,000 frames and one bar is 96,000.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const StudioSequencer = require("../bundles/studio/engine/sequencer.js");

const SAMPLE_RATE = 48000;
const BPM = 120;
const FRAMES_PER_BEAT = (SAMPLE_RATE * 60) / BPM; // 24,000
const FRAMES_PER_BAR = FRAMES_PER_BEAT * 4; // 96,000
const FRAMES_PER_SIXTEENTH = FRAMES_PER_BEAT / 4; // 6,000

/** @returns {{t: number, d: number, p: number, v: number}} a note in beats. */
function note(t, d, p, v = 100) {
  return { t, d, p, v };
}

/** A track in the snapshot's shape, with the fields the sequencer reads. */
function track(id, over = {}) {
  return {
    id,
    name: id,
    color: "#E8C07A",
    device: { engine: "sunvox", type: "Analog generator", params: {} },
    mute: false,
    solo: false,
    gain_db: 0,
    pan: 0,
    locked: false,
    ...over,
  };
}

/** A scene in the snapshot's shape. */
function scene(id, name = id) {
  return { id, name };
}

/** A clip in the snapshot's shape. */
function clip(id, trackId, sceneId, lengthBars, notes) {
  return { id, track_id: trackId, scene_id: sceneId, name: id, length_bars: lengthBars, notes };
}

/** A whole song snapshot, keyed by clip id the way `doc.js` writes it. */
function song({
  bpm = BPM,
  tracks = [],
  scenes = [],
  clips = [],
  takes = [],
  patterns = [],
  steps = [],
  arrangement = null,
} = {}) {
  const snapshot = {
    meta: { title: "Test song", bpm, meter: [4, 4], key: "C major" },
    tracks,
    scenes,
    clips: Object.fromEntries(clips.map((item) => [item.id, item])),
  };
  if (takes.length > 0) snapshot.takes = Object.fromEntries(takes.map((item) => [item.id, item]));
  if (patterns.length > 0) {
    snapshot.patterns = Object.fromEntries(patterns.map((item) => [item.clip_id + "/" + item.id, item]));
  }
  if (steps.length > 0) {
    snapshot.steps = Object.fromEntries(
      steps.map((item) => [
        `${item.clip_id}/${item.pattern_id}/${item.at}/${item.bank_id}.${item.index}`,
        item,
      ]),
    );
  }
  if (arrangement) snapshot.arrangement = arrangement;
  return snapshot;
}

/** A track whose clips are patterns: no SunVox, no notes, just pads. */
function samplerTrack(id = "t1") {
  return track(id, { device: { engine: "sampler" } });
}

/**
 * A pattern clip: one step grid, one swing and one chain of pattern ids, with
 * the very fields `doc.js`'s `normalizeClip` writes.
 */
function patternClip(id, trackId, sceneId, over = {}) {
  const lengthSteps = over.length_steps === undefined ? 16 : over.length_steps;
  const stepBeats = over.step_beats === undefined ? 0.25 : over.step_beats;
  return {
    id,
    track_id: trackId,
    scene_id: sceneId,
    name: id,
    length_bars: Math.max(1, Math.ceil((lengthSteps * stepBeats) / 4)),
    notes: [],
    kind: "pattern",
    length_steps: lengthSteps,
    step_beats: stepBeats,
    swing: 0,
    chain: [],
    ...over,
  };
}

/** One pattern of one clip, as the song's `patterns` container holds it. */
function pattern(clipId, id, order = 0) {
  return { id, clip_id: clipId, name: id, order };
}

/** One step: one pad at one position of one pattern. */
function step(clipId, patternId, at, index, bankId = "b1") {
  return { clip_id: clipId, pattern_id: patternId, at, bank_id: bankId, index, v: 100, locks: {} };
}

/** Pad triggers as [frame, pad index] rows, easy to read. */
function padRows(events) {
  return events.map((event) => [event.frame, event.index]);
}

/** An audio clip: a comp over the clip's own beats, and no notes at all. */
function audioClip(id, trackId, sceneId, lengthBars, comp) {
  return { id, track_id: trackId, scene_id: sceneId, name: id, length_bars: lengthBars, kind: "audio", notes: [], comp };
}

/** A recorded take, as an audio clip's comp names it. */
function take(id, clipId, over = {}) {
  return { id, clip_id: clipId, rate: SAMPLE_RATE, offset_frames: 0, discarded: false, ...over };
}

/** A track that plays takes instead of notes. */
function audioTrack(id = "t1") {
  return track(id, { device: { engine: "audio" } });
}

/** A placement in the snapshot's shape, with 0 fades unless a test sets them. */
function placement(id, trackId, clipId, startBar, bars, over = {}) {
  return {
    id,
    track_id: trackId,
    clip_id: clipId,
    start_bar: startBar,
    bars,
    offset_beats: 0,
    fade_in_beats: 0,
    fade_out_beats: 0,
    ...over,
  };
}

/** A whole arrangement, keyed by placement id the way `doc.js` writes it. */
function arrangementOf(items) {
  return {
    placements: Object.fromEntries(items.map((item) => [item.id, item])),
    markers: {},
    sections: {},
  };
}

/** A sequencer holding one song, stopped and ready to launch. */
function sequencer(snapshot) {
  const seq = StudioSequencer.create({ sampleRate: SAMPLE_RATE });
  seq.setSong(snapshot);
  return seq;
}

/** The events in a form a test can read at a glance. */
function brief(events) {
  return events.map((event) => ({ frame: event.frame, track_id: event.track_id, type: event.type, p: event.p }));
}

/**
 * The launches one block applied, copied: the sequencer reuses the array, so a
 * later block would otherwise overwrite what a test is holding.
 * @param {object[]} events
 * @returns {object[]}
 */
function launchesOf(events) {
  return (events.launches || []).map((launch) => ({ ...launch }));
}

/** Run blocks of `size` frames from `from`, with events moved to absolute frames. */
function collectFrom(seq, from, total, size) {
  const out = [];
  for (let at = from; at < from + total; at += size) {
    const frames = Math.min(size, from + total - at);
    for (const event of seq.block(at, frames)) out.push({ ...event, frame: at + event.frame });
  }
  return out;
}

/** Run blocks of `size` frames from 0, with events moved to absolute frames. */
function collect(seq, total, size) {
  return collectFrom(seq, 0, total, size);
}

/** A deterministic PRNG (mulberry32), so the property test is reproducible. */
function randomSource(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** A handful of notes on a quarter-beat grid, some of them overlapping. */
function randomNotes(next) {
  const count = 2 + Math.floor(next() * 8);
  const notes = [];
  for (let at = 0; at < count; at += 1) {
    const t = Math.round(next() * 16) / 4;
    const d = 0.25 + Math.round(next() * 8) / 4;
    notes.push(note(t, d, 36 + Math.floor(next() * 36), 60 + Math.floor(next() * 60)));
  }
  return notes;
}

/** Four tracks on two scenes, the shape the random edits below mutate. */
function randomState(next) {
  return {
    bpm: BPM,
    tracks: [0, 1, 2, 3].map((index) => ({ id: "t" + index, mute: false, solo: false })),
    clips: [0, 1, 2, 3].map((index) => ({
      id: "c" + index,
      track_id: "t" + index,
      scene_id: index % 2 === 0 ? "s1" : "s2",
      length_bars: 1 + (index % 2),
      notes: randomNotes(next),
    })),
  };
}

/** Play a snapshot with a repeating pattern of block sizes, at absolute frames. */
function playInBlocks(snapshot, total, sizes) {
  const seq = sequencer(snapshot);
  seq.launchClip("c1");
  seq.play();
  const out = [];
  let at = 0;
  let index = 0;
  while (at < total) {
    const frames = Math.min(sizes[index % sizes.length], total - at);
    index += 1;
    for (const event of seq.block(at, frames)) out.push({ ...event, frame: at + event.frame });
    at += frames;
  }
  return out;
}

/** Turn a mutable random state back into the snapshot shape. */
function snapshotOf(state) {
  return song({
    bpm: state.bpm,
    tracks: state.tracks.map((item) => track(item.id, { mute: item.mute, solo: item.solo })),
    scenes: [scene("s1"), scene("s2")],
    clips: state.clips.map((item) => clip(item.id, item.track_id, item.scene_id, item.length_bars, item.notes)),
  });
}

test("scene launch while playing starts at next bar boundary", () => {
  const seq = sequencer(
    song({
      tracks: [track("t1")],
      scenes: [scene("s1")],
      clips: [clip("c1", "t1", "s1", 1, [note(0, 1, 60)])],
    }),
  );

  seq.play();
  assert.deepEqual(brief(seq.block(0, 10000)), [], "nothing is launched yet");

  // Launched at frame 10,000, i.e. inside the first bar: the clip waits for bar 2.
  seq.launchScene("s1");
  assert.deepEqual(brief(seq.block(10000, FRAMES_PER_BAR - 10000)), [], "nothing sounds before the bar boundary");

  const boundaryBlock = seq.block(FRAMES_PER_BAR, 1000);
  assert.deepEqual(brief(boundaryBlock), [{ frame: 0, track_id: "t1", type: "on", p: 60 }]);
});

test("clip loops", () => {
  const seq = sequencer(
    song({
      tracks: [track("t1")],
      scenes: [scene("s1")],
      clips: [clip("c1", "t1", "s1", 1, [note(0, 1, 60)])],
    }),
  );

  // Launched while the transport is stopped, so it starts at the transport's
  // first bar rather than at a quantized boundary.
  seq.launchScene("s1");
  seq.play();

  const events = seq.block(0, FRAMES_PER_BAR * 3);
  const ons = events.filter((event) => event.type === "on").map((event) => event.frame);
  assert.deepEqual(ons, [0, FRAMES_PER_BAR, FRAMES_PER_BAR * 2]);

  const offs = events.filter((event) => event.type === "off").map((event) => event.frame);
  assert.deepEqual(offs, [FRAMES_PER_BEAT, FRAMES_PER_BAR + FRAMES_PER_BEAT, FRAMES_PER_BAR * 2 + FRAMES_PER_BEAT]);
});

test("stopAll emits note-off for sounding notes in the same block", () => {
  const seq = sequencer(
    song({
      tracks: [track("t1")],
      scenes: [scene("s1")],
      clips: [clip("c1", "t1", "s1", 8, [note(0, 20, 60)])],
    }),
  );

  seq.launchScene("s1");
  seq.play();
  assert.deepEqual(brief(seq.block(0, FRAMES_PER_BEAT)), [{ frame: 0, track_id: "t1", type: "on", p: 60 }]);

  // stopAll is a clip stop, so it is quantized to the next bar: the note is
  // still sounding through the rest of bar 1 and every off for it arrives
  // together in the one block that begins at bar 2.
  seq.stopAll();
  assert.deepEqual(brief(seq.block(FRAMES_PER_BEAT, FRAMES_PER_BAR - FRAMES_PER_BEAT)), []);
  assert.deepEqual(brief(seq.block(FRAMES_PER_BAR, 128)), [{ frame: 0, track_id: "t1", type: "off", p: 60 }]);
});

test("block boundaries never drop or duplicate events", () => {
  const snapshot = song({
    tracks: [track("t1"), track("t2")],
    scenes: [scene("s1")],
    clips: [
      clip("c1", "t1", "s1", 1, [note(0, 0.5, 60), note(1.5, 2, 67), note(3, 0.5, 72)]),
      clip("c2", "t2", "s1", 2, [note(0, 3.75, 36), note(2.25, 1, 43)]),
    ],
  });

  const total = FRAMES_PER_BAR * 3;

  const oneBlock = sequencer(snapshot);
  oneBlock.launchScene("s1");
  oneBlock.play();
  const single = collect(oneBlock, total, total);

  const manyBlocks = sequencer(snapshot);
  manyBlocks.launchScene("s1");
  manyBlocks.play();
  const small = collect(manyBlocks, total, 128);

  assert.ok(single.length > 0, "the song must produce events");
  assert.deepEqual(small, single);
});

test("muted track emits nothing", () => {
  const seq = sequencer(
    song({
      tracks: [track("t1", { mute: true }), track("t2")],
      scenes: [scene("s1")],
      clips: [
        clip("c1", "t1", "s1", 1, [note(0, 1, 60)]),
        clip("c2", "t2", "s1", 1, [note(0, 1, 64)]),
      ],
    }),
  );

  seq.launchScene("s1");
  seq.play();

  const events = seq.block(0, FRAMES_PER_BAR);
  assert.deepEqual(brief(events), [
    { frame: 0, track_id: "t2", type: "on", p: 64 },
    { frame: FRAMES_PER_BEAT, track_id: "t2", type: "off", p: 64 },
  ]);
});

test("solo silences the others", () => {
  const seq = sequencer(
    song({
      tracks: [track("t1"), track("t2", { solo: true })],
      scenes: [scene("s1")],
      clips: [
        clip("c1", "t1", "s1", 1, [note(0, 1, 60)]),
        clip("c2", "t2", "s1", 1, [note(0, 1, 64)]),
      ],
    }),
  );

  seq.launchScene("s1");
  seq.play();

  const events = seq.block(0, FRAMES_PER_BAR);
  assert.deepEqual(brief(events), [
    { frame: 0, track_id: "t2", type: "on", p: 64 },
    { frame: FRAMES_PER_BEAT, track_id: "t2", type: "off", p: 64 },
  ]);
});

test("launchClip replaces the track's clip at the next bar with offs for its sounding notes", () => {
  const seq = sequencer(
    song({
      tracks: [track("t1")],
      scenes: [scene("s1"), scene("s2")],
      clips: [
        // One long note, still sounding when the other clip takes the track.
        clip("c1", "t1", "s1", 8, [note(0, 20, 60)]),
        clip("c2", "t1", "s2", 1, [note(0, 1, 67)]),
      ],
    }),
  );

  seq.launchClip("c1");
  seq.play();
  assert.deepEqual(brief(seq.block(0, FRAMES_PER_BEAT)), [{ frame: 0, track_id: "t1", type: "on", p: 60 }]);

  // Halfway through bar 1: the switch waits for bar 2, and the first clip's
  // note is cut there.
  seq.launchClip("c2");
  assert.deepEqual(brief(seq.block(FRAMES_PER_BEAT, FRAMES_PER_BEAT)), [], "still the first clip's note");

  assert.deepEqual(brief(seq.block(FRAMES_PER_BAR, 128)), [
    { frame: 0, track_id: "t1", type: "off", p: 60 },
    { frame: 0, track_id: "t1", type: "on", p: 67 },
  ]);
});

test("position reports the bar, beat and sixteenth of the last processed frame", () => {
  const seq = sequencer(song({ tracks: [track("t1")], scenes: [scene("s1")] }));

  seq.play();
  assert.deepEqual(seq.position(), { bar: 1, beat: 1, sixteenth: 1 });

  seq.block(0, FRAMES_PER_BEAT + 6000);
  assert.deepEqual(seq.position(), { bar: 1, beat: 2, sixteenth: 1 });

  seq.block(FRAMES_PER_BEAT + 6000, FRAMES_PER_BAR - (FRAMES_PER_BEAT + 6000));
  assert.deepEqual(seq.position(), { bar: 1, beat: 4, sixteenth: 4 });

  seq.block(FRAMES_PER_BAR, FRAMES_PER_BEAT);
  assert.deepEqual(seq.position(), { bar: 2, beat: 1, sixteenth: 4 });

  seq.stop();
  assert.deepEqual(seq.position(), { bar: 1, beat: 1, sixteenth: 1 });
});

test("muting a track closes its sounding notes", () => {
  const bass = clip("c1", "t1", "s1", 8, [note(0, 20, 60)]);
  const seq = sequencer(song({ tracks: [track("t1")], scenes: [scene("s1")], clips: [bass] }));

  seq.launchScene("s1");
  seq.play();
  assert.deepEqual(brief(seq.block(0, FRAMES_PER_BEAT)), [{ frame: 0, track_id: "t1", type: "on", p: 60 }]);

  // Muted while the note still sounds: it is released at once, not left stuck.
  seq.setSong(song({ tracks: [track("t1", { mute: true })], scenes: [scene("s1")], clips: [bass] }));
  assert.deepEqual(brief(seq.block(FRAMES_PER_BEAT, 128)), [{ frame: 0, track_id: "t1", type: "off", p: 60 }]);

  // And it stays off for as long as the track is muted.
  assert.deepEqual(brief(seq.block(FRAMES_PER_BEAT + 128, FRAMES_PER_BAR)), []);
});

test("deleting a sounding note closes it", () => {
  const seq = sequencer(
    song({
      tracks: [track("t1")],
      scenes: [scene("s1")],
      clips: [clip("c1", "t1", "s1", 8, [note(0, 3, 60)])],
    }),
  );

  seq.launchClip("c1");
  seq.play();
  assert.deepEqual(brief(seq.block(0, 128)), [{ frame: 0, track_id: "t1", type: "on", p: 60 }]);

  // The note is gone from the clip; the one still sounding is released.
  seq.setSong(
    song({
      tracks: [track("t1")],
      scenes: [scene("s1")],
      clips: [clip("c1", "t1", "s1", 8, [note(2, 1, 61)])],
    }),
  );
  assert.deepEqual(brief(seq.block(128, 128)), [{ frame: 0, track_id: "t1", type: "off", p: 60 }]);

  // The replacement note still lands where it says it does.
  const later = collectFrom(seq, 256, FRAMES_PER_BEAT * 2, 128);
  assert.deepEqual(
    later.filter((event) => event.type === "on").map((event) => [event.frame, event.p]),
    [[FRAMES_PER_BEAT * 2, 61]],
  );
});

test("shortening a clip closes notes past the new end", () => {
  const seq = sequencer(
    song({
      tracks: [track("t1")],
      scenes: [scene("s1")],
      clips: [clip("c1", "t1", "s1", 2, [note(1, 6, 60)])],
    }),
  );

  seq.launchClip("c1");
  seq.play();
  // Up to beat 4.5: the note started at beat 1 and runs to beat 7.
  const played = collectFrom(seq, 0, 108000, 128);
  assert.deepEqual(
    played.map((event) => [event.frame, event.type]),
    [[FRAMES_PER_BEAT, "on"]],
  );

  // The clip is now one bar long, so the note has no tail past beat 4.
  seq.setSong(
    song({
      tracks: [track("t1")],
      scenes: [scene("s1")],
      clips: [clip("c1", "t1", "s1", 1, [note(1, 6, 60)])],
    }),
  );
  assert.deepEqual(brief(seq.block(108000, 128)), [{ frame: 0, track_id: "t1", type: "off", p: 60 }]);

  // The shorter clip loops from beat 4, so the note comes back at beat 5.
  const after = collectFrom(seq, 108128, 12000, 128);
  assert.deepEqual(
    after.map((event) => [event.frame, event.type, event.p]),
    [[120000, "on", 60]],
  );
});

test("tempo change keeps the playhead and later notes in time", () => {
  const notes = [note(0, 1, 60), note(5, 1, 62)];
  const snapshot = (bpm) =>
    song({ bpm, tracks: [track("t1")], scenes: [scene("s1")], clips: [clip("c1", "t1", "s1", 2, notes)] });

  const seq = sequencer(snapshot(BPM));
  seq.launchClip("c1");
  seq.play();
  assert.deepEqual(brief(seq.block(0, 12800)), [{ frame: 0, track_id: "t1", type: "on", p: 60 }]);
  const before = seq.position();

  // 120 → 60 bpm at frame 12,800, i.e. a third of a beat in.
  seq.setSong(snapshot(60));
  assert.deepEqual(seq.position(), before, "the playhead keeps its place in the bar");

  // At 60 bpm a beat is 48,000 frames and beat 0 now sits at frame -12,800:
  // the sounding note's off lands at beat 1, the next note at beat 5.
  const after = collectFrom(seq, 12800, 240000 - 12800, 128);
  assert.deepEqual(
    after.filter((event) => event.type === "off").map((event) => event.frame),
    [35200],
  );
  assert.deepEqual(
    after.filter((event) => event.type === "on").map((event) => [event.frame, event.p]),
    [[227200, 62]],
  );
});

test("a late off after stop and a gap is not lost", () => {
  const seq = sequencer(
    song({
      tracks: [track("t1")],
      scenes: [scene("s1")],
      clips: [clip("c1", "t1", "s1", 8, [note(0, 20, 60)])],
    }),
  );

  seq.launchClip("c1");
  seq.play();
  assert.deepEqual(brief(seq.block(0, 128)), [{ frame: 0, track_id: "t1", type: "on", p: 60 }]);

  // The transport stops at frame 128, but the host's next block starts at
  // frame 1,000: the off is owed at frame 128 and paid at the start of it.
  seq.stop();
  assert.deepEqual(brief(seq.block(1000, 128)), [{ frame: 0, track_id: "t1", type: "off", p: 60 }]);
});

test("every on has exactly one off", () => {
  const next = randomSource(0x51d10a);
  const state = randomState(next);
  const seq = sequencer(snapshotOf(state));

  /** track:pitch → how many of its notes are sounding right now. */
  const balance = new Map();
  const history = [];
  let ons = 0;

  const record = (events, at) => {
    for (const event of events) {
      const key = event.track_id + ":" + event.p;
      const value = (balance.get(key) || 0) + (event.type === "on" ? 1 : -1);
      history.push([at + event.frame, key, event.type]);
      assert.ok(
        value >= 0,
        key + " was released before it was started; last events " + JSON.stringify(history.slice(-12)),
      );
      balance.set(key, value);
      if (event.type === "on") ons += 1;
    }
  };

  seq.launchScene("s1");
  seq.play();

  let frame = 0;
  for (let step = 0; step < 200; step += 1) {
    const size = 2000 + Math.floor(next() * 10000);
    record(seq.block(frame, size), frame);
    frame += size;

    if (next() < 0.12) {
      // One random edit: notes, clip length, mute, solo, or tempo.
      const kind = next();
      if (kind < 0.3) state.clips[Math.floor(next() * 4)].notes = randomNotes(next);
      else if (kind < 0.45) state.clips[Math.floor(next() * 4)].length_bars = 1 + Math.floor(next() * 2);
      else if (kind < 0.6) state.tracks[Math.floor(next() * 4)].mute = next() < 0.5;
      else if (kind < 0.7) state.tracks[Math.floor(next() * 4)].solo = next() < 0.5;
      else state.bpm = 60 + Math.floor(next() * 5) * 30;
      seq.setSong(snapshotOf(state));
    }

    // And a random transport gesture on top of it.
    const gesture = next();
    if (gesture < 0.08) seq.launchScene("s1");
    else if (gesture < 0.16) seq.launchScene("s2");
    else if (gesture < 0.22) seq.launchClip("c" + Math.floor(next() * 4));
    else if (gesture < 0.26) seq.stopTrack("t" + Math.floor(next() * 4));
  }

  assert.ok(ons > 100, "the random song must have made a lot of sound: " + ons + " ons, " + balance.size + " pitches");

  // Everything still sounding stops at the next bar; at the slowest tempo
  // used here a bar is 192,000 frames, so four bars settle every off.
  seq.stopAll();
  for (let step = 0; step < 100; step += 1) {
    record(seq.block(frame, 8000), frame);
    frame += 8000;
  }

  for (const [key, value] of balance) assert.equal(value, 0, key + " has an unmatched note");
});

test("block boundaries never drop or duplicate events at an odd tempo", () => {
  // At 137 bpm a beat is 21,021.9 frames, so every event frame is a rounded
  // position and a block's beat window is never a whole number of beats: the
  // note search and the frame rule must agree whatever the block size is.
  const snapshot = song({
    bpm: 137,
    tracks: [track("t1")],
    scenes: [scene("s1")],
    clips: [clip("c1", "t1", "s1", 1, [note(0.3, 0.77, 60), note(2.5, 9, 62)])],
  });
  const total = 300000;
  const reference = playInBlocks(snapshot, total, [128]);
  assert.ok(reference.length > 0, "the clip must produce events");

  for (const sizes of [[1], [77], [512], [4096], [4099, 1, 77], [512, 4096, 1]]) {
    assert.deepEqual(playInBlocks(snapshot, total, sizes), reference, "block sizes " + JSON.stringify(sizes));
  }
});

test("a launch asked for on a bar boundary takes that boundary", () => {
  const onGrid = song({
    tracks: [track("t1")],
    scenes: [scene("s1")],
    clips: [clip("c1", "t1", "s1", 1, [note(0, 1, 60)])],
  });
  const seq = sequencer(onGrid);
  seq.play();
  assert.deepEqual(brief(seq.block(0, FRAMES_PER_BAR)), []);
  seq.launchScene("s1");
  assert.deepEqual(brief(seq.block(FRAMES_PER_BAR, 128)), [{ frame: 0, track_id: "t1", type: "on", p: 60 }]);

  // And at a tempo where a bar is not a whole number of frames: the rounded
  // boundary frame is the boundary, so the launch must not slip a bar.
  const offGrid = song({
    bpm: 137,
    tracks: [track("t1")],
    scenes: [scene("s1")],
    clips: [clip("c1", "t1", "s1", 1, [note(0, 1, 60)])],
  });
  const odd = sequencer(offGrid);
  odd.play();
  const barFrames = Math.round(((SAMPLE_RATE * 60) / 137) * 4); // a bar is not a whole number of frames here
  assert.deepEqual(brief(odd.block(0, barFrames)), []);
  odd.launchScene("s1");
  assert.deepEqual(brief(odd.block(barFrames, 128)), [{ frame: 0, track_id: "t1", type: "on", p: 60 }]);
});

test("launchScene queued mid-bar is reported at the next bar's frame offset", () => {
  // 120 bpm at 48 kHz: a bar is exactly 96,000 frames, so the boundary is a
  // whole frame and the report is that frame minus the block's first frame.
  const even = sequencer(
    song({
      tracks: [track("t1")],
      scenes: [scene("s1")],
      clips: [clip("c1", "t1", "s1", 1, [note(0, 1, 60)])],
    }),
  );
  even.play();
  assert.deepEqual(launchesOf(even.block(0, 10000)), [], "nothing is launched yet");

  even.launchScene("s1");
  assert.deepEqual(launchesOf(even.block(10000, FRAMES_PER_BAR - 10000)), [], "the launch waits for the bar");
  assert.deepEqual(launchesOf(even.block(FRAMES_PER_BAR, 128)), [
    { track_id: "t1", clip_id: "c1", scene_id: "s1", bar: 1, frame: 0 },
  ]);

  // 97 bpm at 44.1 kHz: a bar is 109,113.40… frames, so the boundary is a
  // rounded position part-way into a block and has to be reported there.
  const barFrames = (44100 * 60 * 4) / 97;
  const boundary = Math.round(barFrames);
  assert.notEqual(boundary, barFrames, "this tempo must leave a fractional bar");

  const odd = StudioSequencer.create({ sampleRate: 44100 });
  odd.setSong(
    song({
      bpm: 97,
      tracks: [track("t1")],
      scenes: [scene("s1")],
      clips: [clip("c1", "t1", "s1", 1, [note(0, 1, 60)])],
    }),
  );
  odd.play();
  odd.block(0, 50000);
  odd.launchScene("s1");

  const offset = boundary - 50000;
  const block = odd.block(50000, 60000);
  assert.deepEqual(launchesOf(block), [
    { track_id: "t1", clip_id: "c1", scene_id: "s1", bar: 1, frame: offset },
  ]);
  assert.ok(offset > 0 && offset < 60000, "the boundary has to be inside the block, not at its edge");
});

test("nextBarFrame matches the frame of the following bar while playing", () => {
  const idle = sequencer(
    song({
      tracks: [track("t1")],
      scenes: [scene("s1")],
      clips: [clip("c1", "t1", "s1", 1, [note(0, 1, 60)])],
    }),
  );
  // Stopped: bar 0 starts at the next block's first frame.
  assert.deepEqual(idle.nextBarFrame(), { bar: 0, beat: 0, frame: 0 });
  idle.block(0, 128);
  assert.deepEqual(idle.nextBarFrame(), { bar: 0, beat: 0, frame: 128 });

  const seq = sequencer(
    song({
      tracks: [track("t1")],
      scenes: [scene("s1")],
      clips: [clip("c1", "t1", "s1", 1, [note(0, 1, 60)])],
    }),
  );
  seq.play();
  seq.block(0, FRAMES_PER_BEAT);
  const next = seq.nextBarFrame();
  assert.deepEqual(next, { bar: 1, beat: 4, frame: FRAMES_PER_BAR });

  // A launch queued mid-bar is reported at exactly the frame the helper names.
  seq.launchScene("s1");
  let at = FRAMES_PER_BEAT;
  let reported = null;
  while (reported === null && at < FRAMES_PER_BAR * 2) {
    const frames = 4096;
    const launches = launchesOf(seq.block(at, frames));
    if (launches.length > 0) reported = { ...launches[0], frame: at + launches[0].frame };
    at += frames;
  }
  assert.deepEqual(reported, {
    track_id: "t1",
    clip_id: "c1",
    scene_id: "s1",
    bar: next.bar,
    frame: next.frame,
  });

  // The same at a fractional frames-per-beat, where the boundary is a rounded
  // position and the helper could drift a frame if it rounded differently.
  const odd = StudioSequencer.create({ sampleRate: 44100 });
  odd.setSong(
    song({
      bpm: 97,
      tracks: [track("t1")],
      scenes: [scene("s1")],
      clips: [clip("c1", "t1", "s1", 1, [note(0, 1, 60)])],
    }),
  );
  odd.play();
  odd.block(0, 12345);
  const oddBoundary = Math.round((44100 * 60 * 4) / 97);
  assert.deepEqual(odd.nextBarFrame(), { bar: 1, beat: 4, frame: oddBoundary }, "the frame must be the rounded boundary");
});

test("stopTrack is reported with clip_id null", () => {
  const seq = sequencer(
    song({
      tracks: [track("t1")],
      scenes: [scene("s1")],
      clips: [clip("c1", "t1", "s1", 1, [note(0, 1, 60)])],
    }),
  );
  seq.launchScene("s1");
  seq.play();

  // Launched before the transport ran, so it takes effect in the block that
  // starts the transport, at bar 0.
  assert.deepEqual(launchesOf(seq.block(0, 1000)), [
    { track_id: "t1", clip_id: "c1", scene_id: "s1", bar: 0, frame: 0 },
  ]);

  seq.stopTrack("t1");
  assert.deepEqual(launchesOf(seq.block(1000, FRAMES_PER_BAR - 1000)), [], "the stop waits for the bar");
  // A stop has no clip of its own: clip_id is null, and the scene is the one
  // of the clip it replaced.
  assert.deepEqual(launchesOf(seq.block(FRAMES_PER_BAR, 128)), [
    { track_id: "t1", clip_id: null, scene_id: "s1", bar: 1, frame: 0 },
  ]);
});

test("a scene launch reports every track in its row, empty slots included", () => {
  const seq = sequencer(
    song({
      // The third track has no clip in either scene: a scene launch still
      // reports it (as a stop), so a recording armed on an empty slot starts.
      tracks: [track("t1"), track("t2"), track("t3")],
      scenes: [scene("s1"), scene("s2")],
      clips: [
        clip("c1", "t1", "s1", 1, [note(0, 1, 60)]),
        clip("c2", "t2", "s1", 1, [note(0, 1, 64)]),
        clip("c3", "t1", "s2", 1, [note(0, 2, 72)]),
      ],
    }),
  );

  seq.launchScene("s1");
  seq.play();
  assert.deepEqual(launchesOf(seq.block(0, 128)), [
    { track_id: "t1", clip_id: "c1", scene_id: "s1", bar: 0, frame: 0 },
    { track_id: "t2", clip_id: "c2", scene_id: "s1", bar: 0, frame: 0 },
    { track_id: "t3", clip_id: null, scene_id: "s1", bar: 0, frame: 0 },
  ]);

  // Scene 2 changes both: t1 gets its other clip, t2 stops. Every entry
  // carries the scene that was launched, and the stop carries null as its
  // clip.
  seq.launchScene("s2");
  assert.deepEqual(launchesOf(seq.block(128, FRAMES_PER_BAR - 128)), [], "the launch waits for the bar");
  assert.deepEqual(launchesOf(seq.block(FRAMES_PER_BAR, 128)), [
    { track_id: "t1", clip_id: "c3", scene_id: "s2", bar: 1, frame: 0 },
    { track_id: "t2", clip_id: null, scene_id: "s2", bar: 1, frame: 0 },
    { track_id: "t3", clip_id: null, scene_id: "s2", bar: 1, frame: 0 },
  ]);

  // Launching the scene that is already playing is still a launch of that
  // row, so every track is reported again at the next bar.
  seq.launchScene("s2");
  assert.equal(launchesOf(seq.block(FRAMES_PER_BAR + 128, FRAMES_PER_BAR * 2)).length, 3);
});

/** @returns {object[]} events as [frame, track, type, pitch] rows, easy to read. */
function rowsOf(events) {
  return events.map((event) => [event.frame, event.track_id, event.type, event.p]);
}

test("arrangement mode plays placements on their bars", () => {
  const seq = sequencer(
    song({
      tracks: [track("t1"), track("t2")],
      scenes: [scene("s1")],
      clips: [
        clip("c1", "t1", "s1", 1, [note(0, 1, 60)]),
        clip("c2", "t2", "s1", 1, [note(0, 1, 64)]),
      ],
      arrangement: arrangementOf([
        placement("p1", "t1", "c1", 1, 1),
        placement("p2", "t2", "c2", 2, 1),
      ]),
    }),
  );

  seq.setMode("arrangement");
  seq.play();

  // Each track sounds only where its placement is: bar 1 for the first one,
  // bar 2 for the second, and nothing in between.
  assert.deepEqual(rowsOf(collect(seq, FRAMES_PER_BAR * 3, 128)), [
    [FRAMES_PER_BAR, "t1", "on", 60],
    [FRAMES_PER_BAR + FRAMES_PER_BEAT, "t1", "off", 60],
    [FRAMES_PER_BAR * 2, "t2", "on", 64],
    [FRAMES_PER_BAR * 2 + FRAMES_PER_BEAT, "t2", "off", 64],
  ]);
});

test("a placement longer than its clip loops it", () => {
  const seq = sequencer(
    song({
      tracks: [track("t1")],
      scenes: [scene("s1")],
      clips: [clip("c1", "t1", "s1", 1, [note(0, 1, 60)])],
      arrangement: arrangementOf([placement("p1", "t1", "c1", 0, 3)]),
    }),
  );

  seq.setMode("arrangement");
  seq.play();

  // The clip is one bar long and the placement three, so it plays three times.
  const events = collect(seq, FRAMES_PER_BAR * 3, 128);
  assert.deepEqual(
    events.filter((event) => event.type === "on").map((event) => event.frame),
    [0, FRAMES_PER_BAR, FRAMES_PER_BAR * 2],
  );
  assert.deepEqual(
    events.filter((event) => event.type === "off").map((event) => event.frame),
    [FRAMES_PER_BEAT, FRAMES_PER_BAR + FRAMES_PER_BEAT, FRAMES_PER_BAR * 2 + FRAMES_PER_BEAT],
  );
});

test("split placements are seamless", () => {
  // A two-bar clip in one placement, then the same clip as `arrangement.split`
  // leaves it: two one-bar halves, the second starting four beats into the
  // clip, which is exactly where the first one stopped. One note crosses the
  // split, so a cut at the boundary or a repeat of the clip would show.
  const notes = [note(0, 1, 60), note(3, 4, 62), note(6, 1, 65)];
  const make = (placements) =>
    song({
      tracks: [track("t1")],
      scenes: [scene("s1")],
      clips: [clip("c1", "t1", "s1", 2, notes)],
      arrangement: arrangementOf(placements),
    });

  const whole = sequencer(make([placement("p1", "t1", "c1", 0, 2)]));
  whole.setMode("arrangement");
  whole.play();
  const unsplit = collect(whole, FRAMES_PER_BAR * 2, 128);

  const split = sequencer(
    make([
      placement("p1", "t1", "c1", 0, 1),
      placement("p2", "t1", "c1", 1, 1, { offset_beats: 4 }),
    ]),
  );
  split.setMode("arrangement");
  split.play();
  const halves = collect(split, FRAMES_PER_BAR * 2, 128);

  assert.ok(unsplit.length > 0, "the clip has to make some sound");
  assert.deepEqual(halves, unsplit, "a split has to play exactly what the one placement played");
});

test("seek starts mid-placement without stuck notes", () => {
  const seq = sequencer(
    song({
      tracks: [track("t1")],
      scenes: [scene("s1")],
      // A long note from clip beat 0 and a short one at beat 4.
      clips: [clip("c1", "t1", "s1", 2, [note(0, 8, 60), note(4, 1, 67)])],
      arrangement: arrangementOf([placement("p1", "t1", "c1", 0, 4)]),
    }),
  );

  seq.setMode("arrangement");
  seq.play();
  assert.deepEqual(brief(seq.block(0, 128)), [{ frame: 0, track_id: "t1", type: "on", p: 60 }]);

  // Bar 1 (the second bar) is four beats into the placement, in the middle of
  // the long note: that note is closed, and the one that starts there begins.
  seq.seek(1);
  assert.deepEqual(brief(seq.block(128, 128)), [
    { frame: 0, track_id: "t1", type: "off", p: 60 },
    { frame: 0, track_id: "t1", type: "on", p: 67 },
  ]);
  // The transport reads the timeline's own bars after a seek.
  assert.deepEqual(seq.position(), { bar: 2, beat: 1, sixteenth: 1 });

  // The short note ends one beat later, and nothing else is left sounding.
  assert.deepEqual(rowsOf(collectFrom(seq, 256, FRAMES_PER_BEAT, 128)), [
    [128 + FRAMES_PER_BEAT, "t1", "off", 67],
  ]);

  // Seeking back to the start plays the whole placement again from its first
  // frame: the long note comes back, and no note was left stuck in between.
  seq.seek(0);
  assert.deepEqual(brief(seq.block(256 + FRAMES_PER_BEAT, 128)), [
    { frame: 0, track_id: "t1", type: "on", p: 60 },
  ]);
});

test("launches are ignored in arrangement mode", () => {
  const snapshot = song({
    tracks: [track("t1")],
    scenes: [scene("s1")],
    clips: [clip("c1", "t1", "s1", 1, [note(0, 1, 60)])],
    arrangement: arrangementOf([placement("p1", "t1", "c1", 0, 3)]),
  });

  const reference = sequencer(snapshot);
  reference.setMode("arrangement");
  reference.play();
  const expected = collect(reference, FRAMES_PER_BAR * 2, 128);
  assert.ok(expected.length > 0, "the placement has to make some sound");

  const seq = sequencer(snapshot);
  seq.setMode("arrangement");
  seq.launchScene("s1");
  seq.launchClip("c1");
  seq.stopTrack("t1");
  seq.stopAll();
  seq.play();

  // Every transport gesture above is a session one: nothing is armed, nothing
  // is reported, and the timeline plays as if they had never been asked for.
  const events = [];
  for (let at = 0; at < FRAMES_PER_BAR * 2; at += 128) {
    const block = seq.block(at, 128);
    assert.deepEqual(launchesOf(block), [], "an arrangement reports no launches");
    for (const event of block) events.push({ ...event, frame: at + event.frame });
  }
  assert.deepEqual(events, expected);

  // And a stop gesture in the middle of the timeline does not stop it either.
  seq.stopAll();
  assert.equal(seq.isPlaying(), true, "stopAll is a session gesture and does not halt the timeline");
  assert.ok(collectFrom(seq, FRAMES_PER_BAR * 2, FRAMES_PER_BEAT, 128).length > 0);
});

test("seek before a placement with an offset still plays the current one", () => {
  // A two-bar take from bar 0, and a second take placed at bar 2 that starts
  // six beats into its clip: its clip beat 0 sits at beat 2, but nothing of it
  // sounds before beat 8. Seeking to bar 1 (beat 4) lands in the FIRST
  // placement, whose take has to start at its beat 4.
  const seq = sequencer(
    song({
      tracks: [audioTrack("t1")],
      scenes: [scene("s1")],
      clips: [
        audioClip("a", "t1", "s1", 2, [{ take_id: "k1", from_beat: 0, to_beat: 8 }]),
        audioClip("b", "t1", "s1", 2, [{ take_id: "k2", from_beat: 0, to_beat: 8 }]),
      ],
      takes: [take("k1", "a"), take("k2", "b")],
      arrangement: arrangementOf([
        placement("p1", "t1", "a", 0, 2),
        placement("p2", "t1", "b", 2, 2, { offset_beats: 6 }),
      ]),
    }),
  );

  seq.setMode("arrangement");
  seq.seek(1);
  seq.play();

  const audio = seq.block(0, 128).filter((event) => event.type === "audio");
  assert.equal(audio.length, 1, "the placement the playhead is in has to start its take");
  assert.equal(audio[0].take_id, "k1", "the seek is inside the first placement, not the one before it is audible");
  assert.equal(audio[0].take_frame, FRAMES_PER_BEAT * 4, "the take starts four beats into the clip");
  assert.equal(audio[0].voice, 0);
});

test("changing a sounding placement's fade does not drop its audio", () => {
  const make = (fadeOut) =>
    song({
      tracks: [audioTrack("t1")],
      scenes: [scene("s1")],
      clips: [audioClip("a", "t1", "s1", 2, [{ take_id: "k1", from_beat: 0, to_beat: 8 }])],
      takes: [take("k1", "a")],
      arrangement: arrangementOf([placement("p1", "t1", "a", 0, 2, { fade_out_beats: fadeOut })]),
    });

  const seq = sequencer(make(0));
  seq.setMode("arrangement");
  seq.play();

  const first = collect(seq, FRAMES_PER_BAR, 128);
  assert.ok(
    first.some((event) => event.type === "audio" && event.take_id === "k1"),
    "the take has to be sounding before the edit",
  );

  // Half way through the placement a fade out is added to it.
  seq.setSong(make(4));
  const after = collectFrom(seq, FRAMES_PER_BAR, FRAMES_PER_BAR, 128);

  assert.deepEqual(
    after.filter((event) => event.type === "audio" || event.type === "audio_stop"),
    [],
    "a placement that only changed its fade keeps the voice it was playing on",
  );

  // The new fade reaches that voice: it starts on beat 4 of the placement and
  // ramps its gain down from 1 to 0 over its last four beats.
  const fades = after.filter((event) => event.type === "fade");
  assert.equal(fades.length, 1, `expected one fade, got ${JSON.stringify(fades)}`);
  assert.deepEqual(fades[0], {
    frame: FRAMES_PER_BAR,
    track_id: "t1",
    type: "fade",
    voice: 0,
    from: 1,
    to: 0,
    frames: 4 * FRAMES_PER_BEAT,
  });
});

test("seek in session mode does not touch the session transport", () => {
  const snapshot = song({
    tracks: [track("t1")],
    scenes: [scene("s1"), scene("s2")],
    clips: [clip("c1", "t1", "s1", 1, [note(0, 1, 60)]), clip("c2", "t1", "s2", 1, [note(0, 2, 72)])],
  });

  /** Play to bar 2, schedule the other clip for the next bar, seek, play on. */
  function run(withSeek) {
    const seq = sequencer(snapshot);
    seq.launchClip("c1");
    seq.play();
    const events = [];
    const reports = [];
    const step = (from, to) => {
      for (let at = from; at < to; at += 128) {
        const block = seq.block(at, 128);
        for (const event of block) events.push({ ...event, frame: at + event.frame });
        for (const report of launchesOf(block)) reports.push({ ...report, frame: at + report.frame });
      }
    };
    step(0, FRAMES_PER_BAR * 2);
    seq.launchClip("c2");
    if (withSeek) seq.seek(7);
    const position = seq.position();
    step(FRAMES_PER_BAR * 2, FRAMES_PER_BAR * 3);
    return { events, reports, position };
  }

  const plain = run(false);
  const seeked = run(true);
  assert.ok(plain.events.length > 0, "the session has to be making some sound");
  assert.deepEqual(seeked.events, plain.events, "a session seek changes nothing about what plays");
  assert.deepEqual(seeked.position, plain.position, "a session seek does not put the transport back to 1.1.1");
  assert.deepEqual(seeked.reports, plain.reports, "a launch scheduled before the seek still lands at its bar");
  assert.ok(
    plain.reports.some((report) => report.clip_id === "c2" && report.bar === 2),
    "the scheduled launch has to be reported at bar 2",
  );

  // The bar is only stored, for a later switch to the timeline: the arrangement
  // starts there instead of at bar 0.
  const timeline = sequencer(
    song({
      tracks: [track("t1")],
      scenes: [scene("s1")],
      clips: [clip("c3", "t1", "s1", 1, [note(0, 1, 65)])],
      arrangement: arrangementOf([placement("p1", "t1", "c3", 2, 1)]),
    }),
  );
  timeline.seek(2);
  timeline.setMode("arrangement");
  timeline.play();
  assert.deepEqual(brief(timeline.block(0, 128)), [{ frame: 0, track_id: "t1", type: "on", p: 65 }]);
});

// --- pattern clips: steps, swing, chains ------------------------------------

test("steps land on their 16ths", () => {
  const seq = sequencer(
    song({
      tracks: [samplerTrack("t1")],
      scenes: [scene("s1")],
      // 16 steps of a 16th each: one bar, one pattern.
      clips: [patternClip("c1", "t1", "s1")],
      patterns: [pattern("c1", "a", 0)],
      steps: [
        step("c1", "a", 0, 0),
        step("c1", "a", 1, 1),
        step("c1", "a", 2, 2),
        step("c1", "a", 3, 3),
        step("c1", "a", 15, 4),
      ],
    }),
  );

  seq.launchClip("c1");
  seq.play();
  const events = collect(seq, FRAMES_PER_BAR, 128);

  // Each step is at `at × step_beats` beats, i.e. on its 16th.
  assert.deepEqual(padRows(events), [
    [0, 0],
    [FRAMES_PER_SIXTEENTH, 1],
    [FRAMES_PER_SIXTEENTH * 2, 2],
    [FRAMES_PER_SIXTEENTH * 3, 3],
    [FRAMES_PER_SIXTEENTH * 15, 4],
  ]);
  for (const event of events) {
    assert.equal(event.type, "pad");
    assert.equal(event.track_id, "t1");
    assert.equal(event.bank_id, "b1");
    assert.equal(event.v, 100);
    // The gate is the plain step length: one 16th of frames.
    assert.equal(event.gate_frames, FRAMES_PER_SIXTEENTH);
  }
  // A pad trigger is not a note: nothing is released.
  assert.equal(events.some((event) => event.type !== "pad"), false);

  // And the pattern loops, so the next bar plays the same steps again.
  assert.deepEqual(padRows(collectFrom(seq, FRAMES_PER_BAR, FRAMES_PER_BAR, 128)), [
    [FRAMES_PER_BAR, 0],
    [FRAMES_PER_BAR + FRAMES_PER_SIXTEENTH, 1],
    [FRAMES_PER_BAR + FRAMES_PER_SIXTEENTH * 2, 2],
    [FRAMES_PER_BAR + FRAMES_PER_SIXTEENTH * 3, 3],
    [FRAMES_PER_BAR + FRAMES_PER_SIXTEENTH * 15, 4],
  ]);
});

/** A one-bar pattern clip of four 16th steps on pads 0..3, over a swing. */
function swungSong(swing, bpm = BPM) {
  return song({
    bpm,
    tracks: [samplerTrack("t1")],
    scenes: [scene("s1")],
    clips: [patternClip("c1", "t1", "s1", { swing })],
    patterns: [pattern("c1", "a", 0)],
    steps: [step("c1", "a", 0, 0), step("c1", "a", 1, 1), step("c1", "a", 2, 2), step("c1", "a", 3, 3)],
  });
}

test("swing 0.5 delays odd 16ths by 0.125 beat", () => {
  const seq = sequencer(swungSong(0.5));
  seq.launchClip("c1");
  seq.play();
  const events = collect(seq, FRAMES_PER_BAR, 128);

  // 0.5 × a 16th is a 32nd, i.e. 0.125 beat = 3,000 frames: the even steps keep
  // their place and the odd ones move by exactly that much.
  const delay = FRAMES_PER_BEAT * 0.125;
  assert.deepEqual(padRows(events), [
    [0, 0],
    [FRAMES_PER_SIXTEENTH + delay, 1],
    [FRAMES_PER_SIXTEENTH * 2, 2],
    [FRAMES_PER_SIXTEENTH * 3 + delay, 3],
  ]);
  // The swing delays the onset, not the gate.
  for (const event of events) assert.equal(event.gate_frames, FRAMES_PER_SIXTEENTH);

  // A swing change is read at the next block: the step already played keeps its
  // frame, and the ones still ahead move — nothing is emitted twice.
  const live = sequencer(swungSong(0));
  live.launchClip("c1");
  live.play();
  assert.deepEqual(padRows(collect(live, FRAMES_PER_SIXTEENTH, 128)), [[0, 0]]);
  live.setSong(swungSong(0.5));
  assert.deepEqual(padRows(collectFrom(live, FRAMES_PER_SIXTEENTH, FRAMES_PER_BAR - FRAMES_PER_SIXTEENTH, 128)), [
    [FRAMES_PER_SIXTEENTH + delay, 1],
    [FRAMES_PER_SIXTEENTH * 2, 2],
    [FRAMES_PER_SIXTEENTH * 3 + delay, 3],
  ]);

  // At a tempo whose beat is not a whole number of frames the delay is rounded
  // together with the absolute position, never added as its own rounded delta.
  const odd = StudioSequencer.create({ sampleRate: 44100 });
  odd.setSong(swungSong(0.5, 97));
  odd.launchClip("c1");
  odd.play();
  const framesPerBeat = (44100 * 60) / 97;
  assert.deepEqual(padRows(collect(odd, framesPerBeat * 4, 512)), [
    [0, 0],
    [Math.round(framesPerBeat * 0.375), 1],
    [Math.round(framesPerBeat * 0.5), 2],
    [Math.round(framesPerBeat * 0.875), 3],
  ]);
  assert.notEqual(
    Math.round(framesPerBeat * 0.375),
    Math.round(framesPerBeat * 0.25) + Math.round(framesPerBeat * 0.125),
    "the swung onset must be rounded as one absolute position",
  );
});

/** A one-bar-per-pattern clip whose chain is the given list. */
function chainSong(chain) {
  return song({
    tracks: [samplerTrack("t1")],
    scenes: [scene("s1")],
    clips: [patternClip("c1", "t1", "s1", { chain })],
    patterns: [pattern("c1", "a", 0), pattern("c1", "b", 1)],
    // The two patterns are told apart by their pad: "a" plays pad 0, "b" 1.
    steps: [step("c1", "a", 0, 0), step("c1", "b", 0, 1)],
  });
}

test("a chain plays its patterns in order and loops", () => {
  const seq = sequencer(chainSong(["a", "b", "a"]));
  seq.launchClip("c1");
  seq.play();

  // One pattern is one bar here, so the chain reads a, b, a and then starts
  // over: the fourth bar is "a" again, the first pattern of the chain.
  const events = collect(seq, FRAMES_PER_BAR * 4, 128);
  assert.deepEqual(padRows(events), [
    [0, 0],
    [FRAMES_PER_BAR, 1],
    [FRAMES_PER_BAR * 2, 0],
    [FRAMES_PER_BAR * 3, 0],
  ]);
  // A pattern change inside a chain cuts nothing: a pad is never released.
  assert.equal(events.some((event) => event.type !== "pad"), false);

  // A chain edit lands from the next block, at the clip-relative beat the
  // playhead reached: the fifth bar now plays the one-pattern chain "a".
  seq.setSong(chainSong(["a"]));
  assert.deepEqual(padRows(collectFrom(seq, FRAMES_PER_BAR * 4, FRAMES_PER_BAR, 128)), [
    [FRAMES_PER_BAR * 4, 0],
  ]);
});

test("a placement of a pattern clip plays its chain on the timeline", () => {
  const seq = sequencer(
    song({
      tracks: [samplerTrack("t1")],
      scenes: [scene("s1")],
      clips: [patternClip("c1", "t1", "s1", { chain: ["a", "b"] })],
      patterns: [pattern("c1", "a", 0), pattern("c1", "b", 1)],
      steps: [step("c1", "a", 0, 0), step("c1", "b", 0, 1)],
      // Four beats into its clip: the placement starts on the chain's second
      // pattern, one bar into the two-bar cycle.
      arrangement: arrangementOf([placement("p1", "t1", "c1", 0, 2, { offset_beats: 4 })]),
    }),
  );

  seq.setMode("arrangement");
  seq.play();

  // The placement is two bars and one pattern is one bar, so it plays "b" and
  // then the "a" its cycle comes round to — and never the "a" step that sits
  // before the placement began.
  assert.deepEqual(padRows(collect(seq, FRAMES_PER_BAR * 2, 128)), [
    [0, 1],
    [FRAMES_PER_BAR, 0],
  ]);
});

function firstOfClipSong() {
  return song({
    tracks: [samplerTrack("t1")],
    scenes: [scene("s1")],
    clips: [patternClip("c1", "t1", "s1")],
    // Written out of order and with the same order on two of them: the first
    // pattern is the lowest `order`, then the lowest id — "a".
    patterns: [pattern("c1", "b", 0), pattern("c1", "c", 1), pattern("c1", "a", 0)],
    steps: [step("c1", "a", 0, 0), step("c1", "b", 0, 1), step("c1", "c", 0, 2)],
  });
}

test("an empty chain plays the first pattern", () => {
  const seq = sequencer(firstOfClipSong());
  seq.launchClip("c1");
  seq.play();

  assert.deepEqual(padRows(collect(seq, FRAMES_PER_BAR * 3, 128)), [
    [0, 0],
    [FRAMES_PER_BAR, 0],
    [FRAMES_PER_BAR * 2, 0],
  ]);
});

test("seeking into a chain lands on the right pattern", () => {
  const seq = sequencer(
    song({
      tracks: [samplerTrack("t1")],
      scenes: [scene("s1")],
      clips: [patternClip("c1", "t1", "s1", { chain: ["a", "b"] })],
      patterns: [pattern("c1", "a", 0), pattern("c1", "b", 1)],
      steps: [step("c1", "a", 0, 0), step("c1", "b", 0, 1)],
      arrangement: arrangementOf([placement("p1", "t1", "c1", 0, 4)]),
    }),
  );

  seq.setMode("arrangement");
  seq.play();
  assert.deepEqual(padRows(collect(seq, FRAMES_PER_BAR * 2, 128)), [
    [0, 0],
    [FRAMES_PER_BAR, 1],
  ]);

  // Seeking to bar 1 lands on the chain's SECOND pattern: which pattern sounds
  // follows from the beat the playhead reached, not from what played before.
  seq.seek(1);
  assert.deepEqual(padRows(collectFrom(seq, FRAMES_PER_BAR * 2, FRAMES_PER_BAR * 2, 128)), [
    [FRAMES_PER_BAR * 2, 1],
    [FRAMES_PER_BAR * 3, 0],
  ]);

  // And bar 3 is the cycle's second pattern again, "b".
  seq.seek(3);
  assert.deepEqual(padRows(collectFrom(seq, FRAMES_PER_BAR * 4, FRAMES_PER_BAR, 128)), [
    [FRAMES_PER_BAR * 4, 1],
  ]);
});

/**
 * A chain clip on one sampler track, with the placements given: one pattern is
 * one bar, and the pads tell the patterns apart — "a" plays pad 0, "b" 1 and
 * "c" 2.
 */
function chainedArrangementSong(chain, placements) {
  return song({
    tracks: [samplerTrack("t1")],
    scenes: [scene("s1")],
    clips: [patternClip("c1", "t1", "s1", { chain })],
    patterns: [pattern("c1", "a", 0), pattern("c1", "b", 1), pattern("c1", "c", 2)],
    steps: [step("c1", "a", 0, 0), step("c1", "b", 0, 1), step("c1", "c", 0, 2)],
    arrangement: arrangementOf(placements),
  });
}

/** Play a song's arrangement from bar 0 and read the pads it played. */
function arrangementPads(snapshot, bars) {
  const seq = sequencer(snapshot);
  seq.setMode("arrangement");
  seq.play();
  return padRows(collect(seq, FRAMES_PER_BAR * bars, 128));
}

test("adjacent placements of a chained clip each start where their offset says", () => {
  // The cycle two placements are joined on is the chain's own: two bars here,
  // not the clip's one. A second placement at offset 0 therefore starts that
  // cycle over — "a" again — instead of carrying on into the "b" that follows
  // the first bar, even though the two placements are adjacent.
  assert.deepEqual(
    arrangementPads(
      chainedArrangementSong(
        ["a", "b"],
        [placement("p1", "t1", "c1", 0, 1), placement("p2", "t1", "c1", 1, 1)],
      ),
      2,
    ),
    [
      [0, 0],
      [FRAMES_PER_BAR, 0],
    ],
  );

  // An offset that does continue the cycle — four beats into the two-bar cycle
  // — is still joined to the placement before it, and plays "b" there.
  assert.deepEqual(
    arrangementPads(
      chainedArrangementSong(
        ["a", "b"],
        [
          placement("p1", "t1", "c1", 0, 1),
          placement("p2", "t1", "c1", 1, 1, { offset_beats: 4 }),
        ],
      ),
      2,
    ),
    [
      [0, 0],
      [FRAMES_PER_BAR, 1],
    ],
  );

  // A placement that is not adjacent at all starts its own cycle: a gap is
  // silence, and the second placement is "a" again a bar later.
  assert.deepEqual(
    arrangementPads(
      chainedArrangementSong(
        ["a", "b"],
        [placement("p1", "t1", "c1", 0, 1), placement("p2", "t1", "c1", 2, 1)],
      ),
      3,
    ),
    [
      [0, 0],
      [FRAMES_PER_BAR * 2, 0],
    ],
  );
});

test("a chain entry naming a missing pattern is a silent slot", () => {
  // "x" names no pattern of this clip. It is not compacted out of the chain:
  // its bar plays nothing and the cycle still runs a, silence, b — one bar each.
  assert.deepEqual(
    arrangementPads(
      chainedArrangementSong(["a", "x", "b"], [placement("p1", "t1", "c1", 0, 4)]),
      4,
    ),
    [
      [0, 0],
      [FRAMES_PER_BAR * 2, 1],
      [FRAMES_PER_BAR * 3, 0],
    ],
  );

  // Scene mode reads the very same chain out of the document.
  const seq = sequencer(chainSong(["a", "x", "b"]));
  seq.launchClip("c1");
  seq.play();
  assert.deepEqual(padRows(collect(seq, FRAMES_PER_BAR * 4, 128)), [
    [0, 0],
    [FRAMES_PER_BAR * 2, 1],
    [FRAMES_PER_BAR * 3, 0],
  ]);

  // A chain with nothing left to play at all is no chain: every slot is the
  // clip's first pattern, rather than a song that plays nothing.
  assert.deepEqual(
    arrangementPads(chainedArrangementSong(["x", "y"], [placement("p1", "t1", "c1", 0, 2)]), 2),
    [
      [0, 0],
      [FRAMES_PER_BAR, 0],
    ],
  );
});

test("an offset inside a pattern lands mid-pattern", () => {
  // Offset 2 is inside the clip's four-beat pattern: the steps that sit at the
  // pattern's start are behind the playhead, so the placement opens on "b"
  // half a bar in, and each pattern still lays its own steps from there.
  assert.deepEqual(
    arrangementPads(
      chainedArrangementSong(["a", "b"], [placement("p1", "t1", "c1", 0, 3, { offset_beats: 2 })]),
      3,
    ),
    [
      [FRAMES_PER_BAR / 2, 1],
      [(FRAMES_PER_BAR * 3) / 2, 0],
      [(FRAMES_PER_BAR * 5) / 2, 1],
    ],
  );
});

test("a chain renders the same events at any block size", () => {
  // Swing pushes the odd steps close to block boundaries, where a rounding
  // rule that leaked the block position would show. A 128-frame block and a
  // 97-frame one must yield the very same events at the very same frames.
  const snapshot = () =>
    song({
      tracks: [samplerTrack("t1")],
      scenes: [scene("s1")],
      clips: [patternClip("c1", "t1", "s1", { chain: ["a", "x", "b"], swing: 0.75 })],
      patterns: [pattern("c1", "a", 0), pattern("c1", "b", 1)],
      steps: [
        step("c1", "a", 0, 0),
        step("c1", "a", 3, 3),
        step("c1", "a", 15, 4),
        step("c1", "b", 7, 5),
        step("c1", "b", 14, 6),
      ],
      arrangement: arrangementOf([
        placement("p1", "t1", "c1", 0, 3),
        placement("p2", "t1", "c1", 3, 2, { offset_beats: 1 }),
      ]),
    });

  const play = (size) => {
    const seq = sequencer(snapshot());
    seq.setMode("arrangement");
    seq.play();
    return collect(seq, FRAMES_PER_BAR * 5, size);
  };
  const wide = play(128);
  const narrow = play(97);
  assert.ok(wide.length > 4, "the song really plays something");
  assert.deepEqual(narrow, wide);
});

test("a swung last step stays inside its pattern", () => {
  // Swing 0.75 on the last step of a sixteen-step pattern: 3.75 beats plus 0.75
  // of a 16th is 3.9375 — still short of the 4-beat pattern end, so the pad
  // never slides past its pattern and no slot plays two of them.
  const seq = sequencer(
    song({
      tracks: [samplerTrack("t1")],
      scenes: [scene("s1")],
      clips: [patternClip("c1", "t1", "s1", { swing: 0.75 })],
      patterns: [pattern("c1", "a", 0)],
      steps: [step("c1", "a", 0, 0), step("c1", "a", 15, 15)],
      arrangement: arrangementOf([placement("p1", "t1", "c1", 0, 2)]),
    }),
  );
  seq.setMode("arrangement");
  seq.play();

  // The swung onset: 94,500 frames into its bar, 1,500 short of the next one.
  const swung = FRAMES_PER_BEAT * 3.9375;
  assert.deepEqual(padRows(collect(seq, FRAMES_PER_BAR * 2, 128)), [
    [0, 0],
    [swung, 15],
    [FRAMES_PER_BAR, 0],
    [FRAMES_PER_BAR + swung, 15],
  ]);
});