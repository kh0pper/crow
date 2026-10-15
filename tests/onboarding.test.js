import { test } from "node:test";
import assert from "node:assert/strict";
import * as i18n from "../servers/gateway/dashboard/shared/i18n.js";

// The full set of onboarding.* keys the feature depends on. t() returns the
// key string unchanged when a key is missing, so "resolves" == "value present".
const ONBOARDING_KEYS = [
  "onboarding.title",
  "onboarding.welcome.title", "onboarding.welcome.body",
  "onboarding.welcome.exampleLabel", "onboarding.welcome.exampleYouName",
  "onboarding.welcome.exampleYou", "onboarding.welcome.exampleCrow", "onboarding.welcome.exampleNote",
  "common.stepOf", "common.stepsLabel",
  "onboarding.ai.title", "onboarding.ai.body",
  "onboarding.aiEmptyNote", "onboarding.aiConfiguredNote", "onboarding.openProviders",
  "onboarding.integrations.title", "onboarding.integrations.body",
  "onboarding.integrationsNote", "onboarding.openIntegrations",
  "onboarding.bot.title", "onboarding.bot.body", "onboarding.openBotBuilder",
  "onboarding.starter.title", "onboarding.starter.body",
  "onboarding.starterMemberCount", "onboarding.openCollections",
  "onboarding.connect.title", "onboarding.connect.body",
  "onboarding.connectNote", "onboarding.openConnections",
  "onboarding.meet.title", "onboarding.meet.body", "onboarding.meet.cta",
  "onboarding.meet.noProvider", "onboarding.meet.err", "onboarding.meet.errGeneric",
  "onboarding.done.title", "onboarding.done.body", "onboarding.doneNote", "onboarding.doneDormant",
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

import onboardingPanel, { STEP_KEYS } from "../servers/gateway/dashboard/panels/onboarding.js";

const DONE_STEP = String(STEP_KEYS.indexOf("done"));

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

test("renders every step with the stepper and step-specific deep links", async () => {
  // Keyed by stem (not index) so a future step insertion doesn't re-break this.
  const deepLinkPerStem = {
    welcome: null,
    // button() renders hrefs through escapeHtml, so & appears as &amp; in HTML.
    ai: "/dashboard/settings?section=llm&amp;tab=providers",
    integrations: "/dashboard/settings?section=integrations",
    bot: "/dashboard/bot-builder",
    starter: "/dashboard/extensions#collections",
    connect: "/dashboard/connect",
    meet: null,
    done: null,
  };
  // integrations, connect, done each render a callout unconditionally.
  // (The ai and meet steps' callouts are db-dependent; tests/onboarding-steps.test.js
  // and tests/onboarding-meet.test.js cover those.)
  const calloutStems = ["integrations", "connect", "done"];
  for (let step = 0; step < STEP_KEYS.length; step++) {
    const stem = STEP_KEYS[step];
    const html = await render({ step: String(step) });
    assert.ok(html.includes("stepper"), `step ${stem} renders the stepper`);
    assert.ok(html.includes("step-active"), `step ${stem} marks the active step`);
    if (deepLinkPerStem[stem]) {
      assert.ok(html.includes(deepLinkPerStem[stem]), `step ${stem} links to ${deepLinkPerStem[stem]}`);
      assert.ok(html.includes('target="_blank"'), `step ${stem} deep-link opens in a new tab`);
      assert.ok(html.includes('rel="noopener"'), `step ${stem} deep-link sets rel=noopener`);
    }
    if (calloutStems.includes(stem)) {
      assert.ok(html.includes("callout"), `step ${stem} renders a callout`);
    }
  }
  const done = await render({ step: DONE_STEP });
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

test("welcome copy: the approved example lines, verbatim", () => {
  assert.equal(i18n.t("onboarding.welcome.exampleYou", "en"), "When is my sister's birthday?");
  assert.equal(i18n.t("onboarding.welcome.exampleCrow", "en"), "March 4 — you saved it from another app last Tuesday.");
  assert.equal(i18n.t("onboarding.welcome.exampleNote", "en"), "That works because the memory lives in your Crow, not in one chat app.");
  assert.equal(i18n.t("common.stepOf", "en"), "Step {n} of {total}");
  assert.equal(i18n.t("common.stepOf", "es"), "Paso {n} de {total}");
});

for (const lang of ["en", "es"]) {
  test(`welcome step (${lang}): crow mark, body, the example and its caption`, async () => {
    const html = await render({ step: "0" }, `crow_lang=${lang}`);
    const at = html.indexOf('class="crow-mark"');
    assert.ok(at !== -1, "the crow mark renders");
    const svg = html.slice(html.lastIndexOf("<svg", at), html.indexOf("</svg>", at) + 6);
    assert.ok(!/\sid=/.test(svg), "the mark carries no id (the header bird owns #crow-tama)");
    assert.ok(svg.includes('aria-hidden="true"') && svg.includes('focusable="false"'), "the mark is decorative");
    assert.ok(svg.includes('class="crow-body-group"'), "the mark is the header bird's geometry");
    for (const k of ["onboarding.welcome.body", "onboarding.welcome.exampleLabel", "onboarding.welcome.exampleYouName",
      "onboarding.welcome.exampleYou", "onboarding.welcome.exampleCrow", "onboarding.welcome.exampleNote"]) {
      const v = i18n.t(k, lang).replace(/'/g, "&#39;");
      assert.ok(html.includes(v) || html.includes(i18n.t(k, lang)), `${k} renders`);
    }
  });

  test(`welcome example (${lang}): the speaker and the line are separated in text, not only by CSS (review M)`, async () => {
    const html = await render({ step: "0" }, `crow_lang=${lang}`);
    const lines = [...html.matchAll(/<p class="onboarding-example-line[^"]*">([\s\S]*?)<\/p>/g)].map((m) => m[1].replace(/<[^>]+>/g, ""));
    assert.equal(lines.length, 2);
    for (const l of lines) assert.match(l, /^\S+?: \S/, "speaker, colon, space, then the line: " + l);
  });

  test(`onboarding stepper (${lang}): translated compact line and group label`, async () => {
    const html = await render({ step: "1" }, `crow_lang=${lang}`);
    const label = i18n.fill(i18n.t("common.stepOf", lang), { n: 2, total: STEP_KEYS.length }) + " · " + i18n.t("onboarding.ai.title", lang);
    assert.ok(html.includes(label), `compact line "${label}"`);
    assert.ok(html.includes(`role="group" aria-label="${i18n.t("common.stepsLabel", lang)}"`));
  });
}

import helpSetupSection from "../servers/gateway/dashboard/settings/sections/help-setup.js";

test("Help & Setup renders a replay link to the onboarding tour", async () => {
  // Stub db.execute for the language lookup; no cookie => default English.
  const db = { execute: async () => ({ rows: [] }) };
  const req = { headers: {} };
  const html = await helpSetupSection.render({ req, db, lang: "en" });
  assert.ok(html.includes("/dashboard/onboarding?step=0"), "links to onboarding step 0");
  assert.ok(html.includes(i18n.t("onboarding.replayLink", "en")), "uses the replay link label");
});

test("Help & Setup replay link honors Spanish (DB language = es)", async () => {
  // render() resolves language DB-first; lock that the ES label is emitted so a
  // future refactor that drops cookie/DB resolution is caught.
  const db = { execute: async () => ({ rows: [{ value: "es" }] }) };
  const req = { headers: {} };
  const html = await helpSetupSection.render({ req, db, lang: "en" });
  assert.ok(html.includes("/dashboard/onboarding?step=0"), "links to onboarding step 0");
  assert.ok(html.includes(i18n.t("onboarding.replayLink", "es")), "uses the ES replay label");
});

test("done step sets onboarding_completed_at exactly once", async () => {
  const calls = [];
  const mkDb = (existingValue) => ({
    async execute(q) {
      const sql = typeof q === "string" ? q : q.sql;
      calls.push(sql);
      if (/SELECT/i.test(sql) && /onboarding_completed_at|dashboard_settings/i.test(sql)) {
        return { rows: existingValue ? [{ value: existingValue }] : [] };
      }
      return { rows: [] };
    },
  });

  // First visit to done: flag absent -> a write (INSERT/UPDATE/REPLACE) must happen.
  const layout = ({ content }) => content;
  const res = { send() {}, setHeader() {} };
  const req = { method: "GET", query: { step: DONE_STEP }, headers: {} };
  calls.length = 0;
  await onboardingPanel.handler(req, res, { layout, lang: "en", db: mkDb(null) });
  assert.ok(
    calls.some((s) => /INSERT|UPDATE|REPLACE/i.test(s)),
    "first done visit must persist onboarding_completed_at",
  );

  // Second visit: flag present -> no write.
  calls.length = 0;
  await onboardingPanel.handler(req, res, { layout, lang: "en", db: mkDb("2026-06-11T00:00:00Z") });
  assert.ok(
    !calls.some((s) => /INSERT|UPDATE|REPLACE/i.test(s)),
    "subsequent done visits must not rewrite the flag",
  );
});
