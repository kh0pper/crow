/**
 * Maker Lab — transcript retention sweep.
 *
 * Periodically deletes maker_transcripts rows older than the owning
 * learner's transcripts_retention_days setting (default 30). Also
 * purges orphaned transcripts whose learner has been deleted (belt +
 * suspenders — ON DELETE CASCADE should already handle that).
 *
 * Runs on bundle boot and then every hour. A process-global flag
 * prevents double-start if both the stdio entry and the gateway's
 * panel routes call startRetentionSweep().
 */

const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

let started = false;
let sweepTimer = null;

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
              AND (state = 'revoked' OR expires_at < datetime('now'))`,
      args: [],
    });
  } catch {
    // Non-fatal
  }
}

export function startRetentionSweep(db) {
  if (started) return;
  started = true;
  // First run soon after boot (5s grace so the DB is warm).
  const initial = setTimeout(() => { runOnce(db).catch(() => {}); }, 5000);
  sweepTimer = setInterval(() => { runOnce(db).catch(() => {}); }, SWEEP_INTERVAL_MS);
  // Allow the process to exit cleanly — neither timer keeps it alive.
  if (initial && typeof initial.unref === "function") initial.unref();
  if (sweepTimer && typeof sweepTimer.unref === "function") sweepTimer.unref();
}

// Exposed for direct invocation (e.g., admin panel "Sweep now" button).
export async function sweepNow(db) {
  await runOnce(db);
}
