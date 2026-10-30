import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Figure = require("../bundles/ramble/server/moves/figure.cjs");

/* Six fixture poses with plausible angles inside the AAOS limits. Missing
 * keys default to 0 via clampPose. Convention (see figure.cjs header): side
 * view facing right, degrees, flexion positive, angles relative to the
 * parent segment; the thigh/upper-arm absolute angle = joint − trunk tilt,
 * so a held hip/shoulder keeps the limb fixed while the trunk rotates.
 * Task 10 extends the support check to the shipped library. */
const STANDING = { support: "feet" };
const FOLD = { // standing forward fold: trunk past horizontal, legs vertical, arms dangle
  rootAngle: 100, spine: 20, neck: 25,
  shoulderL: 120, elbowL: 5, shoulderR: 120, elbowR: 5,
  hipL: 100, kneeL: 5, ankleL: 5, hipR: 100, kneeR: 5, ankleR: 5,
  support: "feet",
};
const LUNGE = { // low lunge: front foot flat, back knee down with a pointed toe
  rootAngle: 5, spine: 5,
  shoulderL: 15, elbowL: 10, shoulderR: 30, elbowR: 20,
  hipL: 95, kneeL: 95, ankleL: 5, hipR: 5, kneeR: 90, ankleR: -50,
  support: "feet",
};
const DOWNDOG = { // inverted V on hands and feet
  rootAngle: 125, spine: 10, neck: 25,
  shoulderL: 145, wristL: 80, shoulderR: 145, wristR: 80,
  hipL: 110, kneeL: 10, ankleL: -40, hipR: 110, kneeR: 10, ankleR: -40,
  support: "hands_feet",
};
const SEATED = { // seated twist: legs forward, one arm sweeps back, head turns
  spine: 10, neck: -25,
  shoulderL: 60, elbowL: 40, wristL: 20, shoulderR: -25,
  hipL: 85, kneeL: 15, ankleL: 5, hipR: 80, kneeR: 10, ankleR: 10,
  support: "seat",
};
const TREE = { // tree pose: one leg standing, arms overhead
  rootAngle: -3, spine: 2,
  shoulderL: 172, elbowL: 4, shoulderR: 172, elbowR: 4,
  hipL: -2, kneeL: 3, hipR: 50, kneeR: 115, ankleR: -25,
  support: "feet",
};
const POSES = [
  ["standing", STANDING], ["forward fold", FOLD], ["low lunge", LUNGE],
  ["downward dog", DOWNDOG], ["seated twist", SEATED], ["tree", TREE],
];

test("SEGMENTS: Winter fractions of height, all sane", () => {
  for (const k of ["head", "trunk", "upperArm", "forearm", "hand", "thigh", "shank", "foot"]) {
    const v = Figure.SEGMENTS[k];
    assert.equal(typeof v, "number", k);
    assert.ok(v > 0.02 && v < 0.35, k + " = " + v + " is a plausible fraction of height");
  }
  const leg = Figure.SEGMENTS.thigh + Figure.SEGMENTS.shank;
  assert.ok(leg > 0.4 && leg < 0.55, "hip-to-ankle ≈ half of height, got " + leg);
});

test("JOINT_LIMITS: every key has min < max", () => {
  assert.deepEqual(Object.keys(Figure.JOINT_LIMITS).sort(),
    ["ankle", "elbow", "hip", "knee", "neck", "shoulder", "spine", "wrist"]);
  for (const [k, lim] of Object.entries(Figure.JOINT_LIMITS)) {
    assert.ok(Number.isFinite(lim.min) && Number.isFinite(lim.max), k);
    assert.ok(lim.min < lim.max, k + ": " + lim.min + " < " + lim.max);
  }
});

test("clampPose clamps to the limits, defaults junk, never mutates", () => {
  assert.equal(Figure.clampPose({ kneeL: 200 }).kneeL, Figure.JOINT_LIMITS.knee.max);
  assert.equal(Figure.clampPose({ kneeR: -200 }).kneeR, Figure.JOINT_LIMITS.knee.min);
  assert.equal(Figure.clampPose({ hipL: 60 }).hipL, 60, "in-range value untouched");
  const c = Figure.clampPose({ kneeL: "x", ankleL: NaN, junk: 1, support: "wings" });
  assert.equal(c.kneeL, 0, "non-numbers default to 0");
  assert.equal(c.ankleL, 0);
  assert.equal(c.support, "feet", "unknown support falls back");
  assert.ok(!("junk" in c), "unknown keys are dropped");
  const input = { kneeL: 200 };
  Figure.clampPose(input);
  assert.equal(input.kneeL, 200, "input untouched");
  assert.doesNotThrow(() => Figure.clampPose(null));
});

test("solve grounds the lowest support point at y=0 and returns no NaN", () => {
  for (const [name, pose] of POSES) {
    const { joints } = Figure.solve(pose, 250);
    const support = Figure.SUPPORT_POINTS[Figure.clampPose(pose).support];
    assert.ok(Array.isArray(support) && support.length > 0, name + ": support set");
    let lowest = -Infinity;
    for (const [jn, p] of Object.entries(joints)) {
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), name + ": " + jn + " is finite");
      if (support.includes(jn)) lowest = Math.max(lowest, p.y);
    }
    assert.ok(Math.abs(lowest) <= 0.5, name + ": lowest support point at y=0, got " + lowest);
  }
});

test("solve scales with heightPx", () => {
  const a = Figure.solve(FOLD, 100).joints, b = Figure.solve(FOLD, 200).joints;
  assert.ok(Math.abs(b.head.x - 2 * a.head.x) < 0.001);
  assert.ok(Math.abs(b.kneeL.y - 2 * a.kneeL.y) < 0.001);
});

test("interpolate: endpoints exact, limits held, support switches at t=0.5", () => {
  const pairs = [[STANDING, FOLD], [FOLD, DOWNDOG], [DOWNDOG, SEATED], [SEATED, TREE], [TREE, LUNGE]];
  for (const [a, b] of pairs) {
    assert.deepEqual(Figure.interpolate(a, b, 0), Figure.clampPose(a));
    assert.deepEqual(Figure.interpolate(a, b, 1), Figure.clampPose(b));
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const p = Figure.interpolate(a, b, t);
      for (const [joint, lim] of Object.entries(Figure.JOINT_LIMITS)) {
        for (const key of [joint + "L", joint + "R"]) {
          if (key in p) {
            assert.ok(p[key] >= lim.min - 1e-9 && p[key] <= lim.max + 1e-9, key + "@" + t);
          }
        }
      }
      assert.ok(p.rootAngle >= Figure.ROOT_LIMIT.min && p.rootAngle <= Figure.ROOT_LIMIT.max, "rootAngle@" + t);
      const expected = t < 0.5 ? Figure.clampPose(a).support : Figure.clampPose(b).support;
      assert.equal(p.support, expected, "support@" + t);
    }
  }
});

test("interpolate: a knee between 10° and 90° never bends backwards", () => {
  const a = { kneeL: 10 }, b = { kneeL: 90 };
  for (let t = 0; t <= 1.0001; t += 0.01) {
    const knee = Figure.interpolate(a, b, t).kneeL;
    assert.ok(knee >= 0 && knee <= 90 + 1e-9, "kneeL@" + t + " = " + knee);
  }
});

test("poseSvg: inert decorative markup, deterministic, muscles accepted and ignored", () => {
  for (const [name, pose] of POSES) {
    const svg = Figure.poseSvg(pose, { size: 200 });
    assert.ok(svg.startsWith("<svg "), name);
    assert.ok(svg.includes("viewBox="), name);
    assert.ok(svg.includes('aria-hidden="true"'), name + ": decorative");
    assert.ok(!/<script/i.test(svg), name);
    assert.ok(!/\son[a-z]+\s*=/i.test(svg), name + ": no on* handlers");
    assert.ok(!svg.includes("`") && !svg.includes("${"), name + ": safe inside a template literal");
    assert.ok(!/>[^<]+</.test(svg.replace(/<svg[^>]*>|<\/svg>|<g[^>]*>|<\/g>/g, "")), name + ": no text nodes");
    assert.equal(Figure.poseSvg(pose, { size: 200 }), svg, name + ": deterministic");
  }
  assert.equal(Figure.poseSvg(TREE, { size: 100, muscles: ["quads"] }), Figure.poseSvg(TREE, { size: 100 }),
    "muscles option is accepted and ignored in v1");
  assert.doesNotThrow(() => Figure.poseSvg(null));
});

test("poseSvg output survives a junk pose without NaN in the markup", () => {
  const svg = Figure.poseSvg({ kneeL: "x", rootAngle: Infinity, support: "nope" }, { size: 120 });
  assert.ok(!/NaN|Infinity/.test(svg), svg);
});

test("no ESM syntax (must load as a classic browser script)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../bundles/ramble/server/moves/figure.cjs", import.meta.url), "utf8");
  assert.ok(!/^\s*(import|export)\s/m.test(src));
});
