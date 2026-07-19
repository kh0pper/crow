/**
 * Advisory host-wide mutex for native llama.cpp runtime processes (Item G,
 * Task 8). Two native models in the same `mutexGroup` (see
 * `manager.js`'s `pickChatMutexGroup`) must never both hold the GPU at
 * once; `acquireHostLock(mutexGroup)` is the primitive the process
 * supervisor (`runtime.js`) and Task 9's gpu-orchestrator wiring use to
 * serialize that.
 *
 * Design choice, documented honestly: Node has no built-in `flock(2)`
 * binding, and this task adds no new npm dependency. Two ways to get an
 * advisory lock without one:
 *
 *   1. Spawn the external `flock` CLI (util-linux) around the whole
 *      critical section.
 *   2. A PID lockfile created with the `wx` ("open, fail if it exists")
 *      flag — the same `O_CREAT|O_EXCL` atomicity `flock(2)` itself is
 *      built on, just addressed through the filesystem namespace instead
 *      of a kernel lock table entry.
 *
 * (1) is Linux-only in practice — `flock` ships with util-linux, which is
 * not present on macOS by default (a v1 target platform per the runtime
 * catalog's darwin-arm64/darwin-x64 assets) — and it also only lets a
 * *whole external command* hold the lock for its lifetime, which doesn't
 * fit this module's "acquire now, release later from arbitrary code"
 * shape (the caller starts a long-lived llama-server child in between).
 * (2) works identically on every POSIX platform Node runs on with zero
 * new dependencies, so that's what this module implements.
 *
 * Same caveat as `flock(2)` itself applies: this is *advisory* — nothing
 * stops another process from deleting or ignoring the lockfile. It only
 * protects cooperating callers (every native-runtime caller in this
 * codebase goes through `acquireHostLock`). The stale-lock steal (see
 * `stealStaleLock` below) is rename-atomic — see its doc for the TOCTOU
 * this guards against — but a lock is still just a cooperative signal:
 * two uncoordinated processes that both bypass `acquireHostLock` entirely
 * (or a lock whose file was manually deleted from outside this module)
 * are not prevented from colliding by anything in this file. The REAL
 * backstops against two llama-server processes actually fighting over
 * the same GPU/port are one layer up in `runtime.js`: `identityProbe`
 * (never trusts a port as "ours" without confirming what it's actually
 * serving) and `state.js`'s `allocatePort` bind-test (never trusts a
 * port reservation without confirming the OS will actually let it bind).
 * This lock is a fast-path optimization to avoid contending for those in
 * the common case, not the sole correctness mechanism.
 *
 * Path: `$XDG_RUNTIME_DIR/crow-native-llm-<mutexGroup>.lock`, falling back
 * to the OS tmpdir when `XDG_RUNTIME_DIR` is unset (headless/systemd
 * services, some containers). Never `~/.crow/...` — this lock is a
 * host-level resource, not per-instance state.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** True if a process with this pid appears to be alive on this host. A
 * `kill(pid, 0)` that succeeds, or fails with EPERM (exists but owned by
 * someone else), both count as "alive" — only ESRCH ("no such process")
 * means it's genuinely gone and the lock it left behind is stale. */
function defaultIsProcessAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === "EPERM";
  }
}

/** Directory the lockfile lives in: `opts.runtimeDir`, else
 * `$XDG_RUNTIME_DIR`, else the OS tmpdir. Exported so callers/tests can
 * predict the path without duplicating the fallback rule. */
export function lockDirFor(opts = {}) {
  return opts.runtimeDir || process.env.XDG_RUNTIME_DIR || tmpdir();
}

/** Full path to `mutexGroup`'s lockfile under `lockDirFor(opts)`. */
export function lockPathFor(mutexGroup, opts = {}) {
  return join(lockDirFor(opts), `crow-native-llm-${mutexGroup}.lock`);
}

function readLockPid(fs, path) {
  try {
    const raw = fs.readFileSync(path, "utf8");
    const pid = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function randomSuffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Discard a stale lockfile at `lockPath`, rename-atomic — this is the fix
 * for a real two-process TOCTOU a reviewer reproduced against an earlier
 * version of this module that did a bare, unconditional `unlinkSync`:
 *
 *   1. Racers A and B both find the SAME lock stale (dead owner pid) and
 *      both decide to steal it.
 *   2. A unlinks the stale file, then (successfully, via its own
 *      O_CREAT|O_EXCL `tryCreate`) writes its OWN fresh lock at the same
 *      path.
 *   3. B — still mid-steal, unaware A already finished — unlinks
 *      `lockPath` AGAIN. `unlinkSync` doesn't check *whose* file is
 *      there; it just removes whatever currently exists. B has just
 *      destroyed A's live lock without A knowing.
 *   4. B creates its own fresh lock. Now BOTH A and B believe they hold
 *      the mutex.
 *
 * The fix: instead of blindly unlinking, atomically CLAIM the file via
 * `renameSync(lockPath, <private staging path>)`. `rename(2)` on the same
 * source path can only succeed for exactly one caller — every other
 * concurrent renamer targeting that same source gets `ENOENT` once the
 * winner's rename has completed, and simply gives up (falls through to
 * `acquireHostLock`'s own subsequent `tryCreate()`, which will correctly
 * fail if the winner has since created their new lock, or correctly
 * succeed into a genuinely free slot if the winner's own steal is what
 * emptied it).
 *
 * The winner still isn't done: `rename` is atomic but content-blind — if
 * some OTHER process had already recreated a live, unrelated lock at
 * `lockPath` between this caller's earlier staleness read and this
 * rename call, the winner would have just yanked THAT away by accident.
 * So after winning the rename, re-read the staged copy and compare its
 * pid against `existingPid` (the pid this caller observed as stale
 * earlier, passed in). A match confirms it's genuinely the same stale
 * file — discard it. A mismatch means this caller almost stole a live
 * lock out from under its legitimate new owner — rename it straight back
 * rather than destroy it, and let the subsequent `tryCreate()` correctly
 * fail against that restored, legitimate lock.
 *
 * Exported for direct testing of this specific race (see
 * `tests/models-runtime.test.js`) — the interleaving above can't be
 * reliably forced through the public `acquireHostLock` entry point alone
 * since a real re-read there always reflects "whatever is on disk right
 * now", not "what a racer believed a moment ago".
 */
export function stealStaleLock({ fs, lockPath, existingPid }) {
  const stagingPath = `${lockPath}.steal.${randomSuffix()}`;
  try {
    fs.renameSync(lockPath, stagingPath);
  } catch (err) {
    if (err && err.code === "ENOENT") return; // another racer already claimed/cleared it
    throw err;
  }
  const stagedPid = readLockPid(fs, stagingPath);
  if (stagedPid === existingPid) {
    // Genuinely the same stale file we decided to steal from — discard it,
    // freeing lockPath for a fresh O_CREAT|O_EXCL create.
    try {
      fs.unlinkSync(stagingPath);
    } catch {
      /* already gone */
    }
  } else {
    // We accidentally captured a DIFFERENT (fresh/live) lock that was
    // (re)created between our staleness read and this rename — put it
    // back rather than clobber its legitimate owner.
    try {
      fs.renameSync(stagingPath, lockPath);
    } catch {
      /* best-effort restore; if this also fails there's nothing more we
       * can safely do from here without risking a second collision */
    }
  }
}

/**
 * Attempt to acquire the advisory host lock for `mutexGroup`.
 *
 * Returns a `release()` function on success, or `null` if the lock is
 * currently held elsewhere by a live owner (never blocks — this is a
 * non-blocking `flock(LOCK_EX | LOCK_NB)` equivalent). A lockfile left
 * behind by a dead owner (pid no longer alive, or unreadable/corrupt
 * content — either way its liveness can't be confirmed) is treated as
 * stale and stolen (via `stealStaleLock`, rename-atomic — see its doc)
 * rather than honored forever.
 *
 * @param {string} mutexGroup
 * @param {{runtimeDir?: string, pid?: number, isProcessAlive?: (pid:number)=>boolean, fs?: object}} [opts]
 *   `fs`/`pid`/`isProcessAlive` are injectable for tests; production uses
 *   the real `node:fs`, `process.pid`, and a real liveness check.
 * @returns {(() => void) | null}
 */
export function acquireHostLock(mutexGroup, opts = {}) {
  const {
    fs = { existsSync, mkdirSync, openSync, closeSync, writeSync, readFileSync, unlinkSync, renameSync },
    pid = process.pid,
    isProcessAlive = defaultIsProcessAlive,
  } = opts;
  const lockPath = lockPathFor(mutexGroup, opts);
  fs.mkdirSync(dirname(lockPath), { recursive: true });

  const tryCreate = () => {
    let fd;
    try {
      fd = fs.openSync(lockPath, "wx");
    } catch (err) {
      if (err && err.code === "EEXIST") return false;
      throw err;
    }
    try {
      fs.writeSync(fd, String(pid));
    } finally {
      fs.closeSync(fd);
    }
    return true;
  };

  let created = tryCreate();
  if (!created) {
    const existingPid = readLockPid(fs, lockPath);
    if (existingPid != null && isProcessAlive(existingPid)) {
      return null; // held elsewhere by a live owner
    }
    // Stale (dead owner, or unreadable/corrupt content) — steal it, then
    // race a fresh create the same way the very first attempt did. The
    // final tryCreate() is itself O_CREAT|O_EXCL-atomic, so no matter how
    // stealStaleLock resolved (won/lost/aborted-and-restored), at most one
    // concurrent caller ever ends up holding the lock.
    stealStaleLock({ fs, lockPath, existingPid });
    created = tryCreate();
    if (!created) return null; // someone else's create won the re-race
  }

  let released = false;
  return function release() {
    if (released) return;
    released = true;
    // Only remove the file if it still identifies us — a defensive check
    // against removing a lock some other steal race already replaced.
    try {
      const currentPid = readLockPid(fs, lockPath);
      if (currentPid === pid) fs.unlinkSync(lockPath);
    } catch {
      /* already gone */
    }
  };
}
