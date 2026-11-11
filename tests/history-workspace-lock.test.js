/**
 * Version history, Task 6: the cross-process lock around a project's git dir
 * (servers/shared/history/workspace-lock.js). No git is needed here.
 *
 * Stale means "the holder is dead", never "the lock is old": a live erase that
 * runs long keeps its lock, and two waiters that judge the same dead lock stale
 * cannot both end up holding a lock.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { acquireGitDirLock } from "../servers/shared/history/workspace-lock.js";

function freshDir() {
  return mkdtempSync(join(tmpdir(), "hist-lock-"));
}
const lockFile = (dir) => join(dir, "crow-history.lock");
const writeLock = (dir, body) => writeFileSync(lockFile(dir), JSON.stringify(body));
const readLockFile = (dir) => JSON.parse(readFileSync(lockFile(dir), "utf8"));

test("a lock whose holder is dead is taken over", async () => {
  const dir = freshDir();
  try {
    writeLock(dir, { pid: 999999, pidStart: "1", startedAt: Date.now(), token: "dead-holder" });
    const lock = await acquireGitDirLock(dir, { waitMs: 1000, isPidAlive: () => false });
    assert.notEqual(readLockFile(dir).token, "dead-holder", "the lock now belongs to the new holder");
    lock.release();
    assert.equal(existsSync(lockFile(dir)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a pid reused by another process (different start time) is a dead holder", async () => {
  const dir = freshDir();
  try {
    writeLock(dir, { pid: process.pid, pidStart: "111", startedAt: Date.now(), token: "old-incarnation" });
    const lock = await acquireGitDirLock(dir, {
      waitMs: 1000,
      isPidAlive: () => true,
      getPidStart: () => "222",
    });
    assert.notEqual(readLockFile(dir).token, "old-incarnation");
    lock.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a live holder keeps the lock however old it is", async () => {
  const dir = freshDir();
  try {
    const startedAt = 1_000_000;
    writeLock(dir, { pid: process.pid, pidStart: "5", startedAt, token: "live-holder" });
    // The clock is far past any age limit; the holder is alive with the same start time.
    let now = startedAt + 3 * 60 * 60 * 1000;
    await assert.rejects(
      acquireGitDirLock(dir, {
        waitMs: 200,
        pollMs: 5,
        isPidAlive: () => true,
        getPidStart: () => "5",
        clock: () => {
          now += 50;
          return now;
        },
      }),
      (err) => err.code === "busy",
    );
    assert.equal(readLockFile(dir).token, "live-holder", "the live holder's lock is untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a real lock records the holder's own start time", async () => {
  const dir = freshDir();
  try {
    const lock = await acquireGitDirLock(dir, { waitMs: 1000 });
    const body = readLockFile(dir);
    assert.equal(body.pid, process.pid);
    if (process.platform === "linux") assert.match(String(body.pidStart), /^\d+$/);
    // The same process counts as alive with its own start time: a second waiter is refused.
    await assert.rejects(acquireGitDirLock(dir, { waitMs: 100, pollMs: 5 }), (err) => err.code === "busy");
    lock.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two waiters that judge the same dead lock stale never both hold a lock", async () => {
  const dir = freshDir();
  try {
    writeLock(dir, { pid: 999999, pidStart: "1", startedAt: Date.now(), token: "L1" });
    const aliveOnlyUs = (pid) => pid === process.pid;
    let bLock = null;
    let interleaved = false;
    // Waiter A reaches its takeover; just before it renames, waiter B does the
    // whole takeover (moves L1 away, creates its own fresh lock) and holds it.
    const aPromise = acquireGitDirLock(dir, {
      waitMs: 3000,
      pollMs: 5,
      isPidAlive: aliveOnlyUs,
      getPidStart: () => "7",
      _beforeStaleRename: () => {
        if (interleaved) return;
        interleaved = true;
        // B's takeover, performed synchronously inside A's seam.
        writeFileSync(lockFile(dir), JSON.stringify({ pid: process.pid, pidStart: "7", startedAt: Date.now(), token: "B-LIVE" }));
        bLock = { release: () => rmSync(lockFile(dir), { force: true }) };
      },
    });
    // Give A time to run its stale pass and (wrongly) take B's lock, if it would.
    await new Promise((done) => setTimeout(done, 150));
    assert.equal(interleaved, true, "the seam ran");
    assert.equal(existsSync(lockFile(dir)), true, "B's lock file still exists");
    assert.equal(readLockFile(dir).token, "B-LIVE", "and it is still B's");
    let aGot = false;
    aPromise.then(() => { aGot = true; }, () => {});
    await new Promise((done) => setTimeout(done, 100));
    assert.equal(aGot, false, "A has not acquired while B holds the lock");
    // B releases; now A may take it.
    bLock.release();
    const aLock = await aPromise;
    assert.notEqual(readLockFile(dir).token, "B-LIVE");
    aLock.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
