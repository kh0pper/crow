/**
 * Crow Mail's local-only tables, DDL constants only (side-effect free, no imports). One shape, two
 * rails: scripts/init-db.js ("mail tables") and scripts/migrations/0027-mail-store.mjs both build
 * from this string. Every table is LOCAL ONLY (instance-sync LOCAL_ONLY_TABLES): the user's
 * mailboxes, folders, threads and messages, the FTS5 index over them, the per-account sync state and
 * the remote-image allow list never leave the instance holding them. Epoch-ms times; statuses are
 * validated in the store, never by a CHECK. No foreign keys: the store removes one account's rows in
 * one transaction. No SCHEMA_GENERATION bump.
 *
 * MAIL_TABLES lists the tables themselves. The fts5 shadow tables (mail_messages_fts_data, _idx,
 * _docsize, _config) belong to mail_messages_fts and are not separate entries.
 *
 * mail_messages_fts follows the memories_fts pattern: an external-content index over the four
 * searchable columns, kept in step by its own triggers. The update trigger is `AFTER UPDATE OF` those
 * four columns only, so flag and read-state writes never touch the index.
 *
 * Writes to mail_messages must be `INSERT ... ON CONFLICT(folder_id, uid) DO UPDATE`, never
 * `INSERT OR REPLACE` / `REPLACE` (and never a bare DELETE + INSERT for a row that keeps its uid):
 * crow does not turn on SQLite's recursive_triggers, so the implicit DELETE that REPLACE performs to
 * clear the conflicting row does NOT fire mail_messages_ad. The old row's terms stay in
 * mail_messages_fts, pointing at a rowid the content table no longer has. The upsert is a real
 * UPDATE, so mail_messages_au re-indexes the row.
 */

export const MAIL_DDL = `
  CREATE TABLE IF NOT EXISTS mail_accounts (
    id TEXT PRIMARY KEY,
    address TEXT NOT NULL UNIQUE COLLATE NOCASE,
    label TEXT NOT NULL,
    provider TEXT,
    imap_host TEXT NOT NULL,
    imap_port INTEGER NOT NULL,
    imap_security TEXT NOT NULL DEFAULT 'ssl',
    smtp_host TEXT NOT NULL,
    smtp_port INTEGER NOT NULL,
    smtp_security TEXT NOT NULL DEFAULT 'ssl',
    username TEXT,
    auth_kind TEXT NOT NULL DEFAULT 'password',
    status TEXT NOT NULL DEFAULT 'active',
    status_detail TEXT,
    window_days INTEGER NOT NULL DEFAULT 90,
    local_models_only INTEGER NOT NULL DEFAULT 0,
    digest_opt_in INTEGER NOT NULL DEFAULT 0,
    digest_time TEXT NOT NULL DEFAULT '07:00',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_sync_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS mail_folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    path TEXT NOT NULL,
    name TEXT,
    special_use TEXT,
    delimiter TEXT,
    uid_validity INTEGER,
    highest_uid INTEGER NOT NULL DEFAULT 0,
    floor_uid INTEGER,
    last_synced_at INTEGER,
    UNIQUE (account_id, path)
  );

  CREATE TABLE IF NOT EXISTS mail_threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    thread_key TEXT NOT NULL,
    subject TEXT,
    last_date INTEGER,
    message_count INTEGER NOT NULL DEFAULT 0,
    unread_count INTEGER NOT NULL DEFAULT 0,
    UNIQUE (account_id, thread_key)
  );

  CREATE INDEX IF NOT EXISTS idx_mail_threads_account_last ON mail_threads(account_id, last_date DESC);

  CREATE TABLE IF NOT EXISTS mail_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    folder_id INTEGER NOT NULL,
    uid INTEGER NOT NULL,
    thread_id INTEGER,
    message_id TEXT,
    in_reply_to TEXT,
    references_json TEXT,
    subject TEXT NOT NULL DEFAULT '',
    from_name TEXT,
    from_addr TEXT,
    from_text TEXT NOT NULL DEFAULT '',
    to_json TEXT,
    cc_json TEXT,
    reply_to_json TEXT,
    to_text TEXT NOT NULL DEFAULT '',
    date INTEGER NOT NULL,
    flags_json TEXT,
    is_read INTEGER NOT NULL DEFAULT 0,
    has_attachments INTEGER NOT NULL DEFAULT 0,
    attachments_json TEXT,
    snippet TEXT,
    body_text TEXT,
    body_html TEXT,
    truncated INTEGER NOT NULL DEFAULT 0,
    parse_error TEXT,
    UNIQUE (folder_id, uid)
  );

  CREATE INDEX IF NOT EXISTS idx_mail_messages_folder_date ON mail_messages(folder_id, date DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_mail_messages_account_date ON mail_messages(account_id, date DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_mail_messages_thread ON mail_messages(thread_id);
  CREATE INDEX IF NOT EXISTS idx_mail_messages_message_id ON mail_messages(account_id, message_id);
  CREATE INDEX IF NOT EXISTS idx_mail_messages_in_reply_to ON mail_messages(account_id, in_reply_to);

  CREATE VIRTUAL TABLE IF NOT EXISTS mail_messages_fts USING fts5(
    subject, from_text, to_text, body_text,
    content=mail_messages,
    content_rowid=id,
    tokenize='unicode61 remove_diacritics 2'
  );

  CREATE TRIGGER IF NOT EXISTS mail_messages_ai AFTER INSERT ON mail_messages BEGIN
    INSERT INTO mail_messages_fts(rowid, subject, from_text, to_text, body_text)
    VALUES (new.id, new.subject, new.from_text, new.to_text, new.body_text);
  END;

  CREATE TRIGGER IF NOT EXISTS mail_messages_ad AFTER DELETE ON mail_messages BEGIN
    INSERT INTO mail_messages_fts(mail_messages_fts, rowid, subject, from_text, to_text, body_text)
    VALUES ('delete', old.id, old.subject, old.from_text, old.to_text, old.body_text);
  END;

  CREATE TRIGGER IF NOT EXISTS mail_messages_au AFTER UPDATE OF subject, from_text, to_text, body_text ON mail_messages BEGIN
    INSERT INTO mail_messages_fts(mail_messages_fts, rowid, subject, from_text, to_text, body_text)
    VALUES ('delete', old.id, old.subject, old.from_text, old.to_text, old.body_text);
    INSERT INTO mail_messages_fts(rowid, subject, from_text, to_text, body_text)
    VALUES (new.id, new.subject, new.from_text, new.to_text, new.body_text);
  END;

  CREATE TABLE IF NOT EXISTS mail_sync_state (
    account_id TEXT PRIMARY KEY,
    state TEXT NOT NULL DEFAULT 'idle',
    error_code TEXT,
    failures INTEGER NOT NULL DEFAULT 0,
    backoff_until INTEGER,
    last_success_at INTEGER,
    last_notice_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS mail_image_allow (
    account_id TEXT NOT NULL,
    sender TEXT NOT NULL COLLATE NOCASE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, sender)
  );
`;

export const MAIL_TABLES = Object.freeze([
  "mail_accounts",
  "mail_folders",
  "mail_threads",
  "mail_messages",
  "mail_messages_fts",
  "mail_sync_state",
  "mail_image_allow",
]);
