// scripts/migrations/0018-voice-handoffs.mjs
//
// voice_handoffs: the log of every hand-off Crow proposes by voice (a task given to another bot) and
// every spoken "stop it" (kind 'stop'), from the proposal to its end (servers/gateway/voice/
// handoff-store.js). Times are epoch ms written by the store's own clock, so a test's fake clock
// moves them. Status and kind carry no CHECK: the store validates them in JS. The partial unique
// index keeps at most one phone confirmation open per device and kind. LOCAL ONLY: the table is in
// instance-sync's LOCAL_ONLY_TABLES, and no audio is ever stored.
//
// ADDITIVE, no SCHEMA_GENERATION bump: init-db.js carries the same DDL (one shape, two rails, the
// 0005/0009/0010/0011 story), so a co-hosted instance converging on its own restart gets it too. DDL
// only: there is nothing to backfill, and it never drops or deletes.
import Database from "better-sqlite3";

export const id = "0018-voice-handoffs";

// Byte-for-byte the block in scripts/init-db.js ("voice_handoffs table").
export const VOICE_HANDOFFS_DDL = `
  CREATE TABLE IF NOT EXISTS voice_handoffs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL DEFAULT 'handoff',
    surface TEXT NOT NULL, device_id TEXT NOT NULL, device_name TEXT,
    bot_id TEXT NOT NULL, task TEXT NOT NULL, asked TEXT,
    status TEXT NOT NULL,
    card_id INTEGER, session_id TEXT, thread_id TEXT, target_id TEXT,
    model_key TEXT, start_now INTEGER NOT NULL DEFAULT 1,
    outcome TEXT, detail TEXT, lang TEXT,
    created_at INTEGER NOT NULL, expires_at INTEGER, decided_at INTEGER, ended_at INTEGER,
    updated_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_voice_handoffs_device ON voice_handoffs(device_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_voice_handoffs_card ON voice_handoffs(card_id) WHERE card_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_voice_handoffs_status ON voice_handoffs(status, expires_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_voice_handoffs_phone_open ON voice_handoffs(device_id, kind) WHERE status = 'awaiting_phone';
`;

export function run({ dbPath, log = () => {} }) {
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 10000");
  try {
    db.exec(VOICE_HANDOFFS_DDL);
    log("  voice_handoffs: ensured");
  } finally {
    db.close();
  }
  return { applied: true, results: ["voice_handoffs: ensured"] };
}
