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
 * per turn, in primeBareServerTools(), which the rails call before the spawn.
 * primeBareServerTools RETURNS the validated names it has for this def's bare entries:
 * that returned map is an explicit snapshot, carried on `piRpcOpts.bareServerTools`, and
 * it is the ONLY thing the synchronous csv assembly reads. The budget check and the
 * spawn therefore see the same listing, and a later turn's cache cannot change a spawn
 * that was already decided. A server that cannot be listed keeps today's spelling
 * (`mcp__<id>`) and warns once per process: a broken server must never break a turn.
 *
 * Tool names are provider data (an add-on may list anything at all), so a name is only
 * kept when pi-lab's `mcp__<id>__<name>` spelling it produces is a plausible tool name:
 * `^[A-Za-z0-9_-]+$` and at most PI_TOOL_NAME_MAX characters overall. Without that, a
 * listed name like `ok_tool,read` would be joined into pi's `--tools` csv and hand the
 * model a built-in (`read`) the def never granted.
 */
import { mcpAddonBlockFor, extensionTools } from "./ext_registry.mjs";
import { crowServerCatalog } from "./crow-server-catalog.mjs";
import { probeServerTools } from "./mcp_writer.mjs";
import { ADDON_KEYS_UNREADABLE } from "../../servers/shared/addon-secrets.js";
// The providers refuse a pi tool name longer than this (I10); the same limit
// service-blocks.mjs applies to the names it emits.
import { PI_TOOL_NAME_MAX } from "./service-blocks.mjs";

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
/**
 * What a sealed add-on's entry looks like instead of a listing when THIS process cannot
 * unseal its keychain values. Named apart from a broken server so an operator can tell
 * "enter the keys again here" from "the server does not start".
 */
const SEALED_ADDON_REASON = "sealed add-on: keys are not readable from this process";

/** A listed tool name becomes part of `mcp__<id>__<name>`: only this alphabet is safe. */
export const TOOL_NAME_RE = /^[A-Za-z0-9_-]+$/;
/** A server id is both a block name and half of every tool name it expands to. */
export const SERVER_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * One listing per Crow home per server id: two homes on one box (or a scratch home in a
 * test) can hold different versions of the same add-on, so an id alone is not a key.
 */
const cacheKey = (crowHome, serverId) => String(crowHome ?? "") + "\0" + String(serverId);

/** home+id -> {tools: string[], at: number, ok: boolean} */
const cache = new Map();
/** home+id already warned about "no listing" in THIS process (one line per id, ever). */
const warned = new Set();
/** home+id already warned about dropped tool names (one line per id, ever). */
const warnedNames = new Set();
/** home+id -> the ONE listing promise in flight for it (concurrent primes share it). */
const inflight = new Map();

/**
 * A bare server entry: a non-empty name with no "/" (not a per-tool entry), no "__"
 * (not an already-spelled pi tool name) and not itself prefixed with "mcp__".
 */
export function isBareServerEntry(entry) {
  return typeof entry === "string" && entry.length > 0
    && !entry.includes("/") && !entry.includes("__") && !entry.startsWith("mcp__");
}

/** A server id that may be expanded and probed at all (F1). */
export function isValidServerId(serverId) {
  return typeof serverId === "string" && SERVER_ID_RE.test(serverId);
}

/** The cache entry while it is still inside its own TTL (positive: 5 min, failed: 60 s). */
function freshEntry(crowHome, serverId, now) {
  const e = cache.get(cacheKey(crowHome, serverId));
  if (!e) return null;
  const ttl = e.ok ? BARE_TOOLS_TTL_MS : BARE_TOOLS_FAILED_TTL_MS;
  return now - e.at < ttl ? e : null;
}

/**
 * The server's own tool names (e.g. "studio_play") from a cached OK entry, else null.
 * A stale positive entry is null too: the rail primes it again before the next spawn.
 * Nothing on the turn path reads this — the spawn uses the map primeBareServerTools
 * returned (piRpcOpts.bareServerTools). This is the cache's own read, for diagnostics
 * and tests.
 */
export function getBareServerTools(serverId, { crowHome, now = Date.now() } = {}) {
  const e = freshEntry(crowHome, serverId, now);
  return e && e.ok && Array.isArray(e.tools) ? e.tools : null;
}

/** Test seam: forget every cached listing, every warning and every in-flight probe. */
export function _resetBareServerToolsForTest() {
  cache.clear();
  warned.clear();
  warnedNames.clear();
  inflight.clear();
}

/**
 * Test seam: plant a listing (or a failure) in the cache for one home, so a caller can
 * exercise the cache paths without spawning anything. Planting alone does not change an
 * expansion: a spawn's csv is built from the map primeBareServerTools returned.
 */
export function _setBareServerToolsForTest(serverId, tools, { crowHome, now = Date.now(), ok = true } = {}) {
  cache.set(cacheKey(crowHome, serverId), { tools: Array.isArray(tools) ? tools.slice() : [], at: now, ok: !!ok });
}

/** The names a probe/extension listing returned (the shape probeServerTools reports). */
function toolNames(tools) {
  return (Array.isArray(tools) ? tools : [])
    .map((t) => (t && typeof t.name === "string" ? t.name : null))
    .filter(Boolean);
}

/**
 * Only the names that form a legitimate pi tool name as `mcp__<id>__<name>`: the
 * alphabet pi-lab's own registrations use, and within the provider's length limit.
 * Everything else is dropped — a name is data from a server, never a grant.
 */
export function validToolNames(serverId, names) {
  const prefix = `mcp__${serverId}__`;
  return (Array.isArray(names) ? names : []).filter((n) =>
    typeof n === "string" && TOOL_NAME_RE.test(n) && prefix.length + n.length <= PI_TOOL_NAME_MAX);
}

/** A listing result plus how many names validation dropped (the warning's subject). */
function listing(serverId, names) {
  const valid = validToolNames(serverId, names);
  return { tools: valid, dropped: names.length - valid.length };
}

/**
 * List one server's tools. Per-instance add-ons go through ext_registry.extensionTools
 * (it handles a sealed entry and refuses a connection service); anything else the Crow
 * catalog can spawn is probed directly. Never throws — a caller turns a throw into a
 * failure reason.
 * @returns {Promise<{tools?: string[], dropped?: number, error?: string, skip?: boolean}>}
 */
async function listServerTools(serverId, { crowHome, probe }) {
  const addon = mcpAddonBlockFor(serverId, crowHome);
  if (addon) {
    // A satellite-hosted bundle has no local server to spawn — crow reaches it through its own
    // satellite tool entry, and the grant (a satellite block) is what carries its tools. So there
    // is nothing to list: silent, no probe, and the entry keeps today's spelling `mcp__<id>` (a
    // revoked or ungranted satellite must stay with NO tools, never with a local expansion).
    if (addon.transport === "satellite") return { skip: true };
    // A SEALED add-on (its env names keychain values) is not readable from this process: the
    // bridge and the job runner are not the gateway, so extensionTools returns
    // ADDON_KEYS_UNREADABLE and the entry keeps `mcp__<id>` on channel and job turns. The
    // gateway-side Perch spawn CAN unseal, so the very same def expands there. That asymmetry is
    // known and accepted; the warning below names it so it is not read as a broken server.
    const res = await extensionTools(serverId, { crowHome, probe });
    if (res && res.ok) return listing(serverId, toolNames(res.tools));
    const error = String((res && res.error) || "the probe failed");
    if (error.includes(CONNECTION_SERVICE_REASON)) return { skip: true };
    if (error.includes(ADDON_KEYS_UNREADABLE)) return { error: SEALED_ADDON_REASON };
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
  if (res && res.ok) return listing(serverId, toolNames(res.tools));
  return { error: String((res && res.error) || "the probe failed") };
}

/**
 * One listing attempt per (home, server) at a time: concurrent primes of the same id share
 * the promise that is already running, so a burst of turns probes the server once.
 */
function listOnce(crowHome, serverId, { probe }) {
  const key = cacheKey(crowHome, serverId);
  const running = inflight.get(key);
  if (running) return running;
  const p = listServerTools(serverId, { crowHome, probe })
    .finally(() => { if (inflight.get(key) === p) inflight.delete(key); });
  inflight.set(key, p);
  return p;
}

/** One line per (home, server id) per process: the entry keeps its old spelling, so say so once. */
function warnUnlisted(crowHome, serverId, reason, log) {
  const key = cacheKey(crowHome, serverId);
  if (warned.has(key)) return;
  warned.add(key);
  try {
    log('bare server "' + serverId + '" in crow_mcp could not be listed (' + reason + '); its entry stays "mcp__'
      + serverId + '" and matches no tool');
  } catch { /* a logger that throws must not break the turn */ }
}

/** One line per (home, server id): names that are not a pi tool name were dropped, never granted. */
function warnDroppedNames(crowHome, serverId, dropped, log) {
  const key = cacheKey(crowHome, serverId);
  if (warnedNames.has(key) || !dropped) return;
  warnedNames.add(key);
  try {
    log('bare server "' + serverId + '" in crow_mcp listed ' + dropped
      + ' tool name(s) that are not a valid pi tool name (letters, digits, "_" and "-" only, and at most '
      + PI_TOOL_NAME_MAX + ' characters as mcp__' + serverId + '__<name>); they are not granted');
  } catch { /* a logger that throws must not break the turn */ }
}

/**
 * Fill the cache for every bare entry of this turn's def, in parallel across servers, and
 * RETURN the listing snapshot this turn spawns with: `{ [serverId]: string[] }`, holding
 * the validated tool names of every bare entry that has a usable listing (a fresh cache
 * hit, or a listing taken now). An entry whose server could not be listed is ABSENT, so
 * the caller keeps `mcp__<id>` for it. A server id that is not a valid id is never
 * expanded and never probed. Nothing is probed twice: a fresh entry (positive, or a
 * failure inside its 60 s window) is left alone, and concurrent primes of one (home,
 * server) share one probe. NEVER throws — an unresolvable or failed server only warns.
 *
 * @param {object} def  the effective def (its `tools.crow_mcp` entries are read)
 * @param {{crowHome?: string, log?: Function, probe?: Function, now?: number}} [opts]
 *   `probe` is the test seam, threaded into extensionTools and used in place of
 *   probeServerTools for a catalog block; `now` is the clock seam for the TTLs.
 * @returns {Promise<Object<string, string[]>>}
 */
export async function primeBareServerTools(def, { crowHome, log = () => {}, probe, now = Date.now() } = {}) {
  const out = {};
  try {
    const list = (def && def.tools && def.tools.crow_mcp) || [];
    const want = [];
    for (const entry of Array.isArray(list) ? list : []) {
      if (!isBareServerEntry(entry) || want.includes(entry)) continue;
      if (!isValidServerId(entry)) {
        // Not a server id (a comma, a space, a newline ...): never probed, never expanded.
        warnUnlisted(crowHome, entry, "not a valid server id (letters, digits, _ and - only)", log);
        continue;
      }
      const fresh = freshEntry(crowHome, entry, now);
      if (fresh) {
        if (fresh.ok && fresh.tools.length) out[entry] = fresh.tools.slice();
        continue;
      }
      want.push(entry);
    }
    await Promise.all(want.map(async (serverId) => {
      let res;
      try {
        res = await listOnce(crowHome, serverId, { probe });
      } catch (e) {
        res = { error: (e && e.message) || String(e) };
      }
      if (res.skip) return;
      warnDroppedNames(crowHome, serverId, res.dropped || 0, log);
      const tools = validToolNames(serverId, res.tools);
      if (tools.length) {
        cache.set(cacheKey(crowHome, serverId), { tools, at: now, ok: true });
        out[serverId] = tools.slice();
        return;
      }
      cache.set(cacheKey(crowHome, serverId), { tools: [], at: now, ok: false });
      warnUnlisted(crowHome, serverId, res.error || "the server exposes no tools", log);
    }));
  } catch { /* a turn must not fail because a server could not be listed */ }
  return out;
}

/**
 * The pi tool names a BARE entry turns into, from the EXPLICIT listing snapshot this
 * spawn carries: `mcp__<id>__<tool>` per tool, minus any name in `skippedTools` (the
 * over-long ones a service block dropped). null when the entry is not bare, when there
 * is no snapshot, or when the snapshot has no listing for it — the caller then keeps its
 * own spelling (`mcp__<id>`). Nothing is read from the module cache here: the spawn uses
 * exactly the listing the budget check saw.
 *
 * Router mode note (F4): pi-lab's mcp-client registers ONE tool, `mcp__<id>`, for a
 * server in router mode (remote-blocks.mjs), not one per tool. Router mode is not
 * visible here — toolAllowlist gets no MCP config — so a router-mode server whose
 * listing SUCCEEDED would lose its gateway tool to the per-tool expansion. No local
 * block carries router today (only remote-blocks.mjs, which toolAllowlist spells on its
 * own), so the empty/unavailable case below (which keeps `mcp__<id>`) is the only one
 * that matters now; revisit if a local block gains router mode, and append `mcp__<id>`
 * alongside the expansion for it.
 *
 * @param {string} entry
 * @param {{bareServerTools?: Object<string,string[]>, skippedTools?: string[], satelliteBundles?: string[]|Set<string>}} [opts]
 *   `bareServerTools` is the explicit `{ [serverId]: string[] }` snapshot
 *   (piRpcOpts.bareServerTools). `satelliteBundles` are the bundles hosted on a satellite
 *   this turn: such a bundle is spelled from its own block (never from a local listing),
 *   so its bare entry is left alone.
 */
export function expandBareEntry(entry, { bareServerTools, skippedTools = [], satelliteBundles } = {}) {
  if (!isBareServerEntry(entry)) return null;
  if (!isValidServerId(entry)) return null;
  if (satelliteBundles) {
    const hosted = satelliteBundles instanceof Set ? satelliteBundles
      : new Set(Array.isArray(satelliteBundles) ? satelliteBundles : []);
    if (hosted.has(entry)) return null;
  }
  const explicit = bareServerTools && typeof bareServerTools === "object" && !Array.isArray(bareServerTools);
  if (!explicit) return null;
  const tools = Array.isArray(bareServerTools[entry]) ? bareServerTools[entry] : null;
  if (!tools || !tools.length) return null;
  // The snapshot may have crossed a seam (piRpcOpts), so validate its names again: a
  // listed name must never become a csv entry of its own. No valid name left means no
  // expansion at all (null), so the caller keeps `mcp__<id>` — an EMPTY array would
  // instead claim the entry and drop it from the csv.
  const valid = validToolNames(entry, tools);
  if (!valid.length) return null;
  const skip = new Set(skippedTools || []);
  return valid
    .map((t) => `mcp__${entry}__${t}`)
    .filter((n) => !skip.has(n));
}