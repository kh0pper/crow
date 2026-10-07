/**
 * Phone-width guard for hand-rolled tab / nav / filter rows (2026-10).
 *
 * On a phone (Pixel 9a, 412px portrait; 390px on smaller phones) a panel's
 * own tab row built as a non-wrapping flex row ("Feed, For You, Playlists,
 * Briefings, Podcasts, Folders, Sources…") is wider than the screen, and the
 * whole panel pans sideways inside .content-body with the cards cut off at
 * the edge. The shared tabs() component (.tab-list) wraps; rows a panel
 * builds itself must too.
 *
 * Layers:
 *   1. the shared stylesheet wraps, on phones, inline-style flex rows of
 *      links/buttons and rows whose class ends in one of ROW_SUFFIXES
 *      (components-css.js, "phone rows");
 *   2. the source scan here (runs everywhere, CI included) fails on a panel
 *      source that hand-rolls a link/button row that does not say how it fits
 *      (flex-wrap:wrap, or overflow-x:auto for a side-scroller), and on a
 *      row-like class the shared guard cannot reach by name;
 *   3. the live half (headless Chrome) proves the CSS in a browser.
 *
 * Opt-out, one rule in the CSS comment, the scan and its failure message: a
 * row that deliberately stays on one line sets flex-wrap:nowrap AND
 * overflow-x:auto, so it scrolls itself instead of panning the page.
 * flex-wrap:nowrap alone is not an opt-out: the scan flags it.
 *
 * What the scan cannot see (recorded in the plan): rows assembled across
 * helper modules, rows built by DOM calls (createElement/appendChild), and
 * rows whose link markup comes from a function in another file. The CSS
 * guard still applies to those at runtime.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { componentsCss } from "../servers/gateway/dashboard/shared/components-css.js";

const ROOT = new URL("..", import.meta.url).pathname;

/** Row-class suffixes the shared guard wraps by name. Keep in step with the
 *  "*-tabs, *-tabbar, …" list in components-css.js (asserted below). */
export const ROW_SUFFIXES = ["tabs", "tabbar", "nav", "chips", "toolbar", "filters", "pills"];

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "vendor") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(m?js)$/.test(name)) out.push(p);
  }
  return out;
}

/** Every dashboard source: the gateway dashboard + every bundle's panel(s) dir. */
function dashboardSources() {
  const files = walk(join(ROOT, "servers/gateway/dashboard"));
  for (const b of readdirSync(join(ROOT, "bundles"))) {
    for (const d of ["panel", "panels"]) walk(join(ROOT, "bundles", b, d), files);
  }
  return files;
}

const lineAt = (src, idx) => src.slice(0, idx).split("\n").length;
const isRowFlex = (decl) =>
  /display\s*:\s*(inline-)?flex/.test(decl) && !/flex-direction\s*:\s*column/.test(decl) &&
  !/flex-flow\s*:\s*column/.test(decl);
/** The row says how it fits: it wraps, or it scrolls itself. flex-wrap:nowrap
 *  without its own scroller does not count (it can still pan the page). */
const saysHowItFits = (decl) =>
  /flex-wrap\s*:\s*wrap|flex-flow\s*:[^;"']*\bwrap\b|overflow-x\s*:\s*(auto|scroll)|overflow\s*:\s*(auto|scroll)/.test(decl);
const LINKISH = /<(a|button)[\s>]/;

/** The element's own content: from the end of its opening tag to its matching close. */
function ownContent(src, styleIdx) {
  const open = src.lastIndexOf("<", styleIdx);
  const tag = (src.slice(open + 1).match(/^([a-zA-Z][a-zA-Z0-9-]*)/) || [])[1];
  if (!tag) return "";
  const start = src.indexOf(">", styleIdx) + 1;
  if (!start) return "";
  const re = new RegExp(`<(/?)${tag}(?=[\\s>/])`, "g");
  re.lastIndex = start;
  let depth = 1, m;
  while ((m = re.exec(src)) && m.index < start + 6000) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return src.slice(start, m.index);
  }
  return src.slice(start, start + 600);    // unmatched (concatenated markup): a bounded window
}

/** Text right after a definition of `name` in this file (const/let/var/function). */
function definitionOf(src, name) {
  const m = new RegExp(`(?:const|let|var|function)\\s+${name}\\b`).exec(src);
  return m ? src.slice(m.index, m.index + 900) : "";
}

/** Markup that starts with a link/button: the mapped item IS the link. */
const STARTS_LINKISH = /^\s*(?:\(\s*)?`?\s*<(a|button)[\s>]/;
/** A callback/definition whose produced item starts with a link/button. */
function producesLinkish(text) {
  for (const m of text.matchAll(/(?:=>|return)\s*/g)) {
    if (STARTS_LINKISH.test(text.slice(m.index + m[0].length, m.index + m[0].length + 40))) return true;
  }
  return false;
}

/** Does this content render a row of links/buttons? Returns a reason or null. */
function linkishList(src, own) {
  for (const m of own.matchAll(/((?:\[[^\]]*\])|[\w$.)\]]+)\.map\(\s*([\w$]+)?/g)) {
    const receiver = m[1];
    // A literal array of <= 3 items is a fixed segmented control (Day / Week), not a growing row.
    if (receiver.startsWith("[") && receiver.split(",").length <= 3) continue;
    const callback = m[2] && !/^(function|async)$/.test(m[2]) ? definitionOf(src, m[2]) : "";
    const body = own.slice(m.index, m.index + 700);
    if (producesLinkish(body) || (callback && producesLinkish(callback))) return "mapped list of links/buttons";
  }
  for (const m of own.matchAll(/\$\{\s*([\w$]+)\s*(?:\.join\([^)]*\))?\s*\}/g)) {
    const def = definitionOf(src, m[1]);
    if (/\.map\(/.test(def) && producesLinkish(def.slice(def.indexOf(".map(")))) return `list built in ${m[1]}`;
  }
  // Written out: a FLAT row (no nested block/form children) of 3+ links or 4+ buttons.
  if (!/<(div|form|section|ul|ol|table|p)[\s>]/.test(own)) {
    const links = (own.match(/<a[\s>]/g) || []).length, buttons = (own.match(/<button[\s>]/g) || []).length;
    if (links >= 3 || buttons >= 4 || links + buttons >= 4) return `${links + buttons} written-out links/buttons`;
  }
  return null;
}

/**
 * Offending rows in one source text:
 *  (a) an inline-style flex row (double or single quoted) that does not say
 *      how it fits and whose own content is a list of links/buttons: mapped
 *      inline, mapped through a named helper, built into a variable, or four
 *      or more written out — the shapes a tab / filter row takes;
 *  (b) a flex-row CSS rule for a row-like class (tab, nav, chip, toolbar,
 *      filter, pill, segment in its name) that does not say how it fits and
 *      whose name the shared guard does not reach (no ROW_SUFFIXES ending).
 */
export function findUnwrappedRows(src) {
  const bad = [];
  for (const m of src.matchAll(/style\s*=\s*(["'])([^"']*)\1/g)) {
    const decl = m[2];
    if (!isRowFlex(decl) || saysHowItFits(decl)) continue;
    const why = linkishList(src, ownContent(src, m.index));
    if (why) bad.push({ line: lineAt(src, m.index), kind: "inline", snippet: `${decl.slice(0, 80)} (${why})` });
  }
  const guarded = new RegExp(`-(${ROW_SUFFIXES.join("|")})$`);
  for (const m of src.matchAll(/(\.[A-Za-z][A-Za-z0-9_-]*)\s*\{([^{}]*)\}/g)) {
    const [, sel, decl] = m;
    if (!/(tab|nav|chip|toolbar|filter|pill|segment)/i.test(sel) || guarded.test(sel)) continue;
    if (!isRowFlex(decl) || saysHowItFits(decl)) continue;
    // Only the container rule counts: a single tab/chip item (.x-tab, .x-chip) is not a row.
    if (/(tab|chip|pill|filter|segment|item|btn|button|header|link|label|icon|badge|count|title|panel|body|content)$/i.test(sel)) continue;
    bad.push({ line: lineAt(src, m.index), kind: "class", snippet: (sel + " {" + decl.replace(/\s+/g, " ")).slice(0, 90) });
  }
  return bad;
}

test("the checker flags the hand-rolled row shapes and passes rows that say how they fit (not vacuous)", () => {
  const rolled = '<div style="display:flex;gap:0.5rem">${tabs.map((t) => `<a href="?tab=${t.id}">${t.label}</a>`).join("")}</div>';
  assert.equal(findUnwrappedRows(rolled).length, 1, "Media's original shape");
  assert.equal(findUnwrappedRows(rolled.replace("display:flex;", "display:flex;flex-wrap:wrap;")).length, 0, "wraps");
  assert.equal(findUnwrappedRows(rolled.replace("display:flex;", "display:flex;flex-wrap:nowrap;overflow-x:auto;")).length, 0, "side-scroller");
  assert.equal(findUnwrappedRows(rolled.replace("display:flex;", "display:flex;flex-wrap:nowrap;")).length, 1, "nowrap alone is not an opt-out: it still pans a phone");
  assert.equal(findUnwrappedRows(rolled.replace("display:flex;", "display:flex;flex-flow:row nowrap;")).length, 1, "flex-flow nowrap alone is not an opt-out either");
  assert.equal(findUnwrappedRows(rolled.replace("display:flex;", "display:flex;flex-direction:column;")).length, 0, "a column");
  // The variants a review found the first scanner missed:
  assert.equal(findUnwrappedRows("const links = tabs.map((t) => `<a href=\"#\">${t}</a>`).join('');\nhtml = `<div style=\"display:flex\">${links}</div>`;").length, 1, "list built into a variable");
  assert.equal(findUnwrappedRows("function renderTab(t) { return `<a href=\"#\">${t}</a>`; }\nhtml = `<nav style=\"display:flex\">${tabs.map(renderTab).join('')}</nav>`;").length, 1, ".map(helper)");
  assert.equal(findUnwrappedRows('<div style="display:flex"><a href="#">All</a></span>${tabs.map((t) => `<a href="#">${t}</a>`).join("")}</div>').length, 1, "a fixed first link (and a stray close tag) before the map");
  assert.equal(findUnwrappedRows("<div style='display:flex'>${tabs.map((t) => `<a href=\"#\">${t}</a>`).join('')}</div>").length, 1, "single-quoted style");
  assert.equal(findUnwrappedRows('<div style="display:flex"><button>A</button><button>B</button><button>C</button><button>D</button></div>').length, 1, "written-out buttons");
  assert.equal(findUnwrappedRows('<div style="display:flex"><button>Save</button><button>Cancel</button></div>').length, 0, "two written-out buttons: an action pair, left to the CSS guard");
  assert.equal(findUnwrappedRows('<div style="display:flex">${["Day","Week"].map((d) => `<button>${d}</button>`).join("")}</div>').length, 0, "a fixed 2-item segmented control");
  assert.equal(findUnwrappedRows(".foo-toolbar { display:flex; gap:0 }").length, 0, "a guarded suffix: the CSS wraps it by name");
  assert.equal(findUnwrappedRows(".foo-tabrow { display:flex; gap:0 }").length, 1, "a row-like class the guard cannot reach by name");
  assert.equal(findUnwrappedRows(".foo-tab { display:flex; gap:0 }").length, 0, "a single tab item is not a row");
  assert.equal(findUnwrappedRows(".foo-tabrow { display:flex; overflow-x:auto }").length, 0, "a class side-scroller");
  assert.equal(findUnwrappedRows(".foo-tabrow { display:flex; flex-wrap:nowrap }").length, 1, "a class row with nowrap alone");
  assert.equal(findUnwrappedRows(".foo-tabrow { display:flex; flex-wrap:nowrap; overflow-x:auto }").length, 0, "a class row with nowrap and its own scroller");
});

test("no dashboard panel hand-rolls a tab/filter row of links that does not say how it fits a phone", () => {
  const offenders = [];
  for (const f of dashboardSources()) {
    for (const o of findUnwrappedRows(readFileSync(f, "utf8"))) offenders.push(`${relative(ROOT, f)}:${o.line} [${o.kind}] ${o.snippet}`);
  }
  assert.deepEqual(offenders, [], "these rows can be wider than a phone. Add flex-wrap:wrap (or use tabs() from shared/components.js); " +
    "a row that must stay on one line needs flex-wrap:nowrap + overflow-x:auto so it scrolls itself; " +
    `a row class should end in one of -${ROW_SUFFIXES.join(", -")} so the shared guard reaches it:\n` + offenders.join("\n"));
});

test("the shared stylesheet: phone rows wrap, link cards in grids shrink, nothing hides content", () => {
  const css = componentsCss().replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(css.includes("@media (max-width: 768px)"), "the row guard is scoped to phone widths");
  const phone = css.slice(css.indexOf("@media (max-width: 768px)"));
  assert.match(phone, /\[style\*="display:flex"\]/, "inline-style flex rows are matched");
  assert.match(phone, /:has\(> a \+ a/, "only rows of links/buttons, not every flex row");
  assert.match(phone, /\[style\*="overflow-x:auto"\]/, "an inline row that scrolls itself is left alone");
  for (const suf of ROW_SUFFIXES) {
    assert.ok(phone.includes(`[class$="-${suf}"]`) && phone.includes(`[class*="-${suf} "]`), `the guard and the scan agree on -${suf}`);
  }
  assert.match(phone, /flex-wrap:\s*wrap/);
  assert.match(css, /\.tab-list \{[^}]*flex-wrap:wrap/, "the shared tabs() row keeps wrapping");
  assert.match(css, /> :where\(a:not\(\.btn, \.badge[^)]*\)\) \{ min-width: 0; \}/, "only link cards in grids, never buttons/badges");
  assert.doesNotMatch(css, /overflow-wrap:\s*anywhere[^}]*\}[^]*h1|:where\(h1, h2/, "no global heading word-break (it shreds headings beside buttons)");
  assert.doesNotMatch(css, /\.content-body[^{]*\{[^}]*overflow-x:\s*hidden/, "no blanket overflow-x:hidden that hides content");
});

test("Contacts: the profile header's info column cannot be wider than the header (a long name breaks instead)", async () => {
  const { contactsCss } = await import("../servers/gateway/dashboard/panels/contacts/css.js");
  const css = contactsCss().replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(css, /\.profile-info \{\s*min-width: 0;\s*max-width: 100%;\s*\}/);
});

// ─── live (private headless Chrome; skips without one, e.g. in CI) ─────────
// The guard is CSS, so its proof is layout: the real renderLayout() page at
// phone sizes with one of each shape the audit found, measured in a browser.
import http from "node:http";
import { before, after } from "node:test";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";

const LONG = "crow-local/qwen3.6-35b-a3b-instruct-q4_k_m-" + "x".repeat(40);
const LABELS = ["Feed", "For You", "Playlists", "Briefings", "Podcasts", "Folders", "Sources", "Library"];
const FIXTURE = `
  <div id="inline-row" style="display:flex;gap:0.5rem;border-bottom:1px solid var(--crow-border)">
    ${LABELS.map((l) => `<a href="#" style="padding:0.4rem 0.75rem">${l}</a>`).join("")}</div>
  <style>.zz-tabs{display:flex;gap:0}.zz-tab{padding:0.6rem 1rem}</style>
  <div id="class-row" class="zz-tabs">${LABELS.map((l) => `<a class="zz-tab" href="#">${l}</a>`).join("")}</div>
  <!-- 1fr = minmax(auto,1fr): the Contacts grid on phones (<=640px) -->
  <div id="grid" class="zz-grid" style="display:grid;grid-template-columns:1fr">
    <a href="#" style="display:block"><div style="display:flex"><span style="flex-shrink:0">AB</span>
      <div style="flex:1;min-width:0"><div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${LONG}</div></div></div>
      <div class="meta">${LONG}</div></a></div>
  <!-- A heading beside a button that will not shrink (the drawer-header shape): the heading keeps
       whole words. The box scrolls by itself so the fixture never pans the page. -->
  <div style="width:260px;overflow-x:auto"><div id="hb" style="display:flex;justify-content:space-between;align-items:center;gap:0.5rem">
    <h3 style="margin:0">Configuración de notificaciones</h3><button type="button" style="white-space:nowrap">Cerrar configuración</button></div></div>
  <div id="ellipsis" style="display:flex;align-items:center;gap:0.5rem"><span style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${LONG}</span><span>3m</span></div>
  <div id="optout" style="display:flex;flex-wrap:nowrap;overflow-x:auto">${LABELS.map((l) => `<a href="#">${l}</a>`).join("")}</div>`;

let chrome = null, server = null, port = 0;
before(async () => {
  chrome = await startHeadlessChrome();
  if (!chrome) return;
  const { renderLayout } = await import("../servers/gateway/dashboard/shared/layout.js");
  const html = renderLayout({ title: "Rows", content: FIXTURE, activePanel: "x", panels: [], lang: "en" });
  server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(html); });
  await new Promise((r) => server.listen(0, chrome.bindHost, r));
  port = server.address().port;
});
after(async () => { if (server) server.close(); if (chrome) await chrome.close(); });

async function measure(w, h, expression, css = "") {
  const tab = await (await fetch(chrome.cdp + "/json/new?about:blank", { method: "PUT" })).json();
  const { default: WebSocket } = await import("ws");
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  let id = 0;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mine = ++id;
    const onMsg = (raw) => { const m = JSON.parse(raw); if (m.id !== mine) return; ws.off("message", onMsg);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result || {}); };
    ws.on("message", onMsg);
    ws.send(JSON.stringify({ id: mine, method, params }));
  });
  const evalIn = async (expr) => { const o = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (o.exceptionDetails) throw new Error(JSON.stringify(o.exceptionDetails)); return o.result.value; };
  try {
    await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile: true });
    await send("Page.navigate", { url: `http://${chrome.pageHost}:${port}/` });
    let ok = false;
    for (let i = 0; i < 75 && !ok; i++) { await new Promise((r) => setTimeout(r, 200)); try { ok = await evalIn("!!document.getElementById('optout')"); } catch {} }
    assert.ok(ok, "the fixture page never loaded");
    if (css) await evalIn(`(function(){var s=document.createElement('style');s.textContent=${JSON.stringify(css)};document.head.appendChild(s);return 1;})()`);
    await evalIn("new Promise(function(r){requestAnimationFrame(function(){requestAnimationFrame(function(){r(1);});});})");
    return JSON.parse(await evalIn(expression));
  } finally { ws.close(); await fetch(chrome.cdp + "/json/close/" + tab.id).catch(() => {}); }
}

const GEOMETRY = `(function(){
  var cb=document.querySelector('.content-body');
  function lines(id){ var tops={}; document.querySelectorAll('#'+id+' > *').forEach(function(e){ tops[Math.round(e.getBoundingClientRect().top)]=1; }); return Object.keys(tops).length; }
  function right(id){ return Math.round(document.getElementById(id).getBoundingClientRect().right); }
  return JSON.stringify({ body: cb.scrollWidth - cb.clientWidth, doc: document.documentElement.scrollWidth - innerWidth,
    limit: Math.round(cb.getBoundingClientRect().left + cb.clientWidth),
    inlineLines: lines('inline-row'), classLines: lines('class-row'), ellipsisLines: lines('ellipsis'),
    optoutLines: lines('optout'), gridRight: Math.round(document.querySelector('#grid > a').getBoundingClientRect().right), headingWords: (function(){ var h=document.querySelector('#hb h3'); var probe=document.createElement('span');
      probe.style.cssText='position:absolute;visibility:hidden;white-space:nowrap;font:inherit'; h.appendChild(probe);
      var widest=0; h.firstChild.textContent.split(' ').forEach(function(w){ probe.textContent=w; widest=Math.max(widest, probe.getBoundingClientRect().width); });
      h.removeChild(probe); return { h3: Math.round(h.getBoundingClientRect().width), widestWord: Math.round(widest) }; })() });
})()`;

for (const [w, h] of [[390, 844], [412, 730]]) {
  test(`live @${w}x${h}: tab rows wrap, a long name stays in its card, nothing pans sideways`, async (t) => {
    if (!chrome) return t.skip("no headless Chrome");
    const m = await measure(w, h, GEOMETRY);
    assert.equal(m.body, 0, "the panel pans sideways inside .content-body: " + JSON.stringify(m));
    assert.equal(m.doc, 0, "the page itself is wider than the screen: " + JSON.stringify(m));
    assert.ok(m.inlineLines > 1 && m.classLines > 1, "the tab rows wrap: " + JSON.stringify(m));
    assert.ok(m.gridRight <= m.limit, "the link card fits: " + JSON.stringify(m));
    assert.ok(m.headingWords.h3 >= m.headingWords.widestWord, "a heading beside a button keeps whole words (no mid-word breaks): " + JSON.stringify(m));
    assert.equal(m.ellipsisLines, 1, "a text + meta row keeps truncating instead of wrapping");
    assert.equal(m.optoutLines, 1, "a row that opts out (nowrap + its own overflow-x:auto) stays on one line");
  });
}

test("live @390x844: the test reaches the mechanism — without the phone-row rules the rows pan the panel again", async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  const m = await measure(390, 844, GEOMETRY, "#inline-row,#class-row{flex-wrap:nowrap !important}");
  assert.ok(m.body > 0, "knocking the wrap out must bring the overflow back: " + JSON.stringify(m));
});

test("live @390x844: the test reaches the mechanism — without the link-card min-width:0 the card overflows", async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  const m = await measure(390, 844, GEOMETRY, "#grid > *{min-width:auto !important}");
  assert.ok(m.gridRight > m.limit, "the card must overflow without the grid rule: " + JSON.stringify(m));
});

test("live @390x844: the heading check reaches the mechanism — a global overflow-wrap:anywhere would shred it", async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  const m = await measure(390, 844, GEOMETRY, "#hb h3{overflow-wrap:anywhere}");
  assert.ok(m.headingWords.h3 < m.headingWords.widestWord, "with anywhere the heading must break mid-word: " + JSON.stringify(m));
});
