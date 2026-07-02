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
import { getPeerCreds } from "./peer-credentials.js";

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
// Audit logging + corruption circuit-breaker
// -----------------------------------------------------------------------
//
// The `cross_host_calls` audit table has now corrupted TWICE the same way
// (2026-06-14, 2026-07-02): an unbounded high-write table whose crash-mid-
// write orphaned pages, then spammed 40k "disk image is malformed" errors
// while federation degraded SILENTLY for days. This breaker converts that
// silent-degradation failure mode into a LOUD, self-limiting one:
//
//   • Structural insert errors (malformed / not-a-database / disk image /
//     disk I/O / SQLITE_IOERR) increment a counter. Past a threshold the
//     breaker OPENS: subsequent audit inserts short-circuit (skip the
//     INSERT) so we stop feeding the corruption.
//   • On trip we fire a LOUD alert. CRITICAL: the alert must NOT depend on
//     a write to the corrupt DB — `createNotification` (notifications.js:63)
//     INSERTs to the same crow.db BEFORE it sends ntfy/email, so those loud
//     channels never fire when the DB is malformed. We therefore call the
//     DB-free push exports DIRECTLY (sendNtfyNotification / sendEmailNotif).
//   • Transient SQLITE_BUSY does NOT trip it.
//   • The alert re-arms after a ~6h cooldown so a days-long degradation
//     re-alerts instead of going silent after the first ping.
//
// Per-process singleton: assumes ONE crow.db file per process (true on this
// fleet). All flags reset on process restart (and via _resetAuditBreaker()).
// -----------------------------------------------------------------------

const AUDIT_STRUCTURAL_RE = /malformed|not a database|disk image|disk I\/O|SQLITE_IOERR/i;
const AUDIT_TRIP_THRESHOLD = 3;
const AUDIT_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h re-arm

let _auditStructuralCount = 0;
let _auditDisabled = false;
let _auditNotified = false;
let _auditNotifiedAt = 0;

// Injectable clock (test hook) so the 6h re-arm is deterministic in tests.
let _auditNow = () => Date.now();

// Overridable alert channels (test hook). Production leaves this null and
// dynamic-imports the REAL DB-free push modules — NOT notifications.js.
let _auditAlertChannels = null;

/**
 * Resolve the DB-free alert channels. Exported so a test can assert the
 * default wiring points at gateway/push/{ntfy,email}.js (NOT createNotification,
 * which writes to the corrupt DB first — the round-2 review bug this guards).
 */
export async function _loadAlertChannels() {
  if (_auditAlertChannels) return _auditAlertChannels;
  const [ntfy, email] = await Promise.all([
    import("../gateway/push/ntfy.js"),
    import("../gateway/push/email.js"),
  ]);
  return {
    sendNtfyNotification: ntfy.sendNtfyNotification,
    sendEmailNotification: email.sendEmailNotification,
  };
}

/**
 * Fire the loud corruption alert if due (one-shot with 6h re-arm). Never
 * throws — a push/email failure must never propagate into the auth path.
 */
async function fireCorruptionAlertIfDue() {
  const now = _auditNow();
  if (_auditNotified && (now - _auditNotifiedAt) < AUDIT_ALERT_COOLDOWN_MS) return;
  _auditNotified = true;
  _auditNotifiedAt = now;
  try {
    const ch = await _loadAlertChannels();
    const payload = {
      title: "Federation audit DB is corrupted",
      body: "Federation audit DB is corrupted — run `npm run recover-db`; federation still works, audit logging paused.",
      url: "/dashboard/nest",
      priority: "high", // high → the email channel actually sends
      type: "system",
    };
    // Route through BOTH DB-free channels directly (no createNotification).
    await ch.sendNtfyNotification(payload);
    await ch.sendEmailNotification(payload);
  } catch (err) {
    // A push/email failure must never break federation auth.
    console.warn(`[cross-host-auth] corruption alert failed: ${err?.message}`);
  }
}

/** True when the audit breaker is open (structural corruption detected). */
export function isAuditDegraded() {
  return _auditDisabled;
}

/** Test hook: clear counter + _auditDisabled + _notified + cooldown + clock. */
export function _resetAuditBreaker() {
  _auditStructuralCount = 0;
  _auditDisabled = false;
  _auditNotified = false;
  _auditNotifiedAt = 0;
  _auditNow = () => Date.now();
}

/** Test hook: override the alert channels (stub ntfy/email). */
export function _setAlertChannels(channels) {
  _auditAlertChannels = channels;
}

/** Test hook: override the clock used for the 6h re-arm cooldown. */
export function _setAuditClock(fn) {
  _auditNow = fn || (() => Date.now());
}

/**
 * Record a cross-host call attempt in the cross_host_calls table.
 *
 * Never throws: audit failure must not break the primary action. When the
 * corruption breaker is open, the INSERT is skipped entirely (and the alert
 * re-arms if the cooldown has elapsed).
 */
export async function auditCrossHostCall(db, record) {
  if (!db) return;

  // Breaker open — stop feeding the corruption; skip the INSERT.
  if (_auditDisabled) {
    // Re-arm the loud alert if the cooldown elapsed (days-long degradation
    // must re-alert; once disabled no inserts run so the error path can't).
    await fireCorruptionAlertIfDue();
    return;
  }

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
    // Swallow — audit must not break the primary path.
    console.warn(`[cross-host-auth] audit write failed: ${err.message}`);
    // Only STRUCTURAL corruption trips the breaker; transient SQLITE_BUSY
    // (contention) must not.
    if (AUDIT_STRUCTURAL_RE.test(err?.message || "")) {
      _auditStructuralCount++;
      if (!_auditDisabled && _auditStructuralCount >= AUDIT_TRIP_THRESHOLD) {
        _auditDisabled = true;
        await fireCorruptionAlertIfDue();
      }
    }
  }
}

// -----------------------------------------------------------------------
// Express middleware factory (W2-1) — single implementation of the
// verify-signature-or-reject logic previously duplicated inline in
// routes/bundles.js and routes/federation.js.
// -----------------------------------------------------------------------

/**
 * Express middleware that verifies an inbound cross-host signed request.
 *
 * @param {object} dbClient  libsql client used ONLY for audit writes
 * @param {object} [opts]
 * @param {boolean} [opts.optional=false]
 *   true  → requests without X-Crow-Signature pass through (next()) so
 *           existing session/OAuth auth paths apply (bundles behavior).
 *   false → requests without X-Crow-Signature get 401 {error:"signature_required"}
 *           (federation behavior — the router is HMAC-only).
 * @param {string|((req)=>string)} [opts.audit=""]  audit-log action; a constant
 *   string ("federation.overview") or a per-request function
 *   (req => `bundle.${req.path.split("/").pop() || ""}`).
 * @param {boolean} [opts.auditBundleId=false]  when true, the post-verify
 *   audit row also records bundleId (req.body?.bundle_id) and the request
 *   nonce — bundles behavior. Federation rows leave both null.
 * @param {string} [opts.emptyBodyString="{}"]  canonical serialization of an
 *   empty/absent parsed JSON body. Bundles' signers hash "{}"; federation's
 *   signers hash "" for body-less GETs. Must match the signer or HMACs of
 *   empty-body requests fail.
 *
 * Behavior preserved exactly from both inline copies: status codes, error
 * strings, audit rows, and req.crossHostAuth = verifyRequest(...) result.
 */
export function crossHostVerifyMiddleware(dbClient, {
  optional = false,
  audit = "",
  auditBundleId = false,
  emptyBodyString = "{}",
} = {}) {
  const actionFor = typeof audit === "function" ? audit : () => audit;
  return async (req, res, next) => {
    const sig = req.headers["x-crow-signature"];
    if (!sig) {
      if (optional) return next(); // not a peer call — pass through
      return res.status(401).json({ error: "signature_required" });
    }

    const source = req.headers["x-crow-source"];
    if (!source) {
      return res.status(401).json({ error: "missing_x_crow_source" });
    }

    // Load shared signing_key from peer-tokens.json
    const creds = getPeerCreds(source);
    if (!creds || !creds.signing_key) {
      await auditCrossHostCall(dbClient, {
        sourceInstanceId: source,
        direction: "inbound",
        action: actionFor(req),
        error: "no_signing_key_for_source",
      });
      return res.status(401).json({ error: "unknown_peer" });
    }

    // Canonical body must match what the signer used. express.json() sets
    // req.body to {} for GETs with no body; emptyBodyString controls whether
    // that canonicalizes to "{}" (bundles) or "" (federation).
    const isEmptyObj = req.body && typeof req.body === "object"
      && !Array.isArray(req.body) && Object.keys(req.body).length === 0;
    const rawBody = typeof req.body === "string"
      ? req.body
      : (isEmptyObj || !req.body ? emptyBodyString : JSON.stringify(req.body));

    const result = verifyRequest({
      method: req.method,
      path: req.originalUrl || req.url,
      body: rawBody,
      headers: Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v])
      ),
      signingKey: creds.signing_key,
    });

    req.crossHostAuth = result;

    // Audit the validation attempt regardless of outcome. Handler path may
    // still fail (e.g. bundle missing) but the HMAC-validity fact is what
    // matters for the security log.
    await auditCrossHostCall(dbClient, {
      sourceInstanceId: source,
      direction: "inbound",
      action: actionFor(req),
      ...(auditBundleId ? { bundleId: req.body?.bundle_id, nonce: result.nonce } : {}),
      hmacValid: result.valid,
      timestampSkewMs: result.timestampSkewMs,
      error: result.valid ? null : result.reason,
    });

    if (!result.valid) {
      return res.status(401).json({ error: result.reason });
    }

    return next();
  };
}
