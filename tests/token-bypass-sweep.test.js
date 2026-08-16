// Task 7 (Track 2): color/radius bypass sweep — dashboard only.
//
// Grep-as-test over the dashboard render tree + the two standalone hardcoded
// pages + bundle panel files. Scope EXCLUDES the frozen public surfaces
// (blog-public.js, songbook-renderer.js, kb-public.js, design-tokens-legacy.js)
// and the three brand-art files (shared/crow-hero.js, shared/empty-state-icons.js,
// shared/notifications.js — Task 8 recolors those and re-adds them to scope).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const EXCLUDED_ABS = new Set(
  [
    "servers/gateway/routes/blog-public.js",
    "servers/blog/songbook-renderer.js",
    "bundles/knowledge-base/routes/kb-public.js",
    "servers/gateway/dashboard/shared/design-tokens-legacy.js",
    "servers/gateway/dashboard/shared/crow-hero.js",
    "servers/gateway/dashboard/shared/empty-state-icons.js",
    "servers/gateway/dashboard/shared/notifications.js",
  ].map((p) => join(ROOT, p)),
);

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (entry.endsWith(".js")) out.push(full);
  }
}

function scopeFiles() {
  const out = [];
  walk(join(ROOT, "servers/gateway/dashboard"), out);
  out.push(join(ROOT, "servers/gateway/setup-page.js"));
  out.push(join(ROOT, "servers/gateway/routes/calls-page.js"));

  const bundlesDir = join(ROOT, "bundles");
  for (const bundle of readdirSync(bundlesDir)) {
    const bundleDir = join(bundlesDir, bundle);
    if (!statSync(bundleDir).isDirectory()) continue;
    for (const entry of readdirSync(bundleDir)) {
      if (!entry.startsWith("panel")) continue;
      const panelDir = join(bundleDir, entry);
      if (statSync(panelDir).isDirectory()) walk(panelDir, out);
    }
  }

  return out.filter((f) => !EXCLUDED_ABS.has(f));
}

function readAll(files) {
  return files.map((f) => ({ file: f, rel: relative(ROOT, f), src: readFileSync(f, "utf8") }));
}

const FILES = readAll(scopeFiles());

test("scope sanity: excludes the frozen files and includes the known sweep files", () => {
  assert.ok(FILES.length > 100, "scope should cover the dashboard tree + bundle panels");
  const rels = new Set(FILES.map((f) => f.rel));
  assert.ok(rels.has("servers/gateway/dashboard/shared/layout.js"));
  assert.ok(rels.has("servers/gateway/routes/calls-page.js"));
  assert.ok(!rels.has("servers/gateway/dashboard/shared/notifications.js"), "brand-art file excluded until Task 8");
  assert.ok(!rels.has("servers/gateway/dashboard/shared/design-tokens-legacy.js"));
});

test("check 1: no old-palette hex literal in scope", () => {
  const OLD_PALETTE = /#0f0f17|#1a1a2e|#2d2d3d|#6366f1|#818cf8|#2d2854|#fbbf24|rgba\(99,102,241|rgba\(251,191,36/i;
  const hits = [];
  for (const { rel, src } of FILES) {
    src.split("\n").forEach((line, idx) => {
      if (OLD_PALETTE.test(line)) hits.push(`${rel}:${idx + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, [], `old-palette hex literals found:\n${hits.join("\n")}`);
});

test("check 2: no color:#fff/white in the same rule as background: var(--crow-accent)", () => {
  // Per-rule scan: split each file on `}` to approximate CSS/inline-style rule
  // boundaries, then check each chunk for both a crow-accent background and a
  // hardcoded white/#fff text color. Also matches inline `style="...;color:#fff"`
  // attributes on elements whose style also sets `background:var(--crow-accent)`.
  const BG_ACCENT = /background:\s*var\(--crow-accent\)/i;
  const WHITE_TEXT = /color:\s*(#fff\b|#ffffff\b|white\b)/i;
  const NOT_WHITE_SPACE = /white-space/i;
  const hits = [];
  for (const { rel, src } of FILES) {
    // Scan rule-ish chunks: split on `}` for CSS blocks and on `>` /`"` boundaries
    // is too lossy for inline styles, so scan a sliding window instead — a hit is
    // any place BG_ACCENT and WHITE_TEXT co-occur within the same declaration
    // block (bounded by `{`/`}` for CSS, or the same style="..." string for HTML).
    const chunks = src.split(/[{}]/);
    for (const chunk of chunks) {
      if (BG_ACCENT.test(chunk) && WHITE_TEXT.test(chunk) && !NOT_WHITE_SPACE.test(chunk.replace(WHITE_TEXT, ""))) {
        hits.push(`${rel}: ${chunk.trim().slice(0, 160)}`);
      }
    }
    // Inline style="" attributes can contain both without a `{`/`}` boundary between them.
    const styleAttrRe = /style="([^"]*)"/g;
    let m;
    while ((m = styleAttrRe.exec(src))) {
      const val = m[1];
      if (BG_ACCENT.test(val) && WHITE_TEXT.test(val)) {
        hits.push(`${rel}: ${val.slice(0, 160)}`);
      }
    }
    // Client-emission `css:` string properties (messages/client.js el() helper).
    const cssPropRe = /css:\s*'([^']*)'/g;
    while ((m = cssPropRe.exec(src))) {
      const val = m[1];
      if (BG_ACCENT.test(val) && WHITE_TEXT.test(val)) {
        hits.push(`${rel}: ${val.slice(0, 160)}`);
      }
    }
  }
  assert.deepEqual(hits, [], `white-on-accent sites found:\n${hits.join("\n")}`);
});

test("check 3: no border-radius: 8px|12px literal in layout.js", () => {
  const layoutRel = "servers/gateway/dashboard/shared/layout.js";
  const { src } = FILES.find((f) => f.rel === layoutRel);
  const RADIUS_LITERAL = /border-radius:\s*(8px|12px)\b/;
  const hits = [];
  src.split("\n").forEach((line, idx) => {
    if (RADIUS_LITERAL.test(line)) hits.push(`${layoutRel}:${idx + 1}: ${line.trim()}`);
  });
  assert.deepEqual(hits, [], `layout.js radius-literal bypass sites found:\n${hits.join("\n")}`);
});

test("check 4: no var(--crow-x, #oldhex) stale fallback using an old-palette value", () => {
  const STALE_FALLBACK = /var\(--crow-[a-z-]+,\s*#(0f0f17|1a1a2e|2d2d3d|6366f1|818cf8|2d2854|fbbf24)/i;
  const hits = [];
  for (const { rel, src } of FILES) {
    src.split("\n").forEach((line, idx) => {
      if (STALE_FALLBACK.test(line)) hits.push(`${rel}:${idx + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, [], `stale old-palette fallback sites found:\n${hits.join("\n")}`);
});
