/**
 * peer-probe-health — per-process record of whether each paired peer's
 * gateway URL answers /health (audit A14, 2026-10-02).
 *
 * Written by proxy.js loadRemoteInstances (the 60 s federation probe); read
 * by the nest `peers` signal. ZERO imports, same discipline as
 * provider-health.js, so the dashboard render path and the test suite never
 * drag in proxy.js.
 *
 * Why not crow_instances.last_seen_at: it is refreshed by doors that do not
 * cross the tailnet. Hyperswarm replication runs over the public DHT, so
 * grackle kept a fresh last_seen_at for the 5 days (2026-09-17..22) it sat
 * logged out of Tailscale, with its blog Funnel, Serve and Ramble all down
 * and no alert. The gateway-URL probe is the one check that fails exactly
 * when the tailnet path is gone.
 *
 * State resets on gateway restart, so an outage age reads "unreachable for
 * AT LEAST X" (same contract as provider-health).
 */

let _peers = Object.create(null);

/**
 * @param {string} id      crow_instances.id
 * @param {boolean} ok     did <gateway_url>/health answer 2xx
 * @param {object} [opts]
 * @param {number} [opts.nowMs]
 * @param {string} [opts.error]
 */
export function recordPeerProbe(id, ok, { nowMs = Date.now(), error = null } = {}) {
  if (!id) return;
  const prev = _peers[id];
  if (ok) {
    _peers[id] = { failingSince: null, lastOkAt: nowMs, lastError: null };
  } else {
    _peers[id] = {
      failingSince: prev?.failingSince ?? nowMs,
      lastOkAt: prev?.lastOkAt ?? null,
      lastError: error ? String(error).slice(0, 200) : null,
    };
  }
}

/** Snapshot: { [id]: { failingSince, lastOkAt, lastError } }. */
export function getPeerProbeHealth() {
  const out = {};
  for (const [id, v] of Object.entries(_peers)) out[id] = { ...v };
  return out;
}

/** Test seam. */
export function _resetPeerProbeHealth() {
  _peers = Object.create(null);
}
