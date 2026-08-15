# Stdio Sync Outbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No sync emission is ever silently lost on a stdio-mounted server — durable `sync_outbox` with write-time lamport minting, drained strictly by the feeds-owning gateway.

**Architecture:** A shared stamping module (extracted from `instance-sync.js`) mints lamports cross-process via `UPDATE sync_state … RETURNING`; `emitOrQueue` in `servers/shared/sync-emit.js` either passes through to a live manager or atomically stamps+queues; the gateway drains in preserve-mode with per-peer delivery accounting and a single-statement claim. Own PR, independent of the Track 1 card-model branch (board data never syncs — no interaction).

**Tech Stack:** Node 22, node:test, better-sqlite3 via `servers/db.js`, Hypercore feeds (untouched — single-writer, gateway-only).

**Spec:** `docs/superpowers/specs/2026-08-15-stdio-sync-outbox-design.md` — the authority; two review rounds' constraints live in its Review record.

## Global Constraints

- Suite floor 3176/0; mutation-test every new test (restore by Edit, never git checkout).
- The suite env exports `CROW_DISABLE_INSTANCE_SYNC=1` (`scripts/run-suite.mjs:92`) — every test in this plan must override the eligibility gate (the `mgr.feedsDisabled = false` pattern, `tests/instance-sync.test.js:76–81`, plus the new injection seam) **or it is vacuous**.
- NOTHING in `scripts/init-db.js` — the shared module owns `CREATE TABLE IF NOT EXISTS` for `sync_outbox` AND `sync_state`. No `SCHEMA_GENERATION` bump.
- Mint + row-stamp + outbox-INSERT are ONE atomic `db.batch()` (spec MUST).
- Strict drain: DELETE an outbox row only when every currently paired peer carries a real-append mark in `delivered_json`; `parked` counts as failure on the drain path.
- Positional-path commits; EN/ES untouched (no UI strings); no new ports.
- Work in a sibling worktree from origin/main (`~/crow-wt-sync-outbox`, `ln -s ~/crow/node_modules`).

---

### Task 1: Extract the stamping module

**Files:**
- Create: `servers/shared/sync-stamp.js`
- Modify: `servers/sharing/instance-sync.js` (`_nextLamport` ~:406–431, `_advanceCounter`, and the per-table row-stamp block inside `emitChange` ~:1585–1612 delegate to the module — behavior byte-identical)
- Modify: `servers/gateway/instance-registry.js` (`getOrCreateLocalInstanceId`, :333–353): atomic persist via `writeFileSync(idPath, id, { flag: "wx" })`, and on `EEXIST` **re-read and return the winner's id** (rename-over-target is NOT exclusive — both racers would "succeed" with different ids and the file test passes vacuously; the real assertion is that both racers RETURN the same id)
- Test: `tests/sync-stamp.test.js`

**Interfaces (produced — exact):**
```js
export function ensureSyncTables(db)                    // CREATE TABLE IF NOT EXISTS sync_state + sync_outbox (spec DDL verbatim)
export async function mintLamport(db, instanceId)       // the atomic UPDATE sync_state … RETURNING increment WHERE instance_id=? ;
                                                        //   sync_state is KEYED by instance_id (init-db ~:1667) and test managers use
                                                        //   explicit ids — an id-less signature mints against the wrong row and breaks
                                                        //   the existing suite. Seeds the row via INSERT OR IGNORE first (_ensureCounter
                                                        //   :378-397 semantics) — a fresh install otherwise UPDATEs 0 rows and NULLs the queue INSERT.
export async function advanceCounter(db, instanceId, floorValue)  // MAX-floor, same semantics as _advanceCounter
export function stampSql(table, row, lamportTs)         // → {sql, args} | null  — the per-table stamp statement
                                                        //   (dashboard_settings by key, crow_context composite w/ MAX(COALESCE()), else by id; null for deletes/unknown)
```

- [ ] **Step 1: Failing tests**: mintLamport monotonic across two SEPARATE `createDbClient` connections to one db (the cross-process shape, in-process approximation); ensureSyncTables idempotent; stampSql returns the exact three shapes (assert SQL strings) and null for deletes; instance-id concurrent-create yields ONE id (spawn two child processes racing `getOrCreateLocalInstanceId` against one dir — assert a single surviving value).
- [ ] **Step 2: fail.** **Step 3: implement + delegate from instance-sync.js.** **Step 4: green + `node --test tests/instance-sync.test.js` proves zero behavior change.** **Step 5: mutation-test (break the MAX-floor — the monotonic test must fail). Step 6: commit.**

### Task 2: `emitOrQueue`

**Files:**
- Create: `servers/shared/sync-emit.js`
- Test: `tests/sync-emit.test.js`

**Interfaces:**
- Consumes: Task 1's module; `readSetting` from the settings registry (for the gate).
- Produces:
```js
export async function emitOrQueue(syncManager, db, table, op, row, opts = {})
// LIVE manager (feedsDisabled === false) → syncManager.emitChange(table, op, row, opts) verbatim
// a feedsDisabled manager COUNTS AS NO MANAGER (the --no-auth companion constructs one and its
//   emitChange returns null at :1538 — pass-through there would silently drop where the spec
//   requires QUEUE)
// no/disabled manager → FIRST the syncability parity gate: table in SYNCED_TABLES AND
//   shouldSyncRow(table, row) (export it — shouldSyncRowForTest already exists :296). A row the
//   live path would filter must NEVER be queued: the drain's emit returns the not-syncable null
//   for it → no appended marks → the row wedges claimed/reclaimed forever and cap-evicts real
//   rows. Not-syncable → return null (identical to live behavior).
// then the eligibility gate: readSetting(db,'sync_deployment_enabled') — '0' → return null;
//   unset → fall back to the process-env predicate — disabled → null;
//   eligible → ONE db.batch(): [#0 INSERT OR IGNORE sync_state seed, counter UPDATE WHERE
//   instance_id=?, row-stamp (stampSql, skipped when null), INSERT sync_outbox(..., lamport via
//   subselect of sync_state counter)] — instanceId resolved via getOrCreateLocalInstanceId().
//   A stamp failure inside the batch is FATAL to the batch (deliberate: all SYNCED_TABLES carry
//   lamport_ts from init-db; do NOT wrap statements individually — that breaks atomicity).
//   returns { queued: true, lamport }
// BELT+BRACES at drain: a drained row whose emit returns the not-syncable null is DELETEd
//   (nothing to deliver), covering rows queued by older code.
// cap: SELECT COUNT(*) before insert; ≥10000 → delete-oldest row, NULL that row's source lamport_ts via stampSql-shaped inverse, warn; then insert
// NEVER throws — internal try/catch, console.warn, return null on failure (today's emit-site contract)
export function _setEligibilityForTest(fn)              // injection seam (suite env override)
```

- [ ] **Step 1: Failing tests**: pass-through with a stub manager; queue path stamps row + outbox row carries the SAME lamport (assert equality — the atomicity observable); gate '0' drops (no row, no stamp); gate unset + env-disabled drops; cap drop-oldest NULLs the evicted source row's lamport and logs; throwing db → returns null, no throw. Fault-injection: kill between logical steps is UNOBSERVABLE because it is one batch — assert via a wrapped batch spy that exactly ONE batch call carries all statements.
- [ ] **Steps 2–6: fail → implement → green → mutation-test (split the batch into two calls — the atomicity spy test must fail) → commit.**

### Task 3: Manager-side strict emit + owner-persisted gate

**Files:**
- Modify: `servers/sharing/instance-sync.js` — `_appendToPeer(peerId, entry, { strict })` returns `'appended' | 'parked' | 'failed'` (chain at :1448 propagates return values); **in strict mode a would-park entry returns `'parked'` WITHOUT pushing to `_pendingPeerEmits`** (:1472–1478 — the spec's entries-never-park-on-the-drain-path rule); `emitChange` gains `opts.strict`: collect per-peer dispositions, treat `parked` as failure, throw on any non-appended (live emits unchanged)
- Modify: `servers/gateway/boot/mcp-mounts.js` — the deployment verdict is persisted **only from the feeds-owning boot path**: `if (!noAuth) writeSetting(db, 'sync_deployment_enabled', feedsDisabled ? '0' : '1', { scope: 'local' })` (`deps.noAuth` exists at :25). A `--no-auth` companion ALSO constructs a manager (mcp-mounts.js:28–30 → managers.js:37) with feedsDisabled=true — an unguarded boot write would clobber the owner's `'1'` with `'0'` on the shared crow.db and undo the spec's round-2 fix. The matrix: owner+feeds-on writes '1'; owner+env-disabled writes '0'; --no-auth NEVER writes.
- Test: extend `tests/instance-sync.test.js`

- [ ] **Step 1: Failing tests**: `_appendToPeer` disposition per outcome (stub feed append success / feed absent+paired → parked / append throws → failed); strict parked does NOT land in `_pendingPeerEmits`; strict emitChange throws on parked and on failed, resolves with `{lamport, appended: [peerIds]}` when all appended; non-strict behavior byte-identical (run the whole existing instance-sync file green); the setting matrix (owner feeds-on → '1', owner env-disabled → '0', noAuth → NO write, pre-seeded value survives a companion boot).
- [ ] **Steps 2–6 as above; mutation-test: make strict treat parked as success — the parked test must fail.**

### Task 4: The drain

**Files:**
- Create: `servers/sharing/sync-outbox-drain.js`
- Modify: `servers/gateway/boot/mcp-mounts.js` (after `eagerInitPairedPeers()`: `startOutboxDrain(syncManager, db)` — boot pass + 60s interval, cleared on shutdown)
- Test: `tests/sync-outbox-drain.test.js`

**Interfaces:**
```js
export function startOutboxDrain(mgr, db, { intervalMs = 60000 } = {})   // → { stop() }
export async function drainOnce(mgr, db, { batchSize = 100 } = {})       // → { emitted, deleted, parkedPeers: [...] }
// claim: single autocommit UPDATE … SET claimed_at WHERE id IN (SELECT … claimed_at IS NULL OR < -10 min ORDER BY id LIMIT ?) RETURNING *
// per row: mgr.emitChange(table, op, JSON.parse(row_json), { lamportTs: row.lamport_ts, strict: true }) →
//   merge appended peers into delivered_json; DELETE when delivered covers ALL currently paired peers
//   ("currently paired" = the emit-target set, crow_instances status IN ('active','offline') — an
//   offline peer retains rows indefinitely BY DESIGN (durability) and does NOT trip the unarmed-peer
//   escalation); a not-syncable null from emitChange → DELETE (nothing to deliver);
//   else UPDATE delivered_json **AND SET claimed_at = NULL** — retained rows (and the batch-stop
//   path) MUST unclaim, or the 10-min stale window turns "retry next tick" into retry-in-10-min
//   and the partial-delivery test cannot pass
// serialization: module-level promise chain (the _appendLocks pattern) — overlapping calls queue
// refuses when mgr.feedsDisabled; health: log count on non-zero pass; expose depth + oldest age via a getStats()
// interval timer is unref()'d (mcp-mounts has no shutdown hook to clear it in)
```

- [ ] **Step 1: Failing tests** (stub feeds injected into `mgr.outFeeds` AND **stub peers registered as 'active' rows in `crow_instances`** — without registration the delivery accounting is vacuous, spec's named trap): order preserved across batches; partial delivery (peer A armed, peer B paired-but-unarmed) → row kept with delivered_json {A:true}, B's arrival completes + deletes; claim excludes claimed rows (second drainOnce on a hand-claimed row no-ops until stale); stale claim (backdated 11 min) reclaims; preserve-mode lamport asserted on the captured feed entry; overlapping drainOnce calls serialize (interleave spy); feedsDisabled refusal.
- [ ] **Steps 2–6: fail → implement → green → mutation-test (delete rows on parked — the partial-delivery test must fail) → commit.**

### Task 5: Call-site sweep

**Files:**
- Modify: `servers/memory/server.js` (6 sites: ~:100, :602, :692, :939, :984, :1082 → `emitOrQueue(syncManager, db, …)`), `servers/gateway/dashboard/settings/registry.js`, `servers/shared/providers-db.js`, `servers/gateway/dashboard/panels/skills.js` (2), `servers/sharing/message-sync.js`, `servers/sharing/contact-sync.js` (sink null-branch queues), `servers/sharing/group-sync.js` (2), `servers/sharing/sync-conflict-resolve.js` (2)
- Modify (the two in-gateway zero-emit writers joining the sweep): `servers/gateway/dashboard/panels/memory.js` (~:161 delete, ~:170 edit — emit via emitOrQueue), `servers/sharing/boot.js` (~:928 memories share-import, ~:961 research_notes)
- Test: `tests/sync-emit-sites.test.js`

- [ ] **Step 1: Failing tests**: for EACH converted site, a targeted test that invokes the site's operation with syncManager null (or absent) against a scratch db and asserts the outbox row (table_name + op). The memory-server sites reuse the existing memory-server test harness. Panel/boot seams (verified — `grep "panels/memory" tests/` finds nothing): the memory panel's POST logic is drivable directly with `{method:'POST', body}` + a `res.redirectAfterPost` stub, precedent `tests/contacts-sync-panel-emit.test.js`; the boot.js share-import path is drivable via `initSharingRuntime` with stub managers then `peerManager.onPeerData(crowId, {type:'share',…})`, precedent `tests/boot-receive-decouple.test.js`.
- [ ] **Steps 2–6: convert site-by-site, green after each, mutation-test at least the memory-insert site (revert to `if (syncManager)` — its site test must fail), commit per logical group.**

### Task 6: The multi-process e2e + mixed-doors race

**Files:**
- Test: `tests/sync-outbox-e2e.test.js`

- [ ] **Step 1: The MUTUAL e2e** (the test this defect family never had): spawn `servers/memory/index.js` as a REAL stdio child on a scratch `CROW_DATA_DIR`, driven via the MCP SDK's `Client` + `StdioClientTransport` (a prod import already, `servers/gateway/proxy.js` — NOTE `tests/remote-mcp-writer.test.js` is NOT a spawn precedent, it only asserts config JSON; no suite test drives stdio MCP today, this is the first). Child env surgery must be explicit — children inherit run-suite's export: `const env = { ...process.env }; delete env.CROW_DISABLE_INSTANCE_SYNC; env.CROW_DATA_DIR = scratch;` — with `sync_deployment_enabled='1'` pre-seeded in the scratch db. Drive one `crow_store_memory`; assert outbox row + stamped row lamport equality. Then construct a manager on the same db (`feedsDisabled=false` override), inject stub feeds + register stub peers 'active', `drainOnce`, assert the captured feed entry carries the child's write-time lamport and the outbox row is gone.
- [ ] **Step 2: The mixed-doors race test** (spec's finding-1 scenario): stdio-shaped queue of row X (older content, lamport L1), live manager emit of newer X content (lamport L2 > L1), drain — assert the FEED carries the queued entry with L1 (preserve-mode) and the LOCAL row still carries L2's stamp; feed both entries to a second manager's apply path and assert it converges on the L2 content.
- [ ] **Steps: fail → (fixes if the race exposes an implementation gap) → green → mutation-test (make the drain mint fresh lamports — the race test must fail) → commit.**

### Task 7: Observability, recover-db, docs, suite, PR

- [ ] **Step 1**: drain stats into the health surface (find the existing pattern: `grep -rn "outbox\|getStats" servers/gateway/provider-health.js` and mirror it); escalating warn when a paired peer stays unarmed >3 consecutive drains.
- [ ] **Step 2**: add `sync_outbox` (and `sync_state`) to the recover-db known-table set in `scripts/recover-crow-db.mjs` (verified filename; `grep "recover-db"` finds nothing).
- [ ] **Step 3**: docs — one paragraph in `docs/architecture/memory-server.md` (the emitter contract: emitOrQueue is the only legal emit path) — controller fact-checks any generated text.
- [ ] **Step 4**: `npm test` full suite ≥ floor; 3×3 concurrent validation.
- [ ] **Step 5**: whole-branch adversarial review → fix wave → push → PR → `/commits/<sha>/check-runs` all green → merge. Deploy rides the next routine fleet deploy (drain self-arms; the r4 stdio mount starts queueing the moment its tree updates — no ops step beyond the normal pull, though the Track 1 `.mcp.json` swap SHOULD drop `CROW_JOURNAL_MODE=DELETE` per the spec note).
- [ ] **Step 6**: queue the named follow-ups as Gitea backlog items: bundle-writer emit adoption (pm-workspace, maker-lab, meta-glasses research_notes — currently dead emitters), Notion importer, the historical NULL-lamport re-emit pass (operator-run, per instance, with Kevin).

---

## Review

**2026-08-15, adversarial staff-engineer subagent review. Verdict: REVISE → all findings
applied.** Seven criticals: (1) the --no-auth companion's boot would clobber the owner's gate
setting → write guarded on `!noAuth`; (2) pass-through on a feedsDisabled manager silently
drops → treated as no-manager, queues; (3) queued rows failing SYNCED_TABLES/shouldSyncRow
would wedge forever → parity gate before queueing + drain deletes not-syncable rows (also
recorded in the spec); (4) retained rows stayed claimed 10 min → unclaim on retain and on
batch-stop; (5) mint/advance signatures missed the `instance_id` key → threaded, with the
INSERT OR IGNORE seed as batch statement #0; (6) rename is not O_EXCL → `flag:'wx'` + EEXIST
re-read, test asserts both racers RETURN one id; (7) the claimed stdio-spawn test precedent was
false → MCP SDK Client + StdioClientTransport named, with explicit child-env surgery.
Suggestions applied: strict no-park parameter, stamp-failure-fatal decision stated, real panel/
boot test seams named, recover file corrected to `scripts/recover-crow-db.mjs`, "currently
paired" defined (offline peers retain by design, no escalation), interval `unref()`.
Reviewer Q1 (suite floor): 3176/0 is the post-PR-#289 recorded floor; executors re-verify at
Task 7 regardless. Q2: matrix restated in Task 3.

## Self-review record

Spec coverage: eligibility gate (T2+T3), atomic stamp+queue (T2), strict drain + per-peer
accounting + claim (T3+T4), cap + NULL-on-drop (T2), sweep incl. the two zero-emit in-gateway
writers (T5), e2e + race + registered-peer trap (T6), recover-db + health + follow-ups (T7).
Type consistency: `emitOrQueue`/`drainOnce`/`mintLamport` signatures quoted once and reused.
Line cites are reviewer-verified at 411692ac; executors re-locate by content.
