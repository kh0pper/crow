/**
 * Settings Section: AI Profiles
 */

import { escapeHtml } from "../../shared/components.js";
import { t, tJs } from "../../shared/i18n.js";
import { upsertSetting } from "../registry.js";
import { renderScopeToggle, scopeToggleScript } from "../../shared/scope-toggle.js";
import { listProvidersAll } from "../../../../orchestrator/providers-db.js";

// Canonical route ids the Smart Chat router dispatches to. Keep in sync
// with DEFAULT_ROUTES in servers/gateway/ai/smart-router.js.
const AUTO_ROUTES = [
  { id: "code",    label: "Code",    hint: "slash /code, code fences, or write/debug/refactor/implement" },
  { id: "vision",  label: "Vision",  hint: "image attachments or /vision" },
  { id: "fast",    label: "Fast",    hint: "/fast — quick lookups, tool dispatch" },
  { id: "deep",    label: "Deep",    hint: "/deep or summarize/analyze/compare over 200 chars" },
  { id: "default", label: "Default", hint: "everything else — also the fallback" },
];
const AUTO_RULE_TOGGLES = [
  { id: "slash",      label: "Slash-command routing", hint: "/code /vision /fast /deep prefix." },
  { id: "attachment", label: "Attachment routing",    hint: "Image uploads → vision route." },
  { id: "keyword",    label: "Keyword routing",       hint: "Code fences, verbs like 'summarize', etc." },
];

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

    // Enrich pointer-mode profiles with provider row data (post-v3-strip).
    // Renderer and Edit form read `p.provider/baseUrl/models/apiKey`; for
    // profiles whose direct fields were stripped by the migration, pull
    // them back from the providers DB row so the display stays accurate.
    const pointerIds = Array.from(new Set(aiProfiles.map((p) => p?.provider_id).filter(Boolean)));
    if (pointerIds.length > 0) {
      const placeholders = pointerIds.map(() => "?").join(",");
      const { rows: providerRows } = await db.execute({
        sql: `SELECT id, provider_type, base_url, api_key, models FROM providers WHERE id IN (${placeholders})`,
        args: pointerIds,
      });
      const byId = new Map(providerRows.map((r) => [r.id, r]));
      aiProfiles = aiProfiles.map((p) => {
        if (!p?.provider_id) return p;
        const reg = byId.get(p.provider_id);
        if (!reg) return p;
        let regModels = [];
        try {
          const parsed = JSON.parse(reg.models || "[]");
          regModels = parsed.map((m) => (typeof m === "string" ? m : m?.id)).filter(Boolean);
        } catch {}
        return {
          ...p,
          provider: p.provider || reg.provider_type || null,
          baseUrl: p.baseUrl || reg.base_url || "",
          apiKey: p.apiKey || reg.api_key || "",
          models: (Array.isArray(p.models) && p.models.length) ? p.models : regModels,
        };
      });
    }

    const scopeToggle = await renderScopeToggle(db, "ai_profiles", { lang });

    // Providers list for the auto-routing rules editor. Disabled providers
    // stay in the list so operators can see why a route "doesn't work" —
    // picking one surfaces a hint. Empty-string value ("") means "use the
    // baked-in default" (DEFAULT_ROUTES in smart-router.js).
    const providers = await listProvidersAll(db).catch(() => []);
    const providerOptionsHtml = providers.map((p) =>
      `<option value="${escapeHtml(p.id)}"${p.disabled ? " disabled" : ""}>${escapeHtml(p.id)}${p.disabled ? " (disabled)" : ""}</option>`
    ).join("");

    let html = scopeToggle + scopeToggleScript() + `<style>
      .profile-card { border:1px solid var(--crow-border); border-radius:8px; padding:0.75rem 1rem; margin-bottom:0.5rem; background:var(--crow-surface); }
      .profile-card-header { display:flex; align-items:center; justify-content:space-between; gap:0.5rem; }
      .profile-card-name { font-weight:600; font-size:0.95rem; }
      .profile-card-meta { font-size:0.8rem; color:var(--crow-text-muted); }
      .profile-card-actions { display:flex; gap:0.5rem; margin-top:0.5rem; }
      .profile-form { border:1px solid var(--crow-border); border-radius:8px; padding:1rem; margin-top:0.75rem; background:var(--crow-surface); }
    </style>`;

    for (const p of aiProfiles) {
      const isAuto = p.kind === "auto";
      let meta;
      if (isAuto) {
        const overrides = p.auto_rules?.overrides || {};
        const overrideCount = Object.values(overrides).filter(Boolean).length;
        const disabledRules = Array.isArray(p.auto_rules?.disabled) ? p.auto_rules.disabled.length : 0;
        meta = `<span class="llm-profile-badge llm-profile-badge-auto">auto-routing</span> &middot; ${overrideCount} route override${overrideCount === 1 ? "" : "s"}${disabledRules > 0 ? ` &middot; ${disabledRules} rule${disabledRules === 1 ? "" : "s"} disabled` : ""}`;
      } else {
        const maskedKey = p.apiKey ? "••••" + p.apiKey.slice(-4) : t("settings.notSet", lang);
        meta = `${escapeHtml(p.provider)} &middot; ${p.models?.length || 0} ${t("settings.models", lang)} &middot; ${t("settings.key", lang)} ${maskedKey}`;
      }
      // `test` doesn't make sense for auto profiles — there's no single provider to probe.
      const testBtn = isAuto ? "" : `<button class="btn btn-secondary btn-sm" onclick="testProfile('${escapeHtml(p.id)}',this)">${t("settings.testProfile", lang)}</button>`;
      html += `<div class="profile-card${isAuto ? " profile-card-auto" : ""}" data-profile-id="${escapeHtml(p.id)}">
        <div class="profile-card-header">
          <div>
            <div class="profile-card-name">${escapeHtml(p.name)}</div>
            <div class="profile-card-meta">${meta}</div>
          </div>
        </div>
        <div class="profile-card-actions">
          <button class="btn btn-secondary btn-sm" onclick="editProfile('${escapeHtml(p.id)}')">${t("settings.editProfile", lang)}</button>
          ${testBtn}
          <button class="btn btn-secondary btn-sm" style="color:var(--crow-error)" onclick="deleteProfile('${escapeHtml(p.id)}',this)">${t("settings.deleteProfile", lang)}</button>
        </div>
      </div>`;
    }

    html += `
    <style>
      .llm-profile-badge { display:inline-block; padding:1px 7px; border-radius:var(--crow-radius-pill); font-size:0.7rem; letter-spacing:0.03em; }
      .llm-profile-badge-auto { background:var(--crow-brand-gold); color:#000; font-weight:500; }
      .profile-card-auto { border-left:3px solid var(--crow-brand-gold); }
      .pf-kind-bar { display:flex; gap:0.5rem; margin-bottom:0.75rem; }
      .pf-kind-opt { flex:1; border:1px solid var(--crow-border); border-radius:6px; padding:0.55rem 0.7rem; cursor:pointer; }
      .pf-kind-opt input[type="radio"] { margin-right:0.4rem; vertical-align:middle; }
      .pf-kind-opt.active { border-color:var(--crow-accent); background:color-mix(in srgb, var(--crow-accent) 7%, transparent); }
      .pf-kind-label { font-weight:500; font-size:0.88rem; }
      .pf-kind-hint  { font-size:0.74rem; color:var(--crow-text-muted); margin-top:2px; }
      .pf-auto-block { border:1px solid var(--crow-border); border-radius:6px; padding:0.7rem 0.85rem; margin-bottom:0.75rem; background:color-mix(in srgb, var(--crow-brand-gold) 3%, transparent); }
      .pf-auto-block h4 { margin:0 0 0.5rem 0; font-size:0.85rem; color:var(--crow-text-primary); font-weight:500; }
      .pf-route-row { display:grid; grid-template-columns:90px 1fr; gap:0.5rem; align-items:center; margin-bottom:0.45rem; }
      .pf-route-label { font-family:'JetBrains Mono',monospace; font-size:0.8rem; color:var(--crow-text-secondary); }
      .pf-route-row select { padding:0.35rem 0.5rem; background:var(--crow-bg-deep,#111); border:1px solid var(--crow-border); border-radius:4px; color:var(--crow-text); font-family:'JetBrains Mono',monospace; font-size:0.82rem; }
      .pf-route-hint { font-size:0.72rem; color:var(--crow-text-muted); grid-column:2; margin-top:-2px; }
      .pf-toggle-row { display:flex; align-items:flex-start; gap:0.5rem; margin-bottom:0.35rem; font-size:0.83rem; }
      .pf-toggle-row input[type="checkbox"] { margin-top:3px; }
      .pf-toggle-hint { display:block; font-size:0.72rem; color:var(--crow-text-muted); }
    </style>
    <button class="btn btn-primary btn-sm" id="add-profile-btn" onclick="document.getElementById('profile-form').style.display='block';this.style.display='none'">${t("settings.addProfile", lang)}</button>
    <div class="profile-form" id="profile-form" style="display:none">
      <input type="hidden" id="pf-id" value="">
      <input type="hidden" id="pf-kind" value="chat">
      <div class="pf-kind-bar" id="pf-kind-bar">
        <label class="pf-kind-opt active" data-kind="chat">
          <input type="radio" name="pf-kind-radio" value="chat" checked>
          <span class="pf-kind-label">Chat</span>
          <div class="pf-kind-hint">One provider + model. Default for normal conversations.</div>
        </label>
        <label class="pf-kind-opt" data-kind="auto">
          <input type="radio" name="pf-kind-radio" value="auto">
          <span class="pf-kind-label">Auto-routing</span>
          <div class="pf-kind-hint">Smart Chat — routes per-message to code / vision / fast / deep / default. Requires the experimental flag.</div>
        </label>
      </div>
      <div style="margin-bottom:0.75rem">
        <label style="display:block;font-size:0.8rem;color:var(--crow-text-muted);margin-bottom:4px">${t("settings.profileName", lang)}</label>
        <input type="text" id="pf-name" placeholder="${t("settings.profileNamePlaceholder", lang)}" style="width:100%;padding:0.5rem;background:var(--crow-bg-deep,#111);border:1px solid var(--crow-border);border-radius:4px;color:var(--crow-text);font-size:0.85rem;box-sizing:border-box">
      </div>
      <div class="pf-auto-block" id="pf-auto-block" style="display:none">
        <h4>Auto-routing rules</h4>
        <div style="font-size:0.78rem;color:var(--crow-text-secondary);margin-bottom:0.65rem;line-height:1.45">
          Per-route provider override. Leave blank to use the baked-in default (<code>code</code>→crow-swap-coder, <code>vision</code>→grackle-vision, <code>fast</code>→crow-dispatch, <code>deep</code>→crow-swap-deep, <code>default</code>→crow-chat). Precedence: slash-command &gt; attachment &gt; keyword &gt; default.
        </div>
        ${AUTO_ROUTES.map((r) => `
          <div class="pf-route-row">
            <span class="pf-route-label">${escapeHtml(r.id)}</span>
            <select id="pf-auto-${escapeHtml(r.id)}">
              <option value="">— baked-in default —</option>
              ${providerOptionsHtml}
            </select>
            <span class="pf-route-hint">${escapeHtml(r.hint)}</span>
          </div>`).join("")}
        <hr style="border:none;border-top:1px solid var(--crow-border);margin:0.65rem 0 0.55rem 0">
        <h4 style="font-size:0.8rem">Rule toggles</h4>
        ${AUTO_RULE_TOGGLES.map((r) => `
          <div class="pf-toggle-row">
            <input type="checkbox" id="pf-auto-rule-${escapeHtml(r.id)}" checked>
            <label for="pf-auto-rule-${escapeHtml(r.id)}">
              ${escapeHtml(r.label)}
              <span class="pf-toggle-hint">${escapeHtml(r.hint)}</span>
            </label>
          </div>`).join("")}
      </div>
      <div class="pf-chat-block" id="pf-chat-block">
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
      </div><!-- /pf-chat-block -->
      <div style="display:flex;gap:0.5rem">
        <button class="btn btn-primary btn-sm" onclick="saveProfile()">${t("settings.saveProfile", lang)}</button>
        <button class="btn btn-secondary btn-sm" onclick="cancelProfileForm()">${t("common.cancel", lang)}</button>
      </div>
      <div id="pf-status" style="font-size:0.85rem;margin-top:0.5rem"></div>
    </div>

    <script>
    var _profileData = ${JSON.stringify(aiProfiles.map(p => ({ ...p, apiKey: undefined })))};
    var _autoRoutes = ${JSON.stringify(AUTO_ROUTES.map((r) => r.id))};
    var _autoRuleToggles = ${JSON.stringify(AUTO_RULE_TOGGLES.map((r) => r.id))};

    function _setKindUI(kind) {
      var isAuto = kind === 'auto';
      document.getElementById('pf-kind').value = kind;
      document.getElementById('pf-auto-block').style.display = isAuto ? 'block' : 'none';
      document.getElementById('pf-chat-block').style.display = isAuto ? 'none' : 'block';
      document.querySelectorAll('#pf-kind-bar .pf-kind-opt').forEach(function (el) {
        el.classList.toggle('active', el.dataset.kind === kind);
      });
    }
    document.querySelectorAll('#pf-kind-bar input[name="pf-kind-radio"]').forEach(function (el) {
      el.addEventListener('change', function () { _setKindUI(el.value); });
    });

    function editProfile(id) {
      var p = _profileData.find(function(x){return x.id===id});
      if (!p) return;
      var kind = p.kind === 'auto' ? 'auto' : 'chat';
      var radio = document.querySelector('#pf-kind-bar input[value="' + kind + '"]');
      if (radio) radio.checked = true;
      _setKindUI(kind);

      document.getElementById('pf-id').value = p.id;
      document.getElementById('pf-name').value = p.name;

      if (kind === 'auto') {
        var rules = p.auto_rules || {};
        var overrides = rules.overrides || {};
        _autoRoutes.forEach(function (route) {
          var sel = document.getElementById('pf-auto-' + route);
          if (sel) sel.value = overrides[route] || '';
        });
        var disabled = Array.isArray(rules.disabled) ? rules.disabled : [];
        _autoRuleToggles.forEach(function (t) {
          var cb = document.getElementById('pf-auto-rule-' + t);
          if (cb) cb.checked = !disabled.includes(t);
        });
      } else {
        document.getElementById('pf-provider').value = p.provider;
        document.getElementById('pf-key').value = '';
        document.getElementById('pf-key').placeholder = '${tJs("settings.leaveBlankKeep", lang)}';
        document.getElementById('pf-url').value = p.baseUrl || '';
        document.getElementById('pf-models').value = (p.models||[]).join(', ');
        document.getElementById('pf-default').value = p.defaultModel || '';
      }
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
      // Reset kind to "chat" and auto-rule fields.
      var chatRadio = document.querySelector('#pf-kind-bar input[value="chat"]');
      if (chatRadio) chatRadio.checked = true;
      _setKindUI('chat');
      _autoRoutes.forEach(function (route) {
        var sel = document.getElementById('pf-auto-' + route);
        if (sel) sel.value = '';
      });
      _autoRuleToggles.forEach(function (t) {
        var cb = document.getElementById('pf-auto-rule-' + t);
        if (cb) cb.checked = true;
      });
    }

    async function saveProfile() {
      var params = new URLSearchParams();
      params.set('action', 'save_ai_profile');
      var id = document.getElementById('pf-id').value;
      if (id) params.set('profile_id', id);
      var kind = document.getElementById('pf-kind').value || 'chat';
      params.set('profile_kind', kind);
      params.set('profile_name', document.getElementById('pf-name').value);
      if (kind === 'auto') {
        var overrides = {};
        _autoRoutes.forEach(function (route) {
          var sel = document.getElementById('pf-auto-' + route);
          if (sel && sel.value) overrides[route] = sel.value;
        });
        var disabled = [];
        _autoRuleToggles.forEach(function (t) {
          var cb = document.getElementById('pf-auto-rule-' + t);
          if (cb && !cb.checked) disabled.push(t);
        });
        params.set('profile_auto_rules', JSON.stringify({ overrides: overrides, disabled: disabled }));
      } else {
        params.set('profile_provider', document.getElementById('pf-provider').value);
        var key = document.getElementById('pf-key').value;
        if (key) params.set('profile_api_key', key);
        params.set('profile_base_url', document.getElementById('pf-url').value);
        params.set('profile_models', document.getElementById('pf-models').value);
        params.set('profile_default_model', document.getElementById('pf-default').value);
      }
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
      const { profile_id, profile_kind, profile_name, profile_provider, profile_api_key, profile_base_url, profile_models, profile_default_model, profile_auto_rules, vision_profile_id } = req.body;
      const kind = profile_kind === "auto" ? "auto" : "chat";
      if (!profile_name) {
        res.json({ ok: false, error: "Name is required" });
        return true;
      }
      if (kind === "chat" && !profile_provider) {
        res.json({ ok: false, error: "Provider is required for Chat-kind profiles" });
        return true;
      }

      // Parse + validate auto_rules for kind="auto". Unknown keys are dropped
      // so operators can't smuggle arbitrary JSON into the profile blob.
      let autoRules = null;
      if (kind === "auto") {
        try {
          const parsed = JSON.parse(profile_auto_rules || "{}");
          const overrides = {};
          const knownRoutes = new Set(AUTO_ROUTES.map((r) => r.id));
          for (const [k, v] of Object.entries(parsed.overrides || {})) {
            if (knownRoutes.has(k) && typeof v === "string" && v) overrides[k] = v;
          }
          const knownToggles = new Set(AUTO_RULE_TOGGLES.map((r) => r.id));
          const disabled = Array.isArray(parsed.disabled)
            ? parsed.disabled.filter((x) => typeof x === "string" && knownToggles.has(x))
            : [];
          autoRules = { overrides, disabled };
        } catch {
          res.json({ ok: false, error: "Invalid auto_rules payload" });
          return true;
        }
      }

      const models = (profile_models || "").split(",").map(m => m.trim()).filter(Boolean);
      const defaultModel = profile_default_model || models[0] || "";

      const existing = await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = 'ai_profiles'", args: [] });
      let profiles = [];
      try { profiles = JSON.parse(existing.rows[0]?.value || "[]"); } catch {}

      if (profile_id) {
        const idx = profiles.findIndex(p => p.id === profile_id);
        if (idx === -1) { res.json({ ok: false, error: "Profile not found" }); return true; }
        profiles[idx].kind = kind;
        profiles[idx].name = profile_name;
        if (kind === "auto") {
          // Auto profiles carry only { id, name, kind, auto_rules }. Strip
          // legacy direct/pointer fields so there's no stale hint of a
          // provider — chat.js only dispatches via smartRoute for these.
          profiles[idx].auto_rules = autoRules;
          delete profiles[idx].provider;
          delete profiles[idx].provider_id;
          delete profiles[idx].model_id;
          delete profiles[idx].apiKey;
          delete profiles[idx].baseUrl;
          delete profiles[idx].models;
          delete profiles[idx].defaultModel;
          delete profiles[idx].vision_profile_id;
        } else {
          delete profiles[idx].auto_rules;
          profiles[idx].defaultModel = defaultModel;
          if (vision_profile_id !== undefined) profiles[idx].vision_profile_id = vision_profile_id || null;
          if (profiles[idx].provider_id) {
            // Pointer-mode profile: provider/apiKey/baseUrl/models live on
            // the providers DB row (edit them in the Providers tab). The
            // Edit form fields are display-only for these; don't rewrite
            // them back into the profile or we'll reintroduce the legacy
            // shape that the v3 migration stripped.
            if (defaultModel) profiles[idx].model_id = defaultModel;
          } else {
            profiles[idx].provider = profile_provider;
            if (profile_api_key) profiles[idx].apiKey = profile_api_key;
            profiles[idx].baseUrl = (profile_base_url || "").trim();
            profiles[idx].models = models;
          }
        }
      } else {
        const { randomBytes } = await import("node:crypto");
        const id = randomBytes(4).toString("hex");
        if (kind === "auto") {
          profiles.push({ id, kind: "auto", name: profile_name, auto_rules: autoRules });
        } else {
          profiles.push({
            id,
            kind: "chat",
            name: profile_name,
            provider: profile_provider,
            apiKey: profile_api_key || "",
            baseUrl: (profile_base_url || "").trim(),
            models,
            defaultModel,
            vision_profile_id: vision_profile_id || null,
          });
        }
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
        const result = await testProfileConnection(profile, db);
        res.json(result);
      } catch (err) {
        res.json({ ok: false, error: err.message });
      }
      return true;
    }

    return false;
  },
};
