# Perch open-anywhere — PR2 shipped, PR3 (C2 + D + E) resume brief

**Date:** 2026-09-12
**Plan:** `docs/superpowers/plans/2026-09-11-perch-hub-open-anywhere.md` (operator-approved; its "Operator decisions" + "Architecture" sections are load-bearing — read them first)
**Branch:** `feat/perch-open-anywhere` (worktree `/home/kh0pp/crow-wt-openperch`)
**PR2:** #360 — Phases B (B1–B4) + C1. Full suite 4686/0 green at push.

> The session that produced Phase A + B1 was a local-model run that died at
> ~300k tokens; this brief exists so PR3 does not have to re-derive state from
> scratch. Everything below was measured, not asserted.

## What is already done (do NOT redo)

- **Phase A (A1–A4)** — merged to `main` (`bb3500c6` and predecessors). The
  row's `model` column means an explicit choice only; `control()` validates the
  model pair; a dead recorded model fails open at wake; the subscribe/history
  duplicate bubble is deduped.
- **B1** `bot_sessions.cwd` schema (`f92d3ce7`) — nullable TEXT, additive-only,
  **no `SCHEMA_GENERATION` bump** (the `kind`/`narrowed_tools`/`label`
  precedent). It is in the CREATE body, the guarded `addColumnIfMissing` ALTER
  (placed BEFORE the control-CHECK rebuild block — ordering is load-bearing),
  and `BOT_SESSIONS_CANONICAL_COLUMNS` so the dedicated rebuild carries it
  instead of aborting on it as drift. Tests: `init-db-bot-tables` 13/13.
- **B2** `buildBotWorld({cwd})` (`979a267e`, `scripts/pi-bots/bot-world.mjs`) —
  validates cwd (absolute/existing/dir → typed `bad_cwd`) BEFORE any side
  effect; **relocates the per-bot `.mcp.json` to the cwd** (the in-body
  `writeBotMcp(def, { sessionDir: resolvedCwd, … })` call — pi-lab's mcp-client
  reads `cwd/.mcp.json`, so writing it at the world root would silently strip
  every MCP tool); `no_session_dir` throw REPLACED by a
  `<crowHome>/pi-bots/<botId>` fallback; world root (`sessionDir`) keeps
  storage duty (`sessions/`, `outputs/<sid>`, uploads); `selfAuthoringDir`
  stays keyed on `def.session_dir` by design (review Q1). Returns `cwd`.
- **B3** `PiRpc` (`4634d861`, `scripts/pi-bots/bridge.mjs`) — `spawnCwd =
  opts.cwd || sessionDir` used as the child's process cwd; `--session-dir`
  STILL points at the world root; `prepareSpawn`'s `piRpcOpts` stay cwd-free so
  every channel caller (gmail/discord/job_runner) is byte-identical. The split
  belongs to the interactive caller (B4), not prepareSpawn.
- **B4** engine (`08132c52`, `servers/gateway/perch-interactive.js`) — `s.cwd`
  through newSession/spawn/startChild/writeRow/adoptRow/snapshot/stateEvent/
  control. Key decisions actually implemented:
  - `startChild` sets `s.cwd = world.cwd || world.sessionDir` (snapshot reports
    the truth even for a default session) and passes `cwd: world.cwd` into
    PiRpc opts.
  - **`extraWritePaths` widens ONLY when `world.cwd !== world.sessionDir`** —
    i.e. the chosen dir is writable (decision 2), but a DEFAULT session's
    `write_paths` stays byte-identical `[outputsDir]`. (The plan's B4 bullet
    list omitted the write_paths step; decision 2 + the E1 walk require it, so
    it lives here. This is the one named deviation from the B4 text.)
  - `writeRow` stamps `cwd=COALESCE(?, cwd)`; `writeCwd()` is the targeted
    single-column writer (no status restamp, mirrors `writeModel`). INSERT
    gained the `cwd` column — **11 cols / 9 SELECT placeholders + 2 WHERE = 11
    args**, re-verified against a live `better-sqlite3` prepare (an off-by-one
    here throws `near "WHERE": syntax error` / `10 values for 11 columns`).
  - `control({cwd})`: validates (absolute/existing/dir → `bad_request`),
    refuses `turn_in_progress`, persists via `writeCwd`, and because pi's cwd
    is fixed at spawn (no live chdir) **hibernates an awake child** with a
    `working directory → <dir>` log frame; reported under `bindsAtWake.cwd`.
    Runs LAST among the controls so a combined `{planMode, cwd}` never
    hibernates the child out from under the planMode branch.
- **C1** routes (`bcde286b`, `servers/gateway/routes/perch-interactive-api.js`)
  — `GET /dashboard/perch-api/browse?path=` (directory NAMES + paths only,
  never contents/file entries; `~` expansion; `resolve()` collapses `..`;
  realpath; 404 `{error:'unreadable'}`; symlinks followed only to real dirs;
  dot-dirs last; cap 500; `parent` from the RESOLVED realpath). Under the same
  `dashboardAuth`, **NOT** in `PUBLIC_FUNNEL_PREFIXES` (network invariant
  holds; `auth-network` 20/20). `POST /bots/:id/interactive` accepts optional
  `{cwd}` (route-validated → 400 `bad_cwd`, new `ERROR_MAP` row);
  `POST /interactive/:sid/control` forwards an explicit `cwd` (presence-keyed).

### Test seams already updated (so PR3 does not re-break them)
- `tests/perch-interactive-controls.test.js` — the fake `buildBotWorld` seam
  returns `cwd: args.cwd || join(dir,"bots",args.botId)` (mirrors B2). 7 new
  B4 tests appended.
- `tests/perch-interactive-routes.test.js` — the fake `spawn` captures `cwd`;
  the two existing `engineCalls.spawn` deepEquals were updated to carry the new
  `cwd` key (`cwd:null` interactive / `cwd:undefined` dispatch). 10 new C1 tests.
- `tests/bot-world.test.js` — 4 B2 tests + 1 B3 PiRpc-seam test appended.
- `tests/perch-interactive-dispatch.test.js` — the old `no_session_dir` throw
  test was rewritten to assert the B2 fallback.

## What PR3 must do (C2 + Phase D + Phase E)

Follow the plan's steps **C2, D1, D2, D3, E1, E2** verbatim — they are
unchanged and already adversarially reviewed (see the plan's Review table).
The relevant files and the load-bearing constraints:

- **C2** (`perch-hub/html.js`, `client.js`, `css.js`, `shared/i18n.js`):
  `#perch-new-cwd` text input + `#perch-browse-btn` beside the model select in
  the `#perch-launch` row (html.js ~:63-66); `startNewSession()` (client.js
  ~:508) reads the field and sends `cwd` ONLY when non-empty (empty = "the
  bot's default", never send the key). Picker = a modal overlay listing
  `/browse` results (header shows current path, `..` row → `parent`, tap a dir
  → navigate, a **labelled "Choose"** writes the path into `#perch-new-cwd`).
  **Explicit Escape handler + a visible "Cancel" button** (dismiss must not
  depend on either alone — review S5). Register listeners through the hub's
  generation-checked registry (`on(...)`, client.js ~:93) so the Turbo-leak
  guard (`perch-hub-stream-leak.test.js`) covers them. i18n: EN+ES keys
  `perch.cwdLabel`, `perch.cwdPlaceholder`, `perch.browse`, `perch.choose`,
  `perch.browseFailed`, `perch.cwdDefaultNote` (the parity test
  `i18n-global-parity.test.js` fails loudly on one-sided keys). Add the matching
  `tJs(...)` constants near client.js ~:247.
- **D1** (html.js, css.js): `#perch-tabs` `role="tablist"` with four buttons
  (chat|session|files|activity) + four `<section id="perch-tab-<name>">`
  wrappers inside `#perch-chat`. Desktop (≥`PERCH_SPLIT_MIN_WIDTH`): top strip
  in the right pane; phone: fixed bottom tab bar with the composer ABOVE it.
  **The flex chain has already killed one Send button** — keep
  `#perch-chat{flex:1;min-height:0}` and the transcript as the only scroller;
  the tab bar joins as a non-shrinking sibling. CDP-measure Send reachable at
  412×730 and 1280×900 in EVERY tab.
- **D2** (client.js, i18n): tab state is a plain `var tab='chat'` reset on
  session open; switching is **pure visibility toggling — never touch the
  EventSource/`openStream`/`closeSession`/any SSE lifecycle** (review S6).
  Route `log`/`tool`-start/note/`error` frames to `#perch-activity-list`
  (chat keeps user/bot messages, ask cards, hard failures). Session tab gets
  the model/thinking/permission/plan controls + rename/close + a read-only cwd
  display with a "Change directory" button that reopens the browse modal and
  POSTs `control({cwd})`. Deliberately NOT in the hash.
- **D3** (routes + client.js + css.js + i18n): `GET /interactive/:sid/files/list`
  → outputsDir-relative `{name,size,mtime}`, flat, skip dotfiles + symlinks
  (`lstatSync`), sort mtime desc, cap 200, reuse `snap.outputsDir`, same 409
  shapes as the download route, NEVER lists uploadsDir. Mirror the jail's attack
  inventory at the LIST level in `perch-interactive-routes.test.js`.
- **E1**: full `npm test`; `node servers/gateway/index.js --no-auth` boots
  clean; **the live Perch walk** (start a session in a chosen non-default dir →
  it writes a file there → **one tool call through a per-bot MCP server from
  that dir** — this is the silent-failure guard for the `.mcp.json` relocation
  — → switch model while hibernating → restart gateway → adopts on the switched
  model in the chosen dir → disable the provider → fail-open log in Activity →
  change cwd mid-session refused in-turn, works idle). CDP render checks at
  412×730 + 1280×900 + no horizontal scroll at 320px. **These need a running
  gateway + headless Chrome** — they could not be run in the PR2 session.
- **E2**: `docs/architecture/gateway-server.md` (perch cwd model + new
  endpoints), the `docs/guide` perch walkthrough, and a status footer on
  `docs/reviews/2026-09-11-perch-pr356-review-completion.md`
  ("R1/R2/R4 closed by <PR#>"). `cd docs && npm run dev` spot-check.

## Repo discipline reminders (bite if forgotten)
- Commit with **positional path args**: `git commit <path> -m "…"` (parallel
  sessions share the tree). Verify `git show --stat HEAD`.
- `git pull --rebase` before pushing; CI red blocks ALL merges.
- The branch is checked out in the **worktree** `/home/kh0pp/crow-wt-openperch`
  (not the main `/home/kh0pp/crow` clone) — `git checkout feat/perch-open-anywhere`
  there, or work in the worktree directly.
- No new host ports (would fail `check-ports`); no bundle-manifest bumps (all
  core gateway code); do not touch `PUBLIC_FUNNEL_PREFIXES`/`isAllowedNetwork()`.

## Unrelated fix shipped alongside (separate PR)
The `[sharing] Failed to init sync feed … File descriptor could not be locked`
warning in pi sessions was **not** perch work and **not** a broken harness: the
systemd gateway holds the instance-sync feed lock and each pi session's
`.mcp.json` spawned a second `servers/sharing/index.js` on the same `~/.crow`
that lost the race. Fixed in PR **#359** (`fix/stdio-sharing-sync-gate`): the
stdio entry defaults `CROW_DISABLE_INSTANCE_SYNC=1` via a pure
`stdioCompanionEnv()` helper (explicit `=0` opts back in), Nostr stays live.
