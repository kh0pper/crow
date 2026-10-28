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
 */

let _lookupFailures = Object.create(null);
let _untrusted = [];
let _orphans = [];

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

export function getPeerTrustHealth(nowMs = Date.now()) {
  const lookupFailures = {};
  for (const [id, v] of Object.entries(_lookupFailures)) {
    if (nowMs - v.at <= LOOKUP_FAILURE_TTL_MS) lookupFailures[id] = { ...v };
  }
  return { lookupFailures, untrustedWithCreds: _untrusted.map((r) => ({ ...r })), orphanKeys: [..._orphans] };
}

/** Test seam. */
export function _resetPeerTrustHealth() {
  _lookupFailures = Object.create(null);
  _untrusted = [];
  _orphans = [];
}
