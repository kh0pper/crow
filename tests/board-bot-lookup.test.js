// tests/board-bot-lookup.test.js
//
// bot-lookup.js isEnabledBot: an enabled pi_bot_defs row that is not the
// reserved voice bot. One crow.db fixture with four rows covers each branch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createDbClient } from "../servers/db.js";
import { isEnabledBot } from "../servers/gateway/board/bot-lookup.js";
import { CROW_VOICE_BOT_ID } from "../servers/shared/voice-bot.js";

async function withCdb(fn) {
  const root = mkdtempSync(join(tmpdir(), "botlookup-"));
  const dbPath = join(root, "crow.db");
  const c = new Database(dbPath);
  c.exec(`CREATE TABLE pi_bot_defs (bot_id TEXT PRIMARY KEY, display_name TEXT NOT NULL,
    definition TEXT, enabled INTEGER NOT NULL DEFAULT 1, project_id INTEGER)`);
  const ins = c.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, enabled) VALUES (?,?,?)");
  ins.run("bot-1", "Bot one", 1);
  ins.run("bot-off", "Bot off", 0);
  ins.run(CROW_VOICE_BOT_ID, "Voice", 1);
  c.close();
  const cdb = createDbClient(dbPath);
  try {
    await fn(cdb);
  } finally {
    cdb.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("isEnabledBot: an enabled row is true", async () => {
  await withCdb(async (cdb) => {
    assert.equal(await isEnabledBot(cdb, "bot-1"), true);
  });
});

test("isEnabledBot: disabled, unknown, voice and empty ids are false", async () => {
  await withCdb(async (cdb) => {
    assert.equal(await isEnabledBot(cdb, "bot-off"), false);
    assert.equal(await isEnabledBot(cdb, "nobody"), false);
    assert.equal(await isEnabledBot(cdb, CROW_VOICE_BOT_ID), false);
    assert.equal(await isEnabledBot(cdb, ""), false);
    assert.equal(await isEnabledBot(cdb, null), false);
    assert.equal(await isEnabledBot(cdb, undefined), false);
  });
});

test("isEnabledBot: a store without pi_bot_defs reads as false, never throws", async () => {
  const root = mkdtempSync(join(tmpdir(), "botlookup-empty-"));
  const dbPath = join(root, "crow.db");
  new Database(dbPath).close();
  const cdb = createDbClient(dbPath);
  try {
    assert.equal(await isEnabledBot(cdb, "bot-1"), false);
  } finally {
    cdb.close();
    rmSync(root, { recursive: true, force: true });
  }
});
