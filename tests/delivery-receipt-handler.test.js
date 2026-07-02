/**
 * delivery-receipt-handler — R5 Task 4. handleDeliveryReceipt flips a sent
 * message relayed→delivered and clears its retry row, but ONLY for the contact
 * the receipt authentically came from (event.id is public on relays, so a
 * forged receipt from another contact must NOT mark or purge). Late acks still
 * flip the column even when no retry row remains.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleDeliveryReceipt } from "../servers/sharing/boot.js";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "ackh-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

const PK_REAL = "02" + "a".repeat(64);   // contact 1 (real recipient)
const XONLY_REAL = "a".repeat(64);
const PK_ATTACKER = "02" + "c".repeat(64); // contact 2 (attacker)
const XONLY_ATTACKER = "c".repeat(64);

async function seed(db) {
  await db.execute({ sql: `INSERT INTO contacts (id, crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, contact_type) VALUES (1,'crow:real','Real','', ?, 'crow')`, args: [PK_REAL] });
  await db.execute({ sql: `INSERT INTO contacts (id, crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, contact_type) VALUES (2,'crow:atk','Atk','', ?, 'crow')`, args: [PK_ATTACKER] });
  await db.execute({ sql: `INSERT INTO messages (contact_id, nostr_event_id, content, direction, is_read, delivery_status, created_at) VALUES (1,'evtSent','hi','sent',1,'relayed',datetime('now'))`, args: [] });
  await db.execute({ sql: `INSERT INTO message_retry_queue (nostr_event_id, contact_id, recipient_pubkey, raw_event, attempt_count, next_attempt_at, created_at) VALUES ('evtSent',1,?, '{}',0,1,1)`, args: [XONLY_REAL] });
}

test("authentic receipt flips relayed→delivered and clears the retry row", async () => {
  const { db, cleanup } = freshDb();
  try {
    await seed(db);
    await handleDeliveryReceipt(db, ["evtSent"], XONLY_REAL);
    const msg = (await db.execute({ sql: "SELECT delivery_status FROM messages WHERE nostr_event_id='evtSent'", args: [] })).rows[0];
    assert.equal(msg.delivery_status, "delivered");
    const q = await db.execute({ sql: "SELECT * FROM message_retry_queue WHERE nostr_event_id='evtSent'", args: [] });
    assert.equal(q.rows.length, 0, "retry row cleared");
  } finally { cleanup(); }
});

test("forged receipt from a different contact does NOT mark or purge", async () => {
  const { db, cleanup } = freshDb();
  try {
    await seed(db);
    await handleDeliveryReceipt(db, ["evtSent"], XONLY_ATTACKER); // attacker names a public event id
    const msg = (await db.execute({ sql: "SELECT delivery_status FROM messages WHERE nostr_event_id='evtSent'", args: [] })).rows[0];
    assert.equal(msg.delivery_status, "relayed", "unchanged");
    const q = await db.execute({ sql: "SELECT * FROM message_retry_queue WHERE nostr_event_id='evtSent'", args: [] });
    assert.equal(q.rows.length, 1, "retry row intact");
  } finally { cleanup(); }
});

test("late ack (no retry row left) still flips the column", async () => {
  const { db, cleanup } = freshDb();
  try {
    await seed(db);
    await db.execute({ sql: "DELETE FROM message_retry_queue WHERE nostr_event_id='evtSent'", args: [] }); // expired earlier
    await handleDeliveryReceipt(db, ["evtSent"], XONLY_REAL);
    const msg = (await db.execute({ sql: "SELECT delivery_status FROM messages WHERE nostr_event_id='evtSent'", args: [] })).rows[0];
    assert.equal(msg.delivery_status, "delivered");
  } finally { cleanup(); }
});

test("unknown sender is a safe no-op and never throws", async () => {
  const { db, cleanup } = freshDb();
  try {
    await seed(db);
    await handleDeliveryReceipt(db, ["evtSent"], "f".repeat(64)); // no matching contact
    const msg = (await db.execute({ sql: "SELECT delivery_status FROM messages WHERE nostr_event_id='evtSent'", args: [] })).rows[0];
    assert.equal(msg.delivery_status, "relayed");
    await handleDeliveryReceipt({ execute: async () => { throw new Error("boom"); } }, ["evtSent"], XONLY_REAL); // broken db → no throw
  } finally { cleanup(); }
});
