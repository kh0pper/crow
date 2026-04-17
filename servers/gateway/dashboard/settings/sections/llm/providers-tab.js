/**
 * Providers tab — unified list of local-bundle + cloud providers.
 * - Rows pulled from `listProvidersAll(db)` (same function the legacy
 *   providers section uses).
 * - "Add cloud provider" form: POSTs with provider_type set on the new row.
 * - "Sync bundle providers" button: re-runs syncProvidersFromModelsJson
 *   with force=true to re-enable any rows disabled by a prior uninstall.
 * - Disable / enable / test buttons reuse the existing legacy actions.
 *
 * Every POST redirects back to ?section=llm&tab=providers so Turbo Drive
 * keeps the user on this tab.
 */

import { escapeHtml } from "../../../shared/components.js";
import {
  listProvidersAll,
  upsertProvider,
  disableProvider,
  syncProvidersFromModelsJson,
} from "../../../../../orchestrator/providers-db.js";
import { invalidateProvidersCache } from "../../../../../orchestrator/providers.js";
import { KNOWN_PROVIDER_TYPES } from "../../../../../orchestrator/provider-type.js";

const BACK = "?section=llm&tab=providers";

function hostBadge(p) {
  const base = `font-size:0.72rem;padding:2px 8px;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:var(--crow-radius-pill);white-space:nowrap`;
  if (p.host === "cloud") return `<span style="${base};color:var(--crow-accent)">cloud${p.provider_type ? ` · ${escapeHtml(p.provider_type)}` : ""}</span>`;
  if (p.host === "local") return `<span style="${base};color:var(--crow-text-secondary)">local</span>`;
  return `<span style="${base};color:var(--crow-text-secondary)">${escapeHtml((p.host || "").slice(0, 18))}</span>`;
}

export default {
  async render({ db }) {
    const providers = await listProvidersAll(db);
    const rows = providers.map((p) => {
      const models = (p.models || []).map((m) => escapeHtml(m.id || "?")).join(", ") || "—";
      const dotColor = p.disabled ? "var(--crow-text-muted)" : "var(--crow-success)";
      const dotTitle = p.disabled ? "disabled (soft-delete)" : "enabled";
      const idEsc = escapeHtml(p.id);
      return `<tr class="${p.disabled ? "llm-row-disabled" : ""}">
        <td class="llm-cell-status"><span aria-label="${dotTitle}" title="${dotTitle}" style="color:${dotColor};font-size:1.15rem;line-height:1">●</span></td>
        <td class="llm-cell-id">${idEsc}</td>
        <td>${hostBadge(p)}</td>
        <td class="llm-cell-endpoint">${escapeHtml(p.baseUrl || "—")}</td>
        <td class="llm-cell-models" title="${escapeHtml(models)}">${models}</td>
        <td class="llm-cell-actions">
          <form method="post" style="display:inline">
            <input type="hidden" name="action" value="${p.disabled ? "llm_provider_enable" : "llm_provider_disable"}">
            <input type="hidden" name="id" value="${idEsc}">
            <button class="btn btn-secondary btn-xs" type="submit">${p.disabled ? "Enable" : "Disable"}</button>
          </form>
        </td>
      </tr>`;
    }).join("");

    const typeOptions = KNOWN_PROVIDER_TYPES
      .map((t) => `<option value="${t}">${t}</option>`)
      .join("");

    return `<style>
      .llm-providers-table { width:100%; border-collapse:collapse; font-size:0.875rem; }
      .llm-providers-table thead tr { background:var(--crow-bg-elevated); }
      .llm-providers-table th {
        text-align:left; padding:10px 12px;
        color:var(--crow-text-muted);
        font-weight:500; font-size:0.72rem;
        letter-spacing:0.06em; text-transform:uppercase;
        border-bottom:1px solid var(--crow-border);
      }
      .llm-providers-table tbody tr { border-bottom:1px solid var(--crow-border); }
      .llm-providers-table tbody tr:last-child { border-bottom:none; }
      .llm-providers-table td { padding:10px 12px; vertical-align:middle; }
      .llm-row-disabled { opacity:0.6; }
      .llm-cell-status { width:24px; padding-left:12px !important; padding-right:0 !important; }
      .llm-cell-id { font-family:'JetBrains Mono',monospace; font-size:0.85rem; color:var(--crow-text-primary); white-space:nowrap; }
      .llm-cell-endpoint { font-family:'JetBrains Mono',monospace; font-size:0.78rem; color:var(--crow-text-muted); max-width:280px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .llm-cell-models { color:var(--crow-text-secondary); max-width:340px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .llm-cell-actions { text-align:right; white-space:nowrap; width:1%; }
      .btn-xs { padding:3px 10px; font-size:0.75rem; border-radius:var(--crow-radius-pill); }
      .llm-card {
        border:1px solid var(--crow-border);
        border-radius:var(--crow-radius-card);
        background:var(--crow-bg-surface);
        overflow:hidden;
      }
      .llm-toolbar {
        display:flex; justify-content:space-between; align-items:center;
        margin-bottom:0.75rem; gap:0.75rem;
      }
      .llm-add-form { margin-top:1rem; padding:1.25rem; background:var(--crow-bg-elevated); border:1px solid var(--crow-border); border-radius:var(--crow-radius-card); }
      .llm-add-form .llm-field { margin-bottom:0.65rem; }
      .llm-add-form label { display:block; font-size:0.75rem; color:var(--crow-text-muted); margin-bottom:4px; letter-spacing:0.03em; }
      .llm-add-form input, .llm-add-form select {
        width:100%; padding:0.5rem 0.65rem;
        background:var(--crow-bg-surface);
        border:1px solid var(--crow-border);
        border-radius:6px;
        color:var(--crow-text-primary);
        box-sizing:border-box;
        font-size:0.85rem;
      }
      .llm-add-form input:focus, .llm-add-form select:focus {
        outline:none; border-color:var(--crow-accent);
        box-shadow:0 0 0 2px var(--crow-accent-muted);
      }
      .llm-sync-note {
        display:inline-flex; align-items:center; gap:0.35rem;
        padding:0.55rem 0.75rem;
        background:var(--crow-accent-muted);
        color:var(--crow-text-primary);
        border-radius:var(--crow-radius-pill);
        font-size:0.78rem;
        border:1px solid var(--crow-border);
      }
      .llm-details-summary {
        cursor:pointer;
        font-size:0.9rem;
        font-weight:500;
        padding:0.5rem 0.75rem;
        border-radius:6px;
        list-style:none;
      }
      .llm-details-summary::-webkit-details-marker { display:none; }
      .llm-details-summary::before { content:"+ "; color:var(--crow-accent); font-weight:600; }
      details[open] > .llm-details-summary::before { content:"− "; }
      details[open] > .llm-details-summary { background:var(--crow-bg-elevated); }
    </style>

    <p class="llm-section-hint">
      ${providers.length} provider${providers.length === 1 ? "" : "s"} in registry. Bundle providers auto-appear on install. Instance-sync replicates this table across paired Crow instances.
    </p>

    <div class="llm-toolbar">
      <div></div>
      <form method="post">
        <input type="hidden" name="action" value="llm_provider_sync">
        <button class="btn btn-secondary btn-sm" type="submit" title="Re-upsert every models.json entry. Re-enables rows disabled by a prior bundle uninstall.">Sync bundle providers</button>
      </form>
    </div>

    <div class="llm-card">
      <table class="llm-providers-table">
        <thead><tr><th></th><th>ID</th><th>Host</th><th>Endpoint</th><th>Models</th><th></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="6" style="padding:1.25rem;text-align:center;color:var(--crow-text-muted)">No providers registered.</td></tr>`}</tbody>
      </table>
    </div>

    <details style="margin-top:1.25rem">
      <summary class="llm-details-summary">Add cloud provider</summary>
      <form method="post" class="llm-add-form">
        <input type="hidden" name="action" value="llm_provider_add">
        <div style="font-size:0.78rem;color:var(--crow-text-muted);margin-bottom:0.85rem;padding:0.55rem 0.75rem;background:var(--crow-bg-surface);border-left:3px solid var(--crow-brand-gold);border-radius:4px">
          <strong style="color:var(--crow-text-secondary)">Note:</strong> this API key will sync to your paired Crow instances (local-lab threat model). A per-row local-only toggle is planned for v2.
        </div>
        <div class="llm-field">
          <label>Provider ID <span style="color:var(--crow-text-muted);font-weight:normal">— lowercase, used in dropdowns</span></label>
          <input type="text" name="id" required pattern="[a-z][a-z0-9-]*" placeholder="cloud-openai-main" style="font-family:'JetBrains Mono',monospace">
        </div>
        <div style="display:grid;grid-template-columns:1fr 2fr;gap:0.75rem">
          <div class="llm-field">
            <label>Type</label>
            <select name="provider_type">${typeOptions}</select>
          </div>
          <div class="llm-field">
            <label>Base URL</label>
            <input type="text" name="base_url" required placeholder="https://api.openai.com/v1" style="font-family:'JetBrains Mono',monospace">
          </div>
        </div>
        <div class="llm-field">
          <label>API key</label>
          <input type="password" name="api_key" autocomplete="off" placeholder="sk-…">
        </div>
        <div style="display:grid;grid-template-columns:1fr 2fr;gap:0.75rem">
          <div class="llm-field">
            <label>Default model</label>
            <input type="text" name="model_id" placeholder="gpt-4o-mini" style="font-family:'JetBrains Mono',monospace">
          </div>
          <div class="llm-field">
            <label>Description <span style="color:var(--crow-text-muted);font-weight:normal">— optional</span></label>
            <input type="text" name="description" placeholder="e.g. GPT-4o for research">
          </div>
        </div>
        <div style="margin-top:0.75rem">
          <button type="submit" class="btn btn-primary btn-sm">Add provider</button>
        </div>
      </form>
    </details>`;
  },

  async handleAction({ req, res, db, action }) {
    if (action === "llm_provider_add") {
      const { id, provider_type, base_url, api_key, model_id, description } = req.body;
      if (!id || !base_url) {
        res.status(400).type("text/plain").send("id and base_url required");
        return true;
      }
      await upsertProvider(db, {
        id,
        baseUrl: base_url,
        apiKey: api_key || null,
        host: "cloud",
        bundleId: null,
        description: description || null,
        models: model_id ? [{ id: model_id }] : [],
        disabled: false,
        providerType: provider_type || null,
      });
      invalidateProvidersCache();
      res.redirectAfterPost(BACK);
      return true;
    }
    if (action === "llm_provider_disable") {
      await disableProvider(db, req.body.id);
      invalidateProvidersCache();
      res.redirectAfterPost(BACK);
      return true;
    }
    if (action === "llm_provider_enable") {
      const all = await listProvidersAll(db);
      const row = all.find((p) => p.id === req.body.id);
      if (row) {
        await upsertProvider(db, { ...row, disabled: false });
        invalidateProvidersCache();
      }
      res.redirectAfterPost(BACK);
      return true;
    }
    if (action === "llm_provider_sync") {
      const result = await syncProvidersFromModelsJson(db, { force: true });
      console.log(`[llm-providers-tab] sync force=true upserted=${result.upserted}`);
      invalidateProvidersCache();
      res.redirectAfterPost(BACK);
      return true;
    }
    return false;
  },
};
