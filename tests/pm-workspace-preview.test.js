/**
 * PM Workspace — the note editor's Preview tab is SERVER-rendered.
 *
 * The sink this pins: note content can be written by a bot (the pm-workspace
 * MCP create-note tool takes content_md), and the old editor ran it through
 * `marked.parse` in the browser and assigned the result to `preview.innerHTML`.
 * The gateway CSP allows inline handlers, so `<img src=x onerror=…>` was one
 * missing CDN load away from executing.
 *
 * What is pinned here:
 *   - POST /api/pm/notes/preview answers SANITIZED HTML (servers/blog/
 *     renderer.js renderBotMarkdown) for the classic hostile inputs,
 *   - ordinary markdown still renders (heading, list, link),
 *   - note text is BOT text: no image outside /blog/media/ survives (a note's
 *     `![x](/dashboard/logout)` used to fire a GET with the reader's
 *     cookies) and every link carries the Turbo prefetch opt-out,
 *   - the body cap matches the MCP tool's content_md cap, and the preview only
 *     RENDERS a note up to PREVIEW_RENDER_MAX (8_192 chars): marked's lexer is
 *     quadratic on mixed-delimiter emphasis, so the cap bounds render TIME, not
 *     just size. Over it the preview answers the note as ESCAPED TEXT in a <pre>
 *     with truncated:true instead of handing it to marked (65_535 chars of
 *     `*a_` blocked the event loop ~21.7 s; 8_192 chars cost ~0.4 s),
 *   - the route sits behind the same path-scoped auth as POST /api/pm/notes,
 *   - a failed renderer import answers ESCAPED TEXT in a <pre>, never raw
 *     markdown,
 *   - statically: the editor never calls marked and never assigns innerHTML
 *     from anything but the server's `html`; its truncated-banner line is
 *     textContent; the editor page no longer loads
 *     marked from the CDN (the drawing scripts are untouched); the planner's
 *     decide buttons carry their arguments in data-*, never in an onclick
 *     that interpolates the uid.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, "..");
const EDITOR_JS = join(REPO_ROOT, "bundles", "pm-workspace", "panel", "static", "note-text-editor.js");
const ROUTES_JS = join(REPO_ROOT, "bundles", "pm-workspace", "panel", "routes.js");
const PANEL_JS = join(REPO_ROOT, "bundles", "pm-workspace", "panel", "pm-workspace.js");
const ANCHOR = `<pre style="white-space:pre-wrap">`;

const authStub = (req, res, next) => (req.headers["x-test-auth"] ? next() : res.status(401).end());
const H = { "x-test-auth": "1", "content-type": "text/plain;charset=UTF-8" };

let server, base;
const saved = {};

async function mount(routesSpec) {
  const { default: pmRouter } = await import(routesSpec);
  const app = express();
  app.use(express.json());
  app.use(pmRouter(authStub));
  const srv = app.listen(0);
  await once(srv, "listening");
  return { srv, url: `http://127.0.0.1:${srv.address().port}` };
}

before(async () => {
  saved.CROW_APP_ROOT = process.env.CROW_APP_ROOT;
  process.env.CROW_APP_ROOT = REPO_ROOT;
  const mounted = await mount(`../bundles/pm-workspace/panel/routes.js?preview=${Date.now()}`);
  server = mounted.srv;
  base = mounted.url;
});

after(() => {
  server?.close();
  if (saved.CROW_APP_ROOT === undefined) delete process.env.CROW_APP_ROOT;
  else process.env.CROW_APP_ROOT = saved.CROW_APP_ROOT;
});

const preview = (md, headers = H) => fetch(base + "/api/pm/notes/preview", {
  method: "POST", headers, body: JSON.stringify({ content_md: md }),
});

/* ------------------------------------------------------- the sanitizing rail */

test("the route answers the classic hostile inputs with no live markup", async () => {
  const cases = [
    `<img src=x onerror=alert(1)>`,
    `<svg onload=alert(1)></svg>`,
    `<a href="javascript:alert(1)">x</a>`,
    `[x](javascript:alert(1))`,
  ];
  for (const md of cases) {
    const r = await preview(md);
    assert.equal(r.status, 200, md);
    const { html } = await r.json();
    assert.equal(typeof html, "string", md);
    // Asserted on MARKUP, not on substrings: a note that is nothing but a
    // refused image (raw `<img …>` is dropped by the bot renderer) answers the
    // escaped-source <pre>, where the words `onerror=…` are inert character
    // data. A live handler can only sit inside a tag.
    assert.doesNotMatch(html, /<[^>]*onerror/i, `no onerror attribute for ${md}: ${html}`);
    assert.doesNotMatch(html, /<[^>]*onload/i, `no onload attribute for ${md}: ${html}`);
    assert.doesNotMatch(html, /<[^>]*javascript:/i, `no javascript: URL for ${md}: ${html}`);
    assert.doesNotMatch(html, /<img[^>]*\ssrc="?x"?[^>]*>/i, `no live <img> for ${md}: ${html}`);
  }
});

test("ordinary markdown still renders: heading, list and link", async () => {
  const r = await preview("# Preview Title\n\n- one\n- two\n\n[link](https://example.com/page)");
  assert.equal(r.status, 200);
  const { html } = await r.json();
  assert.match(html, /<h1[^>]*>Preview Title<\/h1>/, html);
  assert.match(html, /<li[^>]*>one<\/li>/, html);
  assert.match(html, /<li[^>]*>two<\/li>/, html);
  assert.match(html, /<a href="https:\/\/example\.com\/page"[^>]*>link<\/a>/, html);
});

test("an empty body renders empty rather than failing", async () => {
  const r = await preview("");
  assert.equal(r.status, 200);
  assert.equal((await r.json()).html, "");
});

/* ------------------------------------------------------------------ the cap */

test("over-cap content_md is refused, not rendered", async () => {
  const r = await preview("x".repeat(200_001));
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.equal(typeof body.error, "string");
  assert.match(body.error, /too long/i);
  assert.equal(body.html, undefined, "a refused preview answers no markup");
});

/* --------------------------------------------------- bot output in the preview */

// A note can be written by a bot (the pm-workspace MCP create-note tool), so the
// preview is a bot-markdown sink: the same image rule and the same link opt-outs
// the Perch reply path has.
test("a note's images are bot images: /dashboard/logout fires nothing", async () => {
  // A markdown image is dropped to its alt text (the renderer's rule), a raw
  // HTML <img> disappears entirely — in neither case is there an <img> tag, so
  // the reader's browser never GETs the src with their cookies.
  for (const md of ["![x](/dashboard/logout)", '<img src="/dashboard/logout">']) {
    const r = await preview(md);
    assert.equal(r.status, 200, md);
    const { html } = await r.json();
    assert.doesNotMatch(html, /<img/i, `${md} → ${html}`);
  }
  const md = "![x](/dashboard/logout)";
  const { html } = await (await preview(md)).json();
  assert.doesNotMatch(html, /dashboard\/logout/, "a markdown image is alt text, not even a link: " + html);
});

test("bot links in the preview carry data-turbo-prefetch=\"false\"", async () => {
  const r = await preview("- [x](/dashboard/make/open/a/b)");
  assert.equal(r.status, 200);
  const { html } = await r.json();
  assert.match(html, /<a href="\/dashboard\/make\/open\/a\/b"[^>]*data-turbo-prefetch="false"/, html);
});

/* ------------------------- the render budget: long notes are TEXT, not a hang */

/** `pat` repeated and cut to exactly `len` chars. `*a_`, `_*a` and `**_a` are
 *  the mixed-delimiter bodies marked's lexer goes quadratic on (65_535 chars of
 *  `*a_` took ~21.7 s before this cap; `_a_` is the escape-dense control). */
const repeatPattern = (pat, len) => pat.repeat(Math.ceil(len / pat.length)).slice(0, len);
const pathological = (len) => repeatPattern("_a_", len);

/** Process CPU time, per bot-markdown-render.test.js: the render is synchronous
 *  and in THIS process, so wall-clock only adds the parallel suite's load. */
function cpuMs() { const u = process.cpuUsage(); return (u.user + u.system) / 1000; }

test("a 199 KB pathological note answers the escaped <pre> as truncated in under 1 s", async () => {
  const md = pathological(199_000);
  const t0 = performance.now();
  const r = await preview(md);
  const ms = performance.now() - t0;
  assert.equal(r.status, 200, "over the render budget is not an error: the editor shows the source");
  const body = await r.json();
  assert.equal(body.truncated, true);
  // Exact: the escaped text of the note, in the fallback <pre>, and nothing else
  // (the note holds no HTML-special characters, so escaping is the identity).
  assert.equal(body.html, ANCHOR + md + "</pre>");
  // Measured 36 ms on the review box (was ~21 s through renderMarkdown).
  assert.ok(ms < 1000, `199 KB pathological note answered in ${ms.toFixed(0)} ms (budget 1000)`);
});

// The budget is about TIME. Each of these bodies is quadratic in marked at 64 KB
// (~5-22 s, measured), yet at the 8_192-char render cap the whole round trip
// costs a few hundred milliseconds: that is what makes the cap the right rail.
test("8_192 chars of every mixed-delimiter body renders in under 1.5 s each", async (t) => {
  for (const pat of ["*a_", "_*a", "**_a", "_a_"]) {
    const md = repeatPattern(pat, 8_192);
    assert.equal(md.length, 8_192);
    const t0 = cpuMs();
    const r = await preview(md);
    const ms = cpuMs() - t0;
    assert.equal(r.status, 200, pat);
    const body = await r.json();
    assert.notEqual(body.truncated, true, `${pat}: the cap is INCLUSIVE — 8_192 chars still renders`);
    assert.match(body.html, /^<p>/, `${pat}: markdown was rendered: ${body.html.slice(0, 80)}`);
    assert.ok(!body.html.startsWith(ANCHOR), `${pat}: not the escaped-text fallback`);
    t.diagnostic(`8_192 chars of "${pat}" rendered in ${ms.toFixed(0)} ms`);
    assert.ok(ms < 1500, `8_192 chars of "${pat}" took ${ms.toFixed(0)} ms (budget 1500)`);
  }
});

// One char over the budget: marked is never called, so the answer is immediate
// even though the same body at 64 KB would block the loop for ~20 s.
test("8_193 and 65_535 chars of \"*a_\" answer the escaped <pre> as truncated in under 100 ms", async (t) => {
  for (const len of [8_193, 65_535]) {
    const md = repeatPattern("*a_", len);
    const t0 = cpuMs();
    const r = await preview(md);
    const ms = cpuMs() - t0;
    assert.equal(r.status, 200, `${len}: over the render budget is not an error`);
    const body = await r.json();
    assert.equal(body.truncated, true, `${len}: answered as text, so the editor shows the note`);
    assert.equal(body.html, ANCHOR + md + "</pre>", `${len}: the escaped source, nothing else`);
    t.diagnostic(`${len} chars of "*a_" answered in ${ms.toFixed(0)} ms`);
    assert.ok(ms < 100, `${len} chars of "*a_" answered in ${ms.toFixed(0)} ms (budget 100)`);
  }
});

/* ----------------------------------------------------------------- the auth */

test("auth: the preview route requires the same session as the note save route", async () => {
  assert.equal((await preview("# hi", {})).status, 401, "no session → refused");
  const save = await fetch(base + "/api/pm/notes", {
    method: "POST", headers: {}, body: JSON.stringify({ title: "t", content_md: "x" }),
  });
  assert.equal(save.status, 401, "the save route refuses the same way, so the preview mirrors it");
});

/* ---------------------------------------- the renderer's own failure fallback */

test("a failed renderer import answers escaped text in a <pre>, never raw markdown", async () => {
  // The installed shape: routes.js copied ALONE into <CROW_HOME>/panels, with
  // no repo around it to fall back to, so servers/blog/renderer.js is missing.
  const installed = mkdtempSync(join(tmpdir(), "pm-preview-noapproot-"));
  const previous = process.env.CROW_APP_ROOT;
  let mounted;
  try {
    mkdirSync(join(installed, "panels"), { recursive: true });
    copyFileSync(ROUTES_JS, join(installed, "panels", "pm-workspace-routes.js"));
    // Bare imports (`express`) must still resolve from the copied file.
    symlinkSync(join(REPO_ROOT, "node_modules"), join(installed, "node_modules"), "dir");
    process.env.CROW_APP_ROOT = installed;
    mounted = await mount(pathToFileURL(join(installed, "panels", "pm-workspace-routes.js")).href);
    const hostile = `<img src=x onerror="alert(1)"> "quoted"`;
    const r = await fetch(mounted.url + "/api/pm/notes/preview", {
      method: "POST", headers: H, body: JSON.stringify({ content_md: hostile }),
    });
    assert.equal(r.status, 200);
    const { html } = await r.json();
    assert.match(html, /^<pre style="white-space:pre-wrap">/, html);
    assert.doesNotMatch(html, /<img/i, `the tag is text, not markup: ${html}`);
    assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/, html);
  } finally {
    mounted?.srv.close();
    if (previous === undefined) delete process.env.CROW_APP_ROOT;
    else process.env.CROW_APP_ROOT = previous;
    rmSync(installed, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------- statics */

test("static: the editor never parses markdown and only ever writes the server's html", () => {
  const src = readFileSync(EDITOR_JS, "utf8");
  assert.doesNotMatch(src, /marked\.parse/, "no client-side marked parse left in the editor");
  assert.doesNotMatch(src, /typeof marked/, "no marked feature-detect either");
  assert.doesNotMatch(src, /function renderMarkdown\s*\(/, "the client-side renderMarkdown helper is gone");

  const assignments = src.match(/\.innerHTML\s*\+?=/g) || [];
  assert.deepEqual(assignments, [".innerHTML ="], "exactly one innerHTML assignment: " + assignments.join(","));
  assert.match(src, /preview\.innerHTML = data\.html;/,
    "the one assignment writes the route's `html` and nothing else");
});

test("static: the editor posts to the preview route and falls back to textContent", () => {
  const src = readFileSync(EDITOR_JS, "utf8");
  assert.match(src, /PM_BASE \+ "\/api\/pm\/notes\/preview"/, "the preview fetch goes to the server route");
  // While the answer is in flight, and if it fails, the markdown is TEXT.
  assert.match(src, /preview\.textContent = md;/, "the waiting/error path is textContent");
  assert.match(src, /renderPreview\(\);/, "the preview tab asks for a server render");
});

test("static: truncated:true shows a plain-text line above the preview, never html", () => {
  const src = readFileSync(EDITOR_JS, "utf8");
  assert.match(src, /data\.truncated === true/, "the server's truncated flag is what drives the line");
  // The line's text is a static string written with textContent; it is a
  // sibling of the preview so the one innerHTML assignment above stays the
  // only markup ever written.
  assert.match(src, /previewNote\.textContent = show \? "[^"]+"/, "textContent, with a static English string");
  assert.match(src, /insertBefore\(previewNote, preview\)/, "it sits above the preview");
  assert.doesNotMatch(src, /previewNote\.innerHTML/, "no innerHTML for the line");
  assert.match(src, /Long note: showing the text without formatting\./);
});

test("static: the editor page no longer loads marked from a CDN, the drawing scripts stay", () => {
  const src = readFileSync(ROUTES_JS, "utf8");
  assert.doesNotMatch(src, /cdn\.jsdelivr\.net\/npm\/marked/, "no marked script tag");
  assert.doesNotMatch(src, /marked\.min\.js/, "no marked bundle reference");
  // The drawing editor's scripts are out of scope and must survive.
  assert.match(src, /cdnjs\.cloudflare\.com\/ajax\/libs\/fabric\.js/, "fabric.js untouched");
  assert.match(src, /cdn\.jsdelivr\.net\/npm\/perfect-freehand@/, "perfect-freehand untouched");
});

test("static: the manifest version was bumped so installed copies refresh", () => {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "bundles", "pm-workspace", "manifest.json"), "utf8"));
  const [major, minor, patch] = manifest.version.split(".").map(Number);
  assert.ok(major === 1 && minor === 0 && patch >= 4,
    "1.0.4 or later so repairInstalledBundleAssets refreshes the installed panel: " + manifest.version);
});

test("static: planner decide buttons carry data-*, never an onclick with the uid", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  // No inline handler on the page interpolates a value any more: a uid inside
  // an onclick string literal only held because of the uid's shape.
  assert.doesNotMatch(src, /onclick="[^"]*\$\{/, "no onclick interpolating a value");
  assert.doesNotMatch(src, /pmPlanDecide\('[^']*\$\{/);
  assert.match(src, /data-uid="\$\{escapeHtml\(e\.uid\)\}"/, "the uid travels in a data attribute");
  assert.match(src, /data-pm-decide="approved"/, "the decision travels in a data attribute");
  assert.match(src, /data-pm-decide="cancelled"/, "all three decisions are covered");
  // One delegated listener reads them back and calls pmPlanDecide.
  assert.match(src, /addEventListener\('click'/, "a delegated click listener exists");
  assert.match(src, /closest\('\[data-pm-decide\]'\)/, "it matches only decide buttons");
  assert.match(src, /pmPlanDecide\(btn\.dataset\.uid/, "and passes the dataset values to pmPlanDecide");
});