import { test } from "node:test";
import assert from "node:assert/strict";
import { getLocalCatalog, canonicalForCategory } from "../servers/gateway/capability-registry.js";

const db = {
  async execute() {
    return { rows: [
      { bot_id: "a", display_name: "A", enabled: 1, project_id: null, definition: JSON.stringify({ models: { default: "m1" }, tools: { crow_mcp: ["crow-memory/x"] } }) },
      { bot_id: "b", display_name: "B", enabled: 0, project_id: 3, definition: "{}" },
    ] };
  },
};

test("catalog includes core tools with canonical+category and a positive count", async () => {
  const cat = await getLocalCatalog(db, { crowHome: "/tmp/nonexistent-crowhome", instanceId: "self", instanceName: "Self" });
  const mem = cat.tools.find((t) => t.canonicalId === canonicalForCategory("memory"));
  assert.ok(mem, "memory core tool present");
  assert.equal(mem.category, "memory");
  assert.ok(mem.toolCount > 0);
});

test("catalog projects bots public-safe (no definition leak)", async () => {
  const cat = await getLocalCatalog(db, { crowHome: "/tmp/nonexistent-crowhome", instanceId: "self" });
  assert.equal(cat.bots.length, 2);
  assert.equal(cat.bots[0].model, "m1");
  assert.equal(cat.bots[0].tool_count, 1);
  assert.ok(!JSON.stringify(cat.bots).includes("definition"));
  assert.equal(cat.instanceId, "self");
});
