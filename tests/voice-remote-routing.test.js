import { test } from "node:test";
import assert from "node:assert/strict";
import { getChatTools, createToolExecutor } from "../servers/gateway/ai/tool-executor.js";

test("getChatTools advertises remoteTools as direct promoted tools", () => {
  const tools = getChatTools({ remoteTools: [
    { name: "fw_play", description: "Play music.", inputSchema: { type: "object", additionalProperties: true } },
  ] });
  const fw = tools.find(t => t.name === "fw_play");
  assert.ok(fw, "fw_play should be advertised");
  assert.equal(fw.description, "Play music.");
});

test("getChatTools without remoteTools advertises no remote tools (unchanged)", () => {
  assert.equal(getChatTools().some(t => t.name === "fw_play"), false);
});

test("getChatTools does not duplicate a name already advertised", () => {
  const tools = getChatTools({ remoteTools: [{ name: "crow_discover", description: "dupe" }] });
  assert.equal(tools.filter(t => t.name === "crow_discover").length, 1);
});

function fakeRemote() {
  const calls = [];
  return {
    calls,
    routeMap: new Map([["fw_play", { instanceId: "A", canonicalId: "funkwhale" }]]),
    callRemote: async (name, args) => { calls.push({ name, args }); return { content: [{ type: "text", text: `played ${args?.query || ""}` }] }; },
    close: async () => {},
  };
}

test("executeTool routes a remote tool by direct name", async () => {
  const remote = fakeRemote();
  const { result, isError } = await createToolExecutor({ remote }).executeTool("fw_play", { query: "jazz" });
  assert.equal(isError, false);
  assert.match(result, /played jazz/);
  assert.deepEqual(remote.calls, [{ name: "fw_play", args: { query: "jazz" } }]);
});

test("executeTool routes a remote tool hidden behind crow_tools", async () => {
  const remote = fakeRemote();
  await createToolExecutor({ remote }).executeTool("crow_tools", { action: "fw_play", params: { query: "blues" } });
  assert.deepEqual(remote.calls, [{ name: "fw_play", args: { query: "blues" } }]);
});

test("executeTool: with no remote, a non-existent tool falls through unchanged", async () => {
  const { isError, result } = await createToolExecutor().executeTool("fw_play", {});
  assert.equal(isError, true);
  assert.match(result, /Unknown tool|not found/);
});

test("executeTool: remote present but tool not in routeMap uses the local path", async () => {
  const remote = fakeRemote();
  const { isError } = await createToolExecutor({ remote }).executeTool("definitely_not_a_tool", {});
  assert.equal(remote.calls.length, 0);
  assert.equal(isError, true);
});

test("buildRemoteVoiceContext is re-exported from tool-executor", async () => {
  const m = await import("../servers/gateway/ai/tool-executor.js");
  assert.equal(typeof m.buildRemoteVoiceContext, "function");
});
