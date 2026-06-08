import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRemoteProxyServer } from "../scripts/pi-bots/crow-remote-proxy.mjs";

// A stub MCP client mimicking the SDK Client surface the proxy uses.
function stubClient({ tools, callImpl, connectThrows }) {
  return {
    connected: false,
    async connect() { if (connectThrows) throw new Error("peer unreachable"); this.connected = true; },
    async listTools() { return { tools }; },
    async callTool(args) { return callImpl(args); },
    async close() { this.connected = false; },
  };
}

test("lists the peer mount's tools verbatim", async () => {
  const client = stubClient({
    tools: [{ name: "crow_store_memory", description: "store", inputSchema: { type: "object" } }],
    callImpl: async () => ({ content: [{ type: "text", text: "ok" }] }),
  });
  const { listTools } = await buildRemoteProxyServer({ clientFactory: async () => client });
  const out = await listTools();
  assert.equal(out.tools.length, 1);
  assert.equal(out.tools[0].name, "crow_store_memory");
});

test("forwards tools/call to the peer and returns its result", async () => {
  let seen = null;
  const client = stubClient({
    tools: [{ name: "crow_search_memories", description: "", inputSchema: { type: "object" } }],
    callImpl: async (a) => { seen = a; return { content: [{ type: "text", text: "hit" }] }; },
  });
  const { callTool } = await buildRemoteProxyServer({ clientFactory: async () => client });
  const r = await callTool({ name: "crow_search_memories", arguments: { query: "x" } });
  assert.deepEqual(seen, { name: "crow_search_memories", arguments: { query: "x" } });
  assert.equal(r.content[0].text, "hit");
});

test("peer-deny error is surfaced (not swallowed) to the caller", async () => {
  const client = stubClient({
    tools: [{ name: "crow_store_memory", description: "", inputSchema: { type: "object" } }],
    callImpl: async () => { const e = new Error("Tool not exposed for remote invocation by this instance"); e.code = -32001; throw e; },
  });
  const { callTool } = await buildRemoteProxyServer({ clientFactory: async () => client });
  await assert.rejects(() => callTool({ name: "crow_store_memory", arguments: {} }), /not exposed/);
});

test("peer unreachable → empty tool list, no throw", async () => {
  const client = stubClient({ tools: [], callImpl: async () => ({}), connectThrows: true });
  const { listTools } = await buildRemoteProxyServer({ clientFactory: async () => client });
  const out = await listTools();
  assert.deepEqual(out.tools, []);
});
