/**
 * F4a Layer 2b — pure helpers for cross-instance tool invocation.
 *
 * DB-AGNOSTIC by design: callers (bridge=better-sqlite3, panel=libsql, CLI)
 * read the feature flag + peer gateway URLs with their own client and pass the
 * results in. This module only parses + mints; it touches no DB and no network.
 * Remote invocation is OFF unless the caller passes a truthy remoteEnabled /
 * non-empty peerGatewayUrls — so any caller that doesn't opt in keeps today's
 * behavior (the flag-off invariant is structural).
 */

/** Core capabilities with a dedicated MCP mount (addons deferred to a later slice). */
export const REMOTE_CANON_MOUNT = {
  "crow-memory": "/memory",
  "crow-projects": "/projects",
  "crow-sharing": "/sharing",
  "crow-storage": "/storage",
  "crow-blog": "/blog-mcp",
};

/** Parse a raw `feature_flags` setting value → is remote_invocation enabled? */
export function parseRemoteInvocationFlag(raw) {
  if (raw == null) return false;
  let flags;
  try { flags = JSON.parse(raw); } catch { return false; }
  return !!flags && flags.remote_invocation === true;
}

/** Parse def.tools.remote_mcp → [{ instanceId, canonicalId }], dropping malformed entries. */
export function remoteServersForBot(def) {
  const sel = (def && def.tools && def.tools.remote_mcp) || [];
  const out = [];
  for (const entry of sel) {
    if (typeof entry !== "string") continue;
    const idx = entry.indexOf("::");
    if (idx <= 0) continue; // need a non-empty instanceId before "::"
    const instanceId = entry.slice(0, idx);
    const canonicalId = entry.slice(idx + 2);
    if (!instanceId || !canonicalId) continue;
    out.push({ instanceId, canonicalId });
  }
  return out;
}

/**
 * Mint per-(instance,capability) stdio forward-proxy blocks for a bot.
 * @param {object} def
 * @param {object} o
 * @param {Record<string,string>} o.peerGatewayUrls  instanceId -> gateway_url (caller-supplied)
 * @param {string} o.proxyPath  absolute path to crow-remote-proxy.mjs
 * @param {string} o.node       absolute node binary
 * @returns {{ blocks: Record<string,object>, warnings: string[] }}
 */
export function mintRemoteBlocks(def, { peerGatewayUrls = {}, proxyPath, node }) {
  const blocks = {};
  const warnings = [];
  for (const { instanceId, canonicalId } of remoteServersForBot(def)) {
    const mount = REMOTE_CANON_MOUNT[canonicalId];
    if (!mount) {
      warnings.push(`remote '${instanceId}::${canonicalId}' skipped — only core capabilities are remotely invocable this slice (addon caps deferred)`);
      continue;
    }
    const gatewayUrl = peerGatewayUrls[instanceId];
    if (!gatewayUrl) {
      warnings.push(`remote '${instanceId}::${canonicalId}' skipped — unknown/revoked peer or no gateway_url for instance '${instanceId}'`);
      continue;
    }
    const name = `crow-remote-${instanceId.slice(0, 8)}-${canonicalId}`;
    blocks[name] = {
      command: node,
      args: [proxyPath],
      env: {
        CROW_REMOTE_INSTANCE_ID: instanceId,
        CROW_REMOTE_GATEWAY_URL: gatewayUrl,
        CROW_REMOTE_MOUNT: mount,
      },
    };
  }
  return { blocks, warnings };
}
