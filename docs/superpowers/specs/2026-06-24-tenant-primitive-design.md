# Design: Phase 1.0 Minimal Tenant Primitive

**Date:** 2026-06-24
**Project:** FERPA metered-inference (paid metered AI inference for K-12 districts)
**Roadmap:** `/home/kh0pp/.claude/plans/i-have-ambitions-to-polished-bee.md` — Phase 1.0
**Status:** design approved; ready for `writing-plans`.

## Goal

The usage ledger (`usage_events`) must key on a real `tenant_id` from day one, so every
metered inference event is attributable to a tenant when Phase 3 isolation lands. Today
every surface writes `tenant_id = NULL`; every row accumulated until this ships is
permanently un-attributable.

This is **identity only**. It does NOT add query-scoping, tenant isolation, or access
control — that is the Phase 3 re-architecture. The roadmap invariant holds throughout:
**exactly one live tenant; do not onboard a second before Phase 3 exit** (pre-isolation,
the `contactId=null` ACL bypass makes `tenant_id` decorative for access control).

## Context (current state, verified 2026-06-24)

- `recordUsageEvent(db, event)` in `servers/shared/metering.js` **already accepts and
  writes `tenantId`** (defaults to `null`). The plumbing exists; the gap is that no caller
  resolves a real id.
- `usage_events.tenant_id` is already a **nullable `TEXT`** column with index
  `idx_usage_events_tenant(tenant_id, created_at)` (`scripts/init-db.js`). No schema change
  to this table is required.
- There are exactly **three write surfaces**, all passing `null` today:
  - `servers/gateway/routes/chat.js:782` — dashboard chat, `tenantId: null`.
  - `servers/gateway/routes/llm-router.js:263` — companion/glasses `/llm` proxy; omits the
    field (defaults to `null`).
  - `scripts/pi-bots/metering.mjs:67` — `meterBotTurn`, `tenantId: null`; this single
    module is the bot leg for BOTH `bridge.mjs` (interactive) and `job_runner.mjs`
    (scheduled).

## Design decisions (from brainstorm Q&A)

1. **Resolver = constant + env override.** `resolveTenantId()` returns
   `process.env.CROW_TENANT_ID || 'default'`. A well-known constant means no DB read and no
   new failure surface on the best-effort (try/catch) meter hot path. The env override lets
   a future manual-pilot instance tag its ledger distinctly **without a code change** while
   still being one tenant per instance (invariant holds).
2. **Backfill NULL → 'default'.** Existing `usage_events` rows with `tenant_id IS NULL`
   predate tenant tagging and were the operator's; an idempotent migration attributes them
   to `'default'` so the ledger is uniformly queryable by tenant.
3. **Soft link (no FK).** The `tenants` table is a registry; `usage_events.tenant_id` stays
   plain nullable `TEXT`, linked by convention. Avoids a SQLite table rebuild (can't
   `ALTER TABLE ADD CONSTRAINT`), matches the existing design, and keeps the meter path
   unable to throw on an unknown tenant. Phase 3 hardens the link during the real isolation
   re-architecture.
4. **Minimal registry shape.** `tenants(id TEXT PRIMARY KEY, name TEXT, status TEXT NOT
   NULL DEFAULT 'active', created_at)`. `status` is included (one column, obviously needed
   to suspend a tenant soon); richer fields (kind, contract pointers) are deferred.

## Components

### New: `servers/shared/tenancy.js`

The single home for tenancy primitives:

- `export const DEFAULT_TENANT_ID = 'default';`
- `export function resolveTenantId(ctx = {})` → `process.env.CROW_TENANT_ID || DEFAULT_TENANT_ID`.
  Pure, no DB read, cannot fail. The `ctx` param is **ignored now** and exists purely as the
  Phase-3 seam: Phase 3 replaces the body to resolve a real tenant from `ctx` (request,
  auth, device) without changing any call site.
- `export async function ensureTenant(db, { id, name })` → idempotent registry upsert
  (`INSERT OR IGNORE INTO tenants(id, name) VALUES(?, ?)`). Used by init-db. `db` is a libsql
  client (`{ execute }`), matching the rest of `servers/shared/`.

### Changed: `scripts/init-db.js`

Add (all idempotent — safe to re-run on every instance):

```sql
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now'))
);
```

- Seed `default`: `ensureTenant(db, { id: 'default', name: 'Default (operator)' })`.
- If `process.env.CROW_TENANT_ID` is set and ≠ `'default'`, also `ensureTenant` a row for it
  (so the resolver's id always has a registry home), name defaulting to the id (operator can
  rename later).
- Backfill: `UPDATE usage_events SET tenant_id = 'default' WHERE tenant_id IS NULL;`
- `usage_events` DDL is **unchanged**.

### Changed: three call sites

Replace the `tenantId` argument with `resolveTenantId()`:

- `servers/gateway/routes/chat.js:782` — `tenantId: null` → `tenantId: resolveTenantId()`.
- `servers/gateway/routes/llm-router.js:263` — add `tenantId: resolveTenantId()`.
- `scripts/pi-bots/metering.mjs:67` — `tenantId: null` → `tenantId: resolveTenantId()`
  (import `resolveTenantId` from `servers/shared/tenancy.js`, same path style as the existing
  `recordUsageEvent` import).

## Data flow

Each surface, at the moment it records a usage_event, calls `resolveTenantId()` and passes
the id into `recordUsageEvent`. No request-context plumbing is added, because v1 resolution
is context-free (env-or-constant). The hot path stays cheap and unfailable: no DB read, no
new throw surface on the best-effort meter.

## Error handling

`resolveTenantId()` cannot throw (pure env/constant read). The three call sites are already
wrapped in best-effort try/catch; behavior there is unchanged. `ensureTenant` and the
backfill run inside init-db, which already logs and continues on table-init errors.

## Testing (TDD, red first)

- **`tests/tenancy.test.js` (new):**
  - `resolveTenantId()` → `'default'` when `CROW_TENANT_ID` is unset.
  - `resolveTenantId()` → the env value when `CROW_TENANT_ID` is set.
  - `resolveTenantId({ anything })` ignores `ctx` (still returns the resolved id).
  - `ensureTenant` inserts a row; a second call with the same id is a no-op (idempotent).
- **init-db metering test (extend existing `tests/init-db-metering-tables.test.js`):**
  - After init, `tenants` contains a `default` row.
  - A pre-inserted `usage_events` row with `tenant_id IS NULL` is backfilled to `'default'`.
  - Running init twice is clean (no duplicate/no error).
- **`tests/pibot-metering.test.js` (extend):** `meterBotTurn` writes `tenant_id = 'default'`
  (not NULL).
- **chat.js / llm-router.js:** covered by the resolver unit test (same constant value is
  threaded); the implementation plan pins the exact per-site assertion (a focused record
  assertion if cheap, otherwise verified by the wired resolver).

Verification: `node --test` on the affected test files all green; gateway boots clean
(`node servers/gateway/index.js --no-auth`).

## Explicitly OUT of scope (Phase 3+, do not build now)

- Per-request tenant identification from auth (auth stays single-operator).
- Query-scoping / tenant isolation / cross-tenant access control.
- A second live tenant.
- Hard FK from `usage_events` to `tenants`.
- Tenant CRUD UI or API (registry is seeded via init-db; the operator can `INSERT` manually
  if a non-default tenant is needed before Phase 3).
- `tenant_id` on any other table (conversations, providers, etc.).

## Deploy

Code + idempotent migration. init-db runs per data dir on all four instances (resolves to
`'default'` everywhere, since none set `CROW_TENANT_ID`). The gateway/bot restarts required
are the same set the editor-UI deploy needs (`crow-gateway`, the `crow-mpa` gateway, and
`pibot-gateways@crow-mpa` / `pibot-discord@crow-mpa`), so the two deploys can be folded
together to avoid a second WS drop on MPA.
