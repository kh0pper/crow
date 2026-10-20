/**
 * The player-bar shell for first-party pages without the dashboard layout (bar on every Crow page,
 * 2026-10-16): servers/gateway/dashboard/shared/player-shell.js.
 *
 * One fragment, placed before </body> by a route that has ALREADY passed dashboardAuth: the design
 * tokens, the bar with no sidebar offset, a top-level-only guard that runs before the player, the
 * player script itself (verbatim, one implementation), and the script that reserves the bar's height
 * in --crow-player-h.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { playerShellHtml } from "../servers/gateway/dashboard/shared/player-shell.js";
import { playerBarHtml, playerBarJs, PLAYER_RESERVE_JS } from "../servers/gateway/dashboard/shared/player.js";
import { designTokensCss } from "../servers/gateway/dashboard/shared/design-tokens.js";
import { t, translations } from "../servers/gateway/dashboard/shared/i18n.js";

const scripts = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

test("the shell carries the bar, the audio, the tokens, and a zero sidebar offset scoped to the bar", () => {
  for (const lang of ["en", "es"]) {
    const html = playerShellHtml(lang);
    assert.match(html, /id="crow-player-bar"/);
    assert.match(html, /id="crow-audio"/);
    assert.ok(html.includes(designTokensCss()), "the one token source, verbatim");
    assert.match(html, /#crow-player-bar\{--crow-sidebar-width:0px;font-family:var\(--crow-body-font\);color:var\(--crow-text-primary\)\}/, "no sidebar; the dashboard's font and ink, not the host page's");
  }
});

test("one implementation: the bar HTML and the player script are embedded verbatim", () => {
  for (const lang of ["en", "es"]) {
    const html = playerShellHtml(lang);
    assert.ok(html.includes(playerBarHtml(lang)));
    assert.ok(scripts(html).includes(playerBarJs(lang)));
  }
});

test("the top-level guard runs BEFORE the player script and removes the bar inside a frame", () => {
  const html = playerShellHtml("en");
  const s = scripts(html);
  const guardIdx = s.findIndex((x) => x.includes("window.top !== window"));
  const playerIdx = s.indexOf(playerBarJs("en"));
  assert.ok(guardIdx >= 0 && playerIdx > guardIdx, "guard first");
  for (const [framed, kept] of [[true, false], [false, true]]) {
    const { document, window } = parseHTML(`<html><body>${playerBarHtml("en")}</body></html>`);
    const top = framed ? {} : null;
    const win = { document };
    win.top = framed ? top : win;
    new Function("window", "document", s[guardIdx])(win, document);
    assert.equal(!!document.getElementById("crow-player-bar"), kept, framed ? "framed: no bar" : "top-level: bar kept");
    assert.equal(!!document.getElementById("crow-audio"), kept);
    void window;
  }
});

test("every emitted script parses, with no backtick and no leaked ${ from the template", () => {
  for (const lang of ["en", "es"]) {
    const html = playerShellHtml(lang);
    assert.ok(!html.includes("`"), "no backtick");
    assert.ok(!html.includes("${"), "no template leak");
    for (const src of scripts(html)) assert.doesNotThrow(() => new Function(src));
  }
});

// ─── the reserve (one copy, in the player core; 2026-10-20) ─────────────────
// player.js exports PLAYER_RESERVE_JS and playerBarJs emits it, so dashboard layout pages AND the shell
// pages get the same reserve. These run it in linkedom with the browser APIs stubbed.

/** A fake window + stubs; run(doc) runs the reserve against `doc` with the same window (a Turbo visit keeps it). */
function reserveHarness({ resizeObserver = true, fonts = null } = {}) {
  const mos = [], ros = [], listeners = {};
  function MutationObserver(fn) { this.fn = fn; mos.push(this); }
  MutationObserver.prototype.observe = function (target, opts) { this.target = target; this.opts = opts; };
  function ResizeObserver(fn) { this.fn = fn; this.targets = []; ros.push(this); }
  ResizeObserver.prototype.observe = function (target) { this.targets.push(target); };
  const win = { addEventListener: (k, fn) => { (listeners[k] ||= []).push(fn); } };
  const run = (document) => {
    if (fonts) Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
    new Function("window", "document", "MutationObserver", "ResizeObserver", PLAYER_RESERVE_JS)(win, document, MutationObserver, resizeObserver ? ResizeObserver : undefined);
  };
  return { mos, ros, listeners, win, run };
}
function barDoc(height = 57, extra = "") {
  const { document } = parseHTML(`<html><body>${extra}${playerBarHtml("en")}</body></html>`);
  const bar = document.getElementById("crow-player-bar");
  const box = { h: height };
  Object.defineProperty(bar, "offsetHeight", { configurable: true, get: () => (bar.style.display === "none" ? 0 : box.h) });
  return { document, bar, box, h: () => document.documentElement.style.getPropertyValue("--crow-player-h") };
}

test("one reserve: playerBarJs carries PLAYER_RESERVE_JS (so layout pages get it) and the shell carries no second copy", () => {
  for (const lang of ["en", "es"]) {
    assert.ok(playerBarJs(lang).includes(PLAYER_RESERVE_JS), "the player script runs the reserve");
    const html = playerShellHtml(lang);
    assert.equal(html.split(PLAYER_RESERVE_JS).length - 1, 1, "exactly one reserve in the shell output");
    assert.equal(html.split("setProperty('--crow-player-h'").length - 1, 1, "and no other setter beside it");
    assert.equal(scripts(html).filter((x) => x.includes("--crow-player-h")).length, 1, "one script sets the variable");
  }
  assert.ok(!PLAYER_RESERVE_JS.includes("`"), "no backtick in the reserve");
  assert.doesNotThrow(() => new Function(PLAYER_RESERVE_JS));
  assert.doesNotThrow(() => new Function(playerBarJs("en")));
});

test("the reserve runs BEFORE the player's no-bar return, so a framed shell page (bar removed) still gets 0px", () => {
  const js = playerBarJs("en");
  assert.ok(js.indexOf(PLAYER_RESERVE_JS) < js.indexOf("if (!audio || !bar) return;"));
  const { document } = parseHTML("<html><body><p>framed</p></body></html>");
  const H = reserveHarness();
  H.run(document);
  assert.equal(document.documentElement.style.getPropertyValue("--crow-player-h"), "0px");
});

test("a Turbo render with the permanent bar: the inline run finds no bar (Turbo holds it out of the page while the new body's scripts run), so it measures only a frame later (no 0px write and layout pass in between)", () => {
  const d = barDoc(57);
  d.bar.style.display = "block";
  const H = reserveHarness();
  H.run(d.document);                               // the first page load: observed, 57px
  assert.equal(d.h(), "57px");
  const held = d.bar;
  held.remove();                                   // Bardo: the permanent bar is out of the document
  const frames = [];
  H.win.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
  H.run(d.document);                               // the new body's player script runs now
  assert.equal(d.h(), "57px", "no bar in the page at this instant: nothing written until the frame");
  d.document.body.appendChild(held);               // Bardo puts it back; no style change on it
  d.box.h = 63;                                    // e.g. the new page's fonts: the frame must really measure
  assert.equal(frames.length, 1, "one frame scheduled");
  frames[0]();
  assert.equal(d.h(), "63px", "the frame measures the bar that came back");
});

test("the reserve sets --crow-player-h from the bar (0px hidden, its height shown), observes the bar once", () => {
  const d = barDoc(57);
  const H = reserveHarness();
  H.run(d.document);
  assert.equal(d.h(), "0px");
  d.bar.style.display = "block";
  H.mos[0].fn();
  assert.equal(d.h(), "57px");
  d.bar.style.display = "none";
  H.listeners.resize[0]();
  assert.equal(d.h(), "0px");
  H.run(d.document);
  assert.equal(H.mos.length, 1, "idempotent for the same bar: a Turbo render adds no second observer");
  assert.equal(d.bar.getAttribute("data-crow-player-reserve"), "1", "the once-guard is on the BAR, not on <html>");
});

test("I2: a NEW bar (a Turbo visit through a page without one) is observed; one window resize handler reads the current bar", () => {
  const H = reserveHarness();
  const d = barDoc(57);
  H.run(d.document);
  // Turbo keeps <html> (and its attributes, inline style) but the new body carries a fresh bar element.
  d.bar.remove();
  d.document.body.insertAdjacentHTML("beforeend", playerBarHtml("en"));
  const bar2 = d.document.getElementById("crow-player-bar");
  assert.notEqual(bar2, d.bar);
  Object.defineProperty(bar2, "offsetHeight", { configurable: true, get: () => (bar2.style.display === "none" ? 0 : 66) });
  H.run(d.document);
  assert.equal(H.mos.length, 2, "the new bar gets its own observer");
  assert.equal(H.mos[1].target, bar2);
  assert.equal(H.listeners.resize.length, 1, "one resize handler per window, not one per bar");
  bar2.style.display = "block";
  H.listeners.resize[0]();
  assert.equal(d.h(), "66px", "the resize handler resolves the CURRENT bar");
});

test("I3: the variable is written only when it changes; the observer watches the bar's own style only", (t) => {
  const d = barDoc(57);
  const H = reserveHarness();
  const proto = Object.getPrototypeOf(d.document.documentElement.style);
  const orig = proto.setProperty;
  let writes = 0;
  proto.setProperty = function (k) { if (k === "--crow-player-h") writes++; return orig.apply(this, arguments); };
  t.after(() => { proto.setProperty = orig; });
  H.run(d.document);
  d.bar.style.display = "block";
  for (let i = 0; i < 20; i++) H.mos[0].fn();     // 20 progress ticks
  H.ros[0].fn([]);
  assert.equal(writes, 2, "0px once, 57px once: " + writes);
  assert.deepEqual(H.mos[0].opts, { attributes: true, attributeFilter: ["style"] }, "no subtree, no characterData: progress/time ticks never wake it");
});

test("the reserve follows the bar's real height: a ResizeObserver on the bar, and web fonts loading", async () => {
  let fontsLoaded;
  const fonts = { ready: new Promise((r) => { fontsLoaded = r; }) };
  const d = barDoc(57);
  d.bar.style.display = "block";
  const H = reserveHarness({ fonts });
  H.run(d.document);
  assert.equal(d.h(), "57px");
  assert.equal(H.ros.length, 1, "a ResizeObserver");
  assert.deepEqual(H.ros[0].targets, [d.bar], "on the bar");
  d.box.h = 74; H.ros[0].fn([]);
  assert.equal(d.h(), "74px", "the bar grew (a wrapped title, a wider font): the reserve follows");
  d.box.h = 61; fontsLoaded(); await new Promise((r) => setImmediate(r));
  assert.equal(d.h(), "61px", "web fonts landing re-measure");
});

test("the reserve still works with no ResizeObserver and no document.fonts", () => {
  const d = barDoc(57);
  const H = reserveHarness({ resizeObserver: false });
  assert.doesNotThrow(() => H.run(d.document));
  assert.equal(d.h(), "0px");
});

test("Perch: a transcript pinned to its end stays pinned when the reserve changes (the chat column shrinks)", () => {
  const d = barDoc(57, '<div id="perch-transcript"></div>');
  const tr = d.document.getElementById("perch-transcript");
  // The column's height follows the variable, the way the layout makes it: 400px less the reserve.
  const reserve = () => parseInt(d.h(), 10) || 0;
  const geo = { scrollHeight: 1000, get clientHeight() { return 400 - reserve(); } };
  let top = 600;
  Object.defineProperty(tr, "scrollHeight", { get: () => geo.scrollHeight });
  Object.defineProperty(tr, "clientHeight", { get: () => geo.clientHeight });
  Object.defineProperty(tr, "scrollTop", { get: () => top, set: (v) => { top = Math.min(v, geo.scrollHeight - geo.clientHeight); } });
  const H = reserveHarness();
  H.run(d.document);                              // 0px, pinned: stays at the end
  d.bar.style.display = "block";                   // the column loses the bar's height
  H.mos[0].fn();
  assert.equal(top, 657, "re-pinned to the new end");
  top = 100;                                       // the reader scrolled up
  d.bar.style.display = "none";
  H.mos[0].fn();
  assert.equal(top, 100, "not pinned: left where the reader put it");
});

test("I4: adjustPosition() (every show path) reaches the reserve synchronously", () => {
  const js = playerBarJs("en");
  const m = /function adjustPosition\(\) \{([\s\S]*?)\n  \}/.exec(js);
  assert.ok(m, "adjustPosition exists");
  assert.match(m[1], /window\.__crowPlayerReserve\(\)/);
});

test("the bar clears the bottom safe area itself (its height, and so the reserve, includes it)", () => {
  assert.match(playerBarHtml("en"), /id="crow-player-bar"[^>]*padding:0 0 env\(safe-area-inset-bottom,0px\)/);
});

test("dark: the bar can be pinned to the dark tokens (a dark-only page), taken from the one token source", () => {
  const html = playerShellHtml("en", { dark: true });
  const darkBlock = /@media \(prefers-color-scheme: dark\) \{\s*:root \{([^}]*)\}/.exec(designTokensCss())[1];
  assert.ok(html.includes("#crow-player-bar{color-scheme:dark;" + darkBlock.trim().replace(/\s+/g, " ") + "}"));
  assert.ok(!playerShellHtml("en").includes("color-scheme:dark"), "not by default");
});

test("i18n: the new player strings exist in en and es and differ", () => {
  for (const k of ["player.ended", "player.dismiss"]) {
    assert.ok(translations[k], k);
    assert.ok(translations[k].en && translations[k].es && translations[k].en !== translations[k].es, k);
  }
  assert.equal(t("player.ended", "en"), "Playback ended");
});
