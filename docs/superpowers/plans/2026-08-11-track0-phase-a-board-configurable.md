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
5. Before rebuilding: copy the db file to `<tasksDbPath>.bak-0002-<yyyymmddHHMMSS>` (`fs.copyFileSync`; wal-checkpoint first via `PRAGMA wal_checkpoint(TRUNCATE)`), and log any non-null `stage` values being dropped (`SELECT id, stage FROM tasks_items WHERE stage IS NOT NULL`).
6. Rebuild in one transaction with `PRAGMA foreign_keys=OFF`: create `tasks_items_new` with the original DDL minus the status CHECK, minus `stage`, plus `data_json TEXT NOT NULL DEFAULT '{}'` (keep: priority CHECK, parent_id/recurrence FKs, assigned_bot, plan_ref, all defaults); `INSERT INTO tasks_items_new (…all old cols except stage…, data_json) SELECT …, '{}' FROM tasks_items`; `DROP TABLE tasks_items`; `ALTER TABLE tasks_items_new RENAME TO tasks_items`; recreate the five `idx_tasks_items_*` indexes verbatim.
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
- [ ] **Step 5: Check `tests/migration-registry.test.js`** — if it asserts the registry's file list or count, extend it for 0002; run it.
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
- [ ] **Step 3: Implement.** Also delete the now-unused `effectiveStage`/`isStage`/`stageToStatus` imports from this file (their module dies in Task 4).
- [ ] **Step 4: Run the renamed test file + `tests/board-job-lock.test.js` + `tests/board-dispatch-job-rail.test.js` → all pass** (dispatch tests still reference stage until Task 4 — if any fail purely on the GET-response shape, patch those assertions here). Mutation-test case 1.
- [ ] **Step 5: Commit** — `git commit servers/gateway/routes/bot-board-api.js tests/board-card-api.test.js -m "feat(board): card API validates status against per-board defs; stage branch removed from move"` (use `git mv` for the rename first).

### Task 4: Delete the stage machinery; dispatch stops writing cards

**Files:**
- Delete: `servers/gateway/routes/board-stages.js`, `scripts/migrate-board-stages.mjs`, `tests/board-stages.test.js`
- Modify: `servers/gateway/routes/bot-board-api.js` (execute ~723-780, plan-dispatch ~784-826, force-unlock's `unstrandCardBestEffort` ~185-206 and its call), `scripts/pi-bots/job_runner.mjs` (delete `unstrandCard` ~129-144 and its three call sites ~237/~343/~508; delete `NO_PROGRESS_ACTIONS` only if its sole use was un-stranding — check `grep -n NO_PROGRESS_ACTIONS` first, tests iterate it), `scripts/pi-bots/bridge.mjs` (delete the statusToStage reconcile block ~741-764 and the `board-stages.js` import; KEEP `cardsDbForBot` + `resetStrandedCardBestEffort` exported), `scripts/pi-bots/board-briefing? — none`, `tests/bot-jobs-stranding.test.js` (retire; replacement below), `tests/board-dispatch-job-rail.test.js` + `tests/board-plan-dispatch.test.js` (update: no card write on dispatch), `tests/board-stages-migration.test.js` (keep 0001 coverage but drop any assertion that live code consumes stage)
- Keep: `scripts/migrations/0001-board-stages.mjs` (recorded history; 0002 supersedes its columns)

**Interfaces:**
- Consumes: `isTerminal`, `resolveBoardDef` (Task 1).
- Produces: `execute` gate = `!locked && !isTerminal(def, card.status) && card.assigned_bot && planExists` (planExists via the existing `resolveCardPlan`/`existsSync` block already in the handler); after `enqueueCardJob` there is **no** tasks_items UPDATE. Same for plan-dispatch (its gate keeps its current shape minus stage).

- [ ] **Step 1: Write the replacement tests first** (in `tests/board-dispatch-job-rail.test.js`):

```js
// 1. execute on a ready card: 200, bot_jobs row exists, AND the tasks_items row is
//    byte-identical to before the call (status, updated_at — the whole row)
// 2. execute on a card whose status is terminal on ITS board → 409/400
// 3. execute on a locked card → 409 (existing case, keep)
// 4. job goes terminal (mark bot_jobs failed directly) → lockMapFor reports unlocked;
//    card row STILL untouched (no un-strand write)
// 5. re-execute after 4 succeeds (recovery-by-redispatch replaces un-strand)
```

- [ ] **Step 2: Run → FAIL** (execute still writes `stage='executing', status='in_progress'`).
- [ ] **Step 3: Implement the deletions** in the order: bot-board-api (execute/plan-dispatch/unstrand/force-unlock call), board-stages.js + wrapper script, bridge reconcile block, job_runner unstrand. After each file: `grep -rn "board-stages\|effectiveStage\|statusToStage\|stageToStatus\|isStage\b" --include="*.js" --include="*.mjs" servers scripts | grep -v tests` must shrink to empty.
- [ ] **Step 4: Update/retire the listed test files.** `bot-jobs-stranding.test.js`: delete, its concern (cards stuck in executing) is structurally impossible now and case 1/4 above are the proof. Run: `npm test -- tests/board-dispatch-job-rail.test.js tests/board-plan-dispatch.test.js tests/board-card-api.test.js tests/board-job-lock.test.js tests/board-stages-migration.test.js` → PASS. Mutation-test case 1 (re-add a status write to execute → fails).
- [ ] **Step 5: Verify bridge export surface unchanged:** `node -e "import('./scripts/pi-bots/bridge.mjs').then(m=>console.log(Object.keys(m).sort().join('\n')))"` diffed against the same command on main — identical.
- [ ] **Step 6: Commit** — `git commit -m "feat(board): delete stage machinery — dispatch no longer writes cards; locks are the only working state" <every touched path>`

### Task 5: Panel renders from the def

**Files:**
- Modify: `servers/gateway/dashboard/panels/bot-board/data-queries.js` (keep `CARD_STATUSES` only as the builtin def's list — re-export `DEFAULT_BOARD_DEF` instead where practical), `html.js` (`renderKanbanBoard` ~219-321: resolve def via `resolveBoardDef(tdb,{projectId})` before the card query; columns/`--bb-cols` from `def.status_values`; declared-field meta row on `cardFaceHtml` — pass `def` down; drawer status `<select>` options from def; adopt the filter bar + list toggle + collapsible-column markup from the tracker path for kanban too), `client.js` (kanban mode: wire the same search/filter/list/collapse handlers the custom mode has; status list arrives via a data attribute or the clientJs args — follow the existing `clientJs(botId, mode, projectId, trackerSlug, contextFields, lang)` signature and extend with the def), `api-handlers.js` (`move` ~17-47: replace `CARD_STATUSES.includes` with resolve+`isValidStatus`, terminal stamping via `isTerminal`), `servers/gateway/routes/streams.js` (~392-400 kanban tick: also select nothing new — add `statuses: def.status_values` once per stream open so the client can detect config drift and reload)
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
