/**
 * crow → satellite transport (SAT-1, spec §5.1, §5.2). Every management request is signed with the
 * satellite's mgmt key; every answer must be complete JSON carrying X-Crow-Sat-Resp-Sig, the
 * satellite key's signature over the request nonce, the status and sha256(body).
 *
 * Why not models/safe-upstream.js: `readJson` hands back only the parsed value, and the response
 * signature is over the raw body bytes, so the bytes are needed before any parse; and the target
 * is the owner-chosen tailnet host over Serve :443 (a CGNAT address that the "cloud" mode refuses
 * by design). Calls go through an injectable `fetchImpl` with `redirect: "manual"` (a 3xx is a
 * protocol error), a timeout, and a byte cap enforced while reading.
 *
 * Errors carry err.code: "unreachable" | "bad_response_sig" | "protocol" | "no_mgmt_key".
 */
import { signRequest, verifyResponse, sha256Hex, isValidCaller } from "../../shared/satellite-protocol.js";
import { loadMgmtKey } from "./mgmt-keys.js";

export const DEFAULT_MAX_BYTES = 64 * 1024;
export const DEFAULT_TIMEOUT_MS = 15000;

export const satFail = (code, message = code, extra = {}) => Object.assign(new Error(message), { code, ...extra });

export const satelliteBaseUrl = (host) => `https://${host}`;

/** The full body as a Buffer, refusing more than `maxBytes` (declared or streamed). */
export async function readCapped(res, maxBytes) {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await res.body?.cancel(); } catch { /* gone */ }
    throw satFail("protocol", "response body too large");
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      try { await reader.cancel(); } catch { /* gone */ }
      throw satFail("protocol", "response body too large");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** application/json only; an event stream (or anything else) is a protocol error. */
export function assertJsonResponse(res) {
  if (res.status >= 300 && res.status < 400) throw satFail("protocol", "redirect refused");
  const ct = String(res.headers.get("content-type") || "").toLowerCase().split(";")[0].trim();
  if (ct !== "application/json") throw satFail("protocol", `refused content type ${ct || "(none)"}`);
}

/** One fetch with timeout and no redirect following; a transport failure is "unreachable". */
export async function sendOnce(fetchImpl, url, { method, headers, body, timeoutMs }) {
  try {
    return await fetchImpl(url, {
      method, headers, body: body === "" && (method === "GET" || method === "HEAD") ? undefined : body,
      redirect: "manual", signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw satFail("unreachable", "satellite unreachable", { cause: err });
  }
}

/**
 * A signed request to a paired satellite (`sat` is its `satellites` row).
 * Resolves `{status, json}`; throws {code} as described above.
 */
export async function satelliteFetch(sat, {
  method = "GET", path, body, caller, maxBytes = DEFAULT_MAX_BYTES, timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch, env = process.env, mgmtKey,
} = {}) {
  const m = String(method).toUpperCase();
  if (typeof path !== "string" || !path.startsWith("/satellite/v1/")) throw satFail("protocol", "bad satellite path");
  if (!isValidCaller(caller)) throw satFail("protocol", "bad caller");
  const key = mgmtKey || loadMgmtKey(sat.id, { env });
  if (!key) throw satFail("no_mgmt_key", "no management key for this satellite");
  const text = body === undefined || body === null ? "" : typeof body === "string" ? body : JSON.stringify(body);
  let sigHeaders;
  try {
    sigHeaders = signRequest(key.ed25519_priv, { method: m, pathQuery: path, body: text, satelliteId: sat.id, caller });
  } catch (err) {
    throw satFail("protocol", "request could not be signed", { cause: err });
  }
  const headers = { Accept: "application/json", ...sigHeaders };
  if (text) headers["Content-Type"] = "application/json";
  const res = await sendOnce(fetchImpl, satelliteBaseUrl(sat.tailnet_host) + path, { method: m, headers, body: text, timeoutMs });
  assertJsonResponse(res);
  const raw = await readCapped(res, maxBytes);
  const sig = res.headers.get("x-crow-sat-resp-sig");
  const ok = typeof sig === "string" && verifyResponse(sat.satellite_pubkey, {
    requestNonce: sigHeaders["X-Crow-Sat-Nonce"], status: res.status, bodySha256: sha256Hex(raw),
  }, sig);
  if (!ok) throw satFail("bad_response_sig", "satellite response signature did not verify");
  let json;
  try { json = JSON.parse(raw.toString("utf8")); } catch { throw satFail("protocol", "response is not JSON"); }
  return { status: res.status, json };
}
