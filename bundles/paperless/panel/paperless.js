/**
 * Crow's Nest Panel — Paperless-ngx: document overview, stats, web UI embed
 *
 * Bundle-compatible version: uses dynamic imports with appRoot instead of
 * static ESM imports, so this panel works both from the repo and when
 * installed to ~/.crow/panels/.
 *
 * Note: Client-side JS uses textContent-based escapeH() for safe HTML rendering,
 * matching the pattern used by other Crow panels (jellyfin, kodi, iptv).
 */

export default {
  id: "paperless",
  name: "Paperless-ngx",
  icon: "document",
  route: "/dashboard/paperless",
  navOrder: 34,
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

    const tabBar = `<div class="pl-tabs">${tabs.map((t) =>
      `<a href="?tab=${escapeHtml(t.id)}" class="pl-tab${tab === t.id ? " active" : ""}">${escapeHtml(t.label)}</a>`
    ).join("")}</div>`;

    let body = "";

    if (tab === "webui") {
      const paperlessUrl = process.env.PAPERLESS_URL || "http://localhost:8000";
      body = `
        <div class="pl-webui">
          <iframe src="${escapeHtml(paperlessUrl)}" class="pl-iframe" allow="fullscreen"></iframe>
        </div>
      `;
    } else {
      body = renderOverview();
    }

    const content = `
      <style>${paperlessStyles()}</style>
      <div class="pl-panel">
        <h1>Paperless-ngx</h1>
        ${tabBar}
        <div class="pl-body">${body}</div>
      </div>
      <script>${paperlessScript()}</script>
    `;

    res.send(layout({ title: "Paperless-ngx", content }));
  },
};

function renderOverview() {
  return `
    <div class="pl-overview">
      <div class="pl-section">
        <h3>Statistics</h3>
        <div id="pl-stats" class="pl-stats">
          <div class="np-loading">Loading stats...</div>
        </div>
      </div>

      <div class="pl-section">
        <h3>Tags</h3>
        <div id="pl-tags" class="pl-tags">
          <div class="np-loading">Loading tags...</div>
        </div>
      </div>

      <div class="pl-section">
        <h3>Recent Documents</h3>
        <div id="pl-recent" class="pl-recent-grid">
          <div class="np-loading">Loading...</div>
        </div>
      </div>
    </div>
  `;
}

function paperlessScript() {
  return `
    function escapeH(s) {
      if (!s) return '';
      const d = document.createElement('div');
      d.textContent = String(s);
      return d.innerHTML;
    }

    async function loadStats() {
      const el = document.getElementById('pl-stats');
      if (!el) return;
      try {
        const res = await fetch('/api/paperless/stats');
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
          { label: 'Documents', value: data.documents_total || 0 },
          { label: 'Tags', value: data.tags_total || 0 },
          { label: 'Correspondents', value: data.correspondents_total || 0 },
          { label: 'Document Types', value: data.document_types_total || 0 },
          { label: 'In Inbox', value: data.documents_inbox || 0 },
        ];
        stats.forEach(function(s) {
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
        });
      } catch (e) {
        el.textContent = '';
        const errDiv = document.createElement('div');
        errDiv.className = 'np-error';
        errDiv.textContent = 'Cannot reach Paperless-ngx.';
        el.appendChild(errDiv);
      }
    }

    async function loadTags() {
      const el = document.getElementById('pl-tags');
      if (!el) return;
      try {
        const res = await fetch('/api/paperless/tags');
        const data = await res.json();
        if (data.error) {
          el.textContent = '';
          const errDiv = document.createElement('div');
          errDiv.className = 'np-error';
          errDiv.textContent = data.error;
          el.appendChild(errDiv);
          return;
        }

        const tags = data.tags || [];
        el.textContent = '';

        if (tags.length === 0) {
          const idle = document.createElement('div');
          idle.className = 'np-idle';
          idle.textContent = 'No tags found';
          el.appendChild(idle);
          return;
        }

        tags.forEach(function(tag) {
          const chip = document.createElement('span');
          chip.className = 'tag-chip';
          if (tag.color) chip.style.borderColor = tag.color;
          chip.textContent = tag.name + ' (' + tag.document_count + ')';
          el.appendChild(chip);
        });
      } catch (e) {
        el.textContent = '';
        const errDiv = document.createElement('div');
        errDiv.className = 'np-error';
        errDiv.textContent = 'Cannot reach Paperless-ngx.';
        el.appendChild(errDiv);
      }
    }

    async function loadRecent() {
      const el = document.getElementById('pl-recent');
      if (!el) return;
      try {
        const res = await fetch('/api/paperless/recent');
        const data = await res.json();
        if (data.error) {
          el.textContent = '';
          const errDiv = document.createElement('div');
          errDiv.className = 'np-error';
          errDiv.textContent = data.error;
          el.appendChild(errDiv);
          return;
        }

        const docs = data.documents || [];
        el.textContent = '';

        if (docs.length === 0) {
          const idle = document.createElement('div');
          idle.className = 'np-idle';
          idle.textContent = 'No documents found';
          el.appendChild(idle);
          return;
        }

        docs.forEach(function(doc) {
          const card = document.createElement('div');
          card.className = 'lib-card';

          const titleEl = document.createElement('div');
          titleEl.className = 'lib-title';
          titleEl.textContent = doc.title;
          card.appendChild(titleEl);

          const meta = document.createElement('div');
          meta.className = 'lib-meta';
          const parts = [];
          if (doc.correspondent) parts.push(doc.correspondent);
          if (doc.created) parts.push(doc.created.split('T')[0]);
          meta.textContent = parts.join(' · ');
          card.appendChild(meta);

          if (doc.tags && doc.tags.length > 0) {
            const tagsEl = document.createElement('div');
            tagsEl.className = 'lib-meta';
            tagsEl.textContent = doc.tags.join(', ');
            card.appendChild(tagsEl);
          }

          el.appendChild(card);
        });
      } catch (e) {
        el.textContent = '';
        const errDiv = document.createElement('div');
        errDiv.className = 'np-error';
        errDiv.textContent = 'Failed to load recent documents.';
        el.appendChild(errDiv);
      }
    }

    // Init
    loadStats();
    loadTags();
    loadRecent();
  `;
}

function paperlessStyles() {
  return `
    .pl-panel h1 { margin: 0 0 1rem; font-size: 1.5rem; }
    .pl-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--crow-border); margin-bottom: 1.5rem; }
    .pl-tab { padding: 0.6rem 1.2rem; color: var(--crow-text-secondary); text-decoration: none;
              border-bottom: 2px solid transparent; transition: all 0.2s; }
    .pl-tab:hover { color: var(--crow-text-primary); }
    .pl-tab.active { color: var(--crow-accent); border-bottom-color: var(--crow-accent); }

    .pl-overview { display: flex; flex-direction: column; gap: 1.5rem; }
    .pl-section h3 { font-size: 0.85rem; color: var(--crow-text-muted); text-transform: uppercase;
                     letter-spacing: 0.05em; margin: 0 0 0.8rem; }

    /* Stats */
    .pl-stats { display: flex; gap: 1rem; flex-wrap: wrap; }
    .stat-card { background: var(--crow-bg-elevated); border-radius: 10px; padding: 1rem 1.2rem;
                 border: 1px solid var(--crow-border); min-width: 100px; text-align: center; }
    .stat-value { font-size: 1.6rem; font-weight: 700; color: var(--crow-accent); }
    .stat-label { font-size: 0.8rem; color: var(--crow-text-muted); margin-top: 0.2rem; }

    /* Tags */
    .pl-tags { display: flex; gap: 0.5rem; flex-wrap: wrap; }
    .tag-chip { display: inline-block; background: var(--crow-bg-elevated); border: 1px solid var(--crow-border);
                border-radius: 16px; padding: 0.3rem 0.8rem; font-size: 0.8rem; color: var(--crow-text-secondary);
                border-left-width: 3px; }

    /* Recent grid */
    .pl-recent-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 1rem; }
    .lib-card { background: var(--crow-bg-elevated); border-radius: 10px; padding: 1rem;
                border: 1px solid var(--crow-border); transition: border-color 0.2s; }
    .lib-card:hover { border-color: var(--crow-accent); }
    .lib-title { font-weight: 600; color: var(--crow-text-primary); margin-bottom: 0.3rem; font-size: 0.95rem; }
    .lib-meta { font-size: 0.8rem; color: var(--crow-text-muted); }

    .np-idle, .np-loading { color: var(--crow-text-muted); font-size: 0.9rem; padding: 1rem;
                            background: var(--crow-bg-elevated); border-radius: 12px; text-align: center; }
    .np-error { color: var(--crow-error); font-size: 0.9rem; padding: 1rem;
                background: var(--crow-bg-elevated); border-radius: 12px; text-align: center; }

    /* Web UI iframe */
    .pl-webui { width: 100%; height: calc(100vh - 200px); min-height: 500px; }
    .pl-iframe { width: 100%; height: 100%; border: none; border-radius: 12px;
                 background: var(--crow-bg-elevated); }

    @media (max-width: 600px) {
      .pl-stats { flex-direction: column; }
      .pl-recent-grid { grid-template-columns: 1fr; }
    }
  `;
}
