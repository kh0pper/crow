/**
 * Fix-it detector: this machine's Caddy still dials the gateway over loopback.
 *
 * The installer used to write `reverse_proxy localhost:3001`, so every visitor
 * through Caddy arrived as a loopback socket carrying X-Forwarded-For — a shape
 * classifyPeer must call `unverified` (any local process can write the same
 * header), so the dashboard's network gate turned the owner away right after
 * first-run setup (the security audit's finding N1a-3/N1a-4).
 *
 * The fix is the dedicated proxy socket (servers/gateway/proxy-socket.js):
 * Caddy dials the unix socket and its visitors classify as `proxy`. The
 * gateway is not root, so it cannot rewrite /etc/caddy/Caddyfile or add the
 * unit lines itself — the card carries the command to run instead.
 *
 * No event fires for a config file, so this is a BOOT check: fix-it/index.js's
 * runBootChecks() calls `check()` once per gateway start. `caddyProxySocketProblem`
 * is pure and takes the Caddyfile path, so tests use fixtures.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CADDYFILE = "/etc/caddy/Caddyfile";
export const SOCKET_PATH = "/run/crow/gateway.sock";
export const DEDUP_KEY = "caddy:loopback-reverse-proxy";

/** The loopback dial the installer used to write. */
const LOOPBACK_PROXY_LINE = /^[ \t]*reverse_proxy[ \t]+(?:localhost|127\.0\.0\.1):3001\b/m;

/** The app checkout this gateway runs from (the fix script lives in it). */
export function appRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
}

/**
 * → the card's text when a readable Caddyfile still dials the gateway over
 * loopback and CROW_PROXY_SOCKET is unset; null otherwise (no Caddy here, a
 * socket-based Caddyfile, or the gateway already has its proxy socket).
 *
 * `caddyfile`, `env`, `app` and `readFile` are for tests.
 */
export function caddyProxySocketProblem({ caddyfile = CADDYFILE, env = process.env, app = appRoot(), readFile = readFileSync } = {}) {
  // Already fixed (or the operator opted out): nothing to say.
  if (String(env.CROW_PROXY_SOCKET || "").trim()) return null;
  let text;
  try { text = String(readFile(caddyfile, "utf8")); } catch { return null; } // no Caddy, or not readable
  if (!LOOPBACK_PROXY_LINE.test(text)) return null;

  const fixCommand = `sudo bash ${resolve(app, "scripts", "fix-caddy-proxy-socket.sh")}`;
  return {
    title: "Visitors coming in through this machine's Caddy are being turned away",
    why: "Caddy still hands them to the gateway over a loopback connection with its own forwarding header, which Crow cannot tell apart from any other program on this machine — so Crow's Nest refuses them. "
      + "Pointing Caddy at the gateway's own proxy socket fixes it. Crow does not run as root, so run this once on the server: " + fixCommand,
    fixCommand,
    context: { caddyfile, fixCommand },
  };
}

export default {
  source: "caddy-proxy-socket",
  // A config file emits no event: runBootChecks() calls check() at gateway start.
  events: [],
  async onEvent() {},
  /** Upsert the card when the problem is present. Never throws into boot. */
  async check(store, opts = {}) {
    const problem = caddyProxySocketProblem(opts);
    if (!problem) return null;
    await store.upsertItem({
      source: "caddy-proxy-socket",
      dedupKey: DEDUP_KEY,
      title: problem.title,
      why: problem.why,
      severity: "warn",
      remedies: [], // not one-click: the gateway cannot write /etc as root
      context: problem.context,
    });
    return problem;
  },
};