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

const LISTEN_ID_RE = /\/listen\/([0-9a-fA-F-]+)\//;

/**
 * Rewrite one {url, codec, auth, ...} stream descriptor to the owning instance's
 * /audio/stream proxy. Returns null for anything we cannot safely proxy (no url,
 * or a non-funkwhale-listen url). SECURITY: the descriptor comes from a remote
 * peer's tool result. A non-listen url must NOT pass through unchanged — it would
 * carry the peer-supplied url + auth sentinel into pushAudioStream, which would
 * then attach a bearer and fetch an attacker-chosen host (credential exfil/SSRF).
 * For matched urls we OVERRIDE both url (→ our /audio/stream on the called
 * instance's gateway) and auth (→ crow-peer:<the instance we actually called>),
 * so a peer cannot redirect the bearer or name a different victim instance.
 */
function rewriteStream(s, gatewayUrl, instanceId) {
  if (!s || typeof s.url !== "string") return null;
  const m = s.url.match(LISTEN_ID_RE);
  if (!m) return null;
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
 * object. No-op for results without a funkwhale audio envelope. An envelope we
 * can't safely proxy (non-funkwhale-listen url) is DROPPED entirely rather than
 * forwarded with its peer-supplied url/auth (see rewriteStream security note).
 */
export function rewriteAudioResult(result, gatewayUrl, instanceId) {
  for (const block of result?.content || []) {
    if (block.type !== "text" || typeof block.text !== "string") continue;
    if (!block.text.includes('"_audio_stream"')) continue;
    try {
      const parsed = JSON.parse(block.text);
      const env = parsed._audio_stream;
      if (!env || typeof env.url !== "string") continue;
      const head = rewriteStream(env, gatewayUrl, instanceId);
      if (!head) {
        // Not a proxyable funkwhale stream — strip it so nothing downstream
        // fetches a peer-controlled url with a bearer attached.
        delete parsed._audio_stream;
        block.text = JSON.stringify(parsed);
        continue;
      }
      head.queue = Array.isArray(env.queue)
        ? env.queue.map((q) => rewriteStream(q, gatewayUrl, instanceId)).filter(Boolean)
        : undefined;
      if (!head.queue) delete head.queue;
      parsed._audio_stream = head;
      block.text = JSON.stringify(parsed);
    } catch { /* not JSON — leave untouched */ }
  }
  return result;
}

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
    urls: wantedIds.slice().sort().map(id => `${id}=${urls.get(id)}`),
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
  // orphaning a connection.
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
    let client;
    try {
      client = await clientFor(route.instanceId);
    } catch (err) {
      // A transient connect failure must not poison the cached promise for the
      // rest of the turn — clear it so a later call (e.g. fw_play after a failed
      // fw_search) gets a fresh attempt.
      clients.delete(route.instanceId);
      throw err;
    }
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
