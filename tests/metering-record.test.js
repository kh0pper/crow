import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";

import { recordUsageEvent } from "../servers/shared/metering.js";

// Minimal schema mirroring init-db.js for an isolated writer test.
async function db0() {
  const db = createClient({ url: ":memory:" });
  await db.execute(`CREATE TABLE pricing_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_id TEXT, provider_type TEXT, model_id TEXT NOT NULL DEFAULT '*',
    input_cost_per_1m REAL NOT NULL, output_cost_per_1m REAL NOT NULL,
    cache_read_cost_per_1m REAL, cache_write_cost_per_1m REAL,
    effective_from TEXT, effective_to TEXT)`);
  await db.execute(`CREATE TABLE usage_events (
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

test("recordUsageEvent prices a matching rule and writes a priced usage_event", async () => {
  const db = await db0();
  await db.execute({
    sql: `INSERT INTO pricing_rules (provider_type, model_id, input_cost_per_1m, output_cost_per_1m)
          VALUES ('together', 'llama-3.1-8b', 0.18, 0.18)`,
    args: [],
  });

  const result = await recordUsageEvent(db, {
    tenantId: "district-1",
    conversationId: 42,
    surface: "chat",
    providerId: "cloud-together-main",
    providerType: "together",
    modelId: "llama-3.1-8b",
    inputTokens: 2_000_000,
    outputTokens: 1_000_000,
  });

  assert.equal(result.priced, true);
  assert.ok(Math.abs(result.cost - 0.54) < 1e-9);

  const { rows } = await db.execute("SELECT * FROM usage_events");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tenant_id, "district-1");
  assert.equal(Number(rows[0].priced), 1);
  assert.ok(Math.abs(Number(rows[0].computed_cost_usd) - 0.54) < 1e-9);
  assert.equal(Number(rows[0].input_tokens), 2_000_000);
});

test("recordUsageEvent records an UNPRICED event when no rule matches (never drops it)", async () => {
  const db = await db0();
  const result = await recordUsageEvent(db, {
    tenantId: "district-1",
    surface: "chat",
    providerId: "cloud-mystery",
    providerType: "mystery",
    modelId: "unknown-model",
    inputTokens: 1000,
    outputTokens: 500,
  });

  assert.equal(result.priced, false);
  assert.equal(result.cost, null);

  const { rows } = await db.execute("SELECT priced, computed_cost_usd FROM usage_events");
  assert.equal(rows.length, 1, "unmatched usage is still recorded for backfill");
  assert.equal(Number(rows[0].priced), 0);
  assert.equal(rows[0].computed_cost_usd, null);
});
