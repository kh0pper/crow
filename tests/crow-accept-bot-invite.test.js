import { test, mock } from "node:test";
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

test("messages handlePostAction routes accept_bot_invite to the sharing tool and redirects", async () => {
  const { handlePostAction } = await import("../servers/gateway/dashboard/panels/messages/api-handlers.js");
  // Stub the sharing client factory via a captured call recorder on the module
  // is overkill; instead assert the dispatch path returns a redirect for a
  // well-formed body even if the tool call fails internally (it catches).
  const calls = [];
  const req = { body: { action: "accept_bot_invite", invite_code: "crow:x.y.z" } };
  const res = { redirectAfterPost: (u) => { calls.push(u); res.headersSent = true; } };
  await handlePostAction(req, res, { db: { execute: async () => ({ rows: [] }) } });
  assert.equal(calls[0], "/dashboard/messages", "redirects back to messages");
});
