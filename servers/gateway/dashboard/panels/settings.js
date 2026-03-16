/**
 * Settings Panel — Integrations, identity, blog settings, theme, password
 */

import { escapeHtml, statCard, statGrid, section, formField, badge, dataTable } from "../shared/components.js";
import { getProxyStatus } from "../../proxy.js";
import { getUpdateStatus, checkForUpdates } from "../../auto-update.js";
import { t, SUPPORTED_LANGS } from "../shared/i18n.js";

export default {
  id: "settings",
  name: "Settings",
  icon: "settings",
  route: "/dashboard/settings",
  navOrder: 90,

  async handler(req, res, { db, layout, lang }) {
    // Handle POST actions
    if (req.method === "POST") {
      const { action } = req.body;

      if (action === "set_theme") {
        await db.execute({
          sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('dashboard_theme', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')",
          args: [req.body.theme, req.body.theme],
        });
        res.json({ ok: true });
        return;
      }

      if (action === "update_blog") {
        const fields = ["blog_title", "blog_tagline", "blog_author", "blog_theme", "blog_listed"];
        for (const key of fields) {
          const value = req.body[key];
          if (value !== undefined) {
            await db.execute({
              sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')",
              args: [key, value, value],
            });
          }
        }
        res.redirect("/dashboard/settings");
        return;
      }

      if (action === "update_discovery") {
        const fields = ["discovery_enabled", "discovery_name"];
        for (const key of fields) {
          const value = req.body[key];
          if (value !== undefined) {
            await db.execute({
              sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')",
              args: [key, value, value],
            });
          }
        }
        res.redirect("/dashboard/settings");
        return;
      }

      if (action === "change_password") {
        const { setPassword, validatePasswordStrength } = await import("../auth.js");
        const { password, confirm } = req.body;
        const strength = validatePasswordStrength(password);
        if (!strength.valid) {
          res.redirect("/dashboard/settings?error=short");
          return;
        }
        if (password !== confirm) {
          res.redirect("/dashboard/settings?error=mismatch");
          return;
        }
        await setPassword(password);
        res.redirect("/dashboard/settings?success=password");
        return;
      }

      if (action === "set_language") {
        const newLang = SUPPORTED_LANGS.includes(req.body.language) ? req.body.language : 'en';
        await db.execute({
          sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('language', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')",
          args: [newLang, newLang],
        });
        // Set cookie for setup page sync
        const secure = process.env.CROW_HOSTED || process.env.NODE_ENV === 'production' ? '; Secure' : '';
        res.setHeader('Set-Cookie', `crow_lang=${newLang}; Path=/; Max-Age=${30*24*60*60}; SameSite=Strict${secure}`);
        res.redirect("/dashboard/settings");
        return;
      }

      if (action === "save_update_settings") {
        const enabled = req.body.auto_update_enabled || "true";
        const interval = req.body.auto_update_interval_hours || "6";
        await db.execute({
          sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('auto_update_enabled', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')",
          args: [enabled, enabled],
        });
        await db.execute({
          sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('auto_update_interval_hours', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')",
          args: [interval, interval],
        });
        res.json({ ok: true, message: "Update settings saved. Restart gateway to apply new interval." });
        return;
      }

      if (action === "check_updates_now") {
        const result = await checkForUpdates();
        res.json({ ok: true, ...result });
        return;
      }

      if (action === "save_ai_provider") {
        const { resolveEnvPath, writeEnvVar, removeEnvVar, sanitizeEnvValue } = await import("../../env-manager.js");
        const envPath = resolveEnvPath();
        const { provider, api_key, model, base_url } = req.body;
        if (provider) writeEnvVar(envPath, "AI_PROVIDER", sanitizeEnvValue(provider));
        if (api_key) writeEnvVar(envPath, "AI_API_KEY", sanitizeEnvValue(api_key));
        if (model) writeEnvVar(envPath, "AI_MODEL", sanitizeEnvValue(model));
        if (base_url) writeEnvVar(envPath, "AI_BASE_URL", sanitizeEnvValue(base_url));
        else removeEnvVar(envPath, "AI_BASE_URL");
        // Invalidate provider config cache
        try {
          const { invalidateConfigCache } = await import("../../ai/provider.js");
          invalidateConfigCache();
        } catch {}
        res.json({ ok: true });
        return;
      }

      if (action === "remove_ai_provider") {
        const { resolveEnvPath, removeEnvVar } = await import("../../env-manager.js");
        const envPath = resolveEnvPath();
        removeEnvVar(envPath, "AI_PROVIDER");
        removeEnvVar(envPath, "AI_API_KEY");
        removeEnvVar(envPath, "AI_MODEL");
        removeEnvVar(envPath, "AI_BASE_URL");
        try {
          const { invalidateConfigCache } = await import("../../ai/provider.js");
          invalidateConfigCache();
        } catch {}
        res.json({ ok: true });
        return;
      }

      if (action === "test_ai_provider") {
        try {
          const { testProviderConnection } = await import("../../ai/provider.js");
          const result = await testProviderConnection();
          res.json(result);
        } catch (err) {
          res.json({ ok: false, error: err.message });
        }
        return;
      }

      if (action === "save_ai_profile") {
        const { profile_id, profile_name, profile_provider, profile_api_key, profile_base_url, profile_models, profile_default_model } = req.body;
        if (!profile_name || !profile_provider) {
          res.json({ ok: false, error: "Name and provider are required" });
          return;
        }

        // Parse models from comma-separated string
        const models = (profile_models || "").split(",").map(m => m.trim()).filter(Boolean);
        const defaultModel = profile_default_model || models[0] || "";

        // Read existing profiles
        const existing = await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = 'ai_profiles'", args: [] });
        let profiles = [];
        try { profiles = JSON.parse(existing.rows[0]?.value || "[]"); } catch {}

        if (profile_id) {
          // Update existing profile
          const idx = profiles.findIndex(p => p.id === profile_id);
          if (idx === -1) { res.json({ ok: false, error: "Profile not found" }); return; }
          profiles[idx].name = profile_name;
          profiles[idx].provider = profile_provider;
          if (profile_api_key) profiles[idx].apiKey = profile_api_key; // blank = keep existing
          profiles[idx].baseUrl = profile_base_url || "";
          profiles[idx].models = models;
          profiles[idx].defaultModel = defaultModel;
        } else {
          // Create new profile
          const { randomBytes } = await import("node:crypto");
          const id = randomBytes(4).toString("hex");
          profiles.push({
            id,
            name: profile_name,
            provider: profile_provider,
            apiKey: profile_api_key || "",
            baseUrl: profile_base_url || "",
            models,
            defaultModel,
          });
        }

        await db.execute({
          sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('ai_profiles', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')",
          args: [JSON.stringify(profiles), JSON.stringify(profiles)],
        });

        res.json({ ok: true });
        return;
      }

      if (action === "delete_ai_profile") {
        const { profile_id } = req.body;
        if (!profile_id) { res.json({ ok: false, error: "profile_id required" }); return; }

        const existing = await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = 'ai_profiles'", args: [] });
        let profiles = [];
        try { profiles = JSON.parse(existing.rows[0]?.value || "[]"); } catch {}

        profiles = profiles.filter(p => p.id !== profile_id);

        await db.execute({
          sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('ai_profiles', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')",
          args: [JSON.stringify(profiles), JSON.stringify(profiles)],
        });

        res.json({ ok: true });
        return;
      }

      if (action === "test_ai_profile") {
        const { profile_id } = req.body;
        if (!profile_id) { res.json({ ok: false, error: "profile_id required" }); return; }

        const existing = await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = 'ai_profiles'", args: [] });
        let profiles = [];
        try { profiles = JSON.parse(existing.rows[0]?.value || "[]"); } catch {}
        const profile = profiles.find(p => p.id === profile_id);
        if (!profile) { res.json({ ok: false, error: "Profile not found" }); return; }

        try {
          const { testProfileConnection } = await import("../../ai/provider.js");
          const result = await testProfileConnection(profile);
          res.json(result);
        } catch (err) {
          res.json({ ok: false, error: err.message });
        }
        return;
      }

      if (action === "save_integration") {
        const { integration_id } = req.body;
        const { INTEGRATIONS } = await import("../../integrations.js");
        const { resolveEnvPath, writeEnvVar, sanitizeEnvValue } = await import("../../env-manager.js");

        const integration = INTEGRATIONS.find((i) => i.id === integration_id);
        if (!integration) {
          res.json({ ok: false, error: "Unknown integration" });
          return;
        }

        const envPath = resolveEnvPath();
        for (const envVar of integration.envVars) {
          const value = req.body[envVar];
          if (value !== undefined && value !== "") {
            writeEnvVar(envPath, envVar, sanitizeEnvValue(value));
          }
        }

        // Regenerate .mcp.json
        try {
          const { execFileSync } = await import("node:child_process");
          const { APP_ROOT } = await import("../../env-manager.js");
          execFileSync("node", ["scripts/generate-mcp-config.js"], {
            cwd: APP_ROOT,
            stdio: "pipe",
            timeout: 10000,
          });
        } catch (e) {
          console.warn("[settings] Failed to regenerate .mcp.json:", e.message);
        }

        const isSystemd = !!process.env.INVOCATION_ID;
        res.json({ ok: true, restarting: isSystemd });
        if (isSystemd) {
          setTimeout(() => process.exit(0), 500);
        }
        return;
      }

      if (action === "save_notification_prefs") {
        const typesEnabled = [];
        if (req.body.type_reminder) typesEnabled.push("reminder");
        if (req.body.type_media) typesEnabled.push("media");
        if (req.body.type_peer) typesEnabled.push("peer");
        if (req.body.type_system) typesEnabled.push("system");
        const prefs = JSON.stringify({ types_enabled: typesEnabled });
        await db.execute({
          sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('notification_prefs', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')",
          args: [prefs, prefs],
        });
        res.redirect("/dashboard/settings");
        return;
      }

      if (action === "remove_integration") {
        const { integration_id } = req.body;
        const { INTEGRATIONS } = await import("../../integrations.js");
        const { resolveEnvPath, removeEnvVar } = await import("../../env-manager.js");

        const integration = INTEGRATIONS.find((i) => i.id === integration_id);
        if (!integration) {
          res.json({ ok: false, error: "Unknown integration" });
          return;
        }

        const envPath = resolveEnvPath();
        for (const envVar of integration.envVars) {
          removeEnvVar(envPath, envVar);
        }

        // Regenerate .mcp.json
        try {
          const { execFileSync } = await import("node:child_process");
          const { APP_ROOT } = await import("../../env-manager.js");
          execFileSync("node", ["scripts/generate-mcp-config.js"], {
            cwd: APP_ROOT,
            stdio: "pipe",
            timeout: 10000,
          });
        } catch (e) {
          console.warn("[settings] Failed to regenerate .mcp.json:", e.message);
        }

        const isSystemd = !!process.env.INVOCATION_ID;
        res.json({ ok: true, restarting: isSystemd });
        if (isSystemd) {
          setTimeout(() => process.exit(0), 500);
        }
        return;
      }
    }

    // Build settings page
    const successMsg = req.query.success === "password"
      ? `<div class="alert alert-success">${t("settings.passwordUpdated", lang)}</div>` : "";
    const errorMsg = req.query.error === "short"
      ? `<div class="alert alert-error">${t("settings.passwordTooShort", lang)}</div>`
      : req.query.error === "mismatch"
      ? `<div class="alert alert-error">${t("settings.passwordMismatch", lang)}</div>` : "";

    // Integration status — collapsible cards grouped by category
    const proxyStatus = getProxyStatus();
    const { INTEGRATIONS: allIntegrations } = await import("../../integrations.js");
    const categories = { productivity: [], communication: [], development: [] };
    const statusMap = new Map(proxyStatus.map((s) => [s.id, s]));
    for (const integration of allIntegrations) {
      const cat = integration.category || "development";
      const status = statusMap.get(integration.id);
      if (categories[cat]) {
        categories[cat].push({ ...integration, proxyStatus: status || null });
      }
    }

    const categoryLabels = { productivity: t("settings.productivity", lang), communication: t("settings.communication", lang), development: t("settings.development", lang) };

    let integrationsHtml = `<style>
      .int-cards { display:flex; flex-direction:column; gap:0.5rem; }
      .int-card { border:1px solid var(--crow-border); border-radius:8px; overflow:hidden; background:var(--crow-surface); }
      .int-card-header { display:flex; align-items:center; gap:0.75rem; padding:0.75rem 1rem; cursor:pointer; user-select:none; }
      .int-card-header:hover { background:color-mix(in srgb, var(--crow-surface) 90%, var(--crow-text) 10%); }
      .int-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; }
      .int-dot-green { background:var(--crow-success); }
      .int-dot-yellow { background:#e6a700; }
      .int-dot-gray { background:var(--crow-text-muted); }
      .int-card-info { flex:1; min-width:0; }
      .int-card-name { font-weight:600; font-size:0.95rem; color:var(--crow-text); }
      .int-card-desc { font-size:0.8rem; color:var(--crow-text-muted); margin-top:2px; }
      .int-chevron { transition:transform 0.2s; color:var(--crow-text-muted); font-size:0.8rem; }
      .int-chevron.open { transform:rotate(180deg); }
      .int-card-body { display:none; padding:0.75rem 1rem; border-top:1px solid var(--crow-border); }
      .int-card-body.open { display:block; }
      .int-field { margin-bottom:0.75rem; }
      .int-field label { display:block; font-size:0.8rem; color:var(--crow-text-muted); margin-bottom:4px; font-family:'JetBrains Mono',monospace; }
      .int-field input { width:100%; padding:0.5rem; background:var(--crow-background,#111); border:1px solid var(--crow-border); border-radius:4px; color:var(--crow-text); font-family:'JetBrains Mono',monospace; font-size:0.85rem; box-sizing:border-box; }
      .int-actions { display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap; margin-top:0.75rem; }
      .int-link { font-size:0.8rem; color:var(--crow-accent); text-decoration:none; }
      .int-link:hover { text-decoration:underline; }
      .int-note { font-size:0.8rem; color:var(--crow-text-muted); font-style:italic; }
      .int-cat-label { font-size:0.75rem; text-transform:uppercase; letter-spacing:0.08em; color:var(--crow-text-muted); margin:1rem 0 0.5rem; font-weight:600; }
      .int-cat-label:first-child { margin-top:0; }
      .int-status-msg { font-size:0.8rem; margin-top:0.5rem; padding:0.4rem 0.6rem; border-radius:4px; }
    </style>`;

    for (const [catKey, items] of Object.entries(categories)) {
      if (items.length === 0) continue;
      integrationsHtml += `<div class="int-cat-label">${categoryLabels[catKey]}</div><div class="int-cards">`;
      for (const item of items) {
        const isConnected = item.proxyStatus?.status === "connected";
        const requiresMissing = item.proxyStatus?.requiresMissing || false;
        const hasEnvVars = item.envVars.length > 0;
        const dotClass = isConnected ? "int-dot-green" : (requiresMissing && !isConnected ? "int-dot-yellow" : "int-dot-gray");
        const connectedBadge = isConnected ? ` ${badge(t("settings.connected", lang), "connected")}` : "";
        const toolCount = item.proxyStatus?.toolCount ? ` <span class="mono" style="font-size:0.8rem;color:var(--crow-text-muted)">${item.proxyStatus.toolCount} ${t("settings.tools", lang)}</span>` : "";

        let bodyContent = "";

        if (hasEnvVars) {
          for (const envVar of item.envVars) {
            const currentVal = process.env[envVar] ? "••••••••" : "";
            bodyContent += `<div class="int-field">
              <label>${escapeHtml(envVar)}</label>
              <input type="password" name="${escapeHtml(envVar)}" placeholder="${currentVal || t("settings.notSet", lang)}" autocomplete="off">
            </div>`;
          }
        } else {
          bodyContent += `<p class="int-note">${t("settings.noConfigNeeded", lang)}</p>`;
        }

        if (requiresMissing) {
          bodyContent += `<p class="int-note">${t("settings.requires", lang)} ${item.requires.map((r) => `<code>${escapeHtml(r)}</code>`).join(", ")} (Python)</p>`;
        }

        let links = "";
        if (item.keyUrl) {
          links += `<a href="${escapeHtml(item.keyUrl)}" target="_blank" rel="noopener" class="int-link">${t("settings.getApiKey", lang)}</a>`;
        }
        if (item.docsUrl) {
          links += `<a href="${escapeHtml(item.docsUrl)}" target="_blank" rel="noopener" class="int-link">${t("settings.docs", lang)}</a>`;
        }

        const saveBtn = hasEnvVars ? `<button class="btn btn-primary btn-sm" onclick="saveIntegration('${escapeHtml(item.id)}',this)">${t("settings.save", lang)}</button>` : "";
        const removeBtn = isConnected ? `<button class="btn btn-secondary btn-sm" onclick="removeIntegration('${escapeHtml(item.id)}',this)">${t("settings.removeIntegration", lang)}</button>` : "";

        bodyContent += `<div class="int-actions">${saveBtn}${removeBtn}${links}</div>`;

        if (item.keyInstructions) {
          bodyContent += `<p class="int-note" style="margin-top:0.5rem">${escapeHtml(item.keyInstructions)}</p>`;
        }

        integrationsHtml += `<div class="int-card" data-integration="${escapeHtml(item.id)}">
          <div class="int-card-header" onclick="toggleIntCard(this)">
            <span class="int-dot ${dotClass}"></span>
            <div class="int-card-info">
              <div class="int-card-name">${escapeHtml(item.name)}${connectedBadge}${toolCount}</div>
              <div class="int-card-desc">${escapeHtml(item.description)}</div>
            </div>
            <span class="int-chevron">&#9662;</span>
          </div>
          <div class="int-card-body">${bodyContent}</div>
        </div>`;
      }
      integrationsHtml += `</div>`;
    }

    integrationsHtml += `<script>
function toggleIntCard(header) {
  const body = header.nextElementSibling;
  const chevron = header.querySelector('.int-chevron');
  body.classList.toggle('open');
  chevron.classList.toggle('open');
}

async function saveIntegration(id, btn) {
  const card = btn.closest('.int-card');
  const inputs = card.querySelectorAll('input[name]');
  const params = new URLSearchParams();
  params.set('action', 'save_integration');
  params.set('integration_id', id);
  let hasValue = false;
  inputs.forEach(inp => { if (inp.value) { params.set(inp.name, inp.value); hasValue = true; } });
  if (!hasValue) return;

  btn.disabled = true;
  btn.textContent = '${t("settings.saving", lang)}';
  try {
    const res = await fetch('/dashboard/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const data = await res.json();
    const msg = document.createElement('div');
    msg.className = 'int-status-msg';
    if (data.ok) {
      msg.style.color = 'var(--crow-success)';
      msg.textContent = data.restarting ? '${t("settings.savedRestarting", lang)}' : '${t("settings.savedRestartNeeded", lang)}';
      if (data.restarting) {
        setTimeout(() => { pollHealth(); }, 2000);
      }
    } else {
      msg.style.color = 'var(--crow-error)';
      msg.textContent = data.error || '${t("settings.saveFailed", lang)}';
    }
    const actions = card.querySelector('.int-actions');
    const oldMsg = card.querySelector('.int-status-msg');
    if (oldMsg) oldMsg.remove();
    actions.after(msg);
    inputs.forEach(inp => { inp.value = ''; inp.placeholder = '••••••••'; });
  } catch (e) {
    console.error(e);
  }
  btn.disabled = false;
  btn.textContent = '${t("settings.save", lang)}';
}

async function removeIntegration(id, btn) {
  if (!confirm('${t("settings.removeConfirm", lang)}')) return;
  btn.disabled = true;
  btn.textContent = '${t("settings.removing", lang)}';
  try {
    const params = new URLSearchParams();
    params.set('action', 'remove_integration');
    params.set('integration_id', id);
    const res = await fetch('/dashboard/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const data = await res.json();
    if (data.ok) {
      if (data.restarting) {
        setTimeout(() => { pollHealth(); }, 2000);
      } else {
        location.reload();
      }
    }
  } catch (e) {
    console.error(e);
  }
  btn.disabled = false;
  btn.textContent = '${t("settings.removeIntegration", lang)}';
}

function pollHealth(attempts) {
  attempts = attempts || 0;
  if (attempts > 15) { location.reload(); return; }
  fetch('/health').then(r => { if (r.ok) location.reload(); else throw 0; }).catch(() => {
    setTimeout(() => pollHealth(attempts + 1), 2000);
  });
}
</script>`;

    // Identity info
    let identityHtml;
    try {
      const { getOrCreateIdentity } = await import("../../../sharing/identity.js");
      const identity = await getOrCreateIdentity();
      identityHtml = `<div style="font-family:'JetBrains Mono',monospace;font-size:0.85rem">
        <div style="margin-bottom:0.5rem"><span style="color:var(--crow-text-muted)">${t("settings.crowId", lang)}</span> ${escapeHtml(identity.crowId)}</div>
        <div><span style="color:var(--crow-text-muted)">${t("settings.ed25519", lang)}</span> ${escapeHtml(identity.ed25519Public?.slice(0, 16))}...</div>
      </div>`;
    } catch {
      identityHtml = `<p style="color:var(--crow-text-muted)">${t("settings.identityNotAvailable", lang)}</p>`;
    }

    // Blog settings
    const blogSettings = await db.execute({
      sql: "SELECT key, value FROM dashboard_settings WHERE key LIKE 'blog_%'",
      args: [],
    });
    const bs = {};
    for (const r of blogSettings.rows) bs[r.key] = r.value;

    const blogForm = `<form method="POST">
      <input type="hidden" name="action" value="update_blog">
      ${formField(t("settings.blogTitle", lang), "blog_title", { value: bs.blog_title || "Crow Blog", placeholder: "My Blog" })}
      ${formField(t("settings.tagline", lang), "blog_tagline", { value: bs.blog_tagline || "", placeholder: t("settings.taglinePlaceholder", lang) })}
      ${formField(t("settings.defaultAuthor", lang), "blog_author", { value: bs.blog_author || "" })}
      ${formField(t("settings.themeLabel", lang), "blog_theme", { type: "select", value: bs.blog_theme || "dark", options: [
        { value: "dark", label: t("settings.darkDefault", lang) },
        { value: "light", label: t("settings.light", lang) },
        { value: "serif", label: t("settings.serif", lang) },
      ]})}
      ${formField(t("settings.blogDiscovery", lang), "blog_listed", { type: "select", value: bs.blog_listed || "false", options: [
        { value: "false", label: t("settings.notListed", lang) },
        { value: "true", label: t("settings.listedInRegistry", lang) },
      ]})}
      <p style="color:var(--crow-text-muted);font-size:0.85rem;margin:-0.5rem 0 1rem">When listed, your blog appears in the Crow Blog Registry so other Crow users can discover it.</p>
      <button type="submit" class="btn btn-primary">${t("settings.saveBlogSettings", lang)}</button>
    </form>`;

    // Contact discovery
    const discoveryForm = `<form method="POST">
      <input type="hidden" name="action" value="update_discovery">
      ${formField(t("settings.contactDiscoveryLabel", lang), "discovery_enabled", { type: "select", value: bs.discovery_enabled || "false", options: [
        { value: "false", label: t("settings.disabled", lang) },
        { value: "true", label: t("settings.enabled", lang) },
      ]})}
      <p style="color:var(--crow-text-muted);font-size:0.85rem;margin:-0.5rem 0 1rem">When enabled, your Crow ID and display name are visible at /discover/profile. Other Crow users can find you and send invite requests.</p>
      ${formField(t("settings.displayName", lang), "discovery_name", { type: "text", value: bs.discovery_name || "", placeholder: t("settings.displayNamePlaceholder", lang) })}
      <button type="submit" class="btn btn-primary">${t("settings.saveDiscoverySettings", lang)}</button>
    </form>`;

    // Password change
    const passwordForm = `<form method="POST">
      <input type="hidden" name="action" value="change_password">
      ${formField(t("settings.newPassword", lang), "password", { type: "password", required: true, placeholder: t("settings.newPasswordPlaceholder", lang) })}
      ${formField(t("settings.confirmPassword", lang), "confirm", { type: "password", required: true })}
      <button type="submit" class="btn btn-secondary">${t("settings.changePasswordButton", lang)}</button>
    </form>`;

    // Language preference
    const langResult = await db.execute({
      sql: "SELECT value FROM dashboard_settings WHERE key = 'language'", args: []
    });
    const { parseCookies } = await import("../auth.js");
    const currentLang = langResult.rows[0]?.value || parseCookies(req).crow_lang || "en";

    const langOptions = SUPPORTED_LANGS.map(code => {
      const labels = { en: "English", es: "Español" };
      return { value: code, label: labels[code] || code };
    });
    const langForm = `<form method="POST">
      <input type="hidden" name="action" value="set_language">
      ${formField(t("settings.languageLabel", lang), "language", { type: "select", value: currentLang, options: langOptions })}
      <button type="submit" class="btn btn-secondary">${t("settings.saveLanguage", lang)}</button>
    </form>`;

    // Auto-update status
    const updateStatus = await getUpdateStatus();
    const lastCheckDisplay = updateStatus.lastCheck
      ? new Date(updateStatus.lastCheck).toLocaleString()
      : t("settings.never", lang);
    const versionDisplay = updateStatus.currentVersion || "unknown";

    const updateHtml = `
      <div style="display:flex;flex-wrap:wrap;gap:1rem;margin-bottom:1rem">
        <div style="flex:1;min-width:200px">
          <div style="font-size:0.8rem;color:var(--crow-text-muted);margin-bottom:0.25rem">${t("settings.currentVersion", lang)}</div>
          <div style="font-family:'JetBrains Mono',monospace;font-size:0.95rem">${escapeHtml(versionDisplay)}</div>
        </div>
        <div style="flex:1;min-width:200px">
          <div style="font-size:0.8rem;color:var(--crow-text-muted);margin-bottom:0.25rem">${t("settings.lastChecked", lang)}</div>
          <div style="font-size:0.9rem">${escapeHtml(lastCheckDisplay)}</div>
        </div>
        <div style="flex:1;min-width:200px">
          <div style="font-size:0.8rem;color:var(--crow-text-muted);margin-bottom:0.25rem">${t("settings.statusLabel", lang)}</div>
          <div style="font-size:0.9rem">${escapeHtml(updateStatus.lastResult || t("settings.waitingFirstCheck", lang))}</div>
        </div>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:0.75rem;align-items:end;margin-bottom:1rem">
        <div>
          <label style="display:block;font-size:0.8rem;color:var(--crow-text-muted);margin-bottom:0.25rem">${t("settings.autoUpdate", lang)}</label>
          <select id="update-enabled" style="padding:0.5rem;border:1px solid var(--crow-border);border-radius:4px;background:var(--crow-bg);color:var(--crow-text);font-size:0.85rem">
            <option value="true"${updateStatus.enabled ? " selected" : ""}>${t("settings.enabledOption", lang)}</option>
            <option value="false"${!updateStatus.enabled ? " selected" : ""}>${t("settings.disabledOption", lang)}</option>
          </select>
        </div>
        <div>
          <label style="display:block;font-size:0.8rem;color:var(--crow-text-muted);margin-bottom:0.25rem">${t("settings.checkInterval", lang)}</label>
          <select id="update-interval" style="padding:0.5rem;border:1px solid var(--crow-border);border-radius:4px;background:var(--crow-bg);color:var(--crow-text);font-size:0.85rem">
            <option value="1"${updateStatus.intervalHours === 1 ? " selected" : ""}>${t("settings.everyHour", lang)}</option>
            <option value="6"${updateStatus.intervalHours === 6 ? " selected" : ""}>${t("settings.every6Hours", lang)}</option>
            <option value="12"${updateStatus.intervalHours === 12 ? " selected" : ""}>${t("settings.every12Hours", lang)}</option>
            <option value="24"${updateStatus.intervalHours === 24 ? " selected" : ""}>${t("settings.daily", lang)}</option>
          </select>
        </div>
        <button class="btn btn-secondary btn-sm" id="save-update-settings">${t("settings.save", lang)}</button>
        <button class="btn btn-primary btn-sm" id="check-updates-now">${t("settings.checkNow", lang)}</button>
      </div>
      <div id="update-status-msg" style="font-size:0.85rem;display:none"></div>
      <p style="color:var(--crow-text-muted);font-size:0.8rem;margin-top:0.5rem">
        Auto-updates pull the latest code from GitHub and restart the gateway. You can also disable with <code>CROW_AUTO_UPDATE=0</code> in your .env file.
      </p>
      <script>
      document.getElementById('save-update-settings').addEventListener('click', async function() {
        const btn = this;
        btn.disabled = true;
        btn.textContent = '${t("settings.saving", lang)}';
        const params = new URLSearchParams();
        params.set('action', 'save_update_settings');
        params.set('auto_update_enabled', document.getElementById('update-enabled').value);
        params.set('auto_update_interval_hours', document.getElementById('update-interval').value);
        try {
          const res = await fetch('/dashboard/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString(),
          });
          const data = await res.json();
          const msg = document.getElementById('update-status-msg');
          msg.style.display = 'block';
          msg.style.color = data.ok ? 'var(--crow-success)' : 'var(--crow-error)';
          msg.textContent = data.message || (data.ok ? 'Saved' : 'Failed');
        } catch (e) { console.error(e); }
        btn.disabled = false;
        btn.textContent = '${t("settings.save", lang)}';
      });

      document.getElementById('check-updates-now').addEventListener('click', async function() {
        const btn = this;
        btn.disabled = true;
        btn.textContent = '${t("settings.checking", lang)}';
        const msg = document.getElementById('update-status-msg');
        msg.style.display = 'block';
        msg.style.color = 'var(--crow-accent)';
        msg.textContent = 'Checking for updates...';
        try {
          const params = new URLSearchParams();
          params.set('action', 'check_updates_now');
          const res = await fetch('/dashboard/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString(),
          });
          const data = await res.json();
          if (data.updated) {
            msg.style.color = 'var(--crow-success)';
            msg.textContent = 'Updated ' + (data.from || '?') + ' → ' + (data.to || '?') + '. Restarting gateway...';
            btn.textContent = 'Restarting...';
            // Poll until the server comes back
            setTimeout(function pollRestart() {
              fetch('/health').then(function(r) {
                if (r.ok) location.reload();
                else setTimeout(pollRestart, 2000);
              }).catch(function() {
                msg.textContent = 'Gateway restarting... waiting for it to come back up.';
                setTimeout(pollRestart, 2000);
              });
            }, 3000);
            return;
          } else if (data.error) {
            msg.style.color = 'var(--crow-error)';
            msg.textContent = data.error;
          } else {
            msg.style.color = 'var(--crow-text-muted)';
            msg.textContent = '${t("settings.alreadyUpToDate", lang)}';
          }
        } catch (e) {
          // Server may have already started restarting
          msg.style.display = 'block';
          msg.style.color = 'var(--crow-accent)';
          msg.textContent = 'Gateway restarting... waiting for it to come back up.';
          btn.textContent = 'Restarting...';
          setTimeout(function pollRestart() {
            fetch('/health').then(function(r) {
              if (r.ok) location.reload();
              else setTimeout(pollRestart, 2000);
            }).catch(function() { setTimeout(pollRestart, 2000); });
          }, 3000);
          return;
        }
        btn.disabled = false;
        btn.textContent = '${t("settings.checkNow", lang)}';
      });
      <\/script>`;

    // Core server stats
    const memoryCount = await db.execute("SELECT COUNT(*) as c FROM memories");
    const sourceCount = await db.execute("SELECT COUNT(*) as c FROM research_sources");
    const contactCount = await db.execute("SELECT COUNT(*) as c FROM contacts WHERE is_blocked = 0");
    const postCount = await db.execute("SELECT COUNT(*) as c FROM blog_posts");

    const stats = statGrid([
      statCard(t("settings.memories", lang), memoryCount.rows[0]?.c || 0, { delay: 0 }),
      statCard(t("settings.sourcesLabel", lang), sourceCount.rows[0]?.c || 0, { delay: 50 }),
      statCard(t("settings.contactsLabel", lang), contactCount.rows[0]?.c || 0, { delay: 100 }),
      statCard(t("settings.postsLabel", lang), postCount.rows[0]?.c || 0, { delay: 150 }),
    ]);

    // Connection URLs
    const gatewayUrl = process.env.CROW_GATEWAY_URL || "";
    const tailscaleIp = process.env.TAILSCALE_IP || "";
    const localUrl = `http://localhost:${process.env.PORT || process.env.CROW_GATEWAY_PORT || 3001}`;
    const requestUrl = `${req.protocol}://${req.get("host")}`;

    let urlRows = [];
    urlRows.push([
      t("settings.local", lang),
      `<code style="font-size:0.85rem;word-break:break-all">${escapeHtml(localUrl)}</code>`,
      badge(t("settings.always", lang), "connected"),
    ]);
    if (requestUrl !== localUrl) {
      urlRows.push([
        t("settings.tailnetLan", lang),
        `<code style="font-size:0.85rem;word-break:break-all">${escapeHtml(requestUrl)}</code>`,
        badge(t("settings.active", lang), "connected"),
      ]);
    }
    if (gatewayUrl) {
      urlRows.push([
        t("settings.publicBlogOnly", lang),
        `<a href="${escapeHtml(gatewayUrl)}/blog/" target="_blank" style="font-size:0.85rem;word-break:break-all">${escapeHtml(gatewayUrl)}/blog/</a>`,
        badge(t("settings.live", lang), "published"),
      ]);
    }
    // MCP endpoint URLs (from setup page content)
    const baseUrl = requestUrl;
    const mcpEndpoints = [
      [t("settings.routerRecommended", lang), `${baseUrl}/router/mcp`, t("settings.categoryTools", lang)],
      ["Memory", `${baseUrl}/memory/mcp`, t("settings.allMemoryTools", lang)],
      ["Projects", `${baseUrl}/research/mcp`, t("settings.allResearchTools", lang)],
      ["Sharing", `${baseUrl}/sharing/mcp`, t("settings.allSharingTools", lang)],
    ];

    const mcpRows = mcpEndpoints.map(([name, url, desc]) => [
      name,
      `<code style="font-size:0.8rem;word-break:break-all">${escapeHtml(url)}</code>`,
      `<span style="color:var(--crow-text-muted);font-size:0.85rem">${desc}</span>`,
    ]);

    const connectionHtml = dataTable([t("settings.context", lang), t("settings.url", lang), t("settings.statusColumn", lang)], urlRows)
      + `<p style="color:var(--crow-text-muted);font-size:0.8rem;margin-top:0.75rem">The Crow's Nest is private (local/Tailscale only). Set <code>CROW_GATEWAY_URL</code> in .env for public blog/podcast URLs.</p>`
      + `<div style="margin-top:1rem"><h4 style="font-size:0.9rem;color:var(--crow-text-muted);margin-bottom:0.5rem">${t("settings.mcpEndpoints", lang)}</h4>`
      + dataTable([t("settings.server", lang), t("settings.endpointUrl", lang), t("settings.scope", lang)], mcpRows)
      + `<p style="color:var(--crow-text-muted);font-size:0.8rem;margin-top:0.5rem">Use these Streamable HTTP endpoints to connect Claude.ai, ChatGPT, Gemini, Cursor, or other MCP clients. See the Help &amp; Setup section below for platform-specific instructions.</p></div>`;

    // AI Provider config
    let aiProviderConfig = null;
    try {
      const { getProviderConfig, PROVIDER_INFO } = await import("../../ai/provider.js");
      aiProviderConfig = getProviderConfig();
    } catch {}

    const aiProviders = [
      { id: "openai", name: "OpenAI", defaultModel: "gpt-4o" },
      { id: "anthropic", name: "Anthropic", defaultModel: "claude-sonnet-4-20250514" },
      { id: "google", name: "Google Gemini", defaultModel: "gemini-2.5-flash" },
      { id: "ollama", name: "Ollama (local)", defaultModel: "llama3.1" },
      { id: "openrouter", name: "OpenRouter", defaultModel: "openai/gpt-4o" },
    ];

    const currentProvider = aiProviderConfig?.provider || "";
    const currentModel = aiProviderConfig?.model || "";
    const currentBaseUrl = aiProviderConfig?.baseUrl || "";
    const hasKey = aiProviderConfig?.apiKey ? true : false;

    const providerOptions = aiProviders.map(p =>
      `<option value="${p.id}"${currentProvider === p.id ? " selected" : ""}>${escapeHtml(p.name)}</option>`
    ).join("");

    const aiProviderHtml = `<style>
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
      var defaults = {openai:'gpt-4o',anthropic:'claude-sonnet-4-20250514',google:'gemini-2.5-flash',ollama:'llama3.1',openrouter:'openai/gpt-4o'};
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
        el.textContent = data.ok ? '${t("settings.savedAiReady", lang)}' : (data.error || '${t("settings.saveFailed", lang)}');
        if (key) { document.getElementById('ai-api-key').value = ''; document.getElementById('ai-api-key').placeholder = '••••••••'; }
      } catch(e) { el.style.color='var(--crow-error)'; el.textContent='Save failed: '+e.message; }
    }
    async function testAiProvider() {
      var el = document.getElementById('ai-status');
      el.style.color = 'var(--crow-accent)';
      el.textContent = '${t("settings.testingConnection", lang)}';
      try {
        var params = new URLSearchParams();
        params.set('action', 'test_ai_provider');
        var res = await fetch('/dashboard/settings', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:params.toString() });
        var data = await res.json();
        el.style.color = data.ok ? 'var(--crow-success)' : 'var(--crow-error)';
        el.textContent = data.ok ? '${t("settings.connectionSuccessful", lang)} ' + (data.provider || 'unknown') : '${t("settings.testFailed", lang)} ' + (data.error || 'Unknown error');
      } catch(e) { el.style.color='var(--crow-error)'; el.textContent='Test failed: '+e.message; }
    }
    async function removeAiProvider() {
      if (!confirm('${t("settings.removeAiConfirm", lang)}')) return;
      var params = new URLSearchParams();
      params.set('action', 'remove_ai_provider');
      try {
        await fetch('/dashboard/settings', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:params.toString() });
        location.reload();
      } catch(e) { console.error(e); }
    }
    <\/script>`;

    // Device context
    const currentDeviceId = process.env.CROW_DEVICE_ID || "";
    const contextSections = await db.execute({
      sql: "SELECT section_key, section_title, device_id, enabled FROM crow_context ORDER BY sort_order, section_key",
      args: [],
    });

    const globalSections = contextSections.rows.filter((r) => !r.device_id);
    const deviceSections = currentDeviceId
      ? contextSections.rows.filter((r) => r.device_id === currentDeviceId)
      : [];
    const overriddenKeys = new Set(deviceSections.map((r) => r.section_key));

    let contextRows = globalSections.map((s) => {
      const hasOverride = overriddenKeys.has(s.section_key);
      const statusBadge = hasOverride
        ? `${badge(t("settings.overriddenBadge", lang), "connected")}`
        : badge(s.enabled ? t("settings.activeBadge", lang) : t("settings.disabledBadge", lang), s.enabled ? "published" : "draft");
      return [
        escapeHtml(s.section_title),
        `<span class="mono" style="font-size:0.8rem">${escapeHtml(s.section_key)}</span>`,
        statusBadge,
      ];
    });

    const deviceLabel = currentDeviceId
      ? `<span class="mono" style="font-size:0.85rem">${escapeHtml(currentDeviceId)}</span>`
      : `<span style="color:var(--crow-text-muted)">${t("settings.notSetDevice", lang)}</span>`;

    const deviceContextHtml = `
      <div style="margin-bottom:1rem">
        <span style="color:var(--crow-text-muted);font-size:0.85rem">${t("settings.deviceId", lang)}</span> ${deviceLabel}
      </div>
      ${dataTable([t("settings.sectionColumn", lang), t("settings.keyColumn", lang), t("settings.statusColumn", lang)], contextRows)}
      <p style="color:var(--crow-text-muted);font-size:0.8rem;margin-top:0.75rem">
        Set <code>CROW_DEVICE_ID</code> in .env to enable per-device context overrides.
        ${currentDeviceId ? `This device has ${deviceSections.length} override(s). ` : ""}
        Manage context via your AI: <em>"Crow, update my context to prefer Spanish responses"</em> or use the <code>crow_add_context_section</code> / <code>crow_update_context_section</code> tools with a <code>device_id</code>.
      </p>`;

    // Help & Setup section — platform guides + context usage
    const helpT = {
      en: {
        platformSetup: "Quick Setup by Platform",
        contextUsage: "Context Usage",
        toolsLoaded: "tools loaded",
        core: "core", external: "external",
        tokensOfContext: "tokens of context",
        routerAvailable: "Router available",
        contextDoc: 'Learn more about <a href="https://maestro.press/software/crow/guide/cross-platform" style="color:var(--crow-accent);text-decoration:none">context management and the router</a>.',
        claudeWebInstr: "Settings &rarr; Integrations &rarr; Add Custom &rarr; paste <code>/mcp</code> URL",
        claudeDesktopInstr: "Use stdio transport (see docs)",
        chatgptInstr: "Settings &rarr; Apps &rarr; Create &rarr; paste <code>/sse</code> URL",
        geminiInstr: "Add to <code>~/.gemini/settings.json</code> with <code>url</code> property",
        cursorInstr: "Add to <code>.cursor/mcp.json</code> with <code>url</code> property",
        windsurfInstr: "Add to <code>~/.codeium/windsurf/mcp_config.json</code>",
        clineInstr: "VS Code MCP settings &rarr; add server URL",
        claudeCodeInstr: "Add to <code>.mcp.json</code> or <code>~/.claude/mcp.json</code>",
      },
      es: {
        platformSetup: "Configuración Rápida por Plataforma",
        contextUsage: "Uso de Contexto",
        toolsLoaded: "herramientas cargadas",
        core: "base", external: "externas",
        tokensOfContext: "tokens de contexto",
        routerAvailable: "Router disponible",
        contextDoc: 'Aprende más sobre <a href="https://maestro.press/software/crow/guide/cross-platform" style="color:var(--crow-accent);text-decoration:none">gestión de contexto y el router</a>.',
        claudeWebInstr: "Settings &rarr; Integrations &rarr; Add Custom &rarr; pega la URL <code>/mcp</code>",
        claudeDesktopInstr: "Usa transporte stdio (ver docs)",
        chatgptInstr: "Settings &rarr; Apps &rarr; Create &rarr; pega la URL <code>/sse</code>",
        geminiInstr: "Agrega a <code>~/.gemini/settings.json</code> con la propiedad <code>url</code>",
        cursorInstr: "Agrega a <code>.cursor/mcp.json</code> con la propiedad <code>url</code>",
        windsurfInstr: "Agrega a <code>~/.codeium/windsurf/mcp_config.json</code>",
        clineInstr: "VS Code MCP settings &rarr; agrega la URL del servidor",
        claudeCodeInstr: "Agrega a <code>.mcp.json</code> o <code>~/.claude/mcp.json</code>",
      },
    };
    const ht = helpT[currentLang] || helpT.en;
    const docsBase = "https://maestro.press/software/crow/platforms";
    const platforms = [
      { name: "Claude Web/Mobile", slug: "claude", instr: ht.claudeWebInstr },
      { name: "Claude Desktop", slug: "claude-desktop", instr: ht.claudeDesktopInstr },
      { name: "ChatGPT", slug: "chatgpt", instr: ht.chatgptInstr },
      { name: "Gemini CLI", slug: "gemini-cli", instr: ht.geminiInstr },
      { name: "Cursor", slug: "cursor", instr: ht.cursorInstr },
      { name: "Windsurf", slug: "windsurf", instr: ht.windsurfInstr },
      { name: "Cline", slug: "cline", instr: ht.clineInstr },
      { name: "Claude Code", slug: "claude-code", instr: ht.claudeCodeInstr },
    ];
    const platformListHtml = platforms.map(p =>
      `<li><a href="${docsBase}/${p.slug}" target="_blank" rel="noopener" style="color:var(--crow-accent);text-decoration:none;font-weight:600">${escapeHtml(p.name)}</a> &mdash; ${p.instr}</li>`
    ).join("\n");

    // Context usage from proxy status
    const coreTools = 49;
    let externalToolCount = 0;
    for (const s of proxyStatus) {
      if (s.status === "connected") externalToolCount += (s.toolCount || 0);
    }
    const totalTools = coreTools + externalToolCount;
    const estimatedTokens = totalTools * 200;
    const routerDisabled = process.env.CROW_DISABLE_ROUTER === "1";

    const helpHtml = `
      <h4 style="font-size:0.9rem;color:var(--crow-text-muted);margin-bottom:0.5rem">${ht.platformSetup}</h4>
      <ul style="font-size:0.85rem;padding-left:1.2rem;list-style:disc;line-height:1.8">
        ${platformListHtml}
      </ul>
      <h4 style="font-size:0.9rem;color:var(--crow-text-muted);margin:1.25rem 0 0.5rem">${ht.contextUsage}</h4>
      <div style="display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap">
        <span style="font-size:0.95rem;font-weight:600">${totalTools} ${ht.toolsLoaded}</span>
        <span style="font-size:0.8rem;color:var(--crow-text-muted)">${coreTools} ${ht.core} + ${externalToolCount} ${ht.external} &mdash; ~${(estimatedTokens / 1000).toFixed(1)}K ${ht.tokensOfContext}</span>
        ${!routerDisabled ? `<span style="font-size:0.75rem;background:color-mix(in srgb, var(--crow-success) 15%, transparent);color:var(--crow-success);padding:2px 8px;border-radius:4px">${ht.routerAvailable}</span>` : ""}
      </div>
      <p style="color:var(--crow-text-muted);font-size:0.8rem;margin-top:0.5rem">${ht.contextDoc}</p>`;

    // AI Profiles
    const profilesResult = await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = 'ai_profiles'", args: [] });
    let aiProfiles = [];
    try { aiProfiles = JSON.parse(profilesResult.rows[0]?.value || "[]"); } catch {}

    let profilesHtml = `<style>
      .profile-card { border:1px solid var(--crow-border); border-radius:8px; padding:0.75rem 1rem; margin-bottom:0.5rem; background:var(--crow-surface); }
      .profile-card-header { display:flex; align-items:center; justify-content:space-between; gap:0.5rem; }
      .profile-card-name { font-weight:600; font-size:0.95rem; }
      .profile-card-meta { font-size:0.8rem; color:var(--crow-text-muted); }
      .profile-card-actions { display:flex; gap:0.5rem; margin-top:0.5rem; }
      .profile-form { border:1px solid var(--crow-border); border-radius:8px; padding:1rem; margin-top:0.75rem; background:var(--crow-surface); }
    </style>`;

    // List existing profiles
    for (const p of aiProfiles) {
      const maskedKey = p.apiKey ? "••••" + p.apiKey.slice(-4) : t("settings.notSet", lang);
      profilesHtml += `<div class="profile-card" data-profile-id="${escapeHtml(p.id)}">
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

    // Add profile form (hidden by default, toggled by button)
    profilesHtml += `
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
      document.getElementById('pf-key').placeholder = '${t("settings.leaveBlankKeep", lang)}';
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
        el.textContent = data.ok ? '${t("settings.savedReloading", lang)}' : (data.error || '${t("settings.saveFailed", lang)}');
        if (data.ok) setTimeout(function(){ location.reload(); }, 500);
      } catch(e) { el.style.color='var(--crow-error)'; el.textContent='Save failed: '+e.message; }
    }

    async function deleteProfile(id, btn) {
      if (!confirm('${t("settings.deleteProfileConfirm", lang)}')) return;
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
      btn.textContent = '${t("settings.testing", lang)}';
      var params = new URLSearchParams();
      params.set('action', 'test_ai_profile');
      params.set('profile_id', id);
      try {
        var res = await fetch('/dashboard/settings', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:params.toString() });
        var data = await res.json();
        btn.textContent = data.ok ? '${t("settings.connectedStatus", lang)}' : '${t("settings.failedStatus", lang)}';
        btn.style.color = data.ok ? 'var(--crow-success)' : 'var(--crow-error)';
        setTimeout(function(){ btn.textContent='${t("settings.testProfile", lang)}'; btn.style.color=''; btn.disabled=false; }, 3000);
      } catch(e) { btn.textContent='Error'; btn.disabled=false; }
    }
    <\/script>
    <p style="color:var(--crow-text-muted);font-size:0.8rem;margin-top:0.75rem">
      AI Profiles let you configure multiple providers and switch between them in the Messages panel. Each profile has its own API key, endpoint, and model list.
    </p>`;

    // Notification preferences
    let notifPrefs = { types_enabled: ["reminder", "media", "peer", "system"] };
    try {
      const { rows: notifRows } = await db.execute({
        sql: "SELECT value FROM dashboard_settings WHERE key = 'notification_prefs'",
        args: [],
      });
      if (notifRows.length > 0) notifPrefs = JSON.parse(notifRows[0].value);
    } catch {}
    const notifTypes = [
      { key: "reminder", label: t("settings.notifReminder", lang) },
      { key: "media", label: t("settings.notifMedia", lang) },
      { key: "peer", label: t("settings.notifPeer", lang) },
      { key: "system", label: t("settings.notifSystem", lang) },
    ];
    const notifCheckboxes = notifTypes.map(({ key, label }) => {
      const checked = notifPrefs.types_enabled?.includes(key) ? "checked" : "";
      return `<label style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.5rem;cursor:pointer">
        <input type="checkbox" name="type_${key}" value="1" ${checked} style="accent-color:var(--crow-accent)"> ${escapeHtml(label)}
      </label>`;
    }).join("");
    const notifForm = `
      <form method="POST" action="/dashboard/settings">
        <input type="hidden" name="_csrf" value="${req.csrfToken}" />
        <input type="hidden" name="action" value="save_notification_prefs" />
        <p style="color:var(--crow-text-muted);font-size:0.85rem;margin-bottom:0.75rem">${t("settings.notifTypes", lang)}</p>
        ${notifCheckboxes}
        <button type="submit" class="btn btn-primary" style="margin-top:0.5rem">${t("common.save", lang)}</button>
      </form>`;

    const content = `
      ${successMsg}${errorMsg}
      ${stats}
      ${section(t("settings.aiProfilesSection", lang), profilesHtml, { delay: 18 })}
      ${section(t("settings.aiProviderSection", lang), aiProviderHtml, { delay: 20 })}
      ${section(t("settings.connectionUrls", lang), connectionHtml, { delay: 25 })}
      ${section(t("settings.helpSetupSection", lang), helpHtml, { delay: 28 })}
      ${section(t("settings.deviceContextSection", lang), deviceContextHtml, { delay: 40 })}
      ${section(t("settings.updatesSection", lang), updateHtml, { delay: 50 })}
      ${section(t("settings.integrationsSection", lang), integrationsHtml, { delay: 100 })}
      ${section(t("settings.identitySection", lang), identityHtml, { delay: 200 })}
      ${section(t("settings.blogSettingsSection", lang), blogForm, { delay: 250 })}
      ${section(t("settings.contactDiscoverySection", lang), discoveryForm, { delay: 300 })}
      ${section(t("settings.notifications", lang), notifForm, { delay: 325 })}
      ${section(t("settings.changePasswordSection", lang), passwordForm, { delay: 350 })}
      ${section(t("settings.languageSection", lang), langForm, { delay: 375 })}
    `;

    return layout({ title: t("settings.pageTitle", lang), content });
  },
};
