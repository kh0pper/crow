/**
 * Guard #10 (design §D5): sanitizeDisplayName bounds a remote-controlled,
 * dashboard-rendered display name. Escaping happens at the sinks; the
 * sanitizer strips control/bidi chars, blocks identity-string impersonation,
 * and caps length by Unicode code point.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeDisplayName } from "../servers/sharing/display-name.js";

// C0 controls (U+0000-U+001F), DEL (U+007F), C1 controls (U+0080-U+009F).
const CONTROL_RE = /[\x00-\x1F\x7F\x80-\x9F]/;

test("XSS-looking input survives as inert, control-free text", () => {
  const input = "<img src=x onerror=alert(1)>";
  const out = sanitizeDisplayName(input);
  assert.notEqual(out, null);
  assert.equal(CONTROL_RE.test(out), false);
  // The sanitizer does not escape; it bounds. The angle brackets survive.
  assert.equal(out, "<img src=x onerror=alert(1)>");
});

test("a 10 KB string caps to exactly 64 code points", () => {
  const out = sanitizeDisplayName("a".repeat(10 * 1024));
  assert.equal(Array.from(out).length, 64);
});

test("newline / carriage-return / tab are stripped and glyphs join", () => {
  const out = sanitizeDisplayName("a\nb\r\nc\td");
  assert.equal(out.includes("\n"), false);
  assert.equal(out.includes("\r"), false);
  assert.equal(out.includes("\t"), false);
  assert.equal(CONTROL_RE.test(out), false);
  // Controls are removed, not spaced, so the surviving glyphs join.
  assert.equal(out, "abcd");
});

test("NUL is stripped (log-injection defense)", () => {
  const withNul = "a" + String.fromCharCode(0) + "b";
  const out = sanitizeDisplayName(withNul);
  assert.equal(CONTROL_RE.test(out), false);
  assert.equal(out, "ab");
});

test("bidi override (U+202E) and isolate (U+2066) are stripped", () => {
  const out = sanitizeDisplayName("a‮b⁦c");
  assert.equal(out.includes("‮"), false);
  assert.equal(out.includes("⁦"), false);
  assert.equal(out, "abc");
});

test("identity-string prefixes are rejected", () => {
  assert.equal(sanitizeDisplayName("crow:deadbeef"), null);
  assert.equal(sanitizeDisplayName("CROW:deadbeef"), null);
  assert.equal(sanitizeDisplayName("req:abc"), null);
  assert.equal(sanitizeDisplayName("REQ:abc"), null);
});

test("bidi-obfuscated prefix is rejected (strip-before-prefix-check ordering)", () => {
  assert.equal(sanitizeDisplayName("‮crow:x"), null);
  assert.equal(sanitizeDisplayName("⁦req:x"), null);
});

test("internal whitespace runs collapse and ends trim", () => {
  assert.equal(sanitizeDisplayName("  a   b  "), "a b");
});

test("empty, whitespace-only, and non-strings return null", () => {
  assert.equal(sanitizeDisplayName(""), null);
  assert.equal(sanitizeDisplayName("   "), null);
  assert.equal(sanitizeDisplayName(null), null);
  assert.equal(sanitizeDisplayName(undefined), null);
  assert.equal(sanitizeDisplayName(42), null);
  assert.equal(sanitizeDisplayName({}), null);
});

test("legitimate names round-trip unchanged", () => {
  assert.equal(sanitizeDisplayName("Alex"), "Alex");
  assert.equal(sanitizeDisplayName("José M."), "José M.");
  assert.equal(sanitizeDisplayName("山田太郎"), "山田太郎");
  assert.equal(sanitizeDisplayName("\u{1F985} Crow"), "\u{1F985} Crow");
});

test("a 64-emoji string caps to 64 emoji, not mangled surrogate pairs", () => {
  const out = sanitizeDisplayName("\u{1F985}".repeat(100));
  const points = Array.from(out);
  assert.equal(points.length, 64);
  // Every code point is the whole emoji, not half a surrogate pair.
  for (const p of points) assert.equal(p, "\u{1F985}");
});
