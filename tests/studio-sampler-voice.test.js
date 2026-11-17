/**
 * Studio sampler voices on their own — a loop, a ping-pong, a speed and a
 * direction.
 *
 * `sampler-voice.js` is pure arithmetic, so it is tested here in plain Node with
 * no web audio at all: a voice is started by hand, `render()` is asked for a run
 * of frames, and the frames are read back. Every sample is a ramp or a constant,
 * so a test can name the exact sample frame a given output frame has to read.
 *
 * It is a classic script, so it is loaded the way a Node caller loads it:
 * `require()` from inside the bundle, where `engine/package.json` marks the
 * directory CommonJS.
 *
 * A voice at pan 0 and gain 0 dB, at velocity 127 and at envelope level 1,
 * lands one sample as `sample × centre`, where centre is the constant-power
 * coefficient `√2 · cos(π/4)`; the helper below spells that out so an exact
 * comparison is readable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ENGINE_DIR = fileURLToPath(new URL("../bundles/studio/engine/", import.meta.url));
const bundleRequire = createRequire(join(ENGINE_DIR, "x.js"));
const StudioSamplerVoice = bundleRequire(join(ENGINE_DIR, "sampler-voice.js"));

const SAMPLE_RATE = 48000;

/** The centre-pan coefficient: a voice at pan 0 with gain 0 dB plays at this level. */
const CENTRE = Math.SQRT2 * Math.cos(Math.PI / 4);

/** @param {number} frames @returns {Float32Array} 1e-5, 2e-5, … so a frame names itself */
function ramp(frames) {
  const samples = new Float32Array(frames);
  for (let at = 0; at < frames; at += 1) samples[at] = (at + 1) / 100000;
  return samples;
}

/** @param {number} frames @param {number} value @returns {Float32Array} a constant */
function constant(frames, value) {
  const samples = new Float32Array(frames);
  samples.fill(value);
  return samples;
}

/**
 * Start one voice with everything a test does not care about at its default:
 * one channel, full velocity, unity gain, centre pan, no envelope (level 1), no
 * filter.
 * @param {object} settings the start settings this test does care about
 * @returns {object} the started voice
 */
function startVoice(settings) {
  const voice = StudioSamplerVoice.create();
  const started = StudioSamplerVoice.start(voice, {
    sampleRate: SAMPLE_RATE,
    velocity: 127,
    gainDb: 0,
    pan: 0,
    ...settings,
  });
  assert.equal(started, true, "the voice has to start");
  return voice;
}

/**
 * Render one voice into a fresh pair of channels, at the mix's unity gain.
 * @param {object} voice
 * @param {number} frames
 * @returns {{left: Float32Array, right: Float32Array}}
 */
function render(voice, frames) {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  StudioSamplerVoice.render(voice, frames, left, right, 0, 1, 1);
  return { left, right };
}

/** @param {number} sample @returns {number} one sample frame as the mix would hold it. */
function atCentre(sample) {
  return Math.fround(sample * CENTRE);
}

/** @param {number} value @param {string} what @returns {void} */
function assertNear(value, expected, what) {
  assert.ok(
    Math.abs(value - expected) < 1e-9,
    `${what}: expected ${expected}, got ${value}`,
  );
}

/** @param {number} from @param {number} to @returns {number[]} from .. to-1 */
function countTo(from, to) {
  const list = [];
  for (let value = from; value < to; value += 1) list.push(value);
  return list;
}

/**
 * The sample frames a plain loop reads: its range forwards, and backwards for a
 * reversed voice (which starts on the range's last frame and wraps at its
 * start).
 * @param {number} size frames in the range
 * @param {number} frames how many output frames
 * @param {boolean} reversed
 * @returns {number[]}
 */
function loopReads(size, frames, reversed) {
  const reads = [];
  for (let at = 0; at < frames; at += 1) {
    const step = at % size;
    reads.push(reversed ? size - 1 - step : step);
  }
  return reads;
}

/**
 * The sample frames a ping-pong voice reads, worked out in whole frames from the
 * behaviour it has to have: it runs to the far end, turns there, comes back, and
 * turns again on the frame it would have left the range on (so the two ends are
 * read once each, never twice).
 * @param {number} size frames in the range
 * @param {number} frames how many output frames
 * @param {number} from the frame it starts on
 * @param {number} direction +1 forwards, -1 backwards
 * @returns {number[]}
 */
function pingPongReads(size, frames, from, direction) {
  const reads = [];
  let position = from;
  let step = direction;
  for (let at = 0; at < frames; at += 1) {
    reads.push(position);
    position += step;
    if (position >= size) {
      position = 2 * (size - 1) - position;
      step = -1;
    } else if (position < 0) {
      position = -position;
      step = 1;
    }
  }
  return reads;
}

// --- the loop ---------------------------------------------------------------

test("a forward loop plays its range and starts again", () => {
  const samples = ramp(100);
  const voice = startVoice({ channels: [samples], loop: "loop" });
  assert.equal(voice.loop === "loop", true, "the voice keeps the loop it was started with");
  assert.equal(voice.looping, true, "a voice started with a loop says it is looping");

  const { left } = render(voice, 300);
  const reads = loopReads(100, 300, false);
  for (let at = 0; at < 300; at += 1) {
    assert.equal(left[at], atCentre(samples[reads[at]]), `frame ${at} has to read sample ${reads[at]}`);
  }

  // No seam at the wrap: inside one pass through the ramp the only jump between
  // two frames is the ramp's own step, plus the float32 rounding of each frame
  // (a frame is stored as a float32, so the difference can miss the exact step by
  // a ten-thousandth of it). The frame that starts a new pass jumps back down to
  // the ramp's first sample by design, so it is left out.
  const step = 1e-5 * CENTRE * 1.0001;
  for (let at = 1; at < 300; at += 1) {
    if (at % 100 === 0) continue;
    assert.ok(
      Math.abs(left[at] - left[at - 1]) <= step,
      `frames ${at - 1} and ${at} jump by more than the ramp's own step: ${left[at - 1]} then ${left[at]}`,
    );
  }
  assert.equal(voice.sounding, true, "a loop is still sounding at the end of the render");
});

test("a ping-pong turns at both ends", () => {
  const samples = ramp(100);
  const voice = startVoice({ channels: [samples], loop: "pingpong" });
  const { left } = render(voice, 400);

  const reads = pingPongReads(100, 400, 0, 1);
  assert.deepEqual(reads.slice(0, 100), countTo(0, 100), "the first pass is the range forwards");
  assert.deepEqual(reads.slice(100, 199), countTo(0, 99).reverse(), "then it comes back, without reading 99 twice");
  assert.deepEqual(reads.slice(199, 298), countTo(1, 100), "and turns again at the bottom");
  assert.deepEqual(reads.slice(298, 397), countTo(0, 99).reverse(), "and comes back once more, down to the bottom frame again");

  for (let at = 0; at < 400; at += 1) {
    assert.equal(left[at], atCentre(samples[reads[at]]), `frame ${at} has to read sample ${reads[at]}`);
  }
  assert.equal(voice.dir, 1, "an even number of turns leaves the voice pointing forwards");
  assert.equal(voice.sounding, true, "a ping-pong is still sounding at the end of the render");
});

test("reverse plus loop runs backwards and wraps", () => {
  const samples = ramp(100);
  const voice = startVoice({ channels: [samples], reverse: true, loop: "loop" });
  assert.equal(voice.dir, -1, "a reversed voice starts backwards");

  const { left } = render(voice, 300);
  const reads = loopReads(100, 300, true);
  assert.equal(reads[0], 99, "a reversed voice starts on the range's last frame");
  assert.equal(reads[100], 99, "and wraps back to it after the range's first frame");
  for (let at = 0; at < 300; at += 1) {
    assert.equal(left[at], atCentre(samples[reads[at]]), `frame ${at} has to read sample ${reads[at]}`);
  }
});

test("reverse plus ping-pong starts backwards and turns", () => {
  const samples = ramp(100);
  const voice = startVoice({ channels: [samples], reverse: true, loop: "pingpong" });

  const { left } = render(voice, 400);
  const reads = pingPongReads(100, 400, 99, -1);
  assert.deepEqual(reads.slice(0, 100), countTo(0, 100).reverse(), "the first pass runs backwards");
  assert.deepEqual(reads.slice(100, 199), countTo(1, 100), "then it turns at the start and comes back up");
  for (let at = 0; at < 400; at += 1) {
    assert.equal(left[at], atCentre(samples[reads[at]]), `frame ${at} has to read sample ${reads[at]}`);
  }
});

// --- ending a loop ----------------------------------------------------------

test("a looping voice still sounds after ten times its length and ends on release", () => {
  const samples = ramp(5000);
  const voice = startVoice({ channels: [samples], loop: "loop", releaseMs: 5 });
  const { left } = render(voice, 50000);

  assert.equal(voice.sounding, true, "a loop has no end of its own");
  assert.equal(left[49999], atCentre(samples[4999]), "ten passes in, it is still reading its range");

  StudioSamplerVoice.release(voice);
  assert.equal(voice.looping, false, "a release ends the loop");
  const tail = render(voice, 240);
  assert.equal(voice.sounding, false, "a 5 ms release ends the voice inside its release time");
  assert.equal(tail.left[239], 0, "nothing is left sounding after the release time");
});

test("beginFadeOut clears looping and fades the voice out", () => {
  const samples = ramp(1000);
  const voice = startVoice({ channels: [samples], loop: "loop" });
  const { left } = render(voice, 100);

  StudioSamplerVoice.beginFadeOut(voice);
  assert.equal(voice.looping, false, "a fade ends the loop");
  assert.equal(voice.fadeRemaining, StudioSamplerVoice.FADE_FRAMES, "the fade is the 64-frame one");

  const tail = render(voice, StudioSamplerVoice.FADE_FRAMES);
  assert.equal(tail.left[0], atCentre(samples[100]), "the fade starts at the level the voice had");
  assert.equal(voice.sounding, false, "64 frames of fade end the voice");
  assert.equal(left[99], atCentre(samples[99]), "the frames before the fade are untouched");
});

test("a looping voice whose sustain is 0 ends when its decay reaches level 0", () => {
  // 10 ms of decay at 48 kHz is 480 frames: the decay is all the voice has.
  const DECAY = 480;
  const samples = constant(4800, 0.5);
  const voice = startVoice({ channels: [samples], loop: "loop", decayMs: 10, sustain: 0 });

  const { left } = render(voice, 2000);
  assert.equal(left[0], atCentre(0.5), "the voice starts at full level");
  assert.ok(left[DECAY - 1] > 0, `the decay has to be audible on its last frame, got ${left[DECAY - 1]}`);
  for (let at = DECAY; at < 2000; at += 1) {
    assert.equal(left[at], 0, `frame ${at} is past the decay and has to be silent`);
  }
  assert.equal(voice.sounding, false, "a looping voice at level 0 ends instead of living on silent");
  assert.equal(voice.looping, false, "and it is not left marked as looping");
});

test("a looping voice with a sustain of 0.5 keeps looping", () => {
  const samples = constant(4800, 0.5);
  const voice = startVoice({ channels: [samples], loop: "loop", decayMs: 10, sustain: 0.5 });

  const { left } = render(voice, 2000);
  assert.equal(voice.sounding, true, "a sustain above 0 has something to hold");
  assertNear(left[1999], 0.5 * 0.5 * CENTRE, "and it holds its sustain level past the decay");
});

test("a loop shorter than two frames runs out instead of spinning", () => {
  const samples = ramp(4);
  const voice = startVoice({ channels: [samples], start: 0, end: 1, loop: "loop" });

  const { left } = render(voice, 200);
  assert.equal(left[0], atCentre(samples[0]), "the one frame in the range is played");
  // The range runs out on frame 1 and the held sample fades over the next 64
  // frames (the first one at full level, the last at a 64th), so silence starts
  // on the frame after the fade.
  for (let at = StudioSamplerVoice.FADE_FRAMES + 1; at < 200; at += 1) {
    assert.equal(left[at], 0, `frame ${at} is past the range and has to be silent`);
  }
  assert.equal(voice.sounding, false, "a range with no room to turn in ends like an unlooped one");

  // A range with no frames at all cannot start in the first place.
  const empty = StudioSamplerVoice.create();
  assert.equal(
    StudioSamplerVoice.start(empty, {
      channels: [samples],
      sampleRate: SAMPLE_RATE,
      start: 2,
      end: 2,
      loop: "loop",
    }),
    false,
    "an empty range has nothing to loop",
  );
});

// --- speed ------------------------------------------------------------------

test("speed 2 reads two frames per output frame", () => {
  const samples = ramp(2000);
  const voice = startVoice({ channels: [samples], speed: 2 });
  assert.equal(voice.step, 2, "a speed of 2 doubles the step");

  const { left } = render(voice, 1000);
  for (const at of [0, 1, 2, 100, 500, 999]) {
    assert.equal(left[at], atCentre(samples[at * 2]), `frame ${at} has to read sample ${at * 2}`);
  }
});

test("speed 0.5 reads half a frame per output frame", () => {
  const samples = ramp(2000);
  const voice = startVoice({ channels: [samples], speed: 0.5 });
  assert.equal(voice.step, 0.5, "a speed of 0.5 halves the step");

  const { left } = render(voice, 1000);
  // Even frames land on a sample, odd ones half way between two of them.
  for (const at of [0, 2, 100, 500]) {
    assert.equal(left[at], atCentre(samples[at / 2]), `frame ${at} has to read sample ${at / 2}`);
  }
  for (const at of [1, 3, 101, 501]) {
    const low = samples[(at - 1) / 2];
    const high = samples[(at + 1) / 2];
    assert.equal(
      left[at],
      Math.fround((low + (high - low) * 0.5) * CENTRE),
      `frame ${at} has to sit half way between samples ${(at - 1) / 2} and ${(at + 1) / 2}`,
    );
  }
});

test("refreshStep works the step out from dir, speed and pitch", () => {
  const voice = StudioSamplerVoice.create();
  const cases = [
    { dir: 1, speed: 1, pitch: 0 },
    { dir: -1, speed: 1, pitch: 0 },
    { dir: 1, speed: 2, pitch: 12 },
    { dir: -1, speed: 0.5, pitch: -12 },
    { dir: 1, speed: 1.5, pitch: 7 },
    { dir: -1, speed: 1, pitch: -3 },
  ];
  for (const item of cases) {
    voice.dir = item.dir;
    voice.speed = item.speed;
    voice.pitch_semis = item.pitch;
    StudioSamplerVoice.refreshStep(voice);
    assert.equal(
      voice.step,
      item.dir * item.speed * Math.pow(2, item.pitch / 12),
      `dir ${item.dir}, speed ${item.speed}, pitch ${item.pitch} has to give dir × speed × 2^(pitch/12)`,
    );
  }

  // A start keeps the three of them apart, and works the step out from them.
  const started = startVoice({ channels: [ramp(100)], speed: 2, pitch: 12, reverse: true });
  assert.equal(started.speed, 2, "the voice keeps its speed");
  assert.equal(started.pitch_semis, 12, "the pitch is kept in semitones");
  assert.equal(started.dir, -1, "the initial reverse sign is the direction");
  assert.equal(started.reverse, true, "the reverse flag is kept as it was");
  assert.equal(started.step, -1 * 2 * Math.pow(2, 12 / 12), "the step is the product of the three");

  // And none of the new settings leaves every default in place.
  const plain = startVoice({ channels: [ramp(100)] });
  assert.equal(plain.loop, "off", "Loop is off by default");
  assert.equal(plain.looping, false, "and a voice with no loop is not looping");
  assert.equal(plain.speed, 1, "speed is 1 by default");
  assert.equal(plain.pitch_semis, 0, "the pitch is 0 by default");
  assert.equal(plain.step, 1, "so the step is exactly one frame per frame");
});

// --- the same output as before ----------------------------------------------

test("a start with none of the new settings renders exactly as it did", () => {
  // A pad with every envelope and mix field in use but none of the new settings:
  // its frames are the ones the voice produced before loops and speeds existed,
  // taken from that code.
  const samples = ramp(4000);
  const voice = startVoice({
    channels: [samples],
    start: 0,
    end: 4000,
    pitch: 3,
    gainDb: -3,
    velocity: 100,
    pan: 0.2,
    attackMs: 2,
    decayMs: 4,
    sustain: 0.7,
    releaseMs: 10,
  });

  const left = new Float32Array(1000);
  const right = new Float32Array(1000);
  StudioSamplerVoice.render(voice, 1000, left, right, 0, 0.8, 0.6);

  assert.deepEqual(
    Array.from(left.subarray(0, 16)),
    [
      0,
      6.656284057271478e-8,
      2.0544135281852505e-7,
      4.166355722645676e-7,
      7.001454491728509e-7,
      0.0000010559710972302128,
      0.0000014841122037978494,
      0.0000019845692804665305,
      0.0000025573417588020675,
      0.0000032024299798649736,
      0.000003919833943655249,
      0.000004709554104920244,
      0.000005571589099417906,
      0.000006505940291390289,
      0.000007512606771342689,
      0.00000859158990351716,
    ],
    "the attack's first frames have to be the ones the voice always played",
  );
  assert.equal(left[100], 0.0003483933978714049, "frame 100 of the left channel");
  assert.equal(left[500], 0.0012169467518106103, "frame 500 of the left channel");
  assert.equal(left[999], 0.0024294203612953424, "frame 999 of the left channel");
  assert.equal(right[100], 0.00035964176640845835, "frame 100 of the right channel");
  assert.equal(right[500], 0.0012562376214191318, "frame 500 of the right channel");
  assert.equal(right[999], 0.0025078575126826763, "frame 999 of the right channel");

  let sumLeft = 0;
  let sumRight = 0;
  for (let at = 0; at < 1000; at += 1) {
    sumLeft += left[at];
    sumRight += right[at];
  }
  assert.equal(sumLeft, 1.2314224223151697, "the whole left channel, frame for frame");
  assert.equal(sumRight, 1.2711806677155124, "the whole right channel, frame for frame");
  assert.equal(voice.sounding, true, "a voice whose range has not run out is still sounding");
});