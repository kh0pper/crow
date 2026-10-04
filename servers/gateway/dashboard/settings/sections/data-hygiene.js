/**
 * Settings Section: Data hygiene (System group)
 *
 * Operator-run repairs, every one DRY-RUN BY DEFAULT: rendering the page only
 * scans and previews; nothing is deleted until the operator presses the
 * confirm-gated button (POST through csrfMiddleware like every settings action).
 *
 *   purge_orphan_messages  — delete `messages` rows whose contact no longer
 *                            exists (the contact-delete cascade's semantics:
 *                            local delete; messages never sync deletes).
 *   bulk_delete_contacts   — delete contacts whose display name matches a
 *                            pattern, each through deleteContactLocal (the
 *                            #155 user-delete path: tombstone + broadcast, so
 *                            paired instances converge).
 *
 * Logic lives in servers/sharing/data-hygiene.js.
 */

import { escapeHtml } from "../../shared/components.js";
import { t, fill } from "../../shared/i18n.js";
import {
  scanOrphanedMessages, purgeOrphanedMessages, previewContactsByName, bulkDeleteContactsByName,
} from "../../../../sharing/data-hygiene.js";
import { getManagersOrNull } from "../../../../sharing/managers.js";

const BASE = "/dashboard/settings?section=data-hygiene";

function flash(req, lang) {
  const q = req?.query || {};
  if (q.purged != null) {
    return `<div class="alert alert-success">${escapeHtml(fill(t("hygiene.purgedMessages", lang), { n: Number(q.purged) || 0, q: Number(q.purged_q) || 0 }))}</div>`;
  }
  if (q.purge_refused) return `<div class="alert alert-error">${escapeHtml(t("hygiene.countChanged", lang))}</div>`;
  if (q.contacts_deleted != null) {
    const skipped = Number(q.contacts_skipped) || 0;
    return `<div class="alert alert-success">${escapeHtml(fill(t("hygiene.contactsDeleted", lang), { n: Number(q.contacts_deleted) || 0, skipped }))}</div>`;
  }
  if (q.contacts_error) return `<div class="alert alert-error">${escapeHtml(t("hygiene.badPattern", lang))}</div>`;
  return "";
}

export default {
  id: "data-hygiene",
  group: "system",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>`,
  labelKey: "settings.section.dataHygiene",
  navOrder: 40,

  async getPreview({ db }) {
    try {
      const s = await scanOrphanedMessages(db);
      return s.messages > 0 ? `${s.messages} orphaned` : "clean";
    } catch {
      return "-";
    }
  },

  async render({ req, db, lang }) {
    const csrf = escapeHtml(req?.csrfToken || "");
    const scan = await scanOrphanedMessages(db);

    // ── orphaned messages ──
    let orphanHtml;
    if (scan.messages === 0 && scan.retryQueue === 0) {
      orphanHtml = `<p style="color:var(--crow-text-muted);font-size:0.88rem">${escapeHtml(t("hygiene.noOrphans", lang))}</p>`;
    } else {
      const rows = scan.byContact.map((r) => `<tr>
          <td style="padding:6px;font-family:'JetBrains Mono',monospace">${escapeHtml(r.contact_id == null ? "NULL" : String(r.contact_id))}</td>
          <td style="padding:6px">${escapeHtml(String(r.n))}</td>
          <td style="padding:6px;font-size:0.78rem;color:var(--crow-text-muted)">${escapeHtml(r.first || "-")} → ${escapeHtml(r.last || "-")}</td>
        </tr>`).join("");
      const confirmMsg = JSON.stringify(fill(t("hygiene.purgeConfirm", lang), { n: scan.messages }));
      orphanHtml = `
        <p style="font-size:0.88rem">${escapeHtml(fill(t("hygiene.orphansFound", lang), { n: scan.messages, q: scan.retryQueue }))}</p>
        <div class="table-scroll"><table class="pi-table">
          <thead><tr><th>contact_id</th><th>${escapeHtml(t("hygiene.colMessages", lang))}</th><th>${escapeHtml(t("hygiene.colRange", lang))}</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
        <form method="POST" action="/dashboard/settings" style="margin-top:0.75rem" onsubmit="return confirm(${escapeHtml(confirmMsg)})">
          <input type="hidden" name="_csrf" value="${csrf}" />
          <input type="hidden" name="action" value="purge_orphan_messages" />
          <input type="hidden" name="expected" value="${scan.messages}" />
          <input type="hidden" name="confirm" value="1" />
          <button type="submit" class="btn btn-secondary">${escapeHtml(fill(t("hygiene.purgeButton", lang), { n: scan.messages }))}</button>
        </form>`;
    }

    // ── contacts by name pattern (preview is a GET: side-effect free) ──
    const pattern = typeof req?.query?.pattern === "string" ? req.query.pattern.slice(0, 100) : "";
    let previewHtml = "";
    if (pattern) {
      const pv = await previewContactsByName(db, pattern);
      if (!pv.like) {
        previewHtml = `<div class="alert alert-error">${escapeHtml(t("hygiene.badPattern", lang))}</div>`;
      } else if (pv.matches.length === 0) {
        previewHtml = `<p style="color:var(--crow-text-muted);font-size:0.88rem">${escapeHtml(t("hygiene.noMatches", lang))}</p>`;
      } else {
        const rows = pv.matches.map((r) => `<tr>
            <td style="padding:6px">${escapeHtml(r.display_name || "-")}</td>
            <td style="padding:6px;font-family:'JetBrains Mono',monospace;font-size:0.75rem">${escapeHtml(String(r.crow_id).slice(0, 24))}</td>
            <td style="padding:6px;font-size:0.78rem">${escapeHtml(r.origin || "-")}</td>
            <td style="padding:6px;font-size:0.78rem;color:var(--crow-text-muted)">${escapeHtml(r.created_at || "-")}</td>
          </tr>`).join("");
        const confirmMsg = JSON.stringify(fill(t("hygiene.contactsConfirm", lang), { n: pv.matches.length, pattern }));
        previewHtml = `
          <p style="font-size:0.88rem">${escapeHtml(fill(t("hygiene.matches", lang), { n: pv.matches.length }))}${pv.truncated ? " " + escapeHtml(t("hygiene.truncated", lang)) : ""}${pv.protected.length ? " " + escapeHtml(fill(t("hygiene.protected", lang), { n: pv.protected.length })) : ""}</p>
          <div class="table-scroll"><table class="pi-table">
            <thead><tr><th>${escapeHtml(t("hygiene.colName", lang))}</th><th>Crow ID</th><th>${escapeHtml(t("hygiene.colOrigin", lang))}</th><th>${escapeHtml(t("hygiene.colCreated", lang))}</th></tr></thead>
            <tbody>${rows}</tbody>
          </table></div>
          <form method="POST" action="/dashboard/settings" style="margin-top:0.75rem" onsubmit="return confirm(${escapeHtml(confirmMsg)})">
            <input type="hidden" name="_csrf" value="${csrf}" />
            <input type="hidden" name="action" value="bulk_delete_contacts" />
            <input type="hidden" name="pattern" value="${escapeHtml(pattern)}" />
            <input type="hidden" name="contact_ids" value="${escapeHtml(pv.matches.map((r) => r.id).join(","))}" />
            <input type="hidden" name="confirm" value="1" />
            <button type="submit" class="btn btn-secondary">${escapeHtml(fill(t("hygiene.contactsButton", lang), { n: pv.matches.length }))}</button>
          </form>`;
      }
    }

    return `${flash(req, lang)}<style>
      .pi-table { width:100%; border-collapse:collapse; font-size:0.88rem; }
      .pi-table th { text-align:left; padding:6px; background:var(--crow-bg-deep); color:var(--crow-text-muted); font-weight:500; font-size:0.75rem; }
      .pi-table tr { border-bottom:1px solid var(--crow-border); }
    </style>
    <p style="font-size:0.85rem;color:var(--crow-text-muted);margin-bottom:1rem">${escapeHtml(t("hygiene.intro", lang))}</p>

    <h3 style="font-size:1rem;margin:0 0 0.5rem">${escapeHtml(t("hygiene.orphansTitle", lang))}</h3>
    ${orphanHtml}

    <h3 style="font-size:1rem;margin:1.5rem 0 0.5rem">${escapeHtml(t("hygiene.contactsTitle", lang))}</h3>
    <p style="font-size:0.82rem;color:var(--crow-text-muted)">${escapeHtml(t("hygiene.contactsHelp", lang))}</p>
    <form method="GET" action="/dashboard/settings" style="display:flex;gap:0.5rem;align-items:center;margin-bottom:0.75rem">
      <input type="hidden" name="section" value="data-hygiene" />
      <input type="text" name="pattern" value="${escapeHtml(pattern)}" maxlength="100" placeholder="streamable" style="flex:1" />
      <button type="submit" class="btn btn-primary">${escapeHtml(t("hygiene.preview", lang))}</button>
    </form>
    ${previewHtml}
    `;
  },

  async handleAction({ req, res, db, action }) {
    if (action === "purge_orphan_messages") {
      const r = await purgeOrphanedMessages(db, {
        confirm: req.body.confirm === "1",
        expected: req.body.expected != null && req.body.expected !== "" ? Number(req.body.expected) : null,
      });
      if (r.refused) {
        res.redirectAfterPost(`${BASE}&purge_refused=1`);
      } else if (r.dryRun) {
        res.redirectAfterPost(BASE); // unconfirmed: nothing to report
      } else {
        console.log(`[data-hygiene] purged ${r.deleted.messages} orphaned message(s), ${r.deleted.retryQueue} retry-queue row(s)`);
        res.redirectAfterPost(`${BASE}&purged=${r.deleted.messages}&purged_q=${r.deleted.retryQueue}`);
      }
      return true;
    }
    if (action === "bulk_delete_contacts") {
      const ids = String(req.body.contact_ids || "").split(",").map((s) => s.trim()).filter(Boolean);
      const r = await bulkDeleteContactsByName(db, getManagersOrNull() || {}, {
        pattern: String(req.body.pattern || ""),
        ids,
        confirm: req.body.confirm === "1",
      });
      if (!r.ok) {
        res.redirectAfterPost(`${BASE}&contacts_error=${encodeURIComponent(r.reason)}`);
      } else {
        console.log(`[data-hygiene] bulk contact delete: ${r.deleted} deleted, ${r.skipped.length} skipped`);
        res.redirectAfterPost(`${BASE}&contacts_deleted=${r.deleted}&contacts_skipped=${r.skipped.length}`);
      }
      return true;
    }
    return false;
  },
};
