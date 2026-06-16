import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { deriveBotIdentity } from "../servers/sharing/identity.js";
import { handleCrowMessageEvent } from "../scripts/pi-bots/gateways/crow-messages.mjs";
import { buildDM, openDM, xOnly } from "../scripts/pi-bots/gateways/nostr-client.mjs";

const SEED = Buffer.alloc(32, 3);

test("invite → accept → authorized chat → reply decryptable by sender", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crowmsg-e2e-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: join(import.meta.dirname, "..") });
  const db = new Database(join(dir, "crow.db"));
  try {
    const bot = deriveBotIdentity(SEED, "bot1");
    const sender = deriveBotIdentity(SEED, "sender1");
    db.prepare("INSERT INTO bot_message_invites (bot_id, token) VALUES (?,?)").run("bot1", "tok-9");

    // captured outbound DMs (bot → sender), as real encrypted events
    const outbound = [];
    const sendDM = async (recipXOnly, text) => {
      outbound.push(buildDM(bot.secp256k1Priv, recipXOnly, text));
    };
    const deps = { botId: "bot1", db, sendDM, log: () => {} };

    // 1. sender accepts the invite
    await handleCrowMessageEvent({
      ...deps, senderPubkey: xOnly(sender.secp256k1Pubkey),
      decrypted: JSON.stringify({ type: "crow_social", subtype: "bot_invite_accept", token: "tok-9",
        sender: { crow_id: sender.crowId, secp256k1Pub: xOnly(sender.secp256k1Pubkey), display_name: "Sender One" } }),
      handleInbound: async () => ({ action: "done" }),
    });

    // 2. now an authorized chat turn
    let turnSeen = null;
    await handleCrowMessageEvent({
      ...deps, senderPubkey: xOnly(sender.secp256k1Pubkey), decrypted: "hello there",
      handleInbound: async (opts) => { turnSeen = opts; await opts.sendReply("general kenobi"); return { action: "done" }; },
    });

    assert.equal(turnSeen.user_message, "hello there");
    // last outbound is the chat reply; sender can decrypt it
    const replyEv = outbound[outbound.length - 1];
    const text = openDM(sender.secp256k1Priv, replyEv.pubkey, replyEv.content);
    assert.equal(text, "general kenobi");
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
