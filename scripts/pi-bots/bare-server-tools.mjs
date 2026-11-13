#!/usr/bin/env node
/**
 * Crow Bot Builder — a BARE server entry in a bot def's `tools.crow_mcp`.
 *
 * pi's `--tools` filter matches EXACT tool names, and pi-lab registers a local MCP
 * server's tools one by one as `mcp__<server>__<tool>`. A bare entry (`"studio"`) used
 * to be spelled `mcp__studio`, which matched nothing: the server was started and every
 * one of its tools was filtered out, while the per-tool spelling (`"studio/studio_play"`
 * -> `mcp__studio__studio_play`) worked. This module lists such a server's real tool
 * names so the bare entry expands to the names pi actually offers.
 *
 * The listing is LIVE — one killed-on-finish `tools/list` probe, the same one the Bot
 * Builder Tools tab does (mcp_writer.probeServerTools) — and it happens ONCE per server
 * per turn, in primeBareServerTools(), which the rails call before the spawn. So
 * toolAllowlist() only ever READS the cache and stays synchronous and pure. A server
 * that cannot be listed keeps today's spelling (`mcp__<id>`) and warns once per process:
 * a broken server must never break a turn.
 */
import { mcpAddonBlockFor, extensionTools } from "./ext_registry.mjs";
import { crowServerCatalog } from "./crow-server-catalog.mjs";
import { probeServerTools } from "./mcp_writer.mjs";

/** How long a positive listing stays usable. */
export const BARE_TOOLS_TTL_MS = 5 * 60 * 1000;
/** How long a FAILED listing is remembered, so a broken server is not re-probed every turn. */
export const BARE_TOOLS_FAILED_TTL_MS = 60 * 1000;
/** A probe is short: it runs on the turn path, before the spawn. */
const PROBE_TIMEOUT_MS = 12000;
/**
 * ext_registry.extensionTools refuses a connection-based service with this error instead of
 * spawning it (its tools come from a project's connections, so a blind probe would have no
 * credentials). That is not a listing failure — it is skipped silently.
 */
const CONNECTION_SERVICE_REASON = "tools come from its connections";

/** serverId -> {tools: string[], at: number, ok: boolean} */
const cache = new Map();
/** Server ids already warned about in THIS process (one line per id, ever). */
const warned = new Set();

/**
 * A bare server entry: a non-empty name with no "/" (not a per-tool entry), no "__"
 * (not an already-spelled pi tool name) and not itself prefixed with "mcp__".
 */
export function isBareServerEntry(entry) {
  return typeof entry === "string" && entry.length > 0
    && !entry.includes("/") && !entry.includes("__") && !entry.startsWith("mcp__");
}

/** The cache entry while it is still inside its own TTL (positive: 5 min, failed: 60 s). */
function freshEntry(serverId, now) {
  const e = cache.get(serverId);
  if (!e) return null;
  const ttl = e.ok ? BARE_TOOLS_TTL_MS : BARE_TOOLS_FAILED_TTL_MS;
  return now - e.at < ttl ? e : null;
}

/**
 * The server's own tool names (e.g. "studio_play") from a cached OK entry, else null.
 * A stale positive entry is null too: the rail primes it again before the next spawn.
 */
export function getBareServerTools(serverId, { now = Date.now() } = {}) {
  const e = freshEntry(serverId, now);
  return e && e.ok && Array.isArray(e.tools) ? e.tools : null;
}

/** Test seam: forget every cached listing and every warning. */
export function _resetBareServerToolsForTest() {
  cache.clear();
  warned.clear();
}

/**
 * Test seam: plant a listing (or a failure) so a caller can exercise the expansion
 * without spawning anything.
 */
export function _setBareServerToolsForTest(serverId, tools, { now = Date.now(), ok = true } = {}) {
  cache.set(String(serverId), { tools: Array.isArray(tools) ? tools.slice() : [], at: now, ok: !!ok });
}

/** The names a probe/extension listing returned (the shape probeServerTools reports). */
function toolNames(tools) {
  return (Array.isArray(tools) ? tools : [])
    .map((t) => (t && typeof t.name === "string" ? t.name : null))
    .filter(Boolean);
}

/**
 * List one server's tools. Per-instance add-ons go through ext_registry.extensionTools
 * (it handles a sealed entry and refuses a connection service); anything else the Crow
 * catalog can spawn is probed directly. Never throws — a caller turns a throw into a
 * failure reason.
 * @returns {Promise<{tools?: string[], error?: string, skip?: boolean}>}
 */
async function listServerTools(serverId, { crowHome, probe }) {
  const addon = mcpAddonBlockFor(serverId, crowHome);
  if (addon) {
    // A satellite-hosted bundle has no local server to spawn — crow reaches it through its own
    // satellite tool entry, and the grant (a satellite block) is what carries its tools. So there
    // is nothing to list: silent, no probe, and the entry keeps today's spelling `mcp__<id>` (a
    // revoked or ungranted satellite must stay with NO tools, never with a local expansion).
    if (addon.transport === "satellite") return { skip: true };
    const res = await extensionTools(serverId, { crowHome, probe });
    if (res && res.ok) return { tools: toolNames(res.tools) };
    const error = String((res && res.error) || "the probe failed");
    if (error.includes(CONNECTION_SERVICE_REASON)) return { skip: true };
    return { error };
  }
  const catalog = crowServerCatalog(crowHome);
  const block = (catalog && catalog.servers && catalog.servers[serverId]) || null;
  if (!block) {
    // `unconfigured` is the catalog's own "exists but cannot be spawned here and why".
    const why = catalog && catalog.unconfigured && catalog.unconfigured[serverId];
    return { error: why ? String(why) : "no such server on this instance" };
  }
  const run = typeof probe === "function" ? probe : probeServerTools;
  const res = await run(block, { timeoutMs: PROBE_TIMEOUT_MS });
  if (res && res.ok) return { tools: toolNames(res.tools) };
  return { error: String((res && res.error) || "the probe failed") };
}

/** One line per server id per process: the entry keeps its old spelling, so say so once. */
function warnUnlisted(serverId, reason, log) {
  if (warned.has(serverId)) return;
  warned.add(serverId);
  try {
    log('bare server "' + serverId + '" in crow_mcp could not be listed (' + reason + '); its entry stays "mcp__'
      + serverId + '" and matches no tool');
  } catch { /* a logger that throws must not break the turn */ }
}

/**
 * Fill the cache for every bare entry of this turn's def, in parallel across servers.
 * Nothing is probed twice: a fresh entry (positive, or a failure inside its 60 s window)
 * is left alone. NEVER throws — an unresolvable or failed server only warns.
 *
 * @param {object} def  the effective def (its `tools.crow_mcp` entries are read)
 * @param {{crowHome?: string, log?: Function, probe?: Function, now?: number}} [opts]
 *   `probe` is the test seam, threaded into extensionTools and used in place of
 *   probeServerTools for a catalog block; `now` is the clock seam for the TTLs.
 */
export async function primeBareServerTools(def, { crowHome, log = () => {}, probe, now = Date.now() } = {}) {
  try {
    const list = (def && def.tools && def.tools.crow_mcp) || [];
    const want = [];
    for (const entry of Array.isArray(list) ? list : []) {
      if (!isBareServerEntry(entry) || want.includes(entry) || freshEntry(entry, now)) continue;
      want.push(entry);
    }
    await Promise.all(want.map(async (serverId) => {
      let res;
      try {
        res = await listServerTools(serverId, { crowHome, probe });
      } catch (e) {
        res = { error: (e && e.message) || String(e) };
      }
      if (res.skip) return;
      if (Array.isArray(res.tools) && res.tools.length) {
        cache.set(serverId, { tools: res.tools, at: now, ok: true });
        return;
      }
      cache.set(serverId, { tools: [], at: now, ok: false });
      warnUnlisted(serverId, res.error || "the server exposes no tools", log);
    }));
  } catch { /* a turn must not fail because a server could not be listed */ }
}

/**
 * The pi tool names a BARE entry turns into, from a known tool list: `mcp__<id>__<tool>`
 * per tool, minus any name in `skippedTools` (the over-long ones a service block dropped).
 * null when the entry is not bare, or no tool list is known for it — the caller then
 * keeps its own spelling (`mcp__<id>`).
 *
 * @param {string} entry
 * @param {{bareServerTools?: Object<string,string[]>, skippedTools?: string[], satelliteBundles?: string[]|Set<string>}} [opts]
 *   `bareServerTools` is an EXPLICIT `{ [serverId]: string[] }`; when absent the module
 *   cache is read through getBareServerTools(). `satelliteBundles` are the bundles hosted on
 *   a satellite this turn: such a bundle is spelled from its own block (never from a local
 *   listing), so its bare entry is left alone.
 */
export function expandBareEntry(entry, { bareServerTools, skippedTools = [], satelliteBundles } = {}) {
  if (!isBareServerEntry(entry)) return null;
  if (satelliteBundles) {
    const hosted = satelliteBundles instanceof Set ? satelliteBundles
      : new Set(Array.isArray(satelliteBundles) ? satelliteBundles : []);
    if (hosted.has(entry)) return null;
  }
  const explicit = bareServerTools && typeof bareServerTools === "object" && !Array.isArray(bareServerTools);
  const tools = explicit
    ? (Array.isArray(bareServerTools[entry]) ? bareServerTools[entry] : null)
    : getBareServerTools(entry);
  if (!Array.isArray(tools) || !tools.length) return null;
  const skip = new Set(skippedTools || []);
  return tools
    .filter((t) => typeof t === "string" && t.length > 0)
    .map((t) => `mcp__${entry}__${t}`)
    .filter((n) => !skip.has(n));
}