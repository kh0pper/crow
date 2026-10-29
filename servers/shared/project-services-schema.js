/**
 * Project services schema — DDL constants only, side-effect free, no imports. One shape, two
 * rails: scripts/init-db.js (fresh installs and every init-db run) and
 * scripts/migrations/0019-project-services.mjs (existing instances, no SCHEMA_GENERATION bump)
 * both build from these strings, so the two can never drift. The keychain and bot_jobs lazy
 * ensures (keychain/store.js ensureKeychainTable, pi-bots/bot-jobs-schema.mjs) read the same
 * constants.
 *
 * service_connections is LOCAL ONLY (instance-sync LOCAL_ONLY_TABLES): a connection names an
 * account on this machine, and its secrets live in the local-only keychain.
 *
 * No CHECK constraints: method and status are validated in the store (the keychain's rule), so a
 * new value never needs a table rebuild. owner_contact_id carries no foreign key, so deleting a
 * contact is never blocked. The slug index wraps owner_contact_id in IFNULL because SQLite treats
 * NULLs as distinct in a UNIQUE index; without it two project-wide (owner NULL) connections could
 * share a slug.
 */

export const SERVICE_CONNECTIONS_DDL = `
  CREATE TABLE IF NOT EXISTS service_connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT NOT NULL UNIQUE,
    project_id INTEGER NOT NULL REFERENCES project_spaces(id) ON DELETE CASCADE,
    owner_contact_id INTEGER,
    service_id TEXT NOT NULL,
    bundle_id TEXT,
    method TEXT NOT NULL,
    account_label TEXT NOT NULL,
    label_slug TEXT NOT NULL,
    config TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    source_connection_id INTEGER,
    last_tested_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_service_connections_slug
    ON service_connections(project_id, IFNULL(owner_contact_id, 0), service_id, label_slug)
    WHERE status != 'disconnected';
  CREATE INDEX IF NOT EXISTS idx_service_connections_project ON service_connections(project_id, status);
  CREATE INDEX IF NOT EXISTS idx_service_connections_bundle ON service_connections(bundle_id);
`;

/** The project a chat belongs to. No backfill: existing threads stay in "Everything". */
export const CHAT_PROJECT_COLUMN = Object.freeze({
  table: "chat_conversations",
  column: "project_id",
  ddl: "ALTER TABLE chat_conversations ADD COLUMN project_id INTEGER",
});

/** Links a keychain secret (kind 'service') to its service_connections row by uuid. */
export const KEYCHAIN_CONNECTION_COLUMN = Object.freeze({
  table: "crow_keychain",
  column: "connection_uuid",
  ddl: "ALTER TABLE crow_keychain ADD COLUMN connection_uuid TEXT",
});

/** Who started a bot job ('owner' | 'other' …; NULL fails closed). */
export const BOT_JOBS_PRINCIPAL_COLUMN = Object.freeze({
  table: "bot_jobs",
  column: "principal",
  ddl: "ALTER TABLE bot_jobs ADD COLUMN principal TEXT",
});

/**
 * Kept apart from KEYCHAIN_DDL on purpose: on a pre-0019 crow_keychain, an index on
 * connection_uuid inside KEYCHAIN_DDL would fail before the ALTER that adds the column runs.
 */
export const KEYCHAIN_SERVICE_INDEX_DDL = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_crow_keychain_service ON crow_keychain (connection_uuid, env_key) WHERE kind = 'service';
`;
