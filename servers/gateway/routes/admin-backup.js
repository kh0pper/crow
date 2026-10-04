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
 * CROW_BACKUP_DIR. File names, ownership sidecars and per-instance retention
 * (CROW_BACKUP_KEEP_DAYS, default 7) live in servers/shared/backup-naming.js —
 * read its header for the co-hosted naming scheme and the restore note.
 *
 * Auth: localhost-only. Optionally also requires a bearer token set via
 * CROW_BACKUP_TOKEN, for defence-in-depth if the gateway ever gets reverse-
 * proxied in a way that lets remote clients look like 127.0.0.1.
 */

import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { performBackup, createDbClient } from "../../db.js";
import {
  backupLabel, localBackupContext, backupFileName, backupStem, ownBackupRegex,
  listOwnBackups, readOwner, isForeignOwner, ownerPath, newestBackupOwnership,
} from "../../shared/backup-naming.js";
import { coHostedDataDirWarning } from "../../shared/crow-home.js";

// Kept for existing callers/tests; the logic lives in shared/backup-naming.js.
export function getInstanceLabel() {
  return backupLabel(process.env);
}

// Verify a freshly-written backup file is a structurally sound SQLite db, and
// fold any WAL it carries into the main file. The backup is a standalone copy
// (better-sqlite3 .backup()), so a read-write handle on it is safe — the
// live-WAL hazard applies only to the source db. quick_check is much faster
// than integrity_check and catches the failure modes that matter (truncation,
// page corruption). wal_checkpoint(TRUNCATE) + close leaves no -wal/-shm, so
// the copy is ONE self-contained file that can be renamed into place.
function verifyBackupFile(dest) {
  let handle = null;
  try {
    handle = new Database(dest, { fileMustExist: true });
    const rows = handle.pragma("quick_check");
    const result = Array.isArray(rows) ? String(rows[0]?.quick_check ?? rows[0]) : String(rows);
    if (result === "ok") {
      try { handle.pragma("wal_checkpoint(TRUNCATE)"); } catch {}
    }
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

function unlinkQuiet(p) {
  try { fs.unlinkSync(p); return true; } catch { return false; }
}

// Remove a backup file plus everything that belongs to it: its owner sidecar
// and any -wal/-shm a reader left behind.
function removeBackupFile(full) {
  const removed = unlinkQuiet(full);
  for (const suffix of ["-wal", "-shm"]) unlinkQuiet(full + suffix);
  unlinkQuiet(ownerPath(full));
  return removed;
}

/**
 * Per-instance retention: only THIS instance's files (its own name pattern)
 * are ever pruned, and never one whose sidecar names another instance.
 * Leftover temp files of this instance older than a day are swept too.
 * Exported for tests.
 */
export function pruneOwnBackups(dir, { label, tag, me, keepDays, nowMs = Date.now() }) {
  if (!keepDays || keepDays <= 0) return { pruned: 0 };
  const cutoff = nowMs - keepDays * 24 * 3600 * 1000;
  let pruned = 0;
  for (const f of listOwnBackups(dir, label, tag)) {
    if (f.mtimeMs >= cutoff) continue;
    if (isForeignOwner(readOwner(f.path), me)) continue;
    if (removeBackupFile(f.path)) pruned++;
  }
  // Anchored on the full own name + date, so another instance's temp files
  // (".primary-crow-r4-…") never match the host-default stem.
  const tmpRe = new RegExp(`^\\.${backupStem(label, tag).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d{4}-\\d{2}-\\d{2}\\.db\\.tmp-`);
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!tmpRe.test(name)) continue;
      const full = path.join(dir, name);
      try { if (fs.statSync(full).mtimeMs < nowMs - 24 * 3600 * 1000) unlinkQuiet(full); } catch {}
    }
  } catch {}
  return { pruned };
}

function foreignError(dest, owner) {
  const who = owner.crow_home || owner.instance_id || "another instance";
  const err = new Error(`refusing to overwrite ${dest}: it belongs to a different instance (${who})`);
  err.code = "BACKUP_FOREIGN";
  return err;
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
export async function runBackup(opts = {}) {
  try {
    return await runBackupInner(opts);
  } catch (err) {
    // Every failure (refused overwrite, copy error, leftover WAL, verification)
    // reaches the Nest signal as a failed attempt newer than our newest file.
    if (!err.recorded) {
      try {
        await recordVerification({ path: null, ok: false, result: err.message, checked_at: new Date().toISOString(), kept_previous: true });
      } catch {}
    }
    throw err;
  }
}

async function runBackupInner({ now = new Date() } = {}) {
  const { dir, label, tag, me } = localBackupContext(process.env);
  const keepDays = parseInt(process.env.CROW_BACKUP_KEEP_DAYS || "7", 10);
  const date = now.toISOString().split("T")[0];
  const name = backupFileName(label, tag, date);
  const dest = path.join(dir, name);

  fs.mkdirSync(dir, { recursive: true });

  // Never replace a same-day file another instance owns (co-hosted gateways
  // sharing one backup dir). Checked before the copy and again before rename.
  const assertNotForeign = () => {
    const owner = fs.existsSync(dest) ? readOwner(dest) : null;
    if (owner && isForeignOwner(owner, me)) throw foreignError(dest, owner);
  };
  assertNotForeign();

  // Write-then-rename: the copy lands in a dot-prefixed temp file in the same
  // directory (same filesystem → atomic rename; the dot + ".tmp-" suffix keep
  // it out of every *.db scan), so a crash or a failed verification never
  // leaves a torn file under the real name or clobbers yesterday's good one.
  const tmp = path.join(dir, `.${name}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  const started = Date.now();
  let result;
  try {
    result = await performBackup(null, tmp);
  } catch (err) {
    removeBackupFile(tmp);
    throw err;
  }
  const size = fs.statSync(tmp).size;

  // Verify the backup before declaring success — a backup you can't restore
  // is worse than no backup, because it gives false confidence (W2-4).
  const verify = size > 0 ? verifyBackupFile(tmp) : { ok: false, result: "empty file" };
  if (!verify.ok) {
    removeBackupFile(tmp);
    await recordVerification({
      path: dest, ok: false, result: verify.result,
      size_bytes: size, checked_at: new Date().toISOString(), kept_previous: true,
    });
    // Surfaces as flash=backup_fail on the dashboard path and HTTP 500 on the
    // localhost API — the record is already persisted so the nest signal warns.
    const err = new Error(`backup verification failed: ${verify.result}`);
    err.recorded = true;
    throw err;
  }

  // The checkpoint above emptied any WAL; a leftover non-empty one would mean
  // committed pages live outside the file we are about to rename.
  try {
    const wal = fs.statSync(tmp + "-wal");
    if (wal.size > 0) {
      removeBackupFile(tmp);
      throw new Error("backup copy still has an un-checkpointed WAL");
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  for (const suffix of ["-wal", "-shm"]) unlinkQuiet(tmp + suffix);

  try {
    assertNotForeign();
    // A -wal/-shm left beside the OLD file (a reader opened it) must not be
    // replayed onto the new copy.
    for (const suffix of ["-wal", "-shm"]) unlinkQuiet(dest + suffix);
    fs.renameSync(tmp, dest);
  } catch (err) {
    removeBackupFile(tmp);
    throw err;
  }
  const sidecarTmp = `${tmp}${".owner"}`;
  try {
    // size + mtime fingerprint: a later in-place rewrite of the file (a
    // co-hosted gateway still on old code) shows up as a "mismatch".
    const st = fs.statSync(dest);
    fs.writeFileSync(sidecarTmp, JSON.stringify({ ...me, written_at: new Date().toISOString(), size_bytes: st.size, mtime_ms: st.mtimeMs }, null, 2) + "\n");
    fs.renameSync(sidecarTmp, ownerPath(dest));
  } catch (err) {
    unlinkQuiet(sidecarTmp);
    console.warn("[admin-backup] could not write owner sidecar:", err.message);
  }

  await recordVerification({
    path: dest, ok: true, result: verify.result,
    size_bytes: size, checked_at: new Date().toISOString(),
  });

  const prune = pruneOwnBackups(dir, { label, tag, me, keepDays });
  return {
    ok: true,
    instance: label,
    instance_tag: tag,
    instance_id: me.instance_id,
    path: dest,
    size_bytes: size,
    verified: true,
    duration_ms: Date.now() - started,
    pages_copied: result?.totalPages ?? null,
    pruned_older_than_days: keepDays,
    pruned_count: prune.pruned,
  };
}

/**
 * Boot self-check (post-listen): WARN when this instance's newest backup file
 * was written by a different instance (co-hosted gateways sharing a backup
 * dir), and when a co-hosted CROW_HOME has no CROW_DATA_DIR. The Nest backup
 * signal reports the same "foreign" state as a warn, so the health monitor
 * also raises a dashboard notification. Never throws.
 * @returns {{status:string, path:string|null}}
 */
export function backupSelfCheck({ env = process.env, log = console } = {}) {
  try {
    const dataDirWarning = coHostedDataDirWarning(env);
    if (dataDirWarning) log.warn(`[backup] WARNING: ${dataDirWarning}`);
    const { dir, label, tag, me } = localBackupContext(env);
    const own = newestBackupOwnership(dir, label, tag, me);
    if (own.status === "foreign") {
      log.warn(`[backup] WARNING: newest backup ${own.newest.path} belongs to another instance ` +
        `(crow_home=${own.owner.crow_home || "?"}, instance_id=${own.owner.instance_id || "?"}); ` +
        `this instance (crow_home=${me.crow_home}) has no backup of its own under that name — run a backup.`);
    } else if (own.status === "mismatch") {
      log.warn(`[backup] WARNING: newest backup ${own.newest.path} was rewritten after this instance wrote it ` +
        `(size/mtime no longer match its owner sidecar) — another process overwrote it; run a backup.`);
    } else if (own.status === "unknown") {
      log.log(`[backup] newest backup ${own.newest.path} predates ownership sidecars — owner unknown until the next run`);
    }
    return { status: own.status, path: own.newest?.path || null };
  } catch (err) {
    log.warn(`[backup] self-check failed: ${err.message}`);
    return { status: "error", path: null };
  }
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
