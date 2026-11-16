/**
 * PM Workspace — the drawing editor's two libraries are served from the bundle,
 * never from a CDN.
 *
 * The break this pins: the gateway CSP is `script-src 'self' 'unsafe-inline'`
 * (servers/gateway/index.js), so the editor page's CDN <script> for fabric.js
 * and its CDN importmap entry for perfect-freehand were both REFUSED and the
 * drawing editor could not boot. The fix vendors byte-identical copies of the
 * same pinned releases under panel/static and serves them from /pm/static/, with
 * the SAME sha384 Subresource Integrity values (which do match the local bytes —
 * asserted here with node:crypto, not taken on faith).
 *
 * What is pinned here:
 *   - the drawing page's markup references only /pm/static/ for both libraries,
 *     and no CDN host survives anywhere in the bundle,
 *   - each `integrity` value equals the sha384 of the file it guards,
 *   - GET /pm/static/<lib> answers 200 with a JavaScript content type (module
 *     scripts are refused without one),
 *   - the vendored perfect-freehand is a self-contained ESM file (the importmap
 *     has no relative parent to resolve its imports against),
 *   - the third-party notices exist and name both licenses,
 *   - the manifest version was bumped, so an installed copy refreshes.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, "..");
const BUNDLE_DIR = join(REPO_ROOT, "bundles", "pm-workspace");
const ROUTES_JS = join(BUNDLE_DIR, "panel", "routes.js");
const STATIC_DIR = join(BUNDLE_DIR, "panel", "static");

const FABRIC = "fabric-5.3.1.min.js";
const FREEHAND = "perfect-freehand-1.2.2.js";
const FABRIC_URL = `/pm/static/${FABRIC}`;
const FREEHAND_URL = `/pm/static/${FREEHAND}`;

const sri = (file) => "sha384-" + createHash("sha384").update(readFileSync(join(STATIC_DIR, file))).digest("base64");

const authStub = (req, res, next) => (req.headers["x-test-auth"] ? next() : res.status(401).end());
const H = { "x-test-auth": "1" };

let server, base, scratchHome, savedCrowHome;

before(async () => {
  // The router serves panel/static from <CROW_HOME>/bundles/pm-workspace, the
  // installed shape, so stand that up around the repo's bundle (same harness
  // shape as the other pm-workspace route tests).
  scratchHome = mkdtempSync(join(tmpdir(), "pm-assets-"));
  mkdirSync(join(scratchHome, "bundles"), { recursive: true });
  symlinkSync(BUNDLE_DIR, join(scratchHome, "bundles", "pm-workspace"), "dir");
  savedCrowHome = process.env.CROW_HOME;
  process.env.CROW_HOME = scratchHome;
  process.env.CROW_APP_ROOT = REPO_ROOT;

  const { default: pmRouter } = await import(`../bundles/pm-workspace/panel/routes.js?assets=${Date.now()}`);
  const app = express();
  app.use(pmRouter(authStub));
  const srv = app.listen(0);
  await once(srv, "listening");
  server = srv;
  base = `http://127.0.0.1:${srv.address().port}`;
});

after(() => {
  server?.close();
  if (savedCrowHome === undefined) delete process.env.CROW_HOME;
  else process.env.CROW_HOME = savedCrowHome;
  delete process.env.CROW_APP_ROOT;
  if (scratchHome) rmSync(scratchHome, { recursive: true, force: true });
});

/* ----------------------------------------------------------- the page's head */

const page = (path) => fetch(base + path, { headers: H }).then((r) => r.text());

test("the drawing page points both libraries at /pm/static/ and at no CDN", async () => {
  const r = await fetch(base + "/pm/notes/new", { headers: H });
  assert.equal(r.status, 200);
  const html = await r.text();

  assert.match(html, new RegExp(`"perfect-freehand":\\s*"${FREEHAND_URL.replace(/\./g, "\\.")}"`),
    "the importmap entry resolves perfect-freehand from the bundle");
  assert.match(html, new RegExp(`<script src="${FABRIC_URL.replace(/\./g, "\\.")}"`),
    "the fabric script tag is same-origin");

  assert.doesNotMatch(html, /cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com|https?:\/\/[^"']*\.js/i,
    "no CDN (or any off-origin script) left on the drawing page");
  // The editor module itself must survive the change.
  assert.match(html, /<script type="module" src="\/pm\/static\/note-editor\.js"><\/script>/);
});

test("no CDN URL remains anywhere in the bundle", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (name === "node_modules") continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(js|mjs|json|html|css|md)$/.test(name)) {
        const src = readFileSync(p, "utf8");
        const hit = src.match(/cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com/);
        if (hit) offenders.push(`${p.slice(REPO_ROOT.length + 1)}: ${hit[0]}`);
      }
    }
  };
  walk(BUNDLE_DIR);
  assert.deepEqual(offenders, [], "the vendored copies replace every CDN reference");
});

/* ------------------------------------------------- the integrity values match */

test("both integrity values equal the sha384 of the vendored file", async () => {
  const html = await page("/pm/notes/new");

  const fabricTag = html.match(new RegExp(`<script src="${FABRIC_URL.replace(/\./g, "\\.")}"[^>]*>`));
  assert.ok(fabricTag, "the fabric script tag exists");
  const fabricIntegrity = fabricTag[0].match(/integrity="([^"]+)"/);
  assert.ok(fabricIntegrity, "the fabric script carries an integrity attribute");
  assert.equal(fabricIntegrity[1], sri(FABRIC), "fabric's sha384 is the local file's sha384");

  const mapIntegrity = html.match(new RegExp(`"${FREEHAND_URL.replace(/\./g, "\\.")}":\\s*"(sha384-[^"]+)"`));
  assert.ok(mapIntegrity, "the importmap's integrity map is keyed by the local URL");
  assert.equal(mapIntegrity[1], sri(FREEHAND), "perfect-freehand's sha384 is the local file's sha384");
});

/* -------------------------------------------------- the static route's answer */

test("GET /pm/static/<lib> answers 200 with a JavaScript content type", async () => {
  for (const [url, file] of [[FABRIC_URL, FABRIC], [FREEHAND_URL, FREEHAND]]) {
    const r = await fetch(base + url, { headers: H });
    assert.equal(r.status, 200, url);
    const ct = r.headers.get("content-type") || "";
    assert.match(ct, /^(text|application)\/javascript\b/, `${url}: module scripts need a JS content type, got "${ct}"`);
    const body = await r.text();
    assert.equal("sha384-" + createHash("sha384").update(body).digest("base64"), sri(file),
      `${url}: the served bytes are the vendored file`);
    assert.ok(body.length > 1000, `${url}: a real library, not an error page`);
  }
});

test("the vendored perfect-freehand is self-contained ESM", () => {
  const src = readFileSync(join(STATIC_DIR, FREEHAND), "utf8");
  assert.match(src, /\bexport\s*\{/, "it is an ES module");
  assert.doesNotMatch(src, /^\s*import\s/m, "and it imports nothing (nothing to resolve against /pm/static/)");
});

/* ------------------------------------------------------ notices + version bump */

test("THIRD-PARTY-NOTICES names both libraries, versions, upstreams and MIT", () => {
  const notices = readFileSync(join(STATIC_DIR, "THIRD-PARTY-NOTICES.md"), "utf8");
  assert.match(notices, /fabric\.js 5\.3\.1/);
  assert.match(notices, /perfect-freehand 1\.2\.2/);
  assert.match(notices, /fabricjs\.com|github\.com\/fabricjs\/fabric\.js/);
  assert.match(notices, /github\.com\/steveruizok\/perfect-freehand/);
  assert.match(notices, /Printio \(Juriy Zaytsev, Maxim Chernyak\)/);
  assert.match(notices, /Stephen Ruiz Ltd/);
  assert.equal((notices.match(/MIT License/g) || []).length, 2, "one MIT notice per library");
});

test("the manifest version was bumped so installed copies refresh", () => {
  const manifest = JSON.parse(readFileSync(join(BUNDLE_DIR, "manifest.json"), "utf8"));
  assert.equal(manifest.version, "1.0.5", "a version bump is what makes repairInstalledBundleAssets refresh the panel");
  const registry = JSON.parse(readFileSync(join(REPO_ROOT, "registry", "add-ons.json"), "utf8"));
  const entry = (registry["add-ons"] || []).find((e) => e.id === "pm-workspace");
  assert.ok(entry, "the registry carries pm-workspace");
  assert.equal(entry.version, manifest.version, "registry/add-ons.json follows the manifest version");
});