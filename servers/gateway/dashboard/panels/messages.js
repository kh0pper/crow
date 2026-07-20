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
import { getUnifiedConversationList, getBotDirectory, getMessageRequests } from "./messages/data-queries.js";
import { csrfInput } from "../shared/csrf.js";
import { buildInviteShare, parseShortCodeResult } from "../shared/peer-invite-ui.js";
import { extractInviteCode } from "../../../sharing/invite-url.js";

/**
 * True if the `providers` table — the modern provider registry, same table
 * the onboarding wizard's own gates read (countProviders/resolveStarterProvider
 * in panels/onboarding.js and panels/onboarding/starter-content.js) — has at
 * least one non-disabled row with a usable model. A row with an empty
 * `models` JSON array (e.g. a `no_auto_provider` placeholder) is not usable
 * for chat and must not count; this mirrors resolveStarterProvider's second
 * branch exactly, so a conversation that createStarterArtifacts() was able
 * to provision a provider for is always one this function also recognizes.
 *
 * CDP round (C1-B Task 9, finding #1): the wizard's local-download branch
 * registers a provider ONLY in this table (never touches `.env` AI_PROVIDER
 * or the `dashboard_settings.ai_profiles` blob), so before this function
 * existed, `aiConfigured` stayed false for that path and the freshly-created
 * starter conversation could never open (client.js stubs loadAiConversation
 * to a no-op when the panel says AI is unconfigured).
 *
 * Any query failure degrades to false — never throws, never crashes the
 * panel render.
 *
 * @param {{execute: (arg: string|{sql: string, args: any[]}) => Promise<any>}|null} db
 * @returns {Promise<boolean>}
 */
async function hasUsableProvider(db) {
  if (!db) return false;
  try {
    const { rows } = await db.execute({
      sql: "SELECT models FROM providers WHERE disabled = 0",
      args: [],
    });
    for (const row of rows || []) {
      let models;
      try {
        models = JSON.parse(row.models || "[]");
      } catch {
        models = [];
      }
      if (Array.isArray(models) && models.length && models[0] && models[0].id) return true;
    }
    return false;
  } catch {
    return false;
  }
}

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

    // --- Check AI provider (env config OR profiles OR a usable providers-table row) ---
    let aiConfigured = false;
    try {
      const { getProviderConfig, getAiProfiles } = await import("../../ai/provider.js");
      aiConfigured = !!getProviderConfig();
      if (!aiConfigured) {
        const profiles = await getAiProfiles(db);
        aiConfigured = profiles.length > 0;
      }
    } catch {}
    if (!aiConfigured) {
      // The providers table is the modern registry (see hasUsableProvider's
      // doc comment) — a query failure here just leaves aiConfigured at the
      // env/profiles-only result computed above, it never crashes the render.
      aiConfigured = await hasUsableProvider(db);
    }

    // --- Check storage availability ---
    let storageAvailable = false;
    try {
      const { isAvailable } = await import("../../../storage/s3-client.js");
      storageAvailable = await isAvailable();
    } catch {}

    // --- Get unified conversation list ---
    const { items, totalUnread } = await getUnifiedConversationList(db);

    // Cross-instance bot directory (read-only browse; never throws).
    let botDirectory = { groups: [], total: 0, notAddedCount: 0, perInstance: new Map() };
    // A RENDER — one of only two call sites that opt into the stale-contact prune.
    try { botDirectory = await getBotDirectory(db, { prune: true }); } catch {}

    // Pending message requests (L6 "Requests (N)" inbox; never throws).
    let requests = [];
    try { requests = await getMessageRequests(db); } catch {}

    // --- Bot-invite landing: a shared link opened on THIS instance (?bot_invite=<code>).
    // Parse here (we have `req`) so the still-sync HTML builder just renders strings.
    let botInvite = null;
    const biCode = (req.query && req.query.bot_invite) || null;
    if (biCode) {
      let botName = null;
      try {
        const { parseBotInviteCode } = await import("../../../sharing/identity.js");
        const parsed = parseBotInviteCode(biCode);
        botName = parsed.name || parsed.botCrowId;
      } catch { /* malformed/expired: still offer the button; the tool reports the error */ }
      botInvite = { code: biCode, name: botName, csrf: csrfInput(req) };
    }

    // --- Person-invite landing (?invite=<code or full URL>) — P2/C1 deep link.
    let personInvite = null;
    const piRaw = (req.query && req.query.invite) || null;
    if (piRaw) {
      const code = extractInviteCode(String(piRaw));
      let fromId = null;
      try {
        const { parseInviteCode } = await import("../../../sharing/identity.js");
        fromId = parseInviteCode(code).crowId;
      } catch { /* invalid/expired — card renders the invalid notice */ }
      personInvite = { code, fromId, csrf: csrfInput(req) };
    }

    // --- Build page ---
    let inviteShare = null;
    if (req._inviteResult) {
      try { inviteShare = await buildInviteShare(req._inviteResult); } catch {}
    }

    // Short-code pairing result (P2/C2) — parsed sync, no QR/network involved.
    let shortCodeShare = null;
    if (req._shortCodeResult) {
      try { shortCodeShare = parseShortCodeResult(req._shortCodeResult); } catch {}
    }

    const css = messagesCSS();
    const html = buildMessagesHTML({
      items,
      totalUnread,
      aiConfigured,
      storageAvailable,
      inviteResult: req._inviteResult || null,
      inviteError: req._inviteError || null,
      lang,
      botInvite,
      botDirectory,
      requests,
      csrf: csrfInput(req),
      inviteShare,
      personInvite,
      shortCodeShare,
    });
    const js = messagesClientJS({ aiConfigured, storageAvailable, lang });

    const content = css + html + js;

    const { t } = await import("../shared/i18n.js");
    return layout({ title: t("messages.pageTitle", lang), content });
  },
};
