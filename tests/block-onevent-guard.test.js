/**
 * Cluster C D4a — a per-contact subscription that is still live when the
 * contact is blocked (block→teardown race, or a future wiring path that
 * forgets teardown) must NOT store, receipt, or surface the inbound DM.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { getPublicKey, nip44 } from "nostr-tools";
import { NostrManager } from "../servers/sharing/nostr.js";

function stubRelay() {
  const r = {
    connected: true, subscribeCalls: [], closed: false,
    subscribe(filters, { onevent, onclose }) {
      r.subscribeCalls.push({ filters, onevent, onclose });
      const s = { onevent, onclose, closed: false, close() { this.closed = true; } };
      return s;
    },
    async connect() { r.connected = true; },
    close() { r.closed = true; },
  };
  return r;
}

const ourPriv = new Uint8Array(32).fill(1);
const theirPriv = new Uint8Array(32).fill(2);
const ourPub = getPublicKey(ourPriv);
const theirPub = getPublicKey(theirPriv);
const identity = { secp256k1Pubkey: ourPub, secp256k1Priv: ourPriv };
const encryptToUs = (pt) => nip44.v2.encrypt(pt, nip44.v2.utils.getConversationKey(theirPriv, ourPub));

// The real onevent handler is invoked by resilient-subscribe.js's `wrapped()`
// without being awaited (deliberate: a relay callback must never block on our
// DB work). So `await onevent(event)` in this test resolves before onevent's
// own internal await chain (block-check -> INSERT -> notify -> unread SELECT
// -> receipt) settles. Poll for the eventually-consistent outcome instead of
// asserting immediately.
async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "block-onevent-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

test("onevent: blocked contact's DM is silently dropped (no row, no receipt); unblocked stores", async () => {
  const { db, cleanup } = freshDb();
  try {
    const ins = await db.execute({
      sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, display_name) VALUES ('crow:blockee', 'ed', ?, 'Blockee')",
      args: [theirPub],
    });
    const contactId = Number(ins.lastInsertRowid);

    const mgr = new NostrManager(identity, db);
    let receipts = 0;
    mgr._sendDeliveryReceipt = async () => { receipts++; };
    const relay = stubRelay();
    mgr.relays.set("wss://stub", relay);
    await mgr.subscribeToContact({ id: contactId, crow_id: "crow:blockee", secp256k1_pubkey: theirPub, display_name: "Blockee" });
    const onevent = relay.subscribeCalls[0].onevent;

    const countRows = async () => {
      const n = await db.execute({ sql: "SELECT COUNT(*) AS c FROM messages WHERE contact_id = ?", args: [contactId] });
      return Number(n.rows[0].c);
    };

    // Block AFTER subscribe — the sub is live (the F-BLOCK-1 shape).
    await db.execute({ sql: "UPDATE contacts SET is_blocked = 1 WHERE id = ?", args: [contactId] });
    await onevent({ id: "evt-blocked", pubkey: theirPub, created_at: 1_700_000_000, content: encryptToUs("while blocked") });
    // Settle window: give a wrongly-implemented guard a real chance to store
    // or receipt before asserting the negative.
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(await countRows(), 0, "blocked inbound must NOT store");
    assert.equal(receipts, 0, "blocked inbound must NOT be receipted (silence)");

    // Unblock — the same live sub stores again (fresh check each event).
    await db.execute({ sql: "UPDATE contacts SET is_blocked = 0 WHERE id = ?", args: [contactId] });
    await onevent({ id: "evt-unblocked", pubkey: theirPub, created_at: 1_700_000_001, content: encryptToUs("after unblock") });
    const stored = await waitFor(async () => (await countRows()) === 1);
    assert.ok(stored, "unblocked inbound stores");
    const receipted = await waitFor(() => receipts === 1);
    assert.ok(receipted, "unblocked inbound is receipted");
    await mgr.destroy();
  } finally { cleanup(); }
});
