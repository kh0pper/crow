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
