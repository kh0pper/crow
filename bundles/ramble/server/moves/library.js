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
 * (flow pose ids, routine blocks, easier/harder). validateDrafts runs both
 * passes over a directory of drafts and returns every problem; loadLibrary
 * runs them over the shipped library and SKIPS anything invalid with a console
 * warning naming the id — one broken entry must never take the whole moves
 * surface down.
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
/** A block flow (an opener or a closer) is shorter: 2-7 poses. */
export const FLOW_BLOCK_MIN = 2;

/** The shortest chunk the picker may offer as a card. */
export const CHUNK_MIN_MINUTES = 10;
/** A routine may carry at most this many stages. */
export const STAGES_MAX = 4;
/** How many times a main block runs before "one more round". */
export const DEFAULT_MAX_ROUNDS = 2;
/** The band a landmark's reach may fall in, in metres. */
export const LANDMARK_MIN_METERS = 10;
export const LANDMARK_MAX_METERS = 500;

/** A routine is built from these three blocks, in play order. */
const BLOCK_ORDER = Object.freeze(["warmup", "main", "cooldown"]);
/** What a routine step may name (a pose, an exercise or a walk). */
const STEP_KINDS = Object.freeze(["pose", "exercise", "walk"]);
/** What the picker may offer as a card. */
const CHUNK_KINDS = Object.freeze(["flow", "routine", "landmark", "walk"]);
/** The id lists one anatomy part carries. */
const ANATOMY_ID_FIELDS = Object.freeze(["working", "lengthening", "bones", "nerves"]);

const MINUTES_MAX = 600;
/** A cue is one line on the player. */
const CUE_MAX_CHARS = 60;
const DEFAULT_DIR = fileURLToPath(new URL("./library/", import.meta.url));

const isStr = (v) => typeof v === "string" && v.trim() !== "";
/** An array of non-empty strings (possibly empty unless the caller checks length). */
const isStrArray = (v) => Array.isArray(v) && v.every(isStr);
const isPlainObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const isPositiveInt = (v) => Number.isInteger(v) && v >= 1;
const isNonNegativeInt = (v) => Number.isInteger(v) && v >= 0;

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
 * How long one entry takes to play, in seconds. A routine counts its blocks
 * (warmup and cooldown once, main once per round); a flow counts its holds;
 * anything else falls back to the announced minutes. `lib` sits in the
 * signature so a caller holding a library can pass it through; a routine's
 * plan is read from its own block seconds.
 */
export function plannedSeconds(entry, lib = null, { rounds } = {}) {
  if (!isPlainObject(entry)) return 0;
  if (entry.kind === "routine") {
    const blocks = isPlainObject(entry.blocks) ? entry.blocks : {};
    const timeOf = (items) => (Array.isArray(items) ? items : []).reduce((sum, item) => {
      const seconds = Number.isFinite(item?.seconds) ? item.seconds : 0;
      const rest = Number.isFinite(item?.restSeconds) ? item.restSeconds : 0;
      return sum + seconds + rest;
    }, 0);
    const repeat = isPositiveInt(rounds) ? rounds
      : (isPositiveInt(entry.rounds) ? entry.rounds : 1);
    return timeOf(blocks.warmup) + timeOf(blocks.main) * repeat + timeOf(blocks.cooldown);
  }
  if (entry.kind === "flow" && Array.isArray(entry.flow)) {
    return entry.flow.reduce((sum, p) => sum + (Number.isFinite(p?.holdSeconds) ? p.holdSeconds : 0), 0);
  }
  return Number.isFinite(entry.minutes) ? entry.minutes * 60 : 0;
}

/**
 * Whether the picker may offer this entry as a card: a flow, routine, landmark
 * or walk long enough to be worth standing up for, and never a shared block
 * (an opener or closer is part of a routine, not a card of its own).
 */
export function isChunk(entry) {
  if (!isPlainObject(entry)) return false;
  if (!CHUNK_KINDS.includes(entry.kind)) return false;
  if (entry.block !== undefined) return false;
  return Number.isFinite(entry.minutes) && entry.minutes >= CHUNK_MIN_MINUTES;
}

/** The anatomy vocabulary a caller may hand in, as a Set of ids (or null). */
function anatomyVocab(opts) {
  const raw = opts?.vocab;
  if (raw instanceof Set) return raw;
  if (!Array.isArray(raw)) return null;
  return new Set(raw.map((v) => (typeof v === "string" ? v : v?.id)).filter(isStr));
}

/** Every problem with the optional anatomy groups; ids are checked against `vocab`. */
function anatomyProblems(anatomy, vocab) {
  if (!Array.isArray(anatomy)) {
    return ["anatomy must be an array of { main, working, lengthening, bones, nerves } objects"];
  }
  const problems = [];
  anatomy.forEach((part, i) => {
    const at = `anatomy[${i}]`;
    if (!isPlainObject(part)) { problems.push(`${at} must be an object`); return; }
    for (const field of ANATOMY_ID_FIELDS) {
      if (part[field] === undefined) continue;
      if (!isStrArray(part[field])) {
        problems.push(`${at}.${field} must be an array of anatomy ids`);
        continue;
      }
      if (!vocab) continue;
      for (const id of part[field]) {
        if (!vocab.has(id)) problems.push(`${at}.${field} names an unknown anatomy id: ${id}`);
      }
    }
    if (part.main === undefined) return;
    if (!isStr(part.main)) { problems.push(`${at}.main must be an anatomy id`); return; }
    if (vocab && !vocab.has(part.main)) {
      problems.push(`${at}.main names an unknown anatomy id: ${part.main}`);
    }
  });
  return problems;
}

/** Every problem with one block item of a routine. */
function blockItemProblems(item, at) {
  if (!isPlainObject(item)) return [`${at} must be { id, seconds, restSeconds? }`];
  const problems = [];
  if (!isStr(item.id)) problems.push(`${at}.id must name a pose, exercise or walk`);
  if (!isPositiveInt(item.seconds)) {
    problems.push(`${at}.seconds must be a whole number of 1 or more`);
  }
  if (item.restSeconds !== undefined && !isNonNegativeInt(item.restSeconds)) {
    problems.push(`${at}.restSeconds must be a whole number of 0 or more when present`);
  }
  return problems;
}

/** Every problem with a routine's three blocks (shape only). */
function routineBlockProblems(blocks) {
  if (!isPlainObject(blocks)) {
    return ["a routine needs a blocks object with warmup, main and cooldown arrays"];
  }
  const problems = [];
  for (const name of BLOCK_ORDER) {
    const items = blocks[name];
    if (!Array.isArray(items) || items.length === 0) {
      problems.push(`blocks.${name} is required and must be a non-empty array`);
      continue;
    }
    items.forEach((item, i) => { problems.push(...blockItemProblems(item, `blocks.${name}[${i}]`)); });
  }
  return problems;
}

/**
 * Every problem with a routine's references to other entries: each step names a
 * pose, exercise or walk; skipIf and equipment cover what the steps ask of the
 * body; and the announced minutes match the planned block time.
 */
function routineReferenceProblems(obj, lookup, { allowUnreviewed = false } = {}) {
  const problems = [];
  const blocks = isPlainObject(obj.blocks) ? obj.blocks : {};
  const steps = [];
  for (const name of BLOCK_ORDER) {
    const items = Array.isArray(blocks[name]) ? blocks[name] : [];
    items.forEach((item, i) => {
      if (!isPlainObject(item) || !isStr(item.id)) return;
      const at = `blocks.${name}[${i}]`;
      const target = lookup.get(item.id);
      if (!target) { problems.push(`${at} names an unknown id: ${item.id}`); return; }
      if (!STEP_KINDS.includes(target.kind)) {
        problems.push(`${at} must name a pose, exercise or walk, but ${item.id} is ${target.kind}`);
        return;
      }
      if (!allowUnreviewed && target.reviewed !== true) {
        problems.push(`${at} names an entry that is not reviewed yet: ${item.id}`);
      }
      steps.push(target);
    });
  }

  const limits = new Set();
  const kit = new Set();
  for (const step of steps) {
    for (const tag of Array.isArray(step.skipIf) ? step.skipIf : []) limits.add(tag);
    for (const item of Array.isArray(step.equipment) ? step.equipment : []) {
      if (item !== "none") kit.add(item);
    }
  }
  const skipIf = Array.isArray(obj.skipIf) ? obj.skipIf : [];
  for (const tag of [...limits].sort()) {
    if (!skipIf.includes(tag)) problems.push(`skipIf must include "${tag}" for the steps this routine uses`);
  }
  const equipment = Array.isArray(obj.equipment) ? obj.equipment : [];
  for (const item of [...kit].sort()) {
    if (!equipment.includes(item)) {
      problems.push(`equipment must include "${item}" for the steps this routine uses`);
    }
  }

  if (Number.isInteger(obj.minutes) && obj.minutes >= 1) {
    const planned = plannedSeconds(obj) / 60;
    if (planned > 0 && Math.abs(obj.minutes - planned) > 0.15 * planned) {
      const shown = Math.round(planned * 10) / 10;
      problems.push(`minutes is ${obj.minutes}, more than 15% away from the planned ${shown} minutes of blocks`);
    }
  }
  return problems;
}

/**
 * Shape-check one entry. `lib` (optional) enables the cross-reference checks:
 * every flow item must name a POSE that exists, every routine step a reviewed
 * pose, exercise or walk, and easier/harder must exist. `opts.vocab` (optional)
 * turns on the anatomy id checks; `opts.allowUnreviewed` relaxes the review
 * requirement (drafts). Returns { ok, errors } — never throws, so a caller can
 * show every problem at once instead of the first.
 */
export function validateEntry(obj, lib = null, opts = {}) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, errors: ["entry must be an object"] };
  }
  const errors = [];
  const lookup = idLookup(lib);
  const options = isPlainObject(opts) ? opts : {};
  const allowUnreviewed = options.allowUnreviewed === true;
  const vocab = anatomyVocab(options);

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
  // Per-step anatomy. Its ids are only checked when the caller hands a vocabulary.
  if (obj.anatomy !== undefined) errors.push(...anatomyProblems(obj.anatomy, vocab));
  // Lifted out of the prose steps (exercises).
  for (const field of ["sets", "reps", "tempoSeconds"]) {
    if (obj[field] !== undefined && !isPositiveInt(obj[field])) {
      errors.push(`${field} must be a whole number of 1 or more when present`);
    }
  }
  if (obj.perSide !== undefined && typeof obj.perSide !== "boolean") {
    errors.push("perSide must be true or false when present");
  }
  // How many times the main block (or the whole flow) runs.
  if (obj.kind === "routine" || obj.kind === "flow") {
    for (const field of ["rounds", "maxRounds"]) {
      if (obj[field] !== undefined && !isPositiveInt(obj[field])) {
        errors.push(`${field} must be a whole number of 1 or more when present`);
      }
    }
  }
  if (obj.stages !== undefined
    && (!Array.isArray(obj.stages) || obj.stages.length > STAGES_MAX)) {
    errors.push(`stages must be an array of at most ${STAGES_MAX} members when present`);
  }
  // A shared block is a flow's marker: an opener or a closer, never a card alone.
  if (obj.block !== undefined) {
    if (!BLOCK_KINDS.includes(obj.block)) {
      errors.push(`block must be one of ${BLOCK_KINDS.join(", ")} when present`);
    } else if (obj.kind !== "flow") {
      errors.push(`only a flow entry carries a block, and this entry is a ${String(obj.kind)}`);
    }
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
    const blockFlow = BLOCK_KINDS.includes(obj.block);
    const least = blockFlow ? FLOW_BLOCK_MIN : FLOW_MIN;
    if (!Array.isArray(obj.flow)) {
      errors.push("a flow entry needs a flow array");
    } else {
      if (obj.flow.length < least || obj.flow.length > FLOW_MAX) {
        errors.push(blockFlow
          ? `a block flow holds ${FLOW_BLOCK_MIN}-${FLOW_MAX} poses, got ${obj.flow.length}`
          : `a flow holds ${FLOW_MIN}-${FLOW_MAX} poses, got ${obj.flow.length}`);
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
  if (obj.kind === "routine") {
    errors.push(...routineBlockProblems(obj.blocks));
    if (Number.isInteger(obj.minutes) && obj.minutes < CHUNK_MIN_MINUTES) {
      errors.push(`a routine is a chunk: minutes must be ${CHUNK_MIN_MINUTES} or more`);
    }
    if (lookup) errors.push(...routineReferenceProblems(obj, lookup, { allowUnreviewed }));
  }
  if (obj.kind === "landmark") {
    if (!LANDMARK_KINDS.includes(obj.landmark)) {
      errors.push(`landmark must be one of ${LANDMARK_KINDS.join(", ")}`);
    }
    if (!Number.isInteger(obj.reachMeters)
      || obj.reachMeters < LANDMARK_MIN_METERS || obj.reachMeters > LANDMARK_MAX_METERS) {
      errors.push(`reachMeters must be a whole number from ${LANDMARK_MIN_METERS} to ${LANDMARK_MAX_METERS}`);
    }
    if (Number.isInteger(obj.minutes) && obj.minutes < CHUNK_MIN_MINUTES) {
      errors.push(`a landmark is a chunk: minutes must be ${CHUNK_MIN_MINUTES} or more`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Read every .json file in `root`, parsed. One bad file becomes one
 * { file, error } and never stops the walk. A missing directory comes back as
 * `dirError` so each caller can decide what to say about it.
 */
function readEntryFiles(root) {
  let names;
  try {
    names = readdirSync(root).filter((n) => n.endsWith(".json")).sort();
  } catch (err) {
    return { dirError: err, files: [], problems: [] };
  }
  const files = [];
  const problems = [];
  for (const name of names) {
    let obj;
    try {
      obj = JSON.parse(readFileSync(join(root, name), "utf8"));
    } catch (err) {
      problems.push({ file: name, error: `unreadable or invalid JSON: ${err?.message ?? "parse error"}` });
      continue;
    }
    files.push({ file: name, obj });
  }
  return { dirError: null, files, problems };
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
  const { dirError, files, problems } = readEntryFiles(root);
  if (dirError) {
    console.warn(`[ramble moves] library directory ${root} unreadable:`, dirError?.message);
    return [];
  }
  const warn = (id, errors) => console.warn(`[ramble moves] skipping entry ${id}: ${errors.join("; ")}`);
  for (const { file, error } of problems) {
    console.warn(`[ramble moves] skipping file ${file}: ${error}`);
  }

  const pool = [];
  const byId = new Map();
  for (const { file, obj } of files) {
    const basic = validateEntry(obj);
    if (!basic.ok) { warn(obj?.id ?? file, basic.errors); continue; }
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
 * The review rail for a directory of drafts: the same two passes as loadLibrary
 * but every problem is collected and returned instead of warned, and an
 * unreviewed entry (or a routine over one) is accepted. Never throws.
 */
export function validateDrafts(dir) {
  const root = dir ? String(dir) : DEFAULT_DIR;
  const errors = [];
  try {
    const { dirError, files, problems } = readEntryFiles(root);
    if (dirError) {
      return { ok: false, errors: [{ file: String(root), error: `library directory unreadable: ${dirError?.message ?? "unknown error"}` }] };
    }
    errors.push(...problems);

    const shapeOk = [];
    const byId = new Map();
    for (const { file, obj } of files) {
      const basic = validateEntry(obj);
      if (!basic.ok) {
        for (const error of basic.errors) errors.push({ file, error });
        continue;
      }
      if (byId.has(obj.id)) {
        errors.push({ file, error: `duplicate id, already loaded from an earlier file: ${obj.id}` });
        continue;
      }
      byId.set(obj.id, obj);
      shapeOk.push({ file, obj });
    }

    for (const { file, obj } of shapeOk) {
      const full = validateEntry(obj, byId, { allowUnreviewed: true });
      if (full.ok) continue;
      for (const error of full.errors) errors.push({ file, error });
    }
    return { ok: errors.length === 0, errors };
  } catch (err) {
    errors.push({ file: String(root), error: `drafts could not be read: ${err?.message ?? "unknown error"}` });
    return { ok: false, errors };
  }
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
