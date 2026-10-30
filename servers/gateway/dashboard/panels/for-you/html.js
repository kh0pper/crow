/**
 * For You's markup (For You v1): the page (header with the date, the weather chip and Customize;
 * Your morning; Your news with one story sheet per story) and the customize screen. Every value
 * from a row, a feed or the operator is escaped here; nothing is model-written.
 */
import { escapeHtml } from "../../shared/components.js";
import { t, fill } from "../../shared/i18n.js";
import { whyText, ageText } from "../../../for-you/news.js";
import { weatherKind } from "../../../for-you/weather.js";
import { SECTIONS } from "../../../for-you/settings.js";

const ICON = 'width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';
const SLIDERS = `<svg ${ICON}><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/></svg>`;
const BACK = `<svg ${ICON}><path d="M15 18l-6-6 6-6"/></svg>`;
const CLOSE = `<svg ${ICON}><path d="M18 6L6 18M6 6l12 12"/></svg>`;

const e = escapeHtml;
const upperFirst = (s) => (s ? s.charAt(0).toLocaleUpperCase() + s.slice(1) : s);
const plural = (key, n, lang) => fill(t(`${key}.${n === 1 ? "one" : "other"}`, lang), { n });
const locale = (lang) => (lang === "es" ? "es" : "en-US");

/** "3 cards need you, 1 card is due by today, and your bots finished 2 things since yesterday." */
export function morningSentence(m, lang = "en") {
  const parts = [];
  if (m.needs.total) parts.push(plural("forYou.sum.needs", m.needs.total, lang));
  if (m.due.total) parts.push(plural("forYou.sum.due", m.due.total, lang));
  if (m.finished.total) parts.push(plural("forYou.sum.finished", m.finished.total, lang));
  if (!parts.length) return t("forYou.sum.none", lang);
  const joined = new Intl.ListFormat(locale(lang), { type: "conjunction" }).format(parts);
  return upperFirst(joined) + ".";
}

function line({ tag, tone, title, project, href }, lang) {
  const name = title ? e(title) : e(t("forYou.untitled", lang));
  const proj = project ? `<span class="fy-line-proj"> · ${e(project)}</span>` : "";
  return `<li><a class="fy-line" href="${e(href || "/dashboard/board")}"><span class="fy-dot fy-dot--${tone}" aria-hidden="true"></span><span class="fy-line-text"><span class="fy-line-tag">${e(tag)}</span><span class="fy-line-title">${name}${proj}</span></span></a></li>`;
}

function finishedTag(item, lang) {
  const bot = item.bot || t("forYou.aBot", lang);
  const key = item.outcome === "failure" ? "forYou.tag.failure" : item.outcome === "partial" ? "forYou.tag.partial" : "forYou.tag.finished";
  return upperFirst(fill(t(key, lang), { bot }));
}

export function morningHtml(m, lang = "en") {
  if (m.error) {
    return `<section class="fy-card fy-morning" aria-labelledby="fy-morning-h">
      <h2 class="fy-kicker" id="fy-morning-h">${e(t("forYou.morning", lang))}</h2>
      <p class="fy-sum">${e(t("forYou.morningError", lang))}</p>
      <a class="fy-more-link" href="/dashboard/board">${e(t("forYou.seeBoard", lang))}</a>
    </section>`;
  }
  const lines = [
    ...m.needs.items.map((c) => line({ tag: t("forYou.tag.needs", lang), tone: "needs", ...c }, lang)),
    ...m.due.items.map((c) => line({ tag: t(c.overdue ? "forYou.tag.overdue" : "forYou.tag.due", lang), tone: "due", ...c }, lang)),
    ...m.finished.items.map((c) => line({ tag: finishedTag(c, lang), tone: "done", ...c }, lang)),
    ...(m.leftOff ? [line({ tag: t("forYou.tag.leftOff", lang), tone: "left", ...m.leftOff }, lang)] : []),
  ];
  return `<section class="fy-card fy-morning" aria-labelledby="fy-morning-h">
      <h2 class="fy-kicker" id="fy-morning-h">${e(t("forYou.morning", lang))}</h2>
      <p class="fy-sum">${e(morningSentence(m, lang))}</p>
      ${lines.length ? `<ul class="fy-lines">${lines.join("")}</ul>` : ""}
      <a class="fy-more-link" href="/dashboard/board">${e(t("forYou.seeBoard", lang))}</a>
    </section>`;
}

function storyCard(s, lang, now) {
  const age = ageText(s.publishedAt, lang, now);
  const meta = [s.sourceName, age, whyText(s.why, lang)].filter(Boolean).map(e).join(" · ");
  return `<li class="fy-story" data-fy-story="${e(s.id)}" data-fy-source="${e(s.sourceId)}">
      <button type="button" class="fy-story-open" aria-haspopup="dialog" aria-controls="fy-sheet-${s.id}" data-fy-open="fy-sheet-${s.id}">
        <span class="fy-story-title">${e(s.title)}</span>
        ${s.summary ? `<span class="fy-story-sum">${e(s.summary)}</span>` : ""}
        <span class="fy-story-meta">${meta}</span>
      </button>
    </li>`;
}

function storySheet(s, lang, now) {
  const age = ageText(s.publishedAt, lang, now);
  let source = s.sourceName;
  if (!source) { try { source = new URL(s.url).hostname; } catch { source = ""; } }
  return `<dialog class="fy-sheet" id="fy-sheet-${s.id}" aria-labelledby="fy-sheet-${s.id}-h">
      <div class="fy-sheet-inner">
        <button type="button" class="fy-sheet-close" aria-label="${e(t("common.close", lang))}" data-fy-close>${CLOSE}</button>
        <h3 class="fy-sheet-title" id="fy-sheet-${s.id}-h">${e(s.title)}</h3>
        <p class="fy-sheet-meta">${[s.sourceName, age].filter(Boolean).map(e).join(" · ")}</p>
        <a class="fy-btn fy-btn--primary" href="${e(s.url)}" target="_blank" rel="noopener noreferrer" data-turbo="false" data-fy-read="${s.id}">${e(fill(t("forYou.readAt", lang), { source }))}</a>
        <div class="fy-why"><p class="fy-kicker">${e(t("forYou.whyHeading", lang))}</p><p>${e(whyText(s.why, lang))}</p></div>
        <div class="fy-acts">
          <button type="button" class="fy-btn" data-fy-act="more" data-article="${s.id}" data-source="${s.sourceId}">${e(t("forYou.more", lang))}</button>
          <button type="button" class="fy-btn" data-fy-act="less" data-article="${s.id}" data-source="${s.sourceId}">${e(t("forYou.less", lang))}</button>
          <button type="button" class="fy-btn" data-fy-act="hide" data-article="${s.id}" data-source="${s.sourceId}" data-done="${e(fill(t("forYou.done.hide", lang), { source }))}">${e(fill(t("forYou.hide", lang), { source }))}</button>
        </div>
        <p class="fy-status" role="status" data-fy-status></p>
      </div>
    </dialog>`;
}

export function newsHtml(news, lang = "en", now = Date.now()) {
  let body;
  let count = "";
  if (news.state === "missing") {
    body = `<p class="fy-note">${e(t("forYou.newsMissing", lang))}</p><a class="fy-btn" href="/dashboard/extensions?q=media">${e(t("forYou.installMedia", lang))}</a>`;
  } else if (news.state === "update") {
    body = `<p class="fy-note">${e(t("forYou.newsUpdate", lang))}</p><a class="fy-more-link" href="/dashboard/extensions?q=media">${e(t("nav.extensions", lang))}</a>`;
  } else if (news.state === "error") {
    body = `<p class="fy-note">${e(t("forYou.newsError", lang))}</p>`;
  } else if (!news.stories.length) {
    body = `<p class="fy-note">${e(t("forYou.newsNone", lang))}</p>`;
  } else {
    count = `<span class="fy-news-count">${e(plural("forYou.newsCount", news.stories.length, lang))}</span>`;
    body = `<ul class="fy-stories">${news.stories.map((s) => storyCard(s, lang, now)).join("")}</ul>${news.stories.map((s) => storySheet(s, lang, now)).join("")}`;
  }
  return `<section class="fy-news" aria-labelledby="fy-news-h">
      <div class="fy-news-head"><h2 class="fy-kicker" id="fy-news-h">${e(t("forYou.news", lang))}</h2>${count}</div>
      ${body}
    </section>`;
}

/** The chip and its detail line, or "" (no weather: no chip). */
export function weatherHtml(w, lang = "en") {
  if (!w) return { chip: "", detail: "" };
  const kind = weatherKind(w.code);
  const words = kind ? t(`forYou.wx.${kind}`, lang) : "";
  const chip = `<span class="fy-chip">${e([`${w.temp}°`, words].filter(Boolean).join(" · "))}</span>`;
  const bits = [];
  if (w.high != null && w.low != null) bits.push(fill(t("forYou.wxHighLow", lang), { high: w.high, low: w.low }));
  if (w.rain != null) bits.push(fill(t("forYou.wxRain", lang), { n: Math.round(w.rain) }));
  const detail = `<p class="fy-wx">${bits.length ? `<span>${e(bits.join(" · "))}</span>` : ""}<span class="fy-attrib">${e(t("forYou.weatherBy", lang))}</span></p>`;
  return { chip, detail };
}

/**
 * The page. `data`: { settings, dateText, morning|null, news|null, weather|null }.
 * A section that is off is absent; with all three off, one line says where to turn them on.
 */
export function forYouPageHtml(data, lang = "en", now = Date.now()) {
  const { settings } = data;
  const wx = settings.sections.weather ? weatherHtml(data.weather, lang) : { chip: "", detail: "" };
  const addCity = settings.sections.weather && !settings.place
    ? `<a class="fy-quiet" href="/dashboard/for-you?view=customize#fy-city">${e(t("forYou.addCity", lang))}</a>` : "";
  const anyOn = SECTIONS.some((k) => settings.sections[k]);
  const msgs = {
    "data-fy-failed": t("forYou.actionFailed", lang),
    "data-fy-done-more": t("forYou.done.more", lang),
    "data-fy-done-less": t("forYou.done.less", lang),
  };
  const attrs = Object.entries(msgs).map(([k, v]) => ` ${k}="${e(v)}"`).join("");
  return `<div class="fy" data-fy${attrs}>
    <header class="fy-head">
      <div class="fy-head-text"><p class="fy-date">${e(data.dateText)}</p><h1 class="fy-title">${e(t("forYou.title", lang))}</h1></div>
      <div class="fy-head-actions">${wx.chip}<a class="fy-icon-btn" href="/dashboard/for-you?view=customize" aria-label="${e(t("forYou.customize", lang))}">${SLIDERS}</a></div>
    </header>
    ${wx.detail}${addCity}
    ${anyOn ? "" : `<p class="fy-note">${e(t("forYou.allOff", lang))}</p>`}
    ${settings.sections.morning && data.morning ? morningHtml(data.morning, lang) : ""}
    ${settings.sections.news && data.news ? newsHtml(data.news, lang, now) : ""}
  </div>`;
}

const FLASH = { saved: "forYou.saved", notfound: "forYou.cityNotFound", failed: "forYou.cityFailed" };

/** The customize screen: sections, the weather city, and (with Media Hub) the hidden sources. */
export function customizeHtml({ settings, hidden, mediaInstalled, flash, csrf }, lang = "en") {
  const note = FLASH[flash] ? `<p class="fy-banner" role="status">${e(fill(t(FLASH[flash], lang), { city: settings.city }))}</p>` : "";
  const toggles = SECTIONS.map((k) => `<label class="fy-toggle"><span>${e(t(`forYou.${k}`, lang))}</span><input type="checkbox" name="section_${k}" value="1"${settings.sections[k] ? " checked" : ""}></label>`).join("");
  const place = settings.place ? [settings.place.name, settings.place.admin1, settings.place.country].filter(Boolean).join(", ") : "";
  const hiddenRows = (hidden || []).map((h) => `<li class="fy-hidden-row"><span>${e(h.name)}</span><button type="button" class="fy-btn" data-fy-unhide="${e(h.id)}">${e(t("forYou.showAgain", lang))}</button></li>`).join("");
  const hiddenBlock = mediaInstalled ? `<section class="fy-card" aria-labelledby="fy-hidden-h">
        <h2 class="fy-kicker" id="fy-hidden-h">${e(t("forYou.hiddenSources", lang))}</h2>
        ${hiddenRows ? `<ul class="fy-hidden">${hiddenRows}</ul>` : `<p class="fy-note">${e(t("forYou.hiddenNone", lang))}</p>`}
      </section>` : "";
  return `<div class="fy fy-custom" data-fy data-fy-failed="${e(t("forYou.actionFailed", lang))}" data-fy-shown="${e(t("forYou.shownAgain", lang))}">
    <header class="fy-head">
      <a class="fy-icon-btn" href="/dashboard/for-you" aria-label="${e(t("forYou.back", lang))}">${BACK}</a>
      <h1 class="fy-title fy-title--sub">${e(t("forYou.customize", lang))}</h1>
    </header>
    ${note}
    <form class="fy-form" method="post" action="/dashboard/for-you">
      <input type="hidden" name="_csrf" value="${e(csrf || "")}">
      <fieldset class="fy-card">
        <legend class="fy-kicker">${e(t("forYou.sections", lang))}</legend>
        <p class="fy-hint">${e(t("forYou.sectionsHint", lang))}</p>
        ${toggles}
      </fieldset>
      <div class="fy-card" id="fy-city">
        <label class="fy-kicker" for="fy-city-input">${e(t("forYou.city", lang))}</label>
        <input class="fy-input" id="fy-city-input" name="city" type="text" maxlength="80" autocomplete="off" value="${e(settings.city)}">
        <p class="fy-hint">${e(t("forYou.cityHint", lang))}</p>
        ${place ? `<p class="fy-hint">${e(fill(t("forYou.cityShowing", lang), { place }))}</p>` : ""}
      </div>
      <button type="submit" class="fy-btn fy-btn--primary">${e(t("forYou.save", lang))}</button>
    </form>
    ${hiddenBlock}
  </div>`;
}
