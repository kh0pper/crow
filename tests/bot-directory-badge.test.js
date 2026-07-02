// tests/bot-directory-badge.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { getUnifiedConversationList } from "../servers/gateway/dashboard/panels/messages/data-queries.js";

test("getUnifiedConversationList carries isBot for bot contacts", async () => {
  const db = createClient({ url: ":memory:" });
  await db.execute(`CREATE TABLE chat_conversations (id INTEGER PRIMARY KEY, title TEXT, provider TEXT, model TEXT, updated_at TEXT, created_at TEXT)`);
  await db.execute(`CREATE TABLE chat_messages (id INTEGER PRIMARY KEY, conversation_id INTEGER)`);
  // created_at is required: getUnifiedConversationList orders peers by c.created_at.
  // `origin` matches the real contacts schema (the peer query filters origin='local-bot').
  await db.execute(`CREATE TABLE contacts (id INTEGER PRIMARY KEY, crow_id TEXT, display_name TEXT, last_seen TEXT, is_blocked INTEGER DEFAULT 0, is_bot INTEGER DEFAULT 0, origin TEXT, request_status TEXT, created_at TEXT DEFAULT (datetime('now')))`);
  await db.execute(`CREATE TABLE messages (id INTEGER PRIMARY KEY, contact_id INTEGER, created_at TEXT, is_read INTEGER, direction TEXT)`);
  await db.execute(`INSERT INTO contacts (crow_id, display_name, is_bot) VALUES ('crow:bot','Helper',1)`);
  await db.execute(`INSERT INTO contacts (crow_id, display_name, is_bot) VALUES ('crow:human','Kevin',0)`);

  const { items } = await getUnifiedConversationList(db);
  const bot = items.find((i) => i.displayName === "Helper");
  const human = items.find((i) => i.displayName === "Kevin");
  assert.equal(bot.isBot, true, "bot contact flagged");
  assert.equal(human.isBot, false, "human contact not flagged");
});
