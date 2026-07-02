/**
 * message-retry-queue — R5 Task 1. The delivery-reliability primitives:
 * pure envelope/eligibility/backoff helpers + the persisted retry store
 * (enqueue / dueRetries / recordAttempt / markDelivered). Asserts the
 * eligibility sniff, backoff schedule, monotonic enqueue, due-selection,
 * expiry vs advance, and contact-bound deletion. Every DB helper is guarded.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DELIVERY_RECEIPT_SUBTYPE, buildDeliveryReceipt, shouldEnqueue, backoffSeconds,
  enqueueRetry, dueRetries, recordAttempt, markDelivered,
} from "../servers/sharing/retry-queue.js";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "retryq-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

// --- pure helpers ---

test("buildDeliveryReceipt makes a crow_social/delivery_receipt envelope", () => {
  const s = buildDeliveryReceipt(["e1", "e2", "", null, 5]);
  const p = JSON.parse(s);
  assert.equal(p.type, "crow_social");
  assert.equal(p.subtype, DELIVERY_RECEIPT_SUBTYPE);
  assert.deepEqual(p.payload.event_ids, ["e1", "e2"]); // non-string/empty dropped
});

test("shouldEnqueue: plain relayed DM to a peer → true", () => {
  assert.equal(shouldEnqueue({ content: "hi there", publishedCount: 1, recipientNorm: "a".repeat(64), ownNorm: "b".repeat(64) }), true);
});
test("shouldEnqueue: 0 relays → false", () => {
  assert.equal(shouldEnqueue({ content: "hi", publishedCount: 0, recipientNorm: "a".repeat(64), ownNorm: "b".repeat(64) }), false);
});
test("shouldEnqueue: self-message → false", () => {
  assert.equal(shouldEnqueue({ content: "hi", publishedCount: 2, recipientNorm: "a".repeat(64), ownNorm: "a".repeat(64) }), false);
});
test("shouldEnqueue: crow_social envelope (group msg) → false", () => {
  const env = JSON.stringify({ type: "crow_social", subtype: "group_message", payload: {} });
  assert.equal(shouldEnqueue({ content: env, publishedCount: 1, recipientNorm: "a".repeat(64), ownNorm: "b".repeat(64) }), false);
});
test("shouldEnqueue: invite_accepted envelope → false", () => {
  const env = JSON.stringify({ type: "invite_accepted", crowId: "crow:x" });
  assert.equal(shouldEnqueue({ content: env, publishedCount: 1, recipientNorm: "a".repeat(64), ownNorm: "b".repeat(64) }), false);
});
test("shouldEnqueue: a plain message that merely starts with '{' but isn't an envelope → true", () => {
  assert.equal(shouldEnqueue({ content: "{not json", publishedCount: 1, recipientNorm: "a".repeat(64), ownNorm: "b".repeat(64) }), true);
});

test("backoffSeconds follows the schedule and clamps", () => {
  assert.equal(backoffSeconds(1), 30);
  assert.equal(backoffSeconds(2), 120);
  assert.equal(backoffSeconds(4), 3600);
  assert.equal(backoffSeconds(6), 43200);
  assert.equal(backoffSeconds(99), 43200); // clamp to every-12h
  assert.equal(backoffSeconds(0), 30);     // guard: treated as first
});

// --- persisted store ---

async function seedContact(db, id, secp) {
  await db.execute({
    sql: `INSERT INTO contacts (id, crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, contact_type)
          VALUES (?, ?, 'Peer', '', ?, 'crow')`,
    args: [id, "crow:peer" + id, secp],
  });
}

test("enqueueRetry inserts a due-in-30s row; dueRetries respects next_attempt_at", async () => {
  const { db, cleanup } = freshDb();
  try {
    await seedContact(db, 1, "02" + "a".repeat(64));
    const now = 1_800_000_000;
    await enqueueRetry(db, { eventId: "evt1", contactId: 1, recipientPubkey: "a".repeat(64), rawEvent: '{"id":"evt1"}', nowSec: now });
    assert.equal((await dueRetries(db, now, 50)).length, 0, "not due yet (30s out)");
    const due = await dueRetries(db, now + 31, 50);
    assert.equal(due.length, 1);
    assert.equal(due[0].nostr_event_id, "evt1");
    assert.equal(Number(due[0].attempt_count), 0);
  } finally { cleanup(); }
});

test("enqueueRetry is idempotent on event id (INSERT OR IGNORE)", async () => {
  const { db, cleanup } = freshDb();
  try {
    await seedContact(db, 1, "02" + "a".repeat(64));
    const now = 1_800_000_000;
    await enqueueRetry(db, { eventId: "evtDup", contactId: 1, recipientPubkey: "a".repeat(64), rawEvent: "{}", nowSec: now });
    await enqueueRetry(db, { eventId: "evtDup", contactId: 1, recipientPubkey: "a".repeat(64), rawEvent: "{}", nowSec: now });
    const { rows } = await db.execute({ sql: "SELECT COUNT(*) c FROM message_retry_queue WHERE nostr_event_id='evtDup'", args: [] });
    assert.equal(Number(rows[0].c), 1);
  } finally { cleanup(); }
});

test("recordAttempt advances backoff below max age, expires (deletes) past it", async () => {
  const { db, cleanup } = freshDb();
  try {
    await seedContact(db, 1, "02" + "a".repeat(64));
    const now = 1_800_000_000;
    await enqueueRetry(db, { eventId: "evtA", contactId: 1, recipientPubkey: "a".repeat(64), rawEvent: "{}", nowSec: now });
    const row = (await dueRetries(db, now + 31, 50))[0];
    const r1 = await recordAttempt(db, row, now + 31, 216000); // maxAge 60h
    assert.equal(r1.expired, false);
    const after = (await db.execute({ sql: "SELECT * FROM message_retry_queue WHERE nostr_event_id='evtA'", args: [] })).rows[0];
    assert.equal(Number(after.attempt_count), 1);
    // recordAttempt sets attempt_count = old+1 (=1) and schedules the NEXT
    // retry: backoffSeconds((old+1)+1) = backoffSeconds(2) = 120.
    assert.equal(Number(after.next_attempt_at), (now + 31) + backoffSeconds(2));
    // now force expiry: created_at far in the past
    const r2 = await recordAttempt(db, { ...after, created_at: now - 999999 }, now + 40, 216000);
    assert.equal(r2.expired, true);
    const gone = await db.execute({ sql: "SELECT * FROM message_retry_queue WHERE nostr_event_id='evtA'", args: [] });
    assert.equal(gone.rows.length, 0, "expired row deleted");
  } finally { cleanup(); }
});

test("markDelivered is contact-bound: only deletes the acking contact's rows", async () => {
  const { db, cleanup } = freshDb();
  try {
    await seedContact(db, 1, "02" + "a".repeat(64));
    await seedContact(db, 2, "02" + "b".repeat(64));
    const now = 1_800_000_000;
    await enqueueRetry(db, { eventId: "mine", contactId: 1, recipientPubkey: "a".repeat(64), rawEvent: "{}", nowSec: now });
    await enqueueRetry(db, { eventId: "other", contactId: 2, recipientPubkey: "b".repeat(64), rawEvent: "{}", nowSec: now });
    // An attacker (contact 2) tries to purge contact 1's retry by naming its event id.
    await markDelivered(db, ["mine"], 2);
    assert.equal((await db.execute({ sql: "SELECT * FROM message_retry_queue WHERE nostr_event_id='mine'", args: [] })).rows.length, 1, "contact 1's row untouched");
    // The legit ack from contact 1 clears it.
    await markDelivered(db, ["mine"], 1);
    assert.equal((await db.execute({ sql: "SELECT * FROM message_retry_queue WHERE nostr_event_id='mine'", args: [] })).rows.length, 0);
  } finally { cleanup(); }
});

test("guards: DB helpers never throw on a broken db", async () => {
  const broken = { execute: async () => { throw new Error("boom"); } };
  await enqueueRetry(broken, { eventId: "x", contactId: 1, recipientPubkey: "a", rawEvent: "{}", nowSec: 1 });
  assert.deepEqual(await dueRetries(broken, 1, 50), []);
  assert.deepEqual(await recordAttempt(broken, { created_at: 0, attempt_count: 0, id: 1 }, 2, 10), { expired: false });
  await markDelivered(broken, ["x"], 1); // must not throw
});
