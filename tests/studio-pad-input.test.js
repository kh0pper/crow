/**
 * Studio pads — the pure input rules (`panel/pad-input.js`).
 *
 * Every case drives the very string the page inlines: the emitted classic
 * script is evaluated with `new Function`, the way the page's own `<script>` tag
 * runs it, and the module's named exports are the same evaluation, so a case can
 * check the two against each other.
 *
 * What they pin: the inline-script rules, a linear curve at unity gain being the
 * identity, a threshold refusing the readings below it, exp bending the middle
 * down and log bending it up while both meet linear at the ends, a fixed curve
 * ignoring the reading, an answer that is always a legal velocity, chromatic pads
 * walking a scale and its octaves from the key root inside two octaves, the 16
 * velocity grid rising once per pad from 8 to 127, and a pressure probe that
 * only calls a press real when the device reported two different readings.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SENSE,
  PAD_COUNT,
  PAD_INPUT_SCRIPT,
  PressureProbe,
  SCALES,
  SCALE_NAMES,
  chromaticPitch,
  curveVelocity,
  velocityLevel,
} from "../bundles/studio/panel/pad-input.js";

/** The page's copy: the very text the handler inlines, run as the page runs it. */
function pageApi() {
  return new Function("window", `${PAD_INPUT_SCRIPT}\nreturn window.StudioPadInput;`)({});
}

/** The identity sensitivity: linear, no threshold, unity gain. */
const LINEAR = { curve: "linear", threshold: 0, gain: 1 };

/** A velocity a fit can play, or 0 for a press that does not play. */
function isLegalVelocity(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 127;
}

test("the emitted script follows the panel's inline rules and exposes one global", () => {
  assert.equal(PAD_INPUT_SCRIPT.includes("\u0060"), false, "no backtick: the panel rule");
  assert.equal(PAD_INPUT_SCRIPT.includes("$" + "{"), false, "no template interpolation");
  assert.equal(PAD_INPUT_SCRIPT.includes('"'), false, "no double quote in the emitted text");
  assert.equal(PAD_INPUT_SCRIPT.includes("\\"), false, "no backslash in the emitted text");
  assert.equal(PAD_INPUT_SCRIPT.includes("</script"), false, "it cannot close its own tag");
  assert.doesNotThrow(() => new Function("window", PAD_INPUT_SCRIPT), "it parses as a classic script");

  const page = pageApi();
  assert.equal(typeof page.curveVelocity, "function", "the page gets the velocity curve");
  assert.equal(typeof page.chromaticPitch, "function", "and the chromatic pitches");
  assert.equal(typeof page.velocityLevel, "function", "and the velocity grid");
  assert.equal(typeof page.PressureProbe, "function", "and the pressure probe");
  assert.deepEqual(page.DEFAULT_SENSE, DEFAULT_SENSE, "the starting sensitivity travels");
  assert.deepEqual(page.SCALES, SCALES, "with the scale table");
  assert.deepEqual(page.SCALE_NAMES, SCALE_NAMES, "and the names a picker offers");
  assert.equal(page.PAD_COUNT, PAD_COUNT, "and the pad count");

  // The identity defaults, and the scales the plan names, degree for degree.
  assert.deepEqual(DEFAULT_SENSE, { curve: "linear", threshold: 0, gain: 1 });
  assert.deepEqual(SCALE_NAMES, [
    "major", "minor", "dorian", "phrygian", "pentatonic_major", "pentatonic_minor",
  ]);
  assert.deepEqual(SCALES.major, [0, 2, 4, 5, 7, 9, 11]);
  assert.deepEqual(SCALES.minor, [0, 2, 3, 5, 7, 8, 10]);
  assert.deepEqual(SCALES.dorian, [0, 2, 3, 5, 7, 9, 10]);
  assert.deepEqual(SCALES.phrygian, [0, 1, 3, 5, 7, 8, 10]);
  assert.deepEqual(SCALES.pentatonic_major, [0, 2, 4, 7, 9]);
  assert.deepEqual(SCALES.pentatonic_minor, [0, 3, 5, 7, 10]);
  assert.equal(PAD_COUNT, 16, "a bank is sixteen pads");
});

test("linear gain 1 is the identity", () => {
  const page = pageApi();
  for (let reading = 1; reading <= 127; reading += 1) {
    assert.equal(curveVelocity(reading, LINEAR), reading, `reading ${reading} plays as itself`);
    assert.equal(page.curveVelocity(reading, LINEAR), reading, `the page agrees at ${reading}`);
  }
  // The default sensitivity is that curve, and a missing one reads as it.
  assert.equal(curveVelocity(64, DEFAULT_SENSE), 64);
  assert.equal(curveVelocity(64), 64, "no sense at all is the default");
  assert.equal(curveVelocity(64, { curve: "bogus", threshold: "x", gain: NaN }), 64,
    "a spoiled sense falls back to the identity");
});

test("a threshold refuses the readings below it", () => {
  const sense = { curve: "linear", threshold: 20, gain: 1 };
  assert.equal(curveVelocity(0, sense), 0, "no reading plays nothing");
  assert.equal(curveVelocity(1, sense), 0, "a reading under the threshold plays nothing");
  assert.equal(curveVelocity(19, sense), 0, "19 is under 20");
  assert.equal(curveVelocity(20, sense), 20, "20 is the first reading that plays");
  assert.equal(curveVelocity(127, sense), 127, "and the top is untouched");
  // The fixed curve ignores the reading, so the threshold has nothing to gate.
  assert.equal(curveVelocity(3, { curve: "fixed", threshold: 20, gain: 1 }), 100);
});

test("exp is below linear in the middle and equal at 1 and 127", () => {
  const exp = { curve: "exp", threshold: 0, gain: 1 };
  assert.equal(curveVelocity(1, exp), 1, "the two curves meet at the bottom");
  assert.equal(curveVelocity(127, exp), 127, "and at the top");
  assert.ok(curveVelocity(64, exp) < 64, "a middle reading plays softer on exp");
  for (let reading = 2; reading < 127; reading += 1) {
    assert.ok(curveVelocity(reading, exp) <= reading, `exp never exceeds linear at ${reading}`);
  }
});

test("log is above linear in the middle", () => {
  const log = { curve: "log", threshold: 0, gain: 1 };
  assert.equal(curveVelocity(1, log), 1, "the two curves meet at the bottom");
  assert.equal(curveVelocity(127, log), 127, "and at the top");
  assert.ok(curveVelocity(64, log) > 64, "a middle reading plays louder on log");
  for (let reading = 2; reading < 127; reading += 1) {
    assert.ok(curveVelocity(reading, log) >= reading, `log never falls below linear at ${reading}`);
  }
});

test("fixed ignores the reading", () => {
  const fixed = { curve: "fixed", threshold: 0, gain: 1 };
  const seen = new Set();
  for (let reading = 0; reading <= 127; reading += 1) seen.add(curveVelocity(reading, fixed));
  assert.deepEqual([...seen], [100], "every reading plays the fixed velocity");
  assert.equal(curveVelocity(127, { curve: "fixed", threshold: 0, gain: 0.25 }), 25, "gain 0.25 is 25");
  assert.equal(curveVelocity(1, { curve: "fixed", threshold: 0, gain: 4 }), 127, "gain 4 clamps at 127");
});

test("the answer is always an integer in 1..127 or 0", () => {
  const curves = ["linear", "exp", "log", "fixed"];
  const thresholds = [0, 20, 126, -5, 500, NaN, "x"];
  const gains = [0.25, 0.5, 1, 2, 4, 0, 100, NaN, "x"];
  const readings = [
    0, 1, 2, 19, 20, 63, 64, 126, 127, 128, -1, 0.5, 64.4,
    NaN, Infinity, -Infinity, undefined, null, "abc", "", "60", {}, [], true,
  ];
  const page = pageApi();
  for (const curve of curves) {
    for (const threshold of thresholds) {
      for (const gain of gains) {
        for (const reading of readings) {
          const sense = { curve, threshold, gain };
          const value = curveVelocity(reading, sense);
          const label = `${curve} threshold ${String(threshold)} gain ${String(gain)} reading ${String(reading)}`;
          assert.ok(isLegalVelocity(value), `${label}: ${String(value)} is a legal velocity`);
          assert.equal(page.curveVelocity(reading, sense), value, `${label}: the page agrees`);
        }
      }
    }
  }
  // A missing or non-object sense is the default, not a crash.
  for (const sense of [undefined, null, "linear", 7, [], true]) {
    assert.ok(isLegalVelocity(curveVelocity(64, sense)), `sense ${String(sense)} still answers a velocity`);
  }
});

test("garbage input returns a legal value", () => {
  assert.equal(curveVelocity(NaN, LINEAR), 0, "NaN is no reading");
  assert.equal(curveVelocity(undefined, LINEAR), 0, "so is the missing argument");
  assert.equal(curveVelocity("abc", LINEAR), 0, "and a string that is not a number");
  assert.equal(curveVelocity(Infinity, LINEAR), 0, "an infinity is no reading either");
  for (const reading of [NaN, undefined, null, "abc", {}, [], Infinity, -Infinity]) {
    assert.ok(isLegalVelocity(curveVelocity(reading, LINEAR)), `${String(reading)} still answers lawfully`);
  }
});

test("chromaticPitch walks C major and clamps at the top", () => {
  const page = pageApi();
  const pitches = [];
  for (let index = 0; index < PAD_COUNT; index += 1) pitches.push(chromaticPitch(index, "major", 0));
  assert.deepEqual(pitches, [0, 2, 4, 5, 7, 9, 11, 12, 14, 16, 17, 19, 21, 23, 24, 24],
    "sixteen pads walk two octaves of C major and the last pad clamps at 24");
  for (let index = 0; index < PAD_COUNT; index += 1) {
    assert.equal(page.chromaticPitch(index, "major", 0), pitches[index], `the page agrees on pad ${index}`);
  }
  // The first pad is the key root, and every pad is one of the scale's pitches.
  for (const name of SCALE_NAMES) {
    const degrees = SCALES[name];
    assert.equal(chromaticPitch(0, name, 0), 0, `${name}: the first pad is the root`);
    for (let index = 0; index < PAD_COUNT; index += 1) {
      const pitch = chromaticPitch(index, name, 0);
      assert.ok(Number.isInteger(pitch) && pitch >= -24 && pitch <= 24, `${name} pad ${index} is in range`);
      assert.ok(degrees.includes(((pitch % 12) + 12) % 12), `${name} pad ${index} is on the scale`);
    }
  }
  assert.equal(chromaticPitch(0, "no_such_scale", 0), 0, "an unknown scale reads as major");
});

test("key 7 shifts by 7 and the last pads clamp at 24", () => {
  const shifted = [];
  for (let index = 0; index < PAD_COUNT; index += 1) shifted.push(chromaticPitch(index, "major", 7));
  assert.deepEqual(shifted, [7, 9, 11, 12, 14, 16, 18, 19, 21, 23, 24, 24, 24, 24, 24, 24],
    "the key root adds to every pad, and the top pads clamp at 24");
  assert.equal(chromaticPitch(0, "major", 7), 7, "the first pad is the key");
  assert.equal(chromaticPitch(3, "major", 7), chromaticPitch(3, "major", 0) + 7, "a shift is a shift");
  assert.equal(chromaticPitch(15, "pentatonic_minor", 11), 24, "the clamp holds for every scale");
});

test("velocityLevel is 16 distinct strictly increasing integers from 8 to 127", () => {
  const levels = [];
  for (let index = 0; index < PAD_COUNT; index += 1) levels.push(velocityLevel(index));
  assert.equal(levels.length, 16, "one level per pad");
  assert.equal(levels[0], 8, "the softest pad plays at 8");
  assert.equal(levels[15], 127, "the loudest pad plays at 127");
  assert.equal(new Set(levels).size, 16, "no two pads share a level");
  for (let at = 0; at < levels.length; at += 1) {
    assert.ok(Number.isInteger(levels[at]), `pad ${at} is a whole velocity`);
    if (at > 0) assert.ok(levels[at] > levels[at - 1], `pad ${at} plays louder than pad ${at - 1}`);
  }
});

test("the pressure probe only calls two different readings real", () => {
  const page = pageApi();

  const flatHalf = new page.PressureProbe();
  flatHalf.observe(0.5);
  flatHalf.observe(0.5);
  flatHalf.observe(0.5);
  assert.equal(flatHalf.isReal(), false, "a constant 0.5 is no pressure at all");

  const flatOne = new page.PressureProbe();
  flatOne.observe(1.0);
  flatOne.observe(1.0);
  assert.equal(flatOne.isReal(), false, "neither is a constant 1.0");

  const alone = new page.PressureProbe();
  assert.equal(alone.isReal(), false, "a press that has reported nothing is not real");
  alone.observe(0.4);
  assert.equal(alone.isReal(), false, "and one reading is not two");

  const real = new page.PressureProbe();
  real.observe(0.3);
  assert.equal(real.isReal(), false, "the first reading decides nothing");
  real.observe(0.6);
  assert.equal(real.isReal(), true, "a second, different reading is real pressure");

  const back = new page.PressureProbe();
  back.observe(0.3);
  back.observe(0.6);
  back.observe(0.3);
  assert.equal(back.isReal(), true, "and it stays real within the press");

  back.reset();
  assert.equal(back.isReal(), false, "reset forgets the press");
  back.observe(0.6);
  back.observe(0.6);
  assert.equal(back.isReal(), false, "so the next press starts over at one value");

  const noisy = new PressureProbe();
  noisy.observe(NaN);
  noisy.observe(undefined);
  noisy.observe("abc");
  assert.equal(noisy.isReal(), false, "readings that are not numbers are ignored");
  noisy.observe(0.2);
  assert.equal(noisy.isReal(), false, "and they never count as the first reading");
  noisy.observe(0.8);
  assert.equal(noisy.isReal(), true, "two real readings still make the press real");
});