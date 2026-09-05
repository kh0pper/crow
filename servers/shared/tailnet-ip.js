import { execFileSync } from "node:child_process";
let _cached; // undefined = not yet probed
export function _resetTailnetIpCache() { _cached = undefined; }
export function getOwnTailnetIp({ env = process.env, execFileSyncImpl = execFileSync, cache = true } = {}) {
  if (env.CROW_TAILNET_IP) return env.CROW_TAILNET_IP;
  if (cache && _cached !== undefined) return _cached;
  let ip = null;
  try {
    const out = String(execFileSyncImpl("tailscale", ["ip", "-4"], { timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }));
    ip = out.split("\n").map((l) => l.trim()).find((l) => /^\d+\.\d+\.\d+\.\d+$/.test(l)) || null;
  } catch { ip = null; }
  if (cache) _cached = ip;
  return ip;
}
