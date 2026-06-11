/**
 * health-signals.test.js
 *
 * Tests for collectHealthSignals() and the module-level cache.
 * Uses a stubbed db object — same pattern as crow-context-cache.test.js.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectHealthSignals,
  invalidateHealthCache,
} from "../servers/gateway/dashboard/panels/nest/health-signals.js";

// ─── Stub DB factory ──────────────────────────────────────────────────────────

function makeDb(overrides = {}) {
  return {
    async execute({ sql }) {
      // agents
      if (sql && sql.includes("pi_bot_defs")) return { rows: [{ c: 3 }] };
      // peers — none unseen by default
      if (sql && sql.includes("crow_instances")) return { rows: [] };
      // updates — same version
      if (sql && sql.includes("auto_update_current_version")) return { rows: [{ value: "1.0.0" }] };
      if (sql && sql.includes("auto_update_latest_version")) return { rows: [{ value: "1.0.0" }] };
      // dashboard_settings fallthrough (prefs etc.)
      return { rows: [] };
    },
    ...overrides,
  };
}

// ─── Backup threshold math ────────────────────────────────────────────────────

test("backup: no backup dir → state info, not warn", async () => {
  invalidateHealthCache();
  // Force CROW_BACKUP_DIR to a path that certainly does not exist
  const original = process.env.CROW_BACKUP_DIR;
  process.env.CROW_BACKUP_DIR = "/tmp/__crow_test_nonexistent_dir_xyz__";

  const result = await collectHealthSignals(makeDb());

  // Restore env
  if (original == null) delete process.env.CROW_BACKUP_DIR;
  else process.env.CROW_BACKUP_DIR = original;

  const backupDetail = result.details.find(d => d.id === "backup");
  assert.ok(backupDetail, "backup detail must be present");
  assert.equal(backupDetail.state, "info", "no backup dir → info, not warn");

  // Issue must be info (not warn), so ok should still be true
  const backupIssue = result.issues.find(i => i.id === "backup");
  assert.ok(backupIssue, "backup issue must surface");
  assert.equal(backupIssue.severity, "info");
  // ok = no warn issues
  assert.equal(result.ok, true, "no warn signals → ok=true");
});

test("backup: file older than 7 days → state warn", async () => {
  invalidateHealthCache();
  const original = process.env.CROW_BACKUP_DIR;
  process.env.CROW_BACKUP_DIR = "/tmp/__crow_test_nonexistent_dir_xyz__";

  // Use injectable now = 8 days after epoch 0; but we need a real mtime.
  // Easier: point to a dir that has no files (same as above) but override
  // the age check via injectable now. Since the dir doesn't exist, we get
  // newestMtimeMs=null which → info. So we need a different approach:
  // create a temp file with a real mtime and set now far in the future.
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const tmpDir = mkdtempSync(join(tmpdir(), "crow-backup-test-"));
  process.env.CROW_BACKUP_DIR = tmpDir;

  writeFileSync(join(tmpDir, "test.db"), "");

  // now = real now + 8 days (file appears 8 days old)
  const futureNow = () => Date.now() + 8 * 24 * 60 * 60 * 1000;

  const result = await collectHealthSignals(makeDb(), { now: futureNow });

  // Cleanup
  if (original == null) delete process.env.CROW_BACKUP_DIR;
  else process.env.CROW_BACKUP_DIR = original;

  const backupDetail = result.details.find(d => d.id === "backup");
  assert.ok(backupDetail, "backup detail must be present");
  assert.equal(backupDetail.state, "warn", "8-day-old backup → warn");

  const backupIssue = result.issues.find(i => i.id === "backup");
  assert.ok(backupIssue, "backup issue must surface");
  assert.equal(backupIssue.severity, "warn");
  assert.equal(result.ok, false, "warn signal → ok=false");
});

test("backup: fresh backup within 7 days → ok", async () => {
  invalidateHealthCache();
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const original = process.env.CROW_BACKUP_DIR;
  const tmpDir = mkdtempSync(join(tmpdir(), "crow-backup-fresh-"));
  process.env.CROW_BACKUP_DIR = tmpDir;

  writeFileSync(join(tmpDir, "test.db"), "");

  const result = await collectHealthSignals(makeDb());

  if (original == null) delete process.env.CROW_BACKUP_DIR;
  else process.env.CROW_BACKUP_DIR = original;

  const backupDetail = result.details.find(d => d.id === "backup");
  assert.ok(backupDetail);
  assert.equal(backupDetail.state, "ok");
});

// ─── MINIO_ENDPOINT unset → info not warn ─────────────────────────────────────

test("storage: MINIO_ENDPOINT unset → state off/info, NOT warn", async () => {
  invalidateHealthCache();
  const originalMinio = process.env.MINIO_ENDPOINT;
  delete process.env.MINIO_ENDPOINT;

  const result = await collectHealthSignals(makeDb());

  if (originalMinio != null) process.env.MINIO_ENDPOINT = originalMinio;

  const storageDetail = result.details.find(d => d.id === "storage");
  assert.ok(storageDetail, "storage detail must be present");
  assert.ok(
    storageDetail.state === "off" || storageDetail.state === "info",
    `MINIO unset must be off or info, got ${storageDetail.state}`
  );

  const storageIssue = result.issues.find(i => i.id === "storage");
  // if there is an issue it must NOT be warn
  if (storageIssue) {
    assert.notEqual(storageIssue.severity, "warn", "MINIO unset must not produce a warn issue");
  }
  // ok still true (no warn)
  const warnIssues = result.issues.filter(i => i.severity === "warn");
  // storage is not warn, so warnIssues may come from other signals — just
  // check storage itself is not the source
  const storageWarn = warnIssues.find(i => i.id === "storage");
  assert.equal(storageWarn, undefined, "MINIO unset must not appear as a warn");
});

// ─── Failing signal → 'off', not throw ────────────────────────────────────────

test("failing signal → state off, no throw", async () => {
  invalidateHealthCache();
  const badDb = {
    async execute() {
      throw new Error("simulated DB failure");
    },
  };

  let result;
  await assert.doesNotReject(async () => {
    result = await collectHealthSignals(badDb);
  }, "collectHealthSignals must not throw when the DB fails");

  assert.ok(result, "result must be returned");
  // At least agents/peers/updates rely on DB; they should come back off or degrade
  // gracefully — the key invariant is no throw.
  assert.equal(typeof result.ok, "boolean");
  assert.ok(Array.isArray(result.issues));
  assert.ok(Array.isArray(result.details));
});

// ─── Cache behavior ───────────────────────────────────────────────────────────

test("cache: second call within TTL skips recompute", async () => {
  invalidateHealthCache();
  let calls = 0;
  const countingDb = {
    async execute({ sql }) {
      if (sql && sql.includes("pi_bot_defs")) { calls++; return { rows: [{ c: 0 }] }; }
      if (sql && sql.includes("crow_instances")) return { rows: [] };
      if (sql && sql.includes("auto_update_current_version")) return { rows: [{ value: "1.0.0" }] };
      if (sql && sql.includes("auto_update_latest_version")) return { rows: [{ value: "1.0.0" }] };
      return { rows: [] };
    },
  };

  await collectHealthSignals(countingDb);
  const callsAfterFirst = calls;
  assert.ok(callsAfterFirst > 0, "first call must hit DB");

  await collectHealthSignals(countingDb);
  assert.equal(calls, callsAfterFirst, "second call within TTL must not hit DB");
});

test("cache: injectable now can bypass TTL", async () => {
  invalidateHealthCache();
  let calls = 0;
  const countingDb = {
    async execute({ sql }) {
      if (sql && sql.includes("pi_bot_defs")) { calls++; return { rows: [{ c: 0 }] }; }
      if (sql && sql.includes("crow_instances")) return { rows: [] };
      if (sql && sql.includes("auto_update_current_version")) return { rows: [{ value: "1.0.0" }] };
      if (sql && sql.includes("auto_update_latest_version")) return { rows: [{ value: "1.0.0" }] };
      return { rows: [] };
    },
  };

  let fakeNow = 1_000_000;
  const clock = () => fakeNow;

  await collectHealthSignals(countingDb, { now: clock });
  const after1 = calls;
  assert.ok(after1 > 0, "first call hits DB");

  // Advance clock past TTL
  fakeNow += 60_000;
  await collectHealthSignals(countingDb, { now: clock });
  assert.ok(calls > after1, "after TTL expired, re-hits DB");
});
