import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { libsqlAdapter, meterBotTurn, tokenDelta } from "../scripts/pi-bots/metering.mjs";
import { resolveTenantId } from "../servers/shared/tenancy.js";

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

test("tokenDelta clamps compaction-induced negatives to 0 and flags", () => {
  const warns = [];
  const d = tokenDelta(
    { input: 500, output: 50, cacheRead: 0 },
    { input: 480, output: 60, cacheRead: 0 },
    (m) => warns.push(m),
  );
  assert.deepEqual(d, { input: 0, output: 10, cacheRead: 0 });
  assert.ok(warns.some((w) => /compaction/i.test(w)));
});

test("meterBotTurn writes a priced surface=bot row from the per-turn delta", async () => {
  const conn = freshDb();
  conn.prepare(
    "INSERT INTO pricing_rules (provider_id, model_id, input_cost_per_1m, output_cost_per_1m) VALUES (?,?,?,?)",
  ).run("crow-test", "*", 1.0, 1.0);
  const res = await meterBotTurn({
    conn,
    statsBefore: { tokens: { input: 100, output: 10, cacheRead: 0 } },
    statsAfter: { tokens: { input: 160, output: 35, cacheRead: 5 } },
    resolved: { provider: "crow-test", model: "qwen" },
    requestId: "sess-1",
  });
  assert.equal(res.recorded, true);
  assert.equal(res.priced, true);
  // delta = {input:60, output:25, cacheRead:5} at $1/1M in+out, no cache_read rate
  // ⇒ cacheRead billed at input rate ⇒ (55+5+25)/1e6 = 0.000085. Assert the exact
  // number so a computeCost wiring regression is caught (not just priced=1).
  assert.ok(Math.abs(res.cost - 0.000085) < 1e-12, `expected ~0.000085, got ${res.cost}`);
  const { rows } = await libsqlAdapter(conn).execute("SELECT * FROM usage_events");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].surface, "bot");
  assert.equal(Number(rows[0].input_tokens), 60);
  assert.equal(Number(rows[0].output_tokens), 25);
  assert.equal(Number(rows[0].cached_tokens), 5);
  assert.equal(rows[0].provider_id, "crow-test");
  assert.equal(rows[0].provider_type, null);
  assert.equal(rows[0].model_id, "qwen");
  assert.equal(rows[0].tenant_id, resolveTenantId()); // was null; now the resolved tenant
  assert.equal(rows[0].request_id, "sess-1");
  assert.equal(Number(rows[0].priced), 1);
  assert.ok(Math.abs(Number(rows[0].computed_cost_usd) - 0.000085) < 1e-12);
});

test("meterBotTurn still records an UNPRICED row when no rule matches", async () => {
  const conn = freshDb(); // no pricing_rules seeded
  const res = await meterBotTurn({
    conn,
    statsBefore: { tokens: { input: 0, output: 0, cacheRead: 0 } },
    statsAfter: { tokens: { input: 10, output: 5, cacheRead: 0 } },
    resolved: { provider: "x", model: "y" },
    requestId: "s",
  });
  assert.equal(res.recorded, true);
  assert.equal(res.priced, false);
  const { rows } = await libsqlAdapter(conn).execute("SELECT priced, computed_cost_usd FROM usage_events");
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].priced), 0);
  assert.equal(rows[0].computed_cost_usd, null);
});

test("meterBotTurn writes a clamped row when compaction makes a dimension negative", async () => {
  const conn = freshDb();
  conn.prepare(
    "INSERT INTO pricing_rules (provider_id, model_id, input_cost_per_1m, output_cost_per_1m) VALUES (?,?,?,?)",
  ).run("crow-test", "*", 1.0, 1.0);
  // input compacted down (480 < 500) ⇒ clamps to 0; output still grew by 10.
  const res = await meterBotTurn({
    conn,
    statsBefore: { tokens: { input: 500, output: 50, cacheRead: 0 } },
    statsAfter: { tokens: { input: 480, output: 60, cacheRead: 0 } },
    resolved: { provider: "crow-test", model: "qwen" },
    requestId: "sess-compact",
  });
  assert.equal(res.recorded, true);
  const { rows } = await libsqlAdapter(conn).execute("SELECT input_tokens, output_tokens FROM usage_events");
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].input_tokens), 0);
  assert.equal(Number(rows[0].output_tokens), 10);
});

test("meterBotTurn records nothing on zero delta or missing after-stats", async () => {
  const conn = freshDb();
  const zero = await meterBotTurn({
    conn,
    statsBefore: { tokens: { input: 5, output: 5, cacheRead: 0 } },
    statsAfter: { tokens: { input: 5, output: 5, cacheRead: 0 } },
    resolved: { provider: "x", model: "y" },
  });
  assert.equal(zero.recorded, false);
  const none = await meterBotTurn({
    conn, statsBefore: null, statsAfter: null, resolved: { provider: "x", model: "y" },
  });
  assert.equal(none.recorded, false);
  const { rows } = await libsqlAdapter(conn).execute("SELECT * FROM usage_events");
  assert.equal(rows.length, 0);
});

test("meterBotTurn tags usage with the default tenant when CROW_TENANT_ID is unset", async () => {
  const prev = process.env.CROW_TENANT_ID;
  delete process.env.CROW_TENANT_ID;
  try {
    const conn = freshDb();
    await meterBotTurn({
      conn,
      statsBefore: { tokens: { input: 0, output: 0, cacheRead: 0 } },
      statsAfter: { tokens: { input: 5, output: 5, cacheRead: 0 } },
      resolved: { provider: "x", model: "y" },
      requestId: "s",
    });
    const { rows } = await libsqlAdapter(conn).execute("SELECT tenant_id FROM usage_events");
    assert.equal(rows[0].tenant_id, "default");
  } finally {
    if (prev !== undefined) process.env.CROW_TENANT_ID = prev;
  }
});
