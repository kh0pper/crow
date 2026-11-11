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
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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


const DEAD = { pid: 999999, pidStart: "1", startedAt: 1, token: "L1" };
const breakerFile = (dir) => join(dir, "crow-history.lock.break");
const sleepMs = (ms) => new Promise((done) => setTimeout(done, ms));
// Our own pid is the only live one; its start time is a fixed fake.
const liveUs = { isPidAlive: (pid) => pid === process.pid, getPidStart: () => "7" };

test("two waiters on one dead lock: exactly one holds it (smoke)", async () => {
  const dir = freshDir();
  try {
    writeLock(dir, DEAD);
    const a = acquireGitDirLock(dir, { waitMs: 400, pollMs: 5, ...liveUs });
    const b = acquireGitDirLock(dir, { waitMs: 400, pollMs: 5, ...liveUs });
    const results = await Promise.allSettled([a, b]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    assert.equal(won.length, 1, "exactly one holder");
    assert.equal(lost.length, 1);
    assert.equal(lost[0].reason.code, "busy");
    won[0].value.release();
    assert.equal(existsSync(lockFile(dir)), false);
    assert.equal(existsSync(breakerFile(dir)), false, "the breaker is gone too");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a waiter that judged a dead lock stale never wedges the project when the new holder releases mid-takeover", async () => {
  const dir = freshDir();
  try {
    writeLock(dir, DEAD);
    let bToken = null;
    const swapInB = () => {
      // B finishes its own takeover first and holds a live lock.
      rmSync(lockFile(dir), { force: true });
      bToken = "B-LIVE";
      writeLock(dir, { pid: process.pid, pidStart: "7", startedAt: Date.now(), token: bToken });
    };
    const releaseB = () => rmSync(lockFile(dir), { force: true });
    let swapped = false;
    let released = false;
    const before = () => { if (!swapped) { swapped = true; swapInB(); } };
    const under = () => { if (!released) { released = true; releaseB(); } };
    const a = await acquireGitDirLock(dir, {
      waitMs: 1000, pollMs: 5, ...liveUs,
      // both the old and the new seam names, so the same test can be run on either design
      _beforeStaleRename: before, _beforeBreaker: before,
      _afterStaleRename: under, _underBreaker: under,
    });
    assert.equal(swapped && released, true, "the interleaving happened");
    assert.notEqual(readLockFile(dir).token, "B-LIVE");
    a.release();
    // After everybody has released, a fresh acquirer succeeds at once.
    const fresh = await acquireGitDirLock(dir, { waitMs: 200, pollMs: 5, ...liveUs });
    fresh.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("while one waiter holds the breaker a third process never takes over or co-holds", async () => {
  const dir = freshDir();
  try {
    writeLock(dir, DEAD);
    let third = null;
    let breakerSeen = null;
    const a = await acquireGitDirLock(dir, {
      waitMs: 1000, pollMs: 5, ...liveUs,
      _underBreaker: () => {
        breakerSeen = JSON.parse(readFileSync(breakerFile(dir), "utf8"));
        // A third process arrives right now (waitMs 0: one pass, no waiting).
        third = acquireGitDirLock(dir, { waitMs: 0, pollMs: 1, ...liveUs });
      },
    });
    assert.ok(third, "the seam ran");
    assert.equal(typeof breakerSeen.token, "string", "the breaker is whole and has a token");
    await assert.rejects(third, (err) => err.code === "busy");
    assert.equal(readLockFile(dir).token !== "L1", true);
    a.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a breaker left by a dead process is cleared and the takeover still completes", async () => {
  const dir = freshDir();
  try {
    writeLock(dir, DEAD);
    writeFileSync(breakerFile(dir), JSON.stringify({ pid: 999998, pidStart: "1", startedAt: 1, token: "OLD-BREAKER" }));
    const lock = await acquireGitDirLock(dir, { waitMs: 1000, pollMs: 5, ...liveUs });
    assert.notEqual(readLockFile(dir).token, "L1");
    lock.release();
    assert.equal(existsSync(breakerFile(dir)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a live breaker held by another process is waited out, never removed", async () => {
  const dir = freshDir();
  try {
    writeLock(dir, DEAD);
    writeFileSync(breakerFile(dir), JSON.stringify({ pid: process.pid, pidStart: "7", startedAt: Date.now(), token: "LIVE-BREAKER" }));
    await assert.rejects(
      acquireGitDirLock(dir, { waitMs: 150, pollMs: 5, ...liveUs }),
      (err) => err.code === "busy",
    );
    assert.equal(JSON.parse(readFileSync(breakerFile(dir), "utf8")).token, "LIVE-BREAKER");
    assert.equal(readLockFile(dir).token, "L1", "the dead lock was left alone while the breaker was live");
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

test("the lock name is never observed absent-with-an-incomplete-temp, or empty, before the link", async () => {
  const dir = freshDir();
  try {
    let calls = 0;
    const lock = await acquireGitDirLock(dir, {
      waitMs: 1000,
      _beforeLink: (temp, lockPath) => {
        calls += 1;
        assert.equal(existsSync(lockPath), false, "the lock name does not exist yet");
        const body = JSON.parse(readFileSync(temp, "utf8"));
        assert.equal(typeof body.token, "string", "the temp already holds the whole lock");
        assert.equal(body.pid, process.pid);
      },
    });
    assert.equal(calls, 1, "the writer seam ran");
    lock.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a lock judged stale (had a token) but replaced by a token-less file is not removed", async () => {
  const dir = freshDir();
  try {
    writeLock(dir, DEAD);
    let removed = "never ran";
    let swapped = false;
    const swap = () => {
      if (swapped) return;
      swapped = true;
      rmSync(lockFile(dir), { force: true });
      writeFileSync(lockFile(dir), ""); // fresh, token-less
    };
    await assert.rejects(
      acquireGitDirLock(dir, {
        waitMs: 100, pollMs: 5, ...liveUs,
        _beforeStaleRename: swap, _underBreaker: swap,
        _afterBreak: (r) => { if (removed === "never ran") removed = r; },
      }),
      (err) => err.code === "busy",
    );
    assert.equal(removed, false, "the breaker did not remove the swapped file");
    assert.equal(existsSync(lockFile(dir)), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two token-less files with different inodes: the judged one is not the one removed", async () => {
  const dir = freshDir();
  try {
    const age = () => {
      const old = new Date(Date.now() - 60_000);
      utimesSync(lockFile(dir), old, old);
    };
    writeFileSync(lockFile(dir), "");
    age();
    let removed = "never ran";
    let swapped = false;
    const swap = () => {
      if (swapped) return;
      swapped = true;
      // Create the new file while the old one still exists (so the inode number
      // cannot be reused), then rename it over the old one.
      writeFileSync(`${lockFile(dir)}.new`, "");
      renameSync(`${lockFile(dir)}.new`, lockFile(dir));
      age();
    };
    const lock = await acquireGitDirLock(dir, {
      waitMs: 1000, pollMs: 5, ...liveUs,
      _beforeStaleRename: swap, _underBreaker: swap,
      _afterBreak: (r) => { if (removed === "never ran") removed = r; },
    });
    assert.equal(removed, false, "the first attempt left the different file alone");
    lock.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a lock that cannot be read is busy, never removed", { skip: process.getuid && process.getuid() === 0 }, async () => {
  const dir = freshDir();
  try {
    writeLock(dir, DEAD);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockFile(dir), old, old);
    chmodSync(lockFile(dir), 0o000);
    await assert.rejects(
      acquireGitDirLock(dir, { waitMs: 150, pollMs: 5, ...liveUs }),
      (err) => err.code === "busy",
    );
    chmodSync(lockFile(dir), 0o600);
    assert.equal(readLockFile(dir).token, "L1", "the aged unreadable lock is untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const [label, setup] of [
  ["a live breaker", (dir) => writeFileSync(breakerFile(dir), JSON.stringify({ pid: process.pid, pidStart: "7", startedAt: Date.now(), token: "B" }))],
  ["a fresh garbage breaker", (dir) => writeFileSync(breakerFile(dir), "")],
  ["an unreadable breaker", (dir) => { writeFileSync(breakerFile(dir), "{}"); chmodSync(breakerFile(dir), 0o000); }],
]) {
  const skip = label.startsWith("an unreadable") && process.getuid && process.getuid() === 0;
  test(`the event loop keeps running while acquire waits on ${label}`, { skip }, async () => {
    const dir = freshDir();
    try {
      writeLock(dir, DEAD);
      setup(dir);
      let ticks = 0;
      const timer = setInterval(() => { ticks += 1; }, 5);
      try {
        await assert.rejects(
          acquireGitDirLock(dir, { waitMs: 300, pollMs: 10, ...liveUs }),
          (err) => err.code === "busy",
        );
      } finally {
        clearInterval(timer);
      }
      assert.ok(ticks >= 10, `timers ran while waiting (ticks=${ticks})`);
    } finally {
      try { chmodSync(breakerFile(dir), 0o600); } catch { /* may not exist */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
