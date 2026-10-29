import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseRemoteInvocationFlag,
  remoteServersForBot,
  REMOTE_CANON_MOUNT,
  mintRemoteBlocks,
} from "../scripts/pi-bots/remote-blocks.mjs";

test("parseRemoteInvocationFlag: only literal true enables; everything else off", () => {
  assert.equal(parseRemoteInvocationFlag(JSON.stringify({ remote_invocation: true })), true);
  assert.equal(parseRemoteInvocationFlag(JSON.stringify({ remote_invocation: false })), false);
  assert.equal(parseRemoteInvocationFlag(JSON.stringify({ smart_chat: true })), false);
  assert.equal(parseRemoteInvocationFlag("not json"), false);
  assert.equal(parseRemoteInvocationFlag(null), false);
  assert.equal(parseRemoteInvocationFlag(undefined), false);
});

test("remoteServersForBot parses instanceId::canonicalId, drops malformed", () => {
  const def = { tools: { remote_mcp: ["g1::crow-memory", "g1::crow-blog", "bad", "::x", "y::", 5, ""] } };
  assert.deepEqual(remoteServersForBot(def), [
    { instanceId: "g1", canonicalId: "crow-memory" },
    { instanceId: "g1", canonicalId: "crow-blog" },
  ]);
  assert.deepEqual(remoteServersForBot({}), []);
  assert.deepEqual(remoteServersForBot({ tools: {} }), []);
});

test("mount map covers the five core capabilities only", () => {
  assert.equal(REMOTE_CANON_MOUNT["crow-memory"], "/memory");
  assert.equal(REMOTE_CANON_MOUNT["crow-projects"], "/projects");
  assert.equal(REMOTE_CANON_MOUNT["crow-sharing"], "/sharing");
  assert.equal(REMOTE_CANON_MOUNT["crow-storage"], "/storage");
  assert.equal(REMOTE_CANON_MOUNT["crow-blog"], "/blog-mcp");
  assert.equal(REMOTE_CANON_MOUNT["texas-gov-data"], undefined); // addon — deferred
});

const RELAY = { relayBaseUrl: "http://127.0.0.1:3001", relayTokenPath: "/home/alex/.crow/peer-relay-token" };

test("mintRemoteBlocks mints one stdio block per (instance,capability) aimed at the gateway relay; no peer URL, token or key", () => {
  const def = { tools: { remote_mcp: ["abc12345deadbeef::crow-memory"] } };
  const peerGatewayUrls = { "abc12345deadbeef": "https://bravo.example:8444" };
  const { blocks, warnings } = mintRemoteBlocks(def, { peerGatewayUrls, proxyPath: "/repo/scripts/pi-bots/crow-remote-proxy.mjs", node: "/usr/bin/node", ...RELAY });
  const name = "crow-remote-abc12345-crow-memory";
  assert.ok(blocks[name], "block minted under expected name");
  const b = blocks[name];
  assert.equal(b.command, "/usr/bin/node");
  assert.deepEqual(b.args, ["/repo/scripts/pi-bots/crow-remote-proxy.mjs"]);
  assert.deepEqual(b.env, {
    CROW_REMOTE_INSTANCE_ID: "abc12345deadbeef",
    CROW_REMOTE_MOUNT: "/memory",
    CROW_REMOTE_RELAY_URL: "http://127.0.0.1:3001/peer-relay/abc12345deadbeef/memory/mcp",
    CROW_REMOTE_RELAY_TOKEN_PATH: "/home/alex/.crow/peer-relay-token",
  }, "exactly the relay env: the peer's URL never reaches the bot");
  assert.ok(!JSON.stringify(b).includes("bravo.example"));
  assert.ok(!JSON.stringify(b).includes("auth_token"));
  assert.equal(warnings.length, 0);
  // 38a: router mode, so pi-lab registers the ONE gateway tool
  // mcp__crow-remote-<id8>-<canonical> that the bridge's --tools csv names.
  assert.equal(b.router, true);
});

test("mintRemoteBlocks adds the signed relay actor when an actor is given (sig omitted without a key)", async () => {
  const { initGatewayActorKey, _resetActorKeyForTest, verifyPeerRelayActorSig } = await import("../scripts/pi-bots/actor-sig.mjs");
  const def = { tools: { remote_mcp: ["abc12345deadbeef::crow-blog"] } };
  const actor = { botId: "hank", threadId: "discord:42", gatewayType: "discord" };
  const mint = () => mintRemoteBlocks(def, { peerGatewayUrls: { abc12345deadbeef: "https://g:8444" }, proxyPath: "/p", node: "/n", ...RELAY, actor }).blocks["crow-remote-abc12345-crow-blog"].env;
  _resetActorKeyForTest();
  let env = mint();
  assert.equal(env.CROW_REMOTE_ACTOR_ID, "hank");
  assert.equal(env.CROW_REMOTE_ACTOR_THREAD, "discord:42");
  assert.equal(env.CROW_REMOTE_ACTOR_GATEWAY, "discord");
  assert.ok(!("CROW_REMOTE_ACTOR_SIG" in env), "no key → no signature");
  assert.equal(env.CROW_REMOTE_RELAY_URL, "http://127.0.0.1:3001/peer-relay/abc12345deadbeef/blog-mcp/mcp");
  initGatewayActorKey();
  env = mint();
  assert.equal(verifyPeerRelayActorSig({ ...actor, sig: env.CROW_REMOTE_ACTOR_SIG }), true);
});

test("mintRemoteBlocks warns + skips addon caps and unknown peers", () => {
  const def = { tools: { remote_mcp: ["g1::texas-gov-data", "ghost::crow-memory"] } };
  const { blocks, warnings } = mintRemoteBlocks(def, { peerGatewayUrls: { g1: "https://g1:8444" }, proxyPath: "/p.mjs", node: "/n" });
  assert.deepEqual(Object.keys(blocks), []);
  assert.equal(warnings.length, 2);
  assert.ok(warnings.some((w) => w.includes("texas-gov-data") && /addon|core/i.test(w)));
  assert.ok(warnings.some((w) => w.includes("ghost") && /unknown|gateway/i.test(w)));
});

test("server name uses 8-char instance prefix and hyphens (no __)", () => {
  const def = { tools: { remote_mcp: ["0123456789abcdef::crow-storage"] } };
  const { blocks } = mintRemoteBlocks(def, { peerGatewayUrls: { "0123456789abcdef": "https://x:8444" }, proxyPath: "/p", node: "/n", ...RELAY });
  const name = Object.keys(blocks)[0];
  assert.equal(name, "crow-remote-01234567-crow-storage");
  assert.ok(!name.includes("__"));
});

test("mintRemoteBlocks warns + keeps the first on an 8-char-prefix block-name collision", () => {
  // Two distinct peers sharing the first 8 hex chars, same capability → same block name.
  const a = "abcdef12" + "0000000000000000"; // 24 hex
  const b = "abcdef12" + "ffffffffffffffff";
  const def = { tools: { remote_mcp: [`${a}::crow-memory`, `${b}::crow-memory`] } };
  const { blocks, warnings } = mintRemoteBlocks(def, {
    peerGatewayUrls: { [a]: "https://a:8444", [b]: "https://b:8444" },
    proxyPath: "/p", node: "/n", ...RELAY,
  });
  assert.equal(Object.keys(blocks).length, 1, "only one block (collision)");
  const name = "crow-remote-abcdef12-crow-memory";
  assert.ok(blocks[name], "the first peer's block is kept");
  assert.equal(blocks[name].env.CROW_REMOTE_INSTANCE_ID, a, "first wins, not clobbered by second");
  assert.ok(warnings.some((w) => w.includes("collides")), "a collision warning was emitted");
});

test("mintRemoteBlocks never puts a credential-store path in a block, whatever the caller passes", () => {
  const def = { tools: { remote_mcp: ["abc12345deadbeef::crow-memory"] } };
  const { blocks } = mintRemoteBlocks(def, {
    peerGatewayUrls: { "abc12345deadbeef": "https://g:8444" }, proxyPath: "/p", node: "/n", ...RELAY,
    peerTokensPath: "/home/alex/.crow/peer-tokens.json",
  });
  const b = blocks["crow-remote-abc12345-crow-memory"];
  assert.ok(!JSON.stringify(b).includes("peer-tokens"));
  assert.ok(!Object.keys(b.env).some((k) => /PEER_TOKENS|GATEWAY_URL/.test(k)));
});

test("mintRemoteBlocks without a gateway relay mints nothing and says why", () => {
  const def = { tools: { remote_mcp: ["abc12345deadbeef::crow-memory"] } };
  const { blocks, warnings } = mintRemoteBlocks(def, { peerGatewayUrls: { "abc12345deadbeef": "https://g:8444" }, proxyPath: "/p", node: "/n" });
  assert.deepEqual(blocks, {});
  assert.ok(warnings.some((w) => /relay/.test(w)), warnings.join("; "));
});
