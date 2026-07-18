/**
 * migration-guard.js — runtime migration guard (Item A3).
 *
 * Wraps production init-db runs (auto-update post-pull, gateway boot gate,
 * guarded-init-db CLI) with: pre-migration backup, post-migration row-count /
 * column / schema-object classification, and the Q9 policy — fail closed ONLY
 * on high-confidence loss (restore + quarantine), fail open with a loud
 * DB-free alert on everything else.
 *
 * HARD RULE: every DB access in this module uses raw short-lived
 * better-sqlite3 connections, explicitly closed before any restore — NEVER
 * createDbClient (its per-path keeper handle is never closed and would pin
 * the pre-restore inode for process lifetime; see servers/db.js keeper docs).
 * On the boot path this module's readSchemaState() IS the gate's detection
 * read, so createDbClient first touches the DB only after the gate concludes.
 *
 * Spec + review record: crow-engineering
 * specs/2026-07-18-a3-migration-guard-design.md (rev 3; R1 4C/7M/6M, R2 2C/3M/5M).
 */

import Database from "better-sqlite3";
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync,
  statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import {
  EXPECTED_DROPS, EXPECTED_MOVES, EXPECTED_OBJECT_REMOVALS, EXPECTED_PRUNES,
  LOSS_FLOOR, LOSS_FRACTION, REBUILD_TABLES, VOLATILE_TABLES,
} from "./migration-expectations.js";

const BACKUP_KEEP = 3;
const BACKUP_MAX_MB = Number(process.env.CROW_MIGRATION_BACKUP_MAX_MB || 2048);
const PIN_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // pinned backups exempt 30 days
const DAMAGED_KEEP = 2;
const QUARANTINE_MAX_ATTEMPTS = 3;
const REPO_MARKER = ".crow-migration-quarantine.json";
const DATA_MARKER = "migration-quarantine.json";

/* ------------------------------------------------------------------ paths */

/** The DB path exactly as init-db resolves it. */
export function resolveGuardDbPath(dataDirResolver) {
  if (process.env.CROW_DB_PATH) return resolve(process.env.CROW_DB_PATH);
  return join(dataDirResolver(), "crow.db");
}

/** Backups + marker anchor: the DB's own directory (CROW_DB_PATH may diverge
 *  from resolveDataDir — grackle's F2 incident). */
export function guardAnchor(dbPath) {
  return dirname(resolve(dbPath));
}

/* -------------------------------------------------------------- snapshots */

/** Raw, short-lived, readonly snapshot of everything classification needs. */
export function snapshotDb(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const tables = {};
    const tableRows = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all();
    for (const { name, sql } of tableRows) {
      let count = null;
      try {
        count = db.prepare(`SELECT COUNT(*) AS n FROM "${name.replace(/"/g, '""')}"`).get().n;
      } catch {
        count = null; // unreadable table — classification treats null as unknown
      }
      let columns = [];
      try {
        columns = db.prepare(`PRAGMA table_info("${name.replace(/"/g, '""')}")`).all().map((c) => c.name);
      } catch {}
      tables[name] = { count, columns, sql: sql || "" };
    }
    const objects = db
      .prepare("SELECT type||':'||name AS o, tbl_name FROM sqlite_master WHERE type IN ('index','trigger','view') AND name NOT LIKE 'sqlite_%'")
      .all();
    const userVersion = db.pragma("user_version", { simple: true });
    const pruneCounts = {};
    for (const { table, predicate } of EXPECTED_PRUNES) {
      try {
        pruneCounts[table] = db
          .prepare(`SELECT COUNT(*) AS n FROM "${table.replace(/"/g, '""')}" WHERE ${predicate}`)
          .get().n;
      } catch {
        pruneCounts[table] = 0;
      }
    }
    return { tables, objects, userVersion, pruneCounts };
  } finally {
    try { db.close(); } catch {}
  }
}

/** Boot-gate detection read — raw, never createDbClient. */
export function readSchemaState(dbPath) {
  if (!existsSync(dbPath)) return { exists: false, coreTableCount: 0, userVersion: 0, readable: false };
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const coreTableCount = db
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('memories','dashboard_settings','crow_context')")
      .get().n;
    let userVersion = 0;
    try { userVersion = db.pragma("user_version", { simple: true }); } catch {}
    return { exists: true, coreTableCount, userVersion, readable: true };
  } catch {
    return { exists: true, coreTableCount: 0, userVersion: 0, readable: false };
  } finally {
    try { db?.close(); } catch {}
  }
}

/* ----------------------------------------------------------- classification */

function globToRe(glob) {
  return new RegExp("^" + glob.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
}

const OBJECT_REMOVAL_RES = EXPECTED_OBJECT_REMOVALS.map(globToRe);

/**
 * Pure classification of snapshot A → B. Returns { verdict, report } where
 * verdict ∈ pass|suspect|loss (init-db exit handling is the caller's job —
 * a nonzero exit can only worsen pass → suspect).
 */
export function classify(snapA, snapB) {
  const losses = [];
  const suspects = [];
  const excused = [];
  const moveGains = {};
  for (const { from, to } of EXPECTED_MOVES) {
    const a = snapA.tables[to]?.count ?? 0;
    const b = snapB.tables[to]?.count ?? 0;
    moveGains[from] = Math.max(0, (b ?? 0) - (a ?? 0));
  }

  for (const [name, aInfo] of Object.entries(snapA.tables)) {
    const bInfo = snapB.tables[name];
    // Disappeared tables
    if (!bInfo) {
      if (EXPECTED_DROPS.includes(name)) { excused.push(`${name}: expected drop`); continue; }
      losses.push(`table ${name} disappeared (${aInfo.count} rows)`);
      continue;
    }
    if (aInfo.count == null || bInfo.count == null) {
      suspects.push(`${name}: count unreadable (A=${aInfo.count} B=${bInfo.count})`);
      continue;
    }
    let lost = aInfo.count - bInfo.count;
    if (lost <= 0) continue; // increases always pass

    // Excusals, in spec order: prunes (bounded), moves (bounded)
    const prune = EXPECTED_PRUNES.find((p) => p.table === name);
    if (prune) {
      const bound = snapA.pruneCounts[name] ?? 0;
      const used = Math.min(lost, bound);
      if (used > 0) excused.push(`${name}: ${used} rows via expected prune`);
      lost -= used;
    }
    if (lost > 0 && moveGains[name] > 0) {
      const used = Math.min(lost, moveGains[name]);
      excused.push(`${name}: ${used} rows moved to ${EXPECTED_MOVES.find((m) => m.from === name).to}`);
      lost -= used;
    }
    if (lost <= 0) continue;

    const rebuildPolicy = REBUILD_TABLES[name];
    const rebuildFired = rebuildPolicy && aInfo.sql !== bInfo.sql;
    if (rebuildFired) {
      const msg = `rebuilt table ${name} lost ${lost} rows (${aInfo.count} -> ${bInfo.count})`;
      if (rebuildPolicy === "strict") losses.push(msg);
      else suspects.push(`${msg} [dedup-tolerant rebuild]`);
      continue;
    }
    if (VOLATILE_TABLES.includes(name)) {
      suspects.push(`volatile ${name}: ${aInfo.count} -> ${bInfo.count}`);
      continue;
    }
    const toZero = bInfo.count === 0 && aInfo.count >= LOSS_FLOOR;
    const bigLoss = lost >= LOSS_FLOOR && lost / aInfo.count > LOSS_FRACTION;
    if (toZero || bigLoss) {
      losses.push(`table ${name}: ${aInfo.count} -> ${bInfo.count} unexplained`);
    } else {
      suspects.push(`${name}: ${aInfo.count} -> ${bInfo.count} (noise band)`);
    }
  }

  // Column loss on FIRED rebuilds (identical counts, narrower table)
  for (const [name, policy] of Object.entries(REBUILD_TABLES)) {
    const aInfo = snapA.tables[name];
    const bInfo = snapB.tables[name];
    if (!aInfo || !bInfo || aInfo.sql === bInfo.sql) continue;
    const lostCols = aInfo.columns.filter((c) => !bInfo.columns.includes(c));
    if (lostCols.length) {
      const msg = `rebuilt table ${name} lost column(s): ${lostCols.join(", ")}`;
      if (policy === "strict") losses.push(msg);
      else suspects.push(msg);
    }
  }

  // sqlite_master object removals (indexes/triggers/views) — SUSPECT band
  const bObjects = new Set(snapB.objects.map((o) => o.o));
  for (const { o, tbl_name } of snapA.objects) {
    if (bObjects.has(o)) continue;
    const name = o.split(":")[1];
    const tableExcused =
      EXPECTED_DROPS.includes(tbl_name) ||
      (REBUILD_TABLES[tbl_name] && snapA.tables[tbl_name]?.sql !== snapB.tables[tbl_name]?.sql) ||
      !snapB.tables[tbl_name];
    if (tableExcused && snapB.tables[tbl_name]) {
      // rebuild fired: object loss on a rebuilt table is still worth an alert
      // unless explicitly expected — FTS trigger loss broke search before.
      if (OBJECT_REMOVAL_RES.some((re) => re.test(name))) { excused.push(`object ${o}: expected removal`); continue; }
      suspects.push(`object ${o} removed by ${tbl_name} rebuild without recreation`);
      continue;
    }
    if (tableExcused) { excused.push(`object ${o}: table excused`); continue; }
    if (OBJECT_REMOVAL_RES.some((re) => re.test(name))) { excused.push(`object ${o}: expected removal`); continue; }
    suspects.push(`object ${o} removed`);
  }

  const verdict = losses.length ? "loss" : suspects.length ? "suspect" : "pass";
  return { verdict, report: { losses, suspects, excused } };
}

/* ------------------------------------------------------------------ backup */

export function backupDir(dbPath) {
  return join(guardAnchor(dbPath), "backups", "migrations");
}

async function takeBackup(dbPath, fromGen, toGen, performBackupFn) {
  const dir = backupDir(dbPath);
  // A backup-infrastructure failure (unwritable data dir, ENOSPC — the most
  // likely trigger for a BACKUP feature) must degrade to the fail-open
  // "no safety backup" path, never throw out of the never-throws guard.
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    return { ok: false, reason: `cannot create backup dir: ${err?.message}` };
  }
  // Free-space precheck: ≥1.2× DB size on the anchor filesystem.
  try {
    const { statfsSync } = await import("node:fs");
    const dbSize = statSync(dbPath).size;
    const st = statfsSync(dir);
    if (st.bavail * st.bsize < dbSize * 1.2) {
      return { ok: false, reason: `insufficient disk (need ${Math.ceil((dbSize * 1.2) / 1e6)}MB free)` };
    }
  } catch {} // statfs unsupported → attempt the backup anyway
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = join(dir, `crow-pre-g${fromGen}-to-g${toGen}-${ts}.db`);
  try {
    await performBackupFn(dbPath, dest);
    return { ok: true, path: dest };
  } catch (err) {
    try { unlinkSync(dest); } catch {}
    return { ok: false, reason: err?.message || String(err) };
  }
}

/** Retention: keep last BACKUP_KEEP + size cap; pinned exempt 30 days.
 *  Also caps damaged-evidence sets at DAMAGED_KEEP. */
export function sweepRetention(dbPath) {
  const dir = backupDir(dbPath);
  let entries = [];
  try {
    entries = readdirSync(dir)
      .filter((f) => f.startsWith("crow-pre-") && f.endsWith(".db"))
      .map((f) => ({ f, full: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs, size: statSync(join(dir, f)).size }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch { return; }
  const now = Date.now();
  const pinned = (e) => existsSync(e.full + ".pin") && now - e.mtime < PIN_EXPIRY_MS;
  let kept = 0, bytes = 0;
  for (const e of entries) {
    if (pinned(e)) continue;
    kept += 1;
    bytes += e.size;
    if (kept > BACKUP_KEEP || bytes > BACKUP_MAX_MB * 1e6) {
      try { unlinkSync(e.full); unlinkSync(e.full + ".pin"); } catch {}
    }
  }
  // Damaged-evidence cap (crow.db.damaged-<ts>[-wal|-shm]) in the anchor dir.
  try {
    const anchor = guardAnchor(dbPath);
    const damaged = readdirSync(anchor)
      .filter((f) => /\.damaged-[^/]*$/.test(f) && !/-wal$|-shm$/.test(f))
      .map((f) => ({ f, mtime: statSync(join(anchor, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const e of damaged.slice(DAMAGED_KEEP)) {
      for (const suffix of ["", "-wal", "-shm"]) {
        try { unlinkSync(join(anchor, e.f + suffix)); } catch {}
      }
    }
  } catch {}
}

export function pinBackup(path) {
  try { writeFileSync(path + ".pin", new Date().toISOString()); } catch {}
}

/* ----------------------------------------------------------------- restore */

/** Move damaged db (+wal/+shm) aside as evidence, copy the backup in. The
 *  caller guarantees this process holds no handles on dbPath.
 *
 *  Self-healing on partial failure: if the copy-in fails after the rename,
 *  the damaged file (and its WAL siblings) are renamed BACK so dbPath is
 *  never left missing — a missing DB file would be silently re-created empty
 *  by the next better-sqlite3 open, which is worse than the damaged state. */
export function restoreBackup(dbPath, backupPath) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const evidence = `${dbPath}.damaged-${ts}`;
  renameSync(dbPath, evidence);
  const movedSuffixes = [];
  for (const suffix of ["-wal", "-shm"]) {
    try { renameSync(dbPath + suffix, evidence + suffix); movedSuffixes.push(suffix); } catch {}
  }
  try {
    copyFileSync(backupPath, dbPath);
  } catch (err) {
    try {
      renameSync(evidence, dbPath);
      for (const suffix of movedSuffixes) {
        try { renameSync(evidence + suffix, dbPath + suffix); } catch {}
      }
    } catch {}
    throw new Error(`restore copy failed (damaged file moved back): ${err?.message}`);
  }
  return { evidence };
}

/* ---------------------------------------------------------------- markers */

export function repoMarkerPath(appRoot) { return join(appRoot, REPO_MARKER); }
export function dataMarkerPath(dbPath) { return join(guardAnchor(dbPath), DATA_MARKER); }

export function readMarker(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

/** Active = present and not auto-cleared. */
export function activeMarker(path) {
  const m = readMarker(path);
  return m && !m.cleared ? m : null;
}

export function writeQuarantine({ appRoot, dbPath, sha, fromGeneration, toGeneration, report }) {
  // attempts is keyed by the (from,to) generation pair: a prior marker for the
  // SAME crossing (cleared or not) carries its attempts forward.
  let attempts = 1;
  for (const p of [repoMarkerPath(appRoot), dataMarkerPath(dbPath)]) {
    const prev = readMarker(p);
    if (prev && prev.fromGeneration === fromGeneration && prev.toGeneration === toGeneration) {
      attempts = Math.max(attempts, (prev.attempts || 0) + 1);
    }
  }
  const marker = { sha, fromGeneration, toGeneration, at: new Date().toISOString(), attempts, report };
  for (const p of [repoMarkerPath(appRoot), dataMarkerPath(dbPath)]) {
    try { writeFileSync(p, JSON.stringify(marker, null, 2)); } catch {}
  }
  return marker;
}

/**
 * Under-lock evaluation for the updater: given origin/main's fresh head sha,
 * decide { blocked, marker, cleared }. Clears (marks cleared:true, preserving
 * attempts for the pair) when the head moved AND attempts < cap.
 */
export function evaluateQuarantine({ appRoot, dbPath, originHeadSha }) {
  const paths = [repoMarkerPath(appRoot), dataMarkerPath(dbPath)];
  const markers = paths.map((p) => ({ p, m: readMarker(p) })).filter((x) => x.m && !x.m.cleared);
  if (!markers.length) return { blocked: false };
  const m = markers[0].m;
  if (originHeadSha && originHeadSha !== m.sha && (m.attempts || 1) < QUARANTINE_MAX_ATTEMPTS) {
    for (const { p, m: mm } of markers) {
      try { writeFileSync(p, JSON.stringify({ ...mm, cleared: true, clearedAt: new Date().toISOString() }, null, 2)); } catch {}
    }
    return { blocked: false, cleared: true, marker: m };
  }
  return { blocked: true, marker: m };
}

/* ---------------------------------------------------------------- alerting */

let _alertChannels = null;
/** Test hook. */
export function _setAlertChannelsForTest(ch) { _alertChannels = ch; }

async function loadAlertChannels() {
  if (_alertChannels) return _alertChannels;
  const [ntfy, email] = await Promise.all([
    import("../gateway/push/ntfy.js"),
    import("../gateway/push/email.js"),
  ]);
  return { sendNtfyNotification: ntfy.sendNtfyNotification, sendEmailNotification: email.sendEmailNotification };
}

/** DB-free loud alert (PR #124 pattern) — never throws. */
export async function fireMigrationAlert({ title, body }) {
  try {
    const ch = await loadAlertChannels();
    const payload = { title, body, url: "/dashboard/nest", priority: "high", type: "system" };
    await ch.sendNtfyNotification(payload);
    await ch.sendEmailNotification(payload);
  } catch (err) {
    console.warn(`[migration-guard] alert failed: ${err?.message}`);
  }
}

/* -------------------------------------------------------------- generation */

/** Parse SCHEMA_GENERATION from a checked-out tree (the running process's
 *  import may be stale after a pull). */
export function readTreeGeneration(appRoot) {
  try {
    const src = readFileSync(join(appRoot, "servers", "shared", "schema-version.js"), "utf8");
    const m = src.match(/SCHEMA_GENERATION\s*=\s*(\d+)/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ orchestration */

function defaultRunInitDb(appRoot) {
  return new Promise((res) => {
    execFile("node", ["scripts/init-db.js"], { cwd: appRoot, timeout: 600000 }, (err, stdout, stderr) => {
      res({ code: err ? err.code || 1 : 0, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

/**
 * The guarded init-db run (spec §3.1). Never throws; never runs init-db twice.
 * The caller decides what to do with the verdict (restart, exit, proceed).
 *
 * @returns {Promise<{verdict:string, backupPath?:string, evidence?:string,
 *   report?:object, initDbExit?:number, marker?:object}>}
 */
export async function runGuardedInitDb({
  dbPath,
  appRoot,
  sha = null,
  newGeneration = null,
  log = (m) => console.log(`[migration-guard] ${m}`),
  runInitDb = defaultRunInitDb,
  performBackupFn = null,
  restore = true, // callers that must not restore (unsupervised contexts) pass false-only via policy — default per spec
}) {
  const doBackup = performBackupFn || (await import("../db.js")).performBackup;

  // Pre-flight
  const state = readSchemaState(dbPath);
  if (!state.exists) {
    const r = await runInitDb(appRoot);
    return { verdict: "fresh", initDbExit: r.code };
  }
  if (!state.readable) {
    // Unreadable ≠ empty: preserve evidence file-copies, alert, run unguarded.
    const dir = backupDir(dbPath);
    try {
      mkdirSync(dir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      for (const suffix of ["", "-wal", "-shm"]) {
        if (existsSync(dbPath + suffix)) copyFileSync(dbPath + suffix, join(dir, `unreadable-${ts}${suffix || ".db"}`));
      }
    } catch {}
    await fireMigrationAlert({
      title: "Crow DB unreadable before migration",
      body: `The database at ${dbPath} could not be read before a migration run. File copies were saved to ${dir}. If the migration fails, run \`npm run recover-db\`.`,
    });
    const r = await runInitDb(appRoot);
    return { verdict: "unreadable", initDbExit: r.code };
  }
  if (state.coreTableCount < 3) {
    const r = await runInitDb(appRoot);
    return { verdict: "fresh", initDbExit: r.code };
  }

  // Snapshot A + backup
  let snapA;
  try {
    snapA = snapshotDb(dbPath);
  } catch (err) {
    log(`snapshot failed (${err?.message}) — running unguarded`);
    const r = await runInitDb(appRoot);
    return { verdict: "unreadable", initDbExit: r.code };
  }
  const fromGen = snapA.userVersion;
  const toGen = newGeneration ?? fromGen;
  const backup = await takeBackup(dbPath, fromGen, toGen, doBackup);
  if (!backup.ok) {
    log(`backup failed: ${backup.reason} — proceeding WITHOUT a safety backup (fail open)`);
    await fireMigrationAlert({
      title: "Crow migration running without a safety backup",
      body: `Pre-migration backup failed (${backup.reason}) for ${dbPath}. The migration will proceed; free disk space to restore protection. Backups live in ${backupDir(dbPath)}.`,
    });
  }

  // The migration
  const r = await runInitDb(appRoot);

  // Snapshot B + classify
  let result;
  try {
    const snapB = snapshotDb(dbPath);
    result = classify(snapA, snapB);
  } catch (err) {
    result = { verdict: "suspect", report: { losses: [], suspects: [`post-migration snapshot failed: ${err?.message}`], excused: [] } };
  }
  if (r.code !== 0 && result.verdict === "pass") {
    result = { verdict: "suspect", report: { ...result.report, suspects: [...result.report.suspects, `init-db exited ${r.code}`] } };
  }

  const summary = [...result.report.losses, ...result.report.suspects].join("; ") || "clean";

  if (result.verdict === "loss") {
    let evidence = null;
    if (backup.ok && restore) {
      try {
        ({ evidence } = restoreBackup(dbPath, backup.path));
        pinBackup(backup.path);
        log(`HIGH-CONFIDENCE LOSS — restored ${dbPath} from ${backup.path}; damaged file kept at ${evidence}`);
      } catch (err) {
        log(`restore FAILED: ${err?.message}`);
        evidence = null;
      }
    }
    const marker = writeQuarantine({ appRoot, dbPath, sha, fromGeneration: fromGen, toGeneration: toGen, report: result.report });
    await fireMigrationAlert({
      title: "Crow migration guard: data loss detected — migration quarantined",
      body:
        `A migration on ${dbPath} destroyed data (${summary}). ` +
        (evidence
          ? `The database was RESTORED from the pre-migration backup; the damaged file is kept at ${evidence}. Restart any Crow-connected processes (MCP servers, bots) now.`
          : backup.ok
            ? `Automatic restore FAILED — stop the gateway and restore manually from ${backup.path}.`
            : `No backup was available (disk) — the loss is NOT recoverable from the guard; check ${backupDir(dbPath)}.`) +
        ` This migration is quarantined (attempt ${marker.attempts}/${QUARANTINE_MAX_ATTEMPTS}); delete ${dataMarkerPath(dbPath)} and ${repoMarkerPath(appRoot)} to override.`,
    });
    return {
      verdict: "loss",
      backupPath: backup.path,
      evidence,
      restored: !!evidence,
      dbPresent: existsSync(dbPath),
      report: result.report,
      initDbExit: r.code,
      marker,
    };
  }

  if (result.verdict === "suspect") {
    if (backup.ok) pinBackup(backup.path);
    await fireMigrationAlert({
      title: "Crow migration guard: suspicious changes (proceeding)",
      body: `A migration on ${dbPath} produced unexplained changes (${summary}). The system proceeded (fail open). Pre-migration backup: ${backup.ok ? backup.path : "NONE (disk)"} — kept pinned for 30 days.`,
    });
  }

  sweepRetention(dbPath);
  return { verdict: result.verdict, backupPath: backup.ok ? backup.path : undefined, report: result.report, initDbExit: r.code };
}

export const _testables = { takeBackup, defaultRunInitDb, QUARANTINE_MAX_ATTEMPTS };
