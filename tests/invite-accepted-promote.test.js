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
const payload = { type: "invite_accepted", crowId: "crow:realpeer9", ed25519Pub: "d".repeat(64), secp256k1Pub: PK };

test("promotes an accepted request in place (no duplicate)", async () => {
  const { db, cleanup } = freshDb();
  try {
    await db.execute({
      sql: `INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, contact_type, request_status)
            VALUES (?, '', ?, 'crow', 'accepted')`,
      args: ["req:" + PK_XONLY, PK],
    });
    await handleInviteAccepted(db, stubMgrs(), payload);
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
    await handleInviteAccepted(db, stubMgrs(), payload);
    const { rows } = await db.execute({ sql: "SELECT * FROM contacts WHERE crow_id = ?", args: ["crow:realpeer9"] });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].request_status, null);
  } finally { cleanup(); }
});

test("ignores an incomplete payload and never throws", async () => {
  const { db, cleanup } = freshDb();
  try {
    await handleInviteAccepted(db, stubMgrs(), { type: "invite_accepted", crowId: "crow:x" }); // no keys
    const { rows } = await db.execute({ sql: "SELECT COUNT(*) c FROM contacts", args: [] });
    assert.equal(Number(rows[0].c), 0);
  } finally { cleanup(); }
});
