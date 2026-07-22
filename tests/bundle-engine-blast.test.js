/**
 * GET /bundles/api/engine-blast — C4 Task 10.
 *
 * The uninstall-confirm flow for the "bot-engine" bundle needs to tell the
 * operator which bot channels stop working if they go through with it. This
 * route is the server side of that: enabled pi_bot_defs rows whose parsed
 * definition.gateways intersect ENGINE_CHANNELS (gmail/discord/telegram/slack
 * — bot-engine-status.js).
 *
 * Isolation: CROW_HOME/CROW_DATA_DIR point at a scratch dir (never the
 * operator's real ~/.crow — see bundles-auth-bypass.test.js's note about the
 * uptime-kuma incident), set BEFORE importing bundlesRouter so its
 * module-load-time path resolution reads the scratch dir.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "crow-engine-blast-"));
process.env.CROW_HOME = home;
process.env.CROW_DATA_DIR = join(home, "data");

execFileSync(process.execPath, ["scripts/init-db.js"], {
  env: { ...process.env, CROW_DATA_DIR: process.env.CROW_DATA_DIR },
  stdio: "pipe",
  cwd: new URL("..", import.meta.url).pathname,
});

const { default: bundlesRouter } = await import("../servers/gateway/routes/bundles.js");
const { createDbClient } = await import("../servers/db.js");

const db = createDbClient();

async function withRouter(fn) {
  const app = express();
  app.use(express.json());
  app.use(bundlesRouter());
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); }
}

async function seedBot(botId, { displayName = botId, gateways = [], enabled = 1 } = {}) {
  await db.execute({
    sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,?) " +
      "ON CONFLICT(bot_id) DO UPDATE SET display_name=excluded.display_name, definition=excluded.definition, enabled=excluded.enabled",
    args: [botId, displayName, JSON.stringify({ gateways, tools: {}, models: {} }), enabled],
  });
}

before(async () => {});

after(async () => {
  try { db.close(); } catch {}
  rmSync(home, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.execute({ sql: "DELETE FROM pi_bot_defs", args: [] });
});

test("bot with gmail+discord gateways enabled → listed with both types", async () => {
  await seedBot("mail-and-chat-bot", {
    displayName: "Mail & Chat Bot",
    gateways: [
      { type: "gmail", address: "x@y.z", allowlist: ["x@y.z"] },
      { type: "discord", token: "tok" },
    ],
  });
  await withRouter(async (base) => {
    const res = await fetch(base + "/bundles/api/engine-blast");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.channels.length, 1);
    const entry = body.channels[0];
    assert.equal(entry.bot_id, "mail-and-chat-bot");
    assert.equal(entry.display_name, "Mail & Chat Bot");
    assert.deepEqual([...entry.types].sort(), ["discord", "gmail"]);
  });
});

test("disabled bot is excluded even with a gated gateway", async () => {
  await seedBot("disabled-bot", {
    displayName: "Disabled Bot",
    gateways: [{ type: "discord", token: "tok" }],
    enabled: 0,
  });
  await withRouter(async (base) => {
    const res = await fetch(base + "/bundles/api/engine-blast");
    const body = await res.json();
    assert.deepEqual(body.channels, []);
  });
});

test("bot with only crow-messages/voice gateways is excluded (not an engine channel)", async () => {
  await seedBot("messages-only-bot", {
    displayName: "Messages Only Bot",
    gateways: [
      { type: "crow-messages", allow_paired_instances: true },
      { type: "voice" },
    ],
  });
  await withRouter(async (base) => {
    const res = await fetch(base + "/bundles/api/engine-blast");
    const body = await res.json();
    assert.deepEqual(body.channels, []);
  });
});

test("malformed definition JSON is tolerated (treated as no gateways, not a 500)", async () => {
  await db.execute({
    sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,1)",
    args: ["broken-def-bot", "Broken Def Bot", "{not valid json"],
  });
  await withRouter(async (base) => {
    const res = await fetch(base + "/bundles/api/engine-blast");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.channels, []);
  });
});

test("multiple enabled bots with gated gateways are all listed", async () => {
  await seedBot("bot-a", { displayName: "Bot A", gateways: [{ type: "telegram", token: "t" }] });
  await seedBot("bot-b", { displayName: "Bot B", gateways: [{ type: "slack", token: "t" }] });
  await withRouter(async (base) => {
    const res = await fetch(base + "/bundles/api/engine-blast");
    const body = await res.json();
    const ids = body.channels.map((c) => c.bot_id).sort();
    assert.deepEqual(ids, ["bot-a", "bot-b"]);
  });
});
