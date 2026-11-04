/**
 * `/satellite-tools/<satellite_id>/<bundle>/mcp`: how a BOT reaches a satellite-hosted bundle's
 * tools (SAT-7 part B, spec §9.2, §9.4; plan Task 10). A thin adapter over the shared loopback
 * mount (loopback-tool-mount.js mountLoopbackMcp), which owns everything before `authorize`: the
 * loopback-only peer, the satellite-tools family token (secrets/satellite-tools-token), the v3
 * `satellite-tools` actor signature and its live scope (a dead or unknown scope is
 * `unattributed`), the session binding, the in-flight caps, the fixed error text, result shaping
 * (256 KiB, text only — the same cap the satellite transport applies, so the limit holds end to
 * end) and the audit. None of that is repeated here.
 *
 * This module adds the satellite checks, in this order (the private engineering notes, helper
 * spec §8 "Satellite"):
 *  1. the owner's own turn (isOwnerTurnScope: an owner `j:` job, or an `s:` Perch session the
 *     engine reports as serving the owner) OR the per-bot opt-in (`satellite_bot_optins.any_turn`,
 *     Kevin's Q2 answer: a bot the owner marked "also on other people's turns" may run satellite
 *     tools on a Discord or email turn too). Not the owner's and not opted in -> not_owner_turn;
 *  2. the bot exists and is enabled (resolveSignedScope already refuses a disabled bot; this is
 *     the same rule said again where the grant is read);
 *  3. the satellite row exists (not_found) and is not revoked (not_active). An UNREACHABLE
 *     satellite is deliberately let through: the entry answers "<name> is unreachable (since
 *     HH:MM)", which is what the bot should see;
 *  4. the bundle is hosted on THAT satellite (installs.js bundleHost: installed.json plus
 *     mcp-addons.json; a local bundle, or one on another satellite, is not_found);
 *  5. the bot is granted at least one tool of the bundle (`<bundle>/<tool>` in its def's
 *     tools.crow_mcp — Bot Builder's grants, never auto-granted, spec §9.4). The granted tool
 *     names are the toolFilter, on tools/list AND on every tools/call.
 * `authorizeSatelliteCall` takes the VERIFIED actor, never the request, so a satellite-originated
 * channel (helper spec §7) can call it with an actor it verified itself.
 *
 * The upstream is the part A `isSatellite` entry (satellites/tool-entry.js), looked up live per
 * request — and only when it is that satellite's OWN entry (`isSatellite === true` and
 * `entry.satelliteId` equal to the route's `:sat`; anything else, a local bundle that shares the
 * id included, is `not_active`). Its `callTool` reads the caller from the ALS store the helper
 * sets, so the signed `X-Crow-Sat-Caller` is `bot:<botId>`, and it applies the pin check, the
 * prefix rule, the signed transport and the 256 KiB text-only cap itself. Its pin refusal carries
 * `code: "tools_changed"`, which is handed back as the helper's own code, so the bot reads the
 * fixed sentence and the audit says `error:tools_changed`.
 */
import { createDbClient as defaultCreateDbClient } from "../../db.js";
import { mountLoopbackMcp } from "../loopback-tool-mount.js";
import { SATELLITE_TOOLS_TOKEN } from "../local-token.js";
import { connectedServers } from "../proxy.js";
import { isOwnerTurnScope } from "../../shared/turn-principal.js";
import { splitEntry } from "../../../scripts/pi-bots/skill-tools.mjs";
import { bundleHost, installPaths } from "./installs.js";
import { getBotOptin, getSatellite } from "./store.js";
import { toolNameRe } from "./tools-pin.js";

export const SATELLITE_TOOLS_FAMILY = "satellite-tools";
/**
 * The operator's ruling (helper spec §11 Q1): satellites stay text-only, 256 KiB. The entry
 * enforces the same cap before answering; the helper checks it again on what it shapes.
 */
export const SATELLITE_TOOLS_RESULT_CAP = Object.freeze({ maxBytes: 262144, contentTypes: Object.freeze(["text"]) });
/**
 * 30 s per call: twice the satellite transport's own 15 s cap (satellites/client.js
 * DEFAULT_TIMEOUT_MS), so a slow tailnet link ends as the entry's own "unreachable"/"failed"
 * answer instead of the helper's generic timeout text. It also stays inside the satellite's
 * ±60 s request-timestamp window, so a call the mount gives up on was never a call the satellite
 * would still have accepted.
 */
export const SATELLITE_TOOLS_CALL_TIMEOUT_MS = 30_000;
/** 4, like the services family: one signed HTTPS request per call, no child process to feed. */
export const SATELLITE_TOOLS_MAX_IN_FLIGHT = 4;

const refuse = (code) => ({ ok: false, code });

/** The tools of `bundle` this def grants: `<bundle>/<tool>` (or `<bundle>__<tool>`) entries. */
export function satelliteGrants(def, bundle) {
  const list = def && def.tools && Array.isArray(def.tools.crow_mcp) ? def.tools.crow_mcp : [];
  const re = toolNameRe(bundle);
  const out = new Set();
  for (const entry of list) {
    if (typeof entry !== "string") continue;
    const x = splitEntry(entry);
    // A bare `<bundle>` grants nothing: satellite tools are granted one by one (spec §9.4).
    if (!x || x[0] !== bundle || !x[1] || !re.test(x[1])) continue;
    out.add(x[1]);
  }
  return [...out];
}

/**
 * Checks 1-5 for a verified actor (a resolveSignedScope result). Request-independent. Any throw
 * is not_granted (fail closed).
 * @returns {Promise<{ok:true, ctx:object}|{ok:false, code:string}>}
 */
export async function authorizeSatelliteCall(db, actor, { sat: satelliteId, bundle }, { engine = null, paths = installPaths() } = {}) {
  try {
    if (!actor || typeof actor !== "object" || typeof actor.botId !== "string" || !actor.botId) return refuse("not_granted");
    if (actor.scope !== "session" && actor.scope !== "job") return refuse("not_granted");
    if (typeof satelliteId !== "string" || !satelliteId || typeof bundle !== "string" || !bundle) return refuse("not_found");
    // 1. Kevin's Q2: the owner's own turn, or the owner opted this bot in.
    const ownerTurn = isOwnerTurnScope(actor, { engine });
    if (!ownerTurn && !(await getBotOptin(db, actor.botId))) return refuse("not_owner_turn");
    // 2. the bot, enabled (pi_bot_defs.enabled is the one "on" switch a bot has).
    const row = (await db.execute({ sql: "SELECT definition, enabled FROM pi_bot_defs WHERE bot_id = ?", args: [actor.botId] })).rows[0];
    if (!row || Number(row.enabled) !== 1) return refuse("not_granted");
    let def = null;
    try { def = row.definition ? JSON.parse(row.definition) : null; } catch { def = null; }
    if (!def || typeof def !== "object" || Array.isArray(def)) return refuse("not_granted");
    // 3. the satellite: unknown is not_found, revoked is not_active (unreachable still answers).
    const sat = await getSatellite(db, satelliteId);
    if (!sat) return refuse("not_found");
    if (sat.status === "revoked") return refuse("not_active");
    // 4. this satellite hosts this bundle (one host per bundle id, installs.js).
    const host = bundleHost(bundle, paths);
    if (host.where !== "satellite" || host.host !== satelliteId) return refuse("not_found");
    // 5. the grant.
    const allowedTools = satelliteGrants(def, bundle);
    if (!allowedTools.length) return refuse("not_granted");
    return {
      ok: true,
      // Satellites pass no secrets: their tokens never leave the satellite (helper spec §5).
      ctx: { satelliteId, satelliteName: sat.name || satelliteId, bundle, botId: actor.botId, ownerTurn, allowedTools, secrets: [] },
    };
  } catch {
    return refuse("not_granted");
  }
}

/** tools/list AND every tools/call: the bundle's prefix rule ∧ the bot's grant (the pin filter is the entry's own list). */
export function satelliteToolsFilter(ctx, tool) {
  if (!ctx || !tool || typeof tool.name !== "string") return false;
  if (!Array.isArray(ctx.allowedTools) || !ctx.allowedTools.includes(tool.name)) return false;
  try { return toolNameRe(ctx.bundle).test(tool.name); } catch { return false; }
}

/**
 * The upstream the helper drives: the satellite entry the part A transport maintains, looked up
 * LIVE per request (a bundle uninstalled or re-pinned mid-session is refused at its next call,
 * never served from a stale reference).
 *
 * Only the route's OWN satellite entry is ever used: a local bundle that happens to share the id
 * (or another satellite's entry) is not reachable through this mount, whatever is in the map.
 * Otherwise the answer is `not_active` — the same sentence a turned-off connection gets.
 */
export function satelliteToolsUpstream({ servers } = {}) {
  const map = () => servers || connectedServers;
  const entryFor = (ctx) => {
    const entry = map().get(ctx.bundle);
    if (!entry || entry.isSatellite !== true || String(entry.satelliteId) !== String(ctx.satelliteId)) return null;
    return entry;
  };
  return {
    listTools: async (ctx) => {
      const entry = entryFor(ctx);
      return Array.isArray(entry?.tools) ? entry.tools : [];
    },
    callTool: async (ctx, name, args) => {
      const entry = entryFor(ctx);
      if (!entry || typeof entry.client?.callTool !== "function") return { code: "not_active" };
      const r = await entry.client.callTool({ name, arguments: args });
      // The entry's pin refusal is a code, so the helper answers with its own fixed text and
      // audits `error:tools_changed`. Every other answer passes through as a shaped result.
      if (r && typeof r.code === "string") return { code: r.code };
      return r;
    },
  };
}

/**
 * Mounts `/satellite-tools/:sat/:bundle/mcp`. Returns the helper's `{ sweepIdle, stop }`.
 * `token`, `servers`, `paths`, `crowHome` and `onAudit` are test seams.
 */
export function mountSatelliteTools(app, {
  sessionManager, createDbClient = defaultCreateDbClient, perchEngine, token = SATELLITE_TOOLS_TOKEN,
  servers, paths = installPaths, onAudit,
} = {}) {
  const pathsOf = () => (typeof paths === "function" ? paths() : paths);
  // The helper calls a function-valued perchEngine itself; authorize needs the object.
  const engineOf = () => {
    try { return typeof perchEngine === "function" ? perchEngine() : perchEngine || null; } catch { return null; }
  };
  return mountLoopbackMcp(app, {
    family: SATELLITE_TOOLS_FAMILY,
    params: ":sat/:bundle",
    actorKind: "satellite-tools",
    token,
    authorize: ({ db, params, actor }) => authorizeSatelliteCall(db, actor, { sat: params.sat, bundle: params.bundle }, { engine: engineOf(), paths: pathsOf() }),
    upstream: satelliteToolsUpstream({ servers }),
    toolFilter: satelliteToolsFilter,
    // Explicit: this family MUST call isOwnerTurnScope itself (part B's Q2 opt-in), so the
    // helper's blanket owner-turn check is off and check 1 lives in authorize above. A change to
    // the helper's default must never quietly turn that into "the owner's turn only".
    ownerTurnOnly: false,
    resultCap: { maxBytes: SATELLITE_TOOLS_RESULT_CAP.maxBytes, contentTypes: [...SATELLITE_TOOLS_RESULT_CAP.contentTypes] },
    callTimeoutMs: SATELLITE_TOOLS_CALL_TIMEOUT_MS,
    maxInFlight: SATELLITE_TOOLS_MAX_IN_FLIGHT,
    perchEngine,
    ...(onAudit ? { onAudit } : {}),
    sessionManager,
    createDbClient,
  });
}