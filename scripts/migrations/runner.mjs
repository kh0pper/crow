// scripts/migrations/runner.mjs
//
// Ordered, idempotent, per-instance migration registry.
//
// Co-hosted gateways share one checkout but have their own data dirs, so each
// runs this registry against its OWN stores with its own env-resolved paths.
// It covers changes that carry no SCHEMA_GENERATION bump — additive columns,
// and non-crow.db stores like tasks.db — which the boot schema guard in
// servers/gateway/index.js deliberately does not.
//
// Bookkeeping lives in `schema_migrations` inside the instance's crow.db and is
// created lazily HERE, deliberately NOT in scripts/init-db.js. Adding a table
// there would bump SCHEMA_GENERATION, which re-runs all of init-db's DROP TABLE
// statements against every live instance DB — a rail this change has no reason
// to ride.
//
// Migrations must ALSO be safe to run with their record missing: a database
// restored from backup can lose the row while keeping the schema change. So
// every migration body stays shape-checked and idempotent in its own right, and
// the record is an optimization, not the contract.
//
// Deferrals get bookkeeping of their own (`schema_migrations_deferred`, also
// lazy, also HERE): a migration whose target tables never appear — 0001-0004 on
// a paired instance with no board — defers on EVERY boot, and three log lines
// per boot hid the one deferral that was new. The row remembers the reason so a
// repeated deferral stays quiet while a different one is still reported.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

const FILENAME = /^\d{4}-[a-z0-9-]+\.mjs$/;

/** Sorted absolute paths of every valid migration module in `dir`. */
export function discoverMigrations(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return []; // no registry directory yet is not an error
  }
  return names.filter((n) => FILENAME.test(n)).sort().map((n) => join(dir, n));
}

function open(p) {
  const d = new Database(p);
  d.pragma("busy_timeout = 10000");
  return d;
}

// A migration that returns no reason defers for the reason the registry was
// built around: its target tables do not exist yet.
export const DEFAULT_DEFERRAL_REASON = "target tables absent";

function ensureTables(db) {
  db.prepare(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       id TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL,
       sha TEXT
     )`,
  ).run();
  // first_deferred_at is the start of the CURRENT wait: a changed reason is a
  // new deferral, so it resets (see the upsert in runMigrations).
  db.prepare(
    `CREATE TABLE IF NOT EXISTS schema_migrations_deferred (
       id TEXT PRIMARY KEY,
       reason TEXT NOT NULL,
       first_deferred_at TEXT NOT NULL,
       last_checked_at TEXT NOT NULL
     )`,
  ).run();
}

/**
 * Run every not-yet-applied migration, in order, against ONE instance's stores.
 * Throws on the first failure without recording it — the caller decides whether
 * that is fatal.
 *
 * A migration returning `{ deferred: true }` is NOT recorded. Its target tables
 * did not exist yet: bundle-owned stores are created by their bundle, which
 * starts after the gateway boots, and better-sqlite3 creates an empty DB file on
 * open — so "absent" is the normal fresh-install state, not an error. Recording
 * a deferral as applied would reproduce the bug this registry exists to fix: the
 * table gets created later WITHOUT the new columns, and the migration never
 * retries because its id is already on file.
 *
 * A deferral may carry a short stable `reason` (e.g. "tasks_items absent"). It
 * is remembered in `schema_migrations_deferred`: the first time (and whenever
 * the reason changes) it is logged, on every later boot with the SAME reason it
 * is only re-stamped, because a permanent deferral repeating itself forever is
 * noise that hides a new one.
 *
 * @returns {Promise<{applied: string[], skipped: string[], deferred: string[], newlyDeferred: string[]}>}
 *   `deferred` is every deferral this run; `newlyDeferred` only the ones whose
 *   bookkeeping row was missing or whose reason changed.
 */
export async function runMigrations({
  migrationsDir,
  dbPath,
  tasksDbPath,
  sha = null,
  log = () => {},
  now = () => new Date().toISOString(),
}) {
  const applied = [];
  const skipped = [];
  const deferred = [];
  const newlyDeferred = [];

  const book = open(dbPath);
  try {
    ensureTables(book);
    const done = new Set(book.prepare("SELECT id FROM schema_migrations").all().map((r) => r.id));
    const deferrals = new Map(
      book.prepare("SELECT id, reason, first_deferred_at FROM schema_migrations_deferred").all()
        .map((r) => [r.id, r]),
    );

    for (const file of discoverMigrations(migrationsDir)) {
      const mod = await import(pathToFileURL(file).href);
      if (!mod.id || typeof mod.run !== "function") {
        throw new Error(`${file}: a migration must export \`id\` and \`run\``);
      }
      if (done.has(mod.id)) {
        skipped.push(mod.id);
        continue;
      }

      // The migration's own lines are held until its outcome is known: a KNOWN
      // deferral prints none of them (its "absent" column checks are the same
      // noise as the deferral line), anything else prints them all, in order.
      const lines = [`applying ${mod.id}`];
      const flushLines = () => { for (const m of lines) log(m); };
      let outcome;
      try {
        outcome = await mod.run({ dbPath, tasksDbPath, log: (m) => { lines.push(m); } });
      } catch (err) {
        flushLines(); // a failure keeps every line that led up to it
        throw err;
      }

      if (outcome && outcome.deferred) {
        const reason =
          (typeof outcome.reason === "string" && outcome.reason.trim()) || DEFAULT_DEFERRAL_REASON;
        const at = now();
        deferred.push(mod.id);

        const known = deferrals.get(mod.id);
        if (known && known.reason === reason) {
          // KNOWN: same wait as last boot. Re-stamp and stay quiet — a restored
          // DB missing the row only costs one extra log line, never a retry.
          try {
            book.prepare("UPDATE schema_migrations_deferred SET last_checked_at = ? WHERE id = ?")
              .run(at, mod.id);
          } catch (err) {
            // The stamp is informational only: a busy crow.db must not stop the
            // migrations after this one.
            if (err?.code !== "SQLITE_BUSY") throw err;
          }
          continue; // its held lines are dropped
        }

        // NEW, or the reason changed (a different target is missing now, so the
        // old wait is over): record it with a fresh first_deferred_at and say so.
        book.prepare(
          `INSERT INTO schema_migrations_deferred (id, reason, first_deferred_at, last_checked_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             reason = excluded.reason,
             first_deferred_at = excluded.first_deferred_at,
             last_checked_at = excluded.last_checked_at`,
        ).run(mod.id, reason, at, at);
        deferrals.set(mod.id, { id: mod.id, reason, first_deferred_at: at });
        flushLines();
        log(`${mod.id} deferred — ${reason}, will retry`);
        newlyDeferred.push(mod.id);
        continue;
      }

      flushLines();
      // Apply + forget the deferral in ONE step: a deferral row that outlived
      // its migration would make a later failure look like an old, known wait.
      book.transaction(() => {
        book
          .prepare("INSERT INTO schema_migrations (id, applied_at, sha) VALUES (?, ?, ?)").run(mod.id, now(), sha);
        book.prepare("DELETE FROM schema_migrations_deferred WHERE id = ?").run(mod.id);
      })();
      deferrals.delete(mod.id);
      applied.push(mod.id);
    }
  } finally {
    book.close();
  }

  return { applied, skipped, deferred, newlyDeferred };
}

/**
 * The deferral bookkeeping rows for one instance, by id. Exported so a caller
 * that wants a quiet "known since" line reads the table through the runner
 * instead of opening crow.db itself.
 * @returns {Array<{id: string, reason: string, first_deferred_at: string, last_checked_at: string}>}
 */
export function readDeferrals(dbPath) {
  const book = open(dbPath);
  try {
    ensureTables(book);
    return book
      .prepare("SELECT id, reason, first_deferred_at, last_checked_at FROM schema_migrations_deferred ORDER BY id")
      .all();
  } finally {
    book.close();
  }
}
