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
import { unwireContact, writeTombstone, readTombstone } from "./contact-delete.js";

/**
 * Delete one stale advertised contact. Order is LOAD-BEARING:
 *
 *   1. writeTombstone at **`row.lamport_ts` — the pruned row's OWN lamport** — and marked
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
 *      vector IS an `update`; those stay dropped. A redelivered ORIGINAL insert re-creates
 *      the row — and the next render simply re-prunes it, as a fresh zero-message row
 *      (`_applyContact` will not rebind a `req:` placeholder while a GC tombstone stands,
 *      precisely so this stays true). Self-healing.
 *
 *   2. VERIFY the tombstone landed, and REFUSE the delete if it did not. `writeTombstone`
 *      swallows every error by design (it runs on a receive path and must never throw), so
 *      "delete, then best-effort tombstone" silently produces the one state this whole
 *      feature exists to prevent: the row GONE with nothing to block its resurrection by
 *      the next peer `update`. The failure is not exotic — `"database is locked"` is a
 *      DOCUMENTED recurring failure on this DB. This is the same distrust the `crow_id`
 *      guard below already encodes, extended from "a tombstone is possible" to "a
 *      tombstone actually LANDED".
 *
 *   3. unwireContact — BEFORE the row is removed (an in-flight `subscribeToContact`
 *      onevent INSERT against a deleted contact_id would raise FOREIGN KEY constraint
 *      failed). This also fixes a pre-existing Nostr-subscription leak: the bare DELETE
 *      this replaces never unsubscribed. It runs only once the delete is COMMITTED to,
 *      so a refused prune leaves the contact fully wired.
 *
 *   4. DELETE FROM contacts.
 *
 * A tombstone briefly coexisting with a live row (between 1 and 4, or forever if we
 * refuse at 2) is BENIGN: `_applyContact` rule (a) clears any tombstone whenever a local
 * row exists. Tombstone-then-delete is the strictly safer order.
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

  await writeTombstone(db, row.crow_id, row.lamport_ts, "prune");
  if (!(await readTombstone(db, row.crow_id))) {
    console.warn(
      `[prune] contact ${row.id} (${row.crow_id}): the tombstone did NOT land — refusing to delete. ` +
      `Deleting without one leaves the contact resurrectable by the next peer 'update'. It will be ` +
      `re-attempted on the next render.`,
    );
    return { ok: false, reason: "tombstone-failed" };
  }

  await unwireContact(managers, row);
  await db.execute({ sql: "DELETE FROM contacts WHERE id = ?", args: [row.id] });
  return { ok: true };
}
