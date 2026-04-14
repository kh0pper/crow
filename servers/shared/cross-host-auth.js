/**
 * Cross-host RPC authentication: HMAC signing, nonce cache, replay guard,
 * audit logging.
 *
 * Signing canonical form (identical on both sides):
 *
 *   signature = HMAC-SHA256(
 *     method + "\n" + path + "\n" + timestamp + "\n" + nonce + "\n" + sha256(body-bytes),
 *     signing_key
 *   )
 *
 * Headers on the wire:
 *
 *   Authorization:       Bearer <auth_token>
 *   X-Crow-Signature:    <64-char hex HMAC>
 *   X-Crow-Timestamp:    <unix-millis, as string>
 *   X-Crow-Nonce:        <32-char hex>
 *   X-Crow-Source:       <source instance id>   // so the receiver knows which peer creds to use
 *
 * Verification:
 *   1. Timestamp must be within ±60s of peer's clock (default skew window).
 *   2. HMAC must match.
 *   3. (source_instance_id, nonce) pair must not appear in the 120s LRU cache.
 *
 * Audit:
 *   Every verification attempt (success or failure) is written to
 *   `cross_host_calls`. The orchestrator lifecycle and the Crow's Nest
 *   admin panel both query this table.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";

const DEFAULT_SKEW_MS = 60_000;  // ±60s
const NONCE_TTL_MS = 120_000;    // entries evicted after 120s
const NONCE_CACHE_MAX = 10_000;  // cap on entries

// -----------------------------------------------------------------------
// Nonce cache (in-process LRU-ish, but really a TTL map since cross-host
// RPC volume is low). Keyed by `${source}:${nonce}` → expiresAt.
// -----------------------------------------------------------------------

const nonceCache = new Map();

function pruneNonceCache() {
  const now = Date.now();
  for (const [key, expiresAt] of nonceCache) {
    if (expiresAt <= now) nonceCache.delete(key);
  }
  // Cap the size as a safety net
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

// Periodic cleanup to bound the map
setInterval(pruneNonceCache, 30_000).unref?.();

/**
 * Test-only: reset nonce cache (used by smoke tests).
 */
export function _resetNonceCache() {
  nonceCache.clear();
}

// -----------------------------------------------------------------------
// Canonical signing form
// -----------------------------------------------------------------------

function canonicalString({ method, path, timestamp, nonce, body }) {
  const bodyHash = createHash("sha256").update(body || "").digest("hex");
  return [
    String(method).toUpperCase(),
    String(path),
    String(timestamp),
    String(nonce),
    bodyHash,
  ].join("\n");
}

/**
 * Generate the headers for an outbound request.
 *
 * @param {object} args
 * @param {string} args.method          - HTTP method
 * @param {string} args.path            - Request path (no origin)
 * @param {string|Buffer} [args.body]   - Serialized request body (empty string if none)
 * @param {string} args.authToken       - Plaintext bearer token (this node -> peer)
 * @param {string} args.signingKey      - Plaintext HMAC key (hex)
 * @param {string} args.sourceInstanceId - This node's instance id
 * @returns {Record<string,string>} headers to merge into the outbound fetch
 */
export function signRequest({ method, path, body, authToken, signingKey, sourceInstanceId }) {
  if (!authToken || !signingKey || !sourceInstanceId) {
    throw new Error("signRequest requires authToken, signingKey, sourceInstanceId");
  }
  const timestamp = Date.now().toString();
  const nonce = randomBytes(16).toString("hex");
  const msg = canonicalString({ method, path, timestamp, nonce, body });
  const signature = createHmac("sha256", Buffer.from(signingKey, "hex"))
    .update(msg)
    .digest("hex");

  return {
    Authorization: `Bearer ${authToken}`,
    "X-Crow-Signature": signature,
    "X-Crow-Timestamp": timestamp,
    "X-Crow-Nonce": nonce,
    "X-Crow-Source": sourceInstanceId,
  };
}

// -----------------------------------------------------------------------
// Inbound verification
// -----------------------------------------------------------------------

function safeEqHex(aHex, bHex) {
  if (!aHex || !bHex || aHex.length !== bHex.length) return false;
  try {
    return timingSafeEqual(Buffer.from(aHex, "hex"), Buffer.from(bHex, "hex"));
  } catch {
    return false;
  }
}

/**
 * Verify an inbound signed request.
 *
 * @param {object} args
 * @param {string} args.method          - Request method
 * @param {string} args.path            - Request path (no origin)
 * @param {string|Buffer} args.body     - Raw body
 * @param {object} args.headers         - Lowercased header map
 * @param {string} args.signingKey      - Expected signing key for this peer (hex)
 * @param {number} [args.skewMs]        - Allowed clock skew, default 60s
 * @returns {{valid: boolean, reason?: string, sourceInstanceId?: string,
 *            timestamp?: number, nonce?: string, timestampSkewMs?: number}}
 */
export function verifyRequest({ method, path, body, headers, signingKey, skewMs = DEFAULT_SKEW_MS }) {
  const sig = headers["x-crow-signature"];
  const ts = headers["x-crow-timestamp"];
  const nonce = headers["x-crow-nonce"];
  const source = headers["x-crow-source"];

  if (!sig || !ts || !nonce || !source) {
    return { valid: false, reason: "missing_signature_headers" };
  }
  if (!signingKey) {
    return { valid: false, reason: "no_signing_key_for_source", sourceInstanceId: source };
  }

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) {
    return { valid: false, reason: "bad_timestamp", sourceInstanceId: source, nonce };
  }

  const skew = Date.now() - tsNum;
  const absSkew = Math.abs(skew);
  if (absSkew > skewMs) {
    return {
      valid: false,
      reason: "timestamp_skew",
      sourceInstanceId: source,
      timestamp: tsNum,
      nonce,
      timestampSkewMs: skew,
    };
  }

  // Replay check
  const nonceKey = `${source}:${nonce}`;
  pruneNonceCache();
  if (nonceCache.has(nonceKey)) {
    return {
      valid: false,
      reason: "nonce_replay",
      sourceInstanceId: source,
      timestamp: tsNum,
      nonce,
      timestampSkewMs: skew,
    };
  }

  // Verify HMAC
  const expected = createHmac("sha256", Buffer.from(signingKey, "hex"))
    .update(canonicalString({ method, path, timestamp: ts, nonce, body }))
    .digest("hex");

  if (!safeEqHex(expected, sig)) {
    return {
      valid: false,
      reason: "hmac_mismatch",
      sourceInstanceId: source,
      timestamp: tsNum,
      nonce,
      timestampSkewMs: skew,
    };
  }

  // Store nonce (120s TTL)
  nonceCache.set(nonceKey, Date.now() + NONCE_TTL_MS);

  return {
    valid: true,
    sourceInstanceId: source,
    timestamp: tsNum,
    nonce,
    timestampSkewMs: skew,
  };
}

// -----------------------------------------------------------------------
// Audit logging
// -----------------------------------------------------------------------

/**
 * Record a cross-host call attempt in the cross_host_calls table.
 *
 * Never throws: audit failure must not break the primary action.
 */
export async function auditCrossHostCall(db, record) {
  if (!db) return;
  try {
    await db.execute({
      sql: `INSERT INTO cross_host_calls
            (source_instance_id, target_instance_id, direction, action, bundle_id,
             actor, http_status, hmac_valid, timestamp_skew_ms, nonce, error, request_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        record.sourceInstanceId || null,
        record.targetInstanceId || null,
        record.direction,
        record.action,
        record.bundleId || null,
        record.actor || null,
        record.httpStatus ?? null,
        record.hmacValid === undefined ? null : (record.hmacValid ? 1 : 0),
        record.timestampSkewMs ?? null,
        record.nonce || null,
        record.error || null,
        record.requestId || null,
      ],
    });
  } catch (err) {
    // Swallow — audit must not break the primary path
    console.warn(`[cross-host-auth] audit write failed: ${err.message}`);
  }
}
