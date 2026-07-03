// tests/invite-page.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { DEFAULT_INVITE_PAGE_URL } from "../servers/sharing/invite-url.js";

const PAGE = new URL("../docs/public/invite/index.html", import.meta.url).pathname;

test("static invite page exists where DEFAULT_INVITE_PAGE_URL points", () => {
  assert.ok(existsSync(PAGE), "docs/public/invite/index.html present");
  // The URL path (…/software/crow/invite/) must map to docs/public/invite/
  // under the VitePress base /software/crow/.
  assert.ok(DEFAULT_INVITE_PAGE_URL.endsWith("/software/crow/invite/"), "URL matches public dir layout");
});

test("page is self-contained and reads the fragment client-side only", () => {
  const html = readFileSync(PAGE, "utf-8");
  assert.ok(html.includes("location.hash"), "reads the fragment");
  const stripped = html.replace(/href="https:\/\/maestro\.press[^"]*"/g, "");
  const externalRef = /(?:\b(?:src|href|formaction)\s*=\s*["']?\s*(?:https?:)?\/\/)|url\(\s*["']?\s*(?:https?:)?\/\//i;
  assert.ok(!externalRef.test(stripped), "no external scripts/styles/images (own-domain install links exempt)");
  assert.ok(!/http-equiv\s*=\s*["']?refresh/i.test(html), "no meta refresh");
  assert.ok(!html.includes("fetch("), "no network calls");
  assert.ok(!html.includes("XMLHttpRequest"), "no network calls");
  assert.ok(html.includes("navigator.clipboard"), "copy button");
});

test("page is bilingual", () => {
  const html = readFileSync(PAGE, "utf-8");
  assert.ok(html.includes("Copy code"), "EN copy");
  assert.ok(html.includes("Copiar código"), "ES copy");
});
