/**
 * Settings Section: Bot Runtime (Multi-Instance group) — F3b.
 *
 * Toggles feature_flags.bot_runtime (local-only; absent from sync-allowlist).
 * When ON, this instance's installed bot-runtime units (pibot-*@<instance>)
 * actually run bots (poll Gmail / answer Telegram/Slack/Discord); the runners
 * self-gate on this flag with no restart. OFF = installed-but-idle. Requires
 * the units to be installed first (scripts/pi-bots/install-runtime.sh).
 */
import { readSetting, writeSetting } from "../registry.js";

async function readFlags(db) {
  const raw = await readSetting(db, "feature_flags");
  if (!raw) return {};
  try { return JSON.parse(raw) || {}; } catch { return {}; }
}

export default {
  id: "bot-runtime",
  group: "multiInstance",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9h6v6H9z"/></svg>`,
  labelKey: "settings.section.botRuntime",
  navOrder: 8,

  async getPreview({ settings }) {
    let on = false;
    try { on = JSON.parse(settings?.feature_flags || "{}")?.bot_runtime === true; } catch {}
    return on ? "enabled" : "disabled";
  },

  async render({ db }) {
    const flags = await readFlags(db);
    const on = flags.bot_runtime === true;
    return `<form method="POST">
      <input type="hidden" name="action" value="set_bot_runtime">
      <div style="margin-bottom:1rem;color:var(--crow-text-secondary);font-size:0.9rem;line-height:1.5">
        When enabled, this instance <strong>runs</strong> the bots defined here — polling Gmail and
        answering Telegram / Slack / Discord. The runtime units must be installed first
        (<code>scripts/pi-bots/install-runtime.sh</code>); this toggle then starts/stops them with no restart.
        Off by default. <strong>Local to this instance, never synced.</strong>
      </div>
      <label style="display:flex;align-items:center;gap:0.6rem;cursor:pointer">
        <input type="checkbox" name="enabled" ${on ? "checked" : ""}>
        <span>Run bots on this instance</span>
      </label>
      <div style="margin-top:1.5rem"><button type="submit" class="btn btn-secondary">Save</button></div>
    </form>`;
  },

  async handleAction({ req, res, db, action }) {
    if (action !== "set_bot_runtime") return false;
    const flags = await readFlags(db);
    flags.bot_runtime = req.body.enabled === "on";
    await writeSetting(db, "feature_flags", JSON.stringify(flags), { scope: "local" });
    res.redirectAfterPost("/dashboard/settings?section=bot-runtime");
    return true;
  },
};
