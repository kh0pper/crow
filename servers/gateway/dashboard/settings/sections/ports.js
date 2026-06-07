/**
 * Settings Section: Ports (System group) — read-only host-port registry.
 * Lists installed-bundle ports + live OS listeners with address-aware status
 * and conflict flagging. No mutation in v1.
 */

import { escapeHtml } from "../../shared/components.js";
import { t } from "../../shared/i18n.js";
import { buildPortInventory } from "../../../port-inventory.js";

const KIND_LABEL = {
  parameterized: "bundle",
  hardcoded: "bundle",
  managed: "model service",
  core: "core service",
  foreign: "other listener",
};

function statusCell(r) {
  if (r.conflict) return `<span title="${escapeHtml(r.conflictReason || "conflict")}" style="color:#e0533d">⚠ conflict</span>`;
  if (r.status === "up") return `<span style="color:#3ba55d" title="listening">● up</span>`;
  return `<span style="color:#888">○ down</span>`;
}

export default {
  id: "ports",
  group: "system",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M6 7V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v3"/></svg>`,
  labelKey: "settings.section.ports",
  navOrder: 55,

  async getPreview({ lang } = {}) {
    try {
      const rows = await buildPortInventory({ ttlMs: 15000, now: Date.now() });
      const conflicts = rows.filter((r) => r.conflict).length;
      const crow = rows.filter((r) => r.kind !== "foreign").length;
      return conflicts ? `${crow} ports · ${conflicts} conflict${conflicts > 1 ? "s" : ""}` : `${crow} ports`;
    } catch (err) {
      console.warn("[settings:ports] getPreview failed:", err.message);
      return "";
    }
  },

  async render({ lang }) {
    const rows = await buildPortInventory({ ttlMs: 15000, now: Date.now() });
    const crow = rows.filter((r) => r.kind !== "foreign");
    const foreign = rows.filter((r) => r.kind === "foreign");

    const rowHtml = (r) => `<tr>
      <td style="font-variant-numeric:tabular-nums">${r.port ?? ""}</td>
      <td>${escapeHtml(r.bundleName || "—")}${r.shared ? ` <span style="color:var(--crow-text-muted)">(shared)</span>` : ""}</td>
      <td style="color:var(--crow-text-muted)">${escapeHtml(r.boundAddr || r.declaredBind || "")}</td>
      <td>${statusCell(r)}</td>
      <td style="color:var(--crow-text-muted)">${escapeHtml(KIND_LABEL[r.kind] || r.kind)}</td>
    </tr>`;

    const crowBody = crow.length
      ? crow.map(rowHtml).join("")
      : `<tr><td colspan="5" style="text-align:center;color:var(--crow-text-muted);padding:1rem">No ports registered.</td></tr>`;
    const crowTable = `<table class="settings-table" style="width:100%;border-collapse:collapse">
      <thead><tr style="text-align:left;border-bottom:1px solid var(--crow-border)">
        <th>Port</th><th>App / Service</th><th>Bind</th><th>Status</th><th>Type</th>
      </tr></thead><tbody>${crowBody}</tbody></table>`;

    const foreignTable = foreign.length
      ? `<details style="margin-top:1rem"><summary style="cursor:pointer;color:var(--crow-text-muted)">Other host listeners (${foreign.length})</summary>
         <table class="settings-table" style="width:100%;border-collapse:collapse;margin-top:.5rem"><tbody>
         ${foreign.map((r) => `<tr><td style="font-variant-numeric:tabular-nums">${r.port ?? ""}</td><td style="color:var(--crow-text-muted)">${escapeHtml(r.boundAddr || "")}</td></tr>`).join("")}
         </tbody></table></details>`
      : "";

    return `<p style="color:var(--crow-text-muted);margin:.2rem 0 1rem">${t("settings.ports.description", lang)}</p>
      ${crowTable}${foreignTable}`;
  },
};
