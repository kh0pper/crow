/**
 * Settings Section: Vision Profiles
 *
 * Per-profile config for vision-language models (image description, OCR,
 * etc). Written against the scoped settings API from day one: new rows
 * default to local scope because the typical vLLM endpoint IP is
 * instance-specific. Users can promote to global via the scope toggle.
 *
 * Each profile carries either a pointer into models.json (`provider_id`
 * + `model_id`) OR direct `baseUrl` / `apiKey` / `model`. Pointer mode lets
 * profiles track orchestrator/models.json changes automatically.
 */

import { escapeHtml } from "../../shared/components.js";
import { readSetting, writeSetting, getSettingScope } from "../registry.js";
import { renderScopeToggle, scopeToggleScript } from "../../shared/scope-toggle.js";
import { listProviders, resolveProvider } from "../../../ai/resolve-provider.js";
import { analyzeImage } from "../../../ai/vision.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const KEY = "vision_profiles";
const FIRST_WRITE_DEFAULT_SCOPE = "local";

const _testInflight = new Set();

async function loadProfiles(db) {
  const raw = await readSetting(db, KEY);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

async function saveProfiles(db, profiles, { scope }) {
  await writeSetting(db, KEY, JSON.stringify(profiles), { scope });
}

async function resolveEffectiveScope(db) {
  const raw = await getSettingScope(db, KEY);
  return (raw === "global" || raw === "local") ? raw : FIRST_WRITE_DEFAULT_SCOPE;
}

async function resolveProfileToConfig(profile, db) {
  if (profile?.provider_id) {
    return resolveProvider(profile.provider_id, profile.model_id, db);
  }
  if (!profile?.baseUrl || !profile?.model) return null;
  return {
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey || "none",
    model: profile.model,
  };
}

export default {
  id: "vision-profiles",
  group: "ai",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`,
  labelKey: "settings.section.visionProfiles",
  navOrder: 30,

  async getPreview({ settings }) {
    let profiles = [];
    try { profiles = JSON.parse(settings.vision_profiles || "[]"); } catch {}
    if (profiles.length === 0) return "Not configured";
    const active = profiles.find(p => p.isDefault) || profiles[0];
    const target = active.provider_id
      ? `${active.provider_id}/${active.model_id || "first"}`
      : (active.model || "—");
    return `${active.name} (${target})`;
  },

  async render({ db, lang }) {
    const profiles = await loadProfiles(db);
    const scopeToggle = await renderScopeToggle(db, KEY, { lang });
    let providers = [];
    try { providers = listProviders(); } catch {}
    const providerOptions = providers
      .map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.id)} (${escapeHtml(p.baseUrl)})</option>`)
      .join("");
    const providerModels = JSON.stringify(
      Object.fromEntries(providers.map(p => [p.id, p.models.map(m => m.id)]))
    );

    let html = scopeToggle + scopeToggleScript() + `<style>
      .vp-card { border:1px solid var(--crow-border); border-radius:8px; padding:0.75rem 1rem; margin-bottom:0.5rem; background:var(--crow-surface); }
      .vp-card.default { border-color:var(--crow-accent); }
      .vp-card-header { display:flex; align-items:center; justify-content:space-between; gap:0.5rem; }
      .vp-card-name { font-weight:600; font-size:0.95rem; }
      .vp-card-meta { font-size:0.8rem; color:var(--crow-text-muted); }
      .vp-card-actions { display:flex; gap:0.5rem; margin-top:0.5rem; flex-wrap:wrap; }
      .vp-badge { font-size:0.65rem; padding:0.1rem 0.4rem; border-radius:3px; background:var(--crow-accent); color:#fff; font-weight:600; margin-left:0.4rem; }
      .vp-form { border:1px solid var(--crow-border); border-radius:8px; padding:1rem; margin-top:0.75rem; background:var(--crow-surface); }
      .vp-field { margin-bottom:0.75rem; }
      .vp-label { display:block; font-size:0.8rem; color:var(--crow-text-muted); margin-bottom:4px; }
      .vp-input { width:100%; padding:0.5rem; background:var(--crow-bg-deep,#111); border:1px solid var(--crow-border); border-radius:4px; color:var(--crow-text); font-size:0.85rem; box-sizing:border-box; }
      .vp-input-mono { font-family:'JetBrains Mono',monospace; }
      .vp-mode-section { padding:0.5rem; border:1px dashed var(--crow-border); border-radius:4px; margin-bottom:0.75rem; }
      .vp-mode-section.disabled { opacity:0.4; }
    </style>`;

    for (const p of profiles) {
      const isDefault = !!p.isDefault;
      const target = p.provider_id
        ? `pointer: ${p.provider_id}/${p.model_id || "first"}`
        : `${p.baseUrl || "—"} · ${p.model || "—"}`;
      html += `<div class="vp-card${isDefault ? " default" : ""}" data-profile-id="${escapeHtml(p.id)}">
        <div class="vp-card-header">
          <div>
            <div class="vp-card-name">${escapeHtml(p.name)}${isDefault ? '<span class="vp-badge">Default</span>' : ""}</div>
            <div class="vp-card-meta">${escapeHtml(target)}</div>
          </div>
        </div>
        <div class="vp-card-actions">
          ${isDefault ? "" : `<button class="btn btn-secondary btn-sm" onclick="setDefaultVision('${escapeHtml(p.id)}',this)">Make default</button>`}
          <button class="btn btn-secondary btn-sm" onclick="editVisionProfile('${escapeHtml(p.id)}')">Edit</button>
          <button class="btn btn-secondary btn-sm" onclick="testVisionProfile('${escapeHtml(p.id)}',this)">Test</button>
          <button class="btn btn-secondary btn-sm" style="color:var(--crow-error)" onclick="deleteVisionProfile('${escapeHtml(p.id)}',this)">Delete</button>
        </div>
      </div>`;
    }

    html += `
      <button class="btn btn-primary btn-sm" id="add-vp-btn" onclick="document.getElementById('vp-form').style.display='block';this.style.display='none'">Add vision profile</button>
      <div class="vp-form" id="vp-form" style="display:none">
        <input type="hidden" id="vpf-id" value="">
        <div class="vp-field">
          <label class="vp-label">Profile name</label>
          <input type="text" id="vpf-name" placeholder="e.g. Grackle vision" class="vp-input">
        </div>

        <div class="vp-field">
          <label class="vp-label">Resolution mode</label>
          <label style="margin-right:1rem"><input type="radio" name="vpf-mode" value="pointer" onchange="vpModeChange()" checked> Use models.json provider</label>
          <label><input type="radio" name="vpf-mode" value="direct" onchange="vpModeChange()"> Configure manually</label>
        </div>

        <div class="vp-mode-section" id="vpf-pointer-section">
          <div class="vp-field">
            <label class="vp-label">Provider (from models.json)</label>
            <select id="vpf-provider-id" class="vp-input" onchange="vpUpdateModelList()">
              <option value="">(select…)</option>
              ${providerOptions}
            </select>
          </div>
          <div class="vp-field">
            <label class="vp-label">Model</label>
            <select id="vpf-model-id" class="vp-input">
              <option value="">(first model in provider)</option>
            </select>
          </div>
        </div>

        <div class="vp-mode-section disabled" id="vpf-direct-section">
          <div class="vp-field">
            <label class="vp-label">Base URL</label>
            <input type="text" id="vpf-url" placeholder="e.g. http://100.121.254.89:9102/v1" class="vp-input vp-input-mono">
          </div>
          <div class="vp-field">
            <label class="vp-label">API key (optional)</label>
            <input type="password" id="vpf-key" placeholder="Leave blank to keep existing" autocomplete="off" class="vp-input vp-input-mono">
          </div>
          <div class="vp-field">
            <label class="vp-label">Model</label>
            <input type="text" id="vpf-model" placeholder="e.g. qwen3-vl-8b-instruct-fp8" class="vp-input vp-input-mono">
          </div>
        </div>

        <div class="vp-field">
          <label style="display:flex;align-items:center;gap:6px;font-size:0.85rem;cursor:pointer">
            <input type="checkbox" id="vpf-default">
            Make this the default vision profile
          </label>
        </div>
        <div style="display:flex;gap:0.5rem">
          <button class="btn btn-primary btn-sm" onclick="saveVisionProfile()">Save</button>
          <button class="btn btn-secondary btn-sm" onclick="cancelVpForm()">Cancel</button>
        </div>
        <div id="vpf-status" style="font-size:0.85rem;margin-top:0.5rem"></div>
      </div>

      <script>
      var _visionProfileData = ${JSON.stringify(profiles.map(p => ({ ...p, apiKey: undefined })))};
      var _providerModels = ${providerModels};

      function vpModeChange() {
        var mode = document.querySelector('input[name="vpf-mode"]:checked').value;
        document.getElementById('vpf-pointer-section').classList.toggle('disabled', mode !== 'pointer');
        document.getElementById('vpf-direct-section').classList.toggle('disabled', mode !== 'direct');
      }
      function vpUpdateModelList() {
        var pid = document.getElementById('vpf-provider-id').value;
        var sel = document.getElementById('vpf-model-id');
        while (sel.firstChild) sel.removeChild(sel.firstChild);
        var ph = document.createElement('option'); ph.value = ''; ph.textContent = '(first model in provider)'; sel.appendChild(ph);
        (_providerModels[pid] || []).forEach(function(m){
          var opt = document.createElement('option'); opt.value = m; opt.textContent = m; sel.appendChild(opt);
        });
      }

      function editVisionProfile(id) {
        var p = _visionProfileData.find(function(x){return x.id===id});
        if (!p) return;
        document.getElementById('vpf-id').value = p.id;
        document.getElementById('vpf-name').value = p.name;
        var mode = p.provider_id ? 'pointer' : 'direct';
        document.querySelector('input[name="vpf-mode"][value="'+mode+'"]').checked = true;
        vpModeChange();
        if (mode === 'pointer') {
          document.getElementById('vpf-provider-id').value = p.provider_id || '';
          vpUpdateModelList();
          document.getElementById('vpf-model-id').value = p.model_id || '';
        } else {
          document.getElementById('vpf-url').value = p.baseUrl || '';
          document.getElementById('vpf-key').value = '';
          document.getElementById('vpf-model').value = p.model || '';
        }
        document.getElementById('vpf-default').checked = !!p.isDefault;
        document.getElementById('vp-form').style.display = 'block';
        document.getElementById('add-vp-btn').style.display = 'none';
      }

      function cancelVpForm() {
        document.getElementById('vp-form').style.display = 'none';
        document.getElementById('add-vp-btn').style.display = '';
        ['vpf-id','vpf-name','vpf-url','vpf-key','vpf-model'].forEach(function(f){ document.getElementById(f).value = ''; });
        document.getElementById('vpf-provider-id').value = '';
        var sel = document.getElementById('vpf-model-id');
        while (sel.firstChild) sel.removeChild(sel.firstChild);
        var ph = document.createElement('option'); ph.value = ''; ph.textContent = '(first model in provider)'; sel.appendChild(ph);
        document.getElementById('vpf-default').checked = false;
      }

      async function saveVisionProfile() {
        var params = new URLSearchParams();
        params.set('action','save_vision_profile');
        var id = document.getElementById('vpf-id').value;
        if (id) params.set('profile_id', id);
        params.set('profile_name', document.getElementById('vpf-name').value);
        var mode = document.querySelector('input[name="vpf-mode"]:checked').value;
        params.set('profile_mode', mode);
        if (mode === 'pointer') {
          params.set('provider_id', document.getElementById('vpf-provider-id').value);
          params.set('model_id', document.getElementById('vpf-model-id').value);
        } else {
          params.set('profile_base_url', document.getElementById('vpf-url').value);
          var key = document.getElementById('vpf-key').value;
          if (key) params.set('profile_api_key', key);
          params.set('profile_model', document.getElementById('vpf-model').value);
        }
        if (document.getElementById('vpf-default').checked) params.set('profile_is_default', '1');
        var el = document.getElementById('vpf-status');
        try {
          var res = await fetch('/dashboard/settings', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:params.toString() });
          var data = await res.json();
          el.style.color = data.ok ? 'var(--crow-success)' : 'var(--crow-error)';
          el.textContent = data.ok ? 'Saved' : (data.error || 'Save failed');
          if (data.ok) setTimeout(function(){ location.reload(); }, 400);
        } catch(e) { el.style.color='var(--crow-error)'; el.textContent='Save failed: '+e.message; }
      }

      async function deleteVisionProfile(id, btn) {
        if (!confirm('Delete this vision profile?')) return;
        btn.disabled = true;
        var params = new URLSearchParams();
        params.set('action','delete_vision_profile');
        params.set('profile_id', id);
        try {
          await fetch('/dashboard/settings', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:params.toString() });
          location.reload();
        } catch(e) { btn.disabled = false; }
      }

      async function setDefaultVision(id, btn) {
        btn.disabled = true;
        var params = new URLSearchParams();
        params.set('action','set_default_vision_profile');
        params.set('profile_id', id);
        try {
          await fetch('/dashboard/settings', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:params.toString() });
          location.reload();
        } catch(e) { btn.disabled = false; }
      }

      async function testVisionProfile(id, btn) {
        btn.disabled = true;
        var orig = btn.textContent;
        btn.textContent = 'Warming up model — first test can take 30s…';
        var params = new URLSearchParams();
        params.set('action','test_vision_profile');
        params.set('profile_id', id);
        try {
          var res = await fetch('/dashboard/settings', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:params.toString() });
          var data = await res.json();
          btn.textContent = data.ok ? ('OK: ' + (data.description||'').slice(0,40)) : (data.error || 'Failed').slice(0,60);
          btn.style.color = data.ok ? 'var(--crow-success)' : 'var(--crow-error)';
          setTimeout(function(){ btn.textContent=orig; btn.style.color=''; btn.disabled=false; }, 6000);
        } catch(e) { btn.textContent='Error'; btn.disabled=false; }
      }
      <\/script>
      <p style="color:var(--crow-text-muted);font-size:0.8rem;margin-top:0.75rem">
        Vision profiles feed photo capture (meta-glasses), bot media analysis, and
        Phase 5 photo library captions. Pointer mode keeps the profile in sync with
        <code>models.json</code>; manual mode pins an explicit endpoint.
        New profiles default to <strong>local scope</strong> because vLLM endpoints are
        typically instance-specific — promote to "All instances" via the toggle above
        only if the URL is shared.
      </p>`;

    return html;
  },

  async handleAction({ req, res, db, action }) {
    if (action === "save_vision_profile") {
      const {
        profile_id, profile_name, profile_mode,
        provider_id, model_id,
        profile_base_url, profile_api_key, profile_model,
        profile_is_default,
      } = req.body;
      if (!profile_name) { res.json({ ok: false, error: "Name is required" }); return true; }

      const profiles = await loadProfiles(db);
      const makeDefault = profile_is_default === "1" || profile_is_default === "true";
      const scope = await resolveEffectiveScope(db);

      const build = (existing) => {
        const p = existing ? { ...existing } : {};
        p.name = profile_name;
        if (profile_mode === "pointer") {
          p.provider_id = (provider_id || "").trim() || undefined;
          p.model_id = (model_id || "").trim() || undefined;
          delete p.baseUrl; delete p.apiKey; delete p.model;
          if (!p.provider_id) throw new Error("provider_id required in pointer mode");
        } else {
          p.baseUrl = (profile_base_url || "").trim();
          if (profile_api_key) p.apiKey = profile_api_key;
          p.model = (profile_model || "").trim();
          delete p.provider_id; delete p.model_id;
          if (!p.baseUrl || !p.model) throw new Error("baseUrl and model required in direct mode");
        }
        return p;
      };

      try {
        if (profile_id) {
          const idx = profiles.findIndex(p => p.id === profile_id);
          if (idx === -1) { res.json({ ok: false, error: "Profile not found" }); return true; }
          profiles[idx] = build(profiles[idx]);
          profiles[idx].id = profile_id;
          if (makeDefault) { profiles.forEach(p => { p.isDefault = false; }); profiles[idx].isDefault = true; }
        } else {
          const { randomBytes } = await import("node:crypto");
          const p = build(null);
          p.id = randomBytes(4).toString("hex");
          p.isDefault = makeDefault || profiles.length === 0;
          if (p.isDefault) profiles.forEach(x => { x.isDefault = false; });
          profiles.push(p);
        }
      } catch (err) {
        res.json({ ok: false, error: err.message });
        return true;
      }

      await saveProfiles(db, profiles, { scope });
      res.json({ ok: true, scope });
      return true;
    }

    if (action === "delete_vision_profile") {
      const { profile_id } = req.body;
      if (!profile_id) { res.json({ ok: false, error: "profile_id required" }); return true; }
      const profiles = await loadProfiles(db);
      let next = profiles.filter(p => p.id !== profile_id);
      if (next.length && !next.some(p => p.isDefault)) next[0].isDefault = true;
      const scope = await resolveEffectiveScope(db);
      await saveProfiles(db, next, { scope });
      res.json({ ok: true });
      return true;
    }

    if (action === "set_default_vision_profile") {
      const { profile_id } = req.body;
      if (!profile_id) { res.json({ ok: false, error: "profile_id required" }); return true; }
      const profiles = await loadProfiles(db);
      const target = profiles.find(p => p.id === profile_id);
      if (!target) { res.json({ ok: false, error: "Profile not found" }); return true; }
      profiles.forEach(p => { p.isDefault = false; });
      target.isDefault = true;
      const scope = await resolveEffectiveScope(db);
      await saveProfiles(db, profiles, { scope });
      res.json({ ok: true });
      return true;
    }

    if (action === "test_vision_profile") {
      const { profile_id } = req.body;
      if (!profile_id) { res.json({ ok: false, error: "profile_id required" }); return true; }
      if (_testInflight.has(profile_id)) {
        res.json({ ok: false, error: "Test already running for this profile" });
        return true;
      }
      _testInflight.add(profile_id);
      try {
        const profiles = await loadProfiles(db);
        const profile = profiles.find(p => p.id === profile_id);
        if (!profile) { res.json({ ok: false, error: "Profile not found" }); return true; }
        let providerConfig;
        try { providerConfig = await resolveProfileToConfig(profile, db); }
        catch (err) { res.json({ ok: false, error: `Resolve failed: ${err.message}` }); return true; }
        if (!providerConfig) { res.json({ ok: false, error: "Profile incomplete" }); return true; }

        let bytes;
        const fixturePath = resolvePath(
          dirname(fileURLToPath(import.meta.url)),
          "../../../../..",
          "bundles/meta-glasses/assets/test-fixture.jpg",
        );
        try { bytes = readFileSync(fixturePath); }
        catch {
          bytes = Buffer.from("/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAoHBwkHBgoJCAkLCwoMDxkQDw4ODx4WFxIZJCAmJSMgIyIoLTkwKCo2KyIjMkQyNjs9QEBAJjBGS0U+Sjk/QD3/2wBDAQsLCw8NDx0QEB09KSMpPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT3/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKpgB//Z", "base64");
        }

        try {
          const { description } = await analyzeImage({
            providerConfig,
            prompt: "Describe this image in one short sentence.",
            imageBytes: bytes,
            mime: "image/jpeg",
            timeoutMs: 30_000,
            maxTokens: 100,
          });
          res.json({ ok: true, description });
        } catch (err) {
          res.json({ ok: false, error: err.message });
        }
      } finally {
        _testInflight.delete(profile_id);
      }
      return true;
    }

    return false;
  },
};
