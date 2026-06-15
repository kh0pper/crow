/**
 * Cross-instance (federated) tools for the IN-PROCESS voice loop.
 *
 * The voice turn (bundles/meta-glasses/panel/routes.js) never spawns pi, so the
 * text-bot .mcp.json remote-block path (scripts/pi-bots/remote-blocks.mjs) does
 * not apply. This module gives the voice tool-executor the same reach by:
 *   1. discovering a remote instance's capability tools over a peer-authed MCP
 *      client to the remote /router/mcp (crow_discover category "tools"),
 *   2. advertising the bot's selected remote capabilities' tools to the model,
 *   3. routing those tool calls back to the owning instance as
 *      crow_tools{action, params} (the peer-exposure-gated, verified path), and
 *   4. rewriting any _audio_stream envelope so audio streams through the owning
 *      instance's /audio/stream proxy (the bytes/token never leave that instance).
 *
 * SECURITY NOTE (reviewer C4): remote tools are advertised as direct promoted
 * tools and are NOT subject to the source-side per-bot addon allowlist
 * (isConnectedAddonTool is false for them — they aren't local). That is
 * intentional: the OWNING instance's remote_exposed_tools default-deny gate
 * (servers/gateway/peer-exposure.js) is the trust boundary, enforced server-side
 * regardless of what the source advertises. callRemote also never sets
 * instance_id (C3): peer-exposure denies onward-relay hops.
 *
 * Entirely OFF unless the bound bot opts in via def.tools.remote_mcp AND
 * feature_flags.remote_invocation — buildRemoteVoiceContext returns null
 * otherwise, so every existing caller is byte-for-byte unchanged.
 */

import { remoteServersForBot, parseRemoteInvocationFlag } from "../../../scripts/pi-bots/remote-blocks.mjs";

/**
 * Parse the remote router's crow_discover({category:"tools"}) text into
 * Map<capabilityId, [{name, description}]>. Header lines are "  <id>:" (two
 * spaces); tool lines are "    - <name>: <desc>" (four spaces).
 */
export function parseCapabilityTools(text) {
  const out = new Map();
  let current = null;
  for (const line of String(text || "").split("\n")) {
    const header = line.match(/^ {2}([^\s].*?):\s*$/);
    if (header) {
      current = header[1];
      if (!out.has(current)) out.set(current, []);
      continue;
    }
    const tool = line.match(/^ {4}- (\S+):\s?(.*)$/);
    if (tool && current) {
      out.get(current).push({ name: tool[1], description: tool[2] || "" });
    }
  }
  return out;
}

/**
 * From the discovered per-instance capability map and the bot's remote
 * selections ([{instanceId, canonicalId}]), produce:
 *   advertised: [{name, description, inputSchema}]  — promoted tools for the model
 *   routeMap:   Map<toolName, {instanceId, canonicalId}> — for executor dispatch
 * First selection wins on a tool-name clash. Schema is permissive on purpose:
 * the description carries intent and crow_tools normalizes params downstream.
 */
export function selectRemoteToolset(parsedByInstance, selections) {
  const advertised = [];
  const routeMap = new Map();
  for (const { instanceId, canonicalId } of selections) {
    const caps = parsedByInstance.get(instanceId);
    if (!caps) continue;
    const tools = caps.get(canonicalId);
    if (!tools) continue;
    for (const t of tools) {
      if (routeMap.has(t.name)) continue;
      routeMap.set(t.name, { instanceId, canonicalId });
      advertised.push({
        name: t.name,
        description: t.description || "",
        inputSchema: { type: "object", properties: {}, additionalProperties: true },
      });
    }
  }
  return { advertised, routeMap };
}

const LISTEN_ID_RE = /\/listen\/([0-9a-fA-F-]+)\//;

/** Rewrite one {url, codec, auth, ...} stream descriptor to the owning
 * instance's /audio/stream proxy. Non-funkwhale-listen urls are left as-is. */
function rewriteStream(s, gatewayUrl, instanceId) {
  if (!s || typeof s.url !== "string") return s;
  const m = s.url.match(LISTEN_ID_RE);
  if (!m) return s;
  const id = m[1];
  const codec = s.codec || (s.url.match(/[?&]to=([^&]+)/)?.[1]) || "mp3";
  const base = String(gatewayUrl).replace(/\/+$/, "");
  return {
    ...s,
    url: `${base}/audio/stream?cap=funkwhale&id=${encodeURIComponent(id)}&codec=${encodeURIComponent(codec)}`,
    auth: `crow-peer:${instanceId}`,
  };
}

/**
 * Rewrite any Funkwhale _audio_stream envelope (head + album queue) inside an
 * MCP tool result so the consuming instance streams the bytes through the
 * owning instance's /audio/stream proxy. Mutates + returns the same result
 * object. No-op for results without a funkwhale audio envelope.
 */
export function rewriteAudioResult(result, gatewayUrl, instanceId) {
  for (const block of result?.content || []) {
    if (block.type !== "text" || typeof block.text !== "string") continue;
    if (!block.text.includes('"_audio_stream"')) continue;
    try {
      const parsed = JSON.parse(block.text);
      const env = parsed._audio_stream;
      if (!env || typeof env.url !== "string") continue;
      const queue = Array.isArray(env.queue) ? env.queue : null;
      const head = rewriteStream(env, gatewayUrl, instanceId);
      if (queue) head.queue = queue.map((q) => rewriteStream(q, gatewayUrl, instanceId));
      parsed._audio_stream = head;
      block.text = JSON.stringify(parsed);
    } catch { /* not JSON — leave untouched */ }
  }
  return result;
}

/**
 * Peer-authed MCP client to a remote instance's /router/mcp. Reuses the same
 * peer bearer token the proxy's federation client uses (peer-credentials.js),
 * so the remote's instanceAuth middleware recognises us and peer-exposure gates
 * the call against the remote's remote_exposed_tools allowlist.
 */
export async function createRemoteRouterClient({ instanceId, gatewayUrl }) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const { getPeerCreds } = await import("../../shared/peer-credentials.js");

  const baseUrl = String(gatewayUrl).replace(/\/+$/, "");
  const url = new URL(`${baseUrl}/router/mcp`);
  const creds = getPeerCreds(instanceId);
  const requestInit = creds?.auth_token
    ? { headers: { Authorization: `Bearer ${creds.auth_token}` } }
    : undefined;

  const transport = new StreamableHTTPClientTransport(url, requestInit ? { requestInit } : undefined);
  const client = new Client({ name: `crow-voice-remote-${instanceId}`, version: "0.1.0" });
  await Promise.race([
    client.connect(transport),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("remote router connect timed out (10s)")), 10_000)),
  ]);
  return client;
}
