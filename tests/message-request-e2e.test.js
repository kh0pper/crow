/**
 * message-request-e2e — L6 Task 5. End-to-end proof that the operator's bug
 * (an unknown-sender DM was silently dropped) is closed AND the trust
 * boundary introduced to close it cannot be bypassed.
 *
 * Retention story (Step 1): unknown pubkey DMs us (handleIncomingRequest,
 * Task 2) → a 'pending' request contact + the message are created, never
 * lost → accept_request (Task 4's dashboard action) flips it to 'accepted'
 * and marks messages read → the message now surfaces in the NORMAL thread
 * via getPeerMessages and the contact appears in the unified conversation
 * list (Task 3's gates). The message is present at every step.
 *
 * Security story (Step 2, so C1 can't ship green): the SAME unknown pubkey,
 * first while 'pending' and again while 'accepted', tries a room_join
 * crow_social envelope (servers/sharing/room-inbound.js) — this must be
 * REJECTED (no room row, no member injection) because room-join trust is
 * NULL-only. A NULL (full) contact host is a positive control that DOES
 * pass. crow_send_message-style target lookup must refuse the 'pending'
 * target but allow the 'accepted' one (messaging surface = NULL + accepted).
 *
 * Harness reused verbatim from tests/message-request-gates.test.js
 * (freshLibsql / XO helpers) and tests/message-request-actions.test.js
 * (handlePostAction + fakeRes for accept_request).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleIncomingRequest } from "../servers/sharing/boot.js";
import { handlePostAction } from "../servers/gateway/dashboard/panels/messages/api-handlers.js";
import {
  getPeerMessages, getUnifiedConversationList, getMessageRequests,
} from "../servers/gateway/dashboard/panels/messages/data-queries.js";
import { handleInboundRoomEnvelope } from "../servers/sharing/room-inbound.js";
import { getRoomByUid } from "../servers/gateway/dashboard/panels/messages/rooms-store.js";
import { registerMessagingTools } from "../servers/sharing/tools/messaging.js";

function freshLibsql() {
  const dir = mkdtempSync(join(tmpdir(), "msgreq-e2e-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: join(import.meta.dirname, "..") });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { dir, db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

const XO = (c) => c.repeat(64); // x-only signer pubkey, 64-hex (matches event.pubkey shape)
const PK = (c) => "02" + c.repeat(64); // stored compressed contact pubkey (66-hex)

function fakeRes() {
  return { _r: null, headersSent: false, redirectAfterPost(p) { this._r = p; this.headersSent = true; return true; } };
}

function stubManagers(extra = {}) {
  const notifCalls = [];
  return {
    createNotification: async (_db, opts) => { notifCalls.push(opts); return { id: notifCalls.length }; },
    notifCalls,
    ...extra,
  };
}

async function acceptRequest(db, id, managers = { nostrManager: { subscribeToContact: async () => {} } }) {
  const req = { body: { action: "accept_request", request_id: String(id) } };
  const res = fakeRes();
  const handled = await handlePostAction(req, res, { db, _managers: managers });
  assert.equal(handled, true, "accept_request handled");
  assert.equal(res._r, "/dashboard/messages");
}

// ─── Step 1: retention proof ────────────────────────────────────────────
test("L6 retention: unknown-pubkey DM survives request→accept and lands in the normal thread", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const pk = XO("e"); // the unknown sender, simulated end-to-end
    const mgrs = stubManagers();

    // (1) Unknown pubkey "sends" a plaintext DM — the exact call the sharing
    // receive path makes for anything not consumed by a real handler.
    await handleIncomingRequest(db, mgrs, { senderPubkey: pk, content: "hey, are you there?", eventId: "evt-e-1" });

    const { rows: c1 } = await db.execute({ sql: "SELECT * FROM contacts WHERE secp256k1_pubkey = ?", args: [pk] });
    assert.equal(c1.length, 1, "a request contact was created (not dropped)");
    const contactId = c1[0].id;
    assert.equal(c1[0].request_status, "pending", "new contact starts 'pending'");
    assert.equal(c1[0].crow_id, "req:" + pk);

    const { rows: m1 } = await db.execute({ sql: "SELECT * FROM messages WHERE contact_id = ?", args: [contactId] });
    assert.equal(m1.length, 1, "the DM was stored, not lost");
    assert.equal(m1[0].content, "hey, are you there?");
    assert.equal(m1[0].direction, "received");
    assert.equal(Number(m1[0].is_read), 0);

    // A second DM before any accept — still retained, still one contact row.
    await handleIncomingRequest(db, mgrs, { senderPubkey: pk, content: "second message while pending", eventId: "evt-e-2" });
    const { rows: c1b } = await db.execute({ sql: "SELECT COUNT(*) AS n FROM contacts WHERE secp256k1_pubkey = ?", args: [pk] });
    assert.equal(Number(c1b[0].n), 1, "still exactly one contact row (reused, not duplicated)");
    const { rows: m1b } = await db.execute({ sql: "SELECT COUNT(*) AS n FROM messages WHERE contact_id = ?", args: [contactId] });
    assert.equal(Number(m1b[0].n), 2, "both messages retained while pending");

    // Visible in the "Requests (N)" inbox while pending; NOT in the normal
    // unified conversation list yet (Task 3 gate — pending is hidden there).
    const reqs = await getMessageRequests(db);
    assert.ok(reqs.some((r) => r.id === contactId), "request is visible in the Requests inbox");
    const preAccept = await getUnifiedConversationList(db);
    assert.ok(!preAccept.items.some((i) => i.type === "peer" && i.id === contactId), "not yet in the normal thread list while pending");

    // (2) Accept it — the same steps the accept_request handler performs.
    await acceptRequest(db, contactId);

    const { rows: c2 } = await db.execute({ sql: "SELECT request_status FROM contacts WHERE id = ?", args: [contactId] });
    assert.equal(c2[0].request_status, "accepted", "flipped 'pending' → 'accepted'");

    const { rows: unread } = await db.execute({ sql: "SELECT COUNT(*) AS n FROM messages WHERE contact_id = ? AND is_read = 0", args: [contactId] });
    assert.equal(Number(unread[0].n), 0, "messages marked read on accept");

    // (3) The message now appears in the NORMAL thread via getPeerMessages,
    // and the contact shows up in the unified conversation list as accepted.
    const thread = await getPeerMessages(db, contactId);
    assert.equal(thread.length, 2, "both messages present in the normal thread after accept");
    assert.deepEqual(thread.map((m) => m.content), ["hey, are you there?", "second message while pending"]);
    assert.ok(thread.every((m) => Number(m.is_read) === 1), "surfaced messages are marked read");

    const postAccept = await getUnifiedConversationList(db);
    const peerEntry = postAccept.items.find((i) => i.type === "peer" && i.id === contactId);
    assert.ok(peerEntry, "accepted contact now appears in the unified conversation list");

    // The message was never lost across the whole flow: unknown DM → pending
    // → accepted → normal thread.
  } finally { cleanup(); }
});

// ─── Step 2: negative security proof (room-join trust boundary) ────────
test("SECURITY: the same unknown pubkey cannot cross the room-join trust boundary while 'pending' OR 'accepted'", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const pk = XO("v"); // the same unknown sender from the retention story
    const mgrs = stubManagers();

    // Recreate the L6 sequence: unknown DM → 'pending' request contact.
    await handleIncomingRequest(db, mgrs, { senderPubkey: pk, content: "let me in", eventId: "evt-v-1" });
    const { rows } = await db.execute({ sql: "SELECT id FROM contacts WHERE secp256k1_pubkey = ?", args: [pk] });
    const contactId = rows[0].id;

    const nostrManager = { async sendControl() {} };
    const roomJoinPayload = {
      room_uid: "u-e2e-attack",
      room_name: "Attack Room",
      host_crow_id: "req:" + pk,
      members: [{ crow_id: "req:" + pk }],
    };
    const attemptJoin = () => handleInboundRoomEnvelope({
      db, nostrManager, identity: { crowId: "crow:me" }, subtype: "room_join",
      payload: roomJoinPayload, senderPubkey: pk,
    });

    // While 'pending': rejected.
    await attemptJoin();
    assert.equal(await getRoomByUid(db, "u-e2e-attack"), null, "'pending' signer: no room created");
    const { rows: mem1 } = await db.execute("SELECT COUNT(*) AS n FROM contact_group_members");
    assert.equal(Number(mem1[0].n), 0, "'pending' signer: no member injected");

    // Accept the request (matches Step 1's flow) — messaging is now allowed,
    // but trust surfaces must STILL reject it (trust = NULL only).
    await acceptRequest(db, contactId);
    const { rows: c2 } = await db.execute({ sql: "SELECT request_status FROM contacts WHERE id = ?", args: [contactId] });
    assert.equal(c2[0].request_status, "accepted");

    await attemptJoin();
    assert.equal(await getRoomByUid(db, "u-e2e-attack"), null, "'accepted' signer: still no room created");
    const { rows: mem2 } = await db.execute("SELECT COUNT(*) AS n FROM contact_group_members");
    assert.equal(Number(mem2[0].n), 0, "'accepted' signer: still no member injected");

    // Positive control: a NULL (full) contact host DOES pass room_join trust
    // — proves the rejection above is the request-status gate, not a broken
    // room_join path.
    await db.execute({
      sql: `INSERT INTO contacts (crow_id, display_name, secp256k1_pubkey, ed25519_pubkey, contact_type)
            VALUES ('crow:fullhost', 'Full Host', ?, ?, 'crow')`,
      args: [PK("g"), "f".repeat(64)],
    });
    await handleInboundRoomEnvelope({
      db, nostrManager, identity: { crowId: "crow:me" }, subtype: "room_join",
      payload: { room_uid: "u-e2e-ok", room_name: "Legit Room", host_crow_id: "crow:fullhost", members: [] },
      senderPubkey: XO("g"),
    });
    assert.ok(await getRoomByUid(db, "u-e2e-ok"), "NULL (full) host DOES pass room_join trust (positive control)");

    // crow_send_message-style target lookup: refuses 'pending', allows
    // 'accepted' — drive it against the SAME contact across both states.
    const { db: db2, cleanup: cleanup2 } = freshLibsql();
    try {
      const pk2 = XO("w");
      await handleIncomingRequest(db2, stubManagers(), { senderPubkey: pk2, content: "hi", eventId: "evt-w-1" });
      const { rows: r2 } = await db2.execute({ sql: "SELECT id, crow_id FROM contacts WHERE secp256k1_pubkey = ?", args: [pk2] });
      const contact2Id = r2[0].id;
      const crowId2 = r2[0].crow_id;

      const sent = [];
      const tools = {};
      registerMessagingTools({ tool: (name, _d, _s, handler) => { tools[name] = handler; } }, {
        db: db2, identity: {}, nostrManager: { sendMessage: async (row) => { sent.push(row.crow_id); return { relays: ["r1"] }; } },
      });

      const pendRes = await tools.crow_send_message({ contact: crowId2, message: "let me in early" });
      assert.equal(pendRes.isError, true, "'pending' target refused by crow_send_message");
      assert.equal(sent.length, 0, "no send while pending");

      await acceptRequest(db2, contact2Id);
      const accRes = await tools.crow_send_message({ contact: crowId2, message: "welcome" });
      assert.ok(!accRes.isError, "'accepted' target allowed by crow_send_message");
      assert.deepEqual(sent, [crowId2], "message sent once accepted");
    } finally { cleanup2(); }
  } finally { cleanup(); }
});
