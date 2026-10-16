/**
 * Bot Builder Panel — HTML (list, create form, run monitor)
 *
 * Renders the bot list (pi_bot_defs), the Create an agent form,
 * and the Run monitor (bot_sessions — live, 5s Turbo replace).
 * Mostly literal English (operator-facing labels and data-status values);
 * new user-facing copy (providers link) is i18n-keyed. The run-monitor
 * tbody is VOLATILE-SKIP (replaced every 5s by routes/streams.js, spec rule 5).
 */

import { escapeHtml, section, formField, actionBar, docsUrl } from "../../shared/components.js";
import { csrfInput } from "../../shared/csrf.js";
import { loadModelOptions } from "./data-queries.js";
import { t, fill, SUPPORTED_LANGS } from "../../shared/i18n.js";
import { parseCookies } from "../../auth.js";
import { listProvidersAll } from "../../../../shared/providers-db.js";
import { boardState, friendlyModel, purposeLine, agoText } from "../../shared/bot-display.js";
import { perchAttached } from "../../../shared/perch-attached.js";
import { rowMenuScript } from "./row-menu.js";

// Same crow_lang-cookie resolution the dashboard router uses (index.js);
// defensive because tests render with header-less reqs.
function reqLang(req) {
  try {
    const c = parseCookies(req).crow_lang;
    return SUPPORTED_LANGS.includes(c) ? c : "en";
  } catch { return "en"; }
}

// A deterministic hue per bot id, so an avatar keeps its colour across renders.
function hueOf(id) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 5;
}

/**
 * One bot as a row (option A): avatar, name (id on hover), status dot, an
 * optional purpose line, a meta line (friendly model with the raw key on
 * hover, updated N ago, a No board chip), then Chat / Edit / ⋯. The ⋯ menu
 * opens inline under the row and carries every other action the old table
 * offered. Empty fields are left out, never dashed.
 */
function botRowHtml(bt, { i, lang, req, now, providerRows, active }) {
  let def = {};
  try { def = JSON.parse(bt.definition || "{}") || {}; } catch { def = {}; }
  const id = String(bt.bot_id);
  const enc = encodeURIComponent(id);
  const name = bt.display_name || id;
  const board = boardState(bt);
  const modelKey = (def.models && def.models.default) || "";
  const model = friendlyModel(modelKey, providerRows);
  const purpose = purposeLine(def, lang, board.state === "on");
  const ago = agoText(bt.updated_at, now, lang);
  const dot = !bt.enabled ? ["off", t("botbuilder.dotOff", lang)]
    : active ? ["active", t("botbuilder.dotActive", lang)] : ["on", t("botbuilder.dotOn", lang)];
  const editHref = `/dashboard/bot-builder?bot=${enc}&tab=ai`;
  const menuId = `btb-menu-${i}`;
  const meta = [
    model ? `<span title="${escapeHtml(modelKey)}">${escapeHtml(model)}</span>` : "",
    ago ? `<span>${escapeHtml(ago)}</span>` : "",
    board.state === "off" ? `<span class="btb-nob">${t("botbuilder.rowNoBoard", lang)}</span>` : "",
  ].filter(Boolean).join("");
  let boardItem;
  if (board.state === "on" || board.state === "custom") {
    boardItem = `<a role="menuitem" tabindex="-1" href="/dashboard/bot-board?bot=${enc}">${t("botbuilder.rowOpenBoard", lang)}</a>`;
  } else if (board.reason === "no_slug") {
    boardItem = `<a role="menuitem" tabindex="-1" href="/dashboard/bot-builder?bot=${enc}&tab=tracker">${t("botbuilder.rowSetUpInEdit", lang)}</a>`;
  } else {
    boardItem = `<form method="POST" action="/dashboard/bot-builder" class="btb-menu-form">` +
      `<input type="hidden" name="action" value="board_on"><input type="hidden" name="bot_id" value="${escapeHtml(id)}">` +
      `<input type="hidden" name="return" value="list">${csrfInput(req)}` +
      `<button type="submit" role="menuitem" tabindex="-1">${t("botbuilder.rowTurnOn", lang)}` +
      `<span class="btb-mhint">${t("botbuilder.boardOnWarn", lang)}</span></button></form>`;
  }
  const menu = `<div class="btb-menu" id="${menuId}" role="menu" hidden>` + boardItem +
    `<a role="menuitem" tabindex="-1" href="/dashboard/bot-board?bot=${enc}">${t("botbuilder.rowGiveTask", lang)}</a>` +
    `<a role="menuitem" tabindex="-1" href="/dashboard/perch">${t("botbuilder.rowSessions", lang)}</a>` +
    (bt.project_id != null ? `<a role="menuitem" tabindex="-1" href="/dashboard/projects?view=${encodeURIComponent(String(bt.project_id))}">${t("botbuilder.rowProject", lang)}</a>` : "") +
    `<a role="menuitem" tabindex="-1" class="btb-danger-link" href="/dashboard/bot-builder?bot=${enc}&confirm_delete=1">${t("botbuilder.rowDelete", lang)}</a>` +
    `</div>`;
  return `<div class="btb-row" role="listitem" data-bot="${escapeHtml(id)}">` +
    `<span class="btb-av btb-hue-${hueOf(id)}" aria-hidden="true">${escapeHtml(Array.from(name.trim())[0] || "?").toUpperCase()}</span>` +
    `<div class="btb-row-main">` +
    `<div class="btb-row-name"><span title="${escapeHtml(id)}">${escapeHtml(name)}</span>` +
    `<span class="btb-dot btb-dot-${dot[0]}" role="img" aria-label="${escapeHtml(dot[1])}" title="${escapeHtml(dot[1])}"></span></div>` +
    (purpose ? `<div class="btb-row-purpose">${escapeHtml(purpose)}</div>` : "") +
    (meta ? `<div class="btb-row-meta">${meta}</div>` : "") +
    `</div>` +
    `<div class="btb-row-acts">` +
    (perchAttached(def) ? `<a class="btn btn-primary btn-sm" href="/dashboard/perch?bot=${enc}">${t("perch.tabChat", lang)}</a>` : "") +
    `<a class="btn btn-secondary btn-sm" href="${editHref}">${t("botbuilder.rowEdit", lang)}</a>` +
    `<button type="button" class="btb-more" aria-haspopup="menu" aria-expanded="false" aria-controls="${menuId}" ` +
    `aria-label="${escapeHtml(fill(t("botbuilder.rowMore", lang), { name }))}">&#x22ef;</button>` +
    `</div>` + menu + `</div>`;
}

export async function renderBotList(res, { db, layout, notice, PAGE_CSS, req }) {
  const lang = reqLang(req);
  let bots = [], sessions = [], sessRows = [];
  try {
    bots = (await db.execute({ sql: "SELECT bot_id, display_name, enabled, definition, project_id, datetime(updated_at) AS updated_at FROM pi_bot_defs ORDER BY bot_id", args: [] })).rows;
    sessions = (await db.execute({ sql: "SELECT bot_id, status, count(*) AS n FROM bot_sessions GROUP BY bot_id, status", args: [] })).rows;
    sessRows = (await db.execute({ sql: "SELECT id, bot_id, status, model, escalated, control, card_id, gateway_thread_id, datetime(updated_at) AS updated_at FROM bot_sessions ORDER BY updated_at DESC LIMIT 50", args: [] })).rows;
  } catch { /* defensive */ }
  let providerRows = [];
  try { providerRows = await listProvidersAll(db); } catch { providerRows = []; }
  const now = Date.now();
  const activeIds = new Set(sessions.filter((s) => s.status === "active" && Number(s.n) > 0).map((s) => s.bot_id));
  const rows = bots.map((bt, i) => botRowHtml(bt, { i, lang, req, now, providerRows, active: activeIds.has(bt.bot_id) }));
  // Item 5 PR1 (spec §D1): the guided wizard is the primary creation path.
  // Option A rows: once bots exist, the tutorial shrinks to a small Guide
  // link beside "+ New bot"; with none, the empty state keeps its wording.
  const tutorialHref = docsUrl((lang === "es" ? "es/" : "") + "guide/bot-builder-tutorial");
  const wizCta = rows.length
    ? `<div class="btb-toolbar"><a class="btn btn-primary btn-sm" href="/dashboard/bot-builder?new=1">${t("botbuilder.rowNewBot", lang)}</a>` +
      `<a class="btb-guide-link" href="${escapeHtml(tutorialHref)}" target="_blank" rel="noopener">${t("botbuilder.rowGuide", lang)}</a></div>`
    : `<p style="margin:0 0 1rem"><a class="btn btn-primary btn-md" href="/dashboard/bot-builder?new=1">${t("botbuilder.wizCta", lang)}</a> ` +
      `<a class="btb-hint" style="margin-left:.75rem" href="${escapeHtml(tutorialHref)}" target="_blank" rel="noopener">${t("botbuilder.tutorialLink", lang)}</a></p>`;
  const list = section(t("botbuilder.listTitle", lang),
    notice + wizCta + (rows.length
      ? `<div class="btb-rows" role="list">${rows.join("")}</div>` + rowMenuScript()
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
  const form = section(t("botbuilder.quickCreateTitle", lang),
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
    `<p class="btb-hint">${t("botbuilder.hintQuickCreate", lang)}</p>` +
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
    : `<tr><td colspan="9" class="btb-muted" style="padding:.5rem">${t("botbuilder.monitorEmpty", lang)}</td></tr>`;
  const monitor = section(t("botbuilder.monitorTitle", lang),
    `<turbo-stream-source src="/dashboard/streams/bot-sessions"></turbo-stream-source>` +
    `<div class="table-scroll"><table class="btb-monitor"><thead><tr>` +
    `<th>${t("botbuilder.monThId", lang)}</th><th>${t("botbuilder.monThBot", lang)}</th><th>${t("botbuilder.monThStatus", lang)}</th>` +
    `<th>${t("botbuilder.monThModel", lang)}</th><th>${t("botbuilder.monThEsc", lang)}</th>` +
    `<th>${t("botbuilder.monThControl", lang)}</th><th>${t("botbuilder.monThCard", lang)}</th><th>${t("botbuilder.monThThread", lang)}</th>` +
    `<th>${t("botbuilder.monThUpdated", lang)}</th></tr></thead>` +
    `<tbody id="pibot-sessions-tbody">${monRows}</tbody></table></div>`);
  return res.send(layout({ title: "Bot Builder", content: PAGE_CSS + list + monitor + form }));
}
