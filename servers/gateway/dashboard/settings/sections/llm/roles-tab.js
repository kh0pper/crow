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
          const suffix = lbl.badge + (lbl.title ? "" : "");
          const selected = ov?.provider_id === p.id ? " selected" : "";
          return `<option value="${escapeHtml(p.id)}" title="${escapeHtml(lbl.title)}"${selected} data-warn="${lbl.warn ? 1 : 0}" data-blocked="${lbl.blocked ? 1 : 0}">${suffix} ${escapeHtml(p.id)}${p.disabled ? " (disabled)" : ""}</option>`;
        }).join("");

        const isOverridden = !!ov?.provider_id;
        const overrideBadge = isOverridden
          ? `<span style="font-size:0.72rem;padding:2px 6px;background:var(--crow-accent);color:var(--crow-bg);border-radius:3px">Overridden</span>`
          : "";

        return `<tr>
          <td style="padding:8px">
            <div style="font-family:'JetBrains Mono',monospace">${escapeHtml(r.agent_name)}</div>
            <div style="font-size:0.72rem;color:var(--crow-text-muted)">${escapeHtml(shape?.tag_text || "")}</div>
          </td>
          <td style="padding:8px">
            <form method="post" style="display:flex;gap:0.25rem;align-items:center">
              <input type="hidden" name="action" value="llm_role_override">
              <input type="hidden" name="preset_name" value="${escapeHtml(r.preset_name)}">
              <input type="hidden" name="agent_name" value="${escapeHtml(r.agent_name)}">
              <select name="provider_id" style="background:var(--crow-bg);border:1px solid var(--crow-border);color:var(--crow-text);padding:0.25rem;border-radius:3px;font-size:0.85rem;min-width:240px">
                <option value="">— ${escapeHtml(defaultLabel)} —</option>
                ${pOptions}
              </select>
              <input type="text" name="model_id" placeholder="model (optional)" value="${escapeHtml(ov?.model_id || "")}" style="background:var(--crow-bg);border:1px solid var(--crow-border);color:var(--crow-text);padding:0.25rem;border-radius:3px;font-size:0.85rem;width:160px">
              <button type="submit" class="btn btn-primary btn-xs">Save</button>
              ${isOverridden ? `</form><form method="post" style="display:inline;margin-left:0.25rem"><input type="hidden" name="action" value="llm_role_reset"><input type="hidden" name="preset_name" value="${escapeHtml(r.preset_name)}"><input type="hidden" name="agent_name" value="${escapeHtml(r.agent_name)}"><button type="submit" class="btn btn-secondary btn-xs">Reset</button></form>` : `</form>`}
          </td>
          <td style="padding:8px">${overrideBadge}</td>
        </tr>`;
      }).join("");

      blocks.push(`
        <div style="margin-bottom:1.5rem">
          <h3 style="margin:0 0 0.5rem;font-size:0.95rem;font-family:'JetBrains Mono',monospace;color:var(--crow-text-muted)">${escapeHtml(presetName)}</h3>
          <table style="width:100%;border-collapse:collapse;font-size:0.9rem;border:1px solid var(--crow-border);border-radius:4px;overflow:hidden">
            <thead><tr style="background:var(--crow-bg-deep);color:var(--crow-text-muted);font-weight:500;font-size:0.8rem"><th style="text-align:left;padding:8px">Agent</th><th style="text-align:left;padding:8px">Provider override</th><th style="padding:8px"></th></tr></thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>
      `);
    }

    return `
      <div style="margin-bottom:0.75rem;font-size:0.85rem;color:var(--crow-text-muted)">
        ${roles.length} agent roles across ${byPreset.size} presets. Leaving the dropdown on "preset default" deletes the override row (reverts to presets.js). Dropdown marks: ● compatible · ⚠ warning · ✗ blocker. Hover for details.
      </div>
      ${blocks.join("")}
    `;
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
