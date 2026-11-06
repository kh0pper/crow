/**
 * Peer instance ids — the ONE identity a per-peer grant may be keyed by.
 *
 * N1b-8 (security audit): a one-click "Allow" card must never widen a
 * capability to every peer. The grant is recorded against the peer that asked,
 * and the peer's identity is the id the request was VERIFIED with
 * (`req.instanceAuth.instance.id`, resolved from the bearer token hash by
 * `validateInstanceToken`) — never a name, hostname or id a request body
 * asserts about itself.
 *
 * The shape is the one enrollment already enforces on `source_instance_id`
 * (servers/gateway/routes/instance-enroll.js, ID_RE): [A-Za-z0-9._:-], 1..128
 * characters. Anything else (an object, a display name with spaces, an empty
 * string, a `__proto__`-style key) is not a peer id and must be refused rather
 * than used as a JSON object key.
 */

import { createHash } from "node:crypto";

const PEER_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * @param {unknown} raw
 * @returns {string|null} the trimmed id when it is id-shaped, else null.
 */
export function normalizePeerId(raw) {
  if (typeof raw !== "string") return null;
  const id = raw.trim();
  if (!PEER_ID_RE.test(id)) return null;
  // The regex allows `_`, so `__proto__`-style names DO pass it: this guard is
  // what keeps them from becoming JSON object keys.
  if (id === "__proto__" || id === "prototype" || id === "constructor") return null;
  return id;
}

/**
 * N1b-8 fix round 3: bind an Allow card to the PAIRING it was raised under.
 *
 * A revoke→re-pair reuses the instance id, so an id alone cannot tell "the peer
 * that asked" from "a later peer wearing the same id". `crow_instances.auth_token_hash`
 * can: it changes on every re-pair (NULL on revoke, a new hash on enroll/repair)
 * and on every rotation. The card stores only this 16-hex tag — never the raw
 * hash, which is a live credential — and the remedy compares it with the tag of
 * the peer's CURRENT hash. A mismatch is a refusal (the message says the device
 * was paired again).
 *
 * Rotation also changes the hash, so rotating a peer's token invalidates the
 * cards it left open. That fails closed: the peer asks again.
 *
 * @param {unknown} authTokenHash  crow_instances.auth_token_hash (already a hash)
 * @returns {string|null} 16 hex chars, or null when there is no hash to bind to
 */
export function pairingTag(authTokenHash) {
  if (typeof authTokenHash !== "string") return null;
  const hash = authTokenHash.trim();
  if (!hash) return null;
  return createHash("sha256").update(`crow-peer-card-pairing-v1:${hash}`).digest("hex").slice(0, 16);
}

/**
 * The one accepted tag shape: what `pairingTag()` produces. Anything else
 * (a missing field on a card written before this round, a hand-edited card, a
 * value a payload made up) becomes null, which the remedy refuses.
 */
export function normalizePairingTag(raw) {
  return typeof raw === "string" && /^[0-9a-f]{16}$/.test(raw) ? raw : null;
}