/**
 * pose.json builder for the Ramble anatomy pipeline.
 *
 * The figure engine (figure.cjs) works in px with y DOWN and the ground at
 * y = 0. pose.json is the frame the posing step consumes instead: millimetres,
 * x forward, z up, the ground at z = 0. Both a joint's figure position and the
 * landmark points of the source body end up in that frame, so the armature can
 * be posed from a library entry's key position alone.
 *
 * CLI: node pose-input.mjs --entry ID --position N --variant figure|native \
 *        --landmarks FILE --out FILE
 */
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const require = createRequire(import.meta.url);
const Figure = require("../../../bundles/ramble/server/moves/figure.cjs");

const HERE = dirname(fileURLToPath(import.meta.url));
/** The shipped moves library, as the default source of key positions. */
const DEFAULT_LIBRARY_DIR = resolve(HERE, "../../../bundles/ramble/server/moves/library");
const VARIANTS = ["figure", "native"];

function fail(message) {
  throw new Error("pose-input: " + message);
}

const isRecord = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/** landmarks.json, as written by the landmark step. */
export function loadLandmarks(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    fail("cannot read landmarks file " + path + ": " + err.message);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    fail("landmarks file " + path + " is not JSON: " + err.message);
  }
  if (!isRecord(data)) fail("landmarks file " + path + " does not hold a JSON object");
  return data;
}

/** The raw key position an entry carries for `position`. */
function keyPose(entry, entryId, position) {
  if (!Number.isInteger(position) || position < 0) {
    fail("position must be a whole number from 0 up, got " + String(position));
  }
  if (Array.isArray(entry.poses)) {
    const pose = entry.poses[position];
    if (!isRecord(pose)) {
      fail(entryId + " has " + entry.poses.length + " key position(s), so there is no position " + position);
    }
    return pose;
  }
  if (isRecord(entry.pose)) {
    if (position !== 0) fail(entryId + " carries a single pose, so only position 0 exists");
    return entry.pose;
  }
  fail(entryId + " carries no poses to build from");
}

/**
 * solve() with the figure engine's own segment fractions, or — for variant
 * "native" — with the source body's measured ratios swapped in for the call
 * only. SEGMENTS is module state, so every key is restored in a finally even
 * when a ratio is unusable and nothing gets as far as solve().
 */
function solveWithSegments(pose, heightMm, variant, landmarks) {
  if (variant === "figure") return Figure.solve(pose, heightMm);
  if (variant !== "native") fail('unknown variant "' + String(variant) + '" (expected ' + VARIANTS.join(" or ") + ")");
  if (!isRecord(landmarks.ratios)) fail("variant native needs landmarks.ratios");
  const ratios = landmarks.ratios;
  const keys = Object.keys(Figure.SEGMENTS);
  const saved = keys.map((key) => [key, Figure.SEGMENTS[key]]);
  try {
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(ratios, key)) continue;
      const value = ratios[key];
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        fail("landmarks.ratios." + key + " must be a positive number, got " + String(value));
      }
      Figure.SEGMENTS[key] = value;
    }
    return Figure.solve(pose, heightMm);
  } finally {
    for (const [key, value] of saved) Figure.SEGMENTS[key] = value;
  }
}

/** solve()'s joints (y up is negative) as { name: { x: mm forward, z: mm up } }, plus crown. */
function jointsFromSolved(solved) {
  const joints = {};
  for (const [name, point] of Object.entries(solved.joints)) {
    joints[name] = { x: point.x, z: -point.y };
  }
  const chin = joints.chin;
  const head = joints.head;
  /* solve() puts `head` half a head segment above the chin; the crown is the
   * other half, so it is the same offset again. */
  joints.crown = { x: chin.x + 2 * (head.x - chin.x), z: chin.z + 2 * (head.z - chin.z) };
  return joints;
}

/**
 * The pose.json object: one library key position, solved at the source body's
 * height, with every joint in the pipeline's millimetre side-view frame.
 */
export function buildPoseInput({
  entryId,
  position = 0,
  variant = "figure",
  landmarks,
  libraryDir = DEFAULT_LIBRARY_DIR,
} = {}) {
  if (typeof entryId !== "string" || entryId === "") fail("entryId must be a non-empty string");
  if (!isRecord(landmarks)) fail("landmarks must be a landmarks.json object");
  const heightMm = landmarks.heightMm;
  if (typeof heightMm !== "number" || !Number.isFinite(heightMm) || heightMm <= 0) {
    fail("landmarks.heightMm must be a positive number, got " + String(heightMm));
  }
  if (typeof libraryDir !== "string" || libraryDir === "") fail("libraryDir must be a directory path");
  const entryPath = join(libraryDir, entryId + ".json");
  let entry;
  try {
    entry = JSON.parse(readFileSync(entryPath, "utf8"));
  } catch (err) {
    fail("cannot load library entry " + entryId + " from " + entryPath + ": " + err.message);
  }
  if (!isRecord(entry)) fail("library entry " + entryId + " is not a JSON object");

  const pose = Figure.clampPose(keyPose(entry, entryId, position));
  const solved = solveWithSegments(pose, heightMm, variant, landmarks);
  return {
    version: 1,
    entry: entryId,
    position,
    variant,
    heightMm,
    pose,
    joints: jointsFromSolved(solved),
  };
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      entry: { type: "string" },
      position: { type: "string", default: "0" },
      variant: { type: "string", default: "figure" },
      landmarks: { type: "string" },
      out: { type: "string" },
    },
  });
  for (const name of ["entry", "landmarks", "out"]) {
    if (!values[name]) fail("--" + name + " is required");
  }
  const position = Number(values.position);
  if (!Number.isInteger(position)) fail('--position must be a whole number, got "' + values.position + '"');
  const landmarks = loadLandmarks(values.landmarks);
  const pose = buildPoseInput({
    entryId: values.entry,
    position,
    variant: values.variant,
    landmarks,
  });
  writeFileSync(values.out, JSON.stringify(pose, null, 2) + "\n");
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : null;
if (invoked === fileURLToPath(import.meta.url)) main(process.argv.slice(2));