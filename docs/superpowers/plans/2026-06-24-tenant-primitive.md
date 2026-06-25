# Phase 1.0 Minimal Tenant Primitive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the usage ledger key on a real `tenant_id` from day one (env-or-`'default'`), so every metered inference event is tenant-attributable when Phase 3 isolation lands — replacing today's `tenant_id = NULL` on all three write surfaces.

**Architecture:** A new `servers/shared/tenancy.js` provides `resolveTenantId()` (pure: `process.env.CROW_TENANT_ID || 'default'`, no DB read, cannot throw) + `ensureTenant()` (idempotent registry upsert). `scripts/init-db.js` adds a minimal `tenants` registry table, seeds `default` (+ the env tenant if set), and backfills legacy `NULL` rows to `'default'`. The three `recordUsageEvent` call sites pass `resolveTenantId()` instead of `null`.

**Tech Stack:** Node.js ESM, libsql client (`db.execute({sql,args})`), node built-in test runner, `@libsql/client` (`:memory:`) + better-sqlite3 (init-db test) for tests.

**Spec:** `docs/superpowers/specs/2026-06-24-tenant-primitive-design.md`

## Global Constraints

- **Identity only.** This adds NO query-scoping, tenant isolation, or access control (that is Phase 3). Roadmap invariant: **exactly one live tenant; do not onboard a second before Phase 3 exit.**
- **TDD, red first.**
- **Hot path stays cheap + unfailable:** `resolveTenantId()` does NO DB read and cannot throw. The three call sites are already best-effort try/catch — unchanged.
- **Soft link, no FK.** `usage_events.tenant_id` stays plain nullable `TEXT`; `tenants` is a registry linked by convention. No `usage_events` schema change. (SQLite can't `ALTER TABLE ADD CONSTRAINT`, and the meter must not throw on an unknown tenant.)
- **`resolveTenantId(ctx = {})` ignores `ctx`** today — it exists ONLY as the Phase-3 seam (Phase 3 replaces the body to resolve from request/auth/device without touching any call site). Keep the param; it is intentional, not dead code.
- **Backfill target is always `'default''`** (legacy NULL rows predate tagging and were the operator's), even on an env-tenant instance.
- **All init-db additions idempotent** (safe to re-run on every instance).
- **Commits:** explicit path args (`git commit <paths> -m`); `git pull --rebase` before push; **no Claude co-author**. NOTE: the working tree has 2 unrelated uncommitted files (`scripts/pi-bots/gateways/nostr-client.mjs`, `servers/sharing/nostr.js`) from another session — NEVER stage or commit them; always use explicit per-file paths.
- **Branch:** work on the existing `feat/tenant-primitive` branch (the spec is already committed there at `1eae03c`).

---

### Task 1: `servers/shared/tenancy.js` — resolver + registry upsert

**Files:**
- Create: `servers/shared/tenancy.js`
- Test: `tests/tenancy.test.js`

**Interfaces:**
- Produces:
  - `export const DEFAULT_TENANT_ID = "default";`
  - `resolveTenantId(ctx = {}) -> string` — `process.env.CROW_TENANT_ID || DEFAULT_TENANT_ID`. Pure, ignores `ctx`, never throws.
  - `ensureTenant(db, { id, name = null }) -> Promise<void>` — `INSERT OR IGNORE INTO tenants (id, name) VALUES (?, ?)`. `db` is a libsql client.

- [ ] **Step 1: Write the failing tests**

Create `tests/tenancy.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { DEFAULT_TENANT_ID, resolveTenantId, ensureTenant } from "../servers/shared/tenancy.js";

test("resolveTenantId returns 'default' when CROW_TENANT_ID is unset", () => {
  const prev = process.env.CROW_TENANT_ID;
  delete process.env.CROW_TENANT_ID;
  try {
    assert.equal(resolveTenantId(), "default");
    assert.equal(resolveTenantId(), DEFAULT_TENANT_ID);
  } finally {
    if (prev !== undefined) process.env.CROW_TENANT_ID = prev;
  }
});

test("resolveTenantId returns the env value when CROW_TENANT_ID is set", () => {
  const prev = process.env.CROW_TENANT_ID;
  process.env.CROW_TENANT_ID = "district-acme";
  try {
    assert.equal(resolveTenantId(), "district-acme");
  } finally {
    if (prev === undefined) delete process.env.CROW_TENANT_ID;
    else process.env.CROW_TENANT_ID = prev;
  }
});

test("resolveTenantId ignores ctx (Phase-3 seam, no-op today)", () => {
  const prev = process.env.CROW_TENANT_ID;
  delete process.env.CROW_TENANT_ID;
  try {
    assert.equal(resolveTenantId({ req: {}, auth: { user: "x" }, device: "y" }), "default");
  } finally {
    if (prev !== undefined) process.env.CROW_TENANT_ID = prev;
  }
});

test("ensureTenant inserts once and is idempotent", async () => {
  const db = createClient({ url: ":memory:" });
  await db.execute(`CREATE TABLE tenants (id TEXT PRIMARY KEY, name TEXT, status TEXT NOT NULL DEFAULT 'active', created_at TEXT DEFAULT (datetime('now')))`);
  await ensureTenant(db, { id: "default", name: "Default (operator)" });
  await ensureTenant(db, { id: "default", name: "Different name" }); // no-op (INSERT OR IGNORE)
  const { rows } = await db.execute("SELECT id, name, status FROM tenants");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "default");
  assert.equal(rows[0].name, "Default (operator)"); // first write wins
  assert.equal(rows[0].status, "active");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/tenancy.test.js`
Expected: FAIL — `Cannot find module '.../servers/shared/tenancy.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `servers/shared/tenancy.js`:

```js
/**
 * Tenancy primitives (Phase 1.0 — identity only).
 *
 * The usage ledger keys on a real tenant_id from day one so every metered event
 * is attributable when Phase 3 isolation lands. v1 resolution is context-free:
 * one tenant per instance, `process.env.CROW_TENANT_ID` or the 'default'
 * constant. NO DB read, cannot throw — safe on the best-effort meter hot path.
 *
 * `resolveTenantId(ctx)` IGNORES `ctx` today; it exists as the Phase-3 seam
 * (Phase 3 replaces the body to resolve a real tenant from request/auth/device
 * WITHOUT changing any call site). Do NOT add query-scoping or a second live
 * tenant before Phase 3 — pre-isolation the contactId=null ACL bypass makes
 * tenant_id decorative for access control.
 */

export const DEFAULT_TENANT_ID = "default";

/** Resolve the tenant id for a metered event. Pure: env-or-constant, never throws. */
export function resolveTenantId(ctx = {}) {
  return process.env.CROW_TENANT_ID || DEFAULT_TENANT_ID;
}

/** Idempotent registry upsert. db is a libsql-style client ({ execute }). */
export async function ensureTenant(db, { id, name = null }) {
  await db.execute({
    sql: `INSERT OR IGNORE INTO tenants (id, name) VALUES (?, ?)`,
    args: [id, name],
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/tenancy.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git commit servers/shared/tenancy.js tests/tenancy.test.js -m "feat(metering): tenancy.js — resolveTenantId (env-or-default) + ensureTenant"
git show --stat HEAD | head -5
```

---

### Task 2: `init-db.js` — `tenants` registry + seed + NULL backfill

**Files:**
- Modify: `scripts/init-db.js` (import near top ~line 1; new block after the `usage_events` `initTable(...)` call, currently ending ~line 1474)
- Test: `tests/init-db-metering-tables.test.js`

**Interfaces:**
- Consumes: `ensureTenant`, `DEFAULT_TENANT_ID` (Task 1). `db` is the module-level libsql client already created at `init-db.js:14` (`const db = createDbClient();`).

- [ ] **Step 1: Write the failing tests**

In `tests/init-db-metering-tables.test.js`, append (the file already imports `test`, `assert`, `execFileSync`, `mkdtempSync`, `rmSync`, `tmpdir`, `join`, and `Database`, and runs init-db once against `dir` with the read-only `db` handle):

```js
test("tenants table has a seeded default row", () => {
  const rows = db.prepare("SELECT id, status FROM tenants WHERE id='default'").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "active");
});

test("init-db backfills NULL usage_events.tenant_id to 'default' and is idempotent", () => {
  const d2 = mkdtempSync(join(tmpdir(), "metering-backfill-"));
  try {
    // 1st init: creates tables + seeds the default tenant.
    execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: d2 }, stdio: "pipe" });
    // Insert a legacy NULL-tenant usage_events row.
    const w = new Database(join(d2, "crow.db"));
    w.prepare("INSERT INTO usage_events (tenant_id, surface, input_tokens, output_tokens) VALUES (NULL, 'chat', 1, 1)").run();
    w.close();
    // 2nd init: the backfill runs and must be clean (idempotent re-run).
    execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: d2 }, stdio: "pipe" });
    const r = new Database(join(d2, "crow.db"), { readonly: true });
    const nullCount = r.prepare("SELECT COUNT(*) AS n FROM usage_events WHERE tenant_id IS NULL").get().n;
    const defCount = r.prepare("SELECT COUNT(*) AS n FROM usage_events WHERE tenant_id='default'").get().n;
    r.close();
    assert.equal(nullCount, 0, "no NULL tenant_id rows remain after backfill");
    assert.ok(defCount >= 1, "the legacy row was backfilled to default");
  } finally {
    rmSync(d2, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/init-db-metering-tables.test.js`
Expected: FAIL — `tenants` table does not exist (the "seeded default row" test throws `no such table: tenants`, and the backfill test leaves NULL rows).

- [ ] **Step 3: Add the import**

In `scripts/init-db.js`, immediately after the existing first import line `import { createDbClient, resolveDataDir } from "../servers/db.js";` (line 1), add:

```js
import { ensureTenant, DEFAULT_TENANT_ID } from "../servers/shared/tenancy.js";
```

- [ ] **Step 4: Add the tenants table + seed + backfill**

In `scripts/init-db.js`, immediately AFTER the `usage_events` `await initTable("usage_events table", ` ... `);` call (the block that ends with the three `idx_usage_events_*` indexes, ~line 1474) and BEFORE the next comment (`// Migration: add attachments column to chat_messages if missing`), insert:

```js
// tenants: minimal registry (Phase 1.0 — identity only). usage_events.tenant_id
// is a SOFT link by convention (no FK: SQLite can't ALTER ADD CONSTRAINT and the
// meter path must not throw on an unknown tenant). Phase 3 hardens this during
// the real isolation re-architecture.
await initTable("tenants table", `
  CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY,
    name TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Seed the default tenant; also register the env tenant if one is set and
// distinct (so resolveTenantId()'s id always has a registry home). Then backfill
// legacy NULL usage_events rows to 'default' (they predate tagging; operator's).
try {
  await ensureTenant(db, { id: DEFAULT_TENANT_ID, name: "Default (operator)" });
  const envTenant = process.env.CROW_TENANT_ID;
  if (envTenant && envTenant !== DEFAULT_TENANT_ID) {
    await ensureTenant(db, { id: envTenant, name: envTenant });
  }
  await db.execute({
    sql: `UPDATE usage_events SET tenant_id = ? WHERE tenant_id IS NULL`,
    args: [DEFAULT_TENANT_ID],
  });
} catch (e) {
  console.error("[init-db] tenant seed/backfill skipped:", e.message);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/init-db-metering-tables.test.js`
Expected: PASS (the 2 existing column tests + the 2 new tenant tests).

- [ ] **Step 6: Commit**

```bash
git commit scripts/init-db.js tests/init-db-metering-tables.test.js -m "feat(metering): init-db tenants registry + default seed + NULL->default backfill"
git show --stat HEAD | head -5
```

---

### Task 3: Wire `resolveTenantId()` into the three write surfaces

**Files:**
- Modify: `servers/gateway/routes/chat.js` (import near the existing metering import ~line 30; site at `:782`)
- Modify: `servers/gateway/routes/llm-router.js` (import ~line 38; site at `:263`)
- Modify: `scripts/pi-bots/metering.mjs` (import near the existing `recordUsageEvent` import; site at `:67`)
- Test: `tests/pibot-metering.test.js`

**Interfaces:**
- Consumes: `resolveTenantId` (Task 1).

> **Note on verification:** `meterBotTurn` (pi-bots) is unit-tested with a real DB assertion below. `chat.js`/`llm-router.js` are gateway routes (req/res/streaming) that aren't unit-tested here; per the spec they're verified by the resolver unit test (Task 1) + a grep that the `null` literal is gone and `resolveTenantId` is imported & called + a module-load check. The exact behavior (the same constant threaded) is covered by Task 1.

- [ ] **Step 1: Update the pi-bots test (red)**

In `tests/pibot-metering.test.js`, the existing "meterBotTurn writes a priced surface=bot row" test currently asserts `assert.equal(rows[0].tenant_id, null);`. Change that line to assert the resolved id (robust to a set `CROW_TENANT_ID` in the runner env). Add this import alongside the existing `meterBotTurn` import:

```js
import { resolveTenantId } from "../servers/shared/tenancy.js";
```

and replace the `tenant_id` assertion in that test with:

```js
  assert.equal(rows[0].tenant_id, resolveTenantId()); // was null; now the resolved tenant
```

Also append a focused test:

```js
test("meterBotTurn tags usage with the default tenant when CROW_TENANT_ID is unset", async () => {
  const prev = process.env.CROW_TENANT_ID;
  delete process.env.CROW_TENANT_ID;
  try {
    const conn = freshDb();
    await meterBotTurn({
      conn,
      statsBefore: { tokens: { input: 0, output: 0, cacheRead: 0 } },
      statsAfter: { tokens: { input: 5, output: 5, cacheRead: 0 } },
      resolved: { provider: "x", model: "y" },
      requestId: "s",
    });
    const { rows } = await libsqlAdapter(conn).execute("SELECT tenant_id FROM usage_events");
    assert.equal(rows[0].tenant_id, "default");
  } finally {
    if (prev !== undefined) process.env.CROW_TENANT_ID = prev;
  }
});
```

(The file already imports `meterBotTurn`, `libsqlAdapter`, and defines/imports `freshDb`.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/pibot-metering.test.js`
Expected: FAIL — `meterBotTurn` still writes `null`, so both the updated assertion and the new test fail (`null !== 'default'`).

- [ ] **Step 3: Wire the pi-bots site**

In `scripts/pi-bots/metering.mjs`, add the import next to the existing `recordUsageEvent` import (the existing line is `import { recordUsageEvent } from "../../servers/shared/metering.js";`):

```js
import { resolveTenantId } from "../../servers/shared/tenancy.js";
```

and change the `meterBotTurn` `recordUsageEvent` call (`scripts/pi-bots/metering.mjs:67`) from `tenantId: null,` to:

```js
    tenantId: resolveTenantId(),
```

- [ ] **Step 4: Run the pi-bots test to verify it passes**

Run: `node --test tests/pibot-metering.test.js`
Expected: PASS (all existing tests + the new one).

- [ ] **Step 5: Wire the two gateway sites**

In `servers/gateway/routes/chat.js`, add after the existing `import { recordUsageEvent } from "../../shared/metering.js";` (line 30):

```js
import { resolveTenantId } from "../../shared/tenancy.js";
```

and change `chat.js:782` from `tenantId: null,` to:

```js
              tenantId: resolveTenantId(),
```

In `servers/gateway/routes/llm-router.js`, add after the existing metering import (line 38, `import { extractUsageFromOpenAIResponse, recordUsageEvent } from "../../shared/metering.js";`):

```js
import { resolveTenantId } from "../../shared/tenancy.js";
```

and in the `recordUsageEvent(db(), { ... })` call at `llm-router.js:263`, add a `tenantId` field as the first property inside the object (it currently omits it, defaulting to null):

```js
            tenantId: resolveTenantId(),
```

- [ ] **Step 6: Verify the gateway sites (grep + module load)**

```bash
# No `tenantId: null` remains on the wired surfaces, and resolveTenantId is imported + called:
grep -n "tenantId: null" servers/gateway/routes/chat.js servers/gateway/routes/llm-router.js scripts/pi-bots/metering.mjs && echo "FAIL: a null tenant remains" || echo "OK: no null tenants"
grep -c "resolveTenantId" servers/gateway/routes/chat.js servers/gateway/routes/llm-router.js scripts/pi-bots/metering.mjs   # each >= 2 (import + call)
node -e "import('./servers/gateway/routes/chat.js').then(()=>console.log('chat loads')).catch(e=>{console.error(e);process.exit(1)})"
node -e "import('./servers/gateway/routes/llm-router.js').then(()=>console.log('llm-router loads')).catch(e=>{console.error(e);process.exit(1)})"
node --test tests/pibot-metering.test.js tests/tenancy.test.js
```
Expected: `OK: no null tenants`; each file count `2`; `chat loads`; `llm-router loads`; all tests PASS.

- [ ] **Step 7: Commit**

```bash
git commit servers/gateway/routes/chat.js servers/gateway/routes/llm-router.js scripts/pi-bots/metering.mjs tests/pibot-metering.test.js -m "feat(metering): tag all 3 usage surfaces with resolveTenantId() (was NULL)"
git show --stat HEAD | head -6
```

---

### Task 4: Deploy + idempotent migration (operator-gated)

**Files:** none (deploy + ops only).

> **Context:** PROD. Code + an idempotent init-db migration (tenants table + seed + backfill). init-db runs per data dir on all 4 instances (every instance resolves to `'default'` — none set `CROW_TENANT_ID`). The spec notes this restart set is the SAME one the deferred editor-UI deploy needs, so fold them: restarting the crow-mpa gateway here also lands the editor UI there. Sudo pw in private notes.

- [ ] **Step 1: Pre-flight — rebase, full affected-test run, push the branch / merge to main**

```bash
cd /home/kh0pp/crow
git pull --rebase
node --test tests/tenancy.test.js tests/init-db-metering-tables.test.js tests/pibot-metering.test.js tests/metering.test.js tests/metering-record.test.js tests/metering-panel.test.js tests/price-book.test.js
```
Expected: all green. Then finish the branch per `superpowers:finishing-a-development-branch` (FF-merge `feat/tenant-primitive` → main, push). Verify `git show --stat` on the merge contains ONLY the tenant-primitive files (NOT the unrelated nostr WIP).

- [ ] **Step 2: Run the idempotent migration on each instance**

```bash
# crow main
CROW_DATA_DIR=/home/kh0pp/.crow/data node scripts/init-db.js >/dev/null 2>&1
sqlite3 /home/kh0pp/.crow/data/crow.db "SELECT id,status FROM tenants; SELECT COUNT(*) AS null_tenants FROM usage_events WHERE tenant_id IS NULL;"
# crow-mpa (bots run here — backfills real bot usage_events to 'default')
CROW_DATA_DIR=/home/kh0pp/.crow-mpa/data node scripts/init-db.js >/dev/null 2>&1
sqlite3 /home/kh0pp/.crow-mpa/data/crow.db "SELECT id FROM tenants; SELECT COUNT(*) AS null_tenants FROM usage_events WHERE tenant_id IS NULL;"
# grackle + black-swan (pull main first)
grackle "cd ~/crow && git pull --rebase && CROW_DATA_DIR=/home/kh0pp/.crow/data node scripts/init-db.js >/dev/null 2>&1 && sqlite3 ~/.crow/data/crow.db 'SELECT id FROM tenants;'"
ssh black-swan "cd ~/crow && git pull --rebase && CROW_DATA_DIR=/home/ubuntu/.crow/data node scripts/init-db.js >/dev/null 2>&1 && sqlite3 ~/.crow/data/crow.db 'SELECT id FROM tenants;'"
```
Expected on each: a `default` (active) tenant row and `null_tenants = 0`.

- [ ] **Step 3: Restart the gateways/bots onto the new code (folds in the editor-UI deploy)**

```bash
# confirm unit names first: systemctl list-units 'crow*gateway*' 'pibot*'
echo '<pw>' | sudo -S systemctl restart crow-gateway crow-mpa-gateway pibot-gateways@crow-mpa pibot-discord@crow-mpa
# verify each: active/running, NRestarts=0, /health 200
```
(grackle/black-swan gateways: restart if you want the editor UI + new resolver loaded there; their migration already ran.)

- [ ] **Step 4: Live smoke — a real metered event tags the tenant**

Drive one bot turn on crow-mpa (the `--inject` one-turn smoke from the 1.4 deploy), then confirm the new `usage_events` row carries `tenant_id='default'`:

```bash
DB=/home/kh0pp/.crow-mpa/data/crow.db
sqlite3 "$DB" "SELECT COALESCE(MAX(id),0) FROM usage_events;"   # baseline
# ... trigger ONE bot turn (see the 1.4 deploy smoke command) ...
sqlite3 -header -column "$DB" "SELECT id, surface, tenant_id, provider_id, input_tokens FROM usage_events ORDER BY id DESC LIMIT 3;"
```
Expected: the new row has `tenant_id='default'` (not NULL). Delete the synthetic smoke row + bot_session afterward.

- [ ] **Step 5: Update the project memory**

Update `~/.claude/projects/-home-kh0pp-crow/memory/ferpa-metered-inference-project.md` (+ the handoff): Phase 1.0 tenant primitive SHIPPED + DEPLOYED + which instances migrated; the ledger now keys on `tenant_id='default'` fleet-wide; the `CROW_TENANT_ID` env override is the per-instance tag knob; invariant reminder (no 2nd live tenant before Phase 3). Note the editor UI is now also live on whichever gateways were restarted.

---

## Self-Review

**Spec coverage:**
- `tenancy.js` (DEFAULT_TENANT_ID, resolveTenantId env-or-constant + ctx-ignored, ensureTenant idempotent) → Task 1 ✓
- init-db tenants table + seed default + env tenant + NULL→default backfill, usage_events DDL unchanged → Task 2 ✓
- Three call sites (chat.js:782, llm-router.js:263, pibot metering.mjs:67) → Task 3 ✓
- Tests: tenancy.test.js, init-db backfill+default-row, pibot tenant assertion → Tasks 1–3 ✓
- Soft link / no FK / no usage_events schema change → Task 2 (only adds a table + UPDATE) ✓
- Hot path no-DB-read/unfailable → Task 1 resolver is pure ✓
- Deploy: idempotent migration per data dir on 4 instances + folded restarts → Task 4 ✓
- Out-of-scope (per-request auth resolution, query-scoping, 2nd tenant, hard FK, tenant CRUD UI, tenant_id on other tables) → not built ✓

**Placeholder scan:** none — every code step has complete code; every run step has a command + expected output. (`<pw>` and unit-name confirmation in Task 4 Step 3 are operator-environment values intentionally not hardcoded.)

**Type consistency:** `resolveTenantId(ctx = {}) -> string`, `DEFAULT_TENANT_ID = "default"`, `ensureTenant(db, {id, name}) -> Promise<void>` used identically across Tasks 1–3. The pi-bots test asserts against `resolveTenantId()` (imported) so it tracks the resolver regardless of env.
