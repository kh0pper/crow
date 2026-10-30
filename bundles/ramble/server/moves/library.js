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

export const ENTRY_KINDS = Object.freeze(["pose", "exercise", "flow", "walk"]);
export const LIMIT_TAGS = Object.freeze([
  "knee", "lower_back", "neck", "shoulder", "wrist",
  "hip", "ankle", "balance", "pregnancy", "high_blood_pressure",
]);
export const EQUIPMENT = Object.freeze(["none", "mat", "band", "chair", "wall"]);
export const ACTIVITY_KINDS = Object.freeze([
  "yoga", "walk", "jog", "run", "cycle", "band", "bodyweight", "swim", "sport", "other",
]);

/** A flow is a short sequence: 5-7 poses, each held. */
export const FLOW_MIN = 5;
export const FLOW_MAX = 7;

const MINUTES_MAX = 600;
const DEFAULT_DIR = fileURLToPath(new URL("./library/", import.meta.url));

const isStr = (v) => typeof v === "string" && v.trim() !== "";
/** An array of non-empty strings (possibly empty unless the caller checks length). */
const isStrArray = (v) => Array.isArray(v) && v.every(isStr);

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
  if (!Array.isArray(obj.steps) || obj.steps.length === 0 || !obj.steps.every(isStr)) {
    errors.push("steps must be a non-empty array of non-empty strings");
  }
  for (const field of ["works", "stretches", "mistakes"]) {
    if (!isStrArray(obj[field])) errors.push(`${field} must be an array of non-empty strings`);
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

/** What the server may show: reviewed entries only. */
export function servedLibrary(dir) {
  return loadLibrary(dir).filter((e) => e.reviewed === true);
}

/** Look one entry out of an already-loaded library. */
export function entryById(lib, id) {
  if (!Array.isArray(lib) || typeof id !== "string") return null;
  return lib.find((e) => e && e.id === id) ?? null;
}
