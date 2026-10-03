/**
 * peer-dial-health — per-process record of the tailnet instance-sync dialer's
 * view of each paired peer (DIALER-RETRY, 2026-10-03).
 *
 * Written by servers/sharing/tailnet-sync.js (outbound dialer + inbound
 * accept); read by the nest health signal (`peers-dial:<id>` warn) and the
 * Settings › Paired instances page ("Sync link" column).
 *
 * Why it exists: crow had NO dial address for black-swan for about six weeks
 * (its crow_instances row carried a :443 gateway_url — never dialed — and an
 * empty tailscale_ip). The dialer returned silently, 928 sync entries queued,
 * and nothing anywhere said so. A peer with no usable dial address is now a
 * health condition, and every peer's last attempt / last error is visible.
 *
 * ZERO imports (same discipline as peer-probe-health.js / provider-health.js)
 * so the dashboard render path and the test suite never drag in the sync
 * stack. State resets on gateway restart, so "no dial address since X" reads
 * "for AT LEAST X".
 */

let _peers = Object.create(null);

function entry(id) {
  return (_peers[id] ||= {
    lastAttemptAt: null,
    lastAttemptUrl: null,
    lastAttemptRole: null,
    lastError: null,
    lastErrorAt: null,
    failCount: 0,
    failingSince: null,
    linkedAt: null,
    linkDirection: null,
    linkClosedAt: null,
    noAddressSince: null,
    missing: null,
    backfilled: null,
  });
}

/** An outbound dial is starting. role: "dialer" (elected) | "fallback". */
export function recordDialAttempt(id, { url, role = "dialer", nowMs = Date.now() } = {}) {
  if (!id) return;
  const e = entry(id);
  e.lastAttemptAt = nowMs;
  e.lastAttemptUrl = url ? String(url).slice(0, 300) : null;
  e.lastAttemptRole = role;
}

/** A dial (or its handshake) failed. */
export function recordDialFailure(id, error, { nowMs = Date.now() } = {}) {
  if (!id) return;
  const e = entry(id);
  e.lastError = String(error?.message || error || "unknown error").slice(0, 300);
  e.lastErrorAt = nowMs;
  e.failCount += 1;
  if (e.failingSince == null) e.failingSince = nowMs;
}

/** An authenticated link is up. direction: "outbound" | "inbound". */
export function recordLinkUp(id, { direction, nowMs = Date.now() } = {}) {
  if (!id) return;
  const e = entry(id);
  e.linkedAt = nowMs;
  e.linkDirection = direction || null;
  e.linkClosedAt = null;
  e.failCount = 0;
  e.failingSince = null;
  e.noAddressSince = null;
  e.missing = null;
}

/** The authenticated link closed. */
export function recordLinkClosed(id, { nowMs = Date.now() } = {}) {
  if (!id || !_peers[id]) return;
  _peers[id].linkClosedAt = nowMs;
}

/**
 * The dialer has no usable address for this peer and no link to it exists.
 * `missing` is a list of human-readable reasons ("tailscale_ip is empty", …).
 * noAddressSince is kept from the FIRST observation (incident start).
 */
export function recordNoDialAddress(id, missing, { nowMs = Date.now() } = {}) {
  if (!id) return;
  const e = entry(id);
  if (e.noAddressSince == null) e.noAddressSince = nowMs;
  e.missing = Array.isArray(missing) ? missing.slice(0, 4).map((m) => String(m).slice(0, 160)) : null;
}

/** The peer has a usable address again (or a link exists). */
export function clearNoDialAddress(id) {
  if (!id || !_peers[id]) return;
  _peers[id].noAddressSince = null;
  _peers[id].missing = null;
}

/** A dial address was learned from the peer's signed handshake. */
export function recordAddressBackfill(id, fields, { nowMs = Date.now() } = {}) {
  if (!id) return;
  entry(id).backfilled = { at: nowMs, fields: Object.keys(fields || {}) };
}

/** Drop a peer that left scope (revoked / unpaired). */
export function forgetPeerDialHealth(id) {
  delete _peers[id];
}

/** Snapshot: { [id]: {...} } — copies, safe to hand to renderers. */
export function getPeerDialHealth() {
  const out = {};
  for (const [id, v] of Object.entries(_peers)) {
    out[id] = { ...v, missing: v.missing ? [...v.missing] : null, backfilled: v.backfilled ? { ...v.backfilled } : null };
  }
  return out;
}

/** Test seam. */
export function _resetPeerDialHealth() {
  _peers = Object.create(null);
}
