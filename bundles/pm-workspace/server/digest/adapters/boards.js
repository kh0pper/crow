/**
 * Digest adapter — local boards.
 *
 * Reads (1) the kanban tasks DB (tasks bundle: tasks_items in
 * $CROW_TASKS_DB_PATH → $CROW_DATA_DIR/tasks.db) for open items that are
 * due soon / overdue / recently completed, and (2) that same tasks.db's
 * slug boards (board_defs/tasks_items — Track 0 Phase B converged the old
 * crow.db tracker_defs/tracker_items in here) for per-tracker status
 * counts and action_needed items.
 *
 * Degrades gracefully: absent DBs or tables simply mark their section
 * unavailable — the digest never throws from here.
 *
 * `tdb` is optional: kanbanSection still opens/closes its own short-lived
 * tasks.db client (unchanged), but trackersSection needs one handed in by
 * the caller (assembleDigest in digest/index.js owns its lifecycle). A
 * caller that doesn't pass one (e.g. the Crow's Nest panel overview, which
 * only reads the "Tasks" section) gets a degraded "Trackers" section back,
 * never a throw.
 */

import { createTasksDbClient } from "../../db.js";

export async function boardsSections(db, config, tdb) {
  const sections = [];
  sections.push(await kanbanSection(config));
  sections.push(await trackersSection(tdb));
  return sections;
}

async function kanbanSection(config) {
  const section = { title: "Tasks", available: false, items: [] };
  let tdb = null;
  try {
    tdb = createTasksDbClient(config);
    if (!tdb) {
      section.reason = "tasks.db not found (tasks bundle not installed?)";
      return section;
    }

    // "Open" is per-board (Track 0: board_defs carries each board's terminal
    // set; the frozen 'pending'/'in_progress' pair only describes the builtin
    // board). Candidates come from SQL; terminal-ness filters in JS against
    // the resolved per-project sets. "Recently completed" needs no status
    // literal at all — completed_at is stamped exactly on entry into a
    // terminal status, whatever that board calls it.
    const terminalsByProject = new Map();
    try {
      for (const r of (await tdb.execute({ sql: "SELECT project_id, terminal_values FROM board_defs WHERE project_id IS NOT NULL", args: [] })).rows || []) {
        try { terminalsByProject.set(Number(r.project_id), JSON.parse(r.terminal_values).map(String)); } catch { /* corrupt row → legacy */ }
      }
    } catch { /* board_defs absent (pre-0002) → legacy terminals everywhere */ }
    const LEGACY_TERMINALS = ["done", "cancelled"];
    const isOpen = (row) => {
      const terms = (row.project_id != null && terminalsByProject.get(Number(row.project_id))) || LEGACY_TERMINALS;
      return !terms.includes(String(row.status));
    };

    const candidates = await tdb.execute({
      sql: `SELECT id, title, status, priority, due_date, phase, project_id
            FROM tasks_items
            WHERE due_date IS NOT NULL
              AND date(due_date) <= date('now', '+3 days')
            ORDER BY due_date ASC LIMIT 60`,
      args: [],
    });
    const open = { rows: (candidates.rows || []).filter(isOpen).slice(0, 15) };
    const done = await tdb.execute({
      sql: `SELECT id, title, completed_at FROM tasks_items
            WHERE completed_at IS NOT NULL AND completed_at >= datetime('now', '-1 day')
            ORDER BY completed_at DESC LIMIT 10`,
      args: [],
    });

    section.available = true;
    const today = new Date().toISOString().slice(0, 10);
    for (const row of open.rows) {
      const due = String(row.due_date).slice(0, 10);
      const overdue = due < today;
      section.items.push({
        label: row.title,
        detail: `${overdue ? "OVERDUE" : "Due"} ${due}` + (row.phase ? ` · ${row.phase}` : ""),
        meta: `status: ${row.status} · priority ${row.priority}`,
        urgent: overdue,
      });
    }
    if (done.rows.length > 0) {
      section.note = `Completed in the last 24h: ${done.rows.map((r) => r.title).join(", ")}`;
    }
    if (section.items.length === 0 && !section.note) {
      section.note = "No tasks due in the next 3 days.";
    }
  } catch (err) {
    section.available = false;
    section.reason = `tasks unavailable: ${err.message}`;
  } finally {
    try { tdb?.close?.(); } catch { /* ignore */ }
  }
  return section;
}

async function trackersSection(tdb) {
  const section = { title: "Trackers", available: false, items: [], table: null };
  if (!tdb) {
    section.reason = "tasks.db not found (tasks bundle not installed?)";
    return section;
  }
  try {
    const defs = await tdb.execute({
      sql: "SELECT id, slug, display_name FROM board_defs WHERE slug IS NOT NULL ORDER BY slug",
      args: [],
    });
    section.available = true;
    if (defs.rows.length === 0) {
      section.note = "No trackers defined.";
      return section;
    }

    const rows = [];
    for (const def of defs.rows) {
      const counts = await tdb.execute({
        sql: "SELECT status, COUNT(*) AS n FROM tasks_items WHERE board_id = ? GROUP BY status ORDER BY n DESC",
        args: [def.id],
      });
      const countStr = counts.rows.map((r) => `${r.status}: ${r.n}`).join(", ") || "empty";
      rows.push([def.display_name || def.slug, countStr]);

      const action = await tdb.execute({
        sql: `SELECT title, action_needed FROM tasks_items
              WHERE board_id = ? AND action_needed IS NOT NULL AND action_needed != ''
              ORDER BY priority ASC LIMIT 5`,
        args: [def.id],
      });
      for (const item of action.rows) {
        section.items.push({
          label: item.title,
          detail: `Action needed: ${item.action_needed}`,
          meta: `tracker: ${def.slug}`,
          urgent: true,
        });
      }
    }
    section.table = { headers: ["Tracker", "Status counts"], rows };
  } catch (err) {
    section.available = false;
    section.reason = `trackers unavailable: ${err.message}`;
  }
  return section;
}
