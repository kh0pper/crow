# Safe rolling updates for co-hosted gateways — design

**Date:** 2026-08-06
**Tracking:** R4 kanban card #120 (`~/.crow-r4/data/tasks.db`, `tasks_items`)
**Baseline:** `~/crow` at `cbf7a343` (== `origin/main`), CI green
(`suite`/`static-checks`/`audit` all `completed/success`)

## Problem

Three gateways — `crow-gateway` (`~/.crow`), `crow-mpa-gateway` (`~/.crow-mpa`),
`crow-r4-gateway` (`~/.crow-r4`) — run from ONE shared `~/crow` checkout. crow's
auto-updater treats "pull the tree" and "make this instance current" as a single
operation. That is correct for a single-instance install and wrong for a shared
checkout, and it produces four failure classes.

### Gap 1 — migrations do not travel with code

`scripts/migrate-board-stages.mjs` is documented "run on deploy, both instances" but
has no runner. It reached the primary and never reached r4; r4's `tasks.db` lacked
`stage`/`assigned_bot`/`plan_ref` and every Bot Board drawer open 500'd
("no such column: stage") while the board list rendered fine.

The boot-time schema guard in `servers/gateway/index.js:125-195` covers this for
`crow.db` **only when `SCHEMA_GENERATION` is bumped**. Additive columns with no
generation bump reach a host only via `guarded-init-db`, never via a gateway
restart — and nothing at all covers `tasks.db`.

### Gap 2 — installed bundle copies do not travel with code

Gateways run bundle code from `~/.crow-<inst>/bundles/<id>`, synced by hand. A
restart into newer gateway code can pair with stale bundle copies silently.
Per-instance adaptations are deliberate (`knowledge-base`'s `server/db.js` and
`server/app-root.js`), so a blind `rsync --delete` is not available.

### Gap 3 — nothing verifies an update landed healthy

The `tasks` and `bots-sql-mcp` addon children were dead Aug 3–5 (better-sqlite3 ABI
115 vs the gateway's node v22 ABI 127), visible only in `journalctl`. Addon connect
failures are silent at the dashboard level.

### Gap 4 — the updater lock is checkout-scoped, and starves co-hosted instances

`auto-update.js:126` places the lock at `<git-dir>/crow-auto-update.lock` — one lock
per **checkout**, shared by all three gateways.

Verified evidence (2026-08-06):

- All gateways restarted at the same instant (`20:18:46 CDT`), so the
  "+5 min, then every 6h" timers (`auto-update.js:578`) are **phase-locked**.
- Last check: primary `01:23:48.545Z`, MPA `01:23:49.020Z` — **475 ms apart**.
- MPA won (`last_result="Up to date"`, `latest=cbf7a343`). Primary lost:
  `"Skipped: another updater is running (pid 1333991)"`, and pid 1333991 is
  `crow-mpa-gateway`'s MainPID.
- Primary's `auto_update_latest_version=9f5656a3` is **16 commits behind its own
  `current`** — the bookkeeping is not merely stale, it is backwards, because the
  loser never reaches the code that writes it.

The loser does not just skip the pull (which would be correct — the tree is shared).
It skips **everything**: its own migrations and its own restart-into-new-code. Same
phase every tick means the same loser loses forever. This is deterministic
starvation, not a race.

### Gap 4b — a disabled instance never records its real running version

`startAutoUpdate()` returns at `auto-update.js:561` ("Disabled in settings")
**before** line 568 records real HEAD. r4 reports `current=5cc4daf8` while the
process actually runs `cbf7a343` from the shared tree. The bookkeeping and the
running code disagree and nothing detects it.

## The model: converge to the tree, don't pull

Split the single operation into two with different scopes:

| Operation | Scope | Lock | Who runs it |
|---|---|---|---|
| `updateTree()` | the checkout | checkout-scoped, one winner | whichever instance wins |
| `convergeInstance()` | one instance | none needed | **every** instance, always |

`updateTree()` keeps today's semantics: fetch, CI gate, quarantine check, pull, npm.
`convergeInstance()` runs the migration registry for its own instance with its own
env, then restarts. Trigger: `bootSha !== tree HEAD`.

The lock loser stops returning early — it skips the pull it does not need and
proceeds to convergence. This single split closes Gap 1 and Gap 4 together.

## Scope decision: which stores

Live core stores per instance are exactly two: `<data-dir>/crow.db` and
`<data-dir>/tasks.db` (`scripts/pi-bots/instance-paths.mjs` derives both from the
same anchor: `CROW_DB_PATH` → `resolveDataDir()`).

Bundle-owned DBs are **out of scope for v1**. They are heterogeneous and
bundle-owned — `fed-gov-data` sits at `data/fed-gov-data/` on the primary and at
`bundles/fed-gov-data/data/` on r4. Phase 1's diff-sync covers r4's bundle needs;
generalizing bundle migrations is a separate design if it is ever needed (YAGNI).

Noted, not fixed: `~/.crow/crow.db` and `~/.crow-r4/crow.db` both exist at **0
bytes** — empty decoys of the silent-fallback shape. Harmless; out of scope.

## Phase 1 — `r4-deploy.sh` (no crow changes)

One script at `/home/kh0pp/r4-tehcy/scripts/r4-deploy.sh`. Steps in order,
stop-on-fail:

1. `git -C ~/crow pull --ff-only` (or check out an explicit ref argument).
2. `npm ci --omit=dev` only if the lockfile changed.
3. Run all guarded migrations with explicit r4 env
   (`CROW_HOME`, `CROW_DATA_DIR`, `CROW_DB_PATH` → `~/.crow-r4/…`) and the v22 node:
   `scripts/init-db.js`, `scripts/migrate-board-stages.mjs`, and any future
   `scripts/migrate-*` siblings.
4. Diff-sync repo bundle files into r4 installed copies for bundles present in
   `~/.crow-r4/bundles/` — changed files only, **never** `rsync --delete`;
   `diff -r` report at the end. Also sync panel files into `~/.crow-r4/panels/`
   (`<id>.js` + `<id>-routes.js`).
5. Rebuild native modules on ABI mismatch (better-sqlite3 in `tasks` and
   `bots-sql-mcp`); test-load with the v22 node.
6. `systemctl restart crow-r4-gateway`.
7. Health gate: unit active; journal since restart shows every expected addon
   "connected" and zero "failed to connect"; `curl 127.0.0.1:3008/s/family/` → 200;
   authed `GET /dashboard/bot-board-api/card/<id>` → 200.

Additions beyond the original brief, each from a trap that has already cost time:

- v22 node pinned (`~/.nvm/versions/node/v22.23.1/bin`) on **every** npm/node
  invocation — bare `node` is v20 (ABI 115) and silently mismatches.
- Explicit r4 env on **every** out-of-gateway spawn.
- A **both-DB check**: the primary's `~/.crow/data/*` stores must be unchanged
  after the run. Bulk writes end with a both-DB count check before declaring
  success.
- A timestamped log line whenever the pull touches `scripts/pi-bots/`, so the
  `pibot-gateways@r4` soak (7-day Phase 0, ends ~2026-08-12) has explainable
  heartbeat gaps.
- Prints PASS or FAIL with the failing check and the previous commit hash.

Left **uncommitted**, with a note on card #120 for the r4-tehcy PM session to fold
in — this design does not push to another workstream's Gitea repo.

## Phase 2, PR A — migration registry

`scripts/migrations/` — ordered modules, each exporting:

```js
export const id = "0001-board-stages";          // ordering key, stable forever
export function describe() { return "…"; }
export async function run({ dataDir, dbPath, tasksDbPath, log }) { … }
```

Every migration is idempotent and absent-table tolerant, in the existing
`addColumnIfMissing` house style (PRAGMA presence check, additive ALTER, skip when
the table is absent). `migrate-board-stages.mjs` becomes entry `0001`, kept as a
thin wrapper so the manual invocation and Phase 1 step 3 keep working.

The gateway runs the registry **for its own instance** at boot: after the existing
`SCHEMA_GENERATION` guard block (`index.js:125-195`), before serving. Paths are
env-resolved, so co-hosted instances each migrate their own stores.

**Bookkeeping table:** `schema_migrations` (`id`, `applied_at`, `sha`) in the
instance's `crow.db`, created lazily by the runner with
`CREATE TABLE IF NOT EXISTS` — **deliberately NOT added to `scripts/init-db.js`**.
Adding it there would bump `SCHEMA_GENERATION`, which re-runs all of init-db's
8 `DROP TABLE`s across four live DBs, on a host that has lost databases twice this
month. Creating it lazily means no generation bump, no dryrun rail, no DROP risk.

Idempotence is therefore doubly enforced: by recorded id, and by each migration's
own shape checks. A migration must be safe to run even if its record is missing.

**ORDER INVARIANT:** the registry runs AFTER the schema guard and BEFORE the first
`createDbClient()` in the process, for the same reason the guard block does —
`createDbClient` registers a never-closed per-path WAL keeper, and a later restore
would swap the DB file under a pinned inode. `index.js:118-124` documents this and
`tests/migration-guard.test.js` asserts the source ordering; the registry call site
must be covered the same way.

## Phase 2, PR B — converge + health gate

1. **Record real HEAD at boot** before the "Disabled in settings" return
   (`auto-update.js:561`). Fixes Gap 4b; a disabled instance stops lying about its
   version.
2. **Split** `checkForUpdates()` into `updateTree()` and `convergeInstance()`. The
   lock loser proceeds to convergence instead of returning at
   `auto-update.js:211-218`. Fixes Gap 4.
3. **Boot sha** captured as a module constant at process start; convergence
   triggers on `bootSha !== tree HEAD`.
4. **De-phase-lock:** the first-check delay becomes `5 min + jitter derived from a
   stable hash of the instance's data-dir path`. Co-hosted gateways stop colliding
   at the same millisecond, so lock contention becomes rare rather than certain.
   (Jitter is a robustness measure, not the fix — the fix is item 2.)
5. **Health gate — a REGRESSION check, not an absolute one.** A health snapshot is
   exported over `proxy.js`'s existing `connectedServers` Map (`proxy.js:170`,
   which already carries per-addon `status: connected|disconnected|error`). After a
   convergence restart the new process verifies: HTTP listener bound, DB readable,
   and **no addon that was `connected` before the convergence is now failing**.

   Comparing against "all addons green" would quarantine a perfectly good sha on
   any host that already had a broken addon — which is precisely the state crow was
   in Aug 3–5, when `tasks` and `bots-sql-mcp` were down for an unrelated ABI
   reason. The gate must answer "did this update break something?", not "is
   everything perfect?". Fixes Gap 3.

   Grace window for addon connect: **90 s** — `proxy.js`'s own
   `CONNECT_TIMEOUT_MS` is 60 s, so the window must exceed one full connect attempt
   or a slow-but-healthy addon reads as a regression.
6. **Boot cookie:** before restarting, convergence writes a `pending-verification`
   record into the instance data dir carrying the target sha, the **pre-convergence
   health snapshot** (the baseline item 5 compares against), and a deadline of
   **10 min** from the write. The new boot clears it on pass. A boot that finds a
   **past-deadline** pending record proves the previous convergence failed.

   10 min is chosen to exceed the worst realistic boot: a `SCHEMA_GENERATION`
   migration under the guard, plus the 90 s addon window. Too short quarantines
   healthy slow boots; too long leaves a crash-looping instance undetected for that
   window. Both defaults are constants, adjustable without a schema change.
7. **On failure: quarantine, never rollback.** Write a quarantine marker for that
   sha (reusing `servers/shared/migration-guard.js`'s existing marker machinery,
   which already carries auto-clear-when-main-moves and an attempts cap), fire
   ntfy, keep running degraded and observable. Peers read the marker and never
   converge to that sha.

   **The tree is never touched.** `git reset --hard` on a shared checkout would
   let one instance's failed health check drag two healthy peers backward on their
   next boot — one instance's failure becoming a fleet-wide regression. Auto-
   rollback is safe for the single-instance install it was imagined for and unsafe
   for exactly the topology being fixed. (Operator decision, 2026-08-06.)
8. **Canary by construction:** because peers honor the quarantine marker, the first
   instance to converge absorbs a bad sha alone. This is what the operator already
   does by hand by treating the primary as canary — now it is structural.
9. **Kill switch:** `CROW_DISABLE_CONVERGE=1`, documented.

Once merged and deployed, auto-update *could* be re-enabled for r4. That is the
operator's call and is presented as an option, not assumed.

## Phase 3 — not built

Separate git worktree per instance. Costs a second `node_modules` and a second
pull. Build only if Phases 1+2 demonstrably fail.

## Error handling

- Registry migration throws → abort the remaining registry, log loudly, do NOT
  serve on a half-migrated store; the boot gate's existing fail-closed posture
  applies.
- Health gate cannot determine status (snapshot unavailable) → treat as
  **unknown, fail open**, matching `classifyCheckRuns`' documented posture
  (`auto-update.js:253-259`). The gate defends against a knowably-bad convergence,
  not against unknowns.
- Quarantine marker write fails → alert and do not restart; a quarantine we cannot
  record must not be relied on.
- Instances whose `auto_update_enabled='false'` still record real HEAD (item 1) but
  do not converge. Disabled means disabled.

## Testing

Prose review cannot tell you whether a restart-into-newer-code actually migrates.
The gate must be **executable** (Item 2a lesson).

- A fixture harness standing up **two scratch instances against one fixture
  checkout**, moving the fixture HEAD, and asserting that **both** converge and
  **both** DBs migrate — including the case where one instance loses the lock.
- The starvation case specifically: the loser must still migrate and restart.
- The regression-vs-absolute distinction, both directions: an addon broken BEFORE
  convergence and still broken after must **not** quarantine; an addon healthy
  before and failing after **must**.
- Mutation-test every test. Four vacuous tests were caught this way in the P2 arc;
  assume a test is vacuous until a mutation proves otherwise.
- Order-invariant assertion for the registry call site, matching the existing
  `tests/migration-guard.test.js` source-order check.
- Full suite green; `check-runs` on the head sha green
  (`suite`/`static-checks`/`audit`) before any merge.
- Wiped-scratch acceptance after deploy.

## Risks

- **Blast radius:** PR B changes the update path for all 5 fleet instances, not
  just crow's co-hosted trio. Mitigated by quarantine-not-rollback, canary-by-
  construction, and the kill switch.
- **A wrong health gate is worse than none** — a false negative quarantines a good
  sha fleet-wide. Mitigated by fail-open on unknown, and by the marker's existing
  auto-clear-when-main-moves behavior, which bounds the damage to one sha.
- **Shared host, live workstreams:** two other sessions restart/deploy the r4
  gateway, and `pibot-gateways@r4` is mid-soak from the working tree. Deploys go in
  tight verified windows; every `scripts/pi-bots/` pull and every soak-unit restart
  is logged with a timestamp.

## Constraints that bind this work

- Public GitHub `kh0pper/crow`, PR flow, `enforce_admins` TRUE — green check-runs
  before merge, queried via `/commits/<sha>/check-runs` (never commit-status).
- `~/crow` stays on main always; branch work in a `git worktree` with
  `ln -s ~/crow/node_modules`.
- Positional-path commits. No Claude attribution on commits or PRs.
- New `DROP`/`DELETE` → `migration-expectations.js`. New host ports →
  `docs/developers/port-allocation.md`. EN/ES i18n parity gate is live.
- Every out-of-gateway spawn passes explicit instance env; every bulk write ends
  with a both-DB count check.
- Report outcomes on card #120.
