// tests/roster-advertise-owner.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import {
  getOrCreatePairedRosterInvite, listAdvertisedBots, buildAdvertisementPayload,
} from "../servers/gateway/dashboard/panels/bot-builder/crow-messages-admin.js";

async function seed(db) {
  await db.execute(`CREATE TABLE bot_message_invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT, token TEXT UNIQUE,
    expires_at TEXT, max_uses INTEGER, uses INTEGER DEFAULT 0, revoked INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')), kind TEXT)`);
  await db.execute(`CREATE TABLE pi_bot_defs (
    bot_id TEXT PRIMARY KEY, display_name TEXT, definition TEXT, enabled INTEGER DEFAULT 1)`);
}

test("getOrCreatePairedRosterInvite mints once, then reuses", async () => {
  const db = createClient({ url: ":memory:" });
  await seed(db);
  const t1 = await getOrCreatePairedRosterInvite(db, "botA");
  const t2 = await getOrCreatePairedRosterInvite(db, "botA");
  assert.equal(t1, t2, "same token reused");
  const { rows } = await db.execute("SELECT max_uses, expires_at, kind FROM bot_message_invites WHERE bot_id='botA'");
  assert.equal(rows.length, 1, "exactly one row");
  assert.equal(rows[0].max_uses, null);
  assert.equal(rows[0].expires_at, null);
  assert.equal(rows[0].kind, "paired-roster");
});

test("listAdvertisedBots returns only crow-messages bots with allow_paired_instances", async () => {
  const db = createClient({ url: ":memory:" });
  await seed(db);
  await db.execute({ sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,1)",
    args: ["yes", "Yes Bot", JSON.stringify({ gateways: [{ type: "crow-messages", allow_paired_instances: true }] })] });
  await db.execute({ sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,1)",
    args: ["off", "Off Bot", JSON.stringify({ gateways: [{ type: "crow-messages", allow_paired_instances: false }] })] });
  await db.execute({ sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,1)",
    args: ["gmail", "Gmail Bot", JSON.stringify({ gateways: [{ type: "gmail" }] })] });
  await db.execute({ sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,0)",
    args: ["disabled", "Disabled", JSON.stringify({ gateways: [{ type: "crow-messages", allow_paired_instances: true }] })] });

  const bots = await listAdvertisedBots(db);
  assert.deepEqual(bots.map((b) => b.botId).sort(), ["yes"]);
  assert.equal(bots[0].displayName, "Yes Bot");
});

test("buildAdvertisementPayload combines identity + invite into the wire shape", async () => {
  const db = createClient({ url: ":memory:" });
  await seed(db);
  await db.execute({ sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,1)",
    args: ["yes", "Yes Bot", JSON.stringify({ gateways: [{ type: "crow-messages", allow_paired_instances: true }] })] });

  const payload = await buildAdvertisementPayload(db, {
    instanceId: "inst-1", instanceLabel: "Laptop",
    _identityFor: () => ({ secp256k1Pubkey: "02" + "a".repeat(64) }), // compressed → xOnly strips prefix
    _buildInviteCode: async (_db, botId, token) => `crow:${botId}.${token}.sig`,
  });
  assert.equal(payload.bots.length, 1);
  const b = payload.bots[0];
  assert.equal(b.bot_id, "yes");
  assert.equal(b.display_name, "Yes Bot");
  assert.equal(b.instance_id, "inst-1");
  assert.equal(b.instance_label, "Laptop");
  assert.equal(b.messaging_pubkey, "a".repeat(64), "x-only (prefix stripped)");
  assert.ok(b.invite_code.startsWith("crow:yes."), "invite code built from the reused token");
});
