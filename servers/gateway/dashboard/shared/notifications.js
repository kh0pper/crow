/**
 * Header Notification Bell + Health Status Icons
 *
 * Provides HTML for the header icons and polling JS.
 * Injected into every dashboard page via the headerIcons + scripts slots.
 *
 * Security: All user-generated content (notification titles, bodies) is escaped
 * via escapeNotifHtml() before DOM insertion. Health data is numeric only.
 */

export const headerIconsHtml = `
<div class="header-icon-btn" id="health-icon-btn" onclick="toggleHealthDropdown(event)" title="System health">
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
  </svg>
  <span id="health-label" class="health-label">--</span>
  <div id="health-dropdown" class="header-dropdown" style="display:none">
    <div class="dropdown-title">System Health</div>
    <div id="health-stats" class="dropdown-body">Loading...</div>
  </div>
</div>
<div class="header-icon-btn" id="notif-icon-btn" onclick="toggleNotifDropdown(event)" title="Notifications">
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
    <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
  </svg>
  <span id="notif-badge" class="notif-badge" style="display:none">0</span>
  <div id="notif-dropdown" class="header-dropdown notif-dropdown" style="display:none">
    <div class="dropdown-title">Notifications <button class="btn btn-sm btn-secondary" onclick="dismissAllNotifications(event)">Clear all</button></div>
    <div id="notif-list" class="dropdown-body">Loading...</div>
  </div>
</div>
`;

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
  @media (max-width: 768px) {
    .header-dropdown { position: fixed; top: auto; bottom: 60px; right: 8px; left: 8px; min-width: auto; max-width: none; }
    .health-label { display: none; }
  }
`;

export const headerIconsJs = `
  let _notifPollTimer = null;
  let _tabVisible = true;

  document.addEventListener('visibilitychange', function() {
    _tabVisible = !document.hidden;
    if (_tabVisible) pollNotifications();
  });

  function toggleHealthDropdown(e) {
    e.stopPropagation();
    var dd = document.getElementById('health-dropdown');
    var notifDd = document.getElementById('notif-dropdown');
    notifDd.style.display = 'none';
    dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
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
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    return Math.floor(hrs / 24) + 'd ago';
  }

  async function pollNotifications() {
    if (!_tabVisible) return;
    try {
      var resp = await fetch('/api/notifications/count');
      if (!resp.ok) return;
      var data = await resp.json();

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
          ['RAM', data.health.ram_used_mb + ' / ' + data.health.ram_total_mb + ' MB (' + pct + '%)'],
          ['CPUs', '' + data.health.cpus],
          ['Uptime', formatUptime(data.health.uptime_seconds)]
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

  async function loadNotifications() {
    var list = document.getElementById('notif-list');
    try {
      var resp = await fetch('/api/notifications?unread_only=true&limit=20');
      if (!resp.ok) { list.textContent = 'Error loading'; return; }
      var data = await resp.json();

      if (!data.notifications || data.notifications.length === 0) {
        list.textContent = '';
        var empty = document.createElement('div');
        empty.style.cssText = 'color:var(--crow-text-muted);text-align:center;padding:1rem';
        empty.textContent = 'No notifications';
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
        dismiss.title = 'Dismiss';
        dismiss.textContent = '\\u00D7';
        dismiss.onclick = function(e) { dismissNotification(e, n.id); };
        item.appendChild(dismiss);

        list.appendChild(item);
      });
    } catch(e) {
      list.textContent = 'Failed to load';
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

  pollNotifications();
  _notifPollTimer = setInterval(pollNotifications, 60000);
`;
