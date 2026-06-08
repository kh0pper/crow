/**
 * Settings Section: Remote Tool Exposure (Multi-Instance group) — F4a Layer 2a.
 *
 * Per-instance, LOCAL-ONLY (never synced) allowlist of capabilities this
 * instance lets trusted peer instances invoke. Default = nothing exposed
 * (deny-all). The authoritative enforcement is server-side in
 * peer-exposure.js; this UI only edits the `remote_exposed_tools` setting.
 *
 * `remote_exposed_tools` is deliberately ABSENT from sync-allowlist.js, so
 * writeSetting downgrades it to local scope automatically — each instance is
 * sovereign over what it exposes.
 */
import { writeSetting } from "../registry.js";
import { getLocalCatalog } from "../../../capability-registry.js";
import { getOrCreateLocalInstanceId } from "../../../instance-registry.js";
import { escapeHtml } from "../../shared/components.js";

export default {
  id: "remote-exposure",
  group: "multiInstance",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v6m0 6v6"/><path d="M4.2 4.2l4.2 4.2m6.4 6.4l4.2 4.2"/><path d="M1 12h6m6 0h6"/></svg>`,
  labelKey: "settings.section.remoteExposure",
  navOrder: 6,

  async getPreview({ settings }) {
    let n = 0;
    try {
      const arr = JSON.parse(settings?.remote_exposed_tools || "[]");
      n = Array.isArray(arr) ? arr.filter((x) => typeof x === "string" && x.length > 0).length : 0;
    } catch { n = 0; }
    return n === 0 ? "none exposed" : `${n} exposed`;
  },

  async render({ db }) {
    const catalog = await getLocalCatalog(db, { instanceId: getOrCreateLocalInstanceId() });
    // Distinct capabilities by canonicalId (core categories + installed addons).
    const seen = new Set();
    const caps = [];
    for (const t of catalog.tools) {
      if (!t.canonicalId || seen.has(t.canonicalId)) continue;
      seen.add(t.canonicalId);
      caps.push(t);
    }
    caps.sort((a, b) => String(a.name).localeCompare(String(b.name)));

    const rows = caps.map((c) => {
      const on = c.exposed === true;
      return `<label style="display:flex;align-items:center;gap:0.6rem;padding:0.4rem 0;border-bottom:1px solid var(--crow-border,#2222)">
        <input type="checkbox" name="cap" value="${escapeHtml(c.canonicalId)}" ${on ? "checked" : ""}>
        <span style="flex:1">${escapeHtml(c.name)} <span style="color:var(--crow-text-muted);font-size:0.85rem">(${escapeHtml(c.category)}${c.bundleId ? " · addon" : ""})</span></span>
        <code style="color:var(--crow-text-muted);font-size:0.8rem">${escapeHtml(c.canonicalId)}</code>
      </label>`;
    }).join("");

    return `<form method="POST">
      <input type="hidden" name="action" value="set_remote_exposure">
      <div style="margin-bottom:1rem;color:var(--crow-text-secondary);font-size:0.9rem;line-height:1.5">
        Choose which capabilities <strong>trusted paired instances</strong> may invoke on this
        instance. Exposing a capability lets a peer's bots/agents run its tools here;
        destructive tools still require their in-tool confirmation. Nothing is exposed by
        default. <strong>This setting is local to this instance and never synced.</strong>
      </div>
      <div style="border:1px solid var(--crow-border,#2222);border-radius:8px;padding:0 0.8rem">
        ${rows || '<p style="color:var(--crow-text-muted);padding:0.8rem 0">No capabilities found on this instance.</p>'}
      </div>
      <div style="margin-top:1.5rem">
        <button type="submit" class="btn btn-secondary">Save exposure</button>
      </div>
    </form>`;
  },

  async handleAction({ req, res, db, action }) {
    if (action !== "set_remote_exposure") return false;
    // Checkboxes: req.body.cap is a string (one) or array (many) or undefined (none).
    let selected = req.body.cap;
    if (selected == null) selected = [];
    else if (!Array.isArray(selected)) selected = [selected];
    const clean = [...new Set(selected.filter((x) => typeof x === "string" && x.length > 0))];
    // Local scope (not in sync-allowlist → writeSetting downgrades anyway; be explicit).
    await writeSetting(db, "remote_exposed_tools", JSON.stringify(clean), { scope: "local" });
    res.redirectAfterPost("/dashboard/settings?section=remote-exposure");
    return true;
  },
};
