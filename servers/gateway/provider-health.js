/**
 * provider-health — per-process residency state for alwaysResident inference
 * providers (F-HEALTH-1).
 *
 * Written by gpu-orchestrator.js's residency poll (pollResidency): each tick it
 * records, for every provider THIS machine owns, whether the last probe of its
 * baseUrl succeeded. Read by the gateway's nest `providersSignal` with a PLAIN
 * IMPORT — this module has ZERO imports so pulling it into the dashboard render
 * path (and the test suite) can never drag in the orchestrator's child_process
 * / providers.js / db.js chain. Same per-process-singleton discipline as
 * receive-health.js and isAuditDegraded() in servers/shared/cross-host-auth.js.
 *
 * initialized: false = the orchestrator never ran (e.g. a throw before arming,
 * or a --no-auth boot that hasn't polled yet) — the signal renders "off", never
 * a false warn. It is the analogue of receive-health's receiveWired:null.
 *
 * State is per-process and resets on gateway restart. That is correct: a fresh
 * boot legitimately earns a fresh warm-up window, so a displayed outage age is
 * "unreachable for AT LEAST X".
 *
 * The outage clock: a provider is in outage when
 *   !ready && (nowMs - (lastReadyAt ?? firstOwnedAt)) >= threshold.
 * firstOwnedAt is stamped once, when ownership is taken, and NEVER moves on a
 * repeat not-ready — it is the origin for a provider that has never answered in
 * this process (the grackle case). lastReadyAt is stamped on every success and
 * is what the clock restarts from once the provider has answered at least once.
 */

const INITIAL = () => ({
  initialized: false,
  providers: Object.create(null),
});

let _state = INITIAL();

export function setResidencyInitialized() {
  _state.initialized = true;
}

/**
 * Record one probe result for a provider this machine has decided it OWNS.
 * Creates the entry (owned:true, firstOwnedAt stamped, lastReadyAt:null) on
 * first sight. Always advances baseUrl/embed/ready/checkedAt. On ready: stamps
 * lastReadyAt and clears lastError. On not-ready: records lastError (or null)
 * WITHOUT touching firstOwnedAt or lastReadyAt, so the outage clock survives.
 */
export function recordResidency(name, { ready, nowMs, baseUrl, embed = false, error = null } = {}) {
  let p = _state.providers[name];
  if (!p) {
    p = _state.providers[name] = {
      owned: true,
      baseUrl,
      embed: !!embed,
      ready: false,
      firstOwnedAt: nowMs,
      lastReadyAt: null,
      lastError: null,
      checkedAt: nowMs,
    };
  }
  p.baseUrl = baseUrl;
  p.embed = !!embed;
  p.ready = !!ready;
  p.checkedAt = nowMs;
  if (ready) {
    p.lastReadyAt = nowMs;
    p.lastError = null;
  } else {
    p.lastError = error != null ? (error?.message ?? String(error)) : null;
  }
}

/**
 * Drop a provider entirely. Used by the poll when a provider's baseUrl changes
 * (ownership must be re-evaluated from scratch) or when it stops being
 * orchestratable — a fresh recordResidency then stamps a new firstOwnedAt.
 */
export function releaseResidency(name) {
  delete _state.providers[name];
}

/**
 * Drop entries whose name is NOT in declaredNames (an array or a Set of every
 * provider still declared alwaysResident in the config). Nothing else — it
 * NEVER prunes on locality: a provider that fails a locality check for one tick
 * (tailscale0 restart) must KEEP its outage clock. Pruning on locality was the
 * reviewed CRITICAL.
 */
export function pruneResidency(declaredNames) {
  const declared = declaredNames instanceof Set ? declaredNames : new Set(declaredNames);
  for (const name of Object.keys(_state.providers)) {
    if (!declared.has(name)) delete _state.providers[name];
  }
}

/** Read a copy safe to mutate — mutating it does not touch module state. */
export function getProviderHealth() {
  const providers = {};
  for (const name of Object.keys(_state.providers)) {
    providers[name] = { ..._state.providers[name] };
  }
  return { initialized: _state.initialized, providers };
}

/** Test hook — restore the initial shape (mirrors _resetReceiveHealth). */
export function _resetProviderHealth() {
  _state = INITIAL();
}
