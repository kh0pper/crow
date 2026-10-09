/**
 * D19 (spec §4.3): when a contact is deleted, their words go with them —
 * including the comments they authored on artifacts. The artifact tables live
 * in the SAME crow.db but ship with the Artifacts bundle, which may not be
 * installed (no tables) — so this is a guarded core helper, not an import of
 * the bundle's deleteContactComments (bundles/artifacts/server/comments.js
 * carries the identical statement for bundle-side callers).
 *
 * Soft delete, matching the bundle's rule: the text is blanked and stamped,
 * the row stays for thread integrity (a thread must not lose its anchor
 * comment silently). A MISSING table (bundle not installed) is a no-op; any
 * other error propagates to the caller, which decides per path: the user
 * delete and the prune treat it as a failed delete (retryable / rewire), the
 * sync apply loop logs and proceeds (a hook must never wedge the feed).
 */
export async function deleteContactArtifactComments(db, crowId) {
  if (!db || !crowId) return 0;
  try {
    const r = await db.execute(artifactCommentsBlankStatement(crowId));
    return Number(r.rowsAffected || 0);
  } catch (e) {
    if (/no such table/i.test(String(e && e.message))) return 0;   // bundle not installed
    throw e;
  }
}

/** The blanking statement as a batch entry — for callers that must run it in
 *  ONE transaction with the contact delete (the prune path, review C3-L2). */
export function artifactCommentsBlankStatement(crowId) {
  return {
    sql: "UPDATE artifact_comments SET deleted_at=datetime('now'), text='' WHERE author_kind='contact' AND author_id=? AND deleted_at IS NULL",
    args: [String(crowId)],
  };
}

/** Does the bundle's comments table exist? Never throws. */
export async function artifactCommentsTableExists(db) {
  if (!db) return false;
  try { await db.execute({ sql: "SELECT 1 FROM artifact_comments LIMIT 1", args: [] }); return true; } catch { return false; }
}
