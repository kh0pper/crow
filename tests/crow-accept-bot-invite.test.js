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

// A stub sharing-client factory that records callTool invocations and NEVER
// spins up the real in-memory sharing server (which would open live Nostr relay
// sockets + Hyperswarm and keep node:test alive forever). Injected via the
// handlePostAction `sharingClientFactory` param.
function makeStubSharingFactory() {
  const toolCalls = [];
  const factory = async () => ({
    callTool: async (args) => { toolCalls.push(args); return { content: [{ type: "text", text: "" }] }; },
    close: async () => {},
  });
  factory.toolCalls = toolCalls;
  return factory;
}

test("messages handlePostAction routes accept_bot_invite to the sharing tool and redirects", async () => {
  const { handlePostAction } = await import("../servers/gateway/dashboard/panels/messages/api-handlers.js");
  // Inject a stub factory so no real sharing runtime (relay sockets/Hyperswarm)
  // starts — otherwise this test never lets the process exit.
  const sharingClientFactory = makeStubSharingFactory();
  const calls = [];
  const req = { body: { action: "accept_bot_invite", invite_code: "crow:x.y.z" } };
  const res = { redirectAfterPost: (u) => { calls.push(u); res.headersSent = true; } };
  await handlePostAction(req, res, { db: { execute: async () => ({ rows: [] }) }, sharingClientFactory });
  assert.equal(calls[0], "/dashboard/messages", "redirects back to messages");
  assert.equal(sharingClientFactory.toolCalls[0]?.name, "crow_accept_bot_invite", "routes to the bot-invite tool via the injected factory");
});

test("messages handlePostAction send_peer honors the injected sharingClientFactory (no real runtime)", async () => {
  const { handlePostAction } = await import("../servers/gateway/dashboard/panels/messages/api-handlers.js");
  // Regression guard: the send_peer branch used to call getSharingClient()
  // directly, ignoring the injectable factory and starting the real sharing
  // runtime (live relay sockets). Prove the injected stub is the one used.
  const sharingClientFactory = makeStubSharingFactory();
  const calls = [];
  const req = { body: { action: "send_peer", contact_id: "7", message: "hello there" } };
  const res = { redirectAfterPost: (u) => { calls.push(u); res.headersSent = true; } };
  const db = { execute: async () => ({ rows: [{ display_name: "Alice", crow_id: "crow:alice0001" }] }) };
  await handlePostAction(req, res, { db, sharingClientFactory });
  assert.equal(calls[0], "/dashboard/messages", "redirects back to messages");
  const sent = sharingClientFactory.toolCalls[0];
  assert.equal(sent?.name, "crow_send_message", "send_peer went through the injected factory");
  assert.equal(sent?.arguments?.contact, "Alice");
  assert.equal(sent?.arguments?.message, "hello there");
});
