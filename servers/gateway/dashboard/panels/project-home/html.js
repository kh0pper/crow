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

const KIND_KEY = Object.freeze({ decision: "shell.kindDecision", review: "shell.kindReview", question: "shell.kindQuestion" });

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
/** t(key) with {name} filled; split/join, so a "$" in a value is never a replace pattern. */
const fill = (key, lang, vals) => Object.entries(vals).reduce((out, [k, v]) => out.split("{" + k + "}").join(String(v ?? "")), t(key, lang));
const CLOSE_SVG = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M18 6L6 18M6 6l12 12"/></svg>';

function startSection(data, lang) {
  const { lead, bots } = data;
  if (!lead) {
    return `<section class="ph-section ph-start">
      <p class="ph-line">${escapeHtml(t("shell.noProjectBots", lang))}</p>
      <a class="ph-link" href="/dashboard/bot-builder">${escapeHtml(t("shell.makeBot", lang))}</a>
    </section>`;
  }
  const many = bots.length > 1;
  const options = bots.map((b) => `<option value="${escapeHtml(b.id)}"${b.id === lead.id ? " selected" : ""}>${escapeHtml(b.name)}</option>`).join("");
  return `<section class="ph-section ph-start">
      <button type="button" class="ph-start-btn"${data.briefing && !data.briefing.empty ? " data-ph-briefing" : ""} data-ph-start data-bot="${escapeHtml(lead.id)}">${escapeHtml(t("shell.startSession", lang))}</button>
      <p class="ph-with">${escapeHtml(t("shell.with", lang))} <strong data-ph-lead-name>${escapeHtml(lead.name)}</strong>${many
        ? ` <span aria-hidden="true">·</span> <button type="button" class="ph-change" data-ph-change aria-expanded="false" aria-controls="ph-pick">${escapeHtml(t("shell.changeLead", lang))}</button>`
        : ""}</p>
      ${many ? `<label class="ph-pick" id="ph-pick" hidden><span>${escapeHtml(t("shell.leadPick", lang))}</span><select data-ph-bot>${options}</select></label>` : ""}
      <p class="ph-status" role="status" aria-live="polite" data-ph-status></p>
    </section>`;
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
  const rows = data.sessions.map((s) => {
    const rd = relativeDay(s.lastAt, { now, lang });
    const when = rd ? (rd.key ? t(rd.key, lang) : cap(rd.text)) : "";
    const meta = [s.botName, when].filter(Boolean).join(" · ");
    return `<li><a class="ph-row ph-session" href="/dashboard/perch?project=${encodeURIComponent(project.slug)}#${encodeURIComponent(s.threadId)}" data-turbo-prefetch="false"><span class="ph-row-title">${escapeHtml(s.label || t("shell.untitledSession", lang))}</span>${meta ? `<span class="ph-meta">${escapeHtml(meta)}</span>` : ""}</a></li>`;
  }).join("");
  return `<section class="ph-section ph-earlier">${head}<ul class="ph-list">${rows}</ul></section>`;
}

/** The home page body. */
export function projectHomeHtml(data, project, lang, { now = new Date() } = {}) {
  return `<div class="ph" data-ph data-project-id="${Number(project.id)}" data-project-slug="${escapeHtml(project.slug)}">
    ${startSection(data, lang)}
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
