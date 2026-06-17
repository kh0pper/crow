import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "../node_modules/better-sqlite3/lib/index.js";

const dir = mkdtempSync(join(tmpdir(), "metering-initdb-"));

// Run the real init-db.js against a throwaway data dir.
execFileSync(process.execPath, ["scripts/init-db.js"], {
  env: { ...process.env, CROW_DATA_DIR: dir },
  stdio: "pipe",
});

const db = new Database(join(dir, "crow.db"), { readonly: true });
after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);

test("pricing_rules table exists with provider/model/cost columns", () => {
  const c = cols("pricing_rules");
  for (const col of [
    "id",
    "provider_id",
    "provider_type",
    "model_id",
    "input_cost_per_1m",
    "output_cost_per_1m",
    "cache_read_cost_per_1m",
    "cache_write_cost_per_1m",
    "effective_from",
    "effective_to",
  ]) {
    assert.ok(c.includes(col), `pricing_rules missing column ${col}`);
  }
});

test("usage_events table exists with tenant/token/cost columns", () => {
  const c = cols("usage_events");
  for (const col of [
    "id",
    "tenant_id",
    "conversation_id",
    "message_id",
    "surface",
    "provider_id",
    "provider_type",
    "model_id",
    "input_tokens",
    "output_tokens",
    "cached_tokens",
    "computed_cost_usd",
    "priced",
    "request_id",
    "created_at",
  ]) {
    assert.ok(c.includes(col), `usage_events missing column ${col}`);
  }
});
