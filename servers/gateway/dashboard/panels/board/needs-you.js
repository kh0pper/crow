/**
 * The one "N need you" count the project drawer, the project home and the
 * Board badge share. A project's number is its Needs-you lane (the Board's own
 * laneOf, through the project's own board def) plus the Perch sessions waiting
 * on a person that are filed under it and don't already hold one of those cards.
 *
 * null means "unknown", never zero: a project whose cards live in a store this
 * instance's Board doesn't read, or a tasks.db that exists but can't be read.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createDbClient } from "../../../../db.js";
import { resolveSqlitePath } from "../../../../../scripts/pi-bots/instance-paths.mjs";
import { t } from "../../shared/i18n.js";
import { TASKS_DB, lockMapFor } from "../bot-board/data-queries.js";
import { threadProjects } from "../../../routes/perch.js";
import { laneRows, defsFor, cardsByIds } from "../board.js";
import { groupByLane, openDecision } from "./lanes.js";

const ABSENT_RE = /no such table/i;

/** True when the project keeps its cards in the store the Board reads. */
function inSharedStore(project, tasksDbPath) {
  const uri = project && project.tasks_db_uri;
  if (!uri) return true;
  const real = resolveSqlitePath(String(uri));
  return typeof real === "string" && resolve(real) === resolve(tasksDbPath);
}

async function asProjects(db, projects) {
  const list = [...(projects || [])];
  const out = [];
  for (const p of list) {
    if (p && typeof p === "object") { out.push({ id: Number(p.id), tasks_db_uri: p.tasks_db_uri ?? null }); continue; }
    let uri = null;
    try {
      const { rows } = await db.execute({ sql: "SELECT tasks_db_uri FROM project_spaces WHERE id = ?", args: [Number(p)] });
      uri = rows[0] ? rows[0].tasks_db_uri : null;
    } catch { /* no project_spaces: treat as the shared store */ }
    out.push({ id: Number(p), tasks_db_uri: uri });
  }
  return out;
}

/**
 * Map<projectId, [{ sid, cardId }]> of engine sessions waiting on a person, read
 * the way /roost reads them (routes/perch.js): the filing comes from
 * threadProjects (an unfiled thread falls back to its bot's live project), and a
 * session's card is the live bot_sessions row's card_id first, then the engine's.
 */
async function waitingByProject(db, engine) {
  const out = new Map();
  if (!engine) return out;
  let sessions = [];
  try { sessions = (await engine.list()) || []; } catch { return out; }
  const waiting = sessions.filter((s) => s && s.pendingUi && s.state !== "stopped");
  if (!waiting.length) return out;
  const ids = waiting.map((s) => String(s.sessionId));

  const rowCard = new Map();
  try {
    const { rows } = await db.execute({
      sql: `SELECT gateway_thread_id, card_id FROM bot_sessions WHERE kind='perch-live' AND status != 'stopped' AND gateway_thread_id IN (SELECT value FROM json_each(?))`,
      args: [JSON.stringify(ids)],
    });
    for (const r of rows) rowCard.set(String(r.gateway_thread_id), r.card_id);
  } catch { /* bot_sessions absent: the engine's card ids stand */ }

  const botIdOf = new Map(waiting.map((s) => [String(s.sessionId), s.botId]));
  const botProjectOf = new Map();
  try {
    const { rows } = await db.execute("SELECT bot_id, project_id FROM pi_bot_defs");
    for (const r of rows) botProjectOf.set(r.bot_id, r.project_id == null ? null : Number(r.project_id));
  } catch { /* pi_bot_defs absent: no bot fallback */ }
  let filed = new Map();
  try { filed = await threadProjects(db, ids, botIdOf, botProjectOf); }
  catch (err) { console.warn("[needs-you] could not read thread projects:", err?.message || err); return out; }

  for (const s of waiting) {
    const sid = String(s.sessionId);
    const pid = filed.get(sid);
    if (pid == null) continue;
    const dbCard = rowCard.get(sid);
    const raw = dbCard != null ? dbCard : s.cardId;
    if (!out.has(pid)) out.set(pid, []);
    out.get(pid).push({ sid, cardId: raw == null ? null : Number(raw) });
  }
  return out;
}

/**
 * @returns {Promise<Map<number, number|null>>} projectId -> count (null: unknown)
 */
export async function needsYouCounts(db, projects, { engine, tasksDbPath = TASKS_DB } = {}) {
  const list = await asProjects(db, projects);
  const result = new Map();
  // No tasks.db: nothing has made a card, so every count is 0. Waiting sessions are
  // skipped on purpose here (the brief says 0), not an oversight.
  if (!existsSync(tasksDbPath)) { for (const p of list) result.set(p.id, 0); return result; }

  let tdb;
  try {
    tdb = createDbClient(tasksDbPath);
    const shared = [];
    for (const p of list) {
      if (inSharedStore(p, tasksDbPath)) shared.push(p); else result.set(p.id, null);
    }

    const rowsBy = new Map();
    const all = [];
    for (const p of shared) {
      let rows;
      try { rows = await laneRows(tdb, { projectId: p.id }); }
      catch (err) { if (ABSENT_RE.test(String(err && err.message))) rows = []; else throw err; }
      rowsBy.set(p.id, rows);
      all.push(...rows);
    }
    const lockMap = await lockMapFor(db, all.map((r) => r.id));
    const defs = await defsFor(tdb, all);
    const waiting = await waitingByProject(db, engine);
    for (const p of shared) {
      const needs = groupByLane(rowsBy.get(p.id), defs, lockMap).needs_you;
      const held = new Set(needs.map((c) => c.id));
      const extra = (waiting.get(p.id) || []).filter((w) => !(w.cardId != null && held.has(w.cardId))).length;
      result.set(p.id, needs.length + extra);
    }
  } catch (err) {
    console.warn("[needs-you] tasks.db unreadable:", err && err.message);
    for (const p of list) result.set(p.id, null);
  } finally {
    if (tdb) { try { tdb.close(); } catch { /* already closed */ } }
  }
  return result;
}

/** The "N need you" text for a count: null for 0, "?" for unknown. */
export function needsYouLabel(n, lang = "en") {
  if (n === null || n === undefined) return "?";
  if (!n) return null;
  return t("shell.needYou", lang).replace("{n}", String(n));
}

/**
 * The project's Needs-you cards in the Board's own order, each with the kind
 * of ask: a decision (open decision), a review (recorded result) or a question.
 * An own-store project, or no tasks.db, has none to show here.
 */
export async function needsYouCards(db, project, { tasksDbPath = TASKS_DB, limit = 3 } = {}) {
  if (!project || !inSharedStore(project, tasksDbPath) || !existsSync(tasksDbPath)) return [];
  let tdb;
  try {
    tdb = createDbClient(tasksDbPath);
    const rows = await laneRows(tdb, { projectId: Number(project.id) });
    const lockMap = await lockMapFor(db, rows.map((r) => r.id));
    const defs = await defsFor(tdb, rows);
    const top = groupByLane(rows, defs, lockMap).needs_you.slice(0, limit);
    const full = await cardsByIds(tdb, top.map((r) => r.id));
    return top.map((r) => full.get(r.id)).filter(Boolean).map((c) => ({
      ...c,
      kind: openDecision(c) ? "decision" : c.latest_result_status === "recorded" ? "review" : "question",
    }));
  } catch (err) {
    if (!ABSENT_RE.test(String(err && err.message))) console.warn("[needs-you] cards failed:", err && err.message);
    return [];
  } finally {
    if (tdb) { try { tdb.close(); } catch { /* already closed */ } }
  }
}
