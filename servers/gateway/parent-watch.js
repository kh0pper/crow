/**
 * parent-watch — die-with-session watchdog for the gateway (Item 2a-FU, finding 4).
 *
 * Problem: a scratch gateway launched from an interactive session can outlive
 * that session (no SIGTERM is ever delivered → gracefulShutdown never runs →
 * its bundle children keep the PROD ~/.crow/data/crow.db open for days — the
 * class behind past "database is locked" crash-loops).
 *
 * Mechanism: record the ppid at startup; poll it. If the ppid CHANGES from
 * that initial value, our parent died and init (or a subreaper) adopted us —
 * time to shut down cleanly, which also reaps our bundle children via
 * shutdownAll().
 *
 * The watch deliberately does NOT arm when:
 *   - process.env.INVOCATION_ID is set — we are running under systemd; the
 *     unit manager owns our lifecycle and ppid tricks don't apply. NOTE this
 *     is a heuristic: a scratch gateway spawned BY a systemd-managed process
 *     (a timer job, the pibot bridge) inherits INVOCATION_ID and silently
 *     never arms — and it also inherits the parent's *.service cgroup, so the
 *     out-of-process sweep spares it too. What actually covers that case is
 *     systemd itself: KillMode=control-group reaps the whole cgroup when the
 *     owning unit stops.
 *   - process.env.CROW_ALLOW_ORPHAN === "1" — explicit operator opt-out for
 *     deliberately detached scratch gateways.
 *   - the INITIAL ppid is already <= 1 — started detached, or we are a child
 *     of a container's PID 1. ppid==1 at boot is a LEGIT steady state in
 *     docker; a ppid CHANGE is the only safe orphaning signal, and one can
 *     never be observed from an initial ppid of 1.
 *
 * The interval is unref()ed so the watch never holds the event loop open.
 */

/**
 * @param {object} opts
 * @param {() => void} opts.onOrphaned  called exactly once when the ppid changes
 * @param {() => number} [opts.getPpid] injectable for tests (default: process.ppid)
 * @param {number} [opts.intervalMs]    poll interval (default 15000)
 * @returns {{ armed: boolean, stop: () => void }}
 */
export function startParentWatch({
  onOrphaned,
  getPpid = () => process.ppid,
  intervalMs = 15000,
} = {}) {
  if (typeof onOrphaned !== "function") {
    throw new TypeError("startParentWatch requires an onOrphaned callback");
  }

  const disarmed = { armed: false, stop() {} };

  if (process.env.INVOCATION_ID) return disarmed; // systemd owns our lifecycle
  if (process.env.CROW_ALLOW_ORPHAN === "1") return disarmed; // explicit opt-out

  const initialPpid = getPpid();
  if (!Number.isFinite(initialPpid) || initialPpid <= 1) return disarmed;

  let fired = false;
  const timer = setInterval(() => {
    if (fired) return;
    let current;
    try {
      current = getPpid();
    } catch {
      return; // transient read failure — try again next tick
    }
    if (current !== initialPpid) {
      fired = true;
      clearInterval(timer);
      onOrphaned();
    }
  }, intervalMs);
  timer.unref();

  return {
    armed: true,
    stop() {
      clearInterval(timer);
    },
  };
}
