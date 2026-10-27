/**
 * The re-pair fence (PT-1).
 *
 * While a peer is revoked its entries are never applied and the applied seq
 * does not advance. Without a fence, a re-pair would then replay everything
 * the revoked (possibly compromised) peer appended during the revoked window.
 * Reactivation therefore sets `ff: 1` on the peer's applied-seq record, in the
 * SAME transaction as the revoked→active row write; the first apply run after
 * the re-pair fast-forwards to the remote feed length instead of applying
 * (instance-sync.js _processNewEntriesInner) and clears the flag.
 *
 * The write must land in every record shape: a NULL blob, no record for the
 * peer (SQLite json_set never creates a missing parent), a legacy bare-number
 * record, and no sync_state row at all. So the whole record is written, the
 * sync_state row is seeded first, and a final statement aborts the batch
 * (NOT NULL violation) unless `ff = 1` reads back.
 */

/** The JSON path of a peer's applied-seq record. Ids with `"` are refused. */
export function appliedSeqPath(peerId) {
  if (typeof peerId !== "string" || !peerId || peerId.includes('"')) {
    throw new Error("repair fence: unusable peer id");
  }
  return `$."${peerId}"`;
}

/**
 * Statements to run inside the reactivation's transaction.
 * @param {string} localInstanceId  sync_state.instance_id (this instance)
 * @param {string} peerId
 */
export function fenceStatements(localInstanceId, peerId) {
  if (!localInstanceId) throw new Error("repair fence: local instance id required");
  const path = appliedSeqPath(peerId);
  const blob = "COALESCE(last_applied_seq_per_peer, '{}')";
  return [
    { sql: "INSERT OR IGNORE INTO sync_state (instance_id, local_counter) VALUES (?, 0)", args: [localInstanceId] },
    {
      // Plain `?` params only (the better-sqlite3 wrapper binds arrays
      // positionally); the path is repeated once per use.
      sql: `UPDATE sync_state
              SET last_applied_seq_per_peer = json_set(${blob}, ?,
                    json_object(
                      'k', CASE WHEN json_type(${blob}, ?) = 'object' THEN json_extract(${blob}, ?) END,
                      's', CASE json_type(${blob}, ?)
                             WHEN 'object' THEN COALESCE(json_extract(${blob}, ?), 0)
                             WHEN 'integer' THEN json_extract(${blob}, ?)
                             WHEN 'real' THEN json_extract(${blob}, ?)
                             ELSE 0 END,
                      'ff', 1)),
                  updated_at = datetime('now')
            WHERE instance_id = ?`,
      args: [path, path, `${path}.k`, path, `${path}.s`, path, path, localInstanceId],
    },
    {
      // Abort the whole batch unless the fence reads back.
      sql: `INSERT INTO dashboard_settings_overrides (key, instance_id, value)
              SELECT NULL, NULL, NULL
              WHERE COALESCE((SELECT json_extract(last_applied_seq_per_peer, ?) FROM sync_state WHERE instance_id = ?), 0) != 1`,
      args: [`${path}.ff`, localInstanceId],
    },
  ];
}
