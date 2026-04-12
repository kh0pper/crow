/**
 * Crow's Nest Panel — Homepage: iframe to the YAML-configured dashboard.
 * Panel-only bundle (no MCP server, no dashboard routes).
 */

export default {
  id: "homepage",
  name: "Homepage",
  icon: "home",
  route: "/dashboard/homepage",
  navOrder: 66,
  category: "productivity",

  async handler(req, res, { layout }) {
    const url = process.env.HOMEPAGE_URL || "http://localhost:3030";
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

    const content = `
      <style>
        .hp-panel h1 { margin: 0 0 1rem; font-size: 1.5rem; }
        .hp-subtitle { font-size: 0.85rem; color: var(--crow-text-muted); font-weight: 400; margin-left: 0.5rem; }
        .hp-notes { background: var(--crow-bg-elevated); border-radius: 10px; padding: 0.9rem 1rem;
                    border: 1px solid var(--crow-border); margin-bottom: 1rem; font-size: 0.9rem;
                    color: var(--crow-text-secondary); }
        .hp-notes code { background: var(--crow-bg-surface, var(--crow-bg)); padding: 0.1rem 0.4rem;
                         border-radius: 4px; font-size: 0.85em; }
        .hp-frame { width: 100%; height: calc(100vh - 220px); min-height: 500px;
                    border: none; border-radius: 12px; background: var(--crow-bg-elevated); }
      </style>
      <div class="hp-panel">
        <h1>Homepage <span class="hp-subtitle">YAML-configured dashboard</span></h1>
        <div class="hp-notes">
          Edit <code>services.yaml</code>, <code>widgets.yaml</code>, and
          <code>bookmarks.yaml</code> in <code>~/.crow/homepage/</code> (or
          <code>HOMEPAGE_CONFIG_DIR</code>) to add services. Homepage reloads
          on file change.
        </div>
        <iframe src="${esc(url)}" class="hp-frame" allow="clipboard-read; clipboard-write; fullscreen"></iframe>
      </div>
    `;

    res.send(layout({ title: "Homepage", content }));
  },
};
