/**
 * Task 1 (cross_host_calls corruption hardening, 2026-07-02 plan): bounded
 * retention for the cross_host_calls audit table.
 *
 * cross_host_calls has corrupted crow's DB twice (2026-06-14, 2026-07-02) as
 * an unbounded append-only high-write table. pruneCrossHostAudit() deletes
 * rows older than a retention window (default 14 days — verified-facts in
 * the plan show a 7-day integrations reader in health-signals.js:493-506,
 * so retention MUST exceed 7 days with margin) and best-effort checkpoints
 * the WAL. It must never reject, even against a closed/broken db handle.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "xhost-retention-"));
const dbPath = join(dir, "crow.db");

before(() => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir },
    stdio: "pipe",
    cwd: new URL("..", import.meta.url).pathname,
  });
});

after(() => rmSync(dir, { recursive: true, force: true }));

function isoDaysAgo(days) {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

async function insertRow(db, ageDays) {
  await db.execute({
    sql: `INSERT INTO cross_host_calls
            (source_instance_id, target_instance_id, direction, action, at)
          VALUES (?, ?, 'outbound', 'test-action', ?)`,
    args: ["inst-a", "inst-b", isoDaysAgo(ageDays)],
  });
}

test("default retention (14d) deletes only the 20d-old row", async () => {
  const { createDbClient } = await import("../servers/db.js");
  const { pruneCrossHostAudit } = await import("../servers/shared/cross-host-audit-retention.js");

  const db = createDbClient(dbPath);
  await insertRow(db, 0);
  await insertRow(db, 2);
  await insertRow(db, 10);
  await insertRow(db, 20);

  const before = await db.execute("SELECT COUNT(*) AS n FROM cross_host_calls");
  assert.equal(before.rows[0].n, 4);

  const result = await pruneCrossHostAudit(db);
  assert.equal(result.deleted, 1, "only the 20d-old row should be deleted at the 14d default");
  assert.equal(typeof result.checkpointed, "boolean");

  const after = await db.execute("SELECT COUNT(*) AS n FROM cross_host_calls");
  assert.equal(after.rows[0].n, 3, "now/2d/10d rows must remain — proves the shipped default is 14d, not <10d");

  // A second call at the same retention deletes nothing further.
  const second = await pruneCrossHostAudit(db);
  assert.equal(second.deleted, 0);

  // Explicit 7-day retention now also removes the 10d-old row.
  const third = await pruneCrossHostAudit(db, { retentionDays: 7 });
  assert.equal(third.deleted, 1);

  const finalCount = await db.execute("SELECT COUNT(*) AS n FROM cross_host_calls");
  assert.equal(finalCount.rows[0].n, 2, "only now/2d rows survive a 7d retention pass");

  await db.close();
});

test("boot wiring: runCrossHostAuditPrune prunes the real table via a db factory and never throws", async () => {
  const { createDbClient } = await import("../servers/db.js");
  const { runCrossHostAuditPrune } = await import("../servers/gateway/boot/post-listen.js");

  // Seed one stale (20d) row that the default 14d retention must remove.
  const seed = createDbClient(dbPath);
  await insertRow(seed, 20);
  const beforeCount = (await seed.execute("SELECT COUNT(*) AS n FROM cross_host_calls")).rows[0].n;
  await seed.close();

  // The boot timer calls runCrossHostAuditPrune(createDbClient). We inject a
  // factory bound to the temp DB so the test drives the same code path.
  const result = await runCrossHostAuditPrune(() => createDbClient(dbPath));
  assert.equal(typeof result.deleted, "number");
  assert.ok(result.deleted >= 1, "the 20d-old seed row must be pruned by the default 14d retention");

  const check = createDbClient(dbPath);
  const afterCount = (await check.execute("SELECT COUNT(*) AS n FROM cross_host_calls")).rows[0].n;
  await check.close();
  assert.equal(afterCount, beforeCount - result.deleted, "row count must drop by exactly the reported deleted count");

  // A factory that throws must still resolve (never throw) with a zero result.
  const bad = await runCrossHostAuditPrune(() => { throw new Error("db open failed"); });
  assert.deepEqual(bad, { deleted: 0, checkpointed: false });
});

test("never rejects against a closed/broken db handle", async () => {
  const { pruneCrossHostAudit } = await import("../servers/shared/cross-host-audit-retention.js");

  const brokenDb = {
    async execute() {
      throw new Error("SQLITE_IOERR: disk I/O error");
    },
  };

  const result = await pruneCrossHostAudit(brokenDb);
  assert.deepEqual(result, { deleted: 0, checkpointed: false });

  // A db that throws synchronously (not even returning a promise) must also
  // resolve rather than reject the pruneCrossHostAudit() promise.
  const syncThrowDb = {
    execute() {
      throw new Error("database is closed");
    },
  };
  const result2 = await pruneCrossHostAudit(syncThrowDb);
  assert.deepEqual(result2, { deleted: 0, checkpointed: false });
});
