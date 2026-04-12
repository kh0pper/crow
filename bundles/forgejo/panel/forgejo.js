/**
 * Crow's Nest Panel — Forgejo: repo overview and web UI embed.
 *
 * Mirrors the Gitea panel — Forgejo's REST API is compatible. Client-side
 * JS uses textContent + createElement only (XSS-safe).
 */

export default {
  id: "forgejo",
  name: "Forgejo",
  icon: "git",
  route: "/dashboard/forgejo",
  navOrder: 43,
  category: "infrastructure",

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

    const tabBar = `<div class="fj-tabs">${tabs.map((t) =>
      `<a href="?tab=${escapeHtml(t.id)}" class="fj-tab${tab === t.id ? " active" : ""}">${escapeHtml(t.label)}</a>`
    ).join("")}</div>`;

    let body = "";
    if (tab === "webui") {
      const url = process.env.FORGEJO_URL || "http://localhost:3050";
      body = `<div class="fj-webui"><iframe src="${escapeHtml(url)}" class="fj-iframe" allow="fullscreen"></iframe></div>`;
    } else {
      body = renderOverview();
    }

    const content = `
      <style>${forgejoStyles()}</style>
      <div class="fj-panel">
        <h1>Forgejo</h1>
        ${tabBar}
        <div class="fj-body">${body}</div>
      </div>
      <script>${forgejoScript()}</script>
    `;

    res.send(layout({ title: "Forgejo", content }));
  },
};

function renderOverview() {
  return `
    <div class="fj-overview">
      <div class="fj-section">
        <h3>Status</h3>
        <div id="fj-status" class="fj-status"><div class="np-loading">Checking...</div></div>
      </div>
      <div class="fj-section">
        <h3>Recently Updated Repos</h3>
        <div id="fj-repos" class="fj-repo-list"><div class="np-loading">Loading...</div></div>
      </div>
    </div>
  `;
}

function forgejoScript() {
  return `
    async function loadStatus() {
      const el = document.getElementById('fj-status');
      if (!el) return;
      try {
        const res = await fetch('/api/forgejo/stats');
        const data = await res.json();
        el.textContent = '';
        if (!data.reachable) {
          const err = document.createElement('div');
          err.className = 'np-error';
          err.textContent = data.error || 'Cannot reach Forgejo.';
          el.appendChild(err);
          return;
        }
        const card = document.createElement('div');
        card.className = 'stat-card';
        const val = document.createElement('div');
        val.className = 'stat-value';
        val.textContent = 'OK';
        card.appendChild(val);
        const label = document.createElement('div');
        label.className = 'stat-label';
        label.textContent = data.has_token ? 'Connected with token' : 'No token configured';
        card.appendChild(label);
        el.appendChild(card);

        const urlCard = document.createElement('div');
        urlCard.className = 'stat-card';
        const uv = document.createElement('div');
        uv.className = 'stat-url';
        uv.textContent = data.url;
        urlCard.appendChild(uv);
        const ul = document.createElement('div');
        ul.className = 'stat-label';
        ul.textContent = 'Server URL';
        urlCard.appendChild(ul);
        el.appendChild(urlCard);
      } catch (e) {
        el.textContent = '';
        const err = document.createElement('div');
        err.className = 'np-error';
        err.textContent = 'Failed to reach status endpoint.';
        el.appendChild(err);
      }
    }

    async function loadRepos() {
      const el = document.getElementById('fj-repos');
      if (!el) return;
      try {
        const res = await fetch('/api/forgejo/repos');
        const data = await res.json();
        el.textContent = '';
        if (data.error) {
          const err = document.createElement('div');
          err.className = 'np-error';
          err.textContent = data.error;
          el.appendChild(err);
          return;
        }
        const repos = data.repos || [];
        if (repos.length === 0) {
          const idle = document.createElement('div');
          idle.className = 'np-idle';
          idle.textContent = 'No repositories yet — create one on the Web UI tab.';
          el.appendChild(idle);
          return;
        }
        repos.forEach(function(r) {
          const card = document.createElement('div');
          card.className = 'lib-card';

          const title = document.createElement('div');
          title.className = 'lib-title';
          title.textContent = r.full_name + (r.private ? ' (private)' : '');
          card.appendChild(title);

          if (r.description) {
            const d = document.createElement('div');
            d.className = 'lib-desc';
            d.textContent = r.description;
            card.appendChild(d);
          }

          const meta = document.createElement('div');
          meta.className = 'lib-meta';
          const parts = [];
          if (typeof r.stars === 'number') parts.push('\\u2605 ' + r.stars);
          if (typeof r.open_issues === 'number') parts.push('issues: ' + r.open_issues);
          if (r.updated_at) parts.push('updated ' + new Date(r.updated_at).toLocaleDateString());
          meta.textContent = parts.join(' \\u00b7 ');
          card.appendChild(meta);

          el.appendChild(card);
        });
      } catch (e) {
        el.textContent = '';
        const err = document.createElement('div');
        err.className = 'np-error';
        err.textContent = 'Failed to load repositories.';
        el.appendChild(err);
      }
    }

    loadStatus();
    loadRepos();
  `;
}

function forgejoStyles() {
  return `
    .fj-panel h1 { margin: 0 0 1rem; font-size: 1.5rem; }
    .fj-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--crow-border); margin-bottom: 1.5rem; }
    .fj-tab { padding: 0.6rem 1.2rem; color: var(--crow-text-secondary); text-decoration: none;
              border-bottom: 2px solid transparent; transition: all 0.2s; }
    .fj-tab:hover { color: var(--crow-text-primary); }
    .fj-tab.active { color: var(--crow-accent); border-bottom-color: var(--crow-accent); }

    .fj-overview { display: flex; flex-direction: column; gap: 1.5rem; }
    .fj-section h3 { font-size: 0.85rem; color: var(--crow-text-muted); text-transform: uppercase;
                     letter-spacing: 0.05em; margin: 0 0 0.8rem; }

    .fj-status { display: flex; gap: 1rem; flex-wrap: wrap; }
    .stat-card { background: var(--crow-bg-elevated); border-radius: 10px; padding: 1rem 1.2rem;
                 border: 1px solid var(--crow-border); min-width: 150px; }
    .stat-value { font-size: 1.2rem; font-weight: 700; color: var(--crow-accent); }
    .stat-url { font-size: 0.9rem; font-family: monospace; color: var(--crow-text-primary); word-break: break-all; }
    .stat-label { font-size: 0.8rem; color: var(--crow-text-muted); margin-top: 0.25rem; }

    .fj-repo-list { display: flex; flex-direction: column; gap: 0.6rem; }
    .lib-card { background: var(--crow-bg-elevated); border-radius: 10px; padding: 1rem;
                border: 1px solid var(--crow-border); transition: border-color 0.2s; }
    .lib-card:hover { border-color: var(--crow-accent); }
    .lib-title { font-weight: 600; color: var(--crow-text-primary); font-size: 0.95rem; }
    .lib-desc { font-size: 0.85rem; color: var(--crow-text-secondary); margin-top: 0.3rem; }
    .lib-meta { font-size: 0.8rem; color: var(--crow-text-muted); margin-top: 0.3rem; }

    .np-idle, .np-loading { color: var(--crow-text-muted); font-size: 0.9rem; padding: 1rem;
                            background: var(--crow-bg-elevated); border-radius: 12px; text-align: center; }
    .np-error { color: var(--crow-error); font-size: 0.9rem; padding: 1rem;
                background: var(--crow-bg-elevated); border-radius: 12px; text-align: center; }

    .fj-webui { width: 100%; height: calc(100vh - 200px); min-height: 500px; }
    .fj-iframe { width: 100%; height: 100%; border: none; border-radius: 12px; background: var(--crow-bg-elevated); }
  `;
}
