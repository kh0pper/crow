/**
 * F-UPDATE-1 auto-update hardening (Task 1): branch guard (D1), tolerant
 * ff-only pull with no stash (D2), atomic-reclaim cross-process lock (D3),
 * and the under-lock branch re-check (D3b).
 *
 * Fixtures are real temp git repos (a bare `origin` + a `work` clone) so the
 * module's actual `run()` seam (`_setAppRootForTest`) exercises real git
 * semantics — no mocking of git behavior itself. Every test retargets
 * `_setAppRootForTest` at a fresh fixture and restores it to the REAL repo
 * root before finishing (even on failure), so the real APP_ROOT never sees a
 * mutating command from this file.
 */
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkForUpdates,
  runLockedUpdate,
  _setAppRootForTest,
  _setDbForTest,
  _lockPrimitivesForTest,
} from "../servers/gateway/auto-update.js";

const REAL_APP_ROOT = join(import.meta.dirname, "..");
const restoreRoot = () => _setAppRootForTest(REAL_APP_ROOT);
const LOCK_STALE_MS = 30 * 60 * 1000;

const g = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "au-hard-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  execFileSync("git", ["init", "--bare", "-b", "main", origin], { stdio: "pipe" });
  execFileSync("git", ["clone", origin, work], { stdio: "pipe" });
  g(work, "config", "user.email", "t@t");
  g(work, "config", "user.name", "t");
  writeFileSync(join(work, "a.txt"), "one\n");
  g(work, "add", "a.txt");
  g(work, "commit", "-m", "c1");
  g(work, "push", "origin", "main");
  return { root, origin, work, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Push a commit to origin/main from a THIRD clone, so `work`'s tree is
 *  untouched (the caller then makes work "behind"). */
function originCommit(fx, file, content) {
  const pusher = mkdtempSync(join(fx.root, "pusher-"));
  execFileSync("git", ["clone", fx.origin, pusher], { stdio: "pipe" });
  g(pusher, "config", "user.email", "t@t");
  g(pusher, "config", "user.name", "t");
  writeFileSync(join(pusher, file), content);
  g(pusher, "add", file);
  g(pusher, "commit", "-m", "up");
  g(pusher, "push", "origin", "main");
}

const stubDb = () => ({ execute: async () => ({ rows: [] }) });

// ---------------------------------------------------------------------------
// D1: branch guard
// ---------------------------------------------------------------------------

test("D1 branch guard: on a feature branch, checkForUpdates skips WITHOUT fetching", async () => {
  const fx = fixture();
  try {
    g(fx.work, "checkout", "-b", "feature/x");
    _setAppRootForTest(fx.work);
    _setDbForTest(stubDb());
    const result = await checkForUpdates();
    assert.equal(result.updated, false);
    assert.equal(result.skipped, "not-on-main");
    assert.equal(result.branch, "feature/x");
    assert.ok(result.message && result.message.length > 0, "skip must carry a human message");
    assert.equal(
      existsSync(join(fx.work, ".git", "FETCH_HEAD")),
      false,
      "branch guard must abort BEFORE any fetch",
    );
  } finally {
    _setDbForTest(null);
    restoreRoot();
    fx.cleanup();
  }
});

test("D1 branch guard: detached HEAD also skips as not-on-main", async () => {
  const fx = fixture();
  try {
    const sha = g(fx.work, "rev-parse", "HEAD");
    g(fx.work, "checkout", sha);
    _setAppRootForTest(fx.work);
    _setDbForTest(stubDb());
    const result = await checkForUpdates();
    assert.equal(result.skipped, "not-on-main");
    assert.equal(result.branch, "HEAD");
  } finally {
    _setDbForTest(null);
    restoreRoot();
    fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// D2: tolerant ff-only pull, no stash
// ---------------------------------------------------------------------------

test("D2 tolerant pull: disjoint local dirty file survives byte-identical, no stash entry", async () => {
  const fx = fixture();
  try {
    // A tracked file the incoming update will NOT touch.
    writeFileSync(join(fx.work, "c.txt"), "orig\n");
    g(fx.work, "add", "c.txt");
    g(fx.work, "commit", "-m", "add c");
    g(fx.work, "push", "origin", "main");

    originCommit(fx, "a.txt", "two\n");

    writeFileSync(join(fx.work, "c.txt"), "dirty-local\n");

    _setAppRootForTest(fx.work);
    _setDbForTest(stubDb());
    const result = await checkForUpdates();
    assert.equal(result.updated, true, JSON.stringify(result));
    assert.equal(readFileSync(join(fx.work, "c.txt"), "utf8"), "dirty-local\n");
    assert.equal(g(fx.work, "stash", "list"), "", "no stash entry must ever be created");
  } finally {
    _setDbForTest(null);
    restoreRoot();
    fx.cleanup();
  }
});

test("D2 tolerant pull: overlapping local dirty file refuses honestly, tree untouched, no stash", async () => {
  const fx = fixture();
  try {
    originCommit(fx, "a.txt", "two\n");
    writeFileSync(join(fx.work, "a.txt"), "local-dirty\n");

    _setAppRootForTest(fx.work);
    _setDbForTest(stubDb());
    const result = await checkForUpdates();
    assert.equal(result.updated, false);
    assert.ok(result.error, "overlap must produce an honest error, not silent data loss");
    assert.match(result.error, /conflict|would be overwritten|Pull failed/i);
    assert.equal(readFileSync(join(fx.work, "a.txt"), "utf8"), "local-dirty\n");
    assert.equal(g(fx.work, "stash", "list"), "", "no stash entry must ever be created");
  } finally {
    _setDbForTest(null);
    restoreRoot();
    fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// D3: cross-process lock
// ---------------------------------------------------------------------------

test("D3 lock: a live young lock skips with a message, and is left in place", async () => {
  const fx = fixture();
  try {
    const lockFile = join(fx.work, ".git", "crow-auto-update.lock");
    writeFileSync(lockFile, `${process.pid}\n${new Date().toISOString()}\n`);

    _setAppRootForTest(fx.work);
    _setDbForTest(stubDb());
    const result = await checkForUpdates();
    assert.equal(result.skipped, "locked");
    assert.ok(result.message && result.message.includes(String(process.pid)));
    assert.equal(existsSync(lockFile), true, "a live lock must not be disturbed by a skipped tick");
  } finally {
    _setDbForTest(null);
    restoreRoot();
    fx.cleanup();
  }
});

test("D3 lock: a stale lock (dead pid) is reclaimed and the update proceeds; lock removed after", async () => {
  const fx = fixture();
  try {
    originCommit(fx, "a.txt", "two\n");

    const lockFile = join(fx.work, ".git", "crow-auto-update.lock");
    const oldTs = new Date(Date.now() - LOCK_STALE_MS - 60_000).toISOString();
    writeFileSync(lockFile, `999999999\n${oldTs}\n`);

    _setAppRootForTest(fx.work);
    _setDbForTest(stubDb());
    const result = await checkForUpdates();
    assert.equal(result.updated, true, JSON.stringify(result));
    assert.equal(existsSync(lockFile), false, "lock must be released after a successful run");
  } finally {
    _setDbForTest(null);
    restoreRoot();
    fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// D3b: branch re-check under the lock (TOCTOU)
// ---------------------------------------------------------------------------

test("D3b: runLockedUpdate re-checks branch under the lock and aborts without pulling", async () => {
  const fx = fixture();
  try {
    originCommit(fx, "a.txt", "two\n");
    // Simulate a parallel session's raw checkout landing AFTER the outer D1
    // guard passed but before the lock's pull — exercised directly via the
    // runLockedUpdate seam (checkForUpdates's own D1 guard would otherwise
    // abort this fixture before we ever reach the lock).
    g(fx.work, "checkout", "-b", "feat/y");
    const before = g(fx.work, "rev-parse", "feat/y");

    _setAppRootForTest(fx.work);
    _setDbForTest(stubDb());
    const result = await runLockedUpdate();
    assert.equal(result.updated, false);
    assert.equal(result.skipped, "not-on-main");
    assert.equal(result.branch, "feat/y");

    const after = g(fx.work, "rev-parse", "feat/y");
    assert.equal(after, before, "feat/y must not have been fast-forwarded by an aborted pull");
  } finally {
    _setDbForTest(null);
    restoreRoot();
    fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Lock primitives (unit-level, via _lockPrimitivesForTest)
// ---------------------------------------------------------------------------

test("lock primitives: acquire sweeps stale quarantine leftovers older than the staleness window", () => {
  const dir = mkdtempSync(join(tmpdir(), "au-lockprim-"));
  try {
    const lockFile = join(dir, "crow-auto-update.lock");
    const staleQuarantine = `${lockFile}.stale.424242`;
    writeFileSync(staleQuarantine, "leftover");
    const oldTime = new Date(Date.now() - LOCK_STALE_MS - 60_000);
    utimesSync(staleQuarantine, oldTime, oldTime);

    const held = _lockPrimitivesForTest.acquireLock(lockFile);
    assert.equal(held, lockFile);
    assert.equal(existsSync(staleQuarantine), false, "old quarantine file must be swept on acquire");
  } finally {
    restoreRoot();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lock primitives: stale reclaim leaves OUR pid in the lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "au-lockprim-"));
  try {
    const lockFile = join(dir, "crow-auto-update.lock");
    const oldTs = new Date(Date.now() - LOCK_STALE_MS - 60_000).toISOString();
    writeFileSync(lockFile, `999999999\n${oldTs}\n`);

    const held = _lockPrimitivesForTest.acquireLock(lockFile);
    assert.equal(held, lockFile);
    const [pidLine] = readFileSync(lockFile, "utf8").split("\n");
    assert.equal(parseInt(pidLine, 10), process.pid);
  } finally {
    restoreRoot();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lock primitives: releaseLock never unlinks a lock owned by a different pid", () => {
  const dir = mkdtempSync(join(tmpdir(), "au-lockprim-"));
  try {
    const lockFile = join(dir, "crow-auto-update.lock");
    writeFileSync(lockFile, `424242\n${new Date().toISOString()}\n`);

    _lockPrimitivesForTest.releaseLock(lockFile);
    assert.equal(existsSync(lockFile), true, "release must never touch a lock this process doesn't own");
  } finally {
    restoreRoot();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lock primitives: lockIsStale — dead pid OR age>30min is stale, live+young is not", () => {
  try {
    assert.equal(_lockPrimitivesForTest.lockIsStale(null), true, "missing/unparsable info is stale");
    assert.equal(
      _lockPrimitivesForTest.lockIsStale({ pid: process.pid, ts: Date.now() }),
      false,
      "live pid, fresh timestamp must NOT be stale",
    );
    assert.equal(
      _lockPrimitivesForTest.lockIsStale({ pid: 999999999, ts: Date.now() }),
      true,
      "dead pid is stale even if fresh",
    );
    assert.equal(
      _lockPrimitivesForTest.lockIsStale({ pid: process.pid, ts: Date.now() - LOCK_STALE_MS - 60_000 }),
      true,
      "live pid but age>30min is stale",
    );
  } finally {
    restoreRoot();
  }
});
