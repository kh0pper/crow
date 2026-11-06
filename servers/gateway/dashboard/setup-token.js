/**
 * First-run setup token — the one-time code that proves its holder was sent the
 * setup link.
 *
 * On a fresh install no dashboard password exists, and the gateway listens on
 * 0.0.0.0 while isAllowedNetwork (auth.js) trusts any private-LAN source. So
 * "the first request that sets the password wins" means whoever reaches the
 * box first on the same Wi-Fi owns it. The token closes that window: while no
 * password is set, every first-run path (GET /dashboard/login, POST
 * /dashboard/login, GET /setup) demands the token unless the request is direct
 * loopback BY A LOOPBACK NAME (isDirectLoopback and isLoopbackHost, beside).
 *
 * Where the token comes from:
 *   - CROW_SETUP_TOKEN, when set: today's hosted behaviour, unchanged. No file
 *     is read or written.
 *   - otherwise <CROW_HOME>/setup-token: created on first use (32 random bytes,
 *     base64url, mode 0600 — only this machine's user can read it), removed the
 *     moment the first password is set.
 *
 * The file is read back after being created, so every process on the box
 * (installer, gateway, a second boot) ends up agreeing with what is on disk.
 * Creation is first-writer-wins (link(2), which cannot replace an existing
 * file), so two processes racing to mint a token cannot end up disagreeing,
 * and boot never mints a token once a password exists (a request that raced the first
 * password may recreate the file; harmless, since the gate is unused once a password exists).
 *
 * Node built-ins only.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveCrowHome } from "../../shared/crow-home.js";
import { isLocalPeer } from "../../shared/peer-class.js";
import { isLoopbackHost } from "./same-origin.js";

export const SETUP_TOKEN_FILENAME = "setup-token";

/** <CROW_HOME>/setup-token for the given (or this process's) home. */
export function setupTokenPath({ crowHome = resolveCrowHome() } = {}) {
  return join(crowHome, SETUP_TOKEN_FILENAME);
}

/**
 * The setup token for this instance.
 *
 * `hasPassword` is the caller's knowledge that a dashboard password already
 * exists (auth.js isPasswordSet()). It is only consulted before CREATING the
 * file: a set password means the one-time token has done its job, so a later
 * call must not mint a fresh file the login page would then advertise.
 *
 * @param {{ crowHome?: string, hasPassword?: boolean }} [opts]
 * @returns {{ token: string, source: "env"|"file", path: string|null }}
 *   `path` is null for the env token (no file is involved).
 */
export function getSetupToken({ crowHome = resolveCrowHome(), hasPassword = false } = {}) {
  const envToken = process.env.CROW_SETUP_TOKEN;
  if (envToken) return { token: envToken, source: "env", path: null };

  const file = setupTokenPath({ crowHome });
  const existing = readTokenFile(file);
  if (existing) return { token: existing, source: "file", path: file };
  // No password-free instance any more: never recreate the file.
  if (hasPassword) return { token: "", source: "file", path: file };

  // Create it: temp file in the same directory (0600 from the start, so the
  // token is never readable by anyone else, not even for an instant), then
  // link(2) into place — create-if-absent, and a reader never sees a
  // half-written token.
  mkdirSync(crowHome, { recursive: true, mode: 0o700 });
  const tmp = join(crowHome, `.${SETUP_TOKEN_FILENAME}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, `${randomBytes(32).toString("base64url")}\n`, { mode: 0o600, flag: "wx" });
    try { chmodSync(tmp, 0o600); } catch { /* mode already set at open */ }
    // The FIRST writer wins: link() refuses to replace an existing file
    // (EEXIST), where rename() would have overwritten it and left each process
    // holding a different token.
    try {
      linkSync(tmp, file);
    } catch (err) {
      if (err.code === "EEXIST") {
        /* another writer won: read theirs back below */
      } else if (["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"].includes(err.code)) {
        // A filesystem without hard links (some network or FUSE mounts):
        // create-if-absent directly, still 0600 and still first-writer-wins.
        try {
          writeFileSync(file, readFileSync(tmp, "utf8"), { mode: 0o600, flag: "wx" });
        } catch (e2) {
          if (e2.code !== "EEXIST") throw e2;
        }
      } else {
        throw err;
      }
    }
  } catch {
    /* read-back below is the source of truth */
  } finally {
    try { unlinkSync(tmp); } catch { /* already linked or never written */ }
  }
  // Read back: whatever ended up on disk is what this caller returns, so the
  // installer, the gateway and the login page all name one token even when two
  // boots raced to create the file.
  return { token: readTokenFile(file) || "", source: "file", path: file };
}

function readTokenFile(file) {
  try {
    return readFileSync(file, "utf8").trim() || null;
  } catch {
    return null;
  }
}

/**
 * Constant-time comparison, false for anything that is not a non-empty string
 * of the same length (timingSafeEqual throws on unequal lengths).
 */
export function tokenMatches(candidate, token) {
  if (typeof candidate !== "string" || typeof token !== "string") return false;
  if (!candidate || !token) return false;
  const a = Buffer.from(candidate, "utf8");
  const b = Buffer.from(token, "utf8");
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Delete the token file once the first password exists. A missing file is the
 * normal case (env token, or a second call) and is ignored.
 */
export function clearSetupToken({ crowHome = resolveCrowHome() } = {}) {
  try {
    unlinkSync(setupTokenPath({ crowHome }));
    return true;
  } catch {
    return false;
  }
}

/**
 * True only for a request straight off this machine's loopback socket.
 *
 * Delegates to isLocalPeer (servers/shared/peer-class.js), the one rule the
 * codebase already uses for "this is a bare same-box caller": a loopback socket
 * carrying no forwarding header (x-forwarded-for, x-real-ip, forwarded,
 * x-forwarded-host, x-forwarded-proto), no tailscale-* header (so Serve and
 * Funnel shapes — which arrive on loopback WITH those headers — are not
 * direct), and not a loopback address listed in CROW_TRUSTED_PROXIES (a
 * same-box reverse proxy relaying anyone). So the owner on the machine itself,
 * or through an SSH tunnel to 127.0.0.1, is exempt; a proxied visitor is not.
 *
 * Necessary but not sufficient: a DNS-rebinding page posts from a loopback
 * socket with no forwarding header too, so allowFirstRun() also asks
 * isLoopbackHost (same-origin.js) — the Host has to name this machine.
 */
export function isDirectLoopback(req) {
  return isLocalPeer(req?.socket?.remoteAddress, req?.headers || {});
}

/**
 * The first-run gate for one request. Only ever consulted while no password is
 * set — it guards the FIRST password, never a login or a reset.
 *
 * CROW_SETUP_TOKEN (hosted) has no exemption: the env token is required from
 * every source, this machine included, exactly as before the file existed.
 *
 * The loopback exemption needs BOTH halves: a loopback socket carrying no
 * forwarding header (isDirectLoopback) AND a Host that can only be this machine
 * or a configured own origin (isLoopbackHost, same-origin.js). The second half
 * is what stops a DNS-rebinding page: it posts from a loopback socket with no
 * forwarding header, but its Host is the attacker's domain re-pointed at
 * 127.0.0.1, so it falls through to the token below — and, with no token, is
 * refused exactly as a LAN peer is.
 *
 * @param {object} req Express request (`req.query` for a GET, `req.body` for a POST)
 * @param {{ crowHome?: string, from?: "body"|"query", hasPassword?: boolean, env?: object }} [opts]
 *   `env` is the environment the configured own origin is read from (tests)
 * @returns {{ allowed: boolean, token: string|null }}
 *   `token` is the matched token when the request carried one (so the page can
 *   pass it on in the form), null on the direct-loopback exemption.
 */
export function allowFirstRun(req, { crowHome = resolveCrowHome(), from = "body", hasPassword = false, env = process.env } = {}) {
  if (!process.env.CROW_SETUP_TOKEN && isDirectLoopback(req) && isLoopbackHost(req, { env })) return { allowed: true, token: null };
  const { token } = getSetupToken({ crowHome, hasPassword });
  const candidate = from === "query" ? req?.query?.token : req?.body?.setup_token;
  return tokenMatches(candidate, token) ? { allowed: true, token } : { allowed: false, token: null };
}

/**
 * Gateway boot: with no password set, make sure the token file exists and say
 * where it is — the FILE PATH only, never the token (the log is readable by
 * more than the owner). One line, and nothing at all once a password exists or
 * the token comes from CROW_SETUP_TOKEN.
 *
 * @param {{ crowHome?: string, passwordSet?: boolean, log?: Function }} [opts]
 * @returns {string|null} the logged line, or null when nothing was logged.
 */
export function announceSetupToken({ crowHome = resolveCrowHome(), passwordSet = false, log = console.log } = {}) {
  if (passwordSet) return null;
  if (process.env.CROW_SETUP_TOKEN) return null;
  let path;
  let token = "";
  try {
    ({ path, token } = getSetupToken({ crowHome }));
  } catch {
    return null;
  }
  if (!path) return null;
  const line = token
    ? `[setup] No dashboard password yet. Open the setup link from ${path} (only this machine's user can read it).`
    : `[setup] No dashboard password yet, and the setup token could not be written to ${path}. First-run setup works only from this machine (http://localhost:3001/setup) until the file can be created.`;
  log(line);
  return line;
}

/**
 * The gateway's boot call (servers/gateway/index.js), as one seam: read the
 * password state, then announce the token path. auth.js is imported lazily so
 * this module stays loadable without a database. A password state that cannot
 * be read counts as "a password exists": no file is minted on a guess.
 *
 * @param {{ crowHome?: string, isPasswordSet?: () => (boolean|Promise<boolean>), log?: Function }} [opts]
 * @returns {Promise<string|null>} the logged line, or null when nothing was logged.
 */
export async function bootSetupToken({ crowHome = resolveCrowHome(), isPasswordSet, log = console.log } = {}) {
  let hasPassword = true;
  try {
    hasPassword = isPasswordSet
      ? await isPasswordSet()
      : await (await import("./auth.js")).isPasswordSet();
  } catch {
    return null;
  }
  return announceSetupToken({ crowHome, passwordSet: !!hasPassword, log });
}