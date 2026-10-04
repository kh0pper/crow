// Dashboard-wide text size (A11Y-TEXTSIZE, 2026-10-03). One per-device
// preference (localStorage "crow-text-size"), applied on <html> as
// data-text-size by a pre-paint <head> script, mapped to --crow-text-scale and
// a rem root of calc(100% * scale). Settings › Text size and Perch's A− / A / A+
// both drive the SAME runtime; #407's per-chat key migrates once.
//
// Layers: static checks on every HTML shell + the CSS; the runtime executed
// in a vm against fake storage; i18n; and a live CDP check (skips without the
// shared Chrome) that the size is in force BEFORE the body is parsed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import vm from "node:vm";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";

const TS = await import("../servers/gateway/dashboard/shared/text-size.js");
const layout = await import("../servers/gateway/dashboard/shared/layout.js");

// ─── static: every shell applies it first thing in <head> ──────────────────

const SHELLS = {
  renderLayout: () => layout.renderLayout({ title: "T", content: "<p>x</p>", activePanel: "x", panels: [], lang: "en" }),
  renderLogin: () => layout.renderLogin({ lang: "en" }),
  render2faVerify: () => layout.render2faVerify({ lang: "en" }),
  render2faRecovery: () => layout.render2faRecovery({ lang: "en" }),
  render2faSetup: () => layout.render2faSetup({ lang: "en" }),
  renderResetRequest: () => layout.renderResetRequest({ lang: "en" }),
  renderResetForm: () => layout.renderResetForm({ lang: "en" }),
};

for (const [name, render] of Object.entries(SHELLS)) {
  test(`${name}: the text-size head script runs before any stylesheet and before <body>`, () => {
    const html = render();
    const script = TS.textSizeHeadScript();
    const at = html.indexOf(script);
    assert.ok(at > 0, "head script present");
    assert.ok(at > html.indexOf("<head>") && at < html.indexOf("</head>"), "inside <head>");
    const firstStyle = Math.min(...[html.indexOf("<style"), html.indexOf('rel="stylesheet"')].filter((i) => i >= 0));
    assert.ok(at < firstStyle, "before the first stylesheet — the attribute exists when styles are first computed");
    assert.ok(html.includes(TS.textSizeCss()), "the scale CSS ships with the shell");
  });
}

test("css: each step maps to --crow-text-scale; the root is 100% (the browser's own size) times the scale", async () => {
  const css = TS.textSizeCss();
  const { designTokensCss } = await import("../servers/gateway/dashboard/shared/design-tokens.js");
  assert.match(designTokensCss(), /--crow-text-scale: 1;/, "no attribute = exactly the browser's size");
  assert.match(designTokensCss(), /--crow-sidebar-width: 15rem;/, "the sidebar grows with the text, not clipping nav labels");
  for (const s of TS.TEXT_SIZES) {
    assert.ok(css.includes(`:root[data-text-size="${s.id}"]{--crow-text-scale:${s.scale}}`), s.id);
  }
  assert.match(css, /html\{font-size:calc\(100% \* var\(--crow-text-scale,1\)\)\}/,
    "a percentage root multiplies the user's browser font-size instead of overriding it");
  assert.doesNotMatch(css, /font-size:\s*\d+px/, "never a px root — that would ignore the browser setting");
  assert.deepEqual(TS.TEXT_SIZES.map((s) => s.id), ["small", "default", "large", "xlarge"]);
});

// ─── one source of truth ───────────────────────────────────────────────────

test("Perch and the dashboard read the same key through the same runtime", async () => {
  const { perchHubJs } = await import("../servers/gateway/dashboard/perch-hub/client.js");
  const { perchHubCss } = await import("../servers/gateway/dashboard/perch-hub/css.js");
  const js = perchHubJs("en");
  assert.ok(js.includes("window.crowTextSize||(window.crowTextSize=" + TS.textSizeRuntimeJs() + ")"),
    "Perch prefers the head script's runtime and falls back to the identical source");
  assert.ok(TS.textSizeHeadScript().includes(TS.textSizeRuntimeJs()));
  assert.equal(TS.TEXT_SIZE_KEY, "crow-text-size");
  // Outside the shared runtime (which names the old key only to migrate it),
  // Perch names no key and no scale of its own.
  const own = js.split(TS.textSizeRuntimeJs()).join("");
  assert.doesNotMatch(own, /localStorage|crow\.perch\.textSize|--perch-text-scale/, "Perch holds no key or scale of its own");
  assert.match(perchHubCss(), /#perch-tab-chat\{--pts:var\(--crow-text-scale,1\)/);
});

test("Settings › Text size: four radios over the shared runtime, no server state", async () => {
  const { default: section } = await import("../servers/gateway/dashboard/settings/sections/text-size.js");
  const { getSettingsSection } = await import("../servers/gateway/dashboard/settings/registry.js");
  await import("../servers/gateway/dashboard/panels/settings.js");
  assert.equal(getSettingsSection("text-size"), section, "registered");
  assert.equal(section.group, "general");
  for (const lang of ["en", "es"]) {
    const html = await section.render({ lang });
    const values = [...html.matchAll(/name="crow_text_size" value="([a-z]+)"/g)].map((m) => m[1]);
    assert.deepEqual(values, TS.TEXT_SIZES.map((s) => s.id));
    assert.match(html, /window\.crowTextSize/);
    assert.match(html, /TS\.set\(r\.value\)/);
    assert.doesNotMatch(html, /method="POST"/, "per device — nothing goes to the server");
  }
  assert.equal(await section.handleAction({}), false);
});

test("i18n: every new string exists in en and es and is actually translated", async () => {
  const { t } = await import("../servers/gateway/dashboard/shared/i18n.js");
  const keys = ["settings.section.textSize", "settings.textSize.legend", "settings.textSize.sample",
    "settings.textSize.hint", ...TS.TEXT_SIZES.map((s) => s.labelKey)];
  for (const key of keys) {
    for (const lang of ["en", "es"]) assert.ok(t(key, lang) && t(key, lang) !== key, key + " " + lang);
    assert.notEqual(t(key, "es"), t(key, "en"), key + " translated");
  }
});

// ─── runtime, executed ─────────────────────────────────────────────────────

function fakeStorage(seed = {}) {
  const data = { ...seed };
  return { data, getItem(k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem(k, v) { data[k] = String(v); }, removeItem(k) { delete data[k]; } };
}
/** Run the real head script against a fake window. Returns the window. */
function runHead({ storage, throws = false } = {}) {
  const attrs = {};
  const listeners = {};
  const win = {
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    dispatchEvent(ev) { for (const fn of listeners[ev.type] || []) fn(ev); return true; },
    _fire(type, ev) { for (const fn of listeners[type] || []) fn(ev); },
  };
  if (throws) Object.defineProperty(win, "localStorage", { get() { throw new Error("SecurityError"); } });
  else if (storage) win.localStorage = storage;
  const document = { documentElement: { setAttribute(k, v) { attrs[k] = String(v); }, getAttribute(k) { return attrs[k] ?? null; } } };
  class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } }
  const src = TS.textSizeHeadScript().replace(/^<script>/, "").replace(/<\/script>$/, "");
  vm.runInNewContext(src, { window: win, document, CustomEvent });
  win.attr = () => attrs["data-text-size"];
  return win;
}

test("head script: applies the stored size to <html>", () => {
  for (const s of TS.TEXT_SIZES) {
    assert.equal(runHead({ storage: fakeStorage({ "crow-text-size": s.id }) }).attr(), s.id);
  }
  assert.equal(runHead({ storage: fakeStorage() }).attr(), "default");
  assert.equal(runHead({ storage: fakeStorage({ "crow-text-size": "huge" }) }).attr(), "default");
  assert.equal(runHead({ throws: true }).attr(), "default", "blocked storage still renders");
});

test("head script: migrates #407's per-chat key once, keeps a newer shared choice", () => {
  const store = fakeStorage({ "crow.perch.textSize": "4" });
  assert.equal(runHead({ storage: store }).attr(), "xlarge");
  assert.deepEqual(store.data, { "crow-text-size": "xlarge" });
  const both = fakeStorage({ "crow-text-size": "small", "crow.perch.textSize": "4" });
  assert.equal(runHead({ storage: both }).attr(), "small");
  assert.deepEqual(both.data, { "crow-text-size": "small" });
});

test("runtime: set() saves, applies and announces; another tab's change is followed", () => {
  const store = fakeStorage();
  const win = runHead({ storage: store });
  const seen = [];
  win.addEventListener("crow:text-size", (e) => seen.push(e.detail.size));
  assert.equal(win.crowTextSize.set("large"), true);
  assert.equal(store.data["crow-text-size"], "large");
  assert.equal(win.attr(), "large");
  assert.equal(win.crowTextSize.set("bogus"), false, "unknown ids are refused");
  assert.equal(win.attr(), "large");
  store.data["crow-text-size"] = "small";               // another tab wrote it
  win._fire("storage", { key: "crow-text-size" });
  assert.equal(win.attr(), "small");
  assert.deepEqual(seen, ["large", "small"]);
});

// ─── live: in force before the body is parsed ──────────────────────────────

// A PRIVATE headless Chrome per file (tests/fixtures/headless-chrome.mjs) —
// never the live crow-browser on :9223. Set in before().
let CDP = "(no headless Chrome)", BIND_HOST = "127.0.0.1", chrome = null;
let HOST_FROM_CONTAINER = "127.0.0.1";
let available = false, server = null, port = 0;

// The first thing in <body> records what the page looks like at that moment —
// before first paint, since the parser has not reached any content yet.
const PROBE = "<script>window.__atBodyStart={size:document.documentElement.getAttribute('data-text-size'),"
  + "root:parseFloat(getComputedStyle(document.documentElement).fontSize)};</script>";

// Real nav entries (labels resolve through i18n), so the sidebar has text to clip.
const NAV = ["messages", "contacts", "extensions", "models", "skills", "settings"].map((id, i) =>
  ({ id, name: id, icon: id, route: "/dashboard/" + id, navOrder: i }));

before(async () => {
  chrome = await startHeadlessChrome();
  available = !!chrome;
  if (!available) return;
  CDP = chrome.cdp; HOST_FROM_CONTAINER = chrome.pageHost; BIND_HOST = chrome.bindHost;
  const { default: section } = await import("../servers/gateway/dashboard/settings/sections/text-size.js");
  const content = await section.render({ lang: "en" });
  server = http.createServer((req, res) => {
    const html = layout.renderLayout({ title: "Text size", content, activePanel: "settings", panels: NAV, lang: "en" })
      .replace(/<body([^>]*)>/, (m) => m + PROBE);
    res.writeHead(200, { "content-type": "text/html" });
    res.end(html);
  });
  await new Promise((r) => server.listen(0, BIND_HOST, r));
  port = server.address().port;
});
after(async () => { if (server) server.close(); if (chrome) await chrome.close(); });

async function withTab(fn, { width = 1280, height = 900 } = {}) {
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
  const url = `http://${HOST_FROM_CONTAINER}:${port}/dashboard/settings`;
  const load = async () => {
    await send("Page.navigate", { url });
    for (let i = 0; i < 75; i++) {
      await new Promise((r) => setTimeout(r, 200));
      try { if (await evalIn("document.readyState==='complete'&&!!window.__atBodyStart")) return; } catch {}
    }
    throw new Error("page never loaded");
  };
  try {
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 900 });
    await send("Page.enable");
    return await fn({ evalIn, load });
  } finally {
    try { await evalIn("(function(){try{localStorage.removeItem('crow-text-size');localStorage.removeItem('crow.perch.textSize');}catch(e){}return 1;})()"); } catch {}
    ws.close();
    await fetch(CDP + "/json/close/" + tab.id).catch(() => {});
  }
}

test("live: the stored size is on <html> and the rem root is scaled before the body is parsed", async (t) => {
  if (!available) return t.skip("no CDP endpoint at " + CDP);
  await withTab(async ({ evalIn, load }) => {
    await load();
    await evalIn("localStorage.removeItem('crow-text-size'),1");
    await load();
    const base = await evalIn("window.__atBodyStart");
    assert.equal(base.size, "default");
    await evalIn("localStorage.setItem('crow-text-size','xlarge'),1");
    await load();
    const big = await evalIn("window.__atBodyStart");
    assert.equal(big.size, "xlarge");
    assert.ok(Math.abs(big.root - base.root * 1.4) < 0.1, `root ${base.root} -> ${big.root}`);
    assert.equal(await evalIn("document.querySelector('input[value=xlarge]').checked"), true, "Settings shows the stored size");
  });
});

test("live: picking a size in Settings applies at once; the old Perch key migrates on load", async (t) => {
  if (!available) return t.skip("no CDP endpoint at " + CDP);
  await withTab(async ({ evalIn, load }) => {
    await load();
    await evalIn("localStorage.removeItem('crow-text-size'),localStorage.setItem('crow.perch.textSize','0'),1");
    await load();
    assert.equal((await evalIn("window.__atBodyStart")).size, "small", "migrated before paint");
    assert.equal(await evalIn("localStorage.getItem('crow.perch.textSize')"), null);
    const before = await evalIn("parseFloat(getComputedStyle(document.documentElement).fontSize)");
    await evalIn("(function(){var r=document.querySelector('input[value=large]');r.click();return 1;})()");
    const after = await evalIn("parseFloat(getComputedStyle(document.documentElement).fontSize)");
    assert.equal(await evalIn("document.documentElement.getAttribute('data-text-size')"), "large");
    assert.equal(await evalIn("localStorage.getItem('crow-text-size')"), "large");
    assert.ok(Math.abs(after - before * (1.2 / 0.875)) < 0.1, `${before} -> ${after}`);
  });
});

const FIT = `(function(){
  var spans=[].slice.call(document.querySelectorAll('.sidebar .nav-item span'));
  var clipped=spans.filter(function(e){ return e.scrollWidth>e.clientWidth+1||e.getBoundingClientRect().height>parseFloat(getComputedStyle(e).lineHeight)*1.5; })
    .map(function(e){ return e.textContent; });
  var sb=document.querySelector('.sidebar').getBoundingClientRect().width;
  var mc=parseFloat(getComputedStyle(document.querySelector('.main-content')).marginLeft);
  return { n:spans.length, clipped:clipped, sidebar:sb, mainLeft:mc,
    docScrollX:document.documentElement.scrollWidth-innerWidth };
})()`;

test("live: at Extra large the sidebar grows with the text — no clipped nav labels, no sideways scroll", async (t) => {
  if (!available) return t.skip("no CDP endpoint at " + CDP);
  for (const width of [1280, 412]) {
    await withTab(async ({ evalIn, load }) => {
      const OPEN = "(function(){document.getElementById('sidebar').classList.add('open');return 1;})()";
      await load();
      await evalIn("localStorage.removeItem('crow-text-size'),1");
      await load();
      if (width < 900) await evalIn(OPEN);
      const base = await evalIn(FIT);
      await evalIn("localStorage.setItem('crow-text-size','xlarge'),1");
      await load();
      if (width < 900) await evalIn(OPEN);
      const m = await evalIn(FIT);
      assert.ok(Math.abs(m.sidebar - base.sidebar * 1.4) < 1, width + "px: sidebar " + base.sidebar + " -> " + m.sidebar + " (follows the text)");
      assert.equal(m.n, NAV.length, "the nav rendered");
      assert.deepEqual(m.clipped, [], width + "px: " + JSON.stringify(m));
      assert.equal(m.docScrollX, 0, width + "px: no horizontal page scroll");
      if (width >= 900) assert.ok(Math.abs(m.sidebar - m.mainLeft) < 1, "content starts where the wider sidebar ends");
    }, { width });
  }
});
