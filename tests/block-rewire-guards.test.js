/**
 * Cluster C D3 + D4d — the sync-apply blocked branch performs the FULL
 * teardown (incl. the Nostr unsub the old inline pair missed); a blocked
 * contact's invite_accepted is silenced (no upsert, no ack — even on the
 * ~60h replay of an already-processed event); wireFullContact refuses to
 * wire a blocked row.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { getPublicKey } from "nostr-tools";
import { wireSyncedContact, wireFullContact } from "../servers/sharing/contact-promote.js";
import { handleInviteAccepted } from "../servers/sharing/boot.js";
import { recordProcessedEvent } from "../servers/sharing/processed-events.js";

const theirPriv = new Uint8Array(32).fill(7);
const theirPub = getPublicKey(theirPriv);

function freshDb(tag) {
  const dir = mkdtempSync(join(tmpdir(), `block-rewire-${tag}-`));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

function stubManagers() {
  const calls = [];
  return {
    calls,
    nostrManager: {
      unsubscribeFromContact: (crowId) => calls.push(["unsub", crowId]),
      subscribeToContact: async (c) => calls.push(["sub", c.crow_id || c.crowId]),
      sendControl: async () => calls.push(["ack"]),
      relays: new Map([["wss://stub", {}]]),
      connectRelays: async () => {},
      sendInviteAccepted: async () => {},
    },
    syncManager: {
      closeContactFeeds: async (id) => calls.push(["closeFeeds", id]),
      initContact: async (id) => calls.push(["initContact", id]),
    },
    peerManager: {
      leaveContact: async (crowId) => calls.push(["leave", crowId]),
      joinContact: async (c) => calls.push(["join", c.crowId]),
    },
  };
}

test("D3: wireSyncedContact on a blocked row performs the FULL teardown (incl. Nostr unsub)", async () => {
  const m = stubManagers();
  await wireSyncedContact(m, { id: 7, crow_id: "crow:blocked1", is_blocked: 1, secp256k1_pubkey: theirPub, ed25519_pubkey: "ed" });
  const kinds = m.calls.map((c) => c[0]);
  assert.ok(kinds.includes("unsub"), "Nostr unsubscribe — the leg the old inline pair missed");
  assert.ok(kinds.includes("closeFeeds"), "feeds closed");
  assert.ok(kinds.includes("leave"), "DHT topic left");
  assert.ok(!kinds.includes("sub"), "never subscribes a blocked row");
});

test("D4d belt: wireFullContact refuses a blocked row", async () => {
  const m = stubManagers();
  await wireFullContact(m, { id: 8, crow_id: "crow:blocked2", is_blocked: 1, secp256k1_pubkey: theirPub, ed25519_pubkey: "ed" });
  assert.equal(m.calls.length, 0, "no initContact/joinContact/subscribeToContact for a blocked row");
});

test("D4d: blocked sender's invite_accepted → no upsert, no ack — even for an already-processed event.id", async () => {
  const { db, cleanup } = freshDb("d4d");
  try {
    await db.execute({
      sql: "INSERT INTO contacts (crow_id, secp256k1_pubkey, ed25519_pubkey, display_name, is_blocked) VALUES ('crow:blocked3', ?, 'ed', 'Blocked3', 1)",
      args: [theirPub],
    });
    // The common blocked shape: the handshake WAS processed once, THEN the
    // user blocked. The sender's ~60h retry re-sends the same event.id.
    await recordProcessedEvent(db, "evt-replayed", "invite_accepted");

    const m = stubManagers();
    const payload = { type: "invite_accepted", crowId: "crow:blocked3", ed25519Pub: "ed", secp256k1Pub: theirPub, displayName: "Evil Rename" };
    await handleInviteAccepted(db, m, payload, theirPub, { id: "evt-replayed" });

    assert.ok(!m.calls.some((c) => c[0] === "ack"), "NO handshake ack to a blocked sender (placement before the replay branch)");
    const { rows } = await db.execute("SELECT display_name FROM contacts WHERE crow_id = 'crow:blocked3'");
    assert.equal(rows[0].display_name, "Blocked3", "no upsert mutation");
    assert.ok(!m.calls.some((c) => c[0] === "sub" || c[0] === "initContact"), "no re-wire");
  } finally { cleanup(); }
});
