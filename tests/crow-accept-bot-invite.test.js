import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBotAcceptPayload } from "../servers/sharing/tools/contacts.js";

test("buildBotAcceptPayload carries the token + the accepter's identity, typed crow_social/bot_invite_accept", () => {
  const identity = {
    crowId: "crow:me0000000",
    ed25519Pubkey: "ed".repeat(16),
    secp256k1Pubkey: "ab".repeat(33),
  };
  const out = JSON.parse(buildBotAcceptPayload("the-token", identity, "Kevin"));
  assert.equal(out.type, "crow_social");
  assert.equal(out.subtype, "bot_invite_accept");
  assert.equal(out.token, "the-token");
  assert.equal(out.sender.crow_id, "crow:me0000000");
  assert.equal(out.sender.ed25519_pubkey, identity.ed25519Pubkey);
  assert.equal(out.sender.secp256k1_pubkey, identity.secp256k1Pubkey);
  assert.equal(out.sender.display_name, "Kevin");
});
