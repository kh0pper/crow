/**
 * The in-Crow widgets' markup (widgets phase 3, PR 2): Messages and the apps / projects / bots
 * launchers. The data they draw comes from widgets/more.js; nothing here reads or fetches.
 *
 * Rules this file owns:
 *   - every name, label, alt and attribute value goes through escapeHtml: a conversation's title and
 *     a project's name both reach markup from a store;
 *   - a launcher tile whose href is not same-site is DROPPED here as well as in the loader (the
 *     renderer is the last line, Review focus 5);
 *   - the widget always draws a card: with nothing to show it says so in one line, because "no
 *     conversations yet" is information, not a failure (a failed READ is the registry's error cell
 *     instead, widgets/registry.js).
 *
 * The camera widget moved to the add-on contract: Frigate's own `widgets/cameras.js` supplies the
 * summary and widgets/addon-html.js draws it. The stills' styles stay here (`widgetsMoreCss`,
 * emitted by both pages next to the grid's), because the generic add-on renderer uses the same
 * `.wg-cam` markup and the page's client reloads it on a tap.
 *
 * NOTE: never write a literal closing style tag inside a comment here.
 */
import { escapeHtml } from "../dashboard/shared/components.js";
import { t, fill } from "../dashboard/shared/i18n.js";
import { ageText } from "../for-you/news.js";
import { sameSiteHref } from "./more.js";

const e = escapeHtml;

/** A card with a kicker heading, its body and one way out. */
function cardHtml({ id, title, body, moreHref, moreKey }, lang) {
  return `<section class="fy-card fy-tile" aria-labelledby="${id}-h">
      <h2 class="fy-kicker" id="${id}-h">${e(title)}</h2>
      ${body}
      <a class="fy-more-link" href="${e(moreHref)}">${e(t(moreKey, lang))}</a>
    </section>`;
}

/**
 * Messages: the five latest conversations, each a row with its name, an unread dot and how long ago
 * it moved; the row is the deep link into the thread. Empty is one line, plus the way into Messages.
 */
export function messagesHtml(data, lang = "en", now = Date.now()) {
  const list = data && Array.isArray(data.conversations) ? data.conversations : [];
  const rows = list.filter((c) => c && c.name).map((c) => {
    const unread = Number(c.unread) || 0;
    // The row is a link into this dashboard or it is the list: a hand-made href never leaves the site.
    const href = sameSiteHref(c.href) || "/dashboard/messages";
    const age = ageText(c.at, lang, now);
    const dot = unread
      ? `<span class="wg-dot" role="img" aria-label="${e(fill(t("widgets.more.messages.unread", lang), { n: unread }))}"></span>`
      : "";
    const when = age ? `<span class="wg-conv-age">${e(age)}</span>` : "";
    return `<li class="wg-conv-row"><a class="wg-conv" href="${e(href)}">
        <span class="wg-conv-name">${e(c.name)}</span>${dot}${when}
      </a></li>`;
  }).join("");
  const body = rows ? `<ul class="wg-list">${rows}</ul>` : `<p class="fy-note">${e(t("widgets.more.messages.empty", lang))}</p>`;
  return cardHtml({
    id: "wg-messages",
    title: t("widgets.more.messages.title", lang),
    body,
    moreHref: "/dashboard/messages",
    moreKey: "widgets.more.messages.open",
  }, lang);
}

/** The tiles: an initial badge and the name. A tile's href is same-site or the tile is not drawn. */
function tilesHtml(items) {
  const tiles = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item) continue;
    const href = sameSiteHref(item.href);
    if (!href) continue;
    const label = String(item.label == null ? "" : item.label);
    const initial = (label.trim().charAt(0) || "?").toLocaleUpperCase();
    tiles.push(`<li class="wg-tile-row"><a class="wg-tile" href="${e(href)}">
        <span class="wg-tile-badge" aria-hidden="true">${e(initial)}</span>
        <span class="wg-tile-label">${e(label)}</span>
      </a></li>`);
  }
  return tiles.join("");
}

/** A launcher: a tile grid (never more than the loader's twelve) and "See all" to its own page. */
function launcherHtml({ id, titleKey, emptyKey, moreHref, data }, lang) {
  const tiles = tilesHtml(data && data.items);
  const body = tiles ? `<ul class="wg-tiles">${tiles}</ul>` : `<p class="fy-note">${e(t(emptyKey, lang))}</p>`;
  return cardHtml({ id, title: t(titleKey, lang), body, moreHref, moreKey: "widgets.more.seeAll" }, lang);
}

/** The apps launcher's card. "See all" is the Extensions page: the app catalog Crow installs from. */
export function appsHtml(data, lang = "en") {
  return launcherHtml({
    id: "wg-apps", titleKey: "widgets.more.apps.title", emptyKey: "widgets.more.apps.empty",
    moreHref: "/dashboard/extensions", data,
  }, lang);
}

/** The projects launcher's card: one tile per active project, "See all" to the Projects page. */
export function projectsHtml(data, lang = "en") {
  return launcherHtml({
    id: "wg-projects", titleKey: "widgets.more.projects.title", emptyKey: "widgets.more.projects.empty",
    moreHref: "/dashboard/projects", data,
  }, lang);
}

/** The bots launcher's card: one tile per enabled bot, opening it in Bot Builder. */
export function botsHtml(data, lang = "en") {
  return launcherHtml({
    id: "wg-bots", titleKey: "widgets.more.bots.title", emptyKey: "widgets.more.bots.empty",
    moreHref: "/dashboard/bot-builder", data,
  }, lang);
}

/**
 * The in-Crow widgets' styles, emitted by both pages next to widgets/grid-css.js. Every control is
 * at least 44 px tall, a name wraps (never widens the page), and a still is cropped to its box.
 */
export function widgetsMoreCss() {
  return `<style>
  .wg-list, .wg-tiles, .wg-cams { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  .wg-conv-row, .wg-tile-row, .wg-cam-row { min-width: 0; }
  .wg-conv { display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 4px; color: inherit; text-decoration: none; }
  .wg-conv-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wg-conv-age { flex: 0 0 auto; color: var(--crow-text-secondary); font-size: 0.85rem; }
  .wg-dot { flex: 0 0 auto; width: 8px; height: 8px; border-radius: 50%; background: var(--crow-accent); }
  .wg-tiles, .wg-cams { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .wg-tile {
    display: flex; flex-direction: column; align-items: center; justify-content: flex-start; gap: 6px;
    min-height: 44px; padding: 8px 4px; border-radius: 12px; color: inherit; text-decoration: none;
  }
  .wg-tile-badge {
    display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px;
    border-radius: 10px; background: var(--crow-accent-muted, var(--crow-border)); font-weight: 600;
  }
  .wg-tile-label { font-size: 0.8rem; text-align: center; overflow-wrap: anywhere; min-width: 0; max-width: 100%; }
  .wg-cam {
    display: flex; flex-direction: column; gap: 4px; width: 100%; min-height: 44px; padding: 0;
    border: 0; background: none; color: inherit; border-radius: 10px; overflow: hidden;
  }
  .wg-cam-img { display: block; width: 100%; height: auto; aspect-ratio: 16 / 9; object-fit: cover; background: var(--crow-border); }
  .wg-cam-name { font-size: 0.8rem; text-align: left; overflow-wrap: anywhere; }
</style>`;
}