import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { legacyDesignTokensCss, LEGACY_FONT_IMPORT } from "../servers/gateway/dashboard/shared/design-tokens-legacy.js";
import { designTokensCss } from "../servers/gateway/dashboard/shared/design-tokens.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("legacy module carries the old ground and not the new one", () => {
  assert.ok(legacyDesignTokensCss().includes("#0f0f17"), "legacy keeps the old dark ground");
  assert.ok(!legacyDesignTokensCss().includes("#eef1f3"), "legacy must not carry the new Perch ground");
});

test("legacy module has no glass", () => {
  assert.ok(!legacyDesignTokensCss().includes("theme-glass"), "glass blocks were deleted from the legacy snapshot");
});

test("legacy module has no PERCH_TOKENS export", () => {
  const src = readFileSync(join(ROOT, "servers/gateway/dashboard/shared/design-tokens-legacy.js"), "utf8");
  assert.ok(!src.includes("PERCH_TOKENS"), "legacy module must not export PERCH_TOKENS");
});

// Inverted in Task 3: the palette rewrite landed, so design-tokens.js now
// carries the new Perch ground and must NOT carry the old dark ground.
test("the rewritten design-tokens.js module carries the new Perch ground (post-Task-3)", () => {
  assert.ok(designTokensCss().includes("#eef1f3") && !designTokensCss().includes("#0f0f17"));
});

test("LEGACY_FONT_IMPORT is a non-empty font import string", () => {
  assert.ok(LEGACY_FONT_IMPORT.startsWith("@import"));
  assert.ok(LEGACY_FONT_IMPORT.includes("Fraunces"));
});

test("blog-public.js and songbook-renderer.js import the legacy module, not design-tokens.js", () => {
  const blogPublic = readFileSync(join(ROOT, "servers/gateway/routes/blog-public.js"), "utf8");
  const songbook = readFileSync(join(ROOT, "servers/blog/songbook-renderer.js"), "utf8");

  for (const [name, src] of [["blog-public.js", blogPublic], ["songbook-renderer.js", songbook]]) {
    assert.ok(
      src.includes("design-tokens-legacy.js"),
      `${name} must import from design-tokens-legacy.js`,
    );
    assert.ok(
      !/from\s+["'][^"']*\/design-tokens\.js["']/.test(src),
      `${name} must NOT import design-tokens.js directly`,
    );
  }
});

test("kb-public.js resolves the legacy module and reads the legacy export names", () => {
  const kbPublic = readFileSync(
    join(ROOT, "bundles/knowledge-base/routes/kb-public.js"),
    "utf8",
  );

  assert.ok(
    kbPublic.includes("design-tokens-legacy.js"),
    "kb-public.js must dynamic-import design-tokens-legacy.js",
  );
  assert.ok(
    !/design-tokens\.js/.test(kbPublic),
    "kb-public.js must not reference design-tokens.js at all",
  );
  assert.ok(
    kbPublic.includes("tokens.LEGACY_FONT_IMPORT"),
    "kb-public.js must read tokens.LEGACY_FONT_IMPORT",
  );
  assert.ok(
    kbPublic.includes("tokens.legacyDesignTokensCss"),
    "kb-public.js must read tokens.legacyDesignTokensCss",
  );
});
