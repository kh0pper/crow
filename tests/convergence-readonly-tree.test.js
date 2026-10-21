/**
 * Queue item 19, step 1: a co-hosted instance with a READ-ONLY view of the
 * shared checkout (CROW_AUTO_UPDATE_TREE=external here; a non-writable .git
 * is covered in auto-update-readonly-tree.test.js) converges onto whatever the
 * tree holds, never while a puller holds the lock, and re-checks right before
 * the restart because it only OBSERVED the lock, never held it.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { SCHEMA_GENERATION } from "../servers/shared/schema-version.js";
import { _setAlertChannelsForTest } from "../servers/shared/migration-guard.js";
import {
  _setLockWaitForTest, setBootSha, _setRestartForTest, _setSupervisedForTest, convergeInstance,
} from "../servers/gateway/convergence.js";

delete process.env.INVOCATION_ID;
delete process.env.CROW_SUPERVISED;
_setAlertChannelsForTest({ sendNtfyNotification: async () => {}, sendEmailNotification: async () => {} });
_setLockWaitForTest({ waitMs: 300, pollMs: 25 });

const prevTree = process.env.CROW_AUTO_UPDATE_TREE;
const roots = [];
after(() => {
  _setRestartForTest(null); _setSupervisedForTest(null); _setLockWaitForTest(null); setBootSha(null);
  if (prevTree === undefined) delete process.env.CROW_AUTO_UPDATE_TREE; else process.env.CROW_AUTO_UPDATE_TREE = prevTree;
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const g = (cwd, ...a) => execFileSync("git", a, { cwd, stdio: "pipe" }).toString().trim();
const BS3 = pathToFileURL(createRequire(import.meta.url).resolve("better-sqlite3")).href;

/** A checkout one migration ahead of the running sha, and one instance. */
function fixture(migrationExtra = "") {
  const root = mkdtempSync(join(tmpdir(), "conv-ro-"));
  roots.push(root);
  const work = join(root, "work");
  mkdirSync(join(work, "scripts", "migrations"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", work], { stdio: "pipe" });
  g(work, "config", "user.email", "t@t"); g(work, "config", "user.name", "t");
  writeFileSync(join(work, "scripts", "init-db.js"), "process.exit(0);\n");
  g(work, "add", "-A"); g(work, "commit", "-q", "-m", "seed");
  const bootSha = g(work, "rev-parse", "HEAD");
  writeFileSync(join(work, "scripts", "migrations", "0002-ro-probe.mjs"), `
import Database from ${JSON.stringify(BS3)};
import { writeFileSync } from "node:fs";
export const id = "0002-ro-probe";
export function run({ tasksDbPath }) {
  const d = new Database(tasksDbPath);
  const have = d.prepare("PRAGMA table_info(tasks_items)").all().map((c) => c.name);
  if (!have.includes("probe")) d.prepare("ALTER TABLE tasks_items ADD COLUMN probe TEXT").run();
  d.close();
  ${migrationExtra}
}`);
  g(work, "add", "-A"); g(work, "commit", "-q", "-m", "migration");
  const dataDir = join(root, "inst", "data");
  mkdirSync(dataDir, { recursive: true });
  const t = new Database(join(dataDir, "tasks.db"));
  t.prepare("CREATE TABLE tasks_items (id INTEGER PRIMARY KEY, title TEXT)").run(); t.close();
  const c = new Database(join(dataDir, "crow.db"));
  for (const tbl of ["memories", "dashboard_settings", "crow_context"]) c.prepare(`CREATE TABLE ${tbl} (id INTEGER PRIMARY KEY)`).run();
  c.pragma(`user_version = ${SCHEMA_GENERATION}`); c.close();
  return { work, bootSha, lock: join(work, ".git", "crow-auto-update.lock"),
    instance: { dataDir, dbPath: join(dataDir, "crow.db"), tasksDbPath: join(dataDir, "tasks.db") } };
}

function arm(f) {
  const restarted = [];
  process.env.CROW_AUTO_UPDATE_TREE = "external";
  _setSupervisedForTest(() => true);
  _setRestartForTest((_l, m) => restarted.push(m));
  setBootSha(f.bootSha);
  return restarted;
}

test("a read-only tree with no puller: the instance migrates and restarts into the tree's HEAD, writing no lock", async () => {
  const f = fixture();
  const restarted = arm(f);
  const r = await convergeInstance({ appRoot: f.work, instance: f.instance });
  assert.equal(r.converged, true, JSON.stringify(r));
  assert.equal(restarted.length, 1);
  assert.ok(!execFileSync("ls", ["-a", join(f.work, ".git")]).toString().includes("crow-auto-update.lock"));
});

test("a read-only tree while a puller holds the lock: deferred, no restart", async () => {
  const f = fixture();
  const restarted = arm(f);
  writeFileSync(f.lock, `${process.pid}\n${new Date().toISOString()}\n`);
  const r = await convergeInstance({ appRoot: f.work, instance: f.instance });
  assert.equal(r.skipped, "tree-busy");
  assert.deepEqual(restarted, []);
  assert.ok(execFileSync("cat", [f.lock]).toString().startsWith(String(process.pid)), "the observer never touched the holder's lock");
});

test("a puller that starts AFTER the observer looked: the pre-restart re-check defers the restart", async () => {
  // The migration itself plants a live lock, i.e. a co-hosted gateway began
  // pulling while this instance migrated.
  // The test's own pid: migrations may run in a child that is gone (stale) by the re-check.
  const f = fixture(`writeFileSync(${JSON.stringify("LOCKPATH")}, "${process.pid}\\n" + new Date().toISOString() + "\\n");`);
  const body = join(f.work, "scripts", "migrations", "0002-ro-probe.mjs");
  const src = execFileSync("cat", [body]).toString().replace("LOCKPATH", f.lock);
  writeFileSync(body, src);
  g(f.work, "commit", "-q", "-am", "point at the lock");
  const restarted = arm(f);
  const r = await convergeInstance({ appRoot: f.work, instance: f.instance });
  const { existsSync: ex } = await import("node:fs");
  assert.ok(ex(f.lock), "the migration planted the lock");
  assert.equal(r.skipped, "tree-busy", JSON.stringify(r));
  assert.deepEqual(restarted, [], "never restarts into a tree that is being pulled");
});
