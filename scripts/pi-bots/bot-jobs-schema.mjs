/**
 * Single source of truth for the bot_jobs DDL (Plan B Part 1 background jobs).
 *
 * Imported by three places so the table exists everywhere it's touched, with no
 * drift:
 *   - scripts/init-db.js          — fresh installs (full schema build)
 *   - scripts/pi-bots/job_runner  — lazy self-heal on the pi-bots side
 *   - gateway tool-executor       — lazy self-heal on the crow_delegate side
 *
 * Why lazy-ensure (not just init-db): the gateway only re-runs init-db when the
 * 3-table completeness check fails, so installs that predate this table never get
 * it from a restart. The convention here mirrors pipeline-runner's
 * ensurePipelineRunsTable() — every entry point CREATE-IF-NOT-EXISTS on first use.
 * All statements are idempotent. Pure constant, no side effects on import.
 */
export const BOT_JOBS_DDL = `
  CREATE TABLE IF NOT EXISTS bot_jobs (
    job_id        TEXT PRIMARY KEY,
    bot_id        TEXT NOT NULL,
    goal          TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'queued',  -- queued | running | completed | failed
    deliver_to    TEXT,                            -- JSON {kind, gateway_type?, gateway_thread_id?, memory_category?}
    source        TEXT,                            -- voice | chat | schedule | manual
    schedule_id   INTEGER,                         -- set when launched by the bot cron runner
    card_id       INTEGER,                         -- board card this job executes (source='card')
    card_action   TEXT,                             -- 'execute' | 'plan' (card jobs only)
    escalate      INTEGER NOT NULL DEFAULT 0,
    attempts      INTEGER NOT NULL DEFAULT 0,      -- retry counter (caps re-enqueue of abandoned jobs)
    result        TEXT,
    error         TEXT,
    pi_session_id TEXT,
    tool_calls    INTEGER,
    worker_pid    INTEGER,                         -- pi-bots host pid that claimed it (stale-claim recovery)
    claimed_at    TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    started_at    TEXT,
    ended_at      TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_bot_jobs_status
    ON bot_jobs(status, created_at);

  CREATE INDEX IF NOT EXISTS idx_bot_jobs_bot
    ON bot_jobs(bot_id, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_bot_jobs_card
    ON bot_jobs(card_id) WHERE card_id IS NOT NULL;
`;

/**
 * Columns added AFTER the table shipped. CREATE TABLE IF NOT EXISTS cannot add
 * them to an existing install, so every entry point applies these on first use
 * — the same lazy-ensure contract as the table itself.
 *
 * Adding one here means: add it to BOT_JOBS_DDL above TOO, or fresh installs
 * take the ALTER path forever.
 */
export const BOT_JOBS_ADDED_COLUMNS = [
  { name: "card_id", ddl: "ALTER TABLE bot_jobs ADD COLUMN card_id INTEGER" },
  { name: "card_action", ddl: "ALTER TABLE bot_jobs ADD COLUMN card_action TEXT" },
];

/**
 * Pure: given the column names a live bot_jobs table has, return the ALTER
 * statements still needed. Callers apply them with their own client (the
 * gateway is async libsql, pi-bots is sync better-sqlite3), which is why this
 * returns SQL rather than executing it.
 *
 * @param {string[]} existingColumnNames  from PRAGMA table_info(bot_jobs)
 * @returns {string[]}
 */
export function missingBotJobsColumns(existingColumnNames) {
  const have = new Set(existingColumnNames || []);
  return BOT_JOBS_ADDED_COLUMNS.filter((c) => !have.has(c.name)).map((c) => c.ddl);
}
