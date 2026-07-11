/**
 * Cluster C D4b + D4c — the catch-all receive paths drop a blocked contact's
 * inbound: message-requests (any request_status) and group_message fan-outs
 * (no notification, no store). An UNKNOWN group sender still notifies.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { handleIncomingRequest, handleGroupMessageNotify } from "../servers/sharing/boot.js";

function freshDb(tag) {
  const dir = mkdtempSync(join(tmpdir(), `block-guards-${tag}-`));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

test("D4b: blocked request contact (pending/accepted/full) → no store, no notification", async () => {
  const { db, cleanup } = freshDb("d4b");
  try {
    const cases = [
      { secp: "a".repeat(64), status: "pending" },
      { secp: "c".repeat(64), status: "accepted" },
      { secp: "d".repeat(64), status: null },
    ];
    let notifications = 0;
    const managers = { createNotification: async () => { notifications++; } };
    for (const c of cases) {
      await db.execute({
        sql: "INSERT INTO contacts (crow_id, secp256k1_pubkey, ed25519_pubkey, request_status, is_blocked) VALUES (?, ?, '', ?, 1)",
        args: [`req:${c.secp}`, c.secp, c.status],
      });
      await handleIncomingRequest(db, managers, { senderPubkey: c.secp, content: "hi", eventId: `e-${c.secp.slice(0, 4)}` });
      const { rows } = await db.execute("SELECT COUNT(*) AS c FROM messages");
      assert.equal(Number(rows[0].c), 0, `blocked ${c.status ?? "full"} contact must not store`);
    }
    assert.equal(notifications, 0, "no notifications for blocked senders");

    // Control: an UNblocked pending request still stores (existing behavior).
    const okSecp = "e".repeat(64);
    await db.execute({
      sql: "INSERT INTO contacts (crow_id, secp256k1_pubkey, ed25519_pubkey, request_status, is_blocked) VALUES (?, ?, '', 'pending', 0)",
      args: [`req:${okSecp}`, okSecp],
    });
    await handleIncomingRequest(db, managers, { senderPubkey: okSecp, content: "hello", eventId: "e-ok" });
    const { rows } = await db.execute("SELECT COUNT(*) AS c FROM messages");
    assert.equal(Number(rows[0].c), 1, "unblocked pending request still stores");
  } finally { cleanup(); }
});

test("D4c: group_message — blocked sender drops silently, unblocked stores+notifies, unknown sender still notifies", async () => {
  const { db, cleanup } = freshDb("d4c");
  try {
    let notifications = 0;
    const managers = { createNotification: async () => { notifications++; } };

    // Blocked contact.
    const blockedIns = await db.execute({
      sql: "INSERT INTO contacts (crow_id, secp256k1_pubkey, ed25519_pubkey, is_blocked) VALUES ('crow:blocked-member', ?, '', 1)",
      args: ["f".repeat(64)],
    });
    await handleGroupMessageNotify(db, {
      group_name: "Test Group",
      sender_name: "Blocked Person",
      message: "hello from blocked",
      sender_crow_id: "crow:blocked-member",
    }, managers);
    assert.equal(notifications, 0, "blocked group sender must not notify");
    let rows = (await db.execute("SELECT COUNT(*) AS c FROM messages WHERE contact_id = ?", [Number(blockedIns.lastInsertRowid)])).rows;
    assert.equal(Number(rows[0].c), 0, "blocked group sender must not store");

    // Unblocked contact — existing behavior preserved.
    const okIns = await db.execute({
      sql: "INSERT INTO contacts (crow_id, secp256k1_pubkey, ed25519_pubkey, is_blocked) VALUES ('crow:ok-member', ?, '', 0)",
      args: ["9".repeat(64)],
    });
    await handleGroupMessageNotify(db, {
      group_name: "Test Group",
      sender_name: "OK Person",
      message: "hello from ok",
      sender_crow_id: "crow:ok-member",
    }, managers);
    assert.equal(notifications, 1, "unblocked group sender notifies");
    rows = (await db.execute("SELECT COUNT(*) AS c FROM messages WHERE contact_id = ?", [Number(okIns.lastInsertRowid)])).rows;
    assert.equal(Number(rows[0].c), 1, "unblocked group sender stores");

    // Unknown sender (no matching contact) — must still notify (pins the
    // reorder against a `!found` mistake), but has nowhere to store.
    await handleGroupMessageNotify(db, {
      group_name: "Test Group",
      sender_name: "Ghost",
      message: "hello from nowhere",
      sender_crow_id: "crow:no-such-contact",
    }, managers);
    assert.equal(notifications, 2, "unknown group sender still notifies");
    const total = (await db.execute("SELECT COUNT(*) AS c FROM messages")).rows;
    assert.equal(Number(total[0].c), 1, "unknown group sender has no row to store into (count unchanged)");
  } finally { cleanup(); }
});
