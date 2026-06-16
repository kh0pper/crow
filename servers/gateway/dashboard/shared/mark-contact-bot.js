/**
 * Mark a contact as a Crow Messages bot. Idempotent; never throws. Called by
 * every gateway materialize path (directory add/message, paste form, deep
 * link) right after a successful accept. A bot is always a bot, so this sets
 * the flag unconditionally on the matching crow_id.
 */
export async function markContactIsBot(db, crowId) {
  if (!crowId) return;
  try { await db.execute({ sql: "UPDATE contacts SET is_bot = 1 WHERE crow_id = ?", args: [crowId] }); } catch {}
}
