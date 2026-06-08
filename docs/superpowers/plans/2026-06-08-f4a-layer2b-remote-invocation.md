# F4a Layer 2b — Cross-instance Tool Invocation (pi-bots) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **RESOURCE NOTE:** crow runs a heavy always-on LLM stack. Execute single-threaded — ONE implementer subagent at a time, NO concurrent fan-out. All tests use stubs/temp dirs; never spawn live peer connections in unit tests. If the build involves heavy fan-out, `docker stop` the model stack first (`vllm-rocm-qwen35-4b llamacpp-vulkan-qwen36-35b-a3b llamacpp-vulkan-qwen3-embed crow-companion faster-whisper-server kokoro-tts`) and `docker start` after.

**Goal:** Let a pi-bot call a tool on a trusted peer (restricted to what the peer exposed via L2a), via a local stdio forward-proxy, gated behind a feature flag that is OFF by default.

**Architecture:** A new stdio MCP server (`crow-remote-proxy.mjs`) bridges pi (stdio — its only proven transport) to a peer's capability mount over authenticated HTTP MCP, reusing `loadRemoteInstances`' client pattern + the `peer-tokens.json` Bearer token. `mcp_writer` mints one forward-proxy block per remote selection (`def.tools.remote_mcp`); the bridge adds the corresponding `--tools` entries; the Bot Builder flips Layer 1's read-only remote group to selectable. Every L2b path is a no-op unless `feature_flags.remote_invocation` is true on the calling instance. The peer's L2a gate is the security boundary.

**Tech Stack:** Node.js ESM, `node:test`, `@modelcontextprotocol/sdk` (server+client transports), `better-sqlite3` (bridge/CLI) + libsql (panel), the existing `peer-credentials.js` / `crow_instances` / `capability-registry` machinery.

**Spec:** `docs/superpowers/specs/2026-06-08-f4a-layer2b-remote-invocation-design.md`

**Conventions (every commit):** `git commit <explicit paths> -m "..."` (never `git add -A` + bare commit — parallel sessions share this tree; `git add` a new file by explicit path first if needed); verify `git show --stat HEAD`; never add Claude as co-author; `git pull --rebase` before push. Branch `feat/f4a-layer2b-remote-invocation` (already created off `main`).

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `scripts/pi-bots/remote-blocks.mjs` | Pure, DB-agnostic: mount map, `remoteServersForBot`, `mintRemoteBlocks`, `parseRemoteInvocationFlag` | Create |
| `tests/remote-blocks.test.js` | parse + mint + flag-parse unit tests | Create |
| `scripts/pi-bots/crow-remote-proxy.mjs` | stdio↔HTTP passthrough to one peer mount | Create |
| `tests/crow-remote-proxy.test.js` | against a stub peer MCP server | Create |
| `scripts/pi-bots/mcp_writer.mjs` | `writeBotMcp` merges remote blocks when `opts.remoteEnabled` | Modify |
| `tests/remote-mcp-writer.test.js` | writeBotMcp remote integration (flag on/off) | Create |
| `scripts/pi-bots/bridge.mjs` | read flag+peer urls (sync); thread into `writeBotMcp` + `toolAllowlist(def,{remoteEnabled})` | Modify |
| `tests/bridge-remote-allowlist.test.js` | `toolAllowlist` gating | Create |
| `servers/gateway/dashboard/settings/sections/remote-invocation.js` | feature-flag toggle (Multi-Instance group) | Create |
| `servers/gateway/dashboard/panels/settings.js` | register the section | Modify |
| `servers/gateway/dashboard/shared/i18n.js` | label | Modify |
| `servers/gateway/dashboard/panels/bot-builder.js` | flip remote group selectable (flag+exposed); persist `remote_mcp` | Modify |

**Reference shapes (verified — read while implementing):**
- `def.tools` JSON: `{ pi_builtin[], crow_mcp[] (each "server" or "server/tool"), pi_extensions[], skills[] }`. L2b ADDS `remote_mcp: ["<instanceId>::<canonicalId>"]`.
- `mcp_writer.writeBotMcp(def, opts)` (`scripts/pi-bots/mcp_writer.mjs:186`): reads canonical `~/.pi/agent/mcp.json` + `<crowHome>/mcp-addons.json` (files only — NO db), writes `<sessionDir>/.mcp.json` (mode 0600). Returns `{ path, servers, warnings, journalGuarded, minted }`. `opts`: `{ sessionDir, canonical, canonicalPath, crowHome, extraServers }`.
- Canonical MCP blocks are **stdio**: `{ command, args[], cwd?, env? }`. Node bin = `/home/kh0pp/.nvm/versions/node/v20.20.2/bin/node` (the `NODE`/`PI_CLI` consts already exist in bridge.mjs; mcp_writer can reuse `process.execPath` or the same node path).
- `getPeerCreds(instanceId)` (`servers/shared/peer-credentials.js:102`) → `{ auth_token, signing_key, ... } | null`; reads `CROW_PEER_TOKENS_PATH` || `~/.crow/peer-tokens.json` (verifies 0600).
- Peer MCP endpoint: `${gateway_url}${mount}/mcp` via `StreamableHTTPClientTransport(new URL(...), { requestInit: { headers: { Authorization: "Bearer "+auth_token } } })` (mirrors `proxy.js` `connectToRemoteInstance`).
- `crow_instances` columns incl. `id`, `gateway_url`, `status` (`scripts/init-db.js:1232`). Peers = `status != 'revoked' AND gateway_url IS NOT NULL`.
- Feature flag: `dashboard_settings` key `feature_flags` (JSON object), local-only (NOT in SYNC_ALLOWLIST). Async read: `readSetting(db,"feature_flags")` → `JSON.parse` → `.remote_invocation === true` (see `smart-router.js:141`, `profiles-tab.js:38`). `readSetting` resolves `dashboard_settings_overrides` (this instance) first, then `dashboard_settings`.
- `getOrCreateLocalInstanceId()` (`servers/gateway/instance-registry.js:340`) — sync; reads `<dataDir>/instance-id`.
- Bridge: `toolAllowlist(def)` (`bridge.mjs:51`) → `[...builtin, ...crow_mcp.map(s=>"mcp__"+s.replace("/","__"))].join(",")`. `writeBotMcp` called at `bridge.mjs:320` with `{ sessionDir, crowHome }`; `CROW_DB = botsDbPath()`; `db(p)` opens better-sqlite3 with `busy_timeout=10000`.
- Bot Builder remote group: `gatherPeerTools(db)` (`bot-builder.js:248`) → `[{ ...catalogTool (canonicalId,category,name,bundleId,toolCount,exposed), instanceId, instanceName }]`; rendered read-only at `bot-builder.js:855-861` (`.btb-remote-caps` `<details>`).

**Two items to verify during the build (spec flagged):**
- pi's `--tools mcp__<server>` server-level-allow semantics. Task 5 includes a verification step; if pi requires explicit `mcp__server__tool`, the bridge expands to the proxy's live tool names (the proxy's `tools/list` is the source). Plan defaults to server-level.
- `getOrCreateLocalInstanceId()` resolving correctly in the bridge process (it uses `CROW_HOME`/`CROW_DB_PATH`); Task 4 smoke confirms.

---

## Task 1: Pure helpers — flag parse, remote-selection parse, block minting

**Files:**
- Create: `scripts/pi-bots/remote-blocks.mjs`
- Test: `tests/remote-blocks.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/remote-blocks.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseRemoteInvocationFlag,
  remoteServersForBot,
  REMOTE_CANON_MOUNT,
  mintRemoteBlocks,
} from "../scripts/pi-bots/remote-blocks.mjs";

test("parseRemoteInvocationFlag: only literal true enables; everything else off", () => {
  assert.equal(parseRemoteInvocationFlag(JSON.stringify({ remote_invocation: true })), true);
  assert.equal(parseRemoteInvocationFlag(JSON.stringify({ remote_invocation: false })), false);
  assert.equal(parseRemoteInvocationFlag(JSON.stringify({ smart_chat: true })), false);
  assert.equal(parseRemoteInvocationFlag("not json"), false);
  assert.equal(parseRemoteInvocationFlag(null), false);
  assert.equal(parseRemoteInvocationFlag(undefined), false);
});

test("remoteServersForBot parses instanceId::canonicalId, drops malformed", () => {
  const def = { tools: { remote_mcp: ["g1::crow-memory", "g1::crow-blog", "bad", "::x", "y::", 5, ""] } };
  assert.deepEqual(remoteServersForBot(def), [
    { instanceId: "g1", canonicalId: "crow-memory" },
    { instanceId: "g1", canonicalId: "crow-blog" },
  ]);
  assert.deepEqual(remoteServersForBot({}), []);
  assert.deepEqual(remoteServersForBot({ tools: {} }), []);
});

test("mount map covers the five core capabilities only", () => {
  assert.equal(REMOTE_CANON_MOUNT["crow-memory"], "/memory");
  assert.equal(REMOTE_CANON_MOUNT["crow-projects"], "/projects");
  assert.equal(REMOTE_CANON_MOUNT["crow-sharing"], "/sharing");
  assert.equal(REMOTE_CANON_MOUNT["crow-storage"], "/storage");
  assert.equal(REMOTE_CANON_MOUNT["crow-blog"], "/blog-mcp");
  assert.equal(REMOTE_CANON_MOUNT["texas-gov-data"], undefined); // addon — deferred
});

test("mintRemoteBlocks mints one stdio block per (instance,capability); token NOT embedded", () => {
  const def = { tools: { remote_mcp: ["abc12345deadbeef::crow-memory"] } };
  const peerGatewayUrls = { "abc12345deadbeef": "https://grackle.example:8444" };
  const { blocks, warnings } = mintRemoteBlocks(def, { peerGatewayUrls, proxyPath: "/repo/scripts/pi-bots/crow-remote-proxy.mjs", node: "/usr/bin/node" });
  const name = "crow-remote-abc12345-crow-memory";
  assert.ok(blocks[name], "block minted under expected name");
  const b = blocks[name];
  assert.equal(b.command, "/usr/bin/node");
  assert.deepEqual(b.args, ["/repo/scripts/pi-bots/crow-remote-proxy.mjs"]);
  assert.equal(b.env.CROW_REMOTE_INSTANCE_ID, "abc12345deadbeef");
  assert.equal(b.env.CROW_REMOTE_GATEWAY_URL, "https://grackle.example:8444");
  assert.equal(b.env.CROW_REMOTE_MOUNT, "/memory");
  // No secret in the block.
  assert.ok(!JSON.stringify(b).includes("auth_token"));
  assert.equal(warnings.length, 0);
});

test("mintRemoteBlocks warns + skips addon caps and unknown peers", () => {
  const def = { tools: { remote_mcp: ["g1::texas-gov-data", "ghost::crow-memory"] } };
  const { blocks, warnings } = mintRemoteBlocks(def, { peerGatewayUrls: { g1: "https://g1:8444" }, proxyPath: "/p.mjs", node: "/n" });
  assert.deepEqual(Object.keys(blocks), []);
  assert.equal(warnings.length, 2);
  assert.ok(warnings.some((w) => w.includes("texas-gov-data") && /addon|core/i.test(w)));
  assert.ok(warnings.some((w) => w.includes("ghost") && /unknown|gateway/i.test(w)));
});

test("server name uses 8-char instance prefix and hyphens (no __)", () => {
  const def = { tools: { remote_mcp: ["0123456789abcdef::crow-storage"] } };
  const { blocks } = mintRemoteBlocks(def, { peerGatewayUrls: { "0123456789abcdef": "https://x:8444" }, proxyPath: "/p", node: "/n" });
  const name = Object.keys(blocks)[0];
  assert.equal(name, "crow-remote-01234567-crow-storage");
  assert.ok(!name.includes("__"));
});
```

- [ ] **Step 2: Run it — expect failure**

Run: `node --test tests/remote-blocks.test.js`
Expected: FAIL — `Cannot find module '../scripts/pi-bots/remote-blocks.mjs'`.

- [ ] **Step 3: Implement `remote-blocks.mjs`**

Create `scripts/pi-bots/remote-blocks.mjs`:

```js
/**
 * F4a Layer 2b — pure helpers for cross-instance tool invocation.
 *
 * DB-AGNOSTIC by design: callers (bridge=better-sqlite3, panel=libsql, CLI)
 * read the feature flag + peer gateway URLs with their own client and pass the
 * results in. This module only parses + mints; it touches no DB and no network.
 * Remote invocation is OFF unless the caller passes a truthy remoteEnabled /
 * non-empty peerGatewayUrls — so any caller that doesn't opt in keeps today's
 * behavior (the flag-off invariant is structural).
 */

/** Core capabilities with a dedicated MCP mount (addons deferred to a later slice). */
export const REMOTE_CANON_MOUNT = {
  "crow-memory": "/memory",
  "crow-projects": "/projects",
  "crow-sharing": "/sharing",
  "crow-storage": "/storage",
  "crow-blog": "/blog-mcp",
};

/** Parse a raw `feature_flags` setting value → is remote_invocation enabled? */
export function parseRemoteInvocationFlag(raw) {
  if (raw == null) return false;
  let flags;
  try { flags = JSON.parse(raw); } catch { return false; }
  return !!flags && flags.remote_invocation === true;
}

/** Parse def.tools.remote_mcp → [{ instanceId, canonicalId }], dropping malformed entries. */
export function remoteServersForBot(def) {
  const sel = (def && def.tools && def.tools.remote_mcp) || [];
  const out = [];
  for (const entry of sel) {
    if (typeof entry !== "string") continue;
    const idx = entry.indexOf("::");
    if (idx <= 0) continue; // need a non-empty instanceId before "::"
    const instanceId = entry.slice(0, idx);
    const canonicalId = entry.slice(idx + 2);
    if (!instanceId || !canonicalId) continue;
    out.push({ instanceId, canonicalId });
  }
  return out;
}

/**
 * Mint per-(instance,capability) stdio forward-proxy blocks for a bot.
 * @param {object} def
 * @param {object} o
 * @param {Record<string,string>} o.peerGatewayUrls  instanceId -> gateway_url (caller-supplied)
 * @param {string} o.proxyPath  absolute path to crow-remote-proxy.mjs
 * @param {string} o.node       absolute node binary
 * @returns {{ blocks: Record<string,object>, warnings: string[] }}
 */
export function mintRemoteBlocks(def, { peerGatewayUrls = {}, proxyPath, node }) {
  const blocks = {};
  const warnings = [];
  for (const { instanceId, canonicalId } of remoteServersForBot(def)) {
    const mount = REMOTE_CANON_MOUNT[canonicalId];
    if (!mount) {
      warnings.push(`remote '${instanceId}::${canonicalId}' skipped — only core capabilities are remotely invocable this slice (addon caps deferred)`);
      continue;
    }
    const gatewayUrl = peerGatewayUrls[instanceId];
    if (!gatewayUrl) {
      warnings.push(`remote '${instanceId}::${canonicalId}' skipped — unknown/revoked peer or no gateway_url for instance '${instanceId}'`);
      continue;
    }
    const name = `crow-remote-${instanceId.slice(0, 8)}-${canonicalId}`;
    blocks[name] = {
      command: node,
      args: [proxyPath],
      env: {
        CROW_REMOTE_INSTANCE_ID: instanceId,
        CROW_REMOTE_GATEWAY_URL: gatewayUrl,
        CROW_REMOTE_MOUNT: mount,
      },
    };
  }
  return { blocks, warnings };
}
```

- [ ] **Step 4: Run it — expect pass**

Run: `node --test tests/remote-blocks.test.js`
Expected: PASS — 6 tests, fail 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/pi-bots/remote-blocks.mjs tests/remote-blocks.test.js
git commit scripts/pi-bots/remote-blocks.mjs tests/remote-blocks.test.js \
  -m "F4a L2b: pure helpers — flag parse, remote-selection parse, forward-proxy block minting"
git show --stat HEAD
```

---

## Task 2: `crow-remote-proxy.mjs` — stdio↔HTTP passthrough

**Files:**
- Create: `scripts/pi-bots/crow-remote-proxy.mjs`
- Test: `tests/crow-remote-proxy.test.js`

**Approach:** A standalone stdio MCP server. On startup it connects an MCP `Client` (`StreamableHTTPClientTransport`) to `${CROW_REMOTE_GATEWAY_URL}${CROW_REMOTE_MOUNT}/mcp` with the Bearer peer token from `getPeerCreds(CROW_REMOTE_INSTANCE_ID)`, lists the peer's tools, registers each as a passthrough on an `McpServer`, and connects that server to a `StdioServerTransport`. On connect failure it serves an empty tool list (pi gets nothing remote; never crashes). To keep it unit-testable, the connection logic is a function `buildRemoteProxyServer({ clientFactory })` that takes an injectable client factory (real = StreamableHTTP; test = stub).

- [ ] **Step 1: Write the failing test**

Create `tests/crow-remote-proxy.test.js`:

```js
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
```

- [ ] **Step 2: Run it — expect failure**

Run: `node --test tests/crow-remote-proxy.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `crow-remote-proxy.mjs`**

Create `scripts/pi-bots/crow-remote-proxy.mjs`:

```js
#!/usr/bin/env node
/**
 * F4a Layer 2b — cross-instance forward-proxy (stdio MCP server).
 *
 * pi spawns this as a stdio MCP server (its only proven transport). It connects
 * an MCP client to ONE peer capability mount (CROW_REMOTE_GATEWAY_URL +
 * CROW_REMOTE_MOUNT + /mcp) using the Bearer peer token from peer-tokens.json,
 * and passes tools/list + tools/call through verbatim. It carries NO policy:
 * the peer's L2a exposure gate is the authoritative allow/deny. On any connect
 * failure it serves an empty tool list so a turn never crashes.
 *
 * Reuses the auth pattern from servers/gateway/proxy.js connectToRemoteInstance.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getPeerCreds } from "../../servers/shared/peer-credentials.js";

const CONNECT_TIMEOUT_MS = 15000;

/** Real client factory: authenticated StreamableHTTP client to the peer mount. */
async function defaultClientFactory() {
  const instanceId = process.env.CROW_REMOTE_INSTANCE_ID;
  const gatewayUrl = (process.env.CROW_REMOTE_GATEWAY_URL || "").replace(/\/$/, "");
  const mount = process.env.CROW_REMOTE_MOUNT || "";
  if (!instanceId || !gatewayUrl || !mount) throw new Error("crow-remote-proxy: missing CROW_REMOTE_* env");
  const creds = getPeerCreds(instanceId);
  if (!creds || !creds.auth_token) throw new Error(`crow-remote-proxy: no peer token for ${instanceId}`);
  const url = new URL(`${gatewayUrl}${mount}/mcp`);
  const requestInit = { headers: { Authorization: `Bearer ${creds.auth_token}` } };
  const transport = new StreamableHTTPClientTransport(url, { requestInit });
  const client = new Client({ name: "crow-remote-proxy", version: "0.1.0" });
  await Promise.race([
    client.connect(transport),
    new Promise((_, rej) => setTimeout(() => rej(new Error("connect timeout")), CONNECT_TIMEOUT_MS)),
  ]);
  return client;
}

/**
 * Build the passthrough server. Returns { server, listTools, callTool } where
 * listTools/callTool are the testable passthrough primitives. On connect
 * failure, listTools yields { tools: [] } and callTool rejects with a clear
 * error (no peer to forward to).
 * @param {object} [opts]
 * @param {Function} [opts.clientFactory] async () => MCP client (injectable for tests)
 */
export async function buildRemoteProxyServer({ clientFactory = defaultClientFactory } = {}) {
  let client = null;
  let connectError = null;
  try { client = await clientFactory(); }
  catch (err) { connectError = err; console.error("[crow-remote-proxy] connect failed:", err.message); }

  const listTools = async () => {
    if (!client) return { tools: [] };
    try { return await client.listTools(); }
    catch (err) { console.error("[crow-remote-proxy] listTools failed:", err.message); return { tools: [] }; }
  };
  const callTool = async (params) => {
    if (!client) throw new Error("crow-remote-proxy: peer unavailable" + (connectError ? ` (${connectError.message})` : ""));
    return client.callTool(params); // forward verbatim; peer L2a gate decides
  };

  // Register a passthrough McpServer that mirrors the peer's tools.
  const server = new McpServer({ name: "crow-remote-proxy", version: "0.1.0" });
  const { tools } = await listTools();
  for (const t of tools) {
    server.tool(t.name, t.description || "", t.inputSchema?.properties || {}, async (args) => {
      const r = await callTool({ name: t.name, arguments: args || {} });
      return r;
    });
  }
  return { server, listTools, callTool };
}

// CLI entrypoint: connect to the peer and serve over stdio.
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const { server } = await buildRemoteProxyServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
  })().catch((err) => { console.error("[crow-remote-proxy] fatal:", err.message); process.exit(1); });
}
```

- [ ] **Step 4: Run it — expect pass**

Run: `node --test tests/crow-remote-proxy.test.js`
Expected: PASS — 4 tests, fail 0.

- [ ] **Step 5: Syntax check the CLI path + confirm SDK import paths resolve**

```bash
node --check scripts/pi-bots/crow-remote-proxy.mjs
node --input-type=module -e "import('./scripts/pi-bots/crow-remote-proxy.mjs').then(()=>console.log('module loads + SDK + peer-credentials imports resolve'))"
```
Expected: exit 0; the load line prints. (If `@modelcontextprotocol/sdk/server/mcp.js` is the wrong subpath, find the correct one with `ls node_modules/@modelcontextprotocol/sdk/dist/esm/server/` and fix the import — `mcp.js` exports `McpServer`; confirm against how `servers/gateway/router.js` imports `McpServer`.)

- [ ] **Step 6: Commit**

```bash
git add scripts/pi-bots/crow-remote-proxy.mjs tests/crow-remote-proxy.test.js
git commit scripts/pi-bots/crow-remote-proxy.mjs tests/crow-remote-proxy.test.js \
  -m "F4a L2b: crow-remote-proxy — stdio MCP passthrough to a peer capability mount"
git show --stat HEAD
```

---

## Task 3: `mcp_writer` — merge remote blocks when `opts.remoteEnabled`

**Files:**
- Modify: `scripts/pi-bots/mcp_writer.mjs`
- Test: `tests/remote-mcp-writer.test.js`

**Context:** `writeBotMcp` stays DB-agnostic (files only). It gains `opts.remoteEnabled` (bool) + `opts.peerGatewayUrls` (map). When `remoteEnabled`, it mints remote blocks (Task 1) and merges them into the written `.mcp.json`. Default `remoteEnabled=false` ⇒ existing callers are unchanged (the flag-off invariant). Remote block names are `crow-remote-*` (reserved prefix) so they never collide with canonical/addon names.

- [ ] **Step 1: Write the failing test**

Create `tests/remote-mcp-writer.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeBotMcp } from "../scripts/pi-bots/mcp_writer.mjs";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "l2b-"));
  const sessionDir = join(dir, "session");
  mkdirSync(sessionDir, { recursive: true });
  const canonicalPath = join(dir, "canonical.json");
  writeFileSync(canonicalPath, JSON.stringify({ mcpServers: {
    "crow-memory": { command: "/n", args: ["servers/memory/index.js"], env: { CROW_DB_PATH: "/db" } },
  } }));
  return { dir, sessionDir, canonicalPath };
}

test("flag OFF (default): no remote blocks even when remote_mcp is set", () => {
  const { sessionDir, canonicalPath } = fixture();
  const def = { tools: { crow_mcp: ["crow-memory"], remote_mcp: ["g1::crow-memory"] } };
  writeBotMcp(def, { sessionDir, canonicalPath, crowHome: "/tmp/none" });
  const written = JSON.parse(readFileSync(join(sessionDir, ".mcp.json"), "utf8"));
  assert.ok(written.mcpServers["crow-memory"], "local server present");
  assert.ok(!Object.keys(written.mcpServers).some((k) => k.startsWith("crow-remote-")), "NO remote blocks when flag off");
});

test("flag ON: mints the forward-proxy block alongside local servers", () => {
  const { sessionDir, canonicalPath } = fixture();
  const def = { tools: { crow_mcp: ["crow-memory"], remote_mcp: ["g1abcdef::crow-memory"] } };
  const res = writeBotMcp(def, {
    sessionDir, canonicalPath, crowHome: "/tmp/none",
    remoteEnabled: true,
    peerGatewayUrls: { g1abcdef: "https://g1:8444" },
  });
  const written = JSON.parse(readFileSync(join(sessionDir, ".mcp.json"), "utf8"));
  assert.ok(written.mcpServers["crow-memory"], "local server still present");
  const remote = written.mcpServers["crow-remote-g1abcdef-crow-memory"];
  assert.ok(remote, "remote forward-proxy block minted");
  assert.equal(remote.env.CROW_REMOTE_GATEWAY_URL, "https://g1:8444");
  assert.equal(remote.env.CROW_REMOTE_MOUNT, "/memory");
  assert.ok(Array.isArray(res.remoteWarnings));
});

test("flag ON but addon cap → warning, no block", () => {
  const { sessionDir, canonicalPath } = fixture();
  const def = { tools: { remote_mcp: ["g1::texas-gov-data"] } };
  const res = writeBotMcp(def, { sessionDir, canonicalPath, crowHome: "/tmp/none", remoteEnabled: true, peerGatewayUrls: { g1: "https://g1:8444" } });
  const written = JSON.parse(readFileSync(join(sessionDir, ".mcp.json"), "utf8"));
  assert.ok(!Object.keys(written.mcpServers).some((k) => k.startsWith("crow-remote-")));
  assert.ok(res.remoteWarnings.some((w) => w.includes("texas-gov-data")));
});
```

- [ ] **Step 2: Run it — expect failure**

Run: `node --test tests/remote-mcp-writer.test.js`
Expected: FAIL — flag-on test fails (no remote block minted yet); the flag-off test may already pass.

- [ ] **Step 3: Wire `mintRemoteBlocks` into `writeBotMcp`**

In `scripts/pi-bots/mcp_writer.mjs`:

(a) Add the import near the top (after the existing imports):
```js
import { mintRemoteBlocks } from "./remote-blocks.mjs";
```

(b) In `writeBotMcp(def, opts = {})`, after the existing `const built = buildBotMcp(...)` line and before `mkdirSync(sessionDir, ...)`, merge remote blocks when enabled:
```js
  // F4a L2b: merge cross-instance forward-proxy blocks when the caller has
  // confirmed feature_flags.remote_invocation is on (DB read done by the
  // caller — bridge/panel/CLI — since this module is DB-agnostic). Default
  // off: callers that don't pass remoteEnabled get byte-identical output.
  let remoteWarnings = [];
  if (opts.remoteEnabled) {
    const node = opts.node || process.execPath;
    const proxyPath = opts.proxyPath || join(import.meta.dirname, "crow-remote-proxy.mjs");
    const { blocks, warnings } = mintRemoteBlocks(def, {
      peerGatewayUrls: opts.peerGatewayUrls || {},
      proxyPath,
      node,
    });
    remoteWarnings = warnings;
    for (const [name, block] of Object.entries(blocks)) built.json.mcpServers[name] = block;
  }
```
(`join` and `import.meta.dirname` — `join` is already imported; `import.meta.dirname` is available in this ESM module on Node 20.)

(c) Add `remoteWarnings` to the returned object:
```js
  return {
    path,
    servers: built.servers,
    warnings: built.warnings,
    journalGuarded: built.journalGuarded,
    minted: built.minted,
    remoteWarnings,
  };
```

- [ ] **Step 4: Run it — expect pass**

Run: `node --test tests/remote-mcp-writer.test.js`
Expected: PASS — 3 tests. Also re-run the writer's existing behavior is intact: `node --test tests/remote-blocks.test.js` (still green).

- [ ] **Step 5: Commit**

```bash
git commit scripts/pi-bots/mcp_writer.mjs tests/remote-mcp-writer.test.js \
  -m "F4a L2b: writeBotMcp merges forward-proxy blocks when remoteEnabled (default off)"
git show --stat HEAD
```

---

## Task 4: Bridge — read flag + peer URLs (sync), thread into spawn

**Files:**
- Modify: `scripts/pi-bots/bridge.mjs`
- Test: `tests/bridge-remote-allowlist.test.js`

**Context:** The bridge spawns pi per turn (`better-sqlite3`, `CROW_DB = botsDbPath()`). It must (1) read `feature_flags.remote_invocation` with scope resolution, (2) query peer gateway URLs, (3) pass `remoteEnabled` + `peerGatewayUrls` to `writeBotMcp` (Task 3), and (4) add remote `--tools` entries via `toolAllowlist(def, { remoteEnabled })`. `toolAllowlist` must become testable in isolation.

- [ ] **Step 1: Write the failing test for `toolAllowlist`**

Create `tests/bridge-remote-allowlist.test.js`:

```js
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
```

- [ ] **Step 2: Run it — expect failure**

Run: `node --test tests/bridge-remote-allowlist.test.js`
Expected: FAIL — `toolAllowlist` is not exported, and/or ignores remote entries.

- [ ] **Step 3: Make `toolAllowlist` exported + remote-aware**

In `scripts/pi-bots/bridge.mjs`, replace the existing `toolAllowlist`:
```js
function toolAllowlist(def) {
  const builtin = (def.tools && def.tools.pi_builtin) || [];
  const mcp = ((def.tools && def.tools.crow_mcp) || []).map((s) => "mcp__" + s.replace("/", "__"));
  return [...builtin, ...mcp].join(",");
}
```
with (add the import of `remoteServersForBot` at the top with the other imports — `import { remoteServersForBot } from "./remote-blocks.mjs";`):
```js
export function toolAllowlist(def, { remoteEnabled = false } = {}) {
  const builtin = (def.tools && def.tools.pi_builtin) || [];
  const mcp = ((def.tools && def.tools.crow_mcp) || []).map((s) => "mcp__" + s.replace("/", "__"));
  const out = [...builtin, ...mcp];
  if (remoteEnabled) {
    // Server-level allow per remote capability (= all that capability's tools;
    // the peer's L2a gate is the per-call enforcement). Block names mirror
    // mintRemoteBlocks: crow-remote-<instanceId8>-<canonicalId>.
    for (const { instanceId, canonicalId } of remoteServersForBot(def)) {
      out.push(`mcp__crow-remote-${instanceId.slice(0, 8)}-${canonicalId}`);
    }
  }
  return out.join(",");
}
```

- [ ] **Step 4: Run it — expect pass**

Run: `node --test tests/bridge-remote-allowlist.test.js`
Expected: PASS — 3 tests.

- [ ] **Step 5: Add the sync flag + peer-URL reads and thread them into the spawn path**

In `scripts/pi-bots/bridge.mjs`:

(a) Add imports (top, with the others):
```js
import { parseRemoteInvocationFlag } from "./remote-blocks.mjs";
import { getOrCreateLocalInstanceId } from "../../servers/gateway/instance-registry.js";
```

(b) Add two sync helpers (module scope, near `toolAllowlist`):
```js
// F4a L2b: read feature_flags.remote_invocation with the same scope resolution
// as readSetting (this-instance override first, then global), synchronously
// over better-sqlite3. Local-only flag; default off. Never throws.
export function readRemoteInvocationEnabled(conn) {
  try {
    let localId = null;
    try { localId = getOrCreateLocalInstanceId(); } catch {}
    let row = null;
    if (localId) {
      row = conn.prepare("SELECT value FROM dashboard_settings_overrides WHERE key='feature_flags' AND instance_id=?").get(localId);
    }
    if (!row) row = conn.prepare("SELECT value FROM dashboard_settings WHERE key='feature_flags'").get();
    return parseRemoteInvocationFlag(row ? row.value : null);
  } catch { return false; }
}

// instanceId -> gateway_url for trusted, non-revoked peers with a URL.
export function readPeerGatewayUrls(conn) {
  try {
    const rows = conn.prepare("SELECT id, gateway_url FROM crow_instances WHERE status != 'revoked' AND gateway_url IS NOT NULL").all();
    const map = {};
    for (const r of rows) map[r.id] = r.gateway_url;
    return map;
  } catch { return {}; }
}
```

(c) At the spawn site (the `writeBotMcp(def, { sessionDir, crowHome })` call ~`:320` and where `toolAllowlist(def)` is used inside `PiRpc` constructor): compute the flag + peer URLs once and pass them through. Concretely:
- Where the bridge opens `CROW_DB` and builds the spawn (the function that calls `writeBotMcp` at ~:320), add before the `writeBotMcp` call:
```js
    const _conn = db(CROW_DB);
    let remoteEnabled = false, peerGatewayUrls = {};
    try {
      remoteEnabled = readRemoteInvocationEnabled(_conn);
      if (remoteEnabled) peerGatewayUrls = readPeerGatewayUrls(_conn);
    } finally { _conn.close(); }
```
- Change the `writeBotMcp` call to:
```js
    const w = writeBotMcp(def, { sessionDir, crowHome, remoteEnabled, peerGatewayUrls });
```
- Pass `remoteEnabled` into the `PiRpc` opts (so the constructor's `toolAllowlist` call becomes `toolAllowlist(def, { remoteEnabled: opts.remoteEnabled })`). Update the `PiRpc` constructor line `let tools = toolAllowlist(def);` → `let tools = toolAllowlist(def, { remoteEnabled: opts.remoteEnabled });` and ensure the caller passes `remoteEnabled` in the opts object it builds for `new PiRpc({...})`.

(Read the surrounding function to place these precisely; the anchors are the `writeBotMcp` call at ~:320 and the `new PiRpc({` construction. If `remoteEnabled` is computed in a different function than where `PiRpc` is built, thread it through the same opts the bridge already passes, e.g. alongside `sessionDir`/`resolved`.)

- [ ] **Step 6: Syntax check + spawn-path smoke (flag off → unchanged)**

```bash
node --check scripts/pi-bots/bridge.mjs
node --test tests/bridge-remote-allowlist.test.js
```
Expected: exit 0; allowlist tests still pass. (Full bridge spawn is exercised in the post-deploy acceptance; here we only confirm the module compiles and the pure allowlist logic is correct.)

- [ ] **Step 7: Commit**

```bash
git commit scripts/pi-bots/bridge.mjs tests/bridge-remote-allowlist.test.js \
  -m "F4a L2b: bridge reads remote_invocation flag + peer URLs; threads into writeBotMcp + toolAllowlist"
git show --stat HEAD
```

---

## Task 5: Feature-flag Settings toggle

**Files:**
- Create: `servers/gateway/dashboard/settings/sections/remote-invocation.js`
- Modify: `servers/gateway/dashboard/panels/settings.js`, `servers/gateway/dashboard/shared/i18n.js`

- [ ] **Step 1: Add the i18n label**

In `servers/gateway/dashboard/shared/i18n.js`, beside the other `settings.section.*` entries, add:
```js
  "settings.section.remoteInvocation": { en: "Remote Tool Invocation", es: "Invocación de herramientas remotas" },
```

- [ ] **Step 2: Create the section**

Create `servers/gateway/dashboard/settings/sections/remote-invocation.js`:
```js
/**
 * Settings Section: Remote Tool Invocation (Multi-Instance group) — F4a Layer 2b.
 *
 * Toggles feature_flags.remote_invocation (local-only; NOT in SYNC_ALLOWLIST).
 * When OFF (default), pi-bots on this instance cannot invoke any peer tool and
 * the Bot Builder remote group stays read-only. When ON, a bot may be wired to
 * call capabilities a peer has EXPOSED (L2a) — the peer's gate is the boundary.
 */
import { readSetting, writeSetting } from "../registry.js";

async function readFlags(db) {
  const raw = await readSetting(db, "feature_flags");
  if (!raw) return {};
  try { return JSON.parse(raw) || {}; } catch { return {}; }
}

export default {
  id: "remote-invocation",
  group: "multiInstance",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/><circle cx="4" cy="12" r="1"/></svg>`,
  labelKey: "settings.section.remoteInvocation",
  navOrder: 7,

  async getPreview({ settings }) {
    let on = false;
    try { on = JSON.parse(settings?.feature_flags || "{}")?.remote_invocation === true; } catch {}
    return on ? "enabled" : "disabled";
  },

  async render({ db }) {
    const flags = await readFlags(db);
    const on = flags.remote_invocation === true;
    return `<form method="POST">
      <input type="hidden" name="action" value="set_remote_invocation">
      <div style="margin-bottom:1rem;color:var(--crow-text-secondary);font-size:0.9rem;line-height:1.5">
        When enabled, bots built here can be wired (in the Bot Builder) to call tools that
        a <strong>trusted peer instance has exposed</strong> (Settings → Remote Tool Exposure on that peer).
        The peer enforces what's allowed; destructive tools still require their confirmation.
        Off by default. <strong>Local to this instance, never synced.</strong>
      </div>
      <label style="display:flex;align-items:center;gap:0.6rem;cursor:pointer">
        <input type="checkbox" name="enabled" ${on ? "checked" : ""}>
        <span>Allow this instance's bots to invoke exposed peer tools</span>
      </label>
      <div style="margin-top:1.5rem"><button type="submit" class="btn btn-secondary">Save</button></div>
    </form>`;
  },

  async handleAction({ req, res, db, action }) {
    if (action !== "set_remote_invocation") return false;
    const flags = await readFlags(db);
    flags.remote_invocation = req.body.enabled === "on";
    await writeSetting(db, "feature_flags", JSON.stringify(flags), { scope: "local" });
    res.redirectAfterPost("/dashboard/settings?section=remote-invocation");
    return true;
  },
};
```

- [ ] **Step 3: Register the section**

In `servers/gateway/dashboard/panels/settings.js`:
(a) import (after the other section imports): `import remoteInvocationSection from "../settings/sections/remote-invocation.js";`
(b) register (after the remote-exposure / unified-dashboard registrations): `registerSettingsSection(remoteInvocationSection);`

- [ ] **Step 4: Syntax check + round-trip smoke**

```bash
node --check servers/gateway/dashboard/settings/sections/remote-invocation.js
node --check servers/gateway/dashboard/panels/settings.js
TMP=$(mktemp -d); CROW_DATA_DIR=$TMP CROW_DB_PATH=$TMP/crow.db node scripts/init-db.js >/dev/null 2>&1
node --input-type=module -e "
import section from './servers/gateway/dashboard/settings/sections/remote-invocation.js';
import { createDbClient } from './servers/db.js';
process.env.CROW_DATA_DIR='$TMP'; process.env.CROW_DB_PATH='$TMP/crow.db';
const db = createDbClient();
let html = await section.render({ db });
console.log('default off (unchecked):', !/name=\"enabled\"[^>]*checked/.test(html));
const res = { redirectAfterPost: ()=>{} };
await section.handleAction({ req:{ body:{ action:'set_remote_invocation', enabled:'on' } }, res, db, action:'set_remote_invocation' });
html = await section.render({ db });
console.log('now on (checked):', /name=\"enabled\"[^>]*checked/.test(html));
console.log('preview on:', await section.getPreview({ settings: { feature_flags: JSON.stringify({ remote_invocation: true }) } }));
console.log('preview off:', await section.getPreview({ settings: {} }));
"; rm -rf "$TMP"
grep -n "remote_invocation\|feature_flags" servers/gateway/dashboard/settings/sync-allowlist.js || echo "OK: not in sync-allowlist (local-only)"
```
Expected: `default off (unchecked): true`, `now on (checked): true`, `preview on: enabled`, `preview off: disabled`, and the OK line.

- [ ] **Step 5: Commit**

```bash
git commit servers/gateway/dashboard/settings/sections/remote-invocation.js \
  servers/gateway/dashboard/panels/settings.js servers/gateway/dashboard/shared/i18n.js \
  -m "F4a L2b: Settings toggle for feature_flags.remote_invocation (local-only, default off)"
git show --stat HEAD
```

---

## Task 6: Bot Builder — flip the remote group to selectable (flag + exposed)

**Files:**
- Modify: `servers/gateway/dashboard/panels/bot-builder.js`

**Context:** Today `bot-builder.js:855-861` renders peer capabilities (from `gatherPeerTools(db)`) as a read-only `<details>` list. When `feature_flags.remote_invocation` is on, render them as **checkboxes** for capabilities where `t.exposed === true`, writing `def.tools.remote_mcp` entries (`<instanceId>::<canonicalId>`); non-exposed stay shown-but-disabled. The save handler must persist `remote_mcp`. When the flag is off, render exactly the Layer 1 read-only view.

- [ ] **Step 1: Read the save path + form wiring**

Run (orient — no change yet):
```bash
grep -n "remote_mcp\|crow_mcp\|def.tools\|action ===\|req.body\|hidden(\"tools\")\|JSON.parse(.*body" servers/gateway/dashboard/panels/bot-builder.js | head -40
```
Identify: (a) how the tools form POST is parsed into `def.tools.crow_mcp` (the existing selection persistence), and (b) the `feature_flags` read (add one if absent). The remote selections must be parsed in the SAME handler that writes `def.tools`.

- [ ] **Step 2: Add a flag read helper near `gatherPeerTools`** (module scope)

```js
// F4a L2b: is cross-instance invocation enabled on THIS instance?
async function remoteInvocationOn(db) {
  try {
    const raw = await readSetting(db, "feature_flags");
    return !!raw && JSON.parse(raw)?.remote_invocation === true;
  } catch { return false; }
}
```
(Ensure `readSetting` is imported in this file — `import { readSetting } from "../settings/registry.js";` or the path already used here; check the existing imports and reuse.)

- [ ] **Step 3: Render selectable-or-readonly remote group**

Replace the read-only block at `bot-builder.js:855-861`:
```js
        const peerTools = await gatherPeerTools(db);
        const peerToolsHtml = peerTools.length === 0 ? "" :
          `<details class="btb-remote-caps"><summary>Available on ${new Set(peerTools.map((t) => t.instanceId)).size} peer instance(s) &#9656;</summary>` +
          `<p class="btb-hint">Read-only — these tools live on other instances. Usable from a bot here once cross-instance calling lands (F4a Layer 2).</p>` +
          `<ul>` + peerTools.map((t) =>
            `<li>${escapeHtml(t.name)} <span class="btb-muted">(${escapeHtml(t.category)} · ${escapeHtml(t.instanceName)})</span></li>`
          ).join("") + `</ul></details>`;
```
with:
```js
        const peerTools = await gatherPeerTools(db);
        const remoteOn = await remoteInvocationOn(db);
        // De-dup to one row per (instance, capability).
        const seenRemote = new Set();
        const remoteCaps = [];
        for (const t of peerTools) {
          const key = `${t.instanceId}::${t.canonicalId}`;
          if (!t.canonicalId || seenRemote.has(key)) continue;
          seenRemote.add(key);
          remoteCaps.push(t);
        }
        const selectedRemote = new Set((def.tools && def.tools.remote_mcp) || []);
        const peerToolsHtml = remoteCaps.length === 0 ? "" :
          `<details class="btb-remote-caps"><summary>Peer instance capabilities (${new Set(remoteCaps.map((t) => t.instanceId)).size}) &#9656;</summary>` +
          (remoteOn
            ? `<p class="btb-hint">Exposed peer capabilities are selectable. The peer enforces what's allowed (F4a Layer 2a).</p>`
            : `<p class="btb-hint">Read-only — enable <strong>Settings &rarr; Remote Tool Invocation</strong> to wire these into a bot.</p>`) +
          `<ul style="list-style:none;padding-left:0">` + remoteCaps.map((t) => {
            const key = `${t.instanceId}::${t.canonicalId}`;
            const selectable = remoteOn && t.exposed === true;
            const checked = selectedRemote.has(key) ? " checked" : "";
            const label = `${escapeHtml(t.name)} <span class="btb-muted">(${escapeHtml(t.category)} · ${escapeHtml(t.instanceName)})</span>`;
            if (selectable) {
              return `<li><label><input type="checkbox" name="remote_mcp" value="${escapeHtml(key)}"${checked}> ${label}</label></li>`;
            }
            const why = remoteOn ? "not exposed by that instance" : "invocation disabled";
            return `<li><label style="opacity:.55"><input type="checkbox" disabled> ${label} <span class="btb-muted">— ${why}</span></label></li>`;
          }).join("") + `</ul></details>`;
```
(`def` is in scope where the tools tab body is assembled — confirm; it's the bot def being edited. If the tools tab doesn't already have `def`, load it the same way the local tool selection does.)

- [ ] **Step 4: Persist `remote_mcp` in the save handler**

In the POST handler that builds `def.tools` from the form (found in Step 1), add remote persistence alongside the existing `crow_mcp` handling. The checkboxes POST `remote_mcp` as a string (one) or array (many) or undefined (none). Normalize and store ONLY when the flag is on (so a disabled UI can't be spoofed into enabling — defense in depth; the bridge/writer also gate, and the peer's L2a gate is the true boundary):
```js
      // F4a L2b: persist remote capability selections (only when enabled).
      if (await remoteInvocationOn(db)) {
        let rsel = req.body.remote_mcp;
        if (rsel == null) rsel = [];
        else if (!Array.isArray(rsel)) rsel = [rsel];
        def.tools.remote_mcp = [...new Set(rsel.filter((x) => typeof x === "string" && x.includes("::")))];
      } else {
        // flag off: leave any existing remote_mcp untouched (don't wipe a prior selection)
      }
```
Place this where `def.tools.crow_mcp` is assigned from the form, using the same `def.tools` object. (If the handler reconstructs `def.tools` fresh from the form, preserve `remote_mcp` from the prior def when the flag is off.)

- [ ] **Step 5: Syntax check + render smoke (flag off=read-only, on=selectable)**

```bash
node --check servers/gateway/dashboard/panels/bot-builder.js
TMP=$(mktemp -d); CROW_DATA_DIR=$TMP CROW_DB_PATH=$TMP/crow.db node scripts/init-db.js >/dev/null 2>&1
node --input-type=module -e "
import panel from './servers/gateway/dashboard/panels/bot-builder.js';
import { createDbClient } from './servers/db.js';
process.env.CROW_DATA_DIR='$TMP'; process.env.CROW_DB_PATH='$TMP/crow.db';
const db = createDbClient();
await db.execute({ sql:\"INSERT INTO pi_bot_defs (bot_id,display_name,definition,enabled) VALUES ('t','T','{}',1)\", args:[] });
const layout=(o)=>o.content ?? o;
let out=''; const res={ send:(h)=>{out=String(h);}, redirectAfterPost:()=>{}, type:()=>res };
await panel.handler({ method:'GET', query:{ bot:'t', tab:'tools' }, body:{} }, res, { db, layout });
console.log('tools tab renders:', out.length>500);
console.log('no peers -> no remote checkboxes:', !out.includes('name=\"remote_mcp\"'));
"; rm -rf "$TMP"
```
Expected: `tools tab renders: true`; with no trusted peers the remote group is absent (`no peers -> no remote checkboxes: true`). (Live selectable behavior is covered by the post-deploy acceptance with a real peer.)

- [ ] **Step 6: Commit**

```bash
git commit servers/gateway/dashboard/panels/bot-builder.js \
  -m "F4a L2b: Bot Builder — exposed peer capabilities selectable when remote_invocation on"
git show --stat HEAD
```

---

## Task 7: Invariant + regression sweep

**Files:** none (verification only).

- [ ] **Step 1: Flag-off regression — a bot WITHOUT remote_mcp is byte-identical**

```bash
node --test tests/remote-mcp-writer.test.js tests/bridge-remote-allowlist.test.js tests/remote-blocks.test.js tests/crow-remote-proxy.test.js 2>&1 | grep -E "^# (tests|pass|fail)"
```
Expected: all pass, fail 0. (The flag-off tests in Tasks 3-4 are the regression guard: no remote blocks, no remote allowlist entries when off.)

- [ ] **Step 2: Network-exposure invariant intact**

```bash
node tests/auth-network.test.js 2>&1 | grep -E "^# (tests|pass|fail)"
```
Expected: `fail 0`. (L2b adds no public route.)

- [ ] **Step 3: Flag is local-only**

```bash
grep -n "remote_invocation\|feature_flags" servers/gateway/dashboard/settings/sync-allowlist.js \
  && echo "CHECK: ensure feature_flags is intentionally absent" || echo "OK: feature_flags / remote_invocation not in sync-allowlist (local-only)"
```
Expected: the OK line (feature flags stay local per design).

- [ ] **Step 4: L2a + Layer 1 still green**

```bash
node --test tests/exposure-allowlist.test.js tests/peer-invocation-gate.test.js tests/public-projection.test.js tests/capability-registry.test.js tests/capabilities-cache.test.js 2>&1 | grep -E "^# (tests|pass|fail)"
```
Expected: all pass, fail 0.

- [ ] **Step 5: Gateway boot smoke (isolated port + data dir; prod untouched)**

```bash
TMP=$(mktemp -d)
PORT=3072 CROW_DATA_DIR=$TMP CROW_DB_PATH=$TMP/crow.db timeout 14 node servers/gateway/index.js > /tmp/l2b-boot.log 2>&1
echo "exit=$? (124=timeout, expected)"
grep -iE "listening|Router server mounted|ReferenceError|is not defined|Cannot find module|SyntaxError" /tmp/l2b-boot.log | head
rm -rf "$TMP"
```
Expected: "listening" + "Router server mounted", no module/throw errors.

- [ ] **Step 6: Scoped-diff check**

```bash
git diff --stat main...feat/f4a-layer2b-remote-invocation
```
Expected: only the files in the File Structure table (+ the spec/plan docs). No strays.

- [ ] **Step 7: STOP — hand back for the merge/deploy + acceptance decision.** Do NOT auto-merge or deploy. Acceptance (post-deploy, attended): on grackle expose "Memory" (L2a) + pair confirmed; on crow enable `feature_flags.remote_invocation`, wire a TEST bot to "Memory @ grackle", run one turn that calls a read memory tool, verify the result returns AND grackle's L2a audit (`cross_host_calls`) logs the inbound call. Deploy = `git pull --ff-only` + restart gateways (NO init-db — pure code; `remote_mcp` is a JSON field inside `pi_bot_defs.definition`). Restart any model containers stopped for the build.

---

## Self-Review

**Spec coverage:**
- §1 Feature flag (local-only, default off, 3 gated call-sites) → Task 5 (toggle) + Task 1 `parseRemoteInvocationFlag` + Task 4 (bridge read) + Task 6 (UI read). The three gates: UI (Task 6), mcp_writer (Task 3 `opts.remoteEnabled`), bridge (Task 4 `toolAllowlist` + writeBotMcp). ✓
- §2 `def.tools.remote_mcp` schema → Task 1 `remoteServersForBot` + Task 6 persistence. ✓
- §3 `crow-remote-proxy.mjs` (stdio↔HTTP passthrough, Bearer token, peer L2a gate, graceful failure) → Task 2. ✓
- §4 `mcp_writer` (mount map core-only, mint, flag-gated, addon/unknown-peer warnings) → Task 1 + Task 3. ✓
- §5 bridge allowlist (server-level, flag-gated) → Task 4. ✓
- §6 Bot Builder flip (selectable when flag on AND exposed; non-exposed disabled; read-only when off) → Task 6. ✓
- §7 components table → all tasks. ✓
- Error handling (peer unavailable/deny, flag off, addon/unknown skip) → Task 2 tests + Task 1/3 warnings. ✓
- Testing items 1-6 → Tasks 1-6; acceptance (item 7) → Task 7 Step 7. ✓
- Invariants (auth-network, flag local-only, flag-off byte-identical, L2a/L1 green) → Task 7. ✓
- Non-goals honored: addons deferred (mount map core-only + warning), per-capability only, no bot edit/run, confirm-token untouched. ✓

**Placeholder scan:** No TBD/TODO. The locate-then-edit steps (Task 4 Step 5 spawn-path threading; Task 6 Steps 1/3/4 form-handler placement) are bounded with explicit anchors (`writeBotMcp` ~:320, `new PiRpc({`, `bot-builder.js:855-861`) and a grep orientation step; the two spec-flagged verifications (pi `--tools` server-level semantics; `getOrCreateLocalInstanceId` in-bridge) have explicit fallbacks/smokes.

**Type consistency:** `remoteServersForBot(def) → [{instanceId,canonicalId}]` used in Task 1 (mint), Task 4 (allowlist). Block name `crow-remote-<instanceId.slice(0,8)>-<canonicalId>` identical in `mintRemoteBlocks` (Task 1/3) and `toolAllowlist` (Task 4). `def.tools.remote_mcp` entries `"<instanceId>::<canonicalId>"` consistent across Task 1 parse, Task 6 write, Task 4. `writeBotMcp` opts `{ remoteEnabled, peerGatewayUrls }` consistent between Task 3 (consumer) and Task 4 (bridge producer). `parseRemoteInvocationFlag` (Task 1) reused by the bridge sync read (Task 4) and conceptually mirrors the panel/section async read (Tasks 5-6). Env var names `CROW_REMOTE_{INSTANCE_ID,GATEWAY_URL,MOUNT}` identical between `mintRemoteBlocks` (Task 1) and `crow-remote-proxy` (Task 2).
