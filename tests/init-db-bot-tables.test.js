import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "../node_modules/better-sqlite3/lib/index.js";

const dir = mkdtempSync(join(tmpdir(), "f3-initdb-"));
after(() => rmSync(dir, { recursive: true, force: true }));

// Run the real init-db.js against a throwaway data dir.
execFileSync(process.execPath, ["scripts/init-db.js"], {
  env: { ...process.env, CROW_DATA_DIR: dir },
  stdio: "pipe",
});

const db = new Database(join(dir, "crow.db"), { readonly: true });
const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);

test("pi_bot_defs exists with project_id column", () => {
  assert.ok(cols("pi_bot_defs").includes("project_id"));
});

test("bot_sessions exists with model + escalated columns", () => {
  const c = cols("bot_sessions");
  assert.ok(c.includes("model"));
  assert.ok(c.includes("escalated"));
});

test("bot_skill_events exists with action column", () => {
  assert.ok(cols("bot_skill_events").includes("action"));
});
