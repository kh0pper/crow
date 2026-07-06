/**
 * Phase 3 PR-B (S3): push message inserts onto the instance-sync mesh so 1:1
 * threads read coherently across a user's paired instances.
 *
 * Guarded + null-safe — a sync failure never breaks the local write, and the
 * sink is null pre-boot / in unit tests (no-op). Only INSERTs are emitted;
 * messages are immutable + keyed on nostr_event_id (UNIQUE), so there is no
 * update/delete wire op. The wire row carries the contact's stable crow_id
 * (JOINed here) — instance-sync's EXCLUDED_COLUMNS.messages strips the per-instance
 * id/contact_id on emit (there is NO OUTBOUND_TRANSFORMS.messages); _applyMessage
 * maps crow_id → local contact_id on the peer.
 *
 * managers.js → nostr.js → message-sync.js would form a require cycle if we
 * STATIC-import managers here (nostr.js imports this module). Lazy (cached)
 * dynamic import keeps the load graph acyclic — identical to contact-sync.js.
 */
let _mgrMod = null;
let _testSink = null;
export function __setEmitSinkForTest(sink) { _testSink = sink; }

async function sink() {
  if (_testSink) return _testSink;
  if (!_mgrMod) { try { _mgrMod = await import("./managers.js"); } catch { return null; } }
  return _mgrMod.getInstanceSyncManager?.() || null;
}

/**
 * Emit an INSERT for the message identified by (contactId, nostrEventId).
 * Re-selects the row JOINed to its contact's crow_id; forwards the FULL local
 * row (id + contact_id retained so emitChange's ~:581 lamport stamp works) with
 * crow_id attached. No emit when the row is missing, the event id is falsy, or
 * the contact has no crow_id. Never throws.
 */
export async function emitMessageInsert(db, { contactId, nostrEventId } = {}) {
  try {
    if (!db || !contactId || !nostrEventId) return;
    const { rows } = await db.execute({
      sql: `SELECT m.*, c.crow_id AS crow_id
              FROM messages m JOIN contacts c ON c.id = m.contact_id
             WHERE m.contact_id = ? AND m.nostr_event_id = ?
             LIMIT 1`,
      args: [contactId, nostrEventId],
    });
    const row = rows[0];
    if (!row || !row.nostr_event_id || !row.crow_id) return;
    await (await sink())?.emitChange("messages", "insert", row);
  } catch { /* never throw — coherence is best-effort */ }
}
