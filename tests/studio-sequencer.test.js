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

/** Run blocks of `size` frames from 0, with events moved to absolute frames. */
function collect(seq, total, size) {
  const out = [];
  for (let at = 0; at < total; at += size) {
    const frames = Math.min(size, total - at);
    for (const event of seq.block(at, frames)) out.push({ ...event, frame: at + event.frame });
  }
  return out;
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