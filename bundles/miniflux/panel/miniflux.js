/**
 * Crow's Nest Panel — Miniflux: feed overview, unread entries, web UI embed
 *
 * Bundle-compatible version: uses dynamic imports with appRoot instead of
 * static ESM imports, so this panel works both from the repo and when
 * installed to ~/.crow/panels/.
 *
 * Note: Client-side JS uses textContent-based escapeH() for safe HTML rendering,
 * matching the pattern used by other Crow panels (kodi, media, iptv).
 */

export default {
  id: "miniflux",
  name: "Miniflux",
  icon: "rss",
  route: "/dashboard/miniflux",
  navOrder: 30,
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

    const tabBar = `<div class="mf-tabs">${tabs.map((t) =>
      `<a href="?tab=${escapeHtml(t.id)}" class="mf-tab${tab === t.id ? " active" : ""}">${escapeHtml(t.label)}</a>`
    ).join("")}</div>`;

    let body = "";

    if (tab === "webui") {
      const minifluxUrl = process.env.MINIFLUX_URL || "http://localhost:8085";
      body = `
        <div class="mf-webui">
          <iframe src="${escapeHtml(minifluxUrl)}" class="mf-iframe" allow="fullscreen"></iframe>
        </div>
      `;
    } else {
      body = renderOverview();
    }

    const content = `
      <style>${minifluxStyles()}</style>
      <div class="mf-panel">
        <h1>Miniflux</h1>
        ${tabBar}
        <div class="mf-body">${body}</div>
      </div>
      <script>${minifluxScript()}</script>
    `;

    res.send(layout({ title: "Miniflux", content }));
  },
};

function renderOverview() {
  return `
    <div class="mf-overview">
      <div class="mf-section">
        <h3>Feed Stats</h3>
        <div id="mf-stats" class="mf-stats">
          <div class="np-loading">Loading stats...</div>
        </div>
      </div>

      <div class="mf-section">
        <h3>Unread Entries</h3>
        <div id="mf-unread" class="mf-entries">
          <div class="np-loading">Loading...</div>
        </div>
      </div>

      <div class="mf-section">
        <h3>Starred</h3>
        <div id="mf-starred" class="mf-entries">
          <div class="np-loading">Loading...</div>
        </div>
      </div>
    </div>
  `;
}

function minifluxScript() {
  return `
    function escapeH(s) {
      if (!s) return '';
      const d = document.createElement('div');
      d.textContent = String(s);
      return d.innerHTML;
    }

    async function loadStats() {
      const el = document.getElementById('mf-stats');
      if (!el) return;
      try {
        const res = await fetch('/api/miniflux/stats');
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
          { label: 'Feeds', value: data.feedCount || 0 },
          { label: 'Unread', value: data.unreadCount || 0 },
          { label: 'Starred', value: data.starredCount || 0 },
        ];
        stats.forEach(function(s) {
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
        });
      } catch (e) {
        el.textContent = '';
        const errDiv = document.createElement('div');
        errDiv.className = 'np-error';
        errDiv.textContent = 'Cannot reach Miniflux.';
        el.appendChild(errDiv);
      }
    }

    async function loadEntries(elId, endpoint) {
      const el = document.getElementById(elId);
      if (!el) return;
      try {
        const res = await fetch(endpoint);
        const data = await res.json();
        if (data.error) {
          el.textContent = '';
          const errDiv = document.createElement('div');
          errDiv.className = 'np-error';
          errDiv.textContent = data.error;
          el.appendChild(errDiv);
          return;
        }

        const entries = data.entries || [];
        el.textContent = '';

        if (entries.length === 0) {
          const idle = document.createElement('div');
          idle.className = 'np-idle';
          idle.textContent = elId === 'mf-unread' ? 'All caught up!' : 'No starred entries';
          el.appendChild(idle);
          return;
        }

        entries.forEach(function(entry) {
          const card = document.createElement('div');
          card.className = 'entry-card';

          const titleEl = document.createElement('a');
          titleEl.className = 'entry-title';
          titleEl.textContent = entry.title;
          if (entry.url) {
            titleEl.href = entry.url;
            titleEl.target = '_blank';
          }
          card.appendChild(titleEl);

          const meta = document.createElement('div');
          meta.className = 'entry-meta';
          const parts = [];
          if (entry.feed) parts.push(entry.feed);
          if (entry.published) parts.push(new Date(entry.published).toLocaleDateString());
          if (entry.reading_time) parts.push(entry.reading_time);
          meta.textContent = parts.join(' · ');
          card.appendChild(meta);

          el.appendChild(card);
        });
      } catch (e) {
        el.textContent = '';
        const errDiv = document.createElement('div');
        errDiv.className = 'np-error';
        errDiv.textContent = 'Failed to load entries.';
        el.appendChild(errDiv);
      }
    }

    // Init
    loadStats();
    loadEntries('mf-unread', '/api/miniflux/entries?status=unread&limit=20');
    loadEntries('mf-starred', '/api/miniflux/entries?starred=true&limit=10');

    // Refresh every 30s
    setInterval(function() {
      loadStats();
      loadEntries('mf-unread', '/api/miniflux/entries?status=unread&limit=20');
    }, 30000);
  `;
}

function minifluxStyles() {
  return `
    .mf-panel h1 { margin: 0 0 1rem; font-size: 1.5rem; }
    .mf-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--crow-border); margin-bottom: 1.5rem; }
    .mf-tab { padding: 0.6rem 1.2rem; color: var(--crow-text-secondary); text-decoration: none;
              border-bottom: 2px solid transparent; transition: all 0.2s; }
    .mf-tab:hover { color: var(--crow-text-primary); }
    .mf-tab.active { color: var(--crow-accent); border-bottom-color: var(--crow-accent); }

    .mf-overview { display: flex; flex-direction: column; gap: 1.5rem; }
    .mf-section h3 { font-size: 0.85rem; color: var(--crow-text-muted); text-transform: uppercase;
                     letter-spacing: 0.05em; margin: 0 0 0.8rem; }

    /* Stats */
    .mf-stats { display: flex; gap: 1rem; flex-wrap: wrap; }
    .stat-card { background: var(--crow-bg-elevated); border-radius: 10px; padding: 1rem 1.2rem;
                 border: 1px solid var(--crow-border); min-width: 100px; text-align: center; }
    .stat-value { font-size: 1.6rem; font-weight: 700; color: var(--crow-accent); }
    .stat-label { font-size: 0.8rem; color: var(--crow-text-muted); margin-top: 0.2rem; }

    /* Entries */
    .mf-entries { display: flex; flex-direction: column; gap: 0.6rem; }
    .entry-card { background: var(--crow-bg-elevated); border-radius: 10px; padding: 1rem;
                  border: 1px solid var(--crow-border); transition: border-color 0.2s; }
    .entry-card:hover { border-color: var(--crow-accent); }
    .entry-title { font-weight: 600; color: var(--crow-text-primary); text-decoration: none;
                   display: block; margin-bottom: 0.3rem; font-size: 0.95rem; }
    .entry-title:hover { color: var(--crow-accent); }
    .entry-meta { font-size: 0.8rem; color: var(--crow-text-muted); }

    .np-idle, .np-loading { color: var(--crow-text-muted); font-size: 0.9rem; padding: 1rem;
                            background: var(--crow-bg-elevated); border-radius: 12px; text-align: center; }
    .np-error { color: var(--crow-error); font-size: 0.9rem; padding: 1rem;
                background: var(--crow-bg-elevated); border-radius: 12px; text-align: center; }

    /* Web UI iframe */
    .mf-webui { width: 100%; height: calc(100vh - 200px); min-height: 500px; }
    .mf-iframe { width: 100%; height: 100%; border: none; border-radius: 12px;
                 background: var(--crow-bg-elevated); }

    @media (max-width: 600px) {
      .mf-stats { flex-direction: column; }
    }
  `;
}
