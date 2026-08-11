# Track 0 Phase A — Configurable Cards Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The cards board reads per-board status values and declared fields from a new `board_defs` table in tasks.db; `stage` and the dispatcher's card writes are deleted.

**Architecture:** One new resolution module (`servers/gateway/routes/board-defs.js`) is the sole reader/validator of board configuration; a registry migration (`0002-board-defs`) creates `board_defs` and rebuilds `tasks_items` (CHECK dropped, `stage` dropped, `data_json` added); the panel, JSON API, no-JS handlers, and SSE all switch from hardcoded `CARD_STATUSES` to the resolved def. Spec: `docs/superpowers/specs/2026-08-11-track0-board-configurable-design.md`.

**Tech Stack:** Node 22 built-in test runner, better-sqlite3 (migrations), libsql client (`servers/db.js` `createDbClient`), Express, vanilla-JS dashboard panel.

## Global Constraints

- Node 22 on every invocation: `export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH` (bare `node` is v20).
- Suite floor: **3118 pass / 0 fail** (baseline `f28c427f`). `npm test` runs in a scratch env; single file: `npm test -- tests/<file>.test.js`.
- Commit with positional path args (`git commit <paths> -m …`), verify with `git show --stat HEAD`. Never attribute Claude; no Co-Authored-By trailer.
- NO `SCHEMA_GENERATION` bump; nothing touches `scripts/init-db.js`.
- `bridge.mjs` exported names stay stable (r4 soak until ~2026-08-12): keep `cardsDbForBot` and `resetStrandedCardBestEffort` exported even where their gateway/job_runner callers are deleted.
- Panel client code (`panels/bot-board/client.js`) is emitted inside template literals — no nested backticks anywhere in strings you add there; follow the file's existing string-concatenation style.
- All new UI strings ship in EN **and** ES in `servers/gateway/dashboard/shared/i18n.js` (global parity gate).
- Data guarantee: the 143 r4 cards' title/description/status/priority/due_date/phase/owner/tags/project_id/parent_id/completed_at survive the rebuild byte-identical.
- Mutation-test every new test: after it passes, break the implementation one way, confirm the test fails, restore.

---

### Task 1: Board-def resolution module

**Files:**
- Create: `servers/gateway/routes/board-defs.js`
- Test: `tests/board-defs.test.js`

**Interfaces:**
- Produces (later tasks import all of these from `../routes/board-defs.js` or `../../routes/board-defs.js` depending on depth):
  - `DEFAULT_BOARD_DEF` — frozen `{ id: null, project_id: null, slug: null, display_name: "Board", status_values: ["pending","in_progress","done","cancelled"], terminal_values: ["done","cancelled"], fields: [], builtin: true }`
  - `async resolveBoardDef(tdb, { projectId })` → def object shaped like `DEFAULT_BOARD_DEF` with `builtin: false` when a `board_defs` row matched `project_id`; `DEFAULT_BOARD_DEF` on no row, `projectId == null`, absent table, or any parse error. `status_values`/`terminal_values`/`fields` are parsed arrays, never JSON strings.
  - `isValidStatus(def, v)` → boolean, string-compared against `def.status_values`
  - `isTerminal(def, v)` → boolean against `def.terminal_values`
  - `validateDefPayload(body)` → `{ ok: true, def: {display_name, status_values, terminal_values, fields_json} }` or `{ ok: false, error: "<reason>" }`. Rules: `status_values` non-empty array of non-empty unique trimmed strings (≤ 24 values, each ≤ 60 chars); `terminal_values` ⊆ `status_values`; `fields` an array (≤ 24) of `{key, label, storage, options?, required?}` with unique keys matching `/^[a-z][a-z0-9_]{0,31}$/`, `storage` ∈ {`data`,`column`}, `storage:'column'` allowed only for `key:'phase'`, `options` if present an array of strings.

- [ ] **Step 1: Write the failing test** — `tests/board-defs.test.js`, following the existing test-file style (`node:test`, `node:assert/strict`). Use a temp-dir better-sqlite3 db for the table-present cases and `createDbClient` from `servers/db.js` over it. Cases:

```js
// 1. resolveBoardDef with no board_defs table → DEFAULT_BOARD_DEF (builtin true)
// 2. resolveBoardDef({projectId: null}) → DEFAULT_BOARD_DEF without querying
// 3. seeded row {project_id: 7, status_values:'["a","b"]', terminal_values:'["b"]', fields_json:'[{"key":"phase","label":"Phase","storage":"column"}]'}
//    → resolveBoardDef(tdb,{projectId:7}) returns parsed arrays, builtin false
// 4. corrupt fields_json on the row → DEFAULT_BOARD_DEF (never throws)
// 5. isValidStatus / isTerminal truth table against a custom def
// 6. validateDefPayload: accepts a good payload; rejects empty status list,
//    duplicate statuses, terminal not in statuses, bad field key ("Bad Key"),
//    storage 'column' with key !== 'phase', 25 statuses (cap), non-array fields
```

- [ ] **Step 2: Run to verify it fails** — `npm test -- tests/board-defs.test.js` → FAIL (module not found).
- [ ] **Step 3: Implement `servers/gateway/routes/board-defs.js`** — pure module, no I/O except the one SELECT; every catch degrades to `DEFAULT_BOARD_DEF`; keep it under ~120 lines.
- [ ] **Step 4: Run to verify pass**, then mutation-test (e.g. make `isTerminal` always false → truth-table case fails → restore).
- [ ] **Step 5: Commit** — `git commit servers/gateway/routes/board-defs.js tests/board-defs.test.js -m "feat(board): board-def resolution module — per-board statuses, terminals, fields"`

### Task 2: Migration `0002-board-defs`

**Files:**
- Create: `scripts/migrations/0002-board-defs.mjs`
- Test: `tests/board-defs-migration.test.js`
- Read first: `scripts/migrations/0001-board-stages.mjs`, `scripts/migrations/runner.mjs`, `tests/board-stages-migration.test.js` (the established shape: `export const id`, `export function run({dbPath, tasksDbPath, log})`, `{deferred: true}` when the target table is absent).

**Interfaces:**
- Produces: migration auto-discovered by `runner.mjs` (filename pattern) and run at gateway boot. `run()` returns `{deferred:true}` iff `tasks_items` is absent (board_defs is still created in that pass); otherwise records normally.

**Behavior (all inside one `run()`):**
1. Open `tasksDbPath` (better-sqlite3, `busy_timeout 10000`).
2. `CREATE TABLE IF NOT EXISTS board_defs` exactly per the spec DDL (slug TEXT UNIQUE, project_id INTEGER UNIQUE, display_name, status_values, terminal_values, fields_json DEFAULT '[]', timestamps).
3. If `tasks_items` absent → `{deferred: true}`.
4. Shape-check: rebuild needed iff `PRAGMA table_info(tasks_items)` contains `stage` OR the table's `sqlite_master.sql` contains `CHECK (status IN` (string match is sufficient — that text only ever came from the bundle DDL). If neither → skip to seeding (idempotent re-run path).
5. Before rebuilding: copy the db file to `<tasksDbPath>.bak-0002-<yyyymmddHHMMSS>` (`PRAGMA wal_checkpoint(TRUNCATE)` first, then `fs.copyFileSync`), and log any non-null `stage` values being dropped (`SELECT id, stage FROM tasks_items WHERE stage IS NOT NULL`).
6. Rebuild with **derived DDL, never hardcoded** (review critical #5 — the live table's shape is bundle-owned and can drift; hardcoding crashes the INSERT…SELECT on any variant): read `sql FROM sqlite_master WHERE name='tasks_items'`, string-transform it — strip the `CHECK (status IN (…))` clause, strip the top-level `stage TEXT` column definition, append `, data_json TEXT NOT NULL DEFAULT '{}'` before the closing paren — and build the INSERT column list from `PRAGMA table_info` minus `stage` (everything else, whatever it is, carries over). Index DDL likewise derived: `SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='tasks_items' AND sql IS NOT NULL`, re-executed after the rename. Pragma ordering (review): `PRAGMA foreign_keys=OFF` **before** `BEGIN` (it is a no-op inside a transaction), then BEGIN → create `tasks_items_new` → INSERT…SELECT → DROP old → RENAME → recreate indexes → COMMIT → `PRAGMA foreign_keys=ON`. Boot-time safety: the whole rebuild is one transaction on a `busy_timeout 10000` connection; the stdio second door is read-mostly and retries on busy — same exposure 0001 already accepted.
7. Seeding (idempotent, `INSERT OR IGNORE` keyed on the `project_id` UNIQUE): for each `SELECT DISTINCT project_id FROM tasks_items WHERE project_id IS NOT NULL` — status_values `["pending","in_progress","done","cancelled"]`, terminal `["done","cancelled"]`; fields `[{"key":"phase","label":"Phase","storage":"column","options":[…distinct non-null phase values for that project, sorted…]}]` iff any card in that project has non-null phase, else `[]`; display_name from crow.db (`dbPath`) `project_spaces.name` guarded try/catch, fallback `"Project <id>"`.

- [ ] **Step 1: Write the failing test.** Build a legacy-shaped tasks.db in a temp dir (copy the DDL from the CREATE TABLE in the spec's "Live state" — WITH the CHECK, WITH stage/assigned_bot/plan_ref), seed ~8 rows shaped like r4 (two projects; phases on one project incl. NULLs; one non-null stage on a cancelled card; a parent_id subtask; a completed done card), plus a crow.db with a `project_spaces` row. Cases:

```js
// 1. run() → rebuilt: no CHECK in sqlite_master.sql, no stage column, data_json present
// 2. row-count identical; per-column equality for every surviving column on every row
// 3. board_defs seeded: one def per project, four statuses, phase field ONLY on the
//    project that had phases, options == its distinct values, display_name from crow.db
// 4. re-run → no second rebuild (fs mtime of the .bak unchanged / no new .bak), still equal
// 5. fresh dir (no tasks_items) → {deferred:true} and board_defs exists
// 6. sidecar .bak-0002-* file exists and opens as a db with the OLD shape
// 7. indexes: all five idx_tasks_items_* present after rebuild
```

- [ ] **Step 2: Run → FAIL** (migration module absent).
- [ ] **Step 3: Implement `0002-board-defs.mjs`** per the behavior list.
- [ ] **Step 4: Run → PASS; mutation-test** (e.g. drop the INSERT…SELECT column for `phase` → equality case fails; restore).
- [ ] **Step 5: Restructure `tests/migration-registry.test.js` (review critical #4 — "extend" is not enough).** Its `0001-board-stages` block (~lines 173-202) runs the WHOLE registry directory against a minimal `tasks_items(id, title)` fixture and then asserts `stage` exists (fails — 0002 just dropped it) and that a 0001 re-run leaves columns unchanged (fails — it re-adds `stage` to the rebuilt table). Scope that block's `runMigrations` call to the 0001 module only (import and call its `run()` directly) so it stays a test of 0001's own idempotence; add a separate whole-directory case asserting the CONVERGED final shape (no `stage`, no CHECK, `data_json` present, `board_defs` exists). Run the file → PASS.
- [ ] **Step 6: Commit** — `git commit scripts/migrations/0002-board-defs.mjs tests/board-defs-migration.test.js tests/migration-registry.test.js -m "feat(board): migration 0002 — board_defs + tasks_items rebuild (CHECK and stage dropped, data_json added)"`

### Task 3: API validates against the resolved def

**Files:**
- Modify: `servers/gateway/routes/bot-board-api.js` (GET `/card/:id` ~306-341; edit `/card/:id` ~376-434; move `/card/:id/move` ~437-475; cancel ~478-500)
- Test: extend `tests/board-stage-api.test.js` → rename to `tests/board-card-api.test.js` (keep the passing non-stage cases, retire stage cases here rather than in Task 4, so the suite is green after every task)

**Interfaces:**
- Consumes: `resolveBoardDef`, `isValidStatus`, `isTerminal` from `./board-defs.js` (Task 1).
- Produces: GET `/card/:id` response gains `board: {status_values, terminal_values, fields, builtin}` and DROPS `effectiveStage` and the `stage`/`plan_ref` selects; move endpoint DROPS its `stage` branch (`b.stage` now → 400 `"invalid status"` path); every status write resolves the card's project def first.

**Mechanics:** each handler already loads the card row (which carries `project_id`); call `const def = await resolveBoardDef(tdb, { projectId: card.project_id })` after the row fetch and validate the incoming status **after** loading the card (the current `CARD_STATUSES.has` pre-SQL check moves to post-fetch — the "validate BEFORE SQL" comment invariant becomes "validate before any WRITE", update the header comment). `TERMINAL.has(x)` becomes `isTerminal(def, x)`. `cancel` first checks `isValidStatus(def, "cancelled")` → else 400 `"this board has no cancelled status"`.

- [ ] **Step 1: Write failing tests** (extend the renamed file; it already has an Express harness for the router):

```js
// 1. seeded board_defs row for project 7 with statuses ["todo","doing","shipped"],
//    terminal ["shipped"]: move card → "doing" 200; → "done" 400
// 2. move → "shipped" stamps completed_at; move back → "doing" clears it
// 3. project WITHOUT a def: legacy four statuses still work end-to-end (builtin fallback)
// 4. GET /card/:id returns board.status_values and no effectiveStage key
// 5. move with {stage:"ready"} → 400 (stage branch gone)
// 6. cancel on the custom board (no "cancelled") → 400; on builtin board → 200 + completed_at
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** Do **NOT** touch the `effectiveStage`/`isStage`/`stageToStatus` imports here — execute (~:755) and plan-dispatch (~:804) still call `effectiveStage` until Task 4 owns them (review critical #3: deleting the import in this task 500s every dispatch and reds the suite between tasks). Keep the `plan_ref` select in GET `/card/:id` (spec D-T0.2: plan_ref reads/writes untouched in Track 0); drop only `stage` and `effectiveStage` from the response.
- [ ] **Step 4: Patch `tests/board-job-lock.test.js`'s three move-by-stage bodies IN THIS TASK** (re-review issue #2): the `{stage:"ready"}` POSTs at ~:103-107, ~:134-138, ~:298-302 become `{status:"pending"}` with the same expectations — the stage branch dies here, and :138's expected 200 would otherwise 400. Then run the renamed test file + `tests/board-job-lock.test.js` + `tests/board-dispatch-job-rail.test.js` → all pass (dispatch tests still reference stage via raw SQL setup until Task 4 — if any fail purely on the GET-response shape, patch those assertions here). Mutation-test case 1.
- [ ] **Step 5: Commit** — `git commit servers/gateway/routes/bot-board-api.js tests/board-card-api.test.js -m "feat(board): card API validates status against per-board defs; stage branch removed from move"` (use `git mv` for the rename first).

### Task 4: Delete the stage machinery; dispatch stops writing cards

**Files:**
- Delete: `servers/gateway/routes/board-stages.js`, `scripts/migrate-board-stages.mjs`, `tests/board-stages.test.js`, `tests/bot-jobs-stranding.test.js`
- Modify: `servers/gateway/routes/bot-board-api.js` (execute ~723-780, plan-dispatch ~784-826, force-unlock's `unstrandCardBestEffort` ~185-206 and its call, and NOW delete the `effectiveStage`/`isStage`/`stageToStatus` imports deferred from Task 3), `scripts/pi-bots/job_runner.mjs` (delete `unstrandCard` ~129-144 and its three call sites ~237/~343/~508; delete `NO_PROGRESS_ACTIONS` + its export — review confirmed its only functional use is the un-strand at ~342, and the test iterating it is being deleted), `scripts/pi-bots/bridge.mjs` — FOUR sites, not one (review criticals #1/#2):
  1. the statusToStage reconcile block ~741-764 + the `board-stages.js` import;
  2. `planCard`'s success-path write ~990: `UPDATE tasks_items SET plan_ref=?, stage='ready', status='pending' …` → becomes `UPDATE tasks_items SET plan_ref=?, updated_at=datetime('now') WHERE id=?` (plan_ref write KEPT per spec D-T0.2; stage column is gone post-0002 and status is machinery-written — both go);
  3. `resetStrandedCardBestEffort` ~870-880: stays **exported and functional** (soak + `tests/cards-db-file-uri.test.js` exercise it directly) but stage-free: `UPDATE tasks_items SET status='pending', updated_at=datetime('now') WHERE id=? AND status='in_progress'` — semantically "undo a machinery in_progress", which nothing writes anymore, so it is a defensive no-op in practice;
  4. `planCard`'s four early-refusal `resetStrandedCardBestEffort` calls ~926-941 → delete the calls (the plan-dispatch route no longer writes anything to undo).
  Also modify: `tests/board-dispatch-job-rail.test.js` + `tests/board-plan-dispatch.test.js` (no card write on dispatch), `tests/board-job-lock.test.js` (review critical #6 — lines ~126-131 assert force-unlock's `card_reset`/backlog reset and its fixture DDL has `stage`; rewrite: force-unlock releases the rail and returns no `card_reset`, fixture loses `stage`), `tests/board-stages-migration.test.js` (review critical #7 — it shells `scripts/migrate-board-stages.mjs` at ~:43, which this task deletes; rewrite its harness to import `scripts/migrations/0001-board-stages.mjs`'s `run()` directly), `tests/cards-db-file-uri.test.js` (re-review issue #1 — :129 asserts `row.stage === "backlog"` after the reset; drop that one assertion, the rest of the file survives the new `WHERE status='in_progress'` unchanged)
- Keep: `scripts/migrations/0001-board-stages.mjs` (recorded history; 0002 supersedes its columns)

**Interfaces:**
- Consumes: `isTerminal`, `resolveBoardDef` (Task 1).
- Produces: `execute` gate = `!locked && !isTerminal(def, card.status) && card.assigned_bot && planExists` (planExists via the existing `resolveCardPlan`/`existsSync` block already in the handler); after `enqueueCardJob` there is **no** tasks_items UPDATE. plan-dispatch gate, stated explicitly (review): `!locked && !isTerminal(def, card.status) && card.assigned_bot` — note this legalizes plan-dispatch on an `in_progress` card (old gate refused it via stage∈{backlog,planning}); that is intended: re-planning a card someone marked in_progress is an operator call, and the lock still blocks live work. The route's pre-enqueue `stage='planning', status='pending'` write (~814-817) is deleted along with execute's.

- [ ] **Step 1: Write the replacement tests first** (in `tests/board-dispatch-job-rail.test.js`):

```js
// 1. execute on a ready card: 200, bot_jobs row exists, AND the tasks_items row is
//    byte-identical to before the call (status, updated_at — the whole row)
// 2. execute on a card whose status is terminal on ITS board → 409/400
// 3. execute on a locked card → 409 (existing case, keep)
// 4. job goes terminal (mark bot_jobs failed directly) → lockMapFor reports unlocked;
//    card row STILL untouched (no un-strand write)
// 5. re-execute after 4 succeeds (recovery-by-redispatch replaces un-strand)
// 6. planCard's success write (re-review issue #4 — no surviving test covers it):
//    drive bridge.planCard far enough to reach its card UPDATE (or unit-test the SQL
//    via the same harness cards-db-file-uri.test.js uses) and assert it sets plan_ref
//    and updated_at ONLY — status and (dropped) stage untouched
```

- [ ] **Step 2: Run → FAIL** (execute still writes `stage='executing', status='in_progress'`).
- [ ] **Step 3: Implement the deletions** in the order: bot-board-api (execute/plan-dispatch/unstrand/force-unlock call + stage imports), board-stages.js + wrapper script, bridge (all FOUR sites), job_runner unstrand. Exit greps (re-review issue #3 — patterns tightened; `scripts/migrations/0001-board-stages.mjs` is EXEMPT, it is on the Keep list): both of these must return nothing outside tests/ and 0001: `grep -rn "board-stages\|effectiveStage\|statusToStage\|stageToStatus\|isStage\b" --include="*.js" --include="*.mjs" servers scripts | grep -v "0001-board-stages"` AND — because two of the four bridge sites are raw SQL, invisible to the identifier grep — `grep -rnE "stage\s*=|,\s*stage\b|SET stage" --include="*.js" --include="*.mjs" servers scripts | grep -v "0001-board-stages"` (known false-positive shapes like `stagingDir`/`, stages` in models/runtime.js and bench scripts must not match the tightened patterns; if one does, tighten further rather than deleting exempt code).
- [ ] **Step 4: Update/retire the listed test files.** `bot-jobs-stranding.test.js`: delete — its concern (cards stuck in executing) is structurally impossible now and case 1/4 above are the proof. Run: `npm test -- tests/board-dispatch-job-rail.test.js tests/board-plan-dispatch.test.js tests/board-card-api.test.js tests/board-job-lock.test.js tests/board-stages-migration.test.js tests/cards-db-file-uri.test.js` → PASS. Mutation-test case 1 (re-add a status write to execute → fails) and case 6 (re-add `status='pending'` to planCard's UPDATE → fails).
- [ ] **Step 5: Verify bridge export surface unchanged:** `node -e "import('./scripts/pi-bots/bridge.mjs').then(m=>console.log(Object.keys(m).sort().join('\n')))"` diffed against the same command on main — identical.
- [ ] **Step 6: Commit** — `git commit -m "feat(board): delete stage machinery — dispatch no longer writes cards; locks are the only working state" <every touched path>`

### Task 5: Panel renders from the def

**Files:**
- Modify: `servers/gateway/dashboard/panels/bot-board/data-queries.js` (keep `CARD_STATUSES` only as the builtin def's list — re-export `DEFAULT_BOARD_DEF` instead where practical), `html.js` (`renderKanbanBoard` ~219-321: resolve def via `resolveBoardDef(tdb,{projectId})` before the card query; columns/`--bb-cols` from `def.status_values`; declared-field meta row on `cardFaceHtml` — pass `def` down; drawer status `<select>` options from def — `drawerMarkup` gains a def parameter and its `renderCustomTracker` call site (~html.js:427) passes `DEFAULT_BOARD_DEF` as fallback (review); adopt the filter bar + list toggle + collapsible-column markup from the tracker path for kanban too), `client.js` (kanban mode: wire the same search/filter/list/collapse handlers the custom mode has; status list arrives via the `clientJs(...)` args — follow the existing signature and extend with the def), `api-handlers.js` (`move` ~17-47: replace `CARD_STATUSES.includes` with resolve+`isValidStatus`, terminal stamping via `isTerminal`), `servers/gateway/routes/streams.js` (kanban tick ~392-400: the def's status list must NOT enter the diffed `{cards, locks}` payload — the client's reload check stringifies it and a def edit would otherwise become a permanent-diff reload loop, the exact bug memorialized at html.js:366-371 (review Q3); send it once as a separate `event: board-config` frame at stream open, client reloads once iff it differs from its rendered columns), `servers/gateway/dashboard/panels/bot-board.js` (~:12 facade imports `CARD_STATUSES` — dead; drop it here, review), `servers/gateway/dashboard/panels/bot-builder/editor.js` (~533-544 "Kanban snapshot" hardcodes the four statuses — make it group-by status from the rows so custom statuses count, one small query change, review)
- Test: `tests/board-panel-config.test.js` (new)

**Interfaces:**
- Consumes: everything from Task 1; `statusLabel` applies ONLY when `def.builtin` (configured values render raw, tracker-style).

- [ ] **Step 1: Failing tests** — render-level, same style as existing panel tests (grep `tests/` for how bot-board HTML is currently asserted; `dashboard-native-form-submit.test.js` and the retired stage tests show the harness):

```js
// 1. project with def ["todo","doing","shipped"] renders 3 bb-col divs, --bb-cols:3,
//    and no-JS move buttons carry the custom values
// 2. builtin project renders today's 4 columns with i18n labels (byte-compat check)
// 3. card face shows declared column-backed phase value in the meta row
// 4. api-handlers no-JS move: custom status accepted, off-list value redirects err=bad_move
// 5. drawer markup contains the def's options, not the hardcoded four
```

- [ ] **Step 2: Run → FAIL.** **Step 3: Implement** (html.js first, then client.js — remember: no backticks in emitted client strings). **Step 4: PASS + mutation-test case 4.**
- [ ] **Step 5: Visual check on a scratch gateway:** `CROW_DATA_DIR=$(mktemp -d) node servers/gateway/index.js --no-auth` — board renders; then ctrl-C.
- [ ] **Step 6: Commit.**

### Task 6: Board settings drawer + def endpoints

**Files:**
- Modify: `servers/gateway/routes/bot-board-api.js` (add `GET P+"/board-def"` (query `project_id`) → resolved def incl. builtin; `POST P+"/board-def"` → upsert via `validateDefPayload`, with the guard: removing a status that has cards → 400 `{error:"status '<v>' still has <n> cards"}`), `html.js`/`client.js` (a "⚙ Configure board" button beside the switcher opening a drawer: ordered status list (textarea, one per line), terminal checkboxes, fields table (key/label/storage/options), save → POST → reload), `i18n.js` (all new strings EN+ES, `botboard.cfg*` prefix)
- Test: extend `tests/board-card-api.test.js` + `tests/board-panel-config.test.js`

**Interfaces:**
- Consumes: `validateDefPayload` (Task 1).

- [ ] **Step 1: Failing tests:**

```js
// 1. POST /board-def creates a def; GET returns it; second POST updates (upsert, one row)
// 2. POST removing a status that has cards → 400 with the count; cards untouched
// 3. POST with terminal ⊄ statuses → 400 (validateDefPayload wired, not re-implemented)
// 4. rendered board shows the configure button; drawer markup has cfg i18n strings (en+es spot check)
```

- [ ] **Step 2: FAIL → Step 3: Implement → Step 4: PASS + mutation-test case 2. Step 5: Commit.**

### Task 7: Full suite, docs, PR

- [ ] **Step 1:** `npm test` full suite → **≥ 3118 equivalent green, 0 fail** (count will shift: −retired +new; 0 fail is the contract, and net test count must not drop — state both numbers in the PR body).
- [ ] **Step 2:** `npm run build-registry --check` and `node scripts/check-port-allocation.js` (no new ports — must stay green), and boot check `node servers/gateway/index.js --no-auth` in a scratch `CROW_DATA_DIR`.
- [ ] **Step 3:** Update `docs/architecture/dashboard.md`'s bot-board section (two engines → one config model; stage removed) — keep it to the shape of the surrounding prose.
- [ ] **Step 4:** Commit docs; `git push -u origin feat/board-track0-configurable`; open PR titled `feat(board): Track 0 Phase A — per-board statuses and fields; stage machinery removed` with the spec linked, the data guarantee stated, and the un-strand-deletion reasoning from spec §D-T0.2.
- [ ] **Step 5:** CI via `/commits/<sha>/check-runs` — `suite`, `static-checks`, `audit` all `completed`/`success`. Fix reds; never merge around them.

### Task 8 (post-merge, operator-facing): deploy r4 + acceptance

- [ ] **Step 1:** Check the pibot soak status; log the coming `~/crow` pull + restarts in `~/crow-soak-log.md` (scripts/pi-bots files changed: bridge.mjs, job_runner.mjs).
- [ ] **Step 2:** `SUDO_ASKPASS=<askpass> /home/kh0pp/r4-tehcy/scripts/r4-deploy.sh --dry-run`, then real. Untracked-file collisions abort safely — resolve and re-run.
- [ ] **Step 3:** Acceptance on live r4 (query COPIES of tasks.db): migration ran once (`schema_migrations` has 0002; `.bak-0002-*` exists), 143+ rows intact with per-column spot checks, board renders with the TEHCY def (4 columns + Phase meta), settings drawer opens, a custom status round-trips on a scratch project, dispatch of a throwaway card writes no card state.
- [ ] **Step 4:** Record the result; Phase B (tracker convergence) gets its own plan only after this soaks.

## Self-review notes

- Spec §"Behavior changes" all mapped: render→T5, validation→T3/T5, dispatch→T4, settings→T6, display/i18n→T5/T6, SSE→T5.
- Task 3 renames a test file that Task 4 doesn't know about — Task 4's list uses the new name; if executing out of order, do T3 first (declared order is binding).
- The GET `/card/:id` drawer-hydration change (T3) lands before the drawer consumes `board` (T5) — between them the extra JSON key is inert; acceptable.

## Review

**Reviewer verdict: REVISE** (staff-engineer subagent, 2026-08-11) — architecture approved; 7 critical issues, all incorporated:

1. `bridge.planCard`'s `stage='ready'` write at ~:990 was missed → Task 4 bridge site 2 (plan_ref write kept per spec).
2. `resetStrandedCardBestEffort` writes stage and has planCard-internal call sites ~926-941 → Task 4 bridge sites 3+4; export stays functional (stage-free), answering review Q1.
3. Task 3 deleted imports Task 4's handlers still used (suite red between tasks) → import deletion moved to Task 4.
4. `tests/migration-registry.test.js` whole-directory run breaks two ways under 0002 → Task 2 Step 5 restructures it.
5. Hardcoded rebuild DDL crashes on drifted bundle-created shapes → 0002 derives DDL + index DDL from sqlite_master/PRAGMA; FK pragma ordering fixed (OFF before BEGIN).
6. `tests/board-job-lock.test.js` asserts the deleted `card_reset` behavior → moved to Task 4's modify list with the rewrite described.
7. `tests/board-stages-migration.test.js` shells the deleted wrapper → harness rewritten to import 0001's `run()` directly.

Suggestions incorporated: explicit plan-dispatch gate (in_progress now legal, reasoned); `plan_ref` select kept in GET /card (spec deviation removed); `panels/bot-board.js` facade import cleanup; bot-builder Kanban-snapshot made status-dynamic; `drawerMarkup` def fallback for the tracker call site; SSE `board-config` as a separate non-diffed frame (Q3); boot-time rebuild safety sentence (Q2). Verified-safe claims from review retained as facts: NULL-project cards never reach renderKanbanBoard; client.js drawer ignores stage/effectiveStage; `tests/cards-db-file-uri.test.js` is the only other consumer of the kept bridge exports.

**Re-review round 2 verdict: REVISE → all four remaining issues incorporated:** (1) `cards-db-file-uri.test.js` added to Task 4's modify list (drop its :129 stage assertion); (2) `board-job-lock.test.js`'s three move-by-stage bodies switch to `{status:…}` inside Task 3, keeping the suite green between tasks; (3) exit greps tightened (`stage\s*=`, `,\s*stage\b`) with an explicit 0001 exemption so an executor is never invited to delete kept code; (4) the misdirected `board-plan-ref.test.js` item dropped and replaced by dispatch-test case 6 asserting planCard's UPDATE sets plan_ref+updated_at only, mutation-tested. Round 2 also verified: no fifth stage writer in bridge.mjs; the derived-DDL transform is valid against the live r4 sqlite_master string; the migration-registry restructure matches the file's real blocks.
