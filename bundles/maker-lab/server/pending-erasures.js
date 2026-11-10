/**
 * Maker Lab — the durable "finish this learner erase" marker.
 *
 * A learner delete is a COPPA / GDPR-K promise (DATA-HANDLING.md): the child's
 * sessions, transcripts, memories, settings, the profile row and the HISTORY of
 * everything deleted all have to go. It is also two operations that cannot be
 * one: the cascade is a `db.batch()` of ordinary DELETEs, and the history erase
 * (servers/shared/history/erase.js) is its own armed transaction, in a different
 * module, which can fail (a busy store, a broken arm switch, the history tables
 * deferred).
 *
 * So the cascade writes a marker FIRST, in the SAME batch:
 *
 *   pending_erasures(learner_id, project_uuid, memory_ids_json, created_at)
 *
 * and the marker is cleared only after the erase finished. That is what makes a
 * failed delete RETRYABLE TO COMPLETION:
 *
 *   - a retry with the same `learner_id` finds the marker even when the profile
 *     row is already gone (which is exactly the case after a failed erase — the
 *     cascade committed), remembers which memory ids it must forget, finishes
 *     the erase and only then reports success;
 *   - the 5-minute sweep (retention-sweep.js) does the same for a marker nobody
 *     retried, so a learner erase completes without anyone watching.
 *
 * Success is reported ONLY when no marker remains. A marker that cannot be
 * cleared is a failure, not a success with a footnote.
 *
 * WHY A SEPARATE TABLE (and not a status column on item_erasures): the two rows
 * answer different questions. item_erasures is a permanent tombstone keyed by
 * (item_type, item_id) and lives in the history domain; this is a short-lived
 * WORK ITEM keyed by a learner, holding a list of memory ids to forget and the
 * project to finish, and it is deleted when the work is done. Reusing the
 * tombstone table would put a mutable status on a row that must never change and
 * would make "an item is erased" answerable only by joining a learner's queue.
 *
 * The table is created by migration 0024 and ensured here as well, so an install
 * whose bundle is newer than its crow.db still deletes a learner correctly.
 */
import { appImport } from "./app-root.js";

/**
 * Verbatim copy of scripts/migrations/0024-item-versions.mjs's DDL — a migration
 * may not import a bundle, so the two shapes are kept identical by hand.
 */
export const PENDING_ERASURES_DDL = `
  CREATE TABLE IF NOT EXISTS pending_erasures (
    learner_id INTEGER PRIMARY KEY,
    project_uuid TEXT,
    memory_ids_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );`;

/** The context the erase runs as: Crow itself, on the learner delete's behalf. */
const ERASE_CTX = { authorKind: "system", authorId: "maker-lab" };

/** Items one `eraseItems` call may name (erase.js's MAX_ITEMS is 1000). */
const ERASE_CHUNK = 1000;

/** Markers one sweep pass finishes (a bound on one tick's work). */
export const SWEEP_LIMIT = 100;

/** Per-handle memo: this store's marker table has been ensured. */
const READY = new WeakSet();

/**
 * Create `pending_erasures` if this store does not have it (a crow.db that has
 * not run migration 0024 yet, or an install whose bundle is newer than its core).
 */
export async function ensurePendingErasuresTable(db) {
  if (READY.has(db)) return;
  await db.execute(PENDING_ERASURES_DDL);
  READY.add(db);
}

/** The marker INSERT/UPSERT statement, for the cascade's own batch. */
export function pendingErasureStatement({ learnerId, projectUuid = null, memoryIds = [] }) {
  return {
    sql: `INSERT INTO pending_erasures (learner_id, project_uuid, memory_ids_json, created_at)
          VALUES (?, ?, ?, datetime('now'))
          ON CONFLICT(learner_id) DO UPDATE SET
            project_uuid = COALESCE(excluded.project_uuid, pending_erasures.project_uuid),
            memory_ids_json = excluded.memory_ids_json,
            created_at = excluded.created_at`,
    args: [Number(learnerId), projectUuid, JSON.stringify(memoryIds.map(String))],
  };
}

/**
 * The marker for one learner, or null.
 *
 * @param {object} db
 * @param {number|string} learnerId
 * @returns {Promise<{learner_id: number, project_uuid: string|null,
 *   memory_ids: string[], created_at: string}|null>}
 */
export async function readPendingErasure(db, learnerId) {
  await ensurePendingErasuresTable(db);
  const { rows } = await db.execute({
    sql: "SELECT learner_id, project_uuid, memory_ids_json, created_at FROM pending_erasures WHERE learner_id = ?",
    args: [Number(learnerId)],
  });
  const row = rows[0];
  if (!row) return null;
  let memoryIds = [];
  try {
    const parsed = JSON.parse(row.memory_ids_json || "[]");
    if (Array.isArray(parsed)) memoryIds = parsed.map(String);
  } catch {
    memoryIds = []; // a corrupt list is not a reason to skip the project-wide erase
  }
  return {
    learner_id: Number(row.learner_id),
    project_uuid: row.project_uuid ?? null,
    memory_ids: memoryIds,
    created_at: row.created_at,
  };
}

/** Every marker, oldest first (the sweep's queue). */
export async function listPendingErasures(db, { limit = SWEEP_LIMIT } = {}) {
  await ensurePendingErasuresTable(db);
  const { rows } = await db.execute({
    sql: "SELECT learner_id FROM pending_erasures ORDER BY created_at ASC LIMIT ?",
    args: [Math.max(1, Number(limit) || SWEEP_LIMIT)],
  });
  const out = [];
  for (const row of rows) {
    const pending = await readPendingErasure(db, row.learner_id);
    if (pending) out.push(pending);
  }
  return out;
}

/** Has the marker been cleared? (The only proof an erase is complete.) */
async function markerRemains(db, learnerId) {
  const { rows } = await db.execute({
    sql: "SELECT 1 FROM pending_erasures WHERE learner_id = ? LIMIT 1",
    args: [Number(learnerId)],
  });
  return rows.length > 0;
}

/**
 * Erase the history of one learner: the memories it named, and everything the
 * project-wide closure takes (context sections the delete removed, and a memory
 * that was already in the Trash before this delete). Same door a sweep or the
 * project purge uses — armed, one transaction each, and now with a tombstone per
 * item so nothing can be synced back in.
 *
 * `eraseItems` names at most 1000 items per call by design: chunk rather than let
 * a big learner skip the erase entirely.
 *
 * @returns {Promise<{versions: number, items: number}>}
 */
export async function eraseLearnerHistory(db, { learnerId, projectUuid = null, memoryIds = [] }) {
  const { eraseItems, eraseByProject } = await appImport("servers/shared/history/erase.js");
  const ids = [...new Set(memoryIds.map(String))];
  let versions = 0;
  let items = 0;
  for (let i = 0; i < ids.length; i += ERASE_CHUNK) {
    const result = await eraseItems(
      db,
      ids.slice(i, i + ERASE_CHUNK).map((id) => ({ itemType: "memory", itemId: id })),
      ERASE_CTX,
    );
    versions += result.versions;
    items += result.erased.length;
  }
  const projectResult = await eraseByProject(
    db,
    { projectUuid, projectId: learnerId },
    ERASE_CTX,
  );
  versions += projectResult.versions;
  items += projectResult.erased.length;
  return { versions, items };
}

/**
 * Finish one marker: erase, clear the marker, and confirm none remains.
 *
 * The marker is cleared only AFTER the erase returns, so a failure anywhere keeps
 * it for the next retry (or the next sweep tick). A marker that cannot be cleared
 * throws: the caller must not report success.
 *
 * @returns {Promise<{learnerId: number, versions: number, items: number}>}
 */
export async function finishPendingErasure(db, pending) {
  const learnerId = Number(pending.learner_id);
  const { versions, items } = await eraseLearnerHistory(db, {
    learnerId,
    projectUuid: pending.project_uuid ?? null,
    memoryIds: pending.memory_ids ?? [],
  });
  await db.execute({ sql: "DELETE FROM pending_erasures WHERE learner_id = ?", args: [learnerId] });
  if (await markerRemains(db, learnerId)) {
    throw new Error(`the pending erase marker for learner ${learnerId} could not be cleared`);
  }
  return { learnerId, versions, items };
}

/**
 * The 5-minute sweep: finish every pending marker, oldest first.
 *
 * A marker whose erase fails is LEFT in place and reported — never deleted
 * because "we tried". One learner's failure must not stop the others, so each is
 * handled in its own try/catch; the caller logs the result.
 *
 * @param {object} db
 * @param {{limit?: number}} [opts]
 * @returns {Promise<{completed: Array<{learnerId: number, versions: number, items: number}>,
 *   failed: Array<{learnerId: number, error: string}>}>}
 */
export async function finishPendingErasures(db, { limit = SWEEP_LIMIT } = {}) {
  const completed = [];
  const failed = [];
  let pending = [];
  try {
    pending = await listPendingErasures(db, { limit });
  } catch (err) {
    // A store without the table (an old crow.db, no migration yet) has no
    // markers to finish — that is not a failure worth a log line every 5 minutes.
    if (/no such table/i.test(String(err?.message || ""))) return { completed, failed };
    throw err;
  }
  for (const marker of pending) {
    try {
      completed.push(await finishPendingErasure(db, marker));
    } catch (err) {
      failed.push({ learnerId: Number(marker.learner_id), error: String(err?.message || err) });
    }
  }
  return { completed, failed };
}