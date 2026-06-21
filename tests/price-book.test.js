import { test } from "node:test";
import assert from "node:assert/strict";
import { validateRule, addPriceRule, updatePriceRule, deletePriceRule } from "../servers/shared/price-book.js";
import { createClient } from "@libsql/client";

test("validateRule accepts a well-formed rule and normalizes it", () => {
  const v = validateRule({ provider_id: "crow-chat", provider_type: "", model_id: "", input: "0", output: "0" });
  assert.equal(v.ok, true);
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.normalized, { provider_id: "crow-chat", provider_type: null, model_id: "*", input: 0, output: 0 });
});

test("validateRule rejects a negative rate", () => {
  const v = validateRule({ provider_type: "together", model_id: "x", input: "-1", output: "1" });
  assert.equal(v.ok, false);
  assert.equal(v.normalized, null);
  assert.ok(v.errors.some((e) => /input rate/i.test(e)));
});

test("validateRule rejects a non-numeric rate", () => {
  const v = validateRule({ provider_type: "together", model_id: "x", input: "abc", output: "1" });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /input rate/i.test(e)));
});

test("validateRule requires at least one of provider_id / provider_type", () => {
  const v = validateRule({ provider_id: "", provider_type: "", model_id: "x", input: "1", output: "1" });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /provider/i.test(e)));
});

test("validateRule defaults an empty model_id to '*'", () => {
  const v = validateRule({ provider_type: "together", model_id: "  ", input: "0.18", output: "0.18" });
  assert.equal(v.ok, true);
  assert.equal(v.normalized.model_id, "*");
  assert.equal(v.normalized.provider_id, null);
  assert.equal(v.normalized.input, 0.18);
});

async function db0() {
  const db = createClient({ url: ":memory:" });
  await db.execute(`CREATE TABLE pricing_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_id TEXT, provider_type TEXT, model_id TEXT NOT NULL DEFAULT '*',
    input_cost_per_1m REAL NOT NULL, output_cost_per_1m REAL NOT NULL,
    cache_read_cost_per_1m REAL, cache_write_cost_per_1m REAL,
    effective_from TEXT DEFAULT (datetime('now')), effective_to TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))`);
  return db;
}

test("addPriceRule inserts a normalized rule and returns its id", async () => {
  const db = await db0();
  const { id } = await addPriceRule(db, { provider_type: "together", model_id: "llama-8b", input: "0.18", output: "0.2" });
  assert.ok(id > 0);
  const { rows } = await db.execute("SELECT * FROM pricing_rules");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider_type, "together");
  assert.equal(rows[0].provider_id, null);
  assert.equal(rows[0].model_id, "llama-8b");
  assert.equal(Number(rows[0].input_cost_per_1m), 0.18);
  assert.equal(Number(rows[0].output_cost_per_1m), 0.2);
});

test("addPriceRule throws on an invalid rule (and writes nothing)", async () => {
  const db = await db0();
  await assert.rejects(() => addPriceRule(db, { model_id: "x", input: "-1", output: "1" }), /input rate|provider/i);
  const { rows } = await db.execute("SELECT COUNT(*) AS n FROM pricing_rules");
  assert.equal(Number(rows[0].n), 0);
});

test("updatePriceRule changes only the rate columns in place", async () => {
  const db = await db0();
  const { id } = await addPriceRule(db, { provider_id: "crow-chat", model_id: "*", input: "0", output: "0" });
  const r = await updatePriceRule(db, id, { input: "1.5", output: "2.5" });
  assert.equal(r.changed, 1);
  const { rows } = await db.execute("SELECT * FROM pricing_rules WHERE id=" + id);
  assert.equal(Number(rows[0].input_cost_per_1m), 1.5);
  assert.equal(Number(rows[0].output_cost_per_1m), 2.5);
  assert.equal(rows[0].provider_id, "crow-chat"); // untouched
  assert.equal(rows[0].model_id, "*");            // untouched
});

test("updatePriceRule throws on a negative rate", async () => {
  const db = await db0();
  const { id } = await addPriceRule(db, { provider_id: "crow-chat", model_id: "*", input: "0", output: "0" });
  await assert.rejects(() => updatePriceRule(db, id, { input: "-2", output: "1" }), /input rate/i);
});

test("deletePriceRule removes the row", async () => {
  const db = await db0();
  const { id } = await addPriceRule(db, { provider_type: "together", model_id: "x", input: "1", output: "1" });
  const r = await deletePriceRule(db, id);
  assert.equal(r.deleted, 1);
  const { rows } = await db.execute("SELECT COUNT(*) AS n FROM pricing_rules");
  assert.equal(Number(rows[0].n), 0);
});
