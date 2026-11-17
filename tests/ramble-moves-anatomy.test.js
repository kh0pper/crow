/**
 * Ramble moves — the anatomy vocabulary and the ids library entries name.
 *
 * The vocabulary (moves/anatomy/vocab.json) is what the figure builder can
 * draw and what an entry's `anatomy` groups may point at. These tests read the
 * SHIPPED vocabulary and the SHIPPED library, so they are the rail that keeps
 * the two in step: a new entry naming a part nobody added to the vocabulary is
 * a failure here, and loadLibrary would drop that entry rather than serve a
 * name the figure cannot place.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLibrary, loadVocab, validateEntry } from "../bundles/ramble/server/moves/library.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOVES_DIR = join(HERE, "..", "bundles", "ramble", "server", "moves");
const LIB_DIR = join(MOVES_DIR, "library");
const VOCAB_FILE = join(MOVES_DIR, "anatomy", "vocab.json");

/** The vocabulary as loaded by the module under test, plus its records in file order. */
const vocab = loadVocab(VOCAB_FILE);
const records = [...vocab.values()];
const vocabIds = new Set(vocab.keys());
/** The vocabulary file's own array, read straight off disk (not through loadVocab). */
const fileVocab = JSON.parse(readFileSync(VOCAB_FILE, "utf8")).vocab;

/** Every shipped library entry, read straight off disk (not through loadLibrary). */
const shipped = readdirSync(LIB_DIR)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((file) => ({ file, entry: JSON.parse(readFileSync(join(LIB_DIR, file), "utf8")) }));

/** The id lists one anatomy part carries, plus `main`. */
const ANATOMY_FIELDS = ["working", "lengthening", "bones", "nerves"];

/** Every anatomy part of every shipped entry, with the file it came from. */
const anatomyParts = shipped.flatMap(({ file, entry }) => (Array.isArray(entry.anatomy) ? entry.anatomy : [])
  .map((part, i) => ({ file, entry, part, at: `anatomy[${i}]` })));

/** One readable failure message instead of the first assert that trips. */
const summarise = (problems) => `${problems.length} problem(s):\n  ${problems.join("\n  ")}`;

/** Run `fn` with console.warn captured; returns [result, warnings[]]. */
function captureWarnings(fn) {
  const warnings = [];
  const orig = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try { return [fn(), warnings]; } finally { console.warn = orig; }
}

/** The no-treatment-claims guard the shipped wording has to stay clear of. */
const TREATMENT_CLAIM = /\b(cure|cures|treat|treats|treating|treatment|heal|heals|healing|fix your)\b/i;

// 1 -------------------------------------------------------------- the file
test("loadVocab reads 64 records, each with an id, a name and a layer from muscle, bone and nerve", () => {
  assert.equal(vocab.size, 64, "the shipped vocabulary holds 64 records");
  assert.equal(records.length, fileVocab.length,
    `one loaded record per record in vocab.json (the file holds ${fileVocab.length})`);
  assert.ok(records.length > 0, "the vocabulary is not empty");

  const problems = [];
  for (const [index, record] of records.entries()) {
    const at = `record #${index} (${String(record.id)})`;
    for (const field of ["id", "layer", "name", "anatomical"]) {
      if (typeof record[field] !== "string" || record[field].trim() === "") {
        problems.push(`${at}: ${field} must be a non-empty string`);
      }
    }
    if (!["muscle", "bone", "nerve"].includes(record.layer)) {
      problems.push(`${at}: layer is ${String(record.layer)}, not muscle, bone or nerve`);
    }
  }
  assert.deepEqual(problems, [], summarise(problems));
});

test("loadVocab survives a missing file and a broken file", () => {
  const missing = join(LIB_DIR, "no-such-vocab-file.json");
  const [absent, absentWarnings] = captureWarnings(() => loadVocab(missing));
  assert.ok(absent instanceof Map, "a missing file still gives a Map");
  assert.equal(absent.size, 0);
  assert.ok(absentWarnings.some((w) => w.includes("unreadable")), "the missing file is named in a warning");

  const dir = mkdtempSync(join(tmpdir(), "ramble-moves-vocab-broken-"));
  try {
    const brokenPath = join(dir, "broken.json");
    writeFileSync(brokenPath, "{ not json at all");
    const [broken, brokenWarnings] = captureWarnings(() => loadVocab(brokenPath));
    assert.equal(broken.size, 0);
    assert.ok(brokenWarnings.length > 0, "a malformed vocabulary is warned about");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadVocab skips a record with no string id or layer and keeps the rest", () => {
  assert.equal(records.every((r) => typeof r.id === "string"), true);

  const dir = mkdtempSync(join(tmpdir(), "ramble-moves-vocab-skip-"));
  try {
    const path = join(dir, "vocab.json");
    writeFileSync(path, JSON.stringify({
      reviewed: true,
      vocab: [
        { id: "kept-one", layer: "muscle", name: "Kept one", anatomical: "Kept one" },
        { id: "kept-two", layer: "bone", name: "Kept two", anatomical: "Kept two" },
        { layer: "muscle", name: "No id", anatomical: "No id" },
        { id: "no-layer", name: "No layer", anatomical: "No layer" },
        { id: 42, layer: "nerve", name: "Bad id type", anatomical: "Bad id type" },
        "not a record",
      ],
    }));
    const [loaded, warnings] = captureWarnings(() => loadVocab(path));
    assert.deepEqual([...loaded.keys()], ["kept-one", "kept-two"]);
    assert.equal(warnings.length, 4, `one warning per skipped record, got: ${warnings.join(" | ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadVocab skips a duplicate id and keeps the first record", () => {
  const dir = mkdtempSync(join(tmpdir(), "ramble-moves-vocab-duplicate-"));
  try {
    const path = join(dir, "vocab.json");
    writeFileSync(path, JSON.stringify({
      reviewed: true,
      vocab: [
        { id: "first-wins", layer: "muscle", name: "First one", anatomical: "First one" },
        { id: "first-wins", layer: "bone", name: "Second one", anatomical: "Second one" },
        { id: "other-part", layer: "nerve", name: "Other one", anatomical: "Other one" },
      ],
    }));
    const [loaded, warnings] = captureWarnings(() => loadVocab(path));
    assert.deepEqual([...loaded.keys()], ["first-wins", "other-part"],
      "a repeated id does not add a second record");
    assert.equal(loaded.size, 2);
    assert.equal(loaded.get("first-wins").name, "First one", "the first record is the one kept");
    assert.equal(warnings.length, 1, `one warning for the duplicate, got: ${warnings.join(" | ")}`);
    assert.ok(warnings[0].includes("duplicate"), `the warning names the duplicate: ${warnings[0]}`);
    assert.ok(warnings[0].includes("first-wins"), `and names the id: ${warnings[0]}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 2 ------------------------------------------------------ ids resolve
test("every anatomy id a shipped entry names exists in the vocabulary", () => {
  assert.ok(anatomyParts.length > 0, "the shipped library carries anatomy to check");

  const problems = [];
  for (const { file, part, at } of anatomyParts) {
    if (typeof part.main === "string" && !vocabIds.has(part.main)) {
      problems.push(`${file} ${at}.main: ${part.main}`);
    }
    for (const field of ANATOMY_FIELDS) {
      const ids = Array.isArray(part[field]) ? part[field] : [];
      for (const id of ids) {
        if (!vocabIds.has(id)) problems.push(`${file} ${at}.${field}: ${String(id)}`);
      }
    }
  }
  assert.deepEqual(problems, [], summarise(problems));
});

// 3 ------------------------------------------------------ trained areas
test("every area a pose or exercise trains has a working muscle in the anatomy", () => {
  const checkable = anatomyParts.filter(({ entry }) => entry.kind === "pose" || entry.kind === "exercise");
  assert.ok(checkable.length > 0, "poses and exercises carry the anatomy this rule reads");

  const problems = [];
  let checked = 0;
  for (const { file, entry, part, at } of checkable) {
    const areas = (Array.isArray(entry.areas) ? entry.areas : [])
      .filter((area) => area !== "heart" && area !== "mobility");
    const working = (Array.isArray(part.working) ? part.working : [])
      .map((id) => vocab.get(id))
      .filter(Boolean);
    for (const area of areas) {
      checked += 1;
      if (!working.some((record) => record.area === area)) {
        problems.push(`${file} ${at}: trains "${area}" but no working muscle has that area `
          + `(${working.map((r) => `${r.id}=${String(r.area)}`).join(", ") || "no working muscles"})`);
      }
    }
  }
  assert.ok(checked > 0, "the rule had areas to check");
  assert.deepEqual(problems, [], summarise(problems));
});

// 4 ------------------------------------------------------ the main part
test("every anatomy main is a muscle in the vocabulary and is listed for that step", () => {
  const withMain = anatomyParts.filter(({ part }) => typeof part.main === "string");
  assert.ok(withMain.length > 0, "the shipped library names main parts");

  const problems = [];
  for (const { file, part, at } of withMain) {
    const record = vocab.get(part.main);
    if (!record) {
      problems.push(`${file} ${at}.main: ${part.main} is not in the vocabulary`);
      continue;
    }
    if (record.layer !== "muscle") {
      problems.push(`${file} ${at}.main: ${part.main} is a ${record.layer}, not a muscle`);
    }
    const listed = new Set(ANATOMY_FIELDS
      .filter((field) => field !== "nerves")
      .flatMap((field) => (Array.isArray(part[field]) ? part[field] : [])));
    if (!listed.has(part.main)) {
      problems.push(`${file} ${at}.main: ${part.main} is not in working, lengthening or bones`);
    }
  }
  assert.deepEqual(problems, [], summarise(problems));
});

// 5 ------------------------------------------------------ what is drawable
test("sideView is a boolean on every record and at least one part is not side-view drawable", () => {
  const problems = [];
  for (const record of records) {
    if (typeof record.sideView !== "boolean") {
      problems.push(`${String(record.id)}: sideView is ${typeof record.sideView}, not a boolean`);
    }
  }
  assert.deepEqual(problems, [], summarise(problems));

  const notSideView = records.filter((record) => record.sideView === false).map((record) => record.id);
  assert.ok(notSideView.length > 0, "the vocabulary marks at least one part as not drawn from the side");
});

// 6 ------------------------------------------------------ no treatment claims
test("no vocabulary text and no anatomy why line promises a cure, treatment or heal", () => {
  // The guard itself: it has to catch the wording it exists for.
  assert.equal(TREATMENT_CLAIM.test("This movement cures back pain."), true);
  assert.equal(TREATMENT_CLAIM.test("A gentle way to fix your posture."), true);
  assert.equal(TREATMENT_CLAIM.test("It treats the knee."), true);

  const problems = [];
  for (const record of records) {
    for (const field of ["name", "anatomical"]) {
      if (typeof record[field] === "string" && TREATMENT_CLAIM.test(record[field])) {
        problems.push(`${String(record.id)}.${field}: ${record[field]}`);
      }
    }
  }
  for (const { file, part, at } of anatomyParts) {
    if (typeof part.why === "string" && TREATMENT_CLAIM.test(part.why)) {
      problems.push(`${file} ${at}.why: ${part.why}`);
    }
  }
  assert.deepEqual(problems, [], summarise(problems));
});

// 7 ------------------------------------------------------ the loader rail
test("validateEntry rejects an unknown anatomy id and loadLibrary skips that entry", () => {
  const dir = mkdtempSync(join(tmpdir(), "ramble-moves-anatomy-"));
  try {
    const source = JSON.parse(readFileSync(join(LIB_DIR, "yoga-mountain.json"), "utf8"));
    const good = { ...source, easier: null, harder: null };
    const bad = {
      ...good,
      id: "yoga-mountain-unknown-part",
      anatomy: [{
        ...good.anatomy[0],
        working: [...good.anatomy[0].working, "no-such-muscle"],
      }],
    };

    assert.equal(validateEntry(good, null, { vocab: vocabIds }).ok, true);

    const rejected = validateEntry(bad, null, { vocab: vocabIds });
    assert.equal(rejected.ok, false);
    assert.ok(
      rejected.errors.some((error) => error.includes("unknown anatomy id") && error.includes("no-such-muscle")),
      `the unknown id is named: ${rejected.errors.join("; ")}`,
    );

    writeFileSync(join(dir, "a-good.json"), JSON.stringify(good));
    writeFileSync(join(dir, "b-bad.json"), JSON.stringify(bad));

    const [lib, warnings] = captureWarnings(() => loadLibrary(dir));
    assert.deepEqual(lib.map((entry) => entry.id), ["yoga-mountain"]);
    assert.ok(
      warnings.some((warning) => warning.includes("no-such-muscle")),
      `the skipped entry is named in a warning: ${warnings.join(" | ")}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});