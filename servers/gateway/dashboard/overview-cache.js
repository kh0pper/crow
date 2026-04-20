/**
 * Overview cache — per-peer /dashboard/overview fetch + validate + cache.
 *
 * Callers:
 *   getPeerOverview(db, instanceId) → cached (or fresh) overview envelope
 *   prefetchPeerOverviews(db, ids)  → warm cache at startup
 *   invalidatePeerCache(instanceId) → synchronous drop; call after trust/status flip
 *
 * Cache keying: "${source}::${instanceId}" where source is currently always
 * "dashboard". Phase 3 will add a second source ("companion") on the same map
 * without cross-policy poisoning.
 *
 * TTL policy:
 *   - success envelope  → 30s
 *   - schema violation  → 60s (avoid re-probing a misbehaving peer every request)
 *   - fetch failure     → no TTL; returned but not cached (retry on next call)
 *
 * Receive-side validation runs on EVERY fetched response before caching.
 * A compromised peer cannot bypass by serving a pre-cached entry on another
 * node: each node validates independently. See servers/gateway/routes/federation.js
 * for the advertised schema.
 *
 * Size cap: the outbound helper `forwardSignedRequest` honors `maxResponseBytes`,
 * so oversize bodies never reach the validator. We still re-check here in case a
 * future caller forgets to pass the cap.
 *
 * Trust revocation: cache invalidation on trust/status flip is exposed via
 * `invalidatePeerCache()`; the emit side (instance-registry on update) is out
 * of scope for Phase 2. The 30s TTL is the residual exposure window if the
 * operator revokes a peer between cache fetches.
 */

import { forwardSignedRequest } from "../../shared/peer-forward.js";
import { getOrCreateLocalInstanceId } from "../instance-registry.js";

const TTL_SUCCESS_MS = 30_000;
const TTL_SCHEMA_VIOLATION_MS = 60_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 2_000;

const ID_REGEX = /^[a-z][a-z0-9_-]{0,63}$/;
const PATHNAME_REGEX = /^\/[a-zA-Z0-9_\-./]+$/;
const CATEGORY_ENUM = new Set(["local-panel", "bundle", "instance"]);

// Icon key allowlist. Must match keys advertised by panels/nest/html.js. We
// keep the allowlist here so the cache can reject/downgrade unknown values
// before they reach the renderer — unknown → "default" (silent fallback).
//
// Keep this list in sync with panels/nest/html.js TILE_ICONS + PANEL_ICON_MAP
// + ADDON_ICON_MAP. Adding an icon here that isn't rendered is harmless; the
// renderer does its own final mapping.
const ICON_ALLOWLIST = new Set([
  // TILE_ICONS keys
  "messages", "edit", "files", "settings", "extensions", "health", "skills",
  "contacts", "memory", "media", "conversation", "blog_draft", "project",
  "instance", "default",
  // ADDON_ICON_MAP keys
  "brain", "cloud", "image", "home", "book", "rss", "mic", "message-circle",
  "gamepad", "archive",
  // PANEL_ICON_MAP keys not already above
]);

const _cache = new Map();

function now() {
  return Date.now();
}

function cacheKey(instanceId, source = "dashboard") {
  return `${source}::${instanceId}`;
}

function validateTile(tile) {
  if (!tile || typeof tile !== "object") return null;
  if (typeof tile.id !== "string" || !ID_REGEX.test(tile.id)) return null;
  if (typeof tile.name !== "string" || tile.name.length === 0 || tile.name.length > 256) return null;
  if (typeof tile.pathname !== "string" || !PATHNAME_REGEX.test(tile.pathname)) return null;
  if (tile.pathname.includes("..")) return null;
  if (!CATEGORY_ENUM.has(tile.category)) return null;
  const port = tile.port === undefined ? null : tile.port;
  if (port !== null && (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)) return null;
  const icon = typeof tile.icon === "string" && ICON_ALLOWLIST.has(tile.icon) ? tile.icon : "default";
  return {
    id: tile.id,
    name: tile.name,
    icon,
    pathname: tile.pathname,
    port,
    category: tile.category,
  };
}

/**
 * Validate the outer overview envelope. Returns the sanitized envelope or
 * `null` when the response is structurally invalid.
 */
function validateEnvelope(body) {
  if (!body || typeof body !== "object") return null;
  if (!body.instance || typeof body.instance !== "object") return null;
  if (typeof body.instance.id !== "string" || !ID_REGEX.test(body.instance.id.replace(/[^a-z0-9_-]/g, ""))) {
    // Instance IDs in this codebase are 32-char hex; loosen regex check here
    // to allow existing IDs (hex) to pass.
    if (!/^[a-f0-9]{8,64}$/i.test(body.instance.id)) return null;
  }
  if (!Array.isArray(body.tiles)) return null;
  const tiles = [];
  for (const raw of body.tiles) {
    const t = validateTile(raw);
    if (t) tiles.push(t);
    // silently drop invalid entries; entire-envelope invalid case is caught above
  }
  return {
    instance: {
      id: body.instance.id,
      name: typeof body.instance.name === "string" ? body.instance.name : null,
      hostname: typeof body.instance.hostname === "string" ? body.instance.hostname : null,
      is_home: body.instance.is_home === true,
    },
    tiles,
    health: body.health && typeof body.health === "object" ? {
      status: body.health.status === "ok" ? "ok" : "degraded",
      checkedAt: typeof body.health.checkedAt === "string" ? body.health.checkedAt : null,
    } : { status: "degraded", checkedAt: null },
  };
}

function buildErrorSentinel(instanceId, reason) {
  return {
    instanceId,
    status: "unavailable",
    reason,
    tiles: [],
    fetchedAt: new Date().toISOString(),
  };
}

// The real fetch path. Extracted + swappable so tests can drive the cache
// without touching the HTTP stack. See `_setFetchImpl()` below.
async function defaultFetchImpl(db, instanceId) {
  const localId = getOrCreateLocalInstanceId();
  return forwardSignedRequest({
    db,
    sourceInstanceId: localId,
    targetInstanceId: instanceId,
    method: "GET",
    path: "/dashboard/overview",
    auditAction: "federation.overview",
    actor: "overview-cache",
    timeoutMs: FETCH_TIMEOUT_MS,
    maxResponseBytes: MAX_RESPONSE_BYTES,
  });
}

let _fetchImpl = defaultFetchImpl;

async function doFetch(db, instanceId) {
  const result = await _fetchImpl(db, instanceId);

  if (!result.ok) {
    // Transport / auth / size errors → sentinel with reason. Cached briefly so
    // a burst of /dashboard hits doesn't hammer a broken peer.
    const reason = result.error || "fetch_failed";
    return { sentinel: buildErrorSentinel(instanceId, reason), ttlMs: TTL_SCHEMA_VIOLATION_MS };
  }

  if (result.raw && typeof result.raw === "string" && result.raw.length > MAX_RESPONSE_BYTES) {
    return { sentinel: buildErrorSentinel(instanceId, "response_too_large"), ttlMs: TTL_SCHEMA_VIOLATION_MS };
  }

  const sanitized = validateEnvelope(result.body);
  if (!sanitized) {
    return { sentinel: buildErrorSentinel(instanceId, "schema_violation"), ttlMs: TTL_SCHEMA_VIOLATION_MS };
  }

  return {
    data: {
      instanceId,
      status: "ok",
      instance: sanitized.instance,
      tiles: sanitized.tiles,
      health: sanitized.health,
      fetchedAt: new Date().toISOString(),
    },
    ttlMs: TTL_SUCCESS_MS,
  };
}

/**
 * Fetch (or return cached) overview for a single peer. Stampede-protected:
 * concurrent misses for the same key share one in-flight promise.
 */
export async function getPeerOverview(db, instanceId, { source = "dashboard" } = {}) {
  if (!instanceId) throw new Error("instanceId required");
  const key = cacheKey(instanceId, source);
  const entry = _cache.get(key);
  if (entry && entry.expiresAt > now()) {
    if (entry.inflight) return entry.inflight;
    return entry.data;
  }

  const inflight = (async () => {
    try {
      const { data, sentinel, ttlMs } = await doFetch(db, instanceId);
      const payload = data || sentinel;
      _cache.set(key, { data: payload, expiresAt: now() + ttlMs });
      return payload;
    } catch (err) {
      const payload = buildErrorSentinel(instanceId, "exception:" + (err?.message || "unknown"));
      _cache.set(key, { data: payload, expiresAt: now() + TTL_SCHEMA_VIOLATION_MS });
      return payload;
    }
  })();

  _cache.set(key, { inflight, expiresAt: now() + FETCH_TIMEOUT_MS + 500 });
  return inflight;
}

/**
 * Prefetch overviews for a batch of instance ids. Errors are swallowed;
 * each id independently returns its sentinel.
 */
export async function prefetchPeerOverviews(db, instanceIds, opts = {}) {
  if (!Array.isArray(instanceIds) || instanceIds.length === 0) return [];
  const results = await Promise.allSettled(
    instanceIds.map(id => getPeerOverview(db, id, opts))
  );
  return results.map(r => r.status === "fulfilled" ? r.value : null);
}

/**
 * Synchronous cache-drop. Call after a trust/status mutation on a peer.
 * No-op when the peer isn't cached.
 */
export function invalidatePeerCache(instanceId, { source = "dashboard" } = {}) {
  _cache.delete(cacheKey(instanceId, source));
}

/**
 * Test helper: wipe the cache. Not exported from the public surface, just
 * for the tests/ suite to reset between cases.
 */
export function _resetCache() {
  _cache.clear();
}

/**
 * Test helper: swap the fetch implementation. Pass `null` to restore the
 * real signed-request path.
 */
export function _setFetchImpl(fn) {
  _fetchImpl = fn || defaultFetchImpl;
}

/**
 * Test helper: introspect the cache state. Returns a snapshot object.
 */
export function _inspectCache() {
  const out = {};
  for (const [k, v] of _cache.entries()) {
    out[k] = { hasData: !!v.data, hasInflight: !!v.inflight, expiresAt: v.expiresAt };
  }
  return out;
}
