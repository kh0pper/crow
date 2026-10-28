/**
 * Result service — terminal-state results + per-card autonomy (Track 1,
 * Task 3 / D-T1.5).
 *
 * `board_report_result` is the bot's explicit outcome signal — never
 * inferred from a process exit. It 409s on a def-terminal-status card
 * ('terminal') and on an archived card ('archived'), which also makes the
 * auto path replay-proof: after an auto-move the card is terminal, so a
 * duplicate 'success' report 409s instead of re-approving. A caller-supplied
 * `planId` is validated to belong to `itemId` (400 'bad_plan' otherwise) —
 * load-bearing for Task 6, which passes a user-supplied plan id through:
 * without this check, a stray or cross-item id would silently attach a
 * foreign plan's version/superseded status via listResults's LEFT JOIN.
 *
 * The result↔lock contract: a bot reports mid-turn while its own
 * session/job lock is still live. The auto-move is exempt from the
 * reporting actor's OWN lock only — moveCard's `{lockExempt: actor}` matches
 * the job rail by `job_id` and the session rail by `bot_id` (board-lock.js's
 * sessionRowFor SELECT gains `bot_id` alongside this file, Task 3). Any
 * other live lock still 409s through moveCard, and that error propagates
 * from reportResult unchanged — the result row itself is still recorded
 * ('recorded' status) even when the auto-move is refused.
 *
 * `tdb` is tasks.db, `cdb` is crow.db (bot_jobs/bot_sessions, for the lock
 * check inside moveCard) — both instance-global; this file never resolves a
 * path itself.
 */

import { getCard, moveCard, recordMutation } from "./card-service.js";
import { resolveBoardDef, isTerminal } from "../routes/board-defs.js";
import { nowStamp } from "./util.js";
import { doneStatus } from "../dashboard/panels/board/lanes.js";

function fail(msg, code, http) {
  return Object.assign(new Error(msg), { code, http });
}

/**
 * Record a result for a card. On outcome==='success' && card.autonomy===
 * 'auto' && the card's board def has 'done' among terminal_values: moves
 * the card to 'done' (lockExempt: actor) and marks the result 'approved'
 * with decided_via 'auto'. Otherwise the result stays 'recorded' and the
 * card does not move.
 */
export async function reportResult(tdb, cdb, itemId, { outcome, summaryMd, planId } = {}, actor) {
  const cur = await getCard(tdb, itemId);
  if (!cur) throw fail("card not found", "not_found", 404);
  if (cur.archived_at != null) throw fail("card is archived", "archived", 409);

  const def = await resolveBoardDef(tdb, { projectId: cur.project_id });
  if (isTerminal(def, String(cur.status))) throw fail("card is terminal", "terminal", 409);

  if (planId != null) {
    const plan = (await tdb.execute({
      sql: "SELECT id FROM board_plans WHERE id=? AND item_id=?",
      args: [planId, itemId],
    })).rows[0];
    if (!plan) throw fail(`plan ${planId} does not belong to item ${itemId}`, "bad_plan", 400);
  }

  const a = actor || {};
  const ins = await tdb.execute({
    sql: `INSERT INTO board_results (item_id, plan_id, job_id, actor_kind, actor_id, outcome, summary_md)
          VALUES (?,?,?,?,?,?,?)`,
    args: [itemId, planId ?? null, a.jobId ?? null, a.kind || "human", a.id ?? null, String(outcome), summaryMd == null ? "" : String(summaryMd)],
  });
  const resultId = Number(ins.lastInsertRowid);
  await recordMutation(tdb, { itemId, verb: "result_report", actor, detail: { outcome: [null, String(outcome)] } });

  let status = "recorded";
  if (outcome === "success" && cur.autonomy === "auto" && def.terminal_values.includes("done")) {
    await moveCard(tdb, cdb, itemId, "done", actor, { lockExempt: actor });
    const stamp = nowStamp();
    await tdb.execute({
      sql: "UPDATE board_results SET status='approved', decided_at=?, decided_via='auto' WHERE id=?",
      args: [stamp, resultId],
    });
    status = "approved";
  } else if (cur.autonomy === "gated") {
    // Track 3 Task 8: a gated card never auto-moves on ANY outcome — this
    // result_report is the ONLY signal an operator gets that a bot finished
    // and is waiting on a decision. Blocking event: always pushes,
    // priority high, same as the engine's ask-card push. Fire-and-forget —
    // notifications.js's own createNotification already fails open on every
    // downstream sender, and a notification error must never undo the
    // result row already committed above. `cdb` (crow.db) is where the
    // shared notifications table lives — this file never resolves its own
    // path (module header).
    try {
      const { createNotification } = await import("../../shared/notifications.js");
      await createNotification(cdb, {
        type: "attention",
        priority: "high",
        title: (cur.title ? `"${cur.title}"` : `Card #${itemId}`) + " needs review",
        body: summaryMd || `${String(outcome)} reported by ${a.kind || "bot"}${a.id ? " " + a.id : ""}`,
        action_url: "/dashboard/bot-board#card=" + itemId,
      });
    } catch {
      // Non-fatal — the result row is already committed.
    }
  }

  return { id: resultId, status };
}

/**
 * Approve or reject a recorded result. Only legal on status='recorded'
 * (else 'already_decided'); stamps decided_at/decided_via. NEVER moves the
 * card — an operator's "approve & mark done" affordance is a separate,
 * explicit write, not implied by this call. Records 'result_decide'.
 * `{ newestOnly: true }` (optional; redesign P5) also requires the result to
 * be the item's newest, inside the guarded UPDATE: a newer result makes it
 * 409 'stale' and write nothing. Callers that omit it are unchanged.
 */
export async function decideResult(tdb, itemId, resultId, decision, actor, via, { newestOnly = false } = {}) {
  return decide(tdb, itemId, resultId, decision, actor, via, { newestOnly: newestOnly === true });
}

// The one decide write. `newestOnly` (acceptResult) folds "this is the
// item's newest result" into the guarded UPDATE itself, so a result reported
// between any earlier read and this write makes it change nothing; a 0-row
// UPDATE is then told apart by re-reading the row: still recorded means a
// newer result superseded it ('stale'), anything else 'already_decided'.
async function decide(tdb, itemId, resultId, decision, actor, via, { newestOnly }) {
  const row = (await tdb.execute({
    sql: "SELECT * FROM board_results WHERE id=? AND item_id=?",
    args: [resultId, itemId],
  })).rows[0];
  if (!row) throw fail("result not found", "not_found", 404);
  if (row.status !== "recorded") throw fail("result already decided", "already_decided", 409);

  // The guard (C8): only a still-recorded row is decided, so of two racing
  // decisions exactly one lands; the other changes nothing and is told so.
  const stamp = nowStamp();
  const newest = newestOnly ? " AND id=(SELECT MAX(id) FROM board_results WHERE item_id=?)" : "";
  const w = await tdb.execute({
    sql: "UPDATE board_results SET status=?, decided_at=?, decided_via=? WHERE id=? AND item_id=? AND status='recorded'" + newest,
    args: [String(decision), stamp, via ?? null, resultId, itemId, ...(newestOnly ? [itemId] : [])],
  });
  if (w.rowsAffected !== 1) {
    if (newestOnly) {
      const now = (await tdb.execute({ sql: "SELECT status FROM board_results WHERE id=? AND item_id=?", args: [resultId, itemId] })).rows[0];
      if (now && now.status === "recorded") throw fail("result is not the card's newest", "stale", 409);
    }
    throw fail("result already decided", "already_decided", 409);
  }
  await recordMutation(tdb, {
    itemId,
    verb: "result_decide",
    actor,
    detail: { status: [row.status, String(decision)], decided_via: [null, via ?? null] },
  });

  return { id: resultId, status: String(decision) };
}

/**
 * Accept a result: approve it and close the card, in one call (redesign P3:
 * Accept = approve + done). Only the item's NEWEST result can be accepted
 * (409 'stale' otherwise: a newer report superseded it, and nothing is
 * written). The approval goes through the guarded decideResult, so a second
 * accept is 'already_decided'. The card then moves to its board's done
 * status (doneStatus) unless it is already terminal. If a session holds the
 * card, that move is refused by the existing lock rule: the approval stands
 * and the result is { status: "approved", moved: false }.
 */
export async function acceptResult(tdb, cdb, itemId, resultId, actor, via) {
  const cur = await getCard(tdb, itemId);
  if (!cur) throw fail("card not found", "not_found", 404);
  if (cur.archived_at != null) throw fail("card is archived", "archived", 409);
  const newest = (await tdb.execute({
    sql: "SELECT id FROM board_results WHERE item_id=? ORDER BY id DESC LIMIT 1",
    args: [itemId],
  })).rows[0];
  if (!newest || Number(newest.id) !== Number(resultId)) {
    throw fail("result is not the card's newest", "stale", 409);
  }

  // The read above is a fast refusal; the write re-checks "newest" itself.
  await decide(tdb, itemId, resultId, "approved", actor, via, { newestOnly: true });

  // From here the approval stands, and the move never overwrites anyone
  // else's: it carries the status just re-read (expectStatus), so a move
  // that lands in between (the classic board, another process) makes this
  // one change nothing. Two outcomes keep the card where it is:
  //   - the lock rule refuses the move     -> { approved, moved:false }
  //   - the card moved meanwhile (stale)   -> { approved, moved:false, stale:true };
  //     the lane route answers that 409 'stale' with the card's real lane,
  //     and the Board re-renders from it.
  // Anything else propagates with the result still approved: an archived
  // card is a 409 (the route says 'stale'); a bad_status is a 400 (the
  // route says 'bad_request').
  const def = await resolveBoardDef(tdb, { projectId: cur.project_id });
  const now = await getCard(tdb, itemId);
  if (isTerminal(def, String(now.status))) return { status: "approved", moved: false };
  try {
    await moveCard(tdb, cdb, itemId, doneStatus(def), actor, { expectStatus: String(now.status) });
  } catch (e) {
    if (e && e.code === "locked") return { status: "approved", moved: false };
    if (e && e.code === "stale") return { status: "approved", moved: false, stale: true };
    throw e;
  }
  return { status: "approved", moved: true };
}

/**
 * All results for an item, newest first, each joined with its referenced
 * plan's version + a `plan_superseded` boolean (the plan version that was
 * current when the result was reported may have been superseded since —
 * visible at decide time, not silent). `plan_version`/`plan_superseded` are
 * null/false when the result carries no plan_id.
 */
export async function listResults(tdb, itemId) {
  const rows = (await tdb.execute({
    sql: `SELECT r.*, p.version AS plan_version, p.status AS plan_status
          FROM board_results r
          LEFT JOIN board_plans p ON p.id = r.plan_id
          WHERE r.item_id=?
          ORDER BY r.id DESC`,
    args: [itemId],
  })).rows;
  return rows.map((r) => {
    const { plan_status, ...rest } = r;
    return { ...rest, plan_superseded: plan_status === "superseded" };
  });
}
