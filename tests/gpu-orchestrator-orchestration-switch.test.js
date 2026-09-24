// tests/gpu-orchestrator-orchestration-switch.test.js
//
// CROW_DISABLE_MODEL_ORCHESTRATION=1: no path may start, stop or evict a model
// (spec 2026-09-24 D2). Loopback baseUrls count as local everywhere (see
// gpu-orchestrator-host-gate), so these fixtures WOULD be orchestrated with the
// switch off — the "switch off" tests prove the gate is the switch.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as orch from "../servers/gateway/gpu-orchestrator.js";
import { OrchestrationDisabledError } from "../servers/shared/model-orchestration.js";

const cfg = {
  providers: {
    "crow-chat":  { bundleId: "llamacpp-vulkan-qwen36-35b-a3b", baseUrl: "http://127.0.0.1:8003/v1", host: "local", gpuPolicy: { alwaysResident: true } },
    "crow-embed": { bundleId: "llamacpp-vulkan-qwen3-embed",   baseUrl: "http://127.0.0.1:8005/v1", host: "local" },
  },
};
const mustNot = (what) => async () => { throw new Error(`must not ${what}`); };
const DISABLED_LINE = "[gpu-orchestrator] model orchestration DISABLED on this host (CROW_DISABLE_MODEL_ORCHESTRATION) — no model will be started, stopped or evicted";

let prevEnv, logs, origLog;
beforeEach(() => {
  prevEnv = process.env.CROW_DISABLE_MODEL_ORCHESTRATION;
  orch._setReservationReaderForTest(() => null);
  orch._setReservationNoticeSenderForTest(async () => {}); // never write notification rows
  orch._resetOrchestrationDisabledNoticeForTest();
  logs = []; origLog = console.log; console.log = (m) => logs.push(String(m));
});
afterEach(() => {
  console.log = origLog;
  if (prevEnv === undefined) delete process.env.CROW_DISABLE_MODEL_ORCHESTRATION;
  else process.env.CROW_DISABLE_MODEL_ORCHESTRATION = prevEnv;
  orch._setReservationReaderForTest(null);
  orch._setReservationNoticeSenderForTest(null);
});

test("switch on: acquireProvider throws OrchestrationDisabledError before any probe or start", async () => {
  process.env.CROW_DISABLE_MODEL_ORCHESTRATION = "1";
  await assert.rejects(
    () => orch.acquireProvider("crow-chat", { cfg, probeReadyFn: mustNot("probe"), bundleUpFn: mustNot("start"), bundleStopFn: mustNot("stop"), waitForReadyFn: mustNot("wait") }),
    (e) => e instanceof OrchestrationDisabledError && e.code === "model_orchestration_disabled" && e.provider === "crow-chat"
  );
});

// Regression pin (passes with or without the switch): the unknown-provider
// error keeps precedence over the switch.
test("switch on: acquireProvider still reports an unknown provider as unknown", async () => {
  process.env.CROW_DISABLE_MODEL_ORCHESTRATION = "1";
  await assert.rejects(() => orch.acquireProvider("nope", { cfg }), /unknown provider "nope"/);
});

test("switch on: maybeAcquireLocalProvider returns null without probing or starting", async () => {
  process.env.CROW_DISABLE_MODEL_ORCHESTRATION = "1";
  const r = await orch.maybeAcquireLocalProvider("crow-chat", { cfg, probeReadyFn: mustNot("probe"), bundleUpFn: mustNot("start"), bundleStopFn: mustNot("stop") });
  assert.equal(r, null);
});

test("switch on: resolveWarmableProviderName -> null; switch off -> the bundle row (proves the gate)", () => {
  const own = new Set(["127.0.0.1"]);
  process.env.CROW_DISABLE_MODEL_ORCHESTRATION = "1";
  assert.equal(orch.resolveWarmableProviderName(cfg, "crow-embed", own), null);
  delete process.env.CROW_DISABLE_MODEL_ORCHESTRATION;
  assert.equal(orch.resolveWarmableProviderName(cfg, "crow-embed", own), "crow-embed");
});

test("switch on: ensureResident returns false, touches no seam, and logs DISABLED (not a swallowed failure)", async () => {
  // ensureResident wraps everything in try/catch -> false, so a throwing seam
  // would be swallowed: count calls instead, and require the DISABLED line.
  process.env.CROW_DISABLE_MODEL_ORCHESTRATION = "1";
  let calls = 0; const errs = []; const origErr = console.error; console.error = (m) => errs.push(String(m));
  try {
    const count = async () => { calls++; return true; };
    const r = await orch.ensureResident("crow-chat", cfg, { probeReadyFn: count, bundleUpFn: count, waitForReadyFn: count });
    assert.equal(r, false);
  } finally { console.error = origErr; }
  assert.equal(calls, 0);
  assert.ok(logs.includes(DISABLED_LINE), logs.join("\n"));
  assert.equal(errs.filter((e) => /failed to bring up/.test(e)).length, 0);
});

test("switch on: retryDeferredResidents returns [] and never ensures", async () => {
  process.env.CROW_DISABLE_MODEL_ORCHESTRATION = "1";
  orch._setDeferredResidentsForTest(["crow-chat"]);
  try {
    const r = await orch.retryDeferredResidents({ cfg, ownAddrs: new Set(["127.0.0.1"]), ensure: mustNot("ensure") });
    assert.deepEqual(r, []);
  } finally { orch._setDeferredResidentsForTest([]); }
});

test("switch on: bootResidency ensures nothing, arms no timer, logs the DISABLED line exactly once", async () => {
  process.env.CROW_DISABLE_MODEL_ORCHESTRATION = "1";
  let armed = 0;
  const r = await orch.bootResidency({ cfg, ownAddrs: new Set(["127.0.0.1"]), ensure: mustNot("ensure"), armTimer: () => { armed++; } });
  assert.deepEqual(r, { disabled: true, ensured: [] });
  assert.equal(armed, 0);
  await orch.ensureResident("crow-chat", cfg, { bundleUpFn: mustNot("start") }); // second note must not re-log
  assert.equal(logs.filter((l) => l === DISABLED_LINE).length, 1, logs.join("\n"));
});

test("switch on: startIdleRevertTimer does not arm (returns without scheduling)", () => {
  process.env.CROW_DISABLE_MODEL_ORCHESTRATION = "1";
  const origSetInterval = globalThis.setInterval;
  let scheduled = 0;
  globalThis.setInterval = (...a) => { scheduled++; const h = origSetInterval(...a); clearInterval(h); return h; };
  try { orch.startIdleRevertTimer(); } finally { globalThis.setInterval = origSetInterval; }
  assert.equal(scheduled, 0);
});

test("lowest-level primitives are gated in source (defence in depth)", () => {
  const src = readFileSync(new URL("../servers/gateway/gpu-orchestrator.js", import.meta.url), "utf8");
  for (const fn of ["async function bundleUp(", "async function bundleStop(", "async function startNativeAndAwaitReady(", "async function checkIdleRevert(", "export function startIdleRevertTimer("]) {
    const at = src.indexOf(fn);
    assert.ok(at >= 0, `${fn} not found`);
    const body = src.slice(at, at + 400);
    assert.match(body, /isModelOrchestrationDisabled\(\)/, `${fn} must check the switch first`);
  }
});

test("switch off: the same fixtures orchestrate (acquire starts; bootResidency ensures + arms)", async () => {
  delete process.env.CROW_DISABLE_MODEL_ORCHESTRATION;
  let started = 0;
  const r = await orch.acquireProvider("crow-embed", { cfg, probeReadyFn: async () => false, bundleUpFn: async () => { started++; }, waitForReadyFn: async () => true, bundleStopFn: async () => {} });
  assert.equal(r, true);
  assert.equal(started, 1);
  const ensured = []; let armed = 0;
  const b = await orch.bootResidency({ cfg, ownAddrs: new Set(["127.0.0.1"]), ensure: async (n) => { ensured.push(n); return false; }, armTimer: () => { armed++; } });
  assert.equal(b.disabled, false);
  assert.deepEqual(ensured, ["crow-chat"]);
  assert.equal(armed, 1);
});

test("switch set to \"0\" does NOT disable orchestration", async () => {
  process.env.CROW_DISABLE_MODEL_ORCHESTRATION = "0";
  let started = 0;
  await orch.acquireProvider("crow-embed", { cfg, probeReadyFn: async () => false, bundleUpFn: async () => { started++; }, waitForReadyFn: async () => true, bundleStopFn: async () => {} });
  assert.equal(started, 1);
});

test("meta-glasses: an OrchestrationDisabledError is skipped quietly (no warn)", () => {
  const src = readFileSync(new URL("../bundles/meta-glasses/panel/routes.js", import.meta.url), "utf8");
  const at = src.indexOf("await acquireProvider(profile.provider_id)");
  assert.ok(at > 0, "meta-glasses acquire call not found");
  const catchBlock = src.slice(src.indexOf("} catch (err) {", at), src.indexOf("resolveProvider", at));
  assert.match(catchBlock, /err\?\.code !== "model_orchestration_disabled"/);
});
