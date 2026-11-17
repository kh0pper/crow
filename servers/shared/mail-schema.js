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

// The columns plan 3's A3 adds to mail_accounts, as ADD COLUMN specs rather than part of MAIL_DDL:
// 0027's approved DDL stays exactly as it is, and both rails add these afterwards — init-db.js loops
// this list right after its "mail tables" block, scripts/migrations/0029-mail-account-send-columns.mjs
// runs the same list through the same guard. display_name is the name that goes on From (NULL until
// the operator names the account), aliases_json the account's other addresses (a JSON array, used by
// reply-all) and sent_copy how the Sent copy is kept ('provider' | 'append'). sent_copy's value is
// validated in the account store, never by a CHECK. mail_accounts is LOCAL ONLY, so there is no sync
// column list to change.
export const MAIL_ACCOUNT_SEND_COLUMNS = Object.freeze([
  { table: "mail_accounts", column: "display_name", definition: "TEXT" },
  { table: "mail_accounts", column: "aliases_json", definition: "TEXT NOT NULL DEFAULT '[]'" },
  { table: "mail_accounts", column: "sent_copy", definition: "TEXT NOT NULL DEFAULT 'provider'" },
]);

export const MAIL_TABLES = Object.freeze([
  "mail_accounts",
  "mail_folders",
  "mail_threads",
  "mail_messages",
  "mail_messages_fts",
  "mail_sync_state",
  "mail_image_allow",
]);

// Crow Mail's draft card tables: the draft (one row per card), its immutable revisions (one row per
// version a bot or the person wrote), the person's comments and the voice note for a revision. These
// are a separate constant because 0027 executes MAIL_DDL and its approved shape stays exactly as it
// is: scripts/init-db.js runs this string as "mail draft tables" and
// scripts/migrations/0030-mail-drafts.mjs runs the same string — one shape, two rails.
//
// Epoch-ms times; modes, states, tap actions, revision authors and comment states are validated in
// the draft store (servers/gateway/mail/drafts/store.js), never by a CHECK. No foreign keys: the
// store removes one draft's rows itself. mail_draft_revisions and mail_draft_voice rows are written
// once and never updated, which is what makes a revision the thing the person actually read.
// LOCAL ONLY (instance-sync LOCAL_ONLY_TABLES): a draft holds the recipients and the body, and a
// voice note holds the operator's speech, so none of it leaves this instance. Additive, no
// SCHEMA_GENERATION bump.
//
// The three mail_drafts indexes are the ones the send sweep needs: due schedules by state, the
// ten-second holds by state, and the chat card's lookup by its chat thread. reconcile_count counts
// the Sent-folder checks run for an `unknown` row.
export const MAIL_DRAFTS_DDL = `
  CREATE TABLE IF NOT EXISTS mail_drafts (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    reply_to_mid TEXT,
    thread_key TEXT,
    project_id INTEGER,
    bot_id TEXT,
    chat_thread_id TEXT,
    audience TEXT,
    state TEXT NOT NULL,
    head_rev INTEGER NOT NULL,
    head_hash TEXT NOT NULL,
    due_at INTEGER,
    hold_until INTEGER,
    message_id TEXT,
    claim_token TEXT,
    claimed_at INTEGER,
    attempt_at INTEGER,
    tap_seal TEXT,
    tap_id TEXT,
    tap_action TEXT,
    attach_digest TEXT,
    reconcile_count INTEGER NOT NULL DEFAULT 0,
    next_reconcile_at INTEGER,
    sent_at INTEGER,
    fail_reason TEXT,
    notified_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_mail_drafts_state_due ON mail_drafts(state, due_at);
  CREATE INDEX IF NOT EXISTS idx_mail_drafts_state_hold ON mail_drafts(state, hold_until);
  CREATE INDEX IF NOT EXISTS idx_mail_drafts_chat_thread ON mail_drafts(chat_thread_id);

  CREATE TABLE IF NOT EXISTS mail_draft_revisions (
    draft_id TEXT NOT NULL,
    rev INTEGER NOT NULL,
    author TEXT NOT NULL,
    to_json TEXT NOT NULL,
    cc_json TEXT NOT NULL,
    bcc_json TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    in_reply_to TEXT,
    references_json TEXT,
    attachments_json TEXT NOT NULL,
    from_json TEXT NOT NULL,
    mode TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    note TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (draft_id, rev)
  );

  CREATE TABLE IF NOT EXISTS mail_draft_voice (
    draft_id TEXT NOT NULL,
    rev INTEGER NOT NULL,
    voice_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (draft_id, rev)
  );

  CREATE TABLE IF NOT EXISTS mail_draft_comments (
    id TEXT PRIMARY KEY,
    draft_id TEXT NOT NULL,
    rev INTEGER NOT NULL,
    line_index INTEGER,
    quote TEXT,
    text TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`;

export const MAIL_DRAFT_TABLES = Object.freeze([
  "mail_drafts",
  "mail_draft_revisions",
  "mail_draft_voice",
  "mail_draft_comments",
]);
