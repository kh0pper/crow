# serving.class Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every model catalog entry carries a curated `serving.class`. The
gateway refuses to start a cold `windowed` or `wedge-risk` native model
unless an explicit override names the class. The dashboard never offers a
one-tap start for either.

**Architecture:**
- A pure module `servers/gateway/models/serving-class.js` owns the vocabulary
  and the refusal decision.
- The validator enforces the field in CI.
- `acquireOrStartNative`, the single native spawn funnel, calls the module
  after the resident fast path and before the reservation gate.
- Each caller maps the typed error the same way it already maps
  `ReservedError`.
- The panel and the catalog API expose the class and withhold the Start
  affordance.

**Tech Stack:** Node 24 ESM, `node:test`, Express, better-sqlite3/libsql (tests only).

**Spec:** `docs/superpowers/specs/2026-09-23-serving-class-design.md`. Read it
first. Decisions D1–D8 are binding.

## Global Constraints

- Worktree: `~/crow-wt-serving-class`, branch `feat/serving-class`.
  `node_modules` is a symlink to `~/crow/node_modules`; never commit it.
- Node 24:
  - Every shell starts with `export PATH=/home/kh0pp/.nvm/versions/node/v24.21.0/bin:$PATH`.
  - Tests run as `npm test -- tests/<file>.test.js`. **Never use raw
    `node --test`**, which writes to the live DB.
- Commit with a path: `git commit <paths> -m "..."`, never a bare
  `git commit` after `git add`. Run `git show --stat HEAD` after each commit.
- The class values are exactly `resident`, `windowed` and `wedge-risk`.
  - Error code `serving_class_refused`.
  - HTTP 409.
  - Models-route code `SERVING_CLASS_REFUSED`.
  - Request body field `serving_override`; opts field `servingOverride`.
- `SINGLE_BOX_RAM_MB = 126976`.
- An override must equal the class exactly (D5).
- An uncurated entry (not in the catalog, or the catalog is unreadable) is
  allowed (D6).
- Only the models-panel start API forwards an override (D7). The dashboard
  renders no override button of any kind (D8).
- Every new i18n key needs both `en` and `es` (a global parity gate is live).
- `servers/gateway/dashboard/panels/*` client scripts are built inside
  template literals. **Never put a backtick inside client JS strings there.**
- Do not bump `registry/model-catalog.json` `version`, and do not change any
  other catalog field.

## Review Focus

1. **A model that is already running is never refused**, even if its class
   is `wedge-risk`, because the fast path returns before the check. Pinned in
   Task 3.
2. **A cross-class override** (`windowed` on a `wedge-risk` model) is
   refused. Pinned in Tasks 1 and 3.
3. **Residency or boot with `alwaysResident` on a `wedge-risk` model** must
   neither crash boot nor spawn. `ensureResident` returns `false`. Pinned in
   Task 3.
4. **Refusals must not collapse into a generic 502 or START_FAILED.**
   `maybeAcquireLocalProvider` must rethrow. Pinned in Tasks 3 and 4.
5. **The runtime strip's Start button** is a second one-tap surface for a
   registered model. It must also be withheld. Pinned in Task 5.
6. **A reserved box and a wedge-risk model together**: the permanent refusal must win over `box_reserved`, so the check runs before `startBlockedBy`. Pinned in Task 3.

---

### Task 1: `serving-class.js` module

**Files:**
- Create: `servers/gateway/models/serving-class.js`
- Test: `tests/serving-class.test.js`

**Interfaces:**
- Produces:
  - `SERVING_CLASSES: string[]`
  - `SINGLE_BOX_RAM_MB: number`
  - `servingClassOf(entry): string|null`
  - `class ServingClassError extends Error { code, http, servingClass, provider }`
  - `servingClassRefusal(entry, providerName, override): ServingClassError|null`
  - `startAffordance(servingClass): "start"|"window-only"|"never"`

- [ ] **Step 1: Write the failing test** `tests/serving-class.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SERVING_CLASSES, SINGLE_BOX_RAM_MB, servingClassOf, ServingClassError,
  servingClassRefusal, startAffordance,
} from "../servers/gateway/models/serving-class.js";

const e = (cls) => ({ id: "m", serving: { class: cls } });

test("vocabulary and constant", () => {
  assert.deepEqual(SERVING_CLASSES, ["resident", "windowed", "wedge-risk"]);
  assert.equal(SINGLE_BOX_RAM_MB, 126976);
});

test("servingClassOf: valid class, else null", () => {
  assert.equal(servingClassOf(e("windowed")), "windowed");
  assert.equal(servingClassOf(e("bogus")), null);
  assert.equal(servingClassOf({ id: "m" }), null);
  assert.equal(servingClassOf(null), null);
  assert.equal(servingClassOf({ serving: "wedge-risk" }), null);
});

test("refusal matrix: resident/uncurated always allowed; others need the exact class as override", () => {
  assert.equal(servingClassRefusal(e("resident"), "p", undefined), null);
  assert.equal(servingClassRefusal(null, "p", undefined), null, "uncurated → allowed (D6)");
  assert.equal(servingClassRefusal({ id: "m" }, "p", undefined), null);
  for (const cls of ["windowed", "wedge-risk"]) {
    const err = servingClassRefusal(e(cls), "prov-x", undefined);
    assert.ok(err instanceof ServingClassError);
    assert.equal(err.code, "serving_class_refused");
    assert.equal(err.http, 409);
    assert.equal(err.servingClass, cls);
    assert.equal(err.provider, "prov-x");
    assert.match(err.message, new RegExp(cls));
    assert.equal(servingClassRefusal(e(cls), "p", cls), null, "exact override allows");
    assert.ok(servingClassRefusal(e(cls), "p", true) instanceof ServingClassError, "boolean override is not an override");
  }
  assert.ok(servingClassRefusal(e("wedge-risk"), "p", "windowed") instanceof ServingClassError, "cross-class override refused");
  assert.ok(servingClassRefusal(e("windowed"), "p", "wedge-risk") instanceof ServingClassError, "cross-class override refused");
});

test("startAffordance", () => {
  assert.equal(startAffordance("resident"), "start");
  assert.equal(startAffordance(null), "start");
  assert.equal(startAffordance("windowed"), "window-only");
  assert.equal(startAffordance("wedge-risk"), "never");
});
```

- [ ] **Step 2:** Run `npm test -- tests/serving-class.test.js`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `servers/gateway/models/serving-class.js`:

```js
/**
 * serving.class — a curated safety CEILING on a model catalog entry
 * (spec docs/superpowers/specs/2026-09-23-serving-class-design.md).
 *
 * resident   — single box, no RPC, safe behind a cap: starts as today.
 * windowed   — operator present, two-box and/or evicts production.
 * wedge-risk — a shape that has wedged the box; never one-tap.
 *
 * The class lives in the git-reviewed catalog, never in instance settings:
 * settings may narrow what a box runs, never widen it. Pure, no I/O.
 */

export const SERVING_CLASSES = ["resident", "windowed", "wedge-risk"];

/** One Strix Halo box's GTT total (crow mem_info_gtt_total, 2026-09-23). A
 *  quant needing more RAM than this cannot run single-box, so its model
 *  cannot be `resident` (enforced by scripts/validate-model-catalog.js). */
export const SINGLE_BOX_RAM_MB = 126976;

export function servingClassOf(entry) {
  const cls = entry && entry.serving && typeof entry.serving === "object" ? entry.serving.class : null;
  return SERVING_CLASSES.includes(cls) ? cls : null;
}

export class ServingClassError extends Error {
  constructor(servingClass, providerName) {
    super(`${providerName || "model"} is a ${servingClass} model — the gateway will not start it without an explicit serving_override of "${servingClass}"; heavy models run through an operator window`);
    this.name = "ServingClassError";
    this.code = "serving_class_refused";
    this.http = 409;
    this.servingClass = servingClass;
    this.provider = providerName || null;
  }
}

/** The refusal for starting `entry` as `providerName`, or null when allowed.
 *  Allowed: resident, uncurated (null class), or override === class. */
export function servingClassRefusal(entry, providerName, override) {
  const cls = servingClassOf(entry);
  if (cls === null || cls === "resident") return null;
  if (typeof override === "string" && override === cls) return null;
  return new ServingClassError(cls, providerName);
}

/** What the dashboard may offer for a registered, stopped model of this class. */
export function startAffordance(servingClass) {
  if (servingClass === "windowed") return "window-only";
  if (servingClass === "wedge-risk") return "never";
  return "start";
}
```

- [ ] **Step 4:** Run the same test. Expected: PASS.
- [ ] **Step 5:** Commit: `git add servers/gateway/models/serving-class.js tests/serving-class.test.js && git commit servers/gateway/models/serving-class.js tests/serving-class.test.js -m "feat(models): serving-class module — vocabulary, refusal, start affordance"`

---

### Task 2: Catalog field and validator rules

**Files:**
- Modify: `registry/model-catalog.json`: add `"serving": { "class": … }` to all 11 model entries, placed directly after `"tags"`.
- Modify: `scripts/validate-model-catalog.js`: the per-model loop (near the `chat_template_kwargs` and `launch` checks, ~:207-222) and the `first_run_default` block (~:320-334). Also extend the header comment's schema notes with a one-line `serving` entry.
- Test: `tests/model-catalog-validate.test.js` (append).

**Interfaces:**
- Consumes: `SERVING_CLASSES`, `SINGLE_BOX_RAM_MB`, `servingClassOf` from Task 1. Import them with a relative path from `../servers/gateway/models/serving-class.js`. The validator already imports `validateLaunch` from `servers/gateway/models/launch.js` the same way; check that import line and mirror it.
- Class assignments (spec §2):
  - `deepseek-v4-flash`: `wedge-risk`.
  - `glm-5.3-flash`: `windowed`.
  - Every other entry, including `qwen3.8-flash-next`: `resident`.

- [ ] **Step 1: Write failing tests** (append to `tests/model-catalog-validate.test.js`). That file already imports `validateCatalog` (:3) and `readFileSync` (:6); use those names and add no aliased re-imports. Two fixtures exist:
  - `loadSeed()` (:12) reads the real catalog. Its `models[0]` is `qwen3.5-4b`, the `first_run_default`, which the D3 test needs, because the D3 check only runs in the "exactly one default" branch (:325).
  - `makeV2Catalog()` (:208-270) is a synthetic catalog used by about 20 tests, several of which assert `errors == []`. **Add `serving: { class: "resident" }` to both of its models (`fixture-small`, `fixture-sharded`) in this step**, or those tests fail once `serving` is required.

```js
// ─── serving.class (spec 2026-09-23) ───
function withModel(mutate) {
  const cat = structuredClone(loadSeed()); // real catalog; models[0] = qwen3.5-4b (first_run_default)
  mutate(cat.models[0], cat);
  return validateCatalog(cat);
}

test("serving: the real catalog validates and every entry has a class", () => {
  const real = loadSeed();
  const r = validateCatalog(real);
  assert.deepEqual(r.errors, []);
  for (const m of real.models) assert.ok(m.serving && m.serving.class, `${m.id} has serving.class`);
  const by = Object.fromEntries(real.models.map((m) => [m.id, m.serving.class]));
  assert.equal(by["deepseek-v4-flash"], "wedge-risk");
  assert.equal(by["glm-5.3-flash"], "windowed");
  assert.equal(by["qwen3.8-flash-next"], "resident");
});

test("serving: missing → error (D1, required)", () => {
  const r = withModel((m) => { delete m.serving; });
  assert.ok(r.errors.some((e) => /serving/.test(e)), r.errors.join("\n"));
});

test("serving: unknown class and unknown key inside serving → errors", () => {
  assert.ok(withModel((m) => { m.serving = { class: "safe" }; }).errors.some((e) => /serving\.class/.test(e)));
  assert.ok(withModel((m) => { m.serving = { class: "resident", note: "x" }; }).errors.some((e) => /serving.*note/.test(e)));
  assert.ok(withModel((m) => { m.serving = "resident"; }).errors.some((e) => /serving/.test(e)));
});

test("serving: arithmetic — a quant above SINGLE_BOX_RAM_MB cannot be resident (D2)", () => {
  const over = withModel((m) => { m.serving = { class: "resident" }; m.quants[0].min_ram_mb = 157911; });
  assert.ok(over.errors.some((e) => /126976/.test(e)), over.errors.join("\n"));
  const overWindowed = withModel((m) => { m.serving = { class: "windowed" }; m.quants[0].min_ram_mb = 157911; m.first_run_default = false; });
  assert.ok(!overWindowed.errors.some((e) => /126976/.test(e)));
  const under = withModel((m) => { m.serving = { class: "resident" }; m.quants[0].min_ram_mb = 115068; });
  assert.ok(!under.errors.some((e) => /126976/.test(e)));
});

test("serving: first_run_default must be resident (D3); two-box tag cannot be resident (D4)", () => {
  // The fixture's first model is (or is made) the first_run_default.
  const frd = withModel((m) => { m.first_run_default = true; m.serving = { class: "windowed" }; });
  assert.ok(frd.errors.some((e) => /first_run_default.*resident/.test(e)), frd.errors.join("\n"));
  const tb = withModel((m) => { m.tags = [...(m.tags || []), "two-box"]; m.serving = { class: "resident" }; });
  assert.ok(tb.errors.some((e) => /two-box/.test(e)), tb.errors.join("\n"));
});
```

Note: `withModel` mutates the seed. The seed only gets `serving` in Step 3, so until then every `withModel` result also carries "serving is required" errors for the other models. The regexes above are specific enough that this does not cause false passes; check each expected failure message in Step 2's output.

- [ ] **Step 2:** Run `npm test -- tests/model-catalog-validate.test.js`. Expected: the new tests FAIL.

- [ ] **Step 3: Implement.** In the per-model loop, where `label` is the model's label variable already used there:

```js
    {
      const sv = model.serving;
      if (sv === undefined) {
        errors.push(`${label}: serving is required ({ "class": ${SERVING_CLASSES.map((c) => `"${c}"`).join(" | ")} })`);
      } else if (!sv || typeof sv !== "object" || Array.isArray(sv)) {
        errors.push(`${label}: serving must be an object, got ${JSON.stringify(sv)}`);
      } else {
        for (const k of Object.keys(sv)) if (k !== "class") errors.push(`${label}: unknown key serving.${k}`);
        if (!SERVING_CLASSES.includes(sv.class)) {
          errors.push(`${label}: serving.class must be one of ${SERVING_CLASSES.join(", ")}, got ${JSON.stringify(sv.class)}`);
        } else if (sv.class === "resident") {
          const big = (Array.isArray(model.quants) ? model.quants : []).find((q) => q && Number(q.min_ram_mb) > SINGLE_BOX_RAM_MB);
          if (big) errors.push(`${label}: serving.class "resident" but quant ${big.quant} needs min_ram_mb ${big.min_ram_mb} > ${SINGLE_BOX_RAM_MB} (one box) — use "windowed" or "wedge-risk"`);
          if (Array.isArray(model.tags) && model.tags.includes("two-box")) errors.push(`${label}: tagged two-box, so serving.class cannot be "resident"`);
        }
      }
    }
```

In the `first_run_default` else-branch, after the gated check:

```js
    if (servingClassOf(def) !== "resident") {
      errors.push(`first_run_default model "${def.id}" must be serving.class "resident" (onboarding downloads it one-tap)`);
    }
```

Then add the field to all 11 entries in `registry/model-catalog.json`, directly after each `"tags": [...]` line, e.g. `"serving": { "class": "resident" },`, and use the class assignments above. Keep the file's existing indentation and JSON style, and make no other changes.

- [ ] **Step 4:** Run `npm test -- tests/model-catalog-validate.test.js tests/model-catalog-launch-parity.test.js tests/model-catalog-client-contract.test.js`, then `npm run validate-model-catalog`. Expected: all PASS, and the validator prints OK.
- [ ] **Step 5:** Commit: `git commit registry/model-catalog.json scripts/validate-model-catalog.js tests/model-catalog-validate.test.js -m "feat(catalog): required serving.class on every model + validator rules"`

---

### Task 3: Orchestrator enforcement

**Files:**
- Modify: `servers/gateway/gpu-orchestrator.js`:
  - add an import;
  - `maybeAcquireLocalProvider` (~:569-590): rethrow;
  - `acquireOrStartNative` (~:993): add the check right after the resident fast path (~:1017-1034) and **before** the `startBlockedBy` block (~:1037-1040);
  - idle-revert's `acquireProvider` catch (~:1253-1256): route the refusal through the once-per-provider notice;
  - `_resetReservationNoticesForTest` (~:520): also clear `_servingNoticed`;
  - `ensureNativeResident` (~:1314): swallow the refusal.
- Test: create `tests/gpu-orchestrator-serving-class.test.js`.

**Interfaces:**
- Consumes: `servingClassRefusal` and `ServingClassError` (Task 1).
- Produces:
  - `acquireProvider`, `maybeAcquireLocalProvider` and `ensureResident` honour `opts.servingOverride`.
  - `maybeAcquireLocalProvider` rethrows `ServingClassError`.
  - `gpu-orchestrator.js` re-exports `ServingClassError` (`export { ServingClassError } from "./models/serving-class.js";`) so that routes can import it from either module.

- [ ] **Step 1: Write the failing test** `tests/gpu-orchestrator-serving-class.test.js`. Copy the `nativeProv`, `fakeHandle` and `startCapableOpts` helpers verbatim from `tests/gpu-orchestrator-native.test.js` (lines ~48-123), and read that file's header for why each seam exists. Then:

```js
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  acquireProvider, maybeAcquireLocalProvider, ensureResident, _setNativeHandleForTest,
  _setReservationReaderForTest, _resetReservationNoticesForTest,
} from "../servers/gateway/gpu-orchestrator.js";
import { ServingClassError } from "../servers/gateway/models/serving-class.js";
import { _resetProviderHealth } from "../servers/gateway/provider-health.js";

// …nativeProv / fakeHandle / startCapableOpts copied here…

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
beforeEach(() => { _resetProviderHealth(); _setNativeHandleForTest("native-target", null); _setReservationReaderForTest(() => null); _resetReservationNoticesForTest(); });

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
```

If `acquireProvider` needs the provider name to resolve through `opts.cfg` differently than shown, follow how `tests/gpu-orchestrator-native.test.js` calls `acquireProvider("native-target", …)` (e.g. its test at ~:477), and keep the assertions.

- [ ] **Step 2:** Run `npm test -- tests/gpu-orchestrator-serving-class.test.js`. Expected: FAIL (no refusal thrown).

- [ ] **Step 3: Implement.**

Import near the other model imports, plus the re-export:

```js
import { servingClassRefusal, ServingClassError } from "./models/serving-class.js";
export { ServingClassError } from "./models/serving-class.js";
```

In `acquireOrStartNative`, immediately **before** the `startBlockedBy` block (after the fast path's `// "down" — fall through` comment):

```js
  {
    // serving.class ceiling (spec 2026-09-23 §3.3): after the resident fast
    // path (a running model is never refused) and BEFORE the reservation
    // gate — a permanent refusal must not surface as a retryable box_reserved.
    // (A runtime-binary error in acquireProvider's pre-resolution can still
    // precede this; acceptable — that start could not have succeeded either.)
    // Uncurated (no catalog entry / unreadable catalog) is allowed (D6).
    const catalogId = p?.gpuPolicy?.catalogId || providerName;
    let entry = null;
    try {
      entry = ((opts.loadCatalogFn || defaultLoadCatalog)()?.models || []).find((m) => m.id === catalogId) || null;
    } catch (err) {
      console.warn(`[gpu-orchestrator] serving.class: catalog unreadable, treating ${providerName} as uncurated: ${err.message}`);
    }
    const refusal = servingClassRefusal(entry, providerName, opts.servingOverride);
    if (refusal) {
      console.log(`[gpu-orchestrator] refusing to start ${providerName}: serving.class ${refusal.servingClass} (requested-by=${opts.requester || "-"})`);
      throw refusal;
    }
  }
```

In `maybeAcquireLocalProvider`'s catch:

```js
    if (err instanceof ReservedError || err instanceof ServingClassError) throw err;
```

In `ensureNativeResident`'s catch, after the `ReservedError` line:

```js
    if (err instanceof ServingClassError) { noteServingRefused(name, err); return false; }
```

and next to `noteDeferred`:

```js
const _servingNoticed = new Set();
/** Residency never auto-starts a non-resident model; say so once per provider. */
function noteServingRefused(name, err) {
  if (_servingNoticed.has(name)) return;
  _servingNoticed.add(name);
  console.log(`[gpu-orchestrator] residency skipped ${name}: serving.class ${err.servingClass} never auto-starts`);
}
```

In `_resetReservationNoticesForTest`, add `_servingNoticed.clear();` (declare `_servingNoticed` above it, or move the declaration up).

In idle-revert's catch (~:1253-1256):

```js
      } catch (err) {
        if (err instanceof ServingClassError) noteServingRefused(group.default, err);
        else console.warn(`[gpu-orchestrator] auto-revert to ${group.default} failed: ${err.message}`);
      }
```

Also check that `ensureResident`'s own outer catch (it "never throws") does not already convert the error before `ensureNativeResident` sees it. The return value must be `false`.

- [ ] **Step 4:** Run `npm test -- tests/gpu-orchestrator-serving-class.test.js tests/gpu-orchestrator-native.test.js tests/gpu-orchestrator-reservation.test.js tests/gpu-orchestrator-host-gate.test.js`. Expected: all PASS. The existing native fixtures use catalogs with no `models`, so they are uncurated and unaffected.
- [ ] **Step 5:** Commit: `git commit servers/gateway/gpu-orchestrator.js tests/gpu-orchestrator-serving-class.test.js -m "feat(orchestrator): refuse cold non-resident serving.class starts at the native funnel"`

---

### Task 4: Caller mapping: models start route, llm-router, `/llm/acquire`, chat

**Files:**
- Modify: `servers/gateway/routes/models.js` (`POST /api/models/:id/start`, ~:576-620)
- Modify: `servers/gateway/routes/llm-router.js` (acquire catch ~:233-260; `/llm/acquire` ~:380-392)
- Modify: `servers/gateway/routes/chat.js` (add `servingClassRefusedError` next to `boxReservedError` ~:74; catch ~:720)
- Modify: `servers/gateway/dashboard/shared/i18n.js` (new key `chat.serving_class_refused`, next to `chat.box_reserved` ~:366)
- Test: append to `tests/models-panel.test.js`, `tests/llm-router-reserved.test.js` (or create `tests/llm-router-serving-class.test.js`, copying that file's harness), and the chat test that covers `boxReservedError` (`grep -ln boxReservedError tests/`).

**Interfaces:**
- Consumes:
  - `ServingClassError` from `servers/gateway/models/serving-class.js`;
  - the rethrow from Task 3;
  - `maybeAcquireLocalProviderFn`, the models router's injectable seam (see how `tests/models-panel.test.js` injects it);
  - `deps.acquireFn` and `deps.warmFn` in llm-router.
- Produces:
  - models start: 409 `{ error, code: "SERVING_CLASS_REFUSED", serving_class }`, and `req.body.serving_override` is forwarded as `servingOverride`;
  - router: 409 `{ error: { code: "serving_class_refused", message, serving_class } }`, or the escalate-degrade;
  - `/llm/acquire`: 409 `{ ok:false, error:"serving_class_refused", serving_class, message }`;
  - chat: an `error` event `{ message, code: "serving_class_refused", serving_class }`.

- [ ] **Step 1: Write failing tests.**
  - **models-panel:** a test that injects `maybeAcquireLocalProviderFn: async (id, opts) => { seen = opts; throw new ServingClassError("wedge-risk", id); }`. It POSTs `/api/models/deepseek-v4-flash/start` with body `{ serving_override: "wedge-risk" }` and asserts all of:
    - status 409;
    - `body.code === "SERVING_CLASS_REFUSED"`;
    - `body.serving_class === "wedge-risk"`;
    - `seen.servingOverride === "wedge-risk"`;
    - `seen.requester === "models-panel"`.

    A second test sends no body and asserts `seen.servingOverride === undefined`. Follow the existing start-route tests in that file for the session and network headers.
  - **llm-router:** mirror the reserved tests. One test has `acquireFn` throw `new ServingClassError("windowed", "glm")` on a non-escalate request, and asserts all of:
    - 409;
    - `error.code === "serving_class_refused"`;
    - no `Retry-After` header.

    A second test uses an escalate request with a live fast model (a stub `resolveKeyFn` or `probeReadyFn`, as the reserved degrade test does). It asserts the upstream call went to the fast model, and that the forwarded messages end with a system note matching `/operator window/`.
  - **`/llm/acquire`:** `warmFn` throws a `ServingClassError`, and the test asserts 409 with `error === "serving_class_refused"`.
  - **chat:** a unit test of the exported `servingClassRefusedError(err, "en")` asserts `code === "serving_class_refused"`, `serving_class`, and a message containing the provider name. Add an `es` check that the message differs from `en`.

- [ ] **Step 2:** Run those test files. Expected: the new tests FAIL.

- [ ] **Step 3: Implement.**

**models.js**: in the start route, pass the override and map the error:

```js
        const servingOverride = typeof req.body?.serving_override === "string" ? req.body.serving_override : undefined;
        result = await maybeAcquireLocalProviderFn(modelId, { requester: "models-panel", servingOverride, onError: (err) => { startError = err; } });
      } catch (err) {
        if (err && err.code === "box_reserved") { /* existing */ }
        if (err && err.code === "serving_class_refused") {
          return res.status(409).json({ error: err.message, code: "SERVING_CLASS_REFUSED", serving_class: err.servingClass || null });
        }
        throw err;
      }
```

Confirm that the router has JSON body parsing on that route. The download route already reads `req.body.force`, so mirror whatever it does.

**llm-router.js**:
- Import `ServingClassError` from `../models/serving-class.js`.
- In the acquire catch, before `if (!(err instanceof ReservedError)) throw err;`:

```js
    if (err instanceof ServingClassError) {
      const fast = escalate ? await deps.resolveKeyFn(FAST_KEY).catch(() => null) : null;
      if (fast && await deps.probeReadyFn(fast.baseUrl)) {
        key = FAST_KEY;
        [providerId] = splitKey(key);
        routeLabel = "degraded(serving_class)";
        body.messages = [
          ...(Array.isArray(body.messages) ? body.messages : []),
          { role: "system", content: `Note: ${err.provider || "the larger model"} is a ${err.servingClass} model that only runs in an operator window; answer with what you have.` },
        ];
      } else {
        console.log(`[llm-router] route=refused(serving_class) -> ${key} requester=${requester} class=${err.servingClass}`);
        return res.status(409).json({ error: { code: "serving_class_refused", message: err.message, serving_class: err.servingClass } });
      }
    } else if (!(err instanceof ReservedError)) {
      throw err;
    } else {
      // …the existing reservation handling, unchanged…
    }
```

Restructure only as much as needed to keep the reservation branch byte-identical in behaviour. `routeLabel` must be declared with `let` before this point; check that it is.

- In `/llm/acquire`'s catch:

```js
      if (err instanceof ServingClassError) {
        return res.status(409).json({ ok: false, error: "serving_class_refused", serving_class: err.servingClass, message: err.message });
      }
```

**chat.js**: add an export next to `boxReservedError`:

```js
export function servingClassRefusedError(err, lang) {
  return {
    message: fill(t("chat.serving_class_refused", lang), { provider: (err && err.provider) || "?", cls: (err && err.servingClass) || "?" }),
    code: "serving_class_refused",
    serving_class: (err && err.servingClass) || null,
  };
}
```

and in the warm catch, after the `box_reserved` branch:

```js
        if (err && err.code === "serving_class_refused") {
          sendEvent("error", servingClassRefusedError(err, lang));
          closeStream();
          return;
        }
```

**i18n.js**, next to `chat.box_reserved`:

```js
  "chat.serving_class_refused": { en: "{provider} is a {cls} model: it only runs in an operator-run window, never on demand from chat. Pick a resident model.", es: "{provider} es un modelo {cls}: solo se ejecuta en una ventana operada por una persona, nunca bajo demanda desde el chat. Elige un modelo residente." },
```

- [ ] **Step 4:** Run the touched test files plus `tests/chat-native-copy.test.js` and any i18n parity test (`ls tests | grep -i i18n`). Expected: PASS.
- [ ] **Step 5:** Commit: `git commit servers/gateway/routes/models.js servers/gateway/routes/llm-router.js servers/gateway/routes/chat.js servers/gateway/dashboard/shared/i18n.js <the test files> -m "feat(gateway): map serving.class refusals — models start 409 + override, router 409/degrade, acquire 409, chat error"`

---

### Task 5: Catalog API and panel affordances

**Files:**
- Modify: `servers/gateway/routes/models.js`: the `GET /api/models/catalog` shaping (~:236-262) adds `serving_class: servingClassOf(model)`.
- Modify: `servers/gateway/dashboard/panels/model-catalog.js`:
  - data shaping (~:159-185): add the same field;
  - `runtimeModels` (~:195): add `servingClass` by looking up `catalog.models` by `modelId`;
  - `renderRuntimeStrip` (Start at ~:484-485): no Start for non-resident;
  - client script: `ERROR_MESSAGES` (~:696) gains `SERVING_CLASS_REFUSED`; the post-download "Try in chat" swap (~:821-829) is suppressed for non-resident cards;
  - `renderModelCard` (~:536-588): badge, and the notice in place of Start.
- Modify: `servers/gateway/dashboard/shared/i18n.js`, adding the keys below.
- Test: append to `tests/models-panel.test.js` (API field) and `tests/models-panel-ui.test.js` (render). Update `tests/model-catalog-client-contract.test.js` if it pins the API field list.

**Interfaces:**
- Consumes: `servingClassOf` and `startAffordance` (Task 1). Import them in the panel as `import { servingClassOf, startAffordance } from "../../models/serving-class.js";` and in `routes/models.js` as `from "../models/serving-class.js"`.
- Produces:
  - API field `serving_class` (a string or `null`) on every catalog item;
  - card DOM: a badge `mcat-card__badge--serving-<class>`, and a notice `mcat-card__notice mcat-card__notice--serving` holding the i18n text;
  - no element with `data-action="start"` for that model id, on either the card or the runtime strip.

New i18n keys (`en` / `es`):

```js
  "models.servingWindowedBadge": { en: "Operator window", es: "Ventana del operador" },
  "models.servingWedgeRiskBadge": { en: "Wedge risk", es: "Riesgo de bloqueo" },
  "models.servingWindowedHint": { en: "Operator window only: this model runs two-box or evicts production, so it is never started from here.", es: "Solo en ventana del operador: este modelo usa dos equipos o desaloja producción, así que nunca se inicia desde aquí." },
  "models.errServingClassRefused": { en: "This model only runs in an operator window; it cannot be started here.", es: "Este modelo solo se ejecuta en una ventana del operador; no se puede iniciar aquí." },
  "models.servingWedgeRiskHint": { en: "Known wedge risk: this shape has hung the machine before. It is never started from the dashboard.", es: "Riesgo conocido de bloqueo: esta configuración ya colgó la máquina. Nunca se inicia desde el panel." },
```

- [ ] **Step 1: Write failing tests.**
  - **API:** extend the existing `GET /api/models/catalog: 200 with a valid session` style. Inject or use a catalog containing one `wedge-risk` model, and assert `serving_class === "wedge-risk"` on it. Assert `serving_class === "resident"` on a resident model.
  - **Card render:** in `tests/models-panel-ui.test.js`, follow how that file renders the panel with fixture data. Use a registered, not-running model with `serving_class: "wedge-risk"`, and assert:
    - the HTML contains `models.servingWedgeRiskHint`'s English text;
    - the HTML contains `mcat-card__badge--serving-wedge-risk`;
    - there is no `data-action="start" data-model-id="<id>"`.

    Repeat for `windowed`. For a registered `resident` model, assert that `data-action="start"` is still present.
  - **Runtime strip:** a registry entry whose `catalogId` is the wedge-risk model, not live. Assert no Start button for it in `renderRuntimeStrip`'s output.
  - **Download:** an unregistered wedge-risk model with a fitting quant still renders `data-action="download"`.
  - **Client contract** (`tests/model-catalog-client-contract.test.js`, which runs the real client script in linkedom): render a registered wedge-risk card with two or more quants, dispatch a `change` on its quant select, and assert that no `data-action="start"` and no `data-action="download"` element appears for that id. This pins the dependency on `refreshCardActions`' early return when a Remove button is present (~:748). Also assert `ERROR_MESSAGES` contains `SERVING_CLASS_REFUSED`, using whatever mechanism that file already uses to inspect the client script.

- [ ] **Step 2:** Run the tests. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - **Shaping:** in both the route and the panel, add `serving_class: servingClassOf(model),` to the returned object.
  - **runtimeModels:** build `const classById = new Map((catalog.models || []).map((m) => [m.id, servingClassOf(m)]));` once, before the map. Add `servingClass: classById.get(modelId) ?? null` to both returned object shapes.
  - **renderRuntimeStrip:** change `actionBtn`:

```js
    const affordance = startAffordance(m.servingClass ?? null);
    const actionBtn = m.live
      ? button(t("models.actionStop", lang), { variant: "secondary", size: "sm", attrs: `data-action="stop" data-model-id="${escapeHtml(m.modelId)}"` })
      : affordance === "start"
        ? button(t("models.actionStart", lang), { variant: "secondary", size: "sm", attrs: `data-action="start" data-model-id="${escapeHtml(m.modelId)}"` })
        : `<span class="mcat-strip__status">${escapeHtml(t(affordance === "never" ? "models.servingWedgeRiskBadge" : "models.servingWindowedBadge", lang))}</span>`;
```

  - **renderModelCard:**
    - After the existing badges, add:

```js
  const affordance = startAffordance(model.serving_class ?? null);
  if (affordance !== "start") {
    const key = affordance === "never" ? "models.servingWedgeRiskBadge" : "models.servingWindowedBadge";
    badges.push(`<span class="mcat-card__badge mcat-card__badge--serving-${escapeHtml(model.serving_class)}">${escapeHtml(t(key, lang))}</span>`);
  }
  const servingNotice = affordance === "start" ? "" :
    `<div class="mcat-card__notice mcat-card__notice--serving">${escapeHtml(t(affordance === "never" ? "models.servingWedgeRiskHint" : "models.servingWindowedHint", lang))}</div>`;
```

    - In the `else if (model.registered)` branch, emit `servingNotice` instead of the Start button when `affordance !== "start"`, and keep Remove.
    - Add CSS next to the existing badge rules: `.mcat-card__badge--serving-windowed` and `.mcat-card__badge--serving-wedge-risk` (use `var(--crow-error)` for wedge-risk and the existing warning colour token used by `--gated` for windowed; read the existing badge CSS to match).
    - Do not change the client script's quant-change re-render. It exits early when a Remove button exists, so **keep Remove on non-resident registered cards**; that is load-bearing.
    - In `ERROR_MESSAGES` add `SERVING_CLASS_REFUSED: '${tJs("models.errServingClassRefused", lang)}',` **before** the last entry (`HTTP_401`, ~:718, which has no trailing comma), so that the object literal stays valid.
    - In the post-download `job.status === "done"` branch, when `card.getAttribute("data-serving-class")` is `windowed` or `wedge-risk`, do not build the "Try in chat" link. Instead set the actions to the same notice text **plus a Remove button** (`data-action="remove" data-model-id=…`, the same markup and classes as the server-rendered Remove, so the delegated handler picks it up and `refreshCardActions`' Remove early return keeps a later quant change from restoring Download), as the server render: add `servingWindowedHint` and `servingWedgeRiskHint` via `tJs` into a small client map. Use single or double quotes only, **never backticks**.
    - Grep the client script for any code that creates a `data-action="start"` element client-side (`grep -n 'action="start"\|actionStart' servers/gateway/dashboard/panels/model-catalog.js`). If the client builds one after a download finishes, make it respect the class the same way. Pass the class through a `data-serving-class` attribute on the card root (`<div class="mcat-card" data-model-id=… data-serving-class="${escapeHtml(model.serving_class || "")}">`), and do not render Start when it is `windowed` or `wedge-risk`. **Always add `data-serving-class` to the card root**, because the post-download branch above reads it.

- [ ] **Step 4:** Run `npm test -- tests/models-panel.test.js tests/models-panel-ui.test.js tests/model-catalog-client-contract.test.js` and the i18n parity test. Expected: PASS.
- [ ] **Step 5:** Commit: `git commit servers/gateway/routes/models.js servers/gateway/dashboard/panels/model-catalog.js servers/gateway/dashboard/shared/i18n.js <tests> -m "feat(models-panel): serving_class in the catalog API; no one-tap start for windowed/wedge-risk"`

---

### Task 6: Full suite and docs

**Files:**
- Modify: `docs/architecture/` model docs. Find the models or gateway doc that describes the catalog fields (`grep -rln "first_run_default\|min_runtime_version" docs/architecture docs/developers`). Add a short `serving.class` subsection: the three classes, the fact that it is a ceiling living in the catalog and never in settings, what the gateway refuses, and the `serving_override` API.

- [ ] **Step 1:** Write the doc subsection (≤ 30 lines). Link the spec. Include a **Known limits** list:
  - A model fetched through the HF browser (`/hf-download`), or any provider whose `gpuPolicy.catalogId` is not a catalog id, is uncurated. It is allowed (D6), so a DeepSeek GGUF fetched that way gets no ceiling.
  - An `alwaysResident` non-resident model is never started, and `pollResidency` reports it as down. That is honest, but it is a misconfiguration.
  - The bot model picker (`model-availability.js`) still lists a refused native model as `on_demand`. Picking it yields the refusal error, not a hang.
- [ ] **Step 2:** Run `npm test` (full suite). Expected: 0 failures. Run `npm run validate-model-catalog` and `node scripts/build-registry.mjs --check`.
- [ ] **Step 3:** Commit the doc with a path argument.

## Review

**Round 1, 2026-09-23 (adversarial Plan subagent): REVISE (minor).** Resolved:
- **C1:** the validator fixtures were misdescribed. Task 2 now names `loadSeed()` and `makeV2Catalog()`, the latter gains `serving`, and the aliased imports are dropped.
- **C2:** a reservation masked the permanent refusal. The check moved **before** `startBlockedBy`. The spec §3.3 is updated, and a combined test is added.
- **Suggestions adopted:**
  - the `ensureResident` test pins the native catch (console capture, once-only);
  - the `_servingNoticed` reset;
  - idle-revert goes through the once-notice;
  - `ERROR_MESSAGES` gets the new code;
  - "Try in chat" is suppressed;
  - a client-contract quant-change test;
  - line numbers and import paths are corrected.
- **Deferred to documented known limits (Task 6):** the bot-picker `on_demand` label, `pollResidency` down-reporting, and the HF-browser uncurated bypass.
- **Q1 (key on the registry `catalogId` too?):** No. `registerModel` writes the same id to both, so the provider row is the single source.
- **Q2 (router 409 for OpenAI-compatible clients):** the companion's models are resident, and an escalation degrades instead of returning 409. A direct 409 surfaces as a normal API error.

**Round 2, 2026-09-23: APPROVE.** Adopted: `ERROR_MESSAGES` insertion before `HTTP_401` (no trailing comma); the reservation reader is pinned in `beforeEach`; the post-download non-resident branch keeps a Remove button.
