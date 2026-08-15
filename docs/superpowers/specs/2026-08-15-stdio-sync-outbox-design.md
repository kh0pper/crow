# Stdio-mounted servers must not lose sync emissions — the durable outbox

Companion spec to the Track 1 card-model spec (same arc, own implementation PR, sequenced beside
it). The defect family was named in the Track 0 spec's out-of-scope list and proven at MPA
retirement: **329 of MPA's 343 memories were unreplicable from birth** because they were written
through a stdio-mounted `servers/memory/server.js`, whose every emit site is guarded
`if (syncManager)` — and `syncManager` is null on every stdio mount. The fix must cover **any**
stdio-mounted server, present or future, not just memory.

Verified 2026-08-15 against `origin/main` `411692ac`. This revision incorporates the adversarial
review round (record at the end); the reviewer's two critical findings changed the mechanism —
write-time lamport minting and strict-append draining are not optional refinements, they are what
makes the design correct.

## The defect, precisely

- `InstanceSyncManager.emitChange()` (`servers/sharing/instance-sync.js:1536`) mints a lamport,
  signs the entry with the instance ed25519 key, stamps the row's `lamport_ts`, and appends to
  per-peer **Hypercore out-feeds**. Feeds and identity are gateway-process state; **the lamport
  counter is NOT** — `_nextLamport` is one atomic `UPDATE sync_state … RETURNING` against
  crow.db (`instance-sync.js:406–431`), safe from any process (this fact is load-bearing below).
- Emit call sites outside the manager: `servers/memory/server.js` ×6, dashboard settings
  registry, `providers-db.js`, the skills panel, and the sharing-side `sink()` family. The
  memory/projects/sharing/blog servers also run as **stdio mounts** (repo `.mcp.json`;
  `~/r4-tehcy/.mcp.json` `crow-memory` runs `servers/memory/index.js` against the r4 data dir —
  with `CROW_JOURNAL_MODE=DELETE`, note below). On a stdio mount the write lands in crow.db and
  the emission silently never happens — no lamport, no feed entry, no replication, permanently.
- Hypercores are single-writer append-only logs; a second process must never open the gateway's
  out-feeds. Direct feed writing from stdio processes stays structurally off the table (and the
  sharing network stack must not boot per-mount) — but lamport minting, per the counter fact
  above, does NOT need the gateway.

## Design: write-time stamp + queue, gateway-time strict drain

### The shared emitter module

`servers/shared/sync-emit.js` exports one function that becomes the ONLY way server code emits a
sync change:

```js
emitOrQueue(syncManager, db, table, op, row, opts) // → lamport | null | {queued, lamport}
```

- With a live `syncManager`: exactly today's `emitChange` call (in-gateway behavior unchanged).
- Without a manager, first the **eligibility gate**: the same predicate the gateway uses
  (`shouldInitInstanceSync` semantics — `CROW_DISABLE_INSTANCE_SYNC=1` / no-auth) evaluated in
  the writing process. A deployment that has sync switched off gets today's behavior (emission
  dropped), NOT an ever-growing queue for a drain that will never come.
- Eligible writes are stamped **at write time**: mint the lamport with the same atomic
  `UPDATE sync_state … RETURNING` (the minting + row-stamping logic — table-specific stamping
  rules included: `dashboard_settings` by key, `crow_context` by composite key, else by id, never
  on deletes — is **extracted from `instance-sync.js` into a small shared module** that both the
  manager and `sync-emit.js` call; duplicated stamping logic would drift), then
  `INSERT INTO sync_outbox (table_name, op, row_json, lamport_ts, created_at)`.
- **Why write-time minting is mandatory, not nice-to-have** (review finding 1): the apply side is
  pure last-lamport-wins everywhere (`_checkConflict` :2669, `_applyCrowContext` :1864,
  `_applyDashboardSetting` :1833). Drain-time minting would give an OLD stdio snapshot a NEWER
  lamport than a gateway write that happened after it — peers converge to stale content while
  the origin keeps the newer row, a divergence no future check can see (equal-lamport ties at
  best). With write-time minting the mixed-doors race resolves correctly by construction, and
  the drain re-emits in **preserve-mode** (`opts.lamportTs`, instance-sync.js:1542–1561), which
  skips the mint and the local re-stamp by design (2c C1 machinery, already tested).
- The module owns `CREATE TABLE IF NOT EXISTS sync_outbox` (bundle-init pattern; NOT in
  `init-db.js`, no `SCHEMA_GENERATION` bump). DDL under a live gateway just waits on the 30s
  busy_timeout (`servers/db.js:469`) — accepted cost: better-sqlite3 is synchronous, so a
  contended first-write can block the stdio server's loop up to that long, once.
- Error handling identical to today's emit sites: never throws into the tool path.

```sql
CREATE TABLE IF NOT EXISTS sync_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,   -- drain order = local write order
  table_name TEXT NOT NULL,
  op TEXT NOT NULL,                        -- 'insert'|'update'|'delete'
  row_json TEXT NOT NULL,                  -- the row snapshot as the emit site built it
  lamport_ts INTEGER NOT NULL,             -- minted at write time (see above)
  claimed_at TEXT,                         -- drain batch claim (see below)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- **Cap**: 10,000 rows — on overflow, warn loudly and drop-oldest (the `_pendingPeerEmits`
  256-cap precedent). The cap should never be reachable on a healthy instance; it exists so a
  misconfigured one degrades like today instead of growing a table without bound.

All existing emit call sites convert to `emitOrQueue` (the sharing-internal `sink()` seams keep
their shape; the null branch queues instead of dropping). **Two in-gateway zero-emit writers join
the sweep** (they have a live manager and still never emit — same defect, no excuse): the
dashboard memory panel's edit/delete (`panels/memory.js:161,170`) and the share-import inserts
(`sharing/boot.js:928` memories, `:961` research_notes).

### The drain

The gateway's sync boot (in `boot/mcp-mounts.js`, after `eagerInitPairedPeers()`) drains the
outbox, then re-drains on a 60s interval. The drain is **strict** — the review's finding 2:
`emitChange` resolving is NOT a durability guarantee (`_appendToPeer` parks in-memory on unarmed
feeds :1472–1479, swallows append failures :1466–1469, caps parked entries at 256 with silent
drop-oldest, and `revokeInstance` discards parked slots :3086). Deleting an outbox row against
that contract converts a survivable queue into permanent loss (the outbox row is the only durable
record; a parked-then-crashed entry is gone). Therefore:

- **Refuse to drain while any paired peer's out-feed is unarmed.** Arming is a local hypercore
  open, not peer connectivity — after a healthy `eagerInitPairedPeers` every paired peer is
  armed; the refusal only bites in the failure windows that matter (fd-lock loser during a
  gateway restart overlap, per-peer init failure), which is exactly when deleting rows would
  lose data. Depth stat + a warn cover the visible symptom.
- Drain via a **strict emit mode**: `emitChange(…, {lamportTs, strict: true})` reports per-peer
  disposition and propagates append failures instead of swallowing them. A row is DELETEd only
  when every paired peer took a **real append**; on any failure the batch stops and retries next
  tick (order preserved; entries never park in RAM on the drain path).
- **Serialization** (finding 5): one in-process drain chain (the `_appendLocks` promise-chain
  pattern :1443) so interval ticks never overlap a slow batch, plus a transactional batch claim —
  `BEGIN IMMEDIATE`, stamp `claimed_at` on the batch, commit, emit, delete — so a second
  feeds-enabled gateway on the same crow.db (the grackle multi-gateway shape) no-ops instead of
  double-draining; stale claims (older than 10 min) are reclaimable.
- Batches read `ORDER BY id ASC`. Preserve-mode floors the manager's counter at each entry's
  lamport (instance-sync.js:1558), so fresh gateway mints always exceed drained values.
- Crash window (append succeeded, delete lost): re-emit next drain **with the same preserved
  lamport** — a true redelivery, the case the apply side is built for (2c C1). Idempotent.
- Observability: drain logs count on non-zero passes; health surface gains outbox depth +
  oldest-row age; `sync_outbox` is added to the recover-db table set (the known recover-db
  bundle-table gap otherwise silently drops queued rows on a `.dump` rebuild).

### Scope of the success criterion (finding 3, honestly stated)

This PR's criterion: **the existing emit sites never silently drop, on any mount** — every
`emitChange`/`sink()` call site plus the two in-gateway zero-emit writers named above. It does
NOT claim every write path to every synced table now emits. The remaining zero-emit family is
real and now has names — filed as follow-ups, not silently absorbed: bundle-process writers
(pm-workspace `memory-index.js:49,54`; maker-lab `server.js:390,567,632` + panel mass-delete;
meta-glasses `server.js:265,433,595` — which makes the Phase 6 `research_notes`/
`glasses_note_sessions` replication claim currently dead on arrival at the emit side) and the
Notion importer (`scripts/sync-notion.js:314,321`). Bundles can adopt `emitOrQueue` through the
app-root import pattern in a follow-up PR; that work rides its own review.

### What this deliberately does not do

- **No loopback-POST path** — fails exactly when durability matters; the outbox alone is always
  correct. Latency (≤ one drain interval) is irrelevant for this data.
- **No per-stdio sync manager, no feed sharing** — single-writer feeds.
- **No historical backfill in this PR.** Rows written through stdio mounts before this fix are
  an operator-run repair (the 2c re-emit rails + a one-shot "re-emit rows with NULL lamport_ts"
  pass), executed per-instance with Kevin; r4 is the live case.

### The CROW_JOURNAL_MODE=DELETE note

The r4 stdio memory mount forces journal_mode=DELETE at its connection while the gateway holds
the db in WAL. The setting cannot demote a WAL db while other connections hold it, but it CAN
succeed during a gateway-down window and force the next boot through a mode flip. Pre-existing
sharp edge, out of scope here; Track 1's `.mcp.json` ops step should drop the env var while it
is in the file.

## Testing

- The suite env exports `CROW_DISABLE_INSTANCE_SYNC=1` (`run-suite.mjs:92`), which makes any
  test-constructed manager `feedsDisabled` AND trips `emitOrQueue`'s eligibility gate — **every
  test below must override the predicate** (the existing `mgr.feedsDisabled = false` pattern,
  tests/instance-sync.test.js:76–81, plus an injection seam on the eligibility check) **or the
  entire suite goes quietly inert** (the item-2a vacuous-test tell, named here so the plan
  budgets for it).
- Unit: `emitOrQueue` with a manager (pass-through); without (lamport minted via sync_state, row
  stamped, outbox row carries the lamport, table auto-created); ineligible (predicate false →
  dropped, not queued); cap overflow (warn + drop-oldest); throwing db (never throws out).
- Mixed-doors race (the finding-1 scenario, as a test): stdio write at T0 queued, gateway write
  of the same row at T1 live-emitted, drain at T2 — peers must converge on the T1 content
  (preserve-mode lamport comparison), and the local row keeps the T1 stamp.
- Drain: order across batches; strict mode refuses on an unarmed paired peer and DELETEs
  nothing; append failure stops the batch with rows intact; claim serialization (a second
  drainer no-ops on claimed rows; stale claims reclaim); crash-window redelivery preserves the
  lamport; interval re-drain picks up mid-run queues.
- End-to-end (the test this defect family never had — MUTUAL multi-process per the item-2a
  lesson): spawn `servers/memory/index.js` as a real stdio child on a scratch CROW_DATA_DIR,
  store a memory over MCP stdio, assert the outbox row + stamped lamport; construct a
  gateway-shaped manager on the same db with stub feeds injected into `mgr.outFeeds` (the
  established seam, tests/instance-sync.test.js:1432), drain, assert the feed entry carries the
  write-time lamport and the row is deleted.
- Every call-site conversion mutation-tested against the e2e (break the queue branch, watch it
  fail). Suite floor 3176/0 held; no UI strings; no new ports.

## Out of scope

Track 1's board verbs (board data is instance-local and never syncs — the specs do not
interact); retiring stdio mounts as a product direction; the historical backfill execution; the
bundle-writer emit adoption (named follow-up above); MCP OAuth; `CROW_JOURNAL_MODE` policy.

## Review record (round 1, 2026-08-15)

One adversarial reviewer against `411692ac`. 8 findings, all resolved in this revision. The two
critical ones replaced the mechanism: (1) drain-time lamport minting would resurrect stale
same-row content on peers AND corrupt the origin's stamp — fixed by write-time minting (the
counter is a cross-process-safe db op, a fact the v1 draft got wrong) + preserve-mode drain;
(2) "delete after emitChange resolves" is not durable (in-RAM parking, swallowed append
failures, parked-slot discards) — fixed by strict per-peer append accounting, refuse-on-unarmed,
and batch claims. Also: the eligibility gate + cap (kill-switch deployments must not queue
unbounded), drain serialization incl. the two-gateway case, the honest success-criterion scope
with the named zero-emit family (+ two in-gateway writers added to this PR), the recover-db
line, and the suite-env override trap in the test section. The row_json snapshot semantics and
the e2e seam were verified clean as drafted.
