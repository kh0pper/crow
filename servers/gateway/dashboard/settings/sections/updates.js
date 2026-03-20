/**
 * Settings Section: Updates
 */

import { escapeHtml } from "../../shared/components.js";
import { t, tJs } from "../../shared/i18n.js";
import { upsertSetting } from "../registry.js";

export default {
  id: "updates",
  group: "system",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`,
  labelKey: "settings.section.updates",
  navOrder: 10,

  async getPreview() {
    try {
      const { getUpdateStatus } = await import("../../../auto-update.js");
      const status = await getUpdateStatus();
      return status.currentVersion || "unknown";
    } catch {
      return "";
    }
  },

  async render({ lang }) {
    const { getUpdateStatus } = await import("../../../auto-update.js");
    const updateStatus = await getUpdateStatus();
    const lastCheckDisplay = updateStatus.lastCheck
      ? new Date(updateStatus.lastCheck).toLocaleString()
      : t("settings.never", lang);
    const versionDisplay = updateStatus.currentVersion || "unknown";

    return `
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
        btn.textContent = '${tJs("settings.saving", lang)}';
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
        btn.textContent = '${tJs("settings.save", lang)}';
      });

      document.getElementById('check-updates-now').addEventListener('click', async function() {
        const btn = this;
        btn.disabled = true;
        btn.textContent = '${tJs("settings.checking", lang)}';
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
            msg.textContent = '${tJs("settings.alreadyUpToDate", lang)}';
          }
        } catch (e) {
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
        btn.textContent = '${tJs("settings.checkNow", lang)}';
      });
      <\/script>`;
  },

  async handleAction({ req, res, db, action }) {
    if (action === "save_update_settings") {
      const enabled = req.body.auto_update_enabled || "true";
      const interval = req.body.auto_update_interval_hours || "6";
      await upsertSetting(db, "auto_update_enabled", enabled);
      await upsertSetting(db, "auto_update_interval_hours", interval);
      res.json({ ok: true, message: "Update settings saved. Restart gateway to apply new interval." });
      return true;
    }

    if (action === "check_updates_now") {
      const { checkForUpdates } = await import("../../../auto-update.js");
      const result = await checkForUpdates();
      res.json({ ok: true, ...result });
      return true;
    }

    return false;
  },
};
