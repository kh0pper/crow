# Overhaul Wave 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the 7 Wave-1 findings from `docs/superpowers/specs/2026-06-10-overhaul-findings.md` — funnel boundary hardening, path-validation trio, auth hygiene, housekeeping sweep, token quick-wins, crash-proofing, docs fixes.

**Architecture:** All changes are small, behavior-preserving hardening/cleanup on existing modules; no new subsystems. One branch `overhaul/wave-1`, one commit per task, positional-path commits only (`git commit <paths> -m ...`, never `git add -A`).

**Tech Stack:** Node ESM, better-sqlite3 via `servers/db.js` client, Node built-in test runner (`node --test`).

**Executor guardrails:** positional-path commits only; **never add a `Co-Authored-By` trailer or any Claude attribution to commits**; no DB schema changes anywhere in this wave.

**Pre-verified facts (lead checked against live tree @ `b5db760`):** funnel bug at `funnel.js:40`; `normalizeSkillName` exists at `scripts/pi-bots/skill_proposals.mjs:42` and that module imports only node builtins (no cycle); `verifyAuthToken` has zero callers; all 53 `*.bak` files are untracked & gitignored; all 8 local branches fully merged; `deleteObject(key, bucket)` exists at `servers/storage/s3-client.js:287` and is already imported in `storage/server.js`; `proxy.js:327/:372` + `providers.js:79` are ALREADY guarded (do NOT touch); the live router serves ~10 category tools (varies by bundles), so comments must go count-neutral.

---

### Task 1: Funnel prefix segment-anchoring (W1-1)

**Files:**
- Modify: `servers/gateway/funnel.js:40`
- Test: `tests/auth-network.test.js` (append)

- [ ] **Step 1: Write the failing test** — append to `tests/auth-network.test.js`:

```js
import { rejectFunneledMiddleware } from "../servers/gateway/funnel.js";

function runFunnelMw(path, { funnel = true } = {}) {
  const mw = rejectFunneledMiddleware();
  const req = { headers: funnel ? { "tailscale-funnel-request": "?1" } : {}, path };
  let statusCode = null;
  let nexted = false;
  const res = {
    status(c) { statusCode = c; return this; },
    type() { return this; },
    send() { return this; },
  };
  mw(req, res, () => { nexted = true; });
  return { statusCode, nexted };
}

test("funnel: public prefixes pass, lookalike paths are rejected", () => {
  assert.equal(runFunnelMw("/blog").nexted, true);
  assert.equal(runFunnelMw("/blog/feed.xml").nexted, true);
  assert.equal(runFunnelMw("/robots.txt").nexted, true);
  assert.equal(runFunnelMw("/.well-known/oauth-authorization-server").nexted, true);
  // segment-anchoring: a lookalike prefix must NOT pass
  assert.equal(runFunnelMw("/blogX").statusCode, 403);
  assert.equal(runFunnelMw("/robots.txt.bak").statusCode, 403);
  assert.equal(runFunnelMw("/favicon.ico2").statusCode, 403);
  // private paths still rejected
  assert.equal(runFunnelMw("/dashboard").statusCode, 403);
  // non-funnel requests always pass this middleware
  assert.equal(runFunnelMw("/dashboard", { funnel: false }).nexted, true);
});
```

Also: `tests/auth-network.test.js:81-96` contains an inline COPY of the funnel middleware (`makeFunnelMiddleware`) with the old prefix logic, used by five integration tests. Replace that copy with the real import (`rejectFunneledMiddleware` from `../servers/gateway/funnel.js`) so the tests exercise production code and can't silently diverge — the middleware is fully synchronous and imports nothing, so this is a drop-in.

- [ ] **Step 2: Run to verify it fails** — `node --test tests/auth-network.test.js` → the `/blogX` assertion FAILS (currently `nexted === true`).
- [ ] **Step 3: Fix** `servers/gateway/funnel.js:40` — replace:

```js
    if (PUBLIC_FUNNEL_PREFIXES.some((p) => req.path === p || req.path.startsWith(p))) return next();
```

with:

```js
    if (
      PUBLIC_FUNNEL_PREFIXES.some(
        (p) => req.path === p || (req.path.startsWith(p) && (p.endsWith("/") || req.path[p.length] === "/")),
      )
    )
      return next();
```

- [ ] **Step 4: Run** `node --test tests/auth-network.test.js` → all PASS.
- [ ] **Step 5: Commit** — `git add tests/auth-network.test.js && git commit servers/gateway/funnel.js tests/auth-network.test.js -m "security: segment-anchor the funnel public-prefix match (W1-1)"`

### Task 2: Path-validation trio (W1-2)

**Files:**
- Modify: `scripts/pi-bots/skill_resolver.mjs:39-45`, `servers/gateway/dashboard/panels/bot-builder.js:698` (+its import block ~line 50), `servers/gateway/dashboard/panel-registry.js:54`
- Test: `tests/skill-name-validation.test.js` (create)

- [ ] **Step 1: Write the failing test** — create `tests/skill-name-validation.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSkill } from "../scripts/pi-bots/skill_resolver.mjs";
import { normalizeSkillName } from "../scripts/pi-bots/skill_proposals.mjs";

test("resolveSkill rejects traversal and separator names", () => {
  assert.equal(resolveSkill("../../etc/passwd"), null);
  assert.equal(resolveSkill("/etc/passwd"), null);
  assert.equal(resolveSkill("..\\..\\x"), null);
  assert.equal(resolveSkill("foo/../bar"), null);
});

test("valid kebab names pass validation", () => {
  // resolution depends on env skill dirs; what matters is the validator accepts valid names
  assert.equal(normalizeSkillName("memory-management"), "memory-management");
});

test("normalizeSkillName accepts kebab and strips .md", () => {
  assert.equal(normalizeSkillName("My-Skill.md"), "my-skill");
  assert.equal(normalizeSkillName("emoji💥"), null);
});
```

- [ ] **Step 2: Run to verify failure** — `node --test tests/skill-name-validation.test.js` → traversal test FAILS (resolveSkill currently joins blindly; `../../etc/passwd` would only return null if the file doesn't exist — on this box `/etc/passwd` EXISTS relative to `~/.crow/skills/../../../etc/passwd`? `join("/home/kh0pp/.crow/skills", "../../etc/passwd.md")` = `/home/kh0pp/etc/passwd.md` which doesn't exist → may accidentally pass. The `"/etc/passwd"` absolute case: `join(dir, "/etc/passwd.md")` = `dir/etc/passwd.md` — also missing. **Expected: test may PASS by luck; that's fine — it pins the contract.** Continue regardless.)
- [ ] **Step 3: Harden `resolveSkill`** in `scripts/pi-bots/skill_resolver.mjs` — add import and validation:

```js
import { normalizeSkillName } from "./skill_proposals.mjs";

/** Resolve one skill name to {name, path, text} or null (searched in order). */
export function resolveSkill(name, opts = {}) {
  const base = normalizeSkillName(name);
  if (!base) return null;
  const fname = base + ".md";
  for (const dir of skillDirs(opts.crowHome)) {
    const p = join(dir, fname);
    if (existsSync(p)) return { name, path: p, text: readFileSync(p, "utf8") };
  }
  return null;
}
```

- [ ] **Step 4: Validate bot skills on save** — `servers/gateway/dashboard/panels/bot-builder.js:698`: add `normalizeSkillName` to the existing `skill_proposals.mjs` import (the file already imports `listProposals` from it at ~line 50), then replace:

```js
          def.skills = [].concat(b.skills || []).filter(Boolean);
```

with:

```js
          def.skills = [].concat(b.skills || [])
            .map((s) => normalizeSkillName(s))
            .filter(Boolean);
```

- [ ] **Step 5: Validate panel IDs** — `servers/gateway/dashboard/panel-registry.js`, top of the `for (const id of enabledIds)` loop (line ~54):

```js
  const PANEL_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
  for (const id of enabledIds) {
    if (typeof id !== "string" || !PANEL_ID_RE.test(id)) {
      console.warn(`[dashboard] Ignoring invalid third-party panel id: ${JSON.stringify(id)}`);
      continue;
    }
    const panelPath = join(panelsDir, `${id}.js`);
```

(declare `PANEL_ID_RE` once above the loop, not inside it)

- [ ] **Step 6: Run** `node --test tests/skill-name-validation.test.js` → PASS; boot check `timeout 5 node servers/gateway/index.js --no-auth` exits cleanly after banner (ctrl-C semantics: timeout kill is fine — look for startup banner, no stack trace).
- [ ] **Step 7: Commit** — `git add tests/skill-name-validation.test.js && git commit scripts/pi-bots/skill_resolver.mjs servers/gateway/dashboard/panels/bot-builder.js servers/gateway/dashboard/panel-registry.js tests/skill-name-validation.test.js -m "security: validate skill names + third-party panel ids (W1-2)"`

### Task 3: Auth hygiene — dead fn + ensureColumn guard (W1-3)

**Files:**
- Modify: `servers/gateway/instance-registry.js:38-44`, `servers/db.js:133-140`, `bundles/media/server/db.js` (same `ensureColumn` copy at ~line 77)

- [ ] **Step 1: Confirm zero callers** — `grep -rn "verifyAuthToken" servers/ scripts/ bundles/ --include='*.js' --include='*.mjs'` → only the definition line. (Pre-verified by lead; re-confirm.)
- [ ] **Step 2: Delete** the `verifyAuthToken` function and its JSDoc block from `servers/gateway/instance-registry.js` (lines ~38-44). If `createHash` becomes unused in that file's imports, remove it from the import list (check first: it's likely used elsewhere for token hashing — only remove if truly unused).
- [ ] **Step 3: Guard `ensureColumn`** in `servers/db.js`:

```js
const SQL_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SQL_COLTYPE_RE = /^[A-Za-z0-9_() '"-]+$/;

export async function ensureColumn(db, table, column, type) {
  if (!SQL_IDENT_RE.test(table) || !SQL_IDENT_RE.test(column) || !SQL_COLTYPE_RE.test(type)) {
    throw new Error(`ensureColumn: invalid identifier or type (${table}.${column} ${type})`);
  }
  try {
    await db.execute({ sql: `ALTER TABLE ${table} ADD COLUMN ${column} ${type}`, args: [] });
  } catch (err) {
    // Column already exists — safe to ignore
    if (!err.message?.includes("duplicate column")) throw err;
  }
}
```

Apply the same guard to the copy in `bundles/media/server/db.js`.

- [ ] **Step 4: Unit test the guard** — create `tests/ensure-column-guard.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureColumn } from "../servers/db.js";

function fakeDb() {
  const calls = [];
  return { calls, async execute(q) { calls.push(q.sql); return { rows: [] }; } };
}

test("ensureColumn rejects malicious identifiers", async () => {
  const db = fakeDb();
  await assert.rejects(() => ensureColumn(db, "memories;DROP TABLE x;--", "c", "TEXT"));
  await assert.rejects(() => ensureColumn(db, "memories", "c; --", "TEXT"));
  await assert.rejects(() => ensureColumn(db, "memories", "c", "TEXT; DROP TABLE x"));
  assert.equal(db.calls.length, 0, "no SQL must reach the db on rejection");
});

test("ensureColumn passes valid identifiers through", async () => {
  const db = fakeDb();
  await ensureColumn(db, "memories", "new_col", "TEXT");
  assert.equal(db.calls.length, 1);
});
```

Run: `node --test tests/ensure-column-guard.test.js` → PASS.
- [ ] **Step 5: Verify** — `node --test tests/` (full suite) → no regressions; gateway boots (`timeout 5 node servers/gateway/index.js --no-auth`).
- [ ] **Step 6: Commit** — `git add tests/ensure-column-guard.test.js && git commit servers/gateway/instance-registry.js servers/db.js bundles/media/server/db.js tests/ensure-column-guard.test.js -m "security: drop dead timing-unsafe verifyAuthToken; guard ensureColumn identifiers (W1-3)"`

### Task 4: Housekeeping sweep (W1-4)

**Files:**
- Delete (untracked): 53 `*.bak` files (list via `find . -name "*.bak" -not -path "./node_modules/*" -not -path "./docs/node_modules/*" -not -path "./bundles/*"` — plus `bundles/media`-adjacent ones are excluded; they're all gitignored)
- Modify: `CLAUDE.md:9`, `servers/gateway/router.js:8`, `servers/gateway/index.js:13,738,1378`
- Branches: prune 8 local + ~24 merged remote

- [ ] **Step 1: Delete .bak files** — `find . -name "*.bak" -not -path "./node_modules/*" -not -path "./docs/node_modules/*" -not -path "./bundles/*/node_modules/*" -delete` then verify `find . -name "*.bak" -not -path "*/node_modules/*" | wc -l` → 0. (~56 files, ALL untracked: `git ls-files | grep '\.bak'` is empty — no commit needed for deletions. `*.bak` already in `.gitignore:57`.)
- [ ] **Step 2: Prune local merged branches** — for each of `feat/f3b-bot-runtime-distribution feat/f4a-layer2a-remote-invocation feat/f4a-layer2b-remote-invocation feat/local-model-packs feature/cross-instance-sso fix/crow-instances-data-dir-column fix/l2b-peer-tokens-path fix/portable-better-sqlite3-import`: `git branch -d <b>` (`-d` refuses if unmerged — that's the safety).
- [ ] **Step 3: Remote branch pruning is DEFERRED to Task 8 Step 5** (after the security-review gate — it's the only irreversible-ish operation in the wave, so it goes last).
- [ ] **Step 4: Fix CLAUDE.md test claim** — `CLAUDE.md:9`, replace:

```
- **Tests**: no test framework. Verify a server starts cleanly with `node servers/<name>/index.js` (ctrl-C to exit) or `node servers/gateway/index.js --no-auth` for the gateway. Gateway tests live at `servers/gateway/__tests__/`.
```

with:

```
- **Tests**: Node built-in test runner, no third-party framework — `node --test tests/<file>.test.js` (all tests live in `tests/*.test.js`). Also verify a server starts cleanly: `node servers/<name>/index.js` (ctrl-C to exit) or `node servers/gateway/index.js --no-auth` for the gateway.
```

- [ ] **Step 5: Count-neutral router comments** — the live tool count varies by installed bundles (~10 on this instance), so stop hardcoding numbers:
  - `servers/gateway/router.js:4`: `Exposes ~7 category tools instead of 49+ individual tools` → `Exposes one category tool per server instead of the full raw tool surface`
  - `servers/gateway/index.js:13`: `Consolidated router (7 tools instead of 49+, ~75% context reduction)` → `Consolidated router (category tools instead of the full raw tool surface; major context reduction)`
  - `servers/gateway/index.js:738`: `console.log("Router server mounted (8 tools instead of 58+)")` → `console.log("Router server mounted (category tools instead of the full raw tool surface)")`
  - `servers/gateway/index.js:1378`: `(7 tools, recommended)` → `(category tools, recommended)`
- [ ] **Step 6: Verify + commit** — `node --test tests/auth-network.test.js` still passes; `git commit CLAUDE.md servers/gateway/router.js servers/gateway/index.js -m "chore: housekeeping — fix stale test-path claim, count-neutral router comments (W1-4)"` (branch pruning + .bak deletion need no commit).

### Task 5: Token quick wins — context cache + batched access tracking (W1-5)

**Files:**
- Modify: `servers/memory/crow-context.js` (cache on BOTH `generateCrowContext` :35 and `generateCondensedContext` :239 — the condensed one is the per-handshake path via `servers/shared/instructions.js:49` and carries the headline token win), `servers/memory/server.js:271-276, 380-386` (batch), `servers/memory/server.js` context-mutation handlers (~lines 927, 992, 1071 — invalidate), `servers/gateway/dashboard/panels/skills.js:108,127` (invalidate — gateway-process writers)
- Test: `tests/crow-context-cache.test.js` (create)

**Cache design notes (from plan review):** `generateCrowContext` has THREE return sites — error-fallback (`:45`), empty-sections fallback (`:49`), and the normal `parts.join` (`:83`). Cache the normal AND empty-sections returns (an empty config is a legitimate state); do NOT cache the error-fallback (transient DB failure must not stick for 60s). `generateCondensedContext` likewise — find its return sites and apply the same rule. Invalidation only clears the cache in the SAME process; cross-process staleness (memory-server edit vs gateway cache) is bounded by the 60s TTL, which is the accepted design bound. Peer-sync writes to `crow_context` (`instance-sync.js`) are likewise TTL-bounded — say so in the code comment.

- [ ] **Step 1: Write the failing test** — create `tests/crow-context-cache.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateCrowContext,
  generateCondensedContext,
  invalidateContextCache,
} from "../servers/memory/crow-context.js";

const SECTION_ROW = {
  id: 1, section_key: "identity", section_title: "Identity", content: "You are Crow.",
  enabled: 1, sort_order: 0, device_id: null, project_id: null,
};

function countingDb() {
  let calls = 0;
  return {
    get calls() { return calls; },
    async execute() { calls++; return { rows: [SECTION_ROW] }; },
  };
}

test("generateCrowContext caches within TTL and invalidates on demand", async () => {
  invalidateContextCache();
  const db = countingDb();
  await generateCrowContext(db, { includeDynamic: false, platform: "generic" });
  const after1 = db.calls;
  assert.ok(after1 > 0, "first call must hit the db");
  await generateCrowContext(db, { includeDynamic: false, platform: "generic" });
  assert.equal(db.calls, after1, "second call within TTL must not hit the db");
  invalidateContextCache();
  await generateCrowContext(db, { includeDynamic: false, platform: "generic" });
  assert.ok(db.calls > after1, "invalidation must force regeneration");
});

test("cache is keyed by options", async () => {
  invalidateContextCache();
  const db = countingDb();
  await generateCrowContext(db, { includeDynamic: false, platform: "generic" });
  const after1 = db.calls;
  await generateCrowContext(db, { includeDynamic: false, platform: "claude" });
  assert.ok(db.calls > after1, "different platform must not share a cache entry");
});

test("generateCondensedContext caches too, on its own keys", async () => {
  invalidateContextCache();
  const db = countingDb();
  await generateCondensedContext(db, { routerStyle: false });
  const after1 = db.calls;
  await generateCondensedContext(db, { routerStyle: false });
  assert.equal(db.calls, after1, "condensed: second call within TTL must not hit the db");
  await generateCondensedContext(db, { routerStyle: true });
  assert.ok(db.calls > after1, "condensed: routerStyle must key separately");
});
```

- [ ] **Step 2: Run to verify failure** — `node --test tests/crow-context-cache.test.js` → FAIL (`invalidateContextCache` not exported).
- [ ] **Step 3: Add the cache** in `servers/memory/crow-context.js` — module level, above `generateCrowContext`:

```js
// 60s TTL cache: the full context is regenerated per crow_get_context/resource/HTTP
// call and the condensed form per MCP handshake; content only changes on section
// edits (invalidated in-process below) or slow-moving dynamic stats. Cross-process
// edits (e.g. memory-server vs gateway) and peer-sync writes to crow_context are
// bounded by the TTL, not by invalidation — 60s staleness is the accepted design.
const _ctxCache = new Map(); // key → { text, at }
const CTX_CACHE_TTL_MS = 60_000;

function _cacheGet(key) {
  const hit = _ctxCache.get(key);
  return hit && Date.now() - hit.at < CTX_CACHE_TTL_MS ? hit.text : null;
}

function _cacheSet(key, text) {
  _ctxCache.set(key, { text, at: Date.now() });
  return text;
}

export function invalidateContextCache() {
  _ctxCache.clear();
}
```

In `generateCrowContext` (after destructuring opts):

```js
  const cacheKey = JSON.stringify(["full", includeDynamic, platform, deviceId, projectId]);
  const cached = _cacheGet(cacheKey);
  if (cached !== null) return cached;
```

At the empty-sections fallback (`:49`): `return _cacheSet(cacheKey, getFallbackDocument());` — leave the error-fallback (`:45`) uncached. At the normal return: `return _cacheSet(cacheKey, parts.join("\n"));`

In `generateCondensedContext` (`:239`, after destructuring): same pattern with `const cacheKey = JSON.stringify(["condensed", routerStyle, deviceId, projectId]);` — apply `_cacheGet` up front and `_cacheSet` at every non-error return site (read the function; do not cache returns reached via a caught DB error).

- [ ] **Step 4: Invalidate on mutation** — (a) in `servers/memory/server.js`, extend the existing `./crow-context.js` import with `invalidateContextCache`; call it once per handler immediately after the successful `crow_context` write in `crow_update_context_section` (~927), `crow_add_context_section` (~992), `crow_delete_context_section` (~1071) — reviewer verified each handler has exactly ONE write site (`:976/:1010/:1098`). (b) in `servers/gateway/dashboard/panels/skills.js`, the UPDATEs at `:108` and `:127` also write `crow_context` from the GATEWAY process (which caches via `gateway/index.js:506` and `router.js:486`) — import `invalidateContextCache` from `../../../memory/crow-context.js` (verify the relative path from that file) and call it after each.
- [ ] **Step 5: Batch access tracking** — `servers/memory/server.js`, replace BOTH per-row loops (lines ~271-276 and ~380-386):

```js
      for (const row of rows) {
        await db.execute({
          sql: "UPDATE memories SET accessed_at = datetime('now'), access_count = access_count + 1 WHERE id = ?",
          args: [row.id],
        });
      }
```

with:

```js
      if (rows.length > 0) {
        await db.execute({
          sql: `UPDATE memories SET accessed_at = datetime('now'), access_count = access_count + 1 WHERE id IN (${rows.map(() => "?").join(",")})`,
          args: rows.map((r) => r.id),
        });
      }
```

(indentation differs at the two sites — match each site's)

- [ ] **Step 6: Run** — `node --test tests/crow-context-cache.test.js` → PASS; `node --test tests/` full suite green; boot the memory server: `timeout 5 node servers/memory/index.js` (or its documented entry — check `package.json` `memory-server` script) → clean banner.
- [ ] **Step 7: Commit** — `git add tests/crow-context-cache.test.js && git commit servers/memory/crow-context.js servers/memory/server.js servers/gateway/dashboard/panels/skills.js tests/crow-context-cache.test.js -m "perf: 60s context cache + invalidation; batch memory access-tracking updates (W1-5)"`

### Task 6: Crash-proofing — JSON.parse guards + upload orphan cleanup (W1-6)

**Files:**
- Modify: `servers/gateway/auth.js:25`, `servers/memory/server.js:1406`, `servers/storage/server.js:165-172`, `servers/gateway/routes/storage-http.js:133-145`

(NOTE: `proxy.js:327/:372` and `orchestrator/providers.js:79` were reported by an audit agent but are ALREADY guarded — verified; do not touch.)

- [ ] **Step 1: Guard `auth.js:25`** — replace `return JSON.parse(rows[0].metadata);` with:

```js
    try {
      return JSON.parse(rows[0].metadata);
    } catch {
      console.error("[auth] Corrupt client metadata JSON for registered client; treating as unregistered");
      return undefined;
    }
```

- [ ] **Step 2: Guard `memory/server.js:1406`** — replace `const prefs = JSON.parse(rows[0].value);` with:

```js
        let prefs;
        try {
          prefs = JSON.parse(rows[0].value);
        } catch {
          prefs = {};
        }
```

- [ ] **Step 3: Upload orphan cleanup (MCP tool)** — `servers/storage/server.js` (~165): wrap the DB insert so a failure removes the just-uploaded object (`deleteObject(key, bucket)` is already imported; its signature is `(key, bucket)`):

```js
        await uploadObject(s3Key, buffer, { bucket, contentType: mime_type });

        try {
          // Record in database
          await db.execute({
            sql: `INSERT INTO storage_files (s3_key, original_name, mime_type, size_bytes, bucket, reference_type, reference_id, project_id)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [s3Key, file_name, mime_type || null, buffer.length, bucket || "crow-files", reference_type || null, reference_id || null, project_id ?? null],
          });
        } catch (err) {
          // Don't leave an untracked orphan object behind
          try { await deleteObject(s3Key, bucket || "crow-files"); } catch {}
          throw err;
        }
```

- [ ] **Step 4: Same for the HTTP route** — `servers/gateway/routes/storage-http.js` (~133). **FIRST add `deleteObject` to the import block at lines 17-22** (it currently imports only `isAvailable, uploadObject, getPresignedUrl, isAllowedMimeType, getBucketStats` — `deleteObject` is NOT there; without this the catch below throws ReferenceError). Then: the insert sits in a `try { ... } finally { db.close(); }`. Add a catch that cleans up the object and rethrows, preserving the `finally` (the route's outer catch at ~:160 re-closes db safely and responds 500 — verified):

```js
      await uploadObject(s3Key, buffer, { bucket, contentType: mimetype });

      try {
        await db.execute({
          sql: `INSERT INTO storage_files (s3_key, original_name, mime_type, size_bytes, bucket, reference_type, reference_id, project_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            s3Key, originalname, mimetype, size, bucket,
            referenceType,
            referenceId,
            projectId,
          ],
        });
        if (projectId != null) {
          await appendAudit(db, {
            project_id: projectId, actor_type: "local", action: "file.upload",
            target: `file:${s3Key}`,
            payload: { file_name: originalname, size_bytes: size, mime_type: mimetype },
          });
        }
      } catch (err) {
        try { await deleteObject(s3Key, bucket); } catch {}
        throw err;
      } finally {
        db.close();
      }
```


- [ ] **Step 5: Verify** — `node --test tests/` green; gateway boots clean.
- [ ] **Step 6: Commit** — `git commit servers/gateway/auth.js servers/memory/server.js servers/storage/server.js servers/gateway/routes/storage-http.js -m "reliability: guard JSON.parse on DB blobs; clean up orphaned upload on DB failure (W1-6)"`

### Task 7: Docs quick fixes (W1-7)

**Files:**
- Regenerate: `docs/skills/index.md` (via `npm run sync-skills`)
- Modify: `docs/getting-started/cloud-deploy.md` (top), `docs/developers/index.md:~51-55`, `docs/superpowers/plans/2026-03-20-google-cloud-guide-chaining-docs.md` (1 link), `docs/superpowers/plans/2026-06-10-f7-public-docs-realignment.md:~324` (IP redaction)

- [ ] **Step 1: Sync skills index** — `npm run sync-skills`; verify: `grep -c crow-dream docs/skills/index.md` → 0, and `grep -c "crow-identity\|crow-crosspost" docs/skills/index.md` → ≥2. If the generator still emits `crow-dream`, STOP and report (it would mean a stale source list — do not hand-edit the generated file).
- [ ] **Step 2: Reconcile the cloud-deploy banners** — `docs/getting-started/cloud-deploy.md:3-13` ALREADY has two banners (added in `819d147`) that **contradict each other**: a `::: danger Archived — Legacy Deployment Path` block ("no longer supported") and a `::: tip Recommended: Oracle Cloud Free Tier` block that says Render "is still supported". Do NOT add a third banner. Merge them into ONE coherent block: keep the `::: danger Archived — Legacy Deployment Path` banner, and inside it state that this Render-based path is kept for reference only and point to the [Oracle Cloud Free Tier guide](./oracle-cloud) (and managed hosting) as the supported paths. Delete the contradictory "still supported" phrasing.

- [ ] **Step 3: Conditional language in developers/index.md** — in the Developer Environment section (~lines 51-55), change present-tense claims ("Crow includes a Developer Environment mode", "It also provides a packaging CLI (`npm run package-addon`)") to planned-tense ("A Developer Environment mode is planned: …", "A packaging CLI (`npm run package-addon`) is planned for …"). Keep the feature list, just stop asserting it exists.
- [ ] **Step 4: Fix hardcoded-base link** — in `docs/superpowers/plans/2026-03-20-google-cloud-guide-chaining-docs.md`, change `/software/crow/getting-started/google-cloud` → `/getting-started/google-cloud`.
- [ ] **Step 5: Redact droplet IP** — in `docs/superpowers/plans/2026-06-10-f7-public-docs-realignment.md` (~line 324), the text reads `nginx on droplet \`<droplet-ip>\``. Replace the phrase so it reads `nginx on the maestro.press droplet` (don't produce "droplet the … droplet"). Note: this scrubs the working tree, not git history — acceptable per the findings report.
- [ ] **Step 6: Verify build** — `cd docs && npm run build` → exits 0 (the 24 `env`-language highlight warnings are pre-existing and acceptable).
- [ ] **Step 7: Commit** — `git commit docs/skills/index.md docs/getting-started/cloud-deploy.md docs/developers/index.md docs/superpowers/plans/2026-03-20-google-cloud-guide-chaining-docs.md docs/superpowers/plans/2026-06-10-f7-public-docs-realignment.md -m "docs: sync skills index, legacy-banner cloud-deploy, fix stale claims + redact IP (W1-7)"`

### Task 8: Wave gate — security review, full verification, merge & deploy

- [ ] **Step 1:** `/security-review` on the branch diff (Tasks 1–3 touch auth/boundary surfaces).
- [ ] **Step 2:** Full suite: `node --test tests/` → all green. Boot checks: `timeout 5 node servers/gateway/index.js --no-auth` (clean banner) and `timeout 5 node servers/memory/index.js` (the `memory-server` entry per `package.json:8`).
- [ ] **Step 3:** Merge per `superpowers:finishing-a-development-branch`: `git checkout main && git pull --rebase && git merge --no-ff overhaul/wave-1 -m "Overhaul Wave 1: boundary hardening, path validation, hygiene, token quick-wins, crash-proofing, docs fixes"` then `git push`.
- [ ] **Step 4:** Deploy (batched, single window): `sudo systemctl restart crow-gateway crow-mpa-gateway` then verify BOTH come back: `curl -fsS http://localhost:3001/health` and `curl -fsS http://localhost:3006/health` (`/health` is mounted unauthenticated at `gateway/index.js:464` — verified). Confirm pi-bot units untouched: `systemctl is-active pibot-discord@crow-mpa pibot-gateways@crow-mpa` still `active` (verified: no PartOf/BindsTo coupling to the gateway units).
- [ ] **Step 5: Prune merged remote branches** (deferred from Task 4; post-gate because it's the only irreversible-ish op). First `git fetch --prune`, then for each branch verify merged **at execution time** (`git log --oneline main..origin/<b> | wc -l` → 0) and only then `git push origin --delete <b>`: `f0-caddy-federation-helpers-and-hardware-gate f1-gotosocial-bundle f2-writefreely-bundle f3-matrix-dendrite-bundle f4-funkwhale-bundle f5-pixelfed-bundle f6-lemmy-bundle f7-mastodon-bundle f8-peertube-bundle f11-identity-attestation f12-cross-app-bridging feat/f5-fullmesh-viewer feat/v1-refoundation-f1-f2 feature/context-window-management feature/cross-instance-sso feature/platform-expansion-2026-03-21 grackle-drift pr0-platform-infrastructure pr0.5-caddy-reverse-proxy pr1-simple-bundles pr2-observability pr3-adguard pr4-crowdsec pr5-identity-search-git`. **Do NOT touch** `origin/f13-crosspost-scheduler-gc`, `origin/f14-fediverse-admin-panel`, `origin/f15-image-tag-pins` (1–3 unmerged commits each — operator decision pending) or `gitea/main`. Skip any branch whose merged-check is non-zero and report it.
- [ ] **Step 6:** Post wave summary to the operator.

---

## Review

**Round 1 (2026-06-10, Plan subagent, adversarial vs live tree): REVISE → resolved.** Reviewer verified ~all anchors (funnel.js:40, bot-builder:698, two access-tracking loops only, one crow_context write per mutation handler, all 8 local + 24 listed remote branches at 0 unmerged, pibot units uncoupled from gateway units, /health unauthenticated at index.js:464, live bot defs all lower-kebab → normalizeSkillName regression-free). Three criticals fixed:
- **C1:** `generateCrowContext` has 3 return sites; cache-set was only on one and the test stub (`rows: []`) exercised the uncached fallback → test rewritten with a real section row; cache now set on normal + empty-sections returns, NOT on the error fallback; `generateCondensedContext` (the real per-handshake token win, instructions.js:49) added to scope with the same pattern.
- **C2:** `deleteObject` is NOT imported in storage-http.js (plan had asserted it was) → explicit import step added.
- **C3:** cloud-deploy.md already has two contradictory banners (danger "no longer supported" vs tip "still supported") → step changed from "add banner" to "merge into one coherent archived-banner".
Suggestions adopted: replace the stale inline funnel-middleware copy in tests/auth-network.test.js:81-96 with the real import; router.js anchor corrected to :4; .bak count ~56; ensureColumn unit test added; gateway-process invalidation hooks (panels/skills.js:108,127) added; cross-process staleness documented as TTL-bounded; memory entry corrected to servers/memory/index.js; remote pruning deferred post-gate with at-execution-time merged-checks + `git fetch --prune`; no-op test line removed; IP-redaction wording fixed; no-co-author guardrail added to header. Deliberately deferred: a sync-skills drift CI guard (repo has no CI; revisit in W2-3). Bot-builder silently dropping invalid skill names is accepted (UI only offers on-disk names; API misuse is dropped safely).

**Round 2 (2026-06-10, focused re-review): REVISE → APPROVE.** All three criticals verified genuinely resolved against the live tree; the Task 5 test was traced end-to-end (1 db.execute per uncached call in both functions; SECTION_ROW survives mergeScopedSections; all three tests pass against the prescribed implementation); skills.js anchors + relative import verified. One new defect found and fixed: Task 5 Step 7's commit list omitted `servers/gateway/dashboard/panels/skills.js` (the gateway-process invalidation hook would never have landed) — added. Non-blocking nit accepted: caching `generateCondensedContext`'s empty-sections `null` is a no-op (indistinguishable from a miss) — correct behavior, no perf win in that edge.

## Self-review notes (writing-plans checklist)

- **Spec coverage:** W1-1→Task1, W1-2→Task2, W1-3→Task3, W1-4→Task4, W1-5→Task5, W1-6→Task6, W1-7→Task7, wave gate→Task8. The two refuted JSON.parse sites are explicitly fenced off.
- **Placeholders:** none — every step has literal code/commands.
- **Consistency:** `normalizeSkillName` import direction verified acyclic; `deleteObject(key, bucket)` signature verified; `invalidateContextCache` name used consistently in test + impl.
- **Risk notes for reviewers:** Task 5's cache must not change `generateCrowContext`'s output shape (string), only its freshness; Task 2's lowercasing via `normalizeSkillName` could in theory rename a mixed-case stored skill — repo `skills/` are all lower-kebab (verified pattern), and `loadSkills`-driven UI only offers on-disk names.
