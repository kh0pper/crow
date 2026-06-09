import { test } from "node:test";
import assert from "node:assert/strict";
import { toPublicBot } from "../servers/gateway/capability-registry.js";

const row = () => ({ bot_id: "scout", display_name: "Scout", enabled: 1, project_id: 3, definition: JSON.stringify({ models: { default: "m" }, tools: { crow_mcp: ["x/y"] } }) });

test("toPublicBot: peer_manageable true when bot in managedSet", () => {
  const b = toPublicBot(row(), new Set(["scout"]));
  assert.equal(b.peer_manageable, true);
  assert.equal(b.bot_id, "scout");
});

test("toPublicBot: peer_manageable false when not in set / no set", () => {
  assert.equal(toPublicBot(row(), new Set()).peer_manageable, false);
  assert.equal(toPublicBot(row()).peer_manageable, false);
});

test("toPublicBot: never leaks the definition or secrets", () => {
  const b = toPublicBot(row(), new Set(["scout"]));
  assert.equal("definition" in b, false);
  assert.equal("system_prompt" in b, false);
});
