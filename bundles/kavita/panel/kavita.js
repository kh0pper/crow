/**
 * Crow's Nest Panel — Kavita: library overview, recently added, web UI embed
 *
 * Bundle-compatible version: uses dynamic imports with appRoot instead of
 * static ESM imports, so this panel works both from the repo and when
 * installed to ~/.crow/panels/.
 *
 * Note: Client-side JS uses textContent-based escapeH() for safe HTML rendering,
 * matching the pattern used by other Crow panels (jellyfin, kodi, media, iptv).
 */

export default {
  id: "kavita",
  name: "Kavita",
  icon: "book",
  route: "/dashboard/kavita",
  navOrder: 32,
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

    const tabBar = `<div class="kv-tabs">${tabs.map((t) =>
      `<a href="?tab=${escapeHtml(t.id)}" class="kv-tab${tab === t.id ? " active" : ""}">${escapeHtml(t.label)}</a>`
    ).join("")}</div>`;

    let body = "";

    if (tab === "webui") {
      const kavitaUrl = process.env.KAVITA_URL || "http://localhost:5000";
      body = `
        <div class="kv-webui">
          <iframe src="${escapeHtml(kavitaUrl)}" class="kv-iframe" allow="fullscreen"></iframe>
        </div>
      `;
    } else {
      body = renderOverview();
    }

    const content = `
      <style>${kavitaStyles()}</style>
      <div class="kv-panel">
        <h1>Kavita</h1>
        ${tabBar}
        <div class="kv-body">${body}</div>
      </div>
      <script>${kavitaScript()}</script>
    `;

    res.send(layout({ title: "Kavita", content }));
  },
};

function renderOverview() {
  return `
    <div class="kv-overview">
      <div class="kv-section">
        <h3>Libraries</h3>
        <div id="kv-libraries" class="kv-libraries">
          <div class="np-loading">Loading libraries...</div>
        </div>
      </div>

      <div class="kv-section">
        <h3>Recently Added</h3>
        <div id="kv-recent" class="kv-recent-grid">
          <div class="np-loading">Loading...</div>
        </div>
      </div>

      <div class="kv-section">
        <h3>Want to Read</h3>
        <div id="kv-wanttoread" class="kv-recent-grid">
          <div class="np-loading">Loading...</div>
        </div>
      </div>
    </div>
  `;
}

function kavitaScript() {
  return `
    function escapeH(s) {
      if (!s) return '';
      const d = document.createElement('div');
      d.textContent = String(s);
      return d.innerHTML;
    }

    async function loadLibraries() {
      const el = document.getElementById('kv-libraries');
      if (!el) return;
      try {
        const res = await fetch('/api/kavita/libraries');
        const data = await res.json();
        if (data.error) {
          el.textContent = '';
          const errDiv = document.createElement('div');
          errDiv.className = 'np-error';
          errDiv.textContent = data.error;
          el.appendChild(errDiv);
          return;
        }

        const libraries = data.libraries || [];
        el.textContent = '';

        if (libraries.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'np-idle';
          empty.textContent = 'No libraries configured';
          el.appendChild(empty);
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
          typeEl.textContent = 'Type: ' + (lib.type || 'Unknown');
          card.appendChild(typeEl);
          el.appendChild(card);
        });
      } catch (e) {
        el.textContent = '';
        const errDiv = document.createElement('div');
        errDiv.className = 'np-error';
        errDiv.textContent = 'Cannot reach Kavita.';
        el.appendChild(errDiv);
      }
    }

    async function loadRecent() {
      const el = document.getElementById('kv-recent');
      if (!el) return;
      try {
        const res = await fetch('/api/kavita/recent');
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
          idle.textContent = 'No recently added series';
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
          const parts = [item.format];
          if (item.pages) parts.push(item.pages + ' pages');
          if (item.libraryName) parts.push(item.libraryName);
          meta.textContent = parts.join(' · ');
          card.appendChild(meta);

          el.appendChild(card);
        });
      } catch (e) {
        el.textContent = '';
        const errDiv = document.createElement('div');
        errDiv.className = 'np-error';
        errDiv.textContent = 'Failed to load recent series.';
        el.appendChild(errDiv);
      }
    }

    async function loadWantToRead() {
      const el = document.getElementById('kv-wanttoread');
      if (!el) return;
      try {
        const res = await fetch('/api/kavita/want-to-read');
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
          idle.textContent = 'Want-to-read list is empty';
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
          const parts = [item.format];
          if (item.pages) parts.push(item.pages + ' pages');
          meta.textContent = parts.join(' · ');
          card.appendChild(meta);

          el.appendChild(card);
        });
      } catch (e) {
        el.textContent = '';
        const errDiv = document.createElement('div');
        errDiv.className = 'np-error';
        errDiv.textContent = 'Failed to load want-to-read list.';
        el.appendChild(errDiv);
      }
    }

    // Init
    loadLibraries();
    loadRecent();
    loadWantToRead();
  `;
}

function kavitaStyles() {
  return `
    .kv-panel h1 { margin: 0 0 1rem; font-size: 1.5rem; }
    .kv-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--crow-border); margin-bottom: 1.5rem; }
    .kv-tab { padding: 0.6rem 1.2rem; color: var(--crow-text-secondary); text-decoration: none;
              border-bottom: 2px solid transparent; transition: all 0.2s; }
    .kv-tab:hover { color: var(--crow-text-primary); }
    .kv-tab.active { color: var(--crow-accent); border-bottom-color: var(--crow-accent); }

    .kv-overview { display: flex; flex-direction: column; gap: 1.5rem; }
    .kv-section h3 { font-size: 0.85rem; color: var(--crow-text-muted); text-transform: uppercase;
                     letter-spacing: 0.05em; margin: 0 0 0.8rem; }

    /* Stats */
    .kv-libraries { display: flex; gap: 1rem; flex-wrap: wrap; }
    .stat-card { background: var(--crow-bg-elevated); border-radius: 10px; padding: 1rem 1.2rem;
                 border: 1px solid var(--crow-border); min-width: 100px; text-align: center; }
    .stat-value { font-size: 1.1rem; font-weight: 700; color: var(--crow-accent); }
    .stat-label { font-size: 0.8rem; color: var(--crow-text-muted); margin-top: 0.2rem; }

    /* Loading / Error / Idle */
    .np-idle, .np-loading { color: var(--crow-text-muted); font-size: 0.9rem; padding: 1rem;
                            background: var(--crow-bg-elevated); border-radius: 12px; text-align: center; }
    .np-error { color: var(--crow-error); font-size: 0.9rem; padding: 1rem;
                background: var(--crow-bg-elevated); border-radius: 12px; text-align: center; }

    /* Recent grid */
    .kv-recent-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 1rem; }
    .lib-card { background: var(--crow-bg-elevated); border-radius: 10px; padding: 1rem;
                border: 1px solid var(--crow-border); transition: border-color 0.2s; }
    .lib-card:hover { border-color: var(--crow-accent); }
    .lib-title { font-weight: 600; color: var(--crow-text-primary); margin-bottom: 0.3rem; font-size: 0.95rem; }
    .lib-meta { font-size: 0.8rem; color: var(--crow-text-muted); }

    /* Web UI iframe */
    .kv-webui { width: 100%; height: calc(100vh - 200px); min-height: 500px; }
    .kv-iframe { width: 100%; height: 100%; border: none; border-radius: 12px;
                 background: var(--crow-bg-elevated); }

    @media (max-width: 600px) {
      .kv-libraries { flex-direction: column; }
      .kv-recent-grid { grid-template-columns: 1fr; }
    }
  `;
}
