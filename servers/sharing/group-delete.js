/**
 * Group deletion primitives — tombstones (Item 2b, design §3.2/§3.3).
 *
 * Pure DB helpers with ZERO imports from the sharing layer, mirroring
 * contact-delete.js: sharing-side modules (group-sync.js, instance-sync.js)
 * import this module, and any sharing-side import here would risk the import
 * cycle the lazy dynamic imports in contact-sync.js exist to avoid. Keep this
 * module dependency-free.
 *
 * Semantics DIVERGE from contact_tombstones deliberately (design §3.1): a
 * group tombstone is STRICT delete-wins, keyed on group_uid, with NO lamport
 * gate and NO clear path. The `contact_groups_group_uid_ai` trigger assigns
 * every new group a random uid, so a tombstoned uid can never legitimately
 * return (design §2) — every same-uid reappearance is stale by construction
 * and is dropped forever.
 *
 * Tombstones are LOCAL state, never synced, never pruned (design §3.5): any
 * retention window would re-open the resurrection hole for peers offline
 * longer than the window — the exact defect Item 2b exists to close.
 */

/**
 * The tombstone UPSERT as a STATEMENT, so a caller can commit it atomically
 * with other writes via `db.batch()` (one transaction). W1 (the originating
 * `delete_group`) needs exactly that: the local DELETE and the tombstone MUST
 * land together, or not at all — neither ordering of two separate executes
 * survives its failure modes (the 2a lesson).
 *
 * No `kind` column (contrast contact_tombstones): groups have exactly ONE
 * writer class — the authoritative user delete — so there is no cross-clock
 * precedence to resolve. And because §3.1 is strict delete-wins, `lamport_ts`
 * is recorded for OBSERVABILITY ONLY and is consumed by nothing — it gates no
 * decision, so the blanket MAX on conflict cannot arm any gate wrongly (the
 * commensurability hazard class that produced three of 2a's six bugs simply
 * does not exist here).
 *
 * `deleted_at` is set to now (unix seconds) on first write and PRESERVED on
 * conflict — first write wins; it is wall-clock diagnostics only.
 *
 * @param {string} groupUid
 * @param {number} lamportTs the delete's Lamport clock (observability only)
 * @returns {{sql: string, args: Array}}
 */
export function groupTombstoneStatement(groupUid, lamportTs) {
  return {
    sql: `INSERT INTO group_tombstones (group_uid, lamport_ts, deleted_at)
          VALUES (?, ?, ?)
          ON CONFLICT(group_uid) DO UPDATE SET
            lamport_ts = MAX(group_tombstones.lamport_ts, excluded.lamport_ts)`,
    args: [groupUid, Number(lamportTs) || 0, Math.floor(Date.now() / 1000)],
  };
}

/**
 * UPSERT a tombstone. Guarded — it runs on the receive path and must never
 * throw; no-ops on a falsy db or uid.
 * @param {object} db async db client ({ execute })
 * @param {string} groupUid
 * @param {number} lamportTs
 */
export async function writeGroupTombstone(db, groupUid, lamportTs) {
  if (!db || !groupUid) return;
  try {
    await db.execute(groupTombstoneStatement(groupUid, lamportTs));
  } catch { /* never throw into a receive path */ }
}

/**
 * Read a tombstone row. Guarded: returns null on a missing row, a falsy
 * arg, or ANY error (e.g. missing table on an un-migrated DB).
 * @param {object} db async db client
 * @param {string} groupUid
 * @returns {Promise<{group_uid:string,lamport_ts:number,deleted_at:number}|null>}
 */
export async function readGroupTombstone(db, groupUid) {
  if (!db || !groupUid) return null;
  try {
    const { rows } = await db.execute({
      sql: `SELECT group_uid, lamport_ts, deleted_at FROM group_tombstones WHERE group_uid = ?`,
      args: [groupUid],
    });
    return rows[0] || null;
  } catch {
    return null;
  }
}

/**
 * Is this uid tombstoned? Guarded and FAIL-OPEN (design G2): ANY error —
 * e.g. a missing group_tombstones table under a stale session-spawned server
 * on an un-migrated DB — returns false, meaning "not tombstoned". A read
 * failure must NEVER swallow the caller's work: fail-closed here would
 * silently kill every group sync emit from that process (including
 * crow_create_message_group and the boot backfill), which is exactly the
 * failure mode G2 exists to prevent. The receive-side correctness mechanism
 * is the statement-level NOT EXISTS guard (G1), not this read.
 * @param {object} db async db client
 * @param {string} groupUid
 * @returns {Promise<boolean>}
 */
export async function isGroupTombstoned(db, groupUid) {
  if (!db || !groupUid) return false;
  try {
    const { rows } = await db.execute({
      sql: `SELECT 1 AS one FROM group_tombstones WHERE group_uid = ? LIMIT 1`,
      args: [groupUid],
    });
    return rows.length > 0;
  } catch {
    return false; // FAIL-OPEN — see doc comment
  }
}
