# Voice Channel Federated (Cross-Instance) Tools — Implementation Plan (v2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A voice-channel bot on grackle (Meta glasses → `crow-glasses`) can invoke a capability that lives on a different paired Crow instance (Funkwhale music on the **main crow** instance) **and actually hear the audio** — "shuffle play my music" plays crow's library through the glasses.

**Architecture:** Two layers. (1) **Tool routing** — the in-process voice loop discovers the remote capability's tools, advertises them to the voice model, and routes their calls to the owning instance's `/router/mcp` as `crow_tools{action, params}`. (2) **Audio transport** — because `fw_play` returns an `_audio_stream` envelope with a URL/token only valid *on the owning instance*, the owning instance's gateway exposes a peer-authed audio stream-proxy; the routing layer rewrites the envelope to point at it, and grackle streams the bytes through it to the glasses. Both layers are **null/no-op unless the bound bot opts in** (`def.tools.remote_mcp` + `feature_flags.remote_invocation`).

**Tech Stack:** Node.js (ESM), `@modelcontextprotocol/sdk` (`Client` + `StreamableHTTPClientTransport`), Express, libsql (`servers/db.js`), Node built-in test runner (`node --test`).

---

## Why v2 (decisions taken 2026-06-15)

The v1 plan was **REJECTED** in review (see Review history at the bottom) because it routed the tool call but never solved audio: `fw_play`'s `_audio_stream` URL is owning-instance-internal (`http://crow-funkwhale/...`) and its `auth:"funkwhale"` sentinel resolves to the *consuming* instance's (grackle's) funkwhale token — which the plan also removed. After investigating topology, the operator chose:

- **Keep the glasses bot on grackle** and **build the real product capability** (federated voice tools), rather than co-locating the bot with the music.
- **Audio transport = gateway stream-proxy** (the owning instance proxies the bytes; no funkwhale token ever crosses instances).
- **Consolidate Funkwhale onto the main crow instance** (`~/.crow`), not the MPA sandbox (`~/.crow-mpa`), so grackle federates with its primary peer. The Funkwhale *container* (`crow-funkwhale`) is machine-level and unchanged; only the MCP *addon* registration moves.

Reviewer follow-ups also folded in: **C3** (`callRemote` must never set `instance_id` — peer-exposure denies onward-relay), **C4** (remote tools bypass the source-side addon allowlist; the target's `remote_exposed_tools` is the intended sole gate — documented + tested), **C5** (discovery cached so a voice turn doesn't pay a remote handshake every utterance).

### Topology (verified)

- Funkwhale container `crow-funkwhale` (machine-level, healthy) on the **crow machine**.
- Funkwhale MCP addon currently registered on **MPA** (`~/.crow-mpa/mcp-addons.json`) → moves to **main crow** (`~/.crow/mcp-addons.json`).
- Glasses bot `crow-glasses` runs on **grackle**; uses crow's STT/TTS/LLM remotely already.
- `instanceAuthMiddleware` is global on the gateway (`servers/gateway/index.js:349`) → `req.instanceAuth.instance` is set for any valid peer-bearer request, so a new peer-authed route needs no extra wiring.

---

## File structure

**Phase A — routing**
- **Create** `servers/gateway/ai/remote-voice-tools.js` — discovery (`parseCapabilityTools`, `selectRemoteToolset`), peer-authed router client (`createRemoteRouterClient`), cached orchestration (`buildRemoteVoiceContext`), and the audio-envelope rewrite used by `callRemote`.
- **Modify** `servers/gateway/ai/tool-executor.js` — `createToolExecutor` accepts `opts.remote`; `executeTool` routes remote tools first; `getChatTools` accepts `opts.remoteTools`; re-export `buildRemoteVoiceContext`.
- **Modify** `bundles/meta-glasses/panel/routes.js` (`runVoiceTurn`) — build/pass/close the remote context.

**Phase B — audio transport**
- **Create** `servers/gateway/routes/audio-proxy.js` — peer-authed, exposure-gated `GET /audio/stream` that proxies Funkwhale listen bytes on the owning instance.
- **Modify** `servers/gateway/index.js` — mount the audio-proxy router.
- **Modify** `bundles/meta-glasses/panel/routes.js` — teach `pushAudioStream`'s auth resolver the dynamic `crow-peer:<instanceId>` sentinel.
- (rewrite of the envelope itself lives in `remote-voice-tools.js`'s `callRemote`, Phase A file.)

**Tests**
- **Create** `tests/remote-voice-tools.test.js` — parser, selector, context (flag-off invariant, cache, no-`instance_id`), envelope rewrite (head + album queue).
- **Create** `tests/voice-remote-routing.test.js` — executor routing + `getChatTools` advertising + local-path-unchanged.
- **Create** `tests/audio-proxy.test.js` — exposure gate, param validation, peer-auth required.

**Deploy-only (no repo change)** — Phase C.

---

# Phase A — Federated tool routing

## Task A1: Parse the remote capability→tools listing

**Files:**
- Create: `servers/gateway/ai/remote-voice-tools.js`
- Test: `tests/remote-voice-tools.test.js`

The remote `/router/mcp` `crow_discover{category:"tools"}` returns (see `servers/gateway/router.js:356-365`):

```
External integration tools:

  funkwhale:
    - fw_play: Play a track, album, or start a radio station.
    - fw_search: Search the music library.

  home-assistant:
    - ha_turn_on: Turn on a device.
```

- [ ] **Step 1: Write the failing test**

Create `tests/remote-voice-tools.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCapabilityTools } from "../servers/gateway/ai/remote-voice-tools.js";

test("parseCapabilityTools groups tools under their capability id", () => {
  const text = [
    "External integration tools:",
    "",
    "  funkwhale:",
    "    - fw_play: Play a track or start a radio.",
    "    - fw_search: Search the library.",
    "",
    "  home-assistant:",
    "    - ha_turn_on: Turn on a device.",
  ].join("\n");
  const map = parseCapabilityTools(text);
  assert.deepEqual([...map.keys()], ["funkwhale", "home-assistant"]);
  assert.deepEqual(map.get("funkwhale"), [
    { name: "fw_play", description: "Play a track or start a radio." },
    { name: "fw_search", description: "Search the library." },
  ]);
});

test("parseCapabilityTools tolerates empty / no-integrations text", () => {
  assert.equal(parseCapabilityTools("").size, 0);
  assert.equal(parseCapabilityTools("No external integrations connected.").size, 0);
  assert.equal(parseCapabilityTools(null).size, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/remote-voice-tools.test.js`
Expected: FAIL — module/function not found.

- [ ] **Step 3: Write minimal implementation**

Create `servers/gateway/ai/remote-voice-tools.js`:

```js
/**
 * Cross-instance (federated) tools for the IN-PROCESS voice loop.
 *
 * The voice turn (bundles/meta-glasses/panel/routes.js) never spawns pi, so the
 * text-bot .mcp.json remote-block path (scripts/pi-bots/remote-blocks.mjs) does
 * not apply. This module gives the voice tool-executor the same reach by:
 *   1. discovering a remote instance's capability tools over a peer-authed MCP
 *      client to the remote /router/mcp (crow_discover category "tools"),
 *   2. advertising the bot's selected remote capabilities' tools to the model,
 *   3. routing those tool calls back to the owning instance as
 *      crow_tools{action, params} (the peer-exposure-gated, verified path), and
 *   4. rewriting any _audio_stream envelope so audio streams through the owning
 *      instance's /audio/stream proxy (the bytes/token never leave that instance).
 *
 * SECURITY NOTE (reviewer C4): remote tools are advertised as direct promoted
 * tools and are NOT subject to the source-side per-bot addon allowlist
 * (isConnectedAddonTool is false for them — they aren't local). That is
 * intentional: the OWNING instance's remote_exposed_tools default-deny gate
 * (servers/gateway/peer-exposure.js) is the trust boundary, enforced server-side
 * regardless of what the source advertises. callRemote also never sets
 * instance_id (C3): peer-exposure denies onward-relay hops.
 *
 * Entirely OFF unless the bound bot opts in via def.tools.remote_mcp AND
 * feature_flags.remote_invocation — buildRemoteVoiceContext returns null
 * otherwise, so every existing caller is byte-for-byte unchanged.
 */

import { remoteServersForBot, parseRemoteInvocationFlag } from "../../../scripts/pi-bots/remote-blocks.mjs";

/**
 * Parse the remote router's crow_discover({category:"tools"}) text into
 * Map<capabilityId, [{name, description}]>. Header lines are "  <id>:" (two
 * spaces); tool lines are "    - <name>: <desc>" (four spaces).
 */
export function parseCapabilityTools(text) {
  const out = new Map();
  let current = null;
  for (const line of String(text || "").split("\n")) {
    const header = line.match(/^ {2}([^\s].*?):\s*$/);
    if (header) {
      current = header[1];
      if (!out.has(current)) out.set(current, []);
      continue;
    }
    const tool = line.match(/^ {4}- (\S+):\s?(.*)$/);
    if (tool && current) {
      out.get(current).push({ name: tool[1], description: tool[2] || "" });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/remote-voice-tools.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git commit servers/gateway/ai/remote-voice-tools.js tests/remote-voice-tools.test.js -m "feat(voice): parse remote capability tool listing"
git show --stat HEAD
```

---

## Task A2: Select the bot's remote toolset + route map

**Files:**
- Modify: `servers/gateway/ai/remote-voice-tools.js`
- Test: `tests/remote-voice-tools.test.js`

- [ ] **Step 1: Write the failing test**

Append to `tests/remote-voice-tools.test.js`:

```js
import { selectRemoteToolset } from "../servers/gateway/ai/remote-voice-tools.js";

test("selectRemoteToolset advertises only selected capabilities' tools + builds route map", () => {
  const parsedByInstance = new Map([
    ["inst-A", new Map([
      ["funkwhale", [
        { name: "fw_play", description: "Play music." },
        { name: "fw_search", description: "Search." },
      ]],
      ["home-assistant", [{ name: "ha_turn_on", description: "On." }]],
    ])],
  ]);
  const { advertised, routeMap } = selectRemoteToolset(parsedByInstance, [
    { instanceId: "inst-A", canonicalId: "funkwhale" },
  ]);
  assert.deepEqual(advertised.map(t => t.name), ["fw_play", "fw_search"]);
  assert.equal(routeMap.has("ha_turn_on"), false);
  assert.deepEqual(routeMap.get("fw_play"), { instanceId: "inst-A", canonicalId: "funkwhale" });
  assert.equal(advertised[0].inputSchema.type, "object");
  assert.equal(advertised[0].inputSchema.additionalProperties, true);
});

test("selectRemoteToolset: unknown instance/capability yields nothing; first name wins on clash", () => {
  const parsed = new Map([
    ["A", new Map([["funkwhale", [{ name: "fw_play", description: "A" }]]])],
    ["B", new Map([["funkwhale", [{ name: "fw_play", description: "B" }]]])],
  ]);
  const { advertised, routeMap } = selectRemoteToolset(parsed, [
    { instanceId: "A", canonicalId: "funkwhale" },
    { instanceId: "B", canonicalId: "funkwhale" },
    { instanceId: "Z", canonicalId: "nope" },
  ]);
  assert.equal(advertised.length, 1);
  assert.deepEqual(routeMap.get("fw_play"), { instanceId: "A", canonicalId: "funkwhale" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/remote-voice-tools.test.js`
Expected: FAIL — `selectRemoteToolset is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `servers/gateway/ai/remote-voice-tools.js`:

```js
/**
 * From the discovered per-instance capability map and the bot's remote
 * selections ([{instanceId, canonicalId}]), produce:
 *   advertised: [{name, description, inputSchema}]  — promoted tools for the model
 *   routeMap:   Map<toolName, {instanceId, canonicalId}> — for executor dispatch
 * First selection wins on a tool-name clash. Schema is permissive on purpose:
 * the description carries intent and crow_tools normalizes params downstream.
 */
export function selectRemoteToolset(parsedByInstance, selections) {
  const advertised = [];
  const routeMap = new Map();
  for (const { instanceId, canonicalId } of selections) {
    const caps = parsedByInstance.get(instanceId);
    if (!caps) continue;
    const tools = caps.get(canonicalId);
    if (!tools) continue;
    for (const t of tools) {
      if (routeMap.has(t.name)) continue;
      routeMap.set(t.name, { instanceId, canonicalId });
      advertised.push({
        name: t.name,
        description: t.description || "",
        inputSchema: { type: "object", properties: {}, additionalProperties: true },
      });
    }
  }
  return { advertised, routeMap };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/remote-voice-tools.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git commit servers/gateway/ai/remote-voice-tools.js tests/remote-voice-tools.test.js -m "feat(voice): select remote toolset + build route map"
git show --stat HEAD
```

---

## Task A3: Audio-envelope rewrite (pure)

**Files:**
- Modify: `servers/gateway/ai/remote-voice-tools.js`
- Test: `tests/remote-voice-tools.test.js`

This is the heart of the C1/C2 fix: rewrite a Funkwhale `_audio_stream` envelope (and its album `queue[]`) so its URL points at the **owning instance's** `/audio/stream` proxy and its `auth` is the `crow-peer:<instanceId>` sentinel. Pure function so it's fully unit-tested.

- [ ] **Step 1: Write the failing test**

Append to `tests/remote-voice-tools.test.js`:

```js
import { rewriteAudioResult } from "../servers/gateway/ai/remote-voice-tools.js";

test("rewriteAudioResult rewrites a single fw_play envelope to the proxy URL + crow-peer auth", () => {
  const result = { content: [{ type: "text", text: JSON.stringify({
    prose: "Playing Blue in Green.",
    _audio_stream: { url: "http://crow-funkwhale/api/v1/listen/abc12345-dead-beef-cafe-0123456789ab/?to=opus", codec: "opus", auth: "funkwhale" },
  }) }] };
  const out = rewriteAudioResult(result, "https://crow.example:8443", "crow-inst-1");
  const parsed = JSON.parse(out.content[0].text);
  assert.equal(parsed._audio_stream.url,
    "https://crow.example:8443/audio/stream?cap=funkwhale&id=abc12345-dead-beef-cafe-0123456789ab&codec=opus");
  assert.equal(parsed._audio_stream.auth, "crow-peer:crow-inst-1");
  assert.equal(parsed._audio_stream.codec, "opus"); // preserved
});

test("rewriteAudioResult rewrites every track in an album queue", () => {
  const mk = (uuid) => ({ url: `http://crow-funkwhale/api/v1/listen/${uuid}/?to=mp3`, codec: "mp3", auth: "funkwhale", title: "t" });
  const result = { content: [{ type: "text", text: JSON.stringify({
    _audio_stream: { ...mk("11111111-1111-1111-1111-111111111111"),
      queue: [mk("22222222-2222-2222-2222-222222222222"), mk("33333333-3333-3333-3333-333333333333")] },
  }) }] };
  const out = rewriteAudioResult(result, "https://crow.example:8443", "c1");
  const env = JSON.parse(out.content[0].text)._audio_stream;
  assert.match(env.url, /id=11111111/);
  assert.equal(env.auth, "crow-peer:c1");
  assert.equal(env.queue.length, 2);
  assert.match(env.queue[0].url, /id=22222222/);
  assert.match(env.queue[1].url, /id=33333333/);
  assert.equal(env.queue[0].auth, "crow-peer:c1");
  assert.equal(env.queue[0].title, "t"); // metadata preserved
});

test("rewriteAudioResult leaves non-audio / non-funkwhale results untouched", () => {
  const plain = { content: [{ type: "text", text: JSON.stringify({ ok: true, data: 1 }) }] };
  assert.equal(rewriteAudioResult(plain, "https://x", "c1").content[0].text, JSON.stringify({ ok: true, data: 1 }));
  // a stream whose url isn't a funkwhale listen url is left alone (no id match)
  const odd = { content: [{ type: "text", text: JSON.stringify({ _audio_stream: { url: "https://elsewhere/x.mp3", codec: "mp3" } }) }] };
  assert.equal(JSON.parse(rewriteAudioResult(odd, "https://x", "c1").content[0].text)._audio_stream.url, "https://elsewhere/x.mp3");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/remote-voice-tools.test.js`
Expected: FAIL — `rewriteAudioResult is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `servers/gateway/ai/remote-voice-tools.js`:

```js
const LISTEN_ID_RE = /\/listen\/([0-9a-fA-F-]+)\//;

/** Rewrite one {url, codec, auth, ...} stream descriptor to the owning
 * instance's /audio/stream proxy. Non-funkwhale-listen urls are left as-is. */
function rewriteStream(s, gatewayUrl, instanceId) {
  if (!s || typeof s.url !== "string") return s;
  const m = s.url.match(LISTEN_ID_RE);
  if (!m) return s;
  const id = m[1];
  const codec = s.codec || (s.url.match(/[?&]to=([^&]+)/)?.[1]) || "mp3";
  const base = String(gatewayUrl).replace(/\/+$/, "");
  return {
    ...s,
    url: `${base}/audio/stream?cap=funkwhale&id=${encodeURIComponent(id)}&codec=${encodeURIComponent(codec)}`,
    auth: `crow-peer:${instanceId}`,
  };
}

/**
 * Rewrite any Funkwhale _audio_stream envelope (head + album queue) inside an
 * MCP tool result so the consuming instance streams the bytes through the
 * owning instance's /audio/stream proxy. Mutates + returns the same result
 * object. No-op for results without a funkwhale audio envelope.
 */
export function rewriteAudioResult(result, gatewayUrl, instanceId) {
  for (const block of result?.content || []) {
    if (block.type !== "text" || typeof block.text !== "string") continue;
    if (!block.text.includes('"_audio_stream"')) continue;
    try {
      const parsed = JSON.parse(block.text);
      const env = parsed._audio_stream;
      if (!env || typeof env.url !== "string") continue;
      const queue = Array.isArray(env.queue) ? env.queue : null;
      const head = rewriteStream(env, gatewayUrl, instanceId);
      if (queue) head.queue = queue.map((q) => rewriteStream(q, gatewayUrl, instanceId));
      parsed._audio_stream = head;
      block.text = JSON.stringify(parsed);
    } catch { /* not JSON — leave untouched */ }
  }
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/remote-voice-tools.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git commit servers/gateway/ai/remote-voice-tools.js tests/remote-voice-tools.test.js -m "feat(voice): rewrite federated audio envelopes to the owning-instance proxy"
git show --stat HEAD
```

---

## Task A4: Peer-authed remote router client

**Files:**
- Modify: `servers/gateway/ai/remote-voice-tools.js`

Mirrors `proxy.js:createRemoteInstanceClient` but targets `/router/mcp` (so `crow_tools`/`crow_discover` exist). Thin network wrapper; covered by Task A5's injected-fake tests.

- [ ] **Step 1: Implement**

Append to `servers/gateway/ai/remote-voice-tools.js`:

```js
/**
 * Peer-authed MCP client to a remote instance's /router/mcp. Reuses the same
 * peer bearer token the proxy's federation client uses (peer-credentials.js),
 * so the remote's instanceAuth middleware recognises us and peer-exposure gates
 * the call against the remote's remote_exposed_tools allowlist.
 */
export async function createRemoteRouterClient({ instanceId, gatewayUrl }) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const { getPeerCreds } = await import("../../shared/peer-credentials.js");

  const baseUrl = String(gatewayUrl).replace(/\/+$/, "");
  const url = new URL(`${baseUrl}/router/mcp`);
  const creds = getPeerCreds(instanceId);
  const requestInit = creds?.auth_token
    ? { headers: { Authorization: `Bearer ${creds.auth_token}` } }
    : undefined;

  const transport = new StreamableHTTPClientTransport(url, requestInit ? { requestInit } : undefined);
  const client = new Client({ name: `crow-voice-remote-${instanceId}`, version: "0.1.0" });
  await Promise.race([
    client.connect(transport),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("remote router connect timed out (10s)")), 10_000)),
  ]);
  return client;
}
```

- [ ] **Step 2: Verify the module imports cleanly**

Run: `node -e "import('./servers/gateway/ai/remote-voice-tools.js').then(m => console.log(Object.keys(m).sort().join(',')))"`
Expected: includes `createRemoteRouterClient,parseCapabilityTools,rewriteAudioResult,selectRemoteToolset`.

- [ ] **Step 3: Commit**

```bash
git commit servers/gateway/ai/remote-voice-tools.js -m "feat(voice): peer-authed remote /router/mcp client"
git show --stat HEAD
```

---

## Task A5: `buildRemoteVoiceContext` — flag-gated, cached orchestration

**Files:**
- Modify: `servers/gateway/ai/remote-voice-tools.js`
- Test: `tests/remote-voice-tools.test.js`

Dependency-injected for tests. **Discovery (the expensive `crow_discover`) is cached by a signature of the bot's `remote_mcp` selections with a TTL (reviewer C5)**, so a voice turn that doesn't call a remote tool pays nothing. The router client for *routing* is created lazily on first `callRemote` and closed by `close()`. `callRemote` rewrites audio results (Task A3) and **never sets `instance_id`** (C3).

- [ ] **Step 1: Write the failing test**

Append to `tests/remote-voice-tools.test.js`:

```js
import { buildRemoteVoiceContext, _resetRemoteVoiceCacheForTests } from "../servers/gateway/ai/remote-voice-tools.js";

const FAKE_DISCOVER_TEXT = ["External integration tools:", "", "  funkwhale:", "    - fw_play: Play music."].join("\n");

function fakeDeps({ flag = true, urls = { "inst-A": "https://peer.example:8447" } } = {}) {
  const calls = [];
  let connects = 0;
  return {
    calls, get connects() { return connects; },
    readSettingFn: async () => JSON.stringify({ remote_invocation: flag }),
    getPeerGatewayUrls: async () => new Map(Object.entries(urls)),
    nowFn: () => 1000,
    clientFactory: async ({ instanceId }) => {
      connects++;
      return {
        _id: instanceId,
        callTool: async ({ name, arguments: a }) => {
          calls.push({ instanceId, name, arguments: a });
          if (name === "crow_discover") return { content: [{ type: "text", text: FAKE_DISCOVER_TEXT }] };
          return { content: [{ type: "text", text: JSON.stringify({ ok: true, name, a }) }] };
        },
        close: async () => {},
      };
    },
  };
}

const BOT = { tools: { remote_mcp: ["inst-A::funkwhale"] } };

test("buildRemoteVoiceContext: null when no remote_mcp / flag off / no gateway_url", async () => {
  _resetRemoteVoiceCacheForTests();
  assert.equal(await buildRemoteVoiceContext({}, { tools: {} }, fakeDeps()), null);
  assert.equal(await buildRemoteVoiceContext({}, BOT, fakeDeps({ flag: false })), null);
  assert.equal(await buildRemoteVoiceContext({}, BOT, fakeDeps({ urls: {} })), null);
});

test("buildRemoteVoiceContext: discovers, advertises, routes via crow_tools WITHOUT instance_id", async () => {
  _resetRemoteVoiceCacheForTests();
  const deps = fakeDeps();
  const ctx = await buildRemoteVoiceContext({}, BOT, deps);
  assert.deepEqual(ctx.advertised.map(t => t.name), ["fw_play"]);
  await ctx.callRemote("fw_play", { query: "jazz" });
  const wrapped = deps.calls.find(c => c.name === "crow_tools");
  assert.deepEqual(wrapped.arguments, { action: "fw_play", params: { query: "jazz" } });
  assert.equal("instance_id" in wrapped.arguments, false); // C3
  await ctx.close();
});

test("buildRemoteVoiceContext: discovery is cached by selection signature (C5)", async () => {
  _resetRemoteVoiceCacheForTests();
  const deps = fakeDeps();
  const a = await buildRemoteVoiceContext({}, BOT, deps); await a.close();
  const discoverCalls1 = deps.calls.filter(c => c.name === "crow_discover").length;
  const b = await buildRemoteVoiceContext({}, BOT, deps); await b.close();
  const discoverCalls2 = deps.calls.filter(c => c.name === "crow_discover").length;
  assert.equal(discoverCalls1, 1);
  assert.equal(discoverCalls2, 1, "second build reuses cached discovery — no extra crow_discover");
});

test("buildRemoteVoiceContext: callRemote rewrites a funkwhale audio envelope", async () => {
  _resetRemoteVoiceCacheForTests();
  const deps = fakeDeps();
  deps.clientFactory = async ({ instanceId }) => ({
    callTool: async ({ name }) => name === "crow_discover"
      ? { content: [{ type: "text", text: FAKE_DISCOVER_TEXT }] }
      : { content: [{ type: "text", text: JSON.stringify({ _audio_stream: { url: "http://crow-funkwhale/api/v1/listen/abc/?to=opus", codec: "opus", auth: "funkwhale" } }) }] },
    close: async () => {},
  });
  const ctx = await buildRemoteVoiceContext({}, BOT, deps);
  const r = await ctx.callRemote("fw_play", {});
  const env = JSON.parse(r.content[0].text)._audio_stream;
  assert.match(env.url, /^https:\/\/peer\.example:8447\/audio\/stream\?cap=funkwhale&id=abc&codec=opus$/);
  assert.equal(env.auth, "crow-peer:inst-A");
  await ctx.close();
});

test("buildRemoteVoiceContext: a peer whose discovery throws degrades to null", async () => {
  _resetRemoteVoiceCacheForTests();
  const deps = fakeDeps();
  deps.clientFactory = async () => { throw new Error("peer down"); };
  assert.equal(await buildRemoteVoiceContext({}, BOT, deps), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/remote-voice-tools.test.js`
Expected: FAIL — `buildRemoteVoiceContext is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `servers/gateway/ai/remote-voice-tools.js`:

```js
// Discovery cache: signature -> { at, advertised, routeMap }. Keyed on the
// bot's sorted remote_mcp selections + instance gateway urls; TTL bounds drift.
const DISCOVERY_TTL_MS = 5 * 60 * 1000;
const _discoveryCache = new Map();
export function _resetRemoteVoiceCacheForTests() { _discoveryCache.clear(); }

async function defaultPeerGatewayUrls(db) {
  const map = new Map();
  try {
    const { rows } = await db.execute({
      sql: "SELECT id, gateway_url FROM crow_instances WHERE status != 'revoked' AND gateway_url IS NOT NULL",
      args: [],
    });
    for (const r of rows) map.set(r.id, r.gateway_url);
  } catch { /* no peers / table missing */ }
  return map;
}

async function defaultReadSetting(db, key) {
  const { readSetting } = await import("../dashboard/settings/registry.js");
  return readSetting(db, key);
}

async function defaultDiscover(client) {
  const r = await client.callTool({ name: "crow_discover", arguments: { category: "tools" } });
  let text = "";
  for (const b of r?.content || []) if (b.type === "text") text += b.text;
  return text;
}

/**
 * Build the per-bot remote voice context, or null when the bot hasn't opted in /
 * the flag is off / no reachable peer advertises a selected capability. Never
 * throws into the voice turn. See the module header for the security model.
 */
export async function buildRemoteVoiceContext(db, botDef, deps = {}) {
  const readSettingFn = deps.readSettingFn || defaultReadSetting;
  const getPeerGatewayUrls = deps.getPeerGatewayUrls || defaultPeerGatewayUrls;
  const clientFactory = deps.clientFactory || createRemoteRouterClient;
  const discoverFn = deps.discoverFn || defaultDiscover;
  const now = deps.nowFn || (() => Date.now());

  const selections = remoteServersForBot(botDef);
  if (!selections.length) return null;

  let flagRaw;
  try { flagRaw = await readSettingFn(db, "feature_flags"); } catch { return null; }
  if (!parseRemoteInvocationFlag(flagRaw)) return null;

  const urls = await getPeerGatewayUrls(db);
  const wantedIds = [...new Set(selections.map(s => s.instanceId))].filter(id => urls.get(id));
  if (!wantedIds.length) return null;

  // ---- discovery (cached) ----
  const sig = JSON.stringify({
    sel: selections.map(s => `${s.instanceId}::${s.canonicalId}`).sort(),
    urls: wantedIds.sort().map(id => `${id}=${urls.get(id)}`),
  });
  let disc = _discoveryCache.get(sig);
  if (!disc || now() - disc.at > DISCOVERY_TTL_MS) {
    const parsedByInstance = new Map();
    for (const id of wantedIds) {
      let client = null;
      try {
        client = await clientFactory({ instanceId: id, gatewayUrl: urls.get(id) });
        parsedByInstance.set(id, parseCapabilityTools(await discoverFn(client)));
      } catch (err) {
        console.warn(`[voice-remote] discovery failed for instance ${id}: ${err.message}`);
      } finally {
        if (client) { try { await client.close?.(); } catch {} }
      }
    }
    const reachable = selections.filter(s => parsedByInstance.has(s.instanceId));
    const { advertised, routeMap } = selectRemoteToolset(parsedByInstance, reachable);
    disc = { at: now(), advertised, routeMap };
    _discoveryCache.set(sig, disc);
  }
  if (!disc.advertised.length) return null;

  // ---- routing (lazy clients, closed by close()) ----
  const routeMap = disc.routeMap;
  // Map<instanceId, Promise<client>>. Caching the PROMISE (not the resolved
  // client) makes concurrent callRemote()s for the same instance — executeToolCalls
  // runs tool calls via Promise.all — share one connect instead of racing two and
  // orphaning a connection (reviewer suggestion 1).
  const clients = new Map();
  function clientFor(instanceId) {
    if (!clients.has(instanceId)) {
      clients.set(instanceId, clientFactory({ instanceId, gatewayUrl: urls.get(instanceId) }));
    }
    return clients.get(instanceId); // a Promise<client>; awaited by callers
  }
  async function callRemote(toolName, args) {
    const route = routeMap.get(toolName);
    if (!route) return null;
    const client = await clientFor(route.instanceId);
    // C3: NO instance_id — peer-exposure denies onward-relay hops.
    const result = await client.callTool({ name: "crow_tools", arguments: { action: toolName, params: args || {} } });
    return rewriteAudioResult(result, urls.get(route.instanceId), route.instanceId);
  }
  async function close() {
    for (const p of clients.values()) { try { await (await p)?.close?.(); } catch {} }
    clients.clear();
  }
  return { advertised: disc.advertised, routeMap, callRemote, close };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/remote-voice-tools.test.js`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git commit servers/gateway/ai/remote-voice-tools.js tests/remote-voice-tools.test.js -m "feat(voice): cached, flag-gated remote voice context with audio rewrite"
git show --stat HEAD
```

---

## Task A6: `getChatTools` advertises remote tools

**Files:**
- Modify: `servers/gateway/ai/tool-executor.js` (insert before the final `return tools;` at line 924)
- Test: `tests/voice-remote-routing.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/voice-remote-routing.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { getChatTools } from "../servers/gateway/ai/tool-executor.js";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/voice-remote-routing.test.js`
Expected: FAIL — first test fails (`fw_play should be advertised`).

- [ ] **Step 3: Write minimal implementation**

In `servers/gateway/ai/tool-executor.js`, immediately before the final `return tools;` in `getChatTools` (line 924), insert:

```js
  // Cross-instance (federated) voice tools — advertised as direct promoted tools
  // so the model can call them by name; the executor routes each to its owning
  // instance (see buildRemoteVoiceContext / executeTool's remote branch). Deduped
  // against everything already advertised. Absent unless the bound bot opted in.
  if (Array.isArray(opts.remoteTools) && opts.remoteTools.length) {
    const have = new Set(tools.map((t) => t.name));
    for (const rt of opts.remoteTools) {
      if (!rt || !rt.name || have.has(rt.name)) continue;
      have.add(rt.name);
      tools.push({
        name: rt.name,
        description: rt.description || "",
        inputSchema: rt.inputSchema || { type: "object", properties: {}, additionalProperties: true },
      });
    }
  }

```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/voice-remote-routing.test.js`
Expected: first three tests PASS.

- [ ] **Step 5: Commit**

```bash
git commit servers/gateway/ai/tool-executor.js tests/voice-remote-routing.test.js -m "feat(voice): advertise remote tools in getChatTools"
git show --stat HEAD
```

---

## Task A7: `executeTool` routes remote tools (local path unchanged)

**Files:**
- Modify: `servers/gateway/ai/tool-executor.js` (`createToolExecutor` line 193; `executeTool` line 225)
- Test: `tests/voice-remote-routing.test.js`

- [ ] **Step 1: Write the failing test**

Append to `tests/voice-remote-routing.test.js`:

```js
import { createToolExecutor } from "../servers/gateway/ai/tool-executor.js";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/voice-remote-routing.test.js`
Expected: FAIL — routing tests fall through to "Unknown tool".

- [ ] **Step 3: Write minimal implementation**

In `servers/gateway/ai/tool-executor.js`:

(a) In `createToolExecutor`, after line 196 (`const defaultDeliverTo = ...`), add:

```js
  const remote = opts.remote || null; // cross-instance voice routing (null = off)
```

(b) In `executeTool`, immediately after the opening `try {` (line 226), insert FIRST:

```js
      // Cross-instance routing (voice). Unwrap the crow_tools proxy so a remote
      // tool hidden behind it still routes remotely. Only names a selected remote
      // capability owns (routeMap) are routed; everything else falls through to
      // the unchanged local logic below.
      if (remote && remote.routeMap) {
        const eff = (name === "crow_tools" && args && typeof args.action === "string" && args.action)
          ? args.action : name;
        if (remote.routeMap.has(eff)) {
          const params = name === "crow_tools" ? (args.params || {}) : (args || {});
          try {
            const result = await remote.callRemote(eff, params);
            if (result) return formatResult(result);
            return { result: `Remote tool "${eff}" is unavailable right now.`, isError: true };
          } catch (err) {
            return { result: `Remote tool error (${eff}): ${err.message}`, isError: true };
          }
        }
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/voice-remote-routing.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Run nearby suites for regressions**

Run: `node --test tests/remote-voice-tools.test.js tests/voice-remote-routing.test.js tests/remote-blocks.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git commit servers/gateway/ai/tool-executor.js tests/voice-remote-routing.test.js -m "feat(voice): route remote tools in executeTool, local path unchanged"
git show --stat HEAD
```

---

## Task A8: Re-export `buildRemoteVoiceContext`

**Files:**
- Modify: `servers/gateway/ai/tool-executor.js`

- [ ] **Step 1: Add the re-export**

After the imports block in `servers/gateway/ai/tool-executor.js` (after line 24), add:

```js
export { buildRemoteVoiceContext } from "./remote-voice-tools.js";
```

- [ ] **Step 2: Verify**

Run: `node -e "import('./servers/gateway/ai/tool-executor.js').then(m => console.log(typeof m.buildRemoteVoiceContext))"`
Expected: prints `function`.

- [ ] **Step 3: Commit**

```bash
git commit servers/gateway/ai/tool-executor.js -m "chore(voice): re-export buildRemoteVoiceContext"
git show --stat HEAD
```

---

## Task A9: Wire the voice loop

**Files:**
- Modify: `bundles/meta-glasses/panel/routes.js` (`runVoiceTurn`: destructure line 785; hoist `remoteVoice` near line 789; build near line 937; close in `finally` line 1315)

- [ ] **Step 1: Add to the loadToolExec destructure (line 785)**

Append `buildRemoteVoiceContext` to the destructured names:

```js
    const { createToolExecutor, getChatTools, MAX_TOOL_ROUNDS, effectiveToolName, isExternalSendTool, isConnectedAddonTool, botVoiceScope, buildRemoteVoiceContext } = await loadToolExec();
```

- [ ] **Step 2: Hoist `remoteVoice` next to `toolExecutor` (line ~789)**

Where `let toolExecutor = null;` is declared at the top of `runVoiceTurn`, add beside it:

```js
  let remoteVoice = null;
```

- [ ] **Step 3: Build + pass it (replace lines 937-938)**

Replace:

```js
    toolExecutor = createToolExecutor({ botDef: boundBot });
    const tools = getChatTools({ botDef: boundBot });
```

with:

```js
    // Cross-instance voice tools — null unless this bound bot opted into
    // remote_mcp AND feature_flags.remote_invocation. A down peer / discovery
    // error degrades to local (returns null, never throws), so the turn works.
    try {
      remoteVoice = await buildRemoteVoiceContext(db, boundBot);
    } catch (err) {
      console.warn(`[meta-glasses] remote voice tools unavailable: ${err.message}`);
    }
    toolExecutor = createToolExecutor({ botDef: boundBot, remote: remoteVoice });
    const tools = getChatTools({ botDef: boundBot, remoteTools: remoteVoice?.advertised });
    if (remoteVoice) console.log(`[meta-glasses] remote voice tools: ${remoteVoice.advertised.map(t => t.name).join(", ")}`);
```

- [ ] **Step 4: Close in `finally` (line 1315)**

After `if (toolExecutor) { try { await toolExecutor.close(); } catch {} }`, add:

```js
    if (remoteVoice) { try { await remoteVoice.close(); } catch {} }
```

- [ ] **Step 5: Verify the gateway boots**

Run: `node servers/gateway/index.js --no-auth`
Expected: starts without throwing. Ctrl-C to exit.

- [ ] **Step 6: Commit**

```bash
git commit bundles/meta-glasses/panel/routes.js -m "feat(voice): wire federated remote tools into the glasses voice loop"
git show --stat HEAD
```

---

# Phase B — Cross-instance audio transport

## Task B1: `crow-peer:<id>` auth sentinel in `pushAudioStream`

**Files:**
- Modify: `bundles/meta-glasses/panel/routes.js` (`pushAudioStream` auth resolution, line 2794-2798)

The rewritten envelope carries `auth:"crow-peer:<instanceId>"`. `pushAudioStream` must resolve that to the peer bearer for that instance (the same token the voice loop uses to reach the peer). The static `AUDIO_STREAM_AUTH_SENTINELS` map can't express the per-instance form, so extend the resolver.

- [ ] **Step 1: Implement**

In `bundles/meta-glasses/panel/routes.js`, replace the auth-injection block (lines 2794-2798):

```js
    const headers = {};
    if (auth && AUDIO_STREAM_AUTH_SENTINELS[auth]) {
      const token = AUDIO_STREAM_AUTH_SENTINELS[auth]();
      if (token) headers.Authorization = `Bearer ${token}`;
    }
```

with:

```js
    const headers = {};
    let bearer = null;
    if (auth && AUDIO_STREAM_AUTH_SENTINELS[auth]) {
      bearer = AUDIO_STREAM_AUTH_SENTINELS[auth]();
    } else if (typeof auth === "string" && auth.startsWith("crow-peer:")) {
      // Federated audio: stream through the owning instance's /audio/stream
      // proxy, authed with that peer's bearer (same token the voice loop uses).
      const instId = auth.slice("crow-peer:".length);
      try {
        const { getPeerCreds } = await import(pathToFileURL(join(gatewayDir, "..", "shared", "peer-credentials.js")).href);
        bearer = getPeerCreds(instId)?.auth_token || null;
      } catch (err) {
        console.warn(`[meta-glasses] crow-peer auth resolve failed for ${instId}: ${err.message}`);
      }
    }
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
```

> NOTE: `pathToFileURL`, `join`, and `gatewayDir` are already imported/defined at the top of this file (lines 27, 25, 67). Verify before editing.

- [ ] **Step 2: Verify the bundle still loads**

Run: `node -e "import('./bundles/meta-glasses/panel/routes.js').then(()=>console.log('ok'))"`
Expected: prints `ok` (no syntax/import error).

- [ ] **Step 3: Commit**

```bash
git commit bundles/meta-glasses/panel/routes.js -m "feat(audio): resolve crow-peer:<id> auth sentinel for federated streams"
git show --stat HEAD
```

---

## Task B2: Gateway audio stream-proxy on the owning instance

**Files:**
- Create: `servers/gateway/routes/audio-proxy.js`
- Modify: `servers/gateway/index.js` (mount the router after `instanceAuthMiddleware`, line 349)
- Test: `tests/audio-proxy.test.js`

`GET /audio/stream?cap=funkwhale&id=<uuid>&codec=<mp3|ogg|opus>` — peer-authed (global `instanceAuthMiddleware` sets `req.instanceAuth`), exposure-gated (`getExposedCapabilities` must include `funkwhale`), reconstructs the listen URL from the **owning instance's** Funkwhale addon env (never from caller input → no SSRF), fetches with the local token (dropping the bearer on the storage redirect), and streams the bytes back. Funnel-blocked automatically (not in `PUBLIC_FUNNEL_PREFIXES`).

- [ ] **Step 1: Write the failing test**

Create `tests/audio-proxy.test.js`. The route logic is split into a pure validator + a fetch-injected handler so it's testable without a live Funkwhale:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAudioParams } from "../servers/gateway/routes/audio-proxy.js";

test("validateAudioParams accepts a funkwhale listen request", () => {
  const v = validateAudioParams({ cap: "funkwhale", id: "abc12345-dead-beef-cafe-0123456789ab", codec: "opus" });
  assert.equal(v.ok, true);
  assert.equal(v.id, "abc12345-dead-beef-cafe-0123456789ab");
  assert.equal(v.codec, "opus");
});

test("validateAudioParams rejects bad cap / id / codec", () => {
  assert.equal(validateAudioParams({ cap: "evil", id: "abc", codec: "opus" }).ok, false);
  assert.equal(validateAudioParams({ cap: "funkwhale", id: "../etc/passwd", codec: "opus" }).ok, false);
  assert.equal(validateAudioParams({ cap: "funkwhale", id: "abc", codec: "wav" }).ok, false);
  assert.equal(validateAudioParams({ cap: "funkwhale", id: "", codec: "opus" }).ok, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/audio-proxy.test.js`
Expected: FAIL — module/function not found.

- [ ] **Step 3: Write minimal implementation**

Create `servers/gateway/routes/audio-proxy.js`:

```js
/**
 * Owning-instance audio stream-proxy (federated playback).
 *
 * A paired peer (e.g. grackle's glasses voice loop) cannot reach this instance's
 * internal Funkwhale (http://crow-funkwhale) nor hold its token. This route lets
 * the peer stream audio THROUGH us: we reconstruct the listen URL from OUR OWN
 * Funkwhale addon env (never from caller input — no SSRF), fetch it with OUR
 * token, follow the storage redirect (dropping the bearer), and stream the bytes
 * back to the peer. The peer authenticates with its instance bearer
 * (instanceAuthMiddleware) and the funkwhale capability must be exposed to peers.
 *
 * Mounted under /audio → outside PUBLIC_FUNNEL_PREFIXES → Funnel-blocked.
 */
import { Router } from "express";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getExposedCapabilities } from "../peer-exposure.js";
import { resolveCrowHome } from "../proxy.js";

const ID_RE = /^[0-9a-fA-F-]{8,64}$/;
const CODECS = new Set(["mp3", "ogg", "opus"]);

/** Pure param validation (testable). */
export function validateAudioParams({ cap, id, codec } = {}) {
  if (cap !== "funkwhale") return { ok: false, error: "unsupported_capability" };
  if (typeof id !== "string" || !ID_RE.test(id)) return { ok: false, error: "bad_id" };
  if (!CODECS.has(codec)) return { ok: false, error: "bad_codec" };
  return { ok: true, id, codec };
}

/** Read the local Funkwhale addon env from ~/.crow/mcp-addons.json. */
export function readFunkwhaleEnv(crowHome = resolveCrowHome()) {
  try {
    const cfg = JSON.parse(readFileSync(join(crowHome, "mcp-addons.json"), "utf8"));
    const fw = cfg?.funkwhale?.env || cfg?.funkwhale || {};
    const url = fw.FUNKWHALE_URL || cfg?.funkwhale?.FUNKWHALE_URL;
    const token = fw.FUNKWHALE_ACCESS_TOKEN || cfg?.funkwhale?.FUNKWHALE_ACCESS_TOKEN;
    if (url && token) return { url: String(url).replace(/\/+$/, ""), token: String(token) };
  } catch { /* not installed / unreadable */ }
  return null;
}

export default function audioProxyRouter({ createDbClient, fetchImpl = fetch, fwEnv = readFunkwhaleEnv } = {}) {
  const router = Router();

  router.get("/audio/stream", async (req, res) => {
    if (!req.instanceAuth?.instance) return res.status(401).json({ error: "peer_auth_required" });

    const v = validateAudioParams({ cap: req.query.cap, id: req.query.id, codec: req.query.codec });
    if (!v.ok) return res.status(400).json({ error: v.error });

    const db = createDbClient();
    try {
      const exposed = await getExposedCapabilities(db);
      if (!exposed.has("funkwhale")) return res.status(403).json({ error: "not_exposed" });
    } finally { try { db.close(); } catch {} }

    const fw = fwEnv();
    if (!fw) return res.status(503).json({ error: "funkwhale_not_configured" });

    const listenUrl = `${fw.url}/api/v1/listen/${encodeURIComponent(v.id)}/?to=${v.codec}`;
    try {
      let up = await fetchImpl(listenUrl, { redirect: "manual", headers: { Authorization: `Bearer ${fw.token}` } });
      if (up.status >= 300 && up.status < 400) {
        const loc = up.headers.get("location");
        if (!loc) return res.status(502).json({ error: "redirect_no_location" });
        // Storage redirect carries its own auth — drop our bearer on this hop.
        up = await fetchImpl(new URL(loc, listenUrl).toString(), { redirect: "follow" });
      }
      if (!up.ok || !up.body) return res.status(502).json({ error: `upstream_${up.status}` });

      res.status(200);
      const ct = up.headers.get("content-type"); if (ct) res.setHeader("content-type", ct);
      const cl = up.headers.get("content-length"); if (cl) res.setHeader("content-length", cl);

      const reader = up.body.getReader();
      res.on("close", () => { try { reader.cancel(); } catch {} });
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!res.write(Buffer.from(value))) await new Promise((r) => res.once("drain", r));
      }
      res.end();
    } catch (err) {
      if (!res.headersSent) res.status(502).json({ error: String(err.message || err) });
      else { try { res.end(); } catch {} }
    }
  });

  return router;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/audio-proxy.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Mount the router**

In `servers/gateway/index.js`, after the `instanceAuthMiddleware` line (349), add:

```js
import audioProxyRouter from "./routes/audio-proxy.js";
app.use(audioProxyRouter({ createDbClient }));
```

(Place the `import` with the other top-of-file imports; place the `app.use` right after line 349 so `req.instanceAuth` is populated.)

- [ ] **Step 6: Verify the gateway boots with the route**

Run: `node servers/gateway/index.js --no-auth` then in another shell `curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:<gateway_port>/audio/stream?cap=funkwhale&id=abc&codec=opus"`
Expected: `401` (no peer auth) — proves the route is mounted and the auth gate fires. Ctrl-C the server.

- [ ] **Step 7: Commit**

```bash
git commit servers/gateway/routes/audio-proxy.js servers/gateway/index.js tests/audio-proxy.test.js -m "feat(audio): peer-authed funkwhale stream-proxy on the owning instance"
git show --stat HEAD
```

---

## Task B3: Full-suite + review gate

**Files:** none (verification)

- [ ] **Step 1: Run the full suite**

Run: `for f in tests/*.test.js; do node --test "$f" || echo "FAILED: $f"; done`
Expected: no `FAILED:` lines.

- [ ] **Step 2: Request code review**

Use `superpowers:requesting-code-review` (or `/quick-review`) over the diff (6 files). Address via `superpowers:receiving-code-review`.

- [ ] **Step 3: Security audit (read-only)**

Confirm in the diff:
- `/audio/stream` rejects without `req.instanceAuth.instance` and when `funkwhale` not in `remote_exposed_tools`; reconstructs the URL from local env only (no caller-supplied host) — no SSRF.
- `callRemote` never sets `instance_id` (C3, tested).
- The crow-peer bearer is injected only into a fetch whose host is the peer's own `gateway_url` (grackle built it) — not an arbitrary host.
- Remote tools intentionally bypass the source-side addon allowlist; the target's exposure gate is the boundary (C4, documented in the module header).

---

# Phase C — Deploy + configure (manual; no repo change)

> Operator steps. Where a value is unknown, the step says how to find it (per "verify, don't assume").

- [ ] **Step 1: Deploy code to grackle + crow**

```bash
grackle "cd ~/crow && git pull --rebase && sudo systemctl restart crow-gateway"
# On crow: pull main, restart crow-gateway (main crow instance — the funkwhale owner after Step 2)
cd ~/crow && git pull --rebase && sudo systemctl restart crow-gateway
```

- [ ] **Step 2: Move the Funkwhale addon onto the main crow instance**

The container `crow-funkwhale` is machine-level (unchanged). Copy the **entire** funkwhale entry from `~/.crow-mpa/mcp-addons.json` into `~/.crow/mcp-addons.json` — not just `env`, but `command`/`args`/`cwd`/`env` verbatim (the entry has an explicit machine-absolute `cwd: /home/kh0pp/crow/bundles/funkwhale` + `FUNKWHALE_URL`/`FUNKWHALE_ACCESS_TOKEN`; `readFunkwhaleEnv` in the audio-proxy reads exactly this file). Then restart the main crow gateway. Verify the addon connected + tools present:

```bash
cd ~/crow && curl -s "http://localhost:<crow_gateway_port>/health" | grep -i funkwhale
# expect funkwhale connected with N tools
```

Decide whether to also remove funkwhale from MPA: if the Maestro-Press bots don't use music, remove `~/.crow-mpa/mcp-addons.json` funkwhale + restart `crow-mpa-gateway` to truly un-split. If unsure, leave it (harmless; grackle will target main crow regardless).

- [ ] **Step 3: Expose the `funkwhale` capability to peers on main crow**

Ensure `remote_exposed_tools` on the main crow instance includes `funkwhale` (Settings → Multi-Instance → Remote Tool Exposure, or the same `writeSetting(db,'remote_exposed_tools',…,{scope:'local'})` the panel uses). Verify:

```bash
cd ~/crow && node -e "import('./servers/db.js').then(async({createDbClient})=>{const db=createDbClient();const {getExposedCapabilities}=await import('./servers/gateway/peer-exposure.js');console.log([...await getExposedCapabilities(db)]);db.close();})"
```

Expected: array includes `funkwhale`.

- [ ] **Step 4: Confirm grackle ↔ main crow are paired with a gateway_url**

```bash
grackle "cd ~/crow && node -e \"import('./servers/db.js').then(async({createDbClient})=>{const db=createDbClient();const {rows}=await db.execute('SELECT id,name,gateway_url,status FROM crow_instances');console.table(rows);db.close();})\""
```

Record the **main crow** instance's `id` (status `active`, the `gateway_url` whose `/router/mcp` owns funkwhale) → `<CROW_ID>`. Confirm `getPeerCreds(<CROW_ID>)` has a token on grackle:

```bash
grackle "cd ~/crow && node -e \"import('./servers/shared/peer-credentials.js').then(({getPeerCreds})=>console.log(getPeerCreds('<CROW_ID>')?.auth_token?'token present':'MISSING'))\""
```

- [ ] **Step 5: Enable `feature_flags.remote_invocation` on grackle**

Read-merge-write (don't clobber other flags), then verify:

```bash
grackle "cd ~/crow && node -e \"import('./servers/db.js').then(async({createDbClient})=>{const db=createDbClient();const {readSetting}=await import('./servers/gateway/dashboard/settings/registry.js');const {parseRemoteInvocationFlag}=await import('./scripts/pi-bots/remote-blocks.mjs');console.log('remote_invocation:',parseRemoteInvocationFlag(await readSetting(db,'feature_flags')));db.close();})\""
```

Expected: `remote_invocation: true`.

- [ ] **Step 6: Point `crow-glasses` at main crow's funkwhale**

Set `definition.tools.remote_mcp = [...existing, "<CROW_ID>::funkwhale"]` on grackle's `crow-glasses` bot (preserve existing entries). Verify:

```bash
grackle "cd ~/crow && node -e \"import('./servers/db.js').then(async({createDbClient})=>{const db=createDbClient();const {remoteServersForBot}=await import('./scripts/pi-bots/remote-blocks.mjs');const {rows}=await db.execute({sql:'SELECT definition FROM pi_bot_defs WHERE bot_id LIKE ?',args:['%glasses%']});console.log(remoteServersForBot(JSON.parse(rows[0].definition)));db.close();})\""
```

Expected: `[ { instanceId: '<CROW_ID>', canonicalId: 'funkwhale' } ]`.

- [ ] **Step 7: Remove grackle's dead local funkwhale addon**

Confirm nothing on grackle depends on a local funkwhale, then remove its entries from grackle's `~/.crow/installed.json` + `~/.crow/mcp-addons.json` (the dead `https://grackle…:8446`), and restart grackle's gateway. Verify it's gone:

```bash
grackle "cd ~/crow && curl -s localhost:<grackle_gateway_port>/health | grep -i funkwhale || echo 'no local funkwhale (good)'"
```

- [ ] **Step 8: E2E — play music by voice**

Reopen the glasses app (gateway restart drops the device WS). Say: **"shuffle play my music."**

> Note: exposing/selecting the `funkwhale` capability rides ALL its tools in at once (`fw_search`, `fw_play`, `fw_play_album`, …) — they share the single `funkwhale` exposure + the single `<CROW_ID>::funkwhale` selection. "Play my music" is typically a **chain**: the model calls `fw_search`/`fw_list_library` to get a track UUID, then `fw_play` with it (the advertised schema is permissive, so the model relies on the tool descriptions to know `fw_play` needs a UUID from search first). Expect 2-3 tool rounds, not one. If the model fails to chain, that's the most likely flake — check the round log.

Expected:
- grackle log: `[meta-glasses] remote voice tools: fw_play, fw_search, ...` then a successful `fw_play` round.
- main crow log: peer-exposure audit row `tools/call:crow_tools` → `200`, then a `GET /audio/stream` hit from grackle.
- **Audio actually plays through the glasses** from crow's 8,386-track library.

- [ ] **Step 9: Negative checks**

- Flag off on grackle → restart → glasses bot no longer sees `fw_play` (log shows no remote tools). Re-enable.
- Un-expose `funkwhale` on main crow → `fw_play` routes but `/audio/stream` returns 403 and playback fails cleanly (no crash). Re-expose.

---

## Self-review (against the spec + reviewer)

- **Spec §Design.1 (voice executor remote routing)** → A5, A7.
- **Spec §Design.1 (tool→capability; crow_discover authoritative)** → A1, A2.
- **Spec §Design.2 (wire voice loop)** → A9.
- **Spec §Design.3 (configure crow-glasses)** → C Steps 5-6.
- **Spec §Design.4 (remove grackle's local funkwhale)** → C Step 7.
- **Spec §Design.5 (tests + E2E)** → A/B unit tests + C Step 8.
- **Spec §Risks (behind per-bot config + flag; local path unchanged)** → A7 tests; `opts.remote` defaults null.
- **Spec §Risks (unambiguous tool→capability)** → A2 (route only owned names; first-wins).
- **Reviewer C1/C2 (audio transport)** → Phase B (proxy + envelope rewrite + crow-peer sentinel) + A3.
- **Reviewer C3 (no instance_id)** → A5 callRemote + test.
- **Reviewer C4 (source-side allowlist bypass; target gate is the boundary)** → module header + A7/B security audit.
- **Reviewer C5 (per-turn latency)** → A5 discovery cache + lazy routing client.
- **Topology change (funkwhale → main crow)** → C Step 2-3.

## Known v1 limitations (intentional, follow-ups)

- **Permissive tool schemas** (`{type:"object", additionalProperties:true}` + description). Funkwhale + `crow_tools` normalization tolerate this; richer per-tool schemas (`crow_discover{category,action}`) are a later enhancement.
- **No seeking/range** through the audio proxy (mirrors today's local behavior; Funkwhale streams full).
- **Funkwhale-only audio rewrite** (`cap=funkwhale`). Generalizing the proxy to other streaming caps is a follow-up; the rewrite/route are written so adding a `cap` is small.
- **`getPeerCreds` disk read per track** (code-review Issue 3, low): `pushAudioStream`'s `crow-peer:` branch resolves the bearer via `getPeerCreds` (a `readFileSync`) on every track incl. each album-queue entry. Fine at current scale; cache per-turn if album playback gets heavy.
- **Audio-proxy redirect chain uncapped** (code-review Issue 4, low/defense-in-depth): the storage-hop follow uses `redirect:"follow"` (mirrors the existing `pushAudioStream` prior art). The upstream is built only from local env (trust anchor), so not exploitable in-topology; a max-hop cap is a hardening follow-up.

---

## Review history

**v1 — REJECT (2026-06-14).** Staff-engineer adversarial review found the routing layer sound but the user-facing goal (music) unmet: `fw_play`'s `_audio_stream` URL is owning-instance-internal and its `auth:"funkwhale"` sentinel resolves to the consuming instance's (removed) token — so audio never plays (C1/C2). Also flagged C3 (no `instance_id`), C4 (source-side allowlist bypass), C5 (per-turn discovery latency). Verified all against source.

**Operator decisions (2026-06-15):** keep glasses bot on grackle + build the feature; audio via gateway stream-proxy; consolidate Funkwhale onto main crow.

**v2 (this document):** adds Phase B (audio transport) + A3 (envelope rewrite) + C5 cache + C3/C4 handling, and retargets deploy to main crow.

**v2 — APPROVE (2026-06-15).** Re-review traced the full audio chain against source and confirmed it works end-to-end (routing → envelope rewrite → formatResult preservation → interceptor → crow-peer bearer → /audio/stream proxy → album queue). Folded in: lazy-client promise-caching (concurrency), the search→play chain note in C Step 8, and the "copy the whole addon entry incl. cwd" note in C Step 2. Ready to execute.
