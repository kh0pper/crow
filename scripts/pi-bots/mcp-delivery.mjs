/**
 * How a bot's MCP config reaches pi (S6-CROW).
 *
 * The per-bot config carries signed actor headers (actor-sig.mjs). Written as
 * `<world>/.mcp.json` (or `/tmp/pibot-job-*`/.mcp.json) any other bot that can
 * read the file can replay them. pi-lab >= c8bbb02 accepts the config over an
 * inherited fd instead (`PI_BOT_MCP_CONFIG_FD=<n>`, n > 2, read once to EOF):
 *
 *   "fd"   — the bridge pipes the JSON on fd MCP_CONFIG_FD and closes its end;
 *            nothing is written, and a stale `.mcp.json` from an earlier
 *            file-mode turn is removed.
 *   "file" — the pre-S6 behaviour: `<world>/.mcp.json` + PI_BOT_MCP_CONFIG.
 *
 * Operator switch: PIBOT_MCP_CONFIG_DELIVERY = fd | file | auto (default auto).
 * auto = fd when the pi-lab that pi loads is >= MIN_PI_LAB_REV, else file — an
 * older pi-lab ignores the fd and would run the bot with no MCP servers, so
 * the fallback keeps it working (and the boot warning says why).
 */
import { piLabCompat, warnIfPiLabIncompatible } from "./pi-lab-compat.mjs";

/** The child fd the config is piped on (0-2 are stdio, 3 is the sandbox's --info-fd). */
export const MCP_CONFIG_FD = 4;

/**
 * @param {{env?: object, compat?: () => {ok: boolean}}} [opts]
 * @returns {"fd"|"file"}
 */
export function mcpConfigDelivery({ env = process.env, compat = piLabCompat } = {}) {
  const v = String(env.PIBOT_MCP_CONFIG_DELIVERY || "auto").trim().toLowerCase();
  if (v === "file") return "file";
  if (v === "fd") {
    // Forced fd on a pi-lab that cannot read it leaves the bot with no MCP
    // servers (PiRpc keeps PI_BOT_MCP_CONFIG pinned, so never the cwd walk).
    if (compat === piLabCompat) warnIfPiLabIncompatible(undefined, { onlyProblems: true });
    return "fd";
  }
  let ok = false;
  // The real check also logs the pi-lab WARNING (once per process per
  // result) when it fails, so every process that spawns bots (gateway,
  // pibot-gateways, the minute gmail tick, discord child) says why it fell
  // back to the file. A passing check stays silent here (boot logs it).
  const check = compat === piLabCompat ? () => warnIfPiLabIncompatible(undefined, { onlyProblems: true }) : compat;
  try { ok = !!(check() || {}).ok; } catch { ok = false; }
  return ok ? "fd" : "file";
}
