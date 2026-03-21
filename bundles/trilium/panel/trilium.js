/**
 * Crow's Nest Panel — TriliumNext: note search, recent notes, web UI embed
 *
 * Bundle-compatible version: uses dynamic imports with appRoot instead of
 * static ESM imports, so this panel works both from the repo and when
 * installed to ~/.crow/panels/.
 *
 * Note: Client-side JS uses textContent-based escapeH() for safe HTML rendering,
 * matching the pattern used by other Crow panels (kodi, jellyfin, iptv).
 */

export default {
  id: "trilium",
  name: "TriliumNext",
  icon: "book-open",
  route: "/dashboard/trilium",
  navOrder: 28,
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

    const tabBar = `<div class="tn-tabs">${tabs.map((t) =>
      `<a href="?tab=${escapeHtml(t.id)}" class="tn-tab${tab === t.id ? " active" : ""}">${escapeHtml(t.label)}</a>`
    ).join("")}</div>`;

    let body = "";

    if (tab === "webui") {
      const triliumUrl = process.env.TRILIUM_URL || "http://localhost:8088";
      body = `
        <div class="tn-webui">
          <iframe src="${escapeHtml(triliumUrl)}" class="tn-iframe" allow="fullscreen"></iframe>
        </div>
      `;
    } else {
      body = renderOverview();
    }

    const content = `
      <style>${triliumStyles()}</style>
      <div class="tn-panel">
        <h1>TriliumNext</h1>
        ${tabBar}
        <div class="tn-body">${body}</div>
      </div>
      <script>${triliumScript()}</script>
    `;

    res.send(layout({ title: "TriliumNext", content }));
  },
};

function renderOverview() {
  return `
    <div class="tn-overview">
      <div class="tn-section">
        <h3>Quick Search</h3>
        <div class="tn-search-bar">
          <input type="text" id="tn-search-input" placeholder="Search notes..." class="tn-input" />
          <button id="tn-search-btn" class="tn-btn">Search</button>
        </div>
        <div id="tn-search-results" class="tn-results"></div>
      </div>

      <div class="tn-section">
        <h3>Recent Notes</h3>
        <div id="tn-recent" class="tn-notes-list">
          <div class="tn-loading">Loading...</div>
        </div>
      </div>
    </div>
  `;
}

function triliumScript() {
  return `
    function escapeH(s) {
      if (!s) return '';
      const d = document.createElement('div');
      d.textContent = String(s);
      return d.innerHTML;
    }

    async function loadRecent() {
      const el = document.getElementById('tn-recent');
      if (!el) return;
      try {
        const res = await fetch('/api/trilium/recent');
        const data = await res.json();
        if (data.error) {
          el.textContent = '';
          const errDiv = document.createElement('div');
          errDiv.className = 'tn-error';
          errDiv.textContent = data.error;
          el.appendChild(errDiv);
          return;
        }

        const notes = data.notes || [];
        el.textContent = '';

        if (notes.length === 0) {
          const idle = document.createElement('div');
          idle.className = 'tn-idle';
          idle.textContent = 'No recent notes';
          el.appendChild(idle);
          return;
        }

        notes.forEach(function(note) {
          const card = document.createElement('div');
          card.className = 'tn-note-card';

          const titleEl = document.createElement('div');
          titleEl.className = 'tn-note-title';
          titleEl.textContent = note.title;
          card.appendChild(titleEl);

          const meta = document.createElement('div');
          meta.className = 'tn-note-meta';
          const parts = [note.type];
          if (note.dateModified) {
            parts.push(note.dateModified.slice(0, 16).replace('T', ' '));
          }
          meta.textContent = parts.join(' · ');
          card.appendChild(meta);

          el.appendChild(card);
        });
      } catch (e) {
        el.textContent = '';
        const errDiv = document.createElement('div');
        errDiv.className = 'tn-error';
        errDiv.textContent = 'Cannot reach TriliumNext.';
        el.appendChild(errDiv);
      }
    }

    async function doSearch() {
      const input = document.getElementById('tn-search-input');
      const el = document.getElementById('tn-search-results');
      if (!input || !el) return;
      const q = input.value.trim();
      if (!q) return;

      el.textContent = '';
      const loadDiv = document.createElement('div');
      loadDiv.className = 'tn-loading';
      loadDiv.textContent = 'Searching...';
      el.appendChild(loadDiv);

      try {
        const res = await fetch('/api/trilium/search?q=' + encodeURIComponent(q));
        const data = await res.json();
        el.textContent = '';

        if (data.error) {
          const errDiv = document.createElement('div');
          errDiv.className = 'tn-error';
          errDiv.textContent = data.error;
          el.appendChild(errDiv);
          return;
        }

        const notes = data.notes || [];
        if (notes.length === 0) {
          const idle = document.createElement('div');
          idle.className = 'tn-idle';
          idle.textContent = 'No results found';
          el.appendChild(idle);
          return;
        }

        notes.forEach(function(note) {
          const card = document.createElement('div');
          card.className = 'tn-note-card';

          const titleEl = document.createElement('div');
          titleEl.className = 'tn-note-title';
          titleEl.textContent = note.title;
          card.appendChild(titleEl);

          const meta = document.createElement('div');
          meta.className = 'tn-note-meta';
          meta.textContent = note.type + (note.noteId ? ' · ' + note.noteId : '');
          card.appendChild(meta);

          el.appendChild(card);
        });
      } catch (e) {
        el.textContent = '';
        const errDiv = document.createElement('div');
        errDiv.className = 'tn-error';
        errDiv.textContent = 'Search failed.';
        el.appendChild(errDiv);
      }
    }

    // Init
    loadRecent();

    const searchBtn = document.getElementById('tn-search-btn');
    if (searchBtn) searchBtn.addEventListener('click', doSearch);

    const searchInput = document.getElementById('tn-search-input');
    if (searchInput) {
      searchInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') doSearch();
      });
    }
  `;
}

function triliumStyles() {
  return `
    .tn-panel h1 { margin: 0 0 1rem; font-size: 1.5rem; }
    .tn-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--crow-border); margin-bottom: 1.5rem; }
    .tn-tab { padding: 0.6rem 1.2rem; color: var(--crow-text-secondary); text-decoration: none;
              border-bottom: 2px solid transparent; transition: all 0.2s; }
    .tn-tab:hover { color: var(--crow-text-primary); }
    .tn-tab.active { color: var(--crow-accent); border-bottom-color: var(--crow-accent); }

    .tn-overview { display: flex; flex-direction: column; gap: 1.5rem; }
    .tn-section h3 { font-size: 0.85rem; color: var(--crow-text-muted); text-transform: uppercase;
                     letter-spacing: 0.05em; margin: 0 0 0.8rem; }

    /* Search */
    .tn-search-bar { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
    .tn-input { flex: 1; padding: 0.6rem 0.8rem; background: var(--crow-bg-elevated); border: 1px solid var(--crow-border);
                border-radius: 8px; color: var(--crow-text-primary); font-size: 0.9rem; outline: none; }
    .tn-input:focus { border-color: var(--crow-accent); }
    .tn-btn { padding: 0.6rem 1rem; background: var(--crow-accent); border: none; border-radius: 8px;
              color: #fff; cursor: pointer; font-size: 0.9rem; transition: background 0.15s; }
    .tn-btn:hover { background: var(--crow-accent-hover); }

    /* Notes list */
    .tn-notes-list { display: flex; flex-direction: column; gap: 0.6rem; }
    .tn-results { display: flex; flex-direction: column; gap: 0.6rem; }
    .tn-note-card { background: var(--crow-bg-elevated); border-radius: 10px; padding: 1rem;
                    border: 1px solid var(--crow-border); transition: border-color 0.2s; }
    .tn-note-card:hover { border-color: var(--crow-accent); }
    .tn-note-title { font-weight: 600; color: var(--crow-text-primary); margin-bottom: 0.2rem; font-size: 0.95rem; }
    .tn-note-meta { font-size: 0.8rem; color: var(--crow-text-muted); }

    .tn-idle, .tn-loading { color: var(--crow-text-muted); font-size: 0.9rem; padding: 1rem;
                            background: var(--crow-bg-elevated); border-radius: 12px; text-align: center; }
    .tn-error { color: var(--crow-error); font-size: 0.9rem; padding: 1rem;
                background: var(--crow-bg-elevated); border-radius: 12px; text-align: center; }

    /* Web UI iframe */
    .tn-webui { width: 100%; height: calc(100vh - 200px); min-height: 500px; }
    .tn-iframe { width: 100%; height: 100%; border: none; border-radius: 12px;
                 background: var(--crow-bg-elevated); }

    @media (max-width: 600px) {
      .tn-search-bar { flex-direction: column; }
    }
  `;
}
