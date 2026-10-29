/**
 * Loopback signing relay (item 46 PR-B): how a key-less bot host gets its
 * turn's actor signatures without the key ever leaving the gateway.
 *
 * The gateway's per-boot actor key (scripts/pi-bots/actor-sig.mjs) lives only
 * in this process's memory. Its in-process bots sign directly and the
 * supervised Discord child receives the key over stdin; the separate systemd
 * hosts (pibot-bridge@, pibot-gateways@, pibot-discord@) get NO key. Before a
 * turn's MCP config is built such a host POSTs its tuple here and caches the
 * signatures (actor-sig.mjs presignActors).
 *
 *   POST /internal/actor-sign
 *   { botId, sessionId?, threadId?, gatewayType?, jobId?, kinds: [...] }
 *   → 200 { sigs: { <kind>: <hex> } }      nothing else, never the key
 *
 * Order:
 *   1. a plain loopback request (classifyPeer via "local")           else 404
 *   2. the caller is the MAIN process of a live, installed bot host unit
 *      (bot-host-caller.js: socket inode ↔ /proc/<MainPID>/fd, cgroup,
 *      start time, Transient=no, the template's own unit file)        else 403
 *   3. a well-formed body: BOT_ID_RE bot, known kinds               else 400
 *   4. the host serves THIS instance: its /etc/crow/pibot-<i>.env names
 *      this gateway's database                                        else 403
 *   5. the bot is enabled here, and this host hosts it on the turn's
 *      gateway, judged from the same pi_bot_defs row the host reads to pick
 *      its bots (hostsTurn below)                                    else 403
 *   6. sessionId given: a live session of this bot (signed-session.js)
 *      whose thread and gateway are the request's                    else 403
 *      jobId given: a running bot_jobs row of this bot that THIS host's
 *      main process claimed (worker_pid)                              else 403
 *      no session: only a generic job's own tuple (thread "job-<id>",
 *      gateway "job"), and no session kind                       else 403/400
 *   7. this process holds the key                                    else 503
 * So a host can only obtain signatures for a real, live session (or a job it
 * is running) of a bot it hosts, and for exactly that session's tuple.
 *
 * Reachable only from loopback, and nothing in it trusts a header: step 1 is
 * classifyPeer (servers/shared/peer-class.js), which reads the TCP socket and
 * answers "local" only for a loopback socket carrying no forwarding or
 * tailscale-* header; step 2 reads the kernel and systemd. A local process
 * can set any header it likes and gain nothing.
 *
 * Mountable on a bare express app: every dependency is a function parameter.
 */
import { Router } from "express";
import { classifyPeer } from "../../shared/peer-class.js";
import { resolveSignedSession, sessionMatchesTuple } from "../../shared/signed-session.js";
import { createBotHostCallerResolver } from "../bot-host-caller.js";
import { SESSION_ACTOR_KINDS, hasActorKey, signKindForTuple } from "../../../scripts/pi-bots/actor-sig.mjs";
import { BOT_ID_RE } from "../../../scripts/pi-bots/bot-workspace-env.mjs";
import { resolveDbPath } from "../../db.js";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export const ACTOR_SIGN_PATH = "/internal/actor-sign";
export const ACTOR_SIGN_KINDS = Object.freeze(["bot", "board", "artifacts", "board-thread", ...SESSION_ACTOR_KINDS]);

const REFUSE_LOG_WINDOW_MS = 3_600_000;
const REFUSE_LOG_CAP = 64;
const refusedLogged = new Map();
/** Test seam on module state (like peer-relay.js's _resetPeerRelayLog). */
export function _resetActorSignLog() { refusedLogged.clear(); }

function noteRefused(reason, now) {
  const last = refusedLogged.get(reason);
  if (last !== undefined && now - last < REFUSE_LOG_WINDOW_MS) return;
  refusedLogged.delete(reason);
  if (refusedLogged.size >= REFUSE_LOG_CAP) refusedLogged.delete(refusedLogged.keys().next().value);
  refusedLogged.set(reason, now);
  console.warn(`[actor-sign] refused a caller: ${reason}`);
}

/** Lazily: the Telegram/Slack/... registry pibot-gateways@ hosts (gateways/index.mjs). */
let hostManagedP = null;
function hostManaged() {
  if (!hostManagedP) hostManagedP = import("../../../scripts/pi-bots/gateways/index.mjs").then((m) => m.isHostManaged).catch(() => () => false);
  return hostManagedP;
}

const JOB_GATEWAYS = new Set(["job", "board"]); // job_runner.mjs: generic jobs, and card execution through handleInbound

/**
 * Does a host of this template run this bot's turn on this gateway? The same
 * rules the hosts use to pick their bots from pi_bot_defs:
 *  - bridge   (bridge_tick_lib.mjs): a gmail gateway with an address; and the job drain
 *  - gateways (gateways/gateway_runner.mjs): a host-managed gateway type; and the job drain
 *  - discord  (discord_gateway.mjs): a discord gateway
 * Job turns are further bound to the job this host claimed (step 6).
 */
export async function hostsTurn(template, def, gatewayType) {
  const gws = def && Array.isArray(def.gateways) ? def.gateways : [];
  const has = (pred) => gws.some((g) => g && typeof g === "object" && pred(g));
  if (JOB_GATEWAYS.has(gatewayType)) return template === "bridge" || template === "gateways";
  if (template === "bridge") return gatewayType === "gmail" && has((g) => g.type === "gmail" && g.address);
  if (template === "discord") return gatewayType === "discord" && has((g) => g.type === "discord");
  if (template === "gateways") return (await hostManaged())(gatewayType) && has((g) => g.type === gatewayType);
  return false;
}

const canonical = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };

// Trimmed, like every field of the actor-sig MAC: a padded value signs and
// matches exactly as its trimmed form does (signed-session.js sessionMatchesTuple).
const str = (v) => (typeof v === "string" ? v.trim() : v == null ? undefined : typeof v === "number" ? String(v) : null);

/**
 * @param {object} o
 * @param {() => object} o.createDbClient
 * @param {object} [o.deps]
 * @param {{authenticate: (socket) => Promise<{ok:boolean, reason?:string}>}} [o.deps.resolver]
 * @param {() => number} [o.deps.now]
 */
export function actorSignRouter({ createDbClient, deps = {} } = {}) {
  if (typeof createDbClient !== "function") throw new TypeError("actorSignRouter: createDbClient is required");
  const resolver = deps.resolver || createBotHostCallerResolver();
  const now = deps.now || (() => Date.now());
  const localDbPath = deps.localDbPath || resolveDbPath();
  const router = Router();

  router.post(ACTOR_SIGN_PATH, async (req, res) => {
    const fail = (status, error) => { if (!res.headersSent) res.status(status).json({ error }); };

    // 1. Only this host's own processes, unproxied (404: the route is not there for anyone else).
    let via = null;
    try { via = classifyPeer(req).via; } catch { via = null; }
    if (via !== "local") return fail(404, "not found");

    // 2. The kernel says who connected.
    let who;
    try { who = await resolver.authenticate(req.socket); } catch { who = { ok: false, reason: "caller check failed" }; }
    if (!who || who.ok !== true) {
      noteRefused((who && who.reason) || "unknown", now());
      return fail(403, "only a bot host's main process may ask for signatures");
    }

    // 3. The request.
    const b = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : null;
    if (!b) return fail(400, "a JSON object body is required");
    const botId = str(b.botId), sessionId = str(b.sessionId), threadId = str(b.threadId), gatewayType = str(b.gatewayType), jobId = str(b.jobId);
    if (typeof botId !== "string" || !BOT_ID_RE.test(botId)) return fail(400, "a valid botId is required");
    if ([sessionId, threadId, gatewayType, jobId].some((v) => v === null || (typeof v === "string" && v.length > 512))) return fail(400, "malformed tuple");
    const kinds = Array.isArray(b.kinds) ? [...new Set(b.kinds)] : null;
    if (!kinds || !kinds.length || !kinds.every((k) => ACTOR_SIGN_KINDS.includes(k))) return fail(400, "kinds must be a non-empty list of known kinds");
    const wantsSession = kinds.some((k) => SESSION_ACTOR_KINDS.includes(k));
    if (sessionId !== undefined && sessionId !== "" && !/^[1-9][0-9]{0,15}$/.test(sessionId.trim())) return fail(400, "malformed sessionId");
    const hasSession = sessionId !== undefined && sessionId !== "";
    if (wantsSession && !hasSession) return fail(400, "session kinds need a sessionId");

    // 4. A host of this instance (its instance config names this database).
    if (!who.hostDbPath || canonical(who.hostDbPath) !== canonical(localDbPath)) return fail(403, "this bot host serves another instance");

    let db;
    try {
      db = createDbClient();
      // 5. A bot this host hosts, on this gateway (from the row the host itself reads).
      const bot = await db.execute({ sql: "SELECT definition, enabled FROM pi_bot_defs WHERE bot_id = ?", args: [botId] });
      const row = bot.rows[0];
      if (!row) return fail(403, "unknown bot");
      if (Number(row.enabled) !== 1) return fail(403, "the bot is not enabled");
      let def = null;
      try { def = row.definition ? JSON.parse(row.definition) : null; } catch { def = null; }
      if (!(await hostsTurn(who.template, def, gatewayType))) return fail(403, `this bot host does not host the bot on gateway '${gatewayType ?? ""}'`);

      // 6. A live session (or running job) of that bot, for exactly its tuple.
      if (jobId !== undefined && jobId !== "") {
        let job = null;
        try {
          const r = await db.execute({ sql: "SELECT status, worker_pid FROM bot_jobs WHERE job_id = ? AND bot_id = ?", args: [jobId, botId] });
          job = r.rows[0] || null;
        } catch { job = null; }
        if (!job || job.status !== "running") return fail(403, "no running job of this bot");
        if (Number(job.worker_pid) !== who.pid) return fail(403, "the job was claimed by another host");
      }
      if (hasSession) {
        const s = await resolveSignedSession(db, { botId, sessionId });
        if (!s) return fail(403, "not a live session of this bot");
        if (!sessionMatchesTuple(s, { threadId, gatewayType })) return fail(403, "the tuple is not the session's");
      } else {
        // A generic background job: its own fixed tuple only (job_runner.mjs jobActor).
        if (jobId === undefined || jobId === "" || threadId !== `job-${jobId}` || gatewayType !== "job") return fail(403, "neither a live session nor a running job's tuple");
      }

      // 7. Sign with this process's key; the key itself never leaves.
      if (!hasActorKey()) return fail(503, "the gateway holds no actor key");
      const tuple = { botId, sessionId, threadId, gatewayType, jobId };
      const sigs = {};
      for (const kind of kinds) {
        const sig = signKindForTuple(kind, tuple);
        if (sig) sigs[kind] = sig;
      }
      return res.json({ sigs });
    } catch (err) {
      console.error(`[actor-sign] error: ${err && err.message}`);
      return fail(500, "signing relay error");
    } finally {
      if (db) { try { db.close(); } catch {} }
    }
  });
  return router;
}
