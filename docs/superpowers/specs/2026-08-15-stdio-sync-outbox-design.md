# Stdio-mounted servers must not lose sync emissions — the durable outbox

Companion spec to the Track 1 card-model spec (same arc, own implementation PR, sequenced beside
it). The defect family was named in the Track 0 spec's out-of-scope list and proven at MPA
retirement: **329 of MPA's 343 memories were unreplicable from birth** because they were written
through a stdio-mounted `servers/memory/server.js`, whose every emit site is guarded
`if (syncManager)` — and `syncManager` is null on every stdio mount. The fix must cover **any**
stdio-mounted server, present or future, not just memory.

Verified 2026-08-15 against `origin/main` `411692ac`.

## The defect, precisely

- `InstanceSyncManager.emitChange()` (`servers/sharing/instance-sync.js:1536`) mints a lamport
  from a persisted counter, signs the entry with the instance ed25519 key, stamps the row's
  `lamport_ts`, and appends to per-peer **Hypercore out-feeds**. All of that state — counter,
  identity, feeds, `_pendingPeerEmits` — lives in the gateway process.
- Emit call sites outside the manager: `servers/memory/server.js` ×6 (memories, crow_context),
  `servers/gateway/dashboard/settings/registry.js`, `servers/shared/providers-db.js`,
  `servers/gateway/dashboard/panels/skills.js`, `servers/sharing/{message,contact,group}-sync.js`
  + `sync-conflict-resolve.js`. Each has its own null-guard idiom (`if (syncManager)`, `sink()?.`,
  `if (!_syncManager) return`). Dashboard/panel sites only ever run inside the gateway; the
  memory/projects/sharing/blog servers also run as **stdio mounts** (repo `.mcp.json`;
  `~/r4-tehcy/.mcp.json` `crow-memory` runs `servers/memory/index.js` against the r4 data dir —
  with `CROW_JOURNAL_MODE=DELETE`, note below). On a stdio mount the write lands in crow.db and
  the emission silently never happens: no lamport, no feed entry, no replication — permanently
  (nothing ever revisits the row).
- Hypercores are single-writer append-only logs; a second process must never open/append the
  gateway's out-feeds. Direct emission from stdio processes is therefore structurally off the
  table — this is why the naive fix (start a sync manager in the stdio process) is wrong, and
  why the whole sharing stack (Hyperswarm, Nostr) must not boot per-stdio-mount anyway.

## Design: write-time outbox, gateway-time drain

### The shared emitter module

`servers/shared/sync-emit.js` exports one function that becomes the ONLY way any server code
emits a sync change:

```js
emitOrQueue(syncManager, db, table, op, row, opts) // → lamport | null | 'queued'
```

- With a live `syncManager`: exactly today's `emitChange` call (behavior unchanged in-gateway).
- Without: durably queue in crow.db — `INSERT INTO sync_outbox (table_name, op, row_json,
  created_at)`. Fire-and-forget error handling identical to today's emit sites (never throws
  into the tool path).
- The module owns `CREATE TABLE IF NOT EXISTS sync_outbox` (bundle-init pattern), so a stdio
  mount that runs before the gateway has ever migrated still queues. **Not** in `init-db.js` —
  no `SCHEMA_GENERATION` bump; a registry migration is unnecessary since both writers create
  idempotently.

```sql
CREATE TABLE IF NOT EXISTS sync_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,   -- drain order = local write order
  table_name TEXT NOT NULL,
  op TEXT NOT NULL,                        -- 'insert'|'update'|'delete'
  row_json TEXT NOT NULL,                  -- the row snapshot as the emit site built it
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

All existing emit call sites convert to `emitOrQueue` (the sharing-internal sites keep their
`sink()` seams but the sink's null branch queues instead of dropping). The sweep is mechanical;
the test for each site is not (below).

### The drain

The gateway's sync boot (in `boot/mcp-mounts.js`, AFTER `eagerInitPairedPeers()` — emissions
before feeds arm would park or drop, the exact bug class 2c C3 fixed) drains the outbox, then
re-drains on an interval (60s) for rows queued by stdio mounts while the gateway runs:

- Read rows `ORDER BY id ASC` in batches; for each, call `syncManager.emitChange(table, op,
  JSON.parse(row_json))` and DELETE the row **after** the emit resolves; stop the batch on the
  first failure (retry next tick — order preserved).
- Lamports are minted **at drain time, in outbox order** — correct by construction: the queued
  writes are strictly newer than anything the counter saw before them, and their relative local
  order is preserved by `id ASC`.
- Snapshots, not re-reads: if a row was mutated five times offline, five outbox entries emit in
  order and last-writer-wins converges peers to the final state. A delete after an update emits
  as a delete. No re-read logic, no special cases.
- Crash window (emit succeeded, delete lost): the row re-emits next drain with a fresh lamport —
  a duplicate emission of identical content, which the apply side already treats as idempotent
  (redelivery is a designed-for case: 2c C1 re-emit). Accepted.
- `feedsDisabled` (--no-auth) gateways do NOT drain — a scratch gateway must not consume and
  discard a prod outbox. Drain requires an armed, feeds-enabled manager.
- Observability: drain logs count on every non-zero pass; the health surface
  (`provider-residency`-style) gains an outbox-depth stat so a wedged drain is visible, not
  silent.

### What this deliberately does not do

- **No loopback-POST path.** POSTing to the local gateway fails exactly when durability matters
  (gateway down/migrating) and would need the outbox as its fallback anyway — the outbox alone
  is simpler and always correct. Latency (up to one drain interval) is irrelevant for
  memory/context replication.
- **No per-stdio sync manager**, no feed sharing, no second Hyperswarm — single-writer feeds
  (above).
- **No historical backfill in this PR.** Rows already written through stdio mounts before this
  fix (NULL `lamport_ts`, never emitted) are real but are an operator-run repair, not write-path
  code: the existing re-emit rails (2c) plus a one-shot "re-emit rows with NULL lamport_ts"
  script get their own follow-up task, executed per-instance with Kevin (r4 is the live case).
  The spec's success criterion is: **from deploy forward, zero silent losses on any mount.**

### Ordering vs live emissions

While the gateway runs, a stdio write queues and a near-simultaneous gateway write emits
immediately — the queued row's lamport is minted up to 60s later. Both rows are independent
writes to different rows in practice (two doors, two actors); for the same row the apply side is
last-lamport-wins, and the drain's later lamport correctly represents "the stdio write happened,
the gateway learned of it later." No additional coordination is warranted.

### The CROW_JOURNAL_MODE=DELETE note

The r4 stdio memory mount forces journal_mode=DELETE onto its connection while the gateway holds
the same db in WAL. Rollback-journal and WAL modes are mutually exclusive per-database, not
per-connection — the setting cannot actually demote a WAL db while other connections hold it
(SQLite refuses), but it CAN succeed during a gateway-down window and then force the next
gateway boot through a mode flip. That is a pre-existing sharp edge outside this spec's scope;
the deploy checklist notes it and the `.mcp.json` cleanup (Track 1's ops step) should drop the
env var while it is in there.

## Testing

- Unit: `emitOrQueue` with a manager (passes through, returns lamport), without (row queued,
  table auto-created), with a throwing db (never throws).
- Drain: order preservation across batches; stop-on-failure + resume; crash-window duplicate is
  idempotent at apply (pair with the existing sync apply tests); feedsDisabled refusal;
  interval re-drain picks up rows queued mid-run.
- End-to-end: spawn `servers/memory/index.js` as a real stdio child against a scratch
  CROW_DATA_DIR, store a memory over MCP stdio, assert the outbox row; boot a gateway-shaped
  manager against the same db, drain, assert the peer feed received the entry (in-memory feed
  seam) and the row's lamport_ts stamped. This is the test the defect family never had — a
  MUTUAL multi-process case per the item-2a lesson (prose review is insufficient for
  distributed state; the gate must be executable).
- Every emit call-site conversion gets a mutation test (break the queue branch, watch the e2e
  test fail — not just the unit test).
- Suite floor 3176/0 held; EN/ES untouched (no UI strings); no new ports.

## Out of scope

Track 1's board verbs (own spec — board data is instance-local by design and never syncs);
retiring stdio mounts as a product direction (the outbox makes them safe instead); the
historical-rows backfill execution (follow-up task with Kevin per instance); MCP OAuth;
`CROW_JOURNAL_MODE` policy.
