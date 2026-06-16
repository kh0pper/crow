// tests/roster-advertise-materialize.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { randomBytes } from "node:crypto";
import { deriveBotIdentity, generateBotInviteCode, parseBotInviteCode } from "../servers/sharing/identity.js";
import { handlePostAction } from "../servers/gateway/dashboard/panels/messages/api-handlers.js";

function fakeRes() {
  return {
    headersSent: false,
    _redir: null,
    redirectAfterPost(url) {
      this.headersSent = true;
      this._redir = url;
      return this;
    },
  };
}

// Generate a real bot identity + invite code once for the test suite.
const TEST_SEED = randomBytes(32);
const TEST_BOT_ID = "test-roster-bot-1";
const botIdentity = deriveBotIdentity(TEST_SEED, TEST_BOT_ID);
const REAL_INVITE_CODE = generateBotInviteCode(botIdentity, "tok-test-123", [], "Test Bot");
const REAL_BOT_CROW_ID = parseBotInviteCode(REAL_INVITE_CODE).botCrowId;

test("first send to an advertised bot accepts the invite, tags origin, and sends", async () => {
  const db = createClient({ url: ":memory:" });
  await db.execute(
    `CREATE TABLE contacts (id INTEGER PRIMARY KEY, crow_id TEXT, secp256k1_pubkey TEXT, origin TEXT)`
  );

  const calls = [];
  const fakeClient = {
    async callTool(args) {
      calls.push(args.name);
      if (args.name === "crow_accept_bot_invite") {
        // Simulate the accept tool creating the contact (idempotent on crow_id).
        await db.execute({
          sql: "INSERT INTO contacts (crow_id, secp256k1_pubkey) VALUES (?, ?)",
          args: [REAL_BOT_CROW_ID, botIdentity.secp256k1Pubkey],
        });
      }
      return { content: [{ type: "text", text: "ok" }] };
    },
    async close() {},
  };

  const req = {
    body: {
      action: "message_advertised_bot",
      invite_code: REAL_INVITE_CODE,
      message: "hello",
    },
  };
  const res = fakeRes();

  const handled = await handlePostAction(req, res, {
    db,
    sharingClientFactory: async () => fakeClient,
  });
  assert.equal(res.headersSent, true, "redirected");
  assert.deepEqual(calls, ["crow_accept_bot_invite", "crow_send_message"], "accept then send");

  const { rows } = await db.execute({
    sql: "SELECT origin FROM contacts WHERE crow_id = ?", args: [REAL_BOT_CROW_ID],
  });
  assert.equal(rows[0]?.origin, "advertised", "newly created contact tagged origin=advertised");
});

test("accept failure → no tag, no send (no half-state)", async () => {
  const db = createClient({ url: ":memory:" });
  await db.execute(
    `CREATE TABLE contacts (id INTEGER PRIMARY KEY, crow_id TEXT, secp256k1_pubkey TEXT, origin TEXT)`
  );
  const calls = [];
  const fakeClient = {
    async callTool(args) {
      calls.push(args.name);
      return {
        isError: true,
        content: [{ type: "text", text: "Failed to accept bot invite: bad code" }],
      };
    },
    async close() {},
  };
  const req = {
    body: {
      action: "message_advertised_bot",
      invite_code: REAL_INVITE_CODE,
      message: "hello",
    },
  };
  const res = fakeRes();

  await handlePostAction(req, res, { db, sharingClientFactory: async () => fakeClient });
  assert.deepEqual(calls, ["crow_accept_bot_invite"], "send NOT attempted after failed accept");
  const { rows } = await db.execute("SELECT COUNT(*) AS n FROM contacts");
  assert.equal(Number(rows[0].n), 0, "no contact materialized on failed accept");
});
