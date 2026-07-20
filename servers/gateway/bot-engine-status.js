/**
 * Bot-engine status — a LEAF module (imports ONLY pi_resolver.mjs).
 *
 * Two other subsystems each own a distinct signal about whether the bot
 * engine ("pi") is usable right now:
 *   - routes/bundles.js knows about in-flight installs (its in-memory jobs
 *     Map, via activeJobFor()).
 *   - bot-runtime.js (PR C4-C) knows about the circuit breaker guarding
 *     repeated spawn failures.
 *
 * Rather than importing either of those directly, each source registers
 * itself INTO this module at init via a setter (setActiveJobSource /
 * setBreakerSource). bundles.js is a ~2,500-line file that drags in express,
 * db.js, peer-forward, and cross-host-auth — importing it from here would
 * risk an ESM cycle back through anything that imports bot-engine-status
 * (the readiness UI, the attach gate). Inverting the wiring keeps this
 * module a leaf so both of those callers can use engineStatus() cheaply and
 * often without pulling in either dependency graph.
 *
 * Precedence, most urgent first (r1-reviewed): installing > absent >
 * unhealthy > ready. Absent beats a stale open breaker — an uninstalled
 * engine is "absent", never "unhealthy" (a breaker only means something
 * once something concrete has been spawned and failed; resolvePiCli()
 * returning null is ground truth that nothing is there to have failed).
 *
 * Every check here is a cheap synchronous fs stat (via resolvePiCli) or a
 * plain function call — no caching, no async I/O.
 */
import { resolvePiCli } from "../../scripts/pi-bots/pi_resolver.mjs";

const BOT_ENGINE_BUNDLE_ID = "bot-engine";

export const ENGINE_CHANNELS = ["gmail", "discord", "telegram", "slack"];

/** wired by bot-runtime.js in PR C4-C: fn() => { open, lastError, retryAt } | null */
let breakerSource = null;
/** wired by routes/bundles.js at router construction: fn(bundleId) => job | null */
let activeJobSource = null;

/** @param {() => ({open: boolean, lastError?: string, retryAt?: string} | null)} fn */
export function setBreakerSource(fn) {
  breakerSource = typeof fn === "function" ? fn : null;
}

/** @param {(bundleId: string) => (object | null)} fn */
export function setActiveJobSource(fn) {
  activeJobSource = typeof fn === "function" ? fn : null;
}

/**
 * Test-only: set (or clear) both registered sources in one call — mirrors
 * the _setDockerProbeForTest / _resetDockerProbeForTest idiom in
 * dashboard/panels/extensions/data-queries.js. Call with no args (or {})
 * between tests so one test's breaker/job stub can never leak into the
 * next (this module's sources are plain module-level state, not per-test).
 *
 * @param {{breaker?: Function|null, activeJob?: Function|null}} [seams]
 */
export function _setSeamsForTest({ breaker = null, activeJob = null } = {}) {
  breakerSource = typeof breaker === "function" ? breaker : null;
  activeJobSource = typeof activeJob === "function" ? activeJob : null;
}

/**
 * @param {object} [opts]
 * @param {object} [opts.env] defaults to process.env — forwarded to resolvePiCli
 * @param {string} [opts.crowHome] forwarded to resolvePiCli (test seam)
 * @param {string} [opts.repoRoot] forwarded to resolvePiCli (test seam)
 * @param {string} [opts.execPath] forwarded to resolvePiCli (test seam)
 * @returns {{state:"installing"}
 *          |{state:"absent"}
 *          |{state:"unhealthy", error: string|null, retryAt: string|null}
 *          |{state:"ready", source: string, cliPath: string}}
 */
export function engineStatus({ env = process.env, ...rest } = {}) {
  const job = activeJobSource?.(BOT_ENGINE_BUNDLE_ID);
  if (job) return { state: "installing" };

  const resolved = resolvePiCli({ env, ...rest });
  if (!resolved) return { state: "absent" };

  const breaker = breakerSource?.();
  if (breaker?.open) {
    return {
      state: "unhealthy",
      error: breaker.lastError ?? null,
      retryAt: breaker.retryAt ?? null,
    };
  }

  return { state: "ready", source: resolved.source, cliPath: resolved.cliPath };
}
