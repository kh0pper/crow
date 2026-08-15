# Track 1 — the card model

Design spec under the scope document `specs/2026-08-08-board-truth-and-visual-language-scope.md`
(Gitea `kh0pp/crow-engineering`, branch `docs/board-truth-and-visual-language-scope`) and the Track 0
spec `2026-08-11-track0-board-configurable-design.md`. Track 0 (Phases A + B) is deployed and
soaked; this spec covers **Track 1**: plans as records, the gateway `board_*` verb surface with
provenance, per-card autonomy and the result/approval model, card archiving, `plan_ref`/`planCard`
retirement, and the remaining merged-id-space guards.

Everything below was re-verified 2026-08-15 against `origin/main` `411692ac` and copies (never the
live files) of r4's `tasks.db` and `crow.db`. Suite floor at that sha: **3176 pass / 0 fail**.
This revision incorporates the two adversarial review rounds' findings (review record at the end).

---

## Live state, re-verified (the numbers keep moving — always re-check)

- **194 `tasks_items` rows** (ids 1–194): 176 cards (`board_id IS NULL`; 66 pending /
  33 in_progress / 74 done / 3 cancelled) + 18 migrated tracker items on 2 of the 3 slug boards
  (`toolkit-assets` 10 × drafted, `monday-team-mirror` 8 × working, `comms-log` 0).
- **4 `board_defs`**: project board "R4 TEHCY" (project_id 1) + 3 slug boards.
- **`pm_sync_state`: 153 kanban + 8 tracker rows**, all `local_id` → `tasks_items` ids.
  Monday board 18422517679 two-way sync is live and Kevin uses it daily.
- **77 done/cancelled cards** — the archive backlog behind Kevin's 2026-08-12 request.
  **69 of the 77 are Monday-mapped kanban rows** (verified by join across the db copies) — the
  backlog archive is therefore a two-sided operation (D-T1.6 rollout note).
- **`kevin-gated` tag on 14 cards** — the hand-rolled autonomy convention (scope doc Finding 1).
- **`plan_ref` NULL on all 194 rows**; `assigned_bot` non-null on 1; `data_json` `'{}'` on every
  card; **0 `tasks_recurrence` rows and 0 cards with `recurrence_id`** (recurrence is dormant).
- **Migrations 0001–0003 applied** (bookkeeping in crow.db `schema_migrations`).
- **The stdio doors**: `~/r4-tehcy/.mcp.json` mounts `r4-tasks` (installed tasks bundle →
  tasks.db) and `r4-trackers` (installed bots-sql-mcp, hand-edited 2026-08-12). **bots-sql-mcp is
  ~22 tools and only 5 are tracker tools** — the rest (PIR pipeline, job-search, bot
  conversations, notes, preferences) run against crow.db, are in active use, and are NOT board
  surface. Session allowlist today: `tasks_create/update/complete/store_briefing`.
  `tasks_delete` exists in the bundle but is **not allowlisted** (permission-prompt-gated).
- **The gate pattern is live**: `pm_planned_events` (5 confirmed / 1 rejected;
  `decided_via` chat 2 / dashboard 4).
- **The local MCP token rail exists but r4 carries no token yet** (`mcp_local_token_hash` absent
  from r4's settings — verified on a copy). Generation is a one-time-reveal flow in the Connect
  panel (`dashboard/panels/connect.js:172`). MCP auth chain is instance-auth → local token →
  OAuth bearer (`routes/mcp.js:225–263`); **no MCP mount accepts dashboard-session cookies**.
- **SQLite 3.53** via the repo's better-sqlite3 on node 22 — `DROP COLUMN` available; `plan_ref`
  has no index/view/trigger/CHECK (verified on the r4 copy).
- **Monday sync reads are by-id** (`sync/monday.js` `WHERE id = ?` from `pm_sync_state.local_id`);
  the pushed row shape (`kanbanRowShape`, monday.js:168–175) never includes `archived_at`.
- **The dispatch prompt instructs bots to move cards** (`bridge.mjs:672–679`: "set this card
  in_progress, then done") and `planForCard` (`bridge.mjs:505–540`) splices the plan **file**
  into every execute prompt; `bridge.mjs:43` statically imports from `routes/plan-ref.js`.

## Decisions

### D-T1.1 — One verb surface, served by the gateway, mounted three ways

A new **board MCP server** (`servers/gateway/board-mcp.js`, tools below) is created by the gateway
and mounted at **`/board/mcp`** on the same `mountMcpServer` rail as the other core servers.
**Auth is token-only** (the rail's local-token leg; there is no cookie leg and none is added —
the dashboard never talks to the MCP mount, it has the HTTP routes). One implementation serves:

1. **Kevin's sessions** — `~/r4-tehcy/.mcp.json` replaces **`r4-tasks`** with one HTTP entry at
   `http://127.0.0.1:3008/board/mcp` carrying the instance's **local MCP token** (bootstrap: r4
   has no token yet — generating one via the Connect panel's one-time reveal is a named rollout
   step, done with Kevin). **`r4-trackers` (bots-sql-mcp) is NOT retired** — 17 of its ~22 tools
   are live non-board surface (PIR, job-search, conversations). What retires there is the
   **tracker subset**: the 5 `tracker_*` tools leave the session allowlist at the swap, and a
   logged ops step strips the hand-edited tracker block from the installed copy — closing the
   Phase B hand-edit debt without touching the other tools. **Hard requirement (Kevin, verbatim):
   plumbing only — full card-editing capability from sessions and the dashboard is preserved.**
2. **The dashboard** — `bot-board-api.js` routes and the MCP tools converge on the shared service
   layer (D-T1.2); routes keep paths and payload shapes except where this spec names a change.
3. **Bots** — per decision 10 bots get the full verb set. A bot's generated MCP config
   (`mcp_writer.mjs`, which already supports headers) gains the same HTTP entry carrying a
   **board token**: a second per-instance static token, same storage/validation pattern as the
   local token but **path-scoped to the `/board/*` MCP transport paths** (the mount registers
   `/board/mcp`, `/board/sse`, `/board/messages` — scoping to `/board/mcp` alone would 401
   SSE-transport clients). Rationale: the local token is
   deliberately full-surface, and embedding IT in every bot config would widen each bot's reach
   to the entire gateway MCP surface and put full-surface raw tokens in bot session dirs; the
   board token bounds the blast radius to exactly the verbs decision 10 grants. **Raw-token
   residence** (the config writer runs in the bridge process, deliberately db-agnostic, and the
   settings registry holds only the hash): the gateway mints at boot when absent, stores the
   hash in the local-scope settings registry, and persists the raw at `<crowHome>/board-token`
   mode 0600 — the exact `peer-tokens.json` precedent `mcp_writer.mjs` already reads beside it.
   `crow-server-catalog.mjs` (today stdio-blocks only) emits its first `{url, headers}` block
   for the board entry; pi's mcp-client supports url+headers natively. That raw copies land in
   bot config files is accepted and named here.

The **installed tasks bundle and bots-sql-mcp files stay on disk untouched**. Only `.mcp.json`
entries/allowlists change — an **ops step on r4, executed with Kevin** in the same deploy
conversation (D-T1.9 bounds the window).

Verb set (names final, `board_` prefix):

| verb | maps to | notes |
|---|---|---|
| `board_list_boards` | defs + counts | slug + project boards |
| `board_list_items` | list w/ filters | status/tag/search/board; excludes archived unless `include_archived` |
| `board_get_item` | card or item by id | includes current plan head, latest results (with plan version + superseded flag), recent mutations |
| `board_create_item` | create | board-aware; def-validated status; `parent_id` supported — validated to exist, and the child inherits the parent's project/board (the `tasks_add_subtask` semantics, not a bare column write) |
| `board_update_item` | edit fields | def-validated; declared fields via data_json/phase; `parent_id` supported |
| `board_move_item` | status move | def-validated, terminal stamping — the route's semantics |
| `board_archive_item` / `board_unarchive_item` | D-T1.6 | refuses a locked card |
| `board_get_plan` / `board_save_plan` / `board_approve_plan` | D-T1.4 | save creates a new version |
| `board_report_result` | D-T1.5 | the bot's explicit outcome signal |
| `board_decide_result` | D-T1.5 | approve/reject a recorded result |
| `board_store_briefing` / `board_list_briefings` / `board_get_briefing` / `board_briefing_snapshot` | tasks_briefings | full parity with the tasks bundle's briefing tools (snapshot computes without storing, exactly like `tasks_briefing_snapshot`) |

Deliberately absent, each named for Kevin's sign-off at the swap:
- **delete** — archive is the product answer (`tasks_delete` was never allowlisted anyway);
- **recurrence** — `tasks_set_recurrence`, create-time recurrence params, and complete's
  roll-forward are **knowingly dropped from the verb surface** (0 live rows, 0 cards with
  `recurrence_id`; the bundle stays on disk as the fallback if recurrence is ever wanted);
- **force-unlock / execute / def editing** — operator affordances, dashboard-only.

### D-T1.2 — A shared service layer, one file per concern

The board-defs.js lesson (one predicate, one file) applied to mutations:
`servers/gateway/board/` gains `card-service.js` (create/update/move/archive + validation +
mutation recording), `plan-service.js`, `result-service.js`. Converging callers — after this
spec, the ONLY `tasks_items` writers in the gateway:

- `bot-board-api.js` routes (thin callers),
- `board-mcp.js` tools (thin callers),
- **`panels/bot-board/api-handlers.js`** — its direct writes (no-JS move UPDATE at :49, tracker
  status/lease UPDATE at :90) convert to service calls; left unconverged they would bypass
  provenance and the archive/autonomy guards.

The Monday sync's writes stay in pm-workspace (installed bundle, own rail, `pm_sync_log`
provenance — with the D-T1.6 additions).

### D-T1.3 — Provenance: `board_mutations`, actor = human / session / bot-id

Per decisions 10 + 13: full verbs, every write recorded, no database identity for the orchestrator.

```sql
CREATE TABLE board_mutations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  verb TEXT NOT NULL,                   -- 'create'|'update'|'move'|'archive'|'unarchive'|'plan_save'|'plan_approve'|'result_report'|'result_decide'
  actor_kind TEXT NOT NULL CHECK(actor_kind IN ('human','session','bot')),
  actor_id TEXT,                        -- bot_id for bots; NULL for human; optional label for sessions
  job_id TEXT,                          -- bot_jobs linkage when dispatched
  detail_json TEXT NOT NULL DEFAULT '{}', -- changed fields: {field: [old, new]} — a diff, not a snapshot
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_board_mutations_item ON board_mutations(item_id, id);
```

Actor resolution: dashboard-route callers → `human` (verified: no server-side automation calls
the dashboard board routes today); token-authenticated MCP callers → `session` unless the request
carries `X-Crow-Actor-Kind: bot` + `X-Crow-Actor-Id`/`X-Crow-Job-Id` (set in the bot's generated
config). Header transport: the MCP SDK (1.27.1) passes `requestInfo` (headers) through to tool
handlers (`shared/protocol.js:351` — verified); if a handler-side gap appears in practice, the
fallback is enriching `req.auth` in the mount middleware. Headers are honored only on
token-authenticated requests. This is a **record, not a security boundary** — decision 10 is
explicit that provenance, not restriction, is the goal.

The card drawer gains a read-only "history" strip (latest mutations, actor-attributed). EN+ES.

### D-T1.4 — Plans become records (and the file rail retires)

**Store topology (round-2 critical): `board_plans`, `board_results`, and `board_mutations` are
instance-global-only** — created in the instance tasks.db and nowhere else (the Phase B F1
precedent: slug boards are instance-global only, and `customTrackerContext` already pins the
instance-global store). The bridge's `planForCard` resolves the instance-global store
**freshly** (never `world.tasksDbPath`, which follows `project_spaces.tasks_db_uri`), because
gateway verbs only address instance-global cards — a per-project row id sent to
`board_report_result` would otherwise attach a result to whatever instance-global card shares
the id: the merged-id-space bug reborn. Named rule for the hypothetical bot whose
`cardsDbForBot` resolves to a genuinely divergent per-project store: the plan/result surface is
absent for its cards (prompt carries no plan; `report_result` on an id the instance-global
store doesn't hold 404s) — logged, not silently wrong. On live r4 the sole project's
`tasks_db_uri` points at the instance-global file, so this rule bites nothing today.

```sql
CREATE TABLE board_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  version INTEGER NOT NULL,             -- 1..n per item
  body_md TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','superseded')),
  created_actor_kind TEXT NOT NULL, created_actor_id TEXT,
  decided_at TEXT, decided_via TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(item_id, version)
);
```

- `board_save_plan` appends version n+1 as `draft`; approving marks it `approved` and the
  previously-approved version `superseded`, one transaction. "Current plan" is **derived**
  (latest approved, else latest draft) — no pointer column.
- The card drawer's Plan tab re-points from the file rail to plan records (list versions, view,
  save-as-new-version, approve). Route paths stay; payloads change from `{markdown, mtime}` to
  `{versions, body_md, version, status}` — the only non-test caller is the panel client
  (client.js:89, :265; verified), which moves in the same PR.
- **The dispatch prompt reads the record**: `bridge.mjs`'s `planForCard` re-points from the plan
  file to the card's current `board_plans` record — read from the **instance-global store,
  resolved freshly** (see the store-topology rule above; NOT `world.tasksDbPath`) — and the
  execute prompt (D-T1.5) carries it. Without this the whole loop is dead — a card with an
  approved plan would dispatch with "(plan file missing)".
- "Ready for a bot" stays derived; an approved plan is NOT a dispatch precondition (the
  operator's click is the intent; a plan-required gate is a future per-card knob, YAGNI).

### D-T1.5 — Per-card autonomy + results follow `pm_planned_events`

`tasks_items.autonomy TEXT NOT NULL DEFAULT 'gated' CHECK-free` (service-validated
`'gated'|'auto'`, consistent with post-0002 status), seeded `gated` everywhere; the 14
`kevin-gated` tags are noted in the migration log (the tag stays as a visual; the column is the
machine truth). Drawer + create form expose it (EN+ES).

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
  decided_at TEXT, decided_via TEXT,    -- 'chat'|'dashboard'|'auto'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Terminal-state model (scope §1.4, the PR-#277 lesson made structural):

- A bot finishing work calls `board_report_result` — an **explicit tool call with an outcome**,
  never inferred from a process exit. Job-terminal still only releases the lock (Track 0 shape).
- **Guards**: `board_report_result` 409s on a terminal-status or archived card. This also makes
  the auto path replay-proof: after an auto-move the card is terminal, so a duplicate "success"
  409s instead of re-approving. Multiple results over a card's life (re-runs) are legitimate;
  each is decided independently, and `board_get_item`/decide surface each result's plan version
  plus a superseded marker (an approved-plan version that was superseded mid-run is visible at
  decide time, not silent).
- **The result↔lock contract** (the piece v1 of this spec missed; plumbing made concrete in
  round 2): a bot reports mid-turn, while its own session/job lock is live. The service's
  auto-move is **exempt from the reporting actor's own lock** — matched on the **job rail by
  `job_id`** and on the **session rail by `actor_id === bot_id`** (which requires two plumbing
  edits this spec now names: `sessionRowFor`'s SELECT gains `bot_id` — today it returns only
  id/status/dir/age — and `job_runner.runCardExecute` passes `job.job_id` into `handleInbound`
  → `buildBotWorld` → `writeBotMcp` headers, so `X-Crow-Job-Id` is actually settable on the
  per-turn config rewrite; without the session-rail match, a chat-driven "do card 5" turn holds
  a lock no job-id exemption can ever match). And on the bridge side, a turn that reported a
  result ends its session **`done`** — not `waiting-user` — so a gated card ends its run
  **unlocked**, awaiting review. **Detection mechanism** (named, race-free): the bridge already
  captures `pi.toolCalls()` at end-of-turn; a non-error `*__board_report_result` call in THIS
  turn's transcript is the signal — no `board_results` query (which would race other actors).
  This requires `board_report_result`'s 409s to surface as MCP `isError` results so a refused
  report is never counted.
- On `outcome='success'`: if `autonomy='auto'` AND the board def has `done` **among its terminal
  values**, the service moves the card to `done` (recorded as the bot's mutation) and marks the
  result `approved` with `decided_via='auto'`. Otherwise the result stays `recorded`, the card
  does not move, and the card face shows "awaiting review". Failure/partial results always just
  record — and also get a card-face marker (a failed run must not look identical to
  still-running).
- `board_decide_result` approves/rejects a recorded result (`decided_via` 'chat' from MCP,
  'dashboard' from the drawer). Approving does NOT auto-move a gated card — the operator moves
  it, or uses "approve & mark done" (enabled only when the def has terminal `done`; one
  affordance, two writes, both recorded).
- **The execute prompt is rewritten**: it instructs the bot to work the plan and
  `board_report_result` — it no longer says "set this card in_progress, then done"
  (bridge.mjs:672–679 today). Bots CAN still `board_move_item` (decision 10: full verbs,
  provenance, no restriction) — the #277 guard is the model and the prompt, not a permission,
  and a bot-initiated move is a recorded, attributed act. Named decision.

### D-T1.6 — Archiving: present-but-hidden, ids immortal (Kevin, 2026-08-12)

`tasks_items.archived_at TEXT` (NULL = live). One mechanism for both card and tracker items.
Invariants:

- **Ids survive forever** — archive is an UPDATE; the gateway surface never deletes rows, so
  `pm_sync_state.local_id` cannot dangle. (During the cutover window the stdio `tasks_delete`
  still exists but is not allowlisted — D-T1.9.)
- **Default views exclude archived.** The enumeration (each site gets a test; a missed site is a
  ghost card or an SSE reload-loop):
  - panel kanban + list render; column counts; the SSE kanban tick's row set (`streams.js`) —
    **plus a client-side removal check** (round-2: the client diff is one-directional; a DOM
    card absent from the frame never triggers anything, so a card archived in another view
    ghosts until manual reload — the client compares the DOM card-id set against the frame's
    and reloads under the existing 10s storm guard);
  - the list/board API endpoints and `board_list_items`;
  - `bot-board-api.js` `/project/:id/unlinked` (:843) and bulk-assign candidates (:879);
  - pm-workspace digest adapters;
  - bot-builder `editor.js` tracker-tab status counts (:551);
  - **the bot turn context**: `scripts/pi-bots/tracker.mjs` `kanbanText` (:33),
    `taskListContext` (:84), `customTrackerContext` (:112) — otherwise every bot prompt still
    carries archived cards, which then 409 when touched.
  - Filters are **column-guarded** (probe for `archived_at` before filtering): `tracker.mjs`
    accepts per-project `tasksDbPath` stores, and a store created by the unowned bundle after
    0004 converges only at next boot — an unguarded filter would crash the bot turn.
  - An `include_archived`/"Show archived" toggle (panel filter bar + verb param) is the only way
    to see archived items; the archived view offers per-card "Unarchive".
- **Monday sync: mapped-archived rows are pull-only.**
  - By-id pull targets intentionally do NOT filter — a pull updating an archived row updates it
    in place (never re-INSERTs) and is logged with a **distinct action `pull_archived_update`**
    so the drift between a hidden local row and a live Monday item is visible, not silent.
  - The `localChanged` push branch (monday.js:534–556) **skips archived rows** — an archived
    card is not a change to publish, including one with a pre-archive unsynced edit (that edit
    stays local; the next pull may overwrite it, logged). The unmapped **create-scan gets the
    same column-guarded `archived_at IS NULL` filter** (round-2 correction: its WHERE today is
    only project/parent/not-cancelled — without the filter, every archived-but-unmapped done
    card would be RE-CREATED on Monday by the next scan, resurrecting the backlog remotely).
  - The migration test seeds an archived+synced row and proves a pull round-trip neither
    duplicates nor resurrects it, and that a local edit does not push.
- **Guards**: archiving a locked card → 409; unarchive flips only `archived_at`. Archived cards
  refuse `move`/`update`/`execute`/`report_result` with a clear 409 ("unarchive first") — frozen
  at the gateway surface. Two named exceptions: the Monday pull (logged,
  `pull_archived_update`) and the stdio cutover window (which bypasses the gateway and
  therefore CANNOT log — it is bounded instead, per D-T1.9).
- **UI**: card-face/drawer "Archive", archived view behind the toggle. No bulk archive in v1.
- **Rollout note**: 69 of the 77 backlog cards are Monday-mapped — the one-time backlog pass is
  two-sided (archive locally via the verb; Kevin archives the same items Monday-side, or accepts
  the logged drift). Operator action, not migration.

### D-T1.7 — `plan_ref` + `planCard` retire; the column drops inside 0004

Per decisions 12/16. The complete retirement list (a missed edit is a 500 after DROP COLUMN):

- `servers/gateway/routes/plan-ref.js` — deleted. **`bridge.mjs:43` statically imports from it**
  — the bridge edit lands in the same task or the pibot units crash-loop at import.
- `bridge.planCard`, `recordPlanRef`, `planForCard`'s file rail (re-pointed to `board_plans`,
  D-T1.4), and `scripts/pi-bots/plan_dispatch.mjs` (orphaned — only consumer is `planCard`).
- job_runner's `card_action === 'plan'` branch; the `/card/:id/plan-dispatch` route (no drawer
  button exists — the only callers are tests). **Deploy step: any queued `card_action='plan'`
  bot_jobs rows are failed/drained with a log line before the new code path goes live.**
- `bot-board-api.js` SELECTs naming `plan_ref`: `GET /card/:id` (:274) and `/card/:id/execute`
  (:716) — both survive Track 1 and must drop the column from their SELECTs. The GET /card
  payload **loses its `plan_ref` key** (client.js never reads it; `tests/board-card-api.test.js:70`
  pins it and is updated).
- `ALTER TABLE tasks_items DROP COLUMN plan_ref` is the last statement of migration 0004 — not a
  standalone bump, not a follow-up ticket.

`bridge.mjs`'s export surface changes (exports removed): the r4 soak window ended 2026-08-12; the
`pibot-gateways@r4` restart at deploy is still soak-logged, and `job_runner.mjs` moves in the
same PR. The scope doc's `file:`-URI bug loses another call site with `planCard`;
`cardsDbForBot` itself stays out of scope with its own PR.

### D-T1.8 — The merged-id-space guards complete

The Phase B parking ruling is executed: the plan routes (as re-pointed), `/card/:id/project`
(:575), `/card/:id/execute` (:716), `/card/:id/force-unlock`, and the panel's no-JS move
(`api-handlers.js:35`) all gain the card predicate, and the service layer centralizes it: card
lookups are `WHERE id=? AND board_id IS NULL`, item lookups `IS NOT NULL`, nothing reads by bare
id.

### D-T1.9 — What does not change, and the cutover window

Unchanged: dispatch/execute lock rails and gating (Track 0 shape, minus the D-T1.5 lock
exemption); `board_defs` + Configure drawer; def envelope contract (JSON strings; `title AS
label`); Monday mapping semantics (plus the D-T1.6 additions); the tasks/bots-sql-mcp bundle
files on disk; tracker-item API paths; the Funnel invariant; `SCHEMA_GENERATION` (0004 is a
registry migration). **Knowingly dropped from the verb surface**: recurrence tooling (dormant,
named above).

**The cutover window** (post-deploy, pre-`.mcp.json`-swap): the stdio doors keep working against
the migrated store (they never touched `plan_ref`), but with the old semantics — no
`board_mutations` rows, no archive/autonomy guards, `tasks_complete` writes `done` without def
validation, and the bundle's `tasks_delete` exists (not allowlisted; a permission prompt stands
between it and the data). These suspensions are accepted **because the window is bounded**: the
swap is targeted in the same deploy conversation with Kevin, not left open-ended.

## Migration `0004-track1-card-model` (registry rail)

1. Sidecar backup `tasks.db.bak-0004-<utc>`; **defer** (`{deferred:true}`, the 0002/0003 pattern)
   when `tasks_items` is absent.
2. `CREATE TABLE board_plans / board_results / board_mutations` (+ indexes).
3. `ALTER TABLE tasks_items ADD COLUMN autonomy TEXT NOT NULL DEFAULT 'gated'`;
   `ADD COLUMN archived_at TEXT`. Validation is service-layer (no CHECK via ALTER).
4. Log the `kevin-gated` tag count (no data rewrite — flipping cards to `auto` is a deliberate
   per-card operator act later).
5. `ALTER TABLE tasks_items DROP COLUMN plan_ref` — **probe-guarded**: the column exists only
   on stores that lived through pre-Track-1 code (the bundle's own CREATE never had it, and the
   bridge already probes for its absence on "pre-migration DBs"); an unconditional DROP throws
   on grackle's empty store and any bundle-created store. On the instance-global store the
   column is all-NULL (verified). 
6. **Per-project stores**: the ALTERs (3) + (5) also run, probe-guarded, against every
   `project_spaces` tasks-store (0002's enumeration precedent), each with its own sidecar
   backup — and **any non-NULL `plan_ref` found there is logged loudly before the drop**
   (`recordPlanRef` wrote to per-project stores, so "all-NULL" is verified only for the
   instance-global copy; the referenced plan FILES stay on disk, the log preserves the
   mapping). The three new tables are NOT created here — they are instance-global-only
   (D-T1.4). A store created later by the unowned bundle converges at next boot (readers stay
   column-guarded, D-T1.6).
7. Idempotent via column/table probes; re-run converges.

`tests/migration-registry.test.js`: the converged-shape case extends to 0004 — and its existing
assertion at :233 that `plan_ref` **survives** ("dormant columns survive") is **inverted**, not
extended. Fixtures pre-seed `schema_migrations` 0001–0003 (markPhaseADone pattern).
grackle/black-swan: absent stores defer; empty stores apply trivially — next routine deploy.

## Testing and rollout

- TDD per task; every new test mutation-tested (restore by Edit, never git checkout). Suite
  floor **3176/0**; 3×3 concurrent-suite validation before the PR.
- New surface: verb-by-verb MCP tests over the HTTP mount (local token; board token path-scope —
  a board token must 401 on `/memory/mcp`; actor headers); service-layer units (validation,
  provenance rows, autonomy × outcome × terminal-def matrix, lock-exemption contract, replay
  409s, archive guards); migration 0004 (incl. per-project stores + the archived+synced Monday
  round-trip + no-push-of-archived); SSE by event name; panel client parse test both board modes
  (double-escaped escapes, no backticks); EN+ES parity for every new string.
- **Retired-surface test work** (budgeted, not discovered mid-build): rewrite/delete
  `tests/board-plan-ref.test.js`, `tests/board-plan-dispatch.test.js`, the ~15 planCard-routing
  tests in `tests/bot-jobs-card-routing.test.js`, `tests/board-dispatch-job-rail.test.js:158–174`,
  `tests/cards-db-file-uri.test.js:144–156` (recordPlanRef), and the plan-shape cases in
  `tests/board-card-api.test.js` (:70, :263–330, :355).
- CI: `suite`/`static-checks`/`audit` green via `/commits/<sha>/check-runs`; `enforce_admins`
  on; no new ports (`/board/mcp` rides the gateway port).
- Deploy (r4, after merge), in order:
  1. fuser check for stdio holders of tasks.db/crow.db; **ask Kevin to close tehcy sessions**;
     pause `pibot-gateways@r4` (restart + soak-log).
  2. `r4-deploy.sh --dry-run`, then real; ignore the 1s smoke gate's false FAIL; verify
     `systemctl is-active`, `curl :3008/s/family/`, 0004 journal lines (instance + per-project
     stores), board renders, queued `plan` jobs drained.
  3. **Bootstrap tokens with Kevin**: generate the local MCP token (Connect panel, one-time
     reveal — r4 has none today); gateway mints the board token; verify a verb round-trip over
     `/board/mcp` with each.
  4. **The swap, same conversation**: `.mcp.json` — `r4-tasks` → the `/board/mcp` entry;
     `r4-trackers` stays, tracker_* tools leave the allowlist; drop the hand-edited tracker
     block from the installed bots-sql-mcp copy (logged — the Phase B debt closes here).
  5. The 77-card archive backlog: operator pass via the verb after Kevin's nod, **paired with
     Monday-side archiving of the 69 mapped items** (or his explicit acceptance of the logged
     drift).

## Out of scope

The stdio-sync-emitter fix (companion spec `2026-08-15-stdio-sync-outbox-design.md` — board data
is instance-local and never syncs, so these two specs do not interact); the `cardsDbForBot`
`file:`-URI bug (own PR); Track 2 (Perch CSS ownership flip first) and Track 3; the
models-manager resume flake; MCP OAuth; any Funnel exposure change (Kevin's named approval);
bulk-archive UI; a plan-required execute gate; recurrence verbs (named drop, D-T1.9).

## Review record (round 2, 2026-08-15)

Fresh reviewer verifying the round-1 revisions against code + the live r4 configs. 11 findings,
all resolved in this revision. The critical one was introduced BY round 1: the plan-record
re-point read per-project stores where the new tables would not exist, and a per-project card id
reported to the gateway would attach results to the wrong instance-global card — resolved by the
store-topology rule (three new tables instance-global-only, planForCard resolves instance-global
freshly, divergent-store bots get a named absent-surface rule). Also: the lock-exemption's
missing identity plumbing (sessionRowFor bot_id + job_id through handleInbound→writeBotMcp
headers); the session-done detection mechanism (pi.toolCalls scan for a non-error
board_report_result, requiring 409s to be MCP isError); raw board-token residence
(<crowHome>/board-token 0600, peer-tokens.json precedent, catalog's first url block); the
create-scan archived filter (would have re-created archived cards on Monday); briefing snapshot
verb added (parity claim was false without it); probe-guarded plan_ref drops + per-project
non-NULL logging + per-store backups; the SSE client removal check; token scope wording
(/board/* transport paths); parent_id gets add-subtask semantics; the stdio-window "logged"
claim corrected to "bounded".

## Review record (round 1, 2026-08-15)

Two adversarial reviewers (correctness; product/ops) against `411692ac` + r4 db copies. 24
findings, all resolved in this revision. The five that broke the v1 draft outright: (1)
retiring `r4-trackers` would have removed ~17 live non-board tools — retirement re-scoped to the
tracker subset; (2) the bridge execute path (`planForCard`, the dispatch prompt, the static
plan-ref import at bridge.mjs:43) was never re-pointed — now D-T1.4/D-T1.5/D-T1.7; (3) the
result/autonomy flow collided with the session/job lock rails both ways (auto-move 409s on the
reporter's own lock; gated runs end `waiting-user` = locked) — the result↔lock contract in
D-T1.5 is the fix; (4) capability floor gaps (briefing reads, `parent_id`, recurrence) —
briefing reads + parent_id added, recurrence named as a deliberate drop; (5) three unstated ops
gaps (no local token on r4; unbounded stdio window with suspended invariants; 69 Monday-mapped
backlog cards) — all now named rollout steps. Also: MCP auth claim corrected (token-only, no
cookie leg); the board token replaces handing bots the full-surface local token;
`api-handlers.js` writes converge into the service; migration-test inversion + retired-test
inventory budgeted; `decided_via` gains `'auto'`; failed results get a card-face marker;
per-project stores enter 0004; `pull_archived_update` log action added.
