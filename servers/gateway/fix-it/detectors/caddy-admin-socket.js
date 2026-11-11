/**
 * Fix-it detector: this machine's Caddy admin API is still Caddy's default.
 *
 * The installer writes `admin unix//run/caddy/admin.sock` into the Caddyfile,
 * so only the caddy service user (and root) can reach it. A Caddyfile without
 * any admin option — every install from before that change — leaves Caddy's
 * admin API on http://localhost:2019 with no authentication: any local account,
 * including a default-tier bot, can POST /load there and rewrite the HTTPS front
 * door Caddy serves for Crow. That would undo the dedicated proxy socket's
 * premise, since a bot that can rewrite the front door no longer needs to forge
 * a proxy peer.
 *
 * The fix is a unix-socket admin endpoint plus a systemd drop-in that gives
 * Caddy the /run/caddy directory it cannot create itself. The gateway is not
 * root, so it cannot write /etc/caddy/Caddyfile or the drop-in — the card
 * carries the command to run instead.
 *
 * An admin line the owner wrote (a TCP address, another socket, `admin off`) is
 * their own choice and never gets a card.
 *
 * No event fires for a config file, so this is a BOOT check: fix-it/index.js's
 * runBootChecks() calls `check()` once per gateway start. The problem test is
 * pure and takes the Caddyfile path and the file reader, so tests use fixtures —
 * and it is decided from the file text alone: nothing here opens a socket.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CADDYFILE = "/etc/caddy/Caddyfile";
export const DEDUP_KEY = "caddy:admin-open";

/**
 * The gateway upstream lines the installer writes / used to write.
 *
 * `(?:[^A-Za-z0-9.:]|$)` — not a word character — keeps `:30010` and `:3001.5`
 * out. Same shapes as fix-caddy-proxy-socket.sh and its detector, so the three
 * cannot disagree about what "Crow's Caddyfile" means.
 */
const UNIX_PROXY_LINE = /^[ \t]*reverse_proxy[ \t]+unix\/\/run\/crow-proxy\/gateway\.sock(?:[^A-Za-z0-9.:]|$)/m;
const LOOPBACK_PROXY_LINE = /^[ \t]*reverse_proxy[ \t]+(?:localhost|127\.0\.0\.1):3001(?:[^A-Za-z0-9.:]|$)/m;

/**
 * An `admin` global option: its line's first token is `admin`. A comment that
 * mentions the word (`#admin …`) and a directive that merely contains it
 * (`respond "admin …" 200`) are not options and never count.
 */
const ADMIN_OPTION_LINE = /^[ \t]*admin(?:[ \t]|$)/m;

/** The app checkout this gateway runs from (the fix script lives in it). */
export function appRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
}

/**
 * → the card's text when a readable Crow Caddyfile has no `admin` option (so
 * Caddy's admin API is its unauthenticated localhost default); null otherwise
 * (no Caddy here, not Crow's Caddyfile, or the owner already chose an admin
 * address).
 *
 * `caddyfile`, `app` and `readFile` are for tests.
 */
export function caddyAdminProblem({ caddyfile = CADDYFILE, app = appRoot(), readFile = readFileSync } = {}) {
  let text;
  try { text = String(readFile(caddyfile, "utf8")); } catch { return null; } // no Caddy, or not readable
  // Only a Caddyfile that fronts Crow is ours to speak about.
  if (!UNIX_PROXY_LINE.test(text) && !LOOPBACK_PROXY_LINE.test(text)) return null;
  // Any admin option is the owner's own decision — `off`, a socket, or an address.
  if (ADMIN_OPTION_LINE.test(text)) return null;

  const fixCommand = `sudo bash ${resolve(app, "scripts", "fix-caddy-admin-socket.sh")}`;
  return {
    title: "This machine's Caddy admin API is open to any program on it",
    why: "Caddy's admin API is on its default local address with no authentication, so any program or bot on this machine can rewrite the Caddy that fronts Crow. "
      + "One command moves it onto a unix socket only Caddy's own service user can open. Crow does not run as root, so run this once on the server: " + fixCommand,
    fixCommand,
    context: { caddyfile, fixCommand },
  };
}

export default {
  source: "caddy-admin-socket",
  // A config file emits no event: runBootChecks() calls check() at gateway start.
  events: [],
  async onEvent() {},
  /**
   * Upsert the card when the problem is present, RESOLVE it when the problem is
   * gone (the fix script ran, or the Caddyfile was edited by hand) so the Nest
   * stops asking. Never throws into boot.
   */
  async check(store, opts = {}) {
    const problem = caddyAdminProblem(opts);
    if (!problem) {
      try { await store.resolveByKey("caddy-admin-socket", DEDUP_KEY); } catch { /* no row yet, or no store */ }
      return null;
    }
    await store.upsertItem({
      source: "caddy-admin-socket",
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