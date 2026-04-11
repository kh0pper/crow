/**
 * Crow's Nest Panel — BookStack: wiki overview, recent pages, web UI embed
 *
 * Bundle-compatible version: uses dynamic imports with appRoot instead of
 * static ESM imports, so this panel works both from the repo and when
 * installed to ~/.crow/panels/.
 *
 * Note: Client-side JS uses textContent-based escapeH() for safe HTML rendering,
 * matching the pattern used by other Crow panels (jellyfin, kodi, iptv).
 */

export default {
  id: "bookstack",
  name: "BookStack",
  icon: "book",
  route: "/dashboard/bookstack",
  navOrder: 38,
  category: "productivity",

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

    const tabBar = `<div class="bs-tabs">${tabs.map((t) =>
      `<a href="?tab=${escapeHtml(t.id)}" class="bs-tab${tab === t.id ? " active" : ""}">${escapeHtml(t.label)}</a>`
    ).join("")}</div>`;

    let body = "";

    if (tab === "webui") {
      const bookstackUrl = process.env.BOOKSTACK_URL || "http://localhost:6875";
      body = `
        <div class="bs-webui">
          <iframe src="${escapeHtml(bookstackUrl)}" class="bs-iframe" allow="fullscreen"></iframe>
        </div>
      `;
    } else {
      body = renderOverview();
    }

    const content = `
      <style>${bookstackStyles()}</style>
      <div class="bs-panel">
        <h1>BookStack</h1>
        ${tabBar}
        <div class="bs-body">${body}</div>
      </div>
      <script>${bookstackScript()}</script>
    `;

    res.send(layout({ title: "BookStack", content }));
  },
};

function renderOverview() {
  return `
    <div class="bs-overview">
      <div class="bs-section">
        <h3>Library Stats</h3>
        <div id="bs-stats" class="bs-stats">
          <div class="np-loading">Loading stats...</div>
        </div>
      </div>

      <div class="bs-section">
        <h3>Recent Pages</h3>
        <div id="bs-recent" class="bs-recent-grid">
          <div class="np-loading">Loading...</div>
        </div>
      </div>
    </div>
  `;
}

function bookstackScript() {
  return `
    // Safe HTML escaper using textContent
    function escapeH(s) {
      if (!s) return '';
      const d = document.createElement('div');
      d.textContent = String(s);
      return d.innerHTML;
    }

    async function loadStats() {
      const el = document.getElementById('bs-stats');
      if (!el) return;
      try {
        const res = await fetch('/api/bookstack/stats');
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
          { label: 'Shelves', value: data.shelves || 0 },
          { label: 'Books', value: data.books || 0 },
          { label: 'Chapters', value: data.chapters || 0 },
          { label: 'Pages', value: data.pages || 0 },
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
        errDiv.textContent = 'Cannot reach BookStack.';
        el.appendChild(errDiv);
      }
    }

    async function loadRecent() {
      const el = document.getElementById('bs-recent');
      if (!el) return;
      try {
        const res = await fetch('/api/bookstack/recent');
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
          idle.textContent = 'No pages found';
          el.appendChild(idle);
          return;
        }

        items.forEach(function(item) {
          const card = document.createElement('div');
          card.className = 'lib-card';

          const titleEl = document.createElement('div');
          titleEl.className = 'lib-title';
          titleEl.textContent = item.name;
          card.appendChild(titleEl);

          const meta = document.createElement('div');
          meta.className = 'lib-meta';
          const parts = [];
          if (item.book) parts.push(item.book);
          if (item.chapter) parts.push(item.chapter);
          if (item.updated) parts.push(item.updated);
          meta.textContent = parts.join(' · ');
          card.appendChild(meta);

          if (item.preview) {
            const prevEl = document.createElement('div');
            prevEl.className = 'lib-preview';
            prevEl.textContent = item.preview;
            card.appendChild(prevEl);
          }

          el.appendChild(card);
        });
      } catch (e) {
        el.textContent = '';
        const errDiv = document.createElement('div');
        errDiv.className = 'np-error';
        errDiv.textContent = 'Failed to load recent pages.';
        el.appendChild(errDiv);
      }
    }

    // Init
    loadStats();
    loadRecent();
  `;
}

function bookstackStyles() {
  return `
    .bs-panel h1 { margin: 0 0 1rem; font-size: 1.5rem; }
    .bs-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--crow-border); margin-bottom: 1.5rem; }
    .bs-tab { padding: 0.6rem 1.2rem; color: var(--crow-text-secondary); text-decoration: none;
              border-bottom: 2px solid transparent; transition: all 0.2s; }
    .bs-tab:hover { color: var(--crow-text-primary); }
    .bs-tab.active { color: var(--crow-accent); border-bottom-color: var(--crow-accent); }

    .bs-overview { display: flex; flex-direction: column; gap: 1.5rem; }
    .bs-section h3 { font-size: 0.85rem; color: var(--crow-text-muted); text-transform: uppercase;
                     letter-spacing: 0.05em; margin: 0 0 0.8rem; }

    /* Stats */
    .bs-stats { display: flex; gap: 1rem; flex-wrap: wrap; }
    .stat-card { background: var(--crow-bg-elevated); border-radius: 10px; padding: 1rem 1.2rem;
                 border: 1px solid var(--crow-border); min-width: 100px; text-align: center; }
    .stat-value { font-size: 1.6rem; font-weight: 700; color: var(--crow-accent); }
    .stat-label { font-size: 0.8rem; color: var(--crow-text-muted); margin-top: 0.2rem; }

    /* Recent grid */
    .bs-recent-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 1rem; }
    .lib-card { background: var(--crow-bg-elevated); border-radius: 10px; padding: 1rem;
                border: 1px solid var(--crow-border); transition: border-color 0.2s; }
    .lib-card:hover { border-color: var(--crow-accent); }
    .lib-title { font-weight: 600; color: var(--crow-text-primary); margin-bottom: 0.3rem; font-size: 0.95rem; }
    .lib-meta { font-size: 0.8rem; color: var(--crow-text-muted); }
    .lib-preview { font-size: 0.8rem; color: var(--crow-text-secondary); margin-top: 0.4rem;
                   overflow: hidden; text-overflow: ellipsis; display: -webkit-box;
                   -webkit-line-clamp: 2; -webkit-box-orient: vertical; }

    .np-idle, .np-loading { color: var(--crow-text-muted); font-size: 0.9rem; padding: 1rem;
                            background: var(--crow-bg-elevated); border-radius: 12px; text-align: center; }
    .np-error { color: var(--crow-error); font-size: 0.9rem; padding: 1rem;
                background: var(--crow-bg-elevated); border-radius: 12px; text-align: center; }

    /* Web UI iframe */
    .bs-webui { width: 100%; height: calc(100vh - 200px); min-height: 500px; }
    .bs-iframe { width: 100%; height: 100%; border: none; border-radius: 12px;
                 background: var(--crow-bg-elevated); }

    @media (max-width: 600px) {
      .bs-stats { flex-direction: column; }
      .bs-recent-grid { grid-template-columns: 1fr; }
    }
  `;
}
