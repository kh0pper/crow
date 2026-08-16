/**
 * Board shared util — small helpers duplicated across card-service.js,
 * plan-service.js, result-service.js (nowStamp) and the archived_at
 * column-guard idiom used wherever a caller can't assume migration 0004 has
 * run yet (nowStamp callers stamp columns; hasArchivedAtColumn guards a
 * WHERE clause). Converged here (Track 2 Task 10, W4/§5.3) so there is one
 * definition instead of three near-identical copies drifting apart.
 */

/**
 * A JS-side timestamp in the same shape as SQLite's `datetime('now')`
 * (UTC "YYYY-MM-DD HH:MM:SS"). Used wherever a stamped column also needs to
 * appear in a mutation's diff — going through a placeholder lets the diff
 * record the EXACT value written, instead of a second read-back after the
 * SQL-side `datetime('now')` literal.
 */
export function nowStamp() {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

/**
 * True iff tasks_items on `db` carries an archived_at column. An installed
 * bundle's tasks.db (or a store that hasn't converged through migration
 * 0004 yet) may not have it — callers that filter on archived_at must guard
 * with this first (PRAGMA probe idiom: scripts/pi-bots/bridge.mjs
 * planForCard, scripts/pi-bots/tracker.mjs archivedClause).
 */
export async function hasArchivedAtColumn(db) {
  try {
    const rows = (await db.execute("PRAGMA table_info(tasks_items)")).rows || [];
    return rows.some((r) => r.name === "archived_at");
  } catch {
    return false;
  }
}
