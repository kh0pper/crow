/**
 * Crow's Nest Panel — Audiobookshelf: library overview, progress, web UI embed
 *
 * Bundle-compatible version: uses dynamic imports with appRoot instead of
 * static ESM imports, so this panel works both from the repo and when
 * installed to ~/.crow/panels/.
 *
 * Note: Client-side JS uses textContent-based escapeH() for safe HTML rendering,
 * matching the pattern used by other Crow panels (kodi, media, iptv).
 */

export default {
  id: "audiobookshelf",
  name: "Audiobookshelf",
  icon: "mic",
  route: "/dashboard/audiobookshelf",
  navOrder: 31,
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

    const tabBar = `<div class="abs-tabs">${tabs.map((t) =>
      `<a href="?tab=${escapeHtml(t.id)}" class="abs-tab${tab === t.id ? " active" : ""}">${escapeHtml(t.label)}</a>`
    ).join("")}</div>`;

    let body = "";

    if (tab === "webui") {
      const absUrl = process.env.AUDIOBOOKSHELF_URL || "http://localhost:13378";
      body = `
        <div class="abs-webui">
          <iframe src="${escapeHtml(absUrl)}" class="abs-iframe" allow="autoplay; fullscreen"></iframe>
        </div>
      `;
    } else {
      body = renderOverview();
    }

    const content = `
      <style>${absStyles()}</style>
      <div class="abs-panel">
        <h1>Audiobookshelf</h1>
        ${tabBar}
        <div class="abs-body">${body}</div>
      </div>
      <script>${absScript()}</script>
    `;

    res.send(layout({ title: "Audiobookshelf", content }));
  },
};

function renderOverview() {
  return `
    <div class="abs-overview">
      <div class="abs-section">
        <h3>Libraries</h3>
        <div id="abs-libraries" class="abs-stats">
          <div class="np-loading">Loading libraries...</div>
        </div>
      </div>

      <div class="abs-section">
        <h3>In Progress</h3>
        <div id="abs-progress" class="abs-items">
          <div class="np-loading">Loading...</div>
        </div>
      </div>

      <div class="abs-section">
        <h3>Recently Added</h3>
        <div id="abs-recent" class="abs-item-grid">
          <div class="np-loading">Loading...</div>
        </div>
      </div>
    </div>
  `;
}

function absScript() {
  return `
    function escapeH(s) {
      if (!s) return '';
      const d = document.createElement('div');
      d.textContent = String(s);
      return d.innerHTML;
    }

    async function loadLibraries() {
      const el = document.getElementById('abs-libraries');
      if (!el) return;
      try {
        const res = await fetch('/api/audiobookshelf/libraries');
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
        const libraries = data.libraries || [];
        if (libraries.length === 0) {
          const idle = document.createElement('div');
          idle.className = 'np-idle';
          idle.textContent = 'No libraries configured';
          el.appendChild(idle);
          return;
        }

        libraries.forEach(function(lib) {
          const card = document.createElement('div');
          card.className = 'stat-card';
          const nameEl = document.createElement('div');
          nameEl.className = 'stat-value';
          nameEl.textContent = lib.name;
          card.appendChild(nameEl);
          const typeEl = document.createElement('div');
          typeEl.className = 'stat-label';
          typeEl.textContent = lib.mediaType || 'library';
          card.appendChild(typeEl);
          el.appendChild(card);
        });
      } catch (e) {
        el.textContent = '';
        const errDiv = document.createElement('div');
        errDiv.className = 'np-error';
        errDiv.textContent = 'Cannot reach Audiobookshelf.';
        el.appendChild(errDiv);
      }
    }

    async function loadProgress() {
      const el = document.getElementById('abs-progress');
      if (!el) return;
      try {
        const res = await fetch('/api/audiobookshelf/progress');
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
          idle.textContent = 'No items in progress';
          el.appendChild(idle);
          return;
        }

        items.forEach(function(item) {
          const card = document.createElement('div');
          card.className = 'np-card';

          const titleEl = document.createElement('div');
          titleEl.className = 'np-title';
          titleEl.textContent = item.title || 'Untitled';
          card.appendChild(titleEl);

          if (item.author) {
            const authorEl = document.createElement('div');
            authorEl.className = 'np-subtitle';
            authorEl.textContent = 'by ' + item.author;
            card.appendChild(authorEl);
          }

          const progEl = document.createElement('div');
          progEl.className = 'np-time';
          progEl.textContent = item.progress + ' complete' + (item.duration ? ' of ' + item.duration : '');
          card.appendChild(progEl);

          // Progress bar
          const barWrap = document.createElement('div');
          barWrap.className = 'progress-bar-wrap';
          const bar = document.createElement('div');
          bar.className = 'progress-bar';
          bar.style.width = item.progress;
          barWrap.appendChild(bar);
          card.appendChild(barWrap);

          el.appendChild(card);
        });
      } catch (e) {
        el.textContent = '';
        const errDiv = document.createElement('div');
        errDiv.className = 'np-error';
        errDiv.textContent = 'Failed to load progress.';
        el.appendChild(errDiv);
      }
    }

    async function loadRecent() {
      const el = document.getElementById('abs-recent');
      if (!el) return;
      try {
        const res = await fetch('/api/audiobookshelf/recent');
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
          idle.textContent = 'No recent items';
          el.appendChild(idle);
          return;
        }

        items.forEach(function(item) {
          const card = document.createElement('div');
          card.className = 'lib-card';

          const titleEl = document.createElement('div');
          titleEl.className = 'lib-title';
          titleEl.textContent = item.title || 'Untitled';
          card.appendChild(titleEl);

          const meta = document.createElement('div');
          meta.className = 'lib-meta';
          const parts = [];
          if (item.author) parts.push(item.author);
          if (item.duration) parts.push(item.duration);
          if (item.year) parts.push(String(item.year));
          meta.textContent = parts.join(' · ');
          card.appendChild(meta);

          if (item.webPlayerUrl) {
            const btn = document.createElement('a');
            btn.className = 'play-btn';
            btn.href = item.webPlayerUrl;
            btn.target = '_blank';
            btn.textContent = 'Listen';
            card.appendChild(btn);
          }

          el.appendChild(card);
        });
      } catch (e) {
        el.textContent = '';
        const errDiv = document.createElement('div');
        errDiv.className = 'np-error';
        errDiv.textContent = 'Failed to load recent items.';
        el.appendChild(errDiv);
      }
    }

    // Init
    loadLibraries();
    loadProgress();
    loadRecent();

    // Refresh progress every 30s
    setInterval(loadProgress, 30000);
  `;
}

function absStyles() {
  return `
    .abs-panel h1 { margin: 0 0 1rem; font-size: 1.5rem; }
    .abs-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--crow-border); margin-bottom: 1.5rem; }
    .abs-tab { padding: 0.6rem 1.2rem; color: var(--crow-text-secondary); text-decoration: none;
               border-bottom: 2px solid transparent; transition: all 0.2s; }
    .abs-tab:hover { color: var(--crow-text-primary); }
    .abs-tab.active { color: var(--crow-accent); border-bottom-color: var(--crow-accent); }

    .abs-overview { display: flex; flex-direction: column; gap: 1.5rem; }
    .abs-section h3 { font-size: 0.85rem; color: var(--crow-text-muted); text-transform: uppercase;
                      letter-spacing: 0.05em; margin: 0 0 0.8rem; }

    /* Stats / Libraries */
    .abs-stats { display: flex; gap: 1rem; flex-wrap: wrap; }
    .stat-card { background: var(--crow-bg-elevated); border-radius: 10px; padding: 1rem 1.2rem;
                 border: 1px solid var(--crow-border); min-width: 100px; text-align: center; }
    .stat-value { font-size: 1.1rem; font-weight: 700; color: var(--crow-accent); }
    .stat-label { font-size: 0.8rem; color: var(--crow-text-muted); margin-top: 0.2rem; }

    /* In Progress */
    .abs-items { display: flex; flex-direction: column; gap: 0.8rem; }
    .np-card { background: var(--crow-bg-elevated); border-radius: 12px; padding: 1.2rem; }
    .np-title { font-size: 1.1rem; font-weight: 600; color: var(--crow-text-primary); margin-bottom: 0.3rem; }
    .np-subtitle { font-size: 0.85rem; color: var(--crow-text-secondary); margin-bottom: 0.4rem; }
    .np-time { font-size: 0.8rem; color: var(--crow-text-muted); margin-bottom: 0.5rem; }
    .np-idle, .np-loading { color: var(--crow-text-muted); font-size: 0.9rem; padding: 1rem;
                            background: var(--crow-bg-elevated); border-radius: 12px; text-align: center; }
    .np-error { color: var(--crow-error); font-size: 0.9rem; padding: 1rem;
                background: var(--crow-bg-elevated); border-radius: 12px; text-align: center; }

    /* Progress bar */
    .progress-bar-wrap { width: 100%; height: 4px; background: var(--crow-border); border-radius: 2px; overflow: hidden; }
    .progress-bar { height: 100%; background: var(--crow-accent); border-radius: 2px; transition: width 0.3s; }

    /* Recent grid */
    .abs-item-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 1rem; }
    .lib-card { background: var(--crow-bg-elevated); border-radius: 10px; padding: 1rem;
                border: 1px solid var(--crow-border); transition: border-color 0.2s; }
    .lib-card:hover { border-color: var(--crow-accent); }
    .lib-title { font-weight: 600; color: var(--crow-text-primary); margin-bottom: 0.3rem; font-size: 0.95rem; }
    .lib-meta { font-size: 0.8rem; color: var(--crow-text-muted); }
    .play-btn { display: inline-block; margin-top: 0.6rem; background: var(--crow-accent); border: none;
                border-radius: 6px; padding: 0.4rem 0.8rem; color: #fff; cursor: pointer; font-size: 0.85rem;
                text-decoration: none; transition: background 0.15s; }
    .play-btn:hover { background: var(--crow-accent-hover); }

    /* Web UI iframe */
    .abs-webui { width: 100%; height: calc(100vh - 200px); min-height: 500px; }
    .abs-iframe { width: 100%; height: 100%; border: none; border-radius: 12px;
                  background: var(--crow-bg-elevated); }

    @media (max-width: 600px) {
      .abs-stats { flex-direction: column; }
      .abs-item-grid { grid-template-columns: 1fr; }
    }
  `;
}
