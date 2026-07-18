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
 * codebase goes through `acquireHostLock`).
 *
 * Path: `$XDG_RUNTIME_DIR/crow-native-llm-<mutexGroup>.lock`, falling back
 * to the OS tmpdir when `XDG_RUNTIME_DIR` is unset (headless/systemd
 * services, some containers). Never `~/.crow/...` — this lock is a
 * host-level resource, not per-instance state.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
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

/**
 * Attempt to acquire the advisory host lock for `mutexGroup`.
 *
 * Returns a `release()` function on success, or `null` if the lock is
 * currently held elsewhere by a live owner (never blocks — this is a
 * non-blocking `flock(LOCK_EX | LOCK_NB)` equivalent). A lockfile left
 * behind by a dead owner (pid no longer alive, or unreadable/corrupt
 * content — either way its liveness can't be confirmed) is treated as
 * stale and stolen rather than honored forever.
 *
 * @param {string} mutexGroup
 * @param {{runtimeDir?: string, pid?: number, isProcessAlive?: (pid:number)=>boolean, fs?: object}} [opts]
 *   `fs`/`pid`/`isProcessAlive` are injectable for tests; production uses
 *   the real `node:fs`, `process.pid`, and a real liveness check.
 * @returns {(() => void) | null}
 */
export function acquireHostLock(mutexGroup, opts = {}) {
  const {
    fs = { existsSync, mkdirSync, openSync, closeSync, writeSync, readFileSync, unlinkSync },
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
    // Stale (dead owner, or unreadable/corrupt content) — steal it.
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* already gone */
    }
    created = tryCreate();
    if (!created) return null; // lost a race with another stealer
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
