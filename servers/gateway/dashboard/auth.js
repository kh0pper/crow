/**
 * Dashboard Authentication
 *
 * Password-based auth with session cookies.
 * - Password hashed with crypto.scrypt (async)
 * - Session tokens stored in oauth_tokens table (reuses existing infra)
 * - CSRF double-submit cookie pattern
 * - Account lockout: 5 failed attempts → 15 min lock
 */

import { scrypt, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { createDbClient, auditLog } from "../../db.js";

function hashToken(t) { return createHash('sha256').update(t).digest('hex'); }

const SESSION_COOKIE = "crow_session";
const CSRF_COOKIE = "crow_csrf";
const isHosted = !!process.env.CROW_HOSTED;
const SESSION_MAX_AGE = isHosted ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
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
function verifyPassword(password, stored) {
  return new Promise((resolve, reject) => {
    const [salt, hash] = stored.split(":");
    scrypt(password, salt, 64, (err, key) => {
      if (err) reject(err);
      else resolve(timingSafeEqual(Buffer.from(hash, "hex"), key));
    });
  });
}

/**
 * Parse cookies from request.
 */
function parseCookies(req) {
  const header = req.headers.cookie || "";
  const cookies = {};
  for (const pair of header.split(";")) {
    const [name, ...rest] = pair.trim().split("=");
    if (name) cookies[name] = rest.join("=");
  }
  return cookies;
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
 */
export async function setPassword(password) {
  const hash = await hashPassword(password);
  const db = createDbClient();
  try {
    await db.execute({
      sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('password_hash', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')",
      args: [hash, hash],
    });
    await auditLog(db, 'password_changed', {});
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
 * Attempt login. Returns session token on success, null on failure.
 */
export async function attemptLogin(password, ip) {
  const db = createDbClient();
  try {
    // Check lockout (persistent in DB)
    const lockout = await getLockout(db, ip);
    if (lockout && lockout.lockedUntil && Date.now() < lockout.lockedUntil) {
      const remaining = Math.ceil((lockout.lockedUntil - Date.now()) / 60000);
      return { error: `Account locked. Try again in ${remaining} minute(s).` };
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
        await auditLog(db, 'auth_lockout', { ip });
      }
      await setLockout(db, ip, a);
      await auditLog(db, 'auth_login_failure', { ip });
      return { error: "Invalid password." };
    }

    // Reset attempts on success + clean expired lockouts
    await clearLockout(db, ip);
    await auditLog(db, 'auth_login_success', { ip });

    // Create session token
    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + SESSION_MAX_AGE).toISOString();
    await db.execute({
      sql: "INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES (?, 'access', 'dashboard', 'dashboard', ?)",
      args: [hashToken(token), expiresAt],
    });

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
      sql: "SELECT token FROM oauth_tokens WHERE token = ? AND client_id = 'dashboard' AND expires_at > datetime('now')",
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
 * Check if request IP is on the local/Tailscale allowlist.
 */
export function isAllowedNetwork(req) {
  if (process.env.CROW_DASHBOARD_PUBLIC === "true") return true;

  const ip = req.ip || req.connection?.remoteAddress || "";
  // Normalize IPv6-mapped IPv4
  const addr = ip.replace(/^::ffff:/, "");

  // Localhost
  if (addr === "127.0.0.1" || addr === "::1" || addr === "localhost") return true;

  // RFC 1918 private ranges
  if (/^10\./.test(addr)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(addr)) return true;
  if (/^192\.168\./.test(addr)) return true;

  // Tailscale CGNAT range (100.64.0.0/10)
  const parts = addr.split(".").map(Number);
  if (parts.length === 4 && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;

  // Custom IP allowlist (comma-separated IPs or CIDR ranges)
  const custom = process.env.CROW_ALLOWED_IPS;
  if (custom) {
    for (const entry of custom.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (entry.includes("/")) {
        // CIDR check
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
 * Dashboard auth middleware.
 * Checks session cookie or redirects to login.
 */
export function dashboardAuth(req, res, next) {
  // Network check
  if (!isAllowedNetwork(req)) {
    res.status(403).type("html").send(`<!DOCTYPE html><html><head><title>Access Denied</title></head><body style="font-family:sans-serif;padding:3rem;text-align:center">
      <h1>Access Denied</h1>
      <p>Crow's Nest is only accessible from local network or Tailscale.</p>
      <p>Set up <a href="https://tailscale.com">Tailscale</a> for secure remote access,<br>or set <code>CROW_DASHBOARD_PUBLIC=true</code> in your <code>.env</code> to allow public access.</p>
    </body></html>`);
    return;
  }

  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];

  verifySession(token).then((valid) => {
    if (valid) {
      req.dashboardSession = token;
      next();
    } else {
      res.redirect("/dashboard/login");
    }
  }).catch(() => {
    res.redirect("/dashboard/login");
  });
}

/**
 * Set session cookie on response.
 */
export function setSessionCookie(res, token) {
  const maxAge = SESSION_MAX_AGE / 1000;
  const secure = process.env.CROW_HOSTED || process.env.NODE_ENV === 'production';
  const secureSuffix = secure ? '; Secure' : '';
  res.setHeader("Set-Cookie", [
    `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secureSuffix}`,
    `${CSRF_COOKIE}=${randomBytes(16).toString("hex")}; SameSite=Strict; Path=/; Max-Age=${maxAge}${secureSuffix}`,
  ]);
}

/**
 * Clear session cookie on response.
 */
export function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", [
    `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
    `${CSRF_COOKIE}=; SameSite=Strict; Path=/; Max-Age=0`,
  ]);
}

export { parseCookies };
