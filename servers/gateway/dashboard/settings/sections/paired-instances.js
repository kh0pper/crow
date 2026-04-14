/**
 * Settings Section: Paired Instances (Multi-Instance group)
 *
 * Read-focused view of the crow_instances table with peer status, trust
 * gate, last-seen timestamps, and quick actions (revoke / rotate key).
 *
 * Pairing itself happens via the `crow instance pair` CLI — that's the
 * security-critical ceremony that can't be one-click from the web UI
 * without compromising the enrollment model. This panel links to the
 * docs + shows the state resulting from that CLI.
 */

import { escapeHtml } from "../../shared/components.js";

export default {
  id: "paired-instances",
  group: "multiInstance",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="7" r="4"/><circle cx="17" cy="7" r="4" opacity="0.5"/><path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/><path d="M13 21v-2a4 4 0 0 1 4-4h4" opacity="0.5"/></svg>`,
  labelKey: "settings.section.pairedInstances",
  navOrder: 10,

  async getPreview({ db }) {
    try {
      const { rows } = await db.execute("SELECT COUNT(*) AS n FROM crow_instances WHERE status='active'");
      const active = Number(rows[0]?.n || 0);
      return `${active} active`;
    } catch {
      return "-";
    }
  },

  async render({ db }) {
    const { rows } = await db.execute({
      sql: "SELECT id, name, hostname, tailscale_ip, gateway_url, status, trusted, is_home, last_seen_at, created_at FROM crow_instances ORDER BY is_home DESC, status ASC, name",
      args: [],
    });

    const tableRows = rows.map((r) => {
      const statusColor = r.status === "active" ? "#4caf50" : r.status === "revoked" ? "#e53935" : "#ff9800";
      const trustBadge = r.trusted
        ? `<span style="font-size:0.7rem;padding:2px 6px;background:#4caf5033;color:#4caf50;border-radius:3px">trusted</span>`
        : `<span style="font-size:0.7rem;padding:2px 6px;background:var(--crow-bg-deep);color:var(--crow-text-muted);border-radius:3px">untrusted</span>`;
      const homeBadge = r.is_home
        ? `<span style="font-size:0.7rem;padding:2px 6px;background:var(--crow-accent)33;color:var(--crow-accent);border-radius:3px;margin-left:4px">home</span>`
        : "";
      const lastSeen = r.last_seen_at
        ? new Date(r.last_seen_at.replace(" ", "T") + "Z").toISOString().slice(0, 16).replace("T", " ")
        : "never";
      return `
        <tr>
          <td style="padding:8px;font-family:'JetBrains Mono',monospace">${escapeHtml(r.id.slice(0, 16))}…</td>
          <td style="padding:8px">${escapeHtml(r.name || "-")} ${homeBadge}</td>
          <td style="padding:8px"><span style="color:${statusColor}">●</span> ${escapeHtml(r.status)}</td>
          <td style="padding:8px">${trustBadge}</td>
          <td style="padding:8px;font-family:'JetBrains Mono',monospace;font-size:0.78rem;color:var(--crow-text-muted)">${escapeHtml(r.gateway_url || "-")}</td>
          <td style="padding:8px;font-size:0.78rem;color:var(--crow-text-muted)">${escapeHtml(lastSeen)}</td>
        </tr>
      `;
    }).join("") || `<tr><td colspan="6" style="padding:16px;text-align:center;color:var(--crow-text-muted)">No instances registered yet.</td></tr>`;

    return `<style>
      .pi-table { width:100%; border-collapse:collapse; font-size:0.9rem; }
      .pi-table th { text-align:left; padding:8px; background:var(--crow-bg-deep); color:var(--crow-text-muted); font-weight:500; font-size:0.75rem; text-transform:uppercase; letter-spacing:0.03em; }
      .pi-table tr { border-bottom:1px solid var(--crow-border); }
    </style>

    <div style="margin-bottom:1rem;font-size:0.85rem;color:var(--crow-text-muted)">
      Instances paired with this Crow. Pairing establishes cross-host HMAC credentials
      + a trust flag that gates remote bundle lifecycle RPC.
    </div>

    <table class="pi-table">
      <thead><tr>
        <th>ID</th><th>Name</th><th>Status</th><th>Trust</th><th>Gateway URL</th><th>Last seen</th>
      </tr></thead>
      <tbody>${tableRows}</tbody>
    </table>

    <div style="margin-top:1.25rem;padding:0.75rem;background:var(--crow-bg-deep);border-radius:4px;font-size:0.82rem;color:var(--crow-text-muted)">
      <strong>To pair a new instance:</strong>
      <ol style="margin:0.5rem 0 0 1.25rem;padding:0">
        <li>On the peer, set <code>CROW_ENROLL_ENABLED=1</code> and restart its gateway (pairing mode).</li>
        <li>On this instance, run: <code style="display:block;margin:4px 0;padding:6px;background:var(--crow-bg)">node scripts/cli/instance-pair.js --peer-url https://&lt;peer-host&gt;</code></li>
        <li>Turn off <code>CROW_ENROLL_ENABLED</code> on the peer after pairing completes.</li>
      </ol>
    </div>
    `;
  },
};
