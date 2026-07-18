/**
 * The Maestro Press consulting-pipeline CRM must NOT ship in core Crow
 * (strategic-review Q4, Kevin 2026-07-18: moved to a private MPA-only bundle).
 * Every public install used to advertise crow_consulting_* tools in its AI
 * tool manifest — this pins the removal.
 */
import { test } from "node:test";
import assert from "node:assert";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("core tool manifests carry no consulting category or crow_consulting_* tools", async () => {
  const { TOOL_MANIFESTS } = await import("../servers/gateway/tool-manifests.js");
  assert.ok(!("consulting" in TOOL_MANIFESTS), "TOOL_MANIFESTS must not have a consulting category");
  const flat = JSON.stringify(TOOL_MANIFESTS);
  assert.ok(!flat.includes("crow_consulting"), "no crow_consulting_* tool may appear in manifests");
});

test("servers/consulting is gone from the tree", () => {
  assert.ok(!existsSync(join(repoRoot, "servers", "consulting")), "servers/consulting must not exist");
});
