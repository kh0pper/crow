/**
 * Crow's Nest Panel — Jellyfin: library overview, active sessions, web UI embed
 *
 * Bundle-compatible version: uses dynamic imports with appRoot instead of
 * static ESM imports, so this panel works both from the repo and when
 * installed to ~/.crow/panels/.
 *
 * Note: Client-side JS uses textContent-based escapeH() for safe HTML rendering,
 * matching the pattern used by other Crow panels (kodi, media, iptv).
 */

const ITEMS_PER_PAGE = 24;

export default {
  id: "jellyfin",
  name: "Jellyfin",
  icon: "film",
  route: "/dashboard/jellyfin",
  navOrder: 27,
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

    const tabBar = `<div class="jf-tabs">${tabs.map((t) =>
      `<a href="?tab=${escapeHtml(t.id)}" class="jf-tab${tab === t.id ? " active" : ""}">${escapeHtml(t.label)}</a>`
    ).join("")}</div>`;

    let body = "";

    if (tab === "webui") {
      const jellyfinUrl = process.env.JELLYFIN_URL || "http://localhost:8096";
      body = `
        <div class="jf-webui">
          <iframe src="${escapeHtml(jellyfinUrl)}" class="jf-iframe" allow="autoplay; fullscreen; picture-in-picture"></iframe>
        </div>
      `;
    } else {
      body = renderOverview();
    }

    const content = `
      <style>${jellyfinStyles()}</style>
      <div class="jf-panel">
        <h1>Jellyfin</h1>
        ${tabBar}
        <div class="jf-body">${body}</div>
      </div>
      <script>${jellyfinScript()}</script>
    `;

    res.send(layout({ title: "Jellyfin", content }));
  },
};

function renderOverview() {
  return `
    <div class="jf-overview">
      <div class="jf-section">
        <h3>Library Stats</h3>
        <div id="jf-stats" class="jf-stats">
          <div class="np-loading">Loading stats...</div>
        </div>
      </div>

      <div class="jf-section">
        <h3>Active Sessions</h3>
        <div id="jf-sessions" class="jf-sessions">
          <div class="np-loading">Loading sessions...</div>
        </div>
      </div>

      <div class="jf-section">
        <h3>Recently Added</h3>
        <div id="jf-recent" class="jf-recent-grid">
          <div class="np-loading">Loading...</div>
        </div>
      </div>
    </div>
  `;
}

function jellyfinScript() {
  return `
    // Safe HTML escaper using textContent
    function escapeH(s) {
      if (!s) return '';
      const d = document.createElement('div');
      d.textContent = String(s);
      return d.innerHTML;
    }

    async function loadStats() {
      const el = document.getElementById('jf-stats');
      if (!el) return;
      try {
        const res = await fetch('/api/jellyfin/stats');
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
          { label: 'Movies', value: data.MovieCount || 0 },
          { label: 'Series', value: data.SeriesCount || 0 },
          { label: 'Episodes', value: data.EpisodeCount || 0 },
          { label: 'Songs', value: data.SongCount || 0 },
          { label: 'Albums', value: data.AlbumCount || 0 },
          { label: 'Artists', value: data.ArtistCount || 0 },
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
          empty.textContent = 'No library items found';
          el.appendChild(empty);
        }
      } catch (e) {
        el.textContent = '';
        const errDiv = document.createElement('div');
        errDiv.className = 'np-error';
        errDiv.textContent = 'Cannot reach Jellyfin.';
        el.appendChild(errDiv);
      }
    }

    async function loadSessions() {
      const el = document.getElementById('jf-sessions');
      if (!el) return;
      try {
        const res = await fetch('/api/jellyfin/sessions');
        const data = await res.json();
        if (data.error) {
          el.textContent = '';
          const errDiv = document.createElement('div');
          errDiv.className = 'np-error';
          errDiv.textContent = data.error;
          el.appendChild(errDiv);
          return;
        }

        const sessions = data.sessions || [];
        el.textContent = '';

        if (sessions.length === 0) {
          const idle = document.createElement('div');
          idle.className = 'np-idle';
          idle.textContent = 'No active playback sessions';
          el.appendChild(idle);
          return;
        }

        sessions.forEach(function(s) {
          const card = document.createElement('div');
          card.className = 'np-card';

          const titleEl = document.createElement('div');
          titleEl.className = 'np-title';
          titleEl.textContent = s.nowPlaying;
          card.appendChild(titleEl);

          const subEl = document.createElement('div');
          subEl.className = 'np-subtitle';
          subEl.textContent = s.user + ' on ' + s.device + ' (' + s.client + ')';
          card.appendChild(subEl);

          if (s.position) {
            const timeEl = document.createElement('div');
            timeEl.className = 'np-time';
            timeEl.textContent = s.position + (s.isPaused ? ' (paused)' : ' (playing)');
            card.appendChild(timeEl);
          }

          el.appendChild(card);
        });
      } catch (e) {
        el.textContent = '';
        const errDiv = document.createElement('div');
        errDiv.className = 'np-error';
        errDiv.textContent = 'Cannot reach Jellyfin.';
        el.appendChild(errDiv);
      }
    }

    async function loadRecent() {
      const el = document.getElementById('jf-recent');
      if (!el) return;
      try {
        const res = await fetch('/api/jellyfin/recent');
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
          titleEl.textContent = item.name;
          card.appendChild(titleEl);

          const meta = document.createElement('div');
          meta.className = 'lib-meta';
          const parts = [item.type];
          if (item.year) parts.push(String(item.year));
          if (item.runtime) parts.push(item.runtime);
          meta.textContent = parts.join(' · ');
          card.appendChild(meta);

          if (item.genres) {
            const genreEl = document.createElement('div');
            genreEl.className = 'lib-meta';
            genreEl.textContent = item.genres;
            card.appendChild(genreEl);
          }

          if (item.streamUrl) {
            const btn = document.createElement('a');
            btn.className = 'play-btn';
            btn.href = item.streamUrl;
            btn.target = '_blank';
            btn.textContent = 'Stream';
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
    loadStats();
    loadSessions();
    loadRecent();

    // Refresh sessions every 10s. Track on window so Turbo re-entries clear
    // the prior poll instead of stacking.
    if (window.__jfSessionsInterval) clearInterval(window.__jfSessionsInterval);
    window.__jfSessionsInterval = setInterval(loadSessions, 10000);
  `;
}

function jellyfinStyles() {
  return `
    .jf-panel h1 { margin: 0 0 1rem; font-size: 1.5rem; }
    .jf-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--crow-border); margin-bottom: 1.5rem; }
    .jf-tab { padding: 0.6rem 1.2rem; color: var(--crow-text-secondary); text-decoration: none;
              border-bottom: 2px solid transparent; transition: all 0.2s; }
    .jf-tab:hover { color: var(--crow-text-primary); }
    .jf-tab.active { color: var(--crow-accent); border-bottom-color: var(--crow-accent); }

    .jf-overview { display: flex; flex-direction: column; gap: 1.5rem; }
    .jf-section h3 { font-size: 0.85rem; color: var(--crow-text-muted); text-transform: uppercase;
                     letter-spacing: 0.05em; margin: 0 0 0.8rem; }

    /* Stats */
    .jf-stats { display: flex; gap: 1rem; flex-wrap: wrap; }
    .stat-card { background: var(--crow-bg-elevated); border-radius: 10px; padding: 1rem 1.2rem;
                 border: 1px solid var(--crow-border); min-width: 100px; text-align: center; }
    .stat-value { font-size: 1.6rem; font-weight: 700; color: var(--crow-accent); }
    .stat-label { font-size: 0.8rem; color: var(--crow-text-muted); margin-top: 0.2rem; }

    /* Sessions / Now Playing */
    .jf-sessions { display: flex; flex-direction: column; gap: 0.8rem; }
    .np-card { background: var(--crow-bg-elevated); border-radius: 12px; padding: 1.2rem; }
    .np-title { font-size: 1.1rem; font-weight: 600; color: var(--crow-text-primary); margin-bottom: 0.3rem; }
    .np-subtitle { font-size: 0.85rem; color: var(--crow-text-secondary); margin-bottom: 0.4rem; }
    .np-time { font-size: 0.8rem; color: var(--crow-text-muted); }
    .np-idle, .np-loading { color: var(--crow-text-muted); font-size: 0.9rem; padding: 1rem;
                            background: var(--crow-bg-elevated); border-radius: 12px; text-align: center; }
    .np-error { color: var(--crow-error); font-size: 0.9rem; padding: 1rem;
                background: var(--crow-bg-elevated); border-radius: 12px; text-align: center; }

    /* Recent grid */
    .jf-recent-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 1rem; }
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
    .jf-webui { width: 100%; height: calc(100vh - 200px); min-height: 500px; }
    .jf-iframe { width: 100%; height: 100%; border: none; border-radius: 12px;
                 background: var(--crow-bg-elevated); }

    @media (max-width: 600px) {
      .jf-stats { flex-direction: column; }
      .jf-recent-grid { grid-template-columns: 1fr; }
    }
  `;
}
