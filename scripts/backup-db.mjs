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
 *      script never opens the live database on this path.
 *   2. Otherwise the deciding question is who has the DATABASE open, not which
 *      port answers (dbHolders() in scripts/restore-db.mjs — /proc/<pid>/fd,
 *      else lsof). With no holders, open the database READ-ONLY and run
 *      .backup() into a temp file in the backup dir, verify it (quick_check,
 *      then wal_checkpoint(TRUNCATE) so the copy is one self-contained file),
 *      and rename it into place under the SAME name — with the same owner
 *      sidecar — the endpoint writes. With holders and no gateway of ours, or
 *      when the holders cannot be determined, refuse: an external open of a
 *      live WAL crow.db is what orphans the gateway's descriptors.
 *   2b. A port that answers but does not answer like a gateway (5xx, reset,
 *      garbage, timeout) also refuses: something there may well be holding the
 *      database.
 *   3. The SQL dump is made from the VERIFIED COPY (never the live DB) and
 *      only when the sqlite3 CLI is installed. Without it the dump is
 *      skipped with one line: the binary copy is complete on its own.
 *
 * Modes (backup.sh calls these; nothing else should need them):
 *   --report <file> --db <path>            make the copy (+ dump), report what landed
 *   --names --report <file> --db <path>    dry run: report the names only, write nothing
 *   --backup-dir                           print resolveBackupDir() and exit
 *   --naming                               print stem, tag and artifacts dir name
 *   --prune [--dry-run] [--db <path>]      per-instance retention for .db and .sql
 *
 * The report file is a shell-sourceable list (DB_FILE=..., SQL_FILE=...,
 * SOURCE=..., copied by backup.sh for its S3/git steps).
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
  isForeignOwner, resolveBackupDir,
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
  const answerDb = typeof body.db_path === "string" ? realpathOrResolve(body.db_path) : null;
  const answerPath = typeof body.path === "string" ? body.path : null;
  const answerReal = answerPath ? realpathOrResolve(answerPath) : null;
  const ours = answerDb !== null && answerDb === dbReal && answerReal !== null && isInsideDir(answerReal, dirReal);
  if (!ours) {
    const where = answerDb ? ` (it backed up ${answerDb})` : " (its answer names no db_path)";
    const outside = answerReal && !isInsideDir(answerReal, dirReal) ? `, and its copy ${answerReal} is outside ${dirReal}` : "";
    return { foreign: true, reason: `the gateway on port ${port} backs up another database${where}${outside} — ignoring it` };
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

  if (dryRun) {
    writeReport(reportFile, {
      DB_FILE: planned,
      SQL_FILE: planned.replace(/\.db$/, ".sql"),
      SOURCE: "names",
    });
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

  if (probe.up && !probe.ok) {
    // A port that answers but not like a gateway is a port that may well hold
    // the live database: refuse instead of opening the file ourselves.
    throw new Error(listeningRefusal(port, probe));
  }

  if (probe.ok) {
    console.log(`  Gateway answering on 127.0.0.1:${port} — asking it for the copy (the live database is not opened here).`);
    const answer = await gatewayCopy(port, { dbReal, dirReal });
    if (answer.foreign) {
      console.log(`  ${answer.reason}.`);
    } else {
      source = "gateway";
      copy = answer;
    }
  }

  if (!copy) {
    // Nobody to ask, or the one we asked was not ours: the file handles decide.
    const holders = dbHolders(dbPath);
    if (holders && holders.length) {
      const who = holdersText(holders);
      throw new Error(
        probe.ok
          ? `${dbName} is open by: ${who} but no gateway for it answers on port ${port}; ` +
            `set PORT/CROW_GATEWAY_PORT to its port, or stop those processes.`
          : `${dbName} is open by: ${who}. Stop the gateway and any Crow server using this ` +
            `database, then run the backup again (or set PORT/CROW_GATEWAY_PORT to the port of ` +
            `the gateway that serves it).`,
      );
    }
    if (holders === null) {
      throw new Error(
        `could not check whether another process holds ${dbPath} (no /proc/<pid>/fd and no lsof ` +
        `on this host) — refusing to open it directly in case something does`,
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
  return 0;
}

/* ------------------------------------------------------------- prune mode */

/**
 * Per-instance retention. The .db half is the endpoint's own pruneOwnBackups
 * (same name pattern, same foreign-owner guard), so a script-pruned dir looks
 * exactly like an endpoint-pruned one; the .sql half removes this instance's
 * dumps older than CROW_BACKUP_KEEP_DAYS.
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

  const ownSql = () => {
    const out = [];
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return out; }
    for (const name of names) {
      if (!sqlRe.test(name)) continue;
      const full = path.join(dir, name);
      // The same guard as the .db half: a dump whose sidecar names another
      // instance is never ours to delete.
      if (isForeignOwner(readOwner(full), me)) continue;
      try {
        const st = fs.statSync(full);
        if (st.isFile() && st.mtimeMs < cutoff) out.push(full);
      } catch { /* raced away */ }
    }
    return out;
  };

  if (dryRun) {
    const { listOwnBackups } = await import("../servers/shared/backup-naming.js");
    const dbCount = listOwnBackups(dir, label, tag).filter((f) => f.mtimeMs < cutoff).length;
    console.log(`  [dry-run] Would prune up to ${dbCount + ownSql().length} file(s) older than ${keepDays} days (this instance's only).`);
    return 0;
  }

  const { pruneOwnBackups } = await import("../servers/gateway/routes/admin-backup.js");
  const { pruned } = pruneOwnBackups(dir, { label, tag, me, keepDays });
  let sqlPruned = 0;
  for (const full of ownSql()) {
    removeWithJournals(full);
    sqlPruned++;
  }
  if (!pruned && !sqlPruned) {
    console.log("  No old backups to prune.");
  } else {
    console.log(`  Pruned ${pruned} database cop${pruned === 1 ? "y" : "ies"} and ${sqlPruned} SQL dump${sqlPruned === 1 ? "" : "s"} older than ${keepDays} days.`);
  }
  return 0;
}

/* ------------------------------------------------------------------- main */

function parseArgs(argv) {
  const opts = { mode: "make", dryRun: false, dbPath: null, report: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--report") { opts.report = argv[++i]; }
    else if (a === "--db") { opts.dbPath = argv[++i]; }
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
    console.log("usage: node scripts/backup-db.mjs [--report FILE --db PATH] [--names] [--backup-dir] [--naming] [--prune [--dry-run]]");
    return 0;
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