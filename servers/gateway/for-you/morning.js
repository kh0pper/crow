/**
 * For You's "Your morning" card (For You v1): facts from rows, each linked to its item. No model
 * reads or writes anything here, and nothing is written (the page GET is prefetched by Turbo).
 *
 *   needs     the Board's Needs-you lane across Everything (laneRows {all} + groupByLane, the
 *             Board's own rule and order), total and the first NEEDS_LINES cards.
 *   due       open cards (not terminal on their own board) due today or earlier in the instance's
 *             time zone, earliest first, not already listed under needs.
 *   finished  results bots (not people) reported in the last FINISHED_HOURS, newest first, one
 *             per card, with the bot's name.
 *   leftOff   "where you left off": perch/briefing.js's newest summarized session, on the project
 *             that has it; null when CROW_SESSION_BRIEFING=0 or no session has a summary. Only the
 *             session's label (or bot name) is shown, never its model-written summary.
 *
 * Cards live in the instance-global tasks.db; a project with its own store is not read (as on the
 * Board). A missing tasks.db is an empty morning; an unreadable one costs its lines, never the page.
 */
import { existsSync } from "node:fs";
import { createDbClient } from "../../db.js";
import { TASKS_DB, lockMapFor } from "../dashboard/panels/bot-board/data-queries.js";
import { laneRows, defsFor, cardsByIds, threadsByCard, cardHref } from "../dashboard/panels/board.js";
import { groupByLane } from "../dashboard/panels/board/lanes.js";
import { kindOf } from "../dashboard/panels/board/needs-you.js";
import { drawerHrefs } from "../board/card-link.js";
import { buildBriefing, briefingEnabled } from "../perch/briefing.js";
import { localYmd } from "../../shared/relative-dates.js";

export const NEEDS_LINES = 3;
export const DUE_LINES = 2;
export const FINISHED_LINES = 2;
export const FINISHED_HOURS = 24;
const ABSENT_RE = /no such (table|column)/i;

const oneLine = (s) => String(s ?? "").replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
const sqliteTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const pad = (n) => String(n).padStart(2, "0");

async function rowsOrEmpty(db, q) {
  try { return (await db.execute(q)).rows || []; } catch (err) {
    if (ABSENT_RE.test(String(err && err.message))) return [];
    throw err;
  }
}

/** Map<cardId, href>: the Board's own "open this card" link, a conversation first (cardHref). */
async function linksFor(db, cards, slugByProject) {
  let threads = new Map(), hrefs = new Map();
  try {
    threads = await threadsByCard(db, cards.map((c) => Number(c.id)));
    hrefs = await drawerHrefs(db, cards.map((c) => ({ id: c.id, project_id: c.project_id })));
  } catch (err) { console.warn("[for-you] card links failed:", err && err.message); }
  return new Map(cards.map((c) => [Number(c.id), cardHref(c, threads, hrefs, slugByProject)]));
}

/** Map<botId, display name> for the given ids. */
async function botNames(db, ids) {
  const out = new Map();
  if (!ids.length) return out;
  for (const r of await rowsOrEmpty(db, { sql: "SELECT bot_id, display_name FROM pi_bot_defs WHERE bot_id IN (SELECT value FROM json_each(?))", args: [JSON.stringify(ids)] })) {
    out.set(String(r.bot_id), oneLine(r.display_name || r.bot_id));
  }
  return out;
}

/** The project holding the newest summarized Perch session, or null. */
async function newestSummaryProject(db) {
  const rows = await rowsOrEmpty(db, {
    sql: `SELECT s.project_id FROM bot_sessions b
            JOIN shell_items s ON s.item_kind = 'perch_thread' AND s.item_ref = b.gateway_thread_id
           WHERE b.kind = 'perch-live' AND s.project_id IS NOT NULL
             AND b.summary IS NOT NULL AND trim(b.summary) != '' AND b.summary_at IS NOT NULL
           ORDER BY b.summary_at DESC, b.id DESC LIMIT 1`,
    args: [],
  });
  return rows[0] ? Number(rows[0].project_id) : null;
}

async function leftOffLine(db, projectsById, opts) {
  if (!briefingEnabled()) return null;
  const pid = await newestSummaryProject(db);
  if (pid == null || !projectsById.has(pid)) return null;
  const b = await buildBriefing(db, pid, opts);
  const s = b.summaries[0];
  if (!s || !b.project) return null;
  const slug = b.project.slug;
  return {
    title: s.label || s.botName || "",
    project: b.project.name,
    href: s.openable
      ? `/dashboard/perch?project=${encodeURIComponent(slug)}#${encodeURIComponent(s.threadId)}`
      : `/dashboard/project/${encodeURIComponent(slug)}`,
  };
}

/**
 * Everything the card draws.
 * @param db crow.db client
 * @param opts.projects activeProjects rows ({ id, slug, name }); names and links come from these
 * @param opts.tz the instance time zone (schedule-store instanceZone)
 */
export async function loadMorning(db, { projects = [], tz, now = Date.now(), tasksDbPath = TASKS_DB } = {}) {
  const projectsById = new Map(projects.map((p) => [Number(p.id), p]));
  const slugByProject = new Map(projects.map((p) => [Number(p.id), String(p.slug)]));
  const nameOf = (pid) => (pid != null && projectsById.has(Number(pid)) ? String(projectsById.get(Number(pid)).name) : null);
  const out = { needs: { total: 0, items: [] }, due: { total: 0, items: [] }, finished: { total: 0, items: [] }, leftOff: null };

  if (existsSync(tasksDbPath)) {
    let tdb;
    try {
      tdb = createDbClient(tasksDbPath);
      // Needs you: the Board's Everything lane.
      const rows = await laneRows(tdb, { all: true });
      const defs = await defsFor(tdb, rows);
      const lockMap = await lockMapFor(db, rows.map((r) => r.id));
      const needs = groupByLane(rows, defs, lockMap).needs_you;
      out.needs.total = needs.length;
      const listed = new Set();
      const top = await cardsByIds(tdb, needs.slice(0, NEEDS_LINES).map((r) => r.id));
      const needCards = needs.slice(0, NEEDS_LINES).map((r) => top.get(r.id)).filter(Boolean);

      // Due today or earlier, not done on its own board. The terminal statuses of every board
      // the due cards sit on are excluded IN the query (done cards are never archived on their
      // own, so a filter after a LIMIT would starve on a mature board), and the total is a COUNT.
      const { y, m, d } = localYmd(now, tz);
      const today = `${y}-${pad(m)}-${pad(d)}`;
      const DUE_WHERE = `board_id IS NULL AND parent_id IS NULL AND archived_at IS NULL
                 AND due_date IS NOT NULL AND trim(due_date) != '' AND substr(due_date, 1, 10) <= ?`;
      const duePids = (await rowsOrEmpty(tdb, { sql: `SELECT DISTINCT project_id FROM tasks_items WHERE ${DUE_WHERE}`, args: [today] }))
        .map((r) => ({ project_id: r.project_id == null ? null : Number(r.project_id) }));
      const dueDefs = await defsFor(tdb, duePids);
      const terminal = [];
      for (const { project_id: pid } of [...duePids, { project_id: null }]) {
        const def = dueDefs.get(pid) || dueDefs.get(null);
        for (const st of def.terminal_values) terminal.push({ p: pid, s: String(st) });
      }
      const NOT_DONE = `AND NOT EXISTS (SELECT 1 FROM json_each(?) j
                 WHERE json_extract(j.value, '$.p') IS tasks_items.project_id AND json_extract(j.value, '$.s') = tasks_items.status)`;
      const dueArgs = [today, JSON.stringify(terminal)];
      out.due.total = Number((await rowsOrEmpty(tdb, { sql: `SELECT COUNT(*) AS n FROM tasks_items WHERE ${DUE_WHERE} ${NOT_DONE}`, args: dueArgs }))[0]?.n || 0);
      const due = (await rowsOrEmpty(tdb, {
        sql: `SELECT id, title, status, project_id, due_date FROM tasks_items WHERE ${DUE_WHERE} ${NOT_DONE}
               ORDER BY substr(due_date, 1, 10), priority, id LIMIT ?`,
        args: [...dueArgs, DUE_LINES + NEEDS_LINES],
      })).map((r) => ({ ...r, id: Number(r.id), project_id: r.project_id == null ? null : Number(r.project_id) }));

      // Finished by bots since yesterday: one line per card, newest first.
      const fin = await rowsOrEmpty(tdb, {
        sql: `SELECT r.item_id, r.actor_id, r.outcome, r.created_at, t.title, t.project_id
                FROM board_results r JOIN tasks_items t ON t.id = r.item_id
               WHERE r.actor_kind != 'human' AND r.created_at > ? AND t.board_id IS NULL AND t.archived_at IS NULL
               ORDER BY r.created_at DESC, r.id DESC LIMIT 100`,
        args: [sqliteTime(now - FINISHED_HOURS * 3600000)],
      });
      const seen = new Set();
      const finished = fin.filter((r) => { const k = Number(r.item_id); if (seen.has(k)) return false; seen.add(k); return true; });
      out.finished.total = finished.length;

      for (const c of needCards) listed.add(Number(c.id));
      const dueTop = due.filter((r) => !listed.has(r.id)).slice(0, DUE_LINES);
      const finTop = finished.slice(0, FINISHED_LINES).map((r) => ({ ...r, id: Number(r.item_id), project_id: r.project_id == null ? null : Number(r.project_id) }));
      const links = await linksFor(db, [...needCards, ...dueTop, ...finTop], slugByProject);
      const names = await botNames(db, [...new Set(finTop.map((r) => r.actor_id).filter(Boolean).map(String))]);

      out.needs.items = needCards.map((c) => ({ title: oneLine(c.title), project: nameOf(c.project_id), kind: kindOf(c), href: links.get(Number(c.id)) }));
      out.due.items = dueTop.map((r) => ({ title: oneLine(r.title), project: nameOf(r.project_id), overdue: String(r.due_date).slice(0, 10) < today, href: links.get(r.id) }));
      out.finished.items = finTop.map((r) => ({
        title: oneLine(r.title), project: nameOf(r.project_id), outcome: String(r.outcome),
        bot: r.actor_id ? names.get(String(r.actor_id)) || oneLine(r.actor_id) : null, href: links.get(r.id),
      }));
    } catch (err) {
      console.warn("[for-you] morning board read failed:", err && err.message);
    } finally {
      if (tdb) { try { tdb.close(); } catch { /* already closed */ } }
    }
  }

  try { out.leftOff = await leftOffLine(db, projectsById, { tasksDbPath }); }
  catch (err) { console.warn("[for-you] where you left off failed:", err && err.message); }
  return out;
}
