/**
 * Advertised-contact prune primitive (spec `2026-07-12-advertised-contact-prune-design.md` §3 F4).
 *
 * Distinct from contact-delete.js's `deleteContactLocal`: that is a USER-initiated
 * delete and it BROADCASTS (`emitContactDelete`). This is garbage collection — the
 * un-advertised bot is gone from this instance's view of its advertiser, and every
 * other instance paired with that advertiser will independently reach the same
 * conclusion from its own view. So the prune writes a LOCAL tombstone and emits
 * NOTHING: no delete on the wire, no host authority, and `sync_conflicts` cannot grow.
 *
 * Imports ONLY from ./contact-delete.js — which is deliberately dependency-free to
 * stay out of the managers.js → nostr.js import cycle (see its header). Do NOT import
 * managers.js here; the caller passes `managers` in.
 */
import { unwireContact, writeTombstone } from "./contact-delete.js";

/**
 * Delete one stale advertised contact. Order is LOAD-BEARING:
 *   1. unwireContact — BEFORE the row is removed (an in-flight `subscribeToContact`
 *      onevent INSERT against a deleted contact_id would raise FOREIGN KEY constraint
 *      failed). This also fixes a pre-existing Nostr-subscription leak: the bare DELETE
 *      this replaces never unsubscribed.
 *   2. DELETE FROM contacts.
 *   3. writeTombstone at **`row.lamport_ts` — the pruned row's OWN lamport**, never a
 *      fresh counter value. The prune emits nothing, so a fresh counter burn is invisible
 *      to the fleet: two instances pruning independently would land on tombstones that a
 *      re-adder's `insert` can TIE with, and the apply gate drops ties
 *      (`instance-sync.js` `lamportTs <= tomb.lamport_ts`) ⇒ permanent, unrecoverable
 *      divergence. The row's own lamport makes the gate exactly right: a replay of an
 *      already-seen `insert` is `<= row.lamport_ts` ⇒ dropped; a genuine re-add is emitted
 *      at the re-adder's next lamport, necessarily `> row.lamport_ts` (its counter advanced
 *      past that row when it applied it) ⇒ applies and clears the tombstone.
 *
 * @param {object} db async db client ({ execute })
 * @param {object|null} managers { nostrManager?, syncManager?, peerManager? } — null/partial is fine
 * @param {{id:number, crow_id:string, lamport_ts:number}} row
 * @returns {Promise<{ok:true}|{ok:false, reason:string}>}
 */
export async function pruneAdvertisedContact(db, managers, row) {
  if (!db || !row || row.id == null) return { ok: false, reason: "no-row" };
  // No crow_id ⇒ no tombstone is possible (writeTombstone silently no-ops on a falsy
  // id) ⇒ the delete would be resurrectable. Refuse rather than ship a silent no-op.
  if (!row.crow_id) return { ok: false, reason: "no-crow-id" };
  await unwireContact(managers, row);
  await db.execute({ sql: "DELETE FROM contacts WHERE id = ?", args: [row.id] });
  await writeTombstone(db, row.crow_id, row.lamport_ts);
  return { ok: true };
}
