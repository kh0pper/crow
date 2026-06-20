# Phase 1.4 — pi-bots usage capture (design)

**Date:** 2026-06-19
**Project:** FERPA metered-inference (`ferpa-metered-inference-project`)
**Roadmap:** `~/.claude/plans/i-have-ambitions-to-polished-bee.md` — Phase 1.4
**Status:** approved design → writing-plans

## Goal

Every bot inference turn produces a `surface="bot"` row in the pibot instance's
`usage_events` ledger, using the **same** price book + `recordUsageEvent` code
path as the gateway surfaces (chat, `/llm`). This closes the last unmetered
inference surface and satisfies the Phase 1 exit criterion ("every inference
call on every surface produces an accurate, tenant-attributed `usage_event`")
for the bot leg.

This is **capture only**. No quota enforcement, no tenant scoping, no backend
re-routing — those are later phases. The point is a complete, single-cost-basis
ledger that reconciliation (Phase 1.5) can trust.

## Scope (decided)

- **In:** `bridge.mjs:handleInbound` (all interactive channels — Gmail, Discord,
  Telegram, Slack funnel through here) **and** `job_runner.mjs:runJob`
  (scheduled bot cron jobs). Both are real bot work that consumes backend
  tokens.
- **Out (documented seams):**
  - `skill_review.mjs:runSkillReview` — the idle-only self-learning review
    spawns its own `PiRpc`. Real spend, but internal/optimization, off unless
    `skill_learning` is enabled. Noted follow-up; not v1.
  - Pre-spawn **quota gate** — Phase 4 (billing/caps). Nothing to enforce
    against pre-tenant. Document the seam (the point just before `new PiRpc`).
  - Seeding the MPA price book — an ops step (`scripts/seed-price-book.mjs` per
    data dir). Until done, bot events land `priced=0`, which is correct and
    visible in the metering panel's unpriced-coverage warning.

## Background facts (verified against the installed code)

### pi's `get_session_stats` RPC

`@earendil-works/pi-coding-agent` (v0.74.2). The RPC command
`{type:"get_session_stats"}` returns
`{type:"response", command:"get_session_stats", success:true, data: SessionStats}`.

`SessionStats` (from `dist/core/agent-session.js:getSessionStats()`):

```
{
  sessionFile, sessionId,
  userMessages, assistantMessages, toolCalls, toolResults, totalMessages,
  tokens: { input, output, cacheRead, cacheWrite, total },
  cost,            // sum of per-message cost.total — pi's OWN price-table
                   // estimate. DRIFT ALARM ONLY, never a billing input.
  contextUsage
}
```

**Critical:** `tokens` is recomputed each call by **summing `usage` over all
current `state.messages`**. It is cumulative across the whole (possibly resumed)
session. A **mid-turn compaction** (pi summarizing/dropping old messages when
context fills) shrinks that sum — so `after − before` can go negative on a
dimension. This is the roadmap's flagged hazard (`use per-message get_messages
deltas to stay correct across session compaction`). v1 handles it by clamping
to 0 and logging; the full per-message reconciliation is deferred to 1.5.

### The metering recording path

`servers/shared/metering.js`:
- `loadPricingRules(db)` → `db.execute("SELECT * FROM pricing_rules WHERE effective_to IS NULL")`
- `recordUsageEvent(db, event)` → looks up the rule (`selectPriceRule`), computes
  cost (`computeCost`), writes one `usage_events` row. Unmatched model ⇒
  `priced=0`, `computed_cost_usd NULL`, **still written**.
- `selectPriceRule`, `computeCost` are **pure** (client-agnostic).

`db` here is a **libsql** client (`db.execute({sql,args})`). The pi-bots bridge
speaks **better-sqlite3** (`prepare().run()`). Bridging this is the one piece of
integration friction (see "libsql adapter" below).

`usage_events` columns (from `scripts/init-db.js`): `tenant_id, conversation_id,
message_id, surface, provider_id, provider_type, model_id, input_tokens,
output_tokens, cached_tokens, computed_cost_usd, priced, request_id, created_at`.
No `cache_write` column.

### Where bot inference lands

- `bridge.mjs:handleInbound` constructs `PiRpc` (line ~549) for every
  interactive channel. Single funnel.
- `job_runner.mjs:runJob` lazy-imports `bridge.PiRpc` and constructs it directly
  (line ~205) for scheduled jobs.
- `skill_review.mjs:runSkillReview` constructs its own `PiRpc` (line ~212) —
  **out of scope** for v1.

### Deploy surface (verified)

`pibot-gateways.service` sets `CROW_DB_PATH=/home/kh0pp/.crow-mpa/data/crow.db`.
That DB **already has** `usage_events` + `pricing_rules` (both empty) — the
metering schema deployed fleet-wide with `340d989`. Therefore this is a
**code-only deploy**: no `init-db`, no schema migration. Restart
`pibot-gateways@crow-mpa` (and any Discord/Gmail gateway procs) onto current
main. This touches the crow-mpa host (the accepted coordination cost).

## Components

### 1. `scripts/pi-bots/metering.mjs` (new)

**`libsqlAdapter(conn)`** — wraps a better-sqlite3 connection so the
libsql-shaped `recordUsageEvent`/`loadPricingRules` work unchanged:

```
execute(q):
  q is a string OR {sql, args}
  sql = string form; args = q.args || []
  if sql matches /^\s*select/i  -> { rows: stmt.all(...args) }
  else                          -> { rowsAffected: stmt.run(...args).changes }
```

Returning the **single** `recordUsageEvent` path on both gateway (real libsql)
and bridge (adapter) is deliberate — reconciliation (1.5) must trust one
recording code path. Rows from better-sqlite3 `.all()` are plain objects, shape-
compatible with what `loadPricingRules`/`selectPriceRule` consume.

**`meterBotTurn({ conn, statsBefore, statsAfter, resolved, surface = "bot", requestId, log })`**
— async, best-effort:

```
before = statsBefore?.tokens || {input:0,output:0,cacheRead:0,cacheWrite:0}
after  = statsAfter?.tokens  || null
if !after: return            // no stats → record nothing (don't guess)
delta.input     = max(0, after.input     - before.input)
delta.output    = max(0, after.output    - before.output)
delta.cacheRead = max(0, after.cacheRead - before.cacheRead)
if any raw (after - before) < 0: log("compaction detected — usage undercount this turn")
if delta.input==0 && delta.output==0 && delta.cacheRead==0: return  // nothing to record
await recordUsageEvent(libsqlAdapter(conn), {
  surface, providerId: resolved.provider, providerType: null,
  modelId: resolved.model, tenantId: null,
  inputTokens: delta.input, outputTokens: delta.output,
  cachedTokens: delta.cacheRead, requestId,
})
```

`cacheWrite` is intentionally dropped in v1 (no column, `computeCost` doesn't
model it, self-hosted bots are $0). Noted as a reconciliation follow-up.

The helper takes `conn` (injectable) rather than opening its own, so tests pass
an in-memory DB and the call sites control connection lifecycle (matching the
bridge's existing per-helper open/close idiom).

### 2. `PiRpc.getSessionStats()` (in `bridge.mjs`, mirrors `getState()`)

```
async getSessionStats() {
  this.send({ type: "get_session_stats" });
  return this.waitFor(m => m.type==="response" && m.command==="get_session_stats", 15000, "get_session_stats");
}
```

Returns the full response; callers read `.data` (the `SessionStats`).

### 3. Wiring — `bridge.mjs:handleInbound`

Inside the existing `try` around the turn:
- Before `pi.prompt(...)`: `const stats0 = await pi.getSessionStats().catch(()=>null);`
  (alongside the existing `st0 = await pi.getState()`).
- After the turn (after `st1`): `const stats1 = await pi.getSessionStats().catch(()=>null);`
- After `piSessionId` is resolved, best-effort meter:

```
try {
  const mconn = db(CROW_DB);
  try {
    await meterBotTurn({ conn: mconn, statsBefore: stats0?.data, statsAfter: stats1?.data,
      resolved, surface: "bot", requestId: piSessionId, log });
  } finally { mconn.close(); }
} catch (e) { log("[metering] bot usage record failed (non-fatal): " + (e?.message||e)); }
```

Placed so it never affects `sendReply` / the returned `result`. Mirrors
`appendAuditBridge`'s best-effort, own-connection pattern.

### 4. Wiring — `job_runner.mjs:runJob`

Same before/after `getSessionStats` around the job's `pi.prompt` (the site
already has `resolved`, `st0`/`st1`, and a resolved `sessionId` — verified), same
`meterBotTurn` call with `surface="bot"`, `requestId=sessionId`, opening a
short-lived connection via the module's existing `dbConn()` helper. Guarded
identically (best-effort, never fails the job).

## Data flow

```
inbound turn / scheduled job
  → resolveModel() → resolved {provider, model, ...}
  → stats0 = pi.getSessionStats()        (cumulative-before)
  → pi.prompt(...)  → agent_end
  → stats1 = pi.getSessionStats()        (cumulative-after)
  → meterBotTurn(): delta = clamp(after - before)
       → recordUsageEvent(libsqlAdapter(conn), {surface:"bot", provider, model, tokens})
            → selectPriceRule + computeCost (priced=0 if MPA price book unseeded)
            → INSERT usage_events
  → (panel /dashboard/metering on the MPA gateway shows surface=bot spend)
```

## Error handling

- All capture is wrapped in try/catch and `.catch(()=>null)` on the RPC reads;
  a metering failure logs and is swallowed. **A turn never fails because of
  metering** (same invariant as chat.js / llm-router.js).
- Missing/!success stats ⇒ record nothing (never fabricate counts).
- Negative delta (compaction) ⇒ clamp to 0 + warn. Undercount is acceptable and
  visible; reconciliation (1.5) measures the residual drift.
- Unpriced model ⇒ row still written `priced=0` (coverage gap surfaced, never
  dropped).

## Testing (TDD — red first)

`tests/pibot-metering.test.js` (node built-in runner, in-memory better-sqlite3):

1. **adapter** — SELECT returns `{rows:[...]}`; INSERT returns `{rowsAffected}`;
   round-trips a `pricing_rules` seed and a `usage_events` insert.
2. **normal delta** — before `{input:100,output:10,cacheRead:0}`, after
   `{input:160,output:35,cacheRead:5}` ⇒ one `surface=bot` row, `input_tokens=60,
   output_tokens=25, cached_tokens=5`, `priced=1`, cost via the seeded rule.
3. **compaction** — after < before on input ⇒ clamped to 0, warning logged,
   row reflects clamped values.
4. **unpriced model** — model with no matching rule ⇒ row written `priced=0`,
   `computed_cost_usd NULL`.
5. **no-op** — null/empty after-stats ⇒ no row written.
6. **getSessionStats parse** — feed a fake NDJSON `response/get_session_stats`
   frame through the PiRpc stdout buffer; assert `.data.tokens` parsed.

Plus, post-deploy: a **live one-turn smoke** on the MPA instance (one real bot
turn → assert a `surface=bot` `usage_events` row), then delete the synthetic row
if it was a test bot.

Regression: run the existing metering suite (`tests/metering*.test.js`,
`tests/llm-tap.test.js`, `tests/init-db-metering-tables.test.js`) — unchanged,
must stay green (we add a new recording caller, we don't touch the shared path).

## Deploy

1. Commit on `feat/metering-core` with explicit path args; `git pull --rebase`;
   push.
2. **Code-only** — no init-db. Restart `pibot-gateways@crow-mpa` and any
   Discord/Gmail gateway procs onto current main (sudo pw in private notes;
   PROD — deploy carefully).
3. Live smoke (above). Confirm the MPA `/dashboard/metering` panel shows the
   `surface=bot` event.
4. (Optional, separate) seed the MPA price book to make bot events `priced`.

## Follow-ups (out of v1, recorded)

- `skill_review` self-learning calls (real spend; surface e.g. `bot:internal`).
- `cacheWrite` token modeling (needs a schema/`computeCost` extension).
- Per-message `get_messages` delta for compaction-exact counts (folds into 1.5).
- `provider_type` + `tenant_id` attribution (Phase 1.0/2/3, shared with chat.js).
- Pre-spawn quota gate (Phase 4).
