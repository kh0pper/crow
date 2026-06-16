// tests/bot-directory-contacts-surface.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { randomBytes } from "node:crypto";
import { deriveBotIdentity, generateBotInviteCode, parseBotInviteCode } from "../servers/sharing/identity.js";
import { handleContactAction } from "../servers/gateway/dashboard/panels/contacts/api-handlers.js";

const ident = deriveBotIdentity(randomBytes(32), "c-dir-bot");
const CODE = generateBotInviteCode(ident, "tok", [], "Dir Bot");
const CROW_ID = parseBotInviteCode(CODE).botCrowId;

test("contacts dir_add_bot materializes + flags is_bot", async () => {
  const db = createClient({ url: ":memory:" });
  await db.execute(`CREATE TABLE contacts (id INTEGER PRIMARY KEY, crow_id TEXT, secp256k1_pubkey TEXT, origin TEXT, is_bot INTEGER DEFAULT 0)`);
  const calls = [];
  const fakeClient = { async callTool(a){ calls.push(a.name); if (a.name==="crow_accept_bot_invite") await db.execute({ sql:"INSERT INTO contacts (crow_id, secp256k1_pubkey) VALUES (?,?)", args:[CROW_ID, ident.secp256k1Pubkey] }); return { content:[{type:"text",text:"ok"}] }; }, async close(){} };
  const req = { body: { action: "dir_add_bot", invite_code: CODE } };
  const result = await handleContactAction(req, db, { sharingClientFactory: async () => fakeClient });
  assert.equal(result.redirect, "/dashboard/contacts?view=bots");
  assert.deepEqual(calls, ["crow_accept_bot_invite"]);
  const { rows } = await db.execute({ sql:"SELECT is_bot, origin FROM contacts WHERE crow_id=?", args:[CROW_ID] });
  assert.equal(Number(rows[0].is_bot), 1);
  assert.equal(rows[0].origin, "advertised", "new contact tagged origin=advertised");
});
