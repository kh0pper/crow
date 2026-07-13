/**
 * Sync Conflict Resolution Helper
 *
 * Provides resolveConflict() and restoreConflict() so conflict-review
 * actions from the settings UI (and tests) can call the logic directly
 * without going through HTTP, and without pulling in the full gateway
 * dependency tree.
 *
 * Spec reference: W4-1 §6 (Task B restore logic).
 *
 * Key invariants enforced here:
 *   - NEVER INSERT OR REPLACE (FTS corruption / FK cascade / partial-row nulling).
 *   - Stale-snapshot guard: re-read the live row before any destructive action.
 *     Compare raw snapshots WITHOUT OUTBOUND_TRANSFORMS (transforms are
 *     wire-form preprocessing; applying them here would falsely trip the guard
 *     on rows that have a locally-assigned project_id, etc.).
 *   - Table name validated against SYNCED_TABLES before any SQL interpolation.
 *   - Column names from PRAGMA table_info intersection only (never raw JSON keys).
 *   - op='insert' conflicts → restore refused (D7 collision, operator must resolve
 *     manually; the data is visible in the JSON view).
 *   - The ENTIRE restore application (UPDATE or INSERT) is wrapped in one catch;
 *     on failure the conflict row stays unresolved (spec round-2 C2 / round-3 C2).
 */

import { SYNCED_TABLES, rowsEquivalent } from "./instance-sync.js";

// ── Outcomes ─────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ResolveOutcome
 * @property {"resolved"} status
 */

/**
 * @typedef {Object} RestoreOutcome
 * @property {"applied"|"stale"|"refused"|"error"} status
 * @property {string} [message]   — plain-language message for the UI
 */

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Fetch live columns for a table via PRAGMA table_info.
 * Returns a Set of column names as declared in the schema.
 *
 * @param {object} db
 * @param {string} table — pre-validated against SYNCED_TABLES
 * @returns {Promise<Set<string>>}
 */
async function liveColumns(db, table) {
  const { rows } = await db.execute({
    sql: `PRAGMA table_info(${table})`,
    args: [],
  });
  return new Set(rows.map((r) => r.name));
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Mark a conflict as resolved (no data change).
 *
 * @param {object} db
 * @param {number|string} conflictId
 * @returns {Promise<ResolveOutcome>}
 */
export async function resolveConflict(db, conflictId) {
  await db.execute({
    sql: `UPDATE sync_conflicts SET resolved = 1, resolved_at = datetime('now') WHERE id = ?`,
    args: [conflictId],
  });
  return { status: "resolved" };
}

/**
 * Attempt to restore the losing side of a conflict.
 *
 * Steps per spec §6:
 *   1. Fetch the conflict row; refuse op='insert' immediately.
 *   2. Validate table against SYNCED_TABLES.
 *   3. Stale-snapshot guard: re-read live row, compare to stored winning_data
 *      WITHOUT transforms. If different (or row now gone when snapshot had one):
 *      re-snapshot winning_data + return "stale" outcome (conflict stays unresolved).
 *   4. Parse losing_data; intersect keys with live PRAGMA columns, exclude id.
 *   5. If row exists → UPDATE present keys (id excluded from SET).
 *      If row gone  → plain INSERT of present keys.
 *      Both branches in one try/catch — on failure leave conflict unresolved.
 *   6. emitChange via instanceSync manager (null manager → restore locally, note it).
 *   7. Mark conflict resolved.
 *
 * For op='delete' conflicts, "restore other version" means applying the delete:
 *   stale-snapshot guard (mandatory) → DELETE + emitChange("delete") → resolved.
 *
 * @param {object} db
 * @param {number|string} conflictId
 * @param {{ instanceSync?: object|null }} opts
 * @returns {Promise<RestoreOutcome>}
 */
export async function restoreConflict(db, conflictId, { instanceSync = null } = {}) {
  // ── 1. Fetch conflict row ─────────────────────────────────────────────────

  const { rows: conflictRows } = await db.execute({
    sql: `SELECT * FROM sync_conflicts WHERE id = ?`,
    args: [conflictId],
  });
  if (conflictRows.length === 0) {
    return { status: "error", message: "Conflict record not found." };
  }
  const conflict = conflictRows[0];

  // op='insert' collisions cannot be restored (D7 — the incoming row cannot
  // safely overwrite the unrelated local row that owns its id).
  if (conflict.op === "insert") {
    return {
      status: "refused",
      message:
        "This version cannot be restored automatically. The incoming row collided " +
        "with an unrelated local record at the same id. Review the data below and " +
        "resolve manually.",
    };
  }

  const table = conflict.table_name;
  const rowId = conflict.row_id;

  // crow_context conflicts cannot be auto-restored: the row_id is a JSON composite
  // key, not a numeric id, so the id-keyed stale-snapshot guard below would run
  // SELECT … WHERE id = '{…}', find nothing, re-snapshot to 'null', and silently
  // destroy the recorded local snapshot.  Use crow_update_context_section to apply
  // the losing data manually.  (Placement BEFORE the stale guard is load-bearing —
  // see spec §4 C3.)
  if (table === "crow_context") {
    return {
      status: "refused",
      message:
        "This version cannot be restored automatically. crow_context rows are keyed " +
        "by a composite key (section_key, device_id, project_id), not a single id. " +
        "Use crow_update_context_section to apply the values shown below.",
    };
  }

  // ── 2. Validate table ─────────────────────────────────────────────────────

  if (!SYNCED_TABLES.includes(table)) {
    return {
      status: "error",
      message: `Table "${table}" is not in the sync allowlist.`,
    };
  }

  // ── 3. Stale-snapshot guard ───────────────────────────────────────────────
  // Re-read the live row. Compare raw snapshots (NO OUTBOUND_TRANSFORMS).
  // Guard applies to both update and delete restore paths.

  let storedWinningData;
  try {
    // winning_data is never SQL NULL (NOT NULL constraint), but can be the JSON
    // string 'null' when the row was gone at the time of the snapshot.
    storedWinningData = conflict.winning_data ? JSON.parse(conflict.winning_data) : null;
    // JSON.parse('null') returns the JS value null, so 'null' → null correctly.
  } catch {
    storedWinningData = null;
  }

  const { rows: liveRows } = await db.execute({
    sql: `SELECT * FROM ${table} WHERE id = ?`,
    args: [rowId],
  });
  const liveRow = liveRows[0] ?? null;

  // Determine if the snapshot is stale:
  //   - winning_data was null (row gone) and row now exists → stale.
  //   - winning_data had a row and row is now gone → stale (re-snapshot to null).
  //   - Both present: compare with rowsEquivalent on ALL keys in stored snapshot
  //     (since this is a raw local-to-local comparison, not a wire compare).
  const liveSnapshot = liveRow ?? null;
  let isStale = false;
  if (storedWinningData === null && liveSnapshot !== null) {
    isStale = true;
  } else if (storedWinningData !== null && liveSnapshot === null) {
    isStale = true;
  } else if (storedWinningData !== null && liveSnapshot !== null) {
    // Compare using rowsEquivalent treating storedWinningData as "b"
    // (checks all keys stored in the snapshot against live row).
    if (!rowsEquivalent(liveSnapshot, storedWinningData)) {
      isStale = true;
    }
  }

  if (isStale) {
    // Re-snapshot winning_data to the current live row.
    // When the row is gone, store the JSON string 'null' (not SQL NULL, which would
    // violate the winning_data NOT NULL constraint). The stale guard treats
    // JSON.parse('null') === null the same as storedWinningData === null below.
    const newWinningData = liveSnapshot ? JSON.stringify(liveSnapshot) : "null";
    await db.execute({
      sql: `UPDATE sync_conflicts SET winning_data = ? WHERE id = ?`,
      args: [newWinningData, conflictId],
    });
    return {
      status: "stale",
      message:
        "This item has changed since the conflict was recorded — please review " +
        "the current version and confirm again.",
    };
  }

  // ── op='delete': restore means applying the delete ────────────────────────

  if (conflict.op === "delete") {
    if (liveRow === null) {
      // Row is already gone — nothing to do; mark resolved.
      await resolveConflict(db, conflictId);
      return { status: "applied" };
    }

    try {
      await db.execute({
        sql: `DELETE FROM ${table} WHERE id = ?`,
        args: [rowId],
      });
    } catch (err) {
      return {
        status: "error",
        message:
          "This version can't be restored automatically — the delete failed. " +
          "Its data remains visible below.",
      };
    }

    // emitChange with "delete"
    let syncNote = null;
    if (instanceSync) {
      try {
        await instanceSync.emitChange(table, "delete", { id: rowId });
      } catch {}
    } else {
      syncNote = "Restored locally (sharing not initialized — peers not notified).";
    }

    await resolveConflict(db, conflictId);
    return { status: "applied", message: syncNote || undefined };
  }

  // ── op='update' (or default): restore the losing data ────────────────────

  let losingData;
  try {
    losingData = conflict.losing_data ? JSON.parse(conflict.losing_data) : null;
  } catch {
    losingData = null;
  }
  if (!losingData || typeof losingData !== "object") {
    return {
      status: "error",
      message:
        "This version can't be restored automatically — its data is missing or corrupt.",
    };
  }

  // ── 4. Intersect losing_data keys with live PRAGMA columns, exclude id ───

  const cols = await liveColumns(db, table);
  // lamport_ts is excluded from the SET (it will be set by emitChange when
  // propagating, and locally it should reflect the restore, not the old wire ts).
  // id is excluded from SET per spec (mirroring _applyUpdate).
  const EXCLUDE_FROM_SET = new Set(["id", "lamport_ts"]);
  const presentKeys = Object.keys(losingData).filter(
    (k) => cols.has(k) && !EXCLUDE_FROM_SET.has(k),
  );

  // ── 5. Apply restore in one catch ────────────────────────────────────────

  let applyOp; // "update" or "insert"
  try {
    if (liveRow !== null) {
      // Row exists: UPDATE only the present keys (excluding id from SET).
      applyOp = "update";
      if (presentKeys.length === 0) {
        // Nothing to update (no overlapping mutable columns); treat as resolved.
        await resolveConflict(db, conflictId);
        return { status: "applied" };
      }
      const setClauses = presentKeys.map((k) => `${k} = ?`).join(", ");
      const values = presentKeys.map((k) => losingData[k] ?? null);
      await db.execute({
        sql: `UPDATE ${table} SET ${setClauses} WHERE id = ?`,
        args: [...values, rowId],
      });
    } else {
      // Row gone: plain INSERT of present keys (id included if present in losing data).
      applyOp = "insert";
      const insertKeys = Object.keys(losingData).filter((k) => cols.has(k));
      if (insertKeys.length === 0) {
        return {
          status: "error",
          message:
            "This version can't be restored automatically — no valid columns found. " +
            "Its data remains visible below.",
        };
      }
      const colList = insertKeys.join(", ");
      const placeholders = insertKeys.map(() => "?").join(", ");
      const values = insertKeys.map((k) => losingData[k] ?? null);
      if (table === "contact_groups") {
        // G3 (2b design R2 F3'): an operator clicking Restore on an old
        // contact_groups conflict must NOT re-insert a tombstoned group_uid —
        // that would manufacture the resurrection zombie through a SUPPORTED
        // UI path (G1 then quarantines it on peers: permanent, silent).
        // STATEMENT-LEVEL guard (INSERT…SELECT WHERE NOT EXISTS), same shape
        // as G1's apply gate, so the check is atomic with the write. A NULL
        // uid never matches the subquery → the insert proceeds (a keyless row
        // cannot be tombstoned; fail-open like isGroupTombstoned). NEVER add
        // RETURNING here: stmt.reader would flip and rowsAffected hardcodes 0
        // (servers/db.js:153-172), silently turning every restore into a
        // refusal.
        const uid = typeof losingData.group_uid === "string" ? losingData.group_uid : null;
        const res = await db.execute({
          sql: `INSERT INTO ${table} (${colList})
                SELECT ${placeholders}
                WHERE NOT EXISTS (SELECT 1 FROM group_tombstones WHERE group_uid = ?)`,
          args: [...values, uid],
        });
        if (!(Number(res?.rowsAffected) > 0)) {
          // Refused, not applied: leave the conflict UNRESOLVED (its data
          // stays visible, like the op='insert' D7 refusal) and emit nothing.
          return {
            status: "refused",
            message:
              "This group was deleted fleet-wide — restore refused. Deleted " +
              "groups stay deleted on every instance; re-create the group " +
              "instead (it will get a fresh identity and sync normally).",
          };
        }
      } else {
        await db.execute({
          sql: `INSERT INTO ${table} (${colList}) VALUES (${placeholders})`,
          args: values,
        });
      }
    }
  } catch {
    return {
      status: "error",
      message:
        "This version can't be restored automatically — its data conflicts with the " +
        "current database state. Its data remains visible below.",
    };
  }

  // ── 6. emitChange so peers receive the restoration ───────────────────────

  let syncNote = null;
  if (instanceSync) {
    try {
      // "update" when we UPDATEd; "insert" when we re-INSERTed a since-deleted row.
      // Emitting "update" for a re-insert would silently no-op on peers that also
      // lack the row (_applyUpdate matches 0 rows without error).
      await instanceSync.emitChange(table, applyOp, { ...losingData, id: rowId });
    } catch {}
  } else {
    syncNote = "Restored locally (sharing not initialized — peers not notified).";
  }

  // ── 7. Mark resolved ──────────────────────────────────────────────────────

  await resolveConflict(db, conflictId);
  return { status: "applied", message: syncNote || undefined };
}
