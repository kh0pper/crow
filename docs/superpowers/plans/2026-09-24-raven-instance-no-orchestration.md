# Host-level "no model orchestration" switch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A gateway started with `CROW_DISABLE_MODEL_ORCHESTRATION=1` never starts, stops or evicts a model. Every start path refuses, the read-only monitors keep running, and the Models panel says why. Raven's Crow instance needs this before it installs.

**Architecture:**
- A pure env reader and a typed error live in a new `servers/shared/model-orchestration.js`.
- `servers/gateway/gpu-orchestrator.js` checks the switch at each start chokepoint:
  - `maybeAcquireLocalProvider` returns `null`;
  - `acquireProvider` throws;
  - `ensureResident` returns `false`;
  - `retryDeferredResidents` returns `[]`;
  - `checkIdleRevert` returns;
  - the boot residency body is extracted into an exported `bootResidency()` that skips the ensure loop and the idle-revert timer.
- The Models route returns 409 `MODEL_ORCHESTRATION_DISABLED`, and the panel's runtime strip shows a notice.

**Tech Stack:** Node 24 ESM, Express routes, the `node:test` runner (via `npm test -- tests/<file>.test.js` only; never raw `node --test`).

**Spec:** `docs/superpowers/specs/2026-09-24-raven-instance-no-orchestration-design.md`

## Global Constraints

- **Env name:** exactly `CROW_DISABLE_MODEL_ORCHESTRATION`. It is on only for `"1"` or `"true"` (case-insensitive, after trim). Every other value, including unset, means orchestration is ON, which is unchanged behaviour.
- **Read on every call,** never cached at import, so tests can toggle `process.env`.
- **Error:** class `OrchestrationDisabledError` with `code = "model_orchestration_disabled"`, `http = 409` and `provider` set to the provider name or `null`.
- **Route error code:** `MODEL_ORCHESTRATION_DISABLED` (HTTP 409).
- **Boot log line, verbatim:** `[gpu-orchestrator] model orchestration DISABLED on this host (CROW_DISABLE_MODEL_ORCHESTRATION) — no model will be started, stopped or evicted`
- **Read-only monitors stay armed** under the switch: `startResidencyMonitor()`, `startExternalEngineMonitor()`, and `initNativeModels()` (downloads-only reconcile).
- **i18n:** every new key has both `en` and `es` (the global parity gate).
- **Tests** stub every notice sender that writes a DB row, the way the reservation tests do.
- **Commits:** `git add <new file>` for new files, then `git commit <paths> -m ...`. Never commit without a path.

## Review Focus

1. **The switch set to `"0"`, `"false"`, `""`, `" 1 "` or `"TRUE"`.** Only `" 1 "` (after trim) and `"TRUE"` enable it. `"0"` must NOT disable orchestration, because an operator writing `=0` expects "not disabled". Pinned in Task 1's truth-table test.
2. **An already-running local model.** Under the switch, `maybeAcquireLocalProvider` returns `null`, never `true`. The caller dials base_url, which still works, and the router is unaffected. Pinned in Task 2: `probeReadyFn` must not even be called.
3. **The idle-revert path when an operator flips the env on a host with mutex groups.** The timer is never armed, and `checkIdleRevert` returns before probing if it is ever called. Pinned in Task 2 through `bootResidency`'s `armTimer` seam.
4. **Starting from the Models panel under the switch.** The user sees 409 `MODEL_ORCHESTRATION_DISABLED` with a message naming the env var, not `NOT_NATIVE`. Pinned in Task 3.
5. **The switch off, on the same fixtures.** Orchestration proceeds exactly as today, which proves the gate is the switch and not the fixture. Pinned in Tasks 2 and 3.

---

### Task 1: The switch reader and its error

**Files:**
- Create: `servers/shared/model-orchestration.js`
- Test: `tests/model-orchestration-switch.test.js`

**Interfaces:**
- Produces:
  - `isModelOrchestrationDisabled(env = process.env): boolean`
  - `class OrchestrationDisabledError extends Error`, constructed as `(providerName?: string)`, with fields `name`, `code`, `http` and `provider`
  - `ORCHESTRATION_DISABLED_ENV = "CROW_DISABLE_MODEL_ORCHESTRATION"`

- [ ] **Step 1: Write the failing test**

```js
// tests/model-orchestration-switch.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isModelOrchestrationDisabled, OrchestrationDisabledError, ORCHESTRATION_DISABLED_ENV,
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
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `export PATH=/home/kh0pp/.nvm/versions/node/v24.21.0/bin:$PATH && npm test -- tests/model-orchestration-switch.test.js`
Expected: FAIL (cannot find module `servers/shared/model-orchestration.js`).

- [ ] **Step 3: Implement**

```js
// servers/shared/model-orchestration.js
/**
 * Host-level "no model orchestration" switch
 * (spec docs/superpowers/specs/2026-09-24-raven-instance-no-orchestration-design.md).
 *
 * A host whose models are owned by something else (raven: halogen under
 * systemd and pi-lab's windows) sets CROW_DISABLE_MODEL_ORCHESTRATION=1, and
 * its gateway never starts, stops or evicts a model. Read on every call so
 * tests can toggle it. Pure, no I/O.
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
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npm test -- tests/model-orchestration-switch.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add servers/shared/model-orchestration.js tests/model-orchestration-switch.test.js
git commit servers/shared/model-orchestration.js tests/model-orchestration-switch.test.js -m "feat(models): CROW_DISABLE_MODEL_ORCHESTRATION reader + OrchestrationDisabledError"
```

---

### Task 2: Gate every start path in the orchestrator

**Files:**
- Modify: `servers/gateway/gpu-orchestrator.js`:
  - imports (near line 82);
  - `maybeAcquireLocalProvider` (~587);
  - `acquireProvider` (~1244);
  - `checkIdleRevert` (~1361);
  - `ensureResident` (~1486);
  - `retryDeferredResidents` (~1522);
  - `initOrchestrator` (~1807): extract the body into `bootResidency`.
- Test: `tests/gpu-orchestrator-orchestration-switch.test.js`

**Interfaces:**
- Consumes: `isModelOrchestrationDisabled`, `OrchestrationDisabledError` (Task 1).
- Produces:
  - `export async function bootResidency({ cfg = loadProviders(), ownAddrs = getOwnAddresses(), ensure = ensureResident, armTimer = startIdleRevertTimer } = {}): Promise<{ disabled: boolean, ensured: string[] }>`
  - `initOrchestrator` calls `await bootResidency()` in place of its former post-reconcile body.
  - A re-export for route callers: `export { OrchestrationDisabledError } from "../shared/model-orchestration.js";`

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
import * as orch from "../servers/gateway/gpu-orchestrator.js";
import { OrchestrationDisabledError } from "../servers/shared/model-orchestration.js";

const cfg = {
  providers: {
    "crow-chat":  { bundleId: "llamacpp-vulkan-qwen36-35b-a3b", baseUrl: "http://127.0.0.1:8003/v1", host: "local", gpuPolicy: { alwaysResident: true } },
    "crow-embed": { bundleId: "llamacpp-vulkan-qwen3-embed",   baseUrl: "http://127.0.0.1:8005/v1", host: "local" },
  },
};
const mustNot = (what) => async () => { throw new Error(`must not ${what}`); };

let prevEnv, logs, origLog;
beforeEach(() => {
  prevEnv = process.env.CROW_DISABLE_MODEL_ORCHESTRATION;
  orch._setReservationReaderForTest(() => null);
  orch._setReservationNoticeSenderForTest(async () => {}); // never write notification rows
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

test("switch on: acquireProvider still reports an unknown provider as unknown", async () => {
  process.env.CROW_DISABLE_MODEL_ORCHESTRATION = "1";
  await assert.rejects(() => orch.acquireProvider("nope", { cfg }), /unknown provider "nope"/);
});

test("switch on: maybeAcquireLocalProvider returns null without probing or starting", async () => {
  process.env.CROW_DISABLE_MODEL_ORCHESTRATION = "1";
  const r = await orch.maybeAcquireLocalProvider("crow-chat", { cfg, probeReadyFn: mustNot("probe"), bundleUpFn: mustNot("start"), bundleStopFn: mustNot("stop") });
  assert.equal(r, null);
});

test("switch on: warmProviderByName is a no-op (null)", async () => {
  process.env.CROW_DISABLE_MODEL_ORCHESTRATION = "1";
  assert.equal(await orch.warmProviderByName("crow-chat", { cfg, probeReadyFn: mustNot("probe"), bundleUpFn: mustNot("start") }), null);
});

test("switch on: ensureResident returns false and never starts", async () => {
  process.env.CROW_DISABLE_MODEL_ORCHESTRATION = "1";
  const r = await orch.ensureResident("crow-chat", cfg, { probeReadyFn: mustNot("probe"), bundleUpFn: mustNot("start"), waitForReadyFn: mustNot("wait") });
  assert.equal(r, false);
});

test("switch on: retryDeferredResidents returns [] and never ensures", async () => {
  process.env.CROW_DISABLE_MODEL_ORCHESTRATION = "1";
  orch._setDeferredResidentsForTest(["crow-chat"]);
  try {
    const r = await orch.retryDeferredResidents({ cfg, ownAddrs: new Set(["127.0.0.1"]), ensure: mustNot("ensure") });
    assert.deepEqual(r, []);
  } finally { orch._setDeferredResidentsForTest([]); }
});

test("switch on: bootResidency ensures nothing, arms no timer, logs the DISABLED line once", async () => {
  process.env.CROW_DISABLE_MODEL_ORCHESTRATION = "1";
  let armed = 0;
  const r = await orch.bootResidency({ cfg, ownAddrs: new Set(["127.0.0.1"]), ensure: mustNot("ensure"), armTimer: () => { armed++; } });
  assert.deepEqual(r, { disabled: true, ensured: [] });
  assert.equal(armed, 0);
  assert.equal(logs.filter((l) => l === "[gpu-orchestrator] model orchestration DISABLED on this host (CROW_DISABLE_MODEL_ORCHESTRATION) — no model will be started, stopped or evicted").length, 1, logs.join("\n"));
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
```

(`isAlwaysResident` reads `v.gpuPolicy.alwaysResident` or `v.alwaysResident`, at gpu-orchestrator.js ~427. The fixture uses the first.)

- [ ] **Step 2: Run them and confirm they fail**

Run: `npm test -- tests/gpu-orchestrator-orchestration-switch.test.js`
Expected: FAIL. `bootResidency` is not exported, and the switch-on tests fail because the orchestrator ignores the env.

- [ ] **Step 3: Implement the gates**

1. **Imports** (next to the other `../shared/` imports):

```js
import { isModelOrchestrationDisabled, OrchestrationDisabledError } from "../shared/model-orchestration.js";
export { OrchestrationDisabledError } from "../shared/model-orchestration.js";
```

2. **One-shot log helper** (module scope, near `noteServingRefused`):

```js
const DISABLED_LINE = "[gpu-orchestrator] model orchestration DISABLED on this host (CROW_DISABLE_MODEL_ORCHESTRATION) — no model will be started, stopped or evicted";
let _disabledNoticed = false;
/** Log the host-level switch once per process (spec 2026-09-24 D2). */
function noteOrchestrationDisabled() {
  if (_disabledNoticed) return;
  _disabledNoticed = true;
  console.log(DISABLED_LINE);
}
```

The bootResidency test asserts exactly one DISABLED line in `logs`, while earlier tests in the same file may already have tripped the once-flag. So export a reset seam, `export function _resetOrchestrationDisabledNoticeForTest() { _disabledNoticed = false; }`, and call it in the test file's `beforeEach` (add `orch._resetOrchestrationDisabledNoticeForTest();` there).

3. **`maybeAcquireLocalProvider`:** first statement after `if (!providerName) return null;`:

```js
  // Host-level switch (spec 2026-09-24 D2): "not mine to manage", the same
  // null a cloud row gets; the caller dials base_url.
  if (isModelOrchestrationDisabled()) return null;
```

4. **`acquireProvider`:** directly after the `if (!p) throw …unknown provider…` line:

```js
  // Host-level switch (spec 2026-09-24 D2) — defence in depth: before any
  // probe, lock, sibling stop or start.
  if (isModelOrchestrationDisabled()) throw new OrchestrationDisabledError(providerName);
```

5. **`checkIdleRevert`:** first statement: `if (isModelOrchestrationDisabled()) return;`

6. **`ensureResident`:** first statement inside the `try`:

```js
    if (isModelOrchestrationDisabled()) { noteOrchestrationDisabled(); return false; }
```

7. **`retryDeferredResidents`:** first statement: `if (isModelOrchestrationDisabled()) return [];`

8. **Extract `bootResidency` from `initOrchestrator`.** Replace the final `try { const cfg = loadProviders(); … } catch (err) { console.warn(... initOrchestrator body failed ...) }` block of `initOrchestrator` with `await bootResidency();`, and add:

```js
/**
 * Boot residency (extracted from initOrchestrator for testability): ensure
 * owned alwaysResident providers, park the not-yet-local ones, arm the
 * idle-revert/deferred-retry timer. Under CROW_DISABLE_MODEL_ORCHESTRATION
 * none of that runs — the read-only monitors initOrchestrator armed first
 * stay armed. Never throws.
 */
export async function bootResidency({
  cfg = loadProviders(),
  ownAddrs = getOwnAddresses(),
  ensure = ensureResident,
  armTimer = startIdleRevertTimer,
} = {}) {
  if (isModelOrchestrationDisabled()) {
    noteOrchestrationDisabled();
    return { disabled: true, ensured: [] };
  }
  const ensured = [];
  try {
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

In the `cfg` / `ownAddrs` defaults above, `loadProviders()` and `getOwnAddresses()` throwing would escape `bootResidency` before the `try`. `loadProviders` already catches internally (read it to confirm). If `getOwnAddresses` can throw, move both calls inside the `try` using `cfg ??= loadProviders()` and destructure without defaults.

- [ ] **Step 4: Run and confirm it passes, plus the neighbouring orchestrator suites**

Run: `npm test -- tests/gpu-orchestrator-orchestration-switch.test.js tests/gpu-orchestrator-reservation.test.js tests/gpu-orchestrator-host-gate.test.js tests/gpu-orchestrator-native.test.js tests/gpu-orchestrator-residency-poll.test.js tests/gpu-orchestrator-serving-class.test.js tests/lifecycle-external-engine.test.js`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/gpu-orchestrator-orchestration-switch.test.js
git commit servers/gateway/gpu-orchestrator.js tests/gpu-orchestrator-orchestration-switch.test.js -m "feat(models): gate every orchestrator start path on CROW_DISABLE_MODEL_ORCHESTRATION; extract bootResidency"
```

---

### Task 3: Models route and panel say why

**Files:**
- Modify: `servers/gateway/routes/models.js`: the `POST /api/models/:id/start` handler (~578) and `GET /api/models/runtime` (~660).
- Modify: `servers/gateway/dashboard/panels/model-catalog.js`: `loadPanelData` return (~260) and `renderRuntimeStrip` notices (~457-471).
- Modify: `servers/gateway/dashboard/shared/i18n.js`: add `models.runtimeOrchestrationDisabled` next to `models.runtimeNoBinary` (~685).
- Test: append to `tests/models-panel.test.js` and `tests/model-catalog-client-contract.test.js`.

**Interfaces:**
- Consumes: `isModelOrchestrationDisabled` (Task 1).
- Produces:
  - route JSON `{ error, code: "MODEL_ORCHESTRATION_DISABLED" }` with status 409;
  - runtime JSON gains `orchestrationDisabled: boolean`;
  - panel data gains `orchestrationDisabled: boolean`;
  - `renderRuntimeStrip` renders `t("models.runtimeOrchestrationDisabled")` as a notice when it is true.

- [ ] **Step 1: Write the failing tests** (append to `tests/models-panel.test.js`, reusing its `freshLibsql`, `seedSession`, `withServer`, `makeCatalog`, `authHeaders` and `FIXED_PROBE` helpers exactly as the serving-class tests at ~1320 do)

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

Also append to `tests/model-catalog-client-contract.test.js`. Build `data` the same way that file's existing `renderRuntimeStrip(data, "en")` call does at ~65, copying its fixture:

```js
test("renderRuntimeStrip shows the orchestration-disabled notice only when data.orchestrationDisabled", () => {
  const base = /* the file's existing runtime-strip data fixture */;
  const on = renderRuntimeStrip({ ...base, orchestrationDisabled: true }, "en");
  const off = renderRuntimeStrip({ ...base, orchestrationDisabled: false }, "en");
  assert.match(on, /Model orchestration is disabled on this host/);
  assert.doesNotMatch(off, /Model orchestration is disabled on this host/);
  assert.match(renderRuntimeStrip({ ...base, orchestrationDisabled: true }, "es"), /orquestación de modelos está desactivada/);
});
```

Replace the `/* … */` with the actual fixture expression from that file: if it is a named const, reference it; if it is inline, lift it into a `const` both tests share. The plan does not know its exact name, so read lines 30-80 first.

- [ ] **Step 2: Run them and confirm they fail**

Run: `npm test -- tests/models-panel.test.js tests/model-catalog-client-contract.test.js`
Expected: the three new tests FAIL (409 missing, flag missing, notice missing).

- [ ] **Step 3: Implement**

1. **`routes/models.js`:** import `isModelOrchestrationDisabled` from `../../shared/model-orchestration.js` (check the relative depth: `routes/` sits under `servers/gateway/`, so it is `../../shared/`). In the start handler, directly after the `NOT_INSTALLED` 404 check:

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

   In the runtime handler: `res.json({ probe: getCachedProbeFn(), models, activeDownloads, orchestrationDisabled: isModelOrchestrationDisabled() });`

2. **`model-catalog.js`:** import `isModelOrchestrationDisabled` from `../../../shared/model-orchestration.js` (the panel lives in `servers/gateway/dashboard/panels/`). Add `orchestrationDisabled: isModelOrchestrationDisabled(),` to `loadPanelData`'s return object. In `renderRuntimeStrip`, destructure `orchestrationDisabled`, and as the first notice push:

```js
  if (orchestrationDisabled) notices.push(t("models.runtimeOrchestrationDisabled", lang));
```

   It must come before the `if (!probe)` branch, so it shows even with no probe.

3. **`i18n.js`,** next to `models.runtimeNoBinary`:

```js
  "models.runtimeOrchestrationDisabled": { en: "Model orchestration is disabled on this host. Models here are started outside Crow.", es: "La orquestación de modelos está desactivada en este equipo. Los modelos se inician fuera de Crow." },
```

- [ ] **Step 4: Run and confirm it passes**

Run: `npm test -- tests/models-panel.test.js tests/model-catalog-client-contract.test.js`, then any i18n parity test: `ls tests | grep -i i18n` and run each with `npm test -- tests/<that>.test.js`.
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git commit servers/gateway/routes/models.js servers/gateway/dashboard/panels/model-catalog.js servers/gateway/dashboard/shared/i18n.js tests/models-panel.test.js tests/model-catalog-client-contract.test.js -m "feat(models): Models panel/route explain CROW_DISABLE_MODEL_ORCHESTRATION (409 + runtime notice)"
```

---

### Task 4: Docs, the raven port section, full suite

**Files:**
- Modify: `docs/developers/configuration.md`: add a row to the same table that holds `CROW_DISABLE_NOSTR` (line ~47).
- Modify: `docs/architecture/models.md`: a new section `## Host switch: no model orchestration` placed before `## External engines`.
- Modify: `docs/developers/port-allocation.md`: a new `## Second host: raven` section appended at the end, after `## Process for amending this file`.

- [ ] **Step 1: configuration.md row**

```markdown
| `CROW_DISABLE_MODEL_ORCHESTRATION` | *(unset)* | `1` (or `true`) makes this gateway **never start, stop or evict a model**: on-demand acquires return "not managed here" (callers dial the provider's base_url), boot residency and idle-revert are skipped, the Models panel's Start answers 409 `MODEL_ORCHESTRATION_DISABLED`. Read-only health polls stay on. For hosts whose models are owned by something else (raven: halogen under systemd). Any other value, including `0`, leaves orchestration on. |
```

- [ ] **Step 2: models.md section**

```markdown
## Host switch: no model orchestration

`CROW_DISABLE_MODEL_ORCHESTRATION=1` (`servers/shared/model-orchestration.js`) is a property of the **host**, not of a provider row. Per-row gates (locality, owner, foreign-instance veto, bundle/runtime presence, the external-engine marker) decide *which* rows a host may orchestrate. This switch says the host orchestrates *none*, however rows arrive through sync. That matters on a box like raven, where any synced row whose base_url is the box's own LAN address counts as local.

Under the switch:

- `maybeAcquireLocalProvider` returns `null`, the same as for a cloud row;
- `acquireProvider` throws `OrchestrationDisabledError` (`model_orchestration_disabled`) before any probe or start;
- `ensureResident`, `retryDeferredResidents` and `checkIdleRevert` are no-ops;
- `bootResidency` logs one DISABLED line and arms no idle-revert timer.

The residency poll and the external-engine poll still run, since both are read-only. Model downloads are not gated. Spec: `docs/superpowers/specs/2026-09-24-raven-instance-no-orchestration-design.md`.
```

- [ ] **Step 3: port-allocation.md raven section**

```markdown
## Second host: raven

Raven (10.0.0.126, `raven.dachshund-chromatic.ts.net`) is the second Strix Halo box. Its ports live in their own namespace. The first column is `raven:<port>`, not a bare number, because `scripts/check-port-allocation.js` reads bare numbers in the first cell as **crow** allocations. A raven port is verified only by checking raven (`ss -ltn`). Making the checker host-aware is follow-up work.

| port | bind | what | status |
|---|---|---|---|
| raven:3009 | 127.0.0.1 | Crow gateway (user unit `crow-gateway.service`, `CROW_DISABLE_MODEL_ORCHESTRATION=1`); reached only through Tailscale Serve `raven:8444` | planned |
| raven:8444 | tailnet (Serve) | Tailscale Serve HTTPS → `127.0.0.1:3009` (fleet `:8444` convention; never Funnel) | planned |
| raven:8030 | 0.0.0.0 (ufw: crow + grackle only) | halogen Flash-Next production (`flash-next.service`), an external engine Crow never manages | live |
| raven:8031–8033 | 0.0.0.0 | two-box masters (window mode, pi-lab) | reserved |
| raven:13305 | 127.0.0.1 | Lemonade server (`lemond`, installed but disabled since the 2026-09-24 NPU spike) | disabled |
| raven:9000 | 127.0.0.1 | Lemonade websocket | disabled |
```

- [ ] **Step 4: Full verification**

Run, in order:
1. `node scripts/check-port-allocation.js`: expected exit 0.
2. `npm run build-registry -- --check`, if that script exists in `package.json` (CI runs it): expected exit 0.
3. `npm test`, the FULL suite in the scratch env: expected 0 failures. Record the pass count in the PR body.

- [ ] **Step 5: Commit**

```bash
git commit docs/developers/configuration.md docs/architecture/models.md docs/developers/port-allocation.md -m "docs: CROW_DISABLE_MODEL_ORCHESTRATION + raven port namespace"
```

---

## Operational runbook (NOT part of the PR; the controller runs it after merge)

**A. Deploy.**
1. Confirm check-runs are green on the main sha.
2. In a free slot in `~/CROW-SCHEDULE.md`: `git -C ~/crow pull --ff-only origin main && sudo systemctl restart crow-gateway crow-r4-gateway`.
3. `/health` returns 200 on :3001 and :3008.
4. Neither log contains the DISABLED line (the env is unset there).

**B. Raven install** (spec D5). In a registered slot outside 22:00–06:00, with MemAvailable ≥ 6 GiB checked first. Every step is idempotent.
1. nvm and Node v24.21.0 (user-level).
2. `git clone https://github.com/kh0pper/crow.git ~/crow`, then `cd ~/crow && CROW_DATA_DIR=$HOME/.crow/data npm run setup`.
3. Write `~/.config/systemd/user/crow-gateway.service` with the env from spec D5, plus `Restart=always` and `MemoryMax=1G`. Then `loginctl enable-linger kh0pp` (sudo) and `systemctl --user enable --now crow-gateway`.
4. `sudo tailscale serve --bg --https=8444 http://127.0.0.1:3009`.
5. **Verify:**
   - the journal shows the DISABLED line;
   - `https://raven…ts.net:8444/health` returns 200 from crow;
   - `ss -ltn` shows `127.0.0.1:3009` only;
   - halogen returns 200.
6. Add the standing-automations row to CROW-SCHEDULE.

**C. Pairing** (spec D6). **Only after Kevin's explicit go:** identity export/import, crow's enroll window (two crow restarts), `instance-pair.js`, then verify sync both ways.
