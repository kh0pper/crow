import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  isSafeBundleId, composeFile, localAlwaysResident,
  pollResidency, startResidencyMonitor, _stopResidencyMonitor,
} from "../servers/gateway/gpu-orchestrator.js";
import {
  _resetProviderHealth, getProviderHealth,
} from "../servers/gateway/provider-health.js";

// --- helpers ------------------------------------------------------------

const CROW_IP = "100.118.41.122";
const GRACKLE_IP = "100.121.254.89";
const OTHER_IP = "10.9.9.9";

const own = (...ips) => new Set(["localhost", "127.0.0.1", "::1", ...ips]);
const CROW = own(CROW_IP);

// A declared alwaysResident provider with a safe bundle by default.
const prov = (baseUrl, extra = {}) => ({
  baseUrl,
  bundleId: "safe-bundle",
  gpuPolicy: { alwaysResident: true },
  ...extra,
});

// A probe recorder — remembers which baseUrls it was asked about.
function makeProbe(result = true) {
  const seen = [];
  const fn = async (url) => {
    seen.push(url);
    if (typeof result === "function") return result(url);
    return result;
  };
  fn.seen = seen;
  return fn;
}

const yes = () => true; // composeExists that always says the file exists

beforeEach(() => { _resetProviderHealth(); _stopResidencyMonitor(); });
afterEach(() => { _stopResidencyMonitor(); });

// --- isSafeBundleId / composeFile ---------------------------------------

test("isSafeBundleId accepts single safe path segments", () => {
  for (const ok of ["vllm-cuda-embed", "a1", "a.b_c-d", "Z", "9x"]) {
    assert.equal(isSafeBundleId(ok), true, `expected accept: ${ok}`);
  }
});

test("isSafeBundleId rejects empty, non-strings, traversal, separators, leading . or -", () => {
  for (const bad of ["", null, undefined, 123, {}, [], "123/x", "..", ".", "a/b", "a\\b", "-x", ".hidden", "../foo", "/abs"]) {
    assert.equal(isSafeBundleId(bad), false, `expected reject: ${JSON.stringify(bad)}`);
  }
});

test('composeFile("..") throws instead of resolving to the repo-root docker-compose.yml', () => {
  assert.throws(() => composeFile(".."), /unsafe|bundleId/i);
  assert.throws(() => composeFile("a/b"), /unsafe|bundleId/i);
  // a safe id still returns a path
  assert.ok(composeFile("safe-bundle").endsWith("/safe-bundle/docker-compose.yml"));
});

// --- localAlwaysResident ------------------------------------------------

test("localAlwaysResident returns only declared+locally-orchestratable names, and does not log", () => {
  const cfg = { providers: {
    "crow-voice": prov(`http://${CROW_IP}:8011/v1`),
    "grackle-embed": prov(`http://${GRACKLE_IP}:9100/v1`),
  } };
  const logs = [];
  const orig = console.log; console.log = (m) => logs.push(String(m));
  try {
    assert.deepEqual(localAlwaysResident(cfg, CROW), ["crow-voice"]);
  } finally { console.log = orig; }
  assert.equal(logs.length, 0, "localAlwaysResident must not log");
});

// --- pollResidency: ownership + traps -----------------------------------

test("trap 1: probes only owned providers; a peer's provider is never probed nor recorded", async () => {
  const cfg = { providers: {
    "crow-voice": prov(`http://${CROW_IP}:8011/v1`),
    "grackle-embed": prov(`http://${GRACKLE_IP}:9100/v1`),
  } };
  const probe = makeProbe(true);
  const probed = await pollResidency({ cfg, ownAddrs: CROW, probe, now: () => 1000, composeExists: yes });
  assert.deepEqual(probed, ["crow-voice"]);
  assert.deepEqual(probe.seen, [`http://${CROW_IP}:8011/v1`]);
  const h = getProviderHealth().providers;
  assert.ok(h["crow-voice"], "crow-voice recorded");
  assert.equal(h["grackle-embed"], undefined, "peer provider never recorded");
});

test("trap 2: a provider that becomes local on tick 2 is stamped firstOwnedAt at tick 2's clock", async () => {
  const cfg1 = { providers: { p: prov(`http://${OTHER_IP}:8080/v1`) } };
  await pollResidency({ cfg: cfg1, ownAddrs: CROW, probe: makeProbe(false), now: () => 1000, composeExists: yes });
  assert.equal(getProviderHealth().providers.p, undefined, "not owned on tick 1 → not recorded");

  const cfg2 = { providers: { p: prov(`http://${OTHER_IP}:8080/v1`) } };
  await pollResidency({ cfg: cfg2, ownAddrs: own(OTHER_IP), probe: makeProbe(false), now: () => 5000, composeExists: yes });
  const p = getProviderHealth().providers.p;
  assert.ok(p, "owned on tick 2 → recorded");
  assert.equal(p.firstOwnedAt, 5000, "clock starts at tick 2, not boot");
});

test("CRITICAL: a provider that drops out of the local set (tailscale0 flap) is STILL probed and its clock is NOT reset", async () => {
  const cfg = { providers: { "crow-voice": prov(`http://${CROW_IP}:8011/v1`) } };
  // tick 1: local, not ready → clock starts at T=1000
  await pollResidency({ cfg, ownAddrs: CROW, probe: makeProbe(false), now: () => 1000, composeExists: yes });
  const after1 = getProviderHealth().providers["crow-voice"];
  assert.ok(after1, "recorded on tick 1");
  assert.equal(after1.firstOwnedAt, 1000);

  // tick 2: ownAddrs NO LONGER contains the address (tailscale0 restart).
  // Full tick, INCLUDING the internal pruneResidency call.
  const probe2 = makeProbe(false);
  const probed = await pollResidency({ cfg, ownAddrs: own(), probe: probe2, now: () => 9999, composeExists: yes });
  assert.deepEqual(probed, ["crow-voice"], "still probed despite failing the locality check");
  assert.deepEqual(probe2.seen, [`http://${CROW_IP}:8011/v1`]);
  const after2 = getProviderHealth().providers["crow-voice"];
  assert.ok(after2, "entry still exists after prune");
  assert.equal(after2.firstOwnedAt, 1000, "outage clock unchanged");
});

test("ownership is released and re-evaluated when baseUrl changes", async () => {
  // own at url A
  const cfgA = { providers: { p: prov(`http://${CROW_IP}:8011/v1`) } };
  await pollResidency({ cfg: cfgA, ownAddrs: CROW, probe: makeProbe(false), now: () => 1000, composeExists: yes });
  assert.equal(getProviderHealth().providers.p.firstOwnedAt, 1000);

  // tick with url B that is NOT local → entry gone, not probed
  const cfgB = { providers: { p: prov(`http://${OTHER_IP}:9000/v1`) } };
  const probeB = makeProbe(false);
  await pollResidency({ cfg: cfgB, ownAddrs: CROW, probe: probeB, now: () => 2000, composeExists: yes });
  assert.equal(getProviderHealth().providers.p, undefined, "released on baseUrl change to a non-local url");
  assert.deepEqual(probeB.seen, [], "not probed");

  // tick with url B that IS local → fresh firstOwnedAt
  await pollResidency({ cfg: cfgB, ownAddrs: own(OTHER_IP), probe: makeProbe(false), now: () => 3000, composeExists: yes });
  assert.equal(getProviderHealth().providers.p.firstOwnedAt, 3000, "fresh ownership stamp");
});

// --- pollResidency: SSRF / compose gates --------------------------------

test("a provider with no bundleId is never probed and any existing entry is released", async () => {
  // seed an entry
  const seeded = { providers: { p: prov(`http://${CROW_IP}:8011/v1`) } };
  await pollResidency({ cfg: seeded, ownAddrs: CROW, probe: makeProbe(false), now: () => 1000, composeExists: yes });
  assert.ok(getProviderHealth().providers.p);

  const cfg = { providers: { p: prov(`http://${CROW_IP}:8011/v1`, { bundleId: null }) } };
  const probe = makeProbe(true);
  const probed = await pollResidency({ cfg, ownAddrs: CROW, probe, now: () => 2000, composeExists: yes });
  assert.deepEqual(probed, []);
  assert.deepEqual(probe.seen, []);
  assert.equal(getProviderHealth().providers.p, undefined, "released when bundleId disappears");
});

test("a provider whose compose file is absent is never probed, and an existing entry is released", async () => {
  const cfg = { providers: { p: prov(`http://${CROW_IP}:8011/v1`) } };
  await pollResidency({ cfg, ownAddrs: CROW, probe: makeProbe(false), now: () => 1000, composeExists: yes });
  assert.ok(getProviderHealth().providers.p);

  const probe = makeProbe(true);
  const probed = await pollResidency({ cfg, ownAddrs: CROW, probe, now: () => 2000, composeExists: () => false });
  assert.deepEqual(probed, []);
  assert.deepEqual(probe.seen, []);
  assert.equal(getProviderHealth().providers.p, undefined, "released when compose file vanishes");
});

test("a composeExists that throws is treated as not-orchestratable (guarded, no throw)", async () => {
  const cfg = { providers: { p: prov(`http://${CROW_IP}:8011/v1`) } };
  const probe = makeProbe(true);
  const probed = await pollResidency({
    cfg, ownAddrs: CROW, probe, now: () => 1000,
    composeExists: () => { throw new Error("stat boom"); },
  });
  assert.deepEqual(probed, []);
  assert.deepEqual(probe.seen, []);
});

// --- pollResidency: log-spam regression ---------------------------------

test("pollResidency emits NO '[gpu-orchestrator] skipping' log line", async () => {
  const cfg = { providers: {
    "crow-voice": prov(`http://${CROW_IP}:8011/v1`),
    "grackle-embed": prov(`http://${GRACKLE_IP}:9100/v1`), // skipped from crow
  } };
  const logs = [];
  const orig = console.log; console.log = (m) => logs.push(String(m));
  try {
    await pollResidency({ cfg, ownAddrs: CROW, probe: makeProbe(true), now: () => 1000, composeExists: yes });
  } finally { console.log = orig; }
  assert.ok(!logs.some((l) => l.includes("[gpu-orchestrator] skipping")), `unexpected skip log: ${logs.join(" | ")}`);
});

// --- pollResidency: error isolation -------------------------------------

test("a probe that rejects is recorded as not-ready with lastError; other providers still recorded", async () => {
  const cfg = { providers: {
    a: prov(`http://${CROW_IP}:8011/v1`),
    b: prov(`http://${CROW_IP}:8012/v1`),
  } };
  const probe = async (url) => {
    if (url.includes(":8011")) throw new Error("connect ECONNREFUSED");
    return true;
  };
  const probed = await pollResidency({ cfg, ownAddrs: CROW, probe, now: () => 1000, composeExists: yes });
  assert.deepEqual(probed.sort(), ["a", "b"]);
  const h = getProviderHealth().providers;
  assert.equal(h.a.ready, false);
  assert.match(h.a.lastError, /ECONNREFUSED/);
  assert.equal(h.b.ready, true);
});

test("a cfg whose providers getter throws does not throw and leaves prior state intact", async () => {
  // seed known-good state
  const seeded = { providers: { p: prov(`http://${CROW_IP}:8011/v1`) } };
  await pollResidency({ cfg: seeded, ownAddrs: CROW, probe: makeProbe(true), now: () => 1000, composeExists: yes });
  const before = getProviderHealth();

  const throwing = { get providers() { throw new Error("db down"); } };
  const probed = await pollResidency({ cfg: throwing, ownAddrs: CROW, probe: makeProbe(true), now: () => 2000, composeExists: yes });
  assert.deepEqual(probed, [], "no work done");
  assert.deepEqual(getProviderHealth(), before, "prior state untouched");
});

// --- pollResidency: prune via a full tick -------------------------------

test("prune via full tick: a provider removed from cfg entirely is dropped from state", async () => {
  const cfg1 = { providers: { p: prov(`http://${CROW_IP}:8011/v1`) } };
  await pollResidency({ cfg: cfg1, ownAddrs: CROW, probe: makeProbe(true), now: () => 1000, composeExists: yes });
  assert.ok(getProviderHealth().providers.p);

  // p is gone, but the config still READS (another provider remains), so this
  // is a real removal rather than a failed load.
  const other = { ...prov(`http://${CROW_IP}:9999/v1`), gpuPolicy: { alwaysResident: false } };
  const cfg2 = { providers: { other } };
  await pollResidency({ cfg: cfg2, ownAddrs: CROW, probe: makeProbe(true), now: () => 2000, composeExists: yes });
  assert.equal(getProviderHealth().providers.p, undefined, "pruned when no longer declared");
});

test("an UNREADABLE config ({providers:{}}) does not wipe outage clocks", async () => {
  // loadProviders() returns {providers:{}} when the DB and models.json are both
  // unreadable. That is indistinguishable from "all providers deleted", so it
  // must NOT prune — otherwise every bad tick restarts the 10-min warn window
  // and a long outage stays silent forever (the bug this feature exists to fix).
  const cfg1 = { providers: { p: prov(`http://${CROW_IP}:8011/v1`) } };
  await pollResidency({ cfg: cfg1, ownAddrs: CROW, probe: makeProbe(false), now: () => 1000, composeExists: yes });
  const clock = getProviderHealth().providers.p.firstOwnedAt;
  assert.equal(clock, 1000);

  await pollResidency({ cfg: { providers: {} }, ownAddrs: CROW, probe: makeProbe(false), now: () => 500_000, composeExists: yes });
  const after = getProviderHealth().providers.p;
  assert.ok(after, "entry survives an unreadable config");
  assert.equal(after.firstOwnedAt, clock, "outage clock NOT reset by an unreadable config");
});

// --- monitor lifecycle --------------------------------------------------

test("startResidencyMonitor is idempotent and _stopResidencyMonitor clears it (no leaked interval)", () => {
  startResidencyMonitor();
  startResidencyMonitor(); // second call is a no-op
  _stopResidencyMonitor();
  // if the interval leaked, the test suite would hang; reaching here is the assertion
  assert.ok(true);
});
