/**
 * Phase 3 PR-A — Task 4b: dashboard panels emit contact mutations (push side).
 * Drives handleContactAction / handlePostAction against a real init-db DB with
 * the contact-sync emit sink spied. Asserts each mutating action emits the right
 * op, and that verified/decline/pending do NOT emit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleContactAction } from "../servers/gateway/dashboard/panels/contacts/api-handlers.js";
import { handlePostAction } from "../servers/gateway/dashboard/panels/messages/api-handlers.js";
import { __setEmitSinkForTest } from "../servers/sharing/contact-sync.js";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "p3panel-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: join(import.meta.dirname, "..") });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}
function spy() {
  const seen = [];
  __setEmitSinkForTest({ emitChange: async (t, op, row) => seen.push({ op, crow_id: row.crow_id, is_blocked: row.is_blocked, request_status: row.request_status }) });
  return seen;
}
const res = { redirectAfterPost: (u) => ({ redirect: u }) };
async function seedContact(db, { crow_id, contact_type = "crow", secp = "a".repeat(64), request_status = null }) {
  await db.execute({ sql: "INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, contact_type, request_status) VALUES (?, 'N', '', ?, ?, ?)", args: [crow_id, secp, contact_type, request_status] });
  return Number((await db.execute({ sql: "SELECT id FROM contacts WHERE crow_id = ?", args: [crow_id] })).rows[0].id);
}

test("contacts panel: block emits update with is_blocked=1", async () => {
  const { db, cleanup } = freshDb();
  try {
    const id = await seedContact(db, { crow_id: "crow:blk" });
    const seen = spy();
    await handleContactAction({ body: { action: "block", contact_id: String(id) } }, db);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].op, "update");
    assert.equal(seen[0].crow_id, "crow:blk");
    assert.equal(Number(seen[0].is_blocked), 1);
  } finally { __setEmitSinkForTest(null); cleanup(); }
});

test("contacts panel: unblock emits update with is_blocked=0", async () => {
  const { db, cleanup } = freshDb();
  try {
    const id = await seedContact(db, { crow_id: "crow:unblk" });
    await db.execute({ sql: "UPDATE contacts SET is_blocked = 1 WHERE id = ?", args: [id] });
    const seen = spy();
    await handleContactAction({ body: { action: "unblock", contact_id: String(id) } }, db);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].op, "update");
    assert.equal(Number(seen[0].is_blocked), 0);
  } finally { __setEmitSinkForTest(null); cleanup(); }
});

test("contacts panel: add_manual emits insert; set_verified emits nothing", async () => {
  const { db, cleanup } = freshDb();
  try {
    const seen = spy();
    await handleContactAction({ body: { action: "add_manual", name: "Bob", email: "b@x.io" } }, db);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].op, "insert");
    assert.ok(seen[0].crow_id.startsWith("manual:"));
    // set_verified: no emit
    const id = await seedContact(db, { crow_id: "crow:ver" });
    seen.length = 0;
    await handleContactAction({ body: { action: "set_verified", contact_id: String(id), verified: "1" } }, db);
    assert.equal(seen.length, 0, "verified is per-device — never synced");
  } finally { __setEmitSinkForTest(null); cleanup(); }
});

test("contacts panel: edit emits update", async () => {
  const { db, cleanup } = freshDb();
  try {
    const id = await seedContact(db, { crow_id: "crow:edit" });
    const seen = spy();
    await handleContactAction({ body: { action: "edit_contact", contact_id: String(id), notes: "hello" } }, db);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].op, "update");
  } finally { __setEmitSinkForTest(null); cleanup(); }
});

test("contacts panel: delete emits delete for a manual row, nothing for a crow: row", async () => {
  const { db, cleanup } = freshDb();
  try {
    const manualId = await seedContact(db, { crow_id: "manual:d1", contact_type: "manual", secp: "" });
    const crowId = await seedContact(db, { crow_id: "crow:d2", contact_type: "crow" });
    const seen = spy();
    await handleContactAction({ body: { action: "delete_contact", contact_id: String(manualId) } }, db);
    await handleContactAction({ body: { action: "delete_contact", contact_id: String(crowId) } }, db); // no-op (not manual)
    assert.equal(seen.length, 1, "only the manual delete emitted");
    assert.equal(seen[0].op, "delete");
    assert.equal(seen[0].crow_id, "manual:d1");
  } finally { __setEmitSinkForTest(null); cleanup(); }
});

test("messages panel: block/unblock emit update", async () => {
  const { db, cleanup } = freshDb();
  try {
    await seedContact(db, { crow_id: "crow:mblk" });
    const seen = spy();
    await handlePostAction({ body: { action: "block", crow_id: "crow:mblk" } }, res, { db });
    await handlePostAction({ body: { action: "unblock", crow_id: "crow:mblk" } }, res, { db });
    assert.equal(seen.length, 2);
    assert.equal(seen[0].op, "update"); assert.equal(Number(seen[0].is_blocked), 1);
    assert.equal(seen[1].op, "update"); assert.equal(Number(seen[1].is_blocked), 0);
  } finally { __setEmitSinkForTest(null); cleanup(); }
});

test("messages panel: accept_request emits update; decline emits nothing", async () => {
  const { db, cleanup } = freshDb();
  try {
    const accId = await seedContact(db, { crow_id: "req:acc", request_status: "pending" });
    const decId = await seedContact(db, { crow_id: "req:dec", request_status: "pending" });
    const seen = spy();
    await handlePostAction({ body: { action: "accept_request", request_id: String(accId) } }, res, { db });
    await handlePostAction({ body: { action: "decline_request", request_id: String(decId) } }, res, { db });
    assert.equal(seen.length, 1, "only accept emitted");
    assert.equal(seen[0].op, "update");
    assert.equal(seen[0].request_status, "accepted");
  } finally { __setEmitSinkForTest(null); cleanup(); }
});
