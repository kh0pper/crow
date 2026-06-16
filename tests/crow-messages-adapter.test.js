import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveBotIdentity } from "../servers/sharing/identity.js";
import { xOnly, buildDM, openDM, makeDedupeGate } from "../scripts/pi-bots/gateways/nostr-client.mjs";

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
