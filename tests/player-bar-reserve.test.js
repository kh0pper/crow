/**
 * Bar on every Crow page (2026-10-16): pages that carry the player shell keep their content, bottom
 * sheets and floating buttons clear of the bar through --crow-player-h (set by the shell's reserve
 * script: the bar's height while it shows, else 0px).
 *
 *  - the artifact viewer (bundles/artifacts/panel/static/viewer.css + viewer-client.js);
 *  - the markdown file viewer (servers/gateway/routes/fileview.js), which also gains the shell itself.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express from "express";

const read = (rel) => readFileSync(new URL("../" + rel, import.meta.url), "utf8");
const VAR = "var(--crow-player-h,0px)";

test("viewer.css: the root's bottom padding adds the bar's height, on phones AND in the wide layout", () => {
  const css = read("bundles/artifacts/panel/static/viewer.css");
  assert.match(css, /#crow-artifact-viewer\{box-sizing:border-box;[^}]*padding:12px 16px calc\(96px \+ var\(--crow-player-h,0px\)\)/);
  const wide = /@media \(min-width:1024px\)\{([\s\S]*?)\n\}/.exec(css)[1];
  assert.ok(wide.includes(`#crow-artifact-viewer{padding-bottom:calc(24px + ${VAR})}`), "wide: still clear of the bar");
});

test("viewer.css: the phone sheet sits ON the bar (bottom = its height), the wide column's sticky height leaves room for it", () => {
  const css = read("bundles/artifacts/panel/static/viewer.css");
  const phone = /@media \(max-width:1023\.98px\)\{([\s\S]*?)\n\}/.exec(css)[1];
  assert.match(phone, new RegExp(`\\.cv-side\\{position:fixed;left:0;right:0;bottom:${VAR.replace(/[()]/g, "\\$&")};`));
  const wide = /@media \(min-width:1024px\)\{([\s\S]*?)\n\}/.exec(css)[1];
  assert.ok(wide.includes(`max-height:calc(100vh - 24px - ${VAR})`));
  assert.ok(css.includes(`.cv-selbar{position:fixed;left:16px;right:16px;bottom:calc(24px + ${VAR})`), "the selection button clears the bar too");
});

test("viewer-client.js: the docked selection button sits above the sheet AND the bar", () => {
  const js = read("bundles/artifacts/panel/static/viewer-client.js");
  assert.ok(js.includes(`selBar.style.bottom = docked ? "calc(" + (side.offsetHeight + 8) + "px + ${VAR})" : "";`));
});

// ─── fileview ────────────────────────────────────────────────────────────────

let srv, base, root, md;
before(async () => {
  root = mkdtempSync(join(tmpdir(), "fileview-bar-"));
  md = join(root, "doc.md");
  writeFileSync(md, "# Hello\n\nsome text\n");
  process.env.CROW_FILEVIEW_ROOT = root;
  const { default: fileviewRouter } = await import("../servers/gateway/routes/fileview.js");
  const app = express();
  const dashboardAuth = (req, res, next) => (/crow_session=good/.test(req.headers.cookie || "") ? next() : res.status(401).type("text/plain").send("login"));
  app.use(fileviewRouter(dashboardAuth));
  srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => { srv?.close(); rmSync(root, { recursive: true, force: true }); });

const get = (path, cookie = "crow_session=good") => fetch(base + path, { headers: cookie ? { cookie } : {} });

test("fileview: the page carries the player shell (dark-pinned, a dark page), padded for the bar, reloads instead of a Turbo render", async () => {
  const { playerShellHtml } = await import("../servers/gateway/dashboard/shared/player-shell.js");
  const r = await get("/dashboard/fileview?path=" + encodeURIComponent(md));
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(html.includes(playerShellHtml("en", { dark: true })), "the shell, dark");
  assert.ok(html.indexOf(playerShellHtml("en", { dark: true })) > html.indexOf('<div class="wrap">'));
  assert.ok(html.trimEnd().endsWith("</body></html>"));
  assert.ok(html.includes(`.wrap{max-width:820px;margin:0 auto;padding:2.5rem 1.25rem calc(5rem + ${VAR})}`));
  assert.match(html, /<meta name="turbo-visit-control" content="reload">/);
  assert.match(html, /<h1[^>]*>Hello<\/h1>/);
});

test("fileview: the bar follows the crow_lang cookie", async () => {
  const { playerShellHtml } = await import("../servers/gateway/dashboard/shared/player-shell.js");
  const html = await (await get("/dashboard/fileview?path=" + encodeURIComponent(md), "crow_session=good; crow_lang=es")).text();
  assert.ok(html.includes(playerShellHtml("es", { dark: true })));
  assert.match(html, /<html lang="es">/, "the document's language is the resolved one (the bar's words are in it)");
  assert.match(await (await get("/dashboard/fileview?path=" + encodeURIComponent(md))).text(), /<html lang="en">/, "no cookie: en");
});

test("fileview: under an es page, the page's own English words say so (lang=\"en\" on the not-found note)", async () => {
  const html = await (await get("/dashboard/fileview?path=" + encodeURIComponent(join(root, "missing.md")), "crow_session=good; crow_lang=es")).text();
  assert.match(html, /<html lang="es">/);
  assert.match(html, /<p lang="en">File not found/);
});

test("fileview: no session, no bar (401 from dashboardAuth)", async () => {
  const r = await get("/dashboard/fileview?path=" + encodeURIComponent(md), null);
  assert.equal(r.status, 401);
  assert.doesNotMatch(await r.text(), /crow-player-bar/);
});

// ─── dashboard layout pages (the reserve lives in the player core, 2026-10-20) ─────────────
// Pages built with renderLayout reserve the bar through --crow-player-h only (set by playerBarJs);
// tests/player-bar-reserve-live.test.js measures the result in a real browser.

const SAFE_MINUS_BAR = "max(0px, env(safe-area-inset-bottom, 0px) - var(--crow-player-h,0px))";
const noComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");
const ruleBody = (css, selector, from = 0) => {
  const i = css.indexOf(selector + " {", from) >= 0 ? css.indexOf(selector + " {", from) : css.indexOf(selector + "{", from);
  assert.ok(i >= 0, "missing rule " + selector);
  return css.slice(i, css.indexOf("}", i) + 1);
};

test("layout.js: a scrolling page pads .main-content by the bar; the app shells (phone, Perch) end at the bar", async () => {
  const css = noComments(read("servers/gateway/dashboard/shared/layout.js"));
  assert.match(ruleBody(css, ".main-content"), new RegExp(`padding-bottom: ${VAR.replace(/[()]/g, "\\$&")};`), "desktop: the last ~bar of every page can scroll clear");
  const phone = css.slice(css.indexOf("body.sidebar-open {"));     // the phone block's .main-content follows it
  const shells = [ruleBody(phone, ".main-content"), ruleBody(css, "body:has(#perch-chat) .main-content")];
  for (const r of shells) {
    assert.ok(r.includes(`height: calc(100vh - ${VAR});`), "vh fallback: " + r);
    assert.ok(r.includes(`height: calc(100dvh - ${VAR});`), "dvh: " + r);
    assert.ok(r.includes("min-height: 0;"), "C1: the base min-height:100vh must not win: " + r);
    assert.ok(r.includes("padding-bottom: 0;"), "the shell height already reserves: no double reserve: " + r);
  }
  assert.ok(css.includes(`.content-body { padding-bottom: ${SAFE_MINUS_BAR}; }`), "the safe area is not counted twice under the bar");
  assert.match(ruleBody(css, ".crow-toasts"), new RegExp(`bottom: calc\\(1\\.5rem \\+ ${VAR.replace(/[()]/g, "\\$&")}\\);`));
});

test("Perch: the tab bar's safe-area padding yields to the bar; the artifact pane (docked and full screen) ends at the bar", async () => {
  const { perchHubCss } = await import("../servers/gateway/dashboard/perch-hub/css.js");
  const css = noComments(perchHubCss());
  assert.ok(css.includes(`#perch-tabs{display:flex;gap:4px;flex-shrink:0;order:10;border-top:1px solid var(--line);\npadding:6px 0 calc(6px + ${SAFE_MINUS_BAR})}`));
  assert.ok(css.includes(`#perch-hub-root .art-pane-split{top:0;right:0;bottom:${VAR};`));
  assert.ok(css.includes(`#perch-hub-root .art-pane-sheet{inset:0;bottom:${VAR};`));
});

test("Bot Board: the phone picker sheet sits on the bar, the drawer ends at it", async () => {
  const { botBoardStyles } = await import("../servers/gateway/dashboard/panels/bot-board/css.js");
  const css = noComments(botBoardStyles());
  assert.ok(css.includes(`.bb-sheet{position:fixed;left:0;right:0;bottom:${VAR};top:auto;`));
  assert.ok(css.includes(`padding:.75rem .75rem calc(.75rem + ${SAFE_MINUS_BAR})}`));
  assert.ok(css.includes(`height:calc(100vh - ${VAR});height:calc(100dvh - ${VAR});`),
    "the drawer's vh fallback (no dvh support) leaves room for the bar too");
});

test("phone header dropdowns open above the bar", async () => {
  const { headerIconsCss, tamagotchiCss } = await import("../servers/gateway/dashboard/shared/notifications.js");
  assert.ok(headerIconsCss.includes(`.header-dropdown { position: fixed; top: auto; bottom: calc(60px + ${VAR});`));
  assert.ok(tamagotchiCss.includes(`.crow-dropdown { position: fixed; top: auto; bottom: calc(60px + ${VAR});`));
});

// ─── the reserve script, in a stub window (PLAYER_RESERVE_JS) ───────────────────────────────
// A minimal document/window: enough to count the variable's writes and the listeners the script adds.

async function reserveSandbox() {
  const vm = await import("node:vm");
  const { PLAYER_RESERVE_JS } = await import("../servers/gateway/dashboard/shared/player.js");
  const writes = [], frames = [], docListeners = [], winListeners = [];
  const props = {};
  const root = { style: {
    getPropertyValue: (k) => props[k] || "",
    setProperty: (k, v) => { writes.push([k, v]); props[k] = v; },
  } };
  let bar = null;
  const document = {
    documentElement: root,
    getElementById: (id) => (id === "crow-player-bar" ? bar : null),
    addEventListener: (type, fn) => docListeners.push([type, fn]),
  };
  const window = {
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
    addEventListener: (type, fn) => winListeners.push([type, fn]),
  };
  const ctx = vm.createContext({ window, document, MutationObserver: class { observe() {} } });
  return {
    run: () => vm.runInContext(PLAYER_RESERVE_JS, ctx),
    setBar: (b) => { bar = b; },
    writes, frames, docListeners, winListeners,
  };
}

test("reserve (no bar at run time, a Turbo visit): no 0px write before the frame — it measures only in the rAF", async () => {
  const sb = await reserveSandbox();
  sb.run();
  assert.deepEqual(sb.writes, [], "no immediate write while the bar is held out of the page");
  assert.equal(sb.frames.length, 1, "one frame scheduled");
  sb.setBar({ style: { display: "block" }, offsetHeight: 57, getAttribute: () => "1", setAttribute() {} });
  sb.frames[0]();
  assert.deepEqual(sb.writes, [["--crow-player-h", "57px"]], "the frame measures the bar that came back");
});

test("reserve: one turbo:load listener per window (re-runs on every visit add none), and it re-measures", async () => {
  const sb = await reserveSandbox();
  sb.setBar({ style: { display: "block" }, offsetHeight: 57, getAttribute: () => null, setAttribute() {} });
  sb.run();
  sb.run();
  sb.run();
  const loads = sb.docListeners.filter(([type]) => type === "turbo:load");
  assert.equal(loads.length, 1, "installed once per window");
  assert.equal(sb.winListeners.filter(([type]) => type === "resize").length, 1);
  sb.setBar(null);                                  // a page without the bar, reached by a Turbo visit
  loads[0][1]();
  assert.equal(sb.writes.at(-1)[1], "0px", "the variable follows to 0px there");
});
