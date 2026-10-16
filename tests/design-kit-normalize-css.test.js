// Design kit (spec §3.2): the vendor step's CSS normalizer turns upstream CSS
// into the plain shape lib-check.js accepts, and records what it changed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeCss } from "../scripts/design-kit/normalize-css.mjs";
import { cssFetches } from "../bundles/design-kit/server/lib-check.js";

test("comments are stripped (and returned), strings that look like comments are kept", () => {
  const r = normalizeCss('/*! Banner ✨ v1 */a{content:"/* not a comment */"}/* x */b{c:d}');
  assert.equal(r.css, 'a{content:"/* not a comment */"}b{c:d}');
  assert.deepEqual(r.comments, ["/*! Banner ✨ v1 */", "/* x */"]);
});

test("BOM, CRLF and tabs are normalized", () => {
  const r = normalizeCss("﻿a{\r\n\tb:c}\r\n");
  assert.equal(r.css, "a{\n b:c}\n");
});

test("a custom property holding an inline SVG data: URL becomes none, and is recorded", () => {
  const r = normalizeCss(`:root{--icon-a:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3C/svg%3E");--keep:1}.x{background-image:var(--icon-a)}`);
  assert.equal(r.css, ":root{--icon-a:none;--keep:1}.x{background-image:var(--icon-a)}");
  assert.deepEqual(r.changes, ["--icon-a: inline SVG data: URL replaced with none"]);
  assert.equal(cssFetches(Buffer.from(r.css)), false);
});

test("an inline SVG outside a custom property is refused, not silently kept", () => {
  assert.throws(() => normalizeCss(`.x{background:url("data:image/svg+xml,%3Csvg%3E")}`), /data:image\/svg/);
});

test("the result must pass the lib checker, or the normalizer throws", () => {
  assert.throws(() => normalizeCss(".x{background:url(https:x)}"), /lib-check/);
  assert.throws(() => normalizeCss("@import 'a.css';"), /lib-check/);
});
