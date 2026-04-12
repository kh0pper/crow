/**
 * Crow's Nest Panel — AdGuard Home: stats overview + web UI.
 * XSS-safe: textContent + createElement only.
 */

export default {
  id: "adguard-home",
  name: "AdGuard Home",
  icon: "shield",
  route: "/dashboard/adguard-home",
  navOrder: 66,
  category: "networking",

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
    const tabBar = `<div class="ag-tabs">${tabs.map((t) =>
      `<a href="?tab=${escapeHtml(t.id)}" class="ag-tab${tab === t.id ? " active" : ""}">${escapeHtml(t.label)}</a>`
    ).join("")}</div>`;

    let body = "";
    if (tab === "webui") {
      const url = (process.env.ADGUARD_URL || "http://localhost:3020").replace(/\/+$/, "");
      body = `<div class="ag-webui"><iframe src="${escapeHtml(url)}" class="ag-iframe" allow="fullscreen"></iframe></div>`;
    } else {
      body = `
        <div class="ag-section">
          <h3>Status</h3>
          <div id="ag-status"><div class="np-loading">Loading…</div></div>
        </div>
        <div class="ag-section">
          <h3>Top Blocked Domains (24h)</h3>
          <div id="ag-blocked"><div class="np-loading">Loading…</div></div>
        </div>
      `;
    }

    const content = `
      <style>${styles()}</style>
      <div class="ag-panel">
        <h1>AdGuard Home <span class="ag-subtitle">DNS filtering</span></h1>
        ${tabBar}
        <div class="ag-body">${body}</div>
      </div>
      <script>${script()}</script>
    `;
    res.send(layout({ title: "AdGuard Home", content }));
  },
};

function script() {
  return `
    function clearNode(el) { while (el.firstChild) el.removeChild(el.firstChild); }
    function errorNode(msg) { const d = document.createElement('div'); d.className = 'np-error'; d.textContent = msg; return d; }
    function idleNode(msg) { const d = document.createElement('div'); d.className = 'np-idle'; d.textContent = msg; return d; }

    function statCard(label, value, warnClass) {
      const c = document.createElement('div');
      c.className = 'ag-card' + (warnClass ? ' ' + warnClass : '');
      const v = document.createElement('div');
      v.className = 'ag-val';
      v.textContent = value == null ? '—' : String(value);
      c.appendChild(v);
      const l = document.createElement('div');
      l.className = 'ag-label';
      l.textContent = label;
      c.appendChild(l);
      return c;
    }

    async function loadStatus() {
      const el = document.getElementById('ag-status');
      if (!el) return;
      clearNode(el);
      try {
        const res = await fetch('/api/adguard/status');
        const d = await res.json();
        if (d.error) { el.appendChild(errorNode(d.error)); return; }
        const grid = document.createElement('div');
        grid.className = 'ag-grid';
        grid.appendChild(statCard('Version', d.version || '—'));
        grid.appendChild(statCard('Protection', d.protection_enabled ? 'On' : 'Off', d.protection_enabled ? '' : 'ag-warn'));
        grid.appendChild(statCard('Queries (24h)', d.num_dns_queries_today != null ? d.num_dns_queries_today.toLocaleString() : '—'));
        grid.appendChild(statCard('Blocked (24h)', d.num_blocked_filtering_today != null ? d.num_blocked_filtering_today.toLocaleString() : '—'));
        grid.appendChild(statCard('Filter Lists', (d.filter_lists_enabled ?? 0) + '/' + (d.filter_lists_total ?? 0)));
        grid.appendChild(statCard('Rules', d.filter_rules_total != null ? d.filter_rules_total.toLocaleString() : '—'));
        el.appendChild(grid);
      } catch (e) {
        el.appendChild(errorNode('Cannot reach AdGuard Home.'));
      }
    }

    async function loadBlocked() {
      const el = document.getElementById('ag-blocked');
      if (!el) return;
      clearNode(el);
      try {
        const res = await fetch('/api/adguard/top-blocked');
        const d = await res.json();
        if (d.error) { el.appendChild(errorNode(d.error)); return; }
        const items = d.top_blocked || [];
        if (items.length === 0) { el.appendChild(idleNode('No blocked queries yet (needs real DNS traffic).')); return; }
        items.forEach(function (item) {
          const row = document.createElement('div');
          row.className = 'ag-row';
          const name = document.createElement('span');
          name.textContent = item.name;
          const count = document.createElement('span');
          count.className = 'ag-count';
          count.textContent = item.count.toLocaleString();
          row.appendChild(name);
          row.appendChild(count);
          el.appendChild(row);
        });
      } catch (e) {
        el.appendChild(errorNode('Failed to load blocked domains.'));
      }
    }

    if (document.getElementById('ag-status')) loadStatus();
    if (document.getElementById('ag-blocked')) loadBlocked();
  `;
}

function styles() {
  return `
    .ag-panel h1 { margin: 0 0 1rem; font-size: 1.5rem; }
    .ag-subtitle { font-size: .85rem; color: var(--crow-text-muted); font-weight: 400; margin-left: .5rem; }
    .ag-tabs { display: flex; border-bottom: 1px solid var(--crow-border); margin-bottom: 1.5rem; }
    .ag-tab { padding: .6rem 1.2rem; color: var(--crow-text-secondary); text-decoration: none;
              border-bottom: 2px solid transparent; }
    .ag-tab.active { color: var(--crow-accent); border-bottom-color: var(--crow-accent); }
    .ag-section { margin-bottom: 1.6rem; }
    .ag-section h3 { font-size: .8rem; color: var(--crow-text-muted); text-transform: uppercase;
                     letter-spacing: .05em; margin: 0 0 .6rem; }
    .ag-grid { display: flex; gap: 1rem; flex-wrap: wrap; }
    .ag-card { background: var(--crow-bg-elevated); border: 1px solid var(--crow-border);
               border-radius: 10px; padding: 1rem 1.2rem; min-width: 120px; text-align: center; }
    .ag-card.ag-warn { border-color: #f59e0b; }
    .ag-card.ag-warn .ag-val { color: #f59e0b; }
    .ag-val { font-size: 1.4rem; font-weight: 700; color: var(--crow-accent); }
    .ag-label { font-size: .8rem; color: var(--crow-text-muted); margin-top: .2rem; }
    .ag-row { display: flex; justify-content: space-between; padding: .4rem .7rem; border-radius: 6px;
              background: var(--crow-bg-elevated); margin-bottom: .3rem; font-size: .9rem; }
    .ag-count { color: var(--crow-accent); font-family: ui-monospace, monospace; }
    .ag-webui { width: 100%; height: calc(100vh - 220px); min-height: 500px; }
    .ag-iframe { width: 100%; height: 100%; border: none; border-radius: 10px; background: var(--crow-bg-elevated); }
    .np-idle, .np-loading { color: var(--crow-text-muted); padding: 1rem;
                            background: var(--crow-bg-elevated); border-radius: 10px; text-align: center; }
    .np-error { color: #ef4444; padding: 1rem;
                background: var(--crow-bg-elevated); border-radius: 10px; text-align: center; }
  `;
}
