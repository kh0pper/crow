/**
 * The campaigns credentials key (CROW_CAMPAIGNS_ENCRYPTION_KEY), read when needed.
 *
 * The MCP server gets it in its own env: the gateway env overlaid by this instance's
 * campaigns entry in mcp-addons.json (proxy.js). The dashboard panel runs in the gateway,
 * so it reads them in that SAME order — the entry first — and both always use one key. A
 * generated key reaches only the entry (mode 600). Never logged.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export function campaignsKey(env = process.env) {
  let fromEntry = "";
  try {
    const file = join(env.CROW_HOME || join(homedir(), ".crow"), "mcp-addons.json");
    fromEntry = JSON.parse(readFileSync(file, "utf8"))?.campaigns?.env?.CROW_CAMPAIGNS_ENCRYPTION_KEY || "";
  } catch { /* no entry */ }
  return fromEntry || env.CROW_CAMPAIGNS_ENCRYPTION_KEY || "";
}
