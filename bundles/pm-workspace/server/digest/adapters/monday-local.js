/**
 * Digest adapter — local Monday mirror + sync health.
 *
 * Summarizes pm_sync_state (mapped items per board) and the pm_sync_log
 * tail (last runs, conflicts, errors). Makes NO Monday API calls — this
 * is a pure local read, so it always works even when Monday is
 * unreachable.
 */

export async function mondayLocalSection(db) {
  const section = { title: "Monday sync", available: false, items: [], table: null };
  try {
    const state = await db.execute({
      sql: `SELECT board_id, COUNT(*) AS n, MAX(last_synced_at) AS last
            FROM pm_sync_state GROUP BY board_id ORDER BY board_id`,
      args: [],
    });
    section.available = true;

    if (state.rows.length === 0) {
      section.note = "No boards synced yet.";
    } else {
      section.table = {
        headers: ["Board", "Items", "Last synced"],
        rows: state.rows.map((r) => [r.board_id, String(r.n), r.last || "never"]),
      };
    }

    // The sync re-logs unresolved flags every run (e.g. delete_flagged each
    // 15-min pull), so collapse to one row per distinct problem with a count —
    // otherwise a single stale flag fills the whole section.
    const problems = await db.execute({
      sql: `SELECT MAX(run_at) AS run_at, action, board_id, item_ref,
                   detail, COUNT(*) AS n
            FROM pm_sync_log
            WHERE (ok = 0 OR action IN ('conflict','delete_flagged'))
              AND run_at >= datetime('now', '-1 day')
            GROUP BY board_id, action, item_ref
            ORDER BY run_at DESC LIMIT 10`,
      args: [],
    });
    for (const row of problems.rows) {
      const times = Number(row.n) > 1 ? ` (×${row.n} in 24h)` : "";
      section.items.push({
        label: `${row.action} — ${row.item_ref || "?"}${times}`,
        detail: row.detail || "",
        meta: `board ${row.board_id} · last ${row.run_at}`,
        urgent: true,
      });
    }
  } catch (err) {
    section.available = false;
    section.reason = `sync tables unavailable: ${err.message}`;
  }
  return section;
}
