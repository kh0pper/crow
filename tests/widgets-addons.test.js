/**
 * Widgets phase 3, PR 3: add-on widgets — a bundle's own widget on the grid, and Frigate as the
 * reference implementation.
 *
 * The scratch CROW_HOME is built by this file: `installed.json` plus `bundles/<id>/manifest.json`
 * and `bundles/<id>/widgets/<wid>.js`, exactly the layout an install produces. Every case needs no
 * browser and no network:
 *   - discovery: a valid declaration becomes an entry whose grid id is `addon-<bundle>-<widget>`,
 *     offered on both pages and on neither default layout, with the manifest's sizes and title;
 *   - discovery's refusals: a bundle that is not installed, a bad id, bad sizes, a too-long title, a
 *     missing loader file, a symlink out of the bundle, a manifest that is not JSON — each costs its
 *     own declaration only, and a good sibling in the same manifest still loads;
 *   - loading: a valid summary, a throw, a hang (cut off by the add-on's own budget), a module with
 *     no `load`, a wrong shape — each is one cell, and the other cells still load;
 *   - the ctx a loader receives is frozen and holds exactly `lang` and `now`;
 *   - the summary validation: caps, the fields it drops, same-site hrefs and images only, and a
 *     throw for something that is not a summary;
 *   - the renderer: escaping, stills with the tap target the page's client already handles, rows,
 *     the empty and error lines, the title in the page's language;
 *   - the registry merge, the Frigate widget itself, the bundle contract's new checks, and the
 *     grid's hidden cell plus its literal title in the picker.
 */
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHTML } from "linkedom";
import { WIDGETS, widgetOf, widgetsForPage, loadWidgets } from "../servers/gateway/widgets/registry.js";
import { gridHtml, widgetTitle } from "../servers/gateway/widgets/grid-html.js";
import {
  addonWidgets, normalizeAddonSummary, ADDON_WIDGET_TIMEOUT_MS, ADDON_WIDGET_FAIL_TTL_MS,
  _resetAddonWidgetStateForTest,
} from "../servers/gateway/widgets/addons.js";
import { addonWidgetHtml } from "../servers/gateway/widgets/addon-html.js";
import { validateManifest, detectSurfaces } from "../scripts/lib/bundle-contract.mjs";
import { forYouClientJs } from "../servers/gateway/dashboard/panels/for-you/client.js";
import { t } from "../servers/gateway/dashboard/shared/i18n.js";

const dir = mkdtempSync(join(tmpdir(), "widgets-addons-"));
const HOME = join(dir, "home");
mkdirSync(HOME, { recursive: true });
process.env.CROW_HOME = HOME;
const REPO = new URL("..", import.meta.url).pathname;
const NOW = Date.parse("2026-11-03T15:00:00Z");

after(() => rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  rmSync(join(HOME, "bundles"), { recursive: true, force: true });
  writeFileSync(join(HOME, "installed.json"), "[]");
  // The module cache and the failure map outlive one case: a bundle id is unique per case, but a
  // stale failure would still answer for a file this case just wrote.
  _resetAddonWidgetStateForTest();
});

/** Unique per bundle, so a module imported by one case can never answer another's file. */
let seq = 0;
const bundleId = (base) => `${base}-${++seq}`;

function setInstalled(ids) {
  writeFileSync(join(HOME, "installed.json"), JSON.stringify(ids));
}

function manifestFor(id, widgets) {
  return { id, name: id, description: "d", type: "bundle", category: "misc", version: "1.0.0", widgets };
}

/** Write one installed bundle: its manifest (an object, or raw text) and its widget files. */
function installBundle(id, { manifest, widgets = {} } = {}) {
  const bdir = join(HOME, "bundles", id);
  mkdirSync(join(bdir, "widgets"), { recursive: true });
  writeFileSync(join(bdir, "manifest.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
  for (const [wid, src] of Object.entries(widgets)) writeFileSync(join(bdir, "widgets", `${wid}.js`), src);
  return bdir;
}

const DECL = { id: "cams", title: { en: "Cams", es: "Cámaras" }, sizes: [[2, 2], [4, 2]] };
const OK_MODULE = 'export async function load() { return { state: "ok", headline: "", items: [], more_href: null }; }\n';

// ─── discovery ──────────────────────────────────────────────────────────────

test("discovery: a valid declaration is an entry titled by its manifest, on both pages, on neither default", () => {
  const id = bundleId("demo");
  installBundle(id, { manifest: manifestFor(id, [DECL]), widgets: { cams: OK_MODULE } });
  setInstalled([id]);

  const list = addonWidgets(HOME);
  assert.equal(list.length, 1);
  const w = list[0];
  assert.equal(w.id, `addon-${id}-cams`, "the grid id names the bundle and the widget");
  assert.equal(w.section, null, "no For You customize switch");
  assert.deepEqual(w.pages, ["for-you", "widgets"]);
  assert.equal(w.defaultOn, false, "never part of a page's default layout");
  assert.deepEqual(w.sizes, [[2, 2], [4, 2]]);
  assert.deepEqual(w.defaultSize, [2, 2], "the first declared size is the default");
  assert.deepEqual(w.title, { en: "Cams", es: "Cámaras" });
  assert.equal("titleKey" in w, false, "an add-on has no i18n key: its title is literal");
  assert.deepEqual(w.addon, { bundle: id, widget: "cams" });
  assert.equal(typeof w.load, "function");
  assert.equal(typeof w.render, "function");
  assert.equal(widgetTitle(w, "en"), "Cams");
  assert.equal(widgetTitle(w, "es"), "Cámaras");
  assert.equal(widgetTitle(w, "fr"), "Cams", "a language it has no title for falls back to en");
});

test("discovery: a plain string title is kept as it is", () => {
  const id = bundleId("plain");
  installBundle(id, {
    manifest: manifestFor(id, [{ id: "one", title: "One", sizes: [[1, 1]] }]),
    widgets: { one: OK_MODULE },
  });
  setInstalled([id]);
  const [w] = addonWidgets(HOME);
  assert.equal(w.title, "One");
  assert.equal(widgetTitle(w, "es"), "One");
  assert.deepEqual(w.defaultSize, [1, 1]);
});

test("discovery skips what it cannot trust, and keeps the good sibling in the same manifest", () => {
  const id = bundleId("mixed");
  const bdir = installBundle(id, {
    manifest: manifestFor(id, [
      { id: "good", title: "Good", sizes: [[2, 1]] },
      { id: "../x", title: "Traversal", sizes: [[2, 1]] },
      { id: "../../other/widgets/cams", title: "Out of the bundle", sizes: [[2, 1]] },
      { id: "A", title: "Upper", sizes: [[2, 1]] },
      { id: "wide", title: "Wide", sizes: [[3, 1]] },
      { id: "tall", title: "Tall", sizes: [[2, 3]] },
      { id: "nosize", title: "No size", sizes: [] },
      { id: "loud", title: "x".repeat(61), sizes: [[2, 1]] },
      { id: "nofile", title: "No file", sizes: [[2, 1]] },
      { id: "sneaky", title: "Sneaky", sizes: [[2, 1]] },
      { id: "extra", title: "Extra key", sizes: [[2, 1]], module: "server/x.js" },
      { id: "good", title: "Duplicate", sizes: [[2, 1]] },
    ]),
    // Every refused declaration below that COULD name a real file gets that file: the skip must
    // come from the id / keys rule, not from the missing-file rule doing the work for it.
    widgets: {
      good: OK_MODULE, A: OK_MODULE, wide: OK_MODULE, tall: OK_MODULE, nosize: OK_MODULE,
      loud: OK_MODULE, extra: OK_MODULE, sneaky: OK_MODULE,
    },
  });
  // `widgets/../x.js` is the bundle's own x.js, and `widgets/../../other/widgets/cams.js` is a
  // sibling bundle's widget: both exist, both stay outside this bundle's widgets/ dir.
  writeFileSync(join(bdir, "x.js"), OK_MODULE);
  mkdirSync(join(HOME, "bundles", "other", "widgets"), { recursive: true });
  writeFileSync(join(HOME, "bundles", "other", "widgets", "cams.js"), OK_MODULE);
  // A file outside the bundle, and a widget file that symlinks to it.
  const outside = join(dir, "outside.js");
  writeFileSync(outside, OK_MODULE);
  rmSync(join(bdir, "widgets", "sneaky.js"));
  symlinkSync(outside, join(bdir, "widgets", "sneaky.js"));

  // A bundle whose manifest is not JSON, and one on disk that is not installed at all.
  const junk = bundleId("junk");
  installBundle(junk, { manifest: "{not json at all", widgets: { cams: OK_MODULE } });
  const notInstalled = bundleId("absent");
  installBundle(notInstalled, { manifest: manifestFor(notInstalled, [DECL]), widgets: { cams: OK_MODULE } });
  setInstalled([id, junk]);

  const list = addonWidgets(HOME);
  assert.deepEqual(list.map((w) => w.id), [`addon-${id}-good`], "one good declaration survives, the rest are skipped");
  assert.equal(list[0].title, "Good", "the FIRST declaration of a duplicated id wins");
});

test("discovery never throws, whatever sits in the home", () => {
  setInstalled(["nope"]);
  assert.deepEqual(addonWidgets(HOME), [], "an installed id with no bundle");
  const id = bundleId("nowidgets");
  installBundle(id, { manifest: manifestFor(id, undefined), widgets: {} });
  setInstalled([id]);
  assert.deepEqual(addonWidgets(HOME), [], "no widgets key: nothing");
  const stranger = bundleId("stranger");
  installBundle(stranger, { manifest: { ...manifestFor(stranger, null), widgets: "cams" }, widgets: { cams: OK_MODULE } });
  setInstalled([stranger]);
  assert.deepEqual(addonWidgets(HOME), [], "a widgets value that is not an array: nothing");
});

test("discovery: two bundles that spell one grid id — the first claim wins, the second is skipped", () => {
  // `a-b` + `c` and `a` + `b-c` both land on addon-a-b-c.
  const longer = "coll-a-b";
  const shorter = "coll-a";
  installBundle(longer, {
    manifest: manifestFor(longer, [{ id: "c", title: "From the longer bundle", sizes: [[2, 1]] }]),
    widgets: { c: OK_MODULE },
  });
  installBundle(shorter, {
    manifest: manifestFor(shorter, [{ id: "b-c", title: "From the shorter bundle", sizes: [[2, 1]] }]),
    widgets: { "b-c": OK_MODULE },
  });

  setInstalled([longer, shorter]);
  const list = addonWidgets(HOME);
  assert.equal(list.length, 1, "one cell, whichever bundle got there first");
  assert.equal(list[0].id, "addon-coll-a-b-c");
  assert.equal(list[0].title, "From the longer bundle");

  // Install order decides, not the bundle id's shape or length.
  setInstalled([shorter, longer]);
  const reversed = addonWidgets(HOME);
  assert.equal(reversed.length, 1);
  assert.equal(reversed[0].title, "From the shorter bundle");
});

test("limits: a manifest offers at most 8 widgets, and the grid takes at most 24 in total", () => {
  const nine = Array.from({ length: 9 }, (_, i) => `w${i}`);
  const first = bundleId("nine");
  installBundle(first, {
    manifest: manifestFor(first, nine.map((wid) => ({ id: wid, title: wid, sizes: [[2, 1]] }))),
    widgets: Object.fromEntries(nine.map((wid) => [wid, OK_MODULE])),
  });
  setInstalled([first]);
  const capped = addonWidgets(HOME);
  assert.equal(capped.length, 8, "the schema's own ceiling is 8 declarations per manifest");
  assert.deepEqual(capped.map((w) => w.addon.widget), nine.slice(0, 8), "the ninth declaration is dropped");

  // Four bundles declaring 8 + 8 + 8 + 1 = 25 valid widgets between them.
  const many = [bundleId("many-a"), bundleId("many-b"), bundleId("many-c"), bundleId("many-d")];
  const counts = [8, 8, 8, 1];
  for (let b = 0; b < many.length; b++) {
    const ids = Array.from({ length: counts[b] }, (_, i) => `w${i}`);
    installBundle(many[b], {
      manifest: manifestFor(many[b], ids.map((wid) => ({ id: wid, title: wid, sizes: [[1, 1]] }))),
      widgets: Object.fromEntries(ids.map((wid) => [wid, OK_MODULE])),
    });
  }
  setInstalled(many);
  const total = addonWidgets(HOME);
  assert.equal(total.length, 24, "25 valid declarations, 24 cells: the grid's own ceiling wins");
  assert.equal(new Set(total.map((w) => w.id)).size, 24, "24 distinct ids");
});

// ─── loading ────────────────────────────────────────────────────────────────

test("loading: a valid answer, a throw, a hang, no loader, a wrong shape — each costs its own cell", async () => {
  const id = bundleId("load");
  installBundle(id, {
    manifest: manifestFor(id, [
      { id: "ok", title: "Ok", sizes: [[2, 1]] },
      { id: "boom", title: "Boom", sizes: [[2, 1]] },
      { id: "hang", title: "Hang", sizes: [[2, 1]] },
      { id: "noload", title: "No loader", sizes: [[2, 1]] },
      { id: "bogus", title: "Bogus", sizes: [[2, 1]] },
    ]),
    widgets: {
      ok: 'export async function load() { return { state: "ok", headline: "Hello", items: [], more_href: "/dashboard/demo" }; }\n',
      boom: 'export async function load() { throw new Error("the bundle is unhappy"); }\n',
      hang: "export async function load() { return new Promise(() => {}); }\n",
      noload: "export const notALoader = 1;\n",
      bogus: 'export async function load() { return { state: "bogus" }; }\n',
    },
  });
  setInstalled([id]);

  const entries = addonWidgets(HOME, { timeoutMs: 60 });
  assert.equal(entries.length, 5, "all five are offered");
  const started = Date.now();
  const cells = await loadWidgets(entries, { lang: "en", now: NOW }, { log: () => {} });
  assert.ok(Date.now() - started < 2000, "the hung loader was cut off at its own budget, not the page's");

  assert.deepEqual(cells.map((c) => (c.failed ? "failed" : "ok")), ["ok", "failed", "failed", "failed", "failed"]);
  // The add-on's own words never reach the page: the failing cells are the grid's one error line.
  const html = gridHtml("widgets", cells, "en");
  assert.doesNotMatch(html, /the bundle is unhappy/);
  assert.equal(html.split("This widget couldn't load just now").length - 1, 4);
  assert.equal(ADDON_WIDGET_TIMEOUT_MS, 3000, "the shipped budget is three seconds");
});

test("loading: a hung loader costs the next page view almost nothing, and is called once", async () => {
  const id = bundleId("hung");
  installBundle(id, {
    manifest: manifestFor(id, [{ id: "hang", title: "Hang", sizes: [[2, 1]] }]),
    widgets: {
      hang: "export async function load() {\n"
        + "  globalThis.__addonHangCalls = (globalThis.__addonHangCalls || 0) + 1;\n"
        + "  return new Promise(() => {});\n"
        + "}\n",
    },
  });
  setInstalled([id]);
  try {
    const started = Date.now();
    const first = await loadWidgets(addonWidgets(HOME, { timeoutMs: 150 }), { lang: "en", now: NOW }, { log: () => {} });
    const firstTook = Date.now() - started;
    assert.equal(first[0].failed, true, "the hang is that cell's error line");
    assert.ok(firstTook >= 100, `the first call waited out its own budget (${firstTook} ms)`);

    // A second page view, a second discovery of the same module url: the failure answers.
    const again = Date.now();
    const second = await loadWidgets(addonWidgets(HOME, { timeoutMs: 150 }), { lang: "en", now: NOW }, { log: () => {} });
    const secondTook = Date.now() - again;
    assert.equal(second[0].failed, true, "still that cell's error line");
    assert.ok(secondTook < 50, `a remembered failure does not wait on the stuck import (${secondTook} ms)`);
    assert.equal(globalThis.__addonHangCalls, 1, "the module's load ran exactly once");
    assert.equal(ADDON_WIDGET_FAIL_TTL_MS, 60_000, "a failure is remembered for a minute");
  } finally {
    delete globalThis.__addonHangCalls;
  }
});

test("loading: a module that throws is not called again within the failure TTL", async () => {
  const id = bundleId("once");
  installBundle(id, {
    manifest: manifestFor(id, [{ id: "boom", title: "Boom", sizes: [[2, 1]] }]),
    widgets: {
      boom: "export async function load() {\n"
        + "  globalThis.__addonBoomCalls = (globalThis.__addonBoomCalls || 0) + 1;\n"
        + '  throw new Error("the bundle is unhappy");\n'
        + "}\n",
    },
  });
  setInstalled([id]);
  try {
    const first = await loadWidgets(addonWidgets(HOME, { timeoutMs: 500 }), { lang: "en", now: NOW }, { log: () => {} });
    assert.equal(first[0].failed, true);
    assert.equal(globalThis.__addonBoomCalls, 1);

    const started = Date.now();
    const second = await loadWidgets(addonWidgets(HOME, { timeoutMs: 500 }), { lang: "en", now: NOW }, { log: () => {} });
    assert.equal(second[0].failed, true);
    assert.ok(Date.now() - started < 50, "the TTL answers instead of the module");
    assert.equal(globalThis.__addonBoomCalls, 1, "the loader was not asked a second time");
  } finally {
    delete globalThis.__addonBoomCalls;
  }
});

test("loading: a wrong-shaped answer is remembered too", async () => {
  const id = bundleId("shape");
  installBundle(id, {
    manifest: manifestFor(id, [{ id: "bogus", title: "Bogus", sizes: [[2, 1]] }]),
    widgets: {
      bogus: "export async function load() {\n"
        + "  globalThis.__addonBogusCalls = (globalThis.__addonBogusCalls || 0) + 1;\n"
        + '  return { state: "bogus" };\n'
        + "}\n",
    },
  });
  setInstalled([id]);
  try {
    const first = await loadWidgets(addonWidgets(HOME), { lang: "en", now: NOW }, { log: () => {} });
    assert.equal(first[0].failed, true);
    const second = await loadWidgets(addonWidgets(HOME), { lang: "en", now: NOW }, { log: () => {} });
    assert.equal(second[0].failed, true);
    assert.equal(globalThis.__addonBogusCalls, 1, "an invalid summary is a failure like any other");
  } finally {
    delete globalThis.__addonBogusCalls;
  }
});

test("loading: a validated summary comes back as the cell's data", async () => {
  const id = bundleId("data");
  installBundle(id, {
    manifest: manifestFor(id, [{ id: "one", title: "One", sizes: [[2, 1]] }]),
    widgets: {
      one: 'export async function load() { return { state: "ok", headline: "Hi", items: [{ title: "Row", href: "https://evil.example" }], more_href: "/dashboard/demo" }; }\n',
    },
  });
  setInstalled([id]);
  const [w] = addonWidgets(HOME);
  const cells = await loadWidgets([w], { lang: "en", now: NOW }, { log: () => {} });
  assert.equal(cells[0].failed, undefined);
  assert.deepEqual(cells[0].data, {
    state: "ok",
    headline: "Hi",
    items: [{ key: "0", title: "Row", kind: "", href: null, image: null }],
    more_href: "/dashboard/demo",
  }, "the loader's answer went through normalizeAddonSummary");
});

test("loading: a default export that is a function is a loader too", async () => {
  const id = bundleId("default");
  installBundle(id, {
    manifest: manifestFor(id, [{ id: "one", title: "One", sizes: [[2, 1]] }]),
    widgets: { one: 'export default async function load() { return { state: "empty" }; }\n' },
  });
  setInstalled([id]);
  const cells = await loadWidgets(addonWidgets(HOME), { lang: "en", now: NOW }, { log: () => {} });
  assert.equal(cells[0].failed, undefined);
  assert.equal(cells[0].data.state, "empty");
});

test("loading: the loader gets a frozen ctx of exactly lang and now", async () => {
  const id = bundleId("ctx");
  installBundle(id, {
    manifest: manifestFor(id, [{ id: "one", title: "One", sizes: [[2, 1]] }]),
    widgets: {
      one: 'export async function load(ctx) {\n'
        + "  globalThis.__addonKeys = Object.keys(ctx);\n"
        + "  globalThis.__addonFrozen = Object.isFrozen(ctx);\n"
        + "  globalThis.__addonLang = ctx.lang;\n"
        + "  globalThis.__addonNow = ctx.now;\n"
        + '  return { state: "ok" };\n'
        + "}\n",
    },
  });
  setInstalled([id]);
  try {
    const [w] = addonWidgets(HOME);
    await loadWidgets([w], { lang: "es", now: 1234567, db: {}, crowHome: HOME }, { log: () => {} });
    assert.deepEqual(globalThis.__addonKeys, ["lang", "now"], "no database, no host, no request");
    assert.equal(globalThis.__addonFrozen, true, "the object cannot be extended with a database");
    assert.equal(globalThis.__addonLang, "es");
    assert.equal(globalThis.__addonNow, 1234567);
  } finally {
    for (const k of ["__addonKeys", "__addonFrozen", "__addonLang", "__addonNow"]) delete globalThis[k];
  }
});

// ─── the summary's rules ────────────────────────────────────────────────────

test("normalizeAddonSummary: caps the count and the lengths, and keeps only what it is allowed to", () => {
  const items = Array.from({ length: 13 }, (_, i) => ({
    key: "k" + i,
    title: "t" + i,
    kind: "camera",
    href: "/dashboard/x",
    actions: [{ id: "approve" }],
    project: "garden",
    lock: { count: 1 },
  }));
  items[0].title = "y".repeat(300);
  const out = normalizeAddonSummary({ state: "ok", headline: "  headline  ", items, more_href: "/dashboard/demo" });
  assert.equal(out.items.length, 12, "at most twelve items");
  assert.equal(out.items[0].title.length, 120, "an item title is capped");
  assert.deepEqual(Object.keys(out.items[0]).sort(), ["href", "image", "key", "kind", "title"], "actions, project and lock are dropped");
  assert.equal(out.headline, "headline", "the headline is trimmed");
  assert.equal(normalizeAddonSummary({ state: "ok", headline: "h".repeat(500) }).headline.length, 200);
  assert.deepEqual(Object.keys(out).sort(), ["headline", "items", "more_href", "state"]);

  // Junk items are dropped, an absent list is an empty one.
  const mixed = normalizeAddonSummary({ state: "ok", items: [null, "row", 7, {}, { title: "   " }, { title: "kept" }] });
  assert.deepEqual(mixed.items.map((i) => i.title), ["kept"]);
  assert.deepEqual(normalizeAddonSummary({ state: "empty" }).items, []);
  assert.equal(normalizeAddonSummary({ state: "empty" }).more_href, null);
});

test("normalizeAddonSummary: only same-site hrefs and images survive", () => {
  for (const bad of ["//evil.example/x", "https://evil.example/x", "javascript:alert(1)", "/\\evil.example", "/a\u0001b", "", null, 42]) {
    const item = normalizeAddonSummary({ state: "ok", items: [{ title: "x", href: bad, image: bad }], more_href: bad }).items[0];
    assert.equal(item.href, null, String(bad));
    assert.equal(item.image, null, String(bad));
    assert.equal(normalizeAddonSummary({ state: "ok", more_href: bad }).more_href, null, String(bad));
  }
  const good = normalizeAddonSummary({
    state: "ok",
    items: [{ title: "x", href: "/dashboard/a", image: "/api/frigate/front/latest.jpg" }],
    more_href: "/dashboard/b",
  });
  assert.equal(good.items[0].href, "/dashboard/a");
  assert.equal(good.items[0].image, "/api/frigate/front/latest.jpg");
  assert.equal(good.more_href, "/dashboard/b");
});

test("normalizeAddonSummary: anything that is not a summary throws one plain error", () => {
  for (const bad of [null, undefined, "ok", 7, [], [["ok"]], {}, { state: "OK" }, { state: 1 }]) {
    assert.throws(() => normalizeAddonSummary(bad), { name: "Error", message: "invalid widget summary" }, JSON.stringify(bad));
  }
});

// ─── the renderer ──────────────────────────────────────────────────────────

const WIDGET = { id: "addon-demo-cams", title: { en: "Cams", es: "Cámaras" } };

test("renderer: stills are the tap target the page's client already reloads, and rows are links or text", () => {
  const data = normalizeAddonSummary({
    state: "ok",
    headline: "Two up",
    items: [
      { key: "front", title: "front", kind: "camera", image: "/api/frigate/front/latest.jpg" },
      { key: "link", title: "A link", href: "/dashboard/demo" },
      { key: "plain", title: "Plain row" },
    ],
    more_href: "/dashboard/frigate",
  });
  const html = addonWidgetHtml(WIDGET, data, "en");
  assert.match(html, /^<section class="fy-card fy-tile" aria-labelledby="addon-demo-cams-h">/);
  assert.match(html, /<h2 class="fy-kicker" id="addon-demo-cams-h">Cams<\/h2>/);
  assert.match(html, /<p class="fy-tile-title">Two up<\/p>/);
  assert.equal(html.split("data-wg-cam").length - 1, 1, "one still, inside the button the client hears");
  assert.match(html, /<img class="wg-cam-img" loading="lazy" src="\/api\/frigate\/front\/latest\.jpg" alt="front">/);
  assert.match(html, /aria-label="Reload front"/);
  assert.match(html, /<ul class="wg-list">/, "the items without an image are rows of a list");
  assert.match(html, /<a class="wg-conv" href="\/dashboard\/demo">/);
  assert.match(html, /<span class="wg-conv"><span class="wg-conv-name">Plain row<\/span><\/span>/);
  assert.match(html, /<a class="fy-more-link" href="\/dashboard\/frigate">Open<\/a>/);
  assert.doesNotMatch(html, /<video|<source/, "never video");
});

test("renderer: every string from the add-on is escaped", () => {
  const html = addonWidgetHtml(
    { id: 'x"><img src=1 onerror=alert(1)>', title: '<script>alert("title")</script>' },
    normalizeAddonSummary({
      state: "ok",
      headline: "<script>alert(1)</script>",
      items: [{ title: "<b>row</b>", href: "/dashboard/x?q=<script>" }],
      more_href: "/dashboard/demo",
    }),
    "en",
  );
  assert.ok(!html.includes("<script>"), "no script tag survives");
  assert.ok(!html.includes("<b>row</b>"));
  assert.match(html, /&lt;script&gt;alert\(&quot;title&quot;\)&lt;\/script&gt;/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;b&gt;row&lt;\/b&gt;/);
  // The heading id is reduced to letters, digits and dashes.
  assert.match(html, /aria-labelledby="ximgsrc1onerroralert1-h"/);
});

test("renderer: empty and error states each say one line, and the card is always drawn", () => {
  const empty = addonWidgetHtml(WIDGET, normalizeAddonSummary({ state: "empty" }), "en");
  assert.match(empty, /<p class="fy-note">Nothing to show yet\.<\/p>/);
  assert.match(empty, /Cams/, "the card keeps its title");
  assert.match(addonWidgetHtml(WIDGET, normalizeAddonSummary({ state: "empty" }), "es"), /Nada que mostrar todavía\./);

  const nothing = addonWidgetHtml(WIDGET, normalizeAddonSummary({ state: "ok" }), "en");
  assert.match(nothing, /Nothing to show yet\./, "no items and no headline is the empty line");

  const error = addonWidgetHtml(WIDGET, normalizeAddonSummary({ state: "error" }), "en");
  assert.match(error, new RegExp(t("widgets.grid.error", "en")));
  assert.match(error, /Cams/, "the card keeps its title");

  // Never "" — an add-on widget always draws its card once it loaded.
  assert.notEqual(addonWidgetHtml(WIDGET, {}, "en"), "");
  assert.notEqual(addonWidgetHtml({ id: "addon-x-y", title: "Y" }, null, "en"), "");
});

test("renderer: the title object picks the page's language and falls back to en", () => {
  assert.match(addonWidgetHtml(WIDGET, normalizeAddonSummary({ state: "empty" }), "es"), /<h2 class="fy-kicker" id="addon-demo-cams-h">Cámaras<\/h2>/);
  assert.match(addonWidgetHtml({ id: "addon-a-b", title: { en: "Only English" } }, null, "es"), /Only English/);
});

test("a tap on an add-on still reloads that image with a fresh ?t=<now>, and nothing else", async () => {
  const js = forYouClientJs();
  assert.ok(!js.includes("`"), "the client is emitted inside a template literal: no backtick");
  assert.ok(!js.includes("${"), "and no ${");
  const card = addonWidgetHtml(WIDGET, normalizeAddonSummary({
    state: "ok",
    items: [{ title: "front", image: "/api/frigate/front/latest.jpg" }],
  }), "en");
  const { parseHTML } = await import("linkedom");
  const { document, window } = parseHTML(`<!doctype html><html><body>
    <div class="fy" data-fy data-fy-failed="That action failed.">${card}</div>
  </body></html>`);
  const vm = await import("node:vm");
  const ctx = vm.createContext({ window, document, JSON, Number, Object, Array, String, Date, isFinite, setTimeout, clearTimeout });
  vm.runInContext(js.replace(/^<script>\s*/, "").replace(/<\/script>\s*$/, ""), ctx);
  const img = document.querySelector(".wg-cam-img");
  const tap = () => document.querySelector("[data-wg-cam]").dispatchEvent(new window.Event("click", { bubbles: true }));
  tap();
  const once = img.getAttribute("src");
  assert.match(once, /^\/api\/frigate\/front\/latest\.jpg\?t=\d+$/, "the same still URL, with a clock on the end");
  assert.equal(once.split("?t=").length - 1, 1, "one query, not a growing chain");
  const first = once.split("?t=")[1];
  await new Promise((r) => setTimeout(r, 5));
  tap();
  const twice = img.getAttribute("src");
  assert.equal(twice.split("?t=").length - 1, 1, "and still one after a second tap");
  assert.notEqual(twice.split("?t=")[1], first, "a later tap asks for a newer frame");
});

// ─── the registry merge, and the grid ──────────────────────────────────────

test("the registry: add-ons come after the built-ins, and WIDGETS stays built-in only", () => {
  const id = bundleId("merge");
  installBundle(id, { manifest: manifestFor(id, [DECL]), widgets: { cams: OK_MODULE } });
  setInstalled([id]);

  for (const page of ["for-you", "widgets"]) {
    const list = widgetsForPage(page, { crowHome: HOME });
    assert.equal(list[list.length - 1].id, `addon-${id}-cams`, `${page}: the add-on is last`);
    assert.ok(list.length > WIDGETS.length, `${page}: the built-ins are still all there`);
  }
  assert.equal(widgetsForPage("for-you", { crowHome: HOME, widgets: [WIDGETS[0]] }).length, 1, "an own list excludes add-ons");
  assert.equal(widgetOf(`addon-${id}-cams`), null, "widgetOf answers for built-ins only");
  assert.equal(WIDGETS.some((w) => w.id === "camera"), false, "the built-in camera widget is gone");
  assert.equal(Object.isFrozen(WIDGETS), true);
  assert.match(t("widgets.addon.empty", "es"), /Nada que mostrar/);
  assert.equal(t("widgets.addon.refresh", "en"), "Reload {name}");
});

test("the grid: an add-on's cell is drawn hidden, and the picker lists its literal title", () => {
  const id = bundleId("grid");
  installBundle(id, { manifest: manifestFor(id, [DECL]), widgets: { cams: OK_MODULE } });
  setInstalled([id]);
  const [w] = addonWidgets(HOME);
  const html = gridHtml("widgets", [{ widget: w, data: normalizeAddonSummary({ state: "ok", headline: "Live" }) }], "es");
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const cell = document.querySelector(`[data-widget="addon-${id}-cams"]`);
  assert.ok(cell, "the cell is on the page");
  assert.equal(cell.hasAttribute("hidden"), true, "offered, not part of the default layout");
  assert.equal(cell.getAttribute("data-sizes"), "[[2,2],[4,2]]");
  assert.equal(cell.getAttribute("data-w"), "2");
  assert.match(cell.textContent, /Live/, "the body is the add-on's summary");
  // The picker is an inert template on the page until the client clones it out.
  assert.match(html, new RegExp(`<button type="button" class="fy-btn wg-picker-add" data-wg-add="addon-${id}-cams">Cámaras</button>`));
});

// ─── the Frigate reference widget ──────────────────────────────────────────

const FRIGATE = await import("../bundles/frigate/widgets/cameras.js");

test("frigate: the manifest declares the widget, and the contract accepts it", () => {
  const manifest = JSON.parse(readFileSync(join(REPO, "bundles", "frigate", "manifest.json"), "utf8"));
  const r = validateManifest(manifest, join(REPO, "bundles", "frigate"));
  assert.equal(r.ok, true, r.errors.join("; "));
  assert.equal(manifest.version, "1.1.0");
  assert.deepEqual(manifest.widgets, [
    { id: "cameras", title: { en: "Cameras", es: "Cámaras" }, sizes: [[2, 2], [4, 2]] },
  ], "the cameras widget, in both languages, two sizes");
  assert.ok(readFileSync(join(REPO, "bundles", "frigate", "widgets", "cameras.js"), "utf8").includes("export async function load"));
});

test("frigate: the camera list as stills, disabled cameras left out, at most four", async () => {
  FRIGATE._resetForTest();
  try {
    const cameras = { front: {}, garden: {}, off: { enabled: false } };
    for (const n of ["a", "b", "c", "d", "e", "f"]) cameras[n] = {};
    FRIGATE._setFetchForTest(async (path) => {
      assert.equal(path, "/api/config", "the one read");
      return { cameras };
    });
    const summary = await FRIGATE.load({ lang: "en", now: NOW });
    assert.equal(summary.state, "ok");
    assert.equal(summary.items.length, 4, "a 2x2 block, whatever the camera count");
    assert.deepEqual(summary.items.map((i) => i.title), ["front", "garden", "a", "b"], "config order, disabled camera skipped");
    assert.deepEqual(summary.items[0], {
      key: "front", kind: "camera", title: "front", image: "/api/frigate/front/latest.jpg",
    });
    assert.equal(summary.more_href, "/dashboard/frigate");
    assert.equal(summary.headline, "");
    const normalized = normalizeAddonSummary(summary);
    assert.equal(normalized.items.length, 4, "the summary passes the same validation the gateway applies");
  } finally {
    FRIGATE._resetForTest();
  }
});

test("frigate: no cameras is the empty state, and a camera's name is escaped into its still's URL", async () => {
  FRIGATE._resetForTest();
  try {
    FRIGATE._setFetchForTest(async () => ({ cameras: {} }));
    const empty = await FRIGATE.load({ lang: "en", now: NOW });
    assert.deepEqual(empty, { state: "empty", headline: "", items: [], more_href: "/dashboard/frigate" });

    FRIGATE._setFetchForTest(async () => ({ cameras: { 'x"><script>alert(1)</script>': {} } }));
    const odd = await FRIGATE.load({ lang: "en", now: NOW });
    assert.equal(odd.items[0].image, "/api/frigate/x%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E/latest.jpg");
    const html = addonWidgetHtml({ id: "addon-frigate-cameras", title: { en: "Cameras" } }, normalizeAddonSummary(odd), "en");
    assert.ok(!html.includes("<script>alert(1)"));
  } finally {
    FRIGATE._resetForTest();
  }
});

test("frigate: a failed read throws, and the failure is remembered for a minute", async () => {
  FRIGATE._resetForTest();
  let calls = 0;
  try {
    FRIGATE._setFetchForTest(async () => { calls++; throw new Error("frigate is down"); });
    await assert.rejects(() => FRIGATE.load({ lang: "en", now: 1000 }), /frigate is down/);
    assert.equal(calls, 1);
    await assert.rejects(() => FRIGATE.load({ lang: "en", now: 2000 }), /unreachable/, "within the minute it does not ask again");
    assert.equal(calls, 1, "Frigate is not asked twice");
    // A minute later the widget tries again.
    FRIGATE._setFetchForTest(async () => ({ cameras: { front: {} } }));
    const later = await FRIGATE.load({ lang: "en", now: 1000 + 61_000 });
    assert.equal(later.state, "ok");
  } finally {
    FRIGATE._resetForTest();
  }
});

test("frigate: a cell that fails is the grid's error line, and the rest of the page still draws", async () => {
  const id = bundleId("broken");
  installBundle(id, {
    manifest: manifestFor(id, [{ id: "one", title: "One", sizes: [[2, 1]] }, { id: "two", title: "Two", sizes: [[2, 1]] }]),
    widgets: {
      one: 'export async function load() { throw new Error("no"); }\n',
      two: 'export async function load() { return { state: "ok", headline: "fine" }; }\n',
    },
  });
  setInstalled([id]);
  const cells = await loadWidgets(addonWidgets(HOME), { lang: "en", now: NOW }, { log: () => {} });
  assert.deepEqual(cells.map((c) => (c.failed ? "failed" : "ok")), ["failed", "ok"]);
  const html = gridHtml("widgets", cells, "en");
  assert.match(html, /data-widget="addon-[a-z0-9-]*-one"/);
  assert.match(html, /This widget couldn't load just now/);
  assert.match(html, /fine/, "the sibling still draws");
});

// ─── the bundle contract ───────────────────────────────────────────────────

function contractBundle(files) {
  const root = mkdtempSync(join(dir, "contract-"));
  const bdir = join(root, "demo");
  mkdirSync(bdir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const p = join(bdir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  return bdir;
}

const CONTRACT_BASE = { id: "demo", name: "Demo", description: "d", type: "bundle", category: "misc" };

test("bundle contract: a widgets declaration is shape-checked, and its loader file must exist", () => {
  const withFile = contractBundle({ "widgets/cams.js": "x" });
  const ok = validateManifest({ ...CONTRACT_BASE, widgets: [DECL] }, withFile);
  assert.equal(ok.ok, true, ok.errors.join("; "));
  assert.deepEqual(detectSurfaces({ ...CONTRACT_BASE, widgets: [DECL] }), ["widgets"]);
  assert.deepEqual(detectSurfaces({ ...CONTRACT_BASE, widgets: [] }), [], "an empty list declares nothing");

  const missing = contractBundle({});
  const gone = validateManifest({ ...CONTRACT_BASE, widgets: [DECL] }, missing);
  assert.equal(gone.ok, false);
  assert.ok(gone.errors.some((e) => e.includes("widgets/cams.js not found")), gone.errors.join("; "));

  const twice = contractBundle({ "widgets/cams.js": "x" });
  const dup = validateManifest({ ...CONTRACT_BASE, widgets: [DECL, { ...DECL, title: "Other" }] }, twice);
  assert.equal(dup.ok, false);
  assert.ok(dup.errors.some((e) => /duplicate id/.test(e)), dup.errors.join("; "));

  const badSize = validateManifest({ ...CONTRACT_BASE, widgets: [{ id: "cams", title: "Cams", sizes: [[3, 1]] }] }, withFile);
  assert.equal(badSize.ok, false);
  assert.ok(badSize.errors.some((e) => e.startsWith("shape")), badSize.errors.join("; "));

  for (const bad of [
    { id: "../x", title: "T", sizes: [[2, 1]] },
    { id: "A", title: "T", sizes: [[2, 1]] },
    { id: "cams", title: "T".repeat(61), sizes: [[2, 1]] },
    { id: "cams", title: { es: "Solo español" }, sizes: [[2, 1]] },
    { id: "cams", title: "T", sizes: [] },
    { id: "cams", title: "T", sizes: [[2, 1]], module: "widgets/other.js" },
  ]) {
    assert.equal(validateManifest({ ...CONTRACT_BASE, widgets: [bad] }, withFile).ok, false, JSON.stringify(bad));
  }
});