/**
 * providersSignal (F-HEALTH-1) — nest health signal for alwaysResident provider
 * residency. Drives collectHealthSignals and asserts on the `providers` detail /
 * issue, mirroring tests/messages-health-signal.test.js. Clock injected via
 * opts.now; state driven through the provider-health.js state module.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectHealthSignals, invalidateHealthCache,
} from "../servers/gateway/dashboard/panels/nest/health-signals.js";
import {
  setResidencyInitialized, recordResidency, _resetProviderHealth,
} from "../servers/gateway/provider-health.js";
import { _resetReceiveHealth } from "../servers/sharing/receive-health.js";
import { t } from "../servers/gateway/dashboard/shared/i18n.js";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const THRESHOLD = 10 * MIN;

// Stub db: every query returns empty rows. messagesSignal short-circuits to
// "off" while receiveWired is null (we reset it), so it never reads db here.
const db = { execute: async () => ({ rows: [] }) };

async function providers(opts = {}) {
  _resetReceiveHealth(); // keep the messages signal quiet / non-interfering
  invalidateHealthCache(); // 30s module cache + _cacheLang
  const r = await collectHealthSignals(db, opts);
  return {
    detail: r.details.find((d) => d.id === "providers"),
    issue: r.issues.find((i) => i.id === "providers"),
    all: r,
  };
}

const at = (ms) => () => ms;

test("not initialized → off, no issue", async () => {
  _resetProviderHealth();
  const { detail, issue } = await providers({ now: at(NOW) });
  assert.equal(detail.state, "off");
  assert.equal(issue, undefined);
});

test("initialized, zero providers → off, no issue", async () => {
  _resetProviderHealth();
  setResidencyInitialized();
  const { detail, issue } = await providers({ now: at(NOW) });
  assert.equal(detail.state, "off");
  assert.equal(issue, undefined);
});

test("all ready → ok, no issue, value mentions the resident count", async () => {
  _resetProviderHealth();
  setResidencyInitialized();
  recordResidency("crow-voice", { ready: true, nowMs: NOW, baseUrl: "http://x:8011/v1", embed: false });
  const { detail, issue } = await providers({ now: at(NOW) });
  assert.equal(detail.state, "ok");
  assert.equal(issue, undefined);
  assert.match(detail.value, /1/);
  assert.match(detail.value, /resident/i);
});

test("not-ready UNDER the threshold → ok, no issue (warm/deferred window)", async () => {
  _resetProviderHealth();
  setResidencyInitialized();
  // firstOwnedAt stamped at NOW, never answered
  recordResidency("crow-voice", { ready: false, nowMs: NOW, baseUrl: "http://x:8011/v1", embed: false });
  const { detail, issue } = await providers({ now: at(NOW + 1 * MIN) });
  assert.equal(detail.state, "ok");
  assert.equal(issue, undefined);
});

test("not-ready OVER the threshold → one warn issue id=providers", async () => {
  _resetProviderHealth();
  setResidencyInitialized();
  recordResidency("crow-voice", { ready: false, nowMs: NOW, baseUrl: "http://x:8011/v1", embed: false });
  const { detail, issue } = await providers({ now: at(NOW + THRESHOLD + MIN) });
  assert.equal(detail.state, "warn");
  assert.ok(issue);
  assert.equal(issue.id, "providers");
  assert.equal(issue.severity, "warn");
});

test("never-ready-since-ownership clocks from firstOwnedAt (grackle case)", async () => {
  _resetProviderHealth();
  setResidencyInitialized();
  // lastReadyAt stays null; firstOwnedAt = NOW
  recordResidency("grackle-embed", { ready: false, nowMs: NOW, baseUrl: "http://y:9100/v1", embed: true });
  const { detail, issue } = await providers({ now: at(NOW + THRESHOLD + MIN) });
  assert.equal(detail.state, "warn");
  assert.ok(issue);
});

test("was-ready-then-down: clock runs from lastReadyAt, not firstOwnedAt", async () => {
  _resetProviderHealth();
  setResidencyInitialized();
  const url = "http://x:8011/v1";
  // firstOwnedAt = NOW (never-ready), then a success at NOW+20m, then down at NOW+21m
  recordResidency("crow-voice", { ready: false, nowMs: NOW, baseUrl: url, embed: false });
  recordResidency("crow-voice", { ready: true, nowMs: NOW + 20 * MIN, baseUrl: url, embed: false });
  recordResidency("crow-voice", { ready: false, nowMs: NOW + 21 * MIN, baseUrl: url, embed: false });
  // now: 25m past NOW (> threshold from firstOwnedAt) but only 5m past lastReadyAt
  const { detail, issue } = await providers({ now: at(NOW + 25 * MIN) });
  assert.equal(detail.state, "ok", "must NOT warn: now - lastReadyAt < threshold");
  assert.equal(issue, undefined);
});

test("embed vs non-embed down → different issue copy; non-embed omits 'embed'", async () => {
  // embed provider down → EMBED issue copy
  _resetProviderHealth();
  setResidencyInitialized();
  recordResidency("grackle-embed", { ready: false, nowMs: NOW, baseUrl: "http://y:9100/v1", embed: true });
  const embedIssue = (await providers({ now: at(NOW + THRESHOLD + MIN) })).issue;
  assert.ok(embedIssue);
  const embedLabel = embedIssue.label;

  // non-embed provider down → NON-embed issue copy
  _resetProviderHealth();
  setResidencyInitialized();
  recordResidency("crow-voice", { ready: false, nowMs: NOW, baseUrl: "http://x:8011/v1", embed: false });
  const voiceIssue = (await providers({ now: at(NOW + THRESHOLD + MIN) })).issue;
  assert.ok(voiceIssue);
  const voiceLabel = voiceIssue.label;

  assert.notEqual(embedLabel, voiceLabel);
  assert.doesNotMatch(voiceLabel, /embed/i, "non-embed issue copy must not mention embedding");
  // The issue label becomes the notification title, so a lone down provider
  // must be named in it — no unresolved {name} placeholder either.
  assert.match(embedLabel, /grackle-embed/);
  assert.match(voiceLabel, /crow-voice/);
  for (const l of [embedLabel, voiceLabel]) assert.doesNotMatch(l, /\{name\}/);
});

test("two providers over threshold → exactly ONE issue, multi copy", async () => {
  _resetProviderHealth();
  setResidencyInitialized();
  recordResidency("crow-voice", { ready: false, nowMs: NOW, baseUrl: "http://x:8011/v1", embed: false });
  recordResidency("other-model", { ready: false, nowMs: NOW, baseUrl: "http://x:8012/v1", embed: false });
  const { detail, all } = await providers({ now: at(NOW + THRESHOLD + MIN) });
  assert.equal(detail.state, "warn");
  const providerIssues = all.issues.filter((i) => i.id === "providers");
  assert.equal(providerIssues.length, 1);
  assert.match(detail.value, /2/); // downMulti mentions the count
});

test("CROW_PROVIDER_NOT_READY_WARN_MS override is honored", async () => {
  const prev = process.env.CROW_PROVIDER_NOT_READY_WARN_MS;
  try {
    _resetProviderHealth();
    setResidencyInitialized();
    recordResidency("crow-voice", { ready: false, nowMs: NOW, baseUrl: "http://x:8011/v1", embed: false });
    // 5 min out: OK at the 10-min default...
    let r = await providers({ now: at(NOW + 5 * MIN) });
    assert.equal(r.detail.state, "ok");
    // ...but WARN once the threshold is lowered to 1 min.
    process.env.CROW_PROVIDER_NOT_READY_WARN_MS = String(1 * MIN);
    r = await providers({ now: at(NOW + 5 * MIN) });
    assert.equal(r.detail.state, "warn");
    assert.ok(r.issue);
  } finally {
    if (prev === undefined) delete process.env.CROW_PROVIDER_NOT_READY_WARN_MS;
    else process.env.CROW_PROVIDER_NOT_READY_WARN_MS = prev;
  }
});

test("EN and ES render for all 11 keys (output never equals the raw key)", () => {
  const keys = [
    "signals.providers.label",
    "signals.providers.notStarted",
    "signals.providers.off",
    "signals.providers.resident",
    "signals.providers.warming",
    "signals.providers.down",
    "signals.providers.downMulti",
    "signals.providers.downIssue",
    "signals.providers.downIssueEmbed",
    "signals.providers.downIssueMulti",
    "signals.providers.action",
  ];
  assert.equal(keys.length, 11);
  for (const key of keys) {
    for (const lang of ["en", "es"]) {
      const rendered = t(key, lang);
      assert.notEqual(rendered, key, `missing i18n for ${key} (${lang})`);
      assert.ok(rendered && rendered.length > 0);
    }
  }
});

test("providersSignal never breaks its siblings (warn state still yields other signals)", async () => {
  _resetProviderHealth();
  setResidencyInitialized();
  recordResidency("crow-voice", { ready: false, nowMs: NOW, baseUrl: "http://x:8011/v1", embed: false });
  const { detail, all } = await providers({ now: at(NOW + THRESHOLD + MIN) });
  assert.equal(detail.state, "warn");
  assert.ok(all.details.length > 1);
  assert.ok(all.details.some((d) => d.id === "disk"), "disk signal still present");
});
