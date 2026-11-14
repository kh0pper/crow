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
 *     renderer.js renderMarkdown) for the classic hostile inputs,
 *   - ordinary markdown still renders (heading, list, link),
 *   - the body cap matches the MCP tool's content_md cap,
 *   - the route sits behind the same path-scoped auth as POST /api/pm/notes,
 *   - a failed renderer import answers ESCAPED TEXT in a <pre>, never raw
 *     markdown,
 *   - statically: the editor never calls marked and never assigns innerHTML
 *     from anything but the server's `html`; the editor page no longer loads
 *     marked from the CDN (the drawing scripts are untouched).
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
    assert.doesNotMatch(html, /onerror/i, `no onerror for ${md}: ${html}`);
    assert.doesNotMatch(html, /onload/i, `no onload for ${md}: ${html}`);
    assert.doesNotMatch(html, /javascript:/i, `no javascript: for ${md}: ${html}`);
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