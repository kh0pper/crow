import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { InstanceSyncManager } from "../servers/sharing/instance-sync.js";
import { sign } from "../servers/sharing/identity.js";
import * as ed from "../node_modules/@noble/ed25519/index.js";
import bus from "../servers/shared/event-bus.js";

const tmpDir = mkdtempSync(join(tmpdir(), "crow-p3b-apply-"));
execFileSync(process.execPath, ["scripts/init-db.js"], {
  env: { ...process.env, CROW_DATA_DIR: tmpDir }, stdio: "pipe",
});
const DB_PATH = join(tmpDir, "crow.db");
after(() => rmSync(tmpDir, { recursive: true, force: true }));

const TEST_PRIV = Buffer.alloc(32, 0xAB);
const TEST_PUB_HEX = Buffer.from(await ed.getPublicKey(TEST_PRIV)).toString("hex");
const IDENTITY = { ed25519Priv: TEST_PRIV, ed25519Pubkey: TEST_PUB_HEX };
const LOCAL_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const REMOTE_ID = "bbbbbbbb-0000-0000-0000-000000000002";
const SECP = "a".repeat(64);

function mgr(id = LOCAL_ID) { return new InstanceSyncManager(IDENTITY, createDbClient(DB_PATH), id); }
function signedEntry(table, op, row, lamport_ts, instance_id = REMOTE_ID) {
  const e = { table, op, row, lamport_ts, instance_id };
  e.signature = sign(JSON.stringify(e), IDENTITY.ed25519Priv);
  return e;
}
async function seedContact(db, id, crowId) {
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey) VALUES (?, ?, '', ?)", args: [id, crowId, SECP] });
}

test("_applyMessage: resolves crow_id → local contact_id (NOT the wire id/contact_id)", async () => {
  const m = mgr(); const db = m.db;
  await seedContact(db, 100, "crow:coh1");
  await m._applyEntry(REMOTE_ID, signedEntry("messages", "insert",
    { id: 9999, contact_id: 4242, crow_id: "crow:coh1", nostr_event_id: "coh-ev1",
      content: "hello from A", direction: "sent", created_at: "2026-07-06T10:00:00Z" }, 10));
  const { rows } = await db.execute({ sql: "SELECT contact_id, content, direction FROM messages WHERE nostr_event_id='coh-ev1'" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].contact_id, 100, "stored under the LOCAL contact_id, not the wire 4242");
  assert.equal(rows[0].content, "hello from A");
  assert.equal(rows[0].direction, "sent", "sent row mirrors as sent (coherent thread)");
});

test("_applyMessage: skips when the contact is not local yet (no phantom contact)", async () => {
  const m = mgr(); const db = m.db;
  const before = (await db.execute("SELECT COUNT(*) c FROM contacts")).rows[0].c;
  await m._applyEntry(REMOTE_ID, signedEntry("messages", "insert",
    { crow_id: "crow:absent", nostr_event_id: "orphan-ev", content: "x", direction: "received", created_at: "2026-07-06T10:00:00Z" }, 4));
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) c FROM messages WHERE nostr_event_id='orphan-ev'" })).rows[0].c, 0, "no message stored");
  assert.equal((await db.execute("SELECT COUNT(*) c FROM contacts")).rows[0].c, before, "no phantom contact created");
});

test("_applyMessage: INSERT OR IGNORE dedupes on nostr_event_id (idempotent re-delivery)", async () => {
  const m = mgr(); const db = m.db;
  await seedContact(db, 101, "crow:coh2");
  const e = signedEntry("messages", "insert",
    { crow_id: "crow:coh2", nostr_event_id: "dup-ev", content: "once", direction: "received", created_at: "2026-07-06T10:00:00Z" }, 5);
  await m._applyEntry(REMOTE_ID, e);
  await m._applyEntry(REMOTE_ID, e); // replay
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) c FROM messages WHERE nostr_event_id='dup-ev'" })).rows[0].c, 1, "exactly one row");
});

test("_applyMessage: a row already stored via direct Nostr is not duplicated by sync", async () => {
  const m = mgr(); const db = m.db;
  await seedContact(db, 102, "crow:coh3");
  // Simulate the direct-Nostr onevent store landing first.
  await db.execute({ sql: "INSERT INTO messages (contact_id, nostr_event_id, content, direction, is_read) VALUES (102, 'both-ev', 'body', 'received', 0)" });
  await m._applyEntry(REMOTE_ID, signedEntry("messages", "insert",
    { crow_id: "crow:coh3", nostr_event_id: "both-ev", content: "body", direction: "received", created_at: "2026-07-06T10:00:00Z" }, 6));
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) c FROM messages WHERE nostr_event_id='both-ev'" })).rows[0].c, 1, "sync did not double-store");
});

test("_applyMessage: fires messages:changed with the LOCAL contact_id on a new row", async () => {
  const m = mgr(); const db = m.db;
  await seedContact(db, 103, "crow:coh4");
  const events = [];
  const onBus = (p) => events.push(p);
  bus.on("messages:changed", onBus);
  await m._applyEntry(REMOTE_ID, signedEntry("messages", "insert",
    { crow_id: "crow:coh4", nostr_event_id: "badge-ev", content: "ping", direction: "received", created_at: "2026-07-06T10:00:00Z" }, 7));
  bus.off("messages:changed", onBus);
  assert.equal(events.length, 1);
  assert.equal(events[0].contactId, 103, "badge event carries the locally-resolved contact_id");
});

test("_applyMessage: a bad wire row (no nostr_event_id) is dropped by the shouldSyncRow gate, never throws", async () => {
  const m = mgr(); const db = m.db;
  await seedContact(db, 104, "crow:coh5");
  await m._applyEntry(REMOTE_ID, signedEntry("messages", "insert", { crow_id: "crow:coh5", content: "no id" }, 4));
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) c FROM messages WHERE content='no id'" })).rows[0].c, 0);
});

test("_applyMessage: a locally-BLOCKED contact still STORES the synced row (I-2)", async () => {
  const m = mgr(); const db = m.db;
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey, is_blocked) VALUES (105, 'crow:blk', '', ?, 1)", args: [SECP] });
  const badgeEvents = [];
  const onBadge = (p) => badgeEvents.push(p);
  bus.on("messages:changed", onBadge);
  await m._applyEntry(REMOTE_ID, signedEntry("messages", "insert",
    { crow_id: "crow:blk", nostr_event_id: "blk-ev", content: "still stored", direction: "received", created_at: "2026-07-06T10:00:00Z" }, 8));
  bus.off("messages:changed", onBadge);
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) c FROM messages WHERE nostr_event_id='blk-ev'" })).rows[0].c, 1,
    "row stored despite block (converged-block semantics — no data loss)");
  assert.equal(badgeEvents.length, 0,
    "M-B1: a blocked contact must not tick the unread badge (messages:changed suppressed)");
  // Notification SUPPRESSION for the blocked contact is asserted in
  // messages-sync-notify.test.js (that file wires the createNotification seam).
});
