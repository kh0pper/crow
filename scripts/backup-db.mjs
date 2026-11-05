#!/usr/bin/env node
/**
 * The binary copy behind `npm run backup` (scripts/backup.sh).
 *
 * Why this exists (N1c-9): backup.sh used to run `sqlite3 <live crow.db>
 * ".dump"` and `sqlite3 <live crow.db> ".backup '<dest>'"`. An external open
 * of a live WAL-mode crow.db is the one thing that must never happen: on the
 * last-close SQLite unlinks crow.db-wal/-shm, which orphans the file
 * descriptors the gateway is still holding (the keeper handles in
 * servers/db.js exist for exactly that failure, and `sqlite3` also never sees
 * the gateway's un-checkpointed pages). So:
 *
 *   1. If a gateway answers on 127.0.0.1:<gatewayListenPort()> it is asked
 *      for the copy (POST /api/admin/backup, servers/gateway/routes/
 *      admin-backup.js). That copy is made in-process by better-sqlite3's
 *      online .backup(), is verified there, and lands under the name the
 *      dashboard, the Nest backup signal and pruneOwnBackups already know
 *      (servers/shared/backup-naming.js: <label>[-<tag>]-<date>.db plus its
 *      .owner.json sidecar). Its answer is only used when it names OUR
 *      database (db_path) and a copy inside OUR backup dir: on a host running
 *      two gateways, the port may well belong to the other instance. This
 *      script never opens the live database on this path. An answer that names
 *      NO database (db_path absent) is an older Crow: it cannot be attributed,
 *      so the run stops and says to update Crow or stop that gateway — never a
 *      silent fall-through to a local copy.
 *   2. Otherwise the deciding question is who has the DATABASE open, not which
 *      port answers (dbHolders() in scripts/restore-db.mjs — /proc/<pid>/fd,
 *      else lsof). With no holders, open the database READ-ONLY and run
 *      .backup() into a temp file in the backup dir, verify it (quick_check,
 *      then wal_checkpoint(TRUNCATE) so the copy is one self-contained file),
 *      and rename it into place under the SAME name — with the same owner
 *      sidecar — the endpoint writes. With holders and no gateway of ours, or
 *      when the holders cannot be determined, refuse: an external open of a
 *      live WAL crow.db is what orphans the gateway's descriptors. "Cannot be
 *      determined" includes processes whose fd directory we may not read (a
 *      non-root run, other users' processes): their count is in the refusal,
 *      and with a gateway that answered about ANOTHER database it refuses
 *      rather than fall back to a local copy.
 *   2b. A port that answers but does not answer like a gateway (5xx, reset,
 *      garbage, timeout) also refuses: something there may well be holding the
 *      database.
 *   3. The SQL dump is made from the VERIFIED COPY (never the live DB) and
 *      only when the sqlite3 CLI is installed. Without it the dump is
 *      skipped with one line: the binary copy is complete on its own.
 *   4. This instance's identity.json is copied into the SAME local backup
 *      directory as `<stem>-identity-<date>.json` (0600, owner sidecar,
 *      pruned with the rest) — and NOWHERE else. Security audit N1c-10, the
 *      operator's ruling (2026-11-05): identity stays on this machine; a copy
 *      owner can take anywhere is the passphrase-protected Export
 *      (buildIdentityBackup), and everything under <CROW_HOME>/secrets is
 *      never copied at all. backup.sh's S3 and git steps have an explicit
 *      allow-list (this run's .db and .sql) plus a guard that refuses exactly
 *      what must not leave — this instance's identity copy name, any
 *      identity.json, and anything under <CROW_HOME>/secrets
 *      (uploadRefusalReason in servers/shared/backup-naming.js, asked through
 *      `--may-leave` below).
 *
 * Modes (backup.sh calls these; nothing else should need them):
 *   --report <file> --db <path>            make the copy (+ dump + identity), report what landed
 *   --names --report <file> --db <path>    dry run: report the names only, write nothing
 *   --backup-dir                           print resolveBackupDir() and exit
 *   --naming                               print stem, tag and artifacts dir name
 *   --may-leave <file>                     may this file be uploaded/committed? exit 0 yes, 3 no (+ why)
 *   --prune [--dry-run] [--db <path>]      per-instance retention for .db, .sql and the identity copies
 *
 * The report file is a shell-sourceable list (DB_FILE=..., SQL_FILE=...,
 * SOURCE=..., plus IDENTITY_FILE in a dry run). backup.sh copies it for its
 * S3/git steps, which allow-list DB_FILE and SQL_FILE only: IDENTITY_FILE is
 * there for the dry-run line and no upload step may read it.
 *
 * Mode bits (N1c-12): every file here is 0600, written that way from creation.
 * A directory this script CREATES is 0700; an existing backup directory is
 * never clamped (it may be shared) — it is warned about once instead, because
 * `chmod` on a filesystem without modes must not abort a backup.
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { gatewayListenPort } from "../servers/gateway/listen-port.js";
import { dbHolders, holdersText } from "./restore-db.mjs";
import {
  localBackupContext, backupFileName, backupStem, artifactStoreName, ownerPath, readOwner,
  isForeignOwner, resolveBackupDir, identityBackupFileName, identityFilePath, ownIdentityRegex,
  uploadRefusalReason,
} from "../servers/shared/backup-naming.js";

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const DATE_RE = "\\d{4}-\\d{2}-\\d{2}";

/* ------------------------------------------------------------ small utils */

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function chmodQuiet(p, mode) {
  try { fs.chmodSync(p, mode); } catch { /* not ours / gone */ }
}

function unlinkQuiet(p) {
  try { fs.unlinkSync(p); } catch { /* already gone */ }
}

function removeWithJournals(p) {
  unlinkQuiet(p);
  for (const suffix of ["-wal", "-shm"]) unlinkQuiet(p + suffix);
}

/** Create `dir` 0700 when it is missing; never clamp a directory that already
 * exists (it may be shared with other software) — warn once instead. A
 * filesystem without modes must never abort a backup. */
function ensurePrivateDir(dir) {
  if (fs.existsSync(dir)) { warnIfShared(dir); return; }
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  chmodQuiet(dir, DIR_MODE);
}

/** One warning naming a directory that group/others may read. Never a chmod. */
function warnIfShared(dir) {
  let mode = null;
  try { mode = fs.statSync(dir).mode & 0o777; } catch { return; }
  if (!mode || !(mode & 0o077)) return;
  console.warn(
    `  Warning: ${dir} is mode 0${mode.toString(8)} (group- or world-accessible), so the backups in it may be ` +
    `readable by others. chmod 700 it if only Crow uses it.`,
  );
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return "?";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function utcDate(now = new Date()) {
  return now.toISOString().split("T")[0];
}

function tmpBeside(dir, name) {
  return path.join(dir, `.${name}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

function writeReport(file, vars) {
  const body = Object.entries(vars).map(([k, v]) => `${k}=${shellQuote(v ?? "")}`).join("\n") + "\n";
  fs.writeFileSync(file, body, { mode: FILE_MODE });
  chmodQuiet(file, FILE_MODE);
}

/* ------------------------------------------------------- the gateway probe */

/** True when `err` (or its cause chain / aggregate members) is ECONNREFUSED. */
function isConnectionRefused(err) {
  const seen = new Set();
  let e = err;
  while (e && typeof e === "object" && !seen.has(e)) {
    seen.add(e);
    if (e.code === "ECONNREFUSED") return true;
    if (Array.isArray(e.errors) && e.errors.some((x) => x && x.code === "ECONNREFUSED")) return true;
    e = e.cause;
  }
  return false;
}

/**
 * Ask the gateway's /health on loopback.
 *
 *   up   = something is listening on the port. ONLY a refused connection
 *          counts as "nothing there": a reset, a timeout, a 5xx or a body that
 *          is not an HTTP answer all mean a process we know nothing about may
 *          be holding the live database, so backup and restore must refuse
 *          rather than open it themselves.
 *   ok   = it answered 2xx, so it is a gateway and may be asked for a backup.
 *   status/error carry the reason for the refusal sentence.
 */
/**
 * Whether a user other than this one could be holding the database the way a
 * gateway does (writing it): true when the file (or its -wal/-shm) belongs to
 * someone else or lets its group or others write it. A crow.db is normally
 * 0644 and the owner's, so other users can at most read it, which is not the
 * live-WAL hazard a local copy must avoid. A stat failure counts as "could".
 * @param {string} dbPath
 * @returns {boolean}
 */
function othersCanOpen(dbPath) {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const real = realpathOrResolve(dbPath);
  for (const file of [real, `${real}-wal`, `${real}-shm`]) {
    let st;
    try {
      st = fs.statSync(file);
    } catch (err) {
      if (err && err.code === "ENOENT" && file !== real) continue;
      return true;
    }
    if (uid !== null && st.uid !== uid) return true;
    if ((st.mode & 0o022) !== 0) return true;
  }
  return false;
}

export async function probeGateway(port, timeoutMs = 2000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctrl.signal });
    try { await res.arrayBuffer(); } catch { /* body is not needed */ }
    return { up: true, ok: res.ok, timedOut: false, status: res.status, refused: false };
  } catch (err) {
    if (ctrl.signal.aborted) return { up: true, ok: false, timedOut: true, refused: false };
    if (isConnectionRefused(err)) {
      return { up: false, ok: false, timedOut: false, refused: true };
    }
    // Reset/EPIPE/garbage answer: something is there, we just cannot talk to it.
    return { up: true, ok: false, timedOut: false, refused: false, error: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The sentence both scripts use when a port answers but not like a gateway
 * (5xx, reset, garbage, timeout). Exported so restore-db.mjs says the same.
 */
export function listeningRefusal(port, probe) {
  const why = probe.timedOut
    ? "GET /health did not answer within 2 s"
    : probe.status
      ? `GET /health answered HTTP ${probe.status}`
      : `GET /health failed (${probe.error || "no usable answer"})`;
  return `something is listening on port ${port} but ${why} — refusing to open the database directly in case that is the gateway`;
}

/* ---------------------------------------------------- paths, ours or theirs */

function realpathOrResolve(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

/** True when `file` (already real) is strictly inside directory `dir` (real). */
function isInsideDir(file, dir) {
  const rel = path.relative(dir, file);
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
}

/* ------------------------------------------------------------ verification */

/**
 * Verify a freshly-written COPY (never the live DB) and fold its WAL into the
 * main file, so the file we rename into place is one self-contained database.
 * Same semantics as admin-backup.js's verifyBackupFile.
 */
function verifyCopy(file) {
  let handle = null;
  try {
    handle = new Database(file, { fileMustExist: true });
    const rows = handle.pragma("quick_check");
    const result = Array.isArray(rows) ? String(rows[0]?.quick_check ?? rows[0]) : String(rows);
    if (result === "ok") {
      try { handle.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* fold best-effort */ }
    }
    return { ok: result === "ok", result };
  } catch (err) {
    return { ok: false, result: err.message };
  } finally {
    try { handle?.close(); } catch { /* already closed */ }
  }
}

/* --------------------------------------------------------------- sidecars */

/** The owner sidecar admin-backup.js writes — same shape, same name, 0600. */
function writeSidecar(file, me) {
  const st = fs.statSync(file);
  const rec = { ...me, written_at: new Date().toISOString(), size_bytes: st.size, mtime_ms: st.mtimeMs };
  // Dot-prefixed + ".tmp-" keeps it out of every *.db scan and inside
  // pruneOwnBackups' leftover-temp sweep if this process dies mid-write.
  const sidecarTmp = tmpBeside(path.dirname(file), path.basename(file)) + ".owner";
  try {
    fs.writeFileSync(sidecarTmp, JSON.stringify(rec, null, 2) + "\n", { mode: FILE_MODE });
    chmodQuiet(sidecarTmp, FILE_MODE);
    fs.renameSync(sidecarTmp, ownerPath(file));
    chmodQuiet(ownerPath(file), FILE_MODE);
  } catch (err) {
    unlinkQuiet(sidecarTmp);
    console.warn(`  Warning: could not write the owner sidecar (${err.message}).`);
  }
}

/** Refuse to replace a same-day file that belongs to another instance. */
function assertNotForeign(dest, me) {
  if (!fs.existsSync(dest)) return;
  const owner = readOwner(dest);
  if (owner && isForeignOwner(owner, me)) {
    const who = owner.crow_home || owner.instance_id || "another instance";
    const err = new Error(`refusing to overwrite ${dest}: it belongs to a different instance (${who})`);
    err.code = "BACKUP_FOREIGN";
    throw err;
  }
}

/* ---------------------------------------------------------- the two copies */

/**
 * Ask the gateway on `port` for a copy, and only accept it when it is OUR
 * copy: `db_path` must be the realpath of our database and the returned `path`
 * must be inside our backup dir. Otherwise `{foreign:true, reason}` is
 * returned — the caller then decides by dbHolders() instead.
 *
 * A reply with no `db_path` is not "foreign", it is unusable: an older gateway
 * cannot say which database it copied, so `{refuse:true, reason}` tells the
 * operator to either update Crow or stop the gateway and run the backup again.
 */
async function gatewayCopy(port, { dbReal, dirReal }) {
  const token = process.env.CROW_BACKUP_TOKEN || "";
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}/api/admin/backup`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(10 * 60_000),
    });
  } catch (err) {
    throw new Error(`could not reach the gateway on port ${port}: ${err.message}`);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.ok !== true) {
    throw new Error(`the gateway refused the backup: ${body?.error || `HTTP ${res.status}`}`);
  }

  // A co-hosted gateway (another CROW_HOME, another crow.db) answers /health
  // on its port too. Its copy is of ITS database, so taking it would either
  // back up the wrong instance or file it under the wrong name.
  //
  // An answer that names no database at all is an older Crow: its copy cannot
  // be attributed, and the port is in use by a process holding some crow.db, so
  // stop here with advice instead of guessing (or opening our own file while a
  // gateway we cannot identify is running).
  if (typeof body.db_path !== "string") {
    return {
      refuse: true,
      reason: `the gateway on port ${port} is older than this backup script and did not say which database it ` +
        `backed up; update Crow, or stop the gateway and run the backup again`,
    };
  }
  const answerDb = realpathOrResolve(body.db_path);
  const answerPath = typeof body.path === "string" ? body.path : null;
  const answerReal = answerPath ? realpathOrResolve(answerPath) : null;
  const ours = answerReal !== null && answerDb === dbReal && isInsideDir(answerReal, dirReal);
  if (!ours) {
    const outside = answerReal && !isInsideDir(answerReal, dirReal) ? `, and its copy ${answerReal} is outside ${dirReal}` : "";
    return { foreign: true, reason: `the gateway on port ${port} backs up another database (it backed up ${answerDb})${outside} — ignoring it` };
  }
  if (!fs.existsSync(answerPath)) {
    throw new Error(`the gateway reported a copy at ${answerPath}, but no such file exists`);
  }
  const size = fs.statSync(answerPath).size;
  if (size === 0) throw new Error(`the gateway wrote an empty copy at ${answerPath}`);
  return { file: answerPath, size, pages: body.pages_copied ?? null, instance: body.instance ?? null };
}

async function localCopy(dbPath, dir, name, me) {
  const dest = path.join(dir, name);
  const tmp = tmpBeside(dir, name);
  try {
    // Written 0600 FROM CREATION (not chmod'ed afterwards): a crow.db copy holds
    // everything Crow knows, and a mode-less filesystem must not abort here.
    fs.closeSync(fs.openSync(tmp, "wx", FILE_MODE));
    // Nobody holds the DB (dbHolders() said so), so a direct better-sqlite3
    // connection and its online .backup() are safe here — read-only, because
    // the live database is still not ours to write to.
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      await db.backup(tmp);
    } finally {
      try { db.close(); } catch { /* already closed */ }
    }
    chmodQuiet(tmp, FILE_MODE);
    const size = fs.statSync(tmp).size;
    if (!size) throw new Error("the copy came out empty");
    const verify = verifyCopy(tmp);
    if (!verify.ok) throw new Error(`verification failed: ${verify.result}`);
    for (const suffix of ["-wal", "-shm"]) unlinkQuiet(tmp + suffix);
    assertNotForeign(dest, me);
    // A -wal/-shm left beside the OLD file must not be replayed onto the new one.
    for (const suffix of ["-wal", "-shm"]) unlinkQuiet(dest + suffix);
    fs.renameSync(tmp, dest);
    chmodQuiet(dest, FILE_MODE);
    writeSidecar(dest, me);
    return { file: dest, size, pages: null };
  } catch (err) {
    removeWithJournals(tmp);
    throw err;
  }
}

/* ------------------------------------------------------- the identity copy */

/**
 * Copy this instance's identity.json into the backup dir, 0600, with the same
 * owner sidecar as the database copy.
 *
 * Security audit N1c-10, the operator's ruling: the identity stays on THIS
 * machine (restore.sh --with-identity puts it back on the same hardware), so
 * the copy lives only in the local backup folder — never in S3, never in the
 * git repo (backup.sh's steps allow-list this run's .db and .sql and ask
 * uploadRefusalReason() about every other name). Nothing under
 * <CROW_HOME>/secrets is touched: the keychain key never leaves the machine,
 * and the Keychain's own passphrase Export is how those entries travel.
 *
 * A same-day copy whose sidecar names ANOTHER instance is left alone (a
 * warning, not a refusal: the database copy is already written and sound, and
 * another instance's identity is never ours to overwrite).
 * @returns {{path:string, size:number}|null}
 */
function copyIdentity({ dbPath, dir, ctx, date, me }) {
  // identity.js's file, anchored on the database this run actually copied (see
  // identityFilePath: CROW_DATA_DIR, else crow.db's own directory).
  const source = identityFilePath({ dbPath });
  if (!fs.existsSync(source)) {
    console.log("  no identity.json yet (nothing to keep)");
    return null;
  }
  const dest = path.join(dir, identityBackupFileName(ctx.label, ctx.tag, date));
  const existing = fs.existsSync(dest) ? readOwner(dest) : null;
  if (existing && isForeignOwner(existing, me)) {
    const who = existing.crow_home || existing.instance_id || "another instance";
    console.warn(`  Warning: ${dest} belongs to a different instance (${who}); leaving it alone.`);
    return null;
  }
  const tmp = tmpBeside(dir, path.basename(dest)) + ".json";
  try {
    // 0600 FROM CREATION (open 'wx' + mode, never a copyFileSync + chmod): the
    // file holds the master seed, so it must not be readable by anyone else
    // even for the instant between writing and renaming it into place.
    const bytes = fs.readFileSync(source);
    const fd = fs.openSync(tmp, "wx", FILE_MODE);
    try { fs.writeSync(fd, bytes); } finally { fs.closeSync(fd); }
    chmodQuiet(tmp, FILE_MODE);
    fs.renameSync(tmp, dest);
    chmodQuiet(dest, FILE_MODE);
    writeSidecar(dest, me);
    const size = fs.statSync(dest).size;
    console.log(`  Identity copy (this machine only): ${dest} (${fmtBytes(size)})`);
    return { path: dest, size };
  } catch (err) {
    unlinkQuiet(tmp);
    console.warn(`  Warning: could not copy the identity (${err.message}); the database copy is complete.`);
    return null;
  }
}

/* ------------------------------------------------------------- SQL dumping */

function sqlite3Available() {
  const r = spawnSync("sqlite3", ["--version"], { stdio: "ignore" });
  return !r.error && r.status === 0;
}

/**
 * Dump the verified COPY with the sqlite3 CLI (never the live DB). The CLI is
 * an external process, so the copy is checkpointed and no writer is attached
 * to it: it opens a standalone file that nothing else has mapped.
 */
function dumpSql(copyPath, sqlDest) {
  const dir = path.dirname(copyPath);
  // Named off the copy so a killed run's half-written dump is swept by the
  // same leftover-temp sweep as the copy itself.
  const tmp = tmpBeside(dir, path.basename(copyPath)) + ".sql";
  let fd = null;
  try {
    fd = fs.openSync(tmp, "w", FILE_MODE);
    const r = spawnSync("sqlite3", [copyPath, ".dump"], { stdio: ["ignore", fd, "pipe"] });
    fs.closeSync(fd);
    fd = null;
    if (r.error) throw r.error;
    if (r.status !== 0) {
      const why = (r.stderr || "").toString().trim().split("\n")[0] || `sqlite3 exited ${r.status}`;
      throw new Error(why);
    }
    chmodQuiet(tmp, FILE_MODE);
    fs.renameSync(tmp, sqlDest);
    chmodQuiet(sqlDest, FILE_MODE);
    return { ok: true, size: fs.statSync(sqlDest).size };
  } catch (err) {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* closed */ } }
    unlinkQuiet(tmp);
    return { ok: false, result: err.message };
  } finally {
    // The CLI opened the copy read-write; drop any journal it left behind.
    if (copyPath !== sqlDest && fs.existsSync(copyPath)) {
      for (const suffix of ["-wal", "-shm"]) unlinkQuiet(copyPath + suffix);
    }
  }
}

/* -------------------------------------------------------------- make mode */

async function make({ dbPath, reportFile, dryRun }) {
  const ctx = localBackupContext(process.env);
  const dir = ctx.dir;
  // The owner sidecar names the database this run actually copied: `--db`
  // wins, so a script pointed at another crow.db does not record the default.
  const me = { ...ctx.me, db_path: path.resolve(dbPath) };
  const date = utcDate();
  const name = backupFileName(ctx.label, ctx.tag, date);
  const planned = path.join(dir, name);
  // The identity copy this run WOULD keep, local only. It is in the report for
  // the dry-run line backup.sh prints; no upload step may read it (see the
  // allow-list guards in backup.sh).
  const plannedIdentity = path.join(dir, identityBackupFileName(ctx.label, ctx.tag, date));

  if (dryRun) {
    const vars = {
      DB_FILE: planned,
      SQL_FILE: planned.replace(/\.db$/, ".sql"),
      SOURCE: "names",
    };
    // Only when there IS one to copy: a dry run must not promise a file the
    // real run would report as "no identity.json yet".
    if (fs.existsSync(identityFilePath({ dbPath }))) vars.IDENTITY_FILE = plannedIdentity;
    writeReport(reportFile, vars);
    return 0;
  }

  ensurePrivateDir(dir);

  const port = gatewayListenPort();
  const dbName = path.basename(dbPath);
  const probe = await probeGateway(port);
  const dbReal = realpathOrResolve(dbPath);
  const dirReal = realpathOrResolve(dir);

  let copy = null;
  let source = null;
  // The reason a gateway that DID answer was not usable (it backs up another
  // instance's database). Kept for the refusal below: with an answering gateway
  // on the port, a local copy is the one thing that must not happen silently.
  let gatewayReason = null;

  if (probe.up && !probe.ok) {
    // A port that answers but not like a gateway is a port that may well hold
    // the live database: refuse instead of opening the file ourselves.
    throw new Error(listeningRefusal(port, probe));
  }

  if (probe.ok) {
    console.log(`  Gateway answering on 127.0.0.1:${port} — asking it for the copy (the live database is not opened here).`);
    const answer = await gatewayCopy(port, { dbReal, dirReal });
    if (answer.refuse) throw new Error(answer.reason);
    if (answer.foreign) {
      gatewayReason = answer.reason;
      console.log(`  ${answer.reason}.`);
    } else {
      source = "gateway";
      copy = answer;
    }
  }

  if (!copy) {
    // Nobody to ask, or the one we asked was not ours: the file handles decide.
    const scan = dbHolders(dbPath);
    if (scan === null) {
      throw new Error(
        `could not check whether another process holds ${dbPath} (no /proc/<pid>/fd and no lsof ` +
        `on this host) — refusing to open it directly in case something does`,
      );
    }
    const holders = scan.holders;
    // Processes whose open files we could not see (another user's). For a
    // normal user that is every root and system process, so it matters only
    // when another user could write this database: a file owned by someone
    // else, or one its group or others may write. Then
    // "nobody holds it" is not a fact this host can give, and it is never used
    // to justify opening the live database while a gateway answers.
    const blind = scan.unreadable > 0
      ? `could not see the open files of ${scan.unreadable} process${scan.unreadable === 1 ? "" : "es"} owned by other users`
      : null;
    if (holders.length) {
      const who = holdersText(holders);
      const base = probe.ok
        ? `${dbName} is open by: ${who} but no gateway for it answers on port ${port}; ` +
          `set PORT/CROW_GATEWAY_PORT to its port, or stop those processes.`
        : `${dbName} is open by: ${who}. Stop the gateway and any Crow server using this ` +
          `database, then run the backup again (or set PORT/CROW_GATEWAY_PORT to the port of ` +
          `the gateway that serves it).`;
      throw new Error(blind ? `${base} Also, ${blind}.` : base);
    }
    if (blind && probe.ok && othersCanOpen(dbPath)) {
      // A gateway answered, but not about OUR database: whatever is behind that
      // port may be the process holding our file, and the handles cannot rule it
      // out. Never fall through to a local copy on that evidence.
      throw new Error(
        `${blind}, and ${gatewayReason} — refusing to copy ${dbPath} here in case one of those ` +
        `processes is holding it. Stop that gateway, or set PORT/CROW_GATEWAY_PORT to the port of the ` +
        `gateway that serves this database, then run the backup again.`,
      );
    }
    source = "local";
    if (probe.refused) {
      console.log(`  No gateway on 127.0.0.1:${port} and nothing holds the database — making the copy here with better-sqlite3.`);
    } else {
      console.log(`  ${dbName} is not held by any other process — making the copy here with better-sqlite3.`);
    }
    copy = await localCopy(dbPath, dir, name, me);
  }

  console.log(`  Binary copy: ${copy.file} (${fmtBytes(copy.size)}${copy.pages ? `, ${copy.pages} pages` : ""})`);

  // The SQL dump comes from the verified copy, never from the live database.
  const sqlDest = copy.file.replace(/\.db$/, ".sql");
  let sqlFile = "";
  if (!sqlite3Available()) {
    console.log("  sqlite3 not installed: no SQL dump; the binary copy is complete");
  } else {
    console.log("  Creating SQL dump from the verified copy...");
    const dump = dumpSql(copy.file, sqlDest);
    if (dump.ok) {
      sqlFile = sqlDest;
      console.log(`  SQL dump: ${sqlDest} (${fmtBytes(dump.size)})`);
    } else {
      console.log(`  Warning: SQL dump failed (${dump.result}); the binary copy is complete.`);
    }
  }

  writeReport(reportFile, { DB_FILE: copy.file, DB_SIZE: String(copy.size), SQL_FILE: sqlFile, SOURCE: source });

  // Local only (N1c-10): never in the report, so no upload step can pick it up.
  copyIdentity({ dbPath, dir, ctx, date, me });

  return 0;
}

/* ------------------------------------------------------------- prune mode */

/**
 * Per-instance retention. The .db half is the endpoint's own pruneOwnBackups
 * (same name pattern, same foreign-owner guard), so a script-pruned dir looks
 * exactly like an endpoint-pruned one; the .sql half removes this instance's
 * dumps older than CROW_BACKUP_KEEP_DAYS, and the identity half its
 * `<stem>-identity-<date>.json` copies by the same rule.
 */
async function prune({ dryRun, dbPath }) {
  const keepDays = parseInt(process.env.CROW_BACKUP_KEEP_DAYS || "7", 10);
  if (!keepDays || keepDays <= 0) {
    console.log("  Retention disabled (CROW_BACKUP_KEEP_DAYS <= 0).");
    return 0;
  }
  const ctx = localBackupContext(process.env);
  const { dir, label, tag } = ctx;
  // Same identity the copy path records, so the foreign-owner guard compares
  // like with like.
  const me = dbPath ? { ...ctx.me, db_path: path.resolve(dbPath) } : ctx.me;
  const cutoff = Date.now() - keepDays * 24 * 3600 * 1000;
  const sqlRe = new RegExp(`^${escapeRe(backupStem(label, tag))}-(${DATE_RE})\\.sql$`);
  const identityRe = ownIdentityRegex(label, tag);

  // This instance's own files of one name pattern, older than the cutoff and
  // never one whose sidecar names another instance.
  const ownOlder = (re) => {
    const out = [];
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return out; }
    for (const name of names) {
      if (!re.test(name)) continue;
      const full = path.join(dir, name);
      // The same guard as the .db half: a file whose sidecar names another
      // instance is never ours to delete.
      if (isForeignOwner(readOwner(full), me)) continue;
      try {
        const st = fs.statSync(full);
        if (st.isFile() && st.mtimeMs < cutoff) out.push(full);
      } catch { /* raced away */ }
    }
    return out;
  };
  const ownSql = () => ownOlder(sqlRe);
  const ownIdentity = () => ownOlder(identityRe);

  if (dryRun) {
    const { listOwnBackups } = await import("../servers/shared/backup-naming.js");
    const dbCount = listOwnBackups(dir, label, tag).filter((f) => f.mtimeMs < cutoff).length;
    const count = dbCount + ownSql().length + ownIdentity().length;
    console.log(`  [dry-run] Would prune up to ${count} file(s) older than ${keepDays} days (this instance's only).`);
    return 0;
  }

  const { pruneOwnBackups } = await import("../servers/gateway/routes/admin-backup.js");
  const { pruned } = pruneOwnBackups(dir, { label, tag, me, keepDays });
  let sqlPruned = 0;
  for (const full of ownSql()) {
    removeWithJournals(full);
    sqlPruned++;
  }
  // An identity copy is pruned with the run it belongs to, sidecar and all —
  // the same per-instance rule, so a co-hosted instance's copies survive.
  let identityPruned = 0;
  for (const full of ownIdentity()) {
    removeWithJournals(full);
    unlinkQuiet(ownerPath(full));
    identityPruned++;
  }
  if (!pruned && !sqlPruned && !identityPruned) {
    console.log("  No old backups to prune.");
  } else {
    const identityPart = identityPruned ? ` and ${identityPruned} identity cop${identityPruned === 1 ? "y" : "ies"}` : "";
    console.log(`  Pruned ${pruned} database cop${pruned === 1 ? "y" : "ies"} and ${sqlPruned} SQL dump${sqlPruned === 1 ? "" : "s"}${identityPart} older than ${keepDays} days.`);
  }
  return 0;
}

/* ------------------------------------------------------------------- main */

function parseArgs(argv) {
  const opts = { mode: "make", dryRun: false, dbPath: null, report: null, file: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--report") { opts.report = argv[++i]; }
    else if (a === "--db") { opts.dbPath = argv[++i]; }
    else if (a === "--may-leave") { opts.mode = "may-leave"; opts.file = argv[++i]; }
    else if (a === "--names") { opts.mode = "names"; }
    else if (a === "--backup-dir") { opts.mode = "backup-dir"; }
    else if (a === "--naming") { opts.mode = "naming"; }
    else if (a === "--prune") { opts.mode = "prune"; }
    else if (a === "--dry-run") { opts.dryRun = true; }
    else if (a === "-h" || a === "--help") { opts.mode = "help"; }
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.mode === "help") {
    console.log("usage: node scripts/backup-db.mjs [--report FILE --db PATH] [--names] [--backup-dir] [--naming] [--may-leave FILE] [--prune [--dry-run]]");
    return 0;
  }
  if (opts.mode === "may-leave") {
    // The upload guard's single definition (uploadRefusalReason): silence and 0
    // when the file may leave, the reason on stdout and 3 when it must not.
    if (!opts.file) throw new Error("--may-leave <file> is required");
    const why = uploadRefusalReason(opts.file);
    if (!why) return 0;
    process.stdout.write(`${why}\n`);
    return 3;
  }
  if (opts.mode === "backup-dir") {
    process.stdout.write(resolveBackupDir() + "\n");
    return 0;
  }
  if (opts.mode === "naming") {
    // One line each: the stem of this instance's backup names, its tag (empty
    // for the host-default instance) and its artifacts copy's directory name.
    // scripts/backup.sh reads these to name the artifacts copy and the git
    // dumps per instance.
    const { label, tag } = localBackupContext(process.env);
    process.stdout.write(`${backupStem(label, tag)}\n${tag || ""}\n${artifactStoreName(label, tag)}\n`);
    return 0;
  }
  if (opts.mode === "prune") return prune({ dryRun: opts.dryRun, dbPath: opts.dbPath || process.env.CROW_DB_PATH || null });
  const dbPath = opts.dbPath || process.env.CROW_DB_PATH;
  if (!dbPath) throw new Error("--db <path> (or CROW_DB_PATH) is required");
  if (!fs.existsSync(dbPath)) throw new Error(`database not found at ${dbPath}`);
  if (!opts.report) throw new Error("--report <file> is required");
  return make({ dbPath, reportFile: opts.report, dryRun: opts.mode === "names" || opts.dryRun });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code ?? 0))
    .catch((err) => {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    });
}