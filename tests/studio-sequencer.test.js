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
function song({ bpm = BPM, tracks = [], scenes = [], clips = [] } = {}) {
  return {
    meta: { title: "Test song", bpm, meter: [4, 4], key: "C major" },
    tracks,
    scenes,
    clips: Object.fromEntries(clips.map((item) => [item.id, item])),
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