/**
 * Digest adapter — local boards.
 *
 * Reads (1) the kanban tasks DB (tasks bundle: tasks_items in
 * $CROW_TASKS_DB_PATH → $CROW_DATA_DIR/tasks.db) for open items that are
 * due soon / overdue / recently completed, and (2) crow.db's Bot Board
 * trackers (tracker_defs/tracker_items) for per-tracker status counts and
 * action_needed items.
 *
 * Degrades gracefully: absent DBs or tables simply mark their section
 * unavailable — the digest never throws from here.
 */

import { createTasksDbClient } from "../../db.js";

export async function boardsSections(db, config) {
  const sections = [];
  sections.push(await kanbanSection(config));
  sections.push(await trackersSection(db));
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

    const open = await tdb.execute({
      sql: `SELECT id, title, status, priority, due_date, phase
            FROM tasks_items
            WHERE status IN ('pending','in_progress') AND due_date IS NOT NULL
              AND date(due_date) <= date('now', '+3 days')
            ORDER BY due_date ASC LIMIT 15`,
      args: [],
    });
    const done = await tdb.execute({
      sql: `SELECT id, title, completed_at FROM tasks_items
            WHERE status = 'done' AND completed_at >= datetime('now', '-1 day')
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

async function trackersSection(db) {
  const section = { title: "Trackers", available: false, items: [], table: null };
  try {
    const defs = await db.execute({
      sql: "SELECT id, slug, display_name FROM tracker_defs ORDER BY slug",
      args: [],
    });
    section.available = true;
    if (defs.rows.length === 0) {
      section.note = "No trackers defined.";
      return section;
    }

    const rows = [];
    for (const def of defs.rows) {
      const counts = await db.execute({
        sql: "SELECT status, COUNT(*) AS n FROM tracker_items WHERE tracker_id = ? GROUP BY status ORDER BY n DESC",
        args: [def.id],
      });
      const countStr = counts.rows.map((r) => `${r.status}: ${r.n}`).join(", ") || "empty";
      rows.push([def.display_name || def.slug, countStr]);

      const action = await db.execute({
        sql: `SELECT label, action_needed FROM tracker_items
              WHERE tracker_id = ? AND action_needed IS NOT NULL AND action_needed != ''
              ORDER BY priority ASC LIMIT 5`,
        args: [def.id],
      });
      for (const item of action.rows) {
        section.items.push({
          label: item.label,
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
