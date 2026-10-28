/**
 * The project home's markup: Start a session (with the lead, and a per-session
 * bot pick), Needs you (up to three rows, then All on Board) and Earlier
 * sessions. No session state, id or model is ever shown: a session is its
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
      <button type="button" class="ph-start-btn" data-ph-start data-bot="${escapeHtml(lead.id)}">${escapeHtml(t("shell.startSession", lang))}</button>
      <p class="ph-with">${escapeHtml(t("shell.with", lang))} <strong data-ph-lead-name>${escapeHtml(lead.name)}</strong>${many
        ? ` <span aria-hidden="true">·</span> <button type="button" class="ph-change" data-ph-change aria-expanded="false" aria-controls="ph-pick">${escapeHtml(t("shell.changeLead", lang))}</button>`
        : ""}</p>
      ${many ? `<label class="ph-pick" id="ph-pick" hidden><span>${escapeHtml(t("shell.leadPick", lang))}</span><select data-ph-bot>${options}</select></label>` : ""}
      <p class="ph-status" role="status" aria-live="polite" data-ph-status></p>
    </section>`;
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
    return `<li><a class="ph-row" href="${escapeHtml(c.href)}"${c.waiting ? ' data-turbo-prefetch="false"' : ""}>${chip}<span class="ph-row-title">${escapeHtml(c.title || t("shell.untitledSession", lang))}</span></a></li>`;
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
