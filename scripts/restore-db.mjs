#!/usr/bin/env node
/**
 * Node side of `npm run restore` (scripts/restore.sh).
 *
 * The restore itself is a file copy, but three steps must not use the sqlite3
 * CLI (N1c-9/N1c-13):
 *
 *   safety-copy  Take the whole CURRENT database before it is replaced. A
 *                `cp crow.db` misses everything still sitting in crow.db-wal,
 *                so the pre-restore copy is a better-sqlite3 online .backup()
 *                — it reads through the WAL and writes one self-contained
 *                file, 0600.
 *   inspect      --dry-run listing of a .db backup: quick_check, the table
 *                list and per-table row counts.
 *   verify       Post-restore check: quick_check plus the table and memories
 *                counts.
 *   gateway-check  Is the gateway answering on its port? restore.sh refuses
 *                while it is (a live gateway holds the -wal/-shm we remove).
 *
 * Globals stay off the live file: every path here is either a copy, the
 * freshly restored DB, or the current DB of a host whose gateway is stopped.
 */
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { gatewayListenPort } from "../servers/gateway/listen-port.js";
import { probeGateway } from "./backup-db.mjs";

const FILE_MODE = 0o600;

function chmodQuiet(p, mode) {
  try { fs.chmodSync(p, mode); } catch { /* not ours / gone */ }
}

function quickCheck(file) {
  let handle = null;
  try {
    handle = new Database(file, { fileMustExist: true });
    const rows = handle.pragma("quick_check");
    const result = Array.isArray(rows) ? String(rows[0]?.quick_check ?? rows[0]) : String(rows);
    return { ok: result === "ok", result, handle };
  } catch (err) {
    try { handle?.close(); } catch { /* closed */ }
    return { ok: false, result: err.message, handle: null };
  }
}

function tablesOf(handle) {
  try {
    return handle.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all().map((r) => r.name);
  } catch {
    return [];
  }
}

function countRows(handle, table) {
  try {
    return handle.prepare(`SELECT COUNT(*) AS n FROM "${table.replace(/"/g, '""')}"`).get().n;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- commands */

/** Whole copy of a live/OFFLINE database into `dest`, 0600. */
async function safetyCopy(dbPath, dest) {
  if (!fs.existsSync(dbPath)) {
    console.log(`  No database at ${dbPath} — nothing to save.`);
    return 0;
  }
  try { fs.unlinkSync(dest); } catch { /* fresh name */ }
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    // better-sqlite3's online backup API is asynchronous and reads through
    // the WAL, so un-checkpointed rows land in the copy.
    await db.backup(dest);
  } finally {
    try { db.close(); } catch { /* closed */ }
  }
  chmodQuiet(dest, FILE_MODE);
  const check = quickCheck(dest);
  try { check.handle?.close(); } catch { /* closed */ }
  if (!check.ok) {
    console.error(`  Warning: the pre-restore copy failed quick_check (${check.result}). It was kept at ${dest}.`);
    return 0;
  }
  const size = fs.statSync(dest).size;
  console.log(`  Saved a whole copy of the current database (WAL included): ${size} bytes, quick_check ok.`);
  return 0;
}

/** --dry-run preview of a .db backup. */
function inspect(file) {
  const check = quickCheck(file);
  if (!check.ok) {
    console.log(`    (could not read — ${check.result})`);
    return 0;
  }
  const handle = check.handle;
  try {
    const tables = tablesOf(handle);
    console.log(`  Quick check: ${check.result}`);
    console.log(`  Tables (${tables.length}):`);
    for (const t of tables) {
      const n = countRows(handle, t);
      console.log(`    ${t}: ${n === null ? "?" : n}`);
    }
  } finally {
    try { handle.close(); } catch { /* closed */ }
  }
  return 0;
}

/** Post-restore verification: quick_check + table and memories counts. */
function verify(file) {
  const check = quickCheck(file);
  if (!check.ok) {
    console.error(`  Integrity check FAILED: ${check.result}`);
    return 1;
  }
  const handle = check.handle;
  try {
    const tables = tablesOf(handle);
    const memories = countRows(handle, "memories");
    console.log(`  Quick check: ${check.result}`);
    console.log(`  Tables: ${tables.length}`);
    console.log(`  Memories: ${memories === null ? "n/a" : memories}`);
  } finally {
    try { handle.close(); } catch { /* closed */ }
  }
  return 0;
}

/** Print "<port> <up|down>"; exit 0 when the gateway answers, 3 when it does not. */
async function gatewayCheck() {
  const port = gatewayListenPort();
  const probe = await probeGateway(port);
  process.stdout.write(`${port} ${probe.up ? "up" : "down"}\n`);
  return probe.up ? 0 : 3;
}

/* ------------------------------------------------------------------- main */

export async function main(argv = process.argv.slice(2)) {
  const [cmd, a, b] = argv;
  switch (cmd) {
    case "safety-copy":
      if (!a || !b) throw new Error("usage: restore-db.mjs safety-copy <db> <dest>");
      return await safetyCopy(a, b);
    case "inspect":
      if (!a) throw new Error("usage: restore-db.mjs inspect <backup.db>");
      return inspect(a);
    case "verify":
      if (!a) throw new Error("usage: restore-db.mjs verify <db>");
      return verify(a);
    case "gateway-check":
      return gatewayCheck();
    default:
      console.log("usage: node scripts/restore-db.mjs safety-copy <db> <dest> | inspect <backup.db> | verify <db> | gateway-check");
      return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code ?? 0))
    .catch((err) => {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    });
}