/**
 * Board tab (redesign P3) — the current shell scope's cards in four lanes:
 * Needs you, Working, Up next, Done. Phone first; each card opens its
 * conversation (or, without one, its classic card view), and a Details link
 * always reaches the full card (plan, results, history) on the classic board.
 *
 * Data: cards come from the instance-global tasks.db only (top-level,
 * unarchived kanban cards); locks, conversations and projects from crow.db.
 * A lane is laneOf() over stored state (panels/board/lanes.js), and the chip
 * counts are laneOf over the SAME rows, never a separate COUNT(*): a count
 * can never disagree with the lane it labels. Rendered rows are capped per
 * lane; counts are not.
 *
 * Lane moves are a later task; edits and the drawer stay on the classic board.
 */

import { existsSync } from "node:fs";
import { createDbClient } from "../../../db.js";
import { t } from "../shared/i18n.js";
import { TASKS_DB, lockMapFor, liveBirdsByCard } from "./bot-board/data-queries.js";
import { resolveBoardDef, DEFAULT_BOARD_DEF } from "../../routes/board-defs.js";
import { activeProjects } from "../../../shared/shell-items.js";
import { getInteractiveEngine } from "../../perch-interactive.js";
import { LANES, groupByLane } from "./board/lanes.js";
import { boardHtml, cardHref } from "./board/html.js";

export { cardHref };
import { boardCss } from "./board/css.js";
import { boardClientJs } from "./board/client.js";

/** Rendered cards per lane; the chip and heading still carry the full count. */
export const LANE_RENDER_CAP = 100;

const TOP_LEVEL = "t.board_id IS NULL AND t.parent_id IS NULL AND t.archived_at IS NULL";

/**
 * The WHERE clause for a scope, by the rule Chat uses (shell-items.js
 * listItemRefs): a card whose project is missing, archived or a learner
 * profile counts as Unassigned, so no card ever vanishes from every scope.
 *   { projectId }  that project's cards
 *   { unassigned } project_id NULL or not a live project (`activeIds`, the
 *                  live ids from activeProjects / ACTIVE_PROJECT_WHERE in
 *                  crow.db; an empty list means every card)
 *   { all }        every card, no project filter
 * Every scope is top-level, unarchived cards only.
 */
function scopeWhere(scope, activeIds = []) {
  if (scope && scope.projectId != null) return { sql: `${TOP_LEVEL} AND t.project_id = ?`, args: [Number(scope.projectId)] };
  if (scope && scope.unassigned) {
    const live = (activeIds || []).map(Number).filter(Number.isInteger);
    if (!live.length) return { sql: TOP_LEVEL, args: [] };
    return { sql: `${TOP_LEVEL} AND (t.project_id IS NULL OR t.project_id NOT IN (${live.map(() => "?").join(",")}))`, args: live };
  }
  return { sql: TOP_LEVEL, args: [] };
}

// The latest board_results row per card: renderKanbanBoard's join, same shape.
const LATEST_RESULT_JOIN = `LEFT JOIN board_results r ON r.id = (
  SELECT id FROM board_results WHERE item_id = t.id ORDER BY id DESC LIMIT 1
)`;

/** id and project_id as Numbers (null project stays null): lock and def maps are keyed by Number. */
function normalize(row) {
  return { ...row, id: Number(row.id), project_id: row.project_id == null ? null : Number(row.project_id) };
}

/**
 * Every card in scope with exactly the columns laneOf (and groupByLane's
 * order) reads. No LIMIT. Without board_results (a pre-0004 store) the
 * result status is simply absent.
 */
export async function laneRows(tdb, scope, { activeIds = [] } = {}) {
  const w = scopeWhere(scope, activeIds);
  let rows;
  try {
    rows = (await tdb.execute({
      sql: `SELECT t.id, t.status, t.priority, t.project_id, t.action_needed, t.data_json,
                   r.status AS latest_result_status
              FROM tasks_items t ${LATEST_RESULT_JOIN}
             WHERE ${w.sql}`,
      args: w.args,
    })).rows || [];
  } catch {
    rows = (await tdb.execute({
      sql: `SELECT t.id, t.status, t.priority, t.project_id, t.action_needed, t.data_json
              FROM tasks_items t WHERE ${w.sql}`,
      args: w.args,
    })).rows || [];
  }
  return rows.map(normalize);
}

/** Map<project_id, def> for every project the rows touch, plus null → the builtin def. */
export async function defsFor(tdb, rows) {
  const defs = new Map([[null, DEFAULT_BOARD_DEF]]);
  for (const pid of new Set(rows.map((r) => r.project_id).filter((p) => p != null))) {
    defs.set(pid, await resolveBoardDef(tdb, { projectId: pid }));
  }
  return defs;
}

function countsOf(byLane) {
  return Object.fromEntries(LANES.map((l) => [l, byLane[l].length]));
}

/**
 * Cards per lane in a scope: laneOf over laneRows, with the caller's lock
 * map (lockMapFor's Map<Number id, boolean>). Never truncated. Same scope
 * SQL as the rendered lanes; { unassigned } needs `opts.activeIds` (the live
 * project ids, activeProjects(db)).
 */
export async function laneCounts(tdb, scope, lockMap, opts = {}) {
  const rows = await laneRows(tdb, scope, opts);
  return countsOf(groupByLane(rows, await defsFor(tdb, rows), lockMap));
}

/** Full card rows (the face's columns + latest result) for the given ids. */
async function cardsByIds(tdb, ids) {
  if (!ids.length) return new Map();
  const ph = ids.map(() => "?").join(",");
  let rows;
  try {
    rows = (await tdb.execute({
      sql: `SELECT t.*, r.id AS latest_result_id, r.outcome AS latest_result_outcome, r.status AS latest_result_status
              FROM tasks_items t ${LATEST_RESULT_JOIN} WHERE t.id IN (${ph})`,
      args: ids,
    })).rows || [];
  } catch {
    rows = (await tdb.execute({ sql: `SELECT t.* FROM tasks_items t WHERE t.id IN (${ph})`, args: ids })).rows || [];
  }
  return new Map(rows.map((r) => { const n = normalize(r); return [n.id, n]; }));
}

/**
 * Map<cardId, gateway_thread_id>: each card's kind='perch-live' conversation
 * (unarchived first, then newest). bot_sessions absent → empty (every card opens its details).
 */
export async function threadsByCard(db, ids) {
  const out = new Map();
  if (!ids.length) return out;
  try {
    // An unarchived conversation wins over a newer archived one; within
    // each, the newest. A store without bot_sessions.archived_at (pre-0006)
    // orders by id alone.
    const where = `kind = 'perch-live' AND gateway_thread_id IS NOT NULL AND gateway_thread_id != ''
               AND card_id IN (${ids.map(() => "?").join(",")})`;
    let rows;
    try {
      rows = (await db.execute({
        sql: `SELECT card_id, gateway_thread_id FROM bot_sessions WHERE ${where} ORDER BY (archived_at IS NULL) DESC, id DESC`,
        args: ids,
      })).rows;
    } catch {
      rows = (await db.execute({
        sql: `SELECT card_id, gateway_thread_id FROM bot_sessions WHERE ${where} ORDER BY id DESC`,
        args: ids,
      })).rows;
    }
    for (const r of rows || []) {
      const cid = Number(r.card_id);
      if (!out.has(cid)) out.set(cid, String(r.gateway_thread_id));
    }
  } catch { /* bot_sessions absent: no conversations */ }
  return out;
}

/**
 * Everything the page draws, or an empty board. tasks.db absent is normal
 * (nothing has made a card yet): it is never opened, so never created.
 */
async function loadBoard(db, scope, engine) {
  const empty = { counts: countsOf(Object.fromEntries(LANES.map((l) => [l, []]))), lanes: Object.fromEntries(LANES.map((l) => [l, []])), defs: new Map([[null, DEFAULT_BOARD_DEF]]), lockMap: new Map(), threads: new Map(), birds: new Map() };
  if (!existsSync(TASKS_DB)) return empty;
  let tdb;
  try {
    tdb = createDbClient(TASKS_DB);
    const activeIds = scope && scope.unassigned ? (await activeProjects(db)).map((p) => p.id) : [];
    const rows = await laneRows(tdb, scope, { activeIds });
    const lockMap = await lockMapFor(db, rows.map((r) => r.id));
    const defs = await defsFor(tdb, rows);
    const grouped = groupByLane(rows, defs, lockMap);
    const counts = countsOf(grouped);
    const shownIds = LANES.flatMap((l) => grouped[l].slice(0, LANE_RENDER_CAP).map((r) => r.id));
    const full = await cardsByIds(tdb, shownIds);
    const lanes = Object.fromEntries(LANES.map((l) => [l, grouped[l].slice(0, LANE_RENDER_CAP).map((r) => full.get(r.id)).filter(Boolean)]));
    const threads = await threadsByCard(db, shownIds);
    const birds = await liveBirdsByCard(engine, db);
    return { counts, lanes, defs, lockMap, threads, birds };
  } catch (err) {
    if (!/no such table/i.test(String(err && err.message))) console.warn("[board] load failed:", err && err.message);
    return empty;
  } finally {
    if (tdb) { try { tdb.close(); } catch { /* already closed */ } }
  }
}

export default {
  id: "board",
  name: "Board",
  icon: "kanban",
  route: "/dashboard/board",
  navOrder: 16,
  category: "tools",
  hidden: true, // the new shell's Board tab; the classic nav keeps the Bot Board

  async handler(req, res, { db, layout, lang, engine = getInteractiveEngine({ createIfMissing: false }) }) {
    const scope = req.crowScope || { all: true };
    const board = await loadBoard(db, scope, engine);
    return layout({
      title: t("shell.tabBoard", lang),
      content: boardCss() + boardHtml(board, lang) + boardClientJs(),
    });
  },
};
