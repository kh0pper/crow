/**
 * Track 2 visual language, Task 6 — font delivery (spec §3.2 + §4.2).
 *
 * One manifest loads fonts for the dashboard: a shared `FONT_LINKS` constant
 * (preconnect x2 + one stylesheet <link>) that names Inter + JetBrains Mono
 * only, replacing the 7 drifted <link> sites in layout.js and the dashboard's
 * own `FONT_IMPORT` @import (removed along with the export itself). DM Sans
 * and Fraunces are swept to `var(--crow-body-font)` everywhere in the
 * dashboard/bundle-panel tree except the frozen public surfaces and named
 * prose/label exemptions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const LAYOUT_PATH = join(ROOT, "servers/gateway/dashboard/shared/layout.js");
const TOKENS_PATH = join(ROOT, "servers/gateway/dashboard/shared/design-tokens.js");

function walk(dir, exemptDirs = []) {
  let out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (exemptDirs.some((d) => p === d || p.startsWith(d + "/"))) continue;
    if (e.isDirectory()) out = out.concat(walk(p, exemptDirs));
    else if (/\.(js|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

/* --------------------------------------------------------- (a)/(b) FONT_LINKS */

test("layout.js carries exactly one fonts.googleapis stylesheet URL, and neither layout.js nor design-tokens.js has an @import", () => {
  const layoutSrc = readFileSync(LAYOUT_PATH, "utf8");
  const tokensSrc = readFileSync(TOKENS_PATH, "utf8");

  const urlHits = layoutSrc.match(/https:\/\/fonts\.googleapis\.com\/css2\?family=/g) || [];
  assert.equal(urlHits.length, 1, `expected exactly one fonts.googleapis URL in layout.js, found ${urlHits.length}`);

  assert.ok(!/@import url\('https:\/\/fonts/.test(layoutSrc), "layout.js must not carry a fonts @import");
  assert.ok(!/@import url\('https:\/\/fonts/.test(tokensSrc), "design-tokens.js must not carry a fonts @import");

  // design-tokens-legacy.js is exempt (plan-review finding 8): it permanently
  // carries the old @import for the frozen blog/songbook/kb surfaces.
  const legacySrc = readFileSync(
    join(ROOT, "servers/gateway/dashboard/shared/design-tokens-legacy.js"),
    "utf8",
  );
  assert.ok(/@import url\('https:\/\/fonts/.test(legacySrc), "design-tokens-legacy.js must keep its own @import");
});

test("the FONT_LINKS URL names Inter + JetBrains Mono and neither DM Sans nor Fraunces", () => {
  const layoutSrc = readFileSync(LAYOUT_PATH, "utf8");
  const match = layoutSrc.match(/https:\/\/fonts\.googleapis\.com\/css2\?family=[^"']+/);
  assert.ok(match, "expected a fonts.googleapis URL in layout.js");
  const url = match[0];

  assert.ok(url.includes("Inter"), "URL must load Inter");
  assert.ok(url.includes("JetBrains+Mono") || url.includes("JetBrains%20Mono"), "URL must load JetBrains Mono");
  assert.ok(!url.includes("DM+Sans") && !url.includes("DM%20Sans"), "URL must not load DM Sans");
  assert.ok(!url.includes("Fraunces"), "URL must not load Fraunces");

  assert.ok(layoutSrc.includes("FONT_LINKS"), "layout.js must define/use a FONT_LINKS constant");
});

/* --------------------------------------------------------------- (c) DM Sans */

test("grep-as-test: no 'DM Sans' anywhere under servers/gateway/dashboard/", () => {
  const files = walk(join(ROOT, "servers/gateway/dashboard"));
  const hits = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    if (src.includes("DM Sans")) hits.push(relative(ROOT, f));
  }
  assert.deepEqual(hits, [], `'DM Sans' still referenced in: ${hits.join(", ")}`);
});

/* --------------------------------------------------------------- (d) Fraunces */

// calls-page.js is deliberately outside scope (Task 7 moves its font during
// its own recolor); it lives under servers/gateway/routes, which the (c)
// DM Sans test above does not walk (scope pinned to dashboard/), so no
// exemption is needed there. This Fraunces test walks servers/ + bundles/,
// so its exemptions must be listed explicitly.
const FRAUNCES_EXEMPT_FILES = new Set([
  join(ROOT, "servers/gateway/dashboard/shared/design-tokens-legacy.js"),
  join(ROOT, "servers/gateway/routes/blog-public.js"),
  join(ROOT, "servers/blog/songbook-renderer.js"),
  join(ROOT, "bundles/knowledge-base/routes/kb-public.js"),
  join(ROOT, "servers/gateway/dashboard/settings/sections/theme.js"), // serif label
  join(ROOT, "servers/blog/server.js"), // zod description
]);

test("grep-as-test: 'Fraunces' appears only in the frozen legacy/public surfaces + named prose exemptions", () => {
  const files = [...walk(join(ROOT, "servers")), ...walk(join(ROOT, "bundles"))];
  const hits = [];
  for (const f of files) {
    if (FRAUNCES_EXEMPT_FILES.has(f)) continue;
    const src = readFileSync(f, "utf8");
    if (src.includes("Fraunces")) hits.push(relative(ROOT, f));
  }
  assert.deepEqual(hits, [], `'Fraunces' still referenced outside the exemption list in: ${hits.join(", ")}`);
});

test("exempted files still contain what they're exempted for (mutation guard against a stale exemption list)", () => {
  for (const f of FRAUNCES_EXEMPT_FILES) {
    const src = readFileSync(f, "utf8");
    assert.ok(src.includes("Fraunces"), `${relative(ROOT, f)} was exempted but no longer contains 'Fraunces' — remove it from the exemption list`);
  }
});
