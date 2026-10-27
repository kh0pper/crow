/**
 * PT-1 fixture: the sync apply gate applies entries only from a trusted,
 * live paired peer and fails closed on an id with no crow_instances row.
 * Tests that feed a manager from stub or bare in-feeds (no pairing) model
 * remotes that ARE paired and trusted, so this pairs each remote for the
 * duration of an apply run. The row is removed again afterwards so it never
 * becomes an emit target or a "new peer" in later assertions.
 */
export function trustRemotesOnApply(mgr) {
  const inner = mgr._processNewEntriesInner.bind(mgr);
  mgr._processNewEntriesInner = async (remoteId, feed) => {
    const added = await mgr.db.execute({
      sql: "INSERT OR IGNORE INTO crow_instances (id, name, crow_id, status, trusted) VALUES (?, ?, 'crow:stub', 'active', 1)",
      args: [remoteId, remoteId],
    });
    try { return await inner(remoteId, feed); } finally {
      if (added.rowsAffected) await mgr.db.execute({ sql: "DELETE FROM crow_instances WHERE id = ?", args: [remoteId] });
    }
  };
  return mgr;
}
