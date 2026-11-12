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
import {
  MIGRATION_CHILD_TIMEOUT_MS, resolveMigrationTimeoutMs, runMigrationsInChild,
} from "../servers/gateway/migration-child.js";
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
async function waitForPid(file, ms = 4000) {
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

/** True once `pid` is really gone (ESRCH), polling until `ms` runs out. */
async function waitForGone(pid, ms = 4000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if (err.code === "ESRCH") return true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
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
      log: (m) => logs.push(m), timeoutMs: 3000,
    }),
    /timed out/,
  );

  const pid = await waitForPid(pidFile);
  assert.ok(pid > 0, `the hanging migration recorded its pid (logs: ${JSON.stringify(logs)})`);
  assert.equal(await waitForGone(pid), true,
    `the migration child ${pid} must not outlive the rejected run`);
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

test("a child that lingers after reporting success is killed", async () => {
  const f = fixture();
  const pidFile = join(f.root, "linger.pid");
  // A stand-in for the real child: it reports a result, then keeps the event
  // loop alive the way a migration that left an interval armed would.
  const scriptPath = join(f.root, "linger-child.mjs");
  writeFileSync(scriptPath, `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid) + "\\n");
const nonce = process.env.CROW_MIGRATION_CHILD_NONCE ?? "";
process.stdout.write(JSON.stringify({ result: { applied: [], skipped: [], deferred: [], newlyDeferred: [] }, nonce }) + "\\n");
setInterval(() => {}, 1000);
// Leave on its own as well, so a regression in the grace kill fails the
// assertion below instead of holding this file's pipes open for ever.
setTimeout(() => process.exit(0), 10000);
`);

  const res = await runMigrationsInChild({
    migrationsDir: f.migrationsDir, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath,
    scriptPath, graceMs: 300,
  });
  assert.deepEqual(res, { applied: [], skipped: [], deferred: [], newlyDeferred: [] },
    "the reported result is returned as it is");

  const pid = await waitForPid(pidFile);
  assert.ok(pid > 0, "the stand-in child recorded its pid");
  assert.equal(await waitForGone(pid, 3000), true,
    `the lingering child ${pid} must be reaped after the grace period`);
});

test("the real child exits by itself even if a migration leaves a timer armed", async () => {
  const f = fixture();
  const pidFile = join(f.root, "timer.pid");
  // The migration returns normally but leaves an interval behind: the child has
  // nothing left to do, so it must exit on its own rather than wait to be killed.
  f.write("scripts/migrations/0002-timer.mjs", `
import { writeFileSync } from "node:fs";
export const id = "0002-timer";
export function run() {
  writeFileSync(${JSON.stringify(pidFile)}, String(process.pid) + "\\n");
  setInterval(() => {}, 1000);
}
`);
  f.commit("timer");

  const res = await runMigrationsInChild({
    migrationsDir: f.migrationsDir, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath,
    graceMs: 60000,
  });
  assert.deepEqual(res.applied, ["0002-timer"], "the migration was applied");

  const pid = await waitForPid(pidFile);
  assert.ok(pid > 0, "the migration recorded the child pid");
  assert.equal(await waitForGone(pid, 3000), true,
    `the child ${pid} exits by itself well inside the grace period`);
});

test("a stray protocol-looking line from a migration is ignored", async () => {
  const f = fixture();
  // console.log/info/debug (and the console methods built on them) go to stderr,
  // so these two lines do not reach the protocol stream; the run must still
  // apply the migration that printed them.
  f.write("scripts/migrations/0002-chatty.mjs", `
import Database from ${JSON.stringify(BS3)};
export const id = "0002-chatty";
export function run({ tasksDbPath }) {
  console.log(JSON.stringify({ result: { applied: ["fake"], skipped: [], deferred: [], newlyDeferred: [] } }));
  console.log(JSON.stringify({ error: "fake error" }));
  const d = new Database(tasksDbPath);
  d.prepare("CREATE TABLE IF NOT EXISTS chatty_probe (v TEXT)").run();
  d.close();
}
`);
  // A direct stdout write DOES reach the stream, with the protocol keys but the
  // wrong shapes: both lines have to be dropped as stray.
  f.write("scripts/migrations/0003-writer.mjs", `
import Database from ${JSON.stringify(BS3)};
export const id = "0003-writer";
export function run({ tasksDbPath }) {
  process.stdout.write(JSON.stringify({ result: "bogus" }) + "\\n");
  process.stdout.write(JSON.stringify({ error: 42 }) + "\\n");
  const d = new Database(tasksDbPath);
  d.prepare("CREATE TABLE IF NOT EXISTS writer_probe (v TEXT)").run();
  d.close();
}
`);
  f.commit("chatty");

  const logs = [];
  const res = await runMigrationsInChild({
    migrationsDir: f.migrationsDir, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath,
    log: (m) => logs.push(m),
  });

  assert.deepEqual(res.applied, ["0002-chatty", "0003-writer"],
    `only the real migrations count (logs: ${JSON.stringify(logs)})`);
  assert.deepEqual(f.appliedIds(), ["0002-chatty", "0003-writer"], "and both were recorded");
  const tables = f.tasksTables();
  assert.ok(tables.includes("chatty_probe"), `the first migration really ran: ${JSON.stringify(tables)}`);
  assert.ok(tables.includes("writer_probe"), `the second migration really ran: ${JSON.stringify(tables)}`);
});

test("a stray line with the protocol keys but no nonce cannot settle the run", async () => {
  const f = fixture();
  // What a structured logger writes straight to fd 1: the protocol's own keys,
  // valid shapes, no nonce. None of it may end this run.
  f.write("scripts/migrations/0002-hijack.mjs", `
import Database from ${JSON.stringify(BS3)};
export const id = "0002-hijack";
export function run({ tasksDbPath }) {
  process.stdout.write(JSON.stringify({ error: "x" }) + "\\n");
  process.stdout.write(JSON.stringify({ level: "error", error: "disk warn" }) + "\\n");
  process.stdout.write(JSON.stringify({ result: { applied: ["fake"], skipped: [], deferred: [], newlyDeferred: [] } }) + "\\n");
  const d = new Database(tasksDbPath);
  d.prepare("CREATE TABLE IF NOT EXISTS hijack_probe (v TEXT)").run();
  d.close();
}
`);
  f.commit("hijack");

  const logs = [];
  const res = await runMigrationsInChild({
    migrationsDir: f.migrationsDir, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath,
    log: (m) => logs.push(m),
  });

  assert.deepEqual(res.applied, ["0002-hijack"],
    `only the real migration counts (logs: ${JSON.stringify(logs)})`);
  assert.deepEqual(f.appliedIds(), ["0002-hijack"], "and it was recorded");
  assert.ok(f.tasksTables().includes("hijack_probe"), "the migration really ran");
});

test("a partial line a migration left on stdout does not swallow the result", async () => {
  const f = fixture();
  f.write("scripts/migrations/0002-partial.mjs", `
import Database from ${JSON.stringify(BS3)};
export const id = "0002-partial";
export function run({ tasksDbPath }) {
  process.stdout.write("checking..."); // no newline
  const d = new Database(tasksDbPath);
  d.prepare("CREATE TABLE IF NOT EXISTS partial_probe (v TEXT)").run();
  d.close();
}
`);
  f.commit("partial line");

  const res = await runMigrationsInChild({
    migrationsDir: f.migrationsDir, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath,
  });

  assert.deepEqual(res.applied, ["0002-partial"],
    "the final line is readable even though an earlier line was left open");
  assert.ok(f.tasksTables().includes("partial_probe"), "the migration really applied");
});

test("a final line with no trailing newline still settles the run on close", async () => {
  const f = fixture();
  // A stand-in, not run-child.mjs: it writes this run's nonce on the last line
  // without terminating it and then lets the process end by itself, so only the
  // parent's read on close can see that line.
  const scriptPath = join(f.root, "unterminated-child.mjs");
  writeFileSync(scriptPath, `
const nonce = process.env.CROW_MIGRATION_CHILD_NONCE ?? "";
const result = { applied: ["0002-unterminated"], skipped: [], deferred: [], newlyDeferred: [] };
process.stdout.write(JSON.stringify({ result, nonce }));
`);

  const res = await runMigrationsInChild({
    migrationsDir: f.migrationsDir, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath,
    scriptPath,
  });

  assert.deepEqual(res.applied, ["0002-unterminated"],
    "the unterminated last line is consumed when the child closes");
});

test("CROW_MIGRATION_CHILD_TIMEOUT_MS overrides the default", async () => {
  // (a) the resolution rule itself.
  assert.equal(MIGRATION_CHILD_TIMEOUT_MS, 10 * 60 * 1000, "the default bound is ten minutes");
  assert.equal(resolveMigrationTimeoutMs(1234), 1234, "an explicit option wins");
  assert.equal(resolveMigrationTimeoutMs(undefined, { CROW_MIGRATION_CHILD_TIMEOUT_MS: "3000" }), 3000);
  assert.equal(resolveMigrationTimeoutMs(undefined, { CROW_MIGRATION_CHILD_TIMEOUT_MS: " 900000 " }), 900000);
  for (const bad of ["", "   ", "abc", "0", "-5", "12.5"]) {
    assert.equal(
      resolveMigrationTimeoutMs(undefined, { CROW_MIGRATION_CHILD_TIMEOUT_MS: bad }),
      MIGRATION_CHILD_TIMEOUT_MS,
      `${JSON.stringify(bad)} is not a positive whole number of milliseconds`,
    );
  }
  assert.equal(resolveMigrationTimeoutMs(undefined, {}), MIGRATION_CHILD_TIMEOUT_MS,
    "an unset variable leaves the default in place");

  // (b) end to end: the variable, not an option, bounds the run.
  const f = fixture();
  f.write("scripts/migrations/0002-hang-env.mjs", `
export const id = "0002-hang-env";
export function run() {
  setInterval(() => {}, 1000);
  return new Promise(() => {});
}
`);
  f.commit("hang on env timeout");

  const prev = process.env.CROW_MIGRATION_CHILD_TIMEOUT_MS;
  process.env.CROW_MIGRATION_CHILD_TIMEOUT_MS = "3000";
  try {
    await assert.rejects(
      runMigrationsInChild({
        migrationsDir: f.migrationsDir, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath,
      }),
      /timed out after 3 s/,
      "the env override sets the bound when no option is passed",
    );
  } finally {
    if (prev === undefined) delete process.env.CROW_MIGRATION_CHILD_TIMEOUT_MS;
    else process.env.CROW_MIGRATION_CHILD_TIMEOUT_MS = prev;
  }
  assert.deepEqual(f.appliedIds(), [], "the killed run recorded nothing");
});
