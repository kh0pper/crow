/**
 * Settings Section: Sync Profiles (Multi-Instance group)
 *
 * Per-peer `sync_profile` picker (what tables replicate). Lets the operator
 * say "this peer gets memories only, not blog posts" etc. Also surfaces
 * the global CROW_SYNC_PROVIDERS env toggle as a reminder.
 */

import { escapeHtml } from "../../shared/components.js";

const PROFILE_CHOICES = [
  { id: "full",        label: "Full (all synced tables)" },
  { id: "memory-only", label: "Memory only" },
  { id: "blog-only",   label: "Blog only" },
  { id: "custom",      label: "Custom (set via DB)" },
];

export default {
  id: "sync-profiles",
  group: "multiInstance",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-15-6.7L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 15 6.7l3-2.7"/><path d="M16 16h5v5"/></svg>`,
  labelKey: "settings.section.syncProfiles",
  navOrder: 30,

  async getPreview({ db }) {
    try {
      const { rows } = await db.execute("SELECT sync_profile, COUNT(*) AS n FROM crow_instances WHERE status='active' GROUP BY sync_profile");
      return rows.map((r) => `${r.n} ${r.sync_profile}`).join(", ") || "none";
    } catch {
      return "-";
    }
  },

  async render({ db }) {
    const { rows } = await db.execute({
      sql: "SELECT id, name, status, trusted, sync_profile FROM crow_instances WHERE status != 'revoked' ORDER BY name",
      args: [],
    });

    const tableRows = rows.map((r) => {
      const options = PROFILE_CHOICES.map(
        (c) => `<option value="${c.id}"${(r.sync_profile || "full") === c.id ? " selected" : ""}>${escapeHtml(c.label)}</option>`
      ).join("");
      return `
        <tr data-id="${escapeHtml(r.id)}">
          <td style="padding:8px;font-family:'JetBrains Mono',monospace;font-size:0.85rem">${escapeHtml(r.name || r.id.slice(0, 16))}</td>
          <td style="padding:8px">
            <select class="sp-select" data-peer-id="${escapeHtml(r.id)}" style="padding:4px;background:var(--crow-bg-deep);border:1px solid var(--crow-border);border-radius:3px;color:var(--crow-text)">
              ${options}
            </select>
          </td>
          <td style="padding:8px;font-size:0.78rem;color:var(--crow-text-muted)">
            ${r.trusted ? "trusted" : "not trusted"} · ${r.status}
          </td>
        </tr>
      `;
    }).join("") || `<tr><td colspan="3" style="padding:16px;text-align:center;color:var(--crow-text-muted)">No peers configured.</td></tr>`;

    const providersSync = process.env.CROW_SYNC_PROVIDERS === "1" ? "enabled" : "default (on via SYNCED_TABLES)";

    return `<style>
      .sp-table { width:100%; border-collapse:collapse; font-size:0.9rem; }
      .sp-table th { text-align:left; padding:8px; background:var(--crow-bg-deep); color:var(--crow-text-muted); font-weight:500; font-size:0.75rem; text-transform:uppercase; }
      .sp-table tr { border-bottom:1px solid var(--crow-border); }
      .sp-status { font-size:0.85rem; margin-top:0.75rem; }
    </style>

    <div style="margin-bottom:1rem;font-size:0.85rem;color:var(--crow-text-muted)">
      Which tables replicate to each paired instance. <strong>Full</strong> syncs memories,
      crow_context, contacts, shared_items, messages, relay_config, crow_instances, and providers.
      Narrower profiles limit what flows to that peer.
    </div>

    <table class="sp-table">
      <thead><tr><th>Peer</th><th>Sync profile</th><th>State</th></tr></thead>
      <tbody>${tableRows}</tbody>
    </table>

    <div class="sp-status" id="sp-status"></div>

    <div style="margin-top:1.25rem;padding:0.75rem;background:var(--crow-bg-deep);border-radius:4px;font-size:0.82rem">
      <strong>Providers table sync:</strong> ${escapeHtml(providersSync)} — provider-registry edits
      on any instance propagate to peers automatically (push via emitChange, pull via periodic scan).
    </div>

    <script>
    (function() {
      async function apiCall(action, payload) {
        const form = new FormData();
        form.append('action', action);
        if (payload) form.append('payload', JSON.stringify(payload));
        const res = await fetch(window.location.pathname + window.location.search, {
          method: 'POST', body: form, credentials: 'same-origin',
        });
        return res.ok;
      }
      document.querySelectorAll('.sp-select').forEach(function(sel) {
        sel.addEventListener('change', async function() {
          const id = sel.getAttribute('data-peer-id');
          const value = sel.value;
          const ok = await apiCall('set_sync_profile', { id, sync_profile: value });
          const status = document.getElementById('sp-status');
          status.textContent = ok ? ('✓ Updated ' + id + ' → ' + value) : ('✗ Update failed');
        });
      });
    })();
    </script>
    `;
  },

  async handleAction({ req, res, db, action }) {
    if (action === "set_sync_profile") {
      const payload = JSON.parse(req.body?.payload || "{}");
      const ALLOWED = ["full", "memory-only", "blog-only", "custom"];
      if (!payload.id || !ALLOWED.includes(payload.sync_profile)) {
        res.status(400).type("html").send("bad request");
        return true;
      }
      await db.execute({
        sql: "UPDATE crow_instances SET sync_profile = ?, updated_at = datetime('now') WHERE id = ?",
        args: [payload.sync_profile, payload.id],
      });
      res.status(200).type("text/plain").send("ok");
      return true;
    }
    return false;
  },
};
