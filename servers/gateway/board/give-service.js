/**
 * give-service.js — the Give-a-task core: put a card on a bot's board, and
 * optionally start the bot on it. The Perch "Give to…" / dispatch routes and
 * the voice hand-off both call THIS, so they can never gate differently.
 *
 * Moved out of routes/perch-interactive-api.js; behaviour unchanged. Every
 * refusal is thrown in the {code, http} shape the route's mapEngineError()
 * maps.
 */
import { createDbClient } from "../../db.js";
import { resolveEngineStatus } from "../dashboard/panels/bot-builder/engine-gate.js";
import { perchAttached } from "../shared/perch-attached.js";
import { tasksDbPath } from "../../../scripts/pi-bots/instance-paths.mjs";
import { updateCard, createCard } from "./card-service.js";
import { appendAudit } from "../../shared/project-acl.js";
import { ensureItem } from "../../shared/shell-items.js";
import { loadGiveTarget } from "./offer-service.js";
import { assertAssignableBot } from "./bot-lookup.js";

/** The instance-global tasks store, resolved once at module load (same idiom
 * as bot-board-api.js's own TASKS_DB constant). */
const TASKS_DB = tasksDbPath();

/** Every provenance write the Give routes make is an operator action from
 * the dashboard — same shape as bot-board-api.js's own DASHBOARD_ACTOR. */
export const DASHBOARD_ACTOR = { kind: "human", id: null, jobId: null };

/** Same `{code, http}` throw shape card-service's own local `fail()` uses —
 * this router's own route-level validations (card existence, kind, archived)
 * funnel through mapEngineError's `.http`-first branch the same way a
 * card-service throw does, one error path for both origins. */
export function routeFail(message, code, http) {
  return Object.assign(new Error(message), { code, http });
}

/** Load a card's row for dispatch/attach-card validation: exists, is a CARD
 * (`board_id IS NULL` — Track 3 review Q2: dispatch/attach are cards-only),
 * and is not archived. Throws a routeFail() the catch block already knows
 * how to map: not_found→404, bad_request→400 (a custom-board ITEM id),
 * archived→409. */
export async function loadDispatchableCard(tdb, cardId) {
  const row = (await tdb.execute({
    sql: "SELECT id, board_id, archived_at, parent_id, project_id, status FROM tasks_items WHERE id=?",
    args: [cardId],
  })).rows[0];
  if (!row) throw routeFail("card not found", "not_found", 404);
  if (row.board_id != null) throw routeFail("not a card", "bad_request", 400);
  if (row.archived_at != null) throw routeFail("card is archived", "archived", 409);
  return row;
}

export function parseDef(row) {
  try {
    const def = JSON.parse(row.definition || "{}");
    return def && typeof def === "object" ? def : {};
  } catch {
    return {};
  }
}

/** assertAssignableBot, thrown in the shape the Perch routes map to their
 * `bot_unavailable` refusal (400). Defence in depth on the dispatch paths. */
export async function assertBotUnblocked(db, botId) {
  try {
    await assertAssignableBot(db, botId);
  } catch (e) {
    if (e && e.code === "bad_bot") throw routeFail("bot unavailable", "bot_unavailable", 400);
    throw e;
  }
}

/**
 * The dispatch core — POST /bots/:id/dispatch and "Give to…" with start:true
 * both run THIS, so the two can never gate differently. Checks, in order:
 * engine ready (409 engine_required), the bot has a Perch channel (403
 * perch_not_attached), the card is a live card (404/400/409), the card is
 * free (checkCardFree), then spawns bound to the card, writes the
 * assigned_bot provenance (unless the caller already wrote it — the give
 * route does, and a second write would be a second board_mutations row for
 * one action), and fires turn 1 without awaiting it. Every refusal is thrown
 * in the {code, http} shape mapEngineError() maps.
 *
 * `ctx.db` is the crow.db client (the assignment guard reads it).
 * `ctx.tdb` is opened here on first need (so an engine/perch refusal never
 * touches the tasks store) and left open for the CALLER to close.
 *
 * `getEng` is the engine GETTER, called only once the engine-ready and
 * Perch checks pass: resolving it creates the interactive-engine singleton,
 * which a refused dispatch (or a give that never starts) must not do.
 */
export async function dispatchCard(ctx, { row, getEng, botId, cardId, note, skipProvenance = false }) {
  await assertBotUnblocked(ctx.db, botId);
  if (resolveEngineStatus().state !== "ready") throw routeFail("engine_required", "engine_required", 409);
  const def = row ? parseDef(row) : {};
  if (!perchAttached(def)) throw routeFail("perch_not_attached", "perch_not_attached", 403);
  const eng = await getEng();

  if (!ctx.tdb) ctx.tdb = createDbClient(TASKS_DB);
  await loadDispatchableCard(ctx.tdb, cardId);

  await eng.checkCardFree(cardId);
  const result = await eng.spawn({ botId, cardId });

  // Provenance: the assigned_bot write goes through the SAME service
  // updateCard()/board_update_item's route uses (bot-board-api.js's own
  // DASHBOARD_ACTOR idiom) — one code path, one recordMutation shape.
  //
  // I6 (final review): eng.spawn() above already claims the card. If this
  // write throws, the OLD code let the error propagate past the spawned
  // session — the route errored out while the session still existed,
  // still held the claim, and never got its turn-1 message: an orphan
  // child on a permanently occupied card, recoverable only by Recall.
  // The session itself is more valuable than this provenance write
  // (a cosmetic "assigned by" field on the card), so a failure here is
  // logged and dispatch continues — the operator gets a working session,
  // just without the card-side assignment note.
  if (!skipProvenance) {
    try {
      await updateCard(ctx.tdb, cardId, { assigned_bot: botId }, DASHBOARD_ACTOR);
    } catch (provenanceErr) {
      console.error(
        `[perch-interactive-api] dispatch: assigned_bot provenance write failed for card ${cardId}, session ${result.sessionId} (session still proceeds):`,
        provenanceErr
      );
    }
  }

  // Fire-and-forget: dispatch STARTS the turn (spawn() already composed
  // and stored s.dispatchBrief; THIS message() call is what triggers it
  // to fire — see perch-interactive.js's own header note). Never awaited
  // — the route responds as soon as the session exists, not once the
  // agent turn finishes.
  eng.message(result.sessionId, note).catch(() => {});
  return result;
}

/** After a give: the response, and — only on an explicit boolean
 * start:true ("Start right away" defaults OFF) — the dispatch core. A start
 * that fails does NOT undo the give: the card is visibly on the bot's board
 * and can be started from there; the response says why it did not start. */
export async function startAfterGive(ctx, { row, getEng, botId, cardId, start, note }) {
  const out = { ok: true, assigned: true, started: false, cardId };
  if (start !== true) return out;
  try {
    const r = await dispatchCard(ctx, { row, getEng, botId, cardId, note, skipProvenance: true });
    return { ...out, started: true, sessionId: r.sessionId, threadId: r.threadId };
  } catch (err) {
    return { ...out, code: String((err && err.code) || "start_failed") };
  }
}

export function giveAudit(db, row, cardId, extra) {
  return appendAudit(db, {
    project_id: Number(row.project_id), actor_type: "local", action: "card_given",
    target: `card:${cardId}`, payload: { bot_id: String(row.bot_id), ...extra },
  });
}

/**
 * A NEW task straight onto a bot's board: the core of POST /bots/:id/tasks, shared with the
 * card-offer accept. loadGiveTarget (400 bot_unavailable / 409 no_board), then ONE createCard on
 * the bot's project with its assigned_bot (one create row, the builtin gated autonomy), then one
 * card_given audit row. `tdb` is the tasks client, or a getter called only once the bot passes
 * (so a refused bot never opens the tasks store, as before). `audit` adds payload fields ahead
 * of `created`. A failure after the create carries `err.cardId`, so a caller can tell a card was
 * made.
 */
export async function createTaskForBot(db, tdb, botId, { title, description = null, tags = null, audit = {} } = {}) {
  const row = await loadGiveTarget(db, botId);
  await assertBotUnblocked(db, botId); // the one guard every assignment path shares
  const t = typeof tdb === "function" ? tdb() : tdb;
  const { id: cardId } = await createCard(t, { title, description, project_id: Number(row.project_id), assigned_bot: botId, tags }, DASHBOARD_ACTOR);
  try {
    await giveAudit(db, row, cardId, { ...audit, created: true });
  } catch (err) {
    throw Object.assign(err, { cardId });
  }
  return { cardId, row };
}

/** File a freshly started thread under its card's project. A thread row never
 * carries a card (ensureItem nulls card_id for perch_thread); its card comes
 * from bot_sessions. Best-effort: never throws. */
export async function fileStartedThread(db, { threadId, projectId }) {
  try { await ensureItem(db, "perch_thread", threadId, { projectId, setBy: "origin" }); }
  catch (err) { console.error("[give-service] fileStartedThread failed:", (err && err.message) || err); }
}
