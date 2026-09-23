/**
 * The health monitor's notify cycle (post-listen.js), driven end to end through
 * collectHealthSignals + the extracted runHealthNotifyCycle (review round 2,
 * item 1). The dedupe map is keyed by issue id with a 24 h window, and
 * pruneResolved keeps a marker alive while ANY issue with that id is active —
 * so if external engines shared the "providers" id, an external info issue
 * would keep the resident warn's marker alive and swallow the next real
 * resident push. This test pins that it does not.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectHealthSignals, invalidateHealthCache, runHealthNotifyCycle,
} from "../servers/gateway/dashboard/panels/nest/health-signals.js";
import {
  setResidencyInitialized, recordResidency, recordExternal, _resetProviderHealth,
} from "../servers/gateway/provider-health.js";
import { _resetReceiveHealth } from "../servers/sharing/receive-health.js";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const VOICE = "http://x:8011/v1";
const RAVEN = "http://10.0.0.126:8030/v1";
const db = { execute: async () => ({ rows: [] }) };

async function monitorCycle(lastMap, nowMs) {
  _resetReceiveHealth();
  invalidateHealthCache();
  const signals = await collectHealthSignals(db, { now: () => nowMs });
  const pushed = [];
  const r = await runHealthNotifyCycle({
    issues: signals.issues, lastMap, nowMs,
    notify: async (issue) => { pushed.push(issue.id); },
  });
  return { lastMap: r.lastMap, pushed, issues: signals.issues };
}

test("resident warn → pushed; recovers while an external engine is down; warns again within 24h → pushed AGAIN", async () => {
  _resetProviderHealth();
  setResidencyInitialized();

  // Cycle 1: crow-voice never answered for 11 min → warn → push.
  recordResidency("crow-voice", { ready: false, nowMs: NOW, baseUrl: VOICE, embed: false });
  let c = await monitorCycle({}, NOW + 11 * MIN);
  assert.ok(c.pushed.includes("providers"), "first resident outage pushes");

  // Between cycles: crow-voice recovers; raven's halogen answered, then stopped (a prod window).
  recordResidency("crow-voice", { ready: true, nowMs: NOW + 20 * MIN, baseUrl: VOICE, embed: false });
  recordExternal("raven-flash-next", { ready: true, nowMs: NOW + 20 * MIN, baseUrl: RAVEN, engineHost: "raven", label: "halogen" });
  recordExternal("raven-flash-next", { ready: false, nowMs: NOW + 25 * MIN, baseUrl: RAVEN, engineHost: "raven", label: "halogen" });

  // Cycle 2: resident fine, external down → only an externalEngines INFO issue.
  c = await monitorCycle(c.lastMap, NOW + 30 * MIN);
  assert.equal(c.issues.find((i) => i.id === "providers"), undefined, "no providers issue while the resident is fine");
  assert.equal(c.issues.find((i) => i.id === "externalEngines")?.severity, "info");
  assert.equal(c.lastMap.providers, undefined, "the resident incident's marker was pruned");
  assert.ok(!c.pushed.includes("externalEngines"), "external engines never push");

  // Cycle 3 (well inside 24 h of cycle 1): crow-voice down again for 20 min → MUST push again.
  recordResidency("crow-voice", { ready: false, nowMs: NOW + 40 * MIN, baseUrl: VOICE, embed: false });
  c = await monitorCycle(c.lastMap, NOW + 60 * MIN);
  assert.ok(c.pushed.includes("providers"), "a new resident outage within 24 h is pushed, not swallowed");
});

test("runHealthNotifyCycle: warn-only, 24 h window, a failed notify leaves no marker, resolved ids pruned", async () => {
  const warn = { id: "disk", severity: "warn", label: "Disk" };
  const info = { id: "peers", severity: "info", label: "Peers" };
  let r = await runHealthNotifyCycle({ issues: [warn, info], lastMap: {}, nowMs: 1000, notify: async () => {} });
  assert.deepEqual(r.pushed, ["disk"]);
  assert.deepEqual(r.lastMap, { disk: 1000 });
  assert.equal(r.dirty, true);
  r = await runHealthNotifyCycle({ issues: [warn], lastMap: r.lastMap, nowMs: 2000, notify: async () => {} });
  assert.deepEqual(r.pushed, [], "inside the 24 h window");
  assert.equal(r.dirty, false);
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    r = await runHealthNotifyCycle({ issues: [{ id: "backup", severity: "warn" }], lastMap: {}, nowMs: 1, notify: async () => { throw new Error("ntfy down"); } });
  } finally { console.warn = origWarn; }
  assert.deepEqual(r.lastMap, {}, "a failed notification is retried next cycle");
  r = await runHealthNotifyCycle({ issues: [], lastMap: { disk: 1000 }, nowMs: 3000, notify: async () => {} });
  assert.deepEqual(r.lastMap, {});
  assert.equal(r.dirty, true);
});
