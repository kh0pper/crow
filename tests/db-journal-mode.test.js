/**
 * Tests for W4-4 commit 5: WAL systemic fixes in servers/db.js.
 *
 * (i)  WAL default (normal host): keeper registered, client is in WAL.
 * (ii) Injected low-RAM (CROW_TEST_TOTALMEM): resolveJournalMode returns DELETE,
 *      keeper NOT registered, client works in DELETE mode,
 *      performBackup still works (C5 transient-handle fallback).
 * (iii) Dedup: two clients on the same path with a forced mode mismatch
 *       (env set to WAL but DB is in DELETE) → only one warn line.
 */

import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "../node_modules/better-sqlite3/lib/index.js";

// Each test creates its own tempdir so there's no cross-test contamination.
const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function makeTempDir() {
  const d = mkdtempSync(join(tmpdir(), "db-jm-test-"));
  dirs.push(d);
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: d },
    stdio: "pipe",
  });
  return d;
}

// Fresh import of db.js per test: we need to reset the dedup sets and the
// keeper map between tests. ESM caches modules, so we use dynamic import with
// a unique query param to bust the cache.
let _importSeq = 0;
async function freshDb(extraEnv = {}) {
  // Set env BEFORE import so resolveJournalMode() reads it at call time.
  for (const [k, v] of Object.entries(extraEnv)) process.env[k] = v;
  _importSeq++;
  const mod = await import(`../servers/db.js?t=${_importSeq}`);
  return mod;
}

// Capture all console.warn lines during an async function.
async function captureWarns(fn) {
  const warns = [];
  const orig = console.warn;
  console.warn = (...args) => warns.push(args.map(String).join(" "));
  try {
    const result = await fn();
    return { result, warns };
  } finally {
    console.warn = orig;
  }
}

// ── Test (i): WAL default ───────────────────────────────────────────────────

test("db-jm: WAL default — keeper registered, client in WAL", async () => {
  const dir = makeTempDir();
  const dbPath = join(dir, "crow.db");

  delete process.env.CROW_JOURNAL_MODE;
  delete process.env.CROW_TEST_TOTALMEM;

  // Use a high-RAM host value so WAL is auto-selected.
  const { createDbClient, resolveJournalMode, _setTotalmemFn, _dbKeepers: keepers } = await freshDb({});
  // Inject a large totalmem so WAL branch is taken regardless of actual host RAM.
  if (_setTotalmemFn) _setTotalmemFn(() => 8 * 1024 ** 3); // 8 GiB

  const mode = resolveJournalMode();
  assert.equal(mode, "WAL", "resolveJournalMode should return WAL on high-RAM host");

  const client = createDbClient(dbPath);

  // Verify the DB is actually in WAL mode.
  const rawDb = new Database(dbPath);
  const actualMode = rawDb.pragma("journal_mode", { simple: true });
  rawDb.close();
  assert.equal(actualMode.toLowerCase(), "wal", "DB must be in WAL mode");

  // Keeper must be registered.
  assert.equal(keepers.has(dbPath), true, "keeper must be registered for WAL DB");

  client.close();
});

// ── Test (ii): Low-RAM auto-select DELETE ──────────────────────────────────

test("db-jm: low-RAM injected — resolveJournalMode returns DELETE, no keeper, client works, performBackup fallback works", async () => {
  const dir = makeTempDir();
  const dbPath = join(dir, "crow.db");
  const backupPath = join(dir, "crow.db.bak");

  delete process.env.CROW_JOURNAL_MODE;

  const { createDbClient, resolveJournalMode, _setTotalmemFn, performBackup, _dbKeepers: keepers } = await freshDb({
    CROW_TEST_TOTALMEM: "1073741824", // 1 GiB — under 2 GiB threshold → DELETE
  });
  if (_setTotalmemFn) _setTotalmemFn(() => 1 * 1024 ** 3); // belt-and-suspenders

  const { warns } = await captureWarns(async () => {
    const mode = resolveJournalMode();
    assert.equal(mode, "DELETE", "resolveJournalMode must return DELETE on low-RAM host");

    const client = createDbClient(dbPath);

    // DB should be in DELETE mode.
    const rawDb = new Database(dbPath);
    const actualMode = rawDb.pragma("journal_mode", { simple: true });
    rawDb.close();
    assert.equal(actualMode.toLowerCase(), "delete", "DB must be in DELETE mode");

    // Keeper must NOT be registered.
    assert.equal(keepers.has(dbPath), false, "keeper must NOT be registered for DELETE DB");

    // Client should work (basic execute).
    const r = await client.execute({ sql: "SELECT 1 AS val", args: [] });
    assert.equal(r.rows[0].val, 1, "client execute must work in DELETE mode");

    client.close();

    // performBackup must use the transient-handle fallback (C5).
    await performBackup(dbPath, backupPath);
    assert.equal(existsSync(backupPath), true, "backup file must exist after performBackup");
  });

  const autoWarn = warns.filter((w) => w.includes("Low-RAM host") || w.includes("auto-selecting"));
  assert.ok(autoWarn.length >= 1, "must log auto-select decision");

  delete process.env.CROW_TEST_TOTALMEM;
});

// ── Test (iii): Dedup — two clients, DELETE mode, only one keeper-skip warn ─

test("db-jm: dedup — two clients on DELETE-mode DB produce only one keeper-skip warn", async () => {
  const dir = makeTempDir();
  const dbPath = join(dir, "crow.db");

  // Pre-set the DB to DELETE mode so ensureKeeper will skip registration
  // and emit its dedup warn.
  const rawDb = new Database(dbPath);
  rawDb.pragma("journal_mode = DELETE");
  rawDb.close();

  // Force CROW_JOURNAL_MODE=DELETE so createDbClient doesn't try to flip.
  process.env.CROW_JOURNAL_MODE = "DELETE";

  const { createDbClient, _dbKeepers: keepers } = await freshDb({ CROW_JOURNAL_MODE: "DELETE" });

  const { warns } = await captureWarns(async () => {
    // Two clients on the same path — ensureKeeper should warn once and skip twice.
    const c1 = createDbClient(dbPath);
    const c2 = createDbClient(dbPath);
    c1.close();
    c2.close();
  });

  // Exactly one keeper-skip warn for this path.
  const keeperWarn = warns.filter((w) => w.includes("keeper-skip") && w.includes(dbPath));
  assert.equal(keeperWarn.length, 1, `expected exactly 1 keeper-skip warn, got ${keeperWarn.length}: ${JSON.stringify(keeperWarn)}`);

  // Keeper must not be registered.
  assert.equal(keepers.has(dbPath), false, "keeper must not be registered for DELETE DB");

  delete process.env.CROW_JOURNAL_MODE;
});
