/**
 * Queue item 35: for a given bot, the tools array Crow sends is byte-identical
 * across turns and spawns unless the SET of granted tools really changes.
 *
 * Why it matters: some serving engines render the tool block before the
 * system message, so an identical tools array is a cross-conversation prefix
 * cache (a ~63k-token, 327-tool surface measured at ~1 s time-to-first-token
 * cached vs ~45 s uncached). A reorder of the same set used to miss it:
 *   - pi sends tools in the order of the pinned `--tools` csv, which followed
 *     the stored def's order, and Bot Builder moves a re-moded source's block
 *     to the end of `crow_mcp` (applySourceModes);
 *   - the gateway's connectedServers Map fills in connect-COMPLETION order
 *     (built-in integrations connect in parallel), and getChatTools /
 *     createProxyServer serialized it in that order.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { buildToolsCsv, PiRpc } = await import("../scripts/pi-bots/bridge.mjs");
const { applySourceModes } = await import("../servers/gateway/dashboard/panels/bot-builder/def-adapter.js");
const { getChatTools } = await import("../servers/gateway/ai/tool-executor.js");
const { connectedServers, createProxyServer } = await import("../servers/gateway/proxy.js");
const { countCsvTools } = await import("../scripts/pi-bots/tool-budget.mjs");

const RESOLVED = { provider: "stub", model: "stub", key: "stub/stub" };
const MCP = [
  "crow-memory/crow_store_memory", "crow-memory/crow_search_memories",
  "board/board_list_items", "board/board_get_item",
  "tasks/tasks_list", "brave-search/brave_web_search",
];
const shuffled = (a) => [a[3], a[0], a[5], a[2], a[4], a[1], ...a.slice(6)];

// ---------------------------------------------------------------- pi path

test("same tool SET in a different def order → byte-identical --tools csv", () => {
  const a = { tools: { pi_builtin: ["read", "grep", "ls"], crow_mcp: MCP } };
  const b = { tools: { pi_builtin: ["ls", "read", "grep"], crow_mcp: shuffled(MCP) } };
  const ca = buildToolsCsv(a, { resolved: RESOLVED }).csv;
  const cb = buildToolsCsv(b, { resolved: RESOLVED }).csv;
  assert.equal(ca, cb);
  // builtins first, then mcp__ names, each group in code-unit order
  assert.equal(ca, "grep,ls,read," +
    "mcp__board__board_get_item,mcp__board__board_list_items,mcp__brave-search__brave_web_search," +
    "mcp__crow-memory__crow_search_memories,mcp__crow-memory__crow_store_memory,mcp__tasks__tasks_list");
});

test("two builds of the same bot are byte-identical (and the same as a fresh build)", () => {
  const def = { tools: { pi_builtin: ["bash", "read"], crow_mcp: shuffled(MCP) } };
  const one = buildToolsCsv(def, { resolved: RESOLVED, interactive: true }).csv;
  const two = buildToolsCsv(JSON.parse(JSON.stringify(def)), { resolved: RESOLVED, interactive: true }).csv;
  assert.equal(one, two);
});

test("the tool-budget count is unchanged by canonical ordering (duplicates kept)", () => {
  const def = { tools: { pi_builtin: ["read"], crow_mcp: [...MCP, MCP[0]] } };
  const csv = buildToolsCsv(def, { resolved: RESOLVED }).csv;
  assert.equal(countCsvTools(csv), 1 + MCP.length + 1);
});

test("code-unit order, not locale order; blanks dropped; count unchanged", () => {
  const def = { tools: { pi_builtin: ["read", "", "Bash"], crow_mcp: ["b_x/t", "b-x/t", "B/t", "a/Z", "a/z", "a/z"] } };
  const csv = buildToolsCsv(def, { resolved: RESOLVED }).csv;
  assert.equal(csv, "Bash,read,mcp__B__t,mcp__a__Z,mcp__a__z,mcp__a__z,mcp__b-x__t,mcp__b_x__t");
  const unsorted = ["read", "Bash", ...def.tools.crow_mcp].length;
  assert.equal(countCsvTools(csv), unsorted, "the budget counts the same entries");
});

test("interactive = channel csv + fixed tail, so the channel array stays a prefix", () => {
  const def = { tools: { pi_builtin: ["read"], crow_mcp: shuffled(MCP) } };
  const channel = buildToolsCsv(def, { resolved: RESOLVED }).csv;
  const perch = buildToolsCsv(def, { resolved: RESOLVED, interactive: true }).csv;
  assert.equal(perch, channel + ",ask_user,send_user_file");
});

test("the subagent append stays after the sorted envelope", () => {
  const def = { tools: { pi_builtin: ["read"], crow_mcp: ["tasks/tasks_list"] }, permission_policy: { multi_agent: true } };
  const resolved = { provider: "alibaba-coding", model: "qwen3.6-plus", key: "alibaba-coding/qwen3.6-plus" };
  const { csv, maCapable } = buildToolsCsv(def, { resolved, interactive: true });
  assert.equal(maCapable, true);
  assert.equal(csv, "read,mcp__tasks__tasks_list,subagent,ask_user,send_user_file");
});

test("narrowing still only removes, and keeps the canonical order", () => {
  const def = { tools: { pi_builtin: ["read", "bash"], crow_mcp: shuffled(MCP) } };
  const csv = buildToolsCsv(def, {
    resolved: RESOLVED, interactive: true,
    narrowedTools: JSON.stringify(["bash", "mcp__board__board_get_item", "ask_user"]),
  }).csv;
  assert.equal(csv, "read," +
    "mcp__board__board_list_items,mcp__brave-search__brave_web_search," +
    "mcp__crow-memory__crow_search_memories,mcp__crow-memory__crow_store_memory,mcp__tasks__tasks_list," +
    "send_user_file");
});

test("remote capability entries are ordered by name too", () => {
  const def = { tools: { pi_builtin: [], crow_mcp: ["tasks/tasks_list"], remote_mcp: ["bbbbbbbb-2::memory", "aaaaaaaa-1::projects"] } };
  const flipped = { tools: { ...def.tools, remote_mcp: [...def.tools.remote_mcp].reverse() } };
  const a = buildToolsCsv(def, { resolved: RESOLVED, remoteEnabled: true }).csv;
  assert.equal(a, buildToolsCsv(flipped, { resolved: RESOLVED, remoteEnabled: true }).csv);
  assert.equal(a, "mcp__crow-remote-aaaaaaaa-projects,mcp__crow-remote-bbbbbbbb-memory,mcp__tasks__tasks_list");
});

test("a Bot Builder source round trip (off, then all again) pins the same --tools", () => {
  const catalog = {
    a: [{ name: "a1", access: "read" }, { name: "a2", access: "write" }],
    b: [{ name: "b1", access: "read" }, { name: "b2", access: "write" }],
    c: [{ name: "c1", access: "read" }],
  };
  const start = ["a/a1", "a/a2", "b/b1", "b/b2", "c/c1"];
  const off = applySourceModes(start, catalog, { b: { mode: "off", was: "all", custom: [] } });
  const back = applySourceModes(off, catalog, { b: { mode: "all", was: "off", custom: [] } });
  assert.notDeepEqual(back, start, "precondition: the stored def order really moves");
  const csv = (crow_mcp) => buildToolsCsv({ tools: { pi_builtin: ["read"], crow_mcp } }, { resolved: RESOLVED }).csv;
  assert.equal(csv(back), csv(start));
});

/** Spawn PiRpc against a stub that dumps argv; return the --tools value pi got. */
async function pinnedTools(def) {
  const scratch = mkdtempSync(join(tmpdir(), "crow-stable-tools-"));
  mkdirSync(join(scratch, "sessions"), { recursive: true });
  const out = join(scratch, "argv.json");
  const stub = join(scratch, "stub-pi.mjs");
  writeFileSync(stub,
    'import { writeFileSync } from "node:fs";\n' +
    'writeFileSync(process.env.CROW_TEST_ARGV_OUT, JSON.stringify(process.argv.slice(2)));\n' +
    'process.exit(0);\n');
  const pi = new PiRpc({
    def, sessionDir: scratch, resolved: RESOLVED, nodeBin: process.execPath, cliPath: stub,
    extraEnv: { CROW_TEST_ARGV_OUT: out },
  });
  for (let i = 0; i < 100 && !existsSync(out); i++) await new Promise((r) => setTimeout(r, 50));
  try { pi.close(); } catch { /* already exited */ }
  assert.ok(existsSync(out), "stub pi never recorded its argv");
  const argv = JSON.parse(readFileSync(out, "utf8"));
  rmSync(scratch, { recursive: true, force: true });
  return argv[argv.indexOf("--tools") + 1];
}

test("two real PiRpc spawns of permuted defs pin byte-identical --tools", async () => {
  const a = await pinnedTools({ tools: { pi_builtin: ["read", "ls"], crow_mcp: MCP } });
  const b = await pinnedTools({ tools: { pi_builtin: ["ls", "read"], crow_mcp: shuffled(MCP) } });
  assert.equal(a, b);
  assert.ok(a.startsWith("ls,read,mcp__board__"), a);
});

// ---------------------------------------------------------------- gateway path

const FAKE = {
  "zz-stable-fake-b": [
    { name: "fw_search", description: "search", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
    { name: "fw_play", description: "play", inputSchema: { type: "object", properties: {} } },
    { name: "zz_granular", description: "granular", inputSchema: { type: "object", properties: {} } },
  ],
  "zz-stable-fake-a": [
    { name: "ha_toggle", description: "toggle", inputSchema: { type: "object", properties: { id: { type: "string" } } } },
    { name: "aa_other", description: "other", inputSchema: { type: "object", properties: {} } },
  ],
};

const PEER_TOOLS = [
  { name: "zz_peer_search", description: "peer search", inputSchema: { type: "object", properties: {} } },
  { name: "zz_peer_store", description: "peer store", inputSchema: { type: "object", properties: {} } },
];

/** Run fn with connectedServers holding FAKE in the given id order (tool lists optionally reversed). */
async function withServers(order, reverseTools, fn) {
  const saved = new Map(connectedServers);
  connectedServers.clear();
  try {
    // What prod also holds: a server that failed to connect, and one remote peer
    // entry — inserted first on one side and last on the other.
    const extras = () => {
      connectedServers.set("zz-stable-fake-down", { client: null, tools: [], status: "error", error: "x", isAddon: true });
      connectedServers.set("instance-zzstablepeer", {
        client: { callTool: async () => ({ content: [] }) }, status: "connected", isRemote: true, instanceName: "peer",
        tools: reverseTools ? [...PEER_TOOLS].reverse() : PEER_TOOLS,
      });
    };
    if (reverseTools) extras();
    for (const id of order) {
      const tools = reverseTools ? [...FAKE[id]].reverse() : FAKE[id];
      connectedServers.set(id, { client: { callTool: async () => ({ content: [] }) }, tools, status: "connected", isAddon: true });
    }
    if (!reverseTools) extras();
    return await fn();
  } finally {
    connectedServers.clear();
    for (const [k, v] of saved) connectedServers.set(k, v);
  }
}

const ORDER_1 = ["zz-stable-fake-a", "zz-stable-fake-b"];
const ORDER_2 = ["zz-stable-fake-b", "zz-stable-fake-a"];

test("getChatTools (unbound) is byte-identical whatever order the servers connected in", async () => {
  const one = await withServers(ORDER_1, false, () => JSON.stringify(getChatTools()));
  const two = await withServers(ORDER_2, true, () => JSON.stringify(getChatTools()));
  assert.equal(one, two);
});

test("getChatTools (bound to a bot) is byte-identical whatever order the servers connected in", async () => {
  const botDef = { bot_id: "probe", tools: { crow_mcp: ["memory/crow_store_memory", "zz-stable-fake-b/fw_play", "zz-stable-fake-a/ha_toggle", "zz-stable-fake-b/zz_granular"] } };
  const one = await withServers(ORDER_1, false, () => JSON.stringify(getChatTools({ botDef })));
  const two = await withServers(ORDER_2, true, () => JSON.stringify(getChatTools({ botDef })));
  assert.equal(one, two);
});

test("getChatTools orders cross-instance remote tools by name", async () => {
  const rt = (n) => ({ name: n, description: n, inputSchema: { type: "object", properties: {} } });
  const one = await withServers([], false, () => JSON.stringify(getChatTools({ remoteTools: [rt("r_b"), rt("r_a")] })));
  const two = await withServers([], false, () => JSON.stringify(getChatTools({ remoteTools: [rt("r_a"), rt("r_b")] })));
  assert.equal(one, two);
});

async function proxyToolsList() {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const server = createProxyServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "stable-tools-test", version: "0" });
  await client.connect(ct);
  try { return JSON.stringify((await client.listTools()).tools); }
  finally { await client.close(); await server.close(); }
}

test("/tools/mcp tools/list is byte-identical whatever order the servers connected in", async () => {
  const one = await withServers(ORDER_1, false, proxyToolsList);
  const two = await withServers(ORDER_2, true, proxyToolsList);
  assert.equal(one, two);
});

test("dashboard chat's system prompt lists add-on tools in a stable order", async () => {
  const { generateSystemPrompt } = await import("../servers/gateway/ai/system-prompt.js");
  const addonPart = (p) => p.slice(p.indexOf("## Installed Extension Tools"));
  const one = await withServers(ORDER_1, false, async () => addonPart(await generateSystemPrompt()));
  const two = await withServers(ORDER_2, true, async () => addonPart(await generateSystemPrompt()));
  assert.ok(one.includes("### zz-stable-fake-a"), "the add-on section is present");
  assert.equal(one, two);
});
