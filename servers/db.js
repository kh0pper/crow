/**
 * Crow Database Client Factory
 *
 * Opens a SQLite file via better-sqlite3 and exposes a libsql-shaped
 * async API so existing callers keep working unchanged. Results carry
 * the {rows, columns, rowsAffected, lastInsertRowid} shape libsql
 * returned.
 *
 * Previously backed by @libsql/client, which had two bugs that made it
 * unsuitable for our workload:
 *   - Silent cross-process stale reads: a client never observed writes
 *     made by a separate process (sqlite3 CLI, other gateway instance)
 *     to the same file. No error thrown, just stale snapshot forever.
 *   - Chronic SQLITE_IOERR on healthy files: reads would begin failing
 *     with "disk I/O error" even when PRAGMA integrity_check = ok.
 *     Closing and reopening the client did not recover.
 *
 * See 2026-04-22 MPA pipeline-runner investigation.
 *
 * Shared by memory server, research server, gateway auth, sharing,
 * orchestrator, scheduler, and init-db. Used by all three gateway
 * instances (primary, MPA, finance) running off this tree.
 */

import Database from "better-sqlite3";
import os from "node:os";
import { existsSync, statSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { isDefaultCrowHome, resolveInstanceDataDir } from "./shared/crow-home.js";
import { currentWriteContext } from "./shared/history/write-context.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Sanitize user input for use in SQLite FTS5 MATCH queries.
 * Strips FTS5 operators and wraps individual terms in double quotes
 * for safe literal matching. Returns null if no valid terms remain.
 *
 * The returned string joins terms with a bare space, which FTS5 parses as
 * an implicit AND — every term must appear in a row for it to match. That's
 * the right default for precise recall, but it means an ordinary
 * multi-word natural-language question (which is mostly function words)
 * can require all of them verbatim in one row and match nothing. See
 * `orFromAndFtsQuery` / `ftsMatchWithOrFallback` below for the fallback.
 */
export function sanitizeFtsQuery(input) {
  if (!input || typeof input !== "string") return null;
  // Remove FTS5 operators and special syntax
  const cleaned = input
    .replace(/\b(AND|OR|NOT|NEAR)\b/gi, "")
    .replace(/[*"(){}[\]^~:]/g, "")
    .trim();
  if (!cleaned) return null;
  // Split into words, quote each for literal matching
  const terms = cleaned
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => `"${w}"`)
    .join(" ");
  return terms || null;
}

/**
 * Convert an AND-form FTS5 MATCH query (as returned by `sanitizeFtsQuery` —
 * quoted terms joined by a bare space, i.e. implicit AND) into the same
 * terms joined with explicit OR. The input is already a sequence of
 * individually double-quoted terms with no embedded spaces, so splitting
 * on the single-space separator and rejoining with " OR " is safe and
 * introduces no new injection surface — every term stays quoted exactly
 * as sanitizeFtsQuery produced it.
 *
 * Returns null for null/empty input. For a single-term query, OR and AND
 * are identical, so the caller can treat that as "no different fallback".
 */
export function orFromAndFtsQuery(safeQuery) {
  if (!safeQuery) return null;
  return safeQuery.split(" ").join(" OR ");
}

/**
 * Run an FTS5 MATCH query built from `sanitizeFtsQuery` (implicit AND
 * across terms). If the strict AND query returns zero rows, retry the
 * identical terms joined with OR before giving up — this is what turns an
 * honest-but-unhelpful empty result for ordinary multi-word prose ("What
 * can you remember for me?") into a ranked broader match, while leaving
 * every precise AND match that already succeeds untouched (the AND query
 * is always tried first and returned as-is whenever it finds anything).
 *
 * Assumes `params[0]` is the FTS MATCH argument produced by
 * sanitizeFtsQuery, and that `sql` contains `ORDER BY rank` so the OR
 * fallback still ranks rows matching more terms first.
 *
 * @param {{execute: (arg: {sql: string, args: any[]}) => Promise<any>}} db
 * @param {string} sql
 * @param {any[]} params
 * @returns {Promise<any[]>} rows
 */
export async function ftsMatchWithOrFallback(db, sql, params) {
  const result = await db.execute({ sql, args: params });
  if (result.rows.length > 0) return result.rows;
  const orQuery = orFromAndFtsQuery(params[0]);
  if (!orQuery || orQuery === params[0]) return result.rows;
  const orResult = await db.execute({ sql, args: [orQuery, ...params.slice(1)] });
  return orResult.rows;
}

/**
 * Escape SQL LIKE wildcard characters in user input.
 * Use with `LIKE ? ESCAPE '\'` in queries.
 */
export function escapeLikePattern(input) {
  if (!input || typeof input !== "string") return input;
  return input
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
}

/**
 * Resolve the Crow data directory path.
 * Priority: CROW_DATA_DIR env → for a non-default CROW_HOME,
 * dirname(CROW_DB_PATH) else <CROW_HOME>/data (queue item 33: never another
 * instance's ~/.crow/data; servers/shared/crow-home.js) → ~/.crow/data/ →
 * ./data/ (fallback)
 */
export function resolveDataDir() {
  if (process.env.CROW_DATA_DIR) {
    return resolve(process.env.CROW_DATA_DIR);
  }
  if (!isDefaultCrowHome(process.env)) {
    return resolveInstanceDataDir(process.env);
  }
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const crowHome = resolve(home, ".crow", "data");
  // Use ~/.crow/data/ if it exists, otherwise fall back to repo-local ./data/
  if (home && existsSync(crowHome)) {
    return crowHome;
  }
  return resolve(__dirname, "../data");
}

/** This instance's crow.db path: CROW_DB_PATH → <resolveDataDir()>/crow.db. */
export function resolveDbPath() {
  return process.env.CROW_DB_PATH ? resolve(process.env.CROW_DB_PATH) : resolve(resolveDataDir(), "crow.db");
}

/**
 * Verify database is accessible and schema is initialized.
 * Throws descriptive errors on failure.
 */
export async function verifyDb(db) {
  try {
    await db.execute("SELECT 1 FROM memories LIMIT 0");
  } catch (err) {
    if (/SQLITE_CANTOPEN|unable to open database/i.test(err.message)) {
      throw new Error("Database not found. Run 'npm run setup' in the crow directory first.");
    } else if (/no such table/i.test(err.message)) {
      throw new Error("Database not initialized. Run 'npm run init-db' first.");
    }
    throw err;
  }
}

/**
 * Log an audit event to the audit_log table.
 * Errors are logged to stderr rather than thrown.
 */
export async function auditLog(db, eventType, { actor, ip, details } = {}) {
  try {
    await db.execute({
      sql: "INSERT INTO audit_log (event_type, actor, ip_address, details) VALUES (?, ?, ?, ?)",
      args: [eventType, actor || null, ip || null, details ? JSON.stringify(details) : null],
    });
  } catch (e) {
    console.error('audit log failed:', e.message);
  }
}

/**
 * Safely add a column to an existing table if it doesn't exist.
 * SQLite doesn't support IF NOT EXISTS for ALTER TABLE ADD COLUMN,
 * so we catch the "duplicate column" error.
 */
const SQL_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SQL_COLTYPE_RE = /^[A-Za-z0-9_() '"-]+$/;

export async function ensureColumn(db, table, column, type) {
  if (!SQL_IDENT_RE.test(table) || !SQL_IDENT_RE.test(column) || !SQL_COLTYPE_RE.test(type)) {
    throw new Error(`ensureColumn: invalid identifier or type (${table}.${column} ${type})`);
  }
  try {
    await db.execute({ sql: `ALTER TABLE ${table} ADD COLUMN ${column} ${type}`, args: [] });
  } catch (err) {
    // Column already exists — safe to ignore
    if (!err.message?.includes("duplicate column")) throw err;
  }
}

/**
 * Normalize the args payload callers pass through libsql-shape APIs.
 * libsql accepts arrays (positional) and objects (named via :foo/@foo/$foo);
 * better-sqlite3 accepts the same via stmt.run(...args) for positional
 * and stmt.run(namedObject) for named.
 */
function spreadArgs(args) {
  if (args == null) return [];
  return Array.isArray(args) ? args : [args];
}

/**
 * Execute a single statement on a better-sqlite3 handle and return a
 * libsql-shaped ResultSet. Reader statements (SELECT, PRAGMA that
 * returns rows, WITH, etc.) go through .all(); others through .run()
 * so we collect changes / lastInsertRowid.
 */
function executeOne(db, sql, rawArgs) {
  const stmt = db.prepare(sql);
  const args = spreadArgs(rawArgs);
  if (stmt.reader) {
    const rows = stmt.all(...args);
    return {
      rows,
      columns: rows.length > 0 ? Object.keys(rows[0]) : [],
      rowsAffected: 0,
      lastInsertRowid: 0,
    };
  }
  const info = stmt.run(...args);
  return {
    rows: [],
    columns: [],
    rowsAffected: info.changes,
    lastInsertRowid: info.lastInsertRowid,
  };
}

/* ------------------------------------------- version-history attribution */

/**
 * The stamp (Task 2 of the version history design): a write made inside a write
 * context (servers/shared/history/write-context.js) attributes the versions its
 * capture triggers just wrote to that context's author.
 *
 * `id > :before AND author_kind = 'unattributed'` is deliberately narrow:
 *   - `id > before` (the max id read at the start of the same transaction) can
 *     only match rows the write itself created, so a concurrent connection's
 *     versions are never touched;
 *   - `author_kind = 'unattributed'` makes attribution happen exactly once, and
 *     is what item_versions' guard trigger allows (covered.js names the same four
 *     columns as the only legal single edit of a version row).
 *
 * item_versions is local-only (never in SYNCED_TABLES) and carries no trigger
 * that emits, so this UPDATE queues no outbound sync event of its own.
 */
const STAMP_SQL = `
  UPDATE item_versions
     SET author_kind = ?, author_id = ?, job_id = ?, origin_instance = ?
   WHERE id > ? AND author_kind = 'unattributed'`;

/**
 * A statement whose first keyword writes and must therefore be stamped. Comments
 * and leading whitespace are skipped. Anything else — transaction control
 * (BEGIN/COMMIT/END/ROLLBACK/SAVEPOINT/RELEASE), PRAGMA, ATTACH/DETACH, VACUUM,
 * ANALYZE, DDL, SELECT — passes straight to executeOne: only a write can have
 * produced the version rows a stamp would attribute, and wrapping a hand-written
 * `BEGIN IMMEDIATE` in another transaction would fail outright.
 */
const STAMPED_KEYWORDS = new Set(["INSERT", "UPDATE", "DELETE", "REPLACE"]);

/** The first bare word of a statement, uppercased; null when there is none. */
const LEADING_KEYWORD_RE = /^(?:(?:--[^\n]*(?:\n|$))|\/\*[\s\S]*?\*\/|\s)*([A-Za-z][A-Za-z0-9_]*)/;

function leadingKeyword(sql) {
  const m = LEADING_KEYWORD_RE.exec(sql);
  return m ? m[1].toUpperCase() : null;
}

/**
 * The bare words of a statement at paren depth 0, in order, with comments and
 * quoted/bracketed text skipped. A CTE body is always inside parentheses, so the
 * only depth-0 words in `WITH …` are the CTE names, their `AS` / `MATERIALIZED`,
 * and the verb of the statement that follows the CTE list.
 */
function topLevelWords(sql) {
  const words = [];
  let depth = 0;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === c) {
          if (sql[j + 1] === c) { j += 2; continue; } // doubled quote is an escape
          break;
        }
        j++;
      }
      i = j;
      continue;
    }
    if (c === "[") {
      const close = sql.indexOf("]", i + 1);
      i = close === -1 ? sql.length : close;
      continue;
    }
    if (c === "(") { depth++; continue; }
    if (c === ")") { if (depth > 0) depth--; continue; }
    if (depth === 0 && /[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < sql.length && /[A-Za-z0-9_$]/.test(sql[j])) j++;
      words.push(sql.slice(i, j).toUpperCase());
      i = j - 1;
    }
  }
  return words;
}

/**
 * The verbs that can START the statement following a `WITH …` CTE list. DML one
 * of the four stamped verbs; SELECT/VALUES do not write. (`RECURSIVE`, a CTE name
 * and `AS [NOT] MATERIALIZED` come before it, and a CTE name can never be one of
 * these: they are reserved words.)
 */
const WITH_MAIN_VERBS = new Set([...STAMPED_KEYWORDS, "SELECT", "VALUES"]);

/**
 * Does a `WITH …` statement WRITE? better-sqlite3 reports
 * `WITH … INSERT … RETURNING` as a reader (its rows come back like a SELECT's),
 * so what counts is the verb after the CTE list, not `stmt.reader`. A CTE body is
 * always parenthesised, so the first depth-0 verb after `WITH` is that verb.
 */
function withStatementWrites(sql) {
  const words = topLevelWords(sql);
  for (let i = 1; i < words.length; i++) {
    if (WITH_MAIN_VERBS.has(words[i])) return STAMPED_KEYWORDS.has(words[i]);
  }
  return false;
}

/**
 * sql → does this statement need a stamp? MODULE-level and keyed by SQL text:
 * whether a statement writes depends only on the SQL and the SQLite build, never
 * on the handle, and a dashboard request re-sends the same statements all day.
 * Bounded LRU (~2000 entries) — a long-lived gateway sees a bounded set of SQL
 * texts, and the oldest entry is dropped rather than the cache growing forever.
 */
const STAMP_VERDICT_CACHE = new Map();
const STAMP_VERDICT_CACHE_MAX = 2000;

function cacheVerdict(sql, verdict) {
  if (STAMP_VERDICT_CACHE.size >= STAMP_VERDICT_CACHE_MAX) {
    const oldest = STAMP_VERDICT_CACHE.keys().next().value;
    if (oldest !== undefined) STAMP_VERDICT_CACHE.delete(oldest);
  }
  STAMP_VERDICT_CACHE.set(sql, verdict);
}

/**
 * Does `sql` write — i.e. can it have produced version rows that need stamping?
 *
 * The leading keyword answers for almost every statement without preparing
 * anything: INSERT/UPDATE/DELETE/REPLACE (RETURNING included — it is still a
 * write) say yes; BEGIN, COMMIT, END, ROLLBACK, SAVEPOINT, RELEASE, PRAGMA,
 * ATTACH, DETACH, VACUUM, ANALYZE, CREATE/DROP/ALTER and SELECT say no. Only a
 * `WITH …` needs the prepared statement's reader flag, and only when the verb
 * after its CTE list is not itself DML.
 */
function needsStamp(db, sql) {
  const keyword = leadingKeyword(sql);
  if (keyword === null) return false;
  if (STAMPED_KEYWORDS.has(keyword)) return true;
  if (keyword !== "WITH") return false;
  const cached = STAMP_VERDICT_CACHE.get(sql);
  if (cached !== undefined) {
    // Refresh recency (a Map iterates in insertion order).
    STAMP_VERDICT_CACHE.delete(sql);
    STAMP_VERDICT_CACHE.set(sql, cached);
    return cached;
  }
  let verdict;
  try {
    verdict = withStatementWrites(sql) || db.prepare(sql).reader !== true;
  } catch {
    // Never cache a failure: let executeOne raise the real error.
    return false;
  }
  cacheVerdict(sql, verdict);
  return verdict;
}

/**
 * Per-path keeper handles. SQLite in WAL mode unlinks the -wal/-shm files
 * when the last active connection to a file closes. The gateway has many
 * transient createDbClient() open/close cycles (startup migrations, the
 * per-minute loadRemoteInstances probe, etc.) and if any of them happens
 * to be the last active connection at close time, the unlink orphans the
 * FDs held by peer modules, which then fail reads with
 * "disk I/O error" (SQLite surfacing EBADF on the unlinked inode).
 *
 * Holding one never-closed keeper per DB path guarantees there's always
 * another reader registered in the WAL index, so close() on transient
 * clients can't drop the count to zero.
 *
 * Keeper registration is result-read-based: ensureKeeper registers ONLY when
 * the post-attempt mode read shows 'wal'. Non-WAL DBs don't get a keeper (no
 * fd waste; removes the deleted-wal-fd hazard for DELETE-mode hosts).
 */


const VALID_JOURNAL_MODES = new Set(["WAL", "DELETE", "TRUNCATE", "PERSIST", "MEMORY", "OFF"]);

/**
 * Module-level totalmem probe. Injectable for tests:
 *   set CROW_TEST_TOTALMEM=<bytes> env before importing, OR
 *   assign db._setTotalmemFn(fn) in tests (see export below).
 */
let _totalmemFn = os.totalmem;
export function _setTotalmemFn(fn) { _totalmemFn = fn; }

// Dedup-log sets: one warn per (filePath, requestedMode) per process.
const _modeWarnedPaths = new Set(); // dedup keys: "path::mode" or "path::keeper-skip"
const _failedFlipPaths = new Set(); // "path::mode" — skip flip on repeat attempts

// Dedup-log set for auto-SELECT decision (logged once per process).
let _autoSelectLogged = false;

/**
 * Resolve the journal mode to request.
 *
 * Priority:
 *   1. CROW_JOURNAL_MODE env (explicit override — always wins).
 *   2. Low-RAM auto-select: totalmem ≤ CROW_WAL_MIN_RAM_GB → "DELETE".
 *   3. Default: "WAL".
 *
 * CROW_TEST_TOTALMEM env overrides totalmem() for test isolation (set before
 * import, or use _setTotalmemFn() for in-process injection).
 */
export function resolveJournalMode() {
  if (process.env.CROW_JOURNAL_MODE) {
    const raw = process.env.CROW_JOURNAL_MODE.toUpperCase();
    return VALID_JOURNAL_MODES.has(raw) ? raw : "WAL";
  }

  // Low-RAM auto-select: ≤ CROW_WAL_MIN_RAM_GB GiB → DELETE.
  // A nominal-2GB host reports slightly under 2 GiB; <= catches it.
  const minRamGb = parseFloat(process.env.CROW_WAL_MIN_RAM_GB || "2");
  const totalMem = process.env.CROW_TEST_TOTALMEM
    ? parseInt(process.env.CROW_TEST_TOTALMEM, 10)
    : _totalmemFn();
  const totalGb = totalMem / (1024 ** 3);

  if (totalGb <= minRamGb) {
    if (!_autoSelectLogged) {
      _autoSelectLogged = true;
      console.warn(
        `[db] Low-RAM host (${totalGb.toFixed(2)} GiB ≤ ${minRamGb} GiB threshold) — ` +
        `auto-selecting journal_mode=DELETE. Set CROW_JOURNAL_MODE=WAL to override.`
      );
    }
    return "DELETE";
  }

  return "WAL";
}

export const _dbKeepers = new Map();

/* ------------------------------------------------------- WAL tripwire */

/**
 * WAL-generation tripwire. While this process holds live connections, the
 * -wal file's inode must NEVER change: SQLite only replaces it via
 * unlink+recreate, which orphans every already-attached connection (they
 * keep writing through the old, deleted generation — no mutual exclusion
 * with the new one → torn multi-page commits → "database disk image is
 * malformed"). That is exactly the 2026-08-04 corruption mechanism (a
 * second in-process SQLite build, @libsql via panel routes, unlinked the
 * live WAL: POSIX locks never conflict within one PID, so its last-closer
 * check "won" against our own connections).
 *
 * The tripwire stats the -wal path on an interval and screams into the
 * journal on an inode change, turning the next silent generation split
 * into a diagnosable event within seconds instead of a corrupt DB an hour
 * later. Detection only — no automatic restart.
 *
 * CROW_WAL_TRIPWIRE_MS overrides the interval (default 30000; 0 disables).
 */
export const _walTripwires = new Map(); // filePath → {baselineIno, trips, timer}

export function checkWalCoherence(filePath) {
  const tw = _walTripwires.get(filePath);
  if (!tw) return { armed: false };
  let currentIno = null;
  try { currentIno = statSync(filePath + "-wal").ino; } catch { /* missing */ }
  if (tw.baselineIno === null && currentIno !== null) {
    // WAL appeared after arming (first real write) — adopt it as baseline.
    tw.baselineIno = currentIno;
  }
  const ok = tw.baselineIno === null || currentIno === tw.baselineIno;
  return { armed: true, ok, baselineIno: tw.baselineIno, currentIno };
}

function armWalTripwire(filePath) {
  if (_walTripwires.has(filePath)) return;
  const intervalMs = Number(process.env.CROW_WAL_TRIPWIRE_MS ?? 30000);
  if (!intervalMs) return;
  let baselineIno = null;
  try { baselineIno = statSync(filePath + "-wal").ino; } catch { /* not yet */ }
  const tw = { baselineIno, trips: 0, timer: null };
  _walTripwires.set(filePath, tw);
  tw.timer = setInterval(() => {
    const res = checkWalCoherence(filePath);
    if (res.armed && !res.ok) {
      tw.trips += 1;
      console.error(
        `[db] WAL GENERATION SPLIT DETECTED for ${filePath}: -wal inode changed ` +
        `${res.baselineIno} -> ${res.currentIno ?? "(missing)"} while this process holds ` +
        `connections. Connections in this process may now write through a dead WAL and ` +
        `CORRUPT the database. Restart this service and find the unlinker ` +
        `(strace -f -e unlink,unlinkat). See servers/db.js WAL tripwire notes.`
      );
      tw.baselineIno = res.currentIno; // re-baseline so a further split logs again
    }
  }, intervalMs);
  tw.timer.unref?.();
}

/**
 * Ensure a WAL-mode keeper handle exists for filePath.
 *
 * Registration is RESULT-READ-BASED: we register the keeper only when the
 * DB is actually in WAL mode. On non-WAL DBs: close and don't register
 * (saves the fd; removes the deleted-wal-fd hazard on DELETE-mode hosts).
 *
 * Must be called AFTER the client's own pragma resolution in createDbClient
 * so the read reflects the mode the client actually ended up in.
 *
 * @param {string} filePath - Absolute path to the SQLite file.
 * @param {string} requestedMode - The mode that was requested (for context).
 */
function ensureKeeper(filePath, requestedMode) {
  if (_dbKeepers.has(filePath)) return;
  const keeper = new Database(filePath);
  const actualMode = (() => {
    try { return keeper.pragma("journal_mode", { simple: true }); } catch { return null; }
  })();
  if (typeof actualMode === "string" && actualMode.toLowerCase() === "wal") {
    try { keeper.pragma("busy_timeout = 30000"); } catch {}
    _dbKeepers.set(filePath, keeper);
    armWalTripwire(filePath);
  } else {
    // Non-WAL or unreadable — close without registering.
    try { keeper.close(); } catch {}
    const warnKey = `${filePath}::keeper-skip`;
    if (!_modeWarnedPaths.has(warnKey)) {
      _modeWarnedPaths.add(warnKey);
      console.warn(
        `[db] keeper-skip for ${filePath}: mode is '${actualMode}' (requested '${requestedMode}') — no WAL keeper registered`
      );
    }
  }
}

/**
 * Create a database client for the given (or inferred) SQLite file.
 * The returned object mirrors @libsql/client's surface (async .execute,
 * .batch, .executeMultiple, .close) so existing call sites don't have
 * to change.
 *
 * The async signatures are retained; the underlying work is synchronous
 * because better-sqlite3 is synchronous, but promise-returning keeps
 * callers that use await correct.
 *
 * Journal mode handling (read-first, deduped, non-fatal):
 *   1. READ the current mode (lock-free, no SQLITE_BUSY risk).
 *   2. Skip the flip if already at the requested mode.
 *   3. Attempt the flip only when modes differ AND no prior failed attempt
 *      for this (path, mode) pair in this process (failed-attempt memo prevents
 *      repeat 5s event-loop stalls on a locked DB during a boot storm).
 *   4. On throw OR post-flip mismatch: dedup-log once per (path, requestedMode)
 *      and continue — accept the current mode rather than crashing.
 *   5. busy_timeout 30000 explicit set stays (unchanged from prior behavior).
 */
export function createDbClient(dbPath) {
  const filePath = dbPath || process.env.CROW_DB_PATH || resolve(resolveDataDir(), "crow.db");

  const db = new Database(filePath);
  const requestedMode = resolveJournalMode();

  // Read-first: lock-free, no SQLITE_BUSY risk.
  let currentMode = null;
  try {
    currentMode = db.pragma("journal_mode", { simple: true });
  } catch {
    // Unreadable — proceed to attempt flip anyway.
  }

  const modeKey = `${filePath}::${requestedMode}`;
  const needsFlip = typeof currentMode === "string"
    ? currentMode.toLowerCase() !== requestedMode.toLowerCase()
    : true; // unreadable current mode → attempt flip

  if (needsFlip && !_failedFlipPaths.has(modeKey)) {
    try {
      db.pragma(`journal_mode = ${requestedMode}`);
      // Re-read to confirm.
      const resultMode = db.pragma("journal_mode", { simple: true });
      if (typeof resultMode === "string" && resultMode.toLowerCase() !== requestedMode.toLowerCase()) {
        // Mode mismatch after flip (DB declined — common when another writer holds it).
        if (!_modeWarnedPaths.has(modeKey)) {
          _modeWarnedPaths.add(modeKey);
          console.warn(
            `[db] journal_mode flip to '${requestedMode}' declined for ${filePath} — ` +
            `DB is in '${resultMode}' mode. Continuing with current mode.`
          );
        }
        _failedFlipPaths.add(modeKey);
      }
    } catch (err) {
      // SQLITE_BUSY or other error — re-read actual mode and dedup-log.
      let actualMode = null;
      try { actualMode = db.pragma("journal_mode", { simple: true }); } catch {}
      if (!_modeWarnedPaths.has(modeKey)) {
        _modeWarnedPaths.add(modeKey);
        console.warn(
          `[db] journal_mode flip to '${requestedMode}' failed for ${filePath} ` +
          `(${err.message}) — DB is in '${actualMode}' mode. Continuing with current mode.`
        );
      }
      _failedFlipPaths.add(modeKey); // don't retry; prevents repeat 5s event-loop stalls
    }
  }

  try {
    db.pragma("busy_timeout = 30000");
  } catch (err) {
    console.warn("[db] Failed to set busy_timeout:", err.message);
  }

  // ensureKeeper AFTER pragma resolution (spec requirement: C4/keeper hygiene).
  // Registers keeper only when the DB is actually in WAL mode.
  ensureKeeper(filePath, requestedMode);

  /* -- attribution state, per handle ------------------------------------- */

  // Does this store have the history tables yet? Cached per handle (an instance
  // that has run the migration never re-checks). A "no" IS re-checked, but only
  // after a minute: a long-lived client outlives the migration that adds the
  // table and must notice it, yet must not query sqlite_master on every write.
  // item_versions_erase is required too — the append-only guard trigger's WHEN
  // clause reads it, so a stamp on a store that lost it would fail the write.
  let itemVersionsPresent = null;
  let itemVersionsMissingUntil = 0; // epoch ms; a cached "no" expires here
  const VERSIONS_TABLES = ["item_versions", "item_versions_erase"];
  const VERSIONS_RECHECK_MS = 60_000;
  let maxIdStmt = null;
  let stampStmt = null;
  let stampingTxn = null;

  function hasItemVersions(now = Date.now()) {
    if (itemVersionsPresent === true) return true;
    if (itemVersionsPresent === false && now < itemVersionsMissingUntil) return false;
    try {
      const rows = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${VERSIONS_TABLES.map(() => "?").join(", ")})`,
        )
        .all(...VERSIONS_TABLES);
      itemVersionsPresent = rows.length === VERSIONS_TABLES.length;
    } catch {
      itemVersionsPresent = false;
    }
    itemVersionsMissingUntil = itemVersionsPresent ? 0 : now + VERSIONS_RECHECK_MS;
    return itemVersionsPresent === true;
  }

  /** The newest item_versions id, or 0 — the watermark a stamp may not cross. */
  function maxVersionId() {
    maxIdStmt ||= db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM item_versions");
    return Number(maxIdStmt.get().id);
  }

  /**
   * Attribute the versions written since `before` to `ctx`. A write that wrote no
   * version row (an uncovered table, a no-op UPDATE) moves no id, so there is
   * nothing to stamp and no UPDATE is run at all.
   */
  function stampFrom(ctx, before) {
    if (maxVersionId() <= before) return;
    stampStmt ||= db.prepare(STAMP_SQL);
    stampStmt.run(ctx.authorKind, ctx.authorId, ctx.jobId, ctx.originInstance, before);
  }

  /**
   * Run `work` and stamp what it wrote.
   *
   * Outside a transaction the max-id read, the write and the attribution are ONE
   * immediate transaction (BEGIN IMMEDIATE): they are atomic, so two writers
   * cannot interleave a stamp onto each other's rows — and a throw from `work`
   * rolls back everything, including any version the triggers wrote, so nothing is
   * stamped after a failed write.
   *
   * When the caller ALREADY holds a transaction — the hand-written
   * `BEGIN IMMEDIATE … COMMIT` in project-lifecycle, model-roles-store and the c2c
   * outbox — the stamp runs INLINE inside it: opening another transaction would
   * fail ("cannot start a transaction within a transaction") and a savepoint would
   * be a second, redundant mechanism for the same thing. The stamp shares that
   * transaction's fate, so a caller's ROLLBACK un-stamps with everything else.
   *
   * The inline branch reads its watermark inside the caller's transaction: with a
   * `BEGIN IMMEDIATE` (what every hand-written caller uses) that read is stable,
   * because the write lock is already held.
   */
  function runStamped(work, ctx) {
    if (db.inTransaction) {
      const before = maxVersionId();
      const result = work();
      stampFrom(ctx, before);
      return result;
    }
    stampingTxn ||= db.transaction((job) => {
      const before = maxVersionId();
      const result = job.work(); // throws → the whole transaction rolls back
      stampFrom(job.ctx, before);
      return result;
    });
    return stampingTxn.immediate({ work, ctx });
  }

  const sqlOf = (s) => (typeof s === "string" ? s : s.sql);
  const argsOf = (s) => (typeof s === "string" ? [] : s.args);

  return {
    async execute(arg) {
      const sql = sqlOf(arg);
      const ctx = currentWriteContext();
      // No context (or no SQL text): exactly as before.
      if (!ctx || typeof sql !== "string") return executeOne(db, sql, argsOf(arg));
      // A read, a PRAGMA, DDL or transaction control passes straight through: only
      // a write can have produced the version rows a stamp would attribute.
      if (!needsStamp(db, sql) || !hasItemVersions()) return executeOne(db, sql, argsOf(arg));
      return runStamped(() => executeOne(db, sql, argsOf(arg)), ctx);
    },
    async batch(statements) {
      // Wrap in a single transaction so all statements commit atomically,
      // matching libsql's batch() semantics.
      const txn = db.transaction((stmts) => stmts.map((s) => executeOne(db, sqlOf(s), argsOf(s))));
      const ctx = currentWriteContext();
      // No context: the old path exactly, with no reader-ness work at all.
      if (!ctx || !hasItemVersions()) return txn(statements);
      // A batch of pure reads keeps the old shape. Otherwise the batch AND the
      // stamp are one immediate transaction: the batch keeps its all-or-nothing
      // rollback, and a failed statement never leaves a stamp behind for rows that
      // were never written.
      if (!statements.some((s) => needsStamp(db, sqlOf(s)))) return txn(statements);
      // The statements run inline rather than through `txn`, so this is ONE
      // transaction (no nested savepoint): the same all-or-nothing contract.
      // Nested db.transaction: a SAVEPOINT when the caller already holds a
      // transaction, so a failed statement still undoes the batch's earlier ones.
      const batchTxn = db.transaction(() => statements.map((s) => executeOne(db, sqlOf(s), argsOf(s))));
      return runStamped(() => batchTxn(), ctx);
    },
    async executeMultiple(sql) {
      // DDL and bulk bootstrap only (schema, indexes, keychain tables) — never a
      // write to covered content, so version attribution does not apply here.
      db.exec(sql);
      return [];
    },
    close() {
      try { db.close(); } catch {}
    },
  };
}

/**
 * Perform an online backup of a crow.db file to destPath using the keeper
 * handle's better-sqlite3 `.backup()`. Runs the SQLite online backup API
 * from inside the gateway process so no external process ever opens the
 * DB file directly — which would, under WAL mode, orphan the gateway's
 * -wal/-shm FDs on close.
 *
 * Returns { totalPages, remainingPages } from better-sqlite3, so callers
 * can confirm completion.
 *
 * C5 fallback: if no keeper is registered (e.g. DELETE-mode host where
 * ensureKeeper skipped registration), open a transient handle, run the
 * backup, then close it. This is safe on DELETE-mode DBs (the never-open-
 * externally hazard in WAL mode doesn't apply to DELETE/TRUNCATE/PERSIST).
 */
export async function performBackup(dbPath, destPath) {
  const filePath = dbPath || process.env.CROW_DB_PATH || resolve(resolveDataDir(), "crow.db");
  const keeper = _dbKeepers.get(filePath);
  if (keeper) {
    return keeper.backup(destPath);
  }
  // C5: transient-handle fallback for non-WAL hosts.
  const transient = new Database(filePath);
  try {
    return await transient.backup(destPath);
  } finally {
    try { transient.close(); } catch {}
  }
}
