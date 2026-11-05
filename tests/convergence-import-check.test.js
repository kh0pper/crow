/**
 * L0.4 — the peer-side import check, plus the two refusal gates that surround it
 * (audit N1c-3, S7 and B3).
 *
 * A co-hosted gateway converges on its OWN restart, with its OWN env. The
 * puller's check passing says nothing about this instance: an instance-path gate
 * refusal or a missing credential only exists here. So the peer runs the same
 * check BEFORE its migrations, and also refuses any sha the updater already
 * rolled back — otherwise it would migrate and restart into it.
 *
 * The tree is NOT rolled back from this path (the puller's check passed, so the
 * other instances may be running the sha healthily).
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { SCHEMA_GENERATION } from "../servers/shared/schema-version.js";
import { _setAlertChannelsForTest } from "../servers/shared/migration-guard.js";
import { writeUpdateQuarantine } from "../servers/shared/update-quarantine.js";
import {
  _setLockWaitForTest, setBootSha, _setRestartForTest, _setSupervisedForTest, convergeInstance,
  readPending, readConvQuarantine,
} from "../servers/gateway/convergence.js";

delete process.env.INVOCATION_ID;
delete process.env.CROW_SUPERVISED;
_setAlertChannelsForTest({ sendNtfyNotification: async () => {}, sendEmailNotification: async () => {} });
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

const SEAM_THROWS = `import "./boom.js";
if (process.env.CROW_GATEWAY_IMPORT_CHECK === "1") { process.stdout.write("crow-gateway-import-ok\\n"); process.exit(0); }
`;

const BOOM = `throw new Error("this gateway graph does not load");
`;

const MIGRATION = `
import Database from ${JSON.stringify(BS3)};
export const id = "0002-ic-probe";
export function run({ tasksDbPath }) {
  const d = new Database(tasksDbPath);
  const have = d.prepare("PRAGMA table_info(tasks_items)").all().map((c) => c.name);
  if (!have.includes("probe")) d.prepare("ALTER TABLE tasks_items ADD COLUMN probe TEXT").run();
  d.close();
}`;

/**
 * One checkout, one instance, one commit behind: `boot` is the sha this process
 * runs, HEAD is `mid` (the pulled sha whose gateway does not load).
 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "conv-ic-"));
  const work = join(root, "work");
  mkdirSync(join(work, "scripts", "migrations"), { recursive: true });
  mkdirSync(join(work, "servers", "gateway"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", work], { stdio: "pipe" });
  g(work, "config", "user.email", "t@t");
  g(work, "config", "user.name", "t");
  writeFileSync(join(work, "scripts", "init-db.js"), "process.exit(0);\n");
  writeFileSync(join(work, "servers", "gateway", "index.js"), "process.exit(0);\n");
  g(work, "add", "-A");
  g(work, "commit", "-q", "-m", "boot");
  const boot = g(work, "rev-parse", "HEAD");

  writeFileSync(join(work, "scripts", "migrations", "0002-ic-probe.mjs"), MIGRATION);
  writeFileSync(join(work, "servers", "gateway", "index.js"), SEAM_THROWS);
  writeFileSync(join(work, "servers", "gateway", "boom.js"), BOOM);
  g(work, "add", "-A");
  g(work, "commit", "-q", "-m", "mid");
  const mid = g(work, "rev-parse", "HEAD");

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
    root, work, boot, mid, dataDir, tasksDbPath,
    instance: { dataDir, dbPath, tasksDbPath },
    lock: join(work, ".git", "crow-auto-update.lock"),
    gitDir: join(work, ".git"),
    hasProbe: () => {
      const d = new Database(tasksDbPath);
      const cols = d.prepare("PRAGMA table_info(tasks_items)").all().map((col) => col.name);
      d.close();
      return cols.includes("probe");
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  _fixtures.push(f);
  return f;
}

test("the peer withholds migration and restart when its own env fails the import check", async () => {
  const f = fixture();
  arm();
  setBootSha(f.boot);

  const r = await convergeInstance({ appRoot: f.work, instance: f.instance });

  assert.equal(r.skipped, "import-check-failed", JSON.stringify(r));
  assert.deepEqual(restarts, [], "nothing may restart into a sha this instance cannot load");
  assert.equal(readPending(f.dataDir), null, "no boot cookie for a refused convergence");
  assert.equal(readConvQuarantine({ appRoot: f.work, dataDir: f.dataDir }).sha, f.mid,
    "the sha is quarantined on this host");
  assert.equal(f.hasProbe(), false, "the check runs BEFORE runMigrations — the store is untouched");
  assert.equal(g(f.work, "rev-parse", "HEAD"), f.mid, "the peer path never resets the tree");
});

test("a sha the updater rolled back is refused by every peer (B3)", async () => {
  const f = fixture();
  arm();
  setBootSha(f.boot);
  writeUpdateQuarantine({ gitDir: f.gitDir, sha: f.mid, previous: f.boot, reason: "import-check" });

  const r = await convergeInstance({ appRoot: f.work, instance: f.instance });

  assert.equal(r.skipped, "update-quarantined", JSON.stringify(r));
  assert.deepEqual(restarts, []);
  assert.equal(f.hasProbe(), false);
  assert.equal(g(f.work, "rev-parse", "HEAD"), f.mid);
});

test("an EXPIRED update quarantine does not block a peer", async () => {
  const f = fixture();
  arm();
  setBootSha(f.boot);
  // A tree that loads (no seam: the check is skipped) and an expired marker
  // naming it: the transient reason's TTL has passed, so the peer converges.
  writeFileSync(join(f.work, "servers", "gateway", "index.js"), "process.exit(0);\n");
  g(f.work, "commit", "-q", "-am", "loads again");
  const head = g(f.work, "rev-parse", "HEAD");
  writeUpdateQuarantine({
    gitDir: f.gitDir, sha: head, reason: "import-timeout", now: Date.now() - 7 * 60 * 60 * 1000,
  });

  const r = await convergeInstance({ appRoot: f.work, instance: f.instance });

  assert.equal(r.converged, true, JSON.stringify(r));
  assert.equal(restarts.length, 1);
});

test("HEAD is re-read under the lock: a tree that moved yields tree-moved, no cookie (S7)", async () => {
  const f = fixture();
  arm();
  setBootSha(f.boot);

  writeFileSync(f.lock, `${process.pid}\n${new Date().toISOString()}\n`);
  const pending = convergeInstance({ appRoot: f.work, instance: f.instance });
  setTimeout(() => {
    g(f.work, "commit", "-q", "--allow-empty", "-m", "moved while waiting");
    rmSync(f.lock, { force: true });
  }, 150);
  const r = await pending;

  assert.equal(r.skipped, "tree-moved", JSON.stringify(r));
  assert.equal(r.sha, g(f.work, "rev-parse", "HEAD"), "the decision names the sha the tree holds now");
  assert.equal(readPending(f.dataDir), null, "no cookie for a tree we did not converge to");
  assert.deepEqual(restarts, []);
});

test("HEAD re-read under the lock: back at the boot sha means nothing to do", async () => {
  const f = fixture();
  arm();
  setBootSha(f.boot);

  writeFileSync(f.lock, `${process.pid}\n${new Date().toISOString()}\n`);
  const pending = convergeInstance({ appRoot: f.work, instance: f.instance });
  setTimeout(() => {
    g(f.work, "reset", "-q", "--hard", f.boot); // a rollback landed meanwhile
    rmSync(f.lock, { force: true });
  }, 150);
  const r = await pending;

  assert.equal(r.skipped, "current", JSON.stringify(r));
  assert.deepEqual(restarts, []);
  assert.ok(!existsSync(join(f.dataDir, "convergence-pending.json")));
});