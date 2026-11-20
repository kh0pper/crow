/**
 * Crow Recurring Reports' local-only tables, DDL constants only (side-effect free, no imports). One
 * shape, two rails: scripts/init-db.js ("reports tables") and
 * scripts/migrations/0031-reports-core.mjs both build from this string.
 *
 * A report is one row in `reports`: what it presents, how it is delivered, who last approved it (the
 * seal columns) and where its head recipe stands. `report_recipe_revisions` keeps every recipe that
 * was ever saved, one row per (report, rev), written once and never updated, so a revision is the
 * thing the owner or the bot actually saved. `report_state` is the report's own small key/value store
 * (a source block's high-water mark, a diff baseline). `report_usage` counts a day's sends, bot
 * minutes and extra step runs against the caps, keyed by the report's own time zone's day.
 * `report_approvals_audit` records every approval decision, refused and revoked ones included.
 *
 * Epoch-ms times; statuses, author kinds and decision words are validated in the stores
 * (servers/gateway/reports/store.js and the approvals module), never by a CHECK. No foreign keys: the
 * store removes one report's rows itself. Every table is LOCAL ONLY (instance-sync
 * LOCAL_ONLY_TABLES): a report names the owner's sources, recipients and credentials, so it never
 * leaves the instance that holds it. Additive, no SCHEMA_GENERATION bump.
 *
 * reports.pending_free_change is set when a bot's save changed only free settings, so the owner's card
 * can offer Apply without a fresh go-live. reports.live_seal / live_nonce hold the go-live approval
 * seal over the live set (servers/gateway/reports/seal.js); both are NULL whenever the report is not
 * live, and a refusal or revocation nulls them so an old seal can never re-approve the row.
 *
 * REPORTS_RUNS_DDL is the runs half, kept apart because 0031 already shipped REPORTS_DDL exactly as it
 * is: `report_runs` is one attempt at running a report (queued, running, then ok, empty or failed), and
 * `report_run_requests` is the tiny queue a bot tool inserts into when it wants a preview or a run now
 * (it never starts a run itself). A scheduled run's window is unique per report, so a missed window
 * cannot run twice. `trigger` is an SQL keyword, so it is quoted everywhere in SQL.
 *
 * REPORTS_SEND_DDL is the send half: the owner's recipients for one report, and the send log (one row
 * per run, recipient and attempt). Its own comment below spells out the states, the unique keys and why
 * neither table can ever be resent automatically.
 */
export const REPORTS_DDL = `
  CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    project_id INTEGER,
    owner TEXT,
    bot_id TEXT,
    title TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    recipe_json TEXT NOT NULL DEFAULT '{"blocks":[]}',
    recipe_rev INTEGER NOT NULL DEFAULT 0,
    recipe_hash TEXT,
    sources_hash TEXT,
    schedule_id INTEGER,
    delivery_mode TEXT NOT NULL DEFAULT 'email_link',
    comment_tier_default TEXT NOT NULL DEFAULT 'c',
    comment_visibility TEXT NOT NULL DEFAULT 'own',
    ai_commentary INTEGER NOT NULL DEFAULT 0,
    model_ref TEXT,
    pause_reason TEXT,
    notify_every_run INTEGER NOT NULL DEFAULT 0,
    sender_account_id TEXT,
    artifact_id TEXT,
    live_rev INTEGER,
    live_seal TEXT,
    live_nonce TEXT,
    approved_preview_run TEXT,
    pending_free_change INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_reports_project ON reports(project_id);

  CREATE TABLE IF NOT EXISTS report_recipe_revisions (
    report_id TEXT NOT NULL,
    rev INTEGER NOT NULL,
    recipe_json TEXT NOT NULL,
    recipe_hash TEXT NOT NULL,
    sources_hash TEXT NOT NULL,
    author_kind TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (report_id, rev)
  );

  CREATE TABLE IF NOT EXISTS report_state (
    report_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (report_id, key)
  );

  CREATE TABLE IF NOT EXISTS report_usage (
    report_id TEXT NOT NULL,
    day TEXT NOT NULL,
    emails INTEGER NOT NULL DEFAULT 0,
    bot_ms INTEGER NOT NULL DEFAULT 0,
    extra_step_runs INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (report_id, day)
  );

  CREATE TABLE IF NOT EXISTS report_approvals_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    subject TEXT,
    actor TEXT,
    decided TEXT NOT NULL,
    at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_report_approvals_audit_report ON report_approvals_audit(report_id);
`;

export const REPORTS_TABLES = Object.freeze([
  "reports",
  "report_recipe_revisions",
  "report_state",
  "report_usage",
  "report_approvals_audit",
]);

/**
 * The runs: one row per attempt, and the request queue a bot tool writes to.
 *
 * Every run names the trigger that made it (`schedule`, `manual`, `preview`) and who asked for it
 * (`owner`, `schedule`, a `bot:<id>`). `gateway_run_id` is the id of the gateway process that claimed
 * the run (servers/gateway/run-id.js): a boot sweep fails every queued or running row whose id is not
 * this process's, so a restart never leaves a run stuck in `running`. `block_log_json` is a small
 * summary (how many items, which sources failed), never the items themselves; `error_text` is the
 * redacted one-line reason a run failed. Epoch-ms times; statuses are validated in the run engine
 * (servers/gateway/reports/run.js), never by a CHECK. No foreign keys.
 *
 * The run tables are LOCAL ONLY too (instance-sync LOCAL_ONLY_TABLES): a run's error text and block
 * log name the owner's sources, and a report never leaves its instance.
 */
export const REPORTS_RUNS_DDL = `
  CREATE TABLE IF NOT EXISTS report_runs (
    id TEXT PRIMARY KEY,
    report_id TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    scheduled_for INTEGER,
    late INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER,
    ended_at INTEGER,
    status TEXT NOT NULL DEFAULT 'queued',
    recipe_rev INTEGER,
    artifact_version INTEGER,
    block_log_json TEXT,
    error_text TEXT,
    gateway_run_id TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_report_runs_schedule_window
    ON report_runs(report_id, scheduled_for) WHERE "trigger" = 'schedule';

  CREATE INDEX IF NOT EXISTS idx_report_runs_report ON report_runs(report_id, created_at);

  CREATE INDEX IF NOT EXISTS idx_report_runs_status ON report_runs(status);

  CREATE TABLE IF NOT EXISTS report_run_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    claimed_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_report_run_requests_claimed
    ON report_run_requests(claimed_at);
`;

export const REPORTS_RUNS_TABLES = Object.freeze(["report_runs", "report_run_requests"]);

/**
 * The run-to-version map: which artifact version a run wrote, and which links that version may show.
 *
 * One row per (artifact_id, n), written INSIDE the artifact's own version batch (the artifacts store's
 * `addVersion` `extraStatements` seam), so the row exists exactly when the version does: a failed insert
 * rolls the version back with it, and a version can never be orphaned from the run that made it. The
 * PRIMARY KEY is the version's own key, so a version has at most one run and a run cannot claim a
 * version twice.
 *
 * `allowed_links_json` is the run's set of http(s) URLs that appear in its items (de-duplicated, at most
 * 2,000), the same set the recipient view uses to decide which links become clickable; it is the only
 * place a report's own links are recorded, so the rendered document stays inert. Times are epoch ms;
 * `trigger` is an SQL keyword and is quoted everywhere. No CHECKs, no foreign keys: the run engine
 * validates the trigger word, and the reports store removes a report's rows itself.
 *
 * A version in this table was made by a report run, never by the owner, which is why the dashboard and
 * the report page say "Report run" for it instead of "you". LOCAL ONLY (instance-sync
 * LOCAL_ONLY_TABLES): a row names a report and its run, and a report never leaves its instance.
 * Additive, no SCHEMA_GENERATION bump.
 */
export const REPORTS_VERSIONS_DDL = `
  CREATE TABLE IF NOT EXISTS report_versions (
    artifact_id TEXT NOT NULL,
    n INTEGER NOT NULL,
    report_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    allowed_links_json TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (artifact_id, n)
  );

  CREATE INDEX IF NOT EXISTS idx_report_versions_report ON report_versions(report_id);
`;

export const REPORTS_VERSIONS_TABLES = Object.freeze(["report_versions"]);

/**
 * The send half: who a report goes to, and one row per attempt at mailing one of them.
 *
 * `report_recipients` is the owner's list for one report. An address is stored lower-cased, and a
 * report has at most one row per address (the unique index), so proposing the same person twice
 * answers the row that exists instead of a second one. `comment_tier` NULL means "the report's own
 * default" (spec R15). `state` is one of proposed, approved, refused, revoked. An approved row carries
 * an approval nonce and an approval seal over the report, the row, the address and the tier
 * (servers/gateway/reports/seal.js, kind "recipient"); refusing or revoking NULLS both, so an old seal
 * can never re-approve a row. A recipient is NOT part of the live set: adding, approving, refusing or
 * revoking one never changes the report's status.
 *
 * `report_sends` is the send log (spec R3): one row per (run, recipient, attempt), written `pending`
 * before anything is attempted and moved once by a guarded claim, then settled by its claim token. It
 * names the sender account so a restart can still say what happened, and it stores both the Crow-made
 * Message-ID and whatever the provider reported, because later matching looks for either. Statuses are
 * pending, sending, sent, failed, unknown and refused. A `sending` or `unknown` row is never resent
 * automatically: only a `pending` row can be claimed.
 *
 * Epoch-ms times; statuses and states are validated in the stores (servers/gateway/reports/approvals.js
 * and the mail module's reports send door), never by a CHECK. No foreign keys: the reports store
 * removes one report's rows itself. Every table is LOCAL ONLY (instance-sync LOCAL_ONLY_TABLES): a
 * recipient is a person the owner writes to and a send names that person and the account, so neither
 * leaves the instance holding the report. Additive, no SCHEMA_GENERATION bump.
 */
export const REPORTS_SEND_DDL = `
  CREATE TABLE IF NOT EXISTS report_recipients (
    id TEXT PRIMARY KEY,
    report_id TEXT NOT NULL,
    address TEXT NOT NULL,
    display_name TEXT,
    comment_tier TEXT,
    state TEXT NOT NULL DEFAULT 'proposed',
    proposed_by TEXT NOT NULL,
    approval_nonce TEXT,
    approval_seal TEXT,
    approved_at INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_report_recipients_report_address
    ON report_recipients(report_id, address);

  CREATE INDEX IF NOT EXISTS idx_report_recipients_report ON report_recipients(report_id);

  CREATE TABLE IF NOT EXISTS report_sends (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    report_id TEXT NOT NULL,
    recipient_id TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 1,
    account_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    claim_token TEXT,
    message_id TEXT,
    provider_message_id TEXT,
    reason TEXT,
    gateway_run_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_report_sends_run_recipient_attempt
    ON report_sends(run_id, recipient_id, attempt);

  CREATE INDEX IF NOT EXISTS idx_report_sends_report ON report_sends(report_id);

  CREATE INDEX IF NOT EXISTS idx_report_sends_status ON report_sends(status);
`;

export const REPORTS_SEND_TABLES = Object.freeze(["report_recipients", "report_sends"]);