// Crow Artifacts — which chats an artifact's cards fan out to (spec v1.6 D25).
//
// ONE function, ONE query: PR-1's interim answer is the origin session (the
// chat that made the artifact); PR-3 swaps the body to the artifact_links
// table (many linked chats, ask-first linking) without touching any caller.
// A link without a bot can never receive a card (the engine hook is
// bot-checked), so it is not returned.

/** @returns {Promise<Array<{threadId: string, botId: string}>>} active links, most recent first. */
export async function linkedThreads(db, artifactId) {
  const r = (await db.execute({
    sql: "SELECT created_by_bot, origin_session FROM artifacts WHERE id=? AND deleted_at IS NULL",
    args: [String(artifactId)],
  })).rows[0];
  if (!r || !r.origin_session || !r.created_by_bot) return [];
  return [{ threadId: String(r.origin_session), botId: String(r.created_by_bot) }];
}
