/**
 * peer-trust-health — per-process record of peer-trust problems, read by the
 * Nest health signals. ZERO imports (same discipline as peer-probe-health.js)
 * so the dashboard render path never drags in the DB layer.
 *
 * Three kinds:
 *   lookupFailures  — a trust lookup failed on both the captured and a fresh
 *                     DB client; the peer was refused (fail closed, loud).
 *   untrustedWithCreds — rows that fail the trust predicate but still hold a
 *                     bearer hash or a credential-store entry ("re-pair or revoke").
 *   orphanKeys      — credential-store entries with no crow_instances row.
 *   unboundPeers    — siblings that sync without pair binding (PT-2a legacy:
 *                     older Crow, or no pair key on one side).
 *   pairBindingRefusals — siblings whose sync handshake was refused by the
 *                     pair-binding policy (id → { reason, message, at }).
 * The two pair-binding kinds are written by sync-pair-binding.js
 * (recordPairBindingState) and expire like lookupFailures.
 */

let _lookupFailures = Object.create(null);
let _untrusted = [];
let _orphans = [];
let _unboundPeers = Object.create(null);
let _pairRefusals = Object.create(null);

/** A lookup for `id` failed closed. Kept for 10 minutes after the last failure. */
export function recordTrustLookupFailure(id, error, nowMs = Date.now()) {
  if (!id) return;
  _lookupFailures[id] = { at: nowMs, error: error ? String(error).slice(0, 200) : null };
}

/** @param {{id: string, name?: string}[]} rows */
export function setUntrustedWithCreds(rows) { _untrusted = (rows || []).map((r) => ({ id: r.id, name: r.name || null })); }

/** @param {string[]} ids */
export function setOrphanKeys(ids) { _orphans = [...(ids || [])]; }

const LOOKUP_FAILURE_TTL_MS = 10 * 60 * 1000;
const PAIR_BINDING_TTL_MS = LOOKUP_FAILURE_TTL_MS;

/** `id` synced as legacy (no pair binding). Clears its refusal. */
export function recordUnboundPeer(id, message, nowMs = Date.now()) {
  if (!id) return;
  delete _pairRefusals[id];
  _unboundPeers[id] = { at: nowMs, message: String(message || "").slice(0, 300) };
}

/** `id`'s sync handshake was refused by the pair-binding policy. Clears its unbound entry. */
export function recordPairBindingRefusal(id, reason, message, nowMs = Date.now()) {
  if (!id) return;
  delete _unboundPeers[id];
  _pairRefusals[id] = { at: nowMs, reason: reason ? String(reason) : null, message: String(message || "").slice(0, 300) };
}

/** A bound handshake: drop both pair-binding entries for `id`. */
export function clearPairBindingState(id) {
  if (!id) return;
  delete _unboundPeers[id];
  delete _pairRefusals[id];
}

function fresh(map, nowMs, ttl) {
  const out = {};
  for (const [id, v] of Object.entries(map)) if (nowMs - v.at <= ttl) out[id] = { ...v };
  return out;
}

export function getPeerTrustHealth(nowMs = Date.now()) {
  const lookupFailures = {};
  for (const [id, v] of Object.entries(_lookupFailures)) {
    if (nowMs - v.at <= LOOKUP_FAILURE_TTL_MS) lookupFailures[id] = { ...v };
  }
  return {
    lookupFailures,
    untrustedWithCreds: _untrusted.map((r) => ({ ...r })),
    orphanKeys: [..._orphans],
    unboundPeers: fresh(_unboundPeers, nowMs, PAIR_BINDING_TTL_MS),
    pairBindingRefusals: fresh(_pairRefusals, nowMs, PAIR_BINDING_TTL_MS),
  };
}

/** Test seam. */
export function _resetPeerTrustHealth() {
  _lookupFailures = Object.create(null);
  _untrusted = [];
  _orphans = [];
  _unboundPeers = Object.create(null);
  _pairRefusals = Object.create(null);
}
