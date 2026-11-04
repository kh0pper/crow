/**
 * The Crow-to-Crow transport: ONE place that decides which PeerManager call a
 * delivered frame uses, so no send site can quietly bind `peerManager.send`.
 *
 * A c2c frame names its target: `to_instance_id` is the instance that must apply
 * it (an accept, a role change, an unshare). Paired siblings share one Crow id
 * (all of one user's instances have one identity and one pinned key), so
 * `send(crowId, …)` — "the newest connection of that Crow id" — can land on a
 * sibling that must answer `not_home` and hold the frame (L1 before S11). A
 * targeted frame therefore goes through `sendTo(crowId, instanceId, …)`, and only
 * a frame with no target (`'*'`: an invite before the visitor is known, an
 * unshare of a member that never accepted) uses `send`, whose semantics are
 * exactly right for it ("whoever is there").
 *
 * `sendTo` returns `false` when the named instance has no live connection here:
 * the outbox keeps the frame (S11), it never falls back to another sibling.
 * Nothing in this module throws for "not reachable"; a real write failure still
 * throws out of `send`/`sendTo` and stops the flush, as before.
 */
import { RefusalLog } from "../contact-binding.js";

const OWN_CROW_LOG_EVERY_MS = 3_600_000;
// A c2c frame addressed to our own Crow id is a caller bug (a sibling link is not
// a contact), not a steady state: one line per hour is enough.
const ownCrowLog = new RefusalLog({ max: 8, intervalMs: OWN_CROW_LOG_EVERY_MS });

/**
 * Send one c2c frame to `crowId` through the right PeerManager call.
 *
 * @param {object} peerManager the local manager (anything with `send`; `sendTo`
 *   and `identity` are optional so an older or stub manager keeps working)
 * @param {string} crowId the CONTACT's Crow id — never our own (see below)
 * @param {object} frame the frame as stored in the outbox
 * @returns {boolean} whether a line was written. `false` = the named instance is
 *   not reachable now, so the caller holds the frame (S11).
 */
export function c2cSend(peerManager, crowId, frame) {
  if (!peerManager || typeof peerManager.send !== "function") {
    throw new Error("c2c: no peer manager to send with");
  }
  // Every instance of a Crow shares one identity, so a sibling connection sits in
  // OUR OWN crowId's bucket (peer-manager.js). A c2c frame is for a contact: sending
  // it there would hand a project frame to another instance of ourselves.
  const own = peerManager.identity?.crowId;
  if (typeof own === "string" && own && crowId === own) {
    if (ownCrowLog.shouldLog(String(crowId))) {
      console.warn("[c2c] refused to send a c2c frame on our own Crow id: a sibling link is not a contact");
    }
    return false;
  }
  const to = frame?.to_instance_id ?? null;
  if (to === null || typeof peerManager.sendTo !== "function") {
    peerManager.send(crowId, frame);
    return true; // send() throws when it cannot write; returning here means it did
  }
  return peerManager.sendTo(crowId, to, frame);
}

/** The outbox's `send` for one contact: every frame goes through `c2cSend`. */
export const c2cSendFor = (peerManager, crowId) => (frame) => c2cSend(peerManager, crowId, frame);

/**
 * Resolve a contact id to the outbox's `send`, through the transport (R2-4c: the
 * dashboard routes and the two-node fixture share THIS resolver, so the gate runs
 * the production send path).
 *
 * `null` is not an error: no peer manager (a test, an early boot) or a contact
 * with no Crow id means the frame stays queued for boot.js's 60 s tick, and an
 * action must not fail because a peer happens to be unreachable.
 *
 * @returns {Promise<Function|null>}
 */
export async function c2cSendForContact(db, peerManager, contactId) {
  if (!Number.isSafeInteger(contactId) || contactId <= 0) return null;
  if (!peerManager || typeof peerManager.send !== "function") return null;
  try {
    const { rows } = await db.execute({
      sql: "SELECT crow_id FROM contacts WHERE id = ? LIMIT 1",
      args: [contactId],
    });
    const crowId = rows[0]?.crow_id;
    if (typeof crowId !== "string" || !crowId) return null;
    return c2cSendFor(peerManager, crowId);
  } catch (err) {
    console.warn(`[c2c] could not resolve a contact's crow id for the flush: ${err?.message || err}`);
    return null;
  }
}