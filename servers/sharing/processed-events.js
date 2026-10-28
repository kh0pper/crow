/**
 * Clock-free replay hygiene for authenticated control events (design §D4).
 *
 * R5's retry loop re-publishes the EXACT stored signed `invite_accepted` event
 * for up to ~60h. Without this ledger a stale retry, arriving after the user
 * deleted the contact, silently re-adds it — a remote party reversing a local
 * deletion. A stale retry is not "old" (comparing two machines' unsynced wall
 * clocks was rejected in review): it is *the same event*. We record every
 * successfully-handled `event.id` and skip the upsert on a repeat (still acking,
 * to stop the peer's retry loop).
 *
 * Zero sharing-layer imports; both helpers are guarded — the receive path must
 * never throw.
 */

/**
 * Has this control event.id already been handled?
 * @param {object} db async db client ({ execute })
 * @param {string} eventId
 * @returns {Promise<boolean>} false on any error / missing input.
 */
export async function wasProcessed(db, eventId) {
  if (!db || !eventId) return false;
  try {
    const { rows } = await db.execute({
      sql: "SELECT 1 FROM processed_control_events WHERE event_id = ? LIMIT 1",
      args: [eventId],
    });
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * Record a handled control event.id (INSERT OR IGNORE), then opportunistically
 * prune rows older than 30 days — 30d >> the ~60h retry window, so no
 * still-retryable event id can be pruned. Never throws.
 * @param {object} db async db client
 * @param {string} eventId
 * @param {string} kind e.g. "invite_accepted"
 */
export async function recordProcessedEvent(db, eventId, kind) {
  if (!db || !eventId) return;
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    await db.execute({
      sql: "INSERT OR IGNORE INTO processed_control_events (event_id, kind, seen_at) VALUES (?, ?, ?)",
      args: [eventId, kind || "", nowSec],
    });
    await db.execute({
      sql: "DELETE FROM processed_control_events WHERE seen_at < ?",
      args: [nowSec - 30 * 86400],
    });
  } catch {
    // The ledger is an optimization; a write failure must not break pairing.
  }
}

// ─── claimOnce: a fail-CLOSED, cross-process "run this at most once" ───
//
// The helpers above fail open (a read error means "not seen", a write error
// is ignored), which is right for the pairing ack but wrong for anything that
// RUNS work: a replayed bot_relay task must never run twice, and several
// processes (gateway and stdio sharing servers) share one DB and each receive
// the same Nostr event. claimOnce is the claim: the first INSERT wins, every
// later caller (any process) loses, and an insert error loses too.

const PRUNE_EVERY_MS = 60 * 60 * 1000;
const CLAIM_LOG_EVERY_MS = 60_000;
const RETENTION_SEC = 30 * 86400;
let _lastPruneMs = 0;
let _lastClaimLogMs = 0;

/** Test seam: forget the prune and log timers. */
export function _resetClaimOnceForTest() {
  _lastPruneMs = 0;
  _lastClaimLogMs = 0;
}

/**
 * Claim `key` in processed_control_events. True only when THIS call inserted
 * the row (rowsAffected === 1); a repeat, a missing input or an insert error
 * is false (fail closed; an insert error is logged at most once a minute).
 * The 30-day prune (at most once an hour) runs after the insert in its own
 * try: a prune error is logged and never changes the result, so a claimed row
 * can never strand its task.
 * @param {object} db async db client ({ execute })
 * @param {string} key namespaced, e.g. "bot_relay:<relay_id>"
 * @param {string} kind
 * @returns {Promise<boolean>}
 */
export async function claimOnce(db, key, kind) {
  if (!db || typeof key !== "string" || !key) return false;
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  let claimed = false;
  try {
    const r = await db.execute({
      sql: "INSERT OR IGNORE INTO processed_control_events (event_id, kind, seen_at) VALUES (?, ?, ?)",
      args: [key, kind || "", nowSec],
    });
    claimed = Number(r?.rowsAffected) === 1;
  } catch (err) {
    if (nowMs - _lastClaimLogMs >= CLAIM_LOG_EVERY_MS) {
      _lastClaimLogMs = nowMs;
      try { console.warn(`[sharing] claim failed for ${String(kind).slice(0, 32)}; not handled (fail closed): ${err?.message}`); } catch {}
    }
    return false;
  }
  if (nowMs - _lastPruneMs >= PRUNE_EVERY_MS) {
    _lastPruneMs = nowMs;
    try {
      await db.execute({
        sql: "DELETE FROM processed_control_events WHERE seen_at < ?",
        args: [nowSec - RETENTION_SEC],
      });
    } catch (err) {
      try { console.warn(`[sharing] processed_control_events prune failed: ${err?.message}`); } catch {}
    }
  }
  return claimed;
}
