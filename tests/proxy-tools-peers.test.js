/**
 * Queue item 38b: the raw tool surface (/tools/mcp and every /tools-<name>
 * mount) is built by createProxyServer from connectedServers, which also holds
 * one `instance-<id>` entry per connected federation peer (isRemote, the peer's
 * /memory/mcp tools). Peers are reached through /router/mcp and the bot remote
 * proxy, never here: two peers used to collide on crow_store_memory and 500
 * every session init, and one peer's memory tools surfaced under the LOCAL
 * names (a call wrote to the peer).
 *
 * No network: entries carry stub clients; the HTTP case uses the real
 * mountMcpServer on an ephemeral loopback port.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { connectedServers, createProxyServer } from "../servers/gateway/proxy.js";
import { resolveCalledCanonicalId } from "../servers/gateway/peer-exposure.js";
import { SessionManager } from "../servers/gateway/session-manager.js";
import { mountMcpServer } from "../servers/gateway/routes/mcp.js";

const MEM_TOOLS = [
  { name: "crow_store_memory", description: "store", inputSchema: { type: "object", properties: { content: { type: "string" } } } },
  { name: "crow_search_memories", description: "search", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
];

function stubClient(label, calls) {
  return { async callTool({ name }) { calls.push(`${label}:${name}`); return { content: [{ type: "text", text: label }] }; } };
}

function peer(id, calls = []) {
  return [`instance-${id}`, {
    client: stubClient(id, calls), tools: MEM_TOOLS, status: "connected",
    isRemote: true, instanceId: id, instanceName: id, gatewayUrl: "http://127.0.0.1:9", hostname: id,
  }];
}

function local(id, tools, calls = []) {
  return [id, { client: stubClient(id, calls), tools, status: "connected" }];
}

const registered = (srv) => Object.keys(srv._registeredTools || {}).sort();

afterEach(() => { connectedServers.clear(); });

test("one local source + two peers sharing tool names: no throw, only local tools exposed", () => {
  for (const [k, v] of [local("brave-search", [{ name: "brave_web_search", inputSchema: { type: "object" } }]), peer("p1"), peer("p2")]) connectedServers.set(k, v);
  let srv;
  assert.doesNotThrow(() => { srv = createProxyServer(); });
  assert.deepEqual(registered(srv), ["brave_web_search"]);
});

test("a single peer's memory tools do not appear under the bare local names", () => {
  for (const [k, v] of [local("brave-search", [{ name: "brave_web_search", inputSchema: { type: "object" } }]), peer("p1")]) connectedServers.set(k, v);
  const names = registered(createProxyServer());
  assert.ok(!names.includes("crow_store_memory"), "peer crow_store_memory must not be exposed");
  assert.ok(!names.includes("crow_search_memories"));
});

test("a client filter cannot opt a peer back in (allowSources naming the instance key)", () => {
  for (const [k, v] of [peer("p1")]) connectedServers.set(k, v);
  assert.deepEqual(registered(createProxyServer({ allowSources: ["instance-p1"] })), []);
});

test("two LOCAL sources sharing a tool name: no throw, the first is kept, one warning", () => {
  const calls = [];
  for (const [k, v] of [
    local("src-a", [{ name: "dup_tool", inputSchema: { type: "object" } }, { name: "a_only", inputSchema: { type: "object" } }], calls),
    local("src-b", [{ name: "dup_tool", inputSchema: { type: "object" } }, { name: "b_only", inputSchema: { type: "object" } }], calls),
  ]) connectedServers.set(k, v);
  const warns = [];
  const warn = console.warn; console.warn = (...a) => { warns.push(a.join(" ")); };
  let s1, s2;
  try {
    s1 = createProxyServer();
    s2 = createProxyServer(); // second session: no second warning for the same clash
  } finally { console.warn = warn; }
  assert.deepEqual(registered(s1), ["a_only", "b_only", "dup_tool"]);
  assert.deepEqual(registered(s2), ["a_only", "b_only", "dup_tool"]);
  const clash = warns.filter((w) => w.includes("dup_tool"));
  assert.equal(clash.length, 1, "warned once per process for one clash: " + JSON.stringify(warns));
  assert.match(clash[0], /src-a/);
  assert.match(clash[0], /src-b/);
});

test("over HTTP: /tools/mcp initializes (200) with two peers and lists no peer tool", async () => {
  const peerCalls = [];
  for (const [k, v] of [local("brave-search", [{ name: "brave_web_search", inputSchema: { type: "object" } }]), peer("p1", peerCalls), peer("p2", peerCalls)]) connectedServers.set(k, v);
  const app = express(); app.use(express.json());
  mountMcpServer(app, "/tools", createProxyServer, new SessionManager(), (_q, _s, n) => n());
  const http = app.listen(0, "127.0.0.1"); await new Promise((r) => http.once("listening", r));
  const url = new URL(`http://127.0.0.1:${http.address().port}/tools/mcp`);
  const client = new Client({ name: "t", version: "0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(url));
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), ["brave_web_search"]);
    const r = await client.callTool({ name: "crow_store_memory", arguments: { content: "x" } }).catch((e) => ({ thrown: e.message }));
    assert.ok(r.thrown || r.isError, "the bare memory name is not a /tools tool");
    assert.deepEqual(peerCalls, [], "no call reached a peer");
  } finally {
    await client.close().catch(() => {});
    await new Promise((r) => http.close(r));
  }
});

// The peer-invocation gate resolves /tools calls against connectedServers. It
// must see the same surface createProxyServer exposes: never a peer entry, and
// never an ambiguous name (which source runs depends on iteration order).
test("peer gate: /tools resolution ignores peer entries and denies an ambiguous name", () => {
  const body = (name) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } });
  const m = new Map([
    peer("p1"),
    local("texas-gov-data", [{ name: "tx_query" }, { name: "dup_tool" }]),
    local("trello", [{ name: "add_card" }, { name: "dup_tool" }]),
  ]);
  assert.equal(resolveCalledCanonicalId("/tools", body("crow_store_memory"), m), null, "a peer's tool resolves to nothing (deny)");
  assert.equal(resolveCalledCanonicalId("/tools", body("tx_query"), m), "texas-gov-data");
  assert.equal(resolveCalledCanonicalId("/tools-readonly", body("add_card"), m), "trello");
  assert.equal(resolveCalledCanonicalId("/tools", body("dup_tool"), m), null, "ambiguous → fail closed");
  assert.equal(resolveCalledCanonicalId("/router", { method: "tools/call", params: { name: "crow_tools", arguments: { action: "dup_tool" } } }, m), null);
  assert.equal(resolveCalledCanonicalId("/router", { method: "tools/call", params: { name: "crow_tools", arguments: { action: "crow_store_memory" } } }, m), null);
});
