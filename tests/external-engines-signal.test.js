/**
 * externalEngines nest signal (spec 2026-09-23 external-engine-provider §2.4,
 * revised in review rounds 1+2): its OWN id, info at most, never warn, and the
 * resident `providers` signal never carries external content.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectHealthSignals, invalidateHealthCache, _setTailscaleReader, _setDiskReader,
} from "../servers/gateway/dashboard/panels/nest/health-signals.js";
import {
  setResidencyInitialized, recordResidency, recordExternal, _resetProviderHealth,
} from "../servers/gateway/provider-health.js";
import { _resetReceiveHealth } from "../servers/sharing/receive-health.js";
import { t } from "../servers/gateway/dashboard/shared/i18n.js";

// This file's fixed NOW (2027) and the real `ok` check below are not driven
// through collectHealthSignals' injectable seams for two sibling signals:
// backupSignal reads real mtimes under CROW_BACKUP_DIR (a fixed future NOW
// would read a live install's real backups as impossibly stale), and
// exposureSignal shells out to the real `tailscale` CLI. Neutralize both the
// same way tests/security-signals.test.js does (inertTailscale), so `all.ok`
// reflects only the externalEngines signal under test, on any host.
process.env.CROW_BACKUP_DIR = "/tmp/__crow_test_nonexistent_backup_dir__";
_setTailscaleReader(() => { throw new Error("no tailscale"); });
// diskSignal ran the real `df /`: on a host whose root fs is >90% full it
// warns, `all.ok` goes false, and the "nest stays ok" assertion failed
// locally while passing on CI's roomy runners (B6, 2026-10-02). Feed it a
// fixed half-full reading instead. The other env-driven siblings are pinned
// for the same reason: MINIO_ENDPOINT makes storageSignal probe the network
// (warn when unreachable); the exposure flags warn when set in the shell.
_setDiskReader(() => "Avail Size\n500000M 1000000M\n");
delete process.env.MINIO_ENDPOINT;
delete process.env.CROW_DASHBOARD_PUBLIC;
delete process.env.CROW_CSRF_STRICT;

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const RAVEN = "http://10.0.0.126:8030/v1";
const db = { execute: async () => ({ rows: [] }) };
const at = (ms) => () => ms;

async function signals(opts = {}) {
  _resetReceiveHealth();
  invalidateHealthCache();
  const r = await collectHealthSignals(db, opts);
  return {
    ext: r.details.find((d) => d.id === "externalEngines"),
    extIssue: r.issues.find((i) => i.id === "externalEngines"),
    prov: r.details.find((d) => d.id === "providers"),
    provIssue: r.issues.find((i) => i.id === "providers"),
    all: r,
  };
}
function ext(ready, nowMs, extra = {}) {
  recordExternal("raven-flash-next", { ready, nowMs, baseUrl: RAVEN, engineHost: "raven", label: "halogen", ...extra });
}

test("no external engines watched → no externalEngines card at all", async () => {
  _resetProviderHealth();
  setResidencyInitialized();
  const { ext: card, all } = await signals({ now: at(NOW) });
  assert.equal(card, undefined);
  assert.ok(all.details.some((d) => d.id === "disk"), "siblings unaffected by the null filter");
  assert.equal(all.details.find((d) => d.id === "disk").value, "50% used", "the fixed disk reading, never the host's df");
});

test("up → ok card 'halogen on raven: up', no issue", async () => {
  _resetProviderHealth();
  setResidencyInitialized();
  ext(true, NOW);
  const { ext: card, extIssue } = await signals({ now: at(NOW) });
  assert.equal(card.state, "ok");
  assert.equal(card.value, "halogen on raven: up");
  assert.equal(extIssue, undefined);
});

test("never answered → info 'not reachable from this instance'; nest stays ok", async () => {
  _resetProviderHealth();
  setResidencyInitialized();
  ext(false, NOW);
  const { ext: card, extIssue, all } = await signals({ now: at(NOW + 10 * HOUR) });
  assert.equal(card.state, "info");
  assert.equal(extIssue.severity, "info");
  assert.equal(extIssue.label, "halogen on raven: not reachable from this instance");
  assert.equal(all.ok, true);
});

test("answered once, down for HOURS → still info: 'down for 10h (externally managed)'; never a warn", async () => {
  _resetProviderHealth();
  setResidencyInitialized();
  ext(true, NOW);
  ext(false, NOW + MIN);
  const { extIssue, all } = await signals({ now: at(NOW + 10 * HOUR) });
  assert.equal(extIssue.severity, "info");
  assert.equal(extIssue.label, "halogen on raven: down for 10h (externally managed)");
  assert.equal(all.issues.filter((i) => i.severity === "warn" && i.id === "externalEngines").length, 0);
});

test("down for under a minute reads '<1m', never 'now'", async () => {
  _resetProviderHealth();
  setResidencyInitialized();
  ext(true, NOW);
  ext(false, NOW + 1000);
  const { ext: card } = await signals({ now: at(NOW + 20_000) });
  assert.equal(card.value, "halogen on raven: down for <1m (externally managed)");
});

test("the resident providers signal carries NO external content and no external-driven issue", async () => {
  _resetProviderHealth();
  setResidencyInitialized();
  ext(false, NOW); // external engine never reachable
  let r = await signals({ now: at(NOW + HOUR) });
  assert.equal(r.prov.state, "off", "no resident rows → providers is off, exactly as before");
  assert.equal(r.provIssue, undefined);

  recordResidency("crow-voice", { ready: true, nowMs: NOW, baseUrl: "http://x:8011/v1", embed: false });
  r = await signals({ now: at(NOW + HOUR) });
  assert.equal(r.prov.state, "ok");
  assert.equal(r.prov.value, "1 resident");
  assert.equal(r.provIssue, undefined);
});

test("free-text label/host render verbatim through fill() — '$&' is not a replacement pattern", async () => {
  _resetProviderHealth();
  setResidencyInitialized();
  recordExternal("raven-flash-next", { ready: true, nowMs: NOW, baseUrl: RAVEN, engineHost: "r$&n", label: "h$'x" });
  const { ext: card } = await signals({ now: at(NOW) });
  assert.equal(card.value, "h$'x on r$&n: up");
});

test("Spanish: translated label and lines", async () => {
  _resetProviderHealth();
  setResidencyInitialized();
  ext(false, NOW);
  const { ext: card, extIssue } = await signals({ now: at(NOW), lang: "es" });
  assert.equal(card.label, "Motores externos");
  assert.equal(extIssue.label, "halogen en raven: no accesible desde esta instancia");
});

test("EN and ES render for the 5 externalEngines keys", () => {
  for (const key of [
    "signals.externalEngines.label", "signals.externalEngines.up", "signals.externalEngines.downFor",
    "signals.externalEngines.unreachable", "signals.externalEngines.action",
  ]) {
    for (const lang of ["en", "es"]) assert.notEqual(t(key, lang), key, `missing i18n for ${key} (${lang})`);
    assert.notEqual(t(key, "es"), t(key, "en"), `${key}: es must be a real translation`);
  }
});

test("B6: a full disk (sibling warn) is what flips ok — the externalEngines issue stays info either way", async () => {
  _resetProviderHealth();
  setResidencyInitialized();
  ext(false, NOW);
  _setDiskReader(() => "Avail Size\n10000M 1000000M\n");   // 1% free
  try {
    const { extIssue, all } = await signals({ now: at(NOW + 10 * HOUR) });
    assert.equal(all.ok, false, "the disk warn drives ok");
    assert.equal(extIssue.severity, "info", "never a warn from the external engine");
    assert.ok(all.issues.some((i) => i.id === "disk" && i.severity === "warn"));
  } finally {
    _setDiskReader(() => "Avail Size\n500000M 1000000M\n");
  }
});
