/**
 * Bot Board Panel — thin orchestrator.
 *
 * Wires bot-board/* submodules. See panels/bot-board/ for the implementation.
 */

import { escapeHtml, section } from "../shared/components.js";
import { botBoardStyles } from "./bot-board/css.js";
import {
  gatherPeerBots, tableMissing, parseBotDef,
  CARD_STATUSES, STATUS_LABEL,
} from "./bot-board/data-queries.js";
import { clientJs } from "./bot-board/client.js";
import { handleBotBoardPost } from "./bot-board/api-handlers.js";
import { drawerMarkup, renderKanbanBoard, renderCustomTracker } from "./bot-board/html.js";
import { botRuntimeActive } from "./bot-runtime-flag.js";

export default {
  id: "bot-board",
  name: "Bot Board",
  icon: "project",
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
        sql: "SELECT bot_id, display_name, definition, enabled, project_id FROM pi_bot_defs WHERE enabled=1 ORDER BY bot_id",
        args: [],
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
    if (!selBot && bots.length > 0 && reqBot == null) {
      selBot = bots[0]; // default to first enabled bot
    }

    // Error/notice messages
    const noticeBits = [];
    if (q.err === "locked") noticeBits.push(`<p class="bb-msg err">⚠️ That item is being worked by a bot — read-only.</p>`);
    else if (q.err === "bad_move") noticeBits.push(`<p class="bb-msg err">⚠️ Invalid status move.</p>`);
    else if (q.err === "move_failed") noticeBits.push(`<p class="bb-msg err">⚠️ Move failed.</p>`);
    if (reqBot != null && !selBot) {
      noticeBits.push(`<p class="bb-msg err">⚠️ Bot <code>${escapeHtml(reqBot)}</code> not found or disabled.</p>`);
    }
    if (!(await botRuntimeActive(db))) {
      noticeBits.unshift(`<p class="bb-msg">Bot runtime is not active on this instance — board reflects definitions only.</p>`);
    }
    const notice = noticeBits.join("");

    // ---- Bot switcher (GET form) ----
    const switcherOptions = bots.length
      ? bots.map((b) => {
          const typeLabel = b.trackerType === "custom" && b.trackerSlug
            ? `custom: ${escapeHtml(b.trackerSlug)}`
            : escapeHtml(b.trackerType);
          const selected = selBot && b.botId === selBot.botId ? " selected" : "";
          return `<option value="${escapeHtml(b.botId)}"${selected}>${escapeHtml(b.displayName)} (${typeLabel})</option>`;
        }).join("")
      : `<option value="">-- no bots --</option>`;

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
        `title="Edit bot definition">Edit bot</a>`
      : "";

    const switcher =
      `<form method="GET" action="/dashboard/bot-board" class="bb-switch">` +
      `<label for="bb-bot" style="font-size:.8rem;color:var(--crow-text-muted)">Bot</label>` +
      `<select id="bb-bot" name="bot" onchange="this.form.submit()">` +
      switcherOptions +
      `</select>` + editBotLink +
      `<noscript><button type="submit">Go</button></noscript>` +
      switcherButtons +
      `</form>`;

    // ---- No bot selected ----
    if (!selBot) {
      const peerBots = await gatherPeerBots(db);
      const peerStatus = q.peer != null && q.peer !== ""
        ? `<p class="bb-msg ${q.peer === "ok" ? "ok" : "err"}">${q.peer === "ok"
            ? "✅ Peer bot updated."
            : "⚠️ Peer bot update failed: " + escapeHtml(String(q.peer))}</p>`
        : "";
      const peerBotsHtml = peerBots.length === 0 ? "" :
        section("Bots on other instances",
          peerStatus +
          `<table class="bb-list-table"><thead><tr><th>Bot</th><th>Instance</th><th>Model</th><th>Status</th><th></th></tr></thead><tbody>` +
          peerBots.map((b) =>
            `<tr><td>${escapeHtml(b.display_name || b.bot_id)}</td>` +
            `<td>${escapeHtml(b.instanceName)}</td>` +
            `<td>${escapeHtml(b.model || "—")}</td>` +
            `<td>${b.enabled ? "enabled" : "disabled"}</td>` +
            `<td>${b.peer_manageable
              ? `<form method="POST" action="/dashboard/bot-board" style="display:inline">` +
                `<input type="hidden" name="action" value="peer_toggle">` +
                `<input type="hidden" name="instance_id" value="${escapeHtml(String(b.instanceId || ""))}">` +
                `<input type="hidden" name="bot_id" value="${escapeHtml(String(b.bot_id || ""))}">` +
                `<input type="hidden" name="enabled" value="${b.enabled ? 0 : 1}">` +
                `<button type="submit" class="bb-btn bb-sec" style="margin:0;font-size:.72rem;padding:.2rem .6rem">${b.enabled ? "Disable" : "Enable"}</button>` +
                `</form>` +
                ` <a class="bb-btn bb-sec" style="margin:0;font-size:.72rem;padding:.2rem .6rem" href="/dashboard/bot-builder?peer=${encodeURIComponent(b.instanceId)}&bot=${encodeURIComponent(b.bot_id)}">Edit</a>`
              : `<span style="font-size:.72rem;color:var(--crow-text-muted)">read-only — open on owner</span>`}</td></tr>`
          ).join("") +
          `</tbody></table><p class="bb-msg">Manageable bots can be enabled/disabled from here. Others are read-only — open that instance's dashboard to edit or run them.</p>`);
      return layout({
        title: "Bot Board",
        content: botBoardStyles() + section("Bot Board",
          notice + switcher +
          `<p style="margin-top:1rem;color:var(--crow-text-muted)">No enabled bots found. Create a bot in Bot Builder to start a board.</p>`) +
          peerBotsHtml +
          drawerMarkup(lang) + clientJs(null, "none", null, null, null, lang),
      });
    }

    // ---- Dispatch by tracker type ----
    const trackerType = selBot.trackerType;

    if (trackerType === "none") {
      return layout({
        title: `Bot Board — ${selBot.displayName}`,
        content: botBoardStyles() + section(
          `Board — ${escapeHtml(selBot.displayName)}`,
          notice + switcher +
          `<p style="margin-top:1rem;color:var(--crow-text-muted)">This bot has no tracker.</p>`),
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
