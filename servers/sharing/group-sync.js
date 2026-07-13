/**
 * Phase 3 (groups follow the user): push PLAIN contact-group mutations onto the
 * instance-sync mesh so a user's organizational groups + membership appear on
 * every paired instance.
 *
 * Guarded + null-safe — a sync failure never breaks the local write, and the
 * sink is null pre-boot / in unit tests (no-op). Groups are keyed on the stable
 * group_uid; membership travels as a wire-map of member contact crow_ids attached
 * here via a JOIN (the per-instance group_id/contact_id are never portable).
 *
 * ROOMS ARE EXCLUDED: a contact_groups row with a non-NULL room_uid IS a
 * multi-party Crow Messages room with its OWN Nostr fan-out (room_messages /
 * room-inbound.js). emitGroupUpsert no-ops on such rows; shouldSyncRow drops them
 * again both directions (defense in depth).
 *
 * managers.js → nostr.js → group-sync.js would form a require cycle under a
 * static import; the cached lazy dynamic import keeps the graph acyclic — identical
 * to contact-sync.js / message-sync.js. Do NOT "simplify" to a static import.
 */
import { isGroupTombstoned } from "./group-delete.js";

let _mgrMod = null;
let _testSink = null;
export function __setEmitSinkForTest(sink) { _testSink = sink; }

async function sink() {
  if (_testSink) return _testSink;
  if (!_mgrMod) { try { _mgrMod = await import("./managers.js"); } catch { return null; } }
  return _mgrMod.getInstanceSyncManager?.() || null;
}

/**
 * Emit an upsert for a plain group: re-select it, skip if it is a room or lacks a
 * group_uid, attach the full member-crow_id wire-map, forward the FULL local row
 * (id retained for emitChange's lamport stamp). Never throws.
 */
export async function emitGroupUpsert(db, groupId) {
  try {
    if (!db || !groupId) return;
    const { rows } = await db.execute({
      sql: "SELECT * FROM contact_groups WHERE id = ? LIMIT 1",
      args: [groupId],
    });
    const row = rows[0];
    if (!row || row.room_uid != null || !row.group_uid) return; // room / keyless → skip
    // G2 (design §3.3): never emit for a tombstoned uid. Belt-and-braces for
    // the anomalous live-row-beside-tombstone state (§3.6 — reachable only via
    // a race or manual DB edit; G1 on receivers is the load-bearing guard, so
    // this just stops the pointless emit at the source). isGroupTombstoned is
    // FAIL-OPEN: a read failure (e.g. a missing group_tombstones table under a
    // stale session-spawned server on an un-migrated DB) returns false and the
    // emit PROCEEDS — a read failure must never silently kill every group sync
    // emit from this process (crow_create_message_group, the boot backfill).
    if (await isGroupTombstoned(db, row.group_uid)) return;
    // I2: attach ONLY syncable members — exclude local-bot origin and pending
    // (unestablished) memberships, which the peer must never learn about.
    const { rows: mem } = await db.execute({
      sql: `SELECT c.crow_id AS crow_id
              FROM contact_group_members gm JOIN contacts c ON c.id = gm.contact_id
             WHERE gm.group_id = ?
               AND c.crow_id IS NOT NULL
               AND (c.origin IS NULL OR c.origin != 'local-bot')
               AND (c.request_status IS NULL OR c.request_status = 'accepted')`,
      args: [groupId],
    });
    row.members = mem.map((r) => r.crow_id).filter(Boolean);
    await (await sink())?.emitChange("contact_groups", "update", row);
  } catch { /* never throw — group sync is best-effort */ }
}

/** Emit a group delete by its stable group_uid. Capture the uid BEFORE the local DELETE. */
export async function emitGroupDelete(groupUid) {
  if (!groupUid) return;
  try { await (await sink())?.emitChange("contact_groups", "delete", { group_uid: groupUid }); }
  catch { /* never throw */ }
}
