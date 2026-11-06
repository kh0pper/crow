/**
 * F4a Layer 2a — cross-instance invocation exposure + enforcement.
 *
 * The trust boundary for remote tool invocation. A trusted peer instance
 * (req.instanceAuth.instance) may invoke a tool ONLY if its owning capability
 * canonicalId is exposed to it: either in this instance's all-trusted-peers
 * `remote_exposed_tools` allowlist, or in a per-peer grant for THAT peer
 * (`remote_exposed_tools_by_peer`, N1b-8). DEFAULT-DENY: nothing is invocable
 * by a peer until the operator exposes it.
 *
 * This gate is the security keystone — it enforces server-side, independent of
 * any UI affordance, even against a peer crafting a raw JSON-RPC call to any
 * mounted MCP endpoint. The catalog `exposed` flag is convenience, NOT the
 * boundary. Local-operator calls are never gated here (they don't carry
 * req.instanceAuth.instance).
 *
 * N1b-8: the per-peer side exists so one peer's one-click "Allow" card cannot
 * widen a capability to every peer forever. The peer identity used here is the
 * VERIFIED one (`req.instanceAuth.instance.id`, from the bearer token hash) and
 * nothing else — a request body cannot assert it.
 */
import { getOrCreateLocalInstanceId } from "./instance-registry.js";
import { auditCrossHostCall } from "../shared/cross-host-auth.js";
import { emitFixIt } from "./fix-it/index.js";
import { canonicalizePeerCapabilityTool, getLocalCapabilityIds } from "./capability-ids.js";
import {
  EXPOSURE_SETTING_KEY,
  PEER_EXPOSURE_SETTING_KEY,
  getExposedCapabilities,
  getPeerExposures,
  getPeerGrantedCapabilities,
  getExposureForPeer,
  isCapabilityExposedToPeer,
  grantPeerCapability,
  renewPeerGrant,
  removePeerGrant,
  removePeerExposures,
  grantIsActive,
} from "./peer-exposure-store.js";

// The exposure storage lives in peer-exposure-store.js (a leaf module the
// Fix-it detector/remedy and the Settings section can import without a cycle);
// re-exported here because this is where callers expect to find it.
export {
  EXPOSURE_SETTING_KEY,
  PEER_EXPOSURE_SETTING_KEY,
  getExposedCapabilities,
  getPeerExposures,
  getPeerGrantedCapabilities,
  getExposureForPeer,
  isCapabilityExposedToPeer,
  grantPeerCapability,
  renewPeerGrant,
  removePeerGrant,
  removePeerExposures,
  grantIsActive,
};

const EMPTY_SET = new Set();

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

/**
 * Find the ONLY connectedServers id that could run `toolName`, or null (deny).
 *
 * The gate runs before, and separately from, the executor (router.js
 * crow_tools: first connected non-remote match in map order; proxy.js
 * createProxyServer: first registered, bound at session start). Sources
 * connect, disconnect and reconnect in between, so the gate must not guess
 * which one will run. Rule: skip federation peers (isRemote — no executor
 * reaches a peer by bare name, and resolving one would raise a Fix-it card
 * that could expose an `instance-<id>` string), and require the name to be
 * held by exactly ONE local entry, WHATEVER its status. Then any executor
 * can only run that entry or nothing. A name held by two local entries —
 * connected or not — is ambiguous and denied (fail closed).
 */
function resolveProxyTool(toolName, connectedServers) {
  if (!toolName || !connectedServers) return null;
  let found = null;
  for (const [id, entry] of connectedServers) {
    if (!entry || entry.isRemote) continue;
    // A satellite-hosted bundle is NEVER remotable (spec §9.2): not resolvable, so it can never
    // be in remote_exposed_tools effectively, whatever the setting says.
    if (entry.isSatellite) continue;
    if (Array.isArray(entry.tools) && entry.tools.some((t) => t && t.name === toolName)) {
      if (found !== null) return null; // ambiguous
      found = id; // addon entries are keyed by their canonical id (proxy.js)
    }
  }
  return found;
}

/**
 * Resolve the canonical capability id a peer call targets, and where the id
 * came from: `peerChosen` is true only when the PEER named it (a `/router`
 * `crow_<something>` tool), which is the one case where the id must be matched
 * against this instance's own catalog before it may raise a card.
 *
 * @returns {{id: string|null|"__allow__", peerChosen: boolean}}
 */
export function resolveCalledCapability(prefix, body, connectedServers) {
  // A batch (array) or a non-object body names no single method: never allow.
  if (Array.isArray(body) || (body !== undefined && (body === null || typeof body !== "object"))) {
    return { id: null, peerChosen: false };
  }
  if (!body || body.method !== "tools/call") return { id: "__allow__", peerChosen: false };
  const toolName = body.params?.name;
  const p = String(prefix || "").replace(/^\/+/, "");

  // For these single-capability mounts the tool name is intentionally NOT
  // consulted: the whole mount maps to exactly one capability, and the
  // underlying MCP server validates the tool name downstream — so an
  // un-exposed tool cannot ride in on a single-capability mount.
  if (Object.prototype.hasOwnProperty.call(PREFIX_CANON, p)) {
    return { id: PREFIX_CANON[p], peerChosen: false };
  }

  if (p === "router") {
    if (toolName === "crow_discover") return { id: "__allow__", peerChosen: false };
    if (toolName === "crow_tools") {
      const args = body.params?.arguments || {};
      if (args.instance_id) return { id: null, peerChosen: false }; // onward relay to a third instance — deny this hop
      return { id: resolveProxyTool(args.action, connectedServers), peerChosen: false };
    }
    if (typeof toolName === "string" && toolName.startsWith("crow_")) {
      // N1b-8 review round 1 (B2): the PEER picked this string. Canonicalise it
      // (`crow_Memory` → `crow-memory`, junk → an id no catalog holds) and let
      // the gate require it to be a capability of this instance before a card
      // or a counter may mention it.
      return { id: canonicalizePeerCapabilityTool(toolName), peerChosen: true };
    }
    return { id: null, peerChosen: false };
  }

  if (p === "tools" || p.startsWith("tools-")) {
    return { id: resolveProxyTool(toolName, connectedServers), peerChosen: false };
  }

  return { id: null, peerChosen: false }; // unknown prefix — fail closed
}

/**
 * Resolve the canonical capability id a peer call targets.
 * @returns {string|null|"__allow__"} canonicalId to check; null = deny (fail
 *   closed); "__allow__" = ungated (discovery / non-tools-call method).
 */
export function resolveCalledCanonicalId(prefix, body, connectedServers) {
  return resolveCalledCapability(prefix, body, connectedServers).id;
}

/**
 * Is `id` a capability THIS instance has? A peer-named id must be in the local
 * catalog. An id the instance itself resolved (a mount's canonical id, or an
 * addon found in the live server map) is known by construction. Never throws —
 * an unknown answer fails closed (the capability stays unknown, so it gets no
 * card).
 */
function isKnownCapability(id, peerChosen, connectedServers) {
  try {
    if (getLocalCapabilityIds().has(id)) return true;
    if (peerChosen) return false;
    return connectedServers instanceof Map && connectedServers.has(id);
  } catch { return false; }
}

const DENY_CODE = -32001;
const INVALID_REQUEST = -32600;
// Verbs that carry no JSON-RPC body on an MCP mount (open the session stream,
// close the session). Every other peer request must be ONE plain object.
const BODYLESS = new Set(["GET", "HEAD", "DELETE"]);

/**
 * A paired instance sends exactly one plain JSON-RPC object per POST. A batch
 * (array) or any other shape is refused before the MCP transport sees it: the
 * transport runs every message of a batch, and the exposure decision below is
 * made for one message. Bodyless verbs may carry no body (or the parser's {}).
 */
function isSinglePeerRequest(req) {
  const body = req.body;
  if (Array.isArray(body)) return false;
  if (body === undefined) return BODYLESS.has(String(req.method || "").toUpperCase());
  return body !== null && typeof body === "object";
}

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
 * @param {Set<string>} [o.exposedSetOverride] test hook — all-peer set, skips the db read
 * @param {Map<string, Set<string>>} [o.peerGrantsOverride] test hook — per-peer caps, skips the db read
 * @param {number} [o.now] test hook — injectable clock for grant expiry
 * @param {Function} [o.auditFn] test hook — defaults to auditCrossHostCall
 */
export async function enforcePeerExposure({ prefix, req, res, db, connectedServers, exposedSetOverride, peerGrantsOverride, now = Date.now(), auditFn = auditCrossHostCall, emitFn = emitFixIt }) {
  // Only peer-instance callers are gated. Local-operator calls don't carry this.
  if (!req?.instanceAuth?.instance) return true;

  const body = req.body;
  if (!isSinglePeerRequest(req)) {
    const sourceId = req.instanceAuth.instance.id;
    let localId = null;
    try { localId = getOrCreateLocalInstanceId(); } catch { /* best-effort */ }
    try {
      await auditFn(db, {
        sourceInstanceId: sourceId,
        targetInstanceId: localId,
        direction: "inbound",
        action: Array.isArray(body) ? `jsonrpc:batch(${body.length})` : "jsonrpc:invalid",
        bundleId: null,
        actor: `instance:${sourceId}`,
        httpStatus: 403,
        error: "not_single_request",
      });
    } catch { /* audit must not break the path */ }
    if (!res.headersSent) {
      res.status(403).json({
        jsonrpc: "2.0",
        id: null,
        error: { code: INVALID_REQUEST, message: "A paired instance must send one JSON-RPC request per call" },
      });
    }
    return false;
  }
  const resolved = resolveCalledCapability(prefix, body, connectedServers);
  const canonicalId = resolved.id;
  if (canonicalId === "__allow__") return true; // discovery / non-tools-call

  const sourceId = req.instanceAuth.instance.id;
  const exposed = exposedSetOverride || await getExposedCapabilities(db);
  // N1b-8: per-peer grants. Skipped when a test hook supplies the sets (the
  // hooks exist so unit tests never need a db); a read failure denies the
  // per-peer path only — the all-peer allowlist is unaffected.
  let peerCaps = EMPTY_SET;
  try {
    if (peerGrantsOverride !== undefined && peerGrantsOverride !== null) {
      peerCaps = peerGrantsOverride.get?.(sourceId) || EMPTY_SET;
    } else if (exposedSetOverride === undefined) {
      peerCaps = await getPeerGrantedCapabilities(db, sourceId, { now });
    }
  } catch { peerCaps = EMPTY_SET; }
  const allowed = typeof canonicalId === "string" && (exposed.has(canonicalId) || peerCaps.has(canonicalId));

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
  // card. Fire-and-forget; must never block or break the gate. A deny that
  // resolved to nothing this instance could name emits nothing at all (see the
  // `emitCapability` note below).
  //
  // N1b-8: the payload carries ONLY the verified peer id (`sourceId`) — that is
  // what scopes the all-peer card to this one peer. No name, id or header the
  // peer wrote into its request body ever reaches this payload.
  //
  // N1b-8 review round 1 (B2): `capabilityKnown` says whether the id matched a
  // capability of THIS instance's catalog. When it did not (a peer picked
  // `crow_junk99` on /router, or a name that is not even id-shaped), the
  // detector records ONE bounded "unknown" bucket for that peer instead of a
  // card and a counter keyed by junk. An id THIS instance resolved that came
  // out empty (an unknown /tools tool name) emits nothing at all, as before.
  const emitCapability = typeof canonicalId === "string"
    ? canonicalId
    : (resolved.peerChosen ? null : undefined);
  if (emitCapability !== undefined) {
    const capabilityKnown = typeof canonicalId === "string"
      ? isKnownCapability(canonicalId, resolved.peerChosen, connectedServers)
      : false;
    try {
      Promise.resolve(emitFn(db, "peer-exposure:denied", {
        capability: emitCapability,
        capabilityKnown,
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
