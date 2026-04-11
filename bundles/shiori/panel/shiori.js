/**
 * Crow's Nest Panel — Shiori: bookmark overview, recent saves, web UI embed
 *
 * Bundle-compatible version: uses dynamic imports with appRoot instead of
 * static ESM imports, so this panel works both from the repo and when
 * installed to ~/.crow/panels/.
 *
 * Note: Client-side JS uses textContent-based escapeH() for safe HTML rendering,
 * matching the pattern used by other Crow panels (jellyfin, kodi, iptv).
 */

export default {
  id: "shiori",
  name: "Shiori",
  icon: "bookmark",
  route: "/dashboard/shiori",
  navOrder: 37,
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

    const tabBar = `<div class="sh-tabs">${tabs.map((t) =>
      `<a href="?tab=${escapeHtml(t.id)}" class="sh-tab${tab === t.id ? " active" : ""}">${escapeHtml(t.label)}</a>`
    ).join("")}</div>`;

    let body = "";

    if (tab === "webui") {
      const shioriUrl = process.env.SHIORI_URL || "http://localhost:8086";
      body = `
        <div class="sh-webui">
          <iframe src="${escapeHtml(shioriUrl)}" class="sh-iframe" allow="fullscreen"></iframe>
        </div>
      `;
    } else {
      body = renderOverview();
    }

    const content = `
      <style>${shioriStyles()}</style>
      <div class="sh-panel">
        <h1>Shiori</h1>
        ${tabBar}
        <div class="sh-body">${body}</div>
      </div>
      <script>${shioriScript()}</script>
    `;

    res.send(layout({ title: "Shiori", content }));
  },
};

function renderOverview() {
  return `
    <div class="sh-overview">
      <div class="sh-section">
        <h3>Stats</h3>
        <div id="sh-stats" class="sh-stats">
          <div class="np-loading">Loading stats...</div>
        </div>
      </div>

      <div class="sh-section">
        <h3>Recent Bookmarks</h3>
        <div id="sh-recent" class="sh-recent-list">
          <div class="np-loading">Loading...</div>
        </div>
      </div>
    </div>
  `;
}

function shioriScript() {
  return `
    // Safe HTML escaper using textContent
    function escapeH(s) {
      if (!s) return '';
      const d = document.createElement('div');
      d.textContent = String(s);
      return d.innerHTML;
    }

    async function loadStats() {
      const el = document.getElementById('sh-stats');
      if (!el) return;
      try {
        const res = await fetch('/api/shiori/stats');
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
          { label: 'Bookmarks', value: data.bookmarkCount || 0 },
          { label: 'Tags', value: data.tagCount || 0 },
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
        errDiv.textContent = 'Cannot reach Shiori.';
        el.appendChild(errDiv);
      }
    }

    async function loadRecent() {
      const el = document.getElementById('sh-recent');
      if (!el) return;
      try {
        const res = await fetch('/api/shiori/recent');
        const data = await res.json();
        if (data.error) {
          el.textContent = '';
          const errDiv = document.createElement('div');
          errDiv.className = 'np-error';
          errDiv.textContent = data.error;
          el.appendChild(errDiv);
          return;
        }

        const items = data.bookmarks || [];
        el.textContent = '';

        if (items.length === 0) {
          const idle = document.createElement('div');
          idle.className = 'np-idle';
          idle.textContent = 'No bookmarks yet';
          el.appendChild(idle);
          return;
        }

        items.forEach(function(item) {
          const card = document.createElement('div');
          card.className = 'lib-card';

          const titleEl = document.createElement('a');
          titleEl.className = 'lib-title';
          titleEl.textContent = item.title || item.url;
          titleEl.href = item.url;
          titleEl.target = '_blank';
          titleEl.rel = 'noopener';
          card.appendChild(titleEl);

          if (item.excerpt) {
            const descEl = document.createElement('div');
            descEl.className = 'lib-meta';
            descEl.textContent = item.excerpt.slice(0, 120);
            card.appendChild(descEl);
          }

          const metaEl = document.createElement('div');
          metaEl.className = 'lib-meta-row';
          if (item.hasArchive) {
            const archiveSpan = document.createElement('span');
            archiveSpan.className = 'lib-badge';
            archiveSpan.textContent = 'Archived';
            metaEl.appendChild(archiveSpan);
          }
          if (item.tags && item.tags.length > 0) {
            item.tags.forEach(function(tag) {
              const tagSpan = document.createElement('span');
              tagSpan.className = 'lib-tag';
              tagSpan.textContent = tag;
              metaEl.appendChild(tagSpan);
            });
          }
          if (metaEl.children.length > 0) card.appendChild(metaEl);

          el.appendChild(card);
        });
      } catch (e) {
        el.textContent = '';
        const errDiv = document.createElement('div');
        errDiv.className = 'np-error';
        errDiv.textContent = 'Failed to load bookmarks.';
        el.appendChild(errDiv);
      }
    }

    // Init
    loadStats();
    loadRecent();
  `;
}

function shioriStyles() {
  return `
    .sh-panel h1 { margin: 0 0 1rem; font-size: 1.5rem; }
    .sh-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--crow-border); margin-bottom: 1.5rem; }
    .sh-tab { padding: 0.6rem 1.2rem; color: var(--crow-text-secondary); text-decoration: none;
              border-bottom: 2px solid transparent; transition: all 0.2s; }
    .sh-tab:hover { color: var(--crow-text-primary); }
    .sh-tab.active { color: var(--crow-accent); border-bottom-color: var(--crow-accent); }

    .sh-overview { display: flex; flex-direction: column; gap: 1.5rem; }
    .sh-section h3 { font-size: 0.85rem; color: var(--crow-text-muted); text-transform: uppercase;
                     letter-spacing: 0.05em; margin: 0 0 0.8rem; }

    /* Stats */
    .sh-stats { display: flex; gap: 1rem; flex-wrap: wrap; }
    .stat-card { background: var(--crow-bg-elevated); border-radius: 10px; padding: 1rem 1.2rem;
                 border: 1px solid var(--crow-border); min-width: 100px; text-align: center; }
    .stat-value { font-size: 1.6rem; font-weight: 700; color: var(--crow-accent); }
    .stat-label { font-size: 0.8rem; color: var(--crow-text-muted); margin-top: 0.2rem; }

    /* Recent list */
    .sh-recent-list { display: flex; flex-direction: column; gap: 0.8rem; }
    .lib-card { background: var(--crow-bg-elevated); border-radius: 10px; padding: 1rem;
                border: 1px solid var(--crow-border); transition: border-color 0.2s; }
    .lib-card:hover { border-color: var(--crow-accent); }
    .lib-title { font-weight: 600; color: var(--crow-accent); text-decoration: none; display: block;
                 margin-bottom: 0.3rem; font-size: 0.95rem; }
    .lib-title:hover { text-decoration: underline; }
    .lib-meta { font-size: 0.8rem; color: var(--crow-text-muted); margin-bottom: 0.4rem; }
    .lib-meta-row { display: flex; gap: 0.4rem; flex-wrap: wrap; margin-top: 0.4rem; align-items: center; }
    .lib-tag { background: var(--crow-bg-secondary, rgba(255,255,255,0.06)); border-radius: 4px;
               padding: 0.15rem 0.5rem; font-size: 0.75rem; color: var(--crow-text-secondary); }
    .lib-badge { background: var(--crow-accent); border-radius: 4px; padding: 0.15rem 0.5rem;
                 font-size: 0.7rem; color: #fff; font-weight: 600; }

    .np-idle, .np-loading { color: var(--crow-text-muted); font-size: 0.9rem; padding: 1rem;
                            background: var(--crow-bg-elevated); border-radius: 12px; text-align: center; }
    .np-error { color: var(--crow-error); font-size: 0.9rem; padding: 1rem;
                background: var(--crow-bg-elevated); border-radius: 12px; text-align: center; }

    /* Web UI iframe */
    .sh-webui { width: 100%; height: calc(100vh - 200px); min-height: 500px; }
    .sh-iframe { width: 100%; height: 100%; border: none; border-radius: 12px;
                 background: var(--crow-bg-elevated); }

    @media (max-width: 600px) {
      .sh-stats { flex-direction: column; }
    }
  `;
}
