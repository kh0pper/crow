/**
 * contact-promote — R4 Task 2. upsertFullContact is the single idempotent
 * write path for a full (request_status NULL) contact. Covers: fresh insert,
 * promotion of an accepted message-request in place, merge when a duplicate
 * full row already owns the crow_id, and no-op on an existing full contact.
 * managers wiring (sync/DHT/Nostr) is stubbed and its calls are asserted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upsertFullContact } from "../servers/sharing/contact-promote.js";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "promote-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

function stubManagers() {
  const calls = { init: [], join: [], sub: [] };
  return {
    calls,
    syncManager: { initContact: async (id) => calls.init.push(id) },
    peerManager: { joinContact: async (a) => calls.join.push(a) },
    nostrManager: { subscribeToContact: async (a) => calls.sub.push(a) },
  };
}

const PK = "02" + "a".repeat(64);          // 66-hex compressed
const PK_XONLY = "a".repeat(64);           // its 64-hex x-only tail
const ED = "b".repeat(64);
const CROW = "crow:testpeer01";

test("created — fresh full contact when nothing exists", async () => {
  const { db, cleanup } = freshDb();
  try {
    const m = stubManagers();
    const r = await upsertFullContact(db, m, { crowId: CROW, ed25519Pub: ED, secp256k1Pub: PK, displayName: "Peer" });
    assert.equal(r.outcome, "created");
    const { rows } = await db.execute({ sql: "SELECT * FROM contacts WHERE crow_id = ?", args: [CROW] });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].request_status, null);
    assert.equal(rows[0].ed25519_pubkey, ED);
    assert.equal(m.calls.init.length, 1);
    assert.equal(m.calls.join.length, 1);
    assert.equal(m.calls.sub.length, 1);
  } finally { cleanup(); }
});

test("promoted — an accepted request row becomes a full contact in place", async () => {
  const { db, cleanup } = freshDb();
  try {
    // Seed an accepted, secp-only request row (crow_id sentinel, empty ed25519).
    await db.execute({
      sql: `INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, contact_type, request_status)
            VALUES (?, NULL, '', ?, 'crow', 'accepted')`,
      args: ["req:" + PK_XONLY, PK],
    });
    const m = stubManagers();
    const r = await upsertFullContact(db, m, { crowId: CROW, ed25519Pub: ED, secp256k1Pub: PK, displayName: "Peer" });
    assert.equal(r.outcome, "promoted");
    const { rows } = await db.execute({
      sql: "SELECT * FROM contacts WHERE lower(substr(secp256k1_pubkey,-64)) = ?", args: [PK_XONLY],
    });
    assert.equal(rows.length, 1, "no duplicate row");
    assert.equal(rows[0].crow_id, CROW);
    assert.equal(rows[0].request_status, null);
    assert.equal(rows[0].ed25519_pubkey, ED);
    assert.equal(m.calls.join.length, 1, "promotion wires DHT join");
  } finally { cleanup(); }
});

test("merged — request messages fold into a pre-existing full contact, request row deleted", async () => {
  const { db, cleanup } = freshDb();
  try {
    // A full contact already owns CROW (e.g. added via crow_accept_invite)...
    const full = await db.execute({
      sql: `INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, contact_type)
            VALUES (?, 'Peer', ?, ?, 'crow')`,
      args: [CROW, ED, PK],
    });
    const fullId = Number(full.lastInsertRowid);
    // ...and a separate request row for the SAME secp key accrued a message.
    const reqRow = await db.execute({
      sql: `INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, contact_type, request_status)
            VALUES (?, '', ?, 'crow', 'pending')`,
      args: ["req:" + PK_XONLY, PK],
    });
    const reqId = Number(reqRow.lastInsertRowid);
    await db.execute({
      sql: `INSERT INTO messages (contact_id, nostr_event_id, content, direction, is_read, created_at)
            VALUES (?, 'evt-merge', 'hi', 'received', 0, datetime('now'))`,
      args: [reqId],
    });
    const m = stubManagers();
    const r = await upsertFullContact(db, m, { crowId: CROW, ed25519Pub: ED, secp256k1Pub: PK, displayName: "Peer" });
    assert.equal(r.outcome, "merged");
    const reqGone = await db.execute({ sql: "SELECT id FROM contacts WHERE id = ?", args: [reqId] });
    assert.equal(reqGone.rows.length, 0, "request row deleted");
    const moved = await db.execute({ sql: "SELECT contact_id FROM messages WHERE nostr_event_id = 'evt-merge'", args: [] });
    assert.equal(Number(moved.rows[0].contact_id), fullId, "message reassigned to the full contact");
  } finally { cleanup(); }
});

test("noop — an existing full contact is left as-is (no re-wire)", async () => {
  const { db, cleanup } = freshDb();
  try {
    await db.execute({
      sql: `INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, contact_type)
            VALUES (?, 'Peer', ?, ?, 'crow')`,
      args: [CROW, ED, PK],
    });
    const m = stubManagers();
    const r = await upsertFullContact(db, m, { crowId: CROW, ed25519Pub: ED, secp256k1Pub: PK, displayName: "Peer" });
    assert.equal(r.outcome, "noop");
    assert.equal(m.calls.sub.length, 0, "no re-subscribe on a live full contact");
  } finally { cleanup(); }
});

test("rejects the req: sentinel and a missing secp key", async () => {
  const { db, cleanup } = freshDb();
  try {
    await assert.rejects(() => upsertFullContact(db, stubManagers(), { crowId: "req:" + PK_XONLY, ed25519Pub: ED, secp256k1Pub: PK }));
    await assert.rejects(() => upsertFullContact(db, stubManagers(), { crowId: CROW, ed25519Pub: ED, secp256k1Pub: "" }));
  } finally { cleanup(); }
});
