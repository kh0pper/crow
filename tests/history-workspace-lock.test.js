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
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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

test("a fresh empty lock file is never taken over", async () => {
  const dir = freshDir();
  try {
    writeFileSync(lockFile(dir), "");
    await assert.rejects(
      acquireGitDirLock(dir, { waitMs: 150, pollMs: 5, isPidAlive: () => true }),
      (err) => err.code === "busy",
    );
    assert.equal(existsSync(lockFile(dir)), true, "the file is untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a lock created by us is whole from the first moment it exists", async () => {
  const dir = freshDir();
  try {
    const lock = await acquireGitDirLock(dir, { waitMs: 1000 });
    const body = readLockFile(dir);
    assert.equal(typeof body.token, "string");
    assert.deepEqual(readdirSync(dir), ["crow-history.lock"], "no temp name is left behind");
    lock.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a token-less file judged stale but swapped for a live lock is put back, not deleted", async () => {
  const dir = freshDir();
  try {
    // An old empty file: judged stale (no token, older than 5 s).
    writeFileSync(lockFile(dir), "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockFile(dir), old, old);
    let swapped = false;
    let heldLock = null;
    const waiter = acquireGitDirLock(dir, {
      waitMs: 2000,
      pollMs: 5,
      isPidAlive: (pid) => pid === process.pid,
      getPidStart: () => "9",
      _beforeStaleRename: () => {
        if (swapped) return;
        swapped = true;
        // Another process finishes its own takeover first and now holds a live lock.
        rmSync(lockFile(dir), { force: true });
        writeFileSync(lockFile(dir), JSON.stringify({ pid: process.pid, pidStart: "9", startedAt: Date.now(), token: "LIVE" }));
        heldLock = () => rmSync(lockFile(dir), { force: true });
      },
    });
    await new Promise((done) => setTimeout(done, 200));
    assert.equal(swapped, true);
    assert.equal(readLockFile(dir).token, "LIVE", "the live lock is back in place");
    let got = false;
    waiter.then(() => { got = true; }, () => {});
    await new Promise((done) => setTimeout(done, 100));
    assert.equal(got, false, "the waiter does not hold the lock while the live holder does");
    heldLock();
    (await waiter).release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed put-back keeps the moved-aside file", async () => {
  const dir = freshDir();
  const realWarn = console.warn;
  const warned = [];
  console.warn = (...args) => { warned.push(args.join(" ")); };
  try {
    writeLock(dir, { pid: 999999, pidStart: "1", startedAt: Date.now(), token: "L1" });
    let done = false;
    const waiter = acquireGitDirLock(dir, {
      waitMs: 500,
      pollMs: 5,
      isPidAlive: (pid) => pid === process.pid,
      getPidStart: () => "3",
      _beforeStaleRename: () => {
        if (done) return;
        // Replace L1 with a live lock, then (below) a THIRD lock takes the name
        // right after our rename, so the put-back cannot succeed.
        rmSync(lockFile(dir), { force: true });
        writeFileSync(lockFile(dir), JSON.stringify({ pid: process.pid, pidStart: "3", startedAt: Date.now(), token: "LIVE" }));
      },
      _afterStaleRename: () => {
        if (done) return;
        done = true;
        writeFileSync(lockFile(dir), JSON.stringify({ pid: process.pid, pidStart: "3", startedAt: Date.now(), token: "THIRD" }));
      },
    });
    await assert.rejects(waiter, (err) => err.code === "busy");
    const leftovers = readdirSync(dir).filter((name) => name.includes(".stale-"));
    assert.equal(leftovers.length, 1, "the moved lock was kept");
    assert.equal(JSON.parse(readFileSync(join(dir, leftovers[0]), "utf8")).token, "LIVE");
    assert.equal(readLockFile(dir).token, "THIRD", "the third lock was not disturbed");
    assert.ok(warned.some((line) => /kept, not deleted/.test(line)), "and it was logged");
  } finally {
    console.warn = realWarn;
    rmSync(dir, { recursive: true, force: true });
  }
});
