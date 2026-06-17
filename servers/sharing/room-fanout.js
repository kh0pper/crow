/**
 * Crow Messages room transport (phase 3a). Pure envelope builders + a best-effort
 * fan-out over nostrManager.sendControl (publish-only, no 1:1 caching). The host calls this
 * to relay a room_message to every member; a participant uses it to send a reply
 * to the host. No relay/identity coupling here — nostrManager is injected.
 */

export function buildRoomMessageEnvelope({ roomUid, roomName, hostCrowId, msgUid, author, text, addressedTo = [], ts = null }) {
  return JSON.stringify({
    type: "crow_social", version: 1, subtype: "room_message",
    payload: {
      room_uid: roomUid, room_name: roomName, host_crow_id: hostCrowId,
      msg_uid: msgUid, author: author || {}, text: text || "",
      addressed_to: Array.isArray(addressedTo) ? addressedTo : [],
      ts: ts || new Date().toISOString(),
    },
  });
}

export function buildRoomJoinEnvelope({ roomUid, roomName, hostCrowId, members = [] }) {
  return JSON.stringify({
    type: "crow_social", version: 1, subtype: "room_join",
    payload: { room_uid: roomUid, room_name: roomName, host_crow_id: hostCrowId, members },
  });
}

/**
 * Send `envelope` to each member contact except `excludeContactId`. Best-effort:
 * one failed recipient never aborts the rest. Returns { sent:[ids], failed:[ids] }.
 * Uses nostrManager.sendControl — publish-only, so control envelopes are NOT cached
 * into the 1:1 `messages` table (sendMessage WOULD cache them).
 */
export async function fanOut({ nostrManager, members, envelope, excludeContactId = null, log = () => {} }) {
  const sent = [], failed = [];
  for (const c of members) {
    if (excludeContactId != null && Number(c.id) === Number(excludeContactId)) continue;
    try { await nostrManager.sendControl(c, envelope); sent.push(c.id); }
    catch (e) { failed.push(c.id); log("room fanout fail contact=" + c.id + ": " + (e && e.message)); }
  }
  return { sent, failed };
}
