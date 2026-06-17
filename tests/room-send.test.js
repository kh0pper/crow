import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendOperatorRoomMessage } from "../servers/gateway/dashboard/panels/messages/room-send.js";
import { createRoom, ensureLocalRoomForUid, addMember, getRoomMessages } from "../servers/gateway/dashboard/panels/messages/rooms-store.js";

function freshLibsql() {
  const dir = mkdtempSync(join(tmpdir(), "crowroom-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: join(import.meta.dirname, "..") });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { dir, db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}
async function mkContact(db, crowId, name, isBot, c) {
  const r = await db.execute({ sql: "INSERT INTO contacts (crow_id, display_name, is_bot, secp256k1_pubkey, ed25519_pubkey, contact_type) VALUES (?,?,?,?,?, 'crow')", args: [crowId, name, isBot, "02" + c.repeat(64), "e".repeat(64)] });
  return Number(r.lastInsertRowid);
}
function managers(sink) {
  return { identity: { crowId: "crow:me", displayName: "My Crow" }, nostrManager: { async sendControl(ct, env) { sink.push([ct.id, JSON.parse(env)]); } } };
}

test("host send: stores 'sent' row (label You), fans room_message to all members with addressed_to", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const alice = await mkContact(db, "crow:alice", "Alice", 0, "a");
    const bot = await mkContact(db, "crow:bot1", "Research Bot", 1, "b");
    const { groupId, roomUid } = await createRoom(db, { name: "Team", memberContactIds: [alice, bot], mode: "addressed", hostCrowId: "crow:me" });
    const sink = [];
    const r = await sendOperatorRoomMessage({ db, managers: managers(sink), groupId, message: "@Research Bot hi" });
    assert.equal(r.ok, true);
    const msgs = await getRoomMessages(db, groupId);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].direction, "sent");
    assert.equal(msgs[0].sender_label, "You");
    const fanned = sink.filter((s) => s[1].subtype === "room_message");
    assert.equal(fanned.length, 2, "to both members");
    const botMsg = fanned.find((s) => s[0] === bot)[1];
    assert.equal(botMsg.payload.room_uid, roomUid);
    assert.deepEqual(botMsg.payload.addressed_to, ["Research Bot"]);
    assert.equal(botMsg.payload.author.display_name, "My Crow", "remote label is the instance name, not You");
  } finally { cleanup(); }
});

test("participant send (room hosted elsewhere): sends only to the host", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const host = await mkContact(db, "crow:host", "Host", 0, "h");
    const gid = await ensureLocalRoomForUid(db, { roomUid: "u-x", name: "Theirs", hostCrowId: "crow:host" });
    await addMember(db, gid, host);
    const sink = [];
    const r = await sendOperatorRoomMessage({ db, managers: managers(sink), groupId: gid, message: "hi" });
    assert.equal(r.ok, true);
    assert.equal(sink.length, 1, "only the host");
    assert.equal(sink[0][0], host);
  } finally { cleanup(); }
});
