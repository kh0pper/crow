/**
 * alert-spool.js — the DB-free alert spool (audit N1c-2).
 *
 * The migration guard runs on paths where crow.db may be broken (a failed
 * migration, a restore in progress), so it HARD-RULES never writes the DB. Its
 * alerts therefore only ever reached ntfy + email, which are unconfigured on a
 * default install: nobody heard about a quarantined migration. So the guard
 * drops one small JSON file per alert under `<CROW_HOME>/alerts/pending`, and
 * the gateway drains that spool into in-app notifications once its DB is up
 * (servers/gateway/boot/post-listen.js).
 *
 * The file holds display text only — code, title, body, time — masked with the
 * same secret mask every other display surface uses. Never row data: the DB it
 * is describing may be the broken thing.
 *
 * Nothing in here throws: an alerting failure must never become the guard's
 * failure. Callers get null / a zeroed result instead.
 */
import { lstatSync,
  chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { resolveCrowHome } from "./crow-home.js";
import { maskSecrets } from "./secret-mask.js";

/** Pending files kept: past this the OLDEST is dropped (a wedged instance
 *  must not fill the disk with one file per failed boot). */
export const SPOOL_MAX = 50;
/** Delivered files kept for forensics; the notifications themselves carry the
 *  operator-facing record, so this is only a short audit trail. */
export const DELIVERED_KEEP = 100;

/** Where the dashboard shows update/migration state. */
export const ALERTS_ACTION_URL = "/dashboard/settings?section=updates";
/** `source` of a spooled alert's notification. */
export const ALERTS_NOTIFICATION_SOURCE = "migrations";

let _root = null;
/** Test-only: retarget the spool at a scratch directory. */
export function _setAlertsRootForTest(dir) { _root = dir; }

/** `<CROW_HOME>/alerts` — the instance home, never a hardcoded ~/.crow. */
export function alertsRoot() {
  return _root || join(resolveCrowHome(), "alerts");
}

export function alertsDirs() {
  const root = alertsRoot();
  return { root, pending: join(root, "pending"), delivered: join(root, "delivered"), bad: join(root, "bad") };
}

/** 0700, always — the alert text can name a database path. */
function ensureDir(dir) {
  // Walk alerts/ then the subdirectory BEFORE creating anything: a planted
  // symlink (or a non-directory) is refused, never followed, so no write, mkdir
  // or chmod can land outside CROW_HOME. Each level is created non-recursively.
  // CROW_HOME itself may legitimately be a symlink and is not checked.
  for (const d of [alertsRoot(), dir]) {
    let st = null;
    try { st = lstatSync(d); } catch (err) { if (err?.code !== "ENOENT") throw err; }
    if (st === null) {
      mkdirSync(d, { mode: 0o700 });
      st = lstatSync(d);
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${d} is not a plain directory; refusing to use it`);
    try { chmodSync(d, 0o700); } catch {}
  }
}

function slugFor(code) {
  const slug = String(code || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return slug || "alert";
}

/**
 * Write one alert file atomically (temp file + rename) with mode 0600.
 *
 * @param {{code?:string, title:string, body?:string|null, at?:string}} alert
 * @returns {string|null} the file path, or null when it could not be written
 */
export function writeAlertFile({ code = "alert", title, body = null, at = new Date().toISOString() } = {}) {
  let tmp = null;
  try {
    const dirs = alertsDirs();
    ensureDir(dirs.pending);
    // Filenames sort chronologically (ISO stamp, separators flattened), which
    // is what the cap and the drain both rely on.
    const stamp = String(at).replace(/[:.]/g, "-");
    const name = `${stamp}-${slugFor(code)}.json`;
    const record = {
      code: String(code || "alert"),
      title: maskSecrets(String(title ?? "Crow alert")),
      body: body == null ? null : maskSecrets(String(body)),
      at: String(at),
    };
    tmp = join(dirs.pending, `.${name}.${process.pid}.tmp`);
    // "wx": create only, never through an existing file or symlink at that name.
    writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: 0o600, flag: "wx" });
    try { chmodSync(tmp, 0o600); } catch {} // umask can only clear bits, but be explicit
    renameSync(tmp, join(dirs.pending, name));
    tmp = null;
    capPending(dirs.pending);
    return join(dirs.pending, name);
  } catch (err) {
    if (tmp) { try { unlinkSync(tmp); } catch {} }
    console.warn(`[alerts] could not spool alert: ${err?.message}`);
    return null;
  }
}

/** Keep the newest SPOOL_MAX pending files, drop the oldest. Never throws. */
function capPending(dir) {
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
    for (const f of files.slice(0, Math.max(0, files.length - SPOOL_MAX))) {
      try { unlinkSync(join(dir, f)); } catch {}
    }
  } catch {}
}

function pruneDelivered(dir) {
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort().reverse();
    for (const f of files.slice(DELIVERED_KEEP)) {
      try { unlinkSync(join(dir, f)); } catch {}
    }
  } catch {}
}

/** rename within one root; a failed move leaves the file for the next boot. */
function moveFile(from, to) {
  try { renameSync(from, to); return true; } catch { return false; }
}

/**
 * Turn every pending alert file into one in-app notification, then move it to
 * `delivered/`. Idempotent: the FILE NAME is the dedupe key (stored in the
 * notification's metadata), so a crash between the insert and the move cannot
 * bell twice on the next boot. Unreadable files go to `bad/` with one log line.
 *
 * @param {object} db
 * @param {{createNotification: Function, log?: Function}} deps
 * @returns {Promise<{delivered:number, duplicates:number, bad:number, failed:number}>}
 */
export async function drainAlertSpool(db, { createNotification, log = (m) => console.log(m) } = {}) {
  const out = { delivered: 0, duplicates: 0, bad: 0, failed: 0 };
  const dirs = alertsDirs();
  pruneDelivered(dirs.delivered);

  let files;
  try { files = readdirSync(dirs.pending).filter((f) => f.endsWith(".json")).sort(); }
  catch { return out; } // no spool on this instance — the common case
  if (!files.length) return out;
  ensureDir(dirs.delivered);
  ensureDir(dirs.bad);

  for (const name of files) {
    const from = join(dirs.pending, name);
    let record;
    try {
      record = JSON.parse(readFileSync(from, "utf8"));
      if (!record || typeof record !== "object" || typeof record.title !== "string" || !record.title.trim()) {
        throw new Error("no title");
      }
    } catch (err) {
      moveFile(from, join(dirs.bad, name));
      out.bad += 1;
      log(`[alerts] unreadable alert file ${name} moved to bad/: ${err?.message}`);
      continue;
    }

    let already = null;
    try {
      already = (await db.execute({
        sql: "SELECT id FROM notifications WHERE json_valid(metadata) AND json_extract(metadata, '$.spool') = ? LIMIT 1",
        args: [name],
      })).rows?.[0];
    } catch (err) {
      log(`[alerts] dedupe check failed for ${name}: ${err?.message}`);
    }
    if (already) {
      moveFile(from, join(dirs.delivered, name));
      out.duplicates += 1;
      continue;
    }

    try {
      const row = await createNotification(db, {
        type: "system",
        priority: "high",
        source: ALERTS_NOTIFICATION_SOURCE,
        title: record.title,
        body: typeof record.body === "string" ? record.body : null,
        action_url: ALERTS_ACTION_URL,
        metadata: { spool: name, code: record.code ?? null },
      });
      // null = the operator switched "system" notifications off (typeEnabled
      // in notifications.js). Consumed anyway: re-trying every boot could
      // never deliver it, and a silenced type is a choice, not a failure.
      moveFile(from, join(dirs.delivered, name));
      if (row) out.delivered += 1;
    } catch (err) {
      // Kept in pending/ on purpose: the row was never written.
      out.failed += 1;
      log(`[alerts] could not deliver alert file ${name} (kept for the next boot): ${err?.message}`);
    }
  }

  pruneDelivered(dirs.delivered);
  // A bad file already logged its own line; the summary is about deliveries.
  if (out.delivered || out.duplicates || out.failed) {
    log(`[alerts] spool drained: ${out.delivered} delivered, ${out.duplicates} already delivered, ${out.bad} unreadable, ${out.failed} deferred`);
  }
  return out;
}