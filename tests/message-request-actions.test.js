/**
 * message-request-actions — L6 Task 4. Exercises the Messages "Requests (N)"
 * inbox actions and its data query:
 *   - getMessageRequests(db) returns ONLY 'pending' rows with the preview shape
 *     (latest content, count, created_at, crow_id + short display), newest-first.
 *   - accept_request flips request_status 'pending'→'accepted', marks the
 *     request's messages read, and calls nostrManager.subscribeToContact.
 *   - decline_request deletes the request contact (messages gone via CASCADE).
 *   - an unknown / already-handled request_id is a safe no-op redirect.
 *
 * Deps are injected: nostrManager is a stub whose subscribeToContact just
 * records its argument, so the test never touches live relays.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handlePostAction } from "../servers/gateway/dashboard/panels/messages/api-handlers.js";
import { getMessageRequests } from "../servers/gateway/dashboard/panels/messages/data-queries.js";

function freshLibsql() {
  const dir = mkdtempSync(join(tmpdir(), "msgreqact-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir },
    stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { dir, db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

function fakeRes() {
  return { _r: null, headersSent: false, redirectAfterPost(p) { this._r = p; this.headersSent = true; return true; } };
}

// Insert a 'pending' request contact + N received messages; returns contact id.
async function seedRequest(db, pk, contents, createdAt) {
  const ins = await db.execute({
    sql: `INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, contact_type, request_status, created_at)
          VALUES (?,?,?,?,'pending', ?)`,
    args: ["req:" + pk, "", pk, "crow", createdAt || "2026-07-02 10:00:00"],
  });
  const id = Number(ins.lastInsertRowid);
  let i = 0;
  for (const content of contents) {
    await db.execute({
      sql: `INSERT INTO messages (contact_id, nostr_event_id, content, direction, is_read, created_at)
            VALUES (?,?,?,'received',0,?)`,
      args: [id, `evt-${pk.slice(0, 6)}-${i}`, content, createdAt || "2026-07-02 10:00:00"],
    });
    i++;
  }
  return id;
}

test("getMessageRequests returns only pending rows, newest-first, with preview shape", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    // A full (NULL) contact must NOT appear.
    await db.execute({
      sql: `INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, contact_type, request_status)
            VALUES ('crow:full','ed','02${"f".repeat(64)}','crow',NULL)`,
    });
    // An accepted request must NOT appear (only 'pending' are requests).
    await db.execute({
      sql: `INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, contact_type, request_status)
            VALUES ('req:${"c".repeat(64)}','','${"c".repeat(64)}','crow','accepted')`,
    });
    // Two pending requests at different times → newest-first.
    const older = await seedRequest(db, "a".repeat(64), ["first ping"], "2026-07-02 09:00:00");
    const newer = await seedRequest(db, "b".repeat(64), ["hello", "you there?"], "2026-07-02 11:00:00");

    const reqs = await getMessageRequests(db);
    assert.equal(reqs.length, 2, "only the two pending requests");
    assert.equal(reqs[0].id, newer, "newest-first");
    assert.equal(reqs[1].id, older);

    const b = reqs[0];
    assert.equal(b.crowId, "req:" + "b".repeat(64));
    assert.equal(b.msgCount, 2, "message count");
    assert.equal(b.preview, "you there?", "latest message content as preview");
    assert.ok(b.shortId && b.shortId.length < b.crowId.length, "a short display shorter than the full crow_id");
    assert.ok(b.createdAt, "created_at present");
  } finally { cleanup(); }
});

test("accept_request → status 'accepted', messages marked read, subscribeToContact called", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const pk = "a".repeat(64);
    const id = await seedRequest(db, pk, ["hey", "still here"]);
    const subCalls = [];
    const managers = { nostrManager: { subscribeToContact: async (c) => { subCalls.push(c); } } };

    const req = { body: { action: "accept_request", request_id: String(id) } };
    const res = fakeRes();
    const handled = await handlePostAction(req, res, { db, _managers: managers });

    assert.equal(handled, true);
    assert.equal(res._r, "/dashboard/messages");

    const { rows } = await db.execute({ sql: "SELECT request_status FROM contacts WHERE id = ?", args: [id] });
    assert.equal(rows[0].request_status, "accepted", "flipped to accepted (NOT NULL)");

    const { rows: unread } = await db.execute({ sql: "SELECT COUNT(*) AS c FROM messages WHERE contact_id = ? AND is_read = 0", args: [id] });
    assert.equal(Number(unread[0].c), 0, "all request messages marked read");

    assert.equal(subCalls.length, 1, "subscribeToContact called once");
    assert.equal(subCalls[0].id, id);
    assert.equal(subCalls[0].crow_id, "req:" + pk);
    assert.equal(subCalls[0].secp256k1_pubkey, pk);
  } finally { cleanup(); }
});

test("decline_request → contact deleted, messages gone via CASCADE", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const id = await seedRequest(db, "d".repeat(64), ["spam?", "buy now"]);
    const req = { body: { action: "decline_request", request_id: String(id) } };
    const res = fakeRes();
    const handled = await handlePostAction(req, res, { db, _managers: null });

    assert.equal(handled, true);
    assert.equal(res._r, "/dashboard/messages");

    const { rows: c } = await db.execute({ sql: "SELECT id FROM contacts WHERE id = ?", args: [id] });
    assert.equal(c.length, 0, "request contact deleted");
    const { rows: m } = await db.execute({ sql: "SELECT id FROM messages WHERE contact_id = ?", args: [id] });
    assert.equal(m.length, 0, "its messages dropped via CASCADE");
  } finally { cleanup(); }
});

test("unknown / already-handled request_id → safe no-op redirect", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    // No such contact.
    const req1 = { body: { action: "accept_request", request_id: "99999" } };
    const res1 = fakeRes();
    assert.equal(await handlePostAction(req1, res1, { db, _managers: { nostrManager: { subscribeToContact: async () => { throw new Error("should not be called"); } } } }), true);
    assert.equal(res1._r, "/dashboard/messages");

    const req2 = { body: { action: "decline_request", request_id: "88888" } };
    const res2 = fakeRes();
    assert.equal(await handlePostAction(req2, res2, { db, _managers: null }), true);
    assert.equal(res2._r, "/dashboard/messages");

    // Accepting a NULL (full) contact by id must not flip it.
    const ins = await db.execute({
      sql: `INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, contact_type, request_status)
            VALUES ('crow:full','ed','02${"e".repeat(64)}','crow',NULL)`,
    });
    const fullId = Number(ins.lastInsertRowid);
    const req3 = { body: { action: "accept_request", request_id: String(fullId) } };
    const res3 = fakeRes();
    await handlePostAction(req3, res3, { db, _managers: { nostrManager: { subscribeToContact: async () => { throw new Error("should not subscribe a full contact"); } } } });
    const { rows } = await db.execute({ sql: "SELECT request_status FROM contacts WHERE id = ?", args: [fullId] });
    assert.equal(rows[0].request_status, null, "full contact untouched by accept_request");
  } finally { cleanup(); }
});
