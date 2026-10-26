// scripts/migrations/0009-schedule-runs.mjs
//
// schedules.tz (a row's IANA zone; NULL = follow the instance zone) and the schedule_runs history
// table (fired, late, missed, failed, requested and paused runs; servers/gateway/scheduler.js).
//
// ADDITIVE, no SCHEMA_GENERATION bump: init-db.js carries the same shape (CREATE body +
// addColumnIfMissing, and the same schedule_runs DDL) — one shape, two rails, so a co-hosted
// instance converging on its own restart gets it too (the 0005 story).
//
// It also PAUSES the rows this change would otherwise turn into spam. Until now only a task
// starting "reminder:" delivered anything; from now on every plain-text row is a reminder. So an
// enabled plain-text row that repeats more often than hourly (an AI-made "check X every 5 min")
// and any enabled pipeline: row that is not a bot routine are switched off, each with one
// schedule_runs record (status 'paused', source 'upgrade') that the scheduler turns into a single
// notice. Prefixed reminders, bot routines and bundle-owned rows are never touched. The pause is
// an UPDATE guarded on enabled = 1, so a second run (or a lost registry record) pauses nothing
// new. Idempotent, absent-table tolerant, never drops or deletes.
import Database from "better-sqlite3";
import { addColumnIfMissing } from "./0005-bot-sessions-label-cwd.mjs";
import { scheduleKind, cadenceMinutes, REMINDER_PREFIX, ONCE } from "../../servers/shared/schedule-core.js";

export const id = "0009-schedule-runs";

// Byte-for-byte the block in scripts/init-db.js ("schedule_runs table").
export const SCHEDULE_RUNS_DDL = `
  CREATE TABLE IF NOT EXISTS schedule_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schedule_id INTEGER NOT NULL,
    scheduled_for TEXT,
    ran_at TEXT,
    status TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'clock',
    missed_count INTEGER NOT NULL DEFAULT 0,
    job_id TEXT,
    detail TEXT,
    notified_at TEXT,
    acknowledged_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_schedule_runs_sched ON schedule_runs(schedule_id, id DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS ux_schedule_runs_occ ON schedule_runs(schedule_id, scheduled_for) WHERE scheduled_for IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_schedule_runs_status ON schedule_runs(status, notified_at);
`;

/** Why an enabled row must be paused by this upgrade, or null. */
export function pauseReason(row, now = Date.now()) {
  const task = String(row.task ?? "").trim();
  const kind = scheduleKind(task);
  if (kind === "system") return { reason: "system" };
  if (kind !== "reminder" || task.startsWith(REMINDER_PREFIX) || row.cron_expression === ONCE) return null;
  const every = cadenceMinutes(row.cron_expression, row.tz ?? null, now);
  return every !== null && every < 60 ? { reason: "frequent", every_min: every } : null;
}

export function run({ dbPath, log = () => {}, now = Date.now() }) {
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 10000");
  const results = [];
  try {
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schedules'").get();
    if (!t) {
      // A store that predates the core tables: init-db creates both with this shape later.
      log("  schedules: absent");
      return { applied: true, results: ["absent"] };
    }
    const r = addColumnIfMissing(db, "schedules", "tz", "TEXT");
    log(`  schedules.tz: ${r}`);
    results.push(r);
    db.exec(SCHEDULE_RUNS_DDL);
    results.push("schedule_runs: ensured");

    const rows = db.prepare("SELECT id, task, cron_expression, tz FROM schedules WHERE enabled = 1").all();
    const pause = db.prepare("UPDATE schedules SET enabled = 0, updated_at = datetime('now') WHERE id = ? AND enabled = 1");
    const record = db.prepare("INSERT INTO schedule_runs (schedule_id, status, source, detail) VALUES (?, 'paused', 'upgrade', ?)");
    let paused = 0;
    db.transaction(() => {
      for (const row of rows) {
        const why = pauseReason(row, now);
        if (!why) continue;
        if (pause.run(row.id).changes === 1) {
          record.run(row.id, JSON.stringify(why));
          paused++;
        }
      }
    })();
    log(`  schedules paused by the upgrade: ${paused}`);
    results.push(`paused: ${paused}`);
  } finally {
    db.close();
  }
  return { applied: true, results };
}
