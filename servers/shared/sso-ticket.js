/**
 * Cross-instance SSO ticket: sign / verify / dest-path validation.
 *
 * An SSO ticket lets an authenticated session on instance A authorize a
 * passwordless login on a paired+trusted instance B. A signs a short-lived,
 * single-use ticket with the A<->B shared HMAC `signing_key`; B verifies it
 * and mints its own local session.
 *
 * Security properties:
 *   - **Domain separation from RPC.** Tickets are signed with a *derived*
 *     sub-key `HMAC-SHA256(signing_key, "crow-sso-v1")`, never the raw
 *     signing_key used by cross-host RPC (servers/shared/cross-host-auth.js).
 *     The signed message is also prefixed with the literal "crow-sso-v1\n",
 *     whose first line can never collide with the RPC canonical form (which
 *     always begins with an HTTP method). Either guard alone suffices; both
 *     are present so a captured RPC signature can never be coerced into a
 *     valid ticket, or vice-versa.
 *   - **Single-use.** The (src, nonce) pair is consumed *synchronously inside*
 *     verifyTicket before it returns valid — no await between the check and
 *     the set — so two concurrent replays cannot both win.
 *   - **Bounded freshness.** iat/exp are checked against the verifier's clock
 *     with a +/-skew window (cross-machine NTP drift) plus a max-TTL clamp
 *     that bounds a buggy/malicious key-holding signer.
 *   - **Open-redirect safe.** The destination path is validated on both ends.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const SSO_DOMAIN = "crow-sso-v1";
const DEFAULT_TTL_MS = 60_000;       // ticket lifetime set by the signer
const DEFAULT_SKEW_MS = 60_000;      // +/-clock-skew tolerance on the verifier (matches RPC)
const DEFAULT_MAX_TTL_MS = 120_000;  // hard clamp on (exp - iat) the verifier accepts
const NONCE_TTL_MS = DEFAULT_MAX_TTL_MS + DEFAULT_SKEW_MS; // keep a consumed nonce at least this long
const NONCE_CACHE_MAX = 10_000;

// -----------------------------------------------------------------------
// Single-use nonce cache. Own instance — never share with cross-host-auth's
// RPC nonce cache (different replay namespace + consume-on-verify semantics).
// Keyed `${src}:${nonce}` -> expiresAt.
// -----------------------------------------------------------------------
const nonceCache = new Map();

function pruneNonceCache(now = Date.now()) {
  for (const [key, expiresAt] of nonceCache) {
    if (expiresAt <= now) nonceCache.delete(key);
  }
  if (nonceCache.size > NONCE_CACHE_MAX) {
    const overflow = nonceCache.size - NONCE_CACHE_MAX;
    let i = 0;
    for (const key of nonceCache.keys()) {
      if (i >= overflow) break;
      nonceCache.delete(key);
      i++;
    }
  }
}

setInterval(() => pruneNonceCache(), 30_000).unref?.();

/** Test-only: clear the nonce cache between cases. */
export function _resetSsoNonceCache() {
  nonceCache.clear();
}

// -----------------------------------------------------------------------
// Key derivation + signing
// -----------------------------------------------------------------------

/**
 * Derive the SSO signing sub-key from the shared peer signing_key (hex).
 * @param {string} signingKeyHex
 * @returns {Buffer} 32-byte sub-key
 */
export function deriveSsoKey(signingKeyHex) {
  return createHmac("sha256", Buffer.from(signingKeyHex, "hex")).update(SSO_DOMAIN).digest();
}

function b64urlEncode(str) {
  return Buffer.from(str, "utf8").toString("base64url");
}

function b64urlDecode(b64) {
  return Buffer.from(b64, "base64url").toString("utf8");
}

/** Signed message = domain literal + the exact payload bytes the verifier receives. */
function signedMessage(payloadB64) {
  return `${SSO_DOMAIN}\n${payloadB64}`;
}

function safeEqHex(aHex, bHex) {
  if (!aHex || !bHex || aHex.length !== bHex.length) return false;
  try {
    return timingSafeEqual(Buffer.from(aHex, "hex"), Buffer.from(bHex, "hex"));
  } catch {
    return false;
  }
}

/**
 * Sign an SSO ticket.
 *
 * @param {object} args
 * @param {string} args.src         Source (issuing) instance id
 * @param {string} args.dst         Destination (target) instance id
 * @param {string} args.dest        Local destination path on the target (e.g. "/dashboard/nest")
 * @param {string} args.signingKey  Shared HMAC signing_key (hex) for the src<->dst pair
 * @param {number} [args.ttlMs]     Ticket lifetime in ms (default 60s)
 * @param {number} [args.now]       Override clock (tests)
 * @returns {{payloadB64: string, sig: string}}
 */
export function signTicket({ src, dst, dest, signingKey, ttlMs = DEFAULT_TTL_MS, now = Date.now() }) {
  if (!src || !dst || !dest || !signingKey) {
    throw new Error("signTicket requires src, dst, dest, signingKey");
  }
  if (!isSafeDestPath(dest)) {
    throw new Error("signTicket: unsafe dest path");
  }
  const payload = {
    v: 1,
    src: String(src),
    dst: String(dst),
    dest: String(dest),
    iat: now,
    exp: now + ttlMs,
    nonce: randomBytes(16).toString("hex"),
  };
  const payloadB64 = b64urlEncode(JSON.stringify(payload));
  const sig = createHmac("sha256", deriveSsoKey(signingKey)).update(signedMessage(payloadB64)).digest("hex");
  return { payloadB64, sig };
}

/**
 * Verify an SSO ticket. On success, the nonce is consumed (single-use).
 *
 * @param {object} args
 * @param {string} args.payloadB64
 * @param {string} args.sig
 * @param {string} args.signingKey  Shared signing_key (hex) for the claimed source peer
 * @param {string} [args.expectedDst] If set, ticket.dst must equal it
 * @param {number} [args.now]
 * @param {number} [args.nowSkewMs]
 * @param {number} [args.maxTtlMs]
 * @returns {{valid: boolean, reason?: string, ticket?: object}}
 */
export function verifyTicket({
  payloadB64,
  sig,
  signingKey,
  expectedDst,
  now = Date.now(),
  nowSkewMs = DEFAULT_SKEW_MS,
  maxTtlMs = DEFAULT_MAX_TTL_MS,
}) {
  if (!payloadB64 || !sig || !signingKey) return { valid: false, reason: "missing_fields" };

  // Signature first — over the exact bytes received, with the derived sub-key.
  const expected = createHmac("sha256", deriveSsoKey(signingKey)).update(signedMessage(payloadB64)).digest("hex");
  if (!safeEqHex(expected, sig)) return { valid: false, reason: "hmac_mismatch" };

  let payload;
  try {
    payload = JSON.parse(b64urlDecode(payloadB64));
  } catch {
    return { valid: false, reason: "bad_payload" };
  }
  const { src, dst, dest, iat, exp, nonce } = payload || {};
  if (!src || !dst || !dest || !nonce || typeof iat !== "number" || typeof exp !== "number") {
    return { valid: false, reason: "bad_payload" };
  }
  if (expectedDst && dst !== expectedDst) return { valid: false, reason: "dst_mismatch" };
  if (!isSafeDestPath(dest)) return { valid: false, reason: "bad_dest" };
  if (iat > now + nowSkewMs) return { valid: false, reason: "future_ticket" };
  if (now > exp + nowSkewMs) return { valid: false, reason: "expired" };
  if (exp - iat > maxTtlMs) return { valid: false, reason: "ttl_too_long" };

  // Replay guard — check-and-set synchronously (no await before set).
  const key = `${src}:${nonce}`;
  pruneNonceCache(now);
  if (nonceCache.has(key)) return { valid: false, reason: "nonce_replay" };
  nonceCache.set(key, now + NONCE_TTL_MS);

  return { valid: true, ticket: payload };
}

// -----------------------------------------------------------------------
// Destination path validation (open-redirect guard)
// -----------------------------------------------------------------------

/**
 * True only for a safe, local, relative path (no host, no scheme, no
 * traversal). Used on both the signer (defense) and verifier (authority).
 *
 * @param {string} dest
 * @returns {boolean}
 */
export function isSafeDestPath(dest) {
  if (typeof dest !== "string" || dest.length === 0 || dest.length > 512) return false;
  if (!dest.startsWith("/")) return false;          // must be absolute-path-relative
  if (dest.startsWith("//")) return false;          // protocol-relative -> absolute URL
  if (dest.includes("\\")) return false;            // browsers normalize backslash -> slash
  if (dest.includes("..")) return false;            // path traversal (raw)
  if (/%2e/i.test(dest)) return false;              // encoded dot (defense in depth)
  // Charclass gate: rejects ':', '%', '?', '#', whitespace, and all control
  // bytes (incl CR/LF) in one shot — only safe path characters survive.
  if (!/^\/[A-Za-z0-9_\-./]+$/.test(dest)) return false;
  // Reassert via URL parser: must stay same-origin and be path-only.
  try {
    const u = new URL(dest, "http://x");
    if (u.origin !== "http://x") return false;
    if (u.pathname !== dest) return false; // rejects any query/hash that slipped through
  } catch {
    return false;
  }
  return true;
}
