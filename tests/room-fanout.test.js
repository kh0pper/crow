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

// Minor-pool item 2 (2026-07-16 spec): fanOut runs INSIDE the relay's inbound
// message loop (nostr.js subscribeToIncoming → onSocialMessage → room-inbound →
// fanOut); an unbounded sendControl (half-open relay socket mid-publish) used to
// stall inbound processing indefinitely, compounded serially per member.
test("a hung sendControl is capped: fanOut resolves, hung member fails, healthy member sends", async () => {
  const nostrManager = { sendControl(contact) {
    if (contact.id === 1) return new Promise(() => {}); // half-open socket: never settles
    return Promise.resolve({ eventId: "e", relays: ["wss://x"] });
  } };
  const fails = [];
  const res = await Promise.race([
    fanOut({ nostrManager, members: [{ id: 1 }, { id: 2 }], envelope: "{}", log: (m) => fails.push(m), capMs: 50 }),
    new Promise((resolve) => { const t = setTimeout(() => resolve("__hung__"), 2_000); t.unref?.(); }),
  ]);
  assert.notEqual(res, "__hung__", "fanOut must resolve despite a never-settling sendControl");
  assert.deepEqual(res.sent, [2]);
  assert.deepEqual(res.failed, [1]);
  assert.ok(fails.some((m) => m.includes("contact=1")), "capped member must be logged through the log callback");
});

test("N hung members cost ~one cap, not N× (parallel fan-out, not a serial capped loop)", async () => {
  const nostrManager = { sendControl: () => new Promise(() => {}) };
  const start = performance.now();
  const res = await fanOut({ nostrManager, members: [{ id: 1 }, { id: 2 }, { id: 3 }], envelope: "{}", capMs: 100 });
  const elapsed = performance.now() - start;
  assert.deepEqual(res.sent, []);
  assert.deepEqual(res.failed.sort(), [1, 2, 3]);
  assert.ok(elapsed < 250, `3 hung members should cost ~1 cap (100ms), took ${Math.round(elapsed)}ms`);
});
