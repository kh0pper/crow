/**
 * Bot Board Panel — HTML Render Functions
 *
 * Pure render functions (return layout() strings; req/res params are accepted
 * but unused — signatures kept frozen per spec). Card faces, kanban board,
 * custom tracker, and drawer markup.
 */

import { escapeHtml, section, badge } from "../../shared/components.js";
import { t, tJs } from "../../shared/i18n.js";
import { createDbClient } from "../../../../db.js";
import { botBoardStyles } from "./css.js";
import { clientJs } from "./client.js";
import {
  TASKS_DB, STATUS_BADGE,
  lockMapFor, derivePlanPath, readPlan, statusLabel,
} from "./data-queries.js";
import { DEFAULT_BOARD_DEF, resolveBoardDef, resolveSlugBoardDef } from "../../../routes/board-defs.js";

// Display: configured values render raw (tracker-style); only the builtin
// fallback def keeps the i18n'd four.
function defStatusLabel(def, s, lang) {
  return def.builtin ? statusLabel(s, lang) : String(s);
}

// The card face's meta row for a board's declared fields. `column`-backed
// fields read the typed column; `data` fields read data_json.
function declaredFieldMeta(def, card, data) {
  const parts = [];
  for (const f of def.fields || []) {
    const v = f.storage === "column" ? card[f.key] : (data ? data[f.key] : undefined);
    if (v != null && v !== "") {
      parts.push(`<span class="bb-meta">${escapeHtml(String(f.label || f.key))}: ${escapeHtml(String(v))}</span>`);
    }
  }
  return parts.join("");
}

export function cardFaceHtml(card, locked, lang, def = DEFAULT_BOARD_DEF) {
  const prio = card.priority == null ? "" :
    `<span class="bb-prio bb-prio-${escapeHtml(String(card.priority))}" title="${t("botboard.titlePriorityPrefix", lang)} ${escapeHtml(String(card.priority))}">P${escapeHtml(String(card.priority))}</span>`;
  const due = card.due_date ? `<span class="bb-meta">⏱ ${escapeHtml(String(card.due_date))}</span>` : "";
  const owner = card.owner ? `<span class="bb-meta">👤 ${escapeHtml(String(card.owner))}</span>` : "";
  const tags = card.tags
    ? `<div class="bb-tags">${String(card.tags).split(",").map((s) => s.trim()).filter(Boolean)
        .map((tg) => `<span class="bb-tag">${escapeHtml(tg)}</span>`).join("")}</div>`
    : "";
  const sub = card.parent_id != null
    ? `<div class="bb-sub">↳ subtask of #${escapeHtml(String(card.parent_id))}</div>` : "";
  const lockBadge = locked
    ? `<span class="bb-lock" title="${t("botboard.cardWorking", lang)}">${t("botboard.cardWorkingBadge", lang)}</span>` : "";
  // D-T1.6: an archived card only ever reaches this face when the "Show
  // archived" toggle is on (the default query hides it) — flag it visually
  // and let the drawer offer Unarchive instead of Archive.
  const archived = card.archived_at != null;
  const archivedBadge = archived
    ? `<span class="bb-archived-flag" title="${t("board.archivedView", lang)}">${t("board.archive", lang)}</span>` : "";
  let data = {};
  try { data = JSON.parse(card.data_json || "{}"); } catch { data = {}; }
  const fieldMeta = declaredFieldMeta(def, card, data);
  // Search text mirrors the tracker face: everything a human would scan for.
  const searchParts = [card.title || "", card.status || "", card.owner || "", card.tags || "", card.due_date || ""];
  for (const f of def.fields || []) {
    const v = f.storage === "column" ? card[f.key] : data[f.key];
    if (v != null && v !== "") searchParts.push(String(v));
  }
  const searchText = searchParts.join(" ").toLowerCase();
  return `<div class="bb-card${locked ? " bb-locked" : ""}${archived ? " bb-archived" : ""}" draggable="${locked || archived ? "false" : "true"}" ` +
    `data-card="${escapeHtml(String(card.id))}" data-status="${escapeHtml(String(card.status))}" ` +
    `data-locked="${locked ? "1" : "0"}" data-archived="${archived ? "1" : "0"}" data-search-text="${escapeHtml(searchText)}" ` +
    `data-priority="${card.priority != null ? escapeHtml(String(card.priority)) : ""}" ` +
    `tabindex="0" role="button" ` +
    `aria-label="card ${escapeHtml(String(card.id))}: ${escapeHtml(String(card.title || ""))}">` +
    `<div class="bb-card-top">${prio}<span class="bb-id">#${escapeHtml(String(card.id))}</span>${lockBadge}${archivedBadge}</div>` +
    `<div class="bb-title">${escapeHtml(String(card.title || "(untitled)"))}</div>` +
    `<div class="bb-card-meta">${due}${owner}${fieldMeta}</div>${tags}${sub}` +
    `<form method="POST" action="/dashboard/bot-board" class="bb-nojs-move">` +
    `<input type="hidden" name="action" value="move">` +
    `<input type="hidden" name="card_id" value="${escapeHtml(String(card.id))}">` +
    `<input type="hidden" name="project" value="${escapeHtml(String(card.project_id == null ? "" : card.project_id))}">` +
    def.status_values.filter((s) => s !== card.status).map((s) =>
      `<button type="submit" name="status" value="${escapeHtml(s)}" ${locked || archived ? "disabled" : ""} ` +
      `title="${t("botboard.moveTo", lang)}${escapeHtml(defStatusLabel(def, s, lang))}">${escapeHtml(defStatusLabel(def, s, lang))}</button>`).join("") +
    `</form></div>`;
}

export function trackerCardFaceHtml(item, contextFields, statusValues, locked, lang) {
  const prio = item.priority == null ? "" :
    `<span class="bb-prio bb-prio-${escapeHtml(String(item.priority))}" title="${t("botboard.titlePriorityPrefix", lang)} ${escapeHtml(String(item.priority))}">P${escapeHtml(String(item.priority))}</span>`;
  const lockBadge = locked
    ? `<span class="bb-lock" title="${t("botboard.itemProcessing", lang)}">${t("botboard.itemProcessingBadge", lang)}</span>` : "";
  const archived = item.archived_at != null;
  const archivedBadge = archived
    ? `<span class="bb-archived-flag" title="${t("board.archivedView", lang)}">${t("board.archive", lang)}</span>` : "";

  // Extract metadata from data_json for context fields (skip "label" and "status")
  let data = {};
  try { data = JSON.parse(item.data_json || "{}"); } catch { data = {}; }
  const searchParts = [item.label || "", item.status || ""];
  for (const v of Object.values(data)) {
    if (v != null && v !== "") searchParts.push(typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  if (item.action_needed) searchParts.push(String(item.action_needed));
  const searchText = searchParts.join(" ").toLowerCase();
  const metaParts = [];
  for (const cf of contextFields) {
    const key = typeof cf === "string" ? cf : (cf.key || cf.name || "");
    if (!key || key === "label" || key === "status") continue;
    const val = data[key];
    if (val != null && val !== "") {
      const displayKey = typeof cf === "object" && cf.label ? cf.label : key;
      metaParts.push(`<span class="bb-meta">${escapeHtml(String(displayKey))}: ${escapeHtml(String(val))}</span>`);
    }
  }
  const metaHtml = metaParts.length
    ? `<div class="bb-card-meta">${metaParts.join("")}</div>` : "";

  const actionHtml = item.action_needed
    ? `<div class="bb-sub" style="color:#b8860b">⚠ ${escapeHtml(String(item.action_needed))}</div>` : "";

  // No-JS move buttons using dynamic statusValues
  const moveButtons = statusValues.filter((s) => s !== item.status).map((s) =>
    `<button type="submit" name="status" value="${escapeHtml(s)}" ${locked || archived ? "disabled" : ""} ` +
    `title="${t("botboard.moveTo", lang)}${escapeHtml(s)}">${escapeHtml(s)}</button>`).join("");

  return `<div class="bb-card${locked ? " bb-locked" : ""}${archived ? " bb-archived" : ""}" draggable="${locked || archived ? "false" : "true"}" ` +
    `data-card="${escapeHtml(String(item.id))}" data-status="${escapeHtml(String(item.status))}" ` +
    `data-locked="${locked ? "1" : "0"}" data-archived="${archived ? "1" : "0"}" data-item-type="tracker" ` +
    `data-search-text="${escapeHtml(searchText)}" data-action-needed="${item.action_needed ? "1" : "0"}" ` +
    `data-priority="${item.priority != null ? escapeHtml(String(item.priority)) : ""}" ` +
    `data-json="${escapeHtml(item.data_json || "{}")}" ` +
    `tabindex="0" role="button" ` +
    `aria-label="item ${escapeHtml(String(item.id))}: ${escapeHtml(String(item.label || ""))}">` +
    `<div class="bb-card-top">${prio}<span class="bb-id">#${escapeHtml(String(item.id))}</span>${lockBadge}${archivedBadge}</div>` +
    `<div class="bb-title">${escapeHtml(String(item.label || "(untitled)"))}</div>` +
    metaHtml + actionHtml +
    `<form method="POST" action="/dashboard/bot-board" class="bb-nojs-move">` +
    `<input type="hidden" name="action" value="tracker_move">` +
    `<input type="hidden" name="item_id" value="${escapeHtml(String(item.id))}">` +
    `<input type="hidden" name="bot" value="${escapeHtml(String(item.bot_id || ""))}">` +
    moveButtons +
    `</form></div>`;
}

// Right slide-over drawer (design D6) — populated client-side on card click;
// the board stays visible + live behind it. Pure static markup (no dynamic
// data interpolated here); no-JS users never see it (they get &card=M).
export function drawerMarkup(lang, def = DEFAULT_BOARD_DEF) {
  return `<div class="bb-drawer" id="bb-drawer" aria-hidden="true">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h3 id="bb-d-title" style="font-family:'Fraunces',serif;margin:0">${t("botboard.drawerCardTitle", lang)}</h3>
      <button type="button" class="bb-btn bb-sec" id="bb-d-close" aria-label="${tJs("common.close", lang)}">✕ ${t("common.close", lang)}</button>
    </div>
    <div class="bb-msg" id="bb-d-msg"></div>
    <div id="bb-d-lock" class="bb-msg warn"></div>
    <label>${t("botboard.labelTitle", lang)}</label><input id="bb-d-title-in" type="text">
    <div class="bb-row">
      <div><label>${t("botboard.labelStatus", lang)}</label><select id="bb-d-status">${def.status_values.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(defStatusLabel(def, s, lang))}</option>`).join("")}</select></div>
      <div><label>${t("botboard.labelPriority", lang)}</label><select id="bb-d-prio"><option value="">—</option>${[1, 2, 3, 4, 5].map((n) => `<option value="${n}">${n}</option>`).join("")}</select></div>
    </div>
    <div class="bb-row">
      <div><label>${t("botboard.labelDueDate", lang)}</label><input id="bb-d-due" type="text" placeholder="YYYY-MM-DD"></div>
      <div><label>${t("botboard.labelOwner", lang)}</label><input id="bb-d-owner" type="text"></div>
    </div>
    <label>${t("botboard.labelTags", lang)}</label><input id="bb-d-tags" type="text">
    <label>${t("botboard.labelDescription", lang)}</label><textarea id="bb-d-desc" rows="3" style="font-family:inherit"></textarea>
    <label>${t("botboard.labelProject", lang)}</label><select id="bb-d-project"></select>
    <div>
      <button type="button" class="bb-btn" id="bb-d-save">${t("botboard.btnSaveCard", lang)}</button>
      <button type="button" class="bb-btn bb-sec" id="bb-d-cancel">${t("botboard.btnCancelCard", lang)}</button>
      <button type="button" class="bb-btn bb-sec" id="bb-d-unlock" style="display:none">${t("botboard.btnForceUnlock", lang)}</button>
      <button type="button" class="bb-btn bb-sec" id="bb-d-archive" style="display:none">${t("board.archive", lang)}</button>
      <button type="button" class="bb-btn bb-sec" id="bb-d-unarchive" style="display:none">${t("board.unarchive", lang)}</button>
    </div>
    <h4 style="margin-top:1rem;display:flex;justify-content:space-between;align-items:center">
      <span>${t("botboard.planFileHeading", lang)}</span>
      <button type="button" class="bb-btn bb-sec" id="bb-d-plan-toggle" style="margin:0">${t("botboard.btnPreview", lang)}</button>
    </h4>
    <div id="bb-d-plan-msg" class="bb-msg"></div>
    <textarea id="bb-d-plan" rows="14" placeholder="${t("botboard.planFilePlaceholder", lang)}"></textarea>
    <div class="bb-pre" id="bb-d-plan-pre" style="display:none"></div>
    <button type="button" class="bb-btn" id="bb-d-plan-save">${t("botboard.btnSavePlan", lang)}</button>
  </div>
  <div class="bb-drawer" id="bb-newproj" aria-hidden="true">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h3 style="font-family:'Fraunces',serif;margin:0">${t("botboard.drawerNewProject", lang)}</h3>
      <button type="button" class="bb-btn bb-sec" id="bb-np-close" aria-label="${tJs("common.close", lang)}">✕ ${t("common.close", lang)}</button>
    </div>
    <div class="bb-msg" id="bb-np-msg"></div>
    <label>${t("botboard.labelName", lang)}</label><input id="bb-np-name" type="text">
    <label>${t("botboard.labelDescription", lang)}</label><textarea id="bb-np-desc" rows="3" style="font-family:inherit"></textarea>
    <button type="button" class="bb-btn" id="bb-np-save">${t("botboard.btnCreateProject", lang)}</button>
  </div>
  <div class="bb-drawer" id="bb-newcard" aria-hidden="true">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h3 style="font-family:'Fraunces',serif;margin:0">${t("botboard.drawerNewCard", lang)}</h3>
      <button type="button" class="bb-btn bb-sec" id="bb-nc-close" aria-label="${tJs("common.close", lang)}">✕ ${t("common.close", lang)}</button>
    </div>
    <div class="bb-msg" id="bb-nc-msg"></div>
    <p style="font-size:.8rem;color:var(--crow-text-muted)">${t("botboard.newCardHelp", lang)}</p>
    <label>${t("botboard.labelTitle", lang)}</label><input id="bb-nc-title" type="text">
    <label>${t("botboard.labelDescription", lang)}</label><textarea id="bb-nc-desc" rows="3" style="font-family:inherit"></textarea>
    <div class="bb-row">
      <div><label>${t("botboard.labelDueDate", lang)}</label><input id="bb-nc-due" type="text" placeholder="YYYY-MM-DD"></div>
      <div><label>${t("botboard.labelOwner", lang)}</label><input id="bb-nc-owner" type="text"></div>
    </div>
    <label>${t("botboard.labelTags", lang)}</label><input id="bb-nc-tags" type="text">
    <button type="button" class="bb-btn" id="bb-nc-save">${t("botboard.btnCreateCard", lang)}</button>
  </div>
  <div class="bb-drawer" id="bb-bulk" aria-hidden="true">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h3 style="font-family:'Fraunces',serif;margin:0">${t("botboard.drawerBulkTitle", lang)}</h3>
      <button type="button" class="bb-btn bb-sec" id="bb-bk-close" aria-label="${tJs("common.close", lang)}">✕ ${t("common.close", lang)}</button>
    </div>
    <div class="bb-msg" id="bb-bk-msg"></div>
    <p style="font-size:.82rem;color:var(--crow-text-muted)">${t("botboard.bulkHelp", lang)}</p>
    <div id="bb-bk-list" style="max-height:60vh;overflow:auto"></div>
    <button type="button" class="bb-btn" id="bb-bk-save">${t("botboard.btnAssign", lang)}</button>
  </div>`;
}

// Board settings drawer (Track 0) — statuses / terminals / declared fields.
// Hydrated client-side from GET /board-def; saved via POST /board-def.
export function boardSettingsDrawerMarkup(lang, projectId) {
  return `<div class="bb-drawer" id="bb-cfg" aria-hidden="true" data-project="${escapeHtml(String(projectId == null ? "" : projectId))}">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h3 style="font-family:'Fraunces',serif;margin:0">${t("botboard.cfgTitle", lang)}</h3>
      <button type="button" class="bb-btn bb-sec" id="bb-cfg-close" aria-label="${tJs("common.close", lang)}">✕ ${t("common.close", lang)}</button>
    </div>
    <div class="bb-msg" id="bb-cfg-msg"></div>
    <label>${t("botboard.cfgDisplayName", lang)}</label><input id="bb-cfg-name" type="text">
    <label>${t("botboard.cfgStatuses", lang)}</label>
    <textarea id="bb-cfg-statuses" rows="6" spellcheck="false"></textarea>
    <p style="font-size:.78rem;color:var(--crow-text-muted);margin:.2rem 0 .6rem">${t("botboard.cfgStatusesHelp", lang)}</p>
    <label>${t("botboard.cfgTerminals", lang)}</label>
    <div id="bb-cfg-terminals" style="display:flex;flex-wrap:wrap;gap:.5rem;margin:.3rem 0 .6rem"></div>
    <label>${t("botboard.cfgFields", lang)}</label>
    <div id="bb-cfg-fields"></div>
    <button type="button" class="bb-btn bb-sec" id="bb-cfg-addfield">${t("botboard.cfgAddField", lang)}</button>
    <div style="margin-top:.8rem">
      <button type="button" class="bb-btn" id="bb-cfg-save">${t("botboard.cfgSave", lang)}</button>
    </div>
  </div>`;
}

// Tracker item drawer — for custom tracker bots
export function trackerDrawerMarkup(lang) {
  return `<div class="bb-drawer" id="bb-tracker-drawer" aria-hidden="true">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h3 id="bb-td-title" style="font-family:'Fraunces',serif;margin:0">${t("botboard.drawerTrackerItem", lang)}</h3>
      <button type="button" class="bb-btn bb-sec" id="bb-td-close" aria-label="${tJs("common.close", lang)}">✕ ${t("common.close", lang)}</button>
    </div>
    <div class="bb-msg" id="bb-td-msg"></div>
    <div id="bb-td-lock" class="bb-msg warn"></div>
    <label>${t("botboard.labelLabel", lang)}</label><input id="bb-td-label" type="text">
    <div class="bb-row">
      <div><label>${t("botboard.labelStatus", lang)}</label><select id="bb-td-status"></select></div>
      <div><label>${t("botboard.labelPriority", lang)}</label><select id="bb-td-prio"><option value="">—</option>${[1, 2, 3, 4, 5].map((n) => `<option value="${n}">${n}</option>`).join("")}</select></div>
    </div>
    <label>${t("botboard.labelActionNeeded", lang)}</label><input id="bb-td-action" type="text">
    <div id="bb-td-fields"></div>
    <div id="bb-td-lease" style="margin-top:.5rem;font-size:.78rem;color:var(--crow-text-muted)"></div>
    <div>
      <button type="button" class="bb-btn" id="bb-td-save">${t("botboard.btnSaveItem", lang)}</button>
      <button type="button" class="bb-btn bb-sec" id="bb-td-clear-lease" style="display:none">${t("botboard.btnForceClearLease", lang)}</button>
      <button type="button" class="bb-btn bb-sec" id="bb-td-archive" style="display:none">${t("board.archive", lang)}</button>
      <button type="button" class="bb-btn bb-sec" id="bb-td-unarchive" style="display:none">${t("board.unarchive", lang)}</button>
    </div>
  </div>
  <div class="bb-drawer" id="bb-new-tracker-item" aria-hidden="true">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h3 style="font-family:'Fraunces',serif;margin:0">${t("botboard.drawerNewTrackerItem", lang)}</h3>
      <button type="button" class="bb-btn bb-sec" id="bb-nti-close" aria-label="${tJs("common.close", lang)}">✕ ${t("common.close", lang)}</button>
    </div>
    <div class="bb-msg" id="bb-nti-msg"></div>
    <label>${t("botboard.labelLabelTitle", lang)}</label><input id="bb-nti-label" type="text">
    <div class="bb-row">
      <div><label>${t("botboard.labelStatus", lang)}</label><select id="bb-nti-status"></select></div>
      <div><label>${t("botboard.labelPriority", lang)}</label><select id="bb-nti-prio"><option value="3" selected>3</option>${[1, 2, 4, 5].map((n) => `<option value="${n}">${n}</option>`).join("")}</select></div>
    </div>
    <label>${t("botboard.labelActionNeeded", lang)}</label><input id="bb-nti-action" type="text">
    <div id="bb-nti-fields"></div>
    <button type="button" class="bb-btn" id="bb-nti-save">${t("botboard.btnCreateItem", lang)}</button>
  </div>`;
}

// D-T1.6: the "Show archived" filter-bar affordance, shared by both board
// types — a plain nav link (works no-JS too) round-tripping the SAME
// ?include_archived=1 convention the JSON API's list endpoints use. When
// active it also shows the "archived view" banner text.
function archivedToggleHtml(botId, includeArchived, lang) {
  const base = "/dashboard/bot-board?bot=" + encodeURIComponent(botId);
  if (includeArchived) {
    return `<span class="bb-msg" style="display:inline-flex;align-items:center;gap:.4rem;margin:0">` +
      `${escapeHtml(t("board.archivedView", lang))}` +
      `<a class="bb-btn bb-sec" href="${base}">${escapeHtml(t("botboard.backToBoard", lang))}</a></span>`;
  }
  return `<a class="bb-btn bb-sec" href="${base}&include_archived=1">${escapeHtml(t("board.showArchived", lang))}</a>`;
}

// ---- Kanban board rendering ----
export async function renderKanbanBoard(req, res, { db, layout, selBot, bots, notice, switcher, q, lang }) {
  const projectId = selBot.projectId != null ? Number(selBot.projectId) : null;
  // D-T1.6: the "Show archived" filter-bar toggle round-trips as
  // ?include_archived=1 — the SAME query/param convention the JSON API uses.
  // Default view excludes archived cards entirely; the toggle mixes them
  // back into their live column (visually flagged, drag disabled), which is
  // what lets the drawer's Unarchive button reach them.
  const includeArchived = q.include_archived === "1" || q.include_archived === "true";

  if (projectId == null) {
    return layout({
      title: `Bot Board — ${selBot.displayName}`,
      content: botBoardStyles() + section(
        `Board — ${escapeHtml(selBot.displayName)}`,
        notice + switcher +
        `<p style="margin-top:1rem;color:var(--crow-text-muted)">${t("botboard.noProjectLinked", lang)}</p>`) +
        drawerMarkup(lang) + clientJs(selBot.botId, "kanban", null, null, null, lang, false),
    });
  }

  // Cards for the selected project — tasks.db via the journal-safe client.
  // The resolved board def drives everything below: columns, labels, fields.
  let cards = [];
  let def = DEFAULT_BOARD_DEF;
  let tdb;
  try {
    tdb = createDbClient(TASKS_DB);
    def = await resolveBoardDef(tdb, { projectId });
    cards = (await tdb.execute({
      sql: `SELECT * FROM tasks_items WHERE project_id=?${includeArchived ? "" : " AND archived_at IS NULL"} ORDER BY priority ASC, id ASC`,
      args: [projectId],
    })).rows || [];
  } catch {
    cards = [];
  } finally {
    if (tdb) { try { tdb.close(); } catch { /* already closed */ } }
  }

  const lockMap = await lockMapFor(db, cards.map((c) => Number(c.id)));

  // ---- no-JS dedicated card view (&card=M) ----
  if (q.card != null && q.card !== "") {
    const cid = Number(q.card);
    const card = cards.find((c) => Number(c.id) === cid);
    if (!card) {
      return layout({
        title: "Bot Board",
        content: botBoardStyles() + section(t("botboard.cardNotFound", lang),
          `<p>#${escapeHtml(String(q.card))} is not in this bot's project.</p>` +
          `<p><a href="/dashboard/bot-board?bot=${escapeHtml(selBot.botId)}">${t("botboard.backToBoard", lang)}</a></p>`),
      });
    }
    const locked = !!lockMap.get(cid);
    const planInfo = await derivePlanPath(db, card);
    const plan = readPlan(planInfo);
    const fieldRow = (lbl, val) =>
      `<tr><td style="padding:3px 14px 3px 0;opacity:.7">${escapeHtml(lbl)}</td><td>${escapeHtml(String(val == null ? "—" : val))}</td></tr>`;
    const planBlock = !planInfo
      ? `<p class="bb-msg warn">${t("botboard.planNoBot", lang)}</p>`
      : `<p style="font-size:.8rem;color:var(--crow-text-muted)">${escapeHtml(planInfo.path)}</p>` +
        `<div class="bb-pre">${escapeHtml(plan.text || t("botboard.planFilePlaceholder", lang))}</div>` +
        (locked
          ? `<p class="bb-msg warn">${t("botboard.planLocked", lang)}</p>`
          : `<p class="bb-msg">${t("botboard.planJsHint", lang)}</p>`);
    const moveForm =
      `<form method="POST" action="/dashboard/bot-board" style="margin:.6rem 0">` +
      `<input type="hidden" name="action" value="move">` +
      `<input type="hidden" name="card_id" value="${cid}">` +
      `<input type="hidden" name="bot" value="${escapeHtml(selBot.botId)}">` +
      t("botboard.moveLabel", lang) + def.status_values.filter((s) => s !== card.status).map((s) =>
        `<button type="submit" name="status" value="${escapeHtml(s)}" class="bb-btn bb-sec" ${locked ? "disabled" : ""}>${escapeHtml(defStatusLabel(def, s, lang))}</button>`).join(" ") +
      `</form>`;
    return layout({
      title: `Card #${cid}`,
      content: botBoardStyles() + section(
        `Card #${cid} — ${escapeHtml(String(card.title || ""))} ${badge(card.status, STATUS_BADGE[card.status] || "draft")}${locked ? " " + badge("bot working", "info") : ""}`,
        `<p><a href="/dashboard/bot-board?bot=${escapeHtml(selBot.botId)}">${t("botboard.backToBoard", lang)}</a></p>` +
        `<table style="font-size:.9rem;border-collapse:collapse">` +
        fieldRow(t("botboard.fieldPriority", lang), card.priority) + fieldRow(t("botboard.fieldDue", lang), card.due_date) +
        fieldRow(t("botboard.fieldOwner", lang), card.owner) + fieldRow(t("botboard.fieldTags", lang), card.tags) +
        fieldRow(t("botboard.fieldParent", lang), card.parent_id) + fieldRow(t("botboard.fieldUpdated", lang), card.updated_at) +
        `</table>` +
        (card.description ? `<p style="margin-top:.6rem">${escapeHtml(String(card.description))}</p>` : "") +
        moveForm + `<h4 style="margin-top:1rem">${t("botboard.planFileHeading", lang)}</h4>` + planBlock),
    });
  }

  // ---- full kanban board (def-driven: columns, count, labels) ----
  const byStatus = {};
  for (const sv of def.status_values) byStatus[sv] = [];
  for (const c of cards) (byStatus[c.status] || (byStatus[c.status] = [])).push(c);
  // A card is NEVER hidden by configuration: statuses present in the data but
  // absent from the def (the stdio door and the bridge still write legacy
  // values, and the CHECK that used to stop them is gone) render as extra
  // columns after the configured ones — also what makes the /board-def
  // no-orphan refusal actionable, since the named cards are visible to move.
  const columnOrder = [
    ...def.status_values,
    ...Object.keys(byStatus).filter((s) => !def.status_values.includes(s) && byStatus[s].length),
  ];
  const columns = columnOrder.map((st) => {
    const list = byStatus[st] || [];
    const cardsHtml = list.length
      ? list.map((c) => cardFaceHtml(c, !!lockMap.get(Number(c.id)), lang, def)).join("")
      : `<div style="color:var(--crow-text-muted);font-size:.78rem;padding:.4rem">—</div>`;
    return `<div class="bb-col" data-col="${escapeHtml(st)}">` +
      `<h4><span>${escapeHtml(defStatusLabel(def, st, lang))}</span><span>${list.length}</span>` +
      `<button type="button" class="bb-col-toggle" title="${t("botboard.collapseColumn", lang)}" aria-label="${t("botboard.collapseColumnAria", lang).replace("{col}", escapeHtml(st))}">−</button></h4>` +
      `<div class="bb-col-body" data-col-body="${escapeHtml(st)}">${cardsHtml}</div></div>`;
  }).join("");

  const boardHtml = `<div class="bb-board" id="bb-board" data-statuses="${escapeHtml(JSON.stringify(def.status_values))}" style="--bb-cols:${columnOrder.length || 1}">${columns}</div>` +
    `<div id="bb-list-wrap" style="display:none"></div>`;

  // The tracker path's affordances, adopted (Track 0): search, status chips,
  // list toggle. Same markup, same client wiring.
  const filterBarHtml =
    `<div class="bb-filter-bar">` +
    `<input type="text" id="bb-search" class="bb-search" placeholder="${t("botboard.searchCards", lang)}">` +
    `<div class="bb-chips">` +
    def.status_values.map((sv) => `<button type="button" class="bb-chip" data-status-filter="${escapeHtml(sv)}">${escapeHtml(defStatusLabel(def, sv, lang))}</button>`).join("") +
    `</div>` +
    `<div class="bb-view-toggle">` +
    `<button type="button" class="bb-view-btn bb-view-btn-active" data-view="columns">${t("botboard.viewColumns", lang)}</button>` +
    `<button type="button" class="bb-view-btn" data-view="list">${t("botboard.viewList", lang)}</button>` +
    `</div>` +
    `<button type="button" class="bb-btn bb-sec" id="bb-cfg-open">⚙ ${t("botboard.cfgOpenBtn", lang)}</button>` +
    archivedToggleHtml(selBot.botId, includeArchived, lang) +
    `</div>`;

  const content = botBoardStyles() + section(
    `Board — ${escapeHtml(selBot.displayName)}`,
    notice + switcher + filterBarHtml + boardHtml) +
    drawerMarkup(lang, def) + boardSettingsDrawerMarkup(lang, projectId) +
    clientJs(selBot.botId, "kanban", projectId, null, null, lang, includeArchived);

  return layout({ title: `Bot Board — ${selBot.displayName}`, content });
}

// ---- Custom tracker rendering ----
export async function renderCustomTracker(req, res, { db, layout, selBot, bots, notice, switcher, q, lang }) {
  const includeArchived = q.include_archived === "1" || q.include_archived === "true";
  const trackerSlug = selBot.trackerSlug;
  if (!trackerSlug) {
    return layout({
      title: `Bot Board — ${selBot.displayName}`,
      content: botBoardStyles() + section(
        `Board — ${escapeHtml(selBot.displayName)}`,
        notice + switcher +
        `<p style="margin-top:1rem;color:var(--crow-text-muted)">${t("botboard.noTrackerSlug", lang)}</p>`),
    });
  }

  // Look up the slug board def — tasks.db's board_defs (Track 0 Phase B),
  // same store and resolver family the kanban path uses. A missing def has
  // no builtin fallback: null keeps the existing "tracker not found" branch.
  let trackerDef = null;
  let tdb;
  try {
    tdb = createDbClient(TASKS_DB);
    trackerDef = await resolveSlugBoardDef(tdb, trackerSlug);
  } catch { trackerDef = null; }

  if (!trackerDef) {
    if (tdb) { try { tdb.close(); } catch { /* already closed */ } }
    return layout({
      title: `Bot Board — ${selBot.displayName}`,
      content: botBoardStyles() + section(
        `Board — ${escapeHtml(selBot.displayName)}`,
        notice + switcher +
        `<p style="margin-top:1rem;color:var(--crow-text-muted)">${t("botboard.trackerNotFound", lang).replace("{slug}", escapeHtml(trackerSlug))}</p>`),
    });
  }

  const statusValues = trackerDef.status_values;

  // Use bot's tracker_config.context_fields for card face display (not all
  // fields); fall back to the def's own declared fields when the bot has
  // none configured.
  const botContextFields = (selBot.definition && selBot.definition.tracker_config && selBot.definition.tracker_config.context_fields) || [];
  const contextFields = botContextFields.length > 0 ? botContextFields : trackerDef.fields;

  // Query tasks_items for this board. The board is the unit of display:
  // items written by external feeds (e.g. a mirror sync) carry bot_id NULL,
  // and the live stream + bot-board-api already query by board alone —
  // filtering by bot here rendered those boards empty while the stream kept
  // reporting rows, which the client read as a permanent diff (reload loop).
  let items = [];
  try {
    items = (await tdb.execute({
      sql:
        "SELECT id, board_id, bot_id, status, priority, title AS label, data_json, action_needed, " +
        "next_followup_date, processing_lease, processing_lease_status, archived_at, " +
        "datetime(created_at) AS created_at, datetime(updated_at) AS updated_at " +
        "FROM tasks_items WHERE board_id=?" + (includeArchived ? "" : " AND archived_at IS NULL") +
        " ORDER BY priority ASC, id ASC",
      args: [trackerDef.id],
    })).rows || [];
  } catch { items = []; } finally {
    if (tdb) { try { tdb.close(); } catch { /* already closed */ } }
  }

  // Build columns from statusValues
  const byStatus = {};
  for (const sv of statusValues) byStatus[sv] = [];
  for (const item of items) {
    const st = item.status || "";
    if (!byStatus[st]) byStatus[st] = [];
    byStatus[st].push(item);
  }

  const colCount = statusValues.length || 1;

  const columnsHtml = statusValues.map((st) => {
    const list = byStatus[st] || [];
    const cardsHtml = list.length
      ? list.map((item) => {
          const locked = String(item.processing_lease_status) === "in-progress";
          return trackerCardFaceHtml(item, contextFields, statusValues, locked, lang);
        }).join("")
      : `<div style="color:var(--crow-text-muted);font-size:.78rem;padding:.4rem">—</div>`;
    return `<div class="bb-col" data-col="${escapeHtml(st)}">` +
      `<h4><span>${escapeHtml(st)}</span><span>${list.length}</span>` +
      `<button type="button" class="bb-col-toggle" title="${t("botboard.collapseColumn", lang)}" aria-label="${t("botboard.collapseColumnAria", lang).replace("{col}", escapeHtml(st))}">−</button></h4>` +
      `<div class="bb-col-body" data-col-body="${escapeHtml(st)}">${cardsHtml}</div></div>`;
  }).join("");

  const boardHtml = `<div class="bb-board" id="bb-board" style="--bb-cols:${colCount}">${columnsHtml}</div>` +
    `<div id="bb-list-wrap" style="display:none"></div>`;

  const filterBarHtml =
    `<div class="bb-filter-bar">` +
    `<input type="text" id="bb-search" class="bb-search" placeholder="Search items…">` +
    `<div class="bb-chips">` +
    statusValues.map((sv) => `<button type="button" class="bb-chip" data-status-filter="${escapeHtml(sv)}">${escapeHtml(sv)}</button>`).join("") +
    `<button type="button" class="bb-chip bb-chip-action" data-filter="action-needed">${t("botboard.filterActionNeeded", lang)}</button>` +
    `</div>` +
    `<div class="bb-view-toggle">` +
    `<button type="button" class="bb-view-btn bb-view-btn-active" data-view="columns">${t("botboard.viewColumns", lang)}</button>` +
    `<button type="button" class="bb-view-btn" data-view="list">${t("botboard.viewList", lang)}</button>` +
    `</div>` +
    archivedToggleHtml(selBot.botId, includeArchived, lang) +
    `</div>`;

  const content = botBoardStyles() + section(
    `Board — ${escapeHtml(selBot.displayName)} (${escapeHtml(trackerDef.display_name || trackerSlug)})`,
    notice + switcher + filterBarHtml + boardHtml) +
    trackerDrawerMarkup(lang) + drawerMarkup(lang) +
    clientJs(selBot.botId, "custom", null, trackerSlug, contextFields, lang, includeArchived);

  return layout({ title: `Bot Board — ${selBot.displayName}`, content });
}
