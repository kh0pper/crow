// The renderer's "no @import in <style>" rule (spec §3.3). The scan lower-cases
// ASCII only: String#toLowerCase turns U+0130 into two code units, which shifts
// the offsets used to slice the original and let an @import through.
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripImports } from "../bundles/design-kit/renderer/strip-imports.mjs";

test("@import is removed, in any ASCII case", () => {
  assert.equal(stripImports("<style>@import 'a.css';x{}</style>"), "<style>x{}</style>");
  assert.equal(stripImports("<style>@IMPORT url(a.css);x{}</style>"), "<style>x{}</style>");
  assert.equal(stripImports("<style>@import 'a.css'</style>"), "<style>");
});

test("a run of U+0130 before the @import cannot shift it past the scan", () => {
  const out = stripImports("<style>" + "İ".repeat(30) + "@import 'a.css';x{}</style>");
  assert.doesNotMatch(out.toLowerCase(), /@import/);
  assert.equal(out, "<style>" + "İ".repeat(30) + "x{}</style>");
});
