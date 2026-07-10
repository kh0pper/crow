/**
 * invite-accepted-promote — R4 Task 3. handleInviteAccepted must promote an
 * existing accepted/pending message-request row (secp-only, gated) into a full
 * (request_status NULL) contact when the same secp identity sends a valid
 * invite_accepted, WITHOUT creating a duplicate — and add a brand-new full
 * contact when no prior row exists. Managers are stubbed (no live relays).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleInviteAccepted } from "../servers/sharing/boot.js";
import { recordShortInvite, consumeShortInvite } from "../servers/sharing/shortcode-ledger.js";
import { wasProcessed, recordProcessedEvent } from "../servers/sharing/processed-events.js";
import { writeTombstone, readTombstone } from "../servers/sharing/contact-delete.js";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "invacc-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}
const stubMgrs = () => ({
  syncManager: { initContact: async () => {} },
  peerManager: { joinContact: async () => {} },
  nostrManager: { subscribeToContact: async () => {} },
});

// Like stubMgrs but with a spied sendControl so the handshake_complete ack can
// be observed (D4 replay hygiene: a stale retry is skipped but STILL acked).
const stubMgrsWithAck = () => {
  const sendControlCalls = [];
  return {
    mgrs: {
      syncManager: { initContact: async () => {} },
      peerManager: { joinContact: async () => {} },
      nostrManager: {
        subscribeToContact: async () => {},
        sendControl: async (contact, content) => {
          sendControlCalls.push({ contact, content });
          return { eventId: "ack-evt", relays: [] };
        },
      },
    },
    sendControlCalls,
  };
};

const PK = "02" + "c".repeat(64);
const PK_XONLY = "c".repeat(64);
// Distinct attacker secp key — the sender identity of a forged event, NOT
// the victim key the forged payload claims to be.
const ATTACKER_PK = "02" + "e".repeat(64);
const payload = { type: "invite_accepted", crowId: "crow:realpeer9", ed25519Pub: "d".repeat(64), secp256k1Pub: PK };

test("promotes an accepted request in place (no duplicate)", async () => {
  const { db, cleanup } = freshDb();
  try {
    await db.execute({
      sql: `INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, contact_type, request_status)
            VALUES (?, '', ?, 'crow', 'accepted')`,
      args: ["req:" + PK_XONLY, PK],
    });
    await handleInviteAccepted(db, stubMgrs(), payload, PK);
    const { rows } = await db.execute({
      sql: "SELECT * FROM contacts WHERE lower(substr(secp256k1_pubkey,-64)) = ?", args: [PK_XONLY],
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].crow_id, "crow:realpeer9");
    assert.equal(rows[0].request_status, null);
  } finally { cleanup(); }
});

test("adds a fresh full contact when no prior row exists", async () => {
  const { db, cleanup } = freshDb();
  try {
    await handleInviteAccepted(db, stubMgrs(), payload, PK);
    const { rows } = await db.execute({ sql: "SELECT * FROM contacts WHERE crow_id = ?", args: ["crow:realpeer9"] });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].request_status, null);
  } finally { cleanup(); }
});

test("ignores an incomplete payload and never throws", async () => {
  const { db, cleanup } = freshDb();
  try {
    await handleInviteAccepted(db, stubMgrs(), { type: "invite_accepted", crowId: "crow:x" }, PK); // no keys
    const { rows } = await db.execute({ sql: "SELECT COUNT(*) c FROM contacts", args: [] });
    assert.equal(Number(rows[0].c), 0);
  } finally { cleanup(); }
});

test("does NOT promote when the payload secp key != the authenticated sender key (forgery)", async () => {
  const { db, cleanup } = freshDb();
  try {
    // Seed a gated (accepted) message-request row for the VICTIM secp key —
    // this is the row a forged invite_accepted would try to hijack.
    await db.execute({
      sql: `INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, contact_type, request_status)
            VALUES (?, '', ?, 'crow', 'accepted')`,
      args: ["req:" + PK_XONLY, PK],
    });

    // Forged payload: claims the VICTIM's secp key, but the Nostr event was
    // actually signed (and thus authenticated) by the ATTACKER's key — the
    // attacker's own ed25519Pub rides along so a naive promotion would
    // rebind the victim's gated row to the attacker's sync identity.
    const forged = {
      type: "invite_accepted",
      crowId: "crow:realpeer9",
      ed25519Pub: "f".repeat(64), // attacker's own ed25519 key
      secp256k1Pub: PK, // claims the VICTIM's secp key
    };

    await handleInviteAccepted(db, stubMgrs(), forged, ATTACKER_PK);

    // The gated row must be untouched: still request_status set (not
    // promoted to full/NULL), and no new/duplicate full contact created.
    const { rows } = await db.execute({
      sql: "SELECT * FROM contacts WHERE lower(substr(secp256k1_pubkey,-64)) = ?", args: [PK_XONLY],
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].crow_id, "req:" + PK_XONLY);
    assert.notEqual(rows[0].request_status, null);

    const { rows: allRows } = await db.execute({ sql: "SELECT COUNT(*) c FROM contacts", args: [] });
    assert.equal(Number(allRows[0].c), 1);

    const { rows: crowIdRows } = await db.execute({
      sql: "SELECT * FROM contacts WHERE crow_id = ?", args: ["crow:realpeer9"],
    });
    assert.equal(crowIdRows.length, 0);
  } finally { cleanup(); }
});

test("I2: an unauthenticated (forged-sender) invite_accepted carrying a valid inviteId must NOT consume the short-code ledger token", async () => {
  const { db, cleanup } = freshDb();
  try {
    // Seed a gated (accepted) message-request row for the VICTIM secp key,
    // same shape as the forgery test above.
    await db.execute({
      sql: `INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, contact_type, request_status)
            VALUES (?, '', ?, 'crow', 'accepted')`,
      args: ["req:" + PK_XONLY, PK],
    });

    // A real, still-outstanding short-code ledger row for this inviteId.
    const inviteId = "test-inviteid-i2";
    await recordShortInvite(db, inviteId, Date.now() + 600000);

    // Forged payload: claims the VICTIM's secp key AND rides a valid
    // inviteId, but the Nostr event was actually signed by the ATTACKER's key.
    const forged = {
      type: "invite_accepted",
      crowId: "crow:realpeer9",
      ed25519Pub: "f".repeat(64),
      secp256k1Pub: PK,
      inviteId,
    };

    await handleInviteAccepted(db, stubMgrs(), forged, ATTACKER_PK);

    // Not promoted (same assertion shape as the forgery test above).
    const { rows } = await db.execute({
      sql: "SELECT * FROM contacts WHERE lower(substr(secp256k1_pubkey,-64)) = ?", args: [PK_XONLY],
    });
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].request_status, null);

    // The ledger gate must run ONLY after the auth check — since auth failed
    // here, the row must still be outstanding. Consuming it now for the
    // FIRST time must return "consumed" (not "replayed"), proving the forged
    // call never touched it.
    assert.equal(await consumeShortInvite(db, inviteId), "consumed");
  } finally { cleanup(); }
});

// --- Task 11 (design §D4): clock-free replay hygiene ----------------------

test("D4 replay hygiene: a recorded event.id is skipped (no resurrection) but STILL acks; a fresh event.id re-adds even with an OLDER created_at", async () => {
  const { db, cleanup } = freshDb();
  try {
    const { mgrs, sendControlCalls } = stubMgrsWithAck();
    const crowId = "crow:realpeer9";
    // Two invite_accepted events: same crowId/payload, DIFFERENT event.id.
    const ev1 = { id: "invacc-evt-A", created_at: 1000 };
    const ev2 = { id: "invacc-evt-B", created_at: 500 }; // created_at OLDER than the tombstone

    // #1 → contact created, id recorded.
    await handleInviteAccepted(db, mgrs, payload, PK, ev1);
    let rows = (await db.execute({ sql: "SELECT * FROM contacts WHERE crow_id = ?", args: [crowId] })).rows;
    assert.equal(rows.length, 1, "first acceptance creates the contact");
    assert.equal(await wasProcessed(db, ev1.id), true, "the handled event.id is recorded");

    // Delete the contact and write a tombstone (what the deletion feature does).
    await db.execute({ sql: "DELETE FROM contacts WHERE crow_id = ?", args: [crowId] });
    await writeTombstone(db, crowId, 100);
    const tomb = await readTombstone(db, crowId);
    assert.ok(tomb, "tombstone written");

    const acksBefore = sendControlCalls.length;

    // Replay event #1 (same event.id) — the R5 retry loop re-publishing the
    // EXACT stored signed event. Must NOT re-create the contact, but MUST ack.
    await handleInviteAccepted(db, mgrs, payload, PK, ev1);
    rows = (await db.execute({ sql: "SELECT * FROM contacts WHERE crow_id = ?", args: [crowId] })).rows;
    assert.equal(rows.length, 0, "a stale replay must NOT resurrect the deleted contact");
    assert.equal(sendControlCalls.length, acksBefore + 1, "the ack still fires on a recorded replay (stops the peer's 60h retry)");

    // Fresh event #2 — a genuinely new acceptance. created_at is OLDER than the
    // tombstone's deleted_at, and it is STILL accepted: pins §D4 against anyone
    // reintroducing a created_at <= deleted_at clock comparison.
    assert.ok(Number(ev2.created_at) < Number(tomb.deleted_at), "event #2 predates the tombstone (skew case)");
    await handleInviteAccepted(db, mgrs, payload, PK, ev2);
    rows = (await db.execute({ sql: "SELECT * FROM contacts WHERE crow_id = ?", args: [crowId] })).rows;
    assert.equal(rows.length, 1, "a fresh acceptance re-adds the contact even with an older created_at");
    assert.equal(await readTombstone(db, crowId), null, "the fresh re-add clears the tombstone (upsertFullContact, Task 7)");
  } finally { cleanup(); }
});

test("recordProcessedEvent prunes rows older than 30 days and keeps newer ones", async () => {
  const { db, cleanup } = freshDb();
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    await db.execute({
      sql: "INSERT INTO processed_control_events (event_id, kind, seen_at) VALUES (?, 'invite_accepted', ?)",
      args: ["ancient", nowSec - 31 * 86400],
    });
    await db.execute({
      sql: "INSERT INTO processed_control_events (event_id, kind, seen_at) VALUES (?, 'invite_accepted', ?)",
      args: ["recent", nowSec - 5 * 86400],
    });
    // A fresh insert triggers the opportunistic prune.
    await recordProcessedEvent(db, "fresh", "invite_accepted");

    assert.equal(await wasProcessed(db, "ancient"), false, "a row older than 30 days is pruned");
    assert.equal(await wasProcessed(db, "recent"), true, "a row within 30 days is kept");
    assert.equal(await wasProcessed(db, "fresh"), true, "the just-recorded row is present");
  } finally { cleanup(); }
});
