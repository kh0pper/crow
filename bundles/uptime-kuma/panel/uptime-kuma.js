/**
 * Crow's Nest Panel — Uptime Kuma: status card + web UI embed
 *
 * Client-side JS uses textContent + createElement only (no innerHTML) for
 * XSS safety, matching other Crow bundle panels.
 */

export default {
  id: "uptime-kuma",
  name: "Uptime Kuma",
  icon: "activity",
  route: "/dashboard/uptime-kuma",
  navOrder: 63,
  category: "infrastructure",

  async handler(req, res, { layout, appRoot }) {
    const { pathToFileURL } = await import("node:url");
    const { join } = await import("node:path");

    const componentsPath = join(appRoot, "servers/gateway/dashboard/shared/components.js");
    const { escapeHtml } = await import(pathToFileURL(componentsPath).href);

    const tab = req.query.tab || "overview";
    const tabs = [
      { id: "overview", label: "Overview" },
      { id: "webui", label: "Web UI" },
    ];

    const tabBar = `<div class="uk-tabs">${tabs.map((t) =>
      `<a href="?tab=${escapeHtml(t.id)}" class="uk-tab${tab === t.id ? " active" : ""}">${escapeHtml(t.label)}</a>`
    ).join("")}</div>`;

    let body;
    if (tab === "webui") {
      const ukUrl = process.env.UPTIMEKUMA_URL || "http://localhost:3007";
      body = `<div class="uk-webui"><iframe src="${escapeHtml(ukUrl)}" class="uk-iframe" allow="fullscreen"></iframe></div>`;
    } else {
      body = renderOverview();
    }

    const content = `
      <style>${styles()}</style>
      <div class="uk-panel">
        <h1>Uptime Kuma <span class="uk-subtitle">service monitoring</span></h1>
        ${tabBar}
        <div class="uk-body">${body}</div>
      </div>
      <script>${script()}</script>
    `;

    res.send(layout({ title: "Uptime Kuma", content }));
  },
};

function renderOverview() {
  return `
    <div class="uk-overview">
      <div class="uk-section">
        <h3>Status</h3>
        <div id="uk-status" class="uk-status"><div class="np-loading">Checking reachability...</div></div>
      </div>
      <div class="uk-section">
        <h3>Monitors</h3>
        <div id="uk-monitors" class="uk-monitors"><div class="np-loading">Loading monitor metrics...</div></div>
      </div>
      <div class="uk-section uk-notes">
        <h3>Notes</h3>
        <ul>
          <li>Create the admin account in the Web UI tab on first use.</li>
          <li>Set <code>UPTIMEKUMA_USERNAME</code> and <code>UPTIMEKUMA_PASSWORD</code> in Crow settings to see monitor details here.</li>
          <li>Monitor creation, pause/resume, and alerts are done in the Uptime Kuma web UI (socket.io API, not REST).</li>
        </ul>
      </div>
    </div>
  `;
}

function script() {
  return `
    function setText(el, text) { el.textContent = ''; el.appendChild(document.createTextNode(text)); }
    function makeDiv(cls, text) {
      const d = document.createElement('div');
      if (cls) d.className = cls;
      if (text !== undefined) d.textContent = text;
      return d;
    }

    async function loadStatus() {
      const el = document.getElementById('uk-status');
      if (!el) return;
      try {
        const r = await fetch('/api/uptime-kuma/status');
        const data = await r.json();
        el.textContent = '';
        if (data.error) {
          el.appendChild(makeDiv('np-error', data.error));
          return;
        }
        const card = makeDiv('stat-card ' + (data.reachable ? 'stat-ok' : 'stat-warn'));
        card.appendChild(makeDiv('stat-value', data.reachable ? 'Online' : 'Offline'));
        card.appendChild(makeDiv('stat-label', 'HTTP ' + data.http_status));
        el.appendChild(card);
        const urlRow = makeDiv('uk-url', data.base_url || '');
        el.appendChild(urlRow);
      } catch (e) {
        el.textContent = '';
        el.appendChild(makeDiv('np-error', 'Cannot reach Uptime Kuma.'));
      }
    }

    async function loadMonitors() {
      const el = document.getElementById('uk-monitors');
      if (!el) return;
      try {
        const r = await fetch('/api/uptime-kuma/monitors');
        const data = await r.json();
        el.textContent = '';
        if (data.error) {
          el.appendChild(makeDiv('np-idle', data.error));
          return;
        }
        const monitors = Array.isArray(data.monitors) ? data.monitors : [];
        if (monitors.length === 0) {
          el.appendChild(makeDiv('np-idle', 'No monitors yet. Create one in the Web UI tab.'));
          return;
        }
        monitors.forEach(function(m) {
          const card = makeDiv('mon-card');
          const header = makeDiv('mon-header');
          const dot = makeDiv('mon-dot mon-' + m.status);
          header.appendChild(dot);
          const title = makeDiv('mon-title', m.name);
          header.appendChild(title);
          card.appendChild(header);
          const meta = makeDiv('mon-meta');
          const parts = [];
          if (m.type) parts.push(m.type);
          if (m.url) parts.push(m.url);
          else if (m.hostname) parts.push(m.hostname);
          if (m.response_time_ms !== null && m.response_time_ms !== undefined) {
            parts.push(m.response_time_ms + ' ms');
          }
          meta.textContent = parts.join(' \u00b7 ');
          card.appendChild(meta);
          el.appendChild(card);
        });
      } catch (e) {
        el.textContent = '';
        el.appendChild(makeDiv('np-error', 'Failed to load monitor metrics.'));
      }
    }

    loadStatus();
    loadMonitors();
  `;
}

function styles() {
  return `
    .uk-panel h1 { margin: 0 0 1rem; font-size: 1.5rem; }
    .uk-subtitle { font-size: 0.85rem; color: var(--crow-text-muted); font-weight: 400; margin-left: 0.5rem; }
    .uk-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--crow-border); margin-bottom: 1.5rem; }
    .uk-tab { padding: 0.6rem 1.2rem; color: var(--crow-text-secondary); text-decoration: none;
              border-bottom: 2px solid transparent; transition: all 0.2s; }
    .uk-tab:hover { color: var(--crow-text-primary); }
    .uk-tab.active { color: var(--crow-accent); border-bottom-color: var(--crow-accent); }
    .uk-overview { display: flex; flex-direction: column; gap: 1.5rem; }
    .uk-section h3 { font-size: 0.85rem; color: var(--crow-text-muted); text-transform: uppercase;
                     letter-spacing: 0.05em; margin: 0 0 0.8rem; }
    .uk-status { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
    .stat-card { background: var(--crow-bg-elevated); border-radius: 10px; padding: 1rem 1.2rem;
                 border: 1px solid var(--crow-border); min-width: 120px; text-align: center; }
    .stat-card.stat-warn { border-color: var(--crow-error); }
    .stat-card.stat-warn .stat-value { color: var(--crow-error); }
    .stat-card.stat-ok .stat-value { color: var(--crow-accent); }
    .stat-value { font-size: 1.4rem; font-weight: 700; }
    .stat-label { font-size: 0.8rem; color: var(--crow-text-muted); margin-top: 0.2rem; }
    .uk-url { font-family: var(--crow-font-mono, monospace); font-size: 0.85rem;
              color: var(--crow-text-muted); }
    .uk-monitors { display: flex; flex-direction: column; gap: 0.5rem; }
    .mon-card { background: var(--crow-bg-elevated); border-radius: 10px; padding: 0.8rem 1rem;
                border: 1px solid var(--crow-border); }
    .mon-header { display: flex; align-items: center; gap: 0.6rem; }
    .mon-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--crow-text-muted); }
    .mon-dot.mon-up { background: #22c55e; }
    .mon-dot.mon-down { background: #ef4444; }
    .mon-dot.mon-pending { background: #f59e0b; }
    .mon-dot.mon-maintenance { background: #3b82f6; }
    .mon-title { font-weight: 600; color: var(--crow-text-primary); }
    .mon-meta { font-size: 0.8rem; color: var(--crow-text-muted); margin-top: 0.3rem;
                font-family: var(--crow-font-mono, monospace); }
    .uk-notes ul { font-size: 0.9rem; color: var(--crow-text-secondary); line-height: 1.6;
                   padding-left: 1.2rem; }
    .uk-notes code { background: var(--crow-bg-elevated); padding: 0.1rem 0.4rem; border-radius: 4px;
                     font-size: 0.85em; }
    .np-idle, .np-loading { color: var(--crow-text-muted); font-size: 0.9rem; padding: 1rem;
                            background: var(--crow-bg-elevated); border-radius: 12px; text-align: center; }
    .np-error { color: var(--crow-error); font-size: 0.9rem; padding: 1rem;
                background: var(--crow-bg-elevated); border-radius: 12px; text-align: center; }
    .uk-webui { width: 100%; height: calc(100vh - 200px); min-height: 500px; }
    .uk-iframe { width: 100%; height: 100%; border: none; border-radius: 12px;
                 background: var(--crow-bg-elevated); }
  `;
}
