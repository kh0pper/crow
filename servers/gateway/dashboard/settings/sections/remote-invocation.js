/**
 * Settings Section: Remote Tool Invocation (Multi-Instance group) — F4a Layer 2b.
 *
 * Toggles feature_flags.remote_invocation (local-only; NOT in SYNC_ALLOWLIST).
 * When OFF (default), pi-bots on this instance cannot invoke any peer tool and
 * the Bot Builder remote group stays read-only. When ON, a bot may be wired to
 * call capabilities a peer has EXPOSED (L2a) — the peer's gate is the boundary.
 */
import { readSetting, writeSetting } from "../registry.js";

async function readFlags(db) {
  const raw = await readSetting(db, "feature_flags");
  if (!raw) return {};
  try { return JSON.parse(raw) || {}; } catch { return {}; }
}

export default {
  id: "remote-invocation",
  group: "multiInstance",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/><circle cx="4" cy="12" r="1"/></svg>`,
  labelKey: "settings.section.remoteInvocation",
  navOrder: 7,

  async getPreview({ settings }) {
    let on = false;
    try { on = JSON.parse(settings?.feature_flags || "{}")?.remote_invocation === true; } catch {}
    return on ? "enabled" : "disabled";
  },

  async render({ db }) {
    const flags = await readFlags(db);
    const on = flags.remote_invocation === true;
    return `<form method="POST">
      <input type="hidden" name="action" value="set_remote_invocation">
      <div style="margin-bottom:1rem;color:var(--crow-text-secondary);font-size:0.9rem;line-height:1.5">
        When enabled, bots built here can be wired (in the Bot Builder) to call tools that
        a <strong>trusted peer instance has exposed</strong> (Settings &rarr; Remote Tool Exposure on that peer).
        The peer enforces what's allowed; destructive tools still require their confirmation.
        Off by default. <strong>Local to this instance, never synced.</strong>
      </div>
      <label style="display:flex;align-items:center;gap:0.6rem;cursor:pointer">
        <input type="checkbox" name="enabled" ${on ? "checked" : ""}>
        <span>Allow this instance's bots to invoke exposed peer tools</span>
      </label>
      <div style="margin-top:1.5rem"><button type="submit" class="btn btn-secondary">Save</button></div>
    </form>`;
  },

  async handleAction({ req, res, db, action }) {
    if (action !== "set_remote_invocation") return false;
    const flags = await readFlags(db);
    flags.remote_invocation = req.body.enabled === "on";
    await writeSetting(db, "feature_flags", JSON.stringify(flags), { scope: "local" });
    res.redirectAfterPost("/dashboard/settings?section=remote-invocation");
    return true;
  },
};
