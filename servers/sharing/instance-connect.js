/**
 * Hyperswarm instance-connection handling, extracted from boot.js's
 * peerManager.onInstanceConnected so it can be driven by a test (review I2).
 *
 * All of one user's instances share one crow_id, so "crow_id X connected"
 * does not say which instance is on the other end. peer-manager passes the
 * instance_id the peer advertised on its challenge-response; when present,
 * ONLY that instance's feeds ride this connection and only its row is marked
 * seen. Before this, one sibling's connection replicated every live sibling
 * row (and refreshed every row's status), so a revoked or departed sibling
 * could be carried through someone else's connection.
 *
 * Older peers that advertise no instance_id keep the legacy behaviour:
 * every LIVE same-crow_id row (active/offline; revoked and paused excluded).
 */
import { markInstanceConnectionSeen } from "../shared/instance-status.js";

/**
 * @param {object} p
 * @param {object} p.db
 * @param {object} p.instanceSyncManager
 * @param {string} p.crowId
 * @param {object} p.conn                 the authenticated Hyperswarm stream
 * @param {string|null} [p.remoteInstanceId]
 * @returns {Promise<string[]>} the instance ids replicated over `conn`
 */
export async function handleInstanceConnection({ db, instanceSyncManager, crowId, conn, remoteInstanceId = null }) {
  // Accept status='active' or 'offline' — a live Hyperswarm connection IS
  // the signal the peer is up (an offline-but-connected peer must still
  // initialize). Revoked/paused peers stay excluded.
  const { rows } = await db.execute({
    sql: "SELECT id FROM crow_instances WHERE crow_id = ? AND status IN ('active','offline') AND id != ?",
    args: [crowId, instanceSyncManager.localInstanceId],
  });
  const liveIds = rows.map((r) => r.id);
  const targets = remoteInstanceId
    ? liveIds.filter((id) => id === remoteInstanceId)
    : liveIds;

  for (const id of targets) {
    // Arm the out-feed (and the in-feed if a key is already known). No key
    // is passed: the authenticated feed-key receipt on the challenge-response
    // drives any swap (same rule as tailnet-sync's 2d F3 note).
    await instanceSyncManager.initInstance(id, null);
    await instanceSyncManager.replicate(id, conn);
  }

  await markInstanceConnectionSeen(db, { matchedIds: liveIds, remoteInstanceId });
  return targets;
}
