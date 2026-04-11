/**
 * Crow's Nest Panel — Navidrome: library overview, now playing, web UI embed
 *
 * Bundle-compatible version: uses dynamic imports with appRoot instead of
 * static ESM imports, so this panel works both from the repo and when
 * installed to ~/.crow/panels/.
 *
 * Note: Client-side JS uses textContent-based escapeH() for safe HTML rendering,
 * matching the pattern used by other Crow panels (jellyfin, kodi, media, iptv).
 */

export default {
  id: "navidrome",
  name: "Navidrome",
  icon: "music",
  route: "/dashboard/navidrome",
  navOrder: 33,
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

    const tabBar = `<div class="nd-tabs">${tabs.map((t) =>
      `<a href="?tab=${escapeHtml(t.id)}" class="nd-tab${tab === t.id ? " active" : ""}">${escapeHtml(t.label)}</a>`
    ).join("")}</div>`;

    let body = "";

    if (tab === "webui") {
      const navidromeUrl = process.env.NAVIDROME_URL || "http://localhost:4533";
      body = `
        <div class="nd-webui">
          <iframe src="${escapeHtml(navidromeUrl)}" class="nd-iframe" allow="autoplay; fullscreen"></iframe>
        </div>
      `;
    } else {
      body = renderOverview();
    }

    const content = `
      <style>${navidromeStyles()}</style>
      <div class="nd-panel">
        <h1>Navidrome</h1>
        ${tabBar}
        <div class="nd-body">${body}</div>
      </div>
      <script>${navidromeScript()}</script>
    `;

    res.send(layout({ title: "Navidrome", content }));
  },
};

function renderOverview() {
  return `
    <div class="nd-overview">
      <div class="nd-section">
        <h3>Now Playing</h3>
        <div id="nd-nowplaying" class="nd-nowplaying">
          <div class="np-loading">Loading...</div>
        </div>
      </div>

      <div class="nd-section">
        <h3>Recent Albums</h3>
        <div id="nd-albums" class="nd-album-grid">
          <div class="np-loading">Loading albums...</div>
        </div>
      </div>

      <div class="nd-section">
        <h3>Playlists</h3>
        <div id="nd-playlists" class="nd-playlists">
          <div class="np-loading">Loading playlists...</div>
        </div>
      </div>
    </div>
  `;
}

function navidromeScript() {
  return `
    function escapeH(s) {
      if (!s) return '';
      const d = document.createElement('div');
      d.textContent = String(s);
      return d.innerHTML;
    }

    async function loadNowPlaying() {
      const el = document.getElementById('nd-nowplaying');
      if (!el) return;
      try {
        const res = await fetch('/api/navidrome/now-playing');
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
          idle.textContent = 'Nothing is currently playing';
          el.appendChild(idle);
          return;
        }

        entries.forEach(function(e) {
          const card = document.createElement('div');
          card.className = 'np-card';

          const titleEl = document.createElement('div');
          titleEl.className = 'np-title';
          titleEl.textContent = e.title;
          card.appendChild(titleEl);

          const subEl = document.createElement('div');
          subEl.className = 'np-subtitle';
          const parts = [];
          if (e.artist) parts.push(e.artist);
          if (e.album) parts.push(e.album);
          subEl.textContent = parts.join(' — ');
          card.appendChild(subEl);

          if (e.username) {
            const userEl = document.createElement('div');
            userEl.className = 'np-time';
            userEl.textContent = e.username + (e.playerName ? ' on ' + e.playerName : '');
            card.appendChild(userEl);
          }

          el.appendChild(card);
        });
      } catch (e) {
        el.textContent = '';
        const errDiv = document.createElement('div');
        errDiv.className = 'np-error';
        errDiv.textContent = 'Cannot reach Navidrome.';
        el.appendChild(errDiv);
      }
    }

    async function loadAlbums() {
      const el = document.getElementById('nd-albums');
      if (!el) return;
      try {
        const res = await fetch('/api/navidrome/albums');
        const data = await res.json();
        if (data.error) {
          el.textContent = '';
          const errDiv = document.createElement('div');
          errDiv.className = 'np-error';
          errDiv.textContent = data.error;
          el.appendChild(errDiv);
          return;
        }

        const albums = data.albums || [];
        el.textContent = '';

        if (albums.length === 0) {
          const idle = document.createElement('div');
          idle.className = 'np-idle';
          idle.textContent = 'No albums found';
          el.appendChild(idle);
          return;
        }

        albums.forEach(function(album) {
          const card = document.createElement('div');
          card.className = 'lib-card';

          const titleEl = document.createElement('div');
          titleEl.className = 'lib-title';
          titleEl.textContent = album.name;
          card.appendChild(titleEl);

          const meta = document.createElement('div');
          meta.className = 'lib-meta';
          const parts = [];
          if (album.artist) parts.push(album.artist);
          if (album.year) parts.push(String(album.year));
          if (album.songCount) parts.push(album.songCount + ' tracks');
          if (album.duration) parts.push(album.duration);
          meta.textContent = parts.join(' · ');
          card.appendChild(meta);

          if (album.genre) {
            const genreEl = document.createElement('div');
            genreEl.className = 'lib-meta';
            genreEl.textContent = album.genre;
            card.appendChild(genreEl);
          }

          el.appendChild(card);
        });
      } catch (e) {
        el.textContent = '';
        const errDiv = document.createElement('div');
        errDiv.className = 'np-error';
        errDiv.textContent = 'Failed to load albums.';
        el.appendChild(errDiv);
      }
    }

    async function loadPlaylists() {
      const el = document.getElementById('nd-playlists');
      if (!el) return;
      try {
        const res = await fetch('/api/navidrome/playlists');
        const data = await res.json();
        if (data.error) {
          el.textContent = '';
          const errDiv = document.createElement('div');
          errDiv.className = 'np-error';
          errDiv.textContent = data.error;
          el.appendChild(errDiv);
          return;
        }

        const playlists = data.playlists || [];
        el.textContent = '';

        if (playlists.length === 0) {
          const idle = document.createElement('div');
          idle.className = 'np-idle';
          idle.textContent = 'No playlists yet';
          el.appendChild(idle);
          return;
        }

        playlists.forEach(function(pl) {
          const card = document.createElement('div');
          card.className = 'np-card';

          const titleEl = document.createElement('div');
          titleEl.className = 'np-title';
          titleEl.textContent = pl.name;
          card.appendChild(titleEl);

          const subEl = document.createElement('div');
          subEl.className = 'np-subtitle';
          const parts = [pl.songCount + ' songs'];
          if (pl.duration) parts.push(pl.duration);
          if (pl.owner) parts.push('by ' + pl.owner);
          subEl.textContent = parts.join(' · ');
          card.appendChild(subEl);

          el.appendChild(card);
        });
      } catch (e) {
        el.textContent = '';
        const errDiv = document.createElement('div');
        errDiv.className = 'np-error';
        errDiv.textContent = 'Failed to load playlists.';
        el.appendChild(errDiv);
      }
    }

    // Init
    loadNowPlaying();
    loadAlbums();
    loadPlaylists();

    // Refresh now playing every 10s
    setInterval(loadNowPlaying, 10000);
  `;
}

function navidromeStyles() {
  return `
    .nd-panel h1 { margin: 0 0 1rem; font-size: 1.5rem; }
    .nd-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--crow-border); margin-bottom: 1.5rem; }
    .nd-tab { padding: 0.6rem 1.2rem; color: var(--crow-text-secondary); text-decoration: none;
              border-bottom: 2px solid transparent; transition: all 0.2s; }
    .nd-tab:hover { color: var(--crow-text-primary); }
    .nd-tab.active { color: var(--crow-accent); border-bottom-color: var(--crow-accent); }

    .nd-overview { display: flex; flex-direction: column; gap: 1.5rem; }
    .nd-section h3 { font-size: 0.85rem; color: var(--crow-text-muted); text-transform: uppercase;
                     letter-spacing: 0.05em; margin: 0 0 0.8rem; }

    /* Now Playing */
    .nd-nowplaying { display: flex; flex-direction: column; gap: 0.8rem; }
    .np-card { background: var(--crow-bg-elevated); border-radius: 12px; padding: 1.2rem; }
    .np-title { font-size: 1.1rem; font-weight: 600; color: var(--crow-text-primary); margin-bottom: 0.3rem; }
    .np-subtitle { font-size: 0.85rem; color: var(--crow-text-secondary); margin-bottom: 0.4rem; }
    .np-time { font-size: 0.8rem; color: var(--crow-text-muted); }
    .np-idle, .np-loading { color: var(--crow-text-muted); font-size: 0.9rem; padding: 1rem;
                            background: var(--crow-bg-elevated); border-radius: 12px; text-align: center; }
    .np-error { color: var(--crow-error); font-size: 0.9rem; padding: 1rem;
                background: var(--crow-bg-elevated); border-radius: 12px; text-align: center; }

    /* Album grid */
    .nd-album-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 1rem; }
    .lib-card { background: var(--crow-bg-elevated); border-radius: 10px; padding: 1rem;
                border: 1px solid var(--crow-border); transition: border-color 0.2s; }
    .lib-card:hover { border-color: var(--crow-accent); }
    .lib-title { font-weight: 600; color: var(--crow-text-primary); margin-bottom: 0.3rem; font-size: 0.95rem; }
    .lib-meta { font-size: 0.8rem; color: var(--crow-text-muted); }

    /* Playlists */
    .nd-playlists { display: flex; flex-direction: column; gap: 0.8rem; }

    /* Web UI iframe */
    .nd-webui { width: 100%; height: calc(100vh - 200px); min-height: 500px; }
    .nd-iframe { width: 100%; height: 100%; border: none; border-radius: 12px;
                 background: var(--crow-bg-elevated); }

    @media (max-width: 600px) {
      .nd-album-grid { grid-template-columns: 1fr; }
    }
  `;
}
