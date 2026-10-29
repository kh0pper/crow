/**
 * The bot session a session-bound actor signature names (item 46 PR-B).
 *
 * A v2 actor signature (scripts/pi-bots/actor-sig.mjs, kind "peer-relay")
 * binds a bot_sessions.id. The signature proves which session the
 * gateway signed for; this check says whether that session may still act: the
 * row exists, belongs to the signed bot, is not archived, and has not ended
 * (status "done" or "stopped"). Everything a session-scoped mount needs about
 * the caller (its project, its thread) comes from this row, never from the
 * request.
 *
 * Shared by the peer relay (servers/gateway/routes/peer-relay.js), the loopback
 * signing relay (servers/gateway/routes/actor-sign.js) and the loopback MCP
 * mount helper (resolveSignedScope, for the v3 scope-bound kinds). `db` is any
 * client with the libsql `execute` shape.
 */

const ENDED = new Set(["done", "stopped"]);

/** A bot_sessions.id as a positive integer, or null for anything else. */
export function parseSessionId(v) {
  if (typeof v === "number") return Number.isSafeInteger(v) && v > 0 ? v : null;
  if (typeof v !== "string") return null;
  const t = v.trim();
  return /^[1-9][0-9]{0,15}$/.test(t) && Number.isSafeInteger(Number(t)) ? Number(t) : null;
}

/**
 * @returns {Promise<{id:number, botId:string, projectId:number|null, threadId:string|null, gatewayType:string|null}|null>}
 *   null when the session is not a live session of `botId` (or the read fails).
 */
export async function resolveSignedSession(db, { botId, sessionId } = {}) {
  const id = parseSessionId(sessionId);
  if (id === null || typeof botId !== "string" || botId.trim() === "") return null;
  let row = null;
  try {
    const r = await db.execute({
      sql: "SELECT id, bot_id, project_id, gateway_thread_id, gateway_type, status, archived_at FROM bot_sessions WHERE id = ?",
      args: [id],
    });
    row = r.rows[0] || null;
  } catch {
    return null;
  }
  if (!row || row.bot_id !== botId.trim() || row.archived_at != null || ENDED.has(String(row.status))) return null;
  return {
    id: Number(row.id),
    botId: row.bot_id,
    projectId: row.project_id == null ? null : Number(row.project_id),
    threadId: row.gateway_thread_id == null ? null : String(row.gateway_thread_id),
    gatewayType: row.gateway_type == null ? null : String(row.gateway_type),
  };
}

/**
 * Is (threadId, gatewayType) this session's own? Fields are trimmed on both
 * sides and a missing value is "", the same rule the actor-sig MAC applies,
 * so a tuple that verifies compares the same way everywhere.
 */
export function sessionMatchesTuple(session, { threadId, gatewayType } = {}) {
  if (!session) return false;
  const f = (v) => (v == null ? "" : String(v).trim());
  return f(threadId) === f(session.threadId) && f(gatewayType) === f(session.gatewayType);
}

/**
 * The running bot_jobs row a job-bound actor names (the one job check, shared
 * by the signing relay and the mount helper): that job id, that bot, status
 * 'running', and (when `workerPid` is given) claimed by that process.
 * `principal` is read tolerantly: the column arrives with a later migration,
 * and a database without it reads null, which is never the owner.
 * @returns {Promise<{jobId:string, botId:string, cardId:number|null, principal:string|null, workerPid:number|null}|null>}
 *   null for anything else, or when the read fails. Never throws.
 */
export async function resolveRunningJob(db, { botId, jobId, workerPid } = {}) {
  if (typeof botId !== "string" || botId.trim() === "" || typeof jobId !== "string" || jobId.trim() === "") return null;
  let row = null;
  try {
    // SELECT *: a missing principal column must not fail the read (see above).
    const r = await db.execute({ sql: "SELECT * FROM bot_jobs WHERE job_id = ? AND bot_id = ?", args: [jobId.trim(), botId.trim()] });
    row = r.rows[0] || null;
  } catch {
    return null;
  }
  if (!row || row.status !== "running") return null;
  const pid = row.worker_pid == null ? null : Number(row.worker_pid);
  if (workerPid !== undefined && workerPid !== null && pid !== Number(workerPid)) return null;
  return {
    jobId: String(row.job_id),
    botId: String(row.bot_id),
    cardId: row.card_id == null ? null : Number(row.card_id),
    principal: row.principal == null ? null : String(row.principal),
    workerPid: pid,
  };
}

/**
 * Is (threadId, gatewayType) one of the two tuples a running job may carry?
 * `job-<job_id>` / `job` (a generic job, job_runner.mjs jobActor), or
 * `board-card-<card_id>` / `board` for the job's own non-null card_id (card
 * execution through handleInbound). Trimmed like the MAC.
 */
export function jobMatchesTuple(job, { threadId, gatewayType } = {}) {
  if (!job) return false;
  const f = (v) => (v == null ? "" : String(v).trim());
  const t = f(threadId), g = f(gatewayType);
  if (g === "job" && t === `job-${job.jobId}`) return true;
  return g === "board" && job.cardId != null && t === `board-card-${job.cardId}`;
}

// The v3 scope ref (scripts/pi-bots/actor-sig.mjs SCOPE_RE, kept in step).
const SCOPE_REF_RE = /^(s:[1-9][0-9]{0,15}|j:[A-Za-z0-9._:-]{1,128})$/;

/**
 * Resolve the scope a verified v3 signature names (spec §4.2):
 *  - "s:<id>": a live session of the bot whose thread and gateway are the tuple's;
 *  - "j:<id>": a running job of the bot whose tuple is one of jobMatchesTuple's.
 * `defProjectId` is the bot def's own pi_bot_defs.project_id (the authority;
 * null stays null), never anything from the request. A bot without a def is
 * null. `sessionProjectId` is returned for s: only, `principal` for j: only.
 * @returns {Promise<object|null>} null for anything else. Never throws.
 */
export async function resolveSignedScope(db, { botId, scopeRef, threadId, gatewayType } = {}) {
  try {
    if (!db || typeof botId !== "string" || botId.trim() === "" || typeof scopeRef !== "string") return null;
    const ref = scopeRef.trim();
    if (!SCOPE_REF_RE.test(ref)) return null;
    const bot = botId.trim();
    const id = ref.slice(2);
    let out = null;
    if (ref.startsWith("s:")) {
      const s = await resolveSignedSession(db, { botId: bot, sessionId: id });
      if (!s || !sessionMatchesTuple(s, { threadId, gatewayType })) return null;
      out = { scope: "session", id: s.id, botId: s.botId, threadId: s.threadId, gatewayType: s.gatewayType, sessionProjectId: s.projectId };
    } else {
      const j = await resolveRunningJob(db, { botId: bot, jobId: id });
      if (!j || !jobMatchesTuple(j, { threadId, gatewayType })) return null;
      const f = (v) => (v == null ? "" : String(v).trim());
      out = { scope: "job", id: j.jobId, botId: j.botId, threadId: f(threadId), gatewayType: f(gatewayType), principal: j.principal };
    }
    let def;
    try {
      const r = await db.execute({ sql: "SELECT project_id FROM pi_bot_defs WHERE bot_id = ?", args: [bot] });
      def = r.rows[0] || null;
    } catch {
      return null;
    }
    if (!def) return null;
    const defProjectId = def.project_id == null ? null : Number(def.project_id);
    return out.scope === "session"
      ? { scope: out.scope, id: out.id, botId: out.botId, threadId: out.threadId, gatewayType: out.gatewayType, defProjectId, sessionProjectId: out.sessionProjectId }
      : { scope: out.scope, id: out.id, botId: out.botId, threadId: out.threadId, gatewayType: out.gatewayType, defProjectId, principal: out.principal };
  } catch {
    return null;
  }
}
