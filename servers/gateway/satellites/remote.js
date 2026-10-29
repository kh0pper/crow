/**
 * Small signed calls crow makes to a paired satellite outside the request/response routes
 * (SAT-5): the unsigned /health clock read (spec §11.1) and a signed tools/list (§9.1).
 */
import { RESULT_CAP_BYTES } from "../../shared/satellite-protocol.js";
import { satelliteFetch, satelliteBaseUrl, satFail, readCapped } from "./client.js";

const BUNDLE_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * GET /health (unsigned): {protocol, time, skew_ms} where skew_ms = satellite time − crow time
 * at the midpoint of the call; null on any failure. Never trusted for anything but display.
 */
export async function readHealth(sat, { fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 10000 } = {}) {
  const t0 = now();
  try {
    const res = await fetchImpl(`${satelliteBaseUrl(sat.tailnet_host)}/health`, {
      method: "GET", headers: { Accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status !== 200) return null;
    const j = JSON.parse((await readCapped(res, 4096)).toString("utf8"));
    const t1 = now();
    const ts = Date.parse(j?.time);
    if (!Number.isFinite(ts)) return null;
    return { protocol: Number.isInteger(j.protocol) ? j.protocol : null, time: new Date(ts).toISOString(), skew_ms: Math.round(ts - (t0 + t1) / 2) };
  } catch {
    return null;
  }
}

let rpcSeq = 1;

/** Signed tools/list over POST mcp/<bundle> → the `tools` array; throws satFail codes. */
export async function fetchToolList(sat, bundle, { fetchImpl, env, caller = "owner-local", timeoutMs } = {}) {
  if (!BUNDLE_RE.test(String(bundle))) throw satFail("protocol", "bad bundle id");
  const id = rpcSeq++;
  const r = await satelliteFetch(sat, {
    method: "POST", path: `/satellite/v1/mcp/${bundle}`, body: { jsonrpc: "2.0", id, method: "tools/list", params: {} },
    caller, maxBytes: RESULT_CAP_BYTES + 4096, fetchImpl, env, ...(timeoutMs ? { timeoutMs } : {}),
  });
  if (r.status !== 200) throw satFail("refused", typeof r.json?.error === "string" ? r.json.error : `status ${r.status}`, { status: r.status });
  const tools = r.json?.result?.tools;
  if (!Array.isArray(tools)) {
    throw satFail("refused", typeof r.json?.error?.message === "string" ? r.json.error.message.slice(0, 200) : "no tool list", { status: 502 });
  }
  return tools;
}
