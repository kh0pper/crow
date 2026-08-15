# Track 1 Card Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Plans-as-records, the gateway `board_*` verb surface with provenance, per-card autonomy with the result/approval model, Monday-safe card archiving, and `plan_ref`/`planCard` retirement — Track 1 of the board-as-truth arc.

**Architecture:** A shared service layer (`servers/gateway/board/`) becomes the only `tasks_items` writer in the gateway; the dashboard routes, the panel's no-JS handlers, and a new `/board/mcp` MCP mount are thin callers. Migration `0004` (registry rail) adds `board_plans`/`board_results`/`board_mutations` (instance-global ONLY) + `autonomy`/`archived_at` columns and drops `plan_ref`. The bridge's execute path re-points from plan files to plan records and reports outcomes via `board_report_result`.

**Tech Stack:** Node 22 (`export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH`), node:test, better-sqlite3 via `servers/db.js` `createDbClient` (libsql-shaped: `execute/batch/executeMultiple/close`), MCP SDK 1.27.1, Express 4.

**Spec:** `docs/superpowers/specs/2026-08-15-track1-card-model-design.md` — read it FIRST; it carries two review rounds' worth of constraints. The scope doc is on Gitea (`kh0pp/crow-engineering`).

## Global Constraints

- Suite floor **3176/0** (`npm test` from the worktree root). Never merge below it.
- Every new test is **mutation-tested**: break the mechanism by Edit, watch the test fail, restore by Edit — NEVER `git checkout` (it reverts uncommitted work).
- Positional-path commits only: `git commit <paths> -m …`; verify `git show --stat HEAD`.
- Panel `client.js` is a template-literal-emitted script: **no backticks, escape sequences double-escaped** (`'\\n'`); `tests/board-panel-config.test.js` parses the emitted script — keep it green.
- Def envelopes are JSON **strings** (`status_values`/`columns_json`); items expose `title AS label`. `tests/tracker-api.test.js` pins this.
- Every new UI string ships **EN+ES** in `servers/gateway/dashboard/shared/i18n.js` (global parity gate test).
- SSE tests parse frames **by event name**, never bare `data:` lines.
- New tables/columns: **NO `SCHEMA_GENERATION` bump, nothing in `scripts/init-db.js`** — migration registry only.
- `board_plans`/`board_results`/`board_mutations` live in the **instance-global tasks.db ONLY** (spec store-topology rule). Card lookups are `WHERE id=? AND board_id IS NULL`; tracker-item lookups `IS NOT NULL`; nothing reads by bare id.
- Actor vocabulary: `actor_kind IN ('human','session','bot')`; `decided_via IN ('chat','dashboard','auto')`.
- Worktree: `~/crow-wt-board-track1` (branch `feat/board-track1-card-model`), `node_modules` symlinked to `~/crow/node_modules`.
- Do NOT touch anything under `~/.crow-r4` or `~/r4-tehcy` (live instance; deploy is Task 11, operator-led).

---

### Task 1: Migration `0004-track1-card-model`

**Files:**
- Create: `scripts/migrations/0004-track1-card-model.mjs`
- Modify: `tests/migration-registry.test.js` (extend converged-shape; INVERT the "dormant columns survive" assertion at ~:232 — after 0004, `plan_ref` must be GONE)
- Test: `tests/track1-migration.test.js`

**Interfaces:**
- Consumes: `scripts/migrations/runner.mjs` conventions (read `0002-board-defs.mjs` and `0003-tracker-convergence.mjs` first — probe-guarded idempotence, `{deferred:true}` when `tasks_items` absent, sidecar backups, `markPhaseADone`-style fixture seeding in `tests/tracker-convergence-migration.test.js:24`).
- Produces: instance-global tasks.db with tables `board_plans`, `board_results`, `board_mutations` (DDL exactly as in spec D-T1.3/D-T1.4/D-T1.5), columns `tasks_items.autonomy TEXT NOT NULL DEFAULT 'gated'` and `tasks_items.archived_at TEXT`, and NO `plan_ref` column. Per-project stores (from `project_spaces` rows with a `tasks_db_uri`): ONLY the guarded column ALTERs + probe-guarded `DROP COLUMN plan_ref`, each with its own `tasks.db.bak-0004-<utc>` sidecar; log any non-NULL `plan_ref` values loudly before dropping. The three new tables are NOT created in per-project stores.

- [ ] **Step 1: Write the failing tests.** In `tests/track1-migration.test.js`, using the scratch-env fixture pattern from `tests/tracker-convergence-migration.test.js` (seed `schema_migrations` with `0001-board-stages`, `0002-board-defs`, `0003-tracker-convergence` FIRST or the earlier migrations re-run and crash on duplicate data):

```js
test("0004 adds tables+columns and drops plan_ref on a post-0003 store", async () => {
  // fixture: tasks.db shaped like live r4 post-0003 (tasks_items WITH plan_ref column,
  // a few cards + one tracker item), crow.db with schema_migrations seeded 0001-0003
  await runMigrations({ migrationsDir, dataDir, log: () => {} });
  const cols = colNames(tasksDb, "tasks_items");
  assert.ok(cols.includes("autonomy") && cols.includes("archived_at"));
  assert.ok(!cols.includes("plan_ref"));
  for (const t of ["board_plans", "board_results", "board_mutations"]) assert.ok(hasTable(tasksDb, t));
  // data survives bit-for-bit
  assert.equal(rowCount(tasksDb, "tasks_items"), seededCount);
  assert.equal(readTitle(tasksDb, 1), "seeded card one");
});
test("0004 re-run converges (idempotent)", ...);           // run twice, same shape, no throw
test("0004 defers when tasks_items absent", ...);          // fresh empty store → {deferred:true}, nothing recorded
test("0004 tolerates a store that never had plan_ref", ...); // bundle-shaped store WITHOUT plan_ref → no throw, columns added
test("0004 per-project store gets columns + guarded drop + backup, NOT the three tables", ...);
test("0004 logs non-NULL plan_ref before dropping (per-project)", ...); // seed {"kind":"workspace"}, capture log
```

- [ ] **Step 2: Run to verify they fail** (`node --test tests/track1-migration.test.js` — expect module-not-found / shape assertions failing).
- [ ] **Step 3: Implement the migration** following 0003's structure: probe helpers (`hasTable`, `hasColumn`), sidecar backup before first write per store, `db.batch()` for the DDL group, `ALTER TABLE … ADD COLUMN` guarded by `hasColumn`, `DROP COLUMN plan_ref` guarded by `hasColumn`, per-project enumeration copied from 0002's `project_spaces` walk (strip a leading `file:` from `tasks_db_uri` the way the codebase's known `file:`-URI defect requires — check how 0002 handled per-project paths and do the same), log line for the `kevin-gated` tag count and any non-NULL plan_ref.
- [ ] **Step 4: Run the new tests to green.**
- [ ] **Step 5: Update `tests/migration-registry.test.js`** converged-shape case for the whole-directory run: expected final shape now includes the 0004 deltas; the `plan_ref` "dormant columns survive" assertion INVERTS to "plan_ref dropped by 0004".
- [ ] **Step 6: Mutation-test** (e.g., remove the `hasColumn` guard on the DROP — the never-had-plan_ref test must fail; restore by Edit).
- [ ] **Step 7: Full migration-adjacent run**: `node --test tests/track1-migration.test.js tests/migration-registry.test.js tests/tracker-convergence-migration.test.js` → all green.
- [ ] **Step 8: Commit** (`git commit scripts/migrations/0004-track1-card-model.mjs tests/track1-migration.test.js tests/migration-registry.test.js -m "feat(board): migration 0004 — card-model tables, autonomy/archived_at, plan_ref drop"`).

### Task 2: `card-service.js` — the single card writer

**Files:**
- Create: `servers/gateway/board/card-service.js`
- Test: `tests/board-card-service.test.js`

**Interfaces:**
- Consumes: `resolveBoardDef/isValidStatus/isTerminal` from `servers/gateway/routes/board-defs.js`; db handles created by callers (`createDbClient(TASKS_DB)` / `createDbClient()` for crow.db).
- Produces (exact signatures; later tasks call these):

```js
// actor = { kind: 'human'|'session'|'bot', id: string|null, jobId: string|null }
export async function getCard(tdb, id)                    // → row | null   (WHERE id=? AND board_id IS NULL, includes archived)
export async function getItem(tdb, id)                    // → row | null   (WHERE id=? AND board_id IS NOT NULL)
export async function createCard(tdb, { title, description, status, priority, due_date, phase, owner, tags, project_id, parent_id, autonomy }, actor)
  // def-validates status; parent_id: must exist as a card (404-style error), child inherits parent's project_id; records mutation 'create'; → { id }
export async function updateCard(tdb, id, fields, actor)  // partial update; refuses archived (error code 'archived'); records 'update' with {field:[old,new]} diff
export async function moveCard(tdb, cdb, id, status, actor, { lockExempt } = {})
  // def-validates; refuses archived; refuses locked unless lockExempt matches (Task 3 contract); terminal stamping (completed_at set on entry into terminal, cleared on exit); records 'move'
export async function archiveCard(tdb, cdb, id, actor)    // refuses locked (409-style error 'locked'); refuses already-archived; sets archived_at; records 'archive'
export async function unarchiveCard(tdb, id, actor)       // flips archived_at only; records 'unarchive'
export function recordMutation(tdb, { itemId, verb, actor, detail })  // INSERT board_mutations; detail is the {field:[old,new]} object, stored as detail_json
```

Errors are thrown as `Object.assign(new Error(msg), { code, http })` so route callers map them (`archived`→409, `locked`→409, `bad_status`→400, `not_found`→404, `bad_parent`→400).

- [ ] **Step 1: Failing tests** — in-memory-style scratch store seeded via the migration (run 0001–0004 against a temp data dir; the service must be tested on the REAL migrated shape). Core cases (each its own `test()`):

```js
test("createCard validates status against the resolved def and records a create mutation", async () => {
  const { id } = await createCard(tdb, { title: "t", status: "pending", project_id: 1 }, HUMAN);
  const muts = await allMutations(tdb, id);
  assert.equal(muts[0].verb, "create");
  assert.equal(muts[0].actor_kind, "human");
});
test("createCard rejects an off-def status", ...);            // code 'bad_status'
test("createCard parent_id must exist and child inherits project", ...);
test("updateCard records a field diff and refuses archived cards", ...);
test("moveCard stamps completed_at on terminal entry and clears on exit", ...);
test("moveCard refuses tracker-item ids (board_id NOT NULL) with not_found", ...);
test("archiveCard refuses a locked card / unarchive restores exactly", ...);
test("mutation rows carry job_id for bot actors", ...);
```

- [ ] **Step 2: Run to fail.** **Step 3: Implement** (one file, no Express imports — pure service; lock check calls `lockState` from `servers/gateway/routes/board-lock.js` via a passed-in `cdb`). **Step 4: Green.** **Step 5: Mutation-test** (drop the `board_id IS NULL` predicate — the tracker-id test must fail; drop the diff computation — the diff test must fail). **Step 6: Commit.**

### Task 3: `plan-service.js` + `result-service.js` + lock-exemption plumbing

**Files:**
- Create: `servers/gateway/board/plan-service.js`, `servers/gateway/board/result-service.js`
- Modify: `servers/gateway/routes/board-lock.js` (the session-rail SELECT — today returns only `id, status, pi_session_dir, age_s` — gains `bot_id`)
- Test: `tests/board-plan-result-service.test.js`

**Interfaces:**
- Produces:

```js
// plan-service
export async function getCurrentPlan(tdb, itemId)   // latest approved, else latest draft, else null
export async function listPlans(tdb, itemId)        // all versions desc
export async function savePlan(tdb, itemId, bodyMd, actor)        // appends version n+1 status 'draft'; records 'plan_save'
export async function approvePlan(tdb, itemId, version, actor, via) // one txn: mark approved + supersede prior approved; records 'plan_approve'; via ∈ decided_via vocab
// result-service
export async function reportResult(tdb, cdb, itemId, { outcome, summaryMd, planId }, actor)
  // 409 'terminal' on terminal-status card, 409 'archived' on archived; records result row + 'result_report' mutation;
  // on outcome==='success' && card.autonomy==='auto' && def has terminal 'done':
  //   moveCard(..., 'done', actor, { lockExempt: actor }) + result status 'approved', decided_via 'auto'
export async function decideResult(tdb, itemId, resultId, decision /*'approved'|'rejected'*/, actor, via)
  // only on status 'recorded'; stamps decided_at/decided_via; NEVER moves the card
```

- The **lock-exemption contract** (spec D-T1.5): `moveCard`'s `lockExempt` matches the job rail by `actor.jobId === lock.job_id` and the session rail by `actor.id === sessionRow.bot_id`. Any other live lock still 409s.

- [ ] **Step 1: Failing tests** — the full matrix as individual tests (autonomy `gated|auto` × outcome `success|failure|partial` × def-has-done `y|n`), plus:

```js
test("duplicate success after auto-move 409s (replay-proof: card is now terminal)", ...);
test("auto-move succeeds THROUGH the reporter's own job lock, 409s on someone else's", ...);
test("auto-move succeeds through the reporter's own session lock (bot_id match)", ...);
test("gated success records, does not move, result stays 'recorded'", ...);
test("approvePlan supersedes the prior approved version in one transaction", ...);
test("decideResult refuses an already-decided result", ...);
test("result rows surface plan version + superseded flag via getItemDetail join", ...);
```

- [ ] **Steps 2–4: fail → implement → green.** The board-lock.js edit is one line in the session SELECT; run `tests/board-job-lock.test.js` (existing) to prove no regression.
- [ ] **Step 5: Mutation-test** (invert the def-has-done check — the no-done-terminal matrix cell must fail).
- [ ] **Step 6: Commit.**

### Task 4: Route convergence + plan-record drawer + id-space guards

**Files:**
- Modify: `servers/gateway/routes/bot-board-api.js` (routes become thin service callers; GET `/card/:id` SELECT drops `plan_ref` (~:274); `/card/:id/execute` SELECT drops `plan_ref` (~:716) and gains the `board_id IS NULL` guard, as do `/card/:id/project` (~:575) and `/card/:id/force-unlock`; `/card/:id/plan` GET/POST re-point to plan-service with payload `{versions, body_md, version, status}`; DELETE the `/card/:id/plan-dispatch` route)
- Modify: `servers/gateway/dashboard/panels/bot-board/api-handlers.js` (no-JS move ~:35–:49 and tracker status/lease writes ~:90 call the services; no-JS move gains the card predicate)
- Modify: `servers/gateway/dashboard/panels/bot-board/client.js` (drawer Plan tab: version list + view + save-as-new-version + approve button; remove plan mtime logic at ~:89/:265)
- Modify: `servers/gateway/dashboard/shared/i18n.js` (new strings EN+ES: plan versions, approve, autonomy label/values, history strip, archive labels — full list in Task 5)
- Delete: `servers/gateway/routes/plan-ref.js` — **only after Task 7 removes `bridge.mjs:43`'s static import** (if executing tasks in order, defer the actual `git rm` to Task 7; the routes stop importing it here)
- Test: rewrite the plan-shape cases in `tests/board-card-api.test.js` (:70 dormant-column pin, :263–330 `{markdown,mtime}` shapes, :355 plan-dispatch); delete `tests/board-plan-dispatch.test.js`; new cases in `tests/board-card-api.test.js` for the guards

**Interfaces:**
- Consumes: every service function from Tasks 2–3 exactly as signed.
- Produces: HTTP payloads the panel client reads — `GET /card/:id/plan` → `{ versions: [{version, status, created_at}], current: { version, body_md, status } | null }`; `POST /card/:id/plan` `{ body_md }` → `{ ok, version }`; `POST /card/:id/plan/approve` `{ version }` → `{ ok }`. Actor for all dashboard routes: `{ kind: 'human', id: null, jobId: null }`.

- [ ] **Step 1: Failing tests** for the new payloads + guards (tracker-item id against `/card/:id/project` and `/execute` → 400/404; `GET /card/:id` payload has NO `plan_ref` key).
- [ ] **Step 2–4: fail → implement → green.** Keep every existing passing case in `tests/board-card-api.test.js` green except the deliberately rewritten pins.
- [ ] **Step 5:** `node --test tests/board-panel-config.test.js` — the emitted client script must still parse in both board modes (backtick/escape discipline).
- [ ] **Step 6: Mutation-test + commit.**

### Task 5: Archiving surface (API, panel, SSE, counts, digest)

**Files:**
- Modify: `servers/gateway/routes/bot-board-api.js` (`POST /card/:id/archive`, `POST /card/:id/unarchive`; list endpoints + `/project/:id/unlinked` (~:843) + bulk-assign candidates (~:879) gain `archived_at IS NULL` with an `?include_archived=1` escape)
- Modify: `servers/gateway/routes/streams.js` (kanban tick row sets ~:415/:424 filter archived)
- Modify: `servers/gateway/dashboard/panels/bot-board/html.js` + `client.js` (card-face/drawer Archive action; "Show archived" filter toggle; archived view with per-card Unarchive; failed-result + awaiting-review markers on card faces; the **client-side removal check**: compare the DOM card-id set against the frame's id set, reload under the existing 10s storm guard ~:833–840)
- Modify: `servers/gateway/dashboard/panels/bot-builder/editor.js` (tracker-tab status counts ~:551 filter archived, column-guarded)
- Modify: `bundles/pm-workspace/server/digest/adapters/monday-local.js` + digest board readers (column-guarded `archived_at IS NULL`)
- Modify: `servers/gateway/dashboard/shared/i18n.js` (EN+ES: `board.archive`, `board.unarchive`, `board.showArchived`, `board.archivedView`, `board.awaitingReview`, `board.resultFailed`, `board.autonomy`, `board.autonomyGated`, `board.autonomyAuto`, `board.planVersions`, `board.planApprove`, `board.historyTitle`, plus error strings `board.errArchived`, `board.errLocked`)
- Test: `tests/board-archive.test.js` (new); extend `tests/board-streams.test.js`-family SSE test (parse by event name)

**Interfaces:** consumes `archiveCard`/`unarchiveCard`; produces the `include_archived` query/param convention Task 6's `board_list_items` reuses.

- [ ] **Step 1: Failing tests**: archive→ card leaves default list + SSE tick + counts; `include_archived=1` shows it; unarchive restores; locked-card archive 409; archived-card move/update/execute 409 with the i18n'd reason; SSE frame parsed by event name proves the archived card's id is absent from the frame.
- [ ] **Step 2–4: fail → implement → green.** **Step 5:** parse test + i18n parity test green. **Step 6: Mutation-test** (drop ONE enumerated filter site — its dedicated test must fail; this is why each site gets its own test). **Step 7: Commit.**

### Task 6: `/board/mcp` mount + board token + verbs

**Files:**
- Create: `servers/gateway/board-mcp.js` (the McpServer factory: every verb from the spec's table, thin over the services; actor resolution from `requestInfo` headers — `X-Crow-Actor-Kind`/`X-Crow-Actor-Id`/`X-Crow-Job-Id`, honored only on token-auth'd requests, default `session`)
- Modify: `servers/gateway/local-token.js` (board token: `generateBoardToken(db)` persisting hash in local-scope settings + raw to `join(crowHome(), "board-token")` mode 0600; `applyLocalTokenAuth` accepts EITHER token but scopes the board token to paths matching `^/board/(mcp|sse|messages)`)
- Modify: `servers/gateway/boot/mcp-mounts.js` (mount at `/board/mcp` on the same `mountMcpServer` rail; mint the board token at boot when absent)
- Test: `tests/board-mcp.test.js`

**Interfaces:**
- Consumes: services (Tasks 2–3), `resolveBoardDef`, `tasks_briefings` table (briefing verbs mirror the tasks bundle's: `board_store_briefing` INSERT, `board_list_briefings` by date desc, `board_get_briefing` by id/date, `board_briefing_snapshot` computes without storing — port the computation from the installed bundle's `tasks_briefing_snapshot`, reading it at `~/.crow-r4/bundles/tasks/server/tools.js:497` for reference ONLY, re-implemented against the services).
- Produces: the wire surface Kevin's sessions and bot configs mount. `board_report_result`'s refusals MUST return MCP `isError: true` (Task 7's session-done detection depends on it).

- [ ] **Step 1: Failing tests** over a real HTTP mount (the existing MCP-mount test pattern — find it with `grep -rl mountMcpServer tests/`): local token reaches `/board/mcp`; **board token reaches `/board/mcp` but 401s on `/memory/mcp`**; verbs round-trip (create → list excludes archived → get includes plan head + latest result + recent mutations → move validates def → archive/unarchive → briefing store/list/get/snapshot); actor headers land in `board_mutations` (`bot` + job id); headerless token call records `session`; `board_report_result` 409 arrives as `isError: true`.
- [ ] **Step 2–4: fail → implement → green.** **Step 5: Mutation-test** (drop the path-scope check — the 401 test must fail). **Step 6: Commit.**

### Task 7: Bridge/bot rail — plans, results, prompt, retirement

**Files:**
- Modify: `scripts/pi-bots/bridge.mjs` — remove the `routes/plan-ref.js` static import (:43); `planForCard` (~:505–540) reads the current plan from `board_plans` in the **instance-global store resolved freshly** (NOT `world.tasksDbPath`); the execute prompt (~:672–679) rewritten: work the plan, then call `board_report_result` — no more "set this card in_progress, then done"; end-of-turn: a non-error `*__board_report_result` in this turn's `pi.toolCalls()` (captured ~:747) marks the session `done` instead of `waiting-user` (~:754); DELETE `planCard` + `recordPlanRef` exports
- Modify: `scripts/pi-bots/job_runner.mjs` — delete the `card_action === 'plan'` branch (~:227–238); `runCardExecute` passes `job.job_id` into `handleInbound`
- Modify: `scripts/pi-bots/mcp_writer.mjs` + `scripts/pi-bots/crow-server-catalog.mjs` — the board entry is the catalog's first `{url, headers}` block: url `http://127.0.0.1:<gatewayPort>/board/mcp`, headers `Authorization: Bearer <raw board token read from <crowHome>/board-token>`, `X-Crow-Actor-Kind: bot`, `X-Crow-Actor-Id: <botId>`, `X-Crow-Job-Id: <jobId when present>` (per-turn config rewrite already exists)
- Modify: `scripts/pi-bots/tracker.mjs` — `kanbanText` (~:33), `taskListContext` (~:84), `customTrackerContext` (~:112) gain **column-guarded** `archived_at IS NULL` (PRAGMA probe precedent at bridge.mjs:515)
- Delete: `scripts/pi-bots/plan_dispatch.mjs`, `servers/gateway/routes/plan-ref.js`
- Test: rewrite/delete `tests/board-plan-ref.test.js`; the ~15 planCard-routing tests in `tests/bot-jobs-card-routing.test.js`; `tests/board-dispatch-job-rail.test.js:158–174`; `tests/cards-db-file-uri.test.js:144–156` (recordPlanRef); new `tests/bridge-board-rail.test.js`

**Interfaces:** consumes Task 6's mount contract (isError 409s) + Task 3's services (via HTTP only — the bridge process NEVER opens board tables directly except `planForCard`'s read of the instance-global store).

- [ ] **Step 1: Failing tests**: `planForCard` returns the approved record's body (and `(no plan)` when none — never "(plan file missing)"); the execute prompt contains the report_result instruction and NOT the move-to-done instruction; the end-of-turn scan flips session state on a non-error report and does NOT on an `isError` one; `job_id` reaches the generated headers; tracker.mjs contexts omit archived rows on a migrated store and don't crash on a store without the column.
- [ ] **Step 2–4: fail → implement → green** — including the full retired-test sweep in the same task (a missed one shows as a suite failure, which is the point).
- [ ] **Step 5:** grep-proof: `grep -rn "plan_ref\|planCard\|recordPlanRef\|plan-dispatch\|plan_dispatch" servers scripts tests` returns ONLY the migration (0004 drops it) and historical docs.
- [ ] **Step 6: Mutation-test + commit.**

### Task 8: Monday sync archiving invariants

**Files:**
- Modify: `bundles/pm-workspace/server/sync/monday.js` — the `localChanged` push branch (~:534–556) skips archived rows; the unmapped create-scan (~:577–590) gains column-guarded `archived_at IS NULL`; by-id pull writes to an archived row log action `pull_archived_update` (new `pm_sync_log` action string, no schema change)
- Test: `bundles/pm-workspace/test/` (follow the bundle's existing test layout) + one repo-side integration case in `tests/track1-migration.test.js`: the archived+synced round-trip

- [ ] **Step 1: Failing tests**: archived+mapped row with a pending local edit does NOT push; archived+unmapped done card is NOT created remotely; a pull targeting an archived row updates in place, stays archived, logs `pull_archived_update`, and does NOT re-INSERT; nothing duplicates on a second pull.
- [ ] **Step 2–4: fail → implement → green.** **Step 5: Mutation-test** (remove the create-scan filter — the re-creation test must fail). **Step 6: Commit.**

### Task 9: History strip + autonomy UI + drawer polish

**Files:**
- Modify: `servers/gateway/dashboard/panels/bot-board/html.js` + `client.js` (read-only history strip in the drawer: latest N `board_mutations`, actor-attributed; autonomy select on drawer + create form; "approve & mark done" button on a recorded-success result — enabled only when the def has terminal `done`; result markers from Task 5 wired to live data)
- Modify: `servers/gateway/routes/bot-board-api.js` (`GET /card/:id` payload gains `autonomy`, `plan_head`, `latest_results`, `mutations` — additive keys only)
- Test: extend `tests/board-card-api.test.js` + `tests/board-panel-config.test.js` stays green

- [ ] **Steps: failing tests (payload keys, def-gated button rendering) → implement → green → parse test → mutation-test → commit.**

### Task 10: Full-suite convergence + concurrent validation + docs

**Files:**
- Modify: `CLAUDE.md` (one line in the Bot Builder section: card verbs are gateway-served at `/board/mcp`; plans/results/mutations tables are instance-global), `docs/architecture/dashboard.md` pointer if the file structure section lists panels' write paths
- No new code.

- [ ] **Step 1:** `npm test` full suite → **must be ≥ 3176 + every new test, 0 fail**. Fix anything that fell over (the retired-test inventory should already be settled by Task 7).
- [ ] **Step 2:** Concurrent validation: 3 rounds × 3 parallel `npm test` runs (the flake-hunt doctrine — PR #289 made this safe). Zero flakes tolerated; investigate any with the "fixed ports / process table" checklist before proceeding.
- [ ] **Step 3:** Docs edits — **controller fact-checks any subagent-written docs text against the code** (the haiku-fabrication lesson).
- [ ] **Step 4: Commit docs.**

### Task 11: Whole-branch review, PR, deploy runbook (operator-led)

- [ ] **Step 1:** Whole-branch adversarial code review (superpowers:requesting-code-review discipline; run finders synchronously or budget SendMessage resume — the forked orchestrator loses background finder results). Fix findings on-branch; re-run the suite.
- [ ] **Step 2:** Push branch (`git pull --rebase origin main` first), open the PR via GitHub MCP (no Claude attribution). CI gate: `/commits/<sha>/check-runs` — `suite`/`static-checks`/`audit` all `completed`/`success`.
- [ ] **Step 3:** Merge on green. THEN the r4 deploy checklist — **verbatim from the spec's "Testing and rollout" section, steps 1–5**, which is operator-led: fuser check → Kevin closes tehcy sessions → pause `pibot-gateways@r4` (soak-log) → deploy + verify 0004 journal lines (instance + per-project) + drain queued `plan` jobs → **token bootstrap WITH Kevin (Connect panel one-time reveal — r4 has no local token)** → the `.mcp.json` swap same conversation (r4-tasks → `/board/mcp`; r4-trackers STAYS, tracker_* leave the allowlist; strip the hand-edited tracker block, logged) → the two-sided 77-card archive backlog pass with Kevin.

---

## Self-review record

Spec-coverage pass done against D-T1.1–D-T1.9 + migration + testing sections: every spec
requirement maps to a task (D-T1.1 verbs→T6, capability floor→T6 incl. snapshot, retirement
scope→T11 runbook; D-T1.2→T2/T4; D-T1.3→T2/T6; D-T1.4→T1/T3/T4/T7; D-T1.5→T3/T6/T7/T9;
D-T1.6→T1/T5/T7/T8; D-T1.7→T1/T4/T7; D-T1.8→T4; D-T1.9→T11). Type-consistency pass: service
signatures quoted identically in T2/T3 (producers) and T4/T6/T7 (consumers). Line numbers are
reviewer-verified against 411692ac but MUST be re-located by content, not offset, at execution
time (the file will drift as tasks land).
