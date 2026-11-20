/**
 * Messages Panel — HTML Template
 *
 * Three-panel messaging hub: avatar strip + chat area + info sidebar.
 * All user-visible text is escaped via escapeHtml() for XSS prevention.
 */

import { escapeHtml } from "../../shared/components.js";
import { fill, t } from "../../shared/i18n.js";
import { buildBotDirectory } from "../../shared/bot-directory.js";
import { renderInviteShare, renderPeerInviteForms, renderShortCodeShare, renderShortCodeForms } from "../../shared/peer-invite-ui.js";

/** Color palette for peer avatars (deterministic by contact ID) */
const PEER_COLORS = [
  "#0e6b62", "#8b5cf6", "#ec4899", "#f59e0b", "#10b981",
  "#06b6d4", "#f43f5e", "#84cc16", "#d946ef", "#0ea5e9",
];

function peerColor(id) {
  return PEER_COLORS[(id || 0) % PEER_COLORS.length];
}

function initials(name) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.substring(0, 2).toUpperCase();
}

/** "2m ago" / "3h ago" — the same buckets the client's relativeTime() uses, in the panel's language. */
function draftAgo(ms, lang) {
  const diff = Date.now() - Number(ms || 0);
  if (!Number.isFinite(diff) || diff < 0) return "";
  if (diff < 60_000) return t("time.justNow", lang);
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + t("time.mAgo", lang);
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + t("time.hAgo", lang);
  return new Date(Number(ms)).toLocaleDateString();
}

/**
 * One row of the Drafts list. The recipient's name, a one-line preview of the text, the bot chip
 * for a bot's own draft and how long ago it last changed — plus Send and Discard, so a draft can be
 * dealt with without opening its thread. Every value is escaped here; the row carries ids only in
 * its data attributes (the body is in the panel's msg-drafts-data JSON, so it is never written into
 * an attribute).
 */
function draftRow(draft, lang) {
  const id = escapeHtml(String(draft.id || ""));
  const label = escapeHtml(String(draft.label || ""));
  const preview = escapeHtml(String(draft.preview || ""));
  const ago = escapeHtml(draftAgo(draft.updatedAt, lang));
  const bot = draft.origin === "bot" && draft.botName
    ? `<span class="msg-drafts-by">${escapeHtml(fill(t("messages.draft.draftBy", lang), { bot: String(draft.botName) }))}</span>`
    : "";
  return (
    `<div class="msg-drafts-row" data-draft-id="${id}" data-kind="${escapeHtml(String(draft.kind || ""))}" data-conversation-id="${escapeHtml(String(draft.conversationId ?? ""))}">` +
    `<button type="button" class="msg-drafts-open" onclick="msgOpenDraftRow(this)">` +
    `<span class="msg-drafts-row-head"><span class="msg-drafts-name">${label}</span>` +
    `<span class="msg-drafts-time">${ago}</span></span>` +
    (preview ? `<span class="msg-drafts-preview">${preview}</span>` : "") +
    bot +
    `</button>` +
    `<div class="msg-drafts-actions">` +
    `<button type="button" class="msg-draft-send" onclick="msgDraftRowSend(this)">${escapeHtml(t("messages.draft.send", lang))}</button>` +
    `<button type="button" class="msg-draft-discard" onclick="msgDraftRowDiscard(this)">${escapeHtml(t("messages.draft.discard", lang))}</button>` +
    `</div>` +
    `</div>`
  );
}

/**
 * The Drafts section at the top of the Messages view: how many drafts are waiting, one row each, and
 * an empty line when there are none. A <details> so a phone can fold it away and give the whole
 * screen back to the thread (the client folds it when a row opens a thread). Ids are stable —
 * `#msg-drafts` is the section, `#msg-drafts-count` the count line and `#msg-drafts-list` the rows —
 * because the live stream's client redraws exactly those.
 */
function renderDraftsSection(drafts, lang) {
  const list = Array.isArray(drafts) ? drafts : [];
  const rows = list.map((draft) => draftRow(draft, lang)).join("");
  return (
    `<details class="msg-drafts" id="msg-drafts" data-count="${list.length}"${list.length ? " open" : ""}>` +
    `<summary class="msg-drafts-head"><span id="msg-drafts-count">${escapeHtml(fill(t("messages.draft.draftsHeading", lang), { n: list.length }))}</span></summary>` +
    `<div class="msg-drafts-list" id="msg-drafts-list">` +
    (list.length
      ? rows
      : `<div class="msg-drafts-empty" id="msg-drafts-empty">${escapeHtml(t("messages.draft.draftsEmpty", lang))}</div>`) +
    `</div>` +
    `</details>`
  );
}

/**
 * The Discard confirmation. One dialog for both places a draft can be discarded from (its list row
 * and the thread's composer): the client fills it in, shows it and puts focus back where it came
 * from when it closes, Escape included. Markup only — no draft text is ever inside it.
 */
function draftConfirmDialog(lang) {
  return (
    `<div class="msg-draft-confirm" id="msg-draft-confirm" hidden>` +
    `<div class="msg-draft-confirm-card" role="dialog" aria-modal="true" aria-labelledby="msg-draft-confirm-text">` +
    `<p class="msg-draft-confirm-text" id="msg-draft-confirm-text">${escapeHtml(t("messages.draft.discardConfirm", lang))}</p>` +
    `<div class="msg-draft-confirm-actions">` +
    `<button type="button" class="msg-btn-secondary msg-draft-confirm-cancel" id="msg-draft-confirm-cancel">${escapeHtml(t("common.cancel", lang))}</button>` +
    `<button type="button" class="msg-btn-primary msg-draft-confirm-yes" id="msg-draft-confirm-yes">${escapeHtml(t("messages.draft.discard", lang))}</button>` +
    `</div></div></div>`
  );
}

/**
 * Build the full messages panel HTML.
 */
export function buildMessagesHTML(data) {
  const { items, totalUnread, aiConfigured, storageAvailable, inviteResult, inviteError, lang, botInvite, csrf, inviteShare, personInvite, shortCodeShare } = data;
  const drafts = Array.isArray(data.drafts) ? data.drafts : [];
  // WHOSE DRAFTS THESE ARE. A draft holds the words somebody was about to send and who they were
  // for, and the drafts API answers only this machine's own password session
  // (isLocalPasswordSessionOn). The server render must refuse exactly what the API refuses, or a
  // peer's single-sign-on session would read the text (and the previews) here while being told 403
  // there. The panel passes `draftsOwner` from that same rule; anything else — including a caller
  // that forgets it — gets no section, no rows and no data block. Fail closed.
  const draftsOwner = data.draftsOwner === true;

  const peerForms = renderPeerInviteForms({ lang, csrf: csrf || "" });
  const shortCodeForms = renderShortCodeForms({ lang, csrf: csrf || "" });

  // Bot-invite "Add & message" card (data pre-parsed in messages.js).
  let botInviteCard = "";
  if (botInvite) {
    const name = botInvite.name || "a Crow bot";
    botInviteCard =
      `<div class="msg-bot-invite-card">` +
      `<p><strong>${escapeHtml(name)}</strong> would like to chat with you.</p>` +
      `<form method="POST" action="/dashboard/messages">` +
      `<input type="hidden" name="action" value="accept_bot_invite">` +
      `<input type="hidden" name="invite_code" value="${escapeHtml(botInvite.code)}">` +
      `${botInvite.csrf}` +
      `<button type="submit" class="msg-btn-primary">Add &amp; message</button>` +
      `</form></div>`;
  }

  // Person-invite deep link (?invite=<code>) opened on THIS instance (P2/C1).
  let personInviteCard = "";
  if (personInvite) {
    personInviteCard = personInvite.fromId
      ? `<div class="msg-person-invite-card" style="margin:12px;padding:12px;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:8px">` +
        `<div style="font-size:0.85rem;font-weight:600;margin-bottom:6px">${t("invite.connectWith", lang)} ${escapeHtml(personInvite.fromId)}?</div>` +
        `<form method="POST" action="/dashboard/messages">` +
        `<input type="hidden" name="action" value="accept_invite">` +
        `<input type="hidden" name="invite_code" value="${escapeHtml(personInvite.code)}">` +
        `${personInvite.csrf || ""}` +
        `<button type="submit" class="msg-send-btn" style="font-size:0.8rem;padding:6px 14px">${t("invite.acceptBtn", lang)}</button>` +
        `</form></div>`
      : `<div class="msg-person-invite-card" style="margin:12px;padding:12px;background:var(--crow-bg-elevated);border:1px solid var(--crow-error);border-radius:8px">` +
        `<div style="font-size:0.8rem;color:var(--crow-error)">${t("invite.invalidCode", lang)}</div></div>`;
  }

  // Collapsed "browse bots on your other Crows" entry + the directory modal.
  const dir = data.botDirectory || { groups: [], total: 0, notAddedCount: 0 };
  let browseEntry = "", botDirModal = "";
  if (dir.total > 0) {
    browseEntry =
      `<div class="msg-browse-bots" onclick="msgOpenBotDirectory()">` +
      `${escapeHtml(t("messages.botsAvailable", lang).replace("{n}", String(dir.notAddedCount)))}` +
      ` <span class="msg-browse-cta">${escapeHtml(t("messages.browse", lang))}</span></div>`;
    botDirModal =
      `<div class="bot-dir-modal" id="bot-dir-modal"><div class="bot-dir-modal-card">` +
      `<div class="bot-dir-modal-head"><strong>${escapeHtml(t("messages.botDirectoryTitle", lang))}</strong>` +
      `<button class="bot-dir-modal-close" onclick="msgCloseBotDirectory()">&times;</button></div>` +
      buildBotDirectory({ groups: dir.groups, context: "messages", csrf, lang }) +
      `</div></div>`;
  }

  // L6 "Requests (N)" inbox: unknown-sender DMs surfaced with Accept/Decline.
  // Collapsible block, templated on the msg-bot-invite-card Accept form; each
  // row is two classic <form method="POST"> submits (CSRF via the pre-rendered
  // `csrf` input, same as the New Group / bot-invite forms in this file).
  const requests = data.requests || [];
  let requestsBlock = "";
  if (requests.length > 0) {
    const rows = requests.map((r) => {
      const preview = r.preview ? escapeHtml(String(r.preview).substring(0, 140)) : "";
      const idAttr = escapeHtml(String(r.id));
      const countBadge = r.msgCount > 1 ? ` <span class="msg-request-count">${escapeHtml(String(r.msgCount))}</span>` : "";
      return (
        `<div class="msg-request-row">` +
        `<div class="msg-request-meta"><strong>${escapeHtml(r.shortId || r.crowId)}</strong>${countBadge}</div>` +
        (preview ? `<div class="msg-request-preview">${preview}</div>` : "") +
        `<div class="msg-request-actions">` +
        `<form method="POST" action="/dashboard/messages">` +
        `<input type="hidden" name="action" value="accept_request">` +
        `<input type="hidden" name="request_id" value="${idAttr}">` +
        `${csrf || ""}` +
        `<button type="submit" class="msg-btn-primary">${escapeHtml(t("messages.acceptRequest", lang))}</button>` +
        `</form>` +
        `<form method="POST" action="/dashboard/messages">` +
        `<input type="hidden" name="action" value="decline_request">` +
        `<input type="hidden" name="request_id" value="${idAttr}">` +
        `${csrf || ""}` +
        `<button type="submit" class="msg-btn-secondary">${escapeHtml(t("messages.declineRequest", lang))}</button>` +
        `</form>` +
        `</div>` +
        `</div>`
      );
    }).join("");
    requestsBlock =
      `<details class="msg-requests-block" open>` +
      `<summary>${escapeHtml(t("messages.requests", lang).replace("{n}", String(requests.length)))}</summary>` +
      `<div class="msg-requests-help">${escapeHtml(t("messages.requestsHelp", lang))}</div>` +
      rows +
      `</details>`;
  }

  // Build avatar strip items
  const avatarItems = items.map((item) => {
    if (item.type === "ai") {
      const label = escapeHtml((item.displayName || "AI").substring(0, 2).toUpperCase());
      return `<div class="msg-avatar-item" data-type="ai" data-id="${item.id}" onclick="msgSelectItem('ai',${item.id})" title="${escapeHtml(item.displayName)}">
        <div class="msg-avatar msg-avatar-ai">${label}</div>
        <span class="msg-unread-badge" data-badge-ai="${item.id}"></span>
      </div>`;
    } else if (item.type === "room") {
      const label = escapeHtml(initials(item.displayName));
      const unreadClass = item.unread > 0 ? " visible" : "";
      return `<div class="msg-avatar-item" data-type="room" data-id="${item.groupId}" onclick="msgSelectRoom(${item.groupId})" title="${escapeHtml(item.displayName)}">
        <div class="msg-avatar msg-avatar-room">${label}</div>
        <span id="badge-room-${item.groupId}" class="msg-unread-badge${unreadClass}" data-badge-room="${item.groupId}">${item.unread > 0 ? item.unread : ""}</span>
      </div>`;
    } else {
      const color = peerColor(item.id);
      const label = escapeHtml(initials(item.displayName));
      const unreadClass = item.unread > 0 ? " visible" : "";
      const botTag = item.isBot ? `<span class="msg-bot-tag" title="${escapeHtml(t("messages.botTag", lang))}">${escapeHtml(t("messages.botTag", lang))}</span>` : "";
      return `<div class="msg-avatar-item" data-type="peer" data-id="${item.id}" onclick="msgSelectItem('peer',${item.id})" title="${escapeHtml(item.displayName)}">
        <div class="msg-avatar msg-avatar-peer" style="--peer-color:${color}">${label}</div>
        <span id="badge-peer-${item.id}" class="msg-unread-badge${unreadClass}" data-badge-peer="${item.id}">${item.unread > 0 ? item.unread : ""}</span>
        ${botTag}
      </div>`;
    }
  }).join("");

  // Member picker source for the New Group dialog: peer contacts (people + bots)
  // already in the unified list. Normalized to { id, display_name, crow_id, is_bot }.
  const contactsForPicker = items
    .filter((it) => it.type === "peer")
    .map((it) => ({ id: it.id, display_name: it.displayName, crow_id: it.crowId, is_bot: it.isBot }));

  // Invite result banner
  let inviteBanner = "";
  if (inviteResult) {
    const body = inviteShare
      ? renderInviteShare(inviteShare, lang)
      : `<pre style="font-size:0.75rem;white-space:pre-wrap;word-break:break-all;background:var(--crow-bg-deep);padding:8px;border-radius:6px;max-height:120px;overflow-y:auto">${escapeHtml(inviteResult)}</pre>`;
    inviteBanner = `<div style="position:absolute;top:0;left:0;right:0;z-index:50;padding:12px;background:var(--crow-bg-elevated);border-bottom:1px solid var(--crow-border);max-height:70%;overflow-y:auto">
      <div style="font-size:0.8rem;color:var(--crow-text-muted);margin-bottom:4px">${t("messages.inviteGenerated", lang)}</div>
      ${body}
      <button onclick="this.parentElement.remove()" style="margin-top:6px;font-size:0.75rem;background:none;border:1px solid var(--crow-border);border-radius:4px;color:var(--crow-text-muted);cursor:pointer;padding:3px 8px">${t("messages.dismiss", lang)}</button>
    </div>`;
  }
  if (shortCodeShare) {
    inviteBanner = `<div style="position:absolute;top:0;left:0;right:0;z-index:50;padding:12px;background:var(--crow-bg-elevated);border-bottom:1px solid var(--crow-border);max-height:70%;overflow-y:auto">
      <div style="font-size:0.8rem;color:var(--crow-text-muted);margin-bottom:4px">${t("invite.shortCodeTitle", lang)}</div>
      ${renderShortCodeShare(shortCodeShare, lang)}
      <button onclick="this.parentElement.remove()" style="margin-top:6px;font-size:0.75rem;background:none;border:1px solid var(--crow-border);border-radius:4px;color:var(--crow-text-muted);cursor:pointer;padding:3px 8px">${t("messages.dismiss", lang)}</button>
    </div>`;
  }
  if (inviteError) {
    inviteBanner = `<div style="position:absolute;top:0;left:0;right:0;z-index:50;padding:12px;background:var(--crow-bg-elevated);border-bottom:1px solid var(--crow-border)">
      <div style="font-size:0.8rem;color:var(--crow-error)">${t("messages.inviteError", lang)} ${escapeHtml(inviteError)}</div>
      <button onclick="this.parentElement.remove()" style="margin-top:6px;font-size:0.75rem;background:none;border:1px solid var(--crow-border);border-radius:4px;color:var(--crow-text-muted);cursor:pointer;padding:3px 8px">${t("messages.dismiss", lang)}</button>
    </div>`;
  }

  const noChatsLabel = escapeHtml(t("messages.noChats", lang));
  // The Drafts section's client-side source of truth. The rows are the DISPLAY rows
  // (servers/gateway/messages/drafts-rows.js): `kind`, `label`, `body`, `preview`, `botName`,
  // `version`, `updatedAt`, `conversationId`. The server render above and the drafts API's list
  // (`GET /dashboard/messages/api/drafts`, which the client re-reads on every live frame) answer the
  // SAME shape, because the live redraw feeds that answer straight into the row builder — a row
  // without `kind` or `label` would draw blank and a room draft's row would open a contact thread.
  // Nothing about a draft's text rides in a data attribute or an onclick: the body is here, in this
  // JSON block, and is only ever set with textContent.
  const draftsJson = JSON.stringify(drafts).replace(/</g, "\\u003c");

  return botInviteCard + personInviteCard + requestsBlock + browseEntry + `
    <div class="msg-shell">
      ${draftsOwner ? renderDraftsSection(drafts, lang) : ""}
      <div class="msg-hub" style="position:relative">
      ${inviteBanner}
      ${botDirModal}
      <!-- Live peer-badge updates via Turbo Stream (Phase C.3). The
           fallback poll at 5min lives in client.js pollStatus. -->
      <turbo-stream-source src="/dashboard/streams/messages"></turbo-stream-source>
      <!-- Avatar Strip -->
      <div class="msg-strip">
        <button class="msg-strip-new" onclick="msgTogglePopover()" title="${t("messages.newConversation", lang)}">+</button>
        <div class="msg-strip-list">
          ${avatarItems || `<div style="color:var(--crow-text-muted);font-size:0.65rem;text-align:center;padding:8px">${noChatsLabel}</div>`}
        </div>
      </div>

      <!-- New Contact/Chat Popover -->
      <div class="msg-popover" id="msg-popover">
        ${aiConfigured ? `
          <div class="msg-popover-item" onclick="msgNewAiChat()">
            <div class="msg-popover-item-title">${t("messages.newAiChat", lang)}</div>
            <div class="msg-popover-item-desc">${t("messages.aiChatDesc", lang)}</div>
          </div>
          <div class="msg-popover-divider"></div>
        ` : ""}
        <div class="msg-popover-item" onclick="msgShowInviteDialog('generate')">
          <div class="msg-popover-item-title">${t("messages.generateInvite", lang)}</div>
          <div class="msg-popover-item-desc">${t("messages.generateInviteDesc", lang)}</div>
        </div>
        <div class="msg-popover-item" onclick="msgShowInviteDialog('accept')">
          <div class="msg-popover-item-title">${t("messages.acceptInvite", lang)}</div>
          <div class="msg-popover-item-desc">${t("messages.acceptInviteDesc", lang)}</div>
        </div>
        <div class="msg-popover-item" onclick="msgShowInviteDialog('bot')">
          <div class="msg-popover-item-title">${t("messages.addBot", lang)}</div>
          <div class="msg-popover-item-desc">${t("messages.addBotDesc", lang)}</div>
        </div>
        <div class="msg-popover-item" onclick="msgOpenBotDirectory()">
          <div class="msg-popover-item-title">${t("messages.messageABot", lang)}</div>
          <div class="msg-popover-item-desc">${t("messages.messageABotDesc", lang)}</div>
        </div>
        <div class="msg-popover-item" onclick="msgShowCreateGroupDialog()">
          <div class="msg-popover-item-title">${t("messages.newGroup", lang)}</div>
          <div class="msg-popover-item-desc">${t("messages.newGroupDesc", lang)}</div>
        </div>
        <div class="msg-invite-dialog" id="invite-group">
          <form method="POST">
            <input type="hidden" name="action" value="create_room">
            <input name="room_name" placeholder="${t("messages.groupName", lang)}" required maxlength="80" class="msg-input">
            <label class="msg-room-mode">${t("messages.roomMode", lang)}:
              <select name="mode">
                <option value="addressed">${t("messages.roomModeAddressed", lang)}</option>
                <option value="always">${t("messages.roomModeAlways", lang)}</option>
              </select>
            </label>
            <div class="msg-member-picker">
              <div class="msg-member-picker-label">${t("messages.groupMembers", lang)}</div>
              ${(contactsForPicker || []).map((c) => `
                <label class="msg-member-opt"><input type="checkbox" name="member_ids" value="${c.id}">
                  ${c.is_bot ? '<span class="msg-bot-badge">bot</span> ' : ""}${escapeHtml(c.display_name || c.crow_id)}</label>`).join("")}
            </div>
            ${csrf || ""}
            <button type="submit" class="msg-send-btn" style="width:100%;font-size:0.8rem;padding:6px">${t("messages.createGroupBtn", lang)}</button>
          </form>
          <div class="msg-room-hint">${t("messages.roomLeaveHint", lang)}</div>
        </div>
        <div class="msg-invite-dialog" id="invite-generate">
          ${peerForms.generateForm}
          <details style="margin-top:8px">
            <summary style="cursor:pointer;font-size:0.75rem;color:var(--crow-text-muted)">${t("invite.shortCodeToggle", lang)}</summary>
            <div style="margin-top:6px">${shortCodeForms.generateForm}</div>
          </details>
        </div>
        <div class="msg-invite-dialog" id="invite-accept">
          ${peerForms.acceptForm}
          <details style="margin-top:8px">
            <summary style="cursor:pointer;font-size:0.75rem;color:var(--crow-text-muted)">${t("invite.shortCodeToggle", lang)}</summary>
            <div style="margin-top:6px">${shortCodeForms.acceptForm}</div>
          </details>
        </div>
        <div class="msg-invite-dialog" id="invite-bot">
          <form method="POST">
            <input type="hidden" name="action" value="accept_bot_invite">
            <textarea name="invite_code" placeholder="${t("messages.pasteBotInvitePlaceholder", lang)}" rows="3" required></textarea>
            ${csrf || ""}
            <button type="submit" class="msg-send-btn" style="width:100%;font-size:0.8rem;padding:6px">${t("messages.addBotButton", lang)}</button>
          </form>
        </div>
      </div>

      <!-- Chat Area -->
      <div class="msg-chat" id="msg-chat">
        <div class="msg-empty" id="msg-empty-state">
          <div>
            <h3>${t("messages.emptyTitle", lang)}</h3>
            <p>${t("messages.emptyDesc", lang)}</p>
            ${totalUnread > 0 ? `<p style="margin-top:0.5rem;color:var(--crow-accent)">${totalUnread} ${totalUnread !== 1 ? t("messages.emptyDesc", lang).includes("unread") ? "" : "" : ""}unread</p>` : ""}
          </div>
        </div>
      </div>

      <!-- Info Sidebar -->
      <div class="msg-info hidden" id="msg-info">
        <div class="msg-info-profile" id="msg-info-profile"></div>
        <div id="msg-info-details"></div>
        <div class="msg-info-actions" id="msg-info-actions"></div>
      </div>
      </div>
    </div>

    <input type="file" id="msg-file-input" style="display:none" multiple accept="image/*,application/pdf,audio/*,video/*,text/*,application/json,application/zip">
    <div id="msg-storage-available" data-available="${storageAvailable ? '1' : '0'}" style="display:none"></div>
    <!-- Contact roster (people + bots) for the room "add member" picker. Same
         normalized source as the New Group dialog; read client-side, no extra fetch. -->
    <script id="msg-contacts-data" type="application/json">${JSON.stringify(contactsForPicker || []).replace(/</g, "\\u003c")}</script>
    ${draftsOwner ? `<!-- Open drafts (the Drafts section's rows), for the panel's live redraw. -->
    <script id="msg-drafts-data" type="application/json">${draftsJson}</script>
    ${draftConfirmDialog(lang)}` : ""}
  `;
}
