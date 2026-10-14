// Crow Artifacts — which chats an artifact's cards fan out to (spec v1.6 D25).
//
// ONE function, ONE query over artifact_links (PR-3; PR-1 read origin_session
// here). Only ACTIVE links of a live artifact count. A link always names its
// bot: the engine hook is bot-checked, so a card can only reach a chat of the
// bot the link names.

/** @returns {Promise<Array<{threadId: string, botId: string, linkedAt: string}>>} active links, most recent first. */
export async function linkedThreads(db, artifactId) {
  const { rows } = await db.execute({
    sql: `SELECT l.thread_id, l.bot_id, l.linked_at FROM artifact_links l JOIN artifacts a ON a.id=l.artifact_id
          WHERE l.artifact_id=? AND l.unlinked_at IS NULL AND a.deleted_at IS NULL
          ORDER BY l.linked_at DESC, l.id DESC`,
    args: [String(artifactId)],
  });
  return rows.map((r) => ({ threadId: String(r.thread_id), botId: String(r.bot_id), linkedAt: String(r.linked_at) }));
}

/** The active link of ONE chat (null when that chat is not linked). */
export async function activeLink(db, artifactId, threadId) {
  const r = (await db.execute({
    sql: "SELECT l.id, l.bot_id, l.thread_id, l.linked_at FROM artifact_links l JOIN artifacts a ON a.id=l.artifact_id WHERE l.artifact_id=? AND l.thread_id=? AND l.unlinked_at IS NULL AND a.deleted_at IS NULL",
    args: [String(artifactId), String(threadId)],
  })).rows[0];
  return r ? { id: Number(r.id), botId: String(r.bot_id), threadId: String(r.thread_id), linkedAt: String(r.linked_at) } : null;
}
