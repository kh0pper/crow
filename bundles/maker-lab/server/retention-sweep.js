/**
 * Maker Lab — transcript retention sweep, plus the learner-erase finisher.
 *
 * Periodically deletes maker_transcripts rows older than the owning
 * learner's transcripts_retention_days setting (default 30). Also
 * purges orphaned transcripts whose learner has been deleted (belt +
 * suspenders — ON DELETE CASCADE should already handle that).
 *
 * AND, every five minutes, it FINISHES any learner delete whose history erase
 * did not complete (pending-erasures.js): the cascade wrote a durable marker in
 * the same batch that removed the learner, so a marker still sitting there means
 * the erase owes work. Without this a failed erase stayed failed until someone
 * pressed delete again — and the profile row was already gone, so nobody would.
 * A marker whose erase fails again is left in place and will be retried.
 *
 * Runs on bundle boot and then hourly (retention) / every five minutes (pending
 * erases). A process-global flag prevents double-start if both the stdio entry
 * and the gateway's panel routes call startRetentionSweep().
 */
import { finishPendingErasures } from "./pending-erasures.js";

const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const PENDING_ERASE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

let started = false;
let sweepTimer = null;
let pendingTimer = null;

/** Finish every pending learner erase. Never throws: a timer must not die. */
async function runPendingErases(db) {
  try {
    const { completed, failed } = await finishPendingErasures(db);
    if (completed.length) {
      console.log(
        `[maker-lab] finished ${completed.length} pending learner erase(s): ` +
          completed.map((c) => `learner ${c.learnerId} (${c.versions} version(s))`).join(", "),
      );
    }
    for (const miss of failed) {
      console.warn(`[maker-lab] pending learner erase for learner ${miss.learnerId} still failing: ${miss.error}`);
    }
  } catch (err) {
    console.warn("[maker-lab] pending learner erase sweep failed:", err?.message || err);
  }
}

async function runOnce(db) {
  // Per-learner retention from maker_learner_settings. Default 30d when unset.
  // Delete transcripts whose (created_at) is older than (retention_days) days.
  // We use per-learner UPDATE-style CTE; SQLite supports DELETE ... WHERE ... IN.
  try {
    const r = await db.execute(`
      DELETE FROM maker_transcripts
      WHERE id IN (
        SELECT t.id FROM maker_transcripts t
        LEFT JOIN maker_learner_settings mls ON mls.learner_id = t.learner_id
        WHERE (julianday('now') - julianday(t.created_at)) * 1
              >= COALESCE(mls.transcripts_retention_days, 30)
      )
    `);
    if (r.rowsAffected) {
      console.log(`[maker-lab] retention sweep deleted ${r.rowsAffected} transcripts`);
    }
  } catch (err) {
    // Non-fatal — table might not exist yet on fresh installs.
    if (!/no such table/i.test(err.message || "")) {
      console.warn("[maker-lab] retention sweep failed:", err.message);
    }
  }

  // Orphaned guest session sweep — any is_guest=1 sessions that have already
  // ended/expired. Boot-time sweep already handles this on init, but we re-run
  // hourly to catch long-lived processes.
  try {
    await db.execute({
      sql: `DELETE FROM maker_sessions
            WHERE is_guest = 1
              AND (state = 'revoked' OR julianday(expires_at) < julianday('now'))`,
      args: [],
    });
  } catch {
    // Non-fatal
  }
}

export function startRetentionSweep(db) {
  if (started) return;
  started = true;
  // First run soon after boot (5s grace so the DB is warm). The pending-erase
  // pass runs first: it is the promise-keeping one.
  const initial = setTimeout(() => {
    runPendingErases(db).catch(() => {});
    runOnce(db).catch(() => {});
  }, 5000);
  sweepTimer = setInterval(() => { runOnce(db).catch(() => {}); }, SWEEP_INTERVAL_MS);
  pendingTimer = setInterval(() => { runPendingErases(db).catch(() => {}); }, PENDING_ERASE_INTERVAL_MS);
  // Allow the process to exit cleanly — neither timer keeps it alive.
  if (initial && typeof initial.unref === "function") initial.unref();
  if (sweepTimer && typeof sweepTimer.unref === "function") sweepTimer.unref();
  if (pendingTimer && typeof pendingTimer.unref === "function") pendingTimer.unref();
}

// Exposed for direct invocation (e.g., admin panel "Sweep now" button).
export async function sweepNow(db) {
  await runOnce(db);
  await runPendingErases(db);
}
