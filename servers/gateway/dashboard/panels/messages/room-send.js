/**
 * Send an operator-authored message into a room. As HOST: store a 'sent' row and
 * fan the room_message out to every member (computing addressed_to). As PARTICIPANT
 * (room hosted elsewhere): store locally and send only to the host, who re-fans.
 * managers = { identity, nostrManager }. Returns { ok, groupId }.
 */
import { randomBytes } from "node:crypto";
import { getRoom, listRoomMembers, insertRoomMessage, computeAddressedTo } from "./rooms-store.js";
import { buildRoomMessageEnvelope, fanOut } from "../../../../sharing/room-fanout.js";

export async function sendOperatorRoomMessage({ db, managers, groupId, message }) {
  const room = await getRoom(db, groupId);
  if (!room) return { ok: false, error: "no such room" };
  const msgUid = randomBytes(16).toString("hex");
  const myCrowId = managers?.identity?.crowId || null;
  // Remote participants see the instance's name (NOT "You"); the local row shows "You".
  const author = { kind: "human", crow_id: myCrowId, display_name: managers?.identity?.displayName || myCrowId || "Crow" };
  await insertRoomMessage(db, { groupId, msgUid, senderContactId: null, senderLabel: "You", authorKind: "human", content: message, direction: "sent" });
  if (managers?.nostrManager) {
    const members = await listRoomMembers(db, groupId);
    const isHost = !room.host_crow_id || room.host_crow_id === myCrowId;
    if (isHost) {
      const botRoster = members.filter((m) => Number(m.is_bot) === 1).map((m) => ({ contactId: m.id, name: m.display_name || m.crow_id }));
      const addressedTo = room.mode === "always" ? botRoster.map((b) => b.name) : computeAddressedTo(message, botRoster);
      const env = buildRoomMessageEnvelope({ roomUid: room.room_uid, roomName: room.name, hostCrowId: myCrowId, msgUid, author, text: message, addressedTo });
      await fanOut({ nostrManager: managers.nostrManager, members, envelope: env, log: (m) => console.error("[rooms]", m) });
    } else {
      const host = members.find((m) => m.crow_id === room.host_crow_id);
      const env = buildRoomMessageEnvelope({ roomUid: room.room_uid, roomName: room.name, hostCrowId: room.host_crow_id, msgUid, author, text: message, addressedTo: [] });
      if (host) await fanOut({ nostrManager: managers.nostrManager, members: [host], envelope: env });
    }
  }
  return { ok: true, groupId };
}
