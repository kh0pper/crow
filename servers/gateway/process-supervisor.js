/**
 * Generic child-process supervision, extracted out of
 * `models/runtime.js`'s `startModel` (C4 Task 1) so a second consumer can
 * reuse the same restart/idle/kill machinery without any llama-server- or
 * model-specific knowledge baked in.
 *
 * Consumers:
 *   - `models/runtime.js` (`startModel`) — llama-server child, `key: alias`,
 *     `command: binPath`, `args: buildLlamaServerArgs(...)`, registered in
 *     `activeHandles` for the model-catalog panel's status snapshot.
 *   - `bot-runtime.js` (discord child, PR C4-C).
 *   - future Perch session hosts.
 *
 * Keep this file free of model- or bot-specific logic — anything that
 * needs to know about GGUF paths, aliases-as-served-identity, or Discord
 * tokens belongs in the caller, not here.
 */

import { spawn as spawnCb } from "node:child_process";

/**
 * Spawn and supervise a generic child process.
 *
 * Returns a handle `{ key, live, state, restartCount, lastError,
 * startedAt, child, status(), touch(), stop() }`.
 *
 * Supervision:
 *   - Own process group (`detached: true`) so `stop()` can
 *     `process.kill(-pid, "SIGTERM")` the whole tree, falling back to a
 *     direct child kill if the pgroup is already gone.
 *   - Wrapped in `setpriv --pdeathsig=SIGTERM <command> ...` IFF
 *     `setprivAvailable` — belt-and-braces process-group supervision: if
 *     the supervising process itself dies uncleanly (no chance to run its
 *     own `stop()`/SIGTERM-the-group path), `--pdeathsig` still gets the
 *     child a SIGTERM directly from the kernel.
 *   - Restart-with-backoff on an unexpected exit: up to `maxRestarts`
 *     (default 3) restarts, each waiting `backoffMs(attemptIndex)`
 *     (default exponential, capped at 30s) before respawning. On the
 *     `maxRestarts`-th unexpected exit, gives up: `state` becomes
 *     `"unhealthy"`, `lastError` retained, no further respawn.
 *   - Idle timer: stops the process after `idleMinutes` of no `touch()`
 *     calls, UNLESS `keepWarm` or `alwaysResident` is set (idle timer
 *     never scheduled at all in that case) or `idleMinutes <= 0` (the
 *     default — no idle timer unless a caller opts in, e.g. the
 *     llama-server case via `models/runtime.js`'s own `idleMinutes`
 *     default).
 *   - `onTerminal(reason)` fires EXACTLY ONCE, the first time this handle
 *     reaches a state it will never leave — `"stopped"` (via `stop()`,
 *     called explicitly or by the idle timer above) or `"unhealthy"` (the
 *     `maxRestarts`-th unexpected exit). A restart that still has budget
 *     left is NOT terminal — `onTerminal` does not fire for it. Exists so
 *     a caller that hands out a host-wide resource tied to this
 *     process's lifetime can release it exactly once, without polling
 *     `status()`. Never throws into the supervisor even if the callback
 *     itself throws.
 *   - `registry`: an optional `Map` the handle is registered into (keyed
 *     by `key`) on start and deregistered from once the process has
 *     actually stopped — the seam `models/runtime.js`'s `activeHandles`
 *     (and `getStatusSnapshot`) is built on. `null` (the default) means
 *     untracked — nothing is registered anywhere.
 *
 * `spawn`/`setTimeoutFn`/`clearTimeoutFn`/`onTerminal` are all injectable
 * so tests never touch a real process or a real clock.
 */
export function superviseProcess({
  key,
  command,
  args = [],
  env,
  cwd,
  spawn = spawnCb,
  setprivAvailable = false,
  maxRestarts = 3,
  backoffMs = (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
  idleMinutes = 0,
  keepWarm = false,
  alwaysResident = false,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  onTerminal = () => {},
  registry = null,
}) {
  const idleDisabled = !!keepWarm || !!alwaysResident || !(idleMinutes > 0);

  const handle = {
    key,
    live: false,
    state: "starting",
    restartCount: 0,
    lastError: null,
    startedAt: null,
    child: null,
    _idleTimer: null,
    _restartTimer: null,
    _stopped: false,
  };

  let terminalFired = false;
  function fireTerminal(reason) {
    if (terminalFired) return;
    terminalFired = true;
    try {
      onTerminal(reason);
    } catch {
      /* a caller's terminal hook must never break process supervision */
    }
  }

  function resetIdleTimer() {
    if (idleDisabled) return;
    if (handle._idleTimer) clearTimeoutFn(handle._idleTimer);
    handle._idleTimer = setTimeoutFn(() => handle.stop(), idleMinutes * 60 * 1000);
  }

  function spawnChild() {
    const spawnOpts = { detached: true, stdio: ["ignore", "pipe", "pipe"] };
    if (env !== undefined) spawnOpts.env = env;
    if (cwd !== undefined) spawnOpts.cwd = cwd;
    const [cmd, cmdArgs] = setprivAvailable
      ? ["setpriv", ["--pdeathsig=SIGTERM", command, ...args]]
      : [command, args];
    const child = spawn(cmd, cmdArgs, spawnOpts);
    handle.child = child;
    handle.live = true;
    handle.state = "running";
    handle.startedAt = new Date().toISOString();

    child.on("error", (err) => {
      handle.lastError = err && err.message;
    });
    child.on("exit", (code, signal) => {
      handle.live = false;
      handle.child = null;
      if (handle._stopped) {
        handle.state = "stopped";
        if (registry) registry.delete(key);
        fireTerminal("stopped");
        return;
      }
      handle.lastError = `exited (code=${code}, signal=${signal})`;
      if (handle.restartCount >= maxRestarts) {
        handle.state = "unhealthy";
        fireTerminal("unhealthy");
        return;
      }
      handle.restartCount += 1;
      handle.state = "restarting";
      const delay = backoffMs(handle.restartCount - 1);
      handle._restartTimer = setTimeoutFn(() => {
        if (!handle._stopped) spawnChild();
      }, delay);
    });

    resetIdleTimer();
  }

  handle.status = function status() {
    return {
      key,
      state: handle.state,
      live: handle.live,
      restartCount: handle.restartCount,
      lastError: handle.lastError,
      startedAt: handle.startedAt,
      pid: handle.child ? handle.child.pid : null,
    };
  };

  handle.touch = function touch() {
    resetIdleTimer();
  };

  handle.stop = function stop() {
    handle._stopped = true;
    if (handle._idleTimer) clearTimeoutFn(handle._idleTimer);
    if (handle._restartTimer) clearTimeoutFn(handle._restartTimer);
    if (registry) registry.delete(key);
    if (!handle.child) {
      handle.state = "stopped";
      handle.live = false;
      fireTerminal("stopped");
      return Promise.resolve();
    }
    const child = handle.child;
    const pid = child.pid;
    const exited = new Promise((resolvePromise) => child.once("exit", resolvePromise));
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
    return exited.then(() => {
      handle.state = "stopped";
      handle.live = false;
      // fireTerminal("stopped") already ran inside spawnChild's own "exit"
      // listener above (registered before this once()-listener, so it
      // always runs first) — idempotent via terminalFired, not repeated
      // here.
    });
  };

  if (registry) registry.set(key, handle);
  spawnChild();
  return handle;
}

/** Thin wrapper matching the spec's named export; identical to
 * `handle.stop()`. */
export function stopSupervised(handle) {
  return handle.stop();
}
