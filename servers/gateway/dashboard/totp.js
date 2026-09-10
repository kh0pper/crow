/**
 * TOTP Two-Factor Authentication
 *
 * - Secret generation, QR code rendering, verification
 * - Recovery codes (SHA-256 hashed, single-use)
 * - Device trust cookies
 * - Pending 2FA tokens (stored in dashboard_pending_2fa)
 */

import { createHash, randomBytes } from "node:crypto";
import * as OTPAuth from "otpauth";
import QRCode from "qrcode";
import { createDbClient } from "../../db.js";

const isHosted = !!process.env.CROW_HOSTED;
const PENDING_2FA_TTL = 5 * 60 * 1000; // 5 minutes
const DEVICE_TRUST_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days
const RECOVERY_CODE_COUNT = 8;

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

// --- TOTP Secret & Verification ---

/**
 * Generate a new TOTP secret.
 * @returns {{ secret: string, uri: string }} Base32 secret and otpauth URI
 */
export function generateTotpSecret(label = "Crow's Nest") {
  const totp = new OTPAuth.TOTP({
    issuer: "Crow",
    label,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: new OTPAuth.Secret({ size: 20 }),
  });
  return {
    secret: totp.secret.base32,
    uri: totp.toString(),
  };
}

/**
 * Generate a QR code data URI from an otpauth URI.
 * @param {string} uri - otpauth:// URI
 * @returns {Promise<string>} Data URI (image/png)
 */
export async function generateQrDataUri(uri) {
  return QRCode.toDataURL(uri, { width: 256, margin: 2 });
}

/**
 * Verify a TOTP code against a secret.
 *
 * Total on both arguments by design. Every caller passes at least one of them
 * straight out of a request body (`/dashboard/login/2fa` the code,
 * `/dashboard/login/2fa/setup` and the settings enable_2fa action both), so an
 * absent field is an ordinary malformed request. otpauth reads `.length` off
 * the token and `.replace` off the secret, so `undefined` used to raise a
 * TypeError inside an async route handler — an unhandled rejection, and
 * therefore fatal to the whole gateway process. A bad input answers false.
 *
 * @param {string} token - 6-digit code from authenticator
 * @param {string} secret - Base32-encoded secret
 * @returns {boolean}
 */
export function verifyTotp(token, secret) {
  if (typeof token !== "string" || token.trim() === "") return false;
  if (typeof secret !== "string" || secret.trim() === "") return false;
  let parsedSecret;
  try {
    parsedSecret = OTPAuth.Secret.fromBase32(secret);
  } catch {
    return false; // not base32 at all
  }
  const totp = new OTPAuth.TOTP({
    issuer: "Crow",
    label: "Crow's Nest",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: parsedSecret,
  });
  // window: 1 allows previous + next 30-second period (clock skew tolerance)
  const delta = totp.validate({ token, window: 1 });
  return delta !== null;
}

// --- 2FA State (dashboard_settings KV) ---

/**
 * Check if 2FA is enabled.
 */
export async function is2faEnabled() {
  const db = createDbClient();
  try {
    const result = await db.execute({
      sql: "SELECT value FROM dashboard_settings WHERE key = 'totp_enabled'",
      args: [],
    });
    return result.rows.length > 0 && result.rows[0].value === "true";
  } finally {
    db.close();
  }
}

/**
 * Get the stored TOTP secret.
 */
export async function getTotpSecret() {
  const db = createDbClient();
  try {
    const result = await db.execute({
      sql: "SELECT value FROM dashboard_settings WHERE key = 'totp_secret'",
      args: [],
    });
    return result.rows.length > 0 ? result.rows[0].value : null;
  } finally {
    db.close();
  }
}

/**
 * Save 2FA setup (secret + recovery codes). Does NOT enable 2FA yet.
 */
export async function saveTotpSetup(secret, recoveryCodes) {
  const hashedCodes = recoveryCodes.map((c) => sha256(c));
  const db = createDbClient();
  try {
    await db.execute({
      sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('totp_secret', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')",
      args: [secret, secret],
    });
    await db.execute({
      sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('totp_recovery_codes', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')",
      args: [JSON.stringify(hashedCodes), JSON.stringify(hashedCodes)],
    });
  } finally {
    db.close();
  }
}

/**
 * Enable 2FA (after first code verification).
 */
export async function enable2fa() {
  const db = createDbClient();
  try {
    await db.execute({
      sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('totp_enabled', 'true', datetime('now')) ON CONFLICT(key) DO UPDATE SET value = 'true', updated_at = datetime('now')",
      args: [],
    });
  } finally {
    db.close();
  }
}

/**
 * Disable 2FA and remove all related settings.
 */
export async function disable2fa() {
  const db = createDbClient();
  try {
    await db.execute({ sql: "DELETE FROM dashboard_settings WHERE key IN ('totp_enabled', 'totp_secret', 'totp_recovery_codes')", args: [] });
    // Remove all trusted devices
    await db.execute({ sql: "DELETE FROM dashboard_settings WHERE key LIKE 'trusted_device:%'", args: [] });
  } finally {
    db.close();
  }
}

// --- Recovery Codes ---

/**
 * Generate N random recovery codes.
 * @returns {string[]} Plain-text codes (show to user once)
 */
export function generateRecoveryCodes() {
  const codes = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    // Format: xxxx-xxxx-xxxx (12 hex chars with dashes)
    const raw = randomBytes(6).toString("hex");
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`);
  }
  return codes;
}

/**
 * Verify and consume a recovery code.
 * @returns {boolean} True if valid and consumed
 */
export async function verifyRecoveryCode(code) {
  const hashed = sha256(code);
  const db = createDbClient();
  try {
    const result = await db.execute({
      sql: "SELECT value FROM dashboard_settings WHERE key = 'totp_recovery_codes'",
      args: [],
    });
    if (result.rows.length === 0) return false;

    const codes = JSON.parse(result.rows[0].value);
    const idx = codes.indexOf(hashed);
    if (idx === -1) return false;

    // Consume: remove from array
    codes.splice(idx, 1);
    await db.execute({
      sql: "UPDATE dashboard_settings SET value = ?, updated_at = datetime('now') WHERE key = 'totp_recovery_codes'",
      args: [JSON.stringify(codes)],
    });
    return true;
  } finally {
    db.close();
  }
}

/**
 * Get remaining recovery code count.
 */
export async function getRecoveryCodeCount() {
  const db = createDbClient();
  try {
    const result = await db.execute({
      sql: "SELECT value FROM dashboard_settings WHERE key = 'totp_recovery_codes'",
      args: [],
    });
    if (result.rows.length === 0) return 0;
    return JSON.parse(result.rows[0].value).length;
  } finally {
    db.close();
  }
}

// --- Pending 2FA Tokens (dashboard_pending_2fa table) ---
//
// NOT oauth_tokens: its token_type CHECK is ('access','refresh') and SQLite
// cannot ALTER a CHECK, so an INSERT of token_type='pending_2fa' there failed
// on every 2FA login and locked the dashboard out (attemptLogin reported it as
// a soft "server database error" for a correct password). See init-db.js.

/**
 * Create a pending 2FA token after successful password verification.
 * @returns {string} Plain-text token (set as cookie)
 */
export async function createPending2faToken(meta = null) {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + PENDING_2FA_TTL).toISOString();
  // Optional context (e.g. cross-instance SSO {src, dest}) bound to THIS
  // single-use token, stored in the `meta` column. This
  // ties the SSO handoff to the specific 2FA flow so a stale cookie can't make
  // a later normal login look like SSO.
  const resource = meta ? JSON.stringify(meta) : null;
  const db = createDbClient();
  try {
    await db.execute({
      sql: "INSERT INTO dashboard_pending_2fa (token, meta, expires_at) VALUES (?, ?, ?)",
      args: [sha256(token), resource, expiresAt],
    });
    // Clean up expired pending tokens
    await db.execute({
      sql: "DELETE FROM dashboard_pending_2fa WHERE expires_at < datetime('now')",
      args: [],
    });
    return token;
  } finally {
    db.close();
  }
}

/**
 * Read the context bound to a pending 2FA token WITHOUT consuming it.
 * Returns the parsed `meta` object (e.g. SSO {src, dest}) or null. Call this
 * before verifyPending2faToken (which deletes the row on success).
 * @returns {Promise<object|null>}
 */
export async function getPending2faContext(token) {
  if (!token) return null;
  const db = createDbClient();
  try {
    const result = await db.execute({
      sql: "SELECT meta FROM dashboard_pending_2fa WHERE token = ? AND expires_at > datetime('now')",
      args: [sha256(token)],
    });
    const raw = result.rows[0]?.meta;
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  } finally {
    db.close();
  }
}

/**
 * Verify and consume a pending 2FA token.
 * @returns {boolean}
 */
export async function verifyPending2faToken(token) {
  if (!token) return false;
  const db = createDbClient();
  try {
    const result = await db.execute({
      sql: "SELECT token FROM dashboard_pending_2fa WHERE token = ? AND expires_at > datetime('now')",
      args: [sha256(token)],
    });
    if (result.rows.length === 0) return false;

    // Consume token
    await db.execute({
      sql: "DELETE FROM dashboard_pending_2fa WHERE token = ?",
      args: [sha256(token)],
    });
    return true;
  } finally {
    db.close();
  }
}

// --- Device Trust ---

/**
 * Create a trusted device token.
 * @returns {string} Plain-text token (set as cookie)
 */
export async function createDeviceTrust() {
  const token = randomBytes(32).toString("hex");
  const db = createDbClient();
  try {
    const key = `trusted_device:${sha256(token)}`;
    const expiresAt = new Date(Date.now() + DEVICE_TRUST_TTL).toISOString();
    await db.execute({
      sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')",
      args: [key, expiresAt, expiresAt],
    });
    return token;
  } finally {
    db.close();
  }
}

/**
 * Verify a trusted device token.
 * @returns {boolean}
 */
export async function verifyDeviceTrust(token) {
  if (!token) return false;
  const db = createDbClient();
  try {
    const key = `trusted_device:${sha256(token)}`;
    const result = await db.execute({
      sql: "SELECT value FROM dashboard_settings WHERE key = ?",
      args: [key],
    });
    if (result.rows.length === 0) return false;
    // Check expiry
    const expiresAt = new Date(result.rows[0].value);
    if (Date.now() > expiresAt.getTime()) {
      // Expired — clean up
      await db.execute({ sql: "DELETE FROM dashboard_settings WHERE key = ?", args: [key] });
      return false;
    }
    return true;
  } finally {
    db.close();
  }
}

/**
 * Revoke all trusted devices.
 */
export async function revokeAllDeviceTrust() {
  const db = createDbClient();
  try {
    await db.execute({ sql: "DELETE FROM dashboard_settings WHERE key LIKE 'trusted_device:%'", args: [] });
  } finally {
    db.close();
  }
}

/**
 * Whether 2FA is required (managed hosting) but not yet set up.
 */
export async function needs2faSetup() {
  if (!isHosted) return false;
  return !(await is2faEnabled());
}

export { isHosted, DEVICE_TRUST_TTL };
