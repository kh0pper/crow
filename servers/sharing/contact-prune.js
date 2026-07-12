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
 * STATICALLY imports only ./contact-delete.js — which is deliberately dependency-free to
 * stay out of the managers.js → nostr.js import cycle (see its header). Do NOT import
 * managers.js here; the caller passes `managers` in. The one exception is a LAZY dynamic
 * import of ./contact-promote.js on the prune's failure path (to re-wire a contact that
 * survived a failed transaction — see `pruneAdvertisedContact`). That is acyclic: nothing on
 * the managers → nostr → contact-promote chain imports THIS module (its only importer,
 * panels/messages/data-queries.js, imports it dynamically), and it is verified to resolve in
 * both module-init orders. Keep it lazy anyway.
 */
import { unwireContact, readTombstone, tombstoneStatement, isReqId } from "./contact-delete.js";

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
 * this replaces never unsubscribed.) But if the transaction then FAILS we have unwired a
 * contact that SURVIVED — and that is NOT benign: `boot.js`'s global-inbox catch-all
 * early-returns for a full contact (`request_status` NULL) on the grounds that its
 * per-contact subscription is handling the DM, which we just closed. The bot's next message
 * would be neither stored nor filed as a request — it would silently VANISH. So the failure
 * path RE-WIRES the surviving contact (see the catch).
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
  // `tombstoneStatement` deliberately bypasses writeTombstone's guards so it can join the
  // batch — so the `req:` guard has to be re-asserted HERE, or we would DELETE the row and
  // write a `req:`-keyed tombstone that readTombstone/clearTombstone can never see (both
  // no-op on `req:`), violating the table's stated invariant and failing OPEN. No live path
  // reaches this today (the prune's SELECT needs a non-NULL advertised_by, and `req:` rows
  // never sync) — but "unreachable" premises have evaporated twice on this branch already.
  if (isReqId(row.crow_id)) return { ok: false, reason: "req-id" };

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
    // RE-WIRE. We already unwired, and the row SURVIVED — an alive-but-torn-down contact is
    // NOT benign, it SILENTLY LOSES THE BOT'S NEXT DM. boot.js's global-inbox catch-all
    // early-returns for a full contact (`request_status` NULL) precisely because "the
    // per-contact subscription is already handling it" — and we just closed that
    // subscription. The DM would be neither stored on the contact nor filed as a message
    // request: it would simply vanish. (An un-advertised bot is not a dead bot — that is the
    // premise of the whole message-request semantic.) Nothing re-wires before the next
    // gateway restart or inbound sync entry, so do it here.
    try {
      const { rows } = await db.execute({ sql: "SELECT * FROM contacts WHERE id = ?", args: [row.id] });
      if (rows[0]) {
        // Lazy dynamic import: contact-promote sits on the managers → nostr chain, and this
        // module must stay off it (see the header). Same pattern as contact-delete's loadSyncMod.
        const { wireFullContact } = await import("./contact-promote.js");
        // rows[0], NOT `row`: `row` is the prune's 3-field skeleton (id/crow_id/lamport_ts),
        // so `is_blocked` would read undefined and defeat wireFullContact's blocked guard —
        // re-subscribing a BLOCKED contact, with undefined pubkeys.
        await wireFullContact(managers, rows[0]);
      }
    } catch (reErr) {
      // Do NOT swallow this. Landing here means the contact is alive and STILL UNWIRED —
      // exactly the state the re-wire exists to prevent, and its symptom (the bot's next DM
      // silently vanishing) is invisible. Every other failure on this path is loud; so is this.
      console.warn(
        `[prune] contact ${row.id} (${row.crow_id}): the prune failed AND re-wiring it failed ` +
        `(${reErr?.message || "unknown"}) — the contact is alive but torn down, so the bot's next ` +
        `DM will be dropped. It re-wires on the next gateway restart or inbound sync entry.`,
      );
    }
    return { ok: false, reason: "prune-txn-failed" };
  }

  // Belt-and-braces: the transaction committed, so this must hold. If it somehow does not,
  // the row is already gone and we cannot undo it — so make it LOUD rather than silent.
  if (!(await readTombstone(db, row.crow_id))) {
    // Not necessarily data loss: readTombstone returns null on ANY read error, and a peer's
    // legitimate `insert` can re-create the row and clear this tombstone (clearTombAfterApply)
    // in the window between the commit and this read. So report it as needing a look, not as a
    // certainty — but never as silence: if it IS real, the contact is resurrectable and nothing
    // else would ever say so.
    console.warn(
      `[prune] contact ${row.id} (${row.crow_id}): the delete COMMITTED but no tombstone reads ` +
      `back. Either a transient read error, a peer's concurrent re-add (benign), or the contact ` +
      `is now resurrectable by the next peer 'update'. Worth checking contact_tombstones.`,
    );
    return { ok: false, reason: "tombstone-lost" };
  }
  return { ok: true };
}
