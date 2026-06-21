import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { libsqlAdapter } from "../scripts/pi-bots/metering.mjs";

// Minimal schema mirroring init-db.js (matches tests/metering-record.test.js).
export function freshDb() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE pricing_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_id TEXT, provider_type TEXT, model_id TEXT NOT NULL DEFAULT '*',
    input_cost_per_1m REAL NOT NULL, output_cost_per_1m REAL NOT NULL,
    cache_read_cost_per_1m REAL, cache_write_cost_per_1m REAL,
    effective_from TEXT, effective_to TEXT)`);
  db.exec(`CREATE TABLE usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT, conversation_id INTEGER, message_id INTEGER,
    surface TEXT NOT NULL DEFAULT 'chat',
    provider_id TEXT, provider_type TEXT, model_id TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
    cached_tokens INTEGER NOT NULL DEFAULT 0, computed_cost_usd REAL,
    priced INTEGER NOT NULL DEFAULT 0, request_id TEXT,
    created_at TEXT DEFAULT (datetime('now')))`);
  return db;
}

test("libsqlAdapter: SELECT returns {rows}, write returns {rowsAffected}", async () => {
  const a = libsqlAdapter(freshDb());
  const w = await a.execute({
    sql: "INSERT INTO pricing_rules (provider_type, model_id, input_cost_per_1m, output_cost_per_1m) VALUES (?,?,?,?)",
    args: ["together", "*", 0.18, 0.18],
  });
  assert.equal(w.rowsAffected, 1);
  const sel = await a.execute("SELECT * FROM pricing_rules WHERE effective_to IS NULL");
  assert.equal(sel.rows.length, 1);
  assert.equal(sel.rows[0].provider_type, "together");
  assert.equal(sel.rows[0].input_cost_per_1m, 0.18);
});
