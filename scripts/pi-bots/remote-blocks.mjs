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
import { signPeerRelayActor } from "./actor-sig.mjs";

/** Core capabilities with a dedicated MCP mount (addons deferred to a later slice). */
export const REMOTE_CANON_MOUNT = {
  "crow-memory": "/memory",
  "crow-projects": "/projects",
  "crow-sharing": "/sharing",
  "crow-storage": "/storage",
  "crow-blog": "/blog-mcp",
};

/**
 * The .mcp.json server name for one (peer, capability) forward proxy. The
 * bridge's --tools csv names `mcp__` + this (the router-mode gateway tool), so
 * both sides MUST build it here.
 */
export function remoteBlockName(instanceId, canonicalId) {
  return `crow-remote-${instanceId.slice(0, 8)}-${canonicalId}`;
}

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
 *
 * Item 46 PR-B (the operator's ruling): no pair key, signing key or peer bearer ever
 * reaches a bot or pi process. The proxy therefore never talks to the peer: it
 * calls the gateway's loopback relay (servers/gateway/routes/peer-relay.js)
 * with the path-scoped relay token and its signed actor headers, and the
 * gateway forwards. A block's env is exactly the relay env below; it names no
 * peer URL, no bearer, no key and no credential-store path.
 *
 * @param {object} def
 * @param {object} o
 * @param {Record<string,string>} o.peerGatewayUrls  instanceId -> gateway_url (caller-supplied);
 *   used only to skip unknown/revoked peers, never written into a block
 * @param {string} o.proxyPath  absolute path to crow-remote-proxy.mjs
 * @param {string} o.node       absolute node binary
 * @param {string} o.relayBaseUrl   this gateway's loopback base, e.g. http://127.0.0.1:3001
 * @param {string} o.relayTokenPath absolute path to this instance's peer-relay-token
 * @param {{botId:string, sessionId?:string|number, threadId?:string, gatewayType?:string}} [o.actor]
 *   the bot this turn runs as and its bot_sessions.id; its session-bound relay
 *   signature is added when this process holds the per-boot actor key (or its
 *   gateway presigned this exact tuple, actor-sig.mjs presignActors)
 * @returns {{ blocks: Record<string,object>, warnings: string[] }}
 */
export function mintRemoteBlocks(def, { peerGatewayUrls = {}, proxyPath, node, relayBaseUrl, relayTokenPath, actor } = {}) {
  const blocks = {};
  const warnings = [];
  const base = typeof relayBaseUrl === "string" ? relayBaseUrl.replace(/\/+$/, "") : "";
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
    if (!base || !relayTokenPath) {
      warnings.push(`remote '${instanceId}::${canonicalId}' skipped — no gateway relay configured`);
      continue;
    }
    const name = remoteBlockName(instanceId, canonicalId);
    if (blocks[name]) {
      warnings.push(`remote '${instanceId}::${canonicalId}' skipped — block name '${name}' collides with another selected peer (8-char instanceId prefix clash); keeping the first`);
      continue;
    }
    const env = {
      CROW_REMOTE_RELAY_URL: `${base}/peer-relay/${encodeURIComponent(instanceId)}${mount}/mcp`,
      CROW_REMOTE_RELAY_TOKEN_PATH: relayTokenPath,
    };
    if (actor && actor.botId != null && String(actor.botId) !== "") {
      env.CROW_REMOTE_ACTOR_ID = String(actor.botId);
      env.CROW_REMOTE_ACTOR_THREAD = actor.threadId == null ? "" : String(actor.threadId);
      env.CROW_REMOTE_ACTOR_GATEWAY = actor.gatewayType == null ? "" : String(actor.gatewayType);
      env.CROW_REMOTE_ACTOR_SESSION = actor.sessionId == null ? "" : String(actor.sessionId);
      const sig = signPeerRelayActor(actor);
      if (sig) env.CROW_REMOTE_ACTOR_SIG = sig;
    }
    blocks[name] = {
      command: node,
      args: [proxyPath],
      // Router mode: pi-lab's mcp-client registers ONE gateway tool,
      // mcp__<name> (action list|describe|call), which is exactly the
      // server-level entry bridge.mjs toolAllowlist puts in --tools. Without
      // it pi-lab registers mcp__<name>__<tool> per tool, pi's exact-match
      // --tools filter drops every one, and the bot silently has no remote
      // tool (queue item 38a). One tool per capability also keeps the
      // tool-budget count (one per csv entry) honest.
      router: true,
      env,
    };
  }
  return { blocks, warnings };
}
