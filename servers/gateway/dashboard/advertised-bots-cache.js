/**
 * Advertised-bots cache — per-peer /dashboard/advertised-bots fetch + validate
 * + TTL cache. Sibling of overview-cache.js, same signed-fetch seam. A peer
 * that errors/times out yields an `unavailable` sentinel (never throws), so a
 * single offline Crow can't break the Messages render.
 *
 * COMPLETENESS CONTRACT. Every result carries a boolean `complete`, and it is
 * true ONLY when both sides positively agree the list is whole:
 *   - the sender asserted `complete: true` (it skipped no bot while building the
 *     payload — see buildAdvertisementPayload), AND
 *   - the receiver dropped no entry in validateBot (raw.length === bots.length).
 * Anything else — an old peer that sends no `complete` key, a malformed body, a
 * timeout, an unparseable bot — is `complete: false`. Absence of the assertion
 * is never trust: a body that isn't `{bots: [...]}` is reported `unavailable`
 * rather than `ok` with an empty list, because "this peer advertises nothing" is
 * a claim a garbage collector would act on by DELETING contacts. Consumers that
 * destroy data must require `status === "ok" && complete === true`; this is
 * fail-safe by construction across a rolling deploy.
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
    invite_code: b.invite_code.slice(0, 2000), // fresh slice — cache is the hardening point for peer data
    description: (typeof b.description === "string" && b.description.trim())
      ? b.description.trim().slice(0, 140) : null,
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
  catch (err) { return { instanceId, status: "unavailable", reason: "exception:" + (err?.message || "unknown"), bots: [], complete: false }; }
  if (!result || !result.ok) return { instanceId, status: "unavailable", reason: result?.error || "fetch_failed", bots: [], complete: false };
  // A body without a `bots` array is an outage, NOT "this peer advertises
  // nothing" — the latter is a claim the prune would act on by deleting.
  if (!result.body || !Array.isArray(result.body.bots)) {
    return { instanceId, status: "unavailable", reason: "bad_body", bots: [], complete: false };
  }
  const raw = result.body.bots;
  const bots = raw.map((b) => validateBot(b, instanceId)).filter(Boolean);
  // Both sides must agree: the sender positively asserted it, and we parsed
  // every entry it sent. An old peer sends no key ⇒ false.
  const complete = result.body.complete === true && raw.length === bots.length;
  return { instanceId, status: "ok", bots, complete };
}

/** Fetch (or return cached) advertised bots for one paired peer. Never throws. */
export async function getPeerAdvertisedBots(db, instanceId) {
  if (!instanceId) return { instanceId, status: "unavailable", reason: "no_id", bots: [], complete: false };
  const entry = _cache.get(instanceId);
  if (entry && entry.expiresAt > now()) {
    if (entry.inflight) return entry.inflight;
    return entry.data;
  }
  const inflight = (async () => {
    // doFetch never throws today, but guard the IIFE anyway (mirrors
    // overview-cache.js) so a future fallible doFetch can't surface an
    // unhandled rejection to callers sharing this inflight promise.
    try {
      const data = await doFetch(db, instanceId);
      _cache.set(instanceId, { data, expiresAt: now() + TTL_MS });
      return data;
    } catch (err) {
      const sentinel = { instanceId, status: "unavailable", reason: "exception:" + (err?.message || "unknown"), bots: [], complete: false };
      _cache.set(instanceId, { data: sentinel, expiresAt: now() + TTL_MS });
      return sentinel;
    }
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
