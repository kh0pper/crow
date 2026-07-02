/**
 * message-request-gates — L6 Task 3. Proves request rows (request_status
 * 'pending'/'accepted') are excluded from the COMPLETE set of normal surfaces,
 * with the crisp model:
 *   - trust / peer surfaces  = NULL only
 *   - messaging surfaces     = NULL + 'accepted' (exclude 'pending')
 *
 * SECURITY (gate #4/#5): a remote sender who auto-created a request row by
 * DMing us must NOT gain room-host trust via a room_join, must NOT be injected
 * into contact_group_members via a room_join member list, and a partial row that
 * somehow became a member must NOT pass the room_message signer-auth. Only a
 * NULL (full) contact passes any trust surface.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleInboundRoomEnvelope } from "../servers/sharing/room-inbound.js";
import {
  createRoom, getRoomByUid, listRoomMembers, addMember, getRoomMessages,
} from "../servers/gateway/dashboard/panels/messages/rooms-store.js";
import { getUnifiedConversationList } from "../servers/gateway/dashboard/panels/messages/data-queries.js";
import { getContacts } from "../servers/gateway/dashboard/panels/contacts/data-queries.js";
import { registerContactsTools } from "../servers/sharing/tools/contacts.js";
import { registerMessagingTools } from "../servers/sharing/tools/messaging.js";

function freshLibsql() {
  const dir = mkdtempSync(join(tmpdir(), "msgreq-gates-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: join(import.meta.dirname, "..") });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { dir, db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

const PK = (c) => "02" + c.repeat(64); // stored compressed contact pubkey (66-hex)
const XO = (c) => c.repeat(64);        // x-only signer (64-hex)

// Insert a contact with a given request_status (NULL/'pending'/'accepted').
async function mkContact(db, { crowId, name = null, isBot = 0, c, requestStatus = null }) {
  const r = await db.execute({
    sql: `INSERT INTO contacts (crow_id, display_name, is_bot, secp256k1_pubkey, ed25519_pubkey, contact_type, request_status)
          VALUES (?,?,?,?,?, 'crow', ?)`,
    args: [crowId, name, isBot, PK(c), "e".repeat(64), requestStatus],
  });
  return Number(r.lastInsertRowid);
}
async function addMessage(db, contactId, content) {
  await db.execute({
    sql: "INSERT INTO messages (contact_id, content, direction, is_read, created_at) VALUES (?,?, 'received', 0, datetime('now'))",
    args: [contactId, content],
  });
}

// Capture registered MCP tool handlers by name from a register* function.
function captureTools(registerFn, ctx) {
  const tools = {};
  const server = { tool: (name, _desc, _schema, handler) => { tools[name] = handler; } };
  registerFn(server, ctx);
  return tools;
}

// --- (a) conversation list: pending hidden, accepted + NULL shown ---
test("getUnifiedConversationList: hides 'pending', shows 'accepted' and NULL", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const full = await mkContact(db, { crowId: "crow:full", name: "Full", c: "f" });
    const acc = await mkContact(db, { crowId: "req:" + XO("a"), c: "a", requestStatus: "accepted" });
    const pend = await mkContact(db, { crowId: "req:" + XO("b"), c: "b", requestStatus: "pending" });
    await addMessage(db, full, "hi full");
    await addMessage(db, acc, "hi accepted");
    await addMessage(db, pend, "hi pending");

    const { items } = await getUnifiedConversationList(db);
    const ids = items.filter((i) => i.type === "peer").map((i) => i.id);
    assert.ok(ids.includes(full), "NULL (full) contact present");
    assert.ok(ids.includes(acc), "'accepted' request present (messaging surface)");
    assert.ok(!ids.includes(pend), "'pending' request hidden");
  } finally { cleanup(); }
});

// --- (b) SECURITY: room_join trust boundary ---
test("SECURITY: room_join from a 'pending'/'accepted' request signer is REJECTED (no room, no member injection)", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    // Two partial rows whose secp keys we control as signers.
    await mkContact(db, { crowId: "req:" + XO("p"), c: "p", requestStatus: "pending" });
    await mkContact(db, { crowId: "req:" + XO("q"), c: "q", requestStatus: "accepted" });
    // A partial row named in the members[] injection attempt.
    await mkContact(db, { crowId: "req:victim", c: "v", requestStatus: "pending" });

    const nostrManager = { async sendControl() {} };
    const join = (signer) => handleInboundRoomEnvelope({
      db, nostrManager, identity: { crowId: "crow:me" }, subtype: "room_join",
      payload: { room_uid: "u-atk", room_name: "Attack", host_crow_id: "req:evil", members: [{ crow_id: "req:victim" }] },
      senderPubkey: signer,
    });

    await join(XO("p")); // pending signer
    assert.equal(await getRoomByUid(db, "u-atk"), null, "'pending' signer cannot create a room");
    await join(XO("q")); // accepted signer (still NOT trust-eligible)
    assert.equal(await getRoomByUid(db, "u-atk"), null, "'accepted' signer cannot create a room either (trust = NULL only)");

    // No partial contact injected into any room membership.
    const { rows: mem } = await db.execute("SELECT COUNT(*) AS c FROM contact_group_members");
    assert.equal(Number(mem[0].c), 0, "no member injection from a rejected room_join");
  } finally { cleanup(); }
});

test("SECURITY: a NULL (full) host DOES pass room_join; members[] naming a partial row is NOT injected", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    await mkContact(db, { crowId: "crow:host", name: "Host", c: "h" }); // full contact host
    await mkContact(db, { crowId: "req:victim", c: "v", requestStatus: "pending" }); // partial named in members
    await mkContact(db, { crowId: "crow:realmember", name: "Real", c: "r" }); // full contact member

    const nostrManager = { async sendControl() {} };
    await handleInboundRoomEnvelope({
      db, nostrManager, identity: { crowId: "crow:me" }, subtype: "room_join",
      payload: { room_uid: "u-ok", room_name: "Team", host_crow_id: "crow:host",
        members: [{ crow_id: "req:victim" }, { crow_id: "crow:realmember" }] },
      senderPubkey: XO("h"),
    });

    const room = await getRoomByUid(db, "u-ok");
    assert.ok(room, "NULL host materialized the room");
    const members = await listRoomMembers(db, room.id);
    const crowIds = members.map((m) => m.crow_id);
    assert.ok(crowIds.includes("crow:realmember"), "full contact member added");
    assert.ok(!crowIds.includes("req:victim"), "partial contact NOT injected as a member");
  } finally { cleanup(); }
});

test("SECURITY: listRoomMembers excludes a partial row even if force-added; room_message signer-auth fails for it", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    // Room hosted here with a legit member + a force-injected partial member.
    const real = await mkContact(db, { crowId: "crow:real", name: "Real", c: "a" });
    const partial = await mkContact(db, { crowId: "req:" + XO("z"), c: "z", requestStatus: "accepted" });
    const { groupId, roomUid } = await createRoom(db, { name: "Team", memberContactIds: [real], mode: "addressed", hostCrowId: "crow:me" });
    await addMember(db, groupId, partial); // simulate a stray membership row

    const members = await listRoomMembers(db, groupId);
    assert.ok(!members.some((m) => m.id === partial), "listRoomMembers excludes the partial row");

    // A room_message signed by the partial's key must be dropped (not a member).
    const nostrManager = { async sendControl() { throw new Error("should not fan"); } };
    await handleInboundRoomEnvelope({
      db, nostrManager, identity: { crowId: "crow:me" }, subtype: "room_message",
      payload: { room_uid: roomUid, msg_uid: "m1", author: { kind: "human" }, text: "intruder", addressed_to: [] },
      senderPubkey: XO("z"),
    });
    assert.equal((await getRoomMessages(db, groupId)).length, 0, "partial-signed room_message dropped");
  } finally { cleanup(); }
});

// --- (c) getContacts + crow_list_contacts exclude partial rows ---
test("getContacts excludes 'pending' and 'accepted' rows", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const full = await mkContact(db, { crowId: "crow:full", name: "Full", c: "f" });
    await mkContact(db, { crowId: "req:" + XO("a"), c: "a", requestStatus: "accepted" });
    await mkContact(db, { crowId: "req:" + XO("b"), c: "b", requestStatus: "pending" });

    const rows = await getContacts(db);
    const ids = rows.map((r) => Number(r.id));
    assert.deepEqual(ids, [full], "only the NULL contact is returned");
  } finally { cleanup(); }
});

test("crow_list_contacts excludes 'pending' and 'accepted' rows", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    await mkContact(db, { crowId: "crow:full", name: "Full", c: "f" });
    await mkContact(db, { crowId: "req:" + XO("a"), c: "a", requestStatus: "accepted" });
    await mkContact(db, { crowId: "req:" + XO("b"), c: "b", requestStatus: "pending" });

    const tools = captureTools(registerContactsTools, {
      db, identity: {}, peerManager: { isConnected: () => false }, syncManager: {}, nostrManager: {},
    });
    const out = await tools.crow_list_contacts({ include_blocked: false });
    const text = out.content.map((c) => c.text).join("\n");
    assert.ok(text.includes("Full") || text.includes("crow:full"), "full contact listed");
    assert.ok(!text.includes("req:"), "no req: partial rows in crow_list_contacts");
  } finally { cleanup(); }
});

// --- (d) crow_send_message: refuse 'pending', allow 'accepted' + NULL ---
test("crow_send_message refuses a 'pending' target but allows 'accepted'", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const pendCrow = "req:" + XO("b");
    const accCrow = "req:" + XO("a");
    await mkContact(db, { crowId: pendCrow, c: "b", requestStatus: "pending" });
    await mkContact(db, { crowId: accCrow, name: "Accepted One", c: "a", requestStatus: "accepted" });
    await mkContact(db, { crowId: "crow:full", name: "Full", c: "f" });

    const sent = [];
    const nostrManager = { sendMessage: async (row) => { sent.push(row.crow_id); return { relays: ["r1"] }; } };
    const tools = captureTools(registerMessagingTools, { db, identity: {}, nostrManager });

    const pendRes = await tools.crow_send_message({ contact: pendCrow, message: "let me in" });
    assert.equal(pendRes.isError, true, "'pending' target refused");
    assert.equal(sent.length, 0, "no send to a pending request");

    const accRes = await tools.crow_send_message({ contact: accCrow, message: "hi back" });
    assert.ok(!accRes.isError, "'accepted' target allowed");
    assert.deepEqual(sent, [accCrow], "accepted request messaged");

    const fullRes = await tools.crow_send_message({ contact: "Full", message: "yo" });
    assert.ok(!fullRes.isError, "NULL (full) target allowed");
    assert.deepEqual(sent, [accCrow, "crow:full"], "full contact messaged");
  } finally { cleanup(); }
});
