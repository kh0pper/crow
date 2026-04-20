/**
 * Header Notification Bell + Health Status Icons + Tamagotchi Crow
 *
 * Provides HTML/CSS/JS for two modes:
 *   1. Classic: bell icon + health pulse (headerIcons*)
 *   2. Tamagotchi: animated pixel crow with combined dropdown (tamagotchi*)
 *
 * Shared notification rendering logic (sharedNotifJs) is used by both modes.
 *
 * Security: All user-generated content (notification titles, bodies) is escaped
 * via escapeNotifHtml() before DOM insertion. Health data is numeric only.
 */

import { t, tJs } from "./i18n.js";

// ─── Shared notification JS (used by both classic and tamagotchi modes) ───

export function sharedNotifJs(lang) {
  return `
  let _notifPollTimer = null;
  let _tabVisible = true;
  let _prevNotifCount = -1;
  let _activeCallToasts = [];

  document.addEventListener('visibilitychange', function() {
    _tabVisible = !document.hidden;
    if (_tabVisible) pollNotifications();
  });

  function escapeNotifHtml(str) {
    if (!str) return '';
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function formatUptime(seconds) {
    var d = Math.floor(seconds / 86400);
    var h = Math.floor((seconds % 86400) / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return d + 'd ' + h + 'h';
    if (h > 0) return h + 'h ' + m + 'm';
    return m + 'm';
  }

  function formatTimeAgo(iso) {
    var diff = Date.now() - new Date(iso + 'Z').getTime();
    var mins = Math.floor(diff / 60000);
    if (mins < 1) return '${tJs("time.justNow", lang)}';
    if (mins < 60) return mins + '${tJs("time.mAgo", lang)}';
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + '${tJs("time.hAgo", lang)}';
    return Math.floor(hrs / 24) + '${tJs("time.dAgo", lang)}';
  }

  async function loadNotifications() {
    var list = document.getElementById('notif-list');
    try {
      var resp = await fetch('/api/notifications?unread_only=true&limit=20');
      if (!resp.ok) { list.textContent = '${tJs("notif.errorLoading", lang)}'; return; }
      var data = await resp.json();

      if (!data.notifications || data.notifications.length === 0) {
        list.textContent = '';
        var empty = document.createElement('div');
        empty.style.cssText = 'color:var(--crow-text-muted);text-align:center;padding:1rem';
        empty.textContent = '${tJs("notif.noNotifications", lang)}';
        list.appendChild(empty);
        return;
      }

      var typeEmoji = { reminder: '\\u{1F514}', media: '\\u{1F4F0}', peer: '\\u{1F4AC}', system: '\\u2699' };
      var typeClass = { reminder: 'notif-type-reminder', media: 'notif-type-media', peer: 'notif-type-peer', system: 'notif-type-system' };

      list.textContent = '';
      data.notifications.forEach(function(n) {
        var item = document.createElement('div');
        item.className = 'notif-item';
        item.onclick = function() { notifClick(n.id, n.action_url); };

        var icon = document.createElement('span');
        icon.className = 'notif-type-icon ' + (typeClass[n.type] || typeClass.system);
        icon.textContent = typeEmoji[n.type] || typeEmoji.system;
        item.appendChild(icon);

        var body = document.createElement('div');
        body.className = 'notif-item-body';

        var title = document.createElement('div');
        title.className = n.priority === 'high' ? 'notif-item-title high' : 'notif-item-title';
        title.textContent = n.title;
        body.appendChild(title);

        if (n.body) {
          var desc = document.createElement('div');
          desc.className = 'notif-item-desc';
          desc.textContent = n.body;
          body.appendChild(desc);
        }

        var time = document.createElement('div');
        time.className = 'notif-item-time';
        time.textContent = formatTimeAgo(n.created_at);
        body.appendChild(time);

        item.appendChild(body);

        var dismiss = document.createElement('button');
        dismiss.className = 'notif-item-dismiss';
        dismiss.title = '${tJs("notif.dismiss", lang)}';
        dismiss.textContent = '\\u00D7';
        dismiss.onclick = function(e) { dismissNotification(e, n.id); };
        item.appendChild(dismiss);

        list.appendChild(item);
      });
    } catch(e) {
      list.textContent = '${tJs("notif.failedToLoad", lang)}';
    }
  }

  async function notifClick(id, url) {
    try { await fetch('/api/notifications/' + id + '/read', { method: 'POST' }); } catch(e) {}
    if (url) window.location.href = url;
    else { loadNotifications(); pollNotifications(); }
  }

  async function dismissNotification(e, id) {
    e.stopPropagation();
    try {
      await fetch('/api/notifications/' + id + '/dismiss', { method: 'POST' });
      loadNotifications();
      pollNotifications();
    } catch(e) {}
  }

  async function dismissAllNotifications(e) {
    e.stopPropagation();
    try {
      await fetch('/api/notifications/dismiss-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      loadNotifications();
      pollNotifications();
    } catch(e) {}
  }

  // ─── Incoming call toast ───

  function checkForCallNotifications(newCount) {
    if (_prevNotifCount < 0) { _prevNotifCount = newCount; return; }
    if (newCount <= _prevNotifCount) { _prevNotifCount = newCount; return; }
    _prevNotifCount = newCount;
    // Count increased — fetch recent notifications and check for call invites
    fetch('/api/notifications?unread_only=true&limit=5')
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (!data || !data.notifications) return;
        data.notifications.forEach(function(n) {
          if (n.source === 'sharing:room_invite' && _activeCallToasts.indexOf(n.id) === -1) {
            showCallToast(n);
          }
        });
      })
      .catch(function() {});
  }

  function showCallToast(n) {
    _activeCallToasts.push(n.id);
    var toast = document.createElement('div');
    toast.className = 'crow-call-toast';
    toast.setAttribute('data-notif-id', n.id);

    var info = document.createElement('div');
    info.className = 'crow-call-toast-info';
    var icon = document.createElement('span');
    icon.className = 'crow-call-toast-icon';
    icon.textContent = '\\u{1F4DE}';
    info.appendChild(icon);
    var text = document.createElement('span');
    text.textContent = escapeNotifHtml(n.title || 'Incoming call');
    info.appendChild(text);
    toast.appendChild(info);

    var actions = document.createElement('div');
    actions.className = 'crow-call-toast-actions';
    var acceptBtn = document.createElement('a');
    acceptBtn.className = 'crow-call-toast-accept';
    acceptBtn.textContent = 'Accept';
    acceptBtn.href = n.action_url || '#';
    acceptBtn.target = '_blank';
    acceptBtn.onclick = function() {
      fetch('/api/notifications/' + n.id + '/read', { method: 'POST' }).catch(function(){});
      removeCallToast(toast, n.id);
    };
    actions.appendChild(acceptBtn);
    var dismissBtn = document.createElement('button');
    dismissBtn.className = 'crow-call-toast-dismiss';
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.onclick = function() {
      fetch('/api/notifications/' + n.id + '/dismiss', { method: 'POST' }).catch(function(){});
      removeCallToast(toast, n.id);
      pollNotifications();
    };
    actions.appendChild(dismissBtn);
    toast.appendChild(actions);

    document.body.appendChild(toast);
    // Trigger slide-in
    requestAnimationFrame(function() { toast.classList.add('crow-call-toast--visible'); });
    // Auto-dismiss after 60s
    setTimeout(function() { removeCallToast(toast, n.id); }, 60000);
  }

  function removeCallToast(el, id) {
    _activeCallToasts = _activeCallToasts.filter(function(x) { return x !== id; });
    el.classList.remove('crow-call-toast--visible');
    setTimeout(function() { if (el.parentNode) el.parentNode.removeChild(el); }, 300);
  }
`;
}

// ─── Classic mode: bell icon + health pulse ───

export function headerIconsHtml(lang, { companionAvailable } = {}) {
  const kioskBtn = companionAvailable ? `
<button class="header-icon-btn kiosk-toggle-btn" id="kiosk-toggle-btn" onclick="toggleKioskMode()" title="${t("kiosk.toggle", lang)}">
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M12 18.5A3.5 3.5 0 1 0 8.5 15"/>
    <path d="M12 2a7 7 0 0 1 7 7c0 3.5-2 5-3.5 6.5"/>
    <circle cx="12" cy="9" r="1" fill="currentColor"/>
  </svg>
</button>` : "";
  return `
${kioskBtn}
<button class="header-icon-btn crow-ptt-btn" id="crow-ptt-btn" onclick="toggleCrowPtt(event)" title="Ask Crow through glasses" aria-label="Ask Crow" style="display:none">
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 1 0 6 0V4a3 3 0 0 0-3-3z"/>
    <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
    <path d="M12 19v4"/>
    <path d="M8 23h8"/>
  </svg>
</button>
<div class="header-icon-btn" id="health-icon-btn" onclick="toggleHealthDropdown(event)" title="${t("notif.systemHealth", lang)}">
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
  </svg>
  <span id="health-label" class="health-label">--</span>
  <div id="health-dropdown" class="header-dropdown" style="display:none">
    <div class="dropdown-title">${t("notif.systemHealth", lang)}</div>
    <div id="health-stats" class="dropdown-body">${t("common.loading", lang)}</div>
  </div>
</div>
<div class="header-icon-btn" id="notif-icon-btn" onclick="toggleNotifDropdown(event)" title="${t("notif.notifications", lang)}">
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
    <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
  </svg>
  <span id="notif-badge" class="notif-badge" style="display:none">0</span>
  <turbo-stream-source src="/dashboard/streams/notifications"></turbo-stream-source>
  <div id="notif-dropdown" class="header-dropdown notif-dropdown" style="display:none">
    <div class="dropdown-title">${t("notif.notifications", lang)} <button class="btn btn-sm btn-secondary" onclick="dismissAllNotifications(event)">${t("notif.clearAll", lang)}</button></div>
    <div id="notif-list" class="dropdown-body">${t("common.loading", lang)}</div>
  </div>
</div>
`;
}

export const headerIconsCss = `
  .header-icon-btn {
    position: relative;
    background: none;
    border: 1px solid var(--crow-border);
    border-radius: 8px;
    padding: 0.4rem 0.6rem;
    color: var(--crow-text-muted);
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    transition: color 0.15s, border-color 0.15s;
  }
  .header-icon-btn:hover {
    color: var(--crow-accent);
    border-color: var(--crow-accent);
  }
  .health-label {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.7rem;
    font-weight: 500;
  }
  .health-label.health-ok { color: var(--crow-success); }
  .health-label.health-warn { color: var(--crow-brand-gold); }
  .health-label.health-crit { color: var(--crow-error); }
  .notif-badge {
    position: absolute;
    top: -4px;
    right: -4px;
    background: var(--crow-brand-gold);
    color: #1a1a2e;
    font-size: 0.65rem;
    font-weight: 700;
    min-width: 16px;
    height: 16px;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 4px;
  }
  .header-dropdown {
    position: absolute;
    top: calc(100% + 8px);
    right: 0;
    background: var(--crow-bg-surface);
    border: 1px solid var(--crow-border);
    border-radius: 10px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.4);
    min-width: 280px;
    max-width: 360px;
    z-index: 200;
    animation: fadeInUp 0.15s ease-out;
  }
  .dropdown-title {
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--crow-border);
    font-size: 0.8rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--crow-text-muted);
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .dropdown-body {
    padding: 0.75rem;
    max-height: 320px;
    overflow-y: auto;
    font-size: 0.85rem;
  }
  .notif-dropdown { min-width: 320px; max-width: 400px; }
  .notif-item {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    padding: 0.5rem;
    border-radius: 6px;
    cursor: pointer;
    transition: background 0.1s;
  }
  .notif-item:hover { background: var(--crow-bg-elevated); }
  .notif-item + .notif-item { margin-top: 0.25rem; }
  .notif-item-body { flex: 1; min-width: 0; }
  .notif-item-title {
    font-weight: 500;
    font-size: 0.85rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .notif-item-title.high { color: var(--crow-error); }
  .notif-item-desc {
    font-size: 0.75rem;
    color: var(--crow-text-muted);
    margin-top: 2px;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .notif-item-time {
    font-size: 0.65rem;
    color: var(--crow-text-muted);
    font-family: 'JetBrains Mono', monospace;
    margin-top: 2px;
  }
  .notif-item-dismiss {
    background: none;
    border: none;
    color: var(--crow-text-muted);
    cursor: pointer;
    font-size: 1rem;
    padding: 0;
    line-height: 1;
    flex-shrink: 0;
  }
  .notif-item-dismiss:hover { color: var(--crow-error); }
  .notif-type-icon {
    width: 24px;
    height: 24px;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.8rem;
    flex-shrink: 0;
    margin-top: 2px;
  }
  .notif-type-reminder { background: rgba(99,102,241,0.15); color: var(--crow-accent); }
  .notif-type-media { background: rgba(168,85,247,0.15); color: #a855f7; }
  .notif-type-peer { background: rgba(34,197,94,0.15); color: var(--crow-success); }
  .notif-type-system { background: rgba(234,179,8,0.15); color: var(--crow-brand-gold); }
  .health-stat-row {
    display: flex;
    justify-content: space-between;
    padding: 0.35rem 0;
    border-bottom: 1px solid var(--crow-border);
  }
  .health-stat-row:last-child { border-bottom: none; }
  .health-stat-label { color: var(--crow-text-muted); font-size: 0.8rem; }
  .health-stat-value { font-family: 'JetBrains Mono', monospace; font-size: 0.8rem; }
  /* ─── Crow PTT (glasses voice turn) ─── */
  .crow-ptt-btn.active {
    background: #dc2626;
    border-color: #dc2626;
    color: #fff;
    animation: crow-ptt-pulse 1.2s ease-in-out infinite;
  }
  @keyframes crow-ptt-pulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(220,38,38,0.6); }
    50%      { box-shadow: 0 0 0 6px rgba(220,38,38,0); }
  }
  /* ─── Kiosk Mode ─── */
  .kiosk-toggle-btn {
    border-color: var(--crow-accent);
    color: var(--crow-accent);
  }
  .kiosk-toggle-btn:hover {
    background: rgba(99,102,241,0.1);
  }
  .kiosk-overlay {
    display: none;
    position: fixed;
    inset: 0;
    z-index: 10000;
    background: #000;
  }
  .kiosk-overlay.active {
    display: block;
  }
  .kiosk-overlay iframe {
    width: 100%;
    height: 100%;
    border: none;
  }
  /* Close button — HIDDEN by default. The companion app renders its own
   * 'Nest' button inside the iframe for the happy path. We only show this
   * fallback when the iframe FAILS to load (companion host unreachable,
   * refused-to-connect, CSP block) so the user isn't stranded with no way
   * back. Two visibility triggers:
   *   (a) .kiosk-overlay--error — set in JS after the 6s load timeout.
   *   (b) .kiosk-overlay--show-exit — reserved for future manual toggle. */
  .kiosk-exit-btn {
    position: absolute;
    top: 0.75rem;
    right: 0.75rem;
    z-index: 10001;
    display: none;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    border: 1px solid rgba(255,255,255,0.25);
    background: rgba(0,0,0,0.6);
    color: #fff;
    cursor: pointer;
    align-items: center;
    justify-content: center;
    backdrop-filter: blur(4px);
    transition: background 0.15s, border-color 0.15s;
  }
  .kiosk-exit-btn:hover {
    background: rgba(0,0,0,0.85);
    border-color: rgba(255,255,255,0.5);
  }
  .kiosk-exit-btn:focus-visible {
    outline: 2px solid var(--crow-accent);
    outline-offset: 2px;
  }
  .kiosk-overlay--error .kiosk-exit-btn,
  .kiosk-overlay--show-exit .kiosk-exit-btn { display: flex; }
  /* Inline error message replaces the iframe slot when load fails. */
  .kiosk-error-msg {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: #fff;
    font-family: 'DM Sans', sans-serif;
    text-align: center;
    padding: 2rem;
    gap: 1rem;
  }
  .kiosk-error-msg h3 { font-size: 1.2rem; margin: 0; }
  .kiosk-error-msg p { margin: 0; opacity: 0.7; font-size: 0.9rem; max-width: 520px; }
  .kiosk-error-msg button {
    background: transparent; border: 1px solid rgba(255,255,255,0.4);
    color: #fff; padding: 0.5rem 1.25rem; border-radius: 8px;
    cursor: pointer; font-size: 0.85rem;
  }
  .kiosk-error-msg button:hover { background: rgba(255,255,255,0.1); }
  /* ─── Incoming Call Toast ─── */
  .crow-call-toast {
    position: fixed;
    top: -80px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 10001;
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.75rem 1.25rem;
    background: rgba(26,26,46,0.92);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border: 1px solid rgba(99,102,241,0.4);
    border-radius: 12px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    transition: top 0.3s ease-out;
    max-width: 480px;
    width: calc(100% - 2rem);
  }
  .crow-call-toast--visible { top: 16px; }
  .crow-call-toast-info {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex: 1;
    min-width: 0;
    font-size: 0.9rem;
    font-weight: 500;
    color: var(--crow-text-primary, #e7e5e4);
  }
  .crow-call-toast-icon { font-size: 1.2rem; flex-shrink: 0; }
  .crow-call-toast-actions { display: flex; gap: 0.5rem; flex-shrink: 0; }
  .crow-call-toast-accept {
    padding: 0.4rem 1rem;
    font-size: 0.8rem;
    font-weight: 600;
    background: rgba(34,197,94,0.15);
    color: #22c55e;
    border: 1px solid rgba(34,197,94,0.3);
    border-radius: 8px;
    text-decoration: none;
    cursor: pointer;
    transition: background 0.15s;
  }
  .crow-call-toast-accept:hover { background: rgba(34,197,94,0.25); }
  .crow-call-toast-dismiss {
    padding: 0.4rem 0.75rem;
    font-size: 0.8rem;
    font-weight: 500;
    background: none;
    color: var(--crow-text-muted, #78716c);
    border: 1px solid var(--crow-border, rgba(61,61,77,0.4));
    border-radius: 8px;
    cursor: pointer;
    transition: color 0.15s;
  }
  .crow-call-toast-dismiss:hover { color: var(--crow-error, #ef4444); }

  @media (max-width: 768px) {
    .header-dropdown { position: fixed; top: auto; bottom: 60px; right: 8px; left: 8px; min-width: auto; max-width: none; }
    .health-label { display: none; }
    .crow-call-toast { max-width: none; width: calc(100% - 1rem); }
  }
`;

export function headerIconsJs(lang) {
  return `
(function() {
  // Under Turbo Drive, this inline script re-executes on every body swap.
  // Classic-script 'let' at top-level lives in the Realm's global lex env,
  // so re-declaring on re-execution throws SyntaxError. Wrap in an IIFE
  // with an idempotency guard so state + listeners attach exactly once.
  if (window.__crowNotifInit) return;
  window.__crowNotifInit = true;
  ${sharedNotifJs(lang)}

  function toggleHealthDropdown(e) {
    e.stopPropagation();
    var dd = document.getElementById('health-dropdown');
    var notifDd = document.getElementById('notif-dropdown');
    notifDd.style.display = 'none';
    dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
  }

  var _crowPttActive = false;
  async function _refreshCrowPttVisibility() {
    var btn = document.getElementById('crow-ptt-btn');
    if (!btn) return;
    try {
      var res = await fetch('/api/meta-glasses/devices', { credentials: 'same-origin' });
      if (!res.ok) { btn.style.display = 'none'; return; }
      var data = await res.json();
      btn.style.display = (data.connected_count > 0) ? '' : 'none';
    } catch {
      btn.style.display = 'none';
    }
  }
  _refreshCrowPttVisibility();
  if (!window.__crowPttVisibilityInterval) {
    window.__crowPttVisibilityInterval = setInterval(_refreshCrowPttVisibility, 15000);
  }

  async function toggleCrowPtt(e) {
    e.stopPropagation();
    var btn = document.getElementById('crow-ptt-btn');
    if (!btn) return;
    var action = _crowPttActive ? 'end' : 'begin';
    try {
      var res = await fetch('/api/meta-glasses/turn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action: action }),
      });
      var data = await res.json();
      if (action === 'begin') {
        if (!data.ok || !data.delivered) {
          var orig = btn.title;
          btn.title = 'No connected glasses session';
          setTimeout(function() { btn.title = orig; }, 1500);
          return;
        }
        _crowPttActive = true;
        btn.classList.add('active');
        btn.title = 'Stop turn';
      } else {
        _crowPttActive = false;
        btn.classList.remove('active');
        btn.title = 'Ask Crow through glasses';
      }
    } catch (err) {
      console.warn('ptt', err);
    }
  }

  function toggleNotifDropdown(e) {
    e.stopPropagation();
    var dd = document.getElementById('notif-dropdown');
    var healthDd = document.getElementById('health-dropdown');
    healthDd.style.display = 'none';
    dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
    if (dd.style.display === 'block') loadNotifications();
  }

  document.addEventListener('click', function() {
    document.getElementById('health-dropdown').style.display = 'none';
    document.getElementById('notif-dropdown').style.display = 'none';
  });

  document.querySelectorAll('.header-dropdown').forEach(function(el) {
    el.addEventListener('click', function(e) { e.stopPropagation(); });
  });

  async function pollNotifications() {
    if (!_tabVisible) return;
    try {
      var resp = await fetch('/api/notifications/count');
      if (!resp.ok) return;
      var data = await resp.json();

      checkForCallNotifications(data.count);

      var badge = document.getElementById('notif-badge');
      if (data.count > 0) {
        badge.textContent = data.count > 99 ? '99+' : data.count;
        badge.style.display = 'flex';
      } else {
        badge.style.display = 'none';
      }

      if (data.health) {
        var label = document.getElementById('health-label');
        var pct = data.health.ram_pct;
        label.textContent = pct + '%';
        label.className = 'health-label ' + (pct >= 90 ? 'health-crit' : pct >= 75 ? 'health-warn' : 'health-ok');

        var stats = document.getElementById('health-stats');
        stats.textContent = '';
        var rows = [
          ['${tJs("notif.ram", lang)}', data.health.ram_used_mb + ' / ' + data.health.ram_total_mb + ' MB (' + pct + '%)'],
          ['${tJs("notif.cpus", lang)}', '' + data.health.cpus],
          ['${tJs("notif.uptime", lang)}', formatUptime(data.health.uptime_seconds)]
        ];
        rows.forEach(function(r) {
          var row = document.createElement('div');
          row.className = 'health-stat-row';
          var lbl = document.createElement('span');
          lbl.className = 'health-stat-label';
          lbl.textContent = r[0];
          var val = document.createElement('span');
          val.className = 'health-stat-value';
          val.textContent = r[1];
          row.appendChild(lbl);
          row.appendChild(val);
          stats.appendChild(row);
        });
      }
    } catch(e) {}
  }

  pollNotifications();
  // 5-min fallback poll. Live updates come via the Turbo Stream at
  // /dashboard/streams/notifications; this interval is a safety net
  // for transient SSE drops and is intentionally slow.
  if (!window.__crowNotifPollInterval) {
    window.__crowNotifPollInterval = setInterval(pollNotifications, 300000);
    _notifPollTimer = window.__crowNotifPollInterval;
  }
  // Expose HTML onclick callbacks. Function declarations are hoisted, so
  // these references resolve even though the assignments read "before" the
  // function bodies in source order.
  window.dismissAllNotifications = dismissAllNotifications;
  window.toggleCrowPtt = toggleCrowPtt;
  window.toggleHealthDropdown = toggleHealthDropdown;
  window.toggleNotifDropdown = toggleNotifDropdown;
})();
`;
}

// ─── Tamagotchi mode: animated pixel crow with combined dropdown ───

export function tamagotchiHtml(lang, { companionAvailable } = {}) {
  const kioskBtn = companionAvailable ? `
<button class="header-icon-btn kiosk-toggle-btn" id="kiosk-toggle-btn" onclick="toggleKioskMode()" title="${t("kiosk.toggle", lang)}">
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M12 18.5A3.5 3.5 0 1 0 8.5 15"/>
    <path d="M12 2a7 7 0 0 1 7 7c0 3.5-2 5-3.5 6.5"/>
    <circle cx="12" cy="9" r="1" fill="currentColor"/>
  </svg>
</button>` : "";
  return `
${kioskBtn}
<button class="header-icon-btn crow-ptt-btn" id="crow-ptt-btn" onclick="toggleCrowPtt(event)" title="Ask Crow through glasses" aria-label="Ask Crow" style="display:none">
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 1 0 6 0V4a3 3 0 0 0-3-3z"/>
    <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
    <path d="M12 19v4"/>
    <path d="M8 23h8"/>
  </svg>
</button>
<div class="crow-tama-wrap" id="crow-tama-wrap">
  <svg class="crow-tama crow-happy" id="crow-tama" viewBox="0 0 48 56" width="42" height="49" onclick="toggleCrowDropdown(event)">
    <g class="crow-body-group">
      <!-- Feet -->
      <g class="crow-feet">
        <line x1="19" y1="42" x2="17" y2="48" stroke="#6366f1" stroke-width="1.5" stroke-linecap="round"/>
        <line x1="19" y1="42" x2="21" y2="48" stroke="#6366f1" stroke-width="1.5" stroke-linecap="round"/>
        <line x1="29" y1="42" x2="27" y2="48" stroke="#6366f1" stroke-width="1.5" stroke-linecap="round"/>
        <line x1="29" y1="42" x2="31" y2="48" stroke="#6366f1" stroke-width="1.5" stroke-linecap="round"/>
      </g>
      <!-- Body -->
      <ellipse class="crow-body" cx="24" cy="34" rx="12" ry="10" fill="#6366f1"/>
      <!-- Wing -->
      <ellipse class="crow-wing" cx="14" cy="33" rx="6" ry="8" fill="#818cf8" opacity="0.5" transform-origin="14 33"/>
      <!-- Head -->
      <circle class="crow-head" cx="24" cy="18" r="9" fill="#6366f1"/>
      <!-- Eye -->
      <circle class="crow-eye" cx="28" cy="16" r="3" fill="#fbbf24"/>
      <circle class="crow-pupil" cx="29" cy="16" r="1.5" fill="#0f0f17"/>
      <!-- Beak -->
      <polygon class="crow-beak" points="33,18 40,20 33,22" fill="#fbbf24"/>
    </g>
    <!-- Thought bubble (notification count) -->
    <g class="crow-bubble" id="crow-bubble" style="display:none">
      <rect x="32" y="0" width="16" height="14" rx="5" fill="var(--crow-bg-surface, #1a1a2e)" stroke="var(--crow-border, #2a2a3e)" stroke-width="1"/>
      <text class="crow-bubble-count" id="crow-bubble-count" x="40" y="10.5" text-anchor="middle" fill="#fbbf24" font-size="9" font-weight="700" font-family="'JetBrains Mono',monospace">0</text>
    </g>
    <!-- Alarmed exclamation -->
    <text class="crow-exclaim" id="crow-exclaim" style="display:none" x="6" y="12" fill="#ef4444" font-size="14" font-weight="900" font-family="'DM Sans',sans-serif">!</text>
  </svg>
  <!-- Combined dropdown -->
  <div id="crow-dropdown" class="crow-dropdown" style="display:none" onclick="event.stopPropagation()">
    <div class="dropdown-title">
      <span>${t("notif.status", lang)}</span>
      <button class="btn btn-sm btn-secondary" onclick="dismissAllNotifications(event)">${t("notif.clearAll", lang)}</button>
    </div>
    <div class="crow-health-bar" id="crow-health-bar">
      <span class="crow-health-metric">CPU <span id="crow-cpu">--</span></span>
      <span class="crow-health-sep">&middot;</span>
      <span class="crow-health-metric">RAM <span id="crow-ram">--</span></span>
      <span class="crow-health-sep">&middot;</span>
      <span class="crow-health-metric">${t("health.disk", lang)} <span id="crow-disk">--</span></span>
      <span class="crow-health-sep">&middot;</span>
      <span class="crow-health-metric" id="crow-uptime">--</span>
    </div>
    <div id="notif-list" class="dropdown-body">${t("common.loading", lang)}</div>
  </div>
</div>
`;
}

export const tamagotchiCss = `
  /* ─── Tamagotchi Crow ─── */
  .crow-tama-wrap {
    position: relative;
    display: flex;
    align-items: center;
    cursor: pointer;
  }
  .crow-tama {
    display: block;
    overflow: visible;
  }

  /* ─ Bounce keyframes ─ */
  @keyframes crow-bounce-happy {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-3px); }
  }
  @keyframes crow-bounce-tired {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-2px); }
  }

  /* ─ Blink keyframe ─ */
  @keyframes crow-blink {
    0%, 92%, 100% { opacity: 1; }
    95% { opacity: 0; }
  }

  /* ─ Wing flap (alarmed) ─ */
  @keyframes crow-flap {
    0%, 100% { transform: rotateZ(0deg); }
    50% { transform: rotateZ(-20deg); }
  }

  /* ─ Wing droop (tired) ─ */
  @keyframes crow-droop {
    0%, 100% { transform: rotateZ(5deg); }
    50% { transform: rotateZ(10deg); }
  }

  /* ─ Bubble float ─ */
  @keyframes crow-bubble-float {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-2px); }
  }

  /* ─ Happy mood ─ */
  .crow-happy .crow-body-group {
    animation: crow-bounce-happy 2s ease-in-out infinite;
  }
  .crow-happy .crow-eye {
    animation: crow-blink 4s step-end infinite;
  }
  .crow-happy .crow-wing {
    animation: none;
  }
  .crow-happy .crow-beak {
    fill: #fbbf24;
  }

  /* ─ Tired mood ─ */
  .crow-tired .crow-body-group {
    animation: crow-bounce-tired 3s ease-in-out infinite;
  }
  .crow-tired .crow-eye {
    animation: crow-blink 6s step-end infinite;
  }
  .crow-tired .crow-wing {
    animation: crow-droop 3s ease-in-out infinite;
  }
  .crow-tired .crow-beak {
    fill: #c8c864;
  }

  /* ─ Alarmed mood ─ */
  .crow-alarmed .crow-body-group {
    animation: crow-bounce-happy 1s ease-in-out infinite;
  }
  .crow-alarmed .crow-eye {
    animation: crow-blink 2s step-end infinite;
  }
  .crow-alarmed .crow-wing {
    animation: crow-flap 0.3s ease-in-out infinite;
  }
  .crow-alarmed .crow-beak {
    fill: #c8c864;
  }

  /* ─ Bubble ─ */
  .crow-bubble {
    animation: crow-bubble-float 3s ease-in-out infinite;
  }

  /* ─ Combined dropdown ─ */
  .crow-dropdown {
    position: absolute;
    top: calc(100% + 8px);
    right: 0;
    background: var(--crow-bg-surface);
    border: 1px solid var(--crow-border);
    border-radius: 10px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.4);
    min-width: 320px;
    max-width: 400px;
    z-index: 200;
    animation: fadeInUp 0.15s ease-out;
  }
  .crow-health-bar {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.5rem 1rem;
    border-bottom: 1px solid var(--crow-border);
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.75rem;
    color: var(--crow-text-secondary);
    flex-wrap: wrap;
  }
  .crow-health-metric { white-space: nowrap; }
  .crow-health-sep { color: var(--crow-text-muted); }
  .crow-health-ok { color: var(--crow-success); }
  .crow-health-warn { color: var(--crow-brand-gold); }
  .crow-health-crit { color: var(--crow-error); }

  @media (max-width: 768px) {
    .crow-dropdown { position: fixed; top: auto; bottom: 60px; right: 8px; left: 8px; min-width: auto; max-width: none; }
  }
`;

export function tamagotchiJs(lang) {
  return `
(function() {
  // See headerIconsJs for rationale: Turbo body-swap re-injection + classic-
  // script top-level 'let' collide. IIFE + guard keeps listeners/intervals
  // from stacking across navigations.
  if (window.__crowNotifInit) return;
  window.__crowNotifInit = true;
  ${sharedNotifJs(lang)}

  var _crowPttActive = false;
  async function _refreshCrowPttVisibility() {
    var btn = document.getElementById('crow-ptt-btn');
    if (!btn) return;
    try {
      var res = await fetch('/api/meta-glasses/devices', { credentials: 'same-origin' });
      if (!res.ok) { btn.style.display = 'none'; return; }
      var data = await res.json();
      btn.style.display = (data.connected_count > 0) ? '' : 'none';
    } catch {
      btn.style.display = 'none';
    }
  }
  _refreshCrowPttVisibility();
  if (!window.__crowPttVisibilityInterval) {
    window.__crowPttVisibilityInterval = setInterval(_refreshCrowPttVisibility, 15000);
  }

  async function toggleCrowPtt(e) {
    e.stopPropagation();
    var btn = document.getElementById('crow-ptt-btn');
    if (!btn) return;
    var action = _crowPttActive ? 'end' : 'begin';
    try {
      var res = await fetch('/api/meta-glasses/turn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action: action }),
      });
      var data = await res.json();
      if (action === 'begin') {
        if (!data.ok || !data.delivered) {
          var orig = btn.title;
          btn.title = 'No connected glasses session';
          setTimeout(function() { btn.title = orig; }, 1500);
          return;
        }
        _crowPttActive = true;
        btn.classList.add('active');
        btn.title = 'Stop turn';
      } else {
        _crowPttActive = false;
        btn.classList.remove('active');
        btn.title = 'Ask Crow through glasses';
      }
    } catch (err) { console.warn('ptt', err); }
  }

  function toggleCrowDropdown(e) {
    e.stopPropagation();
    var dd = document.getElementById('crow-dropdown');
    dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
    if (dd.style.display === 'block') loadNotifications();
  }

  document.addEventListener('click', function() {
    document.getElementById('crow-dropdown').style.display = 'none';
  });

  function healthColor(pct) {
    if (pct >= 90) return 'crow-health-crit';
    if (pct >= 70) return 'crow-health-warn';
    return 'crow-health-ok';
  }

  function updateCrowMood(health) {
    var svg = document.getElementById('crow-tama');
    var exclaim = document.getElementById('crow-exclaim');
    if (!svg || !health) return;

    var worst = Math.max(health.ram_pct || 0, health.cpu_pct || 0, health.disk_pct || 0);
    var mood;
    if (worst >= 90) {
      mood = 'crow-alarmed';
      exclaim.style.display = '';
    } else if (worst >= 70) {
      mood = 'crow-tired';
      exclaim.style.display = 'none';
    } else {
      mood = 'crow-happy';
      exclaim.style.display = 'none';
    }

    svg.classList.remove('crow-happy', 'crow-tired', 'crow-alarmed');
    svg.classList.add(mood);
  }

  function updateCrowHealthBar(health) {
    if (!health) return;

    var cpuEl = document.getElementById('crow-cpu');
    var ramEl = document.getElementById('crow-ram');
    var diskEl = document.getElementById('crow-disk');
    var uptimeEl = document.getElementById('crow-uptime');

    if (cpuEl) {
      cpuEl.textContent = (health.cpu_pct || 0) + '%';
      cpuEl.className = healthColor(health.cpu_pct || 0);
    }
    if (ramEl) {
      ramEl.textContent = (health.ram_pct || 0) + '%';
      ramEl.className = healthColor(health.ram_pct || 0);
    }
    if (diskEl) {
      diskEl.textContent = (health.disk_pct || 0) + '%';
      diskEl.className = healthColor(health.disk_pct || 0);
    }
    if (uptimeEl && health.uptime_seconds) {
      uptimeEl.textContent = formatUptime(health.uptime_seconds);
    }
  }

  function updateCrowBubble(count) {
    var bubble = document.getElementById('crow-bubble');
    var countEl = document.getElementById('crow-bubble-count');
    if (!bubble) return;

    if (count > 0) {
      bubble.style.display = '';
      if (countEl) countEl.textContent = count > 99 ? '99+' : count;
    } else {
      bubble.style.display = 'none';
    }
  }

  async function pollNotifications() {
    if (!_tabVisible) return;
    try {
      var resp = await fetch('/api/notifications/count');
      if (!resp.ok) return;
      var data = await resp.json();

      checkForCallNotifications(data.count);
      updateCrowBubble(data.count);
      updateCrowMood(data.health);
      updateCrowHealthBar(data.health);
    } catch(e) {}
  }

  pollNotifications();
  // 5-min fallback poll. Live updates come via the Turbo Stream at
  // /dashboard/streams/notifications; this interval is a safety net
  // for transient SSE drops and is intentionally slow.
  if (!window.__crowNotifPollInterval) {
    window.__crowNotifPollInterval = setInterval(pollNotifications, 300000);
    _notifPollTimer = window.__crowNotifPollInterval;
  }
  window.dismissAllNotifications = dismissAllNotifications;
  window.toggleCrowPtt = toggleCrowPtt;
  window.toggleCrowDropdown = toggleCrowDropdown;
})();
`;
}
