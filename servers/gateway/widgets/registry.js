/**
 * The widget registry (widgets phase 2, spec §7.3): the ONE ordered list of widgets a dashboard
 * page can draw as a grid cell.
 *
 * Each entry is `{ id, titleKey, section, sizes, defaultSize, pages, defaultOn, defaultPages,
 * load(ctx), render(data, lang) }`:
 *
 *   id          the cell's identity in the page AND in the device's saved layout
 *               (`crow.widgets.layout.<page>`), so it must never change once shipped;
 *   titleKey    the widget's name in the picker and in the Remove / Size labels;
 *   section     the For You customize switch that offers it (null = always offered);
 *   sizes       every size the resize handle may cycle through, [w, h] in grid columns/rows;
 *   defaultSize the size a page draws it at before the device has a layout of its own;
 *   pages       the pages that offer it ("for-you" and the generic /dashboard/widgets page). A page
 *               may add any widget from "+ Add widget"; this list says where it is OFFERED at all;
 *   defaultOn   false = offered, but not part of any page's default layout (the weather, whose chip
 *               already lives in For You's header). The server draws the cell hidden and the device
 *               may add it with "+ Add widget";
 *   defaultPages an optional per-page override of `defaultOn`: the pages whose DEFAULT layout holds
 *               this widget. Everywhere else it is offered but drawn hidden, so the same widget can
 *               be the generic page's default while For You leaves it out (Today + Ramble), or For
 *               You's default while the generic page leaves it out (Your morning and the rest);
 *   pageSizes   an optional per-page default size ({ page: [w, h] }), for a widget that fills For
 *               You's row but is half of the generic page's first screenful (What needs me). It must
 *               be one of `sizes`; widgets/grid-html.js ignores anything else;
 *   available   an optional `(crowHome) => boolean` offer gate: the widget is offered only while
 *               the host answers true. No `crowHome` handed in = offered (a caller with no host to
 *               ask loses nothing). No built-in carries one today — an add-on's own widgets are
 *               offered by their presence (widgets/addons.js);
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
 *
 * Where each one starts out: For You's default layout is needs-me, morning, moves, listen, news (the
 * weather offered, drawn hidden); the generic page's is needs-me and today (everything else offered
 * from "+ Add widget"). `defaultPages`/`defaultOn` say which, and widgets/grid-html.js draws the rest
 * hidden — a cell the page offers but this device has not put on it yet. Widgets phase 3's in-Crow
 * widgets (messages, apps, projects, bots) are offered on both pages and on neither default: their
 * loaders and renderers live in widgets/more.js and widgets/more-html.js.
 *
 * Installed bundles contribute widgets too (widgets phase 3, PR 3): `widgetsForPage` appends
 * `addonWidgets(crowHome)` after these built-ins, each entry shaped like the ones above but titled by
 * a literal `title` (a string or { en, es }) instead of a `titleKey` (widgets/addons.js). `WIDGETS`
 * itself stays frozen and built-in only.
 */
import { t } from "../dashboard/shared/i18n.js";
import { escapeHtml } from "../dashboard/shared/components.js";
import {
  morningHtml, movesHtml, listenHtml, newsHtml, needsMeWidgetHtml, weatherHtml, todayHtml,
} from "../dashboard/panels/for-you/html.js";
import { loadMorning } from "../for-you/morning.js";
import { loadMoves } from "../for-you/moves.js";
import { loadListen } from "../for-you/listen.js";
import { loadNews } from "../for-you/news.js";
import { loadToday } from "../for-you/today.js";
import { loadMessages, loadApps, loadProjects, loadBots } from "./more.js";
import { messagesHtml, appsHtml, projectsHtml, botsHtml } from "./more-html.js";
import { addonWidgets } from "./addons.js";

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

/**
 * The in-Crow widgets' sizes (widgets phase 3, PR 2): the launchers are one line of tiles or two,
 * half or full width; Messages and the camera want the taller half/full-row box. Each list starts
 * with the widget's default, so the grid's Size button always has somewhere to step.
 */
const HALF_SIZES = Object.freeze([[2, 2], [4, 2]]);
const LAUNCHER_SIZES = Object.freeze([[2, 1], [2, 2], [4, 1], [4, 2]]);

/** The registry, in For You's default order (the weather last: offered, not part of the default). */
export const WIDGETS = Object.freeze([
  {
    id: "needs-me",
    titleKey: "widgets.needsMe.title",
    section: null,
    sizes: FULL_SIZES,
    defaultSize: [4, 2],
    // For You draws it across the whole row; the generic page puts it beside Today + Ramble.
    pageSizes: { widgets: [2, 2] },
    pages: ["for-you", "widgets"],
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
    pages: ["for-you", "widgets"],
    // For You's default; the generic page offers it from "+ Add widget" only.
    defaultPages: ["for-you"],
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
    pages: ["for-you", "widgets"],
    defaultPages: ["for-you"],
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
    pages: ["for-you", "widgets"],
    defaultPages: ["for-you"],
    load: (ctx) => loadListen(ctx.db, { crowHome: ctx.crowHome, now: ctx.now }),
    render: (data, lang, opts) => listenHtml(data, lang, opts && opts.now ? opts.now : undefined),
  },
  {
    id: "news",
    titleKey: "forYou.news",
    section: "news",
    sizes: FULL_SIZES,
    defaultSize: [4, 2],
    pages: ["for-you", "widgets"],
    defaultPages: ["for-you"],
    load: (ctx) => loadNews(ctx.db, { crowHome: ctx.crowHome, now: ctx.now }),
    render: (data, lang, opts) => newsHtml(data, lang, opts && opts.now ? opts.now : undefined),
    // News keeps its own error state (as it did before the grid), not the generic line.
    errorHtml: (lang) => newsHtml({ state: "error", stories: [], hidden: [] }, lang),
  },
  {
    id: "today",
    titleKey: "widgets.today.title",
    section: null,
    // Two lines of text, a half row, or the whole row: the card never asks for more height than its
    // four short lines need, and the generic page puts it beside "What needs me".
    sizes: Object.freeze([[2, 1], [2, 2], [4, 1]]),
    defaultSize: [2, 2],
    pages: ["for-you", "widgets"],
    // The generic page's second default card (widgets phase 2, spec §2.2); For You keeps its own
    // default layout, so the cell is offered there from "+ Add widget" only.
    defaultPages: ["widgets"],
    load: async (ctx) => loadToday(ctx.db, {
      crowHome: ctx.crowHome, now: ctx.now, tz: ctx.tz, lang: ctx.lang, weather: await ctx.weather(),
    }),
    render: (data, lang, opts) => todayHtml(data, lang, opts && opts.now ? opts.now : undefined),
  },
  {
    id: "weather",
    titleKey: "forYou.weather",
    section: "weather",
    sizes: Object.freeze([[1, 1], [2, 1], [4, 1]]),
    defaultSize: [1, 1],
    pages: ["for-you", "widgets"],
    // For You's weather chip stays in the page header (For You v1, unchanged). The widget is the
    // same reading as a cell, so "+ Add widget" can put it on the grid on this device.
    defaultOn: false,
    load: async (ctx) => ({ wx: await ctx.weather() }),
    render: (data, lang) => weatherCell(data, lang),
  },
  // ─── widgets phase 3, PR 2: the in-Crow widgets ───
  // Offered on both pages, on NEITHER page's default layout (`defaultOn: false`): the server draws
  // each cell hidden and "+ Add widget" puts it on this device's grid (widgets/grid-html.js).
  {
    id: "messages",
    titleKey: "widgets.more.messages.title",
    section: null,
    sizes: HALF_SIZES,
    defaultSize: [2, 2],
    pages: ["for-you", "widgets"],
    defaultOn: false,
    load: (ctx) => loadMessages(ctx.db),
    render: (data, lang, opts) => messagesHtml(data, lang, opts && opts.now ? opts.now : undefined),
  },
  {
    id: "apps",
    titleKey: "widgets.more.apps.title",
    section: null,
    sizes: LAUNCHER_SIZES,
    defaultSize: [2, 2],
    pages: ["for-you", "widgets"],
    defaultOn: false,
    load: (ctx) => loadApps(ctx.db, { crowHome: ctx.crowHome, lang: ctx.lang }),
    render: (data, lang) => appsHtml(data, lang),
  },
  {
    id: "projects",
    titleKey: "widgets.more.projects.title",
    section: null,
    sizes: LAUNCHER_SIZES,
    defaultSize: [2, 2],
    pages: ["for-you", "widgets"],
    defaultOn: false,
    load: (ctx) => loadProjects(ctx.db),
    render: (data, lang) => projectsHtml(data, lang),
  },
  {
    id: "bots",
    titleKey: "widgets.more.bots.title",
    section: null,
    sizes: LAUNCHER_SIZES,
    defaultSize: [2, 2],
    pages: ["for-you", "widgets"],
    defaultOn: false,
    load: (ctx) => loadBots(ctx.db),
    render: (data, lang) => botsHtml(data, lang),
  },
]);

/**
 * The BUILT-IN widget with this id, or null (an id from an older layout that no longer exists).
 * Add-on ids (`addon-<bundle>-<widget>`) are not here: they depend on what is installed on this host,
 * so they resolve through `widgetsForPage` (which merges widgets/addons.js) or `loadWidgets`.
 */
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

/**
 * Whether a widget is offered on this host at all: a widget that names an `available(crowHome)`
 * predicate is offered only while it answers true. With no host to ask (a test that names none) the
 * widget is offered — its own load decides.
 */
export function widgetAvailable(widget, crowHome = null) {
  if (!widget || typeof widget.available !== "function") return true;
  if (!crowHome) return true;
  try { return !!widget.available(crowHome); } catch { return false; }
}

/**
 * The page's widgets in registry order: those it lists, its settings offer, and this host offers.
 *
 * With a `crowHome` and NO `widgets` list passed by the caller, the installed add-ons' widgets
 * (widgets/addons.js) are appended after the built-ins, then the same filters apply. A caller that
 * passes its own list — a page with a fixture, a test — gets exactly that list and nothing merged.
 */
export function widgetsForPage(pageId, { settings = null, widgets = null, crowHome = null } = {}) {
  const page = String(pageId == null ? "" : pageId);
  const own = Array.isArray(widgets) ? widgets : null;
  let list = own || WIDGETS;
  if (!own && crowHome) {
    try { list = [...WIDGETS, ...addonWidgets(crowHome)]; } catch { list = WIDGETS; }
  }
  return list.filter((w) => Array.isArray(w.pages) && w.pages.includes(page)
    && widgetOffered(w, settings) && widgetAvailable(w, crowHome));
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