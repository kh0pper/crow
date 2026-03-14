/**
 * Messages Panel — AI Chat + Peer Messages (Nostr)
 *
 * Two-tab layout:
 * - AI Chat: conversations with AI providers (BYOAI), tool calling, streaming
 * - Peer Messages: interactive Nostr P2P messaging (expand, reply, compose, mark read)
 *
 * Security: All user-visible text is escaped via escapeH() before DOM insertion.
 * Chat content from AI providers is treated as untrusted and escaped.
 * innerHTML is only used for static server-rendered HTML from trusted sources
 * (the server-side layout) and for escaped content via escapeH().
 */

import { escapeHtml, statCard, statGrid, section, formatDate, badge } from "../shared/components.js";
import { ICON_SHARING } from "../shared/empty-state-icons.js";

export default {
  id: "messages",
  name: "Messages",
  icon: "messages",
  route: "/dashboard/messages",
  navOrder: 10,

  async handler(req, res, { db, layout }) {
    // --- Handle POST actions for peer messages ---
    if (req.method === "POST") {
      const { action } = req.body;

      if (action === "send" && req.body.contact && req.body.message) {
        // Send a peer message via the sharing server's Nostr transport
        try {
          const { createSharingServer } = await import("../../sharing/server.js");
          const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
          const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

          const server = createSharingServer();
          const client = new Client({ name: "dashboard-peer-send", version: "0.1.0" });
          const [ct, st] = InMemoryTransport.createLinkedPair();
          await server.connect(st);
          await client.connect(ct);

          await client.callTool({
            name: "crow_send_message",
            arguments: { contact: req.body.contact, message: req.body.message },
          });

          await client.close();
        } catch (err) {
          console.error("[messages] Failed to send peer message:", err.message);
        }
        return res.redirect("/dashboard/messages?tab=peer");
      }

      if (action === "mark_read" && req.body.id) {
        await db.execute({
          sql: "UPDATE messages SET is_read = 1 WHERE id = ?",
          args: [parseInt(req.body.id, 10)],
        });
        return res.redirect("/dashboard/messages?tab=peer");
      }
    }

    // Check if AI provider is configured
    let aiConfigured = false;
    try {
      const { getProviderConfig } = await import("../../ai/provider.js");
      aiConfigured = !!getProviderConfig();
    } catch {}

    // Peer message stats
    const totalResult = await db.execute("SELECT COUNT(*) as c FROM messages");
    const unreadResult = await db.execute("SELECT COUNT(*) as c FROM messages WHERE is_read = 0 AND direction = 'received'");
    const contactsCountResult = await db.execute("SELECT COUNT(*) as c FROM contacts WHERE is_blocked = 0");

    const total = totalResult.rows[0]?.c || 0;
    const unread = unreadResult.rows[0]?.c || 0;
    const contactCount = contactsCountResult.rows[0]?.c || 0;

    // Chat conversation count
    let chatCount = 0;
    try {
      const chatResult = await db.execute("SELECT COUNT(*) as c FROM chat_conversations");
      chatCount = chatResult.rows[0]?.c || 0;
    } catch {}

    // Peer messages data
    const messages = await db.execute({
      sql: `SELECT m.id, m.content, m.direction, m.is_read, m.created_at, m.thread_id,
                   m.contact_id, c.display_name, c.crow_id
            FROM messages m
            LEFT JOIN contacts c ON m.contact_id = c.id
            ORDER BY m.created_at DESC LIMIT 50`,
      args: [],
    });

    // Fetch contacts for compose dropdown
    const contactsList = await db.execute(
      "SELECT id, crow_id, display_name FROM contacts WHERE is_blocked = 0 ORDER BY display_name ASC, crow_id ASC"
    );

    // Build peer messages as interactive list (not a flat table)
    let peerMessageList;
    if (messages.rows.length === 0) {
      peerMessageList = `<div class="empty-state">
        <div style="margin-bottom:1rem">${ICON_SHARING}</div>
        <h3>Your inbox is empty</h3>
        <p>Messages from friends and shared items will appear here.</p>
      </div>`;
    } else {
      const msgRows = messages.rows.map((m) => {
        const dir = m.direction === "sent" ? "\u2192 Sent" : "\u2190 Received";
        const isUnread = m.direction === "received" && !m.is_read;
        const unreadClass = isUnread ? " peer-msg-unread" : "";
        const name = escapeHtml(m.display_name || (m.crow_id ? m.crow_id.substring(0, 16) + "..." : "Unknown"));
        const preview = escapeHtml((m.content || "").slice(0, 80));
        const fullContent = escapeHtml(m.content || "");
        const dateStr = formatDate(m.created_at);
        const contactIdentifier = escapeHtml(m.display_name || m.crow_id || "");

        return `<div class="peer-msg-row${unreadClass}" data-msg-id="${m.id}">
          <div class="peer-msg-header" onclick="togglePeerMsg(this)">
            <div class="peer-msg-from">
              <span class="mono" style="font-size:0.75rem;opacity:0.6">${dir}</span>
              <strong>${name}</strong>
              ${isUnread ? badge("new", "published") : ""}
            </div>
            <div class="peer-msg-preview">${preview}${(m.content || "").length > 80 ? "..." : ""}</div>
            <div class="peer-msg-date mono">${dateStr}</div>
          </div>
          <div class="peer-msg-body" style="display:none">
            <div class="peer-msg-full">${fullContent}</div>
            ${isUnread ? `<form method="POST" style="display:inline">
              <input type="hidden" name="action" value="mark_read">
              <input type="hidden" name="id" value="${m.id}">
              <button type="submit" class="btn btn-sm btn-secondary" style="margin-top:0.5rem">Mark as read</button>
            </form>` : ""}
            ${m.crow_id ? `<div class="peer-msg-reply" style="margin-top:0.75rem">
              <form method="POST" style="display:flex;gap:0.5rem;align-items:flex-end">
                <input type="hidden" name="action" value="send">
                <input type="hidden" name="contact" value="${contactIdentifier}">
                <textarea name="message" placeholder="Reply to ${name}..." rows="2"
                  style="flex:1;resize:none;border:1px solid var(--crow-border);border-radius:6px;padding:0.5rem;
                         background:var(--crow-bg-deep,#0f0f17);color:var(--crow-text);font-size:0.85rem;font-family:inherit"
                  required maxlength="10000"></textarea>
                <button type="submit" class="btn btn-primary btn-sm">Reply</button>
              </form>
            </div>` : ""}
          </div>
        </div>`;
      });
      peerMessageList = msgRows.join("");
    }

    // Compose form (contact selector + message)
    let composeForm = "";
    if (contactsList.rows.length > 0) {
      const optionRows = contactsList.rows.map((c) => {
        const label = escapeHtml(c.display_name || c.crow_id.substring(0, 24) + "...");
        const val = escapeHtml(c.display_name || c.crow_id);
        return `<option value="${val}">${label}</option>`;
      }).join("");

      composeForm = `<div class="peer-compose">
        <form method="POST" style="display:flex;gap:0.5rem;flex-wrap:wrap;align-items:flex-end">
          <input type="hidden" name="action" value="send">
          <div style="flex:0 0 200px">
            <label style="font-size:0.8rem;color:var(--crow-text-muted);display:block;margin-bottom:0.25rem">To</label>
            <select name="contact" required style="width:100%;border:1px solid var(--crow-border);border-radius:6px;
                    padding:0.5rem;background:var(--crow-bg-deep,#0f0f17);color:var(--crow-text);font-size:0.85rem">
              ${optionRows}
            </select>
          </div>
          <div style="flex:1;min-width:200px">
            <label style="font-size:0.8rem;color:var(--crow-text-muted);display:block;margin-bottom:0.25rem">Message</label>
            <textarea name="message" placeholder="Write a message..." rows="2" required maxlength="10000"
              style="width:100%;resize:none;border:1px solid var(--crow-border);border-radius:6px;padding:0.5rem;
                     background:var(--crow-bg-deep,#0f0f17);color:var(--crow-text);font-size:0.85rem;font-family:inherit"></textarea>
          </div>
          <button type="submit" class="btn btn-primary btn-sm" style="flex-shrink:0">Send</button>
        </form>
      </div>`;
    }

    // Determine default tab (respect ?tab= query param for redirects after POST)
    const tabParam = req.query?.tab;
    const defaultTab = tabParam === "peer" ? "peer" : (tabParam === "ai-chat" ? "ai-chat" : (aiConfigured ? "ai-chat" : "peer"));

    const content = `
      <style>
        .msg-tabs { display:flex; gap:0; border-bottom:1px solid var(--crow-border); margin-bottom:1.5rem; }
        .msg-tab { padding:0.75rem 1.25rem; cursor:pointer; font-size:0.9rem; color:var(--crow-text-muted);
                   border-bottom:2px solid transparent; transition:all 0.15s; user-select:none; }
        .msg-tab:hover { color:var(--crow-text); }
        .msg-tab.active { color:var(--crow-accent); border-bottom-color:var(--crow-accent); }
        .msg-tab-badge { display:inline-block; min-width:18px; height:18px; line-height:18px; text-align:center;
                         font-size:0.7rem; font-weight:700; border-radius:9px; padding:0 5px; margin-left:6px;
                         background:var(--crow-brand-gold,#fbbf24); color:#000; }
        .msg-pane { display:none; }
        .msg-pane.active { display:block; }

        /* Chat UI */
        .chat-layout { display:flex; gap:0; height:calc(100vh - 220px); min-height:400px; border:1px solid var(--crow-border); border-radius:8px; overflow:hidden; }
        .chat-sidebar { width:260px; flex-shrink:0; border-right:1px solid var(--crow-border); display:flex; flex-direction:column; background:var(--crow-bg-surface,var(--crow-surface)); }
        .chat-sidebar-header { padding:0.75rem; border-bottom:1px solid var(--crow-border); }
        .chat-sidebar-list { flex:1; overflow-y:auto; }
        .chat-conv-item { padding:0.75rem; cursor:pointer; border-bottom:1px solid color-mix(in srgb, var(--crow-border) 50%, transparent); transition:background 0.1s; }
        .chat-conv-item:hover { background:color-mix(in srgb, var(--crow-accent) 8%, transparent); }
        .chat-conv-item.active { background:color-mix(in srgb, var(--crow-accent) 12%, transparent); border-left:3px solid var(--crow-accent); }
        .chat-conv-title { font-size:0.85rem; font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .chat-conv-meta { font-size:0.75rem; color:var(--crow-text-muted); margin-top:2px; }
        .chat-main { flex:1; display:flex; flex-direction:column; min-width:0; }
        .chat-header { padding:0.75rem 1rem; border-bottom:1px solid var(--crow-border); display:flex; align-items:center; gap:0.75rem; }
        .chat-header-title { font-size:0.95rem; font-weight:600; flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .chat-messages { flex:1; overflow-y:auto; padding:1rem; display:flex; flex-direction:column; gap:0.75rem; }
        .chat-msg { max-width:80%; padding:0.6rem 0.9rem; border-radius:12px; font-size:0.9rem; line-height:1.5; word-wrap:break-word; white-space:pre-wrap; }
        .chat-msg-user { align-self:flex-end; background:var(--crow-accent); color:#fff; border-bottom-right-radius:4px; }
        .chat-msg-assistant { align-self:flex-start; background:var(--crow-bg-elevated,#2d2d3d); border-bottom-left-radius:4px; }
        .chat-msg-tool { align-self:flex-start; background:color-mix(in srgb, var(--crow-accent) 10%, var(--crow-bg-deep,#0f0f17));
                         border:1px solid var(--crow-border); border-radius:8px; padding:0.5rem 0.75rem; font-size:0.8rem; max-width:90%; }
        .chat-msg-tool summary { cursor:pointer; color:var(--crow-accent); font-family:'JetBrains Mono',monospace; font-size:0.8rem; }
        .chat-msg-tool pre { margin:0.5rem 0 0; white-space:pre-wrap; font-size:0.75rem; color:var(--crow-text-muted); max-height:200px; overflow-y:auto; }
        .chat-input-area { padding:0.75rem; border-top:1px solid var(--crow-border); display:flex; gap:0.5rem; }
        .chat-input { flex:1; resize:none; border:1px solid var(--crow-border); border-radius:8px; padding:0.6rem 0.75rem;
                      background:var(--crow-bg-deep,#0f0f17); color:var(--crow-text); font-size:0.9rem; font-family:inherit;
                      min-height:40px; max-height:120px; line-height:1.4; }
        .chat-input:focus { outline:none; border-color:var(--crow-accent); }
        .chat-send-btn { padding:0.6rem 1.2rem; background:var(--crow-accent); color:#fff; border:none; border-radius:8px;
                         cursor:pointer; font-size:0.85rem; font-weight:600; transition:opacity 0.15s; flex-shrink:0; }
        .chat-send-btn:hover { opacity:0.85; }
        .chat-send-btn:disabled { opacity:0.5; cursor:not-allowed; }
        .chat-empty { display:flex; align-items:center; justify-content:center; flex:1; text-align:center; color:var(--crow-text-muted); }
        .chat-empty h3 { margin:0.5rem 0; color:var(--crow-text); }
        .chat-empty p { font-size:0.85rem; }
        .chat-typing { font-size:0.8rem; color:var(--crow-accent); padding:0.25rem 0; font-style:italic; }
        .chat-cancel-btn { font-size:0.75rem; background:none; border:1px solid var(--crow-border); border-radius:4px;
                           color:var(--crow-text-muted); cursor:pointer; padding:0.25rem 0.5rem; }
        .chat-delete-btn { font-size:0.75rem; background:none; border:none; color:var(--crow-text-muted); cursor:pointer; padding:0.25rem; }
        .chat-delete-btn:hover { color:var(--crow-error,#ef4444); }

        /* Peer Messages interactive rows */
        .peer-msg-row { border-bottom:1px solid var(--crow-border); transition:background 0.1s; }
        .peer-msg-row:last-child { border-bottom:none; }
        .peer-msg-unread { background:color-mix(in srgb, var(--crow-accent) 5%, transparent); }
        .peer-msg-header { display:flex; align-items:center; gap:0.75rem; padding:0.75rem; cursor:pointer; transition:background 0.1s; }
        .peer-msg-header:hover { background:color-mix(in srgb, var(--crow-accent) 8%, transparent); }
        .peer-msg-from { flex:0 0 180px; display:flex; align-items:center; gap:0.5rem; font-size:0.85rem; }
        .peer-msg-preview { flex:1; font-size:0.85rem; color:var(--crow-text-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .peer-msg-date { flex:0 0 auto; font-size:0.75rem; color:var(--crow-text-muted); }
        .peer-msg-body { padding:0 0.75rem 0.75rem 0.75rem; }
        .peer-msg-full { background:var(--crow-bg-deep,#0f0f17); border-radius:6px; padding:0.75rem; font-size:0.85rem;
                         line-height:1.5; white-space:pre-wrap; word-wrap:break-word; }
        .peer-compose { padding:0.5rem 0; }

        @media (max-width: 768px) {
          .chat-sidebar { width:200px; }
          .chat-msg { max-width:90%; }
          .peer-msg-from { flex:0 0 120px; }
        }
        @media (max-width: 600px) {
          .chat-layout { flex-direction:column; height:auto; }
          .chat-sidebar { width:100%; max-height:200px; border-right:none; border-bottom:1px solid var(--crow-border); }
          .peer-msg-header { flex-wrap:wrap; }
          .peer-msg-from { flex:1 1 100%; }
          .peer-msg-preview { flex:1 1 100%; }
        }
      </style>

      <div class="msg-tabs">
        <div class="msg-tab${defaultTab === "ai-chat" ? " active" : ""}" onclick="switchMsgTab('ai-chat')">
          AI Chat ${chatCount ? `<span class="msg-tab-badge">${chatCount}</span>` : ""}
        </div>
        <div class="msg-tab${defaultTab === "peer" ? " active" : ""}" onclick="switchMsgTab('peer')">
          Peer Messages ${unread ? `<span class="msg-tab-badge">${unread}</span>` : ""}
        </div>
      </div>

      <!-- AI Chat Tab -->
      <div id="pane-ai-chat" class="msg-pane${defaultTab === "ai-chat" ? " active" : ""}">
        ${aiConfigured ? `
          <div class="chat-layout">
            <div class="chat-sidebar">
              <div class="chat-sidebar-header">
                <button class="btn btn-primary btn-sm" style="width:100%" onclick="newConversation()">New Chat</button>
              </div>
              <div class="chat-sidebar-list" id="conv-list">
                <div style="padding:1rem;color:var(--crow-text-muted);font-size:0.85rem;text-align:center">Loading...</div>
              </div>
            </div>
            <div class="chat-main" id="chat-main">
              <div class="chat-empty">
                <div>
                  <h3>Start a conversation</h3>
                  <p>Click "New Chat" or select an existing conversation.</p>
                </div>
              </div>
            </div>
          </div>
        ` : `
          <div class="empty-state">
            <div style="margin-bottom:1rem">${ICON_SHARING}</div>
            <h3>AI Chat not configured</h3>
            <p>Set up an AI provider in <a href="/dashboard/settings" style="color:var(--crow-accent)">Settings</a> to start chatting.</p>
            <p style="font-size:0.85rem;color:var(--crow-text-muted);margin-top:0.5rem">Supports OpenAI, Anthropic, Google Gemini, Ollama, and OpenRouter.</p>
          </div>
        `}
      </div>

      <!-- Peer Messages Tab -->
      <div id="pane-peer" class="msg-pane${defaultTab === "peer" ? " active" : ""}">
        ${statGrid([
          statCard("Total Messages", total, { delay: 0 }),
          statCard("Unread", unread, { delay: 50 }),
          statCard("Contacts", contactCount, { delay: 100 }),
        ])}
        ${composeForm ? section("New Message", composeForm, { delay: 100 }) : ""}
        ${section("Messages", peerMessageList, { delay: 150 })}
      </div>

      <script>
      // Escape all untrusted text before DOM insertion to prevent XSS
      function escapeH(s) {
        if (!s) return '';
        var d = document.createElement('div');
        d.textContent = s;
        return d.innerHTML;
      }

      function togglePeerMsg(headerEl) {
        var body = headerEl.nextElementSibling;
        if (!body) return;
        var isHidden = body.style.display === 'none';
        body.style.display = isHidden ? 'block' : 'none';
        // Mark as read visually when expanding an unread message
        if (isHidden) {
          var row = headerEl.parentElement;
          if (row) row.classList.remove('peer-msg-unread');
        }
      }

      function switchMsgTab(tab) {
        document.querySelectorAll('.msg-tab').forEach(function(t) { t.classList.remove('active'); });
        document.querySelectorAll('.msg-pane').forEach(function(p) { p.classList.remove('active'); });
        document.querySelector('.msg-tab:nth-child(' + (tab === 'ai-chat' ? '1' : '2') + ')').classList.add('active');
        document.getElementById('pane-' + tab).classList.add('active');
        if (tab === 'ai-chat' && !window._convLoaded) { loadConversations(); window._convLoaded = true; }
      }

      var _activeConvId = null;
      var _sending = false;

      ${aiConfigured ? `
      // Load conversations on mount
      if (document.getElementById('pane-ai-chat').classList.contains('active')) {
        loadConversations();
        window._convLoaded = true;
      }

      async function loadConversations() {
        try {
          var res = await fetch('/api/chat/conversations');
          var data = await res.json();
          var list = document.getElementById('conv-list');
          if (!data.conversations || data.conversations.length === 0) {
            list.textContent = '';
            var emptyMsg = document.createElement('div');
            emptyMsg.style.cssText = 'padding:1rem;color:var(--crow-text-muted);font-size:0.85rem;text-align:center';
            emptyMsg.textContent = 'No conversations yet';
            list.appendChild(emptyMsg);
            return;
          }
          // Clear and rebuild using DOM methods
          list.textContent = '';
          data.conversations.forEach(function(c) {
            var item = document.createElement('div');
            item.className = 'chat-conv-item' + (c.id === _activeConvId ? ' active' : '');
            item.dataset.convId = c.id;
            item.addEventListener('click', function() { selectConversation(c.id); });

            var row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;gap:0.5rem';

            var titleEl = document.createElement('div');
            titleEl.className = 'chat-conv-title';
            titleEl.style.flex = '1';
            var title = c.title || 'Untitled';
            titleEl.textContent = title.length > 40 ? title.slice(0, 40) + '...' : title;

            var delBtn = document.createElement('button');
            delBtn.className = 'chat-delete-btn';
            delBtn.title = 'Delete';
            delBtn.textContent = '\\u00d7';
            delBtn.addEventListener('click', function(e) { e.stopPropagation(); deleteConversation(c.id); });

            row.appendChild(titleEl);
            row.appendChild(delBtn);

            var meta = document.createElement('div');
            meta.className = 'chat-conv-meta';
            var date = new Date(c.updated_at || c.created_at).toLocaleDateString();
            meta.textContent = (c.provider || '') + ' \\u00b7 ' + date;

            item.appendChild(row);
            item.appendChild(meta);
            list.appendChild(item);
          });
        } catch(e) { console.error('Failed to load conversations:', e); }
      }

      async function newConversation() {
        try {
          var res = await fetch('/api/chat/conversations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: 'New conversation' }),
          });
          var data = await res.json();
          if (data.id) {
            _activeConvId = data.id;
            await loadConversations();
            await selectConversation(data.id);
          }
        } catch(e) { console.error(e); }
      }

      async function selectConversation(id) {
        _activeConvId = id;
        // Highlight in sidebar
        document.querySelectorAll('.chat-conv-item').forEach(function(el) {
          el.classList.toggle('active', parseInt(el.dataset.convId) === id);
        });
        // Load conversation
        try {
          var res = await fetch('/api/chat/conversations/' + encodeURIComponent(id));
          var data = await res.json();
          renderChatView(data);
        } catch(e) { console.error(e); }
      }

      function renderChatView(data) {
        var conv = data.conversation;
        var msgs = data.messages || [];
        var main = document.getElementById('chat-main');
        main.textContent = '';

        // Header
        var header = document.createElement('div');
        header.className = 'chat-header';
        var headerTitle = document.createElement('div');
        headerTitle.className = 'chat-header-title';
        headerTitle.textContent = conv.title || 'Chat';
        var headerMeta = document.createElement('span');
        headerMeta.className = 'mono';
        headerMeta.style.cssText = 'font-size:0.75rem;color:var(--crow-text-muted)';
        headerMeta.textContent = (conv.provider || '') + (conv.model ? ' / ' + conv.model : '');
        header.appendChild(headerTitle);
        header.appendChild(headerMeta);
        main.appendChild(header);

        // Messages area
        var msgsDiv = document.createElement('div');
        msgsDiv.className = 'chat-messages';
        msgsDiv.id = 'chat-messages';
        for (var i = 0; i < msgs.length; i++) {
          appendMessage(msgsDiv, msgs[i]);
        }
        main.appendChild(msgsDiv);

        // Input area
        var inputArea = document.createElement('div');
        inputArea.className = 'chat-input-area';
        var textarea = document.createElement('textarea');
        textarea.className = 'chat-input';
        textarea.id = 'chat-input';
        textarea.placeholder = 'Type a message...';
        textarea.rows = 1;
        textarea.addEventListener('keydown', function(e) {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
        });
        textarea.addEventListener('input', function() {
          this.style.height = 'auto';
          this.style.height = Math.min(this.scrollHeight, 120) + 'px';
        });
        var sendBtn = document.createElement('button');
        sendBtn.className = 'chat-send-btn';
        sendBtn.id = 'chat-send';
        sendBtn.textContent = 'Send';
        sendBtn.addEventListener('click', sendMessage);
        inputArea.appendChild(textarea);
        inputArea.appendChild(sendBtn);
        main.appendChild(inputArea);

        msgsDiv.scrollTop = msgsDiv.scrollHeight;
      }

      function appendMessage(container, msg) {
        if (msg.role === 'user') {
          var div = document.createElement('div');
          div.className = 'chat-msg chat-msg-user';
          div.textContent = msg.content || '';
          container.appendChild(div);
        } else if (msg.role === 'assistant' && msg.content) {
          var div = document.createElement('div');
          div.className = 'chat-msg chat-msg-assistant';
          div.textContent = msg.content;
          container.appendChild(div);
        } else if (msg.role === 'tool') {
          var toolDiv = document.createElement('div');
          toolDiv.className = 'chat-msg-tool';
          var details = document.createElement('details');
          var summary = document.createElement('summary');
          summary.textContent = msg.tool_name || 'tool';
          var pre = document.createElement('pre');
          pre.textContent = (msg.content || '').slice(0, 300);
          details.appendChild(summary);
          details.appendChild(pre);
          toolDiv.appendChild(details);
          container.appendChild(toolDiv);
        }
      }

      function chatKeyDown(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendMessage();
        }
      }

      async function sendMessage() {
        if (_sending || !_activeConvId) return;
        var input = document.getElementById('chat-input');
        var content = (input.value || '').trim();
        if (!content) return;

        _sending = true;
        input.value = '';
        input.style.height = 'auto';
        document.getElementById('chat-send').disabled = true;

        var messagesDiv = document.getElementById('chat-messages');

        // Add user message
        var userMsg = document.createElement('div');
        userMsg.className = 'chat-msg chat-msg-user';
        userMsg.textContent = content;
        messagesDiv.appendChild(userMsg);
        messagesDiv.scrollTop = messagesDiv.scrollHeight;

        // Add typing indicator
        var typingEl = document.createElement('div');
        typingEl.className = 'chat-typing';
        typingEl.textContent = 'Thinking... ';
        var cancelBtn = document.createElement('button');
        cancelBtn.className = 'chat-cancel-btn';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', cancelGeneration);
        typingEl.appendChild(cancelBtn);
        messagesDiv.appendChild(typingEl);
        messagesDiv.scrollTop = messagesDiv.scrollHeight;

        // Placeholder for streaming assistant content
        var assistantDiv = null;
        var assistantContent = '';
        var currentEventType = null;

        try {
          var response = await fetch('/api/chat/conversations/' + encodeURIComponent(_activeConvId) + '/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: content }),
          });

          var reader = response.body.getReader();
          var decoder = new TextDecoder();
          var buffer = '';

          while (true) {
            var result = await reader.read();
            if (result.done) break;

            buffer += decoder.decode(result.value, { stream: true });
            var lines = buffer.split('\\n');
            buffer = lines.pop() || '';

            for (var li = 0; li < lines.length; li++) {
              var line = lines[li].trim();
              if (!line) continue;

              if (line.startsWith('event: ')) {
                currentEventType = line.slice(7);
                continue;
              }
              if (!line.startsWith('data: ')) continue;

              var eventData;
              try { eventData = JSON.parse(line.slice(6)); } catch(e) { continue; }

              if (!currentEventType) continue;

              if (currentEventType === 'content') {
                if (!assistantDiv) {
                  if (typingEl.parentNode) typingEl.remove();
                  assistantDiv = document.createElement('div');
                  assistantDiv.className = 'chat-msg chat-msg-assistant';
                  messagesDiv.appendChild(assistantDiv);
                }
                assistantContent += eventData.delta || '';
                assistantDiv.textContent = assistantContent;
                messagesDiv.scrollTop = messagesDiv.scrollHeight;
              }

              if (currentEventType === 'tool_call_start') {
                if (typingEl.parentNode) {
                  typingEl.textContent = 'Using ' + (eventData.name || 'tool') + '... ';
                  typingEl.appendChild(cancelBtn);
                }
              }

              if (currentEventType === 'tool_call_result') {
                var toolDiv = document.createElement('div');
                toolDiv.className = 'chat-msg-tool';
                var details = document.createElement('details');
                var summary = document.createElement('summary');
                summary.textContent = eventData.name || 'tool';
                var pre = document.createElement('pre');
                pre.textContent = (eventData.result || '').slice(0, 300);
                details.appendChild(summary);
                details.appendChild(pre);
                toolDiv.appendChild(details);
                messagesDiv.insertBefore(toolDiv, typingEl);
                messagesDiv.scrollTop = messagesDiv.scrollHeight;

                // Reset assistant div for next round
                if (assistantDiv) {
                  assistantDiv = null;
                  assistantContent = '';
                }
                if (typingEl.parentNode) {
                  typingEl.textContent = 'Thinking... ';
                  typingEl.appendChild(cancelBtn);
                }
              }

              if (currentEventType === 'error') {
                if (typingEl.parentNode) typingEl.remove();
                var errDiv = document.createElement('div');
                errDiv.className = 'chat-msg-tool';
                errDiv.style.borderColor = 'var(--crow-error,#ef4444)';
                var errSpan = document.createElement('span');
                errSpan.style.color = 'var(--crow-error,#ef4444)';
                errSpan.textContent = 'Error: ' + (eventData.message || 'Unknown error');
                errDiv.appendChild(errSpan);
                messagesDiv.appendChild(errDiv);
                messagesDiv.scrollTop = messagesDiv.scrollHeight;
              }

              if (currentEventType === 'done') {
                if (typingEl.parentNode) typingEl.remove();
              }

              currentEventType = null;
            }
          }

          // Clean up typing indicator
          if (typingEl.parentNode) typingEl.remove();

        } catch(e) {
          if (typingEl.parentNode) typingEl.remove();
          var errDiv2 = document.createElement('div');
          errDiv2.className = 'chat-msg-tool';
          errDiv2.style.borderColor = 'var(--crow-error,#ef4444)';
          var errSpan2 = document.createElement('span');
          errSpan2.style.color = 'var(--crow-error,#ef4444)';
          errSpan2.textContent = 'Connection error: ' + e.message;
          errDiv2.appendChild(errSpan2);
          messagesDiv.appendChild(errDiv2);
        }

        _sending = false;
        var sendBtnEl = document.getElementById('chat-send');
        if (sendBtnEl) sendBtnEl.disabled = false;
        loadConversations(); // refresh sidebar
      }

      async function cancelGeneration() {
        if (!_activeConvId) return;
        try {
          await fetch('/api/chat/conversations/' + encodeURIComponent(_activeConvId) + '/cancel', { method: 'POST' });
        } catch(e) { console.error(e); }
      }

      async function deleteConversation(id) {
        if (!confirm('Delete this conversation?')) return;
        try {
          await fetch('/api/chat/conversations/' + encodeURIComponent(id), { method: 'DELETE' });
          if (_activeConvId === id) {
            _activeConvId = null;
            var mainEl = document.getElementById('chat-main');
            mainEl.textContent = '';
            var emptyDiv = document.createElement('div');
            emptyDiv.className = 'chat-empty';
            var innerDiv = document.createElement('div');
            var h3 = document.createElement('h3');
            h3.textContent = 'Start a conversation';
            var p = document.createElement('p');
            p.textContent = 'Click "New Chat" or select an existing conversation.';
            innerDiv.appendChild(h3);
            innerDiv.appendChild(p);
            emptyDiv.appendChild(innerDiv);
            mainEl.appendChild(emptyDiv);
          }
          loadConversations();
        } catch(e) { console.error(e); }
      }
      ` : ""}
      <\/script>
    `;

    return layout({ title: "Messages", content });
  },
};
