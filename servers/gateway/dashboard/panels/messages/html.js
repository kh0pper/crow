/**
 * Messages Panel — HTML Template
 *
 * Three-panel messaging hub: avatar strip + chat area + info sidebar.
 * All user-visible text is escaped via escapeHtml() for XSS prevention.
 */

import { escapeHtml } from "../../shared/components.js";
import { t } from "../../shared/i18n.js";

/** Color palette for peer avatars (deterministic by contact ID) */
const PEER_COLORS = [
  "#6366f1", "#8b5cf6", "#ec4899", "#f59e0b", "#10b981",
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

/**
 * Build the full messages panel HTML.
 */
export function buildMessagesHTML(data) {
  const { items, totalUnread, aiConfigured, storageAvailable, inviteResult, inviteError, lang } = data;

  // Build avatar strip items
  const avatarItems = items.map((item) => {
    if (item.type === "ai") {
      const label = escapeHtml((item.displayName || "AI").substring(0, 2).toUpperCase());
      return `<div class="msg-avatar-item" data-type="ai" data-id="${item.id}" onclick="msgSelectItem('ai',${item.id})" title="${escapeHtml(item.displayName)}">
        <div class="msg-avatar msg-avatar-ai">${label}</div>
        <span class="msg-unread-badge" data-badge-ai="${item.id}"></span>
      </div>`;
    } else if (item.type === "bot") {
      const label = escapeHtml(initials(item.displayName));
      return `<div class="msg-avatar-item" data-type="bot" data-id="${item.id}" onclick="msgSelectItem('bot',${item.id})" title="${escapeHtml(item.displayName)}">
        <div class="msg-avatar msg-avatar-bot">${label}</div>
        <span class="msg-unread-badge" data-badge-bot="${item.id}"></span>
      </div>`;
    } else {
      const color = peerColor(item.id);
      const label = escapeHtml(initials(item.displayName));
      const unreadClass = item.unread > 0 ? " visible" : "";
      return `<div class="msg-avatar-item" data-type="peer" data-id="${item.id}" onclick="msgSelectItem('peer',${item.id})" title="${escapeHtml(item.displayName)}">
        <div class="msg-avatar msg-avatar-peer" style="--peer-color:${color}">${label}</div>
        <span id="badge-peer-${item.id}" class="msg-unread-badge${unreadClass}" data-badge-peer="${item.id}">${item.unread > 0 ? item.unread : ""}</span>
      </div>`;
    }
  }).join("");

  // Invite result banner
  let inviteBanner = "";
  if (inviteResult) {
    inviteBanner = `<div style="position:absolute;top:0;left:0;right:0;z-index:50;padding:12px;background:var(--crow-bg-elevated);border-bottom:1px solid var(--crow-border)">
      <div style="font-size:0.8rem;color:var(--crow-text-muted);margin-bottom:4px">${t("messages.inviteGenerated", lang)}</div>
      <pre style="font-size:0.75rem;white-space:pre-wrap;word-break:break-all;background:var(--crow-bg-deep);padding:8px;border-radius:6px;max-height:120px;overflow-y:auto">${escapeHtml(inviteResult)}</pre>
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

  return `
    <div class="msg-hub" style="position:relative">
      ${inviteBanner}
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
        <div class="msg-invite-dialog" id="invite-generate">
          <form method="POST">
            <input type="hidden" name="action" value="generate_invite">
            <button type="submit" class="msg-send-btn" style="width:100%;font-size:0.8rem;padding:6px">${t("messages.generateInviteCode", lang)}</button>
          </form>
        </div>
        <div class="msg-invite-dialog" id="invite-accept">
          <form method="POST">
            <input type="hidden" name="action" value="accept_invite">
            <textarea name="invite_code" placeholder="${t("messages.pasteInvitePlaceholder", lang)}" rows="3" required></textarea>
            <button type="submit" class="msg-send-btn" style="width:100%;font-size:0.8rem;padding:6px">${t("messages.acceptInviteButton", lang)}</button>
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

    <input type="file" id="msg-file-input" style="display:none" multiple accept="image/*,application/pdf,audio/*,video/*,text/*,application/json,application/zip">
    <div id="msg-storage-available" data-available="${storageAvailable ? '1' : '0'}" style="display:none"></div>
  `;
}
