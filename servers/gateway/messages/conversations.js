/**
 * The two conversations a Crow Messages draft can belong to, the people a message to one of them
 * actually reaches, and the audience check a send re-runs before anything leaves the box.
 *
 * A "conversation" is one of exactly two things today, and the draft row names it by kind and by that
 * thing's LOCAL id (never a crow id): a `contact` is one row of `contacts` (the 1:1 peer chat), and a
 * `room` is one `contact_groups` row with a non-NULL `room_uid` (the multi-party chat the Rooms store
 * owns). Both ids are integers, which is why the draft table's conversation_id is one too.
 *
 * `resolveConversation` answers the audience as RECIPIENTS — one entry per person,
 * `{contactId, crowId, pubkey, name, blocked}`. The entry carries the secp256k1 pubkey the contact
 * has RIGHT NOW, because that is the snapshot the store seals: a draft is written for these people
 * AND these keys, and a key that changed between the draft and the tap is a different person to send
 * to. `canonicalRecipients` puts them in the one order the seal covers (sorted, de-duplicated), and
 * `sameAudience` compares two sets by who they are (contact + crow id) while the route compares the
 * keys per recipient, so "somebody joined or left" and "somebody's key changed" stay separate
 * refusals with their own sentences.
 *
 * Nothing here writes; the store and the routes own every write. The Room store is reused as it is
 * (its `listRoomMembers` is the same list the room panel draws and the room send fans out to), so a
 * draft's audience can never be a second, drifting notion of "who is in this room". A room's member
 * list already leaves out blocked and pending contacts, so one of those changing the audience shows
 * up as `recipients_changed`; a 1:1 contact is looked up by id whatever its state, so a blocked
 * contact is reported as blocked (`blocked`) instead of silently disappearing.
 *
 * The DELIVERY re-runs the same idea a second time, by primary id, immediately before the text is
 * handed to a transport: `verifyDeliveryTargets` (below) is what a send path calls with the sealed
 * audience and the exact rows it is about to reach, because the gap between the route's check and
 * the send is where a name-based lookup could otherwise land on a different person.
 */
import { getRoom, listRoomMembers } from "../dashboard/panels/messages/rooms-store.js";

/** The conversation kinds a draft may belong to. The table has no CHECK: this list is the validation. */
export const CONVERSATION_KINDS = Object.freeze(["contact", "room"]);

/** One `contacts` row as a draft's recipient: who they are, and the key this draft is written for. */
function recipientOf(row) {
  return {
    contactId: Number(row.id),
    crowId: String(row.crow_id ?? "").trim(),
    pubkey: String(row.secp256k1_pubkey ?? "").trim(),
    name: String(row.display_name ?? "").trim(),
    blocked: Number(row.is_blocked ?? 0) === 1,
  };
}

/**
 * The people a message to this conversation reaches, or why there is no such conversation.
 *
 * @param {object} db
 * @param {{kind: string, id: number}} target
 * @returns {Promise<{ok: true, kind: string, id: number, recipients: Array<{contactId: number,
 *   crowId: string, pubkey: string, name: string, blocked: boolean}>, label: string}
 *   | {ok: false, reason: "bad_kind"|"not_found"}>}
 */
export async function resolveConversation(db, { kind, id } = {}) {
  if (!CONVERSATION_KINDS.includes(kind)) return { ok: false, reason: "bad_kind" };
  if (!Number.isInteger(id) || id <= 0) return { ok: false, reason: "not_found" };

  if (kind === "contact") {
    const { rows } = await db.execute({
      sql: "SELECT id, crow_id, display_name, secp256k1_pubkey, is_blocked FROM contacts WHERE id = ?",
      args: [id],
    });
    const row = rows[0];
    const crowId = row ? String(row.crow_id || "").trim() : "";
    if (!crowId) return { ok: false, reason: "not_found" };
    return {
      ok: true,
      kind,
      id,
      recipients: canonicalRecipientEntries([recipientOf(row)]),
      label: String(row.display_name || "").trim() || crowId,
    };
  }

  // A room is a contact_groups row with a room_uid; getRoom refuses a plain organizational group.
  const room = await getRoom(db, id);
  if (!room) return { ok: false, reason: "not_found" };
  const members = await listRoomMembers(db, id);
  return {
    ok: true,
    kind,
    id,
    recipients: canonicalRecipientEntries(members.map(recipientOf)),
    label: String(room.name || "").trim() || `Room ${id}`,
  };
}

/**
 * One recipient in the canonical form the seal covers: the contact row it is, the crow id it answers
 * to, and the key snapshot taken when the draft was written. JSON of a fixed three-element array, so
 * no field can slide into its neighbour and two different audiences can never share one text.
 *
 * @param {{contactId: number|string, crowId: string, pubkey?: string}} entry
 * @returns {string}
 */
export function recipientKey(entry) {
  return JSON.stringify([
    Number(entry?.contactId ?? 0),
    String(entry?.crowId ?? "").trim(),
    String(entry?.pubkey ?? "").trim(),
  ]);
}

/**
 * An audience in the one canonical form the seal covers: every recipient as its `recipientKey`, sorted
 * and de-duplicated, so the same audience always seals to the same bytes whatever order the store, a
 * room's membership query or a request body produced it in.
 *
 * Entries without a contact id or a crow id are dropped (`{contactId: 0, ...}` is not a person), which
 * is what keeps a malformed row from sealing as "nobody".
 *
 * @param {Array<object>} recipients
 * @returns {string[]}
 */
export function canonicalRecipients(recipients) {
  const out = new Set();
  for (const entry of Array.isArray(recipients) ? recipients : []) {
    if (!entry || typeof entry !== "object") continue;
    if (!Number.isInteger(Number(entry.contactId)) || Number(entry.contactId) <= 0) continue;
    if (!String(entry.crowId ?? "").trim()) continue;
    out.add(recipientKey(entry));
  }
  return [...out].sort();
}

/**
 * The same recipients, in the canonical order and as objects (what the store writes into
 * `recipients_json`): the audience a seal names, not just its text.
 *
 * @param {Array<object>} recipients
 * @returns {Array<{contactId: number, crowId: string, pubkey: string}>}
 */
export function canonicalRecipientEntries(recipients) {
  const byKey = new Map();
  for (const entry of Array.isArray(recipients) ? recipients : []) {
    if (!entry || typeof entry !== "object") continue;
    if (!Number.isInteger(Number(entry.contactId)) || Number(entry.contactId) <= 0) continue;
    const crowId = String(entry.crowId ?? "").trim();
    if (!crowId) continue;
    const kept = { contactId: Number(entry.contactId), crowId, pubkey: String(entry.pubkey ?? "").trim() };
    // Live-only facts a caller may carry (never sealed, never stored): the name a person reads and
    // whether the contact is blocked right now. They stay on the entry so the send path can check
    // them without a second lookup.
    if (entry.blocked !== undefined) kept.blocked = entry.blocked === true;
    if (entry.name !== undefined) kept.name = String(entry.name ?? "");
    byKey.set(recipientKey(kept), kept);
  }
  return [...byKey.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, kept]) => kept);
}

/** Who a recipient is, without the key: what "the same audience" means (the key has its own check). */
function audienceKey(entry) {
  return JSON.stringify([Number(entry?.contactId ?? 0), String(entry?.crowId ?? "").trim()]);
}

/**
 * The same people on both sides? Both are put through the identity key first (contact row + crow id),
 * so a key that changed — or an entry's order, or a duplicate — never reads as a different audience.
 * The keys themselves are compared by `audienceKeyChanges`.
 */
export function sameAudience(a, b) {
  const set = (list) => {
    const out = new Set();
    for (const entry of Array.isArray(list) ? list : []) {
      if (!entry || typeof entry !== "object") continue;
      if (!Number.isInteger(Number(entry.contactId)) || Number(entry.contactId) <= 0) continue;
      if (!String(entry.crowId ?? "").trim()) continue;
      out.add(audienceKey(entry));
    }
    return out;
  };
  const left = set(a);
  const right = set(b);
  if (left.size !== right.size) return false;
  for (const key of left) if (!right.has(key)) return false;
  return true;
}

/**
 * What moved between the audience a draft was sealed for and the audience the conversation has now:
 * the first recipient who is blocked (`blocked`), or whose current key is not the snapshot
 * (`pubkey_changed`). Answers `{ok: true}` when every recipient is still the person — and the key —
 * the draft was written for. Membership itself is `sameAudience`'s job; this only looks at the people
 * both sides agree are there.
 *
 * @param {Array<object>} sealed the recipient entries on the draft row
 * @param {Array<object>} live the entries `resolveConversation` just derived
 * @returns {{ok: true} | {ok: false, reason: "blocked"|"pubkey_changed", contactId: number}}
 */
export function audienceKeyChanges(sealed, live) {
  const liveByKey = new Map();
  for (const entry of Array.isArray(live) ? live : []) {
    if (entry && Number.isInteger(Number(entry.contactId))) liveByKey.set(audienceKey(entry), entry);
  }
  for (const entry of Array.isArray(sealed) ? sealed : []) {
    const current = liveByKey.get(audienceKey(entry));
    if (!current) continue; // membership is sameAudience's answer, not this one's
    if (current.blocked === true) return { ok: false, reason: "blocked", contactId: Number(entry.contactId) };
    if (String(current.pubkey ?? "").trim() !== String(entry.pubkey ?? "").trim()) {
      return { ok: false, reason: "pubkey_changed", contactId: Number(entry.contactId) };
    }
  }
  return { ok: true };
}

/**
 * The check a DELIVERY makes immediately before it hands text to a transport: the audience a draft
 * sealed, against the exact rows the transport is about to reach, decided by PRIMARY ID and nothing
 * else.
 *
 * `sameAudience` and `audienceKeyChanges` answer the route's question — "who does this conversation
 * reach now?". This one answers the delivery's: "are the rows I am about to hand the text to the
 * rows this draft was checked against?". The difference is the resolution step in between. A send
 * path that finds its destination by a NAME (`crow_send_message` matches `crow_id = ? OR
 * display_name = ?`; a room fan-out re-lists members by label) can land on a different row than the
 * one that was verified: a contact whose display name is another contact's crow id, a member
 * re-pointed at a new key between the check and the send. So both delivery paths — the 1:1 peer
 * send and the room fan-out — take the sealed snapshot and the live rows about to be used, and
 * refuse BEFORE anything leaves the box:
 *
 *   - the live set must be the same people: same count, same contact ids and same crow ids
 *     (`recipients_changed`), so an added, removed or re-pointed row never receives the text;
 *   - each of them must still be unblocked (`blocked`) and still hold the secp256k1 key the draft
 *     sealed (`pubkey_changed`) — a re-keyed row is a different person to send to.
 *
 * Entries without a positive contact id name nobody and are dropped on both sides, so a malformed
 * row can never make an empty audience look like a match.
 *
 * @param {Array<{contactId: number|string, crowId: string, pubkey?: string}>} sealed the draft row's
 *   audience (`recipients_json`, as `mapRow` parsed it)
 * @param {Array<{contactId: number|string, crowId: string, pubkey?: string, blocked?: boolean}>} live
 *   the rows the delivery is about to use, read by primary id
 * @returns {{ok: true} | {ok: false, reason: "recipients_changed"|"pubkey_changed"|"blocked",
 *   contactId?: number}}
 */
export function verifyDeliveryTargets(sealed, live) {
  const byContactId = (list) => {
    const out = new Map();
    for (const entry of Array.isArray(list) ? list : []) {
      if (!entry || typeof entry !== "object") continue;
      const contactId = Number(entry.contactId);
      if (!Number.isInteger(contactId) || contactId <= 0) continue;
      out.set(contactId, entry);
    }
    return out;
  };
  const want = byContactId(sealed);
  const have = byContactId(live);
  if (want.size === 0 || want.size !== have.size) return { ok: false, reason: "recipients_changed" };
  for (const [contactId, entry] of want) {
    const target = have.get(contactId);
    if (!target) return { ok: false, reason: "recipients_changed", contactId };
    if (String(target.crowId ?? "").trim() !== String(entry.crowId ?? "").trim()) {
      return { ok: false, reason: "recipients_changed", contactId };
    }
    if (target.blocked === true) return { ok: false, reason: "blocked", contactId };
    if (String(target.pubkey ?? "").trim() !== String(entry.pubkey ?? "").trim()) {
      return { ok: false, reason: "pubkey_changed", contactId };
    }
  }
  return { ok: true };
}
