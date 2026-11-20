/**
 * The Drafts list's rows: ONE shape, built here, for both the panel's server render and the drafts
 * API's list.
 *
 * That is the whole point of this module. The Messages page draws the Drafts section twice — once as
 * HTML (`buildMessagesHTML`) and, after every live frame, from the rows the API answers
 * (`GET /dashboard/messages/api/drafts`, which the panel's client feeds straight into the same row
 * builder). A row that carries the store's own column names (`conversationKind`) and no `label` is
 * not a row either side can draw: the redrawn list loses the recipient's name and its kind, and a
 * ROOM draft's row then opens a CONTACT thread with the room's group id — a different person's
 * conversation. So the store's rows are turned into display rows in exactly one place, and the API,
 * the panel handler and the render all read that place.
 *
 * A display row is:
 *
 *   `{id, kind, conversationId, label, body, preview, origin, botId, botName, version, updatedAt}`
 *
 * `kind` is `contact` or `room` (the conversation kinds, which is also what the row's `data-kind`
 * attribute carries and what the click handler switches on), `label` is the name a person reads (the
 * contact's, or the room's), `preview` is one line of the body cut to `DRAFT_PREVIEW_CHARS`, and
 * `botName` is the bot that wrote it (the snapshot sealed on the row, else the definition's display
 * name, else its id) or null for the operator's own draft.
 *
 * A draft whose conversation is gone (its contact or room was deleted) is skipped rather than drawn
 * against a name nobody can open — the row would open nothing. A failed read of the conversation
 * leaves the rest of the list drawable: `draftRowViews` never throws.
 *
 * Read-only: it writes nothing.
 */
import { resolveConversation } from "./conversations.js";
import { botNamesFor } from "./drafts-bots.js";
import { oneLine } from "../dashboard/shared/bot-display.js";

/** How much of a draft's text the Drafts list shows. */
export const DRAFT_PREVIEW_CHARS = 80;

/**
 * The name a bot's draft is shown by: the snapshot sealed on the row (what the person saw when the
 * bot wrote it), else the definition's display name, else the id itself — an identifier is not a
 * secret, and a blank chip would be worse than a technical one.
 */
function botNameOf(draft, names) {
  const snapshot = String(draft?.botName ?? "").trim();
  if (snapshot) return snapshot;
  const botId = draft?.botId == null ? "" : String(draft.botId);
  if (!botId) return null;
  const found = names.get(botId);
  return found && found.trim() ? found.trim() : botId;
}

/**
 * The display rows for a list of store drafts, in the order they were given (the store answers
 * newest first), with the conversation's name and kind resolved server-side.
 *
 * @param {object} db
 * @param {object[]} drafts rows from servers/gateway/messages/drafts-store.js
 * @param {{previewChars?: number}} [opts]
 * @returns {Promise<Array<{id: string, kind: string, conversationId: number, label: string,
 *   body: string, preview: string, origin: string, botId: string|null, botName: string|null,
 *   version: number, updatedAt: number}>>}
 */
export async function draftRowViews(db, drafts = [], opts = {}) {
  const list = Array.isArray(drafts) ? drafts.filter(Boolean) : [];
  const previewChars = Number.isInteger(opts?.previewChars) && opts.previewChars > 0
    ? opts.previewChars
    : DRAFT_PREVIEW_CHARS;

  // Only a bot row whose snapshot is missing needs the definition lookup.
  const needsName = list.filter((draft) => draft.origin === "bot" && !String(draft.botName ?? "").trim());
  let names = new Map();
  if (needsName.length) {
    try {
      names = await botNamesFor(db, needsName.map((draft) => draft.botId));
    } catch {
      names = new Map();
    }
  }

  const out = [];
  for (const draft of list) {
    let conversation;
    try {
      conversation = await resolveConversation(db, {
        kind: draft.conversationKind,
        id: draft.conversationId,
      });
    } catch {
      continue;
    }
    if (!conversation?.ok) continue;
    const body = String(draft.body ?? "");
    out.push({
      id: draft.id,
      kind: conversation.kind,
      conversationId: conversation.id,
      label: conversation.label,
      body,
      preview: oneLine(body, previewChars),
      origin: draft.origin,
      botId: draft.botId ?? null,
      botName: draft.origin === "bot" ? botNameOf(draft, names) : null,
      version: draft.version,
      updatedAt: draft.updatedAt,
    });
  }
  return out;
}