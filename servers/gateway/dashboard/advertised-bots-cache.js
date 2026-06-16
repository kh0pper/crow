/**
 * Advertised-bots cache — per-peer /dashboard/advertised-bots fetch + validate
 * + TTL cache. Sibling of overview-cache.js, same signed-fetch seam. A peer
 * that errors/times out yields an `unavailable` sentinel (never throws), so a
 * single offline Crow can't break the Messages render.
 */
import { forwardSignedRequest } from "../../shared/peer-forward.js";
import { getOrCreateLocalInstanceId } from "../instance-registry.js";

const TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 2_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const HEX64 = /^[a-f0-9]{64}$/i;

const _cache = new Map();
const now = () => Date.now();

function validateBot(b, instanceId) {
  if (!b || typeof b !== "object") return null;
  if (typeof b.bot_id !== "string" || !b.bot_id || b.bot_id.length > 128) return null;
  if (typeof b.invite_code !== "string" || !b.invite_code.startsWith("crow:") || b.invite_code.length > 2000) return null;
  // Strip compressed-pubkey prefix (02/03) if present, then lowercase
  const pk = (typeof b.messaging_pubkey === "string" ? b.messaging_pubkey : "").replace(/^0[23]/, "").toLowerCase();
  if (!HEX64.test(pk)) return null;
  return {
    bot_id: b.bot_id,
    display_name: (typeof b.display_name === "string" && b.display_name) ? b.display_name.slice(0, 256) : b.bot_id,
    instance_id: instanceId,
    instance_label: typeof b.instance_label === "string" ? b.instance_label.slice(0, 256) : null,
    messaging_pubkey: pk,
    invite_code: b.invite_code,
  };
}

async function defaultFetchImpl(db, instanceId) {
  const localId = getOrCreateLocalInstanceId();
  return forwardSignedRequest({
    db, sourceInstanceId: localId, targetInstanceId: instanceId,
    method: "GET", path: "/dashboard/advertised-bots",
    auditAction: "federation.advertised-bots", actor: "advertised-bots-cache",
    timeoutMs: FETCH_TIMEOUT_MS, maxResponseBytes: MAX_RESPONSE_BYTES,
  });
}
let _fetchImpl = defaultFetchImpl;

async function doFetch(db, instanceId) {
  let result;
  try { result = await _fetchImpl(db, instanceId); }
  catch (err) { return { instanceId, status: "unavailable", reason: "exception:" + (err?.message || "unknown"), bots: [] }; }
  if (!result || !result.ok) return { instanceId, status: "unavailable", reason: result?.error || "fetch_failed", bots: [] };
  const raw = result.body && Array.isArray(result.body.bots) ? result.body.bots : [];
  const bots = raw.map((b) => validateBot(b, instanceId)).filter(Boolean);
  return { instanceId, status: "ok", bots };
}

/** Fetch (or return cached) advertised bots for one paired peer. Never throws. */
export async function getPeerAdvertisedBots(db, instanceId) {
  if (!instanceId) return { instanceId, status: "unavailable", reason: "no_id", bots: [] };
  const entry = _cache.get(instanceId);
  if (entry && entry.expiresAt > now()) {
    if (entry.inflight) return entry.inflight;
    return entry.data;
  }
  const inflight = (async () => {
    const data = await doFetch(db, instanceId);
    _cache.set(instanceId, { data, expiresAt: now() + TTL_MS });
    return data;
  })();
  _cache.set(instanceId, { inflight, expiresAt: now() + FETCH_TIMEOUT_MS + 500 });
  return inflight;
}

export function _resetCache() { _cache.clear(); }

/**
 * Test helper: swap the fetch implementation. Pass `null` to restore the
 * real signed-request path.
 */
export function _setFetchImpl(fn) { _fetchImpl = fn || defaultFetchImpl; }
