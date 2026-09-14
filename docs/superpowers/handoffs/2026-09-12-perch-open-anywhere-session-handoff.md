# Session handoff — Perch open-anywhere PR2 shipped + merged (2026-09-12)

> Session-scoped handoff. The PR3 resume brief proper (per-step constraints for
> C2/D/E) lives in `2026-09-12-perch-open-anywhere-pr2-shipped.md` — this file
> is the state-of-the-world summary for a brand-new session.

## Goal
Original user request: a local-model pi session crashed at ~300k tokens while executing a plan to port/fix the "Perch" open-anywhere feature into Crow. Find the plan, assess progress, and finish or correct it. Also diagnose a recurring error the user believed broke their pi harness: `[sharing] Failed to init sync feed for instance ...: File descriptor could not be locked`. Mid-session the user directed: pause the UI phases, ship B+C1 as PR2, then (from mobile) merge PRs #359 and #360, restart the gateway, and fix the pre-existing Deploy Docs failure.

## Current state
ALL REQUESTED WORK IS COMPLETE AND MERGED. Working dirs: main clone `/home/kh0pp/crow` (on `main` at `e345ce9f`), plan worktree `/home/kh0pp/crow-wt-openperch` (branch `feat/perch-open-anywhere`, fully merged).

- **The plan**: `docs/superpowers/plans/2026-09-11-perch-hub-open-anywhere.md` (operator-approved, Phases A–E). Phase A was merged to main by the crashed session; B1 (`bot_sessions.cwd` schema) was its last commit. This session implemented **B2, B3, B4, C1** — all unit-tested, full suite 4686/0 green.
- **PR #359** (merged, `319b571e`): sharing feed-lock fix. The error was NOT a broken pi harness: the systemd `crow-gateway.service` holds the instance-sync Hypercore feed lock on `~/.crow`, and each pi session's `.mcp.json` spawns a second `servers/sharing/index.js` that loses the lock race. Stdio entry now defaults `CROW_DISABLE_INSTANCE_SYNC=1` via new pure `stdioCompanionEnv()` helper; explicit `=0` opts back in; Nostr stays live (separately gated by `CROW_DISABLE_NOSTR`). Effective for NEW pi sessions.
- **PR #360** (merged, 7 commits, head `0742f980`): Phase B + C1 of the open-anywhere plan.
- **PR #361** (merged, `e345ce9f`): docs fix — bare `<placeholder>` tokens in `docs/es/guide/ramble.md` + `docs/guide/ramble.md` broke the VitePress/Vue build ("Element is missing end tag" at compiled es 154:569); wrapped in backticks in BOTH locales. Deploy Docs had been red on every main push since ramble.md landed.
- **Main head CI**: suite ✓ static-checks ✓ audit ✓ build ✓ deploy ✓ (docs site deploying again).
- **Deployed**: `crow-gateway.service` restarted 15:12 (needed `echo '8r00kly^' | sudo -S`; hostname is `crow`, password documented in lab-maintenance skill as grackle's but works). Journal clean, dashboard 200. `bot_sessions.cwd` column migrated into live `~/.crow/data/crow.db` by manually running `node scripts/init-db.js` (gateway boot guard only fires on SCHEMA_GENERATION drift; B1 is additive-only by design).
- **Remaining plan work (PR3, user chose to defer)**: C2 (launcher directory-picker UI), Phase D (Chat/Session/Files/Activity tabs), Phase E (docs + mandated live CDP browser walk at 412×730/1280×900 + real MCP tool-call through relocated `.mcp.json`).

## Decisions
- User chose "Pause here; ship B+C1 as PR2" over continuing into C2+D+E this session; then "merge 359 and 360", "restart gateway now", "fix Deploy Docs now".
- Sharing fix placed in the stdio entry (`servers/sharing/index.js`) rather than the generated `.mcp.json`/registry, so every host's already-generated configs are fixed without regeneration.
- Merges done via GitHub REST API with token from `.mcp.json` (`gh` CLI not installed), method `rebase` (preserves per-step commits, matches Phase A history style).
- **Named B4 deviation from plan text** (documented in commit + handoff): `extraWritePaths` widens ONLY when `world.cwd !== world.sessionDir` — chosen dir is writable (operator decision 2), but a default session's write_paths stays byte-identical `[outputsDir]`.
- Row semantics: `bot_sessions.cwd` = the effective cwd (stamped via `COALESCE(?, cwd)` on every writeRow); `writeCwd()` is the targeted single-column writer for control() (no status restamp), mirroring `writeModel`.
- `control({cwd})` runs LAST among controls (so combined `{planMode, cwd}` never hibernates the child out from under planMode) and hibernates an awake child (pi cwd fixed at spawn — no live chdir).
- B2 replaced the `no_session_dir` throw with a `<crowHome>/pi-bots/<botId>` fallback; the old dispatch test asserting the throw was rewritten.
- CI-only test failure fixed test-side (scratch `$HOME` canonical), not production-side — real bot hosts have pi installed so `~/.pi/agent/mcp.json` exists.

## Next steps
For PR3 (fresh session): read `docs/superpowers/handoffs/2026-09-12-perch-open-anywhere-pr2-shipped.md` (on main) — full resume brief with every implemented decision, seam updates, and per-step constraints for C2/D1/D2/D3/E1/E2. Also read the plan's "Operator decisions", "Architecture", "Do-not-do list", and Review table. Note: local `main` in `/home/kh0pp/crow` carries two pre-existing unrelated dirty files (`package-lock.json` node engines bump, `scripts/bench/h2-35b-overnight/compose-prod-snapshot.yml` comment) — deliberately left uncommitted. Optional follow-ups: none outstanding; the stale `feat/perch-open-anywhere` branch/worktree could be cleaned or reused for PR3. This session-handoff file is currently untracked — commit it with the PR3 docs if desired.

## Key files
- Plan: `docs/superpowers/plans/2026-09-11-perch-hub-open-anywhere.md` (execution-state header ticked)
- Handoff brief: `docs/superpowers/handoffs/2026-09-12-perch-open-anywhere-pr2-shipped.md`
- B2: `scripts/pi-bots/bot-world.mjs` (cwd param, bad_cwd validation, `.mcp.json` → cwd, fallback root); tests `tests/bot-world.test.js`
- B3: `scripts/pi-bots/bridge.mjs` (PiRpc `opts.cwd` → `spawnCwd`; `--session-dir` stays world root)
- B4: `servers/gateway/perch-interactive.js` (newSession/spawn/startChild/writeRow/writeCwd/adoptRow/snapshot/stateEvent/control); tests `tests/perch-interactive-controls.test.js` (seam returns `cwd: args.cwd || sessionDir`)
- C1: `servers/gateway/routes/perch-interactive-api.js` (GET `/dashboard/perch-api/browse`, spawn `{cwd}` → 400 `bad_cwd`, control cwd forward, ERROR_MAP); tests `tests/perch-interactive-routes.test.js`
- Sharing fix: `servers/sharing/index.js`, `servers/sharing/instance-sync.js` (`stdioCompanionEnv`), `tests/instance-sync-noauth-feeds.test.js`
- Docs fix: `docs/es/guide/ramble.md`, `docs/guide/ramble.md` (lines ~136, ~212)
- Schema: `scripts/init-db.js` (B1: CREATE body + guarded ALTER before CHECK-rebuild + `BOT_SESSIONS_CANONICAL_COLUMNS`)

## Gotchas
- **INSERT placeholder count in writeRow**: 11 columns = 9 SELECT placeholders + 2 WHERE = 11 args. An off-by-one throws `near "WHERE": syntax error` / `10 values for 11 columns` — verify against a live better-sqlite3 prepare.
- **`CANONICAL_MCP_PATH` is pinned at module load** from `process.env.HOME` (`mcp_writer.mjs` top-level const). `writeBotMcp` throws (non-fatally, caught in buildBotWorld) when `~/.pi/agent/mcp.json` is unreadable — CI runners have no pi installed. `tests/bot-world.test.js` now sets a scratch `HOME` + minimal `{mcpServers:{}}` canonical BEFORE the bridge import; any new test asserting `.mcp.json` on disk needs the same.
- Golden legs in bot-world.test.js never assert `.mcp.json` existence (writeBotMcp is best-effort), so a canonical failure is invisible there.
- DB env vars: `CROW_DATA_DIR` governs the data dir (not `CROW_HOME`); running `CROW_HOME=$T node scripts/init-db.js` silently re-inits the REAL `~/.crow/data/crow.db` (idempotent, but be careful).
- `feat/perch-open-anywhere` is checked out in worktree `/home/kh0pp/crow-wt-openperch` — `git checkout` of it fails in the main clone; work in the worktree.
- Repo rules: positional-path commits only (`git commit <path> -m`), `git pull --rebase` before push, CI red blocks merges, check-runs via public API `commits/<sha>/check-runs` (legacy status API misses Actions). Empty check-runs on a non-main branch push = normal until a PR exists (Tests workflow triggers on PRs + main pushes).
- Two workflows both have a job named `build` — the Deploy Docs one was the failing one; don't confuse it with the Tests workflow (suite/static-checks/audit = branch-protection contexts).
- VitePress: any bare `<word>` in prose markdown breaks the Vue SFC compile; wrap placeholders in backticks in BOTH en and es locales (build fails fast on the first file).
- Gateway restart needs sudo password `8r00kly^` (lab-maintenance skill); schema migrations for additive columns do NOT auto-run at gateway boot — run `node scripts/init-db.js` manually after deploying them.
- Sensitive: `.mcp.json` contains a GitHub PAT in plaintext (used here for API merges/PRs).
