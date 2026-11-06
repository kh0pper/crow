/**
 * v1 Fix-it remedy (instant): grant a capability to the ONE peer that asked.
 *
 * N1b-8 (security audit): this used to add the capability to the local
 * all-trusted-peers allowlist (`remote_exposed_tools`), so a single click caused
 * by one peer's request exposed the capability to every peer, permanently.
 * Now:
 *   - the target peer is the VERIFIED instance id recorded on the card
 *     (`args.requestingInstance`, or the stored card's context as a fallback);
 *     there is deliberately NO path from here to the all-peer list;
 *   - a missing/ill-shaped peer id refuses the remedy (fail closed) rather than
 *     widening the grant;
 *   - a peer that is no longer TRUSTED here (revoked, paused, untrusted, or its
 *     row is gone) refuses too (review round 2, N-a): a revoke→re-pair reuses
 *     the instance id, so a grant left behind for an untrusted id would come
 *     alive the moment that id pairs again;
 *   - the grant carries `expires_at` (`days` from now, default 30) or is
 *     permanent ("until I remove it": `untilRemoved` / `days: null`).
 *
 * Local-only: writes this instance's own settings; never a cross-instance write,
 * never synced.
 */
import { grantPeerCapability } from "../../peer-exposure-store.js";
import { normalizePeerId } from "../../../shared/peer-id.js";
import { peerTrust } from "../../../shared/peer-trust.js";

const DEFAULT_DAYS = 30;
const MAX_DAYS = 3650;

/** Resolve the grant duration from the card's remedy args. */
export function resolveDuration(args) {
  if (!args || typeof args !== "object") return { untilRemoved: false, days: DEFAULT_DAYS };
  if (args.untilRemoved === true || args.days === null) return { untilRemoved: true, days: null };
  const n = Number(args.days);
  if (!Number.isFinite(n) || n <= 0) return { untilRemoved: false, days: DEFAULT_DAYS };
  return { untilRemoved: false, days: Math.min(Math.floor(n), MAX_DAYS) };
}

export default async function exposeCapability(args, ctx) {
  const capability = args && typeof args.capability === "string" ? args.capability.trim() : "";
  if (!capability) return { resolved: false, message: "No capability specified." };
  // A federation peer's proxy entry (instance-<id>) is never a capability of
  // this instance: exposing it would let one peer reach another through us.
  if (capability.startsWith("instance-")) return { resolved: false, message: "That is another instance, not a capability of this one." };

  // The peer that asked, as recorded on the card from the verified request
  // identity. Never a name, never a value taken from the peer's own request.
  const peerId = normalizePeerId(args?.requestingInstance) || normalizePeerId(ctx?.item?.context?.requestingInstance);
  if (!peerId) {
    return { resolved: false, message: "This card has no verified requesting device, so the allowance cannot be limited to one. Nothing was shared." };
  }

  // N1b-8 review round 2 (N-a): the card is a snapshot of a past request; the
  // peer must still be trusted NOW. This is the same predicate the gate uses —
  // `enforcePeerExposure` only ever runs for an instance whose bearer hash
  // matched `TRUSTED_PEER_SQL` (trusted = 1 AND status IN ('active','offline'))
  // at the moment of use. A revoked or paused peer (or one this instance can no
  // longer read) is refused, and the lookup fails closed.
  const db = ctx?.db;
  if (!db) return { resolved: false, message: "Could not read this instance's peer list, so nothing was shared." };
  const trust = await peerTrust(db, peerId);
  if (!trust.ok) {
    const why = trust.reason === "trust_lookup_failed"
      ? "Crow couldn't confirm that device is still paired, so nothing was shared."
      : "That device isn't a trusted peer of this Crow any more, so nothing was shared. Pair it again and it can ask afresh.";
    return { resolved: false, message: why };
  }

  const { untilRemoved, days } = resolveDuration(args);
  const now = Date.now();
  const expiresAt = untilRemoved ? null : new Date(now + days * 86_400_000).toISOString();
  const result = await grantPeerCapability(db, { peerId, capability, expiresAt, now });
  if (!result.ok) return { resolved: false, message: "Could not record the allowance." };

  const when = untilRemoved ? "until you remove it" : `for ${days} day${days === 1 ? "" : "s"}`;
  console.log(`[fix-it] granted capability "${capability}" to peer ${peerId} ${when} (local scope)`);
  return { resolved: true, message: `${capability} is now shared with that device ${when}.` };
}