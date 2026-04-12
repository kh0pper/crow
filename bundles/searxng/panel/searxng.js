/**
 * Crow's Nest Panel — SearXNG: simple search box + results + web UI embed.
 *
 * Client-side JS uses textContent + createElement only (XSS-safe).
 */

export default {
  id: "searxng",
  name: "SearXNG",
  icon: "search",
  route: "/dashboard/searxng",
  navOrder: 45,
  category: "productivity",

  async handler(req, res, { layout, appRoot }) {
    const { pathToFileURL } = await import("node:url");
    const { join } = await import("node:path");

    const componentsPath = join(appRoot, "servers/gateway/dashboard/shared/components.js");
    const { escapeHtml } = await import(pathToFileURL(componentsPath).href);

    const tab = req.query.tab || "search";
    const tabs = [
      { id: "search", label: "Search" },
      { id: "webui", label: "Web UI" },
    ];

    const tabBar = `<div class="sx-tabs">${tabs.map((t) =>
      `<a href="?tab=${escapeHtml(t.id)}" class="sx-tab${tab === t.id ? " active" : ""}">${escapeHtml(t.label)}</a>`
    ).join("")}</div>`;

    let body = "";
    if (tab === "webui") {
      const url = process.env.SEARXNG_BASE_URL || "http://localhost:8098/";
      body = `<div class="sx-webui"><iframe src="${escapeHtml(url)}" class="sx-iframe" allow="fullscreen"></iframe></div>`;
    } else {
      body = renderSearch();
    }

    const content = `
      <style>${searxngStyles()}</style>
      <div class="sx-panel">
        <h1>SearXNG</h1>
        ${tabBar}
        <div class="sx-body">${body}</div>
      </div>
      <script>${searxngScript()}</script>
    `;

    res.send(layout({ title: "SearXNG", content }));
  },
};

function renderSearch() {
  return `
    <div class="sx-search-wrap">
      <div id="sx-status" class="sx-status"><div class="np-loading">Checking...</div></div>

      <form id="sx-form" class="sx-form" onsubmit="return false;">
        <input id="sx-q" type="search" placeholder="Search the web privately..." autocomplete="off" maxlength="500" />
        <button id="sx-btn" type="submit">Search</button>
      </form>

      <div id="sx-results" class="sx-results"></div>
    </div>
  `;
}

function searxngScript() {
  return `
    async function loadStatus() {
      const el = document.getElementById('sx-status');
      if (!el) return;
      try {
        const res = await fetch('/api/searxng/status');
        const data = await res.json();
        el.textContent = '';
        const card = document.createElement('div');
        card.className = 'stat-card';
        const val = document.createElement('div');
        val.className = 'stat-value';
        val.textContent = data.reachable ? 'Online' : 'Offline';
        if (!data.reachable) card.classList.add('stat-warn');
        card.appendChild(val);
        const label = document.createElement('div');
        label.className = 'stat-label';
        label.textContent = data.url;
        card.appendChild(label);
        el.appendChild(card);
      } catch (e) {
        el.textContent = '';
        const err = document.createElement('div');
        err.className = 'np-error';
        err.textContent = 'Failed to check status.';
        el.appendChild(err);
      }
    }

    async function doSearch() {
      const q = document.getElementById('sx-q').value.trim();
      const out = document.getElementById('sx-results');
      out.textContent = '';
      if (!q) return;

      const loading = document.createElement('div');
      loading.className = 'np-loading';
      loading.textContent = 'Searching...';
      out.appendChild(loading);

      try {
        const res = await fetch('/api/searxng/search?q=' + encodeURIComponent(q));
        const data = await res.json();
        out.textContent = '';
        if (data.error) {
          const err = document.createElement('div');
          err.className = 'np-error';
          err.textContent = data.error;
          out.appendChild(err);
          return;
        }
        const results = data.results || [];
        if (results.length === 0) {
          const idle = document.createElement('div');
          idle.className = 'np-idle';
          idle.textContent = 'No results.';
          out.appendChild(idle);
          return;
        }
        results.forEach(function(r) {
          const card = document.createElement('div');
          card.className = 'res-card';

          const a = document.createElement('a');
          a.className = 'res-title';
          a.href = r.url;
          a.target = '_blank';
          a.rel = 'noopener';
          a.textContent = r.title || r.url;
          card.appendChild(a);

          const u = document.createElement('div');
          u.className = 'res-url';
          u.textContent = r.url;
          card.appendChild(u);

          if (r.content) {
            const c = document.createElement('div');
            c.className = 'res-snippet';
            c.textContent = r.content;
            card.appendChild(c);
          }

          if (r.engine) {
            const e = document.createElement('div');
            e.className = 'res-meta';
            e.textContent = 'via ' + r.engine;
            card.appendChild(e);
          }

          out.appendChild(card);
        });
      } catch (e) {
        out.textContent = '';
        const err = document.createElement('div');
        err.className = 'np-error';
        err.textContent = 'Search failed.';
        out.appendChild(err);
      }
    }

    loadStatus();
    const form = document.getElementById('sx-form');
    if (form) {
      form.addEventListener('submit', function(ev) { ev.preventDefault(); doSearch(); });
    }
    const btn = document.getElementById('sx-btn');
    if (btn) btn.addEventListener('click', doSearch);
  `;
}

function searxngStyles() {
  return `
    .sx-panel h1 { margin: 0 0 1rem; font-size: 1.5rem; }
    .sx-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--crow-border); margin-bottom: 1.5rem; }
    .sx-tab { padding: 0.6rem 1.2rem; color: var(--crow-text-secondary); text-decoration: none;
              border-bottom: 2px solid transparent; transition: all 0.2s; }
    .sx-tab:hover { color: var(--crow-text-primary); }
    .sx-tab.active { color: var(--crow-accent); border-bottom-color: var(--crow-accent); }

    .sx-status { display: flex; gap: 1rem; margin-bottom: 1rem; }
    .stat-card { background: var(--crow-bg-elevated); border-radius: 10px; padding: 0.6rem 1rem;
                 border: 1px solid var(--crow-border); min-width: 160px; }
    .stat-card.stat-warn { border-color: var(--crow-error); }
    .stat-card.stat-warn .stat-value { color: var(--crow-error); }
    .stat-value { font-size: 1rem; font-weight: 700; color: var(--crow-accent); }
    .stat-label { font-size: 0.75rem; color: var(--crow-text-muted); margin-top: 0.2rem; font-family: monospace; word-break: break-all; }

    .sx-form { display: flex; gap: 0.5rem; margin-bottom: 1.5rem; }
    .sx-form input { flex: 1; padding: 0.6rem 0.8rem; background: var(--crow-bg-elevated);
                     border: 1px solid var(--crow-border); border-radius: 8px; color: var(--crow-text-primary);
                     font-size: 0.95rem; }
    .sx-form input:focus { outline: none; border-color: var(--crow-accent); }
    .sx-form button { padding: 0.6rem 1.2rem; background: var(--crow-accent); color: #fff;
                      border: none; border-radius: 8px; font-weight: 600; cursor: pointer; }
    .sx-form button:hover { filter: brightness(1.1); }

    .sx-results { display: flex; flex-direction: column; gap: 0.8rem; }
    .res-card { background: var(--crow-bg-elevated); border-radius: 10px; padding: 0.9rem 1rem;
                border: 1px solid var(--crow-border); transition: border-color 0.2s; }
    .res-card:hover { border-color: var(--crow-accent); }
    .res-title { font-weight: 600; color: var(--crow-accent); text-decoration: none; font-size: 0.98rem; }
    .res-title:hover { text-decoration: underline; }
    .res-url { font-size: 0.78rem; color: var(--crow-text-muted); font-family: monospace; word-break: break-all; margin-top: 0.15rem; }
    .res-snippet { font-size: 0.88rem; color: var(--crow-text-secondary); margin-top: 0.4rem; line-height: 1.4; }
    .res-meta { font-size: 0.75rem; color: var(--crow-text-muted); margin-top: 0.3rem; }

    .np-idle, .np-loading { color: var(--crow-text-muted); font-size: 0.9rem; padding: 1rem;
                            background: var(--crow-bg-elevated); border-radius: 12px; text-align: center; }
    .np-error { color: var(--crow-error); font-size: 0.9rem; padding: 0.8rem;
                background: var(--crow-bg-elevated); border-radius: 12px; text-align: center; }

    .sx-webui { width: 100%; height: calc(100vh - 200px); min-height: 500px; }
    .sx-iframe { width: 100%; height: 100%; border: none; border-radius: 12px; background: var(--crow-bg-elevated); }
  `;
}
