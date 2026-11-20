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
  // Saved drafts (bot-door plan, PR A part 2). One open draft per conversation; these hold the one
  // the open thread is showing, the Drafts list's data, and the autosave/confirm state around them.
  var _draft = null;            // { id, version, body, origin, botName, botId } of the open draft
  var _draftRows = null;        // the Drafts list rows (parsed once from the server's JSON)
  var _draftTimer = null;       // the 800 ms autosave debounce
  var _draftPending = null;     // { kind, conversationId, text } captured when the debounce armed
  var _draftStatus = '';        // '', 'saving', 'saved', 'error'
  var _draftReceipt = '';       // one line after a send/discard (kept across the thread reload)
  var _draftChanged = false;    // the row moved under us: offer Reload, never overwrite
  var _draftSending = false;
  // A fixed sentence for a refusal the person cannot fix by reloading (a seal that does not verify, a
  // recipient's key that changed, a blocked contact). Shown in the draft bar INSTEAD of Saved/Saving.
  var _draftNotice = '';
  // The server refused this draft's seal: Send is disabled here and would be refused there anyway.
  var _draftUnverified = false;
  // Bumped whenever the thread, the draft or the message on screen is replaced (a switch, a send, a
  // discard, a reload). An autosave or create that lands afterwards carries the old number and is
  // IGNORED, so a create still in flight when Enter sent the message can never re-adopt the sent text
  // into the composer (see msgDraftSave).
  var _draftEpoch = 0;
  var _draftConfirmCtx = null;  // { draftId, version, rowEl }
  var _draftConfirmReturnFocus = null;

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
    var fireOpen = function (attempt, isDone) {
      // A full-page load (the accept redirect) races Turbo's initial-visit
      // processing: a conversation opened too early is wiped ~10ms after
      // DOMContentLoaded (found via CDP — the open call ran but the viewport
      // never survived). Timing-based fixes proved fragile, so the hook
      // verifies its own outcome: retry every 250ms (up to 12x = ~3s) until
      // the render actually stuck. isDone() must be cheap and DOM-based.
      var tries = 0;
      var tick = function () {
        tries++;
        try { attempt(); } catch (e) { /* retried below */ }
        setTimeout(function () {
          try { if (isDone()) return; } catch (e) {}
          if (tries < 12) setTimeout(tick, 250);
        }, 100);
      };
      setTimeout(tick, 0);
    };
    var openId = params.get('open');
    if (openId && /^\\d+$/.test(openId)) {
      fireOpen(
        function () {
          // a wiped render leaves stale _activeItem → reset so the retry re-renders
          if (_activeItem && !document.getElementById('msg-viewport')) _activeItem = null;
          msgSelectItem('peer', parseInt(openId, 10));
        },
        function () { return !!document.getElementById('msg-viewport'); }
      );
    }
    var openRoom = params.get('openRoom');
    if (openRoom && /^\\d+$/.test(openRoom)) {
      fireOpen(
        function () {
          // a wiped render leaves stale _activeItem → reset so the retry re-renders
          if (_activeItem && !document.getElementById('msg-viewport')) _activeItem = null;
          msgSelectRoom(parseInt(openRoom, 10));
        },
        function () { return !!document.getElementById('msg-viewport'); }
      );
    }
    var aiId = params.get('ai');
    if (aiId && /^\\d+$/.test(aiId)) {
      fireOpen(
        function () {
          // a wiped render leaves stale _activeItem → reset so the retry re-renders
          if (_activeItem && !document.getElementById('msg-viewport')) _activeItem = null;
          msgSelectItem('ai', parseInt(aiId, 10));
        },
        function () {
          // Piggyback the composer focus on the same isDone check that
          // stops the retry loop — it only fires once, right when the
          // conversation actually renders.
          var ready = !!document.getElementById('msg-viewport');
          if (ready) {
            var composer = document.getElementById('msg-input');
            if (composer) composer.focus();
          }
          return ready;
        }
      );
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

  // === Saved drafts (bot-door plan, PR A part 2) ===
  //
  // A draft is one row for one conversation. The thread's composer pre-fills from it, an autosave
  // 800 ms after the last keystroke keeps it in step, and Send/Discard end it. Every write carries
  // the version the screen was drawn from, so two views of the same draft can never overwrite each
  // other: the loser is answered 409 and shows "changed elsewhere" with a Reload button.
  //
  // The Drafts list above the hub is drawn server-side and redrawn here from the same data; the
  // live stream (/dashboard/streams/message-drafts) says only that SOMETHING about a draft changed
  // (ids and an action word), so every redraw re-reads the API. No draft text is ever written into
  // an attribute, an onclick or a URL — only into textContent and a JSON data block.
  var API_DRAFTS = '/dashboard/messages/api/drafts';
  var DRAFT_STR = {
    send: '${tJs("messages.draft.send", lang)}',
    discard: '${tJs("messages.draft.discard", lang)}',
    saved: '${tJs("messages.draft.saved", lang)}',
    saving: '${tJs("messages.draft.saving", lang)}',
    changedElsewhere: '${tJs("messages.draft.changedElsewhere", lang)}',
    reload: '${tJs("messages.draft.reload", lang)}',
    sentReceipt: '${tJs("messages.draft.sentReceipt", lang)}',
    discardedReceipt: '${tJs("messages.draft.discardedReceipt", lang)}',
    errSendFailed: '${tJs("messages.draft.errSendFailed", lang)}',
    unverified: '${tJs("messages.draft.unverified", lang)}',
    errPubkey: '${tJs("messages.draft.errPubkey", lang)}',
    errBlocked: '${tJs("messages.draft.errBlocked", lang)}',
    draftBanner: '${tJs("messages.draft.draftBanner", lang)}',
    draftsHeading: '${tJs("messages.draft.draftsHeading", lang)}',
    draftsEmpty: '${tJs("messages.draft.draftsEmpty", lang)}',
    draftBy: '${tJs("messages.draft.draftBy", lang)}',
    justNow: '${tJs("time.justNow", lang)}',
    mAgo: '${tJs("time.mAgo", lang)}',
    hAgo: '${tJs("time.hAgo", lang)}',
  };

  /** {placeholder} interpolation that inserts values verbatim (split/join, so $& and $$ stay literal). */
  function msgFmtDraft(str, params) {
    var map = params || {};
    return String(str).split(/\\{([a-zA-Z0-9_]+)\\}/).map(function (part, i) {
      if (i % 2 === 1) return Object.prototype.hasOwnProperty.call(map, part) ? String(map[part]) : '{' + part + '}';
      return part;
    }).join('');
  }

  /** The SERVER-BOUND CSRF token the drafts API needs on every unsafe method.
   *
   *  The token is HMAC(secret, session id) and the server hands the page the value it should echo
   *  (the layout's <meta name="crow-csrf">, read by window.crowCsrf()); it is never a cookie value.
   *  The crow_csrf cookie is retired and authorises nothing, so reading it is only a last-resort
   *  fallback for a page so old it has neither the helper nor a meta tag — and even then a stale
   *  value is answered 403 and the layout's fetch wrapper refreshes the token once and retries. */
  function msgDraftHeaders() {
    var token = '';
    try {
      if (typeof window.crowCsrf === 'function') token = String(window.crowCsrf() || '');
    } catch (e) { token = ''; }
    if (!token) {
      try {
        var m = document.cookie ? String(document.cookie).match(/(?:^|;\\s*)crow_csrf=([^;]*)/) : null;
        token = m ? m[1] : '';
      } catch (e) { token = ''; }
    }
    return { 'Content-Type': 'application/json', 'X-Crow-Csrf': token };
  }

  /** The name the thread's header shows: what the approved refusal sentences fill {name} with. */
  function msgDraftRecipientName() {
    return String((_activeItem && _activeItem.name) || '');
  }

  /**
   * One refusal from the drafts API, mapped to what the composer shows. Only the codes PR A's routes
   * can answer are here, and each uses the operator-approved copy:
   *
   *   - seal_invalid / seal_unavailable — the draft could not be verified (or this Crow has no usable
   *     key to verify it with): the approved "unverified" sentence, and Send is disabled for a draft
   *     that exists (the server would refuse it anyway).
   *   - pubkey_changed / blocked — the recipient is not who the draft was written for: errPubkey /
   *     errBlocked, naming the person.
   *   - changed / not_open — "This draft changed somewhere else." + Reload.
   *   - no_recipients — nobody in the conversation to seal or send to: the approved "not sent, your
   *     draft is still here" line (there is nothing to reload, and nothing was lost).
   *   - recipients_changed / conversation_gone — NO PR-A sentence of its own exists for these (PR B
   *     adds errGroupChanged and the recipient picker); the closest approved line is changedElsewhere,
   *     so that is what is shown, with Discard beside it, and Reload is not offered because re-reading
   *     the same row cannot fix either.
   *
   * Answers false for anything else (a 502, a dead network), which the caller shows as the approved
   * "not sent, your draft is still here" line.
   */
  function msgDraftApplyRefusal(out) {
    var code = out && typeof out.error === 'string' ? out.error : '';
    if (code === 'seal_invalid' || code === 'seal_unavailable') {
      // Only a draft that exists can be un-sendable: a create refused for a missing key has nothing
      // for Send to be disabled on, so that one just shows the line.
      _draftUnverified = !!_draft;
      _draftNotice = DRAFT_STR.unverified;
      _draftStatus = '';
      return true;
    }
    if (code === 'pubkey_changed') {
      _draftNotice = msgFmtDraft(DRAFT_STR.errPubkey, { name: msgDraftRecipientName() });
      _draftStatus = '';
      return true;
    }
    if (code === 'blocked') {
      _draftNotice = msgFmtDraft(DRAFT_STR.errBlocked, { name: msgDraftRecipientName() });
      _draftStatus = '';
      return true;
    }
    if (code === 'no_recipients') {
      _draftNotice = '';
      _draftStatus = 'error';
      return true;
    }
    if (code === 'recipients_changed' || code === 'conversation_gone') {
      _draftNotice = DRAFT_STR.changedElsewhere;
      _draftStatus = '';
      return true;
    }
    if (code === 'changed' || code === 'not_open') {
      _draftChanged = true;
      _draftStatus = '';
      return true;
    }
    return false;
  }

  /** 'contact' | 'room' for the open thread, or null (an AI chat holds no message draft). */
  function msgDraftActiveKind() {
    if (!_activeItem) return null;
    if (_activeItem.type === 'peer') return 'contact';
    if (_activeItem.type === 'room') return 'room';
    return null;
  }

  /** The open thread's conversation id (a contact id or a room's group id), or null. */
  function msgDraftActiveId() {
    if (!_activeItem) return null;
    var n = parseInt(String(_activeItem.id), 10);
    return isFinite(n) && n > 0 ? n : null;
  }

  /**
   * Does the OPEN THREAD'S draft hold exactly these words? A send that came from a draft leaves its
   * text in the reopened draft when the delivery fails, so that draft IS the retry path for it; the
   * failed bubble of the same message must not offer a second one (see appendBubble).
   */
  function msgDraftHoldsText(text) {
    if (!_draft) return false;
    // The draft row's own conversation id (the API's display row carries conversationId; it does not
    // carry the store's conversationKind spelling). The bubbles on screen belong to the open thread.
    if (Number(_draft.conversationId) !== msgDraftActiveId()) return false;
    return String(_draft.body == null ? '' : _draft.body).trim()
      === String(text == null ? '' : text).trim();
  }

  /** The same rule, applied to bubbles that were already drawn: a thread's messages render BEFORE its
   *  draft is read (loadPeerConversation/loadRoomConversation draw, then msgDraftLoad fetches), so a
   *  failed row whose words the draft still holds had its Retry added before the draft was known.
   *  Whenever the draft changes, that button goes away — one retry path, never two. */
  function msgDraftSettleFailedBubbles() {
    if (!_draft) return;
    var bubbles = document.querySelectorAll('.msg-bubble-failed');
    for (var i = 0; i < bubbles.length; i++) {
      var ctx = bubbles[i]._retryCtx || null;
      if (!ctx || !msgDraftHoldsText(ctx.content)) continue;
      var btn = bubbles[i].querySelector('.msg-retry-btn');
      if (btn) btn.remove();
      bubbles[i]._retryCtx = null;
    }
  }

  /** The Drafts list's rows: the server's JSON on first use, then whatever the last refresh read. */
  function msgDraftRowsData() {
    if (_draftRows) return _draftRows;
    _draftRows = [];
    try {
      var node = document.getElementById('msg-drafts-data');
      var arr = node ? JSON.parse(node.textContent || '[]') : [];
      if (arr && arr.length) _draftRows = arr;
    } catch (e) { _draftRows = []; }
    return _draftRows;
  }

  function msgDraftRowById(id) {
    var rows = msgDraftRowsData();
    for (var i = 0; i < rows.length; i++) if (rows[i] && rows[i].id === id) return rows[i];
    return null;
  }

  /** The row element a click landed in (works for the server's onclick="...this" and the redraw). */
  function msgDraftRowOf(node) {
    var n = node;
    while (n && n !== document) {
      if (n.classList && n.classList.contains && n.classList.contains('msg-drafts-row')) return n;
      n = n.parentNode;
    }
    return null;
  }

  /** One line of a draft's text for the list: control characters gone, cut at 80 code points. */
  function msgDraftPreview(text) {
    var s = String(text == null ? '' : text).replace(/[\\r\\n\\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
    return s.length > 80 ? s.slice(0, 80) : s;
  }

  /** The same buckets relativeTime() uses, for a draft's last change. */
  function msgDraftAgo(ms) {
    var diff = Date.now() - Number(ms || 0);
    if (!isFinite(diff) || diff < 0) return '';
    if (diff < 60000) return DRAFT_STR.justNow;
    if (diff < 3600000) return Math.floor(diff / 60000) + DRAFT_STR.mAgo;
    if (diff < 86400000) return Math.floor(diff / 3600000) + DRAFT_STR.hAgo;
    return new Date(Number(ms)).toLocaleDateString();
  }

  /** One Drafts row, built the same way the server draws it (same classes and data attributes). */
  function msgDraftRowEl(d) {
    var row = el('div', {
      className: 'msg-drafts-row',
      'data-draft-id': String(d.id || ''),
      'data-kind': String(d.kind || ''),
      'data-conversation-id': String(d.conversationId == null ? '' : d.conversationId),
    });
    var open = el('button', { type: 'button', className: 'msg-drafts-open' });
    var head = el('span', { className: 'msg-drafts-row-head' });
    head.appendChild(el('span', { className: 'msg-drafts-name', text: String(d.label || '') }));
    head.appendChild(el('span', { className: 'msg-drafts-time', text: msgDraftAgo(d.updatedAt) }));
    open.appendChild(head);
    var preview = msgDraftPreview(d.body);
    if (preview) open.appendChild(el('span', { className: 'msg-drafts-preview', text: preview }));
    if (d.origin === 'bot' && d.botName) {
      open.appendChild(el('span', { className: 'msg-drafts-by', text: msgFmtDraft(DRAFT_STR.draftBy, { bot: String(d.botName) }) }));
    }
    open.addEventListener('click', function () { msgOpenDraftRow(row); });
    row.appendChild(open);
    var actions = el('div', { className: 'msg-drafts-actions' });
    var sendBtn = el('button', { type: 'button', className: 'msg-draft-send', text: DRAFT_STR.send });
    sendBtn.addEventListener('click', function () { msgDraftRowSend(row); });
    var discardBtn = el('button', { type: 'button', className: 'msg-draft-discard', text: DRAFT_STR.discard });
    discardBtn.addEventListener('click', function () { msgDraftRowDiscard(row); });
    actions.appendChild(sendBtn);
    actions.appendChild(discardBtn);
    row.appendChild(actions);
    return row;
  }

  /** Redraw the Drafts section from the current rows: the count, the rows, the empty line. A section
   *  that was empty and now has a row opens itself (that is a draft the person just wrote); one they
   *  folded away themselves stays folded. */
  function msgRenderDraftsList() {
    var rows = msgDraftRowsData();
    var countEl = document.getElementById('msg-drafts-count');
    if (countEl) countEl.textContent = msgFmtDraft(DRAFT_STR.draftsHeading, { n: rows.length });
    var section = document.getElementById('msg-drafts');
    if (section) {
      if (rows.length && section.getAttribute('data-count') === '0') section.setAttribute('open', 'open');
      section.setAttribute('data-count', String(rows.length));
    }
    var list = document.getElementById('msg-drafts-list');
    if (!list) return;
    list.textContent = '';
    if (!rows.length) {
      list.appendChild(el('div', { className: 'msg-drafts-empty', id: 'msg-drafts-empty', text: DRAFT_STR.draftsEmpty }));
      return;
    }
    for (var i = 0; i < rows.length; i++) list.appendChild(msgDraftRowEl(rows[i]));
  }

  /** Re-read the open drafts and redraw the list. The ACTIVE draft's version and text are NOT touched
   *  here — a live frame while somebody is typing must not make a stale composer look current. The
   *  open thread is settled by msgDraftReconcile(), which compares against what the composer holds. */
  async function msgRefreshDrafts() {
    var res = null, out = null;
    try {
      res = await fetch(API_DRAFTS + '?state=open');
      try { out = await res.json(); } catch (e) { out = null; }
    } catch (e) { res = null; }
    if (!res || !res.ok || !out || !out.drafts) return;
    _draftRows = out.drafts;
    msgRenderDraftsList();
    if (!_draft) return;
    var fresh = null;
    for (var i = 0; i < _draftRows.length; i++) if (_draftRows[i] && _draftRows[i].id === _draft.id) fresh = _draftRows[i];
    if (fresh) return;
    // Gone: sent or discarded, here or in another view. The text it held is no longer a draft.
    var ta = document.getElementById('msg-input');
    if (ta && ta.value === _draft.body) ta.value = '';
    _draft = null;
    _draftStatus = '';
    _draftChanged = false;
    _draftNotice = '';
    _draftUnverified = false;
    msgRenderDraftBar();
  }

  /** Show/hide and fill the thread's draft bar: bot banner, Saving/Saved, Discard, changed line,
   *  and a refusal notice the person cannot reload their way out of (a failed seal, a changed key, a
   *  blocked contact). Send is disabled while the draft is unverified: the server would refuse it. */
  function msgRenderDraftBar() {
    var bar = document.getElementById('msg-draft-bar');
    if (!bar) return;
    // A failed bubble the open draft still holds keeps only the draft's retry (see the helper).
    msgDraftSettleFailedBubbles();
    var banner = document.getElementById('msg-draft-banner');
    if (banner) {
      if (_draft && _draft.origin === 'bot') {
        banner.textContent = msgFmtDraft(DRAFT_STR.draftBanner, { bot: String(_draft.botName || _draft.botId || '') });
        banner.classList.add('visible');
      } else {
        banner.textContent = '';
        banner.classList.remove('visible');
      }
    }
    var status = document.getElementById('msg-draft-status');
    if (status) {
      var text = '';
      var cls = 'msg-draft-status';
      if (_draftNotice) {
        text = _draftNotice;
        cls += ' error';
      } else if (!_draftChanged) {
        if (_draftStatus === 'saving') text = DRAFT_STR.saving;
        else if (_draftStatus === 'saved') { text = DRAFT_STR.saved; cls += ' saved'; }
        else if (_draftStatus === 'error') { text = DRAFT_STR.errSendFailed; cls += ' error'; }
      }
      if (!text && _draftReceipt) text = _draftReceipt;
      status.textContent = text;
      status.className = cls;
    }
    var discard = document.getElementById('msg-draft-bar-discard');
    if (discard) {
      if (_draft) discard.removeAttribute('hidden');
      else discard.setAttribute('hidden', 'hidden');
    }
    var changed = document.getElementById('msg-draft-changed');
    if (changed) {
      if (_draftChanged) changed.classList.add('visible');
      else changed.classList.remove('visible');
    }
    // Send: a draft whose seal did not verify can never be sent, so the button says so by being off.
    var sendBtn = document.getElementById('msg-send-btn');
    if (sendBtn) sendBtn.disabled = !!_draftUnverified || !!_draftSending;
    if (_draft) {
      var rows = document.querySelectorAll('.msg-drafts-row');
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].getAttribute('data-draft-id') !== _draft.id) continue;
        var rowSend = rows[i].querySelector('.msg-draft-send');
        if (rowSend) rowSend.disabled = !!_draftUnverified || !!_draftSending;
      }
    }
    var show = !!(_draft || _draftNotice || _draftReceipt || _draftChanged || _draftStatus === 'saving' ||
      _draftStatus === 'saved' || _draftStatus === 'error');
    if (show) bar.classList.add('visible');
    else bar.classList.remove('visible');
  }

  /** Leaving a conversation: keep the words being typed (flush the debounce), drop the row state. */
  function msgDraftResetForSwitch() {
    msgDraftFlushPending();
    // Anything still in flight belongs to the thread being left; the epoch makes it inert.
    _draftEpoch += 1;
    _draft = null;
    _draftStatus = '';
    _draftChanged = false;
    _draftReceipt = '';
    _draftNotice = '';
    _draftUnverified = false;
    msgRenderDraftBar();
  }

  function msgDraftClearTimer() {
    if (_draftTimer) { try { clearTimeout(_draftTimer); } catch (e) {} }
    _draftTimer = null;
    _draftPending = null;
  }

  /** Arm the 800 ms autosave for what is in the composer right now. */
  function msgDraftScheduleAutosave() {
    var kind = msgDraftActiveKind();
    if (!kind) return;
    var ta = document.getElementById('msg-input');
    if (!ta) return;
    _draftPending = { kind: kind, conversationId: msgDraftActiveId(), text: ta.value };
    if (_draftTimer) { try { clearTimeout(_draftTimer); } catch (e) {} }
    _draftTimer = setTimeout(function () {
      var p = _draftPending;
      _draftTimer = null;
      _draftPending = null;
      if (p) msgDraftSave(p.kind, p.conversationId, p.text);
    }, 800);
  }

  /** Fire the armed autosave now (a send, or leaving the conversation). */
  function msgDraftFlushPending() {
    var p = _draftPending;
    msgDraftClearTimer();
    if (!p) return Promise.resolve();
    return msgDraftSave(p.kind, p.conversationId, p.text);
  }

  /**
   * The autosave itself. Three cases, each with the one guard that makes it safe:
   *
   *   - NO DRAFT YET and something typed: create it, CREATE-ONLY (expectVersion 0). An open draft
   *     the client did not know about — another tab, the other view, a bot — answers 409 with that
   *     row, and it is ADOPTED (offering Reload when its words differ from what is here) instead of
   *     being overwritten by words typed in ignorance of it.
   *   - A DRAFT AND THE BOX CLEARED: the draft is DISCARDED, not saved as an empty body. An empty
   *     draft in the Drafts list is a row nobody can act on.
   *   - A DRAFT AND NEW WORDS: a PATCH with the version this screen was drawn from. A 409 means
   *     somebody else moved the row — that is the Reload line, never a blind retry with a fresher
   *     version.
   *
   * Every reply is checked against the draft epoch first: if the thread, the draft or the message on
   * screen changed while the request was in flight (Enter sent it, the person switched threads,
   * another view discarded it), the answer is inert — and a create that DID land is cancelled, so a
   * draft of already-sent words never reappears.
   */
  async function msgDraftSave(kind, conversationId, text) {
    var body = String(text == null ? '' : text);
    if (!kind || !isFinite(Number(conversationId))) return;
    var convId = Number(conversationId);
    var epoch = _draftEpoch;
    if (!_draft) {
      if (body.trim() === '') return;
      _draftStatus = 'saving';
      _draftNotice = '';
      msgRenderDraftBar();
      var createRes = null, createOut = null;
      try {
        createRes = await fetch(API_DRAFTS, {
          method: 'PUT',
          headers: msgDraftHeaders(),
          body: JSON.stringify({
            conversationKind: kind,
            conversationId: convId,
            body: body,
            expectVersion: 0,
          }),
        });
        try { createOut = await createRes.json(); } catch (e) { createOut = null; }
      } catch (e) { createRes = null; }
      if (epoch !== _draftEpoch) {
        if (createRes && createRes.ok && createOut && createOut.created && createOut.draft) {
          msgDraftCancelLateCreate(createOut.draft, body);
        }
        _draftStatus = '';
        msgRenderDraftBar();
        msgRefreshDrafts();
        return;
      }
      // Only adopt it for the conversation that is still on screen.
      if (msgDraftActiveKind() === kind && msgDraftActiveId() === convId) {
        if (createRes && createRes.ok && createOut && createOut.draft) {
          _draft = createOut.draft;
          _draftStatus = 'saved';
          _draftChanged = false;
          _draftNotice = '';
          _draftUnverified = false;
        } else if (createRes && createRes.status === 409 && createOut && createOut.draft) {
          // Somebody opened this conversation's draft first. Adopt theirs: the local words stay in the
          // box, and Reload is offered because they are not what the row now holds.
          _draft = createOut.draft;
          _draftNotice = '';
          _draftUnverified = false;
          var box = document.getElementById('msg-input');
          var local = box ? box.value : body;
          _draftStatus = '';
          _draftChanged = local !== String(createOut.draft.body || '');
        } else if (createRes && createRes.status === 409 && msgDraftApplyRefusal(createOut)) {
          // A refusal with its own approved sentence and no row to adopt: seal_unavailable, or a
          // conversation with nobody in it to seal (no_recipients). Never "changed elsewhere" —
          // nothing changed, and reloading would only re-read nothing.
        } else {
          _draftStatus = 'error';
        }
        msgRenderDraftBar();
      }
      msgRefreshDrafts();
      return;
    }
    if (body === _draft.body) {
      _draftStatus = '';
      msgRenderDraftBar();
      return;
    }
    var draftId = _draft.id;
    var expectVersion = Number(_draft.version) || 1;
    // Clearing the box by hand discards the draft: an empty draft is a row nobody can act on, and the
    // plan's "an empty draft is discarded when the page unloads" is only the tail of this rule.
    if (body.trim() === '') {
      _draftStatus = 'saving';
      _draftNotice = '';
      msgRenderDraftBar();
      var discardRes = null;
      try {
        discardRes = await fetch(API_DRAFTS + '/' + encodeURIComponent(draftId) + '/discard', {
          method: 'POST',
          headers: msgDraftHeaders(),
          body: JSON.stringify({ expectVersion: expectVersion }),
        });
      } catch (e) { discardRes = null; }
      if (epoch !== _draftEpoch) { _draftStatus = ''; msgRenderDraftBar(); msgRefreshDrafts(); return; }
      if (!_draft || _draft.id !== draftId) { msgRefreshDrafts(); return; }
      if (discardRes && discardRes.ok) {
        _draft = null;
        _draftStatus = '';
        _draftChanged = false;
        _draftNotice = '';
        _draftUnverified = false;
        _draftReceipt = DRAFT_STR.discardedReceipt;
        msgRenderDraftBar();
      } else if (discardRes && discardRes.status === 409) {
        var discardOut = null;
        try { discardOut = await discardRes.json(); } catch (e) { discardOut = null; }
        if (!msgDraftApplyRefusal(discardOut)) _draftChanged = true;
        msgRenderDraftBar();
      } else {
        _draftStatus = 'error';
        msgRenderDraftBar();
      }
      msgRefreshDrafts();
      return;
    }
    _draftStatus = 'saving';
    _draftNotice = '';
    msgRenderDraftBar();
    var res = null, out = null;
    try {
      res = await fetch(API_DRAFTS + '/' + encodeURIComponent(draftId) + '/body', {
        method: 'PATCH',
        headers: msgDraftHeaders(),
        body: JSON.stringify({ body: body, expectVersion: expectVersion }),
      });
      try { out = await res.json(); } catch (e) { out = null; }
    } catch (e) { res = null; }
    if (epoch !== _draftEpoch) { _draftStatus = ''; msgRenderDraftBar(); msgRefreshDrafts(); return; }
    if (!_draft || _draft.id !== draftId) { msgRefreshDrafts(); return; }
    if (res && res.ok && out && out.draft) {
      _draft = out.draft;
      _draftStatus = 'saved';
      _draftChanged = false;
      _draftNotice = '';
    } else if (res && res.status === 409) {
      if (!msgDraftApplyRefusal(out)) _draftChanged = true;
    } else {
      _draftStatus = 'error';
    }
    msgRenderDraftBar();
    msgRefreshDrafts();
  }

  /**
   * A create that landed after the world moved on (Enter sent the message while the first save was in
   * flight). The row it made holds words that have already gone out, so it is discarded — but only
   * after re-reading it, because a later save may have put newer words in the same row, and those are
   * somebody's draft. Never adopts anything into the composer.
   */
  async function msgDraftCancelLateCreate(draft, sentText) {
    if (!draft || !draft.id) return;
    var res = null, out = null;
    try {
      res = await fetch(API_DRAFTS + '/' + encodeURIComponent(draft.id));
      try { out = await res.json(); } catch (e) { out = null; }
    } catch (e) { res = null; }
    var row = res && res.ok && out && out.draft ? out.draft : null;
    if (!row || row.state !== 'open') return;
    if (String(row.body || '') !== String(sentText == null ? '' : sentText)) return;
    try {
      await fetch(API_DRAFTS + '/' + encodeURIComponent(row.id) + '/discard', {
        method: 'POST',
        headers: msgDraftHeaders(),
        body: JSON.stringify({ expectVersion: Number(row.version) || 1 }),
      });
    } catch (e) { /* the next refresh shows whatever state it ended in */ }
    msgRefreshDrafts();
  }

  /** Pre-fill this thread's composer from its open draft (on opening a conversation). */
  async function msgDraftLoad(kind, conversationId) {
    var convId = Number(conversationId);
    if (!kind || !isFinite(convId)) return;
    _draft = null;
    _draftStatus = '';
    _draftChanged = false;
    _draftNotice = '';
    _draftUnverified = false;
    msgDraftClearTimer();
    var res = null, out = null;
    try {
      res = await fetch(API_DRAFTS + '?conversation=' + encodeURIComponent(kind + ':' + convId));
      try { out = await res.json(); } catch (e) { out = null; }
    } catch (e) { res = null; }
    if (msgDraftActiveKind() !== kind || msgDraftActiveId() !== convId) return;
    var d = res && res.ok && out && out.drafts && out.drafts[0] ? out.drafts[0] : null;
    if (d && d.id) {
      _draft = d;
      var ta = document.getElementById('msg-input');
      if (ta && ta.value.trim() === '') {
        ta.value = String(d.body || '');
        ta.style.height = 'auto';
      }
    }
    msgRenderDraftBar();
  }

  /**
   * Re-read the open thread's draft and settle it against what the composer holds: adopt the newer
   * row when there are no unsaved local words, offer Reload when there are. Never overwrites text
   * somebody is typing.
   */
  async function msgDraftReconcile() {
    var kind = msgDraftActiveKind();
    var convId = msgDraftActiveId();
    if (!kind || convId == null) return;
    var res = null, out = null;
    try {
      res = await fetch(API_DRAFTS + '?conversation=' + encodeURIComponent(kind + ':' + convId));
      try { out = await res.json(); } catch (e) { out = null; }
    } catch (e) { res = null; }
    if (msgDraftActiveKind() !== kind || msgDraftActiveId() !== convId) return;
    var server = res && res.ok && out && out.drafts ? (out.drafts[0] || null) : null;
    var ta = document.getElementById('msg-input');
    var local = ta ? ta.value : '';
    if (!server) {
      if (_draft) {
        if (ta && local === _draft.body) ta.value = '';
        _draft = null;
        _draftStatus = '';
        _draftChanged = false;
        _draftNotice = '';
        _draftUnverified = false;
        msgRenderDraftBar();
      }
      return;
    }
    if (!_draft) {
      if (!ta) return;
      _draft = server;
      _draftNotice = '';
      _draftUnverified = false;
      if (local === '') {
        ta.value = String(server.body || '');
        ta.style.height = 'auto';
        _draftStatus = '';
        _draftChanged = false;
      } else if (local === String(server.body || '')) {
        _draftChanged = false;
      } else {
        _draftChanged = true;
      }
      msgRenderDraftBar();
      return;
    }
    if (Number(server.version) === Number(_draft.version)) {
      _draft = server;
      msgRenderDraftBar();
      return;
    }
    if (local === _draft.body) {
      // The row moved and nothing local is at risk: adopt it, and forget a refusal that belonged to
      // the row this one replaces.
      _draft = server;
      _draftNotice = '';
      _draftUnverified = false;
      if (ta) { ta.value = String(server.body || ''); ta.style.height = 'auto'; }
      _draftStatus = 'saved';
      _draftChanged = false;
    } else {
      _draftChanged = true;
    }
    msgRenderDraftBar();
  }

  /** The Reload button: take the server's row and drop the local words (never a blind re-POST). */
  async function msgReloadDraft() {
    var kind = msgDraftActiveKind();
    var convId = msgDraftActiveId();
    if (!kind || convId == null) return;
    msgDraftClearTimer();
    _draftEpoch += 1;
    _draftChanged = false;
    _draftStatus = '';
    _draftNotice = '';
    _draftUnverified = false;
    _draft = null;
    var res = null, out = null;
    try {
      res = await fetch(API_DRAFTS + '?conversation=' + encodeURIComponent(kind + ':' + convId));
      try { out = await res.json(); } catch (e) { out = null; }
    } catch (e) { res = null; }
    if (msgDraftActiveKind() !== kind || msgDraftActiveId() !== convId) return;
    var server = res && res.ok && out && out.drafts ? (out.drafts[0] || null) : null;
    var ta = document.getElementById('msg-input');
    if (server && server.id) {
      _draft = server;
      if (ta) { ta.value = String(server.body || ''); ta.style.height = 'auto'; }
    } else if (ta) {
      ta.value = '';
    }
    msgRenderDraftBar();
    msgRefreshDrafts();
  }

  /** Open the thread a Drafts row belongs to (and fold the list away on a phone). The row's data-kind
   *  decides which thread: a room draft opens the ROOM, a contact draft opens that contact. A row
   *  whose kind is neither (a malformed redraw) opens nothing — never a peer thread guessed from a
   *  room's group id. */
  function msgOpenDraftRow(node) {
    var row = msgDraftRowOf(node);
    if (!row) return;
    var kind = row.getAttribute('data-kind');
    var id = parseInt(row.getAttribute('data-conversation-id'), 10);
    if (!isFinite(id) || id <= 0) return;
    try {
      var section = document.getElementById('msg-drafts');
      if (section && window.innerWidth < 769) section.removeAttribute('open');
    } catch (e) {}
    if (kind === 'room') msgSelectRoom(id);
    else if (kind === 'contact') msgSelectItem('peer', id);
  }

  /** The Send button on a Drafts row: the stored text is what it sends — unless this row IS the open
   *  thread's draft, in which case the composer's words are the ones the person means. */
  function msgDraftRowSend(node) {
    var row = msgDraftRowOf(node);
    if (!row) return;
    var d = msgDraftRowById(row.getAttribute('data-draft-id'));
    if (!d) return;
    if (_draft && _draft.id === d.id) { msgSendDraft(); return; }
    msgSendDraftRow(d);
  }

  async function msgSendDraftRow(d) {
    if (_draftSending) return;
    _draftSending = true;
    msgDraftRowBusy(d.id, true);
    var res = null, out = null;
    var epoch = _draftEpoch;
    try {
      res = await fetch(API_DRAFTS + '/' + encodeURIComponent(d.id) + '/send', {
        method: 'POST',
        headers: msgDraftHeaders(),
        body: JSON.stringify({ body: String(d.body || ''), expectVersion: Number(d.version) || 1 }),
      });
      try { out = await res.json(); } catch (e) { out = null; }
    } catch (e) { res = null; }
    _draftSending = false;
    msgDraftRowBusy(d.id, false);
    var active = !!(_draft && _draft.id === d.id);
    if (res && res.ok && out && out.ok) {
      if (active && epoch === _draftEpoch) {
        _draftEpoch += 1;
        _draft = null;
        _draftStatus = '';
        _draftChanged = false;
        _draftNotice = '';
        _draftUnverified = false;
        _draftReceipt = msgFmtDraft(DRAFT_STR.sentReceipt, { name: String((_activeItem && _activeItem.name) || d.label || '') });
        var ta = document.getElementById('msg-input');
        if (ta) { ta.value = ''; ta.style.height = 'auto'; }
        msgRenderDraftBar();
        msgReloadThread();
      }
      msgRefreshDrafts();
    } else if (res && res.status === 409) {
      if (active && epoch === _draftEpoch) {
        if (!msgDraftApplyRefusal(out)) _draftChanged = true;
        msgRenderDraftBar();
      }
      msgRefreshDrafts();
    } else {
      // A delivery that did not land answers WITH the reopened row; the thread's own draft adopts it
      // (so a retry carries the current version instead of colliding), a row send just redraws.
      if (active && epoch === _draftEpoch) {
        if (out && out.draft && out.draft.id === d.id && out.draft.state === 'open') _draft = out.draft;
        _draftStatus = 'error';
        msgRenderDraftBar();
      }
      msgRefreshDrafts();
    }
  }

  function msgDraftRowBusy(id, busy) {
    var rows = document.querySelectorAll('.msg-drafts-row');
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].getAttribute('data-draft-id') !== id) continue;
      var btns = rows[i].querySelectorAll('button');
      for (var j = 0; j < btns.length; j++) btns[j].disabled = !!busy;
    }
  }

  /** The Discard button on a Drafts row: ask first. */
  function msgDraftRowDiscard(node) {
    var row = msgDraftRowOf(node);
    if (!row) return;
    var d = msgDraftRowById(row.getAttribute('data-draft-id'));
    if (d) msgAskDiscard(d.id, Number(d.version) || 1, row);
  }

  /** The Discard button in the thread's draft bar: ask first. */
  function msgAskDiscardDraft() {
    if (!_draft) return;
    msgAskDiscard(_draft.id, Number(_draft.version) || 1, null);
  }

  /** Open the Discard confirmation. Escape closes it and focus goes back where it came from. */
  function msgAskDiscard(draftId, version, rowEl) {
    var dialog = document.getElementById('msg-draft-confirm');
    if (!dialog) return;
    _draftConfirmCtx = { draftId: draftId, version: version, rowEl: rowEl || null };
    var back = document.getElementById('msg-draft-bar-discard');
    _draftConfirmReturnFocus = (rowEl && rowEl.querySelector('.msg-draft-discard')) || back || null;
    dialog.removeAttribute('hidden');
    var cancel = document.getElementById('msg-draft-confirm-cancel');
    if (cancel && cancel.focus) { try { cancel.focus(); } catch (e) {} }
  }

  function msgCloseDraftConfirm() {
    var dialog = document.getElementById('msg-draft-confirm');
    if (dialog) dialog.setAttribute('hidden', 'hidden');
    var back = _draftConfirmReturnFocus;
    _draftConfirmCtx = null;
    _draftConfirmReturnFocus = null;
    if (back && back.focus) { try { back.focus(); } catch (e) {} }
  }

  async function msgConfirmDraftDiscard() {
    var ctx = _draftConfirmCtx;
    if (!ctx) { msgCloseDraftConfirm(); return; }
    var yes = document.getElementById('msg-draft-confirm-yes');
    if (yes) yes.disabled = true;
    var res = null;
    try {
      res = await fetch(API_DRAFTS + '/' + encodeURIComponent(ctx.draftId) + '/discard', {
        method: 'POST',
        headers: msgDraftHeaders(),
        body: JSON.stringify({ expectVersion: ctx.version }),
      });
    } catch (e) { res = null; }
    if (yes) yes.disabled = false;
    var active = !!(_draft && _draft.id === ctx.draftId);
    msgCloseDraftConfirm();
    if (res && res.ok) {
      if (active) {
        _draftEpoch += 1;
        _draft = null;
        _draftStatus = '';
        _draftChanged = false;
        _draftNotice = '';
        _draftUnverified = false;
        _draftReceipt = DRAFT_STR.discardedReceipt;
        var ta = document.getElementById('msg-input');
        if (ta) { ta.value = ''; ta.style.height = 'auto'; }
        msgRenderDraftBar();
      }
      msgRefreshDrafts();
    } else if (res && res.status === 409) {
      if (active) {
        var out = null;
        try { out = await res.json(); } catch (e) { out = null; }
        if (!msgDraftApplyRefusal(out)) _draftChanged = true;
        msgRenderDraftBar();
      }
      msgRefreshDrafts();
    } else {
      msgRefreshDrafts();
    }
  }

  if (!window.__msgDraftConfirmBound) {
    window.__msgDraftConfirmBound = true;
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      var dialog = document.getElementById('msg-draft-confirm');
      if (!dialog || dialog.hasAttribute('hidden')) return;
      e.preventDefault();
      msgCloseDraftConfirm();
    });
  }

  (function msgBindDraftConfirm() {
    var dialog = document.getElementById('msg-draft-confirm');
    var cancel = document.getElementById('msg-draft-confirm-cancel');
    var yes = document.getElementById('msg-draft-confirm-yes');
    if (cancel) cancel.addEventListener('click', function () { msgCloseDraftConfirm(); });
    if (yes) yes.addEventListener('click', function () { msgConfirmDraftDiscard(); });
    if (dialog) dialog.addEventListener('click', function (e) { if (e.target === dialog) msgCloseDraftConfirm(); });
  })();

  /** The Send button's draft half: post the exact text the composer shows, with its version. A refusal
   *  is mapped to its approved sentence (msgDraftApplyRefusal), and a delivery that did not land
   *  answers WITH the reopened row — adopted here, so Retry carries the current version instead of
   *  colliding with a row that never left the open state. */
  async function msgSendDraft() {
    if (!_draft || _draftSending) return;
    if (_draftUnverified) {
      // The seal does not verify: the server refuses this draft, and so does the button.
      msgRenderDraftBar();
      return;
    }
    if (_draftChanged) {
      // The row moved under this screen (another tab, another view): the composer's words and the
      // row's version no longer agree, so sending would either be answered 409 or put one view's
      // words out under the other's seal. The changed-elsewhere line and Reload are the way out.
      msgRenderDraftBar();
      return;
    }
    var ta = document.getElementById('msg-input');
    var text = ta ? ta.value : String(_draft.body || '');
    if (String(text).trim() === '') return;
    msgDraftClearTimer();
    _draftSending = true;
    var btn = document.getElementById('msg-send-btn');
    if (btn) btn.disabled = true;
    var draftId = _draft.id;
    var epoch = _draftEpoch;
    var res = null, out = null;
    try {
      res = await fetch(API_DRAFTS + '/' + encodeURIComponent(draftId) + '/send', {
        method: 'POST',
        headers: msgDraftHeaders(),
        body: JSON.stringify({ body: String(text), expectVersion: Number(_draft.version) || 1 }),
      });
      try { out = await res.json(); } catch (e) { out = null; }
    } catch (e) { res = null; }
    _draftSending = false;
    if (btn) btn.disabled = !!_draftUnverified;
    if (epoch !== _draftEpoch) { msgRefreshDrafts(); return; }
    if (!_draft || _draft.id !== draftId) { msgRefreshDrafts(); return; }
    if (res && res.ok && out && out.ok) {
      _draftEpoch += 1;
      _draft = null;
      _draftStatus = '';
      _draftChanged = false;
      _draftNotice = '';
      _draftUnverified = false;
      _draftReceipt = msgFmtDraft(DRAFT_STR.sentReceipt, { name: String((_activeItem && _activeItem.name) || '') });
      if (ta) { ta.value = ''; ta.style.height = 'auto'; }
      msgRenderDraftBar();
      msgReloadThread();
      msgRefreshDrafts();
    } else if (res && res.status === 409) {
      if (!msgDraftApplyRefusal(out)) _draftChanged = true;
      msgRenderDraftBar();
      msgRefreshDrafts();
    } else {
      if (out && out.draft && out.draft.id === draftId && out.draft.state === 'open') {
        _draft = out.draft;
        _draftChanged = false;
      }
      _draftStatus = 'error';
      msgRenderDraftBar();
      msgRefreshDrafts();
    }
  }

  /** Re-open the thread that is on screen (after a send, so the new bubble is the real row). */
  function msgReloadThread() {
    if (!_activeItem) return;
    if (_activeItem.type === 'peer') loadPeerConversation(msgDraftActiveId());
    else if (_activeItem.type === 'room') loadRoomConversation(String(_activeItem.id));
  }

  /** The live stream: ids and an action word; every frame just says "re-read". */
  function startDraftStream() {
    if (window.__crowDraftStream) { try { window.__crowDraftStream.close(); } catch (e) {} window.__crowDraftStream = null; }
    try {
      var es = new EventSource('/dashboard/streams/message-drafts');
      window.__crowDraftStream = es;
      es.addEventListener('crow-draft', function (evt) {
        // Self-cancel once the Messages panel is not the page any more (a Turbo nav away leaves the
        // connection open otherwise, re-reading the drafts API for a section nobody is looking at).
        if (!document.getElementById('msg-drafts')) {
          try { es.close(); } catch (e) {}
          window.__crowDraftStream = null;
          return;
        }
        var data = null;
        try { data = JSON.parse(evt.data); } catch (e) { return; }
        try { msgRefreshDrafts(); } catch (e) {}
        try {
          var kind = msgDraftActiveKind();
          if (kind && data && data.conversationKind === kind && Number(data.conversationId) === Number(msgDraftActiveId())) {
            msgDraftReconcile();
          }
        } catch (e) {}
      });
      es.addEventListener('session-expired', function () {
        try { es.close(); } catch (e) {}
        window.__crowDraftStream = null;
      });
      es.onerror = function () { /* EventSource auto-reconnects */ };
    } catch (e) { /* no EventSource — the next action still re-reads */ }
  }

  // === Avatar Strip Selection ===
  function msgSelectItem(type, id) {
    if (_activeItem && _activeItem.type === type && _activeItem.id === id) return;
    msgDraftResetForSwitch();
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
    msgDraftResetForSwitch();
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

    // First send on a fresh conversation: drop the suggestion chips — they
    // only make sense before any message exists, and sendAiMessage never
    // reloads the conversation from the server, so nothing else clears them.
    var suggestChips = document.querySelector('.msg-suggest-chips');
    if (suggestChips) suggestChips.remove();

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

          if (currentEventType === 'provider_warming') {
            // Server sends a translated message field only for native
            // providers (a first-time native warm can read a multi-GB GGUF
            // off disk and take minutes — worth narrating). Docker/cloud
            // providers send no message; fall back to the generic thinking copy.
            if (typing.parentNode) {
              typing.textContent = (eventData.message || '${tJs("messages.thinking", lang)}') + ' ';
              typing.appendChild(cancelBtn);
            }
          }

          if (currentEventType === 'content') {
            if (!assistantDiv) {
              if (typing.parentNode) typing.remove();
              assistantDiv = el('div', { className: 'msg-bubble received' });
              // Attach routing badge BEFORE streaming content begins so
              // the user sees the route decision immediately.
              if (pendingRoute && (pendingRoute.model_id || pendingRoute.reason)) {
                var liveBadge = el('div', { className: 'msg-route-badge', css: 'display:inline-flex;align-items:center;gap:4px;margin-bottom:0.25rem;padding:2px 8px;background:var(--crow-accent-muted);color:var(--crow-accent);border-radius:var(--crow-radius-pill,999px);font-size:0.68rem;font-family:\\'JetBrains Mono\\',monospace;letter-spacing:0.02em' });
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

      // The thread's open draft pre-fills the composer (and its bot banner, if a bot wrote it).
      msgDraftLoad('contact', Number(contactId));

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
      // Success requires the server's EXPLICIT { ok: true } ack (Task 3 always
      // sends it): a redirected HTML page (setup wizard on an unconfigured
      // instance, login redirect on session expiry) comes back response.ok
      // with a body that fails json() → body null — that is a FAILURE, not a
      // silent fake success (found live via CDP).
      var body = null;
      try { body = await response.json(); } catch(_) { /* non-JSON body */ }
      if (!response.ok || !body || body.ok !== true) {
        // F-UI-7: stamp the failed row id so Retry targets the exact row.
        if (body && body.id) sentBubble.dataset.msgId = body.id;
        markBubbleFailed(sentBubble, body && body.error, { id: body && body.id, content: content });
      } else if (body && body.id) {
        // The words left the box: an autosave or a create still in flight belongs to a message that
        // has already gone out, so its answer is made inert (and a create that lands is cancelled).
        _draftEpoch += 1;
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
      msgDraftLoad('room', Number(groupId));
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
      var roomRes = await fetch('/api/messages/room/' + encodeURIComponent(_activeItem.id) + '/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text }),
      });
      // The words left the box: make any in-flight draft save inert (see sendPeerMessage).
      if (roomRes && roomRes.ok) _draftEpoch += 1;
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
    // The receipt line needs the person a draft was sent to; the header already knows the name.
    if (_activeItem && (headerData.type === 'peer' || headerData.type === 'room')) {
      _activeItem.name = headerData.name;
    }

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
    if (headerData.type === 'ai' && msgs.length === 0) {
      var chipsWrap = el('div', { className: 'msg-suggest-chips' });
      var chipTexts = [
        '${tJs("messages.suggest1", lang)}',
        '${tJs("messages.suggest2", lang)}',
        '${tJs("messages.suggest3", lang)}',
      ];
      chipTexts.forEach(function (chipText) {
        chipsWrap.appendChild(el('button', {
          className: 'msg-suggest-chip',
          type: 'button',
          text: chipText,
          onclick: function () {
            var composer = document.getElementById('msg-input');
            if (composer) composer.value = chipText;
            sendCurrentMessage();
          },
        }));
      });
      viewport.appendChild(chipsWrap);
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

    // Draft bar: the bot banner, Saving…/Saved, Discard, and the "changed elsewhere" + Reload line.
    // Only peer and room conversations hold drafts (an AI chat does not).
    if (headerData.type === 'peer' || headerData.type === 'room') {
      var draftBar = el('div', { className: 'msg-draft-bar', id: 'msg-draft-bar' });
      draftBar.appendChild(el('div', { className: 'msg-draft-banner', id: 'msg-draft-banner' }));
      var draftRowBar = el('div', { className: 'msg-draft-row' });
      draftRowBar.appendChild(el('span', { className: 'msg-draft-status', id: 'msg-draft-status' }));
      var discardBtn = el('button', {
        type: 'button',
        className: 'msg-draft-bar-discard',
        id: 'msg-draft-bar-discard',
        text: DRAFT_STR.discard,
        onclick: function () { msgAskDiscardDraft(); },
      });
      draftRowBar.appendChild(discardBtn);
      draftBar.appendChild(draftRowBar);
      var changedRow = el('div', { className: 'msg-draft-changed', id: 'msg-draft-changed' });
      changedRow.appendChild(el('span', { text: DRAFT_STR.changedElsewhere }));
      changedRow.appendChild(el('button', {
        type: 'button',
        className: 'msg-draft-reload',
        id: 'msg-draft-reload',
        text: DRAFT_STR.reload,
        onclick: function () { msgReloadDraft(); },
      }));
      draftBar.appendChild(changedRow);
      container.appendChild(draftBar);
    }

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
      msgDraftScheduleAutosave();
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
    if (_activeItem.type === 'ai') { sendAiMessage(); return; }
    if (_activeItem.type !== 'peer' && _activeItem.type !== 'room') return;
    // Attachments ride the normal send path (a draft holds words only). A draft from earlier typing
    // stays in the Drafts list to finish or discard.
    if (_pendingAttachments.length > 0) {
      if (_activeItem.type === 'peer') sendPeerMessage();
      else sendRoomMessage();
      return;
    }
    if (_draftTimer) {
      // Words are still inside the 800 ms autosave window: save them first, then send the draft, so
      // a keystroke-then-Enter never leaves a stale draft behind a message that already went out.
      msgDraftFlushPending().then(function () {
        if (_draft) msgSendDraft();
        else sendCurrentMessage();
      });
      return;
    }
    if (_draft) { msgSendDraft(); return; }
    if (_activeItem.type === 'peer') sendPeerMessage();
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
      // A message the room's host relayed carries the receive-time label
      // "<author> via <host>" (PT-3): show it whole, so the relay stays visible
      // even when the author is a known contact.
      var hostRelayed = !isSent && typeof msg.sender_label === 'string' && msg.sender_label.indexOf(' via ') !== -1;
      var senderName = (hostRelayed ? msg.sender_label : '') || msg.sender_name || msg.sender_label || (isSent ? '${tJs("messages.you", lang)}' : '${tJs("messages.them", lang)}');
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
          var badge = el('div', { className: 'msg-route-badge', css: 'display:inline-flex;align-items:center;gap:4px;margin-bottom:0.25rem;padding:2px 8px;background:var(--crow-accent-muted);color:var(--crow-accent);border-radius:var(--crow-radius-pill,999px);font-size:0.68rem;font-family:\\'JetBrains Mono\\',monospace;letter-spacing:0.02em' });
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
    //
    // ONE RETRY PATH: a send that came from a draft leaves its text in the reopened draft when the
    // delivery fails, and that draft (in the bar below, carrying the row's current version) is the
    // retry. So a failed row holding the draft's own words gets the note and no Retry button; any
    // other failed row (a typed send) keeps its own.
    if (isSent && msg.delivery_status === 'failed') {
      markBubbleFailed(div, null, msgDraftHoldsText(msg.content) ? {} : { id: msg.id, content: msg.content });
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
        // Styling lives on the .msg-bubble-failed-note class (css.js, F-UI-6)
        // — no inline css here, it would override the class rule.
        b.appendChild(el('div', {
          className: 'msg-bubble-failed-note',
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
      // Same explicit-ack rule as sendPeerMessage: a redirected HTML response
      // (body null) must re-arm Retry, never fake a delivered bubble.
      if (response.ok && body && body.ok === true) {
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
    var avatar = el('div', { className: 'msg-info-avatar', css: 'background:linear-gradient(135deg,#0e6b62,#8b5cf6)' });
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
    var colors = ['#0e6b62','#8b5cf6','#ec4899','#f59e0b','#10b981','#06b6d4','#f43f5e','#84cc16','#d946ef','#0ea5e9'];
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
    if (contact.safety_number) {
      // F-UI-6: show the SYMMETRIC safety number (same string both sides —
      // matches the Contacts detail page), not the raw asymmetric peer pubkey
      // that read as "the numbers don't match".
      secSec.appendChild(el('div', {
        className: 'msg-info-row',
        css: 'font-size:0.7rem;color:var(--crow-text-muted);margin-top:6px',
        text: '${tJs("contacts.safetyNumber", lang)}',
      }));
      secSec.appendChild(el('div', {
        className: 'msg-info-row',
        css: 'font-family:monospace;font-size:0.75rem;word-break:break-all;user-select:all',
        text: contact.safety_number,
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
        // server-bound token either way (window.crowCsrf — the page's meta tag
        // or GET /dashboard/csrf; never a cookie).
        var csrfEl = document.createElement('input');
        csrfEl.type = 'hidden';
        csrfEl.name = '_csrf';
        try { csrfEl.value = window.crowCsrf ? window.crowCsrf() : ''; } catch (e) { csrfEl.value = ''; }
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
    startDraftStream();
  }

  function stopPolling() {
    if (_pollInterval) { clearInterval(_pollInterval); _pollInterval = null; }
    if (window.__msgPollInterval) { clearInterval(window.__msgPollInterval); window.__msgPollInterval = null; }
    if (window.__crowMsgStream) { try { window.__crowMsgStream.close(); } catch (e) {} window.__crowMsgStream = null; }
    if (window.__crowDraftStream) { try { window.__crowDraftStream.close(); } catch (e) {} window.__crowDraftStream = null; }
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
