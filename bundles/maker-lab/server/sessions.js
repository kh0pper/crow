/**
 * Maker Lab — session minting helpers.
 *
 * Single source of truth for creating sessions + redemption codes.
 * Used by:
 *   - server.js MCP tools (maker_start_session, maker_start_sessions_bulk,
 *     maker_start_guest_session)
 *   - panel/maker-lab.js (admin panel Start-session button)
 *
 * Centralized so the code/token minting format, expiry math, and
 * snapshot-at-start contract for transcripts live in one place.
 */

import { randomBytes, randomUUID } from "node:crypto";

export const SESSION_DEFAULT_MIN = 60;
export const SESSION_MAX_MIN = 240;
export const GUEST_MAX_MIN = 30;
export const CODE_TTL_MIN = 10;

export function mintToken() {
  return randomBytes(24).toString("base64url");
}

export function mintRedemptionCode() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I, O
  const N = "23456789"; // no 0, 1
  const pick = (s) => s[Math.floor(Math.random() * s.length)];
  return `${pick(A)}${pick(A)}${pick(A)}-${pick(N)}${pick(N)}${pick(N)}`;
}

export function addMinutesISO(min) {
  return new Date(Date.now() + min * 60_000).toISOString();
}

/**
 * Mint a session for a learner + insert a one-shot redemption code.
 * Returns { sessionToken, redemptionCode, codeExpiresAt, sessionExpiresAt,
 *           learnerName, batchId }.
 */
export async function mintSessionForLearner(db, { learnerId, durationMin = SESSION_DEFAULT_MIN, idleLockMin, batchId = null }) {
  const r = await db.execute({
    sql: `SELECT rp.id, rp.name, mls.transcripts_enabled, mls.idle_lock_default_min
          FROM research_projects rp
          LEFT JOIN maker_learner_settings mls ON mls.learner_id = rp.id
          WHERE rp.id = ? AND rp.type = 'learner_profile'`,
    args: [learnerId],
  });
  if (!r.rows.length) {
    const err = new Error(`Learner ${learnerId} not found`);
    err.code = "learner_not_found";
    throw err;
  }
  const learner = r.rows[0];
  const sessionToken = mintToken();
  const redemptionCode = mintRedemptionCode();
  const sessionExpiresAt = addMinutesISO(Math.min(durationMin, SESSION_MAX_MIN));
  const codeExpiresAt = addMinutesISO(CODE_TTL_MIN);
  const idleMin = idleLockMin ?? learner.idle_lock_default_min ?? null;

  await db.execute({
    sql: `INSERT INTO maker_sessions
          (token, learner_id, is_guest, expires_at, idle_lock_min, transcripts_enabled_snapshot, batch_id)
          VALUES (?, ?, 0, ?, ?, ?, ?)`,
    args: [sessionToken, learnerId, sessionExpiresAt, idleMin, learner.transcripts_enabled ? 1 : 0, batchId],
  });
  await db.execute({
    sql: `INSERT INTO maker_redemption_codes (code, session_token, expires_at) VALUES (?, ?, ?)`,
    args: [redemptionCode, sessionToken, codeExpiresAt],
  });

  return {
    sessionToken, redemptionCode, codeExpiresAt, sessionExpiresAt,
    learnerId, learnerName: learner.name, batchId,
    shortUrl: `/kiosk/r/${redemptionCode}`,
  };
}

/**
 * Mint an ephemeral guest session. No learner profile; no memories;
 * no transcripts; no artifact persistence. 30-min cap.
 */
export async function mintGuestSession(db, { ageBand }) {
  const sessionToken = mintToken();
  const redemptionCode = mintRedemptionCode();
  const sessionExpiresAt = addMinutesISO(GUEST_MAX_MIN);
  const codeExpiresAt = addMinutesISO(CODE_TTL_MIN);

  await db.execute({
    sql: `INSERT INTO maker_sessions
          (token, learner_id, is_guest, guest_age_band, expires_at, transcripts_enabled_snapshot)
          VALUES (?, NULL, 1, ?, ?, 0)`,
    args: [sessionToken, ageBand, sessionExpiresAt],
  });
  await db.execute({
    sql: `INSERT INTO maker_redemption_codes (code, session_token, expires_at) VALUES (?, ?, ?)`,
    args: [redemptionCode, sessionToken, codeExpiresAt],
  });

  return {
    sessionToken, redemptionCode, codeExpiresAt, sessionExpiresAt,
    ageBand, isGuest: true,
    shortUrl: `/kiosk/r/${redemptionCode}`,
  };
}

/**
 * Create a batch + mint sessions for an array of learner ids sharing
 * the same batch_id. Returns { batchId, sessions: [...], errors: [...] }.
 */
export async function mintBatchSessions(db, { learnerIds, durationMin, idleLockMin, batchLabel }) {
  const batchId = randomUUID();
  await db.execute({
    sql: `INSERT INTO maker_batches (batch_id, label) VALUES (?, ?)`,
    args: [batchId, batchLabel || null],
  });
  const sessions = [];
  const errors = [];
  for (const lid of learnerIds) {
    try {
      const r = await mintSessionForLearner(db, { learnerId: lid, durationMin, idleLockMin, batchId });
      sessions.push(r);
    } catch (err) {
      errors.push({ learner_id: lid, error: err.code || "error", message: err.message });
    }
  }
  return { batchId, batchLabel: batchLabel || null, sessions, errors };
}
