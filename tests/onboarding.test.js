import { test } from "node:test";
import assert from "node:assert/strict";
import * as i18n from "../servers/gateway/dashboard/shared/i18n.js";

// The full set of onboarding.* keys the feature depends on. t() returns the
// key string unchanged when a key is missing, so "resolves" == "value present".
const ONBOARDING_KEYS = [
  "onboarding.title",
  "onboarding.welcome.title", "onboarding.welcome.body",
  "onboarding.integrations.title", "onboarding.integrations.body",
  "onboarding.integrationsNote", "onboarding.openIntegrations",
  "onboarding.bot.title", "onboarding.bot.body", "onboarding.openBotBuilder",
  "onboarding.connect.title", "onboarding.connect.body",
  "onboarding.connectNote", "onboarding.openConnections",
  "onboarding.done.title", "onboarding.done.body", "onboarding.doneNote",
  "onboarding.btnNext", "onboarding.btnBack", "onboarding.btnSkip",
  "onboarding.btnGoDashboard", "onboarding.replayLink",
];

test("every onboarding.* key has a non-empty en AND es value", () => {
  for (const k of ONBOARDING_KEYS) {
    const entry = i18n.translations[k];
    assert.ok(entry, `missing translations entry for ${k}`);
    assert.ok(entry.en && entry.en.trim(), `missing/empty en value for ${k}`);
    assert.ok(entry.es && entry.es.trim(), `missing/empty es value for ${k}`);
  }
});

import onboardingPanel from "../servers/gateway/dashboard/panels/onboarding.js";

// Invoke the panel handler with a stubbed layout (returns content for assertions).
// parseCookies reads req.headers.cookie, so headers must always be an object.
async function render(query = {}, cookie = "") {
  let captured = "";
  const layout = ({ content }) => content;
  const res = { send(h) { captured = h; }, setHeader() {} };
  const req = { method: "GET", query, headers: cookie ? { cookie } : {} };
  const out = await onboardingPanel.handler(req, res, { layout, lang: "en" });
  return typeof out === "string" ? out : captured;
}

test("panel identity: id / route / hidden", () => {
  assert.equal(onboardingPanel.id, "onboarding");
  assert.equal(onboardingPanel.route, "/dashboard/onboarding");
  assert.equal(onboardingPanel.hidden, true);
});

test("renders all 5 steps with the stepper and step-specific deep links", async () => {
  const deepLinkPerStep = [
    null,
    "/dashboard/settings?section=integrations",
    "/dashboard/bot-builder",
    "/dashboard/settings?section=help-setup",
    null,
  ];
  for (let step = 0; step < 5; step++) {
    const html = await render({ step: String(step) });
    assert.ok(html.includes("stepper"), `step ${step} renders the stepper`);
    assert.ok(html.includes("step-active"), `step ${step} marks the active step`);
    if (deepLinkPerStep[step]) {
      assert.ok(html.includes(deepLinkPerStep[step]), `step ${step} links to ${deepLinkPerStep[step]}`);
    }
  }
  const done = await render({ step: "4" });
  assert.ok(done.includes('href="/dashboard"'), "last step links to the dashboard");
});

test("clamps out-of-range / non-numeric step to a valid page without throwing", async () => {
  for (const step of ["-1", "99", "abc"]) {
    const html = await render({ step });
    assert.ok(html.includes("stepper"), `step=${step} still renders a valid page`);
  }
  const noParam = await render({});
  assert.ok(noParam.includes("stepper"), "missing step param renders step 0");
  // Express parses ?step=1&step=2 into an array; parseInt stringifies it and
  // reads the leading int, so it must clamp/render rather than throw.
  const arrayStep = await render({ step: ["1", "2"] });
  assert.ok(arrayStep.includes("stepper"), "array step param still renders");
});

test("honors the crow_lang=es cookie for Spanish copy", async () => {
  const es = await render({ step: "0" }, "crow_lang=es");
  const en = await render({ step: "0" }, "crow_lang=en");
  assert.notEqual(es, en, "ES and EN render differently");
  assert.ok(es.includes(i18n.t("onboarding.welcome.body", "es")), "ES body present");
  assert.ok(en.includes(i18n.t("onboarding.welcome.body", "en")), "EN body present");
});
