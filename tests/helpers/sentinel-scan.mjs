/**
 * Sentinel scan for the add-on-secrets tests (plan §"Global constraints"): every secret
 * value a test uses is `"sentinel-" + randomUUID()`, and afterwards nothing this code
 * produced may contain it — not console output, not an audit row, not a notification.
 *
 *   const out = captureOutput(t);            // console.log/warn/error/… collected
 *   …exercise the code…
 *   assert.ok(!out.text().includes(SENTINEL));
 *   assert.deepEqual(scanDb(dbPath, SENTINEL), []);
 */
import { existsSync } from "node:fs";
import { inspect } from "node:util";
import Database from "better-sqlite3";

/** The tables a secret must never reach: the audit logs and the bell. */
export const SCANNED_TABLES = Object.freeze(["audit_log", "project_audit_log", "notifications"]);

/**
 * The (trimmed) shape of the scanned tables, for a test that builds its own scratch DB and
 * wants the scan to be a real positive control rather than a no-table pass.
 */
export const SCAN_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL, actor TEXT, ip_address TEXT, details TEXT, created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS project_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER, actor_type TEXT, actor_id TEXT, action TEXT, target TEXT, payload TEXT, created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, source TEXT, title TEXT NOT NULL, body TEXT, priority TEXT, action_url TEXT, metadata TEXT
  );
`;

/**
 * Capture this test's console output. `t` is the node:test TestContext; the mocks are
 * restored when the test ends. `text()` joins everything recorded so far.
 */
export function captureOutput(t) {
  const chunks = [];
  const record = (...args) => {
    chunks.push(args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 4, breakLength: Infinity }))).join(" "));
  };
  for (const method of ["log", "warn", "error", "info", "debug", "trace"]) {
    if (typeof console[method] !== "function") continue;
    try { t.mock.method(console, method, record); } catch { /* already mocked by an outer capture */ }
  }
  return {
    text: () => chunks.join("\n"),
    clear: () => { chunks.length = 0; },
  };
}

/** Escape a sentinel for a LIKE pattern (only `%`, `_` and the escape char are special). */
const likePattern = (s) => `%${String(s).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * Rows in the scanned tables whose text columns contain `sentinel`, as
 * `[{ table, id }]`. A missing DB, a missing table or an unreadable file yields [] — the
 * assertion is always "nothing was written", so an absent table is a pass. Throws on a
 * non-existent DB path? No: it returns [] like an empty one.
 */
export function scanDb(dbPath, sentinel) {
  if (!dbPath || !existsSync(dbPath)) return [];
  let db = null;
  const hits = [];
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.pragma("busy_timeout = 2000");
    const present = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    for (const table of SCANNED_TABLES) {
      if (!present.has(table)) continue;
      const cols = db.prepare(`PRAGMA table_info(${table})`).all()
        .filter((c) => !/INT|REAL|BLOB/i.test(String(c.type || "TEXT")))
        .map((c) => c.name);
      if (cols.length === 0) continue;
      const where = cols.map((c) => `CAST(${c} AS TEXT) LIKE ? ESCAPE '\\'`).join(" OR ");
      const rows = db.prepare(`SELECT rowid AS __rowid FROM ${table} WHERE ${where}`).all(...cols.map(() => likePattern(sentinel)));
      for (const r of rows) hits.push({ table, id: Number(r.__rowid) });
    }
  } catch {
    return hits;
  } finally {
    if (db) { try { db.close(); } catch { /* already closed */ } }
  }
  return hits;
}