/**
 * Crow Messages' draft tables, DDL constants only (side-effect free, no imports). One shape, two
 * rails: scripts/init-db.js ("message draft tables") and
 * scripts/migrations/0036-message-drafts.mjs both build from this string. (0034 and 0035 are skipped on
 * purpose: those numbers belong to the reports stack, and the runner applies a migration by its id, so
 * a gap between numbers costs nothing.)
 *
 * A draft is one row in `message_drafts`: the conversation it belongs to (`contact` or `room` and
 * that conversation's local id), who wrote it (`owner`, or `bot` with the bot's id), the body, and
 * the version an autosave compares against. A bot's message is ALWAYS a draft in v1 — it never
 * reaches a conversation by itself; the owner reads it and sends it.
 *
 * Two rules are enforced by the shape rather than by a caller:
 *   - AT MOST ONE OPEN DRAFT PER CONVERSATION: `idx_message_drafts_open` is a PARTIAL UNIQUE index
 *     over (conversation_kind, conversation_id) WHERE state = 'open'. A second INSERT collides, and
 *     the store turns that collision into an update of the row already there.
 *   - THE RECIPIENTS ARE SEALED: `recipients_json` is the audience the message will reach, one entry
 *     per person — `{contact_id, crow_id, secp256k1_pubkey}`, the key being the SNAPSHOT taken when
 *     the draft was written — and `recipients_seal` is an HMAC over the draft's identity (id, origin,
 *     bot id and name, created_at) and that snapshot under a subkey of this instance's keychain key
 *     (servers/gateway/messages/drafts-seal.js). A bot can write a body; it cannot mint a seal, and a
 *     recipient whose key changed since the snapshot is refused at send, so a send that finds a seal
 *     it did not write refuses instead of delivering to somebody else.
 *
 * `message_draft_audit` is the trail: one row per create, edit, send and discard, carrying the
 * draft id, the action, who did it, the resulting version and HASHES of the body and the recipient
 * set. It never carries the message text: a draft body is the operator's words, and the audit table
 * is the one place a compromised reader would look for them.
 *
 * Epoch-ms times; conversation kinds, origins, states and audit actions are validated in the store
 * (servers/gateway/messages/drafts-store.js), never by a CHECK. No foreign keys: a conversation
 * lives in another table (contacts / contact_groups) and the store removes one draft's rows itself.
 * LOCAL ONLY: both names are in instance-sync's LOCAL_ONLY_TABLES, because a draft holds who a
 * message is for and the words of it, and neither leaves the instance that wrote them.
 *
 * Additive, no SCHEMA_GENERATION bump: init-db.js runs this string on its own rail, so a co-hosted
 * instance converging on its own restart gets it too. DDL only: nothing to backfill, and no schema
 * object or row is removed.
 */
export const MESSAGE_DRAFTS_DDL = `
  CREATE TABLE IF NOT EXISTS message_drafts (
    id TEXT PRIMARY KEY,
    conversation_kind TEXT NOT NULL,
    conversation_id INTEGER NOT NULL,
    origin TEXT NOT NULL,
    bot_id TEXT,
    bot_name TEXT,
    project_id INTEGER,
    state TEXT NOT NULL DEFAULT 'open',
    version INTEGER NOT NULL DEFAULT 1,
    body TEXT NOT NULL DEFAULT '',
    body_hash TEXT NOT NULL,
    recipients_json TEXT NOT NULL DEFAULT '[]',
    recipients_seal TEXT NOT NULL,
    sent_at INTEGER,
    sent_message_id TEXT,
    fail_reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_message_drafts_open
    ON message_drafts(conversation_kind, conversation_id) WHERE state = 'open';

  CREATE INDEX IF NOT EXISTS idx_message_drafts_conversation
    ON message_drafts(conversation_kind, conversation_id, updated_at DESC);

  CREATE INDEX IF NOT EXISTS idx_message_drafts_state
    ON message_drafts(state, updated_at DESC);

  CREATE TABLE IF NOT EXISTS message_draft_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    draft_id TEXT NOT NULL,
    action TEXT NOT NULL,
    actor TEXT NOT NULL,
    actor_id TEXT,
    version INTEGER NOT NULL,
    body_hash TEXT NOT NULL,
    recipients_seal TEXT NOT NULL,
    at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_message_draft_audit_draft
    ON message_draft_audit(draft_id, at);
`;

export const MESSAGE_DRAFT_TABLES = Object.freeze(["message_drafts", "message_draft_audit"]);

/**
 * `message_drafts.bot_name`: the display name of the bot that wrote the draft, snapshotted when the
 * draft was written and covered by the seal (the "Sent by <bot>" line reads from it). It is its own
 * constant because a store created from an earlier build of this branch has the table already and
 * `CREATE TABLE IF NOT EXISTS` would leave the column out — both rails add it with this exact ALTER.
 */
export const MESSAGE_DRAFTS_BOT_NAME_COLUMN = Object.freeze({
  table: "message_drafts",
  column: "bot_name",
  ddl: "ALTER TABLE message_drafts ADD COLUMN bot_name TEXT",
});