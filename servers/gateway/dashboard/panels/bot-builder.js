/**
 * Bot Builder Panel — thin orchestrator.
 *
 * Wires together panels/bot-builder/ submodules: css, data-queries, peer-edit,
 * api-handlers, editor, html. Same manifest shape as the monolithic original.
 */
import { botBuilderStyles } from "./bot-builder/css.js";
import { tableMissing } from "./bot-builder/data-queries.js";
import { escapeHtml, section } from "../shared/components.js";
import { t } from "../shared/i18n.js";
import { botRuntimeActive } from "./bot-runtime-flag.js";
import { handlePeerEdit } from "./bot-builder/peer-edit.js";
import { handleBotBuilderPost } from "./bot-builder/api-handlers.js";
import { renderBotEditor } from "./bot-builder/editor.js";
import { renderBotList } from "./bot-builder/html.js";
import { renderWizard } from "./bot-builder/wizard.js";
import { renderDeleteConfirm } from "./bot-builder/delete-bot.js";
import { perchGateClientJS } from "./perch.js";

const PAGE_CSS = botBuilderStyles();

// C4 Task 8: q.error="engine_required" / q.warn="bot_runtime_off" are the
// ONLY two values these params ever carry from api-handlers.js's Task 7
// gate (the gateways-tab save redirect) — every other error/warn value
// keeps rendering raw (baseNotice/warnNotice below), unchanged from before
// this task. Both banners carry a button engine-gate-client.js wires up
// (the script ships on every editor tab; see editor.js).
function engineRequiredBanner(lang) {
  return `<p class="btb-notice-err">${escapeHtml(t("botbuilder.engineGateBannerErrorBody", lang))} ` +
    `<button type="button" id="engine-gate-open-btn" class="btb-btn btb-btn-sm btb-btn-inline">` +
    `${escapeHtml(t("botbuilder.engineGateInstallBtn", lang))}</button></p>`;
}
function botRuntimeOffBanner(lang) {
  return `<p class="btb-notice-warn">${escapeHtml(t("botbuilder.runtimeOffBannerBody", lang))} ` +
    `<button type="button" id="bot-runtime-enable-btn" class="btb-btn btb-btn-sm btb-btn-inline">` +
    `${escapeHtml(t("botbuilder.runtimeOffEnableBtn", lang))}</button> ` +
    `<span id="bot-runtime-enable-status" class="btb-hint"></span></p>`;
}

// Perch Hub P1, acceptance finding D2 — `warn=perch_not_installed`. The save
// succeeded; what's missing is the surface the replies would appear on, which
// is the perch-hub bundle itself. Same banner+button shape as the runtime-off
// warning above, and the button is driven by the Perch panel's OWN install-job
// client (`perchGateClientJS`) rather than a second copy of it — one
// implementation of "install perch-hub", used from both places it is offered.
function perchNotInstalledBanner(lang) {
  return `<p class="btb-notice-warn">${escapeHtml(t("botbuilder.perchMissingBody", lang))} ` +
    `<button type="button" id="perch-install-btn" class="btb-btn btb-btn-sm btb-btn-inline">` +
    `${escapeHtml(t("perch.gateInstallBtn", lang))}</button> ` +
    `<span id="perch-install-status" class="btb-hint"></span></p>` +
    perchGateClientJS(lang);
}

/**
 * `?warn=` as a LIST. One save can raise two independent warnings (an engine
 * channel on a disarmed runtime that is ALSO a perch attach with no bundle),
 * and api-handlers appends each as its own `&warn=` — which express's query
 * parser hands back as an array. Rendering `String(q.warn)` on that array
 * would print `bot_runtime_off,perch_not_installed` as raw text and drop both
 * banners. Single-value `?warn=` is unchanged, and free-form warn strings are
 * NOT split on anything (several of them legitimately contain commas).
 */
function warnValues(raw) {
  if (raw == null) return [];
  return (Array.isArray(raw) ? raw : [raw]).map(String).filter(Boolean);
}

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
    // ?created= renders as the review tab's callout (editor.js), not here —
    // both messages stacked read as a double banner (PR #191 review m2).
    const baseNotice = q.saved ? `<p class="btb-notice-ok">Saved.</p>`
      : q.deleted ? `<p class="btb-notice-ok">Deleted <code>${escapeHtml(String(q.deleted))}</code>.</p>`
      : q.error === "engine_required" ? engineRequiredBanner(lang)
      : q.error ? `<p class="btb-notice-err">${escapeHtml(String(q.error))}</p>` : "";
    // Soft, non-blocking warning (e.g. AI-tab model pair not in models.json).
    // Independent of the base notice so it can ride alongside a Saved.
    const warnNotice = warnValues(q.warn).map((w) =>
      w === "bot_runtime_off" ? botRuntimeOffBanner(lang)
        : w === "perch_not_installed" ? perchNotInstalledBanner(lang)
          : `<p class="btb-notice-warn">${escapeHtml(w)}</p>`).join("");
    const notice = runtimeBanner + baseNotice + warnNotice;

    // ---- guided-creation wizard (Item 5 PR1, spec §D1) ----
    // GET ?new=1 renders step 0 fresh. POST action="wizard_step" renders the
    // target step HERE (the POST path needs layout/lang, which api-handlers
    // doesn't receive — spec round-2 MINOR-4); the review step's
    // action="wizard_create" with nav="back" deliberately falls through
    // handleBotBuilderPost without sending, and re-renders here too.
    const bodyAction = req.method === "POST" ? String((req.body || {}).action || "") : "";
    if (bodyAction === "wizard_step" || bodyAction === "wizard_create" || (req.method !== "POST" && q.new)) {
      return renderWizard(req, res, { db, layout, lang, PAGE_CSS, notice });
    }

    // ---- delete confirmation page (Item 5 PR2, spec §D5) — plain GET ----
    if (q.bot && q.confirm_delete) {
      let row = null;
      try {
        row = (await db.execute({ sql: "SELECT bot_id, display_name, definition FROM pi_bot_defs WHERE bot_id=?", args: [String(q.bot)] })).rows[0] || null;
      } catch { row = null; }
      if (!row) return res.redirectAfterPost("/dashboard/bot-builder?error=unknown_bot");
      return renderDeleteConfirm(req, res, { db, layout, lang, PAGE_CSS, bot: row });
    }

    // ---- editor for one bot (C5: delegated to editor.js) ----
    if (q.bot) {
      return renderBotEditor(req, res, { db, layout, lang, PAGE_CSS, botId: String(q.bot), notice, q });
    }

    // ---- list + create + run monitor (C6: delegated to html.js) ----
    return renderBotList(res, { db, layout, notice, PAGE_CSS, req });
  },
};
