/**
 * api.js — the History API: an item's versions, the difference between two of
 * them, and the write that puts one back.
 *
 * One reader over item_versions (filled by the capture triggers in covered.js)
 * with three jobs:
 *
 *   listVersions    the item's versions, newest first, keyset-paginated by id;
 *   diffVersions    what changed between two versions, field by field;
 *   restoreVersion  put a version's value back — as a NEW version, never by
 *                   rewriting history (review focus 3: restoring does not delete
 *                   what came after, it is appended after it).
 *
 * Three rules this file exists to keep in one place:
 *
 *   NO WRITES TO item_versions. A restore writes the COVERED TABLE (the ordinary
 *   INSERT/UPDATE the app would make) and lets the capture trigger record it, so
 *   the restore IS the new version and the append-only guards stay untouched.
 *   Everything goes through `db.execute` inside `withWriteContext(ctx)`, so the
 *   version it produces is stamped with the restorer like any other write.
 *
 *   THE SNAPSHOT IS THE ROW, MINUS COUNTERS. A restore writes every snapshotted
 *   column — not just the tracked ones — because that is what makes a deleted
 *   memory come back in its project (memories.project_id / project_uuid, a blog
 *   post's published_at, a section's scope keys). What it does NOT touch is
 *   anything outside the snapshot: access_count, accessed_at, created_at /
 *   updated_at, lamport_ts, sort_order. A counter is not content, so a restore
 *   never rewinds one (the operator's ruling; the plan's "an untracked column is
 *   untouched by a restore" is exactly this list).
 *
 *   A RESTORE IS ALWAYS ATTRIBUTED. `ctx` must name a real author kind
 *   (owner | bot | peer | system). A missing one is refused rather than silently
 *   recorded as 'unattributed', because the one write a person explicitly asked
 *   for is the last one that should lose its author.
 *
 * BLOBs: the triggers store a blob as the reversible string 'hex:<UPPERCASE HEX>'
 * (covered.js valueExpr — json_object cannot hold a blob). Reading decodes it
 * back to bytes on the way into a restore, so a restored blob is bytes again.
 * The encoding is its own disambiguation: SQLite's hex() is always uppercase and
 * always whole bytes, so a plain text value that happens to start with "hex:" is
 * left alone unless the rest of it is uppercase byte pairs — the one collision
 * the encoding has, and the reason the pattern is anchored and even-length.
 */
import { COVERED } from "./covered.js";
import { AUTHOR_KINDS, withWriteContext } from "./write-context.js";
import { lineDiff } from "../line-diff.js";

/** Versions per page when the caller does not say. */
export const DEFAULT_LIMIT = 100;

/** The cap a caller cannot raise: a history view is a page, not an export. */
export const MAX_LIMIT = 500;

/** A stored blob: 'hex:' plus an even number of UPPERCASE hex digits. */
const HEX_BLOB_RE = /^hex:(?:[0-9A-F]{2})*$/;

/** An Error with a machine-readable `code`, so a route can map it to a message. */
function historyError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** The covered spec for an item type, or a clear refusal. */
function specFor(itemType) {
  const spec = typeof itemType === "string" ? COVERED[itemType] : null;
  if (!spec) throw historyError("unsupported", `unknown item type ${JSON.stringify(itemType)}`);
  return spec;
}

/** The item id as the TEXT item_versions stores it. */
function normalizeItemId(itemId) {
  if (typeof itemId === "number" && Number.isFinite(itemId)) return String(itemId);
  if (typeof itemId === "string") {
    const trimmed = itemId.trim();
    return trimmed === "" ? null : trimmed;
  }
  return null;
}

/** A version id as an integer, or null when it is not one. */
function normalizeVersionId(versionId) {
  if (typeof versionId !== "number" && typeof versionId !== "string") return null;
  if (typeof versionId === "string" && versionId.trim() === "") return null;
  const n = Number(versionId);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

/** The page size actually used: 1…MAX_LIMIT, the default for anything unusable. */
function normalizeLimit(limit) {
  const n = Math.trunc(Number(limit));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

/** SQL identifier quoting (nothing here is user input, but stay exact). */
const quote = (ident) => `"${String(ident).replace(/"/g, '""')}"`;

/* --------------------------------------------------------------- shapes */

/** A snapshot value as it will be written: 'hex:…' back to bytes, else as-is. */
function decodeValue(value) {
  if (typeof value === "string" && HEX_BLOB_RE.test(value)) return Buffer.from(value.slice(4), "hex");
  return value;
}

/**
 * A comparable form of one value. Two values are "the same" for restore purposes
 * only when they would be written identically: 7 and '7' are not, a NULL and a
 * missing value are, and a blob compares by its bytes.
 */
function canonical(value) {
  if (value === undefined || value === null) return "null";
  if (Buffer.isBuffer(value)) return `blob:${value.toString("hex").toUpperCase()}`;
  if (value instanceof Uint8Array) return `blob:${Buffer.from(value).toString("hex").toUpperCase()}`;
  if (typeof value === "number") return `number:${value}`;
  if (typeof value === "boolean") return `boolean:${value}`;
  return `string:${String(value)}`;
}

/**
 * One item_versions row in the History list shape. `itemType` / `itemId` ride
 * along because diffVersions needs the type to order and type its fields, and
 * `redacted` because a redacted version must be shown as one (Task 4 sets it).
 * The snapshot is the parsed JSON as stored — a hex blob stays a hex string
 * here; only a restore turns it back into bytes.
 */
function toVersion(row) {
  return {
    id: Number(row.id),
    itemType: row.item_type,
    itemId: row.item_id,
    op: row.op,
    authorKind: row.author_kind,
    authorId: row.author_id,
    jobId: row.job_id,
    originInstance: row.origin_instance,
    redacted: Number(row.redacted) === 1,
    createdAt: row.created_at,
    snapshot: JSON.parse(row.snapshot_json),
  };
}

const VERSION_COLUMNS = `id, item_type, item_id, op, snapshot_json,
       author_kind, author_id, job_id, origin_instance, redacted, created_at`;

/* ---------------------------------------------------------- listVersions */

/**
 * One item's versions, newest first.
 *
 * Keyset pagination, not OFFSET: `before` is the id of the oldest version the
 * caller already has, and the next page is `id < before`. History is append-only,
 * so an id cursor never skips or repeats a row the way an offset would when a new
 * version lands between two page requests.
 *
 * `item_type` is part of every predicate: item ids are per table (memories and
 * crow_context both have id 3), so a query on item_id alone would mix two items'
 * histories together.
 */
export async function listVersions(db, { itemType, itemId, limit = DEFAULT_LIMIT, before = null } = {}) {
  specFor(itemType);
  const id = normalizeItemId(itemId);
  if (id === null) throw historyError("invalid_request", "listVersions needs an itemId");

  const args = [itemType, id];
  let sql = `SELECT ${VERSION_COLUMNS} FROM item_versions WHERE item_type = ? AND item_id = ?`;
  if (before !== null && before !== undefined) {
    const cursor = normalizeVersionId(before);
    if (cursor === null) throw historyError("invalid_request", "before must be a version id");
    sql += " AND id < ?";
    args.push(cursor);
  }
  sql += " ORDER BY id DESC LIMIT ?";
  args.push(normalizeLimit(limit));

  const { rows } = await db.execute({ sql, args });
  return rows.map(toVersion);
}

/* ---------------------------------------------------------- diffVersions */

/** Is this snapshot value ordinary text (not a stored blob)? */
const isTextValue = (v) => typeof v === "string" && !HEX_BLOB_RE.test(v);

/**
 * A field is shown as a line diff when both sides are text-or-empty: a string on
 * at least one side and nothing but a string or NULL on the other. Everything
 * else — numbers, toggles, NULL→number, a blob — is a before/after value, where
 * a whole-value change is the honest rendering (an importance of 5 becoming 8 is
 * not a line edit).
 */
function diffKind(before, after) {
  const ok = (v) => v === null || v === undefined || isTextValue(v);
  return ok(before) && ok(after) && (isTextValue(before) || isTextValue(after)) ? "text" : "value";
}

/** The spec for a pair of versions: their item type's, or one built from their keys. */
function specForPair(a, b) {
  for (const v of [a, b]) {
    if (isObject(v) && typeof v.itemType === "string" && COVERED[v.itemType]) return COVERED[v.itemType];
  }
  const keys = [];
  for (const v of [a, b]) {
    const snapshot = isObject(v) && isObject(v.snapshot) ? v.snapshot : {};
    for (const key of Object.keys(snapshot)) if (!keys.includes(key)) keys.push(key);
  }
  return { tracked: [], snapshot: keys };
}

/**
 * What changed between two versions: tracked fields first (the order the edit
 * form shows them in), then the rest of the snapshot, and only fields that
 * actually differ.
 *
 * Text fields carry a line diff from servers/shared/line-diff.js — a plain LCS
 * table, deterministic and dependency-free — as `lines` (with `op` " ", "-" or
 * "+"), plus `added` / `removed` counts. Non-text fields carry the two values.
 * Every entry keeps `field`, `before` and `after`, so a caller that only needs
 * to know WHAT changed does not have to care which kind it is.
 *
 * Pure and synchronous: no database, no clock, no randomness.
 */
export function diffVersions(a, b) {
  if (!isObject(a) || !isObject(b)) throw historyError("invalid_request", "diffVersions needs two versions");
  const spec = specForPair(a, b);
  const snapshotOf = (v) => (isObject(v.snapshot) ? v.snapshot : {});

  // Tracked first, then the remaining snapshot columns, then anything either
  // snapshot carries that the type's list does not name (a newer column, or a
  // hand-built snapshot).
  const fields = [...spec.tracked, ...spec.snapshot.filter((c) => !spec.tracked.includes(c))];
  for (const v of [a, b]) {
    for (const key of Object.keys(snapshotOf(v))) if (!fields.includes(key)) fields.push(key);
  }

  const out = [];
  for (const field of fields) {
    const before = snapshotOf(a)[field] ?? null;
    const after = snapshotOf(b)[field] ?? null;
    if (canonical(before) === canonical(after)) continue;

    if (diffKind(before, after) === "text") {
      const lines = lineDiff(typeof before === "string" ? before : "", typeof after === "string" ? after : "");
      out.push({
        field,
        kind: "text",
        before,
        after,
        lines: lines.lines,
        added: lines.added,
        removed: lines.removed,
        capped: lines.capped,
      });
    } else {
      out.push({ field, kind: "value", before, after });
    }
  }
  return out;
}

/* ------------------------------------------------------- restoreVersion */

/** The version row, or null. */
async function readVersion(db, versionId) {
  const { rows } = await db.execute({
    sql: `SELECT ${VERSION_COLUMNS} FROM item_versions WHERE id = ?`,
    args: [versionId],
  });
  return rows[0] ?? null;
}

/** The live row's snapshotted columns, or null when the row is gone. */
async function readRow(db, spec, itemId) {
  const columns = [spec.idColumn, ...spec.snapshot];
  const { rows } = await db.execute({
    sql: `SELECT ${columns.map(quote).join(", ")} FROM ${quote(spec.table)} WHERE ${quote(spec.idColumn)} = ?`,
    args: [itemId],
  });
  return rows[0] ?? null;
}

/** The newest version id in the table — the watermark a restore's write crosses. */
async function maxVersionId(db) {
  const { rows } = await db.execute({ sql: "SELECT COALESCE(MAX(id), 0) AS id FROM item_versions", args: [] });
  return Number(rows[0]?.id ?? 0);
}

/** The item's newest version id, when it is newer than `watermark`; else null. */
async function versionIdAfter(db, watermark, itemType, itemId) {
  const { rows } = await db.execute({
    sql: "SELECT MAX(id) AS id FROM item_versions WHERE item_type = ? AND item_id = ?",
    args: [itemType, itemId],
  });
  const id = rows[0]?.id === null || rows[0]?.id === undefined ? 0 : Number(rows[0].id);
  return id > watermark ? id : null;
}

/**
 * Put one version's value back.
 *
 * The write is the ordinary INSERT / UPDATE on the covered table (inside
 * `withWriteContext(ctx)`), so the capture trigger records the restore as a new
 * version — stamped with the restorer — and every later version stays in the
 * list (review focus 3). item_versions is never written to directly.
 *
 * A REDACTED version is refused (code 'redacted'). Task 4's sweep replaces text
 * matching the public-hygiene secret patterns with "[redacted]" and sets
 * redacted = 1; such a version no longer holds the item's value, so writing it
 * back would paste the placeholder into live content and lose what is there. The
 * honest answer is "pick another version". Task 4 owns the wording a caller
 * shows for it (and what its Trash restore does when a delete version was
 * redacted).
 *
 * Four paths:
 *
 *   the row is live and differs     UPDATE the snapshotted columns that differ.
 *                                   The id is never in SET: an item's key is not
 *                                   content, and rewriting it would move the row
 *                                   rather than restore it.
 *   the row is live and identical   nothing is written. `{ newVersionId: null,
 *                                   unchanged: true }` — a restore of what is
 *                                   already there is not an edit.
 *   the row is gone                 INSERT with the SAME id, so the item comes
 *                                   back as itself: its id, and the project the
 *                                   snapshot names. A new id would make a restored
 *                                   memory a different memory to every link,
 *                                   card and sync peer that held the old one. The
 *                                   usual way here is a `delete` version.
 *   the row is gone, id reused      a `delete` version whose id a row now
 *                                   occupies was not "restored" — the id belongs
 *                                   to something created since. Refused with
 *                                   code 'conflict' rather than overwriting it.
 *
 * `unchanged` is about the SNAPSHOT, not about the tracked subset: restoring a
 * version differing only in an untracked-but-snapshotted column (a memory's
 * instance_id placement pointer) does write — and writes no version, because the
 * trigger is about content — so that call returns `{ newVersionId: null,
 * unchanged: false }`. A caller that needs a version id should treat null as
 * "nothing was recorded".
 *
 * @returns {Promise<{newVersionId: number|null, unchanged: boolean}>}
 */
export async function restoreVersion(db, { versionId } = {}, ctx) {
  if (!isObject(ctx) || !AUTHOR_KINDS.includes(ctx.authorKind)) {
    throw historyError(
      "invalid_context",
      "a restore must name who is restoring it (authorKind owner, bot, peer or system)",
    );
  }
  const id = normalizeVersionId(versionId);
  if (id === null) throw historyError("invalid_request", "restoreVersion needs a version id");

  const version = await readVersion(db, id);
  if (!version) throw historyError("not_found", `no version ${id}`);
  if (Number(version.redacted) === 1) {
    throw historyError(
      "redacted",
      `version ${id} was redacted and no longer holds the item's value; restore a different version`,
    );
  }
  const spec = specFor(version.item_type);
  const itemId = normalizeItemId(version.item_id);
  if (itemId === null) throw historyError("invalid_request", `version ${id} has no item id`);

  const snapshot = JSON.parse(version.snapshot_json);
  // Only the columns this snapshot actually carries: a version written from an
  // older field list must not blank the columns it never knew about.
  const columns = spec.snapshot.filter(
    (column) => column !== spec.idColumn && Object.prototype.hasOwnProperty.call(snapshot, column),
  );
  const values = columns.map((column) => decodeValue(snapshot[column]));
  const row = await readRow(db, spec, itemId);

  /** The one place a restore writes: through the client, inside the context. */
  const write = async (sql, args) => {
    const watermark = await maxVersionId(db);
    try {
      await withWriteContext(ctx, () => db.execute({ sql, args }));
    } catch (err) {
      // A UNIQUE / NOT NULL / CHECK refusal is the table telling us the row this
      // snapshot describes cannot exist beside what is there now (a slug taken
      // by another post, a missing required column in a hand-built snapshot).
      if (/SQLITE_CONSTRAINT|UNIQUE constraint|NOT NULL constraint|CHECK constraint/i.test(err.message)) {
        throw historyError(
          "conflict",
          `${spec.table}/${itemId} cannot take version ${id} back: ${err.message}`,
        );
      }
      throw err;
    }
    return versionIdAfter(db, watermark, version.item_type, itemId);
  };

  if (row) {
    // A delete version's id being live again means the id was re-created since
    // the delete: not a restore, a collision between two different items.
    if (version.op === "delete") {
      throw historyError(
        "conflict",
        `${spec.table}/${itemId} exists again, so version ${id} (a deletion) cannot be restored over it`,
      );
    }
    const changed = columns.filter((_, i) => canonical(row[columns[i]]) !== canonical(values[i]));
    if (changed.length === 0) return { newVersionId: null, unchanged: true };

    const sql =
      `UPDATE ${quote(spec.table)} SET ${changed.map((c) => `${quote(c)} = ?`).join(", ")} ` +
      `WHERE ${quote(spec.idColumn)} = ?`;
    const args = [...changed.map((column) => decodeValue(snapshot[column])), itemId];
    const newVersionId = await write(sql, args);
    return { newVersionId, unchanged: false };
  }

  // The row is gone: put it back as itself, id and filing included.
  const insertColumns = [spec.idColumn, ...columns];
  const sql =
    `INSERT INTO ${quote(spec.table)} (${insertColumns.map(quote).join(", ")}) ` +
    `VALUES (${insertColumns.map(() => "?").join(", ")})`;
  const newVersionId = await write(sql, [itemId, ...values]);
  return { newVersionId, unchanged: false };
}