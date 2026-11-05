/**
 * update-quarantine.js — the update quarantine marker (audit N1c-3, Layer 0).
 *
 * `<git-dir>/crow-update-quarantine.json` records a commit this host ALREADY
 * rolled back, so the updater never pulls it again. It lives in the git dir,
 * next to the checkout lock, for three reasons:
 *   - co-hosted instances share one checkout, so one rollback must stop all of
 *     them from re-pulling the same sha;
 *   - `git reset` / `git clean` cannot move or delete it, unlike a worktree file
 *     (a rollback happens with the marker already in place);
 *   - it is never synced to another instance.
 *
 * Format v1: { v, sha, previous, reason, at, by, expires_at? }. Both shas are
 * FULL 40-hex: a prefix would also match a different commit, so a marker whose
 * sha is not a full sha is ignored by every reader.
 *
 * A rollback that a machine merely got wrong (a timeout, a busy DB) must not
 * pause updates forever, so those reasons carry a 6 h TTL. A sha whose CODE
 * does not load has no TTL: it waits for the next commit on main.
 *
 * Nothing here throws: this runs inside a tick that must still record a result.
 */
import { closeSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

export const UPDATE_QUARANTINE_FILE = "crow-update-quarantine.json";
export const UPDATE_QUARANTINE_FORMAT = 1;
/** Full shas only — see the header. */
export const FULL_SHA_RE = /^[0-9a-f]{40}$/;
/** The reader's ceiling: the real record is a few hundred bytes. */
export const UPDATE_QUARANTINE_MAX_BYTES = 64 * 1024;

/** Transient reasons: how long a rollback for one of them holds before main is
 *  retried with no new commit. Anything not listed waits for main to move.
 *
 *  `deps-failed`: `npm install` itself exited non-zero during the update, so the
 *  pulled sha never got as far as its import check or its init-db. That says
 *  nothing about the commit (a registry outage is not a bad sha), so it expires
 *  and main is retried with no new commit. */
export const TRANSIENT_QUARANTINE_MS = Object.freeze({
  "import-timeout": 6 * 60 * 60 * 1000,
  "init-db-failed": 6 * 60 * 60 * 1000,
  "deps-failed": 6 * 60 * 60 * 1000,
});

export function quarantinePath(gitDir) {
  return join(gitDir, UPDATE_QUARANTINE_FILE);
}

/** Atomic, symlink-safe write: temp + rename, "wx" so a planted file or link at
 *  the temp name is never followed. */
function writeAtomic(path, record) {
  const tmp = `${path}.tmp.${process.pid}`;
  let fd = null;
  try {
    try {
      fd = openSync(tmp, "wx", 0o600);
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      try { unlinkSync(tmp); } catch {}
      fd = openSync(tmp, "wx", 0o600);
    }
    writeSync(fd, JSON.stringify(record, null, 2));
    closeSync(fd);
    fd = null;
    renameSync(tmp, path); // rename replaces a planted symlink, never follows it
    return record;
  } catch {
    if (fd !== null) { try { closeSync(fd); } catch {} }
    try { unlinkSync(tmp); } catch {}
    return null;
  }
}

/**
 * The marker as recorded — no expiry filter (callers decide, so an expired
 * marker can still be REPORTED instead of vanishing silently).
 *
 * @returns {null|{v:number, sha:string, previous:string|null, reason:string,
 *   at:string, by:string, expires_at?:string}}
 */
export function readUpdateQuarantine({ gitDir, readFile = readFileSync, lstat = lstatSync } = {}) {
  if (!gitDir) return null;
  const path = quarantinePath(gitDir);
  // lstat, never stat: a symlink planted at the marker path must not be
  // followed (PR 2's boot guard reads the same file with the same rule), and
  // neither must a fifo, a device or a directory. Size-capped so a huge file
  // cannot be parsed into memory.
  try {
    const st = lstat(path);
    if (!st || st.isSymbolicLink() || !st.isFile() || st.size > UPDATE_QUARANTINE_MAX_BYTES) return null;
  } catch { return null; }
  let raw;
  try { raw = readFile(path, "utf8"); } catch { return null; }
  let m;
  try { m = JSON.parse(raw); } catch { return null; }
  if (!m || typeof m !== "object") return null;
  if (m.v !== UPDATE_QUARANTINE_FORMAT) return null;
  if (typeof m.sha !== "string" || !FULL_SHA_RE.test(m.sha)) return null;
  if (typeof m.reason !== "string" || !m.reason.trim()) return null;
  if (!Number.isFinite(Date.parse(m.at))) return null;
  return {
    v: m.v,
    sha: m.sha,
    previous: typeof m.previous === "string" && FULL_SHA_RE.test(m.previous) ? m.previous : null,
    reason: m.reason,
    at: m.at,
    by: typeof m.by === "string" ? m.by : "unknown",
    ...(typeof m.expires_at === "string" && Number.isFinite(Date.parse(m.expires_at))
      ? { expires_at: m.expires_at } : {}),
  };
}

/** Written when a rollback starts, so it exists BEFORE the checkout moves. A
 *  crash between the two must still leave the record that stops a re-pull. */
export function writeUpdateQuarantine({
  gitDir, sha, previous = null, reason, by = "gateway", now = Date.now(),
} = {}) {
  if (!gitDir || typeof sha !== "string" || !FULL_SHA_RE.test(sha)) return null;
  if (typeof reason !== "string" || !reason.trim()) return null;
  const ttl = TRANSIENT_QUARANTINE_MS[reason];
  const record = {
    v: UPDATE_QUARANTINE_FORMAT,
    sha,
    previous: typeof previous === "string" && FULL_SHA_RE.test(previous) ? previous : null,
    reason,
    at: new Date(now).toISOString(),
    by,
    ...(ttl ? { expires_at: new Date(now + ttl).toISOString() } : {}),
  };
  return writeAtomic(quarantinePath(gitDir), record);
}

export function clearUpdateQuarantine({ gitDir } = {}) {
  if (!gitDir) return false;
  try { unlinkSync(quarantinePath(gitDir)); return true; } catch { return false; }
}

export function quarantineExpired(marker, now = Date.now()) {
  if (!marker?.expires_at) return false;
  return Date.parse(marker.expires_at) <= now;
}

/** The marker only while it still holds; an expired one is ignored (not
 *  deleted here — the updater's evaluate() owns cleanup). */
export function activeUpdateQuarantine({ gitDir, now = Date.now() } = {}) {
  const marker = readUpdateQuarantine({ gitDir });
  if (!marker || quarantineExpired(marker, now)) return null;
  return marker;
}

/**
 * The puller's under-lock decision, called with origin/main's fresh head.
 *
 * Blocks ONLY when the full origin head equals the marker's sha (a prefix is
 * never enough) and the marker has not expired. When main has moved past it the
 * record is spent and is deleted, so the same bad sha can be re-pulled later
 * only by a commit that names it again on main.
 *
 * @returns {{blocked:boolean, marker?:object, cleared?:boolean, expired?:boolean}}
 */
export function evaluateUpdateQuarantine({ gitDir, originHeadSha = "", now = Date.now() } = {}) {
  const marker = readUpdateQuarantine({ gitDir });
  if (!marker) return { blocked: false };
  if (quarantineExpired(marker, now)) {
    clearUpdateQuarantine({ gitDir });
    return { blocked: false, expired: true, marker };
  }
  const head = String(originHeadSha || "").trim();
  if (FULL_SHA_RE.test(head) && head === marker.sha) return { blocked: true, marker };
  if (FULL_SHA_RE.test(head)) {
    clearUpdateQuarantine({ gitDir });
    return { blocked: false, cleared: true, marker };
  }
  // origin/main unreadable: neither block nor clear — a fetch failure reports
  // its own result, and deleting the record on a guess would re-pull a bad sha.
  return { blocked: false, marker };
}