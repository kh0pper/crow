/**
 * The project Services page's markup (project services Task 10): a header (the project, the
 * title, + Add), "Connected in this project" (one row per connection: an icon tile, the service,
 * its account name and when it was last tested, a status pill, and a menu with Test again and
 * Disconnect), the note (the owner-only line always, decision 1; the members line only when the
 * project has members), "Also on your Crow" when other projects have services this one doesn't,
 * and the empty state.
 *
 * No value is ever rendered: a row shows the account name, never a field. Every operator- or
 * service-supplied string goes through escapeHtml.
 *
 * Each row also carries the owner's "Private" switch (Task 16c): the connection's effective
 * sensitivity (on = bots can't read it yet), disabled with the "always private" note for a locked
 * service. A missing or malformed `private` reads as on (fail closed). The client posts it. The copy is the plan's exact copy; nothing
 * here says bots use a connection yet (botsLive is false until the PR that makes them).
 */

import { escapeHtml } from "../../shared/components.js";
import { fill, t } from "../../shared/i18n.js";
import { relativeDay } from "../project-home/data.js";

const PILL_STATUSES = new Set(["active", "needs_reauth", "error", "needs_install", "disconnected", "not_tested"]);

/** "today" / "yesterday" (lower-cased: it follows "Tested"), a weekday or a short date. */
function testedWhen(when, lang, now) {
  const rd = relativeDay(when, { now, lang });
  if (!rd) return "";
  if (rd.key) {
    const s = t(rd.key, lang);
    return s.charAt(0).toLowerCase() + s.slice(1);
  }
  return rd.text;
}

/** "A and B" / "A y B", in the page's language (Intl, no extra copy). */
function joinNames(names, lang) {
  try {
    return new Intl.ListFormat(lang === "es" ? "es" : "en", { style: "long", type: "conjunction" }).format(names);
  } catch {
    return names.join(", ");
  }
}

/**
 * {name} placeholders filled in ONE pass, so a value that itself holds "{project}" (an account
 * label is free text) is inserted verbatim and never substituted again.
 */
function fillOnce(str, params) {
  return String(str).replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(params, k) ? String(params[k]) : m));
}

function iconLetter(name) {
  const c = String(name || "?").trim().charAt(0);
  return c ? c.toUpperCase() : "?";
}

/** The Private switch: checked = private; a locked service is checked and disabled. */
function privateSwitch(c, lang) {
  const p = c.private && typeof c.private === "object" ? c.private : {};
  const on = p.on !== false;
  const locked = p.locked === true;
  const note = locked ? t("services.private.locked", lang) : on ? t("services.private.on", lang) : "";
  return `<span class="svc-private">
          <label class="svc-private-switch"><input type="checkbox" data-svc-private${on ? " checked" : ""}${locked ? " disabled" : ""}> <span>${escapeHtml(t("services.private.label", lang))}</span></label>
          <span class="svc-private-note" data-svc-private-note>${escapeHtml(note)}</span>
        </span>`;
}

function connectionRow(c, project, lang, now) {
  const status = PILL_STATUSES.has(c.status) ? c.status : "error";
  const when = c.lastTestedAt ? testedWhen(c.lastTestedAt, lang, now) : "";
  const sub = [c.accountLabel, when ? fill(t("services.tested", lang), { when }) : ""].filter(Boolean).join(" · ");
  const confirm = fillOnce(t("services.disconnect.confirm", lang), { service: c.name, label: c.accountLabel, project: project.name });
  const retest = status === "needs_install"
    ? ""
    : `<button type="button" class="svc-menu-item" data-svc-retest>${escapeHtml(t("services.retest", lang))}</button>`;
  return `<li class="svc-row" data-svc-row data-uuid="${escapeHtml(c.uuid)}" data-service="${escapeHtml(c.serviceId)}">
        <span class="svc-icon" aria-hidden="true">${escapeHtml(iconLetter(c.name))}</span>
        <span class="svc-text"><span class="svc-name">${escapeHtml(c.name)}</span>${sub ? `<span class="svc-sub">${escapeHtml(sub)}</span>` : ""}${privateSwitch(c, lang)}</span>
        <span class="svc-pill svc-pill--${status}">${escapeHtml(t(`services.status.${status}`, lang))}</span>
        <details class="svc-menu">
          <summary aria-label="${escapeHtml(`${c.name} (${c.accountLabel})`)}"><span aria-hidden="true">&#8943;</span></summary>
          <div class="svc-menu-list">
            ${retest}
            <button type="button" class="svc-menu-item svc-menu-item--danger" data-svc-disconnect data-confirm="${escapeHtml(confirm)}">${escapeHtml(t("services.disconnect", lang))}</button>
          </div>
        </details>
      </li>`;
}

/**
 * The page body.
 * @param {object} page loadServicesPage's payload
 * @param {string} lang
 * @param {{now?: Date}} [opts]
 */
export function projectServicesHtml(page, lang, { now = new Date() } = {}) {
  const { project, connections = [], hasMembers = false, alsoOnCrow = [] } = page;
  const rows = connections.map((c) => connectionRow(c, project, lang, now)).join("");
  const connected = rows
    ? `<ul class="svc-list">${rows}</ul>`
    : `<p class="svc-empty">${escapeHtml(t("services.empty", lang))}</p>`;
  const members = hasMembers ? `<p class="svc-members">${escapeHtml(t("services.members.line", lang))}</p>` : "";
  const also = alsoOnCrow.length
    ? `<section class="svc-section svc-also">
      <h3 class="svc-label">${escapeHtml(t("services.section.also", lang))}</h3>
      <p class="svc-also-line">${escapeHtml(fill(t(alsoOnCrow.length === 1 ? "services.also.lineOne" : "services.also.line", lang), { names: joinNames(alsoOnCrow.map((s) => s.name), lang) }))} <button type="button" class="svc-inline" data-svc-add>${escapeHtml(t("services.also.add", lang))}</button></p>
    </section>`
    : "";
  return `<div class="svc" data-svc data-project-slug="${escapeHtml(project.slug)}">
    <header class="svc-head">
      <div class="svc-head-text">
        <a class="svc-project" href="/dashboard/project/${encodeURIComponent(project.slug)}">${escapeHtml(project.name)}</a>
        <p class="svc-title" aria-hidden="true">${escapeHtml(t("services.page.title", lang))}</p>
      </div>
      <button type="button" class="svc-add" data-svc-add>${escapeHtml(t("services.page.add", lang))}</button>
    </header>
    <section class="svc-section svc-connected">
      <h3 class="svc-label">${escapeHtml(t("services.section.connected", lang))}</h3>
      ${connected}
    </section>
    <div class="svc-note">
      <p class="svc-owner-only">${escapeHtml(t("services.ownerOnly.line", lang))}</p>
      ${members}
    </div>
    ${also}
    <p class="svc-status" role="status" aria-live="polite" data-svc-status></p>
  </div>`;
}
