/**
 * Ramble anatomy pipeline — the Node half (poses, OBJ reading, outlining, SVG).
 *
 * Everything here is synthetic: tiny hand-written OBJ boxes stand in for the
 * posed BodyParts3D meshes, and rasters are built pixel by pixel. Nothing needs
 * the source models, Blender or a network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadPosedDir, parseObj } from "../scripts/ramble-anatomy/lib/obj.mjs";
import { morphClose, rasterizeTriangles } from "../scripts/ramble-anatomy/lib/raster.mjs";
import { pathData, traceLoops } from "../scripts/ramble-anatomy/lib/trace.mjs";
import { buildLayeredSvg } from "../scripts/ramble-anatomy/lib/svg-writer.mjs";
import { buildPoseInput } from "../scripts/ramble-anatomy/lib/pose-input.mjs";
import { crossCheck, formatCrossCheck } from "../scripts/ramble-anatomy/lib/cross-check.mjs";

const require = createRequire(import.meta.url);
const Figure = require("../bundles/ramble/server/moves/figure.cjs");

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const RIG_FILE = join(REPO, "scripts", "ramble-anatomy", "rig.json");
const VOCAB_FILE = join(REPO, "bundles", "ramble", "server", "moves", "anatomy", "vocab.json");
const vocab = JSON.parse(readFileSync(VOCAB_FILE, "utf8")).vocab;

/** Landmark names, as the shared pipeline contract lists them. */
const LANDMARK_NAMES = [
  "hipR", "hipL", "kneeR", "kneeL", "ankleR", "ankleL", "toeR", "toeL",
  "shoulderR", "shoulderL", "elbowR", "elbowL", "wristR", "wristL", "handR", "handL",
  "hipMid", "waistMid", "shoulderMid", "chin", "crown",
];

/* ── parseObj ─────────────────────────────────────────────────────────────── */

const objText = (...lines) => lines.flat().join("\n") + "\n";

test("parseObj: one triangle, one object, vertices re-indexed from zero", () => {
  const parsed = parseObj(objText("v 0 0 0", "v 1 0 0", "v 0 1 0", "f 1 2 3"));
  assert.equal(parsed.objects.length, 1);
  const [object] = parsed.objects;
  assert.equal(object.name, "default", "an object before any o/g line is 'default'");
  assert.ok(object.positions instanceof Float64Array);
  assert.ok(object.indices instanceof Uint32Array);
  assert.deepEqual([...object.positions], [0, 0, 0, 1, 0, 0, 0, 1, 0]);
  assert.deepEqual([...object.indices], [0, 1, 2]);
});

test("parseObj: a quad is fan-triangulated, and a/b/c references reach the same vertices", () => {
  const parsed = parseObj(objText(
    "v 0 0 0", "v 1 0 0", "v 1 1 0", "v 0 1 0",
    "vt 0 0", "vn 0 0 1",
    "f 1/1/1 2/1/1 3/1/1 4/1/1",
    "f 1//1 3//1 2//1",
  ));
  const [object] = parsed.objects;
  assert.equal(object.indices.length, 9, "a quad is two triangles, the extra face one more");
  assert.deepEqual([...object.indices], [0, 1, 2, 0, 2, 3, 0, 2, 1]);
  assert.equal(object.positions.length, 12, "four vertices, x y z each");
});

test("parseObj: negative indices count back from the vertices read so far", () => {
  const parsed = parseObj(objText("v 0 0 0", "v 1 0 0", "v 0 1 0", "v 9 9 9", "f -3 -2 -1"));
  assert.deepEqual([...parsed.objects[0].indices], [0, 1, 2], "the three vertices named, re-indexed locally");
  assert.deepEqual([...parsed.objects[0].positions], [1, 0, 0, 0, 1, 0, 9, 9, 9],
    "only the vertices the face names, in first-reference order");
});

test("parseObj: two o objects keep their own vertices, each re-indexed locally", () => {
  const parsed = parseObj(objText(
    "v 0 0 0", "v 1 0 0", "v 0 1 0",
    "v 5 5 5", "v 6 5 5", "v 5 6 5",
    "o right", "f 1 2 3",
    "o left", "f 4 5 6",
  ));
  assert.deepEqual(parsed.objects.map((object) => object.name), ["right", "left"]);
  assert.deepEqual([...parsed.objects[0].positions], [0, 0, 0, 1, 0, 0, 0, 1, 0]);
  assert.deepEqual([...parsed.objects[0].indices], [0, 1, 2]);
  assert.deepEqual([...parsed.objects[1].positions], [5, 5, 5, 6, 5, 5, 5, 6, 5],
    "the second object does not carry the first object's vertices");
  assert.deepEqual([...parsed.objects[1].indices], [0, 1, 2], "and its indices start at zero again");
});

test("parseObj: an object with no faces is dropped, a nameless o/g is 'default', junk is ignored", () => {
  const parsed = parseObj(objText(
    "v 0 0 0", "v 1 0 0", "v 0 1 0",
    "o dropped-empty",
    "g",
    "s 1", "usemtl skin", "# a comment", "",
    "f 1 2 3",
  ));
  assert.equal(parsed.objects.length, 1);
  assert.equal(parsed.objects[0].name, "default");
  assert.deepEqual([...parsed.objects[0].indices], [0, 1, 2]);
  assert.deepEqual(parseObj("").objects, [], "empty text holds no objects");
});

test("loadPosedDir reads every .obj in a directory and names it after the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "ramble-anatomy-obj-"));
  try {
    writeFileSync(join(dir, "skin.obj"), objText("v 0 0 0", "v 1 0 0", "v 0 1 0", "f 1 2 3"));
    writeFileSync(join(dir, "femur.obj"), objText("v 0 0 0", "v 2 0 0", "v 0 2 0", "f 1 2 3"));
    writeFileSync(join(dir, "_manifest.json"), "{}");
    const meshes = loadPosedDir(dir);
    assert.deepEqual(Object.keys(meshes).sort(), ["femur", "skin"]);
    assert.equal(meshes.femur.objects[0].positions[3], 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── rasterizeTriangles + morphClose + traceLoops ─────────────────────────── */

/** Two triangles covering the rectangle x0,y0 to x1,y1. */
const quad = (x0, y0, x1, y1) => [x0, y0, x1, y0, x1, y1, x0, y0, x1, y1, x0, y1];

const rasterOf = (tris, bounds) => rasterizeTriangles(Float64Array.from(tris), bounds);

/** A raster from a picture: '#' is covered, anything else is not. */
function rasterFromPicture(rows, { pxPerUnit = 1, originX = 0, originY = 0 } = {}) {
  const height = rows.length;
  const width = rows[0].length;
  const data = new Uint8Array(width * height);
  rows.forEach((row, y) => {
    assert.equal(row.length, width, "every row is the same length");
    for (let x = 0; x < width; x++) if (row[x] === "#") data[y * width + x] = 1;
  });
  return { width, height, pxPerUnit, originX, originY, data };
}

const areaOf = (loop) => {
  let sum = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
};

/** The point count a loop's own path data carries (M x y, then l pairs). */
function pointsInPath(d) {
  let points = 0;
  for (const chunk of d.trim().split("z").map((part) => part.trim()).filter(Boolean)) {
    const move = /^M\s+(-?[\d.]+)\s+(-?[\d.]+)/.exec(chunk);
    assert.ok(move, "each loop starts with M x y, got: " + chunk.slice(0, 24));
    points += 1;
    const rest = chunk.slice(move[0].length).trim();
    if (rest === "") continue;
    const line = /^l\s+(-?[\d.\s-]+)$/.exec(rest);
    assert.ok(line, "the rest of a loop is one relative l command, got: " + rest.slice(0, 24));
    const numbers = line[1].trim().split(/\s+/).map(Number);
    assert.equal(numbers.length % 2, 0, "an l command comes in pairs");
    points += numbers.length / 2;
  }
  return points;
}

test("rasterizeTriangles: a filled square is one loop with the square's area", () => {
  const bounds = { minX: -5, minY: -5, maxX: 15, maxY: 15, pxPerUnit: 10 };
  const raster = rasterOf(quad(0, 0, 10, 10), bounds);
  assert.equal(raster.width, 200);
  assert.equal(raster.height, 200);
  assert.equal(raster.pxPerUnit, 10);
  assert.equal(raster.originX, -5);
  assert.equal(raster.originY, -5);
  assert.equal(raster.data[raster.width * 100 + 100], 1, "the middle is covered");
  assert.equal(raster.data[raster.width * 10 + 10], 0, "outside the square is not");

  const loops = traceLoops(raster);
  assert.equal(loops.length, 1);
  assert.ok(Math.abs(areaOf(loops[0]) - 100) < 0.5, "the loop's area is the square's, got " + areaOf(loops[0]));
  for (const [x, y] of loops[0]) {
    assert.ok(x >= -0.001 && x <= 10.001, "x stays inside the square: " + x);
    assert.ok(y >= -0.001 && y <= 10.001, "y stays inside the square: " + y);
  }
});

test("rasterizeTriangles: absurd sizes and empty bounds are refused", () => {
  assert.throws(() => rasterOf(quad(0, 0, 1, 1), {
    minX: 0, minY: 0, maxX: 100000, maxY: 100000, pxPerUnit: 10,
  }), /pixel limit/);
  assert.throws(() => rasterOf(quad(0, 0, 1, 1), { minX: 1, minY: 0, maxX: 1, maxY: 1, pxPerUnit: 10 }), /bounds are empty/);
  assert.throws(() => rasterOf(quad(0, 0, 1, 1), { minX: 0, minY: 0, maxX: 1, maxY: 1, pxPerUnit: 0 }), /pxPerUnit/);
});

test("morphClose fills a one-pixel pin-hole and leaves the outline where it was", () => {
  const pinholed = rasterFromPicture([
    "#####",
    "#####",
    "##.##",
    "#####",
    "#####",
  ]);
  const closed = morphClose(pinholed);
  assert.notEqual(closed, pinholed, "a new raster comes back");
  assert.equal(closed.data[2 * 5 + 2], 1, "the pin-hole is filled");
  assert.equal(closed.data[0], 1);
  assert.equal(closed.width, 5);
  assert.equal(closed.pxPerUnit, pinholed.pxPerUnit);
  for (const [index, value] of pinholed.data.entries()) {
    if (value === 1) assert.equal(closed.data[index], 1, "closing never removes a covered pixel of a solid blob");
  }
  assert.deepEqual(traceLoops(closed).length, 1, "and the blob now has one boundary");
});

test("traceLoops: a ring gives an outer boundary and a hole, with opposite areas", () => {
  const ring = rasterFromPicture([
    "##########",
    "##########",
    "##      ##",
    "##      ##",
    "##      ##",
    "##      ##",
    "##      ##",
    "##      ##",
    "##########",
    "##########",
  ]);
  const loops = traceLoops(ring);
  assert.equal(loops.length, 2, "one outline, one hole");
  const areas = loops.map(areaOf).sort((a, b) => a - b);
  assert.ok(areas[0] < 0 && areas[1] > 0, "the hole runs the other way round: " + areas.join(", "));
  assert.equal(Math.abs(areas[0]), 36, "the hole is the 6x6 gap");
  assert.equal(areas[1], 100, "the outline is the whole 10x10 square");
});

test("traceLoops: two disjoint squares stay two loops", () => {
  const loops = traceLoops(rasterFromPicture([
    "###....###",
    "###....###",
    "###....###",
  ]));
  assert.equal(loops.length, 2);
  for (const loop of loops) assert.equal(Math.abs(areaOf(loop)), 9);
});

test("traceLoops: two pixels touching at a corner stay two loops", () => {
  const loops = traceLoops(rasterFromPicture(["#.", ".#"]));
  assert.equal(loops.length, 2, "a corner touch does not merge the outlines");
  for (const loop of loops) assert.equal(Math.abs(areaOf(loop)), 1);
});

test("traceLoops: coordinates are in the raster's own units, and tiny loops are dropped", () => {
  const shifted = rasterFromPicture(["###", "###"], { pxPerUnit: 2, originX: 100, originY: -50 });
  const [loop] = traceLoops(shifted);
  assert.deepEqual(loop, [[100, -50], [101.5, -50], [101.5, -49], [100, -49]]);
  assert.equal(Math.abs(areaOf(loop)), 1.5, "3 x 3 pixels at 2 px per unit is 1.5 x 1.5 units");

  const one = rasterFromPicture(["#"], { pxPerUnit: 20 });
  assert.deepEqual(traceLoops(one), [], "a 0.05 unit square is below the default area floor");
  assert.equal(traceLoops(one, { minArea: 0.001 }).length, 1, "and stays when the floor is lowered");
});

test("pathData: deterministic, closed, and its numbers reproduce the point count", () => {
  const ring = rasterFromPicture([
    "##########",
    "##      ##",
    "##      ##",
    "##########",
  ]);
  const loops = traceLoops(ring);
  const d = pathData(loops);
  assert.equal(pathData(loops), d, "the same loops give the same path");
  assert.equal(pathData(loops.slice()), d, "and so does an equal copy");
  assert.ok(d.startsWith("M "), "a path starts with a move");
  assert.ok(d.endsWith("z"), "and every loop closes");

  const expected = loops.reduce((total, loop) => total + loop.length, 0);
  assert.equal(pointsInPath(d), expected, "the path carries exactly the loop's points");

  assert.deepEqual(pathData([[[0, 0], [2, 0], [2, 1]]]), "M 0 0 l 2 0 0 1 z",
    "a closed loop closes without repeating its first point");
  assert.equal(pathData([[[0, 0.129], [1.005, 1.0049], [0, 2]]], 1), "M 0 0.1 l 1 0.9 -1 1 z",
    "numbers are rounded once and carry no trailing zeros");
});

/* ── buildLayeredSvg ──────────────────────────────────────────────────────── */

/** A posed box as the posing step writes it, in the millimetre side-view frame. */
function boxMesh({ x0, x1, y0, y1, z0, z1, name = "mid" }) {
  const corners = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const faces = [[1, 2, 3, 4], [5, 8, 7, 6], [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 8, 4], [4, 8, 5, 1]];
  return parseObj(objText(
    "o " + name,
    corners.map((corner) => "v " + corner.join(" ")),
    faces.map((face) => "f " + face.join(" ")),
  ));
}

/** The meshes a solved pose would write: skin, one bone, three muscles, two that must not draw. */
const MESHES = {
  skin: boxMesh({ x0: -100, x1: 100, y0: -100, y1: -60, z0: 0, z1: 1700 }),
  femur: boxMesh({ x0: -20, x1: 20, y0: -40, y1: -20, z0: 400, z1: 800 }),
  /* Two objects in one file: the far and the near side of the same muscle. */
  quadriceps: {
    objects: [
      ...boxMesh({ x0: -30, x1: 30, y0: -30, y1: -10, z0: 420, z1: 780, name: "right" }).objects,
      ...boxMesh({ x0: -30, x1: 30, y0: -32, y1: -12, z0: 420, z1: 780, name: "left" }).objects,
    ],
  },
  abdominals: boxMesh({ x0: -25, x1: 25, y0: -20, y1: -14, z0: 900, z1: 1300 }),
  hamstrings: boxMesh({ x0: -25, x1: 25, y0: -8, y1: 2, z0: 430, z1: 770 }),
  rhomboids: boxMesh({ x0: -40, x1: 40, y0: -60, y1: -50, z0: 1000, z1: 1400 }),
  "not-a-part": boxMesh({ x0: 0, x1: 10, y0: 0, y1: 10, z0: 0, z1: 10 }),
};

const svgOf = (extra = {}) => buildLayeredSvg({ vocab, heightMm: 1700, meshes: MESHES, ...extra });

test("buildLayeredSvg: only skin and side-view bones and muscles are drawn", () => {
  const { svg, report } = svgOf({ title: "Squat" });
  const ids = [...svg.matchAll(/<path id="([^"]+)"/g)].map((match) => match[1]);
  const vocabIds = new Set(vocab.map((record) => record.id));
  for (const id of ids) {
    assert.ok(id === "skin" || vocabIds.has(id), "every path is the skin or a vocabulary id, got " + id);
  }
  assert.ok(ids.includes("skin") && ids.includes("femur") && ids.includes("quadriceps"));
  assert.ok(!ids.includes("rhomboids"), "sideView false is not drawn from the side");
  assert.ok(!ids.includes("not-a-part"), "an id the vocabulary does not know is skipped");
  assert.deepEqual(report.ids.map((entry) => entry.id), ids, "the report lists the paths in drawing order");
  assert.equal(new Set(ids).size, ids.length, "one path per id");
});

test("buildLayeredSvg: the layer groups come in skin, skeleton, muscles, nerves order", () => {
  const { svg } = svgOf({ nerves: [{ id: "sciatic-nerve", points: [[0, -20], [-2, -60]] }] });
  const order = ["skin", "skeleton", "muscles", "nerves"].map((layer) => svg.indexOf('<g id="' + layer + '"'));
  assert.ok(order.every((at) => at >= 0), "every layer is present: " + order.join(", "));
  for (let i = 1; i < order.length; i++) {
    assert.ok(order[i - 1] < order[i], "layer " + i + " follows layer " + (i - 1));
  }
  assert.equal((svg.match(/<g /g) || []).length, 4, "one group per layer");
  assert.equal((svg.match(/<\/g>/g) || []).length, 4, "and each group is closed");
  assert.equal((svg.match(/<svg /g) || []).length, 1, "one svg element");
  assert.ok(svg.trimEnd().endsWith("</svg>"));

  const subset = svgOf({ layers: ["skin", "nerves"] }).svg;
  assert.ok(subset.includes('<g id="skin"'));
  assert.ok(!subset.includes('<g id="skeleton"'), "a layer that was not asked for is not written");
  assert.ok(!subset.includes('<g id="muscles"'));
  assert.ok(!subset.includes('<g id="nerves"'), "an empty layer is left out");
  assert.equal((subset.match(/<g /g) || []).length, (subset.match(/<\/g>/g) || []).length);
});

test("buildLayeredSvg: within a layer the far side is drawn first", () => {
  const { svg, report } = svgOf();
  const at = (id) => svg.indexOf('<path id="' + id + '"');
  assert.ok(at("femur") >= 0);
  assert.ok(at("quadriceps") < at("abdominals"), "quadriceps (Y -20) is behind abdominals (Y -17)");
  assert.ok(at("abdominals") < at("hamstrings"), "abdominals is behind hamstrings (Y -3)");
  const muscles = report.ids.filter((entry) => entry.layer === "muscles").map((entry) => entry.id);
  assert.deepEqual(muscles, ["quadriceps", "abdominals", "hamstrings"]);
  assert.ok(report.ids.find((entry) => entry.id === "quadriceps").loops >= 1,
    "two objects of one mesh become one outline");
});

test("buildLayeredSvg: muscle fill follows the vocabulary's area, bone and skin do not", () => {
  const { svg } = svgOf();
  const pathFor = (id) => svg.match(new RegExp('<path id="' + id + '"[^>]*>'))[0];
  assert.ok(pathFor("quadriceps").includes('fill="#d9822b"'), "a lower-body muscle is orange");
  assert.ok(pathFor("hamstrings").includes('fill="#d9822b"'));
  assert.ok(pathFor("abdominals").includes('fill="#b5446e"'), "a core muscle has its own red");
  assert.ok(!pathFor("femur").includes("fill="), "the bone takes its fill from the group");
  assert.ok(!pathFor("skin").includes("fill="), "and so does the skin");
  assert.match(svg, /<g id="skeleton" fill="#f3efe6"/);
  assert.match(svg, /<g id="muscles" fill-opacity="0\.62"/);
  assert.ok(!/<script/i.test(svg), "no scripts");
  assert.ok(!/<style/i.test(svg), "no css");
  assert.ok(!/\son[A-Za-z]+\s*=/.test(svg), "no event handlers");
});

test("buildLayeredSvg: the credit is escaped in metadata, and absent when not given", () => {
  const credit = "Someone <me> & a friend";
  const { svg } = svgOf({ credit });
  assert.ok(svg.includes("<metadata>Someone &lt;me&gt; &amp; a friend</metadata>"), "escaped, in metadata");
  assert.ok(!svg.includes("<me>"), "the raw text never reaches the markup");
  assert.equal((svg.match(/<metadata>/g) || []).length, 1);

  for (const missing of [undefined, "", null]) {
    const bare = svgOf({ credit: missing }).svg;
    assert.ok(!bare.includes("<metadata>"), "no credit, no metadata element");
  }
  assert.match(svgOf({ title: "Squat <1> & 2" }).svg, /<title>Squat &lt;1&gt; &amp; 2<\/title>/);
});

test("buildLayeredSvg: nerves are drawn only for nerve ids, as open paths", () => {
  const { svg, report } = svgOf({
    nerves: [
      { id: "sciatic-nerve", points: [[0, -20], [-2, -60], [1, -100]] },
      { id: "chest", points: [[0, 0], [1, 1]] },
      { id: "tibial-nerve", points: [[0, 0]] },
      { id: "made-up-nerve", points: [[0, 0], [1, 1]] },
      { id: 7, points: [[0, 0], [1, 1]] },
      null,
    ],
  });
  const ids = [...svg.matchAll(/<path id="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(ids.includes("sciatic-nerve"));
  assert.ok(!ids.includes("chest"), "a muscle id is not a nerve");
  assert.ok(!ids.includes("tibial-nerve"), "a strand of fewer than two points has no path");
  assert.ok(!ids.includes("made-up-nerve"), "an id the vocabulary does not know is not a nerve");
  assert.match(svg, /<g id="nerves" fill="none"/);
  const nervePath = svg.match(/<path id="sciatic-nerve" d="([^"]+)"\/>/);
  assert.ok(nervePath, "the nerve is a path");
  assert.ok(/^M\s+-?[\d.]+\s+-?[\d.]+(\s+L\s+-?[\d.]+\s+-?[\d.]+)+$/.test(nervePath[1]), nervePath[1]);
  assert.ok(!nervePath[1].includes("z"), "a nerve is an open line, not a closed loop");
  assert.ok(report.ids.some((entry) => entry.id === "sciatic-nerve" && entry.layer === "nerves"));
});

test("buildLayeredSvg: the report counts bytes and stays inside the budget", () => {
  const { svg, report } = svgOf({ credit: "Credit line", title: "Squat" });
  assert.equal(report.bytes, Buffer.byteLength(svg, "utf8"));
  assert.ok(Number.isInteger(report.gzipBytes) && report.gzipBytes > 0, "gzip size is a positive whole number");
  assert.ok(report.gzipBytes < report.bytes, "a list of path data compresses");
  assert.equal(report.budgetBytes, 25600);
  assert.equal(report.withinBudget, report.gzipBytes <= report.budgetBytes);
  assert.match(report.viewBox, /^-?[\d.]+ -?[\d.]+ [\d.]+ [\d.]+$/);
  for (const entry of report.ids) {
    assert.ok(Number.isInteger(entry.bytes) && entry.bytes > 0, entry.id + " has a byte count");
    assert.ok(entry.loops >= 1 && entry.points >= 3, entry.id + " has a real outline");
  }
  const [minX, minY, width, height] = report.viewBox.split(" ").map(Number);
  assert.ok(width > 0 && height > 0);
  assert.ok(Math.abs(height - 108) < 0.5, "the drawing is 100 units of figure plus the pad on both ends, got " + height);
  assert.ok(minX < 0 && minY < 0, "the frame reaches past the figure in both directions");
});

test("buildLayeredSvg: nothing to draw is still a whole svg, and junk ids are ignored", () => {
  const empty = buildLayeredSvg({ vocab, heightMm: 1700, meshes: {} });
  assert.match(empty.svg, /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="[^"]+">/);
  assert.equal(empty.report.ids.length, 0);
  assert.ok(!empty.svg.includes("<g "), "no layers means no groups");

  const nothing = buildLayeredSvg({ vocab, heightMm: 1700, meshes: { rhomboids: MESHES.rhomboids } });
  assert.equal(nothing.report.ids.length, 0, "a mesh that is not drawn from the side leaves no path");

  assert.throws(() => buildLayeredSvg({ vocab, heightMm: 0, meshes: {} }), /heightMm/);
  assert.throws(() => buildLayeredSvg({ vocab, heightMm: 1700, meshes: [] }), /meshes/);
});

/* ── buildPoseInput ───────────────────────────────────────────────────────── */

const LANDMARKS = { heightMm: 1700, ratios: { ...Figure.SEGMENTS } };

test("buildPoseInput: body-squat position 0 stands on the floor with the height echoed", () => {
  const pose = buildPoseInput({ entryId: "body-squat", position: 0, variant: "figure", landmarks: LANDMARKS });
  assert.equal(pose.version, 1);
  assert.equal(pose.entry, "body-squat");
  assert.equal(pose.position, 0);
  assert.equal(pose.variant, "figure");
  assert.equal(pose.heightMm, 1700);
  assert.equal(typeof pose.pose.support, "string", "the clamped pose travels with the joints");
  for (const [name, joint] of Object.entries(pose.joints)) {
    assert.ok(Number.isFinite(joint.x) && Number.isFinite(joint.z), name + " is a finite point");
    assert.ok(joint.z >= -1e-6, name + " is not below the floor (z = " + joint.z + ")");
  }
  assert.equal(pose.joints.crown.x, pose.joints.chin.x + 2 * (pose.joints.head.x - pose.joints.chin.x));
  assert.equal(pose.joints.crown.z, pose.joints.chin.z + 2 * (pose.joints.head.z - pose.joints.chin.z));
  assert.ok(pose.joints.crown.z > pose.joints.chin.z, "the crown is above the chin");
});

test("buildPoseInput: position 1 of the squat sits lower than position 0", () => {
  const stand = buildPoseInput({ entryId: "body-squat", position: 0, landmarks: LANDMARKS });
  const squat = buildPoseInput({ entryId: "body-squat", position: 1, landmarks: LANDMARKS });
  assert.equal(squat.position, 1);
  assert.ok(squat.joints.hip.z < stand.joints.hip.z, "the hip drops into the squat");
  assert.ok(squat.joints.crown.z < stand.joints.crown.z, "and so does the head");
  assert.notDeepEqual(squat.pose, stand.pose, "the two key positions are different poses");
});

test("buildPoseInput: an unknown entry, a missing position and an unknown variant throw", () => {
  assert.throws(() => buildPoseInput({ entryId: "no-such-exercise", landmarks: LANDMARKS }), /no-such-exercise/);
  assert.throws(() => buildPoseInput({ entryId: "body-squat", position: 5, landmarks: LANDMARKS }), /position 5/);
  assert.throws(() => buildPoseInput({ entryId: "body-squat", variant: "mirror", landmarks: LANDMARKS }), /variant/);
  assert.throws(() => buildPoseInput({ entryId: "body-squat", landmarks: {} }), /heightMm/);
  assert.throws(() => buildPoseInput({ entryId: "body-squat" }), /landmarks/);
});

test("buildPoseInput: variant native measures with the ratios and always restores SEGMENTS", () => {
  const before = { ...Figure.SEGMENTS };
  const figureSoled = buildPoseInput({ entryId: "body-squat", position: 0, variant: "figure", landmarks: LANDMARKS });
  const nativeSoled = buildPoseInput({
    entryId: "body-squat", position: 0, variant: "native",
    landmarks: { heightMm: 1700, ratios: { trunk: 0.5 } },
  });
  assert.equal(nativeSoled.variant, "native");
  const half = (pose) => Math.hypot(pose.joints.mid.x - pose.joints.hip.x, pose.joints.mid.z - pose.joints.hip.z);
  assert.ok(half(nativeSoled) > half(figureSoled) * 1.5,
    "a taller trunk ratio makes the trunk longer (" + half(figureSoled).toFixed(1) + " -> " + half(nativeSoled).toFixed(1) + ")");
  assert.deepEqual({ ...Figure.SEGMENTS }, before, "the figure engine's own numbers are back");

  assert.throws(() => buildPoseInput({
    entryId: "body-squat", position: 0, variant: "native",
    landmarks: { heightMm: 1700, ratios: { trunk: 0.5, thigh: NaN } },
  }), /ratios\.thigh/);
  assert.deepEqual({ ...Figure.SEGMENTS }, before, "and they are back after a failed solve too");

  assert.throws(() => buildPoseInput({
    entryId: "body-squat", variant: "native", landmarks: { heightMm: 1700 },
  }), /ratios/);
});

test("buildPoseInput: a library entry with a single pose only has position 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "ramble-anatomy-pose-"));
  try {
    writeFileSync(join(dir, "single.json"), JSON.stringify({
      id: "single", kind: "pose", pose: { rootAngle: 10, kneeL: 20 },
    }));
    const pose = buildPoseInput({ entryId: "single", position: 0, landmarks: LANDMARKS, libraryDir: dir });
    assert.equal(pose.entry, "single");
    assert.equal(pose.pose.rootAngle, 10);
    assert.equal(pose.pose.kneeR, 0, "the pose is clamped and filled out");
    assert.throws(() => buildPoseInput({ entryId: "single", position: 1, landmarks: LANDMARKS, libraryDir: dir }),
      /only position 0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildPoseInput: the CLI writes the pose.json for one key position", () => {
  const dir = mkdtempSync(join(tmpdir(), "ramble-anatomy-cli-"));
  try {
    const landmarksPath = join(dir, "landmarks.json");
    const outPath = join(dir, "pose.json");
    writeFileSync(landmarksPath, JSON.stringify({ version: 1, heightMm: 1700, ratios: { ...Figure.SEGMENTS } }));
    execFileSync(process.execPath, [
      join(REPO, "scripts", "ramble-anatomy", "lib", "pose-input.mjs"),
      "--entry", "body-squat", "--position", "1", "--variant", "figure",
      "--landmarks", landmarksPath, "--out", outPath,
    ], { encoding: "utf8" });
    const written = readFileSync(outPath, "utf8");
    assert.ok(written.startsWith("{\n  \"version\": 1,"), "written with a two-space indent");
    assert.ok(written.endsWith("}\n"));
    const pose = JSON.parse(written);
    assert.equal(pose.entry, "body-squat");
    assert.equal(pose.position, 1);
    assert.equal(pose.heightMm, 1700);
    assert.ok(pose.joints.crown.z > pose.joints.chin.z);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── rig.json ─────────────────────────────────────────────────────────────── */

test("rig.json: 16 unique bones whose ends are solved joints and known landmarks", () => {
  const rig = JSON.parse(readFileSync(RIG_FILE, "utf8"));
  assert.ok(Array.isArray(rig.bones));
  assert.equal(rig.bones.length, 16);

  const solved = buildPoseInput({ entryId: "body-squat", position: 0, landmarks: LANDMARKS });
  const jointNames = new Set(Object.keys(solved.joints));
  assert.ok(jointNames.has("crown"), "a solved pose carries the crown");

  const problems = [];
  for (const bone of rig.bones) {
    const at = "bone " + String(bone.name);
    if (typeof bone.name !== "string" || bone.name === "") problems.push(at + ": no name");
    if (!["C", "R", "L"].includes(bone.side)) problems.push(at + ": side " + String(bone.side));
    if (!jointNames.has(bone.figFrom)) problems.push(at + ": figFrom " + String(bone.figFrom) + " is not a solved joint");
    if (!jointNames.has(bone.figTo)) problems.push(at + ": figTo " + String(bone.figTo) + " is not a solved joint");
    if (!LANDMARK_NAMES.includes(bone.lmFrom)) problems.push(at + ": lmFrom " + String(bone.lmFrom) + " is not a landmark");
    if (!LANDMARK_NAMES.includes(bone.lmTo)) problems.push(at + ": lmTo " + String(bone.lmTo) + " is not a landmark");
    if (typeof bone.radiusMm !== "number" || !(bone.radiusMm > 0)) problems.push(at + ": radiusMm is not positive");
  }
  const names = rig.bones.map((bone) => bone.name);
  if (new Set(names).size !== names.length) problems.push("a bone name repeats");
  assert.deepEqual(problems, [], problems.join("\n  "));
});

/* ── crossCheck ───────────────────────────────────────────────────────────── */

test("crossCheck: equal ratios flag nothing, a 10% thigh flags exactly that row", () => {
  const agree = crossCheck({ ratios: { ...Figure.SEGMENTS } });
  assert.equal(agree.rows.length, Object.keys(Figure.SEGMENTS).length);
  assert.equal(agree.flaggedCount, 0);
  for (const row of agree.rows) {
    assert.ok(Math.abs(row.diffPct) < 1e-9, row.segment + " is level");
    assert.equal(row.flagged, false);
  }

  const off = crossCheck({ ratios: { ...Figure.SEGMENTS, thigh: Figure.SEGMENTS.thigh * 1.1 } });
  assert.equal(off.flaggedCount, 1);
  const flagged = off.rows.filter((row) => row.flagged);
  assert.deepEqual(flagged.map((row) => row.segment), ["thigh"]);
  assert.ok(Math.abs(flagged[0].diffPct - 10) < 1e-9, "the difference is read as a percentage: " + flagged[0].diffPct);

  assert.equal(crossCheck({ ratios: { ...Figure.SEGMENTS, thigh: Figure.SEGMENTS.thigh * 1.1 } }, 20).flaggedCount, 0,
    "a wider threshold lets it pass");
  assert.throws(() => crossCheck({ ratios: {} }, -1), /thresholdPct/);
});

test("formatCrossCheck: a plain table naming every segment", () => {
  const text = formatCrossCheck(crossCheck({ ratios: { ...Figure.SEGMENTS, foot: Figure.SEGMENTS.foot * 0.5 } }));
  assert.equal(typeof text, "string");
  for (const segment of Object.keys(Figure.SEGMENTS)) assert.ok(text.includes(segment), segment + " is in the table");
  assert.match(text, /cross-check only/i);
  assert.match(text, /BodyParts3D is one reference body/);
  assert.match(text, /0\.0520/, "ratios carry four decimals");
  assert.match(text, /FLAGGED/);
  assert.ok(text.split("\n").length > Object.keys(Figure.SEGMENTS).length, "one line per segment plus a header");
});