/**
 * Delivery reliability for Crow Messages (R5).
 *
 * One responsibility: durable outbound-DM delivery state so a message a
 * recipient did not receive (offline/asleep, or evicted by public-relay
 * retention) is recovered instead of silently lost.
 *
 *  - buildDeliveryReceipt / DELIVERY_RECEIPT_SUBTYPE — the crow_social ack
 *    the recipient publishes on receipt; the sender flips relayed→delivered.
 *  - shouldEnqueue / backoffSeconds — pure send-side policy.
 *  - enqueueRetry / dueRetries / recordAttempt / markDelivered — the persisted
 *    message_retry_queue (holds the EXACT serialized signed event so a retry
 *    re-publishes the same event.id and the recipient dedups it).
 *
 * Every DB helper is guarded — the receive path and the retry loop must never
 * throw.
 */

import { normalizePubkey } from "./pubkey-util.js";

export const DELIVERY_RECEIPT_SUBTYPE = "delivery_receipt";

// Delay (seconds) before the Nth retry. Attempt 1 fires ~30s after send; the
// tail repeats every 12h until the ~60h expiry (see recordAttempt's maxAgeSec).
const BACKOFF_SCHEDULE = [30, 120, 600, 3600, 14400, 43200];

/** Pure: the crow_social envelope the recipient sends to confirm receipt. */
export function buildDeliveryReceipt(eventIds) {
  const ids = (Array.isArray(eventIds) ? eventIds : [])
    .filter((x) => typeof x === "string" && x.length > 0);
  return JSON.stringify({
    type: "crow_social",
    version: 1,
    subtype: DELIVERY_RECEIPT_SUBTYPE,
    payload: { event_ids: ids },
  });
}

export const HANDSHAKE_COMPLETE_SUBTYPE = "handshake_complete";

/** Pure: the crow_social ack an inviter sends when it has processed an
 * authenticated invite_accepted. Names the invite_accepted event id(s) so the
 * acceptor clears the exact retry row (markDelivered, contact-bound). Mirrors
 * buildDeliveryReceipt — a lost ack self-heals on the acceptor's next retry /
 * the inviter's next restart (the "replayed" re-ack). */
export function buildHandshakeComplete(eventIds) {
  const ids = (Array.isArray(eventIds) ? eventIds : [])
    .filter((x) => typeof x === "string" && x.length > 0);
  return JSON.stringify({
    type: "crow_social",
    version: 1,
    subtype: HANDSHAKE_COMPLETE_SUBTYPE,
    payload: { event_ids: ids },
  });
}

/**
 * Pure: is this send retry-eligible? True only for a genuine 1:1 DM that
 * reached >=1 relay, is not addressed to ourselves, and is not a crow_social /
 * invite_accepted control envelope (those are never stored or acked by the
 * recipient, so a retry would loop forever until expiry). Mirrors the
 * recipient's store+ack eligibility so enqueue <=> "the recipient will ack".
 */
export function shouldEnqueue({ content, publishedCount, recipientNorm, ownNorm }) {
  if (!(publishedCount > 0)) return false;
  if (recipientNorm && ownNorm && recipientNorm === ownNorm) return false;
  if (typeof content === "string" && content.startsWith("{")) {
    try {
      const t = JSON.parse(content)?.type;
      if (t === "crow_social" || t === "invite_accepted") return false;
    } catch {
      // starts with "{" but isn't JSON → a plain message; enqueue it.
    }
  }
  return true;
}

/** Pure: delay before attempt N (N>=1), clamped to the last schedule entry. */
export function backoffSeconds(attempt) {
  const i = Math.max(1, Math.floor(Number(attempt) || 1)) - 1;
  return BACKOFF_SCHEDULE[Math.min(i, BACKOFF_SCHEDULE.length - 1)];
}

/** Persist an unacked outbound DM for retry. INSERT OR IGNORE (event id unique). */
export async function enqueueRetry(db, { eventId, contactId, recipientPubkey, rawEvent, nowSec }) {
  try {
    if (!db || !eventId || !rawEvent) return;
    await db.execute({
      sql: `INSERT OR IGNORE INTO message_retry_queue
              (nostr_event_id, contact_id, recipient_pubkey, raw_event, attempt_count, next_attempt_at, created_at)
            VALUES (?, ?, ?, ?, 0, ?, ?)`,
      args: [eventId, contactId ?? null, recipientPubkey ?? null, rawEvent,
             Math.floor(nowSec) + backoffSeconds(1), Math.floor(nowSec)],
    });
  } catch {
    // Retry is an optimization; a queue-write failure must not break send.
  }
}

/** Rows whose next attempt is due. Guarded → []. */
export async function dueRetries(db, nowSec, limit = 50) {
  try {
    if (!db) return [];
    const { rows } = await db.execute({
      sql: `SELECT * FROM message_retry_queue WHERE next_attempt_at <= ?
            ORDER BY next_attempt_at ASC LIMIT ?`,
      args: [Math.floor(nowSec), limit],
    });
    return rows || [];
  } catch {
    return [];
  }
}

/**
 * After a republish: expire the row (delete) if older than maxAgeSec, else
 * advance attempt_count + reschedule. Guarded → {expired:false} (leave for a
 * later tick).
 */
export async function recordAttempt(db, row, nowSec, maxAgeSec) {
  try {
    if (!db || !row) return { expired: false };
    if (Number(row.created_at) < Math.floor(nowSec) - maxAgeSec) {
      await db.execute({ sql: "DELETE FROM message_retry_queue WHERE id = ?", args: [row.id] });
      return { expired: true };
    }
    const nextAttempt = Number(row.attempt_count) + 1;
    await db.execute({
      sql: `UPDATE message_retry_queue SET attempt_count = ?, next_attempt_at = ? WHERE id = ?`,
      args: [nextAttempt, Math.floor(nowSec) + backoffSeconds(nextAttempt + 1), row.id],
    });
    return { expired: false };
  } catch {
    return { expired: false };
  }
}

/**
 * Clear retry rows for delivered events — CONTACT-BOUND so a forged receipt
 * naming another contact's event ids cannot purge that contact's retries.
 */
export async function markDelivered(db, eventIds, contactId) {
  try {
    const ids = (Array.isArray(eventIds) ? eventIds : []).filter((x) => typeof x === "string" && x);
    if (!db || ids.length === 0 || contactId == null) return;
    const placeholders = ids.map(() => "?").join(",");
    await db.execute({
      sql: `DELETE FROM message_retry_queue WHERE contact_id = ? AND nostr_event_id IN (${placeholders})`,
      args: [contactId, ...ids],
    });
  } catch {
    // Best-effort cleanup; the row will otherwise expire on its own.
  }
}

// normalizePubkey re-exported for callers that compute recipient/own norms.
export { normalizePubkey };
