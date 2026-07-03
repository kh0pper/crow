/**
 * Short-code pairing (Messages Phase 2 PR2 / C2) — pure crypto module.
 *
 * A 12-char Crockford-base32 code (60 bits from crypto.randomBytes) is the
 * ONLY shared secret. Both sides derive a secp256k1 keypair from it via
 * memory-hard scrypt; the inviter publishes a kind:4 self-DM under that key
 * (kind:4 so the self-hosted relay's allowlist carries it) whose NIP-44
 * content wraps a SHORT-EXPIRY invite code. THREAT MODEL: the event is public
 * and the derived key also signs it — a cracked code within the window =
 * pairing MITM. The salt is a FIXED product constant (the code is the only
 * shared input), so the memory-hard cost is a ONE-TIME precomputation over
 * the whole code space, NOT a per-guess cost — 60 bits (not the spec's 40-bit
 * floor) is chosen so that one-time table is infeasible (~10^10 core-years,
 * ~32-exabyte) rather than merely expensive. Layered defenses: 60-bit
 * entropy x memory-hard scrypt x ~10-min expiry (envelope + short inner code
 * + ledger cutoff) x authenticated single-use x acceptor fail-closed on a
 * duplicate-event code x the safety number as the named (PR3) backstop.
 *
 * Pure module: no manager imports, no logging, never logs a code.
 */

import { randomBytes, scrypt as _scrypt } from "crypto";
import { promisify } from "util";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import * as nip44 from "nostr-tools/nip44";

const scrypt = promisify(_scrypt);

export const SHORTCODE_EXPIRY_MS = 10 * 60 * 1000; // minutes-scale, per guardrail

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford: no I, L, O, U
const SALT = "crow-shortcode-invite-v1"; // FIXED product constant — the code is the
  // only shared secret, so no per-invite salt is possible. This makes the KDF cost a
  // ONE-TIME precomputation over the whole code space, which is exactly why CODE_LEN is
  // 12 (60 bits), not the spec's 40-bit floor: a 2^40 table is buildable by a funded
  // adversary; a 2^60 one is not (see the plan's THREAT MODEL header).
const CODE_LEN = 12; // 12 x 5 bits = 60 bits
const SCRYPT_PARAMS = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

/** CODE_LEN symbols x 5 bits = 60 bits, drawn bias-free from 8 random bytes (64 bits). */
export function generateShortCode() {
  const bytes = randomBytes(8); // 64 random bits; we consume the top 60
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  bits >>= 4n; // drop the low 4 bits → exactly 60 bits, no modulo bias (32 | 2^60)
  let code = "";
  for (let i = 0; i < CODE_LEN; i++) {
    code = ALPHABET[Number(bits & 31n)] + code; // low 5 bits → prepend → MSB-first order
    bits >>= 5n;
  }
  return code;
}

/** Display grouping in 4s: K7Q4-M2X9-3FHT. */
export function formatShortCode(code) {
  return code.match(/.{1,4}/g).join("-");
}

/**
 * Uppercase, strip separators, map Crockford confusables (I/L→1, O→0).
 * Returns "" unless the result is EXACTLY 12 alphabet chars (U stays invalid).
 */
export function normalizeShortCode(input) {
  if (typeof input !== "string") return "";
  const up = input.toUpperCase().replace(/[-\s]/g, "")
    .replace(/I/g, "1").replace(/L/g, "1").replace(/O/g, "0");
  if (up.length !== CODE_LEN) return "";
  for (const ch of up) if (!ALPHABET.includes(ch)) return "";
  return up;
}

/**
 * Derive the rendezvous keypair from the code. ASYNC scrypt only — the
 * ~128MB/~1s derivation must never block the event loop. `opts.N` exists
 * FOR TESTS ONLY (full-strength derivation in every production call).
 */
let _derivChain = Promise.resolve(); // M4: single-flight — one 128MB scrypt at a time
export async function deriveShortCodeKeys(code, opts = {}) {
  const norm = normalizeShortCode(code);
  if (!norm) throw new Error("invalid short code");
  const params = { ...SCRYPT_PARAMS, ...(opts.N ? { N: opts.N } : {}) };
  const run = _derivChain.then(async () => {
    const priv = await scrypt(norm, SALT, 32, params);
    return { priv: Buffer.from(priv), pub: getPublicKey(priv) };
  });
  // Chain regardless of this call's outcome so one failure doesn't wedge the queue.
  _derivChain = run.then(() => {}, () => {});
  return run;
}

/** Kind:4 self-DM under the code key; content = NIP-44({ inviteCode, expires }). */
export function buildRendezvousEvent(keys, payload) {
  const conversationKey = nip44.v2.utils.getConversationKey(keys.priv, keys.pub);
  const content = nip44.v2.encrypt(JSON.stringify(payload), conversationKey);
  return finalizeEvent({
    kind: 4,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["p", keys.pub]],
    content,
  }, keys.priv);
}

/** Inverse of buildRendezvousEvent; throws on wrong key, tamper, or expiry. */
export function parseRendezvousEvent(event, keys) {
  if (!event || event.pubkey !== keys.pub) throw new Error("not a rendezvous event");
  const conversationKey = nip44.v2.utils.getConversationKey(keys.priv, keys.pub);
  const payload = JSON.parse(nip44.v2.decrypt(event.content, conversationKey));
  if (!payload || typeof payload.inviteCode !== "string" || typeof payload.expires !== "number") {
    throw new Error("malformed rendezvous payload");
  }
  if (Date.now() > payload.expires) throw new Error("short code expired");
  return { inviteCode: payload.inviteCode, expires: payload.expires };
}
