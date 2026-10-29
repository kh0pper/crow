/**
 * Pair subkeys: purpose-bound keys derived from a pair's `signing_key`.
 *
 * Each use of the pair secret gets its own label, so a MAC made for one
 * purpose can never stand in for another. Every label contains `/`, which an
 * HTTP method token (the first line of cross-host-auth's canonical string)
 * cannot, so a MAC under the raw signing key can never be mistaken for a
 * derivation either. See the private engineering notes for the design.
 */
import { createHmac } from "node:crypto";

export const PAIR_SUBKEY_LABELS = Object.freeze({
  SYNC: "crow/sync-pair-binding/v1",
  REMOTE_ACTOR: "crow/remote-actor/v1",
});

const LABELS = new Set(Object.values(PAIR_SUBKEY_LABELS));
const HEX_RE = /^(?:[0-9a-fA-F]{2})+$/;

/**
 * HMAC-SHA256(key = the DECODED signing_key bytes, label). Throws TypeError on
 * anything but non-empty even-length hex (Buffer.from would silently truncate
 * it) and Error on a label outside the frozen set.
 */
export function pairSubkeyFor(signingKeyHex, label) {
  if (typeof signingKeyHex !== "string" || !HEX_RE.test(signingKeyHex)) {
    throw new TypeError("pairSubkey: signing key must be non-empty hex");
  }
  if (!LABELS.has(label)) throw new Error("pairSubkey: unknown label");
  return createHmac("sha256", Buffer.from(signingKeyHex, "hex")).update(label).digest();
}
