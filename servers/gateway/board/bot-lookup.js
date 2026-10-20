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
