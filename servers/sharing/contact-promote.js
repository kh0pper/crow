/**
 * Durable handshake state for Crow Messages (R4).
 *
 *  - readIncomingSince / persistIncomingCursor: a persisted, monotonic cursor
 *    for the broad incoming Nostr subscription so an offline gateway resumes
 *    from where it left off instead of a fixed 24h window (kills the L3 cliff).
 *  - upsertFullContact (Task 2): the single idempotent insert/promote/merge
 *    write path for a full (request_status NULL) contact.
 *
 * Every function is guarded — the receive path must never throw.
 */

const CURSOR_KEY = "sharing:incoming_since";
const OVERLAP_SEC = 3600;            // re-fetch a 1h overlap; dedup makes it harmless
const MIN_FLOOR_SEC = 86400;         // always look back >= 24h (never worse than the old fixed window)
const MAX_LOOKBACK_SEC = 30 * 86400; // never replay more than 30d (bounds the relay flood)

/**
 * The `since` floor for subscribeToIncoming, derived from the persisted cursor
 * and CLAMPED in both directions:
 *   - never NEWER than now-24h  → a busy gateway (cursor ~ now) still back-fills
 *     a full day on restart; can't regress vs the old fixed 24h window.
 *   - never OLDER than now-30d  → a long-offline gateway can't flood the public
 *     relays with an unbounded kind-4 replay (which relays truncate, silently
 *     dropping the oldest events = the cliff via a new cause).
 * No cursor / bad db → the plain now-24h default. Never throws.
 */
export async function readIncomingSince(db, nowSec) {
  const floor = nowSec - MIN_FLOOR_SEC;              // newest allowed since
  const lowerBound = nowSec - MAX_LOOKBACK_SEC;      // oldest allowed since
  try {
    if (!db) return floor;
    const { rows } = await db.execute({
      sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: [CURSOR_KEY],
    });
    const stored = Number(rows?.[0]?.value);
    if (!Number.isFinite(stored) || stored <= 0) return floor;
    const desired = stored - OVERLAP_SEC;
    // Clamp: at most now-24h (never regress), at least now-30d (bound flood).
    return Math.max(lowerBound, Math.min(desired, floor));
  } catch {
    return floor;
  }
}

/**
 * Advance the persisted cursor to `createdAtSec` — but only forwards
 * (monotonic). Never throws.
 */
export async function persistIncomingCursor(db, createdAtSec) {
  try {
    if (!db || !Number.isFinite(createdAtSec) || createdAtSec <= 0) return;
    // INSERT-or-advance in one statement: on conflict, keep the larger value.
    await db.execute({
      sql: `INSERT INTO dashboard_settings (key, value, updated_at)
            VALUES (?, ?, datetime('now'))
            ON CONFLICT(key) DO UPDATE SET
              value = CASE WHEN CAST(excluded.value AS INTEGER) > CAST(dashboard_settings.value AS INTEGER)
                           THEN excluded.value ELSE dashboard_settings.value END,
              updated_at = datetime('now')`,
      args: [CURSOR_KEY, String(Math.floor(createdAtSec))],
    });
  } catch {
    // Cursor is an optimization; a write failure must not break delivery.
  }
}
