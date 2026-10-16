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
import { playerBarHtml, playerBarJs } from "../servers/gateway/dashboard/shared/player.js";
import { designTokensCss } from "../servers/gateway/dashboard/shared/design-tokens.js";
import { t, translations } from "../servers/gateway/dashboard/shared/i18n.js";

const scripts = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

test("the shell carries the bar, the audio, the tokens, and a zero sidebar offset scoped to the bar", () => {
  for (const lang of ["en", "es"]) {
    const html = playerShellHtml(lang);
    assert.match(html, /id="crow-player-bar"/);
    assert.match(html, /id="crow-audio"/);
    assert.ok(html.includes(designTokensCss()), "the one token source, verbatim");
    assert.match(html, /#crow-player-bar\{--crow-sidebar-width:0px\}/);
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

test("the reserve script sets --crow-player-h from the bar (0px hidden, its height shown) and installs once", () => {
  const html = playerShellHtml("en");
  const reserve = scripts(html).find((x) => x.includes("--crow-player-h"));
  assert.ok(reserve, "a reserve script exists");
  const { document } = parseHTML(`<html><body>${playerBarHtml("en")}</body></html>`);
  const bar = document.getElementById("crow-player-bar");
  Object.defineProperty(bar, "offsetHeight", { configurable: true, get: () => (bar.style.display === "none" ? 0 : 57) });
  const observers = [];
  function MutationObserver(fn) { this.fn = fn; observers.push(this); }
  MutationObserver.prototype.observe = function () {};
  const listeners = {};
  const win = { addEventListener: (k, fn) => { (listeners[k] ||= []).push(fn); } };
  const run = () => new Function("window", "document", "MutationObserver", reserve)(win, document, MutationObserver);
  run();
  const h = () => document.documentElement.style.getPropertyValue("--crow-player-h");
  assert.equal(h(), "0px");
  bar.style.display = "block";
  observers[0].fn();
  assert.equal(h(), "57px");
  bar.style.display = "none";
  listeners.resize[0]();
  assert.equal(h(), "0px");
  run();
  assert.equal(observers.length, 1, "idempotent: a second run (a Turbo render) adds no second observer");
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
