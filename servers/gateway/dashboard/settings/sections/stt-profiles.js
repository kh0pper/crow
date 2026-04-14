/**
 * Settings Section: STT Profiles
 *
 * Platform-wide Speech-to-Text provider profiles (OpenAI Whisper, Groq,
 * Deepgram, whisper.cpp, faster-whisper). Parallel to tts-profiles.js.
 *
 * Registered with `hidden: true` in PR 2 — the section is deep-linkable but
 * omitted from the main menu until PR 3 lands the consumer (meta-glasses
 * bundle). PR 3 flips the flag to make it visible.
 */

import { escapeHtml } from "../../shared/components.js";
import { upsertSetting } from "../registry.js";
import { PROVIDER_INFO } from "../../../ai/stt/index.js";
import { renderScopeToggle, scopeToggleScript } from "../../shared/scope-toggle.js";

export default {
  id: "stt-profiles",
  group: "ai",
  hidden: false, // PR3 has landed — the meta-glasses bundle consumes stt_profiles.
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`,
  labelKey: "settings.section.sttProfiles",
  navOrder: 26,

  async getPreview({ settings }) {
    let profiles = [];
    try { profiles = JSON.parse(settings.stt_profiles || "[]"); } catch {}
    if (profiles.length === 0) return "Not configured";
    const active = profiles.find(p => p.isDefault) || profiles[0];
    const providerName = PROVIDER_INFO[active.provider]?.name || active.provider;
    return `${active.name} (${providerName})`;
  },

  async render({ db }) {
    const result = await db.execute({
      sql: "SELECT value FROM dashboard_settings WHERE key = 'stt_profiles'",
      args: [],
    });
    let profiles = [];
    try { profiles = JSON.parse(result.rows[0]?.value || "[]"); } catch {}

    const providerOptions = Object.entries(PROVIDER_INFO)
      .map(([id, info]) => `<option value="${id}">${escapeHtml(info.name)}${info.supportsStreaming ? " (streaming)" : ""}</option>`)
      .join("");

    const scopeToggle = await renderScopeToggle(db, "stt_profiles");
    let html = scopeToggle + scopeToggleScript() + `<style>
      .sttp-card { border:1px solid var(--crow-border); border-radius:8px; padding:0.75rem 1rem; margin-bottom:0.5rem; background:var(--crow-surface); }
      .sttp-card.default { border-color:var(--crow-accent); }
      .sttp-card-name { font-weight:600; font-size:0.95rem; }
      .sttp-card-meta { font-size:0.8rem; color:var(--crow-text-muted); }
      .sttp-card-actions { display:flex; gap:0.5rem; margin-top:0.5rem; flex-wrap:wrap; }
      .sttp-badge { font-size:0.65rem; padding:0.1rem 0.4rem; border-radius:3px; background:var(--crow-accent); color:#fff; font-weight:600; margin-left:0.4rem; }
      .sttp-stream-badge { font-size:0.6rem; padding:0.05rem 0.3rem; border-radius:3px; background:var(--crow-success); color:#fff; font-weight:600; margin-left:0.3rem; }
      .sttp-form { border:1px solid var(--crow-border); border-radius:8px; padding:1rem; margin-top:0.75rem; background:var(--crow-surface); }
      .sttp-field { margin-bottom:0.75rem; }
      .sttp-label { display:block; font-size:0.8rem; color:var(--crow-text-muted); margin-bottom:4px; }
      .sttp-input { width:100%; padding:0.5rem; background:var(--crow-bg-deep,#111); border:1px solid var(--crow-border); border-radius:4px; color:var(--crow-text); font-size:0.85rem; box-sizing:border-box; }
      .sttp-input-mono { font-family:'JetBrains Mono',monospace; }
    </style>`;

    for (const p of profiles) {
      const maskedKey = p.apiKey ? "••••" + p.apiKey.slice(-4) : "—";
      const info = PROVIDER_INFO[p.provider];
      const providerName = info?.name || p.provider;
      const streamingLabel = info?.supportsStreaming ? '<span class="sttp-stream-badge">streaming</span>' : "";
      const isDefault = !!p.isDefault;
      html += `<div class="sttp-card${isDefault ? " default" : ""}" data-profile-id="${escapeHtml(p.id)}">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:0.5rem">
          <div>
            <div class="sttp-card-name">${escapeHtml(p.name)}${isDefault ? '<span class="sttp-badge">Default</span>' : ""}${streamingLabel}</div>
            <div class="sttp-card-meta">${escapeHtml(providerName)} &middot; model: ${escapeHtml(p.defaultModel || "—")} &middot; key: ${maskedKey}</div>
          </div>
        </div>
        <div class="sttp-card-actions">
          ${isDefault ? "" : `<button class="btn btn-secondary btn-sm" onclick="setDefaultStt('${escapeHtml(p.id)}',this)">Make default</button>`}
          <button class="btn btn-secondary btn-sm" onclick="editSttProfile('${escapeHtml(p.id)}')">Edit</button>
          <button class="btn btn-secondary btn-sm" onclick="testSttProfile('${escapeHtml(p.id)}',this)">Test</button>
          <button class="btn btn-secondary btn-sm" style="color:var(--crow-error)" onclick="deleteSttProfile('${escapeHtml(p.id)}',this)">Delete</button>
        </div>
      </div>`;
    }

    html += `
      <button class="btn btn-primary btn-sm" id="add-stt-btn" onclick="document.getElementById('stt-form').style.display='block';this.style.display='none'">Add STT profile</button>
      <div class="sttp-form" id="stt-form" style="display:none">
        <input type="hidden" id="sttf-id" value="">
        <div class="sttp-field">
          <label class="sttp-label">Profile name</label>
          <input type="text" id="sttf-name" placeholder="e.g. Whisper (local)" class="sttp-input">
        </div>
        <div class="sttp-field">
          <label class="sttp-label">Provider</label>
          <select id="sttf-provider" class="sttp-input">${providerOptions}</select>
        </div>
        <div class="sttp-field">
          <label class="sttp-label">API key</label>
          <input type="password" id="sttf-key" placeholder="Leave blank to keep existing" autocomplete="off" class="sttp-input sttp-input-mono">
        </div>
        <div class="sttp-field">
          <label class="sttp-label">Base URL (optional — for self-hosted / region endpoint)</label>
          <input type="text" id="sttf-url" placeholder="e.g. http://grackle:9000 or https://api.groq.com/openai/v1" class="sttp-input sttp-input-mono">
        </div>
        <div class="sttp-field">
          <label class="sttp-label">Default model</label>
          <input type="text" id="sttf-model" placeholder="e.g. whisper-1, nova-3, Systran/faster-whisper-large-v3" class="sttp-input sttp-input-mono">
        </div>
        <div class="sttp-field">
          <label style="display:flex;align-items:center;gap:6px;font-size:0.85rem;cursor:pointer">
            <input type="checkbox" id="sttf-default">
            Make this the default STT profile
          </label>
        </div>
        <div style="display:flex;gap:0.5rem">
          <button class="btn btn-primary btn-sm" onclick="saveSttProfile()">Save</button>
          <button class="btn btn-secondary btn-sm" onclick="cancelSttForm()">Cancel</button>
        </div>
        <div id="sttf-status" style="font-size:0.85rem;margin-top:0.5rem"></div>
      </div>

      <script>
      var _sttProfileData = ${JSON.stringify(profiles.map(p => ({ ...p, apiKey: undefined })))};

      function editSttProfile(id) {
        var p = _sttProfileData.find(function(x){return x.id===id});
        if (!p) return;
        document.getElementById('sttf-id').value = p.id;
        document.getElementById('sttf-name').value = p.name;
        document.getElementById('sttf-provider').value = p.provider;
        document.getElementById('sttf-key').value = '';
        document.getElementById('sttf-url').value = p.baseUrl || '';
        document.getElementById('sttf-model').value = p.defaultModel || '';
        document.getElementById('sttf-default').checked = !!p.isDefault;
        document.getElementById('stt-form').style.display = 'block';
        document.getElementById('add-stt-btn').style.display = 'none';
      }

      function cancelSttForm() {
        document.getElementById('stt-form').style.display = 'none';
        document.getElementById('add-stt-btn').style.display = '';
        ['sttf-id','sttf-name','sttf-key','sttf-url','sttf-model'].forEach(function(f){ document.getElementById(f).value = ''; });
        document.getElementById('sttf-default').checked = false;
      }

      async function saveSttProfile() {
        var params = new URLSearchParams();
        params.set('action','save_stt_profile');
        var id = document.getElementById('sttf-id').value;
        if (id) params.set('profile_id', id);
        params.set('profile_name', document.getElementById('sttf-name').value);
        params.set('profile_provider', document.getElementById('sttf-provider').value);
        var key = document.getElementById('sttf-key').value;
        if (key) params.set('profile_api_key', key);
        params.set('profile_base_url', document.getElementById('sttf-url').value);
        params.set('profile_default_model', document.getElementById('sttf-model').value);
        if (document.getElementById('sttf-default').checked) params.set('profile_is_default', '1');
        var el = document.getElementById('sttf-status');
        try {
          var res = await fetch('/dashboard/settings', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:params.toString() });
          var data = await res.json();
          el.style.color = data.ok ? 'var(--crow-success)' : 'var(--crow-error)';
          el.textContent = data.ok ? 'Saved' : (data.error || 'Save failed');
          if (data.ok) setTimeout(function(){ location.reload(); }, 400);
        } catch(e) { el.style.color='var(--crow-error)'; el.textContent='Save failed: '+e.message; }
      }

      async function deleteSttProfile(id, btn) {
        if (!confirm('Delete this STT profile?')) return;
        btn.disabled = true;
        var params = new URLSearchParams();
        params.set('action','delete_stt_profile');
        params.set('profile_id', id);
        try {
          await fetch('/dashboard/settings', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:params.toString() });
          location.reload();
        } catch(e) { btn.disabled = false; }
      }

      async function setDefaultStt(id, btn) {
        btn.disabled = true;
        var params = new URLSearchParams();
        params.set('action','set_default_stt_profile');
        params.set('profile_id', id);
        try {
          await fetch('/dashboard/settings', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:params.toString() });
          location.reload();
        } catch(e) { btn.disabled = false; }
      }

      async function testSttProfile(id, btn) {
        btn.disabled = true;
        var orig = btn.textContent;
        btn.textContent = 'Testing…';
        var params = new URLSearchParams();
        params.set('action','test_stt_profile');
        params.set('profile_id', id);
        try {
          var res = await fetch('/dashboard/settings', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:params.toString() });
          var data = await res.json();
          btn.textContent = data.ok ? 'Init OK' : (data.error || 'Failed').slice(0,40);
          btn.style.color = data.ok ? 'var(--crow-success)' : 'var(--crow-error)';
          setTimeout(function(){ btn.textContent=orig; btn.style.color=''; btn.disabled=false; }, 3000);
        } catch(e) { btn.textContent='Error'; btn.disabled=false; }
      }
      <\/script>
      <p style="color:var(--crow-text-muted);font-size:0.8rem;margin-top:0.75rem">
        STT profiles configure how speech becomes text. Bundles that need transcription
        (e.g. Meta Glasses) share these profiles. The <strong>default</strong> profile
        is used when a bundle doesn't pick one explicitly. For end-to-end testing, POST
        audio to <code>/api/stt/debug</code> with <code>profile_id</code>.
      </p>`;

    return html;
  },

  async handleAction({ req, res, db, action }) {
    if (action === "save_stt_profile") {
      const {
        profile_id, profile_name, profile_provider,
        profile_api_key, profile_base_url, profile_default_model,
        profile_is_default,
      } = req.body;
      if (!profile_name || !profile_provider) {
        res.json({ ok: false, error: "Name and provider are required" });
        return true;
      }
      if (!PROVIDER_INFO[profile_provider]) {
        res.json({ ok: false, error: `Unknown provider: ${profile_provider}` });
        return true;
      }

      const existing = await db.execute({
        sql: "SELECT value FROM dashboard_settings WHERE key = 'stt_profiles'",
        args: [],
      });
      let profiles = [];
      try { profiles = JSON.parse(existing.rows[0]?.value || "[]"); } catch {}

      const makeDefault = profile_is_default === "1" || profile_is_default === "true";

      if (profile_id) {
        const idx = profiles.findIndex(p => p.id === profile_id);
        if (idx === -1) { res.json({ ok: false, error: "Profile not found" }); return true; }
        profiles[idx].name = profile_name;
        profiles[idx].provider = profile_provider;
        if (profile_api_key) profiles[idx].apiKey = profile_api_key;
        profiles[idx].baseUrl = (profile_base_url || "").trim();
        profiles[idx].defaultModel = (profile_default_model || "").trim();
        if (makeDefault) {
          profiles.forEach(p => { p.isDefault = false; });
          profiles[idx].isDefault = true;
        }
      } else {
        const { randomBytes } = await import("node:crypto");
        const id = randomBytes(4).toString("hex");
        const isDefault = makeDefault || profiles.length === 0;
        if (isDefault) profiles.forEach(p => { p.isDefault = false; });
        profiles.push({
          id,
          name: profile_name,
          provider: profile_provider,
          apiKey: profile_api_key || "",
          baseUrl: (profile_base_url || "").trim(),
          defaultModel: (profile_default_model || "").trim(),
          isDefault,
        });
      }

      await upsertSetting(db, "stt_profiles", JSON.stringify(profiles));
      res.json({ ok: true });
      return true;
    }

    if (action === "delete_stt_profile") {
      const { profile_id } = req.body;
      if (!profile_id) { res.json({ ok: false, error: "profile_id required" }); return true; }
      const existing = await db.execute({
        sql: "SELECT value FROM dashboard_settings WHERE key = 'stt_profiles'",
        args: [],
      });
      let profiles = [];
      try { profiles = JSON.parse(existing.rows[0]?.value || "[]"); } catch {}
      const before = profiles.length;
      profiles = profiles.filter(p => p.id !== profile_id);
      if (profiles.length && !profiles.some(p => p.isDefault)) {
        profiles[0].isDefault = true;
      }
      await upsertSetting(db, "stt_profiles", JSON.stringify(profiles));
      res.json({ ok: true, removed: before - profiles.length });
      return true;
    }

    if (action === "set_default_stt_profile") {
      const { profile_id } = req.body;
      if (!profile_id) { res.json({ ok: false, error: "profile_id required" }); return true; }
      const existing = await db.execute({
        sql: "SELECT value FROM dashboard_settings WHERE key = 'stt_profiles'",
        args: [],
      });
      let profiles = [];
      try { profiles = JSON.parse(existing.rows[0]?.value || "[]"); } catch {}
      const target = profiles.find(p => p.id === profile_id);
      if (!target) { res.json({ ok: false, error: "Profile not found" }); return true; }
      profiles.forEach(p => { p.isDefault = false; });
      target.isDefault = true;
      await upsertSetting(db, "stt_profiles", JSON.stringify(profiles));
      res.json({ ok: true });
      return true;
    }

    if (action === "test_stt_profile") {
      const { profile_id } = req.body;
      if (!profile_id) { res.json({ ok: false, error: "profile_id required" }); return true; }
      const existing = await db.execute({
        sql: "SELECT value FROM dashboard_settings WHERE key = 'stt_profiles'",
        args: [],
      });
      let profiles = [];
      try { profiles = JSON.parse(existing.rows[0]?.value || "[]"); } catch {}
      const profile = profiles.find(p => p.id === profile_id);
      if (!profile) { res.json({ ok: false, error: "Profile not found" }); return true; }
      try {
        const { testSttProfile } = await import("../../../ai/stt/index.js");
        const result = await testSttProfile(profile);
        res.json(result);
      } catch (err) {
        res.json({ ok: false, error: err.message });
      }
      return true;
    }

    return false;
  },
};
