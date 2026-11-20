/**
 * The shared exit promise.
 *
 * Two places in this bundle clean something up when the process goes away: the
 * lease guard releases the browser lease (lease-guard.js) and the pages that
 * were opened under the private-address guard are blanked (private-address.js,
 * `blankPagesOnExit`). The lease guard replaces node's default exit for
 * SIGTERM/SIGINT, so if it exited as soon as the lease was released, the page
 * cleanup would be cut off half way — with a page left open and unguarded.
 *
 * So the cleanups are registered here instead, and the signal handler awaits ONE
 * promise (`runExitTasks()`) before it calls exit. This module owns nothing but
 * that promise:
 *
 *   - `runExitTasks()` runs every registered task once and returns the SAME
 *     promise on every call (a second signal, or a beforeExit after a SIGTERM,
 *     joins the run already in flight instead of starting a second one);
 *   - it never rejects: a task that throws, or whose promise rejects, is
 *     swallowed and does not stop the tasks after it;
 *   - a task that settles at once holds nothing back; a task that never settles
 *     would hold the exit, so every task keeps its own budget;
 *   - a task registered AFTER the first run is ignored for that run (the
 *     snapshot is taken when the run starts).
 *
 * `addExitTask`/`runExitTasks` are the module's default instance's methods, for
 * callers that need no separate instance (the tests make their own).
 */

/**
 * @returns {{addExitTask: (fn: () => unknown) => void, runExitTasks: () => Promise<void>}}
 */
export function createExitTasks() {
  /** The snapshot every call of `runExitTasks` would take, while no run has started. */
  const tasks = [];
  /** The one run: created on the first call, reused (and returned) forever after. */
  let running = null;

  const run = () => {
    // The snapshot is taken once per run: a task added after this point is not
    // part of it, and a later call joins this same promise.
    const snapshot = tasks.slice();
    return (async () => {
      for (const task of snapshot) {
        try {
          await task();
        } catch {
          // A cleanup that fails must not stop the other cleanups, and must not
          // reject the promise the exit path is waiting on.
        }
      }
    })();
  };

  return {
    /** Register a cleanup. It runs on the first `runExitTasks()` after this. */
    addExitTask(fn) {
      if (typeof fn === "function") tasks.push(fn);
    },
    /** Run every task registered so far, once; always the same promise. */
    runExitTasks() {
      running ||= run();
      return running;
    },
  };
}

/** The instance the bundle shares: one run per process. */
const shared = createExitTasks();

/** Register a cleanup with the shared instance (see the module comment). */
export const addExitTask = (fn) => shared.addExitTask(fn);

/** The shared instance's one exit promise: runs every task once, never rejects. */
export const runExitTasks = () => shared.runExitTasks();