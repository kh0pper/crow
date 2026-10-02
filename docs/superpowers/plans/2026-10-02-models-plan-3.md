# Models arc plan 3 of 4: runtimes (llama-server + gufo) and the models panels — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the native model path runtime-pluggable (llama-server everywhere, gufo on gfx1151 for the models gufo supports), and give the operator the dashboard to register, adopt, edit, start, stop and inspect models and runtimes, so the Extensions page no longer installs models.

**Architecture:** One PR (`feat/models-runtimes-panels`), two halves. **Runtimes (Tasks 1–7):** a runtime module interface (`servers/gateway/models/runtimes/`), the llama-server module extracted from today's code with a parity test, the gufo module (pure argv + container command + version probe), the catalog `runtimes.gufo` block, host install records, runtime-asset adoption, then `selectRuntime` wired into the orchestrator's single start funnel. **Panels (Tasks 8–13):** JSON routes, the Extensions changes, then the Model Catalog page sections (registered models, registration dialog, adopt, runtime card), each client script in its own module.

**Tech Stack:** Node 24 (`export PATH=/home/kh0pp/.nvm/versions/node/v24.21.0/bin:$PATH`), `node:test` through the scratch harness, express, server-rendered panels with an inline client script (template literal; createElement/textContent only), `servers/gateway/dashboard/shared/i18n.js`.

**Spec:** `docs/superpowers/specs/2026-09-04-models-bundles-to-catalog-design.md` §3.4, §4, §6, §8, §9, and **§11 Amendment A** (§11.1 D1′/D2′, §11.2 the runtime abstraction, §11.11 open questions). Depends on plan 2 being merged (the lifecycle listing and `nativeSnapshot` are reused for status; the door is unaffected).

## Global Constraints

- Worktree: `git worktree add ~/crow-wt-models-panels -b feat/models-runtimes-panels origin/main` (after plan 2 merged). Never `git checkout` in `~/crow`.
- Commit with positional paths; `git show --stat HEAD` after each; never `git add -A`; no AI attribution.
- Tests only through `npm test -- tests/<file>.test.js`; full `npm test` once before pushing.
- No `SCHEMA_GENERATION` bump, no DDL; new state lives in `state.json` (`runtimeInstalls`, `runtimeOverrides`, registry `runtimeAssets`) and `gpu_policy` JSON (`runtimeId`, `runtimeLaunch`).
- Every new dashboard string ships `en` + `es`. Panel client JS is inside a template literal: no backticks, no unintended `${`, createElement/textContent only, never innerHTML with data.
- The container launch shape is allowed for the gufo runtime only (spec D2′). It always binds `127.0.0.1:<port>`; never a tailnet or `0.0.0.0` host port.
- gufo never starts on a host whose probe is not `gfx1151`, and never for a model without a catalog `runtimes.gufo` block (spec §11.2).
- No live deploy, model start or DB write on crow from this plan; plan 4 window 4b is where gufo first launches under Crow.

## Review Focus

1. **A gufo pin on a launch gufo cannot serve** (512k YaRN variant pinned to gufo) must refuse with `RUNTIME_UNSUPPORTED`, never fall back silently to llama-server. Test: Task 6 "a pinned gufo that cannot serve refuses".
2. **A stale `crow-rt-<provider>` container left by a crashed gateway** must be removed before a new start binds the port. Test: Task 6 "a gufo start removes a leftover container first".
3. **A gufo install record whose root moved or was pruned** must surface at start as a typed error with the path, not a docker exit code. Test: Task 4 "a missing root is NOT_EXECUTABLE".
4. **The panel on a host with `CROW_DISABLE_MODEL_ORCHESTRATION=1`** must not offer Start/Stop anywhere (the 2026-09-24 minor). Test: Task 10 "no start/stop when orchestration is disabled".
5. **Adopting a file whose size differs from the catalog by more than 0.5 %** (the 27B on-disk Q6) must refuse with a message naming both sizes, so the operator knows to add a quant entry or re-download. Test: Task 5 "an out-of-tolerance size names both sizes".

---

## File structure

| File | Responsibility |
|---|---|
| `servers/gateway/models/runtimes/index.js` (new) | `RUNTIME_IDS`, `getRuntime`, `selectRuntime`, `RuntimeSelectError`. |
| `servers/gateway/models/runtimes/llama-server.js` (new) | llama-server: `buildCommand`, `probeVersion`, `supports`. Extracted, behavior-identical. |
| `servers/gateway/models/runtimes/gufo.js` (new) | gufo: `GUFO_LAUNCH_KEYS`, `validateGufoLaunch`, `renderGufoArgs`, `buildCommand` (container), `probeVersion`, `parseGufoBuildInfo`, `supports`, `containerNameFor`. |
| `servers/gateway/models/runtime-installs.js` (new) | Host install records in `state.json.runtimeInstalls`. |
| `scripts/models-runtime-install.mjs` (new) | Operator CLI: `list`, `set-gufo`, `clear`. |
| `servers/gateway/models/runtime-override.js` | Export `validateLlamaServerBinary`; per-model override records gain `runtimeId`. |
| `servers/gateway/models/runtime.js` | `startModel` accepts a prebuilt `{ command, args }`. |
| `servers/gateway/models/manager.js` | `adoptModel` adopts `runtimeAssets`; `AdoptMismatchError` size message. |
| `servers/gateway/gpu-orchestrator.js` | `startNativeAndAwaitReady` selects a runtime and builds its command; leftover-container cleanup. |
| `scripts/validate-model-catalog.js`, `registry/model-catalog.json` | `runtimes.gufo` rules; the 27B gufo block. |
| `servers/gateway/routes/models.js` | Registered list, register/edit, adopt, provider start/stop, runtime override + install routes. |
| `servers/gateway/dashboard/panels/extensions/html.js`, `…/extensions.js`, `…/extensions/local-models-card.js` (new) | No inference cards in Browse; Local models card; retired chip. |
| `servers/gateway/dashboard/panels/model-catalog.js`, `…/model-catalog-registered.js` (new), `…/model-catalog-dialog.js` (new), `…/model-catalog-runtime-card.js` (new) | Registered list, registration/adopt dialog, runtime card. |
| `servers/gateway/dashboard/shared/i18n.js` | New `models.*` and `extensions.*` keys. |
| Tests | `tests/runtimes-llama-server.test.js`, `tests/runtimes-gufo.test.js`, `tests/fixtures/gufo-parity/qwen38-27b-solo.json`, `tests/model-catalog-runtimes.test.js`, `tests/runtime-installs.test.js`, `tests/models-adopt-runtime-assets.test.js`, `tests/runtimes-select.test.js`, `tests/gpu-orchestrator-runtime.test.js`, `tests/models-routes-registered.test.js`, `tests/extensions-local-models.test.js`, `tests/models-panel-registered.test.js`, `tests/models-panel-dialog-client.test.js`, `tests/models-panel-runtime-card.test.js`. |

---

### Task 1: Runtime interface and the llama-server module (extraction, no behavior change)

**Files:**
- Create: `servers/gateway/models/runtimes/llama-server.js`, `servers/gateway/models/runtimes/index.js` (only `RUNTIME_IDS` and `getRuntime` in this task)
- Modify: `servers/gateway/models/runtime-override.js` (export the existing `validateBinary` as `validateLlamaServerBinary`)
- Test: `tests/runtimes-llama-server.test.js`

**Interfaces:**
- Consumes: `buildLlamaServerArgs` (`runtime.js`), `validateBinary` (renamed export) from `runtime-override.js`.
- Produces:
  - `RUNTIME_IDS = ["llama-server", "gufo"]`, `getRuntime(id) -> module` (throws `Error("unknown runtime …")`)
  - llama-server module: `id = "llama-server"`, `launchShape = "exec"`, `healthPath = "/health"`,
    `buildCommand({ install: { bin }, ggufPath, alias, port, launch, companions = [], task = "chat" }) -> { command, args }`,
    `probeVersion({ bin }, deps) -> string` (throws `RuntimeOverrideError`),
    `supports() -> { ok: true }`.
  - `companions` is `Array<{ kind: "mmproj"|"mtp"|"dflash", path }>`; llama-server renders only `mmproj` (`--mmproj <path>`); task `embedding` → `--embedding`, `rerank` → `--reranking`.

- [ ] **Step 1: Write the failing test.**

```js
// tests/runtimes-llama-server.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { getRuntime, RUNTIME_IDS } from "../servers/gateway/models/runtimes/index.js";
import { buildLlamaServerArgs } from "../servers/gateway/models/runtime.js";

const ls = getRuntime("llama-server");

test("registry exposes both runtime ids and rejects unknown ones", () => {
  assert.deepEqual(RUNTIME_IDS, ["llama-server", "gufo"]);
  assert.throws(() => getRuntime("vllm"), /unknown runtime "vllm"/);
  assert.equal(ls.launchShape, "exec");
  assert.equal(ls.healthPath, "/health");
});

test("buildCommand is byte-identical to today's argv for a chat model with an mmproj", () => {
  const launch = { ctx: 262144, ngl: 999, flash_attn: "on", jinja: true };
  const { command, args } = ls.buildCommand({
    install: { bin: "/opt/llama/llama-server" }, ggufPath: "/w/m.gguf", alias: "qwen3.6-35b-a3b", port: 18102,
    launch, companions: [{ kind: "mmproj", path: "/w/mmproj-F16.gguf" }, { kind: "mtp", path: "/w/mtp.gguf" }], task: "chat",
  });
  assert.equal(command, "/opt/llama/llama-server");
  assert.deepEqual(args, buildLlamaServerArgs({ ggufPath: "/w/m.gguf", alias: "qwen3.6-35b-a3b", port: 18102, launch, extraArgs: ["--mmproj", "/w/mmproj-F16.gguf"] }));
});

test("embedding and rerank tasks add their flag; dflash companions are ignored by llama-server", () => {
  const e = ls.buildCommand({ install: { bin: "/b" }, ggufPath: "/e.gguf", alias: "e", port: 1, launch: null, companions: [{ kind: "dflash", path: "/d.gguf" }], task: "embedding" });
  assert.equal(e.args.at(-1), "--embedding");
  assert.equal(e.args.includes("/d.gguf"), false);
  const r = ls.buildCommand({ install: { bin: "/b" }, ggufPath: "/r.gguf", alias: "r", port: 1, launch: null, task: "rerank" });
  assert.equal(r.args.at(-1), "--reranking");
});

test("probeVersion parses a stock release version line from stderr", () => {
  const v = ls.probeVersion({ bin: "/abs/llama-server" }, {
    accessSyncImpl: () => {}, spawnSyncImpl: () => ({ status: 0, stdout: "", stderr: "version: 10068 (abc1234)\n" }),
  });
  assert.equal(v, "b10068");
});

test("probeVersion refuses a relative path", () => {
  assert.throws(() => ls.probeVersion({ bin: "llama-server" }, {}), (e) => e.code === "NOT_ABSOLUTE");
});
```

- [ ] **Step 2: Run, expect FAIL** (module not found). `npm test -- tests/runtimes-llama-server.test.js`

- [ ] **Step 3: Implement.** In `runtime-override.js` change `function validateBinary(` to `export function validateLlamaServerBinary(` and update its two call sites (`setRuntimeOverride`, `setModelRuntimeOverride`) to the new name.

```js
// servers/gateway/models/runtimes/llama-server.js
/**
 * The llama-server runtime (spec §11.2). Extracted from the orchestrator's
 * inline flag building with no behavior change: tests/runtimes-llama-server
 * pins buildCommand to buildLlamaServerArgs + the old companion/task flags.
 */
import { buildLlamaServerArgs } from "../runtime.js";
import { validateLlamaServerBinary } from "../runtime-override.js";

export const id = "llama-server";
export const launchShape = "exec";
export const healthPath = "/health";

/** The companion + task flags llama-server gets after the launch knobs. */
export function extraArgsFor({ companions = [], task = "chat" } = {}) {
  const extraArgs = [];
  for (const c of companions) if (c && c.kind === "mmproj" && c.path) extraArgs.push("--mmproj", c.path);
  if (task === "embedding") extraArgs.push("--embedding");
  else if (task === "rerank") extraArgs.push("--reranking");
  return extraArgs;
}

export function buildCommand({ install, ggufPath, alias, port, launch = null, companions = [], task = "chat" }) {
  const extraArgs = extraArgsFor({ companions, task });
  return { command: install.bin, args: buildLlamaServerArgs({ ggufPath, alias, port, launch, extraArgs }) };
}

export function probeVersion(install, deps = {}) {
  return validateLlamaServerBinary(install && install.bin, deps);
}

export function supports() {
  return { ok: true };
}
```

```js
// servers/gateway/models/runtimes/index.js
/**
 * Runtime registry (spec §11.2, D1′/D2′). A runtime is a module exporting
 * { id, launchShape, healthPath, buildCommand, probeVersion, supports }.
 */
import * as llamaServer from "./llama-server.js";

export const RUNTIME_IDS = ["llama-server", "gufo"];
const RUNTIMES = new Map([["llama-server", llamaServer]]);

export function registerRuntime(mod) { RUNTIMES.set(mod.id, mod); }

export function getRuntime(id) {
  const r = RUNTIMES.get(id);
  if (!r) throw new Error(`unknown runtime "${id}"`);
  return r;
}
```

(Task 2 imports `gufo.js` into this file; `registerRuntime` exists so the gufo module is added in one line there.)

- [ ] **Step 4: Run, expect PASS**, plus `npm test -- tests/models-runtime-override.test.js tests/models-runtime-override-cli.test.js tests/models-runtime.test.js`.

- [ ] **Step 5: Commit.**

```bash
git add servers/gateway/models/runtimes/index.js servers/gateway/models/runtimes/llama-server.js tests/runtimes-llama-server.test.js
git commit servers/gateway/models/runtimes/index.js servers/gateway/models/runtimes/llama-server.js servers/gateway/models/runtime-override.js tests/runtimes-llama-server.test.js -m "refactor(models): runtime module interface; llama-server extracted with an argv parity test"
```

---

### Task 2: The gufo runtime module (pure)

Spec §11.2, D2′. The production command (crow-addons `llamacpp-vulkan-qwen38-27b/docker-compose.yml`, 2026-10-02) is the parity source.

**Files:**
- Create: `servers/gateway/models/runtimes/gufo.js`, `tests/fixtures/gufo-parity/qwen38-27b-solo.json`
- Modify: `servers/gateway/models/runtimes/index.js` (register gufo)
- Test: `tests/runtimes-gufo.test.js`

**Interfaces:**
- Produces:
  - `id = "gufo"`, `launchShape = "container"`, `healthPath = "/health"`
  - `GUFO_LAUNCH_KEYS = ["ctx", "sessions", "max_pending_per_client", "speculative", "think", "extra_args"]`
  - `GUFO_OWNED_FLAGS` (Set): `--model`, `--mmproj`, `--speculative`, `--dflash-model`, `--context`, `--sessions`, `--served-model-name`, `--max-pending-per-client`, `--host`, `--port`, `--think`
  - `validateGufoLaunch(launch, { contextLen, label }) -> string[]`
  - `renderGufoArgs({ ggufPath, alias, port, launch, companions }) -> string[]` (the argv after the binary)
  - `containerNameFor(providerName) -> "crow-rt-<sanitized>"`
  - `buildCommand({ install, ggufPath, alias, port, launch, companions, providerName }) -> { command: "docker", args, containerName }`
  - `parseGufoBuildInfo(text) -> string|null` (`base=<sha>` → `"<sha>"`, plus `+pr324=<sha>`-style extras appended)
  - `probeVersion(install, { readFileImpl, accessSyncImpl }) -> string` (throws `RuntimeOverrideError` `NOT_EXECUTABLE` | `VERSION_FAILED`)
  - `supports({ catalogEntry, launch, probe }) -> { ok: true } | { ok: false, reason }`
  - install record shape (Task 4 persists it): `{ root, bin = "current/gufo", image = "docker.io/nixos/nix:latest", nixVolume = "gufo-nix", videoGid, renderGid }`

- [ ] **Step 1: Write the parity fixture** (copied from the production compose `command:` list; paths as in the container):

```json
{ "source": "crow-addons/llamacpp-vulkan-qwen38-27b/docker-compose.yml (gufo, 2026-10-02, bd8baeb)",
  "command": ["/opt/gufo/current/gufo", "serve", "llm",
    "--model", "/models/qwen38-27b/Qwen3.8-27B-UD-Q6_K_XL.gguf",
    "--mmproj", "/models/qwen38-27b/mmproj-bf16/mmproj-BF16.gguf",
    "--speculative", "dflash2",
    "--dflash-model", "/models/qwen38-27b/Qwen3.8-27B-DFlash2-Q4_K_M.gguf",
    "--context", "262144", "--sessions", "1", "--served-model-name", "qwen3.8-27b",
    "--max-pending-per-client", "16", "--host", "0.0.0.0", "--port", "8000"] }
```

- [ ] **Step 2: Write the failing test.**

```js
// tests/runtimes-gufo.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getRuntime } from "../servers/gateway/models/runtimes/index.js";
import { validateGufoLaunch, renderGufoArgs, containerNameFor, parseGufoBuildInfo, GUFO_OWNED_FLAGS } from "../servers/gateway/models/runtimes/gufo.js";

const gufo = getRuntime("gufo");
const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "gufo-parity", "qwen38-27b-solo.json"), "utf8"));
const INSTALL = { root: "/home/u/gufo-prod", bin: "current/gufo", image: "docker.io/nixos/nix:latest", nixVolume: "gufo-nix", videoGid: 44, renderGid: 992 };
const SOLO = { ctx: 262144, sessions: 1, max_pending_per_client: 16, speculative: "dflash2" };
const COMP = [
  { kind: "mmproj", path: "/w/qwen38-27b/mmproj-bf16/mmproj-BF16.gguf" },
  { kind: "dflash", path: "/w/qwen38-27b/Qwen3.8-27B-DFlash2-Q4_K_M.gguf" },
];

test("module shape", () => {
  assert.equal(gufo.id, "gufo");
  assert.equal(gufo.launchShape, "container");
});

test("renderGufoArgs carries every flag of the production compose (parity)", () => {
  const args = renderGufoArgs({ ggufPath: "/w/qwen38-27b/Qwen3.8-27B-UD-Q6_K_XL.gguf", alias: "qwen3.8-27b", port: 18110, launch: SOLO, companions: COMP });
  const flags = (argv) => argv.filter((a) => a.startsWith("--"));
  assert.deepEqual(new Set(flags(args)), new Set(flags(fixture.command)));
  const val = (argv, f) => argv[argv.indexOf(f) + 1];
  for (const f of ["--speculative", "--context", "--sessions", "--served-model-name", "--max-pending-per-client"]) {
    assert.equal(val(args, f), val(fixture.command, f), f);
  }
  assert.deepEqual(args.slice(0, 2), ["serve", "llm"]);
  assert.equal(val(args, "--port"), "18110");
  assert.equal(val(args, "--host"), "0.0.0.0", "inside the container; the host side is bound to loopback by -p");
});

test("buildCommand: docker run, loopback-only port, model dirs mounted read-only at the same path", () => {
  const { command, args, containerName } = gufo.buildCommand({
    install: INSTALL, ggufPath: "/w/qwen38-27b/Qwen3.8-27B-UD-Q6_K_XL.gguf", alias: "qwen3.8-27b", port: 18110,
    launch: SOLO, companions: COMP, providerName: "crow-local-27b",
  });
  assert.equal(command, "docker");
  assert.equal(containerName, "crow-rt-crow-local-27b");
  const s = args.join(" ");
  assert.match(s, /^run --rm --name crow-rt-crow-local-27b /);
  assert.ok(s.includes("-p 127.0.0.1:18110:18110"));
  assert.ok(!/-p (0\.0\.0\.0|100\.)/.test(s), "never a public or tailnet host port");
  assert.ok(s.includes("-v gufo-nix:/nix"));
  assert.ok(s.includes("-v /home/u/gufo-prod:/opt/gufo:ro"));
  assert.ok(s.includes("-v /w/qwen38-27b:/w/qwen38-27b:ro"));
  assert.ok(s.includes("-v /w/qwen38-27b/mmproj-bf16:/w/qwen38-27b/mmproj-bf16:ro"));
  assert.ok(s.includes("--device /dev/kfd") && s.includes("--device /dev/dri"));
  assert.ok(s.includes("--group-add 44") && s.includes("--group-add 992"));
  assert.ok(s.includes("docker.io/nixos/nix:latest /opt/gufo/current/gufo serve llm"));
});

test("containerNameFor sanitizes provider ids", () => {
  assert.equal(containerNameFor("Qwen Cloud/x"), "crow-rt-qwen-cloud-x");
});

test("validateGufoLaunch: known keys only, ctx bounded by context_len, owned flags refused in extra_args", () => {
  assert.deepEqual(validateGufoLaunch(SOLO, { contextLen: 262144 }), []);
  assert.match(validateGufoLaunch({ ctx: 524288 }, { contextLen: 262144 })[0], /ctx 524288 exceeds context_len 262144/);
  assert.match(validateGufoLaunch({ bogus: 1 })[0], /unknown key "bogus"/);
  assert.match(validateGufoLaunch({ speculative: "eagle" })[0], /speculative/);
  assert.match(validateGufoLaunch({ think: "maybe" })[0], /think/);
  assert.match(validateGufoLaunch({ extra_args: ["--context", "1"] })[0], /may not contain "--context"/);
  assert.ok(GUFO_OWNED_FLAGS.has("--dflash-model"));
});

test("speculative dflash2 without a dflash companion is refused at render", () => {
  assert.throws(() => renderGufoArgs({ ggufPath: "/m.gguf", alias: "a", port: 1, launch: { speculative: "dflash2" }, companions: [] }), /dflash companion/);
});

test("supports: refuses YaRN extra_args and ctx above context_len; needs gfx1151", () => {
  const entry = { context_len: 262144, runtimes: { gufo: { launch: SOLO } } };
  const probe = { gpuArch: "gfx1151" };
  assert.deepEqual(gufo.supports({ catalogEntry: entry, launch: SOLO, probe }), { ok: true });
  assert.equal(gufo.supports({ catalogEntry: entry, launch: { ...SOLO, ctx: 524288 }, probe }).ok, false);
  assert.match(gufo.supports({ catalogEntry: entry, launch: { extra_args: ["--rope-scaling", "yarn"] }, probe }).reason, /YaRN/);
  assert.match(gufo.supports({ catalogEntry: entry, launch: SOLO, probe: { gpuArch: "gfx1100" } }).reason, /gfx1151/);
  assert.match(gufo.supports({ catalogEntry: { context_len: 1 }, launch: {}, probe }).reason, /no runtimes\.gufo block/);
});

test("parseGufoBuildInfo reads base= and pr extras", () => {
  assert.equal(parseGufoBuildInfo("base=9abedf6 (gufo-org/gufo#350 head)\npr350=9abedf6\npr324=cea8ea8\nbuilt=2026-09-30"), "9abedf6+pr324=cea8ea8");
  assert.equal(parseGufoBuildInfo("nothing here"), null);
});

test("probeVersion: BUILD-INFO beside the binary; a missing root is NOT_EXECUTABLE", () => {
  const v = gufo.probeVersion(INSTALL, {
    accessSyncImpl: () => {},
    readFileImpl: (p) => { assert.equal(p, "/home/u/gufo-prod/current/BUILD-INFO"); return "base=9abedf6\n"; },
  });
  assert.equal(v, "9abedf6");
  assert.throws(() => gufo.probeVersion(INSTALL, { accessSyncImpl: () => { throw new Error("ENOENT"); } }), (e) => e.code === "NOT_EXECUTABLE" && /gufo-prod/.test(e.message));
  assert.throws(() => gufo.probeVersion(INSTALL, { accessSyncImpl: () => {}, readFileImpl: () => "junk" }), (e) => e.code === "VERSION_FAILED");
});
```

- [ ] **Step 3: Run, expect FAIL.** `npm test -- tests/runtimes-gufo.test.js`

- [ ] **Step 4: Implement.**

```js
// servers/gateway/models/runtimes/gufo.js
/**
 * The gufo runtime (spec §11.1 D1′/D2′, §11.2). gufo (gufo-org/gufo, MIT) is a
 * gfx1151-only C++/HIP engine with an OpenAI-compatible server. Its host build
 * links against a /nix closure the host does not carry, so it launches INSIDE
 * docker.io/nixos/nix with the build root mounted read-only and the closure
 * from a named volume — the launch shape crow-addons proved in production on
 * 2026-10-02. The container is supervised like any native child: `docker run`
 * stays attached, so the supervisor's SIGTERM reaches gufo through
 * --sig-proxy, and --rm removes it on exit.
 */
import { accessSync, readFileSync, constants } from "node:fs";
import { dirname, join } from "node:path";
import { RuntimeOverrideError } from "../runtime-override.js";

export const id = "gufo";
export const launchShape = "container";
export const healthPath = "/health";

export const GUFO_LAUNCH_KEYS = ["ctx", "sessions", "max_pending_per_client", "speculative", "think", "extra_args"];
const SPECULATIVE = ["dflash2", "mtp", "off"];
const THINK = ["on", "off"];
export const GUFO_OWNED_FLAGS = new Set([
  "--model", "--mmproj", "--speculative", "--dflash-model", "--context", "--sessions",
  "--served-model-name", "--max-pending-per-client", "--host", "--port", "--think",
]);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export function validateGufoLaunch(launch, { contextLen = null, label = "runtimes.gufo.launch" } = {}) {
  if (launch === undefined || launch === null) return [];
  if (!isObj(launch)) return [`${label}: must be a plain object`];
  const errors = [];
  for (const k of Object.keys(launch)) if (!GUFO_LAUNCH_KEYS.includes(k)) errors.push(`${label}: unknown key "${k}"`);
  const { ctx, sessions, max_pending_per_client, speculative, think, extra_args } = launch;
  if (ctx !== undefined) {
    if (!Number.isInteger(ctx) || ctx < 1024) errors.push(`${label}: ctx must be an integer >= 1024`);
    else if (Number.isFinite(contextLen) && ctx > contextLen) errors.push(`${label}: ctx ${ctx} exceeds context_len ${contextLen}`);
  }
  if (sessions !== undefined && (!Number.isInteger(sessions) || sessions < 1)) errors.push(`${label}: sessions must be an integer >= 1`);
  if (max_pending_per_client !== undefined && (!Number.isInteger(max_pending_per_client) || max_pending_per_client < 1)) errors.push(`${label}: max_pending_per_client must be an integer >= 1`);
  if (speculative !== undefined && !SPECULATIVE.includes(speculative)) errors.push(`${label}: speculative must be one of ${SPECULATIVE.join(", ")}`);
  if (think !== undefined && !THINK.includes(think)) errors.push(`${label}: think must be one of ${THINK.join(", ")}`);
  if (extra_args !== undefined) {
    if (!Array.isArray(extra_args) || extra_args.some((a) => typeof a !== "string")) errors.push(`${label}: extra_args must be an array of strings`);
    else for (const a of extra_args) { const f = a.split("=")[0]; if (GUFO_OWNED_FLAGS.has(f)) errors.push(`${label}: extra_args may not contain "${f}" (owned by the launcher)`); }
  }
  return errors;
}

export function renderGufoArgs({ ggufPath, alias, port, launch = {}, companions = [] }) {
  const l = launch || {};
  const byKind = (k) => companions.find((c) => c && c.kind === k && c.path)?.path || null;
  const args = ["serve", "llm", "--model", ggufPath];
  const mmproj = byKind("mmproj");
  if (mmproj) args.push("--mmproj", mmproj);
  if (l.speculative === "dflash2") {
    const d = byKind("dflash");
    if (!d) throw new Error("gufo: speculative dflash2 needs a dflash companion (runtimes.gufo.assets kind dflash)");
    args.push("--speculative", "dflash2", "--dflash-model", d);
  } else if (l.speculative === "mtp") {
    args.push("--speculative", "mtp");
  }
  if (l.ctx !== undefined) args.push("--context", String(l.ctx));
  if (l.sessions !== undefined) args.push("--sessions", String(l.sessions));
  args.push("--served-model-name", alias);
  if (l.max_pending_per_client !== undefined) args.push("--max-pending-per-client", String(l.max_pending_per_client));
  if (l.think !== undefined) args.push("--think", l.think);
  if (Array.isArray(l.extra_args)) args.push(...l.extra_args);
  args.push("--host", "0.0.0.0", "--port", String(port));
  return args;
}

export function containerNameFor(providerName) {
  const s = String(providerName || "model").toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return `crow-rt-${s || "model"}`;
}

export function buildCommand({ install, ggufPath, alias, port, launch, companions = [], providerName }) {
  const containerName = containerNameFor(providerName || alias);
  const mounts = new Set([dirname(ggufPath), ...companions.filter((c) => c && c.path).map((c) => dirname(c.path))]);
  const args = [
    "run", "--rm", "--name", containerName,
    "--device", "/dev/kfd", "--device", "/dev/dri",
    "--group-add", String(install.videoGid), "--group-add", String(install.renderGid),
    "--ipc", "host", "--ulimit", "memlock=-1:-1", "--shm-size", "16g",
    "-v", `${install.nixVolume || "gufo-nix"}:/nix`,
    "-v", `${install.root}:/opt/gufo:ro`,
  ];
  for (const d of [...mounts].sort()) args.push("-v", `${d}:${d}:ro`);
  args.push("-p", `127.0.0.1:${port}:${port}`, install.image || "docker.io/nixos/nix:latest", `/opt/gufo/${install.bin || "current/gufo"}`);
  args.push(...renderGufoArgs({ ggufPath, alias, port, launch, companions }));
  return { command: "docker", args, containerName };
}

export function parseGufoBuildInfo(text) {
  const lines = String(text || "").split("\n");
  const base = lines.map((l) => l.match(/^base=([0-9a-f]{6,40})\b/)).find(Boolean);
  if (!base) return null;
  const extras = lines
    .map((l) => l.match(/^(pr\d+)=([0-9a-f]{6,40})\b/))
    .filter((m) => m && m[2] !== base[1])
    .map((m) => `${m[1]}=${m[2]}`);
  return [base[1], ...extras].join("+");
}

export function probeVersion(install, { accessSyncImpl = accessSync, readFileImpl = (p) => readFileSync(p, "utf8") } = {}) {
  const binPath = join(install?.root || "", install?.bin || "current/gufo");
  try {
    accessSyncImpl(binPath, constants.X_OK);
  } catch (err) {
    throw new RuntimeOverrideError(`gufo binary ${binPath} is not executable (${err.message})`, "NOT_EXECUTABLE", { bin: binPath });
  }
  let info;
  try { info = readFileImpl(join(dirname(binPath), "BUILD-INFO")); } catch (err) {
    throw new RuntimeOverrideError(`gufo BUILD-INFO beside ${binPath} is unreadable (${err.message})`, "VERSION_FAILED", { bin: binPath });
  }
  const v = parseGufoBuildInfo(info);
  if (!v) throw new RuntimeOverrideError(`gufo BUILD-INFO beside ${binPath} has no base=<sha> line`, "VERSION_FAILED", { bin: binPath });
  return v;
}

export function supports({ catalogEntry, launch = {}, probe }) {
  if (!probe || probe.gpuArch !== "gfx1151") return { ok: false, reason: "gufo runs only on gfx1151 (Strix Halo)" };
  if (!catalogEntry || !isObj(catalogEntry.runtimes) || !isObj(catalogEntry.runtimes.gufo)) return { ok: false, reason: "catalog entry has no runtimes.gufo block" };
  const extra = Array.isArray(launch?.extra_args) ? launch.extra_args : [];
  if (extra.some((a) => /^--(rope-scaling|rope-scale|yarn-)/.test(a))) return { ok: false, reason: "gufo has no YaRN (dense path refuses context above the native length)" };
  if (Number.isInteger(launch?.ctx) && Number.isFinite(catalogEntry.context_len) && launch.ctx > catalogEntry.context_len) {
    return { ok: false, reason: `gufo refuses ctx ${launch.ctx} above the model's ${catalogEntry.context_len}` };
  }
  return { ok: true };
}
```

In `runtimes/index.js` add `import * as gufo from "./gufo.js";` and `RUNTIMES.set("gufo", gufo);`.

- [ ] **Step 5: Run, expect PASS.** `npm test -- tests/runtimes-gufo.test.js tests/runtimes-llama-server.test.js`

- [ ] **Step 6: Commit.**

```bash
git add servers/gateway/models/runtimes/gufo.js tests/runtimes-gufo.test.js tests/fixtures/gufo-parity/qwen38-27b-solo.json
git commit servers/gateway/models/runtimes/gufo.js servers/gateway/models/runtimes/index.js tests/runtimes-gufo.test.js tests/fixtures/gufo-parity/qwen38-27b-solo.json -m "feat(models): gufo runtime — container launch shape, argv parity with the production compose, BUILD-INFO version"
```

---

### Task 3: Catalog `runtimes.gufo` block and the 27B data

Spec §11.2. *(Ruling, Q2 in §11.11)* A runtime asset may omit `hf_repo`; such an asset is **adopt-only** and the validator requires `"adopt_only": true` so the omission is deliberate.

**Files:**
- Modify: `scripts/validate-model-catalog.js`, `registry/model-catalog.json` (`qwen3.8-27b`)
- Test: `tests/model-catalog-runtimes.test.js`

**Interfaces:**
- Consumes: `validateGufoLaunch` (Task 2).
- Produces: catalog shape `models[].runtimes.gufo = { launch, assets: [{ kind: "dflash"|"mmproj", file, size_mb, sha256, hf_repo?, adopt_only? }] }`; exported `validateRuntimesBlock(model, label) -> string[]` from the validator module.

- [ ] **Step 1: Write the failing test.**

```js
// tests/model-catalog-runtimes.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateRuntimesBlock } from "../scripts/validate-model-catalog.js";

const catalog = JSON.parse(readFileSync(join(import.meta.dirname, "..", "registry", "model-catalog.json"), "utf8"));
const SHA = "a".repeat(64);
const base = { id: "m", context_len: 262144 };

test("absent block is valid", () => assert.deepEqual(validateRuntimesBlock(base, "m"), []));

test("only known runtime ids", () => {
  assert.match(validateRuntimesBlock({ ...base, runtimes: { vllm: {} } }, "m")[0], /unknown runtime "vllm"/);
});

test("gufo launch is validated by the gufo module", () => {
  assert.match(validateRuntimesBlock({ ...base, runtimes: { gufo: { launch: { ctx: 999999 } } } }, "m")[0], /exceeds context_len/);
});

test("assets: kind, file, size_mb, sha256 required; hf_repo or adopt_only", () => {
  const ok = { kind: "dflash", file: "d.gguf", size_mb: 1.5, sha256: SHA, adopt_only: true };
  assert.deepEqual(validateRuntimesBlock({ ...base, runtimes: { gufo: { assets: [ok] } } }, "m"), []);
  assert.match(validateRuntimesBlock({ ...base, runtimes: { gufo: { assets: [{ ...ok, adopt_only: undefined }] } } }, "m")[0], /hf_repo or "adopt_only": true/);
  assert.match(validateRuntimesBlock({ ...base, runtimes: { gufo: { assets: [{ ...ok, kind: "lora" }] } } }, "m")[0], /kind/);
  assert.match(validateRuntimesBlock({ ...base, runtimes: { gufo: { assets: [{ ...ok, sha256: "x" }] } } }, "m")[0], /sha256/);
});

test("speculative dflash2 requires a dflash asset", () => {
  assert.match(validateRuntimesBlock({ ...base, runtimes: { gufo: { launch: { speculative: "dflash2" }, assets: [] } } }, "m")[0], /dflash asset/);
});

test("the shipped catalog: qwen3.8-27b carries the production gufo block", () => {
  const m = catalog.models.find((x) => x.id === "qwen3.8-27b");
  assert.deepEqual(m.runtimes.gufo.launch, { ctx: 262144, sessions: 1, max_pending_per_client: 16, speculative: "dflash2" });
  const kinds = m.runtimes.gufo.assets.map((a) => a.kind).sort();
  assert.deepEqual(kinds, ["dflash", "mmproj"]);
  const d = m.runtimes.gufo.assets.find((a) => a.kind === "dflash");
  assert.equal(d.sha256, "1a25c56858e1ebe93f2718ac1d49d1151f9323325c1bbfd6209370f4db131ebd");
  assert.equal(d.adopt_only, true);
  const p = m.runtimes.gufo.assets.find((a) => a.kind === "mmproj");
  assert.equal(p.sha256, "83ee4f4f205fa514161778c41df1ea14144faa0f713510893b63c2395f5c2d53");
  assert.equal(p.hf_repo, "unsloth/Qwen3.8-27B-GGUF");
  for (const x of catalog.models) assert.deepEqual(validateRuntimesBlock(x, x.id), [], x.id);
});
```

- [ ] **Step 2: Run, expect FAIL.** `npm test -- tests/model-catalog-runtimes.test.js`

- [ ] **Step 3: Implement.** In `scripts/validate-model-catalog.js`, export the function and call it from the per-model loop (push its errors into `errors`). The script must stay runnable as a CLI; if it does not already guard `main()` behind an `invokedDirectly` check, add one the same way `scripts/models-runtime-override.mjs` does, so importing it from a test does not run the CLI.

```js
import { validateGufoLaunch } from "../servers/gateway/models/runtimes/gufo.js";

const RUNTIME_BLOCK_IDS = ["gufo"];
const RUNTIME_ASSET_KINDS = ["dflash", "mmproj"];

export function validateRuntimesBlock(model, label) {
  const errors = [];
  if (model.runtimes === undefined) return errors;
  if (!model.runtimes || typeof model.runtimes !== "object" || Array.isArray(model.runtimes)) return [`${label}: runtimes must be an object`];
  for (const [rid, block] of Object.entries(model.runtimes)) {
    if (!RUNTIME_BLOCK_IDS.includes(rid)) { errors.push(`${label}: unknown runtime "${rid}" in runtimes`); continue; }
    if (!block || typeof block !== "object" || Array.isArray(block)) { errors.push(`${label}.runtimes.${rid}: must be an object`); continue; }
    errors.push(...validateGufoLaunch(block.launch, { contextLen: model.context_len, label: `${label}.runtimes.gufo.launch` }));
    const assets = block.assets === undefined ? [] : block.assets;
    if (!Array.isArray(assets)) { errors.push(`${label}.runtimes.gufo.assets: must be an array`); continue; }
    assets.forEach((a, i) => {
      const al = `${label}.runtimes.gufo.assets[${i}]`;
      if (!a || typeof a !== "object") { errors.push(`${al}: must be an object`); return; }
      if (!RUNTIME_ASSET_KINDS.includes(a.kind)) errors.push(`${al}: kind must be one of ${RUNTIME_ASSET_KINDS.join(", ")}`);
      if (typeof a.file !== "string" || !a.file || a.file.includes("..")) errors.push(`${al}: file must be a relative path without ".."`);
      if (!(typeof a.size_mb === "number" && a.size_mb > 0)) errors.push(`${al}: size_mb must be a positive number`);
      if (typeof a.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(a.sha256)) errors.push(`${al}: sha256 must be 64 lowercase hex chars`);
      if (!(typeof a.hf_repo === "string" && a.hf_repo) && a.adopt_only !== true) errors.push(`${al}: needs hf_repo or "adopt_only": true`);
    });
    if (block.launch?.speculative === "dflash2" && !assets.some((a) => a && a.kind === "dflash")) {
      errors.push(`${label}.runtimes.gufo: speculative dflash2 needs a dflash asset`);
    }
  }
  return errors;
}
```

In `registry/model-catalog.json`, add to the `qwen3.8-27b` entry (sizes are decimal MB = bytes / 1e6; bytes and sha256 verified on crow 2026-10-02 from `~/llm/hf-cache/qwen38-27b/`: the DFlash2 sha from pi-lab's pinned `gufo-eval-sha.txt`, the BF16 mmproj sha from its Hugging Face download metadata at revision `4ca72078`):

```json
      "runtimes": {
        "gufo": {
          "launch": { "ctx": 262144, "sessions": 1, "max_pending_per_client": 16, "speculative": "dflash2" },
          "assets": [
            { "kind": "dflash", "file": "Qwen3.8-27B-DFlash2-Q4_K_M.gguf", "size_mb": 1143.01, "sha256": "1a25c56858e1ebe93f2718ac1d49d1151f9323325c1bbfd6209370f4db131ebd", "adopt_only": true },
            { "kind": "mmproj", "file": "mmproj-BF16.gguf", "size_mb": 931.15, "sha256": "83ee4f4f205fa514161778c41df1ea14144faa0f713510893b63c2395f5c2d53", "hf_repo": "unsloth/Qwen3.8-27B-GGUF" }
          ]
        }
      },
```

Append to its `notes`: " On gfx1151 Crow serves it with gufo + DFlash2 (BF16 mmproj; the F16 one is llama.cpp's) when a gufo install is recorded on the host."

- [ ] **Step 4: Run, expect PASS**, plus `npm run validate-model-catalog` and `npm test -- tests/model-catalog-validate.test.js tests/model-catalog-launch-parity.test.js`.

- [ ] **Step 5: Commit.**

```bash
git add tests/model-catalog-runtimes.test.js
git commit scripts/validate-model-catalog.js registry/model-catalog.json tests/model-catalog-runtimes.test.js -m "feat(catalog): runtimes.gufo block (launch + sha-pinned assets); qwen3.8-27b carries the production gufo shape"
```

---

### Task 4: Host runtime install records and the operator CLI

Spec §11.2 (`state.json.runtimeInstalls.gufo`), never replicated.

**Files:**
- Create: `servers/gateway/models/runtime-installs.js`, `scripts/models-runtime-install.mjs`
- Modify: `servers/gateway/models/state.js` (`emptyState` and the loader keep `runtimeInstalls: {}`)
- Test: `tests/runtime-installs.test.js`

**Interfaces:**
- Consumes: `getRuntime("gufo").probeVersion`, `loadState`, `saveState`.
- Produces: `getRuntimeInstall(dir, runtimeId, deps) -> record|null`; `setRuntimeInstall(dir, runtimeId, input, deps) -> record` (validates via the runtime's `probeVersion`; resolves `videoGid`/`renderGid` with `getentGidFn("video")`/`("render")` when not given; stamps `version`, `setAt`); `clearRuntimeInstall(dir, runtimeId, deps) -> boolean`; `listRuntimeInstalls(dir, deps) -> object`. CLI: `node scripts/models-runtime-install.mjs list | set-gufo --root <abs> [--bin current/gufo] [--image …] [--nix-volume …] | clear --runtime gufo` with exit codes 0/1/2 like `models-runtime-override.mjs`.

- [ ] **Step 1: Write the failing test.**

```js
// tests/runtime-installs.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { getRuntimeInstall, setRuntimeInstall, clearRuntimeInstall, listRuntimeInstalls } from "../servers/gateway/models/runtime-installs.js";

function memState() {
  let st = { registry: {}, runtimeInstalls: {} };
  return { loadStateFn: () => JSON.parse(JSON.stringify(st)), saveStateFn: (_d, s) => { st = s; }, peek: () => st };
}
const okProbe = { accessSyncImpl: () => {}, readFileImpl: () => "base=9abedf6\npr324=cea8ea8\n" };

test("set-gufo validates, fills gids from getent, stamps version and time", () => {
  const m = memState();
  const rec = setRuntimeInstall("/d", "gufo", { root: "/home/u/gufo-prod" }, { ...m, ...okProbe, getentGidFn: (g) => ({ video: 44, render: 992 })[g], now: () => new Date("2026-10-05T10:00:00Z") });
  assert.deepEqual(rec, { root: "/home/u/gufo-prod", bin: "current/gufo", image: "docker.io/nixos/nix:latest", nixVolume: "gufo-nix", videoGid: 44, renderGid: 992, version: "9abedf6+pr324=cea8ea8", setAt: "2026-10-05T10:00:00.000Z" });
  assert.deepEqual(getRuntimeInstall("/d", "gufo", m), rec);
  assert.deepEqual(Object.keys(listRuntimeInstalls("/d", m)), ["gufo"]);
});

test("a relative root, an unknown runtime, or a failed probe persists nothing", () => {
  const m = memState();
  assert.throws(() => setRuntimeInstall("/d", "gufo", { root: "gufo-prod" }, { ...m, ...okProbe }), (e) => e.code === "NOT_ABSOLUTE");
  assert.throws(() => setRuntimeInstall("/d", "vllm", { root: "/x" }, m), /unknown runtime/);
  assert.throws(() => setRuntimeInstall("/d", "gufo", { root: "/gone" }, { ...m, accessSyncImpl: () => { throw new Error("ENOENT"); } }), (e) => e.code === "NOT_EXECUTABLE");
  assert.deepEqual(m.peek().runtimeInstalls, {});
});

test("a missing root is NOT_EXECUTABLE and names the path", () => {
  const m = memState();
  assert.throws(() => setRuntimeInstall("/d", "gufo", { root: "/home/u/gufo-prod" }, { ...m, accessSyncImpl: () => { throw new Error("ENOENT"); } }), (e) => e.code === "NOT_EXECUTABLE" && e.message.includes("/home/u/gufo-prod/current/gufo"));
});

test("clear removes only that runtime", () => {
  const m = memState();
  setRuntimeInstall("/d", "gufo", { root: "/r", videoGid: 1, renderGid: 2 }, { ...m, ...okProbe });
  assert.equal(clearRuntimeInstall("/d", "gufo", m), true);
  assert.equal(clearRuntimeInstall("/d", "gufo", m), false);
  assert.equal(getRuntimeInstall("/d", "gufo", m), null);
});
```

- [ ] **Step 2: Run, expect FAIL.** `npm test -- tests/runtime-installs.test.js`

- [ ] **Step 3: Implement.**

```js
// servers/gateway/models/runtime-installs.js
/**
 * Host-local runtime install records (spec §11.2): state.json.runtimeInstalls
 * [runtimeId] = { root, bin, image, nixVolume, videoGid, renderGid, version,
 * setAt }. Like the llama-server override, a record lives in the state file,
 * never the DB, so it never replicates: an install is a fact about one host.
 */
import { execFileSync } from "node:child_process";
import { isAbsolute } from "node:path";
import { loadState, saveState } from "./state.js";
import { getRuntime } from "./runtimes/index.js";
import { RuntimeOverrideError } from "./runtime-override.js";

function defaultGetentGid(group) {
  const line = execFileSync("getent", ["group", group], { encoding: "utf8" }).trim();
  const gid = Number(line.split(":")[2]);
  if (!Number.isInteger(gid)) throw new Error(`getent group ${group}: no gid`);
  return gid;
}

const installsOf = (s) => (s && s.runtimeInstalls && typeof s.runtimeInstalls === "object" && !Array.isArray(s.runtimeInstalls) ? s.runtimeInstalls : {});

export function getRuntimeInstall(dir, runtimeId, { loadStateFn = loadState } = {}) {
  const rec = installsOf(loadStateFn(dir))[runtimeId];
  return rec && typeof rec.root === "string" ? { ...rec } : null;
}

export function listRuntimeInstalls(dir, { loadStateFn = loadState } = {}) {
  return { ...installsOf(loadStateFn(dir)) };
}

export function setRuntimeInstall(dir, runtimeId, input = {}, opts = {}) {
  const { loadStateFn = loadState, saveStateFn = saveState, getentGidFn = defaultGetentGid, now = () => new Date() } = opts;
  const runtime = getRuntime(runtimeId);
  if (runtimeId !== "gufo") throw new Error(`runtime "${runtimeId}" takes no install record (llama-server uses runtime overrides)`);
  if (typeof input.root !== "string" || !isAbsolute(input.root)) {
    throw new RuntimeOverrideError(`gufo root must be an absolute path, got ${JSON.stringify(input.root)}`, "NOT_ABSOLUTE");
  }
  const draft = {
    root: input.root,
    bin: input.bin || "current/gufo",
    image: input.image || "docker.io/nixos/nix:latest",
    nixVolume: input.nixVolume || "gufo-nix",
    videoGid: Number.isInteger(input.videoGid) ? input.videoGid : getentGidFn("video"),
    renderGid: Number.isInteger(input.renderGid) ? input.renderGid : getentGidFn("render"),
  };
  const version = runtime.probeVersion(draft, opts);
  const record = { ...draft, version, setAt: now().toISOString() };
  const state = loadStateFn(dir);
  state.runtimeInstalls = { ...installsOf(state), [runtimeId]: record };
  saveStateFn(dir, state);
  return record;
}

export function clearRuntimeInstall(dir, runtimeId, { loadStateFn = loadState, saveStateFn = saveState } = {}) {
  const state = loadStateFn(dir);
  const map = { ...installsOf(state) };
  if (!Object.hasOwn(map, runtimeId)) return false;
  delete map[runtimeId];
  state.runtimeInstalls = map;
  saveStateFn(dir, state);
  return true;
}
```

In `state.js`, add `runtimeInstalls: {}` to `emptyState()` and `runtimeInstalls: obj("runtimeInstalls")` to the loader's normalized object (the same `obj(...)` helper `conversions` uses). Three existing assertions in `tests/models-state.test.js` deep-equal the empty state ("loadState on a missing state file…", "saveState + loadState round-trip…", "loadState on a corrupt (non-JSON) state file…", around lines 163, 186 and 208): add `runtimeInstalls: {}` to each expected object.

```js
#!/usr/bin/env node
// scripts/models-runtime-install.mjs
/**
 * models-runtime-install.mjs — record, inspect and clear host runtime installs
 * in <data dir>/models/state.json (spec §11.2). gufo only today.
 *
 *   list
 *   set-gufo --root <abs> [--bin current/gufo] [--image docker.io/nixos/nix:latest] [--nix-volume gufo-nix]
 *   clear --runtime gufo
 *
 * For r4: CROW_DATA_DIR=/home/kh0pp/.crow-r4/data node scripts/models-runtime-install.mjs …
 * Exit: 0 ok, 1 refused (validation), 2 usage.
 */
import { parseArgs } from "node:util";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveDataDir } from "../servers/db.js";
import { listRuntimeInstalls, setRuntimeInstall, clearRuntimeInstall } from "../servers/gateway/models/runtime-installs.js";
import { RuntimeOverrideError } from "../servers/gateway/models/runtime-override.js";

export async function main(argv, { dir = resolveDataDir(), out = console.log, err = console.error } = {}) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    root: { type: "string" }, bin: { type: "string" }, image: { type: "string" }, "nix-volume": { type: "string" }, runtime: { type: "string" },
  } });
  const cmd = positionals[0];
  try {
    if (cmd === "list") { out(JSON.stringify(listRuntimeInstalls(dir), null, 2)); return 0; }
    if (cmd === "set-gufo") {
      if (!values.root) { err("usage: set-gufo --root <abs path>"); return 2; }
      const rec = setRuntimeInstall(dir, "gufo", { root: values.root, bin: values.bin, image: values.image, nixVolume: values["nix-volume"] });
      out(`gufo install recorded in ${dir}: ${JSON.stringify(rec)}`);
      return 0;
    }
    if (cmd === "clear") {
      if (values.runtime !== "gufo") { err("usage: clear --runtime gufo"); return 2; }
      out(clearRuntimeInstall(dir, "gufo") ? `cleared gufo install in ${dir}` : "none");
      return 0;
    }
    err("usage: list | set-gufo --root <abs> [...] | clear --runtime gufo");
    return 2;
  } catch (e) {
    if (e instanceof RuntimeOverrideError) { err(`refused (${e.code}): ${e.message}`); return 1; }
    throw e;
  }
}

function invokedDirectly() {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}
if (invokedDirectly()) main(process.argv.slice(2)).then((code) => process.exit(code));
```

- [ ] **Step 4: Run, expect PASS**, plus `npm test -- tests/runtime-installs.test.js tests/models-state.test.js`.

- [ ] **Step 5: Commit.**

```bash
git add servers/gateway/models/runtime-installs.js scripts/models-runtime-install.mjs tests/runtime-installs.test.js
git commit servers/gateway/models/runtime-installs.js scripts/models-runtime-install.mjs servers/gateway/models/state.js tests/runtime-installs.test.js tests/models-state.test.js -m "feat(models): host runtime install records (gufo root/image/nix volume/gids, BUILD-INFO version) + CLI"
```

---

### Task 5: Adopt runtime assets (sha-verified) into the registry

**Files:**
- Modify: `servers/gateway/models/manager.js` (`adoptModel`, the size-mismatch message in `checkAdoptFile`)
- Test: `tests/models-adopt-runtime-assets.test.js`

**Interfaces:**
- Consumes: `adoptModel` (plan 1), catalog `runtimes.gufo.assets` (Task 3).
- Produces: `adoptModel({ …, runtimeAssetPaths = {} })` where `runtimeAssetPaths = { gufo: { dflash: "/abs", mmproj: "/abs" } }`; each path is sha256-checked against the catalog asset of that kind (size-only with `allowUnverified`); the registry entry gains `runtimeAssets: { gufo: [{ kind, path, verified }] }`. Errors reuse `AdoptMismatchError` codes `ADOPT_SHA_MISMATCH`, `ADOPT_SIZE_MISMATCH`, `ADOPT_PATH_NOT_ABSOLUTE`, plus `ADOPT_UNKNOWN_ASSET` for a kind the catalog does not list.

- [ ] **Step 1: Write the failing test** (same real-file, real-libsql harness as `tests/models-adopt.test.js`):

```js
// tests/models-adopt-runtime-assets.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { adoptModel, AdoptMismatchError } from "../servers/gateway/models/manager.js";
import { loadState } from "../servers/gateway/models/state.js";
import { setProviderSyncManager } from "../servers/shared/providers-db.js";

function freshLibsql() {
  const dir = mkdtempSync(join(tmpdir(), "adopt-rt-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: join(import.meta.dirname, "..") });
  const prev = process.env.CROW_DATA_DIR;
  process.env.CROW_DATA_DIR = dir;
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { dir, db, cleanup() { setProviderSyncManager(null); if (prev === undefined) delete process.env.CROW_DATA_DIR; else process.env.CROW_DATA_DIR = prev; try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}
const sha = (b) => createHash("sha256").update(b).digest("hex");
const PRIMARY = Buffer.from("primary-27b"), DFLASH = Buffer.from("dflash-draft"), MMPROJ = Buffer.from("mmproj-bf16");
const catalog = { version: 3, runtime: { name: "llama.cpp", release: "b10068", assets: {} }, models: [{
  id: "m27", family: "T", lab: "L", hf_repo: "t/m27-GGUF", license: "apache-2.0", gated: false, task: "chat", context_len: 262144,
  min_runtime_version: "b10068", default_quant: "Q6", tags: [], serving: { class: "resident" },
  quants: [{ file: "m27-Q6.gguf", quant: "Q6", size_mb: PRIMARY.length / 1e6, min_ram_mb: 1, min_vram_mb: 0, sha256: sha(PRIMARY) }],
  runtimes: { gufo: { launch: { speculative: "dflash2" }, assets: [
    { kind: "dflash", file: "d.gguf", size_mb: DFLASH.length / 1e6, sha256: sha(DFLASH), adopt_only: true },
    { kind: "mmproj", file: "mmproj-BF16.gguf", size_mb: MMPROJ.length / 1e6, sha256: sha(MMPROJ), hf_repo: "t/m27-GGUF" },
  ] } },
}] };
const OPTS = (h) => ({ db: h.db, dir: h.dir, allocatePortFn: async (s, id) => { s.reservations[id] = { port: 18171, owner: {} }; return 18171; },
  ownInstanceIdFn: () => "inst-A", tailnetIpFn: () => "100.118.41.122", gatewayPortFn: () => 3001 });

function weightsDir() {
  const w = mkdtempSync(join(tmpdir(), "w27-"));
  mkdirSync(join(w, "mmproj-bf16"));
  writeFileSync(join(w, "m27.gguf"), PRIMARY);
  writeFileSync(join(w, "d.gguf"), DFLASH);
  writeFileSync(join(w, "mmproj-bf16", "mmproj-BF16.gguf"), MMPROJ);
  writeFileSync(join(w, "wrong.gguf"), Buffer.from("not-the-draft"));
  writeFileSync(join(w, "big.gguf"), Buffer.alloc(PRIMARY.length * 2, 1));
  return w;
}

test("runtime assets are verified and recorded on the registry entry", async () => {
  const h = freshLibsql(); const w = weightsDir();
  try {
    await adoptModel({ modelId: "m27", quant: "Q6", path: join(w, "m27.gguf"), catalog, ...OPTS(h),
      runtimeAssetPaths: { gufo: { dflash: join(w, "d.gguf"), mmproj: join(w, "mmproj-bf16", "mmproj-BF16.gguf") } } });
    assert.deepEqual(loadState(h.dir).registry["m27@Q6"].runtimeAssets, { gufo: [
      { kind: "dflash", path: join(w, "d.gguf"), verified: true },
      { kind: "mmproj", path: join(w, "mmproj-bf16", "mmproj-BF16.gguf"), verified: true },
    ] });
  } finally { h.cleanup(); rmSync(w, { recursive: true, force: true }); }
});

test("a runtime asset whose sha differs is refused naming the asset; nothing registered", async () => {
  const h = freshLibsql(); const w = weightsDir();
  try {
    await assert.rejects(adoptModel({ modelId: "m27", quant: "Q6", path: join(w, "m27.gguf"), catalog, ...OPTS(h),
      runtimeAssetPaths: { gufo: { dflash: join(w, "wrong.gguf") } } }),
      (e) => e instanceof AdoptMismatchError && e.code === "ADOPT_SHA_MISMATCH" && /gufo dflash/.test(e.message));
    assert.equal(Object.keys(loadState(h.dir).registry).length, 0);
  } finally { h.cleanup(); rmSync(w, { recursive: true, force: true }); }
});

test("an unknown asset kind is refused", async () => {
  const h = freshLibsql(); const w = weightsDir();
  try {
    await assert.rejects(adoptModel({ modelId: "m27", quant: "Q6", path: join(w, "m27.gguf"), catalog, ...OPTS(h),
      runtimeAssetPaths: { gufo: { lora: join(w, "d.gguf") } } }), (e) => e.code === "ADOPT_UNKNOWN_ASSET");
  } finally { h.cleanup(); rmSync(w, { recursive: true, force: true }); }
});

test("an out-of-tolerance size names both sizes", async () => {
  const h = freshLibsql(); const w = weightsDir();
  try {
    await assert.rejects(adoptModel({ modelId: "m27", quant: "Q6", path: join(w, "big.gguf"), catalog, allowUnverified: true, ...OPTS(h) }),
      (e) => e.code === "ADOPT_SIZE_MISMATCH" && e.message.includes(`${PRIMARY.length * 2} bytes`) && e.message.includes(`${PRIMARY.length} bytes`) && /catalog quant entry/.test(e.message));
  } finally { h.cleanup(); rmSync(w, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run, expect FAIL.** `npm test -- tests/models-adopt-runtime-assets.test.js`

- [ ] **Step 3: Implement.** In `adoptModel`, after the primary/shard/companion checks and before calling `registerModel`, add:

```js
  const runtimeAssets = {};
  for (const [rid, kinds] of Object.entries(runtimeAssetPaths || {})) {
    const declared = model.runtimes?.[rid]?.assets || [];
    runtimeAssets[rid] = [];
    for (const [kind, assetPath] of Object.entries(kinds || {})) {
      const asset = declared.find((a) => a.kind === kind);
      if (!asset) throw new AdoptMismatchError(`adopt: ${model.id} declares no ${rid} asset of kind "${kind}"`, "ADOPT_UNKNOWN_ASSET", { file: assetPath });
      if (typeof assetPath !== "string" || !isAbsolute(assetPath)) {
        throw new AdoptMismatchError(`adopt: ${rid} ${kind} path must be absolute, got ${JSON.stringify(assetPath)}`, "ADOPT_PATH_NOT_ABSOLUTE", { file: assetPath });
      }
      const verified = await checkAdoptFile({
        path: assetPath, expectedSha: asset.sha256, sizeMb: asset.size_mb, allowUnverified,
        hashFileFn, statFn, what: `${model.id} ${rid} ${kind} (${asset.file})`,
      });
      runtimeAssets[rid].push({ kind, path: assetPath, verified });
    }
  }
```

and pass `runtimeAssets` inside `registryExtra` (spread next to `path`, `adopted`, `verified`, `companions`). Add `runtimeAssetPaths = {}` to the destructured parameters. In `checkAdoptFile`, replace the size-mismatch message (keep the code and the `expected`/`actual` details) with:

```js
    throw new AdoptMismatchError(
      `${what}: ${path} is ${st.size} bytes (${(st.size / 1e6).toFixed(2)} MB) but the catalog says about ${Math.round(sizeMb * 1e6)} bytes (${sizeMb} MB), beyond the 0.5 % tolerance — add a catalog quant entry for this build or download the current file`,
      "ADOPT_SIZE_MISMATCH", { file: path, expected: Math.round(sizeMb * 1e6), actual: st.size });
```

If an existing assertion in `tests/models-adopt.test.js` matches the old wording, update that assertion to the new wording in the same commit.

- [ ] **Step 4: Run, expect PASS**, plus `npm test -- tests/models-adopt.test.js tests/models-registration.test.js`.

- [ ] **Step 5: Commit.**

```bash
git add tests/models-adopt-runtime-assets.test.js
git commit servers/gateway/models/manager.js tests/models-adopt-runtime-assets.test.js tests/models-adopt.test.js -m "feat(models): adopt sha-verified runtime assets (gufo dflash/mmproj) onto the registry entry"
```

---

### Task 6: `selectRuntime` and the orchestrator wiring

Spec §11.2 selection rule; §4 single start funnel.

**Files:**
- Modify: `servers/gateway/models/runtimes/index.js` (`selectRuntime`, `RuntimeSelectError`), `servers/gateway/models/runtime.js` (`startModel` accepts `prebuilt`), `servers/gateway/gpu-orchestrator.js` (`startNativeAndAwaitReady`)
- Test: `tests/runtimes-select.test.js`, `tests/gpu-orchestrator-runtime.test.js`

**Interfaces:**
- Consumes: Tasks 1–5; `getRuntimeInstall`; `hostLaunchDefaults`; `mergeLaunch`.
- Produces:
  - `selectRuntime({ probe, catalogEntry, gpuPolicy, installs, launch }) -> { runtimeId, reason }`; throws `RuntimeSelectError` with `code` `RUNTIME_UNSUPPORTED` (pinned gufo cannot serve) or `RUNTIME_NOT_INSTALLED` (pinned gufo, no install record).
  - `gpu_policy.runtimeId` (`"llama-server"|"gufo"`, optional pin) and `gpu_policy.runtimeLaunch.gufo` (provider override over the catalog gufo launch).
  - `startModel({ …, prebuilt: { command, args } | null })`: when `prebuilt` is given, spawn `prebuilt.command` with `prebuilt.args` and expose them as `argv`.
  - orchestrator: before spawning a gufo container, runs `docker rm -f <containerName>` through an injectable `removeContainerFn`; logs `runtime=<id> (<reason>)`.

- [ ] **Step 1: Write the failing tests.**

```js
// tests/runtimes-select.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectRuntime } from "../servers/gateway/models/runtimes/index.js";

const GFX = { gpuArch: "gfx1151", accel: "vulkan" };
const entry = { context_len: 262144, runtimes: { gufo: { launch: { ctx: 262144 } } } };
const installs = { gufo: { root: "/r" } };

test("gfx1151 + catalog block + install → gufo", () => {
  assert.equal(selectRuntime({ probe: GFX, catalogEntry: entry, gpuPolicy: {}, installs, launch: {} }).runtimeId, "gufo");
});
test("no install, no block, other arch → llama-server, with a reason", () => {
  assert.match(selectRuntime({ probe: GFX, catalogEntry: entry, gpuPolicy: {}, installs: {}, launch: {} }).reason, /no gufo install/);
  assert.equal(selectRuntime({ probe: GFX, catalogEntry: { context_len: 1 }, gpuPolicy: {}, installs, launch: {} }).runtimeId, "llama-server");
  assert.equal(selectRuntime({ probe: { gpuArch: "gfx1100" }, catalogEntry: entry, gpuPolicy: {}, installs, launch: {} }).runtimeId, "llama-server");
});
test("an unpinned YaRN launch falls back to llama-server (the 512k variant)", () => {
  const r = selectRuntime({ probe: GFX, catalogEntry: entry, gpuPolicy: {}, installs, launch: { extra_args: ["--rope-scaling", "yarn"] } });
  assert.equal(r.runtimeId, "llama-server");
  assert.match(r.reason, /YaRN/);
});
test("a pinned llama-server wins even when gufo would qualify", () => {
  assert.equal(selectRuntime({ probe: GFX, catalogEntry: entry, gpuPolicy: { runtimeId: "llama-server" }, installs, launch: {} }).runtimeId, "llama-server");
});
test("a pinned gufo that cannot serve refuses", () => {
  assert.throws(() => selectRuntime({ probe: GFX, catalogEntry: entry, gpuPolicy: { runtimeId: "gufo" }, installs, launch: { ctx: 524288 } }), (e) => e.code === "RUNTIME_UNSUPPORTED");
  assert.throws(() => selectRuntime({ probe: GFX, catalogEntry: entry, gpuPolicy: { runtimeId: "gufo" }, installs: {}, launch: {} }), (e) => e.code === "RUNTIME_NOT_INSTALLED");
});
```

```js
// tests/gpu-orchestrator-runtime.test.js
//
// Drives the real startNativeAndAwaitReady through acquireProvider's native
// branch with every process boundary stubbed: the provider map via opts.cfg,
// the binary via ensureRuntimeFn, state/installs/overrides via their seams,
// readiness via identityProbeFn, the spawn via startModelFn.
import { test } from "node:test";
import assert from "node:assert/strict";
import { acquireProvider, _setOwnInstanceIdForTest, _setReservationReaderForTest } from "../servers/gateway/gpu-orchestrator.js";

_setOwnInstanceIdForTest("me");
_setReservationReaderForTest(() => null);

const catalog = { models: [{ id: "qwen3.8-27b", task: "chat", context_len: 262144, serving: { class: "resident" },
  launch: { ctx: 262144, flash_attn: "on" }, runtimes: { gufo: { launch: { ctx: 262144, sessions: 1, speculative: "dflash2" } } } }] };
const state = {
  registry: { "qwen3.8-27b@UD-Q6_K_XL": { catalogId: "qwen3.8-27b", quant: "UD-Q6_K_XL", file: "m.gguf", path: "/w/m.gguf", sizeMb: 25000,
    runtimeAssets: { gufo: [{ kind: "dflash", path: "/w/d.gguf", verified: true }, { kind: "mmproj", path: "/w/p/p.gguf", verified: true }] } } },
  reservations: {}, conversions: {}, runtimeOverrides: {},
  runtimeInstalls: { gufo: { root: "/home/u/gufo-prod", bin: "current/gufo", image: "docker.io/nixos/nix:latest", nixVolume: "gufo-nix", videoGid: 44, renderGid: 992, version: "9abedf6" } },
};
function cfgWith(gpuPolicy) {
  return { providers: { "crow-local-27b": { baseUrl: "http://127.0.0.1:18110/v1", doorUrl: "http://d/llm/v1", models: [{ id: "qwen3.8-27b" }],
    gpuPolicy: { runtime: "native", owner: "me", catalogId: "qwen3.8-27b", quant: "UD-Q6_K_XL", port: 18110, ...gpuPolicy } } } };
}
function seams(extra = {}) {
  const calls = { started: null, removed: [] };
  return {
    calls,
    opts: {
      resolveDataDirFn: () => "/fake", loadStateFn: () => state, loadCatalogFn: () => catalog,
      getCachedProbeFn: () => ({ gpuArch: "gfx1151", accel: "vulkan" }), reprobeFn: async () => ({ gpuArch: "gfx1151", accel: "vulkan" }),
      existsSyncFn: () => true,
      ensureRuntimeFn: async () => "/opt/llama/llama-server",
      getRuntimeOverrideFn: () => null,
      getModelRuntimeOverrideFn: () => null,
      getRuntimeInstallFn: (_dir, id) => state.runtimeInstalls[id] || null,
      identityProbeFn: (() => { let n = 0; return async () => (n++ === 0 ? "down" : "resident"); })(),
      startModelFn: (o) => { calls.started = o; return { live: true, argv: o.prebuilt ? o.prebuilt.args : [], stop: async () => {}, touch() {}, status: () => ({}) }; },
      removeContainerFn: (name) => { calls.removed.push(name); },
      acquireHostLockFn: () => () => {},
      readinessTimeoutMs: 1000, readinessPollMs: 1, readinessInitialDelayMs: 0,
      ...extra,
    },
  };
}

test("a gfx1151 host with a gufo install starts the 27B through docker, after removing a leftover container", async () => {
  const { calls, opts } = seams();
  await acquireProvider("crow-local-27b", { ...opts, cfg: cfgWith({}) });
  assert.equal(calls.started.prebuilt.command, "docker");
  assert.deepEqual(calls.removed, ["crow-rt-crow-local-27b"]);
  const a = calls.started.prebuilt.args.join(" ");
  assert.ok(a.includes("--dflash-model /w/d.gguf"));
  assert.ok(a.includes("--mmproj /w/p/p.gguf"));
});

test("a provider gufo launch override (copilot ctx 65536) wins over the catalog gufo launch", async () => {
  const { calls, opts } = seams();
  await acquireProvider("crow-local-27b", { ...opts, cfg: cfgWith({ runtimeLaunch: { gufo: { ctx: 65536 } } }) });
  const a = calls.started.prebuilt.args;
  assert.equal(a[a.indexOf("--context") + 1], "65536");
});

test("a pinned llama-server row starts llama-server even on a gufo host", async () => {
  const { calls, opts } = seams();
  await acquireProvider("crow-local-27b", { ...opts, cfg: cfgWith({ runtimeId: "llama-server" }) });
  assert.equal(calls.started.prebuilt.command, "/opt/llama/llama-server");
  assert.deepEqual(calls.removed, []);
});

test("a pinned gufo that cannot serve refuses with RUNTIME_UNSUPPORTED before spawning", async () => {
  const { calls, opts } = seams();
  await assert.rejects(acquireProvider("crow-local-27b", { ...opts, cfg: cfgWith({ runtimeId: "gufo", launch: { extra_args: ["--rope-scaling", "yarn"] } }) }),
    (e) => e.code === "RUNTIME_UNSUPPORTED");
  assert.equal(calls.started, null);
});
```

- [ ] **Step 2: Run, expect FAIL.** `npm test -- tests/runtimes-select.test.js tests/gpu-orchestrator-runtime.test.js`

- [ ] **Step 3: Implement `selectRuntime`** in `runtimes/index.js`:

```js
export class RuntimeSelectError extends Error {
  constructor(message, code) { super(message); this.name = "RuntimeSelectError"; this.code = code; }
}

export function selectRuntime({ probe, catalogEntry, gpuPolicy = {}, installs = {}, launch = {} }) {
  const gufo = getRuntime("gufo");
  const pin = gpuPolicy?.runtimeId;
  if (pin === "llama-server") return { runtimeId: "llama-server", reason: "pinned by gpu_policy.runtimeId" };
  if (pin === "gufo") {
    if (!installs.gufo) throw new RuntimeSelectError("gpu_policy pins gufo but this host has no gufo install record (scripts/models-runtime-install.mjs set-gufo)", "RUNTIME_NOT_INSTALLED");
    const s = gufo.supports({ catalogEntry, launch, probe });
    if (!s.ok) throw new RuntimeSelectError(`gpu_policy pins gufo but it cannot serve this launch: ${s.reason}`, "RUNTIME_UNSUPPORTED");
    return { runtimeId: "gufo", reason: "pinned by gpu_policy.runtimeId" };
  }
  if (pin !== undefined && pin !== null) throw new RuntimeSelectError(`unknown gpu_policy.runtimeId "${pin}"`, "RUNTIME_UNSUPPORTED");
  if (!installs.gufo) return { runtimeId: "llama-server", reason: "no gufo install on this host" };
  const s = gufo.supports({ catalogEntry, launch, probe });
  return s.ok ? { runtimeId: "gufo", reason: "gfx1151 + catalog gufo block + install" } : { runtimeId: "llama-server", reason: s.reason };
}
```

`runtime.js` `startModel`: add `prebuilt = null,` to its parameters and replace the first line of the body with:

```js
  const command = prebuilt ? prebuilt.command : binPath;
  const args = prebuilt ? prebuilt.args : buildLlamaServerArgs({ ggufPath, alias, port, host, launch, extraArgs });
```

then pass `command` (not `binPath`) to `superviseProcess`.

`gpu-orchestrator.js` `startNativeAndAwaitReady`: add seams `getRuntimeInstallFn = getRuntimeInstall`, `removeContainerFn = defaultRemoveContainer`, `selectRuntimeFn = selectRuntime` to the destructured opts; define at module level:

```js
import { getRuntime, selectRuntime } from "./models/runtimes/index.js";
import { extraArgsFor } from "./models/runtimes/llama-server.js";
import { getRuntimeInstall } from "./models/runtime-installs.js";
import { validateGufoLaunch } from "./models/runtimes/gufo.js";

function defaultRemoveContainer(name) {
  try { execFileSync("docker", ["rm", "-f", name], { stdio: "ignore", timeout: 30_000 }); } catch { /* none left over */ }
}
```

(`execFileSync` from `node:child_process`; add it to the existing import if absent.) Replace the block from `// Schema v2 companion + task flags` down to the `startModelFn({ … })` call with:

```js
  const companions = [];
  for (const c of Array.isArray(regEntry.companions) ? regEntry.companions : []) {
    if (c && (c.path || c.file)) companions.push({ kind: c.kind, path: c.path || join(blobDir, c.file) });
  }
  const task = catalogEntry?.task === "embedding" ? "embedding" : catalogEntry?.task === "rerank" ? "rerank" : "chat";
  const gufoInstall = getRuntimeInstallFn(dir, "gufo");
  const pick = selectRuntimeFn({
    probe: hostProbe, catalogEntry, gpuPolicy: p.gpuPolicy || {}, installs: gufoInstall ? { gufo: gufoInstall } : {}, launch,
  });
  const runtime = getRuntime(pick.runtimeId);
  let built;
  if (pick.runtimeId === "gufo") {
    const gufoLaunch = mergeLaunch(catalogEntry?.runtimes?.gufo?.launch, p.gpuPolicy?.runtimeLaunch?.gufo);
    const errs = validateGufoLaunch(gufoLaunch, { contextLen: catalogEntry?.context_len, label: `${providerName} gufo launch` });
    if (errs.length) { const e = new Error(errs.join("; ")); e.code = "INVALID_LAUNCH"; throw e; }
    const gufoCompanions = (regEntry.runtimeAssets?.gufo || []).map((a) => ({ kind: a.kind, path: a.path }));
    built = runtime.buildCommand({ install: gufoInstall, ggufPath, alias, port, launch: gufoLaunch, companions: gufoCompanions, providerName });
    removeContainerFn(built.containerName);
  } else {
    built = runtime.buildCommand({ install: { bin: binPath }, ggufPath, alias, port, launch, companions, task });
  }
  // startModel still receives launch + extraArgs (its status snapshot and the
  // existing native-start tests read them); `prebuilt` is what it spawns.
  const extraArgs = pick.runtimeId === "gufo" ? [] : extraArgsFor({ companions, task });
  console.log(`[gpu-orchestrator] starting native ${providerName} runtime=${pick.runtimeId} (${pick.reason}) alias=${alias} port=${port} readinessTimeoutMs=${readinessTimeoutMs} requested-by=${opts.requester || "-"}`);
  const handle = startModelFn({ binPath, ggufPath, alias, port, launch, spawn: spawnFn, onTerminal: wrappedOnTerminal, extraArgs, prebuilt: built });
```

(`mergeLaunch` is generic over plain objects and merges the gufo knobs correctly; `extra_args` replaces, as for llama-server.) Delete the old `console.log("[gpu-orchestrator] starting native …")` line that this replaces. Keep the `argv` log line after it.

Note: the gufo path does not need `binPath`, but `acquireProvider` still resolves it before the single-flight (cheap when the release is installed); leave that unchanged so a llama-server fallback never waits on a download inside the critical section.

- [ ] **Step 4: Run, expect PASS**, plus every orchestrator test: `npm test -- tests/runtimes-select.test.js tests/gpu-orchestrator-runtime.test.js tests/gpu-orchestrator-native.test.js tests/models-runtime.test.js tests/models-host-profile.test.js` and `ls tests | grep gpu-orchestrator` (run them all).

- [ ] **Step 5: Commit.**

```bash
git add tests/runtimes-select.test.js tests/gpu-orchestrator-runtime.test.js
git commit servers/gateway/models/runtimes/index.js servers/gateway/models/runtimes/llama-server.js servers/gateway/models/runtime.js servers/gateway/gpu-orchestrator.js tests/runtimes-select.test.js tests/gpu-orchestrator-runtime.test.js -m "feat(models): select the runtime per start (gufo on gfx1151 when the catalog and an install allow), pinned refusals, stale container cleanup"
```

---

### Task 7: Per-model overrides know their runtime

Kevin 2026-10-02: the #385 override validates only a llama-server `--version`. A per-model override now carries `runtimeId`; a gufo override is an alternative build root validated by gufo's probe and used in place of the host install's root for that model.

**Files:**
- Modify: `servers/gateway/models/runtime-override.js` (`setModelRuntimeOverride`), `servers/gateway/gpu-orchestrator.js` (gufo branch reads the override), `scripts/models-runtime-override.mjs` (`--runtime gufo --root <abs>`)
- Test: add cases to `tests/models-runtime-override.test.js` and `tests/gpu-orchestrator-runtime.test.js`

**Interfaces:**
- Produces: `setModelRuntimeOverride(dir, catalogId, binOrRoot, { runtimeId = "llama-server", … })`; a gufo record is `{ runtimeId: "gufo", root, bin: "current/gufo", version, label, setAt }`; llama-server records keep today's shape plus `runtimeId: "llama-server"`. `resolveNativeBinPath` ignores records whose `runtimeId === "gufo"`; the orchestrator's gufo branch overlays `{ root, bin }` from a gufo record onto the host install.

- [ ] **Step 1: Add the failing tests.** In `tests/models-runtime-override.test.js`:

```js
test("a gufo per-model override is validated by gufo's probe and stored with runtimeId", () => {
  let st = { runtimeOverrides: {} };
  const rec = setModelRuntimeOverride("/d", "qwen3.8-27b", "/home/u/gufo-rebase4", {
    runtimeId: "gufo", loadStateFn: () => st, saveStateFn: (_d, s) => { st = s; },
    accessSyncImpl: () => {}, readFileImpl: () => "base=d61ca9d\n", now: () => new Date("2026-10-05T00:00:00Z"),
  });
  assert.equal(rec.runtimeId, "gufo");
  assert.equal(rec.root, "/home/u/gufo-rebase4");
  assert.equal(rec.version, "d61ca9d");
});

test("a llama-server override record now carries runtimeId", () => {
  let st = { runtimeOverrides: {} };
  const rec = setModelRuntimeOverride("/d", "qwen3.6-35b-a3b", "/opt/llama/llama-server", {
    loadStateFn: () => st, saveStateFn: (_d, s) => { st = s; },
    accessSyncImpl: () => {}, spawnSyncImpl: () => ({ status: 0, stdout: "", stderr: "version: 10068 (abc)\n" }),
  });
  assert.equal(rec.runtimeId, "llama-server");
  assert.equal(rec.bin, "/opt/llama/llama-server");
});
```

In `tests/gpu-orchestrator-runtime.test.js`:

```js
test("a gufo per-model override root replaces the host install root for that model", async () => {
  const rec = { runtimeId: "gufo", root: "/home/u/gufo-rebase4", bin: "current/gufo", version: "d61ca9d", source: "state" };
  const { calls, opts } = seams({ getModelRuntimeOverrideFn: (_dir, id) => (id === "qwen3.8-27b" ? rec : null) });
  await acquireProvider("crow-local-27b", { ...opts, cfg: cfgWith({}) });
  assert.ok(calls.started.prebuilt.args.join(" ").includes("-v /home/u/gufo-rebase4:/opt/gufo:ro"));
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement.** `setModelRuntimeOverride`:

```js
export function setModelRuntimeOverride(dir, catalogId, binOrRoot, opts = {}) {
  assertModelId(catalogId);
  const { runtimeId = "llama-server", label = null, loadStateFn = loadState, saveStateFn = saveState, now = () => new Date() } = opts;
  let record;
  if (runtimeId === "gufo") {
    if (typeof binOrRoot !== "string" || !isAbsolute(binOrRoot)) throw new RuntimeOverrideError(`gufo override root must be absolute, got ${JSON.stringify(binOrRoot)}`, "NOT_ABSOLUTE");
    const draft = { root: binOrRoot, bin: opts.bin || "current/gufo" };
    const version = gufoProbeVersion(draft, opts);
    record = { runtimeId: "gufo", ...draft, label, version, setAt: now().toISOString() };
  } else if (runtimeId === "llama-server") {
    const version = validateLlamaServerBinary(binOrRoot, opts);
    record = { runtimeId: "llama-server", bin: binOrRoot, label, version, setAt: now().toISOString() };
  } else {
    throw new RuntimeOverrideError(`unknown runtime "${runtimeId}"`, "BAD_RUNTIME");
  }
  const state = loadStateFn(dir);
  state.runtimeOverrides = { ...overridesOf(state), [catalogId]: record };
  saveStateFn(dir, state);
  return record;
}
```

with `import { probeVersion as gufoProbeVersion } from "./runtimes/gufo.js";` (gufo.js imports `RuntimeOverrideError` from this file; the cycle is safe because neither module uses the other's exports at load time — verify by running the test; if Node reports a TDZ error, move `RuntimeOverrideError` to a new `servers/gateway/models/runtime-errors.js` and re-export it from `runtime-override.js`).

`getModelRuntimeOverride` keeps returning a record when `rec.bin` is a string (both shapes have `bin`). Two existing assertions deep-equal a stored llama-server record and must gain the new field: in `tests/models-runtime-override.test.js` the test "per-model override: set, get, list, clear round-trip through state.json" and in `tests/models-runtime-override-cli.test.js` the test "cli: set --model, get --model, list, clear --model round-trip; set/clear print the data dir" — add `runtimeId: "llama-server"` to their expected objects. In `resolveNativeBinPath`, change the per-model branch condition to `if (perModel && typeof perModel.bin === "string" && perModel.runtimeId !== "gufo")`. In the orchestrator gufo branch, before `runtime.buildCommand`, overlay:

```js
    const perModel = (opts.getModelRuntimeOverrideFn || getModelRuntimeOverride)(dir, catalogId);
    const install = perModel?.runtimeId === "gufo" ? { ...gufoInstall, root: perModel.root, bin: perModel.bin || gufoInstall.bin } : gufoInstall;
```

and pass `install` instead of `gufoInstall`. CLI: in `scripts/models-runtime-override.mjs` `set`, accept `--runtime gufo --root <abs>` (and keep `--bin` for llama-server); pass `{ runtimeId, bin: values["gufo-bin"] }`; update its usage text and header comment.

- [ ] **Step 4: Run, expect PASS**, plus `npm test -- tests/models-runtime-override.test.js tests/models-runtime-override-cli.test.js tests/gpu-orchestrator-runtime.test.js`.

- [ ] **Step 5: Commit.**

```bash
git commit servers/gateway/models/runtime-override.js servers/gateway/gpu-orchestrator.js scripts/models-runtime-override.mjs tests/models-runtime-override.test.js tests/models-runtime-override-cli.test.js tests/gpu-orchestrator-runtime.test.js -m "feat(models): per-model runtime overrides carry runtimeId; gufo overrides swap the build root for one model"
```

---

### Task 8: JSON routes for the panel

Spec §6. Every route sits behind the existing `requireDashboardSessionJson` gate in `routes/models.js` and answers `{ error, code }` on failure, like its neighbours.

**Files:**
- Create: `servers/gateway/dashboard/panels/model-catalog-registered.js` (only `buildRegisteredRows` in this task; Task 10 adds rendering)
- Modify: `servers/gateway/routes/models.js`, `servers/gateway/models/manager.js` (extract `hfSyntheticCatalog` from `downloadHfFile`)
- Test: `tests/models-routes-registered.test.js`

**Interfaces:**
- Consumes: `registerModel`, `adoptModel`, `unregisterModel`, `listProvidersAll`, `nativeSnapshot`, `stopNativeProvider`, `maybeAcquireLocalProvider`, `getRuntimeInstall`/`setRuntimeInstall`/`clearRuntimeInstall`, `setModelRuntimeOverride`/`clearModelRuntimeOverride`/`listModelRuntimeOverrides`, `getRuntimeOverride`/`setRuntimeOverride`/`clearRuntimeOverride`, `isModelOrchestrationDisabled`, `getProviderHealth`, `fetchHfPathInfo`.
- Produces:
  - `buildRegisteredRows({ rows, snapshotOf, externalHealth, ownInstanceId }) -> Array<{ provider, model, catalogId, quant, kind: "native"|"external", status, argv, mutexGroup, alwaysResident, defaultMember, runtimeId, launch, runtimeLaunch, ownedHere, engineHost }>` (`status ∈ resident | stopped | external_up | external_down | foreign`)
  - `hfSyntheticCatalog({ hfRepo, file, sha256, sizeBytes }) -> catalog` (manager.js; `downloadHfFile` uses it)
  - Routes:
    - `GET /api/models/registered` → `{ rows, orchestrationDisabled, groups: string[], roles: string[] }` (`roles` = convertible row ids to suggest as provider ids)
    - `POST /api/models/register` `{ catalogId, quant, providerId, mutexGroup?, alwaysResident?, defaultMember?, launch?, runtimeId?, runtimeLaunch? }` → `{ provider }`; `400 INVALID_LAUNCH` with `errors[]`; `409 PROVIDER_ID_CONFLICT` / `EXTERNAL_ENGINE_CONFLICT`
    - `POST /api/models/adopt` `{ catalogId, quant, path, companionPaths?, runtimeAssetPaths?, allowUnverified?, providerId?, … }` → `{ provider, verified }`; `400 ADOPT_*`
    - `POST /api/models/hf-adopt` `{ hfRepo, file, path }` → `{ provider }` (sha from the Hugging Face tree API; refuses `NO_VERIFIABLE_CHECKSUM`)
    - `POST /api/models/providers/:provider/start|stop`, `DELETE /api/models/providers/:provider` (two-step `requiresConfirm` like `DELETE /api/models/:id`); start and stop answer `409 MODEL_ORCHESTRATION_DISABLED` when the host switch is on
    - `GET /api/models/runtimes` → `{ release, hostOverride, modelOverrides, installs }`; `POST /api/models/runtimes/override` `{ bin, model?, runtimeId? }`; `DELETE /api/models/runtimes/override?model=`; `POST /api/models/runtimes/gufo` `{ root, bin?, image?, nixVolume? }`; `DELETE /api/models/runtimes/gufo`. Validation failures answer `400` with the `RuntimeOverrideError` code (`NOT_ABSOLUTE`, `NOT_EXECUTABLE`, `VERSION_FAILED`).

- [ ] **Step 1: Write the failing test.** The pure helpers first, then the routes through the real `modelsRouter(dashboardAuth, opts)` with a real session (the `tests/models-panel.test.js` harness, copied below):

```js
// tests/models-routes-registered.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRegisteredRows } from "../servers/gateway/dashboard/panels/model-catalog-registered.js";
import { hfSyntheticCatalog } from "../servers/gateway/models/manager.js";

const rows = [
  { id: "crow-chat", disabled: false, models: [{ id: "qwen3.6-35b-a3b" }], baseUrl: "http://100.64.9.1:3001/llm/v1",
    gpuPolicy: { runtime: "native", owner: "me", catalogId: "qwen3.6-35b-a3b", quant: "UD-Q5_K_XL", port: 18102, mutexGroup: "crow-strix-vram", defaultMember: true, launch: { ctx: 131072 } } },
  { id: "crow-local-27b", disabled: false, models: [{ id: "qwen3.8-27b" }], baseUrl: "http://100.64.9.1:8006/v1", gpuPolicy: { engine: { managed: "external", host: "crow", label: "gufo" } } },
  { id: "r4-gemma", disabled: false, models: [{ id: "gemma" }], baseUrl: "http://100.64.9.1:3008/llm/v1", gpuPolicy: { runtime: "native", owner: "r4", port: 18120 } },
  { id: "qwen-cloud", disabled: false, models: [{ id: "x" }], baseUrl: "https://example.com/v1", gpuPolicy: null },
  { id: "old-native", disabled: true, models: [{ id: "o" }], baseUrl: "http://127.0.0.1:18100/v1", gpuPolicy: { runtime: "native" } },
];

test("buildRegisteredRows lists enabled native and external rows only, with status and ownership", () => {
  const out = buildRegisteredRows({
    rows, ownInstanceId: "me",
    snapshotOf: (n) => (n === "crow-chat" ? { live: true, argv: ["--model", "/m"] } : null),
    externalHealth: { "crow-local-27b": { ready: true } },
  });
  const by = Object.fromEntries(out.map((r) => [r.provider, r]));
  assert.deepEqual(Object.keys(by).sort(), ["crow-chat", "crow-local-27b", "r4-gemma"]);
  assert.equal(by["crow-chat"].status, "resident");
  assert.deepEqual(by["crow-chat"].argv, ["--model", "/m"]);
  assert.equal(by["crow-chat"].defaultMember, true);
  assert.deepEqual(by["crow-chat"].launch, { ctx: 131072 });
  assert.equal(by["crow-local-27b"].kind, "external");
  assert.equal(by["crow-local-27b"].status, "external_up");
  assert.equal(by["crow-local-27b"].engineHost, "crow");
  assert.equal(by["r4-gemma"].status, "foreign");
  assert.equal(by["r4-gemma"].ownedHere, false);
});

test("hfSyntheticCatalog matches the shape downloadHfFile has always built", () => {
  const c = hfSyntheticCatalog({ hfRepo: "org/Repo-GGUF", file: "Model-Q4_K_M.gguf", sha256: "a".repeat(64), sizeBytes: 2_000_000 });
  assert.equal(c.models.length, 1);
  assert.equal(c.models[0].hf_repo, "org/Repo-GGUF");
  assert.deepEqual(c.models[0].quants[0], { file: "Model-Q4_K_M.gguf", quant: "hf", sha256: "a".repeat(64), size_mb: 2, min_ram_mb: 2, min_vram_mb: 0 });
});
```

Then the route cases, in the same file:

```js
import express from "express";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import modelsRouter from "../servers/gateway/routes/models.js";
import { setProviderSyncManager } from "../servers/shared/providers-db.js";
import { InvalidLaunchError, AdoptMismatchError } from "../servers/gateway/models/manager.js";
import { RuntimeOverrideError } from "../servers/gateway/models/runtime-override.js";

function freshLibsql() {
  const dir = mkdtempSync(join(tmpdir(), "models-reg-routes-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: join(import.meta.dirname, "..") });
  const prev = process.env.CROW_DATA_DIR;
  process.env.CROW_DATA_DIR = dir;
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { dir, db, async cleanup() { setProviderSyncManager(null); if (prev === undefined) delete process.env.CROW_DATA_DIR; else process.env.CROW_DATA_DIR = prev; try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}
async function seedSession(db, token = "tok") {
  await db.execute({ sql: "INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES (?, 'access', 'dashboard', 'dashboard', ?)",
    args: [createHash("sha256").update(token).digest("hex"), new Date(Date.now() + 60_000).toISOString()] });
  return token;
}
const H = (token) => ({ "tailscale-user-login": "test@example.com", cookie: `crow_session=${token}`, "content-type": "application/json" });
async function withServer(opts, fn) {
  const app = express();
  app.use(express.json());
  app.use(modelsRouter((req, res, next) => next(), opts));
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}
const CATALOG = () => ({ version: 3, runtime: { release: "b10068", assets: {} }, models: [] });

test("POST /api/models/register passes roles through and maps INVALID_LAUNCH to 400", async () => {
  const h = freshLibsql();
  try {
    const token = await seedSession(h.db);
    const seen = [];
    const registerModelFn = async (o) => { seen.push(o); if (o.launch?.ctx === 1) throw new InvalidLaunchError(["launch: ctx must be an integer >= 1024"]); return { id: o.providerId }; };
    await withServer({ dir: h.dir, loadCatalogFn: CATALOG, registerModelFn }, async (base) => {
      const ok = await fetch(base + "/api/models/register", { method: "POST", headers: H(token),
        body: JSON.stringify({ catalogId: "qwen3.8-27b", quant: "UD-Q6_K_XL", providerId: "crow-local-27b-512k", mutexGroup: "crow-strix-vram", defaultMember: false, launch: { ctx: 262144 }, runtimeId: "llama-server" }) });
      assert.equal(ok.status, 200);
      assert.equal(seen[0].providerId, "crow-local-27b-512k");
      assert.equal(seen[0].mutexGroup, "crow-strix-vram");
      assert.deepEqual(seen[0].gpuPolicyExtra, { runtimeId: "llama-server" });
      const bad = await fetch(base + "/api/models/register", { method: "POST", headers: H(token), body: JSON.stringify({ catalogId: "x", quant: "q", launch: { ctx: 1 } }) });
      assert.equal(bad.status, 400);
      const j = await bad.json();
      assert.equal(j.code, "INVALID_LAUNCH");
      assert.equal(j.errors.length, 1);
    });
  } finally { await h.cleanup(); }
});

test("POST /api/models/adopt maps ADOPT_SIZE_MISMATCH to 400 with the message", async () => {
  const h = freshLibsql();
  try {
    const token = await seedSession(h.db);
    const adoptModelFn = async () => { throw new AdoptMismatchError("is 25924152384 bytes but the catalog says about 25299060000 bytes", "ADOPT_SIZE_MISMATCH"); };
    await withServer({ dir: h.dir, loadCatalogFn: CATALOG, adoptModelFn }, async (base) => {
      const r = await fetch(base + "/api/models/adopt", { method: "POST", headers: H(token), body: JSON.stringify({ catalogId: "qwen3.8-27b", quant: "UD-Q6_K_XL", path: "/w/m.gguf", allowUnverified: true }) });
      assert.equal(r.status, 400);
      const j = await r.json();
      assert.equal(j.code, "ADOPT_SIZE_MISMATCH");
      assert.match(j.error, /25924152384 bytes/);
    });
  } finally { await h.cleanup(); }
});

test("POST /api/models/providers/:p/start is 409 MODEL_ORCHESTRATION_DISABLED when the host switch is on", async () => {
  const h = freshLibsql();
  const prev = process.env.CROW_DISABLE_MODEL_ORCHESTRATION;
  try {
    const token = await seedSession(h.db);
    process.env.CROW_DISABLE_MODEL_ORCHESTRATION = "1";
    let called = false;
    await withServer({ dir: h.dir, loadCatalogFn: CATALOG, maybeAcquireLocalProviderFn: async () => { called = true; return true; } }, async (base) => {
      const r = await fetch(base + "/api/models/providers/crow-chat/start", { method: "POST", headers: H(token) });
      assert.equal(r.status, 409);
      assert.equal((await r.json()).code, "MODEL_ORCHESTRATION_DISABLED");
      assert.equal(called, false);
    });
  } finally {
    if (prev === undefined) delete process.env.CROW_DISABLE_MODEL_ORCHESTRATION; else process.env.CROW_DISABLE_MODEL_ORCHESTRATION = prev;
    await h.cleanup();
  }
});

test("DELETE /api/models/providers/:p asks for confirmation first, then unregisters", async () => {
  const h = freshLibsql();
  try {
    const token = await seedSession(h.db);
    const calls = [];
    await withServer({ dir: h.dir, loadCatalogFn: CATALOG, providerBindingsFn: async () => [{ kind: "bot", id: "b1" }],
      unregisterModelFn: async (o) => { calls.push(o.modelId); return { disabled: true, deleted: false }; }, getNativeHandleFn: () => null }, async (base) => {
      const first = await (await fetch(base + "/api/models/providers/crow-chat", { method: "DELETE", headers: H(token) })).json();
      assert.equal(first.requiresConfirm, true);
      assert.equal(first.bindings.length, 1);
      assert.deepEqual(calls, []);
      const second = await (await fetch(base + "/api/models/providers/crow-chat?confirm=true", { method: "DELETE", headers: H(token) })).json();
      assert.equal(second.deleted, true);
      assert.deepEqual(calls, ["crow-chat"]);
    });
  } finally { await h.cleanup(); }
});

test("POST /api/models/runtimes/gufo maps NOT_EXECUTABLE to 400", async () => {
  const h = freshLibsql();
  try {
    const token = await seedSession(h.db);
    const setRuntimeInstallFn = () => { throw new RuntimeOverrideError("gufo binary /gone/current/gufo is not executable", "NOT_EXECUTABLE"); };
    await withServer({ dir: h.dir, loadCatalogFn: CATALOG, setRuntimeInstallFn }, async (base) => {
      const r = await fetch(base + "/api/models/runtimes/gufo", { method: "POST", headers: H(token), body: JSON.stringify({ root: "/gone" }) });
      assert.equal(r.status, 400);
      assert.equal((await r.json()).code, "NOT_EXECUTABLE");
    });
  } finally { await h.cleanup(); }
});
```

- [ ] **Step 2: Run, expect FAIL.** `npm test -- tests/models-routes-registered.test.js`

- [ ] **Step 3: Implement.** `manager.js`: extract the catalog literal from `downloadHfFile` into

```js
export function hfSyntheticCatalog({ hfRepo, file, sha256, sizeBytes }) {
  const sizeMb = typeof sizeBytes === "number" ? sizeBytes / 1_000_000 : null;
  return {
    models: [{
      id: deriveModelIdFromFilename(file),
      family: hfRepo.split("/")[1] || hfRepo,
      hf_repo: hfRepo,
      task: "chat",
      context_len: null,
      default_quant: "hf",
      quants: [{ file, quant: "hf", sha256, size_mb: sizeMb, min_ram_mb: sizeMb, min_vram_mb: 0 }],
    }],
  };
}
```

and make `downloadHfFile` call it (`const catalog = hfSyntheticCatalog({ hfRepo, file, sha256, sizeBytes });`).

`model-catalog-registered.js`:

```js
/**
 * Model Catalog page — the registered-models section (spec §6). This module
 * owns the row model (shared by GET /api/models/registered and the server
 * render), the HTML, and the section's client script.
 */
import { isExternalEngine, externalEngineInfo } from "../../../shared/provider-engine.js";

export function buildRegisteredRows({ rows = [], snapshotOf = () => null, externalHealth = {}, ownInstanceId }) {
  const out = [];
  for (const r of rows) {
    if (r.disabled) continue;
    const gp = r.gpuPolicy || {};
    const model = (r.models || [])[0];
    const base = {
      provider: r.id, model: typeof model === "string" ? model : model?.id ?? null,
      catalogId: gp.catalogId ?? null, quant: gp.quant ?? null, mutexGroup: gp.mutexGroup ?? null,
      alwaysResident: !!gp.alwaysResident, defaultMember: !!gp.defaultMember, runtimeId: gp.runtimeId ?? null,
      launch: gp.launch ?? null, runtimeLaunch: gp.runtimeLaunch ?? null, argv: null, engineHost: null,
    };
    if (isExternalEngine(r)) {
      out.push({ ...base, kind: "external", ownedHere: false, engineHost: externalEngineInfo(r)?.host ?? null,
        status: externalHealth[r.id]?.ready ? "external_up" : "external_down" });
      continue;
    }
    if (gp.runtime !== "native") continue;
    const ownedHere = !gp.owner || gp.owner === ownInstanceId;
    if (!ownedHere) { out.push({ ...base, kind: "native", ownedHere, status: "foreign" }); continue; }
    const snap = snapshotOf(r.id);
    out.push({ ...base, kind: "native", ownedHere, status: snap?.live ? "resident" : "stopped", argv: snap?.argv ?? null });
  }
  return out.sort((a, b) => a.provider.localeCompare(b.provider));
}
```

`routes/models.js`: add the imports — `adoptModel`, `hfSyntheticCatalog` from `../models/manager.js`; `nativeSnapshot`, `stopNativeProvider` from `../gpu-orchestrator.js`; `getProviderHealth` from `../provider-health.js`; `getOrCreateLocalInstanceId` from `../instance-registry.js`; `setRuntimeInstall`, `clearRuntimeInstall`, `listRuntimeInstalls` from `../models/runtime-installs.js`; `getRuntimeOverride`, `setRuntimeOverride`, `clearRuntimeOverride`, `setModelRuntimeOverride`, `clearModelRuntimeOverride`, `listModelRuntimeOverrides` from `../models/runtime-override.js`; `buildRegisteredRows` from `../dashboard/panels/model-catalog-registered.js`; `doorKindOf` from `../models/door-resolve.js` — then add the seams to `modelsRouter`'s destructured `opts` (`registerModelFn` already exists; add `adoptModelFn = adoptModel`, `unregisterModelFn` already exists, `nativeSnapshotFn = nativeSnapshot`, `stopNativeProviderFn = stopNativeProvider`, `getProviderHealthFn = getProviderHealth`, `ownInstanceIdFn = getOrCreateLocalInstanceId`, `setRuntimeInstallFn = setRuntimeInstall`, `clearRuntimeInstallFn = clearRuntimeInstall`, `listRuntimeInstallsFn = listRuntimeInstalls`, `setModelRuntimeOverrideFn = setModelRuntimeOverride`, `clearModelRuntimeOverrideFn = clearModelRuntimeOverride`, `listModelRuntimeOverridesFn = listModelRuntimeOverrides`, `getRuntimeOverrideFn = getRuntimeOverride`, `setRuntimeOverrideFn = setRuntimeOverride`, `clearRuntimeOverrideFn = clearRuntimeOverride`), then the routes:

```js
  const ERR_STATUS = {
    INVALID_LAUNCH: 400, PROVIDER_ID_CONFLICT: 409, EXTERNAL_ENGINE_CONFLICT: 409,
    ADOPT_SHA_MISMATCH: 400, ADOPT_SIZE_MISMATCH: 400, ADOPT_FILE_MISSING: 400, ADOPT_PATH_NOT_ABSOLUTE: 400, ADOPT_UNKNOWN_ASSET: 400,
    NOT_ABSOLUTE: 400, NOT_EXECUTABLE: 400, VERSION_FAILED: 400, BAD_MODEL_ID: 400, BAD_RUNTIME: 400,
    UNKNOWN_MODEL: 400, UNKNOWN_QUANT: 400, NOT_OWNER: 409, external_engine: 409,
  };
  function sendErr(res, err) {
    const code = err?.code || "INTERNAL";
    res.status(ERR_STATUS[code] || 500).json({ error: err?.message || String(err), code, ...(Array.isArray(err?.errors) ? { errors: err.errors } : {}) });
  }

  router.get("/api/models/registered", async (req, res) => {
    const db = dbFactory();
    try {
      const all = await listProvidersAllFn(db);
      const rows = buildRegisteredRows({ rows: all, snapshotOf: nativeSnapshotFn, externalHealth: getProviderHealthFn().external || {}, ownInstanceId: ownInstanceIdFn() });
      const groups = [...new Set(all.map((r) => r.gpuPolicy?.mutexGroup).filter(Boolean))].sort();
      // Spec §6: role ids (crow-chat, crow-voice, crow-embed, …) are suggested
      // when a convertible row (a bundle row, or an unmanaged local row) exists.
      const roles = all.filter((r) => !r.disabled && r.gpuPolicy?.runtime !== "native" && !r.gpuPolicy?.engine
        // plan 2 rev 2: unmanaged rows are no longer split into local/cloud by address; a row on THIS host is.
        && (r.bundleId || (doorKindOf({ baseUrl: r.baseUrl, gpuPolicy: r.gpuPolicy }) === "unmanaged" && r.host === "local"))).map((r) => r.id).sort();
      res.json({ rows, groups, roles, orchestrationDisabled: isModelOrchestrationDisabled() });
    } catch (err) { sendErr(res, err); } finally { try { db.close(); } catch {} }
  });

  function roleOpts(b) {
    const o = {};
    if (typeof b.providerId === "string" && b.providerId) o.providerId = b.providerId;
    if (b.mutexGroup === null || typeof b.mutexGroup === "string") o.mutexGroup = b.mutexGroup || null;
    if (b.alwaysResident !== undefined) o.alwaysResident = !!b.alwaysResident;
    if (b.defaultMember !== undefined) o.defaultMember = !!b.defaultMember;
    if (b.launch && typeof b.launch === "object") o.launch = b.launch;
    const extra = {};
    if (b.runtimeId === "llama-server" || b.runtimeId === "gufo") extra.runtimeId = b.runtimeId;
    if (b.runtimeLaunch && typeof b.runtimeLaunch === "object") extra.runtimeLaunch = b.runtimeLaunch;
    if (Object.keys(extra).length) o.gpuPolicyExtra = extra;
    return o;
  }

  router.post("/api/models/register", async (req, res) => {
    const b = req.body || {};
    const db = dbFactory();
    try {
      const provider = await registerModelFn({ modelId: b.catalogId, quant: b.quant, catalog: loadCatalogFn(), db, dir: resolveDir(), ...roleOpts(b) });
      res.json({ provider });
    } catch (err) { sendErr(res, err); } finally { try { db.close(); } catch {} }
  });

  router.post("/api/models/adopt", async (req, res) => {
    const b = req.body || {};
    const db = dbFactory();
    try {
      const provider = await adoptModelFn({
        modelId: b.catalogId, quant: b.quant, path: b.path, companionPaths: b.companionPaths || {}, runtimeAssetPaths: b.runtimeAssetPaths || {},
        allowUnverified: b.allowUnverified === true, catalog: loadCatalogFn(), db, dir: resolveDir(), ...roleOpts(b),
      });
      res.json({ provider, verified: provider.verified !== false });
    } catch (err) { sendErr(res, err); } finally { try { db.close(); } catch {} }
  });

  router.post("/api/models/hf-adopt", async (req, res) => {
    const { hfRepo, file, path } = req.body || {};
    if (!isValidHfRepoId(hfRepo)) return res.status(400).json({ error: `Invalid Hugging Face repo id: ${JSON.stringify(hfRepo)}`, code: "INVALID_HF_REPO" });
    if (!isValidHfFilename(file)) return res.status(400).json({ error: `Invalid file name: ${JSON.stringify(file)}`, code: "INVALID_HF_FILE" });
    const db = dbFactory();
    try {
      const token = await getHfToken(db).catch(() => null);
      const info = await fetchHfPathInfoFn({ hfRepo, file, hfApiBase, hfToken: token });
      if (!info.sha256) return res.status(422).json({ error: "This file has no verifiable checksum (it isn't LFS-tracked) — refusing to adopt an unverifiable file.", code: "NO_VERIFIABLE_CHECKSUM" });
      const catalog = hfSyntheticCatalog({ hfRepo, file, sha256: info.sha256, sizeBytes: info.sizeBytes });
      // adoptModel merges this registryExtra UNDER its own path/adopted/verified fields, so the tag is safe.
      const provider = await adoptModelFn({ modelId: catalog.models[0].id, quant: "hf", path, catalog, db, dir: resolveDir(), registryExtra: { source: "hf-browser" } });
      res.json({ provider });
    } catch (err) { sendErr(res, err); } finally { try { db.close(); } catch {} }
  });

  router.post("/api/models/providers/:provider/:verb(start|stop)", async (req, res) => {
    const name = req.params.provider;
    if (isModelOrchestrationDisabled()) {
      return res.status(409).json({ error: "Model orchestration is disabled on this host (CROW_DISABLE_MODEL_ORCHESTRATION) — models here are started outside Crow", code: "MODEL_ORCHESTRATION_DISABLED" });
    }
    try {
      if (req.params.verb === "stop") return res.json(await stopNativeProviderFn(name, { requester: "models-panel" }));
      let startError = null;
      const result = await maybeAcquireLocalProviderFn(name, { requester: "models-panel", onError: (e) => { startError = e; } });
      if (result === true) return res.json({ running: true });
      if (result === false) {
        // Spec §8: the last 40 stderr lines ride along as the cause.
        const stderrTail = nativeSnapshotFn(name)?.stderrTail || [];
        return res.status(502).json({ error: "Model failed to become ready in time", code: "START_FAILED", cause: { code: startError?.code || "UNKNOWN", message: startError?.message || null, stderrTail } });
      }
      return res.status(409).json({ error: `${name} is not a locally-orchestratable native provider`, code: "NOT_NATIVE" });
    } catch (err) {
      if (err && err.code === "box_reserved") return res.status(409).json({ error: err.message, code: "BOX_RESERVED", owner: err.owner || null, expires_at: err.expires_at || null });
      if (err && err.code === "serving_class_refused") return res.status(409).json({ error: err.message, code: "SERVING_CLASS_REFUSED", serving_class: err.servingClass || null });
      sendErr(res, err);
    }
  });

  router.delete("/api/models/providers/:provider", async (req, res) => {
    const name = req.params.provider;
    const db = dbFactory();
    try {
      const bindings = await providerBindingsFn(db, name);
      if (!(req.query.confirm === "true" || req.body?.confirm === true)) return res.json({ requiresConfirm: true, provider: name, bindings });
      const result = await unregisterModelFn({ modelId: name, db, dir: resolveDir(), runtimeHandle: getNativeHandleFn(name) });
      res.json({ deleted: true, provider: name, disabled: result.disabled, fileDeleted: result.deleted, bindings });
    } catch (err) { sendErr(res, err); } finally { try { db.close(); } catch {} }
  });

  router.get("/api/models/runtimes", (req, res) => {
    try {
      const dir = resolveDir();
      const catalog = loadCatalogFn();
      res.json({
        release: catalog?.runtime?.release ?? null,
        hostOverride: getRuntimeOverrideFn(dir, { env: {} }),
        modelOverrides: listModelRuntimeOverridesFn(dir),
        installs: listRuntimeInstallsFn(dir),
        probe: getCachedProbeFn(),
      });
    } catch (err) { sendErr(res, err); }
  });

  router.post("/api/models/runtimes/override", (req, res) => {
    const { bin, root, model, runtimeId = "llama-server", label = null } = req.body || {};
    try {
      const dir = resolveDir();
      const rec = model
        ? setModelRuntimeOverrideFn(dir, model, runtimeId === "gufo" ? root : bin, { runtimeId, label })
        : setRuntimeOverrideFn(dir, { bin, label });
      res.json({ override: rec });
    } catch (err) { sendErr(res, err); }
  });

  router.delete("/api/models/runtimes/override", (req, res) => {
    try {
      const dir = resolveDir();
      const cleared = req.query.model ? clearModelRuntimeOverrideFn(dir, String(req.query.model)) : clearRuntimeOverrideFn(dir);
      res.json({ cleared });
    } catch (err) { sendErr(res, err); }
  });

  router.post("/api/models/runtimes/gufo", (req, res) => {
    const { root, bin, image, nixVolume } = req.body || {};
    try { res.json({ install: setRuntimeInstallFn(resolveDir(), "gufo", { root, bin, image, nixVolume }) }); } catch (err) { sendErr(res, err); }
  });

  router.delete("/api/models/runtimes/gufo", (req, res) => {
    try { res.json({ cleared: clearRuntimeInstallFn(resolveDir(), "gufo") }); } catch (err) { sendErr(res, err); }
  });
```

Register these routes **before** the existing `router.delete("/api/models/:id", …)` and `router.post("/api/models/:id/start", …)` so `/api/models/providers/…` and `/api/models/runtimes…` are not captured by the `:id` patterns. `getRuntimeOverride(dir, { env: {} })` passes an empty env so a GET never triggers the `CROW_LLAMA_SERVER_BIN` bootstrap write.

`registerModel` needs `gpuPolicyExtra`: in `manager.js` add `gpuPolicyExtra = {}` to its parameters and spread it into the `gpuPolicy` object it builds (after the computed fields, so `runtimeId`/`runtimeLaunch` land in the row); validate `gpuPolicyExtra.runtimeLaunch.gufo` with `validateGufoLaunch` against the model's `context_len` and throw `InvalidLaunchError` on errors, next to the existing `validateLaunch` check.

- [ ] **Step 4: Run, expect PASS**, plus `npm test -- tests/models-panel.test.js tests/models-registration.test.js tests/model-catalog-client-contract.test.js`.

- [ ] **Step 5: Commit.**

```bash
git add servers/gateway/dashboard/panels/model-catalog-registered.js tests/models-routes-registered.test.js
git commit servers/gateway/routes/models.js servers/gateway/models/manager.js servers/gateway/dashboard/panels/model-catalog-registered.js tests/models-routes-registered.test.js -m "feat(models): panel routes — registered list, register/edit, adopt (catalog + HF), provider start/stop/unregister, runtime overrides and gufo install"
```

---

### Task 9: Extensions — no model cards in Browse, one "Local models" card, retired chip

Spec §6, D5.

**Files:**
- Create: `servers/gateway/dashboard/panels/extensions/local-models-card.js`
- Modify: `servers/gateway/dashboard/panels/extensions/html.js`, `servers/gateway/dashboard/panels/extensions.js`, `servers/gateway/dashboard/shared/i18n.js`
- Test: `tests/extensions-local-models.test.js`

**Interfaces:**
- Produces: `renderLocalModelsCard({ registered, resident }, lang) -> html`; `buildExtensionsHTML({ …, localModels = null })`; i18n keys `extensions.localModelsName` ("Local models" / "Modelos locales"), `extensions.localModelsDesc` ("Download, adopt and run models from the Model Catalog." / "Descarga, adopta y ejecuta modelos desde el Catálogo de modelos."), `extensions.localModelsCount` ("{registered} registered · {resident} running" / "{registered} registrados · {resident} en ejecución"), `extensions.localModelsOpen` ("Open Model Catalog" / "Abrir el Catálogo de modelos"), `extensions.retiredBadge` ("retired" / "retirado"), `extensions.retiredHint` ("This extension is no longer in the registry. Remove it to clean up." / "Esta extensión ya no está en el registro. Quítala para limpiar.").

- [ ] **Step 1: Write the failing test.**

```js
// tests/extensions-local-models.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildExtensionsHTML } from "../servers/gateway/dashboard/panels/extensions/html.js";
import { renderLocalModelsCard } from "../servers/gateway/dashboard/panels/extensions/local-models-card.js";

const available = [
  { id: "llamacpp-vulkan-qwen36-35b-a3b", name: "Qwen 35B", category: "ai", inference: true, type: "bundle", description: "m" },
  { id: "ollama", name: "Ollama", category: "ai", type: "bundle", description: "o" },
  { id: "kokoro-tts", name: "Kokoro", category: "ai", type: "bundle", description: "k" },
];
const base = { available, collections: [], registrySource: "local", communityStores: [], bundleStatus: {}, lang: "en" };

test("Browse shows no inference cards but keeps non-model AI bundles", () => {
  const { viewsHtml } = buildExtensionsHTML({ ...base, installed: {}, localModels: { registered: 3, resident: 1 } });
  const browse = viewsHtml.split('id="ext-view-installed"')[0];
  assert.equal(browse.includes('data-addon-id="llamacpp-vulkan-qwen36-35b-a3b"'), false);
  assert.ok(browse.includes('data-addon-id="ollama"'));
  assert.ok(browse.includes('data-addon-id="kokoro-tts"'));
});

test("the Local models card links to the Model Catalog with counts", () => {
  const { viewsHtml } = buildExtensionsHTML({ ...base, installed: {}, localModels: { registered: 3, resident: 1 } });
  assert.ok(viewsHtml.includes('href="/dashboard/model-catalog"'));
  assert.ok(viewsHtml.includes("3 registered · 1 running"));
  const html = renderLocalModelsCard({ registered: 0, resident: 0 }, "es");
  assert.ok(html.includes("Modelos locales"));
});

test("an installed inference bundle still appears under Installed (grackle manages its own)", () => {
  const { viewsHtml } = buildExtensionsHTML({ ...base, installed: { "llamacpp-vulkan-qwen36-35b-a3b": { version: "1" } }, localModels: null });
  const installedView = viewsHtml.split('id="ext-view-installed"')[1];
  assert.ok(installedView.includes('data-addon-id="llamacpp-vulkan-qwen36-35b-a3b"'));
});

test("an installed id missing from the registry renders a retired chip with Remove", () => {
  const { viewsHtml } = buildExtensionsHTML({ ...base, installed: { "vllm-rocm-qwen35-4b-old": { version: "0.1" } }, localModels: null });
  const item = viewsHtml.split('data-addon-id="vllm-rocm-qwen35-4b-old"')[1];
  assert.ok(item.includes("retired"));
  assert.ok(item.includes("bundle-uninstall"));
});
```

- [ ] **Step 2: Run, expect FAIL.** `npm test -- tests/extensions-local-models.test.js`

- [ ] **Step 3: Implement.**

```js
// servers/gateway/dashboard/panels/extensions/local-models-card.js
/**
 * The single "Local models" card that replaces every model bundle card in
 * the Extensions Browse view (spec §6, D5). Models are installed from the
 * Model Catalog page, not from here.
 */
import { escapeHtml } from "../../shared/components.js";
import { t, fill } from "../../shared/i18n.js";

export function renderLocalModelsCard({ registered = 0, resident = 0 } = {}, lang) {
  return `<div class="ext-card addon-card ext-card--local-models" data-addon-id="local-models" data-addon-group="ai" data-addon-category="ai" data-addon-name="${escapeHtml(t("extensions.localModelsName", lang).toLowerCase())}" data-addon-desc="" data-addon-tags="models">
      <div class="ext-card__body">
        <div class="ext-card__name">${escapeHtml(t("extensions.localModelsName", lang))}</div>
        <p class="ext-card__desc">${escapeHtml(t("extensions.localModelsDesc", lang))}</p>
        <div class="ext-card__meta"><span class="ext-card__badge ext-card__badge--type">${escapeHtml(fill(t("extensions.localModelsCount", lang), { registered, resident }))}</span></div>
      </div>
      <div class="ext-card__footer"><a class="btn btn-sm btn-primary" href="/dashboard/model-catalog">${escapeHtml(t("extensions.localModelsOpen", lang))}</a></div>
    </div>`;
}
```

In `html.js`: add `localModels = null` to the destructured parameters and `import { renderLocalModelsCard } from "./local-models-card.js";`. Right after the parameter list, define `const browseable = available.filter((a) => a.inference !== true);` and use `browseable` instead of `available` in the Featured filter and in `groupAddons(…)` (leave the `available.length === 0` emptiness check and the installed view's `available.find(...)` on `available`). In the group-section map, for the group whose id is the AI group (`groupForCategory("ai")`), prepend the card when `localModels` is non-null:

```js
      const lead = localModels && g.id === groupForCategory("ai") ? renderLocalModelsCard(localModels, lang) : "";
      …<div class="ext-grid">${lead}${addons.map((a, i) => addonCard(a, i, i >= GROUP_SHOWN)).join("")}</div>
```

If the AI group would otherwise be empty (every AI add-on was an inference bundle), make sure `grouped` still yields it: after `const grouped = groupAddons(browseable);` add `if (localModels && !grouped.has(groupForCategory("ai"))) grouped.set(groupForCategory("ai"), []);` (place the AI group's position per `DISPLAY_GROUPS`, which the existing `.filter((g) => grouped.has(g.id))` already respects).

In the installed list, after `const registryEntry = available.find((a) => a.id === id);`:

```js
      const retired = !registryEntry && registrySource !== "none";
      const retiredBadge = retired
        ? `<span class="ext-installed__retired" title="${escapeHtml(t("extensions.retiredHint", lang))}">${badge(t("extensions.retiredBadge", lang), "draft")}</span>`
        : "";
```

render `${retiredBadge}` next to `${statusBadge}`, and when `retired` set `actions` to only the existing `bundle-uninstall` button (no start/stop/configure for something the registry no longer describes).

In `extensions.js`, compute the counts and pass them:

```js
import { loadState } from "../../models/state.js";
import { resolveDataDir } from "../../../db.js";
import { getStatusSnapshot } from "../../models/runtime.js";
…
    let localModels = null;
    try {
      const st = loadState(resolveDataDir());
      localModels = { registered: Object.keys(st.registry || {}).length, resident: getStatusSnapshot().filter((s) => s.live).length };
    } catch { localModels = { registered: 0, resident: 0 }; }
```

Add the six i18n keys with the en/es values listed in Interfaces.

- [ ] **Step 4: Run, expect PASS**, plus `npm test -- tests/i18n-global-parity.test.js` and every `tests/extensions*.test.js`.

- [ ] **Step 5: Commit.**

```bash
git add servers/gateway/dashboard/panels/extensions/local-models-card.js tests/extensions-local-models.test.js
git commit servers/gateway/dashboard/panels/extensions/local-models-card.js servers/gateway/dashboard/panels/extensions/html.js servers/gateway/dashboard/panels/extensions.js servers/gateway/dashboard/shared/i18n.js tests/extensions-local-models.test.js -m "feat(extensions): models leave the Browse view for one Local models card; retired installs get a chip and Remove"
```

---

### Task 10: Model Catalog — registered models section

**Files:**
- Modify: `servers/gateway/dashboard/panels/model-catalog-registered.js` (render + client script), `servers/gateway/dashboard/panels/model-catalog.js` (handler includes the section; curated cards hide Start/Stop under the host switch), `servers/gateway/dashboard/shared/i18n.js`
- Test: `tests/models-panel-registered.test.js`

**Interfaces:**
- Consumes: `buildRegisteredRows` (Task 8), routes (Task 8).
- Produces: `renderRegisteredSection(rows, { orchestrationDisabled }, lang) -> html`; `registeredClientJS(lang) -> "<script>…</script>"`; data hooks `data-reg-action="start|stop|edit|unregister"` and `data-provider`; the edit action calls `window.CrowModelDialog.open({ mode: "edit", row })` (Task 11). i18n keys under `models.reg*`: `regHeading` ("Registered models" / "Modelos registrados"), `regEmpty` ("No local models registered yet." / "Aún no hay modelos locales registrados."), `regProvider` ("Provider" / "Proveedor"), `regModel` ("Model" / "Modelo"), `regStatus` ("Status" / "Estado"), `regGroup` ("Group" / "Grupo"), `regRuntime` ("Runtime" / "Runtime"), `regArgv` ("Command line" / "Línea de comandos"), `regEdit` ("Edit" / "Editar"), `regUnregister` ("Unregister" / "Quitar registro"), `regConfirmUnregister` ("Unregister {provider}? Bots and profiles using it: {n}." / "¿Quitar el registro de {provider}? Bots y perfiles que lo usan: {n}."), `regStatusResident` ("running" / "en ejecución"), `regStatusStopped` ("stopped" / "detenido"), `regStatusExternalUp` ("external · up" / "externo · activo"), `regStatusExternalDown` ("external · down" / "externo · caído"), `regStatusForeign` ("on another instance" / "en otra instancia"), `regRestartToApply` ("Running — restart to apply changes." / "En ejecución: reinicia para aplicar los cambios."), `regOrchestrationOff` ("Model orchestration is off on this host; models here are started outside Crow." / "La orquestación de modelos está desactivada en este equipo; los modelos se inician fuera de Crow.").

- [ ] **Step 1: Write the failing test** (server render + the client script executed against a minimal DOM, the pattern `tests/model-catalog-client-contract.test.js` uses; read it and reuse its DOM shim):

```js
// tests/models-panel-registered.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderRegisteredSection, registeredClientJS } from "../servers/gateway/dashboard/panels/model-catalog-registered.js";

const rows = [
  { provider: "crow-chat", model: "qwen3.6-35b-a3b", quant: "UD-Q5_K_XL", kind: "native", status: "resident", argv: ["--model", "/m.gguf", "-c", "131072"], mutexGroup: "crow-strix-vram", runtimeId: null, ownedHere: true },
  { provider: "crow-embed", model: "qwen3-embedding-0.6b", quant: "Q8_0", kind: "native", status: "stopped", argv: null, mutexGroup: null, runtimeId: null, ownedHere: true },
  { provider: "crow-local-27b", model: "qwen3.8-27b", kind: "external", status: "external_up", engineHost: "crow", ownedHere: false },
  { provider: "r4-gemma", model: "gemma", kind: "native", status: "foreign", ownedHere: false },
];

test("rows render with status, argv, and only the actions each row allows", () => {
  const html = renderRegisteredSection(rows, { orchestrationDisabled: false }, "en");
  const chat = html.split('data-provider="crow-chat"')[1].split("</tr>")[0];
  assert.ok(chat.includes("running"));
  assert.ok(chat.includes("--model /m.gguf -c 131072"));
  assert.ok(chat.includes('data-reg-action="stop"'));
  assert.ok(!chat.includes('data-reg-action="start"'));
  const embed = html.split('data-provider="crow-embed"')[1].split("</tr>")[0];
  assert.ok(embed.includes('data-reg-action="start"'));
  const ext = html.split('data-provider="crow-local-27b"')[1].split("</tr>")[0];
  assert.ok(!/data-reg-action="(start|stop|edit|unregister)"/.test(ext), "external rows are read-only");
  const foreign = html.split('data-provider="r4-gemma"')[1].split("</tr>")[0];
  assert.ok(!/data-reg-action="(start|stop)"/.test(foreign));
});

test("no start/stop when orchestration is disabled; a notice explains why", () => {
  const html = renderRegisteredSection(rows, { orchestrationDisabled: true }, "en");
  assert.ok(!/data-reg-action="(start|stop)"/.test(html));
  assert.ok(html.includes("Model orchestration is off on this host"));
});

test("es strings", () => {
  assert.ok(renderRegisteredSection([], { orchestrationDisabled: false }, "es").includes("Aún no hay modelos locales registrados."));
});

test("client script: no backticks, no innerHTML, posts to the provider routes", () => {
  const js = registeredClientJS("en");
  assert.equal(js.includes("`"), false);
  assert.equal(/\.innerHTML\s*=/.test(js), false);
  assert.ok(js.includes("/api/models/providers/"));
});
```

And one case that executes the script (the linkedom + `node:vm` pattern of `tests/model-catalog-client-contract.test.js`):

```js
import vm from "node:vm";
import { parseHTML } from "linkedom";

function bootRegistered(html, respond = () => ({ ok: true, json: () => Promise.resolve({}) })) {
  const { window, document } = parseHTML(`<html><body>${html}</body></html>`);
  const calls = [];
  window.confirm = () => true;
  const ctx = vm.createContext({ window, document, console, location: { reload() {} },
    fetch: (url, init) => { calls.push({ url: String(url), method: init && init.method }); return Promise.resolve(respond(String(url))); } });
  const js = registeredClientJS("en");
  vm.runInContext(js.slice(js.indexOf("<script>") + 8, js.lastIndexOf("</script>")), ctx);
  return { window, document, calls };
}

test("clicking Start posts to the provider route; Unregister asks the server first, then confirms", async () => {
  const { window, document, calls } = bootRegistered(renderRegisteredSection(rows, { orchestrationDisabled: false }, "en"),
    (url) => ({ ok: true, json: () => Promise.resolve(url.endsWith("/crow-embed") ? { requiresConfirm: true, bindings: [] } : {}) }));
  const click = (el) => el.dispatchEvent(new window.Event("click", { bubbles: true }));
  click(document.querySelector('[data-reg-action="start"][data-provider="crow-embed"]'));
  assert.deepEqual(calls[0], { url: "/api/models/providers/crow-embed/start", method: "POST" });
  click(document.querySelector('[data-reg-action="unregister"][data-provider="crow-embed"]'));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls.slice(1).map((c) => c.url), ["/api/models/providers/crow-embed", "/api/models/providers/crow-embed?confirm=true"]);
});
```

- [ ] **Step 2: Run, expect FAIL.** `npm test -- tests/models-panel-registered.test.js`

- [ ] **Step 3: Implement** (append to `model-catalog-registered.js`):

```js
import { escapeHtml } from "../shared/components.js";
import { t, tJs, fill } from "../shared/i18n.js";

const STATUS_KEY = {
  resident: "models.regStatusResident", stopped: "models.regStatusStopped",
  external_up: "models.regStatusExternalUp", external_down: "models.regStatusExternalDown", foreign: "models.regStatusForeign",
};

function actionsFor(r, orchestrationDisabled, lang) {
  if (r.kind === "external" || !r.ownedHere) return "";
  const btn = (action, key, variant) =>
    `<button type="button" class="btn btn-sm btn-${variant}" data-reg-action="${action}" data-provider="${escapeHtml(r.provider)}">${escapeHtml(t(key, lang))}</button>`;
  const parts = [];
  if (!orchestrationDisabled) parts.push(r.status === "resident" ? btn("stop", "models.actionStop", "secondary") : btn("start", "models.actionStart", "primary"));
  parts.push(btn("edit", "models.regEdit", "secondary"), btn("unregister", "models.regUnregister", "danger"));
  return parts.join("");
}

export function renderRegisteredSection(rows, { orchestrationDisabled = false } = {}, lang) {
  const notice = orchestrationDisabled ? `<div class="mcat-card__notice">${escapeHtml(t("models.regOrchestrationOff", lang))}</div>` : "";
  if (!rows.length) {
    return `<section class="mcat-registered" id="mcat-registered"><h3>${escapeHtml(t("models.regHeading", lang))}</h3>${notice}<p class="mcat-empty">${escapeHtml(t("models.regEmpty", lang))}</p></section>`;
  }
  const body = rows.map((r) => {
    const argv = Array.isArray(r.argv) ? r.argv.join(" ") : "";
    const restart = r.status === "resident" ? `<div class="mcat-reg__hint" hidden data-restart-hint="${escapeHtml(r.provider)}">${escapeHtml(t("models.regRestartToApply", lang))}</div>` : "";
    return `<tr data-provider="${escapeHtml(r.provider)}" data-row="${escapeHtml(JSON.stringify(r))}">
        <td>${escapeHtml(r.provider)}</td>
        <td>${escapeHtml(r.model || "")}${r.quant ? " · " + escapeHtml(r.quant) : ""}</td>
        <td class="mcat-reg__status" data-status="${escapeHtml(r.status)}">${escapeHtml(t(STATUS_KEY[r.status] || "models.regStatusStopped", lang))}</td>
        <td>${escapeHtml(r.mutexGroup || "—")}</td>
        <td>${escapeHtml(r.runtimeId || (r.kind === "external" ? "external" : "auto"))}</td>
        <td><code class="mcat-reg__argv">${escapeHtml(argv)}</code>${restart}</td>
        <td class="mcat-reg__actions">${actionsFor(r, orchestrationDisabled, lang)}</td>
      </tr>`;
  }).join("");
  return `<section class="mcat-registered" id="mcat-registered">
      <h3>${escapeHtml(t("models.regHeading", lang))}</h3>${notice}
      <table class="mcat-reg"><thead><tr>
        <th>${escapeHtml(t("models.regProvider", lang))}</th><th>${escapeHtml(t("models.regModel", lang))}</th><th>${escapeHtml(t("models.regStatus", lang))}</th>
        <th>${escapeHtml(t("models.regGroup", lang))}</th><th>${escapeHtml(t("models.regRuntime", lang))}</th><th>${escapeHtml(t("models.regArgv", lang))}</th><th></th>
      </tr></thead><tbody>${body}</tbody></table>
      <div class="mcat-reg__msg" id="mcat-reg-msg" role="status"></div>
    </section>`;
}

export function registeredClientJS(lang) {
  return `<script>
    (function () {
      var root = document.getElementById("mcat-registered");
      if (!root) return;
      var msg = document.getElementById("mcat-reg-msg");
      var CONFIRM = '${tJs("models.regConfirmUnregister", lang)}';
      function say(text) { if (msg) msg.textContent = text; }
      function call(method, path, body) {
        return fetch(path, { method: method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined })
          .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, data: d }; }); });
      }
      root.addEventListener("click", function (e) {
        var b = e.target.closest ? e.target.closest("[data-reg-action]") : null;
        if (!b) return;
        var action = b.getAttribute("data-reg-action");
        var provider = b.getAttribute("data-provider");
        var base = "/api/models/providers/" + encodeURIComponent(provider);
        if (action === "edit") {
          var tr = b.closest("tr");
          var row = tr ? JSON.parse(tr.getAttribute("data-row") || "{}") : {};
          if (window.CrowModelDialog) window.CrowModelDialog.open({ mode: "edit", row: row });
          return;
        }
        if (action === "start" || action === "stop") {
          b.disabled = true;
          call("POST", base + "/" + action).then(function (r) {
            if (r.ok) { location.reload(); return; }
            b.disabled = false;
            say((r.data && r.data.error) || action + " failed");
          });
          return;
        }
        if (action === "unregister") {
          call("DELETE", base).then(function (r) {
            if (!r.ok) { say((r.data && r.data.error) || "failed"); return; }
            var n = (r.data.bindings && r.data.bindings.length) || 0;
            if (!window.confirm(CONFIRM.replace("{provider}", provider).replace("{n}", String(n)))) return;
            call("DELETE", base + "?confirm=true").then(function (r2) {
              if (r2.ok) location.reload(); else say((r2.data && r2.data.error) || "failed");
            });
          });
        }
      });
    })();
  </script>`;
}
```

In `model-catalog.js` `handler`: load rows with `buildRegisteredRows({ rows: await listProvidersAll(db), snapshotOf: nativeSnapshot, externalHealth: getProviderHealth().external || {}, ownInstanceId: getOrCreateLocalInstanceId() })` inside a try/catch (on error, render the section with `[]`), and insert `${renderRegisteredSection(rows, { orchestrationDisabled: isModelOrchestrationDisabled() }, lang)}` above `${tabsHtml}` and `${registeredClientJS(lang)}` after `${modelCatalogClientJS(lang)}`. In `renderModelCard`, the 09-24 minor: when `isModelOrchestrationDisabled()` is true, drop the Start and Stop buttons from `actionHtml` (keep Remove and Download) and show the `models.regOrchestrationOff` notice instead; pass the flag in through `loadPanelData`'s returned `data.orchestrationDisabled` (read it there once) so `renderModelCard` stays pure. Add the i18n keys listed in Interfaces. Add CSS for `.mcat-reg` (table, monospace argv with `word-break: break-all`) to `panelStyles()`.

- [ ] **Step 4: Run, expect PASS**, plus `npm test -- tests/models-panel.test.js tests/models-panel-ui.test.js tests/model-catalog-client-contract.test.js tests/i18n-global-parity.test.js`.

- [ ] **Step 5: Commit.**

```bash
git add tests/models-panel-registered.test.js
git commit servers/gateway/dashboard/panels/model-catalog-registered.js servers/gateway/dashboard/panels/model-catalog.js servers/gateway/dashboard/shared/i18n.js tests/models-panel-registered.test.js -m "feat(models-panel): registered models list with status/argv/start/stop/unregister; no start/stop under the orchestration switch"
```

---

### Task 11: Registration dialog and adopt-from-disk

Spec §6: provider id (default model id; role ids suggested when such a bundle row exists), mutex group, always-resident, launch knobs pre-filled from the catalog; adopt with a path, size-only option labelled unverified; the same dialog for edit and for HF adopt.

**Files:**
- Create: `servers/gateway/dashboard/panels/model-catalog-dialog.js`
- Modify: `servers/gateway/dashboard/panels/model-catalog.js` (curated cards get `data-action="adopt"` and, when downloaded, `data-action="register"`; HF result rows get an Adopt button through a `data-hf-adopt` hook rendered server-side in `renderHfTab`'s help text area and handled by the dialog script), `servers/gateway/dashboard/shared/i18n.js`
- Test: `tests/models-panel-dialog-client.test.js`

**Interfaces:**
- Consumes: `/api/models/register`, `/api/models/adopt`, `/api/models/hf-adopt`, `/api/models/registered` (for the group list), the curated catalog JSON already embedded by the page (`loadPanelData`'s models; add `data-launch` and `data-gufo-assets` attributes to each curated card so the dialog can pre-fill without another fetch).
- Produces: `dialogClientJS(lang)`, defining `window.CrowModelDialog = { open(opts) }` with `opts.mode ∈ "register" | "adopt" | "edit" | "hf-adopt"`; i18n keys `models.dlg*`: `dlgTitleRegister` ("Register model" / "Registrar modelo"), `dlgTitleAdopt` ("Adopt from disk" / "Adoptar desde el disco"), `dlgTitleEdit` ("Edit registration" / "Editar registro"), `dlgProviderId` ("Provider id" / "Id del proveedor"), `dlgGroup` ("Mutex group" / "Grupo de exclusión"), `dlgGroupNone` ("none" / "ninguno"), `dlgAlwaysResident` ("Always resident" / "Siempre residente"), `dlgDefaultMember` ("Default member of its group" / "Miembro predeterminado de su grupo"), `dlgRuntime` ("Runtime" / "Runtime"), `dlgRuntimeAuto` ("auto" / "automático"), `dlgLaunch` ("Launch settings (JSON)" / "Ajustes de arranque (JSON)"), `dlgPath` ("Weights file (absolute path)" / "Archivo de pesos (ruta absoluta)"), `dlgMmprojPath` ("Vision projector (optional)" / "Proyector de visión (opcional)"), `dlgDflashPath` ("gufo draft model (optional)" / "Modelo borrador de gufo (opcional)"), `dlgGufoMmprojPath` ("gufo vision projector (optional)" / "Proyector de visión de gufo (opcional)"), `dlgUnverified` ("Accept a size match without hashing (marked unverified)" / "Aceptar coincidencia de tamaño sin hash (marcado como no verificado)"), `dlgSave` ("Save" / "Guardar"), `dlgCancel` ("Cancel" / "Cancelar"), `dlgBadJson` ("Launch settings are not valid JSON." / "Los ajustes de arranque no son JSON válido."), `actionAdopt` ("Adopt from disk" / "Adoptar desde el disco"), `actionRegister` ("Register as…" / "Registrar como…").

- [ ] **Step 1: Write the failing test** (linkedom + `node:vm`, executed like `tests/model-catalog-client-contract.test.js`):

```js
// tests/models-panel-dialog-client.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { parseHTML } from "linkedom";
import { dialogClientJS } from "../servers/gateway/dashboard/panels/model-catalog-dialog.js";

const JS = dialogClientJS("en");

test("dialog script: template-literal safe, DOM-built", () => {
  assert.equal(JS.includes("`"), false);
  assert.equal(/\.innerHTML\s*=/.test(JS), false);
  assert.ok(JS.includes("window.CrowModelDialog"));
});

function boot(respond) {
  const { window, document } = parseHTML('<html><body><div id="mcat-modal-overlay"><div id="mcat-modal-content"></div></div></body></html>');
  const calls = [];
  const ctx = vm.createContext({ window, document, console, location: { reload() {} },
    fetch: (url, init) => {
      calls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
      const r = respond ? respond(String(url)) : { ok: true, json: () => Promise.resolve({ groups: ["crow-strix-vram"] }) };
      return Promise.resolve(r);
    } });
  vm.runInContext(JS.slice(JS.indexOf("<script>") + 8, JS.lastIndexOf("</script>")), ctx);
  const content = document.getElementById("mcat-modal-content");
  const submit = () => content.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };
  return { window, document, calls, content, submit, flush };
}

test("adopt mode posts the path, the catalog launch and only the filled gufo asset", async () => {
  const b = boot();
  await b.flush();
  b.window.CrowModelDialog.open({ mode: "adopt", model: { id: "qwen3.8-27b", quants: [{ quant: "UD-Q6_K_XL" }], launch: { ctx: 262144 }, gufoAssets: ["dflash", "mmproj"] } });
  const inputs = [...b.content.querySelectorAll('input[type="text"]')];
  assert.equal(b.content.querySelector("textarea").value, '{"ctx":262144}');
  const path = inputs.find((i) => i.getAttribute("placeholder") === "/home/…/model.gguf");
  path.value = "/home/kh0pp/llm/hf-cache/qwen38-27b/Qwen3.8-27B-UD-Q6_K_XL.gguf";
  const dflash = inputs[inputs.indexOf(path) + 2];
  dflash.value = "/home/kh0pp/llm/hf-cache/qwen38-27b/Qwen3.8-27B-DFlash2-Q4_K_M.gguf";
  b.submit();
  const post = b.calls.find((c) => c.url === "/api/models/adopt");
  assert.deepEqual(post.body, {
    catalogId: "qwen3.8-27b", quant: "UD-Q6_K_XL", providerId: "qwen3.8-27b", mutexGroup: null, alwaysResident: false, defaultMember: false,
    launch: { ctx: 262144 }, path: "/home/kh0pp/llm/hf-cache/qwen38-27b/Qwen3.8-27B-UD-Q6_K_XL.gguf", allowUnverified: false, companionPaths: {},
    runtimeAssetPaths: { gufo: { dflash: "/home/kh0pp/llm/hf-cache/qwen38-27b/Qwen3.8-27B-DFlash2-Q4_K_M.gguf" } },
  });
});

test("a 400 shows the server code and message and keeps the dialog open", async () => {
  const b = boot((url) => url === "/api/models/adopt"
    ? { ok: false, json: () => Promise.resolve({ code: "ADOPT_SIZE_MISMATCH", error: "is 2 bytes but the catalog says about 1 bytes" }) }
    : { ok: true, json: () => Promise.resolve({ groups: [] }) });
  await b.flush();
  b.window.CrowModelDialog.open({ mode: "adopt", model: { id: "m", quants: [{ quant: "Q" }] } });
  b.content.querySelector('input[type="text"][placeholder="/home/…/model.gguf"]').value = "/w/m.gguf";
  b.submit();
  await b.flush();
  assert.match(b.content.querySelector(".mcat-dlg__error").textContent, /^ADOPT_SIZE_MISMATCH: is 2 bytes/);
  assert.equal(b.document.getElementById("mcat-modal-overlay").style.display, "flex");
});

test("edit mode locks the provider id and registers under it", async () => {
  const b = boot();
  await b.flush();
  b.window.CrowModelDialog.open({ mode: "edit", row: { provider: "crow-chat", model: "qwen3.6-35b-a3b", catalogId: "qwen3.6-35b-a3b", quant: "UD-Q5_K_XL", mutexGroup: "crow-strix-vram", defaultMember: true, launch: { ctx: 131072 } } });
  assert.equal(b.content.querySelector('input[type="text"]').disabled, true);
  b.submit();
  const post = b.calls.find((c) => c.url === "/api/models/register");
  assert.equal(post.body.providerId, "crow-chat");
  assert.equal(post.body.mutexGroup, "crow-strix-vram");
  assert.equal(post.body.defaultMember, true);
  assert.deepEqual(post.body.launch, { ctx: 131072 });
});

test("invalid launch JSON shows the message and sends nothing", async () => {
  const b = boot();
  await b.flush();
  const before = b.calls.length;
  b.window.CrowModelDialog.open({ mode: "register", model: { id: "m", quants: [{ quant: "Q" }] } });
  b.content.querySelector("textarea").value = "{nope";
  b.submit();
  assert.equal(b.content.querySelector(".mcat-dlg__error").textContent, "Launch settings are not valid JSON.");
  assert.equal(b.calls.length, before);
});
```

The edit test relies on the group `<select>` containing `crow-strix-vram`: the script loads groups once at boot (`fetch("/api/models/registered")`), which is why each test flushes before opening.

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement** `model-catalog-dialog.js`:

```js
/**
 * Registration / adopt / edit dialog for the Model Catalog page (spec §6).
 * One modal, four modes. Built with createElement only (panel client JS is
 * emitted inside a template literal). Server validation is the authority:
 * every error code and message from the routes is shown verbatim.
 */
import { tJs } from "../shared/i18n.js";

export function dialogClientJS(lang) {
  const S = {
    titleRegister: tJs("models.dlgTitleRegister", lang), titleAdopt: tJs("models.dlgTitleAdopt", lang), titleEdit: tJs("models.dlgTitleEdit", lang),
    providerId: tJs("models.dlgProviderId", lang), group: tJs("models.dlgGroup", lang), groupNone: tJs("models.dlgGroupNone", lang),
    alwaysResident: tJs("models.dlgAlwaysResident", lang), defaultMember: tJs("models.dlgDefaultMember", lang),
    runtime: tJs("models.dlgRuntime", lang), runtimeAuto: tJs("models.dlgRuntimeAuto", lang), launch: tJs("models.dlgLaunch", lang),
    path: tJs("models.dlgPath", lang), mmproj: tJs("models.dlgMmprojPath", lang), dflash: tJs("models.dlgDflashPath", lang),
    gufoMmproj: tJs("models.dlgGufoMmprojPath", lang), unverified: tJs("models.dlgUnverified", lang),
    save: tJs("models.dlgSave", lang), cancel: tJs("models.dlgCancel", lang), badJson: tJs("models.dlgBadJson", lang),
  };
  return `<script>
    (function () {
      var S = {
        titleRegister: '${S.titleRegister}', titleAdopt: '${S.titleAdopt}', titleEdit: '${S.titleEdit}',
        providerId: '${S.providerId}', group: '${S.group}', groupNone: '${S.groupNone}',
        alwaysResident: '${S.alwaysResident}', defaultMember: '${S.defaultMember}',
        runtime: '${S.runtime}', runtimeAuto: '${S.runtimeAuto}', launch: '${S.launch}',
        path: '${S.path}', mmproj: '${S.mmproj}', dflash: '${S.dflash}', gufoMmproj: '${S.gufoMmproj}',
        unverified: '${S.unverified}', save: '${S.save}', cancel: '${S.cancel}', badJson: '${S.badJson}'
      };
      var groups = [];
      var roles = [];
      fetch("/api/models/registered").then(function (r) { return r.json(); }).then(function (d) { groups = (d && d.groups) || []; roles = (d && d.roles) || []; }).catch(function () {});

      function el(tag, attrs, text) {
        var n = document.createElement(tag);
        if (attrs) Object.keys(attrs).forEach(function (k) { if (attrs[k] !== null && attrs[k] !== undefined) n.setAttribute(k, attrs[k]); });
        if (text !== undefined) n.textContent = text;
        return n;
      }
      function field(form, label, input) {
        var wrap = el("label", { "class": "mcat-dlg__field" });
        wrap.appendChild(el("span", null, label));
        wrap.appendChild(input);
        form.appendChild(wrap);
        return input;
      }

      function open(opts) {
        var mode = opts.mode;
        var row = opts.row || {};
        var model = opts.model || {};
        var catalogId = row.catalogId || model.id || "";
        var quant = row.quant || (model.quants && model.quants[0] && model.quants[0].quant) || "";
        var overlay = document.getElementById("mcat-modal-overlay");
        var content = document.getElementById("mcat-modal-content");
        while (content.firstChild) content.removeChild(content.firstChild);
        var title = mode === "edit" ? S.titleEdit : (mode === "register" ? S.titleRegister : S.titleAdopt);
        content.appendChild(el("h3", null, title + " — " + (catalogId || opts.hfFile || "")));
        var form = el("form", { "class": "mcat-dlg" });
        content.appendChild(form);

        var quantSel = null;
        if (mode !== "edit" && mode !== "hf-adopt" && model.quants && model.quants.length > 1) {
          quantSel = el("select");
          model.quants.forEach(function (q) { quantSel.appendChild(el("option", { value: q.quant }, q.quant)); });
          field(form, "Quant", quantSel);
        }
        var pid = field(form, S.providerId, el("input", { type: "text", value: row.provider || catalogId || "", list: "mcat-dlg-roles" }));
        if (mode === "edit") pid.disabled = true;
        var dl = el("datalist", { id: "mcat-dlg-roles" });
        roles.forEach(function (r) { dl.appendChild(el("option", { value: r })); });
        form.appendChild(dl);

        var grp = el("select");
        grp.appendChild(el("option", { value: "" }, S.groupNone));
        groups.forEach(function (g) { var o = el("option", { value: g }, g); if (g === row.mutexGroup) o.selected = true; grp.appendChild(o); });
        field(form, S.group, grp);
        var ar = el("input", { type: "checkbox" }); ar.checked = !!row.alwaysResident; field(form, S.alwaysResident, ar);
        var dm = el("input", { type: "checkbox" }); dm.checked = !!row.defaultMember; field(form, S.defaultMember, dm);
        var rt = el("select");
        [["", S.runtimeAuto], ["llama-server", "llama-server"], ["gufo", "gufo"]].forEach(function (p) {
          var o = el("option", { value: p[0] }, p[1]); if ((row.runtimeId || "") === p[0]) o.selected = true; rt.appendChild(o);
        });
        field(form, S.runtime, rt);
        var launch = el("textarea", { rows: "4" });
        launch.value = JSON.stringify(row.launch || model.launch || {});
        field(form, S.launch, launch);

        var pathIn = null, mmIn = null, dfIn = null, gmIn = null, unv = null;
        if (mode === "adopt" || mode === "hf-adopt") {
          pathIn = field(form, S.path, el("input", { type: "text", placeholder: "/home/…/model.gguf" }));
          if (mode === "adopt") {
            mmIn = field(form, S.mmproj, el("input", { type: "text" }));
            if ((model.gufoAssets || []).indexOf("dflash") >= 0) dfIn = field(form, S.dflash, el("input", { type: "text" }));
            if ((model.gufoAssets || []).indexOf("mmproj") >= 0) gmIn = field(form, S.gufoMmproj, el("input", { type: "text" }));
            unv = el("input", { type: "checkbox" }); field(form, S.unverified, unv);
          }
        }

        var err = el("div", { "class": "mcat-dlg__error", role: "alert" });
        form.appendChild(err);
        var actions = el("div", { "class": "mcat-dlg__actions" });
        var cancel = el("button", { type: "button", "class": "btn btn-sm btn-secondary" }, S.cancel);
        var save = el("button", { type: "submit", "class": "btn btn-sm btn-primary" }, S.save);
        actions.appendChild(cancel); actions.appendChild(save); form.appendChild(actions);
        cancel.addEventListener("click", function () { overlay.style.display = "none"; });

        form.addEventListener("submit", function (e) {
          e.preventDefault();
          err.textContent = "";
          var launchObj;
          try { launchObj = launch.value.trim() ? JSON.parse(launch.value) : {}; } catch (x) { err.textContent = S.badJson; return; }
          var body = {
            catalogId: catalogId, quant: quantSel ? quantSel.value : quant, providerId: pid.value.trim() || catalogId,
            mutexGroup: grp.value || null, alwaysResident: ar.checked, defaultMember: dm.checked, launch: launchObj,
          };
          if (rt.value) body.runtimeId = rt.value;
          var url = "/api/models/register";
          if (mode === "adopt") {
            url = "/api/models/adopt";
            body.path = pathIn.value.trim();
            body.allowUnverified = !!(unv && unv.checked);
            body.companionPaths = {};
            if (mmIn && mmIn.value.trim()) body.companionPaths.mmproj = mmIn.value.trim();
            body.runtimeAssetPaths = {};
            var g = {};
            if (dfIn && dfIn.value.trim()) g.dflash = dfIn.value.trim();
            if (gmIn && gmIn.value.trim()) g.mmproj = gmIn.value.trim();
            if (Object.keys(g).length) body.runtimeAssetPaths.gufo = g;
          } else if (mode === "hf-adopt") {
            url = "/api/models/hf-adopt";
            body = { hfRepo: opts.hfRepo, file: opts.hfFile, path: pathIn.value.trim() };
          }
          save.disabled = true;
          fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
            .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, data: d }; }); })
            .then(function (r) {
              save.disabled = false;
              if (r.ok) { overlay.style.display = "none"; location.reload(); return; }
              var d = r.data || {};
              err.textContent = (d.code ? d.code + ": " : "") + (d.error || "failed") + (d.errors ? " — " + d.errors.join("; ") : "");
            });
        });
        overlay.style.display = "flex";
      }

      window.CrowModelDialog = { open: open };

      document.addEventListener("click", function (e) {
        var b = e.target.closest ? e.target.closest("[data-action='adopt'],[data-action='register'],[data-hf-adopt]") : null;
        if (!b) return;
        if (b.hasAttribute("data-hf-adopt")) {
          open({ mode: "hf-adopt", hfRepo: b.getAttribute("data-hf-repo"), hfFile: b.getAttribute("data-hf-file") });
          return;
        }
        var card = b.closest(".mcat-card");
        if (!card) return;
        var model = {
          id: card.getAttribute("data-model-id"),
          quants: JSON.parse(card.getAttribute("data-quants") || "[]"),
          launch: JSON.parse(card.getAttribute("data-launch") || "null"),
          gufoAssets: JSON.parse(card.getAttribute("data-gufo-assets") || "[]")
        };
        open({ mode: b.getAttribute("data-action"), model: model });
      });
    })();
  </script>`;
}
```

In `model-catalog.js` `renderModelCard`: add `data-quants="${escapeHtml(JSON.stringify(model.quants.map((q) => ({ quant: q.quant }))))}"`, `data-launch="${escapeHtml(JSON.stringify(model.launch || null))}"` and `data-gufo-assets="${escapeHtml(JSON.stringify((model.runtimes?.gufo?.assets || []).map((a) => a.kind)))}"` on the root `mcat-card` div (`loadPanelData` must pass `launch` and `runtimes` through on each model; add them where it maps catalog models); add an Adopt button (`data-action="adopt"`, label `models.actionAdopt`) next to Download when the model is not registered, and a Register button (`data-action="register"`, label `models.actionRegister`) next to Start when it is. In the HF results renderer inside `modelCatalogClientJS` (`renderHfResults`), add per result a second button built with createElement: `data-hf-adopt="1"`, `data-hf-repo`, `data-hf-file`, text `'${tJs("models.actionAdopt", lang)}'`. Include `${dialogClientJS(lang)}` in the handler after `${modelCatalogClientJS(lang)}` (the dialog reuses the existing `#mcat-modal-overlay`). Add the i18n keys.

- [ ] **Step 4: Run, expect PASS**, plus `npm test -- tests/model-catalog-client-contract.test.js tests/models-panel-ui.test.js tests/i18n-global-parity.test.js`.

- [ ] **Step 5: Commit.**

```bash
git add servers/gateway/dashboard/panels/model-catalog-dialog.js tests/models-panel-dialog-client.test.js
git commit servers/gateway/dashboard/panels/model-catalog-dialog.js servers/gateway/dashboard/panels/model-catalog.js servers/gateway/dashboard/shared/i18n.js tests/models-panel-dialog-client.test.js -m "feat(models-panel): registration/adopt/edit dialog (roles, group, residency, runtime pin, launch JSON; gufo assets; HF adopt)"
```

---

### Task 12: Runtime card

Spec §6 runtime card + §3.4 ("min_runtime_version gate skipped with a visible warning") + §11.2 (gufo install).

**Files:**
- Create: `servers/gateway/dashboard/panels/model-catalog-runtime-card.js`
- Modify: `servers/gateway/dashboard/panels/model-catalog.js` (render it in place of the old runtime strip's binary line; keep the strip's live-model list), `servers/gateway/dashboard/shared/i18n.js`
- Test: `tests/models-panel-runtime-card.test.js`

**Interfaces:**
- Consumes: `GET /api/models/runtimes` shape (Task 8) — the server render calls the same functions directly.
- Produces: `buildRuntimeCardData({ catalog, hostOverride, modelOverrides, installs, probe }) -> { release, asset, hostOverride, modelOverrides: Array<{ model, runtimeId, bin, root, version, belowMin: boolean }>, gufo: { install, eligible: boolean, reason } }`; `renderRuntimeCard(data, lang)`; `runtimeCardClientJS(lang)`; i18n `models.rt*`: `rtHeading` ("Runtimes" / "Runtimes"), `rtRelease` ("llama-server release: {release}" / "Versión de llama-server: {release}"), `rtHostOverride` ("Host override: {bin} ({version})" / "Sustitución del equipo: {bin} ({version})"), `rtNoOverride` ("Using the catalog release." / "Usando la versión del catálogo."), `rtUseRelease` ("Use catalog release" / "Usar la versión del catálogo"), `rtSetOverride` ("Set override" / "Fijar sustitución"), `rtBinPath` ("llama-server path (absolute)" / "Ruta de llama-server (absoluta)"), `rtModelOverrides` ("Per-model overrides" / "Sustituciones por modelo"), `rtBelowMin` ("Override skips the min_runtime_version check ({min})." / "La sustitución omite la comprobación de min_runtime_version ({min})."), `rtGufo` ("gufo (Strix Halo)" / "gufo (Strix Halo)"), `rtGufoInstalled` ("Installed: {root} ({version})" / "Instalado: {root} ({version})"), `rtGufoNone` ("Not installed on this host." / "No instalado en este equipo."), `rtGufoNotEligible` ("Not available here: {reason}" / "No disponible aquí: {reason}"), `rtGufoRoot` ("gufo build root (absolute)" / "Raíz de la compilación de gufo (absoluta)"), `rtGufoSet` ("Record gufo install" / "Registrar instalación de gufo"), `rtGufoClear` ("Remove gufo install" / "Quitar instalación de gufo").

- [ ] **Step 1: Write the failing test.**

```js
// tests/models-panel-runtime-card.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRuntimeCardData, renderRuntimeCard, runtimeCardClientJS } from "../servers/gateway/dashboard/panels/model-catalog-runtime-card.js";

const catalog = { runtime: { release: "b10068" }, models: [{ id: "qwen3.6-35b-a3b", min_runtime_version: "b10068" }] };

test("an override shows its version and the min_runtime_version warning", () => {
  const d = buildRuntimeCardData({
    catalog, probe: { gpuArch: "gfx1151" },
    hostOverride: { bin: "/opt/llama/llama-server", version: "b9000", source: "state" },
    modelOverrides: { "qwen3.6-35b-a3b": { runtimeId: "llama-server", bin: "/opt/mtp/llama-server", version: "0.2.0-dev (build 405, commit b21e4de74)" } },
    installs: {},
  });
  assert.equal(d.release, "b10068");
  assert.equal(d.modelOverrides[0].belowMin, true, "a non-release override always carries the skip warning");
  const html = renderRuntimeCard(d, "en");
  assert.ok(html.includes("/opt/llama/llama-server (b9000)"));
  assert.ok(html.includes("Override skips the min_runtime_version check (b10068)."));
  assert.ok(html.includes("Use catalog release"));
});

test("gufo section: installed, not installed, not eligible", () => {
  const inst = buildRuntimeCardData({ catalog, probe: { gpuArch: "gfx1151" }, hostOverride: null, modelOverrides: {}, installs: { gufo: { root: "/home/u/gufo-prod", version: "9abedf6" } } });
  assert.ok(renderRuntimeCard(inst, "en").includes("Installed: /home/u/gufo-prod (9abedf6)"));
  const none = buildRuntimeCardData({ catalog, probe: { gpuArch: "gfx1151" }, hostOverride: null, modelOverrides: {}, installs: {} });
  assert.ok(renderRuntimeCard(none, "en").includes("Record gufo install"));
  const other = buildRuntimeCardData({ catalog, probe: { gpuArch: "gfx1100" }, hostOverride: null, modelOverrides: {}, installs: {} });
  assert.equal(other.gufo.eligible, false);
  assert.ok(renderRuntimeCard(other, "en").includes("Not available here"));
  assert.ok(!renderRuntimeCard(other, "en").includes("Record gufo install"));
});

test("client script is template-literal safe and posts to the runtime routes", () => {
  const js = runtimeCardClientJS("en");
  assert.equal(js.includes("`"), false);
  assert.equal(/\.innerHTML\s*=/.test(js), false);
  assert.ok(js.includes("/api/models/runtimes/override") && js.includes("/api/models/runtimes/gufo"));
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement.**

```js
// servers/gateway/dashboard/panels/model-catalog-runtime-card.js
/**
 * Runtime card (spec §6, §3.4, §11.2): the catalog llama-server release, the
 * host and per-model overrides (with the min_runtime_version skip warning —
 * an override bypasses ensureRuntime and therefore the version gate), and
 * the gufo install record on gfx1151 hosts.
 */
import { escapeHtml } from "../shared/components.js";
import { t, tJs, fill } from "../shared/i18n.js";

export function buildRuntimeCardData({ catalog, hostOverride, modelOverrides = {}, installs = {}, probe }) {
  const release = catalog?.runtime?.release ?? null;
  const mins = new Map((catalog?.models || []).map((m) => [m.id, m.min_runtime_version || null]));
  return {
    release,
    hostOverride: hostOverride || null,
    modelOverrides: Object.entries(modelOverrides).map(([model, r]) => ({
      model, runtimeId: r.runtimeId || "llama-server", bin: r.bin || null, root: r.root || null, version: r.version || null,
      min: mins.get(model) || release, belowMin: (r.runtimeId || "llama-server") === "llama-server" && r.version !== release,
    })),
    gufo: {
      install: installs.gufo || null,
      eligible: probe?.gpuArch === "gfx1151",
      reason: probe?.gpuArch === "gfx1151" ? null : `gpu ${probe?.gpuArch || "unknown"} is not gfx1151`,
    },
  };
}

export function renderRuntimeCard(d, lang) {
  const host = d.hostOverride
    ? `<p>${escapeHtml(fill(t("models.rtHostOverride", lang), { bin: d.hostOverride.bin, version: d.hostOverride.version || "?" }))}</p>
       <p class="mcat-card__notice">${escapeHtml(fill(t("models.rtBelowMin", lang), { min: d.release || "?" }))}</p>
       <button type="button" class="btn btn-sm btn-secondary" data-rt-action="clear-host">${escapeHtml(t("models.rtUseRelease", lang))}</button>`
    : `<p>${escapeHtml(t("models.rtNoOverride", lang))}</p>`;
  const setHost = `<div class="mcat-rt__set"><input type="text" id="mcat-rt-bin" placeholder="${escapeHtml(t("models.rtBinPath", lang))}"><button type="button" class="btn btn-sm btn-primary" data-rt-action="set-host">${escapeHtml(t("models.rtSetOverride", lang))}</button></div>`;
  const per = d.modelOverrides.length
    ? `<h4>${escapeHtml(t("models.rtModelOverrides", lang))}</h4><ul>${d.modelOverrides.map((o) =>
        `<li><code>${escapeHtml(o.model)}</code> · ${escapeHtml(o.runtimeId)} · ${escapeHtml(o.bin || o.root || "")} (${escapeHtml(o.version || "?")})${o.belowMin ? ` <span class="mcat-card__notice">${escapeHtml(fill(t("models.rtBelowMin", lang), { min: o.min || "?" }))}</span>` : ""} <button type="button" class="btn btn-sm btn-secondary" data-rt-action="clear-model" data-model="${escapeHtml(o.model)}">${escapeHtml(t("models.rtUseRelease", lang))}</button></li>`).join("")}</ul>`
    : "";
  let gufo;
  if (!d.gufo.eligible) gufo = `<p>${escapeHtml(fill(t("models.rtGufoNotEligible", lang), { reason: d.gufo.reason || "" }))}</p>`;
  else if (d.gufo.install) gufo = `<p>${escapeHtml(fill(t("models.rtGufoInstalled", lang), { root: d.gufo.install.root, version: d.gufo.install.version || "?" }))}</p><button type="button" class="btn btn-sm btn-secondary" data-rt-action="clear-gufo">${escapeHtml(t("models.rtGufoClear", lang))}</button>`;
  else gufo = `<p>${escapeHtml(t("models.rtGufoNone", lang))}</p><div class="mcat-rt__set"><input type="text" id="mcat-rt-gufo-root" placeholder="${escapeHtml(t("models.rtGufoRoot", lang))}"><button type="button" class="btn btn-sm btn-primary" data-rt-action="set-gufo">${escapeHtml(t("models.rtGufoSet", lang))}</button></div>`;
  return `<section class="mcat-runtime-card" id="mcat-runtime-card">
      <h3>${escapeHtml(t("models.rtHeading", lang))}</h3>
      <p>${escapeHtml(fill(t("models.rtRelease", lang), { release: d.release || "?" }))}</p>
      ${host}${setHost}${per}
      <h4>${escapeHtml(t("models.rtGufo", lang))}</h4>${gufo}
      <div class="mcat-reg__msg" id="mcat-rt-msg" role="status"></div>
    </section>`;
}

export function runtimeCardClientJS(lang) {
  return `<script>
    (function () {
      var root = document.getElementById("mcat-runtime-card");
      if (!root) return;
      var msg = document.getElementById("mcat-rt-msg");
      function send(method, path, body) {
        return fetch(path, { method: method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined })
          .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) {
            if (r.ok) { location.reload(); return; }
            msg.textContent = (d.code ? d.code + ": " : "") + (d.error || "failed");
          }); });
      }
      root.addEventListener("click", function (e) {
        var b = e.target.closest ? e.target.closest("[data-rt-action]") : null;
        if (!b) return;
        var a = b.getAttribute("data-rt-action");
        if (a === "clear-host") send("DELETE", "/api/models/runtimes/override");
        else if (a === "clear-model") send("DELETE", "/api/models/runtimes/override?model=" + encodeURIComponent(b.getAttribute("data-model")));
        else if (a === "set-host") send("POST", "/api/models/runtimes/override", { bin: document.getElementById("mcat-rt-bin").value.trim() });
        else if (a === "set-gufo") send("POST", "/api/models/runtimes/gufo", { root: document.getElementById("mcat-rt-gufo-root").value.trim() });
        else if (a === "clear-gufo") send("DELETE", "/api/models/runtimes/gufo");
      });
    })();
  </script>`;
}
```

(`tJs` is imported for parity with the other client modules; drop the import if the linter flags it unused.) In `model-catalog.js`'s handler, build the data from `getRuntimeOverride(dir, { env: {} })`, `listModelRuntimeOverrides(dir)`, `listRuntimeInstalls(dir)`, `getCachedProbe()` and the loaded catalog, render `${renderRuntimeCard(data, lang)}` right after `${renderRuntimeStrip(data, lang)}`, and append `${runtimeCardClientJS(lang)}`. Add the i18n keys.

- [ ] **Step 4: Run, expect PASS**, plus `npm test -- tests/models-panel.test.js tests/i18n-global-parity.test.js`.

- [ ] **Step 5: Commit.**

```bash
git add servers/gateway/dashboard/panels/model-catalog-runtime-card.js tests/models-panel-runtime-card.test.js
git commit servers/gateway/dashboard/panels/model-catalog-runtime-card.js servers/gateway/dashboard/panels/model-catalog.js servers/gateway/dashboard/shared/i18n.js tests/models-panel-runtime-card.test.js -m "feat(models-panel): runtime card — release, host/per-model overrides with the version-gate warning, gufo install"
```

---

### Task 13: Docs, full suite, PR

**Files:**
- Modify: `docs/architecture/models.md`, `docs/guide/` page for the Model Catalog if one exists (`ls docs/guide | grep -i model`)

- [ ] **Step 1: Extend `docs/architecture/models.md`:** a *Runtimes* section (the module interface table from spec §11.2, the selection rule, the container launch shape and why only gufo may use it, install records and the CLI `scripts/models-runtime-install.mjs`, per-model overrides with `runtimeId`, the `crow-rt-<provider>` container name and the stale-container cleanup); a *Panels* section (Extensions Local models card, retired chip, registered list, dialog modes, runtime card, the orchestration-switch behavior).
- [ ] **Step 2:** `cd docs && npm run build`.
- [ ] **Step 3: Full suite + static checks:** `npm test`; `npm run validate-model-catalog`; `node scripts/check-port-allocation.js`; `node scripts/build-registry.mjs --check`. All green; record the count.
- [ ] **Step 4: Commit, rebase, push, PR** (github MCP; no `gh` on crow):

```bash
git commit docs/architecture/models.md -m "docs(models): runtimes (llama-server, gufo) and the models panels"
git pull --rebase origin main && git push -u origin feat/models-runtimes-panels
```

PR title: `feat: models runtimes (gufo on gfx1151) + Model Catalog/Extensions panels (arc plan 3/4)`. Body: the task list; "no gufo install is recorded by this PR, so no host changes runtime on deploy"; the screenshots of the registered list, dialog and runtime card taken from a dev gateway (`node servers/gateway/index.js --no-auth` with a scratch `CROW_HOME`).
- [ ] **Step 5: Gate** on check-runs `suite`, `static-checks`, `audit` all `completed`/`success`, then merge.

Deploy note: merging is safe on crow because selection needs a gufo **install record** (none exists until plan 4 window 4b runs `models-runtime-install.mjs set-gufo`), so every native start keeps using llama-server.

---

## Self-review (plan 3 against spec §3.4, §4, §6, §8, §9, §11)

- §11.1 D1′/D2′ → Task 2 (container shape only in gufo), Task 6 (selection), Global Constraints (gfx1151 only, loopback only).
- §11.2 runtime interface (`launchShape`, `probeVersion`, `buildCommand`, `supports`, `healthPath`) → Tasks 1, 2; selection rule incl. the pinned refusal and the YaRN fallback → Task 6; catalog block → Task 3; install records → Task 4; runtime assets → Task 5; per-model override knows its runtime (Kevin's point about #385) → Task 7.
- §3.4 runtime override + "min_runtime_version skipped with a visible warning" → Task 12 (panel warning), Task 7 (records).
- §6 Extensions (no inference cards, Local models card, retired chip) → Task 9; Model Catalog (registration dialog with provider id/group/resident/launch, adopt curated + HF with unverified label, registered list with argv/status/edit/unregister and "restart to apply", runtime card with version, override and reset) → Tasks 8, 10, 11, 12. The 2026-09-24 minor (Start shown under `CROW_DISABLE_MODEL_ORCHESTRATION`) → Task 10.
- §8 errors at save: `INVALID_LAUNCH` (register/edit, incl. the gufo launch), `ADOPT_*` with the size message naming both sizes, `NOT_ABSOLUTE`/`NOT_EXECUTABLE`/`VERSION_FAILED` for overrides and installs; at start: `RUNTIME_UNSUPPORTED`, `RUNTIME_NOT_INSTALLED`, `MODEL_FILE_MISSING` (unchanged).
- §9: Extensions render, client contract for the new dialogs (script executed), gufo argv parity with the production compose, override chosen over release (existing) plus the gufo root overlay.
- Not here: migrating any role (plan 4), deleting bundles (plan 4), the pi contract (plan 2).
- Names consistent across tasks: `getRuntime`, `RUNTIME_IDS`, `selectRuntime`, `RuntimeSelectError`, `validateLlamaServerBinary`, `validateGufoLaunch`, `renderGufoArgs`, `containerNameFor`, `parseGufoBuildInfo`, `GUFO_OWNED_FLAGS`, `GUFO_LAUNCH_KEYS`, `validateRuntimesBlock`, `getRuntimeInstall`, `setRuntimeInstall`, `clearRuntimeInstall`, `listRuntimeInstalls`, `runtimeAssets`, `runtimeAssetPaths`, `gpuPolicyExtra`, `runtimeId`, `runtimeLaunch`, `hfSyntheticCatalog`, `buildRegisteredRows`, `renderRegisteredSection`, `registeredClientJS`, `dialogClientJS`, `buildRuntimeCardData`, `renderRuntimeCard`, `runtimeCardClientJS`, `renderLocalModelsCard`.
- Placeholder scan: every step carries complete code or an exact command. Two steps tell the implementer to run an existing neighbour test file whose name is found with `ls tests | grep …`, which is a command, not a gap.
