/**
 * Test-only timer overrides.
 *
 * Some gateway loops tick on fixed production cadences (the sync outbox drain
 * every 60 s, the tailnet-sync rescan every 60 s, the dial backoff up to
 * 60 s). Multi-gateway tests wait on those ticks. testTunableMs lets such a
 * test shorten one, and nothing else can:
 *
 * - The override is read ONLY inside the test suite's scratch env, i.e. when
 *   CROW_SUITE_SCRATCH is set (scripts/run-suite.mjs exports it for every test
 *   process and its children). Outside it the variable is ignored and the
 *   production default applies, so a stray CROW_TEST_* in a real gateway's
 *   environment changes nothing.
 * - A value must be a plain positive integer of milliseconds; anything else is
 *   ignored (default applies).
 * - A value is clamped to at least `minMs` (default 250 ms), so a test can
 *   never turn a loop into a busy spin.
 *
 * Read once, where the timer is defined (module load or call time): set the
 * variable in the child's environment before it starts.
 */
export const TEST_TIMING_MIN_MS = 250;

/**
 * @param {string} name     env var name (by convention CROW_TEST_*)
 * @param {number} defaultMs the production value
 * @param {{minMs?: number, env?: object}} [opts]
 * @returns {number}
 */
export function testTunableMs(name, defaultMs, { minMs = TEST_TIMING_MIN_MS, env = process.env } = {}) {
  if (!env.CROW_SUITE_SCRATCH) return defaultMs;
  const raw = env[name];
  if (typeof raw !== "string" || !/^\d+$/.test(raw.trim())) return defaultMs;
  const ms = Number(raw.trim());
  if (!Number.isSafeInteger(ms) || ms <= 0) return defaultMs;
  return Math.max(ms, minMs);
}
