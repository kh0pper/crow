/**
 * Admin backup endpoint.
 *
 * POST /api/admin/backup — runs an in-process better-sqlite3 `.backup()` of
 * this gateway's crow.db and writes the result to disk. This is the
 * replacement for the external-process `sqlite3 .backup` cron we removed on
 * 2026-04-22. External sqlite3 opens+closes of a WAL-mode crow.db unlink
 * -wal/-shm and orphan the gateway's FDs; keeping the backup inside the
 * gateway process avoids that entirely.
 *
 * Destination directory defaults to ~/backups/crow/, configurable via
 * CROW_BACKUP_DIR. Rotation keeps CROW_BACKUP_KEEP_DAYS (default 7) worth
 * of backups, older files in the dir are deleted on each successful run.
 *
 * Auth: localhost-only. Optionally also requires a bearer token set via
 * CROW_BACKUP_TOKEN, for defence-in-depth if the gateway ever gets reverse-
 * proxied in a way that lets remote clients look like 127.0.0.1.
 */

import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import { performBackup, createDbClient } from "../../db.js";

const DEFAULT_DIR = path.join(os.homedir(), "backups", "crow");

// Label for backup notifications. NTFY_TOPIC is used verbatim; an operator
// whose topics share a personal prefix (e.g. "myname-mpa") can set
// CROW_NTFY_LABEL_PREFIX=myname to have it stripped. Exported for tests.
export function getInstanceLabel() {
  const topic = (process.env.NTFY_TOPIC || "").toLowerCase();
  if (topic) {
    const prefix = (process.env.CROW_NTFY_LABEL_PREFIX || "").toLowerCase();
    if (prefix && topic.startsWith(prefix + "-") && topic.length > prefix.length + 1) {
      return topic.slice(prefix.length + 1);
    }
    return topic;
  }
  const dbPath = (process.env.CROW_DB_PATH || "").toLowerCase();
  if (dbPath.includes("crow-mpa")) return "mpa";
  if (dbPath.includes("home-finance")) return "finance";
  return "primary";
}

// Verify a freshly-written backup file is a structurally sound SQLite db.
// The backup is a standalone copy (better-sqlite3 .backup()), so opening a
// second read-only handle is safe — the live-WAL hazard applies only to the
// source db. quick_check is much faster than integrity_check and catches the
// failure modes that matter (truncation, page corruption).
function verifyBackupFile(dest) {
  let handle = null;
  try {
    handle = new Database(dest, { readonly: true, fileMustExist: true });
    const rows = handle.pragma("quick_check");
    const result = Array.isArray(rows) ? String(rows[0]?.quick_check ?? rows[0]) : String(rows);
    return { ok: result === "ok", result };
  } catch (err) {
    return { ok: false, result: err.message };
  } finally {
    try { handle?.close(); } catch {}
  }
}

async function recordVerification(record) {
  const sdb = createDbClient();
  try {
    const ser = JSON.stringify(record);
    await sdb.execute({
      sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('backup_last_verified', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')",
      args: [ser, ser],
    });
  } finally {
    try { sdb.close(); } catch {}
  }
}

function pruneOldBackups(dir, keepDays) {
  if (!keepDays || keepDays <= 0) return { pruned: 0 };
  const cutoff = Date.now() - keepDays * 24 * 3600 * 1000;
  let pruned = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".db")) continue;
      const full = path.join(dir, name);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) {
          fs.unlinkSync(full);
          pruned++;
        }
      } catch {}
    }
  } catch {}
  return { pruned };
}

function normalizeIp(req) {
  const raw = req.ip || req.socket?.remoteAddress || "";
  return raw.replace(/^::ffff:/, "");
}

function requireLocalhost(req, res, next) {
  const addr = normalizeIp(req);
  if (addr === "127.0.0.1" || addr === "::1") return next();
  return res.status(403).json({ error: "backup endpoint is localhost-only", got: addr });
}

function requireToken(req, res, next) {
  const required = process.env.CROW_BACKUP_TOKEN;
  if (!required) return next();
  const provided = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
  if (provided !== required) return res.status(401).json({ error: "invalid backup token" });
  next();
}

/**
 * Run a database backup. Exported for use by the dashboard "Run backup now"
 * action (POST /dashboard/nest/backup). The localhost route below calls this
 * same function — behavior is identical from both callers.
 *
 * @returns {Promise<{ok: boolean, instance: string, path: string, size_bytes: number,
 *   duration_ms: number, pages_copied: number|null, pruned_older_than_days: number,
 *   pruned_count: number}>}
 */
export async function runBackup() {
  const dir = process.env.CROW_BACKUP_DIR || DEFAULT_DIR;
  const keepDays = parseInt(process.env.CROW_BACKUP_KEEP_DAYS || "7", 10);
  const label = getInstanceLabel();
  const date = new Date().toISOString().split("T")[0];
  const dest = path.join(dir, `${label}-${date}.db`);

  fs.mkdirSync(dir, { recursive: true });
  const started = Date.now();
  const result = await performBackup(null, dest);
  const size = fs.statSync(dest).size;

  // Verify the backup before declaring success — a backup you can't restore
  // is worse than no backup, because it gives false confidence (W2-4).
  const verify = size > 0 ? verifyBackupFile(dest) : { ok: false, result: "empty file" };
  await recordVerification({
    path: dest, ok: verify.ok, result: verify.result,
    size_bytes: size, checked_at: new Date().toISOString(),
  });

  const prune = pruneOldBackups(dir, keepDays);
  if (!verify.ok) {
    // Surfaces as flash=backup_fail on the dashboard path and HTTP 500 on the
    // localhost API — the record is already persisted so the nest signal warns.
    throw new Error(`backup verification failed: ${verify.result}`);
  }
  return {
    ok: true,
    instance: label,
    path: dest,
    size_bytes: size,
    verified: true,
    duration_ms: Date.now() - started,
    pages_copied: result?.totalPages ?? null,
    pruned_older_than_days: keepDays,
    pruned_count: prune.pruned,
  };
}

export default function adminBackupRouter() {
  const router = Router();

  router.post("/api/admin/backup", requireLocalhost, requireToken, async (req, res) => {
    try {
      const info = await runBackup();
      res.json(info);
    } catch (err) {
      console.error("[admin-backup] FAILED:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
