/**
 * The campaigns credentials key (CROW_CAMPAIGNS_ENCRYPTION_KEY), read when needed.
 *
 * The MCP server gets it in its own env: the gateway env overlaid by this instance's
 * campaigns entry in mcp-addons.json (proxy.js, which unseals a key the entry lists in
 * `keychainEnv`). The dashboard panel runs in the gateway, so it reads them in that SAME
 * order — the entry first, unsealing the entry's listed keychain names with this process's
 * role — and both always use one key. A generated key reaches only the entry (mode 600).
 * Never logged.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { appImport } from "./app-root.js";

const { AddonKeysUnavailableError, hydrateAddonEntry, processUnsealer } = await appImport("servers/shared/addon-secrets.js");
const { gatewayKeychainPaths } = await appImport("servers/gateway/addon-keys-paths.js");

export function campaignsKey(env = process.env) {
  let entry = null;
  try {
    const file = join(env.CROW_HOME || join(homedir(), ".crow"), "mcp-addons.json");
    entry = JSON.parse(readFileSync(file, "utf8"))?.campaigns ?? null;
  } catch { /* no entry */ }
  let fromEntry = "";
  if (entry && typeof entry === "object") {
    try {
      fromEntry = hydrateAddonEntry("campaigns", entry, { unsealer: processUnsealer(), ...gatewayKeychainPaths() })?.env?.CROW_CAMPAIGNS_ENCRYPTION_KEY || "";
    } catch (err) {
      if (!(err instanceof AddonKeysUnavailableError)) throw err;
      // A listed name has no plain value; the environment override below still applies.
      fromEntry = entry.env?.CROW_CAMPAIGNS_ENCRYPTION_KEY || "";
    }
  }
  return fromEntry || env.CROW_CAMPAIGNS_ENCRYPTION_KEY || "";
}