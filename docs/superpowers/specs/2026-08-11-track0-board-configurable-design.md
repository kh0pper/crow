# Track 0 — the cards board becomes configurable

Design spec under the scope document `specs/2026-08-08-board-truth-and-visual-language-scope.md`
(Gitea `kh0pp/crow-engineering`, branch `docs/board-truth-and-visual-language-scope`). That document
locked sixteen decisions and four tracks; this spec covers **Track 0 only**: the cards board adopts
what tracker boards already do — per-board status values and per-board fields — and the two board
engines converge on one store.

Everything below was re-verified 2026-08-11 against `origin/main` `f28c427f` and copies (never the
live files) of r4's `tasks.db` and `crow.db`. Suite baseline at that sha: **3118 pass / 0 fail**.

---

## Live state, re-verified

The scope doc's three findings hold on current main, several with sharper numbers:

- **The board is a journal.** 143 cards on r4 now (137 on 2026-08-08 — still growing), average
  description 823 chars, max 6,786. `stage` non-null on 1 card (#137, cancelled), `assigned_bot`
  on 1, `plan_ref` on 0.
- **All live card data is on r4.** The primary's `tasks_items` has **0 rows**; grackle has **no
  `tasks_items` table at all**; MPA is archived and gone. The migration story is one board on one
  instance.
- **The second door is live and current.** `~/r4-tehcy/.mcp.json` mounts `r4-tasks` (the tasks
  bundle over stdio, straight at `~/.crow-r4/data/tasks.db`) and `r4-trackers` (bots-sql-mcp over
  stdio at crow.db); `tasks_create/update/complete` are allowlisted. This is the door Kevin's
  sessions write ~2 cards/day through.
- **Two engines, one panel.** `panels/bot-board/html.js` renders `renderKanbanBoard`
  (hardcoded `CARD_STATUSES`, literal `--bb-cols:4`, no filter bar / list view / collapse) beside
  `renderCustomTracker` (statuses and fields from `tracker_defs.status_values` / `columns_json`,
  dynamic `--bb-cols:${colCount}`, filter bar, list toggle, collapsible columns). The gateway API
  already serves CRUD for **both** engines (`routes/bot-board-api.js`).
- **New finding — the tracker engine's schema has no owner.** No `CREATE TABLE` for
  `tracker_defs`/`tracker_items` exists anywhere in the repo, the add-ons registry, or the
  installed bots-sql-mcp bundle. r4's tracker tables were created out-of-band. "Adopt what tracker
  boards already do" therefore means **productizing** a schema that currently exists only as
  hand-rolled state on one instance.
- **New finding — the tasks bundle is fully unowned.** Not in `bundles/`, not in
  `registry/add-ons.json`; it exists only as an installed artifact on r4. Its tools pin the four
  statuses with `z.enum` and write the `phase` column directly — a hard compatibility constraint
  on any schema change.
- **The migration vehicle already exists.** `scripts/migrations/` (runner + `0001-board-stages`)
  is an ordered, idempotent, per-instance registry that runs at gateway boot, explicitly built for
  non-crow.db stores like tasks.db, and explicitly NOT the `SCHEMA_GENERATION` rail. Track 0 needs
  no schema bump and never touches init-db's DROP TABLE path.
- **`tasks_items.status` carries a CHECK constraint** pinning
  `('pending','in_progress','done','cancelled')`. SQLite cannot drop a CHECK with ALTER; per-board
  status values require a guarded table rebuild.
- **`phase` on r4 is doing two jobs**: workflow-ish values (Not started 29, Drafting 28, Internal
  review 10, Final 18, Awaiting reply 1) and grouping-ish values (PM workspace 25, Grant admin 5,
  Nov 2026 toolkit 2, …), 11 distinct + 21 NULL. It is per-board vocabulary, exactly what decision
  11 said it was.

## Decisions this spec makes

The scope doc delegated three questions to Track 0. Answers, with reasoning:

### D-T0.1 — The stores merge, in tasks.db

**One board engine, one store: `tasks.db`.** A new `board_defs` table joins the (rebuilt)
`tasks_items` there; crow.db's `tracker_defs`/`tracker_items` retire in Phase B.

- Why not migrate cards into `tracker_items`: `label` + `data_json` cannot carry the journal —
  823-char average descriptions, typed `due_date`/`parent_id`/`project_id`/recurrence. The richer
  store absorbs the lighter one, not the reverse (18 tracker rows vs 143 cards).
- Why tasks.db and not crow.db: the card data already lives there; the migration registry was
  built for it; it is instance-local by design (the tasks bundle's own "no federation" note),
  which keeps Track 0 entirely off the sync surface; it keeps the journal's write load off the
  contended, twice-corrupted crow.db; and decision 9 ("a plan is a record in the card database")
  means Track 1's plans table lands beside the cards — tasks.db is where "the card database"
  should mean one file you can back up and reason about.
- The file keeps its name. `project_spaces.tasks_db_uri`, backups, r4-deploy, and the second door
  all point at `tasks.db`; renaming buys nothing.

### D-T0.2 — `stage` dies, and dispatch stops writing card state

Locked upstream (decision 11 side: "stage is deleted as a contradiction"). This spec adds the
consequence that makes the deletion safe instead of a hole:

**The dispatcher stops writing to the card entirely.** Today `execute` writes
`stage='executing', status='in_progress'` after enqueueing, and an entire un-strand apparatus
(job_runner's four terminal paths, force-unlock's card reset) exists to undo that write when the
worker dies — the apparatus in which the `file:` URI bug lives. But the board already renders
"a bot is working this card" from the **lock predicate** (`routes/board-lock.js`, job + session
rails), not from the card row. With the dispatcher's write removed:

- a dispatched card shows its lock badge while the job is live, and simply stops being locked when
  the job goes terminal — there is nothing to strand and nothing to un-strand;
- `status` becomes what Finding 1 says it already is: data written by the human, the session, or
  the bot (via its tools mid-turn), never by machinery inferring from process exits — the exact
  principle that got PR #277's v1 reverted;
- `board-stages.js` (STAGES, effectiveStage, statusToStage, stageToStatus) is deleted, along with
  bridge.mjs's post-turn reconcile block and job_runner's card un-strand writes. Two of the three
  `file:`-URI call sites disappear as a side effect (the bug itself, in `cardsDbForBot`, remains
  out of scope and keeps its own PR for the surviving `planCard` site).
- `execute`'s "is it Ready" gate (`effectiveStage === 'ready'`) is replaced by: card is not locked,
  not in a terminal status on its board, and has an `assigned_bot`. An earlier draft of this spec
  also required the plan file to exist, but that was stricter than today's dominant path (an
  explicitly-readied card never checked the plan file — only the legacy null-stage inference did)
  and would have made execute refuse every live card: `plan_ref` is NULL on all of them and no
  plan files exist on r4. The operator's click is the intent; re-dispatching a card whose bot died
  needs no un-strand step. "Ready for a bot" stays derived, per the scope doc, and Track 1 refines
  it when plans become records.

`assigned_bot` stays (dispatch needs a target). `plan_ref` stays as a dormant column with its
reads/writes untouched in Track 0 — decision 16 drops it inside Track 1's plans-table migration,
and this spec deliberately does not reach into it.

### D-T0.3 — `phase` becomes a column-backed declared field; no data moves

`board_defs.fields_json` declares each board's fields. A field's storage is either `data`
(a key in the item's `data_json` — how all tracker fields work today and how new fields are made)
or `column` — a whitelisted binding to an existing typed column. The whitelist is exactly
`['phase']`.

The TEHCY board's migrated definition declares
`{key:'phase', label:'Phase', storage:'column', options:[…the board's observed values…]}`. Nothing
is copied, nothing is dropped, the second door's `INSERT … phase` keeps working unchanged, and the
data guarantee for `phase` is trivially true. The cost is one whitelisted special case, documented
as exactly that; the alternative (migrating phase into data_json) breaks the unowned bundle Kevin
writes through daily, for zero user-visible gain.

### D-T0.4 — Lock unification is deferred to Track 1

Cards are locked by the two-rail predicate (bot_jobs/bot_sessions in crow.db); tracker items by
`processing_lease` columns. Track 1 rebuilds dispatch and terminal-state semantics around the
`pm_planned_events` gate shape — unifying the lock model before that lands means unifying it
twice. Phase B carries the lease columns onto the unified table **verbatim**, and Track 1 decides
the single mechanism. (The scope doc lists the two locks as a Track 0 open question; this is its
answer: converge the store now, converge the lock semantics with dispatch.)

### D-T0.5 — The tasks bundle is not adopted in Track 0

Track 0 is designed so the unowned bundle keeps working without modification: same file, same
table name, same columns (minus `stage`, which the bundle never touches), same four status values
on the migrated board. Its `z.enum` means the second door cannot *set* a custom status on a
reconfigured board — a capability gap, not a breakage, and the gap belongs to Track 1, whose
gateway-served `board_*` verbs are the product answer to both doors. What Track 0 does take is
**schema ownership**: after migration `0002`, the repo's migration registry — not the bundle's
`init-tables.js` — is the authority on `tasks_items`'s shape. (A fresh instance whose bundle
creates the legacy shape converges at the next gateway boot; the migration is shape-checked and
idempotent, so order does not matter.)

---

## The design

### Schema (migration `0002-board-defs`, in the registry)

```sql
CREATE TABLE IF NOT EXISTS board_defs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE,                  -- tracker-style boards (Phase B); NULL for project boards
  project_id INTEGER UNIQUE,         -- project (cards) boards; NULL for slug boards
  display_name TEXT NOT NULL,
  status_values TEXT NOT NULL,       -- JSON array, ordered = column order
  terminal_values TEXT NOT NULL,     -- JSON array, subset of status_values
  fields_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

`tasks_items` is rebuilt (guarded, idempotent, shape-checked: only if the status CHECK or the
`stage` column is present) with exactly three deltas: the status CHECK is dropped, `stage` is
dropped, `data_json TEXT NOT NULL DEFAULT '{}'` is added. Every other column, constraint, FK,
index, and all 143 rows carry over byte-identical. The migration writes a sidecar
`tasks.db.bak-0002-<utc>` before rebuilding and logs the one non-null `stage` value it drops
(card #137, cancelled). Field semantics of `fields_json` entries:
`{key, label, storage:'data'|'column', options?:[], required?:bool}`.

**Seeding.** For each `project_id` that has cards, the migration creates a board_def:
`status_values` = the four legacy statuses (the data guarantee, verbatim), `terminal_values` =
`['done','cancelled']`, and — iff any card in that project has non-null `phase` — a declared
column-backed `phase` field whose `options` are that project's distinct values. On the primary
(0 cards) it seeds nothing. Boards without a def resolve to a built-in default identical to
today's behavior; a fresh install renders exactly as it does now with zero configuration.

### Resolution

One shared module (gateway-side, e.g. `servers/gateway/routes/board-defs.js`) is the only place
board configuration is read or validated: `resolveBoardDef({projectId})` → def-or-default,
`isValidStatus(def, v)`, `isTerminal(def, v)`, `fieldsOf(def)`. The panel, the JSON API, the
no-JS POST handlers, and streams.js all import from it — the board-lock.js lesson (one predicate,
one file) applied to configuration from day one.

### Behavior changes

- **Render** (`renderKanbanBoard`): columns from the resolved def's `status_values` (dynamic
  `--bb-cols`), declared fields on the card face (the tracker face's meta-row treatment), and the
  tracker path's affordances adopted: search/filter bar, status chips, list-view toggle,
  collapsible columns. The drawer's status `<select>` and a per-field input set come from the def.
- **Validation**: every status write — API `move`, `cancel`, card edit, the panel's no-JS `move` —
  validates against the resolved def instead of `CARD_STATUSES`. `completed_at` stamps on entry
  into a terminal value and clears on exit (today's done/cancelled behavior, generalized).
  `cancel` becomes "move to `cancelled` if the board has it", else 400 with a clear reason.
- **Dispatch** (D-T0.2): `execute`/`plan-dispatch` stop writing `stage`/`status`; gating is
  lock + non-terminal + assigned_bot. job_runner and force-unlock keep releasing **rails** but no
  longer rewrite card rows; `bridge.mjs` loses the statusToStage reconcile (its exported surface
  stays name-stable — the reconcile is internal — per the r4 soak constraint).
- **Board settings**: a "Configure board" drawer on the board page (statuses as an ordered
  editable list, terminal subset, fields editor), backed by
  `GET/POST /dashboard/bot-board-api/board-def` endpoints mirroring the tracker-def endpoints.
  Editing `status_values` renames no data: removing a value that has cards on it is rejected with
  the count (no silent orphaning); renaming is remove+add and gets the same guard. A migrate-
  cards-then-remove flow is deliberately NOT built (YAGNI — move the cards on the board first).
- **Display**: configured status values render raw (as tracker boards do). The built-in default
  board keeps today's i18n'd labels. New UI strings (settings drawer, errors) ship EN+ES per the
  parity gate.
- **SSE** (`streams.js`): the kanban tick already sends `{id, status}` rows and the client diffs;
  it gains the def's status list so column membership changes render without a reload.

### Phase B — tracker convergence (same spec, second PR)

Migration `0003-tracker-convergence` moves the 3 `tracker_defs` rows into `board_defs`
(`slug` boards; `columns_json`→`fields_json` with `storage:'data'`, `status_values` verbatim,
`terminal_values` seeded deterministically to `['done']` where the board's list contains it, else
empty — adjustable afterwards in the board settings drawer) and the 18 `tracker_items` into `tasks_items`
(`label`→`title`, `data_json`→`data_json`, `bot_id`/lease columns carried onto `tasks_items` as
plain columns added in this migration; the advisory FK to `pi_bot_defs` is dropped by crossing
files, which it already effectively was). Then, in the same PR:
`renderCustomTracker` folds into the one config-driven renderer; the API's `tracker*` endpoints
re-point at the unified store (paths kept, so the client and any callers keep working);
`pm-workspace`'s Monday sync, `scripts/pi-bots/tracker.mjs`, and the PIR scripts
(`scripts/bots/sync_pir_responses.mjs`, `dispatch_pir_processor.mjs`, bench) re-point their SQL.
crow.db's `tracker_defs`/`tracker_items` are dropped by `0003` after copy (they are not in
init-db, so the A3 init-db guard is not in play; the registry migration's own test carries the
proof of copy-before-drop).

**Ops step (r4, logged):** the out-of-repo `r4-trackers` stdio server (bots-sql-mcp) targets
crow.db's tracker tables and will break at Phase B deploy. Its installed copy gets a hand edit on
r4 to target the unified store — logged in the ops log as product debt that Track 1's
gateway-served verbs retire properly.

Phase B ships only after Phase A has been deployed and observed on r4.

## What must not happen (restated from the scope doc, still binding)

- The 143 cards keep their titles, descriptions, tags, priorities, due dates, owners, projects,
  statuses, and phase values, bit-for-bit. The rebuild is verified by the migration test asserting
  row counts and per-column equality on an r4-shaped seed.
- "No more tasks" remains a statement about the bot-facing tool surface, not the data. Nothing in
  Track 0 deletes the store, the bundle, or the second door.
- No `SCHEMA_GENERATION` bump. Nothing in Track 0 touches init-db.
- The Funnel/network-exposure invariant is untouched.

## Out of scope (Track 0)

The `file:` URI bug fix (own PR; Phase A removes two of its three call sites but does not fix
`cardsDbForBot`); `r4-assistant`'s stale tool list (live-instance ops); plans table, per-card
autonomy, `plan_ref` removal, and the `board_*` tool surface (Track 1); the stdio-mounted-server
sync-emitter defect (`servers/memory/server.js:100` emits only `if (syncManager)` — same defect
family, but memory-sync subsystem; it gets its own spec in this arc, sequenced beside Track 1,
and the fix must be general to any stdio-mounted server); design tokens, Perch ownership flip,
and all repaint work (Track 2); the roost / board×Perch merge (Track 3).

## Known limits accepted in Phase A (reviewed, reasoned, deferred)

The whole-branch review confirmed these and they are deliberately NOT fixed here:

- **A bot-written `in_progress` survives a dead worker as data, not as a lock.** The job going
  terminal releases the lock and logs loudly ("card N is unlocked — if it reads in_progress,
  nothing is working it"); recovery is re-dispatch or a human move. Machinery un-writing a
  bot-written status is the inversion PR #277's v1 was reverted for; Track 1's result/approval
  model owns the real answer.
- **Declared `data`-storage fields render but have no card-level value editor yet.** The settings
  drawer defines them and card faces display them; values arrive today via the API's edit
  endpoint or Phase B's tracker convergence (whose items carry data_json natively). The card
  drawer grows per-field inputs in Phase B, where both card kinds share one drawer.
- **The `board-config` SSE frame is emitted once at stream open** — an already-open second
  browser learns of a def edit on reconnect or next reload, by design (the frame exists to catch
  drift, not to live-sync config).
- **Re-saving a builtin board's settings makes it a configured board** (`builtin` false, raw
  labels instead of the i18n'd four). Opening the settings drawer and saving IS opting into
  configuration; the fallback def exists for boards nobody configured.
- **`boardVocab` (the bridge's per-board vocabulary read) resolves `board_defs` from the store it
  is handed.** For the live fleet that is the instance-global tasks.db; a hypothetical divergent
  per-project store without its own defs falls back to the legacy vocabulary — conservative, and
  moot until Phase B unifies store topology.

## Testing and rollout

- Migration tests for `0002`: legacy-shaped db (CHECK + stage + r4-shaped rows incl. phase) →
  rebuilt with data equality; idempotent re-run; fresh-db no-op; bundle-created-after-migration
  convergence at next run. Same rigor for `0003` in Phase B (copy-before-drop proof).
- Render/validation tests: per-board columns, custom-status move accepted, off-list move rejected,
  terminal stamping, default-board fallback byte-compatible with today.
- Dispatch tests: execute enqueues without writing the card; a job going terminal releases the
  lock with no card write; gating (locked / terminal / no assigned_bot) 409s/400s.
- Every new test is mutation-tested per doctrine. Suite floor: **3118 / 0** on `f28c427f`; the
  stage-machinery tests being retired are replaced by at least as much coverage of the new gating.
- CI: `suite` / `static-checks` / `audit` green via `/commits/<sha>/check-runs` before merge;
  `enforce_admins` is on. No new ports (nothing for `check-ports`).
- Deploy: r4-deploy after merge, `--dry-run` first. Phase A touches `scripts/pi-bots/`
  (bridge.mjs reconcile removal, job_runner un-strand removal) — the pibot-gateways soak runs from
  `~/crow` through ~2026-08-12, so the `~/crow` pull + unit restart is logged in
  `~/crow-soak-log.md` and bridge.mjs's exported names stay stable.
