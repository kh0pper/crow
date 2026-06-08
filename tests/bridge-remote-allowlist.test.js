import { test } from "node:test";
import assert from "node:assert/strict";
import { toolAllowlist } from "../scripts/pi-bots/bridge.mjs";

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
