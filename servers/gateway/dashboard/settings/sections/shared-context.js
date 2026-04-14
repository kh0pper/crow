/**
 * Settings Section: Shared Context / crow.md (Multi-Instance group)
 *
 * Read-focused view of the crow_context sections that replicate across
 * instances via SYNCED_TABLES. Shows which sections are scoped to specific
 * instances (device_id set) vs global. Full editing lives in the existing
 * crow_context MCP tools — this panel surfaces the current state so
 * operators can see what the AI is reading.
 */

import { escapeHtml } from "../../shared/components.js";

export default {
  id: "shared-context",
  group: "multiInstance",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/></svg>`,
  labelKey: "settings.section.sharedContext",
  navOrder: 50,

  async getPreview({ db }) {
    try {
      const { rows } = await db.execute("SELECT COUNT(*) AS n FROM crow_context");
      return `${rows[0]?.n || 0} sections`;
    } catch {
      return "-";
    }
  },

  async render({ db }) {
    const { rows } = await db.execute({
      sql: `SELECT section_key, section_title, sort_order, device_id, project_id, content
            FROM crow_context ORDER BY sort_order, section_key`,
      args: [],
    });

    const globalSections = rows.filter((r) => !r.device_id && !r.project_id);
    const scopedSections = rows.filter((r) => r.device_id || r.project_id);

    const fmtSection = (r) => {
      const scope = [];
      if (r.device_id) scope.push(`device=${String(r.device_id).slice(0, 10)}…`);
      if (r.project_id) scope.push(`project=${r.project_id}`);
      const scopeStr = scope.length ? ` <span style="font-size:0.72rem;color:var(--crow-accent)">[${scope.join(" ")}]</span>` : "";
      const contentPreview = (r.content || "").slice(0, 200).replace(/\n/g, " ");
      return `
        <div style="padding:12px;border:1px solid var(--crow-border);border-radius:4px;margin-bottom:8px">
          <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">
            <div style="font-family:'JetBrains Mono',monospace;font-size:0.85rem">${escapeHtml(r.section_key)}${scopeStr}</div>
          </div>
          <div style="font-weight:500;margin-bottom:4px">${escapeHtml(r.section_title || "")}</div>
          <div style="font-size:0.82rem;color:var(--crow-text-muted);line-height:1.4">${escapeHtml(contentPreview)}${(r.content || "").length > 200 ? "…" : ""}</div>
        </div>
      `;
    };

    return `
    <div style="margin-bottom:1rem;font-size:0.85rem;color:var(--crow-text-muted)">
      Behavioral context (crow.md sections) the AI sees at session start. Global sections replicate
      across all paired instances. Device-scoped or project-scoped overrides stay local. Edit via
      the <code>crow_update_context_section</code> MCP tool (the AI does this when you ask it to).
    </div>

    <h3 style="font-size:0.95rem;margin:1.25rem 0 0.5rem;color:var(--crow-text-muted);text-transform:uppercase;letter-spacing:0.05em">Global (${globalSections.length})</h3>
    ${globalSections.map(fmtSection).join("") || '<div style="color:var(--crow-text-muted);font-size:0.85rem">No global sections.</div>'}

    ${scopedSections.length > 0 ? `
      <h3 style="font-size:0.95rem;margin:1.25rem 0 0.5rem;color:var(--crow-text-muted);text-transform:uppercase;letter-spacing:0.05em">Scoped Overrides (${scopedSections.length})</h3>
      ${scopedSections.map(fmtSection).join("")}
    ` : ""}
    `;
  },
};
