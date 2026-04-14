#!/usr/bin/env node
/**
 * Phase 5-MVP live smoke: forwardBundleAction round-trip against a real peer.
 *
 * Gated on `CROW_LIVE_PEER=1` so this doesn't run in default CI.
 *
 * Prerequisites:
 *   - Peer (usually grackle) is paired via `crow instance pair`
 *   - Peer's gateway is reachable over Tailscale
 *   - crow_instances table contains a trusted=1 row for the peer
 *   - ~/.crow/peer-tokens.json has {auth_token, signing_key} for the peer
 *   - Peer has a "status" action or a no-op bundle for testing (this test
 *     uses `bundle.status` via a deliberately nonexistent bundle_id — we
 *     just want to see the signed request reach the peer and get a
 *     well-formed 404/error back, proving the control plane works).
 *
 * Usage:
 *   CROW_LIVE_PEER=1 CROW_PEER_ID=<id> node scripts/smoke/cross-host-forward-live.js
 *
 * Exits 0 if: the request was signed, sent, received by the peer, and the
 * peer returned a response that the peer's cross-host middleware validated.
 * Specifically we check that `result.status` is NOT 401 (HMAC rejection).
 * A 403 (manifest not trusted), 404 (bundle missing), or 200 (success) all
 * prove the signing/verification pipeline works end-to-end.
 */

import { createDbClient } from "../../servers/db.js";
import { forwardBundleAction } from "../../servers/shared/peer-forward.js";
import { getOrCreateLocalInstanceId } from "../../servers/gateway/instance-registry.js";

if (process.env.CROW_LIVE_PEER !== "1") {
  console.log("SKIP: CROW_LIVE_PEER=1 not set (live peer smoke disabled in CI)");
  process.exit(0);
}

const peerId = process.env.CROW_PEER_ID;
if (!peerId) {
  console.error("FAIL: CROW_PEER_ID env var required (target peer instance id)");
  process.exit(1);
}

const db = await createDbClient();
const sourceId = getOrCreateLocalInstanceId();
const bundleId = process.env.CROW_TEST_BUNDLE || "__nonexistent__";

console.log(`Source: ${sourceId}`);
console.log(`Target: ${peerId}`);
console.log(`Bundle: ${bundleId}`);

const result = await forwardBundleAction({
  db,
  sourceInstanceId: sourceId,
  targetInstanceId: peerId,
  action: "stop",
  bundleId,
  actor: "smoke",
});

console.log(`→ HTTP ${result.status}`);
console.log(`  ok=${result.ok}, error=${result.error || "-"}`);
if (result.body) console.log(`  body: ${JSON.stringify(result.body).slice(0, 200)}`);

// Accept any non-401 response as proof the signing pipeline worked. A 401
// from the peer specifically means HMAC validation failed — that IS a fail.
// Transport failures (ok=false, status=0) are also fails.
if (result.status === 401) {
  console.error("\nFAIL: peer returned 401 — HMAC validation rejected");
  process.exit(1);
}
if (result.status === 0) {
  console.error("\nFAIL: transport error before peer could respond");
  process.exit(1);
}

console.log("\nPASS: signed request reached peer and was validated (non-401 response)");
process.exit(0);
