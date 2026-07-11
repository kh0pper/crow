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

import { normalizePubkey } from "./pubkey-util.js";
import { emitContactChange, emitContactDelete } from "./contact-sync.js";
import { readTombstone, clearTombstone, unwireContact } from "./contact-delete.js";

const HEX_KEY = /^[0-9a-fA-F]{64}(?:[0-9a-fA-F]{2})?$/; // 64 x-only or 66 compressed

/** Wire a full contact into sync feeds, the DHT topic, and the Nostr sub. Each
 * step is independently guarded — a partial-manager (tests) or a transient
 * failure must not abort the upsert (the row is already correct). */
export async function wireFullContact(managers, row) {
  // F-BLOCK-1 D4d belt: no upsert path (tool, accept, invite_accepted) may
  // wire a blocked contact. The wiring returns on unblock (wireSyncedContact).
  if (row?.is_blocked) return;
  const { syncManager, peerManager, nostrManager } = managers || {};
  try { if (syncManager) await syncManager.initContact(row.id, null); } catch {}
  try { if (peerManager) await peerManager.joinContact({ crowId: row.crow_id, ed25519Pubkey: row.ed25519_pubkey }); } catch {}
  try {
    if (nostrManager) await nostrManager.subscribeToContact({
      id: row.id, crow_id: row.crow_id, crowId: row.crow_id,
      secp256k1_pubkey: row.secp256k1_pubkey, display_name: row.display_name,
    });
  } catch {}
}

/**
 * Phase 3: wire a contact that arrived via instance-sync into the live layer.
 *   - blocked   → unsubscribe (close feeds + leave DHT topic), no Nostr sub
 *   - local-bot → no-op (hosted elsewhere; never subscribe on a peer)
 *   - keyless   → no-op (manual address-book entry has no secp key)
 *   - otherwise → wireFullContact (initContact + joinContact + subscribeToContact)
 * Fully guarded — the sync apply loop must never throw.
 */
export async function wireSyncedContact(managers, row) {
  try {
    if (!managers || !row) return;
    if (row.is_blocked) {
      // F-BLOCK-1 D3: FULL teardown. The old inline pair closed feeds + left
      // the DHT but LEFT THE LIVE NOSTR SUB — the cross-instance leg of the
      // finding (a synced block must silence this instance too).
      // unwireContact is the single teardown owner (delete + block paths).
      await unwireContact(managers, row);
      return;
    }
    if (row.origin === "local-bot") return;
    if (!row.secp256k1_pubkey || !HEX_KEY.test(String(row.secp256k1_pubkey))) return; // manual/keyless
    await wireFullContact(managers, row);
  } catch { /* never throw into the sync apply loop */ }
}

export function isPlaceholderName(name) {
  return name == null || name === "" || String(name).startsWith("req:") || String(name).startsWith("crow:");
}

/**
 * Idempotent insert / promote / merge of a FULL (request_status NULL) contact.
 * See the interface block in the plan for the four outcomes. THROWS only on a
 * genuine DB error or invalid input — callers on the receive path must guard.
 * MUST be reached only from an authenticated path (crow_accept_invite tool,
 * crow_add_contact tool, or the invite_accepted handler) — NEVER the plaintext
 * message-request path (promotion is a trust elevation).
 */
export async function upsertFullContact(db, managers, { crowId, ed25519Pub, secp256k1Pub, displayName } = {}) {
  if (!db) throw new Error("upsertFullContact: db required");
  if (!crowId || String(crowId).startsWith("req:")) throw new Error("upsertFullContact: a real crowId is required");
  if (!secp256k1Pub || !HEX_KEY.test(String(secp256k1Pub))) throw new Error("upsertFullContact: a valid secp256k1 pubkey is required");
  const ed = ed25519Pub || "";
  const name = displayName || null;
  const secpNorm = normalizePubkey(secp256k1Pub);

  // D3.2 (R1-C1): read the tombstone ONCE up front. If crowId carries a local
  // tombstone, this instance has APPLIED a delete for it, so any re-create/rebind
  // below is a genuine local re-add — it must clear the tombstone and emit
  // `op="insert"` (NOT `update`), or every peer drops the update forever and the
  // contact resurrects only locally: permanent fleet divergence. By §2.3 this
  // instance's counter already exceeds the tombstone's lamport, so its `insert`
  // clears peers' tombstones. When there is NO tombstone, behavior is byte-
  // identical to today (MERGE/PROMOTE emit `update`, CREATE emits `insert`).
  const tomb = await readTombstone(db, crowId);

  // Deterministic resolution — do NOT use findContactByPubkey (no ORDER BY →
  // arbitrary single row). Get the crowId owner (unique) and ALL secp matches.
  const byCrow = (await db.execute({ sql: "SELECT * FROM contacts WHERE crow_id = ?", args: [crowId] })).rows[0] || null;
  const secpRows = (await db.execute({
    sql: "SELECT * FROM contacts WHERE lower(substr(secp256k1_pubkey,-64)) = ? ORDER BY id ASC",
    args: [secpNorm],
  })).rows;

  // --- MERGE: the crowId owner exists AND a *different* row shares the secp key.
  const otherSecp = byCrow ? secpRows.find((r) => r.id !== byCrow.id) : null;
  if (byCrow && otherSecp) {
    // Fold the other row's messages into the owner (plain UPDATE — globally
    // unique nostr_event_id means no collision; surface a genuine one), then
    // delete the other row and complete the owner.
    await db.execute({ sql: "UPDATE messages SET contact_id = ? WHERE contact_id = ?", args: [byCrow.id, otherSecp.id] });
    await db.execute({ sql: "DELETE FROM contacts WHERE id = ?", args: [otherSecp.id] });
    await db.execute({
      sql: `UPDATE contacts SET request_status = NULL, verified = 0,
              ed25519_pubkey = COALESCE(NULLIF(ed25519_pubkey,''), ?),
              display_name  = COALESCE(NULLIF(display_name,''), ?) WHERE id = ?`,
      args: [ed, name, byCrow.id],
    });
    const row = (await db.execute({ sql: "SELECT * FROM contacts WHERE id = ?", args: [byCrow.id] })).rows[0];
    await wireFullContact(managers, row);
    // Phase 3: the folded row is gone on this instance; propagate its delete +
    // the merged owner to the user's other instances.
    await emitContactDelete(db, otherSecp.crow_id, otherSecp.lamport_ts);
    if (tomb) await clearTombstone(db, crowId);
    await emitContactChange(tomb ? "insert" : "update", row);
    return { contactId: row.id, outcome: "merged" };
  }

  // --- COMPLETE / PROMOTE / NOOP a single existing row: the crowId owner, or a
  // same-secp request row when no owner exists. (byCrow && otherSecp is done.)
  const target = byCrow || secpRows[0] || null;
  if (target) {
    const storedSecp = normalizePubkey(target.secp256k1_pubkey || "");
    const isFull = target.request_status === null || target.request_status === undefined;

    // I1 conflict guard: a trusted contact already owns this crowId with a
    // DIFFERENT key and no separate secp row explains it → refuse to rebind.
    if (byCrow && isFull && storedSecp && storedSecp !== secpNorm) {
      throw new Error(`A contact with Crow ID ${crowId} already exists with a different key`);
    }

    if (isFull && target.crow_id === crowId && storedSecp === secpNorm) {
      if (name && isPlaceholderName(target.display_name)) {
        await db.execute({ sql: "UPDATE contacts SET display_name = ? WHERE id = ?", args: [name, target.id] });
      }
      // Row present + tombstone is a real coexisting state (D3.1(a)): the live
      // row supersedes it. Clear it, but a NOOP emits nothing (as today).
      if (tomb) await clearTombstone(db, crowId);
      return { contactId: target.id, outcome: "noop" };
    }

    // Promote in place. crow_id is only ever set when target is a non-owner
    // (byCrow null) OR target IS the owner (crow_id unchanged) → no UNIQUE risk.
    // NOTE (conscious decision, security-reviewed in Task 5): when byCrow is
    // null and target is an already-FULL contact with the SAME secp key but a
    // DIFFERENT crow_id, this rebinds its crow_id to the input. That is the
    // intended "repair the id" behavior for both the operator tool and an
    // authenticated invite_accepted whose secp is cryptographically bound — the
    // same key-holder is the same peer. No UNIQUE risk (input crow_id unowned).
    await db.execute({
      sql: `UPDATE contacts SET crow_id = ?, secp256k1_pubkey = ?,
              ed25519_pubkey = COALESCE(NULLIF(ed25519_pubkey,''), ?),
              request_status = NULL, verified = 0,
              display_name = CASE WHEN display_name IS NULL OR display_name = '' OR display_name LIKE 'req:%'
                                  THEN ? ELSE display_name END
            WHERE id = ?`,
      args: [crowId, secp256k1Pub, ed, name, target.id],
    });
    const row = (await db.execute({ sql: "SELECT * FROM contacts WHERE id = ?", args: [target.id] })).rows[0];
    await wireFullContact(managers, row);
    if (tomb) await clearTombstone(db, crowId);
    // Phase 3: promoted contact follows the user. D3.2: a tombstoned re-add emits
    // `insert` so peers holding the tombstone apply it instead of dropping it.
    await emitContactChange(tomb ? "insert" : "update", row);
    return { contactId: row.id, outcome: "promoted" };
  }

  // --- CREATE a fresh full contact.
  const ins = await db.execute({
    sql: `INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, contact_type)
          VALUES (?, ?, ?, ?, 'crow')`,
    args: [crowId, name || crowId, ed, secp256k1Pub],
  });
  const row = (await db.execute({ sql: "SELECT * FROM contacts WHERE id = ?", args: [Number(ins.lastInsertRowid)] })).rows[0];
  await wireFullContact(managers, row);
  if (tomb) await clearTombstone(db, crowId); // D3.2: local re-add supersedes the tombstone
  await emitContactChange("insert", row); // Phase 3: new contact follows the user (already insert)
  return { contactId: row.id, outcome: "created" };
}
