/**
 * Fix-it detector: the boot guard is installed for this service but did not run.
 *
 * With `CROW_BOOT_GUARD=1` in the unit, an `ExecStartPre=` copy of the launcher
 * should stamp `launcher_ran_at` before this process starts, and an
 * `ExecStopPost=` copy should stamp `recorder_ran_at` after the previous one
 * ended. If either stamp is missing, the drop-in points at something that no
 * longer works (a node path that moved, a deleted launcher copy, a typo in the
 * unit) — and the failure is otherwise silent: the gateway boots fine and the
 * NEXT update that cannot start simply loops forever with no rollback (S13).
 *
 * No event fires for this: `runBootChecks()` calls `check()` once per start.
 */
import { bootGuardProblem } from "../../boot-guard-state.js";

export const DEDUP_KEY = "boot-guard:did-not-run";
export const SOURCE = "boot-guard";

export default {
  source: SOURCE,
  // A missing stamp emits no event: runBootChecks() calls check() at gateway start.
  events: [],
  async onEvent() {},
  /**
   * Upsert the card while the guard looks broken, RESOLVE it once a boot was
   * guarded. Never throws into boot.
   */
  async check(store, opts = {}) {
    const problem = bootGuardProblem(opts.bootGuard || {});
    if (!problem) {
      try { await store.resolveByKey(SOURCE, DEDUP_KEY); } catch { /* no row yet, or no store */ }
      return null;
    }
    const which = problem.reason === "recorder"
      ? "the part that records how a start ended did not run"
      : problem.reason === "launcher"
        ? "the part that runs before every start did not run"
        : "its record could not be read";
    await store.upsertItem({
      source: SOURCE,
      dedupKey: DEDUP_KEY,
      title: "The boot guard did not run",
      why: `This service is configured to roll back a Crow update that keeps crashing on startup `
        + `(CROW_BOOT_GUARD=1), but ${which}. Nothing else is affected — but a bad update cannot be `
        + `rolled back automatically, so it would keep restarting. Re-run the boot-guard install step `
        + `for this service (scripts/ops/install-boot-guard.sh), then restart it.`,
      severity: "warn",
      remedies: [], // needs the unit directory: the gateway cannot write /etc as root
      context: { reason: problem.reason, detail: String(problem.detail ?? "") },
    });
    return problem;
  },
};