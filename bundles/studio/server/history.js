/**
 * Studio history — the shared, per-song list of steps and the selective undo
 * that lets anyone take one step back without clobbering a later edit.
 *
 * One applied command is one entry, in the shape the store persists:
 *
 *   {id, song_id, seq, command, args, author, summary, touched,
 *    inverse: {before, after}, undo_of, undone_by, created_at}
 *
 * `inverse.before` is what the fields held before the command, `inverse.after`
 * is what the command wrote. Both are keyed the way doc.js writes them —
 * `"<ref>|<field>"`, with `"*"` for a whole created or deleted object (see
 * `applyBeforeAfter` in doc.js).
 *
 * Undo is selective, not chronological (spec §5.3). Each key of
 * `inverse.after` is compared with what the document holds now:
 *
 *   still equal   → plan to restore `inverse.before` for that key;
 *   changed since → report a conflict and leave the field alone.
 *
 * So an old step taken back after someone touched a *different* field of the
 * same object reverts only its own field, and a step whose field has since
 * changed is reported per field instead of overwriting the newer edit.
 *
 * Nothing here opens a transaction: `applyPlan` runs inside the caller's
 * `doc.transact(...)`, so one undo stays one Yjs update and one history step.
 */

import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  applyBeforeAfter,
  cloneJson,
  parseObjectRef,
  readField as readDocField,
  splitRefField,
} from "./doc.js";
import { StudioError } from "./commands/registry.js";

/** The command id an undo entry carries. */
export const UNDO_COMMAND = "history.undo";

/** The command id a redo entry carries. */
export const REDO_COMMAND = "history.redo";

/**
 * Restore order: the song, then the tracks and scenes, then the clips they
 * carry. A track removal is recorded as one `"*"` key per object, so putting a
 * track back before its clips keeps the document consistent at every step.
 */
const REF_ORDER = Object.freeze({ song: 0, track: 1, scene: 2, clip: 3 });

/**
 * Read one value out of the document by a history key.
 * @param {import("yjs").Doc} doc
 * @param {string} key - e.g. `"clip:abc|notes"` or `"track:abc|*"`
 * @returns {any} the value as the document holds it now, or `undefined` when
 *   the object or the field is not there
 * @throws {StudioError} code "invalid" when `key` is not a `"<ref>|<field>"` key
 */
export function readField(doc, key) {
  const split = splitRefField(key);
  if (!split) {
    throw new StudioError("invalid", `"${key}" is not a "<ref>|<field>" history key.`);
  }
  return readDocField(doc, split.ref, split.field);
}

/** @returns {Map<string, any>} a before/after map as a Map, undefined values kept. */
function fieldMap(map) {
  if (!map) return new Map();
  if (map instanceof Map) return new Map(map);
  return new Map(Object.entries(map));
}

/** @returns {object} a deep copy of a before/after map, `undefined` values kept. */
function copyFieldMap(map) {
  const out = {};
  for (const [key, value] of fieldMap(map)) out[key] = cloneJson(value);
  return out;
}

/** @returns {number} the restore order of the object a key names. */
function refRank(key) {
  const split = splitRefField(key);
  const target = split ? parseObjectRef(split.ref) : null;
  return REF_ORDER[target?.kind] ?? Object.keys(REF_ORDER).length;
}

/** @returns {Map<string, any>} a plan in restore order, insertion order kept within a kind. */
function orderPlan(planned) {
  const ordered = new Map();
  const keys = [...planned.keys()].sort((a, b) => refRank(a) - refRank(b));
  for (const key of keys) ordered.set(key, planned.get(key));
  return ordered;
}

/**
 * Build one history entry — the shape the store persists, with the two maps
 * a later undo compares against.
 * @param {{song_id: string, seq: number, command: string, args?: object|null,
 *          author?: {kind?: string, id?: string, label?: string}|null,
 *          summary?: string, touched?: string[], before?: object|Map<string, any>,
 *          after?: object|Map<string, any>, undo_of?: string|null,
 *          undone_by?: string|null, created_at?: string}} spec
 * @returns {{id: string, song_id: string, seq: number, command: string, args: object|null,
 *            author: object|null, summary: string, touched: string[],
 *            inverse: {before: object, after: object}, undo_of: string|null,
 *            undone_by: string|null, created_at: string}}
 * @throws {TypeError} when the song, the command id or the sequence is missing
 */
export function makeEntry({
  song_id,
  seq,
  command,
  args = null,
  author = null,
  summary = "",
  touched = [],
  before = {},
  after = {},
  undo_of = null,
  undone_by = null,
  created_at,
} = {}) {
  if (typeof song_id !== "string" || song_id === "") {
    throw new TypeError("Studio history: an entry needs a song_id");
  }
  if (typeof command !== "string" || command === "") {
    throw new TypeError("Studio history: an entry needs a command id");
  }
  if (!Number.isInteger(seq) || seq < 1) {
    throw new TypeError("Studio history: an entry needs a positive integer seq");
  }

  return {
    id: randomUUID(),
    song_id,
    seq,
    command,
    args: args == null ? null : cloneJson(args),
    author: author == null
      ? null
      : { kind: author.kind ?? null, id: author.id ?? null, label: author.label ?? null },
    summary: typeof summary === "string" ? summary : "",
    touched: Array.isArray(touched) ? [...touched] : [],
    inverse: { before: copyFieldMap(before), after: copyFieldMap(after) },
    undo_of: undo_of ?? null,
    undone_by: undone_by ?? null,
    created_at: created_at ?? new Date().toISOString(),
  };
}

/**
 * Plan the selective undo of one step: which fields go back, and which can no
 * longer be taken back because someone changed them since.
 *
 * A field whose current value is exactly what the step wrote is restored to
 * what it held before. A field that has changed since is reported in
 * `conflicts` and left alone. A `"*"` key compares (and restores) the whole
 * object, and is skipped when another field of the same object is already in
 * conflict — the object is no longer the one the step made.
 *
 * Reads the document; changes nothing. Apply the result with `applyPlan`.
 * @param {import("yjs").Doc} doc
 * @param {object} entry - a history entry, as `makeEntry` returns it
 * @returns {{apply: Map<string, any>, conflicts: Array<{ref: string, field: string, expected: any, actual: any}>}}
 * @throws {StudioError} code "conflict" when the step is already undone,
 *   code "invalid" when the entry carries nothing to undo
 */
export function planUndo(doc, entry) {
  if (entry?.undone_by) {
    throw new StudioError("conflict", "That step is already undone.");
  }
  if (!entry?.inverse || typeof entry.inverse !== "object") {
    throw new StudioError("invalid", "That history step has nothing to undo.");
  }

  const before = fieldMap(entry.inverse.before);
  const after = fieldMap(entry.inverse.after);
  const planned = new Map();
  const conflicts = [];
  const refsInConflict = new Set();

  const keys = [...after.keys()];
  for (const key of keys) {
    const split = splitRefField(key);
    if (!split) {
      throw new StudioError("invalid", `"${key}" is not a "<ref>|<field>" history key.`);
    }
    if (split.field === "*") continue;

    const expected = after.get(key);
    const actual = readField(doc, key);
    if (isDeepStrictEqual(actual, expected)) {
      planned.set(key, cloneJson(before.get(key)));
      continue;
    }
    conflicts.push({ ref: split.ref, field: split.field, expected: cloneJson(expected), actual });
    refsInConflict.add(split.ref);
  }

  for (const key of keys) {
    const split = splitRefField(key);
    if (!split || split.field !== "*") continue;
    // One of this object's fields has already moved on: leave the whole
    // object alone rather than rebuilding it around a newer edit.
    if (refsInConflict.has(split.ref)) continue;

    const expected = after.get(key);
    const actual = readField(doc, key);
    if (isDeepStrictEqual(actual, expected)) {
      planned.set(key, cloneJson(before.get(key)));
      continue;
    }
    conflicts.push({ ref: split.ref, field: "*", expected: cloneJson(expected), actual });
  }

  return { apply: orderPlan(planned), conflicts };
}

/**
 * Plan a redo: the same comparison as an undo, run against the undo entry
 * itself. An undo entry's `inverse` is already the swap of what it changed
 * (its `after` is what the undo wrote), so redoing is undoing the undo.
 * @param {import("yjs").Doc} doc
 * @param {object} undoEntry - the `history.undo` entry to take back
 * @returns {{apply: Map<string, any>, conflicts: Array<{ref: string, field: string, expected: any, actual: any}>}}
 * @throws {StudioError} code "conflict" when that undo has itself been undone
 */
export function planRedo(doc, undoEntry) {
  return planUndo(doc, undoEntry);
}

/**
 * Write a plan onto the document: exactly the fields it names, nothing else.
 *
 * Runs inside the caller's transaction (the hub wraps it in
 * `doc.transact(fn, origin)`); it opens none of its own, so an undo stays one
 * Yjs update and one history step.
 * @param {import("yjs").Doc} doc
 * @param {{apply: Map<string, any>}|Map<string, any>|Object<string, any>|null} plan
 * @returns {void}
 */
export function applyPlan(doc, plan) {
  const planned = plan?.apply ?? plan;
  if (!planned) return;
  const entries = planned instanceof Map ? [...planned.entries()] : Object.entries(planned);
  if (entries.length === 0) return;
  applyBeforeAfter(doc, new Map(entries));
}

/**
 * Build the history entry an undo (or a redo) appends: a swap of the fields
 * its plan changed.
 *
 * `inverse.after` holds what the undo wrote, `inverse.before` what it
 * replaced, so `planUndo` on this entry takes the undo back again.
 * @param {{entry: object, plan: {apply: Map<string, any>}, song_id?: string,
 *          seq: number, author?: object|null, command?: string, summary?: string}} spec
 * @returns {object} the entry, as `makeEntry` returns it
 * @throws {TypeError} when the entry, the plan or the sequence is missing
 */
export function makeUndoEntry({
  entry,
  plan,
  song_id,
  seq,
  author = null,
  command = UNDO_COMMAND,
  summary,
} = {}) {
  if (!entry || typeof entry !== "object" || typeof entry.id !== "string") {
    throw new TypeError("Studio history: an undo needs the entry it takes back");
  }
  const planned = plan?.apply ?? plan;
  if (!(planned instanceof Map)) {
    throw new TypeError("Studio history: an undo needs a plan whose apply is a Map");
  }

  const originalAfter = fieldMap(entry.inverse?.after);
  const before = {};
  const after = {};
  for (const [key, value] of planned) {
    before[key] = cloneJson(originalAfter.get(key));
    after[key] = cloneJson(value);
  }

  const refs = [...new Set([...planned.keys()].map((key) => splitRefField(key)?.ref).filter(Boolean))];
  const isRedo = command === REDO_COMMAND;
  const line = typeof entry.summary === "string" && entry.summary !== "" ? `: ${entry.summary}` : "";

  return makeEntry({
    song_id: song_id ?? entry.song_id,
    seq,
    command,
    args: { entry_id: entry.id },
    author,
    summary: summary ?? `${isRedo ? "Redid" : "Undid"} step ${entry.seq}${line}`,
    touched: refs,
    before,
    after,
    undo_of: entry.id,
  });
}