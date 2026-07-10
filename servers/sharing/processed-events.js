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
