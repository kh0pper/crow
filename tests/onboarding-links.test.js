// tests/onboarding-links.test.js
//
// Item 1b — done-step action cards target the SAME tab; mid-tour deep links do NOT.
//
// Every assertion here runs the real renderer and inspects the produced HTML — a
// source regex would not be evidence that the emitted anchors changed. The one
// exception is the classifier, which is unit-tested directly because its external
// branch is dead code on day one (all four done-step cards are internal).
import { test } from "node:test";
import assert from "node:assert/strict";
import onboardingPanel, {
  isInternalHref,
  cardLinkAttrs,
} from "../servers/gateway/dashboard/panels/onboarding.js";

// Same seam as tests/onboarding.test.js: drive the panel handler with a stub layout.
// No db => the done step's onboarding_completed_at write is skipped.
async function render(step) {
  let captured = "";
  const layout = ({ content }) => content;
  const res = { send(h) { captured = h; }, setHeader() {} };
  const req = { method: "GET", query: { step: String(step) }, headers: {} };
  const out = await onboardingPanel.handler(req, res, { layout, lang: "en" });
  return typeof out === "string" ? out : captured;
}

/** Every `<a ...>` open tag in an HTML string. */
function anchors(html) {
  return html.match(/<a\b[^>]*>/g) || [];
}

/** The anchor open-tag whose href is exactly `href` (asserts exactly one). */
function anchorFor(html, href) {
  const found = anchors(html).filter((a) => a.includes(`href="${href}"`));
  assert.equal(found.length, 1, `expected exactly one anchor for ${href}, got ${found.length}`);
  return found[0];
}

/** Just the done step's action-card grid, so nav/callout anchors don't pollute assertions. */
function actionCardsSlice(html) {
  const start = html.indexOf('<div class="onboarding-action-cards">');
  assert.ok(start !== -1, "done step must render the action-cards grid");
  return html.slice(start);
}

const CARD_HREFS = [
  "/dashboard/memory",
  "/dashboard/bot-builder",
  "/dashboard/connect",
  "/dashboard/extensions#collections",
];

// (a) THE REGRESSION GUARD. deepLink() is mid-tour: it must keep opening a new tab
// so the wizard stays alive behind it. If 1b's change bleeds into deepLink, this
// goes red.
test("mid-tour deep links still open in a new tab (deepLink is out of scope)", async () => {
  const midTour = [
    [1, "/dashboard/settings?section=integrations"],
    [2, "/dashboard/bot-builder"],
    [3, "/dashboard/connect"],
  ];
  for (const [step, href] of midTour) {
    const a = anchorFor(await render(step), href);
    assert.match(a, /target="_blank"/, `mid-tour step ${step} (${href}) must keep target=_blank`);
    assert.match(a, /rel="noopener"/, `mid-tour step ${step} (${href}) must keep rel=noopener`);
  }
});

// (b) The done-step cards are all internal today => no target, no rel.
test("done-step action cards navigate in the same tab (no target attribute)", async () => {
  const cards = actionCardsSlice(await render(4));
  for (const href of CARD_HREFS) {
    const a = anchorFor(cards, href);
    assert.doesNotMatch(a, /target=/, `internal card ${href} must not set target`);
    assert.doesNotMatch(a, /rel=/, `internal card ${href} must not set rel (nothing to protect)`);
  }
  // And the grid as a whole carries no stray new-tab anchor.
  assert.doesNotMatch(cards, /target="_blank"/, "no done-step card opens a new tab");
});

// (c) Whatever _blank survives anywhere in the tour must still be safe.
test("every remaining target=_blank anchor carries rel=noopener", async () => {
  for (const step of [0, 1, 2, 3, 4]) {
    for (const a of anchors(await render(step))) {
      if (a.includes('target="_blank"')) {
        assert.match(a, /rel="noopener"/, `step ${step}: _blank anchor without rel=noopener: ${a}`);
      }
    }
  }
});

// (d) The classifier, both ways. Conservative: only a leading "/" is internal.
test("isInternalHref: only same-origin dashboard paths are internal", () => {
  for (const href of ["/dashboard/memory", "/dashboard/extensions#collections", "/"]) {
    assert.equal(isInternalHref(href), true, `${href} is internal`);
  }
  for (const href of [
    "https://docs.crow.example/guide",
    "http://example.com",
    "//evil.example.com/x",     // protocol-relative: NOT internal
    "javascript:alert(1)",      // eslint-disable-line no-script-url
    "mailto:a@b.c",
    "dashboard/memory",         // relative, no leading slash
    "",
    null,
    undefined,
  ]) {
    assert.equal(isInternalHref(href), false, `${String(href)} is NOT internal`);
  }
});

// (e) The external branch is dead code in the renderer today (Item 4d may add such a
// card), so exercise it at the classifier/attrs layer instead.
test("an external card href would still get target=_blank rel=noopener", () => {
  assert.equal(cardLinkAttrs("https://crow.example/docs"), 'target="_blank" rel="noopener"');
  assert.equal(cardLinkAttrs("//evil.example.com/x"), 'target="_blank" rel="noopener"');
  assert.equal(cardLinkAttrs("/dashboard/memory"), "");
});
