/**
 * Give service — "put this card on that bot's board", in one place.
 *
 * The dashboard's "Give to…" route (POST /cards/:id/give) and its
 * "Give <Name> a task" route (POST /bots/:id/tasks) used to carry this logic
 * inline; the board dispatch verb needs exactly the same checks and writes,
 * so the core lives here and every caller passes WHO is acting:
 *
 *   - the card write and every child write record `actor` (the dashboard
 *     passes its human actor; a bot caller passes the bot), and
 *   - the card_given audit row records `audit.actor_type` / `audit.actor_id`
 *     ("local" for the dashboard, "bot" + the bot's id for a bot).
 *
 * Refusals are thrown in card-service's `{code, http}` shape, with the codes
 * the dashboard route has always returned: not_found 404, bad_request 400 (a
 * tracker item, or a subtask: it lives in its parent's project), archived
 * 409, locked 409 (with `.rail`), bot_unavailable 400, no_board 409,
 * finished 409. Nothing is written until every check passes.
 *
 * Starting a session after a give stays in the route (it needs the
 * interactive engine); this service never starts anything.
 */

import { updateCard } from "./card-service.js";
import { lockState } from "../routes/board-lock.js";
import { resolveBoardDef, isTerminal } from "../routes/board-defs.js";
import { boardState } from "../dashboard/shared/bot-display.js";
import { assertProjectExists, appendAudit } from "../../shared/project-acl.js";
import { isVoiceBotId } from "../../shared/voice-bot.js";

function fail(message, code, http, extra) {
  return Object.assign(new Error(message), { code, http }, extra || {});
}

/** The bot's pi_bot_defs row, or null. */
export async function loadBotRow(cdb, botId) {
  const { rows } = await cdb.execute({
    sql: "SELECT bot_id, display_name, definition, enabled, project_id FROM pi_bot_defs WHERE bot_id=?",
    args: [botId],
  });
  return rows[0] || null;
}

/** Give target check: the bot exists and is enabled (else 400
 * bot_unavailable), and it has a board a card can go on — kanban/task-list
 * with a linked, live project (boardState() "on", the SAME predicate the
 * Bot Builder and the Bot Board render with, so the gate and the UI cannot
 * drift). Anything else — type none, no project, a custom tracker (a card
 * cannot go onto a tracker board), an archived or missing project — is 409
 * no_board. Returns the bot row. */
export async function loadGiveTarget(cdb, botId) {
  const row = await loadBotRow(cdb, botId);
  if (!row || !Number(row.enabled) || isVoiceBotId(row.bot_id)) throw fail("bot unavailable", "bot_unavailable", 400);
  if (boardState(row).state !== "on") throw fail("bot has no board", "no_board", 409);
  try {
    await assertProjectExists(cdb, Number(row.project_id));
  } catch {
    throw fail("bot's board project is gone or archived", "no_board", 409);
  }
  return row;
}

/** One card_given audit row on the bot's project. `extra` is merged into the
 * payload after bot_id; `actor_type` defaults to "local" (the dashboard). */
export function giveAudit(cdb, row, cardId, extra, { actor_type = "local", actor_id = null } = {}) {
  return appendAudit(cdb, {
    project_id: Number(row.project_id), actor_type, actor_id, action: "card_given",
    target: `card:${cardId}`, payload: { bot_id: String(row.bot_id), ...extra },
  });
}

/** The card's row for a give: exists, is a CARD (`board_id IS NULL`), not
 * archived. */
export async function loadGivableCard(tdb, cardId) {
  const row = (await tdb.execute({
    sql: "SELECT id, board_id, archived_at, parent_id, project_id, status FROM tasks_items WHERE id=?",
    args: [cardId],
  })).rows[0];
  if (!row) throw fail("card not found", "not_found", 404);
  if (row.board_id != null) throw fail("not a card", "bad_request", 400);
  if (row.archived_at != null) throw fail("card is archived", "archived", 409);
  return row;
}

/** Giving a parent carries its subtree: card-service keeps a child in its
 * parent's project (createCard/updateCard re-inherit it), so a parent moved
 * alone would leave its children on no board anyone renders. Every live
 * (non-archived) descendant moves to `projectId`, one updateCard (one
 * board_mutations row) each, recorded as `actor` — card-service has no
 * transaction primitive, and each write is independently valid.
 * `childFields` (only CHILD_FIELDS) ride in the same write. Archived
 * descendants (and anything under them) stay put. Returns how many moved. */
async function moveDescendants(tdb, parentId, projectId, actor, childFields) {
  const seen = new Set([parentId]);
  let frontier = [parentId], n = 0;
  while (frontier.length) {
    const { rows } = await tdb.execute({
      sql: `SELECT id FROM tasks_items WHERE parent_id IN (${frontier.map(() => "?").join(",")}) AND board_id IS NULL AND archived_at IS NULL`,
      args: frontier,
    });
    frontier = [];
    for (const r of rows) {
      const id = Number(r.id);
      if (seen.has(id)) continue;
      seen.add(id);
      await updateCard(tdb, id, { ...childFields, project_id: projectId }, actor);
      frontier.push(id);
      n++;
    }
  }
  return n;
}

/** The only extraFields that also reach the child writes: a child is moved
 * with its parent, never assigned, reparented or put on another project. */
const CHILD_FIELDS = ["autonomy"];

/** The audit row's actor. An explicit audit.actor_type wins; otherwise it
 * follows the card actor: a bot is audited as itself ("bot" + its id), a
 * human as "local" (the dashboard). Any other actor kind must say how it is
 * audited, so a non-human caller can never be audited as the operator. */
function resolveAuditActor(actor, audit) {
  if (audit.actor_type) return { actor_type: audit.actor_type, actor_id: audit.actor_id ?? null };
  const kind = actor?.kind ?? "human";
  if (kind === "bot") return { actor_type: "bot", actor_id: audit.actor_id ?? actor?.id ?? null };
  if (kind === "human") return { actor_type: "local", actor_id: audit.actor_id ?? null };
  throw fail(`no audit actor_type for a ${kind} actor`, "bad_request", 400);
}

/**
 * Every give check, in giveCard's order, with nothing written: a live card
 * (404/400/409 archived), top level (400 bad_request), not locked (409
 * locked, `.rail` set), the bot can take it (400 bot_unavailable / 409
 * no_board), not finished (409 finished). Exported so a caller that must
 * write something of its own first (the dispatch verb's claim) can refuse
 * before that write; giveCard runs it again at write time.
 * @returns {Promise<{cur, row, projectId:number}>}
 */
export async function checkGive(tdb, cdb, cardId, botId) {
  const cur = await loadGivableCard(tdb, cardId);
  // A subtask lives in its parent's project — give the parent instead.
  if (cur.parent_id != null) throw fail("a subtask cannot be given on its own", "bad_request", 400);
  const lock = await lockState(cdb, cardId);
  if (lock.locked) throw fail("card is locked", "locked", 409, { rail: lock.rail });
  const row = await loadGiveTarget(cdb, botId);
  const projectId = Number(row.project_id);
  // A finished card is not a task to give: terminal per the TARGET board's
  // definition or the card's CURRENT one (each the builtin default when the
  // board has none — an unassigned card's case).
  const finished = isTerminal(await resolveBoardDef(tdb, { projectId }), cur.status)
    || isTerminal(await resolveBoardDef(tdb, { projectId: cur.project_id }), cur.status);
  if (finished) throw fail("card is finished", "finished", 409);
  return { cur, row, projectId };
}

/**
 * Give an existing top-level card to a bot.
 *
 * Checks, in order: a live card (404/400/409 archived), top level (400
 * bad_request), not locked by a session or job (409 locked, `.rail` set),
 * the bot can take it (400 bot_unavailable / 409 no_board), not finished
 * (409 finished: terminal per the TARGET board's definition or the card's
 * CURRENT one). Then ONE updateCard write (project_id + assigned_bot +
 * `extraFields`, one board_mutations row), the live subtree moved with it
 * (each child gets only the CHILD_FIELDS of `extraFields`), and one
 * card_given audit row (with a children count when any moved).
 *
 * @param tdb tasks.db client; @param cdb crow.db client
 * @param {object} o
 * @param {number} o.cardId
 * @param {string} o.botId
 * @param {{kind,id,jobId}} o.actor recorded on every board_mutations row
 * @param {{actor_type?:string, actor_id?:string|null, extra?:object}} [o.audit]
 *   actor_type defaults from `actor` (resolveAuditActor)
 * @param {object} [o.extraFields] more card fields for the same write
 * @returns {Promise<{row, projectId:number, children:number}>}
 */
export async function giveCard(tdb, cdb, { cardId, botId, actor, audit = {}, extraFields = {} }) {
  const auditActor = resolveAuditActor(actor, audit);
  const { row, projectId } = await checkGive(tdb, cdb, cardId, botId);

  // parent_id never rides along: a given card stays top level.
  const { parent_id: _ignored, ...fields } = extraFields || {};
  const childFields = {};
  for (const k of CHILD_FIELDS) if (Object.prototype.hasOwnProperty.call(fields, k)) childFields[k] = fields[k];
  await updateCard(tdb, cardId, { ...fields, project_id: projectId, assigned_bot: botId }, actor);
  const children = await moveDescendants(tdb, cardId, projectId, actor, childFields);
  await giveAudit(cdb, row, cardId, { ...(audit.extra || {}), ...(children ? { children } : {}) }, auditActor);
  return { row, projectId, children };
}
