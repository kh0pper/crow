/**
 * SQLite dataset backends — the one place that decides which files a
 * `sqlite` data backend may open, and how.
 *
 * A dataset is a user's own SQLite file, never one of Crow's databases:
 *   - It must live under the instance data dir, in `datasets/` (files the
 *     operator imports) or `projects/<id>/databases/` (files the Data
 *     Dashboard created). The check is on the realpath, segment by segment —
 *     never a string prefix, so `data-evil/` is not inside `data/`.
 *   - It must not BE a core database: crow.db, tasks.db, CROW_DB_PATH, or any
 *     *.db directly in the data dir. Compared by realpath AND by device+inode,
 *     so a symlink or a hard link to crow.db placed under datasets/ is refused.
 *
 * Read paths open the file read-only (better-sqlite3 `readonly`, plus
 * `PRAGMA query_only`), so SQLite itself guarantees nothing is written —
 * including PRAGMA assignments and `WITH … DELETE`. On top of that:
 * `prepare()` refuses more than one statement, the statement must be
 * read-only by SQLite's own account (`stmt.readonly`) and return rows, and a
 * first-keyword allowlist stays as defence in depth. The row cap is enforced
 * by stepping the statement, never by editing the SQL text.
 *
 * Limit: better-sqlite3 runs a statement synchronously and cannot be
 * interrupted, so a pathological query (a huge cross join with an aggregate)
 * can still hold the process for its duration. The row cap bounds output,
 * not CPU time.
 */
import { closeSync, constants as fsConstants, existsSync, fstatSync, mkdirSync, openSync, realpathSync, statSync, readdirSync } from "node:fs";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import Database from "better-sqlite3";
import { resolveDataDir } from "../db.js";

export const DEFAULT_MAX_ROWS = 5000;
/** Result size cap (serialized rows). */
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
/** Wall-clock cap for one dataset query run off-thread. */
export const DEFAULT_TIMEOUT_MS = 10_000;
/** Dataset query processes alive at once. */
export const MAX_QUERY_WORKERS = 4;
const READ_KEYWORDS = new Set(["SELECT", "WITH", "EXPLAIN", "PRAGMA", "VALUES"]);

/** The instance data dir (CROW_DATA_DIR, else ~/.crow/data). */
export function dataDir() {
  return resolveDataDir();
}

/** Directory for databases the Data Dashboard creates for a project. */
export function managedDatabasesDir(projectId) {
  return join(dataDir(), "projects", String(projectId), "databases");
}

function real(p) {
  try { return realpathSync(p); } catch { return null; }
}

/** Every core database we can name, as {real, dev, ino}. */
function coreDatabases(dir) {
  const names = new Set();
  const add = (p) => { if (p) names.add(resolve(p)); };
  add(process.env.CROW_DB_PATH);
  add(join(dir, "crow.db"));
  add(join(dir, "tasks.db"));
  try {
    for (const f of readdirSync(dir)) if (f.endsWith(".db")) add(join(dir, f));
  } catch {}
  const out = [];
  for (const p of names) {
    const r = real(p);
    if (!r) continue;
    try {
      const st = statSync(r);
      out.push({ real: r, dev: st.dev, ino: st.ino });
    } catch {}
  }
  return out;
}

/** Path segments of `child` below `parent`, or null when not strictly inside. */
function segmentsBelow(parent, child) {
  const rel = relative(parent, child);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  const segs = rel.split(sep);
  if (segs.some((s) => s === ".." || s === "")) return null;
  return segs;
}

/**
 * Decide whether `p` may be opened as a dataset.
 * @param {string} p
 * @param {{ managedOnly?: boolean }} [opts] managedOnly: only
 *   projects/<id>/databases/ (files the bundle created) — for writers.
 * @returns {{ ok: true, path: string } | { ok: false, reason: string }}
 */
export function resolveDatasetPath(p, opts = {}) {
  if (typeof p !== "string" || !p || !isAbsolute(p)) return { ok: false, reason: "dataset path must be absolute" };
  const dir = real(dataDir());
  if (!dir) return { ok: false, reason: "the data directory does not exist" };
  const r = real(p);
  if (!r) return { ok: false, reason: "dataset file not found" };
  let st;
  try { st = statSync(r); } catch { return { ok: false, reason: "dataset file not found" }; }
  if (!st.isFile()) return { ok: false, reason: "dataset path is not a file" };

  for (const c of coreDatabases(dir)) {
    if (c.real === r || (c.dev === st.dev && c.ino === st.ino)) {
      return { ok: false, reason: "that is one of Crow's own databases, not a dataset" };
    }
  }

  const segs = segmentsBelow(dir, r);
  const inDatasets = !opts.managedOnly && segs && segs[0] === "datasets" && segs.length >= 2;
  const inManaged = segs && segs[0] === "projects" && segs[2] === "databases" && segs.length >= 4;
  if (!inDatasets && !inManaged) {
    return {
      ok: false,
      reason: opts.managedOnly
        ? "only databases the Data Dashboard created (projects/<id>/databases/) can be written"
        : "datasets must live in the data directory's datasets/ or projects/<id>/databases/ folder",
    };
  }
  return { ok: true, path: r };
}

function assertDataset(p, opts) {
  const res = resolveDatasetPath(p, opts);
  if (!res.ok) throw new Error(res.reason);
  return res.path;
}

/**
 * Open a dataset read-only. Caller closes.
 *
 * The checked real path is held open with O_NOFOLLOW while SQLite opens it,
 * and afterwards the path must still resolve to itself and to the same
 * inode, so a symlink swapped in between the check and the open is caught
 * (SQLite opens by name; it takes no fd). Residual window: a swap-and-restore
 * that completes entirely inside SQLite's open, which needs write access to
 * the datasets folder and still yields only a read-only connection.
 */
export function openDatasetReadOnly(p) {
  const path = assertDataset(p);
  let fd;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch {
    throw new Error("dataset file could not be opened safely");
  }
  try {
    const held = fstatSync(fd);
    if (!held.isFile()) throw new Error("dataset path is not a file");
    const db = new Database(path, { readonly: true, fileMustExist: true });
    let after;
    try { after = { real: realpathSync(path), st: statSync(path) }; } catch { after = null; }
    if (!after || after.real !== path || after.st.ino !== held.ino || after.st.dev !== held.dev) {
      db.close();
      throw new Error("dataset file changed while it was being opened");
    }
    db.pragma("query_only = ON");
    return db;
  } finally {
    closeSync(fd);
  }
}

/** Open a bundle-created database for a fixed-shape writer. Caller closes. */
export function openManagedDatasetWritable(p) {
  const path = assertDataset(p, { managedOnly: true });
  const db = new Database(path, { fileMustExist: true });
  db.pragma("busy_timeout = 10000");
  return db;
}

function firstKeyword(sql) {
  const s = String(sql || "")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .trim();
  return (s.match(/^[A-Za-z]+/) || [""])[0].toUpperCase();
}

/**
 * Run one read-only statement on a dataset.
 * @returns {{ columns: string[], rows: object[], rowCount: number, truncated: boolean, executionMs: number }}
 */
export function runReadOnlyQuery(p, sql, { maxRows = DEFAULT_MAX_ROWS, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!READ_KEYWORDS.has(firstKeyword(sql))) {
    throw new Error("Only read-only queries (SELECT, WITH, EXPLAIN, PRAGMA, VALUES) are allowed.");
  }
  const { maxRows: cap, maxBytes: byteCap } = effectiveLimits({ maxRows, maxBytes });
  const db = openDatasetReadOnly(p);
  const start = Date.now();
  try {
    let stmt;
    try {
      stmt = db.prepare(String(sql));
    } catch (err) {
      if (/more than one statement/i.test(err.message)) throw new Error("Only one statement per query.");
      throw err;
    }
    if (!stmt.readonly) throw new Error("That statement would change the database; only read-only queries are allowed.");
    if (!stmt.reader) throw new Error("That statement returns no rows.");
    const columns = stmt.columns().map((c) => c.name);
    const rows = [];
    let truncated = false;
    let bytes = 0;
    for (const row of stmt.iterate()) {
      if (rows.length >= cap) { truncated = true; break; }
      bytes += Buffer.byteLength(JSON.stringify(row) || "", "utf8");
      if (bytes > byteCap) { truncated = true; break; }
      rows.push(row);
    }
    return { columns, rows, rowCount: rows.length, truncated, executionMs: Date.now() - start };
  } finally {
    db.close();
  }
}

const quoteIdent = (name) => `"${String(name).replace(/"/g, '""')}"`;

/** Tables, columns, row counts and indexes, on a read-only connection. */
export function readDatasetSchema(p) {
  const db = openDatasetReadOnly(p);
  try {
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    return {
      tables: names.map(({ name }) => ({
        name,
        columns: db.prepare(`PRAGMA table_info(${quoteIdent(name)})`).all().map((c) => ({
          name: c.name, type: c.type, notnull: !!c.notnull, pk: !!c.pk, default_value: c.dflt_value,
        })),
        rowCount: db.prepare(`SELECT COUNT(*) AS c FROM ${quoteIdent(name)}`).get().c,
        indexes: db.prepare(`PRAGMA index_list(${quoteIdent(name)})`).all().map((i) => i.name),
      })),
    };
  } finally {
    db.close();
  }
}

export { quoteIdent };

/**
 * Create an empty database for a project in its managed folder.
 * @returns {string} the new file's path
 */
export function createManagedDatabase(projectId, name) {
  if (!/^[0-9]+$/.test(String(projectId))) throw new Error("project id must be a number");
  const safe = String(name).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120) || "database";
  const dir = managedDatabasesDir(projectId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${safe}.db`);
  if (existsSync(path)) throw new Error(`Database already exists: ${path}`);
  new Database(path).close();
  return path;
}

// ----------------------------------------------------------- off-process

/**
 * Caller-supplied limits can only LOWER the caps, never raise them: rows
 * ≤ DEFAULT_MAX_ROWS, bytes ≤ DEFAULT_MAX_BYTES (counted per row, serialized,
 * before the row is kept — one huge value ends the read with that row
 * dropped), time ≤ DEFAULT_TIMEOUT_MS.
 */
export function effectiveLimits({ maxRows, maxBytes, timeoutMs } = {}) {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : hi, hi));
  return {
    maxRows: Math.floor(clamp(maxRows, 1, DEFAULT_MAX_ROWS)),
    maxBytes: Math.floor(clamp(maxBytes, 1024, DEFAULT_MAX_BYTES)),
    timeoutMs: Math.floor(clamp(timeoutMs, 100, DEFAULT_TIMEOUT_MS)),
  };
}

/** SQLite's own heap ceiling inside the query process (PRAGMA hard_heap_limit). */
export const CHILD_SQLITE_HEAP_BYTES = 128 * 1024 * 1024;

const CHILD_PATH = fileURLToPath(new URL("./sqlite-dataset-child.js", import.meta.url));
let liveQueries = 0;

/**
 * Run one job ({ op: "query" | "schema", ... }) in a short-lived child
 * process with a wall-clock limit, so a heavy query (the public blog chart
 * endpoint reaches this) never blocks the gateway and never outlives its
 * limit: at the limit the child is SIGKILLed (a worker thread cannot be
 * stopped inside a long SQLite step). The child caps its V8 heap and
 * SQLite's heap, so one huge value fails inside the child. At most
 * MAX_QUERY_WORKERS run at once; beyond that a job is refused as busy.
 */
function runInChild(job, timeoutMs) {
  if (liveQueries >= MAX_QUERY_WORKERS) {
    return Promise.reject(new Error("Too many dataset queries are running; try again shortly."));
  }
  const limit = effectiveLimits({ timeoutMs }).timeoutMs;
  return new Promise((resolveP, rejectP) => {
    let settled = false;
    let timer = null;
    const finish = (fn, v) => { if (!settled) { settled = true; if (timer) clearTimeout(timer); fn(v); } };
    const env = { CROW_DATA_DIR: dataDir(), PATH: process.env.PATH || "", CROW_DATASET_CHILD_HEAP: String(CHILD_SQLITE_HEAP_BYTES) };
    if (process.env.CROW_DB_PATH) env.CROW_DB_PATH = process.env.CROW_DB_PATH;
    let child;
    try {
      child = fork(CHILD_PATH, [], { env, execArgv: ["--max-old-space-size=256"], stdio: ["ignore", "ignore", "pipe", "ipc"] });
    } catch (err) {
      rejectP(err);
      return;
    }
    liveQueries++;
    child.stderr.resume();
    timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      finish(rejectP, new Error(`Query timed out (${Math.round(limit / 1000)}s limit)`));
    }, limit);
    child.once("message", (m) => {
      if (m && m.ok) finish(resolveP, m.result);
      else finish(rejectP, new Error((m && m.error) || "query failed"));
      // A child that answered but lingers is not left running.
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2000).unref();
    });
    child.once("error", (err) => finish(rejectP, err));
    child.once("exit", () => {
      liveQueries--;
      finish(rejectP, new Error("query process stopped"));
    });
    try { child.send(job); } catch (err) { try { child.kill("SIGKILL"); } catch {} finish(rejectP, err); }
  });
}

/** runReadOnlyQuery off-process; see runInChild. */
export function runReadOnlyQueryAsync(p, sql, opts = {}) {
  const { maxRows, maxBytes, timeoutMs } = effectiveLimits(opts);
  return runInChild({ op: "query", path: p, sql: String(sql), maxRows, maxBytes }, timeoutMs);
}

/** readDatasetSchema off-process (COUNT(*) on a large table can be slow). */
export function readDatasetSchemaAsync(p, { timeoutMs } = {}) {
  return runInChild({ op: "schema", path: p }, timeoutMs);
}
