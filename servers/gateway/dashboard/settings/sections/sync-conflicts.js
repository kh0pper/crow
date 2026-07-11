/**
 * Settings Section: Sync Conflicts (Multi-Instance group)
 *
 * Shows unresolved sync conflicts first, resolved ones collapsed below.
 * Each row displays: table, row id, when, winning/losing instance ids, op,
 * and an expandable side-by-side of winning vs losing data.
 *
 * Actions:
 *   keep_current  — mark conflict resolved (keep the winning version as-is).
 *   restore_other — recover the losing data as a new local edit via
 *                   restoreConflict() in sync-conflict-resolve.js.
 *   resolve_all   — bulk mark-all-resolved.
 *
 * POST dispatch follows the settings-section handleAction pattern (auth+CSRF
 * for free via /dashboard/settings), exactly as paired-instances.js does.
 * The section id is "sync-conflicts" (kebab-case) so the section=sync-conflicts
 * query param in notifications resolves correctly (exact-match lookup).
 *
 * Spec reference: W4-1 §6 (Task B).
 */

import { escapeHtml } from "../../shared/components.js";
import { t } from "../../shared/i18n.js";
import { resolveConflict, restoreConflict } from "../../../../sharing/sync-conflict-resolve.js";
import { getInstanceSyncManager } from "../../../../sharing/server.js";

// ── Formatting helpers ────────────────────────────────────────────────────────

function fmtDate(isoish) {
  if (!isoish) return "unknown";
  try {
    const d = new Date(isoish.replace(" ", "T") + (isoish.includes("Z") ? "" : "Z"));
    return d.toISOString().slice(0, 16).replace("T", " ");
  } catch {
    return String(isoish);
  }
}

function shortId(id) {
  if (!id) return "-";
  return String(id).slice(0, 12) + (String(id).length > 12 ? "…" : "");
}

function opBadge(op) {
  const colors = {
    update: "#2196f3",
    delete: "#e53935",
    insert: "#ff9800",
  };
  const color = colors[op] || "#9e9e9e";
  return `<span style="font-size:0.7rem;padding:2px 6px;background:${color}22;color:${color};border-radius:3px;font-family:'JetBrains Mono',monospace">${escapeHtml(op || "update")}</span>`;
}

function prettyJson(raw) {
  if (!raw) return "(none)";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return String(raw);
  }
}

// ── Conflict table row renderer ───────────────────────────────────────────────

function renderConflictRow(r, lang, csrfToken) {
  const when = fmtDate(r.created_at);
  const wId = shortId(r.winning_instance_id);
  const lId = shortId(r.losing_instance_id);
  const isInsert = (r.op === "insert");
  const isDelete = (r.op === "delete");
  const isCrowContext = (r.table_name === "crow_context");
  const resolved = !!r.resolved;

  const winJson = prettyJson(r.winning_data);
  const loseJson = prettyJson(r.losing_data);

  // Restore button is disabled for op='insert' conflicts per spec §6.
  // Also disabled for crow_context (composite key — spec §4).
  const restoreBtn = isInsert
    ? `<span style="font-size:0.78rem;color:var(--crow-text-muted);font-style:italic">
         ${escapeHtml(t("syncConflicts.insertRestoreDisabled", lang))}
       </span>`
    : isCrowContext
    ? `<span style="font-size:0.78rem;color:var(--crow-text-muted);font-style:italic">
         ${escapeHtml(t("syncConflicts.compositeRestoreDisabled", lang))}
       </span>`
    : `<form method="POST" action="/dashboard/settings" style="display:inline">
         <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}" />
         <input type="hidden" name="action" value="sync_conflicts_restore_other" />
         <input type="hidden" name="conflict_id" value="${escapeHtml(String(r.id))}" />
         <button type="submit" class="btn btn-secondary" style="font-size:0.78rem;padding:3px 8px">
           ${escapeHtml(t("syncConflicts.restoreOther", lang))}
         </button>
       </form>`;

  const keepBtn = `<form method="POST" action="/dashboard/settings" style="display:inline;margin-left:0.4rem">
    <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}" />
    <input type="hidden" name="action" value="sync_conflicts_keep_current" />
    <input type="hidden" name="conflict_id" value="${escapeHtml(String(r.id))}" />
    <button type="submit" class="btn btn-secondary" style="font-size:0.78rem;padding:3px 8px">
      ${escapeHtml(t("syncConflicts.keepCurrent", lang))}
    </button>
  </form>`;

  // Resolved rows: simpler display, no action buttons.
  if (resolved) {
    return `
      <tr style="opacity:0.5">
        <td style="padding:8px;font-family:'JetBrains Mono',monospace;font-size:0.78rem">${escapeHtml(r.table_name)}</td>
        <td style="padding:8px;font-family:'JetBrains Mono',monospace;font-size:0.78rem">${escapeHtml(String(r.row_id))}</td>
        <td style="padding:8px;font-size:0.78rem;color:var(--crow-text-muted)">${escapeHtml(when)}</td>
        <td style="padding:8px">${opBadge(r.op)}</td>
        <td style="padding:8px;font-size:0.78rem">
          <span style="font-size:0.7rem;padding:2px 6px;background:#4caf5033;color:#4caf50;border-radius:3px">resolved</span>
        </td>
      </tr>`;
  }

  // Losing-side label: "fields in the other version" — losing_data is the partial
  // incoming row, not a full snapshot; the label must not imply absent fields were deleted.
  const losingLabel = isDelete
    ? escapeHtml(t("syncConflicts.losingDataDelete", lang))
    : escapeHtml(t("syncConflicts.losingDataFields", lang));

  return `
    <tr>
      <td style="padding:8px;font-family:'JetBrains Mono',monospace;font-size:0.78rem">${escapeHtml(r.table_name)}</td>
      <td style="padding:8px;font-family:'JetBrains Mono',monospace;font-size:0.78rem">${escapeHtml(String(r.row_id))}</td>
      <td style="padding:8px;font-size:0.78rem;color:var(--crow-text-muted)">${escapeHtml(when)}</td>
      <td style="padding:8px">${opBadge(r.op)}</td>
      <td style="padding:8px">
        <details>
          <summary style="cursor:pointer;font-size:0.78rem;color:var(--crow-accent)">
            ${escapeHtml(t("syncConflicts.showData", lang))}
            <span style="font-size:0.7rem;color:var(--crow-text-muted)">
              (kept: ${escapeHtml(wId)}, other: ${escapeHtml(lId)})
            </span>
          </summary>
          <div style="display:flex;gap:1rem;margin-top:0.5rem;flex-wrap:wrap">
            <div style="flex:1;min-width:200px">
              <div style="font-size:0.7rem;text-transform:uppercase;letter-spacing:0.04em;color:var(--crow-text-muted);margin-bottom:4px">
                ${escapeHtml(t("syncConflicts.winningData", lang))}
              </div>
              <pre style="background:var(--crow-bg-deep);padding:8px;border-radius:4px;font-size:0.72rem;overflow-x:auto;max-height:200px;overflow-y:auto;white-space:pre-wrap;word-break:break-all">${escapeHtml(winJson)}</pre>
            </div>
            <div style="flex:1;min-width:200px">
              <div style="font-size:0.7rem;text-transform:uppercase;letter-spacing:0.04em;color:var(--crow-text-muted);margin-bottom:4px">
                ${losingLabel}
              </div>
              <pre style="background:var(--crow-bg-deep);padding:8px;border-radius:4px;font-size:0.72rem;overflow-x:auto;max-height:200px;overflow-y:auto;white-space:pre-wrap;word-break:break-all">${escapeHtml(loseJson)}</pre>
            </div>
          </div>
        </details>
      </td>
      <td style="padding:8px;white-space:nowrap">
        ${restoreBtn}
        ${keepBtn}
      </td>
    </tr>`;
}

// ── Section definition ────────────────────────────────────────────────────────

export default {
  id: "sync-conflicts",
  group: "multiInstance",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>`,
  labelKey: "settings.section.syncConflicts",
  navOrder: 15,

  async getPreview({ db }) {
    try {
      const { rows } = await db.execute({
        sql: "SELECT COUNT(*) AS n FROM sync_conflicts WHERE resolved = 0",
        args: [],
      });
      const n = Number(rows[0]?.n || 0);
      return n === 0 ? "none" : `${n} unresolved`;
    } catch {
      return "-";
    }
  },

  async render({ req, db, lang }) {
    const csrfToken = req?.csrfToken || "";
    // Flash is a fixed status enum mapped to i18n — never free text from the
    // URL (an authed user following a crafted link must not see arbitrary
    // content in trusted UI chrome).
    const FLASH_KEYS = {
      applied: "syncConflicts.msgApplied",
      stale: "syncConflicts.msgStale",
      refused: "syncConflicts.msgRefused",
      error: "syncConflicts.msgFailed",
    };
    const flashKey = FLASH_KEYS[req?.query?.syncConflictsMsg] || null;
    const flash = flashKey ? t(flashKey, lang) : "";

    let unresolvedRows = [];
    let resolvedRows = [];
    let unresolvedTotal = 0;
    let dbError = null;
    try {
      const { rows: unresolved } = await db.execute({
        sql: `SELECT * FROM sync_conflicts WHERE resolved = 0 ORDER BY created_at DESC LIMIT 200`,
        args: [],
      });
      const { rows: unresolvedCount } = await db.execute({
        sql: `SELECT COUNT(*) AS n FROM sync_conflicts WHERE resolved = 0`,
        args: [],
      });
      const { rows: resolved } = await db.execute({
        sql: `SELECT * FROM sync_conflicts WHERE resolved = 1 ORDER BY resolved_at DESC LIMIT 25`,
        args: [],
      });
      unresolvedRows = unresolved;
      unresolvedTotal = Number(unresolvedCount[0]?.n || 0);
      resolvedRows = resolved;
    } catch (err) {
      dbError = err.message || "Unknown error";
    }

    if (dbError) {
      return `<div style="color:#e53935;padding:1rem">
        ${escapeHtml(t("syncConflicts.loadError", lang))}: ${escapeHtml(dbError)}
      </div>`;
    }

    const flashHtml = flash
      ? `<div style="margin-bottom:1rem;padding:0.75rem;background:var(--crow-bg-deep);border-left:3px solid var(--crow-accent);border-radius:4px;font-size:0.88rem">
           ${escapeHtml(flash)}
         </div>`
      : "";

    const cols = `
      <colgroup>
        <col style="width:90px">
        <col style="width:140px">
        <col style="width:120px">
        <col style="width:60px">
        <col>
        <col style="width:180px">
      </colgroup>`;

    const theadUnresolved = `<thead><tr>
      <th>${escapeHtml(t("syncConflicts.colTable", lang))}</th>
      <th>${escapeHtml(t("syncConflicts.colRowId", lang))}</th>
      <th>${escapeHtml(t("syncConflicts.colWhen", lang))}</th>
      <th>${escapeHtml(t("syncConflicts.colOp", lang))}</th>
      <th>${escapeHtml(t("syncConflicts.colData", lang))}</th>
      <th>${escapeHtml(t("syncConflicts.colActions", lang))}</th>
    </tr></thead>`;

    const theadResolved = `<thead><tr>
      <th>${escapeHtml(t("syncConflicts.colTable", lang))}</th>
      <th>${escapeHtml(t("syncConflicts.colRowId", lang))}</th>
      <th>${escapeHtml(t("syncConflicts.colWhen", lang))}</th>
      <th>${escapeHtml(t("syncConflicts.colOp", lang))}</th>
      <th colspan="2">${escapeHtml(t("syncConflicts.resolvedLabel", lang))}</th>
    </tr></thead>`;

    const unresolvedTbody = unresolvedRows.length
      ? unresolvedRows.map((r) => renderConflictRow(r, lang, csrfToken)).join("")
      : `<tr><td colspan="6" style="padding:16px;text-align:center;color:var(--crow-text-muted)">
           ${escapeHtml(t("syncConflicts.none", lang))}
         </td></tr>`;

    const resolvedTbody = resolvedRows.length
      ? resolvedRows.map((r) => renderConflictRow(r, lang, csrfToken)).join("")
      : `<tr><td colspan="5" style="padding:12px;text-align:center;color:var(--crow-text-muted)">
           ${escapeHtml(t("syncConflicts.noneResolved", lang))}
         </td></tr>`;

    const overLimitNotice = unresolvedTotal > 200
      ? `<div style="margin-bottom:0.75rem;padding:0.6rem 0.75rem;background:var(--crow-bg-deep);border-left:3px solid #ff9800;border-radius:4px;font-size:0.82rem;color:var(--crow-text-muted)">
           ${escapeHtml(t("syncConflicts.showingFirst", lang).replace("{n}", String(unresolvedTotal)))}
         </div>`
      : "";

    const bulkResolveBtn = unresolvedRows.length > 0
      ? `<form method="POST" action="/dashboard/settings"
              style="margin-top:0.75rem"
              onsubmit="return confirm(${escapeHtml(JSON.stringify(t("syncConflicts.resolveAllConfirm", lang)))})">
           <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}" />
           <input type="hidden" name="action" value="sync_conflicts_resolve_all" />
           <button type="submit" class="btn btn-secondary" style="font-size:0.82rem">
             ${escapeHtml(t("syncConflicts.resolveAll", lang))}
           </button>
         </form>`
      : "";

    return `<style>
      .sc-table { width:100%; border-collapse:collapse; font-size:0.88rem; }
      .sc-table th { text-align:left; padding:8px; background:var(--crow-bg-deep); color:var(--crow-text-muted); font-weight:500; font-size:0.75rem; text-transform:uppercase; letter-spacing:0.03em; }
      .sc-table tr { border-bottom:1px solid var(--crow-border); }
      .sc-table td { vertical-align:top; }
    </style>

    ${flashHtml}

    <div style="margin-bottom:1rem;font-size:0.85rem;color:var(--crow-text-muted)">
      ${escapeHtml(t("syncConflicts.description", lang))}
    </div>

    <h3 style="font-size:0.95rem;margin:0 0 0.5rem;font-weight:600">
      ${escapeHtml(t("syncConflicts.unresolvedHeading", lang))}
      ${unresolvedRows.length > 0 ? `<span style="font-size:0.78rem;color:#e53935;margin-left:0.4rem">(${unresolvedRows.length})</span>` : ""}
    </h3>

    ${overLimitNotice}

    <div style="overflow-x:auto">
      <table class="sc-table">
        ${cols}
        ${theadUnresolved}
        <tbody>${unresolvedTbody}</tbody>
      </table>
    </div>

    ${bulkResolveBtn}

    <details style="margin-top:1.5rem">
      <summary style="cursor:pointer;font-size:0.85rem;color:var(--crow-text-muted);padding:0.4rem 0">
        ${escapeHtml(t("syncConflicts.resolvedHeading", lang))}
        ${resolvedRows.length > 0 ? `(${resolvedRows.length})` : ""}
      </summary>
      <div style="overflow-x:auto;margin-top:0.5rem">
        <table class="sc-table">
          ${cols}
          ${theadResolved}
          <tbody>${resolvedTbody}</tbody>
        </table>
      </div>
    </details>`;
  },

  async handleAction({ req, res, db, action }) {
    if (!action || !action.startsWith("sync_conflicts_")) return false;

    const conflictId = req.body?.conflict_id;
    const instanceSync = getInstanceSyncManager();

    if (action === "sync_conflicts_keep_current") {
      if (!conflictId) {
        res.redirectAfterPost("/dashboard/settings?section=sync-conflicts");
        return true;
      }
      await resolveConflict(db, String(conflictId));
      res.redirectAfterPost("/dashboard/settings?section=sync-conflicts");
      return true;
    }

    if (action === "sync_conflicts_restore_other") {
      if (!conflictId) {
        res.redirectAfterPost("/dashboard/settings?section=sync-conflicts");
        return true;
      }
      const outcome = await restoreConflict(db, String(conflictId), { instanceSync });
      // Pass only the status enum; render() maps it to an i18n'd flash.
      const status = ["applied", "stale", "refused"].includes(outcome.status)
        ? outcome.status
        : "error";
      res.redirectAfterPost(`/dashboard/settings?section=sync-conflicts&syncConflictsMsg=${status}`);
      return true;
    }

    if (action === "sync_conflicts_resolve_all") {
      await db.execute({
        sql: `UPDATE sync_conflicts SET resolved = 1, resolved_at = datetime('now') WHERE resolved = 0`,
        args: [],
      });
      res.redirectAfterPost("/dashboard/settings?section=sync-conflicts");
      return true;
    }

    return false;
  },
};
