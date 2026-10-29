/**
 * Session cards and the "Start a session" control: one component, used by
 * the project home (panels/project-home, rendered on the server) and by the
 * Chat tab in new mode (perch-hub, rendered in the browser from /roost).
 *
 * A session card is its title (the session's label, else its first message,
 * else "Untitled session"), its bot, its project when the page is not
 * already that project's, and a relative day. Never a session id, a state
 * word or a model: a running session shows a small live dot (with a
 * visually hidden "Live"), a session waiting on you a "Waiting" chip. The
 * whole card is a link that opens the session.
 *
 *   sessionCardModel(row, opts)   the card's data. ONE function for both
 *                                 pages: the browser runs this function's own
 *                                 source (sessionCardsJs splices it in), so it
 *                                 is ES5 with no backslash, backtick or
 *                                 dollar-brace (tests/session-cards.test.js).
 *   sessionCardHtml(m, lang)      the server's card (the project home).
 *   sessionCardsJs(lang)          the browser's card builder (the Chat tab),
 *                                 spliced inside the Perch client's IIFE. It
 *                                 builds the same elements and classes.
 *   startControlHtml(data, lang)  "Start a session" with the lead and the
 *                                 per-session bot pick (no model, no options:
 *                                 those live behind the session's details).
 *   startControlJs(lang)          its <script>: POST
 *                                 /dashboard/perch-api/bots/:id/interactive.
 *   sessionUiCss(prefix)          the shared styles, under the page's prefix.
 */

import { escapeHtml } from "./components.js";
import { t, tJs } from "./i18n.js";
import { relativeDay } from "../panels/project-home/data.js";

/**
 * The card's data from one session row.
 *   row  { sessionId, label, firstMessage?, botName, state?, pendingUi?, lastAt }
 *   opts { projectName, projectSlug }  projectName is shown on the card (null
 *        when the page is already that project's); projectSlug, when set,
 *        makes the link carry the project (/dashboard/perch?project=<slug>#sid),
 *        otherwise the link opens the session in place (#sid).
 * Returns { sessionId, title, botName, projectName, lastAt, live, waiting, href };
 * title is null when the session has neither a label nor a first message;
 * a first message is one line, capped at 80 characters.
 */
export function sessionCardModel(row, opts) {
  var r = row || {};
  var o = opts || {};
  var sid = r.sessionId == null ? "" : String(r.sessionId);
  var label = r.label == null ? "" : String(r.label).trim();
  var first = r.firstMessage == null ? "" : String(r.firstMessage).split(String.fromCharCode(10)).join(" ").trim();
  if (first.length > 80) first = first.slice(0, 79).trim() + String.fromCharCode(8230);
  var title = label || first || null;
  var slug = o.projectSlug == null ? "" : String(o.projectSlug);
  return {
    sessionId: sid,
    title: title,
    botName: r.botName == null ? "" : String(r.botName),
    projectName: o.projectName ? String(o.projectName) : null,
    lastAt: r.lastAt == null ? null : String(r.lastAt),
    live: !r.pendingUi && (r.state === "awake" || r.state === "waking"),
    waiting: !!r.pendingUi,
    href: slug
      ? "/dashboard/perch?project=" + encodeURIComponent(slug) + "#" + encodeURIComponent(sid)
      : "#" + encodeURIComponent(sid),
  };
}

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** The server's day text for a card (the project home's relativeDay). */
function dayText(lastAt, lang, now) {
  const rd = relativeDay(lastAt, { now, lang });
  return rd ? (rd.key ? t(rd.key, lang) : cap(rd.text)) : "";
}

/** One card, as the project home renders it (an <li>). */
export function sessionCardHtml(m, lang, { now = new Date() } = {}) {
  const chip = m.waiting ? `<span class="ph-kind ph-kind--waiting">${escapeHtml(t("shell.waitingChip", lang))}</span>` : "";
  const dot = m.live ? `<span class="ph-live"><span class="ph-vh">${escapeHtml(t("shell.liveSession", lang))}</span></span>` : "";
  const meta = [m.botName, m.projectName, dayText(m.lastAt, lang, now)].filter(Boolean).join(" · ");
  const prefetch = m.href.charAt(0) === "#" ? "" : ' data-turbo-prefetch="false"';
  return `<li><a class="ph-row ph-session" href="${escapeHtml(m.href)}"${prefetch}>${chip}${dot}<span class="ph-row-title">${escapeHtml(m.title || t("shell.untitledSession", lang))}</span>${meta ? `<span class="ph-meta">${escapeHtml(meta)}</span>` : ""}</a></li>`;
}

/**
 * The browser's card builder, spliced INSIDE the Perch client's IIFE. It
 * defines sessionCardModel (this module's own function, by its source) and
 * scCardEl(model, whenText): an <li class="ph-card"> holding the same link
 * sessionCardHtml renders. The caller appends the card's menu.
 * Emitted inside a template literal: no backtick and no dollar-brace in the
 * code below; only the tJs interpolations.
 */
export function sessionCardsJs(lang = "en") {
  return `
  /* ---- session cards (shared/session-cards.js) ---------------------------- */
  var SC_UNTITLED='${tJs("shell.untitledSession", lang)}';
  var SC_WAITING='${tJs("shell.waitingChip", lang)}';
  var SC_LIVE='${tJs("shell.liveSession", lang)}';
  ${sessionCardModel.toString()}
  function scSpan(cls,text){ var s=document.createElement('span'); s.className=cls; s.textContent=text==null?'':String(text); return s; }
  function scCardEl(m,whenText){
    var li=document.createElement('li'); li.className='ph-card';
    var a=document.createElement('a'); a.className='ph-row ph-session'; a.href=m.href;
    if(m.href.charAt(0)!=='#') a.setAttribute('data-turbo-prefetch','false');
    if(m.sessionId) a.setAttribute('data-sid',m.sessionId);
    if(m.waiting) a.appendChild(scSpan('ph-kind ph-kind--waiting',SC_WAITING));
    if(m.live){ var dot=scSpan('ph-live',''); dot.appendChild(scSpan('ph-vh',SC_LIVE)); a.appendChild(dot); }
    a.appendChild(scSpan('ph-row-title',m.title||SC_UNTITLED));
    var meta=[m.botName,m.projectName,whenText].filter(Boolean).join(' \\u00b7 ');
    if(meta) a.appendChild(scSpan('ph-meta',meta));
    li.appendChild(a);
    return li;
  }
`;
}

/**
 * "Start a session": the lead, and a per-session bot pick when there is
 * more than one bot. data: { lead, bots, briefing? }.
 * opts: { projectId, projectSlug, inPlace, emptyKey }
 *   projectId   sent as project_id ("unassigned" or a number; omitted when null)
 *   projectSlug where the new session opens (/dashboard/perch?project=<slug>#sid)
 *   inPlace     the page is Perch itself: open the new session by its hash
 *   emptyKey    the line shown with no bot (the project's, or Perch's)
 */
export function startControlHtml(data, lang, { projectId = null, projectSlug = "", inPlace = false, emptyKey = "shell.noProjectBots" } = {}) {
  const { lead, bots } = data;
  if (!lead) {
    return `<section class="ph-section ph-start">
      <p class="ph-line">${escapeHtml(t(emptyKey, lang))}</p>
      <a class="ph-link" href="/dashboard/bot-builder">${escapeHtml(t("shell.makeBot", lang))}</a>
    </section>`;
  }
  const many = bots.length > 1;
  const options = bots.map((b) => `<option value="${escapeHtml(b.id)}"${b.id === lead.id ? " selected" : ""}>${escapeHtml(b.name)}</option>`).join("");
  const attrs = [
    projectId == null ? "" : ` data-project-id="${escapeHtml(String(projectId))}"`,
    projectSlug ? ` data-project-slug="${escapeHtml(projectSlug)}"` : "",
    inPlace ? " data-ph-in-place" : "",
  ].join("");
  return `<section class="ph-section ph-start" data-ph-start-root${attrs}>
      <button type="button" class="ph-start-btn"${data.briefing && !data.briefing.empty ? " data-ph-briefing" : ""} data-ph-start data-bot="${escapeHtml(lead.id)}">${escapeHtml(t("shell.startSession", lang))}</button>
      <p class="ph-with">${escapeHtml(t("shell.with", lang))} <strong data-ph-lead-name>${escapeHtml(lead.name)}</strong>${many
        ? ` <span aria-hidden="true">·</span> <button type="button" class="ph-change" data-ph-change aria-expanded="false" aria-controls="ph-pick">${escapeHtml(t("shell.changeLead", lang))}</button>`
        : ""}</p>
      ${many ? `<label class="ph-pick" id="ph-pick" hidden><span>${escapeHtml(t("shell.leadPick", lang))}</span><select data-ph-bot>${options}</select></label>` : ""}
      <p class="ph-status" role="status" aria-live="polite" data-ph-status></p>
    </section>`;
}

/**
 * The start control's client: "change" shows the bot pick (for this session
 * only), and "Start a session" POSTs /dashboard/perch-api/bots/<id>/interactive
 * with { project_id } when the control names one (plus briefing: true when
 * "Where you left off" has anything: the server rebuilds the briefing itself,
 * so no text is sent) and the dashboard CSRF token (X-Crow-Csrf), then opens
 * the session: by its hash on Perch itself (data-ph-in-place), else at
 * /dashboard/perch?project=<slug>#<sessionId> (or /dashboard/perch#<id>).
 *
 * Returned as a <script> string, so it is a TEMPLATE LITERAL: it must contain
 * NO backticks and no dollar-brace sequences other than the tJs strings below.
 * It re-runs on every Turbo visit and binds only to this page's elements.
 */
export function startControlJs(lang = "en") {
  return `<script>
(function () {
  var root = document.querySelector('[data-ph-start-root]');
  if (!root) return;
  var btn = root.querySelector('[data-ph-start]');
  if (!btn) return;
  var T_FAILED = '${tJs("perch.startFailed", lang)}';
  var T_ENGINE = '${tJs("perch.engineRequired", lang)}';
  var T_NOT_ATTACHED = '${tJs("perch.notAttached", lang)}';
  var sel = root.querySelector('[data-ph-bot]');
  var pick = root.querySelector('.ph-pick');
  var change = root.querySelector('[data-ph-change]');
  var nameEl = root.querySelector('[data-ph-lead-name]');
  var status = root.querySelector('[data-ph-status]');
  var rawPid = root.getAttribute('data-project-id');
  var pid = rawPid === 'unassigned' ? 'unassigned' : (rawPid ? Number(rawPid) : null);
  var slug = root.getAttribute('data-project-slug') || '';
  var inPlace = root.hasAttribute('data-ph-in-place');
  var busy = false;

  function csrf() {
    var parts = document.cookie.split(';');
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].trim().split('=');
      if (kv[0] === 'crow_csrf') return decodeURIComponent(kv.slice(1).join('='));
    }
    return '';
  }
  function say(text) { if (status) status.textContent = text || ''; }
  function fail(text) { busy = false; btn.removeAttribute('disabled'); say(text); }

  if (change && pick) change.addEventListener('click', function () {
    var show = pick.hasAttribute('hidden');
    if (show) pick.removeAttribute('hidden'); else pick.setAttribute('hidden', '');
    change.setAttribute('aria-expanded', show ? 'true' : 'false');
    if (show && sel) sel.focus();
  });
  if (sel) sel.addEventListener('change', function () {
    var o = sel.options[sel.selectedIndex];
    if (!o) return;
    btn.setAttribute('data-bot', o.value);
    if (nameEl) nameEl.textContent = o.textContent;
  });

  btn.addEventListener('click', function () {
    if (busy) return;
    busy = true; btn.setAttribute('disabled', ''); say('');
    var body = {};
    if (pid !== null) body.project_id = pid;
    if (btn.hasAttribute('data-ph-briefing')) body.briefing = true;
    fetch('/dashboard/perch-api/bots/' + encodeURIComponent(btn.getAttribute('data-bot')) + '/interactive', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Crow-Csrf': csrf() },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, j: j }; });
    }).then(function (x) {
      var sid = x.j && (x.j.sessionId || x.j.threadId);
      if (x.status >= 200 && x.status < 300 && sid) {
        if (inPlace) { busy = false; btn.removeAttribute('disabled'); location.hash = encodeURIComponent(sid); return; }
        location.href = '/dashboard/perch' + (slug ? '?project=' + encodeURIComponent(slug) : '') + '#' + encodeURIComponent(sid);
        return;
      }
      var err = x.j && x.j.error;
      fail(err === 'engine_required' ? T_ENGINE : err === 'perch_not_attached' ? T_NOT_ATTACHED : T_FAILED);
    }, function () { fail(T_FAILED); });
  });
})();
</script>`;
}

/**
 * The shared styles: the start control, the list, a card, the live dot and
 * the card's menu. Every rule sits under prefix: "body.shell" on the project
 * home; "body.shell #perch-list" on the Chat tab, which both outweighs
 * Perch's own "#perch-hub-root button" rules and keeps these off the
 * transcript's cards (the phone card has its own .ph-* classes).
 * Phone first (390 px): every target at least 44 px. Colours and radii are
 * the Track 2 --crow-* tokens.
 *
 * NOTE: never write a literal closing style tag inside a comment here.
 */
export function sessionUiCss(prefix = "body.shell") {
  const p = prefix;
  return `
  ${p} .ph-section { min-width: 0; }
  ${p} .ph-h { margin: 0 0 8px; font-size: 0.95rem; font-weight: 600; color: var(--crow-text-primary); text-transform: none; letter-spacing: normal; }
  ${p} .ph-line { margin: 0 0 8px; color: var(--crow-text-secondary); overflow-wrap: anywhere; }
  ${p} .ph-sub { margin: 0 0 8px; font-size: 0.85rem; color: var(--crow-text-secondary); }
  ${p} .ph-start-btn {
    display: inline-flex; align-items: center; justify-content: center;
    min-height: 48px; min-width: 44px; padding: 0 20px; max-width: 100%;
    border: 0; border-radius: var(--crow-radius-control, 10px);
    background: var(--crow-accent); color: var(--crow-accent-contrast);
    font: inherit; font-weight: 600; cursor: pointer;
  }
  ${p} .ph-start-btn[disabled] { opacity: 0.6; cursor: progress; }
  ${p} .ph-with { display: flex; flex-wrap: wrap; align-items: center; gap: 0 0.35rem; margin: 6px 0 0; color: var(--crow-text-secondary); min-height: 44px; overflow-wrap: anywhere; }
  ${p} .ph-with strong { color: var(--crow-text-primary); font-weight: 600; }
  ${p} .ph-change {
    display: inline-flex; align-items: center; min-height: 44px; min-width: 44px; padding: 0 6px;
    border: 0; border-radius: 0; background: none; font: inherit; color: var(--crow-accent); cursor: pointer; text-decoration: underline;
  }
  ${p} .ph-pick { display: flex; flex-direction: column; gap: 4px; margin: 4px 0 0; font-size: 0.85rem; color: var(--crow-text-secondary); }
  ${p} .ph-pick[hidden] { display: none; }
  ${p} .ph-pick select {
    min-height: 44px; max-width: 100%; padding: 0 10px; font: inherit; font-size: 1rem;
    border: 1px solid var(--crow-border); border-radius: var(--crow-radius-control, 10px);
    background: var(--crow-bg-surface); color: var(--crow-text-primary);
  }
  ${p} .ph-status { margin: 6px 0 0; font-size: 0.85rem; color: var(--crow-text-secondary); }
  ${p} .ph-status:empty { display: none; }
  ${p} .ph-list { list-style: none; margin: 0 0 8px; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  ${p} .ph-list[hidden] { display: none; }
  ${p} .ph-row {
    display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px;
    min-height: 44px; padding: 8px 12px; box-sizing: border-box;
    border: 1px solid var(--crow-border); border-radius: var(--crow-radius-card, 12px);
    background: var(--crow-bg-surface); color: var(--crow-text-primary); text-decoration: none;
  }
  ${p} a.ph-row:hover { border-color: var(--crow-accent); }
  ${p} .ph-row-title { flex: 1 1 12rem; min-width: 0; overflow-wrap: anywhere; }
  ${p} .ph-meta { font-size: 0.8rem; color: var(--crow-text-secondary); overflow-wrap: anywhere; }
  ${p} .ph-kind {
    flex: none; padding: 2px 8px; border-radius: var(--crow-radius-pill, 999px);
    font-size: 0.75rem; font-weight: 600; background: var(--crow-accent-muted); color: var(--crow-accent);
  }
  ${p} .ph-link {
    display: inline-flex; align-items: center; min-height: 44px; min-width: 44px; padding: 0 4px;
    color: var(--crow-accent); font-weight: 600; text-decoration: none;
  }
  ${p} .ph-link:hover { text-decoration: underline; }
  ${p} .ph-start-btn:focus-visible, ${p} .ph-change:focus-visible,
  ${p} .ph-row:focus-visible, ${p} .ph-link:focus-visible,
  ${p} .ph-card-more:focus-visible,
  ${p} .ph-pick select:focus-visible { outline: 2px solid var(--crow-accent); outline-offset: 2px; }
  /* A running session: a small dot; its "Live" is for screen readers. */
  ${p} .ph-live { flex: none; position: relative; width: 8px; height: 8px; border-radius: 50%; background: var(--crow-success, var(--crow-accent)); }
  ${p} .ph-vh {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; border: 0;
  }
  /* A card with a menu: the link fills the row, "…" beside it, the menu
     opens below the card. */
  ${p} .ph-card { display: flex; flex-wrap: wrap; align-items: stretch; gap: 6px; min-width: 0; }
  ${p} .ph-card > .ph-row { flex: 1 1 0; min-width: 0; }
  ${p} .ph-card-more {
    flex: none; min-width: 44px; min-height: 44px; padding: 0 10px;
    border: 1px solid var(--crow-border); border-radius: var(--crow-radius-card, 12px);
    background: var(--crow-bg-surface); color: var(--crow-text-secondary);
    font: inherit; font-size: 1.1rem; line-height: 1; cursor: pointer;
  }
  ${p} .ph-card-more.ph-card-text { font-size: 0.9rem; }
  ${p} .ph-card .roost-menu { flex: 1 1 100%; }
  /* Perch's Archived toggle, in sentence case like the rest of the list. */
  ${p} .archived-toggle { text-transform: none; letter-spacing: normal; font-size: 0.85rem; }
  ${p} .ph-card .roost-menu button { min-height: 44px; padding: 0 12px; }
`;
}
