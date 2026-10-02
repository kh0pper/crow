/**
 * Peer status liveness writes that respect operator decisions.
 *
 * `crow_instances.status` carries two kinds of value:
 *   - liveness, set by the connection loops: 'active' / 'offline'
 *   - operator decisions: 'revoked' (crow_revoke_instance, the Paired
 *     Instances revoke button) and 'paused' (crow_update_instance)
 *
 * A connection loop must never overwrite an operator decision. Before this
 * helper, four loops wrote liveness unconditionally (gateway proxy probe,
 * Hyperswarm onInstanceConnected, both tailnet-sync directions), so a revoke
 * lasted only until the next probe or the next same-crow_id peer connection
 * (MPA retirement defect 4, 2026-08-10).
 *
 * Use livenessStatusSql('active' | 'offline') as the right-hand side of
 * `status = ...` in any liveness UPDATE.
 */

export const STICKY_STATUSES = Object.freeze(["revoked", "paused"]);

const LIVENESS = new Set(["active", "offline"]);

export function livenessStatusSql(next) {
  if (!LIVENESS.has(next)) throw new Error(`livenessStatusSql: not a liveness status: ${next}`);
  const sticky = STICKY_STATUSES.map((s) => `'${s}'`).join(", ");
  return `CASE WHEN status IN (${sticky}) THEN status ELSE '${next}' END`;
}

/**
 * Mark the peer(s) behind one Hyperswarm instance connection as seen.
 *
 * All instances of one user share one crow_id, so "crow_id X connected"
 * does not say WHICH instance connected. When the peer advertised its
 * instance_id on the challenge-response, only that row is touched; for an
 * older peer that sends no instance_id, only the rows the caller matched
 * (already filtered to live statuses) are touched. Never every row with the
 * crow_id: that fan-out kept the retired MPA row 'active' with a fresh
 * last_seen_at for weeks after its process was gone (audit 2026-10-02).
 *
 * @param {object} db
 * @param {object} opts
 * @param {string[]} opts.matchedIds   ids the caller selected for this crow_id (live statuses only)
 * @param {string|null} [opts.remoteInstanceId]  the peer's advertised instance_id, if any
 * @returns {Promise<string[]>} the ids updated
 */
export async function markInstanceConnectionSeen(db, { matchedIds, remoteInstanceId = null }) {
  const ids = remoteInstanceId
    ? (matchedIds.includes(remoteInstanceId) ? [remoteInstanceId] : [])
    : [...matchedIds];
  for (const id of ids) {
    await db.execute({
      sql: `UPDATE crow_instances SET last_seen_at = datetime('now'), status = ${livenessStatusSql("active")} WHERE id = ?`,
      args: [id],
    });
  }
  return ids;
}
