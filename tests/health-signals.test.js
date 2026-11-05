/**
 * health-signals.test.js
 *
 * Tests for collectHealthSignals() and the module-level cache.
 * Uses a stubbed db object — same pattern as crow-context-cache.test.js.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectHealthSignals,
  invalidateHealthCache,
  _setDockerPortsReader,
  _setFirewallReader,
  _setTailscaleReader,
  _setContainerReader,
  isRunningInContainer,
  CONTAINER_MARKER_PATHS,
} from "../servers/gateway/dashboard/panels/nest/health-signals.js";
import { parseDockerPsPorts } from "../servers/gateway/dashboard/panels/nest/published-ports.js";
import { docsUrl } from "../servers/gateway/dashboard/shared/components.js";
import { t, fill } from "../servers/gateway/dashboard/shared/i18n.js";
import { backupLabel, instanceBackupTag, backupFileName } from "../servers/shared/backup-naming.js";

// The signal only counts THIS instance's backup files (per-instance naming).
const OWN_BACKUP = backupFileName(backupLabel(), instanceBackupTag(), "2026-01-01");

// Test isolation: every collectHealthSignals() call in this file that does not
// pass its own `publishedPorts.snapshotPath` must read this scratch path, never
// the host's real fence snapshot.
process.env.CROW_PUBLISH_SNAPSHOT = "/tmp/__crow_test_no_publish_snapshot__.json";

// Sibling signals that shell out are neutralized (the same reason
// external-engines-signal.test.js does it): the host's Docker daemon, ufw.conf
// and tailscale must not decide what a card says. The bind is pinned to loopback
// so "the dashboard listens everywhere" is this suite's own choice, not the
// machine's; the tests below that are about a wide bind set it explicitly.
process.env.CROW_GATEWAY_BIND = "127.0.0.1";
_setTailscaleReader(() => { throw new Error("no tailscale"); });
_setDockerPortsReader(() => { throw new Error("no docker"); });
const firewallUnreadable = () => { throw new Error("ENOENT"); };
_setFirewallReader(firewallUnreadable);
// The container-marker check too: CI runs this suite inside a container often
// enough that an unpinned reader would move the Privacy card here.
_setContainerReader(() => false);

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

  // Issue must be info (not warn). Scope the assertion to the BACKUP signal
  // only: result.ok is a global roll-up over ~10 signals (exposure reads live
  // tailscale funnel state + env, disk reads df, storage probes MinIO, etc.),
  // any of which can legitimately warn on a real host — so asserting the global
  // result.ok here is env-dependent and flaky. What this test owns is that a
  // missing backup dir is info, never warn, and thus contributes no warn.
  const backupIssue = result.issues.find(i => i.id === "backup");
  assert.ok(backupIssue, "backup issue must surface");
  assert.equal(backupIssue.severity, "info");
  const backupWarn = result.issues.find(i => i.id === "backup" && i.severity === "warn");
  assert.equal(backupWarn, undefined, "no backup dir must not produce a warn issue");
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

  writeFileSync(join(tmpDir, OWN_BACKUP), "");

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

test("backup: fresh backup, verified ok → ok", async () => {
  invalidateHealthCache();
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const original = process.env.CROW_BACKUP_DIR;
  const tmpDir = mkdtempSync(join(tmpdir(), "crow-backup-fresh-"));
  process.env.CROW_BACKUP_DIR = tmpDir;

  const dbFile = join(tmpDir, OWN_BACKUP);
  writeFileSync(dbFile, "x");

  // Supply a matching verification record so the signal reports verified-ok.
  const verifiedDb = makeDb({
    async execute({ sql }) {
      if (sql && sql.includes("pi_bot_defs")) return { rows: [{ c: 0 }] };
      if (sql && sql.includes("crow_instances")) return { rows: [] };
      if (sql && sql.includes("auto_update")) return { rows: [{ value: "1.0.0" }] };
      if (sql && sql.includes("backup_last_verified")) {
        return { rows: [{ value: JSON.stringify({ path: dbFile, ok: true, result: "ok" }) }] };
      }
      return { rows: [] };
    },
  });

  const result = await collectHealthSignals(verifiedDb);

  if (original == null) delete process.env.CROW_BACKUP_DIR;
  else process.env.CROW_BACKUP_DIR = original;

  const backupDetail = result.details.find(d => d.id === "backup");
  assert.ok(backupDetail);
  assert.equal(backupDetail.state, "ok", "fresh + verified ok → ok");
});

test("backup: fresh backup, no verification record → info (gentle nudge, not warn)", async () => {
  invalidateHealthCache();
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const original = process.env.CROW_BACKUP_DIR;
  const tmpDir = mkdtempSync(join(tmpdir(), "crow-backup-unv-"));
  process.env.CROW_BACKUP_DIR = tmpDir;
  writeFileSync(join(tmpDir, OWN_BACKUP), "x");

  const result = await collectHealthSignals(makeDb()); // no verification record

  if (original == null) delete process.env.CROW_BACKUP_DIR;
  else process.env.CROW_BACKUP_DIR = original;

  const backupIssue = result.issues.find(i => i.id === "backup");
  assert.ok(backupIssue, "unverified fresh backup surfaces an info nudge");
  assert.equal(backupIssue.severity, "info", "must be info, never a false damaged-warn");
});

// ─── MINIO_ENDPOINT unset → info not warn ─────────────────────────────────────

test("storage: MINIO_ENDPOINT unset → state off/info, NOT warn", async () => {
  invalidateHealthCache();
  const saved = {};
  for (const k of ["MINIO_ENDPOINT", "S3_ENDPOINT"]) { saved[k] = process.env[k]; delete process.env[k]; }

  const result = await collectHealthSignals(makeDb());

  for (const [k, v] of Object.entries(saved)) if (v != null) process.env[k] = v;

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

test("storage: configured through the DB (no MINIO_ENDPOINT at all) is probed, not reported as not set up", async () => {
  invalidateHealthCache();
  const saved = {};
  for (const k of ["MINIO_ENDPOINT", "S3_ENDPOINT"]) { saved[k] = process.env[k]; delete process.env[k]; }
  const s3 = await import("../servers/storage/s3-client.js");
  // An endpoint nothing listens on: the probe fails fast → "unreachable", which proves the
  // signal followed the DB config instead of stopping at the missing env var.
  s3.useStorageConfig({ endpoint: "127.0.0.1:9", host: "127.0.0.1", port: 9, useSSL: false, region: "us-east-1", bucketPrefix: "crow", accessKey: "a", secretKey: "b" });
  try {
    const result = await collectHealthSignals(makeDb());
    const d = result.details.find((x) => x.id === "storage");
    assert.notEqual(d.value, "not set up");
  } finally {
    s3.useStorageConfig(null);
    for (const [k, v] of Object.entries(saved)) if (v != null) process.env[k] = v;
    invalidateHealthCache();
  }
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

// ─── syncOutbox signal (stdio-sync-outbox Task 7 Step 1) ──────────────────────

function sqliteAgo(ms) {
  return new Date(Date.now() - ms).toISOString().slice(0, 19).replace("T", " ");
}

function makeOutboxDb({ depth = 0, oldest = null } = {}) {
  return {
    async executeMultiple() {},
    async execute(arg) {
      const sql = typeof arg === "string" ? arg : arg?.sql;
      if (sql && sql.includes("FROM sync_outbox")) return { rows: [{ depth, oldest }] };
      if (sql && sql.includes("pi_bot_defs")) return { rows: [{ c: 0 }] };
      if (sql && sql.includes("crow_instances")) return { rows: [] };
      if (sql && sql.includes("auto_update_current_version")) return { rows: [{ value: "1.0.0" }] };
      if (sql && sql.includes("auto_update_latest_version")) return { rows: [{ value: "1.0.0" }] };
      return { rows: [] };
    },
  };
}

test("syncOutbox: empty outbox → state ok, value 'empty'", async () => {
  invalidateHealthCache();
  const result = await collectHealthSignals(makeOutboxDb({ depth: 0, oldest: null }));
  const detail = result.details.find(d => d.id === "syncOutbox");
  assert.ok(detail, "syncOutbox detail must be present");
  assert.equal(detail.state, "ok");
  assert.equal(detail.value, "empty");
});

test("syncOutbox: queued rows, oldest well under the stale window → state ok, not warn", async () => {
  invalidateHealthCache();
  const result = await collectHealthSignals(makeOutboxDb({ depth: 3, oldest: sqliteAgo(60_000) }));
  const detail = result.details.find(d => d.id === "syncOutbox");
  assert.equal(detail.state, "ok");
  assert.match(detail.value, /3 queued/);
  const issue = result.issues.find(i => i.id === "syncOutbox");
  assert.equal(issue, undefined, "a fresh queue must not surface as an issue");
});

test("syncOutbox: oldest row past the stale window → state warn with an issue", async () => {
  invalidateHealthCache();
  const result = await collectHealthSignals(makeOutboxDb({ depth: 2, oldest: sqliteAgo(20 * 60_000) }));
  const detail = result.details.find(d => d.id === "syncOutbox");
  assert.equal(detail.state, "warn");
  const issue = result.issues.find(i => i.id === "syncOutbox");
  assert.ok(issue, "a stale outbox must surface as an issue");
  assert.equal(issue.severity, "warn");
});

test("syncOutbox: getStats failure (e.g. no executeMultiple) degrades to ok/empty, no throw", async () => {
  invalidateHealthCache();
  const badDb = {
    async execute({ sql }) {
      if (sql && sql.includes("pi_bot_defs")) return { rows: [{ c: 0 }] };
      if (sql && sql.includes("crow_instances")) return { rows: [] };
      if (sql && sql.includes("auto_update_current_version")) return { rows: [{ value: "1.0.0" }] };
      if (sql && sql.includes("auto_update_latest_version")) return { rows: [{ value: "1.0.0" }] };
      return { rows: [] };
    },
    // deliberately no executeMultiple — matches the plain makeDb() stub used
    // by the rest of this file / a real db that hasn't run ensureSyncTables
  };

  let result;
  await assert.doesNotReject(async () => {
    result = await collectHealthSignals(badDb);
  });
  const detail = result.details.find(d => d.id === "syncOutbox");
  assert.equal(detail.state, "ok");
});
// ─── publishedPorts (plan PR S5a) ────────────────────────────────────────────

test("publishedPorts: no snapshot → info 'unknown' card, no published-port warn", async () => {
  invalidateHealthCache();
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "crow-nest-pp-"));

  const result = await collectHealthSignals(makeDb(), {
    publishedPorts: { snapshotPath: join(dir, "absent.json") },
  });

  const detail = result.details.find(d => d.id === "publishedPorts");
  assert.ok(detail, "the publishedPorts card is part of the signal list");
  assert.equal(detail.state, "info", "an unreadable snapshot is info, never ok-looking");
  assert.equal(
    result.issues.some(i => i.id.startsWith("published-ports:") && i.severity === "warn"),
    false,
    "no snapshot never produces a publish warn by itself",
  );
});

test("publishedPorts: a call without its own snapshot path reads the isolated env path", async () => {
  invalidateHealthCache();
  assert.ok(
    process.env.CROW_PUBLISH_SNAPSHOT?.includes("__crow_test"),
    "the file pins CROW_PUBLISH_SNAPSHOT to a scratch path",
  );

  const result = await collectHealthSignals(makeDb());
  const detail = result.details.find(d => d.id === "publishedPorts");
  assert.ok(detail, "the publishedPorts card is part of the signal list");
  assert.equal(detail.state, "info");
  assert.match(detail.value, /unknown/);
});

test("publishedPorts: a wildcard publish is a warn issue under its own id", async () => {
  invalidateHealthCache();
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "crow-nest-pp2-"));
  const path = join(dir, "snapshot.json");
  writeFileSync(path, JSON.stringify({
    taken_at: new Date().toISOString(),
    docker: { version: "28.0.1", userland_proxy: true },
    containers: [{
      id: "0123456789ab",
      name: "crow-engine",
      labels: { "crow.runtime": "docker" },
      host_config: { network_mode: "default", port_bindings: { "8011/tcp": [{ HostIp: "", HostPort: "8011" }] } },
    }],
    raw_rules: { v4: [], v6: [] },
  }));

  const result = await collectHealthSignals(makeDb(), {
    publishedPorts: { snapshotPath: path },
  });

  const issue = result.issues.find(i => i.id === "published-ports:0123456789ab:8011");
  assert.ok(issue, "one issue id per container and port");
  assert.equal(issue.severity, "warn");
  assert.equal(result.ok, false, "a published-port warn fails the nest roll-up");
});

// ─── Updates (audit N1c-1) ────────────────────────────────────────────────────
// The version pair alone used to read OK while every tick failed: auto-update's
// failure branches leave latest_version untouched. The card now reads the result
// auto-update.js wrote, classified by auto-update.js itself.

const NOW = Date.parse("2027-01-10T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

/** A db whose dashboard_settings rows are exactly this test's auto-update state. */
function settingsDb(autoRows = []) {
  return {
    async execute({ sql }) {
      if (sql && sql.includes("auto_update_%")) return { rows: autoRows };
      if (sql && sql.includes("pi_bot_defs")) return { rows: [{ c: 0 }] };
      if (sql && sql.includes("crow_instances")) return { rows: [] };
      return { rows: [] };
    },
  };
}

function autoRows({
  enabled = "true",
  intervalHours = "6",
  lastCheck = iso(NOW - 60_000),
  result = "Up to date",
  resultSince = null,
  current = "1.0.0",
  latest = "1.0.0",
} = {}) {
  const rows = [
    { key: "auto_update_enabled", value: enabled },
    { key: "auto_update_interval_hours", value: intervalHours },
  ];
  if (lastCheck != null) rows.push({ key: "auto_update_last_check", value: lastCheck });
  if (result != null) rows.push({ key: "auto_update_last_result", value: result });
  if (resultSince != null) rows.push({ key: "auto_update_result_since", value: resultSince });
  if (current != null) rows.push({ key: "auto_update_current_version", value: current });
  if (latest != null) rows.push({ key: "auto_update_latest_version", value: latest });
  return rows;
}

async function updatesOf(auto, opts = {}) {
  invalidateHealthCache();
  const result = await collectHealthSignals(settingsDb(autoRows(auto)), { now: () => NOW, ...opts });
  return {
    card: result.details.find((d) => d.id === "updates"),
    issue: result.issues.find((i) => i.id === "updates"),
  };
}

// Every failure result auto-update.js can write, with the cause the card must
// name. The strings are the module's own, copied verbatim where they are fixed.
test("updates: every failure result warns and names its cause", async () => {
  const failures = [
    ["Skipped: not on main (on 'feature/x')", /isn't on main/],
    ["Skipped: cannot determine branch (not a git checkout)", /git branch/],
    ["Skipped: CI is RED on origin/main (abc123456) — not deploying a failing build; will retry next tick", /CI is red on main/],
    ["Skipped: migration quarantined (gen 3->4, attempt 1) — delete the quarantine marker files to override", /migration was quarantined/],
    ["Fetch failed: fatal: unable to access", /fetch from origin/],
    ["Pull failed (local changes may conflict with the update — resolve manually): error: your local changes", /pull failed/],
    ["Update error: boom", /errored/],
    ["Migration quarantined: data loss detected and rolled back (memories)", /migration was quarantined/],
    ["Migration quarantined: data loss detected, automatic restore NOT possible — manual recovery required (x)", /migration was quarantined/],
    ["Migration failed (init-db exit 1) — restart withheld, running code unchanged", /migration failed/],
    ["init-db failed (exit 1) — restart withheld, running code unchanged", /database update failed/],
  ];
  for (const [result, cause] of failures) {
    const { card, issue } = await updatesOf({ result, latest: "0.9.0" });
    assert.equal(card.state, "warn", result);
    assert.match(card.value, cause, result);
    assert.equal(issue.severity, "warn", result);
    assert.match(issue.label, /Automatic updates aren't running: /, result);
    assert.match(issue.label, cause, result);
    assert.equal(issue.actionHref, "/dashboard/settings?section=updates", result);
  }
});

test("updates: a CI run still in progress is not a warning until the RESULT is older than 2x the interval", async () => {
  const pending = "Skipped: CI still running on origin/main (abc123456) — will retry next tick";

  // 1 h into the same pending code, with a 6 h interval (threshold 12 h): still
  // fine. last_check is fresh because every pending tick rewrites it — the age
  // that matters is auto_update_result_since.
  const fresh = await updatesOf({
    result: pending, lastCheck: iso(NOW - 60_000), resultSince: iso(NOW - HOUR), current: "1.0.0", latest: "1.0.0",
  }, { uptimeMs: 2 * HOUR });
  assert.notEqual(fresh.card.state, "warn", "one pending tick is normal");
  assert.equal(fresh.card.state, "ok");
  assert.equal(fresh.issue, undefined);

  // 13 h into the same pending code (last_check rewritten a minute ago): now it
  // has outlived two whole intervals.
  const stuck = await updatesOf({
    result: pending, lastCheck: iso(NOW - 60_000), resultSince: iso(NOW - 13 * HOUR), current: "1.0.0", latest: "1.0.0",
  }, { uptimeMs: 14 * HOUR });
  assert.equal(stuck.card.state, "warn");
  assert.match(stuck.card.value, /CI is still running on main/);
  assert.match(stuck.card.value, /13h/, "the cause line carries how long the result has been repeating");

  // No auto_update_result_since (an install that predates the setting): the age
  // is unknown, and an unknown age is never a warn.
  const unknownAge = await updatesOf({
    result: pending, lastCheck: iso(NOW - 60_000), resultSince: null,
  }, { uptimeMs: 14 * HOUR });
  assert.notEqual(unknownAge.card.state, "warn", "an unknown result age is not a warn");
});

test("updates: a last check older than 2x the interval warns even when the result reads fine", async () => {
  const stale = await updatesOf({ result: "Up to date", lastCheck: iso(NOW - 13 * HOUR) }, { uptimeMs: 14 * HOUR });
  assert.equal(stale.card.state, "warn");
  assert.match(stale.card.value, /no update check for 13h/);
  assert.equal(stale.issue.severity, "warn");

  // A missing last_check is only a warning once the gateway has been up longer
  // than the same threshold — a fresh boot has simply not checked yet.
  const justBooted = await updatesOf({ result: null, lastCheck: null }, { uptimeMs: 5 * 60_000 });
  assert.notEqual(justBooted.card.state, "warn", "a fresh boot is not stuck");

  const neverChecked = await updatesOf({ result: null, lastCheck: null }, { uptimeMs: 13 * HOUR });
  assert.equal(neverChecked.card.state, "warn");
  assert.match(neverChecked.card.value, /no update check has run since Crow started/);
});

test("updates: the first boot after downtime is not a stale check", async () => {
  // The host was off for two days: last_check is 2d old but THIS process started
  // five minutes ago, so the timer has simply not ticked yet. Warning here is
  // how a laptop came back to "no update check for 2d" before its first tick.
  const afterDowntime = await updatesOf(
    { result: "Up to date", lastCheck: iso(NOW - 48 * HOUR) },
    { uptimeMs: 5 * 60_000 },
  );
  assert.notEqual(afterDowntime.card.state, "warn", "a boot after downtime is not a stuck timer");
  assert.equal(afterDowntime.issue, undefined);

  // The same last_check on a gateway that has been up past the threshold is.
  const upLongEnough = await updatesOf(
    { result: "Up to date", lastCheck: iso(NOW - 48 * HOUR) },
    { uptimeMs: 13 * HOUR },
  );
  assert.equal(upLongEnough.card.state, "warn");
  assert.match(upLongEnough.card.value, /no update check for 2d/);
});

test("updates: the env kill switch and --no-auth are 'off', never a stale warn", async () => {
  const saved = process.env.CROW_AUTO_UPDATE;
  try {
    // CROW_AUTO_UPDATE=0 wins over everything, even a failure result and a
    // days-old last_check: nothing was ever going to run.
    process.env.CROW_AUTO_UPDATE = "0";
    const killed = await updatesOf({ result: "Fetch failed: x", lastCheck: iso(NOW - 48 * HOUR) }, { uptimeMs: 72 * HOUR });
    assert.equal(killed.card.state, "off");
    assert.equal(killed.card.value, t("signals.updates.off", "en"));
    assert.equal(killed.issue, undefined, "a switched-off updater is not an issue");

    // A --no-auth gateway defaults auto-update OFF unless it opted in.
    delete process.env.CROW_AUTO_UPDATE;
    const noAuth = await updatesOf({ result: "Fetch failed: x", lastCheck: iso(NOW - 48 * HOUR) }, { noAuth: true, uptimeMs: 72 * HOUR });
    assert.equal(noAuth.card.state, "off");
    assert.equal(noAuth.issue, undefined);

    // …and the explicit opt-in restores the real reading (still a warn here).
    process.env.CROW_AUTO_UPDATE = "1";
    const optedIn = await updatesOf({ result: "Fetch failed: x" }, { noAuth: true, uptimeMs: 72 * HOUR });
    assert.equal(optedIn.card.state, "warn");
  } finally {
    if (saved === undefined) delete process.env.CROW_AUTO_UPDATE; else process.env.CROW_AUTO_UPDATE = saved;
  }
});

test("updates: the interval setting decides the threshold, not a hardcoded 6 h", async () => {
  // A 1 h interval makes 2x = 2 h: a 3 h old check is already stuck.
  const stuck = await updatesOf({ intervalHours: "1", result: "Up to date", lastCheck: iso(NOW - 3 * HOUR) }, { uptimeMs: 4 * HOUR });
  assert.equal(stuck.card.state, "warn");
  const fine = await updatesOf({ intervalHours: "6", result: "Up to date", lastCheck: iso(NOW - 3 * HOUR) }, { uptimeMs: 4 * HOUR });
  assert.equal(fine.card.state, "ok");
});

test("updates: disabled is its own neutral state, never an ok 'current' claim", async () => {
  const { card, issue } = await updatesOf({ enabled: "false", result: "Fetch failed: x", current: "1.0.0", latest: "1.0.0" });
  assert.equal(card.state, "off");
  assert.equal(card.value, t("signals.updates.off", "en"));
  assert.equal(issue, undefined, "disabled is not an issue");
  assert.doesNotMatch(card.value, /1\.0\.0/, "disabled never claims a version is current");
});

test("updates: current version with a fresh check is ok; a newer version is info", async () => {
  const ok = await updatesOf();
  assert.equal(ok.card.state, "ok");
  assert.match(ok.card.value, /1\.0\.0/);
  assert.equal(ok.issue, undefined);

  const available = await updatesOf({ latest: "1.1.0" });
  assert.equal(available.card.state, "info");
  assert.match(available.card.value, /1\.1\.0/);
  assert.equal(available.issue.severity, "info");
  assert.equal(available.issue.actionHref, "/dashboard/settings?section=updates");
});

test("updates: the shared classification covers every string auto-update.js writes", async () => {
  const { classifyUpdateResult, UPDATE_RESULT_PREFIXES } = await import("../servers/gateway/auto-update.js");
  const src = readFileSync(fileURLToPath(new URL("../servers/gateway/auto-update.js", import.meta.url)), "utf8");

  // Every write must be the `msg` the literals below are assigned to, or a
  // literal itself — a new expression shape must be reviewed, not guessed at.
  const args = [...src.matchAll(/saveSetting\("auto_update_last_result",\s*([^;]+?)\);/g)].map((m) => m[1].trim());
  assert.ok(args.length >= 15, `expected every write, found ${args.length}`);
  for (const arg of args) {
    assert.ok(arg === "msg" || /^[`"]/.test(arg), `unreviewed auto_update_last_result expression: ${arg}`);
  }

  // The literals: the direct arguments, plus every `const msg = ...` value. A
  // ternary in this file writes its two branches one per line, so a branch is
  // read from a line that starts with `?` or `:`.
  const literalHeads = [];
  const head = (lit) => lit.split("${")[0];
  for (const arg of args) if (arg !== "msg") literalHeads.push(head(arg.slice(1, -1)));

  const decls = [...src.matchAll(/const msg =\s*([\s\S]*?);\n/g)].map((m) => m[1]);
  assert.equal(decls.length, args.filter((a) => a === "msg").length, "every recorded msg is a const msg = literal");
  const literalOf = (text) => {
    const m = /^[`"]([^`"]*)/.exec(text.trim());
    return m ? head(m[1]) : null;
  };
  for (const body of decls) {
    const lines = body.split("\n");
    const found = [];
    const sameLine = literalOf(lines[0]);
    if (sameLine != null) found.push(sameLine);
    for (const line of lines.slice(1)) {
      if (!/^[?:]/.test(line.trim())) continue;
      const branch = literalOf(line.trim().replace(/^[?:]\s*/, ""));
      if (branch != null) found.push(branch);
    }
    assert.ok(found.length > 0, `could not read the message in: ${body.slice(0, 60)}`);
    literalHeads.push(...found);
  }

  assert.ok(literalHeads.length >= 15, `expected every message literal, found ${literalHeads.length}`);
  for (const text of literalHeads) {
    const verdict = classifyUpdateResult(text);
    assert.ok(verdict, `empty message literal`);
    assert.notEqual(verdict.code, "other", `\"${text}\" is not covered by UPDATE_RESULT_PREFIXES`);
    assert.ok(
      UPDATE_RESULT_PREFIXES.some((e) => text.startsWith(e.prefix)),
      `\"${text}\" has no explicit prefix entry`,
    );
    assert.ok(["ok", "transient", "failure"].includes(verdict.kind), text);
  }

  // And the classifier's own contract: a result nobody classified is a failure,
  // never a silent ok, and an empty result is "no result yet".
  assert.deepEqual(classifyUpdateResult("Something new happened"), { kind: "failure", code: "other" });
  assert.equal(classifyUpdateResult(""), null);
  assert.equal(classifyUpdateResult(null), null);
  assert.deepEqual(classifyUpdateResult("Up to date"), { kind: "ok", code: "up-to-date" });
  assert.deepEqual(classifyUpdateResult("Skipped: CI still running on origin/main"), { kind: "transient", code: "ci-pending" });
});

// ─── Privacy: bind + host firewall + Funnel (audit N1c-16) ──────────────────

// A tailscale that answers with no Funnel at all ("private" from Funnel's side).
const funnelOff = () => _setTailscaleReader(() => "{}");
const funnelMissing = () => _setTailscaleReader(() => { throw new Error("tailscale: not found"); });
const ufw = (text) => _setFirewallReader(() => text);
const ufwUnreadable = () => _setFirewallReader(firewallUnreadable);

async function privacyOf(opts = {}) {
  invalidateHealthCache();
  const result = await collectHealthSignals(makeDb(), { now: () => NOW, ...opts });
  return {
    card: result.details.find((d) => d.id === "exposure"),
    issue: result.issues.find((i) => i.id === "exposure"),
  };
}

test("privacy: a loopback bind is ok when the Funnel check runs", async () => {
  try {
    funnelOff();
    ufw("ENABLED=yes\n");
    const { card, issue } = await privacyOf({ bind: "127.0.0.1" });
    assert.equal(card.state, "ok");
    assert.equal(card.value, t("signals.exposure.private", "en"));
    assert.equal(issue, undefined);
  } finally {
    funnelMissing();
    ufwUnreadable();
  }
});

test("privacy: a tailnet bind is fine too", async () => {
  try {
    funnelOff();
    ufw("ENABLED=no\n");
    const { card } = await privacyOf({ bind: "100.64.20.5" });
    assert.equal(card.state, "ok");
  } finally {
    funnelMissing();
    ufwUnreadable();
  }
});

test("privacy: every interface with the host firewall OFF warns about the local network", async () => {
  try {
    funnelOff();
    ufw("# /etc/ufw/ufw.conf\nENABLED=no\n");
    const { card, issue } = await privacyOf({ bind: "0.0.0.0" });
    assert.equal(card.state, "warn");
    assert.match(card.value, /every interface/);
    assert.match(card.value, /firewall is off/);
    assert.equal(issue.severity, "warn");
    assert.match(issue.label, /local network/);
    // "off" gets the off wording, never the unknown-firewall one.
    assert.match(issue.label, /while the host firewall is off/);
    assert.doesNotMatch(issue.label, /could not be read/);
    assert.equal(issue.label, fill(t("signals.exposure.lanIssue", "en"), { where: t("signals.exposure.everyInterface", "en") }));
    assert.equal(issue.actionHref, "/dashboard/settings");
  } finally {
    funnelMissing();
    ufwUnreadable();
  }
});

test("privacy: the bind comes from the gateway's own listen host (CROW_GATEWAY_BIND), not a second env parse", async () => {
  const saved = process.env.CROW_GATEWAY_BIND;
  try {
    funnelOff();
    ufw("ENABLED=no\n");
    process.env.CROW_GATEWAY_BIND = "0.0.0.0";
    const wide = await privacyOf();
    assert.equal(wide.card.state, "warn", "an unset opts.bind reads listen-host.js");
    process.env.CROW_GATEWAY_BIND = "::";
    const v6Wildcard = await privacyOf();
    assert.equal(v6Wildcard.card.state, "warn", ":: is every interface too");
    process.env.CROW_GATEWAY_BIND = "127.0.0.1";
    const loop = await privacyOf();
    assert.equal(loop.card.state, "ok");
  } finally {
    if (saved == null) delete process.env.CROW_GATEWAY_BIND; else process.env.CROW_GATEWAY_BIND = saved;
    funnelMissing();
    ufwUnreadable();
  }
});

test("privacy: every interface with the host firewall ON is info, and says the rules cannot be read", async () => {
  try {
    funnelOff();
    ufw("ENABLED=yes\n");
    const { card, issue } = await privacyOf({ bind: "0.0.0.0" });
    assert.equal(card.state, "info");
    assert.match(card.value, /listens on every interface/);
    assert.match(card.value, /firewall is on/);
    assert.equal(issue.severity, "info");
    assert.match(issue.label, /rules/);
  } finally {
    funnelMissing();
    ufwUnreadable();
  }
});

test("privacy: every interface with an unreadable firewall file is a warn that names the firewall check as unknown", async () => {
  try {
    funnelOff();
    ufwUnreadable();
    const { card, issue } = await privacyOf({ bind: "0.0.0.0" });
    assert.equal(card.state, "warn", "nothing confirms the LAN is kept out, so never info or ok");
    assert.match(card.value, /firewall could not be read/);
    assert.equal(issue.severity, "warn");
    // Unknown is NOT off: the sentence says the state could not be read and
    // names the likely reasons, instead of claiming the firewall is off.
    assert.match(issue.label, /could not be read/);
    assert.match(issue.label, /firewalld or nftables/);
    assert.doesNotMatch(issue.label, /while the host firewall is off/);
    assert.equal(issue.label, fill(t("signals.exposure.lanIssueUnknown", "en"), { where: t("signals.exposure.everyInterface", "en") }));
  } finally {
    ufwUnreadable();
  }

  // A file that exists but says nothing about ENABLED is unknown the same way.
  try {
    funnelOff();
    ufw("# nothing useful here\n");
    const { card, issue } = await privacyOf({ bind: "0.0.0.0" });
    assert.equal(card.state, "warn");
    assert.match(card.value, /firewall could not be read/);
    assert.match(issue.label, /firewalld or nftables/);
    assert.doesNotMatch(issue.label, /while the host firewall is off/);
  } finally {
    funnelMissing();
    ufwUnreadable();
  }
});

test("privacy: a localhost hostname bind is loopback, not a LAN bind", async () => {
  try {
    funnelOff();
    ufw("ENABLED=no\n"); // firewall off must not matter for a loopback bind
    for (const bind of ["localhost", "ip6-localhost", "LOCALHOST"]) {
      const { card, issue } = await privacyOf({ bind });
      assert.equal(card.state, "ok", bind);
      assert.equal(issue, undefined, bind);
    }
  } finally {
    funnelMissing();
    ufwUnreadable();
  }
});

test("privacy: container detection reads the two marker files and degrades to 'not a container'", () => {
  try {
    assert.deepEqual([...CONTAINER_MARKER_PATHS], ["/.dockerenv", "/run/.containerenv"]);
    _setContainerReader(() => true);
    assert.equal(isRunningInContainer(), true);
    _setContainerReader(() => false);
    assert.equal(isRunningInContainer(), false);
    // An unreadable check is "not known to be a container", never a throw on the
    // signal path.
    _setContainerReader(() => { throw new Error("EACCES"); });
    assert.equal(isRunningInContainer(), false);
  } finally {
    _setContainerReader(() => false);
  }
});

test("privacy: inside a container the bind and firewall are info, never a warn", async () => {
  try {
    funnelOff();
    // Exactly what a container looks like: every-interface bind plus no ufw.conf,
    // which on a host is the loudest Privacy warn there is.
    ufwUnreadable();
    _setContainerReader(() => true);
    const { card, issue } = await privacyOf({ bind: "0.0.0.0" });
    assert.equal(card.state, "info", "a container is not a LAN exposure finding");
    assert.equal(issue.severity, "info");
    assert.match(card.value, /in a container/);
    assert.match(card.value, /published ports on the host/);
    assert.match(issue.label, /published ports on the host/);
    assert.doesNotMatch(issue.label, /local network may be able to reach it/);

    // A tailnet/LAN-looking bind is the same story (the container's own view).
    const lan = await privacyOf({ bind: "192.0.2.10" });
    assert.equal(lan.card.state, "info");

    // A Funnel problem still warns: that is about THIS Crow's routes, not the
    // container's network description.
    _setTailscaleReader(() => JSON.stringify({
      AllowFunnel: { "crow.example.ts.net:443": true },
      Web: { "crow.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3001" } } } },
    }));
    const funnelled = await privacyOf({ bind: "0.0.0.0" });
    assert.equal(funnelled.card.state, "warn");
    assert.equal(funnelled.issue.label, t("signals.exposure.funnel", "en"));
  } finally {
    _setContainerReader(() => false);
    funnelMissing();
    ufwUnreadable();
  }
});

test("privacy: a failing tailscale CLI is unknown, never ok", async () => {
  try {
    funnelMissing();
    ufw("ENABLED=yes\n");
    // Loopback, so the Funnel check is the only thing that could not run.
    const { card, issue } = await privacyOf({ bind: "127.0.0.1" });
    assert.notEqual(card.state, "ok", "a check that did not run can never be an ok");
    assert.equal(card.state, "info");
    assert.match(card.value, /can't check internet sharing \(Funnel\)/);
    assert.equal(issue.severity, "info");
    assert.match(issue.label, /internet sharing \(Funnel\)/);
  } finally {
    funnelMissing();
    ufwUnreadable();
  }
});

test("privacy: the existing Funnel warning is unchanged (and outranks the bind)", async () => {
  try {
    _setTailscaleReader(() => JSON.stringify({
      AllowFunnel: { "crow.example.ts.net:443": true },
      Web: { "crow.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3001" } } } },
    }));
    ufw("ENABLED=yes\n");
    const { card, issue } = await privacyOf({ bind: "127.0.0.1" });
    assert.equal(card.state, "warn");
    assert.equal(issue.label, t("signals.exposure.funnel", "en"));
    assert.equal(issue.actionHref, "/dashboard/settings?section=connections");
  } finally {
    funnelMissing();
    ufwUnreadable();
  }
});

// ─── Published ports with no fence snapshot (audit N1c-17) ───────────────────

const missingSnapshot = () => join(mkdtempSync(join(tmpdir(), "crow-pp-nosnap-")), "absent.json");

async function portsOf(dockerOut, { snapshotPath = missingSnapshot(), calls = null } = {}) {
  _setDockerPortsReader(() => { if (calls) calls.n++; if (dockerOut instanceof Error) throw dockerOut; return dockerOut; });
  invalidateHealthCache();
  const result = await collectHealthSignals(makeDb(), { now: () => NOW, publishedPorts: { snapshotPath } });
  return {
    card: result.details.find((d) => d.id === "publishedPorts"),
    issue: result.issues.find((i) => i.id === "publishedPorts"),
    warns: result.issues.filter((i) => i.id.startsWith("published-ports:") && i.severity === "warn"),
  };
}

test("publishedPorts: no snapshot + Docker publishing beyond loopback warns with the engine-fence guide", async () => {
  try {
    const { card, issue, warns } = await portsOf("0.0.0.0:8080->80/tcp, [::]:8080->80/tcp");
    assert.equal(card.state, "warn");
    assert.equal(issue.severity, "warn");
    assert.match(issue.label, /Docker publishes ports beyond this machine and the engine fence is not installed/);
    assert.equal(issue.actionHref, docsUrl("guide/engine-fence"));
    assert.match(card.value, /8080\/tcp/);
    assert.equal(warns.length, 0, "the card carries the warn; there is no per-port audit to list");
  } finally {
    _setDockerPortsReader(() => { throw new Error("no docker"); });
  }
});

test("publishedPorts: no snapshot + loopback-only Docker ports is info 'none beyond loopback'", async () => {
  try {
    const { card, issue, warns } = await portsOf("127.0.0.1:8080->80/tcp, [::1]:9000->9000/tcp");
    assert.equal(card.state, "info");
    assert.match(card.value, /no Docker ports beyond loopback/);
    assert.equal(issue.severity, "info");
    assert.equal(issue.actionHref, docsUrl("guide/engine-fence"));
    assert.equal(warns.length, 0, "no snapshot never invents a per-port warn");
  } finally {
    _setDockerPortsReader(() => { throw new Error("no docker"); });
  }
});

test("publishedPorts: no snapshot + Docker unavailable stays info 'unknown'", async () => {
  try {
    const { card, warns } = await portsOf(new Error("docker: not found"));
    assert.equal(card.state, "info");
    assert.match(card.value, /unknown/);
    assert.equal(warns.length, 0);
  } finally {
    _setDockerPortsReader(() => { throw new Error("no docker"); });
  }
});

test("publishedPorts: with a snapshot, Docker is never consulted and today's logic stands", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-pp-snap-"));
  const path = join(dir, "snapshot.json");
  writeFileSync(path, JSON.stringify({
    taken_at: new Date(NOW).toISOString(),
    docker: { version: "28.0.1", userland_proxy: true },
    tailscale: { v4: "100.64.20.5" },
    containers: [{
      id: "0123456789ab",
      name: "crow-engine",
      labels: { "crow.runtime": "docker" },
      host_config: { network_mode: "default", port_bindings: { "8011/tcp": [{ HostIp: "127.0.0.1", HostPort: "8011" }] } },
    }],
    raw_rules: { v4: [], v6: [] },
  }));
  try {
    const calls = { n: 0 };
    const { card } = await portsOf("0.0.0.0:8080->80/tcp", { snapshotPath: path, calls });
    assert.equal(calls.n, 0, "a readable snapshot is the authority; Docker is not asked");
    assert.equal(card.state, "ok", "a loopback publish is silent, exactly as before");
  } finally {
    _setDockerPortsReader(() => { throw new Error("no docker"); });
  }
});

test("publishedPorts: the docker ps ports column parses into publishes, exposed-only ports excluded", () => {
  const parsed = parseDockerPsPorts(
    "0.0.0.0:8080->80/tcp, [::]:8080->80/tcp, 9000/tcp\n127.0.0.1:5432->5432/tcp\n::1:7000->7000/tcp\n:::7070->7070/tcp",
  );
  assert.deepEqual(parsed.map((p) => [p.port, p.proto, p.kind]), [
    // 8080 is ONE publish: Docker prints the same publish once per family and
    // the card must not list it twice (and must not count it twice).
    [8080, "tcp", "wildcard"],
    [5432, "tcp", "loopback"],
    [7000, "tcp", "loopback"],
    [7070, "tcp", "wildcard"],
  ]);
  assert.deepEqual(parseDockerPsPorts(""), []);
  assert.deepEqual(parseDockerPsPorts("80/tcp, 443/tcp"), [], "exposed-only ports publish nothing");
});

test("publishedPorts: a docker ps port RANGE is every port it names, parsed on both sides", () => {
  const v4 = parseDockerPsPorts("0.0.0.0:8000-8002->8000-8002/tcp");
  assert.deepEqual(v4.map((p) => [p.port, p.proto, p.kind]), [
    [8000, "tcp", "wildcard"],
    [8001, "tcp", "wildcard"],
    [8002, "tcp", "wildcard"],
  ]);

  // The container side may be a range on its own; only the HOST side decides
  // what is published, so 9000-9001 → 80-81 is still one host port each.
  assert.deepEqual(
    parseDockerPsPorts("127.0.0.1:9000-9001->80-81/tcp").map((p) => [p.port, p.kind]),
    [[9000, "loopback"], [9001, "loopback"]],
  );

  // The same range over both families collapses to one entry per port.
  assert.deepEqual(
    parseDockerPsPorts("0.0.0.0:8000-8001->8000-8001/tcp, [::]:8000-8001->8000-8001/tcp").map((p) => [p.port, p.kind]),
    [[8000, "wildcard"], [8001, "wildcard"]],
  );

  // A reversed or out-of-range tail is read as the start port only: never
  // invent ports Docker did not print.
  assert.deepEqual(parseDockerPsPorts("0.0.0.0:8002-8000->1-3/tcp").map((p) => p.port), [8002]);
  assert.deepEqual(parseDockerPsPorts("0.0.0.0:99999->99999/tcp"), []);
});

test("publishedPorts: a duplicate publish never hides the wider address", () => {
  // A loopback bind and a wildcard bind of the same host port: the wildcard one
  // wins, so de-duplication can only ever make the card more truthful.
  const mixed = parseDockerPsPorts("127.0.0.1:8080->8080/tcp, 0.0.0.0:8080->8080/tcp");
  assert.deepEqual(mixed.map((p) => [p.port, p.kind]), [[8080, "wildcard"]]);
  const reverse = parseDockerPsPorts("0.0.0.0:8080->8080/tcp, 127.0.0.1:8080->8080/tcp");
  assert.deepEqual(reverse.map((p) => [p.port, p.kind]), [[8080, "wildcard"]]);
  // Different protocols are different publishes.
  assert.equal(parseDockerPsPorts("0.0.0.0:8080->8080/tcp, 0.0.0.0:8080->8080/udp").length, 2);
});

test("publishedPorts: a published RANGE beyond loopback warns, counted once per port", async () => {
  try {
    // The shape `docker ps` prints for `-p 8000-8002:8000-8002`, on both
    // families — the card used to drop it entirely (the regex expected a single
    // port) and read "none beyond loopback".
    const { card, issue } = await portsOf("0.0.0.0:8000-8002->8000-8002/tcp, [::]:8000-8002->8000-8002/tcp");
    assert.equal(card.state, "warn");
    assert.equal(issue.severity, "warn");
    assert.match(card.value, /3 port\(s\) beyond loopback/);
    assert.match(card.value, /8000\/tcp/);
    assert.match(card.value, /8002\/tcp/);
    assert.equal(card.value.match(/8000\/tcp/g).length, 1, "listed once, not once per family");
  } finally {
    _setDockerPortsReader(() => { throw new Error("no docker"); });
  }
});

