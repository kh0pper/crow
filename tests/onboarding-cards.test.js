// tests/onboarding-cards.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as i18n from "../servers/gateway/dashboard/shared/i18n.js";
import onboardingPanel, { STEP_KEYS } from "../servers/gateway/dashboard/panels/onboarding.js";

const SRC = readFileSync(new URL("../servers/gateway/dashboard/panels/onboarding.js", import.meta.url), "utf8");

test("the done step offers a starter-collection card that deep-links into the store", () => {
  assert.match(SRC, /\/dashboard\/extensions#collections/);
  assert.match(SRC, /onboarding\.(tryCollections|collections)/, "the card's copy must be i18n'd");
});

// Drive the real handler (same seam as tests/onboarding.test.js's render()) so this
// isn't just a string match on source: the card must actually render, with the href
// and the TRANSLATED title text (not the raw i18n key), on the "done" step.
async function render(query = {}) {
  let captured = "";
  const layout = ({ content }) => content;
  const res = { send(h) { captured = h; }, setHeader() {} };
  const req = { method: "GET", query, headers: {} };
  const out = await onboardingPanel.handler(req, res, { layout, lang: "en" });
  return typeof out === "string" ? out : captured;
}

test("the rendered done step contains the collections card with its translated title and deep link", async () => {
  const html = await render({ step: String(STEP_KEYS.indexOf("done")) });
  assert.ok(html.includes("/dashboard/extensions#collections"), "card links to the store's collections section");
  const title = i18n.t("onboarding.tryCollections.title", "en");
  assert.notEqual(title, "onboarding.tryCollections.title", "the title key must resolve to a translated string");
  assert.ok(html.includes(title), "card renders the translated title, not the raw key");
});
