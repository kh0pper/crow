/**
 * Bot Builder Panel — HTML (list, create form, run monitor)
 *
 * Renders the bot list (pi_bot_defs), the Create an agent form,
 * and the Run monitor (bot_sessions — live, 5s Turbo replace).
 * Mostly literal English (operator-facing labels and data-status values);
 * new user-facing copy (providers link) is i18n-keyed. The run-monitor
 * tbody is VOLATILE-SKIP (replaced every 5s by routes/streams.js, spec rule 5).
 */

import { escapeHtml, section, badge, dataTable, formField, actionBar } from "../../shared/components.js";
import { csrfInput } from "../../shared/csrf.js";
import { loadModelOptions } from "./data-queries.js";
import { t, SUPPORTED_LANGS } from "../../shared/i18n.js";
import { parseCookies } from "../../auth.js";

// Same crow_lang-cookie resolution the dashboard router uses (index.js);
// defensive because tests render with header-less reqs.
function reqLang(req) {
  try {
    const c = parseCookies(req).crow_lang;
    return SUPPORTED_LANGS.includes(c) ? c : "en";
  } catch { return "en"; }
}

export async function renderBotList(res, { db, layout, notice, PAGE_CSS, req }) {
  const lang = reqLang(req);
  let bots = [], sessions = [], sessRows = [];
  try {
    bots = (await db.execute({ sql: "SELECT bot_id, display_name, enabled, definition, project_id, datetime(updated_at) AS updated_at FROM pi_bot_defs ORDER BY bot_id", args: [] })).rows;
    sessions = (await db.execute({ sql: "SELECT bot_id, status, count(*) AS n FROM bot_sessions GROUP BY bot_id, status", args: [] })).rows;
    sessRows = (await db.execute({ sql: "SELECT id, bot_id, status, model, escalated, control, card_id, gateway_thread_id, datetime(updated_at) AS updated_at FROM bot_sessions ORDER BY updated_at DESC LIMIT 50", args: [] })).rows;
  } catch { /* defensive */ }
  const sessSummary = (id) => sessions.filter((s) => s.bot_id === id).map((s) => `${escapeHtml(s.status)}:${s.n}`).join(" ") || "—";
  const rows = bots.map((bt) => {
    let model = "—", trackerType = "none";
    try { const d = JSON.parse(bt.definition || "{}"); model = (d.models && d.models.default) || "—"; trackerType = (d.tracker_config && d.tracker_config.type) || "kanban"; } catch {}
    // M3b: project_id from the column (not JSON).
    const proj = bt.project_id == null ? "—" : bt.project_id;
    const boardLink = bt.enabled && trackerType !== "none"
      ? `<a href="/dashboard/bot-board?bot=${encodeURIComponent(bt.bot_id)}">Board</a>` : "";
    return [
      `<a href="/dashboard/bot-builder?bot=${encodeURIComponent(bt.bot_id)}&tab=ai">${escapeHtml(bt.bot_id)}</a>`,
      escapeHtml(bt.display_name || ""),
      bt.enabled ? badge("enabled", "connected") : badge("disabled", "draft"),
      escapeHtml(String(model)),
      escapeHtml(String(proj)),
      escapeHtml(sessSummary(bt.bot_id)),
      escapeHtml(bt.updated_at || ""),
      boardLink,
      `<a href="/dashboard/bot-builder?bot=${encodeURIComponent(bt.bot_id)}&tab=ai">Edit</a>`,
      `<a class="btb-danger-link" href="/dashboard/bot-builder?bot=${encodeURIComponent(bt.bot_id)}&confirm_delete=1">${t("botbuilder.deleteBotLink", lang)}</a>`,
    ];
  });
  // Item 5 PR1 (spec §D1): the guided wizard is the primary creation path.
  const wizCta =
    `<p style="margin:0 0 1rem"><a class="btn btn-primary btn-md" href="/dashboard/bot-builder?new=1">${t("botbuilder.wizCta", lang)}</a></p>`;
  const list = section("Bots (pi_bot_defs)",
    notice + wizCta + (rows.length
      ? dataTable(["bot_id", "name", "state", "model", "project", "sessions", "updated", "board", "", ""], rows)
      : `<p>${t("botbuilder.emptyListWizard", lang)} <a href="/dashboard/bot-builder?new=1">${t("botbuilder.emptyListWizardLink", lang)}</a></p>`));
  // Create form: project + model dropdowns (Phase 1, S3 plan review)
  let createProjects = [];
  try { createProjects = (await db.execute({ sql: "SELECT id, name, slug FROM project_spaces WHERE archived_at IS NULL ORDER BY id", args: [] })).rows; } catch {}
  const projCreateOpts = createProjects.map((p) => `<option value="${p.id}">#${p.id} &mdash; ${escapeHtml(p.name || "")} (${escapeHtml(p.slug || "")})</option>`).join("");
  const { opts: createModelOpts, error: createModelErr } = await loadModelOptions(db);
  const createByProv = {};
  for (const o of createModelOpts) (createByProv[o.provider] = createByProv[o.provider] || []).push(o);
  // Item 4 PR1 (§2.1): no hardcoded `selected` pin — the browser's natural
  // first-option default is the honest choice on any install.
  const createOptGroups = Object.keys(createByProv).map((p) =>
    `<optgroup label="${escapeHtml(p)}">` +
    createByProv[p].map((m) => `<option value="${escapeHtml(m.key)}">${escapeHtml(m.label)}</option>`).join("") +
    `</optgroup>`
  ).join("");
  // Empty/error model state: warn + link to provider settings, and disable
  // submit — never render a submittable form with an empty model select.
  const modelsUnavailable = !!createModelErr || createModelOpts.length === 0;
  const modelWarn = modelsUnavailable
    ? `<p class="btb-warn">${escapeHtml(createModelErr || "No providers configured.")} ` +
      `<a href="/dashboard/settings?section=llm&amp;tab=providers">${t("botbuilder.createProvidersLink", lang)}</a></p>`
    : "";
  // Item 5 PR1: quick create collapses into an advanced disclosure — the
  // wizard (CTA above) is the primary path. Form contents unchanged.
  const form = section("Create an agent",
    `<details class="btb-quick-create"><summary>${t("botbuilder.quickCreateSummary", lang)}</summary>` +
    `<form method="POST" class="btb-form"><input type="hidden" name="action" value="create">${csrfInput(req)}` +
    formField("Bot id (slug)", "bot_id", { required: true, placeholder: "research-scout" }) +
    formField("Display name", "display_name", { required: true, placeholder: "Research Scout" }) +
    `<div class="btb-group"><label>Linked project</label>` +
    `<select name="project_id" class="btb-select"><option value="">&mdash; none &mdash;</option>${projCreateOpts}</select></div>` +
    modelWarn +
    `<div class="btb-group"><label>Model</label>` +
    `<select name="model" class="btb-select">${createOptGroups}</select></div>` +
    actionBar(`<button type="submit" class="btb-btn"${modelsUnavailable ? " disabled" : ""}>Create</button>`) + `</form>` +
    `<p class="btb-hint">Creates a v0.1 bot with safe defaults; then use the tabbed editor (AI &middot; Tools &middot; Gateways &middot; Project &middot; Skills &middot; Permissions &middot; Triggers &middot; Review).</p>` +
    `</details>`);
  // Run monitor — live bot_sessions (the bridge's runtime authority).
  // Initial server render + a poll-based SSE source (the bridge is a
  // separate process; /dashboard/streams/bot-sessions replaces the tbody
  // every 5s). #pibot-sessions-tbody is the Turbo replace target.
  const statusClass = (s) => {
    if (s === "active" || s === "done") return "btb-ok";
    if (s === "waiting-user") return "btb-status-warn";
    if (s === "error") return "btb-err";
    return "btb-muted";
  };
  const monRows = sessRows.length
    ? sessRows.map((s) => {
        const cls = statusClass(s.status);
        return `<tr>` +
          `<td>${escapeHtml(String(s.id))}</td>` +
          `<td>${escapeHtml(String(s.bot_id || ""))}</td>` +
          `<td class="${cls}">${escapeHtml(String(s.status || ""))}</td>` +
          `<td class="btb-mono">${escapeHtml(String(s.model || "—"))}</td>` +
          `<td>${Number(s.escalated) ? "yes" : "—"}</td>` +
          `<td>${escapeHtml(String(s.control || ""))}</td>` +
          `<td>${s.card_id == null ? "—" : escapeHtml(String(s.card_id))}</td>` +
          `<td class="btb-mono">${escapeHtml(String(s.gateway_thread_id || "").slice(0, 18))}</td>` +
          `<td class="btb-muted">${escapeHtml(String(s.updated_at || ""))}</td>` +
          `</tr>`;
      }).join("")
    : `<tr><td colspan="9" class="btb-muted" style="padding:.5rem">No bot sessions yet.</td></tr>`;
  const monitor = section("Run monitor (bot_sessions — live, 5s)",
    `<turbo-stream-source src="/dashboard/streams/bot-sessions"></turbo-stream-source>` +
    `<table class="btb-monitor"><thead><tr>` +
    `<th>id</th><th>bot</th><th>status</th>` +
    `<th>model</th><th>esc</th>` +
    `<th>control</th><th>card</th><th>thread</th>` +
    `<th>updated</th></tr></thead>` +
    `<tbody id="pibot-sessions-tbody">${monRows}</tbody></table>`);
  return res.send(layout({ title: "Bot Builder", content: PAGE_CSS + list + monitor + form }));
}
