/**
 * W2-4 backup integrity: runBackup() must verify the written file with a
 * PRAGMA quick_check and persist the result to dashboard_settings so the nest
 * backup signal can report it. Uses a real temp SQLite db (the gateway's own
 * crow.db, via init-db) so performBackup has something to copy.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "../node_modules/better-sqlite3/lib/index.js";

const dir = mkdtempSync(join(tmpdir(), "w2-backup-"));
const backupDir = join(dir, "backups");

before(() => {
  // init-db builds a real crow.db at $CROW_DATA_DIR/crow.db.
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir },
    stdio: "pipe",
    cwd: new URL("..", import.meta.url).pathname,
  });
});

after(() => rmSync(dir, { recursive: true, force: true }));

test("runBackup verifies the file and records ok:true", async () => {
  process.env.CROW_DATA_DIR = dir;
  process.env.CROW_DB_PATH = join(dir, "crow.db");
  process.env.CROW_BACKUP_DIR = backupDir;
  const { runBackup } = await import("../servers/gateway/routes/admin-backup.js");

  const info = await runBackup();
  assert.equal(info.ok, true);
  assert.equal(info.verified, true);

  const files = readdirSync(backupDir).filter(f => f.endsWith(".db"));
  assert.ok(files.length >= 1, "a backup file must exist");

  // The verification record must be persisted with ok:true.
  const db = new Database(join(dir, "crow.db"), { readonly: true });
  const row = db.prepare("SELECT value FROM dashboard_settings WHERE key='backup_last_verified'").get();
  db.close();
  assert.ok(row, "backup_last_verified must be written");
  const rec = JSON.parse(row.value);
  assert.equal(rec.ok, true);
  assert.equal(rec.result, "ok");
  assert.ok(rec.size_bytes > 0);
});

test("verifyBackupFile semantics: a healthy sqlite file passes quick_check", () => {
  // Independent confirmation that quick_check on a standalone copy returns "ok".
  const f = join(dir, "probe.db");
  const w = new Database(f);
  w.exec("CREATE TABLE t (x); INSERT INTO t VALUES (1);");
  w.close();
  const r = new Database(f, { readonly: true });
  const res = r.pragma("quick_check");
  r.close();
  const val = Array.isArray(res) ? (res[0]?.quick_check ?? res[0]) : res;
  assert.equal(String(val), "ok");
});
