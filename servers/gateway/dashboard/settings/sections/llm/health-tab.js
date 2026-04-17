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

    let okCount = 0, downCount = 0;
    const rows = ids.map((id) => {
      const h = byId[id];
      const ok = h?.ok === true;
      if (ok) okCount++; else downCount++;
      const statusCell = ok
        ? `<span class="llm-health-ok">● <span style="color:var(--crow-text-secondary)">${escapeHtml(String(h.latencyMs || "?"))}ms</span></span>`
        : `<span class="llm-health-down" title="${escapeHtml(h?.error || "unreachable")}">● <span style="color:var(--crow-text-muted)">${escapeHtml(h?.error ? h.error.slice(0, 56) : "down")}</span></span>`;
      const models = Array.isArray(h?.models) ? h.models.slice(0, 4).join(", ") : "—";
      return `<tr>
        <td class="llm-cell-id">${escapeHtml(id)}</td>
        <td>${statusCell}</td>
        <td class="llm-cell-endpoint">${escapeHtml(h?.baseUrl || "—")}</td>
        <td class="llm-cell-models" title="${escapeHtml(models)}">${escapeHtml(models)}</td>
      </tr>`;
    }).join("");

    return `<style>
      .llm-health-summary {
        display:flex; gap:0.6rem; margin-bottom:0.85rem; flex-wrap:wrap;
      }
      .llm-health-chip {
        display:inline-flex; align-items:center; gap:0.4rem;
        padding:0.35rem 0.75rem;
        border:1px solid var(--crow-border);
        border-radius:var(--crow-radius-pill);
        background:var(--crow-bg-surface);
        font-size:0.8rem;
        color:var(--crow-text-secondary);
      }
      .llm-health-chip strong { color:var(--crow-text-primary); font-weight:600; }
      .llm-health-ok { color:var(--crow-success); font-weight:500; }
      .llm-health-down { color:var(--crow-error); font-weight:500; }
    </style>

    <div class="llm-toolbar">
      <div class="llm-health-summary">
        <span class="llm-health-chip"><strong>${ids.length}</strong> total</span>
        <span class="llm-health-chip"><span class="llm-health-ok">●</span> <strong>${okCount}</strong> reachable</span>
        <span class="llm-health-chip"><span class="llm-health-down">●</span> <strong>${downCount}</strong> down</span>
      </div>
      <a href="?section=llm&tab=health&reprobe=1" class="btn btn-secondary btn-sm" data-turbo-frame="_top">Re-probe</a>
    </div>

    <div class="llm-card">
      <table class="llm-providers-table">
        <thead><tr><th>ID</th><th>Status</th><th>Endpoint</th><th>Discovered models</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="4" style="padding:1.25rem;text-align:center;color:var(--crow-text-muted)">No providers reachable.</td></tr>`}</tbody>
      </table>
    </div>

    ${result.error ? `<div style="margin-top:0.75rem;font-size:0.82rem;color:var(--crow-error)">Matrix error: ${escapeHtml(result.error)}</div>` : ""}`;
  },

  async handleAction() { return false; },
};
