/**
 * F.11: Identity attestation core.
 *
 * Crow's root Ed25519 identity signs per-app handles. Remote verifiers
 * (other fediverse actors, other Crow instances) fetch the signed
 * attestation from `/.well-known/crow-identity.json` on the gateway and
 * verify the signature using the root pubkey discovered via the crow_id
 * (which is sha256(ed25519_pub) — circular, so verification requires the
 * caller to also fetch the pubkey from a trusted source, or pin it).
 *
 * Attestation payload (canonical JSON, sorted keys):
 *   { crow_id, app, external_handle, app_pubkey?, version, created_at }
 *
 * Signed with the root Ed25519 private key; signature is stored hex.
 *
 * Revocations are also signed — the revocation list carries a signed
 * { attestation_id, revoked_at, reason } payload so pinning the
 * revocation list requires the same root key that made the attestation.
 *
 * Verification model:
 *   - Always fetch fresh; cache only if caller passes max_age_seconds.
 *   - Rate-limited at the HTTP surface to 60 req/min/IP (gateway).
 *   - No gossip via crow-sharing yet — only .well-known publication.
 */

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2";
import { createHash } from "node:crypto";

// noble/ed25519 requires sha512 sync
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

/**
 * Produce the canonical JSON string of an attestation payload for signing.
 * Keys are sorted lexicographically; nullish fields are omitted.
 */
export function canonicalPayload({ crow_id, app, external_handle, app_pubkey, version, created_at }) {
  const obj = { app, created_at, crow_id, external_handle, version };
  if (app_pubkey) obj.app_pubkey = app_pubkey;
  // Re-sort after optional insertion
  const sorted = Object.keys(obj).sort().reduce((a, k) => { a[k] = obj[k]; return a; }, {});
  return JSON.stringify(sorted);
}

/**
 * Sign an attestation payload with the root Ed25519 private key.
 * Returns hex signature.
 */
export function signAttestation(identity, payload) {
  const msg = new TextEncoder().encode(canonicalPayload(payload));
  const sig = ed.sign(msg, identity.ed25519Priv);
  return Buffer.from(sig).toString("hex");
}

/**
 * Verify an attestation signature. Returns boolean.
 * `rootPubkey` is the hex Ed25519 public key of the claimed crow_id.
 */
export function verifyAttestation(payload, sigHex, rootPubkey) {
  try {
    const msg = new TextEncoder().encode(canonicalPayload(payload));
    const sig = Buffer.from(sigHex, "hex");
    const pub = Buffer.from(rootPubkey, "hex");
    return ed.verify(sig, msg, pub);
  } catch {
    return false;
  }
}

/**
 * Verify that the supplied ed25519 pubkey actually maps to the claimed
 * crow_id (crow_id = first-8-bytes-of-sha256(ed25519_pub) encoded base36,
 * prefixed "crow:" — see servers/sharing/identity.js computeCrowId).
 * Catches swapped-pubkey attacks where an attacker publishes someone
 * else's crow_id with their own key.
 */
export function verifyCrowIdBinding(crowId, ed25519PubkeyHex) {
  try {
    const pub = Buffer.from(ed25519PubkeyHex, "hex");
    const hash = createHash("sha256").update(pub).digest();
    const num = hash.readBigUInt64BE(0);
    const b36 = num.toString(36).slice(0, 10).padStart(10, "0");
    const expected = `crow:${b36}`;
    return expected === crowId;
  } catch {
    return false;
  }
}

/**
 * Canonical payload for a revocation signature.
 */
export function canonicalRevocationPayload({ attestation_id, revoked_at, reason }) {
  const obj = { attestation_id, revoked_at };
  if (reason) obj.reason = reason;
  const sorted = Object.keys(obj).sort().reduce((a, k) => { a[k] = obj[k]; return a; }, {});
  return JSON.stringify(sorted);
}

export function signRevocation(identity, payload) {
  const msg = new TextEncoder().encode(canonicalRevocationPayload(payload));
  const sig = ed.sign(msg, identity.ed25519Priv);
  return Buffer.from(sig).toString("hex");
}

export function verifyRevocation(payload, sigHex, rootPubkey) {
  try {
    const msg = new TextEncoder().encode(canonicalRevocationPayload(payload));
    const sig = Buffer.from(sigHex, "hex");
    const pub = Buffer.from(rootPubkey, "hex");
    return ed.verify(sig, msg, pub);
  } catch {
    return false;
  }
}

/**
 * Canonical list of app names we accept attestations for. Kept deliberately
 * small and explicit rather than free-form — if an operator wants to attest
 * for an app not on this list, they bump this constant in a follow-up PR.
 * (Caps the surface for accidental typos like "matodon" vs "mastodon".)
 */
export const SUPPORTED_APPS = Object.freeze([
  "mastodon",
  "gotosocial",
  "writefreely",
  "funkwhale",
  "pixelfed",
  "lemmy",
  "matrix-dendrite",
  "peertube",
]);
