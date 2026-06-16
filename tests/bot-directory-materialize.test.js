// tests/bot-directory-materialize.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { randomBytes } from "node:crypto";
import { deriveBotIdentity, generateBotInviteCode, parseBotInviteCode } from "../servers/sharing/identity.js";
import { handlePostAction } from "../servers/gateway/dashboard/panels/messages/api-handlers.js";

const SEED = randomBytes(32);
const BOT_ID = "dir-bot-1";
const ident = deriveBotIdentity(SEED, BOT_ID);
const CODE = generateBotInviteCode(ident, "tok-1", [], "Dir Bot");
const CROW_ID = parseBotInviteCode(CODE).botCrowId;

function fakeRes() { return { headersSent: false, _redir: null, redirectAfterPost(u){ this.headersSent = true; this._redir = u; return this; } }; }
async function db0() {
  const db = createClient({ url: ":memory:" });
  await db.execute(`CREATE TABLE contacts (id INTEGER PRIMARY KEY, crow_id TEXT, secp256k1_pubkey TEXT, origin TEXT, is_bot INTEGER DEFAULT 0)`);
  return db;
}
function fakeClientThatAccepts(db, calls) {
  return { async callTool(a){ calls.push(a.name); if (a.name==="crow_accept_bot_invite") { await db.execute({ sql:"INSERT INTO contacts (crow_id, secp256k1_pubkey) VALUES (?,?)", args:[CROW_ID, ident.secp256k1Pubkey] }); } return { content:[{type:"text",text:"ok"}] }; }, async close(){} };
}

test("dir_add_bot materializes the contact and flags is_bot=1", async () => {
  const db = await db0(); const calls = [];
  const req = { body: { action: "dir_add_bot", invite_code: CODE } };
  const res = fakeRes();
  await handlePostAction(req, res, { db, sharingClientFactory: async () => fakeClientThatAccepts(db, calls) });
  assert.equal(res.headersSent, true);
  assert.deepEqual(calls, ["crow_accept_bot_invite"], "accept only, no send");
  const { rows } = await db.execute({ sql: "SELECT is_bot, origin FROM contacts WHERE crow_id=?", args: [CROW_ID] });
  assert.equal(Number(rows[0].is_bot), 1, "contact flagged is_bot");
  assert.equal(rows[0].origin, "advertised", "new contact tagged origin=advertised (prune lifecycle)");
});

test("dir_message_bot materializes, flags is_bot, and redirects to ?open=<id>", async () => {
  const db = await db0(); const calls = [];
  const req = { body: { action: "dir_message_bot", invite_code: CODE } };
  const res = fakeRes();
  await handlePostAction(req, res, { db, sharingClientFactory: async () => fakeClientThatAccepts(db, calls) });
  assert.deepEqual(calls, ["crow_accept_bot_invite"], "accept only; no forced message");
  const { rows } = await db.execute({ sql: "SELECT id, is_bot FROM contacts WHERE crow_id=?", args: [CROW_ID] });
  assert.equal(Number(rows[0].is_bot), 1);
  assert.equal(res._redir, `/dashboard/messages?open=${rows[0].id}`, "redirects to the new conversation");
});

test("dir_add_bot on a failed accept does not flag anything", async () => {
  const db = await db0(); const calls = [];
  const fc = { async callTool(a){ calls.push(a.name); return { isError: true, content:[{type:"text",text:"bad"}] }; }, async close(){} };
  const req = { body: { action: "dir_add_bot", invite_code: CODE } };
  const res = fakeRes();
  await handlePostAction(req, res, { db, sharingClientFactory: async () => fc });
  const { rows } = await db.execute("SELECT COUNT(*) AS n FROM contacts");
  assert.equal(Number(rows[0].n), 0, "nothing materialized");
});
