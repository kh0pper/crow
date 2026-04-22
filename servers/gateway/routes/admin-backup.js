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
import { performBackup } from "../../db.js";

const DEFAULT_DIR = path.join(os.homedir(), "backups", "crow");

function getInstanceLabel() {
  const topic = (process.env.NTFY_TOPIC || "").toLowerCase();
  const m = topic.match(/^kevin-(.+)$/);
  if (m) return m[1];
  const dbPath = (process.env.CROW_DB_PATH || "").toLowerCase();
  if (dbPath.includes("crow-mpa")) return "mpa";
  if (dbPath.includes("home-finance")) return "finance";
  return "primary";
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

export default function adminBackupRouter() {
  const router = Router();

  router.post("/api/admin/backup", requireLocalhost, requireToken, async (req, res) => {
    const dir = process.env.CROW_BACKUP_DIR || DEFAULT_DIR;
    const keepDays = parseInt(process.env.CROW_BACKUP_KEEP_DAYS || "7", 10);
    const label = getInstanceLabel();
    const date = new Date().toISOString().split("T")[0];
    const dest = path.join(dir, `${label}-${date}.db`);

    try {
      fs.mkdirSync(dir, { recursive: true });
      const started = Date.now();
      const result = await performBackup(null, dest);
      const size = fs.statSync(dest).size;
      const prune = pruneOldBackups(dir, keepDays);
      res.json({
        ok: true,
        instance: label,
        path: dest,
        size_bytes: size,
        duration_ms: Date.now() - started,
        pages_copied: result?.totalPages ?? null,
        pruned_older_than_days: keepDays,
        pruned_count: prune.pruned,
      });
    } catch (err) {
      console.error("[admin-backup] FAILED:", err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}
