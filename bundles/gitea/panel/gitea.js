/**
 * Crow's Nest Panel — Gitea: repo overview and web UI embed.
 *
 * Client-side JS uses textContent + createElement only (XSS-safe).
 */

export default {
  id: "gitea",
  name: "Gitea",
  icon: "git",
  route: "/dashboard/gitea",
  navOrder: 42,
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

    const tabBar = `<div class="gt-tabs">${tabs.map((t) =>
      `<a href="?tab=${escapeHtml(t.id)}" class="gt-tab${tab === t.id ? " active" : ""}">${escapeHtml(t.label)}</a>`
    ).join("")}</div>`;

    let body = "";
    if (tab === "webui") {
      const url = process.env.GITEA_URL || "http://localhost:3040";
      body = `<div class="gt-webui"><iframe src="${escapeHtml(url)}" class="gt-iframe" allow="fullscreen"></iframe></div>`;
    } else {
      body = renderOverview();
    }

    const content = `
      <style>${giteaStyles()}</style>
      <div class="gt-panel">
        <h1>Gitea</h1>
        ${tabBar}
        <div class="gt-body">${body}</div>
      </div>
      <script>${giteaScript()}</script>
    `;

    res.send(layout({ title: "Gitea", content }));
  },
};

function renderOverview() {
  return `
    <div class="gt-overview">
      <div class="gt-section">
        <h3>Status</h3>
        <div id="gt-status" class="gt-status"><div class="np-loading">Checking...</div></div>
      </div>
      <div class="gt-section">
        <h3>Recently Updated Repos</h3>
        <div id="gt-repos" class="gt-repo-list"><div class="np-loading">Loading...</div></div>
      </div>
    </div>
  `;
}

function giteaScript() {
  return `
    async function loadStatus() {
      const el = document.getElementById('gt-status');
      if (!el) return;
      try {
        const res = await fetch('/api/gitea/stats');
        const data = await res.json();
        el.textContent = '';
        if (!data.reachable) {
          const err = document.createElement('div');
          err.className = 'np-error';
          err.textContent = data.error || 'Cannot reach Gitea.';
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
      const el = document.getElementById('gt-repos');
      if (!el) return;
      try {
        const res = await fetch('/api/gitea/repos');
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

function giteaStyles() {
  return `
    .gt-panel h1 { margin: 0 0 1rem; font-size: 1.5rem; }
    .gt-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--crow-border); margin-bottom: 1.5rem; }
    .gt-tab { padding: 0.6rem 1.2rem; color: var(--crow-text-secondary); text-decoration: none;
              border-bottom: 2px solid transparent; transition: all 0.2s; }
    .gt-tab:hover { color: var(--crow-text-primary); }
    .gt-tab.active { color: var(--crow-accent); border-bottom-color: var(--crow-accent); }

    .gt-overview { display: flex; flex-direction: column; gap: 1.5rem; }
    .gt-section h3 { font-size: 0.85rem; color: var(--crow-text-muted); text-transform: uppercase;
                     letter-spacing: 0.05em; margin: 0 0 0.8rem; }

    .gt-status { display: flex; gap: 1rem; flex-wrap: wrap; }
    .stat-card { background: var(--crow-bg-elevated); border-radius: 10px; padding: 1rem 1.2rem;
                 border: 1px solid var(--crow-border); min-width: 150px; }
    .stat-value { font-size: 1.2rem; font-weight: 700; color: var(--crow-accent); }
    .stat-url { font-size: 0.9rem; font-family: monospace; color: var(--crow-text-primary); word-break: break-all; }
    .stat-label { font-size: 0.8rem; color: var(--crow-text-muted); margin-top: 0.25rem; }

    .gt-repo-list { display: flex; flex-direction: column; gap: 0.6rem; }
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

    .gt-webui { width: 100%; height: calc(100vh - 200px); min-height: 500px; }
    .gt-iframe { width: 100%; height: 100%; border: none; border-radius: 12px; background: var(--crow-bg-elevated); }
  `;
}
