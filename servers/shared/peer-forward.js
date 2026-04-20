/**
 * Forwarder for cross-host RPC.
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
 *
 * Two exports:
 *   - forwardSignedRequest({...})  — general helper (any method + path)
 *   - forwardBundleAction({...})   — thin wrapper preserved for backward
 *                                     compat with existing bundle callers
 */

import { getInstance } from "../gateway/instance-registry.js";
import { getPeerCreds } from "./peer-credentials.js";
import { signRequest, auditCrossHostCall } from "./cross-host-auth.js";

/**
 * Read an HTTP response body with a hard byte-count cap, aborting when
 * exceeded. Used by federation fetches to defend against payload bombs
 * from a compromised peer. Returns the decoded text OR `null` if the
 * body exceeded the cap (cap-exceeded is surfaced as an error upstream).
 */
async function readBodyWithCap(res, maxBytes) {
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      try { await reader.cancel(); } catch {}
      return null; // Caller sees this as response_too_large
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) { buf.set(c, offset); offset += c.byteLength; }
  return new TextDecoder("utf-8").decode(buf);
}

/**
 * General cross-host signed-request helper. Handles trust gate, credentials,
 * request signing, fetch, response-size cap, and audit logging.
 *
 * @param {object} args
 * @param {object} args.db                 - libsql client (for audit writes)
 * @param {string} args.sourceInstanceId   - This node's instance id
 * @param {string} args.targetInstanceId   - Target peer instance id
 * @param {"GET"|"POST"|"PUT"|"DELETE"|"PATCH"} args.method
 * @param {string} args.path               - Path on the target (e.g. "/dashboard/overview")
 * @param {object} [args.query]            - Optional query params (object → URLSearchParams)
 * @param {object|string} [args.body]      - Optional request body. Objects are JSON-encoded.
 * @param {string}  args.auditAction       - Structured action name for cross_host_calls.action
 *                                           (e.g. "federation.overview", "bundle.start")
 * @param {string} [args.actor]            - Who requested this (for audit)
 * @param {number} [args.timeoutMs]        - Default 30_000
 * @param {number} [args.maxResponseBytes] - Default 1_048_576 (1 MB). Federation should pass 65_536.
 * @param {object} [args.auditMeta]        - Extra fields to merge into the audit row (e.g. { bundleId })
 * @returns {Promise<{ok: boolean, status: number, body?: any, raw?: string, error?: string}>}
 */
export async function forwardSignedRequest({
  db,
  sourceInstanceId,
  targetInstanceId,
  method,
  path,
  query,
  body,
  auditAction,
  actor,
  timeoutMs = 30_000,
  maxResponseBytes = 1_048_576,
  auditMeta = {},
}) {
  const audit = {
    sourceInstanceId,
    targetInstanceId,
    direction: "outbound",
    action: auditAction,
    actor,
    ...auditMeta,
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

  // 3. Build path + query, signed body, URL
  let queryStr = "";
  if (query && typeof query === "object") {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      sp.append(k, String(v));
    }
    const s = sp.toString();
    if (s) queryStr = `?${s}`;
  }
  const signedPath = `${path}${queryStr}`; // signature covers path+query so peer can verify

  let requestBody = null;
  const headers = { };
  if (body !== undefined && body !== null) {
    if (typeof body === "string") {
      requestBody = body;
    } else {
      requestBody = JSON.stringify(body);
      headers["Content-Type"] = "application/json";
    }
  }

  Object.assign(headers, signRequest({
    method,
    path: signedPath,
    body: requestBody || "",
    authToken: creds.auth_token,
    signingKey: creds.signing_key,
    sourceInstanceId,
  }));

  const url = String(instance.gateway_url).replace(/\/+$/, "") + signedPath;

  // 4. Fire + size-capped read
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: requestBody || undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const error = err.name === "TimeoutError" ? "timeout" : String(err.message || err);
    await auditCrossHostCall(db, { ...audit, error });
    return { ok: false, status: 0, error };
  }

  const raw = await readBodyWithCap(res, maxResponseBytes);
  if (raw === null) {
    const error = "response_too_large";
    await auditCrossHostCall(db, { ...audit, httpStatus: res.status, error });
    return { ok: false, status: res.status, error };
  }

  let parsedBody = null;
  const ctype = res.headers.get("content-type") || "";
  if (ctype.includes("application/json")) {
    try { parsedBody = raw ? JSON.parse(raw) : null; } catch { /* non-JSON */ }
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
    raw,
    error: res.ok ? undefined : (parsedBody?.error || `http_${res.status}`),
  };
}

/**
 * Backward-compat wrapper: forward a bundle action (start/stop/status) to a
 * remote peer. Preserves the exact audit payload shape the pre-extraction
 * code emitted (`action: "bundle.<x>"`, `bundleId` field).
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
  // Bundle routes are mounted under /dashboard/bundles/api/* per
  // servers/gateway/dashboard/index.js. Same path on both sides.
  return forwardSignedRequest({
    db,
    sourceInstanceId,
    targetInstanceId,
    method: "POST",
    path: `/dashboard/bundles/api/${action}`,
    body: { bundle_id: bundleId },
    auditAction: `bundle.${action}`,
    actor,
    timeoutMs,
    auditMeta: { bundleId },
  });
}
