/**
 * trash.js — deleted items, held for N days, then erased for good.
 *
 * "Deleting: trash, then gone" (the version history design §3.4). A delete is an
 * ordinary DELETE on the covered table, so the capture trigger records a `delete`
 * version holding what was removed. That row IS the Trash entry: an item is
 * "in the Trash" exactly when its LATEST version is a delete and its versions
 * still exist.
 *
 * That definition gives the three properties this file needs for free:
 *   - nothing extra to keep in step: no separate trash table, no backfill;
 *   - a restore (a new version) takes the item out of the Trash by definition,
 *     and so does a re-create;
 *   - ERASED means GONE: erase (erase.js) removes every version, so an erased
 *     item cannot be listed or restored by anything reading this module.
 *
 * An erased item leaves ONE durable record — its tombstone in item_erasures
 * (erase.js), which is exactly what is NOT leaked here: it holds no content, no
 * snapshot and no name, only (item_type, item_id) and who erased it when. It is
 * what makes "gone" survive a peer's restore (an erase event tells the peer to
 * erase its copy and record the same tombstone, and sync then refuses to
 * re-create the item). This module reads it only to refuse a restore of a
 * tombstoned item with code 'erased' — the Trash listing never shows one, because
 * a tombstoned item has no versions left to list.
 *
 * Restore goes through api.js's restoreVersion — the one restore in the code
 * base — so a Trash restore IS a new version (review focus 3), it is attributed,
 * and a redacted delete version is refused rather than pasting "[redacted]" into
 * live content.
 *
 * Emptying is the owner's alone (the version history design §4: a bot cannot
 * empty the Trash), and it erases through the same armed door as everything else.
 */
import { restoreVersion } from "./api.js";
import { eraseItems, erasureKeys, findErasedKey } from "./erase.js";

/** The default Trash period, in days (the design's §8.8 default). */
export const DEFAULT_TRASH_DAYS = 30;

/** Rows one Trash listing (or one expand of it) returns. */
export const MAX_TRASH_ROWS = 500;

const MS_PER_DAY = 86_400_000;

function trashError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const str = (v) => {
  if (typeof v === "string") {
    const s = v.trim();
    return s === "" ? null : s;
  }
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
};

/** 1…MAX_TRASH_ROWS, the default for anything unusable. */
function normalizeLimit(limit) {
  const n = Math.trunc(Number(limit));
  if (!Number.isFinite(n) || n <= 0) return MAX_TRASH_ROWS;
  return Math.min(n, MAX_TRASH_ROWS);
}

/** A Trash period in days: a finite number ≥ 1, else the default. */
export function normalizeTrashDays(days) {
  const n = Number(days);
  return Number.isFinite(n) ? Math.max(1, n) : DEFAULT_TRASH_DAYS;
}

/**
 * The items whose LATEST version is a `delete`, newest deletion first.
 *
 * One indexed pass over item_versions: the inner query picks each item's newest
 * version id (idx_item_versions_item), the outer one keeps the deletes. `before`
 * is an ISO timestamp: only deletions at or before it (the sweep's and
 * emptyTrash's age filter).
 *
 * Exported because the sweep needs the same definition of "in the Trash" that the
 * Trash page shows — one query, two callers, no chance of the two drifting.
 *
 * @param {object} db
 * @param {{before?: string|null, limit?: number}} [opts]
 * @returns {Promise<Array<{itemType: string, itemId: string, deletedAt: string,
 *   deletedBy: {authorKind: string, authorId: string|null},
 *   jobId: string|null, originInstance: string|null, redacted: boolean,
 *   snapshot: object}>>}
 */
export async function trashEntries(db, { before = null, limit = MAX_TRASH_ROWS } = {}) {
  const args = [];
  let ageFilter = "";
  if (typeof before === "string" && before !== "") {
    // `<=`, not `<`: an age filter of 0 days means "everything deleted up to now",
    // and a deletion recorded in the same millisecond as the call is still that.
    ageFilter = " AND v.created_at <= ?";
    args.push(before);
  }
  args.push(normalizeLimit(limit));
  const { rows } = await db.execute({
    sql: `SELECT v.item_type, v.item_id, v.op, v.created_at, v.author_kind, v.author_id,
                 v.job_id, v.origin_instance, v.redacted, v.snapshot_json
            FROM item_versions v
           WHERE v.op = 'delete'${ageFilter}
             AND NOT EXISTS (
               SELECT 1 FROM item_versions newer
                WHERE newer.item_type = v.item_type
                  AND newer.item_id = v.item_id
                  AND newer.id > v.id
             )
           ORDER BY v.id DESC
           LIMIT ?`,
    args,
  });
  return rows.map((row) => ({
    itemType: row.item_type,
    itemId: String(row.item_id),
    deletedAt: row.created_at,
    deletedBy: { authorKind: row.author_kind, authorId: row.author_id ?? null },
    jobId: row.job_id ?? null,
    originInstance: row.origin_instance ?? null,
    redacted: Number(row.redacted) === 1,
    snapshot: JSON.parse(row.snapshot_json),
  }));
}

/**
 * The Trash page's list. Newest deletion first, capped by MAX_TRASH_ROWS.
 *
 * @param {object} db
 * @param {{limit?: number, before?: string|null}} [opts]
 */
export async function listTrash(db, opts = {}) {
  return trashEntries(db, opts);
}

/** The item's newest version row (id, op, created_at), or null when it has none (erased). */
async function newestVersion(db, itemType, itemId) {
  const { rows } = await db.execute({
    sql: `SELECT id, op, created_at FROM item_versions WHERE item_type = ? AND item_id = ? ORDER BY id DESC LIMIT 1`,
    args: [itemType, itemId],
  });
  return rows[0] ?? null;
}

/**
 * Put a deleted item back from the Trash.
 *
 * The restore is api.js's restoreVersion on the delete version: the row comes
 * back as ITSELF (same id, same project filing) and the restore is a new version,
 * so the delete stays in the item's History afterwards (review focus 3).
 *
 * Refusals: `not_found` when the item has no versions at all (never existed),
 * `erased` when the item was erased (its tombstone is permanent: the operator's
 * ruling of 2026-11-10 is that an erase is for good, so a restore of one is
 * refused rather than re-created), `not_in_trash` when its newest version is not
 * a delete (it is live), and restoreVersion's own `redacted` / `conflict` /
 * `invalid_context` / `erased`.
 *
 * ORDER MATTERS, and the tombstone is VERSIONED. An erased item usually has no
 * versions left, so when there is nothing to restore and a tombstone exists the
 * honest answer is 'erased', not 'not_found'. When a version DOES exist, the
 * question is restoreVersion's: a version created at or before the tombstone's
 * `erased_at` is the erased item's and is refused there ('erased'), while a
 * version written after the erase is a new life of that id and restores normally.
 *
 * SYNC: a Trash restore is a NORMAL write, not a local-only one. It emits through
 * the same door an ordinary edit uses (`{ syncManager }`, see api.js's
 * restoreVersion), which also mints the fresh lamport_ts the row needs: without
 * that, a peer's next edit carried the pre-restore value and won last-write-wins
 * over the restore, and a restored delete came back on this instance only. The
 * emit is best effort — `synced: false` in the result says the restore stayed
 * local (a host with sync off, a table that does not sync, an emitter that
 * failed), never that the restore did not happen.
 *
 * @param {object} db
 * @param {{itemType: string, itemId: string|number}} item
 * @param {{authorKind: string, authorId?: string, jobId?: string}} ctx who restored it
 * @param {{syncManager?: object|null}} [opts] the process's InstanceSyncManager, when it has one
 * @returns {Promise<{itemType: string, itemId: string, newVersionId: number|null,
 *   unchanged: boolean, synced: boolean, unfiled: boolean}>}
 */
export async function restoreFromTrash(db, item = {}, ctx, { syncManager = null } = {}) {
  const itemType = str(item.itemType);
  const itemId = str(item.itemId);
  if (itemType === null || itemId === null) {
    throw trashError("invalid_request", "restoreFromTrash needs an itemType and an itemId");
  }
  // Erased is permanent FOR THE ERASED ITEM: its tombstone outlives its versions
  // (see the module comment). With nothing left to restore, 'erased' is the
  // honest answer; with a version left, the version's own age decides, and
  // restoreVersion asks that (it knows the created_at).
  const newest = await newestVersion(db, itemType, itemId);
  if (!newest) {
    if (await findErasedKey(db, itemType, erasureKeys(itemType, { itemId }))) {
      throw trashError("erased", `${itemType}/${itemId} was erased and cannot be restored`);
    }
    throw trashError("not_found", `${itemType}/${itemId} has no history: nothing to restore`);
  }
  if (newest.op !== "delete") {
    throw trashError("not_in_trash", `${itemType}/${itemId} is live, not in the Trash`);
  }
  const { newVersionId, unchanged, synced, unfiled } = await restoreVersion(
    db,
    { versionId: Number(newest.id), syncManager },
    ctx,
  );
  return { itemType, itemId, newVersionId, unchanged, synced, unfiled };
}

/**
 * Empty the Trash, or the part of it older than `olderThanDays` days.
 *
 * Owner only: a bot may not empty the Trash (the version history design §4).
 * The removal goes through erase.js, so it is the same armed, one-transaction
 * door the aging sweep uses — emptying early and ageing out are one operation
 * with different clocks.
 *
 * @param {object} db
 * @param {{olderThanDays?: number, now?: Date, maxPages?: number,
 *   syncManager?: object|null|undefined}} [opts]
 *   `olderThanDays` defaults to 0 (empty it all). `now` is injectable for tests.
 *   `maxPages` bounds one call to that many pages of MAX_TRASH_ROWS items.
 *   `syncManager` is passed to every erase (see erase.js): undefined resolves
 *   this process's sync manager, null keeps the erase local.
 * @param {{authorKind: string, authorId?: string}} ctx must be the owner
 * @returns {Promise<{erased: Array<{itemType: string, itemId: string, versions: number}>,
 *   count: number, versions: number, emitted: number, before: string}>}
 */
export async function emptyTrash(
  db,
  { olderThanDays = 0, now = new Date(), maxPages = 20, syncManager = undefined } = {},
  ctx,
) {
  if (!ctx || ctx.authorKind !== "owner") {
    throw trashError("not_owner", "only the owner can empty the Trash");
  }
  // 0 (the default) means "empty it all now". A real period is at least a day
  // (normalizeTrashDays), so a stray 0 setting cannot turn the aging sweep into
  // "erase everything that is in the Trash".
  const requested = Number(olderThanDays);
  const days = Number.isFinite(requested) && requested <= 0 ? 0 : normalizeTrashDays(requested);
  const before = new Date(now.getTime() - days * MS_PER_DAY).toISOString();
  // One page of MAX_TRASH_ROWS per erase (each page is its own armed transaction),
  // repeated until the Trash is empty or the page cap is reached — so one click
  // empties the Trash rather than the first 500 items of it, and a pathological
  // store cannot keep one request busy forever.
  const erased = [];
  let versions = 0;
  let emitted = 0;
  for (let page = 0; page < maxPages; page++) {
    const entries = await trashEntries(db, { before, limit: MAX_TRASH_ROWS });
    if (entries.length === 0) break;
    const result = await eraseItems(
      db,
      entries.map((e) => ({ itemType: e.itemType, itemId: e.itemId })),
      ctx,
      // The conditional is inside the armed transaction: a restore between this
      // page's listing and its erase wrote a newer version, so it survives.
      { deletedBefore: before, syncManager },
    );
    erased.push(...result.erased.filter((item) => item.versions > 0));
    versions += result.versions;
    emitted += result.emitted;
    // `result.erased` is empty only when there was nothing to act on (no history
    // store). An entry with 0 versions is a restore that won the race: it is not
    // in the next listing, so the next page is the right place to continue.
    if (result.erased.length === 0) break;
  }
  return { erased, count: erased.length, versions, emitted, before };
}