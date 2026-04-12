/**
 * Settings Section: TTS Profiles
 *
 * Platform-wide TTS provider profiles (OpenAI, ElevenLabs, Azure, Edge, Piper,
 * Kokoro). Parallel to ai-profiles.js. Each profile stores its own provider,
 * endpoint, key, and default voice. The profile marked `isDefault: true` is
 * used by bundles that don't pick one explicitly.
 *
 * Legacy `dashboard_settings.tts_voice` is kept as a compatibility mirror
 * so bundles/media (which reads it directly) keeps working. Whenever a
 * profile is created/edited/selected-as-default, we write its default voice
 * to `tts_voice`. On "last profile deleted" we leave the mirror stale (see
 * the third-pass review decision in the plan).
 */

import { escapeHtml } from "../../shared/components.js";
import { upsertSetting } from "../registry.js";
import { PROVIDER_INFO } from "../../../ai/tts/index.js";

/** Write a profile's voice into the compat mirror. */
async function mirrorVoice(db, voice) {
  if (!voice) return;
  await upsertSetting(db, "tts_voice", String(voice));
}

/** Read the active default profile (or first) and mirror its voice. */
async function refreshMirror(db) {
  const res = await db.execute({
    sql: "SELECT value FROM dashboard_settings WHERE key = 'tts_profiles'",
    args: [],
  });
  let profiles = [];
  try { profiles = JSON.parse(res.rows[0]?.value || "[]"); } catch {}
  const active = profiles.find(p => p.isDefault) || profiles[0];
  if (active?.defaultVoice) {
    await mirrorVoice(db, active.defaultVoice);
  }
}

export default {
  id: "tts-profiles",
  group: "ai",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>`,
  labelKey: "settings.section.ttsProfiles",
  navOrder: 25,

  async getPreview({ settings }) {
    let profiles = [];
    try { profiles = JSON.parse(settings.tts_profiles || "[]"); } catch {}
    if (profiles.length === 0) return "Not configured";
    const active = profiles.find(p => p.isDefault) || profiles[0];
    const providerName = PROVIDER_INFO[active.provider]?.name || active.provider;
    return `${active.name} (${providerName})`;
  },

  async render({ db }) {
    const result = await db.execute({
      sql: "SELECT value FROM dashboard_settings WHERE key = 'tts_profiles'",
      args: [],
    });
    let profiles = [];
    try { profiles = JSON.parse(result.rows[0]?.value || "[]"); } catch {}

    const providerOptions = Object.entries(PROVIDER_INFO)
      .map(([id, info]) => `<option value="${id}">${escapeHtml(info.name)}</option>`)
      .join("");

    let html = `<style>
      .ttsp-card { border:1px solid var(--crow-border); border-radius:8px; padding:0.75rem 1rem; margin-bottom:0.5rem; background:var(--crow-surface); }
      .ttsp-card.default { border-color:var(--crow-accent); }
      .ttsp-card-header { display:flex; align-items:center; justify-content:space-between; gap:0.5rem; }
      .ttsp-card-name { font-weight:600; font-size:0.95rem; }
      .ttsp-card-meta { font-size:0.8rem; color:var(--crow-text-muted); }
      .ttsp-card-actions { display:flex; gap:0.5rem; margin-top:0.5rem; flex-wrap:wrap; }
      .ttsp-badge { font-size:0.65rem; padding:0.1rem 0.4rem; border-radius:3px; background:var(--crow-accent); color:#fff; font-weight:600; margin-left:0.4rem; }
      .ttsp-form { border:1px solid var(--crow-border); border-radius:8px; padding:1rem; margin-top:0.75rem; background:var(--crow-surface); }
      .ttsp-field { margin-bottom:0.75rem; }
      .ttsp-label { display:block; font-size:0.8rem; color:var(--crow-text-muted); margin-bottom:4px; }
      .ttsp-input { width:100%; padding:0.5rem; background:var(--crow-bg-deep,#111); border:1px solid var(--crow-border); border-radius:4px; color:var(--crow-text); font-size:0.85rem; box-sizing:border-box; }
      .ttsp-input-mono { font-family:'JetBrains Mono',monospace; }
    </style>`;

    for (const p of profiles) {
      const maskedKey = p.apiKey ? "••••" + p.apiKey.slice(-4) : "—";
      const providerName = PROVIDER_INFO[p.provider]?.name || p.provider;
      const isDefault = !!p.isDefault;
      html += `<div class="ttsp-card${isDefault ? " default" : ""}" data-profile-id="${escapeHtml(p.id)}">
        <div class="ttsp-card-header">
          <div>
            <div class="ttsp-card-name">${escapeHtml(p.name)}${isDefault ? '<span class="ttsp-badge">Default</span>' : ""}</div>
            <div class="ttsp-card-meta">${escapeHtml(providerName)} &middot; voice: ${escapeHtml(p.defaultVoice || "—")} &middot; key: ${maskedKey}</div>
          </div>
        </div>
        <div class="ttsp-card-actions">
          ${isDefault ? "" : `<button class="btn btn-secondary btn-sm" onclick="setDefaultTts('${escapeHtml(p.id)}',this)">Make default</button>`}
          <button class="btn btn-secondary btn-sm" onclick="editTtsProfile('${escapeHtml(p.id)}')">Edit</button>
          <button class="btn btn-secondary btn-sm" onclick="testTtsProfile('${escapeHtml(p.id)}',this)">Test</button>
          <button class="btn btn-secondary btn-sm" style="color:var(--crow-error)" onclick="deleteTtsProfile('${escapeHtml(p.id)}',this)">Delete</button>
        </div>
      </div>`;
    }

    html += `
      <button class="btn btn-primary btn-sm" id="add-tts-btn" onclick="document.getElementById('tts-form').style.display='block';this.style.display='none'">Add TTS profile</button>
      <div class="ttsp-form" id="tts-form" style="display:none">
        <input type="hidden" id="ttsf-id" value="">
        <div class="ttsp-field">
          <label class="ttsp-label">Profile name</label>
          <input type="text" id="ttsf-name" placeholder="e.g. Cloud voice" class="ttsp-input">
        </div>
        <div class="ttsp-field">
          <label class="ttsp-label">Provider</label>
          <select id="ttsf-provider" class="ttsp-input">${providerOptions}</select>
        </div>
        <div class="ttsp-field">
          <label class="ttsp-label">API key</label>
          <input type="password" id="ttsf-key" placeholder="Leave blank to keep existing" autocomplete="off" class="ttsp-input ttsp-input-mono">
        </div>
        <div class="ttsp-field">
          <label class="ttsp-label">Base URL (optional — for self-hosted / region endpoint)</label>
          <input type="text" id="ttsf-url" placeholder="e.g. http://grackle:5000 or https://eastus.tts.speech.microsoft.com" class="ttsp-input ttsp-input-mono">
        </div>
        <div class="ttsp-field">
          <label class="ttsp-label">Default voice</label>
          <input type="text" id="ttsf-voice" placeholder="e.g. en-US-JennyNeural, alloy, af_bella" class="ttsp-input ttsp-input-mono">
        </div>
        <div class="ttsp-field">
          <label style="display:flex;align-items:center;gap:6px;font-size:0.85rem;cursor:pointer">
            <input type="checkbox" id="ttsf-default">
            Make this the default TTS profile
          </label>
        </div>
        <div style="display:flex;gap:0.5rem">
          <button class="btn btn-primary btn-sm" onclick="saveTtsProfile()">Save</button>
          <button class="btn btn-secondary btn-sm" onclick="cancelTtsForm()">Cancel</button>
        </div>
        <div id="ttsf-status" style="font-size:0.85rem;margin-top:0.5rem"></div>
      </div>

      <script>
      var _ttsProfileData = ${JSON.stringify(profiles.map(p => ({ ...p, apiKey: undefined })))};

      function editTtsProfile(id) {
        var p = _ttsProfileData.find(function(x){return x.id===id});
        if (!p) return;
        document.getElementById('ttsf-id').value = p.id;
        document.getElementById('ttsf-name').value = p.name;
        document.getElementById('ttsf-provider').value = p.provider;
        document.getElementById('ttsf-key').value = '';
        document.getElementById('ttsf-url').value = p.baseUrl || '';
        document.getElementById('ttsf-voice').value = p.defaultVoice || '';
        document.getElementById('ttsf-default').checked = !!p.isDefault;
        document.getElementById('tts-form').style.display = 'block';
        document.getElementById('add-tts-btn').style.display = 'none';
      }

      function cancelTtsForm() {
        document.getElementById('tts-form').style.display = 'none';
        document.getElementById('add-tts-btn').style.display = '';
        ['ttsf-id','ttsf-name','ttsf-key','ttsf-url','ttsf-voice'].forEach(function(f){ document.getElementById(f).value = ''; });
        document.getElementById('ttsf-default').checked = false;
      }

      async function saveTtsProfile() {
        var params = new URLSearchParams();
        params.set('action','save_tts_profile');
        var id = document.getElementById('ttsf-id').value;
        if (id) params.set('profile_id', id);
        params.set('profile_name', document.getElementById('ttsf-name').value);
        params.set('profile_provider', document.getElementById('ttsf-provider').value);
        var key = document.getElementById('ttsf-key').value;
        if (key) params.set('profile_api_key', key);
        params.set('profile_base_url', document.getElementById('ttsf-url').value);
        params.set('profile_default_voice', document.getElementById('ttsf-voice').value);
        if (document.getElementById('ttsf-default').checked) params.set('profile_is_default', '1');
        var el = document.getElementById('ttsf-status');
        try {
          var res = await fetch('/dashboard/settings', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:params.toString() });
          var data = await res.json();
          el.style.color = data.ok ? 'var(--crow-success)' : 'var(--crow-error)';
          el.textContent = data.ok ? 'Saved' : (data.error || 'Save failed');
          if (data.ok) setTimeout(function(){ location.reload(); }, 400);
        } catch(e) { el.style.color='var(--crow-error)'; el.textContent='Save failed: '+e.message; }
      }

      async function deleteTtsProfile(id, btn) {
        if (!confirm('Delete this TTS profile?')) return;
        btn.disabled = true;
        var params = new URLSearchParams();
        params.set('action','delete_tts_profile');
        params.set('profile_id', id);
        try {
          await fetch('/dashboard/settings', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:params.toString() });
          location.reload();
        } catch(e) { btn.disabled = false; }
      }

      async function setDefaultTts(id, btn) {
        btn.disabled = true;
        var params = new URLSearchParams();
        params.set('action','set_default_tts_profile');
        params.set('profile_id', id);
        try {
          await fetch('/dashboard/settings', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:params.toString() });
          location.reload();
        } catch(e) { btn.disabled = false; }
      }

      async function testTtsProfile(id, btn) {
        btn.disabled = true;
        var orig = btn.textContent;
        btn.textContent = 'Testing…';
        var params = new URLSearchParams();
        params.set('action','test_tts_profile');
        params.set('profile_id', id);
        try {
          var res = await fetch('/dashboard/settings', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:params.toString() });
          var data = await res.json();
          btn.textContent = data.ok ? 'OK (' + (data.bytes||0) + ' B)' : (data.error || 'Failed').slice(0,40);
          btn.style.color = data.ok ? 'var(--crow-success)' : 'var(--crow-error)';
          setTimeout(function(){ btn.textContent=orig; btn.style.color=''; btn.disabled=false; }, 3000);
        } catch(e) { btn.textContent='Error'; btn.disabled=false; }
      }
      <\/script>
      <p style="color:var(--crow-text-muted);font-size:0.8rem;margin-top:0.75rem">
        TTS profiles configure how text becomes speech. Bundles like Companion and Meta Glasses
        share these profiles. The <strong>default</strong> profile is used when a bundle doesn't
        pick one explicitly.
      </p>`;

    return html;
  },

  async handleAction({ req, res, db, action }) {
    if (action === "save_tts_profile") {
      const {
        profile_id, profile_name, profile_provider,
        profile_api_key, profile_base_url, profile_default_voice,
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
        sql: "SELECT value FROM dashboard_settings WHERE key = 'tts_profiles'",
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
        profiles[idx].defaultVoice = (profile_default_voice || "").trim();
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
          defaultVoice: (profile_default_voice || "").trim(),
          isDefault,
        });
      }

      await upsertSetting(db, "tts_profiles", JSON.stringify(profiles));
      await refreshMirror(db);
      res.json({ ok: true });
      return true;
    }

    if (action === "delete_tts_profile") {
      const { profile_id } = req.body;
      if (!profile_id) { res.json({ ok: false, error: "profile_id required" }); return true; }
      const existing = await db.execute({
        sql: "SELECT value FROM dashboard_settings WHERE key = 'tts_profiles'",
        args: [],
      });
      let profiles = [];
      try { profiles = JSON.parse(existing.rows[0]?.value || "[]"); } catch {}
      const before = profiles.length;
      profiles = profiles.filter(p => p.id !== profile_id);
      // If we removed the default and any remain, promote the first.
      if (profiles.length && !profiles.some(p => p.isDefault)) {
        profiles[0].isDefault = true;
      }
      await upsertSetting(db, "tts_profiles", JSON.stringify(profiles));
      if (profiles.length > 0) await refreshMirror(db);
      // If profiles.length === 0, intentionally leave tts_voice stale (see plan).
      res.json({ ok: true, removed: before - profiles.length });
      return true;
    }

    if (action === "set_default_tts_profile") {
      const { profile_id } = req.body;
      if (!profile_id) { res.json({ ok: false, error: "profile_id required" }); return true; }
      const existing = await db.execute({
        sql: "SELECT value FROM dashboard_settings WHERE key = 'tts_profiles'",
        args: [],
      });
      let profiles = [];
      try { profiles = JSON.parse(existing.rows[0]?.value || "[]"); } catch {}
      const target = profiles.find(p => p.id === profile_id);
      if (!target) { res.json({ ok: false, error: "Profile not found" }); return true; }
      profiles.forEach(p => { p.isDefault = false; });
      target.isDefault = true;
      await upsertSetting(db, "tts_profiles", JSON.stringify(profiles));
      await refreshMirror(db);
      res.json({ ok: true });
      return true;
    }

    if (action === "test_tts_profile") {
      const { profile_id } = req.body;
      if (!profile_id) { res.json({ ok: false, error: "profile_id required" }); return true; }
      const existing = await db.execute({
        sql: "SELECT value FROM dashboard_settings WHERE key = 'tts_profiles'",
        args: [],
      });
      let profiles = [];
      try { profiles = JSON.parse(existing.rows[0]?.value || "[]"); } catch {}
      const profile = profiles.find(p => p.id === profile_id);
      if (!profile) { res.json({ ok: false, error: "Profile not found" }); return true; }
      try {
        const { testTtsProfile } = await import("../../../ai/tts/index.js");
        const result = await testTtsProfile(profile);
        res.json(result);
      } catch (err) {
        res.json({ ok: false, error: err.message });
      }
      return true;
    }

    return false;
  },
};
