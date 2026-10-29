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
import { crowTalkRowHtml } from "./crow-talk.js";
import { CROW_BODY_GROUP } from "./crow-mark.js";

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

  // PT-3 N-5: an item whose sender is not in the user's contacts. Its source
  // ends in _unverified; it is labelled, and any link sits behind the label.
  function isUnverifiedNotif(n) {
    var s = n && typeof n.source === 'string' ? n.source : '';
    return s.length > 11 && s.slice(-11) === '_unverified';
  }
  function unverifiedWarning(n) {
    if (n.source === 'sharing:room_invite_unverified') return '${tJs("notif.notContactCallWarning", lang)}';
    if (n.source === 'sharing:voice_memo_unverified') return '${tJs("notif.notContactMemoWarning", lang)}';
    return '';
  }
  // Only http(s) links and same-site paths are followed, from any item.
  function safeNotifLink(u) {
    if (typeof u !== 'string') return '';
    var l = u.toLowerCase();
    if (l.indexOf('https://') === 0 || l.indexOf('http://') === 0) return u;
    if (u.charAt(0) === '/' && u.charAt(1) !== '/') return u;
    return '';
  }
  // An unverified item's link is kept in metadata (the server never puts it in
  // action_url, which is also pushed to the other channels).
  function unverifiedLinkOf(n) {
    var m = n && n.metadata && typeof n.metadata === 'object' ? n.metadata : null;
    return safeNotifLink(m && m.join_url ? m.join_url : n.action_url);
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
        var unverified = isUnverifiedNotif(n);
        // An unverified item never navigates on its own: its link is a
        // separate, labelled control below.
        item.onclick = function() { notifClick(n.id, unverified ? null : n.action_url); };

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

        if (unverified) {
          var label = document.createElement('div');
          label.className = 'notif-item-unverified';
          label.textContent = '${tJs("notif.notContactLabel", lang)}';
          body.appendChild(label);
          var warn = unverifiedWarning(n);
          if (warn) {
            var warnEl = document.createElement('div');
            warnEl.className = 'notif-item-desc notif-item-unverified-warning';
            warnEl.textContent = warn;
            body.appendChild(warnEl);
          }
        }

        if (n.body) {
          var desc = document.createElement('div');
          desc.className = 'notif-item-desc';
          desc.textContent = n.body;
          body.appendChild(desc);
        }

        var unverifiedLink = unverified ? unverifiedLinkOf(n) : '';
        if (unverifiedLink) {
          var open = document.createElement('a');
          open.className = 'notif-item-unverified-link';
          open.textContent = '${tJs("notif.openUnverifiedLink", lang)}';
          open.href = unverifiedLink;
          open.target = '_blank';
          open.rel = 'noopener noreferrer';
          open.onclick = function(e) {
            e.stopPropagation();
            fetch('/api/notifications/' + n.id + '/read', { method: 'POST' }).catch(function(){});
          };
          body.appendChild(open);
        }

        var time = document.createElement('div');
        time.className = 'notif-item-time';
        time.textContent = formatTimeAgo(n.created_at);
        body.appendChild(time);

        item.appendChild(body);

        var dismiss = document.createElement('button');
        dismiss.className = 'notif-item-dismiss';
        dismiss.title = '${tJs("notif.dismiss", lang)}';
        dismiss.setAttribute('aria-label', '${tJs("notif.dismiss", lang)}');
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
    var safe = safeNotifLink(url);
    if (safe) window.location.href = safe;
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
          if ((n.source === 'sharing:room_invite' || n.source === 'sharing:room_invite_unverified') && _activeCallToasts.indexOf(n.id) === -1) {
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

    // PT-3 N-5: a caller not in the contacts gets a warning, and the join
    // link sits behind it ("Open link anyway").
    var unverified = isUnverifiedNotif(n);
    if (unverified) {
      toast.classList.add('crow-call-toast--unverified');
      var warning = document.createElement('div');
      warning.className = 'crow-call-toast-warning';
      warning.setAttribute('role', 'alert');
      warning.textContent = '${tJs("notif.notContactCallWarning", lang)}';
      toast.appendChild(warning);
    }

    var actions = document.createElement('div');
    actions.className = 'crow-call-toast-actions';
    var acceptBtn = document.createElement('a');
    acceptBtn.className = 'crow-call-toast-accept';
    acceptBtn.textContent = unverified ? '${tJs("notif.openUnverifiedLink", lang)}' : 'Accept';
    acceptBtn.href = (unverified ? unverifiedLinkOf(n) : safeNotifLink(n.action_url)) || '#';
    acceptBtn.target = '_blank';
    if (unverified) acceptBtn.rel = 'noopener noreferrer';
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

/**
 * `talkAvailable` (the Kiosk extension's session display is installed): the
 * tray's first row is "Talk to Crow" and a long-press on the bell opens the
 * voice overlay (shared/crow-talk.js). Otherwise neither exists.
 */
export function headerIconsHtml(lang, { talkAvailable, sheet } = {}) {
  const talk = talkAvailable === true;
  // New shell (sheet): the bell is a real button that opens the shell's
  // "Notifications and settings" sheet; its tray renders inside that sheet
  // (headerIconsTrayHtml), not here.
  const bellAttrs = sheet
    ? ` role="button" tabindex="0" aria-haspopup="dialog" aria-controls="shell-avatar" aria-expanded="false" data-shell-tray="notif-dropdown" aria-label="${t("shell.notifSettings", lang)}" title="${t("shell.notifSettings", lang)}"${talk ? ` data-crow-talk aria-describedby="notif-hold-desc"` : ""}`
    : ` title="${t(talk ? "talk.bellLabelHold" : "notif.notifications", lang)}"${talk ? ` data-crow-talk role="button" tabindex="0" aria-controls="notif-dropdown" aria-expanded="false" aria-label="${t("talk.bellLabelHold", lang)}"` : ""}`;
  return `
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
<div class="header-icon-btn" id="notif-icon-btn" onclick="toggleNotifDropdown(event)"${bellAttrs}>
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
    <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
  </svg>
  <span id="notif-badge" class="notif-badge" style="display:none">0</span>
  <turbo-stream-source src="/dashboard/streams/notifications"></turbo-stream-source>${sheet ? (talk ? `<span id="notif-hold-desc" hidden>${t("shell.notifSettingsHold", lang)}</span>` : "") : headerIconsTrayHtml(lang, { talkAvailable })}
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
    color: var(--crow-accent-contrast);
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
  .notif-type-reminder { background: color-mix(in srgb, var(--crow-accent) 15%, transparent); color: var(--crow-accent); }
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
    background: rgba(34,48,58,0.92);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border: 1px solid color-mix(in srgb, var(--crow-accent) 40%, transparent);
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
  .crow-call-toast-warning {
    color: var(--crow-error);
    font-size: 0.85rem;
    margin: 0.25rem 0 0.5rem;
  }
  .crow-call-toast--unverified .crow-call-toast-accept {
    background: transparent;
    color: var(--crow-error);
    border-color: var(--crow-error);
  }
  .notif-item-unverified {
    color: var(--crow-error);
    font-size: 0.75rem;
    font-weight: 600;
  }
  .notif-item-unverified-link {
    color: var(--crow-error);
    font-size: 0.8rem;
    text-decoration: underline;
  }
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
    .header-dropdown { position: fixed; top: auto; bottom: calc(60px + var(--crow-player-h,0px)); right: 8px; left: 8px; min-width: auto; max-width: none; }
    .health-label { display: none; }
    .crow-call-toast { max-width: none; width: calc(100% - 1rem); }
  }
`;

/** The bell's tray: the Talk row (when armed), the title and the list. */
export function headerIconsTrayHtml(lang, { talkAvailable } = {}) {
  const talk = talkAvailable === true;
  return `
  <div id="notif-dropdown" class="header-dropdown notif-dropdown" style="display:none">${talk ? crowTalkRowHtml(lang, { holdTarget: "bell" }) : ""}
    <div class="dropdown-title">${t("notif.notifications", lang)} <button class="btn btn-sm btn-secondary" onclick="dismissAllNotifications(event)">${t("notif.clearAll", lang)}</button></div>
    <div id="notif-list" class="dropdown-body" aria-live="polite" aria-atomic="false">${t("common.loading", lang)}</div>
  </div>`;
}

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

  function setNotifDropdown(open) {
    var dd = document.getElementById('notif-dropdown');
    if (!dd) return;
    // New shell: the tray lives in the open "Notifications and settings"
    // sheet, which owns its state until it closes (shell/client.js).
    if (!open && dd.closest && dd.closest('dialog[open]')) return;
    dd.style.display = open ? 'block' : 'none';
    var owner = document.getElementById('notif-icon-btn');
    if (owner && owner.hasAttribute('aria-expanded')) owner.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) loadNotifications();
  }

  function toggleNotifDropdown(e) {
    e.stopPropagation();
    // The click that only ended a long-press (Talk to Crow) is not a tap.
    if (window.crowTalkSwallowTap && window.crowTalkSwallowTap()) return;
    var dd = document.getElementById('notif-dropdown');
    var healthDd = document.getElementById('health-dropdown');
    healthDd.style.display = 'none';
    setNotifDropdown(dd.style.display === 'none');
  }

  document.addEventListener('click', function() {
    var healthDd = document.getElementById('health-dropdown');
    if (healthDd) healthDd.style.display = 'none';
    setNotifDropdown(false);
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
  window.toggleHealthDropdown = toggleHealthDropdown;
  window.toggleNotifDropdown = toggleNotifDropdown;
})();
`;
}

// ─── Tamagotchi mode: animated pixel crow with combined dropdown ───

/**
 * The bird is the one header button. Tap → the tray. With `talkAvailable` (the
 * Kiosk extension's session display is installed) the tray's first row is
 * "Talk to Crow" and a long-press on the bird opens the voice overlay directly
 * (shared/crow-talk.js); without it the bird is not armed and a long-press is
 * an ordinary tap.
 */
export function tamagotchiHtml(lang, { talkAvailable, sheet } = {}) {
  const talk = talkAvailable === true;
  const birdLabel = t(talk ? "talk.birdLabelHold" : "talk.birdLabel", lang);
  // New shell (sheet, phone review 2026-10-29): the bird is the header's one
  // button. A tap opens the shell's "Notifications and settings" sheet
  // (shell/chrome.js, which holds tamagotchiTrayHtml); a long-press still
  // talks to Crow. The badge stays on the bird.
  const birdAttrs = sheet
    ? `aria-haspopup="dialog" aria-controls="shell-avatar" aria-expanded="false" data-shell-tray="crow-dropdown" aria-label="${t("shell.notifSettings", lang)}" title="${t("shell.notifSettings", lang)}"${talk ? ` aria-describedby="crow-bird-hold-desc"` : ""}`
    : `aria-haspopup="true" aria-controls="crow-dropdown" aria-expanded="false" aria-label="${birdLabel}" title="${birdLabel}"`;
  return `
<div class="crow-tama-wrap" id="crow-tama-wrap">
  <button type="button" class="crow-tama-btn" id="crow-bird-btn" onclick="toggleCrowDropdown(event)" ${birdAttrs}${talk ? " data-crow-talk" : ""}>
  <svg class="crow-tama crow-happy" id="crow-tama" viewBox="0 0 48 56" width="42" height="49" aria-hidden="true" focusable="false">
    ${CROW_BODY_GROUP}
    <!-- Thought bubble (notification count) -->
    <g class="crow-bubble" id="crow-bubble" style="display:none">
      <rect x="32" y="0" width="16" height="14" rx="5" fill="var(--crow-bg-surface, #22303a)" stroke="var(--crow-border, #2a2a3e)" stroke-width="1"/>
      <text class="crow-bubble-count" id="crow-bubble-count" x="40" y="10.5" text-anchor="middle" fill="#d9a521" font-size="9" font-weight="700" font-family="'JetBrains Mono',monospace">0</text>
    </g>
    <!-- Alarmed exclamation -->
    <text class="crow-exclaim" id="crow-exclaim" style="display:none" x="6" y="12" fill="#ef4444" font-size="14" font-weight="900" font-family="var(--crow-body-font)">!</text>
  </svg>
  </button>${sheet ? (talk ? `<span id="crow-bird-hold-desc" hidden>${t("shell.notifSettingsHold", lang)}</span>` : "") : tamagotchiTrayHtml(lang, { talkAvailable })}
</div>
`;
}

/** The bird's tray: the Talk row (when armed), status, health and the list. */
export function tamagotchiTrayHtml(lang, { talkAvailable } = {}) {
  const talk = talkAvailable === true;
  return `
  <!-- Combined dropdown -->
  <div id="crow-dropdown" class="crow-dropdown" style="display:none" onclick="event.stopPropagation()">${talk ? crowTalkRowHtml(lang, { holdTarget: "bird" }) : ""}
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
    <div id="notif-list" class="dropdown-body" aria-live="polite" aria-atomic="false">${t("common.loading", lang)}</div>
  </div>`;
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
  /* The bird is a real button (keyboard + screen reader), with none of a button's chrome. */
  .crow-tama-btn {
    display: flex;
    align-items: center;
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: 10px;
    background: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
    overflow: visible;
  }
  .crow-tama-btn:focus-visible { outline: 2px solid var(--crow-accent); outline-offset: 2px; }

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
  .crow-happy #crow-tama-bird {
    animation: crow-bounce-happy 2s ease-in-out infinite;
  }
  .crow-happy .crow-eye {
    animation: crow-blink 4s step-end infinite;
  }
  .crow-happy .crow-wing {
    animation: none;
  }
  .crow-happy .crow-beak {
    fill: #d9a521;
  }

  /* ─ Tired mood ─ */
  .crow-tired .crow-body-group {
    animation: crow-bounce-tired 3s ease-in-out infinite;
  }
  .crow-tired #crow-tama-bird {
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
  .crow-alarmed #crow-tama-bird {
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
    .crow-dropdown { position: fixed; top: auto; bottom: calc(60px + var(--crow-player-h,0px)); right: 8px; left: 8px; min-width: auto; max-width: none; }
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

  function setCrowDropdown(open) {
    var dd = document.getElementById('crow-dropdown');
    if (!dd) return;
    // New shell: the tray lives in the open "Notifications and settings"
    // sheet, which owns its state until it closes (shell/client.js).
    if (!open && dd.closest && dd.closest('dialog[open]')) return;
    dd.style.display = open ? 'block' : 'none';
    var bird = document.getElementById('crow-bird-btn');
    if (bird) bird.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) loadNotifications();
  }

  function toggleCrowDropdown(e) {
    e.stopPropagation();
    // The click that only ended a long-press (Talk to Crow) is not a tap.
    if (window.crowTalkSwallowTap && window.crowTalkSwallowTap()) return;
    var dd = document.getElementById('crow-dropdown');
    setCrowDropdown(!dd || dd.style.display === 'none');
  }

  document.addEventListener('click', function() { setCrowDropdown(false); });

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

  // ── ramble bird integration (Task 12: header crow draws your hatched bird) ──
  // The header crow's animation mood (bounce/droop, driven by updateCrowMood
  // above) stays tied to HOST health, unchanged. Once a bird is hatched, the
  // bird's own drawn face is a SEPARATE concern driven by the pet's energy,
  // fetched here on the same poll cadence. Any non-200/error/absent bird
  // (login page, ramble not installed, static route 401) is silently a
  // no-op — the classic crow stays exactly as it was.
  // This script runs once per document, but a Turbo visit (Chat, Board and
  // Make are Turbo visits) swaps in a new header holding the default crow:
  // turbo:render redraws the known bird into it at once, then re-checks the
  // pet. One path for every page that carries the header.
  var _rambleBirdSpecies = null;
  var _rambleBirdSeed = null;
  var _rambleBirdMood = null;
  var _rambleBirdOutfit = null;
  var _rambleBirdOutfitObj = null;
  var _rambleBirdFailed = false;

  /** Is the bird drawn in THIS page's header (not only in a header Turbo swapped out)? */
  function _rambleBirdOnPage() {
    var b = document.getElementById('crow-tama-bird');
    return !!(b && b.firstChild && b.firstChild.firstChild);
  }

  function _rambleBirdLoadEngine(cb) {
    if (window.RambleBird) { cb(); return; }
    if (_rambleBirdFailed || window.__rambleBirdLoading) return;
    window.__rambleBirdLoading = true;
    var s = document.createElement('script');
    s.src = '/ramble/static/bird-svg.js';
    s.onload = function() {
      window.__rambleBirdLoading = false;
      if (window.RambleBird) { cb(); } else { _rambleBirdFailed = true; }
    };
    s.onerror = function() {
      window.__rambleBirdLoading = false;
      _rambleBirdFailed = true;
    };
    document.head.appendChild(s);
  }

  function _drawRambleBird(species, seed, mood, outfit) {
    var svg = document.getElementById('crow-tama');
    if (!svg) return;
    var bodyGroup = svg.querySelector('.crow-body-group');
    var bird = document.getElementById('crow-tama-bird');
    var inner;
    if (!bird) {
      // Outer <g id="crow-tama-bird"> carries the mood CSS animation (see
      // tamagotchiCss); the inner <g> carries the static placement
      // transform. Splitting them keeps the CSS animation transform
      // keyframes from fighting the placement's own transform attribute.
      bird = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      bird.setAttribute('id', 'crow-tama-bird');
      inner = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      inner.setAttribute('transform', 'translate(0 4) scale(0.24)');
      bird.appendChild(inner);
      if (bodyGroup && bodyGroup.nextSibling) {
        svg.insertBefore(bird, bodyGroup.nextSibling);
      } else if (bodyGroup) {
        svg.appendChild(bird);
      } else {
        svg.insertBefore(bird, svg.firstChild);
      }
    } else {
      inner = bird.firstChild;
    }
    if (!inner) return;
    try {
      var g = RambleBird.rollGenome(seed, species);
      if (outfit && typeof RambleBird.applyOutfit === 'function') g = RambleBird.applyOutfit(g, outfit);
      inner.innerHTML = RambleBird.drawBird(g, mood);
    } catch (e) {
      return;
    }
    // Only hide the classic crow once a bird has actually been drawn.
    if (bodyGroup) bodyGroup.style.display='none';
  }

  async function refreshRambleBird() {
    try {
      var resp = await fetch('/api/ramble/pet', { credentials: 'same-origin' });
      if (!resp.ok) return;
      var data = await resp.json();
      if (!data || !data.bird) return;

      var species = data.bird.species;
      var seed = data.bird.seed;
      var energy = data.energy || 0;
      var mood = energy >= 60 ? 'happy' : (energy >= 30 ? 'tired' : 'alarmed');
      var outfit = data.bird.outfit || null;
      var outfitKey = outfit ? JSON.stringify(outfit) : '';

      if (species === _rambleBirdSpecies && seed === _rambleBirdSeed && mood === _rambleBirdMood && outfitKey === _rambleBirdOutfit && _rambleBirdOnPage()) return;

      _rambleBirdLoadEngine(function() {
        if (!window.RambleBird) return;
        _drawRambleBird(species, seed, mood, outfit);
        _rambleBirdSpecies = species;
        _rambleBirdSeed = seed;
        _rambleBirdMood = mood;
        _rambleBirdOutfit = outfitKey;
        _rambleBirdOutfitObj = outfit;
      });
    } catch (e) {}
  }
  document.addEventListener('turbo:render', function() {
    if (_rambleBirdSpecies !== null && window.RambleBird && !_rambleBirdOnPage()) {
      _drawRambleBird(_rambleBirdSpecies, _rambleBirdSeed, _rambleBirdMood, _rambleBirdOutfitObj);
    }
    refreshRambleBird();
  });
  // ── end ramble bird integration ──

  async function pollNotifications() {
    if (!_tabVisible) return;
    try {
      var resp = await fetch('/api/notifications/count');
      if (!resp.ok) return;
      var data = await resp.json();

      checkForCallNotifications(data.count);
      // The new shell's mascot also counts the health issues in its sheet's
      // "Needs attention" group; the classic bird and bell keep the plain count.
      updateCrowBubble(data.count + (document.body.classList.contains('shell') ? (Number(data.attention) || 0) : 0));
      updateCrowMood(data.health);
      updateCrowHealthBar(data.health);
      refreshRambleBird();
    } catch(e) {}
  }

  pollNotifications();
  refreshRambleBird();
  // 5-min fallback poll. Live updates come via the Turbo Stream at
  // /dashboard/streams/notifications; this interval is a safety net
  // for transient SSE drops and is intentionally slow.
  if (!window.__crowNotifPollInterval) {
    window.__crowNotifPollInterval = setInterval(pollNotifications, 300000);
    _notifPollTimer = window.__crowNotifPollInterval;
  }
  window.dismissAllNotifications = dismissAllNotifications;
  window.toggleCrowDropdown = toggleCrowDropdown;
})();
`;
}
