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
 * signing relay (servers/gateway/routes/actor-sign.js). `db` is any client
 * with the libsql `execute` shape.
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
