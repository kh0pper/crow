import { test } from "node:test";
import assert from "node:assert/strict";
import { toPublicBot, toPublicTool, toPublicSkill } from "../servers/gateway/capability-registry.js";

test("toPublicBot exposes only whitelisted fields, never the raw definition", () => {
  const row = {
    bot_id: "scout", display_name: "Scout", enabled: 1, project_id: 7,
    definition: JSON.stringify({
      models: { default: "crow-local/qwen3.6-35b-a3b" },
      tools: { crow_mcp: ["crow-tasks/tasks_list", "crow-memory/crow_store_memory"], pi_builtin: ["read"] },
      gateways: [{ type: "gmail", address: "kevin.hopper+scout@maestro.press", allowlist: ["secret@x"] }],
      permission_policy: { bash: "deny", write_paths: ["/home/kh0pp/.crow-mpa/pi-bots/scout"] },
      system_prompt: "SECRET PROMPT do not leak",
      spawn_env: { PI_PROVIDER: "crow-local", SECRET_KEY: "abc123" },
    }),
  };
  const pub = toPublicBot(row);
  assert.deepEqual(Object.keys(pub).sort(),
    ["bot_id", "display_name", "enabled", "model", "project_id", "tool_count", "tracker_type"].sort());
  assert.equal(pub.bot_id, "scout");
  assert.equal(pub.enabled, true);
  assert.equal(pub.model, "crow-local/qwen3.6-35b-a3b");
  assert.equal(pub.tool_count, 2);
  const blob = JSON.stringify(pub);
  for (const leak of ["SECRET PROMPT", "SECRET_KEY", "abc123", "maestro.press", "permission_policy", "write_paths", "spawn_env", "system_prompt"]) {
    assert.ok(!blob.includes(leak), `leaked: ${leak}`);
  }
});

test("toPublicTool drops env/keys/command/args", () => {
  const pub = toPublicTool({
    canonicalId: "texas-gov-data", category: "tools", name: "texas-gov-data", bundleId: "texas-gov-data", toolCount: 5,
    block: { command: "/usr/bin/uv", args: ["run", "x"], env: { API_KEY: "sekret" } },
  });
  assert.deepEqual(Object.keys(pub).sort(), ["bundleId", "canonicalId", "category", "name", "toolCount"].sort());
  assert.ok(!JSON.stringify(pub).includes("sekret"));
  assert.ok(!JSON.stringify(pub).includes("API_KEY"));
});

test("toPublicSkill is just a name", () => {
  assert.deepEqual(toPublicSkill({ name: "research-pipeline", path: "/home/kh0pp/.crow/skills/research-pipeline.md" }),
    { name: "research-pipeline" });
});
