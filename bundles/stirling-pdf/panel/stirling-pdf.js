/**
 * Crow's Nest Panel — Stirling PDF: iframe to the web UI + reachability.
 *
 * Stirling PDF has no automation API, so this panel is effectively a launcher:
 * it shows status and embeds the web UI.
 */

export default {
  id: "stirling-pdf",
  name: "Stirling PDF",
  icon: "file-text",
  route: "/dashboard/stirling-pdf",
  navOrder: 64,
  category: "productivity",

  async handler(req, res, { layout }) {
    const url = process.env.STIRLING_URL || "http://localhost:8092";
    // Escape the URL for safe insertion into HTML attributes.
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

    const content = `
      <style>
        .sp-panel h1 { margin: 0 0 1rem; font-size: 1.5rem; }
        .sp-subtitle { font-size: 0.85rem; color: var(--crow-text-muted); font-weight: 400; margin-left: 0.5rem; }
        .sp-notes { background: var(--crow-bg-elevated); border-radius: 10px; padding: 0.9rem 1rem;
                    border: 1px solid var(--crow-border); margin-bottom: 1rem; font-size: 0.9rem;
                    color: var(--crow-text-secondary); }
        .sp-notes code { background: var(--crow-bg-surface, var(--crow-bg)); padding: 0.1rem 0.4rem;
                         border-radius: 4px; font-size: 0.85em; }
        .sp-frame { width: 100%; height: calc(100vh - 220px); min-height: 500px;
                    border: none; border-radius: 12px; background: var(--crow-bg-elevated); }
      </style>
      <div class="sp-panel">
        <h1>Stirling PDF <span class="sp-subtitle">merge &middot; split &middot; OCR &middot; convert</span></h1>
        <div class="sp-notes">
          Stirling PDF runs every operation in your browser. There is no
          automation API; use the embedded UI below or open
          <code>${esc(url)}</code> directly.
        </div>
        <iframe src="${esc(url)}" class="sp-frame" allow="clipboard-read; clipboard-write; fullscreen"></iframe>
      </div>
    `;

    res.send(layout({ title: "Stirling PDF", content }));
  },
};
