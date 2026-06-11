/**
 * Bot Board Panel — HTML Render Functions
 *
 * Pure render functions (return layout() strings; req/res params are accepted
 * but unused — signatures kept frozen per spec). Card faces, kanban board,
 * custom tracker, and drawer markup.
 */

import { escapeHtml, section, badge } from "../../../shared/components.js";
import { tJs } from "../../../shared/i18n.js";
import { createDbClient } from "../../../../db.js";
import { botBoardStyles } from "./css.js";
import { clientJs } from "./client.js";
import {
  TASKS_DB, CARD_STATUSES, STATUS_LABEL, STATUS_BADGE,
  lockMapFor, derivePlanPath, readPlan,
} from "./data-queries.js";

export function cardFaceHtml(card, locked) {
  const prio = card.priority == null ? "" :
    `<span class="bb-prio bb-prio-${escapeHtml(String(card.priority))}" title="priority ${escapeHtml(String(card.priority))}">P${escapeHtml(String(card.priority))}</span>`;
  const due = card.due_date ? `<span class="bb-meta">⏱ ${escapeHtml(String(card.due_date))}</span>` : "";
  const owner = card.owner ? `<span class="bb-meta">👤 ${escapeHtml(String(card.owner))}</span>` : "";
  const tags = card.tags
    ? `<div class="bb-tags">${String(card.tags).split(",").map((s) => s.trim()).filter(Boolean)
        .map((tg) => `<span class="bb-tag">${escapeHtml(tg)}</span>`).join("")}</div>`
    : "";
  const sub = card.parent_id != null
    ? `<div class="bb-sub">↳ subtask of #${escapeHtml(String(card.parent_id))}</div>` : "";
  const lockBadge = locked
    ? `<span class="bb-lock" title="a bot is working this card — read-only">🔒 bot working</span>` : "";
  return `<div class="bb-card${locked ? " bb-locked" : ""}" draggable="${locked ? "false" : "true"}" ` +
    `data-card="${escapeHtml(String(card.id))}" data-status="${escapeHtml(String(card.status))}" ` +
    `data-locked="${locked ? "1" : "0"}" tabindex="0" role="button" ` +
    `aria-label="card ${escapeHtml(String(card.id))}: ${escapeHtml(String(card.title || ""))}">` +
    `<div class="bb-card-top">${prio}<span class="bb-id">#${escapeHtml(String(card.id))}</span>${lockBadge}</div>` +
    `<div class="bb-title">${escapeHtml(String(card.title || "(untitled)"))}</div>` +
    `<div class="bb-card-meta">${due}${owner}</div>${tags}${sub}` +
    `<form method="POST" action="/dashboard/bot-board" class="bb-nojs-move">` +
    `<input type="hidden" name="action" value="move">` +
    `<input type="hidden" name="card_id" value="${escapeHtml(String(card.id))}">` +
    `<input type="hidden" name="project" value="${escapeHtml(String(card.project_id == null ? "" : card.project_id))}">` +
    CARD_STATUSES.filter((s) => s !== card.status).map((s) =>
      `<button type="submit" name="status" value="${s}" ${locked ? "disabled" : ""} ` +
      `title="move to ${STATUS_LABEL[s]}">${escapeHtml(STATUS_LABEL[s])}</button>`).join("") +
    `</form></div>`;
}

export function trackerCardFaceHtml(item, contextFields, statusValues, locked) {
  const prio = item.priority == null ? "" :
    `<span class="bb-prio bb-prio-${escapeHtml(String(item.priority))}" title="priority ${escapeHtml(String(item.priority))}">P${escapeHtml(String(item.priority))}</span>`;
  const lockBadge = locked
    ? `<span class="bb-lock" title="a bot is processing this item — read-only">🔒 processing</span>` : "";

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
    `<button type="submit" name="status" value="${escapeHtml(s)}" ${locked ? "disabled" : ""} ` +
    `title="move to ${escapeHtml(s)}">${escapeHtml(s)}</button>`).join("");

  return `<div class="bb-card${locked ? " bb-locked" : ""}" draggable="${locked ? "false" : "true"}" ` +
    `data-card="${escapeHtml(String(item.id))}" data-status="${escapeHtml(String(item.status))}" ` +
    `data-locked="${locked ? "1" : "0"}" data-item-type="tracker" ` +
    `data-search-text="${escapeHtml(searchText)}" data-action-needed="${item.action_needed ? "1" : "0"}" ` +
    `data-priority="${item.priority != null ? escapeHtml(String(item.priority)) : ""}" ` +
    `data-json="${escapeHtml(item.data_json || "{}")}" ` +
    `tabindex="0" role="button" ` +
    `aria-label="item ${escapeHtml(String(item.id))}: ${escapeHtml(String(item.label || ""))}">` +
    `<div class="bb-card-top">${prio}<span class="bb-id">#${escapeHtml(String(item.id))}</span>${lockBadge}</div>` +
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
export function drawerMarkup(lang) {
  return `<div class="bb-drawer" id="bb-drawer" aria-hidden="true">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h3 id="bb-d-title" style="font-family:'Fraunces',serif;margin:0">Card</h3>
      <button type="button" class="bb-btn bb-sec" id="bb-d-close" aria-label="${tJs("common.close", lang)}">✕ Close</button>
    </div>
    <div class="bb-msg" id="bb-d-msg"></div>
    <div id="bb-d-lock" class="bb-msg warn"></div>
    <label>Title</label><input id="bb-d-title-in" type="text">
    <div class="bb-row">
      <div><label>Status</label><select id="bb-d-status">${CARD_STATUSES.map((s) => `<option value="${s}">${STATUS_LABEL[s]}</option>`).join("")}</select></div>
      <div><label>Priority</label><select id="bb-d-prio"><option value="">—</option>${[1, 2, 3, 4, 5].map((n) => `<option value="${n}">${n}</option>`).join("")}</select></div>
    </div>
    <div class="bb-row">
      <div><label>Due date</label><input id="bb-d-due" type="text" placeholder="YYYY-MM-DD"></div>
      <div><label>Owner</label><input id="bb-d-owner" type="text"></div>
    </div>
    <label>Tags (comma-separated)</label><input id="bb-d-tags" type="text">
    <label>Description</label><textarea id="bb-d-desc" rows="3" style="font-family:inherit"></textarea>
    <label>Project</label><select id="bb-d-project"></select>
    <div>
      <button type="button" class="bb-btn" id="bb-d-save">Save card</button>
      <button type="button" class="bb-btn bb-sec" id="bb-d-cancel">Cancel card</button>
      <button type="button" class="bb-btn bb-sec" id="bb-d-unlock" style="display:none">Force-unlock</button>
    </div>
    <h4 style="margin-top:1rem;display:flex;justify-content:space-between;align-items:center">
      <span>Plan file</span>
      <button type="button" class="bb-btn bb-sec" id="bb-d-plan-toggle" style="margin:0">Preview</button>
    </h4>
    <div id="bb-d-plan-msg" class="bb-msg"></div>
    <textarea id="bb-d-plan" rows="14" placeholder="(no plan yet)"></textarea>
    <div class="bb-pre" id="bb-d-plan-pre" style="display:none"></div>
    <button type="button" class="bb-btn" id="bb-d-plan-save">Save plan</button>
  </div>
  <div class="bb-drawer" id="bb-newproj" aria-hidden="true">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h3 style="font-family:'Fraunces',serif;margin:0">New project</h3>
      <button type="button" class="bb-btn bb-sec" id="bb-np-close" aria-label="${tJs("common.close", lang)}">✕ Close</button>
    </div>
    <div class="bb-msg" id="bb-np-msg"></div>
    <label>Name</label><input id="bb-np-name" type="text">
    <label>Description</label><textarea id="bb-np-desc" rows="3" style="font-family:inherit"></textarea>
    <button type="button" class="bb-btn" id="bb-np-save">Create project</button>
  </div>
  <div class="bb-drawer" id="bb-newcard" aria-hidden="true">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h3 style="font-family:'Fraunces',serif;margin:0">New card</h3>
      <button type="button" class="bb-btn bb-sec" id="bb-nc-close" aria-label="${tJs("common.close", lang)}">✕ Close</button>
    </div>
    <div class="bb-msg" id="bb-nc-msg"></div>
    <p style="font-size:.8rem;color:var(--crow-text-muted)">Created in the current project, status <b>pending</b>.</p>
    <label>Title</label><input id="bb-nc-title" type="text">
    <label>Description</label><textarea id="bb-nc-desc" rows="3" style="font-family:inherit"></textarea>
    <div class="bb-row">
      <div><label>Due date</label><input id="bb-nc-due" type="text" placeholder="YYYY-MM-DD"></div>
      <div><label>Owner</label><input id="bb-nc-owner" type="text"></div>
    </div>
    <label>Tags (comma-separated)</label><input id="bb-nc-tags" type="text">
    <button type="button" class="bb-btn" id="bb-nc-save">Create card</button>
  </div>
  <div class="bb-drawer" id="bb-bulk" aria-hidden="true">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h3 style="font-family:'Fraunces',serif;margin:0">Add unlinked cards</h3>
      <button type="button" class="bb-btn bb-sec" id="bb-bk-close" aria-label="${tJs("common.close", lang)}">✕ Close</button>
    </div>
    <div class="bb-msg" id="bb-bk-msg"></div>
    <p style="font-size:.82rem;color:var(--crow-text-muted)">Cards with no project (max 200 per assign).</p>
    <div id="bb-bk-list" style="max-height:60vh;overflow:auto"></div>
    <button type="button" class="bb-btn" id="bb-bk-save">Assign selected</button>
  </div>`;
}

// Tracker item drawer — for custom tracker bots
export function trackerDrawerMarkup(lang) {
  return `<div class="bb-drawer" id="bb-tracker-drawer" aria-hidden="true">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h3 id="bb-td-title" style="font-family:'Fraunces',serif;margin:0">Item</h3>
      <button type="button" class="bb-btn bb-sec" id="bb-td-close" aria-label="${tJs("common.close", lang)}">✕ Close</button>
    </div>
    <div class="bb-msg" id="bb-td-msg"></div>
    <div id="bb-td-lock" class="bb-msg warn"></div>
    <label>Label</label><input id="bb-td-label" type="text">
    <div class="bb-row">
      <div><label>Status</label><select id="bb-td-status"></select></div>
      <div><label>Priority</label><select id="bb-td-prio"><option value="">—</option>${[1, 2, 3, 4, 5].map((n) => `<option value="${n}">${n}</option>`).join("")}</select></div>
    </div>
    <label>Action needed</label><input id="bb-td-action" type="text">
    <div id="bb-td-fields"></div>
    <div id="bb-td-lease" style="margin-top:.5rem;font-size:.78rem;color:var(--crow-text-muted)"></div>
    <div>
      <button type="button" class="bb-btn" id="bb-td-save">Save item</button>
      <button type="button" class="bb-btn bb-sec" id="bb-td-clear-lease" style="display:none">Force-clear lease</button>
    </div>
  </div>
  <div class="bb-drawer" id="bb-new-tracker-item" aria-hidden="true">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h3 style="font-family:'Fraunces',serif;margin:0">New tracker item</h3>
      <button type="button" class="bb-btn bb-sec" id="bb-nti-close" aria-label="${tJs("common.close", lang)}">✕ Close</button>
    </div>
    <div class="bb-msg" id="bb-nti-msg"></div>
    <label>Label (title)</label><input id="bb-nti-label" type="text">
    <div class="bb-row">
      <div><label>Status</label><select id="bb-nti-status"></select></div>
      <div><label>Priority</label><select id="bb-nti-prio"><option value="3" selected>3</option>${[1, 2, 4, 5].map((n) => `<option value="${n}">${n}</option>`).join("")}</select></div>
    </div>
    <label>Action needed</label><input id="bb-nti-action" type="text">
    <div id="bb-nti-fields"></div>
    <button type="button" class="bb-btn" id="bb-nti-save">Create item</button>
  </div>`;
}

// ---- Kanban board rendering ----
export async function renderKanbanBoard(req, res, { db, layout, selBot, bots, notice, switcher, q, lang }) {
  const projectId = selBot.projectId != null ? Number(selBot.projectId) : null;

  if (projectId == null) {
    return layout({
      title: `Bot Board — ${selBot.displayName}`,
      content: botBoardStyles() + section(
        `Board — ${escapeHtml(selBot.displayName)}`,
        notice + switcher +
        `<p style="margin-top:1rem;color:var(--crow-text-muted)">This bot has no project linked. Assign a project_id in Bot Builder.</p>`) +
        drawerMarkup(lang) + clientJs(selBot.botId, "kanban", null, null, null, lang),
    });
  }

  // Cards for the selected project — tasks.db via the journal-safe client.
  let cards = [];
  let tdb;
  try {
    tdb = createDbClient(TASKS_DB);
    cards = (await tdb.execute({
      sql:
        "SELECT id,title,description,status,priority,due_date,owner,tags,parent_id,project_id," +
        "datetime(updated_at) AS updated_at, completed_at " +
        "FROM tasks_items WHERE project_id=? ORDER BY priority ASC, id ASC",
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
        content: botBoardStyles() + section("Card not found",
          `<p>#${escapeHtml(String(q.card))} is not in this bot's project.</p>` +
          `<p><a href="/dashboard/bot-board?bot=${escapeHtml(selBot.botId)}">← back to board</a></p>`),
      });
    }
    const locked = !!lockMap.get(cid);
    const planInfo = await derivePlanPath(db, card);
    const plan = readPlan(planInfo);
    const fieldRow = (lbl, val) =>
      `<tr><td style="padding:3px 14px 3px 0;opacity:.7">${escapeHtml(lbl)}</td><td>${escapeHtml(String(val == null ? "—" : val))}</td></tr>`;
    const planBlock = !planInfo
      ? `<p class="bb-msg warn">No bot is linked to this project, so there is no plan file path.</p>`
      : `<p style="font-size:.8rem;color:var(--crow-text-muted)">${escapeHtml(planInfo.path)}</p>` +
        `<div class="bb-pre">${escapeHtml(plan.text || "(no plan yet)")}</div>` +
        (locked
          ? `<p class="bb-msg warn">🔒 A bot is working this card — the plan file is read-only.</p>`
          : `<p class="bb-msg">Open this board with JavaScript enabled to edit the plan file in the card drawer.</p>`);
    const moveForm =
      `<form method="POST" action="/dashboard/bot-board" style="margin:.6rem 0">` +
      `<input type="hidden" name="action" value="move">` +
      `<input type="hidden" name="card_id" value="${cid}">` +
      `<input type="hidden" name="bot" value="${escapeHtml(selBot.botId)}">` +
      `Move: ` + CARD_STATUSES.filter((s) => s !== card.status).map((s) =>
        `<button type="submit" name="status" value="${s}" class="bb-btn bb-sec" ${locked ? "disabled" : ""}>${escapeHtml(STATUS_LABEL[s])}</button>`).join(" ") +
      `</form>`;
    return layout({
      title: `Card #${cid}`,
      content: botBoardStyles() + section(
        `Card #${cid} — ${escapeHtml(String(card.title || ""))} ${badge(card.status, STATUS_BADGE[card.status] || "draft")}${locked ? " " + badge("bot working", "info") : ""}`,
        `<p><a href="/dashboard/bot-board?bot=${escapeHtml(selBot.botId)}">← back to board</a></p>` +
        `<table style="font-size:.9rem;border-collapse:collapse">` +
        fieldRow("Priority", card.priority) + fieldRow("Due", card.due_date) +
        fieldRow("Owner", card.owner) + fieldRow("Tags", card.tags) +
        fieldRow("Parent", card.parent_id) + fieldRow("Updated", card.updated_at) +
        `</table>` +
        (card.description ? `<p style="margin-top:.6rem">${escapeHtml(String(card.description))}</p>` : "") +
        moveForm + `<h4 style="margin-top:1rem">Plan file</h4>` + planBlock),
    });
  }

  // ---- full kanban board ----
  const byStatus = { pending: [], in_progress: [], done: [], cancelled: [] };
  for (const c of cards) (byStatus[c.status] || (byStatus[c.status] = [])).push(c);
  const columns = CARD_STATUSES.map((st) => {
    const list = byStatus[st] || [];
    const cardsHtml = list.length
      ? list.map((c) => cardFaceHtml(c, !!lockMap.get(Number(c.id)))).join("")
      : `<div style="color:var(--crow-text-muted);font-size:.78rem;padding:.4rem">—</div>`;
    return `<div class="bb-col" data-col="${st}">` +
      `<h4><span>${escapeHtml(STATUS_LABEL[st])}</span><span>${list.length}</span></h4>` +
      `<div class="bb-col-body" data-col-body="${st}">${cardsHtml}</div></div>`;
  }).join("");

  const boardHtml = `<div class="bb-board" style="--bb-cols:4">${columns}</div>`;

  const content = botBoardStyles() + section(
    `Board — ${escapeHtml(selBot.displayName)}`,
    notice + switcher + boardHtml) +
    drawerMarkup(lang) + clientJs(selBot.botId, "kanban", projectId, null, null, lang);

  return layout({ title: `Bot Board — ${selBot.displayName}`, content });
}

// ---- Custom tracker rendering ----
export async function renderCustomTracker(req, res, { db, layout, selBot, bots, notice, switcher, q, lang }) {
  const trackerSlug = selBot.trackerSlug;
  if (!trackerSlug) {
    return layout({
      title: `Bot Board — ${selBot.displayName}`,
      content: botBoardStyles() + section(
        `Board — ${escapeHtml(selBot.displayName)}`,
        notice + switcher +
        `<p style="margin-top:1rem;color:var(--crow-text-muted)">Custom tracker type but no tracker_slug configured.</p>`),
    });
  }

  // Look up tracker_defs
  let trackerDef = null;
  try {
    trackerDef = (await db.execute({
      sql: "SELECT id, slug, display_name, columns_json, status_values FROM tracker_defs WHERE slug=?",
      args: [trackerSlug],
    })).rows[0] || null;
  } catch { trackerDef = null; }

  if (!trackerDef) {
    return layout({
      title: `Bot Board — ${selBot.displayName}`,
      content: botBoardStyles() + section(
        `Board — ${escapeHtml(selBot.displayName)}`,
        notice + switcher +
        `<p style="margin-top:1rem;color:var(--crow-text-muted)">Tracker definition <code>${escapeHtml(trackerSlug)}</code> not found.</p>`),
    });
  }

  let statusValues = [];
  try { statusValues = JSON.parse(trackerDef.status_values || "[]"); } catch { statusValues = []; }

  // Use bot's tracker_config.context_fields for card face display (not all columns)
  const botContextFields = (selBot.definition && selBot.definition.tracker_config && selBot.definition.tracker_config.context_fields) || [];
  // Fall back to columns_json if bot has no context_fields configured
  let contextFields = botContextFields.length > 0 ? botContextFields : [];
  if (!contextFields.length) {
    try { contextFields = JSON.parse(trackerDef.columns_json || "[]"); } catch { contextFields = []; }
  }

  // Query tracker_items for this bot
  let items = [];
  try {
    items = (await db.execute({
      sql:
        "SELECT id, tracker_id, bot_id, status, priority, label, data_json, action_needed, " +
        "next_followup_date, processing_lease, processing_lease_status, " +
        "datetime(created_at) AS created_at, datetime(updated_at) AS updated_at " +
        "FROM tracker_items WHERE bot_id=? AND tracker_id=? ORDER BY priority ASC, id ASC",
      args: [selBot.botId, trackerDef.id],
    })).rows || [];
  } catch { items = []; }

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
          return trackerCardFaceHtml(item, contextFields, statusValues, locked);
        }).join("")
      : `<div style="color:var(--crow-text-muted);font-size:.78rem;padding:.4rem">—</div>`;
    return `<div class="bb-col" data-col="${escapeHtml(st)}">` +
      `<h4><span>${escapeHtml(st)}</span><span>${list.length}</span>` +
      `<button type="button" class="bb-col-toggle" title="collapse column" aria-label="Collapse ${escapeHtml(st)} column">−</button></h4>` +
      `<div class="bb-col-body" data-col-body="${escapeHtml(st)}">${cardsHtml}</div></div>`;
  }).join("");

  const boardHtml = `<div class="bb-board" id="bb-board" style="--bb-cols:${colCount}">${columnsHtml}</div>` +
    `<div id="bb-list-wrap" style="display:none"></div>`;

  const filterBarHtml =
    `<div class="bb-filter-bar">` +
    `<input type="text" id="bb-search" class="bb-search" placeholder="Search items…">` +
    `<div class="bb-chips">` +
    statusValues.map((sv) => `<button type="button" class="bb-chip" data-status-filter="${escapeHtml(sv)}">${escapeHtml(sv)}</button>`).join("") +
    `<button type="button" class="bb-chip bb-chip-action" data-filter="action-needed">action needed</button>` +
    `</div>` +
    `<div class="bb-view-toggle">` +
    `<button type="button" class="bb-view-btn bb-view-btn-active" data-view="columns">Columns</button>` +
    `<button type="button" class="bb-view-btn" data-view="list">List</button>` +
    `</div></div>`;

  const content = botBoardStyles() + section(
    `Board — ${escapeHtml(selBot.displayName)} (${escapeHtml(trackerDef.display_name || trackerSlug)})`,
    notice + switcher + filterBarHtml + boardHtml) +
    trackerDrawerMarkup(lang) + drawerMarkup(lang) + clientJs(selBot.botId, "custom", null, trackerSlug, contextFields, lang);

  return layout({ title: `Bot Board — ${selBot.displayName}`, content });
}
