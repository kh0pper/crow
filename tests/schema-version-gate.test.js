import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "../node_modules/better-sqlite3/lib/index.js";
import { SCHEMA_GENERATION, needsSchemaInit } from "../servers/shared/schema-version.js";

// --- (a) needsSchemaInit truth table (pure helper) ---
test("needsSchemaInit: coreTableCount < 3 → true (missing tables)", () => {
  assert.equal(
    needsSchemaInit({ coreTableCount: 2, userVersion: SCHEMA_GENERATION, schemaGeneration: SCHEMA_GENERATION }),
    true,
  );
});

test("needsSchemaInit: userVersion < schemaGeneration → true (schema drift)", () => {
  assert.equal(
    needsSchemaInit({ coreTableCount: 3, userVersion: 0, schemaGeneration: 1 }),
    true,
  );
});

test("needsSchemaInit: tables=3 & userVersion > schemaGeneration → false", () => {
  assert.equal(
    needsSchemaInit({ coreTableCount: 3, userVersion: 5, schemaGeneration: 1 }),
    false,
  );
});

test("needsSchemaInit: tables=3 & userVersion === schemaGeneration → false", () => {
  assert.equal(
    needsSchemaInit({ coreTableCount: 3, userVersion: 1, schemaGeneration: 1 }),
    false,
  );
});

// --- (b) + (c) integration against a real temp DB ---
const dir = mkdtempSync(join(tmpdir(), "schema-version-gate-"));
const dbPath = join(dir, "crow.db");

function runInitDb() {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DB_PATH: dbPath },
    stdio: "pipe",
  });
}

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("(b) init-db sets PRAGMA user_version to SCHEMA_GENERATION", () => {
  runInitDb();
  const db = new Database(dbPath, { readonly: true });
  try {
    const uv = db.pragma("user_version", { simple: true });
    assert.equal(uv, SCHEMA_GENERATION);
  } finally {
    db.close();
  }
});

test("(c) drift is detected, and re-running init-db restores user_version", () => {
  // Simulate an out-of-band code update: DB predates the version stamp.
  const w = new Database(dbPath);
  w.pragma("user_version = 0");
  const drifted = w.pragma("user_version", { simple: true });
  w.close();
  assert.equal(drifted, 0);

  // The gate must say "re-init needed" when the stamp is behind.
  assert.equal(
    needsSchemaInit({ coreTableCount: 3, userVersion: drifted, schemaGeneration: SCHEMA_GENERATION }),
    true,
  );

  // Re-running init-db (idempotent) re-stamps the version.
  runInitDb();
  const r = new Database(dbPath, { readonly: true });
  try {
    assert.equal(r.pragma("user_version", { simple: true }), SCHEMA_GENERATION);
  } finally {
    r.close();
  }
});
