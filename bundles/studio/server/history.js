/**
 * Studio history — the shared, per-song list of steps and the selective undo
 * that lets anyone take one step back without clobbering a later edit.
 *
 * One applied command is one entry, in the shape the store persists:
 *
 *   {id, song_id, seq, command, args, author, summary, touched,
 *    inverse: {before, after, guards?}, undo_of, undone_by, created_at}
 *
 * `inverse.before` is what the fields held before the command, `inverse.after`
 * is what the command wrote. Both are keyed the way doc.js writes them —
 * `"<ref>|<field>"`, with `"*"` for a whole created or deleted object (see
 * `applyBeforeAfter` in doc.js). A value of `null` means "the object or field
 * did not exist": `null` survives the JSON round trip through the store, while
 * `undefined` would be dropped and turn a deletion into a no-op.
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
 * A plan is dry-run before it is offered: its writes are applied to a clone of
 * the document and `checkInvariants()` (doc.js) is run on the clone. A plan
 * that would throw, or that would leave the song inconsistent — a clip without
 * its track or scene, notes past the clip's end, more tracks or scenes than a
 * song may hold, two objects sharing an id — comes back with an empty `apply`
 * and a `blocked` list of plain-English reasons instead of a half-applied
 * edit. Because the plan is known to be applicable, `applyPlan` on the real
 * document cannot fail half-way.
 *
 * An entry may also carry `inverse.guards`: fields that must still hold what
 * they held when the step was recorded, compared like `after` keys but never
 * restored. A controller value only means what it meant inside the device it
 * was set on, so `track.set_param` guards on the device type: after a device
 * swap the step conflicts (and that track is left alone) instead of writing an
 * old controller into the new module.
 *
 * Undo of an entry E creates U (undo_of=E, E.undone_by=U). Redo of E means
 * undoing U, creating R (undo_of=U, U.undone_by=R). E stays undone_by=U; to
 * take the change back out again, undo R.
 *
 * Nothing here opens a transaction: `applyPlan` runs inside the caller's
 * `doc.transact(...)`, so one undo stays one Yjs update and one history step.
 */

import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import * as Y from "yjs";
import {
  STEP_GUARDS,
  applyBeforeAfter,
  checkInvariants,
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
 * The value a history map carries when the object or field did not exist.
 * `null`, so it survives `JSON.stringify` (which drops `undefined` keys).
 */
const ABSENT = null;

/**
 * What `readField` reports for a single field whose owning object is not in the
 * document any more — distinct from `null`, which means "the object is there
 * but that field is not". An undo reports it as a conflict with `gone: true`
 * instead of mistaking a removed object for a missing value.
 */
export const OBJECT_GONE = Object.freeze({ studio: "object-gone" });

/**
 * Read one value out of the document by a history key.
 * @param {import("yjs").Doc} doc
 * @param {string} key - e.g. `"clip:abc|notes"`, `"track:abc|*"` or
 *   `"track:abc|device.params.Cutoff"`
 * @returns {any} the value as the document holds it now, `null` when the field
 *   is not there, or `OBJECT_GONE` when the object the key names is not in the
 *   song at all
 * @throws {StudioError} code "invalid" when `key` is not a `"<ref>|<field>"` key
 */
export function readField(doc, key) {
  const split = splitRefField(key);
  if (!split) {
    throw new StudioError("invalid", `"${key}" is not a "<ref>|<field>" history key.`);
  }
  if (split.field !== "*" && readDocField(doc, split.ref, "*") === ABSENT) return OBJECT_GONE;
  return readDocField(doc, split.ref, split.field);
}

/**
 * A value with its position hints removed: `_index` and `_after` say where an
 * object sat when a step was recorded, never what it holds, so an object that
 * moved because something in front of it was removed is not a changed object.
 * @param {any} value
 * @returns {any}
 */
function withoutPositionHints(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const { _index, _after, ...rest } = value;
  return rest;
}

/**
 * One conflict, in the shape the history panel shows it: what the step
 * expected, what the document holds now, and `gone` when the object the key
 * names is not in the song any more.
 * @param {string} key - a `"<ref>|<field>"` history key
 * @param {any} expected
 * @param {any} actual - a document value, or `OBJECT_GONE`
 * @returns {{ref: string, field: string, expected: any, actual: any, gone?: boolean}}
 */
function conflictFor(key, expected, actual) {
  const split = splitRefField(key);
  if (actual === OBJECT_GONE) {
    return {
      ref: split.ref,
      field: split.field,
      expected: cloneJson(expected ?? ABSENT),
      actual: ABSENT,
      gone: true,
    };
  }
  return {
    ref: split.ref,
    field: split.field,
    expected: cloneJson(withoutPositionHints(expected) ?? ABSENT),
    actual: withoutPositionHints(actual),
  };
}

/** @returns {Map<string, any>} a before/after map as a Map, absent values as `null`. */
function fieldMap(map) {
  if (!map) return new Map();
  if (map instanceof Map) return new Map(map);
  return new Map(Object.entries(map));
}

/** @returns {object} a deep copy of a before/after map, absent values as `null`. */
function copyFieldMap(map) {
  const out = {};
  for (const [key, value] of fieldMap(map)) out[key] = cloneJson(value ?? ABSENT);
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
 * The guards a command's `apply` result carries: it hangs them on the `after`
 * map under `STEP_GUARDS` (doc.js), because the registry's before/after
 * contract is `"<ref>|<field>"` keys only.
 * @param {any} after - a command's `after` map
 * @returns {Map<string, any>}
 */
function carriedGuards(after) {
  if (!after || typeof after !== "object") return new Map();
  return fieldMap(after[STEP_GUARDS]);
}

/**
 * Build one history entry — the shape the store persists, with the two maps
 * a later undo compares against.
 * @param {{song_id: string, seq: number, command: string, args?: object|null,
 *          author?: {kind?: string, id?: string, label?: string}|null,
 *          summary?: string, touched?: string[], before?: object|Map<string, any>,
 *          after?: object|Map<string, any>, guards?: object|Map<string, any>,
 *          undo_of?: string|null, undone_by?: string|null, created_at?: string}} spec
 *   `guards` are fields an undo must still find unchanged but never restores;
 *   a command's own guards travel on its `after` map and are picked up here.
 * @returns {{id: string, song_id: string, seq: number, command: string, args: object|null,
 *            author: object|null, summary: string, touched: string[],
 *            inverse: {before: object, after: object, guards?: object},
 *            undo_of: string|null, undone_by: string|null, created_at: string}}
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
  guards = {},
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

  const guardFields = new Map([...carriedGuards(after), ...fieldMap(guards)]);

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
    inverse: {
      before: copyFieldMap(before),
      after: copyFieldMap(after),
      // Left out when there are none, so an ordinary step's entry stays the
      // {before, after} pair the store and the tests already know.
      ...(guardFields.size > 0 ? { guards: copyFieldMap(guardFields) } : {}),
    },
    undo_of: undo_of ?? null,
    undone_by: undone_by ?? null,
    created_at: created_at ?? new Date().toISOString(),
  };
}

/**
 * Plan the selective undo of one step: which fields go back, which can no
 * longer be taken back because someone changed them since, and — when the
 * whole plan turns out to be unsafe — why it is blocked.
 *
 * A field whose current value is exactly what the step wrote is restored to
 * what it held before — a `before` of `null` deletes it again, because that is
 * how "it did not exist" is spelled. A field that has changed since is
 * reported in `conflicts` and left alone, and so is a field whose object is
 * gone (`gone: true`). A `"*"` key compares (and restores) the whole object,
 * and is skipped when another field of the same object is already in conflict —
 * the object is no longer the one the step made. Position hints (`_index`,
 * `_after`) are ignored on both sides: an object moving because a neighbour
 * was removed is not an edit to it.
 *
 * `inverse.guards` are compared the same way but never restored: a guard that
 * has moved on means the object the step wrote to is not the object that is
 * there now, so nothing on that ref is restored either.
 *
 * The plan is then dry-run on a clone of the document (see `dryRun`). If any
 * of it would leave the song invalid, `apply` comes back EMPTY and `blocked`
 * says why — a caller that gets an empty `apply` has nothing to undo and
 * reports the reasons instead.
 *
 * Reads the document; changes nothing. Apply the result with `applyPlan`.
 * @param {import("yjs").Doc} doc
 * @param {object} entry - a history entry, as `makeEntry` returns it
 * @returns {{apply: Map<string, any>,
 *            conflicts: Array<{ref: string, field: string, expected: any, actual: any, gone?: boolean}>,
 *            blocked: string[]}}
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
  const guards = fieldMap(entry.inverse.guards);
  const planned = new Map();
  const conflicts = [];
  const refsInConflict = new Set();
  const guardedRefs = new Set();

  // Guards first: one that has moved on means this ref is not the object the
  // step edited, so its fields are left alone (and the guard is never written).
  for (const [key, expected] of guards) {
    const split = splitRefField(key);
    if (!split) {
      throw new StudioError("invalid", `"${key}" is not a "<ref>|<field>" history key.`);
    }
    const actual = readField(doc, key);
    if (isDeepStrictEqual(withoutPositionHints(actual), withoutPositionHints(expected))) continue;
    conflicts.push(conflictFor(key, expected, actual));
    guardedRefs.add(split.ref);
    refsInConflict.add(split.ref);
  }

  const keys = [...after.keys()];
  for (const key of keys) {
    const split = splitRefField(key);
    if (!split) {
      throw new StudioError("invalid", `"${key}" is not a "<ref>|<field>" history key.`);
    }
    if (split.field === "*" || guardedRefs.has(split.ref)) continue;

    const expected = after.get(key);
    const actual = readField(doc, key);
    if (isDeepStrictEqual(withoutPositionHints(actual), withoutPositionHints(expected))) {
      planned.set(key, cloneJson(before.get(key) ?? ABSENT));
      continue;
    }
    conflicts.push(conflictFor(key, expected, actual));
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
    if (isDeepStrictEqual(withoutPositionHints(actual), withoutPositionHints(expected))) {
      planned.set(key, cloneJson(before.get(key) ?? ABSENT));
      continue;
    }
    conflicts.push(conflictFor(key, expected, actual));
  }

  const apply = orderPlan(planned);
  if (apply.size === 0) return { apply: new Map(), conflicts, blocked: [] };

  const blocked = dryRun(doc, apply);
  if (blocked.length > 0) return { apply: new Map(), conflicts, blocked };
  return { apply, conflicts, blocked: [] };
}

/**
 * Apply a plan to a throwaway copy of the document and report what the song
 * would be left with: whatever `checkInvariants()` says about the clone, or one
 * reason when a write throws.
 *
 * The real document is never touched, which is what lets a GUI offer an undo
 * only when applying it can neither fail nor leave the song inconsistent.
 * @param {import("yjs").Doc} doc
 * @param {Map<string, any>} plan - in restore order, as `applyPlan` takes it
 * @returns {string[]} the block reasons; empty when the plan is safe
 */
function dryRun(doc, plan) {
  const clone = new Y.Doc();
  try {
    Y.applyUpdate(clone, Y.encodeStateAsUpdate(doc));
    applyBeforeAfter(clone, plan);
    return checkInvariants(clone);
  } catch (error) {
    return [`That step could not be applied to this song: ${error?.message ?? "the write was refused"}`];
  } finally {
    clone.destroy();
  }
}

/**
 * Plan a redo: the same comparison as an undo, run against the undo entry
 * itself. An undo entry's `inverse` is already the swap of what it changed
 * (its `after` is what the undo wrote), so redoing is undoing the undo.
 *
 * An undo that has already been redone carries an `undone_by` of its own and is
 * refused: undoing that redo is how a change is taken back out again.
 * @param {import("yjs").Doc} doc
 * @param {object} undoEntry - the `history.undo` entry to take back
 * @returns {{apply: Map<string, any>,
 *            conflicts: Array<{ref: string, field: string, expected: any, actual: any, gone?: boolean}>,
 *            blocked: string[]}}
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
 * Yjs update and one history step. A plan comes from `planUndo`, which has
 * already applied it to a clone, so the only way a write can fail here is a
 * document that changed between the two calls; that is reported as a conflict
 * rather than a raw error.
 * @param {import("yjs").Doc} doc
 * @param {{apply: Map<string, any>}|Map<string, any>|Object<string, any>|null} plan
 * @returns {void}
 * @throws {StudioError} code "conflict" when the document no longer takes the
 *   write
 */
export function applyPlan(doc, plan) {
  const planned = plan?.apply ?? plan;
  if (!planned) return;
  const entries = planned instanceof Map ? [...planned.entries()] : Object.entries(planned);
  if (entries.length === 0) return;
  try {
    applyBeforeAfter(doc, new Map(entries));
  } catch (error) {
    if (error instanceof StudioError) throw error;
    throw new StudioError(
      "conflict",
      `That step could not be applied to this song: ${error?.message ?? "the write was refused"}`,
    );
  }
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
    before[key] = cloneJson(originalAfter.get(key) ?? ABSENT);
    after[key] = cloneJson(value ?? ABSENT);
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