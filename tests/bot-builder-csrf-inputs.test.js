/**
 * Wave 1 Bug 1 belt-and-braces guard: every POST form the Bot Builder panel
 * renders must carry a `_csrf` body field (via the hidden() helper or a
 * direct csrfInput(req) call), so saves survive even when the Turbo header
 * path is unavailable (requestSubmit fallback, Turbo disabled, old WebView).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const editorSrc = readFileSync(new URL("../servers/gateway/dashboard/panels/bot-builder/editor.js", import.meta.url), "utf8");
const htmlSrc = readFileSync(new URL("../servers/gateway/dashboard/panels/bot-builder/html.js", import.meta.url), "utf8");

test("editor.js hidden() helper injects csrfInput(req)", () => {
  // Without this assertion the per-form check below would pass on the broken
  // tree (forms contain `hidden(` whether or not hidden() carries the token).
  const def = editorSrc.split("\n").find((l) => l.includes("const hidden = "));
  assert.ok(def, "hidden() helper definition not found");
  assert.ok(def.includes("csrfInput(req)"), "hidden() must append csrfInput(req)");
});

test("editor.js actInputs() helper injects csrfInput(req)", () => {
  // crow-messages gateway management forms use the actInputs() indirection
  // (it sets an explicit action name + bot_id + csrf) instead of hidden().
  // Like the hidden() guard above, pin that it carries the token so the
  // per-form check below stays honest.
  const idx = editorSrc.indexOf("const actInputs = ");
  assert.ok(idx >= 0, "actInputs() helper definition not found");
  const def = editorSrc.slice(idx, idx + 300);
  assert.ok(def.includes("csrfInput(req)"), "actInputs() must include csrfInput(req)");
});

test("every POST form in editor.js carries a CSRF token source", () => {
  const forms = editorSrc.split('<form method="POST"').slice(1);
  assert.ok(forms.length >= 10, `expected >=10 POST forms, found ${forms.length}`);
  forms.forEach((chunk, i) => {
    const head = chunk.slice(0, 500);
    assert.ok(
      head.includes("hidden(") || head.includes("csrfInput(") || head.includes("actInputs("),
      `POST form #${i + 1} in editor.js lacks a _csrf field`
    );
  });
});

test("bot list create form carries csrfInput", () => {
  assert.ok(htmlSrc.includes("csrfInput("), "html.js create form lacks csrfInput");
});
