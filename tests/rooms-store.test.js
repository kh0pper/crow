import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRoom, getRoomByUid, getRoom, listRoomMembers, ensureLocalRoomForUid,
  addMember, removeMember, setMode, renameRoom, deleteRoom, listRooms,
} from "../servers/gateway/dashboard/panels/messages/rooms-store.js";
import { insertRoomMessage, getRoomMessages, computeAddressedTo } from "../servers/gateway/dashboard/panels/messages/rooms-store.js";

function freshLibsql() {
  const dir = mkdtempSync(join(tmpdir(), "crowroom-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: join(import.meta.dirname, "..") });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { dir, db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}
async function mkContact(db, crowId, name, isBot = 0) {
  const r = await db.execute({ sql: "INSERT INTO contacts (crow_id, display_name, is_bot, secp256k1_pubkey, ed25519_pubkey, contact_type) VALUES (?,?,?,?,?, 'crow')", args: [crowId, name, isBot, "02" + crowId.slice(-1).repeat(64), "e".repeat(64)] });
  return Number(r.lastInsertRowid);
}

test("createRoom assigns a room_uid, inserts members; mode validated", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const alice = await mkContact(db, "crow:alice", "Alice");
    const bot = await mkContact(db, "crow:bot1", "Research Bot", 1);
    const { groupId, roomUid } = await createRoom(db, { name: "Team", memberContactIds: [alice, bot], mode: "always", hostCrowId: "crow:me" });
    assert.ok(groupId > 0);
    assert.equal(roomUid.length, 32);
    const room = await getRoom(db, groupId);
    assert.equal(room.name, "Team");
    assert.equal(room.mode, "always");
    assert.equal(room.host_crow_id, "crow:me");
    const byUid = await getRoomByUid(db, roomUid);
    assert.equal(byUid.id, groupId);
    const members = await listRoomMembers(db, groupId);
    assert.equal(members.length, 2);
    assert.ok(members.some((m) => Number(m.is_bot) === 1));
    // Invalid mode coerces to 'addressed'
    const { groupId: g2 } = await createRoom(db, { name: "X", memberContactIds: [], mode: "bogus", hostCrowId: "crow:me" });
    assert.equal((await getRoom(db, g2)).mode, "addressed");
  } finally { cleanup(); }
});

test("ensureLocalRoomForUid materializes once; add/remove/setMode/rename/delete", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const gid1 = await ensureLocalRoomForUid(db, { roomUid: "uid-1", name: "Joined", hostCrowId: "crow:host" });
    const gid2 = await ensureLocalRoomForUid(db, { roomUid: "uid-1", name: "Joined", hostCrowId: "crow:host" });
    assert.equal(gid1, gid2, "idempotent on room_uid");
    const c = await mkContact(db, "crow:bob", "Bob");
    await addMember(db, gid1, c);
    assert.equal((await listRoomMembers(db, gid1)).length, 1);
    await addMember(db, gid1, c); // idempotent
    assert.equal((await listRoomMembers(db, gid1)).length, 1);
    await setMode(db, gid1, "always");
    assert.equal((await getRoom(db, gid1)).mode, "always");
    await renameRoom(db, gid1, "Renamed");
    assert.equal((await getRoom(db, gid1)).name, "Renamed");
    await removeMember(db, gid1, c);
    assert.equal((await listRoomMembers(db, gid1)).length, 0);
    assert.equal((await listRooms(db)).length, 1);
    await deleteRoom(db, gid1);
    assert.equal(await getRoom(db, gid1), null);
    assert.equal((await listRooms(db)).length, 0);
  } finally { cleanup(); }
});

test("insertRoomMessage dedups on (group, msg_uid); getRoomMessages returns chronological", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const { groupId } = await createRoom(db, { name: "R", memberContactIds: [], mode: "addressed", hostCrowId: "crow:me" });
    const a = await insertRoomMessage(db, { groupId, msgUid: "m1", senderContactId: null, senderLabel: "You", authorKind: "human", content: "hi", direction: "sent" });
    const b = await insertRoomMessage(db, { groupId, msgUid: "m1", senderContactId: null, senderLabel: "You", authorKind: "human", content: "hi", direction: "sent" });
    assert.equal(a, true, "first insert is new");
    assert.equal(b, false, "duplicate msg_uid ignored");
    await insertRoomMessage(db, { groupId, msgUid: "m2", senderContactId: null, senderLabel: "Bot", authorKind: "bot", content: "hello", direction: "received" });
    const msgs = await getRoomMessages(db, groupId);
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].content, "hi");
    assert.equal(msgs[1].author_kind, "bot");
  } finally { cleanup(); }
});

test("computeAddressedTo: exact @mention and whole-word name; no substring false-positive", async () => {
  const roster = [{ contactId: 1, name: "Research Bot" }, { contactId: 2, name: "Max" }];
  assert.deepEqual(computeAddressedTo("hey @Research Bot can you help", roster), ["Research Bot"]);
  assert.deepEqual(computeAddressedTo("Max, what time is it?", roster), ["Max"]);
  assert.deepEqual(computeAddressedTo("the maximum value", roster), [], "'maximum' must NOT match 'Max'");
  assert.deepEqual(computeAddressedTo("nobody addressed here", roster), []);
  // multi-bot: both addressed
  assert.deepEqual(computeAddressedTo("@Research Bot and @Max please", roster).sort(), ["Max", "Research Bot"]);
});
