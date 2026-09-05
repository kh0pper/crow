import { execFileSync } from "node:child_process";
let _cached; // undefined = not yet probed
export function _resetTailnetIpCache() { _cached = undefined; }
export function getOwnTailnetIp({ env = process.env, execFileSyncImpl = execFileSync, cache = true } = {}) {
  if (env.CROW_TAILNET_IP) return env.CROW_TAILNET_IP;
  if (cache && _cached) return _cached;
  let ip = null;
  try {
    const out = String(execFileSyncImpl("tailscale", ["ip", "-4"], { timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }));
    ip = out.split("\n").map((l) => l.trim()).find((l) => /^\d+\.\d+\.\d+\.\d+$/.test(l)) || null;
  } catch { ip = null; }
  // Only a SUCCESSFUL probe is cached (final review I4). The gateway often
  // starts before tailscaled has an address; caching that `null` would pin
  // every native row registered for the rest of the process lifetime to a
  // loopback door with `local_only: true`, with no way back short of a
  // restart. A failed probe is cheap and simply retried on the next call.
  if (cache && ip) _cached = ip;
  return ip;
}
