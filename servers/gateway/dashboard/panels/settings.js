/**
 * Settings Panel — Integrations, identity, blog settings, theme, password
 */

import { escapeHtml, statCard, statGrid, section, formField, badge, dataTable } from "../shared/components.js";
import { getProxyStatus } from "../../proxy.js";
import { getUpdateStatus, checkForUpdates } from "../../auto-update.js";

export default {
  id: "settings",
  name: "Settings",
  icon: "settings",
  route: "/dashboard/settings",
  navOrder: 90,

  async handler(req, res, { db, layout }) {
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
        const { scrypt, randomBytes, timingSafeEqual } = await import("node:crypto");
        const { setPassword } = await import("../auth.js");
        const { password, confirm } = req.body;
        if (!password || password.length < 6) {
          // Re-render with error (simplified — redirect back)
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
      ? `<div class="alert alert-success">Password updated.</div>` : "";
    const errorMsg = req.query.error === "short"
      ? `<div class="alert alert-error">Password must be at least 6 characters.</div>`
      : req.query.error === "mismatch"
      ? `<div class="alert alert-error">Passwords don't match.</div>` : "";

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

    const categoryLabels = { productivity: "Productivity", communication: "Communication", development: "Development" };

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
        const connectedBadge = isConnected ? ` ${badge("Connected", "connected")}` : "";
        const toolCount = item.proxyStatus?.toolCount ? ` <span class="mono" style="font-size:0.8rem;color:var(--crow-text-muted)">${item.proxyStatus.toolCount} tools</span>` : "";

        let bodyContent = "";

        if (hasEnvVars) {
          for (const envVar of item.envVars) {
            const currentVal = process.env[envVar] ? "••••••••" : "";
            bodyContent += `<div class="int-field">
              <label>${escapeHtml(envVar)}</label>
              <input type="password" name="${escapeHtml(envVar)}" placeholder="${currentVal || "Not set"}" autocomplete="off">
            </div>`;
          }
        } else {
          bodyContent += `<p class="int-note">No configuration needed — works out of the box.</p>`;
        }

        if (requiresMissing) {
          bodyContent += `<p class="int-note">Requires ${item.requires.map((r) => `<code>${escapeHtml(r)}</code>`).join(", ")} (Python)</p>`;
        }

        let links = "";
        if (item.keyUrl) {
          links += `<a href="${escapeHtml(item.keyUrl)}" target="_blank" rel="noopener" class="int-link">Get API Key</a>`;
        }
        if (item.docsUrl) {
          links += `<a href="${escapeHtml(item.docsUrl)}" target="_blank" rel="noopener" class="int-link">Docs</a>`;
        }

        const saveBtn = hasEnvVars ? `<button class="btn btn-primary btn-sm" onclick="saveIntegration('${escapeHtml(item.id)}',this)">Save</button>` : "";
        const removeBtn = isConnected ? `<button class="btn btn-secondary btn-sm" onclick="removeIntegration('${escapeHtml(item.id)}',this)">Remove</button>` : "";

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
  btn.textContent = 'Saving...';
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
      msg.textContent = data.restarting ? 'Saved. Gateway restarting...' : 'Saved. Restart gateway to activate.';
      if (data.restarting) {
        setTimeout(() => { pollHealth(); }, 2000);
      }
    } else {
      msg.style.color = 'var(--crow-error)';
      msg.textContent = data.error || 'Save failed.';
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
  btn.textContent = 'Save';
}

async function removeIntegration(id, btn) {
  if (!confirm('Remove this integration? Its API keys will be commented out in .env.')) return;
  btn.disabled = true;
  btn.textContent = 'Removing...';
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
  btn.textContent = 'Remove';
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
        <div style="margin-bottom:0.5rem"><span style="color:var(--crow-text-muted)">Crow ID:</span> ${escapeHtml(identity.crowId)}</div>
        <div><span style="color:var(--crow-text-muted)">Ed25519:</span> ${escapeHtml(identity.ed25519Public?.slice(0, 16))}...</div>
      </div>`;
    } catch {
      identityHtml = `<p style="color:var(--crow-text-muted)">Identity not available.</p>`;
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
      ${formField("Blog Title", "blog_title", { value: bs.blog_title || "Crow Blog", placeholder: "My Blog" })}
      ${formField("Tagline", "blog_tagline", { value: bs.blog_tagline || "", placeholder: "A short description" })}
      ${formField("Default Author", "blog_author", { value: bs.blog_author || "" })}
      ${formField("Theme", "blog_theme", { type: "select", value: bs.blog_theme || "dark", options: [
        { value: "dark", label: "Dark (default)" },
        { value: "light", label: "Light" },
        { value: "serif", label: "Serif" },
      ]})}
      ${formField("Blog Discovery", "blog_listed", { type: "select", value: bs.blog_listed || "false", options: [
        { value: "false", label: "Not listed" },
        { value: "true", label: "Listed in Crow Blog Registry" },
      ]})}
      <p style="color:var(--crow-text-muted);font-size:0.85rem;margin:-0.5rem 0 1rem">When listed, your blog appears in the Crow Blog Registry so other Crow users can discover it.</p>
      <button type="submit" class="btn btn-primary">Save Blog Settings</button>
    </form>`;

    // Contact discovery
    const discoveryForm = `<form method="POST">
      <input type="hidden" name="action" value="update_discovery">
      ${formField("Contact Discovery", "discovery_enabled", { type: "select", value: bs.discovery_enabled || "false", options: [
        { value: "false", label: "Disabled" },
        { value: "true", label: "Enabled — findable by other Crow users" },
      ]})}
      <p style="color:var(--crow-text-muted);font-size:0.85rem;margin:-0.5rem 0 1rem">When enabled, your Crow ID and display name are visible at /discover/profile. Other Crow users can find you and send invite requests.</p>
      ${formField("Display Name", "discovery_name", { type: "text", value: bs.discovery_name || "", placeholder: "Name shown to other Crow users" })}
      <button type="submit" class="btn btn-primary">Save Discovery Settings</button>
    </form>`;

    // Password change
    const passwordForm = `<form method="POST">
      <input type="hidden" name="action" value="change_password">
      ${formField("New Password", "password", { type: "password", required: true, placeholder: "At least 6 characters" })}
      ${formField("Confirm Password", "confirm", { type: "password", required: true })}
      <button type="submit" class="btn btn-secondary">Change Password</button>
    </form>`;

    // Auto-update status
    const updateStatus = await getUpdateStatus();
    const lastCheckDisplay = updateStatus.lastCheck
      ? new Date(updateStatus.lastCheck).toLocaleString()
      : "Never";
    const versionDisplay = updateStatus.currentVersion || "unknown";

    const updateHtml = `
      <div style="display:flex;flex-wrap:wrap;gap:1rem;margin-bottom:1rem">
        <div style="flex:1;min-width:200px">
          <div style="font-size:0.8rem;color:var(--crow-text-muted);margin-bottom:0.25rem">Current Version</div>
          <div style="font-family:'JetBrains Mono',monospace;font-size:0.95rem">${escapeHtml(versionDisplay)}</div>
        </div>
        <div style="flex:1;min-width:200px">
          <div style="font-size:0.8rem;color:var(--crow-text-muted);margin-bottom:0.25rem">Last Checked</div>
          <div style="font-size:0.9rem">${escapeHtml(lastCheckDisplay)}</div>
        </div>
        <div style="flex:1;min-width:200px">
          <div style="font-size:0.8rem;color:var(--crow-text-muted);margin-bottom:0.25rem">Status</div>
          <div style="font-size:0.9rem">${escapeHtml(updateStatus.lastResult || "Waiting for first check")}</div>
        </div>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:0.75rem;align-items:end;margin-bottom:1rem">
        <div>
          <label style="display:block;font-size:0.8rem;color:var(--crow-text-muted);margin-bottom:0.25rem">Auto-Update</label>
          <select id="update-enabled" style="padding:0.5rem;border:1px solid var(--crow-border);border-radius:4px;background:var(--crow-bg);color:var(--crow-text);font-size:0.85rem">
            <option value="true"${updateStatus.enabled ? " selected" : ""}>Enabled</option>
            <option value="false"${!updateStatus.enabled ? " selected" : ""}>Disabled</option>
          </select>
        </div>
        <div>
          <label style="display:block;font-size:0.8rem;color:var(--crow-text-muted);margin-bottom:0.25rem">Check Interval</label>
          <select id="update-interval" style="padding:0.5rem;border:1px solid var(--crow-border);border-radius:4px;background:var(--crow-bg);color:var(--crow-text);font-size:0.85rem">
            <option value="1"${updateStatus.intervalHours === 1 ? " selected" : ""}>Every hour</option>
            <option value="6"${updateStatus.intervalHours === 6 ? " selected" : ""}>Every 6 hours</option>
            <option value="12"${updateStatus.intervalHours === 12 ? " selected" : ""}>Every 12 hours</option>
            <option value="24"${updateStatus.intervalHours === 24 ? " selected" : ""}>Daily</option>
          </select>
        </div>
        <button class="btn btn-secondary btn-sm" id="save-update-settings">Save</button>
        <button class="btn btn-primary btn-sm" id="check-updates-now">Check Now</button>
      </div>
      <div id="update-status-msg" style="font-size:0.85rem;display:none"></div>
      <p style="color:var(--crow-text-muted);font-size:0.8rem;margin-top:0.5rem">
        Auto-updates pull the latest code from GitHub and restart the gateway. You can also disable with <code>CROW_AUTO_UPDATE=0</code> in your .env file.
      </p>
      <script>
      document.getElementById('save-update-settings').addEventListener('click', async function() {
        const btn = this;
        btn.disabled = true;
        btn.textContent = 'Saving...';
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
        btn.textContent = 'Save';
      });

      document.getElementById('check-updates-now').addEventListener('click', async function() {
        const btn = this;
        btn.disabled = true;
        btn.textContent = 'Checking...';
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
            msg.textContent = 'Already up to date.';
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
        btn.textContent = 'Check Now';
      });
      <\/script>`;

    // Core server stats
    const memoryCount = await db.execute("SELECT COUNT(*) as c FROM memories");
    const sourceCount = await db.execute("SELECT COUNT(*) as c FROM research_sources");
    const contactCount = await db.execute("SELECT COUNT(*) as c FROM contacts WHERE is_blocked = 0");
    const postCount = await db.execute("SELECT COUNT(*) as c FROM blog_posts");

    const stats = statGrid([
      statCard("Memories", memoryCount.rows[0]?.c || 0, { delay: 0 }),
      statCard("Sources", sourceCount.rows[0]?.c || 0, { delay: 50 }),
      statCard("Contacts", contactCount.rows[0]?.c || 0, { delay: 100 }),
      statCard("Posts", postCount.rows[0]?.c || 0, { delay: 150 }),
    ]);

    // Connection URLs
    const gatewayUrl = process.env.CROW_GATEWAY_URL || "";
    const tailscaleIp = process.env.TAILSCALE_IP || "";
    const localUrl = `http://localhost:${process.env.PORT || process.env.CROW_GATEWAY_PORT || 3001}`;
    const requestUrl = `${req.protocol}://${req.get("host")}`;

    let urlRows = [];
    urlRows.push([
      "Local",
      `<code style="font-size:0.85rem;word-break:break-all">${escapeHtml(localUrl)}</code>`,
      badge("always", "connected"),
    ]);
    if (requestUrl !== localUrl) {
      urlRows.push([
        "Tailnet / LAN",
        `<code style="font-size:0.85rem;word-break:break-all">${escapeHtml(requestUrl)}</code>`,
        badge("active", "connected"),
      ]);
    }
    if (gatewayUrl) {
      urlRows.push([
        "Public (blog only)",
        `<a href="${escapeHtml(gatewayUrl)}/blog/" target="_blank" style="font-size:0.85rem;word-break:break-all">${escapeHtml(gatewayUrl)}/blog/</a>`,
        badge("live", "published"),
      ]);
    }
    urlRows.push([
      "Setup Page",
      `<a href="/setup" target="_blank" style="font-size:0.85rem">/setup</a>`,
      `<span style="color:var(--crow-text-muted);font-size:0.85rem">MCP endpoints &amp; API keys</span>`,
    ]);

    const connectionHtml = dataTable(["Context", "URL", "Status"], urlRows)
      + `<p style="color:var(--crow-text-muted);font-size:0.8rem;margin-top:0.75rem">The Crow's Nest is private (local/Tailscale only). Set <code>CROW_GATEWAY_URL</code> in .env for public blog/podcast URLs.</p>`;

    const content = `
      ${successMsg}${errorMsg}
      ${stats}
      ${section("Connection URLs", connectionHtml, { delay: 25 })}
      ${section("Updates", updateHtml, { delay: 50 })}
      ${section("Integrations", integrationsHtml, { delay: 100 })}
      ${section("Identity", identityHtml, { delay: 200 })}
      ${section("Blog Settings", blogForm, { delay: 250 })}
      ${section("Contact Discovery", discoveryForm, { delay: 300 })}
      ${section("Change Password", passwordForm, { delay: 350 })}
    `;

    return layout({ title: "Settings", content });
  },
};
