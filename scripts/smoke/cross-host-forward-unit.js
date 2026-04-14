#!/usr/bin/env node
/**
 * Phase 5-MVP unit smoke: HMAC signing + verification + replay + skew.
 *
 * Runs entirely in-process — no network, no peer. Verifies:
 *   - signRequest() produces the expected signature shape
 *   - verifyRequest() accepts a valid signed request
 *   - verifyRequest() rejects HMAC mismatch
 *   - verifyRequest() rejects nonce replay
 *   - verifyRequest() rejects timestamp skew
 *   - verifyRequest() rejects missing source/signing_key
 *
 * Usage: node scripts/smoke/cross-host-forward-unit.js
 */

import {
  signRequest,
  verifyRequest,
  _resetNonceCache,
} from "../../servers/shared/cross-host-auth.js";
import { randomBytes } from "crypto";

let failed = 0;
function t(name, ok, detail) {
  if (ok) {
    console.log(`  PASS  ${name}`);
  } else {
    console.error(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
    failed++;
  }
}

const signingKey = randomBytes(32).toString("hex");
const otherKey = randomBytes(32).toString("hex");
const authToken = randomBytes(32).toString("hex");
const sourceId = "source-abc";
const method = "POST";
const path = "/bundles/api/start";
const body = JSON.stringify({ bundle_id: "demo" });

// --- 1. Round-trip OK ---
_resetNonceCache();
{
  const h = signRequest({ method, path, body, authToken, signingKey, sourceInstanceId: sourceId });
  t("signRequest emits signature", !!h["X-Crow-Signature"] && h["X-Crow-Signature"].length === 64);
  t("signRequest emits Authorization", h.Authorization === `Bearer ${authToken}`);
  t("signRequest emits timestamp + nonce + source", !!h["X-Crow-Timestamp"] && !!h["X-Crow-Nonce"] && h["X-Crow-Source"] === sourceId);

  const headers = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
  const result = verifyRequest({ method, path, body, headers, signingKey });
  t("verifyRequest accepts valid signed request", result.valid, result.reason);
  t("verifyRequest returns sourceInstanceId", result.sourceInstanceId === sourceId);
}

// --- 2. HMAC mismatch ---
_resetNonceCache();
{
  const h = signRequest({ method, path, body, authToken, signingKey, sourceInstanceId: sourceId });
  const headers = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
  const result = verifyRequest({ method, path, body, headers, signingKey: otherKey });
  t("verifyRequest rejects HMAC mismatch", !result.valid && result.reason === "hmac_mismatch");
}

// --- 3. Nonce replay ---
_resetNonceCache();
{
  const h = signRequest({ method, path, body, authToken, signingKey, sourceInstanceId: sourceId });
  const headers = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
  const first = verifyRequest({ method, path, body, headers, signingKey });
  const second = verifyRequest({ method, path, body, headers, signingKey });
  t("first verify passes", first.valid);
  t("second verify (replay) rejected", !second.valid && second.reason === "nonce_replay");
}

// --- 4. Timestamp skew ---
_resetNonceCache();
{
  const h = signRequest({ method, path, body, authToken, signingKey, sourceInstanceId: sourceId });
  // Force timestamp into the past
  h["X-Crow-Timestamp"] = String(Date.now() - 120_000);
  const headers = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
  const result = verifyRequest({ method, path, body, headers, signingKey });
  t("verifyRequest rejects stale timestamp", !result.valid && result.reason === "timestamp_skew");
}

// --- 5. Missing source header ---
_resetNonceCache();
{
  const h = signRequest({ method, path, body, authToken, signingKey, sourceInstanceId: sourceId });
  const headers = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
  delete headers["x-crow-source"];
  const result = verifyRequest({ method, path, body, headers, signingKey });
  t("verifyRequest rejects missing source header", !result.valid && result.reason === "missing_signature_headers");
}

// --- 6. Body tamper ---
_resetNonceCache();
{
  const h = signRequest({ method, path, body, authToken, signingKey, sourceInstanceId: sourceId });
  const headers = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
  const tampered = JSON.stringify({ bundle_id: "demo", extra: "mwahaha" });
  const result = verifyRequest({ method, path, body: tampered, headers, signingKey });
  t("verifyRequest rejects body tamper", !result.valid && result.reason === "hmac_mismatch");
}

if (failed) {
  console.error(`\nFAIL: ${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nPASS: all assertions passed");
process.exit(0);
