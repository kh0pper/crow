/**
 * Queue item 49 — old sync conflicts expire on their own.
 *
 * The winning side of a sync_conflicts row was ALREADY applied when the row was
 * written, so an unresolved row nobody opened is review noise (one instance had
 * 363, all months old). These tests pin the operator's ruling end to end:
 *
 *   - the shared predicate (old, unopened, loser not newer),
 *   - the sweep (mark resolved, winner kept, snapshots untouched),
 *   - the days setting (valid / invalid / missing),
 *   - the health card counting only unexpired rows,
 *   - the review page's "opened" ping and "resolve all older than N days",
 *   - migration 0023 (adds the columns, idempotent, defers when absent),
 *   - the sweep on a store that predates the migration (0, no throw),
 *   - sync_conflicts staying OUT of the synced-table allowlist.
 *
 * Scratch DBs only (the suite's scratch CROW_HOME / temp dirs), never ~/.crow.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import Database from "better-sqlite3";

const REPO = join(import.meta.dirname, "..");
const MIGRATIONS = join(REPO, "scripts", "migrations");

const expiry = await import("../servers/sharing/sync-conflict-expiry.js");
const migration = await import("../scripts/migrations/0023-sync-conflict-expiry.mjs");
const { discoverMigrations, runMigrations } = await import("../scripts/migrations/runner.mjs");
const section = (await import("../servers/gateway/dashboard/settings/sections/sync-conflicts.js")).default;
const { SYNCED_TABLES } = await import("../servers/sharing/instance-sync.js");
const { csrfMiddleware } = await import("../servers/gateway/dashboard/shared/csrf.js");
const { collectHealthSignals, invalidateHealthCache } = await import(
  "../servers/gateway/dashboard/panels/nest/health-signals.js"
);
const { runSyncConflictExpirySweep } = await import("../servers/gateway/boot/post-listen.js");

const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/**
 * A real init-db database in a temp dir. `migrate: false` leaves migration 0023
 * unrun, which is how a store that has not booted since the upgrade looks.
 */
function fresh({ migrate = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sync-conflict-expiry-"));
  dirs.push(dir);
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir },
    stdio: "pipe",
    cwd: REPO,
  });
  const dbPath = join(dir, "crow.db");
  if (migrate) migration.run({ dbPath });
  return { dir, dbPath, db: createClient({ url: "file:" + dbPath }) };
}

let seq = 0;

/**
 * Seed one conflict. `winnerAt`/`loserAt` are the raw `updated_at` values inside
 * the two snapshots (null omits the key entirely).
 */
async function seed(db, {
  table = "memories",
  ageDays = 30,
  openedAt = null,
  winnerAt = "2026-01-02T00:00:00Z",
  loserAt = "2026-01-01T00:00:00Z",
  resolved = 0,
  resolvedAt = null,
  hasOpenedColumn = true,
} = {}) {
  const rowId = `row-${++seq}`;
  const win = JSON.stringify(winnerAt === null ? { id: seq } : { id: seq, updated_at: winnerAt });
  const lose = JSON.stringify(loserAt === null ? { id: seq } : { id: seq, updated_at: loserAt });

  const colNames = [
    "table_name", "row_id", "winning_instance_id", "losing_instance_id",
    "winning_lamport_ts", "losing_lamport_ts", "winning_data", "losing_data",
    "resolved", "resolved_at", "created_at",
  ];
  const values = ["?", "?", "'inst-a'", "'inst-b'", "2", "1", "?", "?", "?", "?", "datetime('now', ?)"];
  const args = [table, rowId, win, lose, resolved, resolvedAt, `-${ageDays} days`];
  if (hasOpenedColumn) {
    colNames.push("opened_at");
    values.push("?");
    args.push(openedAt);
  }

  await db.execute({
    sql: `INSERT INTO sync_conflicts (${colNames.join(", ")}) VALUES (${values.join(", ")})`,
    args,
  });
  const { rows } = await db.execute({
    sql: "SELECT * FROM sync_conflicts WHERE row_id = ?",
    args: [rowId],
  });
  return rows[0];
}

async function reload(db, id) {
  const { rows } = await db.execute({ sql: "SELECT * FROM sync_conflicts WHERE id = ?", args: [id] });
  return rows[0];
}

async function unresolvedCount(db) {
  const { rows } = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM sync_conflicts WHERE resolved = 0",
    args: [],
  });
  return Number(rows[0].n);
}

/** Express-ish response double for handleAction. */
function fakeRes() {
  return {
    statusCode: 200,
    ended: false,
    redirected: null,
    status(code) { this.statusCode = code; return this; },
    type() { return this; },
    send() { this.ended = true; return this; },
    end() { this.ended = true; return this; },
    redirectAfterPost(url) { this.redirected = url; return this; },
  };
}

/**
 * Post a settings action through the REAL CSRF rail, exactly as the dashboard
 * mounts it, then hand the request to the section's handleAction.
 */
async function postSettings(db, body, { cookieToken = "csrf-token", includeCsrfCookie = true } = {}) {
  const req = {
    method: "POST",
    headers: {
      cookie: includeCsrfCookie
        ? `crow_session=sess; crow_csrf=${cookieToken}`
        : "crow_session=sess",
    },
    // A real form echoes the cookie value in the hidden field; the CSRF rail
    // compares the two, so the default here is the matching token.
    body: { _csrf: cookieToken, ...body },
    query: {},
  };
  const res = fakeRes();
  let passedCsrf = false;
  csrfMiddleware(req, res, () => { passedCsrf = true; });
  if (!passedCsrf) return { reachedAction: false, res, req };
  await section.handleAction({ req, res, db, action: body.action });
  return { reachedAction: true, res, req };
}

// ── The predicate, through the sweep ─────────────────────────────────────────

test("an old, unopened conflict expires; winner kept; both snapshots untouched; resolved_via='expired'", async () => {
  const { db } = fresh();
  try {
    const row = await seed(db, { ageDays: 30 });
    const n = await expiry.expireOldConflicts(db, { days: 7 });
    assert.equal(n, 1);

    const after_ = await reload(db, row.id);
    assert.equal(after_.resolved, 1);
    assert.equal(after_.resolved_via, "expired");
    assert.ok(after_.resolved_at, "resolved_at is stamped");
    assert.equal(after_.winning_data, row.winning_data, "winning_data is never rewritten");
    assert.equal(after_.losing_data, row.losing_data, "losing_data is never rewritten");
  } finally {
    await db.close();
  }
});

test("a younger conflict does not expire", async () => {
  const { db } = fresh();
  try {
    const row = await seed(db, { ageDays: 1 });
    assert.equal(await expiry.expireOldConflicts(db, { days: 7 }), 0);
    assert.equal((await reload(db, row.id)).resolved, 0);
  } finally {
    await db.close();
  }
});

test("a conflict a person opened does not expire", async () => {
  const { db } = fresh();
  try {
    const row = await seed(db, { ageDays: 30, openedAt: "2026-01-01 00:00:00" });
    assert.equal(await expiry.expireOldConflicts(db, { days: 7 }), 0);
    const after_ = await reload(db, row.id);
    assert.equal(after_.resolved, 0);
    assert.equal(after_.opened_at, "2026-01-01 00:00:00", "opened_at is not touched by the sweep");
  } finally {
    await db.close();
  }
});

test("a row whose losing side is newer than the winner does not expire", async () => {
  const { db } = fresh();
  try {
    const row = await seed(db, {
      ageDays: 30,
      winnerAt: "2026-01-01T00:00:00Z",
      loserAt: "2026-02-01T00:00:00Z",
    });
    assert.equal(await expiry.expireOldConflicts(db, { days: 7 }), 0);
    assert.equal((await reload(db, row.id)).resolved, 0);
  } finally {
    await db.close();
  }
});

test("a row with no updated_at on either side CAN expire (absent is not 'newer')", async () => {
  const { db } = fresh();
  try {
    const row = await seed(db, { ageDays: 30, winnerAt: null, loserAt: null });
    assert.equal(await expiry.expireOldConflicts(db, { days: 7 }), 1);
    assert.equal((await reload(db, row.id)).resolved, 1);
  } finally {
    await db.close();
  }
});

test("an already-resolved row is left exactly as it was", async () => {
  const { db } = fresh();
  try {
    const row = await seed(db, { ageDays: 30, resolved: 1, resolvedAt: "2026-01-01 00:00:00" });
    assert.equal(await expiry.expireOldConflicts(db, { days: 7 }), 0);
    const after_ = await reload(db, row.id);
    assert.equal(after_.resolved, 1);
    assert.equal(after_.resolved_at, "2026-01-01 00:00:00", "a prior decision is not re-stamped");
    assert.equal(after_.resolved_via, null, "the sweep does not claim a row it never resolved");
  } finally {
    await db.close();
  }
});

test("expirableWhere is one predicate and only the old/unopened/non-newer row matches it", async () => {
  const { db } = fresh();
  try {
    const old = await seed(db, { ageDays: 30 });
    const young = await seed(db, { ageDays: 2 });
    const opened = await seed(db, { ageDays: 30, openedAt: "2026-01-01 00:00:00" });
    const newer = await seed(db, { ageDays: 30, winnerAt: "2026-01-01T00:00:00Z", loserAt: "2026-02-01T00:00:00Z" });

    const { sql, args } = expiry.expirableWhere(7);
    const { rows } = await db.execute({
      sql: `SELECT id FROM sync_conflicts WHERE ${sql} ORDER BY id`,
      args,
    });
    assert.deepEqual(rows.map((r) => r.id), [old.id]);
    for (const other of [young.id, opened.id, newer.id]) {
      assert.ok(!rows.some((r) => r.id === other));
    }
  } finally {
    await db.close();
  }
});

// ── The days setting ─────────────────────────────────────────────────────────

async function setDays(db, value) {
  await db.execute({
    sql: `INSERT INTO dashboard_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: ["sync_conflicts_expire_days", value],
  });
}

test("the days setting: a valid 1–365 integer is used", async () => {
  const { db } = fresh();
  try {
    for (const [value, expected] of [["1", 1], ["30", 30], ["365", 365]]) {
      await setDays(db, value);
      assert.equal(await expiry.readExpireDays(db), expected, `value ${value}`);
    }
  } finally {
    await db.close();
  }
});

test("the days setting: anything outside 1–365 or not an integer means the default", async () => {
  const { db } = fresh();
  try {
    for (const value of ["0", "366", "-3", "abc", "7.5", "", "1e2"]) {
      await setDays(db, value);
      assert.equal(await expiry.readExpireDays(db), expiry.EXPIRE_DAYS_DEFAULT, `value ${JSON.stringify(value)}`);
    }
  } finally {
    await db.close();
  }
});

test("the days setting: a missing key means the default; normalizeDays matches", async () => {
  const { db } = fresh();
  try {
    assert.equal(await expiry.readExpireDays(db), 7);
    assert.equal(expiry.EXPIRE_DAYS_DEFAULT, 7);
    assert.equal(expiry.normalizeDays(undefined), 7);
    assert.equal(expiry.normalizeDays(null), 7);
    assert.equal(expiry.normalizeDays("14"), 14);
    assert.equal(expiry.normalizeDays(14), 14);
    assert.equal(expiry.normalizeDays("400"), 7);
  } finally {
    await db.close();
  }
});

test("the configured window steers the sweep", async () => {
  const { db } = fresh();
  try {
    const row = await seed(db, { ageDays: 10 });
    await setDays(db, "30");
    assert.equal(await expiry.expireOldConflicts(db, { days: await expiry.readExpireDays(db) }), 0);
    await setDays(db, "3");
    assert.equal(await expiry.expireOldConflicts(db, { days: await expiry.readExpireDays(db) }), 1);
    assert.equal((await reload(db, row.id)).resolved_via, "expired");
  } finally {
    await db.close();
  }
});

// ── Health signal ────────────────────────────────────────────────────────────

async function syncConflictSignalValue(db) {
  invalidateHealthCache();
  const { details } = await collectHealthSignals(db);
  const detail = details.find((d) => d.id === "syncConflicts");
  assert.ok(detail, "the syncConflicts health detail must exist");
  return detail.value;
}

test("health counts exclude expirable rows", async () => {
  const { db } = fresh();
  try {
    await seed(db, { ageDays: 30 });   // expirable — must not count
    const young = await seed(db, { ageDays: 1 }); // still owed a look
    assert.equal(await syncConflictSignalValue(db), "1 unresolved");

    await db.execute({ sql: "UPDATE sync_conflicts SET resolved = 1 WHERE id = ?", args: [young.id] });
    assert.equal(await syncConflictSignalValue(db), "none");
  } finally {
    await db.close();
  }
});

test("health counts an opened old conflict (the sweep will leave it, so it is owed a look)", async () => {
  const { db } = fresh();
  try {
    await seed(db, { ageDays: 30, openedAt: "2026-01-01 00:00:00" });
    assert.equal(await syncConflictSignalValue(db), "1 unresolved");
  } finally {
    await db.close();
  }
});

test("health falls back to every unresolved row when the expiry columns are absent", async () => {
  const { db } = fresh({ migrate: false });
  try {
    await seed(db, { ageDays: 30, hasOpenedColumn: false });
    await seed(db, { ageDays: 1, hasOpenedColumn: false });
    assert.equal(await syncConflictSignalValue(db), "2 unresolved");
  } finally {
    await db.close();
  }
});

// ── The "opened" ping ────────────────────────────────────────────────────────

test("the opened action stamps opened_at once and answers 204", async () => {
  const { db } = fresh();
  try {
    const row = await seed(db, { ageDays: 30 });
    const { reachedAction, res } = await postSettings(db, {
      action: "sync_conflicts_opened",
      conflict_id: String(row.id),
    });
    assert.ok(reachedAction, "a valid CSRF token reaches the action");
    assert.equal(res.statusCode, 204);
    assert.ok(res.ended);
    assert.ok((await reload(db, row.id)).opened_at, "opened_at is set");

    // Second open: the first timestamp stands.
    await db.execute({
      sql: "UPDATE sync_conflicts SET opened_at = '2026-01-01 00:00:00' WHERE id = ?",
      args: [row.id],
    });
    await postSettings(db, { action: "sync_conflicts_opened", conflict_id: String(row.id) });
    assert.equal((await reload(db, row.id)).opened_at, "2026-01-01 00:00:00");
  } finally {
    await db.close();
  }
});

test("the opened action never touches a resolved row", async () => {
  const { db } = fresh();
  try {
    const row = await seed(db, { ageDays: 30, resolved: 1, resolvedAt: "2026-01-01 00:00:00" });
    await postSettings(db, { action: "sync_conflicts_opened", conflict_id: String(row.id) });
    assert.equal((await reload(db, row.id)).opened_at, null);
  } finally {
    await db.close();
  }
});

test("the opened action is refused without a valid CSRF token", async () => {
  const { db } = fresh();
  try {
    const row = await seed(db, { ageDays: 30 });
    const bad = await postSettings(
      db,
      { action: "sync_conflicts_opened", conflict_id: String(row.id), _csrf: "wrong" },
      { cookieToken: "csrf-token" },
    );
    assert.equal(bad.reachedAction, false, "the real csrfMiddleware refuses the POST");
    assert.equal(bad.res.statusCode, 403);
    assert.equal((await reload(db, row.id)).opened_at, null);

    // No cookie at all (a cross-site form post carries no crow_csrf value).
    const noCookie = await postSettings(
      db,
      { action: "sync_conflicts_opened", conflict_id: String(row.id) },
      { includeCsrfCookie: false },
    );
    assert.equal(noCookie.reachedAction, false);
    assert.equal(noCookie.res.statusCode, 403);
    assert.equal((await reload(db, row.id)).opened_at, null);
  } finally {
    await db.close();
  }
});

test("the page marks each openable row with its conflict id and ships the tracker", async () => {
  const { db } = fresh();
  try {
    const row = await seed(db, { ageDays: 30 });
    const html = await section.render({ req: { csrfToken: "test-csrf", query: {} }, db, lang: "en" });
    assert.match(html, new RegExp(`data-conflict-id="${row.id}"`));
    assert.match(html, /\[data-conflict-id\]/, "the tracker script is present");
    assert.match(html, /sync_conflicts_opened/);
  } finally {
    await db.close();
  }
});

test("the page offers the resolve-all-older-than form with a bounded days input", async () => {
  const { db } = fresh();
  try {
    await seed(db, { ageDays: 30 });
    const html = await section.render({ req: { csrfToken: "test-csrf", query: {} }, db, lang: "en" });
    assert.match(html, /value="sync_conflicts_resolve_older"/);
    assert.match(html, /name="days" type="number" min="1" max="365"/);
    assert.match(html, /value="7"/);
    assert.match(html, /Resolve all older than/, "label comes from the section's i18n helper");
  } finally {
    await db.close();
  }
});

// ── Resolve all older than N days ────────────────────────────────────────────

test("resolve_older resolves opened and newer-loser rows past the cutoff, leaves younger rows alone", async () => {
  const { db } = fresh();
  try {
    const plain = await seed(db, { ageDays: 30 });
    const opened = await seed(db, { ageDays: 30, openedAt: "2026-01-01 00:00:00" });
    const newer = await seed(db, {
      ageDays: 30, winnerAt: "2026-01-01T00:00:00Z", loserAt: "2026-02-01T00:00:00Z",
    });
    const young = await seed(db, { ageDays: 1 });

    const { reachedAction, res } = await postSettings(db, {
      action: "sync_conflicts_resolve_older",
      days: "7",
    });
    assert.ok(reachedAction);
    assert.equal(res.redirected, "/dashboard/settings?section=sync-conflicts");

    for (const id of [plain.id, opened.id, newer.id]) {
      const row = await reload(db, id);
      assert.equal(row.resolved, 1, `row ${id} resolved`);
      assert.equal(row.resolved_via, "bulk");
      assert.ok(row.resolved_at);
    }
    assert.equal((await reload(db, young.id)).resolved, 0, "younger rows stay open");
  } finally {
    await db.close();
  }
});

test("resolve_older rejects anything that is not an integer 1–365 and changes nothing", async () => {
  const { db } = fresh();
  try {
    await seed(db, { ageDays: 30 });
    await seed(db, { ageDays: 400 });
    const before = await unresolvedCount(db);

    for (const days of ["0", "366", "-1", "abc", "7.5", "", undefined]) {
      const { reachedAction, res } = await postSettings(db, {
        action: "sync_conflicts_resolve_older",
        days,
      });
      assert.ok(reachedAction, "validation happens inside the action, not the CSRF rail");
      assert.equal(res.redirected, "/dashboard/settings?section=sync-conflicts");
      assert.equal(await unresolvedCount(db), before, `days=${JSON.stringify(days)} must not resolve anything`);
    }
  } finally {
    await db.close();
  }
});

test("keep_current and resolve_all record resolved_via='operator'", async () => {
  const { db } = fresh();
  try {
    const kept = await seed(db, { ageDays: 1 });
    await postSettings(db, { action: "sync_conflicts_keep_current", conflict_id: String(kept.id) });
    const keptRow = await reload(db, kept.id);
    assert.equal(keptRow.resolved, 1);
    assert.equal(keptRow.resolved_via, "operator");

    await seed(db, { ageDays: 1 });
    await postSettings(db, { action: "sync_conflicts_resolve_all" });
    const { rows } = await db.execute({
      sql: "SELECT resolved, resolved_via FROM sync_conflicts WHERE resolved = 0",
      args: [],
    });
    assert.equal(rows.length, 0, "resolve_all closes everything");
    const { rows: all } = await db.execute({ sql: "SELECT resolved_via FROM sync_conflicts", args: [] });
    assert.ok(all.every((r) => r.resolved_via === "operator"));
  } finally {
    await db.close();
  }
});

// ── Migration 0023 ───────────────────────────────────────────────────────────

const columnsOf = (dbPath, table = "sync_conflicts") => {
  const d = new Database(dbPath, { readonly: true });
  try {
    return d.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  } finally {
    d.close();
  }
};

test("0023 is discovered with its own id and adds opened_at + resolved_via", () => {
  assert.equal(migration.id, "0023-sync-conflict-expiry");
  assert.ok(
    discoverMigrations(MIGRATIONS).some((p) => p.endsWith("/0023-sync-conflict-expiry.mjs")),
    "the runner sees the file",
  );
  const { dbPath } = fresh({ migrate: false });
  assert.ok(!columnsOf(dbPath).includes("opened_at"), "fresh init-db has no opened_at");

  assert.deepEqual(migration.run({ dbPath }), { applied: true });
  const cols = columnsOf(dbPath);
  assert.ok(cols.includes("opened_at"));
  assert.ok(cols.includes("resolved_via"));
});

test("0023 is idempotent (directly and through the runner)", async () => {
  const { db, dbPath, dir } = fresh({ migrate: false });
  try {
    migration.run({ dbPath });
    const once = columnsOf(dbPath);
    assert.deepEqual(migration.run({ dbPath }), { applied: true }, "a second direct run is a no-op, not a failure");
    assert.deepEqual(columnsOf(dbPath), once);

    const tasksDbPath = join(dir, "tasks.db");
    const first = await runMigrations({ migrationsDir: MIGRATIONS, dbPath, tasksDbPath });
    assert.ok(first.applied.includes(migration.id) || first.skipped.includes(migration.id));
    const second = await runMigrations({ migrationsDir: MIGRATIONS, dbPath, tasksDbPath });
    assert.ok(second.skipped.includes(migration.id), "the runner records it and skips next boot");
    assert.deepEqual(columnsOf(dbPath), once);
  } finally {
    await db.close();
  }
});

test("0023 defers with a reason when sync_conflicts is absent, and is not recorded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sync-conflict-expiry-empty-"));
  dirs.push(dir);
  const dbPath = join(dir, "crow.db");
  new Database(dbPath).close();

  const outcome = migration.run({ dbPath });
  assert.equal(outcome.deferred, true);
  assert.match(outcome.reason, /sync_conflicts absent/);

  const { deferred, applied } = await runMigrations({
    migrationsDir: MIGRATIONS,
    dbPath,
    tasksDbPath: join(dir, "tasks.db"),
  });
  assert.ok(deferred.includes(migration.id), "the runner defers it too");
  assert.ok(!applied.includes(migration.id), "a deferral is never recorded as applied");
});

test("0023 does not touch scripts/init-db.js (no SCHEMA_GENERATION bump)", () => {
  const src = readFileSync(join(REPO, "scripts", "init-db.js"), "utf8");
  assert.doesNotMatch(src, /opened_at/, "the columns come from the migration registry only");
  assert.doesNotMatch(src, /resolved_via/);
});

// ── Sweep on an un-migrated store ────────────────────────────────────────────

test("the sweep returns 0 and does not throw when the migration has not run; it warns once", async () => {
  const { db } = fresh({ migrate: false });
  try {
    await seed(db, { ageDays: 30, hasOpenedColumn: false });

    const warnings = [];
    const original = console.warn;
    console.warn = (...args) => { warnings.push(args.join(" ")); };

    let first;
    let second;
    try {
      first = await expiry.expireOldConflicts(db, { days: 7 });
      const afterFirst = warnings.length;
      second = await expiry.expireOldConflicts(db, { days: 7 });
      assert.equal(warnings.length, afterFirst, "the missing-columns warning is logged once per process");
    } finally {
      console.warn = original;
    }

    assert.equal(first, 0);
    assert.equal(second, 0);
    assert.equal(await unresolvedCount(db), 1, "nothing was resolved");
  } finally {
    await db.close();
  }
});

test("the boot sweep never throws and reports 0 on an un-migrated store", async () => {
  const { db } = fresh({ migrate: false });
  try {
    await seed(db, { ageDays: 30, hasOpenedColumn: false });
    // A factory, not the client itself: the sweep closes what it is handed.
    assert.equal(await runSyncConflictExpirySweep(() => ({ execute: (q) => db.execute(q) })), 0);
    assert.equal(await unresolvedCount(db), 1);
  } finally {
    await db.close();
  }
});

test("the boot sweep expires old conflicts and logs the count only when it acted", async () => {
  const { db } = fresh();
  try {
    await seed(db, { ageDays: 30 });
    const logs = [];
    const original = console.log;
    console.log = (...args) => { logs.push(args.join(" ")); };
    let n;
    try {
      const factory = () => ({ execute: (q) => db.execute(q) });
      n = await runSyncConflictExpirySweep(factory);
      await runSyncConflictExpirySweep(factory);
    } finally {
      console.log = original;
    }
    assert.equal(n, 1);
    assert.deepEqual(
      logs.filter((l) => l.startsWith("[sync] expired")),
      ["[sync] expired 1 old conflicts (older than 7 days, winner kept)"],
      "one line for the pass that acted, none for the quiet one",
    );
  } finally {
    await db.close();
  }
});

test("the gateway arms the sweep after listen and every 6 hours, unref'd", () => {
  const src = readFileSync(join(REPO, "servers", "gateway", "boot", "post-listen.js"), "utf8");
  assert.match(src, /SYNC_CONFLICT_EXPIRY_INTERVAL_MS = 6 \* 60 \* 60 \* 1000/);
  assert.match(src, /setImmediate\(\(\) => \{ runSyncConflictExpirySweep\(createDbClient\); \}\)/);
  assert.match(src, /setInterval\(\(\) => \{ runSyncConflictExpirySweep\(createDbClient\); \}, SYNC_CONFLICT_EXPIRY_INTERVAL_MS\)\.unref\(\)/);
});

// ── Sync allowlist ───────────────────────────────────────────────────────────

test("sync_conflicts stays OUT of SYNCED_TABLES (local bookkeeping, never replicated)", () => {
  assert.ok(SYNCED_TABLES.length > 0);
  assert.ok(
    !SYNCED_TABLES.includes("sync_conflicts"),
    "sync_conflicts is per-instance bookkeeping — adding it to the allowlist would replicate conflict rows",
  );
});