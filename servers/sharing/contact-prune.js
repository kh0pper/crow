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
 *   3. writeTombstone at **`row.lamport_ts` — the pruned row's OWN lamport** — and marked
 *      **`kind='prune'`**, i.e. GARBAGE COLLECTION rather than an authoritative delete.
 *      The `kind` is what makes the lamport safe to carry: a prune emits nothing, so its
 *      lamport is a LOCAL row lamport, and two instances' row lamports agree only once
 *      every emit has been applied on both sides. One un-replicated `update` on a peer
 *      (a rename, a block) lifts THAT peer's row lamport, so its tombstone outruns a
 *      re-adder's `insert` — and a lamport gate would drop the re-add, then drop every
 *      later `update` from the re-adder unconditionally: permanent divergence, zero
 *      `sync_conflicts`, nothing logged. So the apply gate does NOT compare an `insert`
 *      against a `kind='prune'` tombstone at all (`instance-sync.js` `_applyContact`).
 *      A prune's ONLY job is to block resurrection-by-`update` (defect D3), and every D3
 *      vector IS an `update`; those stay dropped. Worst case, a redelivered ORIGINAL
 *      insert re-creates the row — and the next render simply re-prunes it. Self-healing.
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
  await writeTombstone(db, row.crow_id, row.lamport_ts, "prune");
  return { ok: true };
}
