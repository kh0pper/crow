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

async function mkContact(db, { crowId, name = null, pubkey = "02" + "a".repeat(64) }) {
  const r = await db.execute({
    sql: `INSERT INTO contacts (crow_id, display_name, secp256k1_pubkey, ed25519_pubkey, contact_type)
          VALUES (?,?,?,?, 'crow')`,
    args: [crowId, name, pubkey, "e".repeat(64)],
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

/** A db stub that answers the contact read with `row` and the messages read-back with `sentRows`. */
function dbWithContactRow(row, sentRows = []) {
  return {
    execute: async ({ sql }) => ({ rows: sql.includes("FROM contacts") ? [row] : sentRows }),
  };
}

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

test("retry_of is IGNORED when the tool fails WITHOUT writing a row (no supersession possible)", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const contactId = await mkContact(db, { crowId: "crow:retryignoredfail", name: "R" });
    const seed = await db.execute({
      sql: `INSERT INTO messages (contact_id, content, direction, delivery_status, created_at)
            VALUES (?, 'hi', 'sent', 'failed', datetime('now'))`,
      args: [contactId],
    });
    const failedId = Number(seed.lastInsertRowid);
    // Stub errors WITHOUT inserting a row (blocked contact / pre-write throw):
    // no new failed row means the old one is NOT superseded and must survive —
    // deleting it here would lose the only copy of the content (this is the
    // mutation guard on the wroteThisAttempt condition of the failure-path
    // delete: drop that condition and this test reddens).
    const sharingClientFactory = async () => ({
      callTool: async () => ({ isError: true, content: [{ type: "text", text: "contact is blocked" }] }),
      close: async () => {},
    });
    const res = fakeJsonRes();
    await handlePeerSend(
      { params: { contactId: String(contactId) }, body: { message: "hi", retry_of: String(failedId) } },
      res,
      { db, sharingClientFactory },
    );
    assert.equal(res.body.ok, false);
    assert.equal(res.body.id, null, "no row written this attempt — id must be null");
    const { rows } = await db.execute({ sql: "SELECT id FROM messages WHERE id = ?", args: [failedId] });
    assert.equal(rows.length, 1, "seeded failed row survives — nothing superseded it");
  } finally { cleanup(); }
});

test("supersede-on-failure: a failed retry that wrote a NEW failed row deletes the OLD one and returns the new id", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const contactId = await mkContact(db, { crowId: "crow:retrysupersede", name: "R" });
    const seed = await db.execute({
      sql: `INSERT INTO messages (contact_id, content, direction, delivery_status, created_at)
            VALUES (?, 'hi', 'sent', 'failed', datetime('now'))`,
      args: [contactId],
    });
    const failedId = Number(seed.lastInsertRowid);
    const res = fakeJsonRes();
    // fail:true stub DOES insert a fresh failed row (mimicking sendMessage's
    // 0-relay write) — the new row retains the content, so the superseded old
    // failed row is deleted to prevent orphan accumulation across repeated
    // retries during a relay outage.
    await handlePeerSend(
      { params: { contactId: String(contactId) }, body: { message: "hi", retry_of: String(failedId) } },
      res,
      { db, sharingClientFactory: stubSendFactory(db, contactId, { fail: true }) },
    );
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.ok, false);
    const { rows: oldRows } = await db.execute({ sql: "SELECT id FROM messages WHERE id = ?", args: [failedId] });
    assert.equal(oldRows.length, 0, "old failed row deleted — superseded by this attempt's new failed row");
    const { rows: newRows } = await db.execute({
      sql: `SELECT id FROM messages WHERE contact_id = ? AND direction = 'sent' AND delivery_status = 'failed' ORDER BY id DESC LIMIT 1`,
      args: [contactId],
    });
    assert.equal(newRows.length, 1, "the new failed row from THIS attempt exists");
    assert.equal(res.body.id, Number(newRows[0].id), "502 body.id is the NEW failed row's id");
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

/* ------------------------------------------------- the NORMAL path is unchanged */

const PUBKEY_A = "02" + "a".repeat(64);

/** One contact row as `handlePeerSend` reads it by primary key. */
function contactRow(over = {}) {
  return {
    id: 5,
    crow_id: "crow:x",
    display_name: "Alice",
    secp256k1_pubkey: PUBKEY_A,
    is_blocked: 0,
    request_status: null,
    ...over,
  };
}

/** A factory that records the tool call AND the options it was constructed with. */
function recordingFactory({ calls, guardArgs, text = "Message delivered to Alice via 2 relay(s)." }) {
  return async (options = {}) => {
    guardArgs.push(options);
    return {
      callTool: async (call) => {
        calls.push(call);
        return { content: [{ type: "text", text }] };
      },
      close: async () => {},
    };
  };
}

// The owner's own Messages composer posts to the same route: it names a contact the way a person
// does, and NOTHING about that may have moved (the strict draft path is a different caller).
test("the normal peer send still hands crow_send_message the contact's display name, and no guard", async () => {
  const calls = [];
  const guardArgs = [];
  const res = fakeJsonRes();
  await handlePeerSend(
    { params: { contactId: "5" }, body: { message: "hi" } },
    res,
    { db: dbWithContactRow(contactRow()), sharingClientFactory: recordingFactory({ calls, guardArgs }) },
  );
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(calls, [{ name: "crow_send_message", arguments: { contact: "Alice", message: "hi" } }],
    "the same identifier the route always handed over: display_name || crow_id");
  assert.equal(guardArgs.length, 1, "the factory is called once");
  assert.equal(guardArgs[0].internalSendGuard, undefined,
    "a normal send carries no internal delivery guard — nothing narrowed, nothing refused");
});

test("the normal peer send falls back to the crow id when the contact has no display name", async () => {
  const calls = [];
  const guardArgs = [];
  const res = fakeJsonRes();
  await handlePeerSend(
    { params: { contactId: "5" }, body: { message: "hi" } },
    res,
    {
      db: dbWithContactRow(contactRow({ display_name: null })),
      sharingClientFactory: recordingFactory({ calls, guardArgs }),
    },
  );
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(calls[0].arguments.contact, "crow:x", "crow_id, exactly as before");
});

/* ------------------------------------------------- crow_send_message's ORDER BY */

/** The tool, with a nostrManager that records who each message actually went to. */
function sendTool(db, sent) {
  return captureTools(registerMessagingTools, {
    db,
    identity: {},
    nostrManager: {
      sendMessage: async (row, text) => {
        sent.push({ id: Number(row.id), crowId: row.crow_id, text });
        return { relays: ["wss://x"] };
      },
    },
  }).crow_send_message;
}

test("crow_send_message: a plain display-name lookup with no crow-id clash resolves the one contact it always did", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const aliceId = await mkContact(db, { crowId: "crow:alice", name: "Alice" });
    await mkContact(db, { crowId: "crow:bob", name: "Bob" });
    const sent = [];
    const res = await sendTool(db, sent)({ contact: "Alice", message: "hi" });
    assert.ok(!res.isError, JSON.stringify(res));
    assert.deepEqual(sent, [{ id: aliceId, crowId: "crow:alice", text: "hi" }],
      "no crow id spells 'Alice', so the name branch still answers the one contact it named");
  } finally { cleanup(); }
});

test("crow_send_message: two contacts sharing a display name still resolve to the lower row id, twice in a row", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const firstId = await mkContact(db, { crowId: "crow:sam-1", name: "Sam" });
    await mkContact(db, { crowId: "crow:sam-2", name: "Sam" });
    const sent = [];
    const tool = sendTool(db, sent);
    await tool({ contact: "Sam", message: "one" });
    await tool({ contact: "Sam", message: "two" });
    assert.deepEqual(sent.map((s) => s.id), [firstId, firstId],
      "the new ORDER BY only settles the crow-id-vs-name question; the id tie-break is the old rowid order");
  } finally { cleanup(); }
});

/* ------------------------------------------------- the internal delivery guard */

// The guard is how the tool refuses when ITS OWN lookup resolves a row other than the one the strict
// caller verified — the window between that caller's read and this SELECT. It is carried on the
// server's construction options (ctx), never as a tool argument: an MCP client cannot set it.
test("crow_send_message's input schema is exactly {contact, message} — the guard is not an argument", () => {
  let shape = null;
  registerMessagingTools(
    { tool: (name, _desc, schema) => { if (name === "crow_send_message") shape = schema; } },
    { db: {}, identity: {}, nostrManager: {} },
  );
  assert.ok(shape, "the tool registered");
  assert.deepEqual(Object.keys(shape).sort(), ["contact", "message"],
    "no client can name, broaden or forge the row a send was sealed for");
});

test("the guard passes when the row its lookup resolved is the sealed row: the message goes out", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const id = await mkContact(db, { crowId: "crow:peer", name: "Peer" });
    const sent = [];
    const guard = { sealed: { contactId: id, crowId: "crow:peer", pubkey: PUBKEY_A }, refusal: null };
    const tools = captureTools(registerMessagingTools, {
      db,
      identity: {},
      internalSendGuard: guard,
      nostrManager: { sendMessage: async (row, text) => { sent.push({ id: Number(row.id), text }); return { relays: ["wss://x"] }; } },
    });
    const res = await tools.crow_send_message({ contact: "crow:peer", message: "hi" });
    assert.ok(!res.isError, JSON.stringify(res));
    assert.deepEqual(sent, [{ id, text: "hi" }]);
    assert.equal(guard.refusal, null, "no refusal was recorded");
  } finally { cleanup(); }
});

// SECURITY (delivery integrity, the last window): the sealed row's crow id moved between the caller's
// check and this lookup, so the identifier the caller named now matches nothing — while another
// contact's DISPLAY NAME spells it. The exact-crow-id ORDER BY cannot help (there is no such crow id
// any more); the guard is what refuses.
test("the guard refuses when the lookup resolves a different row, and nothing is published", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const fakeId = await mkContact(db, { crowId: "crow:impostor", name: "nothing yet", pubkey: "02" + "c".repeat(64) });
    const realId = await mkContact(db, { crowId: "crow:peer", name: "Peer" });
    const sent = [];
    const guard = { sealed: { contactId: realId, crowId: "crow:peer", pubkey: PUBKEY_A }, refusal: null };
    const tools = captureTools(registerMessagingTools, {
      db,
      identity: {},
      internalSendGuard: guard,
      nostrManager: { sendMessage: async (row) => { sent.push(Number(row.id)); return { relays: ["wss://x"] }; } },
    });

    // The race: the real row's crow id is replaced, the impostor's display name picks it up.
    await db.execute({ sql: "UPDATE contacts SET crow_id = 'crow:moved' WHERE id = ?", args: [realId] });
    await db.execute({ sql: "UPDATE contacts SET display_name = 'crow:peer' WHERE id = ?", args: [fakeId] });

    const res = await tools.crow_send_message({ contact: "crow:peer", message: "for Peer only" });
    assert.equal(res.isError, true, "the tool refuses rather than delivering to whoever answers the name");
    assert.equal(guard.refusal, "recipients_changed", "the caller gets a refusal code, not a delivery failure");
    assert.deepEqual(sent, [], "nothing left the box");
  } finally { cleanup(); }
});

test("the guard refuses a row whose key changed (pubkey_changed) and one that no longer resolves", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const id = await mkContact(db, { crowId: "crow:peer", name: "Peer" });
    const sent = [];
    const nostrManager = { sendMessage: async (row) => { sent.push(Number(row.id)); return { relays: ["wss://x"] }; } };

    const rekeyed = { sealed: { contactId: id, crowId: "crow:peer", pubkey: PUBKEY_A }, refusal: null };
    const tools = captureTools(registerMessagingTools, { db, identity: {}, internalSendGuard: rekeyed, nostrManager });
    await db.execute({ sql: "UPDATE contacts SET secp256k1_pubkey = ? WHERE id = ?", args: ["02" + "9".repeat(64), id] });
    const res = await tools.crow_send_message({ contact: "crow:peer", message: "hi" });
    assert.equal(res.isError, true);
    assert.equal(rekeyed.refusal, "pubkey_changed", "the same person holding another key is another person to send to");

    // Blocked: the tool's own SELECT filters the row out, so the guard sees no row at all.
    const blocked = { sealed: { contactId: id, crowId: "crow:peer", pubkey: "02" + "9".repeat(64) }, refusal: null };
    const tools2 = captureTools(registerMessagingTools, { db, identity: {}, internalSendGuard: blocked, nostrManager });
    await db.execute({ sql: "UPDATE contacts SET is_blocked = 1 WHERE id = ?", args: [id] });
    const blockedRes = await tools2.crow_send_message({ contact: "crow:peer", message: "hi" });
    assert.equal(blockedRes.isError, true);
    assert.equal(blocked.refusal, "recipients_changed", "a row that no longer resolves is not the sealed audience");

    assert.deepEqual(sent, [], "neither refusal published anything");
  } finally { cleanup(); }
});

/* ------------------------------------------------- the strict send carries the guard */

test("a strict send passes its sealed row to the tool as the internal guard (never as an argument)", async () => {
  const calls = [];
  const guardArgs = [];
  const res = fakeJsonRes();
  await handlePeerSend(
    { params: { contactId: "5" }, body: { message: "hi" } },
    res,
    {
      db: dbWithContactRow(contactRow()),
      sharingClientFactory: recordingFactory({ calls, guardArgs }),
      strictRecipient: { contactId: 5, crowId: "crow:x", pubkey: PUBKEY_A, name: "Alice", blocked: false },
    },
  );
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(guardArgs[0].internalSendGuard?.sealed, { contactId: 5, crowId: "crow:x", pubkey: PUBKEY_A },
    "the row id, the crow id and the key the draft sealed");
  assert.equal(guardArgs[0].internalSendGuard.refusal, null, "the refusal slot starts empty");
  assert.deepEqual(calls[0].arguments, { contact: "crow:x", message: "hi" },
    "the argument is still just the identifier and the text");
  assert.equal(Object.keys(calls[0].arguments).length, 2, "the guard is not settable through the call");
});

test("a refusal recorded by the tool's guard answers 409 with its own code, not a 502", async () => {
  for (const reason of ["recipients_changed", "pubkey_changed", "blocked"]) {
    const res = fakeJsonRes();
    const sharingClientFactory = async (options = {}) => ({
      callTool: async () => {
        options.internalSendGuard.refusal = reason;
        return { isError: true, content: [{ type: "text", text: "Message NOT sent." }] };
      },
      close: async () => {},
    });
    await handlePeerSend(
      { params: { contactId: "5" }, body: { message: "hi" } },
      res,
      {
        db: dbWithContactRow(contactRow()),
        sharingClientFactory,
        strictRecipient: { contactId: 5, crowId: "crow:x", pubkey: PUBKEY_A },
      },
    );
    assert.equal(res.statusCode, 409, `${reason}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, reason, "the reason the tool found, verbatim");
    assert.equal(res.body.ok, false);
  }
});
