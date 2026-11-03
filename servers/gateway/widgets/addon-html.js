/**
 * The generic renderer for an add-on widget (widgets phase 3, PR 3, spec §7.1/§7.4): the ONE way a
 * bundle's summary reaches the grid. widgets/addons.js loads and validates the summary; nothing here
 * reads, fetches or decides anything.
 *
 * Rules this file owns:
 *   - the card is the same shape the in-Crow widgets draw (widgets/more-html.js cardHtml): a
 *     `<section class="fy-card fy-tile">` with an `<h2 class="fy-kicker">` holding the widget's title
 *     in the page's language. The title is a literal string or { en, es } from the manifest, and the
 *     heading's id is derived from the grid id with letters, digits and dashes only;
 *   - an item that carries an image is drawn exactly like the camera stills were: a `data-wg-cam`
 *     button with one `<img loading="lazy">`, so the tap-to-reload handler panels/for-you/client.js
 *     already emits works with no client change. An item with no image is a row of a `wg-list`, a
 *     link when it has a same-site href and plain text when it does not;
 *   - every title, headline, label and attribute value goes through escapeHtml: all of it arrives
 *     from a bundle;
 *   - the widget always draws a card. "empty" (or nothing to show at all) says so in one line and
 *     "error" reuses the grid's own error line; a failed READ never reaches this file (it is the
 *     registry's error cell instead, widgets/registry.js).
 *
 * The styles are the widgets' own (`widgetsMoreCss`), which both pages already emit.
 */
import { escapeHtml } from "../dashboard/shared/components.js";
import { t, fill } from "../dashboard/shared/i18n.js";

const e = escapeHtml;

/**
 * A widget's name in the page's language: a literal string, or { en, es } with `en` always there.
 * Anything else is "" (the entry would not have been offered, but the renderer invents nothing).
 */
export function addonTitle(title, lang = "en") {
  if (typeof title === "string") return title;
  if (title && typeof title === "object" && !Array.isArray(title)) {
    const named = title[String(lang == null ? "en" : lang)];
    if (typeof named === "string" && named) return named;
    if (typeof title.en === "string") return title.en;
  }
  return "";
}

/** The heading's id: the grid id reduced to [a-z0-9-], so it is always a safe attribute value. */
function headingId(widget) {
  const clean = String(widget && widget.id ? widget.id : "").toLowerCase().replace(/[^a-z0-9-]/g, "");
  return `${clean || "addon-widget"}-h`;
}

/** Items with an image: one lazy still per item, inside the button the page's client reloads on a tap. */
function imageTiles(items, lang) {
  const rows = items.map((item) => `<li class="wg-cam-row"><button type="button" class="wg-cam" data-wg-cam aria-label="${e(fill(t("widgets.addon.refresh", lang), { name: item.title }))}">
        <img class="wg-cam-img" loading="lazy" src="${e(item.image)}" alt="${e(item.title)}">
        <span class="wg-cam-name">${e(item.title)}</span>
      </button></li>`).join("");
  return rows ? `<ul class="wg-cams">${rows}</ul>` : "";
}

/** Items with no image: a row each, a link only when the loader kept a same-site href. */
function textRows(items) {
  const rows = items.map((item) => {
    const name = `<span class="wg-conv-name">${e(item.title)}</span>`;
    const body = item.href
      ? `<a class="wg-conv" href="${e(item.href)}">${name}</a>`
      : `<span class="wg-conv">${name}</span>`;
    return `<li class="wg-conv-row">${body}</li>`;
  }).join("");
  return rows ? `<ul class="wg-list">${rows}</ul>` : "";
}

/**
 * The card for one add-on widget. `widget` is the registry entry (for its id and its title), `data`
 * is what normalizeAddonSummary returned. Never "" — an add-on widget always draws its card once it
 * loaded.
 */
export function addonWidgetHtml(widget, data, lang = "en") {
  const summary = data && typeof data === "object" ? data : {};
  const title = addonTitle(widget && widget.title, lang);
  const id = headingId(widget);
  const state = summary.state;
  const headline = typeof summary.headline === "string" ? summary.headline : "";
  const items = (Array.isArray(summary.items) ? summary.items : [])
    .filter((item) => item && typeof item.title === "string" && item.title !== "");
  const moreHref = typeof summary.more_href === "string" ? summary.more_href : "";

  let body;
  if (state === "error") {
    body = `<p class="fy-note">${e(t("widgets.grid.error", lang))}</p>`;
  } else if (state === "empty" || (!items.length && !headline)) {
    body = `<p class="fy-note">${e(t("widgets.addon.empty", lang))}</p>`;
  } else {
    const parts = [];
    if (headline) parts.push(`<p class="fy-tile-title">${e(headline)}</p>`);
    const tiles = imageTiles(items.filter((item) => item.image), lang);
    if (tiles) parts.push(tiles);
    const rows = textRows(items.filter((item) => !item.image));
    if (rows) parts.push(rows);
    body = parts.join("\n      ");
  }

  const more = moreHref
    ? `<a class="fy-more-link" href="${e(moreHref)}">${e(t("widgets.addon.open", lang))}</a>`
    : "";

  return `<section class="fy-card fy-tile" aria-labelledby="${e(id)}">
      <h2 class="fy-kicker" id="${e(id)}">${e(title)}</h2>
      ${body}
      ${more}
    </section>`;
}