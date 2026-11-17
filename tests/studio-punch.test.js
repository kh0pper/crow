/**
 * Studio punch — the punch rules (`panel/punch.js`).
 *
 * Every case drives the very string the page inlines: the emitted classic script
 * is evaluated with `new Function`, the way the page's own `<script>` tag runs
 * it, and the module's named exports are the same evaluation, so a case can
 * check the two against each other.
 *
 * What they pin: the inline-script rules, one comp splice that replaces a range
 * and keeps everything around it (the one the comp drag and a landed punch both
 * use), a comp comparison with a 1e-9 tolerance, a punch range that has to be
 * whole beats inside the clip, and the frames a pass's gate opens and closes on
 * — moved by the input delay on every pass, rounded once per end.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COMP_EPSILON,
  PUNCH_SCRIPT,
  passGateRanges,
  sameComp,
  spliceComp,
  validRange,
} from "../bundles/studio/panel/punch.js";

/** The page's copy: the very text the handler inlines, run as the page runs it. */
function pageApi() {
  return new Function("window", `${PUNCH_SCRIPT}\nreturn window.StudioPunch;`)({});
}

test("the script has no backtick, dollar-brace, double quote or backslash", () => {
  assert.equal(PUNCH_SCRIPT.includes("\u0060"), false, "no backtick: the panel rule");
  assert.equal(PUNCH_SCRIPT.includes("$" + "{"), false, "no template interpolation");
  assert.equal(PUNCH_SCRIPT.includes('"'), false, "no double quote in the emitted text");
  assert.equal(PUNCH_SCRIPT.includes("\\"), false, "no backslash in the emitted text");
  assert.equal(PUNCH_SCRIPT.includes("</script"), false, "it cannot close its own tag");
  assert.doesNotThrow(() => new Function("window", PUNCH_SCRIPT), "it parses as a classic script");
});

test("the emitted script follows the panel's inline rules and exposes one global", () => {
  assert.equal(PUNCH_SCRIPT.includes("\u0060"), false, "no backtick: the panel rule");
  assert.equal(PUNCH_SCRIPT.includes("$" + "{"), false, "no template interpolation");
  assert.equal(PUNCH_SCRIPT.includes('"'), false, "no double quote in the emitted text");
  assert.equal(PUNCH_SCRIPT.includes("\\"), false, "no backslash in the emitted text");
  assert.equal(PUNCH_SCRIPT.includes("</script"), false, "it cannot close its own tag");
  assert.doesNotThrow(() => new Function("window", PUNCH_SCRIPT), "it parses as a classic script");

  const page = pageApi();
  assert.equal(typeof page.spliceComp, "function", "the page gets the one comp splice");
  assert.equal(typeof page.sameComp, "function", "and the comp comparison");
  assert.equal(typeof page.validRange, "function", "and the range rule");
  assert.equal(typeof page.passGateRanges, "function", "and the gate frames");
  assert.equal(page.COMP_EPSILON, COMP_EPSILON, "the tolerance travels");
  assert.equal(COMP_EPSILON, 1e-9, "a comp is compared to a billionth of a beat");
});

test("spliceComp over empty comp gives one segment", () => {
  const page = pageApi();
  const comp = spliceComp([], "take1", 4, 8, 16);
  assert.deepEqual(comp, [{ take_id: "take1", from_beat: 4, to_beat: 8 }],
    "a clip with no comp gets the range as its whole comp");
  assert.deepEqual(page.spliceComp([], "take1", 4, 8, 16), comp, "the page agrees");
  assert.deepEqual(spliceComp([], "take1", 0, 16, 16),
    [{ take_id: "take1", from_beat: 0, to_beat: 16 }],
    "a range over the whole clip is one segment edge to edge");
});

test("inside one segment splits it in three and keeps the outer pieces", () => {
  const page = pageApi();
  const comp = spliceComp([{ take_id: "a", from_beat: 0, to_beat: 16 }], "b", 4, 8, 16);
  assert.deepEqual(comp, [
    { take_id: "a", from_beat: 0, to_beat: 4 },
    { take_id: "b", from_beat: 4, to_beat: 8 },
    { take_id: "a", from_beat: 8, to_beat: 16 },
  ], "the punched take sits between the two outer pieces of the old one");
  assert.deepEqual(page.spliceComp([{ take_id: "a", from_beat: 0, to_beat: 16 }], "b", 4, 8, 16),
    comp, "the page agrees");

  const head = spliceComp([{ take_id: "a", from_beat: 0, to_beat: 16 }], "b", 0, 4, 16);
  assert.deepEqual(head, [
    { take_id: "b", from_beat: 0, to_beat: 4 },
    { take_id: "a", from_beat: 4, to_beat: 16 },
  ], "a range at the clip's start keeps the rest of the old take");

  const tail = spliceComp([{ take_id: "a", from_beat: 0, to_beat: 16 }], "b", 12, 16, 16);
  assert.deepEqual(tail, [
    { take_id: "a", from_beat: 0, to_beat: 12 },
    { take_id: "b", from_beat: 12, to_beat: 16 },
  ], "and a range at its end keeps what came before");
});

test("across two segments trims both", () => {
  const page = pageApi();
  const before = [
    { take_id: "a", from_beat: 0, to_beat: 8 },
    { take_id: "b", from_beat: 8, to_beat: 16 },
  ];
  const comp = spliceComp(before, "c", 4, 12, 16);
  assert.deepEqual(comp, [
    { take_id: "a", from_beat: 0, to_beat: 4 },
    { take_id: "c", from_beat: 4, to_beat: 12 },
    { take_id: "b", from_beat: 12, to_beat: 16 },
  ], "the range cuts the first take's end and the second take's start");
  assert.deepEqual(page.spliceComp(before, "c", 4, 12, 16), comp, "the page agrees");
  assert.deepEqual(before, [
    { take_id: "a", from_beat: 0, to_beat: 8 },
    { take_id: "b", from_beat: 8, to_beat: 16 },
  ], "the comp it was given is left as it was");
});

test("covering the whole clip gives one segment", () => {
  const page = pageApi();
  const before = [
    { take_id: "a", from_beat: 0, to_beat: 8 },
    { take_id: "b", from_beat: 8, to_beat: 16 },
  ];
  const comp = spliceComp(before, "c", 0, 16, 16);
  assert.deepEqual(comp, [{ take_id: "c", from_beat: 0, to_beat: 16 }],
    "nothing of the old comp is left outside the range");
  assert.deepEqual(page.spliceComp(before, "c", 0, 16, 16), comp, "the page agrees");
  assert.deepEqual(spliceComp([
    { take_id: "a", from_beat: 2, to_beat: 6 },
    { take_id: "b", from_beat: 6, to_beat: 14 },
  ], "c", 0, 16, 16), [{ take_id: "c", from_beat: 0, to_beat: 16 }],
  "a range holding every piece of the old comp leaves exactly itself");
});

test("merges touching segments of the same take", () => {
  const page = pageApi();
  const before = [
    { take_id: "a", from_beat: 0, to_beat: 4 },
    { take_id: "a", from_beat: 4, to_beat: 8 },
    { take_id: "b", from_beat: 8, to_beat: 16 },
  ];
  const comp = spliceComp(before, "a", 4, 8, 16);
  assert.deepEqual(comp, [
    { take_id: "a", from_beat: 0, to_beat: 8 },
    { take_id: "b", from_beat: 8, to_beat: 16 },
  ], "two touching pieces of one take become one, and the neighbour stays");
  assert.deepEqual(page.spliceComp(before, "a", 4, 8, 16), comp, "the page agrees");

  const middle = spliceComp([
    { take_id: "b", from_beat: 0, to_beat: 4 },
    { take_id: "a", from_beat: 4, to_beat: 8 },
    { take_id: "b", from_beat: 8, to_beat: 12 },
  ], "b", 4, 8, 16);
  assert.deepEqual(middle, [{ take_id: "b", from_beat: 0, to_beat: 12 }],
    "a range that joins two pieces of the same take leaves one");

  const apart = spliceComp([
    { take_id: "a", from_beat: 0, to_beat: 4 },
    { take_id: "b", from_beat: 4, to_beat: 8 },
    { take_id: "a", from_beat: 8, to_beat: 12 },
  ], "b", 4, 8, 16);
  assert.deepEqual(apart, [
    { take_id: "a", from_beat: 0, to_beat: 4 },
    { take_id: "b", from_beat: 4, to_beat: 8 },
    { take_id: "a", from_beat: 8, to_beat: 12 },
  ], "pieces of one take that do not touch are not merged");
});

test("clamps a range past the clip end and swaps a reversed pair (the existing comp-drag behaviour)", () => {
  const page = pageApi();
  const before = [{ take_id: "a", from_beat: 0, to_beat: 16 }];
  assert.deepEqual(spliceComp(before, "b", 10, 24, 16), [
    { take_id: "a", from_beat: 0, to_beat: 10 },
    { take_id: "b", from_beat: 10, to_beat: 16 },
  ], "a range running past the clip end stops at the end");
  assert.deepEqual(spliceComp(before, "b", -4, 4, 16), [
    { take_id: "b", from_beat: 0, to_beat: 4 },
    { take_id: "a", from_beat: 4, to_beat: 16 },
  ], "a range before the clip starts at zero");

  const reversed = spliceComp(before, "b", 12, 4, 16);
  assert.deepEqual(reversed, spliceComp(before, "b", 4, 12, 16),
    "a reversed pair is the range it names the right way round");
  assert.deepEqual(reversed, [
    { take_id: "a", from_beat: 0, to_beat: 4 },
    { take_id: "b", from_beat: 4, to_beat: 12 },
    { take_id: "a", from_beat: 12, to_beat: 16 },
  ], "and that is the three piece comp");
  assert.deepEqual(page.spliceComp(before, "b", 12, 4, 16), reversed, "the page agrees");

  assert.deepEqual(spliceComp(before, "b", 20, 24, 16), before,
    "a range entirely past the clip leaves the comp as it was");
  assert.deepEqual(spliceComp(before, "b", 4, 4, 16), before,
    "and so does a range of no width");
});

test("sameComp detects take, from and to differences and tolerates 1e-9", () => {
  const page = pageApi();
  const one = [{ take_id: "a", from_beat: 0, to_beat: 8 }];
  const copy = [{ take_id: "a", from_beat: 0, to_beat: 8 }];
  assert.equal(sameComp(one, copy), true, "the same comp is the same comp");
  assert.equal(page.sameComp(one, copy), true, "the page agrees");
  assert.equal(sameComp([], []), true, "two empty comps are the same");

  assert.equal(sameComp(one, [{ take_id: "b", from_beat: 0, to_beat: 8 }]), false,
    "a different take is a different comp");
  assert.equal(sameComp(one, [{ take_id: "a", from_beat: 1, to_beat: 8 }]), false,
    "so is a different begin");
  assert.equal(sameComp(one, [{ take_id: "a", from_beat: 0, to_beat: 9 }]), false,
    "and a different end");
  assert.equal(sameComp(one, []), false, "a shorter comp is different");
  assert.equal(sameComp([], one), false, "and so is a longer one");

  const nearly = [{ take_id: "a", from_beat: 1e-10, to_beat: 8 - 1e-10 }];
  assert.equal(sameComp(one, nearly), true, "a beat within a billionth is the same beat");
  assert.equal(sameComp(one, [{ take_id: "a", from_beat: 1e-8, to_beat: 8 }]), false,
    "a beat further than that is not");
  assert.equal(sameComp(one, [{ take_id: "a", from_beat: 0, to_beat: 8 + 1e-8 }]), false,
    "a comp that grew is not the same comp");
});

test("validRange refuses to<=from, a fraction and a range past the clip", () => {
  const page = pageApi();
  assert.equal(validRange(0, 4, 16), true, "a whole range inside the clip is valid");
  assert.equal(validRange(0, 16, 16), true, "a range ending on the clip end is valid");
  assert.equal(validRange(12, 16, 16), true, "and one at the end");
  assert.equal(page.validRange(0, 4, 16), true, "the page agrees");

  assert.equal(validRange(4, 4, 16), false, "a range of no width is nothing to punch");
  assert.equal(validRange(8, 4, 16), false, "a reversed pair is refused rather than swapped");
  assert.equal(validRange(0, 4.5, 16), false, "a fraction of a beat is refused");
  assert.equal(validRange(0.5, 4, 16), false, "at either end");
  assert.equal(validRange(0, 17, 16), false, "a range past the clip end is refused");
  assert.equal(validRange(-4, 4, 16), false, "and so is one before the clip start");
  assert.equal(validRange(0, 4, 2), false, "a clip shorter than the range refuses it");
  assert.equal(validRange(NaN, 4, 16), false, "a broken begin is refused");
  assert.equal(validRange(0, null, 16), false, "and a missing end");
  assert.equal(validRange(0, 4, undefined), false, "and a clip whose length is unknown");
});

test("passGateRanges for pass 0 adds the offset to both ends", () => {
  const page = pageApi();
  const range = passGateRanges({
    anchorFrame: 1000,
    fpb: 480,
    loopBeats: 16,
    passIndex: 0,
    from: 2,
    to: 6,
    offsetFrames: 300,
  });
  assert.deepEqual(range, [1000 + 300 + 2 * 480, 1000 + 300 + 6 * 480],
    "pass 0 opens and closes on the beat frames plus the input delay");
  assert.deepEqual(range, [2260, 4180], "which are these frames");
  assert.deepEqual(page.passGateRanges({
    anchorFrame: 1000,
    fpb: 480,
    loopBeats: 16,
    passIndex: 0,
    from: 2,
    to: 6,
    offsetFrames: 300,
  }), range, "the page agrees");

  const noDelay = passGateRanges({
    anchorFrame: 1000,
    fpb: 480,
    loopBeats: 16,
    passIndex: 0,
    from: 2,
    to: 6,
    offsetFrames: 0,
  });
  assert.deepEqual(noDelay, [1960, 3880], "no calibration is no shift at all");

  const whole = passGateRanges({
    anchorFrame: 1000,
    fpb: 480,
    loopBeats: 16,
    passIndex: 0,
    from: 0,
    to: 16,
    offsetFrames: 300,
  });
  assert.deepEqual(whole, [1300, 1300 + 16 * 480], "a range over the pass spans the whole loop");
});

test("pass 2 is shifted by exactly 2*loopBeats*fpb", () => {
  const page = pageApi();
  const common = {
    anchorFrame: 48000,
    fpb: 480,
    loopBeats: 16,
    from: 2,
    to: 6,
    offsetFrames: 512,
  };
  const pass0 = passGateRanges({ ...common, passIndex: 0 });
  const pass1 = passGateRanges({ ...common, passIndex: 1 });
  const pass2 = passGateRanges({ ...common, passIndex: 2 });
  const loopFrames = 16 * 480;
  assert.equal(pass1[0] - pass0[0], loopFrames, "pass 1's gate opens one loop later");
  assert.equal(pass1[1] - pass0[1], loopFrames, "and closes one loop later");
  assert.equal(pass2[0] - pass0[0], 2 * loopFrames, "pass 2 is exactly two loops on");
  assert.equal(pass2[1] - pass0[1], 2 * loopFrames, "at both ends");
  assert.deepEqual(passGateRanges({ ...common, passIndex: 0 }), pass0,
    "the pass index is the only thing that moves the range");
  assert.deepEqual(page.passGateRanges({ ...common, passIndex: 2 }), pass2,
    "the page agrees");
});

test("frames are integers and no two passes' ranges overlap", () => {
  const page = pageApi();
  const options = {
    anchorFrame: 12345.75,
    fpb: 480.3,
    loopBeats: 15.7,
    from: 2,
    to: 6,
    offsetFrames: 733.5,
  };
  const ranges = [];
  for (let passIndex = 0; passIndex < 8; passIndex += 1) {
    const [on, off] = passGateRanges({ ...options, passIndex });
    assert.ok(Number.isInteger(on), `pass ${passIndex} opens on a whole frame, got ${on}`);
    assert.ok(Number.isInteger(off), `pass ${passIndex} closes on a whole frame, got ${off}`);
    assert.ok(on < off, `pass ${passIndex} opens before it closes`);
    if (passIndex > 0) {
      assert.ok(on > ranges[passIndex - 1][1],
        `pass ${passIndex} opens after pass ${passIndex - 1} closed`);
    }
    const pageRange = page.passGateRanges({ ...options, passIndex });
    assert.equal(pageRange[0], on, `the page agrees on pass ${passIndex}'s on frame`);
    assert.equal(pageRange[1], off, `and its off frame`);
    ranges.push([on, off]);
  }

  for (let at = 1; at < ranges.length; at += 1) {
    assert.ok(ranges[at][1] > ranges[at][0], `pass ${at} is a real range`);
  }

  assert.deepEqual(passGateRanges({}), [0, 0], "no options at all is no range");
  assert.deepEqual(
    passGateRanges({ anchorFrame: 100, fpb: 480, loopBeats: 16, passIndex: 0, from: 2, to: 6 }),
    [100 + 2 * 480, 100 + 6 * 480],
    "a missing delay is no delay",
  );
});