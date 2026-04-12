/**
 * Crow's Nest Panel — Dozzle: status + embedded web UI.
 * XSS-safe: textContent + createElement only.
 */

export default {
  id: "dozzle",
  name: "Dozzle",
  icon: "file-text",
  route: "/dashboard/dozzle",
  navOrder: 65,
  category: "infrastructure",

  async handler(req, res, { layout, appRoot }) {
    const { pathToFileURL } = await import("node:url");
    const { join } = await import("node:path");
    const componentsPath = join(appRoot, "servers/gateway/dashboard/shared/components.js");
    const { escapeHtml } = await import(pathToFileURL(componentsPath).href);

    const url = (process.env.DOZZLE_URL || "http://localhost:8095").replace(/\/+$/, "");

    const content = `
      <style>${styles()}</style>
      <div class="dz-panel">
        <h1>Dozzle <span class="dz-subtitle">container log viewer</span></h1>
        <div class="dz-section">
          <h3>Status</h3>
          <div id="dz-status"><div class="np-loading">Loading…</div></div>
        </div>
        <div class="dz-section">
          <h3>Web UI</h3>
          <div class="dz-webui"><iframe src="${escapeHtml(url)}" class="dz-iframe" allow="fullscreen"></iframe></div>
        </div>
      </div>
      <script>${script()}</script>
    `;
    res.send(layout({ title: "Dozzle", content }));
  },
};

function script() {
  return `
    function clearNode(el) { while (el.firstChild) el.removeChild(el.firstChild); }
    function errorNode(msg) { const d = document.createElement('div'); d.className = 'np-error'; d.textContent = msg; return d; }

    async function loadStatus() {
      const el = document.getElementById('dz-status');
      clearNode(el);
      try {
        const res = await fetch('/api/dozzle/status');
        const d = await res.json();
        if (d.error) { el.appendChild(errorNode(d.error)); return; }
        const card = document.createElement('div');
        card.className = 'dz-card';
        const line = document.createElement('div');
        line.className = 'dz-row';
        const b = document.createElement('b');
        b.textContent = 'URL';
        line.appendChild(b);
        const v = document.createElement('span');
        v.textContent = d.url + ' · ' + (d.reachable ? 'reachable' : 'unreachable');
        line.appendChild(v);
        card.appendChild(line);
        el.appendChild(card);
      } catch (e) {
        el.appendChild(errorNode('Cannot reach Dozzle.'));
      }
    }

    loadStatus();
  `;
}

function styles() {
  return `
    .dz-panel h1 { margin: 0 0 1rem; font-size: 1.5rem; }
    .dz-subtitle { font-size: .85rem; color: var(--crow-text-muted); font-weight: 400; margin-left: .5rem; }
    .dz-section { margin-bottom: 1.6rem; }
    .dz-section h3 { font-size: .8rem; color: var(--crow-text-muted); text-transform: uppercase;
                     letter-spacing: .05em; margin: 0 0 .6rem; }
    .dz-card { background: var(--crow-bg-elevated); border: 1px solid var(--crow-border);
               border-radius: 10px; padding: 1rem; }
    .dz-row { display: flex; justify-content: space-between; gap: 1rem; font-size: .9rem; }
    .dz-row b { color: var(--crow-text-muted); font-weight: 500; min-width: 80px; }
    .dz-webui { width: 100%; height: calc(100vh - 280px); min-height: 500px; }
    .dz-iframe { width: 100%; height: 100%; border: none; border-radius: 10px; background: var(--crow-bg-elevated); }
    .np-loading { color: var(--crow-text-muted); padding: 1rem;
                  background: var(--crow-bg-elevated); border-radius: 10px; text-align: center; }
    .np-error { color: #ef4444; padding: 1rem;
                background: var(--crow-bg-elevated); border-radius: 10px; text-align: center; }
  `;
}
