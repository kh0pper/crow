/**
 * Maker Lab — solo-mode device binding helpers.
 *
 * Solo mode lets a single learner auto-redeem without a QR handoff. That
 * posture is SAFE only in two situations:
 *   (A) the kiosk and the Crow host are the same machine (loopback), or
 *   (B) the LAN kiosk has been explicitly bound after an admin Nest login.
 *
 * This module handles the server-side checks for both.
 */

import { verifySession } from "../../../servers/gateway/dashboard/auth.js";

/**
 * Is the request coming from loopback (same-host)?
 * Handles IPv4, IPv6, and IPv4-mapped-IPv6.
 */
export function isLoopback(req) {
  // req.ip respects the `trust proxy` setting. For a same-host request it's
  // 127.0.0.1 or ::1. Behind Caddy/reverse-proxy, x-forwarded-for should be
  // set correctly. Defense-in-depth: also check raw socket.
  const candidates = [
    req.ip,
    req.socket?.remoteAddress,
    req.connection?.remoteAddress,
  ].filter(Boolean);
  for (const addr of candidates) {
    const a = String(addr).replace(/^::ffff:/, "");
    if (a === "127.0.0.1" || a === "::1" || a === "localhost") return true;
  }
  return false;
}

/**
 * Read the maker_lab.solo_lan_exposure setting. Default "off".
 */
export async function getSoloLanExposure(db) {
  try {
    const r = await db.execute({
      sql: "SELECT value FROM dashboard_settings WHERE key = 'maker_lab.solo_lan_exposure'",
      args: [],
    });
    return r.rows[0]?.value === "on" ? "on" : "off";
  } catch {
    return "off";
  }
}

export async function setSoloLanExposure(db, value) {
  const v = value === "on" ? "on" : "off";
  await db.execute({
    sql: `INSERT INTO dashboard_settings (key, value) VALUES ('maker_lab.solo_lan_exposure', ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: [v],
  });
  return v;
}

/**
 * Check whether a fingerprint is recorded in maker_bound_devices.
 * Returns the row (with learner_id) or null.
 */
export async function getBoundDevice(db, fingerprint) {
  if (!fingerprint) return null;
  try {
    const r = await db.execute({
      sql: `SELECT * FROM maker_bound_devices WHERE fingerprint = ?`,
      args: [fingerprint],
    });
    return r.rows[0] || null;
  } catch {
    return null;
  }
}

export async function touchBoundDevice(db, fingerprint) {
  try {
    await db.execute({
      sql: `UPDATE maker_bound_devices SET last_seen_at = datetime('now') WHERE fingerprint = ?`,
      args: [fingerprint],
    });
  } catch {}
}

/**
 * Bind a device fingerprint to a learner. Idempotent (INSERT ON CONFLICT DO UPDATE).
 */
export async function bindDevice(db, { fingerprint, learnerId, label }) {
  await db.execute({
    sql: `INSERT INTO maker_bound_devices (fingerprint, learner_id, label, bound_at, last_seen_at)
          VALUES (?, ?, ?, datetime('now'), datetime('now'))
          ON CONFLICT(fingerprint) DO UPDATE SET
            learner_id = excluded.learner_id,
            label = COALESCE(excluded.label, maker_bound_devices.label),
            last_seen_at = datetime('now')`,
    args: [fingerprint, learnerId, label || null],
  });
}

export async function unbindDevice(db, fingerprint) {
  await db.execute({
    sql: `DELETE FROM maker_bound_devices WHERE fingerprint = ?`,
    args: [fingerprint],
  });
}

export async function listBoundDevices(db) {
  try {
    const r = await db.execute({
      sql: `SELECT bd.fingerprint, bd.learner_id, bd.label, bd.bound_at, bd.last_seen_at,
                   rp.name AS learner_name
            FROM maker_bound_devices bd
            LEFT JOIN research_projects rp ON rp.id = bd.learner_id
            ORDER BY bd.last_seen_at DESC NULLS LAST`,
      args: [],
    });
    return r.rows;
  } catch {
    return [];
  }
}

/**
 * Check the request for a valid Crow's Nest session cookie.
 * Used to auto-bind on first visit when the admin is already logged in.
 */
export async function hasAdminSession(req) {
  try {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies.crow_session;
    if (!token) return false;
    return await verifySession(token);
  } catch {
    return false;
  }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const seg of String(header).split(/;\s*/)) {
    const idx = seg.indexOf("=");
    if (idx < 0) continue;
    out[seg.slice(0, idx).trim()] = seg.slice(idx + 1);
  }
  return out;
}

/**
 * Ensure a default learner exists for solo mode. If none, create one with
 * consent captured (by the admin initiating the binding). Returns the id.
 */
export async function ensureDefaultLearner(db) {
  const r = await db.execute({
    sql: `SELECT id FROM research_projects WHERE type = 'learner_profile' ORDER BY id LIMIT 1`,
    args: [],
  });
  if (r.rows.length) return Number(r.rows[0].id);
  // Create with age null — admin can edit in the settings panel.
  const ins = await db.execute({
    sql: `INSERT INTO research_projects (name, type, created_at, updated_at)
          VALUES ('Default learner', 'learner_profile', datetime('now'), datetime('now'))
          RETURNING id`,
    args: [],
  });
  const lid = Number(ins.rows[0].id);
  await db.execute({
    sql: `INSERT INTO maker_learner_settings (learner_id, age, consent_captured_at)
          VALUES (?, NULL, datetime('now'))`,
    args: [lid],
  });
  return lid;
}
