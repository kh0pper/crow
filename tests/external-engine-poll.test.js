/**
 * external-engine-poll (spec docs/superpowers/specs/2026-09-23-external-engine-provider-design.md §2.3).
 * Every probe goes through an injected fetch — no network. cfg is passed
 * explicitly, the clock via `now`.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  EXTERNAL_ENGINE_PROBE_TIMEOUT_MS, DEFAULT_EXTERNAL_ENGINE_POLL_MS, DB_PROVIDERS_SOURCE,
  externalEnginePollMs, externalModelsUrl, pollExternalEngines,
  startExternalEngineMonitor, _stopExternalEngineMonitor,
} from "../servers/gateway/external-engine-poll.js";
import { _resetProviderHealth, getProviderHealth } from "../servers/gateway/provider-health.js";

const ENGINE = { managed: "external", host: "raven", label: "halogen" };
const RAVEN = "http://10.0.0.126:8030/v1";
const extRow = (extra = {}) => ({
  baseUrl: RAVEN, host: "cloud", bundleId: null, apiKey: null,
  models: [{ id: "flash-next" }], gpuPolicy: { engine: ENGINE }, ...extra,
});
const DB = "db:providers"; // the _source loadProvidersFromDb sets (servers/shared/providers-db.js)
const cfgOne = (extra = {}) => ({ _source: DB, providers: {
  "raven-flash-next": extRow(extra),
  "cloud-openai": { baseUrl: "https://api.openai.com/v1", host: "cloud", apiKey: "sk-cloud" },
  "crow-voice": { baseUrl: "http://127.0.0.1:8011/v1", host: "local", bundleId: "vllm-qwen35-4b" },
} });

function recorder(respond) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    if (typeof respond === "function") return respond(url, init);
    return respond;
  };
  f.calls = calls;
  return f;
}
const ok200 = { ok: true, status: 200 };
const ext = () => getProviderHealth().external;

beforeEach(() => { _resetProviderHealth(); _stopExternalEngineMonitor(); });
afterEach(() => { _stopExternalEngineMonitor(); });

test("defaults: 3 s probe timeout, 60 s interval; CROW_EXTERNAL_ENGINE_POLL_MS overrides; 0 disables", () => {
  assert.equal(DB_PROVIDERS_SOURCE, DB);
  assert.equal(EXTERNAL_ENGINE_PROBE_TIMEOUT_MS, 3000);
  assert.equal(DEFAULT_EXTERNAL_ENGINE_POLL_MS, 60000);
  assert.equal(externalEnginePollMs({}), 60000);
  assert.equal(externalEnginePollMs({ CROW_EXTERNAL_ENGINE_POLL_MS: "" }), 60000);
  assert.equal(externalEnginePollMs({ CROW_EXTERNAL_ENGINE_POLL_MS: "15000" }), 15000);
  assert.equal(externalEnginePollMs({ CROW_EXTERNAL_ENGINE_POLL_MS: "0" }), 0);
  assert.equal(externalEnginePollMs({ CROW_EXTERNAL_ENGINE_POLL_MS: "banana" }), 60000);
});

test("only enabled, marked rows are probed — one GET <base_url>/models each", async () => {
  const f = recorder(ok200);
  const probed = await pollExternalEngines({ cfg: cfgOne(), fetchImpl: f, now: () => 1000 });
  assert.deepEqual(probed, ["raven-flash-next"]);
  assert.deepEqual(f.calls.map((c) => c.url), [`${RAVEN}/models`]);
  assert.equal(f.calls[0].init.method, "GET");
});

test("2xx → ready (lastReadyAt stamped); non-2xx → not-ready with lastError; a throw → not-ready with its message", async () => {
  await pollExternalEngines({ cfg: cfgOne(), fetchImpl: recorder(ok200), now: () => 1000 });
  assert.equal(ext()["raven-flash-next"].ready, true);
  assert.equal(ext()["raven-flash-next"].lastReadyAt, 1000);
  assert.equal(ext()["raven-flash-next"].engineHost, "raven");
  assert.equal(ext()["raven-flash-next"].label, "halogen");

  await pollExternalEngines({ cfg: cfgOne(), fetchImpl: recorder({ ok: false, status: 503 }), now: () => 2000 });
  assert.equal(ext()["raven-flash-next"].ready, false);
  assert.equal(ext()["raven-flash-next"].lastError, "http 503");
  assert.equal(ext()["raven-flash-next"].lastReadyAt, 1000, "outage clock origin kept");

  await pollExternalEngines({ cfg: cfgOne(), fetchImpl: async () => { throw new Error("connect ECONNREFUSED 10.0.0.126:8030"); }, now: () => 3000 });
  assert.match(ext()["raven-flash-next"].lastError, /ECONNREFUSED/);
  assert.equal(ext()["raven-flash-next"].firstSeenAt, 1000);
});

test("no auth header is ever sent — not even when the row carries an api key", async () => {
  const f = recorder(ok200);
  await pollExternalEngines({ cfg: cfgOne({ apiKey: "sk-secret-lan" }), fetchImpl: f, now: () => 1 });
  const { init } = f.calls[0];
  assert.equal(init.headers, undefined, "no headers object at all");
  assert.doesNotMatch(JSON.stringify(init), /sk-secret-lan|Authorization/i);
});

test("the timeout is honoured even when fetch ignores the abort signal; the signal is aborted", async () => {
  let seen = null;
  const hang = (url, init) => { seen = init.signal; return new Promise(() => {}); };
  const t0 = Date.now();
  await pollExternalEngines({ cfg: cfgOne(), fetchImpl: hang, now: () => 1000, timeoutMs: 30 });
  assert.ok(Date.now() - t0 < 1000, "tick resolved at the timeout, not never");
  assert.equal(ext()["raven-flash-next"].ready, false);
  assert.match(ext()["raven-flash-next"].lastError, /timeout/);
  assert.equal(seen.aborted, true);
});

test("disabled and removed rows are pruned from the external map", async () => {
  const two = { _source: DB, providers: {
    "raven-flash-next": extRow(),
    "raven-halogen-smoke": extRow({ baseUrl: "http://10.0.0.126:8031/v1" }),
    "cloud-openai": { baseUrl: "https://api.openai.com/v1", host: "cloud" },
  } };
  await pollExternalEngines({ cfg: two, fetchImpl: recorder(ok200), now: () => 1 });
  assert.deepEqual(Object.keys(ext()).sort(), ["raven-flash-next", "raven-halogen-smoke"]);

  const f = recorder(ok200);
  await pollExternalEngines({ cfg: { _source: DB, providers: {
    "raven-flash-next": extRow({ disabled: true }),
    "cloud-openai": { baseUrl: "https://api.openai.com/v1", host: "cloud" },
  } }, fetchImpl: f, now: () => 2 });
  assert.deepEqual(ext(), {}, "disabled one and removed one both pruned");
  assert.equal(f.calls.length, 0, "a disabled row is not probed");
});

test("C1: a non-DB config (models.json fallback after invalidateProvidersCache, or empty) neither probes nor prunes", async () => {
  await pollExternalEngines({ cfg: cfgOne(), fetchImpl: recorder(ok200), now: () => 1000 });
  const f = recorder(ok200);
  // Non-empty, no markers, sourced from a models.json path — exactly what
  // loadProviders() returns while its cache is null or the DB read fails.
  const fallback = { _source: "/home/kh0pp/crow/models.json", providers: {
    "crow-voice": { baseUrl: "http://127.0.0.1:8011/v1", host: "local", bundleId: "vllm-qwen35-4b" },
  } };
  assert.deepEqual(await pollExternalEngines({ cfg: fallback, fetchImpl: f, now: () => 2000 }), []);
  await pollExternalEngines({ cfg: { _source: null, providers: {} }, fetchImpl: f, now: () => 2500 });
  // Even a marked row is not probed from a config the DB did not produce.
  await pollExternalEngines({ cfg: { providers: { "raven-flash-next": extRow() } }, fetchImpl: f, now: () => 3000 });
  assert.equal(f.calls.length, 0);
  assert.equal(ext()["raven-flash-next"].lastReadyAt, 1000, "clocks survive every non-DB tick");
  assert.equal(ext()["raven-flash-next"].checkedAt, 1000);
});

test("a repointed base_url starts fresh clocks on the next tick", async () => {
  await pollExternalEngines({ cfg: cfgOne(), fetchImpl: recorder(ok200), now: () => 1000 });
  await pollExternalEngines({ cfg: cfgOne({ baseUrl: "http://10.0.0.127:8030/v1" }), fetchImpl: recorder({ ok: false, status: 502 }), now: () => 5000 });
  const e = ext()["raven-flash-next"];
  assert.equal(e.baseUrl, "http://10.0.0.127:8030/v1");
  assert.equal(e.firstSeenAt, 5000);
  assert.equal(e.lastReadyAt, null);
});

test("a non-http(s) base_url is recorded not-ready and NEVER fetched; a trailing slash is normalised", async () => {
  assert.equal(externalModelsUrl("file:///etc/passwd"), null);
  assert.equal(externalModelsUrl("not a url"), null);
  assert.equal(externalModelsUrl("http://h:1/v1/"), "http://h:1/v1/models");
  const f = recorder(ok200);
  await pollExternalEngines({ cfg: cfgOne({ baseUrl: "file:///etc/passwd" }), fetchImpl: f, now: () => 1 });
  assert.equal(f.calls.length, 0);
  assert.equal(ext()["raven-flash-next"].lastError, "unsupported base_url");
});

test("pollExternalEngines never throws — a config whose providers getter throws is a no-op tick", async () => {
  const bad = { _source: "db:providers", get providers() { throw new Error("db unreadable"); } };
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(await pollExternalEngines({ cfg: bad, fetchImpl: recorder(ok200), now: () => 1 }), []);
  } finally { console.warn = origWarn; }
});

test("startExternalEngineMonitor: one immediate tick, idempotent, stops cleanly; interval <= 0 disables", async () => {
  let calls = 0;
  const poll = async () => { calls += 1; return []; };
  const origLog = console.log;
  console.log = () => {};
  try {
    assert.equal(startExternalEngineMonitor({ intervalMs: 60_000, poll }), true);
    assert.equal(startExternalEngineMonitor({ intervalMs: 60_000, poll }), false, "second start is a no-op");
    await new Promise((r) => setImmediate(r));
    assert.equal(calls, 1);
    _stopExternalEngineMonitor();
    assert.equal(startExternalEngineMonitor({ intervalMs: 0, poll }), false);
    await new Promise((r) => setImmediate(r));
    assert.equal(calls, 1, "a disabled monitor never polls");
  } finally {
    console.log = origLog;
    _stopExternalEngineMonitor();
  }
});

test("boot: initOrchestrator arms the poll right after the residency monitor, before anything that can throw", () => {
  const src = readFileSync(new URL("../servers/gateway/gpu-orchestrator.js", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("export async function initOrchestrator"));
  const r = body.indexOf("startResidencyMonitor();");
  const e = body.indexOf("startExternalEngineMonitor()");
  assert.ok(r > 0 && e > r, "startExternalEngineMonitor() follows startResidencyMonitor()");
  assert.ok(e < body.indexOf("createDbClient()"), "armed before the native reconcile's DB work");
});

test("the scratch suite disables the poll for suite gateways", () => {
  const src = readFileSync(new URL("../scripts/run-suite.mjs", import.meta.url), "utf8");
  assert.match(src, /env\.CROW_EXTERNAL_ENGINE_POLL_MS = "0";/);
});
