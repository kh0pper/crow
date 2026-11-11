/**
 * The moves library (moves design Task 1; private engineering notes): the
 * entry format, the fixed vocabularies entries are checked against, and the
 * on-disk loader. One JSON file per entry under moves/library/.
 *
 * CONTENT RULES this module enforces:
 *   - The server serves only entries with `"reviewed": true` (servedLibrary).
 *   - Every entry cites at least one source {title, url, license}. The source
 *     register is moves/SOURCES.md; a source still marked UNVERIFIED there
 *     may not be cited by any shipped entry (review is what flips the flag).
 *   - `skipIf` is the fixed LIMIT_TAGS vocabulary — the safety question the
 *     picker can ask with no model in the loop.
 *
 * validateEntry checks ONE entry's shape; pass a loaded library (array or
 * id->entry Map) as the second argument to also resolve cross-references
 * (flow pose ids, easier/harder). loadLibrary runs both passes and SKIPS
 * anything invalid with a console warning naming the id — one broken entry
 * must never take the whole moves surface down.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ENTRY_KINDS = Object.freeze([
  "pose", "exercise", "flow", "walk", "routine", "landmark",
]);
export const LIMIT_TAGS = Object.freeze([
  "knee", "lower_back", "neck", "shoulder", "wrist",
  "hip", "ankle", "balance", "pregnancy", "high_blood_pressure",
]);
export const EQUIPMENT = Object.freeze(["none", "mat", "band", "chair", "wall"]);
export const ACTIVITY_KINDS = Object.freeze([
  "yoga", "walk", "jog", "run", "cycle", "band", "bodyweight", "swim", "sport", "other",
]);

/** The five areas an entry may train (moves design §5.1). */
export const AREAS = Object.freeze(["upper", "core", "lower", "heart", "mobility"]);
/** The areas a balance-flavoured walk leans on, in picker order. */
export const BALANCE_AREAS = Object.freeze(["mobility", "core", "upper", "lower"]);
/** The two shared block kinds: an opener and a closer, never a card alone. */
export const BLOCK_KINDS = Object.freeze(["warmup", "cooldown"]);
/** What a landmark entry may stand for (§4.5). */
export const LANDMARK_KINDS = Object.freeze([
  "park", "trail", "stairs", "hill", "water", "track",
  "playground", "bench", "plaza", "nest", "heart", "fog",
]);

/** A flow is a short sequence: 5-7 poses, each held. */
export const FLOW_MIN = 5;
export const FLOW_MAX = 7;

/** The shortest chunk the picker may offer as a card. */
export const CHUNK_MIN_MINUTES = 10;
/** A routine may carry at most this many stages. */
export const STAGES_MAX = 4;
/** How many times a main block runs before "one more round". */
export const DEFAULT_MAX_ROUNDS = 2;

const MINUTES_MAX = 600;
/** A cue is one line on the player. */
const CUE_MAX_CHARS = 60;
const DEFAULT_DIR = fileURLToPath(new URL("./library/", import.meta.url));

const isStr = (v) => typeof v === "string" && v.trim() !== "";
/** An array of non-empty strings (possibly empty unless the caller checks length). */
const isStrArray = (v) => Array.isArray(v) && v.every(isStr);
const isPlainObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const isPositiveInt = (v) => Number.isInteger(v) && v >= 1;

/**
 * Normalize one step to { text, cue, say, at }. A plain string is treated as
 * its own text: cue falls back to text, say to cue, and at to 0.
 */
export function stepOf(step) {
  const raw = isPlainObject(step) ? step : {};
  const text = typeof step === "string" ? step
    : (typeof raw.text === "string" ? raw.text : "");
  const cue = typeof raw.cue === "string" ? raw.cue : text;
  const say = typeof raw.say === "string" ? raw.say : cue;
  const at = Number.isInteger(raw.at) && raw.at >= 0 ? raw.at : 0;
  return { text, cue, say, at };
}

/** Every problem with one step, as messages that all name `steps`. */
function stepProblems(step, i) {
  const at = `steps[${i}]`;
  if (typeof step === "string") return isStr(step) ? [] : [`${at} must be a non-empty string`];
  if (!isPlainObject(step)) return [`${at} must be a string or a { text, cue, say, at } object`];
  const problems = [];
  if (!isStr(step.text)) problems.push(`${at}.text must be a non-empty string`);
  if (step.cue !== undefined
    && (typeof step.cue !== "string" || step.cue.length > CUE_MAX_CHARS)) {
    problems.push(`${at}.cue must be a string of at most ${CUE_MAX_CHARS} characters`);
  }
  if (step.say !== undefined && !isStr(step.say)) {
    problems.push(`${at}.say must be a non-empty string when present`);
  }
  if (step.at !== undefined && (!Number.isInteger(step.at) || step.at < 0)) {
    problems.push(`${at}.at must be a whole number of 0 or more`);
  }
  return problems;
}

/** Normalize the optional second validateEntry argument to an id->entry Map. */
function idLookup(lib) {
  if (lib instanceof Map) return lib;
  if (Array.isArray(lib)) {
    return new Map(lib.filter((e) => e && typeof e.id === "string").map((e) => [e.id, e]));
  }
  return null;
}

/**
 * Shape-check one entry. `lib` (optional) enables the cross-reference checks:
 * every flow item must name a POSE that exists, and easier/harder must exist.
 * Returns { ok, errors } — never throws, so a caller can show every problem
 * at once instead of the first.
 */
export function validateEntry(obj, lib = null) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, errors: ["entry must be an object"] };
  }
  const errors = [];
  const lookup = idLookup(lib);

  // Identity.
  if (!isStr(obj.id)) errors.push("id must be a non-empty string");
  if (!ENTRY_KINDS.includes(obj.kind)) errors.push(`kind must be one of ${ENTRY_KINDS.join(", ")}`);
  if (!isStr(obj.title)) errors.push("title must be a non-empty string");
  if (!Number.isInteger(obj.minutes) || obj.minutes < 1 || obj.minutes > MINUTES_MAX) {
    errors.push(`minutes must be a whole number from 1 to ${MINUTES_MAX}`);
  }
  if (![1, 2, 3].includes(obj.level)) errors.push("level must be 1, 2 or 3");
  if (typeof obj.indoor !== "boolean") errors.push("indoor must be true or false");
  if (!ACTIVITY_KINDS.includes(obj.activity)) errors.push(`activity must be one of ${ACTIVITY_KINDS.join(", ")}`);
  if (!Array.isArray(obj.equipment) || !obj.equipment.every((e) => EQUIPMENT.includes(e))) {
    errors.push(`equipment must be an array drawn from ${EQUIPMENT.join(", ")}`);
  }
  if (!isStrArray(obj.tags)) errors.push("tags must be an array of non-empty strings");

  // Teaching.
  if (!Array.isArray(obj.steps) || obj.steps.length === 0) {
    errors.push("steps must be a non-empty array of step strings or { text, cue, say, at } objects");
  } else {
    obj.steps.forEach((step, i) => { errors.push(...stepProblems(step, i)); });
  }
  for (const field of ["works", "stretches", "mistakes"]) {
    if (!isStrArray(obj[field])) errors.push(`${field} must be an array of non-empty strings`);
  }
  // The trained areas, when an entry names them at all.
  if (obj.areas !== undefined) {
    if (!Array.isArray(obj.areas) || obj.areas.length === 0
      || !obj.areas.every((a) => AREAS.includes(a))) {
      errors.push(`areas must be a non-empty array drawn from ${AREAS.join(", ")}`);
    }
  }
  // Lifted out of the prose steps (exercises).
  for (const field of ["sets", "reps", "tempoSeconds"]) {
    if (obj[field] !== undefined && !isPositiveInt(obj[field])) {
      errors.push(`${field} must be a whole number of 1 or more when present`);
    }
  }
  if (obj.perSide !== undefined && typeof obj.perSide !== "boolean") {
    errors.push("perSide must be true or false when present");
  }
  // Two key positions so the figure can move between them.
  if (obj.poses !== undefined) {
    if (!Array.isArray(obj.poses) || obj.poses.length !== 2 || !obj.poses.every(isPlainObject)) {
      errors.push("poses must be exactly two objects [start, end] when present");
    }
  }
  if (!Array.isArray(obj.skipIf)) {
    errors.push("skipIf is required (use [] when no limitation applies)");
  } else {
    for (const t of obj.skipIf) {
      if (!LIMIT_TAGS.includes(t)) errors.push(`skipIf tag is not in the fixed vocabulary: ${String(t)}`);
    }
  }
  for (const field of ["easier", "harder"]) {
    const v = obj[field];
    if (v === null) continue;
    if (!isStr(v)) { errors.push(`${field} must be an entry id or null`); continue; }
    if (lookup && !lookup.has(v)) errors.push(`${field} does not resolve to a known entry: ${v}`);
  }

  // Provenance.
  if (!Array.isArray(obj.sources) || obj.sources.length === 0) {
    errors.push("sources must name at least one source (see moves/SOURCES.md)");
  } else {
    obj.sources.forEach((s, i) => {
      if (!s || typeof s !== "object" || Array.isArray(s)) { errors.push(`sources[${i}] must be an object`); return; }
      if (!isStr(s.title)) errors.push(`sources[${i}].title must be a non-empty string`);
      if (typeof s.url !== "string") errors.push(`sources[${i}].url must be a string ("" until the host page has been checked)`);
      if (!isStr(s.license)) errors.push(`sources[${i}].license must be a non-empty string`);
    });
  }
  if (typeof obj.reviewed !== "boolean") errors.push("reviewed must be true or false");

  // Kind-specific. The pose object's joint-angle shape belongs to the figure
  // builder (Task 2); here it only has to be present and be an object.
  if (obj.kind === "pose"
    && (!obj.pose || typeof obj.pose !== "object" || Array.isArray(obj.pose))) {
    errors.push("a pose entry needs a pose object (joint angles; shape checked by the figure builder)");
  }
  if (obj.kind === "flow") {
    if (!Array.isArray(obj.flow)) {
      errors.push("a flow entry needs a flow array");
    } else {
      if (obj.flow.length < FLOW_MIN || obj.flow.length > FLOW_MAX) {
        errors.push(`a flow holds ${FLOW_MIN}-${FLOW_MAX} poses, got ${obj.flow.length}`);
      }
      obj.flow.forEach((p, i) => {
        if (!p || typeof p !== "object" || !isStr(p.id)
          || !Number.isInteger(p.holdSeconds) || p.holdSeconds < 1) {
          errors.push(`flow[${i}] must be { id, holdSeconds } with a whole holdSeconds >= 1`);
          return;
        }
        if (!lookup) return;
        const target = lookup.get(p.id);
        if (!target) errors.push(`flow[${i}] names an unknown id: ${p.id}`);
        else if (target.kind !== "pose") errors.push(`flow[${i}] must name a pose, but ${p.id} is ${target.kind}`);
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Every entry in `dir` (default: moves/library/), validated. Invalid files are
 * SKIPPED with a console warning naming the id (or the file, when there is no
 * readable id) — never thrown. Two passes: shape first, then cross-references
 * against everything that passed shape, so a flow can only name a pose that
 * itself is valid.
 */
export function loadLibrary(dir) {
  const root = dir ? String(dir) : DEFAULT_DIR;
  let names;
  try {
    names = readdirSync(root).filter((n) => n.endsWith(".json")).sort();
  } catch (err) {
    console.warn(`[ramble moves] library directory ${root} unreadable:`, err?.message);
    return [];
  }
  const warn = (id, errors) => console.warn(`[ramble moves] skipping entry ${id}: ${errors.join("; ")}`);

  const pool = [];
  const byId = new Map();
  for (const name of names) {
    let obj;
    try {
      obj = JSON.parse(readFileSync(join(root, name), "utf8"));
    } catch (err) {
      console.warn(`[ramble moves] skipping file ${name}: ${err?.message}`);
      continue;
    }
    const basic = validateEntry(obj);
    if (!basic.ok) { warn(obj?.id ?? name, basic.errors); continue; }
    if (byId.has(obj.id)) { warn(obj.id, ["duplicate id, already loaded from an earlier file"]); continue; }
    byId.set(obj.id, obj);
    pool.push(obj);
  }

  const out = [];
  for (const entry of pool) {
    const full = validateEntry(entry, byId);
    if (!full.ok) { warn(entry.id, full.errors); continue; }
    out.push(entry);
  }
  return out;
}

/**
 * What the server may show: reviewed entries only, closed over their references. A
 * reviewed flow that names an unreviewed pose is held back too, and an easier/harder
 * link to an unreviewed entry reads as null, so nothing served points at unserved text.
 */
export function servedLibrary(dir) {
  const reviewed = loadLibrary(dir).filter((e) => e.reviewed === true);
  const ids = new Set(reviewed.map((e) => e.id));
  return reviewed
    .filter((e) => e.kind !== "flow" || e.flow.every((step) => ids.has(step.id)))
    .map((e) => ({
      ...e,
      easier: e.easier && ids.has(e.easier) ? e.easier : null,
      harder: e.harder && ids.has(e.harder) ? e.harder : null,
    }));
}

/** Look one entry out of an already-loaded library. */
export function entryById(lib, id) {
  if (!Array.isArray(lib) || typeof id !== "string") return null;
  return lib.find((e) => e && e.id === id) ?? null;
}
