/** Settings › Notifications › Phone notifications (ntfy autowire) — render + actions, hermetic. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  renderNtfyPushPanel, handleNtfyPushAction, _setNtfyPanelDepsForTest, NTFY_ACTIONS,
} from "../servers/gateway/dashboard/settings/ntfy-push-panel.js";
import { writeStoredNtfyConfig, readStoredNtfyConfig, recordNtfyStatus, readNtfyStatus } from "../servers/gateway/push/ntfy-config.js";
import { t } from "../servers/gateway/dashboard/shared/i18n.js";
import section from "../servers/gateway/dashboard/settings/sections/notifications.js";

function env() {
  const d = mkdtempSync(join(tmpdir(), "ntfy-panel-"));
  mkdirSync(join(d, "data"));
  return { CROW_DATA_DIR: join(d, "data") };
}
function fakeRes() {
  const r = { to: null };
  r.redirectAfterPost = (u) => { r.to = u; };
  return r;
}

test("not configured: explains and offers Set up", () => {
  const html = renderNtfyPushPanel({ csrf: "c1", lang: "en", env: env() });
  assert.match(html, new RegExp(t("ntfyPush.notConfigured", "en").slice(0, 20)));
  assert.match(html, /name="action" value="ntfy_setup"/);
  assert.match(html, /name="_csrf" value="c1"/);
  assert.doesNotMatch(html, /ntfy_test/);
});

test("auto mode: channel, address form, phone/last-push status, test + repair; values escaped; no tokens shown", () => {
  const e = env();
  writeStoredNtfyConfig({ topic: "crow-0867ac2809", publisherToken: "tk_SECRETPUB", subscriberToken: "tk_SECRETAPP", externalUrl: "https://h.ts.net:8445" }, e);
  recordNtfyStatus({ appFetchedAt: "2026-10-03T12:00:00.000Z", lastPushAt: "2026-10-03T12:01:00.000Z", lastPushOk: false, lastPushError: "<b>ntfy answered HTTP 403</b>" }, e);
  const html = renderNtfyPushPanel({ csrf: "c", lang: "en", env: e });
  assert.match(html, /crow-0867ac2809/);
  assert.match(html, /name="external_url"[^>]*value="https:\/\/h\.ts\.net:8445"/);
  assert.match(html, /value="ntfy_test"/);
  assert.match(html, /value="ntfy_setup"/);
  assert.match(html, new RegExp(t("ntfyPush.lastFail", "en")));
  assert.match(html, /&lt;b&gt;ntfy answered HTTP 403/);
  assert.doesNotMatch(html, /tk_SECRET/);
  assert.doesNotMatch(html, new RegExp(t("ntfyPush.appNever", "en").slice(0, 20)));
});

test("env mode: says so, offers the test but not repair or the address form", () => {
  const e = { ...env(), NTFY_TOPIC: "kevin", NTFY_EXTERNAL_URL: "https://n.example" };
  const html = renderNtfyPushPanel({ csrf: "c", lang: "es", env: e });
  assert.match(html, new RegExp(t("ntfyPush.sourceEnv", "es").slice(0, 20)));
  assert.match(html, /value="ntfy_test"/);
  assert.doesNotMatch(html, /value="ntfy_setup"/);
  assert.doesNotMatch(html, /name="external_url"/);
});

test("setup action: runs the provisioner, records the result, redirects with a flash", async () => {
  const e = env();
  _setNtfyPanelDepsForTest({ provision: async () => ({ ok: false, reason: "The notification server (crow-ntfy) is not running" }) });
  try {
    const res = fakeRes();
    assert.equal(await handleNtfyPushAction({ req: { body: {} }, res, action: "ntfy_setup", env: e }), true);
    assert.match(res.to, /section=notifications&ntfy=setup_fail#ntfy-push$/);
    assert.equal(readNtfyStatus(e).lastSetupOk, false);
    assert.match(renderNtfyPushPanel({ csrf: "c", lang: "en", env: e, flash: "setup_fail" }), /not running/);

    _setNtfyPanelDepsForTest({ provision: async () => ({ ok: true, topic: "crow-x" }) });
    const res2 = fakeRes();
    await handleNtfyPushAction({ req: { body: {} }, res: res2, action: "ntfy_setup", env: e });
    assert.match(res2.to, /ntfy=setup_ok/);

    // An env host is never auto-provisioned from the button.
    let called = false;
    _setNtfyPanelDepsForTest({ provision: async () => { called = true; return { ok: true }; } });
    const res3 = fakeRes();
    await handleNtfyPushAction({ req: { body: {} }, res: res3, action: "ntfy_setup", env: { ...e, NTFY_TOPIC: "k" } });
    assert.equal(called, false);
    assert.match(res3.to, /ntfy=env/);
  } finally {
    _setNtfyPanelDepsForTest();
  }
});

test("save address: validates, preserves tokens, can clear", async () => {
  const e = env();
  const res0 = fakeRes();
  await handleNtfyPushAction({ req: { body: { external_url: "https://x" } }, res: res0, action: "ntfy_save_url", env: e });
  assert.match(res0.to, /url_bad/, "nothing provisioned yet");
  writeStoredNtfyConfig({ topic: "crow-x", publisherToken: "tk_p", subscriberToken: "tk_a" }, e);
  const res = fakeRes();
  await handleNtfyPushAction({ req: { body: { external_url: "https://h.ts.net:8445/" } }, res, action: "ntfy_save_url", env: e });
  assert.match(res.to, /url_ok/);
  assert.equal(readStoredNtfyConfig(e).externalUrl, "https://h.ts.net:8445");
  assert.equal(readStoredNtfyConfig(e).publisherToken, "tk_p");
  const bad = fakeRes();
  await handleNtfyPushAction({ req: { body: { external_url: "javascript:alert(1)" } }, res: bad, action: "ntfy_save_url", env: e });
  assert.match(bad.to, /url_bad/);
  assert.equal(readStoredNtfyConfig(e).externalUrl, "https://h.ts.net:8445");
  await handleNtfyPushAction({ req: { body: { external_url: "" } }, res: fakeRes(), action: "ntfy_save_url", env: e });
  assert.equal(readStoredNtfyConfig(e).externalUrl, "");
});

test("test action sends a localized system notification and flashes the outcome", async () => {
  const sent = [];
  _setNtfyPanelDepsForTest({ send: async (p) => { sent.push(p); return { ok: true, status: 200 }; } });
  try {
    const res = fakeRes();
    await handleNtfyPushAction({ req: { body: {} }, res, action: "ntfy_test", lang: "es", env: env() });
    assert.equal(sent[0].title, t("ntfyPush.testTitle", "es"));
    assert.equal(sent[0].type, "system");
    assert.match(res.to, /ntfy=test_ok/);
    _setNtfyPanelDepsForTest({ send: async () => ({ ok: false, skipped: true }) });
    const res2 = fakeRes();
    await handleNtfyPushAction({ req: { body: {} }, res: res2, action: "ntfy_test", env: env() });
    assert.match(res2.to, /ntfy=test_off/);
  } finally {
    _setNtfyPanelDepsForTest();
  }
});

test("the Notifications section routes ntfy_* actions and leaves others alone", async () => {
  assert.ok(NTFY_ACTIONS.has("ntfy_test"));
  assert.equal(await handleNtfyPushAction({ req: {}, res: fakeRes(), action: "save_notification_prefs" }), false);
  _setNtfyPanelDepsForTest({ send: async () => ({ ok: true }) });
  try {
    const res = fakeRes();
    assert.equal(await section.handleAction({ req: { body: {} }, res, db: null, action: "ntfy_test", lang: "en" }), true);
    assert.match(res.to, /ntfy=test_ok/);
  } finally {
    _setNtfyPanelDepsForTest();
  }
});

test("every ntfyPush.* string has en + es", () => {
  for (const k of ["title", "intro", "sourceAuto", "sourceEnv", "notConfigured", "channel", "address", "addressHelp", "addressEnv", "addressNone", "saveAddress", "badAddress", "appFetched", "appNever", "lastOk", "lastFail", "lastNone", "setup", "repair", "setupOk", "setupFail", "envBlocks", "test", "testTitle", "testBody", "testSent", "testFailed"]) {
    assert.notEqual(t(`ntfyPush.${k}`, "en"), `ntfyPush.${k}`);
    assert.notEqual(t(`ntfyPush.${k}`, "es"), t(`ntfyPush.${k}`, "en"), `ntfyPush.${k} es`);
  }
});
