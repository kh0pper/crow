/**
 * The executable gate for co-hosted convergence.
 *
 * TWO instance data dirs share ONE git checkout, exactly as crow-gateway /
 * crow-mpa-gateway / crow-r4-gateway share ~/crow. Moving origin forward must
 * leave BOTH instances migrated — including the one that LOSES the checkout
 * lock. A review that only reads the diff cannot tell you whether a
 * restart-into-newer-code actually migrates; this can.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { checkForUpdates, _setAppRootForTest, _setDbForTest } from "../servers/gateway/auto-update.js";
import { _setAlertChannelsForTest } from "../servers/shared/migration-guard.js";
import {
  setBootSha, _setRestartForTest, _setSupervisedForTest, convergeInstance,
  readPending,
} from "../servers/gateway/convergence.js";

// Never let the suite believe it is supervised: a systemd-launched context
// leaks INVOCATION_ID and the restart branch would arm this process's exit.
delete process.env.INVOCATION_ID;
delete process.env.CROW_SUPERVISED;

// The update failure paths call fireMigrationAlert. Unstubbed, the suite sends
// a REAL ntfy push and email.
_setAlertChannelsForTest({ sendNtfyNotification: async () => {}, sendEmailNotification: async () => {} });

// The TREE half resolves its guard DB from env. Unpinned, a bare `node --test`
// run resolves to ~/.crow/data/crow.db and migration-guard would BACK UP and
// PRUNE the live primary instance's data dir. Pin scratch paths; RESTORE (never
// delete) in after(), since run-suite.mjs sets these for the whole process.
const _prevEnv = {
  CROW_HOME: process.env.CROW_HOME,
  CROW_DATA_DIR: process.env.CROW_DATA_DIR,
  CROW_DB_PATH: process.env.CROW_DB_PATH,
};
const _scratch = mkdtempSync(join(tmpdir(), "conv-env-"));
mkdirSync(join(_scratch, "data"), { recursive: true });
process.env.CROW_HOME = _scratch;
process.env.CROW_DATA_DIR = join(_scratch, "data");
process.env.CROW_DB_PATH = join(_scratch, "data", "crow.db");

const REAL_APP_ROOT = join(import.meta.dirname, "..");
const g = (cwd, ...a) => execFileSync("git", a, { cwd, stdio: "pipe" }).toString().trim();

/** Captured restarts, so the gate can assert without arming a real exit. */
const restarts = [];

/** Matches the shape auto-update's getSettings/saveSetting expect. */
function stubDb(rows = [{ key: "auto_update_enabled", value: "true" }]) {
  return {
    execute: async ({ sql }) => (/^SELECT/i.test(sql) ? { rows } : { rows: [] }),
  };
}

const _fixtures = [];
after(() => {
  _setAppRootForTest(REAL_APP_ROOT);
  _setDbForTest(null);
  _setRestartForTest(null);
  _setSupervisedForTest(null);
  setBootSha(null);
  for (const [k, v] of Object.entries(_prevEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(_scratch, { recursive: true, force: true });
  for (const f of _fixtures) f.cleanup();
  _fixtures.length = 0;
});

export function twoInstanceFixture() {
  const root = mkdtempSync(join(tmpdir(), "converge-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work"); // the ONE shared checkout
  execFileSync("git", ["init", "--bare", "-b", "main", origin], { stdio: "pipe" });
  execFileSync("git", ["clone", origin, work], { stdio: "pipe" });
  g(work, "config", "user.email", "t@t");
  g(work, "config", "user.name", "t");

  mkdirSync(join(work, "scripts", "migrations"), { recursive: true });
  // runLockedUpdate CHECKS init-db's exit code; without a runnable one the
  // fixture update always reports failure and withholds the restart.
  writeFileSync(join(work, "scripts", "init-db.js"), "process.exit(0);\n");
  g(work, "add", "-A");
  g(work, "commit", "-m", "seed");
  g(work, "push", "origin", "main");

  const instances = ["alpha", "beta"].map((name) => {
    const dataDir = join(root, name, "data");
    mkdirSync(dataDir, { recursive: true });
    const dbPath = join(dataDir, "crow.db");
    const tasksDbPath = join(dataDir, "tasks.db");
    const t = new Database(tasksDbPath);
    t.prepare("CREATE TABLE tasks_items (id INTEGER PRIMARY KEY, title TEXT)").run();
    t.close();
    new Database(dbPath).close();
    return { name, dataDir, dbPath, tasksDbPath };
  });

  /** Land a new migration on origin, then rewind the shared checkout so it is
   *  genuinely BEHIND — the state a real deploy creates. */
  const advanceOrigin = (filename, body) => {
    writeFileSync(join(work, "scripts", "migrations", filename), body);
    g(work, "add", "-A");
    g(work, "commit", "-m", `add ${filename}`);
    g(work, "push", "origin", "main");
    g(work, "reset", "--hard", "HEAD~1");
  };

  const f = { root, origin, work, instances, advanceOrigin,
              cleanup: () => rmSync(root, { recursive: true, force: true }) };
  _fixtures.push(f);
  return f;
}

// A bare `import Database from "better-sqlite3"` cannot resolve from
// os.tmpdir() — there is no node_modules anywhere on that path. Bake in the
// resolved absolute URL.
const BS3 = pathToFileURL(createRequire(import.meta.url).resolve("better-sqlite3")).href;

export const MIGRATION_BODY = `
import Database from ${JSON.stringify(BS3)};
export const id = "0002-converge-probe";
export function run({ tasksDbPath }) {
  const d = new Database(tasksDbPath);
  const have = d.prepare("PRAGMA table_info(tasks_items)").all().map((c) => c.name);
  if (!have.includes("probe")) d.prepare("ALTER TABLE tasks_items ADD COLUMN probe TEXT").run();
  d.close();
}`;

export function hasProbe(tasksDbPath) {
  const d = new Database(tasksDbPath);
  const cols = d.prepare("PRAGMA table_info(tasks_items)").all().map((c) => c.name);
  d.close();
  return cols.includes("probe");
}

test("BOTH co-hosted instances converge — the lock loser must not starve", async () => {
  const f = twoInstanceFixture();
  restarts.length = 0;

  // Capture the sha we are "running" BEFORE origin moves. Without this,
  // getBootSha() is null and convergence refuses ("no-boot-sha") before it ever
  // reaches runMigrations — the gate would fail for the wrong reason.
  setBootSha(g(f.work, "rev-parse", "HEAD"));
  f.advanceOrigin("0002-converge-probe.mjs", MIGRATION_BODY);
  _setAppRootForTest(f.work);

  // The suite runs deliberately unsupervised, so convergence would otherwise
  // stop at its supervisor guard. Inject both seams rather than setting
  // CROW_SUPERVISED, which would arm a real process.exit(1) in this runner.
  _setSupervisedForTest(() => true);
  _setRestartForTest((_log, msg) => { restarts.push(msg); });

  // alpha: no contention — wins the lock, pulls, converges.
  _setDbForTest(stubDb());
  const a = await checkForUpdates({ instance: f.instances[0] });

  // beta: HOLD the lock so beta genuinely LOSES it. Sequential awaited calls do
  // NOT contend — checkForUpdates releases in a finally — so without this beta
  // would simply find "already up to date" and the gate would prove nothing.
  const lockFile = join(f.work, ".git", "crow-auto-update.lock");
  writeFileSync(lockFile, `${process.pid}\n${new Date().toISOString()}\n`);
  _setDbForTest(stubDb());
  const b = await checkForUpdates({ instance: f.instances[1] });
  rmSync(lockFile, { force: true });

  assert.equal(b.skipped, "locked", "beta must actually have taken the lock-loss path");
  assert.ok(hasProbe(f.instances[0].tasksDbPath), "alpha (lock winner) must be migrated");
  assert.ok(hasProbe(f.instances[1].tasksDbPath),
    "beta LOST the lock and must STILL migrate its own stores — this is the starvation bug");
  assert.equal(a.pulled, true, "the lock winner performs the pull");
  assert.equal(b.pulled, false, "the lock loser must not pull — the tree is shared");
  assert.equal(b.converged, true, "the lock loser must still converge");
  assert.equal(restarts.length, 2, "each converging instance restarts exactly once");
});

test("convergeInstance writes the cookie with the REAL pre-restart baseline", async () => {
  const f = twoInstanceFixture();
  restarts.length = 0;
  const { connectedServers } = await import("../servers/gateway/proxy.js");
  connectedServers.clear();
  connectedServers.set("tasks", { status: "connected", isAddon: true });
  _setSupervisedForTest(() => true);
  _setRestartForTest((_log, msg) => { restarts.push(msg); });
  try {
    setBootSha(g(f.work, "rev-parse", "HEAD"));
    f.advanceOrigin("0002-converge-probe.mjs", MIGRATION_BODY);
    // Fast-forward the shared checkout the way the tree half would.
    g(f.work, "pull", "--ff-only", "origin", "main");

    await convergeInstance({ appRoot: f.work, instance: f.instances[0] });

    const p = readPending(f.instances[0].dataDir);
    assert.ok(p, "convergence MUST write the cookie before restarting");
    assert.equal(p.sha, g(f.work, "rev-parse", "HEAD"));
    assert.deepEqual(p.baseline, { tasks: "connected" },
      "the baseline must be the live snapshot, not an empty object");
    assert.equal(restarts.length, 1, "exactly one restart per convergence");
  } finally { connectedServers.clear(); }
});

test("a CURRENT instance does not converge; a null boot sha REFUSES", async () => {
  const f = twoInstanceFixture();
  restarts.length = 0;
  _setSupervisedForTest(() => true);
  _setRestartForTest((_log, msg) => { restarts.push(msg); });
  const head = g(f.work, "rev-parse", "HEAD");

  setBootSha(head);
  const cur = await convergeInstance({ appRoot: f.work, instance: f.instances[0] });
  assert.equal(cur.skipped, "current",
    "an up-to-date instance must not migrate and restart on every tick");

  setBootSha(null);
  const nul = await convergeInstance({ appRoot: f.work, instance: f.instances[0] });
  assert.equal(nul.skipped, "no-boot-sha",
    "a null boot sha must REFUSE — treating it as 'not current' converges forever");

  assert.equal(restarts.length, 0, "neither case may restart");
});

test("an UNSUPERVISED instance migrates but writes NO cookie", async () => {
  const f = twoInstanceFixture();
  restarts.length = 0;
  _setSupervisedForTest(() => false);
  _setRestartForTest((_log, msg) => { restarts.push(msg); });

  setBootSha(g(f.work, "rev-parse", "HEAD"));
  f.advanceOrigin("0002-converge-probe.mjs", MIGRATION_BODY);
  g(f.work, "pull", "--ff-only", "origin", "main");

  const r = await convergeInstance({ appRoot: f.work, instance: f.instances[1] });
  assert.equal(r.skipped, "unsupervised");
  assert.equal(readPending(f.instances[1].dataDir), null,
    "no supervisor means no restart — a cookie here would expire and quarantine a HEALTHY sha");
  assert.equal(restarts.length, 0);
  assert.ok(hasProbe(f.instances[1].tasksDbPath), "migrations still ran");
});

test("the restart is scheduled by convergence ONLY, never by the update's success path", () => {
  // The success path returning without a restart is not observable from a test
  // (scheduleSupervisedRestart no-ops unsupervised), so anchor on the source —
  // the same technique the boot ORDER INVARIANT test uses. A restart there
  // fires a 1.5s exit timer while convergence is still migrating.
  const src = readFileSync(join(import.meta.dirname, "..", "servers", "gateway", "auto-update.js"), "utf8");
  const successReturn = src.indexOf("return { updated: true, from: currentVersion, to: newVersion };");
  assert.ok(successReturn > 0, "the success return must be present");

  const before = src.slice(0, successReturn);
  const lastRestart = before.lastIndexOf("scheduleSupervisedRestart(");
  const lossPath = before.lastIndexOf("Restarting to reopen the restored database");
  assert.ok(lastRestart < lossPath,
    "the only scheduleSupervisedRestart before the success return must be the " +
    "migration-guard LOSS path (which reopens a restored DB file); convergence owns the rest");
});
