/**
 * message-send-feedback — R2 Task 3. A 0-relay send is a FAILURE surfaced on
 * the LIVE path (not a silent success).
 *
 * (a) TOOL level: crow_send_message returns isError:true when sendMessage
 *     reaches 0 relays ({relays:[]}); success (no isError) with an accurate
 *     "N relay(s)" text when >=1.
 * (b) ROUTE level: peer-messages.js handlePeerSend captures the tool result and
 *     returns a NON-OK (502 / {ok:false}) response when the tool reports
 *     isError; {ok:true} when the send succeeded. This guards C1 (the live send
 *     path used to discard the tool result and always return {ok:true}).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerMessagingTools } from "../servers/sharing/tools/messaging.js";
import { handlePeerSend } from "../servers/gateway/routes/peer-messages.js";

function freshLibsql() {
  const dir = mkdtempSync(join(tmpdir(), "msg-send-feedback-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { dir, db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

// Capture registered MCP tool handlers by name from a register* function.
function captureTools(registerFn, ctx) {
  const tools = {};
  const server = { tool: (name, _desc, _schema, handler) => { tools[name] = handler; } };
  registerFn(server, ctx);
  return tools;
}

async function mkContact(db, { crowId, name = null }) {
  const r = await db.execute({
    sql: `INSERT INTO contacts (crow_id, display_name, secp256k1_pubkey, ed25519_pubkey, contact_type)
          VALUES (?,?,?,?, 'crow')`,
    args: [crowId, name, "02" + "a".repeat(64), "e".repeat(64)],
  });
  return Number(r.lastInsertRowid);
}

// --- (a) TOOL: 0 relays => isError; >=1 => success ---

test("crow_send_message returns isError when the send reaches 0 relays", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    await mkContact(db, { crowId: "crow:zero", name: "Zero" });
    const nostrManager = { sendMessage: async () => ({ relays: [] }) };
    const tools = captureTools(registerMessagingTools, { db, identity: {}, nostrManager });

    const res = await tools.crow_send_message({ contact: "Zero", message: "hi" });
    assert.equal(res.isError, true, "0-relay send is an error");
    const text = res.content.map((c) => c.text).join(" ");
    assert.match(text, /0 relays/i, "message names the 0-relay failure");
  } finally { cleanup(); }
});

test("crow_send_message succeeds (no isError, accurate relay count) when >=1 relay accepts", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    await mkContact(db, { crowId: "crow:one", name: "One" });
    const nostrManager = { sendMessage: async () => ({ relays: ["wss://x"] }) };
    const tools = captureTools(registerMessagingTools, { db, identity: {}, nostrManager });

    const res = await tools.crow_send_message({ contact: "One", message: "hi" });
    assert.ok(!res.isError, "a >=1-relay send is not an error");
    const text = res.content.map((c) => c.text).join(" ");
    assert.match(text, /1 relay/i, "success text reports the relay count");
  } finally { cleanup(); }
});

// --- (b) ROUTE: handlePeerSend surfaces the tool result on the LIVE path ---

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    headersSent: false,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; this.headersSent = true; return this; },
  };
}

// A db stub whose contact lookup returns one row (so handlePeerSend proceeds).
const dbWithContact = { execute: async () => ({ rows: [{ crow_id: "crow:x", display_name: "Alice" }] }) };

function stubFactory(toolResult) {
  return async () => ({
    callTool: async () => toolResult,
    close: async () => {},
  });
}

test("handlePeerSend returns non-ok (502 / ok:false) when the tool reports isError (0 relays)", async () => {
  const req = { params: { contactId: "5" }, body: { message: "hi" } };
  const res = mockRes();
  const sharingClientFactory = stubFactory({
    isError: true,
    content: [{ type: "text", text: "Message could NOT be delivered — reached 0 relays." }],
  });
  await handlePeerSend(req, res, { db: dbWithContact, sharingClientFactory });
  assert.equal(res.statusCode, 502, "0-relay send yields HTTP 502");
  assert.equal(res.body.ok, false, "body reports ok:false");
  assert.match(res.body.error || "", /0 relays/i, "error carries the tool's failure text");
});

test("handlePeerSend returns {ok:true} when the tool succeeds (>=1 relay, no regression)", async () => {
  const req = { params: { contactId: "5" }, body: { message: "hi" } };
  const res = mockRes();
  const sharingClientFactory = stubFactory({
    content: [{ type: "text", text: "Message delivered to Alice via 2 relay(s)." }],
  });
  await handlePeerSend(req, res, { db: dbWithContact, sharingClientFactory });
  assert.equal(res.statusCode, 200, "successful send stays 200");
  assert.equal(res.body.ok, true, "successful send returns ok:true");
});

// --- (c) ROUTE: handlePeerSend returns row ids + guarded retry_of delete (F-UI-5/7) ---

function fakeJsonRes() {
  return {
    statusCode: 200, body: null, headersSent: false,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; this.headersSent = true; return this; },
  };
}

// Stub factory that mimics sendMessage's row write, then answers ok/isError.
function stubSendFactory(db, contactId, { fail = false } = {}) {
  return async () => ({
    callTool: async () => {
      await db.execute({
        sql: `INSERT INTO messages (contact_id, content, direction, delivery_status, nostr_event_id, created_at)
              VALUES (?, ?, 'sent', ?, ?, datetime('now'))`,
        args: [contactId, "hi", fail ? "failed" : "relayed", fail ? null : "evt-abc"],
      });
      return fail
        ? { isError: true, content: [{ type: "text", text: "reached 0 relays" }] }
        : { content: [{ type: "text", text: "Message sent to 3 relay(s)" }] };
    },
    close: async () => {},
  });
}

test("send success returns the new row id + delivery_status (F-UI-5)", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const contactId = await mkContact(db, { crowId: "crow:idreturn", name: "R" });
    const res = fakeJsonRes();
    await handlePeerSend(
      { params: { contactId: String(contactId) }, body: { message: "hi" } },
      res,
      { db, sharingClientFactory: stubSendFactory(db, contactId) },
    );
    assert.equal(res.body.ok, true);
    assert.ok(Number.isInteger(res.body.id));
    assert.equal(res.body.delivery_status, "relayed");
    assert.equal(res.body.nostr_event_id, "evt-abc");
  } finally { cleanup(); }
});

test("send failure (0 relays) returns the failed row id so the client can retry it (F-UI-7)", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const contactId = await mkContact(db, { crowId: "crow:failreturn", name: "R" });
    const res = fakeJsonRes();
    await handlePeerSend(
      { params: { contactId: String(contactId) }, body: { message: "hi" } },
      res,
      { db, sharingClientFactory: stubSendFactory(db, contactId, { fail: true }) },
    );
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.ok, false);
    const { rows } = await db.execute({
      sql: `SELECT id FROM messages WHERE contact_id = ? AND direction = 'sent' ORDER BY id DESC LIMIT 1`,
      args: [contactId],
    });
    assert.equal(res.body.id, Number(rows[0].id));
  } finally { cleanup(); }
});

test("502 does NOT attribute a pre-existing failed row's id to an attempt that wrote no row", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const contactId = await mkContact(db, { crowId: "crow:stale502", name: "R" });
    // Seed an OLD failed row from a previous attempt.
    await db.execute({
      sql: `INSERT INTO messages (contact_id, content, direction, delivery_status, created_at)
            VALUES (?, 'old attempt', 'sent', 'failed', datetime('now'))`,
      args: [contactId],
    });
    // Stub errors WITHOUT inserting a row (e.g. blocked contact filtered by the
    // tool's own lookup, or a nip44 encrypt throw before sendMessage writes).
    const sharingClientFactory = async () => ({
      callTool: async () => ({ isError: true, content: [{ type: "text", text: "contact is blocked" }] }),
      close: async () => {},
    });
    const res = fakeJsonRes();
    await handlePeerSend(
      { params: { contactId: String(contactId) }, body: { message: "hi" } },
      res,
      { db, sharingClientFactory },
    );
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.id, null, "stale pre-existing row id must not be attributed to this attempt");
  } finally { cleanup(); }
});

test("retry_of deletes the old failed row on success — guarded (F-UI-7)", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const contactId = await mkContact(db, { crowId: "crow:retryok", name: "R" });
    // Seed the OLD failed row this retry replaces.
    const seed = await db.execute({
      sql: `INSERT INTO messages (contact_id, content, direction, delivery_status, created_at)
            VALUES (?, 'hi', 'sent', 'failed', datetime('now'))`,
      args: [contactId],
    });
    const failedId = Number(seed.lastInsertRowid);
    const res = fakeJsonRes();
    await handlePeerSend(
      { params: { contactId: String(contactId) }, body: { message: "hi", retry_of: String(failedId) } },
      res,
      { db, sharingClientFactory: stubSendFactory(db, contactId) },
    );
    assert.equal(res.body.ok, true);
    const { rows } = await db.execute({ sql: "SELECT id FROM messages WHERE id = ?", args: [failedId] });
    assert.equal(rows.length, 0, "old failed row deleted");
  } finally { cleanup(); }
});

test("retry_of does NOT delete a row belonging to another contact", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const contactA = await mkContact(db, { crowId: "crow:retryA", name: "A" });
    const contactB = await mkContact(db, { crowId: "crow:retryB", name: "B" });
    const seed = await db.execute({
      sql: `INSERT INTO messages (contact_id, content, direction, delivery_status, created_at)
            VALUES (?, 'hi', 'sent', 'failed', datetime('now'))`,
      args: [contactB],
    });
    const failedId = Number(seed.lastInsertRowid);
    const res = fakeJsonRes();
    await handlePeerSend(
      { params: { contactId: String(contactA) }, body: { message: "hi", retry_of: String(failedId) } },
      res,
      { db, sharingClientFactory: stubSendFactory(db, contactA) },
    );
    assert.equal(res.body.ok, true);
    const { rows } = await db.execute({ sql: "SELECT id FROM messages WHERE id = ?", args: [failedId] });
    assert.equal(rows.length, 1, "other contact's row survives");
  } finally { cleanup(); }
});

test("retry_of does NOT delete a non-failed row", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const contactId = await mkContact(db, { crowId: "crow:retrynonfailed", name: "R" });
    const seed = await db.execute({
      sql: `INSERT INTO messages (contact_id, content, direction, delivery_status, created_at)
            VALUES (?, 'hi', 'sent', 'relayed', datetime('now'))`,
      args: [contactId],
    });
    const rowId = Number(seed.lastInsertRowid);
    const res = fakeJsonRes();
    await handlePeerSend(
      { params: { contactId: String(contactId) }, body: { message: "hi", retry_of: String(rowId) } },
      res,
      { db, sharingClientFactory: stubSendFactory(db, contactId) },
    );
    assert.equal(res.body.ok, true);
    const { rows } = await db.execute({ sql: "SELECT id FROM messages WHERE id = ?", args: [rowId] });
    assert.equal(rows.length, 1, "non-failed row survives");
  } finally { cleanup(); }
});

test("retry_of does NOT delete a received row", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const contactId = await mkContact(db, { crowId: "crow:retryreceived", name: "R" });
    const seed = await db.execute({
      sql: `INSERT INTO messages (contact_id, content, direction, delivery_status, created_at)
            VALUES (?, 'hi', 'received', 'failed', datetime('now'))`,
      args: [contactId],
    });
    const rowId = Number(seed.lastInsertRowid);
    const res = fakeJsonRes();
    await handlePeerSend(
      { params: { contactId: String(contactId) }, body: { message: "hi", retry_of: String(rowId) } },
      res,
      { db, sharingClientFactory: stubSendFactory(db, contactId) },
    );
    assert.equal(res.body.ok, true);
    const { rows } = await db.execute({ sql: "SELECT id FROM messages WHERE id = ?", args: [rowId] });
    assert.equal(rows.length, 1, "received row survives");
  } finally { cleanup(); }
});

test("retry_of is IGNORED when the send itself fails", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const contactId = await mkContact(db, { crowId: "crow:retryignoredfail", name: "R" });
    const seed = await db.execute({
      sql: `INSERT INTO messages (contact_id, content, direction, delivery_status, created_at)
            VALUES (?, 'hi', 'sent', 'failed', datetime('now'))`,
      args: [contactId],
    });
    const failedId = Number(seed.lastInsertRowid);
    const res = fakeJsonRes();
    await handlePeerSend(
      { params: { contactId: String(contactId) }, body: { message: "hi", retry_of: String(failedId) } },
      res,
      { db, sharingClientFactory: stubSendFactory(db, contactId, { fail: true }) },
    );
    assert.equal(res.body.ok, false);
    const { rows } = await db.execute({ sql: "SELECT id FROM messages WHERE id = ?", args: [failedId] });
    assert.equal(rows.length, 1, "seeded failed row survives — retry_of ignored on a failed send");
  } finally { cleanup(); }
});

test("non-digit retry_of is ignored", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const contactId = await mkContact(db, { crowId: "crow:retrynondigit", name: "R" });
    const seed = await db.execute({
      sql: `INSERT INTO messages (contact_id, content, direction, delivery_status, created_at)
            VALUES (?, 'hi', 'sent', 'failed', datetime('now'))`,
      args: [contactId],
    });
    const failedId = Number(seed.lastInsertRowid);
    const res = fakeJsonRes();
    await handlePeerSend(
      { params: { contactId: String(contactId) }, body: { message: "hi", retry_of: `${failedId}x` } },
      res,
      { db, sharingClientFactory: stubSendFactory(db, contactId) },
    );
    assert.equal(res.body.ok, true);
    const { rows } = await db.execute({ sql: "SELECT id FROM messages WHERE id = ?", args: [failedId] });
    assert.equal(rows.length, 1, "strict digit gate rejects '55x'; row survives");
  } finally { cleanup(); }
});
