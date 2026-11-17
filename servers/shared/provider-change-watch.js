// servers/shared/provider-change-watch.js
/**
 * Poll a cheap table fingerprint and report a change once.
 *
 * Why this exists: providers-db.js's `setProviderChangeHook` fires only for
 * writes made INSIDE the calling process. A row written by a script or CLI
 * elsewhere (the same providers table, another process) is invisible to that
 * hook, so pi's models.json kept missing it until the next hourly reconcile or
 * a restart — a bot bound to the new row failed to start a session.
 * `providersFingerprint` is one aggregate query, so a tick costs a few
 * microseconds of SQLite work.
 *
 * Semantics:
 *   - the first fingerprint ever seen is the baseline and reports nothing;
 *   - a later DIFFERENT value calls onChange() once and becomes the baseline
 *     (a steady table stays silent);
 *   - onChange is awaited. A throw from either function is swallowed and the
 *     old baseline is kept, so the next tick tries again;
 *   - polls never overlap: a call made while one is in flight returns at once.
 *
 * Every collaborator is injectable, so callers own the clock and the timing.
 */

export function createProviderChangeWatch({
  fingerprintFn,
  onChange,
  intervalMs = 10000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  let baseline = null;
  let seen = false; // has any fingerprint arrived yet?
  let inFlight = false;
  let timer = null;

  const poll = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      let fp;
      try { fp = await fingerprintFn(); } catch { return; }
      if (!seen) { seen = true; baseline = fp; return; }
      if (fp === baseline) return;
      try { await onChange(); } catch { return; }
      baseline = fp;
    } finally {
      inFlight = false;
    }
  };

  const start = () => {
    if (timer !== null) return;
    timer = setIntervalFn(poll, intervalMs);
    timer?.unref?.(); // a watch never holds the process open
  };

  const stop = () => {
    if (timer === null) return;
    clearIntervalFn(timer);
    timer = null;
  };

  return { start, stop, poll };
}