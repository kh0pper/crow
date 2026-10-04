/**
 * Per-instance backup naming, ownership and retention.
 *
 * Why: a host can run several gateways from one checkout (crow: the primary
 * with CROW_HOME unset + r4 with CROW_HOME=~/.crow-r4). Both used to write
 * ~/backups/crow/primary-<date>.db at 02:30, so whichever finished second
 * replaced the other's nightly backup (2026-10-04: r4's 60 MB DB sat under
 * the primary's name; the primary had no surviving API backup).
 *
 * Naming:
 *   host-default instance (CROW_HOME unset or ~/.crow):  <label>-<date>.db   (UNCHANGED)
 *   any other CROW_HOME:                                 <label>-<tag>-<date>.db
 * where <tag> = slug(basename(CROW_HOME)) + "-" + 6 hex of sha256(resolved
 * CROW_HOME), e.g. primary-crow-r4-1a2b3c-2026-10-05.db. The hash keeps two
 * homes with the same basename apart. The own-file regex anchors the date
 * right after the stem, so the default instance's `primary-<date>.db`
 * pattern can never match a tagged file (and vice versa).
 *
 * Ownership: every backup gets a sidecar `<file>.owner.json`
 * ({instance_id, crow_home, db_path, label, tag, written_at}). A backup run
 * refuses to replace a same-name file whose sidecar names another instance;
 * the Nest backup signal and the boot self-check warn when this instance's
 * newest backup is owned by someone else. Files without a sidecar (written
 * before this change) are "unknown", never "foreign".
 *
 * Restore compatibility: the .db files are unchanged plain SQLite copies made
 * by better-sqlite3's online .backup(); restore exactly as before (stop the
 * gateway, copy the .db over crow.db, remove stale crow.db-wal/-shm, start).
 * The sidecar is metadata only — ignore it on restore. Tagged names only
 * appear on co-hosted (non-default CROW_HOME) instances.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { isDefaultCrowHome, resolveCrowHome, readLocalInstanceIdOrNull } from "./crow-home.js";
import { resolveDataDir } from "../db.js";

export const OWNER_SUFFIX = ".owner.json";
const DATE_RE = "\\d{4}-\\d{2}-\\d{2}";

/** Backup directory: CROW_BACKUP_DIR → ~/backups/crow. */
export function resolveBackupDir(env = process.env) {
  return env.CROW_BACKUP_DIR || join(homedir(), "backups", "crow");
}

/** Instance tag for the filename, or null for the host-default instance. */
export function instanceBackupTag(env = process.env) {
  if (isDefaultCrowHome(env)) return null;
  const home = resolve(resolveCrowHome(env));
  const slug = basename(home).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "home";
  const hash = createHash("sha256").update(home).digest("hex").slice(0, 6);
  return `${slug}-${hash}`;
}

export function backupStem(label, tag) {
  return tag ? `${label}-${tag}` : label;
}

export function backupFileName(label, tag, date) {
  return `${backupStem(label, tag)}-${date}.db`;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Matches exactly this instance's backup files; group 1 = date. */
export function ownBackupRegex(label, tag) {
  return new RegExp(`^${escapeRe(backupStem(label, tag))}-(${DATE_RE})\\.db$`);
}

/**
 * This instance's backup files in `dir`, newest mtime first.
 * @returns {{name:string, path:string, mtimeMs:number, size:number}[]}
 */
export function listOwnBackups(dir, label, tag) {
  const re = ownBackupRegex(label, tag);
  const out = [];
  let names = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    if (!re.test(name)) continue;
    const full = join(dir, name);
    try {
      const st = statSync(full);
      if (st.isFile()) out.push({ name, path: full, mtimeMs: st.mtimeMs, size: st.size });
    } catch {}
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

export function ownerPath(dbFile) {
  return dbFile + OWNER_SUFFIX;
}

/** The sidecar owner record of a backup file, or null when absent/unreadable. */
export function readOwner(dbFile) {
  try {
    const p = ownerPath(dbFile);
    if (!existsSync(p)) return null;
    const rec = JSON.parse(readFileSync(p, "utf8"));
    return rec && typeof rec === "object" ? rec : null;
  } catch {
    return null;
  }
}

/**
 * This instance's ownership record.
 * @param {{instanceId?:string|null, dbPath?:string|null, label:string, tag:string|null}} o
 */
export function ownerRecord({ instanceId = null, dbPath = null, label, tag }, env = process.env) {
  return {
    instance_id: instanceId || null,
    crow_home: resolve(resolveCrowHome(env)),
    db_path: dbPath ? resolve(dbPath) : null,
    label,
    tag: tag || null,
    written_at: new Date().toISOString(),
  };
}

/**
 * True only when `owner` provably belongs to a DIFFERENT instance than `me`:
 * the instance ids, the source DB paths or the CROW_HOMEs differ. Missing fields on
 * either side never count as a mismatch (a legacy sidecar-less file is
 * "unknown", not "foreign").
 */
export function isForeignOwner(owner, me) {
  if (!owner || !me) return false;
  if (owner.instance_id && me.instance_id && owner.instance_id !== me.instance_id) return true;
  if (owner.db_path && me.db_path && resolve(owner.db_path) !== resolve(me.db_path)) return true;
  if (owner.crow_home && me.crow_home && resolve(owner.crow_home) !== resolve(me.crow_home)) return true;
  return false;
}

/**
 * Ownership of this instance's newest backup.
 * @returns {{status:"none"|"ok"|"unknown"|"foreign", newest:object|null, owner:object|null}}
 */
export function newestBackupOwnership(dir, label, tag, me) {
  const [newest] = listOwnBackups(dir, label, tag);
  if (!newest) return { status: "none", newest: null, owner: null };
  const owner = readOwner(newest.path);
  if (!owner) return { status: "unknown", newest, owner: null };
  return { status: isForeignOwner(owner, me) ? "foreign" : "ok", newest, owner };
}

/**
 * The backup label. NTFY_TOPIC is used verbatim; an operator whose topics
 * share a personal prefix (e.g. "myname-mpa") can set CROW_NTFY_LABEL_PREFIX
 * =myname to have it stripped. Otherwise derived from CROW_DB_PATH, else
 * "primary".
 */
export function backupLabel(env = process.env) {
  const topic = (env.NTFY_TOPIC || "").toLowerCase();
  if (topic) {
    const prefix = (env.CROW_NTFY_LABEL_PREFIX || "").toLowerCase();
    if (prefix && topic.startsWith(prefix + "-") && topic.length > prefix.length + 1) {
      return topic.slice(prefix.length + 1);
    }
    return topic;
  }
  const dbPath = (env.CROW_DB_PATH || "").toLowerCase();
  if (dbPath.includes("crow-mpa")) return "mpa";
  if (dbPath.includes("home-finance")) return "finance";
  return "primary";
}

/**
 * Everything a backup run / check needs about THIS instance.
 * @returns {{dir:string, label:string, tag:string|null, me:object}}
 */
export function localBackupContext(env = process.env) {
  const label = backupLabel(env);
  const tag = instanceBackupTag(env);
  const dbPath = env.CROW_DB_PATH || join(resolveDataDir(), "crow.db");
  const me = ownerRecord({ instanceId: readLocalInstanceIdOrNull(env), dbPath, label, tag }, env);
  return { dir: resolveBackupDir(env), label, tag, me };
}
