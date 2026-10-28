// Crow Artifacts — which chats an artifact's cards fan out to, and which chat
// a Send may go to (spec v1.6 D25).
//
// ONE function, ONE query over artifact_links (PR-3; PR-1 read origin_session
// here). Only ACTIVE links of a live artifact count. A link always names its
// bot: the engine hook is bot-checked, so a card can only reach a chat of the
// bot the link names.

import { botHasArtifactsTools } from "./delivery.js";
import { isLocked } from "./trust.js";

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

/**
 * May a round of THIS bot go to THIS chat? (plan PR-3 Task 3.3, review M4/M5c.)
 * Checked by the owner's Send route AND again at delivery (the sweep included).
 * Returns null when it may, else a named reason:
 *   target_unlinked      — no ACTIVE link of this artifact to this chat;
 *   target_other_bot     — the link names a different bot;
 *   target_no_access     — the bot neither made the artifact nor holds a grant;
 *   target_not_bots_chat — the chat's own session row is not this bot's (or is missing);
 *   bot_lacks_artifacts  — the bot's def no longer grants the Artifacts tools;
 *   target_locked        — the chat is locked (D23: never a trusted round).
 * Fail closed: a query error reads as unlinked.
 */
export async function verifyTarget(db, { artifactId, botId, threadId, botDef }) {
  try {
    if (!botId || !threadId) return "target_unlinked";
    const l = await activeLink(db, artifactId, threadId);
    if (!l) return "target_unlinked";
    if (l.botId !== String(botId)) return "target_other_bot";
    const art = (await db.execute({ sql: "SELECT created_by_bot FROM artifacts WHERE id=? AND deleted_at IS NULL AND received=0", args: [String(artifactId)] })).rows[0];
    if (!art) return "target_unlinked";
    if (art.created_by_bot !== String(botId)) {
      const g = (await db.execute({ sql: "SELECT 1 FROM artifact_bot_access WHERE artifact_id=? AND bot_id=?", args: [String(artifactId), String(botId)] })).rows[0];
      if (!g) return "target_no_access";
    }
    const own = (await db.execute({ sql: "SELECT bot_id FROM bot_sessions WHERE gateway_thread_id=? ORDER BY id DESC LIMIT 1", args: [String(threadId)] })).rows[0];
    if (!own || String(own.bot_id) !== String(botId)) return "target_not_bots_chat";
    if (!botHasArtifactsTools(botDef)) return "bot_lacks_artifacts";
    // A LOCKED chat never takes a trusted round (D23): never offered by the
    // sheet, never picked by the Library, refused by the Send route.
    if (await isLocked(db, botId, threadId)) return "target_locked";
    return null;
  } catch { return "target_unlinked"; }
}

/** The Library's Send (no chat in hand, round-2 B7): the most recent ACTIVE
 *  link that verifies, else null — the owner then chooses (new chat / board
 *  card). Never "whichever chat of the bot happens to be live". `botId`
 *  (P6 mention round) considers only that bot's links. */
export async function pickSendTarget(db, { artifactId, loadBotDef, botId = null }) {
  for (const l of await linkedThreads(db, artifactId)) {
    if (botId != null && l.botId !== String(botId)) continue;   // P6 mention: only that bot's chats
    if (!(await verifyTarget(db, { artifactId, botId: l.botId, threadId: l.threadId, botDef: await loadBotDef(l.botId) }))) return { threadId: l.threadId, botId: l.botId };
  }
  return null;
}
