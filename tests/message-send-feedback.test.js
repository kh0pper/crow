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
  assert.deepEqual(res.body, { ok: true }, "successful send returns ok:true");
});
