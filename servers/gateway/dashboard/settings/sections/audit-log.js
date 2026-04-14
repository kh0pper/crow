/**
 * Settings Section: Cross-Host Audit (Multi-Instance group)
 *
 * Read-only view over `cross_host_calls` — every inbound/outbound signed
 * bundle RPC, enrollment attempt, or HMAC-rejected request is logged here.
 * This is the "did my peer try to do something weird?" panel.
 */

import { escapeHtml } from "../../shared/components.js";

export default {
  id: "audit-log",
  group: "multiInstance",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v5a2 2 0 0 0 2 2h5"/><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9z"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="12" y2="17"/></svg>`,
  labelKey: "settings.section.auditLog",
  navOrder: 40,

  async getPreview({ db }) {
    try {
      const { rows } = await db.execute("SELECT COUNT(*) AS n FROM cross_host_calls WHERE at >= datetime('now', '-24 hours')");
      return `${rows[0]?.n || 0} in 24h`;
    } catch {
      return "-";
    }
  },

  async render({ db }) {
    const filter = "WHERE 1=1";
    const { rows } = await db.execute({
      sql: `SELECT * FROM cross_host_calls ${filter} ORDER BY id DESC LIMIT 100`,
      args: [],
    });

    const tableRows = rows.map((r) => {
      const dirColor = r.direction === "inbound" ? "#4caf50" : "var(--crow-accent)";
      const hmacDisplay = r.hmac_valid === 1 ? "✓" : r.hmac_valid === 0 ? "✗" : "-";
      const hmacColor = r.hmac_valid === 1 ? "#4caf50" : r.hmac_valid === 0 ? "#e53935" : "var(--crow-text-muted)";
      const status = r.http_status || "-";
      const statusColor = r.http_status && r.http_status < 400 ? "#4caf50" : r.http_status ? "#e53935" : "var(--crow-text-muted)";
      return `
        <tr>
          <td style="padding:6px 8px;font-family:'JetBrains Mono',monospace;font-size:0.78rem;color:var(--crow-text-muted);white-space:nowrap">${escapeHtml(r.at)}</td>
          <td style="padding:6px 8px;font-size:0.8rem"><span style="color:${dirColor}">${escapeHtml(r.direction)}</span></td>
          <td style="padding:6px 8px;font-family:'JetBrains Mono',monospace;font-size:0.8rem">${escapeHtml(r.action || "-")}</td>
          <td style="padding:6px 8px;font-size:0.78rem">${escapeHtml((r.source_instance_id || "-").slice(0, 12))}…</td>
          <td style="padding:6px 8px;font-size:0.78rem">${escapeHtml((r.target_instance_id || "-").slice(0, 12))}…</td>
          <td style="padding:6px 8px;text-align:center"><span style="color:${hmacColor}">${hmacDisplay}</span></td>
          <td style="padding:6px 8px;text-align:center;color:${statusColor}">${escapeHtml(String(status))}</td>
          <td style="padding:6px 8px;font-size:0.78rem;color:var(--crow-text-muted)">${escapeHtml(r.error || r.bundle_id || "-")}</td>
        </tr>
      `;
    }).join("") || `<tr><td colspan="8" style="padding:16px;text-align:center;color:var(--crow-text-muted)">No cross-host calls recorded yet.</td></tr>`;

    return `<style>
      .al-table { width:100%; border-collapse:collapse; font-size:0.85rem; }
      .al-table th { text-align:left; padding:6px 8px; background:var(--crow-bg-deep); color:var(--crow-text-muted); font-weight:500; font-size:0.72rem; text-transform:uppercase; letter-spacing:0.03em; }
      .al-table tr { border-bottom:1px solid var(--crow-border); }
    </style>

    <div style="margin-bottom:1rem;font-size:0.85rem;color:var(--crow-text-muted)">
      Last ${rows.length} cross-host RPC events. HMAC column: ✓ validated, ✗ rejected, - n/a.
    </div>

    <div style="overflow-x:auto">
      <table class="al-table">
        <thead><tr>
          <th>When</th><th>Dir</th><th>Action</th><th>Source</th><th>Target</th><th style="text-align:center">HMAC</th><th style="text-align:center">HTTP</th><th>Detail</th>
        </tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>
    `;
  },
};
