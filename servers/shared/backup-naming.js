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
 * The identity copy (security audit N1c-10): `npm run backup` also copies this
 * instance's identity.json into the SAME local backup directory, as
 * `<stem>-identity-<date>.json` — 0600, owner sidecar, pruned by the same
 * per-instance rule. It is LOCAL ONLY by ruling: the S3 and git steps carry an
 * explicit allow-list (this run's .db and .sql) and refuse anything whose name
 * says identity or whose path is under secrets/. Identity's off-machine story
 * is the passphrase-protected Export, never the nightly backup.
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
import { basename, dirname, join, resolve } from "node:path";
import { isDefaultCrowHome, resolveCrowHome, resolveInstanceDataDir, readLocalInstanceIdOrNull } from "./crow-home.js";
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

/**
 * This run's LOCAL-ONLY identity copy: `<stem>-identity-<date>.json`, the same
 * stem and date as the run's .db (security audit N1c-10). The word "identity"
 * in the name is what the S3 and git steps' allow-list guards key on, and it
 * can never collide with a .db/.sql name (ownBackupRegex anchors the date right
 * after the stem).
 */
export function identityBackupFileName(label, tag, date) {
  return `${backupStem(label, tag)}-identity-${date}.json`;
}

/** Matches exactly this instance's identity copies; group 1 = date. */
export function ownIdentityRegex(label, tag) {
  return new RegExp(`^${escapeRe(backupStem(label, tag))}-identity-(${DATE_RE})\\.json$`);
}

/**
 * The identity copy that belongs to a nightly backup file: `<stem>-<date>.db`
 * (or `.sql`) → `<dir>/<stem>-identity-<date>.json`. null when `backupFile` is
 * not one of this product's nightly names (a hand-made backup, say) — the
 * caller then simply has no identity copy to restore.
 * @returns {{path:string, stem:string, date:string}|null}
 */
export function identityCopyForBackup(backupFile) {
  const m = new RegExp(`^(.*)-(${DATE_RE})\\.(?:db|sql)$`).exec(basename(backupFile));
  if (!m) return null;
  return { path: join(dirname(backupFile), `${m[1]}-identity-${m[2]}.json`), stem: m[1], date: m[2] };
}

/**
 * This instance's identity.json — the file servers/sharing/identity.js reads.
 *
 * identity.js pins its data dir once at import (CROW_DATA_DIR → a non-default
 * CROW_HOME's data dir → ~/.crow/data → ./data). Callers here must resolve it
 * from an ENVIRONMENT they were given, so:
 *
 *   1. CROW_DATA_DIR wins — that is the dir identity.js would read.
 *   2. Otherwise `dbPath`'s own directory, when the caller has the database in
 *      hand (the scripts do): identity.json sits beside crow.db in every
 *      instance layout, including a co-hosted one, where identity.js's rule is
 *      dirname(CROW_DB_PATH) too.
 *   3. Otherwise resolveInstanceDataDir(env) — identity.js's own rule, for a
 *      caller (a boot module) that has only the environment.
 * @param {{dbPath?:string|null, env?:NodeJS.ProcessEnv}} [opts]
 */
export function identityFilePath({ dbPath = null, env = process.env } = {}) {
  if (env.CROW_DATA_DIR) return join(resolve(env.CROW_DATA_DIR), "identity.json");
  if (dbPath) return join(dirname(resolve(dbPath)), "identity.json");
  return join(resolveInstanceDataDir(env), "identity.json");
}

/**
 * Directory name of THIS instance's artifacts blob copy inside the backup dir.
 * The host-default instance keeps the historical `artifacts`; an instance with
 * its own CROW_HOME gets `artifacts-<stem>`, so two co-hosted instances rsync
 * (`--delete`) into separate subdirectories instead of pruning each other's
 * blobs.
 */
export function artifactStoreName(label, tag) {
  return tag ? `artifacts-${backupStem(label, tag)}` : "artifacts";
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
 * the CROW_HOMEs differ (else the DB paths, else the instance ids). Missing fields on
 * either side never count as a mismatch (a legacy sidecar-less file is
 * "unknown", not "foreign").
 */
export function isForeignOwner(owner, me) {
  if (!owner || !me) return false;
  // CROW_HOME is what the file NAME encodes, so it is the primary key: same
  // home = own file even if the instance-id file was regenerated or the DB
  // moved. Only when either side lacks it do the weaker keys decide.
  if (owner.crow_home && me.crow_home) {
    if (resolve(owner.crow_home) !== resolve(me.crow_home)) return true;
    // Same home but two different DBs (two gateways sharing ~/.crow under one
    // label): still another instance's data.
    return !!(owner.db_path && me.db_path && resolve(owner.db_path) !== resolve(me.db_path));
  }
  if (owner.db_path && me.db_path) return resolve(owner.db_path) !== resolve(me.db_path);
  if (owner.instance_id && me.instance_id) return owner.instance_id !== me.instance_id;
  return false;
}

/**
 * True when the sidecar's recorded size/mtime no longer match the file — the
 * file was rewritten in place by something that did not update the sidecar
 * (e.g. a co-hosted gateway still on pre-sidecar code). Sidecars without a
 * fingerprint never count as stale.
 */
export function sidecarStale(owner, file) {
  if (!owner || owner.size_bytes == null || owner.mtime_ms == null) return false;
  return owner.size_bytes !== file.size || Math.abs(owner.mtime_ms - file.mtimeMs) > 1;
}

/**
 * Ownership of this instance's newest backup. "mismatch" = the sidecar is ours
 * but the file was rewritten after it (size/mtime differ) — its content can no
 * longer be attributed, so it is treated like "foreign".
 * @returns {{status:"none"|"ok"|"unknown"|"foreign"|"mismatch", newest:object|null, owner:object|null}}
 */
export function newestBackupOwnership(dir, label, tag, me) {
  const [newest] = listOwnBackups(dir, label, tag);
  if (!newest) return { status: "none", newest: null, owner: null };
  const owner = readOwner(newest.path);
  if (!owner) return { status: "unknown", newest, owner: null };
  if (isForeignOwner(owner, me)) return { status: "foreign", newest, owner };
  if (sidecarStale(owner, newest)) return { status: "mismatch", newest, owner };
  return { status: "ok", newest, owner };
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
