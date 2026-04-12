/**
 * Companion Settings Section — three fieldsets, each with independent save:
 *   1. Persona       — COMPANION_PERSONA, COMPANION_CHARACTER_NAME, COMPANION_AVATAR
 *   2. AI Provider   — COMPANION_AI_PROFILE, COMPANION_AI_MODEL
 *   3. Household     — 4-slot profiles; each picks a tts_profile + voice within it
 *
 * Voice selection is now a two-level picker: first the platform-wide
 * `tts_profile` (from sections/tts-profiles.js), then a voice offered by
 * that profile's adapter. Legacy COMPANION_TTS_VOICE is read as fallback
 * for one release but no longer written by this form.
 *
 * The deprecated section id `companion-voice` remains available via the
 * dashboard's SECTION_ALIASES map so old deep-links keep resolving.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { execFileSync } from "child_process";

const BUNDLE_DIR = join(homedir(), ".crow", "bundles", "companion");

/* ---------- .env helpers ---------- */

function readBundleEnv() {
  const envPath = join(BUNDLE_DIR, ".env");
  if (!existsSync(envPath)) return {};
  const env = {};
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match) env[match[1]] = match[2];
  }
  return env;
}

function writeBundleEnv(env) {
  const envPath = join(BUNDLE_DIR, ".env");
  const lines = Object.entries(env)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${v}`);
  writeFileSync(envPath, lines.join("\n") + "\n");
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function recreateCompanion() {
  try {
    execFileSync("docker", ["compose", "up", "-d", "--no-build", "--force-recreate"], {
      cwd: BUNDLE_DIR,
      timeout: 60000,
      stdio: "pipe",
    });
  } catch { /* best effort */ }
}

/* ---------- DB reads ---------- */

async function readAiProfiles(db) {
  try {
    const res = await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = 'ai_profiles'", args: [] });
    return res.rows[0]?.value ? JSON.parse(res.rows[0].value) : [];
  } catch { return []; }
}

async function readTtsProfiles(db) {
  try {
    const res = await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = 'tts_profiles'", args: [] });
    return res.rows[0]?.value ? JSON.parse(res.rows[0].value) : [];
  } catch { return []; }
}

/* ---------- Household profile pack/unpack ---------- */

function getHouseholdProfiles() {
  const env = readBundleEnv();
  const profiles = [];
  for (let i = 1; i <= 4; i++) {
    const name = env[`COMPANION_PROFILE_${i}_NAME`];
    profiles.push({
      index: i,
      name: name || "",
      avatar: env[`COMPANION_PROFILE_${i}_AVATAR`] || "",
      ttsProfileId: env[`COMPANION_PROFILE_${i}_TTS_PROFILE_ID`] || "",
      voice: env[`COMPANION_PROFILE_${i}_TTS_VOICE`]
          || env[`COMPANION_PROFILE_${i}_VOICE`] || "",
    });
  }
  return profiles;
}

export default {
  id: "companion",
  group: "content",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`,
  labelKey: "settings.section.companion",
  navOrder: 45,

  async getPreview() {
    const env = readBundleEnv();
    const charName = env.COMPANION_CHARACTER_NAME || "Crow";
    const hhCount = getHouseholdProfiles().filter(p => p.name).length;
    return hhCount > 0 ? `${charName} · ${hhCount} household member${hhCount === 1 ? "" : "s"}` : charName;
  },

  async render({ db }) {
    const env = readBundleEnv();
    const persona = env.COMPANION_PERSONA || "";
    const charName = env.COMPANION_CHARACTER_NAME || "Crow";
    const avatar = env.COMPANION_AVATAR || "mao_pro";
    const aiProfileSlug = env.COMPANION_AI_PROFILE || "";
    const aiModel = env.COMPANION_AI_MODEL || "";

    const aiProfiles = await readAiProfiles(db);
    const ttsProfiles = await readTtsProfiles(db);
    const household = getHouseholdProfiles();

    const fs = "border:1px solid var(--crow-border);border-radius:8px;padding:1rem 1.25rem;margin-bottom:1rem;background:var(--crow-surface)";
    const lg = "font-weight:600;font-size:0.95rem;padding:0 0.5rem";
    const lb = "display:block;font-size:0.8rem;color:var(--crow-text-muted);margin-bottom:4px";
    const ip = "width:100%;padding:0.5rem;background:var(--crow-bg-deep,#111);border:1px solid var(--crow-border);border-radius:4px;color:var(--crow-text);font-size:0.85rem;box-sizing:border-box";
    const bt = "padding:0.4rem 0.9rem;background:var(--crow-accent);color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:0.85rem;font-weight:500";
    const st = "font-size:0.8rem;margin-left:0.75rem";

    /* ---- Persona ---- */
    let html = `
      <form method="POST" data-section-form="persona">
        <fieldset style="${fs}">
          <legend style="${lg}">Persona</legend>
          <p style="font-size:0.75rem;color:var(--crow-text-muted);margin:0 0 0.75rem">
            Character identity. Changes require a container restart.
          </p>
          <input type="hidden" name="action" value="update_companion_persona">

          <div style="margin-bottom:0.75rem">
            <label style="${lb}">Character name</label>
            <input type="text" name="character_name" value="${escapeHtml(charName)}" placeholder="Crow" style="${ip}">
          </div>

          <div style="margin-bottom:0.75rem">
            <label style="${lb}">Default avatar ID (Live2D model name)</label>
            <input type="text" name="avatar" value="${escapeHtml(avatar)}" placeholder="mao_pro" style="${ip};font-family:'JetBrains Mono',monospace">
          </div>

          <div style="margin-bottom:0.75rem">
            <label style="${lb}">Persona prompt (system instructions)</label>
            <textarea name="persona" rows="6" placeholder="You are Crow, an AI companion…" style="${ip};font-family:inherit;resize:vertical">${escapeHtml(persona)}</textarea>
          </div>

          <div style="display:flex;align-items:center">
            <button type="submit" style="${bt}">Save persona &amp; restart</button>
            <span data-section-status="persona" style="${st}"></span>
          </div>
        </fieldset>
      </form>`;

    /* ---- AI Provider ---- */
    html += `
      <form method="POST" data-section-form="ai">
        <fieldset style="${fs}">
          <legend style="${lg}">AI Provider</legend>
          <p style="font-size:0.75rem;color:var(--crow-text-muted);margin:0 0 0.75rem">
            Which AI profile answers voice chat. Define profiles in
            <a href="?section=ai-profiles" style="color:var(--crow-accent)">AI Profiles</a>.
          </p>
          <input type="hidden" name="action" value="update_companion_ai">`;

    if (aiProfiles.length === 0) {
      html += `<p style="font-size:0.85rem;color:var(--crow-text-muted);padding:12px;border:1px solid var(--crow-border);border-radius:8px;background:var(--crow-bg-elevated)">
        No AI profiles configured. <a href="?section=ai-profiles" style="color:var(--crow-accent)">Add one</a> first.
      </p>`;
    } else {
      const autoChecked = !aiProfileSlug ? " checked" : "";
      html += `<label style="display:flex;align-items:center;gap:8px;padding:10px 14px;border:1px solid var(--crow-border);border-radius:8px;cursor:pointer;font-size:0.85rem;margin-bottom:8px;background:${!aiProfileSlug ? "var(--crow-bg-elevated)" : "transparent"}">
        <input type="radio" name="ai_profile" value=""${autoChecked} style="accent-color:var(--crow-accent);width:auto;margin:0">
        <div>
          <div style="font-weight:500">Auto (recommended)</div>
          <div style="font-size:0.75rem;color:var(--crow-text-muted)">Prefers local models for low latency, falls back to cloud</div>
        </div>
      </label>`;

      for (const p of aiProfiles) {
        const slug = p.name.toLowerCase().replace(/\s+/g, "_").replace(/\./g, "_");
        const checked = slug === aiProfileSlug ? " checked" : "";
        const isLocal = /localhost|127\.0\.0\.1|172\.17/.test(p.baseUrl || "");
        const badge = isLocal ? "Local" : "Cloud";
        const badgeColor = isLocal ? "var(--crow-success)" : "var(--crow-accent)";
        const modelCount = (p.models || []).length;
        html += `<label style="display:flex;align-items:center;gap:8px;padding:10px 14px;border:1px solid var(--crow-border);border-radius:8px;cursor:pointer;font-size:0.85rem;margin-bottom:8px;background:${slug === aiProfileSlug ? "var(--crow-bg-elevated)" : "transparent"}">
          <input type="radio" name="ai_profile" value="${escapeHtml(slug)}"${checked} style="accent-color:var(--crow-accent);width:auto;margin:0">
          <div style="flex:1">
            <div style="font-weight:500;display:flex;align-items:center;gap:6px">
              ${escapeHtml(p.name)}
              <span style="font-size:0.65rem;padding:2px 6px;border-radius:4px;background:${badgeColor};color:#fff;font-weight:600">${badge}</span>
            </div>
            <div style="font-size:0.75rem;color:var(--crow-text-muted)">${modelCount} model${modelCount === 1 ? "" : "s"}</div>
          </div>
        </label>`;

        if (modelCount > 1) {
          const defaultModel = p.defaultModel || p.models[0];
          html += `<div class="profile-models" data-profile="${escapeHtml(slug)}" style="margin:-4px 0 8px 28px;padding:8px 14px;border:1px solid var(--crow-border);border-radius:8px;display:${slug === aiProfileSlug ? "block" : "none"}">`;
          for (const m of p.models) {
            const mChecked = (slug === aiProfileSlug && aiModel === m)
              ? " checked"
              : (slug === aiProfileSlug && !aiModel && m === defaultModel) ? " checked" : "";
            const shortName = m.length > 40 ? m.substring(0, 37) + "..." : m;
            html += `<label style="display:flex;align-items:center;gap:6px;padding:4px 0;cursor:pointer;font-size:0.8rem">
              <input type="radio" name="ai_model_${escapeHtml(slug)}" value="${escapeHtml(m)}"${mChecked} style="accent-color:var(--crow-accent);width:auto;margin:0">
              <span>${escapeHtml(shortName)}</span>
              ${m === defaultModel ? '<span style="font-size:0.65rem;color:var(--crow-text-muted)">(default)</span>' : ""}
            </label>`;
          }
          html += `</div>`;
        }
      }
    }

    html += `
          <div style="display:flex;align-items:center;margin-top:0.75rem">
            <button type="submit" style="${bt}" ${aiProfiles.length === 0 ? "disabled" : ""}>Save AI provider &amp; restart</button>
            <span data-section-status="ai" style="${st}"></span>
          </div>
        </fieldset>
      </form>`;

    /* ---- Household ---- */
    const ttsProfileOptions = ['<option value="">— none (use default) —</option>']
      .concat(ttsProfiles.map(tp =>
        `<option value="${escapeHtml(tp.id)}" data-default-voice="${escapeHtml(tp.defaultVoice || "")}">${escapeHtml(tp.name)}${tp.isDefault ? " (default)" : ""}</option>`
      ))
      .join("");

    html += `
      <form method="POST" data-section-form="household">
        <fieldset style="${fs}">
          <legend style="${lg}">Household Profiles</legend>
          <p style="font-size:0.75rem;color:var(--crow-text-muted);margin:0 0 0.75rem">
            Each profile becomes a persona in the character selector. Voice comes from a platform-wide
            <a href="?section=tts-profiles" style="color:var(--crow-accent)">TTS profile</a> — pick the profile first, then a voice.
          </p>
          <input type="hidden" name="action" value="update_companion_household">`;

    for (let i = 1; i <= 4; i++) {
      const p = household.find(hp => hp.index === i) || { index: i, name: "", avatar: "", ttsProfileId: "", voice: "" };
      const num = i;
      const borderColor = p.name ? "var(--crow-accent)" : "var(--crow-border)";
      const openAttr = p.name ? " open" : "";
      const optionsForThisRow = ttsProfileOptions.replace(
        `value="${escapeHtml(p.ttsProfileId)}"`,
        `value="${escapeHtml(p.ttsProfileId)}" selected`
      );
      html += `<details style="margin-bottom:8px;border:1px solid ${borderColor};border-radius:8px;overflow:hidden"${openAttr}>
        <summary style="padding:10px 14px;cursor:pointer;font-size:0.85rem;font-weight:500;background:var(--crow-bg-elevated)">
          ${p.name ? escapeHtml(p.name) : `Profile ${num} (empty)`}
        </summary>
        <div style="padding:12px 14px;display:flex;flex-direction:column;gap:10px">
          <div>
            <label style="${lb}">Name</label>
            <input type="text" name="profile_${num}_name" value="${escapeHtml(p.name)}" placeholder="e.g. Alex" style="${ip}">
          </div>
          <div>
            <label style="${lb}">Avatar ID</label>
            <input type="text" name="profile_${num}_avatar" value="${escapeHtml(p.avatar)}" placeholder="e.g. Cha_AnnoyingParrot, senko, mao_pro" style="${ip};font-family:'JetBrains Mono',monospace">
          </div>
          <div>
            <label style="${lb}">TTS profile</label>
            <select name="profile_${num}_tts_profile" data-tts-select="${num}" style="${ip}">${optionsForThisRow}</select>
          </div>
          <div>
            <label style="${lb}">Voice (provider-specific name — blank = profile default)</label>
            <input type="text" name="profile_${num}_tts_voice" value="${escapeHtml(p.voice)}" placeholder="e.g. en-US-AvaMultilingualNeural, alloy, af_bella" style="${ip};font-family:'JetBrains Mono',monospace" data-tts-voice="${num}">
          </div>
        </div>
      </details>`;
    }

    html += `
          <div style="display:flex;align-items:center;margin-top:0.75rem">
            <button type="submit" style="${bt}">Save household &amp; restart</button>
            <span data-section-status="household" style="${st}"></span>
          </div>
        </fieldset>
      </form>

      <script>
      document.querySelectorAll('form[data-section-form]').forEach(function(form) {
        form.addEventListener('submit', function(ev) {
          ev.preventDefault();
          var key = form.getAttribute('data-section-form');
          var status = document.querySelector('[data-section-status="' + key + '"]');
          status.textContent = 'Saving…';
          status.style.color = 'var(--crow-text-muted)';
          var fd = new URLSearchParams(new FormData(form));
          fetch('/dashboard/settings', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: fd.toString() })
            .then(function(r){ return r.json(); })
            .then(function(data){
              if (data && data.ok) {
                status.textContent = 'Saved. Restarting companion…';
                status.style.color = 'var(--crow-success)';
              } else {
                status.textContent = (data && data.error) || 'Save failed';
                status.style.color = 'var(--crow-error)';
              }
            })
            .catch(function(e){ status.textContent = 'Error: ' + e.message; status.style.color = 'var(--crow-error)'; });
        });
      });

      document.querySelectorAll('[data-tts-select]').forEach(function(sel) {
        var num = sel.getAttribute('data-tts-select');
        sel.addEventListener('change', function() {
          var voiceInput = document.querySelector('[data-tts-voice="' + num + '"]');
          if (!voiceInput || voiceInput.value.trim() !== '') return;
          var opt = sel.options[sel.selectedIndex];
          var def = opt ? opt.getAttribute('data-default-voice') : '';
          if (def) voiceInput.value = def;
        });
      });

      document.querySelectorAll('input[name="ai_profile"]').forEach(function(r) {
        r.addEventListener('change', function() {
          document.querySelectorAll('.profile-models').forEach(function(d) { d.style.display = 'none'; });
          var sel = document.querySelector('.profile-models[data-profile="' + r.value + '"]');
          if (sel) sel.style.display = 'block';
        });
      });
      <\/script>`;

    return html;
  },

  async handleAction({ req, res }) {
    const { action } = req.body;

    if (action === "update_companion_persona") {
      const env = readBundleEnv();
      const persona = (req.body.persona || "").toString();
      const characterName = (req.body.character_name || "").toString().trim();
      const avatar = (req.body.avatar || "").toString().trim();
      if (persona) env.COMPANION_PERSONA = persona.replace(/\n/g, "\\n");
      else delete env.COMPANION_PERSONA;
      if (characterName) env.COMPANION_CHARACTER_NAME = characterName;
      else delete env.COMPANION_CHARACTER_NAME;
      if (avatar) env.COMPANION_AVATAR = avatar;
      else delete env.COMPANION_AVATAR;
      writeBundleEnv(env);
      recreateCompanion();
      res.json({ ok: true });
      return true;
    }

    if (action === "update_companion_ai") {
      const env = readBundleEnv();
      const aiProfile = (req.body.ai_profile || "").toString();
      if (aiProfile) {
        env.COMPANION_AI_PROFILE = aiProfile;
        const modelKey = `ai_model_${aiProfile}`;
        if (req.body[modelKey]) env.COMPANION_AI_MODEL = req.body[modelKey];
        else delete env.COMPANION_AI_MODEL;
      } else {
        delete env.COMPANION_AI_PROFILE;
        delete env.COMPANION_AI_MODEL;
      }
      writeBundleEnv(env);
      recreateCompanion();
      res.json({ ok: true });
      return true;
    }

    if (action === "update_companion_household") {
      const env = readBundleEnv();
      for (let i = 1; i <= 4; i++) {
        const name = (req.body[`profile_${i}_name`] || "").trim();
        const avatar = (req.body[`profile_${i}_avatar`] || "").trim();
        const ttsProfileId = (req.body[`profile_${i}_tts_profile`] || "").trim();
        const voice = (req.body[`profile_${i}_tts_voice`] || "").trim();

        if (name) {
          env[`COMPANION_PROFILE_${i}_NAME`] = name;
          if (avatar) env[`COMPANION_PROFILE_${i}_AVATAR`] = avatar;
          else delete env[`COMPANION_PROFILE_${i}_AVATAR`];
          if (ttsProfileId) env[`COMPANION_PROFILE_${i}_TTS_PROFILE_ID`] = ttsProfileId;
          else delete env[`COMPANION_PROFILE_${i}_TTS_PROFILE_ID`];
          if (voice) env[`COMPANION_PROFILE_${i}_TTS_VOICE`] = voice;
          else delete env[`COMPANION_PROFILE_${i}_TTS_VOICE`];
          delete env[`COMPANION_PROFILE_${i}_VOICE`];
        } else {
          delete env[`COMPANION_PROFILE_${i}_NAME`];
          delete env[`COMPANION_PROFILE_${i}_AVATAR`];
          delete env[`COMPANION_PROFILE_${i}_TTS_PROFILE_ID`];
          delete env[`COMPANION_PROFILE_${i}_TTS_VOICE`];
          delete env[`COMPANION_PROFILE_${i}_VOICE`];
        }
      }
      writeBundleEnv(env);
      recreateCompanion();
      res.json({ ok: true });
      return true;
    }

    return false;
  },
};
