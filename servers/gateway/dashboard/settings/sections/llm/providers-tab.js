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
  if (p.host === "cloud") return `<span style="font-size:0.72rem;padding:2px 6px;background:var(--crow-bg-deep);border-radius:3px;color:var(--crow-accent)">cloud${p.provider_type ? ` · ${escapeHtml(p.provider_type)}` : ""}</span>`;
  if (p.host === "local") return `<span style="font-size:0.72rem;padding:2px 6px;background:var(--crow-bg-deep);border-radius:3px">local</span>`;
  return `<span style="font-size:0.72rem;padding:2px 6px;background:var(--crow-bg-deep);border-radius:3px">${escapeHtml((p.host || "").slice(0, 18))}</span>`;
}

export default {
  async render({ db }) {
    const providers = await listProvidersAll(db);
    const rows = providers.map((p) => {
      const models = (p.models || []).map((m) => escapeHtml(m.id || "?")).join(", ") || "—";
      const status = p.disabled ? "⊖ disabled" : "● enabled";
      const statusColor = p.disabled ? "var(--crow-text-muted)" : "#4caf50";
      const idEsc = escapeHtml(p.id);
      return `<tr>
        <td style="padding:8px;color:${statusColor}">${status}</td>
        <td style="padding:8px;font-family:'JetBrains Mono',monospace">${idEsc}</td>
        <td style="padding:8px">${hostBadge(p)}</td>
        <td style="padding:8px;font-family:'JetBrains Mono',monospace;font-size:0.8rem;color:var(--crow-text-muted)">${escapeHtml(p.baseUrl || "—")}</td>
        <td style="padding:8px;font-size:0.85rem">${models}</td>
        <td style="padding:8px;text-align:right;white-space:nowrap">
          <form method="post" style="display:inline"><input type="hidden" name="action" value="${p.disabled ? "llm_provider_enable" : "llm_provider_disable"}"><input type="hidden" name="id" value="${idEsc}"><button class="btn btn-secondary btn-xs" type="submit">${p.disabled ? "Enable" : "Disable"}</button></form>
        </td>
      </tr>`;
    }).join("");

    const typeOptions = KNOWN_PROVIDER_TYPES
      .map((t) => `<option value="${t}">${t}</option>`)
      .join("");

    return `<style>
      .llm-providers-table { width:100%; border-collapse:collapse; font-size:0.9rem; }
      .llm-providers-table th { text-align:left; padding:8px; background:var(--crow-bg-deep); color:var(--crow-text-muted); font-weight:500; font-size:0.8rem; }
      .llm-providers-table tr { border-bottom:1px solid var(--crow-border); }
      .btn-xs { padding:3px 8px; font-size:0.75rem; }
      .llm-add-form { margin-top:1rem; padding:1rem; background:var(--crow-bg-deep); border-radius:4px; }
      .llm-add-form label { display:block; font-size:0.8rem; color:var(--crow-text-muted); margin:6px 0 2px; }
      .llm-add-form input, .llm-add-form select { width:100%; padding:0.4rem; background:var(--crow-bg); border:1px solid var(--crow-border); border-radius:3px; color:var(--crow-text); box-sizing:border-box; font-size:0.85rem; }
    </style>

    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem">
      <div style="font-size:0.85rem;color:var(--crow-text-muted)">
        ${providers.length} provider${providers.length === 1 ? "" : "s"} in registry. Bundle providers auto-appear on install. Instance-sync keeps this table consistent across paired Crow instances.
      </div>
      <form method="post" style="display:inline">
        <input type="hidden" name="action" value="llm_provider_sync">
        <button class="btn btn-secondary btn-sm" type="submit" title="Re-upsert every models.json entry. Re-enables rows disabled by a prior bundle uninstall.">Sync bundle providers</button>
      </form>
    </div>

    <table class="llm-providers-table">
      <thead><tr><th>Status</th><th>ID</th><th>Host</th><th>Endpoint</th><th>Models</th><th></th></tr></thead>
      <tbody>${rows || `<tr><td colspan="6" style="padding:1rem;text-align:center;color:var(--crow-text-muted)">No providers registered.</td></tr>`}</tbody>
    </table>

    <details style="margin-top:1rem">
      <summary style="cursor:pointer;font-weight:500">Add cloud provider</summary>
      <form method="post" class="llm-add-form">
        <input type="hidden" name="action" value="llm_provider_add">
        <div style="font-size:0.8rem;color:var(--crow-text-muted);margin-bottom:0.5rem">
          This API key will sync to your paired Crow instances (local-lab threat model). v2 will add a per-row local-only toggle.
        </div>
        <label>Provider ID (lowercase; use the name you'll recognize in dropdowns)</label>
        <input type="text" name="id" required pattern="[a-z][a-z0-9-]*" placeholder="cloud-openai-main">
        <label>Type</label>
        <select name="provider_type">${typeOptions}</select>
        <label>Base URL</label>
        <input type="text" name="base_url" required placeholder="https://api.openai.com/v1">
        <label>API key</label>
        <input type="password" name="api_key" autocomplete="off">
        <label>Default model (saved to models list; you can add more later by editing models.json)</label>
        <input type="text" name="model_id" placeholder="gpt-4o-mini">
        <label>Description (optional)</label>
        <input type="text" name="description" placeholder="e.g. GPT-4o for research">
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
