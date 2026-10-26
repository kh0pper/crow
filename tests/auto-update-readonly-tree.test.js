/**
 * Queue item 19, step 1: a co-hosted gateway hardened with a READ-ONLY view of
 * the shared checkout (ProtectHome= + BindReadOnlyPaths=) cannot pull it and
 * cannot write the checkout lock. Another gateway pulls; this one must still
 * converge (migrate its own stores, restart into the tree's HEAD), and must
 * still wait while the puller holds the lock.
 *
 * Read-only is emulated with chmod on the fixture's .git (skipped as root,
 * where mode bits do not stop writes). CROW_AUTO_UPDATE_TREE=external says the
 * same thing explicitly.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkForUpdates, acquireCheckoutLock, treeIsExternal, _setAppRootForTest, _setDbForTest,
} from "../servers/gateway/auto-update.js";

delete process.env.INVOCATION_ID;
delete process.env.CROW_SUPERVISED;

const REAL_APP_ROOT = join(import.meta.dirname, "..");
const isRoot = process.getuid && process.getuid() === 0;
const g = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "au-ro-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  execFileSync("git", ["init", "--bare", "-b", "main", origin], { stdio: "pipe" });
  execFileSync("git", ["clone", origin, work], { stdio: "pipe" });
  g(work, "config", "user.email", "t@t");
  g(work, "config", "user.name", "t");
  writeFileSync(join(work, "a.txt"), "one\n");
  mkdirSync(join(work, "scripts"), { recursive: true });
  writeFileSync(join(work, "scripts", "init-db.js"), "process.exit(0);\n");
  g(work, "add", "a.txt", "scripts/init-db.js");
  g(work, "commit", "-m", "c1");
  g(work, "push", "origin", "main");
  // origin moves ahead: a writable tree would pull this.
  const pusher = join(root, "pusher");
  execFileSync("git", ["clone", origin, pusher], { stdio: "pipe" });
  g(pusher, "config", "user.email", "t@t");
  g(pusher, "config", "user.name", "t");
  writeFileSync(join(pusher, "b.txt"), "two\n");
  g(pusher, "add", "b.txt");
  g(pusher, "commit", "-m", "c2");
  g(pusher, "push", "origin", "main");
  g(work, "fetch", "-q", "origin");
  const gitDir = join(work, ".git");
  return {
    work, gitDir,
    readOnly: () => chmodSync(gitDir, 0o555),
    cleanup: () => { try { chmodSync(gitDir, 0o755); } catch {} rmSync(root, { recursive: true, force: true }); },
  };
}

function settingsDb() {
  const saved = {};
  return {
    saved,
    execute: async ({ sql, args }) => {
      if (/INSERT INTO dashboard_settings/.test(sql)) saved[args[0]] = args[1];
      return { rows: [] };
    },
  };
}

test("treeIsExternal: false for a writable checkout, true when .git is not writable or the env says so", { skip: isRoot && "root ignores mode bits" }, async () => {
  const fx = fixture();
  const saved = process.env.CROW_AUTO_UPDATE_TREE;
  try {
    delete process.env.CROW_AUTO_UPDATE_TREE;
    assert.equal(await treeIsExternal(fx.work), false);
    process.env.CROW_AUTO_UPDATE_TREE = "external";
    assert.equal(await treeIsExternal(fx.work), true);
    delete process.env.CROW_AUTO_UPDATE_TREE;
    fx.readOnly();
    assert.equal(await treeIsExternal(fx.work), true);
  } finally {
    if (saved === undefined) delete process.env.CROW_AUTO_UPDATE_TREE; else process.env.CROW_AUTO_UPDATE_TREE = saved;
    fx.cleanup();
  }
});

test("a read-only checkout is never pulled: the tree half is skipped with an honest result, and the instance half still runs", { skip: isRoot && "root ignores mode bits" }, async () => {
  const fx = fixture();
  const db = settingsDb();
  try {
    _setAppRootForTest(fx.work);
    _setDbForTest(db);
    const before = g(fx.work, "rev-parse", "HEAD");
    fx.readOnly();
    const r = await checkForUpdates({ instance: null });
    assert.equal(r.skipped, "read-only");
    assert.equal(r.pulled, false);
    assert.ok(typeof r.converged === "boolean" && r.skipped === "read-only", "the instance half ran and reported");
    assert.equal(g(fx.work, "rev-parse", "HEAD"), before, "HEAD did not move");
    assert.match(db.saved.auto_update_last_result, /read-only for this instance/);
    assert.equal(db.saved.auto_update_latest_version, g(fx.work, "rev-parse", "--short", "origin/main"));
    assert.ok(!existsSync(join(fx.gitDir, "crow-auto-update.lock")));
  } finally {
    _setAppRootForTest(REAL_APP_ROOT);
    _setDbForTest(null);
    fx.cleanup();
  }
});

test("CROW_AUTO_UPDATE_TREE=external skips the pull even on a writable checkout, and takes no lock", async () => {
  const fx = fixture();
  const db = settingsDb();
  const saved = process.env.CROW_AUTO_UPDATE_TREE;
  try {
    process.env.CROW_AUTO_UPDATE_TREE = "external";
    _setAppRootForTest(fx.work);
    _setDbForTest(db);
    const before = g(fx.work, "rev-parse", "HEAD");
    const r = await checkForUpdates({ instance: null });
    assert.equal(r.skipped, "read-only");
    assert.equal(g(fx.work, "rev-parse", "HEAD"), before);
    assert.ok(!existsSync(join(fx.gitDir, "crow-auto-update.lock")));
  } finally {
    if (saved === undefined) delete process.env.CROW_AUTO_UPDATE_TREE; else process.env.CROW_AUTO_UPDATE_TREE = saved;
    _setAppRootForTest(REAL_APP_ROOT);
    _setDbForTest(null);
    fx.cleanup();
  }
});

test("acquireCheckoutLock on a read-only tree OBSERVES the lock: free → proceeds without writing; live holder → waits; stale → proceeds", { skip: isRoot && "root ignores mode bits" }, async () => {
  const fx = fixture();
  const lock = join(fx.gitDir, "crow-auto-update.lock");
  try {
    // live holder (this pid, fresh timestamp) written before .git goes read-only
    writeFileSync(lock, `${process.pid}\n${new Date().toISOString()}\n`);
    fx.readOnly();
    const t0 = Date.now();
    const busy = await acquireCheckoutLock({ appRoot: fx.work, waitMs: 300, pollMs: 50 });
    assert.equal(busy, null, "a live puller holds the lock: defer");
    assert.ok(Date.now() - t0 >= 250, "it waited");
    chmodSync(fx.gitDir, 0o755);
    writeFileSync(lock, `999999999\n2000-01-01T00:00:00.000Z\n`); // dead pid, old: stale
    fx.readOnly();
    const stale = await acquireCheckoutLock({ appRoot: fx.work, waitMs: 300, pollMs: 50 });
    assert.ok(stale, "a stale lock does not block a read-only observer");
    chmodSync(fx.gitDir, 0o755);
    rmSync(lock);
    fx.readOnly();
    const free = await acquireCheckoutLock({ appRoot: fx.work, waitMs: 300, pollMs: 50 });
    assert.ok(free, "no lock: proceed");
    assert.ok(!existsSync(lock), "the observer wrote nothing");
  } finally {
    fx.cleanup();
  }
});

test("lock staleness: a pid-less lock younger than the write grace is held; another user's live pid (EPERM) is alive", async () => {
  const { _lockPrimitivesForTest } = await import("../servers/gateway/auto-update.js");
  const { lockIsStale } = _lockPrimitivesForTest;
  assert.equal(lockIsStale({ pid: NaN, ts: NaN, mtimeMs: Date.now() }), false, "being written");
  assert.equal(lockIsStale({ pid: NaN, ts: NaN, mtimeMs: Date.now() - 60_000 }), true, "abandoned empty lock");
  assert.equal(lockIsStale({ pid: 1, ts: Date.now() }), false, "pid 1 exists (EPERM for a normal user, or alive as root)");
  assert.equal(lockIsStale({ pid: 2 ** 22 + 11, ts: Date.now() }), true, "a dead pid");
});
