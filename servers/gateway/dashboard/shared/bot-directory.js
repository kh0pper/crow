/**
 * Shared cross-instance bot directory render. Used by the Messages "+" picker
 * modal (context "messages") and the Contacts panel add-source (context
 * "contacts"). All user text escaped. Every POST form carries the CSRF token.
 *
 * Actions (handled in each panel's POST handler):
 *   dir_add_bot     — materialize the bot as a contact (is_bot=1), no message.
 *   dir_message_bot — materialize then redirect to the conversation (messages ctx only).
 */
import { escapeHtml } from "./components.js";
import { t } from "./i18n.js";

export function buildBotDirectory({ groups, context, csrf, lang }) {
  const csrfInput = csrf || "";
  const isMessages = context === "messages";

  if (!Array.isArray(groups) || groups.length === 0) {
    return `<div class="bot-dir-empty">${escapeHtml(t("botdir.empty", lang))}</div>`;
  }

  const groupHtml = groups.map((g) => {
    const rows = g.bots.map((b) => {
      const name = escapeHtml(b.displayName || b.botId);
      const tagline = b.description ? `<div class="bot-dir-tagline">${escapeHtml(b.description)}</div>` : "";
      let actions;
      if (b.added) {
        const href = b.contactId != null ? `/dashboard/messages?open=${encodeURIComponent(b.contactId)}` : "/dashboard/messages";
        actions = `<a class="bot-dir-added" href="${href}" data-contact-id="${escapeHtml(String(b.contactId ?? ""))}">${escapeHtml(t("botdir.added", lang))}</a>`;
      } else {
        const addForm =
          `<form method="POST" style="display:inline">` +
          `<input type="hidden" name="action" value="dir_add_bot">` +
          `<input type="hidden" name="invite_code" value="${escapeHtml(b.inviteCode)}">` +
          `${csrfInput}` +
          `<button type="submit" class="bot-dir-btn">${escapeHtml(t("botdir.add", lang))}</button></form>`;
        const msgForm = isMessages
          ? `<form method="POST" style="display:inline">` +
            `<input type="hidden" name="action" value="dir_message_bot">` +
            `<input type="hidden" name="invite_code" value="${escapeHtml(b.inviteCode)}">` +
            `${csrfInput}` +
            `<button type="submit" class="bot-dir-btn bot-dir-btn-primary">${escapeHtml(t("botdir.message", lang))}</button></form>`
          : "";
        actions = addForm + msgForm;
      }
      const haystack = escapeHtml(((b.displayName || "") + " " + (b.description || "")).toLowerCase());
      return `<div class="bot-dir-row" data-bot-search="${haystack}">` +
        `<div class="bot-dir-row-main"><strong>${name}</strong>${tagline}</div>` +
        `<div class="bot-dir-row-actions">${actions}</div></div>`;
    }).join("");
    const label = escapeHtml(g.instanceLabel || t("botdir.anotherCrow", lang));
    return `<div class="bot-dir-group"><div class="bot-dir-group-head">${label}</div>${rows}</div>`;
  }).join("");

  return `<div class="bot-dir">` +
    `<input type="text" data-bot-directory-search class="bot-dir-search" placeholder="${escapeHtml(t("botdir.searchPlaceholder", lang))}">` +
    groupHtml + `</div>`;
}
