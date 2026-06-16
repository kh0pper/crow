import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveBotIdentity } from "../servers/sharing/identity.js";
import { xOnly, buildDM, openDM, makeDedupeGate } from "../scripts/pi-bots/gateways/nostr-client.mjs";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { handleCrowMessageEvent } from "../scripts/pi-bots/gateways/crow-messages.mjs";
import * as cmStore from "../scripts/pi-bots/gateways/crow-messages-store.mjs";
import { isHostManaged, getAdapter } from "../scripts/pi-bots/gateways/index.mjs";

function freshDb() {
  const d = mkdtempSync(join(tmpdir(), "crowmsg-adapter-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: d }, stdio: "pipe", cwd: join(import.meta.dirname, "..") });
  return { dir: d, db: new Database(join(d, "crow.db")) };
}

const SEED = Buffer.alloc(32, 9);

test("xOnly strips a compressed (66) key to 64, passes 64 through", () => {
  assert.equal(xOnly("02" + "a".repeat(64)).length, 64);
  assert.equal(xOnly("a".repeat(64)), "a".repeat(64));
});

test("makeDedupeGate: first sight true, repeats false", () => {
  const gate = makeDedupeGate();
  assert.equal(gate("evt-1"), true);
  assert.equal(gate("evt-1"), false);
  assert.equal(gate("evt-2"), true);
  assert.equal(gate(null), false);
});

test("buildDM → openDM round-trips between two derived identities", () => {
  const bot = deriveBotIdentity(SEED, "bot-alpha");
  const sender = deriveBotIdentity(SEED, "sender-x");
  // sender → bot
  const ev = buildDM(sender.secp256k1Priv, xOnly(bot.secp256k1Pubkey), "hello bot");
  assert.equal(ev.kind, 4);
  assert.ok(ev.tags.some(t => t[0] === "p" && t[1] === xOnly(bot.secp256k1Pubkey)));
  // bot decrypts using sender's pubkey (event.pubkey)
  const text = openDM(bot.secp256k1Priv, ev.pubkey, ev.content);
  assert.equal(text, "hello bot");
});

test("invite-accept event authorizes the sender, runs no pi turn", async () => {
  const { dir, db } = freshDb();
  try {
    db.prepare("INSERT INTO bot_message_invites (bot_id, token) VALUES (?,?)").run("bot1", "tok-1");
    let turns = 0;
    const sent = [];
    await handleCrowMessageEvent({
      botId: "bot1", senderPubkey: "a".repeat(64),
      decrypted: JSON.stringify({ type: "crow_social", subtype: "bot_invite_accept", token: "tok-1", sender: { crow_id: "crow:s", secp256k1Pub: "a".repeat(64), display_name: "Sam" } }),
      db,
      handleInbound: async () => { turns++; return { action: "done" }; },
      sendDM: async (pk, text) => sent.push([pk, text]),
      log: () => {},
    });
    assert.equal(turns, 0, "no pi turn on accept");
    assert.equal(cmStore.authorizeSender(db, "bot1", "a".repeat(64)), true, "now authorized");
    assert.equal(sent.length, 1, "sent an ack");
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("authorized chat → handleInbound with crow-messages thread; reply published", async () => {
  const { dir, db } = freshDb();
  try {
    cmStore.upsertAclFromAccept(db, "bot1", "a".repeat(64), "crow:s", "Sam");
    let seen = null; const sent = [];
    await handleCrowMessageEvent({
      botId: "bot1", senderPubkey: "a".repeat(64), decrypted: "what's the weather?",
      db,
      handleInbound: async (opts) => { seen = opts; await opts.sendReply("sunny"); return { action: "done" }; },
      sendDM: async (pk, text) => sent.push([pk, text]),
      log: () => {},
    });
    assert.equal(seen.gateway_type, "crow-messages");
    assert.equal(seen.gateway_thread_id, "crow-messages:" + "a".repeat(64));
    assert.equal(seen.user_message, "what's the weather?");
    assert.deepEqual(sent, [["a".repeat(64), "sunny"]]);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("unauthorized chat → no turn, no reply", async () => {
  const { dir, db } = freshDb();
  try {
    let turns = 0; const sent = [];
    await handleCrowMessageEvent({
      botId: "bot1", senderPubkey: "z".repeat(64), decrypted: "hi",
      db,
      handleInbound: async () => { turns++; return {}; },
      sendDM: async (...a) => sent.push(a), log: () => {},
    });
    assert.equal(turns, 0);
    assert.equal(sent.length, 0);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("crow-messages is registered as a host-managed adapter", () => {
  assert.equal(isHostManaged("crow-messages"), true);
  const a = getAdapter("crow-messages");
  assert.ok(a && a.type === "crow-messages" && typeof a.start === "function");
});
