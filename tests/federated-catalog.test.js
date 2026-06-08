import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeFederatedCatalog } from "../servers/gateway/dashboard/federated-catalog.js";

const local = {
  instanceId: "self", instanceName: "Crow",
  tools: [{ canonicalId: "crow-memory", category: "memory", name: "Memory", bundleId: null, toolCount: 5 }],
  skills: [{ name: "research" }],
  bots: [{ bot_id: "a", display_name: "A", enabled: true, project_id: null, tracker_type: "none", model: "m", tool_count: 0 }],
};
const peers = [
  { instanceId: "p1", status: "ok", instance: { id: "p1", name: "Grackle" }, capabilities: {
    tools: [{ canonicalId: "texas-gov-data", category: "tools", name: "Texas", bundleId: "texas-gov-data", toolCount: 5 }],
    skills: [{ name: "tea" }], bots: [{ bot_id: "z", display_name: "Z", enabled: true, project_id: 1, tracker_type: "none", model: "m2", tool_count: 2 }],
  } },
  { instanceId: "p2", status: "unavailable", reason: "fetch_failed", capabilities: { tools: [], skills: [], bots: [] } },
];

test("local items tagged self; peer items tagged owner + remote", () => {
  const m = mergeFederatedCatalog(local, peers, "self");
  const localTool = m.tools.find((t) => t.canonicalId === "crow-memory");
  assert.equal(localTool.instance, "self");
  assert.ok(!localTool.remote);
  const peerTool = m.tools.find((t) => t.canonicalId === "texas-gov-data");
  assert.equal(peerTool.instance, "p1");
  assert.equal(peerTool.instanceName, "Grackle");
  assert.equal(peerTool.remote, true);
  const peerBot = m.bots.find((b) => b.bot_id === "z");
  assert.equal(peerBot.remote, true);
  assert.equal(peerBot.instanceName, "Grackle");
});

test("an unavailable peer contributes nothing and never throws", () => {
  const m = mergeFederatedCatalog(local, peers, "self");
  assert.ok(!m.tools.some((t) => t.instance === "p2"));
  assert.ok(!m.bots.some((b) => b.instance === "p2"));
});

test("handles empty / null peer list", () => {
  const m = mergeFederatedCatalog(local, [], "self");
  assert.equal(m.tools.length, 1);
  assert.equal(m.bots.length, 1);
  assert.doesNotThrow(() => mergeFederatedCatalog(local, null, "self"));
});
