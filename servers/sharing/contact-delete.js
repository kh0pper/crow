/**
 * Contact deletion primitives — tombstones (F-CONTACT-1, design §D3).
 *
 * Pure DB helpers with ZERO imports from the sharing layer. contact-sync.js
 * imports this module, and contact-sync.js is itself imported by
 * contact-promote.js (which is on the managers.js → nostr.js import chain), so
 * any sharing-side import here would risk the very cycle the lazy dynamic import
 * in contact-sync.js exists to avoid. Keep this module dependency-free.
 *
 * Tombstones are LOCAL state, never synced, never pruned (design §D3). They are
 * NEVER written for `req:`-prefixed crow_ids — those rows are per-instance
 * message-request state that never sync. Every helper is guarded (it runs on the
 * receive path and must never throw) and no-ops on a `req:` id.
 */

/** @param {string} id @returns {boolean} true for a per-instance `req:` row. */
function isReqId(id) {
  return typeof id === "string" && id.startsWith("req:");
}

/**
 * UPSERT a tombstone keeping the MAX lamport_ts. deleted_at is set to now (unix
 * seconds) on first write and preserved on conflict. No-op for `req:` ids.
 * @param {object} db async db client ({ execute })
 * @param {string} crowId
 * @param {number} lamportTs the delete's Lamport clock
 */
export async function writeTombstone(db, crowId, lamportTs) {
  if (!db || !crowId || isReqId(crowId)) return;
  try {
    await db.execute({
      sql: `INSERT INTO contact_tombstones (crow_id, lamport_ts, deleted_at)
            VALUES (?, ?, ?)
            ON CONFLICT(crow_id) DO UPDATE SET lamport_ts = MAX(lamport_ts, excluded.lamport_ts)`,
      args: [crowId, Number(lamportTs) || 0, Math.floor(Date.now() / 1000)],
    });
  } catch { /* never throw into a receive path */ }
}

/**
 * @param {object} db async db client
 * @param {string} crowId
 * @returns {Promise<{crow_id:string,lamport_ts:number,deleted_at:number}|null>}
 */
export async function readTombstone(db, crowId) {
  if (!db || !crowId || isReqId(crowId)) return null;
  try {
    const { rows } = await db.execute({
      sql: `SELECT crow_id, lamport_ts, deleted_at FROM contact_tombstones WHERE crow_id = ?`,
      args: [crowId],
    });
    return rows[0] || null;
  } catch {
    return null;
  }
}

/**
 * Remove a tombstone (a local re-create supersedes it). No-op for `req:` ids.
 * @param {object} db async db client
 * @param {string} crowId
 */
export async function clearTombstone(db, crowId) {
  if (!db || !crowId || isReqId(crowId)) return;
  try {
    await db.execute({ sql: `DELETE FROM contact_tombstones WHERE crow_id = ?`, args: [crowId] });
  } catch { /* never throw */ }
}
