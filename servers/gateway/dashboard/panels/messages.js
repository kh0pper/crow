/**
 * Messages Panel — AI Chat + Peer Messages (Nostr)
 *
 * Two-tab layout:
 * - AI Chat: conversations with AI providers (BYOAI), tool calling, streaming
 * - Peer Messages: existing Nostr P2P messaging (unchanged)
 *
 * Security: All user-visible text is escaped via escapeH() before DOM insertion.
 * Chat content from AI providers is treated as untrusted and escaped.
 * innerHTML is only used for static server-rendered HTML from trusted sources
 * (the server-side layout) and for escaped content via escapeH().
 */

import { escapeHtml, statCard, statGrid, dataTable, section, formatDate, badge } from "../shared/components.js";
import { ICON_SHARING } from "../shared/empty-state-icons.js";

export default {
  id: "messages",
  name: "Messages",
  icon: "messages",
  route: "/dashboard/messages",
  navOrder: 10,

  async handler(req, res, { db, layout }) {
    // Check if AI provider is configured
    let aiConfigured = false;
    try {
      const { getProviderConfig } = await import("../../ai/provider.js");
      aiConfigured = !!getProviderConfig();
    } catch {}

    // Peer message stats
    const totalResult = await db.execute("SELECT COUNT(*) as c FROM messages");
    const unreadResult = await db.execute("SELECT COUNT(*) as c FROM messages WHERE is_read = 0 AND direction = 'received'");
    const contactsResult = await db.execute("SELECT COUNT(*) as c FROM contacts WHERE is_blocked = 0");

    const total = totalResult.rows[0]?.c || 0;
    const unread = unreadResult.rows[0]?.c || 0;
    const contacts = contactsResult.rows[0]?.c || 0;

    // Chat conversation count
    let chatCount = 0;
    try {
      const chatResult = await db.execute("SELECT COUNT(*) as c FROM chat_conversations");
      chatCount = chatResult.rows[0]?.c || 0;
    } catch {}

    // Peer messages data
    const messages = await db.execute({
      sql: `SELECT m.id, m.content, m.direction, m.is_read, m.created_at, m.thread_id,
                   c.display_name, c.crow_id
            FROM messages m
            LEFT JOIN contacts c ON m.contact_id = c.id
            ORDER BY m.created_at DESC LIMIT 50`,
      args: [],
    });

    // Build peer messages table
    let peerMessageList;
    if (messages.rows.length === 0) {
      peerMessageList = `<div class="empty-state">
        <div style="margin-bottom:1rem">${ICON_SHARING}</div>
        <h3>Your inbox is empty</h3>
        <p>Messages from friends and shared items will appear here.</p>
      </div>`;
    } else {
      const rows = messages.rows.map((m) => {
        const dir = m.direction === "sent" ? "\u2192" : "\u2190";
        const readBadge = m.direction === "received" && !m.is_read ? badge("new", "published") : "";
        const name = escapeHtml(m.display_name || m.crow_id || "Unknown");
        const content = escapeHtml((m.content || "").slice(0, 100));
        return [
          `<span class="mono">${dir}</span> ${name} ${readBadge}`,
          content,
          `<span class="mono">${formatDate(m.created_at)}</span>`,
        ];
      });
      peerMessageList = dataTable(["Contact", "Message", "Date"], rows);
    }

    // Default to AI Chat tab if provider is configured
    const defaultTab = aiConfigured ? "ai-chat" : "peer";

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

        @media (max-width: 768px) {
          .chat-sidebar { width:200px; }
          .chat-msg { max-width:90%; }
        }
        @media (max-width: 600px) {
          .chat-layout { flex-direction:column; height:auto; }
          .chat-sidebar { width:100%; max-height:200px; border-right:none; border-bottom:1px solid var(--crow-border); }
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
          statCard("Contacts", contacts, { delay: 100 }),
        ])}
        ${section("Recent Messages", peerMessageList, { delay: 150 })}
      </div>

      <script>
      // Escape all untrusted text before DOM insertion to prevent XSS
      function escapeH(s) {
        if (!s) return '';
        var d = document.createElement('div');
        d.textContent = s;
        return d.innerHTML;
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
