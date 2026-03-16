/**
 * Messages Panel — Client-Side JavaScript
 *
 * Handles both AI chat (SSE streaming) and peer messaging (REST + polling).
 * Two loading modes: loadAiConversation(id) and loadPeerConversation(contactId).
 * Security: all untrusted text escaped via escapeH() or textContent before DOM insertion.
 * No innerHTML usage — all DOM construction uses safe methods.
 */

/**
 * @param {object} opts
 * @param {boolean} opts.aiConfigured
 * @param {boolean} opts.storageAvailable
 * @returns {string} — <script> block
 */
import { tJs } from "../../shared/i18n.js";

export function messagesClientJS(opts) {
  const { aiConfigured, storageAvailable, lang } = opts;

  return `<script>
  // === Utility ===
  function escapeH(s) {
    if (!s) return '';
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // Lightweight markdown → safe HTML (escapes first via escapeH, then applies formatting)
  function renderMd(text) {
    if (!text) return '';
    var s = escapeH(text);
    var BT = '\\x60'; // backtick (escaped for template literal)
    // Code blocks
    s = s.replace(new RegExp(BT+BT+BT+'(\\\\w*)\\\\n([\\\\s\\\\S]*?)'+BT+BT+BT, 'g'), function(_, lang, code) {
      return '<pre style="background:var(--crow-bg-deep,#111);padding:0.5rem;border-radius:4px;overflow-x:auto;font-size:0.85rem;margin:0.5rem 0"><code>' + code.trim() + '</code></pre>';
    });
    // Inline code
    s = s.replace(new RegExp(BT+'([^'+BT+']+)'+BT, 'g'), '<code style="background:var(--crow-bg-deep,#111);padding:1px 4px;border-radius:3px;font-size:0.9em">$1</code>');
    // Headers
    s = s.replace(/^### (.+)$/gm, '<strong style="font-size:1rem;display:block;margin:0.75rem 0 0.25rem">$1</strong>');
    s = s.replace(/^## (.+)$/gm, '<strong style="font-size:1.05rem;display:block;margin:0.75rem 0 0.25rem">$1</strong>');
    s = s.replace(/^# (.+)$/gm, '<strong style="font-size:1.1rem;display:block;margin:0.75rem 0 0.25rem">$1</strong>');
    // Bold + italic
    s = s.replace(/\\*\\*\\*(.+?)\\*\\*\\*/g, '<strong><em>$1</em></strong>');
    s = s.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
    s = s.replace(/\\*(.+?)\\*/g, '<em>$1</em>');
    // Horizontal rule
    s = s.replace(/^---$/gm, '<hr style="border:none;border-top:1px solid var(--crow-border);margin:0.75rem 0">');
    // Unordered lists
    s = s.replace(/^- (.+)$/gm, '<li style="margin-left:1.2rem;list-style:disc">$1</li>');
    // Ordered lists
    s = s.replace(/^\\d+\\. (.+)$/gm, '<li style="margin-left:1.2rem;list-style:decimal">$1</li>');
    // Line breaks
    s = s.replace(/\\n\\n/g, '<br><br>');
    s = s.replace(/\\n/g, '<br>');
    return s;
  }

  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (k === 'text') e.textContent = attrs[k];
        else if (k === 'css') e.style.cssText = attrs[k];
        else if (k === 'className') e.className = attrs[k];
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), attrs[k]);
        else e.setAttribute(k, attrs[k]);
      }
    }
    if (children) {
      for (var i = 0; i < children.length; i++) {
        if (typeof children[i] === 'string') e.appendChild(document.createTextNode(children[i]));
        else if (children[i]) e.appendChild(children[i]);
      }
    }
    return e;
  }

  function formatBytes(b) {
    if (!b) return '0 B';
    var u = ['B','KB','MB','GB'];
    var i = Math.floor(Math.log(b) / Math.log(1024));
    return (b / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + u[i];
  }

  function relativeTime(dateStr) {
    if (!dateStr) return '';
    var d = new Date(dateStr);
    var diff = Date.now() - d.getTime();
    if (diff < 60000) return '${tJs("time.justNow", lang)}';
    if (diff < 3600000) return Math.floor(diff / 60000) + '${tJs("time.mAgo", lang)}';
    if (diff < 86400000) return Math.floor(diff / 3600000) + '${tJs("time.hAgo", lang)}';
    return d.toLocaleDateString();
  }

  // === State ===
  var _activeItem = null; // { type: 'ai'|'peer', id: number }
  var _sending = false;
  var _replyingTo = null; // { id, content, senderName }
  var _pendingAttachments = []; // [{ s3_key, name, mime_type, size }]
  var _pollInterval = null;
  var _messages = []; // loaded messages cache for threading lookups

  // === Popover ===
  function msgTogglePopover() {
    var pop = document.getElementById('msg-popover');
    pop.classList.toggle('visible');
    // Hide invite dialogs when toggling
    document.querySelectorAll('.msg-invite-dialog').forEach(function(d) { d.classList.remove('visible'); });
  }

  function msgShowInviteDialog(type) {
    document.querySelectorAll('.msg-invite-dialog').forEach(function(d) { d.classList.remove('visible'); });
    var dialog = document.getElementById('invite-' + type);
    if (dialog) dialog.classList.toggle('visible');
  }

  // Close popover on outside click
  document.addEventListener('click', function(e) {
    var pop = document.getElementById('msg-popover');
    var btn = document.querySelector('.msg-strip-new');
    if (pop && !pop.contains(e.target) && btn && !btn.contains(e.target)) {
      pop.classList.remove('visible');
    }
  });

  // === Avatar Strip Selection ===
  function msgSelectItem(type, id) {
    if (_activeItem && _activeItem.type === type && _activeItem.id === id) return;
    _activeItem = { type: type, id: id };
    _replyingTo = null;
    _pendingAttachments = [];

    // Highlight avatar
    document.querySelectorAll('.msg-avatar-item').forEach(function(item) {
      var match = item.dataset.type === type && parseInt(item.dataset.id) === id;
      item.classList.toggle('active', match);
    });

    // Close popover
    document.getElementById('msg-popover').classList.remove('visible');

    if (type === 'ai') {
      loadAiConversation(id);
    } else {
      loadPeerConversation(id);
    }
  }

  // === AI Chat ===
  ${aiConfigured ? `
  var _profilesCache = null;

  async function getProfiles() {
    if (_profilesCache) return _profilesCache;
    try {
      var r = await fetch('/api/chat/profiles');
      _profilesCache = await r.json();
    } catch(e) { _profilesCache = { profiles: [], envConfig: null }; }
    return _profilesCache;
  }

  async function msgNewAiChat() {
    try {
      var pdata = await getProfiles();
      var profiles = pdata.profiles || [];

      if (profiles.length === 0) {
        // No profiles — use env config (original behavior)
        var r = await fetch('/api/chat/conversations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: '${tJs("messages.newConversationTitle", lang)}' }),
        });
        var data = await r.json();
        if (data.id) window.location.href = '/dashboard/messages';
        return;
      }

      // Show profile/model picker popover
      var popover = document.getElementById('msg-popover');
      popover.textContent = '';
      popover.classList.add('visible');

      var title = el('div', { css: 'font-size:0.85rem;font-weight:600;padding:0.5rem 0.75rem;color:var(--crow-text-muted)' }, ['${tJs("messages.newAiChat", lang)}']);
      popover.appendChild(title);

      var profileSelect = el('select', { className: 'msg-model-select', css: 'margin:0 0.75rem 0.5rem;width:calc(100% - 1.5rem)' });
      profiles.forEach(function(p) {
        profileSelect.appendChild(el('option', { value: p.id, text: p.name }));
      });
      popover.appendChild(profileSelect);

      var modelSelect = el('select', { className: 'msg-model-select', css: 'margin:0 0.75rem 0.5rem;width:calc(100% - 1.5rem)' });
      function updateModels() {
        modelSelect.textContent = '';
        var pid = profileSelect.value;
        var p = profiles.find(function(x){return x.id===pid});
        if (p && p.models) {
          p.models.forEach(function(m) {
            var opt = el('option', { value: m, text: m });
            if (m === p.defaultModel) opt.selected = true;
            modelSelect.appendChild(opt);
          });
        }
      }
      profileSelect.addEventListener('change', updateModels);
      updateModels();
      popover.appendChild(modelSelect);

      var createBtn = el('button', { className: 'msg-popover-item', css: 'text-align:center;font-weight:600;color:var(--crow-accent)', text: '${tJs("messages.createChat", lang)}', onclick: async function() {
        popover.classList.remove('visible');
        var r = await fetch('/api/chat/conversations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: '${tJs("messages.newConversationTitle", lang)}', profile_id: profileSelect.value, model: modelSelect.value }),
        });
        var data = await r.json();
        if (data.id) window.location.href = '/dashboard/messages';
      }});
      popover.appendChild(createBtn);

    } catch(e) { console.error(e); }
  }

  async function loadAiConversation(id) {
    var chat = document.getElementById('msg-chat');
    chat.textContent = '';

    try {
      var r = await fetch('/api/chat/conversations/' + encodeURIComponent(id));
      var data = await r.json();
      var conv = data.conversation;
      var msgs = data.messages || [];
      _messages = msgs;

      // Get model list from profile (if profile-based conversation)
      var models = [];
      var currentModel = conv.model || '';
      if (conv.profile_id) {
        var pdata = await getProfiles();
        var profile = (pdata.profiles || []).find(function(p){return p.id === conv.profile_id});
        if (profile && profile.models) models = profile.models;
      }

      renderChatUI(chat, {
        name: conv.title || 'Chat',
        meta: (conv.provider || '') + (conv.model ? ' / ' + conv.model : ''),
        type: 'ai',
        id: id,
        models: models,
        currentModel: currentModel,
      }, msgs);

      showAiInfo(conv);
    } catch(e) { console.error('Failed to load AI conversation:', e); }
  }

  async function sendAiMessage() {
    if (_sending || !_activeItem || _activeItem.type !== 'ai') return;
    var textarea = document.getElementById('msg-input');
    var content = (textarea.value || '').trim();
    if (!content) return;

    _sending = true;
    textarea.value = '';
    textarea.style.height = 'auto';
    document.getElementById('msg-send-btn').disabled = true;

    var viewport = document.getElementById('msg-viewport');

    // Add user message bubble
    appendBubble(viewport, { role: 'user', content: content });
    viewport.scrollTop = viewport.scrollHeight;

    // Typing indicator
    var typing = el('div', { className: 'msg-typing', text: '${tJs("messages.thinking", lang)} ' });
    var cancelBtn = el('button', { className: 'msg-cancel-btn', text: '${tJs("common.cancel", lang)}', onclick: function() {
      fetch('/api/chat/conversations/' + encodeURIComponent(_activeItem.id) + '/cancel', { method: 'POST' });
    }});
    typing.appendChild(cancelBtn);
    viewport.appendChild(typing);
    viewport.scrollTop = viewport.scrollHeight;

    var assistantDiv = null;
    var assistantContent = '';
    var currentEventType = null;

    try {
      var response = await fetch('/api/chat/conversations/' + encodeURIComponent(_activeItem.id) + '/messages', {
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

          if (line.startsWith('event: ')) { currentEventType = line.slice(7); continue; }
          if (!line.startsWith('data: ')) continue;

          var eventData;
          try { eventData = JSON.parse(line.slice(6)); } catch(e) { continue; }
          if (!currentEventType) continue;

          if (currentEventType === 'content') {
            if (!assistantDiv) {
              if (typing.parentNode) typing.remove();
              assistantDiv = el('div', { className: 'msg-bubble received' });
              viewport.appendChild(assistantDiv);
            }
            assistantContent += eventData.delta || '';
            assistantDiv.innerHTML = renderMd(assistantContent);
            viewport.scrollTop = viewport.scrollHeight;
          }

          if (currentEventType === 'tool_call_start') {
            if (typing.parentNode) {
              typing.textContent = '${tJs("messages.using", lang)} ' + (eventData.name || 'tool') + '... ';
              typing.appendChild(cancelBtn);
            }
          }

          if (currentEventType === 'tool_call_result') {
            var toolDiv = el('div', { className: 'msg-bubble tool' });
            var details = document.createElement('details');
            details.appendChild(el('summary', { text: eventData.name || 'tool' }));
            details.appendChild(el('pre', { text: (eventData.result || '').slice(0, 300) }));
            toolDiv.appendChild(details);
            if (typing.parentNode) {
              viewport.insertBefore(toolDiv, typing);
            } else {
              viewport.appendChild(toolDiv);
            }
            viewport.scrollTop = viewport.scrollHeight;

            if (assistantDiv) { assistantDiv = null; assistantContent = ''; }
            if (typing.parentNode) {
              typing.textContent = '${tJs("messages.thinking", lang)} ';
              typing.appendChild(cancelBtn);
            }
          }

          if (currentEventType === 'error') {
            if (typing.parentNode) typing.remove();
            var errDiv = el('div', { className: 'msg-bubble tool', css: 'border-color:var(--crow-error,#ef4444)' });
            errDiv.textContent = '${tJs("messages.error", lang)} ' + (eventData.message || '${tJs("messages.unknown", lang)}');
            viewport.appendChild(errDiv);
          }

          if (currentEventType === 'done') {
            if (typing.parentNode) typing.remove();
          }

          currentEventType = null;
        }
      }

      if (typing.parentNode) typing.remove();
    } catch(e) {
      if (typing.parentNode) typing.remove();
      var errDiv2 = el('div', { className: 'msg-bubble tool', css: 'border-color:var(--crow-error)' });
      errDiv2.textContent = '${tJs("messages.connectionError", lang)} ' + e.message;
      viewport.appendChild(errDiv2);
    }

    _sending = false;
    var sendBtn = document.getElementById('msg-send-btn');
    if (sendBtn) sendBtn.disabled = false;
  }
  ` : `
  function msgNewAiChat() {
    alert('${tJs("messages.aiNotConfigured", lang)}');
  }
  function loadAiConversation() {}
  function sendAiMessage() {}
  `}

  // === Peer Messaging ===
  async function loadPeerConversation(contactId) {
    var chat = document.getElementById('msg-chat');
    chat.textContent = '';

    try {
      var r = await fetch('/api/messages/peer/' + encodeURIComponent(contactId));
      var data = await r.json();
      var contact = data.contact;
      var msgs = data.messages || [];
      _messages = msgs;

      if (!contact) {
        chat.appendChild(el('div', { className: 'msg-empty' }, [
          el('div', {}, [el('h3', { text: '${tJs("messages.contactNotFound", lang)}' })])
        ]));
        return;
      }

      var isOnline = contact.last_seen && (Date.now() - new Date(contact.last_seen).getTime()) < 300000;

      renderChatUI(chat, {
        name: contact.display_name || contact.crow_id.substring(0, 16) + '...',
        meta: relativeTime(contact.last_seen),
        type: 'peer',
        id: contactId,
        isOnline: isOnline,
      }, msgs);

      showPeerInfo(contact);

      // Mark received messages as read
      for (var i = 0; i < msgs.length; i++) {
        if (msgs[i].direction === 'received' && !msgs[i].is_read) {
          fetch('/api/messages/peer/' + msgs[i].id + '/read', { method: 'POST' }).catch(function(){});
        }
      }
    } catch(e) { console.error('Failed to load peer conversation:', e); }
  }

  async function sendPeerMessage() {
    if (_sending || !_activeItem || _activeItem.type !== 'peer') return;
    var textarea = document.getElementById('msg-input');
    var content = (textarea.value || '').trim();
    if (!content) return;

    _sending = true;
    textarea.value = '';
    textarea.style.height = 'auto';
    document.getElementById('msg-send-btn').disabled = true;

    var viewport = document.getElementById('msg-viewport');

    // Optimistic UI
    appendBubble(viewport, {
      direction: 'sent',
      content: content,
      created_at: new Date().toISOString(),
      attachments: _pendingAttachments.length > 0 ? _pendingAttachments : null,
    });
    viewport.scrollTop = viewport.scrollHeight;

    try {
      await fetch('/api/messages/peer/' + encodeURIComponent(_activeItem.id) + '/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: content,
          attachments: _pendingAttachments.length > 0 ? _pendingAttachments : undefined,
        }),
      });
    } catch(e) {
      console.error('Failed to send peer message:', e);
    }

    _pendingAttachments = [];
    _replyingTo = null;
    hideReplyBar();
    _sending = false;
    var sendBtn = document.getElementById('msg-send-btn');
    if (sendBtn) sendBtn.disabled = false;
  }

  // === Shared Chat UI Rendering ===
  function renderChatUI(container, headerData, msgs) {
    container.textContent = '';

    // Header
    var header = el('div', { className: 'msg-chat-header' });

    if (headerData.type === 'peer') {
      header.appendChild(el('span', { className: 'msg-chat-header-status ' + (headerData.isOnline ? 'online' : 'offline') }));
    }

    header.appendChild(el('div', { className: 'msg-chat-header-name', text: headerData.name }));

    // Model selector (for profile-based AI conversations) or static meta
    if (headerData.type === 'ai' && headerData.models && headerData.models.length > 0) {
      var modelSelect = el('select', { className: 'msg-model-select', onchange: function() {
        fetch('/api/chat/conversations/' + encodeURIComponent(headerData.id), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: this.value }),
        });
      }});
      headerData.models.forEach(function(m) {
        var opt = el('option', { text: m, value: m });
        if (m === headerData.currentModel) opt.selected = true;
        modelSelect.appendChild(opt);
      });
      header.appendChild(modelSelect);
    } else {
      header.appendChild(el('div', { className: 'msg-chat-header-meta', text: headerData.meta }));
    }

    header.appendChild(el('button', { className: 'msg-info-toggle', text: '${tJs("messages.info", lang)}', onclick: function() {
      document.getElementById('msg-info').classList.toggle('hidden');
    }}));

    if (headerData.type === 'ai') {
      header.appendChild(el('button', {
        className: 'msg-info-toggle',
        css: 'color:var(--crow-error)',
        text: '${tJs("messages.deleteConversation", lang)}',
        onclick: function() {
          if (confirm('${tJs("messages.deleteConfirm", lang)}')) {
            fetch('/api/chat/conversations/' + encodeURIComponent(headerData.id), { method: 'DELETE' })
              .then(function() { window.location.href = '/dashboard/messages'; });
          }
        },
      }));
    }

    container.appendChild(header);

    // Viewport
    var viewport = el('div', { className: 'msg-chat-viewport', id: 'msg-viewport' });
    for (var i = 0; i < msgs.length; i++) {
      appendBubble(viewport, msgs[i]);
    }
    container.appendChild(viewport);

    // Reply bar
    var replyBar = el('div', { className: 'msg-reply-bar', id: 'msg-reply-bar' });
    replyBar.appendChild(el('span', { className: 'msg-reply-bar-text', id: 'msg-reply-text' }));
    replyBar.appendChild(el('button', { className: 'msg-reply-bar-cancel', text: '\\u00d7', onclick: function() {
      _replyingTo = null;
      hideReplyBar();
    }}));
    container.appendChild(replyBar);

    // Input area
    var inputArea = el('div', { className: 'msg-chat-input' });

    ${storageAvailable ? `
    inputArea.appendChild(el('button', {
      className: 'msg-attach-btn',
      title: '${tJs("messages.attachFile", lang)}',
      text: '\\ud83d\\udcce',
      onclick: function() { document.getElementById('msg-file-input').click(); },
    }));
    ` : ''}

    var textarea = el('textarea', {
      className: 'msg-textarea',
      id: 'msg-input',
      placeholder: '${tJs("messages.typeMessage", lang)}',
      rows: '1',
    });
    textarea.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCurrentMessage(); }
    });
    textarea.addEventListener('input', function() {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 120) + 'px';
    });
    inputArea.appendChild(textarea);

    inputArea.appendChild(el('button', {
      className: 'msg-send-btn',
      id: 'msg-send-btn',
      text: '${tJs("messages.send", lang)}',
      onclick: sendCurrentMessage,
    }));

    container.appendChild(inputArea);

    // Scroll to bottom
    viewport.scrollTop = viewport.scrollHeight;
  }

  function sendCurrentMessage() {
    if (!_activeItem) return;
    if (_activeItem.type === 'ai') sendAiMessage();
    else sendPeerMessage();
  }

  // === Message Bubble Rendering ===
  function appendBubble(container, msg) {
    var isSent = msg.direction === 'sent' || msg.role === 'user';
    var isTool = msg.role === 'tool';

    if (isTool) {
      var toolBubble = el('div', { className: 'msg-bubble tool' });
      var details = document.createElement('details');
      details.appendChild(el('summary', { text: msg.tool_name || 'tool' }));
      details.appendChild(el('pre', { text: (msg.content || '').slice(0, 300) }));
      toolBubble.appendChild(details);
      container.appendChild(toolBubble);
      return;
    }

    var div = el('div', { className: 'msg-bubble ' + (isSent ? 'sent' : 'received') });
    var msgId = msg.id || msg.nostr_event_id || null;
    if (msgId) div.dataset.msgId = msgId;

    // Reply preview (thread)
    var threadId = msg.thread_id;
    if (threadId) {
      var parent = _messages.find(function(m) { return m.id == threadId || m.nostr_event_id == threadId; });
      if (parent) {
        var preview = el('div', { className: 'msg-bubble-reply-preview' });
        var parentSender = (parent.direction === 'sent' || parent.role === 'user') ? '${tJs("messages.you", lang)}' : (parent.display_name || '${tJs("messages.them", lang)}');
        preview.appendChild(el('strong', { text: parentSender }));
        preview.appendChild(document.createTextNode(' '));
        var parentText = (parent.content || '').substring(0, 60);
        if ((parent.content || '').length > 60) parentText += '...';
        preview.appendChild(el('span', { text: parentText }));
        div.appendChild(preview);
      }
    }

    // Content (render markdown for assistant messages, plain text for user)
    if (msg.content) {
      if (!isSent && msg.role === 'assistant') {
        var contentSpan = document.createElement('span');
        contentSpan.innerHTML = renderMd(msg.content);
        div.appendChild(contentSpan);
      } else {
        div.appendChild(el('span', { text: msg.content }));
      }
    }

    // Attachments
    var attachments = msg.attachments;
    if (attachments && Array.isArray(attachments)) {
      for (var a = 0; a < attachments.length; a++) {
        var att = attachments[a];
        var attDiv = el('div', { className: 'msg-attachment' });

        if (att.mime_type && att.mime_type.startsWith('image/')) {
          var img = el('img', {
            src: '/storage/file/' + encodeURIComponent(att.s3_key),
            alt: att.name || 'Image',
            loading: 'lazy',
          });
          img.addEventListener('click', function() { window.open(this.src, '_blank'); });
          attDiv.appendChild(img);
        } else if (att.mime_type && att.mime_type.startsWith('audio/')) {
          var audio = el('audio', { controls: 'true', src: '/storage/file/' + encodeURIComponent(att.s3_key) });
          attDiv.appendChild(audio);
        } else {
          var card = el('div', { className: 'msg-attachment-card' });
          card.appendChild(el('a', { href: '/storage/file/' + encodeURIComponent(att.s3_key), target: '_blank', text: att.name || '${tJs("messages.file", lang)}' }));
          card.appendChild(el('span', { className: 'msg-attachment-size', text: formatBytes(att.size) }));
          attDiv.appendChild(card);
        }

        div.appendChild(attDiv);
      }
    }

    // Timestamp
    if (msg.created_at) {
      div.appendChild(el('div', { className: 'msg-bubble-meta', text: relativeTime(msg.created_at) }));
    }

    // Reply button (received peer messages)
    if (!isSent && msgId && _activeItem && _activeItem.type === 'peer') {
      div.appendChild(el('button', {
        css: 'background:none;border:none;color:var(--crow-text-muted);cursor:pointer;font-size:0.7rem;margin-top:2px;padding:0;',
        text: '${tJs("messages.reply", lang)}',
        onclick: (function(m) {
          return function() {
            _replyingTo = { id: m.id || m.nostr_event_id, content: m.content, senderName: m.display_name || '${tJs("messages.them", lang)}' };
            showReplyBar();
          };
        })(msg),
      }));
    }

    container.appendChild(div);
  }

  // === Reply Bar ===
  function showReplyBar() {
    if (!_replyingTo) return;
    var bar = document.getElementById('msg-reply-bar');
    var text = document.getElementById('msg-reply-text');
    if (bar && text) {
      text.textContent = '${tJs("messages.replyingTo", lang)} ' + _replyingTo.senderName + ': ' + (_replyingTo.content || '').substring(0, 60);
      bar.classList.add('visible');
    }
  }
  function hideReplyBar() {
    var bar = document.getElementById('msg-reply-bar');
    if (bar) bar.classList.remove('visible');
  }

  // === File Attachment ===
  ${storageAvailable ? `
  document.getElementById('msg-file-input').addEventListener('change', async function(e) {
    var files = e.target.files;
    if (!files || files.length === 0) return;

    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      var formData = new FormData();
      formData.append('file', file);
      formData.append('reference_type', 'message');

      try {
        var r = await fetch('/storage/upload', { method: 'POST', body: formData });
        var data = await r.json();
        if (data.key) {
          _pendingAttachments.push({
            s3_key: data.key,
            name: file.name,
            mime_type: file.type,
            size: file.size,
          });
          var input = document.getElementById('msg-input');
          if (input) input.placeholder = _pendingAttachments.length + ' file(s). ${tJs("messages.typeMessage", lang)}';
        }
      } catch(err) { console.error('Upload failed:', err); }
    }
    e.target.value = '';
  });
  ` : ''}

  // === Info Panel ===
  function showAiInfo(conv) {
    var infoPanel = document.getElementById('msg-info');
    infoPanel.classList.remove('hidden');

    // Profile
    var profile = document.getElementById('msg-info-profile');
    profile.textContent = '';
    var avatar = el('div', { className: 'msg-info-avatar', css: 'background:linear-gradient(135deg,#6366f1,#8b5cf6)' });
    avatar.textContent = (conv.provider || 'AI').substring(0, 2).toUpperCase();
    profile.appendChild(avatar);
    profile.appendChild(el('div', { className: 'msg-info-name', text: conv.title || 'Chat' }));
    profile.appendChild(el('div', { className: 'msg-info-id', text: (conv.provider || '') + (conv.model ? ' / ' + conv.model : '') }));

    // Details
    var details = document.getElementById('msg-info-details');
    details.textContent = '';
    var sec = el('div', { className: 'msg-info-section' });
    sec.appendChild(el('div', { className: 'msg-info-section-title', text: '${tJs("messages.details", lang)}' }));
    sec.appendChild(el('div', { className: 'msg-info-row', text: '${tJs("messages.created", lang)} ' + new Date(conv.created_at).toLocaleDateString() }));
    sec.appendChild(el('div', { className: 'msg-info-row', text: '${tJs("messages.tokens", lang)} ' + String(conv.total_tokens || 0) }));
    details.appendChild(sec);

    // Actions
    var actions = document.getElementById('msg-info-actions');
    actions.textContent = '';
    actions.appendChild(el('button', {
      className: 'msg-info-action-btn danger',
      text: '${tJs("messages.deleteConversationAction", lang)}',
      onclick: function() {
        if (confirm('${tJs("messages.deleteConfirm", lang)}')) {
          fetch('/api/chat/conversations/' + encodeURIComponent(conv.id), { method: 'DELETE' })
            .then(function() { window.location.href = '/dashboard/messages'; });
        }
      },
    }));
  }

  function showPeerInfo(contact) {
    var infoPanel = document.getElementById('msg-info');
    infoPanel.classList.remove('hidden');

    var profile = document.getElementById('msg-info-profile');
    profile.textContent = '';
    var colors = ['#6366f1','#8b5cf6','#ec4899','#f59e0b','#10b981','#06b6d4','#f43f5e','#84cc16','#d946ef','#0ea5e9'];
    var color = colors[(contact.id || 0) % colors.length];

    var avatar = el('div', { className: 'msg-info-avatar', css: 'background:' + color });
    var displayName = contact.display_name || contact.crow_id.substring(0, 16) + '...';
    var parts = displayName.trim().split(/\\s+/);
    avatar.textContent = parts.length >= 2 ? (parts[0][0] + parts[1][0]).toUpperCase() : displayName.substring(0, 2).toUpperCase();
    profile.appendChild(avatar);
    profile.appendChild(el('div', { className: 'msg-info-name', text: displayName }));

    var idEl = el('div', { className: 'msg-info-id', text: contact.crow_id || '', title: '${tJs("messages.clickToCopy", lang)}' });
    idEl.addEventListener('click', function() {
      navigator.clipboard.writeText(contact.crow_id || '').then(function() {
        idEl.textContent = '${tJs("messages.copied", lang)}';
        setTimeout(function() { idEl.textContent = contact.crow_id || ''; }, 1500);
      });
    });
    profile.appendChild(idEl);

    // Details
    var details = document.getElementById('msg-info-details');
    details.textContent = '';

    // Status
    var isOnline = contact.last_seen && (Date.now() - new Date(contact.last_seen).getTime()) < 300000;
    var statusSec = el('div', { className: 'msg-info-section' });
    statusSec.appendChild(el('div', { className: 'msg-info-section-title', text: '${tJs("messages.status", lang)}' }));
    var statusRow = el('div', { className: 'msg-info-row' });
    statusRow.appendChild(el('span', { className: 'msg-chat-header-status ' + (isOnline ? 'online' : 'offline'), css: 'display:inline-block' }));
    statusRow.appendChild(document.createTextNode(' ' + (isOnline ? '${tJs("messages.onlineStatus", lang)}' : '${tJs("messages.lastSeen", lang)} ' + relativeTime(contact.last_seen))));
    statusSec.appendChild(statusRow);
    details.appendChild(statusSec);

    // Security
    var secSec = el('div', { className: 'msg-info-section' });
    secSec.appendChild(el('div', { className: 'msg-info-section-title', text: '${tJs("messages.security", lang)}' }));
    var encRow = el('div', { className: 'msg-info-row', css: 'color:var(--crow-success)' });
    encRow.textContent = '\\ud83d\\udd12 ${tJs("messages.e2eEncrypted", lang)}';
    secSec.appendChild(encRow);
    if (contact.ed25519_pubkey) {
      secSec.appendChild(el('div', {
        className: 'msg-info-row',
        css: 'font-family:monospace;font-size:0.65rem;color:var(--crow-text-muted);word-break:break-all',
        text: contact.ed25519_pubkey.substring(0, 32) + '...',
      }));
    }
    details.appendChild(secSec);

    // Actions
    var actions = document.getElementById('msg-info-actions');
    actions.textContent = '';

    actions.appendChild(el('button', {
      className: 'msg-info-action-btn danger',
      text: contact.is_blocked ? '${tJs("messages.unblockContact", lang)}' : '${tJs("messages.blockContact", lang)}',
      onclick: function() {
        var action = contact.is_blocked ? 'unblock' : 'block';
        if (action === 'block' && !confirm('${tJs("messages.blockConfirm", lang)}')) return;
        var form = document.createElement('form');
        form.method = 'POST';
        form.style.display = 'none';
        var actionInput = document.createElement('input');
        actionInput.name = 'action';
        actionInput.value = action;
        form.appendChild(actionInput);
        var crowIdInput = document.createElement('input');
        crowIdInput.name = 'crow_id';
        crowIdInput.value = contact.crow_id;
        form.appendChild(crowIdInput);
        document.body.appendChild(form);
        form.submit();
      },
    }));
  }

  // === Polling for Real-Time Updates ===
  function startPolling() {
    if (_pollInterval) return;
    _pollInterval = setInterval(pollStatus, 7000);
  }

  function stopPolling() {
    if (_pollInterval) { clearInterval(_pollInterval); _pollInterval = null; }
  }

  async function pollStatus() {
    try {
      var r = await fetch('/api/messages/status');
      var data = await r.json();

      // Update peer badges
      if (data.peers) {
        for (var i = 0; i < data.peers.length; i++) {
          var p = data.peers[i];
          var badge = document.querySelector('[data-badge-peer="' + p.contactId + '"]');
          if (badge) {
            if (p.unread > 0) {
              badge.textContent = p.unread;
              badge.classList.add('visible');
            } else {
              badge.classList.remove('visible');
            }
          }
        }
      }

      // If viewing an active peer conversation, fetch new messages
      if (_activeItem && _activeItem.type === 'peer' && _messages.length > 0) {
        var lastId = _messages[_messages.length - 1].id;
        if (lastId) {
          var nr = await fetch('/api/messages/peer/' + encodeURIComponent(_activeItem.id) + '?afterId=' + lastId);
          var nd = await nr.json();
          if (nd.messages && nd.messages.length > 0) {
            var viewport = document.getElementById('msg-viewport');
            if (viewport) {
              for (var j = 0; j < nd.messages.length; j++) {
                _messages.push(nd.messages[j]);
                appendBubble(viewport, nd.messages[j]);
                if (nd.messages[j].direction === 'received') {
                  fetch('/api/messages/peer/' + nd.messages[j].id + '/read', { method: 'POST' }).catch(function(){});
                }
              }
              viewport.scrollTop = viewport.scrollHeight;
            }
          }
        }
      }
    } catch(e) { /* polling error — ignore */ }
  }

  // Start polling
  startPolling();
  window.addEventListener('beforeunload', stopPolling);
  <\/script>`;
}
