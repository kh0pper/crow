import { test } from "node:test";
import assert from "node:assert/strict";
import { handleCrowMessageEvent } from "../scripts/pi-bots/gateways/crow-messages.mjs";

// Minimal stub db (room branch never touches it).
const stubDb = { prepare() { return { get() { return null; }, run() { return { changes: 1 }; }, all() { return []; } }; } };

function roomEvent(over = {}) {
  return {
    botId: "bot1",
    senderPubkey: "h".repeat(64),         // signer = host (matches hostXOnly below)
    decrypted: JSON.stringify({
      type: "crow_social", version: 1, subtype: "room_message",
      payload: {
        room_uid: "u1", room_name: "Team", host_crow_id: "crow:host", msg_uid: "m1",
        author: { kind: "human", crow_id: "crow:alice", display_name: "Alice" },
        text: "@Research Bot help", addressed_to: ["Research Bot"],
        ...(over.payload || {}),
      },
    }),
    db: stubDb,
    hostXOnly: "h".repeat(64),
    botDisplayName: "Research Bot",
    botCrowId: "crow:bot1",
    sendRoomReply: null, // set per test
    log: () => {},
    ...over,
  };
}

test("addressed human room_message → runs a pi turn; reply goes to host as bot-authored", async () => {
  const replies = [];
  let turn = null;
  await handleCrowMessageEvent(roomEvent({
    handleInbound: async (opts) => { turn = opts; await opts.sendReply("done"); return { action: "done" }; },
    sendRoomReply: async (roomUid, roomName, text) => replies.push([roomUid, text]),
  }));
  assert.ok(turn, "turn ran");
  assert.equal(turn.gateway_thread_id, "crow-room:u1");
  assert.equal(turn.user_message, "@Research Bot help");
  assert.deepEqual(replies, [["u1", "done"]]);
});

test("bot-authored room_message → NO turn (loop-safety)", async () => {
  let turn = false;
  await handleCrowMessageEvent(roomEvent({
    payload: { author: { kind: "bot", display_name: "Other Bot" }, addressed_to: ["Research Bot"] },
    handleInbound: async () => { turn = true; return {}; },
    sendRoomReply: async () => {},
  }));
  assert.equal(turn, false);
});

test("not-addressed human message → NO turn", async () => {
  let turn = false;
  await handleCrowMessageEvent(roomEvent({
    payload: { addressed_to: ["Some Other Bot"] },
    handleInbound: async () => { turn = true; return {}; },
    sendRoomReply: async () => {},
  }));
  assert.equal(turn, false);
});

test("signer != host → dropped (fail-closed)", async () => {
  let turn = false;
  await handleCrowMessageEvent(roomEvent({
    senderPubkey: "z".repeat(64), // not the host
    handleInbound: async () => { turn = true; return {}; },
    sendRoomReply: async () => {},
  }));
  assert.equal(turn, false);
});
