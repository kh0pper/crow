/**
 * The widget registry (widgets phase 2, spec §7.3): the ONE ordered list of widgets a dashboard
 * page can draw as a grid cell.
 *
 * Each entry is `{ id, titleKey, section, sizes, defaultSize, pages, defaultOn, load(ctx), render(data, lang) }`:
 *
 *   id          the cell's identity in the page AND in the device's saved layout
 *               (`crow.widgets.layout.<page>`), so it must never change once shipped;
 *   titleKey    the widget's name in the picker and in the Remove / Size labels;
 *   section     the For You customize switch that offers it (null = always offered);
 *   sizes       every size the resize handle may cycle through, [w, h] in grid columns/rows;
 *   defaultSize the size a page draws it at before the device has a layout of its own;
 *   pages       the pages that offer it. Phase 2 is For You only: the generic page (widgets phase 2,
 *               Task 3) is not built yet, so NO entry lists "widgets" here;
 *   defaultOn   false = offered, but not part of the page's default layout (the weather, whose chip
 *               already lives in For You's header). The server draws the cell hidden and the device
 *               may add it with "+ Add widget";
 *   load(ctx)   reads the data, or returns null when nothing came back (the grid draws the widget's
 *               own one-line error instead). A throw is the same as null;
 *   render      draws the widget from that data; "" means "nothing to show": no cell at all (the
 *               Move card without Ramble, Listen with nothing in it), exactly as For You v1 did.
 *
 * The loaders and renderers are For You's own (for-you/*.js, panels/for-you/html.js) — no logic
 * moves here, the registry only names them. `render` may take a third `{ now }` argument; every
 * renderer already defaults it, so a caller that has no clock to pass loses nothing.
 *
 * `loadWidgets` runs the loads (one failure costs its own cell, never the page) and
 * `widgetsForPage` is the page's ordered offer: the page's entries, minus the widgets whose For You
 * customize switch is off (off now means "not offered", per the phase 2 plan; per-device removal is
 * the grid's job and never touches the server setting).
 */
import { t } from "../dashboard/shared/i18n.js";
import { escapeHtml } from "../dashboard/shared/components.js";
import {
  morningHtml, movesHtml, listenHtml, newsHtml, needsMeWidgetHtml, weatherHtml,
} from "../dashboard/panels/for-you/html.js";
import { loadMorning } from "../for-you/morning.js";
import { loadMoves } from "../for-you/moves.js";
import { loadListen } from "../for-you/listen.js";
import { loadNews } from "../for-you/news.js";

const e = escapeHtml;

/** The weather as a widget: the chip and the detail line the header already shows, in a card. */
function weatherCell(data, lang) {
  const w = weatherHtml(data && data.wx ? data.wx : null, lang);
  if (!w.chip && !w.detail) return "";
  return `<section class="fy-card fy-tile" aria-labelledby="fy-wx-cell-h">
      <h2 class="fy-kicker" id="fy-wx-cell-h">${e(t("forYou.weather", lang))}</h2>
      <p class="fy-tile-title">${w.chip}</p>
      ${w.detail}
    </section>`;
}

/** For You's five full-width widgets all cycle through these, so a resize always changes something. */
const FULL_SIZES = Object.freeze([[4, 2], [2, 2], [4, 1], [2, 1]]);

/** How long any one widget may hold the page before it is drawn as its own error cell. */
export const WIDGET_TIMEOUT_MS = 8000;

/** The registry, in For You's default order (the weather last: offered, not part of the default). */
export const WIDGETS = Object.freeze([
  {
    id: "needs-me",
    titleKey: "widgets.needsMe.title",
    section: null,
    sizes: FULL_SIZES,
    defaultSize: [4, 2],
    pages: ["for-you"],
    defaultOn: true,
    load: (ctx) => ctx.needsMe(),
    render: (data, lang) => needsMeWidgetHtml(data || null, lang),
    // A failed read is the widget's own line, not a bare "couldn't load": the card, its title and
    // its way into the full list all stay (For You v1 did exactly this).
    errorHtml: (lang) => needsMeWidgetHtml(null, lang),
  },
  {
    id: "morning",
    titleKey: "forYou.morning",
    section: "morning",
    sizes: FULL_SIZES,
    defaultSize: [4, 2],
    pages: ["for-you"],
    defaultOn: true,
    load: async (ctx) => loadMorning(ctx.db, { projects: await ctx.projects(), tz: ctx.tz, now: ctx.now }),
    render: (data, lang) => morningHtml(data, lang),
    errorHtml: (lang) => morningHtml({ error: true }, lang),
  },
  {
    id: "moves",
    titleKey: "forYou.moves",
    section: "moves",
    sizes: FULL_SIZES,
    defaultSize: [4, 2],
    pages: ["for-you"],
    defaultOn: true,
    // Ramble's card weighs the weather the header chip already loaded, so it waits for that read
    // (the same value, read once per request by the page's context).
    load: async (ctx) => loadMoves(ctx.db, {
      crowHome: ctx.crowHome, now: ctx.now, weather: await ctx.weather(), lang: ctx.lang,
    }),
    render: (data, lang) => movesHtml(data, lang),
  },
  {
    id: "listen",
    titleKey: "forYou.listen",
    section: "listen",
    sizes: FULL_SIZES,
    defaultSize: [4, 2],
    pages: ["for-you"],
    defaultOn: true,
    load: (ctx) => loadListen(ctx.db, { crowHome: ctx.crowHome, now: ctx.now }),
    render: (data, lang, opts) => listenHtml(data, lang, opts && opts.now ? opts.now : undefined),
  },
  {
    id: "news",
    titleKey: "forYou.news",
    section: "news",
    sizes: FULL_SIZES,
    defaultSize: [4, 2],
    pages: ["for-you"],
    defaultOn: true,
    load: (ctx) => loadNews(ctx.db, { crowHome: ctx.crowHome, now: ctx.now }),
    render: (data, lang, opts) => newsHtml(data, lang, opts && opts.now ? opts.now : undefined),
    // News keeps its own error state (as it did before the grid), not the generic line.
    errorHtml: (lang) => newsHtml({ state: "error", stories: [], hidden: [] }, lang),
  },
  {
    id: "weather",
    titleKey: "forYou.weather",
    section: "weather",
    sizes: Object.freeze([[1, 1], [2, 1], [4, 1]]),
    defaultSize: [1, 1],
    pages: ["for-you"],
    // For You's weather chip stays in the page header (For You v1, unchanged). The widget is the
    // same reading as a cell, so "+ Add widget" can put it on the grid on this device.
    defaultOn: false,
    load: async (ctx) => ({ wx: await ctx.weather() }),
    render: (data, lang) => weatherCell(data, lang),
  },
]);

/** The widget with this id, or null (an id from an older layout that no longer exists). */
export function widgetOf(id) {
  const key = String(id == null ? "" : id);
  for (const w of WIDGETS) if (w.id === key) return w;
  return null;
}

/** True when the For You customize switches offer this widget (no switch: always offered). */
export function widgetOffered(widget, settings) {
  if (!widget || !widget.section) return true;
  const sections = settings && settings.sections;
  if (!sections || typeof sections !== "object") return true;
  return sections[widget.section] !== false;
}

/** The page's widgets in registry order: those it lists, and those its settings offer. */
export function widgetsForPage(pageId, { settings = null, widgets = WIDGETS } = {}) {
  const page = String(pageId == null ? "" : pageId);
  return (widgets || []).filter((w) => Array.isArray(w.pages) && w.pages.includes(page) && widgetOffered(w, settings));
}

/**
 * Load every widget: `[{ widget, data } | { widget, failed: true }]`, in the order given. One
 * widget's throw (or null) is that cell's error line; every other cell still loads, and the page
 * still renders. A reporter logs the failure without the data (never a title or a path).
 *
 * `timeoutMs` is a per-widget ceiling: a loader that never answers (a stuck feed, a calendar that
 * does not reply) becomes its own error cell instead of holding the whole page. The hung read is
 * left to finish on its own — it is only ever the page's wait that is cut short.
 */
export async function loadWidgets(widgets, ctx, { log = console.warn, timeoutMs = WIDGET_TIMEOUT_MS } = {}) {
  const list = Array.isArray(widgets) ? widgets : [];
  return Promise.all(list.map((widget) => loadOne(widget, ctx, { log, timeoutMs })));
}

/** The sentinel a loader that ran out of time resolves to. */
const TIMED_OUT = Object.freeze({ timedOut: true });

async function loadOne(widget, ctx, { log, timeoutMs }) {
  let timer = null;
  try {
    const work = Promise.resolve().then(() => widget.load(ctx));
    const budget = new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      try { timer?.unref?.(); } catch { /* a test's timer need not support unref */ }
    });
    const data = timeoutMs > 0 ? await Promise.race([work, budget]) : await work;
    if (data === TIMED_OUT) {
      try { log(`[widgets] ${widget.id} timed out after ${timeoutMs} ms`); } catch { /* logging never fails a page */ }
      return { widget, failed: true };
    }
    if (data === null || data === undefined) return { widget, failed: true };
    return { widget, data };
  } catch (err) {
    try { log(`[widgets] ${widget.id} failed: ${err && err.message}`); } catch { /* logging never fails a page */ }
    return { widget, failed: true };
  } finally {
    if (timer) clearTimeout(timer);
  }
}