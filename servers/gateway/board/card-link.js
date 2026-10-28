// servers/gateway/board/card-link.js — the one "open this card" link (P6).
//
// A card's drawer (plan, results, history, decision) opens through the classic
// board client's one-shot `#open=<id>` key (openCardById), on the board of a
// card-board bot: the card-board bot on the card's own project
// (cardBoardBotForProject over enabledBoardBots, panels/bot-board/
// data-queries.js). Every "open this card" link uses this module: the Board
// tab's Details/tap links (drawerHrefs, batched), the Perch chat card chip
// (GET /interactive/:sid/card's href) and Make's card links. With no such bot,
// the standalone no-JS card view, `?card=<id>`. Never another project's board
// (Ruling Q14): the classic drawer builds its status select from the page bot's
// board def, so a card opened there would show statuses that aren't its own.

import { existsSync } from "node:fs";
import { createDbClient } from "../../db.js";
import { tasksDbPath } from "../../../scripts/pi-bots/instance-paths.mjs";
import { CROW_VOICE_BOT_ID } from "../../shared/voice-bot.js";
import { enabledBoardBots, cardBoardBotForProject } from "../dashboard/panels/bot-board/data-queries.js";

const CARD_ID = /^[1-9]\d*$/;
const ID_CHUNK = 500; // under SQLite's bound-parameter limit

/**
 * The one URL shape: the card's drawer on `bot`'s board (`?bot=<bot>#open=<id>`), or with no
 * bot the standalone no-JS card view (`?card=<id>`). Pure; null for an id that isn't a card id.
 * Which bot is the caller's to choose by Ruling Q14 (drawerHrefs / cardDrawerHref do).
 */
export function drawerHref(cardId, bot) {
  if (!CARD_ID.test(String(cardId))) return null;
  const id = Number(cardId);
  return bot != null && String(bot) !== ""
    ? `/dashboard/bot-board?bot=${encodeURIComponent(String(bot))}#open=${id}`
    : `/dashboard/bot-board?card=${id}`;
}

/** [{ id, projectId }] for the top-level cards among `ids`, in one read per chunk; [] without a tasks.db. */
async function cardRows(ids, tasksDb) {
  if (!ids.length || (!tasksDb && !existsSync(tasksDbPath()))) return [];
  let tdb = tasksDb;
  const out = [];
  try {
    tdb ||= createDbClient(tasksDbPath());
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const part = ids.slice(i, i + ID_CHUNK);
      const rows = (await tdb.execute({
        sql: `SELECT project_id, id FROM tasks_items WHERE board_id IS NULL AND id IN (${part.map(() => "?").join(",")})`,
        args: part,
      })).rows || [];
      for (const r of rows) out.push({ id: Number(r.id), projectId: r.project_id == null ? null : Number(r.project_id) });
    }
    return out;
  } catch {
    return [];
  } finally {
    if (!tasksDb) { try { tdb && tdb.close(); } catch { /* already closed */ } }
  }
}

/**
 * "Open this card" for many cards at once: Map<cardId, href>, with one bots lookup (none when no
 * card is on a project). Each card is either a row the caller already read, `{ id, project_id }`
 * (or `projectId`), trusted as a top-level card, or a bare id, read from the instance-global
 * tasks.db (`opts.tasksDb` hands in an open client); an id that is no top-level card gets no entry.
 * The rule (Ruling Q14): the card's own project's enabled card-board bot, else `?card=`.
 */
export async function drawerHrefs(db, cards, { tasksDb = null } = {}) {
  const known = [];
  const lookup = [];
  for (const c of cards || []) {
    if (c && typeof c === "object") {
      if (!CARD_ID.test(String(c.id))) continue;
      const p = c.project_id !== undefined ? c.project_id : c.projectId;
      known.push({ id: Number(c.id), projectId: p == null ? null : Number(p) });
    } else if (CARD_ID.test(String(c))) {
      lookup.push(Number(c));
    }
  }
  if (lookup.length) known.push(...await cardRows([...new Set(lookup)], tasksDb));
  const bots = known.some((k) => k.projectId != null) ? await enabledBoardBots(db, CROW_VOICE_BOT_ID) : [];
  const out = new Map();
  for (const k of known) {
    const bot = cardBoardBotForProject(bots, k.projectId);
    out.set(k.id, drawerHref(k.id, bot ? bot.botId : null));
  }
  return out;
}

/**
 * Where "open this card" goes, or null for a card that isn't there.
 * @param db crow.db client (pi_bot_defs). The card is read from the instance-global
 *   tasks.db; `opts.tasksDb` hands in an open client instead.
 * @param cardId a positive integer (number or digit string)
 * @returns {Promise<string|null>} `/dashboard/bot-board?bot=<bot>#open=<id>` or `/dashboard/bot-board?card=<id>`
 */
export async function cardDrawerHref(db, cardId, { tasksDb = null } = {}) {
  if (!CARD_ID.test(String(cardId))) return null;
  return (await drawerHrefs(db, [Number(cardId)], { tasksDb })).get(Number(cardId)) ?? null;
}
