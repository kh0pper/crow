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

test("a single-quoted inline SVG custom property is handled too", () => {
  const r = normalizeCss(`:root{--a:url('data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"%3E%3C/svg%3E')}`);
  assert.equal(r.css, ":root{--a:none}");
  assert.equal(r.changes.length, 1);
});

test("a custom property spread over several lines is handled", () => {
  const r = normalizeCss(`:root{\n  --a:\n    url(\n      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3C/svg%3E"\n    );\n  --b: 2;\n}`);
  assert.equal(r.css, ":root{\n  --a:none;\n  --b: 2;\n}");
});

const OK_SVG = (c) => `%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' stroke='${c}'%3E%3Cpath d='M1 1L2 2'/%3E%3C/svg%3E`;
const BAD_SVG = "%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3Cstyle%3Eg{}%3C/style%3E%3C/svg%3E";

test("extract mode: each distinct SVG that passes the allowlist becomes a relative file; a failing one stays none", () => {
  const src = `:root{--icon-a:url("data:image/svg+xml,${OK_SVG("red")}");--icon-b:url("data:image/svg+xml,${BAD_SVG}")}`
    + `.d{--icon-a:url("data:image/svg+xml,${OK_SVG("blue")}")}.e{--icon-a:url("data:image/svg+xml,${OK_SVG("red")}")}`;
  const r = normalizeCss(src, { extractSvgDir: "icons" });
  assert.equal(r.css, ":root{--icon-a:url(icons/icon-a.svg);--icon-b:none}.d{--icon-a:url(icons/icon-a-2.svg)}.e{--icon-a:url(icons/icon-a.svg)}");
  assert.deepEqual(r.assets.map((a) => a.file), ["icons/icon-a.svg", "icons/icon-a-2.svg"]);
  assert.equal(r.assets[0].svg, decodeURIComponent(OK_SVG("red")));
  assert.deepEqual(r.changes, [
    "--icon-a: inline SVG extracted to icons/icon-a.svg",
    "--icon-b: inline SVG fails the lib-check SVG allowlist, replaced with none",
    "--icon-a: inline SVG extracted to icons/icon-a-2.svg",
    "--icon-a: inline SVG extracted to icons/icon-a.svg",
  ]);
  assert.equal(cssFetches(Buffer.from(r.css)), false);
});
