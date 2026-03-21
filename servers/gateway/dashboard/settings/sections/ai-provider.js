/**
 * Settings Section: AI Provider
 */

import { escapeHtml } from "../../shared/components.js";
import { t, tJs } from "../../shared/i18n.js";

export default {
  id: "ai-provider",
  group: "ai",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>`,
  labelKey: "settings.section.aiProvider",
  navOrder: 10,

  async getPreview() {
    try {
      const { getProviderConfig } = await import("../../../ai/provider.js");
      const config = getProviderConfig();
      if (config?.provider) {
        const model = config.model || "";
        return `${config.provider}${model ? ` (${model})` : ""}`;
      }
    } catch {}
    return "Not configured";
  },

  async render({ lang }) {
    let aiProviderConfig = null;
    try {
      const { getProviderConfig } = await import("../../../ai/provider.js");
      aiProviderConfig = getProviderConfig();
    } catch {}

    const aiProviders = [
      { id: "openai", name: "OpenAI", defaultModel: "gpt-4o" },
      { id: "anthropic", name: "Anthropic", defaultModel: "claude-sonnet-4-20250514" },
      { id: "google", name: "Google Gemini", defaultModel: "gemini-2.5-flash" },
      { id: "ollama", name: "Ollama (local)", defaultModel: "llama3.1" },
      { id: "openrouter", name: "OpenRouter", defaultModel: "openai/gpt-4o" },
      { id: "meta", name: "Meta AI (Llama)", defaultModel: "Llama-4-Maverick-17B-128E-Instruct-FP8" },
    ];

    const currentProvider = aiProviderConfig?.provider || "";
    const currentModel = aiProviderConfig?.model || "";
    const currentBaseUrl = aiProviderConfig?.baseUrl || "";
    const hasKey = aiProviderConfig?.apiKey ? true : false;

    const providerOptions = aiProviders.map(p =>
      `<option value="${p.id}"${currentProvider === p.id ? " selected" : ""}>${escapeHtml(p.name)}</option>`
    ).join("");

    return `<style>
      .ai-field { margin-bottom:0.75rem; }
      .ai-field label { display:block; font-size:0.8rem; color:var(--crow-text-muted); margin-bottom:4px; }
      .ai-field input, .ai-field select { width:100%; padding:0.5rem; background:var(--crow-bg-deep); border:1px solid var(--crow-border); border-radius:4px; color:var(--crow-text); font-family:'JetBrains Mono',monospace; font-size:0.85rem; box-sizing:border-box; }
      .ai-actions { display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap; margin-top:1rem; }
      #ai-status { font-size:0.85rem; margin-top:0.75rem; }
    </style>
    <div class="ai-field">
      <label>${t("settings.provider", lang)}</label>
      <select id="ai-provider" onchange="aiProviderChanged()">
        <option value="">${t("settings.notConfigured", lang)}</option>
        ${providerOptions}
      </select>
    </div>
    <div class="ai-field">
      <label>${t("settings.apiKey", lang)}</label>
      <input type="password" id="ai-api-key" placeholder="${hasKey ? "••••••••" : t("settings.notSet", lang)}" autocomplete="off">
    </div>
    <div class="ai-field">
      <label>${t("settings.model", lang)} <span style="color:var(--crow-text-muted);font-weight:normal">(${t("settings.modelOptional", lang)})</span></label>
      <input type="text" id="ai-model" value="${escapeHtml(currentModel)}" placeholder="e.g. gpt-4o, claude-sonnet-4-20250514, gemini-2.5-flash">
    </div>
    <div class="ai-field" id="ai-base-url-field" style="display:${["ollama", "openrouter", ""].includes(currentProvider) || currentBaseUrl ? "block" : "none"}">
      <label>${t("settings.baseUrl", lang)} <span style="color:var(--crow-text-muted);font-weight:normal">(${t("settings.baseUrlHint", lang)})</span></label>
      <input type="text" id="ai-base-url" value="${escapeHtml(currentBaseUrl)}" placeholder="http://localhost:11434">
    </div>
    <div class="ai-actions">
      <button class="btn btn-primary btn-sm" onclick="saveAiProvider()">${t("settings.save", lang)}</button>
      <button class="btn btn-secondary btn-sm" onclick="testAiProvider()">${t("settings.testConnection", lang)}</button>
      ${currentProvider ? `<button class="btn btn-secondary btn-sm" onclick="removeAiProvider()">${t("settings.removeIntegration", lang)}</button>` : ""}
    </div>
    <div id="ai-status"></div>
    <p style="color:var(--crow-text-muted);font-size:0.8rem;margin-top:0.75rem">
      Configure an AI provider to enable the AI Chat feature in Messages. API keys are stored on this device only. <a href="/dashboard/messages" style="color:var(--crow-accent)">${t("settings.openChat", lang)}</a>
    </p>
    <script>
    function aiProviderChanged() {
      var p = document.getElementById('ai-provider').value;
      var urlField = document.getElementById('ai-base-url-field');
      urlField.style.display = (p === 'ollama' || p === 'openrouter' || p === '') ? 'block' : 'none';
      var defaults = {openai:'gpt-4o',anthropic:'claude-sonnet-4-20250514',google:'gemini-2.5-flash',ollama:'llama3.1',openrouter:'openai/gpt-4o',meta:'Llama-4-Maverick-17B-128E-Instruct-FP8'};
      document.getElementById('ai-model').placeholder = defaults[p] || 'Model name';
    }
    async function saveAiProvider() {
      var params = new URLSearchParams();
      params.set('action', 'save_ai_provider');
      var provider = document.getElementById('ai-provider').value;
      if (provider) params.set('provider', provider);
      var key = document.getElementById('ai-api-key').value;
      if (key) params.set('api_key', key);
      var model = document.getElementById('ai-model').value;
      if (model) params.set('model', model);
      var baseUrl = document.getElementById('ai-base-url').value;
      if (baseUrl) params.set('base_url', baseUrl);
      var el = document.getElementById('ai-status');
      try {
        var res = await fetch('/dashboard/settings', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:params.toString() });
        var data = await res.json();
        el.style.color = data.ok ? 'var(--crow-success)' : 'var(--crow-error)';
        el.textContent = data.ok ? '${tJs("settings.savedAiReady", lang)}' : (data.error || '${tJs("settings.saveFailed", lang)}');
        if (key) { document.getElementById('ai-api-key').value = ''; document.getElementById('ai-api-key').placeholder = '••••••••'; }
      } catch(e) { el.style.color='var(--crow-error)'; el.textContent='Save failed: '+e.message; }
    }
    async function testAiProvider() {
      var el = document.getElementById('ai-status');
      el.style.color = 'var(--crow-accent)';
      el.textContent = '${tJs("settings.testingConnection", lang)}';
      try {
        var params = new URLSearchParams();
        params.set('action', 'test_ai_provider');
        var res = await fetch('/dashboard/settings', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:params.toString() });
        var data = await res.json();
        el.style.color = data.ok ? 'var(--crow-success)' : 'var(--crow-error)';
        el.textContent = data.ok ? '${tJs("settings.connectionSuccessful", lang)} ' + (data.provider || 'unknown') : '${tJs("settings.testFailed", lang)} ' + (data.error || 'Unknown error');
      } catch(e) { el.style.color='var(--crow-error)'; el.textContent='Test failed: '+e.message; }
    }
    async function removeAiProvider() {
      if (!confirm('${tJs("settings.removeAiConfirm", lang)}')) return;
      var params = new URLSearchParams();
      params.set('action', 'remove_ai_provider');
      try {
        await fetch('/dashboard/settings', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:params.toString() });
        location.reload();
      } catch(e) { console.error(e); }
    }
    <\/script>`;
  },

  async handleAction({ req, res, db, action }) {
    if (action === "save_ai_provider") {
      const { resolveEnvPath, writeEnvVar, removeEnvVar, sanitizeEnvValue } = await import("../../../env-manager.js");
      const envPath = resolveEnvPath();
      const { provider, api_key, model, base_url } = req.body;
      if (provider) writeEnvVar(envPath, "AI_PROVIDER", sanitizeEnvValue(provider));
      if (api_key) writeEnvVar(envPath, "AI_API_KEY", sanitizeEnvValue(api_key));
      if (model) writeEnvVar(envPath, "AI_MODEL", sanitizeEnvValue(model));
      if (base_url) writeEnvVar(envPath, "AI_BASE_URL", sanitizeEnvValue(base_url));
      else removeEnvVar(envPath, "AI_BASE_URL");
      try {
        const { invalidateConfigCache } = await import("../../../ai/provider.js");
        invalidateConfigCache();
      } catch {}
      res.json({ ok: true });
      return true;
    }

    if (action === "remove_ai_provider") {
      const { resolveEnvPath, removeEnvVar } = await import("../../../env-manager.js");
      const envPath = resolveEnvPath();
      removeEnvVar(envPath, "AI_PROVIDER");
      removeEnvVar(envPath, "AI_API_KEY");
      removeEnvVar(envPath, "AI_MODEL");
      removeEnvVar(envPath, "AI_BASE_URL");
      try {
        const { invalidateConfigCache } = await import("../../../ai/provider.js");
        invalidateConfigCache();
      } catch {}
      res.json({ ok: true });
      return true;
    }

    if (action === "test_ai_provider") {
      try {
        const { testProviderConnection } = await import("../../../ai/provider.js");
        const result = await testProviderConnection();
        res.json(result);
      } catch (err) {
        res.json({ ok: false, error: err.message });
      }
      return true;
    }

    return false;
  },
};
