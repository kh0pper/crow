/**
 * Studio engine: pause, and a seek that lands on a beat rather than a bar.
 *
 * The first half of this file reads the sequencer on its own — the pure event
 * generator both hosts (the worklet in a browser and Node's offline render)
 * play the song through, loaded with `require()` like
 * `tests/studio-sequencer.test.js` does, and tagged `sequencer:` in the test
 * names. Nothing there touches audio, a clock or a database: the snapshots are
 * in the shape `bundles/studio/server/doc.js` writes and the events are read
 * back.
 *
 * The last two cases run the REAL engine — `node-web-audio-api`'s
 * OfflineAudioContext with the bundle's own worklet, built the way
 * `tests/studio-engine.test.js` builds it — because what they are about is the
 * sound on either side of a pause: the metronome's accents and the sample a
 * take carries on from. A pause is asked for part way through such a render
 * with the offline context's `suspend()`: the case stops rendering at a frame,
 * posts the pause (and the `play()` that follows it), and lets the render
 * carry on. Those two skip on a host whose bundle cannot load
 * `node-web-audio-api`.
 *
 * At 120 bpm and 48 kHz one beat is 24,000 frames and one bar is 96,000.
 *
 * The last group of cases is about the COUNT-IN (R1, R2, R6, R7, R19), which is
 * transport state: they drive the real `engine/studio-processor.js` — composed
 * as `engine-client.js` composes it, evaluated in this thread with the worklet
 * globals it reads supplied as its parameters — and read back both what it posts
 * and what it renders. The song there is one AUDIO track whose take is a ramp,
 * so the frame the song really starts on can be read straight off the master:
 * every frame of the take has a level of its own. Nothing in them is SunVox's
 * business, so they need no native audio host and run everywhere.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const StudioSequencer = require("../bundles/studio/engine/sequencer.js");

const ENGINE_DIR = fileURLToPath(new URL("../bundles/studio/engine/", import.meta.url));
const VENDOR_DIR = fileURLToPath(new URL("../bundles/studio/vendor/sunvox/", import.meta.url));
/** The engine client, for the one thing a test needs from it: composing the module. */
const StudioEngineModule = require(join(ENGINE_DIR, "engine-client.js"));
const SYMBOLS_FILE = fileURLToPath(
  new URL("../bundles/studio/node_modules/node-web-audio-api/js/lib/symbols.js", import.meta.url),
);

const SAMPLE_RATE = 48000;
const BPM = 120;
const FRAMES_PER_BEAT = (SAMPLE_RATE * 60) / BPM; // 24,000
const FRAMES_PER_BAR = FRAMES_PER_BEAT * 4; // 96,000

/**
 * The frame every pause in this file is asked for at: beat 4.375, i.e. a
 * musical 3/8 into the second bar, deliberately away from a beat, a sixteenth
 * and a frame that a bar boundary is rounded to.
 */
const PAUSED_AT = FRAMES_PER_BEAT * 4.375; // 105,000

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
function song({ bpm = BPM, tracks = [], scenes = [], clips = [], takes = [], arrangement = null } = {}) {
  const snapshot = {
    meta: { title: "Pause test", bpm, meter: [4, 4], key: "C major" },
    tracks,
    scenes,
    clips: Object.fromEntries(clips.map((item) => [item.id, item])),
  };
  if (takes.length > 0) snapshot.takes = Object.fromEntries(takes.map((item) => [item.id, item]));
  if (arrangement) snapshot.arrangement = arrangement;
  return snapshot;
}

/** A track that plays takes instead of notes. */
function audioTrack(id = "t1") {
  return track(id, { device: { engine: "audio" } });
}

/** An audio clip: a comp over the clip's own beats, and no notes at all. */
function audioClip(id, trackId, sceneId, lengthBars, comp) {
  return { id, track_id: trackId, scene_id: sceneId, name: id, length_bars: lengthBars, kind: "audio", notes: [], comp };
}

/** A recorded take, as an audio clip's comp names it. */
function take(id, clipId, over = {}) {
  return { id, clip_id: clipId, rate: SAMPLE_RATE, offset_frames: 0, discarded: false, ...over };
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

/** @returns {object[]} events as [frame, track, type, pitch] rows, easy to read. */
function rowsOf(events) {
  return events.map((event) => [event.frame, event.track_id, event.type, event.p]);
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

/** A song of one note clip whose notes sit on the first beat of four bars. */
function fourBarSong() {
  return song({
    tracks: [track("t1")],
    scenes: [scene("s1")],
    clips: [clip("c1", "t1", "s1", 4, [note(0, 1, 60), note(4, 1, 62), note(8, 1, 64), note(12, 1, 65)])],
  });
}

// --- the sequencer -----------------------------------------------------------

test("sequencer: pause keeps the position and emits note-offs", () => {
  const seq = sequencer(
    song({
      tracks: [track("t1")],
      scenes: [scene("s1")],
      // One long note, still sounding when the transport is paused.
      clips: [clip("c1", "t1", "s1", 4, [note(0, 16, 60)])],
    }),
  );
  seq.launchClip("c1");
  seq.play();
  assert.deepEqual(brief(seq.block(0, PAUSED_AT)), [{ frame: 0, track_id: "t1", type: "on", p: 60 }]);

  const before = seq.position();
  seq.pause();

  assert.equal(seq.isPlaying(), false, "the transport is not running after a pause");
  assert.deepEqual(seq.position(), before, "a pause keeps the position the playhead reached");
  assert.deepEqual(seq.position(), { bar: 2, beat: 1, sixteenth: 2 }, "the paused playhead sits inside bar 2");

  // The note still sounding is released at once, exactly as a stop releases it:
  // its off is owed at the pause's frame and paid at the next block's first one.
  assert.deepEqual(brief(seq.block(PAUSED_AT, 128)), [{ frame: 0, track_id: "t1", type: "off", p: 60 }]);

  // And nothing else sounds while the transport is paused, however long the
  // host keeps handing blocks over.
  assert.deepEqual(brief(seq.block(PAUSED_AT + 128, FRAMES_PER_BAR)), []);
  assert.deepEqual(seq.position(), before);
});

test("sequencer: play after pause resumes at the paused beat in session and in arrangement", () => {
  const snapshot = () =>
    song({
      tracks: [track("t1")],
      scenes: [scene("s1")],
      // Eight bars of clip so nothing loops inside the two bars this reads, and
      // a note on the first beat of each of the run's first four bars.
      clips: [clip("c1", "t1", "s1", 8, [note(0, 1, 60), note(4, 1, 62), note(8, 1, 64), note(12, 1, 65)])],
      arrangement: arrangementOf([placement("p1", "t1", "c1", 0, 4)]),
    });

  /** @returns {object[]} the rows of the resumed run, in absolute frames. */
  function resumedRows(seq) {
    const rows = [];
    const step = (from, frames) => {
      for (const [frame, trackId, type, p] of rowsOf(seq.block(from, frames))) {
        rows.push([from + frame, trackId, type, p]);
      }
    };
    // What the pause owed is paid at the first frame of the resumed run.
    step(PAUSED_AT, 128);
    assert.equal(seq.isPlaying(), true, "play resumes the transport");
    // The rest of the bar, and the two after it.
    step(PAUSED_AT + 128, FRAMES_PER_BAR - 128);
    step(PAUSED_AT + FRAMES_PER_BAR, FRAMES_PER_BAR * 2);
    return rows;
  }

  /** The very same run, paused at beat 4.375 and carried on from there. */
  const expected = [
    [PAUSED_AT, "t1", "off", 62],
    [FRAMES_PER_BAR * 2, "t1", "on", 64],
    [FRAMES_PER_BAR * 2 + FRAMES_PER_BEAT, "t1", "off", 64],
    [FRAMES_PER_BAR * 3, "t1", "on", 65],
    [FRAMES_PER_BAR * 3 + FRAMES_PER_BEAT, "t1", "off", 65],
  ];

  const session = sequencer(snapshot());
  session.launchClip("c1");
  session.play();
  session.block(0, PAUSED_AT);
  session.pause();
  session.play();
  assert.deepEqual(resumedRows(session), expected, "a session run carries on from the beat it was paused at");

  const arrangement = sequencer(snapshot());
  arrangement.setMode("arrangement");
  arrangement.play();
  arrangement.block(0, PAUSED_AT);
  arrangement.pause();
  arrangement.play();
  assert.deepEqual(resumedRows(arrangement), expected, "a timeline run carries on from the same beat");
});

test("sequencer: stop after pause returns to bar 1 in session and to the seek bar in arrangement", () => {
  const snapshot = () =>
    song({
      tracks: [track("t1")],
      scenes: [scene("s1")],
      clips: [clip("c1", "t1", "s1", 4, [note(0, 1, 60), note(4, 1, 62), note(8, 1, 64)])],
      arrangement: arrangementOf([placement("p1", "t1", "c1", 0, 4)]),
    });

  // Session: a stop is a stop — the clip is armed again and plays from bar 1.
  const session = sequencer(snapshot());
  session.launchClip("c1");
  session.play();
  session.block(0, PAUSED_AT);
  session.pause();
  session.stop();
  assert.deepEqual(session.position(), { bar: 1, beat: 1, sixteenth: 1 }, "a session stop goes back to 1.1.1");
  session.play();
  // The note the pause cut is released first, and the clip's first note — the
  // one bar 1 holds — follows it at the same frame.
  assert.deepEqual(brief(session.block(PAUSED_AT, 128)), [
    { frame: 0, track_id: "t1", type: "off", p: 62 },
    { frame: 0, track_id: "t1", type: "on", p: 60 },
  ]);

  // Arrangement: the seek bar is kept, so the run starts again at bar 1 of the
  // timeline (beat 4) — not at bar 0, and not at the beat it was paused on.
  const arrangement = sequencer(snapshot());
  arrangement.setMode("arrangement");
  arrangement.seek(1);
  arrangement.play();
  assert.deepEqual(brief(arrangement.block(0, FRAMES_PER_BEAT / 2)), [{ frame: 0, track_id: "t1", type: "on", p: 62 }]);
  arrangement.block(FRAMES_PER_BEAT / 2, FRAMES_PER_BEAT); // to beat 5.5
  arrangement.pause();
  arrangement.stop();
  arrangement.play();

  // The run starts again on the seek bar, beat 4: the note that starts there
  // sounds at the resumed frame and the one on beat 0 — bar 0, which is not
  // where the timeline was left — is never played. A run resumed from the
  // pause instead would have started a beat and a half in.
  assert.deepEqual(rowsOf(arrangement.block(FRAMES_PER_BEAT * 1.5, FRAMES_PER_BAR)), [
    [0, "t1", "on", 62],
    [FRAMES_PER_BEAT, "t1", "off", 62],
  ]);
  assert.deepEqual(rowsOf(arrangement.block(FRAMES_PER_BEAT * 5.5, 128)), [[0, "t1", "on", 64]]);
});

test("sequencer: pause while stopped is a no-op", () => {
  const seq = sequencer(fourBarSong());
  seq.launchClip("c1");

  // Nothing is running yet, so there is nothing to pause: Play still starts the
  // clip at bar 1.
  seq.pause();
  assert.equal(seq.isPlaying(), false);
  assert.deepEqual(seq.position(), { bar: 1, beat: 1, sixteenth: 1 });
  seq.play();
  assert.deepEqual(brief(seq.block(0, 128)), [{ frame: 0, track_id: "t1", type: "on", p: 60 }]);

  // A second pause keeps the beat the first one recorded.
  seq.block(128, PAUSED_AT - 128);
  seq.pause();
  const paused = seq.position();
  seq.pause();
  assert.equal(seq.isPlaying(), false);
  assert.deepEqual(seq.position(), paused, "a pause while paused changes nothing");

  seq.play();
  assert.deepEqual(rowsOf(seq.block(PAUSED_AT, FRAMES_PER_BAR)), [
    [0, "t1", "off", 62],
    [FRAMES_PER_BAR * 2 - PAUSED_AT, "t1", "on", 64],
  ]);
});

test("sequencer: queued launches survive a pause", () => {
  const seq = sequencer(
    song({
      tracks: [track("t1")],
      scenes: [scene("s1"), scene("s2")],
      clips: [clip("c1", "t1", "s1", 4, [note(0, 4, 60)]), clip("c2", "t1", "s2", 1, [note(0, 1, 72)])],
    }),
  );
  seq.launchClip("c1");
  seq.play();
  // To bar 1 beat 2, past that bar's boundary and well before the next one.
  seq.block(0, FRAMES_PER_BEAT * 4.125);

  // Launched a beat and a bit into bar 1, so it is queued for the bar after it
  // — beat 8, which the pause comes before.
  seq.launchClip("c2");
  seq.block(FRAMES_PER_BEAT * 4.125, PAUSED_AT - FRAMES_PER_BEAT * 4.125);
  seq.pause();
  seq.play();

  const events = [];
  const reports = [];
  let at = PAUSED_AT;
  while (at < FRAMES_PER_BAR * 2 + 128) {
    const block = seq.block(at, 4096);
    for (const report of launchesOf(block)) reports.push({ ...report, frame: at + report.frame });
    for (const event of block) events.push({ ...event, frame: at + event.frame });
    at += 4096;
  }

  // The launch the pause interrupted is still queued for its own bar, and it
  // took effect there: nothing about where it lands was lost.
  assert.deepEqual(reports, [{ track_id: "t1", clip_id: "c2", scene_id: "s2", bar: 2, frame: FRAMES_PER_BAR * 2 }]);
  assert.deepEqual(
    events.filter((event) => event.type === "on").map((event) => [event.frame, event.p]),
    [[FRAMES_PER_BAR * 2, 72]],
  );
});

test("sequencer: seek(2.25) lands on bar 2 beat 2 in Arrangement", () => {
  const seq = sequencer(
    song({
      tracks: [track("t1")],
      scenes: [scene("s1")],
      // One note on the seek frame and one on the bar after it.
      clips: [clip("c1", "t1", "s1", 8, [note(0, 1, 60), note(9, 1, 62), note(12, 1, 64)])],
      arrangement: arrangementOf([placement("p1", "t1", "c1", 0, 8)]),
    }),
  );
  seq.setMode("arrangement");
  // A quarter of a bar is one beat: bar 2 beat 2 (0-based) is beat 9.
  seq.seek(2.25);
  seq.play();

  assert.deepEqual(brief(seq.block(0, 128)), [{ frame: 0, track_id: "t1", type: "on", p: 62 }]);
  assert.deepEqual(seq.position(), { bar: 3, beat: 2, sixteenth: 1 }, "the playhead reads 0-based bar 2, beat 2");

  // And the note the bar's first beat would have held is not played: the
  // playhead is on beat 9, a beat past it.
  assert.deepEqual(rowsOf(seq.block(128, FRAMES_PER_BEAT * 2)), [[FRAMES_PER_BEAT - 128, "t1", "off", 62]]);
});

test("sequencer: seek while playing jumps at the next block and playback continues", () => {
  const seq = sequencer(
    song({
      tracks: [track("t1")],
      scenes: [scene("s1")],
      // The first note is three beats long, so it is still sounding when the
      // seek moves the playhead out from under it.
      clips: [clip("c1", "t1", "s1", 4, [note(0, 3, 60), note(4, 1, 62), note(8, 1, 64)])],
      arrangement: arrangementOf([placement("p1", "t1", "c1", 0, 4)]),
    }),
  );
  seq.setMode("arrangement");
  seq.play();
  assert.deepEqual(brief(seq.block(0, 128)), [{ frame: 0, track_id: "t1", type: "on", p: 60 }]);
  seq.block(128, 60000 - 128); // to beat 2.5, mid-bar

  seq.seek(1); // bar 1 of the timeline: beat 4
  assert.deepEqual(rowsOf(seq.block(60000, 128)), [
    [0, "t1", "off", 60],
    [0, "t1", "on", 62],
  ]);
  assert.equal(seq.isPlaying(), true, "a seek while playing does not stop the transport");
  assert.deepEqual(seq.position(), { bar: 2, beat: 1, sixteenth: 1 });

  // Playback carries on from the seek frame, on the timeline's own grid.
  assert.deepEqual(rowsOf(seq.block(60128, FRAMES_PER_BEAT)), [[FRAMES_PER_BEAT - 128, "t1", "off", 62]]);
});

test("sequencer: seek in Session while paused does not move the paused position", () => {
  const seq = sequencer(fourBarSong());
  seq.launchClip("c1");
  seq.play();
  seq.block(0, PAUSED_AT);
  seq.pause();

  const paused = seq.position();
  seq.seek(7);
  assert.deepEqual(seq.position(), paused, "a session position is not the timeline's");

  seq.play();
  assert.deepEqual(rowsOf(seq.block(PAUSED_AT, FRAMES_PER_BAR)), [
    [0, "t1", "off", 62],
    [FRAMES_PER_BAR * 2 - PAUSED_AT, "t1", "on", 64],
  ]);
});

test("sequencer: pausedBeat is cleared by stop and by play", () => {
  const seq = sequencer(fourBarSong());
  // The second pause: beat 8.375 of the run the stop started, i.e. past the
  // bar line the clip's third note sits on.
  const secondPause = PAUSED_AT + FRAMES_PER_BAR * 2 + 9000;
  seq.launchClip("c1");
  seq.play();
  seq.block(0, PAUSED_AT);
  seq.pause();

  // A stop clears the pause: Play starts the clip at bar 1, not at the beat the
  // pause recorded.
  seq.stop();
  seq.play();
  assert.deepEqual(brief(seq.block(PAUSED_AT, 128)), [
    { frame: 0, track_id: "t1", type: "off", p: 62 },
    { frame: 0, track_id: "t1", type: "on", p: 60 },
  ]);
  seq.block(PAUSED_AT + 128, secondPause - (PAUSED_AT + 128));

  // A play clears it too: the pause that comes after the resume records the
  // beat the run has actually reached (8.375, not the 4.375 it started from),
  // so the next resume carries on from there.
  seq.pause();
  assert.deepEqual(seq.position(), { bar: 3, beat: 1, sixteenth: 2 });
  seq.play();
  const events = [];
  for (let at = secondPause; at < secondPause + FRAMES_PER_BEAT * 2; at += 128) {
    for (const event of seq.block(at, 128)) events.push({ ...event, frame: at + event.frame });
  }
  assert.deepEqual(
    events.map((event) => [event.frame, event.type, event.p]),
    [[secondPause, "off", 64]],
    "the run carries on from the resumed beat: the note that was sounding is released where it stands",
  );
  assert.deepEqual(seq.position(), { bar: 3, beat: 3, sixteenth: 2 });
});

test("sequencer: click accents stay on bar lines after seek(1.25) in Arrangement", () => {
  const seq = sequencer(
    song({
      tracks: [track("t1")],
      scenes: [scene("s1")],
      clips: [clip("c1", "t1", "s1", 8, [note(0, 1, 60), note(16, 1, 62)])],
      arrangement: arrangementOf([placement("p1", "t1", "c1", 0, 8)]),
    }),
  );
  seq.setMode("arrangement");
  // 0-based bar 1, a quarter of a bar in: timeline beat 5. A beat counted off
  // the seek rather than off the timeline would put every accent one out.
  seq.seek(1.25);
  seq.play();

  /** The click frames and accents of the run, in absolute frames. */
  const clicks = [];
  const walk = (from, to) => {
    for (let frame = from; frame < to; frame += 128) {
      seq.block(frame, 128);
      const click = seq.clickBeats(frame, 128);
      for (let at = 0; at < click.count; at += 1) {
        clicks.push({ frame: frame + click.frames[at], accent: click.accents[at] });
      }
    }
  };

  // Two bars of the seeked run, then a pause part way into the third — off the
  // beat a click sits on — and the rest of the run after it.
  const pausedAt = FRAMES_PER_BEAT * 4 + 4096; // beat 9.171 of the timeline
  walk(0, pausedAt);
  seq.pause();
  seq.play();
  walk(pausedAt, FRAMES_PER_BAR * 3);

  // One click per beat of the timeline, from the seeked beat on: frame 0 of the
  // run is beat 5, and the pause moves nothing.
  const expectedFrames = [];
  for (let beat = 5; beat < 17; beat += 1) expectedFrames.push((beat - 5) * FRAMES_PER_BEAT);
  assert.deepEqual(
    clicks.map((click) => click.frame),
    expectedFrames,
    "every beat of the seeked run clicks once, across the pause",
  );

  // And the accents are on the bars of the timeline, not on every fourth beat
  // counted from the seek: 8, 12 and 16, never 7, 11 or 15.
  assert.ok(clicks.some((click) => click.frame < pausedAt), "there are clicks before the pause");
  assert.ok(clicks.some((click) => click.frame > pausedAt), "there are clicks after the pause");
  assert.deepEqual(
    clicks.filter((click) => click.accent).map((click) => 5 + click.frame / FRAMES_PER_BEAT),
    [8, 12, 16],
    "the accents sit on the bar lines of the timeline the playhead was seeked into",
  );
});

// --- the engine --------------------------------------------------------------

/** What a case is told when this host cannot load the engine at all. */
let engineSkip = "";

/** @returns {string} why the engine cases cannot run here. */
function engineSkipReason() {
  return `no offline audio engine in this host (${engineSkip})`;
}

/** @returns {object|null} the engine's tools, or null when this host has none. */
let engineToolsPromise;
async function engineTools() {
  if (engineToolsPromise === undefined) {
    engineToolsPromise = (async () => {
      try {
        // The bundle's own dependency, resolved from inside the bundle (that is
        // where package.json declares it).
        const bundleRequire = createRequire(join(ENGINE_DIR, "x.js"));
        const { OfflineAudioContext } = bundleRequire("node-web-audio-api");
        const client = bundleRequire(join(ENGINE_DIR, "engine-client.js"));
        const { kWorkletRelease } = await import(pathToFileURL(SYMBOLS_FILE).href);
        return {
          OfflineAudioContext: OfflineAudioContext,
          client: client,
          releaseSymbol: kWorkletRelease,
          // The engine sources, read from the bundle exactly as a Node caller
          // would; engine-client falls back to the files on disk for the rest.
          assets: {
            "sequencer.js": readFileSync(join(ENGINE_DIR, "sequencer.js"), "utf8"),
            "resample.js": readFileSync(join(ENGINE_DIR, "resample.js"), "utf8"),
            "sunvox.js": readFileSync(join(VENDOR_DIR, "sunvox.js"), "utf8"),
            "studio-processor.js": readFileSync(join(ENGINE_DIR, "studio-processor.js"), "utf8"),
            "sunvox.wasm": readFileSync(join(VENDOR_DIR, "sunvox.wasm")),
          },
        };
      } catch (error) {
        engineSkip = String((error && error.message) || error);
        return null;
      }
    })();
  }
  return engineToolsPromise;
}

/** @param {BaseAudioContext} context @returns {Promise<void>} */
async function releaseWorklet(tools, context) {
  try {
    await context.audioWorklet[tools.releaseSymbol]();
  } catch {
    /* nothing to release */
  }
}

/**
 * One channel of a rendered buffer, copied into JS-owned memory. Never
 * getChannelData() in node: see renderSong in bundles/studio/server/render.js.
 * @param {AudioBuffer} buffer
 * @param {number} channel
 * @returns {Float32Array}
 */
function channelOf(buffer, channel) {
  const samples = new Float32Array(buffer.length);
  buffer.copyFromChannel(samples, channel);
  return samples;
}

/**
 * Render one song offline through the real engine and apply a transport gesture
 * part way through it.
 *
 * The gesture is asked for with the offline context's `suspend()`: rendering
 * stops at `atFrame`, `apply(engine)` posts its messages, and the render is let
 * go again. The messages are ordered, so a pause and the `play()` that follows
 * it are applied one after the other, exactly in that order.
 *
 * @param {object} tools `engineTools()`'s answer
 * @param {object} options
 * @param {object} options.song the snapshot to play
 * @param {(engine: object) => void} options.apply the gesture at the suspend
 * @param {number} options.atFrame the frame rendering stops at
 * @param {number} [options.seconds] how long the render is
 * @param {"session"|"arrangement"} [options.mode]
 * @param {number} [options.fromBar] the seek bar for `mode: "arrangement"`
 * @param {boolean} [options.metronome] turn the click on before Play
 * @param {object[]} [options.audio] one `{id, channels, rate}` per take to load
 * @returns {Promise<{left: Float32Array, right: Float32Array}>}
 */
async function renderWithGesture(
  tools,
  { song: snapshot, apply, atFrame, seconds = 2, mode = "session", fromBar = 0, metronome = false, audio = [] },
) {
  const context = new tools.OfflineAudioContext({
    numberOfChannels: 2,
    length: Math.round(seconds * SAMPLE_RATE),
    sampleRate: SAMPLE_RATE,
  });
  let engine = null;
  let rendered = false;
  try {
    engine = await tools.client.create(context, { assetBytes: tools.assets });
    for (const item of audio) {
      // A fresh copy: loadAudio transfers the buffers to the worklet.
      await engine.loadAudio(item.id, item.channels.map((channel) => Float32Array.from(channel)), item.rate);
    }
    engine.setSong(snapshot);
    if (mode === "arrangement") {
      engine.setMode("arrangement");
      engine.seek(fromBar);
    } else if (Array.isArray(snapshot.scenes) && snapshot.scenes.length > 0) {
      engine.launchScene(snapshot.scenes[0].id);
    }
    if (metronome) engine.setMetronome(true);
    engine.play();
    engine.node.connect(context.destination);

    // The gesture, at `atFrame` frames into the render.
    const gesture = context.suspend(atFrame / SAMPLE_RATE).then(async () => {
      apply(engine);
      await context.resume();
    });

    await engine.flush();
    const buffer = await context.startRendering();
    rendered = true;
    await gesture;
    return { left: channelOf(buffer, 0), right: channelOf(buffer, 1) };
  } finally {
    if (engine) engine.dispose();
    if (!rendered) await releaseWorklet(tools, context);
  }
}

/** What a click has to reach before it counts as one (its quietest peaks). */
const ONSET_THRESHOLD = 0.05;

/**
 * How long the output has to stay under the threshold before a loud sample is a
 * NEW click: longer than one cycle of the lowest click (48 frames at 1 kHz), far
 * shorter than the shortest gap between two beats.
 */
const ONSET_GAP = 800;

/** An accent's peak and a plain beat's, as the processor makes them. */
const ACCENT_PEAK = 0.5;
const PLAIN_PEAK = 0.35;

/**
 * The frames a click starts on: the first sample above the threshold after at
 * least `ONSET_GAP` frames of quiet.
 * @param {Float32Array} samples
 * @returns {number[]} absolute frame indices, in order
 */
function onsetsOf(samples) {
  const onsets = [];
  let lastLoud = -Infinity;
  for (let at = 0; at < samples.length; at += 1) {
    if (Math.abs(samples[at]) <= ONSET_THRESHOLD) continue;
    if (at - lastLoud > ONSET_GAP) onsets.push(at);
    lastLoud = at;
  }
  return onsets;
}

/** @returns {number} the largest absolute sample in [from, to). */
function peakIn(samples, from, to) {
  let peak = 0;
  const end = Math.min(samples.length, to);
  for (let at = Math.max(0, from); at < end; at += 1) {
    const value = Math.abs(samples[at]);
    if (value > peak) peak = value;
  }
  return peak;
}

test("click accents stay on bar lines after pause and resume mid-bar", async (t) => {
  const tools = await engineTools();
  if (!tools) {
    t.skip(engineSkipReason());
    return;
  }

  // An empty song: the metronome is the only thing in this render, so every
  // sound in it is a click. Rendering stops a quarter of a beat into bar 1 —
  // off every bar line and off every sixteenth — and the transport is paused
  // and started again there.
  const pausedAt = FRAMES_PER_BAR + FRAMES_PER_BEAT + 6080; // 126,080: beat 5.253
  const bars = 4;
  const { left } = await renderWithGesture(tools, {
    song: song(),
    atFrame: pausedAt,
    seconds: (FRAMES_PER_BAR * bars) / SAMPLE_RATE,
    metronome: true,
    apply: (engine) => {
      engine.pause();
      engine.play();
    },
  });

  // The click is the engine's own grid: one per quarter note, and the accent —
  // louder and higher — on every fourth one whatever the song's meter says.
  const expected = [];
  for (let beat = 0; beat < bars * 4; beat += 1) expected.push(beat * FRAMES_PER_BEAT);

  const onsets = onsetsOf(left);
  assert.deepEqual(
    onsets.filter((frame) => frame < pausedAt),
    expected.filter((frame) => frame < pausedAt),
    "the clicks before the pause sit on their beats",
  );
  // After the resume the grid has to carry on exactly where it was: a run that
  // restarted its beat counter at the resume frame would click between the
  // grid's beats from here on.
  assert.deepEqual(
    onsets.filter((frame) => frame > pausedAt),
    expected.filter((frame) => frame > pausedAt),
    "the clicks after the resume sit on the very same grid",
  );

  // And the accents are still on the bar lines: every fourth beat, louder than
  // the plain ones.
  for (const frame of expected) {
    const peak = peakIn(left, frame - 2, frame + 300);
    const want = frame % FRAMES_PER_BAR === 0 ? ACCENT_PEAK : PLAIN_PEAK;
    assert.ok(
      Math.abs(peak - want) < 0.03,
      `the click at frame ${frame} peaks at ${peak}, expected ${want} (${frame % FRAMES_PER_BAR === 0 ? "accent" : "plain"})`,
    );
  }
  assert.ok(pausedAt > expected[0] && pausedAt < expected[expected.length - 1], "the pause has to be inside the render");
});

test("an audio take resumes at the right sample offset after pause", async (t) => {
  const tools = await engineTools();
  if (!tools) {
    t.skip(engineSkipReason());
    return;
  }

  // A one-bar take that is a ramp: every frame of it has its own level, so the
  // frame a resumed voice starts on can be read straight off the render.
  const frames = FRAMES_PER_BAR;
  const samples = new Float32Array(frames);
  for (let at = 0; at < frames; at += 1) samples[at] = (at + 1) / 100000;

  const snapshot = song({
    tracks: [audioTrack("t1")],
    scenes: [scene("s1")],
    clips: [audioClip("a", "t1", "s1", 1, [{ take_id: "k1", from_beat: 0, to_beat: 4 }])],
    takes: [take("k1", "a", { frames })],
    arrangement: arrangementOf([placement("p1", "t1", "a", 0, 1)]),
  });

  const pausedAt = FRAMES_PER_BEAT * 2.5 + 32; // 60,032: beat 2.5013, mid-bar
  const { left, right } = await renderWithGesture(tools, {
    song: snapshot,
    atFrame: pausedAt,
    seconds: FRAMES_PER_BAR / SAMPLE_RATE,
    mode: "arrangement",
    audio: [{ id: "k1", channels: [samples], rate: SAMPLE_RATE }],
    apply: (engine) => {
      engine.pause();
      engine.play();
    },
  });

  // The take is laid out so that its frame `at` sounds on the transport frame
  // `at` (it was recorded at the song's tempo from beat 0): a resumed voice has
  // to pick the ramp up where the playhead stands, not start it over.
  const centre = Math.cos(Math.PI / 4); // the centre-pan coefficient at 0 dB
  for (const at of [FRAMES_PER_BEAT * 3, FRAMES_PER_BEAT * 3.5]) {
    const want = samples[at] * centre;
    assert.ok(
      Math.abs(left[at] - want) < 1e-4,
      `left frame ${at}: expected ${want.toFixed(6)} of the ramp, got ${left[at].toFixed(6)}`,
    );
    assert.ok(
      Math.abs(right[at] - want) < 1e-4,
      `right frame ${at}: expected ${want.toFixed(6)} of the ramp, got ${right[at].toFixed(6)}`,
    );
  }

  // A take restarted from its first frame would be at the ramp's beginning
  // here, which is nowhere near what the render holds.
  const restarted = samples[FRAMES_PER_BEAT * 3 - Math.round(pausedAt)];
  assert.ok(
    Math.abs(left[FRAMES_PER_BEAT * 3] - restarted * centre) > 0.1,
    "the resumed voice has to carry on into the take rather than start it again",
  );
});

// --- the count-in -------------------------------------------------------------

/**
 * The files a processor needs to exist at all: the hosts `studio-processor.js`
 * guards (the fonts, Faust, NAM, the cabinets and the master meter) are left
 * out, so a song with one audio track needs none of them — and no native audio
 * host has to load for any of these cases.
 */
const COUNT_IN_FILES = [
  "sequencer.js",
  "resample.js",
  "sampler-voice.js",
  "pad-events.js",
  "roll-clock.js",
  "perf-fx.js",
  "studio-processor.js",
];

/** The smallest valid wasm module: enough for the processor's own compile. */
const EMPTY_WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

/** The block this host hands the processor. */
const BLOCK = 128;

/** @returns {Promise<void>} a macrotask, so the compile's promise work settles */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 1));
}

/**
 * Wait for something the processor posts to arrive.
 * @param {() => boolean} predicate
 * @param {number} [ms]
 * @returns {Promise<boolean>} whether it happened in time
 */
async function waitFor(predicate, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) await settle();
  return predicate();
}

/**
 * The processor class, composed as `engine-client.js` composes it and evaluated
 * in this thread with the worklet globals it reads supplied as its parameters.
 * @returns {{cls: Function, posts: object[]}} the class and where it posts
 */
function loadCountInProcessor() {
  const source = StudioEngineModule.composeEngineModule(
    COUNT_IN_FILES.map((name) => readFileSync(join(ENGINE_DIR, name), "utf8")),
  );
  const posts = [];
  let registered = null;
  class StandInProcessor {
    constructor() {
      this.port = {
        onmessage: null,
        postMessage: (message) => posts.push(message),
        start() {},
      };
    }
  }
  const evaluate = new Function("AudioWorkletProcessor", "registerProcessor", "sampleRate", "currentFrame", source);
  evaluate(
    StandInProcessor,
    (name, cls) => {
      registered = cls;
    },
    SAMPLE_RATE,
    0,
  );
  assert.ok(registered, "the module has to register the studio processor");
  return { cls: registered, posts: posts };
}

/**
 * A take that is a ramp: every frame of it has a level of its own, so the frame
 * the song starts on can be read straight off the master.
 * @param {number} [frames]
 * @returns {Float32Array}
 */
function rampTake(frames = FRAMES_PER_BAR) {
  const samples = new Float32Array(frames);
  for (let at = 0; at < frames; at += 1) samples[at] = (at + 1) / 200000;
  return samples;
}

/** @returns {object} one audio track whose one-bar clip plays the ramp take */
function rampSong({ bpm = BPM } = {}) {
  return song({
    bpm,
    tracks: [audioTrack("t1")],
    scenes: [scene("s1")],
    clips: [audioClip("a", "t1", "s1", 1, [{ take_id: "k1", from_beat: 0, to_beat: 4 }])],
    takes: [take("k1", "a", { frames: FRAMES_PER_BAR })],
  });
}

/** @returns {number} the first frame at or after `from` that is not silence (-1 if none) */
function firstLoud(samples, from) {
  for (let at = Math.max(0, from); at < samples.length; at += 1) if (samples[at] !== 0) return at;
  return -1;
}

/**
 * The frames a count-in's clicks sit on: click `i` at `playFrame - (beats - i) *
 * fpb`, rounded once, none of them on the play frame itself.
 * @param {number} playFrame
 * @param {number} beats
 * @param {number} fpb
 * @returns {number[]}
 */
function countInGrid(playFrame, beats, fpb) {
  const frames = [];
  for (let index = 0; index < beats; index += 1) frames.push(Math.round(playFrame - (beats - index) * fpb));
  return frames;
}

/**
 * One processor holding a song, with helpers to post messages between blocks and
 * render them by hand.
 * @param {object} snapshot the song, as `doc.js` writes it
 * @param {{pcm?: boolean, metronome?: boolean}} [options]
 * @returns {Promise<object>} the host
 */
async function countInHost(snapshot, { pcm = true, metronome = false } = {}) {
  const loaded = loadCountInProcessor();
  const processor = new loaded.cls({ processorOptions: { wasmBinary: EMPTY_WASM } });
  const ready = await waitFor(() => loaded.posts.some((message) => message.type === "ready"));
  assert.ok(ready, `the processor has to come up and report ready, it posted ${JSON.stringify(loaded.posts)}`);
  const post = (message) => processor.port.onmessage({ data: message });
  post({ type: "song", snapshot: snapshot });
  if (pcm) post({ type: "audio", take_id: "k1", channels: [rampTake()] });
  if (metronome) post({ type: "metronome", on: true });
  if (Array.isArray(snapshot.scenes) && snapshot.scenes.length > 0) {
    post({ type: "launchScene", id: snapshot.scenes[0].id });
  }
  await settle();
  return {
    post: post,
    processor: processor,
    posts: loaded.posts,
    /** @param {string} type @returns {object[]} the messages of one type, in arrival order */
    of(type) {
      return loaded.posts.filter((message) => message.type === type);
    },
    /**
     * Render `blocks` blocks of 128 frames and hand back the master.
     * @param {number} blocks
     * @returns {{left: Float32Array, right: Float32Array}}
     */
    run(blocks) {
      const total = blocks * BLOCK;
      const left = new Float32Array(total);
      const right = new Float32Array(total);
      for (let index = 0; index < blocks; index += 1) {
        const start = index * BLOCK;
        processor.process([], [[left.subarray(start, start + BLOCK), right.subarray(start, start + BLOCK)]]);
      }
      return { left: left, right: right };
    },
  };
}

test("count_in: the start is announced before the first click, the clicks are on their own grid, and the song starts on the announced frame", async () => {
  const host = await countInHost(rampSong());
  host.post({ type: "play", count_in_bars: 1 });

  const started = host.of("count_in_start");
  assert.equal(started.length, 1, "the count-in is announced once");
  const playFrame = started[0].play_frame;
  // 120 bpm: one bar is 96,000 frames, which is 750 blocks of 128, so four beats
  // after the message is already a block's first frame and nothing moves it.
  assert.equal(playFrame, 4 * FRAMES_PER_BEAT, "the song starts exactly four beats after the message");
  assert.equal(playFrame % BLOCK, 0, "on a block's first frame");

  // A bar of count-in and four blocks of the song.
  const audio = host.run(750 + 4);

  const clicks = host.of("count_in");
  assert.deepEqual(clicks.map((message) => message.frame), countInGrid(playFrame, 4, FRAMES_PER_BEAT));
  assert.deepEqual(clicks.map((message) => message.frame), [0, 24000, 48000, 72000], "click i at playFrame - (4 - i) beats");
  assert.deepEqual(clicks.map((message) => message.beat), [1, 2, 3, 4], "beats are 1-based, as the page shows them");
  assert.deepEqual(clicks.map((message) => message.beats), [4, 4, 4, 4]);
  for (const click of clicks) assert.equal(click.play_frame, playFrame, "every click names the frame the song starts on");
  assert.ok(
    host.posts.indexOf(started[0]) < host.posts.indexOf(clicks[0]),
    "the play frame is announced before the first click",
  );

  const done = host.of("count_in_done");
  assert.equal(done.length, 1, "the count-in finishes once");
  assert.equal(done[0].frame, playFrame, "and it finishes on the frame it announced");

  // The song: the transport runs from the announced frame on, and the take's
  // first frame is the first sound after the count-in.
  assert.equal(host.processor.sequencer.isPlaying(), true, "the song is playing after the count-in");
  const first = firstLoud(audio.left, 72000 + 1300);
  assert.equal(first, playFrame, `the take has to begin on ${playFrame}, it began on ${first}`);
  const centre = Math.cos(Math.PI / 4);
  assert.ok(
    Math.abs(audio.left[playFrame] - (1 / 200000) * centre) < 1e-7,
    `the take's first frame should sound at ${playFrame}, it holds ${audio.left[playFrame]}`,
  );

  // The first click of the count-in is the accent, the rest are plain.
  assert.ok(Math.abs(peakIn(audio.left, 0, 64) - ACCENT_PEAK) < 0.01, "beat 1 of the count-in is louder");
  for (const frame of [24000, 48000, 72000]) {
    assert.ok(Math.abs(peakIn(audio.left, frame, frame + 64) - PLAIN_PEAK) < 0.01, `${frame} is a plain click`);
  }
});

test("count_in: the play frame is the first block start at or after the count, at a tempo whose beats miss a boundary", async () => {
  // 140 bpm: a beat is 20,571 3/7 frames, so four beats are 82,285 5/7 — the
  // first block start at or after them is 82,304, not the beat itself.
  const host = await countInHost(rampSong({ bpm: 140 }));
  host.post({ type: "play", count_in_bars: 1 });
  const playFrame = host.of("count_in_start")[0].play_frame;
  const fourBeats = Math.round(4 * ((SAMPLE_RATE * 60) / 140));
  assert.ok(playFrame >= fourBeats, `the play frame ${playFrame} has to be at or after four beats (${fourBeats})`);
  assert.equal(playFrame % BLOCK, 0, "it is a block's first frame");
  assert.ok(playFrame - fourBeats < BLOCK, "and the FIRST such frame, so no block is skipped");

  const fpb = (SAMPLE_RATE * 60) / 140;
  const expected = countInGrid(playFrame, 4, fpb);
  const audio = host.run(Math.ceil(playFrame / BLOCK) + 2);
  assert.deepEqual(host.of("count_in").map((message) => message.frame), expected, "the clicks hold the same rounding");
  assert.equal(firstLoud(audio.left, expected[3] + 1300), playFrame, "and the song starts on the frame it announced");
});

test("count_in: a paused transport counts in and then resumes at the paused position", async () => {
  // 821 blocks in: 105,088 frames, 3/8 into the second bar — off the bar, off
  // the beat and off a sixteenth, and on a block start (which every host's frame
  // counter really is).
  const pausedAt = 821 * BLOCK;
  /** @returns {Promise<object>} a host paused there, with the transport running */
  const pausedHost = async () => {
    const host = await countInHost(rampSong());
    host.post({ type: "play" });
    host.run(821);
    host.post({ type: "pause" });
    return host;
  };

  const counted = await pausedHost();
  const paused = counted.processor.sequencer.position();
  assert.equal(counted.processor.sequencer.isPlaying(), false, "the pause stopped the transport");

  counted.post({ type: "play", count_in_bars: 1 });
  const playFrame = counted.of("count_in_start")[0].play_frame;
  assert.equal(playFrame, pausedAt + FRAMES_PER_BAR, "the count-in adds one bar to the wait");

  // The whole count-in runs with the transport still paused.
  counted.run((playFrame - pausedAt) / BLOCK);
  assert.equal(counted.of("count_in_done").length, 0, "the count-in has not finished yet");
  assert.equal(counted.processor.sequencer.isPlaying(), false, "and the transport is still paused");
  assert.deepEqual(counted.processor.sequencer.position(), paused, "at the position it was paused on");

  counted.run(1);
  assert.equal(counted.of("count_in_done").length, 1, "the count-in finished on its frame");
  assert.equal(counted.of("count_in_done")[0].frame, playFrame);
  assert.equal(counted.processor.sequencer.isPlaying(), true, "and resumed the transport");

  // It resumed AT THE PAUSED POSITION, not from beat 0: the very position a
  // plain play() resumes at one block after the pause.
  const plain = await pausedHost();
  plain.post({ type: "play" });
  plain.run(1);
  assert.deepEqual(
    counted.processor.sequencer.position(),
    plain.processor.sequencer.position(),
    "a count-in on a paused transport resumes it exactly as play() does",
  );
  assert.notDeepEqual(counted.processor.sequencer.position(), { bar: 1, beat: 1, sixteenth: 1 }, "it did not restart");
});

test("count_in: stop during the count-in leaves the sequencer stopped and starts no further click", async () => {
  const host = await countInHost(rampSong());
  host.post({ type: "play", count_in_bars: 1 });
  const playFrame = host.of("count_in_start")[0].play_frame;
  host.run(10);
  assert.equal(host.of("count_in").length, 1, "the first click has rung");

  host.post({ type: "stop" });
  // Past the frame the song would have started on, so a count-in that survived
  // the stop would show itself here.
  const audio = host.run(playFrame / BLOCK + 4);

  assert.equal(host.of("count_in_done").length, 0, "a cancelled count-in never starts the song");
  assert.equal(host.of("count_in").length, 1, "and starts no further click");
  assert.equal(host.processor.sequencer.isPlaying(), false, "the sequencer is stopped");
  assert.deepEqual(host.processor.sequencer.position(), { bar: 1, beat: 1, sixteenth: 1 }, "at 1.1.1");
  assert.equal(peakIn(audio.left, 0, audio.left.length), 0, "the click that rang finished and nothing follows it");
});

test("count_in: cancelCountIn from a paused transport leaves it paused at the same position", async () => {
  const pausedAt = 821 * BLOCK;
  const host = await countInHost(rampSong());
  host.post({ type: "play" });
  host.run(821);
  host.post({ type: "pause" });
  const paused = host.processor.sequencer.position();

  // Two bars, so the count-in runs long enough to be cancelled in.
  host.post({ type: "play", count_in_bars: 2 });
  const playFrame = host.of("count_in_start")[0].play_frame;
  assert.equal(playFrame, pausedAt + 2 * FRAMES_PER_BAR, "two bars after the pause");
  host.run(10);
  host.post({ type: "count_in_cancel" });
  const audio = host.run((playFrame - pausedAt - 10 * BLOCK) / BLOCK + 4);

  assert.equal(host.of("count_in_done").length, 0, "a cancelled count-in never starts the song");
  assert.equal(host.of("count_in").length, 1, "and starts no further click");
  assert.equal(host.processor.sequencer.isPlaying(), false, "the transport is left paused");
  assert.deepEqual(host.processor.sequencer.position(), paused, "at the very position it was paused on");
  assert.equal(peakIn(audio.left, 0, audio.left.length), 0, "the ringing click finished and nothing follows it");
});

test("count_in: a second play during the count-in changes nothing", async () => {
  const host = await countInHost(rampSong());
  host.post({ type: "play", count_in_bars: 1 });
  host.run(10);
  const playFrame = host.of("count_in_start")[0].play_frame;

  // A different count-in length, and a plain Play: neither restarts nor
  // short-cuts the count-in that is running.
  host.post({ type: "play", count_in_bars: 2 });
  host.post({ type: "play" });
  const audio = host.run((playFrame - 10 * BLOCK) / BLOCK + 4);

  assert.equal(host.of("count_in_start").length, 1, "a count-in in progress is not restarted");
  assert.equal(host.of("count_in_start")[0].play_frame, playFrame, "the frame it announced still stands");
  assert.deepEqual(
    host.of("count_in").map((message) => message.frame),
    [0, 24000, 48000, 72000],
    "one bar of clicks, exactly as asked",
  );
  assert.equal(host.of("count_in_done").length, 1, "and one finish");
  assert.equal(host.of("count_in_done")[0].frame, playFrame);
  const base = 10 * BLOCK;
  const first = firstLoud(audio.left, 72000 + 1300 - base);
  assert.equal(first < 0 ? -1 : first + base, playFrame, "the song starts where the first count-in said it would");
  // One launch report, on the play frame: the second play queued nothing.
  assert.deepEqual(
    host.of("launched").map((message) => message.frame),
    [playFrame],
    "the scene the page launched is applied once, on the play frame",
  );
});

test("count_in: a tempo change during the count-in leaves the click spacing and moves the song's grid", async () => {
  // An empty song: the count-in and the metronome are the only sound.
  const host = await countInHost(song(), { pcm: false, metronome: true });
  host.post({ type: "play", count_in_bars: 1 });
  const playFrame = host.of("count_in_start")[0].play_frame;
  const beforeEdit = host.run(188); // to frame 24,064: the first click has rung, the second is in
  // Half the tempo, asked for in the middle of the count-in.
  host.post({ type: "song", snapshot: song({ bpm: 60 }) });

  // Two bars of the song after it starts, at the new tempo (one beat is 48,000).
  const afterEdit = host.run(playFrame / BLOCK - 188 + (2 * FRAMES_PER_BAR) / BLOCK);
  // The two runs end to end are one render: the frames in the onsets below are
  // the processor's own.
  const whole = new Float32Array(beforeEdit.left.length + afterEdit.left.length);
  whole.set(beforeEdit.left, 0);
  whole.set(afterEdit.left, beforeEdit.left.length);

  // The count-in keeps the spacing it started with: one click per old beat.
  assert.deepEqual(
    host.of("count_in").map((message) => message.frame),
    [0, 24000, 48000, 72000],
    "a tempo edit does not move a click the count-in already had",
  );
  assert.equal(host.of("count_in_done")[0].frame, playFrame, "and the song still starts on the announced frame");

  // From the downbeat the song runs on the NEW tempo: the metronome's own click
  // is one beat (48,000 frames) apart from there on.
  assert.deepEqual(onsetsOf(whole), [0, 24000, 48000, 72000, 96000, 144000, 192000, 240000]);
  // The engine's bars are four beats, so the downbeat is the accent and the
  // three beats after it are plain — one bar of the song at the new tempo.
  assert.ok(
    Math.abs(peakIn(whole, 96000, 96000 + 64) - ACCENT_PEAK) < 0.01,
    "the downbeat is the accent of the bar at the new tempo",
  );
  for (const frame of [144000, 192000, 240000]) {
    assert.ok(Math.abs(peakIn(whole, frame, frame + 64) - PLAIN_PEAK) < 0.01, `${frame} is a plain beat at 60 bpm`);
  }
});

test("count_in: play without a count-in is today's Play, with no count-in at all", async () => {
  /** @param {object} options @returns {Promise<object>} a host that has played */
  const played = async (options) => {
    const host = await countInHost(rampSong());
    host.post({ type: "play", ...options });
    return host;
  };

  const plain = await played({});
  const plainAudio = plain.run(8);
  // Off, explicitly, and a length the options row does not offer: both are the
  // plain Play, untouched.
  const off = await played({ count_in_bars: 0 });
  const offAudio = off.run(8);
  const other = await played({ count_in_bars: 3 });
  const otherAudio = other.run(8);

  for (const host of [plain, off, other]) {
    assert.deepEqual(host.of("count_in_start"), [], "no count-in is announced");
    assert.deepEqual(host.of("count_in"), [], "no click is counted in");
    assert.deepEqual(host.of("count_in_done"), [], "and nothing reports a count-in finishing");
    assert.equal(host.processor.sequencer.isPlaying(), true, "the transport starts at once");
    assert.equal(host.of("launched")[0].frame, 0, "the launch applies on the first block");
  }
  assert.deepEqual(Array.from(offAudio.left), Array.from(plainAudio.left), "an explicit 0 renders the plain Play");
  assert.deepEqual(Array.from(otherAudio.left), Array.from(plainAudio.left), "and so does a length the row omits");
  assert.notEqual(plainAudio.left[0], 0, "the song's take starts on the first frame, as it always did");
});