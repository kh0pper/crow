# F4a Layer 1 — Federated Capability + Bot Discovery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **RESOURCE NOTE (crow froze twice during design):** crow runs a heavy always-on LLM stack (`vllm` + `llama-server` + `python3`, ~9 GB+ resident). Execute this plan **single-threaded** — ONE implementer subagent at a time, NO concurrent fan-out. Avoid spawning live MCP probes during tests (all tests here use stubs/temp dirs, never live `probeServerTools`). If memory pressure appears, pause and check `free -h`.

**Goal:** Make each Crow instance's Bot Builder show the whole instance mesh — local capabilities/bots plus peers' — by building a federation-aware discovery registry on top of the existing F5 signed-fetch mesh.

**Architecture:** A local catalog module aggregates this instance's tools (`TOOL_MANIFESTS` + installed addons, vocab-normalized) + skills + bots, projected through strict public-safe whitelists. A new HMAC-gated `/dashboard/capabilities` endpoint advertises it. A cache module (mirroring `overview-cache.js`) pulls peers' catalogs via `forwardSignedRequest`. A merge function tags items by owning instance. The Bot Board and Bot Builder panels render local-editable + remote-read-only.

**Tech Stack:** Node.js ESM, `node:test`, Express routers, the existing federation primitives (`peer-forward.js`, `overview-cache.js`, `federation.js`, `mergeDiscoveredPeers`).

**Spec:** `docs/superpowers/specs/2026-06-08-f4a-federated-discovery-design.md`

**Conventions (every commit):** `git commit <explicit paths> -m "..."` (never `git add -A` + bare commit); verify `git show --stat HEAD`; never add Claude as co-author; `git pull --rebase` before push. Branch `feat/f4a-federated-discovery` (already created off `main`).

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `servers/gateway/capability-registry.js` | Local catalog + public-safe projectors (`getLocalCatalog`, `toPublicBot/Tool/Skill`, vocab map) | Create |
| `tests/capability-registry.test.js` | Aggregator + freshness | Create |
| `tests/public-projection.test.js` | Security: no secrets leak through projectors | Create |
| `servers/gateway/routes/federation.js` | Add `GET /capabilities` (reuse HMAC gate) | Modify |
| `servers/gateway/dashboard/capabilities-cache.js` | Cached, validated peer pull + envelope validator | Create |
| `tests/capabilities-cache.test.js` | Envelope validation + cache behavior | Create |
| `servers/gateway/dashboard/federated-catalog.js` | `mergeFederatedCatalog` | Create |
| `tests/federated-catalog.test.js` | Merge + ownership tags + down-peer resilience | Create |
| `servers/gateway/dashboard/panels/bot-board.js` | "Bots on other instances" section | Modify |
| `servers/gateway/dashboard/panels/bot-builder.js` | Collapsed remote-capabilities group | Modify |

**Reference shapes (already verified — read these while implementing):**
- `TOOL_MANIFESTS`: `{ <category>: { displayName, description, tools: { <toolName>: {params, desc} } } }` (`servers/gateway/tool-manifests.js`). Categories: memory, projects, blog, sharing, media, orchestrator, consulting, storage.
- Core canonical server names (`scripts/server-registry.js`): `crow-memory`, `crow-projects` (research), `crow-sharing`, `crow-blog`, `crow-storage`. Convention: canonical = `crow-<category>`.
- Installed addons: `listInstalledExtensions(crowHome)` → `[{ id, block, inCanonical, needsMint, group, name, capabilities }]` (`scripts/pi-bots/ext_registry.mjs:169`). `extensionSkills(ext)` → `[name]` (`:242`). **Do NOT call `extensionTools` in the registry** (it spawns MCP servers — resource risk); use the static `capabilities` overlay instead.
- Vocab: `CANONICAL_TO_VOICE_CATEGORY` (`ext_registry.mjs:272`) maps `crow-memory→memory` etc.
- `pi_bot_defs` columns: `bot_id, display_name, definition (JSON), enabled, project_id, created_at, updated_at`. `definition` JSON: `{ engine, models:{default,...}, tools:{pi_builtin[],crow_mcp[],pi_extensions[],skills[]}, gateways[], permission_policy{}, triggers{}, system_prompt, skills[], session_dir, spawn_env{} }`.
- Federation route factory: `federationRouter({ createDbClient })`, mounted under `/dashboard`; HMAC middleware `federationVerifyMiddleware(dbForAudit)` (`federation.js`). Existing route is `router.get("/overview", federationVerifyMiddleware(...), handler)`.
- `overview-cache.js`: consts `TTL_SUCCESS_MS=30_000`, `MAX_RESPONSE_BYTES=64*1024`, `FETCH_TIMEOUT_MS=2_000`; `getPeerOverview(db, id, {source})`; `validateEnvelope(body)`; `defaultFetchImpl(db, id)` uses `forwardSignedRequest({ db, sourceInstanceId, targetInstanceId, method:"GET", path:"/dashboard/overview", auditAction, timeoutMs, maxResponseBytes })`; test hooks `_setFetchImpl`, `_resetCache`.
- `mergeDiscoveredPeers(trustedInstances, peerOverviews, localId)` → `{ discoveredInstances, discoveredOverviews }` (`panels/nest/data-queries.js:250`).

---

## Task 1: Local capability registry + public-safe projectors

**Files:**
- Create: `servers/gateway/capability-registry.js`
- Test: `tests/capability-registry.test.js`, `tests/public-projection.test.js`

- [ ] **Step 1: Write the failing projection (security) test**

Create `tests/public-projection.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { toPublicBot, toPublicTool, toPublicSkill } from "../servers/gateway/capability-registry.js";

test("toPublicBot exposes only whitelisted fields, never the raw definition", () => {
  const row = {
    bot_id: "scout", display_name: "Scout", enabled: 1, project_id: 7,
    definition: JSON.stringify({
      models: { default: "crow-local/qwen3.6-35b-a3b" },
      tools: { crow_mcp: ["crow-tasks/tasks_list", "crow-memory/crow_store_memory"], pi_builtin: ["read"] },
      gateways: [{ type: "gmail", address: "kevin.hopper+scout@maestro.press", allowlist: ["secret@x"] }],
      permission_policy: { bash: "deny", write_paths: ["/home/kh0pp/.crow-mpa/pi-bots/scout"] },
      system_prompt: "SECRET PROMPT do not leak",
      spawn_env: { PI_PROVIDER: "crow-local", SECRET_KEY: "abc123" },
    }),
  };
  const pub = toPublicBot(row);
  assert.deepEqual(Object.keys(pub).sort(),
    ["bot_id", "display_name", "enabled", "model", "project_id", "tool_count", "tracker_type"].sort());
  assert.equal(pub.bot_id, "scout");
  assert.equal(pub.enabled, true);
  assert.equal(pub.model, "crow-local/qwen3.6-35b-a3b");
  assert.equal(pub.tool_count, 2);
  // The sensitive material must NOT appear anywhere in the serialized projection.
  const blob = JSON.stringify(pub);
  for (const leak of ["SECRET PROMPT", "SECRET_KEY", "abc123", "maestro.press", "permission_policy", "write_paths", "spawn_env", "system_prompt"]) {
    assert.ok(!blob.includes(leak), `leaked: ${leak}`);
  }
});

test("toPublicTool drops env/keys/command/args", () => {
  const pub = toPublicTool({
    canonicalId: "texas-gov-data", category: "tools", name: "texas-gov-data", bundleId: "texas-gov-data", toolCount: 5,
    block: { command: "/usr/bin/uv", args: ["run", "x"], env: { API_KEY: "sekret" } },
  });
  assert.deepEqual(Object.keys(pub).sort(), ["bundleId", "canonicalId", "category", "name", "toolCount"].sort());
  assert.ok(!JSON.stringify(pub).includes("sekret"));
  assert.ok(!JSON.stringify(pub).includes("API_KEY"));
});

test("toPublicSkill is just a name", () => {
  assert.deepEqual(toPublicSkill({ name: "research-pipeline", path: "/home/kh0pp/.crow/skills/research-pipeline.md" }),
    { name: "research-pipeline" });
});
```

- [ ] **Step 2: Run it — expect failure**

Run: `node --test tests/public-projection.test.js`
Expected: FAIL — `Cannot find module '../servers/gateway/capability-registry.js'`.

- [ ] **Step 3: Write `capability-registry.js`**

Create `servers/gateway/capability-registry.js`:

```js
/**
 * Local capability registry (F4a Layer 1). Single source of truth for "what
 * capabilities + bots exist on THIS instance," vocab-normalized, built by live
 * aggregation (a freshly-installed addon appears with no restart). Plus the
 * strict public-safe projectors — the ONLY path from local data to the mesh
 * wire. Never emit a raw bot definition, addon block, env, or secret.
 */
import { TOOL_MANIFESTS } from "./tool-manifests.js";
import { listInstalledExtensions, extensionSkills, voiceCategoryFor, resolveCrowHome } from "../../scripts/pi-bots/ext_registry.mjs";
import { skillDirs } from "../../scripts/pi-bots/skill_resolver.mjs";
import { readdirSync } from "node:fs";

/** Canonical server id for a core manifest category (crow-memory, etc.). */
export function canonicalForCategory(category) {
  return `crow-${category}`;
}

// ---- public-safe projectors (security boundary) ----

export function toPublicTool(entry) {
  return {
    canonicalId: entry.canonicalId,
    category: entry.category,
    name: entry.name,
    bundleId: entry.bundleId ?? null,
    toolCount: entry.toolCount ?? null,
  };
}

export function toPublicSkill(s) {
  return { name: typeof s === "string" ? s : s.name };
}

export function toPublicBot(row) {
  let def = {};
  try { def = JSON.parse(row.definition || "{}"); } catch { def = {}; }
  const crowMcp = (def.tools && Array.isArray(def.tools.crow_mcp)) ? def.tools.crow_mcp : [];
  return {
    bot_id: row.bot_id,
    display_name: row.display_name,
    enabled: row.enabled === 1 || row.enabled === true,
    project_id: row.project_id ?? null,
    tracker_type: (def.triggers && def.triggers.tracker_type) || "none",
    model: (def.models && def.models.default) || null,
    tool_count: crowMcp.length,
  };
}

// ---- local catalog (live aggregation) ----

function coreTools() {
  const out = [];
  for (const [category, manifest] of Object.entries(TOOL_MANIFESTS)) {
    const names = Object.keys(manifest.tools || {});
    out.push({
      canonicalId: canonicalForCategory(category),
      category,
      name: manifest.displayName || category,
      bundleId: null,
      toolCount: names.length,
    });
  }
  return out;
}

function addonTools(crowHome) {
  const out = [];
  for (const ext of listInstalledExtensions(crowHome)) {
    const category = voiceCategoryFor(ext.id) || "extension";
    const toolCount = ext.capabilities && Array.isArray(ext.capabilities.tools)
      ? ext.capabilities.tools.length : null;
    out.push({ canonicalId: ext.id, category, name: ext.name || ext.id, bundleId: ext.id, toolCount });
  }
  return out;
}

function localSkills(crowHome) {
  const names = new Set();
  for (const dir of skillDirs(crowHome)) {
    try { for (const f of readdirSync(dir)) if (f.endsWith(".md")) names.add(f.replace(/\.md$/, "")); }
    catch { /* dir missing */ }
  }
  return [...names].sort().map((name) => ({ name }));
}

async function localBots(db) {
  try {
    const { rows } = await db.execute({
      sql: "SELECT bot_id, display_name, enabled, project_id, definition FROM pi_bot_defs ORDER BY bot_id",
      args: [],
    });
    return rows || [];
  } catch { return []; } // table may not exist on this instance
}

/**
 * The local, vocab-normalized catalog with everything projected public-safe.
 * @param {object} db libsql client
 * @param {object} opts { crowHome, instanceId, instanceName }
 */
export async function getLocalCatalog(db, { crowHome = resolveCrowHome(), instanceId = null, instanceName = null } = {}) {
  const tools = [...coreTools(), ...addonTools(crowHome)].map(toPublicTool);
  const skills = localSkills(crowHome).map(toPublicSkill);
  const bots = (await localBots(db)).map(toPublicBot);
  return { instanceId, instanceName, tools, skills, bots };
}
```

- [ ] **Step 4: Run the projection test — expect pass**

Run: `node --test tests/public-projection.test.js`
Expected: PASS — 3 tests.

- [ ] **Step 5: Write the aggregator test**

Create `tests/capability-registry.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { getLocalCatalog, canonicalForCategory } from "../servers/gateway/capability-registry.js";

// Stub db: returns two bot rows.
const db = {
  async execute() {
    return { rows: [
      { bot_id: "a", display_name: "A", enabled: 1, project_id: null, definition: JSON.stringify({ models: { default: "m1" }, tools: { crow_mcp: ["crow-memory/x"] } }) },
      { bot_id: "b", display_name: "B", enabled: 0, project_id: 3, definition: "{}" },
    ] };
  },
};

test("catalog includes core tools with canonical+category and a positive count", async () => {
  const cat = await getLocalCatalog(db, { crowHome: "/tmp/nonexistent-crowhome", instanceId: "self", instanceName: "Self" });
  const mem = cat.tools.find((t) => t.canonicalId === canonicalForCategory("memory"));
  assert.ok(mem, "memory core tool present");
  assert.equal(mem.category, "memory");
  assert.ok(mem.toolCount > 0);
});

test("catalog projects bots public-safe (no definition leak)", async () => {
  const cat = await getLocalCatalog(db, { crowHome: "/tmp/nonexistent-crowhome", instanceId: "self" });
  assert.equal(cat.bots.length, 2);
  assert.equal(cat.bots[0].model, "m1");
  assert.equal(cat.bots[0].tool_count, 1);
  assert.ok(!JSON.stringify(cat.bots).includes("definition"));
  assert.equal(cat.instanceId, "self");
});
```

Note: `crowHome` points at a nonexistent dir so `listInstalledExtensions`/`skillDirs` return empty — the test asserts the core-tool + bot path without depending on machine state.

- [ ] **Step 6: Run it — expect pass**

Run: `node --test tests/capability-registry.test.js`
Expected: PASS — 2 tests. (If `listInstalledExtensions` throws on a missing dir rather than returning `[]`, wrap the `addonTools` loop body in try/catch and re-run.)

- [ ] **Step 7: Commit**

```bash
git add servers/gateway/capability-registry.js tests/capability-registry.test.js tests/public-projection.test.js
git commit servers/gateway/capability-registry.js tests/capability-registry.test.js tests/public-projection.test.js \
  -m "F4a: local capability registry + public-safe projectors"
git show --stat HEAD
```

---

## Task 2: `/dashboard/capabilities` advertisement endpoint

**Files:**
- Modify: `servers/gateway/routes/federation.js` (add a second route to the existing router)
- Test: covered by the manual smoke in Step 4 + the envelope test in Task 3.

- [ ] **Step 1: Add the route**

In `servers/gateway/routes/federation.js`: add the import at the top (with the other imports):
```js
import { getLocalCatalog } from "../capability-registry.js";
```
Inside `export default function federationRouter({ createDbClient })`, **after** the existing `router.get("/overview", ...)` block and **before** `return router;`, add:
```js
  // F4a Layer 1: capability + bot catalog. Same HMAC gate as /overview, separate
  // endpoint so the hot overview stays lean and this larger payload is pulled
  // lazily (only when the Bot Builder/Board panels render). Funnel-blocked via
  // the /dashboard mount; never add to PUBLIC_FUNNEL_PREFIXES.
  router.get("/capabilities", federationVerifyMiddleware(dbForAudit), async (req, res) => {
    const db = createDbClient();
    try {
      const localId = getOrCreateLocalInstanceId();
      const inst = await getInstance(db, localId);
      const catalog = await getLocalCatalog(db, { instanceId: localId, instanceName: inst?.name || null });
      res.type("application/json").send(JSON.stringify({
        instance: { id: localId, name: inst?.name || null },
        capabilities: { tools: catalog.tools, skills: catalog.skills, bots: catalog.bots },
        generatedAt: new Date().toISOString(),
      }));
    } catch (err) {
      console.warn("[federation] capabilities render failed:", err.message);
      res.status(500).json({ error: "capabilities_render_failed" });
    } finally {
      db.close();
    }
  });
```

- [ ] **Step 2: Syntax check**

Run: `node --check servers/gateway/routes/federation.js`
Expected: exit 0.

- [ ] **Step 3: Confirm the route is mounted under /dashboard (no Funnel exposure)**

Run: `grep -rn "federationRouter" servers/gateway/dashboard/index.js`
Expected: a mount line like `app.use("/dashboard", federationRouter({ createDbClient }))` (or similar). Confirm the prefix is `/dashboard` — so the external path is `/dashboard/capabilities`, behind the global `rejectFunneledMiddleware`. If the mount prefix differs, note it; do NOT add `/dashboard/capabilities` to `PUBLIC_FUNNEL_PREFIXES`.

- [ ] **Step 4: Local smoke (no HMAC — call the handler logic via getLocalCatalog)**

The route itself requires HMAC; verifying the payload shape end-to-end is done through `getLocalCatalog` (Task 1 tests) + the envelope validator (Task 3). Confirm the handler wiring compiles and the catalog shape matches what the validator (Task 3) expects: `{ instance:{id,name}, capabilities:{tools[],skills[],bots[]}, generatedAt }`.

- [ ] **Step 5: Commit**

```bash
git commit servers/gateway/routes/federation.js -m "F4a: advertise capability catalog at /dashboard/capabilities (HMAC-gated)"
git show --stat HEAD
```

---

## Task 3: Peer capabilities cache (mirror `overview-cache.js`)

**Files:**
- Create: `servers/gateway/dashboard/capabilities-cache.js`
- Test: `tests/capabilities-cache.test.js`

**Approach:** structurally mirror `servers/gateway/dashboard/overview-cache.js` — read it first. Same cache map, `now()`, stampede protection, `_setFetchImpl`/`_resetCache` test hooks, `forwardSignedRequest` fetch. Differences: path `/dashboard/capabilities`, audit action `federation.capabilities`, TTL 60s, and a capabilities-specific `validateCapabilitiesEnvelope`.

- [ ] **Step 1: Write the envelope-validation + cache test**

Create `tests/capabilities-cache.test.js`:

```js
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getPeerCapabilities, _setFetchImpl, _resetCache, validateCapabilitiesEnvelope } from "../servers/gateway/dashboard/capabilities-cache.js";

beforeEach(() => _resetCache());

test("validateCapabilitiesEnvelope accepts a well-formed payload", () => {
  const ok = validateCapabilitiesEnvelope({
    instance: { id: "abc", name: "Crow" },
    capabilities: {
      tools: [{ canonicalId: "crow-memory", category: "memory", name: "Memory", bundleId: null, toolCount: 5 }],
      skills: [{ name: "research" }],
      bots: [{ bot_id: "x", display_name: "X", enabled: true, project_id: null, tracker_type: "none", model: "m", tool_count: 0 }],
    },
    generatedAt: "2026-06-08T00:00:00Z",
  });
  assert.ok(ok);
  assert.equal(ok.capabilities.tools.length, 1);
});

test("validateCapabilitiesEnvelope rejects junk / missing capabilities", () => {
  assert.equal(validateCapabilitiesEnvelope(null), null);
  assert.equal(validateCapabilitiesEnvelope({ instance: { id: "x" } }), null);
  assert.equal(validateCapabilitiesEnvelope({ capabilities: "nope" }), null);
});

test("validateCapabilitiesEnvelope strips unexpected fields from items", () => {
  const ok = validateCapabilitiesEnvelope({
    instance: { id: "abc", name: null },
    capabilities: { tools: [{ canonicalId: "c", category: "x", name: "n", bundleId: null, toolCount: 1, evil: "DROP" }], skills: [], bots: [] },
    generatedAt: "t",
  });
  assert.ok(!JSON.stringify(ok).includes("DROP"));
});

test("getPeerCapabilities caches a successful fetch", async () => {
  let calls = 0;
  _setFetchImpl(async () => { calls++; return { data: { instance: { id: "p" }, capabilities: { tools: [], skills: [], bots: [] }, generatedAt: "t" }, ttlMs: 60_000 }; });
  const a = await getPeerCapabilities({}, "p", { source: "test" });
  const b = await getPeerCapabilities({}, "p", { source: "test" });
  assert.equal(calls, 1, "second call served from cache");
  assert.equal(a.status, "ok");
  assert.equal(b.status, "ok");
});
```

- [ ] **Step 2: Run it — expect failure (module missing)**

Run: `node --test tests/capabilities-cache.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `capabilities-cache.js`**

Read `servers/gateway/dashboard/overview-cache.js` and create `servers/gateway/dashboard/capabilities-cache.js` mirroring it, with this exact public surface and validator:

```js
/**
 * Per-peer capability-catalog cache (F4a Layer 1). Mirrors overview-cache.js:
 * stampede-protected, validated-on-receive, TTL-cached signed fetch of a peer's
 * /dashboard/capabilities. Longer TTL than overview (catalogs change only on
 * install/uninstall). Receive-side validation is the trust boundary — a
 * compromised peer cannot inject unexpected fields.
 */
import { forwardSignedRequest } from "../../shared/peer-forward.js";
import { getOrCreateLocalInstanceId } from "../instance-registry.js";

const TTL_SUCCESS_MS = 60_000;
const TTL_VIOLATION_MS = 60_000;
const FETCH_TIMEOUT_MS = 2_000;
const MAX_RESPONSE_BYTES = 256 * 1024; // catalogs are larger than overviews
const _cache = new Map();
const now = () => Date.now();
const cacheKey = (id, source = "dashboard") => `${source}::${id}`;

const str = (v, max = 256) => (typeof v === "string" ? v.slice(0, max) : null);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function vTool(t) {
  if (!t || typeof t !== "object") return null;
  return { canonicalId: str(t.canonicalId), category: str(t.category), name: str(t.name), bundleId: t.bundleId == null ? null : str(t.bundleId), toolCount: num(t.toolCount) };
}
function vSkill(s) { return s && typeof s === "object" && str(s.name) ? { name: str(s.name) } : null; }
function vBot(b) {
  if (!b || typeof b !== "object" || !str(b.bot_id)) return null;
  return { bot_id: str(b.bot_id), display_name: str(b.display_name), enabled: !!b.enabled, project_id: b.project_id == null ? null : num(b.project_id), tracker_type: str(b.tracker_type) || "none", model: b.model == null ? null : str(b.model), tool_count: num(b.tool_count) ?? 0 };
}

const CAP_ARRAY = 500; // hard cap per list

export function validateCapabilitiesEnvelope(body) {
  if (!body || typeof body !== "object") return null;
  if (!body.instance || typeof body.instance !== "object" || !str(body.instance.id)) return null;
  const c = body.capabilities;
  if (!c || typeof c !== "object" || !Array.isArray(c.tools) || !Array.isArray(c.skills) || !Array.isArray(c.bots)) return null;
  return {
    instance: { id: str(body.instance.id), name: body.instance.name == null ? null : str(body.instance.name) },
    capabilities: {
      tools: c.tools.map(vTool).filter(Boolean).slice(0, CAP_ARRAY),
      skills: c.skills.map(vSkill).filter(Boolean).slice(0, CAP_ARRAY),
      bots: c.bots.map(vBot).filter(Boolean).slice(0, CAP_ARRAY),
    },
    generatedAt: str(body.generatedAt),
  };
}

function errorSentinel(instanceId, reason) {
  return { instanceId, status: reason === "ok" ? "ok" : "unavailable", reason, capabilities: { tools: [], skills: [], bots: [] } };
}

let _fetchImpl = defaultFetchImpl;
export function _setFetchImpl(fn) { _fetchImpl = fn; }
export function _resetCache() { _cache.clear(); }

async function defaultFetchImpl(db, instanceId) {
  const result = await forwardSignedRequest({
    db, sourceInstanceId: getOrCreateLocalInstanceId(), targetInstanceId: instanceId,
    method: "GET", path: "/dashboard/capabilities", auditAction: "federation.capabilities",
    timeoutMs: FETCH_TIMEOUT_MS, maxResponseBytes: MAX_RESPONSE_BYTES,
  });
  if (!result || !result.ok) return { sentinel: errorSentinel(instanceId, (result && result.error) || "fetch_failed"), ttlMs: null };
  let parsed;
  try { parsed = typeof result.body === "string" ? JSON.parse(result.body) : result.body; } catch { return { sentinel: errorSentinel(instanceId, "parse_error"), ttlMs: TTL_VIOLATION_MS }; }
  const valid = validateCapabilitiesEnvelope(parsed);
  if (!valid) return { sentinel: errorSentinel(instanceId, "schema_violation"), ttlMs: TTL_VIOLATION_MS };
  return { data: { instanceId, status: "ok", ...valid }, ttlMs: TTL_SUCCESS_MS };
}

export async function getPeerCapabilities(db, instanceId, { source = "dashboard" } = {}) {
  const key = cacheKey(instanceId, source);
  const hit = _cache.get(key);
  if (hit && hit.expiresAt > now()) return hit.inflight ? hit.inflight : hit.data;
  const inflight = (async () => {
    const r = await _fetchImpl(db, instanceId);
    if (r.data) { _cache.set(key, { data: r.data, expiresAt: now() + (r.ttlMs || TTL_SUCCESS_MS) }); return r.data; }
    if (r.ttlMs) _cache.set(key, { data: r.sentinel, expiresAt: now() + r.ttlMs });
    else _cache.delete(key); // don't cache hard failures
    return r.sentinel;
  })();
  _cache.set(key, { inflight, expiresAt: now() + FETCH_TIMEOUT_MS + 500 });
  return inflight;
}
```

(Verify against `overview-cache.js` that `forwardSignedRequest`'s return shape is `{ ok, status, body, raw, error }` — adjust the `result.body` access if the real field differs.)

- [ ] **Step 4: Run the test — expect pass**

Run: `node --test tests/capabilities-cache.test.js`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add servers/gateway/dashboard/capabilities-cache.js tests/capabilities-cache.test.js
git commit servers/gateway/dashboard/capabilities-cache.js tests/capabilities-cache.test.js \
  -m "F4a: peer capabilities cache + receive-side envelope validation"
git show --stat HEAD
```

---

## Task 4: `mergeFederatedCatalog`

**Files:**
- Create: `servers/gateway/dashboard/federated-catalog.js`
- Test: `tests/federated-catalog.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/federated-catalog.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeFederatedCatalog } from "../servers/gateway/dashboard/federated-catalog.js";

const local = {
  instanceId: "self", instanceName: "Crow",
  tools: [{ canonicalId: "crow-memory", category: "memory", name: "Memory", bundleId: null, toolCount: 5 }],
  skills: [{ name: "research" }],
  bots: [{ bot_id: "a", display_name: "A", enabled: true, project_id: null, tracker_type: "none", model: "m", tool_count: 0 }],
};
const peers = [
  { instanceId: "p1", status: "ok", instance: { id: "p1", name: "Grackle" }, capabilities: {
    tools: [{ canonicalId: "texas-gov-data", category: "tools", name: "Texas", bundleId: "texas-gov-data", toolCount: 5 }],
    skills: [{ name: "tea" }], bots: [{ bot_id: "z", display_name: "Z", enabled: true, project_id: 1, tracker_type: "none", model: "m2", tool_count: 2 }],
  } },
  { instanceId: "p2", status: "unavailable", reason: "fetch_failed", capabilities: { tools: [], skills: [], bots: [] } },
];

test("local items tagged self; peer items tagged owner + remote", () => {
  const m = mergeFederatedCatalog(local, peers, "self");
  const localTool = m.tools.find((t) => t.canonicalId === "crow-memory");
  assert.equal(localTool.instance, "self");
  assert.ok(!localTool.remote);
  const peerTool = m.tools.find((t) => t.canonicalId === "texas-gov-data");
  assert.equal(peerTool.instance, "p1");
  assert.equal(peerTool.instanceName, "Grackle");
  assert.equal(peerTool.remote, true);
  const peerBot = m.bots.find((b) => b.bot_id === "z");
  assert.equal(peerBot.remote, true);
  assert.equal(peerBot.instanceName, "Grackle");
});

test("an unavailable peer contributes nothing and never throws", () => {
  const m = mergeFederatedCatalog(local, peers, "self");
  assert.ok(!m.tools.some((t) => t.instance === "p2"));
  assert.ok(!m.bots.some((b) => b.instance === "p2"));
});

test("handles empty / null peer list", () => {
  const m = mergeFederatedCatalog(local, [], "self");
  assert.equal(m.tools.length, 1);
  assert.equal(m.bots.length, 1);
  assert.doesNotThrow(() => mergeFederatedCatalog(local, null, "self"));
});
```

- [ ] **Step 2: Run it — expect failure**

Run: `node --test tests/federated-catalog.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `servers/gateway/dashboard/federated-catalog.js`:

```js
/**
 * Merge the local catalog with peer catalogs into a mesh view (F4a Layer 1).
 * Mirrors the mergeDiscoveredPeers spirit: local items are tagged with the
 * local instance; each peer's items are tagged with that peer's id/name and
 * remote:true. An unavailable peer (status !== "ok") simply contributes
 * nothing — never throws, never blocks.
 */
function tag(items, instance, instanceName, remote) {
  return (Array.isArray(items) ? items : []).map((it) => ({ ...it, instance, instanceName, remote }));
}

export function mergeFederatedCatalog(localCatalog, peerCatalogs, localId) {
  const lc = localCatalog || { tools: [], skills: [], bots: [] };
  const out = {
    tools: tag(lc.tools, localId, lc.instanceName || null, false),
    skills: tag(lc.skills, localId, lc.instanceName || null, false),
    bots: tag(lc.bots, localId, lc.instanceName || null, false),
  };
  for (const peer of (Array.isArray(peerCatalogs) ? peerCatalogs : [])) {
    if (!peer || peer.status !== "ok" || !peer.capabilities) continue;
    const id = peer.instanceId || (peer.instance && peer.instance.id);
    const name = (peer.instance && peer.instance.name) || null;
    out.tools.push(...tag(peer.capabilities.tools, id, name, true));
    out.skills.push(...tag(peer.capabilities.skills, id, name, true));
    out.bots.push(...tag(peer.capabilities.bots, id, name, true));
  }
  return out;
}
```

- [ ] **Step 4: Run it — expect pass**

Run: `node --test tests/federated-catalog.test.js`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add servers/gateway/dashboard/federated-catalog.js tests/federated-catalog.test.js
git commit servers/gateway/dashboard/federated-catalog.js tests/federated-catalog.test.js \
  -m "F4a: mergeFederatedCatalog (local + peer catalogs with ownership tags)"
git show --stat HEAD
```

---

## Task 5: Bot Board — "Bots on other instances" section

**Files:**
- Modify: `servers/gateway/dashboard/panels/bot-board.js`

**Context:** the handler is async, has `db` in scope, and renders via `layout`. The local bot list is built around line 405 (`SELECT ... FROM pi_bot_defs WHERE enabled=1`). Peer bots come from the federated catalog. Use the same peer set the nest carousel uses: `getTrustedInstances(db)` + gossip-discovered peers. To keep this task self-contained and resilient, gather peer catalogs with a budgeted `Promise.allSettled` and render below the local switcher.

- [ ] **Step 1: Add imports** (with the other imports at the top of `bot-board.js`)

```js
import { getPeerCapabilities } from "../capabilities-cache.js";
import { getTrustedInstances } from "./nest/data-queries.js";
import { getOrCreateLocalInstanceId } from "../../instance-registry.js";
```

- [ ] **Step 2: Add a helper to gather peer bots** (module scope, after imports)

```js
// F4a: best-effort federated peer bots. Budgeted; a slow/offline peer is skipped.
async function gatherPeerBots(db) {
  let peers = [];
  try { peers = await getTrustedInstances(db); } catch { return []; }
  if (!peers.length) return [];
  const localId = getOrCreateLocalInstanceId();
  const settled = await Promise.allSettled(
    peers.filter((p) => p.id !== localId).map((p) => getPeerCapabilities(db, p.id, { source: "bot-board" }))
  );
  const out = [];
  for (const s of settled) {
    if (s.status !== "fulfilled" || !s.value || s.value.status !== "ok") continue;
    const inst = s.value.instance || {};
    for (const b of (s.value.capabilities?.bots || [])) {
      out.push({ ...b, instanceId: s.value.instanceId, instanceName: inst.name || s.value.instanceId });
    }
  }
  return out;
}
```

- [ ] **Step 3: Render the section.** In the no-bot-selected view (the `if (!selBot)` branch, ~line 482) and/or below the switcher, after the local content is assembled, call the helper and append a read-only section. Locate the `return layout({ ... content: PAGE_CSS + section("Bot Board", notice + switcher + ... )})` for the `!selBot` branch and insert, before that return:

```js
    const peerBots = await gatherPeerBots(db);
    const peerBotsHtml = peerBots.length === 0 ? "" :
      section("Bots on other instances",
        `<table class="bb-list-table"><thead><tr><th>Bot</th><th>Instance</th><th>Model</th></tr></thead><tbody>` +
        peerBots.map((b) =>
          `<tr><td>${escapeHtml(b.display_name || b.bot_id)}</td>` +
          `<td>${escapeHtml(b.instanceName)}</td>` +
          `<td>${escapeHtml(b.model || "—")}</td></tr>`
        ).join("") +
        `</tbody></table><p class="bb-msg">Read-only — these bots live on other instances. Open that instance's dashboard to edit or run them.</p>`);
```

Then append `peerBotsHtml` into that branch's content string (e.g. `content: PAGE_CSS + section("Bot Board", notice + switcher + ...) + peerBotsHtml + drawerMarkup() + ...`). `escapeHtml` and `section` are already imported in this file.

- [ ] **Step 4: Syntax check**

Run: `node --check servers/gateway/dashboard/panels/bot-board.js`
Expected: exit 0.

- [ ] **Step 5: Render smoke (no peers → section absent; never throws)**

```bash
TMP=$(mktemp -d); CROW_DATA_DIR=$TMP CROW_DB_PATH=$TMP/crow.db node scripts/init-db.js >/dev/null 2>&1
node --input-type=module -e "
import panel from './servers/gateway/dashboard/panels/bot-board.js';
import { createDbClient } from './servers/db.js';
process.env.CROW_DATA_DIR='$TMP'; process.env.CROW_DB_PATH='$TMP/crow.db';
const db = createDbClient(); const layout = (o)=>o.content ?? o;
let out=''; const res={ send:(h)=>{out=String(h);}, redirectAfterPost:()=>{}, type:()=>res };
const r = await panel.handler({ method:'GET', query:{}, body:{} }, res, { db, layout });
const html = String(r ?? out);
console.log('renders without throw:', html.length>0);
console.log('no peers -> no remote section:', !html.includes('Bots on other instances'));
"; rm -rf "$TMP"
```
Expected: `renders without throw: true` and `no peers -> no remote section: true`. (If `getTrustedInstances` returns local-only or empty on this isolated DB, the section is correctly absent.)

- [ ] **Step 6: Commit**

```bash
git commit servers/gateway/dashboard/panels/bot-board.js -m "F4a: Bot Board shows read-only peer bots (federated)"
git show --stat HEAD
```

---

## Task 6: Bot Builder — collapsed remote-capabilities group

**Files:**
- Modify: `servers/gateway/dashboard/panels/bot-builder.js`

**Context:** the Tools&Extensions tab renders local tools around lines 763–836 (builtin + MCP via `probeAll` + extensions via `probeExtensions`). Add a separate, **read-only, collapsed** group listing peer-available capabilities (tools), labeled by owning instance, NOT selectable. Reuse the same `gatherPeerBots`-style peer fetch but for tools.

- [ ] **Step 1: Add imports** (with the other imports)

```js
import { getPeerCapabilities } from "../capabilities-cache.js";
import { getTrustedInstances } from "./nest/data-queries.js";
```
(`getOrCreateLocalInstanceId` — check if already imported in this file via instance-registry; if not, add `import { getOrCreateLocalInstanceId } from "../../instance-registry.js";`.)

- [ ] **Step 2: Add a peer-tools gatherer** (module scope)

```js
// F4a: best-effort federated peer tools (read-only display). Budgeted; offline peers skipped.
async function gatherPeerTools(db) {
  let peers = [];
  try { peers = await getTrustedInstances(db); } catch { return []; }
  if (!peers.length) return [];
  const localId = getOrCreateLocalInstanceId();
  const settled = await Promise.allSettled(
    peers.filter((p) => p.id !== localId).map((p) => getPeerCapabilities(db, p.id, { source: "bot-builder" }))
  );
  const out = [];
  for (const s of settled) {
    if (s.status !== "fulfilled" || !s.value || s.value.status !== "ok") continue;
    const inst = s.value.instance || {};
    for (const t of (s.value.capabilities?.tools || [])) {
      out.push({ ...t, instanceName: inst.name || s.value.instanceId });
    }
  }
  return out;
}
```

- [ ] **Step 3: Render the collapsed group** in the Tools tab. After the local tools HTML is built (near the end of the tools-tab render, ~line 836), add:

```js
      const peerTools = await gatherPeerTools(db);
      const peerToolsHtml = peerTools.length === 0 ? "" :
        `<details class="btb-remote-caps"><summary>Available on ${new Set(peerTools.map((t) => t.instanceName)).size} peer instance(s) ▸</summary>` +
        `<p class="btb-hint">Read-only — these tools live on other instances. Usable from a bot here once cross-instance calling lands (F4a Layer 2).</p>` +
        `<ul>` + peerTools.map((t) =>
          `<li>${escapeHtml(t.name)} <span class="btb-muted">(${escapeHtml(t.category)} · ${escapeHtml(t.instanceName)})</span></li>`
        ).join("") + `</ul></details>`;
```

Append `peerToolsHtml` into the tools-tab body string where the tab content is assembled (after the local tool checkboxes/groups, before the tab's closing). `escapeHtml` is already imported.

- [ ] **Step 4: Syntax check**

Run: `node --check servers/gateway/dashboard/panels/bot-builder.js`
Expected: exit 0.

- [ ] **Step 5: Render smoke (editor renders; no peers → no remote group; remote tools never selectable)**

```bash
TMP=$(mktemp -d); CROW_DATA_DIR=$TMP CROW_DB_PATH=$TMP/crow.db node scripts/init-db.js >/dev/null 2>&1
node --input-type=module -e "
import panel from './servers/gateway/dashboard/panels/bot-builder.js';
import { createDbClient } from './servers/db.js';
process.env.CROW_DATA_DIR='$TMP'; process.env.CROW_DB_PATH='$TMP/crow.db';
const db = createDbClient();
await db.execute({ sql:\"INSERT INTO pi_bot_defs (bot_id,display_name,definition,enabled) VALUES ('t','T','{}',1)\", args:[] });
const layout=(o)=>o.content ?? o;
let out=''; const res={ send:(h)=>{out=String(h);}, redirectAfterPost:()=>{}, type:()=>res };
await panel.handler({ method:'GET', query:{ bot:'t', tab:'tools' }, body:{} }, res, { db, layout });
console.log('tools tab renders:', out.includes('btb') || out.length>500);
console.log('no peers -> no remote group:', !out.includes('peer instance'));
"; rm -rf "$TMP"
```
Expected: `tools tab renders: true` and `no peers -> no remote group: true`.

- [ ] **Step 6: Commit**

```bash
git commit servers/gateway/dashboard/panels/bot-builder.js -m "F4a: Bot Builder shows collapsed read-only peer capabilities group"
git show --stat HEAD
```

---

## Task 7: Invariant sweep + full F4a test run

**Files:** none (verification only).

- [ ] **Step 1: Network-exposure invariant + capabilities route not public**

```bash
node tests/auth-network.test.js 2>&1 | grep -E "^# (tests|pass|fail)"
grep -rn "capabilities" servers/gateway/index.js servers/gateway/dashboard/index.js | grep -i "funnel\|PUBLIC_FUNNEL" || echo "OK: /dashboard/capabilities not in any funnel-public list"
```
Expected: auth-network `fail 0`; the grep prints the OK line (capabilities is NOT funnel-exposed).

- [ ] **Step 2: Full F4a test set**

```bash
node --test tests/public-projection.test.js tests/capability-registry.test.js tests/capabilities-cache.test.js tests/federated-catalog.test.js 2>&1 | grep -E "^# (tests|pass|fail)"
```
Expected: all pass, fail 0.

- [ ] **Step 3: Scoped-diff check**

```bash
git diff --stat main...feat/f4a-federated-discovery
```
Expected: only the files in the File Structure table (+ the spec/plan docs). No strays.

- [ ] **Step 4: STOP — hand back for the merge/deploy decision.** Do NOT auto-merge or deploy. Deploy (when chosen) is `git pull --ff-only` + restart `crow-gateway` (+ `crow-mpa-gateway` on crow) + grackle — **no `init-db`** (F4a adds no tables). Single-host at a time, verify health after each, per the resource note.

---

## Self-Review

**Spec coverage:**
- Local registry (vocab-normalized, fresh-on-install) → Task 1. ✓
- Public-safe projectors (strict whitelist, no definition leak) → Task 1 + `public-projection.test.js`. ✓
- `/dashboard/capabilities` HMAC-gated endpoint → Task 2. ✓
- `capabilities-cache.js` (mirror overview-cache, 60s TTL, receive-side validation) → Task 3. ✓
- `mergeFederatedCatalog` (ownership tags, down-peer resilience) → Task 4. ✓
- Bot Board peer-bots section (read-only, link context) → Task 5. ✓
- Bot Builder collapsed remote group (visible-not-selectable, count) → Task 6. ✓
- Invariants (auth-network, not funnel-public) → Task 7. ✓
- Non-goals honored: no invocation, no pi_bot_defs sync, no bundle audit. ✓

**Placeholder scan:** No TBD/TODO. The panel tasks (5, 6) name the exact insertion regions but require the implementer to locate the precise content-assembly string in two large files — bounded with grep anchors + render smokes that fail loudly if the section didn't wire in. The `forwardSignedRequest` return-field access in Task 3 is flagged to verify against the real signature.

**Type consistency:** `getLocalCatalog`/`toPublicBot`/`toPublicTool`/`toPublicSkill` (Task 1) consumed identically in Tasks 2–4. `validateCapabilitiesEnvelope`/`getPeerCapabilities` (Task 3) used in Tasks 5–6. `mergeFederatedCatalog` signature `(local, peers, localId)` consistent. Catalog shape `{instance,capabilities:{tools,skills,bots},generatedAt}` identical across producer (Task 2) and validator (Task 3). Bot projection fields match between `toPublicBot` (Task 1) and `vBot` (Task 3).
