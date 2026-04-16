/**
 * Messages Panel — Unified Messaging Hub
 *
 * Three-panel layout: avatar strip (left) + chat area (center) + info sidebar (right).
 * Merges AI Chat and Peer Messages into one conversation list.
 * Absorbs Contacts panel functionality.
 *
 * Orchestrator: imports modular CSS, HTML, client JS, data queries, and POST handlers.
 *
 * Security: All user-visible text is escaped. No innerHTML with untrusted content.
 */

import { messagesCSS } from "./messages/css.js";
import { buildMessagesHTML } from "./messages/html.js";
import { messagesClientJS } from "./messages/client.js";
import { handlePostAction } from "./messages/api-handlers.js";
import { getUnifiedConversationList } from "./messages/data-queries.js";

export default {
  id: "messages",
  name: "Messages",
  icon: "messages",
  route: "/dashboard/messages",
  navOrder: 10,
  category: "core",
  preload: true,

  async handler(req, res, { db, lang, layout }) {
    // --- Handle POST actions ---
    if (req.method === "POST") {
      const result = await handlePostAction(req, res, { db });
      // If handlePostAction sent a response (redirect), stop here
      if (res.headersSent) return;
      // result === false means action was generate_invite (no redirect, re-render with result)
    }

    // --- Check AI provider (env config OR profiles) ---
    let aiConfigured = false;
    try {
      const { getProviderConfig, getAiProfiles } = await import("../../ai/provider.js");
      aiConfigured = !!getProviderConfig();
      if (!aiConfigured) {
        const profiles = await getAiProfiles(db);
        aiConfigured = profiles.length > 0;
      }
    } catch {}

    // --- Check storage availability ---
    let storageAvailable = false;
    try {
      const { isAvailable } = await import("../../../storage/s3-client.js");
      storageAvailable = await isAvailable();
    } catch {}

    // --- Get unified conversation list ---
    const { items, totalUnread } = await getUnifiedConversationList(db);

    // --- Build page ---
    const css = messagesCSS();
    const html = buildMessagesHTML({
      items,
      totalUnread,
      aiConfigured,
      storageAvailable,
      inviteResult: req._inviteResult || null,
      inviteError: req._inviteError || null,
      lang,
    });
    const js = messagesClientJS({ aiConfigured, storageAvailable, lang });

    const content = css + html + js;

    const { t } = await import("../shared/i18n.js");
    return layout({ title: t("messages.pageTitle", lang), content });
  },
};
