// servers/gateway/make/card-docs.js — a card's documents, and a document's card (P6).
//
// Three ways a document belongs to a card, read in crow.db (cards themselves live
// in the instance-global tasks.db and are never read here):
//   1. a hand link: shell_items.card_id (setItemCard; also the origin card ensureItem filed)
//   2. the artifact was made on the card: artifacts.origin_card
//   3. the artifact is linked (an active artifact_links row) to a chat whose card is this
//      one. A thread's card is only ever decided by threadCard (newest perch-live session).
// shell_items.card_id is filing, never access. Titles are data: callers escape them, and
// nothing here reads an artifact's content.
import { existsSync } from "node:fs";
import { itemsForCard, getItem, threadCard } from "../../shared/shell-items.js";
import { t, fill } from "../dashboard/shared/i18n.js";
import { createDbClient } from "../../db.js";
import { tasksDbPath } from "../../../scripts/pi-bots/instance-paths.mjs";
import { resolveBoardDef } from "../routes/board-defs.js";
import { lockMapFor } from "../routes/board-lock.js";
import { laneOf } from "../dashboard/panels/board/lanes.js";
import { cardDrawerHref, drawerHref } from "../board/card-link.js";

const noTable = (err) => /no such table/i.test(String(err?.message || err));
async function rowsOf(db, sql, args) {
  try { return (await db.execute({ sql, args })).rows; } catch (err) { if (noTable(err)) return []; throw err; }
}
const num = (v) => (v === null || v === undefined ? null : Number(v));
const openUrl = (kind, ref) => `/dashboard/make/open/${kind}/${encodeURIComponent(String(ref))}`;

/** Live (not deleted) artifacts by id: Map<id, { title, origin_card, origin_session }>. */
async function liveArtifacts(db, ids) {
  if (!ids.length) return new Map();
  const rows = await rowsOf(db,
    `SELECT id, title, origin_card, origin_session FROM artifacts
      WHERE deleted_at IS NULL AND id IN (SELECT value FROM json_each(?))`,
    [JSON.stringify(ids.map(String))]);
  return new Map(rows.map((r) => [String(r.id), r]));
}

/**
 * The artifacts linked to a chat whose card is `cardId`. The SQL only narrows to threads that
 * ever had a perch-live session on the card; threadCard decides each one.
 */
async function chatArtifactIds(db, cardId) {
  const threads = await rowsOf(db,
    `SELECT DISTINCT gateway_thread_id FROM bot_sessions
      WHERE kind = 'perch-live' AND card_id = ? AND gateway_thread_id IS NOT NULL`, [cardId]);
  const out = [];
  for (const { gateway_thread_id: thread } of threads) {
    if ((await threadCard(db, thread)) !== cardId) continue;
    const links = await rowsOf(db,
      `SELECT l.artifact_id FROM artifact_links l JOIN artifacts a ON a.id = l.artifact_id
        WHERE l.thread_id = ? AND l.unlinked_at IS NULL AND a.deleted_at IS NULL
        ORDER BY l.linked_at, l.id`, [String(thread)]);
    for (const l of links) out.push(String(l.artifact_id));
  }
  return out;
}

/**
 * A card's documents: hand links (shell_items), then artifacts made on the card
 * (origin_card), then artifacts linked to its chats; each document once. A deleted or
 * unknown artifact is never listed. A Workspace file's title is "Document <fileId>" (the
 * core keeps no file names). Missing tables read as no documents.
 * @returns {Promise<Array<{ kind: "artifact"|"workspace_file", ref: string, title: string, openUrl: string }>>}
 */
export async function documentsForCard(db, cardId, { lang = "en" } = {}) {
  if (!/^[1-9]\d*$/.test(String(cardId))) return [];
  const id = Number(cardId);
  const refs = [];
  for (const it of await itemsForCard(db, id)) refs.push({ kind: it.kind, ref: String(it.ref) });
  for (const r of await rowsOf(db, "SELECT id FROM artifacts WHERE origin_card = ? AND deleted_at IS NULL ORDER BY created_at, id", [id])) {
    refs.push({ kind: "artifact", ref: String(r.id) });
  }
  for (const ref of await chatArtifactIds(db, id)) refs.push({ kind: "artifact", ref });

  const seen = new Set();
  const unique = refs.filter((d) => { const k = `${d.kind}:${d.ref}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const arts = await liveArtifacts(db, unique.filter((d) => d.kind === "artifact").map((d) => d.ref));
  const out = [];
  for (const d of unique) {
    let title;
    if (d.kind === "artifact") {
      const a = arts.get(d.ref);
      if (!a) continue;
      title = String(a.title ?? "");
    } else {
      title = fill(t("shell.documentNumbered", lang), { id: d.ref });
    }
    out.push({ kind: d.kind, ref: d.ref, title, openUrl: openUrl(d.kind, d.ref) });
  }
  return out;
}

/**
 * The one ordering rule for a document's card: the hand link (shell_items.card_id), then
 * the artifact's origin_card, then the card of the artifact's origin thread (threadCard).
 * Make/sources.js passes the facts it already holds; cardForDocument reads them.
 */
export async function documentCard(db, { handCardId = null, originCard = null, originSession = null } = {}) {
  if (num(handCardId) !== null) return num(handCardId);
  if (num(originCard) !== null) return num(originCard);
  if (originSession) return threadCard(db, originSession);
  return null;
}

/**
 * A document's card, or null. An artifact that is deleted or unknown has none.
 * @param {"artifact"|"workspace_file"} kind
 * @returns {Promise<number|null>}
 */
export async function cardForDocument(db, kind, ref) {
  if (kind !== "artifact" && kind !== "workspace_file") return null;
  const item = await getItem(db, kind, String(ref));
  if (kind === "workspace_file") return item?.cardId ?? null;
  const a = (await liveArtifacts(db, [String(ref)])).get(String(ref));
  if (!a) return null;
  return documentCard(db, { handCardId: item?.cardId, originCard: a.origin_card, originSession: a.origin_session });
}

/** The top-level card's lane columns (laneRows' shape) from tasks.db, or null. */
async function laneRow(tdb, id) {
  const sql = (withResult) => `SELECT t.id, t.title, t.status, t.project_id, t.action_needed, t.data_json${withResult ? ", r.status AS latest_result_status" : ""}
      FROM tasks_items t ${withResult ? "LEFT JOIN board_results r ON r.id = (SELECT id FROM board_results WHERE item_id = t.id ORDER BY id DESC LIMIT 1)" : ""}
     WHERE t.id = ? AND t.board_id IS NULL`;
  try {
    return (await tdb.execute({ sql: sql(true), args: [id] })).rows[0] || null;
  } catch {
    // A pre-0004 store has no board_results: the result status is simply absent (laneRows' rule).
    return (await tdb.execute({ sql: sql(false), args: [id] })).rows[0] || null;
  }
}

/**
 * What a document's header says about its card (P6 Task 6.2), or null when there is no
 * such top-level card (or no tasks.db). Every field is read, never guessed:
 *  - title: the card's title (bot/operator text: callers escape it);
 *  - lane: laneOf over the card's status, latest result, ask and decision, its board def
 *    and whether a session or job holds it (the Board tab's rule); null if any part fails;
 *  - href: cardDrawerHref (the drawer on its own project's card-board bot, else ?card=), sharing this call's tasks.db;
 *  - thread: the card's conversation by the Board tab's rule (threadsByCard), or null.
 * One tasks.db client per call: call it once per request, never in a loop.
 * @returns {Promise<{ id: number, title: string, lane: string|null, href: string, thread: string|null }|null>}
 */
export async function cardSummary(db, cardId, { tasksDb = null } = {}) {
  if (!/^[1-9]\d*$/.test(String(cardId))) return null;
  const id = Number(cardId);
  if (!tasksDb && !existsSync(tasksDbPath())) return null;
  let tdb = tasksDb;
  try {
    tdb ||= createDbClient(tasksDbPath());
    const row = await laneRow(tdb, id);
    if (!row) return null;
    let lane = null;
    try {
      const def = await resolveBoardDef(tdb, { projectId: row.project_id == null ? null : Number(row.project_id) });
      const locked = (await lockMapFor(db, [id])).get(id) === true;
      lane = laneOf(row, def, { locked });
    } catch { lane = null; }
    let href = null;
    try { href = await cardDrawerHref(db, id, { tasksDb: tdb }); } catch { href = null; }
    let thread = null;
    try {
      // Dynamic: panels/board.js reaches bot-board/html.js, which imports this module.
      const { threadsByCard } = await import("../dashboard/panels/board.js");
      thread = (await threadsByCard(db, [id])).get(id) ?? null;
    } catch { thread = null; }
    return { id, title: String(row.title ?? ""), lane, href: href || drawerHref(id, null), thread };
  } catch {
    return null;
  } finally {
    if (!tasksDb) { try { tdb && tdb.close(); } catch { /* already closed */ } }
  }
}
