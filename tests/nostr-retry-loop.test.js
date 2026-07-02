/**
 * nostr-retry-loop — R5 Task 2. _runRetryTick re-publishes due retry rows to
 * the connected relays (the EXACT stored event) and advances/expires them.
 * Uses a real DB + a fake relay map; asserts republish happened, backoff
 * advanced, an expired row was dropped, and a corrupt raw_event is purged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NostrManager } from "../servers/sharing/nostr.js";
import { enqueueRetry } from "../servers/sharing/retry-queue.js";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "retryloop-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

async function seedContact(db, id, secp) {
  await db.execute({
    sql: `INSERT INTO contacts (id, crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, contact_type)
          VALUES (?, ?, 'Peer', '', ?, 'crow')`,
    args: [id, "crow:peer" + id, secp],
  });
}

// A NostrManager with a fake relay that records published events, no real net.
function fakeManager(db) {
  const identity = { secp256k1Pubkey: "b".repeat(64), secp256k1Priv: new Uint8Array(32) };
  const m = new NostrManager(identity, db);
  const published = [];
  m.relays = new Map([["wss://fake", { connected: true, connect: async () => {}, publish: async (e) => { published.push(e); } }]]);
  return { m, published };
}

test("_runRetryTick republishes a due row and advances its backoff", async () => {
  const { db, cleanup } = freshDb();
  try {
    await seedContact(db, 1, "02" + "a".repeat(64));
    const now = Math.floor(Date.now() / 1000);
    const evt = { id: "evtRetry", kind: 4, content: "cipher", tags: [["p", "a".repeat(64)]] };
    // Enqueue with a next_attempt_at already in the past so it's due now.
    await db.execute({
      sql: `INSERT INTO message_retry_queue (nostr_event_id, contact_id, recipient_pubkey, raw_event, attempt_count, next_attempt_at, created_at)
            VALUES (?, 1, ?, ?, 0, ?, ?)`,
      args: ["evtRetry", "a".repeat(64), JSON.stringify(evt), now - 5, now - 5],
    });
    const { m, published } = fakeManager(db);
    await m._runRetryTick();
    assert.equal(published.length, 1, "republished once");
    assert.equal(published[0].id, "evtRetry", "the EXACT stored event");
    const { rows } = await db.execute({ sql: "SELECT attempt_count FROM message_retry_queue WHERE nostr_event_id='evtRetry'", args: [] });
    assert.equal(Number(rows[0].attempt_count), 1, "attempt advanced");
  } finally { cleanup(); }
});

test("_runRetryTick expires (deletes) a row older than the max age", async () => {
  const { db, cleanup } = freshDb();
  try {
    await seedContact(db, 1, "02" + "a".repeat(64));
    const now = Math.floor(Date.now() / 1000);
    await db.execute({
      sql: `INSERT INTO message_retry_queue (nostr_event_id, contact_id, recipient_pubkey, raw_event, attempt_count, next_attempt_at, created_at)
            VALUES (?, 1, ?, ?, 9, ?, ?)`,
      args: ["evtOld", "a".repeat(64), JSON.stringify({ id: "evtOld" }), now - 5, now - 999999],
    });
    const { m } = fakeManager(db);
    await m._runRetryTick();
    const { rows } = await db.execute({ sql: "SELECT * FROM message_retry_queue WHERE nostr_event_id='evtOld'", args: [] });
    assert.equal(rows.length, 0, "expired row deleted");
  } finally { cleanup(); }
});

test("_runRetryTick purges a corrupt raw_event without throwing", async () => {
  const { db, cleanup } = freshDb();
  try {
    await seedContact(db, 1, "02" + "a".repeat(64));
    const now = Math.floor(Date.now() / 1000);
    await db.execute({
      sql: `INSERT INTO message_retry_queue (nostr_event_id, contact_id, recipient_pubkey, raw_event, attempt_count, next_attempt_at, created_at)
            VALUES (?, 1, ?, ?, 0, ?, ?)`,
      args: ["evtBad", "a".repeat(64), "{not valid json", now - 5, now - 5],
    });
    const { m, published } = fakeManager(db);
    await m._runRetryTick();
    assert.equal(published.length, 0, "nothing republished for a corrupt row");
    const { rows } = await db.execute({ sql: "SELECT * FROM message_retry_queue WHERE nostr_event_id='evtBad'", args: [] });
    assert.equal(rows.length, 0, "corrupt row purged");
  } finally { cleanup(); }
});
