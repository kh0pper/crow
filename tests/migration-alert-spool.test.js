/**
 * N1c-2 — update and migration failures must reach the operator inside Crow.
 *
 * Part 1 (the guard): the migration guard may not write crow.db (the DB is the
 * thing that may be broken), so a failure drops one small JSON file under
 * <CROW_HOME>/alerts/pending with mode 0600 in a 0700 dir. Driven through
 * runGuardedInitDb with the existing guard harness + _setAlertChannelsForTest,
 * so the ntfy/email rail is observable and no network happens.
 *
 * Part 2 (delivery): the gateway turns each pending file into one in-app
 * notification at boot and moves it to alerts/delivered/. Idempotent by file
 * name, so a crash between insert and move cannot bell twice.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";

import { runGuardedInitDb, fireMigrationAlert, _setAlertChannelsForTest } from "../servers/shared/migration-guard.js";
import {
  writeAlertFile, drainAlertSpool, alertsDirs, alertsRoot, _setAlertsRootForTest,
  SPOOL_MAX, DELIVERED_KEEP, ALERTS_ACTION_URL, ALERTS_NOTIFICATION_SOURCE,
} from "../servers/shared/alert-spool.js";
import { createDbClient } from "../servers/db.js";
import { createNotification } from "../servers/shared/notifications.js";

const REPO = join(import.meta.dirname, "..");

function stubAlerts() {
  const calls = [];
  _setAlertChannelsForTest({
    sendNtfyNotification: async (p) => calls.push(["ntfy", p]),
    sendEmailNotification: async (p) => calls.push(["email", p]),
  });
  return calls;
}

function cleanupAlerts() {
  _setAlertChannelsForTest(null);
  _setAlertsRootForTest(null);
}

function makeFixtureDb(dbPath, { victimRows = 20 } = {}) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE memories (id INTEGER PRIMARY KEY, content TEXT);
    CREATE TABLE dashboard_settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE crow_context (id INTEGER PRIMARY KEY, section TEXT);
    CREATE TABLE test_data (id INTEGER PRIMARY KEY, payload TEXT);
  `);
  const ins = db.prepare("INSERT INTO test_data (payload) VALUES (?)");
  for (let i = 0; i < victimRows; i++) ins.run(`row-${i}`);
  db.pragma("user_version = 8");
  db.close();
}

const copyBackup = async (src, dest) => {
  const db = new Database(src, { readonly: true });
  try { await db.backup(dest); } finally { db.close(); }
};

/* ------------------------------------------------- the guard's spool write */

test("guard: one failure writes exactly one 0600 spool file in a 0700 dir, with no row data", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "n1c2-guard-"));
  t.after(() => { cleanupAlerts(); rmSync(dir, { recursive: true, force: true }); });
  const dbPath = join(dir, "data", "crow.db");
  makeFixtureDb(dbPath);
  const alerts = stubAlerts();
  _setAlertsRootForTest(join(dir, "alerts"));
  const dirs = alertsDirs();

  const destructive = async () => {
    const db = new Database(dbPath);
    db.exec("DROP TABLE test_data");
    db.pragma("user_version = 9");
    db.close();
    return { code: 0 };
  };
  const res = await runGuardedInitDb({
    dbPath, appRoot: dir, sha: "badsha", newGeneration: 9,
    log: () => {}, runInitDb: destructive, performBackupFn: copyBackup,
  });
  assert.equal(res.verdict, "loss");

  const files = readdirSync(dirs.pending);
  assert.equal(files.length, 1, `exactly one spool file, saw ${files}`);
  assert.equal(statSync(dirs.pending).mode & 0o777, 0o700, "spool dir is 0700");
  const full = join(dirs.pending, files[0]);
  assert.equal(statSync(full).mode & 0o777, 0o600, "spool file is 0600");

  const rec = JSON.parse(readFileSync(full, "utf8"));
  assert.deepEqual(Object.keys(rec).sort(), ["at", "body", "code", "title"]);
  assert.equal(rec.code, "migration-loss");
  assert.match(rec.title, /migration quarantined/);
  assert.ok(Number.isFinite(Date.parse(rec.at)), `at is a time: ${rec.at}`);
  // Same text the ntfy/email alert carried, and no row data from the DB.
  assert.ok(alerts.some(([ch, p]) => ch === "ntfy" && p.title === rec.title), "same alert text as ntfy");
  assert.ok(alerts.some(([ch, p]) => ch === "email" && p.body === rec.body), "same alert text as email");
  const text = JSON.stringify(rec);
  assert.ok(!/"payload"|row-\d/.test(text), `no row data in the spool file: ${text}`);
});

test("guard: the spool cap drops the oldest file past 50", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "n1c2-cap-"));
  t.after(() => { cleanupAlerts(); rmSync(dir, { recursive: true, force: true }); });
  _setAlertsRootForTest(join(dir, "alerts"));
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  for (let i = 0; i < SPOOL_MAX + 5; i++) {
    const at = new Date(base + i * 1000).toISOString();
    assert.ok(writeAlertFile({ code: `code-${i}`, title: `alert ${i}`, body: "b", at }), `wrote ${i}`);
  }
  const dirs = alertsDirs();
  const files = readdirSync(dirs.pending).filter((f) => f.endsWith(".json")).sort();
  assert.equal(files.length, SPOOL_MAX, "capped at 50");
  const codes = files.map((f) => JSON.parse(readFileSync(join(dirs.pending, f), "utf8")).code);
  assert.deepEqual(codes, Array.from({ length: SPOOL_MAX }, (_, i) => `code-${i + 5}`), "the oldest five are gone, the rest in order");
});

test("guard: a failing spool write never throws, and the other railings still fire", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "n1c2-fail-"));
  t.after(() => { cleanupAlerts(); rmSync(dir, { recursive: true, force: true }); });
  // A regular file where `alerts/` must be created → mkdirSync throws ENOTDIR.
  writeFileSync(join(dir, "blocked"), "not a directory");
  _setAlertsRootForTest(join(dir, "blocked", "alerts"));
  const alerts = stubAlerts();
  await fireMigrationAlert({ code: "x", title: "t", body: "b" }); // must not reject
  assert.equal(writeAlertFile({ code: "x", title: "t", body: "b" }), null, "the write reports failure");
  assert.ok(alerts.some(([ch]) => ch === "ntfy"), "ntfy was still attempted");
  assert.ok(alerts.some(([ch]) => ch === "email"), "email was still attempted");
});

test("guard: the alert path opens no database at all", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "n1c2-dbfree-"));
  t.after(() => { cleanupAlerts(); rmSync(dir, { recursive: true, force: true }); });
  stubAlerts();
  _setAlertsRootForTest(join(dir, "alerts"));
  await fireMigrationAlert({ code: "db-free", title: "Crow alert", body: "body" });
  assert.equal(readdirSync(join(alertsRoot(), "pending")).length, 1, "the file was written");
  assert.deepEqual(readdirSync(dir), ["alerts"], "nothing else was created — no DB, no data dir");

  // Rot-guard: the spool module imports nothing that could open crow.db.
  const src = readFileSync(join(REPO, "servers", "shared", "alert-spool.js"), "utf8");
  const imports = src.split("\n").filter((l) => /^import\s/.test(l)).join("\n");
  assert.ok(!/better-sqlite3|createDbClient|\.\.\/db\.js|notifications\.js|migration-guard/.test(imports), imports);
});

/* ------------------------------------------------------------- delivery */

function scratchDb(t) {
  const dir = mkdtempSync(join(tmpdir(), "n1c2-drain-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_HOME: dir, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO,
  });
  const db = createDbClient(join(dir, "crow.db"));
  t.after(() => { cleanupAlerts(); try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  _setAlertsRootForTest(join(dir, "alerts"));
  // deliver:false — the fan-out (web push/ntfy/email) is another module's
  // contract; these tests are about rows, moves and dedupe.
  const notify = (d, opts) => createNotification(d, { ...opts, deliver: false });
  const rows = async () => (await db.execute({ sql: "SELECT * FROM notifications ORDER BY id", args: [] })).rows;
  return { dir, db, notify, rows };
}

test("delivery: two spool files become two high-priority system bells and both move to delivered/", async (t) => {
  const s = scratchDb(t);
  const dirs = alertsDirs();
  const logs = [];
  writeAlertFile({ code: "migration-loss", title: "Crow migration guard: data loss detected — migration quarantined", body: "The database was RESTORED from the pre-migration backup.", at: "2026-01-01T00:00:00.000Z" });
  writeAlertFile({ code: "init-db-failed", title: "Crow init-db failed during auto-update", body: "init-db exited 1 after pulling an update.", at: "2026-01-01T00:00:01.000Z" });

  const res = await drainAlertSpool(s.db, { createNotification: s.notify, log: (m) => logs.push(m) });
  assert.deepEqual(res, { delivered: 2, duplicates: 0, bad: 0, failed: 0 });

  const rows = await s.rows();
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.type, "system");
    assert.equal(r.priority, "high");
    assert.equal(r.source, ALERTS_NOTIFICATION_SOURCE);
    assert.equal(r.action_url, ALERTS_ACTION_URL);
  }
  assert.match(rows[0].title, /migration quarantined/);
  assert.match(rows[1].title, /init-db failed/);
  assert.deepEqual(JSON.parse(rows[0].metadata).spool, readdirSync(dirs.delivered).sort()[0], "the file name is the dedupe key");
  assert.equal(readdirSync(dirs.pending).length, 0, "pending/ is empty");
  assert.equal(readdirSync(dirs.delivered).length, 2, "both files are in delivered/");
  assert.equal(logs.length, 1, `one summary line, saw ${logs.length}`);
});

test("delivery: a file left in pending/ after its row was written never duplicates", async (t) => {
  const s = scratchDb(t);
  const dirs = alertsDirs();
  writeAlertFile({ code: "migration-loss", title: "data loss detected", body: "b", at: "2026-01-01T00:00:00.000Z" });
  const first = await drainAlertSpool(s.db, { createNotification: s.notify, log: () => {} });
  assert.equal(first.delivered, 1);
  assert.equal((await s.rows()).length, 1);

  // Simulate a crash after the INSERT but before the move: the file is back in
  // pending/ while the notification row already exists.
  const moved = readdirSync(dirs.delivered)[0];
  copyFileSync(join(dirs.delivered, moved), join(dirs.pending, moved));
  const second = await drainAlertSpool(s.db, { createNotification: s.notify, log: () => {} });
  assert.equal(second.delivered, 0);
  assert.equal(second.duplicates, 1);
  assert.equal((await s.rows()).length, 1, "still one notification");
  assert.equal(readdirSync(dirs.pending).length, 0, "the leftover file moved on the second pass");
});

test("delivery: a malformed file goes to bad/ with exactly one log line", async (t) => {
  const s = scratchDb(t);
  const dirs = alertsDirs();
  mkdirSync(dirs.pending, { recursive: true, mode: 0o700 });
  writeFileSync(join(dirs.pending, "2026-01-01T00-00-00-000Z-broken.json"), "{not json");
  const logs = [];
  const res = await drainAlertSpool(s.db, { createNotification: s.notify, log: (m) => logs.push(m) });
  assert.equal(res.bad, 1);
  assert.equal((await s.rows()).length, 0, "no notification for an unreadable file");
  assert.deepEqual(readdirSync(dirs.bad), ["2026-01-01T00-00-00-000Z-broken.json"]);
  assert.equal(readdirSync(dirs.pending).length, 0);
  assert.equal(logs.length, 1, `exactly one line about the bad file, saw ${logs.length}`);
  assert.match(logs[0], /unreadable alert file .* moved to bad\//);
});

test("delivery: delivered/ keeps only the newest 100 files", async (t) => {
  const s = scratchDb(t);
  const dirs = alertsDirs();
  mkdirSync(dirs.delivered, { recursive: true, mode: 0o700 });
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  let newest = null;
  for (let i = 0; i < DELIVERED_KEEP + 5; i++) {
    const stamp = new Date(base + i * 1000).toISOString().replace(/[:.]/g, "-");
    newest = `${stamp}-old.json`;
    writeFileSync(join(dirs.delivered, newest), "{}");
  }
  await drainAlertSpool(s.db, { createNotification: s.notify, log: () => {} });
  const left = readdirSync(dirs.delivered).sort();
  assert.equal(left.length, DELIVERED_KEEP);
  assert.ok(!left.includes("2026-01-01T00-00-00-000Z-old.json"), "the oldest five are gone");
  assert.ok(left.includes(newest), "the newest is kept");
});