/**
 * Per-instance migration registry (scripts/migrations/).
 *
 * Fixtures are real temp directories with real SQLite files, so the runner's
 * actual import + bookkeeping path is exercised. Fixture migration bodies import
 * ONLY node: builtins — a bare specifier like "better-sqlite3" cannot resolve
 * from os.tmpdir(), which has no node_modules anywhere on its path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { runMigrations, discoverMigrations, readDeferrals } from "../scripts/migrations/runner.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "migreg-"));
  const dir = join(root, "migrations");
  mkdirSync(dir);
  const dbPath = join(root, "crow.db");
  const tasksDbPath = join(root, "tasks.db");
  new Database(dbPath).close();
  new Database(tasksDbPath).close();
  return { root, dir, dbPath, tasksDbPath };
}

/** A second migrations dir over the SAME stores. ESM caches modules by URL, so
 *  changing a migration's behaviour between boots means a new file path. */
function altDir(f, name) {
  const d = join(f.root, name);
  mkdirSync(d, { recursive: true });
  return d;
}

const deferring = (id, reason) =>
  `export const id = ${JSON.stringify(id)};
   export function run() { return ${reason === undefined
     ? "{ deferred: true }"
     : `{ deferred: true, reason: ${JSON.stringify(reason)} }`}; }`;

/** The runner's own deferral line — `<id> deferred — <reason>, will retry`. */
const isRunnerDeferralLine = (line) => /^\d{4}-[a-z0-9-]+ deferred — .*will retry/.test(line);

const wm = (dir, name, body) => writeFileSync(join(dir, name), body);

const sideEffect = (id, file) =>
  `import { appendFileSync } from "node:fs";
   export const id = ${JSON.stringify(id)};
   export function run() { appendFileSync(${JSON.stringify(file)}, ${JSON.stringify(id + "\n")}); }`;

test("runs migrations in filename order, not creation order", async () => {
  const f = fixture();
  try {
    const order = join(f.root, "order.txt");
    // Created out of order deliberately: readdirSync order is unspecified, so a
    // fixture whose files happen to be created in sorted order proves nothing.
    wm(f.dir, "0003-c.mjs", sideEffect("0003-c", order));
    wm(f.dir, "0001-a.mjs", sideEffect("0001-a", order));
    wm(f.dir, "0002-b.mjs", sideEffect("0002-b", order));

    const res = await runMigrations({ migrationsDir: f.dir, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath });

    assert.deepEqual(res.applied, ["0001-a", "0002-b", "0003-c"]);
    assert.equal(readFileSync(order, "utf8"), "0001-a\n0002-b\n0003-c\n");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("is idempotent — the body runs exactly once across two calls", async () => {
  const f = fixture();
  try {
    const hits = join(f.root, "hits.txt");
    wm(f.dir, "0001-once.mjs", sideEffect("0001-once", hits));

    const a = await runMigrations({ migrationsDir: f.dir, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath });
    const b = await runMigrations({ migrationsDir: f.dir, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath });

    assert.deepEqual(a.applied, ["0001-once"]);
    assert.deepEqual(b.applied, []);
    assert.deepEqual(b.skipped, ["0001-once"]);
    assert.equal(readFileSync(hits, "utf8"), "0001-once\n", "the body must run exactly once");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a DEFERRED migration is NOT recorded and runs again next time", async () => {
  const f = fixture();
  try {
    const hits = join(f.root, "deferred.txt");
    wm(f.dir, "0001-defer.mjs",
      `import { appendFileSync } from "node:fs";
       export const id = "0001-defer";
       export function run() { appendFileSync(${JSON.stringify(hits)}, "x"); return { deferred: true }; }`);

    const a = await runMigrations({ migrationsDir: f.dir, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath });
    const b = await runMigrations({ migrationsDir: f.dir, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath });

    assert.deepEqual(a.deferred, ["0001-defer"]);
    assert.deepEqual(a.applied, []);
    assert.deepEqual(b.deferred, ["0001-defer"], "a deferred migration must retry, not be recorded");
    assert.equal(readFileSync(hits, "utf8"), "xx", "the body must run BOTH times");

    const db = new Database(f.dbPath);
    const rows = db.prepare("SELECT id FROM schema_migrations").all();
    db.close();
    assert.deepEqual(rows, [], "a deferral must leave no bookkeeping row behind");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("creates schema_migrations lazily — never requires init-db", async () => {
  const f = fixture();
  try {
    wm(f.dir, "0001-noop.mjs", `export const id = "0001-noop"; export function run() {}`);
    await runMigrations({ migrationsDir: f.dir, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath });

    const db = new Database(f.dbPath);
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
    db.close();
    assert.ok(t, "the runner must CREATE TABLE IF NOT EXISTS its own bookkeeping table");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("ignores files that do not match the NNNN-slug.mjs pattern", () => {
  const f = fixture();
  try {
    wm(f.dir, "0001-real.mjs", `export const id = "0001-real"; export function run() {}`);
    wm(f.dir, "README.md", "not a migration");
    wm(f.dir, "helper.mjs", "export const x = 1;");
    wm(f.dir, "0002-draft.mjs.bak", "stray");

    const found = discoverMigrations(f.dir).map((p) => p.split("/").pop());
    assert.deepEqual(found, ["0001-real.mjs"]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a throwing migration aborts the rest and records nothing", async () => {
  const f = fixture();
  try {
    const after = join(f.root, "after.txt");
    wm(f.dir, "0001-boom.mjs", `export const id = "0001-boom"; export function run() { throw new Error("boom"); }`);
    wm(f.dir, "0002-after.mjs", sideEffect("0002-after", after));   // observable side effect

    await assert.rejects(
      () => runMigrations({ migrationsDir: f.dir, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath }),
      /boom/,
    );

    assert.equal(existsSync(after), false, "0002 must NOT run after 0001 throws");
    const db = new Database(f.dbPath);
    const rows = db.prepare("SELECT id FROM schema_migrations").all();
    db.close();
    assert.deepEqual(rows, [], "a failed migration must not be recorded");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("0001-board-stages: adds columns, DEFERS when ANY target table is absent", async () => {
  const dir = join(import.meta.dirname, "..", "scripts", "migrations");

  // (a) Every target absent → deferred, not recorded.
  const bare = fixture();
  try {
    const r = await runMigrations({ migrationsDir: dir, dbPath: bare.dbPath, tasksDbPath: bare.tasksDbPath });
    assert.ok(r.deferred.includes("0001-board-stages"),
      "a fresh instance has no tasks_items yet — recording this as applied is the original bug");
    assert.ok(!r.applied.includes("0001-board-stages"));
  } finally { rmSync(bare.root, { recursive: true, force: true }); }

  // (a2) THE PRODUCTION SHAPE: crow.db tables exist (init-db has run at boot),
  // tasks_items does not (the tasks bundle has not started). This is every real
  // instance at boot — an "all absent" rule would wrongly record it as applied
  // here, and the tasks_items columns would never land.
  const mixed = fixture();
  try {
    const c = new Database(mixed.dbPath);
    c.prepare("CREATE TABLE project_spaces (id INTEGER PRIMARY KEY)").run();
    c.prepare("CREATE TABLE bot_sessions (id INTEGER PRIMARY KEY)").run();
    c.close();

    const r = await runMigrations({ migrationsDir: dir, dbPath: mixed.dbPath, tasksDbPath: mixed.tasksDbPath });
    assert.ok(r.deferred.includes("0001-board-stages"),
      "crow.db tables present + tasks_items absent MUST defer — this is the real-instance shape");
    assert.ok(!r.applied.includes("0001-board-stages"));

    // The crow.db half still applied its column — deferral is about the RECORD.
    const c2 = new Database(mixed.dbPath);
    const cols = c2.prepare("PRAGMA table_info(project_spaces)").all().map((x) => x.name);
    c2.close();
    assert.ok(cols.includes("repo_path"), "present tables must still be migrated");
  } finally { rmSync(mixed.root, { recursive: true, force: true }); }

  // (b) All targets present → 0001 applies its columns and is re-runnable.
  // Scoped to 0001's OWN run() — a whole-directory run no longer preserves
  // these columns (0002 rebuilds the table and drops `stage` by design); the
  // converged end state is case (c) below.
  const f = fixture();
  try {
    const t = new Database(f.tasksDbPath);
    t.prepare("CREATE TABLE tasks_items (id INTEGER PRIMARY KEY, title TEXT)").run();
    t.close();
    const c = new Database(f.dbPath);
    c.prepare("CREATE TABLE project_spaces (id INTEGER PRIMARY KEY)").run();
    c.prepare("CREATE TABLE bot_sessions (id INTEGER PRIMARY KEY)").run();
    c.close();

    const mod = await import(join(dir, "0001-board-stages.mjs"));
    const out = await mod.run({ dbPath: f.dbPath, tasksDbPath: f.tasksDbPath, log: () => {} });
    assert.ok(!out || !out.deferred, "all targets present → not deferred");

    const t2 = new Database(f.tasksDbPath);
    const cols = t2.prepare("PRAGMA table_info(tasks_items)").all().map((x) => x.name);
    t2.close();
    for (const col of ["stage", "assigned_bot", "plan_ref"]) {
      assert.ok(cols.includes(col), `tasks_items.${col} must exist`);
    }

    // Shape-level idempotence: re-run directly, bypassing the record. A missing
    // guard would throw "duplicate column name".
    await mod.run({ dbPath: f.dbPath, tasksDbPath: f.tasksDbPath, log: () => {} });
    const t3 = new Database(f.tasksDbPath);
    const after = t3.prepare("PRAGMA table_info(tasks_items)").all().map((x) => x.name);
    t3.close();
    assert.deepEqual(after, cols, "a re-run must not change the column set");
  } finally { rmSync(f.root, { recursive: true, force: true }); }

  // (c) The CONVERGED shape: a whole-directory run over a bundle-shaped store
  // ends with 0002's world — no stage, no status CHECK, data_json + board_defs
  // present — and every migration recorded.
  const g = fixture();
  try {
    const t = new Database(g.tasksDbPath);
    t.exec("CREATE TABLE tasks_items (id INTEGER PRIMARY KEY, title TEXT, " +
      "status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','done','cancelled')), " +
      "phase TEXT, project_id INTEGER)");
    t.close();
    const c = new Database(g.dbPath);
    c.prepare("CREATE TABLE project_spaces (id INTEGER PRIMARY KEY)").run();
    c.prepare("CREATE TABLE bot_sessions (id INTEGER PRIMARY KEY)").run();
    c.close();

    const r = await runMigrations({ migrationsDir: dir, dbPath: g.dbPath, tasksDbPath: g.tasksDbPath });
    assert.ok(r.applied.includes("0001-board-stages"));
    assert.ok(r.applied.includes("0002-board-defs"));

    const t2 = new Database(g.tasksDbPath);
    const cols = t2.prepare("PRAGMA table_info(tasks_items)").all().map((x) => x.name);
    const sql = t2.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks_items'").get().sql;
    const hasBoardDefs = !!t2.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='board_defs'").get();
    const hasBoardPlans = !!t2.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='board_plans'").get();
    const hasBoardResults = !!t2.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='board_results'").get();
    const hasBoardMutations = !!t2.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='board_mutations'").get();
    const hasTasksBriefings = !!t2.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks_briefings'").get();
    t2.close();
    assert.ok(!cols.includes("stage"), "converged shape has no stage");
    assert.ok(cols.includes("data_json"), "converged shape has data_json");
    assert.ok(cols.includes("assigned_bot"), "dormant column assigned_bot survives");
    assert.ok(!cols.includes("plan_ref"), "plan_ref is DROPPED by 0004 — no longer a survivor");
    assert.ok(!/CHECK\s*\(\s*status/i.test(sql), "converged shape has no status CHECK");
    assert.ok(hasBoardDefs, "board_defs exists");
    assert.ok(r.applied.includes("0003-tracker-convergence"),
      "no tracker tables in the fixture crow.db → 0003 records as a column-only no-op");
    assert.ok(cols.includes("board_id"), "converged shape has board_id (0003)");
    assert.ok(cols.includes("processing_lease_status"), "converged shape has the lease columns (0003)");
    assert.ok(r.applied.includes("0004-track1-card-model"), "0004 applies over the converged 0001-0003 shape");
    assert.ok(cols.includes("autonomy") && cols.includes("archived_at"), "converged shape has autonomy + archived_at (0004)");
    assert.ok(hasBoardPlans && hasBoardResults && hasBoardMutations, "converged shape has the three Track 1 tables (0004)");
    assert.ok(hasTasksBriefings, "converged shape has tasks_briefings (0004)");
  } finally { rmSync(g.root, { recursive: true, force: true }); }
});

test("a repeated deferral is logged once, not on every boot", async () => {
  const f = fixture();
  try {
    wm(f.dir, "0001-defer.mjs", deferring("0001-defer", "tasks_items absent"));
    const boot = (nowIso) => {
      const lines = [];
      return { lines, run: () => runMigrations({
        migrationsDir: f.dir, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath,
        log: (m) => lines.push(m), now: () => nowIso,
      }) };
    };

    const first = boot("2026-01-01T00:00:00.000Z");
    const a = await first.run();
    assert.deepEqual(a.newlyDeferred, ["0001-defer"], "a first deferral is NEW");
    assert.deepEqual(a.deferred, ["0001-defer"]);
    assert.ok(first.lines.some((m) => m.includes("0001-defer deferred — tasks_items absent")),
      `the new deferral must be logged: ${first.lines.join(" | ")}`);

    const second = boot("2026-01-02T00:00:00.000Z");
    const b = await second.run();
    assert.deepEqual(b.deferred, ["0001-defer"], "still deferred, so still retried every boot");
    assert.deepEqual(b.newlyDeferred, [], "same reason → KNOWN, not new");
    assert.ok(!second.lines.some(isRunnerDeferralLine),
      `a known deferral must not log: ${second.lines.join(" | ")}`);

    // first_deferred_at is the start of the wait; only last_checked_at moves.
    assert.deepEqual(readDeferrals(f.dbPath), [{
      id: "0001-defer", reason: "tasks_items absent",
      first_deferred_at: "2026-01-01T00:00:00.000Z", last_checked_at: "2026-01-02T00:00:00.000Z",
    }]);

    const db = new Database(f.dbPath);
    const appliedRows = db.prepare("SELECT id FROM schema_migrations").all();
    db.close();
    assert.deepEqual(appliedRows, [], "a deferral is never recorded as applied");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a changed deferral reason makes it new again", async () => {
  const f = fixture();
  try {
    wm(f.dir, "0001-defer.mjs", deferring("0001-defer", "tasks_items absent"));
    await runMigrations({ migrationsDir: f.dir, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath });

    // A different target is missing now — that is a new wait, not the old one.
    const d2 = altDir(f, "migrations-2");
    wm(d2, "0001-defer.mjs", deferring("0001-defer", "tracker_items absent"));
    const lines = [];
    const r = await runMigrations({
      migrationsDir: d2, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath,
      log: (m) => lines.push(m), now: () => "2026-02-01T00:00:00.000Z",
    });
    assert.deepEqual(r.newlyDeferred, ["0001-defer"]);
    assert.ok(lines.some((m) => m.includes("tracker_items absent")), lines.join(" | "));
    const row = readDeferrals(f.dbPath)[0];
    assert.equal(row.reason, "tracker_items absent");
    assert.equal(row.first_deferred_at, "2026-02-01T00:00:00.000Z", "the old wait is over — the new one starts now");

    // Same reason again → known once more.
    const again = await runMigrations({ migrationsDir: d2, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath });
    assert.deepEqual(again.newlyDeferred, []);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a deferral with no reason books as \"target tables absent\"", async () => {
  const f = fixture();
  try {
    wm(f.dir, "0001-bare.mjs", deferring("0001-bare"));
    await runMigrations({ migrationsDir: f.dir, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath });
    assert.equal(readDeferrals(f.dbPath)[0].reason, "target tables absent");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a missing deferral row (restored DB) makes the next deferral new again", async () => {
  const f = fixture();
  try {
    wm(f.dir, "0001-defer.mjs", deferring("0001-defer", "tasks_items absent"));
    await runMigrations({ migrationsDir: f.dir, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath });

    const db = new Database(f.dbPath);
    db.prepare("DELETE FROM schema_migrations_deferred").run();
    db.close();

    const lines = [];
    const r = await runMigrations({
      migrationsDir: f.dir, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath, log: (m) => lines.push(m),
    });
    assert.deepEqual(r.newlyDeferred, ["0001-defer"], "bookkeeping is an optimization — losing it costs one log line, never a retry");
    assert.ok(lines.some(isRunnerDeferralLine));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("when a deferred migration later applies, it is recorded and its deferral row is gone", async () => {
  const f = fixture();
  try {
    wm(f.dir, "0001-defer.mjs", deferring("0001-defer", "tasks_items absent"));
    const a = await runMigrations({ migrationsDir: f.dir, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath });
    assert.deepEqual(a.newlyDeferred, ["0001-defer"]);

    // The bundle finally created the table: same id, no deferral this time.
    const d2 = altDir(f, "migrations-2");
    wm(d2, "0001-defer.mjs", `export const id = "0001-defer"; export function run() {}`);
    const b = await runMigrations({ migrationsDir: d2, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath });
    assert.deepEqual(b.applied, ["0001-defer"]);
    assert.deepEqual(b.deferred, []);
    assert.deepEqual(b.newlyDeferred, []);

    const db = new Database(f.dbPath);
    const recorded = db.prepare("SELECT id FROM schema_migrations").all().map((r) => r.id);
    db.close();
    assert.deepEqual(recorded, ["0001-defer"]);
    assert.deepEqual(readDeferrals(f.dbPath), [], "the deferral row is deleted in the same step as the record");

    // And a second boot skips it — nothing left to defer.
    const c = await runMigrations({ migrationsDir: d2, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath });
    assert.deepEqual(c.skipped, ["0001-defer"]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("0001-0004 name the absent table in their deferral reason", async () => {
  const dir = join(import.meta.dirname, "..", "scripts", "migrations");
  const f = fixture();
  try {
    // The production shape for a paired instance with no board: crow.db is
    // initialized, tasks.db exists and holds only board_defs — never tasks_items.
    const t = new Database(f.tasksDbPath);
    t.exec("CREATE TABLE board_defs (id INTEGER PRIMARY KEY, slug TEXT UNIQUE)");
    t.close();
    const c = new Database(f.dbPath);
    c.exec("CREATE TABLE project_spaces (id INTEGER PRIMARY KEY); CREATE TABLE bot_sessions (id INTEGER PRIMARY KEY)");
    c.close();

    const lines = [];
    const r = await runMigrations({
      migrationsDir: dir, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath, log: (m) => lines.push(m),
    });

    const byId = Object.fromEntries(readDeferrals(f.dbPath).map((x) => [x.id, x.reason]));
    for (const id of ["0001-board-stages", "0002-board-defs", "0003-tracker-convergence", "0004-track1-card-model"]) {
      assert.ok(r.deferred.includes(id), `${id} must defer without tasks_items`);
      assert.equal(byId[id], "tasks_items absent", `${id} must name the table it found absent`);
    }
    assert.ok(lines.some((m) => m.includes("0001-board-stages deferred — tasks_items absent")), lines.join(" | "));

    // Second boot, same stores: every one of them is KNOWN and quiet.
    const quiet = [];
    const r2 = await runMigrations({
      migrationsDir: dir, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath, log: (m) => quiet.push(m),
    });
    assert.deepEqual(r2.newlyDeferred, []);
    for (const id of ["0001-board-stages", "0002-board-defs", "0003-tracker-convergence", "0004-track1-card-model"]) {
      assert.ok(r2.deferred.includes(id), `${id} still defers (and is still retried)`);
    }
    // The runner's own deferral line is what must stay quiet. A migration body
    // may still log its own progress (0002 says board_defs was created).
    assert.ok(!quiet.some(isRunnerDeferralLine), `no repeated deferral lines: ${quiet.join(" | ")}`);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("the deferral bookkeeping can never sync to a paired instance", async () => {
  // instance-sync emits and applies only SYNCED_TABLES (an allowlist), and this
  // table is not in it — same position as schema_migrations itself.
  const { SYNCED_TABLES } = await import("../servers/sharing/instance-sync.js");
  assert.ok(!SYNCED_TABLES.includes("schema_migrations_deferred"));
  assert.ok(!SYNCED_TABLES.includes("schema_migrations"));
});

test("WIRING: both boot passes report only NEW deferrals, and the known ones get one quiet line", () => {
  // Without this anchor the callers could keep printing every known deferral
  // while the runner's bookkeeping looks perfectly correct.
  const index = readFileSync(join(import.meta.dirname, "..", "servers", "gateway", "index.js"), "utf8");
  assert.match(index, /if \(_resReg\.newlyDeferred\.length\)/,
    "the boot pass prints its 'deferred (will retry)' line only for new deferrals");
  assert.doesNotMatch(index, /if \(_resReg\.deferred\.length\)/);

  const postListen = readFileSync(join(import.meta.dirname, "..", "servers", "gateway", "boot", "post-listen.js"), "utf8");
  assert.match(postListen, /if \(r2\.newlyDeferred\.length\)/);
  assert.match(postListen, /console\.log\(`\[migrations:post-settle\] waiting on absent tables:/,
    "known deferrals still get ONE quiet line per boot, at console.log");
  assert.doesNotMatch(postListen, /console\.warn\(`\[migrations:post-settle\] waiting on absent tables/,
    "a known deferral is not a warning");
});

test("ORDER INVARIANT: registry runs after the schema guard, before the first createDbClient", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "servers", "gateway", "index.js"), "utf8");

  // Anchor on the guard's CALL, not its import: `runGuardedInitDb` first appears
  // in the dynamic-import destructure, so a plain indexOf would also match a
  // registry block wrongly placed INSIDE the guard block.
  const guardCall = src.indexOf("await runGuardedInitDb(");
  const registry = src.indexOf("runMigrations(");
  const firstClient = src.indexOf("initOAuthTables()");

  assert.ok(guardCall > 0, "the schema guard call must be present");
  assert.ok(registry > 0, "the registry call must be present");
  assert.ok(firstClient > 0, "initOAuthTables must be present");
  assert.ok(guardCall < registry, "registry must run AFTER the schema guard");
  assert.ok(registry < firstClient,
    "registry must run BEFORE the first createDbClient — createDbClient registers a " +
    "never-closed per-path WAL keeper, and a later migration-guard restore would " +
    "swap the DB file under a pinned inode (split-brain)");
});

test("item 48: a KNOWN deferral prints none of the migration's own lines; a failure prints them all", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: j } = await import("node:path");
  const { runMigrations } = await import("../scripts/migrations/runner.mjs");
  const dir = mkdtempSync(j(tmpdir(), "mig48-"));
  try {
    const migDir = j(dir, "m");
    (await import("node:fs")).mkdirSync(migDir);
    writeFileSync(j(migDir, "0001-quiet.mjs"),
      'export const id = "0001-quiet";\nexport function run({ log }) { log("  t.c: absent"); return { deferred: true, reason: "t absent" }; }\n');
    const args = { migrationsDir: migDir, dbPath: j(dir, "crow.db"), tasksDbPath: j(dir, "tasks.db") };
    const first = [];
    await runMigrations({ ...args, log: (m) => first.push(m) });
    assert.ok(first.includes("  t.c: absent"), "a new deferral prints the migration's lines");
    const second = [];
    const r = await runMigrations({ ...args, log: (m) => second.push(m) });
    assert.deepEqual(r.deferred, ["0001-quiet"]);
    assert.deepEqual(second, [], "a known deferral prints nothing at all, not even 'applying'");

    writeFileSync(j(migDir, "0002-boom.mjs"),
      'export const id = "0002-boom";\nexport function run({ log }) { log("  before the failure"); throw new Error("boom"); }\n');
    const third = [];
    await assert.rejects(runMigrations({ ...args, log: (m) => third.push(m) }), /boom/);
    assert.ok(third.includes("applying 0002-boom") && third.includes("  before the failure"),
      "a throwing migration still prints what it logged");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
