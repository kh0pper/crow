import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
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
const FOLD = { // standing forward fold: trunk past horizontal, legs vertical, arms hang short of the floor
  rootAngle: 100, spine: 20, neck: 25,
  shoulderL: 90, elbowL: 5, shoulderR: 90, elbowR: 5,
  hipL: 100, kneeL: 5, ankleL: 5, hipR: 100, kneeR: 5, ankleR: 5,
  support: "feet",
};
const LUNGE = { // low lunge: back knee down (toes tucked), front foot flat, hip sunk below the front knee
  rootAngle: 0, spine: 5,
  shoulderL: 15, elbowL: 10, shoulderR: 30, elbowR: 20,
  hipL: 101, kneeL: 118, ankleL: 20, hipR: -20, kneeR: 90, ankleR: 4,
  support: "knees",
};
const DOWNDOG = { // inverted V on hands and feet, arms in line with the trunk, heels a little up
  rootAngle: 140, spine: 5, neck: 20,
  shoulderL: 180, wristL: 60, shoulderR: 180, wristR: 60,
  hipL: 115, kneeL: 5, ankleL: 15, hipR: 115, kneeR: 5, ankleR: 15,
  support: "hands_feet",
};
const SEATED = { // seated twist: legs out along the floor, one hand down beside the hip
  rootAngle: -5, spine: 15, neck: -25,
  shoulderL: 60, elbowL: 40, wristL: 20, shoulderR: 9, elbowR: 55,
  hipL: 87, kneeL: 0, ankleL: 0, hipR: 87, kneeR: 0, ankleR: 0,
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

/* The named contact must be ON the floor (within 1 px at 100 px tall), and
 * nothing may go through it (y > 0.5). Seated, the hip rides 0.05H above the
 * floor on the buttock. Task 10 runs this same check over the shipped library. */
const FEET = ["heelL", "toeL", "heelR", "toeR"];
const ON = (j, names, at = 0) => names.some((k) => Math.abs(j[k].y - at) <= 1);
const CONTACT = {
  feet: (j) => ON(j, FEET),
  hands_feet: (j) => ON(j, ["handL", "handR"]) && ON(j, FEET),
  seat: (j) => ON(j, ["hip"], -Figure.SEAT_HEIGHT_FRAC * 100),
  back: (j) => ON(j, ["hip", "shoulder"]),
  knees: (j) => ON(j, ["kneeL", "kneeR"]),
};
test("every fixture pose: no NaN, nothing through the floor, the named contact on the floor", () => {
  for (const [name, pose] of POSES) {
    const { joints } = Figure.solve(pose, 100);
    for (const [jn, p] of Object.entries(joints)) {
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), name + ": " + jn + " is finite");
      assert.ok(p.y <= 0.5, name + ": " + jn + " is through the floor at y=" + p.y.toFixed(2));
    }
    const support = Figure.clampPose(pose).support;
    assert.ok(CONTACT[support](joints), name + ": its " + support + " contact is on the floor");
  }
});

test("a standing figure is about 1.0H tall, head included", () => {
  const { joints } = Figure.solve(STANDING, 100);
  const crown = joints.head.y - Figure.SEGMENTS.head * 100 / 2;
  assert.ok(crown > -101 && crown < -99, "crown at " + crown.toFixed(2));
});

test("a pose that sinks a non-contact part through the floor is caught", () => {
  const sunk = { ...SEATED, kneeL: 0, hipL: 70, hipR: 70 }; // legs angled down: heels go under
  const { joints } = Figure.solve(sunk, 100);
  assert.ok(Object.values(joints).some((p) => p.y > 0.5), "the check above would reject this pose");
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

/* The shipped library's exercises, each with the two key positions a rep moves
 * between. Read off disk, never written. */
const LIBRARY_DIR = new URL("../bundles/ramble/server/moves/library/", import.meta.url);
function libraryExercises() {
  const out = [];
  for (const name of readdirSync(LIBRARY_DIR)) {
    if (!name.endsWith(".json")) continue;
    const entry = JSON.parse(readFileSync(new URL(name, LIBRARY_DIR), "utf8"));
    if (!entry || entry.kind !== "exercise" || !Array.isArray(entry.poses)) continue;
    if (entry.poses.length < 2) continue;
    out.push(entry);
  }
  return out;
}

/* A pose's own value for a key, with clampPose's default for a key it leaves
 * out. */
const valueOf = (pose, key) => (typeof pose[key] === "number" ? pose[key] : 0);

function insideLimits(pose, where) {
  for (const [joint, lim] of Object.entries(Figure.JOINT_LIMITS)) {
    for (const side of ["L", "R"]) {
      const key = joint + side;
      if (!Object.prototype.hasOwnProperty.call(pose, key)) continue;
      assert.ok(pose[key] >= lim.min - 1e-9 && pose[key] <= lim.max + 1e-9,
        where + ": " + key + " = " + pose[key]);
    }
  }
  assert.ok(pose.rootAngle >= Figure.ROOT_LIMIT.min && pose.rootAngle <= Figure.ROOT_LIMIT.max,
    where + ": rootAngle = " + pose.rootAngle);
}

test("tween: endpoints exact, support switches at t=0.5, no easing", () => {
  const pairs = [[STANDING, FOLD], [FOLD, DOWNDOG], [DOWNDOG, SEATED], [SEATED, TREE], [TREE, LUNGE]];
  for (const [a, b] of pairs) {
    assert.deepEqual(Figure.tween(a, b, 0), Figure.clampPose(a));
    assert.deepEqual(Figure.tween(a, b, 1), Figure.clampPose(b));
    assert.deepEqual(Figure.tween(a, b, -1), Figure.clampPose(a), "before the start is the start");
    assert.deepEqual(Figure.tween(a, b, 4), Figure.clampPose(b), "past the end is the end");
    assert.deepEqual(Figure.tween(a, b, "half"), Figure.clampPose(a), "a non-number is no motion");
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const p = Figure.tween(a, b, t);
      insideLimits(p, "t=" + t);
      const expected = t < 0.5 ? Figure.clampPose(a).support : Figure.clampPose(b).support;
      assert.equal(p.support, expected, "support@" + t);
    }
  }

  /* Linear, not eased: half way through is half way round the joint. */
  const mid = Figure.tween({ kneeL: 10 }, { kneeL: 90 }, 0.5);
  assert.equal(mid.kneeL, 50);
  assert.equal(Figure.tween({ kneeL: 10 }, { kneeL: 90 }, 0.25).kneeL, 30);
  assert.equal(mid.support, "feet", "support comes from the first half");
  assert.equal(Figure.tween({ kneeL: 10, support: "seat" }, { kneeL: 90 }, 0.49).support, "seat");
  assert.equal(Figure.tween({ kneeL: 10, support: "seat" }, { kneeL: 90 }, 0.5).support, "feet");
});

test("tween: every shipped exercise's two key positions are inside the limits", () => {
  const exercises = libraryExercises();
  assert.ok(exercises.length > 0, "the shipped library carries exercises");

  for (const entry of exercises) {
    const [start, end] = entry.poses;
    for (const pose of [start, end]) {
      const clamped = Figure.clampPose(pose);
      for (const key of Object.keys(clamped)) {
        if (key === "support") continue;
        assert.equal(clamped[key], valueOf(pose, key), entry.id + ": " + key + " is unchanged by clampPose");
      }
      insideLimits(clamped, entry.id);
    }
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      insideLimits(Figure.tween(start, end, t), entry.id + " tween@" + t);
    }
    assert.deepEqual(Figure.tween(start, end, 0), Figure.clampPose(start), entry.id + " starts on its first pose");
    assert.deepEqual(Figure.tween(start, end, 1), Figure.clampPose(end), entry.id + " ends on its second pose");
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

/* ── Colour bands, arrows and labels ──────────────────────────────────────
 * The decoration layers are optional: without them poseSvg draws exactly the
 * bare figure above, so the tests below always anchor on that bare call. */
const LINES = /<line /g;
const CIRCLES = /<circle /g;
const count = (svg, re) => (svg.match(re) || []).length;
const frame = (svg) => svg.match(/viewBox="([^"]+)"/)[1].split(" ").map(Number);
const groups = (svg, attr) => {
  const re = new RegExp('<g data-layer="' + attr + '"[^>]*>([\\s\\S]*?)<\\/g>', "g");
  const out = [];
  let m;
  while ((m = re.exec(svg))) out.push(m[1]);
  return out;
};
const group = (svg, attr) => groups(svg, attr)[0] || "";

test("poseSvg: no bands, arrows, labels or layers is the bare figure", () => {
  for (const [name, pose] of POSES) {
    const bare = Figure.poseSvg(pose, { size: 200 });
    assert.equal(Figure.poseSvg(pose, {
      size: 200, bands: undefined, arrows: undefined, labels: undefined, layers: undefined,
    }), bare, name + ": an opts object with nothing in it changes nothing");
    assert.equal(Figure.poseSvg(pose, {
      size: 200, bands: {}, arrows: [], labels: [], layers: {},
    }), bare, name + ": empty decoration lists change nothing");
    assert.ok(!bare.includes("data-layer"), name + ": no decoration groups in the bare figure");
    assert.ok(!bare.includes("<text"), name + ": no text nodes in the bare figure");
  }
});

test("poseSvg bands: working is blue over the base line, lengthening red and dashed, both sides", () => {
  const bare = Figure.poseSvg(DOWNDOG, { size: 200 });
  const svg = Figure.poseSvg(DOWNDOG, {
    size: 200, bands: { working: ["thigh", "upperArm"], lengthening: ["shin"] },
  });
  const muscles = groups(svg, "muscles");
  assert.equal(muscles.length, 2, "one group for working, one for lengthening");
  assert.match(svg, /<g data-layer="muscles" stroke="#2f6fdb"/, "working bands are blue");
  assert.match(svg, /<g data-layer="muscles" stroke="#c8423b" stroke-width="[\d.]+" stroke-dasharray="[^"]+"/,
    "lengthening bands are red and dashed, so colour is not the only signal");
  assert.equal(count(muscles[0], LINES), 4, "thigh and upperArm are each drawn near and far");
  assert.equal(count(muscles[1], LINES), 2, "shin is drawn near and far");
  assert.equal(count(svg, LINES), count(bare, LINES) + 6, "bands are extra strokes over the base figure");
  assert.deepEqual(frame(svg), frame(bare), "bands need no extra room");

  const head = Figure.poseSvg(STANDING, { size: 160, bands: { working: ["head"] } });
  assert.match(group(head, "muscles"), /^<circle /, "the head circle can be banded too");

  const dashed = Figure.poseSvg(STANDING, { size: 160, bands: { lengthening: ["foot"] } });
  assert.equal(count(group(dashed, "muscles"), LINES), 2, "feet are two segments");
});

test("poseSvg: unknown segment names are ignored in bands and labels", () => {
  const bare = Figure.poseSvg(STANDING, { size: 160 });
  assert.equal(Figure.poseSvg(STANDING, {
    size: 160, bands: { working: ["wing", 42, null], lengthening: "torso" },
  }), bare, "unknown names and a non-array list draw nothing");
  assert.equal(Figure.poseSvg(STANDING, {
    size: 160, labels: [{ segment: "wing", text: "wing" }, { segment: "__proto__", text: "x" }],
  }), bare, "an unknown or inherited segment name gets no label");
});

test("poseSvg layers: skeleton dots per joint, nerves dotted along the spine, muscles switchable", () => {
  const bare = Figure.poseSvg(TREE, { size: 160 });
  const joints = Object.keys(Figure.solve(TREE, 100).joints);

  const skel = Figure.poseSvg(TREE, { size: 160, layers: { skeleton: true } });
  assert.equal(count(group(skel, "skeleton"), CIRCLES), joints.length, "one dot per solved joint");
  assert.equal(count(skel, CIRCLES), count(bare, CIRCLES) + joints.length,
    "the dots are added on top of the head circle");
  assert.match(group(skel, "skeleton"), /^<circle /, "the layer holds plain circles");

  const nerves = Figure.poseSvg(TREE, { size: 160, layers: { nerves: true } });
  assert.match(nerves, /<g data-layer="nerves"[^>]*stroke-dasharray="[^"]+"/, "the spine line is dotted");
  assert.equal(count(group(nerves, "nerves"), LINES), 2, "mid to shoulder, shoulder to chin");
  assert.equal(count(nerves, LINES), count(bare, LINES) + 2);

  assert.equal(Figure.poseSvg(TREE, { size: 160, layers: { skeleton: "yes", nerves: 1 } }), bare,
    "only true turns a layer on");

  const bands = { working: ["thigh"] };
  assert.ok(Figure.poseSvg(TREE, { size: 160, bands }).includes("#2f6fdb"), "bands are on by default");
  assert.equal(Figure.poseSvg(TREE, { size: 160, bands, layers: { muscles: false } }), bare,
    "layers.muscles === false turns the bands off");
  assert.notEqual(Figure.poseSvg(TREE, { size: 160, bands, layers: { muscles: true } }), bare);
});

test("poseSvg arrows: one line group each, drawn from the anchor joint in the asked direction", () => {
  const bare = Figure.poseSvg(LUNGE, { size: 180 });
  const one = Figure.poseSvg(LUNGE, { size: 180, arrows: [{ from: "hips", direction: "forward" }] });
  assert.equal(count(one, /<g data-layer="arrow"/g), 1, "one group per arrow");
  const shaft = group(one, "arrow").match(/<line x1="([-\d.]+)" y1="([-\d.]+)" x2="([-\d.]+)" y2="([-\d.]+)"/);
  assert.ok(shaft, "the group starts with the shaft");
  const [, x1, y1, x2, y2] = shaft.map(Number);
  assert.ok(Number.isFinite(x1) && Number.isFinite(y1) && Number.isFinite(x2) && Number.isFinite(y2));
  assert.ok(x2 > x1, "forward is +x (the figure faces right)");
  assert.equal(y2, y1, "a forward arrow is level");
  const hip = Figure.solve(LUNGE, 100).joints.hip;
  assert.ok(Math.abs(x1 - hip.x) < 0.06 && Math.abs(y1 - hip.y) < 0.06, "it starts at the solved hip");
  assert.equal(count(group(one, "arrow"), LINES), 3, "shaft plus a two-line head");

  const all = Figure.poseSvg(LUNGE, {
    size: 180,
    arrows: ["hands", "feet", "knees", "hips", "elbows", "shoulders", "head", "back", "chest", "heels"]
      .map((from, i) => ({ from, direction: ["up", "down", "forward", "back", "out"][i % 5] })),
  });
  assert.equal(count(all, /<g data-layer="arrow"/g), 10, "every documented anchor draws");
  assert.equal(count(all, LINES), count(bare, LINES) + 30);
  assert.ok(!/NaN|Infinity/.test(all));

  const none = Figure.poseSvg(LUNGE, {
    size: 180,
    arrows: [
      { from: "wings", direction: "up" }, { from: "hands", direction: "sideways" },
      { from: "hips" }, "hips", null, 7, { from: 5, direction: "up" },
    ],
  });
  assert.equal(none, bare, "unknown anchors, unknown directions and junk entries draw nothing");
});

test("poseSvg labels: text is escaped and capped, a leader line is drawn, the frame widens", () => {
  const bare = Figure.poseSvg(FOLD, { size: 220 });
  const one = Figure.poseSvg(FOLD, { size: 220, labels: [{ segment: "torso", text: "<b>x</b>" }] });
  assert.ok(!one.includes("<b>"), "markup in a label is escaped, never raw");
  assert.ok(one.includes("&lt;b&gt;x&lt;/b&gt;"), "it reaches the markup as text");
  assert.equal(count(group(one, "labels"), LINES), 1, "one leader line per label");
  assert.equal(count(one, LINES), count(bare, LINES) + 1);
  assert.ok(frame(one)[2] > frame(bare)[2], "the viewBox widens, so the figure zooms out to make room");
  assert.equal(frame(one)[1], frame(bare)[1], "the top of the frame is unchanged");
  assert.ok(one.includes('aria-hidden="true"'));

  const escaped = Figure.poseSvg(STANDING, {
    size: 200, labels: [{ segment: "neck", text: "a&b<c>d\"e'f" }],
  });
  assert.ok(escaped.includes("a&amp;b&lt;c&gt;d&quot;e&#39;f"), "all five characters are escaped");
  assert.ok(!escaped.includes("a&b<c>d"), "the raw text never reaches the markup");

  const long = Figure.poseSvg(STANDING, {
    size: 200, labels: [{ segment: "torso", text: "x".repeat(120) }],
  });
  assert.ok(long.includes(">" + "x".repeat(40) + "<"), "label text is capped at 40 characters");
  assert.ok(!long.includes("x".repeat(41)));

  const stacked = Figure.poseSvg(STANDING, {
    size: 200,
    labels: [{ segment: "head", text: "Head" }, { segment: "shin", text: "Shin" },
      { segment: "hand", text: 12 }],
  });
  assert.equal(count(group(stacked, "labels"), LINES), 3, "each placed label gets its leader");
  assert.ok(stacked.includes(">12<"), "a number is rendered as its own digits");
  const narrow = Figure.poseSvg(STANDING, { size: 200, labels: [{ segment: "head", text: "Head" }] });
  const wider = Figure.poseSvg(STANDING, { size: 200, labels: [{ segment: "head", text: "Head and neck" }] });
  assert.ok(frame(wider)[2] > frame(narrow)[2], "the column follows the widest label");
  assert.deepEqual(frame(stacked), frame(narrow), "stacking more short labels does not widen the frame");
  assert.equal(Figure.poseSvg(STANDING, { size: 200, labels: [
    { segment: "head", text: "Head" }, { segment: "shin", text: "Shin" }, { segment: "hand", text: 12 },
  ] }), stacked, "deterministic");
});

test("poseSvg decorations stay inert and never put junk in the markup", () => {
  const svg = Figure.poseSvg(DOWNDOG, {
    size: 200,
    bands: { working: ["torso", "thigh"], lengthening: ["neck", "shin"] },
    arrows: [{ from: "hips", direction: "up", label: "Hips" }, { from: "hands", direction: "down" }],
    labels: [{ segment: "head", text: "Head" }],
    layers: { skeleton: true, nerves: true },
  });
  assert.ok(svg.startsWith("<svg "));
  assert.ok(svg.endsWith("</svg>"));
  assert.ok(svg.includes('aria-hidden="true"'));
  assert.ok(!svg.includes("xmlns"), "no namespace attribute");
  assert.ok(!/https?:|javascript:|\/\//i.test(svg), "no URL-shaped strings");
  assert.ok(!/<script/i.test(svg));
  assert.ok(!/\son[a-z]+\s*=/i.test(svg), "no on* handlers");
  assert.ok(!/NaN|Infinity/.test(svg));
  assert.ok(!svg.includes("`") && !svg.includes("${"), "safe inside a template literal");

  const junk = [null, undefined, "bands", 7, NaN, [], true, { bands: "torso" },
    { bands: { working: "torso", lengthening: { 0: "shin" } } },
    { bands: { working: [null, {}, [], "thigh"], lengthening: [NaN] } },
    { arrows: "hands", labels: "torso", layers: "skeleton" },
    { arrows: [NaN, {}, { from: null, direction: 3 }, { from: "hands", direction: "up", label: {} }] },
    { labels: [null, 5, "torso", { segment: 7 }, { segment: "torso" },
      { segment: "torso", text: {} }, { segment: "head", text: "" }, { segment: "head", text: NaN }] },
    { layers: { skeleton: "yes", nerves: [], muscles: "no" } },
    { size: NaN, bands: { working: ["head"] }, arrows: [{ from: "head", direction: "down" }],
      labels: [{ segment: "pelvis", text: "Pelvis" }], layers: { skeleton: true, nerves: true } }];
  for (const opts of junk) {
    assert.doesNotThrow(() => Figure.poseSvg(LUNGE, opts), "opts " + JSON.stringify(opts));
    const out = Figure.poseSvg(LUNGE, opts);
    assert.ok(!/NaN|Infinity|undefined/.test(out), "no junk values for opts " + JSON.stringify(opts));
    assert.ok(out.startsWith("<svg ") && out.endsWith("</svg>"), "still a whole svg");
  }
  assert.equal(Figure.poseSvg(LUNGE, { arrows: [{ from: "hands", direction: "up", label: {} }] }),
    Figure.poseSvg(LUNGE, { arrows: [{ from: "hands", direction: "up" }] }),
    "a non-text arrow label adds nothing");
});

test("no ESM syntax (must load as a classic browser script)", async () => {
  const src = readFileSync(new URL("../bundles/ramble/server/moves/figure.cjs", import.meta.url), "utf8");
  assert.ok(!/^\s*(import|export)\s/m.test(src));
});
