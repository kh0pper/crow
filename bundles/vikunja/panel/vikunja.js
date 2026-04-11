/**
 * Crow's Nest Panel — Vikunja: task overview, project stats, web UI embed
 *
 * Bundle-compatible version: uses dynamic imports with appRoot instead of
 * static ESM imports, so this panel works both from the repo and when
 * installed to ~/.crow/panels/.
 *
 * Note: Client-side JS uses textContent-based escapeH() for safe HTML rendering,
 * matching the pattern used by other Crow panels (jellyfin, kodi, iptv).
 */

export default {
  id: "vikunja",
  name: "Vikunja",
  icon: "check-square",
  route: "/dashboard/vikunja",
  navOrder: 39,
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

    const tabBar = `<div class="vk-tabs">${tabs.map((t) =>
      `<a href="?tab=${escapeHtml(t.id)}" class="vk-tab${tab === t.id ? " active" : ""}">${escapeHtml(t.label)}</a>`
    ).join("")}</div>`;

    let body = "";

    if (tab === "webui") {
      const vikunjaUrl = process.env.VIKUNJA_URL || "http://localhost:3456";
      body = `
        <div class="vk-webui">
          <iframe src="${escapeHtml(vikunjaUrl)}" class="vk-iframe" allow="fullscreen"></iframe>
        </div>
      `;
    } else {
      body = renderOverview();
    }

    const content = `
      <style>${vikunjaStyles()}</style>
      <div class="vk-panel">
        <h1>Vikunja</h1>
        ${tabBar}
        <div class="vk-body">${body}</div>
      </div>
      <script>${vikunjaScript()}</script>
    `;

    res.send(layout({ title: "Vikunja", content }));
  },
};

function renderOverview() {
  return `
    <div class="vk-overview">
      <div class="vk-section">
        <h3>Task Stats</h3>
        <div id="vk-stats" class="vk-stats">
          <div class="np-loading">Loading stats...</div>
        </div>
      </div>

      <div class="vk-section">
        <h3>Overdue Tasks</h3>
        <div id="vk-overdue" class="vk-task-list">
          <div class="np-loading">Loading...</div>
        </div>
      </div>

      <div class="vk-section">
        <h3>Recent Tasks</h3>
        <div id="vk-recent" class="vk-task-list">
          <div class="np-loading">Loading...</div>
        </div>
      </div>
    </div>
  `;
}

function vikunjaScript() {
  return `
    // Safe HTML escaper using textContent
    function escapeH(s) {
      if (!s) return '';
      const d = document.createElement('div');
      d.textContent = String(s);
      return d.innerHTML;
    }

    async function loadStats() {
      const el = document.getElementById('vk-stats');
      if (!el) return;
      try {
        const res = await fetch('/api/vikunja/stats');
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
          { label: 'Projects', value: data.projects || 0 },
          { label: 'Open Tasks', value: data.open || 0 },
          { label: 'Done', value: data.done || 0 },
          { label: 'Overdue', value: data.overdue || 0 },
        ];
        stats.forEach(function(s) {
          const card = document.createElement('div');
          card.className = 'stat-card';
          if (s.label === 'Overdue' && s.value > 0) card.classList.add('stat-warn');
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
        errDiv.textContent = 'Cannot reach Vikunja.';
        el.appendChild(errDiv);
      }
    }

    function renderTaskList(el, tasks, emptyMessage) {
      el.textContent = '';
      if (tasks.length === 0) {
        const idle = document.createElement('div');
        idle.className = 'np-idle';
        idle.textContent = emptyMessage;
        el.appendChild(idle);
        return;
      }

      tasks.forEach(function(task) {
        const card = document.createElement('div');
        card.className = 'lib-card';

        const header = document.createElement('div');
        header.style.display = 'flex';
        header.style.alignItems = 'center';
        header.style.gap = '0.5rem';

        const checkbox = document.createElement('span');
        checkbox.className = 'task-check';
        checkbox.textContent = task.done ? '\\u2611' : '\\u2610';
        header.appendChild(checkbox);

        const titleEl = document.createElement('div');
        titleEl.className = 'lib-title';
        if (task.done) titleEl.style.textDecoration = 'line-through';
        titleEl.textContent = task.title;
        header.appendChild(titleEl);

        card.appendChild(header);

        const meta = document.createElement('div');
        meta.className = 'lib-meta';
        const parts = [];
        if (task.project) parts.push(task.project);
        if (task.priority && task.priority !== 'unset') parts.push('P: ' + task.priority);
        if (task.due_date) parts.push('Due: ' + task.due_date);
        meta.textContent = parts.join(' \\u00b7 ');
        card.appendChild(meta);

        if (task.labels && task.labels.length > 0) {
          const labelsEl = document.createElement('div');
          labelsEl.className = 'task-labels';
          task.labels.forEach(function(label) {
            const tag = document.createElement('span');
            tag.className = 'task-label';
            tag.textContent = label;
            labelsEl.appendChild(tag);
          });
          card.appendChild(labelsEl);
        }

        el.appendChild(card);
      });
    }

    async function loadOverdue() {
      const el = document.getElementById('vk-overdue');
      if (!el) return;
      try {
        const res = await fetch('/api/vikunja/overdue');
        const data = await res.json();
        if (data.error) {
          el.textContent = '';
          const errDiv = document.createElement('div');
          errDiv.className = 'np-error';
          errDiv.textContent = data.error;
          el.appendChild(errDiv);
          return;
        }
        renderTaskList(el, data.tasks || [], 'No overdue tasks');
      } catch (e) {
        el.textContent = '';
        const errDiv = document.createElement('div');
        errDiv.className = 'np-error';
        errDiv.textContent = 'Failed to load overdue tasks.';
        el.appendChild(errDiv);
      }
    }

    async function loadRecent() {
      const el = document.getElementById('vk-recent');
      if (!el) return;
      try {
        const res = await fetch('/api/vikunja/recent');
        const data = await res.json();
        if (data.error) {
          el.textContent = '';
          const errDiv = document.createElement('div');
          errDiv.className = 'np-error';
          errDiv.textContent = data.error;
          el.appendChild(errDiv);
          return;
        }
        renderTaskList(el, data.tasks || [], 'No recent tasks');
      } catch (e) {
        el.textContent = '';
        const errDiv = document.createElement('div');
        errDiv.className = 'np-error';
        errDiv.textContent = 'Failed to load recent tasks.';
        el.appendChild(errDiv);
      }
    }

    // Init
    loadStats();
    loadOverdue();
    loadRecent();
  `;
}

function vikunjaStyles() {
  return `
    .vk-panel h1 { margin: 0 0 1rem; font-size: 1.5rem; }
    .vk-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--crow-border); margin-bottom: 1.5rem; }
    .vk-tab { padding: 0.6rem 1.2rem; color: var(--crow-text-secondary); text-decoration: none;
              border-bottom: 2px solid transparent; transition: all 0.2s; }
    .vk-tab:hover { color: var(--crow-text-primary); }
    .vk-tab.active { color: var(--crow-accent); border-bottom-color: var(--crow-accent); }

    .vk-overview { display: flex; flex-direction: column; gap: 1.5rem; }
    .vk-section h3 { font-size: 0.85rem; color: var(--crow-text-muted); text-transform: uppercase;
                     letter-spacing: 0.05em; margin: 0 0 0.8rem; }

    /* Stats */
    .vk-stats { display: flex; gap: 1rem; flex-wrap: wrap; }
    .stat-card { background: var(--crow-bg-elevated); border-radius: 10px; padding: 1rem 1.2rem;
                 border: 1px solid var(--crow-border); min-width: 100px; text-align: center; }
    .stat-card.stat-warn { border-color: var(--crow-error); }
    .stat-card.stat-warn .stat-value { color: var(--crow-error); }
    .stat-value { font-size: 1.6rem; font-weight: 700; color: var(--crow-accent); }
    .stat-label { font-size: 0.8rem; color: var(--crow-text-muted); margin-top: 0.2rem; }

    /* Task list */
    .vk-task-list { display: flex; flex-direction: column; gap: 0.6rem; }
    .lib-card { background: var(--crow-bg-elevated); border-radius: 10px; padding: 1rem;
                border: 1px solid var(--crow-border); transition: border-color 0.2s; }
    .lib-card:hover { border-color: var(--crow-accent); }
    .lib-title { font-weight: 600; color: var(--crow-text-primary); font-size: 0.95rem; }
    .lib-meta { font-size: 0.8rem; color: var(--crow-text-muted); margin-top: 0.3rem; }
    .task-check { font-size: 1.1rem; color: var(--crow-text-muted); }
    .task-labels { display: flex; gap: 0.3rem; flex-wrap: wrap; margin-top: 0.4rem; }
    .task-label { font-size: 0.7rem; background: var(--crow-bg-surface, var(--crow-bg)); border-radius: 4px;
                  padding: 0.15rem 0.5rem; color: var(--crow-text-secondary); border: 1px solid var(--crow-border); }

    .np-idle, .np-loading { color: var(--crow-text-muted); font-size: 0.9rem; padding: 1rem;
                            background: var(--crow-bg-elevated); border-radius: 12px; text-align: center; }
    .np-error { color: var(--crow-error); font-size: 0.9rem; padding: 1rem;
                background: var(--crow-bg-elevated); border-radius: 12px; text-align: center; }

    /* Web UI iframe */
    .vk-webui { width: 100%; height: calc(100vh - 200px); min-height: 500px; }
    .vk-iframe { width: 100%; height: 100%; border: none; border-radius: 12px;
                 background: var(--crow-bg-elevated); }

    @media (max-width: 600px) {
      .vk-stats { flex-direction: column; }
    }
  `;
}
