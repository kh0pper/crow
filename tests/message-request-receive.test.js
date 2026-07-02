/**
 * message-request-receive — L6 core fix (Task 2). Exercises
 * `handleIncomingRequest`: a decrypted plaintext DM from an unknown sender
 * must become a `request_status='pending'` contact + a stored `received`
 * message + a first-message-only notification, instead of being silently
 * dropped. Also asserts dedup (same nostr_event_id → one message), no
 * re-notify on subsequent messages, and an early-return for a sender that is
 * already a full (NULL request_status) contact.
 *
 * Deps are injected: `createNotification` is stubbed via `managers` so the
 * test asserts notification firing without touching push/email/ntfy.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { handleIncomingRequest } from "../servers/sharing/boot.js";

let dir, db;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "msgreq-test-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir },
    stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  process.env.CROW_DATA_DIR = dir;
  db = createDbClient();
});

after(() => {
  try { db.close(); } catch {}
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

// A managers object whose createNotification just counts invocations.
function stubManagers() {
  const calls = [];
  return {
    calls,
    createNotification: async (_db, opts) => {
      calls.push(opts);
      return { id: calls.length };
    },
  };
}

async function contactsForPk(pk) {
  const norm = String(pk).slice(-64).toLowerCase();
  const { rows } = await db.execute({
    sql: "SELECT * FROM contacts WHERE lower(substr(secp256k1_pubkey,-64)) = ?",
    args: [norm],
  });
  return rows;
}

async function messageCount(contactId) {
  const { rows } = await db.execute({
    sql: "SELECT COUNT(*) AS c FROM messages WHERE contact_id = ?",
    args: [contactId],
  });
  return Number(rows[0].c);
}

test("unknown pubkey → ONE pending contact + ONE received message + ONE notification", async () => {
  const pk = "a".repeat(64);
  const mgrs = stubManagers();

  await handleIncomingRequest(db, mgrs, {
    senderPubkey: pk,
    content: "hey, is this thing on?",
    eventId: "evt-a-1",
  });

  const contacts = await contactsForPk(pk);
  assert.equal(contacts.length, 1, "exactly one request contact created");
  const c = contacts[0];
  assert.equal(c.request_status, "pending", "request_status must be 'pending'");
  assert.equal(c.crow_id, "req:" + pk, "crow_id is req:<FULL 64-hex>");
  assert.equal(c.secp256k1_pubkey, pk);
  assert.equal(c.ed25519_pubkey, "", "ed25519 placeholder is empty string");
  assert.equal(c.contact_type, "crow");

  assert.equal(await messageCount(c.id), 1, "one received message stored");
  const { rows: msgs } = await db.execute({
    sql: "SELECT * FROM messages WHERE contact_id = ?",
    args: [c.id],
  });
  assert.equal(msgs[0].direction, "received");
  assert.equal(Number(msgs[0].is_read), 0);
  assert.equal(msgs[0].content, "hey, is this thing on?");
  assert.equal(msgs[0].nostr_event_id, "evt-a-1");

  assert.equal(mgrs.calls.length, 1, "exactly one notification fired");
  assert.equal(mgrs.calls[0].source, "sharing:message_request");
  assert.equal(mgrs.calls[0].action_url, "/dashboard/messages");
});

test("second message from same pubkey → +1 message, NO 2nd contact, NO 2nd notification", async () => {
  const pk = "a".repeat(64); // same sender as the first test
  const mgrs = stubManagers();

  await handleIncomingRequest(db, mgrs, {
    senderPubkey: pk,
    content: "still here",
    eventId: "evt-a-2",
  });

  const contacts = await contactsForPk(pk);
  assert.equal(contacts.length, 1, "no second contact row");
  assert.equal(await messageCount(contacts[0].id), 2, "second message appended");
  assert.equal(mgrs.calls.length, 0, "no re-notify on a non-new request row");
});

test("same eventId twice → dedup to a single message", async () => {
  const pk = "d".repeat(64);
  const mgrs = stubManagers();

  await handleIncomingRequest(db, mgrs, {
    senderPubkey: pk,
    content: "dup test",
    eventId: "evt-d-dup",
  });
  await handleIncomingRequest(db, mgrs, {
    senderPubkey: pk,
    content: "dup test (retransmit)",
    eventId: "evt-d-dup",
  });

  const contacts = await contactsForPk(pk);
  assert.equal(contacts.length, 1, "one contact");
  assert.equal(await messageCount(contacts[0].id), 1, "event-id dedup → single message");
  // First call created the row → one notify; second call reused it → no notify.
  assert.equal(mgrs.calls.length, 1, "notify only on the newly-created request");
});

test("sender that is already a full (NULL request_status) contact → NO request row, early return", async () => {
  const xonly = "b".repeat(64);
  const compressed = "02" + xonly; // stored 66-hex compressed form

  await db.execute({
    sql: `INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, request_status)
          VALUES (?,?,?,?,NULL)`,
    args: ["crow:full-contact-b", "Full Contact", "ed25519-real", compressed],
  });

  const before = await contactsForPk(xonly);
  assert.equal(before.length, 1, "only the seeded full contact exists");

  const mgrs = stubManagers();
  await handleIncomingRequest(db, mgrs, {
    senderPubkey: xonly, // 32-byte x-only tail of the stored compressed key
    content: "this should be handled by subscribeToContact, not the request path",
    eventId: "evt-b-1",
  });

  const after = await contactsForPk(xonly);
  assert.equal(after.length, 1, "no req: row created for an existing full contact");
  assert.equal(after[0].crow_id, "crow:full-contact-b", "the existing full contact is untouched");
  assert.equal(await messageCount(after[0].id), 0, "request path stored no message (early return)");
  assert.equal(mgrs.calls.length, 0, "no notification for a full contact");
});
