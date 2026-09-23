/**
 * serving.class orchestrator enforcement (Task 3, spec
 * docs/superpowers/specs/2026-09-23-serving-class-design.md §3.3).
 *
 * The gateway's single native-model spawn funnel (`acquireOrStartNative`)
 * must refuse a cold `windowed`/`wedge-risk` model unless the caller's
 * `opts.servingOverride` names the exact class. The check sits AFTER the
 * resident fast path (a running model is never refused) and BEFORE the
 * `startBlockedBy` reservation gate (a permanent refusal must win over a
 * transient box_reserved).
 *
 * Fixtures (`nativeProv`, `fakeHandle`, `startCapableOpts`) are copied
 * verbatim from `tests/gpu-orchestrator-native.test.js` — see that file's
 * header for why each seam exists (no real llama-server, filesystem, or
 * network is ever touched).
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  acquireProvider, maybeAcquireLocalProvider, ensureResident, _setNativeHandleForTest,
  _setReservationReaderForTest, _resetReservationNoticesForTest,
} from "../servers/gateway/gpu-orchestrator.js";
import { ServingClassError } from "../servers/gateway/models/serving-class.js";
import { _resetProviderHealth } from "../servers/gateway/provider-health.js";

// --- fixtures (copied verbatim from tests/gpu-orchestrator-native.test.js) ---

function nativeProv(port, alias, extra = {}) {
  const { gpuPolicy, ...rest } = extra;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    host: "local",
    bundleId: null,
    models: [{ id: alias, task: "chat" }],
    gpuPolicy: { runtime: "native", catalogId: alias, quant: "Q4", port, ...gpuPolicy },
    ...rest,
  };
}

function fakeHandle(overrides = {}) {
  const h = {
    live: true,
    stopCalls: 0,
    async stop() {
      h.stopCalls += 1;
      h.live = false;
    },
    status() {
      return { live: h.live };
    },
    ...overrides,
  };
  return h;
}

function startCapableOpts({ cfg, identityProbeFn, startCalls = [], startModelFn }) {
  const registryEntry = { file: "model.gguf", catalogId: "native-target", quant: "Q4" };
  return {
    cfg,
    identityProbeFn,
    acquireHostLockFn: () => () => {},
    startModelFn: startModelFn || ((params) => {
      startCalls.push(params);
      return fakeHandle();
    }),
    ensureRuntimeFn: async () => "/fake/runtimes/llamacpp/b1/llama-server",
    loadStateFn: () => ({ registry: { "native-target@Q4": registryEntry } }),
    resolveDataDirFn: () => "/fake/crow-home",
    loadCatalogFn: () => ({ runtime: { release: "b1", assets: {} } }),
    getCachedProbeFn: () => ({ platform: "linux", accel: "cpu" }),
    existsSyncFn: () => true,
    getRuntimeOverrideFn: () => null,
    ownInstanceIdFn: () => "this-instance",
    readinessTimeoutMs: 200,
    readinessPollMs: 5,
    readinessInitialDelayMs: 0,
  };
}

const catalogWith = (cls) => () => ({
  runtime: { release: "b1", assets: {} },
  models: [{ id: "native-target", serving: { class: cls } }],
});

function setup(cls, { fastStatus = "down", servingOverride } = {}) {
  const p = nativeProv(18200, "native-target");
  const cfg = { providers: { "native-target": p } };
  const startCalls = [];
  let n = 0;
  const identityProbeFn = async () => (++n === 1 ? fastStatus : "resident");
  const opts = { ...startCapableOpts({ cfg, identityProbeFn, startCalls }), loadCatalogFn: catalogWith(cls), servingOverride };
  return { cfg, opts, startCalls };
}

// Pin the reservation reader: a live box reservation on the host must not leak into these tests.
beforeEach(() => {
  _resetProviderHealth();
  _setNativeHandleForTest("native-target", null);
  _setNativeHandleForTest("native-sib", null);
  _setReservationReaderForTest(() => null);
  _resetReservationNoticesForTest();
});

test("cold wedge-risk: acquireProvider throws ServingClassError and never spawns", async () => {
  const { opts, startCalls } = setup("wedge-risk");
  await assert.rejects(acquireProvider("native-target", opts), (e) => e instanceof ServingClassError && e.servingClass === "wedge-risk");
  assert.equal(startCalls.length, 0);
});

test("cold windowed: refused too", async () => {
  const { opts, startCalls } = setup("windowed");
  await assert.rejects(acquireProvider("native-target", opts), ServingClassError);
  assert.equal(startCalls.length, 0);
});

test("already resident: never refused, even wedge-risk (fast path first)", async () => {
  const { opts, startCalls } = setup("wedge-risk", { fastStatus: "resident" });
  await acquireProvider("native-target", opts);
  assert.equal(startCalls.length, 0);
});

test("override equal to the class starts it; a cross-class override does not", async () => {
  const ok = setup("wedge-risk", { servingOverride: "wedge-risk" });
  await acquireProvider("native-target", ok.opts);
  assert.equal(ok.startCalls.length, 1);
  _setNativeHandleForTest("native-target", null);
  const cross = setup("wedge-risk", { servingOverride: "windowed" });
  await assert.rejects(acquireProvider("native-target", cross.opts), ServingClassError);
  assert.equal(cross.startCalls.length, 0);
});

test("resident and uncurated start as before", async () => {
  const r = setup("resident");
  await acquireProvider("native-target", r.opts);
  assert.equal(r.startCalls.length, 1);
  _setNativeHandleForTest("native-target", null);
  const u = setup("resident");
  u.opts.loadCatalogFn = () => ({ runtime: { release: "b1", assets: {} }, models: [] });
  await acquireProvider("native-target", u.opts);
  assert.equal(u.startCalls.length, 1);
});

test("maybeAcquireLocalProvider rethrows the refusal (a decision, not a failure) and never calls onError", async () => {
  const { opts } = setup("wedge-risk");
  let onErrorCalls = 0;
  await assert.rejects(maybeAcquireLocalProvider("native-target", { ...opts, onError: () => { onErrorCalls++; } }), ServingClassError);
  assert.equal(onErrorCalls, 0);
});

test("ensureResident: alwaysResident wedge-risk returns false via the serving notice (not the generic failure catch), once", async () => {
  _resetReservationNoticesForTest();
  const { cfg, opts, startCalls } = setup("wedge-risk");
  cfg.providers["native-target"].gpuPolicy.alwaysResident = true;
  const logs = [], errs = [];
  const origLog = console.log, origErr = console.error;
  console.log = (...a) => logs.push(a.join(" "));
  console.error = (...a) => errs.push(a.join(" "));
  try {
    assert.equal(await ensureResident("native-target", cfg, opts), false);
    assert.equal(await ensureResident("native-target", cfg, setup("wedge-risk").opts), false);
  } finally { console.log = origLog; console.error = origErr; }
  assert.equal(startCalls.length, 0);
  // ensureResident's OUTER catch also returns false — so pin that the
  // native catch handled it: no generic failure line, one skip notice.
  assert.equal(errs.filter((l) => /failed to bring up|native-target/.test(l)).length, 0, errs.join("\n"));
  assert.equal(logs.filter((l) => /residency skipped native-target: serving\.class wedge-risk/.test(l)).length, 1, logs.join("\n"));
});

test("reserved box + cold wedge-risk: the permanent refusal wins over box_reserved", async () => {
  _setReservationReaderForTest(() => ({ owner: "someone", expires_at: "2099-01-01T00:00:00Z", allow: [], key: "k" }));
  try {
    const { opts, startCalls } = setup("wedge-risk");
    await assert.rejects(acquireProvider("native-target", opts), ServingClassError);
    assert.equal(startCalls.length, 0);
  } finally { _setReservationReaderForTest(() => null); }
});

test("cold wedge-risk with a resident LIVE sibling in the same mutexGroup: refused BEFORE sibling eviction", async () => {
  const p = nativeProv(18200, "native-target", { gpuPolicy: { mutexGroup: "local-llm" } });
  const sib = nativeProv(18201, "native-sib", { gpuPolicy: { mutexGroup: "local-llm" } });
  const cfg = { providers: { "native-target": p, "native-sib": sib } };
  const sibHandle = fakeHandle();
  _setNativeHandleForTest("native-sib", sibHandle);

  const startCalls = [];
  let stopModelFnCalls = 0;
  const identityProbeFn = async () => "down";
  const opts = {
    ...startCapableOpts({ cfg, identityProbeFn, startCalls }),
    loadCatalogFn: catalogWith("wedge-risk"),
    stopModelFn: async (h) => { stopModelFnCalls += 1; return h.stop(); },
  };

  await assert.rejects(acquireProvider("native-target", opts), (e) => e instanceof ServingClassError && e.servingClass === "wedge-risk");
  assert.equal(startCalls.length, 0);
  assert.equal(stopModelFnCalls, 0, "the injected stopModelFn was never called");
  assert.equal(sibHandle.stopCalls, 0, "the sibling handle's stop() was never called");
  assert.equal(sibHandle.live, true, "the sibling is still resident/live");
});

// --- item 3 (MINOR, D6): an unreadable catalog is uncurated, so the start
// proceeds. `loadCatalogFn` is shared across the whole native-start path —
// `acquireProvider` calls it FIRST via `resolveNativeBinPath` (unguarded:
// resolveNativeBinPath does not try/catch it, so a throw there aborts the
// start before the serving.class gate is ever reached — not what this test
// is pinning), and again later inside `startNativeAndAwaitReady`'s
// catalogEntry lookup (already try/catch-guarded there). So this stub lets
// call #1 (resolveNativeBinPath) succeed, throws on call #2 — the
// serving.class D6 catch this test targets — and succeeds again after, so
// the unrelated steps around it are unaffected.
test("D6: an unreadable catalog at the serving.class check is treated as uncurated — the start still proceeds", async () => {
  const p = nativeProv(18202, "native-target");
  const cfg = { providers: { "native-target": p } };
  const startCalls = [];
  let probeCalls = 0;
  const identityProbeFn = async () => (++probeCalls === 1 ? "down" : "resident");
  let loadCatalogCalls = 0;
  const loadCatalogFn = () => {
    loadCatalogCalls += 1;
    if (loadCatalogCalls === 2) throw new Error("bad json");
    return { runtime: { release: "b1", assets: {} } };
  };
  const opts = { ...startCapableOpts({ cfg, identityProbeFn, startCalls }), loadCatalogFn };

  await acquireProvider("native-target", opts);
  assert.equal(startCalls.length, 1);
  assert.ok(loadCatalogCalls > 2, "loadCatalogFn was called again by unrelated start steps (startNativeAndAwaitReady's catalogEntry lookup)");
});
