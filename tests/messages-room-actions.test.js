import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getUnifiedConversationList } from "../servers/gateway/dashboard/panels/messages/data-queries.js";
import { createRoom, insertRoomMessage } from "../servers/gateway/dashboard/panels/messages/rooms-store.js";
import { handlePostAction } from "../servers/gateway/dashboard/panels/messages/api-handlers.js";
import { listRoomMembers } from "../servers/gateway/dashboard/panels/messages/rooms-store.js";

function freshLibsql() {
  const dir = mkdtempSync(join(tmpdir(), "crowroom-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: join(import.meta.dirname, "..") });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { dir, db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

test("getUnifiedConversationList includes rooms; excludes local-bot self-contacts from peers", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    // A local-bot self-contact must NOT show as a phantom 1:1 conversation.
    await db.execute("INSERT INTO contacts (crow_id, display_name, is_bot, secp256k1_pubkey, ed25519_pubkey, contact_type, origin) VALUES ('crow:bot1','Research Bot',1,'02" + "b".repeat(64) + "','" + "e".repeat(64) + "','crow','local-bot')");
    const { groupId } = await createRoom(db, { name: "Team", memberContactIds: [], mode: "addressed", hostCrowId: "crow:me" });
    await insertRoomMessage(db, { groupId, msgUid: "m1", senderContactId: null, senderLabel: "Bot", authorKind: "bot", content: "hi", direction: "received" });
    const { items, totalUnread } = await getUnifiedConversationList(db);
    const room = items.find((i) => i.type === "room");
    assert.ok(room, "room present in unified list");
    assert.equal(room.displayName, "Team");
    assert.equal(room.groupId, groupId);
    assert.equal(room.unread, 1);
    assert.equal(totalUnread, 1);
    assert.equal(items.filter((i) => i.type === "peer").length, 0, "local-bot self-contact not listed as a peer");
  } finally { cleanup(); }
});

function fakeRes() { return { _r: null, redirectAfterPost(p) { this._r = p; return true; } }; }
// fanOut uses sendControl (publish-only, no 1:1 caching).
function fakeManagers(sink) {
  return { identity: { crowId: "crow:me", displayName: "My Crow" }, nostrManager: { async sendControl(ct, env) { sink.push([ct.id, JSON.parse(env)]); } } };
}

test("create_room → host room with members; room_join fanned via sendControl; redirects to openRoom", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const a = await db.execute({ sql: "INSERT INTO contacts (crow_id, display_name, secp256k1_pubkey, ed25519_pubkey, contact_type) VALUES ('crow:a','Alice','02" + "a".repeat(64) + "','" + "e".repeat(64) + "','crow')", args: [] });
    const aliceId = Number(a.lastInsertRowid);
    const sink = [];
    const req = { body: { action: "create_room", room_name: "Team", mode: "addressed", member_ids: String(aliceId) } };
    const res = fakeRes();
    const handled = await handlePostAction(req, res, { db, _managers: fakeManagers(sink) });
    assert.equal(handled, true);
    const room = (await db.execute("SELECT id FROM contact_groups WHERE room_uid IS NOT NULL")).rows[0];
    assert.ok(room, "room created");
    assert.equal((await listRoomMembers(db, room.id)).length, 1);
    assert.ok(sink.some((s) => s[1].subtype === "room_join"), "room_join fanned");
    assert.match(res._r, /openRoom=/);
  } finally { cleanup(); }
});
