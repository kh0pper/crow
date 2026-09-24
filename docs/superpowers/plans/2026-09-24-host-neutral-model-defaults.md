# Host-neutral embed/rerank/vision defaults — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No code default names a machine. The embedding and rerank providers resolve by env → `dashboard_settings` → the lowest-id enabled provider that has a model with a matching task tag. The smart-router's vision route picks an image-capable enabled provider.

**Architecture:**
- A new module, `servers/shared/provider-task.js`, holds a pure picker (`pickProviderByTask`, which takes a set of task synonyms) and one async resolver with a cache keyed on task and setting (`resolveProviderForTask`).
- `embeddings.js` and `rerank.js` call the resolver.
- `rerank.js` also gets the DB-row fallback that embeddings already has.
- `smart-router.js` gets a pure `pickVisionProvider` fallback, and the Settings AI-profiles hint shows it.

**Tech Stack:** Node 24 ESM, libsql `createDbClient(dbPath?)` (reads `dbPath || process.env.CROW_DB_PATH` on every call), the `node:test` runner via `npm test -- tests/<file>.test.js` (never raw `node --test`).

**Spec:** `docs/superpowers/specs/2026-09-24-host-neutral-model-defaults-design.md` (updated after plan review round 1).

## Global Constraints

- **Task synonyms:** `EMBED_TASKS = ["embed", "embedding"]` and `RERANK_TASKS = ["rerank", "score"]`. Real rerank rows are tagged `score` (`bundles/vllm-cuda-rerank/manifest.json`), and `servers/gateway/perch-model-catalog.js` already treats these as synonyms.
- **A row matches a task set** when ANY entry in its `models` array has `task` in the set.
- **Embed resolution order:** `CROW_EMBED_PROVIDER` env → `dashboard_settings.embed_provider` → the lowest-id enabled matching provider → `null`.
- **Rerank resolution order:** `CROW_RERANK_PROVIDER` env → `dashboard_settings.rerank_provider` → the lowest-id enabled matching provider → `null`. A `null` provider means candidates come back unreranked, in their original order.
- **Vision:**
  - `DEFAULT_ROUTES.vision = tierDefault("vision", null)`, so `CROW_SMART_ROUTER_VISION` is read once at module load like the other tiers.
  - When it is `null`, the route picks the lowest-id enabled provider that has a model whose `input` includes `"image"` or whose `task === "vision"`. Otherwise the existing chain (profile fallback → `crow-chat`) applies.
- **"Enabled"** means `Number(disabled)` is 0: that covers `0`, `false`, `null` and `undefined`, whereas `true` and `1` mean disabled. **"Lowest id"** means the smallest by JavaScript string comparison.
- **Caching:** 30 s, keyed on `task|settingKey`. Env is read before the cache on every call.
- **DB unavailable:** the task fallback resolves `null`. There is no `models.json` fallback, because that could bring back a named host.
- **Named-host literals:** `servers/memory/embeddings.js`, `servers/memory/rerank.js`, `servers/memory/server.js` and `servers/gateway/ai/smart-router.js` must contain no `grackle-embed`, `grackle-rerank` or `grackle-vision` literal, comments included. Other files' history comments may stay.
- **`embed_provider` and `rerank_provider` stay OUT of `SYNC_ALLOWLIST`.**
- **Commits:** `git add <new files>`, then `git commit <paths> -m ...`. Never a bare commit. No attribution lines.
- **Test hygiene:** tests restore env in `finally`/`after` and reset the resolver cache with the seam. Every DB a test opens is a temp file under the test's own `mkdtempSync` dir, passed through `CROW_DB_PATH`, which is restored afterwards.

## Review Focus

1. **A real rerank row tagged `score`.** It resolves as the rerank default. Pinned in Tasks 1 and 2.
2. **Two enabled embed rows (`crow-embed`, `grackle-embed`).** The lowest id wins; disabling it makes the other win. Pinned in Tasks 1 and 2.
3. **A rerank provider that exists only in the DB (cold `loadProviders` cache).** It is still called, not silently skipped. Pinned in Task 2 with a stubbed `fetch`.
4. **The resolver cache must not hide an env override set later.** Pinned in Task 1.
5. **An image attachment with no enabled vision-capable provider.** It falls back exactly as before and never picks a disabled row. Pinned in Task 3.

---

### Task 1: `provider-task.js` — pure picker + cached resolver

**Files:**
- Create: `servers/shared/provider-task.js`
- Test: `tests/provider-task.test.js`

**Interfaces (produces):**
- `EMBED_TASKS` (`["embed", "embedding"]`) and `RERANK_TASKS` (`["rerank", "score"]`), both frozen arrays.
- `pickProviderByTask(providers, tasks) → string|null`, where `tasks` is a string or an array of strings, and `providers` is either an object map `{ [id]: { models, disabled? } }` or an array of `{ id, models, disabled? }`. `models` may be an array or a JSON string.
- `async resolveProviderForTask({ tasks, envVar, settingKey, dbFactory = createDbClient }) → string|null`
- `_resetProviderTaskCacheForTest()`

- [ ] **Step 1: Write the failing test**

```js
// tests/provider-task.test.js
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  pickProviderByTask, resolveProviderForTask, _resetProviderTaskCacheForTest, EMBED_TASKS, RERANK_TASKS,
} from "../servers/shared/provider-task.js";

const withTask = (task, extra = {}) => ({ models: [{ id: "m", task }], ...extra });

beforeEach(() => _resetProviderTaskCacheForTest());

test("task synonym sets", () => {
  assert.deepEqual([...EMBED_TASKS], ["embed", "embedding"]);
  assert.deepEqual([...RERANK_TASKS], ["rerank", "score"]);
  assert.ok(Object.isFrozen(EMBED_TASKS) && Object.isFrozen(RERANK_TASKS));
});

test("pickProviderByTask: lowest enabled id wins (map and array forms); synonyms match", () => {
  const map = { "grackle-embed": withTask("embed"), "crow-embed": withTask("embedding"), "crow-chat": { models: [{ id: "x" }] } };
  assert.equal(pickProviderByTask(map, EMBED_TASKS), "crow-embed");
  const arr = [{ id: "zz-rr", ...withTask("score") }, { id: "aa-rr", ...withTask("rerank") }];
  assert.equal(pickProviderByTask(arr, RERANK_TASKS), "aa-rr");
  assert.equal(pickProviderByTask(arr, "score"), "zz-rr");
});

test("pickProviderByTask: any model in the row counts; JSON-string models parse", () => {
  const map = { multi: { models: [{ id: "chat" }, { id: "e", task: "embed" }] }, str: { models: JSON.stringify([{ id: "e", task: "embed" }]) } };
  assert.equal(pickProviderByTask(map, EMBED_TASKS), "multi");
  delete map.multi;
  assert.equal(pickProviderByTask(map, EMBED_TASKS), "str");
});

test("pickProviderByTask: disabled (1 or true) skipped; missing/empty/garbage models ignored; no match -> null", () => {
  const map = { "crow-embed": withTask("embed", { disabled: true }), "d1": withTask("embed", { disabled: 1 }), "grackle-embed": withTask("embed", { disabled: 0 }), a: { models: [] }, b: {}, c: { models: "not json" } };
  assert.equal(pickProviderByTask(map, EMBED_TASKS), "grackle-embed");
  assert.equal(pickProviderByTask(map, RERANK_TASKS), null);
  assert.equal(pickProviderByTask({}, EMBED_TASKS), null);
  assert.equal(pickProviderByTask(null, EMBED_TASKS), null);
  assert.equal(pickProviderByTask("nope", EMBED_TASKS), null);
});

function fakeDb({ setting = null, rows = [] } = {}) {
  const calls = [];
  const factory = () => ({
    async execute({ sql }) {
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
    assert.equal(await resolveProviderForTask({ tasks: EMBED_TASKS, envVar: "X_TEST_PROVIDER", settingKey: "embed_provider", dbFactory: factory }), "crow-embed");
    process.env.X_TEST_PROVIDER = "from-env";
    assert.equal(await resolveProviderForTask({ tasks: EMBED_TASKS, envVar: "X_TEST_PROVIDER", settingKey: "embed_provider", dbFactory: factory }), "from-env");
  } finally {
    if (prev === undefined) delete process.env.X_TEST_PROVIDER; else process.env.X_TEST_PROVIDER = prev;
  }
});

test("resolveProviderForTask: setting wins over the task pick; whitespace setting ignored", async () => {
  let r = fakeDb({ setting: "my-embed", rows: [dbRow("crow-embed", "embed")] });
  assert.equal(await resolveProviderForTask({ tasks: EMBED_TASKS, envVar: "X_UNSET_1", settingKey: "embed_provider", dbFactory: r.factory }), "my-embed");
  _resetProviderTaskCacheForTest();
  r = fakeDb({ setting: "   ", rows: [dbRow("crow-embed", "embed")] });
  assert.equal(await resolveProviderForTask({ tasks: EMBED_TASKS, envVar: "X_UNSET_1", settingKey: "embed_provider", dbFactory: r.factory }), "crow-embed");
});

test("resolveProviderForTask: task pick; none -> null; DB failure -> null", async () => {
  const r = fakeDb({ rows: [dbRow("grackle-embed", "embed"), dbRow("crow-embed", "embed", 1), dbRow("crow-rerank", "score")] });
  assert.equal(await resolveProviderForTask({ tasks: EMBED_TASKS, envVar: "X_UNSET_2", settingKey: "embed_provider", dbFactory: r.factory }), "grackle-embed");
  assert.equal(await resolveProviderForTask({ tasks: RERANK_TASKS, envVar: "X_UNSET_2", settingKey: "rerank_provider", dbFactory: r.factory }), "crow-rerank");
  assert.equal(await resolveProviderForTask({ tasks: ["vision"], envVar: "X_UNSET_2", settingKey: "vision_x", dbFactory: r.factory }), null);
  _resetProviderTaskCacheForTest();
  const broken = () => { throw new Error("no db"); };
  assert.equal(await resolveProviderForTask({ tasks: EMBED_TASKS, envVar: "X_UNSET_2", settingKey: "embed_provider", dbFactory: broken }), null);
});

test("resolveProviderForTask: cached 30 s per task|settingKey (second call does not hit the DB; another key does)", async () => {
  const r = fakeDb({ rows: [dbRow("crow-embed", "embed")] });
  await resolveProviderForTask({ tasks: EMBED_TASKS, envVar: "X_UNSET_3", settingKey: "embed_provider", dbFactory: r.factory });
  const n = r.calls.length;
  await resolveProviderForTask({ tasks: EMBED_TASKS, envVar: "X_UNSET_3", settingKey: "embed_provider", dbFactory: r.factory });
  assert.equal(r.calls.length, n);
  await resolveProviderForTask({ tasks: EMBED_TASKS, envVar: "X_UNSET_3", settingKey: "other_key", dbFactory: r.factory });
  assert.ok(r.calls.length > n);
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
 * env override → dashboard_settings key → the lowest-id ENABLED provider that
 * has a model tagged with one of the task's synonyms → null. Cached 30 s per
 * task|settingKey; the env is consulted before the cache on every call.
 */
import { createDbClient } from "../db.js";

export const EMBED_TASKS = Object.freeze(["embed", "embedding"]);
export const RERANK_TASKS = Object.freeze(["rerank", "score"]);

const TTL_MS = 30_000;
const _cache = new Map(); // `${tasks}|${settingKey}` -> { value, at }

/** Test seam: forget cached resolutions. */
export function _resetProviderTaskCacheForTest() { _cache.clear(); }

function modelsOf(p) {
  if (!p) return [];
  if (Array.isArray(p.models)) return p.models;
  if (typeof p.models === "string") {
    try { const m = JSON.parse(p.models); return Array.isArray(m) ? m : []; } catch { return []; }
  }
  return [];
}

/** Lowest enabled id with any model tagged in `tasks`, else null. Pure. */
export function pickProviderByTask(providers, tasks) {
  if (!providers || typeof providers !== "object") return null;
  const want = new Set(Array.isArray(tasks) ? tasks : [tasks]);
  const entries = Array.isArray(providers)
    ? providers.filter((p) => p && p.id).map((p) => [p.id, p])
    : Object.entries(providers);
  const ids = entries
    .filter(([, p]) => p && !Number(p.disabled) && modelsOf(p).some((m) => m && want.has(m.task)))
    .map(([id]) => id)
    .sort();
  return ids[0] ?? null;
}

export async function resolveProviderForTask({ tasks, envVar, settingKey, dbFactory = createDbClient }) {
  const env = envVar ? process.env[envVar] : undefined;
  if (typeof env === "string" && env.trim()) return env.trim();
  const key = `${[].concat(tasks).join(",")}|${settingKey || ""}`;
  const hit = _cache.get(key);
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
        value = pickProviderByTask(rows || [], tasks);
      }
    } finally {
      db.close?.();
    }
  } catch {
    value = null; // DB unavailable: never fall back to a named host
  }
  _cache.set(key, { value, at: Date.now() });
  return value;
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npm test -- tests/provider-task.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add servers/shared/provider-task.js tests/provider-task.test.js
git commit servers/shared/provider-task.js tests/provider-task.test.js -m "feat(providers): host-neutral task-based default provider resolver"
```

---

### Task 2: Embeddings and rerank use the resolver; rerank reads DB-only rows

**Files:**
- Modify: `servers/memory/embeddings.js`: the header comment (lines 1-12), `FALLBACK_PROVIDER` and `resolveDefaultProvider` (~19-60), and the `resolveEmbedConfig` default param (~66).
- Modify: `servers/memory/rerank.js` (the whole file is ~80 lines; read it first).
- Modify: `servers/memory/server.js`: the description string at `:126` and the comment at `:134-136` ("optionally reranks top-K via grackle-rerank").
- Modify: `tests/embed-provider.test.js`: its second test asserts `grackle-embed`.
- Test: `tests/embed-rerank-defaults.test.js` (new).

**Interfaces:**
- Consumes (Task 1): `resolveProviderForTask`, `EMBED_TASKS`, `RERANK_TASKS` and `_resetProviderTaskCacheForTest` from `../shared/provider-task.js`. `loadProviderFromDb(id)` is exported from `servers/memory/embeddings.js` (read its signature; it returns `{ baseUrl, apiKey, models }` or `null`).
- Produces:
  - `resolveDefaultProvider(): Promise<string|null>` (same export name as today; it can now be `null`);
  - `export async function resolveDefaultRerankProvider(): Promise<string|null>` from `rerank.js`;
  - `rerank(query, candidates, { topK, providerName })`, with `providerName` optional.

- [ ] **Step 1: Write the failing tests**

In `tests/embed-provider.test.js`, replace the second test (titled "falls back to grackle-embed when no env override and DB unreachable") with:

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

Create `tests/embed-rerank-defaults.test.js`. Static imports run before the env assignment below; that is safe because none of these modules opens a DB at import, and `createDbClient()` reads `CROW_DB_PATH` on every call.

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
const saved = {};
for (const k of ["CROW_EMBED_PROVIDER", "CROW_RERANK_PROVIDER"]) saved[k] = process.env[k];
after(() => {
  if (prevDb === undefined) delete process.env.CROW_DB_PATH; else process.env.CROW_DB_PATH = prevDb;
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(dir, { recursive: true, force: true });
});

async function seed(rows, settings = {}) {
  const db = createDbClient(dbPath);
  try {
    await db.execute("CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, base_url TEXT, api_key TEXT, models TEXT, gpu_policy TEXT, disabled INTEGER DEFAULT 0)");
    await db.execute("CREATE TABLE IF NOT EXISTS dashboard_settings (key TEXT PRIMARY KEY, value TEXT)");
    await db.execute("DELETE FROM providers");
    await db.execute("DELETE FROM dashboard_settings");
    for (const [id, task, disabled = 0, baseUrl = "http://127.0.0.1:1/v1"] of rows) {
      await db.execute({ sql: "INSERT INTO providers (id, base_url, models, disabled) VALUES (?, ?, ?, ?)", args: [id, baseUrl, JSON.stringify([{ id: "m-" + id, task }]), disabled] });
    }
    for (const [k, v] of Object.entries(settings)) {
      await db.execute({ sql: "INSERT INTO dashboard_settings (key, value) VALUES (?, ?)", args: [k, v] });
    }
  } finally { db.close?.(); }
}

beforeEach(() => {
  _resetProviderTaskCacheForTest();
  delete process.env.CROW_EMBED_PROVIDER;
  delete process.env.CROW_RERANK_PROVIDER;
});

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

test("rerank: 'score'-tagged row resolves; env override wins", async () => {
  await seed([["zz-rerank", "score"], ["aa-rerank", "rerank"]]);
  assert.equal(await resolveDefaultRerankProvider(), "aa-rerank");
  _resetProviderTaskCacheForTest();
  await seed([["only-score", "score"]]);
  assert.equal(await resolveDefaultRerankProvider(), "only-score");
  process.env.CROW_RERANK_PROVIDER = "env-rerank";
  assert.equal(await resolveDefaultRerankProvider(), "env-rerank");
});

test("rerank: a DB-only task-resolved provider IS called (stubbed fetch) and reorders", async () => {
  await seed([["db-rerank", "score", 0, "http://127.0.0.1:9/v1"]]);
  const origFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push(String(url));
    return new Response(JSON.stringify({ results: [{ index: 2, relevance_score: 0.9 }, { index: 0, relevance_score: 0.5 }, { index: 1, relevance_score: 0.1 }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const out = await rerank("q", [{ id: 1, text: "a" }, { id: 2, text: "b" }, { id: 3, text: "c" }], { topK: 3 });
    assert.equal(seen.length, 1, "reranker endpoint must be called");
    assert.match(seen[0], /127\.0\.0\.1:9\/v1\/rerank$/);
    assert.equal(out[0].id, 3);
  } finally { globalThis.fetch = origFetch; }
});

test("rerank: no provider -> candidates unreranked in original order", async () => {
  await seed([["crow-chat", "chat"]]);
  const out = await rerank("q", [{ id: 1, text: "a" }, { id: 2, text: "b" }, { id: 3, text: "c" }], { topK: 2 });
  assert.deepEqual(out.map((c) => c.id), [1, 2]);
});

test("no named-host literals remain in the memory servers", () => {
  for (const f of ["../servers/memory/embeddings.js", "../servers/memory/rerank.js", "../servers/memory/server.js"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    assert.doesNotMatch(src, /grackle-(embed|rerank|vision)/, f);
  }
});
```

Before relying on the stubbed-fetch test, read how `rerank()` parses the response body today (`results[].index` / `relevance_score`, or `data[]`?). Make the stub return exactly the shape the existing code parses, then keep the assertion that the highest-scored candidate (`id 3`) comes first.

- [ ] **Step 2: Run them and confirm they fail**

Run: `npm test -- tests/embed-provider.test.js tests/embed-rerank-defaults.test.js`
Expected: FAIL (the missing `resolveDefaultRerankProvider` export, the `grackle-embed` fallback, the literal scan, and the DB-only rerank row not being called).

- [ ] **Step 3: Implement**

1. **`servers/memory/embeddings.js`:**
   - Replace the header's first paragraph with: `Embedding client + BLOB+JS cosine-similarity search. The default provider is host-neutral: see resolveDefaultProvider (spec 2026-09-24 host-neutral-model-defaults).`
   - Delete `FALLBACK_PROVIDER`, the resolution-order comment block and the `_defaultProvider*` cache variables. Add `import { resolveProviderForTask, EMBED_TASKS } from "../shared/provider-task.js";` to the imports, and replace `resolveDefaultProvider` with:

```js
// Default embedding-provider resolution (spec 2026-09-24): CROW_EMBED_PROVIDER
// env → dashboard_settings 'embed_provider' → the lowest-id enabled provider
// with an embed-tagged model → null. Never a named host.
export async function resolveDefaultProvider() {
  return resolveProviderForTask({ tasks: EMBED_TASKS, envVar: "CROW_EMBED_PROVIDER", settingKey: "embed_provider" });
}
```

   - Change `async function resolveEmbedConfig(providerName = FALLBACK_PROVIDER)` to `async function resolveEmbedConfig(providerName)`. Then grep the file: no `FALLBACK_PROVIDER` may remain. Callers (~126, ~165) already pass `providerName || (await resolveDefaultProvider())`.

2. **`servers/memory/rerank.js`:**
   - Header line 2 becomes `Reranker client. Provider is host-neutral: see resolveDefaultRerankProvider.`
   - Delete `DEFAULT_PROVIDER`. Import `resolveProviderForTask` and `RERANK_TASKS` from `../shared/provider-task.js`, and `loadProviderFromDb` from `./embeddings.js`.
   - Add:

```js
/** CROW_RERANK_PROVIDER env → dashboard_settings 'rerank_provider' → lowest-id
 *  enabled provider with a rerank/score-tagged model → null (spec 2026-09-24). */
export async function resolveDefaultRerankProvider() {
  return resolveProviderForTask({ tasks: RERANK_TASKS, envVar: "CROW_RERANK_PROVIDER", settingKey: "rerank_provider" });
}
```

   - Make `resolveRerankConfig` async and mirror embeddings' DB fallback:

```js
async function resolveRerankConfig(providerName) {
  if (!providerName) throw new Error("no rerank provider");
  let p = loadProviders().providers?.[providerName];
  if (!p || !p.baseUrl) p = await loadProviderFromDb(providerName); // cold cache / DB-only row
  if (!p || !p.baseUrl) throw new Error(`rerank provider "${providerName}" not configured`);
  const model = p.models?.[0]?.id || "default";
  return { baseUrl: p.baseUrl, apiKey: p.apiKey, model, name: providerName };
}
```

   - In `rerank`: the signature becomes `{ topK = 10, providerName } = {}`. After the empty-candidates check, add `providerName = providerName || (await resolveDefaultRerankProvider());`, and change `cfg = resolveRerankConfig(providerName)` to `cfg = await resolveRerankConfig(providerName)` inside the existing try/catch (which returns `candidates.slice(0, topK)`).
   - Check for an import cycle: `embeddings.js` must not import `rerank.js`. If it does, move `loadProviderFromDb` usage behind a dynamic `await import("./embeddings.js")` inside `resolveRerankConfig`.

3. **`servers/memory/server.js`:**
   - `:126`: `(auto-falls back to FTS-only if grackle-embed offline)` becomes `(auto-falls back to FTS-only if the embedding provider is offline)`.
   - The comment at `:134-136`: `optionally reranks top-K via grackle-rerank` becomes `optionally reranks top-K via the default rerank provider`.

4. **Callers:** run `grep -rn "rerank(" servers bundles --include=*.js | grep -v "function rerank"`. Any caller passing a named `providerName` for a host must drop it. Paste the grep in your report.

- [ ] **Step 4: Run and confirm it passes**

Run: `npm test -- tests/embed-provider.test.js tests/embed-rerank-defaults.test.js tests/provider-task.test.js tests/memory-search-smoke.test.js`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/embed-rerank-defaults.test.js
git commit servers/memory/embeddings.js servers/memory/rerank.js servers/memory/server.js tests/embed-provider.test.js tests/embed-rerank-defaults.test.js -m "feat(memory): host-neutral embed + rerank defaults; rerank reads DB-only rows"
```

---

### Task 3: Smart-router vision capability pick, UI hint, smoke scripts, docs

**Files:**
- Modify: `servers/gateway/ai/smart-router.js`: the header comment (~18), `DEFAULT_ROUTES` (~57) and `resolveRouteToProvider` (~115).
- Modify: `servers/gateway/dashboard/settings/sections/llm/ai-profiles.js` (~169, the baked-in-default hint).
- Modify: `tests/smart-router.test.js`: the top env-clearing loop (~24), the fixture (~44), the `DEFAULT_ROUTES` test (~56); plus appended tests.
- Modify: `scripts/smoke/providers-resolve.js`, `scripts/smoke/lifecycle-refcount.js`, `scripts/smoke/smart-router-check.js`, `scripts/smoke/local-provider-warmup.js`.
- Modify: docs. Run `grep -rn "grackle-embed\|grackle-rerank\|grackle-vision" docs --include=*.md` and edit only sentences that state a *default or fallback* provider.

**Interfaces:**
- Produces: `export function pickVisionProvider(providers) → object|null` from `smart-router.js`. It takes `listProvidersAll`'s array shape `{ id, disabled, models: [{ input?, task? }] }`.

- [ ] **Step 1: Write the failing tests** (in `tests/smart-router.test.js`)
   - Change the top loop from `for (const tier of ["CODE", "FAST", "DEEP"])` to `for (const tier of ["CODE", "FAST", "DEEP", "VISION"])`.
   - In the `providers` fixture, replace `{ id: "grackle-vision", models: [{ id: "qwen3-vl-4b" }] },` with `{ id: "some-vl", models: [{ id: "qwen3-vl-4b", input: ["text", "image"] }] },`.
   - In the `DEFAULT_ROUTES` test, retitle `vision -> grackle-vision` to `vision -> null (capability pick)` and change the expected `vision: "grackle-vision"` to `vision: null`. Keep its `Object.isFrozen` assertion.
   - Append:

```js
test("pickVisionProvider: lowest enabled image-capable id; disabled skipped; none -> null", () => {
  const { pickVisionProvider } = router;
  const list = [
    { id: "zz-vl", disabled: 0, models: [{ id: "a", input: ["text", "image"] }] },
    { id: "aa-vl", disabled: true, models: [{ id: "b", input: ["image"] }] },
    { id: "mm-vl", disabled: 0, models: [{ id: "c", task: "vision" }] },
    { id: "crow-chat", disabled: 0, models: [{ id: "d", input: ["text"] }] },
  ];
  assert.equal(pickVisionProvider(list)?.id, "mm-vl");
  assert.equal(pickVisionProvider([{ id: "x", disabled: 1, models: [{ input: ["image"] }] }]), null);
  assert.equal(pickVisionProvider([]), null);
  assert.equal(pickVisionProvider(null), null);
});

test("image attachment routes to the image-capable provider", async () => {
  const r = await pick(router, "what is this?", { attachments: [{ mime_type: "image/png" }] });
  assert.equal(r.provider_id, "some-vl");
});

test("/vision slash routes to the image-capable provider", async () => {
  const r = await pick(router, "/vision describe it");
  assert.equal(r.provider_id, "some-vl");
});

test("image attachment with no enabled vision-capable provider falls back as before", async () => {
  const noVision = providers.filter((p) => p.id !== "some-vl").concat([{ id: "off-vl", disabled: 1, models: [{ input: ["image"] }] }]);
  const r = await pick(router, "what is this?", { attachments: [{ mime_type: "image/png" }], providers: noVision });
  assert.notEqual(r.provider_id, "off-vl");
  assert.equal(r.provider_id, "crow-chat");
});

test("CROW_SMART_ROUTER_VISION env override wins for a fresh module load", async () => {
  process.env.CROW_SMART_ROUTER_VISION = "my-coder";
  try {
    const fresh = await import(pathToFileURL(MODULE_PATH).href + "?env-override=vision");
    assert.equal(fresh.DEFAULT_ROUTES.vision, "my-coder");
    const r = await pick(fresh, "what is this?", { attachments: [{ mime_type: "image/png" }] });
    assert.equal(r.provider_id, "my-coder");
  } finally {
    delete process.env.CROW_SMART_ROUTER_VISION;
  }
});
```

   The existing `/fast`/`/code` tests show how slash commands route. If `/vision` requires the rest of the message in a specific form, match the existing slash tests' pattern.

- [ ] **Step 2: Run them and confirm they fail**

Run: `npm test -- tests/smart-router.test.js`
Expected: FAIL (`pickVisionProvider` is not exported; vision still defaults to `grackle-vision`).

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

   - In `resolveRouteToProvider`, between step 2 (baked) and step 3 (profile fallback):

```js
  // 2b. capability pick for vision when no override/baked default (spec 2026-09-24 D3)
  if (route === "vision" && !DEFAULT_ROUTES.vision) {
    const v = pickVisionProvider(providers);
    if (v) return v;
  }
```

- [ ] **Step 4: Settings hint** (`ai-profiles.js` ~169). The hint currently renders `DEFAULT_ROUTES[r.id] || DEFAULT_ROUTES.default`, which would show vision as `crow-chat`. Render `r.id === "vision" && !DEFAULT_ROUTES.vision ? "first image-capable provider" : (DEFAULT_ROUTES[r.id] || DEFAULT_ROUTES.default)`, keeping it inside the existing `escapeHtml(...)`. This file is server-rendered HTML in a template literal, so add no backticks inside `${}`.

- [ ] **Step 5: Smoke scripts** (manual, not in the suite). Make them host-neutral:
   - `providers-resolve.js`: replace `"grackle-embed"`, `"grackle-rerank"` and `"grackle-vision"` in its id list with `process.env.SMOKE_EMBED_PROVIDER || "crow-embed"`, and include rerank and vision only when `SMOKE_RERANK_PROVIDER` / `SMOKE_VISION_PROVIDER` are set.
   - `lifecycle-refcount.js`: add `const P = process.env.SMOKE_EMBED_PROVIDER || "crow-embed";` at the top and use `P` for every `"grackle-embed"`, messages included.
   - `smart-router-check.js`: the two `grackle-vision` checks assert `provider_id === process.env.SMOKE_VISION_PROVIDER` when that env is set, and only that `provider_id` is truthy otherwise.
   - `local-provider-warmup.js`: wrap the rerank/vision mutex-sibling expectation and the vision peer-host expectation in `if (process.env.SMOKE_RERANK_PROVIDER && process.env.SMOKE_VISION_PROVIDER) { … }`, using those env values in place of the `grackle-*` ids.
   - Run `node --check <file>` on each (syntax only; it never touches a DB).

- [ ] **Step 6: Docs.** Run the docs grep; for each sentence stating a *default/fallback* provider, rewrite it to the host-neutral rule. Paste the grep before and after in your report.

- [ ] **Step 7: Run and confirm it passes, then the full suite**

Run: `npm test -- tests/smart-router.test.js` (PASS), then `npm test` (full suite, 0 failures). Record the counts.

- [ ] **Step 8: Commit**

```bash
git commit servers/gateway/ai/smart-router.js servers/gateway/dashboard/settings/sections/llm/ai-profiles.js tests/smart-router.test.js scripts/smoke/providers-resolve.js scripts/smoke/lifecycle-refcount.js scripts/smoke/smart-router-check.js scripts/smoke/local-provider-warmup.js <each doc file edited> -m "feat(router): vision picks an image-capable provider; host-neutral hint, smoke scripts, docs"
```

---

## Operational runbook (NOT part of the PR; the controller runs it after merge + deploy). Spec §3.

1. Register a CROW-SCHEDULE slot (no GPU, no model containers).
2. **On crow**, through the gateway's providers/settings API (never a second DB client):
   - add a `crow-embed` row (`http://100.118.41.122:8004/v1`, host `local`, models `[{"id":"qwen3-embedding-0.6b","task":"embed","dim":1024,"matryoshkaDims":[1024,768,512,256],"warm":true,"priority":"interactive"}]`, `bundle_id llamacpp-vulkan-qwen3-embed`);
   - set `embed_provider=crow-embed`;
   - disable `grackle-rerank` and `grackle-vision`.
3. **On r4:** the same row and setting through :3008. Back up `crow-r4-gateway.service` and `~/.crow-r4/mcp-addons.json`, then change `CROW_EMBED_PROVIDER` to `crow-embed` and `EMBED_HOST` to `http://100.118.41.122:8004`. Restart r4.
4. **Verify:**
   - semantic memory search on crow and r4;
   - the crow embed container log shows requests;
   - raven resolves `crow-embed`;
   - grackle `:9100` gets no new traffic from crow, r4 or raven.
5. **Note:** no shipped provider row declares an image-capable model, so vision keeps falling back to `crow-chat`, which is a VLM. That is fine. Tagging crow-chat's model `input: ["text","image"]` would make the capability pick explicit; it's optional and deferred.

## Review

- **Round 1 (2026-09-24): REVISE.**
  - **Critical, fixed:**
    - (1) rerank rows are tagged `score`, so synonym sets were added;
    - (2) the literal scan would have tripped on the un-edited `server.js:136` comment, so that comment was added to the edits and the constraint scoped to the four files;
    - (3) the smart-router helper is `pick(mod, content, extra)`, so exact calls were written;
    - (4) rerank ignored DB-only rows, so the `loadProviderFromDb` fallback was added, plus a stubbed-fetch test.
  - **Suggestions adopted:**
    - the ai-profiles hint;
    - the cache key `task|settingKey`;
    - tests for the VISION env override, `/vision` and `disabled: true`;
    - a match on any model in the row;
    - the spec aligned on DB failure → `null`;
    - the smoke mutex check gated on env;
    - the unused imports and the test count fixed.
