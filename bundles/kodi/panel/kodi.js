/**
 * Crow's Nest Panel — Kodi: now playing, remote control, library browser
 *
 * Bundle-compatible version: uses dynamic imports with appRoot instead of
 * static ESM imports, so this panel works both from the repo and when
 * installed to ~/.crow/panels/.
 *
 * Note: Client-side JS uses innerHTML with escapeH() for safe HTML rendering,
 * matching the pattern used by other Crow panels (media, iptv, browser).
 * All user-facing strings are escaped via textContent-based escapeH().
 */

const ITEMS_PER_PAGE = 24;

export default {
  id: "kodi",
  name: "Kodi",
  icon: "monitor",
  route: "/dashboard/kodi",
  navOrder: 26,
  category: "media",

  async handler(req, res, { layout, appRoot }) {
    const { pathToFileURL } = await import("node:url");
    const { join } = await import("node:path");

    const componentsPath = join(appRoot, "servers/gateway/dashboard/shared/components.js");
    const { escapeHtml } = await import(pathToFileURL(componentsPath).href);

    // Current tab
    const tab = req.query.tab || "remote";

    // Tab bar
    const tabs = [
      { id: "remote", label: "Remote" },
      { id: "movies", label: "Movies" },
      { id: "tvshows", label: "TV Shows" },
      { id: "music", label: "Music" },
    ];

    const tabBar = `<div class="kodi-tabs">${tabs.map((t) =>
      `<a href="?tab=${escapeHtml(t.id)}" class="kodi-tab${tab === t.id ? " active" : ""}">${escapeHtml(t.label)}</a>`
    ).join("")}</div>`;

    let body = "";

    if (tab === "remote") {
      body = renderRemote();
    } else {
      body = renderLibraryTab(tab);
    }

    const content = `
      <style>${kodiStyles()}</style>
      <div class="kodi-panel">
        <h1>Kodi</h1>
        <div class="kodi-now-playing" id="now-playing">
          <div class="np-loading">Connecting to Kodi...</div>
        </div>
        ${tabBar}
        <div class="kodi-body">${body}</div>
      </div>
      <script>${kodiScript()}</script>
    `;

    res.send(layout({ title: "Kodi", content }));
  },
};

function renderRemote() {
  return `
    <div class="kodi-remote">
      <div class="remote-section">
        <h3>Transport</h3>
        <div class="transport-controls">
          <button class="ctrl-btn" onclick="kodiControl('previous')" title="Previous">&#9198;</button>
          <button class="ctrl-btn" onclick="kodiControl('seek_backward', 30)" title="Rewind 30s">&#9194;</button>
          <button class="ctrl-btn ctrl-primary" onclick="kodiControl('play_pause')" title="Play/Pause">&#9199;</button>
          <button class="ctrl-btn" onclick="kodiControl('seek_forward', 30)" title="Forward 30s">&#9193;</button>
          <button class="ctrl-btn" onclick="kodiControl('next')" title="Next">&#9197;</button>
          <button class="ctrl-btn ctrl-danger" onclick="kodiControl('stop')" title="Stop">&#9209;</button>
        </div>
      </div>

      <div class="remote-section">
        <h3>Volume</h3>
        <div class="volume-controls">
          <button class="ctrl-btn" onclick="kodiControl('mute')" title="Mute">&#128263;</button>
          <input type="range" id="volume-slider" min="0" max="100" value="50"
                 oninput="kodiControl('set_volume', parseInt(this.value))">
          <span id="volume-label">50</span>
          <button class="ctrl-btn" onclick="kodiControl('unmute')" title="Unmute">&#128266;</button>
        </div>
      </div>

      <div class="remote-section">
        <h3>Navigation</h3>
        <div class="dpad-grid">
          <div></div>
          <button class="ctrl-btn dpad-btn" onclick="kodiNav('Up')" title="Up">&#9650;</button>
          <div></div>
          <button class="ctrl-btn dpad-btn" onclick="kodiNav('Left')" title="Left">&#9664;</button>
          <button class="ctrl-btn dpad-btn dpad-center" onclick="kodiNav('Select')" title="Select">OK</button>
          <button class="ctrl-btn dpad-btn" onclick="kodiNav('Right')" title="Right">&#9654;</button>
          <div></div>
          <button class="ctrl-btn dpad-btn" onclick="kodiNav('Down')" title="Down">&#9660;</button>
          <div></div>
        </div>
        <div class="nav-extras">
          <button class="ctrl-btn" onclick="kodiNav('Back')" title="Back">&#8592; Back</button>
          <button class="ctrl-btn" onclick="kodiNav('Home')" title="Home">&#8962; Home</button>
          <button class="ctrl-btn" onclick="kodiNav('ContextMenu')" title="Context Menu">&#9776; Menu</button>
          <button class="ctrl-btn" onclick="kodiNav('Info')" title="Info">&#8505; Info</button>
        </div>
      </div>
    </div>
  `;
}

function renderLibraryTab(tab) {
  const typeMap = { movies: "movie", tvshows: "tvshow", music: "album" };
  const mediaType = typeMap[tab] || "movie";

  return `
    <div class="kodi-library" data-type="${mediaType}">
      <div class="library-controls">
        <select id="sort-select" onchange="loadLibrary()">
          <option value="title">Title</option>
          <option value="year">Year</option>
          <option value="rating">Rating</option>
          <option value="dateadded">Recently Added</option>
        </select>
        <button class="ctrl-btn" onclick="loadLibrary()" title="Refresh">&#8635; Refresh</button>
      </div>
      <div id="library-grid" class="library-grid">
        <div class="np-loading">Loading library...</div>
      </div>
      <div id="library-pager" class="library-pager"></div>
    </div>
  `;
}

function kodiScript() {
  // Client-side JS for the Kodi panel.
  // Uses escapeH() (textContent-based) for all user-facing strings before DOM insertion,
  // following the same pattern as other Crow panels (media, iptv, browser).
  return `
    let pollTimer = null;
    let currentOffset = 0;

    // Safe HTML escaper using textContent
    function escapeH(s) {
      if (!s) return '';
      const d = document.createElement('div');
      d.textContent = String(s);
      return d.innerHTML;
    }

    // --- Now Playing ---
    async function refreshNowPlaying() {
      try {
        const res = await fetch('/api/kodi/now-playing');
        const data = await res.json();
        const el = document.getElementById('now-playing');
        if (!el) return;

        if (data.error) {
          el.textContent = '';
          const errDiv = document.createElement('div');
          errDiv.className = 'np-error';
          errDiv.textContent = data.error;
          el.appendChild(errDiv);
          return;
        }

        if (!data.title) {
          el.textContent = '';
          const idleDiv = document.createElement('div');
          idleDiv.className = 'np-idle';
          idleDiv.textContent = 'Nothing playing';
          el.appendChild(idleDiv);

          if (data.volume !== undefined) {
            const slider = document.getElementById('volume-slider');
            const label = document.getElementById('volume-label');
            if (slider) slider.value = data.volume;
            if (label) label.textContent = data.volume;
          }
          return;
        }

        const pct = data.progress || 0;
        const card = document.createElement('div');
        card.className = 'np-card';

        const titleEl = document.createElement('div');
        titleEl.className = 'np-title';
        titleEl.textContent = data.title;
        card.appendChild(titleEl);

        if (data.show) {
          const subEl = document.createElement('div');
          subEl.className = 'np-subtitle';
          subEl.textContent = data.show + ' S' + data.season + 'E' + data.episode;
          card.appendChild(subEl);
        }
        if (data.artist) {
          const subEl = document.createElement('div');
          subEl.className = 'np-subtitle';
          subEl.textContent = data.artist + (data.album ? ' — ' + data.album : '');
          card.appendChild(subEl);
        }

        const progWrap = document.createElement('div');
        progWrap.className = 'np-progress';
        const progBar = document.createElement('div');
        progBar.className = 'np-bar';
        progBar.style.width = pct + '%';
        progWrap.appendChild(progBar);
        card.appendChild(progWrap);

        const timeEl = document.createElement('div');
        timeEl.className = 'np-time';
        timeEl.textContent = data.elapsed + ' / ' + data.total + '  (' + pct + '%)';
        card.appendChild(timeEl);

        const statusEl = document.createElement('div');
        statusEl.className = 'np-status';
        statusEl.textContent = data.speed;
        card.appendChild(statusEl);

        el.textContent = '';
        el.appendChild(card);

        if (data.volume !== undefined) {
          const slider = document.getElementById('volume-slider');
          const label = document.getElementById('volume-label');
          if (slider) slider.value = data.volume;
          if (label) label.textContent = data.volume;
        }
      } catch (e) {
        const el = document.getElementById('now-playing');
        if (el) {
          el.textContent = '';
          const errDiv = document.createElement('div');
          errDiv.className = 'np-error';
          errDiv.textContent = 'Cannot reach Kodi. Check connection.';
          el.appendChild(errDiv);
        }
      }
    }

    // --- Controls ---
    async function kodiControl(command, value) {
      try {
        await fetch('/api/kodi/control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command, value }),
        });
        setTimeout(refreshNowPlaying, 500);
      } catch (e) {
        console.error('Control error:', e);
      }
    }

    async function kodiNav(action) {
      try {
        await fetch('/api/kodi/navigate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        });
      } catch (e) {
        console.error('Nav error:', e);
      }
    }

    // --- Library ---
    async function loadLibrary(offset) {
      const container = document.querySelector('.kodi-library');
      if (!container) return;

      const mediaType = container.dataset.type;
      const sortBy = document.getElementById('sort-select')?.value || 'title';
      currentOffset = offset || 0;

      const grid = document.getElementById('library-grid');
      if (grid) {
        grid.textContent = '';
        const loadingDiv = document.createElement('div');
        loadingDiv.className = 'np-loading';
        loadingDiv.textContent = 'Loading...';
        grid.appendChild(loadingDiv);
      }

      try {
        const res = await fetch('/api/kodi/library/' + encodeURIComponent(mediaType) + '?sort_by=' + encodeURIComponent(sortBy) + '&limit=${ITEMS_PER_PAGE}&offset=' + currentOffset);
        const data = await res.json();

        if (data.error) {
          if (grid) {
            grid.textContent = '';
            const errDiv = document.createElement('div');
            errDiv.className = 'np-error';
            errDiv.textContent = data.error;
            grid.appendChild(errDiv);
          }
          return;
        }

        const items = data.items || [];
        if (items.length === 0) {
          if (grid) {
            grid.textContent = '';
            const emptyDiv = document.createElement('div');
            emptyDiv.className = 'np-idle';
            emptyDiv.textContent = 'No items found';
            grid.appendChild(emptyDiv);
          }
          return;
        }

        if (grid) {
          grid.textContent = '';
          items.forEach(function(item) {
            const card = document.createElement('div');
            card.className = 'lib-card';

            const titleEl = document.createElement('div');
            titleEl.className = 'lib-title';
            titleEl.textContent = item.title || item.name || '';
            card.appendChild(titleEl);

            if (item.year) {
              const meta = document.createElement('div');
              meta.className = 'lib-meta';
              meta.textContent = String(item.year);
              card.appendChild(meta);
            }
            if (item.artist) {
              const meta = document.createElement('div');
              meta.className = 'lib-meta';
              meta.textContent = item.artist;
              card.appendChild(meta);
            }
            if (item.genre) {
              const meta = document.createElement('div');
              meta.className = 'lib-meta';
              meta.textContent = item.genre;
              card.appendChild(meta);
            }
            if (item.rating) {
              const meta = document.createElement('div');
              meta.className = 'lib-meta';
              meta.textContent = 'Rating: ' + item.rating;
              card.appendChild(meta);
            }
            if (item.runtime) {
              const meta = document.createElement('div');
              meta.className = 'lib-meta';
              meta.textContent = item.runtime;
              card.appendChild(meta);
            }
            if (item.seasons !== undefined) {
              const meta = document.createElement('div');
              meta.className = 'lib-meta';
              meta.textContent = item.seasons + ' seasons, ' + item.episodes + ' episodes';
              card.appendChild(meta);
            }

            // Play button (not for tvshow — need to pick an episode)
            var playType = mediaType === 'tvshow' ? null : (mediaType === 'album' ? 'album' : mediaType);
            if (playType) {
              const btn = document.createElement('button');
              btn.className = 'play-btn';
              btn.textContent = 'Play';
              btn.addEventListener('click', function() { kodiPlay(playType, item.id); });
              card.appendChild(btn);
            }

            grid.appendChild(card);
          });
        }

        // Pager
        const pager = document.getElementById('library-pager');
        if (pager) {
          pager.textContent = '';

          if (currentOffset > 0) {
            const prevBtn = document.createElement('button');
            prevBtn.className = 'ctrl-btn';
            prevBtn.textContent = 'Previous';
            prevBtn.addEventListener('click', function() { loadLibrary(Math.max(0, currentOffset - ${ITEMS_PER_PAGE})); });
            pager.appendChild(prevBtn);
          }

          const info = document.createElement('span');
          info.textContent = 'Showing ' + items.length + ' of ' + (data.total || '?');
          pager.appendChild(info);

          if (items.length === ${ITEMS_PER_PAGE} && currentOffset + ${ITEMS_PER_PAGE} < (data.total || Infinity)) {
            const nextBtn = document.createElement('button');
            nextBtn.className = 'ctrl-btn';
            nextBtn.textContent = 'Next';
            nextBtn.addEventListener('click', function() { loadLibrary(currentOffset + ${ITEMS_PER_PAGE}); });
            pager.appendChild(nextBtn);
          }
        }
      } catch (e) {
        if (grid) {
          grid.textContent = '';
          const errDiv = document.createElement('div');
          errDiv.className = 'np-error';
          errDiv.textContent = 'Failed to load library.';
          grid.appendChild(errDiv);
        }
      }
    }

    async function kodiPlay(type, id) {
      try {
        await fetch('/api/kodi/control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: 'play', media_type: type, id: id }),
        });
        setTimeout(refreshNowPlaying, 1000);
      } catch (e) {
        console.error('Play error:', e);
      }
    }

    // Init. Track the poll on window so Turbo re-entries clear the prior
    // one instead of stacking.
    refreshNowPlaying();
    if (window.__kodiPollTimer) clearInterval(window.__kodiPollTimer);
    pollTimer = setInterval(refreshNowPlaying, 5000);
    window.__kodiPollTimer = pollTimer;

    // Auto-load library if on a library tab
    if (document.querySelector('.kodi-library')) {
      loadLibrary(0);
    }
  `;
}

function kodiStyles() {
  return `
    .kodi-panel h1 { margin: 0 0 1rem; font-size: 1.5rem; }
    .kodi-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--crow-border); margin-bottom: 1.5rem; }
    .kodi-tab { padding: 0.6rem 1.2rem; color: var(--crow-text-secondary); text-decoration: none;
                border-bottom: 2px solid transparent; transition: all 0.2s; }
    .kodi-tab:hover { color: var(--crow-text-primary); }
    .kodi-tab.active { color: var(--crow-accent); border-bottom-color: var(--crow-accent); }

    /* Now Playing */
    .kodi-now-playing { margin-bottom: 1.5rem; }
    .np-card { background: var(--crow-bg-elevated); border-radius: 12px; padding: 1.2rem; }
    .np-title { font-size: 1.1rem; font-weight: 600; color: var(--crow-text-primary); margin-bottom: 0.3rem; }
    .np-subtitle { font-size: 0.85rem; color: var(--crow-text-secondary); margin-bottom: 0.4rem; }
    .np-progress { background: var(--crow-bg-deep); border-radius: 4px; height: 6px; margin: 0.8rem 0 0.4rem; overflow: hidden; }
    .np-bar { background: var(--crow-accent); height: 100%; border-radius: 4px; transition: width 0.5s ease; }
    .np-time { font-size: 0.8rem; color: var(--crow-text-muted); }
    .np-status { font-size: 0.75rem; color: var(--crow-text-muted); text-transform: uppercase; margin-top: 0.2rem; }
    .np-idle, .np-loading { color: var(--crow-text-muted); font-size: 0.9rem; padding: 1rem;
                            background: var(--crow-bg-elevated); border-radius: 12px; text-align: center; }
    .np-error { color: var(--crow-error); font-size: 0.9rem; padding: 1rem;
                background: var(--crow-bg-elevated); border-radius: 12px; text-align: center; }

    /* Remote */
    .kodi-remote { display: flex; flex-direction: column; gap: 1.5rem; }
    .remote-section h3 { font-size: 0.85rem; color: var(--crow-text-muted); text-transform: uppercase;
                         letter-spacing: 0.05em; margin: 0 0 0.8rem; }
    .transport-controls { display: flex; gap: 0.5rem; flex-wrap: wrap; justify-content: center; }
    .ctrl-btn { background: var(--crow-bg-elevated); border: 1px solid var(--crow-border); border-radius: 8px;
                padding: 0.6rem 1rem; color: var(--crow-text-primary); cursor: pointer; font-size: 1rem;
                transition: all 0.15s; }
    .ctrl-btn:hover { background: var(--crow-accent-muted); border-color: var(--crow-accent); }
    .ctrl-primary { background: var(--crow-accent); border-color: var(--crow-accent); color: #fff; }
    .ctrl-primary:hover { background: var(--crow-accent-hover); }
    .ctrl-danger { color: var(--crow-error); }

    /* Volume */
    .volume-controls { display: flex; align-items: center; gap: 0.6rem; }
    .volume-controls input[type=range] { flex: 1; accent-color: var(--crow-accent); }
    #volume-label { font-size: 0.85rem; color: var(--crow-text-secondary); min-width: 2ch; text-align: center; }

    /* D-pad */
    .dpad-grid { display: grid; grid-template-columns: repeat(3, 56px); gap: 6px; justify-content: center; margin-bottom: 0.8rem; }
    .dpad-btn { width: 56px; height: 56px; display: flex; align-items: center; justify-content: center;
                font-size: 1.3rem; padding: 0; }
    .dpad-center { background: var(--crow-accent); border-color: var(--crow-accent); color: #fff; font-size: 0.85rem; font-weight: 600; }
    .dpad-center:hover { background: var(--crow-accent-hover); }
    .nav-extras { display: flex; gap: 0.5rem; flex-wrap: wrap; justify-content: center; }
    .nav-extras .ctrl-btn { font-size: 0.85rem; padding: 0.5rem 0.8rem; }

    /* Library */
    .library-controls { display: flex; gap: 0.6rem; margin-bottom: 1rem; align-items: center; }
    .library-controls select { background: var(--crow-bg-elevated); border: 1px solid var(--crow-border);
                               border-radius: 8px; padding: 0.5rem 0.8rem; color: var(--crow-text-primary);
                               font-size: 0.9rem; }
    .library-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 1rem; }
    .lib-card { background: var(--crow-bg-elevated); border-radius: 10px; padding: 1rem;
                border: 1px solid var(--crow-border); transition: border-color 0.2s; }
    .lib-card:hover { border-color: var(--crow-accent); }
    .lib-title { font-weight: 600; color: var(--crow-text-primary); margin-bottom: 0.3rem; font-size: 0.95rem; }
    .lib-meta { font-size: 0.8rem; color: var(--crow-text-muted); }
    .play-btn { margin-top: 0.6rem; background: var(--crow-accent); border: none; border-radius: 6px;
                padding: 0.4rem 0.8rem; color: #fff; cursor: pointer; font-size: 0.85rem; transition: background 0.15s; }
    .play-btn:hover { background: var(--crow-accent-hover); }
    .library-pager { display: flex; align-items: center; gap: 0.8rem; justify-content: center; margin-top: 1rem;
                     color: var(--crow-text-secondary); font-size: 0.9rem; }

    @media (max-width: 600px) {
      .library-grid { grid-template-columns: 1fr; }
      .transport-controls { gap: 0.3rem; }
      .ctrl-btn { padding: 0.5rem 0.7rem; font-size: 0.9rem; }
    }
  `;
}
