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
  }

  return { id: resultId, status };
}

/**
 * Approve or reject a recorded result. Only legal on status='recorded'
 * (else 'already_decided'); stamps decided_at/decided_via. NEVER moves the
 * card — an operator's "approve & mark done" affordance is a separate,
 * explicit write, not implied by this call. Records 'result_decide'.
 */
export async function decideResult(tdb, itemId, resultId, decision, actor, via) {
  const row = (await tdb.execute({
    sql: "SELECT * FROM board_results WHERE id=? AND item_id=?",
    args: [resultId, itemId],
  })).rows[0];
  if (!row) throw fail("result not found", "not_found", 404);
  if (row.status !== "recorded") throw fail("result already decided", "already_decided", 409);

  const stamp = nowStamp();
  await tdb.execute({
    sql: "UPDATE board_results SET status=?, decided_at=?, decided_via=? WHERE id=?",
    args: [String(decision), stamp, via ?? null, resultId],
  });
  await recordMutation(tdb, {
    itemId,
    verb: "result_decide",
    actor,
    detail: { status: [row.status, String(decision)], decided_via: [null, via ?? null] },
  });

  return { id: resultId, status: String(decision) };
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
