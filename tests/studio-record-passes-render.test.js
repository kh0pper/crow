/**
 * Studio — where a looped recording's three passes sound in a real render.
 *
 * No browser and no fakes around the render: `renderSong()` runs the bundle's own
 * engine inside `node-web-audio-api`'s OfflineAudioContext, exactly as the studio
 * render tests and the MCP render tool do, and the takes are handed to it through
 * `takeAudio` as the decoded PCM the storage rail would answer with.
 *
 * The song is three passes of a one-bar loop at 240 bpm, where a bar is 48,000
 * frames. A pass starts at bar k's own frame (0, 48,000, 96,000), and each pass's
 * take is a one-bar audio clip placed on that bar, comped over the clip's four
 * beats — which is what makes its take start on the pass's beat 0. A click is
 * eight frames at full scale on silence.
 *
 * The takes are the ones a loop recording leaves behind: take 0 was cut at the arm
 * frame, so its click sits 1,200 frames into the file and it stores those 1,200 as
 * its offset; passes 1 and 2 were cut on split frames that already carry the round
 * trip, so their clicks sit at their file's first frame and they store 0. Playing
 * each take from its stored offset is what puts every click on its pass's beat 0.
 *
 * The negative control is the same takes with the values the panel stored before
 * the fix (1,200 on takes 1 and 2), plus the mirror image of that mistake: a take
 * whose file still carries the delay and reports 0.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSong } from "../bundles/studio/server/render.js";

/** The render's rate. */
const SAMPLE_RATE = 48000;

/** The song's tempo: 12,000 frames a beat, so every bar is a whole number of frames. */
const BPM = 240;

/** One beat at this rate and tempo. */
const FRAMES_PER_BEAT = (SAMPLE_RATE * 60) / BPM;

/** The beats in one loop pass: four, a bar. */
const BEATS_PER_PASS = 4;

/** One loop pass in frames: 48,000. */
const PASS_FRAMES = FRAMES_PER_BEAT * BEATS_PER_PASS;

/** The passes the song plays, one take each. */
const PASSES = 3;

/** The calibrated round trip every take of this recording was cut by, in frames. */
const ROUND_TRIP = 1200;

/** How long a click is: eight frames at full scale on silence. */
const CLICK_FRAMES = 8;

/** How long each take's file is; long enough to hold a click at frame 0, or at 1,200. */
const TAKE_FRAMES = 2400;

/** What counts as loud: the takes are silence and full scale, and nothing else plays. */
const LOUD = 1e-3;

/** The track every pass plays on, and the scene the clips belong to. */
const TRACK_ID = "audio-1";
const SCENE = "scene-1";

/** One take id per pass, in pass order. */
const TAKE_IDS = ["take-pass-0", "take-pass-1", "take-pass-2"];

/**
 * The offsets and click positions this recording leaves behind: take 0's file
 * holds the round trip in front of its beat, the passes after it hold none.
 */
const RECORDED = { offsets: [ROUND_TRIP, 0, 0], leads: [ROUND_TRIP, 0, 0] };

/**
 * One take's PCM: silence with a click `lead` frames in, on both channels.
 * @param {number} lead the frame the click starts at
 * @returns {Float32Array[]} two channels of `TAKE_FRAMES` frames
 */
function clickTake(lead) {
  const left = new Float32Array(TAKE_FRAMES);
  left.fill(1, lead, lead + CLICK_FRAMES);
  // Separate arrays: the engine takes ownership of the ones it is handed.
  return [left, Float32Array.from(left)];
}

/**
 * The three-pass song: one one-bar audio clip per pass, comped over that clip's
 * four beats and placed on that pass's bar.
 *
 * A take's frames are measured from its own clip's beat 0 — `startAudio` reads
 * `round(clipBeat * framesPerBeat) + offset_frames` — so one clip's comp cannot
 * play three different takes across three loop passes: it would read take 1 four
 * beats into a file that holds one. Three clips, one per pass, are the same three
 * passes with each take read from its own beat 0.
 * @param {number[]} offsets one take's `offset_frames` per pass
 * @returns {object} a snapshot, shaped the way the hub hands one to a render
 */
function passesSong(offsets) {
  const clips = {};
  const placements = {};
  const takes = {};
  TAKE_IDS.forEach((takeId, pass) => {
    const clipId = `clip-pass-${pass}`;
    takes[takeId] = {
      id: takeId,
      clip_id: clipId,
      storage_key: `projects/7/studio/song-1/takes/${takeId}.wav`,
      rate: SAMPLE_RATE,
      channels: 2,
      frames: TAKE_FRAMES,
      offset_frames: offsets[pass],
      compensated: true,
      bpm: BPM,
      recorded_at: "2026-11-03T12:00:00.000Z",
      author_label: "the operator",
      discarded: false,
    };
    clips[clipId] = {
      id: clipId,
      track_id: TRACK_ID,
      scene_id: SCENE,
      name: `Pass ${pass + 1}`,
      length_bars: 1,
      kind: "audio",
      notes: [],
      comp: [{ take_id: takeId, from_beat: 0, to_beat: BEATS_PER_PASS }],
    };
    placements[`place-${pass}`] = {
      id: `place-${pass}`,
      clip_id: clipId,
      track_id: TRACK_ID,
      start_bar: pass,
      bars: 1,
      offset_beats: 0,
      fade_in_beats: 0,
      fade_out_beats: 0,
    };
  });
  return {
    meta: { title: "Loop passes", bpm: BPM, meter: [4, 4], key: "C major" },
    tracks: [
      {
        id: TRACK_ID,
        name: "Guitar",
        color: "#8FC1E8",
        device: { engine: "audio" },
        mute: false,
        solo: false,
        gain_db: 0,
        pan: 0,
        locked: false,
      },
    ],
    scenes: [{ id: SCENE, name: "A" }],
    clips,
    takes,
    arrangement: { placements, markers: {}, sections: {} },
  };
}

/**
 * Render the three passes with the takes given.
 * @param {{offsets?: number[], leads?: number[]}} [options] what each pass stores
 *   as its offset, and where the click sits in its file
 * @returns {Promise<{left: Float32Array, right: Float32Array, seconds: number}>}
 */
async function renderPasses({ offsets = RECORDED.offsets, leads = RECORDED.leads } = {}) {
  const rendered = await renderSong(passesSong(offsets), {
    mode: "arrangement",
    from_bar: 0,
    seconds: (PASSES * PASS_FRAMES) / SAMPLE_RATE,
    takeAudio: async (take) => {
      const pass = TAKE_IDS.indexOf(take.id);
      assert.notEqual(pass, -1, `the render asked for a take this song does not hold: ${take.id}`);
      return { rate: SAMPLE_RATE, channels: clickTake(leads[pass]) };
    },
  });
  assert.deepEqual(rendered.missing_samples, [], "nothing the render plays is missing");
  return rendered;
}

/**
 * @param {Float32Array} channel
 * @param {number} from the first frame of the window
 * @param {number} to the frame it stops at (exclusive)
 * @returns {number} the first frame in the window that is louder than silence, or
 *   -1 when the whole window is silent
 */
function firstLoud(channel, from, to) {
  const start = Math.max(0, Math.trunc(from));
  const end = Math.min(channel.length, Math.trunc(to));
  for (let at = start; at < end; at += 1) {
    if (Math.abs(channel[at]) > LOUD) return at;
  }
  return -1;
}

/**
 * @param {number} pass
 * @returns {number} the frame that pass's beat 0 lands on
 */
function passStart(pass) {
  return pass * PASS_FRAMES;
}

test("every loop pass's click sounds on its pass's beat 0 in a real offline render", async () => {
  const rendered = await renderPasses();
  assert.equal(rendered.seconds, 3, "three passes at 240 bpm are three seconds of audio");
  assert.equal(rendered.left.length, PASSES * PASS_FRAMES, "and hold three passes' frames");

  for (let pass = 0; pass < PASSES; pass += 1) {
    const start = passStart(pass);
    const end = start + PASS_FRAMES;
    for (const channel of ["left", "right"]) {
      const onset = firstLoud(rendered[channel], start, end);
      assert.notEqual(onset, -1, `pass ${pass} sounds at all in the ${channel} channel`);
      assert.ok(
        Math.abs(onset - start) <= 1,
        `pass ${pass}: its beat 0 is frame ${start} of the render, but its click sounded on `
          + `${onset} (${onset - start} frames off) in the ${channel} channel`,
      );
    }
  }
});

test("the offsets the panel stored before the fix put a later pass's click off its beat", async () => {
  const correct = await renderPasses();

  // The same takes, with the value the panel stored for every pass before the fix:
  // 1,200 on takes 1 and 2 as well, whose files already start on their own beat.
  const old = await renderPasses({ offsets: [ROUND_TRIP, ROUND_TRIP, ROUND_TRIP] });

  // Pass 0 is the pass that really does hold those frames in front of its beat, so
  // the old values were right for it and it is untouched.
  assert.ok(
    Math.abs(firstLoud(old.left, passStart(0), passStart(1)) - passStart(0)) <= 1,
    "pass 0 still sounds on its beat, because its take is the one cut with the delay in front of it",
  );

  for (const pass of [1, 2]) {
    const start = passStart(pass);
    const end = start + PASS_FRAMES;
    assert.ok(
      Math.abs(firstLoud(correct.left, start, end) - start) <= 1,
      `pass ${pass} sounds on its beat 0 with the offsets the fix stores`,
    );
    // The take is read from frame 1,200, and its click sits at frame 0: the click
    // is not heard 1,200 frames late, it is cut away, so the pass has no click of
    // its own left in it.
    assert.equal(
      firstLoud(old.left, start, end),
      -1,
      `pass ${pass}'s click is gone: its take is read from frame ${ROUND_TRIP} while the click is at frame 0`,
    );
  }

  // The mirror image of the same mistake, and the shape that does sound 1,200
  // frames late: a take whose file still carries the round trip in front of its
  // beat, played with a stored offset of 0.
  const carried = await renderPasses({ offsets: [ROUND_TRIP, 0, 0], leads: [ROUND_TRIP, ROUND_TRIP, ROUND_TRIP] });
  for (const pass of [1, 2]) {
    const start = passStart(pass);
    const onset = firstLoud(carried.left, start, start + PASS_FRAMES);
    assert.ok(
      Math.abs(onset - (start + ROUND_TRIP)) <= 1,
      `pass ${pass}: its beat 0 is frame ${start}, and its click carries ${ROUND_TRIP} frames of `
        + `delay, so it belongs on ${start + ROUND_TRIP}; it sounded on ${onset}`,
    );
  }
});