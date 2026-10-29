/**
 * Recall gate for session-summary memories (R1.2 PR 4; spec §9.11, option 1).
 *
 * A summary memory carries the privacy rank of the session it came from, in
 * the tags the summary job writes ("source-rank-<0|1|2>": this box, another of
 * your boxes, the cloud). The source prefix is reserved (summary-source.js:
 * only the job writes such a memory, nothing edits it), so the tag cannot be
 * spoofed. A model-facing recall (crow_recall_by_context, crow_search_memories,
 * crow_deep_recall, and every router or proxy path, which all run those same
 * handlers) returns a summary only to an asker at least as private as its
 * source: asker rank <= source rank.
 *
 * The asker is the call's actor (servers/research/actor.js): a bot (stdio env,
 * or a product client's x-crow-actor headers) ranks by where its current
 * model runs (whereItRuns, the same ranking as the summary job). Anything
 * else (the owner over MCP, whose client model is unknown, an unknown caller,
 * a bot whose model cannot be resolved) ranks as the CLOUD, fail closed: it
 * gets only cloud-rank summaries. A summary with no readable rank tag counts
 * as this box (reaches a this-box asker only). Operator views (the memory
 * panel, the project home) do not go through here and are not filtered.
 */
export const RANK_HERE = 0;
export const RANK_CLOUD = 2;
const RANK = Object.freeze({ here: 0, other_box: 1, cloud: 2 });

/**
 * The SQL clause (starting with " AND") that keeps a summary memory only when
 * its source rank is >= askerRank; "" when the asker is this box (sees all).
 * `alias` is the memories table alias ("m." or "").
 */
export function summaryRecallClause(askerRank, alias = "m.") {
  const r = Number.isInteger(askerRank) && askerRank >= RANK_HERE && askerRank <= RANK_CLOUD ? askerRank : RANK_CLOUD;
  if (r === RANK_HERE) return "";
  const allowed = [];
  for (let k = r; k <= RANK_CLOUD; k++) allowed.push(`(',' || COALESCE(${alias}tags, '') || ',') LIKE '%,source-rank-${k},%'`);
  return ` AND (${alias}source IS NULL OR ${alias}source NOT LIKE 'session-summary:%' OR ${allowed.join(" OR ")})`;
}

function defaultModelOf(definition) {
  try { const d = JSON.parse(definition || "{}"); return d && d.models && d.models.default ? String(d.models.default) : null; } catch { return null; }
}

/**
 * The asker's rank. A bot: its current model (the newest perch-live row's
 * explicit model for `threadId`, else the bot's default; a role key resolved),
 * ranked by whereItRuns. Anything unknown: the cloud. Never throws.
 */
export async function askerRank(db, actor, { threadId = null, where = null, resolveRole = null } = {}) {
  try {
    if (!actor || actor.kind !== "bot" || !actor.id) return RANK_CLOUD;
    let key = null;
    if (threadId) {
      const { rows } = await db.execute({
        sql: "SELECT model FROM bot_sessions WHERE gateway_thread_id = ? AND bot_id = ? AND model IS NOT NULL AND trim(model) != '' ORDER BY id DESC LIMIT 1",
        args: [String(threadId), String(actor.id)],
      });
      if (rows[0]) key = String(rows[0].model);
    }
    if (!key) {
      const { rows } = await db.execute({ sql: "SELECT definition FROM pi_bot_defs WHERE bot_id = ?", args: [String(actor.id)] });
      key = rows[0] ? defaultModelOf(rows[0].definition) : null;
    }
    if (!key) return RANK_CLOUD;
    let resolve = resolveRole, whereFn = where;
    if (!resolve || !whereFn) {
      const [{ resolveRole: rr, loadRoleContext }, { whereItRuns }, { getOwnAddresses }] = await Promise.all([
        import("../shared/model-roles-store.js"), import("../shared/model-roles.js"), import("../shared/locality.js"),
      ]);
      resolve = resolve || ((d, k) => rr(d, k, { need: "chat" }));
      if (!whereFn) {
        const ctx = await loadRoleContext(db);
        const ownAddrs = getOwnAddresses();
        whereFn = (k) => whereItRuns(k, { providers: ctx.providers, ownAddrs });
      }
    }
    if (key.startsWith("role:")) {
      const r = await resolve(db, key);
      key = r && r.key ? String(r.key) : null;
      if (!key) return RANK_CLOUD;
    }
    const w = whereFn(key);
    return Object.hasOwn(RANK, w) ? RANK[w] : RANK_CLOUD;
  } catch { return RANK_CLOUD; }
}
