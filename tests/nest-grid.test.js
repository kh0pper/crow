// The Crow's Nest home grid (design quick win 3): one shared stroke icon set,
// one tile per app (no panel + bundle duplicates), a fixed priority order,
// two-line labels, and a compact phone header so the grid starts high.
//
// Two layers:
//   • static assertions on the renderer, icon set, sidebar and manifests;
//   • a live layout check in a private headless Chrome (skips without one,
//     throws under CROW_REQUIRE_TEST_CHROME=1). The builders are called
//     directly — no docker, no health probes — and the staggered reveal is
//     switched off so a measurement never catches a tile mid-animation.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const { registerPanel, getVisiblePanels } = await import("../servers/gateway/dashboard/panel-registry.js");
const { buildNestHTML } = await import("../servers/gateway/dashboard/panels/nest/html.js");
const { nestCSS } = await import("../servers/gateway/dashboard/panels/nest/css.js");
const { renderLayout } = await import("../servers/gateway/dashboard/shared/layout.js");

// The real core panels, registered the way dashboard/index.js does.
const CORE_FILES = [
  "health", "messages", "memory", "projects", "blog", "files", "extensions",
  "model-catalog", "skills", "settings", "contacts", "bot-builder", "bot-board",
  "design-system", "onboarding", "connect", "fediverse", "metering", "perch-hub",
];
const CORE = [];
for (const f of CORE_FILES) {
  const { default: p } = await import(`../servers/gateway/dashboard/panels/${f}.js`);
  CORE.push(p);
  registerPanel(p);
}
// The artifacts bundle registers a panel AND is an installed bundle.
const { default: artifactsPanel } = await import("../bundles/artifacts/panel/artifacts.js");
registerPanel(artifactsPanel);
// A bundle panel whose bundle ships a container (its dot is carried over).
registerPanel({ id: "dotbundle", name: "Dot Bundle", icon: "database", route: "/dashboard/dotbundle", navOrder: 140, handler() {} });
// A bundle panel that is hidden: its bundle keeps its own tile.
registerPanel({ id: "hiddenbundle", name: "Hidden Bundle", icon: "lock", route: "/dashboard/hiddenbundle", navOrder: 141, hidden: true, handler() {} });

// A real-world long bundle name: it must clamp to two lines, not spill.
const LONG_NAME = "Offline Block Coding (Scratch-compatible)";
const BUNDLES = [
  { id: "artifacts", name: "Artifacts", icon: "layers", isRunning: false, hasContainer: false, webUI: null },
  { id: "dotbundle", name: "Dot Bundle", icon: "database", isRunning: true, hasContainer: true, webUI: null },
  { id: "hiddenbundle", name: "Hidden Bundle", icon: "lock", isRunning: true, hasContainer: true, webUI: { port: 8701, path: "/" } },
  { id: "noicon", name: "No Icon Bundle", icon: null, isRunning: false, hasContainer: false, webUI: { port: 8702, path: "/" } },
  { id: "emojiicon", name: "Emoji Icon", icon: "\u{1F426}", isRunning: false, hasContainer: false, webUI: { port: 8703, path: "/" } },
  // Nothing to open: a model server with no web UI, and an orphan install
  // record whose manifest is gone (the data layer yields name = id, no webUI).
  { id: "noui-x", name: "Headless Model Server", icon: "cpu", isRunning: true, hasContainer: true, webUI: null },
  { id: "orphan-x", name: "orphan-x", icon: null, isRunning: false, hasContainer: false, webUI: null },
  { id: "changedetection-x", name: "Changedetection.io", icon: "eye", isRunning: true, hasContainer: true, webUI: { port: 5000, path: "/" } },
  { id: "stirling-x", name: "Stirling PDF", icon: "file-text", isRunning: true, hasContainer: true, webUI: { port: 8080, path: "/" } },
  { id: "abs-x", name: "Audiobookshelf", icon: "mic", isRunning: false, hasContainer: true, webUI: { port: 13378, path: "/" } },
  { id: "kolibri-x", name: "Kolibri", icon: "graduation-cap", isRunning: true, hasContainer: true, webUI: { port: 8090, path: "/" } },
  { id: "blocks-x", name: LONG_NAME, icon: "gamepad", isRunning: false, hasContainer: true, webUI: { port: 8601, path: "/" } },
  { id: "frigate-x", name: "Frigate", icon: "phone-video", isRunning: true, hasContainer: true, webUI: { port: 5001, path: "/" } },
];

function baseData(overrides = {}) {
  return { pinnedItems: [], bundles: BUNDLES, instances: [], trustedInstances: [], peerOverviews: [], ...overrides };
}

/** Every top-level tile in the local grid, in document order. */
function tiles(html) {
  const grid = html.slice(html.indexOf('<div class="nest-grid">'));
  return [...grid.matchAll(/<a href="([^"]*)" class="nest-app nest-app--(panel|bundle)"[^>]*>([\s\S]*?)<\/a>/g)]
    .map((m) => {
      const iconBlock = m[3].match(/<div class="nest-app-icon">([\s\S]*?)<\/div>\s*<div class="nest-app-label">/);
      return {
        href: m[1], kind: m[2], body: m[3],
        icon: iconBlock ? iconBlock[1].replace(/<span class="nest-app-status"[^>]*><\/span>/, "").trim() : "",
        label: (m[3].match(/<div class="nest-app-label">([\s\S]*?)<\/div>/) || [])[1],
        dot: /class="nest-app-status"/.test(m[3]),
      };
    });
}

const coreVisibleIds = () => CORE.filter((p) => p.id !== "nest" && p.hidden !== true).map((p) => p.id);

// ─── Icon set ───────────────────────────────────────────────────────────────

test("app-icons: one shared set with the keys later pages reuse", async () => {
  const { APP_ICONS, appIconSvg } = await import("../servers/gateway/dashboard/shared/app-icons.js");
  for (const k of ["home", "bot", "graduation-cap", "search", "git", "package", "layers", "folder", "kanban", "tool", "pie-chart", "share-2", "models"]) {
    assert.ok(Object.hasOwn(APP_ICONS, k), `APP_ICONS is missing "${k}"`);
    assert.match(appIconSvg(k), /^<svg [^>]*viewBox="0 0 24 24"[^>]*stroke="currentColor"/, `${k} is a stroke svg`);
  }
  assert.match(appIconSvg("bot", 18), /^<svg [^>]*width="18" height="18"/, "a sized icon carries width/height");
  assert.doesNotMatch(appIconSvg("bot"), /^<svg[^>]* width="/, "an unsized icon leaves sizing to CSS");
});

test("app-icons: aliases resolve; prototype keys and junk never do", async () => {
  const { appIconSvg, isAppIconKey } = await import("../servers/gateway/dashboard/shared/app-icons.js");
  for (const [alias, target] of [["document", "file-text"], ["phone-video", "video"], ["network", "share-2"], ["map-location-dot", "map"], ["building-columns", "landmark"]]) {
    assert.equal(appIconSvg(alias), appIconSvg(target), `${alias} → ${target}`);
    assert.ok(isAppIconKey(alias), `${alias} is allowlisted`);
  }
  for (const bad of ["__proto__", "constructor", "toString", "hasOwnProperty", "<svg onload=alert(1)>", "", null, undefined, 42]) {
    assert.equal(appIconSvg(bad), null, `appIconSvg(${String(bad)}) must be null`);
    assert.equal(isAppIconKey(bad), false, `isAppIconKey(${String(bad)}) must be false`);
  }
});

test("every bundle manifest icon and every bundle panel icon resolves (emoji falls back)", async () => {
  const { appIconSvg } = await import("../servers/gateway/dashboard/shared/app-icons.js");
  const missing = [];
  for (const d of readdirSync(join(ROOT, "bundles"))) {
    const mp = join(ROOT, "bundles", d, "manifest.json");
    if (existsSync(mp)) {
      let icon = null;
      try { icon = JSON.parse(readFileSync(mp, "utf8")).icon; } catch {}
      if (typeof icon === "string" && /^[a-z0-9-]+$/.test(icon) && !appIconSvg(icon)) missing.push(`${d}/manifest.json: ${icon}`);
    }
    const pd = join(ROOT, "bundles", d, "panel");
    if (!existsSync(pd)) continue;
    for (const f of readdirSync(pd).filter((x) => x.endsWith(".js"))) {
      const src = readFileSync(join(pd, f), "utf8");
      const m = src.match(/\n\s*(?:id:[^\n]*,\s*)?icon:\s*"([a-z0-9-]+)"/);
      if (m && !appIconSvg(m[1])) missing.push(`${d}/panel/${f}: ${m[1]}`);
    }
  }
  assert.deepEqual(missing, [], "icon keys that render nothing");
});

// ─── Grid ───────────────────────────────────────────────────────────────────

test("every visible core panel has its own icon on the grid", () => {
  const all = tiles(buildNestHTML(baseData(), "en"));
  const core = new Set(coreVisibleIds());
  const coreTiles = all.filter((t) => t.kind === "panel" && core.has(t.href.replace("/dashboard/", "")));
  assert.ok(coreTiles.length >= 12, `expected the core panels on the grid, got ${coreTiles.length}`);
  const seen = new Map();
  for (const t of coreTiles) {
    assert.ok(t.icon.startsWith("<svg"), `${t.href} has an svg icon`);
    assert.doesNotMatch(t.icon, /<circle cx="12" cy="12" r="10"\/><\/svg>$/, `${t.href} renders the empty fallback circle`);
    assert.ok(!seen.has(t.icon), `${t.href} shares its icon with ${seen.get(t.icon)}`);
    seen.set(t.icon, t.href);
  }
});

test("core panel manifests (incl. conditionally hidden ones) each resolve to a distinct icon", async () => {
  const { appIconSvg } = await import("../servers/gateway/dashboard/shared/app-icons.js");
  const seen = new Map();
  for (const p of CORE.filter((x) => x.id !== "nest" && x.hidden !== true)) {
    const svg = appIconSvg(p.icon);
    assert.ok(svg, `${p.id}: icon "${p.icon}" renders nothing`);
    assert.ok(!seen.has(svg), `${p.id} shares its icon with ${seen.get(svg)}`);
    seen.set(svg, p.id);
  }
});

test("one Artifacts tile: a bundle with a visible panel is not drawn twice", () => {
  const html = buildNestHTML(baseData(), "en");
  const all = tiles(html);
  const art = all.filter((t) => t.href === "/dashboard/artifacts" || /Artifacts/.test(t.label || ""));
  assert.equal(art.length, 1, `Artifacts tiles: ${JSON.stringify(art.map((t) => t.href))}`);
  assert.equal(art[0].kind, "panel");
  assert.ok(!art[0].dot, "a container-less bundle carries no running dot");
  assert.ok(!/A<\/div>/.test(art[0].body), "no letter avatar");
});

test("a container bundle's running dot moves onto its panel tile", () => {
  const all = tiles(buildNestHTML(baseData(), "en"));
  const dot = all.filter((t) => t.href === "/dashboard/dotbundle");
  assert.equal(dot.length, 1);
  assert.equal(dot[0].kind, "panel");
  assert.ok(dot[0].dot, "the panel tile carries the bundle's status dot");
  assert.match(dot[0].body, /nest-app-status[^>]*var\(--crow-success\)/, "running → success colour");
});

test("a web-UI bundle whose panel is hidden keeps its own bundle tile", () => {
  const all = tiles(buildNestHTML(baseData(), "en"));
  const hb = all.filter((t) => /Hidden Bundle/.test(t.label || ""));
  assert.equal(hb.length, 1);
  assert.equal(hb[0].kind, "bundle");
});

test("only openable bundles get a tile: no web UI and no panel means no tile", () => {
  for (const lang of ["en", "es"]) {
    const all = tiles(buildNestHTML(baseData(), lang));
    const labels = all.map((t) => t.label);
    assert.ok(!labels.includes("Headless Model Server"), `[${lang}] a no-UI bundle must not be a tile`);
    assert.ok(!labels.includes("orphan-x"), `[${lang}] an orphan record must not be a tile`);
    assert.equal(all.filter((t) => t.label === "Stirling PDF").length, 1, `[${lang}] a web-UI bundle still renders`);
    assert.equal(all.filter((t) => t.href === "/dashboard/artifacts").length, 1, `[${lang}] a no-UI bundle with a visible panel renders once, as its panel`);
  }
  // A hidden panel is not something to open either: without a web UI its bundle has no tile.
  const noUiHidden = BUNDLES.map((b) => b.id === "hiddenbundle" ? { ...b, webUI: null } : b);
  const hb = tiles(buildNestHTML(baseData({ bundles: noUiHidden }), "en")).filter((t) => /Hidden Bundle/.test(t.label || ""));
  assert.equal(hb.length, 0);
});

test("a direct-mode web UI tile keeps the Extensions href as its no-JS fallback", () => {
  const direct = [...BUNDLES, { id: "direct-x", name: "Direct App", icon: "eye", isRunning: true, hasContainer: true, webUI: { port: 8704, path: "/", proxyMode: "direct" } }];
  const t = tiles(buildNestHTML(baseData({ bundles: direct }), "en")).find((x) => x.label === "Direct App");
  assert.ok(t, "direct-mode tile renders");
  assert.equal(t.href, "/dashboard/extensions");
});

test("container-less bundle tiles show no status dot; container ones do", () => {
  const all = tiles(buildNestHTML(baseData(), "en"));
  const noicon = all.find((t) => /No Icon Bundle/.test(t.label || ""));
  const stirling = all.find((t) => /Stirling PDF/.test(t.label || ""));
  assert.ok(noicon && !noicon.dot, "no container → no dot");
  assert.ok(stirling && stirling.dot, "container → dot");
});

test("an icon-less or emoji-icon bundle gets the package glyph, never a letter avatar", async () => {
  const { appIconSvg } = await import("../servers/gateway/dashboard/shared/app-icons.js");
  const pkg = appIconSvg("package");
  const all = tiles(buildNestHTML(baseData(), "en"));
  for (const name of ["No Icon Bundle", "Emoji Icon"]) {
    const t = all.find((x) => (x.label || "").includes(name));
    assert.ok(t, name);
    assert.ok(t.icon.includes(pkg), `${name} renders the package glyph`);
    assert.doesNotMatch(t.body, /font-weight:600">[A-Z]<\/div>/, `${name} has no letter avatar`);
  }
  const kol = all.find((x) => (x.label || "").includes("Kolibri"));
  assert.ok(kol.icon.includes(appIconSvg("graduation-cap")), "a known manifest key renders its glyph");
});

test("priority order: Perch, Messages, Artifacts first; bundles after every panel", () => {
  const all = tiles(buildNestHTML(baseData(), "en"));
  assert.deepEqual(all.slice(0, 3).map((t) => t.href), ["/dashboard/perch", "/dashboard/messages", "/dashboard/artifacts"]);
  const lastPanel = all.map((t) => t.kind).lastIndexOf("panel");
  const firstBundle = all.map((t) => t.kind).indexOf("bundle");
  assert.ok(firstBundle > lastPanel, "bundle tiles come after panel tiles");
  const idx = (h) => all.findIndex((t) => t.href === h);
  assert.ok(idx("/dashboard/model-catalog") < idx("/dashboard/metering"), "listed panels before unlisted ones");
  assert.ok(idx("/dashboard/metering") < idx("/dashboard/extensions") && idx("/dashboard/extensions") < idx("/dashboard/settings"), "unlisted keep navOrder");
});

test("hidden panels never reach the grid", () => {
  const hrefs = tiles(buildNestHTML(baseData(), "en")).map((t) => t.href);
  for (const h of ["/dashboard/design-system", "/dashboard/onboarding", "/dashboard/nest", "/dashboard/hiddenbundle"]) {
    assert.ok(!hrefs.includes(h), `${h} must not be a tile`);
  }
});

test("Spanish labels for the newer panels", () => {
  const labels = tiles(buildNestHTML(baseData(), "es")).map((t) => t.label);
  for (const l of ["Constructor de bots", "Tablero de bots", "Uso", "Artefactos", "Perch Hub", "Mensajes"]) {
    assert.ok(labels.includes(l), `es label "${l}" missing from ${JSON.stringify(labels)}`);
  }
});

test("a pinned project uses the folder glyph", async () => {
  const { appIconSvg } = await import("../servers/gateway/dashboard/shared/app-icons.js");
  const html = buildNestHTML(baseData({ pinnedItems: [{ type: "project", id: "p1", label: "Thesis", href: "/dashboard/projects/p1" }] }), "en");
  const pinned = html.slice(html.indexOf('class="nest-pinned-item"'));
  assert.ok(pinned.includes(appIconSvg("folder")), "pinned project → folder");
});

// ─── Peer tiles ─────────────────────────────────────────────────────────────

function peerHtml(icon) {
  return buildNestHTML(baseData({
    trustedInstances: [{ id: "peer-a", name: "other", hostname: "other.example.ts.net", gateway_url: "https://other.example.ts.net" }],
    peerOverviews: [{
      status: "ok",
      instance: { id: "peer-a", name: "other", hostname: "other.example.ts.net" },
      tiles: [{ id: "x", name: "X", icon, pathname: "/dashboard/x", port: null, category: "local-panel" }],
    }],
  }), "en");
}
function peerIcon(html) {
  const sec = html.slice(html.indexOf('data-instance="peer-a"'));
  return sec.match(/<div class="nest-app-icon">([\s\S]*?)<\/div>/)[1];
}

test("peer tiles: an alias key, a new key, and a prototype key", async () => {
  const { appIconSvg } = await import("../servers/gateway/dashboard/shared/app-icons.js");
  assert.equal(peerIcon(peerHtml("phone-video")), appIconSvg("video"), "alias key resolves");
  assert.equal(peerIcon(peerHtml("bot")), appIconSvg("bot"), "new key renders");
  assert.equal(peerIcon(peerHtml("layers")), appIconSvg("layers"), "new key renders");
  assert.equal(peerIcon(peerHtml("project")), appIconSvg("project"), "legacy key from an older peer still renders");
  for (const bad of ["__proto__", "constructor", "toString"]) {
    const icon = peerIcon(peerHtml(bad));
    assert.ok(icon.startsWith("<svg"), `${bad} falls back to a real glyph`);
    assert.ok(!/function|\[object/.test(icon), `${bad} must not stringify a prototype member`);
  }
});

// ─── Sidebar ────────────────────────────────────────────────────────────────

test("the sidebar draws the shared icons too, and ignores prototype keys", async () => {
  const { appIconSvg } = await import("../servers/gateway/dashboard/shared/app-icons.js");
  const html = renderLayout({
    title: "t", content: "", activePanel: "x", lang: "en",
    panels: [
      { id: "artifacts", name: "Artifacts", icon: "layers", route: "/dashboard/artifacts", navOrder: 1 },
      { id: "weird", name: "Weird", icon: "constructor", route: "/dashboard/weird", navOrder: 2 },
    ],
  });
  const nav = (id) => html.match(new RegExp(`<a href="/dashboard/${id}" class="nav-item[^"]*"[^>]*>(<svg[\\s\\S]*?</svg>)`))[1];
  assert.equal(nav("artifacts"), appIconSvg("layers", 18));
  assert.match(nav("weird"), /<circle cx="12" cy="12" r="10"\/>/, "an unknown key falls back to the default circle");
});

// ─── Live layout ────────────────────────────────────────────────────────────

let chrome = null, server = null, port = 0, CDP = "", PAGE_HOST = "127.0.0.1";

const HEALTH_OK = { ok: true, issues: [], details: [
  { label: "CPU", value: "3%", state: "ok" }, { label: "RAM", value: "41%", state: "ok" },
  { label: "Disk", value: "62%", state: "ok" }, { label: "Docker", value: "12 up", state: "ok" },
] };
const HEALTH_WARN = { ok: false, details: HEALTH_OK.details, issues: [
  { severity: "warn", label: "Last backup was 9 days ago", actionLabel: "Back up now", actionHref: "/dashboard/nest?action=backup" },
  { severity: "info", label: "Two extensions have updates", actionLabel: "Review", actionHref: "/dashboard/extensions" },
] };

before(async () => {
  chrome = await startHeadlessChrome();
  if (!chrome) return;
  CDP = chrome.cdp; PAGE_HOST = chrome.pageHost;
  server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const lang = u.searchParams.get("lang") || "en";
    const healthSignals = u.searchParams.get("health") === "warn" ? HEALTH_WARN : HEALTH_OK;
    const content = nestCSS() + buildNestHTML(baseData({ healthSignals }), lang)
      + "<style>.nest-app{animation:none!important;opacity:1!important}</style>"
      // ?scale=150 stands in for a phone's font-size setting (Android Chrome
      // scales rem text the same way): every rem in the page grows by 1.5x.
      + (u.searchParams.get("scale") === "150" ? "<style>html{font-size:150%!important}</style>" : "");
    const html = renderLayout({ title: "Crow's Nest", content, activePanel: "nest", panels: getVisiblePanels(), lang });
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise((r) => server.listen(0, chrome.bindHost, r));
  port = server.address().port;
});
after(async () => { if (server) server.close(); if (chrome) await chrome.close(); });

async function measure(w, h, query, { dark = false } = {}) {
  const tab = await (await fetch(CDP + "/json/new?about:blank", { method: "PUT" })).json();
  const { default: WebSocket } = await import("ws");
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  let id = 0;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mine = ++id;
    const onMsg = (raw) => {
      const m = JSON.parse(raw);
      if (m.id !== mine) return;
      ws.off("message", onMsg);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result || {});
    };
    ws.on("message", onMsg);
    ws.send(JSON.stringify({ id: mine, method, params }));
  });
  const evalIn = async (expr) => {
    const out = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (out.exceptionDetails) throw new Error("page threw: " + JSON.stringify(out.exceptionDetails));
    return out.result.value;
  };
  try {
    await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile: w < 900 });
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
    await send("Page.enable");
    await send("Page.navigate", { url: `http://${PAGE_HOST}:${port}/dashboard/nest${query}` });
    let ok = false;
    for (let i = 0; i < 75 && !ok; i++) {
      await new Promise((r) => setTimeout(r, 200));
      try { ok = await evalIn("document.readyState==='complete' && document.querySelectorAll('.nest-grid .nest-app').length>0"); } catch { ok = false; }
    }
    assert.ok(ok, "the nest never rendered");
    await evalIn("new Promise(function(r){requestAnimationFrame(function(){requestAnimationFrame(function(){r(1);});});})");
    return JSON.parse(await evalIn(`JSON.stringify((function(){
      var LONG_NAME = ${JSON.stringify(LONG_NAME)};
      var apps = [].slice.call(document.querySelectorAll('.nest-grid .nest-app'));
      var vh = window.innerHeight, vw = document.documentElement.clientWidth;
      var full = apps.filter(function(a){ var b=a.getBoundingClientRect(); return b.top>=0 && b.bottom<=vh && b.left>=0 && b.right<=vw; }).length;
      // A label may clip only past two lines (the clamp), and only the one
      // fixture name that is long on purpose; nothing may spill sideways.
      var labels = [].slice.call(document.querySelectorAll('.nest-grid .nest-app-label'));
      var overflow = labels.filter(function(l){
        var lh = parseFloat(getComputedStyle(l).lineHeight);
        var clipped = l.scrollHeight > l.clientHeight + 1;
        // The clamp's ellipsis on the long fixture can widen scrollWidth, so
        // sideways spill is read from the rendered lines themselves too.
        var lb = l.getBoundingClientRect(), rg = document.createRange();
        rg.selectNodeContents(l);
        var spill = [].slice.call(rg.getClientRects()).some(function(x){ return x.width > 0 && (x.left < lb.left - 1 || x.right > lb.right + 1); });
        var wide = l.scrollWidth > l.clientWidth + 1 && !(clipped && l.textContent === LONG_NAME);
        return spill || wide || l.clientHeight > 2 * lh + 1 || (clipped && l.textContent !== LONG_NAME); }).map(function(l){ return l.textContent; });
      // A word is broken when its glyphs land on more than one line
      // ("Extension / s").
      var broken = [];
      [].slice.call(document.querySelectorAll('.nest-grid .nest-app')).forEach(function(app){
        var l = app.querySelector('.nest-app-label');
        if (!l || !l.firstChild || l.firstChild.nodeType !== 3) return;
        var node = l.firstChild, text = node.textContent, re = /\\S+/g, m;
        while ((m = re.exec(text))) {
          var r = document.createRange();
          r.setStart(node, m.index); r.setEnd(node, m.index + m[0].length);
          var tops = {};
          [].slice.call(r.getClientRects()).forEach(function(rc){ if (rc.width > 0) tops[Math.round(rc.top)] = 1; });
          var probe = document.createElement('span');
          probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap';
          probe.textContent = m[0];
          l.appendChild(probe);
          var w = probe.getBoundingClientRect().width;
          l.removeChild(probe);
          // Core (panel) labels must never break; a bundle's single word
          // wider than the whole cell ("Changedetection.io") may, as a last resort.
          var core = app.classList.contains('nest-app--panel');
          if (Object.keys(tops).length > 1 && (core || w <= app.clientWidth)) broken.push(text + ' [' + m[0] + ' ' + Math.round(w) + 'px in ' + app.clientWidth + 'px]');
        }
      });
      var bird = document.querySelector('.nest-welcome-crow');
      var bb = bird ? bird.getBoundingClientRect() : null;
      var bundleIcon = document.querySelector('.nest-grid .nest-app--bundle .nest-app-icon');
      return {
        firstTop: apps[0].getBoundingClientRect().top,
        total: apps.length, full: full, overflow: overflow, broken: broken,
        artifacts: document.querySelectorAll('.nest-grid a[href="/dashboard/artifacts"]').length,
        birdVisible: !!bb && bb.height > 0 && getComputedStyle(bird).display !== 'none',
        hScroll: document.documentElement.scrollWidth > vw + 1,
        bundleColor: bundleIcon ? getComputedStyle(bundleIcon).color : null,
      };
    })())`));
  } finally {
    ws.close();
    await fetch(CDP + "/json/close/" + tab.id).catch(() => {});
  }
}

test("live 412x915: the grid starts high and shows at least six rows", async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  for (const lang of ["en", "es"]) {
    const m = await measure(412, 915, `?lang=${lang}`);
    assert.ok(m.firstTop <= 250, `[${lang}] first tile top ${m.firstTop}px > 250px`);
    assert.ok(m.full >= 18, `[${lang}] only ${m.full} of ${m.total} tiles fully visible`);
    assert.deepEqual(m.overflow, [], `[${lang}] labels overflow their two lines`);
    assert.equal(m.artifacts, 1, `[${lang}] Artifacts tiles`);
    assert.equal(m.hScroll, false, `[${lang}] no horizontal scroll`);
  }
});

test("live 412x915 with two health warnings: still at least five rows", async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  const m = await measure(412, 915, "?health=warn");
  assert.ok(m.full >= 15, `only ${m.full} tiles fully visible under a warning strip`);
  assert.deepEqual(m.overflow, []);
});

test("live 412x915 dark: same budget, bundle tint from the dark rule", async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  const light = await measure(412, 915, "");
  const dark = await measure(412, 915, "", { dark: true });
  assert.ok(dark.firstTop <= 250 && dark.full >= 18, `dark: top ${dark.firstTop}, full ${dark.full}`);
  assert.deepEqual(dark.overflow, []);
  assert.notEqual(dark.bundleColor, light.bundleColor, "bundle glyph tint differs between light and dark");
});

test("live 1280x900: desktop keeps the greeting bird, one Artifacts tile, no overflow", async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  const m = await measure(1280, 900, "");
  assert.ok(m.birdVisible, "greeting bird visible on desktop");
  assert.equal(m.artifacts, 1);
  assert.deepEqual(m.overflow, []);
  assert.equal(m.hScroll, false);
});

test("live 412x915 + 1280x900 with text scaled to 150%: no word breaks inside a tile label", async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  for (const [w, h] of [[412, 915], [1280, 900]]) {
    for (const lang of ["en", "es"]) {
      const m = await measure(w, h, `?lang=${lang}&scale=150`);
      assert.deepEqual(m.broken, [], `[${w} ${lang} 150%] words broken mid-word`);
      assert.equal(m.hScroll, false, `[${w} ${lang} 150%] no horizontal scroll`);
    }
  }
});

test("live 412x915 at default text size: no word breaks either", async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  for (const lang of ["en", "es"]) {
    const m = await measure(412, 915, `?lang=${lang}`);
    assert.deepEqual(m.broken, [], `[${lang}] words broken mid-word`);
  }
});
