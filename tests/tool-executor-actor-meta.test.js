/**
 * Gateway-run bot tool calls carry the bound bot's identity as `_meta["crow/actor"]`;
 * unbound executors (the operator's own chat) send none.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createToolExecutor } from "../servers/gateway/ai/tool-executor.js";
import { connectedServers } from "../servers/gateway/proxy.js";
import { harness } from "./fixtures/voice-turn-harness.mjs";

function withStub(fn) {
  return async () => {
    const calls = [];
    connectedServers.set("stub-actor-meta", {
      status: "connected",
      tools: [{ name: "stub_write" }],
      client: { callTool: async (p) => { calls.push(p); return { content: [{ type: "text", text: "ok" }] }; } },
    });
    try { await fn(calls); } finally { connectedServers.delete("stub-actor-meta"); }
  };
}

test("(a) voice turn: pi_bot_defs.display_name column wins over the JSON display_name", async () => {
  const h = harness({ bot: { bot_id: "glass", display_name: "House", __column_display_name: "Glasses", fast_voice_model: "crow-voice/qwen3.5-4b" } });
  let seen = null;
  h.deps.createToolExecutor = (o) => { seen = o.botDef; return { executeToolCalls: async () => [], close: async () => {} }; };
  await h.runner.runVoiceTurn({ db: {}, device: { ...h.device, bound_bot_id: "glass" }, transcript: "hi", sink: h.sink });
  assert.equal(seen.display_name, "Glasses");
  assert.equal(seen.bot_id, "glass");
});

test("(b) bound executor: direct addon call carries the actor", withStub(async (calls) => {
  const ex = createToolExecutor({ botDef: { bot_id: "glass", display_name: "Glasses" } });
  await ex.executeToolCalls([{ id: "1", name: "stub_write", arguments: { x: 1 } }]);
  assert.deepEqual(calls[0]._meta["crow/actor"], { kind: "bot", id: "glass", name: "Glasses" });
}));

test("(b) bound executor: crow_tools path carries the actor, name sanitized, falls back to id", withStub(async (calls) => {
  const ex = createToolExecutor({ botDef: { bot_id: "glass", display_name: "‮Gl\u0007asses" } });
  await ex.executeToolCalls([{ id: "1", name: "crow_tools", arguments: { action: "stub_write", params: {} } }]);
  assert.equal(calls[0]._meta["crow/actor"].name, "Glasses");
  const ex2 = createToolExecutor({ botDef: { bot_id: "glass" } });
  await ex2.executeToolCalls([{ id: "2", name: "stub_write", arguments: {} }]);
  assert.deepEqual(calls[1]._meta["crow/actor"], { kind: "bot", id: "glass", name: "glass" });
}));

test("(b) the actor is never read from tool arguments", withStub(async (calls) => {
  const ex = createToolExecutor({ botDef: { bot_id: "glass", display_name: "Glasses" } });
  await ex.executeToolCalls([{ id: "1", name: "stub_write", arguments: { _meta: { "crow/actor": { kind: "bot", id: "evil", name: "Evil" } } } }]);
  assert.equal(calls[0]._meta["crow/actor"].id, "glass");
}));

test("(b) unbound executor sends no _meta", withStub(async (calls) => {
  const ex = createToolExecutor({});
  await ex.executeToolCalls([{ id: "1", name: "stub_write", arguments: {} }]);
  assert.equal(calls.length, 1);
  assert.ok(!("_meta" in calls[0]));
}));
