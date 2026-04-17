/**
 * Roles tab — 12 fixed rows (preset × agent) with per-row provider/model
 * override dropdowns. The "empty" dropdown option means "no override; use
 * the preset default" and routes to clearRoleOverride (DELETE). A picked
 * provider routes to setRoleOverride (UPSERT).
 *
 * Uses compat() from orchestrator/compat.js to:
 *   - mark each option as compatible / warning / blocker in the dropdown
 *     (via optgroup + suffix tags)
 *   - refuse to save when the selection emits a blocker (unless the row
 *     is a vision-required agent pointing at a vision model, etc — blockers
 *     are per-pair, not per-row).
 */

import { escapeHtml } from "../../../shared/components.js";
import { listAllRoles, roleShape } from "../../../../../orchestrator/role-shape.js";
import { listProvidersAll, listRoleOverrides, setRoleOverride, clearRoleOverride } from "../../../../../orchestrator/providers-db.js";
import { compat } from "../../../../../orchestrator/compat.js";
import { presets } from "../../../../../orchestrator/presets.js";

const BACK = "?section=llm&tab=roles";

function presetAgentDefault(presetName, agentName) {
  const p = presets[presetName];
  if (!p) return { provider: null };
  const agent = p.agents?.find((a) => a.name === agentName);
  return { provider: agent?.provider || p.provider || null };
}

function modelOptions(provider) {
  const models = Array.isArray(provider?.models) ? provider.models : [];
  return models.map((m) => (typeof m === "string" ? { id: m } : m)).filter((m) => m && m.id);
}

function optionLabel(role, provider, otherAssignments) {
  const result = compat(role, provider, { otherAssignments });
  if (!result.ok) {
    const msg = result.blockers[0]?.message || "incompatible";
    return { badge: "✗", title: msg, warn: true, blocked: true };
  }
  if (result.warnings.length > 0) {
    return { badge: "⚠", title: result.warnings.map((w) => w.message).join("\n"), warn: true, blocked: false };
  }
  return { badge: "●", title: result.hints.map((h) => h.message).join(" · "), warn: false, blocked: false };
}

export default {
  async render({ db }) {
    const roles = listAllRoles();
    const providers = await listProvidersAll(db);
    const overrides = await listRoleOverrides(db);
    const ovByAgent = new Map(
      overrides.map((o) => [`${o.preset_name}:${o.agent_name}`, o]),
    );

    // Group rows by preset for visual blocks.
    const byPreset = new Map();
    for (const r of roles) {
      if (!byPreset.has(r.preset_name)) byPreset.set(r.preset_name, []);
      byPreset.get(r.preset_name).push(r);
    }

    // For each preset, pre-compute the set of "other agent assignments" so
    // compat() can flag mutex collisions. Assignments resolve to the
    // override provider if one is set; otherwise to the preset's default.
    const providerById = new Map(providers.map((p) => [p.id, p]));
    function resolveAssignment(presetName, agentName) {
      const ov = ovByAgent.get(`${presetName}:${agentName}`);
      if (ov?.provider_id) {
        const p = providerById.get(ov.provider_id);
        if (p && !p.disabled) return p;
      }
      const def = presetAgentDefault(presetName, agentName);
      const p = def.provider ? providerById.get(def.provider) : null;
      if (p && !p.disabled) return p;
      return null;
    }

    // Collect tier-2 warnings for currently-active overrides so we can
    // surface them at the top of the tab instead of only inside dropdowns.
    const activeWarnings = [];
    for (const r of roles) {
      const ov = ovByAgent.get(`${r.preset_name}:${r.agent_name}`);
      if (!ov?.provider_id) continue;
      const picked = providerById.get(ov.provider_id);
      if (!picked || picked.disabled) continue;
      const siblings = roles
        .filter((x) => x.preset_name === r.preset_name && x.agent_name !== r.agent_name)
        .map((x) => ({ agent_name: x.agent_name, provider: resolveAssignment(x.preset_name, x.agent_name) }));
      const res = compat(r, picked, { otherAssignments: siblings });
      for (const w of res.warnings) {
        activeWarnings.push({ ...w, role: `${r.preset_name}.${r.agent_name}` });
      }
    }

    const blocks = [];
    for (const [presetName, rs] of byPreset) {
      const rowsHtml = rs.map((r) => {
        const shape = roleShape(r.preset_name, r.agent_name);
        const key = `${r.preset_name}:${r.agent_name}`;
        const ov = ovByAgent.get(key);
        const otherAssignments = rs
          .filter((x) => x.agent_name !== r.agent_name)
          .map((x) => ({ agent_name: x.agent_name, provider: resolveAssignment(x.preset_name, x.agent_name) }));

        const def = presetAgentDefault(r.preset_name, r.agent_name);
        const defaultLabel = def.provider ? `preset default — ${def.provider}` : "preset default";
        const pOptions = providers.map((p) => {
          const lbl = optionLabel(r, p, otherAssignments);
          const selected = ov?.provider_id === p.id ? " selected" : "";
          return `<option value="${escapeHtml(p.id)}" title="${escapeHtml(lbl.title)}"${selected}>${lbl.badge} ${escapeHtml(p.id)}${p.disabled ? " (disabled)" : ""}</option>`;
        }).join("");

        const isOverridden = !!ov?.provider_id;
        const overrideBadge = isOverridden
          ? `<span class="llm-role-pill llm-role-pill-overridden" title="Override in effect — points at ${escapeHtml(ov.provider_id)}${ov.model_id ? " · " + escapeHtml(ov.model_id) : ""}">Overridden</span>`
          : `<span class="llm-role-pill llm-role-pill-default">Preset default</span>`;

        const tagText = shape?.tag_text ? `<span class="llm-role-tag">${escapeHtml(shape.tag_text)}</span>` : "";

        return `<div class="llm-role-row${isOverridden ? " llm-role-row-overridden" : ""}">
          <div class="llm-role-head">
            <div class="llm-role-name">${escapeHtml(r.agent_name)}</div>
            ${tagText}
            ${overrideBadge}
          </div>
          <form method="post" class="llm-role-form">
            <input type="hidden" name="action" value="llm_role_override">
            <input type="hidden" name="preset_name" value="${escapeHtml(r.preset_name)}">
            <input type="hidden" name="agent_name" value="${escapeHtml(r.agent_name)}">
            <select name="provider_id" aria-label="Provider for ${escapeHtml(r.agent_name)}">
              <option value="">— ${escapeHtml(defaultLabel)} —</option>
              ${pOptions}
            </select>
            <input type="text" name="model_id" placeholder="model (optional)" value="${escapeHtml(ov?.model_id || "")}">
            <button type="submit" class="btn btn-primary btn-xs">Save</button>
          </form>
          ${isOverridden ? `<form method="post" class="llm-role-reset"><input type="hidden" name="action" value="llm_role_reset"><input type="hidden" name="preset_name" value="${escapeHtml(r.preset_name)}"><input type="hidden" name="agent_name" value="${escapeHtml(r.agent_name)}"><button type="submit" class="btn btn-secondary btn-xs">Reset to preset default</button></form>` : ``}
        </div>`;
      }).join("");

      blocks.push(`
        <section class="llm-preset-card">
          <header class="llm-preset-header">
            <h3>${escapeHtml(presetName)}</h3>
            <span class="llm-preset-count">${rs.length} agent${rs.length === 1 ? "" : "s"}</span>
          </header>
          <div class="llm-preset-rows">${rowsHtml}</div>
        </section>
      `);
    }

    const warningsBanner = activeWarnings.length > 0 ? `
      <div class="llm-warning-banner" role="status">
        <div class="llm-warning-banner-title">⚠ ${activeWarnings.length} active override${activeWarnings.length === 1 ? "" : "s"} with warnings</div>
        <ul class="llm-warning-banner-list">
          ${activeWarnings.slice(0, 5).map((w) => `<li><code>${escapeHtml(w.role)}</code> — ${escapeHtml(w.message)}</li>`).join("")}
          ${activeWarnings.length > 5 ? `<li style="color:var(--crow-text-muted)">…and ${activeWarnings.length - 5} more</li>` : ""}
        </ul>
      </div>` : "";

    return `<style>
      .llm-preset-card {
        border:1px solid var(--crow-border);
        border-radius:var(--crow-radius-card);
        background:var(--crow-bg-surface);
        margin-bottom:1rem;
        overflow:hidden;
      }
      .llm-preset-header {
        display:flex; align-items:baseline; justify-content:space-between;
        padding:0.7rem 1rem;
        background:var(--crow-bg-elevated);
        border-bottom:1px solid var(--crow-border);
      }
      .llm-preset-header h3 {
        margin:0;
        font-family:'JetBrains Mono',monospace;
        font-size:0.9rem;
        color:var(--crow-text-primary);
        letter-spacing:0.02em;
      }
      .llm-preset-count { font-size:0.72rem; color:var(--crow-text-muted); }
      .llm-preset-rows { padding:0.35rem 0; }
      .llm-role-row {
        padding:0.65rem 1rem;
        border-bottom:1px solid var(--crow-border);
      }
      .llm-role-row:last-child { border-bottom:none; }
      .llm-role-row-overridden { background:color-mix(in srgb, var(--crow-accent) 4%, transparent); }
      .llm-role-head {
        display:flex; align-items:center; gap:0.6rem;
        margin-bottom:0.45rem;
      }
      .llm-role-name { font-family:'JetBrains Mono',monospace; font-size:0.9rem; color:var(--crow-text-primary); font-weight:500; }
      .llm-role-tag { font-size:0.72rem; color:var(--crow-text-muted); }
      .llm-role-pill {
        margin-left:auto;
        font-size:0.7rem;
        padding:2px 10px;
        border-radius:var(--crow-radius-pill);
        letter-spacing:0.02em;
      }
      .llm-role-pill-default {
        background:var(--crow-bg-elevated);
        color:var(--crow-text-muted);
        border:1px solid var(--crow-border);
      }
      .llm-role-pill-overridden {
        background:var(--crow-accent);
        color:#fff;
        font-weight:500;
      }
      .llm-role-form {
        display:flex;
        gap:0.5rem;
        align-items:center;
        flex-wrap:wrap;
      }
      .llm-role-form select,
      .llm-role-form input[type="text"] {
        background:var(--crow-bg-surface);
        border:1px solid var(--crow-border);
        color:var(--crow-text-primary);
        padding:0.35rem 0.55rem;
        border-radius:6px;
        font-size:0.85rem;
      }
      .llm-role-form select { flex:1 1 320px; min-width:240px; font-family:'JetBrains Mono',monospace; }
      .llm-role-form input[type="text"] { flex:0 1 160px; font-family:'JetBrains Mono',monospace; }
      .llm-role-form select:focus,
      .llm-role-form input:focus {
        outline:none;
        border-color:var(--crow-accent);
        box-shadow:0 0 0 2px var(--crow-accent-muted);
      }
      .llm-role-reset { margin-top:0.35rem; }
      .llm-warning-banner {
        border:1px solid var(--crow-brand-gold);
        background:color-mix(in srgb, var(--crow-brand-gold) 10%, var(--crow-bg-surface));
        border-radius:var(--crow-radius-card);
        padding:0.85rem 1rem;
        margin-bottom:1.25rem;
      }
      .llm-warning-banner-title {
        font-weight:600;
        color:var(--crow-brand-gold);
        margin-bottom:0.35rem;
        font-size:0.88rem;
      }
      .llm-warning-banner-list {
        margin:0; padding-left:1.15rem;
        font-size:0.82rem;
        color:var(--crow-text-secondary);
        line-height:1.5;
      }
      .llm-warning-banner-list code {
        background:var(--crow-bg-elevated);
        padding:1px 5px;
        border-radius:4px;
        font-family:'JetBrains Mono',monospace;
        font-size:0.78rem;
        color:var(--crow-text-primary);
      }
    </style>

    <p class="llm-section-hint">
      ${roles.length} agent roles across ${byPreset.size} presets. Leaving the dropdown on "preset default" deletes the override row (reverts to <code>presets.js</code>). Dropdown marks: <strong style="color:var(--crow-success)">●</strong> compatible · <strong style="color:var(--crow-brand-gold)">⚠</strong> warning · <strong style="color:var(--crow-error)">✗</strong> blocker. Hover any option for details.
    </p>

    ${warningsBanner}

    ${blocks.join("")}`;
  },

  async handleAction({ req, res, db, action }) {
    if (action === "llm_role_override") {
      const { preset_name, agent_name, provider_id, model_id } = req.body;
      if (!preset_name || !agent_name) {
        res.status(400).type("text/plain").send("preset_name + agent_name required");
        return true;
      }

      // Empty provider_id means "clear the override" — plan's UI→backend contract.
      if (!provider_id || provider_id === "") {
        await clearRoleOverride(db, preset_name, agent_name);
        res.redirectAfterPost(BACK);
        return true;
      }

      // Pre-save compat check. Blockers hard-stop the save.
      const all = await listProvidersAll(db);
      const picked = all.find((p) => p.id === provider_id);
      if (!picked) {
        res.status(400).type("text/plain").send(`Provider "${provider_id}" not found`);
        return true;
      }

      // Gather other assignments in this preset for mutex detection.
      const allRoles = listAllRoles().filter((r) => r.preset_name === preset_name && r.agent_name !== agent_name);
      const overrides = await listRoleOverrides(db);
      const ovByAgent = new Map(overrides.map((o) => [`${o.preset_name}:${o.agent_name}`, o]));
      const byId = new Map(all.map((p) => [p.id, p]));
      const other = allRoles.map((r) => {
        const ov = ovByAgent.get(`${r.preset_name}:${r.agent_name}`);
        let prov = null;
        if (ov?.provider_id) prov = byId.get(ov.provider_id);
        if (!prov || prov.disabled) {
          const def = presetAgentDefault(r.preset_name, r.agent_name);
          prov = def.provider ? byId.get(def.provider) : null;
        }
        return { agent_name: r.agent_name, provider: prov || null };
      });

      const result = compat({ preset_name, agent_name }, picked, { otherAssignments: other });
      if (!result.ok) {
        const reasons = result.blockers.map((b) => `• ${b.message}`).join("\n");
        res.status(400).type("text/plain").send(`Save blocked:\n${reasons}`);
        return true;
      }

      await setRoleOverride(db, {
        preset_name,
        agent_name,
        provider_id,
        model_id: (model_id || "").trim() || null,
      });
      res.redirectAfterPost(BACK);
      return true;
    }

    if (action === "llm_role_reset") {
      const { preset_name, agent_name } = req.body;
      if (!preset_name || !agent_name) {
        res.status(400).type("text/plain").send("preset_name + agent_name required");
        return true;
      }
      await clearRoleOverride(db, preset_name, agent_name);
      res.redirectAfterPost(BACK);
      return true;
    }

    return false;
  },
};
