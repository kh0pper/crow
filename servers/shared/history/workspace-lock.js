/**
 * workspace-lock.js — the cross-process lock around one project's git dir.
 *
 * A project's file history is written from more than one process: the gateway
 * (the sweep, a restore, an erase) and the pi-bots runners (a job-end commit).
 * The in-process promise chain in workspace-history.js cannot see the other
 * process, so two of them can collide on git's own index.lock and lose a commit
 * for no good reason. This is the lock they share instead.
 *
 * The lock is a FILE inside the git dir (`crow-history.lock`) holding
 * `{ pid, pidStart, startedAt, token }`. It is written whole to a private temp
 * file and LINKED into place (link fails with EEXIST when the name is taken), so
 * the lock name never shows an empty or half-written file. A lock is STALE — and
 * may be taken over — only when its HOLDER IS DEAD:
 *
 *   - its pid is not alive (no signal-0 target; EPERM counts as alive), or
 *   - the pid is alive but its process start time (field 22 of /proc/<pid>/stat)
 *     differs from the `pidStart` the lock recorded: the pid was reused by an
 *     unrelated process, so the real holder is gone.
 *
 * Never by age while the holder is alive: a long erase (rewrite, reflog expire,
 * gc) is slow but alive, and taking its lock mid-gc could prune a new writer's
 * objects. A file that is READABLE but is not a lock (empty, garbage) and is older
 * than 5 seconds is also stale; there is no holder to ask. A file that cannot be
 * READ at all (EACCES, EIO, anything but "missing") is never stale: we cannot tell
 * whose it is, so the caller waits.
 *
 * Known gap (parked): the pid and start time are judged in OUR pid namespace. A
 * lock written by a process in another namespace (a container sharing the data
 * dir) can name a pid that means something else here, and be judged stale while
 * its holder is alive. No current deployment shares a history dir across
 * namespaces; recording the namespace and boot id in the lock would close it.
 *
 * Taking over a stale lock goes through a BREAKER file (`crow-history.lock.break`,
 * created the same way, so only one waiter breaks at a time). Holding the breaker,
 * the waiter re-reads the lock and unlinks it only if it is still the same file
 * (same inode and token) and still stale; then it drops the breaker and creates
 * the lock the normal way. A live lock is never moved or renamed, so the lock name
 * is never briefly empty while someone holds it. A breaker whose holder is dead is
 * removed (again only if it is still the file judged) and the takeover retries.
 *
 * release() removes the file only while it still holds OUR token, so a lock that
 * was already taken over is never deleted out from under its new owner. It never
 * throws — it runs in a `finally`.
 *
 * `waitMs` is the whole wait budget; past it the call throws an Error whose
 * `.code` is "busy". A missing git dir throws `.code` "gone" instead (the project
 * was purged while we waited for it).
 */
import { closeSync, linkSync, openSync, readFileSync, rmSync, statSync, unlinkSync, writeSync } from "node:fs";
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

/**
 * Read a lock-shaped file.
 *   {state:"missing"}           no such file
 *   {state:"unreadable"}        any other read error (never judged stale)
 *   {state:"garbage"}           readable, but not a lock with a token
 *   {state:"ok", body, token}   a lock
 */
function readLockFile(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    return { state: err && err.code === "ENOENT" ? "missing" : "unreadable" };
  }
  try {
    const body = JSON.parse(text);
    if (body && typeof body === "object" && typeof body.token === "string") return { state: "ok", body, token: body.token };
  } catch {
    /* not JSON */
  }
  return { state: "garbage" };
}

/** The file's inode as a string, or null when it cannot be statted. */
function inoOf(path) {
  try {
    return String(statSync(path).ino);
  } catch {
    return null;
  }
}

/** The file's mtime in ms, or null when it is gone. */
function mtimeOf(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Whether a lock-shaped file (the lock or the breaker) may be taken over, and
 * which file that verdict is about.
 *
 * @returns {{state: string, stale: boolean, token: string|null, ino: string|null}}
 */
function judgeFile(path, { isPidAlive, getPidStart, clock }) {
  const ino = inoOf(path);
  const read = readLockFile(path);
  if (read.state === "missing") return { state: "missing", stale: false, token: null, ino };
  if (read.state === "unreadable") return { state: "unreadable", stale: false, token: null, ino };
  if (read.state === "garbage") {
    const mtime = mtimeOf(path);
    return { state: "garbage", stale: mtime !== null && clock() - mtime > 5000, token: null, ino };
  }
  const { body, token } = read;
  if (!isPidAlive(body.pid)) return { state: "ok", stale: true, token, ino };
  // Alive: stale only when the pid now belongs to a different process.
  if (body.pidStart != null) {
    const nowStart = getPidStart(body.pid);
    if (nowStart !== null && String(nowStart) !== String(body.pidStart)) return { state: "ok", stale: true, token, ino };
  }
  return { state: "ok", stale: false, token, ino };
}

/**
 * Create `path` holding `body`, whole, or fail with EEXIST when the name is taken:
 * write a private temp file and link it into place.
 */
function createWhole(path, body, beforeLink) {
  const temp = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeSync(fd, Buffer.from(JSON.stringify(body), "utf8"));
    } finally {
      closeSync(fd);
    }
    if (typeof beforeLink === "function") beforeLink(temp, path);
    linkSync(temp, path);
  } finally {
    try { rmSync(temp, { force: true }); } catch { /* only a name */ }
  }
}

/** Unlink `path` only if it is still the very file `verdict` judged. */
function unlinkIfSame(path, verdict, ctx) {
  const again = judgeFile(path, ctx);
  if (again.state !== verdict.state || again.ino !== verdict.ino || again.token !== verdict.token || !again.stale) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Take the cross-process lock for one git dir.
 *
 * @param {string} repoDir  the project's Crow git dir
 * @param {{waitMs?: number, pollMs?: number, isPidAlive?: Function,
 *   getPidStart?: Function, clock?: Function, _beforeLink?: Function,
 *   _beforeBreaker?: Function, _underBreaker?: Function, _afterBreak?: Function}} [opts]
 * @returns {Promise<{release: () => void}>}
 */
export async function acquireGitDirLock(repoDir, opts = {}) {
  const waitMs = Number.isFinite(Number(opts.waitMs)) ? Math.max(0, Number(opts.waitMs)) : 120_000;
  const pollMs = Number.isFinite(Number(opts.pollMs)) ? Math.max(1, Number(opts.pollMs)) : 50;
  const isPidAlive = typeof opts.isPidAlive === "function" ? opts.isPidAlive : defaultIsPidAlive;
  const getPidStart = typeof opts.getPidStart === "function" ? opts.getPidStart : defaultPidStart;
  const clock = typeof opts.clock === "function" ? opts.clock : Date.now;
  const lockPath = join(repoDir, "crow-history.lock");
  const breakerPath = `${lockPath}.break`;
  const token = randomBytes(16).toString("hex");
  const ctx = { isPidAlive, getPidStart, clock };
  const deadline = clock() + waitMs;
  let waited = false;

  const bodyFor = (tok) => ({ pid: process.pid, pidStart: getPidStart(process.pid), startedAt: clock(), token: tok });

  for (;;) {
    // The first attempt always happens, even with a zero budget: a free lock is
    // still free. Only a SECOND pass is refused by the deadline.
    if (waited && clock() >= deadline) {
      throw lockError("busy", "another change to this project's files is still running");
    }
    try {
      createWhole(lockPath, bodyFor(token), opts._beforeLink);
      return { release: () => releaseLock(lockPath, token) };
    } catch (err) {
      if (!err || err.code === "ENOENT") {
        // The git dir itself is gone: the project was purged while we waited.
        throw lockError("gone", "the project's file history directory is gone");
      }
      if (err.code !== "EEXIST") throw err;
    }

    waited = true;
    const verdict = judgeFile(lockPath, ctx);
    if (verdict.state !== "missing" && verdict.stale) {
      if (typeof opts._beforeBreaker === "function") opts._beforeBreaker(lockPath);
      await breakStaleLock(lockPath, breakerPath, verdict, ctx, opts);
      continue;
    }
    if (verdict.state === "missing") continue; // released between our create and our look

    await sleep(Math.min(pollMs, Math.max(1, deadline - clock())));
  }
}

/**
 * Remove a lock judged stale, serialized by the breaker file. Returns after one
 * attempt either way; the caller loops and tries to create the lock again.
 */
async function breakStaleLock(lockPath, breakerPath, verdict, ctx, opts) {
  const breakerToken = randomBytes(16).toString("hex");
  try {
    createWhole(breakerPath, { pid: process.pid, pidStart: ctx.getPidStart(process.pid), startedAt: ctx.clock(), token: breakerToken });
  } catch (err) {
    if (!err || err.code !== "EEXIST") return; // gone, or something we cannot fix here
    // Another waiter is breaking. If that breaker's holder is dead, clear it.
    const breaker = judgeFile(breakerPath, ctx);
    if (breaker.state !== "missing" && breaker.stale) unlinkIfSame(breakerPath, breaker, ctx);
    return;
  }
  try {
    if (typeof opts._underBreaker === "function") opts._underBreaker(lockPath);
    // Still the file we judged, and still stale? Only then does it go.
    const removed = unlinkIfSame(lockPath, verdict, ctx);
    if (typeof opts._afterBreak === "function") opts._afterBreak(removed);
  } finally {
    releaseLock(breakerPath, breakerToken);
  }
}

/** Remove the lock file, but only while it is still ours. Never throws. */
function releaseLock(lockPath, token) {
  try {
    const held = readLockFile(lockPath);
    if (held.state !== "ok" || held.token !== token) return;
    rmSync(lockPath, { force: true });
  } catch {
    /* a lock file we could not remove is taken over as stale later */
  }
}
