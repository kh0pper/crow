/**
 * a11y baseline tests (W3-4 + W3-5a)
 *
 * 1. components-css.js contains :focus-visible rules for buttons, nav links, inputs.
 * 2. layout renderLayout output contains the toast container with aria-live="polite".
 * 3. All new i18n keys introduced in W3-4 have both en and es values.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { componentsCss } from "../servers/gateway/dashboard/shared/components-css.js";
import { renderLayout } from "../servers/gateway/dashboard/shared/layout.js";
import * as i18n from "../servers/gateway/dashboard/shared/i18n.js";

// ─── 1. focus-visible baseline ───
test("components-css contains :focus-visible rule for .btn variants", () => {
  const css = componentsCss();
  assert.ok(css.includes(":focus-visible"), "missing :focus-visible in components-css");
  assert.ok(css.includes(".btn:focus-visible"), "missing .btn:focus-visible");
  assert.ok(css.includes("outline: 2px solid var(--crow-accent)"), "missing outline rule");
});

test("components-css focus-visible covers nav links and form inputs", () => {
  const css = componentsCss();
  assert.ok(css.includes(".sidebar-nav a.nav-item:focus-visible"), "missing nav link focus-visible");
  assert.ok(css.includes("input:focus-visible"), "missing input focus-visible");
  assert.ok(css.includes("select:focus-visible"), "missing select focus-visible");
  assert.ok(css.includes("textarea:focus-visible"), "missing textarea focus-visible");
});

// ─── 2. toast container in layout ───
function stubLayout() {
  return renderLayout({
    title: "Test",
    content: "<p>hi</p>",
    activePanel: "nest",
    panels: [{ id: "nest", name: "Nest", icon: "health", route: "/dashboard", navOrder: 1 }],
    lang: "en",
  });
}

test("renderLayout output contains crow-toasts container with aria-live=polite", () => {
  const html = stubLayout();
  assert.ok(html.includes('id="crow-toasts"'), "missing id=crow-toasts");
  assert.ok(html.includes('aria-live="polite"'), "missing aria-live=polite on toast container");
});

test("renderLayout output contains crowToast window function definition", () => {
  const html = stubLayout();
  assert.ok(html.includes("window.crowToast"), "missing crowToast global");
  assert.ok(html.includes("__crowToastDefined"), "missing idempotent guard");
});

// ─── 3. W3-4 i18n keys ───
const W3_4_KEYS = [
  // alert() → crowToast replacements
  "blog.uploadFailed",
  "blog.uploadError",
  "botbuilder.stopSessionFailed",
  "botboard.trackerItemLocked",
  "botboard.cardLocked",
  "botboard.moveFailed",
  "botboard.moveItemFailed",
  // confirm() i18n
  "botbuilder.confirmApproveSkill",
  "botbuilder.confirmRejectSkill",
  "botbuilder.confirmStopSession",
  "botboard.confirmCancelCard",
  "botboard.confirmForceUnlock",
  "botboard.confirmClearLease",
  "projects.confirmRevoke",
  "orchestrator.confirmResetRefcounts",
  // silent-catch toasts
  "botboard.loadFailed",
  // extensions inline banner
  "extensions.serviceUnavailable",
  "extensions.serviceUnavailableDesc",
];

test("every W3-4 i18n key has a non-empty en AND es value", () => {
  for (const k of W3_4_KEYS) {
    const entry = i18n.translations[k];
    assert.ok(entry, `missing translations entry for ${k}`);
    assert.ok(entry.en && entry.en.trim(), `missing/empty en value for ${k}`);
    assert.ok(entry.es && entry.es.trim(), `missing/empty es value for ${k}`);
  }
});
