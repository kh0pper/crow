/**
 * Project services, Task 18: on the owner's own turns a project's bots get one labelled MCP block
 * per connected account (`github-work`, `github-personal`), pointing at the gateway's loopback
 * door `/services-tools/<uuid>/mcp` (servers/gateway/services/mount.js). ONE seam,
 * withServiceBlocks, used by every rail: channel turns and card jobs (bridge.mjs handleInbound),
 * generic jobs (job_runner.mjs runJob) and Perch children (perch-interactive.js startChild).
 *
 * Fail closed, in this order (each "no" means no block at all, and the turn's config is the one
 * it had before this module existed):
 *  - not the owner's turn (plan decision 1): a job is the owner's only when its bot_jobs.principal
 *    is 'owner' (NULL or anything else is not, rev 4 H2) AND this process is the one that claimed
 *    it (bot_jobs.worker_pid); a channel turn (gmail, discord, telegram, slack, crow-messages, ...)
 *    is never the owner's; a Perch session is the owner's only when the engine says so; the
 *    Crow voice bot gets none until roadmap PR 10;
 *  - a connection that is sensitive (servers/shared/service-sensitivity.js isSensitiveConnection,
 *    Task 16c; any doubt is sensitive) or whose row's service_id is not the one the owner's
 *    connect route recorded (connectionBindingOk);
 *  - a service the bot's tool selection does not name (C4);
 *  - file-mode MCP delivery (lane B helper spec §4.5: the token and signature must never land in
 *    <sessionDir>/.mcp.json);
 *  - no services token file, or no v3 `service` signature for exactly this turn's tuple
 *    (signScopeActor returns null without the gateway's scope key and with no presigned match).
 *    A key-less bot host asks its gateway's signing relay in a SEPARATE presign call for
 *    ["service"] only, and only for an owner `j:` turn (H1-bis): the relay refuses a whole request
 *    that asks for a scope kind on a job that is not the owner's, which would otherwise strip
 *    that turn's bot/board signatures too.
 *
 * A block carries NO secret: the loopback URL, the services FAMILY token (it opens nothing but
 * that door, which re-checks the signature, the live scope, the owner's turn, the project, the
 * selection and the sensitivity on every request) and the actor headers. Keychain values never
 * leave the gateway's per-connection child.
 *
 * Block names come from the store (`<serviceId>-<labelSlug>`, Task 3). A name already emitted for
 * this turn is skipped (first wins, in connectionsFor order: Task 7 ruling 7); a name equal to a
 * key of the built config or to a reserved server name (R13: the instance catalog plus the
 * canonical ~/.pi/agent/mcp.json) is skipped with a warning (I9); a pi tool name over 64
 * characters is skipped with a warning (I10: pi-lab registers mcp__<block>__<tool> verbatim and
 * the provider then refuses the whole request).
 */
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hasActorKey, presignActors, scopeRefFor, signScopeActor } from "./actor-sig.mjs";
import { mcpConfigDelivery } from "./mcp-delivery.mjs";
import { botsDbPath, resolveSqlitePath } from "./instance-paths.mjs";
import { splitEntry } from "./skill-tools.mjs";
import { crowServerCatalog } from "./crow-server-catalog.mjs";
import { readCanonicalMcp } from "./mcp_writer.mjs";
import { gatewayListenPort } from "../../servers/gateway/listen-port.js";
import { SERVICES_TOKEN } from "../../servers/gateway/local-token.js";
import { readToolCache } from "../../servers/gateway/services/tool-cache.js";
import { serviceById } from "../../servers/shared/service-catalog.js";
import { connectionBindingOk, isSensitiveConnection } from "../../servers/shared/service-sensitivity.js";
import { NEVER_OWNER_GATEWAYS } from "../../servers/shared/turn-principal.js";
import { isVoiceBotDef, isVoiceBotId } from "../../servers/shared/voice-bot.js";

/** pi tool names past this are refused by the providers (I10). */
export const PI_TOOL_NAME_MAX = 64;
export const SERVICES_PATH_PREFIX = "/services-tools/";

export const WARN_NOT_OWNER = (gatewayType) => `services: turn from ${gatewayType || "unknown"} sender, owner accounts not offered`;
export const WARN_UNSIGNED = "services: unsigned host, project connections not offered";
export const WARN_FILE_MODE = "services: file-mode MCP delivery, connections not offered";
export const WARN_COLLIDES = (name) => `services: block ${name} collides, skipped`;
export const WARN_DUPLICATE = (name) => `services: block ${name} named twice, the first is kept`;
export const WARN_LONG_TOOL = (name) => `services: tool name ${name} is over ${PI_TOOL_NAME_MAX} characters, skipped`;
export const WARN_LONG_BLOCK = (name) => `services: block ${name} is too long for a tool name, skipped`;
export const WARN_NOT_CLAIMER = "services: job claimed by another process, connections not offered";

const empty = () => ({ blocks: {}, byService: {}, skippedTools: [], warnings: [], scopeRef: null });

/**
 * Who started this turn, and the scope its signature binds (lane B spec §4.1, §4.3).
 *  - a job (card or generic): `j:<job_id>@<this pid>`; the owner's only when the job row's
 *    principal is exactly 'owner' AND its worker_pid is this process (the claimer; the relay and
 *    the mount check the same pid, so a job claimed elsewhere fails closed here, loudly);
 *  - a Perch session with a row: `s:<row id>`, the owner's when the engine says (`perchOwner`);
 *  - anything else (every channel, NEVER_OWNER_GATEWAYS included): no scope, not the owner's.
 * @returns {{scopeRef: string|null, ownerTurn: boolean, notClaimer?: boolean}}
 */
export function turnScopeFor({ gatewayType, sessionRowId = null, jobId = null, principal = null, workerPid = null, perchOwner = false } = {}) {
  if (jobId != null && jobId !== "") {
    const scopeRef = scopeRefFor({ jobId: String(jobId) });
    if (!scopeRef) return { scopeRef: null, ownerTurn: false };
    const claimer = Number(workerPid) === process.pid;
    return { scopeRef, ownerTurn: principal === "owner" && claimer, notClaimer: principal === "owner" && !claimer };
  }
  if (NEVER_OWNER_GATEWAYS.includes(gatewayType)) return { scopeRef: null, ownerTurn: false };
  if (gatewayType === "perch" && sessionRowId != null) {
    const scopeRef = scopeRefFor({ sessionId: sessionRowId });
    return { scopeRef, ownerTurn: !!scopeRef && perchOwner === true };
  }
  return { scopeRef: null, ownerTurn: false };
}

/**
 * The project's active connections a bot may be offered, as connectionsFor reads them
 * (service-connections.js: status 'active', the local owner's only, a non-archived project, ordered
 * by service, slug, id), on a better-sqlite3 handle. `[]` for no project or any read failure.
 * @returns {Array<{uuid, serviceId, bundleId, accountLabel, labelSlug, blockName}>}
 */
export function readProjectConnectionsSync(conn, projectId) {
  if (projectId == null || !conn) return [];
  try {
    return conn.prepare(
      "SELECT uuid, service_id, bundle_id, account_label, label_slug FROM service_connections " +
      "WHERE project_id = ? AND status = 'active' AND owner_contact_id IS NULL " +
      "AND project_id IN (SELECT id FROM project_spaces WHERE status != 'archived' AND archived_at IS NULL) " +
      "ORDER BY service_id, label_slug, id",
    ).all(Number(projectId)).map((r) => ({
      uuid: r.uuid, serviceId: r.service_id, bundleId: r.bundle_id ?? null, accountLabel: r.account_label,
      labelSlug: r.label_slug, blockName: `${r.service_id}-${r.label_slug}`,
    }));
  } catch {
    return [];
  }
}

/** What a crow_mcp list selects of one service: null, `{tools: null}` (bare: every tool) or `{tools: [...]}`. */
function selectionOf(def, serviceId) {
  const list = (def && def.tools && Array.isArray(def.tools.crow_mcp)) ? def.tools.crow_mcp : [];
  const tools = [];
  for (const e of list) {
    if (typeof e !== "string") continue;
    if (e === serviceId) return { tools: null };
    const x = splitEntry(e);
    if (x && x[0] === serviceId && x[1] && !tools.includes(x[1])) tools.push(x[1]);
  }
  return tools.length ? { tools } : null;
}

/** The connected service ids the def's (effective) crow_mcp names, bare or per tool (C4). */
export function selectedServiceIds(def, connections) {
  const out = new Set();
  for (const c of connections || []) if (c && !out.has(c.serviceId) && selectionOf(def, c.serviceId)) out.add(c.serviceId);
  return out;
}

/** The connections that may be offered at all: selected, bound as the owner connected them, not sensitive. */
export function offerableConnections(def, connections, { crowHome } = {}) {
  const selected = selectedServiceIds(def, connections);
  return (connections || []).filter((c) => selected.has(c.serviceId)
    && connectionBindingOk(c, { crowHome }) && !isSensitiveConnection(c, { crowHome }));
}

/** A service's installed bundle version (installed.json, else its manifest), as the children read it. */
function installedVersion(crowHome, bundleId) {
  const read = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
  const raw = read(join(crowHome, "installed.json"));
  let found = false, version = null;
  if (Array.isArray(raw)) {
    for (const e of raw) {
      const id = typeof e === "string" ? e : e?.id;
      if (id === bundleId) { found = true; version = typeof e === "object" && typeof e.version === "string" ? e.version : null; }
    }
  } else if (raw && typeof raw === "object" && Object.hasOwn(raw, bundleId)) {
    found = true;
    version = typeof raw[bundleId]?.version === "string" ? raw[bundleId].version : null;
  }
  if (!found) return { installed: false, version: null };
  if (!version) { const m = read(join(crowHome, "bundles", bundleId, "manifest.json")); version = typeof m?.version === "string" ? m.version : null; }
  return { installed: true, version };
}

/** The shared tool cache's list for a service at its installed version (children.js serviceTools), or null. */
export function cachedServiceTools(serviceId, { crowHome } = {}) {
  try {
    const service = serviceById(serviceId);
    if (!service || typeof crowHome !== "string") return null;
    const { installed, version } = installedVersion(crowHome, service.bundleId);
    return installed ? readToolCache(crowHome, service.id, version) : null;
  } catch { return null; }
}

/** R13: every server name a bot can already get here (instance catalog + canonical config). Unreadable: none. */
export function reservedBlockNames(crowHome) {
  const out = new Set();
  try {
    const c = crowServerCatalog(crowHome);
    for (const n of [...Object.keys(c?.servers || {}), ...Object.keys(c?.unconfigured || {})]) out.add(n);
  } catch { /* nothing to add */ }
  try { for (const n of Object.keys(readCanonicalMcp()?.mcpServers || {})) out.add(n); } catch { /* none */ }
  return out;
}

/**
 * The block names and pi tool names for the offerable connections, without signing: the part the
 * spawn and the Perch envelope (routes/perch.js) share, so both count the same tools.
 * @returns {{names: Array<{conn, name}>, byService: Object<string,string[]>, skippedTools: string[], warnings: string[]}}
 */
export function serviceBlockNames({ def, connections, existingNames = new Set(), toolsFor = () => null }) {
  const taken = existingNames instanceof Set ? existingNames : new Set(existingNames || []);
  const emitted = new Set();
  const names = [], byService = {}, skippedTools = [], warnings = [];
  for (const conn of connections || []) {
    const name = conn.blockName;
    if (typeof name !== "string" || !name) continue;
    if (emitted.has(name)) { warnings.push(WARN_DUPLICATE(name)); continue; }
    if (taken.has(name)) { warnings.push(WARN_COLLIDES(name)); continue; }
    if (("mcp__" + name).length > PI_TOOL_NAME_MAX) { warnings.push(WARN_LONG_BLOCK(name)); continue; }
    emitted.add(name);
    names.push({ conn, name });
    (byService[conn.serviceId] ||= []).push(name);
    const sel = selectionOf(def, conn.serviceId);
    const cached = toolsFor(conn.serviceId);
    const toolNames = new Set([...(sel && sel.tools ? sel.tools : []), ...(Array.isArray(cached) ? cached.map((t) => t && t.name).filter((n) => typeof n === "string") : [])]);
    for (const t of toolNames) {
      const full = `mcp__${name}__${t}`;
      if (full.length > PI_TOOL_NAME_MAX && !skippedTools.includes(full)) { skippedTools.push(full); warnings.push(WARN_LONG_TOOL(full)); }
    }
  }
  return { names, byService, skippedTools, warnings };
}

/**
 * The blocks for one turn. Pure apart from the signature (actor-sig.mjs module state) and the
 * sensitivity files it reads.
 * @param {object} a
 * @param {object} a.def            the effective def the spawn pins its csv from
 * @param {Array}  a.connections    readProjectConnectionsSync's rows
 * @param {object} a.actor          {botId, sessionId?, jobId?, threadId, gatewayType}
 * @param {string|null} a.scopeRef  turnScopeFor's
 * @param {boolean} a.ownerTurn     turnScopeFor's
 * @returns {{blocks, byService, skippedTools, warnings, scopeRef}}
 */
export function serviceBlocksFor({ def, connections, actor = {}, scopeRef, ownerTurn, crowHome, port = gatewayListenPort(),
  existingNames = new Set(), toolsFor = (sid) => cachedServiceTools(sid, { crowHome }), delivery = mcpConfigDelivery(), token } = {}) {
  const out = empty();
  try {
    const offer = offerableConnections(def, connections, { crowHome });
    if (!offer.length) return out;
    if (ownerTurn !== true || scopeRef == null || isVoiceBotId(actor.botId) || isVoiceBotDef(def)) {
      out.warnings.push(WARN_NOT_OWNER(actor.gatewayType));
      return out;
    }
    if (delivery !== "fd") { out.warnings.push(WARN_FILE_MODE); return out; }
    const tuple = { kind: "service", botId: actor.botId, threadId: actor.threadId, gatewayType: actor.gatewayType,
      ...(String(scopeRef).startsWith("j:") ? { jobId: actor.jobId } : { sessionId: actor.sessionId }) };
    // The signature must bind exactly the scope the caller decided on.
    if (scopeRefFor(tuple) !== scopeRef) { out.warnings.push(WARN_UNSIGNED); return out; }
    const sig = signScopeActor(tuple);
    const bearer = typeof token === "string" ? token.trim() : "";
    if (!sig || !bearer) { out.warnings.push(WARN_UNSIGNED); return out; }
    const named = serviceBlockNames({ def, connections: offer, existingNames, toolsFor });
    out.warnings.push(...named.warnings);
    const headers = {
      Authorization: "Bearer " + bearer,
      "X-Crow-Actor-Kind": "service",
      "X-Crow-Actor-Id": String(actor.botId),
      "X-Crow-Actor-Scope": scopeRef,
      "X-Crow-Actor-Thread": String(actor.threadId ?? ""),
      "X-Crow-Actor-Gateway": String(actor.gatewayType ?? ""),
      "X-Crow-Actor-Sig": sig,
    };
    for (const { conn, name } of named.names) {
      out.blocks[name] = { url: `http://127.0.0.1:${port}${SERVICES_PATH_PREFIX}${conn.uuid}/mcp`, headers: { ...headers } };
    }
    out.byService = named.byService;
    out.skippedTools = named.skippedTools;
    out.scopeRef = scopeRef;
    return out;
  } catch {
    return empty();
  }
}

/**
 * A NEW config with the blocks added and, for each service that got blocks, the config's own
 * block of that name (a canonical or add-on `github`) turned off: the labelled blocks replace it.
 * A null config stays null (a failed build is never repaired into a services-only one).
 */
export function applyServiceBlocks(mcpConfig, result) {
  if (!mcpConfig || typeof mcpConfig !== "object" || !result || !result.blocks || !Object.keys(result.blocks).length) return mcpConfig;
  const servers = { ...(mcpConfig.mcpServers || {}) };
  for (const sid of Object.keys(result.byService || {})) if (Object.hasOwn(servers, sid)) servers[sid] = { disabled: true };
  for (const [name, block] of Object.entries(result.blocks)) if (!Object.hasOwn(servers, name)) servers[name] = block;
  return { ...mcpConfig, mcpServers: servers };
}

function readServicesToken() {
  try { return readFileSync(SERVICES_TOKEN.path(), "utf8").trim() || null; } catch { return null; }
}

function openCrowDb() {
  const d = new Database(resolveSqlitePath(botsDbPath()), { readonly: true, fileMustExist: true });
  d.pragma("busy_timeout = 10000");
  return d;
}

/**
 * THE seam (I1). Reads the project's connections, builds and applies the blocks, and:
 *  - assigns the new config to `spawnPrep.piRpcOpts.mcpConfig` (and returns it),
 *  - sets `spawnPrep.piRpcOpts.serviceBlocks` (service id -> block names) and
 *    `spawnPrep.piRpcOpts.serviceSkippedTools`, which PiRpc's and the preflight's buildToolsCsv read,
 *  - stores the result on `world._mcpArgs.serviceBlocks` so PR-B's bindWorldSession rebuild
 *    (bot-world.mjs writeWorldMcp) re-applies it.
 * Never throws: any failure is "no blocks" (the config is the one handed in).
 * @param {object} world      buildBotWorld's (or a job's {def, crowHome, projectId, bot, _mcpArgs?})
 * @param {object} spawnPrep  {piRpcOpts}
 * @param {{scopeRef: string|null, ownerTurn: boolean, log?: Function, actor?: object, notClaimer?: boolean,
 *          openDb?: Function, readToken?: Function, presign?: Function}} opts
 * @returns {Promise<{mcpConfig: object|null, serviceBlocks: object, result: object}>}
 */
export async function withServiceBlocks(world, spawnPrep, { scopeRef = null, ownerTurn = false, log = () => {}, actor = null, notClaimer = false,
  openDb = openCrowDb, readToken = readServicesToken, presign = presignActors } = {}) {
  const po = (spawnPrep && spawnPrep.piRpcOpts) || {};
  const base = po.mcpConfig === undefined ? (world && world.mcpConfig) || null : po.mcpConfig;
  const none = { mcpConfig: base, serviceBlocks: {}, result: empty() };
  try {
    if (!world || world.projectId == null) return none;
    const a = world._mcpArgs || {};
    const who = actor || { botId: a.botId || (world.bot && world.bot.bot_id), threadId: a.threadId, gatewayType: a.gatewayType || world.gatewayType, jobId: a.jobId || null };
    if (scopeRef && String(scopeRef).startsWith("s:")) who.sessionId = String(scopeRef).slice(2);
    let connections = [];
    const conn = openDb();
    try { connections = readProjectConnectionsSync(conn, world.projectId); } finally { try { conn.close(); } catch { /* closed */ } }
    const def = (po.def) || world.def;
    const crowHome = world.crowHome;
    if (!offerableConnections(def, connections, { crowHome }).length) return none;
    if (notClaimer) log(WARN_NOT_CLAIMER);
    const delivery = po.mcpDelivery || world.mcpDelivery || mcpConfigDelivery();
    // H1-bis: a key-less host asks for the service signature in its OWN request, owner j: turns only.
    if (ownerTurn === true && delivery === "fd" && !hasActorKey() && String(scopeRef || "").startsWith("j:")) {
      await presign({ gatewayUrl: "http://127.0.0.1:" + gatewayListenPort(), botId: who.botId, threadId: who.threadId,
        gatewayType: who.gatewayType, jobId: who.jobId, kinds: ["service"] });
    }
    const existingNames = new Set([...Object.keys((base && base.mcpServers) || {}), ...reservedBlockNames(crowHome)]);
    const result = serviceBlocksFor({ def, connections, actor: who, scopeRef, ownerTurn, crowHome, existingNames, delivery, token: readToken() });
    for (const w of result.warnings) log(w);
    const mcpConfig = applyServiceBlocks(base, result);
    if (spawnPrep) {
      spawnPrep.piRpcOpts = Object.assign(spawnPrep.piRpcOpts || {}, {
        mcpConfig, serviceBlocks: result.byService, serviceSkippedTools: result.skippedTools,
      });
    }
    if (world._mcpArgs) world._mcpArgs.serviceBlocks = Object.keys(result.blocks).length ? result : null;
    if (Object.keys(result.blocks).length) world.mcpConfig = mcpConfig;
    return { mcpConfig, serviceBlocks: result.byService, result };
  } catch {
    return none;
  }
}

/**
 * The pi tool names a crow_mcp entry turns into, for a service that got blocks:
 * `<sid>/<tool>` → `mcp__<block>__<tool>` per block, bare `<sid>` → `mcp__<block>` per block
 * (the same bare spelling every other server gets). Skipped (over-long) names are dropped. null
 * when the entry is not a service with blocks (the caller keeps its own spelling).
 */
export function expandServiceEntry(entry, { serviceBlocks, skippedTools = [] } = {}) {
  if (!serviceBlocks || typeof serviceBlocks !== "object" || typeof entry !== "string") return null;
  const x = splitEntry(entry);
  const sid = x ? x[0] : entry;
  const blocks = Object.hasOwn(serviceBlocks, sid) ? serviceBlocks[sid] : null;
  if (!Array.isArray(blocks) || !blocks.length) return null;
  const skip = new Set(skippedTools || []);
  return blocks.map((b) => (x ? `mcp__${b}__${x[1]}` : `mcp__${b}`)).filter((n) => !skip.has(n));
}
