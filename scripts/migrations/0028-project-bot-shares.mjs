// scripts/migrations/0028-project-bot-shares.mjs
//
// project_bot_shares: one row per bot a project's owner has shared that project with, at level
// 'read' or 'read_write', plus the revoke (revoked_at, never a delete). The partial unique index
// keeps at most one LIVE row per (project, bot), so a revoked row and a fresh grant coexist.
// LOCAL ONLY: the table is in instance-sync's LOCAL_ONLY_TABLES — a share is this instance's own
// grant and never replicates. There is no foreign key on bot_id: bot definitions are text keys in
// pi_bot_defs, so a deleted bot leaves a dead row that resolves to no access. The ON DELETE CASCADE
// on project_id is a backstop only — foreign keys are not enforced on production connections, so
// revoking a share is an explicit write.
//
// ADDITIVE, no SCHEMA_GENERATION bump: init-db.js carries the same DDL (one shape, two rails, the
// 0005/0009/0010/0011/0018 story), so a co-hosted instance converging on its own restart gets it
// too. DDL only: there is nothing to backfill, and it never drops or deletes rows.
import Database from "better-sqlite3";

export const id = "0028-project-bot-shares";

// rollbackSafe: a new table and its indexes only; older code never reads them.
export const rollbackSafe = true;

// Byte-for-byte the block in scripts/init-db.js ("project_bot_shares table").
export const PROJECT_BOT_SHARES_DDL = `
  CREATE TABLE IF NOT EXISTS project_bot_shares (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id    INTEGER NOT NULL REFERENCES project_spaces(id) ON DELETE CASCADE,
    bot_id        TEXT NOT NULL,
    level         TEXT NOT NULL CHECK (level IN ('read','read_write')),
    granted_by    TEXT NOT NULL DEFAULT 'owner',
    granted_at    TEXT NOT NULL DEFAULT (datetime('now')),
    revoked_at    TEXT
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_project_bot_shares_live ON project_bot_shares(project_id, bot_id) WHERE revoked_at IS NULL;

  CREATE INDEX IF NOT EXISTS idx_project_bot_shares_bot ON project_bot_shares(bot_id);
`;

export function run({ dbPath, log = () => {} }) {
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 10000");
  try {
    db.exec(PROJECT_BOT_SHARES_DDL);
    log("  project_bot_shares: ensured");
  } finally {
    db.close();
  }
  return { applied: true, results: ["project_bot_shares: ensured"] };
}
