/**
 * Crow's Nest Panel — Change Detection: watch list + iframe to web UI.
 * XSS-safe client rendering (textContent + createElement only).
 */

export default {
  id: "changedetection",
  name: "Change Detection",
  icon: "eye",
  route: "/dashboard/changedetection",
  navOrder: 65,
  category: "automation",

  async handler(req, res, { layout, appRoot }) {
    const { pathToFileURL } = await import("node:url");
    const { join } = await import("node:path");
    const componentsPath = join(appRoot, "servers/gateway/dashboard/shared/components.js");
    const { escapeHtml } = await import(pathToFileURL(componentsPath).href);

    const tab = req.query.tab || "overview";
    const tabs = [
      { id: "overview", label: "Watches" },
      { id: "webui", label: "Web UI" },
    ];
    const tabBar = `<div class="cd-tabs">${tabs.map((t) =>
      `<a href="?tab=${escapeHtml(t.id)}" class="cd-tab${tab === t.id ? " active" : ""}">${escapeHtml(t.label)}</a>`
    ).join("")}</div>`;

    let body;
    if (tab === "webui") {
      const cdUrl = process.env.CHANGEDETECTION_URL || "http://localhost:5010";
      body = `<div class="cd-webui"><iframe src="${escapeHtml(cdUrl)}" class="cd-iframe" allow="fullscreen"></iframe></div>`;
    } else {
      body = `
        <div class="cd-section">
          <h3>Watches</h3>
          <div id="cd-watches" class="cd-list"><div class="np-loading">Loading watches...</div></div>
        </div>
        <div class="cd-section cd-notes">
          <h3>Notes</h3>
          <ul>
            <li>Set <code>CHANGEDETECTION_API_KEY</code> in Crow settings (create one under Settings &gt; API in the web UI).</li>
            <li>Add and edit watches in the web UI tab; this view is read-only.</li>
          </ul>
        </div>
      `;
    }

    const content = `
      <style>${styles()}</style>
      <div class="cd-panel">
        <h1>Change Detection <span class="cd-subtitle">watch webpages for changes</span></h1>
        ${tabBar}
        <div class="cd-body">${body}</div>
      </div>
      <script>${script()}</script>
    `;
    res.send(layout({ title: "Change Detection", content }));
  },
};

function script() {
  return `
    function makeDiv(cls, text) {
      const d = document.createElement('div');
      if (cls) d.className = cls;
      if (text !== undefined) d.textContent = text;
      return d;
    }
    function formatAgo(iso) {
      if (!iso) return 'never';
      const diff = Date.now() - new Date(iso).getTime();
      if (isNaN(diff)) return iso;
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return 'just now';
      if (mins < 60) return mins + 'm ago';
      const hrs = Math.floor(mins / 60);
      if (hrs < 24) return hrs + 'h ago';
      const days = Math.floor(hrs / 24);
      return days + 'd ago';
    }
    async function loadWatches() {
      const el = document.getElementById('cd-watches');
      if (!el) return;
      try {
        const r = await fetch('/api/changedetection/watches');
        const data = await r.json();
        el.textContent = '';
        if (data.error) {
          el.appendChild(makeDiv('np-error', data.error));
          return;
        }
        const watches = Array.isArray(data.watches) ? data.watches : [];
        if (watches.length === 0) {
          el.appendChild(makeDiv('np-idle', 'No watches configured yet. Add one from the Web UI tab.'));
          return;
        }
        watches.forEach(function(w) {
          const card = makeDiv('cd-card');
          const header = document.createElement('div');
          header.className = 'cd-card-header';
          const dot = makeDiv('cd-dot ' + (w.paused ? 'cd-paused' : (w.last_error ? 'cd-err' : 'cd-ok')));
          header.appendChild(dot);
          const link = document.createElement('a');
          link.className = 'cd-title';
          link.href = w.url || '#';
          link.target = '_blank';
          link.rel = 'noopener';
          link.textContent = w.title || w.url || '(untitled)';
          header.appendChild(link);
          card.appendChild(header);

          const meta = makeDiv('cd-meta');
          const parts = [];
          if (w.url && w.title) parts.push(w.url);
          parts.push('checked ' + formatAgo(w.last_checked));
          parts.push('changed ' + formatAgo(w.last_changed));
          if (w.tag) parts.push('tag: ' + w.tag);
          if (w.paused) parts.push('paused');
          meta.textContent = parts.join(' \u00b7 ');
          card.appendChild(meta);

          if (w.last_error) {
            card.appendChild(makeDiv('cd-err-text', 'Error: ' + w.last_error));
          }

          el.appendChild(card);
        });
      } catch (e) {
        el.textContent = '';
        el.appendChild(makeDiv('np-error', 'Failed to load watches.'));
      }
    }
    loadWatches();
  `;
}

function styles() {
  return `
    .cd-panel h1 { margin: 0 0 1rem; font-size: 1.5rem; }
    .cd-subtitle { font-size: 0.85rem; color: var(--crow-text-muted); font-weight: 400; margin-left: 0.5rem; }
    .cd-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--crow-border); margin-bottom: 1.5rem; }
    .cd-tab { padding: 0.6rem 1.2rem; color: var(--crow-text-secondary); text-decoration: none;
              border-bottom: 2px solid transparent; transition: all 0.2s; }
    .cd-tab:hover { color: var(--crow-text-primary); }
    .cd-tab.active { color: var(--crow-accent); border-bottom-color: var(--crow-accent); }
    .cd-section h3 { font-size: 0.85rem; color: var(--crow-text-muted); text-transform: uppercase;
                     letter-spacing: 0.05em; margin: 0 0 0.8rem; }
    .cd-section { margin-bottom: 1.5rem; }
    .cd-list { display: flex; flex-direction: column; gap: 0.5rem; }
    .cd-card { background: var(--crow-bg-elevated); border-radius: 10px; padding: 0.8rem 1rem;
               border: 1px solid var(--crow-border); }
    .cd-card-header { display: flex; align-items: center; gap: 0.6rem; }
    .cd-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--crow-text-muted); flex: 0 0 auto; }
    .cd-dot.cd-ok { background: #22c55e; }
    .cd-dot.cd-err { background: #ef4444; }
    .cd-dot.cd-paused { background: #f59e0b; }
    .cd-title { font-weight: 600; color: var(--crow-text-primary); text-decoration: none; word-break: break-all; }
    .cd-title:hover { text-decoration: underline; }
    .cd-meta { font-size: 0.8rem; color: var(--crow-text-muted); margin-top: 0.3rem; word-break: break-all; }
    .cd-err-text { color: var(--crow-error); font-size: 0.85rem; margin-top: 0.3rem; word-break: break-word; }
    .cd-notes ul { font-size: 0.9rem; color: var(--crow-text-secondary); line-height: 1.6; padding-left: 1.2rem; }
    .cd-notes code { background: var(--crow-bg-elevated); padding: 0.1rem 0.4rem; border-radius: 4px; font-size: 0.85em; }
    .np-idle, .np-loading { color: var(--crow-text-muted); font-size: 0.9rem; padding: 1rem;
                            background: var(--crow-bg-elevated); border-radius: 12px; text-align: center; }
    .np-error { color: var(--crow-error); font-size: 0.9rem; padding: 1rem;
                background: var(--crow-bg-elevated); border-radius: 12px; text-align: center; }
    .cd-webui { width: 100%; height: calc(100vh - 200px); min-height: 500px; }
    .cd-iframe { width: 100%; height: 100%; border: none; border-radius: 12px;
                 background: var(--crow-bg-elevated); }
  `;
}
