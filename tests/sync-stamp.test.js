/**
 * Tests for servers/shared/sync-stamp.js — the shared stamping module
 * (stdio-sync-outbox Task 1).
 *
 * Scope: the module's own behavior in isolation — instance-sync.js's
 * delegation is proven byte-identical separately by the existing
 * tests/instance-sync.test.js run (see task-1-report.md for that evidence).
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDbClient } from "../servers/db.js";
import {
  ensureSyncTables,
  mintLamport,
  advanceCounter,
  stampSql,
  seedCounterSql,
  bumpCounterSql,
} from "../servers/shared/sync-stamp.js";

const tmpDir = mkdtempSync(join(tmpdir(), "crow-sync-stamp-test-"));

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Collapse whitespace so SQL-string assertions aren't brittle to indentation. */
function normSql(sql) {
  return sql.replace(/\s+/g, " ").trim();
}

// ── ensureSyncTables ─────────────────────────────────────────────────────

test("ensureSyncTables: creates sync_state + sync_outbox, idempotent on re-run", async () => {
  const dbPath = join(tmpDir, "ensure.db");
  const db = createDbClient(dbPath);

  await ensureSyncTables(db);
  await ensureSyncTables(db); // must not throw — IF NOT EXISTS

  const { rows } = await db.execute({
    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('sync_state','sync_outbox') ORDER BY name",
    args: [],
  });
  assert.deepEqual(rows.map((r) => r.name), ["sync_outbox", "sync_state"]);
  db.close();
});

// ── mintLamport ──────────────────────────────────────────────────────────

test("mintLamport: monotonic + unique across two SEPARATE createDbClient connections, and advanceCounter MAX-floor never regresses", async () => {
  const dbPath = join(tmpDir, "mint.db");
  const dbA = createDbClient(dbPath);
  const dbB = createDbClient(dbPath);
  await ensureSyncTables(dbA);

  const instanceId = "inst-mint-1";

  // Interleave 25 mints from each of two independent connections to the
  // same db file — the in-process approximation of the cross-process shape
  // (gateway process + stdio-mounted process both minting against one db).
  const results = await Promise.all([
    ...Array.from({ length: 25 }, () => mintLamport(dbA, instanceId)),
    ...Array.from({ length: 25 }, () => mintLamport(dbB, instanceId)),
  ]);

  const unique = new Set(results);
  assert.equal(unique.size, 50, "all 50 mints must be unique");
  assert.deepEqual(
    [...results].sort((a, b) => a - b),
    Array.from({ length: 50 }, (_, i) => i + 1),
    "mints must cover 1..50 with no gaps",
  );

  const current = Math.max(...results); // 50

  // A floor BELOW the current counter must not regress it (MAX, not SET).
  await advanceCounter(dbA, instanceId, 10);
  const afterLowFloor = await mintLamport(dbB, instanceId);
  assert.equal(afterLowFloor, current + 1, "a low floor must not regress the counter");

  // A floor ABOVE the current counter must push future mints past it.
  await advanceCounter(dbA, instanceId, 1000);
  const afterHighFloor = await mintLamport(dbB, instanceId);
  assert.equal(afterHighFloor, 1002, "a high floor must strictly exceed the floor value");

  dbA.close();
  dbB.close();
});

test("mintLamport: mints against a fresh (unseeded) instance_id without a pre-existing sync_state row", async () => {
  const dbPath = join(tmpDir, "mint-fresh.db");
  const db = createDbClient(dbPath);
  await ensureSyncTables(db);

  const first = await mintLamport(db, "brand-new-instance");
  assert.equal(first, 1, "first mint against an unseeded row must be 1, not NULL/skip");

  db.close();
});

// ── seedCounterSql / bumpCounterSql (statement builders Task 2 composes from) ──

test("seedCounterSql / bumpCounterSql: return {sql, args} shapes usable standalone in a db.batch()", async () => {
  const dbPath = join(tmpDir, "builders.db");
  const db = createDbClient(dbPath);
  await ensureSyncTables(db);

  const instanceId = "inst-builders-1";
  const seed = seedCounterSql(instanceId);
  const bump = bumpCounterSql(instanceId);

  assert.equal(typeof seed.sql, "string");
  assert.deepEqual(seed.args, [instanceId]);
  assert.equal(typeof bump.sql, "string");
  assert.deepEqual(bump.args, [instanceId]);

  // Composing them manually (as Task 2's batch will) must behave the same
  // as calling mintLamport.
  await db.batch([seed, bump]);
  const { rows } = await db.execute({
    sql: "SELECT local_counter FROM sync_state WHERE instance_id = ?",
    args: [instanceId],
  });
  assert.equal(Number(rows[0].local_counter), 1);

  db.close();
});

// ── stampSql ─────────────────────────────────────────────────────────────

test("stampSql: dashboard_settings stamps by key", () => {
  const result = stampSql("dashboard_settings", { key: "theme", value: "dark" }, 42);
  assert.equal(normSql(result.sql), normSql("UPDATE dashboard_settings SET lamport_ts = ? WHERE key = ?"));
  assert.deepEqual(result.args, [42, "theme"]);
});

test("stampSql: crow_context stamps by composite key w/ MAX(COALESCE())", () => {
  const result = stampSql(
    "crow_context",
    { section_key: "identity", device_id: null, project_id: "proj-1" },
    7,
  );
  assert.equal(
    normSql(result.sql),
    normSql(`UPDATE crow_context SET lamport_ts = MAX(COALESCE(lamport_ts, 0), ?)
              WHERE section_key = ? AND device_id IS ? AND project_id IS ?`),
  );
  assert.deepEqual(result.args, [7, "identity", null, "proj-1"]);
});

test("stampSql: falls back to stamping by id for a generic table", () => {
  const result = stampSql("memories", { id: 5, content: "hi" }, 3);
  assert.equal(normSql(result.sql), normSql("UPDATE memories SET lamport_ts = ? WHERE id = ?"));
  assert.deepEqual(result.args, [3, 5]);
});

test("stampSql: returns null for a delete-shaped row (no id, no key, no section_key)", () => {
  assert.equal(stampSql("contacts", { crow_id: "abc-123" }, 9), null);
});

test("stampSql: returns null for an unknown table with no id", () => {
  assert.equal(stampSql("some_unmapped_table", { name: "x" }, 1), null);
});

// ── getOrCreateLocalInstanceId concurrent-create race ───────────────────

test("getOrCreateLocalInstanceId: concurrent first-ever boot — both racers return the SAME id", async () => {
  const raceDir = mkdtempSync(join(tmpdir(), "crow-instanceid-race-"));
  const fixture = fileURLToPath(new URL("./fixtures/instance-id-racer.mjs", import.meta.url));

  const runRacer = () =>
    new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, [fixture], {
        env: { ...process.env, CROW_DATA_DIR: raceDir },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { err += d; });
      child.on("close", (code) => {
        if (code !== 0) return reject(new Error(`racer exited ${code}: ${err}`));
        resolvePromise(out.trim());
      });
      child.on("error", reject);
    });

  const [idA, idB] = await Promise.all([runRacer(), runRacer()]);

  assert.ok(idA, "racer A must return a non-empty id");
  assert.ok(idB, "racer B must return a non-empty id");
  // The real assertion: both racers RETURN the same id. A file-content-only
  // check (reading instance-id after both exit) passes vacuously even when
  // the two in-flight processes disagreed — both "succeeded" with different
  // ids while whichever wrote last silently overwrote the file.
  assert.equal(idA, idB, "both concurrent racers must observe the SAME winning id");

  rmSync(raceDir, { recursive: true, force: true });
});
