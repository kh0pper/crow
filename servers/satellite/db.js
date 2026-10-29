/**
 * satellite.db (SAT-3, spec §6.3): the agent's only database, under $SAT_HOME, mode 0600.
 * Independent of crow's crow.db and of SCHEMA_GENERATION: its own version lives in `meta`
 * (`sat_schema_version`), and a tiny runner applies each numbered migration in a transaction.
 *
 * `crow_keychain` is crow's keychain table verbatim (KEYCHAIN_DDL + the service index), so the
 * keychain core runs on it unchanged.
 */
import Database from "better-sqlite3";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { KEYCHAIN_DDL, KEYCHAIN_SERVICE_INDEX_DDL } from "../gateway/keychain/schema.js";

export const SAT_SCHEMA_VERSION = 1;
export const SATELLITE_DB_FILE = "satellite.db";
const VERSION_KEY = "sat_schema_version";

const V1 = `
  CREATE TABLE IF NOT EXISTS jobs (
    id           TEXT PRIMARY KEY,
    bundle_id    TEXT,
    action       TEXT NOT NULL,
    status       TEXT NOT NULL,
    log_json     TEXT NOT NULL DEFAULT '[]',
    started_at   TEXT NOT NULL,
    completed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS nonces (
    nonce   TEXT PRIMARY KEY,
    seen_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_nonces_seen ON nonces (seen_at);
  CREATE TABLE IF NOT EXISTS pair_codes (
    code_hash   TEXT PRIMARY KEY,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    used_at     INTEGER,
    wrong_tries INTEGER NOT NULL DEFAULT 0,
    voided_at   INTEGER
  );
  CREATE TABLE IF NOT EXISTS pair_nonces (
    nonce_s   TEXT PRIMARY KEY,
    nonce_c   TEXT NOT NULL,
    issued_at INTEGER NOT NULL,
    used_at   INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_pair_nonces_issued ON pair_nonces (issued_at);
  CREATE TABLE IF NOT EXISTS cert_serials (
    serial      TEXT PRIMARY KEY,
    accepted_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS audit (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    ts     TEXT NOT NULL,
    route  TEXT NOT NULL,
    caller TEXT,
    result TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit (ts);
  CREATE TABLE IF NOT EXISTS tool_cache (
    bundle     TEXT PRIMARY KEY,
    version    TEXT,
    tools_json TEXT NOT NULL,
    sha256     TEXT NOT NULL,
    cached_at  TEXT NOT NULL
  );
  ${KEYCHAIN_DDL}
  ${KEYCHAIN_SERVICE_INDEX_DDL}
`;

/** Ordered migrations; each runs once, in a transaction, then bumps meta. */
export const MIGRATIONS = Object.freeze([{ version: 1, up: (db) => db.exec(V1) }]);

export function currentVersion(db) {
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(VERSION_KEY);
  return row ? Number(row.value) : 0;
}

export function migrate(db, migrations = MIGRATIONS) {
  const have = currentVersion(db);
  const newest = migrations.reduce((m, x) => Math.max(m, x.version), 0);
  if (have > newest) throw new Error(`satellite.db is at schema ${have}, newer than this agent (${newest})`);
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (m.version <= have) continue;
    db.transaction(() => {
      m.up(db);
      db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(VERSION_KEY, String(m.version));
    })();
  }
  return currentVersion(db);
}

function tighten(path) {
  for (const p of [path, `${path}-wal`, `${path}-shm`]) {
    try { if (existsSync(p)) chmodSync(p, 0o600); } catch { /* best effort */ }
  }
}

/** Open (creating at 0600) and migrate $SAT_HOME/satellite.db. */
export function openSatelliteDb(satHome) {
  mkdirSync(satHome, { recursive: true, mode: 0o700 });
  const path = join(satHome, SATELLITE_DB_FILE);
  if (!existsSync(path)) closeSync(openSync(path, "a", 0o600));
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  migrate(db);
  tighten(path);
  return db;
}
