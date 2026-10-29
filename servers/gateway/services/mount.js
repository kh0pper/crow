/**
 * `/services-tools/<uuid>/mcp`: the only door a bot uses to reach the owner's connected
 * accounts (project services Task 17). It is the services adapter on the shared loopback mount
 * (loopback-tool-mount.js mountLoopbackMcp), which owns everything before `authorize`: the
 * loopback-only peer, the services family token (secrets/services-token), the v3 `service`
 * actor signature and its live scope (a dead or unknown scope is `unattributed`), the session
 * binding, and the owner-turn check (ownerTurnOnly stays on: a j: job whose principal is
 * 'owner', or an s: Perch session the engine reports as serving the owner's services). It also
 * owns the in-flight caps, the fixed error text, result shaping and redaction (with
 * `ctx.secrets`) and the audit. None of that is repeated here.
 *
 * This module adds the services checks (plan checks 2–6, minus the owner turn the helper ran):
 *  3. the connection exists (else not_found) and is the local owner's (owner_contact_id IS
 *     NULL, else owner_mismatch);
 *  4. one project: the bot def's project (pi_bot_defs.project_id, the authority), and for an s:
 *     scope the session's project too, equal the connection's (else wrong_project; a def with
 *     no project is wrong_project);
 *  5. the bot's selection: its effective crow_mcp (effectiveCrowMcp, the def's stored list plus
 *     its repo skills' grants, minus declines) names the connection's service, bare (every
 *     tool) or as `service/tool` entries (only those tools), else not_selected;
 *  6. the connection can be served: active, or an 'error' row ensureChild retries on its own
 *     (child_unavailable, listableConnection), in a project that is not archived (else
 *     not_active).
 * authorizeServiceCall takes the VERIFIED actor, never the request, so the satellite channel
 * (services PR 9) can call it with an actor it verified itself.
 *
 * Every refusal is decided before anything starts: the helper refuses before `authorize`, and
 * `authorize` only reads rows. A child starts only in onInitialize (no cached tool list yet)
 * or in a tools/call, and each call resolves its child afresh (ensureChild), so a child that
 * stopped or restarted between two calls of one MCP session is simply started again.
 */
import { createDbClient as defaultCreateDbClient } from "../../db.js";
import { resolveCrowHome } from "../../shared/crow-home.js";
import { getConnection } from "../../shared/service-connections.js";
import { mountLoopbackMcp } from "../loopback-tool-mount.js";
import { SERVICES_TOKEN } from "../local-token.js";
import { effectiveCrowMcp } from "../../../scripts/pi-bots/skill-tools.mjs";
import {
  ensureChild, childSecretValues, serviceTools, listableConnection, cancelCall as stopConnectionChild,
} from "./children.js";

export const SERVICES_FAMILY = "services-tools";
/** Kevin 2026-10-29 (Q1): 256 KiB, text and images; base64 images count. */
export const SERVICES_RESULT_CAP = Object.freeze({ maxBytes: 262144, contentTypes: Object.freeze(["text", "image"]) });
/**
 * 60 s per call (lane A, PR 3): the same as a child's connect timeout. The helper's in-flight
 * ceiling becomes 5 x this, 300 s, after which a call that never settled stops its child.
 */
export const SERVICES_CALL_TIMEOUT_MS = 60_000;
export const SERVICES_MAX_IN_FLIGHT = 4;

const refuse = (code) => ({ ok: false, code });

/** Split a crow_mcp entry into [server, tool] (`server/tool` or `server__tool`); null for a bare name. */
function splitEntry(e) {
  const i = e.indexOf("/"), j = e.indexOf("__");
  if (i > 0) return [e.slice(0, i), e.slice(i + 1)];
  if (j > 0) return [e.slice(0, j), e.slice(j + 2)];
  return null;
}

/**
 * What a crow_mcp list selects of one service: `null` when nothing, `{allowedTools: null}`
 * for a bare selection (every tool), else `{allowedTools: [names]}`.
 */
export function serviceSelection(list, serviceId) {
  if (!Array.isArray(list) || typeof serviceId !== "string" || !serviceId) return null;
  const tools = new Set();
  for (const e of list) {
    if (typeof e !== "string") continue;
    if (e === serviceId) return { allowedTools: null };
    const x = splitEntry(e);
    if (x && x[0] === serviceId && x[1]) tools.add(x[1]);
  }
  return tools.size ? { allowedTools: [...tools] } : null;
}

async function botDef(db, botId) {
  const r = (await db.execute({ sql: "SELECT definition FROM pi_bot_defs WHERE bot_id = ?", args: [botId] })).rows[0];
  if (!r) return null;
  const def = JSON.parse(r.definition || "{}");
  return def && typeof def === "object" && !Array.isArray(def) ? def : null;
}

async function projectArchived(db, projectId) {
  const r = (await db.execute({ sql: "SELECT status, archived_at FROM project_spaces WHERE id = ?", args: [projectId] })).rows[0];
  return !r || r.status === "archived" || r.archived_at != null;
}

/**
 * Checks 3–6 for a verified actor (a resolveSignedScope result: scope, botId, defProjectId,
 * sessionProjectId for s:). Request-independent. Any throw is not_granted (fail closed).
 * `ctx.secrets` is a LIVE getter over the values injected into this connection's child at its
 * last spawn, so the helper redacts results with what the child actually holds.
 * @returns {Promise<{ok:true, ctx:object}|{ok:false, code:string}>}
 */
export async function authorizeServiceCall(db, actor, uuid, { crowHome = resolveCrowHome(), repoSkillsDir } = {}) {
  try {
    if (!actor || typeof actor !== "object" || typeof actor.botId !== "string") return refuse("not_granted");
    if (actor.scope !== "session" && actor.scope !== "job") return refuse("not_granted");
    // 3.
    const connection = await getConnection(db, uuid);
    if (!connection) return refuse("not_found");
    if (connection.ownerContactId != null) return refuse("owner_mismatch");
    // 4. one project: the def's project is the authority; a session must agree with it.
    if (actor.defProjectId == null || Number(actor.defProjectId) !== connection.projectId) return refuse("wrong_project");
    if (actor.scope === "session" && (actor.sessionProjectId == null || Number(actor.sessionProjectId) !== connection.projectId)) return refuse("wrong_project");
    // 5. the bot's selection.
    let def;
    try { def = await botDef(db, actor.botId); } catch { def = null; }
    if (!def) return refuse("not_selected");
    const sel = serviceSelection(effectiveCrowMcp(def, { crowHome, repoSkillsDir }), connection.serviceId);
    if (!sel) return refuse("not_selected");
    // 6. servable.
    if (!listableConnection(connection) || await projectArchived(db, connection.projectId)) return refuse("not_active");
    const ctx = {
      uuid: connection.uuid,
      connection,
      botId: actor.botId,
      serviceId: connection.serviceId,
      allowedTools: sel.allowedTools,
      get secrets() { return childSecretValues(connection.uuid); },
    };
    return { ok: true, ctx };
  } catch {
    return refuse("not_granted");
  }
}

/** tools/list AND every tools/call: only the selected tools. */
export function servicesToolFilter(ctx, tool) {
  if (!ctx || !tool || typeof tool.name !== "string") return false;
  return ctx.allowedTools === null || (Array.isArray(ctx.allowedTools) && ctx.allowedTools.includes(tool.name));
}

/**
 * The upstream the helper drives. Each child start gets its own DB client (closed when the
 * start settles), never the request's: the helper closes that one when the response ends,
 * which can be before a shared single-flight start finishes.
 */
export function servicesUpstream({ createDbClient = defaultCreateDbClient, crowHome = resolveCrowHome } = {}) {
  const home = () => (typeof crowHome === "function" ? crowHome() : crowHome);
  const child = async (uuid) => {
    const db = createDbClient();
    try { return await ensureChild(db, uuid, { crowHome: home() }); } finally { try { db.close(); } catch { /* closed */ } }
  };
  return {
    // The cached list only: listing never starts a child (Task 14, I3).
    listTools: async (ctx) => serviceTools(ctx.serviceId, { crowHome: home() }) || [],
    // initialize: with no cached list yet, start the child once to fill it. A ChildError is
    // its code (the helper answers 502 child_unavailable for any code).
    onInitialize: async (ctx) => {
      if (serviceTools(ctx.serviceId, { crowHome: home() })) return undefined;
      try { await child(ctx.uuid); return undefined; } catch (err) { return { code: typeof err?.code === "string" ? err.code : "child_unavailable" }; }
    },
    // Per call: the child as it is now (started again if it stopped), then the call. A
    // ChildError carries its code (busy, child_unavailable, ...); any other failure, the
    // child's own error text included, is "<tool> failed." in the helper. The call settles when
    // the child exits (children.js aborts it).
    callTool: async (ctx, name, args, { signal } = {}) => {
      const { client } = await child(ctx.uuid);
      return client.callTool({ name, arguments: args }, undefined, { signal, timeout: SERVICES_CALL_TIMEOUT_MS + 5_000 });
    },
    // The helper's in-flight ceiling: a call that never settled stops the connection's child.
    cancelCall: async (ctx) => { await stopConnectionChild(ctx.uuid); },
  };
}

/**
 * A SYNC accessor for the Perch engine (the helper calls perchEngine() synchronously on every
 * s: request): the module is loaded once here, then the engine is looked up per call and never
 * created. With the module unloadable every s: scope is refused (fail closed).
 */
export async function perchEngineAccessor(load = () => import("../perch-interactive.js")) {
  let mod = null;
  try { mod = await load(); } catch { mod = null; }
  return () => {
    try { return mod?.getInteractiveEngine?.({ createIfMissing: false }) ?? null; } catch { return null; }
  };
}

/**
 * Mounts `/services-tools/:uuid/mcp`. Returns the helper's `{ sweepIdle, stop }`.
 * `token`, `crowHome`, `repoSkillsDir` and `onAudit` are test seams.
 */
export function mountServicesTools(app, {
  sessionManager, createDbClient = defaultCreateDbClient, perchEngine, token = SERVICES_TOKEN,
  crowHome = resolveCrowHome, repoSkillsDir, onAudit,
} = {}) {
  const home = () => (typeof crowHome === "function" ? crowHome() : crowHome);
  return mountLoopbackMcp(app, {
    family: SERVICES_FAMILY,
    params: ":uuid",
    actorKind: "service",
    token,
    authorize: ({ db, params, actor }) => authorizeServiceCall(db, actor, params.uuid, { crowHome: home(), repoSkillsDir }),
    upstream: servicesUpstream({ createDbClient, crowHome: home }),
    toolFilter: servicesToolFilter,
    resultCap: { maxBytes: SERVICES_RESULT_CAP.maxBytes, contentTypes: [...SERVICES_RESULT_CAP.contentTypes] },
    callTimeoutMs: SERVICES_CALL_TIMEOUT_MS,
    maxInFlight: SERVICES_MAX_IN_FLIGHT,
    perchEngine,
    ...(onAudit ? { onAudit } : {}),
    sessionManager,
    createDbClient,
  });
}
