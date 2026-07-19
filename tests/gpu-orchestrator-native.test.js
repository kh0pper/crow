/**
 * gpu-orchestrator native-runtime branch (Item G, Task 9).
 *
 * A provider is native iff `provider.gpuPolicy?.runtime === "native"`
 * (the ONLY writer of that field is `manager.js`'s `registerModel` — see
 * its doc for the exact row shape this file's fixtures mirror: `bundleId:
 * null`, `host: "local"`, `baseUrl: "http://127.0.0.1:<port>/v1"`,
 * `models: [{ id: <alias>, task, contextLen }]`).
 *
 * Every native-path test stubs `spawn`/`fetch`-adjacent seams
 * (`identityProbeFn`, `startModelFn`, `stopModelFn`, `acquireHostLockFn`,
 * `bundleStopFn`, `probeReadyFn`, `ensureRuntimeFn`, `loadStateFn`,
 * `resolveDataDirFn`, `loadCatalogFn`, `getCachedProbeFn`) via the
 * `opts` bag `acquireProvider`/`maybeAcquireLocalProvider`/`ensureResident`
 * now accept — no real llama-server, no real filesystem/network touched.
 * `opts.cfg` overrides the provider config the native branch resolves
 * targets/siblings from, following the same "cfg passed explicitly"
 * pattern `tests/gpu-orchestrator-host-gate.test.js` and
 * `tests/gpu-orchestrator-residency-poll.test.js` already use for the
 * PURE helpers in this module.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  pollResidency,
  acquireProvider,
  maybeAcquireLocalProvider,
  resolveWarmableProviderName,
  ensureResident,
  isNativeRuntimeProvider,
  initNativeModels,
  NativePortConflictError,
  NativeHostLockHeldError,
  _setNativeHandleForTest,
} from "../servers/gateway/gpu-orchestrator.js";
import { _resetProviderHealth, getProviderHealth } from "../servers/gateway/provider-health.js";
import { nativeReadinessTimeoutMs } from "../servers/gateway/models/runtime.js";

// --- fixtures ------------------------------------------------------------

const OWN = new Set(["localhost", "127.0.0.1", "::1"]);

/** A native provider row shaped exactly like `manager.js`'s `registerModel`
 * output: `bundleId: null`, `host: "local"`, loopback baseUrl,
 * `models[0].id` doubling as the llama-server `--alias`. */
function nativeProv(port, alias, extra = {}) {
  const { gpuPolicy, ...rest } = extra;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    host: "local",
    bundleId: null,
    models: [{ id: alias, task: "chat" }],
    gpuPolicy: { runtime: "native", ...gpuPolicy },
    ...rest,
  };
}

/** A Docker-backed provider row (the pre-existing, unmodified control
 * plane) — used to prove the native branch doesn't weaken the Docker
 * gates it sits beside. */
function dockerProv(baseUrl, bundleId, extra = {}) {
  return { baseUrl, bundleId, host: "local", models: [{ id: "docker-model", task: "chat" }], ...extra };
}

/** A stub `startModel()` handle — `{ live, stop(), status() }`. */
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

/** Injectable seams that get a fresh native provider all the way to
 * "started and ready" without touching a real binary/download/process. */
function startCapableOpts({ cfg, identityProbeFn, startCalls = [], startModelFn }) {
  return {
    cfg,
    identityProbeFn,
    acquireHostLockFn: () => () => {},
    startModelFn: startModelFn || ((params) => {
      startCalls.push(params);
      return fakeHandle();
    }),
    ensureRuntimeFn: async () => "/fake/runtimes/llamacpp/b1/llama-server",
    loadStateFn: () => ({ registry: { "native-target": { file: "model.gguf" } } }),
    resolveDataDirFn: () => "/fake/crow-home",
    loadCatalogFn: () => ({ runtime: { release: "b1", assets: {} } }),
    getCachedProbeFn: () => ({ platform: "linux", accel: "cpu" }),
    readinessTimeoutMs: 200,
    readinessPollMs: 5,
    readinessInitialDelayMs: 0,
  };
}

beforeEach(() => {
  _resetProviderHealth();
  _setNativeHandleForTest("native-target", null);
  _setNativeHandleForTest("native-sib", null);
});

// --- getNativeHandle (Item G, Task 12 follow-up: read-only accessor for the
// panel's stop/delete routes — see gpu-orchestrator.js's doc on it) --------

test("getNativeHandle: null when no handle was ever seeded for this provider name", async () => {
  const { getNativeHandle } = await import("../servers/gateway/gpu-orchestrator.js");
  assert.equal(getNativeHandle("native-target"), null);
  assert.equal(getNativeHandle("some-unknown-provider"), null);
});

test("getNativeHandle: returns the exact handle object seeded via the test seam, live reflects in place", async () => {
  const { getNativeHandle } = await import("../servers/gateway/gpu-orchestrator.js");
  const handle = fakeHandle({ live: true });
  _setNativeHandleForTest("native-target", handle);
  assert.equal(getNativeHandle("native-target"), handle);

  // Mutating the handle's own `live` flag (as `runtime.js`'s real
  // startModel/stop() do in place) is visible through the accessor without
  // re-seeding — it's a live reference into the module's map, not a copy.
  handle.live = false;
  assert.equal(getNativeHandle("native-target").live, false);
});

test("getNativeHandle: clearing via the test seam (null) makes it null again — the accessor has no separate mutation surface", async () => {
  const { getNativeHandle } = await import("../servers/gateway/gpu-orchestrator.js");
  _setNativeHandleForTest("native-target", fakeHandle({ live: true }));
  assert.notEqual(getNativeHandle("native-target"), null);
  _setNativeHandleForTest("native-target", null);
  assert.equal(getNativeHandle("native-target"), null);
});

// --- touch point 5: pollResidency compose-file gate (named blocker) -----

test("pollResidency never releases a native provider's residency for lacking a compose file", async () => {
  const cfg = {
    providers: {
      "native-embed": nativeProv(18107, "qwen3-embed", { gpuPolicy: { alwaysResident: true, runtime: "native" } }),
      "docker-embed": dockerProv("http://127.0.0.1:9100/v1", "safe-bundle", { gpuPolicy: { alwaysResident: true } }),
    },
  };
  const probe = async () => true;
  const composeExistsCalls = [];
  // ALWAYS false — this is exactly the condition that used to trip the
  // gate for anything with a bundleId. A native provider must never even
  // ask composeExists in the first place.
  const composeExists = (id) => {
    composeExistsCalls.push(id);
    return false;
  };

  const probed = await pollResidency({ cfg, ownAddrs: OWN, probe, now: () => 1000, composeExists });

  assert.deepEqual(probed.sort(), ["native-embed"], "only the native provider was probed this tick");
  assert.deepEqual(composeExistsCalls, ["safe-bundle"], "composeExists is never called for a native provider");
  const health = getProviderHealth().providers;
  assert.ok(health["native-embed"], "native provider's residency entry was NOT released for lacking a compose file");
  assert.equal(health["docker-embed"], undefined, "Docker provider still correctly released — the per-runtime gate didn't weaken the Docker path");
});

// --- touch point 1: acquireProvider re-warm / bind-failure (named blocker) --

test("after simulated restart, re-warm binds the exact port from base_url; bind failure surfaces an error, never a silent rebind", async () => {
  const cfg = { providers: { "native-target": nativeProv(18106, "qwen3-4b") } };
  // Simulated restart: _nativeHandles has NOTHING for "native-target" (the
  // in-memory map reset with the gateway process) — beforeEach already
  // ensures this. The real llama-server process either died or never came
  // back; identityProbe never reports "resident" for the whole window,
  // simulating a bind failure (e.g. EADDRINUSE causing an immediate exit).
  const startCalls = [];
  const startModelFn = (params) => {
    startCalls.push(params);
    return fakeHandle();
  };
  const identityProbeFn = async () => "down";

  await assert.rejects(
    () => acquireProvider("native-target", startCapableOpts({ cfg, identityProbeFn, startCalls, startModelFn })),
    /failed to bind port 18106|refusing to rebind/,
  );

  assert.equal(startCalls.length, 1, "started exactly once — no retry attempt on a different port");
  assert.equal(startCalls[0].port, 18106, "bound the EXACT port encoded in base_url, never re-allocated");
});

// --- touch point 1: identity-conflict / lock-held --------------------------

test("acquire native: identity conflict on the fast path throws before taking the lock or starting anything", async () => {
  const cfg = { providers: { "native-target": nativeProv(18105, "qwen3-4b") } };
  let lockCalls = 0;
  const startCalls = [];

  let caught = null;
  try {
    await acquireProvider("native-target", {
      ...startCapableOpts({ cfg, identityProbeFn: async () => "conflict", startCalls }),
      acquireHostLockFn: () => {
        lockCalls += 1;
        return () => {};
      },
    });
  } catch (err) {
    caught = err;
  }

  assert.ok(caught instanceof NativePortConflictError, `expected NativePortConflictError, got ${caught}`);
  assert.equal(lockCalls, 0, "the host lock is never taken on a conflict");
  assert.equal(startCalls.length, 0, "never started — no traffic routed to a conflicting port");
});

test("acquire native: host lock held elsewhere surfaces an honest error, no start attempted", async () => {
  const cfg = { providers: { "native-target": nativeProv(18104, "qwen3-4b") } };
  const startCalls = [];

  let caught = null;
  try {
    await acquireProvider("native-target", {
      ...startCapableOpts({ cfg, identityProbeFn: async () => "down", startCalls }),
      acquireHostLockFn: () => null, // held elsewhere
    });
  } catch (err) {
    caught = err;
  }

  assert.ok(caught instanceof NativeHostLockHeldError, `expected NativeHostLockHeldError, got ${caught}`);
  assert.match(caught.message, /another Crow instance on this host is using the GPU\/RAM/);
  assert.equal(startCalls.length, 0, "never started while the lock is held elsewhere");
});

// --- touch point 1: sibling swap inside the single-flight -----------------

test("acquire native: a Docker sibling in the same mutexGroup is stopped via bundleStop to admit it", async () => {
  const cfg = {
    providers: {
      "native-target": nativeProv(18101, "qwen3-4b", { gpuPolicy: { runtime: "native", mutexGroup: "local-llm" } }),
      "docker-sib": dockerProv("http://127.0.0.1:8003/v1", "vllm-rocm-qwen35-4b", { gpuPolicy: { mutexGroup: "local-llm" } }),
    },
  };

  let targetProbeCalls = 0;
  const identityProbeFn = async (baseUrl) => {
    if (baseUrl.includes(":18101")) {
      targetProbeCalls += 1;
      return targetProbeCalls === 1 ? "down" : "resident";
    }
    return "down";
  };
  const bundleStopCalls = [];
  const bundleStopFn = async (bundleId) => {
    bundleStopCalls.push(bundleId);
  };
  const probeReadyFn = async (baseUrl) => baseUrl.includes(":8003"); // Docker sibling is currently up

  const result = await acquireProvider(
    "native-target",
    { ...startCapableOpts({ cfg, identityProbeFn }), bundleStopFn, probeReadyFn },
  );

  assert.equal(result, true);
  assert.deepEqual(bundleStopCalls, ["vllm-rocm-qwen35-4b"], "the Docker sibling was stopped via bundleStop");
});

test("acquire native: a native sibling in the same mutexGroup is stopped via its handle's stop()", async () => {
  const cfg = {
    providers: {
      "native-target": nativeProv(18102, "qwen3-8b", { gpuPolicy: { runtime: "native", mutexGroup: "local-llm" } }),
      "native-sib": nativeProv(18103, "qwen3-4b", { gpuPolicy: { runtime: "native", mutexGroup: "local-llm" } }),
    },
  };
  const sibHandle = fakeHandle();
  _setNativeHandleForTest("native-sib", sibHandle);

  let targetProbeCalls = 0;
  const identityProbeFn = async (baseUrl) => {
    if (baseUrl.includes(":18102")) {
      targetProbeCalls += 1;
      return targetProbeCalls === 1 ? "down" : "resident";
    }
    return "down";
  };

  const result = await acquireProvider("native-target", startCapableOpts({ cfg, identityProbeFn }));

  assert.equal(result, true);
  assert.equal(sibHandle.stopCalls, 1, "the native sibling's handle.stop() was called exactly once");
  assert.equal(sibHandle.live, false);
});

// --- fix round 1, finding 1: lock held for the LIFE of residency ----------

test("acquire native: the host lock is held for the life of residency — release fires only on the handle's terminal transition, never right after a successful start", async () => {
  const cfg = { providers: { "native-target": nativeProv(18112, "qwen3-4b") } };
  let releaseCalls = 0;
  const release = () => {
    releaseCalls += 1;
  };
  let capturedOnTerminal = null;
  const startModelFn = (params) => {
    capturedOnTerminal = params.onTerminal;
    assert.equal(typeof capturedOnTerminal, "function", "startModel is given an onTerminal callback to wire up");
    return fakeHandle();
  };

  let probeCalls = 0;
  const identityProbeFn = async () => {
    probeCalls += 1;
    return probeCalls === 1 ? "down" : "resident"; // fast-path down, then resident once "started"
  };

  const result = await acquireProvider("native-target", {
    ...startCapableOpts({ cfg, identityProbeFn, startModelFn }),
    acquireHostLockFn: () => release,
  });

  assert.equal(result, true);
  assert.equal(releaseCalls, 0, "the lock must NOT be released immediately after a successful start");

  // Simulate the process later reaching a terminal state (runtime.js's
  // own onTerminal-firing correctness — idle-stop, restarts-exhausted,
  // explicit stop — is covered separately in tests/models-runtime.test.js;
  // this test only proves gpu-orchestrator wires release() to fire when
  // that callback IS invoked, and not before).
  capturedOnTerminal("stopped");
  assert.equal(releaseCalls, 1, "release fires when the handle reaches a terminal state");
});

// --- fix round 1, finding 3: Docker acquire evicts a native sibling -------

test("Docker acquire evicts a resident native sibling in the same mutexGroup (handle.stop spy)", async () => {
  const cfg = {
    providers: {
      "docker-target": dockerProv("http://127.0.0.1:8003/v1", "vllm-rocm-qwen35-4b", { gpuPolicy: { mutexGroup: "local-llm" } }),
      "native-sib": nativeProv(18120, "qwen3-4b", { gpuPolicy: { runtime: "native", mutexGroup: "local-llm" } }),
    },
  };
  const sibHandle = fakeHandle();
  _setNativeHandleForTest("native-sib", sibHandle);

  const bundleUpCalls = [];
  const result = await acquireProvider("docker-target", {
    cfg,
    probeReadyFn: async () => false, // never "already resident" via the fast path — force the full swap+start
    bundleUpFn: async (bundleId) => {
      bundleUpCalls.push(bundleId);
    },
    waitForReadyFn: async () => true, // stub past the real polling loop
  });

  assert.equal(result, true);
  assert.deepEqual(bundleUpCalls, ["vllm-rocm-qwen35-4b"]);
  assert.equal(sibHandle.stopCalls, 1, "the native sibling's handle.stop() was called to admit the Docker target");
  assert.equal(sibHandle.live, false);
});

// --- touch point 2: maybeAcquireLocalProvider ------------------------------

test("maybeAcquireLocalProvider does not early-out on a native provider's null bundleId", async () => {
  const cfg = { providers: { "native-target": nativeProv(18108, "qwen3-4b") } };
  // Fast path (already resident) — resolveNativeBinPath still runs before
  // the single-flight per the acquireProvider contract, so the full
  // start-capable opts bag is supplied even though nothing will actually
  // start.
  const result = await maybeAcquireLocalProvider(
    "native-target",
    startCapableOpts({ cfg, identityProbeFn: async () => "resident" }),
  );
  assert.equal(result, true, "must not return null just because the native provider has no bundleId");
});

// --- touch point 3: resolveWarmableProviderName ----------------------------

test("resolveWarmableProviderName treats a native provider (bundleId null, runtime native) as warmable", () => {
  const cfg = { providers: { "native-target": nativeProv(18109, "qwen3-4b") } };
  assert.equal(resolveWarmableProviderName(cfg, "native-target", OWN), "native-target");
});

// --- touch point 4: ensureResident -----------------------------------------

test("ensureResident native: process alive + identityProbe resident -> already resident, never restarts", async () => {
  const p = nativeProv(18110, "qwen3-embed", { gpuPolicy: { alwaysResident: true, runtime: "native" } });
  const cfg = { providers: { "native-target": p } };
  _setNativeHandleForTest("native-target", fakeHandle({ live: true }));

  const startCalls = [];
  const result = await ensureResident("native-target", cfg, {
    identityProbeFn: async () => "resident",
    startModelFn: (params) => {
      startCalls.push(params);
      return fakeHandle();
    },
  });

  assert.equal(result, false, "already resident -> no NEW embed warmup to report");
  assert.equal(startCalls.length, 0, "never restarted an already-resident process");
});

test("ensureResident native: no live handle -> starts it and reports embed capability", async () => {
  const p = nativeProv(18111, "qwen3-embed", { gpuPolicy: { alwaysResident: true, runtime: "native" } });
  p.models = [{ id: "qwen3-embed", task: "embed" }];
  const cfg = { providers: { "native-target": p } };
  // beforeEach already cleared any handle for "native-target".

  let probeCalls = 0;
  const identityProbeFn = async () => {
    probeCalls += 1;
    // First call is the fast-path check (nothing running yet -> "down");
    // subsequent calls are the post-start readiness wait, which reports
    // resident immediately once the (stubbed) process is "up".
    return probeCalls === 1 ? "down" : "resident";
  };

  const result = await ensureResident("native-target", cfg, {
    identityProbeFn,
    acquireHostLockFn: () => () => {},
    startModelFn: () => fakeHandle(),
    ensureRuntimeFn: async () => "/fake/runtimes/llamacpp/b1/llama-server",
    loadStateFn: () => ({ registry: { "native-target": { file: "model.gguf" } } }),
    resolveDataDirFn: () => "/fake/crow-home",
    loadCatalogFn: () => ({ runtime: { release: "b1", assets: {} } }),
    getCachedProbeFn: () => ({ platform: "linux", accel: "cpu" }),
    readinessTimeoutMs: 200,
    readinessPollMs: 5,
    readinessInitialDelayMs: 0,
  });

  assert.equal(result, true, "started fresh AND is embed-capable -> caller should trigger backfill");
  assert.ok(probeCalls >= 1);
});

// --- Item G, Task 10: size-scaled readiness timeout -------------------------

test("nativeReadinessTimeoutMs: boundaries — 0 MB floors at 120s, 2500 MB SSD is 140s, 17000 MB HDD is 800s", () => {
  assert.equal(nativeReadinessTimeoutMs(0), 120_000, "0 MB (or unknown size) never goes below the base floor");
  assert.equal(nativeReadinessTimeoutMs(2500, "ssd"), 140_000, "120_000 + 2500*8 = 140_000");
  assert.equal(nativeReadinessTimeoutMs(17000, "hdd"), 800_000, "120_000 + 17000*40 = 800_000");
});

test("nativeReadinessTimeoutMs: defaults to ssd's per-MB rate when storageClass is omitted", () => {
  assert.equal(nativeReadinessTimeoutMs(2500), nativeReadinessTimeoutMs(2500, "ssd"));
});

test("nativeReadinessTimeoutMs: a non-finite/negative size degrades to the bare floor, never throws or goes negative", () => {
  assert.equal(nativeReadinessTimeoutMs(undefined), 120_000);
  assert.equal(nativeReadinessTimeoutMs(null), 120_000);
  assert.equal(nativeReadinessTimeoutMs(NaN), 120_000);
  assert.equal(nativeReadinessTimeoutMs(-500), 120_000);
});

test("acquire native: with no readinessTimeoutMs override, the timeout is computed from the registry entry's sizeMb via nativeReadinessTimeoutMs — not the old flat default", async () => {
  const cfg = { providers: { "native-target": nativeProv(18113, "qwen3-4b") } };
  const calls = [];
  // Tiny stand-in formula so the test doesn't actually wait real minutes —
  // proves WHAT gets passed in (sizeMb, storageClass), not the real
  // production timeout value (that's covered by the boundary tests above).
  const nativeReadinessTimeoutMsFn = (sizeMb, storageClass) => {
    calls.push({ sizeMb, storageClass });
    return 200; // ms — plenty for the stubbed identity-probe below
  };
  let probeCalls = 0;
  const identityProbeFn = async () => {
    probeCalls += 1;
    // 1st call: acquireOrStartNative's fast-path check (nothing running
    // yet). 2nd+: the post-start readiness wait — "resident" immediately.
    return probeCalls === 1 ? "down" : "resident";
  };

  const result = await acquireProvider("native-target", {
    ...startCapableOpts({ cfg, identityProbeFn }),
    // Override the fixture's flat `readinessTimeoutMs: 200` from
    // startCapableOpts — this test is specifically about what happens when
    // NO override is supplied, so the formula path is exercised instead.
    readinessTimeoutMs: undefined,
    nativeReadinessTimeoutMsFn,
    loadStateFn: () => ({ registry: { "native-target": { file: "model.gguf", sizeMb: 4321 } } }),
  });

  assert.equal(result, true);
  assert.deepEqual(calls, [{ sizeMb: 4321, storageClass: "ssd" }], "the registry entry's sizeMb and the default ssd storageClass were threaded into the formula");
});

test("acquire native: an explicit readinessTimeoutMs override still wins outright (existing test fixtures keep working)", async () => {
  const cfg = { providers: { "native-target": nativeProv(18114, "qwen3-4b") } };
  let formulaCalls = 0;
  const nativeReadinessTimeoutMsFn = () => {
    formulaCalls += 1;
    return 999_999;
  };
  let probeCalls = 0;
  const identityProbeFn = async () => {
    probeCalls += 1;
    return probeCalls === 1 ? "down" : "resident";
  };

  const result = await acquireProvider("native-target", {
    ...startCapableOpts({ cfg, identityProbeFn }),
    nativeReadinessTimeoutMsFn,
    // startCapableOpts already sets readinessTimeoutMs: 200 — an explicit
    // override — so the formula must never even be called.
  });

  assert.equal(result, true);
  assert.equal(formulaCalls, 0, "an explicit readinessTimeoutMs override bypasses the formula entirely");
});

// --- Item G, Task 10: isNativeRuntimeProvider (chat.js copy-selection seam) -

test("isNativeRuntimeProvider: true for a native provider, false for a Docker provider, false for an unknown name", () => {
  const cfg = {
    providers: {
      "native-target": nativeProv(18115, "qwen3-4b"),
      "docker-target": dockerProv("http://127.0.0.1:8003/v1", "vllm-rocm-qwen35-4b"),
    },
  };
  assert.equal(isNativeRuntimeProvider("native-target", cfg), true);
  assert.equal(isNativeRuntimeProvider("docker-target", cfg), false);
  assert.equal(isNativeRuntimeProvider("does-not-exist", cfg), false);
});

// ---------------------------------------------------------------------------
// Final-review fix wave — Fix 1: probe cache never populated in production
// ---------------------------------------------------------------------------

test("Fix 1: acquire native with a null initial probe cache awaits reprobeFn exactly once; a second acquire makes zero additional calls", async () => {
  const cfg = { providers: { "native-target": nativeProv(18116, "qwen3-4b") } };
  const fakeProbe = { platform: "linux", accel: "cpu" };
  let cachedProbe = null; // mirrors probe.js's real cache: null until reprobe() warms it
  let reprobeCalls = 0;
  const getCachedProbeFn = () => cachedProbe;
  const reprobeFn = async () => {
    reprobeCalls += 1;
    cachedProbe = fakeProbe; // reprobe() also populates the cache it's read from — same as production
    return fakeProbe;
  };

  const ensureRuntimeCalls = [];
  let probeCalls = 0;
  const identityProbeFn = async () => {
    probeCalls += 1;
    // Per acquire: 1st call is the fast-path check (nothing running yet ->
    // "down"), 2nd+ is the post-start readiness wait -> "resident". `probeCalls`
    // is reset to 0 before the second acquire below so this pattern repeats.
    return probeCalls === 1 ? "down" : "resident";
  };

  const opts = {
    cfg,
    identityProbeFn,
    acquireHostLockFn: () => () => {},
    startModelFn: () => fakeHandle(),
    ensureRuntimeFn: async (dir, runtimeBlock, probe) => {
      ensureRuntimeCalls.push(probe);
      return "/fake/runtimes/llamacpp/b1/llama-server";
    },
    loadStateFn: () => ({ registry: { "native-target": { file: "model.gguf" } } }),
    resolveDataDirFn: () => "/fake/crow-home",
    loadCatalogFn: () => ({ runtime: { release: "b1", assets: {} } }),
    getCachedProbeFn,
    reprobeFn,
    readinessTimeoutMs: 200,
    readinessPollMs: 5,
    readinessInitialDelayMs: 0,
  };

  const first = await acquireProvider("native-target", opts);
  assert.equal(first, true);
  assert.equal(reprobeCalls, 1, "reprobeFn was awaited exactly once on the null-cache miss");
  assert.deepEqual(ensureRuntimeCalls[0], fakeProbe, "the reprobe()'d probe (not null) was threaded into ensureRuntimeFn");

  // Second acquire: a fresh down->resident cycle (same shape as the first —
  // resolveNativeBinPath runs unconditionally on every acquireProvider call,
  // per its own doc, regardless of which path the swap itself takes).
  probeCalls = 0;
  await acquireProvider("native-target", opts);
  assert.equal(reprobeCalls, 1, "second acquire: zero additional reprobeFn calls — the cache is warm");
});

// ---------------------------------------------------------------------------
// Final-review fix wave — Fix 2: handle.touch() had zero callers
// ---------------------------------------------------------------------------

test("Fix 2: the resident fast path touches the live native handle, resetting its idle timer", async () => {
  const cfg = { providers: { "native-target": nativeProv(18117, "qwen3-4b") } };
  let touchCalls = 0;
  const handle = fakeHandle({ touch: () => { touchCalls += 1; } });
  _setNativeHandleForTest("native-target", handle);

  // resolveNativeBinPath runs unconditionally on every acquireProvider call
  // (before the fast path is even checked — see its own doc), so this test
  // needs the full stub bag even though it never reaches a real start.
  const result = await acquireProvider(
    "native-target",
    startCapableOpts({ cfg, identityProbeFn: async () => "resident" }), // fast path — already resident
  );

  assert.equal(result, true);
  assert.equal(touchCalls, 1, "handle.touch() was called on the resident fast path");
});

test("Fix 2: the resident fast path does not call touch() when there is no live handle in-memory (simulated-restart re-warm case)", async () => {
  const cfg = { providers: { "native-target": nativeProv(18118, "qwen3-4b") } };
  // No _setNativeHandleForTest call — beforeEach already cleared it. This
  // is the "simulated restart" shape: identityProbe reports resident (the
  // real OS-level port is up) but this process holds no in-memory handle.
  const result = await acquireProvider(
    "native-target",
    startCapableOpts({ cfg, identityProbeFn: async () => "resident" }),
  );
  assert.equal(result, true, "still reports resident even with no live handle to touch — touch() is best-effort, not required for correctness");
});

test("Fix 2: touch() is not called on a dead (non-live) cached handle", async () => {
  const cfg = { providers: { "native-target": nativeProv(18119, "qwen3-4b") } };
  let touchCalls = 0;
  const handle = fakeHandle({ live: false, touch: () => { touchCalls += 1; } });
  _setNativeHandleForTest("native-target", handle);

  await acquireProvider("native-target", startCapableOpts({ cfg, identityProbeFn: async () => "resident" }));

  assert.equal(touchCalls, 0, "a non-live handle is never touched — matches the sibling-eviction gate's live check elsewhere in this file");
});

// ---------------------------------------------------------------------------
// Final-review fix wave — Fix 5: readiness-timeout orphans a loading process
// ---------------------------------------------------------------------------

test("Fix 5: a readiness timeout (\"down\") stops the orphaned handle and clears it from _nativeHandles before throwing; both release paths fire safely", async () => {
  const cfg = { providers: { "native-target": nativeProv(18121, "qwen3-4b") } };

  // A handle that mirrors runtime.js's real behavior more faithfully than
  // the bare `fakeHandle()` helper: its stop() actually fires the captured
  // onTerminal callback (exactly once), same as the real startModel's
  // handle does — needed so this test can observe BOTH release paths Fix
  // 5's doc describes (onTerminal's, and acquireOrStartNative's own
  // finally block) actually firing, not just one of them.
  let live = true;
  let stopCalls = 0;
  let capturedOnTerminal = null;
  const handle = {
    get live() { return live; },
    async stop() {
      stopCalls += 1;
      live = false;
      if (capturedOnTerminal) capturedOnTerminal("stopped");
    },
    status() { return { live }; },
  };
  const startModelFn = (params) => {
    capturedOnTerminal = params.onTerminal;
    return handle;
  };
  const identityProbeFn = async () => "down"; // never becomes resident — the timeout path

  // Idempotent, like native-lock.js's real release() closure (guarded by a
  // `released` flag) — a raw (non-guarded) counter alongside it proves BOTH
  // call sites actually invoke it, while the guarded flag proves that,
  // exactly as Fix 5's doc claims, this is safe: no crash, no double-free.
  let rawReleaseCalls = 0;
  let released = false;
  const release = () => {
    rawReleaseCalls += 1;
    if (released) return;
    released = true;
  };

  await assert.rejects(
    () => acquireProvider("native-target", {
      ...startCapableOpts({ cfg, identityProbeFn, startModelFn }),
      acquireHostLockFn: () => release,
    }),
    /failed to bind port 18121|refusing to rebind/,
  );

  assert.equal(stopCalls, 1, "the orphaned handle was stopped before the readiness-timeout error was thrown");
  assert.equal(live, false);
  assert.equal(rawReleaseCalls, 2, "release() was invoked from BOTH call sites — onTerminal (via handle.stop()) and acquireOrStartNative's finally block");
  assert.equal(released, true, "and it settled safely — no throw from the second (idempotent-no-op) call");
});

test("Fix 5: a post-start identity conflict also stops the orphaned handle and clears it from _nativeHandles before throwing", async () => {
  const cfg = { providers: { "native-target": nativeProv(18122, "qwen3-4b") } };
  const handle = fakeHandle();
  const startModelFn = () => handle;
  let probeCalls = 0;
  const identityProbeFn = async () => {
    probeCalls += 1;
    // 1st call: fast-path check (nothing running yet -> "down"). 2nd+:
    // post-start readiness wait — the process bound the port but is
    // serving something else.
    return probeCalls === 1 ? "down" : "conflict";
  };

  let caught = null;
  try {
    await acquireProvider("native-target", startCapableOpts({ cfg, identityProbeFn, startModelFn }));
  } catch (err) {
    caught = err;
  }

  assert.ok(caught instanceof NativePortConflictError, `expected NativePortConflictError, got ${caught}`);
  assert.equal(handle.stopCalls, 1, "the orphaned (conflicting) handle was stopped before the conflict error was thrown");
  assert.equal(handle.live, false);
});

// ---------------------------------------------------------------------------
// Final-review fix wave — Fix 3: reconcileOnBoot never invoked
// ---------------------------------------------------------------------------

test("Fix 3: initNativeModels invokes reconcileOnBootFn exactly once, shaping native provider rows to {modelId}", async () => {
  const state = { reservations: {}, journal: {}, registry: {} };
  let reconcileCalls = 0;
  let capturedListProviderRows = null;
  const reconcileOnBootFn = (args) => {
    reconcileCalls += 1;
    capturedListProviderRows = args.listProviderRows;
    assert.equal(args.state, state);
    assert.equal(typeof args.isProcessAlive, "function");
    return { freedReservations: [], orphanRows: [], resumableDownloads: [] };
  };

  const rows = [
    { id: "native-a", disabled: false, gpuPolicy: { runtime: "native" } },
    { id: "docker-b", disabled: false, gpuPolicy: null }, // not native — must be excluded
    { id: "native-disabled", disabled: true, gpuPolicy: { runtime: "native" } }, // disabled — excluded
  ];

  const plan = await initNativeModels({
    dir: "/fake/crow-home",
    db: {}, // truthy — enables the provider-row read branch
    loadStateFn: () => state,
    saveStateFn: () => {},
    listProvidersAllFn: async () => rows,
    reconcileOnBootFn,
  });

  assert.equal(reconcileCalls, 1, "reconcileOnBoot was invoked exactly once");
  assert.deepEqual(capturedListProviderRows(), [{ modelId: "native-a" }], "only the enabled native row was shaped in — Docker and disabled rows excluded");
  assert.deepEqual(plan, { freedReservations: [], orphanRows: [], resumableDownloads: [] });
});

test("Fix 3: a journaled (interrupted) download is re-enqueued via enqueueDownloadFn", async () => {
  const state = {
    reservations: {},
    journal: {
      "native-partial": { url: "https://huggingface.co/x/resolve/main/y.gguf", dest: "/fake/blobs/y.gguf", bytesDone: 1024, expectedSha: "deadbeef", startedAt: "2026-07-18T00:00:00.000Z" },
    },
    registry: {},
  };
  const enqueueCalls = [];
  const catalog = { models: [] };

  await initNativeModels({
    dir: "/fake/crow-home",
    db: null, // no DB — reservations/journal reconciliation still runs
    loadStateFn: () => state,
    saveStateFn: () => {},
    loadCatalogFn: () => catalog,
    enqueueDownloadFn: (params) => {
      enqueueCalls.push(params);
      return Promise.resolve({ path: "/fake/blobs/y.gguf", sha256: "deadbeef" });
    },
  });

  assert.equal(enqueueCalls.length, 1, "the one journaled download was re-enqueued");
  assert.equal(enqueueCalls[0].modelId, "native-partial");
  assert.equal(enqueueCalls[0].dir, "/fake/crow-home");
  assert.equal(enqueueCalls[0].catalog, catalog);
});

test("Fix 3: a reconcileOnBootFn throw does not propagate out of initNativeModels", async () => {
  await assert.doesNotReject(() => initNativeModels({
    dir: "/fake/crow-home",
    db: null,
    loadStateFn: () => ({ reservations: {}, journal: {}, registry: {} }),
    reconcileOnBootFn: () => {
      throw new Error("boom");
    },
  }));
});

test("Fix 3: a provider-row read failure (bad db) does not propagate — reconciliation degrades to reservations-only", async () => {
  const state = { reservations: {}, journal: {}, registry: {} };
  let reconcileCalls = 0;
  const plan = await initNativeModels({
    dir: "/fake/crow-home",
    db: {},
    loadStateFn: () => state,
    listProvidersAllFn: async () => {
      throw new Error("db read failed");
    },
    reconcileOnBootFn: (args) => {
      reconcileCalls += 1;
      assert.deepEqual(args.listProviderRows(), [], "provider rows degrade to empty on a read failure, never throw");
      return { freedReservations: [], orphanRows: [], resumableDownloads: [] };
    },
  });
  assert.equal(reconcileCalls, 1);
  assert.deepEqual(plan, { freedReservations: [], orphanRows: [], resumableDownloads: [] });
});

test("Fix 3: freed reservations are persisted via saveStateFn", async () => {
  const state = { reservations: { "model-dead": { port: 18100 } }, journal: {}, registry: {} };
  let saveCalls = 0;
  await initNativeModels({
    dir: "/fake/crow-home",
    db: null,
    loadStateFn: () => state,
    saveStateFn: (dir, s) => {
      saveCalls += 1;
      assert.equal(dir, "/fake/crow-home");
      assert.equal(s, state);
    },
    reconcileOnBootFn: () => ({
      freedReservations: [{ modelId: "model-dead", port: 18100 }],
      orphanRows: [],
      resumableDownloads: [],
    }),
  });
  assert.equal(saveCalls, 1, "saveState was called because a reservation was freed");
});
