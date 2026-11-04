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
function song({ bpm = BPM, tracks = [], scenes = [], clips = [], arrangement = null } = {}) {
  const snapshot = {
    meta: { title: "Test song", bpm, meter: [4, 4], key: "C major" },
    tracks,
    scenes,
    clips: Object.fromEntries(clips.map((item) => [item.id, item])),
  };
  if (arrangement) snapshot.arrangement = arrangement;
  return snapshot;
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