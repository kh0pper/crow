# External-Engine Provider Kind Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a provider row declare "a different machine runs this engine" (`gpu_policy.engine = { managed: "external", host, label? }`). Crow then never orchestrates that row, watches it with a read-only 60 s probe, and shows its reachability in the nest health strip and the Providers tab.

**Architecture:** A pure, import-free helper (`servers/shared/provider-engine.js`) defines the marker. Every orchestrator path in `gpu-orchestrator.js` consults it before any other check. `upsertProvider` rejects rows that contradict it. A new module (`servers/gateway/external-engine-poll.js`) is armed next to the residency monitor. It sends `GET <base_url>/models` for every enabled marked row and records the results in a new `external` map in `provider-health.js`. The nest `providersSignal` and the Providers tab read that map. The work needs no schema change: `gpu_policy` is an existing JSON column that already replicates.

**Tech Stack:** Node 24 ESM, `node:test`, `@libsql/client` (only for the validation tests), server-rendered dashboard HTML, and the i18n table in `servers/gateway/dashboard/shared/i18n.js`.

**Spec:** `docs/superpowers/specs/2026-09-23-external-engine-provider-design.md`. It is the binding authority, so read it alongside this plan.

## Global Constraints

- Worktree ~/crow-wt-external-engine; node_modules is a symlink — never commit it or .superpowers/.
- Every shell starts with `export PATH=/home/kh0pp/.nvm/versions/node/v24.21.0/bin:$PATH`; tests ONLY via `npm test -- tests/<file>.test.js` (never raw `node --test` — it writes to the live DB).
- Commit with explicit paths (`git add` new files, then `git commit <paths> -m ...`); `git show --stat HEAD` after each commit.
- Every new i18n key needs en AND es (global parity gate). Dashboard panel client scripts inside template literals: never put a backtick in client JS.
- No network in tests: every probe goes through an injected fetch.
- No schema change (gpu_policy is an existing JSON column); if you find one is needed, stop and say so instead of planning it.
- The marker is exactly `gpu_policy.engine.managed === "external"`, and `"external"` is the only value defined. `engine.host` is display and documentation only and is never used for routing. `providers.host` stays `cloud` (spec §2.1).
- Every orchestrator path checks the marker **before** any other check (spec §2.2).
- The probe is `GET <base_url>/models` with **no auth header**, a **3 s timeout**, no retry within a tick, and 2xx means ready. The interval defaults to **60 s** and is set by `CROW_EXTERNAL_ENGINE_POLL_MS` (spec §2.3).
- The probe is read-only and never reacts to what it finds. The llm-router, chat, and sync are **not** changed (spec §2.5). `GET /api/providers/health` is unchanged (spec §2.4).
- External engines **never** produce a nest warn, and so never a push. They surface at severity `info` only: `"<label> on <host>: up"`, `"… down for <age> (externally managed)"` if the engine answered once in this process, or `"… not reachable from this instance"` if it never did. The resident-model warn path stays byte-identical (spec §2.4, revised in review round 1).
- Validation is **transition-only**. `upsertProvider` throws `EXTERNAL_ENGINE_CONFLICT` or `EXTERNAL_ENGINE_INVALID` only when a write **changes** `gpu_policy.engine`, `bundleId` or `gpu_policy.runtime` relative to the stored row **and** the resulting row is invalid. A malformed incoming `gpu_policy` JSON string is always `EXTERNAL_ENGINE_INVALID`. The typed orchestrator error is `ExternalEngineError` with `code: "external_engine"`.
- The poll probes and prunes only when `cfg._source === "db:providers"` (the value `loadProvidersFromDb` sets, `servers/shared/providers-db.js`). A models.json-fallback config never probes and never prunes.
- The Providers tab is server-rendered HTML with no client script. Interpolate engine `host` and `label` only through `escapeHtml`, and into i18n strings only through `fill()`, because they are free text replicated from peers.

## Review Focus

These are the five inputs the spec implies but never spells out, most likely first. Each one is pinned by a test in the task named on its line.

1. **A typo'd or partial marker**, such as `managed: "External"` or a missing `host`. Today such a row silently stays orchestratable. Expected: a write that introduces it is rejected loudly with `EXTERNAL_ENGINE_INVALID`, and the orchestrator treats only the exact string `"external"` as marked (Task 1 truth table, Task 2 write tests). A contradictory or malformed row that arrives by replication still accepts writes that leave the engine, bundle and runtime alone (Task 2).
2. **A later write that re-arms a marked row.**
   - Case (a): `gpuPolicy: null` plus a `bundleId`. The SQL `COALESCE` keeps the stored marker, so the effective row is contradictory.
   - Case (b): a `registerModel`-shaped write whose fresh `gpuPolicy: { runtime: "native" }` silently drops the marker and adopts the engine.
   - Expected: both are refused with `EXTERNAL_ENGINE_CONFLICT`. To unmark, the operator makes a separate, explicit write (Task 2).
3. **Free-text `host` or `label` carrying HTML or `$&`** that replicates in from a peer. Expected: the Providers tab escapes it (Task 5), and the nest copy renders it verbatim through `fill()` without mangling it (Task 4).
4. **A tick whose config is not the DB.** `loadProviders()` falls back to models.json, which has no markers, when its cache is null or the DB read fails. That includes the tick right after `invalidateProvidersCache()`, and the empty `{providers:{}}` case. Expected: the tick neither probes nor prunes, and every clock survives (Task 3).
5. **A repointed or odd `base_url`.**
   - A repointed URL starts fresh clocks, so it never inherits a stale "down for <age>" line, and the tab shows "not probed yet" until the new URL has been probed.
   - A non-http(s) `base_url` (such as `file:`) is never fetched.
   - A fetch that ignores the abort signal still resolves the tick at the timeout.
   - Covered in Task 3 and Task 5.

---

## File map

| File | Responsibility |
|---|---|
| `servers/shared/provider-engine.js` (create) | Pure marker helpers: `isExternalEngine`, `externalEngineInfo`, `engineShapeError`, `externalEngineConflict`, `ExternalEngineError`. No imports. |
| `servers/gateway/gpu-orchestrator.js` (modify) | D2 guards in maybeAcquire, acquire, warm-resolve, ensureResident, acquireOrStartNative, `isAlwaysResident`, siblings and mutex groups. Arms the poll in `initOrchestrator`. |
| `servers/shared/lifecycle.js` (modify) | D2 guard: `ensureModelWarm` refuses a marked row and `releaseModel` is a no-op for it. |
| `servers/shared/providers-db.js` (modify) | Transition-only validation of `upsertProvider` writes (D2). The reconciler keeps a stored `engine` and isolates each row in its own try/catch. |
| `servers/gateway/provider-health.js` (modify) | The new `external` map: `recordExternal`, `pruneExternal`, and `getProviderHealth().external`. |
| `servers/gateway/external-engine-poll.js` (create) | `probeExternalEngine`, `pollExternalEngines`, `startExternalEngineMonitor`, `_stopExternalEngineMonitor`, `externalEnginePollMs`. |
| `scripts/run-suite.mjs` (modify) | Sets `CROW_EXTERNAL_ENGINE_POLL_MS=0` for scratch suite gateways. |
| `servers/gateway/dashboard/panels/nest/health-signals.js` (modify) | `providersSignal` gains the external engines, at info severity only. |
| `servers/gateway/dashboard/settings/sections/llm/providers-tab.js` (modify) | `statusDot` and `engineBadge`, both exported, plus `render({ db, lang })`. |
| `servers/gateway/dashboard/shared/i18n.js` (modify) | 3 `signals.providers.*` keys and 4 `settings.providers.*` keys. |
| `docs/architecture/models.md` (modify) | Adds an "External engines" section. |

---

### Task 1: Marker helper + orchestrator guards (D1, D2)

**Files:**
- Create: `servers/shared/provider-engine.js`
- Modify: `servers/gateway/gpu-orchestrator.js` (imports near :93-96; `getMutexSiblings` :414; `isAlwaysResident` :423; `getMutexGroups` :454; `maybeAcquireLocalProvider` :580; `resolveWarmableProviderName` :624; `acquireOrStartNative` :1085; `acquireProvider` :1230; `ensureResident` :1459; the `_deferredResidents` filter in `initOrchestrator`)
- Modify: `servers/shared/lifecycle.js` (imports :20-23; `ensureModelWarm` :192; `releaseModel` :297)
- Test: `tests/provider-engine.test.js` (create), `tests/lifecycle-external-engine.test.js` (create), `tests/gpu-orchestrator-native.test.js`, `tests/gpu-orchestrator-host-gate.test.js`, `tests/gpu-warm-resolve.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces (every later task relies on these exact names):
  - `isExternalEngine(p) -> boolean`. True iff `p?.gpuPolicy?.engine?.managed === "external"`.
  - `externalEngineInfo(p) -> { host: string|null, label: string|null } | null`. Returns null when the row is unmarked.
  - `engineShapeError(engine) -> string|null`. Returns null when `engine` is absent or valid.
  - `externalEngineConflict({ bundleId, gpuPolicy }) -> boolean`.
  - `class ExternalEngineError extends Error { code: "external_engine", provider, engineHost }`. Re-exported from `gpu-orchestrator.js`.
  - `ENGINE_FIELD_MAX = 64`.
  - `_resetExternalSkipNoticesForTest()`. Exported from `gpu-orchestrator.js`.
  - `_internals.getMutexGroups(cfg?)`. It now accepts an optional cfg.
  - `isAlwaysResident(v)` returns false for a marked row, so `declaredAlwaysResident`, `localAlwaysResident`, `alwaysResidentProviders` and `_deferredResidents` never contain one.
  - In `lifecycle.js`: `ensureModelWarm(id, opts)` returns `{ ok: false, reason: "external_engine" }` for a marked row, and `releaseModel(id, opts)` returns `{ ok: true, refs: 0, external: true }`. Both accept an optional `opts.cfg` seam; production omits it.

- [ ] **Step 1: Write the failing helper tests**

Create `tests/provider-engine.test.js`:

```js
/**
 * provider-engine — the external-engine marker (spec
 * docs/superpowers/specs/2026-09-23-external-engine-provider-design.md §2.1/§2.2).
 * Pure helpers, no I/O.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isExternalEngine, externalEngineInfo, engineShapeError,
  externalEngineConflict, ExternalEngineError, ENGINE_FIELD_MAX,
} from "../servers/shared/provider-engine.js";

const ENGINE = { managed: "external", host: "raven", label: "halogen" };

test("isExternalEngine truth table: only managed === \"external\" (exact string) marks a row", () => {
  const cases = [
    [undefined, false],
    [null, false],
    [{}, false],
    [{ gpuPolicy: null }, false],
    [{ gpuPolicy: {} }, false],
    [{ gpuPolicy: { engine: null } }, false],
    [{ gpuPolicy: { engine: {} } }, false],
    [{ gpuPolicy: { engine: { managed: "External", host: "raven" } } }, false],
    [{ gpuPolicy: { engine: { managed: "internal", host: "raven" } } }, false],
    [{ gpuPolicy: { engine: { managed: true, host: "raven" } } }, false],
    [{ gpuPolicy: { engine: "external" } }, false],
    [{ gpuPolicy: { engine: { managed: "external" } } }, true], // shape-invalid, but the orchestrator errs safe
    [{ gpuPolicy: { engine: ENGINE } }, true],
    [{ gpuPolicy: { engine: ENGINE, runtime: "native" } }, true],
  ];
  for (const [p, want] of cases) assert.equal(isExternalEngine(p), want, JSON.stringify(p));
});

test("externalEngineInfo: trimmed host/label for a marked row, null for an unmarked one", () => {
  assert.equal(externalEngineInfo({ gpuPolicy: {} }), null);
  assert.deepEqual(externalEngineInfo({ gpuPolicy: { engine: ENGINE } }), { host: "raven", label: "halogen" });
  assert.deepEqual(
    externalEngineInfo({ gpuPolicy: { engine: { managed: "external", host: "  raven ", label: "" } } }),
    { host: "raven", label: null },
  );
  assert.deepEqual(externalEngineInfo({ gpuPolicy: { engine: { managed: "external" } } }), { host: null, label: null });
});

test("engineShapeError: absent is fine, valid is fine, every malformed shape names its problem", () => {
  assert.equal(engineShapeError(undefined), null);
  assert.equal(engineShapeError(null), null);
  assert.equal(engineShapeError(ENGINE), null);
  assert.equal(engineShapeError({ managed: "external", host: "raven" }), null);
  assert.match(engineShapeError("external"), /must be an object/);
  assert.match(engineShapeError([]), /must be an object/);
  assert.match(engineShapeError({ managed: "External", host: "raven" }), /exactly "external"/);
  assert.match(engineShapeError({ managed: "external" }), /host/);
  assert.match(engineShapeError({ managed: "external", host: "   " }), /host/);
  assert.match(engineShapeError({ managed: "external", host: "x".repeat(ENGINE_FIELD_MAX + 1) }), /host/);
  assert.match(engineShapeError({ managed: "external", host: "raven", label: 7 }), /label/);
  assert.match(engineShapeError({ managed: "external", host: "raven", label: "y".repeat(ENGINE_FIELD_MAX + 1) }), /label/);
});

test("externalEngineConflict: marker + bundleId or marker + native runtime; nothing else", () => {
  assert.equal(externalEngineConflict({ bundleId: null, gpuPolicy: { engine: ENGINE } }), false);
  assert.equal(externalEngineConflict({ bundleId: "halogen", gpuPolicy: { engine: ENGINE } }), true);
  assert.equal(externalEngineConflict({ bundleId: null, gpuPolicy: { engine: ENGINE, runtime: "native" } }), true);
  assert.equal(externalEngineConflict({ bundleId: "b", gpuPolicy: { runtime: "native" } }), false); // unmarked: not this rule's business
  assert.equal(externalEngineConflict({ bundleId: "", gpuPolicy: { engine: ENGINE } }), false);
  assert.equal(externalEngineConflict({}), false);
});

test("ExternalEngineError carries code external_engine, the provider and the engine host", () => {
  const err = new ExternalEngineError("raven-flash-next", "raven");
  assert.ok(err instanceof Error);
  assert.equal(err.name, "ExternalEngineError");
  assert.equal(err.code, "external_engine");
  assert.equal(err.provider, "raven-flash-next");
  assert.equal(err.engineHost, "raven");
  assert.match(err.message, /raven-flash-next/);
  assert.match(err.message, /on raven/);
  assert.equal(new ExternalEngineError("x").engineHost, null);
});
```

- [ ] **Step 2: Write the failing orchestrator tests**

Append to the END of `tests/gpu-orchestrator-native.test.js`. The helpers `nativeProv`, `dockerProv`, `fakeHandle`, `startCapableOpts`, `captureLogs` and `downThenResident` are already defined in that file. `beforeEach` already resets the handles for `native-target` and `native-sib`. Extend the file's existing import from `../servers/gateway/gpu-orchestrator.js` by adding `ExternalEngineError`, `_resetExternalSkipNoticesForTest` and `_internals` to its named-import list:

```js
// --- external engines (spec 2026-09-23 external-engine-provider §2.2) --------
//
// A row carrying gpu_policy.engine.managed === "external" is run by ANOTHER
// machine. Several fixtures below are deliberately contradictory (marker +
// runtime native, marker + bundleId) — the shape a replicated or legacy row
// could have. Without the guard each of them WOULD be started, evicted or
// warmed; that is what makes these tests non-vacuous.

const ENGINE = { managed: "external", host: "raven", label: "halogen" };

test("external engine: maybeAcquireLocalProvider returns null and spawns nothing, even for a row that also claims runtime native", async () => {
  const cfg = { providers: { "native-target": nativeProv(18180, "qwen3-4b", { gpuPolicy: { engine: ENGINE } }) } };
  const startCalls = [];
  const result = await maybeAcquireLocalProvider(
    "native-target",
    startCapableOpts({ cfg, identityProbeFn: async () => "down", startCalls }),
  );
  assert.equal(result, null);
  assert.equal(startCalls.length, 0);
});

test("external engine: acquireProvider throws ExternalEngineError (code external_engine) before any probe or start", async () => {
  const cfg = { providers: { "native-target": nativeProv(18181, "qwen3-4b", { gpuPolicy: { engine: ENGINE } }) } };
  let probes = 0;
  const startCalls = [];
  await assert.rejects(
    acquireProvider("native-target", startCapableOpts({
      cfg,
      identityProbeFn: async () => { probes += 1; return "down"; },
      startCalls,
    })),
    (err) => err instanceof ExternalEngineError && err.code === "external_engine" && err.engineHost === "raven",
  );
  assert.equal(probes, 0, "refused before the identity probe");
  assert.equal(startCalls.length, 0);
});

test("external engine: a Docker-shaped external row is refused by acquireProvider too — bundleUp never runs", async () => {
  const cfg = { providers: { ext: dockerProv("http://127.0.0.1:8030/v1", "halogen-bundle", { gpuPolicy: { engine: ENGINE } }) } };
  const bundleUpCalls = [];
  await assert.rejects(
    acquireProvider("ext", {
      cfg,
      probeReadyFn: async () => false,
      bundleUpFn: async (id) => { bundleUpCalls.push(id); },
      waitForReadyFn: async () => true,
    }),
    ExternalEngineError,
  );
  assert.deepEqual(bundleUpCalls, []);
});

test("external engine: ensureResident skips it, starts nothing, and logs exactly once across repeated calls", async () => {
  _resetExternalSkipNoticesForTest();
  const cfg = { providers: { "native-target": nativeProv(18182, "qwen3-4b", { gpuPolicy: { engine: ENGINE, alwaysResident: true } }) } };
  const startCalls = [];
  const opts = startCapableOpts({ cfg, identityProbeFn: async () => "down", startCalls });
  const logs = await captureLogs(async () => {
    assert.equal(await ensureResident("native-target", cfg, opts), false);
    assert.equal(await ensureResident("native-target", cfg, opts), false);
  });
  assert.equal(startCalls.length, 0);
  const skips = logs.filter((l) => l.includes("residency skipped native-target") && l.includes("external engine on raven"));
  assert.equal(skips.length, 1, logs.join("\n"));
});

test("external engine: a native acquire never evicts an external sibling sharing its mutexGroup", async () => {
  const cfg = { providers: {
    "native-target": nativeProv(18183, "qwen3-4b", { gpuPolicy: { runtime: "native", mutexGroup: "local-llm" } }),
    // Contradictory on purpose: without the guard its bundleId would be bundleStop'd.
    "native-sib": dockerProv("http://127.0.0.1:8030/v1", "halogen-bundle", { gpuPolicy: { mutexGroup: "local-llm", engine: ENGINE } }),
  } };
  const bundleStopCalls = [];
  const result = await acquireProvider("native-target", {
    ...startCapableOpts({ cfg, identityProbeFn: downThenResident() }),
    bundleStopFn: async (id) => { bundleStopCalls.push(id); },
    probeReadyFn: async () => true, // the external engine is answering
  });
  assert.equal(result, true);
  assert.deepEqual(bundleStopCalls, [], "the external engine was never stopped");
});

test("external engine: a Docker acquire never stops an external sibling's live native handle", async () => {
  const cfg = { providers: {
    "docker-target": dockerProv("http://127.0.0.1:8003/v1", "vllm-rocm-qwen35-4b", { gpuPolicy: { mutexGroup: "local-llm" } }),
    "native-sib": nativeProv(18184, "qwen3-4b", { gpuPolicy: { runtime: "native", mutexGroup: "local-llm", engine: ENGINE } }),
  } };
  const sibHandle = fakeHandle();
  _setNativeHandleForTest("native-sib", sibHandle);
  const result = await acquireProvider("docker-target", {
    cfg,
    probeReadyFn: async () => false,
    bundleUpFn: async () => {},
    waitForReadyFn: async () => true,
  });
  assert.equal(result, true);
  assert.equal(sibHandle.stopCalls, 0);
  assert.equal(sibHandle.live, true);
});

test("external engine: idle-revert's mutex groups never name it as default nor list it as a member; siblings exclude it", () => {
  const cfg = { providers: {
    "chat-a": dockerProv("http://127.0.0.1:8003/v1", "bundle-a", { gpuPolicy: { mutexGroup: "g" } }),
    "chat-b": dockerProv("http://127.0.0.1:8004/v1", "bundle-b", { gpuPolicy: { mutexGroup: "g" } }),
    "ext-default": { baseUrl: "http://10.0.0.126:8030/v1", host: "cloud", bundleId: null, gpuPolicy: { mutexGroup: "g", defaultMember: true, engine: ENGINE } },
  } };
  const g = _internals.getMutexGroups(cfg).get("g");
  assert.equal(g.default, null, "idle-revert must never revert TO an external engine");
  assert.deepEqual(g.members.map((m) => m.name).sort(), ["chat-a", "chat-b"]);
  assert.deepEqual(_internals.getMutexSiblings("chat-a", cfg), ["chat-b"]);
  assert.deepEqual(_internals.getMutexSiblings("ext-default", cfg), []);
});
```

Append to the END of `tests/gpu-orchestrator-host-gate.test.js`:

```js
test("external engine: maybeAcquireLocalProvider returns null before the host/locality gates, even on a loopback bundle row", async () => {
  // Without the guard this row passes every gate and the fast path returns true.
  const cfg = { providers: { p: {
    baseUrl: "http://127.0.0.1:1/v1", host: "cloud", bundleId: "b",
    gpuPolicy: { engine: { managed: "external", host: "raven" } },
  } } };
  assert.equal(await maybeAcquireLocalProvider("p", { cfg, probeReadyFn: async () => true }), null);
});
```

Append to the END of `tests/gpu-warm-resolve.test.js`:

```js
test("external engines are never warmable: direct, as an alias, or as the sibling an alias would resolve to", () => {
  const ENGINE = { managed: "external", host: "raven", label: "halogen" };
  const c = { providers: {
    "ext-bundle":  { baseUrl: "http://x:8030/v1", host: "local", bundleId: "halogen", gpuPolicy: { engine: ENGINE } },
    "ext-alias":   { baseUrl: "http://x:8003/v1", host: "cloud", bundleId: null, gpuPolicy: { engine: ENGINE } },
    "crow-chat":   { baseUrl: "http://x:8003/v1", host: "local", bundleId: "llamacpp-qwen36-35b" },
    "plain-alias": { baseUrl: "http://x:8030/v1", host: "local", bundleId: null },
  } };
  assert.strictEqual(resolveWarmableProviderName(c, "ext-bundle", OWN), null);
  assert.strictEqual(resolveWarmableProviderName(c, "ext-alias", OWN), null);
  assert.strictEqual(resolveWarmableProviderName(c, "plain-alias", OWN), null, "an external engine is never the sibling to warm");
  assert.strictEqual(resolveWarmableProviderName(c, "crow-chat", OWN), "crow-chat", "unmarked neighbours are unaffected");
});
```

In `tests/gpu-orchestrator-host-gate.test.js`, add `declaredAlwaysResident, localAlwaysResident` to the named import from `../servers/gateway/gpu-orchestrator.js`, then append to the END of the file:

```js
test("external engine: never always-resident — not declared, not local, not ensured, even with alwaysResident:true on a loopback bundle", () => {
  const cfg = { providers: {
    "crow-voice": CFG.providers["crow-voice"],
    "ext-resident": {
      baseUrl: "http://127.0.0.1:8030/v1", host: "cloud", bundleId: "halogen",
      gpuPolicy: { alwaysResident: true, engine: { managed: "external", host: "raven" } },
    },
  } };
  assert.deepEqual(declaredAlwaysResident(cfg), ["crow-voice"]);
  assert.deepEqual(localAlwaysResident(cfg, CROW), ["crow-voice"]);
  assert.deepEqual(alwaysResidentProviders(cfg, CROW), ["crow-voice"]);
});
```

Create `tests/lifecycle-external-engine.test.js`:

```js
/**
 * Legacy lifecycle.js (ensureModelWarm/releaseModel) refuses external engines
 * (spec 2026-09-23 external-engine-provider §2.2). CROW_REFCOUNT_PATH is
 * pointed at a tmp file BEFORE the module loads (it reads/persists refcounts
 * at import time); fetch is replaced with a spy so nothing leaves the box.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "lifecycle-ext-"));
process.env.CROW_REFCOUNT_PATH = join(dir, "refcounts.json");
const { ensureModelWarm, releaseModel, onLifecycleEvent } = await import("../servers/shared/lifecycle.js");

const cfg = { providers: {
  "raven-flash-next": {
    baseUrl: "http://10.0.0.126:8030/v1", host: "cloud", bundleId: "halogen", // contradictory on purpose
    models: [{ id: "flash-next" }],
    gpuPolicy: { engine: { managed: "external", host: "raven", label: "halogen" } },
  },
} };

let realFetch;
const fetchCalls = [];
before(() => { realFetch = globalThis.fetch; globalThis.fetch = async (...a) => { fetchCalls.push(a); throw new Error("no network in tests"); }; });
after(() => { globalThis.fetch = realFetch; rmSync(dir, { recursive: true, force: true }); });

test("ensureModelWarm refuses an external engine: no probe, no bundle start, reason external_engine", async () => {
  const events = [];
  const off = onLifecycleEvent((e) => events.push(e.type));
  try {
    const r = await ensureModelWarm("raven-flash-next", { cfg });
    assert.deepEqual(r, { ok: false, reason: "external_engine" });
  } finally { off(); }
  assert.equal(fetchCalls.length, 0);
  assert.ok(!events.includes("bundle_start"));
});

test("releaseModel is a no-op for an external engine", async () => {
  assert.deepEqual(await releaseModel("raven-flash-next", { cfg }), { ok: true, refs: 0, external: true });
  assert.equal(fetchCalls.length, 0);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `export PATH=/home/kh0pp/.nvm/versions/node/v24.21.0/bin:$PATH && cd ~/crow-wt-external-engine && npm test -- tests/provider-engine.test.js tests/gpu-orchestrator-native.test.js tests/gpu-orchestrator-host-gate.test.js tests/gpu-warm-resolve.test.js`

Expected results:
- `provider-engine.test.js` and `gpu-orchestrator-native.test.js` fail to load. The first reports `Cannot find module .../provider-engine.js`. The second reports "does not provide an export named 'ExternalEngineError'".
- The new host-gate test fails with `true !== null`.
- The new warm-resolve test fails with `'ext-bundle' !== null`.
- The new always-resident test fails (`ext-resident` is listed).
- The lifecycle tests fail: the guard is missing, so `ensureModelWarm` tries the probe and the fetch spy is called.

- [ ] **Step 4: Create the helper**

Create `servers/shared/provider-engine.js`:

```js
/**
 * External-engine marker (spec docs/superpowers/specs/2026-09-23-external-engine-provider-design.md §2.1).
 *
 * A provider row is an EXTERNAL ENGINE when
 *
 *   gpu_policy.engine = { managed: "external", host: "<machine label>", label?: "<engine name>" }
 *
 * Another machine runs it (raven's halogen). Crow never starts, warms,
 * evicts or idle-reverts to it; the only thing any instance ever sends it is
 * a read-only GET <base_url>/models (external-engine-poll.js). `host` is a
 * display/documentation label — NEVER a routing input; providers.host stays
 * "cloud" (PR #382: an unmanaged LAN endpoint is cloud, shown as "network").
 *
 * PURE and import-free on purpose: the orchestrator, providers-db's write
 * validation, the nest health signal and the Providers tab all read it, and
 * none of them may drag another's import chain along.
 */

export const ENGINE_FIELD_MAX = 64;

/** True iff the row is marked externally managed. Exact string match only. */
export function isExternalEngine(p) {
  return p?.gpuPolicy?.engine?.managed === "external";
}

/** Display info for a marked row: `{ host, label }` (trimmed; empty → null), or null if unmarked. */
export function externalEngineInfo(p) {
  if (!isExternalEngine(p)) return null;
  const e = p.gpuPolicy.engine;
  const clean = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return { host: clean(e.host), label: clean(e.label) };
}

/** Why a gpu_policy.engine value is malformed, or null when it is absent or valid. */
export function engineShapeError(engine) {
  if (engine === undefined || engine === null) return null;
  if (typeof engine !== "object" || Array.isArray(engine)) return "gpu_policy.engine must be an object";
  if (engine.managed !== "external") return 'gpu_policy.engine.managed must be exactly "external"';
  if (typeof engine.host !== "string" || !engine.host.trim() || engine.host.length > ENGINE_FIELD_MAX) {
    return `gpu_policy.engine.host must be a non-empty string of at most ${ENGINE_FIELD_MAX} characters`;
  }
  if (engine.label !== undefined && engine.label !== null
      && (typeof engine.label !== "string" || engine.label.length > ENGINE_FIELD_MAX)) {
    return `gpu_policy.engine.label must be a string of at most ${ENGINE_FIELD_MAX} characters`;
  }
  return null;
}

/** The contradiction spec §2.2 forbids: externally managed AND orchestratable here. */
export function externalEngineConflict({ bundleId, gpuPolicy } = {}) {
  if (gpuPolicy?.engine?.managed !== "external") return false;
  return (bundleId != null && bundleId !== "") || gpuPolicy.runtime === "native";
}

/** Thrown by acquireProvider (and the native start funnel) for a marked row. */
export class ExternalEngineError extends Error {
  constructor(providerName, engineHost = null) {
    super(`orchestrator: provider "${providerName}" is an external engine${engineHost ? ` on ${engineHost}` : ""} — Crow never starts, stops or swaps it`);
    this.name = "ExternalEngineError";
    this.code = "external_engine";
    this.provider = providerName;
    this.engineHost = engineHost;
  }
}
```

- [ ] **Step 5: Wire the guards into the orchestrator**

In `servers/gateway/gpu-orchestrator.js`:

(a) Imports. Find this text:

```js
import { servingClassRefusal, ServingClassError } from "./models/serving-class.js";
export { ServingClassError } from "./models/serving-class.js";
```

Replace it with:

```js
import { servingClassRefusal, ServingClassError } from "./models/serving-class.js";
import { isExternalEngine, externalEngineInfo, ExternalEngineError } from "../shared/provider-engine.js";
export { ServingClassError } from "./models/serving-class.js";
export { ExternalEngineError } from "../shared/provider-engine.js";
```

(b) `getMutexSiblings`. Replace the whole function with:

```js
function getMutexSiblings(name, cfg = loadProviders()) {
  const p = getProvider(name, cfg);
  if (isExternalEngine(p)) return []; // spec 2026-09-23 D2: never part of a swap
  const group = mutexGroupOf(p);
  if (!group) return [];
  return Object.entries(cfg.providers || {})
    .filter(([n, v]) => n !== name && !isExternalEngine(v) && mutexGroupOf(v) === group)
    .map(([n]) => n);
}
```

(c) `getMutexGroups`. Replace the whole function (with its preceding `// Map<mutexGroup, …>` comment line) with:

```js
// Map<mutexGroup, { default: string|null, members: Array<{name, baseUrl, bundleId}> }>
// External engines (spec 2026-09-23 D2) are never members and never the
// default — idle-revert must neither probe/seed them nor revert TO them.
function getMutexGroups(cfg = loadProviders()) {
  const groups = new Map();
  for (const [name, v] of Object.entries(cfg.providers || {})) {
    if (isExternalEngine(v)) continue;
    const group = mutexGroupOf(v);
    if (!group) continue;
    if (!groups.has(group)) groups.set(group, { default: null, members: [] });
    const g = groups.get(group);
    g.members.push({ name, baseUrl: v.baseUrl, bundleId: v.bundleId });
    if (v.gpuPolicy?.defaultMember === true || v.defaultMember === true) g.default = name;
  }
  return groups;
}
```

(`checkIdleRevert` keeps calling `getMutexGroups()` with no argument, so production behaviour for unmarked rows is unchanged.)

(d) `maybeAcquireLocalProvider`. Find:

```js
  const p = getProvider(providerName, cfg);
  if (!p?.bundleId && !isNativeRuntime(p)) return null;
```

Replace it with:

```js
  const p = getProvider(providerName, cfg);
  // External engine (spec 2026-09-23 D2) — checked FIRST: "not mine to
  // manage", the same null a cloud row gets; the caller dials base_url.
  if (isExternalEngine(p)) return null;
  if (!p?.bundleId && !isNativeRuntime(p)) return null;
```

(e) `resolveWarmableProviderName`. Find:

```js
  const direct = provs[name];
  if (!direct) return null;
  if (direct.bundleId || isNativeRuntime(direct)) {
```

Replace it with:

```js
  const direct = provs[name];
  if (!direct) return null;
  if (isExternalEngine(direct)) return null; // spec 2026-09-23 D2: never warmed here
  if (direct.bundleId || isNativeRuntime(direct)) {
```

In the same function, find:

```js
    if (n === name || !v || !v.bundleId) continue;
```

Replace it with:

```js
    if (n === name || !v || !v.bundleId || isExternalEngine(v)) continue;
```

(f) `acquireOrStartNative` is the single native-spawn funnel, so it gets a guard for defence in depth. Find its first lines:

```js
async function acquireOrStartNative(providerName, p, cfg, opts = {}) {
  // Owner gate, defence in depth (final review C3). Every caller is
```

Replace them with:

```js
async function acquireOrStartNative(providerName, p, cfg, opts = {}) {
  // External engine (spec 2026-09-23 D2): the single native-spawn funnel
  // refuses one even if a caller forgot to gate.
  if (isExternalEngine(p)) throw new ExternalEngineError(providerName, externalEngineInfo(p)?.host ?? null);
  // Owner gate, defence in depth (final review C3). Every caller is
```

(g) `acquireProvider`. Find:

```js
  const p = getProvider(providerName, cfg);
  if (!p) throw new Error(`orchestrator: unknown provider "${providerName}"`);

  if (isNativeRuntime(p)) {
```

Replace it with:

```js
  const p = getProvider(providerName, cfg);
  if (!p) throw new Error(`orchestrator: unknown provider "${providerName}"`);
  // External engine (spec 2026-09-23 D2) — before any probe, lock or start.
  if (isExternalEngine(p)) throw new ExternalEngineError(providerName, externalEngineInfo(p)?.host ?? null);

  if (isNativeRuntime(p)) {
```

(h) `ensureResident`. Directly above the `/** Ensure ONE alwaysResident provider:` doc comment, insert:

```js
// ensureResident runs at boot and on every residency retry; an external
// engine is announced once per provider, then skipped silently.
const _externalSkipNoticed = new Set();
function noteExternalSkip(name, p) {
  if (_externalSkipNoticed.has(name)) return;
  _externalSkipNoticed.add(name);
  const host = externalEngineInfo(p)?.host || "another machine";
  console.log(`[gpu-orchestrator] residency skipped ${name}: external engine on ${host} — never started here`);
}
export function _resetExternalSkipNoticesForTest() { _externalSkipNoticed.clear(); }
```

Then, inside `ensureResident`, find:

```js
    const p = (cfg.providers || {})[name];
    const requester = opts.requester || "residency";
    if (p && isNativeRuntime(p)) {
```

Replace it with:

```js
    const p = (cfg.providers || {})[name];
    const requester = opts.requester || "residency";
    if (p && isExternalEngine(p)) { noteExternalSkip(name, p); return false; }
    if (p && isNativeRuntime(p)) {
```

(i) `isAlwaysResident`. Replace:

```js
function isAlwaysResident(v) {
  return v?.gpuPolicy?.alwaysResident === true || v?.alwaysResident === true;
}
```

with:

```js
function isAlwaysResident(v) {
  if (isExternalEngine(v)) return false; // spec 2026-09-23 D2: never resident here
  return v?.gpuPolicy?.alwaysResident === true || v?.alwaysResident === true;
}
```

In `initOrchestrator`, the deferred set uses its own inline copy of that predicate. Find:

```js
        .filter(([, v]) => (v.gpuPolicy?.alwaysResident === true || v.alwaysResident === true)
          && !orchestratableHere(v, {}, ownAddrs))
```

Replace it with:

```js
        .filter(([, v]) => isAlwaysResident(v) && !orchestratableHere(v, {}, ownAddrs))
```

(j) `servers/shared/lifecycle.js`. Find:

```js
import { loadProviders } from "./providers.js";
```

Replace it with:

```js
import { loadProviders } from "./providers.js";
import { isExternalEngine } from "./provider-engine.js";
```

Directly above the `/**` doc comment of `export async function ensureModelWarm`, insert:

```js
/** External engine (spec 2026-09-23 D2): another machine runs it — this
 *  module never warms, counts or stops it. `opts.cfg` is a test seam. */
function isExternalHere(providerId, opts = {}) {
  const cfg = opts.cfg || loadProviders();
  return isExternalEngine(cfg.providers?.[providerId]);
}
```

In `ensureModelWarm`, find:

```js
export async function ensureModelWarm(providerId, opts = {}) {
  const info = lookupProvider(providerId);
```

Replace it with:

```js
export async function ensureModelWarm(providerId, opts = {}) {
  if (isExternalHere(providerId, opts)) {
    emit({ type: "external_engine_refused", providerId });
    return { ok: false, reason: "external_engine" };
  }
  const info = lookupProvider(providerId);
```

In `releaseModel`, find:

```js
export async function releaseModel(providerId, opts = {}) {
  const info = lookupProvider(providerId);
```

Replace it with:

```js
export async function releaseModel(providerId, opts = {}) {
  if (isExternalHere(providerId, opts)) return { ok: true, refs: 0, external: true };
  const info = lookupProvider(providerId);
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `export PATH=/home/kh0pp/.nvm/versions/node/v24.21.0/bin:$PATH && cd ~/crow-wt-external-engine && npm test -- tests/provider-engine.test.js tests/lifecycle-external-engine.test.js tests/gpu-orchestrator-native.test.js tests/gpu-orchestrator-host-gate.test.js tests/gpu-warm-resolve.test.js tests/gpu-orchestrator-residency-poll.test.js tests/gpu-orchestrator-serving-class.test.js`

Expected: PASS, 0 failures. That includes every pre-existing test in these files, since unmarked rows behave exactly as before.

- [ ] **Step 7: Commit**

```bash
cd ~/crow-wt-external-engine
git add servers/shared/provider-engine.js tests/provider-engine.test.js tests/lifecycle-external-engine.test.js
git commit servers/shared/provider-engine.js servers/gateway/gpu-orchestrator.js servers/shared/lifecycle.js tests/provider-engine.test.js tests/lifecycle-external-engine.test.js tests/gpu-orchestrator-native.test.js tests/gpu-orchestrator-host-gate.test.js tests/gpu-warm-resolve.test.js -m "feat(providers): external-engine marker; orchestrator never acquires, warms, evicts or reverts to one"
git show --stat HEAD
```

---

### Task 2: Transition-only write validation in `upsertProvider`, plus reconciler hardening (D2 validation)

**Files:**
- Modify: `servers/shared/providers-db.js`: imports near :38; `upsertProvider` :227; `syncProvidersFromModelsJson` :555.
- Test: `tests/providers-external-engine-write.test.js` (create).

**Interfaces:**
- Consumes: `engineShapeError`, `externalEngineConflict`, `isExternalEngine` from Task 1.
- Produces:
  - `upsertProvider` throws an `Error` whose `.code` is `"EXTERNAL_ENGINE_INVALID"` or `"EXTERNAL_ENGINE_CONFLICT"`. Nothing is written or emitted when it throws. Every other write behaves as before.
  - `syncProvidersFromModelsJson` returns one extra counter, `failed: number`.

The rules below are **transition-only** (review round 1, C2). They run after the existing-row `SELECT` and **before** the no-op check.

1. **A malformed incoming `gpu_policy` is always `EXTERNAL_ENGINE_INVALID`.** Malformed means a raw string that does not parse, or that parses to something other than a plain object. It is never treated as "keep the stored policy".
2. **Work out the resulting row.**
   - The effective policy is the incoming policy if there is one, else the stored one. This mirrors `COALESCE(excluded.gpu_policy, providers.gpu_policy)`.
   - The effective bundle is always the incoming `bundleId`, because `bundle_id = excluded.bundle_id`.
3. **Did the write change anything that matters?** It changed if `engine` differs by canonical deep-equal, or the bundle differs (`null` ≡ `""`), or `runtime` differs, compared with the stored row. If none of these changed, the write passes, even when the stored row is contradictory or malformed. Such a row can arrive by replication, which never goes through `upsertProvider`.
4. **If something changed, reject a resulting row that is invalid:**
   - `engineShapeError(effective.engine)` → `EXTERNAL_ENGINE_INVALID`;
   - `externalEngineConflict({ bundleId, gpuPolicy: effective })` → `EXTERNAL_ENGINE_CONFLICT`;
   - a stored-marked row that becomes an unmarked but orchestratable row (it gains a bundle or `runtime: "native"`) → `EXTERNAL_ENGINE_CONFLICT`. Unmark first, in a separate write.

The reconciler changes in two ways.
- **Q3:** when the assert branch writes a non-null `gpuPolicy` for a row whose stored policy carries `engine`, the stored `engine` is copied into the written policy.
- **C2:** each models.json entry runs in its own `try/catch`. A refusal logs `[providers-reconcile] <id> skipped: <code>: <message>`, increments `failed`, and the pass continues.

- [ ] **Step 1: Write the failing tests**

Create `tests/providers-external-engine-write.test.js`:

```js
/**
 * upsertProvider external-engine validation is TRANSITION-ONLY (spec
 * docs/superpowers/specs/2026-09-23-external-engine-provider-design.md §2.2,
 * revised after review round 1): a write is refused only when it CHANGES
 * engine / bundleId / runtime and the result is invalid. Replication writes
 * rows directly, so contradictory or malformed rows are seeded here with raw
 * SQL, and today's write paths (tab re-enable, reenableProviderPreservingContent,
 * repairProviderHosts, the models.json reconciler) must keep working on them.
 *
 * Harness: freshLibsql() from providers-reconcile-gate.test.js — per-test
 * init-db'd tmp DB, CROW_DATA_DIR and CROW_MODELS_JSON pointed into it, so
 * neither the real ~/.crow nor any real models.json is touched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  upsertProvider, listProvidersAll, setProviderSyncManager,
  reenableProviderPreservingContent, repairProviderHosts, syncProvidersFromModelsJson,
} from "../servers/shared/providers-db.js";

function freshLibsql(fixtureProviders = {}) {
  const dir = mkdtempSync(join(tmpdir(), "providers-ext-engine-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir, CROW_MODELS_JSON: "" }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const fixturePath = join(dir, "models.fixture.json");
  writeFileSync(fixturePath, JSON.stringify({ providers: fixtureProviders }));
  const prevDataDir = process.env.CROW_DATA_DIR;
  const prevModelsJson = process.env.CROW_MODELS_JSON;
  process.env.CROW_DATA_DIR = dir;
  process.env.CROW_MODELS_JSON = fixturePath;
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return {
    db,
    cleanup() {
      setProviderSyncManager(null);
      if (prevDataDir === undefined) delete process.env.CROW_DATA_DIR;
      else process.env.CROW_DATA_DIR = prevDataDir;
      if (prevModelsJson === undefined) delete process.env.CROW_MODELS_JSON;
      else process.env.CROW_MODELS_JSON = prevModelsJson;
      try { db.close(); } catch {}
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const ENGINE = { managed: "external", host: "raven", label: "halogen" };
const RAVEN = "http://10.0.0.126:8030/v1";
const ravenRow = (extra = {}) => ({
  id: "raven-flash-next",
  baseUrl: RAVEN,
  apiKey: null,
  host: "cloud",
  bundleId: null,
  description: "raven halogen",
  models: [{ id: "flash-next" }],
  disabled: false,
  providerType: "openai-compat",
  ...extra,
});

/** Seed a row the way replication does: raw SQL, no validation. */
async function seedRaw(db, { id, baseUrl = RAVEN, host = "cloud", bundleId = null, gpuPolicy, disabled = 0, instanceId = "peer-instance" }) {
  await db.execute({
    sql: `INSERT INTO providers (id, base_url, api_key, host, bundle_id, description, models, disabled, lamport_ts, instance_id, provider_type, gpu_policy)
          VALUES (?, ?, NULL, ?, ?, NULL, '[{"id":"m"}]', ?, 5, ?, 'openai-compat', ?)`,
    args: [id, baseUrl, host, bundleId, disabled, instanceId, gpuPolicy == null ? null : (typeof gpuPolicy === "string" ? gpuPolicy : JSON.stringify(gpuPolicy))],
  });
}

async function stored(db, id) {
  const { rows } = await db.execute({ sql: "SELECT * FROM providers WHERE id = ?", args: [id] });
  return rows[0] || null;
}
const policyOf = (row) => (row?.gpu_policy == null ? null : JSON.parse(row.gpu_policy));
const code = (c) => (err) => err?.code === c;

// --- new invalid rows are refused -------------------------------------------

test("a valid marker on a cloud row is accepted and stored", async () => {
  const h = freshLibsql();
  try {
    await upsertProvider(h.db, ravenRow({ gpuPolicy: { engine: ENGINE } }));
    assert.deepEqual(policyOf(await stored(h.db, "raven-flash-next")).engine, ENGINE);
  } finally { h.cleanup(); }
});

test("a NEW row with marker + bundleId is refused (EXTERNAL_ENGINE_CONFLICT); nothing written", async () => {
  const h = freshLibsql();
  try {
    await assert.rejects(upsertProvider(h.db, ravenRow({ bundleId: "halogen", gpuPolicy: { engine: ENGINE } })), code("EXTERNAL_ENGINE_CONFLICT"));
    assert.equal(await stored(h.db, "raven-flash-next"), null);
  } finally { h.cleanup(); }
});

test("a NEW row with marker + native runtime is refused (EXTERNAL_ENGINE_CONFLICT)", async () => {
  const h = freshLibsql();
  try {
    await assert.rejects(upsertProvider(h.db, ravenRow({ gpuPolicy: { engine: ENGINE, runtime: "native" } })), code("EXTERNAL_ENGINE_CONFLICT"));
  } finally { h.cleanup(); }
});

test("introducing a malformed marker is refused (EXTERNAL_ENGINE_INVALID): typo'd managed, missing host, empty host", async () => {
  const h = freshLibsql();
  try {
    await assert.rejects(upsertProvider(h.db, ravenRow({ gpuPolicy: { engine: { managed: "External", host: "raven" } } })), code("EXTERNAL_ENGINE_INVALID"));
    await assert.rejects(upsertProvider(h.db, ravenRow({ gpuPolicy: { engine: { managed: "external" } } })), code("EXTERNAL_ENGINE_INVALID"));
    await assert.rejects(upsertProvider(h.db, ravenRow({ gpu_policy: JSON.stringify({ engine: { managed: "external", host: "" } }) })), code("EXTERNAL_ENGINE_INVALID"));
  } finally { h.cleanup(); }
});

test("a malformed incoming gpu_policy JSON string is INVALID, not 'keep stored' — even on a row with no marker", async () => {
  const h = freshLibsql();
  try {
    await upsertProvider(h.db, ravenRow({ gpuPolicy: { mutexGroup: "g" } }));
    await assert.rejects(upsertProvider(h.db, ravenRow({ gpu_policy: "{not json" })), code("EXTERNAL_ENGINE_INVALID"));
    await assert.rejects(upsertProvider(h.db, ravenRow({ gpu_policy: "[1,2]" })), code("EXTERNAL_ENGINE_INVALID"));
    assert.deepEqual(policyOf(await stored(h.db, "raven-flash-next")), { mutexGroup: "g" }, "stored policy untouched");
  } finally { h.cleanup(); }
});

test("COALESCE hole: a null-policy write that NEWLY adds a bundleId to a marked row is refused", async () => {
  const h = freshLibsql();
  try {
    await upsertProvider(h.db, ravenRow({ gpuPolicy: { engine: ENGINE } }));
    await assert.rejects(upsertProvider(h.db, ravenRow({ bundleId: "halogen", gpuPolicy: null })), code("EXTERNAL_ENGINE_CONFLICT"));
    const row = await stored(h.db, "raven-flash-next");
    assert.equal(row.bundle_id, null);
    assert.deepEqual(policyOf(row).engine, ENGINE, "marker untouched");
  } finally { h.cleanup(); }
});

test("no one-step adoption: a registerModel-shaped native write over a marked row is refused; unmark-then-register works", async () => {
  const h = freshLibsql();
  try {
    await upsertProvider(h.db, ravenRow({ gpuPolicy: { engine: ENGINE } }));
    const native = { runtime: "native", catalogId: "x", quant: "Q4", port: 18200 };
    await assert.rejects(upsertProvider(h.db, ravenRow({ host: "local", gpuPolicy: native })), code("EXTERNAL_ENGINE_CONFLICT"));
    await upsertProvider(h.db, ravenRow({ gpuPolicy: {} })); // explicit unmark, its own write
    assert.equal(policyOf(await stored(h.db, "raven-flash-next")).engine, undefined);
    await upsertProvider(h.db, ravenRow({ host: "local", gpuPolicy: native }));
    assert.equal(policyOf(await stored(h.db, "raven-flash-next")).runtime, "native");
  } finally { h.cleanup(); }
});

test("the marking path ({...listProvidersAll row, gpuPolicy + engine}) passes; a spread re-enable of the marked row is a no-op", async () => {
  const h = freshLibsql();
  try {
    await upsertProvider(h.db, ravenRow());
    let row = (await listProvidersAll(h.db)).find((r) => r.id === "raven-flash-next");
    await upsertProvider(h.db, { ...row, gpuPolicy: { ...(row.gpuPolicy || {}), engine: ENGINE } });
    row = (await listProvidersAll(h.db)).find((r) => r.id === "raven-flash-next");
    assert.deepEqual(row.gpuPolicy.engine, ENGINE);
    assert.equal(row.host, "cloud", "host stays cloud (spec §2.1)");
    const r = await upsertProvider(h.db, { ...row, disabled: false });
    assert.equal(r.unchanged, true);
  } finally { h.cleanup(); }
});

// --- replicated contradictory / malformed rows keep accepting today's writes --

test("replicated contradictory row (marker + bundle): the tab's {...row, disabled:false} write passes", async () => {
  const h = freshLibsql();
  try {
    await seedRaw(h.db, { id: "rep-bundle", bundleId: "halogen", gpuPolicy: { engine: ENGINE }, disabled: 1 });
    const row = (await listProvidersAll(h.db)).find((r) => r.id === "rep-bundle");
    await upsertProvider(h.db, { ...row, disabled: false });
    assert.equal(Number((await stored(h.db, "rep-bundle")).disabled), 0);
  } finally { h.cleanup(); }
});

test("replicated contradictory and malformed rows: reenableProviderPreservingContent passes", async () => {
  const h = freshLibsql();
  try {
    await seedRaw(h.db, { id: "rep-native", gpuPolicy: { engine: ENGINE, runtime: "native" }, disabled: 1 });
    await seedRaw(h.db, { id: "rep-typo", gpuPolicy: { engine: { managed: "External", host: "raven" } }, disabled: 1 });
    assert.ok(await reenableProviderPreservingContent(h.db, "rep-native"));
    assert.ok(await reenableProviderPreservingContent(h.db, "rep-typo"));
    assert.equal(Number((await stored(h.db, "rep-native")).disabled), 0);
    assert.equal(Number((await stored(h.db, "rep-typo")).disabled), 0);
  } finally { h.cleanup(); }
});

test("replicated contradictory row: repairProviderHosts still repairs its host", async () => {
  const h = freshLibsql();
  try {
    // In repair scope: no bundle, no owner, written by THIS instance, host "local" but the IP is not ours.
    await seedRaw(h.db, { id: "rep-repair", host: "local", gpuPolicy: { engine: ENGINE, runtime: "native" }, instanceId: "own-instance" });
    const res = await repairProviderHosts(h.db, {
      ownInstanceId: "own-instance",
      ownAddrs: new Set(["localhost", "127.0.0.1", "::1", "10.0.0.237"]),
    });
    assert.deepEqual(res.changes.map((c) => c.id), ["rep-repair"]);
    assert.equal((await stored(h.db, "rep-repair")).host, "cloud");
  } finally { h.cleanup(); }
});

test("replicated contradictory row: the reconciler re-asserts it (same bundle, engine preserved) without failing", async () => {
  const h = freshLibsql({
    "rep-recon": { baseUrl: RAVEN, bundleId: "halogen", mutexGroup: "g", models: [{ id: "m" }] },
  });
  try {
    await seedRaw(h.db, { id: "rep-recon", bundleId: "halogen", gpuPolicy: { engine: ENGINE } });
    const res = await syncProvidersFromModelsJson(h.db, { ownAddrs: new Set(["localhost", "127.0.0.1", "::1", "10.0.0.126"]) });
    assert.equal(res.failed, 0);
    const p = policyOf(await stored(h.db, "rep-recon"));
    assert.equal(p.mutexGroup, "g");
    assert.deepEqual(p.engine, ENGINE);
  } finally { h.cleanup(); }
});

// --- reconciler: Q3 (engine preserved) and per-row isolation ------------------

test("Q3: the reconciler keeps a stored engine when it re-asserts a gpuPolicy", async () => {
  const h = freshLibsql({
    "raven-flash-next": { baseUrl: RAVEN, mutexGroup: "g", alwaysResident: false, models: [{ id: "flash-next" }] },
  });
  try {
    await upsertProvider(h.db, ravenRow({ gpuPolicy: { engine: ENGINE } }));
    const res = await syncProvidersFromModelsJson(h.db, { ownAddrs: new Set(["localhost", "127.0.0.1", "::1", "10.0.0.126"]) });
    assert.equal(res.failed, 0);
    const p = policyOf(await stored(h.db, "raven-flash-next"));
    assert.equal(p.mutexGroup, "g", "file content asserted");
    assert.deepEqual(p.engine, ENGINE, "marker survived the reconcile");
  } finally { h.cleanup(); }
});

test("reconciler isolation: one refused entry is logged and counted; the rest of the pass still runs", async () => {
  const h = freshLibsql({
    "raven-flash-next": { baseUrl: RAVEN, bundleId: "halogen", models: [{ id: "flash-next" }] }, // newly adds a bundle to a marked row
    "fx-loop": { baseUrl: "http://127.0.0.1:8011/v1", models: [{ id: "m" }] },
  });
  const warns = [];
  const origWarn = console.warn;
  console.warn = (m) => warns.push(String(m));
  try {
    await upsertProvider(h.db, ravenRow({ gpuPolicy: { engine: ENGINE } }));
    const res = await syncProvidersFromModelsJson(h.db, { ownAddrs: new Set(["localhost", "127.0.0.1", "::1", "10.0.0.126"]) });
    assert.equal(res.failed, 1);
    assert.ok(await stored(h.db, "fx-loop"), "the next entry was still seeded");
    assert.equal((await stored(h.db, "raven-flash-next")).bundle_id, null, "refused write left the row alone");
    assert.ok(warns.some((w) => w.includes("[providers-reconcile] raven-flash-next skipped: EXTERNAL_ENGINE_CONFLICT")), warns.join("\n"));
  } finally {
    console.warn = origWarn;
    h.cleanup();
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `export PATH=/home/kh0pp/.nvm/versions/node/v24.21.0/bin:$PATH && cd ~/crow-wt-external-engine && npm test -- tests/providers-external-engine-write.test.js`

Expected: FAIL. The refusal tests report "Missing expected rejection". The Q3 test fails because the engine was dropped. The isolation test fails because `res.failed` is `undefined`. The replicated-row tests pass already, since nothing validates yet.

- [ ] **Step 3: Implement the validation**

In `servers/shared/providers-db.js`, find:

```js
import { inferHost, repairHostDecision } from "./provider-host.js";
```

Replace it with:

```js
import { inferHost, repairHostDecision } from "./provider-host.js";
import { isExternalEngine, engineShapeError, externalEngineConflict } from "./provider-engine.js";
```

Directly above the `/**` doc comment that precedes `export async function upsertProvider`, insert:

```js
function engineWriteError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** Stored gpu_policy → object, or null (absent or corrupt — corrupt reads as "none"). */
function parseStoredPolicy(raw) {
  if (raw == null) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

/** Incoming gpu_policy (the upsert's already-stringified value) → { policy, malformed }. */
function parseIncomingPolicy(raw) {
  if (raw == null) return { policy: null, malformed: false };
  if (typeof raw === "object") return { policy: raw, malformed: Array.isArray(raw) };
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? { policy: v, malformed: false } : { policy: null, malformed: true };
  } catch { return { policy: null, malformed: true }; }
}

const nullish = (v) => (v === undefined ? null : v);

/**
 * External-engine write rules (spec 2026-09-23 §2.2, TRANSITION-ONLY after
 * review round 1). Replication writes rows directly — never through here — so
 * a contradictory or malformed marked row can already be stored. A write that
 * leaves engine / bundleId / runtime as stored must pass regardless (the tab's
 * re-enable, reenableProviderPreservingContent, repairProviderHosts and the
 * reconciler all spread the stored row back in). Only a write that CHANGES one
 * of them is judged, on the EFFECTIVE row: the upsert SQL COALESCEs a null
 * gpu_policy into the stored one, while bundle_id is always overwritten.
 */
function assertExternalEngineWrite({ incomingBundleId, incomingPolicyRaw, storedRow }) {
  const { policy: incoming, malformed } = parseIncomingPolicy(incomingPolicyRaw);
  if (malformed) throw engineWriteError("EXTERNAL_ENGINE_INVALID", "gpu_policy must be a JSON object");
  const storedPolicy = storedRow ? parseStoredPolicy(storedRow.gpu_policy) : null;
  const storedBundle = storedRow ? nullish(storedRow.bundle_id) : null;
  const effective = incoming ?? storedPolicy;
  const bundle = nullish(incomingBundleId);

  const changed =
    !canonicalJsonEqual(nullish(storedPolicy?.engine), nullish(effective?.engine))
    || String(storedBundle ?? "") !== String(bundle ?? "")
    || nullish(storedPolicy?.runtime) !== nullish(effective?.runtime);
  if (!changed) return;

  const shape = engineShapeError(effective?.engine);
  if (shape) throw engineWriteError("EXTERNAL_ENGINE_INVALID", shape);
  if (externalEngineConflict({ bundleId: bundle, gpuPolicy: effective })) {
    throw engineWriteError("EXTERNAL_ENGINE_CONFLICT",
      'an external engine (gpu_policy.engine.managed = "external") cannot also carry a bundleId or gpu_policy.runtime = "native"');
  }
  const orchestratable = (bundle != null && bundle !== "") || effective?.runtime === "native";
  if (isExternalEngine({ gpuPolicy: storedPolicy }) && !isExternalEngine({ gpuPolicy: effective }) && orchestratable) {
    throw engineWriteError("EXTERNAL_ENGINE_CONFLICT",
      "this row is an external engine; clear gpu_policy.engine in its own write before giving it a bundle or a native runtime");
  }
}
```

(`canonicalJsonEqual` is already defined above `upsertIsNoop` in this file. `canonicalJsonEqual(null, null)` is `true`.)

Inside `upsertProvider`, find:

```js
  const gpuPolicy = provider.gpuPolicy != null ? JSON.stringify(provider.gpuPolicy) : (provider.gpu_policy ?? null);

  if (existed && upsertIsNoop(rows[0], {
```

Replace it with:

```js
  const gpuPolicy = provider.gpuPolicy != null ? JSON.stringify(provider.gpuPolicy) : (provider.gpu_policy ?? null);

  assertExternalEngineWrite({
    incomingBundleId: provider.bundleId ?? provider.bundle_id ?? null,
    incomingPolicyRaw: gpuPolicy,
    storedRow: existed ? rows[0] : null,
  });

  if (existed && upsertIsNoop(rows[0], {
```

- [ ] **Step 4: Harden the reconciler (Q3 plus per-row isolation)**

In `syncProvidersFromModelsJson`, replace everything from `const counters = {` down to (but not including) `const rep = await repairProviderHosts(dbClient, { ownAddrs: addrs });` with:

```js
  const counters = { upserted: 0, unchanged: 0, skipped_disabled: 0, skipped_unowned: 0, reenabled: 0, repaired: 0, failed: 0 };
  const entries = config?.providers
    ? Object.entries(config.providers).filter(([id]) => !id.startsWith("$"))
    : [];

  const { rows: existingRows } = await dbClient.execute("SELECT id, disabled, gpu_policy FROM providers");
  const existing = new Map(existingRows.map((r) => [r.id, r]));

  for (const [id, p] of entries) {
    // Per-row isolation (external-engine review C2): one refused write — e.g.
    // a models.json entry that would newly give a marked external engine a
    // bundle — must not abort the rest of the pass or the host repair below.
    try {
      const cur = existing.get(id);
      const decision = reconcileDecision({
        owned: isLocallyOrchestratable({ baseUrl: p.baseUrl }, addrs),
        present: cur !== undefined,
        disabled: cur !== undefined && !!Number(cur.disabled),
        force,
      });
      if (decision === "skip_disabled") { counters.skipped_disabled++; continue; }
      if (decision === "skip_unowned") { counters.skipped_unowned++; continue; }
      if (decision === "reenable") {
        const res = await reenableProviderPreservingContent(dbClient, id);
        if (res) counters.reenabled++;
        continue;
      }
      // "seed" | "assert" — full assert from the file entry.
      let gpuPolicy = (p.mutexGroup || p.alwaysResident || p.defaultMember)
        ? { mutexGroup: p.mutexGroup ?? null, alwaysResident: !!p.alwaysResident, defaultMember: !!p.defaultMember }
        : null;
      // Q3: models.json knows nothing of external engines — never let a
      // re-assert drop a stored marker. (A null gpuPolicy already keeps the
      // stored one via the upsert's COALESCE.)
      const storedEngine = cur ? parseStoredPolicy(cur.gpu_policy)?.engine : undefined;
      if (gpuPolicy && storedEngine != null) gpuPolicy = { ...gpuPolicy, engine: storedEngine };
      const res = await upsertProvider(dbClient, {
        id,
        baseUrl: p.baseUrl || "",
        apiKey: p.apiKey ?? null,
        host: inferHost(p.baseUrl, p.host, { ownAddrs: addrs }),
        bundleId: p.bundleId ?? null,
        description: p.$description || p.description || null,
        models: p.models || [],
        disabled: false,
        providerType: inferProviderType(p.api) || p.providerType || null,
        gpuPolicy,
      });
      if (res.unchanged) counters.unchanged++;
      else counters.upserted++;
    } catch (err) {
      counters.failed++;
      console.warn(`[providers-reconcile] ${id} skipped: ${err?.code ? err.code + ": " : ""}${err?.message ?? err}`);
    }
  }
```

Then update the function's JSDoc `@returns` line so that it lists `failed: number` next to `repaired: number`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `export PATH=/home/kh0pp/.nvm/versions/node/v24.21.0/bin:$PATH && cd ~/crow-wt-external-engine && npm test -- tests/providers-external-engine-write.test.js tests/providers-upsert-noop.test.js tests/providers-war-sim.test.js tests/providers-host-inference.test.js tests/providers-reconcile-gate.test.js tests/providers-host-repair.test.js tests/providers-host-repair-sim.test.js tests/models-registration.test.js tests/sync-emit-sites.test.js`

Expected: PASS, 0 failures.

- [ ] **Step 6: Commit**

```bash
cd ~/crow-wt-external-engine
git add tests/providers-external-engine-write.test.js
git commit servers/shared/providers-db.js tests/providers-external-engine-write.test.js -m "feat(providers): transition-only external-engine write validation; reconciler keeps the marker and isolates rows"
git show --stat HEAD
```

---

### Task 3: `external` health map + read-only poll + boot arming (D3)

**Files:**
- Modify: `servers/gateway/provider-health.js`
- Create: `servers/gateway/external-engine-poll.js`
- Modify: `servers/gateway/gpu-orchestrator.js` (`initOrchestrator`, plus one import)
- Modify: `scripts/run-suite.mjs` (scratch env block)
- Test: `tests/provider-health.test.js`, `tests/external-engine-poll.test.js` (create)

**Interfaces:**
- Consumes: `isExternalEngine` and `externalEngineInfo` (Task 1).
- Produces (Tasks 4 and 5 read these):
  - `recordExternal(name, { ready, nowMs, baseUrl, engineHost = null, label = null, error = null })`.
  - `pruneExternal(liveNames: string[] | Set<string>)`.
  - `getProviderHealth().external: Record<name, { baseUrl, engineHost, label, ready, firstSeenAt, lastReadyAt, lastError, checkedAt }>`.
  - From `external-engine-poll.js`:
    - `EXTERNAL_ENGINE_PROBE_TIMEOUT_MS = 3000` and `DEFAULT_EXTERNAL_ENGINE_POLL_MS = 60000`.
    - `externalEnginePollMs(env?) -> number`.
    - `externalModelsUrl(baseUrl) -> string|null`.
    - `probeExternalEngine(baseUrl, { fetchImpl, timeoutMs }) -> Promise<{ ready, error }>`.
    - `pollExternalEngines({ cfg?, fetchImpl?, now?, timeoutMs? }) -> Promise<string[]>`. It never throws, and it is a no-op unless `cfg._source === "db:providers"`.
    - `DB_PROVIDERS_SOURCE = "db:providers"`.
    - `startExternalEngineMonitor({ intervalMs?, poll? }) -> boolean` and `_stopExternalEngineMonitor()`.

- [ ] **Step 1: Write the failing provider-health tests**

Extend the import at the top of `tests/provider-health.test.js` with `recordExternal, pruneExternal`. The import becomes:

```js
import {
  setResidencyInitialized, recordResidency, releaseResidency,
  pruneResidency, getProviderHealth, _resetProviderHealth,
  recordExternal, pruneExternal,
} from "../servers/gateway/provider-health.js";
```

Append to the END of the file:

```js
// --- external engines (spec 2026-09-23 external-engine-provider §2.3) -------

const RAVEN = "http://10.0.0.126:8030/v1";
const ext = (ready, nowMs, extra = {}) =>
  recordExternal("raven-flash-next", { ready, nowMs, baseUrl: RAVEN, engineHost: "raven", label: "halogen", ...extra });

test("recordExternal: first sight stamps firstSeenAt with lastReadyAt null; fields as specified", () => {
  _resetProviderHealth();
  ext(false, 1000, { error: new Error("ECONNREFUSED") });
  const e = getProviderHealth().external["raven-flash-next"];
  assert.deepEqual(e, {
    baseUrl: RAVEN, engineHost: "raven", label: "halogen",
    ready: false, firstSeenAt: 1000, lastReadyAt: null, lastError: "ECONNREFUSED", checkedAt: 1000,
  });
});

test("recordExternal: ready stamps lastReadyAt + clears lastError; a later not-ready keeps both clocks", () => {
  _resetProviderHealth();
  ext(false, 1000, { error: "down" });
  ext(true, 2000);
  ext(false, 9000, { error: "http 503" });
  const e = getProviderHealth().external["raven-flash-next"];
  assert.equal(e.firstSeenAt, 1000);
  assert.equal(e.lastReadyAt, 2000);
  assert.equal(e.ready, false);
  assert.equal(e.lastError, "http 503");
  assert.equal(e.checkedAt, 9000);
});

test("recordExternal: a changed baseUrl starts a fresh entry — no inherited 'was ready'", () => {
  _resetProviderHealth();
  ext(true, 1000);
  ext(false, 5000, { baseUrl: "http://10.0.0.127:8030/v1" });
  const e = getProviderHealth().external["raven-flash-next"];
  assert.equal(e.baseUrl, "http://10.0.0.127:8030/v1");
  assert.equal(e.firstSeenAt, 5000);
  assert.equal(e.lastReadyAt, null);
});

test("pruneExternal drops only names not passed (array and Set); the residency map is untouched", () => {
  _resetProviderHealth();
  recordResidency("crow-voice", { ready: true, nowMs: 1, baseUrl: "u" });
  recordExternal("a", { ready: true, nowMs: 1, baseUrl: "u" });
  recordExternal("b", { ready: true, nowMs: 1, baseUrl: "u" });
  pruneExternal(["a"]);
  assert.ok(getProviderHealth().external.a);
  assert.equal(getProviderHealth().external.b, undefined);
  pruneExternal(new Set());
  assert.deepEqual(getProviderHealth().external, {});
  assert.ok(getProviderHealth().providers["crow-voice"], "residency map is a separate map");
  pruneResidency([]);
  assert.deepEqual(getProviderHealth().providers, {});
});

test("getProviderHealth copies the external map too; _resetProviderHealth clears it", () => {
  _resetProviderHealth();
  ext(true, 1);
  const first = getProviderHealth();
  first.external["raven-flash-next"].ready = false;
  delete first.external["raven-flash-next"];
  assert.equal(getProviderHealth().external["raven-flash-next"].ready, true);
  _resetProviderHealth();
  assert.deepEqual(getProviderHealth().external, {});
});
```

- [ ] **Step 2: Write the failing poll tests**

Create `tests/external-engine-poll.test.js`:

```js
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `export PATH=/home/kh0pp/.nvm/versions/node/v24.21.0/bin:$PATH && cd ~/crow-wt-external-engine && npm test -- tests/provider-health.test.js tests/external-engine-poll.test.js`

Expected: FAIL.
- `provider-health.test.js` does not load ("does not provide an export named 'recordExternal'").
- `external-engine-poll.test.js` does not load (`Cannot find module`).

- [ ] **Step 4: Add the external map to `provider-health.js`**

In `servers/gateway/provider-health.js`, replace:

```js
const INITIAL = () => ({
  initialized: false,
  providers: Object.create(null),
});
```

with:

```js
const INITIAL = () => ({
  initialized: false,
  providers: Object.create(null),
  external: Object.create(null),
});
```

Replace the whole `getProviderHealth` function with:

```js
/** Read a copy safe to mutate — mutating it does not touch module state. */
export function getProviderHealth() {
  const providers = {};
  for (const name of Object.keys(_state.providers)) {
    providers[name] = { ..._state.providers[name] };
  }
  const external = {};
  for (const name of Object.keys(_state.external)) {
    external[name] = { ..._state.external[name] };
  }
  return { initialized: _state.initialized, providers, external };
}
```

Directly above the `/** Test hook — restore the initial shape` comment, insert:

```js
/*
 * External engines (spec docs/superpowers/specs/2026-09-23-external-engine-provider-design.md §2.3)
 * — a SEPARATE map, written by external-engine-poll.js. An external engine is
 * never "owned": this instance only watches it from its own network position.
 *
 *   firstSeenAt  stamped once, on first probe (or after a baseUrl change)
 *   lastReadyAt  last 2xx; null = has NEVER answered in this process — the
 *                nest signal shows that as info, never warn (a firewalled
 *                peer like black-swan must not carry a permanent warning)
 */
export function recordExternal(name, { ready, nowMs, baseUrl, engineHost = null, label = null, error = null } = {}) {
  let e = _state.external[name];
  if (e && e.baseUrl !== baseUrl) {
    delete _state.external[name]; // repointed: a fresh engine, fresh clocks
    e = undefined;
  }
  if (!e) {
    e = _state.external[name] = {
      baseUrl,
      engineHost,
      label,
      ready: false,
      firstSeenAt: nowMs,
      lastReadyAt: null,
      lastError: null,
      checkedAt: nowMs,
    };
  }
  e.engineHost = engineHost;
  e.label = label;
  e.ready = !!ready;
  e.checkedAt = nowMs;
  if (ready) {
    e.lastReadyAt = nowMs;
    e.lastError = null;
  } else {
    e.lastError = error != null ? (error?.message ?? String(error)) : null;
  }
}

/** Drop external entries whose name is not in liveNames (array or Set). */
export function pruneExternal(liveNames) {
  const live = liveNames instanceof Set ? liveNames : new Set(liveNames);
  for (const name of Object.keys(_state.external)) {
    if (!live.has(name)) delete _state.external[name];
  }
}
```

- [ ] **Step 5: Create the poll module**

Create `servers/gateway/external-engine-poll.js`:

```js
/**
 * External-engine poll (spec docs/superpowers/specs/2026-09-23-external-engine-provider-design.md §2.3).
 *
 * Every CROW_EXTERNAL_ENGINE_POLL_MS (default 60 s; <= 0 disables), for every
 * ENABLED provider row marked gpu_policy.engine.managed === "external":
 * GET <base_url>/models — no auth header, 3 s timeout, 2xx = ready — and
 * record the result in provider-health.js's `external` map.
 *
 * READ-ONLY by construction: one GET per engine per tick, no retry within a
 * tick, and nothing ever reacts to the result (no start, no route-away).
 * pi-lab cleared it for any time, windows included (spec §2.6).
 *
 * PER INSTANCE: each instance probes from its own network position; a peer
 * the firewall keeps off the engine's LAN reports its own truth.
 *
 * Armed by initOrchestrator() right after the residency monitor. The scratch
 * test suite sets CROW_EXTERNAL_ENGINE_POLL_MS=0 (scripts/run-suite.mjs).
 */
import { loadProviders } from "../shared/providers.js";
import { isExternalEngine, externalEngineInfo } from "../shared/provider-engine.js";
import { recordExternal, pruneExternal } from "./provider-health.js";

export const EXTERNAL_ENGINE_PROBE_TIMEOUT_MS = 3_000;
export const DEFAULT_EXTERNAL_ENGINE_POLL_MS = 60_000;
/** The `_source` loadProvidersFromDb() sets. Anything else is the models.json
 *  fallback loadProviders() serves while its cache is null or the DB read
 *  fails — it carries no markers, so trusting it would prune every clock. */
export const DB_PROVIDERS_SOURCE = "db:providers";

let _timer = null;
let _inFlight = false;
let _failing = false; // edge-trigger for the poll's failure warn

/** Interval from env; unset/empty/non-numeric → the 60 s default. */
export function externalEnginePollMs(env = process.env) {
  const raw = env.CROW_EXTERNAL_ENGINE_POLL_MS;
  if (raw === undefined || raw === "") return DEFAULT_EXTERNAL_ENGINE_POLL_MS;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_EXTERNAL_ENGINE_POLL_MS;
}

/** `<base_url>/models` for an http(s) base_url, else null (never fetched). */
export function externalModelsUrl(baseUrl) {
  let u;
  try { u = new URL(String(baseUrl)); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  return String(baseUrl).replace(/\/+$/, "") + "/models";
}

/**
 * One read-only probe. Never throws. The timeout is enforced by a race as
 * well as the abort signal, so a fetch that ignores the signal still cannot
 * hold the tick open past `timeoutMs`.
 */
export async function probeExternalEngine(baseUrl, {
  fetchImpl = globalThis.fetch,
  timeoutMs = EXTERNAL_ENGINE_PROBE_TIMEOUT_MS,
} = {}) {
  const url = externalModelsUrl(baseUrl);
  if (!url) return { ready: false, error: "unsupported base_url" };
  const ac = new AbortController();
  let timer = null;
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new Error(`timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    // Deliberately NO headers: the engine has no auth (spec §3) and a row's
    // api_key must never be sent to a LAN box on a timer.
    const res = await Promise.race([fetchImpl(url, { method: "GET", signal: ac.signal }), timedOut]);
    // Fire-and-forget: releasing the body must never extend the tick past the race.
    try { res?.body?.cancel?.()?.catch?.(() => {}); } catch { /* the body is irrelevant */ }
    if (res && res.ok) return { ready: true, error: null };
    return { ready: false, error: `http ${res?.status ?? "?"}` };
  } catch (err) {
    return { ready: false, error: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One tick. Returns the names probed. MUST NEVER THROW (the interval relies
 * on it). Probes AND prunes only when the config came from the DB
 * (review round 1, C1): after invalidateProvidersCache() or a DB error,
 * loadProviders() serves the models.json fallback — non-empty, no markers —
 * and pruning on it would wipe every ready-once clock. Such a tick is a no-op.
 */
export async function pollExternalEngines(opts = {}) {
  const probed = [];
  try {
    const cfg = opts.cfg !== undefined ? opts.cfg : loadProviders();
    if (cfg?._source !== DB_PROVIDERS_SOURCE) return probed;
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    const now = opts.now || Date.now;
    const timeoutMs = opts.timeoutMs ?? EXTERNAL_ENGINE_PROBE_TIMEOUT_MS;
    const providers = cfg.providers || {};
    const targets = Object.entries(providers).filter(([, p]) => p && !p.disabled && isExternalEngine(p));
    const results = await Promise.all(targets.map(async ([name, p]) => ({
      name, p, r: await probeExternalEngine(p.baseUrl, { fetchImpl, timeoutMs }),
    })));
    for (const { name, p, r } of results) {
      const info = externalEngineInfo(p);
      recordExternal(name, {
        ready: r.ready, nowMs: now(), baseUrl: p.baseUrl,
        engineHost: info.host, label: info.label, error: r.error,
      });
      probed.push(name);
    }
    pruneExternal(targets.map(([n]) => n)); // DB-sourced: an absent/disabled row really is gone
  } catch (err) {
    if (!_failing) {
      _failing = true;
      console.warn(`[external-engines] poll failed: ${err.message}`);
    }
    return probed;
  }
  _failing = false;
  return probed;
}

/**
 * Arm the poll: one tick now, then every `intervalMs`. Idempotent, in-flight
 * guarded, unref'd. Returns true when armed by THIS call.
 */
export function startExternalEngineMonitor({ intervalMs = externalEnginePollMs(), poll = pollExternalEngines } = {}) {
  if (_timer) return false;
  if (!(intervalMs > 0) || !Number.isFinite(intervalMs)) {
    console.log("[external-engines] read-only poll disabled (CROW_EXTERNAL_ENGINE_POLL_MS <= 0)");
    return false;
  }
  const tick = () => {
    if (_inFlight) return;
    _inFlight = true;
    Promise.resolve()
      .then(() => poll())
      .catch(() => {})
      .finally(() => { _inFlight = false; });
  };
  tick();
  _timer = setInterval(() => {
    try { tick(); } catch {}
  }, intervalMs);
  _timer.unref?.();
  console.log(`[external-engines] read-only poll armed: every ${intervalMs}ms`);
  return true;
}

/** Test hook — clear the interval so the suite never leaks it. */
export function _stopExternalEngineMonitor() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  _inFlight = false;
  _failing = false;
}
```

- [ ] **Step 6: Arm it at boot, and disable it in the scratch suite**

In `servers/gateway/gpu-orchestrator.js`, find:

```js
import { isExternalEngine, externalEngineInfo, ExternalEngineError } from "../shared/provider-engine.js";
```

Replace it with:

```js
import { isExternalEngine, externalEngineInfo, ExternalEngineError } from "../shared/provider-engine.js";
import { startExternalEngineMonitor } from "./external-engine-poll.js";
```

In `initOrchestrator`, find:

```js
  setResidencyInitialized();
  startResidencyMonitor();
```

Replace it with:

```js
  setResidencyInitialized();
  startResidencyMonitor();
  // External engines (spec 2026-09-23 §2.3): read-only GET /models every
  // CROW_EXTERNAL_ENGINE_POLL_MS (default 60 s). Armed here, before anything
  // that can throw, for the same reason as the residency monitor.
  try {
    startExternalEngineMonitor();
  } catch (err) {
    console.warn(`[gpu-orchestrator] external-engine poll not armed: ${err.message}`);
  }
```

In `scripts/run-suite.mjs`, find:

```js
env.CROW_DISABLE_PERCH = "1";
```

Replace it with:

```js
env.CROW_DISABLE_PERCH = "1";
// External-engine poll (spec 2026-09-23 §2.3): a scratch suite gateway must
// never send its 60 s read-only probe from the test runner. Unit tests drive
// pollExternalEngines/startExternalEngineMonitor through their own seams.
env.CROW_EXTERNAL_ENGINE_POLL_MS = "0";
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `export PATH=/home/kh0pp/.nvm/versions/node/v24.21.0/bin:$PATH && cd ~/crow-wt-external-engine && npm test -- tests/provider-health.test.js tests/external-engine-poll.test.js tests/gpu-orchestrator-residency-poll.test.js tests/gpu-orchestrator-native.test.js tests/providers-health-signal.test.js`

Expected: PASS, 0 failures. `providers-health-signal` must stay green because the new `external` field is empty by default.

- [ ] **Step 8: Commit**

```bash
cd ~/crow-wt-external-engine
git add servers/gateway/external-engine-poll.js tests/external-engine-poll.test.js
git commit servers/gateway/provider-health.js servers/gateway/external-engine-poll.js servers/gateway/gpu-orchestrator.js scripts/run-suite.mjs tests/provider-health.test.js tests/external-engine-poll.test.js -m "feat(providers): read-only external-engine poll, armed beside the residency monitor"
git show --stat HEAD
```

---

### Task 4: Nest `providersSignal` shows external engines, at info only (D4, nest)

**Files:**
- Modify: `servers/gateway/dashboard/panels/nest/health-signals.js`: the i18n import at :27, the header comment, and `providersSignal` at :704.
- Modify: `servers/gateway/dashboard/shared/i18n.js`: after `"signals.providers.action"`.
- Test: `tests/providers-health-signal.test.js`

**Interfaces:**
- Consumes:
  - `getProviderHealth().external` and `recordExternal` (Task 3);
  - `fill` from `i18n.js` (already exported).
- Produces: the same signal object shape `{ id: "providers", severity, state, label, value, issueLabel?, actionLabel?, actionHref? }`. `state` can now also be `"info"`.

Rules (review round 1, C3):
- External engines **never** produce a warn, and so never a health-monitor push.
- Each engine contributes one line:
  - `"<label> on <host>: up"`;
  - `"<label> on <host>: down for <age> (externally managed)"` if it answered at least once in this process;
  - `"<label> on <host>: not reachable from this instance"` if it never did.
- If any external engine is not up, and no resident model is in warn, the signal is `info`. Its issue label joins the not-up lines with `"; "`.
- If a resident model is in warn, the signal returns exactly today's warn object, byte for byte, and the external lines are not added.
- If there are no resident entries and no external entries, the signal is `off` as today.

- [ ] **Step 1: Write the failing tests**

In `tests/providers-health-signal.test.js`, change the provider-health import to:

```js
import {
  setResidencyInitialized, recordResidency, recordExternal, _resetProviderHealth,
} from "../servers/gateway/provider-health.js";
```

Append to the END of the file:

```js
// --- external engines (spec 2026-09-23 external-engine-provider §2.4, as
// revised in review round 1: info only, NEVER warn — raven's prod windows stop
// halogen for hours by design, and a nest warn is a high-priority push) -------

const RAVEN = "http://10.0.0.126:8030/v1";
function ext(ready, nowMs, extra = {}) {
  recordExternal("raven-flash-next", { ready, nowMs, baseUrl: RAVEN, engineHost: "raven", label: "halogen", ...extra });
}
const HOUR = 60 * MIN;

test("external only, up → ok, no issue, value 'halogen on raven: up'", async () => {
  _resetProviderHealth();
  setResidencyInitialized();
  ext(true, NOW);
  const { detail, issue } = await providers({ now: at(NOW) });
  assert.equal(detail.state, "ok");
  assert.equal(issue, undefined);
  assert.equal(detail.value, "halogen on raven: up");
});

test("never answered in this process → INFO 'not reachable from this instance', never warn, nest stays ok", async () => {
  _resetProviderHealth();
  setResidencyInitialized();
  ext(false, NOW, { error: "timeout after 3000ms" });
  const { detail, issue, all } = await providers({ now: at(NOW + 10 * HOUR) });
  assert.equal(detail.state, "info");
  assert.equal(issue.severity, "info");
  assert.equal(issue.label, "halogen on raven: not reachable from this instance");
  assert.equal(all.ok, true);
});

test("answered once, then down for HOURS → still info (never warn): 'down for 10h (externally managed)'", async () => {
  _resetProviderHealth();
  setResidencyInitialized();
  ext(true, NOW);
  ext(false, NOW + MIN);
  const { detail, issue, all } = await providers({ now: at(NOW + 10 * HOUR) });
  assert.equal(detail.state, "info");
  assert.equal(issue.severity, "info");
  assert.equal(issue.label, "halogen on raven: down for 10h (externally managed)");
  assert.equal(all.ok, true);
  assert.equal(all.issues.filter((i) => i.severity === "warn").length, 0, "nothing the health monitor would push");
});

test("down for under a minute reads '<1m', never 'now'", async () => {
  _resetProviderHealth();
  setResidencyInitialized();
  ext(true, NOW);
  ext(false, NOW + 1000);
  const { detail } = await providers({ now: at(NOW + 20_000) });
  assert.match(detail.value, /down for <1m \(externally managed\)/);
});

test("a resident-model warn is byte-identical with or without an external engine down", async () => {
  _resetProviderHealth();
  setResidencyInitialized();
  recordResidency("crow-voice", { ready: false, nowMs: NOW, baseUrl: "http://x:8011/v1", embed: false });
  const alone = (await providers({ now: at(NOW + THRESHOLD + MIN) })).all.issues.find((i) => i.id === "providers");

  _resetProviderHealth();
  setResidencyInitialized();
  recordResidency("crow-voice", { ready: false, nowMs: NOW, baseUrl: "http://x:8011/v1", embed: false });
  ext(true, NOW);
  ext(false, NOW + MIN);
  const r = await providers({ now: at(NOW + THRESHOLD + MIN) });
  const withExt = r.all.issues.find((i) => i.id === "providers");
  assert.deepEqual(withExt, alone);
  assert.equal(r.detail.state, "warn");
  assert.equal(r.all.issues.filter((i) => i.id === "providers").length, 1);
});

test("resident ok + an external engine not reachable → info; value carries both parts", async () => {
  _resetProviderHealth();
  setResidencyInitialized();
  recordResidency("crow-voice", { ready: true, nowMs: NOW, baseUrl: "http://x:8011/v1", embed: false });
  ext(false, NOW);
  const { detail } = await providers({ now: at(NOW) });
  assert.equal(detail.state, "info");
  assert.equal(detail.value, "1 resident · halogen on raven: not reachable from this instance");
});

test("free-text label/host render verbatim through fill() — '$&' is not a replacement pattern", async () => {
  _resetProviderHealth();
  setResidencyInitialized();
  recordExternal("raven-flash-next", { ready: true, nowMs: NOW, baseUrl: RAVEN, engineHost: "r$&n", label: "h$'x" });
  const { detail } = await providers({ now: at(NOW) });
  assert.equal(detail.value, "h$'x on r$&n: up");
});

test("Spanish: the info copy is translated and still names engine + host", async () => {
  _resetProviderHealth();
  setResidencyInitialized();
  ext(false, NOW);
  invalidateHealthCache();
  _resetReceiveHealth();
  const r = await collectHealthSignals(db, { now: at(NOW), lang: "es" });
  const issue = r.issues.find((i) => i.id === "providers");
  assert.equal(issue.severity, "info");
  assert.match(issue.label, /halogen en raven: no accesible desde esta instancia/);
});

test("EN and ES render for the 3 new external-engine keys", () => {
  const keys = [
    "signals.providers.externalUp",
    "signals.providers.externalDownFor",
    "signals.providers.externalUnreachable",
  ];
  for (const key of keys) {
    for (const lang of ["en", "es"]) assert.notEqual(t(key, lang), key, `missing i18n for ${key} (${lang})`);
    assert.notEqual(t(key, "es"), t(key, "en"), `${key}: es must be a real translation`);
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `export PATH=/home/kh0pp/.nvm/versions/node/v24.21.0/bin:$PATH && cd ~/crow-wt-external-engine && npm test -- tests/providers-health-signal.test.js`

Expected: FAIL. The new external tests fail: for example, "external only, up" gets state `off` and a different value, and the i18n test reports missing keys. All pre-existing tests still pass.

- [ ] **Step 3: Add the i18n keys**

In `servers/gateway/dashboard/shared/i18n.js`, find:

```js
  "signals.providers.action": { en: "Open model health", es: "Ver estado de modelos" },
```

Replace it with:

```js
  "signals.providers.action": { en: "Open model health", es: "Ver estado de modelos" },
  // External engines (spec 2026-09-23 external-engine-provider §2.4) — info only, never warn
  "signals.providers.externalUp": { en: "{label} on {host}: up", es: "{label} en {host}: activo" },
  "signals.providers.externalDownFor": { en: "{label} on {host}: down for {age} (externally managed)", es: "{label} en {host}: caído desde hace {age} (gestionado externamente)" },
  "signals.providers.externalUnreachable": { en: "{label} on {host}: not reachable from this instance", es: "{label} en {host}: no accesible desde esta instancia" },
```

- [ ] **Step 4: Rewrite `providersSignal`**

In `servers/gateway/dashboard/panels/nest/health-signals.js`, change the import:

```js
import { t } from "../../shared/i18n.js";
```

to:

```js
import { t, fill } from "../../shared/i18n.js";
```

In the header comment, replace the line:

```
 *   providers — alwaysResident provider residency (unreachable ≥threshold → warn)
```

with:

```
 *   providers — alwaysResident provider residency (unreachable ≥threshold → warn)
 *               + external engines (info only — never warn, never a push)
```

Replace the whole `async function providersSignal(lang, nowFn) { … }` with the version below. Everything up to and including the `if (down.length > 0) { … return warn }` block is today's code unchanged, except for the widened `off` check:

```js
async function providersSignal(lang, nowFn) {
  const health = getProviderHealth();
  const label = t("signals.providers.label", lang);
  const action = {
    actionLabel: t("signals.providers.action", lang),
    actionHref: "/dashboard/settings?section=llm&tab=health",
  };

  if (!health.initialized) {
    return { id: "providers", severity: null, state: "off", label, value: t("signals.providers.notStarted", lang) };
  }
  const names = Object.keys(health.providers);
  const external = health.external || {};
  const extNames = Object.keys(external);
  if (names.length === 0 && extNames.length === 0) {
    return { id: "providers", severity: null, state: "off", label, value: t("signals.providers.off", lang) };
  }

  const now = nowFn();
  const threshold = notReadyWarnMs();
  const down = [];
  let readyCount = 0;
  let warmingCount = 0;
  for (const name of names) {
    const p = health.providers[name];
    if (p.ready) { readyCount++; continue; }
    const origin = p.lastReadyAt ?? p.firstOwnedAt;
    if (now - origin >= threshold) {
      down.push({ name, embed: !!p.embed, age: formatAge(now - origin) });
    } else {
      warmingCount++;
    }
  }

  if (down.length > 0) {
    const value = down.length === 1
      ? t("signals.providers.down", lang).replace("{name}", down[0].name).replace("{age}", down[0].age)
      : t("signals.providers.downMulti", lang).replace("{n}", String(down.length));

    // Always NAME the provider when exactly one is down — this string becomes the
    // notification title (post-listen.js sets title: issue.label). The embed-vs-voice
    // split is derived from the provider's own embed flag, never hardcoded: crow only
    // ever owns crow-voice, which carries no embed model.
    let issueLabel;
    if (down.length === 1) {
      const key = down[0].embed ? "signals.providers.downIssueEmbed" : "signals.providers.downIssue";
      issueLabel = t(key, lang).replace("{name}", down[0].name);
    } else {
      issueLabel = t("signals.providers.downIssueMulti", lang)
        .replace("{n}", String(down.length))
        .replace("{names}", down.map(d => d.name).join(", "));
    }
    return { id: "providers", severity: "warn", state: "warn", label, value, issueLabel, ...action };
  }

  const parts = [];
  if (names.length > 0) {
    parts.push(t("signals.providers.resident", lang).replace("{n}", String(readyCount)));
    if (warmingCount > 0) {
      parts.push(t("signals.providers.warming", lang).replace("{n}", String(warmingCount)));
    }
  }

  // External engines (spec 2026-09-23 §2.4, revised in review round 1): INFO
  // ONLY, NEVER WARN. They are operated from outside Crow — raven's prod
  // windows stop halogen for hours by design — and a warn here becomes a
  // high-priority push via the health monitor. Labels/hosts are free text
  // replicated from peers: fill() (no $-pattern mangling); the nest escapes HTML.
  const notUp = [];
  for (const name of extNames) {
    const e = external[name];
    const vars = { label: e.label || name, host: e.engineHost || "?" };
    if (e.ready) {
      parts.push(fill(t("signals.providers.externalUp", lang), vars));
      continue;
    }
    let line;
    if (e.lastReadyAt != null) {
      const age = formatAge(now - e.lastReadyAt);
      line = fill(t("signals.providers.externalDownFor", lang), { ...vars, age: age === "now" ? "<1m" : age });
    } else {
      line = fill(t("signals.providers.externalUnreachable", lang), vars);
    }
    parts.push(line);
    notUp.push(line);
  }

  if (notUp.length > 0) {
    return { id: "providers", severity: "info", state: "info", label, value: parts.join(" · "), issueLabel: notUp.join("; "), ...action };
  }
  return { id: "providers", severity: null, state: "ok", label, value: parts.join(" · ") };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `export PATH=/home/kh0pp/.nvm/versions/node/v24.21.0/bin:$PATH && cd ~/crow-wt-external-engine && npm test -- tests/providers-health-signal.test.js tests/i18n-global-parity.test.js tests/messages-health-signal.test.js`

Expected: PASS, 0 failures. The pre-existing residency tests, together with the byte-identical test, prove the resident-model warn path is unchanged.

- [ ] **Step 6: Commit**

```bash
cd ~/crow-wt-external-engine
git commit servers/gateway/dashboard/panels/nest/health-signals.js servers/gateway/dashboard/shared/i18n.js tests/providers-health-signal.test.js -m "feat(nest): providers signal lists external engines at info severity only (never a push)"
git show --stat HEAD
```

---

### Task 5: Providers tab — reachability dot + "external · host" badge (D4, tab)

**Files:**
- Modify: `servers/gateway/dashboard/settings/sections/llm/providers-tab.js`
- Modify: `servers/gateway/dashboard/shared/i18n.js` (after `"settings.pageTitle"`)
- Test: `tests/providers-tab-host-badge.test.js`

**Interfaces:**
- Consumes: `isExternalEngine` and `externalEngineInfo` (Task 1); `getProviderHealth().external` (Task 3).
- Produces:
  - `engineBadge(p, lang = "en") -> string`. It returns an HTML span, or `""` for an unmarked row.
  - `statusDot(p, { external, lang = "en" }) -> string`. It returns the `●` span.
  - `render({ db, lang })`, which already receives `lang` from `llm.js`.

The dot does the following:
- A disabled row keeps the existing muted "disabled (soft-delete)" dot.
- An unmarked row keeps the existing green "enabled" dot.
- A marked row takes its dot from `external[p.id]`:
  - with no entry, or an entry whose `baseUrl` differs from the row's → muted, "not probed yet";
  - `ready` → green, "reachable";
  - otherwise → `var(--crow-error)`, "not reachable from this instance".

- [ ] **Step 1: Write the failing tests**

Replace the contents of `tests/providers-tab-host-badge.test.js` with:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { hostBadge, engineBadge, statusDot } from "../servers/gateway/dashboard/settings/sections/llm/providers-tab.js";

const ctx = {
  ownAddrs: new Set(["127.0.0.1", "::1", "localhost", "100.118.41.122"]),
  ownInstanceId: "0867ac2809dedd885ba7769b21966f8e",
  instanceNames: new Map(),
};

test("hostBadge renders the honest label and escapes it", () => {
  assert.match(hostBadge({ host: "cloud", baseUrl: "http://10.0.0.126:8030/v1", provider_type: "openai-compat" }, ctx), />network</);
  assert.match(hostBadge({ host: "cloud", baseUrl: "https://api.together.xyz/v1", provider_type: "openai-compat" }, ctx), />cloud · openai-compat</);
  assert.match(hostBadge({ host: "local", baseUrl: "http://100.118.41.122:8003/v1" }, ctx), />this machine</);
  assert.match(hostBadge({ host: "<b>x", baseUrl: "http://10.0.0.1/v1" }, ctx), /&lt;b&gt;x/);
});

// --- external engines (spec 2026-09-23 external-engine-provider §2.4) -------

const ENGINE = { managed: "external", host: "raven", label: "halogen" };
const RAVEN = "http://10.0.0.126:8030/v1";
const row = (extra = {}) => ({ id: "raven-flash-next", baseUrl: RAVEN, host: "cloud", disabled: false, gpuPolicy: { engine: ENGINE }, ...extra });

test("engineBadge: 'external · <host>' for a marked row (en + es), nothing for an unmarked one", () => {
  assert.equal(engineBadge({ gpuPolicy: null }), "");
  assert.equal(engineBadge({ gpuPolicy: { runtime: "native" } }), "");
  assert.match(engineBadge(row()), />external · raven</);
  assert.match(engineBadge(row(), "es"), />externo · raven</);
  assert.match(engineBadge(row()), /title="halogen"/);
});

test("engineBadge escapes free-text host and label replicated from a peer", () => {
  const evil = engineBadge(row({ gpuPolicy: { engine: { managed: "external", host: "<img src=x onerror=alert(1)>", label: "\"><script>" } } }));
  assert.doesNotMatch(evil, /<img/);
  assert.doesNotMatch(evil, /<script>/);
  assert.match(evil, /&lt;img/);
  assert.match(evil, /&quot;&gt;&lt;script&gt;/);
});

test("statusDot: an external row reflects the external health map — up / down / not probed yet", () => {
  const unprobed = statusDot(row(), { external: {} });
  assert.match(unprobed, /not probed yet/);
  assert.match(unprobed, /var\(--crow-text-muted\)/);

  const up = statusDot(row(), { external: { "raven-flash-next": { ready: true, baseUrl: RAVEN } } });
  assert.match(up, /var\(--crow-success\)/);
  assert.match(up, /external engine reachable from this instance/);

  const down = statusDot(row(), { external: { "raven-flash-next": { ready: false, baseUrl: RAVEN } } });
  assert.match(down, /var\(--crow-error\)/);
  assert.match(down, /not reachable from this instance/);

  const es = statusDot(row(), { external: {}, lang: "es" });
  assert.match(es, /aún sin sondear/);
});

test("statusDot: health recorded for an OLD base_url reads as not probed yet (row was repointed)", () => {
  const stale = statusDot(row(), { external: { "raven-flash-next": { ready: true, baseUrl: "http://10.0.0.127:8030/v1" } } });
  assert.match(stale, /not probed yet/);
});

test("statusDot: disabled and unmarked rows keep today's dots regardless of the map", () => {
  assert.match(statusDot(row({ disabled: true }), { external: { "raven-flash-next": { ready: true, baseUrl: RAVEN } } }), /disabled \(soft-delete\)/);
  const plain = statusDot({ id: "cloud-openai", baseUrl: "https://api.openai.com/v1", disabled: false, gpuPolicy: null }, { external: {} });
  assert.match(plain, /title="enabled"/);
  assert.match(plain, /var\(--crow-success\)/);
});

test("render: a marked listProvidersAll row gets the badge and the not-probed dot (stub db, empty health map)", async () => {
  const { default: tab } = await import("../servers/gateway/dashboard/settings/sections/llm/providers-tab.js");
  const db = {
    execute: async (q) => {
      const sql = typeof q === "string" ? q : q.sql;
      if (sql.includes("FROM providers")) {
        return { rows: [{
          id: "raven-flash-next", base_url: RAVEN, api_key: null, host: "cloud", bundle_id: null,
          provider_type: "openai-compat", description: null, models: "[]",
          gpu_policy: JSON.stringify({ engine: ENGINE }), disabled: 0,
        }] };
      }
      return { rows: [] };
    },
  };
  const html = await tab.render({ db, lang: "en" });
  assert.match(html, />external · raven</);
  assert.match(html, /external engine not probed yet/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `export PATH=/home/kh0pp/.nvm/versions/node/v24.21.0/bin:$PATH && cd ~/crow-wt-external-engine && npm test -- tests/providers-tab-host-badge.test.js`

Expected: FAIL to load ("does not provide an export named 'engineBadge'").

- [ ] **Step 3: Add the i18n keys**

In `servers/gateway/dashboard/shared/i18n.js`, find:

```js
  "settings.pageTitle": { en: "Settings", es: "Ajustes" },
```

Replace it with:

```js
  "settings.pageTitle": { en: "Settings", es: "Ajustes" },
  // Providers tab — external engines (spec 2026-09-23 external-engine-provider §2.4)
  "settings.providers.externalBadge": { en: "external · {host}", es: "externo · {host}" },
  "settings.providers.engineUp": { en: "external engine reachable from this instance", es: "motor externo accesible desde esta instancia" },
  "settings.providers.engineDown": { en: "external engine not reachable from this instance", es: "motor externo no accesible desde esta instancia" },
  "settings.providers.engineUnprobed": { en: "external engine not probed yet", es: "motor externo aún sin sondear" },
```

- [ ] **Step 4: Implement the badge, the dot and the render wiring**

In `servers/gateway/dashboard/settings/sections/llm/providers-tab.js`, find:

```js
import { getOrCreateLocalInstanceId } from "../../../../instance-registry.js";
```

Replace it with:

```js
import { getOrCreateLocalInstanceId } from "../../../../instance-registry.js";
import { isExternalEngine, externalEngineInfo } from "../../../../../shared/provider-engine.js";
import { getProviderHealth } from "../../../../provider-health.js";
import { t, fill } from "../../../shared/i18n.js";
```

Directly below the closing `}` of `export function hostBadge(...)`, insert:

```js
/** "external · <host>" pill for a row marked gpu_policy.engine.managed = "external"; "" otherwise.
 *  host/label are free text replicated from peers — escaped, never trusted. */
export function engineBadge(p, lang = "en") {
  const info = externalEngineInfo(p);
  if (!info) return "";
  const base = `font-size:0.72rem;padding:2px 8px;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:var(--crow-radius-pill);white-space:nowrap;margin-left:4px`;
  const text = fill(t("settings.providers.externalBadge", lang), { host: info.host || "?" });
  return `<span style="${base};color:var(--crow-text-secondary)" title="${escapeHtml(info.label || "")}">${escapeHtml(text)}</span>`;
}

/** Status dot. External engines show THIS instance's read-only probe result
 *  (external-engine-poll.js); every other row keeps the enabled/disabled dot. */
export function statusDot(p, { external = {}, lang = "en" } = {}) {
  let color;
  let title;
  if (p.disabled) {
    color = "var(--crow-text-muted)";
    title = "disabled (soft-delete)";
  } else if (!isExternalEngine(p)) {
    color = "var(--crow-success)";
    title = "enabled";
  } else {
    const h = external[p.id];
    if (!h || h.baseUrl !== p.baseUrl) {
      color = "var(--crow-text-muted)";
      title = t("settings.providers.engineUnprobed", lang);
    } else if (h.ready) {
      color = "var(--crow-success)";
      title = t("settings.providers.engineUp", lang);
    } else {
      color = "var(--crow-error)";
      title = t("settings.providers.engineDown", lang);
    }
  }
  const tEsc = escapeHtml(title);
  return `<span aria-label="${tEsc}" title="${tEsc}" style="color:${color};font-size:1.15rem;line-height:1">●</span>`;
}
```

In `render`, find:

```js
  async render({ db }) {
    const providers = await listProvidersAll(db);
```

Replace it with:

```js
  async render({ db, lang = "en" }) {
    const providers = await listProvidersAll(db);
    const external = getProviderHealth().external;
```

Then find:

```js
      const dotColor = p.disabled ? "var(--crow-text-muted)" : "var(--crow-success)";
      const dotTitle = p.disabled ? "disabled (soft-delete)" : "enabled";
      const idEsc = escapeHtml(p.id);
      return `<tr class="${p.disabled ? "llm-row-disabled" : ""}">
        <td class="llm-cell-status"><span aria-label="${dotTitle}" title="${dotTitle}" style="color:${dotColor};font-size:1.15rem;line-height:1">●</span></td>
        <td class="llm-cell-id">${idEsc}</td>
        <td>${hostBadge(p, hostCtx)}</td>
```

Replace it with:

```js
      const idEsc = escapeHtml(p.id);
      return `<tr class="${p.disabled ? "llm-row-disabled" : ""}">
        <td class="llm-cell-status">${statusDot(p, { external, lang })}</td>
        <td class="llm-cell-id">${idEsc}</td>
        <td>${hostBadge(p, hostCtx)}${engineBadge(p, lang)}</td>
```

(This tab is server-rendered HTML with no client `<script>`, so the backtick rule is not triggered. Do not add a client script.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `export PATH=/home/kh0pp/.nvm/versions/node/v24.21.0/bin:$PATH && cd ~/crow-wt-external-engine && npm test -- tests/providers-tab-host-badge.test.js tests/i18n-global-parity.test.js tests/settings-i18n-section-labels.test.js`

Expected: PASS, 0 failures.

- [ ] **Step 6: Commit**

```bash
cd ~/crow-wt-external-engine
git commit servers/gateway/dashboard/settings/sections/llm/providers-tab.js servers/gateway/dashboard/shared/i18n.js tests/providers-tab-host-badge.test.js -m "feat(settings): Providers tab shows external-engine reachability and an external · host badge"
git show --stat HEAD
```

---

### Task 6: Docs + full suite

**Files:**
- Modify: `docs/architecture/models.md` (insert a new section directly above `## What later plans add`)

**Interfaces:**
- Consumes: every name from Tasks 1-5.
- Produces: operator-facing documentation, and a green full suite.

- [ ] **Step 1: Write the docs section**

In `docs/architecture/models.md`, directly above the line `## What later plans add`, insert:

```markdown
## External engines

A provider row can declare that **another machine runs the engine**: `gpu_policy.engine = { managed: "external", host: "<machine>", label?: "<engine>" }` (today: halogen on raven, row `raven-flash-next`). `managed` must be exactly `"external"`, the only value defined. `host` is a display label, never a routing input, and `providers.host` stays `cloud` (the tab shows "network" + "external · raven"). The helper is `isExternalEngine` in `servers/shared/provider-engine.js`. `gpu_policy` replicates, so every paired instance learns that the row is not its to manage.

**Never orchestrated.** Every orchestrator path checks the marker first. `maybeAcquireLocalProvider` returns `null`, so the caller dials `base_url` directly, exactly as for a cloud row. `acquireProvider` throws `ExternalEngineError` (`code: "external_engine"`). `resolveWarmableProviderName` returns `null`. `ensureResident` skips the row and logs once per provider. The row is never always-resident, never a mutex sibling (so it is never evicted), never a mutex-group member, and never an idle-revert default. The legacy `servers/shared/lifecycle.js` `ensureModelWarm` refuses it (`reason: "external_engine"`), and `releaseModel` is a no-op for it.

**Write validation (transition-only).** `upsertProvider` judges a write only when it **changes** `gpu_policy.engine`, `bundleId` or `gpu_policy.runtime` relative to the stored row. It then refuses a resulting row that has any of these:
- a malformed marker (`EXTERNAL_ENGINE_INVALID`);
- a marker combined with a `bundleId` or `runtime: "native"`, judged on the effective policy after the upsert's `COALESCE` (`EXTERNAL_ENGINE_CONFLICT`);
- a marked row turned into an orchestratable one in a single write (`EXTERNAL_ENGINE_CONFLICT`). To convert such a row, first unmark it with its own write (no `engine`, no bundle, no native runtime), then register.

A malformed incoming `gpu_policy` JSON string is always `EXTERNAL_ENGINE_INVALID`.

A write that leaves those three fields as stored always passes. Replication writes rows directly, never through `upsertProvider`, so a contradictory row can arrive from a peer, and the tab's re-enable, host repair and the reconciler must keep working on it.

The models.json reconciler keeps a stored `engine` when it re-asserts `gpu_policy`. It also runs each entry in its own try/catch: a refused entry is logged as `[providers-reconcile] <id> skipped: …` and counted in `failed`.

**Read-only health.** `servers/gateway/external-engine-poll.js` is armed by `initOrchestrator` next to the residency monitor.
- Every `CROW_EXTERNAL_ENGINE_POLL_MS` (default 60000; `0` disables it; the scratch test suite sets `0`), each enabled marked row gets one `GET <base_url>/models` with no auth header and a 3 s timeout. 2xx means ready.
- Results land in `getProviderHealth().external` (`servers/gateway/provider-health.js`). Disabled and removed rows are pruned from it.
- A tick probes and prunes only when the providers config came from the DB (`_source === "db:providers"`). The models.json fallback that `loadProviders()` serves after a cache invalidation or a DB error carries no markers, so such a tick is a no-op and every clock survives.
- Each instance probes from its own network position. A peer on another LAN may even reach a *different* device at the same private IP (for example `10.0.0.126`). That is harmless: the result is info-only, and the request is a header-less GET on `/models`.

**Surfacing.** The nest `providers` signal lists external engines at **info severity only, never warn**, so they never trigger a health-monitor push. Each engine gets one line:
- `"halogen on raven: up"`;
- `"… down for <age> (externally managed)"` once it has answered in this process;
- `"… not reachable from this instance"` if it never has.

Engines run outside Crow are stopped on purpose: raven's production windows stop halogen for hours, and Crow has no route-away. A resident-model warn is unchanged, and when it fires it is the signal's one issue.

The Settings > LLM > Providers dot for a marked row shows this instance's probe result: reachable, not reachable, or not probed yet.

**Not in scope:** remote lifecycle (the window script starts and stops halogen over ssh), route-away or fallback when an engine is down, and sync filtering. `GET /api/providers/health` still probes every row on demand.
```

- [ ] **Step 2: Run the full suite**

Run: `export PATH=/home/kh0pp/.nvm/versions/node/v24.21.0/bin:$PATH && cd ~/crow-wt-external-engine && npm test`

Expected: the suite total rises by the new tests, with 0 failures and 0 cancelled. Also confirm the static checks CI runs:

Run: `export PATH=/home/kh0pp/.nvm/versions/node/v24.21.0/bin:$PATH && cd ~/crow-wt-external-engine && node scripts/check-port-allocation.js && git status --short`

Expected:
- `check-port-allocation` passes (this work adds no ports).
- `git status` shows only the docs change as uncommitted.
- There is no `node_modules` entry and no `.superpowers/` entry.

- [ ] **Step 3: Commit**

```bash
cd ~/crow-wt-external-engine
git commit docs/architecture/models.md -m "docs(models): external engines — marker, guards, validation, read-only poll, surfacing"
git show --stat HEAD
```

---

## Operational step (controller, after merge + deploy — NOT a code task)

Do this only when all of the following hold:
- the PR is merged;
- the CI check-runs are green;
- `crow-gateway.service` (`WorkingDirectory=/home/kh0pp/crow`) has auto-updated to the merge commit. Check `git -C ~/crow log -1 --oneline`, and confirm that `auto_update_last_result` is not "Skipped".

pi-lab cleared the probe for any time (spec §2.6), and this step starts no model, so no `CROW-SCHEDULE.md` reservation is needed.

**Mark ONLY `raven-flash-next`.** Its `base_url` is `http://10.0.0.126:8030/v1`, which answered 200 on 2026-09-23. **Do NOT mark `raven-halogen-smoke`.** It points at `:8731`, which is dead, and the controller raises it with Kevin separately.

Use the normal provider-update path: `upsertProvider(db, { ...row, gpuPolicy: { ...row.gpuPolicy, engine } })` in `servers/shared/providers-db.js`, with `row` taken from `listProvidersAll(db)`. This is the read-spread-upsert shape used by the Providers tab's `llm_provider_enable` action and by `reenableProviderPreservingContent`.

`upsertProvider` bumps `lamport_ts` and calls `emitOrQueue`. A one-shot process has no live sync manager, so the change goes into `sync_outbox` (`table_name = 'providers'`), and the running gateway's drain sends it to peers.

This is a deliberate operator write against the live DB, **not** a test. The data dir is set explicitly. Run:

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v24.21.0/bin:$PATH
cd ~/crow
CROW_DATA_DIR=/home/kh0pp/.crow/data node --input-type=module -e '
import { createDbClient } from "./servers/db.js";
import { listProvidersAll, upsertProvider } from "./servers/shared/providers-db.js";
const ID = "raven-flash-next";
const EXPECT_URL = "http://10.0.0.126:8030/v1";
const ENGINE = { managed: "external", host: "raven", label: "halogen" };
const db = createDbClient();
const outbox = async () => Number((await db.execute("SELECT COUNT(*) AS n FROM sync_outbox WHERE table_name = '\''providers'\''")).rows[0].n);
try {
  const row = (await listProvidersAll(db)).find((r) => r.id === ID);
  if (!row) throw new Error(ID + " MISSING — stop and investigate");
  if (row.baseUrl !== EXPECT_URL) throw new Error(ID + " base_url is " + row.baseUrl + ", expected " + EXPECT_URL + " — stop");
  if (row.bundleId || row.gpuPolicy?.runtime === "native") throw new Error(ID + " has bundle/native — stop and investigate");
  const before = await outbox();
  const res = await upsertProvider(db, { ...row, gpuPolicy: { ...(row.gpuPolicy || {}), engine: ENGINE } });
  const after = await outbox();
  console.log(ID, JSON.stringify(res), "sync_outbox providers rows:", before, "->", after);
  if (after !== before + 1) console.log("WARNING: outbox did not grow by exactly 1 — the marker may not replicate; stop and investigate (sync_deployment_enabled? drain already ran?)");
} finally { db.close(); }
'
```

Then verify each of the following in order:

1. **The one-shot's output.**
   - `res` shows a new `lamport_ts`, with no `unchanged`.
   - The outbox count rose by exactly 1.
   - If the count did not rise, stop. The marker is set locally but will not replicate.
2. **The drain.** Within about 60 s the gateway drains the queued row:

   ```bash
   journalctl -u crow-gateway.service --since "-3 min" --no-pager | grep "sync-outbox-drain"
   ```

   Expect `[sync-outbox-drain] drained batch: emitted=… deleted=…`.
3. **The row on crow.** Re-read it with `listProvidersAll`. `gpuPolicy.engine` should equal `{managed:"external",host:"raven",label:"halogen"}` and `host` should still be `"cloud"`.
4. **The Providers tab.** Within about 90 s (the 30 s providers cache plus the 60 s tick), crow's Settings > LLM > Providers shows "external · raven" on `raven-flash-next`, with a green dot when halogen answers. The gateway journal has `[external-engines] read-only poll armed: every 60000ms` from boot.
5. **The row on r4, read-only.** r4's DB is `/home/kh0pp/.crow-r4/data/crow.db`, and this check only reads it:

   ```bash
   cd ~/crow && node --input-type=module -e '
   import { createClient } from "@libsql/client";
   const db = createClient({ url: "file:/home/kh0pp/.crow-r4/data/crow.db" });
   const { rows } = await db.execute({ sql: "SELECT gpu_policy, lamport_ts FROM providers WHERE id = ?", args: ["raven-flash-next"] });
   console.log(rows[0] ? rows[0].gpu_policy + " lamport=" + rows[0].lamport_ts : "row missing on r4");
   db.close();
   '
   ```

   The printed `gpu_policy` must carry `"engine":{"managed":"external","host":"raven","label":"halogen"}`. If it does not appear within a few minutes, check r4's instance-sync log before retrying anything.

**Rollback.** Run the same one-shot with `gpuPolicy: rest`, where `rest` is the row's `gpuPolicy` without `engine`. This is the explicit unmark write the validation expects.

---

## Review

### Adversarial review round 1 (binding rulings from the coordinator, 2026-09-23)

| # | Finding | Resolution in this plan |
|---|---|---|
| C1 | **A prune could wipe the clocks after a cache invalidation.** `loadProviders()` falls back to `loadFromModelsJson()` when its cache is null or the DB read fails (`servers/shared/providers.js:44-63`). The next tick would then see a non-empty config with no markers and prune every external entry. | Task 3: `pollExternalEngines` probes **and** prunes only when `cfg._source === "db:providers"`. That is the exact value `loadProvidersFromDb` sets, verified in `servers/shared/providers-db.js`; the fallback sets a file path or `null`. Any other tick is a no-op. New test "C1: a non-DB config … neither probes nor prunes". The old "any provider present" prune guard is gone. |
| C2 | **Validation rejected today's writes on rows it never wrote.** Replication applies rows directly, so contradictory or malformed marked rows can arrive from a peer. The spread writes then failed on them: the tab's re-enable, `reenableProviderPreservingContent`, `repairProviderHosts` and the reconciler. | Task 2 is rewritten to be **transition-only**. It throws only when the write changes `engine`, `bundleId` or `runtime` relative to the stored row **and** the resulting row is invalid. A malformed incoming `gpu_policy` JSON string is always `EXTERNAL_ENGINE_INVALID`. `syncProvidersFromModelsJson` runs each entry in its own try/catch (log, `failed++`, continue). Tests seed contradictory and malformed rows with raw SQL, and each of those four paths succeeds on them. A write that newly adds a `bundleId` to a marked row still throws. |
| C3 | **False high-priority pushes.** A nest warn becomes a health-monitor push, and raven's production windows stop halogen for hours by design. | Task 4 is rewritten: external engines are severity **info only**, never warn. The lines are "`<label> on <host>: up`", "`… down for <age> (externally managed)`" once the engine has answered in this process, or "`… not reachable from this instance`". The `downIssueAny` fold-into-warn logic and its keys are dropped, leaving 3 new keys instead of 7. The resident-model warn path is byte-identical, pinned by a deepEqual test. Spec §2.4 is updated with the reason. |
| Q3 | **The reconciler dropped the marker** when it re-asserted a non-null `gpuPolicy` from models.json. | Task 2 Step 4: the reconciler reads the stored `gpu_policy` and copies its `engine` into the written policy. Tested by "Q3: the reconciler keeps a stored engine…" and by the replicated-row reconciler test. |
| S1 | `isAlwaysResident` could let a marked row into the declared, local or deferred residency sets. | Task 1 (i): `isAlwaysResident` returns false for marked rows, and `initOrchestrator`'s inline deferred-set predicate now uses `isAlwaysResident`. Tested in the host-gate file. |
| S2 | The legacy `lifecycle.js` `ensureModelWarm` and `releaseModel` had no guard. | Task 1 (j): `ensureModelWarm` returns `{ ok: false, reason: "external_engine" }` with no probe and no bundle start, and `releaseModel` is a no-op. There is a `cfg` test seam, and the new `tests/lifecycle-external-engine.test.js` uses a tmp `CROW_REFCOUNT_PATH` and a fetch spy. |
| S3 | `await res.body.cancel()` ran outside the timeout race and could extend the tick. | Task 3: the cancel is now fire-and-forget, with a `.catch`. |
| S4 | The per-network-position caveat was undocumented. | Task 6 docs and spec §2.3: a peer on another LAN may reach a different device at the same private IP. This is harmless, since the result is info-only and the request is a header-less GET on `/models`. |
| Ops | The operational step marked a dead endpoint and did not verify replication. | The step is rewritten. It marks only `raven-flash-next`, after asserting its `base_url`; `raven-halogen-smoke` (`:8731`, dead) is left for Kevin. It sets `CROW_DATA_DIR=/home/kh0pp/.crow/data` explicitly, checks that the `sync_outbox` providers count grows by exactly 1, looks for the drain log line, and verifies the marker on r4 read-only. Spec §2.6 is updated to match. |
