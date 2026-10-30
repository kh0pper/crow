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
import { needsYouLabel } from "./needs-you-label.js";
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
  const idOf = (p) => Number(p && typeof p === "object" ? p.id : p);
  // A row that carries tasks_db_uri is trusted; one without the key (e.g. an
  // activeProjects row: id, slug, name) has its store read here, in ONE query,
  // so a project with its own store is never counted against the shared one.
  const lookup = list.filter((p) => !(p && typeof p === "object" && "tasks_db_uri" in p)).map(idOf);
  const uris = new Map();
  if (lookup.length) {
    try {
      const { rows } = await db.execute({
        sql: "SELECT id, tasks_db_uri FROM project_spaces WHERE id IN (SELECT value FROM json_each(?))",
        args: [JSON.stringify(lookup)],
      });
      for (const r of rows) uris.set(Number(r.id), r.tasks_db_uri ?? null);
    } catch { /* no project_spaces: treat as the shared store */ }
  }
  return list.map((p) => (p && typeof p === "object" && "tasks_db_uri" in p
    ? { id: Number(p.id), tasks_db_uri: p.tasks_db_uri ?? null }
    : { id: idOf(p), tasks_db_uri: uris.get(idOf(p)) ?? null }));
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
  let waiting = sessions.filter((s) => s && s.pendingUi && s.state !== "stopped");
  if (!waiting.length) return out;
  let ids = waiting.map((s) => String(s.sessionId));

  // An archived session is put away: it never counts or lists as waiting.
  try {
    const { rows } = await db.execute({
      sql: "SELECT DISTINCT gateway_thread_id FROM bot_sessions WHERE kind='perch-live' AND archived_at IS NOT NULL AND gateway_thread_id IN (SELECT value FROM json_each(?))",
      args: [JSON.stringify(ids)],
    });
    const gone = new Set(rows.map((r) => String(r.gateway_thread_id)));
    if (gone.size) {
      waiting = waiting.filter((s) => !gone.has(String(s.sessionId)));
      ids = waiting.map((s) => String(s.sessionId));
      if (!waiting.length) return out;
    }
  } catch { /* bot_sessions or archived_at absent: nothing is archived */ }

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

const CACHE_MS = 5000;
const CACHE_MAX = 64;
const countCache = new Map(); // key -> { at, entries: [[projectId, count]] }, oldest first

/** Forget every cached count (tests, and anything that must see a change at once). */
export function clearNeedsYouCache() { countCache.clear(); }

/** The number of cached entries (tests). */
export function needsYouCacheSize() { return countCache.size; }

/**
 * @returns {Promise<Map<number, number|null>>} projectId -> count (null: unknown)
 *
 * Cached per process for 5 s, keyed by the sorted project ids and tasksDbPath
 * (the shell asks on every page load). Nothing invalidates it: a card or a
 * session that changes shows in the drawer up to 5 s late, and a different
 * engine or db handle for the same key is not told apart. Pass cacheMs: 0 to
 * bypass; `now` is the clock.
 */
export async function needsYouCounts(db, projects, { engine, tasksDbPath = TASKS_DB, cacheMs = CACHE_MS, now = Date.now } = {}) {
  const list = await asProjects(db, projects);
  const key = list.map((p) => `${p.id}|${p.tasks_db_uri ?? ""}`).sort().join(",") + "@" + tasksDbPath;
  const hit = cacheMs > 0 ? countCache.get(key) : null;
  if (hit) {
    if (now() - hit.at < cacheMs) return withParts(new Map(hit.entries), hit.parts);
    countCache.delete(key); // expired: dropped when read
  }
  const result = await computeCounts(db, list, engine, tasksDbPath);
  if (cacheMs > 0) {
    countCache.set(key, { at: now(), entries: [...result], parts: [...result.parts] });
    while (countCache.size > CACHE_MAX) countCache.delete(countCache.keys().next().value); // oldest first
  }
  return result;
}

/**
 * The count's two halves ride along on the Map as `.parts`: projectId ->
 * { cards, chats } (cards needing you on the Board; waiting chats that hold
 * none of those cards). The shell's Board tab shows `cards`, so its count
 * matches the Board, and the Chat tab shows `chats`. The Map's own values are
 * the totals every other reader already uses.
 */
function withParts(map, parts) {
  map.parts = new Map(parts || []);
  return map;
}

async function computeCounts(db, list, engine, tasksDbPath) {
  const result = withParts(new Map());
  // No tasks.db: nothing has made a card, so a project's count is its waiting
  // sessions alone; a project with its own store is unknown, as everywhere.
  if (!existsSync(tasksDbPath)) {
    const waiting = await waitingByProject(db, engine);
    for (const p of list) {
      const n = inSharedStore(p, tasksDbPath) ? (waiting.get(p.id) || []).length : null;
      result.set(p.id, n);
      if (n != null) result.parts.set(p.id, { cards: 0, chats: n });
    }
    return result;
  }

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
      result.parts.set(p.id, { cards: needs.length, chats: extra });
    }
  } catch (err) {
    console.warn("[needs-you] tasks.db unreadable:", err && err.message);
    for (const p of list) result.set(p.id, null);
    result.parts.clear();
  } finally {
    if (tdb) { try { tdb.close(); } catch { /* already closed */ } }
  }
  return result;
}

export { needsYouLabel };

/** The kind of ask a Needs-you card is, or null when it carries none of the three. */
export function kindOf(c) {
  if (openDecision(c)) return "decision";
  if (c.latest_result_status === "recorded") return "review";
  if (String(c.action_needed ?? "").trim() !== "") return "question";
  return null;
}

/** The project's whole Needs-you lane (Board order), read from an open tasks.db. */
async function needsLane(db, tdb, projectId) {
  const rows = await laneRows(tdb, { projectId: Number(projectId) });
  const lockMap = await lockMapFor(db, rows.map((r) => r.id));
  const defs = await defsFor(tdb, rows);
  return groupByLane(rows, defs, lockMap).needs_you;
}

/**
 * The project's Needs-you items: its cards in the Board's own order, each with
 * the kind of ask (a decision, a review, a question, or null), then its
 * waiting sessions that hold none of those cards (read the way the count reads
 * them), [{ sid }]. At most `limit` items in all, cards first. No tasks.db
 * has no cards, but a project in the shared store still lists its waiting
 * sessions; an own-store project (cards this instance's Board doesn't read)
 * shows nothing at all, cards or sessions.
 */
export async function needsYouItems(db, project, { engine = null, tasksDbPath = TASKS_DB, limit = 3 } = {}) {
  const none = { cards: [], waiting: [] };
  if (!project) return none;
  const shared = inSharedStore(project, tasksDbPath);
  let tdb;
  try {
    let cards = [];
    let held = new Set();
    if (shared && existsSync(tasksDbPath)) {
      tdb = createDbClient(tasksDbPath);
      const needs = await needsLane(db, tdb, project.id);
      held = new Set(needs.map((c) => c.id));
      const top = needs.slice(0, limit);
      const full = await cardsByIds(tdb, top.map((r) => r.id));
      cards = top.map((r) => full.get(r.id)).filter(Boolean).map((c) => ({ ...c, kind: kindOf(c) }));
    }
    const room = Math.max(0, limit - cards.length);
    const waiting = room && shared
      ? ((await waitingByProject(db, engine)).get(Number(project.id)) || [])
        .filter((w) => !(w.cardId != null && held.has(w.cardId))).slice(0, room).map((w) => ({ sid: w.sid }))
      : [];
    return { cards, waiting };
  } catch (err) {
    if (!ABSENT_RE.test(String(err && err.message))) console.warn("[needs-you] items failed:", err && err.message);
    return none;
  } finally {
    if (tdb) { try { tdb.close(); } catch { /* already closed */ } }
  }
}

/** The project's Needs-you cards alone (needsYouItems without its waiting sessions). */
export async function needsYouCards(db, project, { tasksDbPath = TASKS_DB, limit = 3 } = {}) {
  return (await needsYouItems(db, project, { tasksDbPath, limit })).cards;
}
