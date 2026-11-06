/**
 * Settings Section: Remote Tool Exposure (Multi-Instance group) — F4a Layer 2a.
 *
 * Per-instance, LOCAL-ONLY (never synced) exposure controls, in two shapes:
 *   1. the all-trusted-peers allowlist (`remote_exposed_tools`) — the checkbox
 *      list below, an explicit "share with all my Crows" statement;
 *   2. per-device allowances (`remote_exposed_tools_by_peer`, N1b-8) — what a
 *      Fix-it "Allow" card grants to the ONE peer that asked, with an expiry.
 *      Listed here with the peer and the expiry, and renewable or removable.
 * Default = nothing exposed (deny-all). The authoritative enforcement is
 * server-side in peer-exposure.js; this UI only edits the exposure settings.
 *
 * Both keys are deliberately ABSENT from sync-allowlist.js, so writeSetting
 * downgrades them to local scope automatically — each instance is sovereign
 * over what it exposes.
 */
import { writeSetting } from "../registry.js";
import {
  getPeerExposures,
  grantIsActive,
  renewPeerGrant,
  removePeerGrant,
} from "../../../peer-exposure-store.js";
import { normalizePeerId } from "../../../../shared/peer-id.js";
import { getLocalCatalog } from "../../../capability-registry.js";
import { getOrCreateLocalInstanceId, getInstance } from "../../../instance-registry.js";
import { escapeHtml } from "../../shared/components.js";
import { resolveFriendlyName } from "../../../fix-it/friendly-names.js";

const SECTION_URL = "/dashboard/settings?section=remote-exposure";

/** Format an ISO timestamp for display; "" when unparseable. */
function formatWhen(iso) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return "";
  return new Date(t).toISOString().slice(0, 10);
}

/** Best-effort display label for a peer: its stored name, else a short id. */
async function peerLabel(db, peerId) {
  let name = null;
  try { name = (await getInstance(db, peerId))?.name || null; } catch { name = null; }
  return name && String(name).trim() ? String(name).trim() : `${peerId.slice(0, 8)}…`;
}

/**
 * The "Per-device allowances" block: one row per (peer, capability) grant, with
 * its state — active with an expiry, expired (still listed so it can be renewed
 * or removed), or "until you remove it".
 */
async function renderPeerGrants(db) {
  const grants = await getPeerExposures(db);
  const now = Date.now();
  const entries = [];
  for (const [peerId, caps] of grants) {
    for (const [capability, grant] of caps) entries.push({ peerId, capability, grant });
  }
  entries.sort((a, b) => `${a.peerId}:${a.capability}`.localeCompare(`${b.peerId}:${b.capability}`));

  const states = await Promise.all(entries.map(async (e) => {
    const label = await peerLabel(db, e.peerId);
    let state;
    if (e.grant.expiresAt == null) state = "until you remove it";
    else if (grantIsActive(e.grant, now)) state = `expires ${escapeHtml(formatWhen(e.grant.expiresAt))}`;
    else state = `<strong style="color:var(--crow-error)">expired</strong> ${escapeHtml(formatWhen(e.grant.expiresAt))}`;
    return { ...e, label, state };
  }));

  const rows = states.map((e) => {
    const friendly = resolveFriendlyName(e.capability);
    const actionForm = (action, buttonText) => `<form method="POST" style="display:inline">
        <input type="hidden" name="action" value="${action}">
        <input type="hidden" name="peer" value="${escapeHtml(e.peerId)}">
        <input type="hidden" name="cap" value="${escapeHtml(e.capability)}">
        <button type="submit" class="btn btn-text" style="background:none;border:none;color:var(--crow-text-muted);cursor:pointer;padding:0 0.25rem">${buttonText}</button>
      </form>`;
    return `<div style="display:flex;align-items:center;gap:0.6rem;flex-wrap:wrap;padding:0.5rem 0;border-bottom:1px solid var(--crow-border,#2222)">
      <span style="flex:1 1 16rem">${escapeHtml(e.label)} <span style="color:var(--crow-text-muted);font-size:0.85rem">(${escapeHtml(e.peerId)})</span>
        <br><span style="font-size:0.85rem;color:var(--crow-text-muted)">${escapeHtml(friendly)} — ${e.state}</span></span>
      ${actionForm("renew_peer_exposure", "Renew 30 days")}
      ${actionForm("remove_peer_exposure", "Remove")}
    </div>`;
  }).join("");

  const body = rows || `<p style="color:var(--crow-text-muted);padding:0.8rem 0;margin:0">No one-device allowances yet. An “Allow” card on the Nest creates one, for the device that asked only.</p>`;
  return `<h4 style="font-size:0.95rem;margin:1.75rem 0 0.4rem">Per-device allowances</h4>
    <div style="color:var(--crow-text-secondary);font-size:0.9rem;line-height:1.5;margin-bottom:0.5rem">
      Capabilities allowed for a single device, usually from an “Allow” card on the Nest. An expired allowance
      stops working on its own and can be renewed or removed here. Nothing here is listed above, so it is never
      shared with your other devices.
    </div>
    <div style="border:1px solid var(--crow-border,#2222);border-radius:8px;padding:0 0.8rem">${body}</div>`;
}

export default {
  id: "remote-exposure",
  group: "otherCrows",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v6m0 6v6"/><path d="M4.2 4.2l4.2 4.2m6.4 6.4l4.2 4.2"/><path d="M1 12h6m6 0h6"/></svg>`,
  labelKey: "settings.section.remoteExposure",
  hidden: true,
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
      const friendly = resolveFriendlyName(c.canonicalId, c.name);
      return `<label style="display:flex;align-items:center;gap:0.6rem;padding:0.4rem 0;border-bottom:1px solid var(--crow-border,#2222)">
        <input type="checkbox" name="cap" value="${escapeHtml(c.canonicalId)}" ${on ? "checked" : ""}>
        <span style="flex:1">${escapeHtml(friendly)} <span style="color:var(--crow-text-muted);font-size:0.85rem">(${escapeHtml(c.category)}${c.bundleId ? " · addon" : ""})</span></span>
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
    </form>
    ${await renderPeerGrants(db)}`;
  },

  async handleAction({ req, res, db, action }) {
    const body = req.body || {};
    // N1b-8: one-device allowances — renew (+30 days from now) or remove.
    if (action === "renew_peer_exposure" || action === "remove_peer_exposure") {
      const peerId = normalizePeerId(body.peer);
      const capability = typeof body.cap === "string" ? body.cap.trim() : "";
      if (!peerId || !capability) {
        res.redirectAfterPost(SECTION_URL);
        return true;
      }
      if (action === "remove_peer_exposure") await removePeerGrant(db, { peerId, capability });
      else await renewPeerGrant(db, { peerId, capability, days: 30 });
      res.redirectAfterPost(SECTION_URL);
      return true;
    }
    if (action !== "set_remote_exposure") return false;
    // Checkboxes: req.body.cap is a string (one) or array (many) or undefined (none).
    let selected = req.body.cap;
    if (selected == null) selected = [];
    else if (!Array.isArray(selected)) selected = [selected];
    const clean = [...new Set(selected.filter((x) => typeof x === "string" && x.length > 0))];
    // Local scope (not in sync-allowlist → writeSetting downgrades anyway; be explicit).
    await writeSetting(db, "remote_exposed_tools", JSON.stringify(clean), { scope: "local" });
    res.redirectAfterPost(SECTION_URL);
    return true;
  },
};
