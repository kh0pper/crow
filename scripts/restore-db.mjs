#!/usr/bin/env node
/**
 * Node side of `npm run restore` (scripts/restore.sh).
 *
 * The restore itself is a file copy, but a few steps must not use the sqlite3
 * CLI (N1c-9/N1c-13):
 *
 *   safety-copy  Take the whole CURRENT database before it is replaced. A
 *                `cp crow.db` misses everything still sitting in crow.db-wal,
 *                so the pre-restore copy is a better-sqlite3 online .backup()
 *                — it reads through the WAL and writes one self-contained
 *                file, 0600. The live database it reads is opened READ-ONLY.
 *                A copy that cannot be made or fails quick_check exits non-zero
 *                (restore.sh then stops instead of replacing the database).
 *   check-source THE SOURCE GATE: refuse a source that is the live database
 *                itself (or its -wal/-shm), one that is empty, or one that
 *                fails quick_check read-only — all before anything changes.
 *   apply        Replace the database: copy (or replay) into a temp file BESIDE
 *                it, quick_check the temp, then drop the old -wal/-shm and
 *                rename the temp into place. The restored file keeps the old
 *                file's owner and mode.
 *   inspect      --dry-run listing of a .db backup: quick_check, the table
 *                list and per-table row counts (read-only).
 *   verify       Post-restore check: quick_check plus the table and memories
 *                counts.
 *   precheck     THE GATE. Is any other process holding the database open
 *                (dbHolders), and is anything answering on the gateway port?
 *                restore.sh refuses to run while either is true.
 *
 * dbHolders() is exported because scripts/backup-db.mjs asks the same
 * question: "who has this database open" — not "which port answers" — is what
 * decides whether a copy may safely be taken here.
 *
 * Globals stay off the live file: every open of a live database in this file
 * is read-only, and every write is to a copy or to the freshly restored DB of
 * a host where nothing holds it.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { gatewayListenPort } from "../servers/gateway/listen-port.js";
import { probeGateway } from "./backup-db.mjs";

const FILE_MODE = 0o600;

function chmodQuiet(p, mode) {
  try { fs.chmodSync(p, mode); } catch { /* not ours / gone */ }
}

function unlinkQuiet(p) {
  try { fs.unlinkSync(p); } catch { /* already gone */ }
}

/* ---------------------------------------------------- who holds the database */

/**
 * The paths a holder could have open: the database and its WAL sidecars.
 * Realpath where it exists, so a symlinked data dir compares equal.
 */
function dbTargets(dbPath) {
  const targets = new Set();
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = dbPath + suffix;
    try { targets.add(fs.realpathSync(p)); } catch { targets.add(path.resolve(p)); }
  }
  return targets;
}

/** The process name for a pid: /proc/<pid>/comm, else `ps`; "?" when neither. */
function commOf(pid) {
  try {
    const comm = fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim();
    if (comm) return comm;
  } catch { /* no procfs (or not ours to read) */ }
  try {
    const r = spawnSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" });
    const comm = (r.stdout || "").trim();
    if (comm) return path.basename(comm);
  } catch { /* ps missing */ }
  return "?";
}

/**
 * Linux: every /proc/<pid>/fd link whose target is the DB, its -wal or its
 * -shm. Unreadable pids (other users, vanished, hidden) are skipped quietly;
 * null when the scan told us nothing at all (no /proc, or not one fd dir
 * readable) — "unknown" must never be mistaken for "nobody".
 * @returns {{pid:number, comm:string}[]|null}
 */
function procFsHolders(dbPath) {
  const targets = dbTargets(dbPath);
  let entries = null;
  try { entries = fs.readdirSync("/proc"); } catch { return null; }
  const found = [];
  let sawAnyFdDir = false;
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;
    let fds;
    try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch { continue; }
    sawAnyFdDir = true;
    let holds = false;
    for (const fd of fds) {
      let link;
      try { link = fs.readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
      // "…/crow.db-wal (deleted)": still an open descriptor on our file.
      if (targets.has(link.replace(/ \(deleted\)$/, ""))) { holds = true; break; }
    }
    if (holds) found.push({ pid, comm: commOf(pid) });
  }
  if (!sawAnyFdDir) return null;
  return found.sort((a, b) => a.pid - b.pid);
}

/**
 * Fallback for hosts without procfs: `lsof -t` on the database and its
 * sidecars. null when lsof is not installed (nothing told us anything).
 * @returns {{pid:number, comm:string}[]|null}
 */
function lsofHolders(dbPath) {
  const pids = new Set();
  let ran = false;
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = dbPath + suffix;
    if (suffix && !fs.existsSync(p)) continue;
    const r = spawnSync("lsof", ["-t", "-w", "--", p], { encoding: "utf8" });
    if (r.error) continue; // lsof missing: try the next one (and give up on null)
    ran = true; // status 1 = ran fine, nobody holds it
    for (const token of String(r.stdout || "").trim().split(/\s+/)) {
      const pid = Number(token);
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) pids.add(pid);
    }
  }
  if (!ran) return null;
  return [...pids].sort((a, b) => a - b).map((pid) => ({ pid, comm: commOf(pid) }));
}

/**
 * Which processes (other than this one) have the database open — the database
 * itself, its -wal or its -shm.
 *
 * Why this and not a port probe: a second Crow server started from another
 * CROW_HOME, a pi-bots bridge, an `sqlite3` shell or a crashed keeper all hold
 * crow.db/-wal/-shm without answering on OUR port, and a running gateway is
 * only visible as a port until you know it is ours. The file handles are the
 * fact; the port is a guess.
 *
 * @returns {{pid:number, comm:string}[]|null} holders (possibly empty), or
 *   null when this host gives no way to tell.
 */
export function dbHolders(dbPath) {
  if (process.platform === "linux") {
    const found = procFsHolders(dbPath);
    if (found) return found;
  }
  return lsofHolders(dbPath);
}

/** "1234 (node), 5678 (node)" */
export function holdersText(holders) {
  return holders.map((h) => `${h.pid} (${h.comm})`).join(", ");
}

/* ------------------------------------------------------------------ checks */

/**
 * quick_check a file. `readonly` opens the database read-only — used for the
 * live database's safety copy and for previewing a user's backup file, neither
 * of which may be written to.
 */
function quickCheck(file, { readonly = false } = {}) {
  let handle = null;
  try {
    handle = new Database(file, readonly ? { readonly: true, fileMustExist: true } : { fileMustExist: true });
    const rows = handle.pragma("quick_check");
    const result = Array.isArray(rows) ? String(rows[0]?.quick_check ?? rows[0]) : String(rows);
    return { ok: result === "ok", result, handle };
  } catch (err) {
    try { handle?.close(); } catch { /* closed */ }
    return { ok: false, result: err.message, handle: null };
  }
}

/** quick_check a file, close the handle and drop any journal our own read left. */
function checkFile(file, { readonly = false, fold = false } = {}) {
  const journalsBefore = journalsOf(file);
  const res = quickCheck(file, { readonly });
  if (res.handle) {
    try {
      // Folding the WAL leaves ONE self-contained file, which is what gets
      // renamed into place; a filesystem that will not checkpoint is not fatal.
      if (fold && res.ok) { try { res.handle.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* best-effort */ } }
      res.handle.close();
    } catch { /* already closed */ }
  }
  dropCreatedJournals(file, journalsBefore);
  return { ok: res.ok, result: res.result };
}

/** Remove a -wal/-shm that our own read-only open created (never a pre-existing one). */
function dropCreatedJournals(file, existedBefore) {
  for (const suffix of ["-wal", "-shm"]) {
    if (existedBefore.has(file + suffix)) continue;
    unlinkQuiet(file + suffix);
  }
}

const journalsOf = (file) => new Set([file + "-wal", file + "-shm"].filter((p) => fs.existsSync(p)));

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

/* ------------------------------------------------------- the source guards */

/** Real path of a file, falling back to the absolute path when it is gone. */
function realpathOrResolve(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

/**
 * The source must never be the database being replaced, nor one of its
 * -wal/-shm files: restoring the live file onto itself destroys both copies
 * (and a -wal replayed as a database is not one).
 * @returns {string|null} the refusal sentence, or null when the source is safe.
 */
function selfRestoreReason(source, dbPath) {
  const src = realpathOrResolve(source);
  for (const suffix of ["", "-wal", "-shm"]) {
    if (src !== realpathOrResolve(dbPath + suffix)) continue;
    return suffix
      ? `refusing to restore ${source}: it is ${path.basename(dbPath)}${suffix}, part of the database a restore replaces`
      : `refusing to restore ${source}: it IS the database being restored (${dbPath}) — nothing has been changed`;
  }
  return null;
}

/**
 * THE SOURCE GATE, run before anything is touched. Refuses (code 4) a source
 * that is the target itself, is empty, or fails quick_check read-only; code 1
 * is an error reading it. The sentence goes to stdout.
 */
function checkSource(source, dbPath) {
  const self = selfRestoreReason(source, dbPath);
  if (self) return { code: 4, message: self };
  let st;
  try { st = fs.statSync(source); } catch (err) {
    return { code: 1, message: `cannot read ${source}: ${err.message}` };
  }
  if (!st.isFile()) return { code: 1, message: `${source} is not a regular file` };
  if (st.size === 0) return { code: 4, message: `refusing to restore ${source}: the file is empty — nothing has been changed` };
  if (/\.sql$/i.test(source)) {
    return { code: 0, message: `  Source check: ${path.basename(source)} is a SQL dump (${st.size} bytes).` };
  }
  const check = checkFile(source, { readonly: true });
  if (!check.ok) {
    return {
      code: 4,
      message: `refusing to restore ${source}: it failed its integrity check (${check.result}) — nothing has been changed`,
    };
  }
  return { code: 0, message: "  Source check: quick_check ok." };
}

/* ------------------------------------------------------------- the restore */

/** Replay a .sql dump into `dest` with the sqlite3 CLI (the only external tool). */
function replaySql(source, dest) {
  if (spawnSync("sqlite3", ["--version"], { stdio: "ignore" }).error) {
    throw new Error("the sqlite3 command-line tool is not installed, so a .sql dump cannot be replayed");
  }
  const inFd = fs.openSync(source, "r");
  let r;
  try {
    r = spawnSync("sqlite3", [dest], { stdio: [inFd, "ignore", "pipe"] });
  } finally {
    try { fs.closeSync(inFd); } catch { /* closed */ }
  }
  if (r.error) throw r.error;
  if (r.status !== 0) {
    const why = String(r.stderr || "").trim().split("\n")[0] || `sqlite3 exited ${r.status}`;
    throw new Error(`replaying the SQL dump failed: ${why}`);
  }
}

/**
 * Replace `dbPath` with the backup at `source`.
 *
 * The order is what keeps the old database safe: `check-source` has already
 * verified the source (read-only); the copy lands in a temp file BESIDE the
 * database and is verified there; only then are the old database's -wal/-shm
 * removed and the temp renamed into place. `rename` is atomic and the temp is
 * on the same filesystem, so a failure at any point leaves the old database
 * and its WAL exactly as they were. A .sql dump is replayed into the temp file
 * and checked in the same way.
 *
 * The restored file keeps the old database's OWNER and MODE when there was one
 * (a service user's crow.db stays that user's file); as a non-root user chown
 * cannot give a file away, which is said out loud.
 */
function applyRestore(source, dbPath) {
  const dir = path.dirname(dbPath);
  const base = path.basename(dbPath);
  const tmp = path.join(dir, `.${base}.restore-${Date.now()}-${process.pid}.tmp`);
  const isSql = /\.sql$/i.test(source);
  let old = null;
  try { old = fs.statSync(dbPath); } catch { /* no database yet */ }

  try {
    if (isSql) {
      replaySql(source, tmp);
    } else {
      fs.copyFileSync(source, tmp);
      // Test seam (tests/backup-script.test.js): a copy that dies half-way,
      // proving the old database and its -wal survive a failed restore.
      if (process.env.CROW_RESTORE_TEST_FAIL === "copy") {
        const fd = fs.openSync(tmp, "r+");
        try {
          const size = fs.fstatSync(fd).size;
          fs.ftruncateSync(fd, Math.max(1, Math.floor(size / 2)));
        } finally { fs.closeSync(fd); }
        throw new Error("injected failure: the copy died before the database was replaced");
      }
    }
    chmodQuiet(tmp, FILE_MODE);
    const check = checkFile(tmp, { fold: true });
    if (!check.ok) throw new Error(`the restored copy failed its integrity check (${check.result})`);
    // Verified. Only now may the old database's journals go, and only now is
    // the file under the real name replaced.
    for (const suffix of ["-wal", "-shm"]) unlinkQuiet(dbPath + suffix);
    fs.renameSync(tmp, dbPath);
  } catch (err) {
    for (const p of [tmp, tmp + "-wal", tmp + "-shm"]) unlinkQuiet(p);
    throw err;
  }

  if (old) {
    try {
      fs.chownSync(dbPath, old.uid, old.gid);
    } catch (err) {
      const why = err.code === "EPERM"
        ? "not permitted (only root can give a file to another user)"
        : err.message;
      console.log(`  Note: could not keep the old database's owner (${why}); ${base} is owned by the user running the restore.`);
    }
    chmodQuiet(dbPath, old.mode & 0o7777);
  } else {
    chmodQuiet(dbPath, FILE_MODE);
  }
  const size = fs.statSync(dbPath).size;
  console.log(`  ${isSql ? "SQL dump replayed" : "Binary copy restored"}: ${dbPath} (${size} bytes).`);
  return 0;
}

/* ---------------------------------------------------------------- commands */

/** Whole copy of an OFFLINE database into `dest`, 0600.
 *
 * Returns 1 (and keeps the bad copy as evidence) when the copy cannot be made
 * or fails quick_check: restore.sh stops there rather than replacing a database
 * it could not save first. */
async function safetyCopy(dbPath, dest) {
  if (!fs.existsSync(dbPath)) {
    console.log(`  No database at ${dbPath} — nothing to save.`);
    return 0;
  }
  try { fs.unlinkSync(dest); } catch { /* fresh name */ }
  try {
    // Read-only: this is the live database. better-sqlite3 never writes through
    // this handle, so a pre-restore copy cannot checkpoint or roll anything back.
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      // better-sqlite3's online backup API is asynchronous and reads through
      // the WAL, so un-checkpointed rows land in the copy.
      await db.backup(dest);
    } finally {
      try { db.close(); } catch { /* closed */ }
    }
  } catch (err) {
    console.error(`  Error: could not save the current database: ${err.message}`);
    console.error("  Stopping — the restore will not replace a database it could not back up first.");
    return 1;
  }
  chmodQuiet(dest, FILE_MODE);
  const check = checkFile(dest);
  if (!check.ok) {
    console.error(`  Error: the pre-restore copy failed quick_check (${check.result}). It was kept at ${dest}.`);
    console.error("  Stopping — the restore will not replace a database whose own backup is not sound.");
    return 1;
  }
  const size = fs.statSync(dest).size;
  console.log(`  Saved a whole copy of the current database (WAL included): ${size} bytes, quick_check ok.`);
  return 0;
}

/** --dry-run preview of a .db backup (read-only: it is the user's only copy). */
function inspect(file) {
  const journalsBefore = journalsOf(file);
  const check = quickCheck(file, { readonly: true });
  if (!check.ok) {
    dropCreatedJournals(file, journalsBefore);
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
    dropCreatedJournals(file, journalsBefore);
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

/**
 * The gate restore.sh runs before it touches anything.
 *
 * Refuses (exit 3, reason on stdout) when:
 *   - any other process holds the database (file handles beat port guesses),
 *   - something is answering on the gateway port (a live gateway holds the
 *     -wal/-shm we are about to remove),
 *   - the holders cannot be determined AND something answers on the port.
 * Warns on stdout and allows (exit 0) when holders are unknown but nothing
 * answers on the port — the legacy behaviour, now said out loud.
 */
async function precheck(dbPath) {
  const name = path.basename(dbPath);
  const holders = dbHolders(dbPath);
  if (holders && holders.length) {
    process.stdout.write(
      `${name} is open by: ${holdersText(holders)}. Stop the gateway and any Crow server ` +
      `using this database, then run the restore again.\n`,
    );
    return 3;
  }

  const port = gatewayListenPort();
  const probe = await probeGateway(port);
  if (probe.up) {
    if (probe.ok) {
      process.stdout.write(
        `The gateway is running on port ${port}. Stop it first\n` +
        `(systemctl --user stop crow-gateway, or stop the process), then run the restore again.\n`,
      );
    } else {
      const why = probe.timedOut
        ? "GET /health did not answer within 2 s"
        : probe.status
          ? `GET /health answered HTTP ${probe.status}`
          : `GET /health failed (${probe.error || "no usable answer"})`;
      process.stdout.write(
        `something is listening on port ${port} but ${why} — a Crow server may be holding the ` +
        `database; stop it (systemctl --user stop crow-gateway, or stop the process), then run the restore again.\n`,
      );
    }
    return 3;
  }

  if (holders === null) {
    process.stdout.write(
      `Warning: could not check whether another process holds ${name} (no /proc/<pid>/fd and no ` +
      `lsof on this host); nothing answers on port ${port} either.\n`,
    );
  }
  return 0;
}

/* ------------------------------------------------------------------- main */

export async function main(argv = process.argv.slice(2)) {
  const [cmd, a, b] = argv;
  switch (cmd) {
    case "safety-copy":
      if (!a || !b) throw new Error("usage: restore-db.mjs safety-copy <db> <dest>");
      return await safetyCopy(a, b);
    case "check-source": {
      if (!a || !b) throw new Error("usage: restore-db.mjs check-source <backup-file> <db>");
      const r = checkSource(a, b);
      process.stdout.write(`${r.message}\n`);
      return r.code;
    }
    case "apply":
      if (!a || !b) throw new Error("usage: restore-db.mjs apply <backup-file> <db>");
      return applyRestore(a, b);
    case "inspect":
      if (!a) throw new Error("usage: restore-db.mjs inspect <backup.db>");
      return inspect(a);
    case "verify":
      if (!a) throw new Error("usage: restore-db.mjs verify <db>");
      return verify(a);
    case "precheck":
      if (!a) throw new Error("usage: restore-db.mjs precheck <db>");
      return await precheck(a);
    default:
      console.log("usage: node scripts/restore-db.mjs safety-copy <db> <dest> | check-source <backup-file> <db> | apply <backup-file> <db> | inspect <backup.db> | verify <db> | precheck <db>");
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