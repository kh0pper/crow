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
  lockMapFor, statusLabel, liveBirdsByCard, sessionBirdState, foldBirdStates,
} from "./data-queries.js";
import { DEFAULT_BOARD_DEF, resolveBoardDef, resolveSlugBoardDef } from "../../../routes/board-defs.js";
// Track 3 Task 11 (spec §5.6): the interactive-engine singleton — live bird
// state is engine-sourced, not DB-derivable. createIfMissing:false: rendering
// the board must never conjure the engine into existence; a gateway that has
// never spawned an interactive session just draws no birds.
import { getInteractiveEngine } from "../../../perch-interactive.js";
// Track 3 Task 12: the roost strip's "observing" fallback (a bot with no
// COMPLETE perch gateway record can never hold a live session) — the SAME
// predicate routes/perch.js's /roost endpoint gates on, extracted so this
// SSR join and that JSON endpoint can never drift on what "attached" means.
import { perchAttached } from "../../../shared/perch-attached.js";
// Track 1 (carried item 2): the no-JS card view's plan block reads plan
// RECORDS now (D-T1.4), not the retired file rail — same store the JS
// drawer's GET /card/:id/plan route (plan-service.getCurrentPlan) reads.
import { getCurrentPlan } from "../../../board/plan-service.js";

// Display: configured values render raw (tracker-style); only the builtin
// fallback def keeps the i18n'd four.
function defStatusLabel(def, s, lang) {
  return def.builtin ? statusLabel(s, lang) : String(s);
}

// Shared tag-pill builder (Track 2 Task 10, W4/§5.2) — the kanban face
// (cardFaceHtml) and the tracker face (trackerCardFaceHtml) both render a
// card/item's comma-separated `tags` column as the same `.bb-tags`/`.bb-tag`
// pill block. Extracted so a tracker-side tags read doesn't drift from the
// kanban rendering it was copied from.
function tagPillsHtml(tags) {
  return tags
    ? `<div class="bb-tags">${String(tags).split(",").map((s) => s.trim()).filter(Boolean)
        .map((tg) => `<span class="bb-tag">${escapeHtml(tg)}</span>`).join("")}</div>`
    : "";
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

export function cardFaceHtml(card, locked, lang, def = DEFAULT_BOARD_DEF, bird = null) {
  // Track 3 Task 11 (spec §3.2/§5.6): a bird glyph, present only when a live
  // (waiting/working/hibernating) session carries this card's id. `bb-bird--
  // <state>` is PERCH_TOKENS-colored in css.js; `data-bird-sid` is how the
  // client correlates a later `bird-state` SSE frame (keyed by session id,
  // not card id) back to this DOM node, and what a click opens the drawer on.
  const birdHtml = bird
    ? `<span class="bb-bird bb-bird--${escapeHtml(String(bird.state))}" data-bird-sid="${escapeHtml(String(bird.sessionId))}" title="${escapeHtml(String(bird.state))}"></span>`
    : "";
  const prio = card.priority == null ? "" :
    `<span class="bb-prio bb-prio-${escapeHtml(String(card.priority))}" title="${t("botboard.titlePriorityPrefix", lang)} ${escapeHtml(String(card.priority))}">P${escapeHtml(String(card.priority))}</span>`;
  const due = card.due_date ? `<span class="bb-meta">⏱ ${escapeHtml(String(card.due_date))}</span>` : "";
  const owner = card.owner ? `<span class="bb-meta">👤 ${escapeHtml(String(card.owner))}</span>` : "";
  const tags = tagPillsHtml(card.tags);
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
  // Track 1 Task 9 (carried item 4): the result marker — read straight off
  // the list-payload columns the kanban query now carries (D-T1.6). A
  // 'recorded' success is a gated card sitting there waiting on a human;
  // failure/partial is worth a visible flag whether or not it's been
  // decided yet — a failed run must not look identical to still-running.
  const resultGatedSuccess = card.latest_result_outcome === "success" && card.latest_result_status === "recorded";
  const resultMarker =
    resultGatedSuccess
      ? `<div class="bb-marker bb-marker-waiting">${t("board.markerWaiting", lang)}</div>`
      : (card.latest_result_outcome === "failure" || card.latest_result_outcome === "partial")
        ? `<div class="bb-marker bb-marker-failed">${t("board.markerFailed", lang)}</div>`
        : "";
  // Track 3 Task 14: Accept/Reject directly on the card face — a gated
  // success result sitting on THIS card. `data-result-actions` is the guard
  // both the click-to-open handler and dragstart check for (closest() —
  // client.js), so a click here never opens the card drawer or starts a
  // drag; the buttons dispatch their own decide (+ two-step move-to-'done'
  // on accept, spec §4) via a delegated handler, never a page reload of
  // their own. Only rendered when latest_result_id actually came back from
  // the SSR join (a store mid-migration without the column/table degrades to
  // the marker alone, same guard the marker itself already relies on).
  const resultActionsHtml = resultGatedSuccess && card.latest_result_id != null
    ? `<div class="bb-result-actions" data-result-actions data-result-id="${escapeHtml(String(card.latest_result_id))}">` +
      `<button type="button" class="bb-btn bb-sec" data-result-action="accept">${t("board.btnApproveResult", lang)}</button>` +
      `<button type="button" class="bb-btn bb-sec" data-result-action="reject">${t("board.btnRejectResult", lang)}</button>` +
      `</div>`
    : "";
  let data = {};
  try { data = JSON.parse(card.data_json || "{}"); } catch { data = {}; }
  const fieldMeta = declaredFieldMeta(def, card, data);
  // Search text mirrors the tracker face: everything a human would scan for.
  // The id leads so a typed "#284" (or a bare "284") finds one card among hundreds.
  const searchParts = [`#${card.id}`, card.title || "", card.status || "", card.owner || "", card.tags || "", card.due_date || ""];
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
    `<div class="bb-card-top">${prio}<span class="bb-id">#${escapeHtml(String(card.id))}</span>${birdHtml}${lockBadge}${archivedBadge}</div>` +
    `<div class="bb-title">${escapeHtml(String(card.title || "(untitled)"))}</div>` +
    `<div class="bb-card-meta">${due}${owner}${fieldMeta}</div>${tags}${sub}${resultMarker}${resultActionsHtml}` +
    `<form method="POST" action="/dashboard/bot-board" class="bb-nojs-move">` +
    `<input type="hidden" name="action" value="move">` +
    `<input type="hidden" name="card_id" value="${escapeHtml(String(card.id))}">` +
    `<input type="hidden" name="project" value="${escapeHtml(String(card.project_id == null ? "" : card.project_id))}">` +
    def.status_values.filter((s) => s !== card.status).map((s) =>
      `<button type="submit" name="status" value="${escapeHtml(s)}" ${locked || archived ? "disabled" : ""} ` +
      `title="${t("botboard.moveTo", lang)}${escapeHtml(defStatusLabel(def, s, lang))}">${escapeHtml(defStatusLabel(def, s, lang))}</button>`).join("") +
    `</form></div>`;
}

// ---- Track 3 Task 12: the roost strip ("birds on a wire" above the board) ----
//
// One glyph per bot (not per card): idle/working/waiting/hibernating/observing,
// same fold as routes/perch.js's GET /roost — engine-sourced, never conjures
// the engine into existence (the `engine` argument is whatever renderKanbanBoard
// resolved, createIfMissing:false in production; see that function's own note).
const ROOST_STATE_LABEL_KEY = {
  idle: "botboard.roostStateIdle",
  working: "botboard.roostStateWorking",
  waiting: "botboard.roostStateWaiting",
  hibernating: "botboard.roostStateHibernating",
  observing: "botboard.roostStateObserving",
};

// Fold every bot def down to ONE strip entry: {id, name, state, sessionId}.
// `sessionId` is the session whose state WON the fold (spec §3.2 priority,
// via the shared foldBirdStates/sessionBirdState — same functions
// liveBirdsByCard uses, so the strip and the card glyphs never disagree on
// what a given session's state is) — null for idle/observing, where there is
// no live session to correlate a later `bird-state` SSE frame against.
async function computeRoostBirds(bots, engine) {
  let sessions = [];
  if (engine) {
    try { sessions = await engine.list(); } catch { sessions = []; }
  }
  const byBot = new Map();
  for (const s of sessions) {
    const list = byBot.get(s.botId);
    if (list) list.push(s); else byBot.set(s.botId, [s]);
  }
  return (bots || []).map((b) => {
    // §3.1: a bot with no complete perch gateway record can never hold a
    // live session — always "observing", regardless of what engine.list()
    // might (stalely) say about a bot id that used to carry one.
    if (!perchAttached(b.definition)) {
      return { id: b.botId, name: b.displayName, state: "observing", sessionId: null };
    }
    const botSessions = byBot.get(b.botId) || [];
    const state = foldBirdStates(botSessions.map(sessionBirdState)) || "idle";
    const winner = state === "idle" ? null : botSessions.find((s) => sessionBirdState(s) === state);
    return { id: b.botId, name: b.displayName, state, sessionId: winner ? winner.sessionId : null };
  });
}

// One `.bb-roost-bird[data-bot]` — glyph, name, state text, and the ONE
// primary action for this state (spec: idle→Send out, working/hibernating→
// Open, waiting→Answer, observing→a plain link to Bot Builder). The overflow
// menu (Talk/Sessions/Recall/Setup) is the SAME on every bird; Recall is
// omitted when there is no live session to stop (idle/observing).
function roostBirdHtml(bird, lang) {
  const state = bird.state;
  const idAttr = escapeHtml(String(bird.id));
  const stateText = t(ROOST_STATE_LABEL_KEY[state] || ROOST_STATE_LABEL_KEY.idle, lang);
  // `data-bird-sid` on the GLYPH span — the exact convention cardFaceHtml
  // uses — so a `bird-state` SSE frame can patch card face AND roost glyph
  // with the SAME selector (`.bb-bird[data-bird-sid="<sid>"]`), never two.
  const sidAttr = bird.sessionId != null ? ` data-bird-sid="${escapeHtml(String(bird.sessionId))}"` : "";
  const sidDataAttr = bird.sessionId != null ? ` data-sid="${escapeHtml(String(bird.sessionId))}"` : "";

  let primaryHtml;
  if (state === "observing") {
    primaryHtml = `<a class="bb-roost-primary bb-roost-link" href="/dashboard/bot-builder#${idAttr}">${t("botboard.roostActionAttach", lang)}</a>`;
  } else if (state === "idle") {
    primaryHtml = `<button type="button" class="bb-roost-primary" data-roost-action="dispatch" data-bot="${idAttr}">${t("botboard.roostActionSendOut", lang)}</button>`;
  } else if (state === "waiting") {
    primaryHtml = `<button type="button" class="bb-roost-primary" data-roost-action="answer" data-bot="${idAttr}"${sidDataAttr}>${t("botboard.roostActionAnswer", lang)}</button>`;
  } else {
    // working / hibernating
    primaryHtml = `<button type="button" class="bb-roost-primary" data-roost-action="open" data-bot="${idAttr}"${sidDataAttr}>${t("botboard.roostActionOpen", lang)}</button>`;
  }

  const recallHtml = bird.sessionId != null
    ? `<button type="button" data-roost-action="recall" data-bot="${idAttr}"${sidDataAttr}>${t("botboard.roostActionRecall", lang)}</button>`
    : "";

  return `<div class="bb-roost-bird" data-bot="${idAttr}" data-roost-state="${escapeHtml(state)}">` +
    `<span class="bb-bird bb-bird--${escapeHtml(state)}"${sidAttr} title="${escapeHtml(stateText)}"></span>` +
    `<span class="bb-roost-name">${escapeHtml(String(bird.name))}</span>` +
    `<span class="bb-roost-state">${escapeHtml(stateText)}</span>` +
    primaryHtml +
    `<button type="button" class="bb-roost-more" data-roost-menu-toggle aria-haspopup="true" aria-expanded="false" aria-label="${escapeHtml(t("botboard.roostMoreAria", lang))}">⋯</button>` +
    `<div class="bb-roost-menu" aria-hidden="true">` +
    `<button type="button" data-roost-action="talk" data-bot="${idAttr}">${t("botboard.roostActionTalk", lang)}</button>` +
    `<button type="button" data-roost-action="sessions" data-bot="${idAttr}"${sidDataAttr}>${t("botboard.roostActionSessions", lang)}</button>` +
    recallHtml +
    `<a href="/dashboard/bot-builder?bot=${encodeURIComponent(String(bird.id))}&tab=tracker">${t("botboard.roostActionSetup", lang)}</a>` +
    `</div></div>`;
}

// The strip itself — `bots` is the FULL switcher list (every bot on this
// board's dashboard, not just the selected one): birds-on-a-wire is a
// roster overview, not a per-board filter.
export async function roostStripHtml(bots, engine, lang) {
  const birds = await computeRoostBirds(bots, engine);
  const body = birds.length
    ? birds.map((b) => roostBirdHtml(b, lang)).join("")
    : `<div class="bb-roost-empty">${t("botboard.roostEmpty", lang)}</div>`;
  return `<div class="bb-roost" id="bb-roost"><div class="bb-roost-track" id="bb-roost-track">${body}</div></div>`;
}

// The Send-out card-picker dialog (idle→primary action). Static markup only
// — reuses the SAME `.bb-drawer` slide-over + openDrawer/closeDrawer idiom
// every other panel dialog uses; the card <select> and note field are filled
// in client-side from the DOM (minus GET /roost's occupiedCardIds) when it
// opens, never SSR'd per-bot.
export function roostDispatchDialogMarkup(lang) {
  return `<div class="bb-drawer" id="bb-roost-dispatch" aria-hidden="true">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h3 id="bb-rd-title" style="font-family:var(--crow-body-font);margin:0">${t("botboard.roostDispatchTitle", lang)}</h3>
      <button type="button" class="bb-btn bb-sec" id="bb-rd-close" aria-label="${tJs("common.close", lang)}">✕ ${t("common.close", lang)}</button>
    </div>
    <div class="bb-msg" id="bb-rd-msg"></div>
    <label>${t("botboard.roostDispatchCardLabel", lang)}</label>
    <select id="bb-rd-card"></select>
    <div id="bb-rd-note-wrap">
      <label>${t("botboard.roostDispatchNoteLabel", lang)}</label>
      <textarea id="bb-rd-note" rows="3" style="font-family:inherit"></textarea>
    </div>
    <button type="button" class="bb-btn" id="bb-rd-send">${t("botboard.roostDispatchConfirm", lang)}</button>
  </div>`;
}

// Track 3 Task 13: the session drawer's static shell — a right slide-over
// (`.bb-drawer.bb-bird-drawer`, `role="dialog"` `aria-modal="true"`), plus
// its own backdrop element (ESC/backdrop-click close, wired in drawer.js's
// emitted JS). Pure static markup, no dynamic data interpolated — hydrated
// entirely client-side, same split as drawerMarkup() below.
export function birdDrawerMarkup(lang) {
  return `<div class="bb-bird-backdrop" id="bb-bird-backdrop" aria-hidden="true"></div>
  <div class="bb-drawer bb-bird-drawer" id="bb-bird-drawer" role="dialog" aria-modal="true" aria-hidden="true" aria-labelledby="bb-bd-name">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:.4rem">
      <div style="min-width:0">
        <div id="bb-bd-name" style="font-family:var(--crow-body-font);font-weight:600;font-size:1rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></div>
        <span id="bb-bd-state" class="bb-list-status"></span>
      </div>
      <div style="display:flex;align-items:center;gap:.3rem;flex:0 0 auto">
        <div class="bb-bd-menu-wrap">
          <button type="button" class="bb-roost-more" id="bb-bd-menu-toggle" aria-haspopup="true" aria-expanded="false" aria-label="${escapeHtml(t("botboard.bdMoreAria", lang))}">⋯</button>
          <div class="bb-bd-menu" id="bb-bd-menu" aria-hidden="true">
            <button type="button" id="bb-bd-stop">${t("botboard.bdStop", lang)}</button>
          </div>
        </div>
        <button type="button" class="bb-btn bb-sec" id="bb-bd-close" aria-label="${tJs("common.close", lang)}">✕ ${t("common.close", lang)}</button>
      </div>
    </div>
    <div id="bb-bd-card-link-wrap" class="bb-msg" style="display:none"><a id="bb-bd-card-link" href="#"></a></div>
    <div id="bb-bd-hibernating" class="bb-msg warn" style="display:none">${t("botboard.bdHibernating", lang)}</div>
    <div class="bb-bd-controls-row">
      <select id="bb-bd-model" disabled aria-label="${escapeHtml(t("botboard.bdEnvelopeModelPrefix", lang))}"></select>
      <select id="bb-bd-thinking" disabled></select>
      <select id="bb-bd-permission">
        <option value="guarded">${t("botboard.bdPermGuarded", lang)}</option>
        <option value="ask">${t("botboard.bdPermAsk", lang)}</option>
        <option value="bypass">${t("botboard.bdPermBypass", lang)}</option>
      </select>
      <label class="bb-bd-plan-label"><input type="checkbox" id="bb-bd-plan-toggle"> ${t("botboard.bdPlanModeLabel", lang)}</label>
    </div>
    <div id="bb-bd-bindsatwake" class="bb-msg warn" style="display:none">
      <span id="bb-bd-bindsatwake-text">${t("botboard.bdBindsAtWake", lang)}</span>
      <button type="button" class="bb-btn bb-sec" id="bb-bd-apply-now">${t("botboard.bdApplyNow", lang)}</button>
    </div>
    <div class="bb-bd-controls-toggle-wrap">
      <button type="button" class="bb-btn bb-sec" id="bb-bd-controls-toggle" aria-expanded="false">${t("botboard.bdEnvelopeToggle", lang)}</button>
      <button type="button" class="bb-btn bb-sec" id="bb-bd-attach-card">${t("botboard.bdAttachCard", lang)}</button>
    </div>
    <div id="bb-bd-controls-pane" style="display:none"></div>
    <div id="bb-bd-result"></div>
    <div id="bb-bd-picker" style="display:none"></div>
    <div id="bb-bd-transcript" class="bb-pre bb-bd-transcript"></div>
    <div id="bb-bd-ask"></div>
    <div id="bb-bd-files">
      <button type="button" class="bb-btn bb-sec" id="bb-bd-attach">${t("botboard.bdAttachFile", lang)}</button>
      <input type="file" id="bb-bd-file-input" style="display:none" accept="image/*">
      <span id="bb-bd-files-queue" class="bb-bd-files-queue"></span>
    </div>
    <div id="bb-bd-composer">
      <textarea id="bb-bd-input" rows="3" style="font-family:inherit" placeholder="${t("botboard.bdComposerPlaceholder", lang)}"></textarea>
      <div>
        <button type="button" class="bb-btn" id="bb-bd-send">${t("botboard.bdSend", lang)}</button>
        <button type="button" class="bb-btn bb-sec" id="bb-bd-abort" style="display:none">${t("botboard.bdAbort", lang)}</button>
      </div>
    </div>
  </div>`;
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
  const searchParts = [`#${item.id}`, item.label || "", item.status || "", item.tags || ""];
  for (const v of Object.values(data)) {
    if (v != null && v !== "") searchParts.push(typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  if (item.action_needed) searchParts.push(String(item.action_needed));
  const searchText = searchParts.join(" ").toLowerCase();
  const tags = tagPillsHtml(item.tags);
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
    metaHtml + tags + actionHtml +
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
      <h3 id="bb-d-title" style="font-family:var(--crow-body-font);margin:0">${t("botboard.drawerCardTitle", lang)}</h3>
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
    <label>${t("board.autonomy", lang)}</label>
    <select id="bb-d-autonomy">
      <option value="gated">${t("board.autonomyGated", lang)}</option>
      <option value="auto">${t("board.autonomyAuto", lang)}</option>
    </select>
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
    <div id="bb-d-result-wrap"></div>
    <h4 style="margin-top:1rem">${t("board.historyTitle", lang)}</h4>
    <div id="bb-d-history" class="bb-msg"></div>
  </div>
  <div class="bb-drawer" id="bb-newproj" aria-hidden="true">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h3 style="font-family:var(--crow-body-font);margin:0">${t("botboard.drawerNewProject", lang)}</h3>
      <button type="button" class="bb-btn bb-sec" id="bb-np-close" aria-label="${tJs("common.close", lang)}">✕ ${t("common.close", lang)}</button>
    </div>
    <div class="bb-msg" id="bb-np-msg"></div>
    <label>${t("botboard.labelName", lang)}</label><input id="bb-np-name" type="text">
    <label>${t("botboard.labelDescription", lang)}</label><textarea id="bb-np-desc" rows="3" style="font-family:inherit"></textarea>
    <button type="button" class="bb-btn" id="bb-np-save">${t("botboard.btnCreateProject", lang)}</button>
  </div>
  <div class="bb-drawer" id="bb-newcard" aria-hidden="true">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h3 style="font-family:var(--crow-body-font);margin:0">${t("botboard.drawerNewCard", lang)}</h3>
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
    <label>${t("board.autonomy", lang)}</label>
    <select id="bb-nc-autonomy">
      <option value="gated">${t("board.autonomyGated", lang)}</option>
      <option value="auto">${t("board.autonomyAuto", lang)}</option>
    </select>
    <button type="button" class="bb-btn" id="bb-nc-save">${t("botboard.btnCreateCard", lang)}</button>
  </div>
  <div class="bb-drawer" id="bb-bulk" aria-hidden="true">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h3 style="font-family:var(--crow-body-font);margin:0">${t("botboard.drawerBulkTitle", lang)}</h3>
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
      <h3 style="font-family:var(--crow-body-font);margin:0">${t("botboard.cfgTitle", lang)}</h3>
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
      <h3 id="bb-td-title" style="font-family:var(--crow-body-font);margin:0">${t("botboard.drawerTrackerItem", lang)}</h3>
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
      <h3 style="font-family:var(--crow-body-font);margin:0">${t("botboard.drawerNewTrackerItem", lang)}</h3>
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
export async function renderKanbanBoard(req, res, {
  db, layout, selBot, bots, notice, switcher, q, lang,
  // Track 3 Task 11 test seam — same accessor-or-object shape as the
  // perch.js/streams.js seams; production never passes this key, so the
  // createIfMissing:false default above is what actually runs live.
  engine = getInteractiveEngine({ createIfMissing: false }),
}) {
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
        drawerMarkup(lang) + birdDrawerMarkup(lang) + clientJs(selBot.botId, "kanban", null, null, null, lang, false),
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
    const archivedClause = includeArchived ? "" : " AND t.archived_at IS NULL";
    try {
      // Track 1 Task 9 (carried item 4): LEFT JOIN each card's LATEST
      // board_results row — outcome + status — onto the row set. This is
      // "the list payload" the card face's marker (bb-marker-waiting /
      // bb-marker-failed) reads; a per-card follow-up query would be an
      // N+1, so the correlated subquery does it in the one list SELECT.
      cards = (await tdb.execute({
        sql: `SELECT t.*, r.id AS latest_result_id, r.outcome AS latest_result_outcome, r.status AS latest_result_status
              FROM tasks_items t
              LEFT JOIN board_results r ON r.id = (
                SELECT id FROM board_results WHERE item_id = t.id ORDER BY id DESC LIMIT 1
              )
              WHERE t.project_id=?${archivedClause}
              ORDER BY t.priority ASC, t.id ASC`,
        args: [projectId],
      })).rows || [];
    } catch {
      // board_results is a Track 1 table (0004): a pre-migration store or a
      // hand-built test fixture may not carry it yet — column/table-guard
      // (D-T1.6 precedent) degrades to plain cards, no markers, rather than
      // losing the whole board.
      cards = (await tdb.execute({
        sql: `SELECT * FROM tasks_items WHERE project_id=?${includeArchived ? "" : " AND archived_at IS NULL"} ORDER BY priority ASC, id ASC`,
        args: [projectId],
      })).rows || [];
    }
  } catch {
    cards = [];
  } finally {
    if (tdb) { try { tdb.close(); } catch { /* already closed */ } }
  }

  const lockMap = await lockMapFor(db, cards.map((c) => Number(c.id)));
  // Track 3 Task 11: engine-sourced bird state, one entry per occupied card —
  // see data-queries.js's liveBirdsByCard for why this can't be read off the
  // cards themselves (bot_sessions rows are not the live truth; spec §5.6).
  const birdsByCard = await liveBirdsByCard(engine, db);

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
    // Track 1 (carried item 2): the no-JS plan block re-points from the
    // retired plan-FILE rail (derivePlanPath/readPlan, D-T1.7) to plan
    // RECORDS (D-T1.4) — plan-service.getCurrentPlan against the
    // instance-global tasks.db, the SAME store the JS drawer's Plan tab
    // reads via GET /card/:id/plan. "Current plan" is derived there too:
    // latest approved, else latest draft, else none.
    let currentPlan = null;
    let ptdb;
    try {
      ptdb = createDbClient(TASKS_DB);
      currentPlan = await getCurrentPlan(ptdb, cid);
    } catch { currentPlan = null; } finally {
      if (ptdb) { try { ptdb.close(); } catch { /* already closed */ } }
    }
    const fieldRow = (lbl, val) =>
      `<tr><td style="padding:3px 14px 3px 0;opacity:.7">${escapeHtml(lbl)}</td><td>${escapeHtml(String(val == null ? "—" : val))}</td></tr>`;
    const planBlock = !currentPlan
      ? `<p class="bb-msg warn">${t("botboard.planPlaceholder", lang)}</p>`
      : `<p style="font-size:.8rem;color:var(--crow-text-muted)">v${escapeHtml(String(currentPlan.version))} (${escapeHtml(String(currentPlan.status))})</p>` +
        `<div class="bb-pre">${escapeHtml(currentPlan.body_md || t("botboard.planFilePlaceholder", lang))}</div>` +
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
      ? list.map((c) => cardFaceHtml(c, !!lockMap.get(Number(c.id)), lang, def, birdsByCard.get(Number(c.id)) || null)).join("")
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

  // Track 3 Task 12: the roost strip — birds-on-a-wire above the board,
  // one glyph per bot on this dashboard (the full switcher list, not just
  // the selected board's bot). Same `engine` seam as birdsByCard above, so
  // a test overriding it drives BOTH the card glyphs and the strip.
  const roostHtml = await roostStripHtml(bots, engine, lang);

  const content = botBoardStyles() + section(
    `Board — ${escapeHtml(selBot.displayName)}`,
    notice + switcher + roostHtml + filterBarHtml + boardHtml) +
    drawerMarkup(lang, def) + boardSettingsDrawerMarkup(lang, projectId) + roostDispatchDialogMarkup(lang) +
    birdDrawerMarkup(lang) +
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
        "SELECT id, board_id, bot_id, status, priority, title AS label, tags, data_json, action_needed, " +
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
    `<input type="text" id="bb-search" class="bb-search" placeholder="Search items (label, tag, #id)…">` +
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
