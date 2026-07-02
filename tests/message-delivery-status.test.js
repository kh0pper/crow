import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { NostrManager } from "../servers/sharing/nostr.js";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";

// Real (throwaway) secp256k1 keys — NIP-44 conversation-key derivation needs
// valid curve points, unlike the all-zero stub used by resubscribe tests
// (which never reach the encryption path).
const senderPriv = generateSecretKey();
const identity = { secp256k1Pubkey: getPublicKey(senderPriv), secp256k1Priv: senderPriv };
const recipientPriv = generateSecretKey();
const recipientPubkey = getPublicKey(recipientPriv);

// Minimal relay stub matching what safeRelayPublish expects (connected + publish()).
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

let dir, db, contactId;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "message-delivery-status-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: join(import.meta.dirname, ".."),
  });
  process.env.CROW_DATA_DIR = dir;
  db = createDbClient();

  const res = await db.execute({
    sql: `INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey) VALUES (?, ?, ?)`,
    args: ["crow:test-contact", "b".repeat(64), "c".repeat(64)],
  });
  contactId = Number(res.lastInsertRowid);
});

after(() => {
  try { db.close(); } catch {}
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

test("sendMessage persists delivery_status='relayed' when publish succeeds to >=1 relay", async () => {
  const mgr = new NostrManager(identity, db);
  mgr.relays.set("wss://stub-ok", stubRelay({ connected: true, shouldPublish: true }));

  const contact = { id: contactId, secp256k1_pubkey: recipientPubkey };
  const result = await mgr.sendMessage(contact, "hello relayed");

  assert.ok(result.relays.length >= 1, "expected >=1 relay to accept publish");

  const row = await db.execute({
    sql: `SELECT delivery_status FROM messages WHERE nostr_event_id = ?`,
    args: [result.eventId],
  });
  assert.equal(row.rows[0].delivery_status, "relayed");
});

test("sendMessage persists delivery_status='failed' when 0 relays accept publish", async () => {
  const mgr = new NostrManager(identity, db);
  mgr.relays.set("wss://stub-fail", stubRelay({ connected: true, shouldPublish: false }));

  const contact = { id: contactId, secp256k1_pubkey: recipientPubkey };
  const result = await mgr.sendMessage(contact, "hello failed");

  assert.deepEqual(result.relays, []);

  const row = await db.execute({
    sql: `SELECT delivery_status FROM messages WHERE nostr_event_id = ?`,
    args: [result.eventId],
  });
  assert.equal(row.rows[0].delivery_status, "failed");
});

test("sendMessage persists delivery_status='failed' when relays.size===0 (no relays connected)", async () => {
  const mgr = new NostrManager(identity, db);
  // No relays set — sendMessage will call connectRelays(), but override it to
  // stay empty so we don't hit the live network in a unit test.
  mgr.connectRelays = async () => {};

  const contact = { id: contactId, secp256k1_pubkey: recipientPubkey };
  const result = await mgr.sendMessage(contact, "hello no relays");

  assert.deepEqual(result.relays, []);

  const row = await db.execute({
    sql: `SELECT delivery_status FROM messages WHERE nostr_event_id = ?`,
    args: [result.eventId],
  });
  assert.equal(row.rows[0].delivery_status, "failed");
});
