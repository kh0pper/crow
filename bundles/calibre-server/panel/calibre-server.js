/**
 * Crow's Nest Panel — Calibre Server: library overview, recent books, web UI embed
 *
 * Bundle-compatible version: uses dynamic imports with appRoot instead of
 * static ESM imports, so this panel works both from the repo and when
 * installed to ~/.crow/panels/.
 *
 * Note: Client-side JS uses textContent-based escapeH() for safe HTML rendering,
 * matching the pattern used by other Crow panels (kodi, media, iptv).
 */

export default {
  id: "calibre-server",
  name: "Calibre",
  icon: "book",
  route: "/dashboard/calibre-server",
  navOrder: 28,
  category: "media",

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

    const tabBar = `<div class="cb-tabs">${tabs.map((t) =>
      `<a href="?tab=${escapeHtml(t.id)}" class="cb-tab${tab === t.id ? " active" : ""}">${escapeHtml(t.label)}</a>`
    ).join("")}</div>`;

    let body = "";

    if (tab === "webui") {
      const calibreUrl = process.env.CALIBRE_URL || "http://localhost:8081";
      body = `
        <div class="cb-webui">
          <iframe src="${escapeHtml(calibreUrl)}" class="cb-iframe" allow="fullscreen"></iframe>
        </div>
      `;
    } else {
      body = renderOverview();
    }

    const content = `
      <style>${calibreStyles()}</style>
      <div class="cb-panel">
        <h1>Calibre</h1>
        ${tabBar}
        <div class="cb-body">${body}</div>
      </div>
      <script>${calibreScript()}</script>
    `;

    res.send(layout({ title: "Calibre", content }));
  },
};

function renderOverview() {
  return `
    <div class="cb-overview">
      <div class="cb-section">
        <h3>Library Stats</h3>
        <div id="cb-stats" class="cb-stats">
          <div class="np-loading">Loading stats...</div>
        </div>
      </div>

      <div class="cb-section">
        <h3>Recent Books</h3>
        <div id="cb-recent" class="cb-recent-grid">
          <div class="np-loading">Loading...</div>
        </div>
      </div>
    </div>
  `;
}

function calibreScript() {
  return `
    // Safe HTML escaper using textContent
    function escapeH(s) {
      if (!s) return '';
      const d = document.createElement('div');
      d.textContent = String(s);
      return d.innerHTML;
    }

    async function loadStats() {
      const el = document.getElementById('cb-stats');
      if (!el) return;
      try {
        const res = await fetch('/api/calibre-server/stats');
        const data = await res.json();
        if (data.error) {
          el.textContent = '';
          const errDiv = document.createElement('div');
          errDiv.className = 'np-error';
          errDiv.textContent = data.error;
          el.appendChild(errDiv);
          return;
        }

        el.textContent = '';
        const stats = [
          { label: 'Books', value: data.totalBooks || 0 },
          { label: 'Authors', value: data.totalAuthors || 0 },
          { label: 'Tags', value: data.totalTags || 0 },
          { label: 'Series', value: data.totalSeries || 0 },
          { label: 'Publishers', value: data.totalPublishers || 0 },
          { label: 'Formats', value: data.totalFormats || 0 },
        ];
        stats.forEach(function(s) {
          if (s.value > 0) {
            const card = document.createElement('div');
            card.className = 'stat-card';
            const valEl = document.createElement('div');
            valEl.className = 'stat-value';
            valEl.textContent = s.value.toLocaleString();
            card.appendChild(valEl);
            const labelEl = document.createElement('div');
            labelEl.className = 'stat-label';
            labelEl.textContent = s.label;
            card.appendChild(labelEl);
            el.appendChild(card);
          }
        });
        if (el.children.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'np-idle';
          empty.textContent = 'No library data available';
          el.appendChild(empty);
        }
      } catch (e) {
        el.textContent = '';
        const errDiv = document.createElement('div');
        errDiv.className = 'np-error';
        errDiv.textContent = 'Cannot reach Calibre server.';
        el.appendChild(errDiv);
      }
    }

    async function loadRecent() {
      const el = document.getElementById('cb-recent');
      if (!el) return;
      try {
        const res = await fetch('/api/calibre-server/recent');
        const data = await res.json();
        if (data.error) {
          el.textContent = '';
          const errDiv = document.createElement('div');
          errDiv.className = 'np-error';
          errDiv.textContent = data.error;
          el.appendChild(errDiv);
          return;
        }

        const items = data.items || [];
        el.textContent = '';

        if (items.length === 0) {
          const idle = document.createElement('div');
          idle.className = 'np-idle';
          idle.textContent = 'No books found';
          el.appendChild(idle);
          return;
        }

        items.forEach(function(item) {
          const card = document.createElement('div');
          card.className = 'lib-card';

          const titleEl = document.createElement('div');
          titleEl.className = 'lib-title';
          titleEl.textContent = item.title;
          card.appendChild(titleEl);

          const meta = document.createElement('div');
          meta.className = 'lib-meta';
          const parts = [];
          if (item.authors) parts.push(item.authors);
          if (item.formats) parts.push(item.formats);
          meta.textContent = parts.join(' \u00b7 ');
          card.appendChild(meta);

          if (item.tags) {
            const tagsEl = document.createElement('div');
            tagsEl.className = 'lib-meta';
            tagsEl.textContent = item.tags;
            card.appendChild(tagsEl);
          }

          if (item.downloadUrl) {
            const btn = document.createElement('a');
            btn.className = 'play-btn';
            btn.href = item.downloadUrl;
            btn.target = '_blank';
            btn.textContent = 'Download';
            card.appendChild(btn);
          }

          el.appendChild(card);
        });
      } catch (e) {
        el.textContent = '';
        const errDiv = document.createElement('div');
        errDiv.className = 'np-error';
        errDiv.textContent = 'Failed to load recent books.';
        el.appendChild(errDiv);
      }
    }

    // Init
    loadStats();
    loadRecent();
  `;
}

function calibreStyles() {
  return `
    .cb-panel h1 { margin: 0 0 1rem; font-size: 1.5rem; }
    .cb-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--crow-border); margin-bottom: 1.5rem; }
    .cb-tab { padding: 0.6rem 1.2rem; color: var(--crow-text-secondary); text-decoration: none;
              border-bottom: 2px solid transparent; transition: all 0.2s; }
    .cb-tab:hover { color: var(--crow-text-primary); }
    .cb-tab.active { color: var(--crow-accent); border-bottom-color: var(--crow-accent); }

    .cb-overview { display: flex; flex-direction: column; gap: 1.5rem; }
    .cb-section h3 { font-size: 0.85rem; color: var(--crow-text-muted); text-transform: uppercase;
                     letter-spacing: 0.05em; margin: 0 0 0.8rem; }

    /* Stats */
    .cb-stats { display: flex; gap: 1rem; flex-wrap: wrap; }
    .stat-card { background: var(--crow-bg-elevated); border-radius: 10px; padding: 1rem 1.2rem;
                 border: 1px solid var(--crow-border); min-width: 100px; text-align: center; }
    .stat-value { font-size: 1.6rem; font-weight: 700; color: var(--crow-accent); }
    .stat-label { font-size: 0.8rem; color: var(--crow-text-muted); margin-top: 0.2rem; }

    /* Recent grid */
    .cb-recent-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 1rem; }
    .lib-card { background: var(--crow-bg-elevated); border-radius: 10px; padding: 1rem;
                border: 1px solid var(--crow-border); transition: border-color 0.2s; }
    .lib-card:hover { border-color: var(--crow-accent); }
    .lib-title { font-weight: 600; color: var(--crow-text-primary); margin-bottom: 0.3rem; font-size: 0.95rem; }
    .lib-meta { font-size: 0.8rem; color: var(--crow-text-muted); }
    .play-btn { display: inline-block; margin-top: 0.6rem; background: var(--crow-accent); border: none;
                border-radius: 6px; padding: 0.4rem 0.8rem; color: #fff; cursor: pointer; font-size: 0.85rem;
                text-decoration: none; transition: background 0.15s; }
    .play-btn:hover { background: var(--crow-accent-hover); }

    .np-idle, .np-loading { color: var(--crow-text-muted); font-size: 0.9rem; padding: 1rem;
                            background: var(--crow-bg-elevated); border-radius: 12px; text-align: center; }
    .np-error { color: var(--crow-error); font-size: 0.9rem; padding: 1rem;
                background: var(--crow-bg-elevated); border-radius: 12px; text-align: center; }

    /* Web UI iframe */
    .cb-webui { width: 100%; height: calc(100vh - 200px); min-height: 500px; }
    .cb-iframe { width: 100%; height: 100%; border: none; border-radius: 12px;
                 background: var(--crow-bg-elevated); }

    @media (max-width: 600px) {
      .cb-stats { flex-direction: column; }
      .cb-recent-grid { grid-template-columns: 1fr; }
    }
  `;
}
