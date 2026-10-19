/**
 * What a pi bot's model actually gets offered, computed offline: a MIRROR of
 * two upstream rules, kept tiny so a drift is easy to see.
 *
 * 1. pi-lab extensions/mcp-client.ts registers, per healthy server in the
 *    merged .mcp.json:
 *      - router mode (`"router": true` on the block): ONE gateway tool
 *        `mcp__<server>` (registerRouterTool);
 *      - otherwise one tool per server tool, `mcp__<server>__<tool>`
 *        (registerDirectTools).
 * 2. pi's `--tools` csv is split on commas and each registered tool is kept
 *    only on an EXACT name match (pi 0.85.1 dist/cli/args.js splits,
 *    dist/core/agent-session.js filters with Set.has).
 *
 * The live counterpart, which runs the real pi + pi-lab when both are present,
 * is tests/remote-tools-reach-pi.test.js. Re-check this mirror against it after
 * a pi or pi-lab upgrade.
 */

/**
 * @param {Record<string, object>} blocks  mcpServers entries (name -> block)
 * @param {Record<string, string[]>} toolsByServer  server name -> its tool names
 * @returns {string[]} the tool names pi-lab registers
 */
export function piLabRegisteredNames(blocks, toolsByServer) {
  const out = [];
  for (const [server, block] of Object.entries(blocks || {})) {
    if (block && block.router === true) out.push(`mcp__${server}`);
    else for (const t of toolsByServer[server] || []) out.push(`mcp__${server}__${t}`);
  }
  return out;
}

/** The registered tools pi keeps for a `--tools` csv (exact match). */
export function piOfferedTools(csv, registered) {
  const allow = new Set(String(csv || "").split(",").map((s) => s.trim()).filter(Boolean));
  return registered.filter((n) => allow.has(n));
}
