/**
 * accept-idempotent — P2/C4 Task 2. Proves acceptInviteCore is idempotent and
 * repairable now that it routes contact creation through upsertFullContact
 * (R4) instead of a raw INSERT + "Already connected" short-circuit:
 *   1. Fresh accept of an unknown peer creates a contact and shows the safety
 *      number.
 *   2. Re-accepting the SAME invite code twice must NOT throw / hit a UNIQUE
 *      violation — the second call is a non-error noop, contact count stays 1.
 *   3. Accepting an invite whose secp key matches an existing partial
 *      (request_status='accepted') contact PROMOTES that row in place (one
 *      row, real display_name) instead of erroring or duplicating.
 *   4. The acceptancePayload still carries inviteId when the invite code had
 *      one — captured from BOTH sendMessage and sendInviteAccepted into one
 *      shared array, so this assertion survives Task 3's swap to
 *      sendInviteAccepted without editing this test.
 *
 * Harness follows short-invite-tools.test.js: freshLibsql() + captureTools()
 * + a stubbed nostrManager (no live relays/Hyperswarm).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerContactsTools } from "../servers/sharing/tools/contacts.js";
import { deriveInstanceIdentity, generateInviteCode } from "../servers/sharing/identity.js";

function freshLibsql() {
  const dir = mkdtempSync(join(tmpdir(), "accept-idempotent-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { dir, db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

// Capture registered MCP tool handlers by name (message-request-gates.test.js
// / short-invite-tools.test.js pattern).
function captureTools(registerFn, ctx) {
  const tools = {};
  const server = { tool: (name, _desc, _schema, handler) => { tools[name] = handler; } };
  registerFn(server, ctx);
  return tools;
}

// nostrManager stub: sendMessage AND sendInviteAccepted both push into ONE
// shared `sent` array, so a caller can assert on the acceptance payload
// regardless of which method acceptInviteCore currently calls (this task
// calls sendMessage; Task 3 swaps to sendInviteAccepted).
function makeNostrStub(sent) {
  return {
    relays: new Map([["stub://r1", {}]]), // non-empty: acceptInviteCore skips connectRelays()
    async connectRelays() { return [...this.relays.keys()]; },
    async subscribeToContact() {},
    sendMessage: async (contact, content) => { sent.push({ contact, content }); return { eventId: "e", relays: ["stub://r1"] }; },
    sendInviteAccepted: async (contact, content) => { sent.push({ contact, content }); return { eventId: "e", relays: ["stub://r1"] }; },
  };
}

const stubPeerManager = { joinContact: async () => {} };
const stubSyncManager = { initContact: async () => {} };

// --- 1. Fresh accept: unknown peer -> contact created, safety number shown ---
test("crow_accept_invite: fresh accept creates a contact and shows the safety number", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const identity = deriveInstanceIdentity(randomBytes(32));
    const inviter = deriveInstanceIdentity(randomBytes(32));
    const code = generateInviteCode(inviter);

    const sent = [];
    const nostrManager = makeNostrStub(sent);
    const tools = captureTools(registerContactsTools, {
      db, identity, peerManager: stubPeerManager, syncManager: stubSyncManager, nostrManager,
    });

    const res = await tools.crow_accept_invite({ invite_code: code });
    assert.ok(!res.isError, `fresh accept should succeed: ${res.content?.[0]?.text}`);
    const text = res.content.map((c) => c.text).join("\n");
    assert.match(text, /Safety Number:/, "safety number is shown");

    const { rows } = await db.execute({ sql: "SELECT * FROM contacts WHERE crow_id = ?", args: [inviter.crowId] });
    assert.equal(rows.length, 1, "exactly one contact row inserted");
    assert.equal(rows[0].secp256k1_pubkey, inviter.secp256k1Pubkey);
  } finally { cleanup(); }
});

// --- 2. Re-accept idempotency: same invite code twice -> no throw/UNIQUE, 1 row ---
test("crow_accept_invite: re-accepting the SAME invite twice is a non-error noop (idempotent)", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const identity = deriveInstanceIdentity(randomBytes(32));
    const inviter = deriveInstanceIdentity(randomBytes(32));
    const code = generateInviteCode(inviter);

    const sent = [];
    const nostrManager = makeNostrStub(sent);
    const tools = captureTools(registerContactsTools, {
      db, identity, peerManager: stubPeerManager, syncManager: stubSyncManager, nostrManager,
    });

    const first = await tools.crow_accept_invite({ invite_code: code });
    assert.ok(!first.isError, `first accept should succeed: ${first.content?.[0]?.text}`);

    // Second accept of the SAME code — must not throw, no UNIQUE violation,
    // and must NOT be the old "Already connected" isError-free-but-terse
    // short-circuit turned error by a raw INSERT collision.
    const second = await tools.crow_accept_invite({ invite_code: code });
    assert.ok(!second.isError, `re-accept should be a non-error result, got: ${second.content?.[0]?.text}`);

    const { rows } = await db.execute({ sql: "SELECT COUNT(*) AS c FROM contacts WHERE crow_id = ?", args: [inviter.crowId] });
    assert.equal(Number(rows[0].c), 1, "contact count stays 1 after re-accept");
  } finally { cleanup(); }
});

// --- 3. Repair a partial (request_status='accepted') row -> promoted in place ---
test("crow_accept_invite: accepting an invite matching a partial contact's secp key PROMOTES it in place", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const identity = deriveInstanceIdentity(randomBytes(32));
    const inviter = deriveInstanceIdentity(randomBytes(32));
    const code = generateInviteCode(inviter);

    // Seed a partial message-request contact sharing the inviter's secp key,
    // with a placeholder crow_id/display_name (the shape handleInviteAccepted
    // et al. produce for a gated, not-yet-full contact).
    const secpXOnly = inviter.secp256k1Pubkey.length === 66
      ? inviter.secp256k1Pubkey.slice(2) : inviter.secp256k1Pubkey;
    await db.execute({
      sql: `INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, contact_type, request_status)
            VALUES (?, ?, '', ?, 'crow', 'accepted')`,
      args: ["req:" + secpXOnly, "req:" + secpXOnly, inviter.secp256k1Pubkey],
    });

    const sent = [];
    const nostrManager = makeNostrStub(sent);
    const tools = captureTools(registerContactsTools, {
      db, identity, peerManager: stubPeerManager, syncManager: stubSyncManager, nostrManager,
    });

    const res = await tools.crow_accept_invite({ invite_code: code, display_name: "Real Name" });
    assert.ok(!res.isError, `promote-accept should succeed: ${res.content?.[0]?.text}`);
    const text = res.content.map((c) => c.text).join("\n");
    assert.match(text, /Safety Number:/, "safety number still shown on promote");

    const { rows } = await db.execute({
      sql: "SELECT * FROM contacts WHERE lower(substr(secp256k1_pubkey,-64)) = ?", args: [secpXOnly.toLowerCase()],
    });
    assert.equal(rows.length, 1, "still exactly one row — promoted, not duplicated");
    assert.equal(rows[0].request_status, null, "request_status cleared (promoted to a full contact)");
    assert.equal(rows[0].crow_id, inviter.crowId, "crow_id repaired to the real invite crowId");
    assert.equal(rows[0].display_name, "Real Name", "placeholder display_name replaced with the real one");
  } finally { cleanup(); }
});

// --- 4. inviteId round-trips through the acceptancePayload ---
test("crow_accept_invite: acceptancePayload carries inviteId when the invite code had one (captured from sendMessage OR sendInviteAccepted)", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const identity = deriveInstanceIdentity(randomBytes(32));
    const inviter = deriveInstanceIdentity(randomBytes(32));
    const inviteId = "accept-idempotent-inviteid-1";
    const code = generateInviteCode(inviter, { inviteId, expiresInMs: 10 * 60 * 1000 });

    const sent = [];
    const nostrManager = makeNostrStub(sent);
    const tools = captureTools(registerContactsTools, {
      db, identity, peerManager: stubPeerManager, syncManager: stubSyncManager, nostrManager,
    });

    const res = await tools.crow_accept_invite({ invite_code: code });
    assert.ok(!res.isError, `accept should succeed: ${res.content?.[0]?.text}`);

    assert.equal(sent.length, 1, "exactly one acceptance send captured (from sendMessage or sendInviteAccepted)");
    const acceptancePayload = JSON.parse(sent[0].content);
    assert.equal(acceptancePayload.type, "invite_accepted");
    assert.equal(acceptancePayload.inviteId, inviteId, "acceptancePayload echoes the code's inviteId");
  } finally { cleanup(); }
});
