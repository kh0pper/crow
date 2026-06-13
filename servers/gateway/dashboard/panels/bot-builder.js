/**
 * Bot Builder Panel — thin orchestrator.
 *
 * Wires together panels/bot-builder/ submodules: css, data-queries, peer-edit,
 * api-handlers, editor, html. Same manifest shape as the monolithic original.
 */
import { botBuilderStyles } from "./bot-builder/css.js";
import { tableMissing } from "./bot-builder/data-queries.js";
import { escapeHtml, section } from "../shared/components.js";
import { botRuntimeActive } from "./bot-runtime-flag.js";
import { handlePeerEdit } from "./bot-builder/peer-edit.js";
import { handleBotBuilderPost } from "./bot-builder/api-handlers.js";
import { renderBotEditor } from "./bot-builder/editor.js";
import { renderBotList } from "./bot-builder/html.js";

const PAGE_CSS = botBuilderStyles();

export default {
  id: "bot-builder",
  name: "Bot Builder",
  icon: "extensions",
  route: "/dashboard/bot-builder",
  navOrder: 14,
  category: "tools",

  async handler(req, res, { db, layout, lang }) {
    const notAvail = await tableMissing(db);

    // ---- F4a L3: remote edit of a TRUSTED PEER's bot (?peer=<instanceId>&bot=<botId>) ----
    // Runs BEFORE the notAvail gate (peer-edit works even when pi_bot_defs is missing here).
    if (await handlePeerEdit(req, res, { db, layout })) return;

    // ---- POST ----
    if (req.method === "POST" && !notAvail) {
      await handleBotBuilderPost(req, res, { db });
      if (res.headersSent) return;
    }

    if (notAvail) {
      return res.send(layout({
        title: "Bot Builder",
        content: section("Bot Builder",
          `<p>The Bot Builder tables are not initialized on this instance.</p>` +
          `<p>Run <code>npm run init-db</code> on the host whose crow.db this gateway uses, then reload.</p>`),
      }));
    }

    const runtimeActive = await botRuntimeActive(db);
    const runtimeBanner = runtimeActive ? "" :
      `<p class="btb-notice-warn">Bot definitions are stored on this instance. ` +
      `The bot runtime (Gmail/Telegram/Discord gateways) is enabled per-instance and is not active here yet.</p>`;

    const q = req.query || {};
    const baseNotice = q.saved ? `<p class="btb-notice-ok">Saved.</p>`
      : q.created ? `<p class="btb-notice-ok">Created <code>${escapeHtml(String(q.created))}</code>.</p>`
      : q.error ? `<p class="btb-notice-err">${escapeHtml(String(q.error))}</p>` : "";
    // Soft, non-blocking warning (e.g. AI-tab model pair not in models.json).
    // Independent of the base notice so it can ride alongside a Saved.
    const warnNotice = q.warn ? `<p class="btb-notice-warn">${escapeHtml(String(q.warn))}</p>` : "";
    const notice = runtimeBanner + baseNotice + warnNotice;

    // ---- editor for one bot (C5: delegated to editor.js) ----
    if (q.bot) {
      return renderBotEditor(req, res, { db, layout, lang, PAGE_CSS, botId: String(q.bot), notice, q });
    }

    // ---- list + create + run monitor (C6: delegated to html.js) ----
    return renderBotList(res, { db, layout, notice, PAGE_CSS, req });
  },
};
