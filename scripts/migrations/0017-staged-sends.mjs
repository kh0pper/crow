// scripts/migrations/0017-staged-sends.mjs
//
// staged_sends: one row per provider draft a bot staged for the operator's yes (spec §12,
// servers/gateway/staged/store.js) — the recipients, subject and body the operator was shown, the
// SHA-256 of their canonical form, and the state from `staged` to `sent`/`failed`/`replaced`/
// `discarded`. LOCAL ONLY: the table is in instance-sync's LOCAL_ONLY_TABLES, because it holds
// addresses and bodies. Times are epoch ms; state is validated in the store, not by a CHECK.
//
// Independent of 0016 (the migration runner applies by id, not by contiguity, and 0017 is additive
// DDL on a table nothing else references).
//
// ADDITIVE, no SCHEMA_GENERATION bump: init-db.js carries the same DDL (one shape, two rails, the
// 0005/0009/0010/0011/0018 story), so a co-hosted instance converging on its own restart gets it
// too. DDL only: there is nothing to backfill, and it never drops or deletes.
import Database from "better-sqlite3";

export const id = "0017-staged-sends";

// Byte-for-byte the block in scripts/init-db.js ("staged_sends table").
export const STAGED_SENDS_DDL = `
  CREATE TABLE IF NOT EXISTS staged_sends (
    id TEXT PRIMARY KEY,
    session_id TEXT, thread_id TEXT, bot_id TEXT, card_id INTEGER, job_id TEXT,
    channel TEXT NOT NULL DEFAULT 'gmail',
    cred_ref TEXT,
    provider_draft_id TEXT NOT NULL, provider_thread_id TEXT,
    snapshot TEXT NOT NULL, content_hash TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'staged', fail_reason TEXT,
    tainted INTEGER NOT NULL DEFAULT 0, new_recipients TEXT, source_flags TEXT,
    sent_at INTEGER, provider_message_id TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_staged_sends_session ON staged_sends(session_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_staged_sends_card ON staged_sends(card_id, created_at DESC) WHERE card_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_staged_sends_thread ON staged_sends(thread_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_staged_sends_draft ON staged_sends(provider_draft_id);
  CREATE INDEX IF NOT EXISTS idx_staged_sends_state ON staged_sends(state, created_at DESC);
`;

export function run({ dbPath, log = () => {} }) {
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 10000");
  try {
    db.exec(STAGED_SENDS_DDL);
    log("  staged_sends: ensured");
  } finally {
    db.close();
  }
  return { applied: true, results: ["staged_sends: ensured"] };
}