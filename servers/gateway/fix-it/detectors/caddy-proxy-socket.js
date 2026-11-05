/**
 * Fix-it detector: this machine's Caddy still dials the gateway over loopback.
 *
 * The installer used to write `reverse_proxy localhost:3001`, so every visitor
 * through Caddy arrived as a loopback socket carrying X-Forwarded-For — a shape
 * classifyPeer must call `unverified` (any local process can write the same
 * header), so the dashboard's network gate turned the owner away right after
 * first-run setup (the security audit's finding N1a-3/N1a-4).
 *
 * The fix is the dedicated proxy socket (servers/gateway/proxy-socket.js),
 * owned by a systemd socket unit: only the local Caddy can open it, and the
 * gateway receives its listening fd by socket activation. The gateway is not
 * root, so it cannot rewrite /etc/caddy/Caddyfile or install the unit itself —
 * the card carries the command to run instead.
 *
 * No event fires for a config file, so this is a BOOT check: fix-it/index.js's
 * runBootChecks() calls `check()` once per gateway start. The problem test is
 * pure and takes the Caddyfile and socket-unit paths (plus the file readers),
 * so tests use fixtures.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CADDYFILE = "/etc/caddy/Caddyfile";
/** The systemd socket unit that owns the socket (root:caddy 0660). */
export const SOCKET_UNIT = "/etc/systemd/system/crow-gateway-proxy.socket";
/** Where that unit listens. The gateway only ever sees the fd. */
export const SOCKET_PATH = "/run/crow-proxy/gateway.sock";
export const DEDUP_KEY = "caddy:loopback-reverse-proxy";

/**
 * The loopback dial the installer used to write.
 *
 * `(?:[^A-Za-z0-9.:]|$)` — not a word character — keeps `:30010` and
 * `:3001.5` out, and matches exactly the shapes the fix script rewrites: the
 * end of the line, a trailing ` {`, or a trailing comment. The detector's grep
 * and the script's sed/re-grep use the same shape on purpose.
 */
const LOOPBACK_PROXY_LINE = /^[ \t]*reverse_proxy[ \t]+(?:localhost|127\.0\.0\.1):3001(?:[^A-Za-z0-9.:]|$)/m;

/** The app checkout this gateway runs from (the fix script lives in it). */
export function appRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
}

/**
 * → the card's text when a readable Caddyfile still dials the gateway over
 * loopback AND the socket unit is not installed; null otherwise (no Caddy here,
 * a socket-based Caddyfile, or systemd already owns the socket).
 *
 * `caddyfile`, `socketUnit`, `app`, `readFile` and `exists` are for tests.
 */
export function caddyProxySocketProblem({
  caddyfile = CADDYFILE,
  socketUnit = SOCKET_UNIT,
  app = appRoot(),
  readFile = readFileSync,
  exists = existsSync,
} = {}) {
  let text;
  try { text = String(readFile(caddyfile, "utf8")); } catch { return null; } // no Caddy, or not readable
  if (!LOOPBACK_PROXY_LINE.test(text)) return null;
  // Decided on the Caddyfile alone (review): while Caddy still dials loopback the
  // owner is locked out, whether or not the socket unit file exists.
  void socketUnit; void exists;

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
  /**
   * Upsert the card when the problem is present, RESOLVE it when the problem is
   * gone (the fix script ran, or the Caddyfile was edited by hand) so the Nest
   * stops asking. Never throws into boot.
   */
  async check(store, opts = {}) {
    const problem = caddyProxySocketProblem(opts);
    if (!problem) {
      try { await store.resolveByKey("caddy-proxy-socket", DEDUP_KEY); } catch { /* no row yet, or no store */ }
      return null;
    }
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