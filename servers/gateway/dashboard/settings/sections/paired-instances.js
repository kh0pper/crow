/**
 * Settings Section: Paired Instances (Multi-Instance group)
 *
 * Read-focused view of the crow_instances table with peer status, trust
 * gate, last-seen timestamps, and a per-peer Revoke action — the same
 * revokePeer() (servers/sharing/revoke-peer.js) the crow_revoke_instance MCP
 * tool runs: row + token, feed teardown, notification. Key rotation is
 * not a dashboard action; it runs through the instance-sync rotation flow.
 *
 * Pairing itself happens via the `crow instance pair` CLI — that's the
 * security-critical ceremony that can't be one-click from the web UI
 * without compromising the enrollment model. This panel links to the
 * docs + shows the state resulting from that CLI.
 */

import { escapeHtml } from "../../shared/components.js";
import { readSetting, writeSetting } from "../registry.js";
import { t, fill } from "../../shared/i18n.js";
import { getOrCreateLocalInstanceId } from "../../../instance-registry.js";
import { revokePeer } from "../../../../sharing/revoke-peer.js";
import { getPeerDialHealth } from "../../../../shared/peer-dial-health.js";

function localInstanceIdOrNull() {
  try { return getOrCreateLocalInstanceId(); } catch { return null; }
}

/** Rows the operator may revoke from this page: not already revoked, not
 *  the home instance, not this instance's own row. */
export function canRevokeRow(row, localId) {
  return !!row && row.status !== "revoked" && !Number(row.is_home) && row.id !== localId;
}

function fmtMs(ms) {
  return ms == null ? "?" : new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

/**
 * The "Sync link" cell: this gateway's tailnet instance-sync dialer view of
 * the peer — linked / no dial address / last attempt + last error. Text only
 * (every value is escaped); empty for this instance's own row.
 */
export function renderSyncLinkCell(h, lang) {
  if (!h) return escapeHtml(t("settings.pairedNoDialYet", lang));
  const lines = [];
  if (h.linkedAt != null && h.linkClosedAt == null) {
    lines.push(`<span style="color:#4caf50">●</span> ${escapeHtml(fill(t("settings.pairedLinkUp", lang), { direction: h.linkDirection || "?", when: fmtMs(h.linkedAt) }))}`);
  } else if (h.linkClosedAt != null) {
    lines.push(escapeHtml(fill(t("settings.pairedLinkClosed", lang), { when: fmtMs(h.linkClosedAt) })));
  }
  if (h.noAddressSince != null) {
    lines.push(`<span style="color:#e53935">●</span> ${escapeHtml(fill(t("settings.pairedNoAddress", lang), { when: fmtMs(h.noAddressSince), missing: (h.missing || []).join("; ") }))}`);
  }
  if (h.lastAttemptAt != null) {
    lines.push(escapeHtml(fill(t("settings.pairedLastAttempt", lang), { when: fmtMs(h.lastAttemptAt), url: h.lastAttemptUrl || "?" })));
  }
  if (h.lastError && (h.linkedAt == null || h.lastErrorAt >= h.linkedAt)) {
    lines.push(`<span style="color:#ff9800">${escapeHtml(fill(t("settings.pairedLastError", lang), { when: fmtMs(h.lastErrorAt), error: h.lastError }))}</span>`);
  }
  if (h.backfilled) {
    lines.push(escapeHtml(fill(t("settings.pairedLearned", lang), { fields: h.backfilled.fields.join(", ") })));
  }
  return lines.length ? lines.join("<br>") : escapeHtml(t("settings.pairedNoDialYet", lang));
}

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

  async render({ req, db, lang }) {
    const localId = localInstanceIdOrNull();
    const csrf = req?.csrfToken || "";
    const revokeErr = req?.query?.revoke_error;
    const flash = revokeErr
      ? `<div class="alert alert-error">${escapeHtml(t("settings.pairedRevokeRefused", lang))}</div>`
      : (req?.query?.revoked ? `<div class="alert alert-success">${escapeHtml(t("settings.pairedRevokeDone", lang))}</div>` : "");
    const ssoOn = (await readSetting(db, "sso_enabled")) === "true";
    const { rows } = await db.execute({
      sql: "SELECT id, name, hostname, tailscale_ip, gateway_url, status, trusted, is_home, last_seen_at, created_at FROM crow_instances ORDER BY is_home DESC, status ASC, name",
      args: [],
    });

    const dialHealth = getPeerDialHealth();
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
      const revokeCell = canRevokeRow(r, localId)
        ? `<form method="POST" action="/dashboard/settings" style="margin:0"
              onsubmit="return confirm(${escapeHtml(JSON.stringify(fill(t("settings.pairedRevokeConfirm", lang), { name: r.name || r.id.slice(0, 16) })))})">
            <input type="hidden" name="_csrf" value="${escapeHtml(csrf)}" />
            <input type="hidden" name="action" value="revoke_instance" />
            <input type="hidden" name="instance_id" value="${escapeHtml(r.id)}" />
            <button type="submit" class="btn btn-secondary" style="font-size:0.75rem;padding:2px 8px">${escapeHtml(t("settings.pairedRevoke", lang))}</button>
          </form>`
        : (r.id === localId ? `<span style="font-size:0.75rem;color:var(--crow-text-muted)">${escapeHtml(t("settings.pairedThisInstance", lang))}</span>` : "");
      return `
        <tr>
          <td style="padding:8px;font-family:'JetBrains Mono',monospace">${escapeHtml(r.id.slice(0, 16))}…</td>
          <td style="padding:8px">${escapeHtml(r.name || "-")} ${homeBadge}</td>
          <td style="padding:8px"><span style="color:${statusColor}">●</span> ${escapeHtml(r.status)}</td>
          <td style="padding:8px">${trustBadge}</td>
          <td style="padding:8px;font-family:'JetBrains Mono',monospace;font-size:0.78rem;color:var(--crow-text-muted)">${escapeHtml(r.gateway_url || "-")}</td>
          <td style="padding:8px;font-size:0.78rem;color:var(--crow-text-muted)">${escapeHtml(lastSeen)}</td>
          <td style="padding:8px;font-size:0.75rem;color:var(--crow-text-muted);max-width:22rem;overflow-wrap:anywhere">${r.id === localId || r.status === "revoked" ? "" : renderSyncLinkCell(dialHealth[r.id], lang)}</td>
          <td style="padding:8px">${revokeCell}</td>
        </tr>
      `;
    }).join("") || `<tr><td colspan="8" style="padding:16px;text-align:center;color:var(--crow-text-muted)">No instances registered yet.</td></tr>`;

    return `${flash}<style>
      .pi-table { width:100%; border-collapse:collapse; font-size:0.9rem; }
      .pi-table th { text-align:left; padding:8px; background:var(--crow-bg-deep); color:var(--crow-text-muted); font-weight:500; font-size:0.75rem; text-transform:uppercase; letter-spacing:0.03em; }
      .pi-table tr { border-bottom:1px solid var(--crow-border); }
    </style>

    <div style="margin-bottom:1rem;font-size:0.85rem;color:var(--crow-text-muted)">
      Instances paired with this Crow. Pairing establishes cross-host HMAC credentials
      + a trust flag that gates remote bundle lifecycle RPC.
    </div>

    <div class="table-scroll"><table class="pi-table">
      <thead><tr>
        <th>ID</th><th>Name</th><th>Status</th><th>Trust</th><th>Gateway URL</th><th>Last seen</th><th>${escapeHtml(t("settings.pairedSyncLink", lang))}</th><th>${escapeHtml(t("settings.pairedActions", lang))}</th>
      </tr></thead>
      <tbody>${tableRows}</tbody>
    </table></div>

    <form method="POST" action="/dashboard/settings" style="margin-top:1.25rem;padding:0.85rem 1rem;background:var(--crow-bg-deep);border-radius:6px">
      <input type="hidden" name="_csrf" value="${req?.csrfToken || ""}" />
      <input type="hidden" name="action" value="save_sso_enabled" />
      <label style="display:flex;align-items:center;gap:0.6rem;cursor:pointer;font-size:0.92rem">
        <input type="checkbox" name="sso_enabled" value="1" ${ssoOn ? "checked" : ""} style="accent-color:var(--crow-accent)" />
        <span><strong>Cross-instance single sign-on</strong></span>
      </label>
      <p style="margin:0.5rem 0 0.75rem 1.9rem;font-size:0.8rem;color:var(--crow-text-muted)">
        When on, tapping a trusted, paired instance signs you in without re-entering its
        password (2FA is still required if the destination has it). This setting is
        <strong>per-instance</strong> — enable it on each instance you want to reach this way.
        Off by default.
      </p>
      <button type="submit" class="btn btn-primary" style="margin-left:1.9rem">Save</button>
    </form>

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

  async handleAction({ req, res, db, action }) {
    if (action === "revoke_instance") {
      const id = String(req.body.instance_id || "").slice(0, 100);
      const result = await revokePeer(db, id, { localInstanceId: localInstanceIdOrNull() });
      res.redirectAfterPost(result.ok
        ? "/dashboard/settings?section=paired-instances&revoked=1"
        : `/dashboard/settings?section=paired-instances&revoke_error=${encodeURIComponent(result.reason)}`);
      return true;
    }
    if (action !== "save_sso_enabled") return false;
    const val = req.body.sso_enabled ? "true" : "false";
    // Local scope only — never synced. B accepting SSO from A is B's decision;
    // a synced toggle would let a peer flip this instance's acceptance policy.
    await writeSetting(db, "sso_enabled", val, { scope: "local" });
    res.redirectAfterPost("/dashboard/settings?section=paired-instances");
    return true;
  },
};
