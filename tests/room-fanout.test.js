import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRoomMessageEnvelope, buildRoomJoinEnvelope, fanOut } from "../servers/sharing/room-fanout.js";

test("buildRoomMessageEnvelope shapes a crow_social room_message", () => {
  const env = JSON.parse(buildRoomMessageEnvelope({
    roomUid: "u1", roomName: "Team", hostCrowId: "crow:me", msgUid: "m1",
    author: { kind: "human", crow_id: "crow:me", display_name: "You" }, text: "hi",
    addressedTo: ["Research Bot"], ts: "2026-06-16T00:00:00Z",
  }));
  assert.equal(env.type, "crow_social");
  assert.equal(env.subtype, "room_message");
  assert.equal(env.payload.room_uid, "u1");
  assert.equal(env.payload.msg_uid, "m1");
  assert.deepEqual(env.payload.addressed_to, ["Research Bot"]);
  assert.equal(env.payload.author.kind, "human");
});

test("fanOut sends to every member except the excluded origin; returns sent/failed", async () => {
  const calls = [];
  // fanOut MUST use sendControl (publish-only, no 1:1 messages caching), NOT sendMessage.
  const nostrManager = { async sendControl(contact, envelope) {
    if (contact.id === 3) throw new Error("relay down");
    calls.push([contact.id, JSON.parse(envelope).subtype]);
    return { eventId: "e", relays: ["wss://x"] };
  } };
  const members = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 9 }];
  const res = await fanOut({ nostrManager, members, envelope: buildRoomJoinEnvelope({ roomUid: "u", roomName: "T", hostCrowId: "crow:me", members: [] }), excludeContactId: 9 });
  assert.deepEqual(calls.map((c) => c[0]).sort(), [1, 2]); // 9 excluded, 3 failed
  assert.deepEqual(res.sent.sort(), [1, 2]);
  assert.deepEqual(res.failed, [3]);
});
