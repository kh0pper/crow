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
 *   The write runs inside `withWriteContext(ctx)` and through the gateway
 *   client's `runTransaction`, so the version it produces is stamped with the
 *   restorer like any other write.
 *
 *   A RESTORE IS ONE SYNCHRONOUS TRANSACTION. Its read → compare → write →
 *   version-id all happen inside one `db.runTransaction` callback
 *   (servers/db.js), i.e. one `db.transaction(...).immediate()` on the
 *   underlying handle — the same mechanism `batch()` gives an erase
 *   (erase.js). Nothing may await between the row a restore compares against and
 *   the row it writes: an `await db.execute(...)` there would let an unrelated
 *   caller's statement on the SAME shared connection join the open transaction,
 *   and it would then commit — or roll back — with the restore. So the helpers
 *   below take a synchronous `run` and never the client. The sync emit is
 *   deliberately OUTSIDE that transaction (see emitRestored): a sync problem must
 *   never undo, or hide, a restore the operator asked for.
 *
 *   A RESTORE IS A NORMAL WRITE, SYNC INCLUDED. It used to stop at the local row,
 *   which made a restore the one edit a paired instance never heard about: the
 *   peer's next write carried the pre-restore value and won last-write-wins, and
 *   an un-delete never crossed at all. So a restore now emits through the same
 *   door an ordinary write uses (`emitOrQueue` from servers/shared/sync-emit.js,
 *   exactly as servers/memory/memory-write.js does for a memory and
 *   servers/memory/server.js does for a context section), which also MINTS the
 *   fresh lamport_ts the row needs to out-rank the peer's stale copy — `insert`
 *   for an un-delete, `update` otherwise. blog_posts is deliberately not one of
 *   them: it is not in instance-sync's SYNCED_TABLES, so a blog post restore is
 *   a plain local write and the result says `synced: false`. With no emitter
 *   (a test, a host with sync off) the write still happens and `synced` is false.
 *
 *   THE FILING IS RESOLVED, NOT REPLAYED. project_spaces.id is a per-instance id
 *   and REUSED after a project is deleted, so a snapshot's project_id can name a
 *   different project today. A snapshot with a project_uuid is filed by uuid
 *   (uuid → current local id); a uuid whose project is gone files the item
 *   UNFILED (both keys NULL, `unfiled: true`) instead of into a stranger's
 *   project. Without a uuid the local id is kept only while it still exists and
 *   does not contradict the live row's uuid — see resolveFiling(). A context
 *   section adds one more rule: its snapshot carries the project's uuid (a
 *   derived field, covered.js), so a section version WITHOUT one predates that
 *   and is restored unfiled rather than trusted by a bare local id
 *   (spec.filingRequiresUuid).
 *
 *   THE SNAPSHOT IS THE ROW, MINUS COUNTERS. A restore writes every snapshotted
 *   column — not just the tracked ones — because that is what makes a deleted
 *   memory come back in its project (memories.project_id / project_uuid, a blog
 *   post's published_at, a section's scope keys). What it does NOT touch is
 *   anything outside the snapshot: access_count, accessed_at, created_at /
 *   updated_at, lamport_ts, sort_order. A counter is not content, so a restore
 *   never rewinds one (the operator's ruling; the plan's "an untracked column is
 *   untouched by a restore" is exactly this list). One snapshotted column is
 *   neither content nor counter — a memory's instance_id placement pointer — and
 *   it is kept as it is too (see KEEP_CURRENT).
 *
 *   A RESTORE IS ALWAYS ATTRIBUTED. `ctx` must name a real author kind
 *   (owner | bot | peer | system). A missing one is refused rather than silently
 *   recorded as 'unattributed', because the one write a person explicitly asked
 *   for is the last one that should lose its author.
 *
 * BLOBs: the triggers store a blob as the reversible string 'hex:<UPPERCASE HEX>'
 * (covered.js valueExpr — json_object cannot hold a blob). Reading decodes it
 * back to bytes on the way into a restore, so a restored blob is bytes again.
 *
 * TEXT IS ESCAPED OUT OF THE BLOB MARKER'S WAY, BOTH WAYS. A text value can
 * start with "hex:" ("hex:DEADBEEF" is a hex-looking string, not necessarily
 * bytes) or with "txt:" (the escape itself), so valueExpr prefixes a TEXT value
 * starting with EITHER marker with one more 'txt:', and decodeValue below strips
 * exactly one. `hex:` therefore means bytes and `txt:` means text, unambiguously
 * for every row written since the escape. ROWS WRITTEN BEFORE IT CARRY NO MARKER
 * and cannot be told apart: a pre-escape snapshot holding "hex:DEADBEEF" is read
 * back as the blob [0xDE 0xAD 0xBE 0xEF]. That ambiguity is accepted (there is no
 * information left to resolve it with) and only affects rows stored before this
 * change.
 *
 * A DERIVED SNAPSHOT FIELD IS READ, NEVER WRITTEN. crow_context's project_uuid
 * is computed from project_spaces when the version is written (covered.js
 * `derived`), not a column of crow_context: it decides the FILING of a restored
 * section and is never part of the INSERT/UPDATE into the table itself.
 */
import { COVERED, tableColumns } from "./covered.js";
import { erasureKeys, findEraseRefusalSync } from "./erase.js";
import { AUTHOR_KINDS, withWriteContext } from "./write-context.js";
import { lineDiff } from "../line-diff.js";

/** Versions per page when the caller does not say. */
export const DEFAULT_LIMIT = 100;

/** The cap a caller cannot raise: a history view is a page, not an export. */
export const MAX_LIMIT = 500;

/** A stored blob: 'hex:' plus an even number of UPPERCASE hex digits. */
const HEX_BLOB_RE = /^hex:(?:[0-9A-F]{2})*$/;

/** The escape for a TEXT value that would otherwise look like a stored blob. */
const TEXT_ESCAPE = "txt:";

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

/**
 * A snapshot value as it will be written: one leading 'txt:' back to text,
 * 'hex:…' back to bytes, anything else as-is. Both markers are self-describing
 * and reversible — valueExpr adds exactly one 'txt:' to a text value starting
 * with either marker, and this strips exactly one — so the only value that cannot
 * be recovered is one stored before the 'txt:' escape existed (see the BLOBs note
 * at the top of this file).
 */
function decodeValue(value) {
  if (typeof value !== "string") return value;
  if (value.startsWith(TEXT_ESCAPE)) return value.slice(TEXT_ESCAPE.length);
  if (HEX_BLOB_RE.test(value)) return Buffer.from(value.slice(4), "hex");
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

/* ---------------------------------------------------------- historySize */

/**
 * How big the version store is: the row count and an approximate byte size
 * (SUM(LENGTH(snapshot_json))). The settings section's size line is the whole
 * caller — a small machine needs to see the number rather than discover it when
 * the disk fills (the version history design §6).
 *
 * APPROXIMATE, and it says so: LENGTH counts characters for a text column, so a
 * snapshot of multi-byte text takes more bytes on disk than this adds up. It is
 * the right order of magnitude, which is what the line is for.
 *
 * A store that has not run the history migration has no table: zeros, never a
 * throw, so a settings page can never fail because history is not set up.
 *
 * @returns {Promise<{versions: number, bytes: number}>}
 */
export async function historySize(db) {
  try {
    const { rows } = await db.execute({
      sql: "SELECT COUNT(*) AS versions, COALESCE(SUM(LENGTH(snapshot_json)), 0) AS bytes FROM item_versions",
      args: [],
    });
    return { versions: Number(rows[0]?.versions) || 0, bytes: Number(rows[0]?.bytes) || 0 };
  } catch {
    return { versions: 0, bytes: 0 };
  }
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

/**
 * The synchronous statement runner a restore works through.
 *
 * Every read, comparison and write of a restore goes through this — `run` comes
 * from `db.runTransaction` (servers/db.js) and executes IMMEDIATELY on the
 * underlying handle, inside the one transaction the whole restore is. Deliberately
 * not `db.execute`: awaiting a statement between the read and the write would let
 * another caller's statement on the same shared connection join the transaction.
 *
 * @typedef {(statement: {sql: string, args?: any[]}) =>
 *   {rows: object[], columns: string[], rowsAffected: number, lastInsertRowid: number}} RunStatement
 */

/** The version row, or null. */
function readVersion(run, versionId) {
  const { rows } = run({ sql: `SELECT ${VERSION_COLUMNS} FROM item_versions WHERE id = ?`, args: [versionId] });
  return rows[0] ?? null;
}

/**
 * The live row's own columns (every snapshotted one the TABLE actually has — a
 * derived field is computed, not stored), or null when the row is gone.
 */
function readRow(run, spec, itemId) {
  const columns = tableColumns(spec);
  const { rows } = run({
    sql: `SELECT ${columns.map(quote).join(", ")} FROM ${quote(spec.table)} WHERE ${quote(spec.idColumn)} = ?`,
    args: [itemId],
  });
  return rows[0] ?? null;
}

/** The newest version id in the table — the watermark a restore's write crosses. */
function maxVersionId(run) {
  const { rows } = run({ sql: "SELECT COALESCE(MAX(id), 0) AS id FROM item_versions", args: [] });
  return Number(rows[0]?.id ?? 0);
}

/** The id of the newest `delete` version of this item newer than `versionId`, or null. */
function deleteVersionAfter(run, itemType, itemId, versionId) {
  const { rows } = run({
    sql: `SELECT MAX(id) AS id FROM item_versions
           WHERE item_type = ? AND item_id = ? AND op = 'delete' AND id > ?`,
    args: [itemType, itemId, versionId],
  });
  const id = rows[0]?.id;
  return id === null || id === undefined ? null : Number(id);
}

/* ------------------------------------------------------------- the filing */

/** A non-empty string, or null (an empty project_uuid is no uuid at all). */
const nonEmpty = (v) => (typeof v === "string" && v.trim() !== "" ? v : null);

/** One project_spaces row as {id, uuid}, by uuid or by local id; null when absent. */
function findProject(run, { uuid = null, id = null } = {}) {
  const byUuid = uuid !== null;
  const value = byUuid ? uuid : id;
  if (value === null || value === undefined) return null;
  const { rows } = run({
    sql: `SELECT id, uuid FROM project_spaces WHERE ${byUuid ? "uuid" : "id"} = ?`,
    args: [value],
  });
  return rows[0] ? { id: Number(rows[0].id), uuid: rows[0].uuid ?? null } : null;
}

/**
 * The filing a snapshot can actually have on THIS instance, now.
 *
 * project_spaces.id is a per-instance integer and it is REUSED: delete a project
 * and the next one created takes the id. So a version's project_id is not a fact
 * about today's project table, and writing it back verbatim can file an item into
 * a stranger's project. Four cases, in the order they are decided:
 *
 *   the snapshot names a project_uuid   the UUID is the portable key, so it wins:
 *                                       it resolves to whatever local id that
 *                                       project has NOW (which may differ from the
 *                                       snapshot's project_id), and if the uuid is
 *                                       gone its project was deleted — the item is
 *                                       written UNFILED rather than into whoever
 *                                       holds the old id.
 *   no project at all in the snapshot   unfiled, and nothing was lost (unfiled is
 *                                       false: there was no filing to lose).
 *   no uuid, and the type REQUIRES one  unfiled, `unfiled: true`. crow_context is
 *                                       that type: project_uuid is a derived
 *                                       snapshot field written WITH the triggers,
 *                                       so a version without one predates them and
 *                                       holds only a per-instance id — the one
 *                                       thing that cannot be trusted. Filing it
 *                                       into whoever holds that id now is exactly
 *                                       the corruption this function prevents.
 *   no uuid, id still exists           keep it — unless the LIVE row already names
 *                                       a different project by uuid, which is proof
 *                                       that this id no longer means this item's
 *                                       project (a memory whose uuid arrived later
 *                                       than the version being restored).
 *   no uuid, id gone                   unfiled: project_id NULL (and project_uuid
 *                                       NULL where the snapshot carries one).
 *
 * `unfiled: true` is reported for the caller to show: an item that came back but
 * could not come back to its project is not a failure, and it is not a silent
 * success either. Only the types with a project filing have one — blog posts
 * belong to the instance, not a project.
 *
 * @returns {{project_id: number|null|undefined, project_uuid: string|null|undefined,
 *   unfiled: boolean}} `undefined` for a column the snapshot does not carry: it is
 *   then not written at all, and a version predating the column stays that way.
 */
function resolveFiling(run, spec, snapshot, live) {
  const out = { project_id: undefined, project_uuid: undefined, unfiled: false };
  if (!spec.projectRef.includes("project_id")) return out;
  if (!Object.prototype.hasOwnProperty.call(snapshot, "project_id")) return out;

  const uuid = nonEmpty(snapshot.project_uuid);
  if (uuid !== null) {
    const project = findProject(run, { uuid });
    if (project) {
      out.project_id = project.id;
      out.project_uuid = uuid;
      return out;
    }
    out.project_id = null;
    out.project_uuid = null;
    out.unfiled = true;
    return out;
  }

  const wanted = snapshot.project_id ?? null;
  if (wanted === null) {
    out.project_id = null;
    return out;
  }
  // A type whose snapshot is only portable cannot be filed by a local id: see
  // spec.filingRequiresUuid and the note above.
  if (spec.filingRequiresUuid) {
    out.project_id = null;
    out.project_uuid = null;
    out.unfiled = true;
    return out;
  }
  const project = findProject(run, { id: wanted });
  if (!project) {
    out.project_id = null;
    out.project_uuid = null;
    out.unfiled = true;
    return out;
  }
  // The live row's portable key disproves the local id: this memory says it is in
  // project <liveUuid>, and the project at `wanted` is not that project.
  const liveUuid = live ? nonEmpty(live.project_uuid) : null;
  if (liveUuid !== null && project.uuid !== liveUuid) {
    out.project_id = null;
    out.project_uuid = null;
    out.unfiled = true;
    return out;
  }
  out.project_id = project.id;
  return out;
}

/* ------------------------------------------------------------ the sync emit */

/**
 * Snapshotted columns a restore does NOT write back, per table.
 *
 * memories.instance_id is a PLACEMENT pointer — which of the owner's machines
 * the memory was written on. It is in the snapshot (an erase and the reader both
 * want the whole row) but it is not content, so restoring an old value of the
 * memory must not drag the row's placement back to a machine it has since moved
 * off. Its CURRENT value is kept, which also means a version differing only in
 * instance_id is an unchanged restore (and writes no version: the trigger watches
 * content).
 */
const KEEP_CURRENT = Object.freeze({
  memories: Object.freeze(["instance_id"]),
});

/**
 * The wire row for a restored memory: { id } plus the snapshotted columns the row
 * actually has — the same shape servers/memory/memory-write.js emits for an
 * ordinary insert/update. OUTBOUND_TRANSFORMS in instance-sync.js strips
 * project_id and a null project_uuid on the way out, so this row is filed on a
 * peer by its portable key, exactly as a normal memory write is.
 */
function memoryWireRow(row) {
  const out = { id: Number(row.id) };
  for (const column of COVERED.memory.snapshot) {
    if (Object.prototype.hasOwnProperty.call(row, column)) out[column] = row[column];
  }
  return out;
}

/**
 * Broadcast a restore, through the same door every ordinary write uses.
 *
 * The emit is best effort and runs AFTER the restore is committed: a sync failure
 * must never undo (or hide) a restore the operator asked for, and `emitOrQueue`
 * never throws anyway. Returns whether the row actually left this instance.
 *
 * A blog post is NOT synced (instance-sync's SYNCED_TABLES has no blog_posts), so
 * a plain local write is the whole story there and nothing is emitted.
 *
 * @returns {Promise<boolean>}
 */
async function emitRestored(db, syncManager, { spec, itemType, op, row }) {
  try {
    let wireRow;
    if (itemType === "memory") {
      wireRow = memoryWireRow(row);
    } else if (itemType === "context_section") {
      // Exactly what servers/memory/server.js does after an ordinary section
      // write: re-select the committed row (the wire row needs sort_order, which
      // is not part of the snapshot), build the allowlisted wire row and carry the
      // project's UUID (the local project id stays behind for the Lamport stamp to
      // find the row by).
      const { rows } = await db.execute({
        sql: `SELECT * FROM ${quote(spec.table)} WHERE ${quote(spec.idColumn)} = ?`,
        args: [row[spec.idColumn]],
      });
      if (!rows[0]) return false;
      const { buildCrowContextWireRow, crowContextProjectUuid } = await import(
        "../../sharing/instance-sync.js"
      );
      const uuid = await crowContextProjectUuid(db, rows[0].project_id ?? null);
      wireRow = buildCrowContextWireRow(rows[0], uuid);
    } else {
      return false;
    }
    const { emitOrQueue } = await import("../sync-emit.js");
    const emitted = await emitOrQueue(syncManager, db, spec.table, op, wireRow);
    return emitted !== null && emitted !== undefined;
  } catch (err) {
    console.warn(`[history] the restore of ${spec.table} could not be sent to peers:`, err?.message ?? err);
    return false;
  }
}

/* ------------------------------------------------------- the transaction */

/** The codes this module raises itself, so a mapped SQLite error cannot masquerade as one. */
const OWN_CODES = new Set([
  "erased",
  "invalid_context",
  "invalid_request",
  "not_found",
  "redacted",
  "conflict",
  "unsupported",
]);

/**
 * Run a restore's read → compare → write → version-id as ONE synchronous
 * transaction on the underlying handle.
 *
 * `db.runTransaction` (servers/db.js) runs the callback inside a single
 * `db.transaction(...).immediate()` — the same mechanism `batch()` gives an erase
 * (erase.js) — and hands it a synchronous statement runner. That is the contract
 * this module needs and the reason it does not use `db.execute`: a handle is ONE
 * connection, so a statement issued by another caller while a transaction is open
 * joins it rather than waiting, and anything awaited in the middle would let that
 * caller's write commit or roll back with the restore.
 *
 * A client without it refuses rather than falling back to a transaction spread
 * across awaits, which would look right and be wrong.
 */
function runOneTransaction(db, work) {
  if (!db || typeof db.runTransaction !== "function") {
    throw historyError(
      "unavailable",
      "this database client cannot run a restore as one transaction (it has no runTransaction)",
    );
  }
  return db.runTransaction(work);
}

/**
 * A UNIQUE / NOT NULL / CHECK refusal is the table telling us the row this
 * snapshot describes cannot exist beside what is there now (a slug taken by
 * another post, a section key taken at the same scope, a missing required column
 * in a hand-built snapshot). Reported as `conflict`, not as a raw SQL error.
 */
function asHistoryError(err) {
  if (err && OWN_CODES.has(err.code)) return err;
  if (/SQLITE_CONSTRAINT|UNIQUE constraint|NOT NULL constraint|CHECK constraint/i.test(String(err?.message))) {
    return historyError("conflict", err.message);
  }
  return err;
}

/** The item's newest version id, when it is newer than `watermark`; else null. */
function versionIdAfter(run, watermark, itemType, itemId) {
  const { rows } = run({
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
 * AN ERASED item is refused too (code 'erased', the operator's ruling of
 * 2026-11-10). An erase leaves a permanent tombstone in item_erasures — in the
 * same transaction that removed the versions — and a restore must not undo it:
 * that row exists precisely so an item the owner erased cannot come back, here
 * or (via sync) anywhere else. Normally an erased item has no versions left to
 * restore, but a version can outlive it (a filtered page, a stale reader, a
 * redaction pass) and "not found" would be the wrong answer for what was
 * deliberately forgotten.
 *
 * The refusal is VERSIONED: it applies to a version created at or before the
 * tombstone's `erased_at`, i.e. to the erased item's own values. A version
 * written after the erase is a new life of that id or name (the operator's
 * "a genuinely new item that reuses a name later is accepted") and the tombstone
 * has nothing to say about it.
 *
 * Four paths:
 *
 *   the row is live and differs     UPDATE the snapshotted columns that differ.
 *                                   The id is never in SET: an item's key is not
 *                                   content, and rewriting it would move the row
 *                                   rather than restore it. Nor is a memory's
 *                                   instance_id (a placement pointer, see
 *                                   KEEP_CURRENT): the row stays where it is now.
 *   the row is live and identical   nothing is written. `{ newVersionId: null,
 *                                   unchanged: true, synced: false }` — a restore
 *                                   of what is already there is not an edit.
 *   the row is gone                 INSERT with the SAME id, so the item comes
 *                                   back as itself: its id, and the project the
 *                                   snapshot names (resolved to a project that
 *                                   still exists — see resolveFiling). A new id
 *                                   would make a restored memory a different
 *                                   memory to every link, card and sync peer that
 *                                   held the old one. The usual way here is a
 *                                   `delete` version.
 *   the row is gone, id reused      a `delete` version whose id a row now
 *                                   occupies was not "restored" — the id belongs
 *                                   to something created since. Refused with
 *                                   code 'conflict' rather than overwriting it.
 *                                   The same goes for a live row whose CURRENT life
 *                                   began after the version being restored (a
 *                                   `delete` version newer than it): that row is a
 *                                   different item wearing the same id.
 *
 * `unchanged` is about the SNAPSHOT, not about the tracked subset: restoring a
 * version differing only in an untracked-but-snapshotted column (a blog post's
 * published_at) does write — and writes no version, because the trigger is about
 * content — so that call returns `{ newVersionId: null, unchanged: false }`. A
 * caller that needs a version id should treat null as "nothing was recorded".
 *
 * `synced` says whether the restore actually reached the sync layer (emitted to a
 * live manager, or durably queued): false for a test host, a host with sync off, a
 * blog post (not a synced table) and for a no-op. `unfiled` says the item came
 * back without its project filing: its project is gone, its id now names a
 * different project, or (a context section) the version predates the portable id.
 * A restore that succeeds partially is reported, never hidden.
 *
 * @param {object} db
 * @param {{versionId: number|string, syncManager?: object|null}} options
 * @param {{authorKind: string, authorId?: string, jobId?: string}} ctx who is restoring
 * @returns {Promise<{newVersionId: number|null, unchanged: boolean, synced: boolean,
 *   unfiled: boolean}>}
 */
export async function restoreVersion(db, { versionId, syncManager = null } = {}, ctx) {
  if (!isObject(ctx) || !AUTHOR_KINDS.includes(ctx.authorKind)) {
    throw historyError(
      "invalid_context",
      "a restore must name who is restoring it (authorKind owner, bot, peer or system)",
    );
  }
  const id = normalizeVersionId(versionId);
  if (id === null) throw historyError("invalid_request", "restoreVersion needs a version id");

  // ONE synchronous transaction for read → compare → write → the new version id,
  // with the writer's context open so servers/db.js stamps the version the
  // trigger writes. Nothing in here may await: an await would hand the open
  // transaction to any other caller writing through this same client.
  const outcome = await withWriteContext(ctx, () =>
    runOneTransaction(db, (run) => {
      const version = readVersion(run, id);
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
      // An ERASED item is never restored (the tombstone is the operator's ruling
      // that it is gone for good) — but only while the version being restored is
      // the ERASED item's: a version created at or before `erased_at` is, and a
      // version written after the erase belongs to a new life of that id/name and
      // the tombstone has nothing to say about it (a genuinely new item that
      // reuses an id later must be restorable). Checked BEFORE anything is
      // written, and both key shapes: the section scope this snapshot describes,
      // and the row id the tombstone may have been recorded under.
      const erasedTombstone = findEraseRefusalSync(
        run,
        version.item_type,
        erasureKeys(version.item_type, { itemId, snapshot }),
        version.created_at,
      );
      if (erasedTombstone !== null) {
        throw historyError(
          "erased",
          `${version.item_type}/${itemId} was erased and cannot be restored`,
        );
      }
      // Only the columns this snapshot actually carries, and only the ones the
      // TABLE has: a version written from an older field list must not blank the
      // columns it never knew about, and a DERIVED field (a section's
      // project_uuid) is a filing, not a column to write.
      const columns = tableColumns(spec).filter(
        (column) => column !== spec.idColumn && Object.prototype.hasOwnProperty.call(snapshot, column),
      );
      const values = columns.map((column) => decodeValue(snapshot[column]));
      const row = readRow(run, spec, itemId);

      // The filing is resolved against today's project table, never replayed: a
      // project's integer id can belong to a different project by now.
      const filing = resolveFiling(run, spec, snapshot, row);
      const setValue = (column, value) => {
        const at = columns.indexOf(column);
        if (at >= 0 && value !== undefined) values[at] = value;
      };
      setValue("project_id", filing.project_id);
      setValue("project_uuid", filing.project_uuid);

      // What the caller is told, once the transaction commits.
      const report = (result) => ({ ...result, unfiled: filing.unfiled, spec, itemType: version.item_type, itemId });

      if (row) {
        // A delete version's id being live again means the id was re-created since
        // the delete: not a restore, a collision between two different items.
        if (version.op === "delete") {
          throw historyError(
            "conflict",
            `${spec.table}/${itemId} exists again, so version ${id} (a deletion) cannot be restored over it`,
          );
        }
        // A delete NEWER than the version being restored says the same thing from
        // the other side: the live row was created after that deletion, so its
        // current life is not the life this version belongs to. (The conservative
        // consequence: once an item has been deleted, a version from before that
        // deletion is refused even if the item was later restored — the version
        // table cannot tell an un-delete from a stranger's re-create. Restore the
        // `delete` version itself, or a version from after the un-delete.)
        const laterDelete = deleteVersionAfter(run, version.item_type, itemId, id);
        if (laterDelete !== null) {
          throw historyError(
            "conflict",
            `${spec.table}/${itemId} was deleted again (version ${laterDelete}) after version ${id}: ` +
              `the row that exists now began a new life, so this version no longer describes it`,
          );
        }

        const keep = KEEP_CURRENT[spec.table] || [];
        const changed = columns.filter(
          (column, i) => !keep.includes(column) && canonical(row[column]) !== canonical(values[i]),
        );
        if (changed.length === 0) return report({ newVersionId: null, unchanged: true, row: null, op: null });

        const watermark = maxVersionId(run);
        const sql =
          `UPDATE ${quote(spec.table)} SET ${changed.map((c) => `${quote(c)} = ?`).join(", ")} ` +
          `WHERE ${quote(spec.idColumn)} = ?`;
        const args = [...changed.map((column) => values[columns.indexOf(column)]), itemId];
        const written = run({ sql, args });
        // The row was read inside this transaction, so nothing could have removed
        // it — but a restore that updates nothing must never look like success.
        if (Number(written.rowsAffected || 0) === 0) {
          throw historyError("conflict", `${spec.table}/${itemId} disappeared while version ${id} was being restored`);
        }
        const newVersionId = versionIdAfter(run, watermark, version.item_type, itemId);
        return report({ newVersionId, unchanged: false, row: readRow(run, spec, itemId), op: "update" });
      }

      // The row is gone: put it back as itself, id and filing included.
      const insertColumns = [spec.idColumn, ...columns];
      const watermark = maxVersionId(run);
      const sql =
        `INSERT INTO ${quote(spec.table)} (${insertColumns.map(quote).join(", ")}) ` +
        `VALUES (${insertColumns.map(() => "?").join(", ")})`;
      run({ sql, args: [itemId, ...values] });
      const newVersionId = versionIdAfter(run, watermark, version.item_type, itemId);
      return report({ newVersionId, unchanged: false, row: readRow(run, spec, itemId), op: "insert" });
    }).catch((err) => {
      throw asHistoryError(err);
    }),
  );

  // The write is committed and cannot be taken back by a sync problem, so the
  // emit is last and best effort. A no-op restore has nothing to send.
  const synced =
    outcome.unchanged || !outcome.row
      ? false
      : await emitRestored(db, syncManager, {
          spec: outcome.spec,
          itemType: outcome.itemType,
          op: outcome.op,
          row: outcome.row,
        });

  return { newVersionId: outcome.newVersionId, unchanged: outcome.unchanged, synced, unfiled: outcome.unfiled };
}