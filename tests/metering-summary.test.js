import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";

import { summarizeUsage } from "../servers/shared/metering.js";

async function db0() {
  const db = createClient({ url: ":memory:" });
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

async function seed(db, rows) {
  for (const r of rows) {
    await db.execute({
      sql: `INSERT INTO usage_events
              (provider_id, model_id, input_tokens, output_tokens, computed_cost_usd, priced)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [r.provider_id, r.model_id, r.input, r.output, r.cost, r.priced],
    });
  }
}

test("summarizeUsage totals tokens and cost across events", async () => {
  const db = await db0();
  await seed(db, [
    { provider_id: "together", model_id: "llama-8b", input: 1000, output: 200, cost: 0.5, priced: 1 },
    { provider_id: "together", model_id: "llama-8b", input: 2000, output: 300, cost: 1.5, priced: 1 },
  ]);

  const s = await summarizeUsage(db);
  assert.equal(s.totals.events, 2);
  assert.equal(s.totals.inputTokens, 3000);
  assert.equal(s.totals.outputTokens, 500);
  assert.ok(Math.abs(s.totals.costUsd - 2.0) < 1e-9);
  assert.equal(s.unpricedEvents, 0);
});

test("summarizeUsage counts unpriced events (coverage gap) and ignores their null cost", async () => {
  const db = await db0();
  await seed(db, [
    { provider_id: "together", model_id: "llama-8b", input: 100, output: 20, cost: 0.1, priced: 1 },
    { provider_id: "mystery", model_id: "unknown", input: 999, output: 99, cost: null, priced: 0 },
  ]);

  const s = await summarizeUsage(db);
  assert.equal(s.totals.events, 2);
  assert.equal(s.unpricedEvents, 1);
  assert.ok(Math.abs(s.totals.costUsd - 0.1) < 1e-9, "null costs don't corrupt the total");
});

test("summarizeUsage groups by provider+model, sorted by cost desc", async () => {
  const db = await db0();
  await seed(db, [
    { provider_id: "together", model_id: "llama-8b", input: 100, output: 10, cost: 0.2, priced: 1 },
    { provider_id: "together", model_id: "llama-70b", input: 100, output: 10, cost: 5.0, priced: 1 },
  ]);

  const s = await summarizeUsage(db);
  assert.equal(s.byProvider.length, 2);
  assert.equal(s.byProvider[0].modelId, "llama-70b", "most expensive first");
  assert.ok(Math.abs(s.byProvider[0].costUsd - 5.0) < 1e-9);
  assert.equal(s.byProvider[1].modelId, "llama-8b");
});
