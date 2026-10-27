/**
 * Schedule panel: the page (problems strip, toolbar, agenda, one detail) and the create sheet.
 * Pure HTML from the model schedule-catalog.js builds plus a few page flags (schedule.js); no
 * file or DB access here. Every POST form carries the CSRF field, so it works without JS too.
 *
 * Layout (the Skills page's pattern): one `.sc-detail` at most, rendered inside its row's <li>.
 * On a phone it sits under the row; at ≥ 769px CSS pins it as a side pane (css.js).
 *
 * Read-only rows (the box hold, box ledger windows, machine timers) render as plain text with a
 * "read-only" label: no link, no detail, no form. Their fixes in the strip are links or copy
 * buttons; a copy button only puts text on the clipboard, and the text is always on the page
 * too (selectable without JS).
 */
import { escapeHtml } from "../../shared/components.js";
import { checkCommand } from "../../../schedule-sources/host-timers.js";
import { describeCron } from "../../../../shared/schedule-words.js";
import { t, fill } from "../../shared/i18n.js";
import { localYmd, dayNum, fromDayNum, fmtYmd } from "../../../../shared/relative-dates.js";

const esc = (v) => escapeHtml(v === null || v === undefined ? "" : String(v));
const ROUTE = "/dashboard/schedule";
const href = (params) => esc(ROUTE + (params ? "?" + params : ""));
const qs = (o) => Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
const vh = (s) => `<span class="sc-vh"> ${esc(s)}</span>`;
const NEWS_BRIEFINGS = "/dashboard/media?tab=briefings";

const locale = (lang) => (lang === "es" ? "es-ES" : "en-US");
const SPACES = /[  ]/g;
function fmt(ms, zone, lang, opts) {
  return new Intl.DateTimeFormat(locale(lang), { ...opts, timeZone: zone }).format(new Date(ms)).replace(SPACES, " ");
}
const TIME = { hour: "numeric", minute: "2-digit" };
const DAY_TIME = { weekday: "short", hour: "numeric", minute: "2-digit" };
const DATE_TIME = { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
const timeTag = (ms, text) => `<time datetime="${esc(new Date(ms).toISOString())}">${esc(text)}</time>`;
const zoneShort = (ms, zone, lang) => {
  const p = new Intl.DateTimeFormat(locale(lang), { timeZone: zone, timeZoneName: "short" }).formatToParts(new Date(ms)).find((x) => x.type === "timeZoneName");
  return p ? p.value : zone;
};

/** The words for an item's title (the briefing has no task text of its own). */
function itemTitle(it, lang) {
  if (it.kind === "briefing") return t("schedule.briefingTitle", lang);
  return it.title || t("schedule.untitled", lang);
}

const TYPE = {
  reminder: ["schedule.type.reminder", "accent"],
  bot_routine: ["schedule.type.botRoutine", "info"],
  briefing: ["schedule.type.briefing", "plain"],
  system: ["schedule.type.system", "muted"],
  box_hold: ["schedule.type.boxHold", "muted"],
  box_window: ["schedule.type.boxWindow", "muted"],
  host_timer: ["schedule.type.machineTimer", "muted"],
};
const LOCK = `<svg class="sc-lock" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false"><path fill="currentColor" d="M5 7V5a3 3 0 0 1 6 0v2h.5A1.5 1.5 0 0 1 13 8.5v5A1.5 1.5 0 0 1 11.5 15h-7A1.5 1.5 0 0 1 3 13.5v-5A1.5 1.5 0 0 1 4.5 7H5Zm1.5 0h3V5a1.5 1.5 0 0 0-3 0v2Z"/></svg>`;
const roLabel = (lang) => `<span class="sc-ro-label">${LOCK}${esc(t("schedule.readOnly", lang))}</span>`;
const typeChip = (it, lang) => `<span class="sc-chip sc-chip-${TYPE[it.kind][1]}">${esc(t(TYPE[it.kind][0], lang))}</span>`;
const zoneChip = (it, ms, lang) => (it.zoneDiffers ? `<span class="sc-chip sc-chip-plain" title="${esc(it.zone)}">${esc(zoneShort(ms ?? Date.now(), it.zone, lang))}</span>` : "");

/** "Every weekday at 8:00 AM" / "Once" / "Custom schedule". */
function cadenceText(it, lang) {
  if (it.once) return t("schedule.once", lang);
  return it.summary || t("schedule.custom", lang);
}

function csrf(m) { return `<input type="hidden" name="_csrf" value="${esc(m.csrf)}">`; }

/** A POST button (a real form: works without JS and through Turbo's CSRF header). */
function postButton(m, action, fields, label, { cls = "btn btn-secondary", ctx = "" } = {}) {
  const inputs = Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("");
  return `<form method="POST" action="${ROUTE}" class="sc-inline-form">${csrf(m)}<input type="hidden" name="action" value="${esc(action)}">${inputs}<button type="submit" class="${cls}">${esc(label)}${ctx ? vh(ctx) : ""}</button></form>`;
}

/** The pause/resume switch: role=switch, on = running. */
function switchForm(m, it) {
  const on = it.enabled;
  const title = itemTitle(it, m.lang);
  return `<form method="POST" action="${ROUTE}" class="sc-switch-form">${csrf(m)}<input type="hidden" name="action" value="${on ? "pause" : "resume"}"><input type="hidden" name="id" value="${esc(it.id)}">` +
    `<button type="submit" class="sc-switch" role="switch" aria-checked="${on ? "true" : "false"}" aria-label="${esc(fill(t("schedule.switchLabel", m.lang), { name: title }))}"><span class="sc-switch-track" aria-hidden="true"></span><span class="sc-switch-text">${esc(t(on ? "schedule.on" : "schedule.paused", m.lang))}</span></button></form>`;
}

// ---------------------------------------------------------------- strip

function missedText(run, zone, lang) {
  const count = Number(run.missed_count || 1);
  let detail = {};
  try { detail = JSON.parse(run.detail || "{}") || {}; } catch {}
  const first = Date.parse(run.scheduled_for);
  const last = Date.parse(detail.last_missed || run.scheduled_for);
  if (count > 1 && Number.isFinite(first) && Number.isFinite(last)) {
    return fill(t(detail.capped ? "schedule.missedManyCapped" : "schedule.missedMany", lang), { n: count, first: fmt(first, zone, lang, DAY_TIME), last: fmt(last, zone, lang, DAY_TIME) });
  }
  return Number.isFinite(first) ? fill(t("schedule.missedOne", lang), { when: fmt(first, zone, lang, DAY_TIME) }) : t("schedule.missedOneBare", lang);
}

function problemText(p, m) {
  const { lang } = m;
  const it = p.item;
  const name = it ? itemTitle(it, lang) : null;
  switch (p.code) {
    case "missed": return [name, missedText(p.run, it.zone, lang)];
    case "failed": {
      let err = null;
      if (p.run) { try { err = (JSON.parse(p.run.detail || "{}") || {}).error || null; } catch {} err = err || p.run.job_error || null; }
      if (p.job) err = p.job.error || null;
      return [name, err ? fill(t("schedule.p.failedWhy", lang), { error: String(err).slice(0, 200) }) : t("schedule.p.failed", lang)];
    }
    case "reminders-off": return [t("schedule.p.remindersOffTitle", lang), t("schedule.p.remindersOff", lang)];
    case "engine-missing": return [t("schedule.p.botsCantRunTitle", lang), t("schedule.p.engineMissing", lang)];
    case "runtime-off": return [t("schedule.p.botsCantRunTitle", lang), t("schedule.p.runtimeOff", lang)];
    case "cant-run": return [name, t(`schedule.p.cant.${p.why}`, lang)];
    case "no-runner": return [name, fill(t("schedule.p.noRunner", lang), { when: fmt(it.nextRun, it.zone, lang, DAY_TIME) })];
    case "paused-upgrade": {
      let d = {};
      try { d = JSON.parse(p.run.detail || "{}") || {}; } catch {}
      return [name, d.reason === "frequent" ? fill(t("schedule.p.pausedFrequent", lang), { n: d.every_min ?? "?" }) : t("schedule.p.pausedSystem", lang)];
    }
    case "no-next": return [name, fill(t("schedule.p.noNext", lang), { cron: it.cron })];
    case "hold-corrupt": return [t("schedule.p.holdCorruptTitle", lang), t("schedule.p.holdCorrupt", lang)];
    case "ledger-stale": return [
      p.count === 1 ? t("schedule.p.ledgerStale1Title", lang) : fill(t("schedule.p.ledgerStaleTitle", lang), { n: p.count }),
      fill(t(p.count > p.rows.length ? "schedule.p.ledgerStaleMore" : "schedule.p.ledgerStale", lang), { list: p.rows.join("; "), more: p.count - p.rows.length }),
    ];
    case "timer-failed": return [
      fill(t("schedule.p.timerOn", lang), { name: p.timer.name, host: p.host }),
      fill(t(p.timer.check ? "schedule.p.timerFailed" : "schedule.p.timerFailedNoCopy", lang), { result: p.timer.lastResult, unit: p.timer.id }),
    ];
    case "timers-old": return [fill(t("schedule.p.timersOldTitle", lang), { host: p.host }), fill(t("schedule.p.timersOld", lang), { when: fmt(p.collectedAt, m.zone, lang, DATE_TIME) })];
  }
  return [name || "", ""];
}

const FIX_LABEL = {
  "run-now": "schedule.runNow", "ack-run": "schedule.dismiss", pause: "schedule.pause", resume: "schedule.turnBackOn", delete: "schedule.delete",
  openJob: "schedule.openJob", notifOn: "schedule.notifOn", botRuntime: "schedule.openBotRuntime",
  copyRelease: "schedule.copyRelease", copyPath: "schedule.copyPath", copyCheck: "schedule.copyCheck", openLedger: "schedule.openLedger", howRefresh: "schedule.howRefresh",
};

/** Copyable text: always shown (selectable without JS); the button appears once the script runs. */
function copyBlock(text, label, m, ctx) {
  return `<span class="sc-copy"><code class="sc-mono sc-copy-text">${esc(text)}</code><button type="button" class="btn btn-secondary btn-sm sc-act" data-sc-copy="${esc(text)}" data-l-copied="${esc(t("schedule.copied", m.lang))}" data-l-failed="${esc(t("schedule.copyFailed", m.lang))}" hidden>${esc(label)}${ctx ? vh(ctx) : ""}</button></span>`;
}

function fixButton(m, p, f, ctx) {
  const cls = "btn btn-secondary btn-sm sc-act";
  const label = t(FIX_LABEL[f.act === "link" || f.act === "copy" ? f.label : f.act], m.lang);
  if (f.act === "copy") {
    // Belt and braces: a check command reaches the clipboard only if it is still the one the
    // unit-name rule builds (an untrusted timer file can't smuggle another command in).
    if (f.label === "copyCheck" && (!p.timer || checkCommand(p.timer) !== f.text)) return "";
    return copyBlock(f.text, label, m, ctx);
  }
  if (f.act === "link") return `<a class="${cls}" href="${esc(f.href)}"${f.external ? ` target="_blank" rel="noopener noreferrer"` : ""}>${esc(label)}${ctx ? vh(ctx) : ""}</a>`;
  if (f.act === "ack-run") return postButton(m, "ack-run", { run: p.runId }, label, { cls, ctx });
  return postButton(m, f.act, f.settles && p.runId ? { id: p.scheduleId, run: p.runId } : { id: p.scheduleId }, label, { cls, ctx });
}

function strip(m) {
  const { lang } = m;
  if (!m.problems.length) {
    return `<section class="sc-attn ok" aria-labelledby="sc-attn-h"><h2 id="sc-attn-h" class="sc-st sc-st-ok"><span class="sc-dot" aria-hidden="true"></span>${esc(t("schedule.allGood", lang))}</h2></section>`;
  }
  const items = m.problems.map((p) => {
    const [title, reason] = problemText(p, m);
    const tone = p.severity === "error" ? "error" : "warning";
    const link = p.scheduleId ? `<a class="sc-attn-name" href="${href(qs({ id: `crow:${p.scheduleId}` }))}#sc-${p.scheduleId}">${esc(title)}</a>` : `<b>${esc(title)}</b>`;
    return `<li class="sc-attn-item"><span class="sc-st sc-st-${tone}"><span class="sc-dot" aria-hidden="true"></span><span class="sc-vh">${esc(t(p.severity === "error" ? "schedule.problem" : "schedule.warning", lang))}</span></span>` +
      `<div class="sc-attn-text">${link}<span>${esc(reason)}</span></div><div class="sc-attn-acts">${p.fixes.map((f) => fixButton(m, p, f, title)).join("")}</div></li>`;
  }).join("");
  const n = m.problems.length;
  return `<section class="sc-attn" aria-labelledby="sc-attn-h"><h2 id="sc-attn-h">${esc(n === 1 ? t("schedule.attn1", lang) : fill(t("schedule.attnN", lang), { n }))}</h2><ul class="sc-attn-list">${items}</ul></section>`;
}

// ---------------------------------------------------------------- detail

const RUN_TONE = { ok: "ok", late: "warning", missed: "warning", failed: "error", requested: "info", running: "info", paused: "muted", "job-queued": "info", "job-running": "info", "job-completed": "ok", "job-failed": "error" };

function runLine(r, it, m) {
  const { lang } = m;
  const z = it.zone;
  let text;
  if (r.status === "missed") {
    text = r.count > 1 && r.first && r.last
      ? fill(t(r.capped ? "schedule.missedManyCapped" : "schedule.missedMany", lang), { n: r.count, first: fmt(r.first, z, lang, DAY_TIME), last: fmt(r.last, z, lang, DAY_TIME) })
      : r.first ? fill(t("schedule.missedOne", lang), { when: fmt(r.first, z, lang, DAY_TIME) }) : t("schedule.missedOneBare", lang);
  } else {
    const key = `schedule.run.${r.status}`;
    text = t(key, lang) === key ? r.status : t(key, lang);
    if (r.error && /failed/.test(r.status)) text += ": " + r.error;
    if (r.source === "run-now") text += " " + t("schedule.run.byHand", lang);
  }
  const tone = RUN_TONE[r.status] || "muted";
  const when = r.at ? timeTag(r.at, fmt(r.at, z, lang, DATE_TIME)) : "";
  return `<li class="sc-run"><span class="sc-st sc-st-${tone}"><span class="sc-dot" aria-hidden="true"></span>${esc(text)}</span>${when ? `<span class="sc-run-at">${when}</span>` : ""}</li>`;
}

function detailControls(it, m) {
  const { lang } = m;
  const title = itemTitle(it, lang);
  if (m.confirmDelete) {
    return `<div class="sc-confirm" role="group" aria-labelledby="sc-confirm-text">
      <p id="sc-confirm-text" tabindex="-1">${esc(fill(t("schedule.deleteConfirm", lang), { name: title }))}</p>
      <div class="sc-d-acts">${postButton(m, "delete", { id: it.id, confirm: "1" }, t("schedule.delete", lang), { cls: "btn btn-danger" })}<a class="btn btn-secondary" href="${href(qs({ id: it.ref }))}#sc-${it.id}">${esc(t("schedule.cancel", lang))}</a></div>
    </div>`;
  }
  const acts = [];
  if (it.owned) {
    // News owns the briefing: its controls live in News → Briefings (a direct flip here would
    // skip News's own restart point and could make up a missed briefing).
    acts.push(`<a class="btn btn-primary" href="${NEWS_BRIEFINGS}">${esc(t("schedule.changeInNews", lang))}</a>`);
    acts.push(`<a class="btn btn-secondary" href="${NEWS_BRIEFINGS}">${esc(t(it.enabled ? "schedule.pauseInNews" : "schedule.resumeInNews", lang))}</a>`);
    acts.push(`<a class="btn btn-secondary" href="${NEWS_BRIEFINGS}">${esc(t("schedule.runInNews", lang))}</a>`);
    return `<p class="sc-muted">${esc(t("schedule.briefingNote", lang))}</p><div class="sc-d-acts">${acts.join("")}</div>`;
  }
  if (it.kind === "system") {
    return `<p class="sc-note">${esc(t("schedule.systemNote", lang))}</p><div class="sc-d-acts">${postButton(m, "delete", { id: it.id }, t("schedule.delete", lang), { cls: "btn btn-danger" })}</div>`;
  }
  acts.push(`<span class="sc-d-switch">${switchForm(m, it)}</span>`);
  acts.push(postButton(m, "run-now", { id: it.id }, t("schedule.runNow", lang), { cls: "btn btn-primary" }));
  if (it.kind === "bot_routine" && it.botId) acts.push(`<a class="btn btn-secondary" href="/dashboard/bot-builder?bot=${encodeURIComponent(it.botId)}&amp;tab=activity">${esc(t("schedule.openBot", lang))}</a>`);
  acts.push(postButton(m, "delete", { id: it.id }, t("schedule.delete", lang), { cls: "btn btn-danger" }));
  return `<div class="sc-d-acts">${acts.join("")}</div>`;
}

function detail(m) {
  const { lang } = m;
  const d = m.detail;
  const it = d.item;
  const title = itemTitle(it, lang);
  const ref = d.next[0] ?? it.nextRun ?? m.now;
  const when = it.once
    ? (it.nextRun ? `${esc(t("schedule.once", lang))} · ${timeTag(it.nextRun, fmt(it.nextRun, it.zone, lang, { dateStyle: "full", timeStyle: "short" }))}` : esc(t("schedule.once", lang)))
    : esc(cadenceText(it, lang));
  const raw = it.once ? "" : `<span class="sc-mono">${esc(it.cron)}</span> · `;
  const next = d.next.length
    ? `<ol class="sc-next">${d.next.map((ms) => `<li>${timeTag(ms, fmt(ms, it.zone, lang, { weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))}</li>`).join("")}</ol>`
    : `<p class="sc-muted">${esc(t(it.enabled ? "schedule.noNextRuns" : "schedule.pausedNoNext", lang))}</p>`;
  const runs = d.runs.length ? `<ul class="sc-runs">${d.runs.map((r) => runLine(r, it, m)).join("")}</ul>` : `<p class="sc-muted">${esc(t("schedule.noRuns", lang))}</p>`;
  const bot = it.kind === "bot_routine"
    ? `<div class="sc-d-sec"><b>${esc(t("schedule.d.bot", lang))}</b><span>${esc(it.bot ? it.bot.display_name : it.botId)}</span>${it.goal ? `<p class="sc-d-goal">${esc(it.goal)}</p>` : ""}</div>` : "";
  const briefing = it.kind === "briefing" && d.briefing
    ? `<div class="sc-d-sec"><b>${esc(t("schedule.d.lastBriefing", lang))}</b><span>${esc(t(`schedule.briefing.${["ready", "failed", "generating"].includes(d.briefing.status) ? d.briefing.status : "other"}`, lang))}${d.briefing.at ? " · " + timeTag(d.briefing.at, fmt(d.briefing.at, it.zone, lang, DATE_TIME)) : ""}</span></div>` : "";
  const notice = m.notice ? `<p class="sc-note sc-note-${m.notice.kind}" id="sc-done" role="${m.notice.kind === "err" ? "alert" : "status"}" tabindex="-1">${esc(m.notice.text)}</p>` : "";
  return `<div class="sc-detail" id="sc-detail" role="region" aria-labelledby="sc-detail-h">
    <div class="sc-d-head"><h2 id="sc-detail-h" tabindex="-1">${esc(title)}</h2><a class="sc-close" href="${href("")}#sc-${it.id}" aria-label="${esc(t("schedule.close", lang))}" data-sc-close>✕</a></div>
    ${notice}
    <div class="sc-chips">${typeChip(it, lang)}${it.enabled ? "" : `<span class="sc-chip sc-chip-muted">${esc(t("schedule.paused", lang))}</span>`}${zoneChip(it, ref, lang)}</div>
    <div class="sc-d-sec"><b>${esc(t("schedule.d.when", lang))}</b><span>${when}</span><span class="sc-muted">${raw}${esc(it.zone)}</span></div>
    ${bot}${briefing}
    ${detailControls(it, m)}
    <div class="sc-d-sec"><b>${esc(t("schedule.d.next", lang))}</b>${next}</div>
    <div class="sc-d-sec"><b>${esc(t("schedule.d.runs", lang))}</b>${runs}</div>
  </div>`;
}

// ---------------------------------------------------------------- agenda

/** A read-only row (box hold, box window, machine timer): text only, no link, no controls. */
function roRowHtml(it, m, { group, day = null } = {}) {
  const { lang } = m;
  const z = m.zone;
  // A machine's cron line is worded like Crow's own ("Every 15 minutes"); other text shows as is.
  const sched = it.cron ? describeCron(it.cron, lang) || it.summary : it.summary;
  let at = "";
  const until = it.end ? fill(t("schedule.until", lang), { when: fmt(it.end, z, lang, it.end - m.now > 86_400_000 ? DAY_TIME : TIME) }) : null;
  if (it.kind === "box_hold") at = esc(t("schedule.heldNow", lang));
  else if (group === "now") at = esc(t("schedule.runningNow", lang));
  else if (group === "standing") at = esc(t(it.unreadable ? "schedule.undated" : "schedule.ongoing", lang));
  else if (group === "frequent") at = esc(sched || t("schedule.custom", lang));
  else if (it.nextRun !== null) {
    const opts = group === "later" ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" } : day !== null && dayNum(localYmd(it.nextRun, z)) !== day ? DAY_TIME : TIME;
    at = timeTag(it.nextRun, fmt(it.nextRun, z, lang, opts));
  }
  const title = it.kind === "box_hold" ? fill(t("schedule.holdTitle", lang), { owner: it.owner || "?" }) : it.title;
  const meta = [];
  if (it.kind === "box_hold") { if (it.reason) meta.push(it.reason); if (until) meta.push(until); }
  if (it.kind === "box_window") {
    if (it.owner) meta.push(fill(t("schedule.by", lang), { owner: it.owner }));
    if (until && !it.standing) meta.push(until);
    if (it.standing) meta.push(it.when);
  }
  if (it.kind === "host_timer") { meta.push(fill(t("schedule.onHost", lang), { host: it.host })); if (sched && group !== "frequent") meta.push(sched); }
  return `<li class="sc-row sc-row-ro" id="sc-${esc(it.ref.replace(/[^A-Za-z0-9_-]/g, "-"))}"><div class="sc-hit sc-ro"><span class="sc-at">${at}</span><span class="sc-main"><span class="sc-name">${esc(title)}</span>` +
    `<span class="sc-meta">${typeChip(it, lang)}${roLabel(lang)}${meta.length ? `<span>${esc(meta.join(" · "))}</span>` : ""}</span></span></div></li>`;
}

function rowHtml(it, m, { group, day = null } = {}) {
  if (it.readOnly && it.src) return roRowHtml(it, m, { group, day });
  const { lang } = m;
  const sel = m.detail && m.detail.item.id === it.id;
  let at = "";
  if (group === "now") {
    at = m.running.has(it.id) ? esc(t("schedule.runningNow", lang)) : it.nextRun !== null ? `${esc(t("schedule.dueAt", lang))} ${timeTag(it.nextRun, fmt(it.nextRun, it.zone, lang, DAY_TIME))}` : "";
  } else if (group === "later") at = it.nextRun !== null ? timeTag(it.nextRun, fmt(it.nextRun, it.zone, lang, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })) : "";
  else if (group === "done") at = it.lastRun !== null ? timeTag(it.lastRun, fmt(it.lastRun, it.zone, lang, DAY_TIME)) : "";
  // A schedule in another zone can fall on another local date than its instance-zone day group:
  // then its own weekday is shown with the time.
  else if (group === "day") at = timeTag(it.nextRun, fmt(it.nextRun, it.zone, lang, day !== null && dayNum(localYmd(it.nextRun, it.zone)) !== day ? DAY_TIME : TIME));
  else if (group === "frequent") at = esc(cadenceText(it, lang));
  const meta = [cadenceText(it, lang)];
  if (it.kind === "bot_routine" && it.bot && it.title !== it.bot.display_name) meta.push(it.bot.display_name);
  if (!it.enabled && group === "paused") meta.push(t("schedule.paused", lang));
  if (it.kind === "system") meta.push(t("schedule.neverRuns", lang));
  const params = qs({ id: it.ref });
  return `<li class="sc-row${sel ? " sel" : ""}" id="sc-${esc(it.id)}">` +
    `<a class="sc-hit" href="${href(params)}#sc-${esc(it.id)}"${sel ? ` aria-current="true"` : ""}><span class="sc-at">${at}</span><span class="sc-main"><span class="sc-name">${esc(itemTitle(it, lang))}</span>` +
    `<span class="sc-meta">${typeChip(it, lang)}${zoneChip(it, it.nextRun, lang)}<span>${esc(meta.filter(Boolean).join(" · "))}</span></span></span></a>` +
    (sel ? detail(m) : "") + `</li>`;
}

function dayHeading(d, m) {
  const { lang } = m;
  const ymd = fromDayNum(d.ymdNum);
  const date = fmtYmd(locale(lang), ymd, { month: "short", day: "numeric" });
  const name = d.offset === 0 ? t("schedule.today", lang) : d.offset === 1 ? t("schedule.tomorrow", lang) : fmtYmd(locale(lang), ymd, { weekday: "long" });
  return `<h3 class="sc-day-h"><span>${esc(name.charAt(0).toUpperCase() + name.slice(1))}</span><span class="sc-day-date">${esc(date)}</span></h3>`;
}

function fold(key, label, list, m, group, open = false) {
  if (!list.length) return "";
  const has = m.detail && list.some((it) => it.id === m.detail.item.id);
  return `<details class="sc-fold" data-fold="${key}"${open || has ? " open" : ""}><summary class="sc-fold-h"><b>${esc(fill(label, { n: list.length }))}</b></summary><ul class="sc-list">${list.map((it) => rowHtml(it, m, { group })).join("")}</ul></details>`;
}

/** "On the machines": every host file's timers, grouped by host (collapsed). */
function machines(m) {
  const { lang } = m;
  const hosts = m.hosts || [];
  if (!hosts.length) return "";
  const n = hosts.reduce((k, h) => k + h.timers.length, 0);
  const body = hosts.map((h, hi) => {
    const id = `sc-host-${hi}`;
    const rows = h.timers.map((tm) => {
      const bits = [];
      if (tm.schedule) bits.push(tm.kind === "cron" ? describeCron(tm.schedule, lang) || tm.schedule : tm.schedule);
      bits.push(tm.next !== null ? fill(t("schedule.machine.next", lang), { when: fmt(tm.next, m.zone, lang, DAY_TIME) }) : t("schedule.machine.noNext", lang));
      if (tm.lastResult) bits.push(fill(t("schedule.machine.last", lang), { result: tm.lastResult }));
      const tone = tm.failed ? "error" : tm.lastResult ? "ok" : "muted";
      const status = `<span class="sc-st sc-st-${tone}"><span class="sc-dot" aria-hidden="true"></span>${esc(t(tm.failed ? "schedule.machine.failed" : tm.lastResult ? "schedule.machine.ok" : "schedule.machine.unknown", lang))}</span>`;
      const at = tm.next !== null ? timeTag(tm.next, fmt(tm.next, m.zone, lang, DAY_TIME)) : "";
      return `<li class="sc-row sc-row-ro"><div class="sc-hit sc-ro"><span class="sc-at">${at}</span><span class="sc-main"><span class="sc-name">${esc(tm.name)}</span>` +
        `<span class="sc-meta">${status}${roLabel(lang)}<span>${esc(bits.join(" · "))}</span></span></span></div></li>`;
    }).join("");
    const collected = fill(t("schedule.machine.collected", lang), { when: fmt(h.collectedAt, m.zone, lang, DATE_TIME) });
    return `<section class="sc-host" aria-labelledby="${id}"><h3 class="sc-day-h sc-host-h" id="${id}"><span>${esc(h.host)}</span><span class="sc-day-date">${esc(collected)}</span></h3>${rows ? `<ul class="sc-list">${rows}</ul>` : `<p class="sc-muted sc-host-empty">${esc(t("schedule.machine.none", lang))}</p>`}</section>`;
  }).join("");
  return `<details class="sc-fold" data-fold="machines"><summary class="sc-fold-h"><b>${esc(fill(t("schedule.machinesN", lang), { n }))}</b></summary>${body}</details>`;
}

function agenda(m) {
  const { lang } = m;
  const g = m.agenda;
  const parts = [];
  if (g.now.length) parts.push(`<section class="sc-day" aria-labelledby="sc-day-now"><h3 class="sc-day-h" id="sc-day-now">${esc(t("schedule.now", lang))}</h3><ul class="sc-list">${g.now.map((it) => rowHtml(it, m, { group: "now" })).join("")}</ul></section>`);
  for (const d of g.days) {
    const id = `sc-day-${d.offset}`;
    parts.push(`<section class="sc-day" aria-labelledby="${id}">${dayHeading(d, m).replace("<h3 ", `<h3 id="${id}" `)}<ul class="sc-list">${d.items.map((it) => rowHtml(it, m, { group: "day", day: d.ymdNum })).join("")}</ul></section>`);
  }
  const anyUpcoming = g.now.length || g.days.length || g.later.length || g.frequent.length;
  if (!anyUpcoming) {
    parts.push(`<div class="sc-empty"><b>${esc(t("schedule.emptyTitle", lang))}</b><span>${esc(t("schedule.emptyText", lang))}</span><a class="btn btn-primary" href="${href("new=1")}" data-sc-new>${esc(t("schedule.new", lang))}</a></div>`);
  }
  parts.push(fold("later", t("schedule.laterN", lang), g.later, m, "later"));
  parts.push(fold("frequent", t("schedule.frequentN", lang), g.frequent, m, "frequent"));
  parts.push(fold("standing", t("schedule.standingN", lang), g.standing || [], m, "standing"));
  parts.push(fold("paused", t("schedule.pausedN", lang), g.paused, m, "paused"));
  parts.push(fold("done", t("schedule.doneN", lang), g.done, m, "done"));
  parts.push(machines(m));
  return parts.join("");
}

// ---------------------------------------------------------------- create

function previewBlock(p, lang) {
  if (!p) return `<p class="sc-muted">${esc(t("schedule.previewEmpty", lang))}</p>`;
  if (!p.ok) return `<p class="sc-note sc-note-err" role="alert">${esc(p.hint || t("schedule.previewBad", lang))}</p>`;
  return `<p class="sc-preview-sum"><b>${esc(p.summary)}</b></p><p class="sc-muted">${esc(t("schedule.previewNext", lang))}</p><ol class="sc-next">${p.next3.map((x) => `<li><time datetime="${esc(x.iso)}">${esc(x.text)}</time></li>`).join("")}</ol>`;
}

function createSheet(m) {
  const { lang } = m;
  const cs = m.create || {};
  const typed = cs.typed || { text: "", when: "", cron: "", tz: "" };
  const err = cs.error ? `<div class="sc-note sc-note-err" role="alert" id="sc-create-err">${esc(cs.error)}</div>` : "";
  const openOnLoad = !!(cs.error || cs.preview || m.createOpen);
  const briefing = m.mediaInstalled ? `<a class="sc-type-link" href="${NEWS_BRIEFINGS}">${esc(t("schedule.type.briefing", lang))}<span class="sc-muted"> · ${esc(t("schedule.briefingInNews", lang))}</span></a>` : "";
  return `<dialog id="sc-create" class="sc-dialog" aria-labelledby="sc-create-h"${openOnLoad ? " data-open-on-load" : ""}>
    <form method="POST" action="${ROUTE}" id="sc-create-form">
      ${csrf(m)}
      <input type="hidden" name="tz" value="${esc(typed.tz)}" data-sc-tz>
      <div class="sc-d-head"><h2 id="sc-create-h">${esc(t("schedule.createTitle", lang))}</h2><button type="button" class="sc-close" data-sc-dismiss aria-label="${esc(t("schedule.cancel", lang))}">✕</button></div>
      ${err}
      <fieldset class="sc-types"><legend>${esc(t("schedule.typeLabel", lang))}</legend>
        <label class="sc-type"><input type="radio" name="type" value="reminder" checked> ${esc(t("schedule.type.reminder", lang))}</label>
        ${briefing}
        <a class="sc-type-link" href="/dashboard/bot-builder">${esc(t("schedule.type.botRoutine", lang))}<span class="sc-muted"> · ${esc(t("schedule.botInBuilder", lang))}</span></a>
      </fieldset>
      <label class="sc-field" for="sc-text">${esc(t("schedule.whatLabel", lang))}</label>
      <input class="sc-input" id="sc-text" name="text" maxlength="1000" required value="${esc(typed.text)}" placeholder="${esc(t("schedule.whatPlaceholder", lang))}"${cs.focus === "text" || !cs.focus ? " autofocus" : ""}>
      <label class="sc-field" for="sc-when">${esc(t("schedule.whenLabel", lang))}</label>
      <input class="sc-input" id="sc-when" name="when" maxlength="200" value="${esc(typed.when)}" placeholder="${esc(t("schedule.whenPlaceholder", lang))}" aria-describedby="sc-when-hint sc-preview" autocomplete="off"${cs.focus === "when" ? " autofocus" : ""}>
      <p class="sc-hint" id="sc-when-hint">${esc(t("schedule.whenHint", lang))}</p>
      <details class="sc-adv"${typed.cron ? " open" : ""}><summary>${esc(t("schedule.useCron", lang))}</summary>
        <label class="sc-field" for="sc-cron">${esc(t("schedule.cronLabel", lang))}</label>
        <input class="sc-input sc-mono" id="sc-cron" name="cron" maxlength="50" value="${esc(typed.cron)}" placeholder="0 9 * * 1-5" aria-describedby="sc-preview" autocomplete="off">
      </details>
      <div class="sc-preview" id="sc-preview" aria-live="polite" data-l-next="${esc(t("schedule.previewNext", lang))}" data-l-empty="${esc(t("schedule.previewEmpty", lang))}" data-lang="${esc(lang)}">${previewBlock(cs.preview, lang)}</div>
      <div class="sc-d-acts">
        <button type="submit" name="action" value="create" class="btn btn-primary">${esc(t("schedule.save", lang))}</button>
        <button type="submit" name="action" value="preview" class="btn btn-secondary" formnovalidate data-sc-preview-btn>${esc(t("schedule.preview", lang))}</button>
        <button type="button" class="btn btn-secondary" data-sc-dismiss>${esc(t("schedule.cancel", lang))}</button>
      </div>
    </form>
  </dialog>
  <noscript><style>#sc-create[data-open-on-load]{display:block;position:static;margin:0 0 1rem}</style></noscript>`;
}

// ---------------------------------------------------------------- page

/**
 * @param {object} m  the catalog model plus: lang, csrf, now, running (Map), toast, notice
 *   ({kind, text}|null), confirmDelete, create ({typed, error, preview, focus}|null),
 *   createOpen, mediaInstalled, sources (["crow", …]), filter
 */
export function renderSchedulePage(m) {
  const { lang } = m;
  const chips = m.sources.length > 1
    ? `<div class="sc-chips sc-filters" role="group" aria-label="${esc(t("schedule.filterLabel", lang))}">${["all", ...m.sources].map((s) => `<a class="sc-filter" href="${href(s === "all" ? "" : qs({ show: s }))}"${(m.filter || "all") === s ? ` aria-current="true"` : ""}>${esc(t(`schedule.src.${s}`, lang))}</a>`).join("")}</div>`
    : "";
  const toast = `<div class="sc-toast" role="status" id="sc-toast"${m.toast ? ` data-sc-toast="${esc(m.toast)}"` : ""}></div>`;
  const today = localYmd(m.now, m.zone);
  return `<div class="sc-page${m.detail ? " has-detail" : ""}" data-today="${esc(`${today.y}-${today.m}-${today.d}`)}">
    <p class="sc-lede">${esc(t("schedule.lede", lang))}${m.sources.length > 1 ? " " + esc(t("schedule.ledeReadOnly", lang)) : ""}</p>
    ${m.pageNotice ? `<div class="sc-note sc-note-${m.pageNotice.kind}" role="${m.pageNotice.kind === "err" ? "alert" : "status"}">${esc(m.pageNotice.text)}</div>` : ""}
    ${strip(m)}
    <div class="sc-toolbar"><a class="btn btn-primary sc-new" href="${href("new=1")}" data-sc-new>${esc(t("schedule.new", lang))}</a>${chips}</div>
    <div class="sc-agenda">${agenda(m)}</div>
    <p class="sc-foot">${esc(fill(t("schedule.zoneFoot", lang), { zone: m.zone }))}</p>
    ${createSheet(m)}
    ${toast}
  </div>`;
}
