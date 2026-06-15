/**
 * F4a Layer 2a — cross-instance invocation exposure + enforcement.
 *
 * The trust boundary for remote tool invocation. A trusted peer instance
 * (req.instanceAuth.instance) may invoke a tool ONLY if its owning capability
 * canonicalId is in this instance's `remote_exposed_tools` allowlist.
 * DEFAULT-DENY: nothing is invocable by a peer until the operator exposes it.
 *
 * This gate is the security keystone — it enforces server-side, independent of
 * any UI affordance, even against a peer crafting a raw JSON-RPC call to any
 * mounted MCP endpoint. The catalog `exposed` flag is convenience, NOT the
 * boundary. Local-operator calls are never gated here (they don't carry
 * req.instanceAuth.instance).
 */
import { readSetting } from "./dashboard/settings/registry.js";
import { getOrCreateLocalInstanceId } from "./instance-registry.js";
import { auditCrossHostCall } from "../shared/cross-host-auth.js";
import { emitFixIt } from "./fix-it/index.js";

/** Local-only (never-synced) setting key. Deliberately absent from sync-allowlist.js. */
export const EXPOSURE_SETTING_KEY = "remote_exposed_tools";

/**
 * Read the exposure allowlist → Set<canonicalId>. Tolerates absent/malformed
 * settings by returning an empty set (deny-all). Never throws.
 */
export async function getExposedCapabilities(db) {
  let raw;
  try { raw = await readSetting(db, EXPOSURE_SETTING_KEY); } catch { return new Set(); }
  if (raw == null) return new Set();
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return new Set(); }
  if (!Array.isArray(parsed)) return new Set();
  return new Set(parsed.filter((x) => typeof x === "string" && x.length > 0));
}

// Mount prefix → canonical capability id, for prefixes where ALL tools belong
// to one capability. Root "" is the single-server memory mount.
const PREFIX_CANON = {
  "memory": "crow-memory",
  "": "crow-memory",
  "projects": "crow-projects",
  "research": "crow-projects",
  "sharing": "crow-sharing",
  "storage": "crow-storage",
  "blog-mcp": "crow-blog",
};

/** Find the connectedServers id whose tool list contains `toolName`. */
function resolveProxyTool(toolName, connectedServers) {
  if (!toolName || !connectedServers) return null;
  for (const [id, entry] of connectedServers) {
    if (entry && Array.isArray(entry.tools) && entry.tools.some((t) => t && t.name === toolName)) {
      return id; // addon entries are keyed by their canonical id (proxy.js)
    }
  }
  return null;
}

/**
 * Resolve the canonical capability id a peer call targets.
 * @returns {string|null|"__allow__"} canonicalId to check; null = deny (fail
 *   closed); "__allow__" = ungated (discovery / non-tools-call method).
 */
export function resolveCalledCanonicalId(prefix, body, connectedServers) {
  if (!body || body.method !== "tools/call") return "__allow__";
  const toolName = body.params?.name;
  const p = String(prefix || "").replace(/^\/+/, "");

  // For these single-capability mounts the tool name is intentionally NOT
  // consulted: the whole mount maps to exactly one capability, and the
  // underlying MCP server validates the tool name downstream — so an
  // un-exposed tool cannot ride in on a single-capability mount.
  if (Object.prototype.hasOwnProperty.call(PREFIX_CANON, p)) return PREFIX_CANON[p];

  if (p === "router") {
    if (toolName === "crow_discover") return "__allow__";
    if (toolName === "crow_tools") {
      const args = body.params?.arguments || {};
      if (args.instance_id) return null; // onward relay to a third instance — deny this hop
      return resolveProxyTool(args.action, connectedServers);
    }
    if (typeof toolName === "string" && toolName.startsWith("crow_")) {
      return `crow-${toolName.slice("crow_".length)}`;
    }
    return null;
  }

  if (p === "tools" || p.startsWith("tools-")) {
    return resolveProxyTool(toolName, connectedServers);
  }

  return null; // unknown prefix — fail closed
}

const DENY_CODE = -32001;

/**
 * Enforcement gate for the instance-auth MCP path. Returns true to proceed,
 * false if the call was rejected (this fn already wrote the JSON-RPC error).
 *
 * @param {object} o
 * @param {string} o.prefix mount prefix (closure-bound in mountMcpServer)
 * @param {object} o.req express req (reads req.instanceAuth, req.body)
 * @param {object} o.res express res
 * @param {object} o.db libsql client (for exposure read + audit)
 * @param {Map} o.connectedServers proxy map (for addon/proxy resolution)
 * @param {Set<string>} [o.exposedSetOverride] test hook — skip the db read
 * @param {Function} [o.auditFn] test hook — defaults to auditCrossHostCall
 */
export async function enforcePeerExposure({ prefix, req, res, db, connectedServers, exposedSetOverride, auditFn = auditCrossHostCall, emitFn = emitFixIt }) {
  // Only peer-instance callers are gated. Local-operator calls don't carry this.
  if (!req?.instanceAuth?.instance) return true;

  const body = req.body;
  const canonicalId = resolveCalledCanonicalId(prefix, body, connectedServers);
  if (canonicalId === "__allow__") return true; // discovery / non-tools-call

  const exposed = exposedSetOverride || await getExposedCapabilities(db);
  const allowed = typeof canonicalId === "string" && exposed.has(canonicalId);

  const sourceId = req.instanceAuth.instance.id;
  let localId = null;
  try { localId = getOrCreateLocalInstanceId(); } catch { /* best-effort */ }
  const toolName = body?.params?.name || null;

  // Audit every peer tools/call decision (never throws).
  try {
    await auditFn(db, {
      sourceInstanceId: sourceId,
      targetInstanceId: localId,
      direction: "inbound",
      action: `tools/call:${toolName || "?"}`,
      bundleId: canonicalId || null,
      actor: `instance:${sourceId}`,
      httpStatus: allowed ? 200 : 403,
      error: allowed ? null : "not_exposed",
    });
  } catch { /* audit must not break the path */ }

  if (allowed) return true;

  // Fix-it: a resolvable capability was denied → surface a one-click "Allow"
  // card. Fire-and-forget; must never block or break the gate. Only real,
  // resolvable capabilities (string canonicalId) become cards — a null-canonical
  // (malformed) deny is skipped.
  if (typeof canonicalId === "string") {
    try {
      Promise.resolve(emitFn(db, "peer-exposure:denied", {
        capability: canonicalId,
        requestingInstance: sourceId,
        toolName,
      })).catch(() => {});
    } catch { /* never breaks the gate */ }
  }

  if (!res.headersSent) {
    res.status(403).json({
      jsonrpc: "2.0",
      id: body?.id ?? null,
      error: { code: DENY_CODE, message: "Tool not exposed for remote invocation by this instance" },
    });
  }
  return false;
}
