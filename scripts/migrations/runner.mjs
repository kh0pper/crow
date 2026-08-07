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

function ensureTable(db) {
  db.prepare(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       id TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL,
       sha TEXT
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
 * @returns {Promise<{applied: string[], skipped: string[], deferred: string[]}>}
 */
export async function runMigrations({
  migrationsDir,
  dbPath,
  tasksDbPath,
  sha = null,
  log = () => {},
}) {
  const applied = [];
  const skipped = [];
  const deferred = [];

  const book = open(dbPath);
  try {
    ensureTable(book);
    const done = new Set(book.prepare("SELECT id FROM schema_migrations").all().map((r) => r.id));

    for (const file of discoverMigrations(migrationsDir)) {
      const mod = await import(pathToFileURL(file).href);
      if (!mod.id || typeof mod.run !== "function") {
        throw new Error(`${file}: a migration must export \`id\` and \`run\``);
      }
      if (done.has(mod.id)) {
        skipped.push(mod.id);
        continue;
      }

      log(`applying ${mod.id}`);
      const outcome = await mod.run({ dbPath, tasksDbPath, log });

      if (outcome && outcome.deferred) {
        log(`${mod.id} deferred — target tables absent, will retry`);
        deferred.push(mod.id);
        continue;
      }

      book
        .prepare("INSERT INTO schema_migrations (id, applied_at, sha) VALUES (?, ?, ?)")
        .run(mod.id, new Date().toISOString(), sha);
      applied.push(mod.id);
    }
  } finally {
    book.close();
  }

  return { applied, skipped, deferred };
}
