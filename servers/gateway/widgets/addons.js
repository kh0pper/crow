/**
 * Add-on widgets (widgets phase 3, PR 3, spec §7.1/§7.4): a bundle's own widget on the grid.
 *
 * A bundle declares its widgets in its manifest — `widgets: [{ id, title, sizes }]` — and ships the
 * code for each as `widgets/<id>.js`, a module exporting `load(ctx)`. Discovery reads INSTALLED
 * copies only (`<CROW_HOME>/bundles/<id>/`), re-checks every declaration (an installed manifest is
 * not trusted to have passed the schema), and turns each good one into a registry entry the pages
 * merge after the built-ins (widgets/registry.js `widgetsForPage`).
 *
 * The rules that keep one bundle's mistake inside its own cell:
 *   - a declaration is re-checked here: an id that is not a plain slug, a title that is not 1-60
 *     characters (or { en, es } with `en` there), sizes that are not 1-4 [w, h] pairs with w in
 *     {1, 2, 4} and h in {1, 2} — that entry is skipped, its siblings still load;
 *   - the loader file is ALWAYS `widgets/<id>.js` inside the bundle (the manifest has no path key to
 *     abuse), its real path must stay inside the bundle (a symlink pointing out is skipped), and a
 *     missing file means the widget is not offered at all;
 *   - the module is imported and called under ONE 3000 ms budget (Promise.race), and the answer goes
 *     through normalizeAddonSummary: a throw, a hang or a wrong shape is that cell's error line
 *     (widgets/registry.js turns a throw into one), never the page's;
 *   - a failure is remembered per module (file + version) for ADDON_WIDGET_FAIL_TTL_MS, so a broken
 *     add-on is not imported again on every page view meanwhile; a hung import is dropped from the
 *     module cache at the timeout, so a stuck promise is never reused after the TTL;
 *   - the loader gets a FROZEN ctx of exactly { lang, now } — no database, no host, no request, no
 *     settings. Add-on widgets cannot act: every field of an item other than its key, title, kind,
 *     href and image is dropped, and a link or an image must be same-site (widgets/more.js
 *     sameSiteHref) or it is null;
 *   - a throw anywhere in one bundle's discovery costs that bundle only: `addonWidgets` never throws.
 *
 * Grid ids are `addon-<bundle>-<widget>` and never change once shipped; two bundles can still spell
 * the same one (`a-b` + `c`, `a` + `b-c`), so the first claim wins and a later repeat is skipped. The built-in `camera` widget
 * moved onto this contract (Frigate's `widgets/cameras.js`), so a device that had saved the old
 * `camera` cell simply loses that one cell: the grid client drops an id no widget carries any more
 * and keeps the rest of the layout (widgets/grid-client.js).
 *
 * `addonWidgets(crowHome, { timeoutMs })` takes the per-module budget as an option so a test never
 * waits the real three seconds.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveCrowHome } from "../../shared/crow-home.js";
import { installedBundleIds } from "../skills-catalog.js";
import { sameSiteHref } from "./more.js";
import { addonWidgetHtml } from "./addon-html.js";

/** How long one add-on's import AND its load may take before that cell is its own error line. */
export const ADDON_WIDGET_TIMEOUT_MS = 3000;
/**
 * How long a failed add-on widget is remembered. Every offered widget loads on every page view,
 * so an add-on that threw (or hung) is not asked again until this has passed: without it a broken
 * add-on costs every page the full budget, for as long as it stays installed.
 */
export const ADDON_WIDGET_FAIL_TTL_MS = 60_000;
/** How many add-on widgets may join the grid in total, whatever is installed. */
export const ADDON_WIDGET_LIMIT = 24;
/** How many widgets one manifest may declare (the schema's own ceiling). */
const DECLARED_MAX = 8;

const WIDGET_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const DECL_KEYS = new Set(["id", "title", "sizes"]);
const TITLE_MAX = 60;
const SIZES_MAX = 4;
const WIDTHS = new Set([1, 2, 4]);
const HEIGHTS = new Set([1, 2]);

const ITEM_TITLE_MAX = 120;
const ITEM_KEY_MAX = 64;
const ITEM_KIND_MAX = 32;
const ITEM_MAX = 12;
const HEADLINE_MAX = 200;
const STATES = new Set(["ok", "empty", "error"]);

// ─── the declaration, as the schema states it ───────────────────────────────

function validTitleText(v) {
  return typeof v === "string" && v.length >= 1 && v.length <= TITLE_MAX;
}

/** A title as declared: a plain string, or { en, es }. Anything else is null. */
export function validAddonTitle(raw) {
  if (validTitleText(raw)) return raw;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (!Object.keys(raw).every((k) => k === "en" || k === "es")) return null;
  if (!validTitleText(raw.en)) return null;
  const out = { en: raw.en };
  if (raw.es !== undefined) {
    if (!validTitleText(raw.es)) return null;
    out.es = raw.es;
  }
  return out;
}

/** Sizes as declared: 1-4 [w, h] pairs, w in {1, 2, 4} and h in {1, 2}. Anything else is null. */
export function validAddonSizes(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > SIZES_MAX) return null;
  const out = [];
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length !== 2) return null;
    const w = entry[0];
    const h = entry[1];
    if (!Number.isInteger(w) || !WIDTHS.has(w)) return null;
    if (!Number.isInteger(h) || !HEIGHTS.has(h)) return null;
    out.push([w, h]);
  }
  return out;
}

/** One declared widget, checked: `{ id, title, sizes }`, or null when the declaration is bad. */
export function validAddonDecl(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (!Object.keys(raw).every((k) => DECL_KEYS.has(k))) return null;
  if (typeof raw.id !== "string" || !WIDGET_ID_RE.test(raw.id)) return null;
  const title = validAddonTitle(raw.title);
  if (!title) return null;
  const sizes = validAddonSizes(raw.sizes);
  if (!sizes) return null;
  return { id: raw.id, title, sizes };
}

// ─── the summary, as spec §7.1 states it (the subset an add-on may fill) ────

function text(value, max) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

/**
 * Validate what an add-on's `load` returned. Pure. The output is
 * `{ state, headline, items, more_href }`, or a throw of `Error("invalid widget summary")` when the
 * answer is not a summary at all (not a plain object, or a state that is not one of the three).
 *
 * Anything an item carries beyond `key`, `title`, `kind`, `href` and `image` is DROPPED — an add-on
 * widget cannot act in this release, so a hand-made `actions`, `project` or `lock` block never
 * reaches the page. An item without a non-empty title is dropped; at most 12 are kept.
 */
export function normalizeAddonSummary(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid widget summary");
  const state = raw.state;
  if (!STATES.has(state)) throw new Error("invalid widget summary");

  const headline = typeof raw.headline === "string" ? raw.headline.trim().slice(0, HEADLINE_MAX) : "";

  const items = [];
  const list = Array.isArray(raw.items) ? raw.items : [];
  for (let i = 0; i < list.length && items.length < ITEM_MAX; i++) {
    const item = list[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    if (typeof item.title !== "string" || item.title.trim() === "") continue;
    items.push({
      key: typeof item.key === "string" ? item.key.slice(0, ITEM_KEY_MAX) : String(i),
      title: item.title.slice(0, ITEM_TITLE_MAX),
      kind: text(item.kind, ITEM_KIND_MAX),
      href: sameSiteHref(item.href),
      image: sameSiteHref(item.image),
    });
  }

  return { state, headline, items, more_href: sameSiteHref(raw.more_href) };
}

// ─── loading one widget's module ────────────────────────────────────────────

/** Imported modules, per (file, version): a version bump loads the new copy, a reload does not. */
const moduleCache = new Map();
/** Failed widgets, per module url: `failedUntil` (an epoch ms). Cleared by the TTL, never by success. */
const failureCache = new Map();

/** Drop both maps (a module cache entry and a failure outlive one test otherwise). Test-only. */
export function _resetAddonWidgetStateForTest() {
  moduleCache.clear();
  failureCache.clear();
}

function moduleUrl(file, version) {
  return pathToFileURL(file).href + "?v=" + encodeURIComponent(version);
}

async function importAddon(file, version) {
  const url = moduleUrl(file, version);
  let pending = moduleCache.get(url);
  if (!pending) {
    // A failed import is forgotten, so the next page view tries again.
    pending = import(url).catch((err) => {
      // Only if this is still the entry: a timed-out import was already dropped and may have been
      // replaced by a newer one, which this stale rejection must not remove.
      if (moduleCache.get(url) === pending) moduleCache.delete(url);
      throw err;
    });
    moduleCache.set(url, pending);
  }
  return pending;
}

/** The module's loader: the named `load`, or a default export that is a function. */
function loaderOf(mod) {
  if (mod && typeof mod.load === "function") return mod.load;
  if (mod && typeof mod.default === "function") return mod.default;
  return null;
}

async function loadAddonWidget({ file, version }, ctx, timeoutMs) {
  const url = moduleUrl(file, version);
  // A recent failure answers at once: the module is neither imported nor called. Every offered
  // widget loads on every page view, so asking a broken add-on again would cost every page.
  const failedUntil = failureCache.get(url);
  if (failedUntil && failedUntil > Date.now()) throw new Error("add-on widget failed recently");
  // Exactly these two, and frozen: a loader has no way to reach the database, the host or a session.
  const frozen = Object.freeze({
    lang: ctx && ctx.lang === "es" ? "es" : "en",
    now: ctx && Number.isFinite(Number(ctx.now)) ? Number(ctx.now) : Date.now(),
  });
  let timer = null;
  let hung = false;
  const work = (async () => {
    const fn = loaderOf(await importAddon(file, version));
    if (!fn) throw new Error("add-on widget has no load export");
    return fn(frozen);
  })();
  const budget = new Promise((_, reject) => {
    timer = setTimeout(() => {
      hung = true;
      reject(new Error("add-on widget timed out"));
    }, timeoutMs);
    try { timer?.unref?.(); } catch { /* a test's timer need not support unref */ }
  });
  try {
    return normalizeAddonSummary(await Promise.race([work, budget]));
  } catch (err) {
    // A throw, a timeout or a wrong shape alike: remembered for the TTL, never the page's problem.
    failureCache.set(url, Date.now() + ADDON_WIDGET_FAIL_TTL_MS);
    // A hung import must not be reused once the TTL is over: its own .catch never fires, so the
    // entry would otherwise stay in the cache forever and every later request would wait on it.
    if (hung) moduleCache.delete(url);
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ─── discovery, from installed copies only ─────────────────────────────────

function entryFor({ bundleId, file, version, decl, timeoutMs }) {
  const widget = {
    id: `addon-${bundleId}-${decl.id}`,
    section: null,
    title: decl.title,
    sizes: Object.freeze(decl.sizes.map((pair) => Object.freeze(pair))),
    defaultSize: Object.freeze([decl.sizes[0][0], decl.sizes[0][1]]),
    pages: ["for-you", "widgets"],
    defaultOn: false,
    addon: { bundle: bundleId, widget: decl.id },
    load: (ctx) => loadAddonWidget({ file, version }, ctx, timeoutMs),
  };
  widget.render = (data, lang) => addonWidgetHtml(widget, data, lang);
  return widget;
}

/** The widgets one installed bundle declares, each with a loader file that really is inside it. */
function bundleWidgets(home, bundleId, timeoutMs) {
  const bundleDir = join(home, "bundles", bundleId);
  let manifest;
  try { manifest = JSON.parse(readFileSync(join(bundleDir, "manifest.json"), "utf8")); } catch { return []; }
  const declared = manifest && Array.isArray(manifest.widgets) ? manifest.widgets : null;
  if (!declared || !declared.length) return [];
  let realBundle;
  try { realBundle = realpathSync(bundleDir); } catch { return []; }
  const version = typeof manifest.version === "string" && manifest.version ? manifest.version : "0";
  const seen = new Set();
  const out = [];
  for (const raw of declared.slice(0, DECLARED_MAX)) {
    const decl = validAddonDecl(raw);
    if (!decl || seen.has(decl.id)) continue;
    seen.add(decl.id);
    const file = join(bundleDir, "widgets", `${decl.id}.js`);
    let realFile;
    try {
      if (!existsSync(file)) continue;
      realFile = realpathSync(file);
    } catch { continue; }
    // A symlink out of the bundle is not the bundle's widget.
    if (!realFile.startsWith(realBundle + sep)) continue;
    out.push(entryFor({ bundleId, file: realFile, version, decl, timeoutMs }));
  }
  return out;
}

/**
 * Every add-on widget this host offers, in install order then declaration order, at most
 * ADDON_WIDGET_LIMIT. Reads the INSTALLED manifests (`<CROW_HOME>/bundles/<id>/`), never the repo's.
 * Never throws: a bundle that cannot be read, parsed or trusted simply contributes nothing.
 */
export function addonWidgets(crowHome, { timeoutMs = ADDON_WIDGET_TIMEOUT_MS } = {}) {
  const home = crowHome || resolveCrowHome();
  if (!home) return [];
  const budget = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Number(timeoutMs)
    : ADDON_WIDGET_TIMEOUT_MS;
  let ids = [];
  try { ids = installedBundleIds(home); } catch { return []; }
  const out = [];
  // Grid ids are `<bundle>-<widget>` joined, which two bundles can spell the same way
  // (`a-b` + `c`, `a` + `b-c`): the first claim wins, a later repeat is not a second cell.
  const seen = new Set();
  for (const bundleId of ids) {
    if (out.length >= ADDON_WIDGET_LIMIT) break;
    let mine = [];
    try { mine = bundleWidgets(home, bundleId, budget); } catch { mine = []; }
    for (const widget of mine) {
      if (out.length >= ADDON_WIDGET_LIMIT) break;
      if (seen.has(widget.id)) continue;
      seen.add(widget.id);
      out.push(widget);
    }
  }
  return out;
}