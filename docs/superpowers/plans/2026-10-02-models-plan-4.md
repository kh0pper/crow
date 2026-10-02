# Models arc plan 4 of 4: migration windows and bundle retirement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The window runbooks (W0–W6) are operator procedures, executed attended, one per registered CROW-SCHEDULE slot; they are not subagent tasks.

**Goal:** Move crow's model roles off their docker bundles onto the native catalog path one role at a time — each inside a registered, deadman-guarded window that restores production on its own — then delete what migrated.

**Architecture:** One code PR first (`feat/models-migrate-ops`): the two small product changes the windows need (converting an unmanaged local row; a YaRN-aware context ceiling), the operator script `scripts/ops/models-migrate.mjs` (`status`, `verify`, `adopt`, `convert`, `revert`, `repoint`, `mark-external`, `unmark-external`), the window helper `scripts/ops/models-window.mjs` (`preflight`, `arm`, `restore`, `disarm`) whose deadman is an out-of-process systemd user timer, and the voice benchmark `scripts/bench/voice-runtime-bench.mjs`. Then the windows W0 (voice benchmark) through W5, then a retirement PR (W6). Plans 2 and 3 must be merged and deployed before W1; W0 needs only this plan's Task 4.

**Tech Stack:** Node 24 (`export PATH=/home/kh0pp/.nvm/versions/node/v24.21.0/bin:$PATH`), `node:test` through the scratch harness, systemd user transient timers (`systemd-run --user`), docker CLI, `box-reserve.mjs`, the plan 2 lifecycle API with the models token.

**Spec:** `docs/superpowers/specs/2026-09-04-models-bundles-to-catalog-design.md` §7 (migration sequence + rollback line), §9 (live acceptance per step), and **§11 Amendment A** (§11.3 external interim, §11.5 voice pending, §11.9 amended sequence, §11.11 open questions). `~/CROW-SCHEDULE.md` is the slot authority; re-read it before every window.

## Global Constraints

- Worktree for the code PR: `git worktree add ~/crow-wt-models-migrate -b feat/models-migrate-ops origin/main`. Never `git checkout` in `~/crow`.
- Commit with positional paths; `git show --stat HEAD`; never `git add -A`; no AI attribution.
- Tests through `npm test -- tests/<file>.test.js`; full `npm test` before pushing; CI check-runs green before merge.
- **Every window** (global CLAUDE.md "Unattended-window safety"): (1) read `~/CROW-SCHEDULE.md`; (2) register a row before starting and move it to Done after; (3) `box-reserve.mjs status` must print `none` first; (4) arm the out-of-process deadman BEFORE anything in prod stops; (5) the deadman restores prod by itself at the cap; (6) verify prod is back before calling the window closed.
- **Slots:** Monday–Friday between 09:00 and 16:30 only. The Engram Stage 2 queue runs on crow only on nights and weekends (never Mon–Fri 07:00–17:00, never 02:15–04:15) and holds the box per unit; `box-reserve.mjs hold` silently overwrites an existing hold, so overlapping it is never safe. Never 02:15–04:15 (pi-lab nightly audit at 02:30, dsv4-window interlock). Never Saturday 2026-10-03 08:00–10:30 (pi-lab's raven smoke drives compat checks from crow). One window per day unless the previous one closed clean with time to spare.
- No window deletes weights. Adopt never copies or unlinks. Rollback for every step is `models-window.mjs restore` (the same command the deadman runs).
- `~/crow-addons` is a public GitHub repo: commit there only with Kevin's go; never push from a window.
- `~/.pi/agent/models.json` hand-written entries are pi-lab's; a window that must repoint one (W3, W4) backs the file up first and the deadman restores the backup.

## Review Focus

1. **The deadman fires while the gateway is down** (it crashed mid-window): restore must still bring prod back without the lifecycle API. Test: Task 3 "restore works when the lifecycle API is unreachable".
2. **`revert` of a row that had no `gpu_policy`** (unmanaged `crow-embed`) must leave it non-native; `upsertProvider` COALESCEs a null policy, so a naive revert keeps it native. Test: Task 2 "revert of an unmanaged row clears the native policy".
3. **A second `revert`** (the deadman fires after an operator already reverted by hand) must be a no-op, not a second write over newer state. Test: Task 2 "revert is idempotent".
4. **`arm` while a box hold already exists** (an Engram unit, another window) must refuse, not overwrite it. Test: Task 3 "preflight refuses an existing hold".
5. **The 512k variant's `ctx 524288` with YaRN ×2** must pass validation and the start guard, and the same `ctx` without YaRN must still be refused. Test: Task 1 "YaRN raises the ceiling by its scale".

---

## File structure

| File | Responsibility |
|---|---|
| `servers/gateway/models/launch.js` | `contextCeiling(launch, contextLen)`; `validateLaunch` uses it. |
| `servers/gateway/gpu-orchestrator.js` | `CTX_EXCEEDS_MODEL` guard uses `contextCeiling`. |
| `servers/gateway/models/manager.js` | `registerModel({ convertUnmanaged })`: snapshot + convert an unmanaged local row. |
| `scripts/ops/models-migrate.mjs` (new) | Operator CLI for one provider at a time. |
| `scripts/ops/models-window.mjs` (new) | Window preflight, deadman arm/disarm, restore. |
| `scripts/bench/voice-runtime-bench.mjs` (new) | TTFT and tok/s at 1/4/8 concurrent streams. |
| `scripts/ops/models-retire-installed.mjs` (new, W6 PR) | Remove retired bundles from `installed.json` and `~/.crow/bundles`. |
| Tests | `tests/models-launch-yarn.test.js`, `tests/models-convert-unmanaged.test.js`, `tests/models-migrate-cli.test.js`, `tests/models-window.test.js`, `tests/voice-runtime-bench.test.js`, `tests/models-retire-installed.test.js`. |

---

### Task 1: Two product changes the windows need

*(Rulings, spec gaps.)* (a) `crow-embed` and `crow-local-27b-512k` are **unmanaged** rows (no `bundle_id`, no `gpu_policy`), which `registerModel` refuses to convert (`ProviderIdConflictError`). An explicit `convertUnmanaged: true` lets the operator script convert an unmanaged **local** row with the same snapshot as a bundle row; cloud rows and external engines stay refused. (b) The 512k variant runs `-c 524288` with `--rope-scaling yarn --rope-scale 2`, above `context_len` 262144, which both `validateLaunch` and the start guard refuse. The ceiling becomes `context_len × rope-scale` when `extra_args` carry `--rope-scaling yarn`.

**Files:**
- Modify: `servers/gateway/models/launch.js`, `servers/gateway/gpu-orchestrator.js` (the `CTX_EXCEEDS_MODEL` block), `servers/gateway/models/manager.js` (collision guard in `registerModel`)
- Test: `tests/models-launch-yarn.test.js`, `tests/models-convert-unmanaged.test.js`

**Interfaces:**
- Produces: `contextCeiling(launch, contextLen) -> number|null` (null when `contextLen` is not finite); `registerModel({ …, convertUnmanaged = false })`.

- [ ] **Step 1: Write the failing tests.**

```js
// tests/models-launch-yarn.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { contextCeiling, validateLaunch } from "../servers/gateway/models/launch.js";

const YARN2 = ["--rope-scaling", "yarn", "--rope-scale", "2", "--yarn-orig-ctx", "262144", "--override-kv", "qwen35.context_length=int:524288"];

test("YaRN raises the ceiling by its scale", () => {
  assert.equal(contextCeiling({ extra_args: YARN2 }, 262144), 524288);
  assert.equal(contextCeiling({ extra_args: ["--rope-scaling=yarn", "--rope-scale=2.5"] }, 262144), 655360);
  assert.equal(contextCeiling({}, 262144), 262144);
  assert.equal(contextCeiling({ extra_args: ["--rope-scale", "2"] }, 262144), 262144, "a scale without yarn is not YaRN");
  assert.equal(contextCeiling({}, null), null);
});

test("validateLaunch accepts 524288 with YaRN x2 and still refuses it without", () => {
  assert.deepEqual(validateLaunch({ ctx: 524288, extra_args: YARN2 }, { contextLen: 262144 }), []);
  assert.match(validateLaunch({ ctx: 524288 }, { contextLen: 262144 })[0], /ctx 524288 exceeds context_len 262144/);
});
```

```js
// tests/models-convert-unmanaged.test.js
//
// Uses the real-file, real-libsql harness of tests/models-adopt.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { adoptModel, ProviderIdConflictError } from "../servers/gateway/models/manager.js";
import { loadState } from "../servers/gateway/models/state.js";
import { upsertProvider, listProvidersAll, setProviderSyncManager } from "../servers/shared/providers-db.js";

function freshLibsql() {
  const dir = mkdtempSync(join(tmpdir(), "conv-unmanaged-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: join(import.meta.dirname, "..") });
  const prev = process.env.CROW_DATA_DIR;
  process.env.CROW_DATA_DIR = dir;
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { dir, db, cleanup() { setProviderSyncManager(null); if (prev === undefined) delete process.env.CROW_DATA_DIR; else process.env.CROW_DATA_DIR = prev; try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}
const sha = (b) => createHash("sha256").update(b).digest("hex");
const W = Buffer.from("embed-weights");
const catalog = { version: 3, runtime: { release: "b10068", assets: {} }, models: [{
  id: "qwen3-embedding-0.6b", family: "Q", lab: "L", hf_repo: "x/y", license: "apache-2.0", gated: false, task: "embedding", context_len: 32768,
  min_runtime_version: "b10068", default_quant: "Q8_0", tags: [], serving: { class: "resident" },
  quants: [{ file: "Qwen3-Embedding-0.6B-Q8_0.gguf", quant: "Q8_0", size_mb: W.length / 1e6, min_ram_mb: 1, min_vram_mb: 0, sha256: sha(W) }],
}] };
const OPTS = (h) => ({ db: h.db, dir: h.dir, allocatePortFn: async (s, id) => { s.reservations[id] = { port: 18101, owner: {} }; return 18101; },
  ownInstanceIdFn: () => "inst-A", tailnetIpFn: () => "100.118.41.122", gatewayPortFn: () => 3001, ownAddrsFn: () => new Set(["100.118.41.122", "127.0.0.1"]) });

test("an unmanaged local row converts only with convertUnmanaged, and is snapshotted", async () => {
  const h = freshLibsql();
  const w = mkdtempSync(join(tmpdir(), "w-"));
  try {
    writeFileSync(join(w, "e.gguf"), W);
    await upsertProvider(h.db, { id: "crow-embed", baseUrl: "http://100.118.41.122:8004/v1", host: "local", models: [{ id: "qwen3-embedding-0.6b" }] });
    const args = { modelId: "qwen3-embedding-0.6b", quant: "Q8_0", path: join(w, "e.gguf"), catalog, providerId: "crow-embed", mutexGroup: null, alwaysResident: true, ...OPTS(h) };
    await assert.rejects(adoptModel(args), (e) => e instanceof ProviderIdConflictError);
    await adoptModel({ ...args, convertUnmanaged: true });
    const row = (await listProvidersAll(h.db)).find((r) => r.id === "crow-embed");
    assert.equal(row.baseUrl, "http://100.118.41.122:3001/llm/p/crow-embed/v1", "native rows advertise their provider door (plan 2 Task 4)");
    assert.equal(row.gpuPolicy.runtime, "native");
    assert.equal(row.gpuPolicy.alwaysResident, true);
    const snap = loadState(h.dir).conversions["crow-embed"];
    assert.equal(snap.row.base_url, "http://100.118.41.122:8004/v1");
    assert.equal(snap.row.gpu_policy, null);
  } finally { h.cleanup(); rmSync(w, { recursive: true, force: true }); }
});

test("convertUnmanaged never converts a cloud row", async () => {
  const h = freshLibsql();
  const w = mkdtempSync(join(tmpdir(), "w-"));
  try {
    writeFileSync(join(w, "e.gguf"), W);
    await upsertProvider(h.db, { id: "crow-embed", baseUrl: "https://api.example.com/v1", host: "cloud", apiKey: "k", models: [{ id: "qwen3-embedding-0.6b" }] });
    await assert.rejects(adoptModel({ modelId: "qwen3-embedding-0.6b", quant: "Q8_0", path: join(w, "e.gguf"), catalog, providerId: "crow-embed", convertUnmanaged: true, ...OPTS(h) }),
      (e) => e instanceof ProviderIdConflictError);
  } finally { h.cleanup(); rmSync(w, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run, expect FAIL.** `npm test -- tests/models-launch-yarn.test.js tests/models-convert-unmanaged.test.js`

- [ ] **Step 3: Implement.** `launch.js`:

```js
/** The highest ctx a launch may request: context_len, times the YaRN scale
 * when extra_args enable `--rope-scaling yarn` (spec §11.9 step 4; the 512k
 * variant runs -c 524288 at --rope-scale 2 over a 262144 model). */
export function contextCeiling(launch, contextLen) {
  if (!Number.isFinite(contextLen)) return null;
  const args = Array.isArray(launch?.extra_args) ? launch.extra_args : [];
  const flagValue = (name) => {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === name) return args[i + 1];
      if (args[i].startsWith(name + "=")) return args[i].slice(name.length + 1);
    }
    return undefined;
  };
  if (flagValue("--rope-scaling") !== "yarn") return contextLen;
  const scale = Number(flagValue("--rope-scale"));
  return Number.isFinite(scale) && scale > 1 ? Math.floor(contextLen * scale) : contextLen;
}
```

and in `validateLaunch` replace `else if (Number.isFinite(contextLen) && ctx > contextLen)` with:

```js
    else {
      const ceiling = contextCeiling(launch, contextLen);
      if (ceiling !== null && ctx > ceiling) errors.push(`${label}: ctx ${ctx} exceeds context_len ${contextLen}${ceiling !== contextLen ? ` (YaRN ceiling ${ceiling})` : ""}`);
    }
```

In `gpu-orchestrator.js`, replace the `launch.ctx > catalogEntry.context_len` comparison with `launch.ctx > contextCeiling(launch, catalogEntry.context_len)` (import `contextCeiling` from `./models/launch.js`; keep the error code and message).

`manager.js` `registerModel`: add `convertUnmanaged = false` and `ownAddrsFn = getOwnAddresses` (from `../../shared/locality.js`) to the parameters, import `doorKindOf` from `./door-resolve.js` and `isLocallyOrchestratable` from `../../shared/locality.js`, and change the guard to the following. The unmanaged row must point at **this** host. Plan 2 revision 2 removed the address-based `local` door kind, and an address proves locality only when checked against this host's own addresses.

```js
    const isBundleRow = !!existingRow.bundleId;
    const isUnmanagedLocal = convertUnmanaged === true
      && !isOurs && !isBundleRow
      && existingRow.gpuPolicy?.runtime !== NATIVE_RUNTIME
      && doorKindOf({ baseUrl: existingRow.baseUrl, gpuPolicy: existingRow.gpuPolicy }) === "unmanaged"
      && isLocallyOrchestratable({ baseUrl: existingRow.baseUrl }, ownAddrsFn());
    if (!isOurs && !isBundleRow && !isUnmanagedLocal) throw new ProviderIdConflictError(providerId);
    converted = isBundleRow || isUnmanagedLocal;
```

`adoptModel` forwards `convertUnmanaged` through `...registerOpts` already.

- [ ] **Step 4: Run, expect PASS**, plus `npm test -- tests/models-launch.test.js tests/models-registration.test.js tests/models-adopt.test.js tests/gpu-orchestrator-native.test.js tests/model-catalog-validate.test.js`.

- [ ] **Step 5: Commit.**

```bash
git add tests/models-launch-yarn.test.js tests/models-convert-unmanaged.test.js
git commit servers/gateway/models/launch.js servers/gateway/gpu-orchestrator.js servers/gateway/models/manager.js tests/models-launch-yarn.test.js tests/models-convert-unmanaged.test.js -m "feat(models): YaRN-aware context ceiling; convert an unmanaged local row on explicit request"
```

---

### Task 2: `scripts/ops/models-migrate.mjs`

**Files:**
- Create: `scripts/ops/models-migrate.mjs`
- Test: `tests/models-migrate-cli.test.js`

**Interfaces:**
- Consumes: `adoptModel`, `registerModel`, `hashFileSha256`, `resolveEntry` (manager.js); `loadState`/`saveState`/`releasePort`/`registryKey` (state.js); `listProvidersAll`, `upsertProvider` (providers-db.js); `createDbClient`, `resolveDataDir` (servers/db.js).
- Produces: `main(argv, deps) -> Promise<number>` (exit code: 0 ok, 1 refused, 2 usage, 3 not found); subcommands:

| command | effect |
|---|---|
| `status [--provider <id>]` | JSON per provider: id, base_url, bundle_id, gpu_policy, disabled, lamport, registry key, conversion snapshot (at, revertedAt) |
| `verify --catalog <id> --quant <q> --path <abs> [--mmproj <abs>]` | sha256 check only; writes nothing |
| `adopt --catalog <id> --quant <q> --path <abs> --provider <id> [--mmproj <abs>] [--dflash <abs>] [--gufo-mmproj <abs>] [--group <g>\|--no-group] [--always-resident] [--default-member] [--launch <json>] [--runtime <id>] [--runtime-launch <json>] [--unverified] [--convert-unmanaged]` | `adoptModel` with roles; converts a bundle or (with the flag) unmanaged row |
| `convert --catalog <id> --quant <q> --provider <id> [role flags]` | `registerModel` onto an existing registry entry (variants, re-roles) |
| `revert --provider <id>` | restore the row from `state.conversions[id]`, release its port reservation, stamp `revertedAt`; idempotent |
| `repoint --provider <id> --base-url <url>` | rewrite one row's `base_url` (r4's own `crow-embed` row); prints the previous URL |
| `mark-external --provider <id> --host <h> --label <l> [--expect-url <url>]` / `unmark-external --provider <id>` | the #386 marker, guarded |

Every write prints the data dir it wrote and the row's lamport before and after. `CROW_DATA_DIR` selects the instance (r4: `/home/kh0pp/.crow-r4/data`).

- [ ] **Step 1: Write the failing test** (real libsql, real files; `main` is called in-process with `deps.dir`):

```js
// tests/models-migrate-cli.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { main } from "../scripts/ops/models-migrate.mjs";
import { loadState } from "../servers/gateway/models/state.js";
import { upsertProvider, listProvidersAll, setProviderSyncManager } from "../servers/shared/providers-db.js";

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "mm-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: join(import.meta.dirname, "..") });
  const prev = process.env.CROW_DATA_DIR;
  process.env.CROW_DATA_DIR = dir;
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  const out = [], err = [];
  const W = Buffer.from("embed-weights");
  const sha = createHash("sha256").update(W).digest("hex");
  const weights = mkdtempSync(join(tmpdir(), "mmw-"));
  writeFileSync(join(weights, "e.gguf"), W);
  const catalog = { version: 3, runtime: { release: "b10068", assets: {} }, models: [{
    id: "qwen3-embedding-0.6b", family: "Q", lab: "L", hf_repo: "x/y", license: "apache-2.0", gated: false, task: "embedding", context_len: 32768,
    min_runtime_version: "b10068", default_quant: "Q8_0", tags: [], serving: { class: "resident" },
    quants: [{ file: "Qwen3-Embedding-0.6B-Q8_0.gguf", quant: "Q8_0", size_mb: W.length / 1e6, min_ram_mb: 1, min_vram_mb: 0, sha256: sha }],
  }] };
  const deps = {
    dir, dbFactory: () => db, loadCatalogFn: () => catalog,
    out: (s) => out.push(s), err: (s) => err.push(s),
    registerOpts: { allocatePortFn: async (s, id) => { s.reservations[id] = { port: 18101, owner: {} }; return 18101; },
      ownInstanceIdFn: () => "inst-A", tailnetIpFn: () => "100.118.41.122", gatewayPortFn: () => 3001, ownAddrsFn: () => new Set(["100.118.41.122", "127.0.0.1"]) },
  };
  return { dir, db, deps, out, err, weights, cleanup() { setProviderSyncManager(null); if (prev === undefined) delete process.env.CROW_DATA_DIR; else process.env.CROW_DATA_DIR = prev; try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); rmSync(weights, { recursive: true, force: true }); } };
}
const row = async (db, id) => (await listProvidersAll(db)).find((r) => r.id === id);

test("adopt --convert-unmanaged converts crow-embed; revert restores it non-native; revert is idempotent", async () => {
  const h = harness();
  try {
    await upsertProvider(h.db, { id: "crow-embed", baseUrl: "http://100.118.41.122:8004/v1", host: "local", models: [{ id: "qwen3-embedding-0.6b" }] });
    const code = await main(["adopt", "--catalog", "qwen3-embedding-0.6b", "--quant", "Q8_0", "--path", join(h.weights, "e.gguf"),
      "--provider", "crow-embed", "--no-group", "--always-resident", "--convert-unmanaged"], h.deps);
    assert.equal(code, 0, h.err.join("\n"));
    assert.equal((await row(h.db, "crow-embed")).gpuPolicy.runtime, "native");

    assert.equal(await main(["revert", "--provider", "crow-embed"], h.deps), 0);
    const r = await row(h.db, "crow-embed");
    assert.equal(r.baseUrl, "http://100.118.41.122:8004/v1");
    assert.notEqual(r.gpuPolicy?.runtime, "native", "revert of an unmanaged row clears the native policy");
    const st = loadState(h.dir);
    assert.ok(st.conversions["crow-embed"].revertedAt);
    assert.equal(st.reservations["crow-embed"], undefined, "port reservation released");

    const lamport = (await row(h.db, "crow-embed")).lamport_ts;
    assert.equal(await main(["revert", "--provider", "crow-embed"], h.deps), 0);
    assert.equal((await row(h.db, "crow-embed")).lamport_ts, lamport, "revert is idempotent: no second write");
    assert.match(h.out.at(-1), /already reverted/);
  } finally { h.cleanup(); }
});

test("verify writes nothing and reports a mismatch with exit 1", async () => {
  const h = harness();
  try {
    writeFileSync(join(h.weights, "bad.gguf"), "nope");
    assert.equal(await main(["verify", "--catalog", "qwen3-embedding-0.6b", "--quant", "Q8_0", "--path", join(h.weights, "e.gguf")], h.deps), 0);
    assert.equal(await main(["verify", "--catalog", "qwen3-embedding-0.6b", "--quant", "Q8_0", "--path", join(h.weights, "bad.gguf")], h.deps), 1);
    assert.deepEqual(Object.keys(loadState(h.dir).registry), []);
  } finally { h.cleanup(); }
});

test("repoint prints the previous URL; mark-external refuses an unexpected URL", async () => {
  const h = harness();
  try {
    await upsertProvider(h.db, { id: "crow-embed", baseUrl: "http://100.118.41.122:8004/v1", host: "local", models: [{ id: "qwen3-embedding-0.6b" }] });
    assert.equal(await main(["repoint", "--provider", "crow-embed", "--base-url", "http://100.118.41.122:3001/llm/v1"], h.deps), 0);
    assert.match(h.out.join("\n"), /previous base_url: http:\/\/100\.118\.41\.122:8004\/v1/);
    assert.equal(await main(["mark-external", "--provider", "crow-embed", "--host", "crow", "--label", "gufo", "--expect-url", "http://x/v1"], h.deps), 1);
    assert.equal(await main(["revert", "--provider", "nope"], h.deps), 3);
    assert.equal(await main(["bogus"], h.deps), 2);
  } finally { h.cleanup(); }
});
```

- [ ] **Step 2: Run, expect FAIL.** `npm test -- tests/models-migrate-cli.test.js`

- [ ] **Step 3: Implement.**

```js
#!/usr/bin/env node
// scripts/ops/models-migrate.mjs
/**
 * models-migrate — the operator's one-provider-at-a-time tool for the models
 * arc windows (spec §7, §11.9). Every write goes through the product code
 * paths (adoptModel / registerModel / upsertProvider), so rows stamp lamport
 * and replicate through the outbox exactly like a dashboard edit.
 *
 * Run inside a registered CROW-SCHEDULE window (models-window.mjs arms the
 * deadman that calls `revert`). Instance: CROW_DATA_DIR (r4:
 * /home/kh0pp/.crow-r4/data). Exit: 0 ok, 1 refused, 2 usage, 3 not found.
 */
import { parseArgs } from "node:util";
import { realpathSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDbClient, resolveDataDir } from "../../servers/db.js";
import { adoptModel, registerModel, hashFileSha256, resolveEntry } from "../../servers/gateway/models/manager.js";
import { loadState, saveState, releasePort, registryKey } from "../../servers/gateway/models/state.js";
import { listProvidersAll, upsertProvider } from "../../servers/shared/providers-db.js";

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const defaultCatalog = () => JSON.parse(readFileSync(join(REPO, "registry", "model-catalog.json"), "utf8"));

const OPTIONS = {
  provider: { type: "string" }, catalog: { type: "string" }, quant: { type: "string" }, path: { type: "string" },
  mmproj: { type: "string" }, dflash: { type: "string" }, "gufo-mmproj": { type: "string" },
  group: { type: "string" }, "no-group": { type: "boolean" }, "always-resident": { type: "boolean" }, "default-member": { type: "boolean" },
  launch: { type: "string" }, runtime: { type: "string" }, "runtime-launch": { type: "string" }, unverified: { type: "boolean" }, "convert-unmanaged": { type: "boolean" },
  "base-url": { type: "string" }, host: { type: "string" }, label: { type: "string" }, "expect-url": { type: "string" },
};

function roleOpts(v) {
  const o = {};
  if (v.provider) o.providerId = v.provider;
  if (v["no-group"]) o.mutexGroup = null; else if (v.group) o.mutexGroup = v.group;
  if (v["always-resident"]) o.alwaysResident = true;
  if (v["default-member"]) o.defaultMember = true;
  if (v.launch) o.launch = JSON.parse(v.launch);
  // gpuPolicyExtra is read by registerModel once plan 3 Task 8 lands; before
  // that it is an ignored extra parameter (only W4b uses these two flags).
  const extra = {};
  if (v.runtime) extra.runtimeId = v.runtime;
  if (v["runtime-launch"]) extra.runtimeLaunch = JSON.parse(v["runtime-launch"]);
  if (Object.keys(extra).length) o.gpuPolicyExtra = extra;
  if (v["convert-unmanaged"]) o.convertUnmanaged = true;
  return o;
}

export async function main(argv, deps = {}) {
  const out = deps.out || console.log;
  const err = deps.err || console.error;
  const dir = deps.dir || resolveDataDir();
  const loadCatalogFn = deps.loadCatalogFn || defaultCatalog;
  let parsed;
  try { parsed = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS }); } catch (e) { err(e.message); return 2; }
  const { values: v, positionals } = parsed;
  const cmd = positionals[0];
  const db = (deps.dbFactory || createDbClient)();
  const findRow = async (id) => (await listProvidersAll(db)).find((r) => r.id === id) || null;
  try {
    switch (cmd) {
      case "status": {
        const st = loadState(dir);
        const rows = (await listProvidersAll(db)).filter((r) => !v.provider || r.id === v.provider);
        out(JSON.stringify(rows.map((r) => ({
          id: r.id, base_url: r.baseUrl, bundle_id: r.bundleId, gpu_policy: r.gpuPolicy, disabled: r.disabled, lamport: r.lamport_ts,
          registry_key: r.gpuPolicy?.catalogId && r.gpuPolicy?.quant ? registryKey(r.gpuPolicy.catalogId, r.gpuPolicy.quant) : null,
          conversion: st.conversions[r.id] ? { at: st.conversions[r.id].at, revertedAt: st.conversions[r.id].revertedAt || null } : null,
        })), null, 2));
        return 0;
      }
      case "verify": {
        if (!v.catalog || !v.quant || !v.path) { err("usage: verify --catalog <id> --quant <q> --path <abs>"); return 2; }
        const { quantEntry } = resolveEntry(loadCatalogFn(), v.catalog, v.quant);
        const actual = await hashFileSha256(v.path);
        if (actual !== quantEntry.sha256) { err(`MISMATCH ${v.path}: ${actual} != catalog ${quantEntry.sha256}`); return 1; }
        out(`verified ${v.path} = ${actual}`);
        return 0;
      }
      case "adopt": {
        if (!v.catalog || !v.quant || !v.path || !v.provider) { err("usage: adopt --catalog --quant --path --provider [role flags]"); return 2; }
        const before = await findRow(v.provider);
        const runtimeAssetPaths = {};
        if (v.dflash || v["gufo-mmproj"]) runtimeAssetPaths.gufo = { ...(v.dflash ? { dflash: v.dflash } : {}), ...(v["gufo-mmproj"] ? { mmproj: v["gufo-mmproj"] } : {}) };
        const r = await adoptModel({
          modelId: v.catalog, quant: v.quant, path: v.path, companionPaths: v.mmproj ? { mmproj: v.mmproj } : {}, runtimeAssetPaths,
          allowUnverified: !!v.unverified, catalog: loadCatalogFn(), db, dir, ...roleOpts(v), ...(deps.registerOpts || {}),
        });
        out(`adopted ${v.catalog}@${v.quant} as ${r.id} in ${dir}: base_url ${r.baseUrl}, port ${r.gpuPolicy?.port}, lamport ${before?.lamport_ts ?? "-"} -> ${r.lamport_ts}, converted=${!!r.converted}`);
        return 0;
      }
      case "convert": {
        if (!v.catalog || !v.quant || !v.provider) { err("usage: convert --catalog --quant --provider [role flags]"); return 2; }
        const before = await findRow(v.provider);
        const r = await registerModel({ modelId: v.catalog, quant: v.quant, catalog: loadCatalogFn(), db, dir, ...roleOpts(v), ...(deps.registerOpts || {}) });
        out(`registered ${v.catalog}@${v.quant} as ${r.id} in ${dir}: base_url ${r.baseUrl}, lamport ${before?.lamport_ts ?? "-"} -> ${r.lamport_ts}, converted=${!!r.converted}`);
        return 0;
      }
      case "revert": {
        if (!v.provider) { err("usage: revert --provider <id>"); return 2; }
        const st = loadState(dir);
        const snap = st.conversions[v.provider];
        if (!snap) { err(`no conversion snapshot for ${v.provider} in ${dir}`); return 3; }
        if (snap.revertedAt) { out(`${v.provider} already reverted at ${snap.revertedAt}; nothing written`); return 0; }
        const s = snap.row;
        const res = await upsertProvider(db, {
          id: s.id, baseUrl: s.base_url, apiKey: s.api_key, host: s.host, bundleId: s.bundle_id, description: s.description,
          models: s.models, providerType: s.provider_type, disabled: !!s.disabled,
          // upsertProvider COALESCEs a null policy (keeps the native one), so an
          // unmanaged row is written back as {} — not native, no group.
          gpuPolicy: s.gpu_policy ?? {},
        });
        const st2 = loadState(dir);
        releasePort(st2, v.provider);
        st2.conversions[v.provider] = { ...st2.conversions[v.provider], revertedAt: new Date().toISOString() };
        saveState(dir, st2);
        out(`reverted ${v.provider} in ${dir}: base_url ${s.base_url}, bundle ${s.bundle_id || "-"}, lamport -> ${res.lamport_ts}`);
        return 0;
      }
      case "repoint": {
        if (!v.provider || !v["base-url"]) { err("usage: repoint --provider <id> --base-url <url>"); return 2; }
        const r = await findRow(v.provider);
        if (!r) { err(`no provider ${v.provider} in ${dir}`); return 3; }
        const res = await upsertProvider(db, { ...r, baseUrl: v["base-url"] });
        out(`previous base_url: ${r.baseUrl}`);
        out(`repointed ${v.provider} in ${dir} -> ${v["base-url"]} (lamport ${r.lamport_ts} -> ${res.lamport_ts})`);
        return 0;
      }
      case "mark-external":
      case "unmark-external": {
        if (!v.provider || (cmd === "mark-external" && (!v.host || !v.label))) { err("usage: mark-external --provider --host --label [--expect-url]"); return 2; }
        const r = await findRow(v.provider);
        if (!r) { err(`no provider ${v.provider} in ${dir}`); return 3; }
        if (v["expect-url"] && r.baseUrl !== v["expect-url"]) { err(`${v.provider} base_url is ${r.baseUrl}, expected ${v["expect-url"]} — refusing`); return 1; }
        if (cmd === "mark-external" && (r.bundleId || r.gpuPolicy?.runtime === "native")) { err(`${v.provider} has a bundle or native runtime — refusing`); return 1; }
        const gp = { ...(r.gpuPolicy || {}) };
        if (cmd === "mark-external") gp.engine = { managed: "external", host: v.host, label: v.label }; else delete gp.engine;
        const res = await upsertProvider(db, { ...r, gpuPolicy: gp });
        out(`${cmd} ${v.provider} in ${dir}: lamport ${r.lamport_ts} -> ${res.lamport_ts}`);
        return 0;
      }
      default:
        err("usage: status | verify | adopt | convert | revert | repoint | mark-external | unmark-external (see the file header)");
        return 2;
    }
  } catch (e) {
    if (e && typeof e.code === "string" && /^(ADOPT_|INVALID_LAUNCH|PROVIDER_ID_CONFLICT|EXTERNAL_ENGINE|UNKNOWN_)/.test(e.code)) { err(`refused (${e.code}): ${e.message}`); return 1; }
    if (e && e.name === "ProviderIdConflictError") { err(`refused: ${e.message}`); return 1; }
    throw e;
  } finally {
    if (!deps.dbFactory) { try { db.close(); } catch {} }
  }
}

function invokedDirectly() {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}
if (invokedDirectly()) main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e.stack || e.message); process.exit(1); });
```

`deps.registerOpts` exists only for tests (port allocation, instance id, tailnet IP); production passes nothing and the real defaults apply. If `ProviderIdConflictError` carries a `code`, the regex branch catches it; the name check covers it otherwise.

- [ ] **Step 4: Run, expect PASS.** `npm test -- tests/models-migrate-cli.test.js`

- [ ] **Step 5: Commit.**

```bash
git add scripts/ops/models-migrate.mjs tests/models-migrate-cli.test.js
git commit scripts/ops/models-migrate.mjs tests/models-migrate-cli.test.js -m "feat(ops): models-migrate — status/verify/adopt/convert/revert/repoint/mark-external for the migration windows"
```

---

### Task 3: `scripts/ops/models-window.mjs` — preflight, deadman, restore

The deadman is a **systemd user transient timer** (`systemd-run --user --on-active=<cap>`), so it survives the operator session, the gateway, and this process. Its unit runs `models-window.mjs restore` with everything it needs on the command line; it never depends on the window session's state.

**Files:**
- Create: `scripts/ops/models-window.mjs`
- Test: `tests/models-window.test.js`

**Interfaces:**
- Produces: `main(argv, deps) -> Promise<number>` with subcommands:
  - `preflight` → exit 1 when `box-reserve status` is not `none`, when a `models-w*` deadman timer is already armed, or when any `engram-*` user unit is active; prints what it found.
  - `arm --window <name> --cap-min <n> --provider <id> [--container <name>] [--models-json-backup <abs>] [--r4-repoint <url>] [--allow <p1,p2>]` → holds the box (`--minutes cap+10 --allow <provider>[,allow…]`), then arms `models-<window>-deadman` running `restore` with the same arguments; prints the unit name.
  - `restore --window <name> --provider <id> [--container <name>] [--models-json-backup <abs>] [--r4-repoint <url>]` → (1) stop the native model via the lifecycle API, falling back to killing whatever listens on its `gpu_policy.port` when the API is unreachable; (2) `models-migrate.mjs revert --provider`; (3) with `--r4-repoint`, `models-migrate.mjs repoint` on r4's data dir; (4) with `--models-json-backup`, copy the backup over `~/.pi/agent/models.json`; (5) with `--container`, `docker start <container>` and wait up to 600 s for `/health` (or `/v1/models`) on its published port; (6) release the box hold; (7) print a one-line verdict. Every step runs even if an earlier one failed; exit 0 only if all succeeded.
  - `disarm --window <name>` → stop and reset the deadman timer, release the hold.
- `deps` seams: `run(cmd, args) -> { status, stdout, stderr }`, `fetchFn`, `readFileFn`, `copyFileFn`, `sleepFn`, `nowFn`, `env`.

- [ ] **Step 1: Write the failing test.**

```js
// tests/models-window.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../scripts/ops/models-window.mjs";

function fakeRun(responses = {}) {
  const calls = [];
  const run = (cmd, args) => {
    const key = [cmd, ...args].join(" ");
    calls.push(key);
    for (const [pat, res] of Object.entries(responses)) if (key.includes(pat)) return typeof res === "function" ? res(key) : res;
    return { status: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}
const base = (over = {}) => ({ out: () => {}, err: () => {}, sleepFn: async () => {}, env: { HOME: "/home/u", PATH: "/usr/bin" }, ...over });

test("preflight refuses an existing hold", async () => {
  const { run } = fakeRun({ "box-reserve.mjs status": { status: 0, stdout: '{ "owner": "engram-s2a" }', stderr: "" } });
  assert.equal(await main(["preflight"], base({ run })), 1);
});

test("preflight refuses an active engram unit and an armed models deadman", async () => {
  const a = fakeRun({ "box-reserve.mjs status": { status: 0, stdout: "none" }, "list-units": { status: 0, stdout: "engram-s2a-b16-lr1x.service loaded active running\n" } });
  assert.equal(await main(["preflight"], base({ run: a.run })), 1);
  const b = fakeRun({ "box-reserve.mjs status": { status: 0, stdout: "none" }, "list-timers": { status: 0, stdout: "models-w3-deadman.timer\n" } });
  assert.equal(await main(["preflight"], base({ run: b.run })), 1);
  const c = fakeRun({ "box-reserve.mjs status": { status: 0, stdout: "none" } });
  assert.equal(await main(["preflight"], base({ run: c.run })), 0);
});

test("arm holds the box with the provider allowed, then arms a transient timer that runs restore", async () => {
  const { run, calls } = fakeRun({ "box-reserve.mjs status": { status: 0, stdout: "none" } });
  const code = await main(["arm", "--window", "w1", "--cap-min", "60", "--provider", "crow-embed", "--container", "llamacpp-vulkan-qwen3-embed", "--r4-repoint", "http://100.118.41.122:8004/v1"], base({ run }));
  assert.equal(code, 0);
  const hold = calls.find((c) => c.includes("box-reserve.mjs hold"));
  assert.match(hold, /--owner models-w1 .*--minutes 70 --allow crow-embed/);
  const timer = calls.find((c) => c.startsWith("systemd-run --user"));
  assert.match(timer, /--unit=models-w1-deadman --on-active=60min --collect/);
  assert.match(timer, /models-window\.mjs restore --window w1 --provider crow-embed --container llamacpp-vulkan-qwen3-embed --r4-repoint http:\/\/100\.118\.41\.122:8004\/v1/);
  assert.ok(calls.indexOf(hold) < calls.indexOf(timer), "hold first, then the deadman (the deadman releases the hold)");
});

test("restore works when the lifecycle API is unreachable: kills the port listener, reverts, restarts the container, releases", async () => {
  const { run, calls } = fakeRun({
    "models-migrate.mjs status": { status: 0, stdout: JSON.stringify([{ id: "crow-embed", gpu_policy: { port: 18101 } }]) },
    "ss -ltnpH": { status: 0, stdout: 'LISTEN 0 512 127.0.0.1:18101 0.0.0.0:* users:(("llama-server",pid=4242,fd=3))\n' },
    "docker port llamacpp-vulkan-qwen3-embed": { status: 0, stdout: "8000/tcp -> 100.118.41.122:8004\n" },
  });
  const fetchFn = async (url) => {
    if (url.includes("/llm/models/")) throw new Error("ECONNREFUSED");
    return { ok: true, status: 200 };
  };
  const code = await main(["restore", "--window", "w1", "--provider", "crow-embed", "--container", "llamacpp-vulkan-qwen3-embed"],
    base({ run, fetchFn, readFileFn: () => "tok" }));
  assert.equal(code, 0);
  assert.ok(calls.includes("kill -TERM 4242"));
  assert.ok(calls.some((c) => c.includes("models-migrate.mjs revert --provider crow-embed")));
  assert.ok(calls.includes("docker start llamacpp-vulkan-qwen3-embed"));
  assert.ok(calls.some((c) => c.includes("box-reserve.mjs release")));
});

test("restore runs every step even when one fails, and exits non-zero", async () => {
  const { run, calls } = fakeRun({
    "models-migrate.mjs status": { status: 0, stdout: "[]" },
    "models-migrate.mjs revert": { status: 1, stdout: "", stderr: "boom" },
  });
  const code = await main(["restore", "--window", "w2", "--provider", "crow-voice", "--container", "vllm-rocm-qwen35-4b"],
    base({ run, fetchFn: async () => ({ ok: true, status: 200 }), readFileFn: () => "tok" }));
  assert.equal(code, 1);
  assert.ok(calls.includes("docker start vllm-rocm-qwen35-4b"), "the container still comes back");
  assert.ok(calls.some((c) => c.includes("box-reserve.mjs release")), "the hold is still released");
});

test("restore copies the models.json backup back", async () => {
  const copies = [];
  const { run } = fakeRun({ "models-migrate.mjs status": { status: 0, stdout: "[]" } });
  await main(["restore", "--window", "w3", "--provider", "crow-chat", "--models-json-backup", "/home/u/.pi/agent/models.json.pre-w3"],
    base({ run, fetchFn: async () => ({ ok: true, status: 200 }), readFileFn: () => "tok", copyFileFn: (a, b) => copies.push([a, b]) }));
  assert.deepEqual(copies, [["/home/u/.pi/agent/models.json.pre-w3", "/home/u/.pi/agent/models.json"]]);
});

test("disarm stops the timer and releases the hold", async () => {
  const { run, calls } = fakeRun();
  assert.equal(await main(["disarm", "--window", "w1"], base({ run })), 0);
  assert.ok(calls.includes("systemctl --user stop models-w1-deadman.timer"));
  assert.ok(calls.some((c) => c.includes("box-reserve.mjs release")));
});
```

- [ ] **Step 2: Run, expect FAIL.** `npm test -- tests/models-window.test.js`

- [ ] **Step 3: Implement.**

```js
#!/usr/bin/env node
// scripts/ops/models-window.mjs
/**
 * models-window — the guard rails around one models-arc migration window
 * (plan 4). `arm` holds the box and arms an OUT-OF-PROCESS deadman (a
 * systemd user transient timer) that runs `restore` at the cap; `restore`
 * is also the manual rollback; `disarm` ends a clean window.
 *
 * restore never stops at the first failure: prod coming back matters more
 * than a clean exit code. It works with the gateway down (the native model
 * dies with the gateway via pdeathsig; whatever still listens on the native
 * port is killed by pid).
 */
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { readFileSync, copyFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(dirname(HERE));
const NODE = process.execPath;
const BOX = join(REPO, "scripts", "ops", "box-reserve.mjs");
const MIGRATE = join(REPO, "scripts", "ops", "models-migrate.mjs");
const SELF = join(REPO, "scripts", "ops", "models-window.mjs");
const R4_DATA = "/home/kh0pp/.crow-r4/data";
const OPTIONS = {
  window: { type: "string" }, "cap-min": { type: "string" }, provider: { type: "string" }, container: { type: "string" },
  "models-json-backup": { type: "string" }, "r4-repoint": { type: "string" }, allow: { type: "string" },
};

const defaultRun = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 120_000, ...opts });
  return { status: r.status ?? 1, stdout: r.stdout || "", stderr: r.stderr || (r.error ? r.error.message : "") };
};

export async function main(argv, deps = {}) {
  const out = deps.out || console.log;
  const err = deps.err || console.error;
  const run = deps.run || defaultRun;
  const fetchFn = deps.fetchFn || fetch;
  const env = deps.env || process.env;
  const readFileFn = deps.readFileFn || ((p) => readFileSync(p, "utf8"));
  const copyFileFn = deps.copyFileFn || copyFileSync;
  const sleepFn = deps.sleepFn || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let parsed;
  try { parsed = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS }); } catch (e) { err(e.message); return 2; }
  const { values: v, positionals } = parsed;
  const cmd = positionals[0];
  const home = env.HOME;
  const unit = (w) => `models-${w}-deadman`;

  if (cmd === "preflight") {
    let ok = true;
    const st = run(NODE, [BOX, "status"]);
    if (st.stdout.trim() !== "none") { err(`box is held: ${st.stdout.trim()}`); ok = false; }
    const units = run("systemctl", ["--user", "list-units", "--state=active", "--no-legend", "engram-*"]);
    if (/engram-/.test(units.stdout)) { err(`an engram unit is active: ${units.stdout.trim()}`); ok = false; }
    const timers = run("systemctl", ["--user", "list-timers", "--all", "--no-legend", "models-*-deadman.timer"]);
    if (/models-.*-deadman/.test(timers.stdout)) { err(`a models deadman is already armed: ${timers.stdout.trim()}`); ok = false; }
    out(ok ? "preflight ok: box free, no engram unit, no models deadman" : "preflight FAILED");
    return ok ? 0 : 1;
  }

  if (cmd === "arm") {
    const cap = Number(v["cap-min"]);
    if (!v.window || !v.provider || !Number.isInteger(cap) || cap < 5 || cap > 240) { err("usage: arm --window <name> --cap-min <5..240> --provider <id> [...]"); return 2; }
    const allow = [v.provider, ...(v.allow ? v.allow.split(",").map((s) => s.trim()).filter(Boolean) : [])].join(",");
    const hold = run(NODE, [BOX, "hold", "--owner", `models-${v.window}`, "--reason", `models arc window ${v.window}`, "--minutes", String(cap + 10), "--allow", allow]);
    if (hold.status !== 0) { err(`hold refused: ${hold.stderr || hold.stdout}`); return 1; }
    const restoreArgs = ["restore", "--window", v.window, "--provider", v.provider];
    if (v.container) restoreArgs.push("--container", v.container);
    if (v["models-json-backup"]) restoreArgs.push("--models-json-backup", v["models-json-backup"]);
    if (v["r4-repoint"]) restoreArgs.push("--r4-repoint", v["r4-repoint"]);
    const t = run("systemd-run", ["--user", `--unit=${unit(v.window)}`, `--on-active=${cap}min`, "--collect",
      `--setenv=PATH=${env.PATH}`, `--setenv=HOME=${home}`, NODE, SELF, ...restoreArgs]);
    if (t.status !== 0) {
      err(`deadman NOT armed (${t.stderr.trim()}); releasing the hold — do not proceed`);
      run(NODE, [BOX, "release"]);
      return 1;
    }
    out(`armed ${unit(v.window)}.timer: restore in ${cap} min; hold allows ${allow}`);
    return 0;
  }

  if (cmd === "restore") {
    if (!v.window || !v.provider) { err("usage: restore --window <name> --provider <id> [...]"); return 2; }
    let failures = 0;
    const step = (name, ok, detail = "") => { out(`[restore ${v.window}] ${name}: ${ok ? "ok" : "FAILED"} ${detail}`.trim()); if (!ok) failures++; };

    // 1. stop the native model: lifecycle API, else kill the port listener
    let port = null;
    try {
      const st = run(NODE, [MIGRATE, "status", "--provider", v.provider]);
      port = Number(JSON.parse(st.stdout || "[]")[0]?.gpu_policy?.port) || null;
    } catch { port = null; }
    let stopped = false;
    try {
      const token = readFileFn(join(home, ".crow", "models-token")).trim();
      const r = await fetchFn(`http://127.0.0.1:3001/llm/models/${encodeURIComponent(v.provider)}/stop`, { method: "POST", headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
      stopped = !!(r && (r.ok || r.status === 409));
    } catch { stopped = false; }
    if (!stopped && port) {
      const ss = run("ss", ["-ltnpH", `sport = :${port}`]);
      const pids = [...ss.stdout.matchAll(/pid=(\d+)/g)].map((m) => m[1]);
      for (const pid of pids) run("kill", ["-TERM", pid]);
      stopped = true;
    }
    step("stop native", stopped, port ? `(port ${port})` : "");

    // 2. revert the row
    const rv = run(NODE, [MIGRATE, "revert", "--provider", v.provider]);
    step("revert row", rv.status === 0, rv.stdout.trim() || rv.stderr.trim());

    // 3. r4's own row
    if (v["r4-repoint"]) {
      const rp = run(NODE, [MIGRATE, "repoint", "--provider", v.provider, "--base-url", v["r4-repoint"]], { env: { ...env, CROW_DATA_DIR: R4_DATA } });
      step("repoint r4 row", rp.status === 0, rp.stdout.trim() || rp.stderr.trim());
    }

    // 4. pi models.json
    if (v["models-json-backup"]) {
      try { copyFileFn(v["models-json-backup"], join(home, ".pi", "agent", "models.json")); step("restore pi models.json", true); }
      catch (e) { step("restore pi models.json", false, e.message); }
    }

    // 5. the container
    if (v.container) {
      const ds = run("docker", ["start", v.container]);
      let healthy = false;
      if (ds.status === 0) {
        const pm = run("docker", ["port", v.container]).stdout.match(/->\s*([\d.]+):(\d+)/);
        const baseUrl = pm ? `http://${pm[1]}:${pm[2]}` : null;
        for (let i = 0; i < 120 && baseUrl && !healthy; i++) {
          for (const path of ["/health", "/v1/models"]) {
            try { const r = await fetchFn(baseUrl + path, { signal: AbortSignal.timeout(5_000) }); if (r && r.ok) { healthy = true; break; } } catch { /* not yet */ }
          }
          if (!healthy) await sleepFn(5_000);
        }
      }
      step("container back", healthy, v.container);
    }

    // 6. release the hold
    const rel = run(NODE, [BOX, "release"]);
    step("release hold", rel.status === 0);
    out(`[restore ${v.window}] ${failures === 0 ? "PROD RESTORED" : `${failures} step(s) FAILED — check by hand`}`);
    return failures === 0 ? 0 : 1;
  }

  if (cmd === "disarm") {
    if (!v.window) { err("usage: disarm --window <name>"); return 2; }
    run("systemctl", ["--user", "stop", `${unit(v.window)}.timer`]);
    run("systemctl", ["--user", "reset-failed", `${unit(v.window)}.service`]);
    run(NODE, [BOX, "release"]);
    out(`disarmed ${unit(v.window)}; hold released`);
    return 0;
  }

  err("usage: preflight | arm | restore | disarm (see the file header)");
  return 2;
}

function invokedDirectly() {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}
if (invokedDirectly()) main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e.stack || e.message); process.exit(1); });
```

The test's `fakeRun` matches on substrings of `"<cmd> <args…>"`, so `NODE` paths in the joined key are irrelevant to the assertions.

- [ ] **Step 4: Run, expect PASS.** `npm test -- tests/models-window.test.js`

- [ ] **Step 5: Commit.**

```bash
git add scripts/ops/models-window.mjs tests/models-window.test.js
git commit scripts/ops/models-window.mjs tests/models-window.test.js -m "feat(ops): models-window — preflight, box hold + out-of-process deadman, restore that works with the gateway down"
```

---

### Task 4: `scripts/bench/voice-runtime-bench.mjs`

Spec §11.5. Same prompts, same `max_tokens`, streaming, against two OpenAI-compatible endpoints; 1, 4 and 8 concurrent streams; TTFT p50/p95 and decode tok/s (per stream and aggregate); one tool-call sanity request per endpoint.

**Files:**
- Create: `scripts/bench/voice-runtime-bench.mjs`
- Test: `tests/voice-runtime-bench.test.js`

**Interfaces:**
- Produces: `parseSseTimings(chunks: Array<{ at: number, text: string }>, startAt) -> { ttftMs, tokens, decodeMs }` (counts streamed content deltas as tokens; uses `usage.completion_tokens` when the final frame carries it); `summarize(samples) -> { n, ttft_p50, ttft_p95, tps_stream_p50, tps_aggregate }`; `runLevel({ url, model, headers, concurrency, rounds, prompts, maxTokens, fetchFn, nowFn }) -> summary`; `main(argv)` — `--a <label>=<baseUrl>|<model>` and `--b …`, `--levels 1,4,8`, `--rounds 3`, `--max-tokens 128`, `--prompt-set voice|code`, `--out <dir>` writes `voice-bench-<ts>.json` and `.md`.

- [ ] **Step 1: Write the failing test.**

```js
// tests/voice-runtime-bench.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { parseSseTimings, summarize, runLevel } from "../scripts/bench/voice-runtime-bench.mjs";

test("parseSseTimings: TTFT from the first content delta, tokens from usage when present", () => {
  const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;
  const chunks = [
    { at: 1010, text: sse({ choices: [{ delta: { role: "assistant" } }] }) },
    { at: 1050, text: sse({ choices: [{ delta: { content: "Hel" } }] }) },
    { at: 1060, text: sse({ choices: [{ delta: { content: "lo" } }] }) + sse({ choices: [{ delta: {} , finish_reason: "stop" }], usage: { completion_tokens: 3 } }) },
    { at: 1150, text: "data: [DONE]\n\n" },
  ];
  assert.deepEqual(parseSseTimings(chunks, 1000), { ttftMs: 50, tokens: 3, decodeMs: 100 });
});

test("summarize: percentiles and aggregate throughput", () => {
  const s = summarize([
    { ttftMs: 100, tokens: 100, decodeMs: 1000, startedAt: 0, endedAt: 1100 },
    { ttftMs: 200, tokens: 100, decodeMs: 2000, startedAt: 0, endedAt: 2200 },
  ]);
  assert.equal(s.n, 2);
  assert.equal(s.ttft_p50, 100);
  assert.equal(s.ttft_p95, 200);
  assert.equal(s.tps_stream_p50, 50);
  assert.equal(s.tps_aggregate, Math.round((200 / 2.2) * 10) / 10);
});

test("runLevel drives N concurrent streams against a stub server", async () => {
  let inflight = 0, peak = 0;
  const srv = http.createServer((req, res) => {
    inflight++; peak = Math.max(peak, inflight);
    res.writeHead(200, { "content-type": "text/event-stream" });
    setTimeout(() => {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "x" } }] })}\n\n`);
      res.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`);
      inflight--;
    }, 20);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const s = await runLevel({ url: `http://127.0.0.1:${srv.address().port}/v1`, model: "m", headers: {}, concurrency: 4, rounds: 2, prompts: ["hi"], maxTokens: 8 });
    assert.equal(s.n, 8);
    assert.equal(peak, 4);
  } finally { srv.close(); }
});
```

- [ ] **Step 2: Run, expect FAIL.** `npm test -- tests/voice-runtime-bench.test.js`

- [ ] **Step 3: Implement.**

```js
#!/usr/bin/env node
// scripts/bench/voice-runtime-bench.mjs
/**
 * Voice runtime benchmark (spec §11.5): the same Qwen3.5-4B behind two
 * OpenAI-compatible endpoints (vLLM BF16 and llama-server Q8_0), 1/4/8
 * concurrent streams, TTFT p50/p95 and decode tok/s. Kevin decides the voice
 * runtime from the table this prints.
 *
 *   node scripts/bench/voice-runtime-bench.mjs \
 *     --a "vllm=http://100.118.41.122:8011/v1|qwen3.5-4b" \
 *     --b "llamacpp-q8=http://127.0.0.1:18990/v1|qwen3.5-4b" \
 *     --levels 1,4,8 --rounds 3 --max-tokens 128 --out ~/llm/bench/voice
 */
import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const PROMPTS = [
  "In two sentences, what should I pack for a rainy day hike?",
  "Turn on some quiet music and tell me what you picked.",
  "Summarize: the meeting moved to Thursday at 3 pm in room 204, bring the budget sheet.",
  "¿Cuál es la capital de Australia y por qué no es Sídney?",
  "Give me a one-line reminder to call the dentist tomorrow morning.",
  "What is 17 times 23? Answer with just the number and one short sentence.",
  "Suggest a dinner I can cook in 20 minutes with eggs, spinach and rice.",
  "Explain in one sentence what a VPN does.",
];

/** W3's acceptance prompts: single-stream code generation (spec §7 step 3, ~70 tok/s baseline). */
export const CODE_PROMPTS = [
  "Write a Python function that parses an ISO-8601 date string and returns the weekday name, with three unit tests.",
  "Write a JavaScript debounce(fn, ms) with a cancel() method and JSDoc.",
  "Write a SQL query that returns the top 5 customers by total order value in 2025, with the schema you assume.",
];

export function parseSseTimings(chunks, startAt) {
  let first = null, last = null, deltas = 0, usage = null, buf = "";
  for (const { at, text } of chunks) {
    buf += text;
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, i); buf = buf.slice(i + 2);
      const line = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") { last = at; continue; }
      let j; try { j = JSON.parse(data); } catch { continue; }
      if (j.usage && Number.isFinite(j.usage.completion_tokens)) usage = j.usage.completion_tokens;
      const c = j.choices?.[0]?.delta?.content;
      if (typeof c === "string" && c.length) { deltas++; if (first === null) first = at; }
      last = at;
    }
  }
  return { ttftMs: first === null ? null : first - startAt, tokens: usage ?? deltas, decodeMs: first === null || last === null ? null : last - first };
}

const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : null; };

export function summarize(samples) {
  const ok = samples.filter((s) => s.ttftMs !== null);
  const tps = ok.filter((s) => s.decodeMs > 0).map((s) => Math.round((s.tokens / (s.decodeMs / 1000)) * 10) / 10);
  const span = ok.length ? (Math.max(...ok.map((s) => s.endedAt)) - Math.min(...ok.map((s) => s.startedAt))) / 1000 : 0;
  const total = ok.reduce((a, s) => a + s.tokens, 0);
  return { n: ok.length, ttft_p50: pct(ok.map((s) => s.ttftMs), 50), ttft_p95: pct(ok.map((s) => s.ttftMs), 95),
    tps_stream_p50: pct(tps, 50), tps_aggregate: span > 0 ? Math.round((total / span) * 10) / 10 : null };
}

async function oneStream({ url, model, headers, prompt, maxTokens, fetchFn, nowFn }) {
  const startedAt = nowFn();
  const res = await fetchFn(`${url}/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model, stream: true, stream_options: { include_usage: true }, max_tokens: maxTokens, temperature: 0,
      chat_template_kwargs: { enable_thinking: false }, messages: [{ role: "user", content: prompt }] }),
  });
  const chunks = [];
  const dec = new TextDecoder();
  for await (const part of res.body) chunks.push({ at: nowFn(), text: dec.decode(part, { stream: true }) });
  return { ...parseSseTimings(chunks, startedAt), startedAt, endedAt: nowFn() };
}

export async function runLevel({ url, model, headers = {}, concurrency, rounds, prompts = PROMPTS, maxTokens, fetchFn = fetch, nowFn = () => performance.now() }) {
  const samples = [];
  for (let r = 0; r < rounds; r++) {
    const batch = Array.from({ length: concurrency }, (_, k) => oneStream({ url, model, headers, prompt: prompts[(r * concurrency + k) % prompts.length], maxTokens, fetchFn, nowFn })
      .catch(() => ({ ttftMs: null, tokens: 0, decodeMs: null, startedAt: 0, endedAt: 0 })));
    samples.push(...(await Promise.all(batch)));
  }
  return summarize(samples);
}

async function toolSanity({ url, model }) {
  const r = await fetch(`${url}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    model, max_tokens: 256, temperature: 0, chat_template_kwargs: { enable_thinking: false },
    tools: [{ type: "function", function: { name: "play_music", description: "Play music", parameters: { type: "object", properties: { genre: { type: "string" } }, required: ["genre"] } } }],
    messages: [{ role: "user", content: "Play some jazz." }] }) });
  const j = await r.json().catch(() => ({}));
  const call = j.choices?.[0]?.message?.tool_calls?.[0]?.function;
  return call ? `${call.name}(${call.arguments})` : `no tool call (finish ${j.choices?.[0]?.finish_reason ?? "?"})`;
}

function parseTarget(s) {
  const [label, rest] = s.split("=");
  const [url, model] = rest.split("|");
  return { label, url: url.replace(/\/+$/, ""), model };
}

export async function main(argv) {
  const { values } = parseArgs({ args: argv, options: { a: { type: "string" }, b: { type: "string" }, levels: { type: "string", default: "1,4,8" }, rounds: { type: "string", default: "3" }, "max-tokens": { type: "string", default: "128" }, "prompt-set": { type: "string", default: "voice" }, out: { type: "string" } } });
  const prompts = values["prompt-set"] === "code" ? CODE_PROMPTS : PROMPTS;
  const targets = [values.a, values.b].filter(Boolean).map(parseTarget);
  const levels = values.levels.split(",").map(Number);
  const result = { at: new Date().toISOString(), levels, rounds: Number(values.rounds), maxTokens: Number(values["max-tokens"]), targets: [] };
  for (const t of targets) {
    const row = { ...t, tool: await toolSanity(t).catch((e) => `error ${e.message}`), levels: {} };
    for (const c of levels) row.levels[c] = await runLevel({ url: t.url, model: t.model, concurrency: c, rounds: result.rounds, maxTokens: result.maxTokens, prompts });
    result.targets.push(row);
  }
  const md = ["| target | users | TTFT p50 ms | TTFT p95 ms | tok/s per stream p50 | tok/s aggregate | n |", "|---|---|---|---|---|---|---|"];
  for (const t of result.targets) for (const c of levels) { const s = t.levels[c]; md.push(`| ${t.label} | ${c} | ${Math.round(s.ttft_p50 ?? NaN)} | ${Math.round(s.ttft_p95 ?? NaN)} | ${s.tps_stream_p50} | ${s.tps_aggregate} | ${s.n} |`); }
  md.push("", ...result.targets.map((t) => `- ${t.label} tool call: ${t.tool}`));
  console.log(md.join("\n"));
  if (values.out) {
    mkdirSync(values.out, { recursive: true });
    const stamp = result.at.replace(/[:.]/g, "-");
    writeFileSync(join(values.out, `voice-bench-${stamp}.json`), JSON.stringify(result, null, 2));
    writeFileSync(join(values.out, `voice-bench-${stamp}.md`), md.join("\n") + "\n");
  }
  return 0;
}

function invokedDirectly() {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}
if (invokedDirectly()) main(process.argv.slice(2)).then((c) => process.exit(c));
```

- [ ] **Step 4: Run, expect PASS.** `npm test -- tests/voice-runtime-bench.test.js`

- [ ] **Step 5: Commit, then full suite, push, PR (Tasks 1–4 are one PR).**

```bash
git add scripts/bench/voice-runtime-bench.mjs tests/voice-runtime-bench.test.js
git commit scripts/bench/voice-runtime-bench.mjs tests/voice-runtime-bench.test.js -m "feat(bench): voice runtime benchmark — TTFT and tok/s at 1/4/8 users, tool-call sanity"
npm test
git pull --rebase origin main && git push -u origin feat/models-migrate-ops
```

PR (github MCP): `feat(ops): models migration tooling — models-migrate, models-window deadman, voice bench, YaRN ceiling, unmanaged-row convert (arc plan 4/4, part 1)`. Gate on check-runs; merge; the product changes in Task 1 deploy through auto-update only when the box is free.

---

### Task 5: Retirement PR (W6) — delete what migrated

Runs only after every window it depends on closed clean and held for 48 hours. Branch `feat/models-retire-crow-bundles`.

**Which bundles go** (spec §7 step 6 as amended by §11.5/§11.9):

| bundle | deleted when |
|---|---|
| `bundles/llamacpp-vulkan-qwen3-embed`, `bundles/llamacpp-cpu-qwen3-embed` | W1 closed clean |
| `bundles/llamacpp-vulkan-qwen36-35b-a3b` | W3 closed clean |
| `bundles/vllm-rocm-qwen35-4b` | W2 ran (llama.cpp won the benchmark). If vLLM won, it stays, PR #390 merges, and this row is skipped. |

Never deleted here: `vllm-cuda-*`, the orchestrator's docker branch, the `inference` contract (spec §7 step 6).

**Files:**
- Delete: the bundle directories above
- Modify: `registry/add-ons.json` (regenerated), `docs/developers/port-allocation.md` (row `8007 llamacpp-cpu-qwen3-embed`, and any row naming a deleted bundle), tests that read a deleted bundle's files
- Create: `scripts/ops/models-retire-installed.mjs`
- Test: `tests/models-retire-installed.test.js`

**Interfaces:**
- Produces: `planRetirement({ installed, retiredIds, bundlesDir, existsFn }) -> { keepInstalled, removeIds, removeDirs }` (pure); `main(argv, deps)`: `--ids a,b,c` (required), `--apply` (default is dry-run printing the plan), `--crow-home <dir>` (default `CROW_HOME` or `~/.crow`).

- [ ] **Step 1: Write the failing test.**

```js
// tests/models-retire-installed.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planRetirement, main } from "../scripts/ops/models-retire-installed.mjs";

const INSTALLED = [
  { id: "maker-lab", type: "mcp-server", version: "0.1.0" },
  { id: "llamacpp-vulkan-qwen36-35b-a3b", type: "bundle", version: "1.0.0" },
  { id: "companion", type: "bundle", version: "1.2.0" },
];

test("planRetirement removes only the listed ids and only existing copies", () => {
  const p = planRetirement({ installed: INSTALLED, retiredIds: ["llamacpp-vulkan-qwen36-35b-a3b", "llamacpp-vulkan-qwen3-embed"], bundlesDir: "/h/.crow/bundles",
    existsFn: (d) => d.endsWith("llamacpp-vulkan-qwen36-35b-a3b") || d.endsWith("llamacpp-vulkan-qwen3-embed") });
  assert.deepEqual(p.keepInstalled.map((e) => e.id), ["maker-lab", "companion"]);
  assert.deepEqual(p.removeIds, ["llamacpp-vulkan-qwen36-35b-a3b"]);
  assert.deepEqual(p.removeDirs, ["/h/.crow/bundles/llamacpp-vulkan-qwen36-35b-a3b", "/h/.crow/bundles/llamacpp-vulkan-qwen3-embed"]);
});

test("dry-run by default; --apply rewrites installed.json (0600) and removes the copies", async () => {
  const home = mkdtempSync(join(tmpdir(), "retire-"));
  try {
    writeFileSync(join(home, "installed.json"), JSON.stringify(INSTALLED));
    mkdirSync(join(home, "bundles", "llamacpp-vulkan-qwen36-35b-a3b"), { recursive: true });
    const out = [];
    assert.equal(await main(["--ids", "llamacpp-vulkan-qwen36-35b-a3b", "--crow-home", home], { out: (s) => out.push(s) }), 0);
    assert.ok(existsSync(join(home, "bundles", "llamacpp-vulkan-qwen36-35b-a3b")), "dry-run touched nothing");
    assert.match(out.join("\n"), /DRY RUN/);
    assert.equal(await main(["--ids", "llamacpp-vulkan-qwen36-35b-a3b", "--crow-home", home, "--apply"], { out: () => {} }), 0);
    assert.deepEqual(JSON.parse(readFileSync(join(home, "installed.json"), "utf8")).map((e) => e.id), ["maker-lab", "companion"]);
    assert.equal(existsSync(join(home, "bundles", "llamacpp-vulkan-qwen36-35b-a3b")), false);
    assert.ok(existsSync(join(home, "installed.json.pre-retire")), "a backup is kept");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("refuses ids that are not model bundles of this arc", async () => {
  assert.equal(await main(["--ids", "companion"], { out: () => {}, err: () => {} }), 1);
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement.**

```js
#!/usr/bin/env node
// scripts/ops/models-retire-installed.mjs
/**
 * After the retirement PR deletes a model bundle from the repo, remove its
 * installed.json entry and its ~/.crow/bundles copy (spec §7 step 6). Dry-run
 * unless --apply. Only the arc's model bundles are accepted.
 */
import { parseArgs } from "node:util";
import { readFileSync, writeFileSync, copyFileSync, existsSync, rmSync, chmodSync, renameSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const RETIRABLE = new Set(["llamacpp-vulkan-qwen36-35b-a3b", "llamacpp-vulkan-qwen3-embed", "llamacpp-cpu-qwen3-embed", "vllm-rocm-qwen35-4b"]);

export function planRetirement({ installed, retiredIds, bundlesDir, existsFn = existsSync }) {
  const ids = new Set(retiredIds);
  return {
    keepInstalled: installed.filter((e) => !ids.has(e.id)),
    removeIds: installed.filter((e) => ids.has(e.id)).map((e) => e.id),
    removeDirs: retiredIds.map((id) => join(bundlesDir, id)).filter((d) => existsFn(d)),
  };
}

export async function main(argv, deps = {}) {
  const out = deps.out || console.log;
  const err = deps.err || console.error;
  const { values } = parseArgs({ args: argv, options: { ids: { type: "string" }, apply: { type: "boolean" }, "crow-home": { type: "string" } } });
  const ids = (values.ids || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!ids.length) { err("usage: --ids a,b [--apply] [--crow-home <dir>]"); return 2; }
  const bad = ids.filter((id) => !RETIRABLE.has(id));
  if (bad.length) { err(`refusing non-arc ids: ${bad.join(", ")}`); return 1; }
  const home = values["crow-home"] || process.env.CROW_HOME || join(homedir(), ".crow");
  const path = join(home, "installed.json");
  const installed = JSON.parse(readFileSync(path, "utf8"));
  const plan = planRetirement({ installed, retiredIds: ids, bundlesDir: join(home, "bundles") });
  out(`${values.apply ? "APPLY" : "DRY RUN"}: remove installed entries [${plan.removeIds.join(", ")}], remove dirs [${plan.removeDirs.join(", ")}]`);
  if (!values.apply) return 0;
  copyFileSync(path, `${path}.pre-retire`);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(plan.keepInstalled, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  for (const d of plan.removeDirs) rmSync(d, { recursive: true, force: true });
  out(`done; backup at ${path}.pre-retire`);
  return 0;
}

function invokedDirectly() {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}
if (invokedDirectly()) main(process.argv.slice(2)).then((c) => process.exit(c));
```

- [ ] **Step 4: Delete the bundles and fix what referenced their files.**

```bash
git rm -r bundles/llamacpp-vulkan-qwen3-embed bundles/llamacpp-cpu-qwen3-embed bundles/llamacpp-vulkan-qwen36-35b-a3b
# only if W2 ran:
# git rm -r bundles/vllm-rocm-qwen35-4b
npm run build-registry
git grep -l -e llamacpp-vulkan-qwen36-35b-a3b -e llamacpp-vulkan-qwen3-embed -e llamacpp-cpu-qwen3-embed -- tests scripts servers docs
```

For every hit: a test that **reads the bundle's files** (`bundles/<id>/manifest.json` or its compose) is changed to use a fixture bundle under `tests/fixtures/` or dropped if it tested only that bundle's own manifest; a test or module that uses the id as an **opaque string** stays. `tests/fixtures/launch-parity/*.json` stay (they are the record of the retired commands). In `docs/developers/port-allocation.md` delete the `8007 | 127.0.0.1 | llamacpp-cpu-qwen3-embed` row and any row naming a deleted bundle. Then `node scripts/check-port-allocation.js` and `node scripts/build-registry.mjs --check` pass.

- [ ] **Step 5: Full suite, commit, PR, gate.**

```bash
npm test
git add scripts/ops/models-retire-installed.mjs tests/models-retire-installed.test.js
# Directory paths are positional too: in this dedicated worktree, `tests` and `bundles` hold only this task's changes.
git commit scripts/ops/models-retire-installed.mjs tests registry/add-ons.json docs/developers/port-allocation.md bundles -m "chore(models): retire crow's migrated model bundles; installed.json cleanup script"
git show --stat HEAD   # the deleted bundle directories, the regenerated registry and every touched test must be listed
git pull --rebase origin main && git push -u origin feat/models-retire-crow-bundles
```

PR, check-runs gate, merge. The post-merge operational steps are in runbook W6.

---

## Window calendar

Re-read `~/CROW-SCHEDULE.md` before choosing; the dates below are the earliest that fit the bookings known on 2026-10-02 and the dependencies. All are weekdays, 09:00–16:30, outside the Engram queue's hours, never 02:15–04:15, one per day.

| window | earliest slot | cap | depends on | degrades |
|---|---|---|---|---|
| W0 voice benchmark | Mon 2026-10-05 10:00 | 40 min | Task 4 on a branch (not merged), the Q8_0 GGUF and the b10068 release downloaded in prep | nothing stops; GPU contention with live voice for ~30 min |
| W1 crow-embed | Tue 2026-10-06 10:00 | 60 min | plan 2 merged + Op 3 passed; this plan's PR merged | embeddings for ~5 min (crow, r4, raven) |
| W2 crow-voice | Wed 2026-10-07 10:00 | 60 min | W0 result + **Kevin chose llama.cpp** | voice/companion fast path for ~5 min |
| W3 crow-chat (35B) | Thu 2026-10-08 10:00 | 90 min | W1 clean; MTP runtime check in prep | the 35B (bots, escalations degrade to the fast model) for ~10–20 min |
| W4 27B 512k | Fri 2026-10-09 10:00 | 60 min | W3 clean; **Kevin's answer to Q1** (27B weights) | evicts the 35B for the test, ~15 min |
| W4b gufo slots catalog-managed (optional) | the next free weekday after plan 3 merged | 90 min | plan 3 merged; Q1 and Q2 answered | evicts the 35B while the solo 27B is tested |
| W5 gemma for r4 | the next free weekday after W4 | 45 min | r4-tehcy coordinated (ASK_LLM_URL owner) | r4's ask-generation for ~5 min |
| W6 retire | after W1/W3 (and W2 if run) held 48 h | 30 min | Task 5 PR merged | none (removes stopped containers' installs) |

Saturday 2026-10-03 is out for every window (pi-lab raven smoke 08:00–10:30, then the Engram weekend queue). Friday nights are pi-lab's raven windows (raven only; they do not block crow daytime slots).

## Runbooks

Shared variables for every runbook (set in the window's shell):

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v24.21.0/bin:$PATH
cd ~/crow
TOKEN=$(cat ~/.crow/models-token)
MM="node scripts/ops/models-migrate.mjs"
MW="node scripts/ops/models-window.mjs"
lifecycle() { curl -s -m 30 -X "$1" -H "authorization: Bearer $TOKEN" "http://127.0.0.1:3001/llm/models$2"; }
native_port() { lifecycle GET "" | node -pe 'const m=JSON.parse(require("fs").readFileSync(0)).models.find((x)=>x.provider===process.argv[1]); m && m.argv ? m.argv[m.argv.indexOf("--port")+1] : ""' "$1"; }
wait_job() { for i in $(seq 1 120); do s=$(lifecycle GET "/jobs/$1" | node -pe 'JSON.parse(require("fs").readFileSync(0)).state'); echo "$s"; case "$s" in resident) return 0;; failed|blocked_by_reservation) return 1;; esac; sleep 5; done; return 1; }
```

### W0 — voice runtime benchmark (~30 min, cap 40)

**Purpose:** spec §11.5. Same Qwen3.5-4B: vLLM 0.23 BF16 (the live `vllm-rocm-qwen35-4b`, `:8011`) vs llama.cpp Q8_0 (a temporary llama-server on loopback `:18990`, the stock b10068 Vulkan release the native path would use). Nothing in prod stops.

**Prep (any time before, no GPU, no prod effect; disk only):**

```bash
mkdir -p ~/llm/hf-cache/qwen35-4b ~/llm/bench/voice/llama-b10068
curl -L --fail -o ~/llm/hf-cache/qwen35-4b/Qwen3.5-4B-Q8_0.gguf https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q8_0.gguf
echo "10cc391b403021dd11c614679d2fd92f611c3681d29e29651b717316965d61e1  $HOME/llm/hf-cache/qwen35-4b/Qwen3.5-4B-Q8_0.gguf" | sha256sum -c -
curl -L --fail -o /tmp/llama-b10068-vulkan.tar.gz https://github.com/ggml-org/llama.cpp/releases/download/b10068/llama-b10068-bin-ubuntu-vulkan-x64.tar.gz
echo "713641920dce6c8efb953ebc9ffa309977e200cec5e182e6ad0e8b086203cdc3  /tmp/llama-b10068-vulkan.tar.gz" | sha256sum -c -
tar -xzf /tmp/llama-b10068-vulkan.tar.gz -C ~/llm/bench/voice/llama-b10068
LS=$(find ~/llm/bench/voice/llama-b10068 -name llama-server -type f | head -1); "$LS" --version; "$LS" --help | grep -c -- --no-op-offload
```

If `--no-op-offload` is absent from the help, drop it from the command below (the native path would fail the same way; record it as a finding for W2).

**CROW-SCHEDULE row:**

```
| **2026-10-05 (Mon) 10:00 → 10:30, hard cap 40 min (unit RuntimeMaxSec)** | **voice runtime benchmark (models arc W0)**: vLLM 0.23 BF16 (:8011, live, untouched) vs llama.cpp b10068 Q8_0 on 127.0.0.1:18990 (temporary user unit `voice-bench-llamacpp`, -c 65536 -np 8), 1/4/8 users, TTFT + tok/s. Nothing in prod stops; GPU shared with live voice for ~30 min. | Claude session (crow) | `systemd-run --user --unit=voice-bench-llamacpp -p RuntimeMaxSec=2400` + `scripts/bench/voice-runtime-bench.mjs` | voice-bench-llamacpp inactive AND :8011 /v1/models 200 AND the result table is in this row |
```

**Steps:**
0. Work from the plan 4 worktree (the bench script is on its branch until the PR merges): `cd ~/crow-wt-models-migrate`.
1. `node ~/crow/scripts/ops/box-reserve.mjs status` prints `none`, and `systemctl --user list-units --state=active 'engram-*' --no-legend` prints nothing (otherwise another job owns the GPU: pick another slot).
2. Start the llama.cpp side as its own deadman (the unit dies at 40 min no matter what):
   ```bash
   systemd-run --user --unit=voice-bench-llamacpp -p RuntimeMaxSec=2400 --collect \
     "$LS" -m ~/llm/hf-cache/qwen35-4b/Qwen3.5-4B-Q8_0.gguf --alias qwen3.5-4b --host 127.0.0.1 --port 18990 \
     -c 65536 -np 8 -ngl 999 -fa on --no-mmap --no-op-offload --jinja
   for i in $(seq 1 60); do curl -sf -m 2 http://127.0.0.1:18990/health && break; sleep 2; done
   ```
   (`-c 65536 -np 8` gives each of 8 slots 8192 tokens, the same per-sequence budget as vLLM's `--max-model-len 8192 --max-num-seqs 8`.)
3. Run the benchmark:
   ```bash
   node scripts/bench/voice-runtime-bench.mjs \
     --a "vllm-0.23-bf16=http://100.118.41.122:8011/v1|qwen3.5-4b" \
     --b "llamacpp-b10068-q8_0=http://127.0.0.1:18990/v1|qwen3.5-4b" \
     --levels 1,4,8 --rounds 3 --max-tokens 128 --out ~/llm/bench/voice
   ```
4. `systemctl --user stop voice-bench-llamacpp`; confirm `curl -sf http://100.118.41.122:8011/v1/models` is 200.
5. Paste the table into the CROW-SCHEDULE row and move it to Done; write the table into the PR or a reply to Kevin with the two tool-call lines.

**Acceptance:** both targets have `n` = rounds × users at every level (no failed streams), and both tool-call lines show `play_music(...)`. A target with failed streams is re-run once; a second failure is reported as a result, not retried.

**Decision rule offered to Kevin (he decides):** llama.cpp Q8_0 replaces vLLM only if its TTFT p50 at 1 user is not worse than vLLM's by more than 20 % and its aggregate tok/s at 8 users is at least 80 % of vLLM's, and its tool call works. Otherwise vLLM stays (merge PR #390, skip W2, keep the bundle out of W6).

**Rollback:** `systemctl --user stop voice-bench-llamacpp` (the unit also stops itself at the cap).

### W1 — crow-embed to native (cap 60)

**Prep (read-only):**

```bash
EMBED_CT=$(docker ps --filter publish=8004 --format '{{.Names}}' | head -1); echo "$EMBED_CT"   # expected llamacpp-vulkan-qwen3-embed
EMBED_GGUF=/home/kh0pp/llm/hf-cache/qwen3-embedding-0.6b/Qwen3-Embedding-0.6B-Q8_0.gguf
$MM verify --catalog qwen3-embedding-0.6b --quant Q8_0 --path "$EMBED_GGUF"
$MM status --provider crow-embed
R4_EMBED_URL=$(CROW_DATA_DIR=/home/kh0pp/.crow-r4/data $MM status --provider crow-embed | node -pe 'JSON.parse(require("fs").readFileSync(0))[0].base_url'); echo "$R4_EMBED_URL"
mkdir -p ~/llm/bench
embed_dump() { node -e '
const [url, out] = process.argv.slice(1);
const texts = ["the meeting moved to Thursday", "buy oat milk", "Strix Halo GTT", "¿dónde está la biblioteca?", "crow memory recall test"];
(async () => { const r = await fetch(url + "/embeddings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "qwen3-embedding-0.6b", input: texts }) });
  require("fs").writeFileSync(out, JSON.stringify((await r.json()).data.map((d) => d.embedding))); console.log("saved", out); })();' "$1" "$2"; }
embed_dump http://100.118.41.122:8004/v1 ~/llm/bench/embed-baseline.json
ssh raven 'curl -s -m 10 -o /dev/null -w "%{http_code}\n" http://100.118.41.122:3001/llm/health'   # must print 200
```

**CROW-SCHEDULE row:**

```
| **<date> (<day>) 10:00 → 10:45, hard cap 60 min (deadman models-w1-deadman)** | **models arc W1: crow-embed → native llama-server** (adopt hf-cache Q8_0 in place, convert the unmanaged row, stop <EMBED_CT>, start native through /llm/models; r4's own crow-embed row → crow's door). Embeddings on crow/r4/raven dark ~5 min. | Claude session (crow) | scripts/ops/models-window.mjs + models-migrate.mjs | crow-embed resident native OR restored to <EMBED_CT> AND no models-w1-deadman timer AND no box hold AND this row moved to Done |
```

**Steps:**
1. `$MW preflight`
2. `$MW arm --window w1 --cap-min 60 --provider crow-embed --container "$EMBED_CT" --r4-repoint "$R4_EMBED_URL"`
3. `$MM adopt --catalog qwen3-embedding-0.6b --quant Q8_0 --path "$EMBED_GGUF" --provider crow-embed --no-group --always-resident --convert-unmanaged`
4. `docker stop "$EMBED_CT"`; `sleep 35` (the gateway's provider cache is 30 s).
5. `JOB=$(lifecycle POST /crow-embed/start | node -pe 'JSON.parse(require("fs").readFileSync(0)).job_id'); wait_job "$JOB"`
6. `CROW_DATA_DIR=/home/kh0pp/.crow-r4/data $MM repoint --provider crow-embed --base-url http://100.118.41.122:3001/llm/p/crow-embed/v1`

**Acceptance:**
1. `lifecycle GET ""` shows `crow-embed` `resident` with an argv containing `--embedding` and `--pooling mean`.
2. Vectors match the container's: `embed_dump http://127.0.0.1:3001/llm/p/crow-embed/v1 ~/llm/bench/embed-new.json`, then
   `node -e 'const a=require(process.env.HOME+"/llm/bench/embed-baseline.json"), b=require(process.env.HOME+"/llm/bench/embed-new.json"); const cos=(x,y)=>{let d=0,n=0,m=0;for(let i=0;i<x.length;i++){d+=x[i]*y[i];n+=x[i]*x[i];m+=y[i]*y[i];}return d/Math.sqrt(n*m)}; const c=a.map((v,i)=>cos(v,b[i])); console.log(c); process.exit(c.every((x)=>x>=0.999)?0:1)'` exits 0.
3. The allow-list exemption works: the start in step 5 succeeded while the box was held by `models-w1` (spec §7 step 1).
4. From raven: `ssh raven "curl -s -m 20 http://100.118.41.122:3001/llm/p/crow-embed/v1/embeddings -H 'content-type: application/json' -d '{\"model\":\"qwen3-embedding-0.6b\",\"input\":\"hello\"}' | head -c 120"` returns an embedding. Use the provider path: the bare id is ambiguous while `grackle-embed` is enabled. raven's own consumers use the row's `base_url`, which is already the provider door.
5. A memory recall on crow (`crow_search_memories` with a query known to hit) returns results, and `journalctl -u crow-gateway --since "-10 min" | grep -i embed` shows no errors; on r4, `journalctl --user -u crow-r4-gateway --since "-10 min" | grep -i embed` (or the system unit, whichever r4 runs as) shows no errors.

**Close:** `$MW disarm --window w1`; `curl -sf http://100.118.41.122:8003/health` and `curl -sf http://100.118.41.122:8011/v1/models` are 200; move the row to Done with the acceptance results. Leave `$EMBED_CT` stopped (not removed) until W6.

**Rollback (any failure, or the deadman at 60 min):** `$MW restore --window w1 --provider crow-embed --container "$EMBED_CT" --r4-repoint "$R4_EMBED_URL"`.

### W2 — crow-voice to native (only if Kevin chose llama.cpp after W0; cap 60)

**Prep:** the Q8_0 GGUF from W0's prep; `$MM verify --catalog qwen3.5-4b --quant Q8_0 --path ~/llm/hf-cache/qwen35-4b/Qwen3.5-4B-Q8_0.gguf`. `adoptModel` requires a path for **every** catalog companion, and the catalog 4B lists an mmproj, so fetch it too (vision becomes available on crow-voice; the vLLM bundle ran with images disabled):

```bash
curl -L --fail -o ~/llm/hf-cache/qwen35-4b/mmproj-F16.gguf https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/mmproj-F16.gguf
echo "cd88edcf8d031894960bb0c9c5b9b7e1fea6ebee02b9f7ce925a00d12891f864  $HOME/llm/hf-cache/qwen35-4b/mmproj-F16.gguf" | sha256sum -c -
```
 If W0 showed `--no-op-offload` missing from b10068, set the host profile opt-out by adding `"no_op_offload": false` to the `--launch` below.

**CROW-SCHEDULE row:** as W1's, with `models arc W2: crow-voice → native llama-server Q8_0 (-c 65536 -np 8)`, `vllm-rocm-qwen35-4b` as the container, "voice/companion fast path dark ~5 min".

**Steps:**
1. `$MW preflight`; `$MW arm --window w2 --cap-min 60 --provider crow-voice --container vllm-rocm-qwen35-4b`
2. `$MM adopt --catalog qwen3.5-4b --quant Q8_0 --path ~/llm/hf-cache/qwen35-4b/Qwen3.5-4B-Q8_0.gguf --mmproj ~/llm/hf-cache/qwen35-4b/mmproj-F16.gguf --provider crow-voice --no-group --always-resident --launch '{"ctx":65536,"parallel":8,"jinja":true}'`
3. `docker stop vllm-rocm-qwen35-4b`; `sleep 35`; start through the lifecycle API and `wait_job`.

**Acceptance:**
1. A companion fast-path turn: `curl -s -m 60 http://127.0.0.1:3001/llm/v1/chat/completions -H 'content-type: application/json' -d '{"model":"qwen3.5-4b","messages":[{"role":"user","content":"Say hello in five words."}],"max_tokens":32}'` answers, and the gateway log shows `route=fast -> crow-voice/qwen3.5-4b`.
2. `node scripts/bench/voice-runtime-bench.mjs --a "native=http://127.0.0.1:$(native_port crow-voice)/v1|qwen3.5-4b" --levels 1,8 --rounds 2` is within 20 % of W0's llama.cpp TTFT p50 and aggregate tok/s, and its tool-call line shows a call.
3. If a glasses or companion device is available, one spoken turn works (optional; note it in the row).

**Close:** disarm; prod health checks; Done row. Kevin decides PR #390's fate (close it: voice no longer runs vLLM).

**Rollback:** `$MW restore --window w2 --provider crow-voice --container vllm-rocm-qwen35-4b`.

### W3 — crow-chat (35B) to native (cap 90)

**Prep (read-only):**

```bash
D=/home/kh0pp/llm/hf-cache/qwen36-35b-a3b-mtp
$MM verify --catalog qwen3.6-35b-a3b --quant UD-Q5_K_XL --path $D/Qwen3.6-35B-A3B-UD-Q5_K_XL.gguf
sha256sum $D/mmproj-F16.gguf   # must be 71f3cbc1f7cc0f30d09d41cfa924c0060827ebc33bf15ace7e86661e856f0160
# Does the runtime the native path will use support draft-mtp?
"$LS" --help 2>&1 | grep -c draft-mtp
for b in ~/llama-*/build/bin/llama-server; do echo "$b $("$b" --help 2>&1 | grep -c draft-mtp)"; done
# Baseline: the bundle, single stream, code prompts
node scripts/bench/voice-runtime-bench.mjs --a "bundle=http://100.118.41.122:8003/v1|qwen3.6-35b-a3b" --levels 1 --rounds 3 --max-tokens 512 --prompt-set code --out ~/llm/bench/chat
cp ~/.pi/agent/models.json ~/.pi/agent/models.json.pre-w3
```

If the stock release prints `0` for draft-mtp, pick an operator build that prints a non-zero count and set it for this model only (prep is fine: it changes nothing until a native start): `node scripts/models-runtime-override.mjs set --model qwen3.6-35b-a3b --bin <that build>`; record which build in the row (spec §7 step 3).

**CROW-SCHEDULE row:**

```
| **<date> (<day>) 10:00 → 11:15, hard cap 90 min (deadman models-w3-deadman)** | **models arc W3: crow-chat (35B) → native llama-server** (adopt hf-cache MTP Q5 + mmproj in place, convert the bundle row, stop llamacpp-vulkan-qwen36-35b-a3b, start native; pi models.json crow-local → provider door, backup kept). **The 35B is down ~10–20 min; escalations degrade to the fast model.** | Claude session (crow) | scripts/ops/models-window.mjs + models-migrate.mjs | crow-chat resident native OR the bundle container healthy on :8003 AND models.json is either the edited or the restored file AND no models-w3-deadman timer AND no box hold AND this row moved to Done |
```

**Steps:**
1. `$MW preflight`; `$MW arm --window w3 --cap-min 90 --provider crow-chat --container llamacpp-vulkan-qwen36-35b-a3b --models-json-backup ~/.pi/agent/models.json.pre-w3`
2. `$MM adopt --catalog qwen3.6-35b-a3b --quant UD-Q5_K_XL --path $D/Qwen3.6-35B-A3B-UD-Q5_K_XL.gguf --mmproj $D/mmproj-F16.gguf --provider crow-chat --group crow-strix-vram --default-member`
3. `docker stop -t 120 llamacpp-vulkan-qwen36-35b-a3b`; `sleep 35`; start `crow-chat` through the lifecycle API; `wait_job` (allow up to 10 min: 27 GB with `--no-mmap`).
4. Repoint pi's alias entry (pi-lab pre-agreed in the plan 2 handoff):
   ```bash
   node -e 'const f=process.env.HOME+"/.pi/agent/models.json"; const fs=require("fs"); const j=JSON.parse(fs.readFileSync(f,"utf8")); j.providers["crow-local"].baseUrl="http://100.118.41.122:3001/llm/p/crow-chat/v1"; fs.writeFileSync(f+".tmp", JSON.stringify(j,null,2)+"\n",{mode:0o600}); fs.renameSync(f+".tmp", f); console.log("crow-local ->", j.providers["crow-local"].baseUrl)'
   ```
   and make the DB `crow-local` row follow now instead of at the next hourly reconcile:
   `CROW_DATA_DIR=/home/kh0pp/.crow/data node --input-type=module -e 'import { createDbClient } from "./servers/db.js"; import { syncProvidersFromModelsJson } from "./servers/shared/providers-db.js"; const db = createDbClient(); console.log(await syncProvidersFromModelsJson(db)); db.close();'`

**Acceptance:**
1. `lifecycle GET ""`: `crow-chat` resident; argv has `--spec-type draft-mtp --spec-draft-n-max 2`, `--mmproj`, `-c 262144`.
2. Door, path form: `curl -s -m 120 http://127.0.0.1:3001/llm/p/crow-chat/v1/chat/completions -H 'content-type: application/json' -d '{"model":"qwen3.6-35b-a3b","messages":[{"role":"user","content":"Write a haiku about crows."}],"max_tokens":64}'` answers.
3. Escalation: the same request to `/llm/v1/chat/completions` with content `"!escalate what is 2+2"` logs `route=escalate(manual) -> crow-chat/qwen3.6-35b-a3b`.
4. A bot round-trip: one pi turn through the bridge for a test bot whose default model is `crow-local/qwen3.6-35b-a3b` (Bot Builder → the bot's Review tab → "Send test message", or the bot's channel), and the bridge log shows `model-resolve … crow-local/qwen3.6-35b-a3b` with no "Unknown provider".
5. Speed: `node scripts/bench/voice-runtime-bench.mjs --a "native=http://127.0.0.1:$(native_port crow-chat)/v1|qwen3.6-35b-a3b" --levels 1 --rounds 3 --max-tokens 512 --prompt-set code` gives single-stream tok/s ≥ 90 % of the prep baseline (spec: within 10 % of ~70).
6. Vision: `curl -s -m 120 http://127.0.0.1:3001/llm/p/crow-chat/v1/chat/completions -H 'content-type: application/json' -d '{"model":"qwen3.6-35b-a3b","max_tokens":32,"messages":[{"role":"user","content":[{"type":"text","text":"What color is this image?"},{"type":"image_url","image_url":{"url":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="}}]}]}'` answers (a 400 about images means the mmproj did not load).

If 5 fails with the stock release, restore (below), set the per-model override to the fastest operator build from prep, and re-run the window another day; record the numbers.

**Close:** disarm; health of `:8011` and the door; keep `models.json.pre-w3` for a week; Done row with the numbers and the runtime used. Send the plan 2 handoff's "after W3" settings change to pi-lab (`localModels` entry → gateway mode).

**Rollback:** `$MW restore --window w3 --provider crow-chat --container llamacpp-vulkan-qwen36-35b-a3b --models-json-backup ~/.pi/agent/models.json.pre-w3`, then run the `syncProvidersFromModelsJson` one-shot above so the DB `crow-local` row follows the restored file.

### W4 — 27B 512k variant to native (cap 60; gated on Kevin's Q1)

**Gate:** Kevin answered spec §11.11 Q1. The on-disk `Qwen3.8-27B-UD-Q6_K_XL.gguf` (sha `739202186fd9389bb58497c58b56c8a0d4253d99d20131e6a0427e363e678fc8`, 25,924,152,384 bytes, the pre-2026-08-19 cut with in-GGUF MTP) is 2.4 % larger than the catalog's current UD-Q6_K_XL and cannot be adopted under it.
- **If "add a catalog entry":** a small PR first. The file no longer exists on Hugging Face and the validator requires unique basenames within a model, so the entry is **adopt-only** under a distinct name: add to `qwen3.8-27b.quants` `{ "file": "Qwen3.8-27B-UD-Q6_K_XL.pre-0819.gguf", "quant": "UD-Q6_K_XL-pre0819", "size_mb": 25924.15, "min_ram_mb": 35026, "min_vram_mb": 0, "sha256": "739202186fd9389bb58497c58b56c8a0d4253d99d20131e6a0427e363e678fc8", "adopt_only": true }` (min_ram_mb = the current Q6's 34401 + the 625 MB size difference). The same PR teaches `scripts/validate-model-catalog.js` to accept `adopt_only: true` on a quant, `POST /api/models/download` to refuse such a quant with `409 ADOPT_ONLY`, and the curated card to hide Download for it (one i18n pair, `models.adoptOnly`: "Adopt from disk only" / "Solo adoptar desde el disco"), each with a test (write that PR as its own two-task writing-plans pass once Kevin answers; it is not built speculatively). Adopt passes the real on-disk path; the registry records `path`, so the basename difference is harmless. Use `--quant UD-Q6_K_XL-pre0819`.
- **If "re-download":** download the current UD-Q6_K_XL (25.3 GB) to `~/llm/hf-cache/qwen38-27b-0819/` in prep and adopt that; the gufo slots keep using the old file.

Set the two shell variables W4 and W4b use, per the answer:

```bash
# answer "add a catalog entry":
Q27=UD-Q6_K_XL-pre0819; F27=/home/kh0pp/llm/hf-cache/qwen38-27b/Qwen3.8-27B-UD-Q6_K_XL.gguf
# answer "re-download":
Q27=UD-Q6_K_XL;         F27=/home/kh0pp/llm/hf-cache/qwen38-27b-0819/Qwen3.8-27B-UD-Q6_K_XL.gguf
```

*(Ruling)* The variant migrates **without** `--spec-type draft-mtp`: the catalog 27B has no `mtp` tag, so `validateLaunch` refuses `spec` for it (spec §3.1 note); record decode tok/s and revisit when MTP for the 27B is settled.

**Prep:** `$MM verify` the chosen file; `sha256sum ~/llm/hf-cache/qwen38-27b/mmproj-F16.gguf` = `cbb841a9ee0636b2ec172f5bb8df2ea8dfeb01e90fe7c6126581d662a0b4e43e`; `cp ~/.pi/agent/models.json ~/.pi/agent/models.json.pre-w4`; check the runtime: the 512k slot ran on ROCm 7.2.3 llama.cpp; if the stock Vulkan release cannot load `-c 524288` in the W4 attempt, the fallback is a per-model override to an operator ROCm build (`~/llama-*/build/bin/llama-server`).

**CROW-SCHEDULE row:** `models arc W4: crow-local-27b-512k → native (YaRN x2, 524288)`, "evicts the 35B for ~15 min", container `llamacpp-vulkan-qwen38-27b-512k` (normally down; the restore leaves it down if it was down), deadman `models-w4-deadman`.

**Steps:**
1. `$MW preflight`; `$MW arm --window w4 --cap-min 60 --provider crow-local-27b-512k --allow crow-chat --models-json-backup ~/.pi/agent/models.json.pre-w4` (no `--container`: the 512k container is on-demand and stays down; `--allow crow-chat` lets step 5 bring the 35B back under the hold).
2. `$MM adopt --catalog qwen3.8-27b --quant "$Q27" --path "$F27" --mmproj ~/llm/hf-cache/qwen38-27b/mmproj-F16.gguf --provider crow-local-27b-512k --group crow-strix-vram --convert-unmanaged --launch '{"ctx":524288,"kv_type":"q8_0","parallel":1,"extra_args":["--rope-scaling","yarn","--rope-scale","2","--yarn-orig-ctx","262144","--override-kv","qwen35.context_length=int:524288","-b","2048","-ub","2048","-ctxcp","2","--cache-ram","0"]}'`
3. `sleep 35`; start `crow-local-27b-512k` (the job reports `evicting` while the 35B stops); `wait_job`.
4. pi's entry: the row's served alias is now the catalog id `qwen3.8-27b` (registerModel writes `models[0].id` from the catalog). Repoint and rename in `~/.pi/agent/models.json`: `crow-local-27b-512k.baseUrl = "http://100.118.41.122:3001/llm/p/crow-local-27b-512k/v1"`, `models[0].id = "qwen3.8-27b"` (same node one-liner pattern as W3).
5. After acceptance, start `crow-chat` again through the lifecycle API (it evicts the 512k) and `wait_job`.

**Acceptance:**
1. `curl -s http://127.0.0.1:$(native_port crow-local-27b-512k)/props | node -pe 'JSON.parse(require("fs").readFileSync(0)).default_generation_settings.n_ctx'` prints `524288` (verify context from `/props`, never from the flag).
2. A short chat through `/llm/p/crow-local-27b-512k/v1` answers; one image request answers.
3. The 35B is resident again after step 5 (`lifecycle GET ""`).

**Close:** disarm; Done row; send pi-lab the "after W4" settings change (key renamed to `crow-local-27b-512k/qwen3.8-27b`).

**Rollback:** `$MW restore --window w4 --provider crow-local-27b-512k --models-json-backup ~/.pi/agent/models.json.pre-w4`, then start `crow-chat` through the lifecycle API (or `docker start llamacpp-vulkan-qwen36-35b-a3b` if W3 was itself rolled back).

### W4b — gufo solo/copilot from external to catalog-managed (optional; after plan 3; Q1 and Q2 answered; cap 90)

**Prep:** confirm with pi-lab that the compose slots may move under Crow (pi-lab owns their deploy today, spec §11.3), and that no pi-lab job is using them during the slot. Do **not** record the gufo install before the window: it makes every later start of a gufo-capable catalog model on crow pick gufo.

**Steps (solo, then copilot):**
1. `$MW preflight`; `$MW arm --window w4b --cap-min 90 --provider crow-local-27b --allow crow-chat,crow-local-27b-copilot`
2. `$MM unmark-external --provider crow-local-27b`
3. `$MM adopt --catalog qwen3.8-27b --quant "$Q27" --path "$F27" --mmproj ~/llm/hf-cache/qwen38-27b/mmproj-F16.gguf --dflash ~/llm/hf-cache/qwen38-27b/Qwen3.8-27B-DFlash2-Q4_K_M.gguf --gufo-mmproj ~/llm/hf-cache/qwen38-27b/mmproj-bf16/mmproj-BF16.gguf --provider crow-local-27b --group crow-strix-vram --convert-unmanaged --runtime gufo`
4. `docker compose -f ~/crow-addons/llamacpp-vulkan-qwen38-27b/docker-compose.yml down` (if up); `node scripts/models-runtime-install.mjs set-gufo --root /home/kh0pp/gufo-prod`; `sleep 35`; start `crow-local-27b` via the lifecycle API.
5. Acceptance: `GET /llm/models` argv starts with `docker run --rm --name crow-rt-crow-local-27b` and contains `--speculative dflash2`; `pi-lab`'s `scripts/two-box/raven-gufo-compat.py` pointed at `http://127.0.0.1:3001/llm/p/crow-local-27b/v1` passes 7/7 (run by or with pi-lab).
6. Copilot: `$MM unmark-external --provider crow-local-27b-copilot`, then `$MM convert --catalog qwen3.8-27b --quant "$Q27" --provider crow-local-27b-copilot --no-group --convert-unmanaged --runtime gufo --runtime-launch '{"gufo":{"ctx":65536}}'` (it shares the solo row's registry entry and its runtime assets; `--no-group` keeps it co-resident with the 35B as today), `docker compose -f ~/crow-addons/llamacpp-vulkan-qwen38-27b-copilot/docker-compose.yml down`, start it through the lifecycle API, and repeat the compat check against `/llm/p/crow-local-27b-copilot/v1` (6/7 expected: text-only).
7. Close: disarm; restart the 35B if evicted; Done row.

**Rollback:** `$MW restore --window w4b --provider crow-local-27b` then `$MM mark-external --provider crow-local-27b --host crow --label gufo`, `node scripts/models-runtime-install.mjs clear --runtime gufo`, and `docker compose -f ~/crow-addons/llamacpp-vulkan-qwen38-27b/docker-compose.yml up -d` only if it was up before.

### W5 — gemma for r4 (cap 45; coordinate with the r4-tehcy session first)

**Prep (read-only):**

```bash
GEMMA=$(docker inspect llamacpp-vulkan-gemma4-e2b --format '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}' | while read -r d; do [ -f "$d/gemma-4-E2B-it-Q4_0.gguf" ] && echo "$d/gemma-4-E2B-it-Q4_0.gguf"; done | head -1); echo "$GEMMA"   # must print a path
CROW_DATA_DIR=/home/kh0pp/.crow-r4/data $MM verify --catalog gemma-4-e2b-it --quant Q4_0 --path "$GEMMA"
# adoptModel needs every catalog companion: use the mmproj beside the model if it is there, else fetch it
GEMMA_MMPROJ="$(dirname "$GEMMA")/mmproj-F16.gguf"
[ -f "$GEMMA_MMPROJ" ] || curl -L --fail -o "$GEMMA_MMPROJ" https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/main/mmproj-F16.gguf
echo "140be8d7849741f88c50757d529b84373ee8e27052cc2236855b537f4a8215fa  $GEMMA_MMPROJ" | sha256sum -c -
grep -rn ASK_LLM_URL ~/r4-tehcy ~/.config/systemd/user ~/.crow-r4 2>/dev/null | head   # where r4's ask-generation reads its endpoint
```

**Steps:** (r4 is its own instance: the crow-side `models-window.mjs restore` cannot stop or revert r4 rows, so this window arms its own deadman.)
1. `$MW preflight`; `node scripts/ops/box-reserve.mjs hold --owner models-w5 --reason "models arc W5 (gemma for r4)" --minutes 55 --allow gemma-4-e2b-it`
2. Deadman, armed before anything stops:
   ```bash
   # Absolute node path (nvm is not on the user manager's PATH); the token is read
   # INSIDE the unit's shell, never placed on its command line.
   systemd-run --user --unit=models-w5-deadman --on-active=45min --collect /bin/sh -c \
     'curl -s -m 30 -X POST -H "authorization: Bearer $(cat /home/kh0pp/.crow-r4/models-token)" http://127.0.0.1:3008/llm/models/gemma-4-e2b-it/stop; docker start llamacpp-vulkan-gemma4-e2b; /home/kh0pp/.nvm/versions/node/v24.21.0/bin/node /home/kh0pp/crow/scripts/ops/box-reserve.mjs release'
   R4TOK=$(cat ~/.crow-r4/models-token)   # for the operator's own curls below only
   ```
3. `CROW_DATA_DIR=/home/kh0pp/.crow-r4/data CROW_GATEWAY_PORT=3008 $MM adopt --catalog gemma-4-e2b-it --quant Q4_0 --path "$GEMMA" --mmproj "$GEMMA_MMPROJ" --provider gemma-4-e2b-it --no-group --always-resident` (`CROW_GATEWAY_PORT=3008` makes the row's door r4's gateway, not crow's).
4. `docker stop llamacpp-vulkan-gemma4-e2b`; `sleep 35`; start the row through **r4's** lifecycle API: `curl -s -X POST -H "authorization: Bearer $R4TOK" http://127.0.0.1:3008/llm/models/gemma-4-e2b-it/start`, then poll `http://127.0.0.1:3008/llm/models/jobs/<id>` with the same bearer until `resident`.
5. Only after a direct check passes (`curl -s -m 60 http://127.0.0.1:3008/llm/p/gemma-4-e2b-it/v1/chat/completions -H 'content-type: application/json' -d '{"model":"gemma-4-e2b-it","messages":[{"role":"user","content":"One word: hello"}],"max_tokens":8}'`), change r4's `ASK_LLM_URL` to `http://127.0.0.1:3008/llm/p/gemma-4-e2b-it/v1` and its model name to `gemma-4-e2b-it` where the prep grep found them, and restart only the r4 process that reads it (with r4-tehcy's agreement). This is the last step before closing: the deadman does not revert `ASK_LLM_URL`, so if anything fails after it, revert that by hand first.
6. Close: `systemctl --user stop models-w5-deadman.timer`; `node scripts/ops/box-reserve.mjs release`; Done row.

**Acceptance:** one r4 ask-generation run produces output (r4-tehcy's own check); `GET :3008/llm/models` shows the row resident; `wayfinder-embed` untouched (D13).

**Rollback:** revert `ASK_LLM_URL` (if changed), then `systemctl --user start models-w5-deadman.service` runs the same restore immediately; finally `systemctl --user stop models-w5-deadman.timer`.

### W6 — retirement (cap 30; after Task 5's PR merged)

**Steps (no model starts):**
1. Register a short row ("removes stopped model containers and their installs; no model starts").
2. `node scripts/ops/models-retire-installed.mjs --ids llamacpp-vulkan-qwen36-35b-a3b,llamacpp-vulkan-qwen3-embed,llamacpp-cpu-qwen3-embed` (dry run), check the plan, then the same with `--apply` (add `vllm-rocm-qwen35-4b` only if W2 ran).
3. `docker rm llamacpp-vulkan-qwen36-35b-a3b "$EMBED_CT"` (and `vllm-rocm-qwen35-4b` if W2 ran); never `docker image prune` here.
4. crow-addons: with Kevin's go only, `git -C ~/crow-addons rm -r llamacpp-vulkan-qwen38-27b-512k llamacpp-vulkan-gemma4-e2b llamacpp-cpu-qwen3-embed` for the slots that migrated, committed locally, not pushed.
5. pi-lab: confirm `~/.pi/agent/settings.json` has no `composeDir` entry pointing at a deleted directory (`node -e 'const s=require(process.env.HOME+"/.pi/agent/settings.json"); for (const [k,v] of Object.entries(s.localModels||{})) if (v.composeDir && !require("fs").existsSync(v.composeDir)) console.log("STALE", k, v.composeDir)'`); hand any STALE line to pi-lab.
6. The Extensions page Installed view shows no chip for the removed ids; the stale pre-arc installs (`vllm-rocm-qwen3`, `vllm-rocm-qwen3-32b`, `llamacpp-qwen72b`) show the retired chip from plan 3 and can be removed from there.

---

## Self-review (plan 4 against spec §7, §9, §11.5, §11.9, and the global window rules)

- §7 step 0 → plan 2 (prerequisite stated in the calendar). Steps 1–6 → W1, W2 (conditional on §11.5), W3, W4 (+W4b), W5, W6; the rollback line → `models-window.mjs restore` (Task 3) calling `models-migrate.mjs revert` (Task 2).
- §11.5 voice benchmark → Task 4 + W0, with Kevin's decision as the gate for W2 and for the vLLM bundle's fate in W6.
- §11.9 amendments: unmanaged-row conversion → Task 1; external slots stay external → W4b optional and gated; r4's own row → W1 step 6 and the deadman's `--r4-repoint`.
- Global window rules: CROW-SCHEDULE row template in every runbook; `box-reserve` preflight that refuses an existing hold (Review Focus 4); out-of-process deadman (systemd user timer) armed before prod stops; restore that works with the gateway down (Review Focus 1) and finishes every step; prod verification before closing.
- Schedule constraints: weekday 09:00–16:30 only, Saturday 10-03 08:00–10:30 excluded, 02:15–04:15 excluded, Engram nights/weekends avoided; one window per day.
- Found while validating the plans' code against the repo: `adoptModel` refuses an adopt that omits any catalog companion (`ADOPT_COMPANION_MISSING`), so W2 and W5 fetch and pass the mmproj (W3/W4 already did).
- Spec gaps found while writing this plan and ruled on: YaRN context ceiling (Task 1), unmanaged-row conversion (Task 1), revert of a null policy (Task 2), the 512k alias rename and the no-MTP ruling (W4), r4's door port (`CROW_GATEWAY_PORT=3008`, W5), the alias-row/companion-alias collision that led to the provider-scoped door (plan 2 Task 3/4, used in W1/W3/W4/W5).
- Names consistent with plans 2 and 3: `contextCeiling`, `convertUnmanaged`, `providerDoorUrl` path shape `/llm/p/<id>/v1`, lifecycle routes `/llm/models/:provider/start|stop`, `/llm/models/jobs/:id`, models token at `~/.crow/models-token`, `runtimeAssetPaths.gufo`, `gpuPolicyExtra.runtimeId`, `models-runtime-install.mjs set-gufo`.
- Placeholder scan: runbook values that only exist at execution time (`$EMBED_CT`, the gemma directory, the chosen operator build, the native port) are captured by an exact command in each runbook's prep and carried in shell variables; the W4 quant name depends on Kevin's Q1 answer and both branches are written out.
