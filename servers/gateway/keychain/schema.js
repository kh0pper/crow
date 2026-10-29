/**
 * crow_keychain DDL — side-effect free; imported by scripts/init-db.js (fresh installs)
 * and by keychain/store.js ensureKeychainTable (existing installs). Additive: no
 * SCHEMA_GENERATION bump. LOCAL-ONLY: listed in instance-sync LOCAL_ONLY_TABLES.
 * No CHECK constraints (review S8): enum values are validated in store.js, so a new
 * value never needs a table rebuild.
 *
 * connection_uuid (migration 0019) links a kind 'service' secret to its service_connections row.
 * It is the LAST column so a fresh table and an ALTERed old one have the same shape. Its unique
 * index is KEYCHAIN_SERVICE_INDEX_DDL, kept out of KEYCHAIN_DDL: on a pre-0019 table that index
 * would fail before the ALTER runs (ensureKeychainTable adds the column first).
 */
import { KEYCHAIN_CONNECTION_COLUMN, KEYCHAIN_SERVICE_INDEX_DDL } from "../../shared/project-services-schema.js";

export { KEYCHAIN_CONNECTION_COLUMN, KEYCHAIN_SERVICE_INDEX_DDL };

export const KEYCHAIN_DDL = `
  CREATE TABLE IF NOT EXISTS crow_keychain (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    kind             TEXT NOT NULL,
    label            TEXT NOT NULL,
    bundle_id        TEXT,
    env_key          TEXT,
    username         TEXT,
    url              TEXT,
    secret_sealed    TEXT NOT NULL,
    key_id           TEXT NOT NULL,
    origin           TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'active',
    first_view_until TEXT,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    connection_uuid  TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_crow_keychain_ext
    ON crow_keychain (bundle_id, env_key) WHERE kind = 'extension';
`;
