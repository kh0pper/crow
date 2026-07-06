/**
 * handshake-complete — P2/C4 Task 3. Proves the completion ack that stops an
 * offline inviter from stranding the pairing handshake:
 *
 *  - buildHandshakeComplete: pure crow_social envelope naming invite_accepted
 *    event id(s) (mirrors buildDeliveryReceipt).
 *  - NostrManager.sendInviteAccepted: sends the acceptance DM like sendControl
 *    (no message row) AND enqueues it for retry on publish — the ONE deliberate
 *    exception to shouldEnqueue's invite_accepted exclusion.
 *  - handleInviteAccepted: emits the ack after a successful promote AND at the
 *    "replayed" ledger verdict (I4 self-heal), but NEVER on "expired" or an
 *    auth-fail.
 *  - handleHandshakeComplete: clears the acceptor's retry row, CONTACT-BOUND to
 *    the authenticated sender — a forged ack naming another contact's event ids
 *    must not clear them.
 *
 * Real (throwaway) secp256k1 keys are used wherever NIP-44 encryption is
 * actually exercised (sendInviteAccepted, via NostrManager) — an all-zero key
 * is not a valid curve scalar (message-delivery-status.test.js precedent).
 * handleInviteAccepted / handleHandshakeComplete tests stub the collaborators
 * (nostrManager.sendControl spied, syncManager/peerManager no-ops) against a
 * real on-disk libsql db (invite-accepted-promote.test.js precedent) so the
 * real upsertFullContact / findContactByPubkey / shortcode-ledger code runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";

import {
  HANDSHAKE_COMPLETE_SUBTYPE,
  buildHandshakeComplete,
  DELIVERY_RECEIPT_SUBTYPE,
} from "../servers/sharing/retry-queue.js";
import { NostrManager } from "../servers/sharing/nostr.js";
import { handleInviteAccepted, handleHandshakeComplete } from "../servers/sharing/boot.js";
import { recordShortInvite, consumeShortInvite } from "../servers/sharing/shortcode-ledger.js";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "handshake-complete-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

// Minimal relay stub matching what safeRelayPublish expects.
function stubRelay({ connected = true, shouldPublish = true } = {}) {
  return {
    connected,
    async connect() { this.connected = true; },
    async publish() {
      if (!shouldPublish) throw new Error("publish rejected");
      return { id: "ev" };
    },
  };
}

// --- buildHandshakeComplete: pure envelope --------------------------------

test("buildHandshakeComplete: crow_social envelope naming event ids", () => {
  const env = JSON.parse(buildHandshakeComplete(["evt-1", "evt-2", 5, ""]));
  assert.equal(env.type, "crow_social");
  assert.equal(env.subtype, HANDSHAKE_COMPLETE_SUBTYPE);
  assert.deepEqual(env.payload.event_ids, ["evt-1", "evt-2"]); // non-strings dropped
  assert.notEqual(HANDSHAKE_COMPLETE_SUBTYPE, DELIVERY_RECEIPT_SUBTYPE);
});

// --- A. NostrManager.sendInviteAccepted: the retry carve-in ---------------

test("A1: sendInviteAccepted enqueues a retry row when publish succeeds, writes NO message row", async () => {
  const { db, cleanup } = freshDb();
  try {
    const senderPriv = generateSecretKey();
    const identity = { secp256k1Pubkey: getPublicKey(senderPriv), secp256k1Priv: senderPriv };
    const recipientPriv = generateSecretKey();
    const recipientPubkey = getPublicKey(recipientPriv);

    const res = await db.execute({
      sql: `INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey) VALUES (?, ?, ?)`,
      args: ["crow:acceptor-target", "d".repeat(64), recipientPubkey],
    });
    const contactId = Number(res.lastInsertRowid);

    const mgr = new NostrManager(identity, db);
    mgr.relays.set("wss://stub-ok", stubRelay({ connected: true, shouldPublish: true }));

    const content = JSON.stringify({ type: "invite_accepted", crowId: "crow:me" });
    const result = await mgr.sendInviteAccepted({ id: contactId, secp256k1_pubkey: recipientPubkey }, content);

    assert.ok(result.relays.length >= 1, "expected >=1 relay to accept publish");
    assert.ok(result.eventId, "returns the signed event id");

    const retryRow = await db.execute({
      sql: `SELECT * FROM message_retry_queue WHERE nostr_event_id = ?`,
      args: [result.eventId],
    });
    assert.equal(retryRow.rows.length, 1, "the acceptance DM was enqueued for retry");
    assert.equal(retryRow.rows[0].contact_id, contactId);

    const msgRow = await db.execute({
      sql: `SELECT * FROM messages WHERE nostr_event_id = ?`,
      args: [result.eventId],
    });
    assert.equal(msgRow.rows.length, 0, "no 1:1 message row for a control envelope");
  } finally { cleanup(); }
});

test("A2: sendInviteAccepted does NOT enqueue when 0 relays accept publish", async () => {
  const { db, cleanup } = freshDb();
  try {
    const senderPriv = generateSecretKey();
    const identity = { secp256k1Pubkey: getPublicKey(senderPriv), secp256k1Priv: senderPriv };
    const recipientPriv = generateSecretKey();
    const recipientPubkey = getPublicKey(recipientPriv);

    const res = await db.execute({
      sql: `INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey) VALUES (?, ?, ?)`,
      args: ["crow:acceptor-target-2", "d".repeat(64), recipientPubkey],
    });
    const contactId = Number(res.lastInsertRowid);

    const mgr = new NostrManager(identity, db);
    mgr.relays.set("wss://stub-down", stubRelay({ connected: true, shouldPublish: false }));

    const content = JSON.stringify({ type: "invite_accepted", crowId: "crow:me" });
    const result = await mgr.sendInviteAccepted({ id: contactId, secp256k1_pubkey: recipientPubkey }, content);

    assert.deepEqual(result.relays, []);

    const retryRow = await db.execute({
      sql: `SELECT * FROM message_retry_queue WHERE nostr_event_id = ?`,
      args: [result.eventId],
    });
    assert.equal(retryRow.rows.length, 0, "0-relay publish must not enqueue a retry");
  } finally { cleanup(); }
});

test("A3: sendInviteAccepted enqueue failure never throws out of the send", async () => {
  const { db, cleanup } = freshDb();
  try {
    const senderPriv = generateSecretKey();
    const identity = { secp256k1Pubkey: getPublicKey(senderPriv), secp256k1Priv: senderPriv };
    const recipientPriv = generateSecretKey();
    const recipientPubkey = getPublicKey(recipientPriv);

    // A db whose execute always throws — simulates an enqueueRetry failure.
    const throwingDb = { execute: async () => { throw new Error("db down"); } };
    const mgr = new NostrManager(identity, throwingDb);
    mgr.relays.set("wss://stub-ok", stubRelay({ connected: true, shouldPublish: true }));

    const content = JSON.stringify({ type: "invite_accepted", crowId: "crow:me" });
    const result = await mgr.sendInviteAccepted({ id: 7, secp256k1_pubkey: recipientPubkey }, content); // must resolve
    assert.ok(result.eventId);
  } finally { cleanup(); }
});

// --- handleInviteAccepted: ack emission ------------------------------------

const PK = "02" + "c".repeat(64);
const PK_XONLY = "c".repeat(64);
const ATTACKER_PK = "02" + "e".repeat(64);

function stubMgrsWithAck() {
  const sendControlCalls = [];
  return {
    mgrs: {
      syncManager: { initContact: async () => {} },
      peerManager: { joinContact: async () => {} },
      nostrManager: {
        subscribeToContact: async () => {},
        sendControl: async (contact, content) => {
          sendControlCalls.push({ contact, content });
          return { eventId: "ack-evt", relays: ["stub://r1"] };
        },
      },
    },
    sendControlCalls,
  };
}

test("B: handleInviteAccepted emits the handshake_complete ack on promote-success", async () => {
  const { db, cleanup } = freshDb();
  try {
    const { mgrs, sendControlCalls } = stubMgrsWithAck();
    const payload = { type: "invite_accepted", crowId: "crow:realpeer9", ed25519Pub: "d".repeat(64), secp256k1Pub: PK };
    const event = { id: "invacc-evt-1" };

    await handleInviteAccepted(db, mgrs, payload, PK, event);

    const { rows } = await db.execute({ sql: "SELECT * FROM contacts WHERE crow_id = ?", args: ["crow:realpeer9"] });
    assert.equal(rows.length, 1, "promote happened");
    assert.equal(rows[0].request_status, null);

    assert.equal(sendControlCalls.length, 1, "ack sent exactly once");
    assert.equal(sendControlCalls[0].contact.secp256k1_pubkey, PK);
    const env = JSON.parse(sendControlCalls[0].content);
    assert.equal(env.subtype, HANDSHAKE_COMPLETE_SUBTYPE);
    assert.deepEqual(env.payload.event_ids, ["invacc-evt-1"]);
  } finally { cleanup(); }
});

test("C (I4): handleInviteAccepted acks on the replayed verdict too, WITHOUT re-promoting", async () => {
  const { db, cleanup } = freshDb();
  try {
    const { mgrs, sendControlCalls } = stubMgrsWithAck();
    const inviteId = "test-inviteid-replayed";
    await recordShortInvite(db, inviteId, Date.now() + 600000);
    // Consume once ourselves so the ledger row is already "consumed" —
    // handleInviteAccepted's own consume call will then see "replayed".
    assert.equal(await consumeShortInvite(db, inviteId), "consumed");

    const payload = {
      type: "invite_accepted", crowId: "crow:realpeer9", ed25519Pub: "d".repeat(64),
      secp256k1Pub: PK, inviteId,
    };
    const event = { id: "invacc-evt-replayed" };

    await handleInviteAccepted(db, mgrs, payload, PK, event);

    const { rows } = await db.execute({ sql: "SELECT COUNT(*) c FROM contacts", args: [] });
    assert.equal(Number(rows[0].c), 0, "no promotion on a replayed verdict");

    assert.equal(sendControlCalls.length, 1, "the cross-restart self-heal ack still fires");
    const env = JSON.parse(sendControlCalls[0].content);
    assert.deepEqual(env.payload.event_ids, ["invacc-evt-replayed"]);
  } finally { cleanup(); }
});

test("D: handleInviteAccepted does NOT ack on the expired verdict", async () => {
  const { db, cleanup } = freshDb();
  try {
    const { mgrs, sendControlCalls } = stubMgrsWithAck();
    const inviteId = "test-inviteid-expired";
    await recordShortInvite(db, inviteId, Date.now() - 1000); // already past its window

    const payload = {
      type: "invite_accepted", crowId: "crow:realpeer9", ed25519Pub: "d".repeat(64),
      secp256k1Pub: PK, inviteId,
    };
    const event = { id: "invacc-evt-expired" };

    await handleInviteAccepted(db, mgrs, payload, PK, event);

    const { rows } = await db.execute({ sql: "SELECT COUNT(*) c FROM contacts", args: [] });
    assert.equal(Number(rows[0].c), 0, "no promotion on an expired verdict");
    assert.equal(sendControlCalls.length, 0, "no ack on expired — a stranded acceptor retries until R4-repair");
  } finally { cleanup(); }
});

test("E: handleInviteAccepted does NOT ack on auth-fail (forged sender), and never touches the ledger", async () => {
  const { db, cleanup } = freshDb();
  try {
    const { mgrs, sendControlCalls } = stubMgrsWithAck();
    const inviteId = "test-inviteid-authfail";
    await recordShortInvite(db, inviteId, Date.now() + 600000);

    // Forged payload: claims PK's secp key, but signed (senderPubkey) by the attacker.
    const forged = {
      type: "invite_accepted", crowId: "crow:realpeer9", ed25519Pub: "f".repeat(64),
      secp256k1Pub: PK, inviteId,
    };
    const event = { id: "invacc-evt-authfail" };

    await handleInviteAccepted(db, mgrs, forged, ATTACKER_PK, event);

    const { rows } = await db.execute({ sql: "SELECT COUNT(*) c FROM contacts", args: [] });
    assert.equal(Number(rows[0].c), 0, "no promotion on auth-fail");
    assert.equal(sendControlCalls.length, 0, "no ack on auth-fail");

    // The ledger gate runs only after the auth check — since auth failed, the
    // real consumeShortInvite call below must see the row still outstanding.
    assert.equal(await consumeShortInvite(db, inviteId), "consumed");
  } finally { cleanup(); }
});

test("H: handleInviteAccepted still promotes with a missing event, but sends NO ack (guarded, never throws)", async () => {
  const { db, cleanup } = freshDb();
  try {
    const { mgrs, sendControlCalls } = stubMgrsWithAck();
    const payload = { type: "invite_accepted", crowId: "crow:realpeer9", ed25519Pub: "d".repeat(64), secp256k1Pub: PK };

    await handleInviteAccepted(db, mgrs, payload, PK); // no event arg at all

    const { rows } = await db.execute({ sql: "SELECT * FROM contacts WHERE crow_id = ?", args: ["crow:realpeer9"] });
    assert.equal(rows.length, 1, "promote still happens without an event");
    assert.equal(sendControlCalls.length, 0, "no ack possible without an event id");
  } finally { cleanup(); }
});

// --- handleHandshakeComplete: contact-bound clearing -----------------------

async function seedContact(db, crowId, secpPubkey) {
  const res = await db.execute({
    sql: `INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey) VALUES (?, ?, ?)`,
    args: [crowId, "d".repeat(64), secpPubkey],
  });
  return Number(res.lastInsertRowid);
}

async function seedRetryRow(db, { eventId, contactId }) {
  await db.execute({
    sql: `INSERT INTO message_retry_queue
            (nostr_event_id, contact_id, recipient_pubkey, raw_event, attempt_count, next_attempt_at, created_at)
          VALUES (?, ?, ?, '{}', 0, 0, 0)`,
    args: [eventId, contactId, "irrelevant"],
  });
}

test("F: handleHandshakeComplete clears the retry row, contact-bound to the authenticated sender", async () => {
  const { db, cleanup } = freshDb();
  try {
    const contactId = await seedContact(db, "crow:acceptor-owner", PK);
    await seedRetryRow(db, { eventId: "evt-1", contactId });

    await handleHandshakeComplete(db, ["evt-1"], PK_XONLY);

    const { rows } = await db.execute({ sql: "SELECT * FROM message_retry_queue WHERE nostr_event_id = ?", args: ["evt-1"] });
    assert.equal(rows.length, 0, "the retry row was cleared");
  } finally { cleanup(); }
});

test("G: a forged handshake_complete (resolving to a DIFFERENT contact) does NOT clear another contact's retry row", async () => {
  const { db, cleanup } = freshDb();
  try {
    const ownerContactId = await seedContact(db, "crow:acceptor-owner-2", PK);
    await seedRetryRow(db, { eventId: "evt-1", contactId: ownerContactId });

    // The attacker has their own real contact row under a different secp key —
    // their ack is authentically signed by THEM, but names an event id that
    // belongs to a different contact's retry row.
    const attackerContactId = await seedContact(db, "crow:attacker", ATTACKER_PK);
    assert.notEqual(attackerContactId, ownerContactId);

    await handleHandshakeComplete(db, ["evt-1"], ATTACKER_PK);

    const { rows } = await db.execute({ sql: "SELECT * FROM message_retry_queue WHERE nostr_event_id = ?", args: ["evt-1"] });
    assert.equal(rows.length, 1, "the row for the real owner must survive the forged ack");
    assert.equal(rows[0].contact_id, ownerContactId);
  } finally { cleanup(); }
});

test("G2: a handshake_complete from an unrecognized sender (no matching contact) never throws and clears nothing", async () => {
  const { db, cleanup } = freshDb();
  try {
    const ownerContactId = await seedContact(db, "crow:acceptor-owner-3", PK);
    await seedRetryRow(db, { eventId: "evt-1", contactId: ownerContactId });

    await handleHandshakeComplete(db, ["evt-1"], "f".repeat(64)); // no contact resolves

    const { rows } = await db.execute({ sql: "SELECT * FROM message_retry_queue WHERE nostr_event_id = ?", args: ["evt-1"] });
    assert.equal(rows.length, 1, "row untouched when the sender resolves to no contact");
  } finally { cleanup(); }
});
