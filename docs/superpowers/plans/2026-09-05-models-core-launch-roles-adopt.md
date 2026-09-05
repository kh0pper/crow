# Models core: launch profiles, provider roles, adopt-in-place, runtime override — Implementation Plan (arc plan 1 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the native (llama-server) model path everything the docker bundles express today — tuned launch flags, provider roles and variants over shared weights, adoption of weights already on disk, an operator-built runtime binary, and a row shape that replicates safely — so the later plans can migrate each provider role off its bundle.

**Architecture:** One PR (`feat/models-core-launch-roles`). Pure modules first (`launch.js` renders flags; `state.js` gets the `<catalogId>@<quant>` registry key; `runtime-override.js`; `native-locality.js`), then the writers (`registerModel`/`adoptModel` in `manager.js`), then the orchestrator consumes them. Nothing in this PR deletes a bundle, changes the docker branch, touches the Extensions page, or migrates a live row; the panel and routes are adapted only enough to keep working with the new registry key.

**Tech Stack:** Node 22 (`export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH` before every node/npm command), node:test via the scratch harness, `@libsql/client` for the providers table, express routes.

**Spec:** `docs/superpowers/specs/2026-09-04-models-bundles-to-catalog-design.md` — §3 (data model), §4 (orchestrator), §7 step 0 is NOT here (replication fix is plan 2), §8 error codes, §9 tests. Decisions D2, D3, D6, D11, D12, D14.

## Global Constraints

- Commit with positional paths: `git add <new files>` then `git commit <paths> -m "…"`; verify with `git show --stat HEAD`. No AI attribution in commits (operator rule).
- Run single test files ONLY through the scratch harness: `node scripts/run-suite.mjs tests/<file>.test.js`. Bare `node --test` can write to the live `crow.db`.
- CI must be green before merge (`suite`, `static-checks`, `audit`). `static-checks` runs `npm run validate-model-catalog`, `check-port-allocation`, `build-registry --check`, `check-vendored-payloads`.
- No new dashboard strings in this PR (no i18n changes). No new ports. No `SCHEMA_GENERATION` bump (no DDL changes: everything new lives inside the existing `gpu_policy` JSON column and `state.json`).
- Do not touch `~/.crow*`, `/home/kh0pp/llm`, `/mnt/data`, `~/crow-addons` from the worktree. Do not start or stop any model. Do not deploy: the primary gateway auto-restarts when origin/main moves, and a deploy is refused while `node scripts/ops/box-reserve.mjs status` shows a reservation.
- Work in a worktree: `git worktree add ~/crow-wt-models-core -b feat/models-core-launch-roles main`.
- Catalog `size_mb` is DECIMAL megabytes (bytes / 1e6), matching the Hugging Face tree API; `min_ram_mb` must be `>= size_mb`.

---

## File structure

| File | Responsibility |
|---|---|
| `servers/gateway/models/launch.js` (new) | Pure: `validateLaunch`, `mergeLaunch`, `renderLaunchArgs`, `LAUNCH_OWNED_FLAGS`. The only place that knows how a knob becomes a llama-server flag. |
| `servers/gateway/models/runtime-override.js` (new) | Host-local override record in `state.json`: get/set/clear, executable + `--version` validation, env bootstrap. |
| `servers/gateway/models/door.js` (new) | `gatewayPort()`, `doorBaseUrl()`, `nativeLoopbackUrl()` — the two URL shapes a native row carries. |
| `servers/shared/tailnet-ip.js` (new) | `getOwnTailnetIp()` (cached `tailscale ip -4`, env override, null on failure). |
| `servers/shared/native-locality.js` (new) | `isOwnedHere`, `isOrchestratableHere`, `localizeNativeRow` — owner gate + door→loopback rewrite. |
| `servers/gateway/models/state.js` | Registry key helpers, legacy-key migration on load, new persisted fields (`conversions`, `runtimeOverride`). |
| `servers/gateway/models/runtime.js` | `buildLlamaServerArgs` renders `launch`; `startModel` carries `launch` and exposes `argv`; `resolveAsset` prefers a CUDA asset. |
| `servers/gateway/models/manager.js` | `registerModel` roles/variants/conversion/door/owner; `adoptModel`; `unregisterModel` adopted-safe and shared-weights-safe; chat+vision mutex rule. |
| `servers/shared/providers-db.js` | `loadProvidersFromDb` localizes owned native rows. |
| `servers/gateway/gpu-orchestrator.js` | Registry-key lookup, `path`, launch merge + ctx guard, `MODEL_FILE_MISSING`, override-first binary, owner gate at every locality check, argv log. |
| `servers/gateway/routes/models.js`, `servers/gateway/dashboard/panels/model-catalog.js` | Read the registry through the new helpers so existing behavior survives the key change. |
| `scripts/validate-model-catalog.js`, `registry/model-catalog.json` | `launch` rules, `linux-x64-cuda` key, curated launch data, 35B → MTP repo, EmbeddingGemma entry. |
| `docs/architecture/models.md` (new) | The first architecture page for the model path. |
| Tests | `tests/models-launch.test.js`, `tests/models-runtime-override.test.js`, `tests/models-door-locality.test.js`, `tests/models-adopt.test.js`, `tests/model-catalog-launch-parity.test.js`, `tests/fixtures/launch-parity/*.json`, plus additions to `model-catalog-validate`, `models-state`, `models-runtime`, `models-registration`, `gpu-orchestrator-native`, `providers-upsert-noop` (or a new `providers-localize.test.js`). |

---

### Task 1: `launch.js` — validate, merge, render

**Files:**
- Create: `servers/gateway/models/launch.js`
- Test: `tests/models-launch.test.js`

**Interfaces (Produces):**
```js
export const LAUNCH_OWNED_FLAGS; // Set<string> — flags extra_args may never contain
export function validateLaunch(launch, { contextLen = null, label = "launch", hasMtp = false } = {}) // -> string[] errors (empty = valid)
export function mergeLaunch(base, override) // -> new object; override keys replace base keys; `sampling` merges key-by-key; `extra_args` replaces; null/undefined inputs allowed
export function renderLaunchArgs(launch) // -> string[] in a FIXED order (see below); null/undefined -> []
```
Render order: `-c`, `-ngl`, `-fa`, `-np`, `--no-mmap`, `-ctk` `-ctv`, `--spec-type` `--spec-draft-n-max`, `--temp`, `--top-p`, `--top-k`, `--min-p`, `--presence-penalty`, `--jinja`, then `extra_args` verbatim.

- [ ] **Step 1: Write the failing tests**

```js
// tests/models-launch.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateLaunch, mergeLaunch, renderLaunchArgs, LAUNCH_OWNED_FLAGS } from "../servers/gateway/models/launch.js";

const FULL = {
  ctx: 262144, ngl: 999, flash_attn: "on", parallel: 1, no_mmap: true, kv_type: "q8_0",
  spec: { type: "draft-mtp", draft_n_max: 2 },
  sampling: { temp: 1.0, top_p: 0.95, top_k: 20, min_p: 0.0, presence_penalty: 0.0 },
  jinja: true,
  extra_args: ["--pooling", "mean"],
};

test("validateLaunch: the full example is valid", () => {
  assert.deepEqual(validateLaunch(FULL, { contextLen: 262144, hasMtp: true }), []);
});

test("validateLaunch: null/undefined launch is valid (absent block)", () => {
  assert.deepEqual(validateLaunch(undefined), []);
  assert.deepEqual(validateLaunch(null), []);
});

test("validateLaunch: non-object fails naming the label", () => {
  const errs = validateLaunch("x", { label: "models[3].launch" });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /models\[3\]\.launch.*object/);
});

test("validateLaunch: unknown top-level key fails", () => {
  const errs = validateLaunch({ ctxx: 1 });
  assert.match(errs[0], /unknown key "ctxx"/);
});

test("validateLaunch: ctx must be an integer >= 1024 and <= contextLen", () => {
  assert.match(validateLaunch({ ctx: 100 })[0], /ctx/);
  assert.match(validateLaunch({ ctx: 4096.5 })[0], /ctx/);
  assert.match(validateLaunch({ ctx: 300000 }, { contextLen: 262144 })[0], /ctx 300000 exceeds context_len 262144/);
  assert.deepEqual(validateLaunch({ ctx: 262144 }, { contextLen: 262144 }), []);
});

test("validateLaunch: ngl integer >= 0; parallel integer >= 1; no_mmap boolean; flash_attn enum", () => {
  assert.match(validateLaunch({ ngl: -1 })[0], /ngl/);
  assert.match(validateLaunch({ parallel: 0 })[0], /parallel/);
  assert.match(validateLaunch({ no_mmap: "yes" })[0], /no_mmap/);
  assert.match(validateLaunch({ flash_attn: "maybe" })[0], /flash_attn must be one of on, off, auto/);
});

test("validateLaunch: kv_type must be a known llama.cpp cache type", () => {
  assert.match(validateLaunch({ kv_type: "q9_9" })[0], /kv_type/);
  assert.deepEqual(validateLaunch({ kv_type: "f16" }), []);
});

test("validateLaunch: spec needs type + positive integer draft_n_max, and an MTP source", () => {
  assert.match(validateLaunch({ spec: { type: "draft-mtp" } }, { hasMtp: true })[0], /spec\.draft_n_max/);
  assert.match(validateLaunch({ spec: { type: "draft-mtp", draft_n_max: 2 } }, { hasMtp: false })[0], /spec requires an mtp companion or the "mtp" tag/);
  assert.deepEqual(validateLaunch({ spec: { type: "draft-mtp", draft_n_max: 2 } }, { hasMtp: true }), []);
});

test("validateLaunch: sampling keys are numbers within range; unknown sampling key fails", () => {
  assert.match(validateLaunch({ sampling: { temp: -1 } })[0], /sampling\.temp/);
  assert.match(validateLaunch({ sampling: { top_p: 1.5 } })[0], /sampling\.top_p/);
  assert.match(validateLaunch({ sampling: { top_k: 2.5 } })[0], /sampling\.top_k/);
  assert.match(validateLaunch({ sampling: { bogus: 1 } })[0], /sampling: unknown key "bogus"/);
});

test("validateLaunch: extra_args must be strings and may not carry an owned flag", () => {
  assert.match(validateLaunch({ extra_args: "-b 4096" })[0], /extra_args must be an array of strings/);
  assert.match(validateLaunch({ extra_args: ["-c", "8192"] })[0], /extra_args may not contain "-c"/);
  assert.match(validateLaunch({ extra_args: ["--port=1"] })[0], /extra_args may not contain "--port"/);
  assert.match(validateLaunch({ extra_args: ["--mmproj", "x"] })[0], /extra_args may not contain "--mmproj"/);
  assert.deepEqual(validateLaunch({ extra_args: ["-b", "4096", "-ub", "4096", "--pooling", "mean"] }), []);
});

test("LAUNCH_OWNED_FLAGS contains identity, renderer-owned and companion/task flags", () => {
  for (const f of ["-m", "--model", "--alias", "--port", "--host", "-c", "--ctx-size", "--mmproj", "--embedding", "--embeddings",
    "--reranking", "--jinja", "-ngl", "--n-gpu-layers", "-fa", "--flash-attn", "-np", "--parallel", "--no-mmap", "-ctk", "-ctv",
    "--cache-type-k", "--cache-type-v", "--spec-type", "--spec-draft-n-max", "--temp", "--top-p", "--top-k", "--min-p", "--presence-penalty"]) {
    assert.ok(LAUNCH_OWNED_FLAGS.has(f), `missing ${f}`);
  }
});

test("mergeLaunch: override keys replace, sampling merges per key, extra_args replaces, nulls tolerated", () => {
  const merged = mergeLaunch(
    { ctx: 262144, sampling: { temp: 1.0, top_k: 20 }, extra_args: ["-b", "1"] },
    { ctx: 32768, sampling: { top_k: 40 }, extra_args: ["-b", "2"] },
  );
  assert.deepEqual(merged, { ctx: 32768, sampling: { temp: 1.0, top_k: 40 }, extra_args: ["-b", "2"] });
  assert.deepEqual(mergeLaunch(null, { ngl: 1 }), { ngl: 1 });
  assert.deepEqual(mergeLaunch({ ngl: 1 }, undefined), { ngl: 1 });
  assert.deepEqual(mergeLaunch(null, null), {});
});

test("mergeLaunch never mutates its inputs", () => {
  const base = { sampling: { temp: 1 } };
  const over = { sampling: { top_k: 2 } };
  mergeLaunch(base, over);
  assert.deepEqual(base, { sampling: { temp: 1 } });
  assert.deepEqual(over, { sampling: { top_k: 2 } });
});

test("renderLaunchArgs: fixed order, every knob", () => {
  assert.deepEqual(renderLaunchArgs(FULL), [
    "-c", "262144", "-ngl", "999", "-fa", "on", "-np", "1", "--no-mmap", "-ctk", "q8_0", "-ctv", "q8_0",
    "--spec-type", "draft-mtp", "--spec-draft-n-max", "2",
    "--temp", "1", "--top-p", "0.95", "--top-k", "20", "--min-p", "0", "--presence-penalty", "0",
    "--jinja", "--pooling", "mean",
  ]);
});

test("renderLaunchArgs: absent knobs render nothing; no_mmap:false renders nothing; jinja:false renders nothing", () => {
  assert.deepEqual(renderLaunchArgs(undefined), []);
  assert.deepEqual(renderLaunchArgs({}), []);
  assert.deepEqual(renderLaunchArgs({ no_mmap: false, jinja: false }), []);
  assert.deepEqual(renderLaunchArgs({ ctx: 8192 }), ["-c", "8192"]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node scripts/run-suite.mjs tests/models-launch.test.js`
Expected: FAIL — `Cannot find module '../servers/gateway/models/launch.js'`.

- [ ] **Step 3: Implement**

```js
// servers/gateway/models/launch.js
/**
 * Launch profiles for native llama-server starts (spec §3.1 / §4).
 *
 * A `launch` block is a fixed set of typed knobs plus `extra_args`. This
 * module is the ONLY place that maps a knob to a llama-server flag:
 * the catalog validator calls `validateLaunch`, the orchestrator calls
 * `mergeLaunch` (catalog defaults under the provider row's override) and
 * `renderLaunchArgs`. Identity flags (--model/--alias/--port/--host) and
 * companion/task flags (--mmproj/--embedding/--reranking) stay owned by
 * runtime.js + gpu-orchestrator.js; `extra_args` may never carry them.
 */

export const FLASH_ATTN_VALUES = ["on", "off", "auto"];
export const KV_TYPES = ["f32", "f16", "bf16", "q8_0", "q4_0", "q4_1", "iq4_nl", "q5_0", "q5_1"];
const SPEC_TYPE_RE = /^[a-z0-9][a-z0-9-]*$/;

const TOP_LEVEL_KEYS = new Set(["ctx", "ngl", "flash_attn", "parallel", "no_mmap", "kv_type", "spec", "sampling", "jinja", "extra_args"]);
const SAMPLING_RULES = {
  temp: (v) => v >= 0 && v <= 5,
  top_p: (v) => v >= 0 && v <= 1,
  top_k: (v) => Number.isInteger(v) && v >= 0,
  min_p: (v) => v >= 0 && v <= 1,
  presence_penalty: (v) => v >= -2 && v <= 2,
};
const SAMPLING_FLAGS = { temp: "--temp", top_p: "--top-p", top_k: "--top-k", min_p: "--min-p", presence_penalty: "--presence-penalty" };

export const LAUNCH_OWNED_FLAGS = new Set([
  "-m", "--model", "--alias", "--port", "--host",
  "-c", "--ctx-size", "--mmproj", "--embedding", "--embeddings", "--reranking", "--jinja",
  "-ngl", "--n-gpu-layers", "-fa", "--flash-attn", "-np", "--parallel", "--no-mmap",
  "-ctk", "-ctv", "--cache-type-k", "--cache-type-v",
  "--spec-type", "--spec-draft-n-max",
  "--temp", "--top-p", "--top-k", "--min-p", "--presence-penalty",
]);

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function validateLaunch(launch, { contextLen = null, label = "launch", hasMtp = false } = {}) {
  const errors = [];
  if (launch === undefined || launch === null) return errors;
  if (!isPlainObject(launch)) return [`${label}: must be a plain object`];

  for (const key of Object.keys(launch)) {
    if (!TOP_LEVEL_KEYS.has(key)) errors.push(`${label}: unknown key "${key}"`);
  }
  const { ctx, ngl, flash_attn, parallel, no_mmap, kv_type, spec, sampling, jinja, extra_args } = launch;

  if (ctx !== undefined) {
    if (!Number.isInteger(ctx) || ctx < 1024) errors.push(`${label}: ctx must be an integer >= 1024`);
    else if (Number.isFinite(contextLen) && ctx > contextLen) errors.push(`${label}: ctx ${ctx} exceeds context_len ${contextLen}`);
  }
  if (ngl !== undefined && (!Number.isInteger(ngl) || ngl < 0)) errors.push(`${label}: ngl must be an integer >= 0`);
  if (parallel !== undefined && (!Number.isInteger(parallel) || parallel < 1)) errors.push(`${label}: parallel must be an integer >= 1`);
  if (no_mmap !== undefined && typeof no_mmap !== "boolean") errors.push(`${label}: no_mmap must be a boolean`);
  if (jinja !== undefined && typeof jinja !== "boolean") errors.push(`${label}: jinja must be a boolean`);
  if (flash_attn !== undefined && !FLASH_ATTN_VALUES.includes(flash_attn)) {
    errors.push(`${label}: flash_attn must be one of ${FLASH_ATTN_VALUES.join(", ")}`);
  }
  if (kv_type !== undefined && !KV_TYPES.includes(kv_type)) errors.push(`${label}: kv_type must be one of ${KV_TYPES.join(", ")}`);

  if (spec !== undefined) {
    if (!isPlainObject(spec)) errors.push(`${label}: spec must be a plain object`);
    else {
      if (typeof spec.type !== "string" || !SPEC_TYPE_RE.test(spec.type)) errors.push(`${label}: spec.type must be a flag-safe string`);
      if (!Number.isInteger(spec.draft_n_max) || spec.draft_n_max < 1) errors.push(`${label}: spec.draft_n_max must be a positive integer`);
      if (!hasMtp) errors.push(`${label}: spec requires an mtp companion or the "mtp" tag on the model`);
    }
  }

  if (sampling !== undefined) {
    if (!isPlainObject(sampling)) errors.push(`${label}: sampling must be a plain object`);
    else {
      for (const [k, v] of Object.entries(sampling)) {
        const rule = SAMPLING_RULES[k];
        if (!rule) errors.push(`${label}: sampling: unknown key "${k}"`);
        else if (typeof v !== "number" || !Number.isFinite(v) || !rule(v)) errors.push(`${label}: sampling.${k} is out of range`);
      }
    }
  }

  if (extra_args !== undefined) {
    if (!Array.isArray(extra_args) || extra_args.some((a) => typeof a !== "string")) {
      errors.push(`${label}: extra_args must be an array of strings`);
    } else {
      for (const arg of extra_args) {
        const flag = arg.split("=")[0];
        if (LAUNCH_OWNED_FLAGS.has(flag)) errors.push(`${label}: extra_args may not contain "${flag}" (owned by the launcher)`);
      }
    }
  }
  return errors;
}

export function mergeLaunch(base, override) {
  const out = {};
  for (const src of [base, override]) {
    if (!isPlainObject(src)) continue;
    for (const [k, v] of Object.entries(src)) {
      if (k === "sampling" && isPlainObject(v)) out.sampling = { ...(out.sampling || {}), ...v };
      else if (k === "spec" && isPlainObject(v)) out.spec = { ...v };
      else if (k === "extra_args" && Array.isArray(v)) out.extra_args = [...v];
      else out[k] = v;
    }
  }
  return out;
}

export function renderLaunchArgs(launch) {
  if (!isPlainObject(launch)) return [];
  const args = [];
  if (launch.ctx !== undefined) args.push("-c", String(launch.ctx));
  if (launch.ngl !== undefined) args.push("-ngl", String(launch.ngl));
  if (launch.flash_attn !== undefined) args.push("-fa", launch.flash_attn);
  if (launch.parallel !== undefined) args.push("-np", String(launch.parallel));
  if (launch.no_mmap === true) args.push("--no-mmap");
  if (launch.kv_type !== undefined) args.push("-ctk", launch.kv_type, "-ctv", launch.kv_type);
  if (isPlainObject(launch.spec)) args.push("--spec-type", launch.spec.type, "--spec-draft-n-max", String(launch.spec.draft_n_max));
  if (isPlainObject(launch.sampling)) {
    for (const key of Object.keys(SAMPLING_FLAGS)) {
      if (launch.sampling[key] !== undefined) args.push(SAMPLING_FLAGS[key], String(launch.sampling[key]));
    }
  }
  if (launch.jinja === true) args.push("--jinja");
  if (Array.isArray(launch.extra_args)) args.push(...launch.extra_args);
  return args;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node scripts/run-suite.mjs tests/models-launch.test.js` — Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add servers/gateway/models/launch.js tests/models-launch.test.js
git commit servers/gateway/models/launch.js tests/models-launch.test.js -m "feat(models): launch profiles — validate, merge, render llama-server knobs"
```

---

### Task 2: catalog validator — `launch` rules and the CUDA asset key

**Files:**
- Modify: `scripts/validate-model-catalog.js` (per-model loop, around the `chat_template_kwargs` check at ~line 196; `KNOWN_RUNTIME_ASSET_KEYS` at line 57)
- Test: `tests/model-catalog-validate.test.js`

**Interfaces:** Consumes `validateLaunch` from Task 1. Produces: `validateCatalog` rejects invalid `launch`; accepts `linux-x64-cuda` (with `min_glibc`, like the other linux keys).

- [ ] **Step 1: Failing tests** (append; use the file's existing `loadSeed`, `clone`, `defaultModel`, `otherModel` helpers)

```js
test("launch: a valid block on a model validates", () => {
  const c = clone(loadSeed());
  otherModel(c).launch = { ctx: 8192, ngl: 999, flash_attn: "on" };
  assert.deepEqual(validateCatalog(c).errors, []);
});

test("launch: ctx above the model's context_len fails, naming the model", () => {
  const c = clone(loadSeed());
  const m = otherModel(c);
  m.launch = { ctx: m.context_len * 2 };
  const { errors } = validateCatalog(c);
  assert.equal(errors.length, 1);
  assert.match(errors[0], new RegExp(`${m.id}.*launch.*exceeds context_len`));
});

test("launch: extra_args carrying an owned flag fails", () => {
  const c = clone(loadSeed());
  otherModel(c).launch = { extra_args: ["--alias", "x"] };
  assert.match(validateCatalog(c).errors[0], /extra_args may not contain "--alias"/);
});

test("launch: spec is accepted only with an mtp companion or the mtp tag", () => {
  const c = clone(loadSeed());
  const m = otherModel(c);
  m.launch = { spec: { type: "draft-mtp", draft_n_max: 2 } };
  m.tags = (m.tags || []).filter((t) => t !== "mtp");
  m.companions = (m.companions || []).filter((x) => x.kind !== "mtp");
  assert.match(validateCatalog(c).errors[0], /spec requires an mtp companion or the "mtp" tag/);
  m.tags.push("mtp");
  assert.deepEqual(validateCatalog(c).errors, []);
});

test("runtime asset key linux-x64-cuda is accepted and requires min_glibc", () => {
  const c = clone(loadSeed());
  c.runtime.assets["linux-x64-cuda"] = { file: "llama-b1-bin-ubuntu-cuda-x64.tar.gz", sha256: "a".repeat(64) };
  assert.match(validateCatalog(c).errors[0], /linux-x64-cuda.*min_glibc/);
  c.runtime.assets["linux-x64-cuda"].min_glibc = "2.34";
  assert.deepEqual(validateCatalog(c).errors, []);
});
```

- [ ] **Step 2:** `node scripts/run-suite.mjs tests/model-catalog-validate.test.js` → the five new tests FAIL.

- [ ] **Step 3: Implement**

In `scripts/validate-model-catalog.js`:
```js
import { validateLaunch } from "../servers/gateway/models/launch.js";
// KNOWN_RUNTIME_ASSET_KEYS: add "linux-x64-cuda" (the existing `key.startsWith("linux-")` min_glibc rule covers it).
```
Inside the per-model loop, right after the `chat_template_kwargs` block:
```js
    if (model.launch !== undefined) {
      const hasMtp = (Array.isArray(model.tags) && model.tags.includes("mtp"))
        || (Array.isArray(model.companions) && model.companions.some((c) => c && c.kind === "mtp"));
      for (const e of validateLaunch(model.launch, { contextLen: model.context_len, label: `${label} launch`, hasMtp })) {
        errors.push(e);
      }
    }
```
Add to the header doc comment: a "Schema v3 (launch profiles, 2026-09)" paragraph stating the rules above in one sentence each.

- [ ] **Step 4:** tests PASS; `npm run validate-model-catalog` still passes on the unchanged catalog.

- [ ] **Step 5: Commit**
```bash
git commit scripts/validate-model-catalog.js tests/model-catalog-validate.test.js -m "feat(model-catalog): validate launch blocks; accept a linux-x64-cuda runtime asset"
```

---

### Task 3: curated launch data, 35B → MTP repo, EmbeddingGemma entry, compose-parity fixtures

**Files:**
- Modify: `registry/model-catalog.json`
- Create: `tests/fixtures/launch-parity/qwen36-35b-a3b.json`, `qwen3-embedding-0.6b.json`, `gemma-4-e2b-it.json`
- Create: `tests/model-catalog-launch-parity.test.js`

**Interfaces:** Consumes `mergeLaunch`, `renderLaunchArgs` (Task 1). Produces the data every later task and plan reads.

- [ ] **Step 1: Write the fixtures** — the compose `command:` lists copied VERBATIM (they are the rollback record once the bundles are deleted in plan 4):

`tests/fixtures/launch-parity/qwen36-35b-a3b.json` (from `bundles/llamacpp-vulkan-qwen36-35b-a3b/docker-compose.yml`):
```json
{ "catalogId": "qwen3.6-35b-a3b", "source": "bundles/llamacpp-vulkan-qwen36-35b-a3b/docker-compose.yml",
  "command": ["-m", "/models/qwen36-35b-a3b-mtp/Qwen3.6-35B-A3B-UD-Q5_K_XL.gguf", "--mmproj", "/models/qwen36-35b-a3b-mtp/mmproj-F16.gguf",
    "--alias", "qwen3.6-35b-a3b", "--host", "0.0.0.0", "--port", "8000", "-ngl", "999", "-fa", "on", "--no-mmap",
    "-c", "262144", "-np", "1", "--spec-type", "draft-mtp", "--spec-draft-n-max", "2", "--jinja"] }
```
`tests/fixtures/launch-parity/qwen3-embedding-0.6b.json` (from `bundles/llamacpp-vulkan-qwen3-embed/docker-compose.yml`):
```json
{ "catalogId": "qwen3-embedding-0.6b", "source": "bundles/llamacpp-vulkan-qwen3-embed/docker-compose.yml",
  "command": ["-m", "/models/qwen3-embedding-0.6b/Qwen3-Embedding-0.6B-Q8_0.gguf", "--alias", "qwen3-embedding-0.6b", "--embedding",
    "--pooling", "mean", "--host", "0.0.0.0", "--port", "8000", "-ngl", "999", "-fa", "on", "--no-mmap",
    "-c", "32768", "--parallel", "8", "-b", "4096", "-ub", "4096"] }
```
`tests/fixtures/launch-parity/gemma-4-e2b-it.json` (from `~/crow-addons/llamacpp-vulkan-gemma4-e2b/docker-compose.yml`):
```json
{ "catalogId": "gemma-4-e2b-it", "source": "crow-addons/llamacpp-vulkan-gemma4-e2b/docker-compose.yml",
  "command": ["-m", "/models/gemma-4-E2B-it-Q4_0.gguf", "--alias", "gemma-4-e2b", "--host", "0.0.0.0", "--port", "8000",
    "-ngl", "999", "-fa", "on", "-c", "8192", "--jinja", "--reasoning-budget", "0"] }
```
(No 27B fixture: unsloth reworked `unsloth/Qwen3.8-27B-GGUF` on 2026-08-19 — MTP moved to `MTP/mtp-Qwen3.8-27B-Q4_0.gguf` and the main GGUF was re-cut — so the on-disk 27B (25,924,152,384 bytes) matches no current HF file and its `--spec-type draft-mtp` cannot be promised for the catalog file. The 27B catalog `launch` below carries everything EXCEPT `spec`; plan 4 step 4 settles MTP for the 27B with the operator.)

- [ ] **Step 2: Write the parity test**

```js
// tests/model-catalog-launch-parity.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeLaunch, renderLaunchArgs } from "../servers/gateway/models/launch.js";

const here = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(readFileSync(join(here, "..", "registry", "model-catalog.json"), "utf8"));
const fixturesDir = join(here, "fixtures", "launch-parity");

// Flags the orchestrator owns outside the launch block (identity, companions, task).
const IDENTITY = new Set(["-m", "--model", "--mmproj", "--alias", "--host", "--port", "--embedding", "--embeddings", "--reranking"]);
const ALIASES = { "--parallel": "-np", "--ctx-size": "-c", "--n-gpu-layers": "-ngl", "--flash-attn": "-fa", "--embeddings": "--embedding" };
const BOOLEAN_FLAGS = new Set(["--no-mmap", "--jinja", "--embedding", "--embeddings", "--reranking"]);

/** argv -> Map<flag, value|true>, aliases normalized, identity flags dropped. */
function flagPairs(argv) {
  const out = new Map();
  for (let i = 0; i < argv.length; i++) {
    let flag = argv[i];
    if (!flag.startsWith("-")) continue;
    flag = ALIASES[flag] || flag;
    const isBool = BOOLEAN_FLAGS.has(flag) || i + 1 >= argv.length || argv[i + 1].startsWith("-");
    const value = isBool ? true : argv[++i];
    if (IDENTITY.has(flag)) continue;
    out.set(flag, value);
  }
  return out;
}

for (const file of readdirSync(fixturesDir).filter((f) => f.endsWith(".json"))) {
  const fixture = JSON.parse(readFileSync(join(fixturesDir, file), "utf8"));
  test(`launch parity: ${fixture.catalogId} renders every flag its retired compose carried (${fixture.source})`, () => {
    const model = catalog.models.find((m) => m.id === fixture.catalogId);
    assert.ok(model, `catalog has ${fixture.catalogId}`);
    const jinja = fixture.command.includes("--jinja") || !!model.chat_template_kwargs;
    const rendered = renderLaunchArgs(mergeLaunch(model.launch, jinja ? { jinja: true } : null));
    const want = flagPairs(fixture.command);
    const got = flagPairs(rendered);
    for (const [flag, value] of want) {
      assert.ok(got.has(flag), `${fixture.catalogId}: catalog launch is missing ${flag}`);
      assert.equal(got.get(flag), value, `${fixture.catalogId}: ${flag} differs`);
    }
    for (const flag of got.keys()) {
      assert.ok(want.has(flag), `${fixture.catalogId}: catalog launch adds ${flag} the compose never had`);
    }
  });
}
```

- [ ] **Step 3:** run → FAIL (catalog has no `launch` blocks yet).

- [ ] **Step 4: Edit `registry/model-catalog.json`** (keep the `runtime` block untouched; keep every existing field). Per model, add `launch` and the noted data changes:

| id | changes |
|---|---|
| `qwen3.5-4b` | `launch: {"ctx": 32768, "ngl": 999, "flash_attn": "on"}` |
| `gemma-4-e2b-it` | `launch: {"ctx": 8192, "ngl": 999, "flash_attn": "on", "extra_args": ["--reasoning-budget", "0"]}` (`--jinja` comes from the parity fixture's `jinja` merge in tests and from the orchestrator's `chat_template_kwargs`/launch.jinja rule at runtime — add `"jinja": true` here so the runtime matches the addon) |
| `qwen3-embedding-0.6b` | set `context_len: 32768` (the model supports 32k; the compose ran it so); `launch: {"ctx": 32768, "ngl": 999, "flash_attn": "on", "no_mmap": true, "parallel": 8, "extra_args": ["--pooling", "mean", "-b", "4096", "-ub", "4096"]}` |
| `qwen3-reranker-0.6b` | `launch: {"ctx": 8192, "ngl": 999, "flash_attn": "on"}` |
| `qwen3-vl-4b-instruct` | `launch: {"ctx": 32768, "ngl": 999, "flash_attn": "on"}` |
| `qwen3.6-35b-a3b` | **repo switch to the MTP build the lab runs**: `hf_repo: "unsloth/Qwen3.6-35B-A3B-MTP-GGUF"`; `tags` add `"mtp"`; quants: `UD-Q5_K_XL` `size_mb: 27159.12`, `sha256: "9de9a9420f61a0bb59bb2ca1ea170a6a57f6821fa1deec915bcaef523730a919"`, `min_ram_mb: 30356`; `UD-Q4_K_XL` `size_mb: 22853.66`, `sha256: "55983c5a75a1ab969824077b3bb3de4146e82a9234072b48ad4e8f92ad3fe9f1"`, `min_ram_mb: 26050`; companion mmproj `size_mb: 899.28`, `sha256: "71f3cbc1f7cc0f30d09d41cfa924c0060827ebc33bf15ace7e86661e856f0160"`; `launch: {"ctx": 262144, "ngl": 999, "flash_attn": "on", "parallel": 1, "no_mmap": true, "jinja": true, "spec": {"type": "draft-mtp", "draft_n_max": 2}}`; `notes` gains one sentence: "The MTP build (multi-token prediction inside the GGUF) is the one this box runs; the bench notes in scripts/bench/results measured it at ~70 tok/s single-stream with draft-n 2." (`min_ram_mb` = size_mb + 3196.6, the same 32k-context KV+overhead delta the non-MTP entry carried.) |
| `qwen3.8-27b` | `launch: {"ctx": 262144, "ngl": 999, "flash_attn": "on", "kv_type": "q8_0", "no_mmap": true, "parallel": 1, "jinja": true, "sampling": {"temp": 1.0, "top_p": 0.95, "top_k": 20, "min_p": 0.0, "presence_penalty": 0.0}}` — NO `spec` (see fixture note); `notes` gains: "unsloth re-cut this repo on 2026-08-19 and moved MTP to a separate MTP/ GGUF; the catalog file therefore runs without draft-mtp until the MTP companion is verified." |
| `qwen3.8-flash-next` | `launch: {"ctx": 262144, "ngl": 999, "flash_attn": "on", "no_mmap": true, "parallel": 1, "jinja": true, "spec": {"type": "draft-mtp", "draft_n_max": 2}}` (it has an `mtp` companion) |
| `glm-5.3-flash` | `launch: {"ctx": 131072, "ngl": 999, "flash_attn": "on", "no_mmap": true, "jinja": true}` |
| `deepseek-v4-flash` | `launch: {"ctx": 131072, "ngl": 999, "flash_attn": "on", "no_mmap": true, "jinja": true}` |

New entry, appended after `qwen3-reranker-0.6b`:
```json
{
  "id": "embeddinggemma-300m",
  "family": "gemma3",
  "lab": "Google",
  "hf_repo": "ggml-org/embeddinggemma-300M-GGUF",
  "license": "gemma",
  "gated": false,
  "task": "embedding",
  "context_len": 2048,
  "min_runtime_version": "b10068",
  "default_quant": "Q8_0",
  "tags": ["small", "embedding", "cpu-capable", "alternative"],
  "quants": [
    { "file": "embeddinggemma-300M-Q8_0.gguf", "quant": "Q8_0", "size_mb": 333.59, "min_ram_mb": 1100, "min_vram_mb": 0,
      "sha256": "b5ce9d77a3fc4b3b39ccb5643c36777911cc4eb46a66962eadfa3f5f60490d63" }
  ],
  "launch": { "ctx": 2048, "ngl": 999 },
  "notes": "The optional alternative to Qwen3-Embedding-0.6B: Google's EmbeddingGemma (300M, 768-dimensional, Gemma license). The GGUF declares mean pooling and llama-server honours it, so no --pooling flag is passed — overriding it would change the vectors. This is the exact file r4's wayfinder knowledge base has embedded with since 2026-07. Switching the fleet embedder from Qwen to this re-embeds every memory; it is offered, not made the default."
}
```
(`size_mb` = 333,590,944 bytes / 1e6; `min_ram_mb` is the same fit method as the other small entries: model bytes plus 2k-context KV and runtime overhead, rounded up.)

- [ ] **Step 5: Verify**
```bash
npm run validate-model-catalog
node scripts/run-suite.mjs tests/model-catalog-launch-parity.test.js tests/model-catalog-validate.test.js tests/starter-content.test.js tests/models-panel-ui.test.js tests/model-catalog-client-contract.test.js tests/chat-template-kwargs.test.js
```
Expected: all PASS. If a live-catalog test pinned the model count (10), update it to read the catalog dynamically.

- [ ] **Step 6: Commit**
```bash
git add tests/fixtures/launch-parity tests/model-catalog-launch-parity.test.js
git commit registry/model-catalog.json tests/fixtures/launch-parity tests/model-catalog-launch-parity.test.js -m "feat(model-catalog): launch profiles for every entry; 35B on the MTP build; EmbeddingGemma-300M alternative embedder"
```

---

### Task 4: `runtime.js` — render `launch`, expose argv, prefer a CUDA asset

**Files:**
- Modify: `servers/gateway/models/runtime.js` (`buildLlamaServerArgs` ~line 906, `startModel` ~964, `resolveAsset` ~239)
- Test: `tests/models-runtime.test.js`

**Interfaces (Produces):**
```js
export function buildLlamaServerArgs({ ggufPath, alias, port, host = "127.0.0.1", launch = null, extraArgs = [] })
// -> ["--model", ggufPath, "--alias", alias, "--port", String(port), "--host", host, ...renderLaunchArgs(launch), ...extraArgs]
startModel({ ..., launch })  // handle.argv = the full args array; handle.status() includes { argv }
resolveAsset(probe, runtimeBlock, opts) // probe.accel === "cuda" && assets["linux-x64-cuda"] (glibc ok) -> key "linux-x64-cuda"; else unchanged behavior
```

- [ ] **Step 1: Failing tests** (append to `tests/models-runtime.test.js`; reuse its existing imports and the fake-spawn pattern of the test at ~line 139)

```js
test("buildLlamaServerArgs renders the launch block between identity flags and extraArgs", () => {
  const args = buildLlamaServerArgs({
    ggufPath: "/m/x.gguf", alias: "x", port: 18150, host: "127.0.0.1",
    launch: { ctx: 8192, no_mmap: true }, extraArgs: ["--mmproj", "/m/p.gguf"],
  });
  assert.deepEqual(args, ["--model", "/m/x.gguf", "--alias", "x", "--port", "18150", "--host", "127.0.0.1", "-c", "8192", "--no-mmap", "--mmproj", "/m/p.gguf"]);
});

test("buildLlamaServerArgs without launch is byte-identical to the pre-launch shape", () => {
  assert.deepEqual(
    buildLlamaServerArgs({ ggufPath: "/m/x.gguf", alias: "x", port: 1, host: "h" }),
    ["--model", "/m/x.gguf", "--alias", "x", "--port", "1", "--host", "h"],
  );
});

test("startModel passes launch through and exposes the rendered argv on the handle and its status()", async () => {
  const spawned = [];
  const fakeSpawn = (cmd, args) => { spawned.push({ cmd, args }); return fakeChild(); }; // fakeChild(): the file's existing stub child factory
  const handle = startModel({ binPath: "/bin/llama-server", ggufPath: "/m/x.gguf", alias: "x", port: 18151,
    launch: { ctx: 4096 }, spawn: fakeSpawn, setprivAvailable: false, setTimeoutFn: () => 0, clearTimeoutFn: () => {} });
  assert.ok(handle.argv.includes("-c") && handle.argv.includes("4096"));
  assert.deepEqual(handle.status().argv, handle.argv);
  assert.ok(spawned[0].args.includes("4096"));
  await handle.stop();
});

test("resolveAsset: a cuda probe prefers linux-x64-cuda when the catalog ships it", () => {
  const rt = { release: "b1", assets: {
    "linux-x64-vulkan": { file: "v.tar.gz", sha256: "a".repeat(64), min_glibc: "2.34" },
    "linux-x64-cuda": { file: "c.tar.gz", sha256: "b".repeat(64), min_glibc: "2.34" },
    "linux-x64-cpu": { file: "p.tar.gz", sha256: "c".repeat(64), min_glibc: "2.34" } } };
  const r = resolveAsset({ platform: "linux", accel: "cuda" }, rt, { lddOutput: "ldd (GNU libc) 2.39" });
  assert.equal(r.key, "linux-x64-cuda");
});

test("resolveAsset: a cuda probe without a cuda asset still falls to vulkan (unchanged v1 rule)", () => {
  const rt = { release: "b1", assets: {
    "linux-x64-vulkan": { file: "v.tar.gz", sha256: "a".repeat(64), min_glibc: "2.34" },
    "linux-x64-cpu": { file: "p.tar.gz", sha256: "c".repeat(64), min_glibc: "2.34" } } };
  const r = resolveAsset({ platform: "linux", accel: "cuda" }, rt, { lddOutput: "ldd (GNU libc) 2.39" });
  assert.equal(r.key, "linux-x64-vulkan");
});
```
If the file has no `fakeChild()` helper, copy the child stub the `startModel passes --alias/--port/--host args` test builds inline into a small local function.

- [ ] **Step 2:** run → the five FAIL.

- [ ] **Step 3: Implement**

```js
// runtime.js — top imports
import { renderLaunchArgs } from "./launch.js";

export function buildLlamaServerArgs({ ggufPath, alias, port, host = "127.0.0.1", launch = null, extraArgs = [] }) {
  return ["--model", ggufPath, "--alias", alias, "--port", String(port), "--host", host, ...renderLaunchArgs(launch), ...extraArgs];
}
```
In `startModel`: add `launch = null` to the destructured params; `const args = buildLlamaServerArgs({ ggufPath, alias, port, host, launch, extraArgs });` (replace the existing line). After `const handle = superviseProcess({...})` returns, add:
```js
  handle.argv = args;
  const baseStatus = handle.status;
  handle.status = () => ({ ...baseStatus(), alias, port, argv: args });
```
(Check whether `startModel` already decorates `status()` with `alias`/`port` for the panel — if it does, add `argv` to that existing decoration instead of wrapping twice.)

In `resolveAsset`, inside `if (wantsGpu) {` before the Vulkan lookup:
```js
    if (probe.accel === "cuda") {
      const cudaAsset = assets[LINUX_CUDA_KEY];
      if (cudaAsset && glibcAtLeast(parseGlibcVersion(lddOutput), cudaAsset.min_glibc)) {
        return { key: LINUX_CUDA_KEY, url: buildRuntimeDownloadUrl(release, cudaAsset.file, baseUrl), sha256: cudaAsset.sha256 };
      }
    }
```
with `const LINUX_CUDA_KEY = "linux-x64-cuda";` beside `LINUX_VULKAN_KEY`.

- [ ] **Step 4:** `node scripts/run-suite.mjs tests/models-runtime.test.js` → PASS.

- [ ] **Step 5: Commit**
```bash
git commit servers/gateway/models/runtime.js tests/models-runtime.test.js -m "feat(models-runtime): render launch profiles into llama-server argv; expose argv; prefer a CUDA asset"
```

---

### Task 5: `state.js` — registry key, legacy migration, new persisted fields

**Files:**
- Modify: `servers/gateway/models/state.js`
- Test: `tests/models-state.test.js`

**Interfaces (Produces):**
```js
export function registryKey(catalogId, quant) // -> `${catalogId}@${quant}`
export function parseRegistryKey(key) // -> { catalogId, quant } | null (no "@")
export function findRegistryEntries(state, catalogId) // -> [{ key, entry }] for every quant of that catalog id (legacy key === catalogId included)
export function findRegistryEntryForProvider(state, provider) // provider = { gpuPolicy } -> { key, entry } | null using gpuPolicy.catalogId/quant
// loadState() now returns { reservations, journal, registry, conversions, runtimeOverride } and migrates legacy keys
```

- [ ] **Step 1: Failing tests** (append)

```js
import { registryKey, parseRegistryKey, findRegistryEntries, findRegistryEntryForProvider } from "../servers/gateway/models/state.js";

test("registryKey/parseRegistryKey round-trip; legacy key parses to null", () => {
  assert.equal(registryKey("qwen3.5-4b", "UD-Q4_K_XL"), "qwen3.5-4b@UD-Q4_K_XL");
  assert.deepEqual(parseRegistryKey("qwen3.5-4b@UD-Q4_K_XL"), { catalogId: "qwen3.5-4b", quant: "UD-Q4_K_XL" });
  assert.equal(parseRegistryKey("qwen3.5-4b"), null);
});

test("loadState migrates a legacy <modelId> registry key to <catalogId>@<quant> exactly once (idempotent)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "models-state-"));
  try {
    saveState(dir, { reservations: {}, journal: {}, registry: {
      "qwen3.5-4b": { file: "Qwen3.5-4B-UD-Q4_K_XL.gguf", quant: "UD-Q4_K_XL", catalogId: "qwen3.5-4b", sizeMb: 2912 },
      "mystery": { file: "m.gguf" }, // no catalogId/quant -> left alone
    } });
    const s1 = loadState(dir);
    assert.ok(s1.registry["qwen3.5-4b@UD-Q4_K_XL"]);
    assert.equal(s1.registry["qwen3.5-4b"], undefined);
    assert.ok(s1.registry["mystery"]);
    saveState(dir, s1);
    const s2 = loadState(dir);
    assert.deepEqual(s2.registry, s1.registry);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loadState returns conversions {} and runtimeOverride null by default and round-trips them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "models-state-"));
  try {
    assert.deepEqual(loadState(dir).conversions, {});
    assert.equal(loadState(dir).runtimeOverride, null);
    const s = loadState(dir);
    s.conversions["crow-chat"] = { row: { id: "crow-chat" }, at: "2026-09-05T00:00:00Z" };
    s.runtimeOverride = { bin: "/x/llama-server", label: "x", version: "b1", setAt: "2026-09-05T00:00:00Z" };
    saveState(dir, s);
    assert.deepEqual(loadState(dir).conversions["crow-chat"].row, { id: "crow-chat" });
    assert.equal(loadState(dir).runtimeOverride.bin, "/x/llama-server");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("findRegistryEntries returns every quant for a catalog id, including a legacy-keyed entry", () => {
  const state = { registry: {
    "a@Q4": { catalogId: "a", quant: "Q4" }, "a@Q8": { catalogId: "a", quant: "Q8" }, "b@Q4": { catalogId: "b", quant: "Q4" }, "c": { file: "c.gguf" },
  } };
  assert.deepEqual(findRegistryEntries(state, "a").map((x) => x.key).sort(), ["a@Q4", "a@Q8"]);
  assert.deepEqual(findRegistryEntries(state, "c").map((x) => x.key), ["c"]);
  assert.deepEqual(findRegistryEntries(state, "zzz"), []);
});

test("findRegistryEntryForProvider resolves via gpuPolicy.catalogId/quant, else null", () => {
  const state = { registry: { "a@Q4": { catalogId: "a", quant: "Q4" } } };
  assert.equal(findRegistryEntryForProvider(state, { gpuPolicy: { catalogId: "a", quant: "Q4" } }).key, "a@Q4");
  assert.equal(findRegistryEntryForProvider(state, { gpuPolicy: { catalogId: "a", quant: "Q8" } }), null);
  assert.equal(findRegistryEntryForProvider(state, { gpuPolicy: {} }), null);
});
```

- [ ] **Step 2:** run → FAIL.

- [ ] **Step 3: Implement** in `state.js`:

```js
export function registryKey(catalogId, quant) { return `${catalogId}@${quant}`; }
export function parseRegistryKey(key) {
  const at = typeof key === "string" ? key.indexOf("@") : -1;
  if (at <= 0 || at === key.length - 1) return null;
  return { catalogId: key.slice(0, at), quant: key.slice(at + 1) };
}

function emptyState() {
  return { reservations: {}, journal: {}, registry: {}, conversions: {}, runtimeOverride: null };
}

/** Legacy (Item G) registry keys were the model id. Re-key every entry that
 * carries catalogId + quant to `<catalogId>@<quant>`; entries without both
 * fields (hf-browser rows registered before this arc) keep their key. Pure
 * (returns a new object); idempotent. */
export function migrateRegistryKeys(registry) {
  const out = {};
  for (const [key, entry] of Object.entries(registry || {})) {
    const legacy = parseRegistryKey(key) === null && entry && typeof entry.catalogId === "string" && typeof entry.quant === "string";
    const newKey = legacy ? registryKey(entry.catalogId, entry.quant) : key;
    if (!(newKey in out)) out[newKey] = entry;
  }
  return out;
}

export function loadState(dir) {
  const path = statePath(dir);
  if (!existsSync(path)) return emptyState();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const obj = (k) => (parsed && typeof parsed[k] === "object" && parsed[k]) || {};
    return {
      reservations: obj("reservations"),
      journal: obj("journal"),
      registry: migrateRegistryKeys(obj("registry")),
      conversions: obj("conversions"),
      runtimeOverride: parsed && parsed.runtimeOverride && typeof parsed.runtimeOverride === "object" ? parsed.runtimeOverride : null,
    };
  } catch {
    return emptyState();
  }
}

export function findRegistryEntries(state, catalogId) {
  const out = [];
  for (const [key, entry] of Object.entries(state?.registry || {})) {
    const parsed = parseRegistryKey(key);
    if ((parsed && parsed.catalogId === catalogId) || (!parsed && key === catalogId)) out.push({ key, entry });
  }
  return out;
}

export function findRegistryEntryForProvider(state, provider) {
  const gp = provider?.gpuPolicy || {};
  if (typeof gp.catalogId !== "string" || typeof gp.quant !== "string") return null;
  const key = registryKey(gp.catalogId, gp.quant);
  const entry = state?.registry?.[key];
  return entry ? { key, entry } : null;
}
```
`saveState` is unchanged (it serializes whatever object it gets). Update `reconcileOnBoot`'s doc only if it mentions registry keys (it reads `reservations` and `journal`; leave logic as is).

- [ ] **Step 4:** `node scripts/run-suite.mjs tests/models-state.test.js tests/models-registration.test.js tests/gpu-orchestrator-native.test.js` → models-state PASS; the other two may FAIL on the key change — that is expected and is fixed in Tasks 8 and 10; note which tests broke.

- [ ] **Step 5: Commit**
```bash
git commit servers/gateway/models/state.js tests/models-state.test.js -m "feat(models-state): <catalogId>@<quant> registry key with legacy migration; conversions + runtimeOverride persisted"
```

---

### Task 6: `runtime-override.js`

**Files:**
- Create: `servers/gateway/models/runtime-override.js`
- Test: `tests/models-runtime-override.test.js`

**Interfaces (Produces):**
```js
export class RuntimeOverrideError extends Error // .code: "NOT_EXECUTABLE" | "VERSION_FAILED" | "NOT_ABSOLUTE"
export function getRuntimeOverride(dir, { env = process.env, loadStateFn, saveStateFn, accessSyncImpl } = {})
// -> { bin, label, version, setAt, source: "state" | "env" } | null ; bootstraps from env.CROW_LLAMA_SERVER_BIN once (persisting it) when state has none
export function setRuntimeOverride(dir, { bin, label = null }, { execFileSyncImpl, accessSyncImpl, loadStateFn, saveStateFn, now } = {})
// validates: absolute path, X_OK, `bin --version` exits 0 -> stores { bin, label, version, setAt } ; returns the record
export function clearRuntimeOverride(dir, { loadStateFn, saveStateFn } = {}) // -> true if one was set
export function parseLlamaServerVersion(output) // "version: 10068 (abc1234)" -> "b10068"; unknown -> first line trimmed
```

- [ ] **Step 1: Failing tests**

```js
// tests/models-runtime-override.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadState } from "../servers/gateway/models/state.js";
import { getRuntimeOverride, setRuntimeOverride, clearRuntimeOverride, parseLlamaServerVersion, RuntimeOverrideError } from "../servers/gateway/models/runtime-override.js";

const okAccess = () => {};
const okExec = () => "version: 10068 (abc1234)\nbuilt with cc\n";

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "rt-override-"));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("parseLlamaServerVersion maps llama-server's version line to a b-tag", () => {
  assert.equal(parseLlamaServerVersion("version: 10068 (abc1234)\nbuilt with"), "b10068");
  assert.equal(parseLlamaServerVersion("something else\n"), "something else");
});

test("getRuntimeOverride is null with no record and no env", () => withDir((dir) => {
  assert.equal(getRuntimeOverride(dir, { env: {} }), null);
}));

test("setRuntimeOverride validates and persists { bin, label, version, setAt }", () => withDir((dir) => {
  const rec = setRuntimeOverride(dir, { bin: "/opt/llama/llama-server", label: "rocm-7.2.3" },
    { execFileSyncImpl: okExec, accessSyncImpl: okAccess, now: () => new Date("2026-09-05T00:00:00Z") });
  assert.deepEqual(rec, { bin: "/opt/llama/llama-server", label: "rocm-7.2.3", version: "b10068", setAt: "2026-09-05T00:00:00.000Z" });
  assert.deepEqual(loadState(dir).runtimeOverride, rec);
  assert.equal(getRuntimeOverride(dir, { env: {} }).source, "state");
}));

test("setRuntimeOverride refuses a relative path, a non-executable, and a binary whose --version fails", () => withDir((dir) => {
  assert.throws(() => setRuntimeOverride(dir, { bin: "llama-server" }, { execFileSyncImpl: okExec, accessSyncImpl: okAccess }),
    (e) => e instanceof RuntimeOverrideError && e.code === "NOT_ABSOLUTE");
  assert.throws(() => setRuntimeOverride(dir, { bin: "/x/llama-server" }, { execFileSyncImpl: okExec, accessSyncImpl: () => { throw new Error("EACCES"); } }),
    (e) => e.code === "NOT_EXECUTABLE");
  assert.throws(() => setRuntimeOverride(dir, { bin: "/x/llama-server" }, { execFileSyncImpl: () => { throw new Error("boom"); }, accessSyncImpl: okAccess }),
    (e) => e.code === "VERSION_FAILED" && /boom/.test(e.message));
  assert.equal(loadState(dir).runtimeOverride, null);
}));

test("getRuntimeOverride bootstraps from CROW_LLAMA_SERVER_BIN once and persists it", () => withDir((dir) => {
  const env = { CROW_LLAMA_SERVER_BIN: "/env/llama-server" };
  const rec = getRuntimeOverride(dir, { env, accessSyncImpl: okAccess, execFileSyncImpl: okExec });
  assert.equal(rec.bin, "/env/llama-server");
  assert.equal(rec.source, "env");
  assert.equal(loadState(dir).runtimeOverride.bin, "/env/llama-server");
  // A stored record wins over env afterwards.
  setRuntimeOverride(dir, { bin: "/stored/llama-server" }, { execFileSyncImpl: okExec, accessSyncImpl: okAccess });
  assert.equal(getRuntimeOverride(dir, { env }).bin, "/stored/llama-server");
}));

test("getRuntimeOverride ignores an env bootstrap that fails validation (never throws)", () => withDir((dir) => {
  const env = { CROW_LLAMA_SERVER_BIN: "/missing/llama-server" };
  assert.equal(getRuntimeOverride(dir, { env, accessSyncImpl: () => { throw new Error("ENOENT"); } }), null);
}));

test("clearRuntimeOverride removes the record", () => withDir((dir) => {
  setRuntimeOverride(dir, { bin: "/x/llama-server" }, { execFileSyncImpl: okExec, accessSyncImpl: okAccess });
  assert.equal(clearRuntimeOverride(dir), true);
  assert.equal(getRuntimeOverride(dir, { env: {} }), null);
  assert.equal(clearRuntimeOverride(dir), false);
}));
```

- [ ] **Step 2:** run → FAIL (module missing).

- [ ] **Step 3: Implement**

```js
// servers/gateway/models/runtime-override.js
import { accessSync, constants } from "node:fs";
import { execFileSync } from "node:child_process";
import { isAbsolute } from "node:path";
import { loadState, saveState } from "./state.js";

export class RuntimeOverrideError extends Error {
  constructor(message, code, details = {}) { super(message); this.name = "RuntimeOverrideError"; this.code = code; Object.assign(this, details); }
}

export function parseLlamaServerVersion(output) {
  const text = String(output || "");
  const m = text.match(/version:\s*(\d+)/i);
  if (m) return `b${m[1]}`;
  return (text.split("\n")[0] || "").trim();
}

function validateBinary(bin, { accessSyncImpl = accessSync, execFileSyncImpl = execFileSync }) {
  if (typeof bin !== "string" || !isAbsolute(bin)) throw new RuntimeOverrideError(`runtime override must be an absolute path, got ${JSON.stringify(bin)}`, "NOT_ABSOLUTE");
  try { accessSyncImpl(bin, constants.X_OK); } catch (err) {
    throw new RuntimeOverrideError(`${bin} is not an executable file (${err.message})`, "NOT_EXECUTABLE", { bin });
  }
  let out;
  try {
    out = execFileSyncImpl(bin, ["--version"], { timeout: 10_000, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  } catch (err) {
    // llama-server prints its version to stderr and may exit 0; execFileSync throws only on non-zero exit / spawn failure.
    const stderr = err && err.stderr ? String(err.stderr) : "";
    if (err && err.status === 0 && stderr) out = stderr;
    else throw new RuntimeOverrideError(`${bin} --version failed: ${err.message}`, "VERSION_FAILED", { bin });
  }
  return parseLlamaServerVersion(out);
}

export function setRuntimeOverride(dir, { bin, label = null }, opts = {}) {
  const { loadStateFn = loadState, saveStateFn = saveState, now = () => new Date() } = opts;
  const version = validateBinary(bin, opts);
  const record = { bin, label, version, setAt: now().toISOString() };
  const state = loadStateFn(dir);
  state.runtimeOverride = record;
  saveStateFn(dir, state);
  return record;
}

export function clearRuntimeOverride(dir, { loadStateFn = loadState, saveStateFn = saveState } = {}) {
  const state = loadStateFn(dir);
  const had = !!state.runtimeOverride;
  state.runtimeOverride = null;
  saveStateFn(dir, state);
  return had;
}

export function getRuntimeOverride(dir, opts = {}) {
  const { env = process.env, loadStateFn = loadState } = opts;
  const stored = loadStateFn(dir).runtimeOverride;
  if (stored && typeof stored.bin === "string") return { ...stored, source: "state" };
  const envBin = env.CROW_LLAMA_SERVER_BIN;
  if (!envBin) return null;
  try {
    return { ...setRuntimeOverride(dir, { bin: envBin, label: "CROW_LLAMA_SERVER_BIN" }, opts), source: "env" };
  } catch {
    return null; // an invalid env bootstrap is ignored, never fatal at boot
  }
}
```
Note: llama-server writes `version:` to stderr; `execFileSync` returns stdout only. Merge both: pass `stdio: ["ignore", "pipe", "pipe"]` and, when the returned stdout has no `version:` line, fall back to spawning with `2>&1` semantics — the simplest correct form is `execFileSyncImpl(bin, ["--version"], { ..., encoding: "utf8", stdio: "pipe" })` and then read `err.stderr`/`err.stdout` on throw. Keep the implementation to what the tests exercise (stub returns a string), and add a real-binary smoke in Step 4.

- [ ] **Step 4:** tests PASS. Real-binary smoke (read-only, not a model start): `node -e 'import("./servers/gateway/models/runtime-override.js").then(m=>console.log(m.parseLlamaServerVersion(require("child_process").execFileSync("/home/kh0pp/llama-master/build/bin/llama-server",["--version"],{encoding:"utf8",stdio:["ignore","pipe","pipe"]}).toString()))).catch(e=>console.log("stderr path:",e.message))'` — confirm the version line is captured (adjust the stdout/stderr handling if it lands on stderr).

- [ ] **Step 5: Commit**
```bash
git add servers/gateway/models/runtime-override.js tests/models-runtime-override.test.js
git commit servers/gateway/models/runtime-override.js tests/models-runtime-override.test.js -m "feat(models): host-local llama-server runtime override with executable + --version validation"
```

---

### Task 7: door URLs, tailnet IP, and native locality (owner gate + loopback rewrite)

**Files:**
- Create: `servers/gateway/models/door.js`, `servers/shared/tailnet-ip.js`, `servers/shared/native-locality.js`
- Test: `tests/models-door-locality.test.js`

**Interfaces (Produces):**
```js
// door.js
export function gatewayPort(env = process.env) // Number(env.PORT || env.CROW_GATEWAY_PORT || 3001)
export function doorBaseUrl({ tailnetIp, port }) // `http://${tailnetIp || "127.0.0.1"}:${port}/llm/v1`
export function nativeLoopbackUrl(port) // `http://127.0.0.1:${port}/v1`
// tailnet-ip.js
export function getOwnTailnetIp({ env = process.env, execFileSyncImpl, cache = true } = {}) // env.CROW_TAILNET_IP wins; else `tailscale ip -4` first IPv4 line; null on failure; cached per process
export function _resetTailnetIpCache()
// native-locality.js
export function isOwnedHere(provider, ownInstanceId) // true | false | null (no owner declared)
export function isOrchestratableHere(provider, { ownAddrs, ownInstanceId }) // owner decides when declared; else isLocallyOrchestratable(provider, ownAddrs)
export function localizeNativeRow(provider, ownInstanceId) // owned native row with gpuPolicy.port -> { ...provider, doorUrl: provider.baseUrl, baseUrl: nativeLoopbackUrl(port) }; otherwise the same object
```

- [ ] **Step 1: Failing tests**

```js
// tests/models-door-locality.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { gatewayPort, doorBaseUrl, nativeLoopbackUrl } from "../servers/gateway/models/door.js";
import { getOwnTailnetIp, _resetTailnetIpCache } from "../servers/shared/tailnet-ip.js";
import { isOwnedHere, isOrchestratableHere, localizeNativeRow } from "../servers/shared/native-locality.js";

const OWN = new Set(["localhost", "127.0.0.1", "::1", "100.118.41.122"]);

test("gatewayPort: PORT wins, then CROW_GATEWAY_PORT, then 3001", () => {
  assert.equal(gatewayPort({ PORT: "3008", CROW_GATEWAY_PORT: "3001" }), 3008);
  assert.equal(gatewayPort({ CROW_GATEWAY_PORT: "3008" }), 3008);
  assert.equal(gatewayPort({}), 3001);
});

test("doorBaseUrl and nativeLoopbackUrl shapes", () => {
  assert.equal(doorBaseUrl({ tailnetIp: "100.118.41.122", port: 3001 }), "http://100.118.41.122:3001/llm/v1");
  assert.equal(doorBaseUrl({ tailnetIp: null, port: 3001 }), "http://127.0.0.1:3001/llm/v1");
  assert.equal(nativeLoopbackUrl(18100), "http://127.0.0.1:18100/v1");
});

test("getOwnTailnetIp: env override, tailscale output, failure -> null; cached", () => {
  _resetTailnetIpCache();
  assert.equal(getOwnTailnetIp({ env: { CROW_TAILNET_IP: "100.1.2.3" } }), "100.1.2.3");
  _resetTailnetIpCache();
  let calls = 0;
  const exec = () => { calls++; return "100.118.41.122\nfd7a:115c::1\n"; };
  assert.equal(getOwnTailnetIp({ env: {}, execFileSyncImpl: exec }), "100.118.41.122");
  assert.equal(getOwnTailnetIp({ env: {}, execFileSyncImpl: exec }), "100.118.41.122");
  assert.equal(calls, 1);
  _resetTailnetIpCache();
  assert.equal(getOwnTailnetIp({ env: {}, execFileSyncImpl: () => { throw new Error("no tailscale"); } }), null);
});

test("isOwnedHere: declared owner compares; undeclared is null", () => {
  assert.equal(isOwnedHere({ gpuPolicy: { owner: "A" } }, "A"), true);
  assert.equal(isOwnedHere({ gpuPolicy: { owner: "A" } }, "B"), false);
  assert.equal(isOwnedHere({ gpuPolicy: {} }, "B"), null);
  assert.equal(isOwnedHere({}, "B"), null);
});

test("isOrchestratableHere: owner gate wins over the baseUrl-hostname rule; falls back to it when no owner", () => {
  const door = { baseUrl: "http://100.118.41.122:3001/llm/v1", gpuPolicy: { runtime: "native", owner: "crow" } };
  assert.equal(isOrchestratableHere(door, { ownAddrs: OWN, ownInstanceId: "crow" }), true);
  // r4 shares the box: same tailnet address is in OWN, but the owner is crow -> not orchestratable on r4.
  assert.equal(isOrchestratableHere(door, { ownAddrs: OWN, ownInstanceId: "r4" }), false);
  const bundle = { baseUrl: "http://100.118.41.122:8003/v1", bundleId: "x" };
  assert.equal(isOrchestratableHere(bundle, { ownAddrs: OWN, ownInstanceId: "r4" }), true); // unchanged legacy rule
  assert.equal(isOrchestratableHere({ baseUrl: "http://100.121.254.89:9100/v1" }, { ownAddrs: OWN, ownInstanceId: "crow" }), false);
});

test("localizeNativeRow rewrites an owned native row to loopback and keeps the door; leaves everything else untouched", () => {
  const row = { baseUrl: "http://100.118.41.122:3001/llm/v1", gpuPolicy: { runtime: "native", owner: "crow", port: 18100 } };
  const local = localizeNativeRow(row, "crow");
  assert.equal(local.baseUrl, "http://127.0.0.1:18100/v1");
  assert.equal(local.doorUrl, "http://100.118.41.122:3001/llm/v1");
  assert.equal(row.baseUrl, "http://100.118.41.122:3001/llm/v1", "input not mutated");
  assert.equal(localizeNativeRow(row, "r4"), row);
  assert.equal(localizeNativeRow({ baseUrl: "http://x/v1", bundleId: "b" }, "crow").baseUrl, "http://x/v1");
  const noPort = { baseUrl: "http://127.0.0.1:18100/v1", gpuPolicy: { runtime: "native", owner: "crow" } };
  assert.equal(localizeNativeRow(noPort, "crow").baseUrl, "http://127.0.0.1:18100/v1"); // pre-arc row: already loopback, no rewrite
});
```

- [ ] **Step 2:** run → FAIL (modules missing).

- [ ] **Step 3: Implement**

```js
// servers/gateway/models/door.js
export function gatewayPort(env = process.env) {
  const raw = Number.parseInt(env.PORT || env.CROW_GATEWAY_PORT || "3001", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 3001;
}
export function doorBaseUrl({ tailnetIp, port }) { return `http://${tailnetIp || "127.0.0.1"}:${port}/llm/v1`; }
export function nativeLoopbackUrl(port) { return `http://127.0.0.1:${port}/v1`; }
```
```js
// servers/shared/tailnet-ip.js
import { execFileSync } from "node:child_process";
let _cached; // undefined = not yet probed
export function _resetTailnetIpCache() { _cached = undefined; }
export function getOwnTailnetIp({ env = process.env, execFileSyncImpl = execFileSync, cache = true } = {}) {
  if (env.CROW_TAILNET_IP) return env.CROW_TAILNET_IP;
  if (cache && _cached !== undefined) return _cached;
  let ip = null;
  try {
    const out = String(execFileSyncImpl("tailscale", ["ip", "-4"], { timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }));
    ip = out.split("\n").map((l) => l.trim()).find((l) => /^\d+\.\d+\.\d+\.\d+$/.test(l)) || null;
  } catch { ip = null; }
  if (cache) _cached = ip;
  return ip;
}
```
```js
// servers/shared/native-locality.js
import { isLocallyOrchestratable } from "./locality.js";
import { nativeLoopbackUrl } from "../gateway/models/door.js";

export function isOwnedHere(provider, ownInstanceId) {
  const owner = provider?.gpuPolicy?.owner;
  if (typeof owner !== "string" || !owner) return null;
  return owner === ownInstanceId;
}
export function isOrchestratableHere(provider, { ownAddrs, ownInstanceId }) {
  const owned = isOwnedHere(provider, ownInstanceId);
  if (owned !== null) return owned;
  return isLocallyOrchestratable(provider, ownAddrs);
}
export function localizeNativeRow(provider, ownInstanceId) {
  const gp = provider?.gpuPolicy;
  if (!gp || gp.runtime !== "native" || isOwnedHere(provider, ownInstanceId) !== true) return provider;
  const port = Number(gp.port);
  if (!Number.isInteger(port) || port <= 0) return provider;
  const loop = nativeLoopbackUrl(port);
  if (provider.baseUrl === loop) return provider;
  return { ...provider, doorUrl: provider.baseUrl, baseUrl: loop };
}
```

- [ ] **Step 4:** PASS.

- [ ] **Step 5: Commit**
```bash
git add servers/gateway/models/door.js servers/shared/tailnet-ip.js servers/shared/native-locality.js tests/models-door-locality.test.js
git commit servers/gateway/models/door.js servers/shared/tailnet-ip.js servers/shared/native-locality.js tests/models-door-locality.test.js -m "feat(models): gateway door URL, tailnet IP probe, owner-gated native locality"
```

---

### Task 8: `registerModel` — roles, variants, conversion, door + owner; `unregisterModel` adopted- and shared-weights-safe; vision joins the chat group

**Files:**
- Modify: `servers/gateway/models/manager.js` (`isChatClassRow` ~1250, `registerModel` 1352-1467, `unregisterModel` 1469-1520)
- Test: `tests/models-registration.test.js`

**Interfaces (Produces):**
```js
export async function registerModel({
  modelId, quant, catalog, db, dir,
  providerId = modelId,           // the provider row id (role or variant)
  launch = null,                  // gpu_policy.launch override (validated with validateLaunch against the catalog context_len)
  mutexGroup,                     // undefined = auto (chat/vision -> pickChatMutexGroup; else none); null = explicitly none; string = that group
  alwaysResident = false, defaultMember = false,
  registryExtra = {},             // spread LAST onto the registry entry (adopt uses: path, adopted, verified, companions)
  ownInstanceIdFn = getOrCreateLocalInstanceId, tailnetIpFn = getOwnTailnetIp, gatewayPortFn = gatewayPort,
  allocatePortFn, listProvidersAllFn, upsertProviderFn, invalidateCacheFn,
}) // -> { id: providerId, providerId, registryKey, baseUrl (door), doorUrl, port, models, gpuPolicy, converted: boolean, ... }
// gpuPolicy written: { runtime:"native", catalogId, quant, port, owner, alwaysResident, defaultMember, [mutexGroup], [launch] }
// Converting an existing BUNDLE row at providerId: allowed; snapshot -> state.conversions[providerId] = { row, at }; bundle_id -> null.
export async function unregisterModel({ modelId /* = providerId */, db, dir, runtimeHandle, ... })
// resolves the registry key from the row's gpuPolicy (fallback: modelId); deletes the registry entry ONLY when no other enabled row references the same key; never unlinks an adopted entry; unlinks `entry.path` (or blob path) otherwise.
```

- [ ] **Step 1: Failing tests** (append; use the file's `freshLibsql`, `makeCatalog`, `dbRow`; add `launch` to `makeCatalog`'s chat model: `launch: { ctx: 4096, ngl: 999 }`)

```js
const REG_OPTS = (h) => ({ db: h.db, dir: h.dir, allocatePortFn: async (state, id) => { state.reservations[id] = { port: 18150, owner: {} }; return 18150; },
  ownInstanceIdFn: () => "inst-A", tailnetIpFn: () => "100.118.41.122", gatewayPortFn: () => 3001 });

test("registerModel: row carries the door base_url, owner, port, catalogId/quant; registry key is <id>@<quant>", async () => {
  const h = freshLibsql();
  try {
    const r = await registerModel({ modelId: "chat-test-model", quant: "Q4_K_M", catalog: makeCatalog(), ...REG_OPTS(h) });
    assert.equal(r.baseUrl, "http://100.118.41.122:3001/llm/v1");
    assert.equal(r.port, 18150);
    assert.equal(r.registryKey, "chat-test-model@Q4_K_M");
    const row = await dbRow(h.db, "chat-test-model");
    const gp = JSON.parse(row.gpu_policy);
    assert.equal(row.base_url, "http://100.118.41.122:3001/llm/v1");
    assert.deepEqual({ runtime: gp.runtime, catalogId: gp.catalogId, quant: gp.quant, port: gp.port, owner: gp.owner, alwaysResident: gp.alwaysResident, defaultMember: gp.defaultMember },
      { runtime: "native", catalogId: "chat-test-model", quant: "Q4_K_M", port: 18150, owner: "inst-A", alwaysResident: false, defaultMember: false });
    assert.ok(loadState(h.dir).registry["chat-test-model@Q4_K_M"]);
    assert.equal(loadState(h.dir).registry["chat-test-model"], undefined);
  } finally { h.cleanup(); }
});

test("registerModel: no tailnet ip -> loopback door and local_only:true", async () => {
  const h = freshLibsql();
  try {
    const r = await registerModel({ modelId: "chat-test-model", quant: "Q4_K_M", catalog: makeCatalog(), ...REG_OPTS(h), tailnetIpFn: () => null });
    assert.equal(r.baseUrl, "http://127.0.0.1:3001/llm/v1");
    assert.equal(JSON.parse((await dbRow(h.db, "chat-test-model")).gpu_policy).local_only, true);
  } finally { h.cleanup(); }
});

test("registerModel: providerId decouples the row id from the model id (a role)", async () => {
  const h = freshLibsql();
  try {
    const r = await registerModel({ modelId: "chat-test-model", quant: "Q4_K_M", catalog: makeCatalog(), providerId: "crow-chat", ...REG_OPTS(h) });
    assert.equal(r.id, "crow-chat");
    const row = await dbRow(h.db, "crow-chat");
    assert.equal(JSON.parse(row.models)[0].id, "chat-test-model");
    assert.equal(loadState(h.dir).reservations["crow-chat"].port, 18150);
  } finally { h.cleanup(); }
});

test("registerModel: two variants share one registry entry; unregistering one keeps the weights and the entry", async () => {
  const h = freshLibsql();
  let n = 0;
  const alloc = async (state, id) => { const port = 18160 + n++; state.reservations[id] = { port, owner: {} }; return port; };
  try {
    const opts = { ...REG_OPTS(h), allocatePortFn: alloc };
    await registerModel({ modelId: "chat-test-model", quant: "Q4_K_M", catalog: makeCatalog(), providerId: "v-solo", launch: { ctx: 4096 }, ...opts });
    await registerModel({ modelId: "chat-test-model", quant: "Q4_K_M", catalog: makeCatalog(), providerId: "v-copilot", launch: { ctx: 2048 }, ...opts });
    assert.equal(Object.keys(loadState(h.dir).registry).length, 1);
    assert.equal(JSON.parse((await dbRow(h.db, "v-copilot")).gpu_policy).launch.ctx, 2048);
    let unlinked = 0;
    await unregisterModel({ modelId: "v-copilot", db: h.db, dir: h.dir, unlinkFn: () => { unlinked++; } });
    assert.equal(unlinked, 0, "shared weights untouched while v-solo still references them");
    assert.ok(loadState(h.dir).registry["chat-test-model@Q4_K_M"]);
    assert.equal((await dbRow(h.db, "v-copilot")).disabled, 1);
    await unregisterModel({ modelId: "v-solo", db: h.db, dir: h.dir, unlinkFn: () => { unlinked++; } });
    assert.ok(unlinked >= 1, "last reference removes the blob");
    assert.equal(loadState(h.dir).registry["chat-test-model@Q4_K_M"], undefined);
  } finally { h.cleanup(); }
});

test("registerModel: launch override is validated against the catalog context_len", async () => {
  const h = freshLibsql();
  try {
    await assert.rejects(
      registerModel({ modelId: "chat-test-model", quant: "Q4_K_M", catalog: makeCatalog(), launch: { ctx: 999999 }, ...REG_OPTS(h) }),
      (e) => e.code === "INVALID_LAUNCH" && /exceeds context_len/.test(e.message));
  } finally { h.cleanup(); }
});

test("registerModel: converts an existing BUNDLE row of the same id, snapshotting it to state.conversions", async () => {
  const h = freshLibsql();
  try {
    await upsertProvider(h.db, { id: "crow-chat", baseUrl: "http://100.118.41.122:8003/v1", host: "local", bundleId: "llamacpp-vulkan-qwen36-35b-a3b",
      models: [{ id: "qwen3.6-35b-a3b", task: "chat" }], gpuPolicy: { mutexGroup: "crow-strix-vram", alwaysResident: false, defaultMember: true } });
    const r = await registerModel({ modelId: "chat-test-model", quant: "Q4_K_M", catalog: makeCatalog(), providerId: "crow-chat", defaultMember: true, ...REG_OPTS(h) });
    assert.equal(r.converted, true);
    const row = await dbRow(h.db, "crow-chat");
    assert.equal(row.bundle_id, null);
    assert.equal(JSON.parse(row.gpu_policy).mutexGroup, "crow-strix-vram", "auto mutex joins the group the converted row already had");
    const snap = loadState(h.dir).conversions["crow-chat"];
    assert.equal(snap.row.bundle_id, "llamacpp-vulkan-qwen36-35b-a3b");
    assert.equal(snap.row.base_url, "http://100.118.41.122:8003/v1");
    assert.match(snap.at, /^\d{4}-/);
  } finally { h.cleanup(); }
});

test("registerModel: still refuses to clobber a foreign non-bundle, non-native row (cloud provider)", async () => {
  const h = freshLibsql();
  try {
    await upsertProvider(h.db, { id: "zai", baseUrl: "https://api.z.ai/v1", host: "cloud", models: [{ id: "glm-5" }] });
    await assert.rejects(registerModel({ modelId: "chat-test-model", quant: "Q4_K_M", catalog: makeCatalog(), providerId: "zai", ...REG_OPTS(h) }), ProviderIdConflictError);
  } finally { h.cleanup(); }
});

test("registerModel: mutexGroup null = none even for chat; explicit string wins; alwaysResident/defaultMember persisted", async () => {
  const h = freshLibsql();
  try {
    await registerModel({ modelId: "chat-test-model", quant: "Q4_K_M", catalog: makeCatalog(), providerId: "voice", mutexGroup: null, alwaysResident: true, ...REG_OPTS(h) });
    const gp = JSON.parse((await dbRow(h.db, "voice")).gpu_policy);
    assert.equal("mutexGroup" in gp, false);
    assert.equal(gp.alwaysResident, true);
    await registerModel({ modelId: "chat-test-model", quant: "Q4_K_M", catalog: makeCatalog(), providerId: "chat2", mutexGroup: "my-group", defaultMember: true, ...REG_OPTS(h) });
    const gp2 = JSON.parse((await dbRow(h.db, "chat2")).gpu_policy);
    assert.equal(gp2.mutexGroup, "my-group");
    assert.equal(gp2.defaultMember, true);
  } finally { h.cleanup(); }
});

test("registerModel: a vision-task model joins the chat mutex group by default", async () => {
  const h = freshLibsql();
  try {
    const catalog = makeCatalog();
    catalog.models.push({ ...catalog.models[0], id: "vl-test", task: "vision", quants: catalog.models[0].quants });
    await registerModel({ modelId: "vl-test", quant: "Q4_K_M", catalog, ...REG_OPTS(h) });
    assert.equal(JSON.parse((await dbRow(h.db, "vl-test")).gpu_policy).mutexGroup, "local-llm");
  } finally { h.cleanup(); }
});

test("pickChatMutexGroup counts vision rows as chat-class", () => {
  const rows = [{ id: "a", gpuPolicy: { mutexGroup: "g1" }, models: [{ id: "m", task: "vision" }] }];
  assert.equal(pickChatMutexGroup(rows), "g1");
});

test("unregisterModel: never unlinks an adopted entry", async () => {
  const h = freshLibsql();
  try {
    await registerModel({ modelId: "chat-test-model", quant: "Q4_K_M", catalog: makeCatalog(), ...REG_OPTS(h),
      registryExtra: { path: "/mnt/weights/chat.gguf", adopted: true, verified: true } });
    let unlinked = 0;
    await unregisterModel({ modelId: "chat-test-model", db: h.db, dir: h.dir, unlinkFn: () => { unlinked++; } });
    assert.equal(unlinked, 0);
    assert.equal(loadState(h.dir).registry["chat-test-model@Q4_K_M"], undefined);
  } finally { h.cleanup(); }
});
```
Also update the existing tests in this file that read `state.registry["chat-test-model"]` to read `state.registry["chat-test-model@Q4_K_M"]` (grep `registry\[` in the file), and the test asserting `base_url` is `http://127.0.0.1:<port>/v1` to assert the door shape instead (the port now lives in `gpu_policy.port`; the `port` return field still equals the allocated port).

- [ ] **Step 2:** run → FAIL.

- [ ] **Step 3: Implement** in `manager.js`:

Imports:
```js
import { loadState, saveState, allocatePort, releasePort, registryKey, findRegistryEntryForProvider } from "./state.js";
import { validateLaunch } from "./launch.js";
import { doorBaseUrl, gatewayPort } from "./door.js";
import { getOwnTailnetIp } from "../../shared/tailnet-ip.js";
import { getOrCreateLocalInstanceId } from "../instance-registry.js";
```
(Keep whatever `state.js` names are already imported; add the new ones.)

```js
export class InvalidLaunchError extends Error {
  constructor(errors) { super(`invalid launch override: ${errors.join("; ")}`); this.name = "InvalidLaunchError"; this.code = "INVALID_LAUNCH"; this.errors = errors; }
}

function isChatClassRow(row) {
  return Array.isArray(row.models) && row.models.some((m) => m && (m.task === "chat" || m.task === "vision"));
}
```
`registerModel` body (replace from the collision guard through the return):
```js
  const { model, quantEntry } = resolveEntry(catalog, modelId, quant);
  const key = registryKey(model.id, quantEntry.quant);

  if (launch !== null && launch !== undefined) {
    const hasMtp = (Array.isArray(model.tags) && model.tags.includes("mtp"))
      || (Array.isArray(model.companions) && model.companions.some((c) => c && c.kind === "mtp"));
    const errs = validateLaunch(launch, { contextLen: model.context_len, label: "launch", hasMtp });
    if (errs.length) throw new InvalidLaunchError(errs);
  }

  const state = loadState(dir);
  const existingRows = await listProvidersAllFn(db);
  const existingRow = existingRows.find((r) => r.id === providerId) || null;
  let converted = false;
  if (existingRow) {
    const isOurs = existingRow.gpuPolicy?.runtime === NATIVE_RUNTIME
      && Array.isArray(existingRow.models) && existingRow.models.some((m) => m && m.id === model.id);
    const isBundleRow = !!existingRow.bundleId;
    if (!isOurs && !isBundleRow) throw new ProviderIdConflictError(providerId);
    converted = isBundleRow;
  }

  // Port: keep the port an existing native row already advertises; a fresh row (or a converted bundle row) allocates.
  const existingPort = existingRow?.gpuPolicy?.runtime === NATIVE_RUNTIME ? Number(existingRow.gpuPolicy.port) : NaN;
  const port = Number.isInteger(existingPort) && existingPort > 0
    ? existingPort
    : await allocatePortFn(state, providerId, { crowHome: dir, pid: process.pid });

  if (converted) {
    state.conversions[providerId] = {
      at: new Date().toISOString(),
      row: { id: existingRow.id, base_url: existingRow.baseUrl, api_key: existingRow.apiKey ?? null, host: existingRow.host, bundle_id: existingRow.bundleId,
        description: existingRow.description ?? null, models: existingRow.models, provider_type: existingRow.provider_type ?? null, gpu_policy: existingRow.gpuPolicy ?? null },
    };
  }

  const plannedFiles = planFiles(model, quantEntry);
  state.registry[key] = {
    ...(state.registry[key] || {}),
    file: sanitizeFilename(quantEntry.file),
    quant: quantEntry.quant,
    catalogId: model.id,
    registeredAt: state.registry[key]?.registeredAt || new Date().toISOString(),
    sizeMb: Number.isFinite(quantEntry.size_mb) ? quantEntry.size_mb : null,
    shardFiles: plannedFiles.filter((f) => f.role === "shard").map((f) => f.dest),
    companions: plannedFiles.filter((f) => f.role === "companion").map((f) => ({ kind: f.kind, file: f.dest })),
    ...registryExtra,
  };
  saveState(dir, state);

  const owner = ownInstanceIdFn();
  const tailnetIp = tailnetIpFn();
  const gpuPolicy = { runtime: NATIVE_RUNTIME, catalogId: model.id, quant: quantEntry.quant, port, owner, alwaysResident: !!alwaysResident, defaultMember: !!defaultMember };
  if (!tailnetIp) gpuPolicy.local_only = true;
  if (launch !== null && launch !== undefined) gpuPolicy.launch = launch;
  if (mutexGroup === undefined) {
    if (model.task === "chat" || model.task === "vision") {
      const inherited = converted ? existingRow.gpuPolicy?.mutexGroup : null;
      gpuPolicy.mutexGroup = inherited || pickChatMutexGroup(existingRows.filter((r) => r.id !== providerId));
    }
  } else if (typeof mutexGroup === "string" && mutexGroup) {
    gpuPolicy.mutexGroup = mutexGroup;
  } // null -> no key at all

  const baseUrl = doorBaseUrl({ tailnetIp, port: gatewayPortFn() });
  const models = [{ id: model.id, task: model.task, contextLen: model.context_len,
    ...(model.chat_template_kwargs && typeof model.chat_template_kwargs === "object" ? { chatTemplateKwargs: model.chat_template_kwargs } : {}) }];
  const description = `${model.family} ${quantEntry.quant} (native)`;

  const upserted = await upsertProviderFn(db, { id: providerId, baseUrl, apiKey: null, host: "local", bundleId: null, description, models,
    disabled: false, providerType: "openai-compat", gpuPolicy });
  await invalidateCacheFn();

  return { id: providerId, providerId, registryKey: key, baseUrl, doorUrl: baseUrl, port, apiKey: null, host: "local", bundleId: null,
    description, models, gpuPolicy, disabled: false, converted, lamport_ts: upserted.lamport_ts };
```
Note `upsertProvider` uses `COALESCE(excluded.gpu_policy, providers.gpu_policy)` — we always pass a full `gpuPolicy`, so the converted row's old policy is replaced, not merged.

`unregisterModel`: after `releasePortFn(state, modelId)`:
```js
  const rows = await listProvidersAllFn(db);              // add `listProvidersAllFn = listProvidersAll` to the params
  const self = rows.find((r) => r.id === modelId) || null;
  const found = self ? findRegistryEntryForProvider(state, self) : null;
  const key = found ? found.key : modelId;
  const regEntry = state.registry[key];
  const otherRefs = rows.filter((r) => r.id !== modelId && !r.disabled && r.gpuPolicy?.runtime === NATIVE_RUNTIME
    && r.gpuPolicy.catalogId && r.gpuPolicy.quant && registryKey(r.gpuPolicy.catalogId, r.gpuPolicy.quant) === key);
  const lastReference = otherRefs.length === 0;
  if (lastReference) delete state.registry[key];
  saveState(dir, state);

  let deleted = false;
  if (lastReference && regEntry?.file && !regEntry.adopted) {
    const primary = regEntry.path || join(modelsBlobDir(dir), regEntry.file);
    const owned = [primary,
      ...(Array.isArray(regEntry.shardFiles) ? regEntry.shardFiles.map((n) => join(modelsBlobDir(dir), n)) : []),
      ...(Array.isArray(regEntry.companions) ? regEntry.companions.map((c) => c && (c.path || (c.file && join(modelsBlobDir(dir), c.file)))) : [])]
      .filter((p) => typeof p === "string" && p.length > 0);
    for (const dest of owned) {
      try { unlinkFn(dest); deleted = true; } catch (err) { if (err && err.code !== "ENOENT") throw err; }
    }
  }
```
(then the existing `disableProviderFn` + `invalidateCacheFn` + return.)

- [ ] **Step 4:** `node scripts/run-suite.mjs tests/models-registration.test.js tests/models-manager.test.js` → PASS (fix the pre-existing tests per the note in Step 1).

- [ ] **Step 5: Commit**
```bash
git commit servers/gateway/models/manager.js tests/models-registration.test.js -m "feat(models): registerModel roles/variants/conversion with door base_url + owner; unregister safe for adopted and shared weights"
```

---

### Task 9: `adoptModel` — register weights already on disk

**Files:**
- Modify: `servers/gateway/models/manager.js` (new export beside `registerModel`)
- Test: `tests/models-adopt.test.js`

**Interfaces (Produces):**
```js
export class AdoptMismatchError extends Error // .code: "ADOPT_SHA_MISMATCH" | "ADOPT_SIZE_MISMATCH" | "ADOPT_FILE_MISSING" | "ADOPT_COMPANION_MISSING"; .expected, .actual, .file
export async function hashFileSha256(path, { createReadStreamImpl } = {}) // -> hex
export async function adoptModel({
  modelId, quant, path, companionPaths = {},   // companionPaths: { mmproj: "/abs/mmproj.gguf", mtp: "/abs/mtp.gguf" }
  catalog, db, dir, allowUnverified = false,
  hashFileFn = hashFileSha256, statFn = statSync,
  ...registerOpts                              // providerId, launch, mutexGroup, alwaysResident, defaultMember + the injectable seams
}) // -> registerModel's result plus { adopted: true, verified: boolean }
```
Rules: `path` must exist (`ADOPT_FILE_MISSING`). Verified mode (default): sha256 of `path` must equal `quantEntry.sha256` (`ADOPT_SHA_MISMATCH`, message names the expected quant + file); every catalog companion needs a path whose sha matches (`ADOPT_COMPANION_MISSING` when absent). Unverified mode (`allowUnverified: true`): byte size must be within 0.5% of `size_mb * 1e6` (`ADOPT_SIZE_MISMATCH`), companions checked by size the same way; result `verified: false`. Sharded quants: `path` is the primary part; the shards are expected as siblings in the same directory with their catalog basenames (checked for existence only in unverified mode, by sha in verified mode). Registry extra written: `{ path, adopted: true, verified, companions: [{ kind, file: basename(path), path }], shardFiles: [siblings' basenames] }`.

- [ ] **Step 1: Failing tests**

```js
// tests/models-adopt.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { adoptModel, hashFileSha256, AdoptMismatchError } from "../servers/gateway/models/manager.js";
import { loadState } from "../servers/gateway/models/state.js";
import { setProviderSyncManager } from "../servers/shared/providers-db.js";

function freshLibsql() { /* copy verbatim from tests/models-registration.test.js */ }
const sha = (buf) => createHash("sha256").update(buf).digest("hex");

function catalogFor(files) {
  // files: { primary: Buffer, mmproj?: Buffer }
  return { version: 1, runtime: { name: "llama.cpp", release: "b10068", assets: {} }, models: [{
    id: "adopt-test", family: "T", lab: "L", hf_repo: "t/adopt-GGUF", license: "apache-2.0", gated: false, task: "chat", context_len: 8192,
    min_runtime_version: "b10068", default_quant: "Q8_0", tags: [], first_run_default: true,
    companions: files.mmproj ? [{ kind: "mmproj", file: "mmproj-F16.gguf", size_mb: files.mmproj.length / 1e6, sha256: sha(files.mmproj) }] : [],
    quants: [{ file: "adopt-test-Q8_0.gguf", quant: "Q8_0", size_mb: files.primary.length / 1e6, min_ram_mb: 1, min_vram_mb: 0, sha256: sha(files.primary) }],
  }] };
}
const OPTS = (h) => ({ db: h.db, dir: h.dir, allocatePortFn: async (s, id) => { s.reservations[id] = { port: 18170, owner: {} }; return 18170; },
  ownInstanceIdFn: () => "inst-A", tailnetIpFn: () => "100.118.41.122", gatewayPortFn: () => 3001 });

test("hashFileSha256 streams a file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "adopt-"));
  try {
    writeFileSync(join(dir, "f"), "hello");
    assert.equal(await hashFileSha256(join(dir, "f")), sha(Buffer.from("hello")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("adoptModel: verified adoption registers with path/adopted/verified and never copies", async () => {
  const h = freshLibsql();
  const weights = mkdtempSync(join(tmpdir(), "weights-"));
  try {
    const primary = Buffer.from("primary-bytes"), mmproj = Buffer.from("mmproj-bytes");
    writeFileSync(join(weights, "big.gguf"), primary); writeFileSync(join(weights, "proj.gguf"), mmproj);
    const r = await adoptModel({ modelId: "adopt-test", quant: "Q8_0", path: join(weights, "big.gguf"), companionPaths: { mmproj: join(weights, "proj.gguf") },
      catalog: catalogFor({ primary, mmproj }), ...OPTS(h) });
    assert.equal(r.adopted, true); assert.equal(r.verified, true);
    const entry = loadState(h.dir).registry["adopt-test@Q8_0"];
    assert.equal(entry.path, join(weights, "big.gguf"));
    assert.equal(entry.adopted, true);
    assert.deepEqual(entry.companions, [{ kind: "mmproj", file: "proj.gguf", path: join(weights, "proj.gguf") }]);
    assert.equal(statSync(join(weights, "big.gguf")).size, primary.length, "file untouched");
  } finally { h.cleanup(); rmSync(weights, { recursive: true, force: true }); }
});

test("adoptModel: sha mismatch refuses, naming the expected quant and file", async () => {
  const h = freshLibsql();
  const weights = mkdtempSync(join(tmpdir(), "weights-"));
  try {
    writeFileSync(join(weights, "big.gguf"), "wrong-bytes");
    await assert.rejects(adoptModel({ modelId: "adopt-test", quant: "Q8_0", path: join(weights, "big.gguf"), catalog: catalogFor({ primary: Buffer.from("primary-bytes") }), ...OPTS(h) }),
      (e) => e instanceof AdoptMismatchError && e.code === "ADOPT_SHA_MISMATCH" && /Q8_0/.test(e.message) && /adopt-test-Q8_0\.gguf/.test(e.message));
    assert.equal(Object.keys(loadState(h.dir).registry).length, 0, "nothing registered");
  } finally { h.cleanup(); rmSync(weights, { recursive: true, force: true }); }
});

test("adoptModel: missing companion path refuses; missing primary refuses", async () => {
  const h = freshLibsql();
  const weights = mkdtempSync(join(tmpdir(), "weights-"));
  try {
    const primary = Buffer.from("primary-bytes"), mmproj = Buffer.from("mmproj-bytes");
    writeFileSync(join(weights, "big.gguf"), primary);
    await assert.rejects(adoptModel({ modelId: "adopt-test", quant: "Q8_0", path: join(weights, "big.gguf"), catalog: catalogFor({ primary, mmproj }), ...OPTS(h) }),
      (e) => e.code === "ADOPT_COMPANION_MISSING" && /mmproj/.test(e.message));
    await assert.rejects(adoptModel({ modelId: "adopt-test", quant: "Q8_0", path: join(weights, "nope.gguf"), catalog: catalogFor({ primary }), ...OPTS(h) }),
      (e) => e.code === "ADOPT_FILE_MISSING");
  } finally { h.cleanup(); rmSync(weights, { recursive: true, force: true }); }
});

test("adoptModel: allowUnverified matches by size (0.5%) and marks verified:false; size mismatch refuses", async () => {
  const h = freshLibsql();
  const weights = mkdtempSync(join(tmpdir(), "weights-"));
  try {
    const primary = Buffer.alloc(10_000, 1);
    writeFileSync(join(weights, "big.gguf"), Buffer.alloc(10_000, 2)); // same size, different bytes
    const r = await adoptModel({ modelId: "adopt-test", quant: "Q8_0", path: join(weights, "big.gguf"), catalog: catalogFor({ primary }), allowUnverified: true, ...OPTS(h) });
    assert.equal(r.verified, false);
    assert.equal(loadState(h.dir).registry["adopt-test@Q8_0"].verified, false);
  } finally { h.cleanup(); rmSync(weights, { recursive: true, force: true }); }
  const h2 = freshLibsql();
  const w2 = mkdtempSync(join(tmpdir(), "weights-"));
  try {
    writeFileSync(join(w2, "big.gguf"), Buffer.alloc(5_000, 2));
    await assert.rejects(adoptModel({ modelId: "adopt-test", quant: "Q8_0", path: join(w2, "big.gguf"), catalog: catalogFor({ primary: Buffer.alloc(10_000, 1) }), allowUnverified: true, ...OPTS(h2) }),
      (e) => e.code === "ADOPT_SIZE_MISMATCH");
  } finally { h2.cleanup(); rmSync(w2, { recursive: true, force: true }); }
});

test("adoptModel: passes providerId/launch/mutexGroup through to registerModel", async () => {
  const h = freshLibsql();
  const weights = mkdtempSync(join(tmpdir(), "weights-"));
  try {
    const primary = Buffer.from("primary-bytes");
    writeFileSync(join(weights, "big.gguf"), primary);
    const r = await adoptModel({ modelId: "adopt-test", quant: "Q8_0", path: join(weights, "big.gguf"), catalog: catalogFor({ primary }),
      providerId: "crow-chat", launch: { ctx: 4096 }, mutexGroup: "crow-strix-vram", defaultMember: true, ...OPTS(h) });
    assert.equal(r.id, "crow-chat");
    assert.equal(r.gpuPolicy.launch.ctx, 4096);
    assert.equal(r.gpuPolicy.mutexGroup, "crow-strix-vram");
  } finally { h.cleanup(); rmSync(weights, { recursive: true, force: true }); }
});
```

- [ ] **Step 2:** FAIL.

- [ ] **Step 3: Implement** in `manager.js`:

```js
import { createReadStream, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export class AdoptMismatchError extends Error {
  constructor(message, code, details = {}) { super(message); this.name = "AdoptMismatchError"; this.code = code; Object.assign(this, details); }
}

export function hashFileSha256(path, { createReadStreamImpl = createReadStream } = {}) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStreamImpl(path).on("data", (c) => hash.update(c)).on("error", reject).on("end", () => resolve(hash.digest("hex")));
  });
}

function sizeMatches(actualBytes, sizeMb) {
  const expected = sizeMb * 1e6;
  return Math.abs(actualBytes - expected) <= expected * 0.005;
}

async function checkAdoptFile({ path, expectedSha, sizeMb, allowUnverified, hashFileFn, statFn, what }) {
  let st;
  try { st = statFn(path); } catch { throw new AdoptMismatchError(`${what}: file not found at ${path}`, "ADOPT_FILE_MISSING", { file: path }); }
  if (!allowUnverified) {
    const actual = await hashFileFn(path);
    if (actual !== expectedSha) {
      throw new AdoptMismatchError(`${what}: sha256 of ${path} is ${actual}, expected ${expectedSha}`, "ADOPT_SHA_MISMATCH", { file: path, expected: expectedSha, actual });
    }
    return true;
  }
  if (!sizeMatches(st.size, sizeMb)) {
    throw new AdoptMismatchError(`${what}: ${path} is ${st.size} bytes, expected about ${Math.round(sizeMb * 1e6)}`, "ADOPT_SIZE_MISMATCH", { file: path, expected: Math.round(sizeMb * 1e6), actual: st.size });
  }
  return false;
}

export async function adoptModel({ modelId, quant, path, companionPaths = {}, catalog, allowUnverified = false,
  hashFileFn = hashFileSha256, statFn = statSync, ...registerOpts }) {
  const { model, quantEntry } = resolveEntry(catalog, modelId, quant);
  const what = `${model.id} ${quantEntry.quant} (${quantEntry.file})`;
  const verifiedPrimary = await checkAdoptFile({ path, expectedSha: quantEntry.sha256, sizeMb: quantEntry.size_mb - (quantEntry.shards || []).reduce((s, x) => s + x.size_mb, 0),
    allowUnverified, hashFileFn, statFn, what });

  const shardFiles = [];
  for (const shard of Array.isArray(quantEntry.shards) ? quantEntry.shards : []) {
    const shardPath = join(dirname(path), basename(shard.file));
    await checkAdoptFile({ path: shardPath, expectedSha: shard.sha256, sizeMb: shard.size_mb, allowUnverified, hashFileFn, statFn, what: `${what} shard ${basename(shard.file)}` });
    shardFiles.push(basename(shard.file));
  }

  const companions = [];
  for (const c of Array.isArray(model.companions) ? model.companions : []) {
    const cPath = companionPaths[c.kind];
    if (!cPath) throw new AdoptMismatchError(`${what}: catalog companion ${c.kind} (${c.file}) needs a path`, "ADOPT_COMPANION_MISSING", { kind: c.kind, file: c.file });
    await checkAdoptFile({ path: cPath, expectedSha: c.sha256, sizeMb: c.size_mb, allowUnverified, hashFileFn, statFn, what: `${what} companion ${c.kind}` });
    companions.push({ kind: c.kind, file: basename(cPath), path: cPath });
  }

  const verified = verifiedPrimary === true;
  const result = await registerModel({ modelId, quant, catalog, ...registerOpts,
    registryExtra: { ...(registerOpts.registryExtra || {}), path, adopted: true, verified, companions, shardFiles } });
  return { ...result, adopted: true, verified };
}
```
`registerModel` already spreads `registryExtra` last, so `path/adopted/verified/companions/shardFiles` override the planned-file defaults.

- [ ] **Step 4:** PASS.

- [ ] **Step 5: Commit**
```bash
git add tests/models-adopt.test.js
git commit servers/gateway/models/manager.js tests/models-adopt.test.js -m "feat(models): adoptModel — register weights already on disk by sha256 (or size, unverified)"
```

---

### Task 10: orchestrator — registry key, `path`, launch merge, ctx guard, missing-file, override binary, owner gate, argv log

**Files:**
- Modify: `servers/gateway/gpu-orchestrator.js` (imports ~66-88; `mutexGroupOf`/`isNativeRuntime`/`portFromBaseUrl` ~309-335; `alwaysResidentProviders` ~362; `maybeAcquireLocalProvider` ~497; `resolveNativeBinPath` ~603; `persistLivenessMarker` ~671; `startNativeAndAwaitReady` ~714-810; `acquireOrStartNative` sibling loop ~923; `acquireProvider` ~1000-1020 and docker sibling loop ~1070)
- Test: `tests/gpu-orchestrator-native.test.js`

**Interfaces:** Consumes Tasks 1, 5, 6, 7. Produces: unchanged exports plus `_setOwnInstanceIdForTest(id)`; new opts seams on the native path: `getRuntimeOverrideFn`, `existsSyncFn`, `ownInstanceIdFn`.

- [ ] **Step 1: Failing tests** (append; extend `startCapableOpts` to accept and forward `getRuntimeOverrideFn`, `existsSyncFn`, `ownInstanceIdFn`, and to default `loadStateFn` to a registry keyed `"native-target@Q4"` with `catalogId: "native-target", quant: "Q4"`; `nativeProv` gets `gpuPolicy: { catalogId: "native-target", quant: "Q4", port }` by default)

```js
test("native start: launch = catalog defaults merged under the provider override, rendered into startModel's launch", async () => {
  const startCalls = [];
  const cfg = { providers: { "native-target": nativeProv(18100, "native-target", { gpuPolicy: { launch: { ctx: 4096 } } }) } };
  const opts = startCapableOpts({ cfg, identityProbeFn: probeSequence(["down", "resident"]), startCalls });
  opts.loadCatalogFn = () => ({ runtime: { release: "b1", assets: {} }, models: [{ id: "native-target", task: "chat", context_len: 8192, launch: { ctx: 8192, ngl: 999 }, chat_template_kwargs: { enable_thinking: false } }] });
  assert.equal(await acquireProvider("native-target", opts), true);
  assert.deepEqual(startCalls[0].launch, { ctx: 4096, ngl: 999, jinja: true });
  assert.ok(!startCalls[0].extraArgs.includes("--jinja"), "--jinja is rendered via launch.jinja, not extraArgs");
});

test("native start: resolved ctx above context_len is refused with CTX_EXCEEDS_MODEL before any spawn", async () => {
  const startCalls = [];
  const cfg = { providers: { "native-target": nativeProv(18100, "native-target", { gpuPolicy: { launch: { ctx: 16384 } } }) } };
  const opts = startCapableOpts({ cfg, identityProbeFn: probeSequence(["down"]), startCalls });
  opts.loadCatalogFn = () => ({ runtime: { release: "b1", assets: {} }, models: [{ id: "native-target", task: "chat", context_len: 8192 }] });
  await assert.rejects(acquireProvider("native-target", opts), (e) => e.code === "CTX_EXCEEDS_MODEL");
  assert.equal(startCalls.length, 0);
});

test("native start: registry entry resolved by gpuPolicy.catalogId@quant; ggufPath uses entry.path when set", async () => {
  const startCalls = [];
  const cfg = { providers: { "crow-chat": nativeProv(18100, "qwen3.6-35b-a3b", { gpuPolicy: { catalogId: "qwen3.6-35b-a3b", quant: "UD-Q5_K_XL", port: 18100 } }) } };
  const opts = startCapableOpts({ cfg, identityProbeFn: probeSequence(["down", "resident"]), startCalls });
  opts.loadStateFn = () => ({ registry: { "qwen3.6-35b-a3b@UD-Q5_K_XL": { file: "x.gguf", catalogId: "qwen3.6-35b-a3b", quant: "UD-Q5_K_XL", path: "/mnt/w/Qwen3.6-35B-A3B-UD-Q5_K_XL.gguf",
    companions: [{ kind: "mmproj", file: "mmproj-F16.gguf", path: "/mnt/w/mmproj-F16.gguf" }] } } });
  assert.equal(await acquireProvider("crow-chat", opts), true);
  assert.equal(startCalls[0].ggufPath, "/mnt/w/Qwen3.6-35B-A3B-UD-Q5_K_XL.gguf");
  assert.deepEqual(startCalls[0].extraArgs, ["--mmproj", "/mnt/w/mmproj-F16.gguf"]);
  assert.equal(startCalls[0].alias, "qwen3.6-35b-a3b");
});

test("native start: a missing model file fails with MODEL_FILE_MISSING and never spawns", async () => {
  const startCalls = [];
  const cfg = { providers: { "native-target": nativeProv(18100, "native-target") } };
  const opts = startCapableOpts({ cfg, identityProbeFn: probeSequence(["down"]), startCalls });
  opts.existsSyncFn = () => false;
  await assert.rejects(acquireProvider("native-target", opts), (e) => e.code === "MODEL_FILE_MISSING");
  assert.equal(startCalls.length, 0);
});

test("native start: the runtime override binary wins over the catalog release; a vanished override falls back", async () => {
  const startCalls = [];
  const cfg = { providers: { "native-target": nativeProv(18100, "native-target") } };
  const opts = startCapableOpts({ cfg, identityProbeFn: probeSequence(["down", "resident"]), startCalls });
  opts.getRuntimeOverrideFn = () => ({ bin: "/opt/mine/llama-server", version: "b10500" });
  opts.existsSyncFn = (p) => true;
  let ensured = 0; opts.ensureRuntimeFn = async () => { ensured++; return "/fake/release/llama-server"; };
  assert.equal(await acquireProvider("native-target", opts), true);
  assert.equal(startCalls[0].binPath, "/opt/mine/llama-server");
  assert.equal(ensured, 0, "ensureRuntime skipped under an override");
  _setNativeHandleForTest("native-target", null);
  const opts2 = startCapableOpts({ cfg, identityProbeFn: probeSequence(["down", "resident"]), startCalls });
  opts2.getRuntimeOverrideFn = () => ({ bin: "/opt/gone/llama-server" });
  opts2.existsSyncFn = (p) => p !== "/opt/gone/llama-server";
  assert.equal(await acquireProvider("native-target", opts2), true);
  assert.equal(startCalls[1].binPath, "/fake/runtimes/llamacpp/b1/llama-server");
});

test("owner gate: a native row owned by another instance is never orchestrated here even when its host is one of ours", async () => {
  const startCalls = [];
  const p = nativeProv(18100, "native-target", { baseUrl: "http://127.0.0.1:3001/llm/v1", gpuPolicy: { owner: "other-instance", port: 18100 } });
  const cfg = { providers: { "native-target": p } };
  const opts = startCapableOpts({ cfg, identityProbeFn: probeSequence(["down"]), startCalls });
  opts.ownInstanceIdFn = () => "this-instance";
  assert.equal(await maybeAcquireLocalProvider("native-target", opts), null);
  assert.equal(await acquireProvider("native-target", opts), null);
  assert.equal(startCalls.length, 0);
});

test("owner gate: a native row owned by THIS instance orchestrates even though its base_url is the tailnet door", async () => {
  const startCalls = [];
  const p = nativeProv(18100, "native-target", { baseUrl: "http://100.118.41.122:3001/llm/v1", gpuPolicy: { owner: "this-instance", port: 18100 } });
  const cfg = { providers: { "native-target": p } };
  const opts = startCapableOpts({ cfg, identityProbeFn: probeSequence(["down", "resident"]), startCalls });
  opts.ownInstanceIdFn = () => "this-instance";
  assert.equal(await acquireProvider("native-target", opts), true);
  assert.equal(startCalls[0].port, 18100, "port from gpuPolicy.port, not from the door URL");
});

test("liveness marker is written under the registry key, not the provider name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-"));
  try {
    saveState(dir, { reservations: {}, journal: {}, registry: { "native-target@Q4": { file: "m.gguf", catalogId: "native-target", quant: "Q4" } } });
    const cfg = { providers: { "crow-x": nativeProv(18100, "native-target", { gpuPolicy: { catalogId: "native-target", quant: "Q4", port: 18100 } }) } };
    const opts = startCapableOpts({ cfg, identityProbeFn: probeSequence(["down", "resident"]) });
    opts.loadStateFn = () => loadState(dir); opts.resolveDataDirFn = () => dir; opts.existsSyncFn = () => true;
    assert.equal(await acquireProvider("crow-x", opts), true);
    const s = loadState(dir);
    assert.equal(s.registry["native-target@Q4"].wasLive, true);
    assert.equal(s.registry["crow-x"], undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```
(`probeSequence(states)` — if the file lacks such a helper, add: `function probeSequence(states) { let i = 0; return async () => states[Math.min(i++, states.length - 1)]; }`.)

- [ ] **Step 2:** run → FAIL.

- [ ] **Step 3: Implement**

Imports to add:
```js
import { loadState, saveState, reconcileOnBoot, registryKey, findRegistryEntryForProvider } from "./models/state.js";
import { mergeLaunch } from "./models/launch.js";
import { getRuntimeOverride } from "./models/runtime-override.js";
import { isOrchestratableHere } from "../shared/native-locality.js";
import { getOrCreateLocalInstanceId } from "./instance-registry.js";
```
Helpers (beside `mutexGroupOf`):
```js
let _ownInstanceIdForTest = null;
export function _setOwnInstanceIdForTest(id) { _ownInstanceIdForTest = id; }
function ownInstanceId(opts = {}) {
  if (typeof opts.ownInstanceIdFn === "function") return opts.ownInstanceIdFn();
  if (_ownInstanceIdForTest) return _ownInstanceIdForTest;
  try { return getOrCreateLocalInstanceId(); } catch { return null; }
}
/** Owner gate (spec §4): a row that declares gpu_policy.owner is orchestrated ONLY by that instance;
 * an undeclared row keeps the baseUrl-hostname rule. */
function orchestratableHere(p, opts = {}, ownAddrs = getOwnAddresses()) {
  return isOrchestratableHere(p, { ownAddrs, ownInstanceId: ownInstanceId(opts) });
}
function nativePort(p) {
  const gp = Number(p?.gpuPolicy?.port);
  return Number.isInteger(gp) && gp > 0 ? gp : portFromBaseUrl(p?.baseUrl);
}
/** Local URL the orchestrator probes/forwards to for a native row: loopback + native port (never the door). */
function nativeLocalUrl(p) {
  const port = nativePort(p);
  return port ? `http://127.0.0.1:${port}/v1` : p?.baseUrl;
}
function registryKeyOf(p, providerName, state) {
  const found = findRegistryEntryForProvider(state, p);
  if (found) return found.key;
  return providerName; // pre-arc rows: provider id == model id == legacy key (migrated on load if it carried catalogId+quant)
}
```
Call-site changes:
- `alwaysResidentProviders` (~362) and `initOrchestrator`'s `_deferredResidents` filter: replace `isLocallyOrchestratable(v, ownAddrs)` with `orchestratableHere(v, {}, ownAddrs)`.
- `maybeAcquireLocalProvider` (~497): `if (!orchestratableHere(p, opts)) return null;`
- `acquireProvider` native branch (~1000) and docker branch (~1017): `if (!orchestratableHere(p, opts)) { console.warn(...); return null; }`
- `acquireOrStartNative`: identity probe uses `nativeLocalUrl(p)`; sibling loop `if (!sib || !orchestratableHere(sib, opts)) continue;`; docker sibling `probeReadyFn(sib.baseUrl)` → for native siblings use `_nativeHandles` as today (unchanged).
- `acquireProvider` docker branch sibling loop (~1070): `orchestratableHere(sib, opts)`.
- `resolveNativeBinPath`: at the top, after `dir`:
```js
  const { getRuntimeOverrideFn = getRuntimeOverride, existsSyncFn = existsSync } = opts;
  const override = getRuntimeOverrideFn(dir);
  if (override && typeof override.bin === "string") {
    if (existsSyncFn(override.bin)) return override.bin;
    console.warn(`[gpu-orchestrator] runtime override ${override.bin} is missing — falling back to the catalog release`);
  }
```
- `persistLivenessMarker(dir, key, …)`: callers pass the registry key (computed once in `startNativeAndAwaitReady` as `const key = registryKeyOf(p, providerName, state)`).
- `startNativeAndAwaitReady`:
```js
  const port = nativePort(p);
  if (!port) throw new Error(`orchestrator: native provider "${providerName}" has no port (gpu_policy.port or baseUrl)`);
  const dir = resolveDataDirFn();
  const state = loadStateFn(dir);
  const key = registryKeyOf(p, providerName, state);
  const regEntry = state.registry?.[key];
  if (!regEntry?.file) throw new Error(`orchestrator: no model registry entry "${key}" for native provider "${providerName}" — was it registered?`);
  const blobDir = join(dir, "models", "blobs");
  const ggufPath = regEntry.path || join(blobDir, regEntry.file);
  const { existsSyncFn = existsSync } = opts;
  if (!existsSyncFn(ggufPath)) {
    const err = new Error(`orchestrator: model file for "${providerName}" is missing at ${ggufPath}`);
    err.code = "MODEL_FILE_MISSING"; throw err;
  }
  const catalogId = p.gpuPolicy?.catalogId || providerName;
  let catalogEntry = null;
  try { catalogEntry = (loadCatalogFn()?.models || []).find((m) => m.id === catalogId) || null; } catch { /* no catalog-driven args */ }

  const jinja = !!(catalogEntry && catalogEntry.chat_template_kwargs && typeof catalogEntry.chat_template_kwargs === "object");
  const launch = mergeLaunch(mergeLaunch(catalogEntry?.launch, p.gpuPolicy?.launch), jinja ? { jinja: true } : null);
  if (Number.isInteger(launch.ctx) && Number.isFinite(catalogEntry?.context_len) && launch.ctx > catalogEntry.context_len) {
    const err = new Error(`orchestrator: launch ctx ${launch.ctx} exceeds ${catalogId} context_len ${catalogEntry.context_len}`);
    err.code = "CTX_EXCEEDS_MODEL"; throw err;
  }
  const extraArgs = [];
  for (const c of Array.isArray(regEntry.companions) ? regEntry.companions : []) {
    if (c && c.kind === "mmproj" && (c.path || c.file)) extraArgs.push("--mmproj", c.path || join(blobDir, c.file));
  }
  if (catalogEntry?.task === "embedding") extraArgs.push("--embedding");
  else if (catalogEntry?.task === "rerank") extraArgs.push("--reranking");
```
then `startModelFn({ binPath, ggufPath, alias, port, launch, spawn: spawnFn, onTerminal: wrappedOnTerminal, extraArgs })`, log `argv=${JSON.stringify(handle.argv || [])}` after the handle exists, and `waitForNativeReady(nativeLocalUrl(p), alias, …)`. Remove the old `--jinja` push (it is now `launch.jinja`). `wrappedOnTerminal` and the success path call `persistLivenessMarker(dir, key, …)`.

- [ ] **Step 4:** `node scripts/run-suite.mjs tests/gpu-orchestrator-native.test.js tests/gpu-orchestrator-reservation.test.js tests/gpu-orchestrator-residency-poll.test.js tests/gpu-orchestrator-host-gate.test.js tests/gpu-warm-resolve.test.js` → PASS. Existing tests that asserted `extraArgs` deep-equals `["--jinja"]` change to assert `launch.jinja === true`.

- [ ] **Step 5: Commit**
```bash
git commit servers/gateway/gpu-orchestrator.js tests/gpu-orchestrator-native.test.js -m "feat(gpu-orchestrator): launch profiles, registry-key lookup, adopted paths, ctx guard, runtime override, owner gate"
```

---

### Task 11: localize owned native rows in the provider cache; keep routes and panel working on the new key

**Files:**
- Modify: `servers/shared/providers-db.js` (`loadProvidersFromDb` ~115-140)
- Modify: `servers/gateway/routes/models.js` (registry reads at ~228, ~532, ~574, ~620, ~643)
- Modify: `servers/gateway/dashboard/panels/model-catalog.js` (registry reads ~151, ~181-215)
- Test: `tests/providers-localize.test.js` (new), existing `tests/models-panel.test.js`, `tests/models-panel-ui.test.js`, `tests/model-catalog-client-contract.test.js`

**Interfaces:** Consumes `localizeNativeRow` (Task 7), `findRegistryEntries`/`findRegistryEntryForProvider` (Task 5). Produces: `loadProvidersFromDb(db, { ownInstanceId })` — every owned native row has `baseUrl` = loopback and `doorUrl` = the door; route/panel payloads unchanged in shape, with `registryKey` added to runtime-strip rows.

- [ ] **Step 1: Failing test**

```js
// tests/providers-localize.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadProvidersFromDb } from "../servers/shared/providers-db.js";

function fakeDb(rows) { return { execute: async () => ({ rows }) }; }
const row = (id, base_url, gpu_policy) => ({ id, base_url, api_key: null, host: "local", bundle_id: null, description: null, models: "[]", disabled: 0, gpu_policy: JSON.stringify(gpu_policy) });

test("loadProvidersFromDb localizes rows this instance owns and leaves foreign-owned rows on their door", async () => {
  const db = fakeDb([
    row("crow-chat", "http://100.118.41.122:3001/llm/v1", { runtime: "native", owner: "me", port: 18100 }),
    row("grackle-x", "http://100.121.254.89:3002/llm/v1", { runtime: "native", owner: "grackle", port: 18100 }),
  ]);
  const cfg = await loadProvidersFromDb(db, { ownInstanceId: "me" });
  assert.equal(cfg.providers["crow-chat"].baseUrl, "http://127.0.0.1:18100/v1");
  assert.equal(cfg.providers["crow-chat"].doorUrl, "http://100.118.41.122:3001/llm/v1");
  assert.equal(cfg.providers["grackle-x"].baseUrl, "http://100.121.254.89:3002/llm/v1");
  assert.equal(cfg.providers["grackle-x"].doorUrl, undefined);
});
```

- [ ] **Step 2:** FAIL.

- [ ] **Step 3: Implement**

`providers-db.js`:
```js
import { localizeNativeRow } from "./native-locality.js";
export async function loadProvidersFromDb(db, { ownInstanceId = getOrCreateLocalInstanceId() } = {}) {
  ...
    providers[r.id] = localizeNativeRow({ baseUrl: r.base_url, apiKey: r.api_key, host: r.host, bundleId: r.bundle_id, description: r.description, models, gpuPolicy }, ownInstanceId);
```
`routes/models.js`: import `findRegistryEntries`, `parseRegistryKey`; replace each `state.registry[model.id]`/`state.registry[modelId]` read with a local helper defined once at the top of `createModelsRouter`:
```js
  const regEntryFor = (state, id) => state.registry[id] || (findRegistryEntries(state, id)[0]?.entry ?? null);
```
In the `/api/models/runtime` strip: iterate `Object.entries(state.registry)` and emit `{ modelId: entry.catalogId || key, registryKey: key, quant: entry.quant, ...status-or-marker }`, looking the status up by alias `entry.catalogId || key`. `DELETE`/`start`/`stop` routes: existence via `regEntryFor`; start/stop keep passing `modelId` (= provider id, identical to the catalog id for every row registered from the panel today) to `maybeAcquireLocalProvider`/`getNativeHandle`; DELETE passes `modelId` to `unregisterModel` (Task 8 resolves the key from the row).
`panels/model-catalog.js`: same `regEntryFor` helper for the card (`registered`/`registeredQuant`/`running`), and the runtime-strip loop mirrors the route (`modelId: entry.catalogId || key`, `registryKey: key`); `quantLookup.get(rm.modelId)?.get(regEntry.quant)` keeps working because `rm.modelId` is the catalog id.

- [ ] **Step 4:** `node scripts/run-suite.mjs tests/providers-localize.test.js tests/models-panel.test.js tests/models-panel-ui.test.js tests/model-catalog-client-contract.test.js tests/providers-upsert-noop.test.js tests/providers-reconcile-gate.test.js tests/chat-conversations-providers-fallback.test.js` → PASS.

- [ ] **Step 5: Commit**
```bash
git add tests/providers-localize.test.js
git commit servers/shared/providers-db.js servers/gateway/routes/models.js servers/gateway/dashboard/panels/model-catalog.js tests/providers-localize.test.js -m "feat(providers): localize owned native rows to loopback in the provider cache; routes/panel read the keyed registry"
```

---

### Task 12: architecture doc, full suite, PR

**Files:**
- Create: `docs/architecture/models.md`
- Modify: `docs/architecture/index.md` (add the link), `docs/.vitepress/config.ts` (sidebar entry beside `box-reservation`)

- [ ] **Step 1: Write `docs/architecture/models.md`** with these sections, each 3-8 sentences drawn from the spec and this plan: *Two paths today (bundles vs native) and where this arc is heading* (link the spec); *Catalog schema v3* (`launch` block table with knob → flag, `size_mb` is decimal MB, `linux-x64-cuda` slot); *Registry (`state.json`)*: keys `<catalogId>@<quant>`, `path`/`adopted`/`verified`, `conversions`, `runtimeOverride`; *Provider row shape for a native model*: `base_url` = door, `gpu_policy` fields (`catalogId`, `quant`, `port`, `owner`, `launch`, `mutexGroup`, `alwaysResident`, `defaultMember`, `local_only`), why the door and the owner gate exist (co-hosted r4, replication); *Start sequence* (identity probe on loopback → reservation gate → sibling swap → host lock → argv render → readiness), the error codes `CTX_EXCEEDS_MODEL`, `MODEL_FILE_MISSING`, `INVALID_LAUNCH`, `ADOPT_*`, `NOT_ABSOLUTE`/`NOT_EXECUTABLE`/`VERSION_FAILED`; *Runtime override* (`CROW_LLAMA_SERVER_BIN`, panel in plan 3); *What later plans add* (doors + lifecycle API, panel UX, migration + retirement).
- [ ] **Step 2:** `cd docs && npm run build` succeeds.
- [ ] **Step 3: Full suite + static checks** (node 22 on PATH): `npm test`; `npm run validate-model-catalog`; `node scripts/check-port-allocation.js`; `node scripts/build-registry.mjs --check`. All green.
- [ ] **Step 4: Commit + push + PR**
```bash
git add docs/architecture/models.md
git commit docs/architecture/models.md docs/architecture/index.md docs/.vitepress/config.ts -m "docs(architecture): models — catalog v3 launch profiles, keyed registry, native row shape, owner gate"
git pull --rebase origin main && git push -u origin feat/models-core-launch-roles
gh pr create --title "feat: models core — launch profiles, provider roles, adopt-in-place, runtime override (arc plan 1/4)" --body "<summary of tasks 1-12; link the spec; state explicitly: no bundle deleted, no docker-branch change, no migration, no deploy>"
```
- [ ] **Step 5: Gate.** Query `https://api.github.com/repos/kh0pper/crow/commits/<head sha>/check-runs` until `suite`, `static-checks`, `audit` are all `completed`/`success`. Merge only then. Do NOT deploy: the primary auto-restarts on the next auto-update tick only when no reservation is active (the orchestrator refuses otherwise); r4 is restarted manually later, in plan 4's first window.

---

## Self-review (plan 1 against spec §3, §4, §8, §9)

- §3.1 launch block + validator rules → Tasks 1, 2; curated values → Task 3. `jinja` was added as a knob because the 35B compose passes `--jinja` while the catalog entry has no `chat_template_kwargs`; the spec's owned-flags list gains `--jinja` accordingly (renderer-owned).
- §3.2 provider row (`catalogId`, `quant`, `launch`, `port`, `owner`, door `base_url`, `local_only`, conversion snapshot, task-based mutex incl. vision) → Task 8. Registering onto a bundle row converts it → Task 8.
- §3.3 registry key, `path`, `adopted`, `verified`, no-unlink on adopted → Tasks 5, 8, 9. Shared weights between variants → Task 8 (last-reference delete).
- §3.4 runtime override, env bootstrap, never replicates (state file) → Task 6; consumed → Task 10. The "min_runtime_version gate skipped with warning" is a panel concern (no runtime gate exists today) → plan 3.
- §4 orchestrator: render precedence, registry lookup, `path`, port from `gpu_policy`, loopback probing/forwarding, owner gate, override-first, ctx guard, docker branch untouched → Task 10; cache localization → Task 11.
- §8: `INVALID_LAUNCH` at save (Task 8), `MODEL_FILE_MISSING` (Task 10), adopt codes (Task 9), override codes + fallback (Tasks 6, 10). Stderr-tail `cause` and `NOT_OWNER` belong to the door/lifecycle API → plan 2.
- §9: parity fixtures (Task 3), key migration (Task 5), adopt (Task 9), owner/loop/override/ctx (Task 10). Door tests, lifecycle API, two-instance sync, Extensions render, client contract for new dialogs → plans 2 and 3.
- Names consistent: `registryKey`, `findRegistryEntries`, `findRegistryEntryForProvider`, `mergeLaunch`, `renderLaunchArgs`, `validateLaunch`, `LAUNCH_OWNED_FLAGS`, `getRuntimeOverride`, `setRuntimeOverride`, `clearRuntimeOverride`, `doorBaseUrl`, `nativeLoopbackUrl`, `gatewayPort`, `getOwnTailnetIp`, `isOwnedHere`, `isOrchestratableHere`, `localizeNativeRow`, `adoptModel`, `hashFileSha256`, `AdoptMismatchError`, `InvalidLaunchError`, `_setOwnInstanceIdForTest`.
- Placeholder scan: none. Every step has code or an exact command.

---

## The rest of the arc (plans 2-4 — each gets its own writing-plans pass when its turn comes; this section fixes their scope, not their steps)

**Plan 2 — gateway doors + replication + pi-lab** (`feat/models-doors`): (a) find and fix why a provider disable/conversion on the primary did not replicate to r4/black-swan/grackle (spec §7 step 0; start from `servers/shared/sync-emit.js` `emitOrQueue` and the instance-sync pull loop; two-instance test); (b) `/llm/v1` model addressing (`<provider>/<model>` and unique bare id; ambiguity 400; forward to `nativeLocalUrl` for owned rows, to the owner's door otherwise; `GET /llm/v1/models` lists native rows + the two companion aliases; companion heuristics untouched); (c) lifecycle API under `/llm/models` with local-MCP-token auth, async start jobs, `blocked_by_reservation`, `NOT_OWNER`, stderr-tail `cause`; (d) pi-lab `lib/local-models.mjs` → gateway contract, `settings.json` `localModels` shape (`gateway`, `provider`), `models.json` rows on the door; pi-lab PR on `crow-mode` → main.

**Plan 3 — panels** (`feat/models-panel-roles`): Extensions AI group drops `inference` cards, adds the "Local models" card and the retired-installed chip; Model Catalog page gains the registration dialog (provider id, mutex group, always-resident, launch knobs), adopt-from-disk (curated + HF tab), registered-models list with argv/status/edit/unregister, runtime override card (`--version`, min_runtime_version warning, reset); `en`+`es` for every string; client-contract tests.

**Plan 4 — migration + retirement** (`feat/models-retire-crow-bundles` + `scripts/ops/models-migrate.mjs`): the ops script (`adopt`, `convert`, `revert <provider>`, `status`), then the six windows of spec §7 (embed → voice Q8_0 → chat 35B from the MTP repo → 27B variants incl. the MTP decision → gemma for r4 → retire crow's four bundles, installed.json/`~/.crow/bundles` cleanup, `~/crow-addons` composes, compose `localModels`), each registered in CROW-SCHEDULE with the reservation held and acceptance recorded on the PR.
