/**
 * The project home's markup: Start a session (with the lead, and a per-session
 * bot pick), Where you left off (R1.2 PR 4: the briefing's summaries, Board
 * facts and recalled memories; absent when CROW_SESSION_BRIEFING=0), Needs you
 * (up to three rows, then All on Board) and Earlier sessions. No session state, id or model is ever shown: a session is its
 * label (or "Untitled session"), its bot and a relative day.
 *
 * Every bot- or operator-written value goes through escapeHtml.
 */

import { escapeHtml } from "../../shared/components.js";
import { t } from "../../shared/i18n.js";
import { needsYouLabel } from "../board/needs-you-label.js";
import { relativeDay } from "./data.js";
import { csrfInput } from "../../shared/csrf.js";
import { servicesUiEnabled } from "../../../services/ui-flag.js";
import { sessionCardHtml, sessionCardModel, startControlHtml } from "../../shared/session-cards.js";

const KIND_KEY = Object.freeze({ decision: "shell.kindDecision", review: "shell.kindReview", question: "shell.kindQuestion" });

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
/** t(key) with {name} filled; split/join, so a "$" in a value is never a replace pattern. */
const fill = (key, lang, vals) => Object.entries(vals).reduce((out, [k, v]) => out.split("{" + k + "}").join(String(v ?? "")), t(key, lang));
const CLOSE_SVG = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M18 6L6 18M6 6l12 12"/></svg>';

const MOVE_ERRORS = Object.freeze({
  voice_bot: "projectHome.errVoice", unknown_bot: "projectHome.errUnknown", same_project: "projectHome.errSame",
  custom_tracker: "botbuilder.boardOnCustom", no_project: "projectHome.errNoProject", stale: "projectHome.errStale",
});

/** The result line after a move: a success status, or an alert naming why nothing changed. */
function noticeHtml(data, lang) {
  if (data.movedName) return `<p class="ph-banner ph-banner--ok" role="status" data-ph-moved>${escapeHtml(fill("projectHome.moved", lang, { bot: data.movedName }))}</p>`;
  const n = data.notice;
  if (!n || !n.error) return "";
  const msg = n.error === "conflict"
    ? fill("projectHome.errConflict", lang, { path: n.path || "" })
    : t(MOVE_ERRORS[n.error] || "projectHome.errOther", lang);
  return `<p class="ph-banner ph-banner--err" role="alert" data-ph-error="${escapeHtml(n.error)}">${escapeHtml(msg)}</p>`;
}

/** Bots (§14): the project's bots with Edit, and for a viewer who may change it, Add a bot and Move a bot here. */
function botsSection(data, project, lang, req) {
  const head = `<h3 class="ph-h" id="ph-bots-h">${escapeHtml(t("projectHome.bots", lang))}</h3>`;
  const rows = data.bots.map((b) => `<li><div class="ph-row ph-bot"><span class="ph-row-title">${escapeHtml(b.name)}</span><a class="ph-link ph-edit" href="/dashboard/bot-builder?bot=${encodeURIComponent(b.id)}" aria-label="${escapeHtml(fill("projectHome.editBot", lang, { bot: b.name }))}">${escapeHtml(t("projectHome.edit", lang))}</a></div></li>`).join("");
  const list = rows ? `<ul class="ph-list ph-bot-list">${rows}</ul>` : `<p class="ph-line">${escapeHtml(t("projectHome.noBots", lang))}</p>`;
  let controls = "";
  if (data.canManage) {
    const home = `/dashboard/project/${encodeURIComponent(project.slug)}`;
    if (data.confirm) {
      const c = data.confirm;
      controls = `<div class="ph-confirm" role="group" aria-labelledby="ph-confirm-h" data-ph-confirm>
        <p class="ph-confirm-h" id="ph-confirm-h">${escapeHtml(fill("projectHome.moveConfirm", lang, { bot: c.name, from: c.fromName, project: project.name }))}</p>
        <p class="ph-sub">${escapeHtml(t("projectHome.moveWhat", lang))}</p>
        <form method="POST" action="${home}" class="ph-move-form">
          ${csrfInput(req)}
          <input type="hidden" name="action" value="move_bot">
          <input type="hidden" name="bot_id" value="${escapeHtml(c.id)}">
          <button type="submit" class="ph-start-btn">${escapeHtml(t("projectHome.moveGo", lang))}</button>
          <a class="ph-link" href="${home}">${escapeHtml(t("common.cancel", lang))}</a>
        </form>
      </div>`;
    } else {
      const options = data.movable.map((b) => `<option value="${escapeHtml(b.id)}">${escapeHtml(fill("projectHome.moveOption", lang, { bot: b.name, from: b.fromName }))}</option>`).join("");
      const move = data.movable.length
        ? `<form method="GET" action="${home}" class="ph-move-form ph-move-pick">
            <label class="ph-pick"><span>${escapeHtml(t("projectHome.moveHere", lang))}</span><select name="move" data-ph-move-select>${options}</select></label>
            <button type="submit" class="ph-start-btn" data-ph-move-go>${escapeHtml(t("projectHome.moveContinue", lang))}</button>
          </form>`
        : `<p class="ph-sub">${escapeHtml(t("projectHome.moveNone", lang))}</p>`;
      controls = `<details class="ph-add"><summary class="ph-link">${escapeHtml(t("projectHome.addBot", lang))}</summary>
          <a class="ph-link ph-new-bot" href="/dashboard/bot-builder?new=1&amp;project=${Number(project.id)}">${escapeHtml(t("projectHome.newBot", lang))}</a>
        </details>
        ${move}`;
    }
  }
  return `<section class="ph-section ph-bots" aria-labelledby="ph-bots-h">${head}${list}${controls}</section>`;
}

const OUTCOME_KEY = Object.freeze({ success: "board.resultOutcomeSuccess", failure: "board.resultOutcomeFailure", partial: "board.resultOutcomePartial" });

function factText(f, lang) {
  if (f.kind === "moved") return fill("shell.factMoved", lang, { status: f.to });
  if (f.kind === "decided") return f.choice ? fill("shell.factDecidedChoice", lang, { choice: f.choice }) : t("shell.factDecided", lang);
  return fill("shell.factResult", lang, { outcome: OUTCOME_KEY[f.outcome] ? t(OUTCOME_KEY[f.outcome], lang) : f.outcome });
}

/** "Where you left off": summaries, then the Board facts since, then the memory line and its sheet. */
function leftOffSection(data, project, lang, now) {
  const b = data.briefing;
  if (!b) return "";
  const head = `<h3 class="ph-h" id="ph-left-h">${escapeHtml(t("shell.leftOff", lang))}</h3>`;
  const parts = [];
  if (!b.summaries.length) parts.push(`<p class="ph-line">${escapeHtml(t("shell.noSummaries", lang))}</p>`);
  else {
    const rows = b.summaries.map((s) => {
      const rd = relativeDay(s.at, { now, lang });
      const day = rd ? (rd.key ? t(rd.key, lang) : cap(rd.text)) : "";
      const who = s.botName ? fill("shell.botSummary", lang, { bot: s.botName }) : t("shell.summaryAnon", lang);
      const title = [who, day].filter(Boolean).join(" · ");
      const note = s.outsideContent ? `<span class="ph-kind ph-kind--outside">${escapeHtml(t("shell.outsideContent", lang))}</span>` : "";
      const inner = `<span class="ph-row-title">${escapeHtml(title)}</span>${note}<span class="ph-summary-text">${escapeHtml(s.summary)}</span>`;
      return s.openable
        ? `<li><a class="ph-row ph-summary" href="/dashboard/perch?project=${encodeURIComponent(project.slug)}#${encodeURIComponent(s.threadId)}" data-turbo-prefetch="false">${inner}</a></li>`
        : `<li><div class="ph-row ph-summary">${inner}</div></li>`;
    }).join("");
    parts.push(`<ul class="ph-list ph-summaries">${rows}</ul>`);
  }
  if (b.facts.length) {
    const rows = b.facts.map((f) =>
      `<li><a class="ph-row ph-fact" href="${escapeHtml(f.href)}"${f.conversation ? ' data-turbo-prefetch="false"' : ""}><span class="ph-row-title">${escapeHtml(f.title || "#" + f.cardId)}</span><span class="ph-meta">${escapeHtml(factText(f, lang))}</span></a></li>`).join("");
    parts.push(`<p class="ph-sub">${escapeHtml(t("shell.factsSince", lang))}</p><ul class="ph-list ph-facts">${rows}</ul>`);
  }
  if (b.memories.length) {
    const n = b.memories.length;
    const label = fill(n === 1 ? "shell.memoryNotesOne" : "shell.memoryNotes", lang, { n });
    const items = b.memories.map((m) => `<li><a class="ph-row ph-memory" href="/dashboard/memory?edit=${Number(m.id)}"><span class="ph-row-title">${escapeHtml(m.excerpt)}</span></a></li>`).join("");
    parts.push(`<p class="ph-with ph-mem">${escapeHtml(label)} <span aria-hidden="true">·</span> <button type="button" class="ph-change" data-shell-open="ph-memories" aria-haspopup="dialog" aria-controls="ph-memories">${escapeHtml(t("shell.seeThem", lang))}</button></p>
      <dialog id="ph-memories" class="shell-sheet ph-mem-sheet" aria-labelledby="ph-memories-h">
        <div class="shell-sheet-inner">
          <button type="button" class="shell-sheet-close" aria-label="${escapeHtml(t("common.close", lang))}" title="${escapeHtml(t("common.close", lang))}">${CLOSE_SVG}</button>
          <h3 class="shell-heading" id="ph-memories-h">${escapeHtml(t("shell.memorySheet", lang))}</h3>
          <ul class="ph-list">${items}</ul>
        </div>
      </dialog>`);
  }
  return `<section class="ph-section ph-left" aria-labelledby="ph-left-h">${head}${parts.join("")}</section>`;
}

function needsSection(data, project, lang) {
  const n = data.needsYouCount;
  const head = `<h3 class="ph-h">${escapeHtml(t("shell.laneNeedsYou", lang))}</h3>`;
  if (n === null || n === undefined) {
    return `<section class="ph-section ph-needs">${head}<p class="ph-line">${escapeHtml(t("shell.countUnknown", lang))}</p></section>`;
  }
  if (!n && !data.needsYou.length) {
    return `<section class="ph-section ph-needs">${head}<p class="ph-line">${escapeHtml(t("shell.nothingNeedsYou", lang))}</p></section>`;
  }
  // A card's chip names its kind of ask; a waiting session (or a card with none) has no chip.
  const rows = data.needsYou.map((c) => {
    const chip = c.waiting ? `<span class="ph-kind ph-kind--waiting">${escapeHtml(t("shell.waitingChip", lang))}</span>` : KIND_KEY[c.kind] ? `<span class="ph-kind ph-kind--${escapeHtml(c.kind)}">${escapeHtml(t(KIND_KEY[c.kind], lang))}</span>` : "";
    return `<li><a class="ph-row" href="${escapeHtml(c.href)}"${c.waiting || c.conversation ? ' data-turbo-prefetch="false"' : ""}>${chip}<span class="ph-row-title">${escapeHtml(c.title || t("shell.untitledSession", lang))}</span></a></li>`;
  }).join("");
  const label = needsYouLabel(n, lang);
  return `<section class="ph-section ph-needs">${head}
      ${label ? `<p class="ph-sub">${escapeHtml(label)}</p>` : ""}
      ${rows ? `<ul class="ph-list">${rows}</ul>` : ""}
      <a class="ph-link" href="/dashboard/board?project=${encodeURIComponent(project.slug)}">${escapeHtml(t("shell.allOnBoard", lang))}</a>
    </section>`;
}

function sessionsSection(data, project, lang, now) {
  const head = `<h3 class="ph-h">${escapeHtml(t("shell.earlierSessions", lang))}</h3>`;
  if (!data.sessions.length) {
    return `<section class="ph-section ph-earlier">${head}<p class="ph-line">${escapeHtml(t("shell.noSessions", lang))}</p></section>`;
  }
  const rows = data.sessions.map((s) =>
    sessionCardHtml(sessionCardModel({ sessionId: s.threadId, label: s.label, botName: s.botName, lastAt: s.lastAt }, { projectSlug: project.slug }), lang, { now })).join("");
  return `<section class="ph-section ph-earlier">${head}<ul class="ph-list">${rows}</ul></section>`;
}

/** The home page body. */
export function projectHomeHtml(data, project, lang, { now = new Date(), servicesUi = servicesUiEnabled(), req = null } = {}) {
  // The Services link exists only while CROW_SERVICES_UI is on; off, the markup is exactly as before.
  const services = servicesUi
    ? `\n    <nav class="ph-head"><a class="ph-link ph-services" href="/dashboard/project/${encodeURIComponent(project.slug)}/services">${escapeHtml(t("projectHome.services", lang))}</a></nav>`
    : "";
  return `<div class="ph" data-ph data-project-id="${Number(project.id)}" data-project-slug="${escapeHtml(project.slug)}">${services}
    ${noticeHtml(data, lang)}
    ${startControlHtml(data, lang, { projectId: Number(project.id), projectSlug: project.slug })}
    ${botsSection(data, project, lang, req)}
    ${leftOffSection(data, project, lang, now)}
    ${needsSection(data, project, lang)}
    ${sessionsSection(data, project, lang, now)}
  </div>`;
}

/** The 404 body: an unknown or archived slug. "Back to projects" opens the drawer. */
export function projectMissingHtml(lang) {
  return `<div class="ph ph-missing">
    <p class="ph-line">${escapeHtml(t("shell.projectMissing", lang))}</p>
    <button type="button" class="ph-start-btn" data-shell-open="shell-drawer" aria-haspopup="dialog" aria-controls="shell-drawer">${escapeHtml(t("shell.backToProjects", lang))}</button>
  </div>`;
}

/** The 403 body: a POST by someone who may not change this project. */
export function projectForbiddenHtml(lang) {
  return `<div class="ph ph-missing"><p class="ph-line" role="alert">${escapeHtml(t("projectHome.forbidden", lang))}</p></div>`;
}
