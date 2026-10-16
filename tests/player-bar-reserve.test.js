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
  assert.match(html, /<html lang="en">/, "the page's own words stay English; only the bar follows the cookie");
});

test("fileview: no session, no bar (401 from dashboardAuth)", async () => {
  const r = await get("/dashboard/fileview?path=" + encodeURIComponent(md), null);
  assert.equal(r.status, 401);
  assert.doesNotMatch(await r.text(), /crow-player-bar/);
});
