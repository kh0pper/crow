/**
 * Bot lookup — "may this bot be given a card?" in one place.
 *
 * A bot qualifies when it has an ENABLED `pi_bot_defs` row (crow.db) and is
 * not the reserved voice bot, which never takes cards. The card-edit route
 * used to make this check inline; decision follow-up cards need the same
 * rule, so it lives here and both read it.
 *
 * Never throws: a missing table or a transient read error reads as "not
 * enabled", so a caller falls back to leaving the card unassigned.
 */

import { isVoiceBotId } from "../../shared/voice-bot.js";

/** @param cdb crow.db client (createDbClient()) */
export async function isEnabledBot(cdb, botId) {
  if (typeof botId !== "string" || !botId) return false;
  if (isVoiceBotId(botId)) return false;
  try {
    const row = (await cdb.execute({
      sql: "SELECT bot_id FROM pi_bot_defs WHERE bot_id=? AND enabled=1",
      args: [botId],
    })).rows[0];
    return !!row;
  } catch {
    return false;
  }
}

/**
 * The one assignment guard every card path calls before a bot is written onto
 * a card: the voice bot and any missing or disabled bot are refused with the
 * `{code, http}` shape the routes and the board MCP already map. Reads
 * crow.db only (never tasks.db).
 */
export async function assertAssignableBot(cdb, botId) {
  if (await isEnabledBot(cdb, botId)) return;
  const what = isVoiceBotId(botId) ? "the voice bot never takes cards" : `assigned_bot is not an enabled bot: ${botId}`;
  throw Object.assign(new Error(what), { code: "bad_bot", http: 400 });
}
