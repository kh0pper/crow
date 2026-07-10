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

  function msgShowCreateGroupDialog() {
    document.querySelectorAll('.msg-invite-dialog').forEach(function (d) { d.classList.remove('visible'); });
    var dialog = document.getElementById('invite-group');
    if (dialog) dialog.classList.toggle('visible');
    var pop = document.getElementById('msg-popover'); if (pop) pop.classList.remove('visible');
  }

  function msgOpenBotDirectory() {
    var m = document.getElementById('bot-dir-modal');
    if (m) m.classList.add('visible');
    var pop = document.getElementById('msg-popover');
    if (pop) pop.classList.remove('visible');
  }
  function msgCloseBotDirectory() {
    var m = document.getElementById('bot-dir-modal');
    if (m) m.classList.remove('visible');
  }
  document.addEventListener('input', function (e) {
    if (!e.target || !e.target.hasAttribute('data-bot-directory-search')) return;
    var q = e.target.value.toLowerCase();
    document.querySelectorAll('.bot-dir-row').forEach(function (row) {
      var hay = row.getAttribute('data-bot-search') || '';
      row.style.display = hay.indexOf(q) === -1 ? 'none' : '';
    });
  });

  if (!window.__msgOpenHookBound) {
    window.__msgOpenHookBound = true;
    var params = new URLSearchParams(window.location.search);
    var openId = params.get('open');
    if (openId && /^\d+$/.test(openId)) {
      setTimeout(function () { try { msgSelectItem('peer', parseInt(openId, 10)); } catch (e) {} }, 0);
    }
    var openRoom = params.get('openRoom');
    if (openRoom && /^\d+$/.test(openRoom)) {
      setTimeout(function () { try { msgSelectRoom(parseInt(openRoom, 10)); } catch (e) {} }, 0);
    }
    if (params.get('connected') === '1') {
      // COUPLING NOTE (R2-M2): this lives inside the window-level
      // __msgOpenHookBound once-guard, which only re-arms on a full page load.
      // It works for every accept because the accept forms are
      // data-turbo="false" (Task 1) → the 303 lands as a real page load. If
      // those forms are ever re-Turbo'd, the second accept's toast silently
      // breaks — keep the two together.
      setTimeout(function () {
        try { if (window.crowToast) window.crowToast('${tJs("messages.connectedToast", lang)}'); } catch (e) {}
      }, 200);
      // Strip the one-shot params so a refresh/Turbo revisit doesn't re-toast.
      try {
        params.delete('connected');
        var qs = params.toString();
        window.history.replaceState({}, '', window.location.pathname + (qs ? '?' + qs : ''));
      } catch (e) {}
    }
  }

  // Close popover on outside click — attach once per document lifetime so
  // Turbo re-entries don't stack listeners. Lookups are by ID, so the
  // listener works against whichever popover is currently mounted.
  if (!window.__msgOutsideClickBound) {
    window.__msgOutsideClickBound = true;
    document.addEventListener('click', function(e) {
      var pop = document.getElementById('msg-popover');
      var btn = document.querySelector('.msg-strip-new');
      if (pop && !pop.contains(e.target) && btn && !btn.contains(e.target)) {
        pop.classList.remove('visible');
      }
    });
  }

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

  // Rooms (multi-party). groupId is numeric; _activeItem.id holds the groupId.
  function msgSelectRoom(groupId) {
    var gid = String(groupId);
    if (_activeItem && _activeItem.type === 'room' && String(_activeItem.id) === gid) return;
    _activeItem = { type: 'room', id: gid };
    _replyingTo = null;
    _pendingAttachments = [];

    document.querySelectorAll('.msg-avatar-item').forEach(function(item) {
      var match = item.dataset.type === 'room' && String(item.dataset.id) === gid;
      item.classList.toggle('active', match);
    });

    var pop = document.getElementById('msg-popover'); if (pop) pop.classList.remove('visible');
    loadRoomConversation(gid);
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

      // Show profile/model picker popover with Profile + Quick Chat tabs
      var popover = document.getElementById('msg-popover');
      popover.textContent = '';
      popover.classList.add('visible');

      var title = el('div', { css: 'font-size:0.85rem;font-weight:600;padding:0.5rem 0.75rem;color:var(--crow-text-muted)' }, ['${tJs("messages.newAiChat", lang)}']);
      popover.appendChild(title);

      // --- Tab bar ---
      var tabs = el('div', { css: 'display:flex;gap:0.25rem;padding:0 0.75rem;border-bottom:1px solid var(--crow-border);margin-bottom:0.5rem' });
      var tabProfile = el('button', { className: 'msg-new-tab msg-new-tab-active', text: 'Profile', css: 'background:none;border:none;padding:0.4rem 0.75rem;color:var(--crow-text-primary);font-weight:600;border-bottom:2px solid var(--crow-accent);cursor:pointer;margin-bottom:-1px' });
      var tabQuick = el('button', { className: 'msg-new-tab', text: 'Quick chat', css: 'background:none;border:none;padding:0.4rem 0.75rem;color:var(--crow-text-secondary);border-bottom:2px solid transparent;cursor:pointer;margin-bottom:-1px' });
      tabs.appendChild(tabProfile);
      tabs.appendChild(tabQuick);
      popover.appendChild(tabs);

      // --- Profile pane ---
      var profilePane = el('div', { css: 'padding:0' });
      var profileSelect = el('select', { className: 'msg-model-select', css: 'margin:0 0.75rem 0.5rem;width:calc(100% - 1.5rem)' });
      profiles.forEach(function(p) {
        profileSelect.appendChild(el('option', { value: p.id, text: p.name }));
      });
      profilePane.appendChild(profileSelect);

      var modelSelect = el('select', { className: 'msg-model-select', css: 'margin:0 0.75rem 0.5rem;width:calc(100% - 1.5rem)' });
      function updateModels() {
        modelSelect.textContent = '';
        var pid = profileSelect.value;
        var p = profiles.find(function(x){return x.id===pid});
        // kind:"auto" profiles don't pick a model up front — smart-router
        // chooses per-message. Show a single non-selectable placeholder so
        // the picker doesn't look broken, and disable the dropdown.
        if (p && p.kind === 'auto') {
          var placeholder = el('option', { value: '', text: '— auto-routed per message —' });
          placeholder.selected = true;
          modelSelect.appendChild(placeholder);
          modelSelect.disabled = true;
          return;
        }
        modelSelect.disabled = false;
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
      profilePane.appendChild(modelSelect);

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
      profilePane.appendChild(createBtn);
      popover.appendChild(profilePane);

      // --- Quick Chat pane (hidden initially) ---
      var quickPane = el('div', { css: 'padding:0;display:none' });
      var quickProviderSelect = el('select', { className: 'msg-model-select', css: 'margin:0 0.75rem 0.5rem;width:calc(100% - 1.5rem)' });
      var quickModelSelect = el('select', { className: 'msg-model-select', css: 'margin:0 0.75rem 0.5rem;width:calc(100% - 1.5rem)' });
      var quickSystemPrompt = el('textarea', { className: 'msg-system-prompt', placeholder: 'System prompt (optional)', css: 'margin:0 0.75rem 0.5rem;width:calc(100% - 1.5rem);min-height:60px;padding:0.35rem 0.5rem;background:var(--crow-bg-surface);border:1px solid var(--crow-border);border-radius:4px;color:var(--crow-text-primary);font-size:0.82rem;resize:vertical;box-sizing:border-box' });
      var quickLoading = el('div', { css: 'padding:0.5rem 0.75rem;font-size:0.8rem;color:var(--crow-text-muted)', text: 'Loading providers…' });
      quickPane.appendChild(quickLoading);

      var registryProviders = null;
      async function loadRegistryProviders() {
        if (registryProviders) return registryProviders;
        var r = await fetch('/api/chat/registry-providers');
        var data = await r.json();
        registryProviders = data.providers || [];
        return registryProviders;
      }

      function updateQuickModels() {
        quickModelSelect.textContent = '';
        var pid = quickProviderSelect.value;
        var p = (registryProviders || []).find(function(x){return x.id===pid});
        if (p && p.models && p.models.length) {
          p.models.forEach(function(m) { quickModelSelect.appendChild(el('option', { value: m, text: m })); });
        } else {
          quickModelSelect.appendChild(el('option', { value: '', text: '(no declared models — type below)' }));
        }
      }

      async function buildQuickPane() {
        var list = await loadRegistryProviders();
        if (quickLoading.parentNode) quickLoading.remove();
        if (list.length === 0) {
          var empty = el('div', { css: 'padding:0.5rem 0.75rem;font-size:0.82rem;color:var(--crow-text-muted)', text: 'No providers registered. Add one on the LLM settings page first.' });
          quickPane.appendChild(empty);
          return;
        }
        quickProviderSelect.textContent = '';
        list.forEach(function(p) {
          var label = p.id + (p.provider_type ? ' · ' + p.provider_type : '') + (p.host === 'cloud' ? ' (cloud)' : '');
          quickProviderSelect.appendChild(el('option', { value: p.id, text: label }));
        });
        quickProviderSelect.addEventListener('change', updateQuickModels);
        updateQuickModels();
        quickPane.appendChild(quickProviderSelect);
        quickPane.appendChild(quickModelSelect);
        quickPane.appendChild(quickSystemPrompt);

        var startBtn = el('button', { className: 'msg-popover-item', css: 'text-align:center;font-weight:600;color:var(--crow-accent)', text: 'Start Quick Chat', onclick: async function() {
          popover.classList.remove('visible');
          var body = {
            title: '${tJs("messages.newConversationTitle", lang)}',
            provider: quickProviderSelect.value,
            model: quickModelSelect.value,
          };
          if (quickSystemPrompt.value && quickSystemPrompt.value.trim()) body.system_prompt = quickSystemPrompt.value.trim();
          var r = await fetch('/api/chat/conversations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          var data = await r.json();
          if (data.id) window.location.href = '/dashboard/messages';
        }});
        quickPane.appendChild(startBtn);
      }
      popover.appendChild(quickPane);

      // Tab switching
      tabProfile.addEventListener('click', function() {
        tabProfile.classList.add('msg-new-tab-active');
        tabProfile.style.color = 'var(--crow-text-primary)';
        tabProfile.style.fontWeight = '600';
        tabProfile.style.borderBottomColor = 'var(--crow-accent)';
        tabQuick.classList.remove('msg-new-tab-active');
        tabQuick.style.color = 'var(--crow-text-secondary)';
        tabQuick.style.fontWeight = 'normal';
        tabQuick.style.borderBottomColor = 'transparent';
        profilePane.style.display = 'block';
        quickPane.style.display = 'none';
      });
      tabQuick.addEventListener('click', function() {
        tabQuick.classList.add('msg-new-tab-active');
        tabQuick.style.color = 'var(--crow-text-primary)';
        tabQuick.style.fontWeight = '600';
        tabQuick.style.borderBottomColor = 'var(--crow-accent)';
        tabProfile.classList.remove('msg-new-tab-active');
        tabProfile.style.color = 'var(--crow-text-secondary)';
        tabProfile.style.fontWeight = 'normal';
        tabProfile.style.borderBottomColor = 'transparent';
        profilePane.style.display = 'none';
        quickPane.style.display = 'block';
        buildQuickPane().catch(function(e) { console.error('quickPane load failed:', e); });
      });

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

      // Get model list from profile (if profile-based) OR from the
      // providers registry (Quick Chat — conv.provider is a provider id).
      var models = [];
      var currentModel = conv.model || '';
      if (conv.profile_id) {
        var pdata = await getProfiles();
        var profile = (pdata.profiles || []).find(function(p){return p.id === conv.profile_id});
        if (profile && profile.models) models = profile.models;
      } else if (conv.provider) {
        try {
          var rp = await fetch('/api/chat/registry-providers');
          var rpd = await rp.json();
          var reg = (rpd.providers || []).find(function(p){return p.id === conv.provider});
          if (reg && reg.models && reg.models.length) models = reg.models;
        } catch(e) { /* fallback: no compose picker */ }
      }

      renderChatUI(chat, {
        name: conv.title || 'Chat',
        meta: (conv.provider || '') + (conv.model ? ' / ' + conv.model : ''),
        type: 'ai',
        id: id,
        models: models,
        currentModel: currentModel,
      }, msgs);

      // Expose current model so the compose-bar picker can detect overrides.
      if (_activeItem && _activeItem.type === 'ai') _activeItem.currentModel = currentModel;

      showAiInfo(conv);
    } catch(e) { console.error('Failed to load AI conversation:', e); }
  }

  async function sendAiMessage() {
    if (_sending || !_activeItem || _activeItem.type !== 'ai') return;
    var textarea = document.getElementById('msg-input');
    var content = (textarea.value || '').trim();
    if (!content && _pendingAttachments.length === 0) return;

    _sending = true;
    textarea.value = '';
    textarea.style.height = 'auto';
    document.getElementById('msg-send-btn').disabled = true;

    var viewport = document.getElementById('msg-viewport');
    var atts = _pendingAttachments.slice();
    _pendingAttachments = [];
    renderAttachmentPreview();

    // Add user message bubble
    appendBubble(viewport, { role: 'user', content: content || '(attachment)', attachments: atts.length > 0 ? atts : null });
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
    var pendingRoute = null; // Path C routing info from SSE smart_route event

    try {
      // Compose-bar model picker (Path A): one-shot override by default;
      // Pin checkbox promotes to sticky via PATCH before the POST.
      var composeModelEl = document.getElementById('msg-compose-model');
      var composePinEl = document.getElementById('msg-compose-pin');
      var msgBody = { content: content || '(see attached file)', attachments: atts.length > 0 ? atts : undefined };
      if (composeModelEl && composeModelEl.value && composeModelEl.value !== _activeItem.currentModel) {
        if (composePinEl && composePinEl.checked) {
          // Sticky: PATCH conversation first.
          try {
            await fetch('/api/chat/conversations/' + encodeURIComponent(_activeItem.id), {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: composeModelEl.value }),
            });
            _activeItem.currentModel = composeModelEl.value;
          } catch(e) { console.warn('Pin PATCH failed:', e); }
        } else {
          msgBody.model = composeModelEl.value;
        }
      }
      var response = await fetch('/api/chat/conversations/' + encodeURIComponent(_activeItem.id) + '/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(msgBody),
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

          if (currentEventType === 'smart_route') {
            // Path C: show a small pill at the top of the incoming
            // assistant bubble indicating which model was routed-to and
            // why. assistantDiv may not exist yet — stash on a local
            // var and attach at bubble creation.
            pendingRoute = {
              provider_id: eventData.provider_id || null,
              model_id: eventData.model_id || null,
              reason: eventData.reason || null,
            };
          }

          if (currentEventType === 'content') {
            if (!assistantDiv) {
              if (typing.parentNode) typing.remove();
              assistantDiv = el('div', { className: 'msg-bubble received' });
              // Attach routing badge BEFORE streaming content begins so
              // the user sees the route decision immediately.
              if (pendingRoute && (pendingRoute.model_id || pendingRoute.reason)) {
                var liveBadge = el('div', { className: 'msg-route-badge', css: 'display:inline-flex;align-items:center;gap:4px;margin-bottom:0.25rem;padding:2px 8px;background:var(--crow-accent-muted);color:var(--crow-accent);border-radius:var(--crow-radius-pill,8px);font-size:0.68rem;font-family:\\'JetBrains Mono\\',monospace;letter-spacing:0.02em' });
                liveBadge.textContent = (pendingRoute.model_id || '') + (pendingRoute.reason ? ' · ' + pendingRoute.reason : '');
                assistantDiv.appendChild(liveBadge);
              }
              viewport.appendChild(assistantDiv);
            }
            assistantContent += eventData.delta || '';
            // Preserve the badge at the top — replace only the text node.
            var prefixBadge = assistantDiv.firstChild && assistantDiv.firstChild.className === 'msg-route-badge' ? assistantDiv.firstChild : null;
            assistantDiv.innerHTML = '';
            if (prefixBadge) assistantDiv.appendChild(prefixBadge);
            var bodyDiv = document.createElement('span');
            bodyDiv.innerHTML = renderMd(assistantContent);
            assistantDiv.appendChild(bodyDiv);
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
        verified: contact.verified,
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
    if (!content && _pendingAttachments.length === 0) return;

    _sending = true;
    textarea.value = '';
    textarea.style.height = 'auto';
    document.getElementById('msg-send-btn').disabled = true;

    var viewport = document.getElementById('msg-viewport');
    var atts = _pendingAttachments.slice();
    _pendingAttachments = [];
    renderAttachmentPreview();

    // Optimistic UI — keep a ref so we can mark it failed if the send doesn't land.
    var sentBubble = appendBubble(viewport, {
      direction: 'sent',
      content: content || '',
      created_at: new Date().toISOString(),
      attachments: atts.length > 0 ? atts : null,
    });
    viewport.scrollTop = viewport.scrollHeight;

    try {
      var response = await fetch('/api/messages/peer/' + encodeURIComponent(_activeItem.id) + '/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: content || '(attachment)',
          attachments: atts.length > 0 ? atts : undefined,
        }),
      });
      // A 0-relay send returns a non-ok response (or {ok:false}); surface it on
      // the just-sent bubble instead of leaving a misleading success bubble.
      var body = null;
      try { body = await response.json(); } catch(_) { /* non-JSON body */ }
      if (!response.ok || (body && body.ok === false)) {
        // F-UI-7: stamp the failed row id so Retry targets the exact row.
        if (body && body.id) sentBubble.dataset.msgId = body.id;
        markBubbleFailed(sentBubble, body && body.error, { id: body && body.id, content: content });
      } else if (body && body.id) {
        // F-UI-5: reconcile the optimistic bubble with the real row.
        var existing = document.querySelector('.msg-bubble[data-msg-id="' + body.id + '"]');
        if (existing && existing !== sentBubble) {
          // A racing poll/live fetch already rendered the real row.
          sentBubble.remove();
        } else {
          sentBubble.dataset.msgId = body.id;
          _messages.push({
            id: body.id,
            direction: 'sent',
            content: content || '',
            created_at: new Date().toISOString(),
            delivery_status: body.delivery_status || 'relayed',
            nostr_event_id: body.nostr_event_id || null,
          });
          // Send-time tick (F-UI-6): show ✓ immediately; crow-receipt flips ✓✓.
          if (!sentBubble.querySelector('.msg-delivery')) {
            sentBubble.appendChild(el('span', {
              className: 'msg-delivery',
              title: '${tJs("messages.deliveryRelayed", lang)}',
              text: '\\u2713',
            }));
          }
        }
      }
    } catch(e) {
      console.error('Failed to send peer message:', e);
      markBubbleFailed(sentBubble);
    }

    _replyingTo = null;
    hideReplyBar();
    _sending = false;
    var sendBtn = document.getElementById('msg-send-btn');
    if (sendBtn) sendBtn.disabled = false;
  }

  // === Rooms (multi-party) ===
  async function loadRoomConversation(groupId) {
    var chat = document.getElementById('msg-chat');
    chat.textContent = '';
    try {
      var r = await fetch('/api/messages/room/' + encodeURIComponent(groupId));
      var data = await r.json();
      var room = data.room;
      var msgs = data.messages || [];
      _messages = msgs;
      if (!room) {
        chat.appendChild(el('div', { className: 'msg-empty' }, [
          el('div', {}, [el('h3', { text: 'Room not found' })])
        ]));
        return;
      }
      _activeItem = { type: 'room', id: String(groupId), room: room, members: data.members || [] };
      renderChatUI(chat, {
        type: 'room',
        id: String(groupId),
        name: room.name || 'Room',
        room: room,
        members: data.members || [],
      }, msgs);
    } catch(e) { console.error('Failed to load room conversation:', e); }
  }

  async function sendRoomMessage() {
    if (_sending || !_activeItem || _activeItem.type !== 'room') return;
    var input = document.getElementById('msg-input');
    var text = (input.value || '').trim();
    if (!text) return;
    input.value = '';
    input.style.height = 'auto';

    _sending = true;
    document.getElementById('msg-send-btn').disabled = true;

    try {
      await fetch('/api/messages/room/' + encodeURIComponent(_activeItem.id) + '/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text }),
      });
    } catch(e) { console.error('Failed to send room message:', e); }

    _sending = false;
    var sendBtn = document.getElementById('msg-send-btn');
    if (sendBtn) sendBtn.disabled = false;

    loadRoomConversation(_activeItem.id);
  }

  // --- Room settings affordances ---
  async function roomSetMode(groupId, mode) {
    try {
      await fetch('/api/messages/room/' + encodeURIComponent(groupId) + '/mode', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: mode }),
      });
    } catch(e) { console.error('roomSetMode failed:', e); }
    loadRoomConversation(groupId);
  }
  async function roomRename(groupId) {
    var name = prompt('${tJs("messages.roomRename", lang)}');
    if (!name || !name.trim()) return;
    try {
      await fetch('/api/messages/room/' + encodeURIComponent(groupId) + '/rename', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() }),
      });
    } catch(e) { console.error('roomRename failed:', e); }
    loadRoomConversation(groupId);
  }
  async function roomDelete(groupId) {
    if (!confirm('${tJs("messages.roomDelete", lang)}?')) return;
    try {
      await fetch('/api/messages/room/' + encodeURIComponent(groupId), { method: 'DELETE' });
    } catch(e) { console.error('roomDelete failed:', e); }
    _activeItem = null;
    window.location.href = '/dashboard/messages';
  }
  async function roomRemoveMember(groupId, contactId) {
    try {
      await fetch('/api/messages/room/' + encodeURIComponent(groupId) + '/members/' + encodeURIComponent(contactId), { method: 'DELETE' });
    } catch(e) { console.error('roomRemoveMember failed:', e); }
    loadRoomConversation(groupId);
  }
  async function roomAddMember(groupId, contactId) {
    if (!contactId) return;
    try {
      await fetch('/api/messages/room/' + encodeURIComponent(groupId) + '/members', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contact_id: contactId }),
      });
    } catch(e) { console.error('roomAddMember failed:', e); }
    loadRoomConversation(groupId);
  }
  async function roomAddBot(groupId, botId) {
    if (!botId || !String(botId).trim()) return;
    try {
      await fetch('/api/messages/room/' + encodeURIComponent(groupId) + '/members', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bot_id: String(botId).trim() }),
      });
    } catch(e) { console.error('roomAddBot failed:', e); }
    loadRoomConversation(groupId);
  }

  // Contact roster (people + bots) embedded server-side for the add-member
  // picker — no extra fetch. Returns [{ id, display_name, crow_id, is_bot }].
  function msgContactRoster() {
    try {
      var node = document.getElementById('msg-contacts-data');
      if (!node) return [];
      var arr = JSON.parse(node.textContent || '[]');
      return Array.isArray(arr) ? arr : [];
    } catch(e) { return []; }
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

    if (headerData.verified) {
      header.appendChild(el('span', { className: 'verified-badge', text: '✓', title: '${tJs("contacts.verifiedBadgeTitle", lang)}' }));
    }

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

    if (headerData.type === 'room') {
      var gid = headerData.id;
      var room = headerData.room || {};
      var members = headerData.members || [];

      // Bot-reply mode selector
      var modeSel = el('select', { className: 'msg-model-select', title: '${tJs("messages.roomMode", lang)}', onchange: function() {
        roomSetMode(gid, this.value);
      }});
      var optA = el('option', { value: 'addressed', text: '${tJs("messages.roomModeAddressed", lang)}' });
      var optB = el('option', { value: 'always', text: '${tJs("messages.roomModeAlways", lang)}' });
      if ((room.mode || 'addressed') === 'always') optB.selected = true; else optA.selected = true;
      modeSel.appendChild(optA);
      modeSel.appendChild(optB);
      header.appendChild(modeSel);

      // Member chips with remove (×)
      var memberWrap = el('div', { css: 'display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin:0 0.4rem' });
      for (var mi = 0; mi < members.length; mi++) {
        (function(mem) {
          var chip = el('span', { className: 'msg-room-chip' });
          if (Number(mem.is_bot)) chip.appendChild(el('span', { className: 'msg-bot-badge', text: 'bot', css: 'margin-right:3px' }));
          chip.appendChild(document.createTextNode(mem.display_name || (mem.crow_id || '').substring(0, 10)));
          chip.appendChild(el('button', {
            css: 'background:none;border:none;color:var(--crow-text-muted);cursor:pointer;margin-left:3px;padding:0;font-size:0.8rem',
            text: '\\u00d7',
            onclick: function() { roomRemoveMember(gid, mem.id); },
          }));
          memberWrap.appendChild(chip);
        })(members[mi]);
      }
      header.appendChild(memberWrap);

      // Add-member picker: contacts (people + bots) NOT already in the room.
      // Choosing one POSTs { contact_id }. Members already present are excluded
      // by id via headerData.members.
      var memberIds = {};
      for (var xi = 0; xi < members.length; xi++) { memberIds[String(members[xi].id)] = true; }
      var roster = msgContactRoster().filter(function(c) { return !memberIds[String(c.id)]; });
      var addSel = el('select', { className: 'msg-model-select', title: '${tJs("messages.roomAddMember", lang)}', css: 'max-width:160px' });
      addSel.appendChild(el('option', { value: '', text: '${tJs("messages.roomAddMember", lang)}' }));
      roster.forEach(function(c) {
        var label = (Number(c.is_bot) ? 'bot · ' : '') + (c.display_name || (c.crow_id || '').substring(0, 10));
        addSel.appendChild(el('option', { value: String(c.id), text: label }));
      });
      addSel.addEventListener('change', function() {
        var v = this.value;
        this.selectedIndex = 0;
        if (v) roomAddMember(gid, parseInt(v, 10));
      });
      header.appendChild(addSel);

      // Add a LOCAL bot by id (materialized into an is_bot contact server-side).
      header.appendChild(el('button', {
        className: 'msg-info-toggle',
        text: '+ bot',
        title: '${tJs("messages.roomAddBotPrompt", lang)}',
        onclick: function() {
          var botId = prompt('${tJs("messages.roomAddBotPrompt", lang)}');
          if (botId && botId.trim()) roomAddBot(gid, botId.trim());
        },
      }));

      header.appendChild(el('button', { className: 'msg-info-toggle', text: '${tJs("messages.roomRename", lang)}', onclick: function() { roomRename(gid); } }));
      header.appendChild(el('button', {
        className: 'msg-info-toggle',
        css: 'color:var(--crow-error)',
        text: '${tJs("messages.roomDelete", lang)}',
        onclick: function() { roomDelete(gid); },
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

    // Attachment preview strip
    var attPreview = el('div', { className: 'msg-attachment-preview', id: 'msg-att-preview' });
    container.appendChild(attPreview);

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

    // Per-message model picker (Path A compose-bar) — one-shot by default;
    // "Pin" toggle fires the existing PATCH to make the selection sticky.
    // Appears only on AI conversations where the conversation advertises
    // a model list (profile-based, or Quick Chat with a declared models list).
    if (headerData.type === 'ai' && headerData.models && headerData.models.length > 0) {
      var composeWrap = el('div', { css: 'display:flex;align-items:center;gap:0.35rem;margin-right:0.4rem' });
      var composeSelect = el('select', { className: 'msg-model-select', id: 'msg-compose-model', css: 'max-width:160px' });
      headerData.models.forEach(function(m) {
        var opt = el('option', { text: m, value: m });
        if (m === headerData.currentModel) opt.selected = true;
        composeSelect.appendChild(opt);
      });
      composeWrap.appendChild(composeSelect);

      var pinLabel = el('label', { css: 'display:flex;align-items:center;gap:0.2rem;font-size:0.72rem;color:var(--crow-text-muted);cursor:pointer;user-select:none', title: 'Pin the selected model to this conversation (sticky)' });
      var pinCheck = el('input', { type: 'checkbox', id: 'msg-compose-pin', css: 'margin:0;cursor:pointer' });
      pinLabel.appendChild(pinCheck);
      pinLabel.appendChild(document.createTextNode('Pin'));
      composeWrap.appendChild(pinLabel);

      inputArea.appendChild(composeWrap);
    }

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
    else if (_activeItem.type === 'peer') sendPeerMessage();
    else if (_activeItem.type === 'room') sendRoomMessage();
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

    // Room messages carry a per-sender label (and bot badge for bot authors).
    if (_activeItem && _activeItem.type === 'room') {
      var senderName = msg.sender_name || msg.sender_label || (isSent ? '${tJs("messages.you", lang)}' : '${tJs("messages.them", lang)}');
      var senderLine = el('div', { className: 'msg-bubble-sender' });
      if (msg.author_kind === 'bot' || Number(msg.sender_is_bot)) {
        senderLine.appendChild(el('span', { className: 'msg-bot-badge', text: 'bot', css: 'margin-right:4px' }));
      }
      senderLine.appendChild(document.createTextNode(senderName));
      div.appendChild(senderLine);
    }

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
        // Routing badge (Path C): small pill showing which model answered
        // and why. msg.model_id comes from chat_messages.model_id;
        // msg._route_reason is transiently set on freshly-sent messages
        // from the SSE smart_route event (not persisted).
        if (msg.model_id || msg._route_reason) {
          var badge = el('div', { className: 'msg-route-badge', css: 'display:inline-flex;align-items:center;gap:4px;margin-bottom:0.25rem;padding:2px 8px;background:var(--crow-accent-muted);color:var(--crow-accent);border-radius:var(--crow-radius-pill,8px);font-size:0.68rem;font-family:\\'JetBrains Mono\\',monospace;letter-spacing:0.02em' });
          badge.textContent = (msg.model_id || '') + (msg._route_reason ? ' · ' + msg._route_reason : '');
          div.appendChild(badge);
        }
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

    // Delivery status indicator (sent messages only) — persisted delivery_status
    // read back on THREAD RELOAD (R2 Task 4). Task 3's markBubbleFailed already
    // surfaces a live send-time failure; reuse it here for consistency ('failed'
    // gets the same 'msg-bubble-failed' class + note). 'relayed'/'delivered' get a
    // small muted check; 'pending'/null render nothing.
    if (isSent && msg.delivery_status === 'failed') {
      markBubbleFailed(div, null, { id: msg.id, content: msg.content });
    } else if (isSent && (msg.delivery_status === 'relayed' || msg.delivery_status === 'delivered')) {
      div.appendChild(el('span', {
        className: 'msg-delivery' + (msg.delivery_status === 'delivered' ? ' delivered' : ''),
        title: msg.delivery_status === 'delivered' ? '${tJs("messages.deliveryDelivered", lang)}' : '${tJs("messages.deliveryRelayed", lang)}',
        text: msg.delivery_status === 'delivered' ? '\\u2713\\u2713' : '\\u2713',
      }));
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
    return div;
  }

  // Mark a 'sent' bubble as failed-to-deliver, with a Retry control (F-UI-7).
  // retryCtx = { id, content } when known (send-time from the POST body /
  // reload-time from the row). Classes replace the old inline styles (F-UI-6).
  function markBubbleFailed(bubble, errText, retryCtx) {
    try {
      var b = bubble;
      if (!b) {
        var vp = document.getElementById('msg-viewport');
        b = vp && vp.lastElementChild;
      }
      if (!b) return;
      b.classList.add('msg-bubble-failed');
      if (!b.querySelector('.msg-bubble-failed-note')) {
        b.appendChild(el('div', {
          className: 'msg-bubble-failed-note',
          css: 'color:var(--crow-error,#ef4444);font-size:0.7rem;margin-top:2px;',
          text: '! ${tJs("messages.notDelivered", lang)}' + (errText ? ' — ' + errText : ''),
        }));
      }
      var ctx = retryCtx || {};
      if (ctx.content) {
        // Chainable retry target (supersede-on-failure): store the ctx ON the
        // bubble and read it at CLICK time. A failed resend re-stamps
        // _retryCtx.id to the NEW failed row the server wrote (the server
        // deletes the old one when retry_of names it); el() binds handlers via
        // addEventListener, so the existing button's handler can't be swapped
        // in place — the click-time read retargets it instead.
        b._retryCtx = { id: ctx.id, content: ctx.content };
        if (!b.querySelector('.msg-retry-btn')) {
          b.appendChild(el('button', {
            className: 'msg-retry-btn',
            text: '${tJs("messages.retry", lang)}',
            onclick: function () { var c = b._retryCtx || {}; retryFailedMessage(b, c.content, c.id); },
          }));
        }
      }
    } catch (e) { /* never let feedback crash the send path */ }
  }

  // Re-enter the send path for a failed message (F-UI-7). retry_of tells the
  // server to delete the old failed row once the resend lands.
  // NOTE (R1-M2, deliberate): retry re-sends TEXT only. This is consistent
  // with current behavior — failed sends never persist attachments
  // (peer-messages.js stores them only on success) and the send path never
  // transmits thread_id — so there is nothing to lose. Do not "fix" this here.
  async function retryFailedMessage(bubble, content, failedId) {
    if (!_activeItem || _activeItem.type !== 'peer') return;
    var btn = bubble.querySelector('.msg-retry-btn');
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    try {
      var response = await fetch('/api/messages/peer/' + encodeURIComponent(_activeItem.id) + '/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: content, retry_of: failedId != null ? String(failedId) : undefined }),
      });
      var body = null;
      try { body = await response.json(); } catch (_) {}
      if (response.ok && body && body.ok !== false) {
        // Swap the failed bubble to a fresh sent state in place.
        bubble.classList.remove('msg-bubble-failed');
        var note = bubble.querySelector('.msg-bubble-failed-note'); if (note) note.remove();
        var rbtn = bubble.querySelector('.msg-retry-btn'); if (rbtn) rbtn.remove();
        if (body.id) {
          bubble.dataset.msgId = body.id;
          _messages.push({ id: body.id, direction: 'sent', content: content, created_at: new Date().toISOString(), delivery_status: body.delivery_status || 'relayed' });
        }
        if (!bubble.querySelector('.msg-delivery')) {
          bubble.appendChild(el('span', { className: 'msg-delivery', title: '${tJs("messages.deliveryRelayed", lang)}', text: '\\u2713' }));
        }
      } else {
        // Supersede-on-failure: the server may have written a NEW failed row
        // for this attempt (and, given retry_of, deleted the old one) — the
        // 502 body.id is then guaranteed to be THIS attempt's row. Re-stamp
        // so the next Retry click names the live row, not a deleted one.
        if (body && body.id != null) {
          bubble.dataset.msgId = body.id;
          failedId = body.id;
        }
        if (btn) { btn.disabled = false; btn.textContent = '${tJs("messages.retry", lang)}'; }
        markBubbleFailed(bubble, body && body.error, { id: failedId, content: content });
      }
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = '${tJs("messages.retry", lang)}'; }
    }
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
  function renderAttachmentPreview() {
    var strip = document.getElementById('msg-att-preview');
    if (!strip) return;
    strip.textContent = '';
    if (_pendingAttachments.length === 0) {
      strip.classList.remove('visible');
      return;
    }
    strip.classList.add('visible');
    for (var i = 0; i < _pendingAttachments.length; i++) {
      (function(idx) {
        var att = _pendingAttachments[idx];
        var item = el('div', { className: 'msg-attachment-preview-item' });

        if (att.mime_type && att.mime_type.startsWith('image/')) {
          item.appendChild(el('img', { src: '/storage/file/' + encodeURIComponent(att.s3_key), alt: att.name }));
        }

        item.appendChild(el('span', { className: 'att-name', text: att.name || 'file' }));
        item.appendChild(el('span', { className: 'att-size', text: formatBytes(att.size) }));

        var removeBtn = el('button', { className: 'msg-attachment-preview-remove', text: '\\u00d7', onclick: function() {
          _pendingAttachments.splice(idx, 1);
          renderAttachmentPreview();
        }});
        item.appendChild(removeBtn);
        strip.appendChild(item);
      })(i);
    }
  }

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
          renderAttachmentPreview();
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
        // _csrf body fallback: a dynamically built form bypasses Turbo's
        // header hook unless submitted via requestSubmit; carry the
        // double-submit token either way (cookie value is hex — no decode).
        var csrfEl = document.createElement('input');
        csrfEl.type = 'hidden';
        csrfEl.name = '_csrf';
        var csrfM = document.cookie.match(/(?:^|;\\s*)crow_csrf=([^;]*)/);
        csrfEl.value = csrfM ? csrfM[1] : '';
        form.appendChild(csrfEl);
        document.body.appendChild(form);
        if (form.requestSubmit) form.requestSubmit(); else form.submit();
      },
    }));
  }

  // === Live updates (F-UI-4) ===
  // Incremental fetch shared by the SSE nudge and the fallback poll. Dedup is
  // id-keyed against the DOM so an optimistic bubble (stamped in
  // sendPeerMessage) or a racing poll/live append can never double-render
  // (F-UI-5).
  async function fetchNewPeerMessages() {
    if (!_activeItem || _activeItem.type !== 'peer') return;
    // Empty conversation (first message — the walkthrough's exact repro): fetch
    // the initial window (no afterId) and APPEND into the already-rendered
    // empty viewport. Do NOT reload the full conversation/chat UI here — that
    // rebuilds the whole chat UI including the composer and would wipe an
    // in-progress draft (R2-C1: accept lands the user in an empty
    // conversation to type their first message; a nudge/poll must not eat it).
    var lastId = _messages.length > 0 ? _messages[_messages.length - 1].id : 0;
    if (_messages.length > 0 && !lastId) return;
    try {
      var nr = await fetch('/api/messages/peer/' + encodeURIComponent(_activeItem.id) + (lastId ? '?afterId=' + lastId : ''));
      var nd = await nr.json();
      if (!nd.messages || nd.messages.length === 0) return;
      var viewport = document.getElementById('msg-viewport');
      if (!viewport) return;
      for (var j = 0; j < nd.messages.length; j++) {
        var m = nd.messages[j];
        // R1-I3: two guards, in this order. (1) _messages guard: concurrent
        // fetches (nudge racing poll) both read the same lastId — skip a row
        // another fetch already accounted for, WITHOUT pushing a duplicate
        // object (thread-reply lookups scan _messages). (2) DOM guard: the
        // optimistic send path may have stamped the bubble before its
        // _messages push lands — account for the row but don't re-render.
        if (m.id && _messages.some(function (x) { return x.id === m.id; })) continue;
        _messages.push(m);
        if (m.id && viewport.querySelector('.msg-bubble[data-msg-id="' + m.id + '"]')) continue; // already rendered
        appendBubble(viewport, m);
        if (m.direction === 'received') {
          fetch('/api/messages/peer/' + m.id + '/read', { method: 'POST' }).catch(function(){});
        }
      }
      viewport.scrollTop = viewport.scrollHeight;
    } catch (e) { /* incremental fetch error — poll/SSE will retry */ }
  }

  function flipBubbleDelivered(id) {
    try {
      var b = document.querySelector('.msg-bubble[data-msg-id="' + Number(id) + '"]');
      if (!b) return;
      var tick = b.querySelector('.msg-delivery');
      if (!tick) {
        tick = el('span', { className: 'msg-delivery' });
        b.appendChild(tick);
      }
      tick.textContent = '\\u2713\\u2713';
      tick.classList.add('delivered');
      tick.title = '${tJs("messages.deliveryDelivered", lang)}';
    } catch (e) {}
  }

  function startMessagesStream() {
    if (window.__crowMsgStream) { try { window.__crowMsgStream.close(); } catch (e) {} window.__crowMsgStream = null; }
    try {
      var es = new EventSource('/dashboard/streams/messages');
      window.__crowMsgStream = es;
      es.addEventListener('crow-msg', function (evt) {
        try {
          var data = JSON.parse(evt.data);
          if (_activeItem && _activeItem.type === 'peer' && Number(data.contactId) === Number(_activeItem.id)) {
            fetchNewPeerMessages();
          }
        } catch (e) {}
      });
      es.addEventListener('crow-receipt', function (evt) {
        try {
          var data = JSON.parse(evt.data);
          if (!(_activeItem && _activeItem.type === 'peer' && Number(data.contactId) === Number(_activeItem.id))) return;
          (data.ids || []).forEach(flipBubbleDelivered);
        } catch (e) {}
      });
      es.addEventListener('session-expired', function () {
        try { es.close(); } catch (e) {}
        window.__crowMsgStream = null;
        // Next poll re-auths via the usual cookie path (player.js pattern).
      });
      es.onerror = function () { /* EventSource auto-reconnects; swallow. */ };
    } catch (e) { /* no EventSource — the fallback poll covers us */ }
  }

  // === Polling for Real-Time Updates ===
  function startPolling() {
    // Under Turbo, this script re-runs on every nav into Messages. Clear
    // any prior poll tracked on window, then start fresh and track the
    // new handle so the next re-entry (or navigation away) can clear it.
    //
    // Live badge updates come via <turbo-stream-source
    // src="/dashboard/streams/messages">; this 5-min poll is a
    // fallback-only safety net for transient SSE drops. Pre-Streams
    // it was 7s — dropping to 300s is safe given the live path.
    if (window.__msgPollInterval) {
      clearInterval(window.__msgPollInterval);
      window.__msgPollInterval = null;
    }
    _pollInterval = setInterval(pollStatus, 300000);
    window.__msgPollInterval = _pollInterval;
    startMessagesStream();
  }

  function stopPolling() {
    if (_pollInterval) { clearInterval(_pollInterval); _pollInterval = null; }
    if (window.__msgPollInterval) { clearInterval(window.__msgPollInterval); window.__msgPollInterval = null; }
    if (window.__crowMsgStream) { try { window.__crowMsgStream.close(); } catch (e) {} window.__crowMsgStream = null; }
  }

  async function pollStatus() {
    // Self-cancel if the Messages panel DOM has been swapped out — the
    // avatar strip is the root anchor and disappears when Turbo renders
    // a different panel.
    if (!document.querySelector('.msg-avatar-strip, [data-badge-peer]') &&
        !document.getElementById('msg-popover')) {
      stopPolling();
      return;
    }
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
      await fetchNewPeerMessages();
    } catch(e) { /* polling error — ignore */ }
  }

  // Start polling. beforeunload does not fire on Turbo in-document nav,
  // so cleanup happens via the next re-entry's startPolling() call +
  // pollStatus's self-cancel when the panel DOM is gone.
  startPolling();
  <\/script>`;
}
