// servers/gateway/board/card-link.js — the one "open this card" link (P6).
//
// A card's drawer (plan, results, history, decision) opens through the classic
// board client's one-shot `#open=<id>` key (openCardById), on the board of a
// card-board bot. The bot is chosen by the same rule the Board tab's Details
// link uses (cardBoardBotForProject over enabledBoardBots, panels/bot-board/
// data-queries.js): the card-board bot on the card's project. With no such bot,
// the standalone no-JS card view, `?card=<id>`. Never another project's board
// (Ruling Q14): the classic drawer builds its status select from the page bot's
// board def, so a card opened there would show statuses that aren't its own.

import { existsSync } from "node:fs";
import { createDbClient } from "../../db.js";
import { tasksDbPath } from "../../../scripts/pi-bots/instance-paths.mjs";
import { CROW_VOICE_BOT_ID } from "../../shared/voice-bot.js";
import { enabledBoardBots, cardBoardBotForProject } from "../dashboard/panels/bot-board/data-queries.js";

/** The card's project as { projectId }, or null when there is no such top-level card (or no tasks.db). */
async function cardRow(id, tasksDb) {
  if (!tasksDb && !existsSync(tasksDbPath())) return null;
  let tdb = tasksDb;
  try {
    tdb ||= createDbClient(tasksDbPath());
    const r = (await tdb.execute({ sql: "SELECT project_id FROM tasks_items WHERE id = ? AND board_id IS NULL", args: [id] })).rows[0];
    return r ? { projectId: r.project_id == null ? null : Number(r.project_id) } : null;
  } catch {
    return null;
  } finally {
    if (!tasksDb) { try { tdb && tdb.close(); } catch { /* already closed */ } }
  }
}

/**
 * Where "open this card" goes, or null for a card that isn't there.
 * @param db crow.db client (pi_bot_defs). The card is read from the instance-global
 *   tasks.db; `opts.tasksDb` hands in an open client instead.
 * @param cardId a positive integer (number or digit string)
 * @returns {Promise<string|null>} `/dashboard/bot-board?bot=<bot>#open=<id>` or `/dashboard/bot-board?card=<id>`
 */
export async function cardDrawerHref(db, cardId, { tasksDb = null } = {}) {
  if (!/^[1-9]\d*$/.test(String(cardId))) return null;
  const id = Number(cardId);
  const card = await cardRow(id, tasksDb);
  if (!card) return null;
  const bots = await enabledBoardBots(db, CROW_VOICE_BOT_ID);
  const bot = cardBoardBotForProject(bots, card.projectId);
  return bot
    ? `/dashboard/bot-board?bot=${encodeURIComponent(String(bot.botId))}#open=${id}`
    : `/dashboard/bot-board?card=${id}`;
}
