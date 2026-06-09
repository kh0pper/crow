/**
 * Per-peer capability-catalog cache (F4a Layer 1). Mirrors overview-cache.js:
 * stampede-protected, validated-on-receive, TTL-cached signed fetch of a peer's
 * /dashboard/capabilities. Longer TTL than overview (catalogs change only on
 * install/uninstall). Receive-side validation is the trust boundary — a
 * compromised peer cannot inject unexpected fields.
 */
import { forwardSignedRequest } from "../../shared/peer-forward.js";
import { getOrCreateLocalInstanceId } from "../instance-registry.js";

const TTL_SUCCESS_MS = 60_000;
const TTL_VIOLATION_MS = 60_000;
const FETCH_TIMEOUT_MS = 2_000;
const MAX_RESPONSE_BYTES = 256 * 1024; // catalogs are larger than overviews
const _cache = new Map();
const now = () => Date.now();
const cacheKey = (id, source = "dashboard") => `${source}::${id}`;

const str = (v, max = 256) => (typeof v === "string" ? v.slice(0, max) : null);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function vTool(t) {
  if (!t || typeof t !== "object") return null;
  const canonicalId = str(t.canonicalId);
  const name = str(t.name);
  if (!canonicalId || !name) return null;
  return {
    canonicalId,
    category: str(t.category),
    name,
    bundleId: t.bundleId == null ? null : str(t.bundleId),
    toolCount: num(t.toolCount),
    exposed: !!t.exposed,
  };
}

function vSkill(s) {
  return s && typeof s === "object" && str(s.name) ? { name: str(s.name) } : null;
}

function vBot(b) {
  if (!b || typeof b !== "object" || !str(b.bot_id)) return null;
  return {
    bot_id: str(b.bot_id),
    display_name: str(b.display_name),
    enabled: !!b.enabled,
    project_id: b.project_id == null ? null : num(b.project_id),
    tracker_type: str(b.tracker_type) || "none",
    model: b.model == null ? null : str(b.model),
    tool_count: num(b.tool_count) ?? 0,
    peer_manageable: !!b.peer_manageable,
  };
}

const CAP_ARRAY = 500; // hard cap per list

export function validateCapabilitiesEnvelope(body) {
  if (!body || typeof body !== "object") return null;
  if (!body.instance || typeof body.instance !== "object" || !str(body.instance.id)) return null;
  const c = body.capabilities;
  if (!c || typeof c !== "object" || !Array.isArray(c.tools) || !Array.isArray(c.skills) || !Array.isArray(c.bots)) return null;
  return {
    instance: {
      id: str(body.instance.id),
      name: body.instance.name == null ? null : str(body.instance.name),
    },
    capabilities: {
      tools: c.tools.map(vTool).filter(Boolean).slice(0, CAP_ARRAY),
      skills: c.skills.map(vSkill).filter(Boolean).slice(0, CAP_ARRAY),
      bots: c.bots.map(vBot).filter(Boolean).slice(0, CAP_ARRAY),
    },
    generatedAt: str(body.generatedAt),
  };
}

function errorSentinel(instanceId, reason) {
  return { instanceId, status: "unavailable", reason, capabilities: { tools: [], skills: [], bots: [] } };
}

let _fetchImpl = defaultFetchImpl;
export function _setFetchImpl(fn) { _fetchImpl = fn || defaultFetchImpl; }
export function _resetCache() { _cache.clear(); }

async function defaultFetchImpl(db, instanceId) {
  const result = await forwardSignedRequest({
    db,
    sourceInstanceId: getOrCreateLocalInstanceId(),
    targetInstanceId: instanceId,
    method: "GET",
    path: "/dashboard/capabilities",
    auditAction: "federation.capabilities",
    timeoutMs: FETCH_TIMEOUT_MS,
    maxResponseBytes: MAX_RESPONSE_BYTES,
  });

  if (!result || !result.ok) {
    return { sentinel: errorSentinel(instanceId, (result && result.error) || "fetch_failed"), ttlMs: null };
  }

  // forwardSignedRequest already parses JSON when Content-Type is application/json
  // (result.body is the parsed object); result.raw is the raw string.
  // Accept either form defensively.
  let parsed;
  if (result.body !== null && result.body !== undefined && typeof result.body === "object") {
    parsed = result.body;
  } else {
    const raw = typeof result.body === "string" ? result.body : result.raw;
    if (!raw) return { sentinel: errorSentinel(instanceId, "parse_error"), ttlMs: TTL_VIOLATION_MS };
    try { parsed = JSON.parse(raw); } catch {
      return { sentinel: errorSentinel(instanceId, "parse_error"), ttlMs: TTL_VIOLATION_MS };
    }
  }

  const valid = validateCapabilitiesEnvelope(parsed);
  if (!valid) return { sentinel: errorSentinel(instanceId, "schema_violation"), ttlMs: TTL_VIOLATION_MS };

  return {
    data: { instanceId, status: "ok", ...valid },
    ttlMs: TTL_SUCCESS_MS,
  };
}

export async function getPeerCapabilities(db, instanceId, { source = "dashboard" } = {}) {
  if (!instanceId) throw new Error("instanceId required");
  const key = cacheKey(instanceId, source);
  const hit = _cache.get(key);
  if (hit && hit.expiresAt > now()) return hit.inflight ? hit.inflight : hit.data;

  const inflight = (async () => {
    try {
      const r = await _fetchImpl(db, instanceId);
      if (r.data) {
        const payload = r.data.status ? r.data : { status: "ok", ...r.data };
        _cache.set(key, { data: payload, expiresAt: now() + (r.ttlMs || TTL_SUCCESS_MS) });
        return payload;
      }
      if (r.ttlMs) {
        _cache.set(key, { data: r.sentinel, expiresAt: now() + r.ttlMs });
      } else {
        _cache.delete(key); // don't cache hard failures
      }
      return r.sentinel;
    } catch (err) {
      const sentinel = errorSentinel(instanceId, "exception:" + (err?.message || "unknown"));
      _cache.set(key, { data: sentinel, expiresAt: now() + TTL_VIOLATION_MS });
      return sentinel;
    }
  })();

  _cache.set(key, { inflight, expiresAt: now() + FETCH_TIMEOUT_MS + 500 });
  return inflight;
}
