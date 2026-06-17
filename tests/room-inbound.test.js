import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleInboundRoomEnvelope } from "../servers/sharing/room-inbound.js";
import { createRoom, getRoomByUid, getRoomMessages, listRoomMembers, ensureLocalRoomForUid, addMember } from "../servers/gateway/dashboard/panels/messages/rooms-store.js";

function freshLibsql() {
  const dir = mkdtempSync(join(tmpdir(), "crowroom-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: join(import.meta.dirname, "..") });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { dir, db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}
const PK = (c) => "02" + c.repeat(64);           // compressed contact pubkey
const XO = (c) => c.repeat(64);                   // x-only signer
async function mkContact(db, crowId, name, isBot, c) {
  const r = await db.execute({ sql: "INSERT INTO contacts (crow_id, display_name, is_bot, secp256k1_pubkey, ed25519_pubkey, contact_type) VALUES (?,?,?,?,?, 'crow')", args: [crowId, name, isBot, PK(c), "e".repeat(64)] });
  return Number(r.lastInsertRowid);
}

test("room_join from a KNOWN contact materializes a local room; unknown signer dropped", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    await mkContact(db, "crow:host", "Host", 0, "h"); // the host is a known contact
    const nostrManager = { async sendControl() {} };
    const join = (signer) => handleInboundRoomEnvelope({
      db, nostrManager, identity: { crowId: "crow:me" }, subtype: "room_join",
      payload: { room_uid: "u-join", room_name: "Invited", host_crow_id: "crow:host", members: [] },
      senderPubkey: signer,
    });
    await join(XO("z")); // unknown signer
    assert.equal(await getRoomByUid(db, "u-join"), null, "unknown signer cannot create a room");
    await join(XO("h")); // known host
    const room = await getRoomByUid(db, "u-join");
    assert.ok(room, "room materialized from known host");
    assert.equal(room.host_crow_id, "crow:host");
  } finally { cleanup(); }
});

test("host re-fans a member's human message to other members, computing addressed_to; dedups", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const alice = await mkContact(db, "crow:alice", "Alice", 0, "a");
    const bot = await mkContact(db, "crow:bot1", "Research Bot", 1, "b");
    const { groupId, roomUid } = await createRoom(db, { name: "Team", memberContactIds: [alice, bot], mode: "addressed", hostCrowId: "crow:me" });
    const fanned = [];
    const nostrManager = { async sendControl(ct, env) { fanned.push([ct.id, JSON.parse(env)]); } };
    const payload = {
      room_uid: roomUid, room_name: "Team", host_crow_id: "crow:me", msg_uid: "mh1",
      author: { kind: "human", crow_id: "crow:alice", display_name: "Alice" },
      text: "@Research Bot please summarize", addressed_to: [],
    };
    await handleInboundRoomEnvelope({ db, nostrManager, identity: { crowId: "crow:me" }, subtype: "room_message", payload, senderPubkey: XO("a") });
    const msgs = await getRoomMessages(db, groupId);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].author_kind, "human");
    assert.equal(fanned.length, 1);
    assert.equal(fanned[0][0], bot);
    assert.deepEqual(fanned[0][1].payload.addressed_to, ["Research Bot"], "host computed addressed_to");
    assert.equal(fanned[0][1].payload.msg_uid, "mh1", "msg_uid preserved");
    // Replay same msg_uid → no second store, no second fan-out
    fanned.length = 0;
    await handleInboundRoomEnvelope({ db, nostrManager, identity: { crowId: "crow:me" }, subtype: "room_message", payload, senderPubkey: XO("a") });
    assert.equal((await getRoomMessages(db, groupId)).length, 1);
    assert.equal(fanned.length, 0, "dup not re-fanned");
  } finally { cleanup(); }
});

test("participant side (room hosted elsewhere) stores the host's relay but does NOT re-fan", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const host = await mkContact(db, "crow:host", "Host", 0, "h");
    const gid = await ensureLocalRoomForUid(db, { roomUid: "u-remote", name: "Their Room", hostCrowId: "crow:host" });
    await addMember(db, gid, host);
    let fanned = 0;
    const nostrManager = { async sendControl() { fanned++; } };
    await handleInboundRoomEnvelope({
      db, nostrManager, identity: { crowId: "crow:me" }, subtype: "room_message",
      payload: { room_uid: "u-remote", msg_uid: "r1", author: { kind: "human", crow_id: "crow:alice", display_name: "Alice" }, text: "hi all", addressed_to: [] },
      senderPubkey: XO("h"), // signed by the HOST (relaying Alice's message)
    });
    assert.equal((await getRoomMessages(db, gid)).length, 1, "stored for display");
    assert.equal(fanned, 0, "participant does not re-fan");
  } finally { cleanup(); }
});

test("room_message from a non-member signer is dropped (fail-closed)", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const alice = await mkContact(db, "crow:alice", "Alice", 0, "a");
    const { groupId, roomUid } = await createRoom(db, { name: "Team", memberContactIds: [alice], mode: "addressed", hostCrowId: "crow:me" });
    const nostrManager = { async sendControl() { throw new Error("should not fan"); } };
    await handleInboundRoomEnvelope({
      db, nostrManager, identity: { crowId: "crow:me" }, subtype: "room_message",
      payload: { room_uid: roomUid, msg_uid: "x", author: { kind: "human" }, text: "intruder", addressed_to: [] },
      senderPubkey: XO("z"), // not a member
    });
    assert.equal((await getRoomMessages(db, groupId)).length, 0, "intruder message not stored");
  } finally { cleanup(); }
});
