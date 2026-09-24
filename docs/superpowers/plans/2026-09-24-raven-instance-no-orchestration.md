# Host-level "no model orchestration" switch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A gateway started with `CROW_DISABLE_MODEL_ORCHESTRATION=1` never starts, stops or evicts a model or a model container. Every path refuses, whether it is orchestrator acquire, residency, idle-revert, warm, or model-bundle install/start/stop (local or peer-forwarded). The read-only monitors keep running, and the Models panel says why. Raven's Crow instance needs this before it installs.

**Architecture:**
- A new pure module, `servers/shared/model-orchestration.js`, holds the env reader, the typed error and a model-bundle manifest predicate.
- `servers/gateway/gpu-orchestrator.js` checks the switch at every entry point AND at the lowest-level start/stop primitives.
- `servers/gateway/routes/bundles.js` gains one exported guard, `bundleOrchestrationRefusal(bundleId)`, called from `validateInstall` and from `dispatchBundleAction`'s local path.
- The Models route returns 409 `MODEL_ORCHESTRATION_DISABLED`; the panel shows a notice and translated error text.

**Tech Stack:** Node 24 ESM, Express, the `node:test` runner via `npm test -- tests/<file>.test.js [more files…]`. Never use raw `node --test`: it writes to the live DB.

**Spec:** `docs/superpowers/specs/2026-09-24-raven-instance-no-orchestration-design.md`. Read it in full; D2 and D4 were corrected after plan review round 1.

## Global Constraints

- **Env name:** exactly `CROW_DISABLE_MODEL_ORCHESTRATION`. It is on only for `"1"` or `"true"` (case-insensitive, after trim). Every other value, including unset and `"0"`, means orchestration is ON, which is unchanged behaviour.
- **Read on every call,** never cached at import.
- **Error:** class `OrchestrationDisabledError` with `code = "model_orchestration_disabled"`, `http = 409` and `provider` set to the provider name or `null`. Its message contains the literal `CROW_DISABLE_MODEL_ORCHESTRATION`.
- **Route and bundle error code:** `MODEL_ORCHESTRATION_DISABLED` (HTTP 409).
- **Model-bundle predicate** (decided after review round 2): `manifest.inference === true` OR a truthy `manifest.requires.gpu` OR a non-empty `manifest.requires.gpu_arch` array OR a non-empty `manifest.providers` array OR a truthy `manifest.sttProfileSeed` / `manifest.ttsProfileSeed`. Against the repo today it matches 13 bundles: the llamacpp/vllm family, `sdxl`, `vllm`, `ollama`, `localai`, `faster-whisper-server` and `kokoro-tts`. `companion` is NOT a model container (it calls the router) and is not matched.
- **Boot log line, verbatim:** `[gpu-orchestrator] model orchestration DISABLED on this host (CROW_DISABLE_MODEL_ORCHESTRATION) — no model will be started, stopped or evicted`
- **Read-only monitors stay armed** under the switch: `startResidencyMonitor()`, `startExternalEngineMonitor()`, `initNativeModels()`.
- **i18n:** every new key has `en` and `es` (gate: `tests/i18n-global-parity.test.js`).
- **Bundles:** any change under `bundles/<id>/` bumps that bundle's `manifest.json` `version` (CLAUDE.md rule).
- **Commits:** `git add <new files>`, then `git commit <paths> -m ...`. Never commit without a path.
- **Test hygiene:** tests restore `process.env.CROW_DISABLE_MODEL_ORCHESTRATION` in `finally`/`afterEach`, and they stub the reservation notice sender (it writes DB rows).

## Review Focus

1. **The env set to `"0"`, `""`, `" 1 "` or `"TRUE"`.** Only trimmed `1`/`true` (any case) disable orchestration. Pinned in Task 1.
2. **A peer forwards a bundle start of a model bundle to raven.** It lands on raven's local `dispatchBundleAction` path and must return 409. Pinned in Task 3: the guard is tested on real repo manifests, and a source-scan test proves the local path calls it.
3. **An already-running local model.** `maybeAcquireLocalProvider` returns `null` without even probing, and callers dial base_url. Pinned in Task 2.
4. **Idle-revert on a host with mutex groups.** `startIdleRevertTimer` never arms under the switch, and `checkIdleRevert` returns first. Pinned in Task 2.
5. **Spanish UI, Start pressed.** The client maps `MODEL_ORCHESTRATION_DISABLED` to translated copy, not the server's English. Pinned in Task 4.
6. **The switch off.** The same fixtures orchestrate exactly as today. Pinned in Tasks 2 and 3.

---

### Task 1: Switch reader, error, model-bundle predicate, suite env hygiene

**Files:**
- Create: `servers/shared/model-orchestration.js`
- Modify: `scripts/run-suite.mjs` (the forced-env block, ~lines 88-117)
- Test: `tests/model-orchestration-switch.test.js`

**Interfaces (produces):**
- `ORCHESTRATION_DISABLED_ENV = "CROW_DISABLE_MODEL_ORCHESTRATION"`
- `isModelOrchestrationDisabled(env = process.env): boolean`
- `class OrchestrationDisabledError extends Error`, constructed as `(providerName?)`
- `isModelBundleManifest(manifest): boolean`

- [ ] **Step 1: Write the failing test**

```js
// tests/model-orchestration-switch.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isModelOrchestrationDisabled, OrchestrationDisabledError, ORCHESTRATION_DISABLED_ENV, isModelBundleManifest,
} from "../servers/shared/model-orchestration.js";

test("env name is CROW_DISABLE_MODEL_ORCHESTRATION", () => {
  assert.equal(ORCHESTRATION_DISABLED_ENV, "CROW_DISABLE_MODEL_ORCHESTRATION");
});

test("truth table: only 1/true (trimmed, any case) disable orchestration", () => {
  const on = ["1", "true", "TRUE", " 1 ", "True"];
  const off = [undefined, "", "0", "false", "no", "yes", "2", " "];
  for (const v of on) assert.equal(isModelOrchestrationDisabled({ CROW_DISABLE_MODEL_ORCHESTRATION: v }), true, `value ${JSON.stringify(v)}`);
  for (const v of off) {
    const env = v === undefined ? {} : { CROW_DISABLE_MODEL_ORCHESTRATION: v };
    assert.equal(isModelOrchestrationDisabled(env), false, `value ${JSON.stringify(v)}`);
  }
});

test("reads process.env at call time (not cached at import)", () => {
  const prev = process.env.CROW_DISABLE_MODEL_ORCHESTRATION;
  try {
    delete process.env.CROW_DISABLE_MODEL_ORCHESTRATION;
    assert.equal(isModelOrchestrationDisabled(), false);
    process.env.CROW_DISABLE_MODEL_ORCHESTRATION = "1";
    assert.equal(isModelOrchestrationDisabled(), true);
  } finally {
    if (prev === undefined) delete process.env.CROW_DISABLE_MODEL_ORCHESTRATION;
    else process.env.CROW_DISABLE_MODEL_ORCHESTRATION = prev;
  }
});

test("OrchestrationDisabledError carries code/http/provider and names the env var", () => {
  const e = new OrchestrationDisabledError("crow-chat");
  assert.ok(e instanceof Error);
  assert.equal(e.name, "OrchestrationDisabledError");
  assert.equal(e.code, "model_orchestration_disabled");
  assert.equal(e.http, 409);
  assert.equal(e.provider, "crow-chat");
  assert.match(e.message, /CROW_DISABLE_MODEL_ORCHESTRATION/);
  assert.equal(new OrchestrationDisabledError().provider, null);
});

test("isModelBundleManifest: inference, requires.gpu, or non-empty providers", () => {
  assert.equal(isModelBundleManifest({ inference: true }), true);
  assert.equal(isModelBundleManifest({ requires: { gpu: true } }), true);
  assert.equal(isModelBundleManifest({ requires: { gpu: "amd" } }), true);
  assert.equal(isModelBundleManifest({ providers: [{ id: "x" }] }), true);
  assert.equal(isModelBundleManifest({ requires: { gpu_arch: ["cuda", "rocm", "cpu"] } }), true); // ollama/localai shape
  assert.equal(isModelBundleManifest({ requires: { gpu_arch: [] } }), false);
  assert.equal(isModelBundleManifest({ sttProfileSeed: { id: "whisper" } }), true); // faster-whisper-server
  assert.equal(isModelBundleManifest({ ttsProfileSeed: { id: "kokoro" } }), true);  // kokoro-tts
  assert.equal(isModelBundleManifest({ providers: [] }), false);
  assert.equal(isModelBundleManifest({ inference: false, requires: { gpu: false } }), false);
  assert.equal(isModelBundleManifest({}), false);
  assert.equal(isModelBundleManifest(null), false);
  assert.equal(isModelBundleManifest(undefined), false);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `export PATH=/home/kh0pp/.nvm/versions/node/v24.21.0/bin:$PATH && npm test -- tests/model-orchestration-switch.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```js
// servers/shared/model-orchestration.js
/**
 * Host-level "no model orchestration" switch
 * (spec docs/superpowers/specs/2026-09-24-raven-instance-no-orchestration-design.md).
 *
 * A host whose models are owned by something else (raven: halogen under
 * systemd and pi-lab's windows) sets CROW_DISABLE_MODEL_ORCHESTRATION=1, and
 * its gateway never starts, stops or evicts a model or a model bundle. Read
 * on every call so tests can toggle it. Pure, no I/O.
 */

export const ORCHESTRATION_DISABLED_ENV = "CROW_DISABLE_MODEL_ORCHESTRATION";

export function isModelOrchestrationDisabled(env = process.env) {
  const v = String(env?.[ORCHESTRATION_DISABLED_ENV] ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

export class OrchestrationDisabledError extends Error {
  constructor(providerName) {
    super(`${providerName || "model"} is not started here — model orchestration is disabled on this host (${ORCHESTRATION_DISABLED_ENV})`);
    this.name = "OrchestrationDisabledError";
    this.code = "model_orchestration_disabled";
    this.http = 409;
    this.provider = providerName || null;
  }
}

/** A bundle whose containers serve a model: declared inference, a GPU
 *  requirement or GPU-arch list, provider rows it registers, or a speech
 *  (STT/TTS) profile seed. */
export function isModelBundleManifest(manifest) {
  if (!manifest || typeof manifest !== "object") return false;
  if (manifest.inference === true) return true;
  const req = manifest.requires || {};
  if (req.gpu) return true;
  if (Array.isArray(req.gpu_arch) && req.gpu_arch.length > 0) return true;
  if (Array.isArray(manifest.providers) && manifest.providers.length > 0) return true;
  return Boolean(manifest.sttProfileSeed || manifest.ttsProfileSeed);
}
```

In `scripts/run-suite.mjs`, directly after `delete env.CROW_SUPERVISED;`, add:

```js
// Host-level model-orchestration switch (spec 2026-09-24): a shell that
// exports it must not flip every orchestrator suite; tests set it per-case.
delete env.CROW_DISABLE_MODEL_ORCHESTRATION;
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npm test -- tests/model-orchestration-switch.test.js`
Expected: PASS, 5 tests (the predicate test carries 14 assertions).

- [ ] **Step 5: Commit**

```bash
git add servers/shared/model-orchestration.js tests/model-orchestration-switch.test.js
git commit servers/shared/model-orchestration.js tests/model-orchestration-switch.test.js scripts/run-suite.mjs -m "feat(models): CROW_DISABLE_MODEL_ORCHESTRATION reader, error, model-bundle predicate"
```

---

### Task 2: Gate every orchestrator path (entry points + lowest-level primitives)

**Files:**
- Modify: `servers/gateway/gpu-orchestrator.js`
- Modify: `bundles/meta-glasses/panel/routes.js` (~line 279) and `bundles/meta-glasses/manifest.json` (version `0.1.0` → `0.1.1`)
- Test: `tests/gpu-orchestrator-orchestration-switch.test.js`

**Interfaces:**
- Consumes (Task 1): `isModelOrchestrationDisabled`, `OrchestrationDisabledError`.
- Produces:
  - `export async function bootResidency({ cfg, ownAddrs, ensure = ensureResident, armTimer = startIdleRevertTimer } = {}): Promise<{ disabled: boolean, ensured: string[] }>`
  - `export function _resetOrchestrationDisabledNoticeForTest()`
  - a re-export: `export { OrchestrationDisabledError } from "../shared/model-orchestration.js";`

- [ ] **Step 1: Write the failing tests**

```js
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
```

`isAlwaysResident` (gpu-orchestrator.js ~427) reads `v.gpuPolicy.alwaysResident` or `v.alwaysResident`; the fixture uses the first. `resolveWarmableProviderName(cfg, name, ownAddrs)` is exported (~634).

- [ ] **Step 2: Run them and confirm they fail**

Run: `npm test -- tests/gpu-orchestrator-orchestration-switch.test.js`
Expected: FAIL (`bootResidency` / `_resetOrchestrationDisabledNoticeForTest` not exported; the switch is ignored).

- [ ] **Step 3: Implement** in `servers/gateway/gpu-orchestrator.js`

1. **Imports** (next to the other `../shared/` imports near line 82-92):

```js
import { isModelOrchestrationDisabled, OrchestrationDisabledError } from "../shared/model-orchestration.js";
export { OrchestrationDisabledError } from "../shared/model-orchestration.js";
```

2. **Once-per-process note** (module scope, just above `noteServingRefused`):

```js
const DISABLED_LINE = "[gpu-orchestrator] model orchestration DISABLED on this host (CROW_DISABLE_MODEL_ORCHESTRATION) — no model will be started, stopped or evicted";
let _disabledNoticed = false;
/** Log the host-level switch once per process (spec 2026-09-24 D2). */
function noteOrchestrationDisabled() {
  if (_disabledNoticed) return;
  _disabledNoticed = true;
  console.log(DISABLED_LINE);
}
/** Test seam: re-arm the once-per-process DISABLED log line. */
export function _resetOrchestrationDisabledNoticeForTest() { _disabledNoticed = false; }
```

3. **Lowest-level primitives.** The FIRST statement of each of `bundleUp(bundleId)` (~279), `bundleStop(bundleId)` (~283) and `startNativeAndAwaitReady(providerName, p, opts)` (~885):

```js
  if (isModelOrchestrationDisabled()) throw new OrchestrationDisabledError(bundleId);      // bundleUp / bundleStop
  if (isModelOrchestrationDisabled()) throw new OrchestrationDisabledError(providerName);  // startNativeAndAwaitReady
```

   The FIRST statement of `checkIdleRevert()` and of `startIdleRevertTimer()`:

```js
  if (isModelOrchestrationDisabled()) return;
```

4. **`maybeAcquireLocalProvider`:** after `if (!providerName) return null;`:

```js
  // Host-level switch (spec 2026-09-24 D2): "not mine to manage", the same
  // null a cloud row gets; the caller dials base_url.
  if (isModelOrchestrationDisabled()) return null;
```

5. **`resolveWarmableProviderName`:** first statement: `if (isModelOrchestrationDisabled()) return null; // spec 2026-09-24: nothing is warmable here`

6. **`acquireProvider`:** directly after the `if (!p) throw …unknown provider…` line:

```js
  // Host-level switch (spec 2026-09-24 D2) — before any probe, lock, sibling stop or start.
  if (isModelOrchestrationDisabled()) throw new OrchestrationDisabledError(providerName);
```

7. **`ensureResident`:** first statement inside its `try`: `if (isModelOrchestrationDisabled()) { noteOrchestrationDisabled(); return false; }`

8. **`retryDeferredResidents`:** first statement: `if (isModelOrchestrationDisabled()) return [];`

9. **Extract `bootResidency`.** In `initOrchestrator`, replace the final `try { const cfg = loadProviders(); … } catch (err) { console.warn(`[gpu-orchestrator] initOrchestrator body failed: ${err.message}`); }` block with `await bootResidency();`. Add this function directly above `initOrchestrator`:

```js
/**
 * Boot residency (extracted from initOrchestrator for testability): ensure
 * owned alwaysResident providers, park the not-yet-local ones, arm the
 * idle-revert/deferred-retry timer. Under CROW_DISABLE_MODEL_ORCHESTRATION
 * none of that runs — the read-only monitors initOrchestrator armed first
 * stay armed. Never throws.
 */
export async function bootResidency({ cfg, ownAddrs, ensure = ensureResident, armTimer = startIdleRevertTimer } = {}) {
  if (isModelOrchestrationDisabled()) {
    noteOrchestrationDisabled();
    return { disabled: true, ensured: [] };
  }
  const ensured = [];
  try {
    cfg = cfg ?? loadProviders();
    ownAddrs = ownAddrs ?? getOwnAddresses();
    const residents = alwaysResidentProviders(cfg, ownAddrs); // logs the skip line
    _deferredResidents = new Set(
      Object.entries(cfg.providers || {})
        .filter(([, v]) => isAlwaysResident(v) && !orchestratableHere(v, {}, ownAddrs))
        .map(([n]) => n)
    );
    if (residents.length === 0 && _deferredResidents.size === 0) {
      console.log("[gpu-orchestrator] no alwaysResident providers declared");
      armTimer();
      return { disabled: false, ensured };
    }
    if (residents.length) {
      console.log(`[gpu-orchestrator] ensuring alwaysResident: ${residents.join(", ")}`);
    }
    let embedRecovered = false;
    for (const name of residents) {
      ensured.push(name);
      if (await ensure(name, cfg, { requester: "residency" })) embedRecovered = true;
    }
    armTimer();
    if (embedRecovered) {
      triggerEmbedBackfill(); // fire-and-forget — don't block gateway startup
    }
  } catch (err) {
    console.warn(`[gpu-orchestrator] initOrchestrator body failed: ${err.message}`);
  }
  return { disabled: false, ensured };
}
```

Keep `initOrchestrator`'s earlier statements (monitors, `initNativeModels` reconcile) exactly as they are. `tests/external-engine-poll.test.js` scans that ordering.

10. **meta-glasses** (`bundles/meta-glasses/panel/routes.js` ~279-282). Replace the catch body:

```js
      } catch (err) {
        // Host switch (CROW_DISABLE_MODEL_ORCHESTRATION): the provider is not
        // ours to start — dial it as-is, quietly.
        if (err?.code !== "model_orchestration_disabled") {
          console.warn(`[meta-glasses] gpu-orchestrator acquire(${profile.provider_id}) failed: ${err.message}`);
        }
      }
```

    Then bump `bundles/meta-glasses/manifest.json` `"version"` from `"0.1.0"` to `"0.1.1"`, and run `npm run build-registry`. `registry/add-ons.json` embeds each manifest, and `tests/bundle-contract.test.js` fails on drift. The regenerated `registry/add-ons.json` goes in this task's commit.

- [ ] **Step 4: Run it and confirm it passes, with the neighbouring suites**

Run: `npm test -- tests/gpu-orchestrator-orchestration-switch.test.js tests/gpu-orchestrator-reservation.test.js tests/gpu-orchestrator-host-gate.test.js tests/gpu-orchestrator-native.test.js tests/gpu-orchestrator-residency-poll.test.js tests/gpu-orchestrator-serving-class.test.js tests/lifecycle-external-engine.test.js tests/external-engine-poll.test.js tests/bundle-server-deps.test.js tests/bundle-contract.test.js`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/gpu-orchestrator-orchestration-switch.test.js
git commit servers/gateway/gpu-orchestrator.js bundles/meta-glasses/panel/routes.js bundles/meta-glasses/manifest.json registry/add-ons.json tests/gpu-orchestrator-orchestration-switch.test.js -m "feat(models): gate every orchestrator path on CROW_DISABLE_MODEL_ORCHESTRATION; extract bootResidency"
```

---

### Task 3: Gate model-bundle install/start/stop

**Files:**
- Modify: `servers/gateway/routes/bundles.js`: `validateInstall` (~1167), `dispatchBundleAction` local path (~2438-2496), and imports.
- Test: `tests/bundles-orchestration-switch.test.js`

**Interfaces:**
- Consumes (Task 1): `isModelOrchestrationDisabled`, `isModelBundleManifest`. From `servers/gateway/bundles-config.js`: `getInstalledFirstManifest(bundleId)` (installed copy first, then repo).
- Produces: `export function bundleOrchestrationRefusal(bundleId): null | { status: 409, code: "MODEL_ORCHESTRATION_DISABLED", error: string }`

- [ ] **Step 1: Write the failing test**

```js
// tests/bundles-orchestration-switch.test.js
//
// Spec 2026-09-24 D4 (corrected): under CROW_DISABLE_MODEL_ORCHESTRATION a
// model bundle can be neither installed nor started/stopped — locally or via
// a peer-forwarded /bundles/api/start. Uses real repo manifests:
// llamacpp-vulkan-qwen36-35b-a3b (inference + gpu), caddy (not a model bundle).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bundleOrchestrationRefusal, validateInstall } from "../servers/gateway/routes/bundles.js";
import { _setDockerProbeForTest } from "../servers/gateway/dashboard/panels/extensions/data-queries.js";

_setDockerProbeForTest(true); // same pin as bundles-validate-install.test.js

const prev = process.env.CROW_DISABLE_MODEL_ORCHESTRATION;
afterEach(() => {
  if (prev === undefined) delete process.env.CROW_DISABLE_MODEL_ORCHESTRATION;
  else process.env.CROW_DISABLE_MODEL_ORCHESTRATION = prev;
});

test("switch on: a model bundle is refused with 409 MODEL_ORCHESTRATION_DISABLED", () => {
  process.env.CROW_DISABLE_MODEL_ORCHESTRATION = "1";
  const r = bundleOrchestrationRefusal("llamacpp-vulkan-qwen36-35b-a3b");
  assert.equal(r?.status, 409);
  assert.equal(r?.code, "MODEL_ORCHESTRATION_DISABLED");
  assert.match(r.error, /CROW_DISABLE_MODEL_ORCHESTRATION/);
});

test("switch on: ollama (gpu_arch only) and faster-whisper-server (stt seed) are refused", () => {
  process.env.CROW_DISABLE_MODEL_ORCHESTRATION = "1";
  assert.equal(bundleOrchestrationRefusal("ollama")?.code, "MODEL_ORCHESTRATION_DISABLED");
  assert.equal(bundleOrchestrationRefusal("faster-whisper-server")?.code, "MODEL_ORCHESTRATION_DISABLED");
  assert.equal(bundleOrchestrationRefusal("companion"), null);
});

test("switch on: a non-model bundle passes; switch off: a model bundle passes", () => {
  process.env.CROW_DISABLE_MODEL_ORCHESTRATION = "1";
  assert.equal(bundleOrchestrationRefusal("caddy"), null);
  delete process.env.CROW_DISABLE_MODEL_ORCHESTRATION;
  assert.equal(bundleOrchestrationRefusal("llamacpp-vulkan-qwen36-35b-a3b"), null);
});

test("switch on: unknown bundle id -> null (other gates own not-found)", () => {
  process.env.CROW_DISABLE_MODEL_ORCHESTRATION = "1";
  assert.equal(bundleOrchestrationRefusal("definitely-not-a-real-bundle"), null);
});

test("switch on: validateInstall refuses a model bundle before any other gate", async () => {
  process.env.CROW_DISABLE_MODEL_ORCHESTRATION = "1";
  const r = await validateInstall("llamacpp-vulkan-qwen36-35b-a3b", { forceInstall: true });
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.equal(r.code, "MODEL_ORCHESTRATION_DISABLED");
});

test("dispatchBundleAction's LOCAL path calls the guard before runCompose (peer-forwarded starts land here)", () => {
  const src = readFileSync(new URL("../servers/gateway/routes/bundles.js", import.meta.url), "utf8");
  const at = src.indexOf("// Local path");
  assert.ok(at > 0, "local-path marker not found");
  const local = src.slice(at, src.indexOf("runCompose(", at));
  assert.match(local, /bundleOrchestrationRefusal\(bundleId\)/);
});

test("uninstall and shared-storage apply routes call the guard before any compose", () => {
  const src = readFileSync(new URL("../servers/gateway/routes/bundles.js", import.meta.url), "utf8");
  for (const route of ['router.post("/bundles/api/uninstall"', 'router.post("/bundles/api/shared-storage/apply/:id"']) {
    const at = src.indexOf(route);
    assert.ok(at > 0, `${route} not found`);
    const body = src.slice(at, src.indexOf("runCompose(", at));
    assert.match(body, /bundleOrchestrationRefusal\(/, `${route} must call the guard before runCompose`);
  }
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -- tests/bundles-orchestration-switch.test.js`
Expected: FAIL (`bundleOrchestrationRefusal` not exported).

- [ ] **Step 3: Implement** in `servers/gateway/routes/bundles.js`

1. **Imports:** add `import { isModelOrchestrationDisabled, isModelBundleManifest } from "../../shared/model-orchestration.js";`, and add `getInstalledFirstManifest` to the existing `from "../bundles-config.js"` import block (lines ~43-52). It is not imported today.

2. **The guard** (module scope, directly above `export async function validateInstall`):

```js
/**
 * Host-level switch (spec 2026-09-24 D4): under CROW_DISABLE_MODEL_ORCHESTRATION
 * a model bundle (inference / GPU / provider rows) is never installed, started
 * or stopped here — including a start a peer forwards to this instance.
 * Unknown ids return null: other gates own not-found.
 */
export function bundleOrchestrationRefusal(bundleId) {
  if (!isModelOrchestrationDisabled()) return null;
  if (!isModelBundleManifest(getInstalledFirstManifest(bundleId))) return null;
  return {
    status: 409,
    code: "MODEL_ORCHESTRATION_DISABLED",
    error: `Bundle '${bundleId}' serves a model, and model orchestration is disabled on this host (CROW_DISABLE_MODEL_ORCHESTRATION)`,
  };
}
```

3. **`validateInstall`:** directly after the `invalid_id` check and before the source-exists check:

```js
  const orchRefusal = bundleOrchestrationRefusal(bundleId);
  if (orchRefusal) return { ok: false, ...orchRefusal };
```

4. **`dispatchBundleAction` local path:** directly after the `// Local path` comment, before `const bundleDir`:

```js
    const orchRefusal = bundleOrchestrationRefusal(bundleId);
    if (orchRefusal) return res.status(orchRefusal.status).json({ error: orchRefusal.error, code: orchRefusal.code });
```

5. **Uninstall** (`router.post("/bundles/api/uninstall"`, ~2211) and **shared-storage apply** (`router.post("/bundles/api/shared-storage/apply/:id"`, ~2660). In each handler, right after the bundle id is validated and before anything else runs, add the refusal, using that handler's own id variable (read the handler; it is `bundle_id` from the body for uninstall, and the `:id` param for apply):

```js
    const orchRefusal = bundleOrchestrationRefusal(<that handler's bundle id variable>);
    if (orchRefusal) return res.status(orchRefusal.status).json({ error: orchRefusal.error, code: orchRefusal.code });
```

   The uninstall's `compose down` stops a model container. Raven has none installed today, but this closes the path.

- [ ] **Step 4: Run it and confirm it passes, with the neighbouring bundle suites**

Run: `npm test -- tests/bundles-orchestration-switch.test.js tests/bundles-validate-install.test.js tests/bundles-install-job.test.js tests/bundles-install-set.test.js tests/bundles-install-env.test.js tests/bundles-webui-lifecycle.test.js`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/bundles-orchestration-switch.test.js
git commit servers/gateway/routes/bundles.js tests/bundles-orchestration-switch.test.js -m "feat(bundles): refuse model-bundle install/start/stop/uninstall/apply under CROW_DISABLE_MODEL_ORCHESTRATION"
```

---

### Task 4: Models route and panel say why (translated)

**Files:**
- Modify: `servers/gateway/routes/models.js`: the start handler (~578) and the runtime handler (~660).
- Modify: `servers/gateway/dashboard/panels/model-catalog.js`: the `loadPanelData` return (~260), `renderRuntimeStrip` (~449), and the client `ERROR_MESSAGES` (~720).
- Modify: `servers/gateway/dashboard/shared/i18n.js`: two keys next to `models.runtimeNoBinary` (~685).
- Test: append to `tests/models-panel.test.js` and `tests/model-catalog-client-contract.test.js`.

**Interfaces:**
- Consumes (Task 1): `isModelOrchestrationDisabled`.
- Produces:
  - route 409 `{ error, code: "MODEL_ORCHESTRATION_DISABLED" }`;
  - runtime JSON gains `orchestrationDisabled`;
  - panel data gains `orchestrationDisabled`;
  - i18n keys `models.runtimeOrchestrationDisabled` and `models.errOrchestrationDisabled`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/models-panel.test.js`, reusing its existing helpers `freshLibsql`, `seedSession`, `withServer`, `makeCatalog`, `authHeaders` and `FIXED_PROBE`, exactly as the serving-class tests at ~1320 do:

```js
test("POST /api/models/:id/start under CROW_DISABLE_MODEL_ORCHESTRATION=1 -> 409 MODEL_ORCHESTRATION_DISABLED, acquire never called", async () => {
  const prev = process.env.CROW_DISABLE_MODEL_ORCHESTRATION;
  process.env.CROW_DISABLE_MODEL_ORCHESTRATION = "1";
  const h = freshLibsql();
  try {
    const token = await seedSession(h.db);
    const { registerModel } = await import("../servers/gateway/models/manager.js");
    await registerModel({ modelId: "panel-test-model", quant: "Q4_K_M", catalog: makeCatalog(), db: h.db, dir: h.dir });
    let called = 0;
    await withServer({
      dir: h.dir, loadCatalogFn: makeCatalog, getCachedProbeFn: () => FIXED_PROBE,
      maybeAcquireLocalProviderFn: async () => { called++; return true; },
    }, async (base) => {
      const r = await fetch(base + "/api/models/panel-test-model/start", { method: "POST", headers: authHeaders(token) });
      assert.equal(r.status, 409);
      const body = await r.json();
      assert.equal(body.code, "MODEL_ORCHESTRATION_DISABLED");
      assert.match(body.error, /CROW_DISABLE_MODEL_ORCHESTRATION/);
      assert.equal(called, 0);
    });
  } finally {
    if (prev === undefined) delete process.env.CROW_DISABLE_MODEL_ORCHESTRATION; else process.env.CROW_DISABLE_MODEL_ORCHESTRATION = prev;
    await h.cleanup();
  }
});

test("GET /api/models/runtime carries orchestrationDisabled (true under the switch, false without)", async () => {
  const prev = process.env.CROW_DISABLE_MODEL_ORCHESTRATION;
  const h = freshLibsql();
  try {
    const token = await seedSession(h.db);
    await withServer({ dir: h.dir, loadCatalogFn: makeCatalog, getCachedProbeFn: () => FIXED_PROBE }, async (base) => {
      delete process.env.CROW_DISABLE_MODEL_ORCHESTRATION;
      let body = await (await fetch(base + "/api/models/runtime", { headers: authHeaders(token) })).json();
      assert.equal(body.orchestrationDisabled, false);
      process.env.CROW_DISABLE_MODEL_ORCHESTRATION = "1";
      body = await (await fetch(base + "/api/models/runtime", { headers: authHeaders(token) })).json();
      assert.equal(body.orchestrationDisabled, true);
    });
  } finally {
    if (prev === undefined) delete process.env.CROW_DISABLE_MODEL_ORCHESTRATION; else process.env.CROW_DISABLE_MODEL_ORCHESTRATION = prev;
    await h.cleanup();
  }
});
```

Append to `tests/model-catalog-client-contract.test.js`. It uses that file's own `baseData()` (line ~44) and the already-imported `renderRuntimeStrip` and `modelCatalogClientJS`:

```js
test("renderRuntimeStrip shows the orchestration-disabled notice only when data.orchestrationDisabled (en + es)", () => {
  const on = renderRuntimeStrip({ ...baseData(), orchestrationDisabled: true }, "en");
  const off = renderRuntimeStrip({ ...baseData(), orchestrationDisabled: false }, "en");
  assert.match(on, /Model orchestration is disabled on this host/);
  assert.doesNotMatch(off, /Model orchestration is disabled on this host/);
  assert.match(renderRuntimeStrip({ ...baseData(), orchestrationDisabled: true }, "es"), /orquestación de modelos está desactivada/);
});

test("client ERROR_MESSAGES maps MODEL_ORCHESTRATION_DISABLED to translated copy", () => {
  assert.match(modelCatalogClientJS("en"), /MODEL_ORCHESTRATION_DISABLED:\s*'Model orchestration is disabled on this host/);
  assert.match(modelCatalogClientJS("es"), /MODEL_ORCHESTRATION_DISABLED:\s*'La orquestación de modelos está desactivada/);
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npm test -- tests/models-panel.test.js tests/model-catalog-client-contract.test.js`
Expected: the 4 new tests FAIL.

- [ ] **Step 3: Implement**

1. **`routes/models.js`:** add `import { isModelOrchestrationDisabled } from "../../shared/model-orchestration.js";`. In the start handler, directly after the `NOT_INSTALLED` 404 return:

```js
    // Host-level switch (spec 2026-09-24 D3): say why, instead of the
    // NOT_NATIVE a null acquire would otherwise surface.
    if (isModelOrchestrationDisabled()) {
      return res.status(409).json({
        error: "Model orchestration is disabled on this host (CROW_DISABLE_MODEL_ORCHESTRATION) — models here are started outside Crow",
        code: "MODEL_ORCHESTRATION_DISABLED",
      });
    }
```

   Runtime handler: `res.json({ probe: getCachedProbeFn(), models, activeDownloads, orchestrationDisabled: isModelOrchestrationDisabled() });`

2. **`model-catalog.js`:**
   - add `import { isModelOrchestrationDisabled } from "../../../shared/model-orchestration.js";`;
   - add `orchestrationDisabled: isModelOrchestrationDisabled(),` to `loadPanelData`'s return;
   - in `renderRuntimeStrip`, add `orchestrationDisabled` to the destructure. Directly after `const notices = [];`: `if (orchestrationDisabled) notices.push(t("models.runtimeOrchestrationDisabled", lang));`
   - in the client `ERROR_MESSAGES` object, after the `SERVING_CLASS_REFUSED` line, add:

```js
          MODEL_ORCHESTRATION_DISABLED: '${tJs("models.errOrchestrationDisabled", lang)}',
```

   (The client JS is a template literal: no backticks inside it.)

3. **`i18n.js`,** next to `models.runtimeNoBinary`:

```js
  "models.runtimeOrchestrationDisabled": { en: "Model orchestration is disabled on this host. Models here are started outside Crow.", es: "La orquestación de modelos está desactivada en este equipo. Los modelos se inician fuera de Crow." },
  "models.errOrchestrationDisabled": { en: "Model orchestration is disabled on this host, so Crow can't start models here.", es: "La orquestación de modelos está desactivada en este equipo, así que Crow no puede iniciar modelos aquí." },
```

- [ ] **Step 4: Run and confirm it passes**

Run: `npm test -- tests/models-panel.test.js tests/model-catalog-client-contract.test.js tests/i18n-global-parity.test.js`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git commit servers/gateway/routes/models.js servers/gateway/dashboard/panels/model-catalog.js servers/gateway/dashboard/shared/i18n.js tests/models-panel.test.js tests/model-catalog-client-contract.test.js -m "feat(models): Models panel/route explain CROW_DISABLE_MODEL_ORCHESTRATION (409 + translated notice)"
```

---

### Task 5: Docs, the raven port section, full suite

**Files:**
- Modify: `docs/developers/configuration.md`: a row in the table that holds `CROW_DISABLE_NOSTR` (~47).
- Modify: `docs/architecture/models.md`: a new section before `## External engines`.
- Modify: `docs/developers/port-allocation.md`: append a `## Second host: raven` section at the end.

- [ ] **Step 1: configuration.md row** (insert right after the `CROW_DISABLE_NOSTR` row)

```markdown
| `CROW_DISABLE_MODEL_ORCHESTRATION` | *(unset)* | `1` (or `true`) makes this gateway **never start, stop or evict a model or a model bundle**: on-demand acquires return "not managed here" (callers dial the provider's base_url), boot residency, warm and idle-revert are skipped, model-bundle install/start/stop (including peer-forwarded starts) answer 409 `MODEL_ORCHESTRATION_DISABLED`, and the Models panel's Start answers the same. Read-only health polls stay on. For hosts whose models are owned by something else (raven: halogen under systemd). Any other value, including `0`, leaves orchestration on. |
```

- [ ] **Step 2: models.md section** (insert directly before `## External engines`)

```markdown
## Host switch: no model orchestration

`CROW_DISABLE_MODEL_ORCHESTRATION=1` (`servers/shared/model-orchestration.js`) is a property of the **host**, not of a provider row. Per-row gates (locality, owner, foreign-instance veto, bundle/runtime presence, the external-engine marker) decide *which* rows a host may orchestrate. This switch says the host orchestrates *none*, however rows arrive through sync. That matters on a box like raven, where any synced row whose base_url is the box's own LAN address counts as local.

Under the switch:

- **Entry points:**
  - `maybeAcquireLocalProvider` and `resolveWarmableProviderName` return `null`;
  - `acquireProvider` throws `OrchestrationDisabledError` (`model_orchestration_disabled`) before any probe or start;
  - `ensureResident`, `retryDeferredResidents` and `checkIdleRevert` are no-ops;
  - `bootResidency` logs one DISABLED line and arms no idle-revert timer.
- **Lowest-level primitives** (`bundleUp`, `bundleStop`, `startNativeAndAwaitReady`) throw as well, so a future caller cannot bypass the gate.
- **Model bundles** (`inference: true`, `requires.gpu`, or `providers[]`) cannot be installed, started or stopped through `/bundles/api/*`. This includes starts a peer forwards (`bundleOrchestrationRefusal` in `routes/bundles.js`).

The residency poll and the external-engine poll still run, since both are read-only. Model downloads are not gated. Spec: `docs/superpowers/specs/2026-09-24-raven-instance-no-orchestration-design.md`.
```

- [ ] **Step 3: port-allocation.md raven section** (append at the end of the file)

```markdown
## Second host: raven

Raven (10.0.0.126, `raven.dachshund-chromatic.ts.net`) is the second Strix Halo box. Its ports live in their own namespace. The first column is `raven:<port>`, not a bare number, because `scripts/check-port-allocation.js` reads bare numbers in the first cell as **crow** allocations; rows starting `raven:` are skipped. A raven port is verified only by checking raven (`ss -ltn`). Making the checker host-aware is follow-up work.

| port | bind | what | status |
|---|---|---|---|
| raven:3009 | 127.0.0.1 | Crow gateway (user unit `crow-gateway.service`, `CROW_DISABLE_MODEL_ORCHESTRATION=1`); reached only through Tailscale Serve `raven:8444` | planned |
| raven:8444 | tailnet (Serve) | Tailscale Serve HTTPS → `127.0.0.1:3009` (fleet `:8444` convention; never Funnel) | planned |
| raven:8030 | 0.0.0.0 (ufw: crow + grackle only) | halogen Flash-Next production (`flash-next.service`), an external engine Crow never manages | live |
| raven:8031–8033 | 0.0.0.0 | two-box masters (window mode, pi-lab) | reserved |
| raven:13305 | 127.0.0.1 | Lemonade server (`lemond`, installed but disabled since the 2026-09-24 NPU spike) | disabled |
| raven:9000 | 127.0.0.1 | Lemonade websocket | disabled |
```

- [ ] **Step 4: Full verification**, in order:
1. `node scripts/check-port-allocation.js`: expected exit 0.
2. `npm run build-registry -- --check`: expected exit 0. The meta-glasses version bump may require regenerating `registry/add-ons.json`; if `--check` fails for that reason, run `npm run build-registry` and include the regenerated file in this task's commit.
3. `npm test`, the FULL suite in the scratch env: expected 0 failures. Record the pass/fail counts for the PR body.

- [ ] **Step 5: Commit**

```bash
git commit docs/developers/configuration.md docs/architecture/models.md docs/developers/port-allocation.md -m "docs: CROW_DISABLE_MODEL_ORCHESTRATION + raven port namespace"
```

(Add `registry/add-ons.json` to the path list if Step 4.2 regenerated it.)

---

## Operational runbook (NOT part of the PR; the controller runs it after merge)

**A. Deploy.**
1. Confirm check-runs are green on the main sha.
2. In a free `~/CROW-SCHEDULE.md` slot: `git -C ~/crow pull --ff-only origin main && sudo systemctl restart crow-gateway crow-r4-gateway`.
3. `/health` returns 200 on :3001 and :3008.
4. Neither log contains the DISABLED line.

**B. Raven install** (spec D5). In a registered slot outside 22:00–06:00, with MemAvailable ≥ 6 GiB checked first.
1. nvm and Node v24.21.0 (user).
2. `git clone https://github.com/kh0pper/crow.git ~/crow`, then `CROW_DATA_DIR=$HOME/.crow/data npm run setup`.
3. User unit with the spec D5 env plus `CROW_DISABLE_PERCH=1`, `Restart=always` and `MemoryMax=1G`. Then `sudo loginctl enable-linger kh0pp` and `systemctl --user enable --now crow-gateway`.
4. `sudo tailscale serve --bg --https=8444 http://127.0.0.1:3009`.
5. **Verify:**
   - the DISABLED line is in the journal;
   - Serve `/health` returns 200 from crow;
   - `ss -ltn` shows only `127.0.0.1:3009`;
   - halogen returns 200.
6. Add the CROW-SCHEDULE standing-automations row.

**C. Pairing** (spec D6). **Kevin said GO on 2026-09-24:** identity export/import, crow's enroll window (two crow restarts, each registered), `instance-pair.js`, then verify sync both ways.

## Review

- **Round 1 (2026-09-24, staff-engineer subagent): REVISE.**
  - **Critical, fixed:**
    - (1) model-bundle install/start/stop through `/bundles/api/*` (incl. peer-forwarded) was ungated, and spec D4 falsely claimed model bundles were retired. Task 3 was added and D4 corrected.
    - (2) the `warmProviderByName` test was vacuous (it ignores `opts.cfg` and reads real providers). `resolveWarmableProviderName` is now gated and tested with an injected cfg.
  - **Suggestions adopted:**
    - lowest-level gates (`bundleUp`/`bundleStop`/`startNativeAndAwaitReady`/`startIdleRevertTimer`);
    - the meta-glasses quiet skip, with a version bump;
    - `bootResidency` defaults moved inside the `try`;
    - the reset seam in `beforeEach` code;
    - a translated client error mapping;
    - the named parity gate and `baseData()`;
    - `run-suite.mjs` deletes the env;
    - `CROW_DISABLE_PERCH=1` on raven.
  - **Not adopted:** the chat.js `provider_warming` pre-event is cosmetic. It fires only for native rows, and raven registers none.
- **Round 2 (2026-09-24): REVISE.**
  - **Critical, fixed:**
    - (1) the predicate missed `ollama`/`localai` (`requires.gpu_arch` only). It now covers `gpu_arch`, plus the STT/TTS seeds (faster-whisper-server, kokoro-tts), with a real-manifest test. companion is confirmed not a model container.
    - (2) the `ensureResident` test was vacuous (the function swallows throws). It now counts seam calls and requires the DISABLED line.
    - (3) the meta-glasses bump breaks registry drift. Task 2 now regenerates `registry/add-ons.json` and runs `bundle-contract.test.js`.
  - **Suggestions adopted:**
    - uninstall and shared-storage apply are gated;
    - the import hedge is removed;
    - the meta-glasses test checks the catch block itself;
    - the regression-pin label is added;
    - spec §4 is trimmed to match (the native-row and monitors-armed cases are covered by the lowest-level gate and the unchanged `initOrchestrator` prefix).
- **Round 3 (2026-09-24, scoped): APPROVE.**
  - The predicate matches exactly 13 bundles, with no false positives or misses across 87 manifests.
  - The `ensureResident` test is non-vacuous, and the slices and id variables (`bundle_id` for uninstall, `bundleId` for apply) are correct.
  - `build-registry` changes only one line.
  - Minor notes:
    - Before Task 1, run `npm ci` in the worktree (the controller did this).
    - The uninstall guard goes before the 404 check, so on a switch-on host a not-installed model bundle answers 409, and an installed one can't be uninstalled from the UI. Both are intended.
