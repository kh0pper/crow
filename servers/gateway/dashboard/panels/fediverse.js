/**
 * F.14: Fediverse Admin panel.
 *
 * Two-tab view over the federated-bundles operational surface:
 *   • Moderation Queue — pending moderation_actions (F.11) from the
 *     federated bundles (gotosocial/funkwhale/pixelfed/lemmy/mastodon/
 *     peertube). Operator confirms / rejects / views expired.
 *   • Crosspost Queue — queued/ready/manual/error entries from
 *     crosspost_log (F.12/F.13). Operator can cancel queued, re-drive
 *     manual ones (shows the transformed preview), or just view audit.
 *
 * Actions are POSTs from simple HTML forms — no client JS framework.
 * Auth: standard dashboardAuth on the parent route.
 */

import { t } from "../shared/i18n.js";

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtAgo(ts) {
  if (!ts) return "—";
  const delta = Math.floor(Date.now() / 1000) - Number(ts);
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}

function fmtFuture(ts) {
  if (!ts) return "—";
  const delta = Number(ts) - Math.floor(Date.now() / 1000);
  if (delta <= 0) return `ready`;
  if (delta < 60) return `in ${delta}s`;
  if (delta < 3600) return `in ${Math.floor(delta / 60)}m`;
  return `in ${Math.floor(delta / 3600)}h`;
}

async function loadModerationActions(db, filter) {
  const clauses = [];
  const args = [];
  if (filter === "pending") clauses.push("status = 'pending'");
  else if (filter === "confirmed") clauses.push("status = 'confirmed'");
  else if (filter === "expired") clauses.push("status = 'expired'");
  else if (filter === "rejected") clauses.push("status = 'rejected'");
  // "all" → no filter
  const sql = `SELECT id, bundle_id, action_type, payload_json, requested_by, requested_at,
                      expires_at, status, confirmed_by, confirmed_at, error
               FROM moderation_actions
               ${clauses.length ? "WHERE " + clauses.join(" AND ") : ""}
               ORDER BY requested_at DESC LIMIT 100`;
  const rows = await db.execute({ sql, args });
  return rows.rows.map((r) => ({
    id: Number(r.id),
    bundle_id: r.bundle_id,
    action_type: r.action_type,
    payload: (() => { try { return JSON.parse(r.payload_json); } catch { return null; } })(),
    requested_by: r.requested_by,
    requested_at: Number(r.requested_at),
    expires_at: Number(r.expires_at),
    status: r.status,
    confirmed_by: r.confirmed_by || null,
    confirmed_at: r.confirmed_at ? Number(r.confirmed_at) : null,
    error: r.error || null,
  }));
}

async function loadCrosspostLog(db, filter) {
  const clauses = [];
  const args = [];
  if (filter && filter !== "all") {
    clauses.push("status = ?");
    args.push(filter);
  }
  args.push(100);
  const sql = `SELECT id, idempotency_key, source_app, source_post_id, target_app, transform,
                      status, target_post_id, scheduled_at, published_at, cancelled_at, error,
                      created_at, transformed_payload_json
               FROM crosspost_log
               ${clauses.length ? "WHERE " + clauses.join(" AND ") : ""}
               ORDER BY created_at DESC LIMIT ?`;
  const rows = await db.execute({ sql, args });
  return rows.rows.map((r) => {
    let preview = null;
    try {
      const tp = JSON.parse(r.transformed_payload_json || "null");
      if (tp) preview = (tp.status || tp.caption || JSON.stringify(tp)).slice(0, 180);
    } catch {}
    return {
      id: Number(r.id),
      source_app: r.source_app,
      source_post_id: r.source_post_id,
      target_app: r.target_app,
      transform: r.transform,
      status: r.status,
      target_post_id: r.target_post_id || null,
      scheduled_at: Number(r.scheduled_at),
      published_at: r.published_at ? Number(r.published_at) : null,
      cancelled_at: r.cancelled_at ? Number(r.cancelled_at) : null,
      error: r.error || null,
      created_at: Number(r.created_at),
      preview,
    };
  });
}

function renderTabs(active) {
  const tab = (id, label) =>
    `<a href="?tab=${id}" class="fd-tab ${active === id ? "fd-tab-active" : ""}">${label}</a>`;
  return `<div class="fd-tabs">${tab("moderation", "Moderation Queue")}${tab("crosspost", "Crosspost Queue")}</div>`;
}

function renderModerationSection(lang, items, filter) {
  const filters = ["pending", "confirmed", "expired", "rejected", "all"];
  const filterLinks = filters
    .map((f) => `<a href="?tab=moderation&filter=${f}" class="fd-filter ${filter === f ? "fd-filter-active" : ""}">${f}</a>`)
    .join("");

  const rows = items.length === 0
    ? `<tr><td colspan="6" class="fd-empty">No entries in '${escapeHtml(filter)}'.</td></tr>`
    : items.map((a) => {
        const payloadSummary = a.payload ? Object.entries(a.payload)
          .map(([k, v]) => `<b>${escapeHtml(k)}:</b> ${escapeHtml(String(v).slice(0, 120))}`)
          .join("<br>") : "(no payload)";
        const actions = a.status === "pending"
          ? `<form method="POST" action="/dashboard/fediverse/action" style="display:inline">
              <input type="hidden" name="tab" value="moderation">
              <input type="hidden" name="action" value="confirm_moderation">
              <input type="hidden" name="id" value="${a.id}">
              <button class="fd-btn fd-btn-confirm" type="submit">Confirm</button>
            </form>
            <form method="POST" action="/dashboard/fediverse/action" style="display:inline">
              <input type="hidden" name="tab" value="moderation">
              <input type="hidden" name="action" value="reject_moderation">
              <input type="hidden" name="id" value="${a.id}">
              <button class="fd-btn fd-btn-reject" type="submit">Reject</button>
            </form>`
          : "";
        return `<tr class="fd-row fd-status-${escapeHtml(a.status)}">
          <td class="fd-cell-id">#${a.id}</td>
          <td>
            <div class="fd-bundle">${escapeHtml(a.bundle_id)}</div>
            <div class="fd-action-type">${escapeHtml(a.action_type)}</div>
          </td>
          <td class="fd-payload">${payloadSummary}</td>
          <td>
            <div>req: ${fmtAgo(a.requested_at)} <span class="fd-muted">by ${escapeHtml(a.requested_by)}</span></div>
            <div class="fd-expiry">expires: ${fmtFuture(a.expires_at)}</div>
            ${a.confirmed_at ? `<div>confirmed: ${fmtAgo(a.confirmed_at)}</div>` : ""}
          </td>
          <td><span class="fd-status-badge fd-status-${escapeHtml(a.status)}">${escapeHtml(a.status)}</span></td>
          <td>${actions}</td>
        </tr>`;
      }).join("");

  return `
    <section class="fd-section">
      <div class="fd-filter-bar">${filterLinks}</div>
      <table class="fd-table">
        <thead><tr><th>#</th><th>Bundle / Action</th><th>Payload</th><th>Timing</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="fd-help">Pending actions auto-expire after 72h via the F.13 GC sweeper. Confirming here records your approval but DOES NOT yet auto-fire the action against the federated app — a follow-up scheduler PR wires that end-to-end; for now, confirming + then invoking the bundle's own moderation verb by hand is the expected flow.</p>
    </section>`;
}

function renderCrosspostSection(lang, items, filter) {
  const filters = ["queued", "ready", "published", "manual", "error", "cancelled", "all"];
  const filterLinks = filters
    .map((f) => `<a href="?tab=crosspost&filter=${f}" class="fd-filter ${filter === f ? "fd-filter-active" : ""}">${f}</a>`)
    .join("");

  const rows = items.length === 0
    ? `<tr><td colspan="6" class="fd-empty">No entries in '${escapeHtml(filter)}'.</td></tr>`
    : items.map((c) => {
        const actions = (c.status === "queued" || c.status === "ready")
          ? `<form method="POST" action="/dashboard/fediverse/action" style="display:inline">
              <input type="hidden" name="tab" value="crosspost">
              <input type="hidden" name="action" value="cancel_crosspost">
              <input type="hidden" name="id" value="${c.id}">
              <button class="fd-btn fd-btn-reject" type="submit">Cancel</button>
            </form>`
          : c.status === "error"
          ? `<form method="POST" action="/dashboard/fediverse/action" style="display:inline">
              <input type="hidden" name="tab" value="crosspost">
              <input type="hidden" name="action" value="retry_crosspost">
              <input type="hidden" name="id" value="${c.id}">
              <button class="fd-btn fd-btn-confirm" type="submit">Retry</button>
            </form>`
          : "";
        const whenInfo = c.status === "queued"
          ? `fires: ${fmtFuture(c.scheduled_at)}`
          : c.status === "published"
          ? `published: ${fmtAgo(c.published_at)}`
          : c.status === "cancelled"
          ? `cancelled: ${fmtAgo(c.cancelled_at)}`
          : `scheduled: ${fmtAgo(c.scheduled_at)}`;
        return `<tr class="fd-row fd-status-${escapeHtml(c.status)}">
          <td class="fd-cell-id">#${c.id}</td>
          <td>
            <div class="fd-transform">${escapeHtml(c.transform || `${c.source_app}→${c.target_app}`)}</div>
            <div class="fd-source">source: ${escapeHtml(c.source_app)}#${escapeHtml(c.source_post_id)}</div>
            ${c.target_post_id ? `<div class="fd-target">target: ${escapeHtml(c.target_app)}#${escapeHtml(c.target_post_id)}</div>` : ""}
          </td>
          <td class="fd-preview">${c.preview ? escapeHtml(c.preview) : "<span class=fd-muted>(no preview)</span>"}</td>
          <td>
            <div>${escapeHtml(whenInfo)}</div>
            <div class="fd-muted">created: ${fmtAgo(c.created_at)}</div>
            ${c.error ? `<div class="fd-error">err: ${escapeHtml(c.error.slice(0, 120))}</div>` : ""}
          </td>
          <td><span class="fd-status-badge fd-status-${escapeHtml(c.status)}">${escapeHtml(c.status)}</span></td>
          <td>${actions}</td>
        </tr>`;
      }).join("");

  return `
    <section class="fd-section">
      <div class="fd-filter-bar">${filterLinks}</div>
      <table class="fd-table">
        <thead><tr><th>#</th><th>Route</th><th>Preview</th><th>Timing</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="fd-help">The F.13 scheduler polls every 15s, auto-publishes <code>ready</code>/<code>queued</code> entries to mastodon/gotosocial/crow-blog, and marks media-heavy / context-specific targets as <code>manual</code>. Cancel a queued entry before <code>scheduled_at</code> arrives to prevent publication.</p>
    </section>`;
}

function style() {
  return `<style>
    .fd-root { max-width: 1100px; }
    .fd-root h1 { margin: 0 0 1rem; font-size: 1.4rem; }
    .fd-subtitle { color: var(--crow-text-muted); font-size: 0.9rem; margin-bottom: 1.2rem; }
    .fd-tabs { display: flex; gap: .5rem; margin-bottom: 1rem; border-bottom: 1px solid var(--crow-border); }
    .fd-tab { padding: .5rem .9rem; color: var(--crow-text-muted); text-decoration: none; border-bottom: 2px solid transparent; }
    .fd-tab-active { color: var(--crow-text-primary); border-bottom-color: var(--crow-accent); font-weight: 600; }
    .fd-filter-bar { margin-bottom: 1rem; display: flex; gap: .4rem; flex-wrap: wrap; }
    .fd-filter { font-size: .8rem; padding: .25rem .6rem; border: 1px solid var(--crow-border); border-radius: 14px;
                  color: var(--crow-text-muted); text-decoration: none; text-transform: lowercase; }
    .fd-filter-active { background: var(--crow-accent); color: var(--crow-bg); border-color: var(--crow-accent); }
    .fd-section { background: var(--crow-bg-elevated); border: 1px solid var(--crow-border); border-radius: 10px; padding: 1rem; }
    .fd-table { width: 100%; border-collapse: collapse; font-size: .85rem; }
    .fd-table th { text-align: left; font-weight: 500; color: var(--crow-text-muted); padding: .4rem .6rem; border-bottom: 1px solid var(--crow-border); font-size: .75rem; text-transform: uppercase; letter-spacing: .05em; }
    .fd-table td { padding: .5rem .6rem; vertical-align: top; border-bottom: 1px solid var(--crow-border); }
    .fd-row:last-child td { border-bottom: none; }
    .fd-cell-id { font-family: ui-monospace, monospace; color: var(--crow-text-muted); font-size: .75rem; }
    .fd-bundle { font-weight: 600; color: var(--crow-text-primary); }
    .fd-action-type, .fd-transform { font-family: ui-monospace, monospace; color: var(--crow-accent); font-size: .8rem; }
    .fd-source, .fd-target { font-family: ui-monospace, monospace; color: var(--crow-text-muted); font-size: .75rem; }
    .fd-payload { font-size: .8rem; color: var(--crow-text-secondary); max-width: 320px; word-break: break-word; }
    .fd-preview { max-width: 340px; font-size: .8rem; color: var(--crow-text-secondary); word-break: break-word; }
    .fd-muted { color: var(--crow-text-muted); font-size: .75rem; }
    .fd-error { color: #ef4444; font-family: ui-monospace, monospace; font-size: .7rem; margin-top: .2rem; }
    .fd-status-badge { font-size: .7rem; text-transform: uppercase; letter-spacing: .04em; padding: 2px 6px; border-radius: 10px; }
    .fd-status-badge.fd-status-pending { background: rgba(234,179,8,.15); color: #eab308; }
    .fd-status-badge.fd-status-confirmed, .fd-status-badge.fd-status-published { background: rgba(34,197,94,.15); color: #22c55e; }
    .fd-status-badge.fd-status-expired, .fd-status-badge.fd-status-cancelled, .fd-status-badge.fd-status-rejected, .fd-status-badge.fd-status-manual { background: rgba(148,163,184,.15); color: #94a3b8; }
    .fd-status-badge.fd-status-error { background: rgba(239,68,68,.15); color: #ef4444; }
    .fd-status-badge.fd-status-queued, .fd-status-badge.fd-status-ready { background: rgba(59,130,246,.15); color: #3b82f6; }
    .fd-btn { font-size: .75rem; padding: .3rem .6rem; border-radius: 4px; border: 1px solid var(--crow-border); background: var(--crow-bg); color: var(--crow-text-primary); cursor: pointer; }
    .fd-btn-confirm { background: #22c55e; border-color: #22c55e; color: white; }
    .fd-btn-reject { background: transparent; border-color: #ef4444; color: #ef4444; }
    .fd-btn:hover { opacity: .8; }
    .fd-empty { text-align: center; color: var(--crow-text-muted); padding: 1.5rem; }
    .fd-help { font-size: .8rem; color: var(--crow-text-muted); margin-top: 1rem; padding-top: .8rem; border-top: 1px solid var(--crow-border); }
    .fd-help code { font-family: ui-monospace, monospace; background: var(--crow-bg); padding: 1px 4px; border-radius: 3px; }
    .fd-flash { padding: .5rem .8rem; border-radius: 6px; margin-bottom: .8rem; font-size: .85rem; }
    .fd-flash-ok { background: rgba(34,197,94,.12); color: #22c55e; }
    .fd-flash-err { background: rgba(239,68,68,.12); color: #ef4444; }
  </style>`;
}

export default {
  id: "fediverse",
  name: "Fediverse Admin",
  icon: "globe",
  route: "/dashboard/fediverse",
  navOrder: 80,
  category: "connections",

  async handler(req, res, { db, lang, layout }) {
    const tab = (req.query.tab === "crosspost") ? "crosspost" : "moderation";
    const filter = String(req.query.filter || (tab === "moderation" ? "pending" : "queued"));
    const flash = req.query.flash;

    let flashHtml = "";
    if (flash === "confirmed") flashHtml = `<div class="fd-flash fd-flash-ok">Moderation action confirmed (still needs manual fire — see help text).</div>`;
    else if (flash === "rejected") flashHtml = `<div class="fd-flash fd-flash-ok">Moderation action rejected.</div>`;
    else if (flash === "cancelled") flashHtml = `<div class="fd-flash fd-flash-ok">Crosspost cancelled.</div>`;
    else if (flash === "retried") flashHtml = `<div class="fd-flash fd-flash-ok">Crosspost re-queued for another attempt.</div>`;
    else if (flash && flash.startsWith("err_")) flashHtml = `<div class="fd-flash fd-flash-err">Error: ${escapeHtml(flash.slice(4))}</div>`;

    let section;
    if (tab === "moderation") {
      const items = await loadModerationActions(db, filter);
      section = renderModerationSection(lang, items, filter);
    } else {
      const items = await loadCrosspostLog(db, filter);
      section = renderCrosspostSection(lang, items, filter);
    }

    const content = `
      ${style()}
      <div class="fd-root">
        <h1>Fediverse Admin</h1>
        <div class="fd-subtitle">Moderation queue + crosspost queue. Destructive actions from F.11 and queued crossposts from F.12/F.13 land here for operator review.</div>
        ${flashHtml}
        ${renderTabs(tab)}
        ${section}
      </div>`;
    return layout({ title: "Fediverse Admin", content });
  },

  // POST action handler wired via the main dashboardRouter below
  async handleAction(req, res, { db }) {
    const { tab, action, id } = req.body || {};
    const idNum = Number(id);
    if (!idNum) { res.redirect(`/dashboard/fediverse?tab=${tab || "moderation"}&flash=err_missing_id`); return; }
    try {
      if (action === "confirm_moderation") {
        const now = Math.floor(Date.now() / 1000);
        await db.execute({
          sql: "UPDATE moderation_actions SET status = 'confirmed', confirmed_by = ?, confirmed_at = ? WHERE id = ? AND status = 'pending'",
          args: [String(req.user?.id || "operator"), now, idNum],
        });
        res.redirect(`/dashboard/fediverse?tab=moderation&flash=confirmed`);
        return;
      }
      if (action === "reject_moderation") {
        const now = Math.floor(Date.now() / 1000);
        await db.execute({
          sql: "UPDATE moderation_actions SET status = 'rejected', confirmed_by = ?, confirmed_at = ? WHERE id = ? AND status = 'pending'",
          args: [String(req.user?.id || "operator"), now, idNum],
        });
        res.redirect(`/dashboard/fediverse?tab=moderation&flash=rejected`);
        return;
      }
      if (action === "cancel_crosspost") {
        const now = Math.floor(Date.now() / 1000);
        await db.execute({
          sql: "UPDATE crosspost_log SET status = 'cancelled', cancelled_at = ? WHERE id = ? AND status IN ('queued','ready')",
          args: [now, idNum],
        });
        res.redirect(`/dashboard/fediverse?tab=crosspost&flash=cancelled`);
        return;
      }
      if (action === "retry_crosspost") {
        const now = Math.floor(Date.now() / 1000);
        await db.execute({
          sql: "UPDATE crosspost_log SET status = 'ready', error = NULL, scheduled_at = ? WHERE id = ? AND status = 'error'",
          args: [now, idNum],
        });
        res.redirect(`/dashboard/fediverse?tab=crosspost&flash=retried`);
        return;
      }
      res.redirect(`/dashboard/fediverse?tab=${tab || "moderation"}&flash=err_unknown_action`);
    } catch (err) {
      const msg = encodeURIComponent(String(err.message || err).slice(0, 80));
      res.redirect(`/dashboard/fediverse?tab=${tab || "moderation"}&flash=err_${msg}`);
    }
  },
};
