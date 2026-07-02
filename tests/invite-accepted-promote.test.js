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
