import { test } from "node:test";
import assert from "node:assert/strict";
import * as i18n from "../servers/gateway/dashboard/shared/i18n.js";

// The full set of onboarding.* keys the feature depends on. t() returns the
// key string unchanged when a key is missing, so "resolves" == "value present".
export const ONBOARDING_KEYS = [
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

test("every onboarding.* key resolves in both en and es", () => {
  for (const k of ONBOARDING_KEYS) {
    const en = i18n.t(k, "en");
    const es = i18n.t(k, "es");
    assert.ok(en && en !== k, `missing en value for ${k}`);
    assert.ok(es && es !== k, `missing es value for ${k}`);
  }
});
