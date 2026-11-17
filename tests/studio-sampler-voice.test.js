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
 *
 * The one test at the end that asks about the PROCESSOR — an attack, decay or
 * sustain motion lane landing on a voice that is in its hold — builds the
 * worklet module itself from the engine's own sources (the way
 * `engine-client.js` joins them) and instantiates the processor in a stand-in
 * `AudioWorkletGlobalScope`, so it needs the vendored SunVox wasm file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ENGINE_DIR = fileURLToPath(new URL("../bundles/studio/engine/", import.meta.url));
const VENDOR_DIR = fileURLToPath(new URL("../bundles/studio/vendor/sunvox/", import.meta.url));
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

// --- the hold stage ---------------------------------------------------------

test("holdMs 10 at 48 kHz holds level 1 for 480 frames after the attack", () => {
  const ATTACK = 240; // 5 ms at 48 kHz
  const HOLD = 480; // 10 ms at 48 kHz
  const DECAY = 480; // 10 ms at 48 kHz
  const HELD = atCentre(0.5);
  const samples = constant(48000, 0.5);
  const voice = startVoice({
    channels: [samples],
    attackMs: 5,
    holdMs: 10,
    decayMs: 10,
    sustain: 0.5,
  });
  assert.equal(voice.holdFrames, HOLD, "a 10 ms hold is 480 frames at 48 kHz");

  // Walk the attack frame by frame: 5 ms at 48 kHz is 240 frames, and the level
  // is summed one frame at a time, so it can arrive on the frame after that.
  const attack = [];
  while (voice.stage !== StudioSamplerVoice.STAGE_HOLD) {
    attack.push(render(voice, 1).left[0]);
    assert.ok(attack.length <= ATTACK + 2, "a 5 ms attack has to arrive at level 1 in its own time");
  }
  assert.equal(attack[0], 0, "the attack comes first, as it always did: it starts from silence");
  assert.ok(attack[1] > 0 && attack[1] < HELD, "and it climbs from there");
  assert.equal(voice.stage, StudioSamplerVoice.STAGE_HOLD, "the attack ends in the hold, not in the decay");
  assert.equal(voice.holdFrames, HOLD, "the whole hold is still to run");

  const hold = render(voice, HOLD);
  for (let at = 0; at < HOLD; at += 1) {
    assert.equal(hold.left[at], HELD, `frame ${at} of the hold has to sit at level 1`);
  }
  assert.notEqual(voice.stage, StudioSamplerVoice.STAGE_HOLD, "the hold is over");
  assert.equal(voice.holdFrames, 0, "with no hold left to run");
  // The frame the hold ends on is the decay's own first frame, so it is already
  // one step down: the level was 1 for exactly the hold's 480 frames.
  const after = render(voice, 1);
  assert.equal(
    after.left[0],
    Math.fround(0.5 * (1 - (1 - voice.sustain) / DECAY) * CENTRE),
    "the frame after the hold is the decay's first step down",
  );

  render(voice, DECAY);
  assert.equal(voice.level, 0.5, "the decay settles at the pad's own sustain after the hold");
  assert.notEqual(voice.stage, StudioSamplerVoice.STAGE_HOLD, "and the hold is behind it");
});

test("holdMs 0 output is identical to a voice started without the setting", () => {
  const samples = ramp(4000);
  const settings = {
    channels: [samples],
    pitch: 3,
    gainDb: -3,
    velocity: 100,
    pan: 0.2,
    attackMs: 2,
    decayMs: 4,
    sustain: 0.7,
    releaseMs: 10,
  };
  const absent = startVoice({ ...settings });
  const zero = startVoice({ ...settings, holdMs: 0 });
  assert.equal(absent.holdFrames, 0, "a voice started without the setting has no hold");
  assert.equal(zero.holdFrames, 0, "a hold of 0 frames is no hold at all");
  assert.equal(zero.stage, absent.stage, "so the two of them start in the same stage");

  const first = render(absent, 2000);
  const second = render(zero, 2000);
  assert.deepEqual(Array.from(second.left), Array.from(first.left), "the left channel, frame for frame");
  assert.deepEqual(Array.from(second.right), Array.from(first.right), "the right channel, frame for frame");
  assert.equal(zero.stage, absent.stage, "and they end the render in the same stage");
  assert.equal(zero.level, absent.level, "at the same level");
});

test("a gate countdown that ends during HOLD goes straight to release", () => {
  const GATE = 720; // 15 ms: 240 frames into a hold that starts after a 10 ms attack
  const RELEASE = 480; // 10 ms at 48 kHz
  const samples = constant(48000, 0.5);
  const voice = startVoice({
    channels: [samples],
    mode: "gate",
    attackMs: 10,
    holdMs: 10,
    decayMs: 10,
    sustain: 0,
    releaseMs: 10,
    gateFrames: GATE,
  });

  render(voice, GATE);
  assert.equal(voice.stage, StudioSamplerVoice.STAGE_HOLD, "the gate is still open while the voice holds");
  assert.equal(voice.gateRemaining, 0, "and it is on its last frame");

  render(voice, 1);
  assert.equal(
    voice.stage,
    StudioSamplerVoice.STAGE_RELEASE,
    "a gate that ends in a hold releases from it instead of running its decay",
  );
  assertNear(voice.level, 1 - 1 / RELEASE, "the release starts from the hold's own level, one frame in");

  const tail = render(voice, RELEASE + 1);
  assert.equal(voice.sounding, false, "the release ends the voice, a hold's length before a decay would have");
  assert.ok(
    Math.abs(tail.left[RELEASE - 1]) < 1e-12,
    `the release's last frame is all but silent, got ${tail.left[RELEASE - 1]}`,
  );
  assert.equal(tail.left[RELEASE], 0, "and nothing is left sounding after it");
});

test("STAGE_HOLD is 5 and differs from the processor's stage numbers", () => {
  assert.equal(StudioSamplerVoice.STAGE_HOLD, 5, "the hold is a stage of its own, after the four the voice had");
  assert.equal(StudioSamplerVoice.STAGE_RELEASE, 3, "so the release stage stays where it was");
  assert.notEqual(StudioSamplerVoice.STAGE_HOLD, StudioSamplerVoice.STAGE_RELEASE);

  // The processor keeps its own copy of the three numbers it reads: motion
  // applies an envelope time to the stage a voice is in. Those numbers must not
  // move with this one, or a voice in a hold would look like one in an attack,
  // a decay or a sustain to that code.
  const source = readFileSync(join(ENGINE_DIR, "studio-processor.js"), "utf8");
  for (const [name, value] of [
    ["STAGE_ATTACK", 0],
    ["STAGE_DECAY", 1],
    ["STAGE_SUSTAIN", 2],
  ]) {
    assert.ok(source.includes(`const ${name} = ${value};`), `the processor's ${name} has to stay ${value}`);
  }

  const held = startVoice({ channels: [ramp(1000)], attackMs: 0, holdMs: 10, decayMs: 10 });
  assert.equal(held.stage, StudioSamplerVoice.STAGE_HOLD, "a voice with a hold and no attack starts in it");
  for (const number of [0, 1, 2]) {
    assert.notEqual(held.stage, number, `a voice in a hold is in none of the processor's stages (${number})`);
  }
});

// --- a live reverse flip ----------------------------------------------------

test("flipReverse mid-play continues from the same position in the other direction with no jump larger than one step", () => {
  const samples = ramp(4000);
  const voice = startVoice({ channels: [samples] });
  const forward = render(voice, 100);
  assert.equal(voice.position, 100, "the voice stands on the frame it will read next");
  const step = voice.step;

  StudioSamplerVoice.flipReverse(voice);
  assert.equal(voice.dir, -1, "the flip turns the voice round");
  assert.equal(voice.position, 100, "and leaves the position where it was");
  assert.equal(voice.step, -step, "the step is worked out again from the new direction");

  const backward = render(voice, 3);
  assert.equal(backward.left[0], atCentre(samples[100]), "the first frame after the flip is the one it was about to read");
  assert.equal(backward.left[1], atCentre(samples[99]), "then the one before it");
  assert.equal(backward.left[2], atCentre(samples[98]), "and on backwards");

  // No jump: the frame the flip lands on is one sample further along the ramp
  // than the frame before it was — the ramp's own step, not a cut elsewhere.
  assert.ok(
    Math.abs(backward.left[0] - forward.left[99]) <= 1e-5 * CENTRE * 1.0001,
    `the flip may move the read by one sample and no more: ${forward.left[99]} then ${backward.left[0]}`,
  );

  // A voice that is not looping ends at the edge it now heads for: the range's
  // first frame is its last read, and the held sample fades over 64 frames.
  const rest = render(voice, 400);
  assert.equal(rest.left[0], atCentre(samples[97]), "it keeps walking back down the range");
  assert.equal(rest.left[97], atCentre(samples[0]), "and reads the range's first frame last");
  for (let at = 200; at < 400; at += 1) {
    assert.equal(rest.left[at], 0, `frame ${at} is past the edge and has to be silent`);
  }
  assert.equal(voice.sounding, false, "a flipped one-shot ends at the edge it now runs toward");
});

test("a flipped looping voice wraps at the start", () => {
  const samples = ramp(100);
  const voice = startVoice({ channels: [samples], loop: "loop" });
  render(voice, 10);
  assert.equal(voice.position, 10, "the voice stands on the frame it will read next");

  StudioSamplerVoice.flipReverse(voice);
  const { left } = render(voice, 250);
  for (let at = 0; at < 250; at += 1) {
    const read = (((10 - at) % 100) + 100) % 100;
    assert.equal(left[at], atCentre(samples[read]), `frame ${at} has to read sample ${read}`);
  }
  assert.equal(left[11], atCentre(samples[99]), "the frame past the range's start wraps to its last frame");
  assert.equal(voice.dir, -1, "the voice is still running backwards");
  assert.equal(voice.looping, true, "and it is still a loop");
  assert.equal(voice.sounding, true, "so it never runs out of its range");
});

test("flipping twice restores the original direction", () => {
  const samples = ramp(4000);
  const settings = { channels: [samples], loop: "pingpong", speed: 1.5, pitch: 7 };
  const plain = startVoice({ ...settings });
  const flipped = startVoice({ ...settings });
  const first = render(plain, 50);
  const second = render(flipped, 50);
  assert.deepEqual(Array.from(second.left), Array.from(first.left), "the two voices start out reading the same frames");

  const step = flipped.step;
  StudioSamplerVoice.flipReverse(flipped);
  assert.equal(flipped.step, -step, "one flip turns the step round");
  StudioSamplerVoice.flipReverse(flipped);
  assert.equal(flipped.dir, plain.dir, "and the second turns it back");
  assert.equal(flipped.step, step, "so the step is the product it started with");

  const plainTail = render(plain, 400);
  const flippedTail = render(flipped, 400);
  assert.deepEqual(Array.from(flippedTail.left), Array.from(plainTail.left), "and the frames after them are the same");

  const reversed = startVoice({ channels: [samples], reverse: true });
  StudioSamplerVoice.flipReverse(reversed);
  StudioSamplerVoice.flipReverse(reversed);
  assert.equal(reversed.dir, -1, "a voice that started reversed is backwards again after two flips");
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

// --- a motion lane on a voice in its hold ------------------------------------

/**
 * The worklet module a host composes: the sources a processor needs to exist at
 * all, joined the way `engine-client.js` joins its `SOURCE_FILES`. The modules
 * this test does not go near — the SoundFont, Faust, NAM and cabinet hosts —
 * are optional, and the processor guards every use of one.
 */
const PROCESSOR_MODULE = ["sequencer.js", "sampler-voice.js", "perf-fx.js", "studio-processor.js"]
  .map((name) => readFileSync(join(ENGINE_DIR, name), "utf8"))
  .join("\n;\n");

/**
 * One Studio processor in a stand-in AudioWorkletGlobalScope: a `sampleRate`, a
 * `port`, and the wasm binary it compiles on start. The scope comes back with
 * it, so a test can start a voice with the very `StudioSamplerVoice` the
 * processor calls.
 * @returns {Promise<{processor: object, scope: object}>}
 */
async function createProcessor() {
  const vm = await import("node:vm");
  let Processor = null;
  let announce = null;
  const ready = new Promise((resolve) => {
    announce = resolve;
  });
  const scope = {
    sampleRate: SAMPLE_RATE,
    currentFrame: 0,
    WebAssembly,
    console: { log() {}, warn() {}, error() {} },
    AudioWorkletProcessor: class {
      constructor() {
        this.port = {
          postMessage: (message) => {
            if (message && message.type === "ready") announce();
          },
          onmessage: null,
        };
      }
    },
    registerProcessor: (name, registered) => {
      Processor = registered;
    },
  };
  vm.createContext(scope);
  vm.runInContext(PROCESSOR_MODULE, scope, { filename: "studio-engine.js" });
  const processor = new Processor({
    processorOptions: { wasmBinary: new Uint8Array(readFileSync(join(VENDOR_DIR, "sunvox.wasm"))) },
  });
  await ready;
  return { processor, scope };
}

test("an attack, decay or sustain motion lane applied while a voice is in HOLD does not throw and does not change the stage", async () => {
  const { processor, scope } = await createProcessor();
  const voice = scope.StudioSamplerVoice.create();
  scope.StudioSamplerVoice.start(voice, {
    channels: [constant(48000, 0.5)],
    sampleRate: SAMPLE_RATE,
    attackMs: 0,
    holdMs: 50,
    decayMs: 10,
    sustain: 0.5,
  });
  assert.equal(voice.stage, scope.StudioSamplerVoice.STAGE_HOLD, "the voice sits in its hold");

  for (const [param, value] of [
    ["attack_ms", 40],
    ["decay_ms", 40],
    ["sustain", 0.25],
  ]) {
    assert.doesNotThrow(
      () => processor.applyMotionValue(voice, param, value),
      `${param} has to apply to a voice in a hold without a fault`,
    );
    assert.equal(voice.stage, scope.StudioSamplerVoice.STAGE_HOLD, `${param} must not move a voice out of its hold`);
    assert.doesNotThrow(
      () => processor.restoreMotionParam(voice, param),
      `${param} has to be given back without a fault`,
    );
    assert.equal(
      voice.stage,
      scope.StudioSamplerVoice.STAGE_HOLD,
      `giving ${param} back must not move the stage either`,
    );
  }
  assert.equal(voice.holdFrames, 2400, "the hold still has its 50 ms of frames to run");
  assert.equal(voice.level, 1, "and it still holds the level at 1");
});