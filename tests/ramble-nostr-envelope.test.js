/**
 * Phase 3 — the NostrManager side of the contacts wire.
 *
 * Outbound: `sendControl` wraps a ramble envelope as a kind-4 DM whose
 * content is NIP-44 ciphertext and whose only tag is ["p", recipient] —
 * nothing about the mark is on the relay in the clear.
 * Inbound: the per-contact subscription hands a decrypted `ramble.*`
 * envelope to the bus and stores NO chat message; a blocked contact's
 * envelope vanishes; the catch-all incoming subscription never turns a
 * stranger's envelope into a message request.
 *
 * Harness mirrors tests/block-onevent-guard.test.js (real init-db scratch
 * db, stub relay, real NIP-44 keys).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { getPublicKey, nip44 } from "nostr-tools";
import bus from "../servers/shared/event-bus.js";
import { NostrManager } from "../servers/sharing/nostr.js";

function stubRelay() {
  const r = {
    connected: true, subscribeCalls: [], published: [], closed: false,
    subscribe(filters, { onevent, onclose }) {
      r.subscribeCalls.push({ filters, onevent, onclose });
      return { onevent, onclose, closed: false, close() { this.closed = true; } };
    },
    async publish(event) { r.published.push(event); },
    async connect() { r.connected = true; },
    close() { r.closed = true; },
  };
  return r;
}

const ourPriv = new Uint8Array(32).fill(1);
const theirPriv = new Uint8Array(32).fill(2);
const strangerPriv = new Uint8Array(32).fill(3);
const ourPub = getPublicKey(ourPriv);
const theirPub = getPublicKey(theirPriv);
const strangerPub = getPublicKey(strangerPriv);
const identity = { secp256k1Pubkey: ourPub, secp256k1Priv: ourPriv };
const encryptToUs = (priv, pt) => nip44.v2.encrypt(pt, nip44.v2.utils.getConversationKey(priv, ourPub));

async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "ramble-envelope-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

const ENVELOPE = { type: "ramble.mark", v: 1, mark: { mark_id: "m-secret", kind: "mark", anchor_kind: "geo", geohash: "9v6m21h", lat: 30.46, lon: -98.08, reveal: "open", content_text: "SECRET TEXT", content_kind: "none", created_at: 1 } };

test("sendControl ships a ramble envelope as encrypted kind-4 with only a p tag, and stores no message", async () => {
  const { db, cleanup } = freshDb();
  try {
    const mgr = new NostrManager(identity, db);
    const relay = stubRelay();
    mgr.relays.set("wss://stub", relay);
    const out = await mgr.sendControl({ id: 1, crow_id: "crow:them", secp256k1_pubkey: "02" + theirPub }, JSON.stringify(ENVELOPE));
    assert.deepEqual(out.relays, ["wss://stub"]);
    assert.equal(relay.published.length, 1);
    const ev = relay.published[0];
    assert.equal(ev.kind, 4);
    assert.deepEqual(ev.tags, [["p", theirPub]], "no g tag, no d tag — nothing about the mark is public");
    assert.ok(!ev.content.includes("SECRET TEXT") && !ev.content.includes("ramble.") && !ev.content.includes("9v6m21h"), "content is ciphertext");
    const plain = nip44.v2.decrypt(ev.content, nip44.v2.utils.getConversationKey(theirPriv, ourPub));
    assert.deepEqual(JSON.parse(plain), ENVELOPE);
    const { rows } = await db.execute("SELECT count(*) AS n FROM messages");
    assert.equal(Number(rows[0].n), 0, "a control envelope never becomes a chat row");
  } finally { cleanup(); }
});

test("subscribeToContact: a ramble envelope reaches the bus and stores no message; a plain DM still stores", async () => {
  const { db, cleanup } = freshDb();
  const got = [];
  const listener = (p) => got.push(p);
  bus.on("ramble:envelope", listener);
  let mgr = null;
  try {
    const ins = await db.execute({
      sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, display_name) VALUES ('crow:them', 'ed', ?, 'Them')",
      args: [theirPub],
    });
    const contactId = Number(ins.lastInsertRowid);
    mgr = new NostrManager(identity, db);
    let receipts = 0;
    mgr._sendDeliveryReceipt = async () => { receipts++; };
    const relay = stubRelay();
    mgr.relays.set("wss://stub", relay);
    await mgr.subscribeToContact({ id: contactId, crow_id: "crow:them", secp256k1_pubkey: theirPub, display_name: "Them" });
    const onevent = relay.subscribeCalls[0].onevent;

    await onevent({ id: "evt-r1", pubkey: theirPub, created_at: 1_700_000_000, content: encryptToUs(theirPriv, JSON.stringify(ENVELOPE)) });
    assert.ok(await waitFor(() => got.length === 1), "the envelope must reach the bus");
    assert.deepEqual({ crowId: got[0].crowId, contactId: got[0].contactId, pubkey: got[0].pubkey, eventId: got[0].eventId, createdAt: got[0].createdAt }, { crowId: "crow:them", contactId, pubkey: theirPub, eventId: "evt-r1", createdAt: 1_700_000_000 });
    assert.deepEqual(got[0].payload, ENVELOPE);
    await new Promise((r) => setTimeout(r, 50));
    const rows = await db.execute({ sql: "SELECT count(*) AS n FROM messages WHERE contact_id = ?", args: [contactId] });
    assert.equal(Number(rows.rows[0].n), 0, "never a chat row");
    assert.equal(receipts, 0, "no delivery receipt for a control envelope");

    await onevent({ id: "evt-p1", pubkey: theirPub, created_at: 1_700_000_001, content: encryptToUs(theirPriv, "hello there") });
    assert.ok(await waitFor(async () => Number((await db.execute({ sql: "SELECT count(*) AS n FROM messages WHERE contact_id = ?", args: [contactId] })).rows[0].n) === 1), "a plain DM still stores");
    assert.equal(got.length, 1);

    // A non-ramble JSON DM is untouched by the new branch.
    await onevent({ id: "evt-j1", pubkey: theirPub, created_at: 1_700_000_002, content: encryptToUs(theirPriv, JSON.stringify({ type: "note", text: "x" })) });
    assert.ok(await waitFor(async () => Number((await db.execute({ sql: "SELECT count(*) AS n FROM messages WHERE contact_id = ?", args: [contactId] })).rows[0].n) === 2));
    assert.equal(got.length, 1);
  } finally { bus.off("ramble:envelope", listener); await mgr?.destroy?.(); cleanup(); }
});

test("subscribeToContact: a BLOCKED contact's ramble envelope is dropped before the bus", async () => {
  const { db, cleanup } = freshDb();
  const got = [];
  const listener = (p) => got.push(p);
  bus.on("ramble:envelope", listener);
  let mgr = null;
  try {
    const ins = await db.execute({ sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, display_name, is_blocked) VALUES ('crow:blk', 'ed', ?, 'B', 1)", args: [theirPub] });
    const contactId = Number(ins.lastInsertRowid);
    mgr = new NostrManager(identity, db);
    mgr._sendDeliveryReceipt = async () => {};
    const relay = stubRelay();
    mgr.relays.set("wss://stub", relay);
    await mgr.subscribeToContact({ id: contactId, crow_id: "crow:blk", secp256k1_pubkey: theirPub, display_name: "B" });
    await relay.subscribeCalls[0].onevent({ id: "evt-b1", pubkey: theirPub, created_at: 1_700_000_000, content: encryptToUs(theirPriv, JSON.stringify(ENVELOPE)) });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(got.length, 0);
  } finally { bus.off("ramble:envelope", listener); await mgr?.destroy?.(); cleanup(); }
});

test("subscribeToIncoming: a stranger's ramble envelope is consumed silently (no message request); a plain DM still requests", async () => {
  const { db, cleanup } = freshDb();
  let mgr = null;
  try {
    mgr = new NostrManager(identity, db);
    const relay = stubRelay();
    mgr.relays.set("wss://stub", relay);
    const requests = [];
    await mgr.subscribeToIncoming(async () => {}, async () => {}, async (sender, content) => { requests.push({ sender, content }); });
    const onevent = relay.subscribeCalls[0].onevent;
    await onevent({ id: "in-1", pubkey: strangerPub, created_at: 1_700_000_000, content: encryptToUs(strangerPriv, JSON.stringify(ENVELOPE)) });
    await onevent({ id: "in-2", pubkey: strangerPub, created_at: 1_700_000_001, content: encryptToUs(strangerPriv, "can we talk") });
    assert.ok(await waitFor(() => requests.length === 1));
    assert.deepEqual(requests, [{ sender: strangerPub, content: "can we talk" }]);
  } finally { await mgr?.destroy?.(); cleanup(); }
});
