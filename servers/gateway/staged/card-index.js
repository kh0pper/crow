/**
 * The open staged drafts, by the card they belong to — the ONE read every surface uses to answer
 * "does this card have a draft waiting for the operator's yes?" (lanes.js `laneOf`'s `staged` flag,
 * the Board's Needs-you lane, the project drawer, the "What needs me" widget, the morning brief,
 * the per-card lane state and the note a document's header shows).
 *
 * Card ids are per tasks store: a project may keep its own tasks.db, so card 7 in that store and
 * card 7 in the instance's store are two different cards. A `staged_sends` row records the id, not
 * the store — but it does record where the draft came from, so a read scoped to a store asks each
 * row which project it belongs to and drops the ones whose project keeps a different store. The
 * provenance rule is the one a waiting session is filed by (routes/perch.js `threadProjects`): the
 * chat's own shell_items row while that project is live, else the bot's live project. It is
 * restated here rather than imported so this module carries no route import (the Board, the widget
 * and the make module all load it).
 *
 * A row with no provenance at all — a channel or job draft with no chat — has nothing to tell one
 * store's card 7 from another's, so it counts in the store being read. That is the one case this
 * cannot settle, and it is the case where there is no second card it could belong to.
 *
 * `sending` is deliberately not an open row here: a send in flight is the gateway's work, not the
 * operator's. `failed` is: the operator has a Retry waiting.
 *
 * Rows are newest first (the store's order), so the FIRST draft stored for a card is its newest
 * open one — the one an item's link points at.
 */
import { resolve } from "node:path";
import { resolveSqlitePath, tasksDbPath } from "../../../scripts/pi-bots/instance-paths.mjs";
import { activeProjects, projectOfItems } from "../../shared/shell-items.js";
import { listStaged } from "./store.js";

/** The states that mean "this draft is waiting on a person" (store.STAGED_OPEN minus `sending`). */
const OPEN_STATES = Object.freeze(["staged", "failed"]);

/**
 * Map<cardId, stagedRowId> of the open drafts belonging to cards in the store being listed.
 * Empty (never null) when nothing is staged, when the table is missing, or when the read fails: a
 * card surface must still draw.
 *
 * `opts.tasksDbPath` is that store (the instance's own by default). Only `db` is read — it is the
 * crow.db client every caller already holds.
 */
export async function stagedCardIds(db, { tasksDbPath: storePath = tasksDbPath() } = {}) {
  const out = new Map();
  if (!db) return out;
  let rows;
  try { rows = await listStaged(db, { states: [...OPEN_STATES] }); } catch { return out; }
  const withCard = rows.filter((r) => r && r.cardId != null);
  if (!withCard.length) return out;
  let foreign;
  try { foreign = await foreignRows(db, withCard, storePath); } catch { foreign = new Set(); }
  for (const row of withCard) {
    if (foreign.has(row.id)) continue;
    const id = Number(row.cardId);
    if (!out.has(id)) out.set(id, String(row.id));
  }
  return out;
}

/** The ids of the rows whose own project keeps a tasks store other than `storePath`. */
async function foreignRows(db, rows, storePath) {
  const owner = await rowProjects(db, rows);
  const projectIds = [...new Set([...owner.values()].filter((p) => p != null))];
  const out = new Set();
  if (!projectIds.length) return out;
  const uriOf = new Map();
  try {
    const { rows: found } = await db.execute({
      sql: "SELECT id, tasks_db_uri FROM project_spaces WHERE id IN (SELECT value FROM json_each(?))",
      args: [JSON.stringify(projectIds)],
    });
    for (const p of found) uriOf.set(Number(p.id), p.tasks_db_uri == null ? null : String(p.tasks_db_uri));
  } catch { return out; } // no project_spaces: every row is in this store
  const mine = resolve(String(storePath));
  for (const [rowId, projectId] of owner) {
    if (projectId == null) continue;
    const uri = uriOf.get(Number(projectId));
    if (uri == null) continue; // the shared store
    const real = resolveSqlitePath(uri);
    if (typeof real === "string" && resolve(real) !== mine) out.add(rowId);
  }
  return out;
}

/**
 * Map<rowId, projectId|null>: the project each row came from, by the waiting-session rule
 * (routes/perch.js `threadProjects`): a chat filed in shell_items uses that project (null while the
 * project is not live, which means Unassigned — the bot fallback is for a chat with no row at all);
 * a chat with no row uses its bot's live project. Without the shell tables every row falls back to
 * its bot's project.
 */
async function rowProjects(db, rows) {
  const out = new Map();
  // A staged row's thread is the gateway thread id; a row with no thread (a bridge or job draft)
  // still has its session id, which is the same thing for a perch-live chat.
  const refOf = (r) => (r.threadId != null ? String(r.threadId) : (r.sessionId != null ? String(r.sessionId) : null));
  const refs = new Map(); // thread ref -> bot id
  for (const r of rows) {
    const ref = refOf(r);
    if (ref && !refs.has(ref)) refs.set(ref, r.botId == null ? null : String(r.botId));
  }
  if (!refs.size) return out;
  const ids = [...refs.keys()];
  let filed = new Map();
  let hasRow = new Set();
  try {
    filed = await projectOfItems(db, "perch_thread", ids);
    const { rows: hits } = await db.execute({
      sql: "SELECT item_ref FROM shell_items WHERE item_kind = 'perch_thread' AND item_ref IN (SELECT value FROM json_each(?))",
      args: [JSON.stringify(ids)],
    });
    hasRow = new Set((hits || []).map((h) => String(h.item_ref)));
  } catch { /* no shell_items table: the bot fallback decides */ }
  const botProject = new Map();
  let live = new Set();
  try {
    const botIds = [...new Set([...refs.values()].filter(Boolean))];
    if (botIds.length) {
      const { rows: defs } = await db.execute({
        sql: "SELECT bot_id, project_id FROM pi_bot_defs WHERE bot_id IN (SELECT value FROM json_each(?))",
        args: [JSON.stringify(botIds)],
      });
      for (const d of defs || []) if (d.project_id != null) botProject.set(String(d.bot_id), Number(d.project_id));
    }
    live = new Set((await activeProjects(db)).map((p) => Number(p.id)));
  } catch { /* no pi_bot_defs / project_spaces: no bot fallback */ }
  for (const r of rows) {
    const ref = refOf(r);
    if (!ref) continue;
    if (hasRow.has(ref)) { out.set(r.id, filed.get(ref) ?? null); continue; }
    const pid = r.botId == null ? null : botProject.get(String(r.botId));
    out.set(r.id, pid != null && live.has(Number(pid)) ? Number(pid) : null);
  }
  return out;
}