import { test } from "node:test";
import assert from "node:assert/strict";
import { toolAllowlist } from "../scripts/pi-bots/bridge.mjs";
import { mintRemoteBlocks } from "../scripts/pi-bots/remote-blocks.mjs";
import { piLabRegisteredNames, piOfferedTools } from "./helpers/pi-tool-names.mjs";

const def = { tools: {
  pi_builtin: ["read"],
  crow_mcp: ["crow-memory/crow_store_memory"],
  remote_mcp: ["g1abcdef::crow-memory", "g1abcdef::crow-blog"],
} };

test("flag OFF: only builtin + local crow_mcp, no remote entries", () => {
  const out = toolAllowlist(def, { remoteEnabled: false });
  assert.equal(out, "read,mcp__crow-memory__crow_store_memory");
});

test("flag OFF is the default (no opts)", () => {
  assert.equal(toolAllowlist(def), "read,mcp__crow-memory__crow_store_memory");
});

test("flag ON: adds server-level remote entries", () => {
  const out = toolAllowlist(def, { remoteEnabled: true });
  const parts = out.split(",");
  assert.ok(parts.includes("mcp__crow-remote-g1abcdef-crow-memory"));
  assert.ok(parts.includes("mcp__crow-remote-g1abcdef-crow-blog"));
  assert.ok(parts.includes("read"));
  assert.ok(parts.includes("mcp__crow-memory__crow_store_memory"));
});

// Queue item 38a: the string above was pinned while no remote tool ever
// reached a bot — the minted blocks were not router-mode, so pi-lab registered
// per-tool names the server-level csv entry never matched. What matters is
// what pi OFFERS for this csv and the blocks the writer mints for it.
test("flag ON: every remote csv entry is a tool pi-lab registers for the minted block, and pi keeps it", () => {
  const csv = toolAllowlist(def, { remoteEnabled: true });
  const { blocks, warnings } = mintRemoteBlocks(def, {
    peerGatewayUrls: { g1abcdef: "http://127.0.0.1:9" }, proxyPath: "/p.mjs", node: "/n",
    relayBaseUrl: "http://127.0.0.1:3001", relayToken: "relay-token-fixture",
  });
  assert.deepEqual(warnings, []);
  const peerTools = ["crow_store_memory", "crow_search_memories", "crow_create_post"];
  const registered = piLabRegisteredNames(blocks, Object.fromEntries(Object.keys(blocks).map((k) => [k, peerTools])));
  const offered = piOfferedTools(csv, registered);
  assert.deepEqual(offered.sort(), ["mcp__crow-remote-g1abcdef-crow-blog", "mcp__crow-remote-g1abcdef-crow-memory"]);
  const remoteCsv = csv.split(",").filter((n) => n.startsWith("mcp__crow-remote-"));
  assert.equal(offered.length, remoteCsv.length, "the tool-budget count (one per csv entry) equals what the model gets");
});

test("negative control: a non-router block's tools never match the server-level csv entry (the 38a bug)", () => {
  const csv = toolAllowlist(def, { remoteEnabled: true });
  const direct = { "crow-remote-g1abcdef-crow-memory": { command: "/n", args: ["/p.mjs"] } };
  const registered = piLabRegisteredNames(direct, { "crow-remote-g1abcdef-crow-memory": ["crow_store_memory"] });
  assert.deepEqual(piOfferedTools(csv, registered), []);
});
