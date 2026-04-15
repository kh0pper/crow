/**
 * Settings Section: AI Profiles
 */

import { escapeHtml } from "../../shared/components.js";
import { t, tJs } from "../../shared/i18n.js";
import { upsertSetting } from "../registry.js";
import { renderScopeToggle, scopeToggleScript } from "../../shared/scope-toggle.js";

export default {
  id: "ai-profiles",
  group: "ai",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
  labelKey: "settings.section.aiProfiles",
  navOrder: 20,

  async getPreview({ settings }) {
    let profiles = [];
    try { profiles = JSON.parse(settings.ai_profiles || "[]"); } catch {}
    return `${profiles.length} profile${profiles.length !== 1 ? "s" : ""}`;
  },

  async render({ db, lang }) {
    const profilesResult = await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = 'ai_profiles'", args: [] });
    let aiProfiles = [];
    try { aiProfiles = JSON.parse(profilesResult.rows[0]?.value || "[]"); } catch {}

    const scopeToggle = await renderScopeToggle(db, "ai_profiles", { lang });

    let html = scopeToggle + scopeToggleScript() + `<style>
      .profile-card { border:1px solid var(--crow-border); border-radius:8px; padding:0.75rem 1rem; margin-bottom:0.5rem; background:var(--crow-surface); }
      .profile-card-header { display:flex; align-items:center; justify-content:space-between; gap:0.5rem; }
      .profile-card-name { font-weight:600; font-size:0.95rem; }
      .profile-card-meta { font-size:0.8rem; color:var(--crow-text-muted); }
      .profile-card-actions { display:flex; gap:0.5rem; margin-top:0.5rem; }
      .profile-form { border:1px solid var(--crow-border); border-radius:8px; padding:1rem; margin-top:0.75rem; background:var(--crow-surface); }
    </style>`;

    for (const p of aiProfiles) {
      const maskedKey = p.apiKey ? "••••" + p.apiKey.slice(-4) : t("settings.notSet", lang);
      html += `<div class="profile-card" data-profile-id="${escapeHtml(p.id)}">
        <div class="profile-card-header">
          <div>
            <div class="profile-card-name">${escapeHtml(p.name)}</div>
            <div class="profile-card-meta">${escapeHtml(p.provider)} &middot; ${p.models?.length || 0} ${t("settings.models", lang)} &middot; ${t("settings.key", lang)} ${maskedKey}</div>
          </div>
        </div>
        <div class="profile-card-actions">
          <button class="btn btn-secondary btn-sm" onclick="editProfile('${escapeHtml(p.id)}')">${t("settings.editProfile", lang)}</button>
          <button class="btn btn-secondary btn-sm" onclick="testProfile('${escapeHtml(p.id)}',this)">${t("settings.testProfile", lang)}</button>
          <button class="btn btn-secondary btn-sm" style="color:var(--crow-error)" onclick="deleteProfile('${escapeHtml(p.id)}',this)">${t("settings.deleteProfile", lang)}</button>
        </div>
      </div>`;
    }

    html += `
    <button class="btn btn-primary btn-sm" id="add-profile-btn" onclick="document.getElementById('profile-form').style.display='block';this.style.display='none'">${t("settings.addProfile", lang)}</button>
    <div class="profile-form" id="profile-form" style="display:none">
      <input type="hidden" id="pf-id" value="">
      <div style="margin-bottom:0.75rem">
        <label style="display:block;font-size:0.8rem;color:var(--crow-text-muted);margin-bottom:4px">${t("settings.profileName", lang)}</label>
        <input type="text" id="pf-name" placeholder="${t("settings.profileNamePlaceholder", lang)}" style="width:100%;padding:0.5rem;background:var(--crow-bg-deep,#111);border:1px solid var(--crow-border);border-radius:4px;color:var(--crow-text);font-size:0.85rem;box-sizing:border-box">
      </div>
      <div style="margin-bottom:0.75rem">
        <label style="display:block;font-size:0.8rem;color:var(--crow-text-muted);margin-bottom:4px">${t("settings.provider", lang)}</label>
        <select id="pf-provider" style="width:100%;padding:0.5rem;background:var(--crow-bg-deep,#111);border:1px solid var(--crow-border);border-radius:4px;color:var(--crow-text);font-size:0.85rem;box-sizing:border-box">
          <option value="openai">OpenAI / Compatible</option>
          <option value="anthropic">Anthropic</option>
          <option value="google">Google Gemini</option>
          <option value="ollama">Ollama</option>
        </select>
      </div>
      <div style="margin-bottom:0.75rem">
        <label style="display:block;font-size:0.8rem;color:var(--crow-text-muted);margin-bottom:4px">${t("settings.apiKeyLabel", lang)}</label>
        <input type="password" id="pf-key" placeholder="${t("settings.leaveBlankKeep", lang)}" autocomplete="off" style="width:100%;padding:0.5rem;background:var(--crow-bg-deep,#111);border:1px solid var(--crow-border);border-radius:4px;color:var(--crow-text);font-family:'JetBrains Mono',monospace;font-size:0.85rem;box-sizing:border-box">
      </div>
      <div style="margin-bottom:0.75rem">
        <label style="display:block;font-size:0.8rem;color:var(--crow-text-muted);margin-bottom:4px">${t("settings.baseUrlLabel", lang)}</label>
        <input type="text" id="pf-url" placeholder="e.g. https://coding-intl.dashscope.aliyuncs.com/v1" style="width:100%;padding:0.5rem;background:var(--crow-bg-deep,#111);border:1px solid var(--crow-border);border-radius:4px;color:var(--crow-text);font-family:'JetBrains Mono',monospace;font-size:0.85rem;box-sizing:border-box">
      </div>
      <div style="margin-bottom:0.75rem">
        <label style="display:block;font-size:0.8rem;color:var(--crow-text-muted);margin-bottom:4px">${t("settings.modelsLabel", lang)} <span style="font-weight:normal">(${t("settings.commaSeparated", lang)})</span></label>
        <textarea id="pf-models" rows="3" placeholder="qwen3.5-plus, glm-5, kimi-k2.5" style="width:100%;padding:0.5rem;background:var(--crow-bg-deep,#111);border:1px solid var(--crow-border);border-radius:4px;color:var(--crow-text);font-family:'JetBrains Mono',monospace;font-size:0.85rem;box-sizing:border-box;resize:vertical"></textarea>
      </div>
      <div style="margin-bottom:0.75rem">
        <label style="display:block;font-size:0.8rem;color:var(--crow-text-muted);margin-bottom:4px">${t("settings.defaultModel", lang)}</label>
        <input type="text" id="pf-default" placeholder="e.g. qwen3.5-plus" style="width:100%;padding:0.5rem;background:var(--crow-bg-deep,#111);border:1px solid var(--crow-border);border-radius:4px;color:var(--crow-text);font-family:'JetBrains Mono',monospace;font-size:0.85rem;box-sizing:border-box">
      </div>
      <div style="display:flex;gap:0.5rem">
        <button class="btn btn-primary btn-sm" onclick="saveProfile()">${t("settings.saveProfile", lang)}</button>
        <button class="btn btn-secondary btn-sm" onclick="cancelProfileForm()">${t("common.cancel", lang)}</button>
      </div>
      <div id="pf-status" style="font-size:0.85rem;margin-top:0.5rem"></div>
    </div>

    <script>
    var _profileData = ${JSON.stringify(aiProfiles.map(p => ({ ...p, apiKey: undefined })))};

    function editProfile(id) {
      var p = _profileData.find(function(x){return x.id===id});
      if (!p) return;
      document.getElementById('pf-id').value = p.id;
      document.getElementById('pf-name').value = p.name;
      document.getElementById('pf-provider').value = p.provider;
      document.getElementById('pf-key').value = '';
      document.getElementById('pf-key').placeholder = '${tJs("settings.leaveBlankKeep", lang)}';
      document.getElementById('pf-url').value = p.baseUrl || '';
      document.getElementById('pf-models').value = (p.models||[]).join(', ');
      document.getElementById('pf-default').value = p.defaultModel || '';
      document.getElementById('profile-form').style.display = 'block';
      document.getElementById('add-profile-btn').style.display = 'none';
    }

    function cancelProfileForm() {
      document.getElementById('profile-form').style.display = 'none';
      document.getElementById('add-profile-btn').style.display = '';
      document.getElementById('pf-id').value = '';
      document.getElementById('pf-name').value = '';
      document.getElementById('pf-key').value = '';
      document.getElementById('pf-url').value = '';
      document.getElementById('pf-models').value = '';
      document.getElementById('pf-default').value = '';
    }

    async function saveProfile() {
      var params = new URLSearchParams();
      params.set('action', 'save_ai_profile');
      var id = document.getElementById('pf-id').value;
      if (id) params.set('profile_id', id);
      params.set('profile_name', document.getElementById('pf-name').value);
      params.set('profile_provider', document.getElementById('pf-provider').value);
      var key = document.getElementById('pf-key').value;
      if (key) params.set('profile_api_key', key);
      params.set('profile_base_url', document.getElementById('pf-url').value);
      params.set('profile_models', document.getElementById('pf-models').value);
      params.set('profile_default_model', document.getElementById('pf-default').value);
      var el = document.getElementById('pf-status');
      try {
        var res = await fetch('/dashboard/settings', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:params.toString() });
        var data = await res.json();
        el.style.color = data.ok ? 'var(--crow-success)' : 'var(--crow-error)';
        el.textContent = data.ok ? '${tJs("settings.savedReloading", lang)}' : (data.error || '${tJs("settings.saveFailed", lang)}');
        if (data.ok) setTimeout(function(){ location.reload(); }, 500);
      } catch(e) { el.style.color='var(--crow-error)'; el.textContent='Save failed: '+e.message; }
    }

    async function deleteProfile(id, btn) {
      if (!confirm('${tJs("settings.deleteProfileConfirm", lang)}')) return;
      btn.disabled = true;
      var params = new URLSearchParams();
      params.set('action', 'delete_ai_profile');
      params.set('profile_id', id);
      try {
        await fetch('/dashboard/settings', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:params.toString() });
        location.reload();
      } catch(e) { btn.disabled = false; }
    }

    async function testProfile(id, btn) {
      btn.disabled = true;
      btn.textContent = '${tJs("settings.testing", lang)}';
      var params = new URLSearchParams();
      params.set('action', 'test_ai_profile');
      params.set('profile_id', id);
      try {
        var res = await fetch('/dashboard/settings', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:params.toString() });
        var data = await res.json();
        btn.textContent = data.ok ? '${tJs("settings.connectedStatus", lang)}' : '${tJs("settings.failedStatus", lang)}';
        btn.style.color = data.ok ? 'var(--crow-success)' : 'var(--crow-error)';
        setTimeout(function(){ btn.textContent='${tJs("settings.testProfile", lang)}'; btn.style.color=''; btn.disabled=false; }, 3000);
      } catch(e) { btn.textContent='Error'; btn.disabled=false; }
    }
    <\/script>
    <p style="color:var(--crow-text-muted);font-size:0.8rem;margin-top:0.75rem">
      AI Profiles let you configure multiple providers and switch between them in the Messages panel. Each profile has its own API key, endpoint, and model list.
    </p>`;

    return html;
  },

  async handleAction({ req, res, db, action }) {
    if (action === "save_ai_profile") {
      const { profile_id, profile_name, profile_provider, profile_api_key, profile_base_url, profile_models, profile_default_model, vision_profile_id } = req.body;
      if (!profile_name || !profile_provider) {
        res.json({ ok: false, error: "Name and provider are required" });
        return true;
      }

      const models = (profile_models || "").split(",").map(m => m.trim()).filter(Boolean);
      const defaultModel = profile_default_model || models[0] || "";

      const existing = await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = 'ai_profiles'", args: [] });
      let profiles = [];
      try { profiles = JSON.parse(existing.rows[0]?.value || "[]"); } catch {}

      if (profile_id) {
        const idx = profiles.findIndex(p => p.id === profile_id);
        if (idx === -1) { res.json({ ok: false, error: "Profile not found" }); return true; }
        profiles[idx].name = profile_name;
        profiles[idx].provider = profile_provider;
        if (profile_api_key) profiles[idx].apiKey = profile_api_key;
        profiles[idx].baseUrl = (profile_base_url || "").trim();
        profiles[idx].models = models;
        profiles[idx].defaultModel = defaultModel;
        if (vision_profile_id !== undefined) profiles[idx].vision_profile_id = vision_profile_id || null;
      } else {
        const { randomBytes } = await import("node:crypto");
        const id = randomBytes(4).toString("hex");
        profiles.push({
          id,
          name: profile_name,
          provider: profile_provider,
          apiKey: profile_api_key || "",
          baseUrl: (profile_base_url || "").trim(),
          models,
          defaultModel,
          vision_profile_id: vision_profile_id || null,
        });
      }

      await upsertSetting(db, "ai_profiles", JSON.stringify(profiles));
      res.json({ ok: true });
      return true;
    }

    if (action === "delete_ai_profile") {
      const { profile_id } = req.body;
      if (!profile_id) { res.json({ ok: false, error: "profile_id required" }); return true; }

      const existing = await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = 'ai_profiles'", args: [] });
      let profiles = [];
      try { profiles = JSON.parse(existing.rows[0]?.value || "[]"); } catch {}
      profiles = profiles.filter(p => p.id !== profile_id);
      await upsertSetting(db, "ai_profiles", JSON.stringify(profiles));
      res.json({ ok: true });
      return true;
    }

    if (action === "test_ai_profile") {
      const { profile_id } = req.body;
      if (!profile_id) { res.json({ ok: false, error: "profile_id required" }); return true; }

      const existing = await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = 'ai_profiles'", args: [] });
      let profiles = [];
      try { profiles = JSON.parse(existing.rows[0]?.value || "[]"); } catch {}
      const profile = profiles.find(p => p.id === profile_id);
      if (!profile) { res.json({ ok: false, error: "Profile not found" }); return true; }

      try {
        const { testProfileConnection } = await import("../../../ai/provider.js");
        const result = await testProfileConnection(profile);
        res.json(result);
      } catch (err) {
        res.json({ ok: false, error: err.message });
      }
      return true;
    }

    return false;
  },
};
