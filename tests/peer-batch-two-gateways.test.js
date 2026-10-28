/**
 * Two REAL paired gateways (tests/fixtures/peer-pair.mjs): a paired instance
 * may send one plain JSON-RPC object per MCP POST. A JSON-RPC batch from a
 * peer is refused at the exposure gate on /router/mcp and on /tools/mcp, and
 * none of its calls run. Positive control first: the same peer's single call
 * to an exposed tool runs on both mounts.
 *
 * The side effect is a marker file written by a stub stdio add-on that A's
 * proxy connects at boot: "pt-open" (exposed) and "pt-closed" (not exposed).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { bootPair, until, REPO } from "./fixtures/peer-pair.mjs";

const T = { timeout: 300_000 };
const sdk = (p) => JSON.stringify(new URL(`node_modules/@modelcontextprotocol/sdk/dist/esm/server/${p}`, `file://${REPO}`).href);

const STUB = `
const { McpServer } = await import(${sdk("mcp.js")});
const { StdioServerTransport } = await import(${sdk("stdio.js")});
const { z } = await import(${JSON.stringify(new URL("node_modules/zod/index.js", `file://${REPO}`).href)});
const { writeFileSync } = await import("node:fs");
const { join } = await import("node:path");
const server = new McpServer({ name: process.env.PT_TOOL, version: "0.0.1" });
server.registerTool(process.env.PT_TOOL, { description: "writes a marker file", inputSchema: { marker: z.string() } }, async (args) => {
  const marker = String(args?.marker || "none").replace(/[^a-z0-9-]/gi, "");
  writeFileSync(join(process.env.PT_DIR, marker), "ran");
  return { content: [{ type: "text", text: "ran " + marker }] };
});
await server.connect(new StdioServerTransport());
`;

async function mcpSession(from, to, mount) {
  const url = `${await to.urlFor(from)}${mount}/mcp`;
  const base = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${from.tokens()[to.id].auth_token}` };
  const init = await fetch(url, { method: "POST", headers: base, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "pt-batch", version: "1" } } }) });
  await init.text();
  assert.equal(init.status, 200, `positive control: peer initialize on ${mount}`);
  const headers = { ...base, "mcp-session-id": init.headers.get("mcp-session-id") };
  await (await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) })).text();
  return async (body) => {
    const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    return { status: r.status, text: await r.text() };
  };
}

const call = (id, name, args) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

test("a paired peer's JSON-RPC batch is refused on /router and /tools and runs nothing; its single exposed call runs", T, async () => {
  const { A, B, cleanup } = await bootPair({ sameIdentity: false });
  try {
    const marks = join(A.dir, "marks");
    mkdirSync(marks, { recursive: true });
    const stubPath = join(A.dir, "pt-stub.mjs");
    writeFileSync(stubPath, STUB);
    const addon = (tool) => ({ command: "node", args: [stubPath], cwd: A.dir, env: { PT_TOOL: tool, PT_DIR: marks } });
    writeFileSync(join(A.dir, "mcp-addons.json"), JSON.stringify({ "pt-open": addon("open_touch"), "pt-closed": addon("closed_touch") }));
    A.sql("INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('remote_exposed_tools', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify(["pt-open"])]);
    await A.boot();

    // The proxy binds its tool list at session start: poll with fresh sessions.
    assert.equal(await until(async () => {
      const r = await (await mcpSession(B, A, "/tools"))({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      return /open_touch/.test(r.text) && /closed_touch/.test(r.text);
    }, 60_000, 500), true, `positive control: both stub add-ons are connected on A\n${A.log.slice(-3000)}`);
    const toolsPost = await mcpSession(B, A, "/tools");
    const routerPost = await mcpSession(B, A, "/router");

    // Positive controls: the same peer's single exposed call runs on both mounts.
    const okT = await toolsPost(call(3, "open_touch", { marker: "ok-tools" }));
    assert.equal(okT.status, 200, okT.text);
    assert.equal(existsSync(join(marks, "ok-tools")), true, `the exposed tool ran via /tools: ${okT.text} ${readdirSync(marks)}`);
    const okR = await routerPost(call(3, "crow_tools", { action: "open_touch", params: { marker: "ok-router" } }));
    assert.equal(okR.status, 200, okR.text);
    assert.equal(existsSync(join(marks, "ok-router")), true, "the exposed tool ran via /router");

    // Control: a single call to the unexposed tool is denied (and does not run).
    const noT = await toolsPost(call(4, "closed_touch", { marker: "single-tools" }));
    assert.equal(noT.status, 403, noT.text);

    // Batches: refused, nothing runs, refusal audited.
    const bT = await toolsPost([call(5, "closed_touch", { marker: "batch-tools" })]);
    assert.equal(bT.status, 403, bT.text);
    assert.equal(JSON.parse(bT.text).jsonrpc, "2.0");
    assert.equal(A.audit(B.id)?.error, "not_single_request");
    const bR = await routerPost([call(5, "crow_tools", { action: "closed_touch", params: { marker: "batch-router" } })]);
    assert.equal(bR.status, 403, bR.text);
    assert.equal(A.audit(B.id)?.error, "not_single_request");
    const bOnlyList = await routerPost([{ jsonrpc: "2.0", id: 6, method: "tools/list", params: {} }]);
    assert.equal(bOnlyList.status, 403, "a peer batch with no tools/call is refused too");

    await new Promise((r) => setTimeout(r, 1_000));
    for (const m of ["single-tools", "batch-tools", "batch-router"]) {
      assert.equal(existsSync(join(marks, m)), false, `${m}: the unexposed tool did not run`);
    }
  } finally { await cleanup(); }
});
