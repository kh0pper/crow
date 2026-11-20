/**
 * Dashboard Authentication
 *
 * Password-based auth with session cookies.
 * - Password hashed with crypto.scrypt (async)
 * - Session tokens stored in oauth_tokens table (reuses existing infra)
 * - CSRF: the server-bound token of shared/csrf.js (HMAC of the session id);
 *   there is no CSRF cookie any more — a cookie could be tossed by any host on
 *   the tailnet, since `ts.net` is a public suffix and every
 *   `<x>.<tailnet>.ts.net` is the same SITE as the dashboard
 * - Account lockout: 5 failed attempts → 15 min lock
 *
 * Known residual (F3): the plain → `__Host-` migration below has no
 * per-session "already migrated" marker in this release, so its door stays open
 * for as long as a browser presents a plain `crow_session`. An attacker who can
 * evict a victim's `__Host-` cookie (cookie-jar overflow) AND toss a valid
 * plain session for an account of their own can get that session migrated:
 * session fixation into the attacker's account (multi-user instances only).
 * Closing it needs a per-session flag on the session row — a schema change,
 * tracked separately and deliberately NOT in this change.
 */

import { scrypt, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { createDbClient, auditLog } from "../../db.js";
import { is2faEnabled, verifyDeviceTrust, createPending2faToken } from "./totp.js";
import { forwardedAddrs, classifyPeer, isOverlayAddr, normalizeAddr } from "../../shared/peer-class.js";
import { peerTrust } from "../../shared/peer-trust.js";
import { SUPPORTED_LANGS, t } from "./shared/i18n.js";
import { escapeHtml } from "./shared/components.js";
import { withWriteContext, ownerWriteContext, peerWriteContext } from "../../shared/history/write-context.js";
// The same "this is a bare same-box caller" rule the first-run gate uses
// (peer-class.js's isLocalPeer: a loopback socket carrying no forwarding header
// and no tailscale-* header). setup-token.js imports auth.js only lazily, so
// this is not an import cycle.
import { isDirectLoopback } from "./setup-token.js";
// The names of the two cookies this file sets live with every other Crow cookie
// name (../cookie-names.js), because the extension proxy strips the whole list
// before forwarding a request to a bundle's backend (queue item #51).
import { SESSION_COOKIE, HOST_SESSION_COOKIE } from "../cookie-names.js";

export function hashToken(t) { return createHash('sha256').update(t).digest('hex'); }

const isHosted = !!process.env.CROW_HOSTED;
const SESSION_MAX_AGE = isHosted ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
// SSO-granted sessions are deliberately short-lived (24h) regardless of host
// mode: a session authorized transitively (by being logged into another
// instance) should not become a week-long standing credential.
export const SSO_SESSION_MAX_AGE = 24 * 60 * 60 * 1000;
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_DURATION = 15 * 60 * 1000; // 15 min

/**
 * Validate password strength (for set/change only, not login).
 * @returns {{ valid: boolean, message: string, strength: string }}
 */
export function validatePasswordStrength(password) {
  if (!password || password.length < 12) {
    return { valid: false, message: "Password must be at least 12 characters.", strength: "weak" };
  }
  if (password.length < 16) {
    return { valid: true, message: "Fair password.", strength: "fair" };
  }
  return { valid: true, message: "Strong password.", strength: "strong" };
}

/**
 * Hash a password with scrypt.
 */
function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = randomBytes(16).toString("hex");
    scrypt(password, salt, 64, (err, key) => {
      if (err) reject(err);
      else resolve(`${salt}:${key.toString("hex")}`);
    });
  });
}

/**
 * Verify a password against a hash.
 */
export function verifyPassword(password, stored) {
  return new Promise((resolve, reject) => {
    const [salt, hash] = stored.split(":");
    scrypt(password, salt, 64, (err, key) => {
      if (err) reject(err);
      else resolve(timingSafeEqual(Buffer.from(hash, "hex"), key));
    });
  });
}

/**
 * Parse a request's Cookie header into `{ cookies, duplicates }`.
 *
 * `duplicates` names every cookie that appeared MORE THAN ONCE. Cookie tossing
 * (a sibling host on the tailnet sets its own `Domain=<tailnet>.ts.net` copy of
 * a cookie the dashboard also sets) produces exactly that shape: the browser
 * sends both values under one name. It is never a value a browser meant to
 * send, so the session reader refuses a `__Host-`-less request outright (see
 * sessionFromCookies) instead of letting the last one win.
 *
 * A tossed PLAIN `crow_session` cannot decide anything while the request also
 * carries `__Host-crow_session`: that name is host-only and Secure, so no
 * sibling can set it, let alone duplicate it — the plain copies are then just
 * noise the reader ignores (see sessionFromCookies).
 */
function parseCookieJar(req) {
  const header = req.headers.cookie || "";
  const cookies = {};
  const duplicates = new Set();
  for (const pair of header.split(";")) {
    const [name, ...rest] = pair.trim().split("=");
    if (!name) continue;
    if (Object.prototype.hasOwnProperty.call(cookies, name)) duplicates.add(name);
    cookies[name] = rest.join("=");
  }
  return { cookies, duplicates };
}

/**
 * Parse cookies from request. Duplicate names are resolved last-wins for
 * ordinary lookups (a language cookie, say); the session reader must use
 * parseCookieJar's `duplicates` instead — see sessionFromCookies.
 */
function parseCookies(req) {
  return parseCookieJar(req).cookies;
}

/**
 * Did this request arrive over TLS?
 *
 * `req.secure` is authoritative for an Express request: Express derives it from
 * `trust proxy` (CROW_TRUSTED_PROXIES) only, and resolveClientMiddleware
 * (servers/shared/peer-class.js) sets it for a verified Tailscale Serve hop and
 * the installer's Caddy proxy socket, which is where an `X-Forwarded-Proto`
 * belongs to. A raw upgrade request has no Express getters, so it falls back to
 * the socket being encrypted — or, behind Serve, the proto that hop stamped.
 *
 * The point of knowing: over TLS the session cookie is `__Host-crow_session`
 * (host-only, Secure), and only that name is read; plain HTTP keeps
 * `crow_session`.
 *
 * The X-Forwarded-Proto fallback is for a raw request that never passed
 * through Express (a WebSocket upgrade), so it has no `req.secure`. It trusts
 * the header only when classifyPeer() says a DECLARED proxy or a verified
 * Serve/proxy-socket hop sent it (servers/shared/peer-class.js); an undeclared
 * loopback caller — or any other unverified peer — cannot claim HTTPS by
 * writing the header itself.
 *
 * @param {object} [req] Express request or raw IncomingMessage
 * @returns {boolean}
 */
export function requestIsSecure(req) {
  if (!req) return false;
  if (typeof req.secure === "boolean") return req.secure;
  const sock = req.socket || req.connection;
  if (sock && sock.encrypted === true) return true;
  const proto = String((req.headers && req.headers["x-forwarded-proto"]) || "")
    .split(",")[0].trim().toLowerCase();
  if (proto !== "https") return false;
  try {
    const via = classifyPeer(req).via;
    return via === "serve" || via === "proxy" || via === "funnel";
  } catch {
    return false;
  }
}

/**
 * The session token this request carries, or null.
 *
 * Over HTTPS the deciding name is `__Host-crow_session`: host-only (no
 * `Domain=`), Secure, Path=/, so a sibling host on the same SITE (`ts.net` is a
 * public suffix, so `<x>.<tailnet>.ts.net` is same-site with the dashboard)
 * cannot set, overwrite — or DUPLICATE — it. Whenever it is present the request
 * is read from it and ONLY it: every plain `crow_session` in the jar is ignored,
 * however many copies a sibling tossed in. Refusing on a duplicated PLAIN name
 * there was the bug this rule replaces: `__Host-crow_session=<owner>;
 * crow_session=a; crow_session=b` (`Domain=<tailnet>.ts.net`, two Paths) is
 * exactly the shape a sibling can arrange, and refusing it locked the owner out
 * permanently. A duplicated `__Host-` name is still refused — nothing off this
 * origin can produce one.
 *
 * Plain HTTP keeps `crow_session` (a LAN box on bare HTTP has no Secure cookie
 * at all); there a duplicated plain name is refused, because that is the only
 * session name such a request can carry.
 *
 * Migration: a browser still holding ONLY the old plain cookie on an HTTPS
 * request is migrated — `migrate` says so, and dashboardAuth re-issues it as
 * `__Host-` (keeping the session's own remaining lifetime) and expires the
 * plain name. There is no per-session "already migrated" marker in this
 * release (that is a schema change, tracked separately — see the header's
 * known residual), so the door is open whenever a plain value is presented.
 *
 * @param {object} req
 * @returns {{ token: string|null, migrate: boolean }}
 */
export function sessionFromCookies(req) {
  const { cookies, duplicates } = parseCookieJar(req);
  if (!requestIsSecure(req)) {
    if (duplicates.has(SESSION_COOKIE)) return { token: null, migrate: false };
    return { token: cookies[SESSION_COOKIE] || null, migrate: false };
  }
  if (duplicates.has(HOST_SESSION_COOKIE)) return { token: null, migrate: false };
  if (cookies[HOST_SESSION_COOKIE]) return { token: cookies[HOST_SESSION_COOKIE], migrate: false };
  // No `__Host-` cookie: only a lone plain value may migrate. Duplicates here
  // are the tossing shape with nothing trustworthy to prefer.
  if (duplicates.has(SESSION_COOKIE)) return { token: null, migrate: false };
  if (cookies[SESSION_COOKIE]) return { token: cookies[SESSION_COOKIE], migrate: true };
  return { token: null, migrate: false };
}

/** The session token this request carries (see sessionFromCookies), or null. */
export function sessionTokenFromRequest(req) {
  return sessionFromCookies(req).token;
}

/**
 * Check if a password has been set.
 */
export async function isPasswordSet() {
  const db = createDbClient();
  try {
    const result = await db.execute({
      sql: "SELECT value FROM dashboard_settings WHERE key = 'password_hash'",
      args: [],
    });
    return result.rows.length > 0;
  } finally {
    db.close();
  }
}

/**
 * Set the dashboard password.
 *
 * `opts.keepSession` is the session doing the change (the Settings → Security
 * form): every OTHER dashboard session is revoked with it, so a password change
 * signs out every other device. Without a keepSession (the first-run setup and
 * the forgot-password reset) every dashboard session goes. This is also the
 * prerequisite for the apps origin's revocation (a password change revokes the
 * apps sessions bound to the dashboard sessions it deleted).
 */
export async function setPassword(password, { keepSession = null } = {}) {
  const hash = await hashPassword(password);
  const db = createDbClient();
  try {
    await db.execute({
      sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('password_hash', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')",
      args: [hash, hash],
    });
    let revoked = 0;
    try {
      const res = keepSession
        ? await db.execute({ sql: "DELETE FROM oauth_tokens WHERE client_id = 'dashboard' AND token <> ?", args: [hashToken(keepSession)] })
        : await db.execute({ sql: "DELETE FROM oauth_tokens WHERE client_id = 'dashboard'", args: [] });
      revoked = Number(res?.rowsAffected ?? 0) || 0;
    } catch (err) {
      console.warn("[auth] could not revoke the other sessions after the password change:", err.message);
    }
    await auditLog(db, 'password_changed', { details: { sessions_revoked: revoked } });
  } finally {
    db.close();
  }
}

/**
 * Read lockout state from DB for an IP.
 */
async function getLockout(db, ip) {
  const key = `lockout:${ip}`;
  const result = await db.execute({
    sql: "SELECT value FROM dashboard_settings WHERE key = ?",
    args: [key],
  });
  if (result.rows.length === 0) return null;
  try {
    return JSON.parse(result.rows[0].value);
  } catch {
    return null;
  }
}

/**
 * Write lockout state to DB for an IP.
 */
async function setLockout(db, ip, state) {
  const key = `lockout:${ip}`;
  const value = JSON.stringify(state);
  await db.execute({
    sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')",
    args: [key, value, value],
  });
}

/**
 * Clear lockout for an IP and clean up expired lockouts.
 */
async function clearLockout(db, ip) {
  const key = `lockout:${ip}`;
  await db.execute({ sql: "DELETE FROM dashboard_settings WHERE key = ?", args: [key] });
  // Clean up expired lockouts
  const now = Date.now();
  await db.execute({
    sql: "DELETE FROM dashboard_settings WHERE key LIKE 'lockout:%' AND json_extract(value, '$.lockedUntil') < ?",
    args: [now],
  });
}

/**
 * The scopes a password login's session is stored under. A login made from
 * this machine itself (servers/shared/self-origin.js) is tagged 'onhost':
 * verifySession ignores scopes, so it browses the dashboard as signed in, but
 * local-session.js compares scopes to "dashboard" exactly, so it is never the
 * owner's turn, even if its cookie is replayed from another machine. Only an
 * explicit `onHost: false` gives a plain 'dashboard' session (fails closed).
 */
export function passwordSessionScopes(onHost) {
  return onHost === false ? "dashboard" : "dashboard onhost";
}

/**
 * Attempt login. Returns session token on success, null on failure.
 * `opts.onHost` (5th argument): whether the login request came from this
 * machine; anything but `false` stores an 'onhost' session.
 */
export async function attemptLogin(password, ip, deviceTrustToken = null, userAgent = null, opts = {}) {
  const onHost = opts?.onHost !== false;
  const db = createDbClient();
  try {
    // Check lockout (persistent in DB)
    const lockout = await getLockout(db, ip);
    if (lockout && lockout.lockedUntil && Date.now() < lockout.lockedUntil) {
      const remaining = Math.ceil((lockout.lockedUntil - Date.now()) / 60000);
      return { error: `Account locked. Try again in ${remaining} minute(s).`, locked: true };
    }

    const result = await db.execute({
      sql: "SELECT value FROM dashboard_settings WHERE key = 'password_hash'",
      args: [],
    });
    if (result.rows.length === 0) return { error: "No password set." };

    const valid = await verifyPassword(password, result.rows[0].value);
    if (!valid) {
      // Track failed attempt in DB
      const a = lockout || { count: 0, lockedUntil: null };
      a.count++;
      if (a.count >= LOCKOUT_THRESHOLD) {
        a.lockedUntil = Date.now() + LOCKOUT_DURATION;
        // Detailed security report. NOTE: auditLog() reads only {actor, ip,
        // details} — the extras MUST be nested under `details` or they're
        // silently dropped (W2-1 fix for a pre-existing bug).
        await auditLog(db, 'security_lockout_report', {
          ip,
          details: {
            userAgent,
            attempts: a.count,
            lockedUntil: new Date(a.lockedUntil).toISOString(),
          },
        });
        // Tell the owner immediately — the 15-min health monitor is too slow
        // for "someone is hammering your login right now". Once per hour
        // (lockout_notified_at cooldown), and seed health_last_notified so the
        // monitor doesn't fire a duplicate for the same storm. Never let a
        // notification failure break login handling.
        try {
          const { rows: lnRows } = await db.execute({
            sql: "SELECT value FROM dashboard_settings WHERE key='lockout_notified_at'",
            args: [],
          });
          const lastNotified = lnRows[0]?.value ? Number(lnRows[0].value) : null;
          if (!lastNotified || Date.now() - lastNotified >= 60 * 60 * 1000) {
            const { createNotification } = await import("../../shared/notifications.js");
            const { t } = await import("./shared/i18n.js");
            await createNotification(db, {
              type: "system",
              source: "security:lockout",
              priority: "high",
              title: t("signals.logins.notifTitle", "en").replace("{n}", String(a.count)),
              body: t("signals.logins.notifBody", "en"),
              action_url: "/dashboard/attention",
            });
            const nowStr = String(Date.now());
            await db.execute({
              sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('lockout_notified_at', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')",
              args: [nowStr, nowStr],
            });
            // Seed the monitor's dedupe map so it won't double-notify within 24h.
            try {
              const { rows: hmRows } = await db.execute({
                sql: "SELECT value FROM dashboard_settings WHERE key='health_last_notified'",
                args: [],
              });
              let lastMap = {};
              try { lastMap = hmRows[0]?.value ? JSON.parse(hmRows[0].value) : {}; } catch {}
              lastMap.logins = Date.now();
              const ser = JSON.stringify(lastMap);
              await db.execute({
                sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('health_last_notified', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')",
                args: [ser, ser],
              });
            } catch {}
          }
        } catch {
          // Notification path is best-effort; login handling must continue.
        }
        // Send lockout alert to hosting API (managed hosting only)
        if (isHosted && process.env.CROW_HOSTING_API_URL && process.env.CROW_HOSTING_AUTH_TOKEN) {
          try {
            fetch(`${process.env.CROW_HOSTING_API_URL}/api/security/lockout-alert`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-Instance-Token": process.env.CROW_HOSTING_AUTH_TOKEN },
              body: JSON.stringify({ ip, attempts: a.count, userAgent }),
            }).catch(() => {}); // Fire and forget
          } catch {
            // Non-critical
          }
        }
      }
      // Best-effort: lockout bookkeeping must never take the gateway down.
      // A DB-layer error here (2026-08-03: SQLITE_IOERR_SHORT_READ from a
      // stale in-process WAL index) previously escaped as an unhandled
      // rejection, crashed the gateway on every login POST, and the
      // resulting crash-restart churn corrupted crow.db.
      try {
        await setLockout(db, ip, a);
      } catch (err) {
        console.error("[auth] setLockout failed (continuing):", err.message);
      }
      await auditLog(db, 'auth_login_failure', { ip });
      return { error: "Invalid password." };
    }

    // Reset attempts on success + clean expired lockouts (best-effort, same
    // never-crash rule as setLockout above).
    try {
      await clearLockout(db, ip);
    } catch (err) {
      console.error("[auth] clearLockout failed (continuing):", err.message);
    }

    // Check if 2FA is enabled
    const twoFaEnabled = await is2faEnabled();
    if (twoFaEnabled) {
      // Check device trust cookie (passed via options)
      if (deviceTrustToken && await verifyDeviceTrust(deviceTrustToken)) {
        // Trusted device — skip 2FA, issue session directly
        await auditLog(db, 'auth_login_success', { ip, method: '2fa_trusted_device' });
      } else {
        // Need 2FA verification — create pending token
        await auditLog(db, 'auth_password_verified', { ip });
        // The on-host flag rides the pending token, so the 2FA step mints an
        // 'onhost' session even when its own request comes from elsewhere. A
        // dashboard-consent hand-off (`next`) rides it too, so the 2FA step can
        // return to the app's consent page instead of the dashboard home; the
        // caller has already checked it with oauth-consent.js's isConsentNext.
        const pendingCtx = {};
        if (onHost) pendingCtx.onhost = true;
        if (typeof opts?.next === "string" && opts.next) pendingCtx.next = opts.next;
        const pending2faToken = await createPending2faToken(Object.keys(pendingCtx).length ? pendingCtx : null);
        return { requires2fa: true, pending2faToken };
      }
    } else {
      await auditLog(db, 'auth_login_success', { ip });
    }

    // Create session token
    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + SESSION_MAX_AGE).toISOString();
    await db.execute({
      sql: "INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES (?, 'access', 'dashboard', ?, ?)",
      args: [hashToken(token), passwordSessionScopes(onHost), expiresAt],
    });
    if (onHost) {
      try { await auditLog(db, 'auth_login_onhost', { ip, details: { scopes: passwordSessionScopes(true) } }); } catch { /* audit is best effort */ }
    }

    return { token };
  } catch (err) {
    // Never let a DB-layer failure escape as an unhandled rejection — the
    // 2026-08-03 incident showed that crashing here puts systemd into a
    // crash-restart loop whose overlapping boots corrupt crow.db.
    console.error("[auth] attemptLogin database failure (returning soft error):", err.message);
    return { error: "Login temporarily unavailable (server database error). Check gateway logs." };
  } finally {
    db.close();
  }
}

/**
 * Complete login after 2FA verification. Issues a session token.
 * `opts.onHost`: whether the login (password step or 2FA step) came from this
 * machine; anything but `false` stores an 'onhost' session (passwordSessionScopes).
 */
export async function complete2faLogin(ip, opts = {}) {
  const onHost = opts?.onHost !== false;
  const db = createDbClient();
  try {
    await auditLog(db, 'auth_login_success', { ip, method: '2fa', ...(onHost ? { details: { onhost: true } } : {}) });
    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + SESSION_MAX_AGE).toISOString();
    await db.execute({
      sql: "INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES (?, 'access', 'dashboard', ?, ?)",
      args: [hashToken(token), passwordSessionScopes(onHost), expiresAt],
    });
    return { token };
  } finally {
    db.close();
  }
}

/**
 * Mint a dashboard session authorized via cross-instance SSO.
 *
 * Identical storage to a normal session (oauth_tokens, client_id='dashboard'
 * so verifySession accepts it) but with a 24h lifetime and a distinct
 * `scopes='dashboard sso src:<issuing instance id>'` tag for auditing and so
 * revoking the issuing peer ends its sessions (PT-1). The
 * caller is responsible for having validated the SSO ticket first.
 *
 * @param {string} srcInstanceId  The issuing (source) instance id, for audit.
 * @returns {Promise<{token: string}>}
 */
export async function mintSsoSession(srcInstanceId) {
  const db = createDbClient();
  try {
    // PT-1: re-check the issuing peer immediately before minting. The accept
    // route checked it when the ticket arrived, but both 2FA completions mint
    // up to 5 minutes later, and the peer may have been revoked or paused in
    // between. Every mint goes through here, so no caller can skip it.
    const trust = await peerTrust(db, srcInstanceId);
    if (!trust.ok) {
      try { await auditLog(db, 'auth_sso_refused', { src: srcInstanceId || null, reason: trust.reason }); } catch { /* audit is best effort */ }
      const err = new Error("single sign-on refused");
      err.code = "sso_refused";
      err.reason = trust.reason;
      throw err;
    }
    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + SSO_SESSION_MAX_AGE).toISOString();
    await db.execute({
      // Tagged with the issuing peer (PT-1) so revoking that peer ends the
      // sessions it minted. local-session.js compares scopes to "dashboard"
      // exactly and the session verifier ignores scopes, so the tag is inert.
      sql: "INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES (?, 'access', 'dashboard', ?, ?)",
      args: [hashToken(token), srcInstanceId ? `dashboard sso src:${srcInstanceId}` : "dashboard sso", expiresAt],
    });
    await auditLog(db, 'auth_sso_login', { src: srcInstanceId || null });
    return { token };
  } finally {
    db.close();
  }
}

/**
 * Verify a session token.
 */
export async function verifySession(token) {
  if (!token) return false;
  const db = createDbClient();
  try {
    const result = await db.execute({
      sql: "SELECT token FROM oauth_tokens WHERE token = ? AND client_id = 'dashboard' AND julianday(expires_at) > julianday('now')",
      args: [hashToken(token)],
    });
    return result.rows.length > 0;
  } finally {
    db.close();
  }
}

/**
 * Destroy a session.
 */
export async function destroySession(token) {
  if (!token) return;
  const db = createDbClient();
  try {
    await db.execute({ sql: "DELETE FROM oauth_tokens WHERE token = ?", args: [hashToken(token)] });
    await auditLog(db, 'session_destroyed', {});
  } finally {
    db.close();
  }
}

/**
 * True if ip is RFC1918 private, a tailnet address (100.64.0.0/10 or
 * fd7a:115c:a1e0::/48, v4-mapped spellings included), or in CROW_ALLOWED_IPS.
 * Does NOT include bare loopback; callers decide about loopback from the
 * peer class (servers/shared/peer-class.js). LAN IPv6 (fc00::/7) stays out.
 */
export function isPrivateOrAllowlistedIp(raw) {
  const addr = normalizeAddr(raw);
  if (isOverlayAddr(addr)) return true;
  if (/^10\./.test(addr)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(addr)) return true;
  if (/^192\.168\./.test(addr)) return true;

  const parts = addr.split(".").map(Number);
  if (parts.length === 4 && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;

  const custom = process.env.CROW_ALLOWED_IPS;
  if (custom) {
    for (const entry of custom.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (entry.includes("/")) {
        const [net, bits] = entry.split("/");
        const netParts = net.split(".").map(Number);
        const mask = ~((1 << (32 - Number(bits))) - 1) >>> 0;
        const netNum = ((netParts[0] << 24) | (netParts[1] << 16) | (netParts[2] << 8) | netParts[3]) >>> 0;
        const addrNum = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
        if ((addrNum & mask) === (netNum & mask)) return true;
      } else if (entry === addr) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Decide whether a request is allowed to reach private routes (/dashboard,
 * MCP endpoints, etc.). Works on Express requests and raw upgrade requests.
 *
 * INVARIANT: private routes MUST NEVER be reachable via Tailscale Funnel.
 * The decision is made on the TCP peer, classified once by classifyPeer()
 * (servers/shared/peer-class.js); a header is never an allow reason by
 * itself:
 *   - the Funnel header always denies (tailscaled Del-then-Sets it at
 *     serve.go:1046-1061, so a Funnel client cannot remove it);
 *   - Serve traffic counts as the tailnet client tailscaled named only when
 *     the loopback socket belongs to tailscaled's uid and has Serve's shape;
 *   - a declared proxy (CROW_TRUSTED_PROXIES) or a direct peer passes only
 *     when its own address and every address any forwarding header names are
 *     private, tailnet or CROW_ALLOWED_IPS (a header can only take trust away);
 *   - a connection on the dedicated proxy socket (proxy-socket.js) is a
 *     declared proxy that vouches for the rightmost X-Forwarded-For hop; with
 *     no such hop it names nobody and is refused;
 *   - bare loopback, and loopback carrying headers it cannot vouch for, deny.
 */
export function isAllowedNetwork(req) {
  if (process.env.CROW_DASHBOARD_PUBLIC === "true") return true;
  const headers = req.headers || {};
  if (headers["tailscale-funnel-request"]) return false;
  const p = classifyPeer(req);
  if (p.hops.some((a) => a === null)) return false;
  const trustedClient = (a) => !isLoopbackAddr(a) && isPrivateOrAllowlistedIp(a);
  switch (p.via) {
    case "serve":
      // Serve replaces X-Forwarded-For but passes a client's X-Real-IP through untouched; one that
      // names a non-tailnet address (e.g. added by an office proxy in front of the client) takes
      // trust away and the request is denied (pinned in tests/auth-network.test.js).
      return isOverlayAddr(p.client) && p.hops.every((a) => isOverlayAddr(a));
    case "proxy":
      // `client` is null when nobody vouched for the request (a proxy-socket
      // connection with no X-Forwarded-For): fail closed, never read the
      // (empty) socket address as the client.
      if (!p.client) return false;
      return p.hops.length ? p.hops.every(trustedClient) : trustedClient(p.client);
    case "direct":
      return trustedClient(p.socket) && p.hops.every(trustedClient);
    default: // local, unverified, funnel
      return false;
  }
}

function headerValues(h) {
  if (h == null) return [];
  return (Array.isArray(h) ? h : [h]).flatMap((v) => String(v).split(","));
}

/** A Host / X-Forwarded-Host value naming a tailnet- or LAN-scoped host:
 * localhost, a *.ts.net MagicDNS name, or a loopback/private/tailnet IP. */
function isPrivateScopedHost(raw) {
  let h = String(raw || "").trim().toLowerCase();
  const br = h.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (br) h = br[1];
  else h = h.replace(/:\d+$/, "");
  h = h.replace(/\.$/, "");
  if (!h) return false;
  if (!/^[a-z0-9.:-]+$/.test(h)) return false;
  if (h === "localhost" || h.endsWith(".ts.net")) return true;
  if (isLoopbackAddr(h)) return true;
  if (/^fd7a:115c:a1e0:/.test(h)) return true;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) && isPrivateOrAllowlistedIp(h);
}

function isLoopbackAddr(a) {
  const v = String(a || "").replace(/^::ffff:/, "");
  return v === "::1" || v === "localhost" || /^127\./.test(v);
}

/**
 * The network gate for unauthenticated peer enrollment
 * (POST /instance/enroll-request). The dashboard's rules (isAllowedNetwork),
 * tightened so it can never allow what the dashboard refuses:
 *
 *   - Funnel traffic is refused, and CROW_DASHBOARD_PUBLIC does NOT open it.
 *   - Tailscale-User-Login alone is never trusted (any non-Tailscale proxy
 *     passes a client's copy through).
 *   - The decision uses the TCP peer (req.socket), never req.ip, which
 *     `trust proxy` rewrites from a client-supplied X-Forwarded-For.
 *   - Loopback socket = a same-box proxy (Tailscale Serve, which REPLACES the
 *     inbound X-Forwarded-For with the real client, or Caddy/nginx). It must
 *     name its client (X-Forwarded-For / X-Real-IP / Forwarded), and EVERY
 *     address named must be private, tailnet or CROW_ALLOWED_IPS — so an
 *     internet client behind a public reverse proxy, or a spoofed hop, is
 *     refused. A loopback request naming no client (a bare local process, or
 *     a proxy that forwards no client address) is refused, as the dashboard
 *     refuses bare loopback; `crow instance pair` always dials the peer's
 *     tailnet URL, so it never arrives that way.
 *   - Non-loopback socket: a direct client; it must not claim proxied hops,
 *     and its own address must be private, tailnet or allow-listed.
 *
 *   - Through a loopback proxy, the Host and X-Forwarded-Host the client used
 *     must be tailnet/LAN-scoped (localhost, *.ts.net, private/tailnet IP): a
 *     public front door chained into this host's Serve (a public reverse proxy
 *     on another node → this host's Serve → the gateway) has its X-Forwarded-For replaced by Serve with the
 *     front door's tailnet IP, but still carries the public host name.
 *
 * Residual: a front door that ALSO rewrites Host to a *.ts.net name is
 * indistinguishable from tailnet traffic; the mandatory one-time code is the
 * gate there.
 */
export function isAllowedEnrollNetwork(req) {
  const headers = req.headers || {};
  if (headers["tailscale-funnel-request"]) return false;
  const sock = String(req.socket?.remoteAddress || req.connection?.remoteAddress || "").replace(/^::ffff:/, "");
  // No socket address at all (the dedicated proxy socket, proxy-socket.js) is
  // refused: enrollment is reached over the tailnet directly, never through
  // this host's Caddy.
  if (!sock) return false;
  const hops = forwardedAddrs(headers);
  if (hops.some((a) => a === null)) return false;
  if (isLoopbackAddr(sock)) {
    if (hops.length === 0) return false;
    // Only Serve (verified socket owner) or a declared proxy may speak for a client.
    const via = classifyPeer(req).via;
    if (via !== "serve" && via !== "proxy") return false;
    // A front door chained INTO Serve (public proxy → this host's Serve over
    // the tailnet) arrives with Serve's replaced X-Forwarded-For naming only
    // the front door's tailnet IP — but the Host the client asked for rides
    // along. Every host named must be a tailnet/LAN-scoped one.
    if (!headers.host || !isPrivateScopedHost(headers.host)) return false;
    for (const h of headerValues(headers["x-forwarded-host"])) {
      if (String(h).trim() && !isPrivateScopedHost(h)) return false;
    }
    return hops.every((a) => !isLoopbackAddr(a) && isPrivateOrAllowlistedIp(a.replace(/^::ffff:/, "")));
  }
  if (hops.length > 0) return false;
  return isPrivateOrAllowlistedIp(sock);
}

/**
 * The `src:<instance id>` a session a paired instance minted through SSO carries,
 * or null. `mintSsoSession` stores `scopes = 'dashboard sso src:<id>'`; the tag is
 * revoke plumbing (PT-1) AND the fact that decides whose writes the session makes.
 */
export function ssoSourceOf(scopes) {
  const m = /(?:^|\s)sso src:(\S+)/.exec(String(scopes ?? ""));
  return m && m[1] ? m[1] : null;
}

/**
 * The version-history write context a dashboard request writes under.
 *
 * A password sign-in on this instance is the OWNER: keyed by the first 8 hex of
 * the session's sha256 (never a user name, an email or the raw session id) with
 * the session as the job, so the owner's edits group per sign-in (the version
 * history design, §8.1).
 *
 * A session a paired instance minted through SSO is NOT the owner — the same rule
 * routes/chat.js applies when it decides whose turn a chat is — so its writes are
 * stamped `peer`, with the minting instance as both author and origin.
 *
 * Null when the request carries no session: the write is then recorded as
 * unattributed, never as the owner.
 */
export function ownerRequestWriteContext(req) {
  const ssoSrc = req?.dashboardSsoSrc;
  if (typeof ssoSrc === "string" && ssoSrc) return peerWriteContext(ssoSrc);
  // An SSO session whose source is unknown is still not the owner: no context,
  // so its writes are recorded unattributed rather than as the owner's.
  if (req?.dashboardSso) return null;
  return ownerWriteContext(req?.dashboardSession);
}

/**
 * Verify a dashboard session AND say who its writes belong to: `{ valid, ssoSrc }`,
 * where `ssoSrc` is the instance id that minted an SSO session (null for a local
 * password session). One query, so the middleware never reads the session twice.
 * `verifySession` below stays the plain yes/no check for callers that only gate.
 *
 * `expiresAt` rides along because the caller needs it and a second query would
 * be the same row: the `__Host-` migration re-issues the cookie for the lifetime
 * this session has LEFT, never a fresh week (otherwise a plain cookie could be
 * kept alive forever by replaying the migration).
 */
export async function sessionAuth(token) {
  if (!token) return { valid: false, ssoSrc: null, sso: false, expiresAt: null };
  const db = createDbClient();
  try {
    const row = await readSessionRow(db, token);
    if (!row) return { valid: false, ssoSrc: null, sso: false, expiresAt: null };
    const scopes = String(row.scopes ?? "");
    return {
      valid: true,
      ssoSrc: ssoSourceOf(scopes),
      sso: /(?:^|\s)sso(?:\s|$)/.test(scopes),
      expiresAt: row.expires_at == null ? null : String(row.expires_at),
    };
  } finally {
    db.close();
  }
}

/**
 * The live session row for a token, `null` when there is none.
 */
async function readSessionRow(db, token) {
  const result = await db.execute({
    sql: "SELECT scopes, expires_at FROM oauth_tokens WHERE token = ? AND client_id = 'dashboard' AND julianday(expires_at) > julianday('now')",
    args: [hashToken(token)],
  });
  return result.rows[0] || null;
}

/**
 * How long this session has left, in ms, from its `expires_at` — or 0 when it is
 * unreadable or already due. SQLite writes two shapes into that column: our own
 * ISO strings (with a zone) and `datetime('now')` UTC text with no zone, which
 * Date.parse would read in the host's LOCAL time. A zone-less value is therefore
 * read as UTC.
 */
export function remainingLifetimeMs(expiresAt, now = Date.now()) {
  const raw = String(expiresAt ?? "").trim();
  if (!raw) return 0;
  const zoned = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(raw);
  const at = Date.parse(zoned ? raw : raw.replace(" ", "T") + "Z");
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, at - now);
}

/**
 * The 403 page a request gets when the network gate is closed: the same
 * response dashboardAuth sends, and the same one the login and password-reset
 * pages send (they are the pages a stranger would otherwise type a password
 * into).
 *
 * No env-var escape hatch here: the security audit's finding was that this
 * page sent the owner to CROW_DASHBOARD_PUBLIC=true, which turns the whole
 * network gate off. Say how to reach Crow instead.
 */
export function sendNetworkRefusal(req, res) {
  const cookies = parseCookies(req);
  const lang = SUPPORTED_LANGS.includes(cookies.crow_lang) ? cookies.crow_lang : "en";
  res.status(403).type("html").send(`<!DOCTYPE html><html><head><title>${escapeHtml(t("login.accessDeniedTitle", lang))}</title></head><body style="font-family:sans-serif;padding:3rem;text-align:center">
      <h1>${escapeHtml(t("login.accessDeniedTitle", lang))}</h1>
      <p>${escapeHtml(t("login.accessDeniedBody", lang))}</p>
    </body></html>`);
}

/**
 * Whether the login and password-reset pages may be served to (and accept a
 * password from) this request.
 *
 * The same network rule as every private route, plus one exemption: a request
 * straight off this machine's loopback socket. That is the first-run setup path
 * (the setup page is http://localhost:3001/setup while no password is set) and
 * the owner at this machine's console — reusing exactly the "bare same-box
 * caller" test the first-run gate uses, so a proxied visitor (a forwarding or
 * tailscale-* header) and a Serve/Funnel request are still classified as what
 * they are and refused. CROW_DASHBOARD_PUBLIC=true is handled inside
 * isAllowedNetwork.
 */
export function loginNetworkAllowed(req) {
  return isAllowedNetwork(req) || isDirectLoopback(req);
}

/**
 * Dashboard auth middleware.
 * Checks session cookie or redirects to login.
 *
 * On success the rest of the request runs INSIDE a write context: every write this
 * request makes to covered content — including the panels' direct SQL on crow.db,
 * whose triggers cannot see who is asking — is attributed to this sign-in (or, for
 * an SSO session, to the instance that minted it). Express's next() is called
 * inside the async-local store, so downstream handlers and their promises inherit
 * it.
 *
 * That inheritance is why a handler that starts something LONG-LIVED (a child
 * process, an interval, a background worker) must open it with
 * `withoutWriteContext` (servers/shared/history/write-context.js): otherwise the
 * worker's every later write is stamped with this request's author. A model's tool
 * call is the other side of the same coin — it takes its own context (see
 * servers/gateway/ai/tool-executor.js).
 */
export function dashboardAuth(req, res, next) {
  // Network check
  if (!isAllowedNetwork(req)) {
    sendNetworkRefusal(req, res);
    return;
  }

  const { token, migrate } = sessionFromCookies(req);
  const secure = requestIsSecure(req);

  sessionAuth(token).then(({ valid, ssoSrc, sso, expiresAt }) => {
    if (valid) {
      req.dashboardSession = token;
      // Migration of the pre-`__Host-` cookie: this browser presented the old
      // plain `crow_session` over HTTPS. The response re-issues it as
      // `__Host-crow_session` with the session's OWN remaining lifetime (never a
      // fresh week) and expires the plain one — host-only and, where the request
      // host has a parent that is not itself a public suffix, at that parent too
      // (setSessionCookie) — so a sibling host's `Domain=<tailnet>.ts.net` copy
      // goes with it. (No per-session marker: see the header's known residual.)
      if (migrate) {
        const remaining = remainingLifetimeMs(expiresAt);
        if (remaining > 0) {
          try {
            setSessionCookie(res, token, remaining, { secure, expirePlain: true, req });
          } catch { /* never block a page on a header */ }
        }
      }
      if (ssoSrc) req.dashboardSsoSrc = ssoSrc;
      if (sso) req.dashboardSso = true;
      const ctx = ownerRequestWriteContext(req);
      if (ctx) withWriteContext(ctx, () => next());
      else next();
    } else {
      res.redirectAfterPost("/dashboard/login");
    }
  }).catch(() => {
    res.redirect("/dashboard/login");
  });
}

/**
 * The live dashboard session carried by a request that never passes through
 * Express — a raw WebSocket upgrade — or by a route that must answer 401
 * instead of redirecting to the login page (a page shown inside a frame).
 * Same two checks as dashboardAuth, in the same order: the network rule
 * (which also refuses Tailscale Funnel), then the session cookie against the
 * session store. Resolves the session token, or null. Never throws.
 */
export async function sessionFromRequest(req) {
  if (!req || !req.headers || !isAllowedNetwork(req)) return null;
  const { token } = sessionFromCookies(req);
  if (!token) return null;
  try {
    const session = await sessionAuth(token);
    if (!session.valid) return null;
    return token;
  } catch {
    return null;
  }
}

/**
 * Set session cookie on response.
 */
/** "; Secure" when cookies must be Secure (hosted / production), else "". */
export function cookieSecureSuffix() {
  return process.env.CROW_HOSTED || process.env.NODE_ENV === 'production' ? '; Secure' : '';
}

/**
 * The `Domain=` a plain `crow_session` may ALSO live under for this request host,
 * or null when there is none worth expiring.
 *
 * Why: a sibling host on the tailnet sets its own copy with
 * `Domain=<tailnet>.ts.net` (`ts.net` is a public suffix, so it is same-site with
 * the dashboard). That copy is NOT the host-only cookie this file expires, and
 * the browser keeps sending it — which is the tossing shape the `__Host-`
 * cookie and the migration rail fend off. We cannot enumerate every parent a
 * sibling might have picked, so this is a best effort at the one real installs
 * produce: the IMMEDIATE parent of the request host
 * (`<instance>.<tailnet>.ts.net` → `<tailnet>.ts.net`).
 *
 * Refused (null): IP-literal and single-label hosts, hosts with fewer than three
 * labels (there the parent IS the suffix), non-hostname characters, and parents
 * that are public suffixes in their own right — a tiny PSL-free list, since
 * browsers reject a `Domain=` naming one anyway.
 *
 * @param {string} rawHost the request's Host header (port optional)
 * @returns {string|null}
 */
export function cookieDomainCandidate(rawHost) {
  const host = String(rawHost ?? "").trim().toLowerCase()
    .replace(/:\d+$/, "")
    .replace(/\.$/, "");
  if (!host || host.startsWith("[")) return null;              // [::1] and friends
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return null;      // an IPv4 literal
  if (!/^[a-z0-9.-]+$/.test(host)) return null;
  const labels = host.split(".");
  if (labels.length < 3) return null;
  const parent = labels.slice(1).join(".");
  if (PUBLIC_SUFFIXES.has(parent)) return null;
  return parent;
}

/**
 * Suffixes that are public suffixes in their own right: a `Domain=` naming one is
 * refused by browsers, and a host under one has no parent worth expiring.
 * Tailscale's `ts.net` is the one every Crow install meets; the rest are the
 * LAN/development names a bare box answers on.
 */
const PUBLIC_SUFFIXES = new Set(["ts.net", "localhost", "local", "internal", "home.arpa"]);

/**
 * Set the session cookie on a response.
 *
 * Over HTTPS it is `__Host-crow_session`: Secure, Path=/, and NO Domain — the
 * `__Host-` prefix makes browsers refuse any other shape, so no sibling host on
 * the tailnet (same SITE, thanks to the public suffix) can set or overwrite it.
 * Plain HTTP keeps `crow_session` with today's attributes.
 *
 * `opts.secure` is the request's own answer (requestIsSecure(req)): HTTPS gets
 * the `__Host-` cookie, plain HTTP the plain one. The env fallback is only for
 * a caller that has no request at all (tests, a CLI); every route passes the
 * request's answer so Tailscale Serve / Caddy — where TLS ends at the proxy and
 * the gateway sees loopback — still get `__Host-`.
 *
 * `opts.expirePlain` additionally expires a plain `crow_session` left over from
 * before the `__Host-` cookie existed — once host-only, and once at the request
 * host's parent domain (`opts.req` or `opts.host` names it; see
 * cookieDomainCandidate) because that is the shape a sibling host's tossed copy
 * carries. Best effort: a browser refuses a `Domain=` it does not like, and the
 * host-only expiry is always sent.
 */
export function setSessionCookie(res, token, maxAgeMs = SESSION_MAX_AGE, { secure = null, expirePlain = false, req = null, host = null } = {}) {
  const maxAge = maxAgeMs / 1000;
  const isSecure = secure === null ? !!(process.env.CROW_HOSTED || process.env.NODE_ENV === 'production') : !!secure;
  const secureSuffix = isSecure ? '; Secure' : '';
  const name = isSecure ? HOST_SESSION_COOKIE : SESSION_COOKIE;
  const cookies = [
    `${name}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secureSuffix}`,
  ];
  if (expirePlain && name !== SESSION_COOKIE) {
    const plainExpiry = (domain) =>
      `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${domain ? `; Domain=${domain}` : ''}${secureSuffix}`;
    cookies.push(plainExpiry(null));
    const requestHost = host ?? (req && req.headers ? req.headers.host : null);
    const parent = cookieDomainCandidate(requestHost);
    if (parent) cookies.push(plainExpiry(parent));
  }
  res.setHeader("Set-Cookie", cookies);
}

/**
 * Clear the session cookie on a response.
 *
 * Both names are expired: whichever one this browser holds (`__Host-` over
 * HTTPS, plain over HTTP) has to go, and expiring the other is harmless. Any
 * leftover `crow_csrf` cookie from before the server-bound token is expired too
 * — nothing reads it any more, and it should not linger in the jar.
 *
 * `opts.secure` is the request's own answer (requestIsSecure(req)); it adds
 * `Secure` to the plain cookie's expiry over HTTPS, matching how that cookie
 * was set. The `__Host-` expiry always carries `Secure` — browsers require it
 * for the prefix.
 */
export function clearSessionCookie(res, { secure = false } = {}) {
  res.setHeader("Set-Cookie", [
    `${HOST_SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0; Secure`,
    `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? "; Secure" : ""}`,
    `crow_csrf=; SameSite=Lax; Path=/; Max-Age=0`,
  ]);
}

export { parseCookies };
