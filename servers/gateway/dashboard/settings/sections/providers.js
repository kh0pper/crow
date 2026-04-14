/**
 * Settings Section: LLM Providers (Phase 5-full)
 *
 * Operator-editable view of the providers registry (DB-backed).
 * Lets you see every provider with live health, edit baseUrl/apiKey/models,
 * test /v1/models reachability, disable soft-delete. Auto-registration:
 * bundle installs that declare manifest.providers[] populate this table.
 */

import { escapeHtml } from "../../shared/components.js";
import { listProvidersAll, upsertProvider, disableProvider } from "../../../../orchestrator/providers-db.js";
import { invalidateProvidersCache, healthMatrix } from "../../../../orchestrator/providers.js";

export default {
  id: "providers",
  group: "ai",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`,
  labelKey: "settings.section.providers",
  navOrder: 15,

  async getPreview({ db }) {
    try {
      const list = await listProvidersAll(db);
      const active = list.filter((p) => !p.disabled);
      return `${active.length} provider${active.length === 1 ? "" : "s"}`;
    } catch {
      return "Not configured";
    }
  },

  async render({ db }) {
    const providers = await listProvidersAll(db);
    const health = await healthMatrix({ timeoutMs: 2000 }).catch(() => ({ providers: {} }));

    const rows = providers.map((p) => {
      const h = health.providers?.[p.id];
      const statusDot = p.disabled
        ? `<span title="disabled" style="color:var(--crow-text-muted)">⊖</span>`
        : h?.ok
          ? `<span title="reachable ${h.latencyMs}ms" style="color:#4caf50">●</span>`
          : `<span title="${escapeHtml(h?.error || 'down')}" style="color:#e53935">●</span>`;
      const modelList = (p.models || []).map((m) => escapeHtml(m.id || "?")).join(", ") || "-";
      const hostBadge = p.host === "local"
        ? `<span style="font-size:0.75rem;padding:2px 6px;background:var(--crow-bg-deep);border-radius:3px">local</span>`
        : `<span style="font-size:0.75rem;padding:2px 6px;background:var(--crow-bg-deep);border-radius:3px;color:var(--crow-accent)">${escapeHtml((p.host || '').slice(0, 12))}</span>`;
      const badge = p.bundle_id
        ? `<span style="font-size:0.72rem;padding:2px 6px;background:var(--crow-bg-deep);border-radius:3px;margin-left:4px;color:var(--crow-text-muted)">bundle</span>`
        : "";
      const idEsc = escapeHtml(p.id);
      return `
        <tr data-id="${idEsc}">
          <td style="padding:8px;white-space:nowrap">${statusDot}</td>
          <td style="padding:8px;font-family:'JetBrains Mono',monospace">${idEsc} ${badge}</td>
          <td style="padding:8px">${hostBadge}</td>
          <td style="padding:8px;font-family:'JetBrains Mono',monospace;font-size:0.8rem;color:var(--crow-text-muted)">${escapeHtml(p.baseUrl || "-")}</td>
          <td style="padding:8px;font-size:0.85rem">${modelList}</td>
          <td style="padding:8px;text-align:right;white-space:nowrap">
            <button type="button" class="btn btn-secondary btn-xs" data-action="test" data-pid="${idEsc}">Test</button>
            <button type="button" class="btn btn-secondary btn-xs" data-action="edit" data-pid="${idEsc}">Edit</button>
            ${p.disabled
              ? `<button type="button" class="btn btn-secondary btn-xs" data-action="enable" data-pid="${idEsc}">Enable</button>`
              : `<button type="button" class="btn btn-secondary btn-xs" data-action="disable" data-pid="${idEsc}">Disable</button>`}
          </td>
        </tr>
      `;
    }).join("");

    // All UI-bound data is serialized via JSON.stringify (safe for <script> context
    // only if we avoid closing-script-tag injection — escapeHtml handles most, but
    // for JSON we use the well-known </ → <\/ substitution.
    const providersJson = JSON.stringify(providers).replace(/</g, "\\u003c");

    return `<style>
      .providers-table { width:100%; border-collapse:collapse; font-size:0.9rem; }
      .providers-table th { text-align:left; padding:8px; background:var(--crow-bg-deep); color:var(--crow-text-muted); font-weight:500; font-size:0.8rem; }
      .providers-table tr { border-bottom:1px solid var(--crow-border); }
      .providers-table td { vertical-align:middle; }
      .btn-xs { padding:3px 8px; font-size:0.75rem; }
      #provider-status { font-size:0.85rem; margin-top:0.75rem; }
      #provider-edit-form { margin-top:1rem; padding:1rem; background:var(--crow-bg-deep); border-radius:4px; display:none; }
      #provider-edit-form label { display:block; font-size:0.8rem; color:var(--crow-text-muted); margin:4px 0; }
      #provider-edit-form input, #provider-edit-form textarea { width:100%; padding:0.4rem; background:var(--crow-bg); border:1px solid var(--crow-border); border-radius:3px; color:var(--crow-text); font-family:'JetBrains Mono',monospace; font-size:0.85rem; box-sizing:border-box; }
      #provider-edit-form textarea { min-height:80px; font-size:0.8rem; }
    </style>

    <div style="margin-bottom:1rem;font-size:0.85rem;color:var(--crow-text-muted)">
      ${providers.length} provider${providers.length === 1 ? '' : 's'} in the registry.
      Providers auto-appear when model bundles are installed from the Extensions page.
      Instance-sync keeps this table consistent across paired Crow instances.
    </div>

    <table class="providers-table">
      <thead><tr>
        <th></th><th>ID</th><th>Host</th><th>Endpoint</th><th>Models</th><th></th>
      </tr></thead>
      <tbody>${rows || '<tr><td colspan="6" style="padding:1rem;text-align:center;color:var(--crow-text-muted)">No providers registered.</td></tr>'}</tbody>
    </table>

    <div id="provider-status"></div>

    <form id="provider-edit-form" onsubmit="return window.__providerSave(event)">
      <input type="hidden" id="p_orig_id">
      <label>ID</label>
      <input type="text" id="p_id" required pattern="[a-z][a-z0-9-]*" placeholder="e.g. grackle-embed">
      <label>Base URL</label>
      <input type="text" id="p_baseUrl" required placeholder="http://100.121.254.89:9100/v1">
      <label>API key <span style="color:var(--crow-text-muted);font-weight:normal">(optional; 'none' for local)</span></label>
      <input type="text" id="p_apiKey" placeholder="none">
      <label>Host <span style="color:var(--crow-text-muted);font-weight:normal">('local' or an instance ID)</span></label>
      <input type="text" id="p_host" value="local">
      <label>Description</label>
      <input type="text" id="p_description">
      <label>Models (JSON array)</label>
      <textarea id="p_models">[]</textarea>
      <div style="margin-top:0.75rem;display:flex;gap:0.5rem">
        <button type="submit" class="btn btn-primary btn-sm">Save</button>
        <button type="button" class="btn btn-secondary btn-sm" onclick="window.__providerCancel()">Cancel</button>
      </div>
    </form>

    <script>
    (function(){
      const rows = ${providersJson};
      const byId = Object.fromEntries(rows.map(r => [r.id, r]));

      async function apiCall(action, payload) {
        const form = new FormData();
        form.append('action', action);
        if (payload) form.append('payload', JSON.stringify(payload));
        const res = await fetch(window.location.pathname + window.location.search, {
          method: 'POST', body: form, credentials: 'same-origin',
        });
        return res.ok;
      }

      function setStatusError(id, error) {
        const el = document.getElementById('provider-status');
        el.textContent = '';
        const cross = document.createElement('span');
        cross.style.color = '#e53935';
        cross.textContent = '✗';
        el.appendChild(cross);
        el.appendChild(document.createTextNode(' ' + id + ' unreachable: ' + (error || 'unknown')));
      }
      function setStatusOk(id, latency, models) {
        const el = document.getElementById('provider-status');
        el.textContent = '';
        const check = document.createElement('span');
        check.style.color = '#4caf50';
        check.textContent = '✓';
        el.appendChild(check);
        el.appendChild(document.createTextNode(' ' + id + ' reachable (' + latency + 'ms) · models: ' + (models || []).join(', ')));
      }

      window.__providerTest = async function(id) {
        const el = document.getElementById('provider-status');
        el.textContent = 'Testing ' + id + '…';
        try {
          const r = await fetch('/api/providers/health?timeout=3000', { credentials: 'same-origin' });
          const m = await r.json();
          const p = m.providers[id];
          if (p && p.ok) setStatusOk(id, p.latencyMs, p.models);
          else setStatusError(id, p && p.error);
        } catch (e) { el.textContent = 'Test failed: ' + e.message; }
      };

      window.__providerEdit = function(id) {
        const p = byId[id];
        const f = document.getElementById('provider-edit-form');
        document.getElementById('p_orig_id').value = p ? p.id : '';
        document.getElementById('p_id').value = p ? p.id : '';
        document.getElementById('p_baseUrl').value = p ? p.baseUrl : '';
        document.getElementById('p_apiKey').value = p ? (p.apiKey || '') : '';
        document.getElementById('p_host').value = p ? p.host : 'local';
        document.getElementById('p_description').value = p ? (p.description || '') : '';
        document.getElementById('p_models').value = p ? JSON.stringify(p.models, null, 2) : '[]';
        f.style.display = 'block';
        f.scrollIntoView({ behavior: 'smooth' });
      };
      window.__providerCancel = function() { document.getElementById('provider-edit-form').style.display = 'none'; };

      window.__providerSave = async function(e) {
        e.preventDefault();
        let models;
        try { models = JSON.parse(document.getElementById('p_models').value || '[]'); }
        catch (err) { alert('Models must be valid JSON: ' + err.message); return false; }
        const payload = {
          id: document.getElementById('p_id').value,
          baseUrl: document.getElementById('p_baseUrl').value,
          apiKey: document.getElementById('p_apiKey').value || null,
          host: document.getElementById('p_host').value || 'local',
          description: document.getElementById('p_description').value || null,
          models,
        };
        const ok = await apiCall('provider_save', payload);
        if (ok) window.location.reload();
        else alert('Save failed');
        return false;
      };

      window.__providerDisable = async function(id) {
        if (!confirm('Disable provider ' + id + '? (soft delete; reversible)')) return;
        if (await apiCall('provider_disable', { id })) window.location.reload();
      };
      window.__providerEnable = async function(id) {
        const p = byId[id];
        if (!p) return;
        if (await apiCall('provider_save', Object.assign({}, p, { disabled: false }))) window.location.reload();
      };

      // Wire up action buttons via data-action attributes (avoids inline onclick + XSS)
      document.querySelectorAll('button[data-action][data-pid]').forEach(function(btn){
        btn.addEventListener('click', function(){
          const a = btn.getAttribute('data-action');
          const id = btn.getAttribute('data-pid');
          if (a === 'test') window.__providerTest(id);
          else if (a === 'edit') window.__providerEdit(id);
          else if (a === 'enable') window.__providerEnable(id);
          else if (a === 'disable') window.__providerDisable(id);
        });
      });
    })();
    </script>
    `;
  },

  async handleAction({ req, res, db, action }) {
    if (action === "provider_save") {
      const payload = JSON.parse(req.body?.payload || "{}");
      if (!payload.id || !payload.baseUrl) {
        res.status(400).type("html").send("id + baseUrl required");
        return true;
      }
      await upsertProvider(db, payload);
      invalidateProvidersCache();
      res.redirect("?section=providers");
      return true;
    }
    if (action === "provider_disable") {
      const payload = JSON.parse(req.body?.payload || "{}");
      await disableProvider(db, payload.id);
      invalidateProvidersCache();
      res.redirect("?section=providers");
      return true;
    }
    return false;
  },
};
