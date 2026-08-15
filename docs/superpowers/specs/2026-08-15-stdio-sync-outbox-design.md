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
- Without a manager, first the **eligibility gate — a db-persisted deployment setting, not
  process env** (round-2 finding: `shouldInitInstanceSync` reads THIS process's argv/env, and
  the processes this design couples routinely disagree — the r4 stdio mount's env carries no
  `CROW_DISABLE_INSTANCE_SYNC` while the gateway's unit might, which would queue forever against
  a drain that never comes; the inverse inheritance silently drops, i.e. today's defect). The
  feeds-owning gateway persists its own predicate verdict to a local-scoped setting
  (`sync_deployment_enabled`) at boot; `emitOrQueue` reads THAT (env/argv only as a fallback
  when the setting has never been written). When the deployment has sync off → drop (today's
  behavior). When on → queue. **A `--no-auth` companion gateway on a shared crow.db (the
  grackle shape) is a non-owner and QUEUES rather than drops** — the primary's drain is exactly
  the machinery that can finally replicate its writes.
- Before either gate, the **syncability parity check**: `table ∈ SYNCED_TABLES` and
  `shouldSyncRow(table, row)` run at write time exactly as the live path runs them — a row the
  live emit would filter must never be queued (its drain emit returns null → no delivery marks
  → the row wedges claimed/reclaimed forever and eventually cap-evicts real rows). The drain
  additionally deletes any row whose emit returns the not-syncable null (belt and braces for
  rows queued by older code). [Plan-review addition, 2026-08-15.]
- Eligible writes are stamped **at write time**: mint the lamport with the same atomic
  `UPDATE sync_state … RETURNING` (verified cross-process-safe: single-statement autocommit;
  the manager's only in-memory counter state is a non-authoritative seed flag). The minting +
  row-stamping logic — table-specific rules included: `dashboard_settings` by key,
  `crow_context` by composite key, else by id, never on deletes — is **extracted from
  `instance-sync.js` into a small shared module** that both the manager and `sync-emit.js` call.
- **Mint + row-stamp + outbox INSERT are ONE atomic batch (MUST).** A crash between the stamp
  and the queue INSERT would leave a row stamped-but-never-queued: invisible to the NULL-lamport
  repair rail AND armed to locally reject a peer's later lower-lamport edit the peer never saw —
  silent permanent divergence, strictly worse than today's unstamped row. One `db.batch()`
  (counter increment; stamp + INSERT reading the incremented counter via subselect) closes the
  window.
- The shared module also owns `CREATE TABLE IF NOT EXISTS sync_state` beside its `sync_outbox`
  DDL (today only init-db creates it — a fresh-instance stdio mint would otherwise silently
  fail), and the local-instance-id persist becomes atomic (O_EXCL/rename — the current
  check-then-write can mint two ids on a concurrent first-ever boot).
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
  delivered_json TEXT NOT NULL DEFAULT '{}', -- {peerId: true} per real append (see drain)
  claimed_at TEXT,                         -- drain batch claim (see below)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- **Cap**: 10,000 rows — on overflow, warn loudly and drop-oldest (the `_pendingPeerEmits`
  256-cap precedent: LWW makes dropping the OLDEST the safe direction; refuse-new would keep
  stale snapshots and lose the fresh writes convergence needs). A cap-dropped entry is stamped,
  which would hide it from the NULL-lamport repair rail — so **a cap-drop NULLs the source
  row's `lamport_ts`** (and logs the dropped key), keeping the documented repair rail able to
  find it. The cap should never be reachable on a healthy instance.

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

- **Per-peer delivery accounting, not refuse-all.** (Round-2 correction: a refuse-drain-while-
  any-peer-unarmed rule would let ONE broken peer feed — corrupt feed dir, disk error, the
  warn-and-continue path in `eagerInitPairedPeers` :627–629 — halt delivery to every healthy
  peer until the cap starts dropping rows: a wider blast radius than the live path, where a
  broken peer only parks its own entries.) Instead each row carries `delivered_json`
  ({peerId: true}, stamped per **real append**); a row is DELETEd only when every currently
  paired peer is marked delivered. A peer whose feed won't arm blocks only its own marks —
  healthy peers drain normally — and raises an escalating health alert (not just a depth stat):
  paired-but-unarmed for >N drains is an operator-visible condition.
- Drain via a **strict emit mode**: `_appendToPeer` gains an explicit disposition contract —
  `'appended' | 'parked' | 'failed'` (today it returns undefined on all three; the chain at
  :1448 propagates return values, so this is feasible) — and strict mode **treats `parked` as
  failure**: entries never park in RAM on the drain path (a mid-batch revoke/disarm discards
  parked slots :3070–3089, which would silently lose a "strict" entry). Only `'appended'` sets
  a delivery mark. Append failures propagate; the batch stops and retries next tick.
- **Serialization** (finding 5, mechanism corrected in round 2): one in-process drain chain
  (the `_appendLocks` promise-chain pattern :1443) so interval ticks never overlap a slow
  batch; and the cross-process batch claim is a **single autocommit statement** — no
  BEGIN IMMEDIATE (the shared client's `batch()` is deferred-transaction and a raw multi-await
  BEGIN would sweep concurrent gateway statements into the claim txn):
  `UPDATE sync_outbox SET claimed_at = datetime('now') WHERE id IN (SELECT id FROM sync_outbox
  WHERE claimed_at IS NULL OR claimed_at < datetime('now','-10 minutes') ORDER BY id LIMIT ?)
  RETURNING *`. Stale claims reclaim after 10 min; stale-reclaim double-emit is idempotent
  redelivery (verified: equivalence skip at apply, :2682–2684). The two-gateway case is further
  bounded by the hypercore fd-lock.
- Batches read `ORDER BY id ASC`. Preserve-mode floors the manager's counter at each entry's
  lamport (instance-sync.js:1558), so fresh gateway mints always exceed drained values. The
  apply side has no per-feed lamport-monotonicity assertion (verified) — a feed carrying 90
  after 100 is tolerated and LWW-resolved.
- Crash window (append succeeded, delete lost): re-emit next drain **with the same preserved
  lamport** — a true redelivery, the case the apply side is built for (2c C1). Idempotent.
- **Accepted noise, named so soak doesn't misread it**: when a stdio write and a newer gateway
  write to the same row interleave, the drained stale entry arrives at peers with a LOWER
  lamport than the live emit → each peer records a conflict row + notification while correctly
  keeping the newer content. Correct outcome, noisy signal; the no-same-author-suppression
  heuristic is deliberate upstream (:2650) and is not changed here.
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
  write-time lamport and the row is deleted. **The stub peers must also be registered as
  `'active'` rows in `crow_instances`** — the paired-peer set comes from that table, and
  without registration the delivery-accounting assertions (and the paired-but-unarmed case,
  which needs one registered peer with NO stub feed) go quietly inert — the vacuous-test tell
  again.
- Atomicity: kill the stdio child between logical stamp and queue steps (fault-injection seam
  in the shared module) and assert no stamped-but-unqueued row can exist (the batch makes the
  window unobservable).
- Every call-site conversion mutation-tested against the e2e (break the queue branch, watch it
  fail). Suite floor 3176/0 held; no UI strings; no new ports.

## Out of scope

Track 1's board verbs (board data is instance-local and never syncs — the specs do not
interact); retiring stdio mounts as a product direction; the historical backfill execution; the
bundle-writer emit adoption (named follow-up above); MCP OAuth; `CROW_JOURNAL_MODE` policy.

## Review record (2026-08-15)

**Round 1** (one reviewer, against `411692ac`): 8 findings. The two critical ones replaced the
mechanism: drain-time lamport minting would resurrect stale same-row content on peers AND
corrupt the origin's stamp → write-time minting + preserve-mode drain; "delete after emitChange
resolves" is not durable (in-RAM parking, swallowed append failures, parked-slot discards) →
strict append accounting. Also: eligibility gate + cap, drain serialization, the honest
success-criterion scope with the named zero-emit family (+ two in-gateway writers added to this
PR), the recover-db line, the suite-env override trap.

**Round 2** (fresh reviewer, verifying the round-1 fixes): core mechanism verified correct
(cross-process mint safety, preserve-mode transform/filter behavior, no apply-side monotonicity
assertion, offline peers don't wedge arming, fd-lock bounds the two-gateway case). 9 findings,
all resolved above: (1-CRIT) stamp+queue must be one atomic batch — a stamped-but-unqueued
orphan is invisible to the repair rail and armed to reject peer edits; (2-CRIT) the eligibility
gate moved from process-env (which disagrees across the coupled processes) to a db-persisted
owner-written setting, and --no-auth companions now queue rather than drop; (3) refuse-all-on-
one-unarmed replaced by per-peer delivery accounting + escalating health alert; (4) the claim
became a single autocommit UPDATE…RETURNING (no BEGIN IMMEDIATE on the shared client); (5) the
`appended|parked|failed` disposition contract, strict-treats-parked-as-failure; (6) mixed-doors
conflict noise named as accepted; (7) shared module owns sync_state DDL + atomic instance-id
persist; (8) cap-drop NULLs the source stamp so the repair rail still finds it; (9) e2e must
register stub peers in crow_instances or the strict assertions are vacuous.
