# Host-neutral embed/rerank/vision defaults — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No code default names a machine. The embedding and rerank providers resolve by env → `dashboard_settings` → the lowest-id enabled provider whose first model has the matching `task`. The smart-router's vision route picks an image-capable enabled provider.

**Architecture:**
- A new module, `servers/shared/provider-task.js`, holds a pure picker (`pickProviderByTask`) and one async resolver with a per-task 30 s cache (`resolveProviderForTask`).
- `embeddings.js` and `rerank.js` call the resolver.
- `smart-router.js` gets a pure `pickVisionProvider` fallback between the baked default and the profile fallback.

**Tech Stack:** Node 24 ESM, libsql `createDbClient`, the `node:test` runner via `npm test -- tests/<file>.test.js` (never raw `node --test`).

**Spec:** `docs/superpowers/specs/2026-09-24-host-neutral-model-defaults-design.md`

## Global Constraints

- **Embed resolution order:** `CROW_EMBED_PROVIDER` env → `dashboard_settings.embed_provider` → lowest-id enabled provider with `models[0].task === "embed"` → `null`.
- **Rerank resolution order:** `CROW_RERANK_PROVIDER` env → `dashboard_settings.rerank_provider` → lowest-id enabled provider with `models[0].task === "rerank"` → `null`. A `null` provider means candidates come back unreranked (today's missing-provider behaviour).
- **Vision:**
  - `DEFAULT_ROUTES.vision = tierDefault("vision", null)`, so the `CROW_SMART_ROUTER_VISION` env override works like the other tiers.
  - With no override or baked default, it picks the lowest-id enabled provider that has a model with `input` including `"image"` or `task === "vision"`.
  - Otherwise the existing profile-fallback chain applies.
- **"Enabled"** means `disabled` is falsy (0, false, null or undefined). **"Lowest id"** means the smallest by JavaScript string comparison.
- **Caching:** each task's resolution is cached 30 s. Env is read before the cache on every call, so an env override is never masked by it.
- **DB unavailable:** the task fallback resolves `null`. Never fall back to a named host.
- **The literal strings `grackle-embed`, `grackle-rerank` and `grackle-vision` must not appear in `servers/`** (comments included, except history notes that say "retired"), nor in the smoke scripts' expectations.
- **`embed_provider` and `rerank_provider` stay OUT of `SYNC_ALLOWLIST`.**
- **Commits:** `git add <new files>`, then `git commit <paths> -m ...`. Never a bare commit. No attribution lines.
- **Test hygiene:** tests that set env restore it in `finally`, and tests reset the resolver cache with the seam. Every DB a test opens is a temp file under the test's own `mkdtempSync` dir, passed through `CROW_DB_PATH`, which is restored afterwards.

## Review Focus

1. **Two enabled embed rows (`crow-embed`, `grackle-embed`).** The lowest id (`crow-embed`) wins. With `crow-embed` disabled, `grackle-embed` wins. Pinned in Task 1 and Task 2.
2. **A provider row whose `models` has no `task`, or an empty `models`.** It is ignored and must not throw. Pinned in Task 1.
3. **`dashboard_settings.embed_provider` set to whitespace.** Treated as unset, so the task fallback applies. Pinned in Task 2.
4. **The resolver cache must not hide an env override set later in the same process.** The env is checked first on every call. Pinned in Task 1.
5. **An image attachment with no vision-capable enabled provider.** Routing falls back exactly as before (profile fallback → `crow-chat`) and never picks a disabled image-capable row. Pinned in Task 3.

---

### Task 1: `provider-task.js` — pure picker + cached resolver

**Files:**
- Create: `servers/shared/provider-task.js`
- Test: `tests/provider-task.test.js`

**Interfaces (produces):**
- `pickProviderByTask(providers, task) → string|null`. `providers` is either an object map `{ [id]: { models, disabled? } }` or an array of `{ id, models, disabled? }`.
- `async resolveProviderForTask({ task, envVar, settingKey, dbFactory = createDbClient }) → string|null`
- `_resetProviderTaskCacheForTest()`

- [ ] **Step 1: Write the failing test**

```js
// tests/provider-task.test.js
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pickProviderByTask, resolveProviderForTask, _resetProviderTaskCacheForTest } from "../servers/shared/provider-task.js";

const embedRow = (extra = {}) => ({ models: [{ id: "qwen3-embedding-0.6b", task: "embed" }], ...extra });

beforeEach(() => _resetProviderTaskCacheForTest());

test("pickProviderByTask: lowest enabled id with matching models[0].task wins (map and array forms)", () => {
  const map = { "grackle-embed": embedRow(), "crow-embed": embedRow(), "crow-chat": { models: [{ id: "x" }] } };
  assert.equal(pickProviderByTask(map, "embed"), "crow-embed");
  const arr = [{ id: "grackle-embed", ...embedRow() }, { id: "crow-embed", ...embedRow() }];
  assert.equal(pickProviderByTask(arr, "embed"), "crow-embed");
});

test("pickProviderByTask: disabled rows skipped; missing/empty models ignored; no match -> null", () => {
  const map = { "crow-embed": embedRow({ disabled: 1 }), "grackle-embed": embedRow({ disabled: 0 }), "a": { models: [] }, "b": {}, "c": { models: [{ id: "m" }] } };
  assert.equal(pickProviderByTask(map, "embed"), "grackle-embed");
  assert.equal(pickProviderByTask(map, "rerank"), null);
  assert.equal(pickProviderByTask({}, "embed"), null);
  assert.equal(pickProviderByTask(null, "embed"), null);
  assert.equal(pickProviderByTask("nope", "embed"), null);
});

// A fake dbFactory: records SQL, answers the settings lookup and the providers scan.
function fakeDb({ setting = null, rows = [] } = {}) {
  const calls = [];
  const factory = () => ({
    async execute({ sql, args }) {
      calls.push(sql);
      if (/dashboard_settings/.test(sql)) return { rows: setting === null ? [] : [{ value: setting }] };
      if (/FROM providers/.test(sql)) return { rows };
      throw new Error("unexpected sql " + sql);
    },
    close() {},
  });
  return { factory, calls };
}
const dbRow = (id, task, disabled = 0) => ({ id, models: JSON.stringify([{ id: "m", task }]), disabled });

test("resolveProviderForTask: env wins, and is read before the cache on every call", async () => {
  const prev = process.env.X_TEST_PROVIDER;
  const { factory } = fakeDb({ rows: [dbRow("crow-embed", "embed")] });
  try {
    delete process.env.X_TEST_PROVIDER;
    assert.equal(await resolveProviderForTask({ task: "embed", envVar: "X_TEST_PROVIDER", settingKey: "embed_provider", dbFactory: factory }), "crow-embed");
    process.env.X_TEST_PROVIDER = "from-env";
    assert.equal(await resolveProviderForTask({ task: "embed", envVar: "X_TEST_PROVIDER", settingKey: "embed_provider", dbFactory: factory }), "from-env");
  } finally {
    if (prev === undefined) delete process.env.X_TEST_PROVIDER; else process.env.X_TEST_PROVIDER = prev;
  }
});

test("resolveProviderForTask: setting wins over task pick; whitespace setting is ignored", async () => {
  let r = fakeDb({ setting: "my-embed", rows: [dbRow("crow-embed", "embed")] });
  assert.equal(await resolveProviderForTask({ task: "embed", envVar: "X_UNSET_1", settingKey: "embed_provider", dbFactory: r.factory }), "my-embed");
  _resetProviderTaskCacheForTest();
  r = fakeDb({ setting: "   ", rows: [dbRow("crow-embed", "embed")] });
  assert.equal(await resolveProviderForTask({ task: "embed", envVar: "X_UNSET_1", settingKey: "embed_provider", dbFactory: r.factory }), "crow-embed");
});

test("resolveProviderForTask: lowest-id enabled row for the task; none -> null; DB failure -> null", async () => {
  let r = fakeDb({ rows: [dbRow("grackle-embed", "embed"), dbRow("crow-embed", "embed", 1), dbRow("crow-rerank", "rerank")] });
  assert.equal(await resolveProviderForTask({ task: "embed", envVar: "X_UNSET_2", settingKey: "embed_provider", dbFactory: r.factory }), "grackle-embed");
  _resetProviderTaskCacheForTest();
  assert.equal(await resolveProviderForTask({ task: "vision", envVar: "X_UNSET_2", settingKey: "vision_provider_x", dbFactory: r.factory }), null);
  _resetProviderTaskCacheForTest();
  const broken = () => { throw new Error("no db"); };
  assert.equal(await resolveProviderForTask({ task: "embed", envVar: "X_UNSET_2", settingKey: "embed_provider", dbFactory: broken }), null);
});

test("resolveProviderForTask: cached per task for 30 s (second call does not hit the DB)", async () => {
  const r = fakeDb({ rows: [dbRow("crow-embed", "embed")] });
  await resolveProviderForTask({ task: "embed", envVar: "X_UNSET_3", settingKey: "embed_provider", dbFactory: r.factory });
  const n = r.calls.length;
  await resolveProviderForTask({ task: "embed", envVar: "X_UNSET_3", settingKey: "embed_provider", dbFactory: r.factory });
  assert.equal(r.calls.length, n);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `export PATH=/home/kh0pp/.nvm/versions/node/v24.21.0/bin:$PATH && npm test -- tests/provider-task.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```js
// servers/shared/provider-task.js
/**
 * Host-neutral provider defaults (spec
 * docs/superpowers/specs/2026-09-24-host-neutral-model-defaults-design.md).
 *
 * A default must never name a machine. A task's default provider resolves:
 * env override → dashboard_settings key → the lowest-id ENABLED provider whose
 * first model declares that task → null. Cached 30 s per task; the env is
 * consulted before the cache on every call.
 */
import { createDbClient } from "../db.js";

const TTL_MS = 30_000;
const _cache = new Map(); // task -> { value, at }

/** Test seam: forget cached resolutions. */
export function _resetProviderTaskCacheForTest() { _cache.clear(); }

function modelsOf(p) {
  if (!p) return [];
  if (Array.isArray(p.models)) return p.models;
  if (typeof p.models === "string") { try { const m = JSON.parse(p.models); return Array.isArray(m) ? m : []; } catch { return []; } }
  return [];
}

/** Lowest enabled id whose models[0].task === task, else null. Pure. */
export function pickProviderByTask(providers, task) {
  if (!providers || typeof providers !== "object") return null;
  const entries = Array.isArray(providers)
    ? providers.filter((p) => p && p.id).map((p) => [p.id, p])
    : Object.entries(providers);
  const ids = entries
    .filter(([, p]) => p && !Number(p.disabled) && modelsOf(p)[0]?.task === task)
    .map(([id]) => id)
    .sort();
  return ids[0] ?? null;
}

export async function resolveProviderForTask({ task, envVar, settingKey, dbFactory = createDbClient }) {
  const env = envVar ? process.env[envVar] : undefined;
  if (typeof env === "string" && env.trim()) return env.trim();
  const hit = _cache.get(task);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let value = null;
  try {
    const db = dbFactory();
    try {
      if (settingKey) {
        const { rows } = await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: [settingKey] });
        const v = rows?.[0]?.value;
        if (v && String(v).trim()) value = String(v).trim();
      }
      if (!value) {
        const { rows } = await db.execute({ sql: "SELECT id, models, disabled FROM providers WHERE disabled = 0 ORDER BY id", args: [] });
        value = pickProviderByTask(rows || [], task);
      }
    } finally {
      db.close?.();
    }
  } catch {
    value = null; // DB unavailable: never fall back to a named host
  }
  _cache.set(task, { value, at: Date.now() });
  return value;
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npm test -- tests/provider-task.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add servers/shared/provider-task.js tests/provider-task.test.js
git commit servers/shared/provider-task.js tests/provider-task.test.js -m "feat(providers): host-neutral task-based default provider resolver"
```

---

### Task 2: Embeddings and rerank use the resolver

**Files:**
- Modify: `servers/memory/embeddings.js`:
  - the header comment (lines 1-12);
  - `FALLBACK_PROVIDER` and `resolveDefaultProvider` (~19-60);
  - the `resolveEmbedConfig` default param (~66).
- Modify: `servers/memory/rerank.js` (the header comment, `DEFAULT_PROVIDER`, `resolveRerankConfig`, `rerank`).
- Modify: `servers/memory/server.js:126` (the tool description string).
- Modify: `tests/embed-provider.test.js` (the second test asserts `grackle-embed`).
- Test: `tests/embed-rerank-defaults.test.js` (new).

**Interfaces:**
- Consumes (Task 1): `resolveProviderForTask({ task, envVar, settingKey, dbFactory })` and `_resetProviderTaskCacheForTest()` from `../shared/provider-task.js`.
- Produces:
  - `resolveDefaultProvider(): Promise<string|null>` (same export name as today; it can now return `null`);
  - `export async function resolveDefaultRerankProvider(): Promise<string|null>` from `rerank.js`;
  - `rerank(query, candidates, { topK, providerName })`, where `providerName` is now optional (resolved when absent).

- [ ] **Step 1: Write the failing tests**

Replace the second test in `tests/embed-provider.test.js` (the one titled "falls back to grackle-embed when no env override and DB unreachable") with:

```js
test("no env override and DB unreachable -> null (never a named host)", async () => {
  const { _resetProviderTaskCacheForTest } = await import("../servers/shared/provider-task.js");
  _resetProviderTaskCacheForTest();
  const prevProvider = process.env.CROW_EMBED_PROVIDER;
  const prevDb = process.env.CROW_DB_PATH;
  delete process.env.CROW_EMBED_PROVIDER;
  process.env.CROW_DB_PATH = "/nonexistent-dir-xyz-123/none.db";
  try {
    assert.equal(await resolveDefaultProvider(), null);
  } finally {
    if (prevProvider !== undefined) process.env.CROW_EMBED_PROVIDER = prevProvider;
    if (prevDb === undefined) delete process.env.CROW_DB_PATH;
    else process.env.CROW_DB_PATH = prevDb;
    _resetProviderTaskCacheForTest();
  }
});
```

Create `tests/embed-rerank-defaults.test.js`:

```js
// tests/embed-rerank-defaults.test.js
// Host-neutral defaults against a REAL temp libsql DB (never the live one).
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { _resetProviderTaskCacheForTest } from "../servers/shared/provider-task.js";
import { resolveDefaultProvider } from "../servers/memory/embeddings.js";
import { resolveDefaultRerankProvider, rerank } from "../servers/memory/rerank.js";

const dir = mkdtempSync(join(tmpdir(), "embed-rerank-defaults-"));
const dbPath = join(dir, "crow.db");
const prevDb = process.env.CROW_DB_PATH;
process.env.CROW_DB_PATH = dbPath;
after(() => {
  if (prevDb === undefined) delete process.env.CROW_DB_PATH; else process.env.CROW_DB_PATH = prevDb;
  rmSync(dir, { recursive: true, force: true });
});

async function seed(rows, settings = {}) {
  const db = createDbClient(dbPath);
  try {
    await db.execute("CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, base_url TEXT, models TEXT, disabled INTEGER DEFAULT 0)");
    await db.execute("CREATE TABLE IF NOT EXISTS dashboard_settings (key TEXT PRIMARY KEY, value TEXT)");
    await db.execute("DELETE FROM providers");
    await db.execute("DELETE FROM dashboard_settings");
    for (const [id, task, disabled = 0] of rows) {
      await db.execute({ sql: "INSERT INTO providers (id, base_url, models, disabled) VALUES (?, ?, ?, ?)", args: [id, "http://127.0.0.1:1/v1", JSON.stringify([{ id: "m", task }]), disabled] });
    }
    for (const [k, v] of Object.entries(settings)) {
      await db.execute({ sql: "INSERT INTO dashboard_settings (key, value) VALUES (?, ?)", args: [k, v] });
    }
  } finally { db.close?.(); }
}

const saved = {};
beforeEach(() => {
  _resetProviderTaskCacheForTest();
  for (const k of ["CROW_EMBED_PROVIDER", "CROW_RERANK_PROVIDER"]) { saved[k] = process.env[k]; delete process.env[k]; }
});
after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

test("embed: two enabled embed rows -> lowest id; disabling it -> the other", async () => {
  await seed([["grackle-embed", "embed"], ["crow-embed", "embed"], ["crow-chat", "chat"]]);
  assert.equal(await resolveDefaultProvider(), "crow-embed");
  _resetProviderTaskCacheForTest();
  await seed([["grackle-embed", "embed"], ["crow-embed", "embed", 1]]);
  assert.equal(await resolveDefaultProvider(), "grackle-embed");
});

test("embed: dashboard_settings.embed_provider wins; whitespace value ignored", async () => {
  await seed([["crow-embed", "embed"]], { embed_provider: "custom-embed" });
  assert.equal(await resolveDefaultProvider(), "custom-embed");
  _resetProviderTaskCacheForTest();
  await seed([["crow-embed", "embed"]], { embed_provider: "  " });
  assert.equal(await resolveDefaultProvider(), "crow-embed");
});

test("embed: no embed-task rows -> null", async () => {
  await seed([["crow-chat", "chat"]]);
  assert.equal(await resolveDefaultProvider(), null);
});

test("rerank: task-resolved; env override wins; none -> candidates unreranked in original order", async () => {
  await seed([["zz-rerank", "rerank"], ["aa-rerank", "rerank"]]);
  assert.equal(await resolveDefaultRerankProvider(), "aa-rerank");
  process.env.CROW_RERANK_PROVIDER = "env-rerank";
  assert.equal(await resolveDefaultRerankProvider(), "env-rerank");
  delete process.env.CROW_RERANK_PROVIDER;
  _resetProviderTaskCacheForTest();
  await seed([["crow-chat", "chat"]]);
  const cands = [{ id: 1, text: "a" }, { id: 2, text: "b" }, { id: 3, text: "c" }];
  const out = await rerank("q", cands, { topK: 2 });
  assert.deepEqual(out.map((c) => c.id), [1, 2]);
});

test("no named-host literals remain in the memory servers", () => {
  for (const f of ["../servers/memory/embeddings.js", "../servers/memory/rerank.js", "../servers/memory/server.js"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    assert.doesNotMatch(src, /grackle-(embed|rerank|vision)/, f);
  }
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npm test -- tests/embed-provider.test.js tests/embed-rerank-defaults.test.js`
Expected: FAIL (`resolveDefaultRerankProvider` is not exported; the fallback returns `grackle-embed`; the literal scan fails).

- [ ] **Step 3: Implement**

1. **`servers/memory/embeddings.js`:**
   - Replace the header's first paragraph with: `Embedding client + BLOB+JS cosine-similarity search. The default provider is host-neutral: see resolveDefaultProvider (spec 2026-09-24 host-neutral-model-defaults).`
   - Delete `const FALLBACK_PROVIDER = "grackle-embed";`, the resolution-order comment block and the `_defaultProvider*` cache variables. Replace the whole `resolveDefaultProvider` function with:

```js
import { resolveProviderForTask } from "../shared/provider-task.js";

// Default embedding-provider resolution (spec 2026-09-24): CROW_EMBED_PROVIDER
// env → dashboard_settings 'embed_provider' → the lowest-id enabled provider
// whose first model has task "embed" → null. Never a named host.
export async function resolveDefaultProvider() {
  return resolveProviderForTask({ task: "embed", envVar: "CROW_EMBED_PROVIDER", settingKey: "embed_provider" });
}
```

   (Put the import with the other imports at the top of the file.)
   - Change `async function resolveEmbedConfig(providerName = FALLBACK_PROVIDER)` to `async function resolveEmbedConfig(providerName)`. Its existing `throw new Error(\`embedding provider "${providerName}" not configured\`)` stays; for `null` it now reads `embedding provider "null" not configured`. Callers at ~126 and ~165 already pass `providerName || (await resolveDefaultProvider())`.
   - Grep the file for any remaining `FALLBACK_PROVIDER` and resolve each use the same way.

2. **`servers/memory/rerank.js`:**
   - Header line 2 becomes `Reranker client. Provider is host-neutral: see resolveDefaultRerankProvider.`
   - Delete `const DEFAULT_PROVIDER = "grackle-rerank";`.
   - Add:

```js
import { resolveProviderForTask } from "../shared/provider-task.js";

/** CROW_RERANK_PROVIDER env → dashboard_settings 'rerank_provider' → lowest-id
 *  enabled provider with task "rerank" → null (spec 2026-09-24). */
export async function resolveDefaultRerankProvider() {
  return resolveProviderForTask({ task: "rerank", envVar: "CROW_RERANK_PROVIDER", settingKey: "rerank_provider" });
}
```

   - Change `resolveRerankConfig(providerName = DEFAULT_PROVIDER)` to `resolveRerankConfig(providerName)`, and make its first line `if (!providerName) throw new Error("no rerank provider");`.
   - Change `rerank`'s signature to `{ topK = 10, providerName } = {}`, and as its first statement after the empty-candidates check: `providerName = providerName || (await resolveDefaultRerankProvider());`. The existing `try { cfg = resolveRerankConfig(providerName) } catch { return candidates.slice(0, topK) }` then covers the `null` case.

3. **`servers/memory/server.js:126`:** change `(auto-falls back to FTS-only if grackle-embed offline)` to `(auto-falls back to FTS-only if the embedding provider is offline)`.

4. **Check other callers:** `grep -rn "rerank(" servers --include=*.js | grep -v "function rerank"`. Any caller passing `providerName: "grackle-rerank"` explicitly must drop it, so the default resolution applies. Show the grep output in your report.

- [ ] **Step 4: Run and confirm it passes**

Run: `npm test -- tests/embed-provider.test.js tests/embed-rerank-defaults.test.js tests/provider-task.test.js tests/memory-search-smoke.test.js`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/embed-rerank-defaults.test.js
git commit servers/memory/embeddings.js servers/memory/rerank.js servers/memory/server.js tests/embed-provider.test.js tests/embed-rerank-defaults.test.js -m "feat(memory): host-neutral embed + rerank defaults (no grackle fallback)"
```

---

### Task 3: Smart-router vision fallback, smoke scripts, docs

**Files:**
- Modify: `servers/gateway/ai/smart-router.js`:
  - the header comment line ~18 (`vision → grackle-vision`);
  - `DEFAULT_ROUTES` (~57);
  - `resolveRouteToProvider` (~115).
- Modify: `tests/smart-router.test.js`: the `DEFAULT_ROUTES` test (~line 57 of the file) and the fixture provider list (~line 41).
- Modify: `scripts/smoke/providers-resolve.js`, `scripts/smoke/lifecycle-refcount.js`, `scripts/smoke/smart-router-check.js`, `scripts/smoke/local-provider-warmup.js`.
- Modify: docs that state the grackle default. Run `grep -rn "grackle-embed\|grackle-rerank\|grackle-vision" docs --include=*.md`, then edit only sentences that describe a *default or fallback*. Leave historical logs and specs alone.

**Interfaces:**
- Produces: `export function pickVisionProvider(providers) → object|null` from `smart-router.js`. It takes `listProvidersAll`'s array shape (`{ id, disabled, models: [{ input?, task? }] }`).

- [ ] **Step 1: Write the failing tests** (in `tests/smart-router.test.js`)

   First, delete `CROW_SMART_ROUTER_VISION` alongside the others at the top: change `for (const tier of ["CODE", "FAST", "DEEP"])` to `for (const tier of ["CODE", "FAST", "DEEP", "VISION"])`.

   Then change the provider fixture's `{ id: "grackle-vision", models: [{ id: "qwen3-vl-4b" }] }` entry to `{ id: "some-vl", models: [{ id: "qwen3-vl-4b", input: ["text", "image"] }] }`.

   In the `DEFAULT_ROUTES` test, change its title's `vision -> grackle-vision` to `vision -> null (picked by capability)`, and its expected `vision: "grackle-vision"` to `vision: null`.

   Append:

```js
test("pickVisionProvider: lowest enabled id with an image-capable model; disabled skipped; none -> null", () => {
  const { pickVisionProvider } = router;
  const list = [
    { id: "zz-vl", disabled: 0, models: [{ id: "a", input: ["text", "image"] }] },
    { id: "aa-vl", disabled: 1, models: [{ id: "b", input: ["image"] }] },
    { id: "mm-vl", disabled: 0, models: [{ id: "c", task: "vision" }] },
    { id: "crow-chat", disabled: 0, models: [{ id: "d", input: ["text"] }] },
  ];
  assert.equal(pickVisionProvider(list)?.id, "mm-vl");
  assert.equal(pickVisionProvider([{ id: "x", disabled: 1, models: [{ input: ["image"] }] }]), null);
  assert.equal(pickVisionProvider([]), null);
  assert.equal(pickVisionProvider(null), null);
});

test("image attachment routes to the image-capable provider", async () => {
  const r = await chooseProvider(args({ content: "what is this?", attachments: [{ mime_type: "image/png" }] }));
  assert.equal(r.provider_id, "some-vl");
});

test("image attachment with no vision-capable enabled provider falls back as before", async () => {
  const noVision = providers.filter((p) => p.id !== "some-vl").concat([{ id: "off-vl", disabled: 1, models: [{ input: ["image"] }] }]);
  const r = await chooseProvider(args({ content: "what is this?", attachments: [{ mime_type: "image/png" }], providers: noVision }));
  assert.notEqual(r.provider_id, "off-vl");
  assert.equal(r.provider_id, "crow-chat");
});
```

   `args(...)` is the helper the test file already defines around line 50 (it spreads `...extra` over `{ db, convId, providers, autoRules: null }`). Read it. If it has a different name, use that name, and pass `providers` through it exactly as it allows. If the file's existing chooseProvider calls pass `content`/`attachments` under other keys, match them.

- [ ] **Step 2: Run them and confirm they fail**

Run: `npm test -- tests/smart-router.test.js`
Expected: FAIL (`pickVisionProvider` is not exported; `DEFAULT_ROUTES.vision` is still `grackle-vision`).

- [ ] **Step 3: Implement** in `servers/gateway/ai/smart-router.js`

   - Header comment: `vision  → grackle-vision` becomes `vision  → first enabled image-capable provider (CROW_SMART_ROUTER_VISION overrides)`.
   - `DEFAULT_ROUTES`: `vision:  "grackle-vision",` becomes `vision:  tierDefault("vision", null),`.
   - Add above `resolveRouteToProvider`:

```js
/** Lowest-id enabled provider with an image-capable model (input includes
 *  "image", or task "vision"), else null. Pure (spec 2026-09-24 D3). */
export function pickVisionProvider(providers) {
  if (!Array.isArray(providers)) return null;
  const ok = providers
    .filter((p) => p && p.id && !Number(p.disabled))
    .filter((p) => (Array.isArray(p.models) ? p.models : []).some((m) =>
      (Array.isArray(m?.input) && m.input.includes("image")) || m?.task === "vision"))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return ok[0] || null;
}
```

   - In `resolveRouteToProvider`, between step 2 (baked) and step 3 (profile fallback), insert:

```js
  // 2b. capability pick for vision when no override/baked default (spec 2026-09-24 D3)
  if (route === "vision" && !DEFAULT_ROUTES.vision) {
    const v = pickVisionProvider(providers);
    if (v) return v;
  }
```

- [ ] **Step 4: Smoke scripts (manual, not in the suite).** Replace host-named provider ids with env-driven, host-neutral values:
   - In `scripts/smoke/providers-resolve.js`, replace the `"grackle-embed"`, `"grackle-rerank"` and `"grackle-vision"` entries in its id list with `process.env.SMOKE_EMBED_PROVIDER || "crow-embed"`, `process.env.SMOKE_RERANK_PROVIDER || "crow-rerank"` and `process.env.SMOKE_VISION_PROVIDER || "crow-vision"`.
   - In `scripts/smoke/lifecycle-refcount.js`, introduce `const P = process.env.SMOKE_EMBED_PROVIDER || "crow-embed";` at the top and use `P` everywhere `"grackle-embed"` appears, including in assertion messages.
   - In `scripts/smoke/smart-router-check.js`, the two checks expecting `grackle-vision` become checks that `provider_id` equals `process.env.SMOKE_VISION_PROVIDER` when that env is set, and otherwise that it is truthy.
   - In `scripts/smoke/local-provider-warmup.js`, the `grackle-rerank`/`grackle-vision` mutex-sibling and peer-host expectations use `process.env.SMOKE_RERANK_PROVIDER || "crow-rerank"` and `process.env.SMOKE_VISION_PROVIDER || "crow-vision"`.
   - Keep each script's structure, and run `node --check <file>` on each (syntax only; this never touches a DB).

- [ ] **Step 5: Docs.** Run the docs grep from **Files**. For each sentence that states a *default or fallback* provider, rewrite it to the host-neutral rule; each short sentence should link to `docs/superpowers/specs/2026-09-24-host-neutral-model-defaults-design.md`. Show the grep output before and after in your report.

- [ ] **Step 6: Run and confirm it passes, then run the full suite**

Run: `npm test -- tests/smart-router.test.js` (expected PASS), then `npm test` (full suite, expected 0 failures). Record the counts.

- [ ] **Step 7: Commit**

```bash
git commit servers/gateway/ai/smart-router.js tests/smart-router.test.js scripts/smoke/providers-resolve.js scripts/smoke/lifecycle-refcount.js scripts/smoke/smart-router-check.js scripts/smoke/local-provider-warmup.js <each doc file edited> -m "feat(router): vision route picks an image-capable provider; host-neutral smoke scripts + docs"
```

---

## Operational runbook (NOT part of the PR; the controller runs it after merge + deploy). Spec §3.

1. Register a CROW-SCHEDULE slot (no GPU, no model containers).
2. **On crow:** add a `crow-embed` provider row (`http://100.118.41.122:8004/v1`, host `local`, models `[{"id":"qwen3-embedding-0.6b","task":"embed","dim":1024,"matryoshkaDims":[1024,768,512,256],"warm":true,"priority":"interactive"}]`, `bundle_id llamacpp-vulkan-qwen3-embed`) through the gateway's providers API, never a second DB client. Set `dashboard_settings.embed_provider=crow-embed` through the settings API. Disable `grackle-rerank` and `grackle-vision`.
3. **On r4:** the same row and setting through r4's API (:3008). Edit `crow-r4-gateway.service` `CROW_EMBED_PROVIDER` → `crow-embed` and `~/.crow-r4/mcp-addons.json` `EMBED_HOST` → `http://100.118.41.122:8004`. Back up both first, then restart r4.
4. **Verify:**
   - a semantic memory search on crow and r4;
   - the crow embed container log shows requests;
   - raven resolves `crow-embed` (the row synced);
   - grackle `:9100` receives no new requests from crow, r4 or raven.
