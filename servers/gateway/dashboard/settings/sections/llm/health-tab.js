/**
 * Health tab — provider reachability matrix. Runs healthMatrix() on
 * render and presents a table of (id, endpoint, reachable?, latency,
 * discovered models). A Re-probe button re-runs the same check.
 */

import { escapeHtml } from "../../../shared/components.js";
import { healthMatrix } from "../../../../../orchestrator/providers.js";

export default {
  async render({ db, req }) {
    const force = req?.query?.reprobe === "1";
    const result = await healthMatrix({ timeoutMs: 3000, force }).catch((err) => ({
      providers: {}, error: err.message,
    }));
    const byId = result.providers || {};
    const ids = Object.keys(byId).sort();

    const rows = ids.map((id) => {
      const h = byId[id];
      const ok = h?.ok === true;
      const statusCell = ok
        ? `<span style="color:#4caf50">● ${escapeHtml(String(h.latencyMs || "?"))}ms</span>`
        : `<span style="color:#e53935" title="${escapeHtml(h?.error || "unreachable")}">● ${escapeHtml(h?.error ? h.error.slice(0, 60) : "down")}</span>`;
      const models = Array.isArray(h?.models) ? h.models.slice(0, 4).join(", ") : "—";
      return `<tr>
        <td style="padding:8px;font-family:'JetBrains Mono',monospace">${escapeHtml(id)}</td>
        <td style="padding:8px">${statusCell}</td>
        <td style="padding:8px;font-family:'JetBrains Mono',monospace;font-size:0.8rem;color:var(--crow-text-muted)">${escapeHtml(h?.baseUrl || "—")}</td>
        <td style="padding:8px;font-size:0.85rem">${escapeHtml(models)}</td>
      </tr>`;
    }).join("");

    return `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem">
        <div style="font-size:0.85rem;color:var(--crow-text-muted)">
          Live /api/providers/health matrix. Re-probes every provider with a 3s timeout.
        </div>
        <a href="?section=llm&tab=health&reprobe=1" class="btn btn-secondary btn-sm" data-turbo-frame="_top">Re-probe</a>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:0.9rem;border:1px solid var(--crow-border);border-radius:4px;overflow:hidden">
        <thead><tr style="background:var(--crow-bg-deep);color:var(--crow-text-muted);font-weight:500;font-size:0.8rem"><th style="text-align:left;padding:8px">ID</th><th style="text-align:left;padding:8px">Status</th><th style="text-align:left;padding:8px">Endpoint</th><th style="text-align:left;padding:8px">Discovered models</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="4" style="padding:1rem;text-align:center;color:var(--crow-text-muted)">No providers reachable.</td></tr>`}</tbody>
      </table>
      ${result.error ? `<div style="margin-top:0.75rem;font-size:0.8rem;color:#e53935">Matrix error: ${escapeHtml(result.error)}</div>` : ""}
    `;
  },

  async handleAction() { return false; },
};
