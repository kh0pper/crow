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
 * comment silently). Never throws into a contact-delete path — a missing
 * table (bundle not installed) is a no-op, and any other failure must not
 * wedge the delete it rides along with.
 */
export async function deleteContactArtifactComments(db, crowId) {
  if (!db || !crowId) return 0;
  try {
    const r = await db.execute({
      sql: "UPDATE artifact_comments SET deleted_at=datetime('now'), text='' WHERE author_kind='contact' AND author_id=? AND deleted_at IS NULL",
      args: [String(crowId)],
    });
    return Number(r.rowsAffected || 0);
  } catch {
    return 0;   // no such table (bundle not installed) or a DB hiccup: the contact delete proceeds
  }
}
