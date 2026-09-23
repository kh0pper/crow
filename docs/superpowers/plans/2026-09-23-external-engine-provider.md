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
- An engine that was ready once and has been not-ready for at least `notReadyWarnMs()` (the existing `CROW_PROVIDER_NOT_READY_WARN_MS`, default 10 min) raises a warn. An engine that has **never** been ready in this process raises info only, **never** warn (spec §2.4).
- The validation error codes are exactly `EXTERNAL_ENGINE_CONFLICT` (spec) and `EXTERNAL_ENGINE_INVALID` (derived from "managed is exactly 'external'"). The typed orchestrator error is `ExternalEngineError` with `code: "external_engine"`.
- The Providers tab is server-rendered HTML with no client script. Interpolate engine `host` and `label` only through `escapeHtml`, and into i18n strings only through `fill()`, because they are free text replicated from peers.

## Review Focus

These are the five inputs the spec implies but never spells out, most likely first. Each one is pinned by a test in the task named on its line.

1. **A typo'd or partial marker**, such as `managed: "External"` or a missing `host`. Today such a row silently stays orchestratable. Expected: the write is rejected loudly with `EXTERNAL_ENGINE_INVALID`, and the orchestrator treats only the exact string `"external"` as marked (Task 1 truth table, Task 2 write tests).
2. **A later write that re-arms a marked row.**
   - Case (a): `gpuPolicy: null` plus a `bundleId`. The SQL `COALESCE` keeps the stored marker, so the effective row is contradictory.
   - Case (b): a `registerModel`-shaped write whose fresh `gpuPolicy: { runtime: "native" }` silently drops the marker and adopts the engine.
   - Expected: both are refused with `EXTERNAL_ENGINE_CONFLICT`. To unmark, the operator makes a separate, explicit write (Task 2).
3. **Free-text `host` or `label` carrying HTML or `$&`** that replicates in from a peer. Expected: the Providers tab escapes it (Task 5), and the nest copy renders it verbatim through `fill()` without mangling it (Task 4).
4. **A tick whose config read comes back empty** (`loadProviders()` returns `{providers:{}}` when both the DB and models.json are unreadable). Expected: the external map, with its ready-once and outage clocks, survives. This mirrors the residency poll's reviewed CRITICAL (Task 3).
5. **A repointed or odd `base_url`.**
   - A repointed URL starts fresh clocks, so it never inherits a "was ready" warn, and the tab shows "not probed yet" until the new URL has been probed.
   - A non-http(s) `base_url` (such as `file:`) is never fetched.
   - A fetch that ignores the abort signal still resolves the tick at the timeout.
   - Covered in Task 3 and Task 5.

---

## File map

| File | Responsibility |
|---|---|
| `servers/shared/provider-engine.js` (create) | Pure marker helpers: `isExternalEngine`, `externalEngineInfo`, `engineShapeError`, `externalEngineConflict`, `ExternalEngineError`. No imports. |
| `servers/gateway/gpu-orchestrator.js` (modify) | D2 guards in maybeAcquire, acquire, warm-resolve, ensureResident, acquireOrStartNative, siblings and mutex groups. Arms the poll in `initOrchestrator`. |
| `servers/shared/providers-db.js` (modify) | Validates `upsertProvider` writes (D2). |
| `servers/gateway/provider-health.js` (modify) | The new `external` map: `recordExternal`, `pruneExternal`, and `getProviderHealth().external`. |
| `servers/gateway/external-engine-poll.js` (create) | `probeExternalEngine`, `pollExternalEngines`, `startExternalEngineMonitor`, `_stopExternalEngineMonitor`, `externalEnginePollMs`. |
| `scripts/run-suite.mjs` (modify) | Sets `CROW_EXTERNAL_ENGINE_POLL_MS=0` for scratch suite gateways. |
| `servers/gateway/dashboard/panels/nest/health-signals.js` (modify) | `providersSignal` gains the external engines. |
| `servers/gateway/dashboard/settings/sections/llm/providers-tab.js` (modify) | `statusDot` and `engineBadge`, both exported, plus `render({ db, lang })`. |
| `servers/gateway/dashboard/shared/i18n.js` (modify) | 7 `signals.providers.*` keys and 4 `settings.providers.*` keys. |
| `docs/architecture/models.md` (modify) | Adds an "External engines" section. |

---

### Task 1: Marker helper + orchestrator guards (D1, D2)

**Files:**
- Create: `servers/shared/provider-engine.js`
- Modify: `servers/gateway/gpu-orchestrator.js` (imports near :93-96; `getMutexSiblings` :414; `getMutexGroups` :454; `maybeAcquireLocalProvider` :580; `resolveWarmableProviderName` :624; `acquireOrStartNative` :1085; `acquireProvider` :1230; `ensureResident` :1459)
- Test: `tests/provider-engine.test.js` (create), `tests/gpu-orchestrator-native.test.js`, `tests/gpu-orchestrator-host-gate.test.js`, `tests/gpu-warm-resolve.test.js`

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

- [ ] **Step 3: Run the tests to verify they fail**

Run: `export PATH=/home/kh0pp/.nvm/versions/node/v24.21.0/bin:$PATH && cd ~/crow-wt-external-engine && npm test -- tests/provider-engine.test.js tests/gpu-orchestrator-native.test.js tests/gpu-orchestrator-host-gate.test.js tests/gpu-warm-resolve.test.js`

Expected results:
- `provider-engine.test.js` and `gpu-orchestrator-native.test.js` fail to load. The first reports `Cannot find module .../provider-engine.js`. The second reports "does not provide an export named 'ExternalEngineError'".
- The new host-gate test fails with `true !== null`.
- The new warm-resolve test fails with `'ext-bundle' !== null`.

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

- [ ] **Step 6: Run the tests to verify they pass**

Run: `export PATH=/home/kh0pp/.nvm/versions/node/v24.21.0/bin:$PATH && cd ~/crow-wt-external-engine && npm test -- tests/provider-engine.test.js tests/gpu-orchestrator-native.test.js tests/gpu-orchestrator-host-gate.test.js tests/gpu-warm-resolve.test.js tests/gpu-orchestrator-residency-poll.test.js tests/gpu-orchestrator-serving-class.test.js`

Expected: PASS, 0 failures. That includes every pre-existing test in these files, since unmarked rows behave exactly as before.

- [ ] **Step 7: Commit**

```bash
cd ~/crow-wt-external-engine
git add servers/shared/provider-engine.js tests/provider-engine.test.js
git commit servers/shared/provider-engine.js servers/gateway/gpu-orchestrator.js tests/provider-engine.test.js tests/gpu-orchestrator-native.test.js tests/gpu-orchestrator-host-gate.test.js tests/gpu-warm-resolve.test.js -m "feat(providers): external-engine marker; orchestrator never acquires, warms, evicts or reverts to one"
git show --stat HEAD
```

---

### Task 2: Write-path validation in `upsertProvider` (D2 validation)

**Files:**
- Modify: `servers/shared/providers-db.js` (imports near :38; `upsertProvider` :227)
- Test: `tests/providers-external-engine-write.test.js` (create)

**Interfaces:**
- Consumes: `engineShapeError`, `externalEngineConflict`, `isExternalEngine` from Task 1.
- Produces: `upsertProvider` throws an `Error` with `.code` set to `"EXTERNAL_ENGINE_INVALID"` or `"EXTERNAL_ENGINE_CONFLICT"`. Nothing is written or emitted when it throws. Every other write behaves as before.

Rules, in order:
1. If the incoming `gpuPolicy` is non-null, `engineShapeError(incoming.engine)` must return null. Otherwise the write fails with `EXTERNAL_ENGINE_INVALID`.
2. The effective policy is the incoming policy if present, else the stored one (this mirrors `COALESCE(excluded.gpu_policy, providers.gpu_policy)`). `externalEngineConflict({ bundleId: incomingBundleId, gpuPolicy: effective })` must be false. Otherwise the write fails with `EXTERNAL_ENGINE_CONFLICT`.
3. **No one-step adoption.** Suppose the stored row is marked and the effective row is unmarked but orchestratable (it has a bundle or `runtime: "native"`). The write fails with `EXTERNAL_ENGINE_CONFLICT`. To unmark, the operator makes a separate write that has no engine, no bundle and no native runtime.

These run after the existing-row `SELECT` and **before** the no-op check.

- [ ] **Step 1: Write the failing tests**

Create `tests/providers-external-engine-write.test.js`:

```js
/**
 * upsertProvider refuses contradictory external-engine rows (spec
 * docs/superpowers/specs/2026-09-23-external-engine-provider-design.md §2.2).
 * Harness: freshLibsql() from providers-upsert-noop.test.js — a per-test
 * init-db'd tmp DB; CROW_DATA_DIR points there so the instance-id file never
 * lands in the real ~/.crow.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { upsertProvider, listProvidersAll, setProviderSyncManager } from "../servers/shared/providers-db.js";

function freshLibsql() {
  const dir = mkdtempSync(join(tmpdir(), "providers-ext-engine-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const prevDataDir = process.env.CROW_DATA_DIR;
  process.env.CROW_DATA_DIR = dir;
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return {
    db,
    cleanup() {
      setProviderSyncManager(null);
      if (prevDataDir === undefined) delete process.env.CROW_DATA_DIR;
      else process.env.CROW_DATA_DIR = prevDataDir;
      try { db.close(); } catch {}
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const ENGINE = { managed: "external", host: "raven", label: "halogen" };
const ravenRow = (extra = {}) => ({
  id: "raven-flash-next",
  baseUrl: "http://10.0.0.126:8030/v1",
  apiKey: null,
  host: "cloud",
  bundleId: null,
  description: "raven halogen",
  models: [{ id: "flash-next" }],
  disabled: false,
  providerType: "openai-compat",
  ...extra,
});

async function storedPolicy(db, id) {
  const { rows } = await db.execute({ sql: "SELECT gpu_policy FROM providers WHERE id = ?", args: [id] });
  return rows[0]?.gpu_policy == null ? null : JSON.parse(rows[0].gpu_policy);
}
const code = (c) => (err) => err?.code === c;

test("a valid marker on a cloud row is accepted and stored", async () => {
  const h = freshLibsql();
  try {
    await upsertProvider(h.db, ravenRow({ gpuPolicy: { engine: ENGINE } }));
    assert.deepEqual((await storedPolicy(h.db, "raven-flash-next")).engine, ENGINE);
  } finally { h.cleanup(); }
});

test("marker + bundleId is rejected with EXTERNAL_ENGINE_CONFLICT and nothing is written", async () => {
  const h = freshLibsql();
  try {
    await assert.rejects(upsertProvider(h.db, ravenRow({ bundleId: "halogen", gpuPolicy: { engine: ENGINE } })), code("EXTERNAL_ENGINE_CONFLICT"));
    const { rows } = await h.db.execute({ sql: "SELECT COUNT(*) AS n FROM providers WHERE id = ?", args: ["raven-flash-next"] });
    assert.equal(Number(rows[0].n), 0);
  } finally { h.cleanup(); }
});

test("marker + native runtime is rejected with EXTERNAL_ENGINE_CONFLICT", async () => {
  const h = freshLibsql();
  try {
    await assert.rejects(upsertProvider(h.db, ravenRow({ gpuPolicy: { engine: ENGINE, runtime: "native" } })), code("EXTERNAL_ENGINE_CONFLICT"));
  } finally { h.cleanup(); }
});

test("a malformed marker is rejected loudly with EXTERNAL_ENGINE_INVALID (typo'd managed, missing host)", async () => {
  const h = freshLibsql();
  try {
    await assert.rejects(upsertProvider(h.db, ravenRow({ gpuPolicy: { engine: { managed: "External", host: "raven" } } })), code("EXTERNAL_ENGINE_INVALID"));
    await assert.rejects(upsertProvider(h.db, ravenRow({ gpuPolicy: { engine: { managed: "external" } } })), code("EXTERNAL_ENGINE_INVALID"));
    await assert.rejects(upsertProvider(h.db, ravenRow({ gpu_policy: JSON.stringify({ engine: { managed: "external", host: "" } }) })), code("EXTERNAL_ENGINE_INVALID"));
  } finally { h.cleanup(); }
});

test("COALESCE hole: a null-policy write adding a bundleId to a MARKED row is rejected", async () => {
  const h = freshLibsql();
  try {
    await upsertProvider(h.db, ravenRow({ gpuPolicy: { engine: ENGINE } }));
    await assert.rejects(upsertProvider(h.db, ravenRow({ bundleId: "halogen", gpuPolicy: null })), code("EXTERNAL_ENGINE_CONFLICT"));
    assert.deepEqual((await storedPolicy(h.db, "raven-flash-next")).engine, ENGINE, "marker untouched");
  } finally { h.cleanup(); }
});

test("no one-step adoption: a registerModel-shaped native write over a MARKED row is rejected; unmark-then-register works", async () => {
  const h = freshLibsql();
  try {
    await upsertProvider(h.db, ravenRow({ gpuPolicy: { engine: ENGINE } }));
    await assert.rejects(
      upsertProvider(h.db, ravenRow({ host: "local", gpuPolicy: { runtime: "native", catalogId: "x", quant: "Q4", port: 18200 } })),
      code("EXTERNAL_ENGINE_CONFLICT"),
    );
    // Explicit unmark (its own write) …
    await upsertProvider(h.db, ravenRow({ gpuPolicy: {} }));
    assert.equal((await storedPolicy(h.db, "raven-flash-next")).engine, undefined);
    // … then the native registration is allowed.
    await upsertProvider(h.db, ravenRow({ host: "local", gpuPolicy: { runtime: "native", catalogId: "x", quant: "Q4", port: 18200 } }));
    assert.equal((await storedPolicy(h.db, "raven-flash-next")).runtime, "native");
  } finally { h.cleanup(); }
});

test("the provider-update path used to mark rows ({...listProvidersAll row, gpuPolicy}) and the tab's re-enable ({...row, disabled:false}) both pass on a marked row", async () => {
  const h = freshLibsql();
  try {
    await upsertProvider(h.db, ravenRow());
    let row = (await listProvidersAll(h.db)).find((r) => r.id === "raven-flash-next");
    await upsertProvider(h.db, { ...row, gpuPolicy: { ...(row.gpuPolicy || {}), engine: ENGINE } });
    row = (await listProvidersAll(h.db)).find((r) => r.id === "raven-flash-next");
    assert.deepEqual(row.gpuPolicy.engine, ENGINE);
    assert.equal(row.host, "cloud", "host stays cloud (spec §2.1)");
    const r = await upsertProvider(h.db, { ...row, disabled: false });
    assert.equal(r.unchanged, true, "no-op suppression still applies to a valid marked row");
  } finally { h.cleanup(); }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `export PATH=/home/kh0pp/.nvm/versions/node/v24.21.0/bin:$PATH && cd ~/crow-wt-external-engine && npm test -- tests/providers-external-engine-write.test.js`

Expected: FAIL. The conflict, invalid, COALESCE and adoption tests all report "Missing expected rejection". The first test and the last test pass.

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
function parsePolicy(raw) {
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

function engineWriteError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * External-engine write rules (spec 2026-09-23 §2.2). Judged on the EFFECTIVE
 * policy, because the upsert SQL COALESCEs a null gpu_policy into "keep the
 * stored one" — a null-policy write that adds a bundleId would otherwise
 * produce a marked row with a bundle. Also refuses one-step adoption: a write
 * that swaps a marked row's policy for an orchestratable one (bundle or
 * native) must be preceded by its own explicit unmark write.
 */
function assertExternalEngineWrite({ bundleId, incomingPolicy, storedPolicy }) {
  if (incomingPolicy) {
    const shape = engineShapeError(incomingPolicy.engine);
    if (shape) throw engineWriteError("EXTERNAL_ENGINE_INVALID", shape);
  }
  const effective = incomingPolicy ?? storedPolicy;
  if (externalEngineConflict({ bundleId, gpuPolicy: effective })) {
    throw engineWriteError("EXTERNAL_ENGINE_CONFLICT",
      'an external engine (gpu_policy.engine.managed = "external") cannot also carry a bundleId or gpu_policy.runtime = "native"');
  }
  const orchestratable = (bundleId != null && bundleId !== "") || effective?.runtime === "native";
  if (isExternalEngine({ gpuPolicy: storedPolicy }) && !isExternalEngine({ gpuPolicy: effective }) && orchestratable) {
    throw engineWriteError("EXTERNAL_ENGINE_CONFLICT",
      "this row is an external engine; clear gpu_policy.engine in its own write before giving it a bundle or a native runtime");
  }
}
```

Inside `upsertProvider`, find:

```js
  const gpuPolicy = provider.gpuPolicy != null ? JSON.stringify(provider.gpuPolicy) : (provider.gpu_policy ?? null);

  if (existed && upsertIsNoop(rows[0], {
```

Replace it with:

```js
  const gpuPolicy = provider.gpuPolicy != null ? JSON.stringify(provider.gpuPolicy) : (provider.gpu_policy ?? null);

  assertExternalEngineWrite({
    bundleId: provider.bundleId ?? provider.bundle_id ?? null,
    incomingPolicy: parsePolicy(gpuPolicy),
    storedPolicy: existed ? parsePolicy(rows[0].gpu_policy) : null,
  });

  if (existed && upsertIsNoop(rows[0], {
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `export PATH=/home/kh0pp/.nvm/versions/node/v24.21.0/bin:$PATH && cd ~/crow-wt-external-engine && npm test -- tests/providers-external-engine-write.test.js tests/providers-upsert-noop.test.js tests/providers-war-sim.test.js tests/providers-host-inference.test.js tests/models-registration.test.js tests/sync-emit-sites.test.js`

Expected: PASS, 0 failures.

- [ ] **Step 5: Commit**

```bash
cd ~/crow-wt-external-engine
git add tests/providers-external-engine-write.test.js
git commit servers/shared/providers-db.js tests/providers-external-engine-write.test.js -m "feat(providers): upsertProvider rejects contradictory or malformed external-engine rows"
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
    - `pollExternalEngines({ cfg?, fetchImpl?, now?, timeoutMs? }) -> Promise<string[]>`. It never throws.
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
  EXTERNAL_ENGINE_PROBE_TIMEOUT_MS, DEFAULT_EXTERNAL_ENGINE_POLL_MS,
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
const cfgOne = (extra = {}) => ({ providers: {
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
  const two = { providers: {
    "raven-flash-next": extRow(),
    "raven-halogen-smoke": extRow({ baseUrl: "http://10.0.0.126:8031/v1" }),
    "cloud-openai": { baseUrl: "https://api.openai.com/v1", host: "cloud" },
  } };
  await pollExternalEngines({ cfg: two, fetchImpl: recorder(ok200), now: () => 1 });
  assert.deepEqual(Object.keys(ext()).sort(), ["raven-flash-next", "raven-halogen-smoke"]);

  const f = recorder(ok200);
  await pollExternalEngines({ cfg: { providers: {
    "raven-flash-next": extRow({ disabled: true }),
    "cloud-openai": { baseUrl: "https://api.openai.com/v1", host: "cloud" },
  } }, fetchImpl: f, now: () => 2 });
  assert.deepEqual(ext(), {}, "disabled one and removed one both pruned");
  assert.equal(f.calls.length, 0, "a disabled row is not probed");
});

test("an unreadable-config tick (empty providers map) prunes nothing — clocks survive", async () => {
  await pollExternalEngines({ cfg: cfgOne(), fetchImpl: recorder(ok200), now: () => 1000 });
  await pollExternalEngines({ cfg: { providers: {} }, fetchImpl: recorder(ok200), now: () => 2000 });
  assert.equal(ext()["raven-flash-next"].lastReadyAt, 1000);
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
  const bad = { get providers() { throw new Error("db unreadable"); } };
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
    try { await res?.body?.cancel?.(); } catch { /* the body is irrelevant */ }
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
 * on it). Prunes entries for rows no longer enabled+marked — but only when a
 * config was actually read: loadProviders() returns {providers:{}} when the
 * DB and models.json are both unreadable, and pruning on that would wipe
 * every ready-once clock (the residency poll's reviewed CRITICAL).
 */
export async function pollExternalEngines(opts = {}) {
  const probed = [];
  try {
    const cfg = opts.cfg !== undefined ? opts.cfg : loadProviders();
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
    if (Object.keys(providers).length > 0) pruneExternal(targets.map(([n]) => n));
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

### Task 4: Nest `providersSignal` gains external engines (D4, nest)

**Files:**
- Modify: `servers/gateway/dashboard/panels/nest/health-signals.js` (the i18n import at :27, the header comment, and `providersSignal` at :704)
- Modify: `servers/gateway/dashboard/shared/i18n.js` (after `"signals.providers.action"`)
- Test: `tests/providers-health-signal.test.js`

**Interfaces:**
- Consumes: `getProviderHealth().external` and `recordExternal` (Task 3); `fill` from `i18n.js` (already exported).
- Produces: the same signal object shape `{ id: "providers", severity, state, label, value, issueLabel?, actionLabel?, actionHref? }`. `state` can now also be `"info"`.

Rules:
- An external engine that is ready counts as up.
- An engine that is not ready with `lastReadyAt == null` has never answered here. It becomes info, never warn.
- An engine that is not ready and has been silent for at least the threshold since `lastReadyAt` is down and becomes warn.
- An engine that is not ready but under the threshold is shown only in the `{up}/{n}` count.
- Every warn source (residency down and external down) folds into **one** issue.
- The existing residency-only copy stays byte-identical.

- [ ] **Step 1: Write the failing tests**

In `tests/providers-health-signal.test.js`, change the provider-health import to:

```js
import {
  setResidencyInitialized, recordResidency, recordExternal, _resetProviderHealth,
} from "../servers/gateway/provider-health.js";
```

Append to the END of the file:

```js
// --- external engines (spec 2026-09-23 external-engine-provider §2.4) -------

const RAVEN = "http://10.0.0.126:8030/v1";
function ext(ready, nowMs, extra = {}) {
  recordExternal("raven-flash-next", { ready, nowMs, baseUrl: RAVEN, engineHost: "raven", label: "halogen", ...extra });
}

test("external only, ready → ok, value shows 1/1 external up, no issue", async () => {
  _resetProviderHealth();
  setResidencyInitialized();
  ext(true, NOW);
  const { detail, issue } = await providers({ now: at(NOW) });
  assert.equal(detail.state, "ok");
  assert.equal(issue, undefined);
  assert.match(detail.value, /1\/1 external up/);
});

test("never ready in this process → INFO naming engine + host, never warn — even hours later", async () => {
  _resetProviderHealth();
  setResidencyInitialized();
  ext(false, NOW, { error: "timeout after 3000ms" });
  const { detail, issue, all } = await providers({ now: at(NOW + 10 * 60 * MIN) });
  assert.equal(detail.state, "info");
  assert.equal(issue.severity, "info");
  assert.match(issue.label, /halogen/);
  assert.match(issue.label, /raven/);
  assert.match(detail.value, /not reachable from this instance/);
  assert.equal(all.ok, true, "info never flips the nest to not-ok");
});

test("ready once, then down UNDER the threshold → ok, no issue, 0/1 up", async () => {
  _resetProviderHealth();
  setResidencyInitialized();
  ext(true, NOW);
  ext(false, NOW + 1 * MIN);
  const { detail, issue } = await providers({ now: at(NOW + 5 * MIN) });
  assert.equal(detail.state, "ok");
  assert.equal(issue, undefined);
  assert.match(detail.value, /0\/1 external up/);
});

test("ready once, then down OVER the threshold → one warn naming engine + host; no placeholder left", async () => {
  _resetProviderHealth();
  setResidencyInitialized();
  ext(true, NOW);
  ext(false, NOW + 1 * MIN);
  const { detail, issue } = await providers({ now: at(NOW + THRESHOLD + MIN) });
  assert.equal(detail.state, "warn");
  assert.equal(issue.severity, "warn");
  assert.match(detail.value, /halogen on raven unreachable/);
  assert.match(issue.label, /halogen/);
  assert.match(issue.label, /raven/);
  assert.match(issue.label, /raven-flash-next/);
  for (const s of [detail.value, issue.label]) assert.doesNotMatch(s, /\{[a-z]+\}/);
});

test("a residency outage and an external outage fold into exactly ONE warn issue naming both", async () => {
  _resetProviderHealth();
  setResidencyInitialized();
  recordResidency("crow-voice", { ready: false, nowMs: NOW, baseUrl: "http://x:8011/v1", embed: false });
  ext(true, NOW);
  ext(false, NOW + 1 * MIN);
  const { detail, all } = await providers({ now: at(NOW + THRESHOLD + MIN) });
  assert.equal(detail.state, "warn");
  const issues = all.issues.filter((i) => i.id === "providers");
  assert.equal(issues.length, 1);
  assert.match(issues[0].label, /2/);
  assert.match(issues[0].label, /crow-voice/);
  assert.match(issues[0].label, /halogen \(raven\)/);
});

test("a residency warn wins over an external never-ready info (one issue, warn)", async () => {
  _resetProviderHealth();
  setResidencyInitialized();
  recordResidency("crow-voice", { ready: false, nowMs: NOW, baseUrl: "http://x:8011/v1", embed: false });
  ext(false, NOW);
  const { detail, all } = await providers({ now: at(NOW + THRESHOLD + MIN) });
  assert.equal(detail.state, "warn");
  assert.equal(all.issues.filter((i) => i.id === "providers").length, 1);
  assert.match(all.issues.find((i) => i.id === "providers").label, /crow-voice/);
});

test("free-text label/host render verbatim through fill() — '$&' is not a replacement pattern", async () => {
  _resetProviderHealth();
  setResidencyInitialized();
  recordExternal("raven-flash-next", { ready: false, nowMs: NOW, baseUrl: RAVEN, engineHost: "r$&n", label: "h$'x" });
  const { detail } = await providers({ now: at(NOW) });
  assert.match(detail.value, /h\$'x \(r\$&n\)/);
});

test("Spanish: the info copy is translated and still names engine + host", async () => {
  _resetProviderHealth();
  setResidencyInitialized();
  ext(false, NOW);
  invalidateHealthCache();
  _resetReceiveHealth();
  const r = await collectHealthSignals(db, { now: at(NOW), lang: "es" });
  const issue = r.issues.find((i) => i.id === "providers");
  assert.match(issue.label, /motor externo/i);
  assert.match(issue.label, /halogen/);
  assert.match(issue.label, /raven/);
});

test("EN and ES render for all 7 new external-engine keys", () => {
  const keys = [
    "signals.providers.external",
    "signals.providers.externalDown",
    "signals.providers.externalDownIssue",
    "signals.providers.downIssueAny",
    "signals.providers.externalUnreachable",
    "signals.providers.externalUnreachableMulti",
    "signals.providers.externalUnreachableIssue",
  ];
  for (const key of keys) {
    for (const lang of ["en", "es"]) {
      const rendered = t(key, lang);
      assert.notEqual(rendered, key, `missing i18n for ${key} (${lang})`);
    }
    assert.notEqual(t(key, "es"), t(key, "en"), `${key}: es must be a real translation`);
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `export PATH=/home/kh0pp/.nvm/versions/node/v24.21.0/bin:$PATH && cd ~/crow-wt-external-engine && npm test -- tests/providers-health-signal.test.js`

Expected: FAIL. The new external tests fail: for example, "external only, ready" gets `off` where it expects `ok`, and the i18n test reports a missing key. The pre-existing tests still pass.

- [ ] **Step 3: Add the i18n keys**

In `servers/gateway/dashboard/shared/i18n.js`, find:

```js
  "signals.providers.action": { en: "Open model health", es: "Ver estado de modelos" },
```

Replace it with:

```js
  "signals.providers.action": { en: "Open model health", es: "Ver estado de modelos" },
  // External engines (spec 2026-09-23 external-engine-provider §2.4)
  "signals.providers.external": { en: "{up}/{n} external up", es: "{up}/{n} externos activos" },
  "signals.providers.externalDown": { en: "{label} on {host} unreachable ≥{age}", es: "{label} en {host} inaccesible ≥{age}" },
  "signals.providers.externalDownIssue": { en: "The external engine {label} on {host} has stopped answering; requests routed to {name} fail until it recovers.", es: "El motor externo {label} en {host} ha dejado de responder; las solicitudes dirigidas a {name} fallan hasta que se recupere." },
  "signals.providers.downIssueAny": { en: "{n} model providers are unreachable ({names}); requests routed to them fall back or fail until they recover.", es: "{n} proveedores de modelos están inaccesibles ({names}); las solicitudes dirigidas a ellos recurren a alternativas o fallan hasta que se recuperen." },
  "signals.providers.externalUnreachable": { en: "{label} ({host}) not reachable from this instance", es: "{label} ({host}) no es accesible desde esta instancia" },
  "signals.providers.externalUnreachableMulti": { en: "{n} external engines not reachable from this instance", es: "{n} motores externos no son accesibles desde esta instancia" },
  "signals.providers.externalUnreachableIssue": { en: "The external engine {label} on {host} has not answered from this instance — expected when a firewall keeps this instance off its network.", es: "El motor externo {label} en {host} no ha respondido desde esta instancia; es lo esperado si un cortafuegos deja esta instancia fuera de su red." },
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
 *               + external engines (ready-once then silent ≥threshold → warn;
 *               never ready here → info, never warn)
```

Replace the whole `async function providersSignal(lang, nowFn) { … }` with:

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

  // External engines (spec 2026-09-23 §2.4). Warn ONLY for an engine that has
  // answered at least once in THIS process and has since been silent for
  // >= threshold. One that has never answered here is info — a peer the
  // firewall keeps off the engine's LAN (black-swan) must never carry a
  // permanent warning. Labels/hosts are free text replicated from peers, so
  // they go through fill() (no $-pattern mangling); the nest escapes HTML.
  const extDown = [];
  const extNever = [];
  let extUp = 0;
  for (const name of extNames) {
    const e = external[name];
    const who = { name, label: e.label || name, host: e.engineHost || "?" };
    if (e.ready) { extUp++; continue; }
    if (e.lastReadyAt == null) { extNever.push(who); continue; }
    if (now - e.lastReadyAt >= threshold) extDown.push({ ...who, age: formatAge(now - e.lastReadyAt) });
  }

  const totalDown = down.length + extDown.length;
  if (totalDown > 0) {
    let value;
    let issueLabel;
    if (extDown.length === 0) {
      value = down.length === 1
        ? t("signals.providers.down", lang).replace("{name}", down[0].name).replace("{age}", down[0].age)
        : t("signals.providers.downMulti", lang).replace("{n}", String(down.length));
      // Always NAME the provider when exactly one is down — this string becomes the
      // notification title (post-listen.js sets title: issue.label). The embed-vs-voice
      // split is derived from the provider's own embed flag, never hardcoded: crow only
      // ever owns crow-voice, which carries no embed model.
      if (down.length === 1) {
        const key = down[0].embed ? "signals.providers.downIssueEmbed" : "signals.providers.downIssue";
        issueLabel = t(key, lang).replace("{name}", down[0].name);
      } else {
        issueLabel = t("signals.providers.downIssueMulti", lang)
          .replace("{n}", String(down.length))
          .replace("{names}", down.map(d => d.name).join(", "));
      }
    } else if (totalDown === 1) {
      const d = extDown[0];
      value = fill(t("signals.providers.externalDown", lang), { label: d.label, host: d.host, age: d.age });
      issueLabel = fill(t("signals.providers.externalDownIssue", lang), { label: d.label, host: d.host, name: d.name });
    } else {
      const list = [...down.map((d) => d.name), ...extDown.map((d) => `${d.label} (${d.host})`)];
      value = fill(t("signals.providers.downMulti", lang), { n: totalDown });
      issueLabel = fill(t("signals.providers.downIssueAny", lang), { n: totalDown, names: list.join(", ") });
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
  if (extNames.length > 0) {
    parts.push(fill(t("signals.providers.external", lang), { up: extUp, n: extNames.length }));
  }

  if (extNever.length > 0) {
    const one = extNever.length === 1;
    const unreachable = one
      ? fill(t("signals.providers.externalUnreachable", lang), { label: extNever[0].label, host: extNever[0].host })
      : fill(t("signals.providers.externalUnreachableMulti", lang), { n: extNever.length });
    parts.push(unreachable);
    const issueLabel = one
      ? fill(t("signals.providers.externalUnreachableIssue", lang), { label: extNever[0].label, host: extNever[0].host })
      : unreachable;
    return { id: "providers", severity: "info", state: "info", label, value: parts.join(" · "), issueLabel, ...action };
  }
  return { id: "providers", severity: null, state: "ok", label, value: parts.join(" · ") };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `export PATH=/home/kh0pp/.nvm/versions/node/v24.21.0/bin:$PATH && cd ~/crow-wt-external-engine && npm test -- tests/providers-health-signal.test.js tests/i18n-global-parity.test.js tests/messages-health-signal.test.js`

Expected: PASS, 0 failures. The pre-existing residency tests prove the residency-only copy is unchanged.

- [ ] **Step 6: Commit**

```bash
cd ~/crow-wt-external-engine
git commit servers/gateway/dashboard/panels/nest/health-signals.js servers/gateway/dashboard/shared/i18n.js tests/providers-health-signal.test.js -m "feat(nest): providers signal watches external engines (warn after ready-once, info if never reachable here)"
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

A provider row can declare that **another machine runs the engine**: `gpu_policy.engine = { managed: "external", host: "<machine>", label?: "<engine>" }` (today: halogen on raven, rows `raven-flash-next` and `raven-halogen-smoke`). `managed` must be exactly `"external"`, the only value defined. `host` is a display label, never a routing input, and `providers.host` stays `cloud` (the tab shows "network" + "external · raven"). The helper is `isExternalEngine` in `servers/shared/provider-engine.js`. `gpu_policy` replicates, so every paired instance learns that the row is not its to manage.

**Never orchestrated.** Every orchestrator path checks the marker first. `maybeAcquireLocalProvider` returns `null`, so the caller dials `base_url` directly, exactly as for a cloud row. `acquireProvider` throws `ExternalEngineError` (`code: "external_engine"`). `resolveWarmableProviderName` returns `null`. `ensureResident` skips the row and logs once per provider. The row is never a mutex sibling (so it is never evicted), never a mutex-group member, and never an idle-revert default.

**Write validation.** `upsertProvider` refuses the following:
- a malformed marker (`EXTERNAL_ENGINE_INVALID`);
- a marker combined with a `bundleId` or `runtime: "native"`, judged on the effective policy after the upsert's `COALESCE` (`EXTERNAL_ENGINE_CONFLICT`);
- a single write that replaces a marked row's policy with an orchestratable one (`EXTERNAL_ENGINE_CONFLICT`). To convert such a row, first unmark it with its own write (no `engine`, no bundle, no native runtime), then register.

**Read-only health.** `servers/gateway/external-engine-poll.js` is armed by `initOrchestrator` next to the residency monitor.
- Every `CROW_EXTERNAL_ENGINE_POLL_MS` (default 60000; `0` disables it; the scratch test suite sets `0`), each enabled marked row gets one `GET <base_url>/models` with no auth header and a 3 s timeout. 2xx means ready.
- Results land in `getProviderHealth().external` (`servers/gateway/provider-health.js`). Disabled and removed rows are pruned from it.
- Each instance probes from its own network position.

**Surfacing.** The nest `providers` signal treats an engine that answered once and has since been silent for at least `CROW_PROVIDER_NOT_READY_WARN_MS` (default 10 min) as a **warn** that names the engine and host. An engine that has never answered from this instance is **info** only, so a peer that a firewall keeps off raven's LAN (black-swan) never carries a permanent warning. The Settings > LLM > Providers dot for a marked row shows this instance's probe result: reachable, not reachable, or not probed yet.

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

Do this only after the PR is merged, CI check-runs are green, and both crow gateways have auto-updated to the merge commit. Confirm with `git -C ~/crow log -1 --oneline`, and check that `auto_update_last_result` is not "Skipped". pi-lab cleared the probe to run at any time (spec §2.6), and this step starts no model, so no `CROW-SCHEDULE.md` reservation is needed.

Mark the two rows **on crow**. The instance is `crow-gateway.service` with `WorkingDirectory=/home/kh0pp/crow` and the default data dir `~/.crow/data`. Use the normal provider-update path: `upsertProvider(db, { ...row, gpuPolicy: { ...row.gpuPolicy, engine } })` in `servers/shared/providers-db.js`, where `row` comes from `listProvidersAll(db)`. This is the same read-spread-upsert shape that the Providers tab's `llm_provider_enable` action and `reenableProviderPreservingContent` use. `upsertProvider` bumps `lamport_ts` and calls `emitOrQueue`. With no live sync manager in a one-shot process, the change is queued in the sync outbox, and the running gateway drains it to peers (r4, black-swan, grackle).

This is a deliberate operator write against the live DB. It is **not** a test, so it runs as a one-shot `node` process from the deployed checkout:

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v24.21.0/bin:$PATH
cd ~/crow
node --input-type=module -e '
import { createDbClient } from "./servers/db.js";
import { listProvidersAll, upsertProvider } from "./servers/shared/providers-db.js";
const ENGINE = { managed: "external", host: "raven", label: "halogen" };
const db = createDbClient();
try {
  const all = await listProvidersAll(db);
  for (const id of ["raven-flash-next", "raven-halogen-smoke"]) {
    const row = all.find((r) => r.id === id);
    if (!row) { console.log(id, "MISSING — stop and investigate"); continue; }
    if (row.bundleId || row.gpuPolicy?.runtime === "native") { console.log(id, "has bundle/native — refusing, investigate"); continue; }
    const res = await upsertProvider(db, { ...row, gpuPolicy: { ...(row.gpuPolicy || {}), engine: ENGINE } });
    console.log(id, JSON.stringify(res));
  }
} finally { db.close(); }
'
```

Verify:
1. Re-read both rows with `listProvidersAll`. Each should have `gpuPolicy.engine` equal to `{managed:"external",host:"raven",label:"halogen"}` and `host === "cloud"`.
2. Within about 90 s (30 s providers cache plus the 60 s tick), crow's Settings > LLM > Providers shows the "external · raven" badge on both rows, with a green dot if halogen is up or a muted "not probed yet" dot before the first tick. The gateway journal shows `[external-engines] read-only poll armed: every 60000ms` from boot.
3. Replication: after the outbox drains, the r4 instance (`CROW_DATA_DIR=/home/kh0pp/.crow-r4/data`) has the marker on both rows. Check read-only with the same `listProvidersAll` one-liner run with `CROW_DATA_DIR=/home/kh0pp/.crow-r4/data CROW_HOME=/home/kh0pp/.crow-r4`, without the upsert. Black-swan should then show the engines as info ("not reachable from this instance"), not warn.
4. To roll back, run the same one-liner with `gpuPolicy: { ...rest }`, where `rest` is the row's `gpuPolicy` minus `engine`. This is the explicit unmark write the validation expects.
