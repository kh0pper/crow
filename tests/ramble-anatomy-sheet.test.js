/**
 * Ramble anatomy pipeline — nerves, the comparison sheet and the sample runner.
 *
 * Synthetic data only: poses come from the figure engine's own solve(), the
 * sheet is fed markup written here, and the runner is planned (or dry-run)
 * without a Blender, rsvg-convert or source model anywhere in sight.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { buildNerves } from "../scripts/ramble-anatomy/lib/nerves.mjs";
import { loadPosedDir } from "../scripts/ramble-anatomy/lib/obj.mjs";
import { buildSheet, innerSvg, stickFigureSvgBody, viewBoxOf } from "../scripts/ramble-anatomy/lib/sheet.mjs";
import { buildLayeredSvg } from "../scripts/ramble-anatomy/lib/svg-writer.mjs";
import { assertWindow, planRun } from "../scripts/ramble-anatomy/render-sample.mjs";

const require = createRequire(import.meta.url);
const Figure = require("../bundles/ramble/server/moves/figure.cjs");

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const VOCAB_FILE = join(REPO, "bundles", "ramble", "server", "moves", "anatomy", "vocab.json");
const RENDER_SAMPLE = join(REPO, "scripts", "ramble-anatomy", "render-sample.mjs");
const vocab = JSON.parse(readFileSync(VOCAB_FILE, "utf8")).vocab;

const HEIGHT_MM = 1700;
const SCALE = 100 / HEIGHT_MM;
const NERVE_IDS = [
  "sciatic-nerve", "femoral-nerve", "tibial-nerve", "common-fibular-nerve",
  "median-nerve", "ulnar-nerve", "radial-nerve", "axillary-nerve",
];

const STANDING = { support: "feet" };
const SQUAT = {
  neck: 0, spine: 0,
  shoulderL: 125, elbowL: 5, wristL: 0,
  shoulderR: 125, elbowR: 5, wristR: 0,
  hipL: 110, kneeL: 95, ankleL: 20,
  hipR: 110, kneeR: 95, ankleR: 20,
  rootAngle: 35, support: "feet",
};

/** figure.cjs solve() as pose.json carries it: millimetres, x forward, z up, plus crown. */
function jointsFrom(pose) {
  const solved = Figure.solve(pose, HEIGHT_MM);
  const joints = {};
  for (const [name, point] of Object.entries(solved.joints)) joints[name] = { x: point.x, z: -point.y };
  const chin = joints.chin;
  const head = joints.head;
  joints.crown = { x: chin.x + 2 * (head.x - chin.x), z: chin.z + 2 * (head.z - chin.z) };
  return joints;
}

const toSvg = (joint) => ({ x: joint.x * SCALE, y: -joint.z * SCALE });

/** The box every solved joint falls in, in SVG units. */
function figureBox(joints) {
  let box = null;
  for (const joint of Object.values(joints)) {
    const point = toSvg(joint);
    box = box
      ? {
        minX: Math.min(box.minX, point.x),
        minY: Math.min(box.minY, point.y),
        maxX: Math.max(box.maxX, point.x),
        maxY: Math.max(box.maxY, point.y),
      }
      : { minX: point.x, minY: point.y, maxX: point.x, maxY: point.y };
  }
  return box;
}

/* ── buildNerves ──────────────────────────────────────────────────────────── */

test("buildNerves: exactly the vocabulary's eight nerves, finite points inside the figure's frame", () => {
  const joints = jointsFrom(SQUAT);
  const nerves = buildNerves(joints, HEIGHT_MM);

  assert.deepEqual(nerves.map((nerve) => nerve.id), NERVE_IDS, "every nerve id, in vocabulary order");
  assert.equal(new Set(nerves.map((nerve) => nerve.id)).size, 8);

  const records = new Map(vocab.map((record) => [record.id, record]));
  const box = figureBox(joints);
  for (const nerve of nerves) {
    const record = records.get(nerve.id);
    assert.ok(record, nerve.id + " is a vocabulary id");
    assert.equal(record.layer, "nerve", nerve.id + " is layer nerve");
    assert.ok(nerve.points.length >= 3, nerve.id + " is a strand of at least three points");
    for (const point of nerve.points) {
      assert.equal(point.length, 2, nerve.id + " points are [x, y] pairs");
      assert.ok(Number.isFinite(point[0]) && Number.isFinite(point[1]), nerve.id + " has a finite point");
      assert.ok(point[0] >= box.minX - 10 && point[0] <= box.maxX + 10,
        nerve.id + " x stays near the figure: " + point[0]);
      assert.ok(point[1] >= box.minY - 10 && point[1] <= box.maxY + 10,
        nerve.id + " y stays near the figure: " + point[1]);
    }
  }
});

test("buildNerves: the sciatic strand runs behind the femoral one through the thigh", () => {
  const joints = jointsFrom(STANDING);
  const nerves = buildNerves(joints, HEIGHT_MM);
  const pointsOf = (id) => nerves.find((nerve) => nerve.id === id).points;
  const sciatic = pointsOf("sciatic-nerve");
  const femoral = pointsOf("femoral-nerve");

  /* Both strands have a waypoint halfway down the thigh, so those two face each other. */
  assert.ok(sciatic[1][0] < femoral[1][0] - 1,
    "the sciatic is posterior of the femoral at mid-thigh: " + sciatic[1][0] + " vs " + femoral[1][0]);
  assert.ok(Math.abs(sciatic[1][1] - femoral[1][1]) < 3, "and they sit at about the same height");

  const thighMidX = (toSvg(joints.hip).x + toSvg(joints.kneeL).x) / 2;
  assert.ok(sciatic[1][0] < thighMidX, "posterior is the smaller x for a limb hanging straight down");
  assert.ok(femoral[1][0] > thighMidX, "anterior is the larger x");
});

test("buildNerves: a missing joint throws an Error that names it", () => {
  const joints = jointsFrom(SQUAT);

  const withoutKnee = { ...joints };
  delete withoutKnee.kneeL;
  assert.throws(() => buildNerves(withoutKnee, HEIGHT_MM), /kneeL/);

  const withoutHand = { ...joints };
  delete withoutHand.handL;
  assert.throws(() => buildNerves(withoutHand, HEIGHT_MM), /handL/);

  const withoutShoulder = { ...joints };
  delete withoutShoulder.shoulder;
  assert.throws(() => buildNerves(withoutShoulder, HEIGHT_MM), /"shoulder"/);

  assert.throws(() => buildNerves(joints, 0), /heightMm/);
  assert.throws(() => buildNerves(null, HEIGHT_MM), /"hip"/);
});

/* ── stickFigureSvgBody ───────────────────────────────────────────────────── */

test("stickFigureSvgBody: one head circle, the poseSvg segments and a ground line", () => {
  const joints = jointsFrom(SQUAT);
  const body = stickFigureSvgBody(joints, HEIGHT_MM);

  assert.equal((body.match(/<circle /g) || []).length, 1, "one head circle");
  /* 9 near-side lines + 6 far-side lines + the ground line. */
  assert.equal((body.match(/<line /g) || []).length, 16);
  assert.ok(body.includes('stroke="#2b2f3a" stroke-width="1.2"'), "the near limb is dark");
  assert.ok(body.includes('stroke="#b6bac7" stroke-width="0.9"'), "the far limb is light");
  assert.ok(body.startsWith('<g fill="none" stroke="#b6bac7" stroke-width="0.3">'),
    "a thin ground line comes first");
  assert.ok(body.includes('stroke-linecap="round"'), "round caps, as poseSvg draws them");
  assert.ok(!body.includes("<svg"), "bare markup, no outer svg");

  const circle = /<circle cx="(-?[\d.]+)" cy="(-?[\d.]+)" r="(-?[\d.]+)"\/>/.exec(body);
  assert.ok(circle, "the head is a circle");
  const [cx, cy, radius] = circle.slice(1).map(Number);
  assert.ok(Math.abs(cx - toSvg(joints.head).x) < 0.01, "centred on the head joint");
  assert.ok(Math.abs(cy - toSvg(joints.head).y) < 0.01);
  const expected = Math.hypot(
    toSvg(joints.crown).x - toSvg(joints.chin).x,
    toSvg(joints.crown).y - toSvg(joints.chin).y,
  ) / 2;
  assert.ok(Math.abs(radius - expected) < 0.01, "radius is half the chin-crown distance: " + radius);

  const nearOnly = stickFigureSvgBody(joints, HEIGHT_MM, { far: false });
  assert.equal((nearOnly.match(/<line /g) || []).length, 10, "the ground plus the nine near-side lines");
  assert.ok(!nearOnly.includes('stroke="#b6bac7" stroke-width="0.9"'), "no far limb");
  assert.equal((nearOnly.match(/<circle /g) || []).length, 1);

  assert.throws(() => stickFigureSvgBody({ hip: { x: 0, z: 0 } }, HEIGHT_MM), /"mid"/);
  assert.throws(() => stickFigureSvgBody(joints, -1), /heightMm/);
});

/* ── buildSheet, innerSvg, viewBoxOf ─────────────────────────────────────── */

const CELL = { body: '<line x1="0" y1="0" x2="1" y2="1"/>', viewBox: "-5 -105 10 110" };
const SHEET_COLUMNS = [
  { label: "first", cells: [CELL, { body: '<circle cx="0" cy="0" r="2"/>', viewBox: "-5 -105 10 110" }] },
  { label: "second <&", cells: [CELL, { body: "", viewBox: "-5 -105 10 110" }] },
];

test("buildSheet: one root svg, one nested svg per cell, and every label escaped", () => {
  const sheet = buildSheet({
    title: "Sheet <&>",
    rows: ["p0", "p1 <&"],
    columns: SHEET_COLUMNS,
    cellW: 60,
    cellH: 110,
  });

  assert.ok(sheet.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 142 240"'),
    "one standalone svg of the laid-out grid: " + sheet.slice(0, 80));
  assert.equal((sheet.match(/<svg\b/g) || []).length, 5, "the root plus one per cell");
  assert.equal((sheet.match(/<\/svg>/g) || []).length, 5);
  assert.equal((sheet.match(/viewBox="-5 -105 10 110"/g) || []).length, 4, "every cell shares one frame");
  assert.equal((sheet.match(/<rect /g) || []).length, 5, "a white sheet and a grid line per cell");

  assert.ok(sheet.includes("Sheet &lt;&amp;&gt;"), "the title is escaped");
  assert.ok(sheet.includes(">p1 &lt;&amp;</text>"), "a row label is escaped");
  assert.ok(sheet.includes(">second &lt;&amp;</text>"), "a column label is escaped");
  assert.ok(!sheet.includes("p1 <&"), "the raw label never reaches the markup");
  assert.ok(!sheet.includes("Sheet <&>"));

  assert.ok(sheet.includes(CELL.body), "cell markup is written as markup");
  assert.ok(sheet.includes('<svg x="18" y="16" width="60" height="110" viewBox="-5 -105 10 110">'),
    "the first cell sits inside the left margin");

  assert.throws(() => buildSheet({ rows: [], columns: SHEET_COLUMNS }), /rows/);
  assert.throws(() => buildSheet({ rows: ["a"], columns: [] }), /columns/);
  assert.throws(() => buildSheet({ rows: ["a"], columns: SHEET_COLUMNS, cellW: 0 }), /cellW/);
});

test("innerSvg and viewBoxOf read back what a written SVG holds", () => {  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-8 -112 61 120">\n'
    + '<g id="skeleton"><path id="femur" d="M 0 0 l 1 1 z"/></g>\n</svg>\n';
  assert.equal(viewBoxOf(svg), "-8 -112 61 120");
  assert.equal(innerSvg(svg), '<g id="skeleton"><path id="femur" d="M 0 0 l 1 1 z"/></g>');
  assert.throws(() => innerSvg("no markup at all"), /root <svg>/);
  assert.throws(() => innerSvg('<svg viewBox="0 0 1 1"><g>'), /never closed/);
  assert.throws(() => viewBoxOf("<svg></svg>"), /viewBox/);

  const sheet = buildSheet({ title: "T", rows: ["p0"], columns: SHEET_COLUMNS });
  assert.match(viewBoxOf(sheet), /^0 0 [\d.]+ [\d.]+$/);
  assert.ok(innerSvg(sheet).startsWith("<rect "), "the sheet's children start with its background");
});

/* ── the sheet's own pieces, composed ────────────────────────────────────── */

/** A box mesh as the posing step writes it, in the millimetre side-view frame. */
function boxObj({ x0, x1, y0, y1, z0, z1, name = "mid" }) {
  const corners = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const faces = [[1, 2, 3, 4], [5, 8, 7, 6], [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 8, 4], [4, 8, 5, 1]];
  return ["o " + name, ...corners.map((corner) => "v " + corner.join(" ")),
    ...faces.map((face) => "f " + face.join(" "))].join("\n") + "\n";
}

test("a sheet of a layered drawing, the same drawing skeleton only, and the stick figure over it", () => {
  const dir = mkdtempSync(join(tmpdir(), "ramble-anatomy-stack-"));
  try {
    writeFileSync(join(dir, "skin.obj"), boxObj({ x0: -100, x1: 100, y0: -100, y1: -60, z0: 0, z1: HEIGHT_MM }));
    writeFileSync(join(dir, "femur.obj"), boxObj({ x0: -20, x1: 20, y0: -40, y1: -20, z0: 400, z1: 850, name: "right" }));
    const meshes = loadPosedDir(dir);
    const joints = jointsFrom(SQUAT);

    const all = buildLayeredSvg({
      vocab, heightMm: HEIGHT_MM, meshes, nerves: buildNerves(joints, HEIGHT_MM), credit: "A credit",
    });
    const bones = buildLayeredSvg({
      vocab, heightMm: HEIGHT_MM, meshes, layers: ["skeleton"],
    });
    assert.ok(all.report.ids.some((entry) => entry.id === "sciatic-nerve" && entry.layer === "nerves"),
      "the drawing carries the nerves");
    assert.deepEqual(bones.report.ids.map((entry) => entry.layer), ["skeleton"], "the skeleton drawing is bones only");

    const viewBox = viewBoxOf(all.svg);
    const stick = stickFigureSvgBody(joints, HEIGHT_MM);
    const sheet = buildSheet({
      title: "stack",
      rows: ["p0"],
      columns: [
        { label: "stick figure", cells: [{ body: stick, viewBox }] },
        { label: "own armature", cells: [{ body: innerSvg(all.svg), viewBox }] },
        { label: "armature only", cells: [{ body: innerSvg(bones.svg), viewBox }] },
        {
          label: "overlay",
          cells: [{ body: innerSvg(all.svg) + '\n<g opacity="0.5">' + stick + "</g>", viewBox }],
        },
      ],
    });

    assert.equal((sheet.match(/<svg\b/g) || []).length, 5, "the sheet plus four cells");
    assert.equal((sheet.match(new RegExp('viewBox="' + viewBox + '"', "g")) || []).length, 4,
      "every cell takes the drawing's frame, so they share one scale");
    assert.equal((sheet.match(/<path id="femur"/g) || []).length, 3,
      "the femur is in the armature and the overlay, not in the string of the labels");
    assert.equal((sheet.match(/<circle /g) || []).length, 2, "one head in the stick figure, one in the overlay");
    assert.ok(sheet.includes('<g opacity="0.5">'), "the overlay is half transparent");
    assert.ok(sheet.includes("<metadata>A credit</metadata>"), "the credit rides along in the nested drawing");
    assert.match(viewBoxOf(sheet), /^0 0 [\d.]+ [\d.]+$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── planRun / assertWindow ──────────────────────────────────────────────── */

const SAMPLE_DIR = resolve(mkdtempSync(join(tmpdir(), "ramble-anatomy-sheet-")));
writeFileSync(join(SAMPLE_DIR, "fake.json"), JSON.stringify({
  id: "fake", kind: "exercise", title: "Fake <two>", poses: [{ support: "feet" }, { support: "feet" }],
}));
writeFileSync(join(SAMPLE_DIR, "single.json"), JSON.stringify({
  id: "single", kind: "pose", title: "Single", pose: { support: "feet" },
}));
const OUT_DIR = join(SAMPLE_DIR, "out");
const CACHE_DIR = join(SAMPLE_DIR, "cache");
const CALL = { entry: "fake", cache: CACHE_DIR, out: OUT_DIR, libraryDir: SAMPLE_DIR };

test("planRun: landmarks, pose writes and runs, then the drawings, the sheet and the report", () => {
  const steps = planRun(CALL);
  assert.ok(Array.isArray(steps) && steps.length > 0);

  assert.equal(steps[0].kind, "landmarks", "the landmarks come first");
  assert.deepEqual(steps[0].argv.slice(0, 2), ["python3", "-I"]);
  assert.ok(steps[0].argv[2].endsWith(join("scripts", "ramble-anatomy", "pose", "landmarks.py")));
  assert.deepEqual(steps[0].argv.slice(3), ["--cache", CACHE_DIR, "--out", join(OUT_DIR, "landmarks.json")]);

  assert.equal(steps[1].what, "cross-check");
  assert.equal(steps[1].path, join(OUT_DIR, "cross-check.txt"));

  const poseWrites = steps.map((step, index) => (step.what === "pose-input" ? index : -1)).filter((index) => index >= 0);
  const poseRuns = steps.map((step, index) => (step.kind === "pose" ? index : -1)).filter((index) => index >= 0);
  assert.equal(poseWrites.length, 4, "two key positions and two variants");
  assert.equal(poseRuns.length, 4);
  for (let i = 0; i < 4; i += 1) {
    assert.equal(poseRuns[i], poseWrites[i] + 1, "each pose.json is written just before its run");
    assert.ok(poseWrites[i] > 1, "and after the landmarks and the cross-check");
  }
  assert.deepEqual(poseWrites.map((index) => steps[index].path), [
    join(OUT_DIR, "work", "fake-p0-figure", "pose.json"),
    join(OUT_DIR, "work", "fake-p0-native", "pose.json"),
    join(OUT_DIR, "work", "fake-p1-figure", "pose.json"),
    join(OUT_DIR, "work", "fake-p1-native", "pose.json"),
  ], "key positions outer, variants inner");

  for (const step of steps.filter((entry) => entry.kind === "pose")) {
    assert.deepEqual(step.argv.slice(0, 6), ["taskset", "-c", "12-31", "nice", "-n", "10"],
      "every posing run is bounded: " + step.argv.slice(0, 6).join(" "));
    assert.equal(step.argv[6], "/opt/blender/blender", "the default Blender");
    assert.deepEqual(step.argv.slice(7, 10), ["-b", "--factory-startup", "--python"]);
    assert.ok(step.argv[10].endsWith(join("scripts", "ramble-anatomy", "pose", "bpy_pose.py")));
    assert.equal(step.argv[11], "--");
    assert.equal(step.argv[12], "--cache");
    for (const flag of ["--landmarks", "--rig", "--vocab", "--pose", "--out", "--engine"]) {
      assert.ok(step.argv.includes(flag), "the run names " + flag);
    }
    assert.equal(step.argv[step.argv.indexOf("--engine") + 1], "blender");
    assert.equal(step.argv[step.argv.indexOf("--out") + 1],
      join(OUT_DIR, "work", "fake-p" + step.position + "-" + step.variant));
  }

  const firstDrawing = steps.findIndex((step) => step.what === "anatomy-svg");
  assert.ok(firstDrawing > Math.max(...poseRuns), "the drawings come after every posed mesh");
  assert.deepEqual(
    steps.filter((step) => step.kind === "write" && step.what.endsWith("-svg")).map((step) => step.path),
    [
      join(OUT_DIR, "fake-p0-figure.svg"),
      join(OUT_DIR, "fake-p0-figure-skeleton.svg"),
      join(OUT_DIR, "fake-p0-native.svg"),
      join(OUT_DIR, "fake-p0-native-skeleton.svg"),
      join(OUT_DIR, "fake-p1-figure.svg"),
      join(OUT_DIR, "fake-p1-figure-skeleton.svg"),
      join(OUT_DIR, "fake-p1-native.svg"),
      join(OUT_DIR, "fake-p1-native-skeleton.svg"),
    ],
  );

  const previews = steps.filter((step) => step.kind === "preview");
  assert.equal(previews.length, 9, "eight drawings and the sheet");
  for (const preview of previews) {
    assert.equal(preview.argv[0], "rsvg-convert");
    assert.equal(preview.argv[1], "-b");
    assert.equal(preview.argv[2], "white");
  }
  assert.deepEqual(previews[0].argv.slice(3, 5), ["-h", "1400"]);
  assert.deepEqual(previews[8].argv.slice(3, 5), ["-w", "2600"], "the sheet is the wide one");

  const sheetAt = steps.findIndex((step) => step.what === "sheet");
  assert.ok(sheetAt > firstDrawing);
  assert.equal(steps[sheetAt].path, join(OUT_DIR, "fake-sheet.svg"));
  assert.ok(previews[8].argv.includes(join(OUT_DIR, "fake-sheet.svg")));
  assert.equal(steps[steps.length - 1].what, "report");
  assert.equal(steps[steps.length - 1].path, join(OUT_DIR, "report.json"));

  for (const step of steps.filter((entry) => entry.kind === "write")) {
    assert.ok(step.path.startsWith(sep) || /^[A-Za-z]:/.test(step.path), "a plan names absolute paths: " + step.path);
  }
});

test("planRun: --skip-landmarks drops the landmark step, --variants picks the columns", () => {
  const steps = planRun({ ...CALL, skipLandmarks: true });
  assert.equal(steps.some((step) => step.kind === "landmarks"), false, "no landmark step");
  assert.equal(steps[0].what, "cross-check", "the cross-check moves to the front");

  const figureOnly = planRun({ ...CALL, variants: "figure" });
  assert.equal(figureOnly.filter((step) => step.kind === "pose").length, 2);
  assert.equal(figureOnly.some((step) => (step.path || "").includes("-native")), false);

  assert.throws(() => planRun({ ...CALL, variants: "figure,mirror" }), /mirror/);
  assert.throws(() => planRun({ ...CALL, cores: "all" }), /--cores/);
  assert.throws(() => planRun({ ...CALL, entry: "no-such-entry" }), /no-such-entry/);
  assert.throws(() => planRun({ entry: "fake", out: OUT_DIR, libraryDir: SAMPLE_DIR }), /--cache/);
});

test("planRun: the numpy engine runs bpy_pose.py under python3, still bounded", () => {
  const steps = planRun({ ...CALL, engine: "numpy", cores: "4,8-11" });
  const run = steps.find((step) => step.kind === "pose");
  assert.deepEqual(run.argv.slice(0, 6), ["taskset", "-c", "4,8-11", "nice", "-n", "10"]);
  assert.equal(run.argv[6], "python3");
  assert.equal(run.argv[7], "-I");
  assert.ok(run.argv[8].endsWith(join("scripts", "ramble-anatomy", "pose", "bpy_pose.py")));
  assert.equal(run.argv[run.argv.indexOf("--engine") + 1], "numpy");
  assert.throws(() => planRun({ ...CALL, engine: "pybullet" }), /pybullet/);
});

test("planRun: an entry with a single pose has one key position", () => {
  const steps = planRun({ ...CALL, entry: "single" });
  const writes = steps.filter((step) => step.what === "pose-input");
  assert.equal(writes.length, 2, "one key position, both variants");
  for (const write of writes) {
    assert.match(write.path, /single-p0-(figure|native)[\\/]pose\.json$/);
  }
  assert.equal(steps.filter((step) => step.kind === "pose").length, 2);
  assert.equal(steps.some((step) => (step.path || "").includes("-p1-")), false, "no second key position");
});

test("assertWindow: only a registered CPU window opens the gate", () => {
  assert.throws(() => assertWindow({}), /registered CPU window/);
  assert.throws(() => assertWindow({ RAMBLE_ANATOMY_WINDOW: "" }), /registered CPU window/);
  assert.throws(() => assertWindow({ RAMBLE_ANATOMY_WINDOW: "open" }), /registered CPU window/);
  assert.throws(() => assertWindow(undefined), /registered CPU window/);
  assert.equal(assertWindow({ RAMBLE_ANATOMY_WINDOW: "registered" }), true);
});

/* ── the CLI ─────────────────────────────────────────────────────────────── */

test("the CLI: --dry-run prints the plan and writes nothing, and a closed window refuses to run", () => {
  const dryOut = join(SAMPLE_DIR, "dry-out");
  const printed = execFileSync(process.execPath, [
    RENDER_SAMPLE,
    "--entry", "body-squat", "--cache", CACHE_DIR, "--out", dryOut, "--dry-run",
  ], { encoding: "utf8" });
  assert.match(printed, /landmarks +python3 -I .*landmarks\.py/);
  assert.match(printed, /cross-check\.txt/);
  assert.match(printed, /taskset -c 12-31 nice -n 10 .*bpy_pose\.py/);
  assert.match(printed, /body-squat-p1-figure\.svg/);
  assert.match(printed, /body-squat-sheet\.svg/);
  assert.match(printed, /report\.json/);
  assert.equal(existsSync(dryOut), false, "a dry run creates no output directory");

  /* A library entry the CLI can find, so it gets as far as the window check. */
  const closedOut = join(SAMPLE_DIR, "closed-out");
  const cleanEnv = { ...process.env };
  delete cleanEnv.RAMBLE_ANATOMY_WINDOW;
  assert.throws(
    () => execFileSync(process.execPath, [
      RENDER_SAMPLE,
      "--entry", "body-squat", "--cache", CACHE_DIR, "--out", closedOut,
    ], { encoding: "utf8", env: cleanEnv, stdio: "pipe" }),
    (err) => {
      assert.match(String(err.stderr), /registered CPU window/);
      return true;
    },
  );
  assert.equal(existsSync(closedOut), false, "nothing runs outside a window");

  assert.throws(
    () => execFileSync(process.execPath, [RENDER_SAMPLE, "--out", closedOut, "--dry-run"],
      { encoding: "utf8", stdio: "pipe" }),
    (err) => {
      assert.match(String(err.stderr), /--entry/);
      return true;
    },
  );
});

/* The scratch library directory goes when the file is done. */
process.on("exit", () => rmSync(SAMPLE_DIR, { recursive: true, force: true }));