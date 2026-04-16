/**
 * Crow's Nest Panel — Plex: server info, library stats, on deck, active sessions
 *
 * Bundle-compatible version: uses dynamic imports with appRoot instead of
 * static ESM imports, so this panel works both from the repo and when
 * installed to ~/.crow/panels/.
 *
 * Note: Client-side JS uses textContent-based escapeH() for safe HTML rendering,
 * matching the pattern used by other Crow panels (kodi, jellyfin, media, iptv).
 */

export default {
  id: "plex",
  name: "Plex",
  icon: "film",
  route: "/dashboard/plex",
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
      { id: "ondeck", label: "On Deck" },
    ];

    const plexUrl = process.env.PLEX_URL || "http://localhost:32400";
    const openBtn = `<a href="${escapeHtml(plexUrl)}/web" target="_blank" rel="noopener" class="plex-open-btn">Open Plex</a>`;

    const tabBar = `<div class="plex-tabs">${tabs.map((t) =>
      `<a href="?tab=${escapeHtml(t.id)}" class="plex-tab${tab === t.id ? " active" : ""}">${escapeHtml(t.label)}</a>`
    ).join("")}${openBtn}</div>`;

    let body = "";

    if (tab === "ondeck") {
      body = renderOnDeck();
    } else {
      body = renderOverview();
    }

    const content = `
      <style>${plexStyles()}</style>
      <div class="plex-panel">
        <h1>Plex</h1>
        ${tabBar}
        <div class="plex-body">${body}</div>
      </div>
      <script>${plexScript()}</script>
    `;

    res.send(layout({ title: "Plex", content }));
  },
};

function renderOverview() {
  return `
    <div class="plex-overview">
      <div class="plex-section">
        <h3>Server Info</h3>
        <div id="plex-info" class="plex-info">
          <div class="np-loading">Connecting to Plex...</div>
        </div>
      </div>

      <div class="plex-section">
        <h3>Libraries</h3>
        <div id="plex-libraries" class="plex-stats">
          <div class="np-loading">Loading libraries...</div>
        </div>
      </div>

      <div class="plex-section">
        <h3>Active Sessions</h3>
        <div id="plex-sessions" class="plex-sessions">
          <div class="np-loading">Loading sessions...</div>
        </div>
      </div>
    </div>
  `;
}

function renderOnDeck() {
  return `
    <div class="plex-ondeck-section">
      <div id="plex-ondeck" class="plex-ondeck-grid">
        <div class="np-loading">Loading On Deck...</div>
      </div>
    </div>
  `;
}

function plexScript() {
  return `
    // Safe HTML escaper using textContent
    function escapeH(s) {
      if (!s) return '';
      const d = document.createElement('div');
      d.textContent = String(s);
      return d.innerHTML;
    }

    async function loadServerInfo() {
      const el = document.getElementById('plex-info');
      if (!el) return;
      try {
        const res = await fetch('/api/plex/sessions');
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
        const info = data.serverInfo || {};
        const fields = [
          { label: 'Server', value: info.friendlyName || 'Plex' },
          { label: 'Version', value: info.version || 'Unknown' },
          { label: 'Platform', value: info.platform || 'Unknown' },
        ];
        fields.forEach(function(f) {
          if (f.value) {
            const row = document.createElement('div');
            row.className = 'info-row';
            const labelEl = document.createElement('span');
            labelEl.className = 'info-label';
            labelEl.textContent = f.label + ':';
            row.appendChild(labelEl);
            const valEl = document.createElement('span');
            valEl.className = 'info-value';
            valEl.textContent = f.value;
            row.appendChild(valEl);
            el.appendChild(row);
          }
        });
      } catch (e) {
        el.textContent = '';
        const errDiv = document.createElement('div');
        errDiv.className = 'np-error';
        errDiv.textContent = 'Cannot reach Plex.';
        el.appendChild(errDiv);
      }
    }

    async function loadLibraries() {
      const el = document.getElementById('plex-libraries');
      if (!el) return;
      try {
        const res = await fetch('/api/plex/sessions');
        const data = await res.json();
        if (data.error) {
          el.textContent = '';
          const errDiv = document.createElement('div');
          errDiv.className = 'np-error';
          errDiv.textContent = data.error;
          el.appendChild(errDiv);
          return;
        }

        const libs = data.libraries || [];
        el.textContent = '';

        if (libs.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'np-idle';
          empty.textContent = 'No libraries configured';
          el.appendChild(empty);
          return;
        }

        libs.forEach(function(lib) {
          const card = document.createElement('div');
          card.className = 'stat-card';
          const titleEl = document.createElement('div');
          titleEl.className = 'stat-value';
          titleEl.textContent = lib.title;
          card.appendChild(titleEl);
          const typeEl = document.createElement('div');
          typeEl.className = 'stat-label';
          typeEl.textContent = lib.type;
          card.appendChild(typeEl);
          el.appendChild(card);
        });
      } catch (e) {
        el.textContent = '';
        const errDiv = document.createElement('div');
        errDiv.className = 'np-error';
        errDiv.textContent = 'Cannot reach Plex.';
        el.appendChild(errDiv);
      }
    }

    async function loadSessions() {
      const el = document.getElementById('plex-sessions');
      if (!el) return;
      try {
        const res = await fetch('/api/plex/sessions');
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
          titleEl.textContent = s.title;
          card.appendChild(titleEl);

          const subEl = document.createElement('div');
          subEl.className = 'np-subtitle';
          subEl.textContent = s.user + ' on ' + s.player + ' (' + s.platform + ')';
          card.appendChild(subEl);

          if (s.progress !== undefined) {
            const progWrap = document.createElement('div');
            progWrap.className = 'np-progress';
            const progBar = document.createElement('div');
            progBar.className = 'np-bar';
            progBar.style.width = s.progress + '%';
            progWrap.appendChild(progBar);
            card.appendChild(progWrap);

            const timeEl = document.createElement('div');
            timeEl.className = 'np-time';
            timeEl.textContent = s.position + ' / ' + s.duration + ' (' + s.progress + '%)';
            if (s.state) timeEl.textContent += ' - ' + s.state;
            card.appendChild(timeEl);
          }

          if (s.transcoding) {
            const transEl = document.createElement('div');
            transEl.className = 'np-time';
            transEl.textContent = 'Transcoding: ' + s.transcoding;
            card.appendChild(transEl);
          }

          el.appendChild(card);
        });
      } catch (e) {
        el.textContent = '';
        const errDiv = document.createElement('div');
        errDiv.className = 'np-error';
        errDiv.textContent = 'Cannot reach Plex.';
        el.appendChild(errDiv);
      }
    }

    async function loadOnDeck() {
      const el = document.getElementById('plex-ondeck');
      if (!el) return;
      try {
        const res = await fetch('/api/plex/on-deck');
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
          idle.textContent = 'Nothing on deck - all caught up!';
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

          if (item.show) {
            const showEl = document.createElement('div');
            showEl.className = 'lib-meta';
            showEl.textContent = item.show;
            if (item.season !== undefined && item.episode !== undefined) {
              showEl.textContent += ' S' + item.season + 'E' + item.episode;
            }
            card.appendChild(showEl);
          }

          const meta = document.createElement('div');
          meta.className = 'lib-meta';
          const parts = [item.type];
          if (item.year) parts.push(String(item.year));
          if (item.runtime) parts.push(item.runtime);
          meta.textContent = parts.join(' \u00b7 ');
          card.appendChild(meta);

          if (item.resumePosition) {
            const resumeEl = document.createElement('div');
            resumeEl.className = 'lib-meta';
            resumeEl.textContent = 'Resume at ' + item.resumePosition;
            card.appendChild(resumeEl);
          }

          el.appendChild(card);
        });
      } catch (e) {
        el.textContent = '';
        const errDiv = document.createElement('div');
        errDiv.className = 'np-error';
        errDiv.textContent = 'Failed to load On Deck.';
        el.appendChild(errDiv);
      }
    }

    // Init
    if (document.getElementById('plex-info')) {
      loadServerInfo();
      loadLibraries();
      loadSessions();
      // Track on window so Turbo re-entries clear the prior poll.
      if (window.__plexSessionsInterval) clearInterval(window.__plexSessionsInterval);
      window.__plexSessionsInterval = setInterval(loadSessions, 10000);
    }
    if (document.getElementById('plex-ondeck')) {
      loadOnDeck();
    }
  `;
}

function plexStyles() {
  return `
    .plex-panel h1 { margin: 0 0 1rem; font-size: 1.5rem; }
    .plex-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--crow-border); margin-bottom: 1.5rem; align-items: center; }
    .plex-tab { padding: 0.6rem 1.2rem; color: var(--crow-text-secondary); text-decoration: none;
                border-bottom: 2px solid transparent; transition: all 0.2s; }
    .plex-tab:hover { color: var(--crow-text-primary); }
    .plex-tab.active { color: var(--crow-accent); border-bottom-color: var(--crow-accent); }
    .plex-open-btn { margin-left: auto; padding: 0.4rem 0.8rem; background: var(--crow-accent); border-radius: 6px;
                     color: #fff; text-decoration: none; font-size: 0.85rem; transition: background 0.15s; }
    .plex-open-btn:hover { background: var(--crow-accent-hover); }

    .plex-overview { display: flex; flex-direction: column; gap: 1.5rem; }
    .plex-section h3 { font-size: 0.85rem; color: var(--crow-text-muted); text-transform: uppercase;
                       letter-spacing: 0.05em; margin: 0 0 0.8rem; }

    /* Server Info */
    .plex-info { background: var(--crow-bg-elevated); border-radius: 10px; padding: 1rem; }
    .info-row { display: flex; gap: 0.5rem; padding: 0.3rem 0; }
    .info-label { color: var(--crow-text-muted); font-size: 0.85rem; min-width: 80px; }
    .info-value { color: var(--crow-text-primary); font-size: 0.85rem; }

    /* Stats / Libraries */
    .plex-stats { display: flex; gap: 1rem; flex-wrap: wrap; }
    .stat-card { background: var(--crow-bg-elevated); border-radius: 10px; padding: 1rem 1.2rem;
                 border: 1px solid var(--crow-border); min-width: 100px; text-align: center; }
    .stat-value { font-size: 1rem; font-weight: 700; color: var(--crow-accent); }
    .stat-label { font-size: 0.8rem; color: var(--crow-text-muted); margin-top: 0.2rem; text-transform: capitalize; }

    /* Sessions / Now Playing */
    .plex-sessions { display: flex; flex-direction: column; gap: 0.8rem; }
    .np-card { background: var(--crow-bg-elevated); border-radius: 12px; padding: 1.2rem; }
    .np-title { font-size: 1.1rem; font-weight: 600; color: var(--crow-text-primary); margin-bottom: 0.3rem; }
    .np-subtitle { font-size: 0.85rem; color: var(--crow-text-secondary); margin-bottom: 0.4rem; }
    .np-progress { background: var(--crow-bg-deep); border-radius: 4px; height: 6px; margin: 0.6rem 0 0.4rem; overflow: hidden; }
    .np-bar { background: var(--crow-accent); height: 100%; border-radius: 4px; transition: width 0.5s ease; }
    .np-time { font-size: 0.8rem; color: var(--crow-text-muted); }
    .np-idle, .np-loading { color: var(--crow-text-muted); font-size: 0.9rem; padding: 1rem;
                            background: var(--crow-bg-elevated); border-radius: 12px; text-align: center; }
    .np-error { color: var(--crow-error); font-size: 0.9rem; padding: 1rem;
                background: var(--crow-bg-elevated); border-radius: 12px; text-align: center; }

    /* On Deck grid */
    .plex-ondeck-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 1rem; }
    .lib-card { background: var(--crow-bg-elevated); border-radius: 10px; padding: 1rem;
                border: 1px solid var(--crow-border); transition: border-color 0.2s; }
    .lib-card:hover { border-color: var(--crow-accent); }
    .lib-title { font-weight: 600; color: var(--crow-text-primary); margin-bottom: 0.3rem; font-size: 0.95rem; }
    .lib-meta { font-size: 0.8rem; color: var(--crow-text-muted); }

    @media (max-width: 600px) {
      .plex-stats { flex-direction: column; }
      .plex-ondeck-grid { grid-template-columns: 1fr; }
    }
  `;
}
