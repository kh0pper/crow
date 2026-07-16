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
 *
 * Every send is capped at `capMs` and the members run in parallel
 * (Promise.allSettled), so N wedged sends cost ~one cap, not N×. This runs
 * inside a relay message's handler chain (nostr.js subscribeToIncoming →
 * onSocialMessage → room-inbound → fanOut). nostr-tools dispatches onevent
 * WITHOUT awaiting it, so a wedged send never froze the whole subscription —
 * but it did wedge THAT message's handling forever (serial per-member
 * compounding) and leaked a pending promise per member. The cap bounds both.
 * A capped member counts as failed; the abandoned sendControl's eventual
 * rejection is absorbed by the race (reaction attached at race time — it can
 * never reach the process crash guard). sent/failed are completion-ordered.
 */
export async function fanOut({ nostrManager, members, envelope, excludeContactId = null, log = () => {}, capMs = 10_000 }) {
  const sent = [], failed = [];
  const targets = members.filter((c) => !(excludeContactId != null && Number(c.id) === Number(excludeContactId)));
  await Promise.allSettled(targets.map(async (c) => {
    let timer;
    // Deliberately NOT unref'd: with a hung sendControl this timer can be the
    // only thing left on the loop — unref'd, the loop drains and the cap never
    // fires (the exact instance-sync.js:493 node:test trap). The fast path
    // clears it in finally, so it never outlives a healthy send.
    const cap = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`sendControl exceeded ${capMs}ms`)), capMs);
    });
    try {
      await Promise.race([nostrManager.sendControl(c, envelope), cap]);
      sent.push(c.id);
    } catch (e) {
      failed.push(c.id);
      log("room fanout fail contact=" + c.id + ": " + (e && e.message));
    } finally {
      clearTimeout(timer);
    }
  }));
  return { sent, failed };
}
