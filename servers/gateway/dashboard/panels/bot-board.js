/**
 * Bot Board Panel — thin orchestrator.
 *
 * Wires bot-board/* submodules. See panels/bot-board/ for the implementation.
 */

import { existsSync } from "node:fs";
import { escapeHtml, section } from "../shared/components.js";
import { t } from "../shared/i18n.js";
import { botBoardStyles } from "./bot-board/css.js";
import {
  gatherPeerBots, tableMissing, parseBotDef, TASKS_DB,
} from "./bot-board/data-queries.js";

/** Top-level, unarchived cards per project (board_id NULL = kanban cards). */
async function cardCountsFor(projectIds) {
  const out = new Map();
  const ids = [...new Set(projectIds.filter((n) => Number.isInteger(n)))];
  if (!ids.length) return out;
  let tdb;
  try {
    tdb = createDbClient(TASKS_DB);
    const { rows } = await tdb.execute({
      sql: `SELECT project_id, COUNT(*) AS n FROM tasks_items
            WHERE board_id IS NULL AND archived_at IS NULL AND parent_id IS NULL
              AND project_id IN (${ids.map(() => "?").join(",")})
            GROUP BY project_id`,
      args: ids,
    });
    for (const id of ids) out.set(id, 0);
    for (const r of rows || []) out.set(Number(r.project_id), Number(r.n));
  } catch { /* tasks.db absent: chips just carry no count */ }
  finally { if (tdb) { try { tdb.close(); } catch { /* already closed */ } } }
  return out;
}
import { clientJs } from "./bot-board/client.js";
import { handleBotBoardPost } from "./bot-board/api-handlers.js";
import {
  drawerMarkup, renderKanbanBoard, renderCustomTracker,
  botBoardState, botPickerHtml, boardCard, turnOnPanelHtml, turnOnUnassignedHtml,
  renderStandaloneCardView,
} from "./bot-board/html.js";
import { createDbClient } from "../../../db.js";
import { botRuntimeActive } from "./bot-runtime-flag.js";
import { CROW_VOICE_BOT_ID } from "../../../shared/voice-bot.js";

/**
 * The bot whose board holds a card, for a bare ?card=N (the Board tab's
 * Details link): the bot on the card's project (kanban/task-list first),
 * else the card's assigned bot, else null. Reads the instance-global
 * tasks.db only, and never creates it.
 */
async function botForCard(bots, cardId) {
  const id = Number(cardId);
  if (!Number.isInteger(id) || !existsSync(TASKS_DB)) return null;
  let tdb, row;
  try {
    tdb = createDbClient(TASKS_DB);
    row = (await tdb.execute({ sql: "SELECT project_id, assigned_bot FROM tasks_items WHERE id = ?", args: [id] })).rows[0];
  } catch { return null; }
  finally { if (tdb) { try { tdb.close(); } catch { /* already closed */ } } }
  if (!row) return null;
  if (row.project_id != null) {
    const pid = Number(row.project_id);
    const onProject = bots.filter((b) => b.projectId != null && Number(b.projectId) === pid);
    const match = onProject.find((b) => b.trackerType === "kanban" || b.trackerType === "task-list") || onProject[0];
    if (match) return match;
  }
  return row.assigned_bot ? bots.find((b) => b.botId === String(row.assigned_bot)) || null : null;
}

export default {
  id: "bot-board",
  name: "Bot Board",
  icon: "kanban",
  route: "/dashboard/bot-board",
  navOrder: 15,
  category: "tools",

  async handler(req, res, { db, layout, lang }) {
    const notAvail = await tableMissing(db);

    // ---- no-JS status-move POST handling ----
    if (req.method === "POST" && !notAvail) {
      await handleBotBoardPost(req, res, { db });
      if (res.headersSent) return;
    }

    if (notAvail) {
      return layout({
        title: "Bot Board",
        content: section("Bot Board",
          `<p>The Bot Builder tables (<code>pi_bot_defs</code> / <code>bot_sessions</code>) are not initialized on this instance.</p>` +
          `<p>Run <code>npm run init-db</code> on the host whose crow.db this gateway uses, then reload.</p>`),
      });
    }

    const q = req.query || {};

    // ---- Bot list from pi_bot_defs ----
    let botRows = [];
    try {
      botRows = (await db.execute({
        sql: "SELECT bot_id, display_name, definition, enabled, project_id FROM pi_bot_defs WHERE enabled=1 AND bot_id != ? ORDER BY bot_id",
        args: [CROW_VOICE_BOT_ID],
      })).rows || [];
    } catch { botRows = []; }

    const bots = botRows.map(parseBotDef);

    // ---- Backwards compat: ?project=N -> find bot, redirect ----
    if (q.project != null && q.project !== "" && (q.bot == null || q.bot === "")) {
      const projId = Number(q.project);
      // Prefer kanban-type bots for this project
      const match = bots.find((b) => Number(b.projectId) === projId && (b.trackerType === "kanban" || b.trackerType === "task-list"))
        || bots.find((b) => Number(b.projectId) === projId);
      if (match) {
        return res.redirect(302, `/dashboard/bot-board?bot=${encodeURIComponent(match.botId)}`);
      }
      // No matching bot — fall through to show error below
    }

    // ---- Resolve selected bot ----
    const reqBot = q.bot != null && q.bot !== "" ? String(q.bot) : null;
    let selBot = null;
    if (reqBot != null) {
      selBot = bots.find((b) => b.botId === reqBot) || null;
    }
    // A bare ?card=N opens the card on the board that holds it.
    // When no kanban board can show it (no bot resolves, or the bot's board
    // isn't a card board), the card view is rendered on its own so the
    // card's full detail is always reachable.
    if (!selBot && reqBot == null && q.card != null && q.card !== "") {
      selBot = await botForCard(bots, q.card);
      const kanban = selBot && (selBot.trackerType === "kanban" || selBot.trackerType === "task-list") && selBot.projectId != null;
      if (!kanban) return renderStandaloneCardView({ db, layout, cardId: q.card, botId: selBot ? selBot.botId : null, lang });
    }
    if (!selBot && bots.length > 0 && reqBot == null) {
      selBot = bots[0]; // default to first enabled bot
    }

    // Error/notice messages
    const noticeBits = [];
    if (q.err === "locked") noticeBits.push(`<p class="bb-msg err">${t("botboard.errLocked", lang)}</p>`);
    else if (q.err === "bad_move") noticeBits.push(`<p class="bb-msg err">${t("botboard.errBadMove", lang)}</p>`);
    else if (q.err === "move_failed") noticeBits.push(`<p class="bb-msg err">${t("botboard.errMoveFailed", lang)}</p>`);
    // A failed Turn on (bot-builder board_on, return=board) comes back with
    // its message; free text, so always escaped.
    if (typeof q.error === "string" && q.error) noticeBits.push(`<p class="bb-msg err">${escapeHtml(q.error.slice(0, 500))}</p>`);
    if (reqBot != null && !selBot) {
      noticeBits.push(`<p class="bb-msg err">⚠️ Bot <code>${escapeHtml(reqBot)}</code> ${t("botboard.botNotFound", lang)}</p>`);
    }
    if (!(await botRuntimeActive(db))) {
      noticeBits.unshift(`<p class="bb-msg">${t("botboard.runtimeNotActive", lang)}</p>`);
    }
    const notice = noticeBits.join("");

    // ---- Bot picker: a name button opening a sheet (option B, queue item 20) ----
    // Card counts for the board-on bots: top-level, unarchived cards on each
    // bot's project, from the instance-global tasks.db only.
    const counts = await cardCountsFor(bots.filter((b) => botBoardState(b).state === "on").map((b) => Number(b.projectId)));
    const picker = bots.length
      ? botPickerHtml(bots, selBot, counts, req, lang)
      : `<p class="bb-msg">${t("botboard.noBotsOption", lang)}</p>`;

    const isKanban = selBot && (selBot.trackerType === "kanban" || selBot.trackerType === "task-list");
    const isCustom = selBot && selBot.trackerType === "custom";
    const switcherButtons = isKanban
      ? `<button type="button" class="bb-btn bb-sec" id="bb-new-proj-btn">+ New project</button>` +
        `<button type="button" class="bb-btn bb-sec" id="bb-new-card-btn">+ New card</button>` +
        `<button type="button" class="bb-btn bb-sec" id="bb-bulk-btn">+ Add unlinked cards</button>`
      : isCustom
        ? `<button type="button" class="bb-btn bb-sec" id="bb-new-tracker-item-btn">+ New item</button>`
        : "";

    const editBotLink = selBot
      ? `<a href="/dashboard/bot-builder?bot=${encodeURIComponent(selBot.botId)}&tab=tracker" ` +
        `style="font-size:.78rem;color:var(--crow-text-muted);text-decoration:none;margin-left:.3rem" ` +
        `title="Edit bot definition">${t("botboard.editBotLink", lang)}</a>`
      : "";

    // Mirrors Perch's own "Board" link back to here (perch-hub/html.js's
    // <nav class="machines">) — unconditional, like that one, so the board
    // is reachable from Perch and vice versa regardless of which bot (if
    // any) is selected.
    const perchLink =
      `<a href="/dashboard/perch" ` +
      `style="font-size:.78rem;color:var(--crow-text-muted);text-decoration:none;margin-left:.3rem">` +
      `${t("botboard.perchLink", lang)}</a>`;

    // The board's own actions and links (the old switcher form minus its
    // <select>): every action stays where it was.
    const switcher = picker +
      `<div class="bb-switch">` + editBotLink + perchLink + switcherButtons + `</div>`;

    // ---- No bot selected ----
    if (!selBot) {
      const peerBots = await gatherPeerBots(db);
      const peerStatus = q.peer != null && q.peer !== ""
        ? `<p class="bb-msg ${q.peer === "ok" ? "ok" : "err"}">${q.peer === "ok"
            ? t("botboard.peerBotUpdated", lang)
            : t("botboard.peerBotUpdateFailed", lang) + escapeHtml(String(q.peer))}</p>`
        : "";
      const peerBotsHtml = peerBots.length === 0 ? "" :
        section(t("botboard.peerBotsSection", lang),
          peerStatus +
          `<div class="table-scroll"><table class="bb-list-table"><thead><tr><th>${t("botboard.colBot", lang)}</th><th>${t("botboard.colInstance", lang)}</th><th>${t("botboard.colModel", lang)}</th><th>${t("botboard.colStatus", lang)}</th><th></th></tr></thead><tbody>` +
          peerBots.map((b) =>
            `<tr><td>${escapeHtml(b.display_name || b.bot_id)}</td>` +
            `<td>${escapeHtml(b.instanceName)}</td>` +
            `<td>${escapeHtml(b.model || "—")}</td>` +
            `<td>${b.enabled ? t("botboard.botEnabled", lang) : t("botboard.botDisabled", lang)}</td>` +
            `<td>${b.peer_manageable
              ? `<form method="POST" action="/dashboard/bot-board" style="display:inline">` +
                `<input type="hidden" name="action" value="peer_toggle">` +
                `<input type="hidden" name="instance_id" value="${escapeHtml(String(b.instanceId || ""))}">` +
                `<input type="hidden" name="bot_id" value="${escapeHtml(String(b.bot_id || ""))}">` +
                `<input type="hidden" name="enabled" value="${b.enabled ? 0 : 1}">` +
                `<button type="submit" class="bb-btn bb-sec" style="margin:0;font-size:.72rem;padding:.2rem .6rem">${b.enabled ? t("botboard.btnDisable", lang) : t("botboard.btnEnable", lang)}</button>` +
                `</form>` +
                ` <a class="bb-btn bb-sec" style="margin:0;font-size:.72rem;padding:.2rem .6rem" href="/dashboard/bot-builder?peer=${encodeURIComponent(b.instanceId)}&bot=${encodeURIComponent(b.bot_id)}">${t("botboard.btnEdit", lang)}</a>`
              : `<span style="font-size:.72rem;color:var(--crow-text-muted)">${t("botboard.peerReadOnly", lang)}</span>`}</td></tr>`
          ).join("") +
          `</tbody></table></div><p class="bb-msg">${t("botboard.peerBotsHelp", lang)}</p>`);
      return layout({
        title: "Bot Board",
        content: botBoardStyles() + section(t("botboard.notInitTitle", lang),
          notice + switcher +
          `<p style="margin-top:1rem;color:var(--crow-text-muted)">${t("botboard.noBots", lang)}</p>`) +
          peerBotsHtml +
          drawerMarkup(lang) + clientJs(null, "none", null, null, null, lang),
      });
    }

    // ---- Dispatch by tracker type ----
    const trackerType = selBot.trackerType;

    if (trackerType === "none") {
      return layout({
        title: "Bot Board",
        content: botBoardStyles() + boardCard(selBot, notice + switcher + turnOnPanelHtml(selBot, req, lang) +
          await turnOnUnassignedHtml(bots, req, lang)),
      });
    }

    if (trackerType === "custom") {
      // ---- Custom tracker rendering ----
      return await renderCustomTracker(req, res, { db, layout, selBot, bots, notice, switcher, q, lang });
    }

    // ---- Kanban / task-list rendering (default) ----
    return await renderKanbanBoard(req, res, { db, layout, selBot, bots, notice, switcher, q, lang });
  },
};
