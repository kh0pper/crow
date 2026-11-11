/**
 * Convergence migrates with a FRESH process (see servers/gateway/migration-child.js).
 *
 * The live gateway is long-running. ESM caches a module by URL for the life of
 * the process, so a migration pulled in the same update that statically imports
 * a shared module the gateway already loaded at boot links against the OLD
 * namespace and fails with "does not provide an export named X" — and since the
 * process never restarts, it fails the same way on every tick, forever.
 *
 * The fixture is the same shape as tests/convergence-import-check.test.js: one
 * temp git checkout, one instance (crow.db at SCHEMA_GENERATION + tasks.db),
 * boot sha set, restart/supervised seams captured. Test 1 imports the boot
 * version of a shared module into THIS process before the second commit, which
 * is exactly what a running gateway has in its module cache.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { SCHEMA_GENERATION } from "../servers/shared/schema-version.js";
import { runMigrations } from "../scripts/migrations/runner.mjs";
import { runMigrationsInChild } from "../servers/gateway/migration-child.js";
import {
  _setLockWaitForTest, setBootSha, _setRestartForTest, _setSupervisedForTest, convergeInstance,
  readPending,
} from "../servers/gateway/convergence.js";

delete process.env.INVOCATION_ID;
delete process.env.CROW_SUPERVISED;
delete process.env.CROW_DISABLE_CONVERGE;
_setLockWaitForTest({ waitMs: 4000, pollMs: 20 });

const g = (cwd, ...a) => execFileSync("git", a, { cwd, stdio: "pipe" }).toString().trim();
const BS3 = pathToFileURL(createRequire(import.meta.url).resolve("better-sqlite3")).href;

const restarts = [];
function arm() {
  restarts.length = 0;
  _setSupervisedForTest(() => true);
  _setRestartForTest((_l, m) => restarts.push(m));
}

const _fixtures = [];
after(() => {
  _setRestartForTest(null);
  _setSupervisedForTest(null);
  _setLockWaitForTest(null);
  setBootSha(null);
  for (const f of _fixtures) f.cleanup();
  _fixtures.length = 0;
});

const BOOT_HIST = `export function A() { return "a"; }\n`;
const NEXT_HIST = `export function A() { return "a"; }\nexport function B() { return "fresh"; }\n`;

/**
 * One checkout one commit behind: `boot` is the sha this process runs, HEAD is
 * the pulled sha. The work tree is ESM (package.json type:module) so a shared
 * `.js` module really is an ES module whose export list is fixed at link time.
 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "conv-fm-"));
  const work = join(root, "work");
  mkdirSync(join(work, "scripts", "migrations"), { recursive: true });
  mkdirSync(join(work, "servers", "gateway"), { recursive: true });
  mkdirSync(join(work, "servers", "shared"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", work], { stdio: "pipe" });
  g(work, "config", "user.email", "t@t");
  g(work, "config", "user.name", "t");
  writeFileSync(join(work, "package.json"), `${JSON.stringify({ name: "fixture", type: "module" })}\n`);
  writeFileSync(join(work, "scripts", "init-db.js"), "process.exit(0);\n");
  writeFileSync(join(work, "servers", "gateway", "index.js"), "process.exit(0);\n");
  writeFileSync(join(work, "servers", "shared", "hist.js"), BOOT_HIST);
  g(work, "add", "-A");
  g(work, "commit", "-q", "-m", "boot");
  const boot = g(work, "rev-parse", "HEAD");

  const dataDir = join(root, "inst", "data");
  mkdirSync(dataDir, { recursive: true });
  const tasksDbPath = join(dataDir, "tasks.db");
  const t = new Database(tasksDbPath);
  t.prepare("CREATE TABLE tasks_items (id INTEGER PRIMARY KEY, title TEXT)").run();
  t.close();
  const dbPath = join(dataDir, "crow.db");
  const c = new Database(dbPath);
  for (const tbl of ["memories", "dashboard_settings", "crow_context"]) {
    c.prepare(`CREATE TABLE ${tbl} (id INTEGER PRIMARY KEY)`).run();
  }
  c.pragma(`user_version = ${SCHEMA_GENERATION}`);
  c.close();

  const f = {
    root, work, boot, dataDir, tasksDbPath, dbPath,
    migrationsDir: join(work, "scripts", "migrations"),
    instance: { dataDir, dbPath, tasksDbPath },
    lock: join(work, ".git", "crow-auto-update.lock"),
    write(rel, content) {
      const p = join(work, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
    },
    commit(msg = "next") {
      g(work, "add", "-A");
      g(work, "commit", "-q", "-m", msg);
      return g(work, "rev-parse", "HEAD");
    },
    head: () => g(work, "rev-parse", "HEAD"),
    /** Rows the registry recorded in this instance's crow.db (none if it has no table yet). */
    appliedIds() {
      const d = new Database(dbPath);
      try {
        const has = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
        return has ? d.prepare("SELECT id FROM schema_migrations ORDER BY id").all().map((r) => r.id) : [];
      } finally { d.close(); }
    },
    /** Table names in this instance's tasks.db. */
    tasksTables() {
      const d = new Database(tasksDbPath);
      try {
        return d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
      } finally { d.close(); }
    },
    query(dbFile, sql, params = []) {
      const d = new Database(dbFile);
      try { return d.prepare(sql).all(...params); } finally { d.close(); }
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  _fixtures.push(f);
  return f;
}

const NEEDS_B = `
import Database from ${JSON.stringify(BS3)};
import { B } from "../../servers/shared/hist.js";
export const id = "0002-needs-b";
export function run({ tasksDbPath }) {
  const d = new Database(tasksDbPath);
  d.prepare("CREATE TABLE IF NOT EXISTS fresh_probe (v TEXT)").run();
  d.prepare("INSERT INTO fresh_probe (v) VALUES (?)").run(B());
  d.close();
}`;

test("a migration that imports a module this process already loaded runs in a fresh child", async () => {
  const f = fixture();

  // The running gateway evaluated the BOOT version of the shared module at boot.
  // Importing it here caches that exact namespace by URL, as the gateway has.
  await import(pathToFileURL(join(f.work, "servers", "shared", "hist.js")).href);

  f.write("servers/shared/hist.js", NEXT_HIST);
  f.write("scripts/migrations/0002-needs-b.mjs", NEEDS_B);
  const head = f.commit("needs B");
  arm();
  setBootSha(f.boot);

  // (a) the mechanism itself: in THIS process the new migration links against
  // the stale namespace and the run fails. Without this the test could pass for
  // the wrong reason (e.g. a migration that never needed B).
  await assert.rejects(
    runMigrations({ migrationsDir: f.migrationsDir, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath }),
    /does not provide an export named 'B'/,
    "the in-process runner must hit the stale-module link error",
  );
  assert.deepEqual(f.appliedIds(), [], "the failed in-process run recorded nothing");

  // (b) convergence runs it in a fresh child and succeeds.
  const r = await convergeInstance({ appRoot: f.work, instance: f.instance });

  assert.equal(r.converged, true, JSON.stringify(r));
  assert.equal(r.sha, head);
  assert.ok(r.applied.includes("0002-needs-b"), JSON.stringify(r.applied));
  assert.deepEqual(f.query(f.tasksDbPath, "SELECT v FROM fresh_probe").map((row) => row.v), ["fresh"],
    "the migration ran with the module as it is on disk now");
  assert.equal(restarts.length, 1, "converged instances restart into the new code");
  assert.notEqual(readPending(f.dataDir), null, "and leave the boot-verification cookie");
  assert.equal(f.head(), head, "the peer path never moves the tree");
});

test("a migration that throws reaches the caller unchanged, with no restart and no cookie", async () => {
  const f = fixture();
  f.write("scripts/migrations/0002-boom.mjs", `
export const id = "0002-boom";
export function run() { throw new Error("boom migration"); }
`);
  f.commit("boom");
  arm();
  setBootSha(f.boot);

  await assert.rejects(
    convergeInstance({ appRoot: f.work, instance: f.instance }),
    /boom migration/,
    "the migration's own message must survive the child boundary",
  );

  assert.deepEqual(restarts, [], "nothing may restart into a failed migration");
  assert.equal(readPending(f.dataDir), null, "no boot cookie after a failed convergence");
  assert.deepEqual(f.appliedIds(), [], "the failure is not recorded as applied");
  assert.ok(!f.tasksTables().includes("boom_probe"), "the store is untouched");
});

/** The pid the hanging migration wrote, or 0 if it never appeared. */
async function waitForPid(file, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const raw = readFileSync(file, "utf8");
      if (/^\d+\n$/.test(raw)) return Number(raw.trim());
    } catch { /* not written yet */ }
    await new Promise((r) => setTimeout(r, 25));
  }
  return 0;
}

test("a wedged migration times out and its process is killed", async () => {
  const f = fixture();
  const pidFile = join(f.root, "child.pid");
  // The interval is what keeps the child ALIVE: a pending promise on its own
  // does not hold the event loop, so Node would exit 0 instead of hanging.
  f.write("scripts/migrations/0002-hang.mjs", `
import { writeFileSync } from "node:fs";
export const id = "0002-hang";
export function run() {
  writeFileSync(${JSON.stringify(pidFile)}, String(process.pid) + "\\n");
  setInterval(() => {}, 1000);
  return new Promise(() => {});
}
`);
  f.commit("hang");

  const logs = [];
  await assert.rejects(
    runMigrationsInChild({
      migrationsDir: f.migrationsDir, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath,
      log: (m) => logs.push(m), timeoutMs: 700,
    }),
    /timed out/,
  );

  const pid = await waitForPid(pidFile);
  assert.ok(pid > 0, `the hanging migration recorded its pid (logs: ${JSON.stringify(logs)})`);

  const deadline = Date.now() + 3000;
  let alive = true;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if (err.code === "ESRCH") { alive = false; break; }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(alive, false, `the migration child ${pid} must not outlive the rejected run`);
});

test("a child that dies without an error line reports its exit code", async () => {
  const f = fixture();
  f.write("scripts/migrations/0002-die.mjs", `
export const id = "0002-die";
export function run() { process.exit(3); }
`);
  f.commit("die");

  await assert.rejects(
    runMigrationsInChild({
      migrationsDir: f.migrationsDir, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath,
    }),
    /exited 3/,
  );
});

test("a tree without the child script falls back to in-process migrations and says so", async () => {
  const f = fixture();
  f.write("scripts/migrations/0002-fallback.mjs", `
import Database from ${JSON.stringify(BS3)};
export const id = "0002-fallback";
export function run({ tasksDbPath }) {
  const d = new Database(tasksDbPath);
  d.prepare("CREATE TABLE IF NOT EXISTS fallback_probe (v TEXT)").run();
  d.close();
}
`);
  f.commit("fallback");

  const logs = [];
  const res = await runMigrationsInChild({
    migrationsDir: f.migrationsDir, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath,
    log: (m) => logs.push(m),
    scriptPath: join(f.root, "no-such-tree", "run-child.mjs"),
  });

  assert.deepEqual(res.applied, ["0002-fallback"]);
  assert.ok(logs.some((l) => /falling back/i.test(l)), `the fallback is logged: ${JSON.stringify(logs)}`);
  assert.ok(f.tasksTables().includes("fallback_probe"), "the in-process run really applied it");
});