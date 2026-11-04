/**
 * Satellite-hosted bundles on a bot's turns (SAT-7 part B, spec §9.2 "bot mount", §9.4;
 * loopback mount helper spec §4.4/§4.5, §8 "Satellite"). ONE seam, withSatelliteBlocks, wired
 * where the services seam is wired: channel turns and card jobs (bridge.mjs handleInbound),
 * generic jobs (job_runner.mjs runJob) and every MCP-config rebuild (bot-world.mjs writeWorldMcp).
 *
 * It emits one pi MCP `{url, headers}` block per satellite-hosted bundle the bot is GRANTED:
 *
 *   http://127.0.0.1:<gatewayPort>/satellite-tools/<satellite_id>/<bundle>/mcp
 *
 * with the satellite-tools FAMILY token and the v3 `satellite-tools` actor headers. The block
 * carries no satellite credential: the mount re-checks the signature, the live scope, the
 * owner-turn/opt-in rule, the satellite's state, the host and the grant on every request, and the
 * satellite's own key never leaves this box (satellites/client.js).
 *
 * Fail closed, in this order (each "no" means no block, and the turn's config is what it was):
 *  - no granted bundle: grants are per tool (`<bundle>/<tool>` in def.tools.crow_mcp, Bot
 *    Builder's own rows) and are NEVER auto-granted (spec §9.4);
 *  - a bundle whose satellite row is missing or revoked (an unreachable one keeps its block: the
 *    call explains "<name> is unreachable (since HH:MM)");
 *  - a bundle the bot's own config already names, EXCEPT the `{disabled: true}` placeholder an
 *    unconfigured catalog entry leaves behind. A satellite-hosted bundle is always unconfigured in
 *    the local catalog (its tools come from the paired server, never a local MCP block), so
 *    mcp_writer.mjs writes exactly that placeholder for it and the block takes its place. Any
 *    other entry under that name (a real local add-on) still wins and logs the collision;
 *  - not the owner's own turn and the bot has not opted in (`satellite_bot_optins.any_turn`,
 *    Kevin's Q2 answer). The mount refuses that same combination, so emitting would only cost
 *    tool budget;
 *  - file-mode MCP delivery (helper spec §4.5: the token and the signature must never land in
 *    <sessionDir>/.mcp.json);
 *  - no satellite-tools token file, or no v3 signature for exactly this turn's tuple. A key-less
 *    bot host asks its gateway's signing relay for ["satellite-tools"] in its OWN request, and
 *    only for an owner `j:` turn (helper spec §4.4: the relay signs a scope kind for nothing else,
 *    and refusing a mixed request would strip that turn's other signatures too).
 */
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hasActorKey, presignActors, scopeRefFor, signScopeActor } from "./actor-sig.mjs";
import { mcpConfigDelivery } from "./mcp-delivery.mjs";
import { botsDbPath, resolveSqlitePath } from "./instance-paths.mjs";
import { splitEntry } from "./skill-tools.mjs";
import { gatewayListenPort } from "../../servers/gateway/listen-port.js";
// Not local-token.js: it pulls in the dashboard settings registry, which bridge.mjs must never
// load (tests/pibot-model-resolver-roles.test.js). satelliteToolsTokenPath() mirrors
// SATELLITE_TOOLS_TOKEN.path() (a test pins it).
import { resolveCrowHome } from "../../servers/shared/crow-home.js";
import { installPaths, satelliteInstalls } from "../../servers/gateway/satellites/installs.js";

export const SATELLITE_TOOLS_PATH_PREFIX = "/satellite-tools/";
export const SATELLITE_ACTOR_KIND = "satellite-tools";

export const WARN_NOT_OWNER = (gatewayType) => `satellite tools: turn from ${gatewayType || "unknown"} sender and no opt-in, not offered`;
export const WARN_UNSIGNED = "satellite tools: unsigned host, not offered";
export const WARN_FILE_MODE = "satellite tools: file-mode MCP delivery, not offered";
export const WARN_COLLIDES = (name) => `satellite tools: block ${name} collides, skipped`;
export const WARN_NOT_CLAIMER = "satellite tools: job claimed by another process, not offered";

const empty = () => ({ blocks: {}, byBundle: {}, replacing: [], warnings: [], scopeRef: null });

/**
 * The one entry shape a satellite block may take over: the placeholder mcp_writer.mjs writes for a
 * name the instance catalog knows but cannot spawn locally (`{disabled: true}` and nothing else).
 * A satellite-hosted bundle is ALWAYS that shape (crow-server-catalog.mjs marks every
 * `{transport: "satellite"}` add-on unconfigured), which is why the block for it would otherwise
 * never be emitted.
 */
const isDisabledPlaceholder = (block) => !!block && typeof block === "object" && !Array.isArray(block)
  && block.disabled === true && Object.keys(block).length === 1;

/** `<bundle>/<tool>` (or `<bundle>__<tool>`) grants in this crow_mcp list, per bundle. */
export function grantedBundles(def) {
  const list = def && def.tools && Array.isArray(def.tools.crow_mcp) ? def.tools.crow_mcp : [];
  const out = new Set();
  for (const entry of list) {
    if (typeof entry !== "string") continue;
    const x = splitEntry(entry);
    if (x && x[0] && x[1]) out.add(x[0]);
  }
  return out;
}

/**
 * The satellite-hosted bundles a turn may be offered: installed as satellite bundles, hosted by a
 * satellite that is not revoked, and granted to the bot. Sync on purpose (the bot hosts read
 * crow.db directly, like service-blocks.mjs). `[]` on any read failure.
 * @returns {Array<{id:string, host:string, satelliteName:string}>}
 */
export function offerableSatelliteBundles(conn, { def, paths = installPaths() } = {}) {
  if (!conn) return [];
  const granted = grantedBundles(def);
  if (!granted.size) return [];
  let installs;
  try { installs = satelliteInstalls(paths); } catch { return []; }
  if (!installs.length) return [];
  const hosts = new Map();
  try {
    for (const r of conn.prepare("SELECT id, name, status FROM satellites").all()) hosts.set(String(r.id), { name: r.name == null ? null : String(r.name), status: String(r.status || "") });
  } catch { return []; } // no table yet: nothing is paired
  const out = [];
  for (const rec of installs) {
    const id = String(rec?.id || "");
    const host = String(rec?.host || "");
    if (!id || !host || !granted.has(id)) continue;
    const sat = hosts.get(host);
    // A missing row cannot be an authorised host; revoked is the owner's off switch.
    if (!sat || sat.status === "revoked") continue;
    out.push({ id, host, satelliteName: sat.name || host });
  }
  return out;
}

/** True when the owner opted this bot in to satellite tools on other people's turns (Q2). */
export function readBotOptinSync(conn, botId) {
  if (!conn || typeof botId !== "string" || !botId) return false;
  try {
    const r = conn.prepare("SELECT any_turn FROM satellite_bot_optins WHERE bot_id = ?").get(botId);
    return !!r && Number(r.any_turn) === 1;
  } catch { return false; }
}

/**
 * The blocks for one turn, without signing: the bundle ids that get one, and the warnings.
 * `replaceableNames` are the names whose existing entry is the `{disabled: true}` placeholder for a
 * bundle the install records place on a satellite (the caller derives it, see
 * isDisabledPlaceholder); those are replaced rather than collided with.
 * @returns {{names: Array<{bundle, name}>, byBundle: object, replacing: string[], warnings: string[]}}
 */
export function satelliteBlockNames({ bundles, existingNames = new Set(), replaceableNames = new Set() } = {}) {
  const taken = existingNames instanceof Set ? existingNames : new Set(existingNames || []);
  const original = new Set(taken);
  const replaceable = replaceableNames instanceof Set ? replaceableNames : new Set(replaceableNames || []);
  const names = [], byBundle = {}, replacing = [], warnings = [];
  for (const b of bundles || []) {
    const name = b.id;
    // The block is named after the bundle id, so a config that already has that server keeps it —
    // unless what it has is the disabled placeholder for this very satellite-hosted bundle, which
    // carries nothing to keep.
    const swap = original.has(name) && replaceable.has(name);
    if (taken.has(name) && !swap) { warnings.push(WARN_COLLIDES(name)); continue; }
    taken.add(name);
    if (swap) replacing.push(name);
    names.push({ bundle: b, name });
    byBundle[name] = b.id;
  }
  return { names, byBundle, replacing, warnings };
}

/**
 * The blocks for one turn. Pure apart from the signature (actor-sig.mjs module state).
 * @param {object} a
 * @param {object} a.def            the effective def (its crow_mcp is the grant list)
 * @param {Array}  a.bundles        offerableSatelliteBundles' rows
 * @param {object} a.actor          {botId, sessionId?, jobId?, threadId, gatewayType}
 * @param {string|null} a.scopeRef  the turn's scope (null: nothing can be signed)
 * @param {boolean} a.ownerTurn     whose turn this is (Q2)
 * @param {boolean} a.optin         satellite_bot_optins.any_turn
 * @param {object} a.existingServers the turn's own mcpServers (for the disabled placeholders)
 */
export function satelliteBlocksFor({ def, bundles, actor = {}, scopeRef = null, ownerTurn = false, optin = false,
  port = gatewayListenPort(), existingNames = new Set(), existingServers = null,
  delivery = mcpConfigDelivery(), token } = {}) {
  const out = empty();
  try {
    if (!Array.isArray(bundles) || !bundles.length) return out;
    if (!ownerTurn && !optin) { out.warnings.push(WARN_NOT_OWNER(actor.gatewayType)); return out; }
    if (delivery !== "fd") { out.warnings.push(WARN_FILE_MODE); return out; }
    if (scopeRef == null) { out.warnings.push(WARN_UNSIGNED); return out; }
    const tuple = { kind: SATELLITE_ACTOR_KIND, botId: actor.botId, threadId: actor.threadId, gatewayType: actor.gatewayType,
      ...(String(scopeRef).startsWith("j:") ? { jobId: actor.jobId } : { sessionId: actor.sessionId }) };
    // The signature must bind exactly the scope the caller decided on.
    if (scopeRefFor(tuple) !== scopeRef) { out.warnings.push(WARN_UNSIGNED); return out; }
    const sig = signScopeActor(tuple);
    const bearer = typeof token === "string" ? token.trim() : "";
    if (!sig || !bearer) { out.warnings.push(WARN_UNSIGNED); return out; }
    // The bundles here come from installed.json's satellite records (offerableSatelliteBundles),
    // so a placeholder is only ever swapped for a bundle the install records place on a satellite.
    const servers = existingServers && typeof existingServers === "object" ? existingServers : {};
    const replaceableNames = new Set();
    for (const b of bundles) if (isDisabledPlaceholder(servers[b.id])) replaceableNames.add(b.id);
    const named = satelliteBlockNames({ bundles, existingNames, replaceableNames });
    out.warnings.push(...named.warnings);
    out.replacing = named.replacing;
    const headers = {
      Authorization: "Bearer " + bearer,
      "X-Crow-Actor-Kind": SATELLITE_ACTOR_KIND,
      "X-Crow-Actor-Id": String(actor.botId),
      "X-Crow-Actor-Scope": scopeRef,
      "X-Crow-Actor-Thread": String(actor.threadId ?? ""),
      "X-Crow-Actor-Gateway": String(actor.gatewayType ?? ""),
      "X-Crow-Actor-Sig": sig,
    };
    for (const { bundle, name } of named.names) {
      out.blocks[name] = {
        url: `http://127.0.0.1:${port}${SATELLITE_TOOLS_PATH_PREFIX}${encodeURIComponent(bundle.host)}/${encodeURIComponent(bundle.id)}/mcp`,
        headers: { ...headers },
      };
    }
    out.byBundle = named.byBundle;
    out.scopeRef = scopeRef;
    return out;
  } catch {
    return empty();
  }
}

/**
 * A NEW config with the blocks added. An existing server of that name is kept, except the
 * `{disabled: true}` placeholder the result says it replaces (F1: a satellite-hosted bundle is
 * always unconfigured locally, so that placeholder is all the writer leaves for it).
 */
export function applySatelliteBlocks(mcpConfig, result) {
  if (!mcpConfig || typeof mcpConfig !== "object" || !result || !result.blocks || !Object.keys(result.blocks).length) return mcpConfig;
  const servers = { ...(mcpConfig.mcpServers || {}) };
  const replacing = new Set(Array.isArray(result.replacing) ? result.replacing : []);
  for (const [name, block] of Object.entries(result.blocks)) {
    if (Object.hasOwn(servers, name) && !(replacing.has(name) && isDisabledPlaceholder(servers[name]))) continue;
    servers[name] = block;
  }
  return { ...mcpConfig, mcpServers: servers };
}

/**
 * The pi tool names a crow_mcp entry turns into once its bundle has a block: `<bundle>/<tool>` ->
 * `mcp__<block>__<tool>` (the block is named after the bundle, and pi-lab registers one
 * `mcp__<block>__<tool>` per tool for a {url} block, so this is also the bare spelling). null when
 * the entry's server got no block, so the caller keeps its own spelling.
 * `satelliteBlocks` is block name -> bundle id (withSatelliteBlocks/PiRpc's shape), so the entry
 * names the BUNDLE and the name comes from the block.
 */
export function expandSatelliteEntry(entry, { satelliteBlocks } = {}) {
  if (!satelliteBlocks || typeof satelliteBlocks !== "object" || typeof entry !== "string") return null;
  const x = splitEntry(entry);
  if (!x || !x[1]) return null;
  const out = [];
  for (const [name, id] of Object.entries(satelliteBlocks)) if (id === x[0]) out.push(`mcp__${name}__${x[1]}`);
  return out.length ? out : null;
}

/** <crowHome>/secrets/satellite-tools-token, the same file local-token.js SATELLITE_TOOLS_TOKEN rotates. */
export function satelliteToolsTokenPath() { return join(resolveCrowHome(), "secrets", "satellite-tools-token"); }

function readSatelliteToolsToken() {
  try { return readFileSync(satelliteToolsTokenPath(), "utf8").trim() || null; } catch { return null; }
}

function openCrowDb() {
  const d = new Database(resolveSqlitePath(botsDbPath()), { readonly: true, fileMustExist: true });
  d.pragma("busy_timeout = 10000");
  return d;
}

/**
 * THE seam. Reads this turn's satellite-hosted, granted bundles, builds and applies their blocks,
 * and:
 *  - assigns the new config to `spawnPrep.piRpcOpts.mcpConfig` (and returns it),
 *  - sets `spawnPrep.piRpcOpts.satelliteBlocks` (block name -> bundle id), which PiRpc's and the
 *    preflight's buildToolsCsv read,
 *  - stores the result on `world._mcpArgs.satelliteBlocks` so a later MCP rebuild
 *    (bot-world.mjs writeWorldMcp) re-applies it.
 * Never throws: any failure is "no blocks" (the config is the one handed in).
 * @param {object} world      buildBotWorld's (or a job's {def, crowHome, projectId, bot, _mcpArgs?})
 * @param {object} spawnPrep  {piRpcOpts}
 * @param {{scopeRef: string|null, ownerTurn: boolean, log?: Function, actor?: object, notClaimer?: boolean,
 *          openDb?: Function, readToken?: Function, presign?: Function, paths?: object}} opts
 */
export async function withSatelliteBlocks(world, spawnPrep, { scopeRef = null, ownerTurn = false, log = () => {}, actor = null,
  notClaimer = false, openDb = openCrowDb, readToken = readSatelliteToolsToken, presign = presignActors, paths = null } = {}) {
  const po = (spawnPrep && spawnPrep.piRpcOpts) || {};
  const base = po.mcpConfig === undefined ? (world && world.mcpConfig) || null : po.mcpConfig;
  const none = { mcpConfig: base, satelliteBlocks: {}, result: empty() };
  // A world reused for another turn never carries an earlier turn's blocks into a rebuild.
  if (world && world._mcpArgs) world._mcpArgs.satelliteBlocks = null;
  try {
    const a = world && world._mcpArgs ? world._mcpArgs : {};
    const def = po.def || (world && world.def);
    const crowHome = (world && world.crowHome) || resolveCrowHome();
    const who = actor || { botId: a.botId || (world && world.bot && world.bot.bot_id), threadId: a.threadId, gatewayType: a.gatewayType || (world && world.gatewayType), jobId: a.jobId || null };
    if (scopeRef && String(scopeRef).startsWith("s:")) who.sessionId = String(scopeRef).slice(2);
    // No grant, no read: the common turn (a bot with no satellite bundle) never opens crow.db here.
    if (!grantedBundles(def).size) return none;
    const installs = paths || installPaths(crowHome);
    const conn = openDb();
    let bundles = [], optin = false;
    try {
      bundles = offerableSatelliteBundles(conn, { def, paths: installs });
      optin = bundles.length ? readBotOptinSync(conn, who.botId) : false;
    } finally { try { conn.close(); } catch { /* closed */ } }
    if (!bundles.length) return none;
    if (notClaimer) log(WARN_NOT_CLAIMER);
    const delivery = po.mcpDelivery || (world && world.mcpDelivery) || mcpConfigDelivery();
    // Helper spec §4.4: a key-less host can only be handed a scope kind for an owner j: turn.
    if (ownerTurn === true && delivery === "fd" && !hasActorKey() && String(scopeRef || "").startsWith("j:")) {
      await presign({ gatewayUrl: "http://127.0.0.1:" + gatewayListenPort(), botId: who.botId, threadId: who.threadId,
        gatewayType: who.gatewayType, jobId: who.jobId, kinds: [SATELLITE_ACTOR_KIND] });
    }
    const existingNames = new Set(Object.keys((base && base.mcpServers) || {}));
    const result = satelliteBlocksFor({ def, bundles, actor: who, scopeRef, ownerTurn, optin, existingNames,
      existingServers: (base && base.mcpServers) || null, delivery, token: readToken() });
    for (const w of result.warnings) log(w);
    const mcpConfig = applySatelliteBlocks(base, result);
    if (spawnPrep) {
      spawnPrep.piRpcOpts = Object.assign(spawnPrep.piRpcOpts || {}, { mcpConfig, satelliteBlocks: result.byBundle });
    }
    if (world && world._mcpArgs) world._mcpArgs.satelliteBlocks = Object.keys(result.blocks).length ? result : null;
    if (world && Object.keys(result.blocks).length) world.mcpConfig = mcpConfig;
    return { mcpConfig, satelliteBlocks: result.byBundle, result };
  } catch {
    return none;
  }
}