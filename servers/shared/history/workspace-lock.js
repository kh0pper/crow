/**
 * workspace-lock.js — the cross-process lock around one project's git dir.
 *
 * A project's file history is written from more than one process: the gateway
 * (the sweep, a restore, an erase) and the pi-bots runners (a job-end commit).
 * The in-process promise chain in workspace-history.js cannot see the other
 * process, so two of them can collide on git's own index.lock and lose a commit
 * for no good reason. This is the lock they share instead.
 *
 * The lock is a FILE inside the git dir (`crow-history.lock`), created with
 * O_CREAT|O_EXCL and holding `{ pid, pidStart, startedAt, token }`. A lock is
 * STALE — and may be taken over — only when its HOLDER IS DEAD:
 *
 *   - its pid is not alive (no signal-0 target; EPERM counts as alive), or
 *   - the pid is alive but its process start time (field 22 of /proc/<pid>/stat)
 *     differs from the `pidStart` the lock recorded: the pid was reused by an
 *     unrelated process, so the real holder is gone.
 *
 * Never by age while the holder is alive: a long erase (rewrite, reflog expire,
 * gc) is slow but alive, and taking its lock mid-gc could prune a new writer's
 * objects. A lock file that cannot be read as a lock at all and is older than 5
 * seconds is also taken over (a half-written file from a process that died
 * mid-write); there is no holder to ask.
 *
 * Taking over renames the stale file to a unique name, then CHECKS that the file
 * it moved is the one it judged stale (same token). Two waiters can both judge the
 * same dead lock stale; the first renames it away and creates a fresh live lock,
 * and the second's rename would then move that LIVE lock. So a mismatch puts the
 * moved file back (a hard link, which fails safely if the name is taken again) and
 * loops. The rename is atomic, so exactly one waiter wins the stale file.
 *
 * release() removes the file only while it still holds OUR token, so a lock that
 * was already taken over is never deleted out from under its new owner. It never
 * throws — it runs in a `finally`.
 *
 * `waitMs` is the whole wait budget; past it the call throws an Error whose
 * `.code` is "busy". A missing git dir throws `.code` "gone" instead (the project
 * was purged while we waited for it).
 */
import { closeSync, linkSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

/** A refusal with a machine-readable code, the way workspace-history's are. */
function lockError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** The sleep between attempts, in ms, and never longer than what is left. */
function sleep(ms) {
  // Deliberately NOT unref'd: a process whose only remaining work is waiting for
  // this lock (a bot's job-end commit) must stay alive until it gets it or the
  // budget runs out, instead of exiting with an unsettled await.
  return new Promise((done) => {
    setTimeout(done, Math.max(0, ms));
  });
}

/** Is the process that wrote a lock still running? EPERM means it exists. */
function defaultIsPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return Boolean(err) && err.code === "EPERM";
  }
}

/**
 * The start time of a process (field 22 of /proc/<pid>/stat, in clock ticks since
 * boot), or null when it cannot be read (not Linux, or the process is gone). The
 * comm field may hold spaces and parens, so the fields are counted after the LAST ")".
 */
function defaultPidStart(pid) {
  try {
    const stat = readFileSync(`/proc/${Number(pid)}/stat`, "utf8");
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    // rest[0] is field 3 (state), so field 22 is rest[19].
    return rest[19] && /^\d+$/.test(rest[19]) ? rest[19] : null;
  } catch {
    return null;
  }
}

/** The lock's parsed content, or null when the file is missing or unreadable. */
function readLock(lockPath) {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** The lock file's inode (as a string), or null when it is gone. */
function lockIno(lockPath) {
  try {
    return String(statSync(lockPath).ino);
  } catch {
    return null;
  }
}

/** The lock file's mtime in ms, or null when it is gone. */
function lockMtime(lockPath) {
  try {
    return statSync(lockPath).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Whether an existing lock may be taken over, and which lock it judged.
 *
 * @returns {{stale: boolean, token: string|null, ino: string|null}}
 */
function judgeLock(lockPath, { isPidAlive, getPidStart, clock }) {
  const now = clock();
  const ino = lockIno(lockPath);
  const held = readLock(lockPath);
  if (!held || typeof held.token !== "string") {
    // Nothing to ask: a foreign or damaged file (our own locks are linked into
    // place whole, so they are never empty). Old enough means dead.
    const mtime = lockMtime(lockPath);
    return { stale: mtime !== null && now - mtime > 5000, token: null, ino };
  }
  const token = held.token;
  if (!isPidAlive(held.pid)) return { stale: true, token, ino };
  // Alive: stale only when the pid now belongs to a different process.
  if (held.pidStart != null) {
    const nowStart = getPidStart(held.pid);
    if (nowStart !== null && String(nowStart) !== String(held.pidStart)) return { stale: true, token, ino };
  }
  return { stale: false, token, ino };
}

/**
 * Take the cross-process lock for one git dir.
 *
 * @param {string} repoDir  the project's Crow git dir
 * @param {{waitMs?: number, pollMs?: number, isPidAlive?: Function,
 *   getPidStart?: Function, clock?: Function, _beforeStaleRename?: Function,
 *   _afterStaleRename?: Function}} [opts]
 * @returns {Promise<{release: () => void}>}
 */
export async function acquireGitDirLock(repoDir, opts = {}) {
  const waitMs = Number.isFinite(Number(opts.waitMs)) ? Math.max(0, Number(opts.waitMs)) : 120_000;
  const pollMs = Number.isFinite(Number(opts.pollMs)) ? Math.max(1, Number(opts.pollMs)) : 50;
  const isPidAlive = typeof opts.isPidAlive === "function" ? opts.isPidAlive : defaultIsPidAlive;
  const getPidStart = typeof opts.getPidStart === "function" ? opts.getPidStart : defaultPidStart;
  const clock = typeof opts.clock === "function" ? opts.clock : Date.now;
  const lockPath = join(repoDir, "crow-history.lock");
  const token = randomBytes(16).toString("hex");
  const deadline = clock() + waitMs;
  let waited = false;

  for (;;) {
    // The first attempt always happens, even with a zero budget: a free lock is
    // still free. Only a SECOND pass is refused by the deadline.
    if (waited && clock() >= deadline) {
      throw lockError("busy", "another change to this project's files is still running");
    }
    // The lock is written whole to a private temp file and LINKED into place, so
    // the lock file is never visible empty or half-written (a reader that finds
    // an empty file can only be looking at something that is not one of ours).
    const body = Buffer.from(JSON.stringify({ pid: process.pid, pidStart: getPidStart(process.pid), startedAt: clock(), token }), "utf8");
    const temp = `${lockPath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    try {
      const fd = openSync(temp, "wx", 0o600);
      try {
        writeSync(fd, body);
      } finally {
        closeSync(fd);
      }
      linkSync(temp, lockPath);
      try { rmSync(temp, { force: true }); } catch { /* the lock stands; the temp is only a name */ }
      return { release: () => releaseLock(lockPath, token) };
    } catch (err) {
      try { rmSync(temp, { force: true }); } catch { /* nothing to remove */ }
      if (!err || err.code === "ENOENT") {
        // The git dir itself is gone: the project was purged while we waited.
        throw lockError("gone", "the project's file history directory is gone");
      }
      if (err.code !== "EEXIST") throw err;
    }

    waited = true;
    const verdict = judgeLock(lockPath, { isPidAlive, getPidStart, clock });
    if (verdict.stale) {
      if (typeof opts._beforeStaleRename === "function") opts._beforeStaleRename(lockPath);
      const aside = `${lockPath}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
      let moved = false;
      try {
        renameSync(lockPath, aside);
        moved = true;
        if (typeof opts._afterStaleRename === "function") opts._afterStaleRename(lockPath, aside);
      } catch {
        // Another waiter won the rename (ENOENT): loop and race the create again.
      }
      if (moved) {
        // Provably the file we judged: the same inode and, when the judged file
        // had a token, the same token. Anything else is not ours to destroy.
        const taken = readLock(aside);
        const takenToken = taken && typeof taken.token === "string" ? taken.token : null;
        const sameFile = lockIno(aside) === verdict.ino && takenToken === verdict.token;
        if (sameFile) {
          try { rmSync(aside, { force: true }); } catch { /* another sweep will find it */ }
        } else {
          // We moved something else, quite possibly a live lock another waiter
          // just made. Put it back. If the name is taken again, keep the moved
          // file where it is rather than delete what may be a live holder's lock.
          try {
            linkSync(aside, lockPath);
            try { rmSync(aside, { force: true }); } catch { /* a leftover name only */ }
          } catch {
            console.warn(`[history] a lock moved aside during a takeover was kept, not deleted: ${aside}`);
          }
        }
      }
      continue;
    }

    await sleep(Math.min(pollMs, Math.max(1, deadline - clock())));
  }
}

/** Remove the lock file, but only while it is still ours. Never throws. */
function releaseLock(lockPath, token) {
  try {
    const held = readLock(lockPath);
    if (!held || held.token !== token) return;
    rmSync(lockPath, { force: true });
  } catch {
    /* a lock file we could not remove is taken over as stale later */
  }
}