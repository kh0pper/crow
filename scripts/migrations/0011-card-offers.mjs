// scripts/migrations/0011-card-offers.mjs
//
// card_offers: a card a bot offered in a Perch chat, waiting for the operator's one tap. The
// accepted card lives on the bot's own board project (project_id, fixed at offer time). card_id
// is set once the card exists; claim_token + lease_until guard the window between the accept's
// claim and that settle (servers/gateway/board/offer-service.js). note_delivered_at marks the one
// "[Crow] The operator made card #<n> from your offer." line the bot hears on its next turn.
//
// ADDITIVE, no SCHEMA_GENERATION bump: init-db.js carries the same DDL (one shape, two rails, the
// 0005/0009/0010 story), so a co-hosted instance converging on its own restart gets it too. DDL
// only: there is nothing to backfill, and it never drops or deletes.
import Database from "better-sqlite3";

export const id = "0011-card-offers";

// Byte-for-byte the block in scripts/init-db.js ("card_offers table").
export const CARD_OFFERS_DDL = `
  CREATE TABLE IF NOT EXISTS card_offers (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id            TEXT NOT NULL,
    thread_id         TEXT NOT NULL,
    title             TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
    project_id        INTEGER NOT NULL,
    status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined')),
    card_id           INTEGER,
    note_delivered_at TEXT,
    claim_token       TEXT,
    lease_until       TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    decided_at        TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_card_offers_thread ON card_offers(thread_id, status);
`;

export function run({ dbPath, log = () => {} }) {
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 10000");
  try {
    db.exec(CARD_OFFERS_DDL);
    log("  card_offers: ensured");
  } finally {
    db.close();
  }
  return { applied: true, results: ["card_offers: ensured"] };
}
