/**
 * crow_keychain DDL — side-effect free; imported by scripts/init-db.js (fresh installs)
 * and by keychain/store.js ensureKeychainTable (existing installs). Additive: no
 * SCHEMA_GENERATION bump. LOCAL-ONLY: listed in instance-sync LOCAL_ONLY_TABLES.
 * No CHECK constraints (review S8): enum values are validated in store.js, so a new
 * value never needs a table rebuild.
 */
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
    updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_crow_keychain_ext
    ON crow_keychain (bundle_id, env_key) WHERE kind = 'extension';
`;
