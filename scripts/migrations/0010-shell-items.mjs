// scripts/migrations/0010-shell-items.mjs
//
// shell_items: which project a Perch thread, an artifact or a Workspace file belongs to.
// project_id NULL means Unassigned; there is deliberately no foreign key, so deleting a project
// can never cascade an item away.
//
// ADDITIVE, no SCHEMA_GENERATION bump: init-db.js carries the same DDL (one shape, two rails, the
// 0005/0009 story), so a co-hosted instance converging on its own restart gets it too.
import Database from "better-sqlite3";

export const id = "0010-shell-items";

// Byte-for-byte the block in scripts/init-db.js ("shell_items table").
export const SHELL_ITEMS_DDL = `
  CREATE TABLE IF NOT EXISTS shell_items (
    item_kind    TEXT NOT NULL CHECK (item_kind IN ('perch_thread','artifact','workspace_file')),
    item_ref     TEXT NOT NULL,
    project_id   INTEGER,
    card_id      INTEGER,
    set_by       TEXT NOT NULL CHECK (set_by IN ('backfill','origin','operator')),
    seen_version INTEGER,
    seen_at      TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (item_kind, item_ref),
    CHECK (item_kind != 'perch_thread' OR card_id IS NULL)
  );
  CREATE INDEX IF NOT EXISTS idx_shell_items_project ON shell_items(project_id, item_kind);
  CREATE INDEX IF NOT EXISTS idx_shell_items_card ON shell_items(card_id) WHERE card_id IS NOT NULL;
`;

export function run({ dbPath, tasksDbPath, log = () => {} }) {
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 10000");
  const results = [];
  try {
    db.exec(SHELL_ITEMS_DDL);
    results.push("shell_items: ensured");
    log("  shell_items: ensured");
  } finally {
    db.close();
  }
  return { applied: true, results };
}
