/**
 * Forwarder for cross-host bundle RPC.
 *
 * Given a target instance ID, resolves its gateway URL from the instance
 * registry, loads peer credentials from ~/.crow/peer-tokens.json, signs
 * the request, and fires it. Returns the response JSON + metadata.
 *
 * Trust boundary:
 *   1. Target must be registered in crow_instances.
 *   2. crow_instances.trusted must equal 1.
 *   3. peer-tokens.json must contain creds for the target.
 *   Any failure → structured error, caller decides whether to surface.
 *
 * Manifest trust boundary (for `host: <instance-id>` in bundle manifests)
 * is enforced by the caller (routes/bundles.js), not here — this module
 * is purely the transport layer.
 */

import { getInstance } from "../gateway/instance-registry.js";
import { getPeerCreds } from "./peer-credentials.js";
import { signRequest, auditCrossHostCall } from "./cross-host-auth.js";

/**
 * Forward a bundle action (start/stop/status) to a remote peer.
 *
 * @param {object} args
 * @param {object} args.db                  - libsql client
 * @param {string} args.sourceInstanceId    - This node's instance id
 * @param {string} args.targetInstanceId    - Target peer instance id
 * @param {string} args.action              - "start" | "stop" | "status"
 * @param {string} args.bundleId            - Bundle id to operate on
 * @param {string} [args.actor]             - Who requested this (for audit)
 * @param {number} [args.timeoutMs]         - Default 30s
 * @returns {Promise<{ok: boolean, status: number, body?: object, error?: string}>}
 */
export async function forwardBundleAction({
  db,
  sourceInstanceId,
  targetInstanceId,
  action,
  bundleId,
  actor,
  timeoutMs = 30_000,
}) {
  const audit = {
    sourceInstanceId,
    targetInstanceId,
    direction: "outbound",
    action: `bundle.${action}`,
    bundleId,
    actor,
  };

  // 1. Resolve target instance
  const instance = await getInstance(db, targetInstanceId);
  if (!instance) {
    const error = "target_not_registered";
    await auditCrossHostCall(db, { ...audit, error });
    return { ok: false, status: 0, error };
  }
  if (instance.trusted !== 1) {
    const error = "target_not_trusted";
    await auditCrossHostCall(db, { ...audit, error });
    return { ok: false, status: 0, error };
  }
  if (!instance.gateway_url) {
    const error = "target_has_no_gateway_url";
    await auditCrossHostCall(db, { ...audit, error });
    return { ok: false, status: 0, error };
  }

  // 2. Resolve credentials
  const creds = getPeerCreds(targetInstanceId);
  if (!creds || !creds.auth_token || !creds.signing_key) {
    const error = "missing_peer_credentials";
    await auditCrossHostCall(db, { ...audit, error });
    return { ok: false, status: 0, error };
  }

  // 3. Build + sign request
  const path = `/bundles/api/${action}`;
  const url = String(instance.gateway_url).replace(/\/+$/, "") + path;
  const bodyObj = { bundle_id: bundleId };
  const body = JSON.stringify(bodyObj);

  const headers = {
    "Content-Type": "application/json",
    ...signRequest({
      method: "POST",
      path,
      body,
      authToken: creds.auth_token,
      signingKey: creds.signing_key,
      sourceInstanceId,
    }),
  };

  // 4. Fire
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const error = err.name === "TimeoutError" ? "timeout" : String(err.message || err);
    await auditCrossHostCall(db, { ...audit, error });
    return { ok: false, status: 0, error };
  }

  let parsedBody = null;
  try {
    parsedBody = await res.json();
  } catch {
    // Non-JSON response
  }

  await auditCrossHostCall(db, {
    ...audit,
    httpStatus: res.status,
    error: res.ok ? null : (parsedBody?.error || `http_${res.status}`),
  });

  return {
    ok: res.ok,
    status: res.status,
    body: parsedBody,
    error: res.ok ? undefined : (parsedBody?.error || `http_${res.status}`),
  };
}
