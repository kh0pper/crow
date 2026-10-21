/**
 * Dispatch service — the board_dispatch_item verb: a signed bot hands one of
 * its own top-level cards to another bot.
 *
 * What this protects (see the private engineering notes): a bot cannot move
 * the operator's own card objects, or cards the operator granted, to a bot of
 * its choosing. It does not stop a bot routing work in general — any bot can
 * already create a new card assigned to an enabled bot.
 *
 * Rules, checked in order; nothing is written until every one passes:
 *   1. signed bot caller (non-null id from a verified signature) — 403
 *      actor_unverified;
 *   2. a live top-level card — 404 not_found (missing, or a tracker item),
 *      409 archived, 400 subtask;
 *   3. the caller's own card (assigned_bot === caller) — 403 not_assigned;
 *   4. operator-created or granted — the card's FIRST board_mutations row is
 *      its `create`, by a human, not a decision follow-up (`via:"decision"`);
 *      or data_json.dispatch_grants names the caller. A missing create row
 *      fails closed (Monday-synced cards have none) — 403 not_granted;
 *   5. a valid target (not the caller, an enabled non-voice bot) — 400
 *      bad_bot;
 *   6. a subtree safe to move: the card itself was never reparented or
 *      detached by a non-human, and every live descendant is unlocked,
 *      assigned to nobody or the caller, and was never reparented by a
 *      non-human — 409 subtree_blocked (so a bot cannot launder someone
 *      else's card into a dispatchable card's subtree, nor detach an
 *      operator subtask to dispatch it alone);
 *   7. the give core's own checks (409 locked, 409 finished, 400
 *      bot_unavailable, 409 no_board), run here before any write too.
 *
 * Effect: one guarded UPDATE claims the hand-off by setting assigned_bot to
 * NULL and clearing dispatch_grants (0 rows → 409 changed: the card moved,
 * was archived, reparented or reassigned since the checks, another dispatch
 * claimed it first, or — on the grant path — the grant was revoked); then
 * giveCard with the bot actor and autonomy "gated" (card and children);
 * then one `dispatch` mutation. Nothing starts: no job, no session.
 *
 * A grant is spent by the claim even if the give then refuses (a lock taken
 * in the window after the checks): that fails closed — the operator grants
 * again. The card itself goes back to the caller in that case. Because the
 * claim nulls assigned_bot, the give's update row records assigned_bot as
 * [null, to]; the dispatch row carries from/to.
 */

import { recordMutation } from "./card-service.js";
import { checkGive, giveCard } from "./give-service.js";
import { isEnabledBot } from "./bot-lookup.js";
import { lockedCardIds } from "../routes/board-lock.js";

function fail(message, code, http) {
  return Object.assign(new Error(message), { code, http });
}

function parseJson(text) {
  try {
    const v = JSON.parse(text == null ? "{}" : String(text));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function grantsOf(dataJson) {
  const g = parseJson(dataJson).dispatch_grants;
  return Array.isArray(g) ? g.filter((x) => typeof x === "string" && x) : [];
}

/**
 * Where a card came from, for rule 4. `humanCreated` is true only when the
 * card's own first board_mutations row (lowest id for that item_id) is a
 * `create` by a human actor whose detail is not a decision follow-up.
 * `grants` is data_json.dispatch_grants (string bot ids only).
 */
export async function cardProvenance(tdb, itemId) {
  const card = (await tdb.execute({
    sql: "SELECT data_json FROM tasks_items WHERE id=?", args: [itemId],
  })).rows[0];
  const first = (await tdb.execute({
    sql: "SELECT verb, actor_kind, detail_json FROM board_mutations WHERE item_id=? ORDER BY id ASC LIMIT 1",
    args: [itemId],
  })).rows[0];
  const humanCreated = !!first
    && first.verb === "create"
    && first.actor_kind === "human"
    && parseJson(first.detail_json).via !== "decision";
  return { humanCreated, grants: card ? grantsOf(card.data_json) : [] };
}

/** Live (non-archived) descendants of a card, breadth first — the same walk
 * giveCard's subtree move makes. */
async function liveDescendants(tdb, rootId) {
  const seen = new Set([rootId]);
  const out = [];
  let frontier = [rootId];
  while (frontier.length) {
    const { rows } = await tdb.execute({
      sql: `SELECT id, assigned_bot FROM tasks_items WHERE parent_id IN (${frontier.map(() => "?").join(",")}) AND board_id IS NULL AND archived_at IS NULL`,
      args: frontier,
    });
    frontier = [];
    for (const r of rows) {
      const id = Number(r.id);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, assigned_bot: r.assigned_bot ?? null });
      frontier.push(id);
    }
  }
  return out;
}

/** True when any of `ids` has an update row by a non-human actor that
 * changed parent_id (a bot reparented or detached it). */
async function botReparented(tdb, ids) {
  if (!ids.length) return false;
  const { rows } = await tdb.execute({
    sql: `SELECT detail_json FROM board_mutations WHERE item_id IN (${ids.map(() => "?").join(",")}) AND verb='update' AND actor_kind != 'human'`,
    args: ids,
  });
  return rows.some((r) => Object.prototype.hasOwnProperty.call(parseJson(r.detail_json), "parent_id"));
}

/** Rule 6: true when the move is unsafe — the ROOT card was ever reparented
 * by a non-human (a bot detached an operator subtask to dispatch it alone),
 * or any live descendant is assigned to another bot, locked, or was
 * reparented by a non-human. */
async function subtreeBlocked(tdb, cdb, rootId, callerId) {
  if (await botReparented(tdb, [rootId])) return true;
  const kids = await liveDescendants(tdb, rootId);
  if (!kids.length) return false;
  if (kids.some((k) => k.assigned_bot != null && k.assigned_bot !== callerId)) return true;
  const ids = kids.map((k) => k.id);
  if ((await lockedCardIds(cdb, ids)).size) return true;
  return botReparented(tdb, ids);
}

/**
 * Hand one of the caller's own top-level cards to another bot.
 *
 * @param tdb tasks.db client; @param cdb crow.db client
 * @param {{itemId:number, toBot:string, note?:string}} o
 * @param {{kind:string, id:string|null, jobId:string|null}} actor resolved
 *   by board-mcp.js resolveActor (a bot id only from a verified signature)
 * @returns {Promise<{ok:true, item_id:number, from:string, to:string}>}
 */
export async function dispatchCard(tdb, cdb, { itemId, toBot, note } = {}, actor) {
  // 1. signed bot
  const callerId = actor && actor.kind === "bot" && typeof actor.id === "string" ? actor.id : null;
  if (!callerId) throw fail("only a signed bot can dispatch a card", "actor_unverified", 403);

  // 2. a live top-level card
  const card = Number.isInteger(itemId) ? (await tdb.execute({
    sql: "SELECT id, board_id, archived_at, parent_id, assigned_bot FROM tasks_items WHERE id=?",
    args: [itemId],
  })).rows[0] : null;
  if (!card || card.board_id != null) throw fail(`card not found: ${itemId}`, "not_found", 404);
  if (card.archived_at != null) throw fail("card is archived", "archived", 409);
  if (card.parent_id != null) throw fail("a subtask cannot be dispatched; it moves with its parent", "subtask", 400);

  // 3. the caller's own card
  if (card.assigned_bot !== callerId) throw fail("the card is not assigned to you", "not_assigned", 403);

  // 4. operator-created, or granted to the caller
  const prov = await cardProvenance(tdb, itemId);
  if (!prov.humanCreated && !prov.grants.includes(callerId)) {
    throw fail("only a card the operator created, or granted you, can be dispatched", "not_granted", 403);
  }

  // 5. a valid target
  if (typeof toBot !== "string" || !toBot || toBot === callerId || !(await isEnabledBot(cdb, toBot))) {
    throw fail(`not a bot you can dispatch to: ${toBot}`, "bad_bot", 400);
  }

  // 6. a subtree safe to move
  if (await subtreeBlocked(tdb, cdb, itemId, callerId)) {
    throw fail("the card was detached by a bot, or a subtask is locked, assigned to another bot, or was moved under this card by a bot", "subtree_blocked", 409);
  }

  // 7. the give core's checks, before anything is written
  await checkGive(tdb, cdb, itemId, toBot);

  // Claim: one guarded write. 0 rows → the card changed since the checks.
  // It always moves something: assigned_bot goes to NULL (the WHERE requires
  // it to be the caller), so a second concurrent dispatch's claim matches 0
  // rows on BOTH paths. On the grant path the grant itself must also still
  // be there, so an operator revoke after the checks wins. The transient
  // NULL is an internal claim, not an edit: no board_mutations row; the
  // give's update row and the dispatch row record the move.
  const viaGrant = !prov.humanCreated;
  const claim = await tdb.execute({
    // CASE: a card with unparseable data_json (human path) is claimed as is,
    // never a raw SQLite JSON error.
    sql: `UPDATE tasks_items SET assigned_bot = NULL,
            data_json = CASE WHEN json_valid(data_json) THEN json_remove(data_json, '$.dispatch_grants') ELSE data_json END
          WHERE id = ? AND assigned_bot = ? AND parent_id IS NULL AND archived_at IS NULL AND board_id IS NULL` +
      (viaGrant
        ? ` AND json_valid(data_json) AND EXISTS (SELECT 1 FROM json_each(tasks_items.data_json, '$.dispatch_grants') WHERE value = ?)`
        : ""),
    args: viaGrant ? [itemId, callerId, callerId] : [itemId, callerId],
  });
  if (!Number(claim.rowsAffected)) throw fail("the card changed while dispatching", "changed", 409);

  try {
    await giveCard(tdb, cdb, {
      cardId: itemId, botId: toBot, actor,
      audit: { actor_type: "bot", actor_id: callerId, extra: { via: "dispatch" } },
      extraFields: { autonomy: "gated" },
      // The card write applies only while assigned_bot is still the claim's
      // NULL: an operator reassignment after the claim wins (409 changed).
      expectAssigned: null,
    });
  } catch (err) {
    // The give refused after the claim (a lock or a board change in the
    // window): hand the card back to the caller unless someone else has
    // assigned it since. On 409 changed someone already did (possibly to
    // nobody), so nothing is restored over it. The grant stays spent (fails
    // closed). A failed restore never masks the give's own code.
    if (err?.code !== "changed") {
      try {
        await tdb.execute({
          sql: "UPDATE tasks_items SET assigned_bot = ? WHERE id = ? AND assigned_bot IS NULL AND board_id IS NULL",
          args: [callerId, itemId],
        });
      } catch { /* the give's error below is the one that matters */ }
    }
    throw err;
  }
  await recordMutation(tdb, {
    itemId, verb: "dispatch", actor,
    detail: { from: callerId, to: toBot, note: note == null || note === "" ? null : String(note) },
  });
  return { ok: true, item_id: itemId, from: callerId, to: toBot };
}
