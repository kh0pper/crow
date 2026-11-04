// scripts/migrations/0016-crow-to-crow.mjs
//
// Crow-to-Crow foundation: project_members.accepted_at plus the tables the frame transport builds on
// (project_shared_items, c2c_outbox, c2c_outbox_seq, c2c_inbound_seq, c2c_visits). The same DDL lives
// in scripts/init-db.js (one shape, two rails). ADDITIVE, no SCHEMA_GENERATION bump, idempotent.
// The four c2c_* tables are local-only (see LOCAL_ONLY_TABLES in servers/sharing/instance-sync.js).
import Database from "better-sqlite3";
import { addColumnIfMissing } from "./0006-bot-sessions-archived.mjs";

export const id = "0016-crow-to-crow";

export const C2C_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS project_shared_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL REFERENCES project_spaces(id) ON DELETE CASCADE,
    item_kind   TEXT NOT NULL CHECK (item_kind IN ('card','artifact','workspace_file')),
    item_ref    TEXT NOT NULL,
    share_ref   TEXT NOT NULL UNIQUE DEFAULT (lower(hex(randomblob(16)))),
    added_at    TEXT NOT NULL DEFAULT (datetime('now')),
    removed_at  TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_project_shared_items_live
    ON project_shared_items(project_id, item_kind, item_ref) WHERE removed_at IS NULL;

  CREATE TABLE IF NOT EXISTS c2c_outbox (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id      INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    project_uuid    TEXT NOT NULL,
    seq             INTEGER NOT NULL,
    kind            TEXT NOT NULL,
    to_instance_id  TEXT,
    frame_json      TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    attempts        INTEGER NOT NULL DEFAULT 0,
    last_attempt_at TEXT,
    last_refusal    TEXT,
    acked_at        TEXT
  );

  -- A seq is unique per stream (R1): the same number names different frames on
  -- different targets, so the old (contact, project, seq) key would collide.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_c2c_outbox_stream_seq
    ON c2c_outbox(contact_id, project_uuid, COALESCE(to_instance_id, '*'), seq);

  -- The sender's stream counter: one row per (contact, project, stream), never derived from
  -- MAX(seq) over c2c_outbox, so pruning never re-issues a seq (outbox.js R2).
  CREATE TABLE IF NOT EXISTS c2c_outbox_seq (
    contact_id   INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    project_uuid TEXT NOT NULL,
    stream       TEXT NOT NULL,
    next_seq     INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (contact_id, project_uuid, stream)
  );

  -- One high-water mark per stream: the frame's to_instance_id, or '*' when it has none
  -- (outbox.js R1). The epoch column orders streams: a newer-epoch invite resets one (R3).
  CREATE TABLE IF NOT EXISTS c2c_inbound_seq (
    contact_id         INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    sender_instance_id TEXT NOT NULL,
    project_uuid       TEXT NOT NULL,
    stream             TEXT NOT NULL DEFAULT '*',
    high_water         INTEGER NOT NULL DEFAULT 0,
    epoch              TEXT,
    PRIMARY KEY (contact_id, sender_instance_id, project_uuid, stream)
  );

  CREATE TABLE IF NOT EXISTS c2c_visits (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_contact_id  INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    project_uuid      TEXT NOT NULL,
    name              TEXT NOT NULL,
    role              TEXT NOT NULL CHECK (role IN ('viewer','commenter','editor')),
    epoch             TEXT NOT NULL,
    owner_instance_id TEXT,
    state             TEXT NOT NULL CHECK (state IN ('invited','active','declined','left','unshared')),
    invited_at        TEXT NOT NULL DEFAULT (datetime('now')),
    accepted_at       TEXT,
    ended_at          TEXT,
    UNIQUE (owner_contact_id, project_uuid)
  );
`;

export function run({ dbPath, log = () => {} }) {
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 10000");
  try {
    const has = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
    // The new tables reference project_spaces and contacts; project_members must exist for the column.
    if (!has("project_members") || !has("contacts") || !has("project_spaces")) {
      return { deferred: true };
    }
    const col = addColumnIfMissing(db, "project_members", "accepted_at", "TEXT");
    log(`  project_members.accepted_at: ${col}`);
    db.exec(C2C_TABLES_SQL);
    return { applied: true, results: [col] };
  } finally {
    db.close();
  }
}
