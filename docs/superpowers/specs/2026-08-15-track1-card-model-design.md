# Track 1 — the card model

Design spec under the scope document `specs/2026-08-08-board-truth-and-visual-language-scope.md`
(Gitea `kh0pp/crow-engineering`, branch `docs/board-truth-and-visual-language-scope`) and the Track 0
spec `2026-08-11-track0-board-configurable-design.md`. Track 0 (Phases A + B) is deployed and
soaked; this spec covers **Track 1**: plans as records, the gateway `board_*` verb surface with
provenance, per-card autonomy and the result/approval model, card archiving, `plan_ref`/`planCard`
retirement, and the remaining merged-id-space guards.

Everything below was re-verified 2026-08-15 against `origin/main` `411692ac` and copies (never the
live files) of r4's `tasks.db` and `crow.db`. Suite floor at that sha: **3176 pass / 0 fail**.

---

## Live state, re-verified (the numbers keep moving — always re-check)

- **194 `tasks_items` rows** (ids 1–194): 176 cards (`board_id IS NULL`; 66 pending /
  33 in_progress / 74 done / 3 cancelled) + 18 migrated tracker items on 2 of the 3 slug boards
  (`toolkit-assets` 10 × drafted, `monday-team-mirror` 8 × working, `comms-log` 0).
- **4 `board_defs`**: project board "R4 TEHCY" (project_id 1) + 3 slug boards.
- **`pm_sync_state`: 153 kanban + 8 tracker rows**, all `local_id` → `tasks_items` ids.
  Monday board 18422517679 two-way sync is live and Kevin uses it daily.
- **77 done/cancelled cards** — the archive backlog that motivated Kevin's 2026-08-12 request.
- **`kevin-gated` tag on 14 cards** — the hand-rolled autonomy convention (scope doc Finding 1).
- **`plan_ref` NULL on all 194 rows** (and historically on all rows fleet-wide);
  `assigned_bot` non-null on 1; `data_json` == `'{}'` on every card.
- **Migrations 0001–0003 applied** (bookkeeping in crow.db `schema_migrations`); tasks.db tables:
  `tasks_items`, `tasks_recurrence`, `tasks_briefings`, `board_defs`.
- **The stdio doors are live**: `~/r4-tehcy/.mcp.json` mounts `r4-tasks` (installed tasks bundle →
  tasks.db direct) and `r4-trackers` (installed bots-sql-mcp → hand-edited 2026-08-12 to point at
  tasks.db, `.bak-pre-0003` beside both files — logged product debt). Allowlisted:
  `tasks_create`, `tasks_update`, `tasks_complete`, `tasks_store_briefing`.
- **The gate pattern is live**: `pm_planned_events` (5 confirmed / 1 rejected;
  `decided_via` chat 2 / dashboard 4) — the shape decision 1.4 reuses.
- **The local MCP token exists** (`servers/gateway/local-token.js`): per-instance static bearer for
  headless MCP clients, built precisely because the OAuth dance is unusable — this is the session
  transport's auth. Fleet MCP OAuth remains broken (metadata advertises Funnel-host endpoints);
  nothing here depends on it.
- **SQLite is 3.53** via the repo's better-sqlite3 on node 22 — `ALTER TABLE … DROP COLUMN` is
  available (needs: column not indexed, not in a CHECK/generated/FK — `plan_ref` is none of these).
- **Monday sync reads are by-id** (`sync/monday.js` — `WHERE id = ?` against `tasks_items`,
  keyed from `pm_sync_state.local_id`), which is what makes "present-but-hidden" archiving safe.

## Decisions

### D-T1.1 — One verb surface, served by the gateway, mounted three ways

A new **board MCP server** (`servers/gateway/board-mcp.js`, tools below) is created by the gateway
and mounted at **`/board/mcp`** (Streamable HTTP, same `mountMcpServer` rail as the other core
servers: dashboard-session auth OR the local MCP token). One implementation serves:

1. **Kevin's sessions** — `~/r4-tehcy/.mcp.json` replaces `r4-tasks` + `r4-trackers` with one
   HTTP entry pointing at `http://127.0.0.1:3008/board/mcp` carrying the instance's local token.
   This retires both stdio doors and the bots-sql-mcp hand-edit. **Hard requirement (Kevin,
   verbatim): this changes plumbing only — full card-editing capability from sessions and the
   dashboard is preserved.** The capability floor is the current allowlist: create, update,
   complete/move, list/get, **and briefings** (`tasks_store_briefing` has a `board_*` equivalent;
   `tasks_briefings` stays where it is).
2. **The dashboard** — the existing `bot-board-api.js` routes and the MCP tools converge on a
   shared service module (D-T1.2); the routes keep their paths and payload shapes (the frozen
   panel client keeps working unchanged except where this spec says otherwise).
3. **Bots** — per decision 10 bots get the full verb set. A bot's generated MCP config gains the
   same HTTP entry (local token + actor headers, D-T1.3). No new bespoke bot rail: pi mounts MCP
   servers from config already.

The **installed tasks bundle and bots-sql-mcp files stay on disk untouched** ("no more tasks" is
about the tool surface, not the data or the bundles). Only the `.mcp.json` entries retire — an
**ops step on r4, executed with Kevin** (his live sessions hold the stdio servers; the swap is
logged, and timing is his call).

Verb set (names final, `board_` prefix):

| verb | maps to | notes |
|---|---|---|
| `board_list_boards` | defs + counts | slug + project boards |
| `board_list_items` | list w/ filters | status/tag/search/board; excludes archived unless `include_archived` |
| `board_get_item` | card or item by id | includes plan head + latest result + mutation trail summary |
| `board_create_item` | create | board-aware (project board or slug board); def-validated status |
| `board_update_item` | edit fields | def-validated; declared fields via data_json/phase |
| `board_move_item` | status move | def-validated, terminal stamping — same semantics as the route |
| `board_archive_item` / `board_unarchive_item` | D-T1.6 | refuses a locked card |
| `board_get_plan` / `board_save_plan` / `board_approve_plan` | D-T1.4 | save creates a new version |
| `board_report_result` | D-T1.5 | the bot's explicit outcome signal |
| `board_decide_result` | D-T1.5 | approve/reject a gated result (operator/session) |
| `board_store_briefing` | tasks_briefings insert | capability parity with `tasks_store_briefing` |

Deliberately absent: delete (archive is the product answer), force-unlock and dispatch/execute
(operator affordances; they stay dashboard-only routes), def editing (stays in the Configure
drawer).

### D-T1.2 — A shared service layer, one file per concern

The board-defs.js lesson (one predicate, one file) applied to mutations:
`servers/gateway/board/` gains `card-service.js` (create/update/move/archive + validation +
mutation recording), `plan-service.js`, `result-service.js`. `bot-board-api.js` routes and
`board-mcp.js` tools are thin callers. The service functions take an explicit `actor` (D-T1.3) and
the db handles; they are the ONLY writers of `tasks_items` inside the gateway. (The Monday sync's
writes stay in pm-workspace — it is an installed bundle with its own rail; its provenance is
`pm_sync_log`, which already exists.)

### D-T1.3 — Provenance: `board_mutations`, actor = human / session / bot-id

Per decisions 10 + 13: full verbs, every write recorded, no database identity for the orchestrator.

```sql
CREATE TABLE board_mutations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,             -- no FK: mutations OUTLIVE nothing (items never delete), but archives keep ids anyway
  verb TEXT NOT NULL,                   -- 'create'|'update'|'move'|'archive'|'unarchive'|'plan_save'|'plan_approve'|'result_report'|'result_decide'
  actor_kind TEXT NOT NULL CHECK(actor_kind IN ('human','session','bot')),
  actor_id TEXT,                        -- bot_id for bots; NULL for human; optional label for sessions
  job_id TEXT,                          -- bot_jobs linkage when dispatched
  detail_json TEXT NOT NULL DEFAULT '{}', -- changed fields: {field: [old, new]} — a diff, not a snapshot
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_board_mutations_item ON board_mutations(item_id, id);
```

Actor resolution: dashboard-session callers → `human`; local-token MCP callers → `session` unless
the request carries `X-Crow-Actor-Kind: bot` + `X-Crow-Actor-Id`/`X-Crow-Job-Id` (set in the bot's
generated MCP config). The headers are honored only on locally-token-authenticated requests. This
is a **record, not a security boundary** — decision 10 is explicit that provenance, not
restriction, is the goal; everything behind the token is already trusted with full verbs.

The card drawer gains a read-only "history" strip (latest mutations, actor-attributed). EN+ES.

### D-T1.4 — Plans become records (and the file rail retires)

```sql
CREATE TABLE board_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  version INTEGER NOT NULL,             -- 1..n per item; UNIQUE(item_id, version)
  body_md TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','superseded')),
  created_actor_kind TEXT NOT NULL, created_actor_id TEXT,
  decided_at TEXT, decided_via TEXT,    -- pm_planned_events vocabulary
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(item_id, version)
);
```

- `board_save_plan` appends version n+1 as `draft` (no in-place edits — versioning IS the record);
  approving marks it `approved` and the previously-approved version `superseded`, in one
  transaction. The card's "current plan" is **derived** (latest approved, else latest draft) — no
  pointer column; `plan_ref` is not replaced, it is retired (D-T1.7).
- The card drawer's Plan tab re-points from the file rail (GET/POST `/card/:id/plan` +
  mtime concurrency) to plan records (list versions, view, save-as-new-version, approve).
  The route paths stay; their payloads change from `{markdown, mtime}` to
  `{versions, body_md, version, status}` — the drawer is server-emitted, so both sides move in
  the same PR (no external consumer: verified, the only caller is the panel client).
- "Ready for a bot" stays derived; `execute` gains nothing here (an approved plan is NOT made a
  dispatch precondition — today's operator-click-is-intent gate survives; a plan-required gate is
  a per-card future knob, YAGNI now).

### D-T1.5 — Per-card autonomy + results follow `pm_planned_events`

`tasks_items.autonomy TEXT NOT NULL DEFAULT 'gated' CHECK(autonomy IN ('gated','auto'))`, seeded
`gated` everywhere (matching today's de-facto behavior), and the 14 `kevin-gated` tags noted in the
migration log (the tag keeps working as a visual; the column is the machine truth now). The card
drawer + create form expose it (EN+ES).

```sql
CREATE TABLE board_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  plan_id INTEGER,                      -- the plan version worked, when known
  job_id TEXT,
  actor_kind TEXT NOT NULL, actor_id TEXT,
  outcome TEXT NOT NULL CHECK(outcome IN ('success','failure','partial')),
  summary_md TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'recorded' CHECK(status IN ('recorded','approved','rejected')),
  decided_at TEXT, decided_via TEXT,    -- 'chat'|'dashboard'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Terminal-state model (scope §1.4, the PR-#277 lesson made structural):

- A bot finishing work calls `board_report_result` — an **explicit tool call with an outcome**,
  never inferred from a process exit. Job-terminal still only releases the lock (Track 0 shape).
- On `outcome='success'`: if the card's `autonomy='auto'`, the service moves the card to `done`
  **iff the board's def has `done` among its terminal values** (the `cancel` precedent), records
  the move as the bot's mutation, and marks the result `approved` with `decided_via='auto'`.
  Otherwise (gated, or no `done`): the result stays `recorded`, the card does not move, and the
  board shows an "awaiting review" affordance on the card face.
- `board_decide_result` approves/rejects a recorded result (`decided_via` 'chat' from MCP,
  'dashboard' from the drawer button). Approving does NOT auto-move a gated card — the operator
  moves it (or clicks "approve & mark done", one affordance, two writes, both recorded).
- Failures/partials always just record; nothing moves.

### D-T1.6 — Archiving: present-but-hidden, ids immortal (Kevin, 2026-08-12)

`tasks_items.archived_at TEXT` (NULL = live). One mechanism for both card and tracker items,
board-aware. Invariants:

- **Ids survive forever** — archive is an UPDATE; nothing ever deletes rows, so
  `pm_sync_state.local_id` can never dangle (the F4/stale-row lesson).
- **Default views exclude archived**: panel kanban + list render, `GET /cards`-family list
  endpoints, `board_list_items`, the SSE kanban tick's row set, column counts, and the
  pm-workspace digest adapters all gain `archived_at IS NULL`. An `include_archived`/"Show
  archived" toggle (panel filter bar + verb param) is the only way to see them. **Every filter
  site is enumerated in the plan and each gets a test** — a missed site is either a ghost card or
  an SSE reload-loop (the Phase-A off-def lesson).
- **Monday sync treats archived as present**: by-id reads (mirror update, twoway pull-target)
  intentionally do NOT filter, so a pull that targets an archived row updates it in place and
  never re-INSERTs (the id is found ⇒ no insert path). Any scan-based local→remote push skips
  archived rows (an archived card is not a change to publish). The plan enumerates
  `sync/monday.js`'s scan sites; the migration test seeds an archived+synced row and proves a
  pull round-trip neither duplicates nor resurrects it.
- **Guards**: archiving a locked card → 409; unarchive restores exactly (only `archived_at`
  flips). Archived cards refuse `move`/`execute`/`update` with a clear 409 ("unarchive first") —
  a frozen row is what makes the audit trail trustworthy.
- **UI**: card-face/drawer "Archive" action, an "Archived" view behind the toggle with
  per-card "Unarchive". No bulk "archive all done" in v1 (YAGNI — revisit when Kevin asks; the
  77-card backlog is a one-time session task via the verb).

### D-T1.7 — `plan_ref` + `planCard` retire; the column drops inside 0004

Per decisions 12/16: `plan_ref` reads/writes are removed in code (`plan-ref.js` route module
deleted; `resolveCardPlan`/`containedRealPath` file rail deleted with it; drawer re-pointed per
D-T1.4), `bridge.planCard` + `recordPlanRef` + job_runner's `action='plan'` path + the
`/card/:id/plan-dispatch` route and its drawer button are deleted (the orchestrator writes plans
now — interactively, via `board_save_plan`), and `ALTER TABLE tasks_items DROP COLUMN plan_ref` is
the last statement of migration 0004 — **not** a standalone bump, **not** a follow-up ticket.
`bridge.mjs`'s export surface changes (two exports removed): the r4 soak window ended 2026-08-12,
but the restart of `pibot-gateways@r4` at deploy is still logged in the soak log, and
`job_runner.mjs` (the in-repo consumer) is updated in the same PR. The scope doc's `file:`-URI bug
loses another call site with `planCard`; `cardsDbForBot` itself (used by the custom-tracker turn
context) remains out of scope with its own PR, as before.

### D-T1.8 — The merged-id-space guards complete

The Phase B parking ruling is executed: `/card/:id/plan*` (as re-pointed), `/card/:id/project`,
`/card/:id/execute`, `/card/:id/force-unlock`, and the panel's no-JS move POST all gain the
`board_id IS NULL` predicate (tracker-item ids 400 instead of acting on a card-shaped read), and
the new service layer centralizes the predicate so future endpoints can't forget it: the service's
card lookups are `WHERE id=? AND board_id IS NULL`, item lookups `WHERE id=? AND board_id IS NOT
NULL`, and nothing else reads by bare id.

### D-T1.9 — What does not change

Dispatch/execute lock rails and gating (Track 0 shape); `board_defs` and the Configure drawer;
the def envelope contract (status_values/columns_json as JSON **strings**; items expose `title AS
label`); Monday sync mapping semantics; the tasks/bots-sql-mcp bundle files on disk; tracker-item
API paths; the Funnel/network-exposure invariant (untouched); `SCHEMA_GENERATION` (untouched —
0004 is a registry migration on tasks.db only).

## Migration `0004-track1-card-model` (registry rail)

Order inside one migration, tasks.db side then nothing on crow.db:

1. `CREATE TABLE board_plans / board_results / board_mutations` (+ indexes).
2. `ALTER TABLE tasks_items ADD COLUMN autonomy TEXT NOT NULL DEFAULT 'gated'` — SQLite allows a
   non-NULL default on ADD COLUMN; a CHECK cannot be added by ALTER, so `autonomy` validation is
   service-layer only (consistent with `status` post-0002, where the CHECK was deliberately
   dropped).
3. `ALTER TABLE tasks_items ADD COLUMN archived_at TEXT`.
4. Log the count of `kevin-gated`-tagged cards (no data rewrite — the operator flips specific
   cards to `auto` deliberately, per card, later).
5. `ALTER TABLE tasks_items DROP COLUMN plan_ref` (verified: no index, no CHECK, no FK, no view).
6. Idempotence: guarded by column/table existence probes (0002/0003 pattern); re-run converges.
   Sidecar backup `tasks.db.bak-0004-<utc>` before step 1.

`tests/migration-registry.test.js`'s converged-shape case extends to 0004 (as 0002 and 0003 did);
fixtures pre-seed `schema_migrations` with 0001–0003 (the markPhaseADone pattern) or the earlier
migrations re-run and crash. grackle/black-swan: empty/absent stores ⇒ ADD COLUMNs no-op or apply
to empty tables at next routine deploy — no fleet ops step.

## Testing and rollout

- TDD per task; every new test mutation-tested (restore by Edit, never git checkout). Suite floor
  **3176/0**; concurrent-suite validation (3×3) before the PR per the flake-hunt doctrine.
- New-surface tests: verb-by-verb MCP tests over the HTTP mount (auth: session cookie, local
  token, actor headers); service-layer unit tests (validation, provenance rows, autonomy paths,
  archive guards); migration 0004 tests incl. the archived+synced Monday round-trip; SSE tests
  parse frames by event name; panel client parse test in both board modes (the '\n' lesson —
  double-escaped escapes, no backticks); EN+ES parity gate for every new string.
- CI: `suite`/`static-checks`/`audit` green via `/commits/<sha>/check-runs`; `enforce_admins` on;
  no new ports (`/board/mcp` rides the gateway's existing port — nothing for check-ports).
- Deploy (r4, after merge): fuser check for stdio holders of tasks.db/crow.db, **ask Kevin to
  close tehcy sessions**, pause `pibot-gateways@r4` for the migration window (restart + soak-log),
  `r4-deploy.sh --dry-run` then real, ignore the 1s smoke gate's false FAIL and verify
  `systemctl is-active` + `curl :3008/s/family/` + 0004 journal lines + board renders + a verb
  round-trip over `/board/mcp` with the local token. **The `.mcp.json` swap (retiring
  r4-tasks/r4-trackers) is a separate, Kevin-scheduled ops step** — his sessions restart on his
  clock; until then the stdio doors keep working against the migrated store (they never touched
  `plan_ref`), so there is no forced-upgrade window.
- The 77-card archive backlog: after deploy + Kevin's nod, archive the done/cancelled backlog via
  the verb in one logged session pass (not in the migration — data policy is an operator action,
  not schema).

## Out of scope

The stdio-sync-emitter general fix (own spec, sequenced beside this — `servers/memory/server.js`
emits only `if (syncManager)`, null on every stdio mount; the fix must cover ANY stdio-mounted
server); the `cardsDbForBot` `file:`-URI bug (own PR, unchanged); Track 2 (visual language — Perch
CSS ownership flip first) and Track 3; the models-manager resume flake; MCP OAuth; any Funnel
exposure change (needs Kevin's named approval); bulk-archive UI; a plan-required execute gate.
