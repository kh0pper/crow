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

const tmpDir = mkdtempSync(join(tmpdir(), "crow-p3b-notify-"));
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

test("_applyMessage: notifies on a NEW received row, with nostr_event_id collapse key", async () => {
  const m = mgr(); const db = m.db;
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey, display_name) VALUES (200, 'crow:n1', '', ?, 'Alice')", args: [SECP] });
  const notes = [];
  m.createNotification = async (_db, opts) => { notes.push(opts); return { id: 1 }; };
  await m._applyEntry(REMOTE_ID, signedEntry("messages", "insert",
    { crow_id: "crow:n1", nostr_event_id: "n-ev1", content: "hi Alice", direction: "received", created_at: "2026-07-06T10:00:00Z" }, 5));
  assert.equal(notes.length, 1);
  assert.match(notes[0].title, /Alice/);
  assert.equal(notes[0].type, "peer");
  assert.equal(notes[0].metadata?.nostr_event_id, "n-ev1", "collapse key present");
});

test("_applyMessage: a SENT mirror does NOT notify", async () => {
  const m = mgr(); const db = m.db;
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey, display_name) VALUES (201, 'crow:n2', '', ?, 'Bob')", args: [SECP] });
  const notes = [];
  m.createNotification = async (_db, opts) => { notes.push(opts); return { id: 1 }; };
  await m._applyEntry(REMOTE_ID, signedEntry("messages", "insert",
    { crow_id: "crow:n2", nostr_event_id: "n-ev2", content: "I sent this", direction: "sent", created_at: "2026-07-06T10:00:00Z" }, 5));
  assert.equal(notes.length, 0, "own sent rows never notify");
});

test("_applyMessage: a duplicate (rowsAffected=0) does NOT notify", async () => {
  const m = mgr(); const db = m.db;
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey, display_name) VALUES (202, 'crow:n3', '', ?, 'Cy')", args: [SECP] });
  await db.execute({ sql: "INSERT INTO messages (contact_id, nostr_event_id, content, direction, is_read) VALUES (202, 'n-ev3', 'body', 'received', 0)" });
  const notes = [];
  m.createNotification = async (_db, opts) => { notes.push(opts); return { id: 1 }; };
  await m._applyEntry(REMOTE_ID, signedEntry("messages", "insert",
    { crow_id: "crow:n3", nostr_event_id: "n-ev3", content: "body", direction: "received", created_at: "2026-07-06T10:00:00Z" }, 5));
  assert.equal(notes.length, 0, "already-existing row → no notify (per-instance dedupe)");
});

test("_applyMessage: a throwing createNotification never breaks the apply loop", async () => {
  const m = mgr(); const db = m.db;
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey, display_name) VALUES (203, 'crow:n4', '', ?, 'Di')", args: [SECP] });
  m.createNotification = async () => { throw new Error("boom"); };
  await m._applyEntry(REMOTE_ID, signedEntry("messages", "insert",
    { crow_id: "crow:n4", nostr_event_id: "n-ev4", content: "still stored", direction: "received", created_at: "2026-07-06T10:00:00Z" }, 5));
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) c FROM messages WHERE nostr_event_id='n-ev4'" })).rows[0].c, 1, "row stored despite notify throw");
});

test("_applyMessage: a locally-BLOCKED contact stores the row but does NOT notify (I-2)", async () => {
  const m = mgr(); const db = m.db;
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey, display_name, is_blocked) VALUES (204, 'crow:blk2', '', ?, 'Blocked', 1)", args: [SECP] });
  const notes = [];
  m.createNotification = async (_db, opts) => { notes.push(opts); return { id: 1 }; };
  await m._applyEntry(REMOTE_ID, signedEntry("messages", "insert",
    { crow_id: "crow:blk2", nostr_event_id: "blk-n-ev", content: "hi", direction: "received", created_at: "2026-07-06T10:00:00Z" }, 6));
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) c FROM messages WHERE nostr_event_id='blk-n-ev'" })).rows[0].c, 1, "row stored");
  assert.equal(notes.length, 0, "blocked contact → notification suppressed (the security control)");
});

test("direct-Nostr notify path carries the nostr_event_id collapse key (I-1)", async () => {
  // Mirrors the incoming-DM createNotification at nostr.js:486. Asserts the stored
  // notification ROW carries the collapse key, so a device that also receives this
  // DM via instance-sync (which notifies with the same key) can dedupe the two
  // pushes. (The call-site wiring at nostr.js:486 is additionally exercised by the
  // live E2E; this test locks the row-level contract the call site must satisfy.)
  const { createNotification } = await import("../servers/shared/notifications.js");
  const m = mgr(); const db = m.db;
  const res = await createNotification(db, {
    title: "Message from Alice",
    type: "peer",
    source: "sharing:message",
    action_url: "/dashboard/messages",
    metadata: { nostr_event_id: "direct-ev1" }, // <-- I-1 adds exactly this at :486
  });
  assert.ok(res && res.id, "notification created (peer type enabled by default)");
  const { rows } = await db.execute({ sql: "SELECT metadata FROM notifications WHERE id = ?", args: [res.id] });
  assert.equal(JSON.parse(rows[0].metadata).nostr_event_id, "direct-ev1", "direct-path collapse key persisted");
});
