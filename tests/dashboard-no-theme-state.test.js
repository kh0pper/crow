/**
 * Task 4 (Track 2 visual language): the dashboard has no theme state.
 *
 * design-tokens.js now emits light values on :root and dark values inside
 * @media (prefers-color-scheme: dark) (Task 3) — the OS decides, per spec
 * §3.3. This test guards that the dashboard's OWN theme machinery (the
 * .theme-light class, the sidebar toggle button + toggleTheme(), the
 * noise-texture overlay, and theme-resolver.js) is gone end to end,
 * including panels/nest/css.js's three .theme-light rules (plan-review
 * finding 7 — a two-file check misses those).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DASH = join(ROOT, "servers/gateway/dashboard");
const LAYOUT = join(DASH, "shared/layout.js");
const INDEX = join(DASH, "index.js");
const THEME_RESOLVER = join(ROOT, "servers/gateway/shared/theme-resolver.js");

// design-tokens-legacy.js is the FROZEN pre-rewrite token snapshot that the
// public blog (blog-public.js, songbook-renderer.js) and kb-public.js still
// import for their OWN theme mode — it is guarded by its own freeze test
// (tests/design-tokens-freeze.test.js) and lives under dashboard/shared/
// only because that's where the token modules live, not because it's part
// of the dashboard render path. It legitimately keeps `.theme-light` for
// the blog's separate, still-shipping mode toggle. Not this task's scope.
const EXEMPT = new Set([join(DASH, "shared/design-tokens-legacy.js")]);

function walk(dir) {
  let out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(p));
    else if (/\.(js|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

const dashboardFiles = walk(DASH).filter((f) => !EXEMPT.has(f));

test("no file in the dashboard tree (outside the frozen legacy blog token snapshot) references .theme-light", () => {
  for (const f of dashboardFiles) {
    const src = readFileSync(f, "utf8");
    assert.ok(!/theme-light/.test(src), `${relative(ROOT, f)} still references theme-light`);
  }
});

test("no file in the dashboard tree references toggleTheme", () => {
  for (const f of dashboardFiles) {
    const src = readFileSync(f, "utf8");
    assert.ok(!/toggleTheme/.test(src), `${relative(ROOT, f)} still references toggleTheme`);
  }
});

test("layout.js has no noise-texture / fractalNoise SVG overlay", () => {
  const src = readFileSync(LAYOUT, "utf8");
  assert.ok(!/fractalNoise/.test(src), "layout.js still has the fractalNoise noise overlay");
  assert.ok(!/feTurbulence/.test(src), "layout.js still has the feTurbulence noise-filter markup");
});

test("layout.js and dashboard/index.js no longer read theme_glass or theme_serif", () => {
  // Scoped to the dashboard render path only. settings/sections/theme.js
  // legitimately keeps blog_theme_glass/blog_theme_serif forever (it is
  // the "Blog theme" section, consumed by the frozen blog) and its own
  // theme_glass/theme_serif form-field strings until Task 5 retires glass
  // end to end — this test does not assert on that file.
  for (const f of [LAYOUT, INDEX]) {
    const src = readFileSync(f, "utf8");
    assert.ok(!/theme_glass/.test(src), `${relative(ROOT, f)} still reads theme_glass`);
    assert.ok(!/theme_serif/.test(src), `${relative(ROOT, f)} still reads theme_serif`);
  }
});

test("renderLayout no longer accepts theme, glass, or serif params", () => {
  const src = readFileSync(LAYOUT, "utf8");
  const sig = src.match(/export function renderLayout\(\{([^}]*)\}\)/);
  assert.ok(sig, "renderLayout signature not found");
  const params = sig[1].split(",").map((s) => s.trim());
  assert.ok(!params.includes("theme"), "renderLayout signature still destructures theme");
  assert.ok(!params.includes("glass"), "renderLayout signature still destructures glass");
  assert.ok(!params.includes("serif"), "renderLayout signature still destructures serif");
});

test("theme-resolver.js is deleted", () => {
  assert.ok(!existsSync(THEME_RESOLVER), "servers/gateway/shared/theme-resolver.js must not exist");
});

test("nothing imports or references theme-resolver anywhere in servers/ or bundles/", () => {
  for (const base of [join(ROOT, "servers"), join(ROOT, "bundles")]) {
    for (const f of walk(base)) {
      const src = readFileSync(f, "utf8");
      assert.ok(!/theme-resolver/.test(src), `${relative(ROOT, f)} still references theme-resolver`);
    }
  }
});
