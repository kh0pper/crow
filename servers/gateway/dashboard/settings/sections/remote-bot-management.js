/**
 * Settings Section: Remote Bot Management (Multi-Instance group) — F4a Layer 3.
 *
 * Toggles feature_flags.remote_bot_management (local-only; NOT in SYNC_ALLOWLIST).
 * Master switch. When ON, trusted peers may edit (non-secret fields) and
 * enable/disable any of THIS instance's bots that are individually marked
 * "manageable by peers" in the Bot Builder. Default OFF. The per-bot opt-in
 * (remote_managed_bots) is the second required condition; this is the global
 * kill-switch.
 */
import { readSetting, writeSetting } from "../registry.js";

async function readFlags(db) {
  const raw = await readSetting(db, "feature_flags");
  if (!raw) return {};
  try { return JSON.parse(raw) || {}; } catch { return {}; }
}

export default {
  id: "remote-bot-management",
  group: "multiInstance",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/></svg>`,
  labelKey: "settings.section.remoteBotManagement",
  navOrder: 8,

  async getPreview({ settings }) {
    let on = false;
    try { on = JSON.parse(settings?.feature_flags || "{}")?.remote_bot_management === true; } catch {}
    return on ? "enabled" : "disabled";
  },

  async render({ db }) {
    const flags = await readFlags(db);
    const on = flags.remote_bot_management === true;
    return `<form method="POST">
      <input type="hidden" name="action" value="set_remote_bot_management">
      <div style="margin-bottom:1rem;color:var(--crow-text-secondary);font-size:0.9rem;line-height:1.5">
        When enabled, a <strong>trusted peer instance</strong> can edit the non-secret settings
        (prompt, model, tools, skills, permissions) and enable/disable any of this instance's bots
        that you mark <strong>"Manageable by trusted peers"</strong> in the Bot Builder. Gateway
        credentials are never exposed or settable remotely. The bot always runs here.
        Off by default. <strong>Local to this instance, never synced.</strong>
      </div>
      <label style="display:flex;align-items:center;gap:0.6rem;cursor:pointer">
        <input type="checkbox" name="enabled" ${on ? "checked" : ""}>
        <span>Allow trusted peers to manage exposed bots on this instance</span>
      </label>
      <div style="margin-top:1.5rem"><button type="submit" class="btn btn-secondary">Save</button></div>
    </form>`;
  },

  async handleAction({ req, res, db, action }) {
    if (action !== "set_remote_bot_management") return false;
    const flags = await readFlags(db);
    flags.remote_bot_management = req.body.enabled === "on";
    await writeSetting(db, "feature_flags", JSON.stringify(flags), { scope: "local" });
    res.redirectAfterPost("/dashboard/settings?section=remote-bot-management");
    return true;
  },
};
