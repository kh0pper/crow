/**
 * Crow's Nest Panel — Linkding: bookmark overview, recent bookmarks, web UI embed
 *
 * Bundle-compatible version: uses dynamic imports with appRoot instead of
 * static ESM imports, so this panel works both from the repo and when
 * installed to ~/.crow/panels/.
 *
 * Note: Client-side JS uses textContent-based escapeH() for safe HTML rendering,
 * matching the pattern used by other Crow panels (jellyfin, kodi, iptv).
 */

export default {
  id: "linkding",
  name: "Linkding",
  icon: "bookmark",
  route: "/dashboard/linkding",
  navOrder: 36,
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

    const tabBar = `<div class="ld-tabs">${tabs.map((t) =>
      `<a href="?tab=${escapeHtml(t.id)}" class="ld-tab${tab === t.id ? " active" : ""}">${escapeHtml(t.label)}</a>`
    ).join("")}</div>`;

    let body = "";

    if (tab === "webui") {
      const linkdingUrl = process.env.LINKDING_URL || "http://localhost:9090";
      body = `
        <div class="ld-webui">
          <iframe src="${escapeHtml(linkdingUrl)}" class="ld-iframe" allow="fullscreen"></iframe>
        </div>
      `;
    } else {
      body = renderOverview();
    }

    const content = `
      <style>${linkdingStyles()}</style>
      <div class="ld-panel">
        <h1>Linkding</h1>
        ${tabBar}
        <div class="ld-body">${body}</div>
      </div>
      <script>${linkdingScript()}</script>
    `;

    res.send(layout({ title: "Linkding", content }));
  },
};

function renderOverview() {
  return `
    <div class="ld-overview">
      <div class="ld-section">
        <h3>Stats</h3>
        <div id="ld-stats" class="ld-stats">
          <div class="np-loading">Loading stats...</div>
        </div>
      </div>

      <div class="ld-section">
        <h3>Recent Bookmarks</h3>
        <div id="ld-recent" class="ld-recent-list">
          <div class="np-loading">Loading...</div>
        </div>
      </div>
    </div>
  `;
}

function linkdingScript() {
  return `
    // Safe HTML escaper using textContent
    function escapeH(s) {
      if (!s) return '';
      const d = document.createElement('div');
      d.textContent = String(s);
      return d.innerHTML;
    }

    async function loadStats() {
      const el = document.getElementById('ld-stats');
      if (!el) return;
      try {
        const res = await fetch('/api/linkding/stats');
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
        errDiv.textContent = 'Cannot reach Linkding.';
        el.appendChild(errDiv);
      }
    }

    async function loadRecent() {
      const el = document.getElementById('ld-recent');
      if (!el) return;
      try {
        const res = await fetch('/api/linkding/recent');
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

          if (item.description) {
            const descEl = document.createElement('div');
            descEl.className = 'lib-meta';
            descEl.textContent = item.description.slice(0, 120);
            card.appendChild(descEl);
          }

          if (item.tags && item.tags.length > 0) {
            const tagsEl = document.createElement('div');
            tagsEl.className = 'lib-tags';
            item.tags.forEach(function(tag) {
              const tagSpan = document.createElement('span');
              tagSpan.className = 'lib-tag';
              tagSpan.textContent = tag;
              tagsEl.appendChild(tagSpan);
            });
            card.appendChild(tagsEl);
          }

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

function linkdingStyles() {
  return `
    .ld-panel h1 { margin: 0 0 1rem; font-size: 1.5rem; }
    .ld-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--crow-border); margin-bottom: 1.5rem; }
    .ld-tab { padding: 0.6rem 1.2rem; color: var(--crow-text-secondary); text-decoration: none;
              border-bottom: 2px solid transparent; transition: all 0.2s; }
    .ld-tab:hover { color: var(--crow-text-primary); }
    .ld-tab.active { color: var(--crow-accent); border-bottom-color: var(--crow-accent); }

    .ld-overview { display: flex; flex-direction: column; gap: 1.5rem; }
    .ld-section h3 { font-size: 0.85rem; color: var(--crow-text-muted); text-transform: uppercase;
                     letter-spacing: 0.05em; margin: 0 0 0.8rem; }

    /* Stats */
    .ld-stats { display: flex; gap: 1rem; flex-wrap: wrap; }
    .stat-card { background: var(--crow-bg-elevated); border-radius: 10px; padding: 1rem 1.2rem;
                 border: 1px solid var(--crow-border); min-width: 100px; text-align: center; }
    .stat-value { font-size: 1.6rem; font-weight: 700; color: var(--crow-accent); }
    .stat-label { font-size: 0.8rem; color: var(--crow-text-muted); margin-top: 0.2rem; }

    /* Recent list */
    .ld-recent-list { display: flex; flex-direction: column; gap: 0.8rem; }
    .lib-card { background: var(--crow-bg-elevated); border-radius: 10px; padding: 1rem;
                border: 1px solid var(--crow-border); transition: border-color 0.2s; }
    .lib-card:hover { border-color: var(--crow-accent); }
    .lib-title { font-weight: 600; color: var(--crow-accent); text-decoration: none; display: block;
                 margin-bottom: 0.3rem; font-size: 0.95rem; }
    .lib-title:hover { text-decoration: underline; }
    .lib-meta { font-size: 0.8rem; color: var(--crow-text-muted); margin-bottom: 0.4rem; }
    .lib-tags { display: flex; gap: 0.4rem; flex-wrap: wrap; margin-top: 0.4rem; }
    .lib-tag { background: var(--crow-bg-secondary, rgba(255,255,255,0.06)); border-radius: 4px;
               padding: 0.15rem 0.5rem; font-size: 0.75rem; color: var(--crow-text-secondary); }

    .np-idle, .np-loading { color: var(--crow-text-muted); font-size: 0.9rem; padding: 1rem;
                            background: var(--crow-bg-elevated); border-radius: 12px; text-align: center; }
    .np-error { color: var(--crow-error); font-size: 0.9rem; padding: 1rem;
                background: var(--crow-bg-elevated); border-radius: 12px; text-align: center; }

    /* Web UI iframe */
    .ld-webui { width: 100%; height: calc(100vh - 200px); min-height: 500px; }
    .ld-iframe { width: 100%; height: 100%; border: none; border-radius: 12px;
                 background: var(--crow-bg-elevated); }

    @media (max-width: 600px) {
      .ld-stats { flex-direction: column; }
    }
  `;
}
