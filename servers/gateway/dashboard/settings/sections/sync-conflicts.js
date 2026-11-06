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
 *   resolve_older — resolve every unresolved row older than N days (1–365),
 *                   opened rows and newer-losers included; winner kept.
 *   opened        — page script: a person expanded a row's data, so the expiry
 *                   sweep must leave it alone (sync-conflict-expiry.js).
 *
 * POST dispatch follows the settings-section handleAction pattern (auth+CSRF
 * for free via /dashboard/settings), exactly as paired-instances.js does.
 * The section id is "sync-conflicts" (kebab-case) so the section=sync-conflicts
 * query param in notifications resolves correctly (exact-match lookup).
 *
 * Spec reference: W4-1 §6 (Task B).
 */

import { escapeHtml } from "../../shared/components.js";
import { fill, t } from "../../shared/i18n.js";
import {
  providerEndpointChanged,
  providerEndpointKey,
  providerOrigin,
  clearProviderEndpointHeldNotice,
  clearAllProviderEndpointHeldNotices,
} from "../../../../shared/provider-endpoint.js";
import {
  resolveConflict,
  restoreConflict,
  NATURAL_KEY_RESTORE_TABLES,
} from "../../../../sharing/sync-conflict-resolve.js";
import { getInstanceSyncManager } from "../../../../sharing/server.js";
import {
  EXPIRE_DAYS_DEFAULT,
  EXPIRE_DAYS_MAX,
  EXPIRE_DAYS_MIN,
  expiryColumns,
  markOpened,
  markResolvedVia,
  resolveOlderConflicts,
} from "../../../../sharing/sync-conflict-expiry.js";

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

/**
 * A held providers conflict is one this device refused to apply because the
 * peer's row MOVES the endpoint while the API key lives here (operator ruling
 * 2026-11-06; instance-sync.js _holdProviderEndpointChange). Show the operator
 * the one fact that matters before they press Restore. Every part is escaped.
 *
 * Only unresolved rows render it: a resolved row already had the decision made.
 */
function addressChangeLine(r, lang) {
  let win;
  let lose;
  try {
    win = JSON.parse(r.winning_data);
    lose = JSON.parse(r.losing_data);
  } catch {
    return "";
  }
  const before = win?.base_url;
  const after = lose?.base_url;
  if (!providerEndpointChanged(before, after)) return "";
  // The origin is what an operator recognises… except for a PATH-only move,
  // where both origins read the same; then show the address itself so the line
  // never says "https://x → https://x".
  const beforeOrigin = providerOrigin(before);
  const afterOrigin = providerOrigin(after);
  const from = beforeOrigin === afterOrigin
    ? (providerEndpointKey(before) || String(before ?? "")) : beforeOrigin;
  const to = beforeOrigin === afterOrigin
    ? (providerEndpointKey(after) || String(after ?? "")) : afterOrigin;
  return `<div style="margin:0 0 0.4rem;padding:0.4rem 0.6rem;background:var(--crow-bg-deep);border-left:3px solid #ff9800;border-radius:3px;font-size:0.78rem;max-width:32rem">
    ${escapeHtml(fill(t("syncConflicts.addressChange", lang), { from, to }))}
  </div>`;
}

/** Quiet the "another device wants to change its address" bell item once the
 *  operator has decided this conflict (kept the local address, or accepted it). */
async function clearHoldNotice(db, conflictId) {
  try {
    const { rows } = await db.execute({
      sql: `SELECT row_id FROM sync_conflicts WHERE id = ?`,
      args: [String(conflictId)],
    });
    if (rows[0]) await clearProviderEndpointHeldNotice(db, String(rows[0].row_id));
  } catch {
    // Best effort: the notice is a bell item, never a reason to fail the action.
  }
}

function prettyJson(raw) {
  if (!raw) return "(none)";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return String(raw);
  }
}

/** JSON safe inside a <script> and a template literal (models/client.js idiom). */
function scriptJson(v) {
  return JSON.stringify(v)
    .replace(/</g, "\\u003c")
    .replace(/`/g, "\\u0060")
    .replace(/\$/g, "\\u0024");
}

/**
 * "A person opened this conflict" tracker: one POST per row per page load, so
 * the expiry sweep leaves a row somebody actually looked at alone. Turbo swaps
 * the section content on navigation, which re-runs this script. Pages carry
 * `script-src 'unsafe-inline'`, so a plain inline script is the house pattern
 * here (see theme.js / shared-storage.js) — no nonce.
 */
function openedTrackerJS(csrfToken) {
  return `
(function () {
  var token = ${scriptJson(String(csrfToken || ""))};
  var rows = document.querySelectorAll('details.sc-details[data-conflict-id]');
  for (var i = 0; i < rows.length; i++) {
    (function (el) {
      el.addEventListener('toggle', function () {
        if (!el.open || el.dataset.openedSent) return;
        el.dataset.openedSent = '1';
        var body = new URLSearchParams();
        body.set('action', 'sync_conflicts_opened');
        body.set('conflict_id', el.dataset.conflictId);
        body.set('_csrf', token);
        fetch('/dashboard/settings', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        }).catch(function () {});
      });
    })(rows[i]);
  }
})();`;
}

// ── Conflict table row renderer ───────────────────────────────────────────────

function renderConflictRow(r, lang, csrfToken) {
  const when = fmtDate(r.created_at);
  const wId = shortId(r.winning_instance_id);
  const lId = shortId(r.losing_instance_id);
  const isInsert = (r.op === "insert");
  const isDelete = (r.op === "delete");
  // Natural-key tables (crow_context, contacts, contact_groups): the backend
  // refuses restore for these (NATURAL_KEY_RESTORE_TABLES is the single source
  // of truth in sync-conflict-resolve.js), so the button is disabled upfront
  // instead of click → refused flash (2c-F3).
  const isNaturalKey = NATURAL_KEY_RESTORE_TABLES.has(r.table_name);
  const resolved = !!r.resolved;

  const winJson = prettyJson(r.winning_data);
  const loseJson = prettyJson(r.losing_data);

  // Restore button is disabled for op='insert' conflicts per spec §6
  // (precedence FIRST — matches the backend's refusal order), then for
  // natural-key tables. crow_context keeps its composite-key wording.
  const restoreBtn = isInsert
    ? `<span style="font-size:0.78rem;color:var(--crow-text-muted);font-style:italic">
         ${escapeHtml(t("syncConflicts.insertRestoreDisabled", lang))}
       </span>`
    : isNaturalKey
    ? `<span style="font-size:0.78rem;color:var(--crow-text-muted);font-style:italic">
         ${escapeHtml(t(
           r.table_name === "crow_context"
             ? "syncConflicts.compositeRestoreDisabled"
             : "syncConflicts.naturalKeyRestoreDisabled",
           lang,
         ))}
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
        ${r.table_name === "providers" ? addressChangeLine(r, lang) : ""}
        <details class="sc-details" data-conflict-id="${escapeHtml(String(r.id))}">
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
  group: "advanced",
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
    let resolvedTotal = 0;
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
      const { rows: resolvedCount } = await db.execute({
        sql: `SELECT COUNT(*) AS n FROM sync_conflicts WHERE resolved = 1`,
        args: [],
      });
      unresolvedRows = unresolved;
      unresolvedTotal = Number(unresolvedCount[0]?.n || 0);
      resolvedRows = resolved;
      resolvedTotal = Number(resolvedCount[0]?.n || 0);
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

    // The escape hatch for a backlog: resolves EVERY unresolved row past the
    // cutoff (opened ones and newer-losers included) because a person asked.
    const resolveOlderForm = unresolvedRows.length > 0
      ? `<form method="POST" action="/dashboard/settings"
              style="margin-top:0.5rem;display:flex;gap:0.4rem;align-items:center;flex-wrap:wrap"
              onsubmit="return confirm(${escapeHtml(JSON.stringify(t("syncConflicts.resolveOlderConfirm", lang)))})">
           <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}" />
           <input type="hidden" name="action" value="sync_conflicts_resolve_older" />
           <label for="sc-days" style="font-size:0.82rem;color:var(--crow-text-muted)">
             ${escapeHtml(t("syncConflicts.resolveOlder", lang))}
           </label>
           <input id="sc-days" name="days" type="number" min="${EXPIRE_DAYS_MIN}" max="${EXPIRE_DAYS_MAX}"
                  step="1" value="${EXPIRE_DAYS_DEFAULT}" required style="width:5rem" />
           <span style="font-size:0.82rem;color:var(--crow-text-muted)">
             ${escapeHtml(t("syncConflicts.days", lang))}
           </span>
           <button type="submit" class="btn btn-secondary" style="font-size:0.82rem">
             ${escapeHtml(t("syncConflicts.resolveOlderButton", lang))}
           </button>
         </form>`
      : "";

    // Only rows that render an expandable pane need the opened tracker.
    const openedScript = unresolvedRows.length > 0
      ? `<script>${openedTrackerJS(csrfToken)}</script>`
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
      ${unresolvedTotal > 0 ? `<span style="font-size:0.78rem;color:#e53935;margin-left:0.4rem">(${unresolvedTotal})</span>` : ""}
    </h3>

    ${overLimitNotice}

    <div class="table-scroll">
      <table class="sc-table">
        ${cols}
        ${theadUnresolved}
        <tbody>${unresolvedTbody}</tbody>
      </table>
    </div>

    ${bulkResolveBtn}
    ${resolveOlderForm}

    <details style="margin-top:1.5rem">
      <summary style="cursor:pointer;font-size:0.85rem;color:var(--crow-text-muted);padding:0.4rem 0">
        ${escapeHtml(t("syncConflicts.resolvedHeading", lang))}
        ${resolvedTotal > 0 ? `(${resolvedTotal})` : ""}
      </summary>
      <div class="table-scroll" style="margin-top:0.5rem">
        <table class="sc-table">
          ${cols}
          ${theadResolved}
          <tbody>${resolvedTbody}</tbody>
        </table>
      </div>
    </details>

    ${openedScript}`;
  },

  async handleAction({ req, res, db, action }) {
    if (!action || !action.startsWith("sync_conflicts_")) return false;

    const conflictId = req.body?.conflict_id;
    const instanceSync = getInstanceSyncManager();
    const conflictPage = "/dashboard/settings?section=sync-conflicts";

    // Page-script ping: a person expanded this row's data. Replies 204 — there
    // is nothing to show and the page must not navigate.
    if (action === "sync_conflicts_opened") {
      if (conflictId) await markOpened(db, String(conflictId));
      res.status(204).end();
      return true;
    }

    if (action === "sync_conflicts_keep_current") {
      if (!conflictId) {
        res.redirectAfterPost(conflictPage);
        return true;
      }
      await resolveConflict(db, String(conflictId));
      await markResolvedVia(db, conflictId, "operator");
      await clearHoldNotice(db, conflictId);
      res.redirectAfterPost(conflictPage);
      return true;
    }

    if (action === "sync_conflicts_restore_other") {
      if (!conflictId) {
        res.redirectAfterPost(conflictPage);
        return true;
      }
      const outcome = await restoreConflict(db, String(conflictId), { instanceSync });
      if (outcome.status === "applied") {
        await markResolvedVia(db, conflictId, "operator");
        await clearHoldNotice(db, conflictId);
      }
      // Pass only the status enum; render() maps it to an i18n'd flash.
      const status = ["applied", "stale", "refused"].includes(outcome.status)
        ? outcome.status
        : "error";
      res.redirectAfterPost(`/dashboard/settings?section=sync-conflicts&syncConflictsMsg=${status}`);
      return true;
    }

    if (action === "sync_conflicts_resolve_all") {
      const cols = await expiryColumns(db);
      const via = cols.has("resolved_via") ? `, resolved_via = 'operator'` : "";
      await db.execute({
        sql: `UPDATE sync_conflicts SET resolved = 1, resolved_at = datetime('now')${via} WHERE resolved = 0`,
        args: [],
      });
      await clearAllProviderEndpointHeldNotices(db);
      res.redirectAfterPost(conflictPage);
      return true;
    }

    // Resolve everything past a cutoff a person typed in. Strictly validated:
    // an out-of-range hand-crafted POST must not resolve anything.
    if (action === "sync_conflicts_resolve_older") {
      const raw = String(req.body?.days ?? "").trim();
      const days = /^\d{1,3}$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isInteger(days) || days < EXPIRE_DAYS_MIN || days > EXPIRE_DAYS_MAX) {
        res.redirectAfterPost(conflictPage);
        return true;
      }
      await resolveOlderConflicts(db, { days });
      res.redirectAfterPost(conflictPage);
      return true;
    }

    return false;
  },
};
