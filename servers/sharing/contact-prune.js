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
import { unwireContact, readTombstone, tombstoneStatement } from "./contact-delete.js";

/**
 * Delete one stale advertised contact.
 *
 * ── The tombstone is `kind='prune'`, at the row's OWN `lamport_ts` ──
 * A prune emits nothing, so its lamport is a LOCAL row lamport, and two instances' row
 * lamports agree only once every emit has been applied on both sides. One un-replicated
 * `update` on a peer (a rename, a block) lifts THAT peer's row lamport, so its tombstone
 * outruns a re-adder's `insert` — and a lamport gate would drop the re-add, then drop
 * every later `update` from the re-adder unconditionally: permanent divergence, zero
 * `sync_conflicts`, nothing logged. So the apply gate does NOT compare an `insert` against
 * a `kind='prune'` tombstone at all (`instance-sync.js` `_applyContact`). A prune's ONLY
 * job is to block resurrection-by-`update` (defect D3) — and every D3 vector IS an
 * `update`; those stay dropped.
 *
 * ── ⚠️ The DELETE and the tombstone MUST be ATOMIC. Neither ordering is safe alone. ──
 *   - **tombstone → DELETE** leaves a tombstone beside a LIVE row, and `_applyContact`
 *     rule (a) clears any tombstone whenever a local row exists. Nothing serializes the
 *     receive path against the render that calls the prune, and `unwireContact` awaits real
 *     network teardown — so a concurrent inbound entry for this `crow_id` (a peer's boot
 *     backfill, a rename, a block — and peers are touching this contact right now, because
 *     they all see the same directory change) STRIPS the tombstone inside that window. The
 *     DELETE then lands untombstoned ⇒ resurrectable ⇒ defect D3, restored, silently.
 *   - **DELETE → tombstone** leaves the row GONE with no tombstone if the tombstone write
 *     fails — and `writeTombstone` swallows every error by design (it runs on a receive
 *     path and must never throw), while `"database is locked"` is a DOCUMENTED recurring
 *     failure on this DB.
 * So both statements go in ONE `db.batch()` (which wraps them in a single transaction):
 * either both land or neither does. A failed transaction leaves the contact fully intact
 * and fully wired, and the next render simply re-attempts.
 *
 * `unwireContact` still runs BEFORE the transaction — an in-flight `subscribeToContact`
 * onevent INSERT against a deleted `contact_id` would otherwise raise FOREIGN KEY
 * constraint failed. (It also fixes a pre-existing Nostr-subscription leak: the bare DELETE
 * this replaces never unsubscribed.) If the transaction then fails we have unwired a
 * surviving contact; that self-heals on the next restart's re-wire and is far cheaper than
 * an untombstoned delete.
 *
 * ── Scope of "self-healing" (do NOT overclaim this — it is load-bearing) ──
 * A redelivered ORIGINAL `insert` re-creates the row, and the next render re-prunes it as a
 * fresh zero-message row (`_applyContact` will not rebind a `req:` placeholder while a GC
 * tombstone stands, precisely so this stays true). **That holds only until the bot's next
 * DM.** The re-created row is wired for Nostr, so if the still-running bot messages the user
 * before that next render, the row acquires a message and prune rule 5 (zero messages —
 * history is never destroyed) makes it PERMANENTLY un-prunable, alongside the `req:` row for
 * the same key. That end state is not a defect — it is the design's fail-safe axis (keep,
 * never delete; no history lost) and it is strictly better than resurrecting the contact by
 * stealing the message request's DM. But it is NOT "self-healing", and this feature's entire
 * failure history is an asserted invariant whose premise was later quietly removed.
 *
 * @param {object} db async db client ({ execute, batch })
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

  // ONE transaction: the DELETE and the tombstone land together or not at all (see above —
  // both orderings are unsafe on their own, in opposite directions).
  try {
    await db.batch([
      { sql: "DELETE FROM contacts WHERE id = ?", args: [row.id] },
      tombstoneStatement(row.crow_id, row.lamport_ts, "prune"),
    ]);
  } catch (err) {
    console.warn(
      `[prune] contact ${row.id} (${row.crow_id}): the delete+tombstone transaction FAILED ` +
      `(${err?.message || "unknown"}) — the contact is intact and will be re-attempted on the ` +
      `next render. Deleting without a tombstone would leave it resurrectable by the next peer 'update'.`,
    );
    return { ok: false, reason: "prune-txn-failed" };
  }

  // Belt-and-braces: the transaction committed, so this must hold. If it somehow does not,
  // the row is already gone and we cannot undo it — so make it LOUD rather than silent.
  if (!(await readTombstone(db, row.crow_id))) {
    console.error(
      `[prune] contact ${row.id} (${row.crow_id}): the delete COMMITTED but no tombstone is ` +
      `readable. The contact is now resurrectable by the next peer 'update'.`,
    );
    return { ok: false, reason: "tombstone-lost" };
  }
  return { ok: true };
}
