/**
 * Moves design Task 1 — the library format, loader and fixed vocabularies.
 *
 * ⚠ FIXTURES, NOT THE SHIPPED LIBRARY. bundles/ramble/server/moves/library/
 * ships EMPTY until Task 10, so every behavioural test reads
 * tests/fixtures/ramble-moves-library/ (five poses, one flow over them, one
 * exercise) or builds entries in-test. Nothing here may depend on the
 * contents of the shipped directory.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ENTRY_KINDS, LIMIT_TAGS, EQUIPMENT, ACTIVITY_KINDS,
  FLOW_MIN, FLOW_MAX,
  validateEntry, loadLibrary, servedLibrary, entryById,
} from "../bundles/ramble/server/moves/library.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "ramble-moves-library");

const POSE_IDS = ["pose-a", "pose-b", "pose-c", "pose-d", "pose-e"];

/** A minimal valid pose. Every test mutates exactly one thing from here. */
function base(over = {}) {
  return {
    id: "pose-test",
    kind: "pose",
    title: "Test pose",
    minutes: 1,
    level: 1,
    indoor: true,
    activity: "yoga",
    equipment: ["none"],
    tags: [],
    steps: ["Stand tall."],
    works: [],
    stretches: [],
    mistakes: [],
    skipIf: [],
    easier: null,
    harder: null,
    sources: [{ title: "Ramble test fixture", url: "", license: "CC0" }],
    reviewed: true,
    pose: {},
    ...over,
  };
}

/** A 5-pose flow over POSE_IDS, and the library that resolves it. */
function flowEntry(over = {}) {
  const f = base({
    id: "flow-test",
    kind: "flow",
    minutes: 8,
    steps: ["Move through each pose in order."],
    equipment: ["mat"],
    flow: POSE_IDS.map((id) => ({ id, holdSeconds: 30 })),
    ...over,
  });
  delete f.pose;
  return f;
}
const poseLib = (extra = []) => [...POSE_IDS.map((id) => base({ id })), ...extra];
const items = (ids) => ids.map((id) => ({ id, holdSeconds: 30 }));

/** Run `fn` with console.warn captured; returns [result, warnings[]]. */
function captureWarnings(fn) {
  const warnings = [];
  const orig = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try { return [fn(), warnings]; } finally { console.warn = orig; }
}

const TEMP_DIRS = [];
function tempDir() {
  const d = mkdtempSync(join(tmpdir(), "ramble-moves-"));
  TEMP_DIRS.push(d);
  return d;
}
after(() => { for (const d of TEMP_DIRS) rmSync(d, { recursive: true, force: true }); });

test("the vocabularies are the fixed lists", () => {
  assert.deepEqual([...ENTRY_KINDS], ["pose", "exercise", "flow", "walk"]);
  assert.deepEqual([...LIMIT_TAGS], [
    "knee", "lower_back", "neck", "shoulder", "wrist",
    "hip", "ankle", "balance", "pregnancy", "high_blood_pressure",
  ]);
  assert.deepEqual([...EQUIPMENT], ["none", "mat", "band", "chair", "wall"]);
  assert.deepEqual([...ACTIVITY_KINDS], [
    "yoga", "walk", "jog", "run", "cycle", "band", "bodyweight", "swim", "sport", "other",
  ]);
  assert.equal(FLOW_MIN, 5);
  assert.equal(FLOW_MAX, 7);
});

test("validateEntry accepts a well-formed pose", () => {
  assert.deepEqual(validateEntry(base()), { ok: true, errors: [] });
});

test("validateEntry rejects a missing skipIf and an off-vocabulary skipIf tag", () => {
  const noSkip = base();
  delete noSkip.skipIf;
  const missing = validateEntry(noSkip);
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((e) => e.includes("skipIf")), missing.errors.join("; "));

  const unknown = validateEntry(base({ skipIf: ["elbow"] }));
  assert.equal(unknown.ok, false);
  assert.ok(unknown.errors.some((e) => e.includes("elbow")), unknown.errors.join("; "));

  // An explicit empty list is fine: many moves carry no limitation.
  assert.equal(validateEntry(base({ skipIf: [] })).ok, true);
});

test("validateEntry rejects flows outside 5-7 poses", () => {
  assert.equal(validateEntry(flowEntry({ flow: items(POSE_IDS.slice(0, 4)) })).ok, false);
  assert.equal(validateEntry(flowEntry({ flow: items([...POSE_IDS, "pose-f", "pose-g", "pose-h"]) })).ok, false);
  assert.equal(validateEntry(flowEntry(), poseLib()).ok, true, "5 is the minimum and it passes");
  const lib7 = poseLib([base({ id: "pose-f" }), base({ id: "pose-g" })]);
  assert.equal(validateEntry(flowEntry({ flow: items([...POSE_IDS, "pose-f", "pose-g"]) }), lib7).ok, true);
});

test("validateEntry rejects a flow naming an unknown id, or a non-pose entry", () => {
  const lib = poseLib();
  const dangling = validateEntry(flowEntry({ flow: items(["pose-nope", ...POSE_IDS.slice(1)]) }), lib);
  assert.equal(dangling.ok, false);
  assert.ok(dangling.errors.some((e) => e.includes("pose-nope")), dangling.errors.join("; "));

  const exercise = base({ id: "exercise-x", kind: "exercise", activity: "bodyweight" });
  delete exercise.pose;
  const wrongKind = validateEntry(flowEntry({ flow: items(["exercise-x", ...POSE_IDS.slice(1)]) }), poseLib([exercise]));
  assert.equal(wrongKind.ok, false, "a flow item must name a POSE, not just any entry");

  // Without a library argument the cross-reference check cannot run, and the
  // shape alone is still accepted — resolution is loadLibrary's second pass.
  assert.equal(validateEntry(flowEntry()).ok, true);
});

test("validateEntry rejects empty sources and a source without a license", () => {
  const empty = validateEntry(base({ sources: [] }));
  assert.equal(empty.ok, false);
  assert.ok(empty.errors.some((e) => e.includes("sources")), empty.errors.join("; "));

  const noLicense = validateEntry(base({ sources: [{ title: "Some guide", url: "" }] }));
  assert.equal(noLicense.ok, false);
  assert.ok(noLicense.errors.some((e) => e.includes("license")), noLicense.errors.join("; "));

  // An empty url is allowed until the host page has been checked (SOURCES.md);
  // a missing one is not.
  assert.equal(validateEntry(base({ sources: [{ title: "Guide", license: "CC0" }] })).ok, false);
});

test("easier/harder must be an id or null, and resolve when a library is given", () => {
  const lib = poseLib();
  assert.equal(validateEntry(base({ id: "pose-z", easier: "pose-a" }), lib).ok, true);
  assert.equal(validateEntry(base({ id: "pose-z", easier: null, harder: null }), lib).ok, true);
  assert.equal(validateEntry(base({ easier: 3 })).ok, false);

  const dangling = validateEntry(base({ id: "pose-z", harder: "pose-nope" }), lib);
  assert.equal(dangling.ok, false);
  assert.ok(dangling.errors.some((e) => e.includes("pose-nope")), dangling.errors.join("; "));
});

test("loadLibrary reads the fixture directory and every entry passes both passes", () => {
  const [lib, warnings] = captureWarnings(() => loadLibrary(FIXTURES));
  assert.deepEqual(warnings, [], "the fixtures are all valid; a warning means a fixture rotted");
  assert.deepEqual(lib.map((e) => e.id).sort(), [
    "exercise-squat", "flow-morning", "pose-bridge", "pose-child",
    "pose-mountain", "pose-tree", "pose-warrior",
  ]);
  assert.equal(entryById(lib, "pose-mountain").kind, "pose");
  assert.equal(entryById(lib, "flow-morning").flow.length, 5);
  assert.equal(entryById(lib, "nope"), null);
  assert.equal(entryById(lib, null), null);
});

test("every easier/harder id in the fixture library resolves", () => {
  const lib = loadLibrary(FIXTURES);
  // Not vacuous: the fixtures carry a real progression link.
  assert.equal(entryById(lib, "pose-tree").easier, "pose-mountain");
  for (const e of lib) {
    for (const field of ["easier", "harder"]) {
      if (e[field] === null) continue;
      assert.ok(entryById(lib, e[field]), `${e.id}.${field} -> ${e[field]} must resolve`);
    }
  }
});

test("servedLibrary serves only reviewed entries", () => {
  const all = loadLibrary(FIXTURES);
  const served = servedLibrary(FIXTURES);
  assert.ok(served.length > 0);
  assert.ok(served.every((e) => e.reviewed === true));
  assert.equal(served.length, all.length - 2, "the unreviewed pose, and the reviewed flow that names it, are held back");
  assert.equal(entryById(served, "pose-bridge"), null);
  assert.equal(entryById(served, "flow-morning"), null, "a served flow never points at an unserved pose");
  for (const e of served) {
    for (const ref of [e.easier, e.harder]) if (ref) assert.ok(entryById(served, ref), `${e.id} links only to served entries`);
  }
  assert.ok(entryById(all, "pose-bridge"), "the unreviewed pose is loaded, just not served");
});

test("loadLibrary skips broken, invalid and dangling entries, naming each in a warning", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "broken.json"), "{not json");
  const noSkip = base({ id: "pose-noskip" });
  delete noSkip.skipIf;
  writeFileSync(join(dir, "no-skipif.json"), JSON.stringify(noSkip));
  writeFileSync(join(dir, "pose-ok.json"), JSON.stringify(base({ id: "pose-ok" })));
  writeFileSync(join(dir, "flow-dangling.json"), JSON.stringify(flowEntry({ id: "flow-dangling" })));
  writeFileSync(join(dir, "README.md"), "not an entry");

  const [lib, warnings] = captureWarnings(() => loadLibrary(dir));
  assert.deepEqual(lib.map((e) => e.id), ["pose-ok"]);
  assert.ok(warnings.some((w) => w.includes("broken.json")), "an unreadable file is named");
  assert.ok(warnings.some((w) => w.includes("pose-noskip")), "an invalid entry is named by id");
  assert.ok(warnings.some((w) => w.includes("flow-dangling")), "a flow over missing poses is named");
});

test("a missing directory loads as an empty library rather than throwing", () => {
  const [lib] = captureWarnings(() => loadLibrary(join(FIXTURES, "no-such-dir")));
  assert.deepEqual(lib, []);
});
