/**
 * The grid's markup (widgets phase 2, spec §7.3): `gridHtml(pageId, cells, lang)`.
 *
 * The server draws EVERY widget the page offers, in the page's default order, one
 * `<section class="wg-cell" data-widget data-w data-h data-sizes>` each, inside one CSS grid, plus
 * the edit toolbar and the "+ Add widget" picker as an inert `<template>`. Which cells are really
 * on the page — their order, their size, and the ones this device removed — is the device's own
 * business: `widgets/grid-client.js` applies the layout it finds in
 * `localStorage["crow.widgets.layout.<page>"]`, with no server round trip. Nothing here knows about
 * that layout.
 *
 * Rules this file owns:
 *   - a widget whose `render` returns "" draws NO cell (the Move card without Ramble, Listen with
 *     nothing in it: For You v1 left those sections out, and so does the grid). A LAZY cell is drawn
 *     regardless: the page never asked that widget's loader, so it cannot know — the device fetches
 *     the body and shows the grid's own "nothing to show" line when the answer is empty;
 *   - a widget that is offered but not part of THIS page's default layout is drawn with `hidden`
 *     (`defaultOnFor`): the weather on For You, Your morning on the generic page. It is the "+ Add
 *     widget" entry until this device adds it, and it is NOT loaded with the page: `splitForPage`
 *     keeps those cells out of the page's loads, `gridCellHtml` draws their body as one
 *     `widgets.grid.loading` line and marks them `data-wg-lazy="1"`, and `widgets/grid-client.js`
 *     fetches the body from `GET /dashboard/widgets-api/cell` the moment the device shows it;
 *   - a widget whose load failed draws its own one-line error instead of its content — its own card
 *     where it has one (`errorHtml`), so "What needs me" keeps its title and its way into the full
 *     list — and every other cell still renders;
 *   - every title, label and attribute value goes through escapeHtml: a widget's name, a cell's
 *     id and its size list all reach markup from data;
 *   - the picker lists only the widgets whose cell was really drawn, so a button can never point
 *     at a cell that is not there. Which of those this device has removed is the client's call.
 */
import { escapeHtml } from "../dashboard/shared/components.js";
import { t, fill } from "../dashboard/shared/i18n.js";

const e = escapeHtml;

/**
 * A widget's name in the page's language: its `titleKey` through i18n, or — for an add-on widget —
 * the literal title its manifest declares (a string, or { en, es } with `en` always there).
 */
export function widgetTitle(widget, lang = "en") {
  if (!widget) return "";
  if (widget.titleKey) return t(widget.titleKey, lang);
  if (typeof widget.title === "string") return widget.title;
  if (widget.title && typeof widget.title === "object") {
    const named = widget.title[String(lang == null ? "en" : lang)];
    if (typeof named === "string" && named) return named;
    return typeof widget.title.en === "string" ? widget.title.en : "";
  }
  return "";
}

/**
 * Whether the server draws this widget VISIBLE on `pageId`: part of that page's default layout.
 * `defaultPages` (when a widget carries one) names the pages whose default holds it; otherwise
 * `defaultOn` decides for every page (false = offered everywhere, drawn hidden). A cell drawn hidden
 * is the "+ Add widget" entry on that device until someone adds it.
 */
export function defaultOnFor(widget, pageId = "") {
  const pages = Array.isArray(widget && widget.defaultPages) ? widget.defaultPages : null;
  if (pages) return pages.includes(String(pageId == null ? "" : pageId));
  return !widget || widget.defaultOn !== false;
}

/**
 * The size the server draws a widget at on `pageId`: the page's own default when the widget carries
 * one (`pageSizes`, e.g. "What needs me" is 4 columns on For You and half the generic page), else the
 * widget's default. Guarded by the widget's own list, so a page can never invent a size.
 */
export function defaultSizeOf(widget, pageId = "") {
  const list = Array.isArray(widget && widget.sizes) ? widget.sizes : [];
  const perPage = widget && widget.pageSizes && typeof widget.pageSizes === "object"
    ? widget.pageSizes[String(pageId == null ? "" : pageId)] : null;
  const want = Array.isArray(perPage) ? perPage : Array.isArray(widget && widget.defaultSize) ? widget.defaultSize : null;
  if (want && list.some((s) => Number(s[0]) === Number(want[0]) && Number(s[1]) === Number(want[1]))) {
    return [Number(want[0]), Number(want[1])];
  }
  return Array.isArray(list[0]) ? [Number(list[0][0]), Number(list[0][1])] : [2, 1];
}

/**
 * The page's offer, split by whether the page's OWN default layout holds each widget: `eager` are
 * loaded with the page, `lazy` are not loaded at all — the server draws their cells hidden with a
 * loading line, and the device fetches one from the cell route when it shows it. This is the ONE
 * place that split is made, so both pages agree on it.
 */
export function splitForPage(widgets, pageId = "") {
  const eager = [];
  const lazy = [];
  for (const widget of Array.isArray(widgets) ? widgets : []) {
    if (defaultOnFor(widget, pageId)) eager.push(widget);
    else lazy.push(widget);
  }
  return { eager, lazy };
}

/**
 * The cell's body: the widget's markup, or its own error line when the load failed. The lazy fill
 * route (routes/widgets.js) renders exactly this, so a fetched body and a page-drawn one can never
 * disagree.
 */
export function cellBodyHtml(entry, lang, now) {
  const widget = entry.widget;
  if (entry.failed) {
    if (typeof widget.errorHtml === "function") return widget.errorHtml(lang);
    return `<p class="fy-note">${e(t("widgets.grid.error", lang))}</p>`;
  }
  try {
    return widget.render(entry.data, lang, now === undefined ? undefined : { now }) || "";
  } catch (err) {
    try { console.warn(`[widgets] ${widget.id} render failed: ${err && err.message}`); } catch { /* never a page */ }
    return typeof widget.errorHtml === "function"
      ? widget.errorHtml(lang)
      : `<p class="fy-note">${e(t("widgets.grid.error", lang))}</p>`;
  }
}

/**
 * One cell, or "" when the widget has nothing to show (a lazy entry always draws one: the page has
 * not asked its loader, so it cannot know).
 */
export function gridCellHtml(entry, lang = "en", now, pageId = "") {
  const widget = entry && entry.widget;
  if (!widget || !widget.id) return "";
  // A lazy entry is not loaded at all: its body is the loading line until the device shows it and
  // the client fills it from the cell route.
  const body = entry.lazy
    ? `<p class="fy-note">${e(t("widgets.grid.loading", lang))}</p>`
    : cellBodyHtml(entry, lang, now);
  if (!body) return "";
  const title = widgetTitle(widget, lang);
  const size = defaultSizeOf(widget, pageId);
  const sizes = JSON.stringify(Array.isArray(widget.sizes) ? widget.sizes : []);
  const off = defaultOnFor(widget, pageId) ? "" : " hidden";
  const lazyAttr = entry.lazy ? ' data-wg-lazy="1"' : "";
  return `<section class="wg-cell" data-widget="${e(widget.id)}" data-w="${size[0]}" data-h="${size[1]}" data-sizes="${e(sizes)}" data-def="${size[0]},${size[1]}"${off}${lazyAttr}>
      <div class="wg-cell-body">${body}</div>
      <button type="button" class="fy-btn wg-remove" data-wg-remove aria-label="${e(fill(t("widgets.grid.removeNamed", lang), { name: title }))}">${e(t("widgets.grid.remove", lang))}</button>
      <button type="button" class="fy-btn wg-size" data-wg-size aria-label="${e(fill(t("widgets.grid.resizeNamed", lang), { name: title }))}">${e(t("widgets.grid.resize", lang))}</button>
    </section>`;
}

/** The toolbar: Edit, then (while editing) "+ Add widget" and Done, the hint, and a status line. */
function toolbarHtml(lang) {
  return `<div class="wg-bar" data-wg-toolbar>
      <button type="button" class="fy-btn" data-wg-edit>${e(t("widgets.grid.edit", lang))}</button>
      <button type="button" class="fy-btn" data-wg-add hidden>${e(t("widgets.grid.add", lang))}</button>
      <button type="button" class="fy-btn fy-btn--primary" data-wg-done hidden>${e(t("widgets.grid.done", lang))}</button>
    </div>
    <p class="fy-hint wg-hint" data-wg-hint hidden>${e(t("widgets.grid.hint", lang))}</p>
    <p class="fy-status wg-status" role="status" data-wg-status></p>`;
}

/** The picker, inert until the client clones it into a dialog: one button per drawn widget. */
function pickerHtml(drawn, lang) {
  const rows = drawn.map(({ entry }) => {
    const widget = entry.widget;
    return `<li><button type="button" class="fy-btn wg-picker-add" data-wg-add="${e(widget.id)}">${e(widgetTitle(widget, lang))}</button></li>`;
  }).join("");
  return `<template data-wg-picker-tpl>
      <dialog class="wg-picker" data-wg-picker aria-labelledby="wg-picker-h">
        <div class="wg-picker-inner">
          <h2 class="fy-title fy-title--sub" id="wg-picker-h">${e(t("widgets.grid.addTitle", lang))}</h2>
          <ul class="wg-picker-list">${rows}</ul>
          <p class="fy-note" data-wg-picker-empty hidden>${e(t("widgets.grid.none", lang))}</p>
          <button type="button" class="fy-btn" data-wg-picker-close>${e(t("widgets.grid.close", lang))}</button>
        </div>
      </dialog>
    </template>`;
}

/**
 * The page's grid. `cells` is what `loadWidgets` returned (or a page's own `[{ widget, data }]`, or
 * `{ widget, lazy: true }` for an offered widget the page did not load); `opts.now` reaches a
 * renderer that wants the request's clock. The grid is one element: the client finds it by its
 * `data-wg-page`, and so does the shell when it must keep a swipe from starting inside it.
 *
 * When any cell is lazy, the grid also carries the three page lines a lazy fill may have to draw
 * itself (`data-wg-nothing`, `data-wg-error`, `data-wg-loading`): the client sets one of them as TEXT,
 * never as markup, and puts the loading line back before a Turbo snapshot if the fill was still out.
 * A page with nothing lazy has no use for them, so it does not carry them.
 */
export function gridHtml(pageId, cells, lang = "en", opts = {}) {
  const now = opts.now;
  const page = String(pageId == null ? "" : pageId);
  const drawn = [];
  for (const entry of Array.isArray(cells) ? cells : []) {
    const html = gridCellHtml(entry, lang, now, page);
    if (html) drawn.push({ entry, html });
  }
  const body = drawn.map((c) => c.html).join("\n    ");
  const lazyLines = drawn.some((c) => c.entry && c.entry.lazy)
    ? ` data-wg-nothing="${e(t("widgets.grid.nothing", lang))}" data-wg-error="${e(t("widgets.grid.error", lang))}"`
      + ` data-wg-loading="${e(t("widgets.grid.loading", lang))}"`
    : "";
  return `<div class="wg-grid" data-wg-page="${e(page)}" data-wg-saved="${e(t("widgets.grid.saved", lang))}"${lazyLines}>
    ${toolbarHtml(lang)}
    ${body}
    ${pickerHtml(drawn, lang)}
  </div>`;
}