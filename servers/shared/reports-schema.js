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