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
import { giveTaskScript } from "./give-task.js";
import { voiceAbilityScript } from "./voice-use.js";
import { voiceBotCardHtml } from "./voice-bot-card.js";
import { isVoiceBotId } from "../../../../shared/voice-bot.js";
import { loadUnassigned } from "../bot-board/data-queries.js";

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
 * One bot as a compact card (option B): a large initial avatar beside the
 * name (id on hover) + status dot and an optional purpose line; a meta line
 * (the friendly model as a chip with the raw key on hover, a No board chip,
 * updated N ago); then Chat / Edit / ⋯ along the bottom. The ⋯ menu is a
 * popover under the footer (inline on a phone) and carries every other
 * action the old table offered. Empty fields are left out, never dashed.
 */
function botCardHtml(bt, { i, lang, req, now, providerRows, active }) {
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
    model ? `<span class="btb-mchip" title="${escapeHtml(modelKey)}">${escapeHtml(model)}</span>` : "",
    board.state === "off" ? `<span class="btb-nob">${t("botbuilder.rowNoBoard", lang)}</span>` : "",
    ago ? `<span>${escapeHtml(ago)}</span>` : "",
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
  const menu = `<div class="btb-menu btb-pop" id="${menuId}" role="menu" hidden>` + boardItem +
    // A board-on bot gets the "Give <Name> a task" dialog (PR 2); any other
    // bot keeps the link to its board, where a board-off bot is offered
    // Turn on a board.
    (board.state === "on" && Number(bt.enabled)
      ? `<button type="button" role="menuitem" tabindex="-1" class="btb-give-task" data-bot-id="${escapeHtml(id)}" data-name="${escapeHtml(name)}" ` +
        `data-perch="${perchAttached(def) ? 1 : 0}" aria-haspopup="dialog" aria-controls="btb-give">${t("botbuilder.rowGiveTask", lang)}</button>`
      : `<a role="menuitem" tabindex="-1" href="/dashboard/bot-board?bot=${enc}">${t("botbuilder.rowGiveTask", lang)}</a>`) +
    `<a role="menuitem" tabindex="-1" href="/dashboard/perch">${t("botbuilder.rowSessions", lang)}</a>` +
    (bt.project_id != null ? `<a role="menuitem" tabindex="-1" href="/dashboard/projects?view=${encodeURIComponent(String(bt.project_id))}">${t("botbuilder.rowProject", lang)}</a>` : "") +
    `<a role="menuitem" tabindex="-1" class="btb-danger-link" href="/dashboard/bot-builder?bot=${enc}&confirm_delete=1">${t("botbuilder.rowDelete", lang)}</a>` +
    `</div>`;
  return `<div class="btb-botcard" role="listitem" data-bot="${escapeHtml(id)}">` +
    `<div class="btb-botcard-top"><span class="btb-av btb-av-l btb-hue-${hueOf(id)}" aria-hidden="true">${escapeHtml(Array.from(name.trim())[0] || "?").toUpperCase()}</span>` +
    `<div class="btb-botcard-tm">` +
    `<div class="btb-botcard-name"><span title="${escapeHtml(id)}">${escapeHtml(name)}</span>` +
    `<span class="btb-dot btb-dot-${dot[0]}" role="img" aria-label="${escapeHtml(dot[1])}" title="${escapeHtml(dot[1])}"></span></div>` +
    (purpose ? `<div class="btb-botcard-purpose">${escapeHtml(purpose)}</div>` : "") +
    `</div></div>` +
    (meta ? `<div class="btb-botcard-meta">${meta}</div>` : "") +
    `<div class="btb-botcard-foot">` +
    (perchAttached(def) ? `<a class="btn btn-primary btn-sm" href="/dashboard/perch?bot=${enc}">${t("perch.tabChat", lang)}</a>` : "") +
    `<a class="btn btn-secondary btn-sm" href="${editHref}">${t("botbuilder.rowEdit", lang)}</a>` +
    `<button type="button" class="btb-more" aria-haspopup="menu" aria-expanded="false" aria-controls="${menuId}" ` +
    `aria-label="${escapeHtml(fill(t("botbuilder.rowMore", lang), { name }))}">&#x22ef;</button>` +
    `</div>` + menu + `</div>`;
}

/**
 * "Give <Name> a task" (queue item 20, PR 2): one dialog per page, opened
 * from a board-on bot card's ⋯ menu (give-task.js fills in the bot). Write a
 * new task, or pick a waiting card from the Unassigned list; then "Add to
 * board for later" (the default — starting spins up a model) or "Start now".
 */
function giveTaskDialogHtml(waiting, lang) {
  const opts = waiting.map((c) => `<option value="${escapeHtml(String(c.id))}">${escapeHtml(String(c.title || ""))}</option>`).join("");
  return `<div class="btb-give" id="btb-give" role="dialog" aria-modal="true" aria-labelledby="btb-give-h" hidden>` +
    `<div class="btb-give-panel">` +
    `<p class="btb-give-h" id="btb-give-h"></p>` +
    `<label class="btb-give-l" for="btb-give-text">${t("botbuilder.giveTaskNew", lang)}</label>` +
    `<textarea id="btb-give-text" rows="3" maxlength="500" class="btb-give-text"></textarea>` +
    `<label class="btb-give-l" for="btb-give-card">${t("botbuilder.giveTaskOrPick", lang)}</label>` +
    `<select id="btb-give-card"><option value="">${t("botbuilder.giveTaskNone", lang)}</option>${opts}</select>` +
    `<fieldset class="btb-give-seg"><legend class="btb-sr">${t("botboard.giveWhen", lang)}</legend>` +
    `<label><input type="radio" name="btb-give-when" value="later" checked><span>${t("botboard.giveLater", lang)}</span></label>` +
    `<label><input type="radio" name="btb-give-when" value="now"><span>${t("botboard.giveNow", lang)}</span></label>` +
    `</fieldset>` +
    `<p class="btb-give-hint" id="btb-give-hint" hidden>${t("botboard.giveNowNeedsPerch", lang)}</p>` +
    `<div class="btb-give-actions">` +
    `<button type="button" class="btn btn-secondary btn-sm" data-give-close>${t("common.cancel", lang)}</button>` +
    `<button type="button" class="btn btn-primary btn-sm" id="btb-give-go">${t("botboard.giveTo", lang)}</button>` +
    `</div></div></div>`;
}

/**
 * kioskAvailable: decided on the server (dashboard/index.js, isCrowTalkAvailable
 * on the installed Kiosk panel + its routes) — without it Crow's card has no
 * abilities line and no listing is read.
 *
 * Crow's card (voice-bot-card.js) comes first; the ordinary cards skip the
 * voice row. Every voice surface answers as Crow, so no ordinary card says
 * where it answers voice or offers "Use for voice…".
 */
export async function renderBotList(res, { db, layout, notice, PAGE_CSS, req, kioskAvailable = false }) {
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
  const voiceRow = bots.find((bt) => isVoiceBotId(String(bt.bot_id))) || null;
  const ordinary = bots.filter((bt) => bt !== voiceRow);
  const cards = (voiceRow ? [voiceBotCardHtml(voiceRow, { lang, req, providerRows, kioskAvailable: !!kioskAvailable })] : [])
    .concat(ordinary.map((bt, i) => botCardHtml(bt, { i, lang, req, now, providerRows, active: activeIds.has(bt.bot_id) })));
  // The give dialog ships only when some bot can take a card. It sits
  // OUTSIDE the list section: the layout's .card animates a transform, which
  // would make it the containing block of the dialog's position:fixed.
  const giveDialog = ordinary.some((bt) => Number(bt.enabled) && boardState(bt).state === "on")
    ? giveTaskDialogHtml(await loadUnassigned(), lang) + giveTaskScript(lang)
    : "";
  // What Crow can do by voice: one Kiosk listing read fills the line on its card.
  const abilScript = kioskAvailable && voiceRow ? voiceAbilityScript(lang) : "";
  // Item 5 PR1 (spec §D1): the guided wizard is the primary creation path.
  // Option B: once bots exist, "+ New bot" sits in the toolbar and closes
  // the grid as a dashed tile, and the tutorial is one quiet line under the
  // grid; with none, the empty state keeps its wording (the hero).
  const tutorialHref = docsUrl((lang === "es" ? "es/" : "") + "guide/bot-builder-tutorial");
  const wizCta = cards.length
    ? `<div class="btb-toolbar"><a class="btn btn-primary btn-sm" href="/dashboard/bot-builder?new=1">${t("botbuilder.rowNewBot", lang)}</a></div>`
    : `<p style="margin:0 0 1rem"><a class="btn btn-primary btn-md" href="/dashboard/bot-builder?new=1">${t("botbuilder.wizCta", lang)}</a> ` +
      `<a class="btb-hint" style="margin-left:.75rem" href="${escapeHtml(tutorialHref)}" target="_blank" rel="noopener">${t("botbuilder.tutorialLink", lang)}</a></p>`;
  const newTile = `<div class="btb-botcard-new" role="listitem"><a class="btb-botcard-new-link" href="/dashboard/bot-builder?new=1">` +
    `<b>${t("botbuilder.rowNewBot", lang)}</b><span>${t("botbuilder.newTileHint", lang)}</span></a></div>`;
  const list = section(t("botbuilder.listTitle", lang),
    notice + wizCta + (cards.length
      ? `<div class="btb-cards" role="list">${cards.join("")}${newTile}</div>` +
        `<p class="btb-helpline"><a href="${escapeHtml(tutorialHref)}" target="_blank" rel="noopener">${t("botbuilder.tutorialLink", lang)}</a></p>` +
        rowMenuScript()
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
      `<a href="/dashboard/settings?section=models&amp;add=1">${t("botbuilder.createProvidersLink", lang)}</a></p>`
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
  return res.send(layout({ title: "Bot Builder", content: PAGE_CSS + list + giveDialog + abilScript + monitor + form }));
}
