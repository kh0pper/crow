/**
 * Sample render: one library entry through the whole anatomy pipeline.
 *
 * Steps, in order: the landmarks of the source body, a cross-check of the
 * figure engine's segment fractions against that body's measurements, then one
 * posed mesh set per key position and variant, its layered SVG (all layers and
 * skeleton only) with a PNG preview, one comparison sheet and a report.
 *
 * The posing step is the expensive one, so it only ever starts inside a
 * registered CPU window (`RAMBLE_ANATOMY_WINDOW=registered`) and only under
 * `taskset`/`nice`. `--dry-run` prints the plan and touches nothing.
 *
 * Every command runs through spawnSync with an argv array: no shell, no string
 * building. Paths inside the repository are resolved from this file, so the
 * script works from any directory.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";

import { crossCheck, formatCrossCheck } from "./lib/cross-check.mjs";
import { buildNerves } from "./lib/nerves.mjs";
import { loadPosedDir } from "./lib/obj.mjs";
import { buildPoseInput } from "./lib/pose-input.mjs";
import { buildSheet, innerSvg, stickFigureSvgBody } from "./lib/sheet.mjs";
import { buildLayeredSvg } from "./lib/svg-writer.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const POSE_DIR = join(REPO, "scripts", "ramble-anatomy", "pose");
const LANDMARKS_PY = join(POSE_DIR, "landmarks.py");
const BPY_POSE_PY = join(POSE_DIR, "bpy_pose.py");
const RIG_FILE = join(REPO, "scripts", "ramble-anatomy", "rig.json");
const VOCAB_FILE = join(REPO, "bundles", "ramble", "server", "moves", "anatomy", "vocab.json");
const LIBRARY_DIR = join(REPO, "bundles", "ramble", "server", "moves", "library");

const VARIANTS = ["figure", "native"];
const ENGINES = ["blender", "numpy"];
const WINDOW_ENV = "RAMBLE_ANATOMY_WINDOW";
const WINDOW_VALUE = "registered";
const DEFAULT_CORES = "12-31";
const DEFAULT_BLENDER = "/opt/blender/blender";
/* Preview sizes: the single drawing is tall, the sheet is wide. Tunable, unverified. */
const PREVIEW_HEIGHT_PX = "1400";
const SHEET_WIDTH_PX = "2600";
/* A fallback frame when no drawing exists to take one from. Tunable, unverified. */
const DEFAULT_SHEET_VIEWBOX = "-10 -112 120 120";
const SHEET_PAD_UNITS = 1;
const ALL_LAYERS = ["skin", "skeleton", "muscles", "nerves"];
const SKELETON_ONLY = ["skeleton"];

const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);

function fail(message) {
  throw new Error("render-sample: " + message);
}

function requiredText(raw, name) {
  if (typeof raw !== "string" || raw.trim() === "") fail(name + " is required");
  return raw.trim();
}

/** figure,native (or an array) as a validated, de-duplicated list. */
function variantList(raw) {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : VARIANTS;
  const out = [];
  for (const item of list) {
    const name = String(item === undefined || item === null ? "" : item).trim();
    if (name === "") continue;
    if (!VARIANTS.includes(name)) fail('unknown variant "' + name + '" (expected ' + VARIANTS.join(" or ") + ")");
    if (!out.includes(name)) out.push(name);
  }
  if (out.length === 0) fail("no variants to render");
  return out;
}

/** `taskset` core list, kept as the string it is, so `12-31` stays `12-31`. */
function coreList(raw) {
  const value = raw === undefined || raw === null ? DEFAULT_CORES : String(raw).trim();
  if (!/^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(value)) {
    fail('--cores must look like "12-31" or "4,8-11", got "' + value + '"');
  }
  return value;
}

/** Every path and setting the plan needs, from the CLI options. */
function normalizeOptions(opts) {
  const raw = isRecord(opts) ? opts : {};
  const entry = requiredText(raw.entry, "--entry");
  const outDir = resolve(requiredText(raw.out, "--out"));
  const engine = raw.engine === undefined || raw.engine === null ? "blender" : String(raw.engine).trim();
  if (!ENGINES.includes(engine)) fail('unknown engine "' + engine + '" (expected ' + ENGINES.join(" or ") + ")");
  return {
    entry,
    cache: resolve(requiredText(raw.cache, "--cache")),
    outDir,
    libraryDir: raw.libraryDir === undefined ? LIBRARY_DIR : resolve(requiredText(raw.libraryDir, "libraryDir")),
    variants: variantList(raw.variants),
    cores: coreList(raw.cores),
    blender: resolve(raw.blender || process.env.BLENDER || DEFAULT_BLENDER),
    engine,
    creditFile: raw.creditFile === undefined || raw.creditFile === null || raw.creditFile === ""
      ? null
      : resolve(String(raw.creditFile)),
    skipLandmarks: raw.skipLandmarks === true,
    dryRun: raw.dryRun === true,
    landmarksPath: join(outDir, "landmarks.json"),
    crossCheckPath: join(outDir, "cross-check.txt"),
    sheetPath: join(outDir, entry + "-sheet.svg"),
    sheetPngPath: join(outDir, entry + "-sheet.png"),
    reportPath: join(outDir, "report.json"),
  };
}

const workDirOf = (o, position, variant) => join(o.outDir, "work", o.entry + "-p" + position + "-" + variant);
const posedDirOf = (o, position, variant) => join(workDirOf(o, position, variant), "posed");
const posePathOf = (o, position, variant) => join(workDirOf(o, position, variant), "pose.json");
const svgPathOf = (o, position, variant, skeleton) =>
  join(o.outDir, o.entry + "-p" + position + "-" + variant + (skeleton ? "-skeleton" : "") + ".svg");
const pngPathOf = (o, position, variant, skeleton) => svgPathOf(o, position, variant, skeleton).replace(/\.svg$/, ".png");
const layerKey = (position, variant) => position + "-" + variant;

/** The library entry, plus how many key positions it carries. */
function readEntry(o) {
  const path = join(o.libraryDir, o.entry + ".json");
  let entry;
  try {
    entry = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    fail("cannot load library entry " + o.entry + " from " + path + ": " + err.message);
  }
  if (!isRecord(entry)) fail("library entry " + o.entry + " is not a JSON object");
  const count = Array.isArray(entry.poses) ? entry.poses.length : isRecord(entry.pose) ? 1 : 0;
  if (count === 0) fail("library entry " + o.entry + " carries no poses to render");
  return { entry, positions: Array.from({ length: count }, (_, index) => index) };
}

/** The posing step's argv: taskset and nice first, then Blender or plain python3. */
function poseArgv(o, position, variant) {
  const runner = o.engine === "blender"
    ? [o.blender, "-b", "--factory-startup", "--python", BPY_POSE_PY, "--"]
    : ["python3", "-I", BPY_POSE_PY];
  return [
    "taskset", "-c", o.cores, "nice", "-n", "10",
    ...runner,
    "--cache", o.cache,
    "--vocab", VOCAB_FILE,
    "--rig", RIG_FILE,
    "--landmarks", o.landmarksPath,
    "--pose", posePathOf(o, position, variant),
    "--out", workDirOf(o, position, variant),
    "--engine", o.engine,
  ];
}

const previewArgv = (svgPath, pngPath) =>
  ["rsvg-convert", "-b", "white", "-h", PREVIEW_HEIGHT_PX, svgPath, "-o", pngPath];

const sheetPreviewArgv = (o) =>
  ["rsvg-convert", "-b", "white", "-w", SHEET_WIDTH_PX, o.sheetPath, "-o", o.sheetPngPath];

/** The ordered steps of a run, without running any of them. */
function buildPlan(o, positions) {
  const steps = [];
  if (!o.skipLandmarks) {
    steps.push({
      kind: "landmarks",
      argv: ["python3", "-I", LANDMARKS_PY, "--cache", o.cache, "--out", o.landmarksPath],
    });
  }
  steps.push({ kind: "write", what: "cross-check", path: o.crossCheckPath });
  for (const position of positions) {
    for (const variant of o.variants) {
      steps.push({
        kind: "write",
        what: "pose-input",
        position,
        variant,
        path: posePathOf(o, position, variant),
      });
      steps.push({ kind: "pose", position, variant, argv: poseArgv(o, position, variant) });
    }
  }
  for (const position of positions) {
    for (const variant of o.variants) {
      for (const skeleton of [false, true]) {
        steps.push({
          kind: "write",
          what: skeleton ? "skeleton-svg" : "anatomy-svg",
          position,
          variant,
          path: svgPathOf(o, position, variant, skeleton),
        });
      }
      steps.push({
        kind: "preview",
        position,
        variant,
        argv: previewArgv(svgPathOf(o, position, variant, false), pngPathOf(o, position, variant, false)),
      });
      steps.push({
        kind: "preview",
        position,
        variant,
        argv: previewArgv(svgPathOf(o, position, variant, true), pngPathOf(o, position, variant, true)),
      });
    }
  }
  steps.push({ kind: "write", what: "sheet", path: o.sheetPath });
  steps.push({ kind: "preview", argv: sheetPreviewArgv(o) });
  steps.push({ kind: "write", what: "report", path: o.reportPath });
  return steps;
}

/**
 * Renders may only run inside a registered CPU window: the pose step is the
 * expensive one, and the window is the operator's own bookkeeping that says
 * whose cores these are.
 */
export function assertWindow(env) {
  const value = env && typeof env === "object" ? env[WINDOW_ENV] : undefined;
  if (value !== WINDOW_VALUE) {
    fail("renders may only run inside a registered CPU window (" + WINDOW_ENV + "=" + WINDOW_VALUE +
      "), and the environment says " + (value === undefined ? "nothing" : '"' + String(value) + '"'));
  }
  return true;
}

/**
 * The ordered steps of a run: `{ kind, argv }` for a command, and
 * `{ kind: "write", path }` for a file the run produces — a write step also
 * says which writer makes it (`what`) and, where it belongs to one, the key
 * position and variant. Nothing is executed here.
 */
export function planRun(opts) {
  const o = normalizeOptions(opts);
  const { positions } = readEntry(o);
  return buildPlan(o, positions);
}

/** One plan step as a line of text, for --dry-run. */
function describeStep(step) {
  if (step.kind === "write") return (step.kind + "          ").slice(0, 10) + step.path;
  return (step.kind + "          ").slice(0, 10) + step.argv.join(" ");
}

function readJsonFile(path, what) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    fail("cannot read the " + what + " at " + path + ": " + err.message);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    fail("the " + what + " at " + path + " is not JSON: " + err.message);
  }
}

/** The credit-file text, trimmed, or undefined: the wording is never ours. */
function readCredit(o) {
  if (!o.creditFile) return undefined;
  let text;
  try {
    text = readFileSync(o.creditFile, "utf8");
  } catch (err) {
    fail("cannot read the credit file " + o.creditFile + ": " + err.message);
  }
  const trimmed = text.trim();
  return trimmed === "" ? undefined : trimmed;
}

/* ── running ─────────────────────────────────────────────────────────────── */

function runStep(step) {
  const [command, ...args] = step.argv;
  const started = Date.now();
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) fail(step.kind + " step could not start " + command + ": " + result.error.message);
  if (result.status !== 0) {
    fail(step.kind + " step exited with " + String(result.status) + ": " + step.argv.join(" "));
  }
  return (Date.now() - started) / 1000;
}

function writeOutput(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function landmarksOf(state) {
  if (!state.landmarks) state.landmarks = readJsonFile(state.o.landmarksPath, "landmarks file");
  return state.landmarks;
}

function vocabOf(state) {
  if (!state.vocab) {
    const data = readJsonFile(VOCAB_FILE, "vocabulary file");
    state.vocab = Array.isArray(data) ? data : Array.isArray(data.vocab) ? data.vocab : [];
  }
  return state.vocab;
}

const poseOf = (state, position, variant) => state.poses.get(layerKey(position, variant));
const layersOf = (state, position, variant, skeleton) =>
  state.layers.get(layerKey(position, variant) + (skeleton ? "-skeleton" : ""));

function writeCrossCheck(step, state) {
  const result = crossCheck(landmarksOf(state));
  state.crossCheck = result;
  writeOutput(step.path, formatCrossCheck(result) + "\n");
}

function writePoseInput(step, state) {
  const pose = buildPoseInput({
    entryId: state.o.entry,
    position: step.position,
    variant: step.variant,
    landmarks: landmarksOf(state),
    libraryDir: state.o.libraryDir,
  });
  writeOutput(step.path, JSON.stringify(pose, null, 2) + "\n");
  state.poses.set(layerKey(step.position, step.variant), pose);
}

/** The posed meshes the posing step left for one key position and variant. */
function posedMeshes(o, position, variant) {
  const dir = posedDirOf(o, position, variant);
  try {
    return loadPosedDir(dir);
  } catch (err) {
    return fail("cannot read the posed meshes in " + dir + ": " + err.message);
  }
}

function writeAnatomySvg(step, state) {
  const pose = poseOf(state, step.position, step.variant);
  if (!pose) fail("no pose was built for position " + step.position + " variant " + step.variant);
  const skeleton = step.what === "skeleton-svg";
  const meshes = posedMeshes(state.o, step.position, step.variant);
  const { svg, report } = buildLayeredSvg({
    vocab: vocabOf(state),
    heightMm: pose.heightMm,
    meshes,
    /* A skeleton-only drawing has no nerve layer, so its frame stays the bones'. */
    nerves: skeleton ? [] : buildNerves(pose.joints, pose.heightMm),
    credit: state.credit,
    title: state.o.entry + " p" + step.position + " " + step.variant + (skeleton ? " (skeleton)" : ""),
    layers: skeleton ? SKELETON_ONLY : ALL_LAYERS,
  });
  writeOutput(step.path, svg);
  state.layers.set(layerKey(step.position, step.variant) + (skeleton ? "-skeleton" : ""), { svg, report });
}

/** The union of svg-writer viewBox strings, so every cell of the sheet shares one scale. */
function viewBoxUnion(viewBoxes) {
  let box = null;
  for (const text of viewBoxes) {
    if (typeof text !== "string") continue;
    const parts = text.trim().split(/\s+/).map(Number);
    if (parts.length !== 4 || !parts.every((value) => Number.isFinite(value))) continue;
    const [x, y, width, height] = parts;
    box = box
      ? {
        minX: Math.min(box.minX, x),
        minY: Math.min(box.minY, y),
        maxX: Math.max(box.maxX, x + width),
        maxY: Math.max(box.maxY, y + height),
      }
      : { minX: x, minY: y, maxX: x + width, maxY: y + height };
  }
  if (!box) return DEFAULT_SHEET_VIEWBOX;
  const round = (value) => Number(value.toFixed(2));
  const minX = round(box.minX - SHEET_PAD_UNITS);
  const minY = round(box.minY - SHEET_PAD_UNITS);
  const width = round(box.maxX - box.minX + SHEET_PAD_UNITS * 2);
  const height = round(box.maxY - box.minY + SHEET_PAD_UNITS * 2);
  return [minX, minY, width, height].join(" ");
}

/** The comparison sheet: one row per key position, five views of each. */
function sheetMarkup(state) {
  const o = state.o;
  const viewBox = viewBoxUnion(
    state.positions.flatMap((position) => o.variants.map((variant) => {
      const entry = layersOf(state, position, variant, false);
      return entry ? entry.report.viewBox : null;
    })),
  );
  const empty = () => ({ body: "", viewBox });
  const cellOf = (position, variant, skeleton) => {
    const entry = layersOf(state, position, variant, skeleton);
    return entry ? { body: innerSvg(entry.svg), viewBox } : empty();
  };
  const stickBody = (position) => {
    const pose = poseOf(state, position, "figure");
    return pose ? stickFigureSvgBody(pose.joints, pose.heightMm) : "";
  };

  const columns = [
    {
      label: "stick figure",
      cells: state.positions.map((position) => {
        const body = stickBody(position);
        return body === "" ? empty() : { body, viewBox };
      }),
    },
    { label: "own armature", cells: state.positions.map((position) => cellOf(position, "figure", false)) },
    { label: "armature only", cells: state.positions.map((position) => cellOf(position, "figure", true)) },
  ];
  if (o.variants.includes("native")) {
    columns.push({
      label: "native proportions",
      cells: state.positions.map((position) => cellOf(position, "native", false)),
    });
  }
  columns.push({
    label: "overlay",
    cells: state.positions.map((position) => {
      const entry = layersOf(state, position, "figure", false);
      const body = stickBody(position);
      if (!entry || body === "") return empty();
      /* The stick figure over the anatomy at half opacity, in the same frame. */
      return { body: innerSvg(entry.svg) + '\n<g opacity="0.5">' + body + "</g>", viewBox };
    }),
  });

  return buildSheet({
    title: state.entryTitle ? o.entry + ": " + state.entryTitle : o.entry,
    rows: state.positions.map((position) => o.entry + " p" + position),
    columns,
  });
}

function writeSheet(step, state) {
  const svg = sheetMarkup(state);
  writeOutput(step.path, svg);
  const bytes = Buffer.byteLength(svg, "utf8");
  state.sheet = { path: basename(step.path), bytes, gzipBytes: gzipSync(Buffer.from(svg, "utf8"), { level: 9 }).length };
}

function timingsOf(state) {
  return state.positions.flatMap((position) => state.o.variants.map((variant) => {
    const manifestPath = join(posedDirOf(state.o, position, variant), "_manifest.json");
    let manifest = null;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      manifest = null;
    }
    const wall = state.walls.find((entry) => entry.position === position && entry.variant === variant);
    return {
      position,
      variant,
      engine: isRecord(manifest) && typeof manifest.engine === "string" ? manifest.engine : state.o.engine,
      stagesSeconds: isRecord(manifest) && isRecord(manifest.timingsSeconds) ? manifest.timingsSeconds : null,
      wallSeconds: wall ? wall.wallSeconds : null,
    };
  }));
}

function writeReport(step, state) {
  const o = state.o;
  const svgs = [];
  for (const position of state.positions) {
    for (const variant of o.variants) {
      for (const skeleton of [false, true]) {
        const entry = layersOf(state, position, variant, skeleton);
        if (!entry) continue;
        svgs.push({
          path: basename(svgPathOf(o, position, variant, skeleton)),
          position,
          variant,
          layers: skeleton ? "skeleton" : "all",
          viewBox: entry.report.viewBox,
          ids: entry.report.ids.length,
          bytes: entry.report.bytes,
          gzipBytes: entry.report.gzipBytes,
          budgetBytes: entry.report.budgetBytes,
          withinBudget: entry.report.withinBudget,
        });
      }
    }
  }
  const report = {
    version: 1,
    entry: o.entry,
    title: state.entryTitle,
    heightMm: state.landmarks ? state.landmarks.heightMm : null,
    engine: o.engine,
    cores: o.cores,
    variants: o.variants,
    skipLandmarks: o.skipLandmarks,
    svgs,
    sheet: state.sheet || null,
    crossCheck: state.crossCheck
      ? { rows: state.crossCheck.rows, flaggedCount: state.crossCheck.flaggedCount }
      : null,
    timings: timingsOf(state),
  };
  writeOutput(step.path, JSON.stringify(report, null, 2) + "\n");
}

/** Runs one "write" step: the writers are keyed by what the step produces. */
function writeStep(step, state) {
  switch (step.what) {
    case "cross-check": return writeCrossCheck(step, state);
    case "pose-input": return writePoseInput(step, state);
    case "anatomy-svg":
    case "skeleton-svg": return writeAnatomySvg(step, state);
    case "sheet": return writeSheet(step, state);
    case "report": return writeReport(step, state);
    default: return fail("no writer for the write step " + String(step.what));
  }
}

function runAll(opts) {
  const o = normalizeOptions(opts);
  const { entry, positions } = readEntry(o);
  const plan = buildPlan(o, positions);
  if (o.dryRun) {
    for (const step of plan) console.log(describeStep(step));
    return;
  }
  assertWindow(process.env);
  mkdirSync(o.outDir, { recursive: true });
  const state = {
    o,
    positions,
    entryTitle: typeof entry.title === "string" ? entry.title : null,
    credit: readCredit(o),
    poses: new Map(),
    layers: new Map(),
    walls: [],
    landmarks: null,
    vocab: null,
    crossCheck: null,
    sheet: null,
  };
  for (const step of plan) {
    if (step.kind === "write") {
      writeStep(step, state);
      continue;
    }
    const seconds = runStep(step);
    if (step.kind === "pose") state.walls.push({ position: step.position, variant: step.variant, wallSeconds: seconds });
  }
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      entry: { type: "string" },
      cache: { type: "string" },
      out: { type: "string" },
      variants: { type: "string", default: VARIANTS.join(",") },
      cores: { type: "string", default: DEFAULT_CORES },
      blender: { type: "string" },
      engine: { type: "string", default: "blender" },
      "credit-file": { type: "string" },
      "skip-landmarks": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
    },
  });
  try {
    runAll({
      entry: values.entry,
      cache: values.cache,
      out: values.out,
      variants: values.variants,
      cores: values.cores,
      blender: values.blender,
      engine: values.engine,
      creditFile: values["credit-file"],
      skipLandmarks: values["skip-landmarks"] === true,
      dryRun: values["dry-run"] === true,
    });
  } catch (err) {
    console.error(err && err.message ? err.message : String(err));
    process.exitCode = 1;
  }
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : null;
if (invoked === fileURLToPath(import.meta.url)) main(process.argv.slice(2));