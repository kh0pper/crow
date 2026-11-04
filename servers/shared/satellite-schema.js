/**
 * Satellite tables, DDL constants only (side-effect free, no imports). One shape, two rails:
 * scripts/init-db.js and scripts/migrations/0021-satellites.mjs both build from these strings.
 * Every table is LOCAL ONLY (instance-sync LOCAL_ONLY_TABLES): a satellite belongs to the instance
 * that paired it. No SCHEMA_GENERATION bump.
 */

export const SATELLITES_DDL = `
  CREATE TABLE IF NOT EXISTS satellites (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    tailnet_host TEXT NOT NULL,
    satellite_pubkey TEXT NOT NULL,
    mgmt_pubkey TEXT NOT NULL,
    cert_json TEXT NOT NULL,
    cert_serial TEXT NOT NULL,
    cert_expires_at TEXT NOT NULL,
    primary_url TEXT NOT NULL,
    agent_protocol INTEGER,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','unreachable','revoked')),
    last_status_json TEXT,
    last_seen_at TEXT,
    unreachable_since TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    revoked_at TEXT
  );
`;

export const SATELLITE_REVOCATIONS_DDL = `
  CREATE TABLE IF NOT EXISTS satellite_revocations (
    serial TEXT PRIMARY KEY,
    satellite_id TEXT NOT NULL,
    revoked_at TEXT NOT NULL,
    reason TEXT,
    payload_json TEXT NOT NULL,
    sig TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_satellite_revocations_satellite ON satellite_revocations(satellite_id);
`;

export const SATELLITE_TOOL_PINS_DDL = `
  CREATE TABLE IF NOT EXISTS satellite_tool_pins (
    satellite_id TEXT NOT NULL,
    bundle TEXT NOT NULL,
    version TEXT,
    tools_sha256 TEXT NOT NULL,
    tools_json TEXT NOT NULL,
    read_marks_json TEXT NOT NULL DEFAULT '[]',
    approved_at TEXT NOT NULL,
    PRIMARY KEY (satellite_id, bundle)
  );
`;

export const SATELLITE_BOT_OPTINS_DDL = `
  CREATE TABLE IF NOT EXISTS satellite_bot_optins (
    bot_id TEXT PRIMARY KEY,
    any_turn INTEGER NOT NULL DEFAULT 0 CHECK (any_turn IN (0,1)),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

export const SATELLITE_TABLES = Object.freeze(["satellites", "satellite_revocations", "satellite_tool_pins", "satellite_bot_optins"]);

export const SATELLITE_DDL = SATELLITES_DDL + SATELLITE_REVOCATIONS_DDL + SATELLITE_TOOL_PINS_DDL + SATELLITE_BOT_OPTINS_DDL;
