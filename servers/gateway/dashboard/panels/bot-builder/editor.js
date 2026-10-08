/**
 * Bot Builder Panel — Editor
 *
 * Renders the single-bot editor (?bot=<id>&tab=<tab>): four tabs (Basics,
 * Abilities, Safety, Activity) plus an Advanced view. The editor is a
 * projection of the stored definition — see def-adapter.js for the
 * preserve-unless-changed rule every save follows.
 *
 * Every editor form carries def_rev (a hash of the stored definition text
 * at render): a save from a page that went stale — a skill approved
 * meanwhile, a peer edit, another tab — is refused instead of overwriting.
 */
import { escapeHtml, section, badge } from "../../shared/components.js";
import { csrfInput } from "../../shared/csrf.js";
import { t } from "../../shared/i18n.js";
import { engineGateClientJS } from "./engine-gate-client.js";
import { rowRev } from "./def-adapter.js";
import { withFormSnapshots } from "./ui.js";
import { renderBasics } from "./tab-basics.js";
import { renderAbilities } from "./tab-abilities.js";
import { renderSafety } from "./tab-safety.js";
import { renderActivity } from "./tab-activity.js";
import { renderAdvanced } from "./tab-advanced.js";

export const EDITOR_TABS = ["basics", "abilities", "safety", "activity"];

// Old ?tab= values (bookmarks, bot-board links, an old open page's redirect)
// land on the tab that now holds those settings.
export const LEGACY_TAB_ALIASES = {
  ai: "basics", gateways: "basics", triggers: "basics",
  tools: "abilities", skills: "abilities",
  permissions: "safety",
  sessions: "activity", review: "activity",
  tracker: "advanced",
};

export function resolveTab(raw) {
  const v = String(raw || "basics");
  if (EDITOR_TABS.includes(v) || v === "advanced") return { tab: v, open: null };
  if (LEGACY_TAB_ALIASES[v]) return { tab: LEGACY_TAB_ALIASES[v], open: v === "tracker" ? "board" : null };
  return { tab: "basics", open: null };
}

export async function renderBotEditor(req, res, { db, layout, lang, PAGE_CSS, botId, notice, q }) {
  let bot;
  try {
    bot = (await db.execute({ sql: "SELECT bot_id, display_name, enabled, definition, project_id FROM pi_bot_defs WHERE bot_id=?", args: [botId] })).rows[0];
  } catch { bot = null; }
  if (!bot) return res.send(layout({
    title: "Bot Builder",
    content: PAGE_CSS + section("Bot Builder",
      `<p>${t("botbuilder.noticeUnknownBot", lang)}</p><p><a href="/dashboard/bot-builder">&larr; ${t("botbuilder.noticeAllBots", lang)}</a></p>`),
  }));
  let def; try { def = JSON.parse(bot.definition || "{}"); } catch { def = {}; }
  // M3b: column is authoritative — overwrite any stale JSON copy of project_id.
  def.project_id = bot.project_id == null ? null : Number(bot.project_id);
  const { tab, open } = resolveTab(q.tab);
  const rev = rowRev(bot);

  const tabLabel = { basics: "botbuilder.tabBasics", abilities: "botbuilder.tabAbilities", safety: "botbuilder.tabSafety", activity: "botbuilder.tabActivity" };
  const href = (id) => `/dashboard/bot-builder?bot=${encodeURIComponent(botId)}&amp;tab=${id}`;
  const nav = `<nav aria-label="${escapeHtml(t("botbuilder.navLabel", lang))}"><div class="btb-tabs">` +
    EDITOR_TABS.map((id) =>
      `<a href="${href(id)}" class="btb-tab${id === tab ? " btb-tab-active" : ""}"${id === tab ? ` aria-current="page"` : ""}>${escapeHtml(t(tabLabel[id], lang))}</a>`).join("") +
    `<a href="${href("advanced")}" class="btb-tab btb-tab-adv${tab === "advanced" ? " btb-tab-active" : ""}"${tab === "advanced" ? ` aria-current="page"` : ""}>${escapeHtml(t("botbuilder.tabAdvanced", lang))} &#9656;</a>` +
    `</div></nav>`;

  const hidden = (tb) =>
    `<input type="hidden" name="action" value="save_${tb}"><input type="hidden" name="bot_id" value="${escapeHtml(botId)}">` +
    `<input type="hidden" name="def_rev" value="${rev}">${csrfInput(req)}`;
  const ctx = { req, db, bot, def, botId, lang, q: { ...q, open: q.open || open }, hidden };

  let body;
  if (tab === "basics") body = await renderBasics(ctx);
  else if (tab === "abilities") body = await renderAbilities(ctx);
  else if (tab === "safety") body = await renderSafety(ctx);
  else if (tab === "activity") body = await renderActivity(ctx);
  else body = await renderAdvanced(ctx);
  // Each save form learns what it would post untouched (ui.js form snapshots).
  body = await withFormSnapshots(body);

  return res.send(layout({
    title: "Bot Builder — " + botId, // renderLayout escapes the title itself
    // The engine-gate modal ships on every tab: the Basics form intercepts a
    // channel save, and the Activity checklist opens the same modal.
    content: PAGE_CSS + section(
      "",
      `<p><a href="/dashboard/bot-builder">&larr; ${t("botbuilder.noticeAllBots", lang)}</a></p>` + notice +
      nav + body + engineGateClientJS(lang),
      {
        titleHtml:
          `${escapeHtml(t("botbuilder.editBotTitle", lang))}: ${escapeHtml(bot.display_name || botId)} ` +
          (bot.enabled ? badge(t("botbuilder.badgeEnabled", lang), "connected") : badge(t("botbuilder.badgeDisabled", lang), "draft")),
      }
    ),
  }));
}
