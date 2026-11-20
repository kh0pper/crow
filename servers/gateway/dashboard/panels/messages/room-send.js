/**
 * Send an operator-authored message into a room. As HOST: store a 'sent' row and
 * fan the room_message out to every member (computing addressed_to). As PARTICIPANT
 * (room hosted elsewhere): store locally and send only to the host, who re-fans.
 * managers = { identity, nostrManager }. Returns { ok, groupId }.
 *
 * STRICT MEMBERS (`expectedRecipients`): a Crow Messages draft send already checked the room's
 * audience against the set it sealed — contact ids, crow ids and secp256k1 keys. The fan-out below
 * is the delivery, so the member rows it is about to use are checked AGAIN, by primary id, right
 * before anything is stored or published (servers/gateway/messages/conversations.js
 * `verifyDeliveryTargets`): a member re-keyed or re-pointed at another crow id between the check and
 * the send answers `pubkey_changed` / `recipients_changed`, and a member added does the same, so
 * nothing is written. A member BLOCKED (or turned back into a still-'pending' request) between the
 * two does not answer `blocked`: `listRoomMembers` leaves blocked and pending contacts out, so that
 * member simply drops out of the live set and the answer is `recipients_changed` — the audience is
 * not the one the draft sealed. Without the option the send path is exactly what it always was.
 */
import { randomBytes } from "node:crypto";
import { getRoom, listRoomMembers, insertRoomMessage, computeAddressedTo } from "./rooms-store.js";
import { buildRoomMessageEnvelope, fanOut } from "../../../../sharing/room-fanout.js";
import { verifyDeliveryTargets } from "../../../messages/conversations.js";

/**
 * One member row as a delivery target: who it is (by id and crow id) and the key it holds now.
 * `blocked` is carried for `verifyDeliveryTargets`' contract, but `listRoomMembers` already filters
 * `is_blocked` and pending rows out — which is why a blocked member reads as a missing one
 * (`recipients_changed`), never as `blocked`.
 */
function memberTarget(row) {
  return {
    contactId: Number(row.id),
    crowId: String(row.crow_id ?? "").trim(),
    pubkey: String(row.secp256k1_pubkey ?? "").trim(),
    blocked: Number(row.is_blocked ?? 0) === 1,
  };
}

export async function sendOperatorRoomMessage({ db, managers, groupId, message, expectedRecipients = null }) {
  const room = await getRoom(db, groupId);
  if (!room) return { ok: false, error: "no such room" };
  // ONE read of the member list, before anything is written: it is both what a strict caller is
  // checked against and what the fan-out reaches, so the check and the delivery can never be about
  // two different lists.
  let members = null;
  if (expectedRecipients != null || managers?.nostrManager) {
    members = await listRoomMembers(db, groupId);
  }
  if (expectedRecipients != null) {
    const verdict = verifyDeliveryTargets(expectedRecipients, (members || []).map(memberTarget));
    if (!verdict.ok) return { ok: false, error: verdict.reason };
  }
  const msgUid = randomBytes(16).toString("hex");
  const myCrowId = managers?.identity?.crowId || null;
  // Remote participants see the instance's name (NOT "You"); the local row shows "You".
  const author = { kind: "human", crow_id: myCrowId, display_name: managers?.identity?.displayName || myCrowId || "Crow" };
  await insertRoomMessage(db, { groupId, msgUid, senderContactId: null, senderLabel: "You", authorKind: "human", content: message, direction: "sent" });
  if (managers?.nostrManager) {
    const isHost = !room.host_crow_id || room.host_crow_id === myCrowId;
    if (isHost) {
      const botRoster = (members || []).filter((m) => Number(m.is_bot) === 1).map((m) => ({ contactId: m.id, name: m.display_name || m.crow_id }));
      const addressedTo = room.mode === "always" ? botRoster.map((b) => b.name) : computeAddressedTo(message, botRoster);
      const env = buildRoomMessageEnvelope({ roomUid: room.room_uid, roomName: room.name, hostCrowId: myCrowId, msgUid, author, text: message, addressedTo });
      await fanOut({ nostrManager: managers.nostrManager, members: members || [], envelope: env, log: (m) => console.error("[rooms]", m) });
    } else {
      const host = (members || []).find((m) => m.crow_id === room.host_crow_id);
      const env = buildRoomMessageEnvelope({ roomUid: room.room_uid, roomName: room.name, hostCrowId: room.host_crow_id, msgUid, author, text: message, addressedTo: [] });
      if (host) await fanOut({ nostrManager: managers.nostrManager, members: [host], envelope: env });
    }
  }
  return { ok: true, groupId };
}
