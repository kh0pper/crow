/**
 * Crow's Nest Panel — Netdata: status card + embedded web UI
 * XSS-safe: textContent + createElement only.
 */

export default {
  id: "netdata",
  name: "Netdata",
  icon: "activity",
  route: "/dashboard/netdata",
  navOrder: 64,
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
    const tabBar = `<div class="nd-tabs">${tabs.map((t) =>
      `<a href="?tab=${escapeHtml(t.id)}" class="nd-tab${tab === t.id ? " active" : ""}">${escapeHtml(t.label)}</a>`
    ).join("")}</div>`;

    let body = "";
    if (tab === "webui") {
      const url = (process.env.NETDATA_URL || "http://localhost:19999").replace(/\/+$/, "");
      body = `<div class="nd-webui"><iframe src="${escapeHtml(url)}" class="nd-iframe" allow="fullscreen"></iframe></div>`;
    } else {
      body = `
        <div class="nd-section">
          <h3>Status</h3>
          <div id="nd-status"><div class="np-loading">Loading…</div></div>
        </div>
        <div class="nd-section">
          <h3>Raised Alarms</h3>
          <div id="nd-alarms"><div class="np-loading">Loading…</div></div>
        </div>
      `;
    }

    const content = `
      <style>${styles()}</style>
      <div class="nd-panel">
        <h1>Netdata <span class="nd-subtitle">real-time metrics</span></h1>
        ${tabBar}
        <div class="nd-body">${body}</div>
      </div>
      <script>${script()}</script>
    `;
    res.send(layout({ title: "Netdata", content }));
  },
};

function script() {
  return `
    function clearNode(el) { while (el.firstChild) el.removeChild(el.firstChild); }
    function errorNode(msg) { const d = document.createElement('div'); d.className = 'np-error'; d.textContent = msg; return d; }
    function idleNode(msg) { const d = document.createElement('div'); d.className = 'np-idle'; d.textContent = msg; return d; }

    function statCard(label, value) {
      const c = document.createElement('div');
      c.className = 'nd-card';
      const v = document.createElement('div');
      v.className = 'nd-val';
      v.textContent = value == null ? '—' : String(value);
      c.appendChild(v);
      const l = document.createElement('div');
      l.className = 'nd-label';
      l.textContent = label;
      c.appendChild(l);
      return c;
    }

    async function loadStatus() {
      const el = document.getElementById('nd-status');
      if (!el) return;
      clearNode(el);
      try {
        const res = await fetch('/api/netdata/status');
        const d = await res.json();
        if (d.error) { el.appendChild(errorNode(d.error)); return; }
        const grid = document.createElement('div');
        grid.className = 'nd-grid';
        grid.appendChild(statCard('Version', d.version || '—'));
        grid.appendChild(statCard('Charts', d.charts_available ?? '—'));
        grid.appendChild(statCard('Cores', d.cores ?? '—'));
        grid.appendChild(statCard('Alarms (raised)', d.raised_alarms ?? 0));
        el.appendChild(grid);
      } catch (e) {
        el.appendChild(errorNode('Cannot reach Netdata.'));
      }
    }

    async function loadAlarms() {
      const el = document.getElementById('nd-alarms');
      if (!el) return;
      clearNode(el);
      try {
        const res = await fetch('/api/netdata/alarms');
        const d = await res.json();
        if (d.error) { el.appendChild(errorNode(d.error)); return; }
        const alarms = d.alarms || [];
        if (alarms.length === 0) { el.appendChild(idleNode('All clear — no alarms raised.')); return; }
        alarms.forEach(function (a) {
          const card = document.createElement('div');
          card.className = 'nd-alarm nd-alarm-' + (a.status || 'unknown').toLowerCase();
          const t = document.createElement('div');
          t.className = 'nd-alarm-title';
          t.textContent = a.name + ' (' + a.status + ')';
          card.appendChild(t);
          const sub = document.createElement('div');
          sub.className = 'nd-alarm-meta';
          sub.textContent = (a.chart || '') + ' · ' + (a.value != null ? a.value + ' ' + (a.units || '') : '');
          card.appendChild(sub);
          if (a.info) {
            const info = document.createElement('div');
            info.className = 'nd-alarm-info';
            info.textContent = a.info;
            card.appendChild(info);
          }
          el.appendChild(card);
        });
      } catch (e) {
        el.appendChild(errorNode('Failed to load alarms.'));
      }
    }

    if (document.getElementById('nd-status')) loadStatus();
    if (document.getElementById('nd-alarms')) loadAlarms();
  `;
}

function styles() {
  return `
    .nd-panel h1 { margin: 0 0 1rem; font-size: 1.5rem; }
    .nd-subtitle { font-size: .85rem; color: var(--crow-text-muted); font-weight: 400; margin-left: .5rem; }
    .nd-tabs { display: flex; border-bottom: 1px solid var(--crow-border); margin-bottom: 1.5rem; }
    .nd-tab { padding: .6rem 1.2rem; color: var(--crow-text-secondary); text-decoration: none;
              border-bottom: 2px solid transparent; }
    .nd-tab.active { color: var(--crow-accent); border-bottom-color: var(--crow-accent); }
    .nd-section { margin-bottom: 1.6rem; }
    .nd-section h3 { font-size: .8rem; color: var(--crow-text-muted); text-transform: uppercase;
                     letter-spacing: .05em; margin: 0 0 .6rem; }
    .nd-grid { display: flex; gap: 1rem; flex-wrap: wrap; }
    .nd-card { background: var(--crow-bg-elevated); border: 1px solid var(--crow-border);
               border-radius: 10px; padding: 1rem 1.2rem; min-width: 120px; text-align: center; }
    .nd-val { font-size: 1.4rem; font-weight: 700; color: var(--crow-accent); }
    .nd-label { font-size: .8rem; color: var(--crow-text-muted); margin-top: .2rem; }
    .nd-alarm { border: 1px solid var(--crow-border); background: var(--crow-bg-elevated);
                border-radius: 10px; padding: 1rem; margin-bottom: .6rem; }
    .nd-alarm-warning { border-color: #f59e0b; }
    .nd-alarm-critical { border-color: #ef4444; }
    .nd-alarm-title { font-weight: 600; color: var(--crow-text-primary); }
    .nd-alarm-meta { font-size: .85rem; color: var(--crow-text-muted); margin-top: .2rem; }
    .nd-alarm-info { font-size: .85rem; color: var(--crow-text-secondary); margin-top: .4rem; }
    .nd-webui { width: 100%; height: calc(100vh - 220px); min-height: 500px; }
    .nd-iframe { width: 100%; height: 100%; border: none; border-radius: 10px; background: var(--crow-bg-elevated); }
    .np-idle, .np-loading { color: var(--crow-text-muted); padding: 1rem;
                            background: var(--crow-bg-elevated); border-radius: 10px; text-align: center; }
    .np-error { color: #ef4444; padding: 1rem;
                background: var(--crow-bg-elevated); border-radius: 10px; text-align: center; }
  `;
}
