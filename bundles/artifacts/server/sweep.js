// Crow Artifacts — the periodic sweep (plan Task 3.6; review R-M3).
// Every tick:
//   1. rounds past their deadline → timed-out (threads reopen), owner notified;
//   2. every ended UNTRUSTED round's locked session is stopped (never left
//      holding a Perch slot or its untrusted context);
//   3. queued rounds are retried — unless a box reservation is held.
// Injected: engine (Perch), notify(n), reserved() → bool, botDefOf(botId).
import { sweepTimeouts, getRound } from "./rounds.js";
import { deliverRound, stopRoundSession } from "./delivery.js";
import { reconcileBlobs } from "./store.js";

let running = false;   // R3-M2: ticks never overlap (a tick can wait on the write lock)
const HEALTH = { lastProblem: null, checkedAt: null };
const NOTIFIED = new Set();   // a "told the owner" memo, never a trust state
export function artifactsHealth() { return { ...HEALTH }; }

export async function runSweep(db, opts = {}) {
  if (running) return { skipped: true };
  running = true;
  try { return await sweepOnce(db, opts); } finally { running = false; }
}

async function sweepOnce(db, { engine = null, blobs = null, now = Date.now(), notify = async () => {}, reserved = () => false, botDefOf = async () => null }) {
  const out = { timedOut: [], stopped: [], retried: [], reconciled: null };
  // R2-M5: timeouts never depend on the Perch engine existing.
  out.timedOut = await sweepTimeouts(db, now);
  if (blobs) {
    try { out.reconciled = await reconcileBlobs(db, blobs, { now }); if (out.reconciled.refused) out.problem = `reclaim refused: ${out.reconciled.refused}`; }
    catch (e) { out.problem = `${e.code || "error"}: ${e.message}`; }
  }
  // R3-L5 / review: lock_corrupt, lock_wal, a store/database mismatch or a
  // refused reclaim are SURFACED (a notification once per distinct problem,
  // plus artifactsHealth() for the Nest health signal) — never swallowed.
  HEALTH.lastProblem = out.problem || null;
  HEALTH.checkedAt = now;
  if (out.problem && !NOTIFIED.has(out.problem)) {
    NOTIFIED.add(out.problem);
    try { await notify({ title: "Artifact storage needs attention", body: out.problem, type: "attention", source: "artifacts" }); } catch {}
  }
  for (const id of out.timedOut) {
    try { await notify({ title: "An artifact round timed out", body: `Round ${id} ended without a result; its threads are open again.`, type: "attention", source: "artifacts" }); } catch {}
  }
  if (!engine) return out;   // stopping and retrying need the engine; timeouts did not
  const ended = (await db.execute({ sql: "SELECT id, session_id FROM artifact_rounds WHERE untrusted_input=1 AND status IN ('done','failed','timed-out') AND session_id IS NOT NULL AND session_stopped_at IS NULL", args: [] })).rows;
  for (const r of ended) {
    if (await stopRoundSession(engine, r.session_id)) {
      await db.execute({ sql: "UPDATE artifact_rounds SET session_stopped_at=datetime('now') WHERE id=?", args: [r.id] });
      out.stopped.push(Number(r.id));
    }
  }
  if (!reserved()) {
    const queued = (await db.execute({ sql: "SELECT id, artifact_id FROM artifact_rounds WHERE status='queued' ORDER BY id", args: [] })).rows;
    for (const q of queued) {
      const round = await getRound(db, q.id);
      const art = (await db.execute({ sql: "SELECT origin_session FROM artifacts WHERE id=?", args: [q.artifact_id] })).rows[0];
      try {
        const res = await deliverRound(db, round, { engine, botDef: await botDefOf(round.bot_id), choice: "auto", originThread: art?.origin_session || null, actor: { kind: "system" } });
        if (res.status === "working") out.retried.push(round.id);
        if (res.downgraded) { try { await notify({ title: "A feedback round ran with Artifacts tools only", body: `Round ${round.id} included outside text, so it ran in a session limited to Artifacts.`, type: "attention", source: "artifacts" }); } catch {} }
      } catch {}
    }
  }
  return out;
}

/**
 * What the mount runs when a bot calls artifact_round_done (plan Task 3.6):
 *   - R-M3: an ended UNTRUSTED round's locked session stops at once (never
 *     left holding a Perch slot or its untrusted context);
 *   - the owner hears "Version N is ready" when the round produced one.
 * Exported for tests; never throws into the MCP call.
 */
export async function roundDoneEffects(db, round, { engine = null, notify = async () => {} } = {}) {
  const out = { stopped: false, notified: false };
  if (!round) return out;
  if (engine && round.untrusted && round.session_id && !round.session_stopped_at) {
    out.stopped = await stopRoundSession(engine, round.session_id);
    if (out.stopped) {
      await db.execute({ sql: "UPDATE artifact_rounds SET session_stopped_at=datetime('now') WHERE id=?", args: [round.id] });
    }
  }
  if (round.result_version) {
    try {
      const art = (await db.execute({ sql: "SELECT title FROM artifacts WHERE id=?", args: [round.artifact_id] })).rows[0];
      await notify({
        title: `Version ${round.result_version} is ready`,
        body: `${(art && art.title) || "The artifact"}: the bot finished your feedback round.`,
        type: "system",
        source: "artifacts",
        action_url: `/dashboard/artifacts?id=${encodeURIComponent(round.artifact_id)}`,
      });
      out.notified = true;
    } catch { /* a failed notification must not fail the round */ }
  }
  return out;
}
