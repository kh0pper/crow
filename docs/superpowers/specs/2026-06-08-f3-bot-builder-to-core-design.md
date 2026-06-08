# F3 — Bot Builder → Core (Phase a: definitions everywhere)

**Date:** 2026-06-08 · **Sub-project:** F3 of the Crow v1 refoundation · **Machine:** crow · **Repo:** `/home/kh0pp/crow` (branch `main` @ `58dee45`)

**Predecessor handoffs:** `~/.claude/plans/F3-bot-builder-handoff.md`, master plan `~/.claude/plans/when-i-click-on-woolly-elephant.md`.

## Goal

Make Bot Builder a **core** feature present on every Crow instance, rather than an MPA-only add-on. Today the `pi_bot_defs` table is created by a hand-run script, every `scripts/pi-bots/*.mjs` hardcodes `~/.crow-mpa/...`, and two dashboard panels degrade to a "runs on the MPA instance" notice off-MPA.

## Scope decision (locked with user, 2026-06-08)

**Phase (a) only:** the Bot Builder **UI works and bots can be defined on every instance**. The bot **runtime** (long-lived Gmail/Telegram/Discord gateways + timers) stays opt-in and, in practice, MPA-only for now. Distributing the runtime (systemd templating, per-instance opt-in start) is **Phase (b)** — deferred to its own attended session with a dedicated handoff doc (`F3b-bot-runtime-distribution-handoff.md`, written as the last step of this work).

Rationale: phase (a) delivers the user-visible goal at a fraction of the risk. Phase (b)'s hard part is operational (multi-gateway `crow.db` lock contention, prod-safety restart windows, not disturbing the 3 live MPA bots), which deserves a dedicated attended session, not a bolt-on to a refactor.

## Non-goals (explicitly out of scope for this increment)

- Starting/stopping bot runtime units on non-MPA hosts (Phase b).
- The MPA-targeted e2e/smoke fixtures with intentional `~/.crow-mpa` literals: `bridge_gmail_e2e.mjs`, `slicec_e2e.mjs`, `slicec_api_e2e.mjs`, `p3_0_e2e.mjs`, `s2_setup.sh`, `mcp.json.s0`. These stay MPA-pinned (documented as known-deferred in the F3b handoff).
- A versioned settings/schema-migration runner. F3 ships **no data migration** — idempotent `CREATE TABLE IF NOT EXISTS` is sufficient, consistent with the other 64 tables in `init-db.js`.
- Adding a `canLoad()`/`isAvailable()` hook to `panel-registry.js` (breadth; the in-handler guard suffices).

## Coupling anchors (verified against `58dee45`)

1. **Schema is a hand-run script.** `scripts/init-pi-bots.mjs` creates `pi_bot_defs`, `bot_sessions`, `bot_skill_events` and adds `bot_sessions.model`/`escalated` + `pi_bot_defs.project_id` via guarded `ALTER`s (the base `CREATE TABLE` bodies do **not** include those columns). Not wired into `package.json` or any deploy script — hand-run only.
2. **Hardcoded `~/.crow-mpa` paths** across `scripts/pi-bots/*.mjs`: `bridge.mjs:42,45`, `bridge_tick.mjs:25` (**no env fallback** — hardcoded literal), `tracker.mjs:18-19`, `skill_promote.mjs:40`, `skill_provenance.mjs:20`, `model_resolver.mjs:60,165`, `mcp_writer.mjs:329`. Plus panel `TASKS_DB` (`bot-builder.js:55`) and `defaultDefinition` session dir (`bot-builder.js:285`).
3. **Two panels degrade off-MPA.** `bot-builder.js` (`tableMissing()` @ ~270, notAvail render @ 661–667) and `bot-board.js:395` both show "Bot Builder runs on the MPA instance… run `node ~/crow/scripts/init-pi-bots.mjs`".
4. **`mcp_writer.mjs` mints per-bot `.mcp.json`** blocks that bake in `CROW_DB_PATH` (`mcp_writer.mjs:329`) — generated config, not just a runtime read.

**Reuse targets:** `resolveDataDir()` (`servers/db.js:70`, the canonical DB router: `CROW_DATA_DIR` → `~/.crow/data` → `./data`); `getOrCreateLocalInstanceId()` (`servers/gateway/instance-registry.js:340`). The DB path and `resolveCrowHome()` (`ext_registry.mjs:45`, governs bundles/skills/panels) are **two distinct routing signals** — this work keys DB paths off `resolveDataDir()` only, leaving the already-correct crowHome resolution alone.

## Design

### 1. Schema to core (`scripts/init-db.js`)

Add the three tables to `init-db.js` in their **full current shape** as `CREATE TABLE IF NOT EXISTS`:

- `pi_bot_defs` **including** the `project_id INTEGER` column + `idx_pi_bot_defs_project`.
- `bot_sessions` **including** `model TEXT` and `escalated INTEGER DEFAULT 0` (today added by guarded `ALTER`), with the `status`/`control` CHECK constraints and both indexes.
- `bot_skill_events` + its two indexes.

A fresh instance gets the complete schema directly. On the MPA DB every statement is a verified no-op (tables + columns already present). No `ALTER` migration moves into `init-db.js`.

**`init-pi-bots.mjs` is kept** as a legacy/MPA maintenance script: it still does the JSON→column `project_id` **backfill** and the prod-bot guard (`bot_registry` row count), which `init-db.js` must not do. `init-db.js` becomes the canonical DDL source. Add cross-reference header comments in both files so the DDL can't silently drift.

### 2. Per-instance path resolution

New shared module `scripts/pi-bots/instance-paths.mjs` exporting:

- `botsDbPath()` → `process.env.CROW_DB_PATH` || `${resolveDataDir()}/crow.db`
- `tasksDbPath()` → `process.env.CROW_TASKS_DB_PATH` || `${resolveDataDir()}/tasks.db`
- `botsWorkspaceRoot()` → `${dirname(resolveDataDir())}/pi-bots/` (→ `~/.crow-mpa/pi-bots` on MPA, `~/.crow/pi-bots` elsewhere)

Imports `resolveDataDir` from `servers/db.js`. Each call site keeps its existing `process.env.X || …` precedence — only the **fallback literal** changes from `~/.crow-mpa/...` to the resolved path. On the MPA gateway `CROW_DB_PATH`/`CROW_TASKS_DB_PATH` are already set in the service env, so behavior there is **byte-identical**; resolution only changes instances that don't set the env.

Edit call sites: `bridge.mjs:42,45`, `bridge_tick.mjs:25` (add the missing fallback), `tracker.mjs:18-19`, `skill_promote.mjs:40`, `skill_provenance.mjs:20`, `model_resolver.mjs:60,165`, `mcp_writer.mjs:329`, panel `bot-builder.js:55` (`TASKS_DB`) and `:285` (`defaultDefinition` session dir → derive from `botsWorkspaceRoot()`).

**`mcp_writer.mjs` minting:** the per-bot `.mcp.json` blocks it generates must bake in the **resolved** DB path, so a bot defined on a general instance points pi at that instance's DB, not `~/.crow-mpa`.

### 3. Panel gating + runtime indicator (`bot-builder.js`, `bot-board.js`)

- **Keep** the in-handler `tableMissing()` guard (the panel must never throw — `dashboard/index.js` is shared across gateways). With tables now in `init-db.js`, this becomes a true edge case (a DB not re-inited after upgrade).
- **Reframe** the notAvail message: drop the MPA-specific text; show "Bot Builder tables not initialized on this instance — run `npm run init-db`."
- **Runtime indicator:** when tables exist but `feature_flags.bot_runtime` is not set on this instance, show a neutral banner — *"Bot definitions are stored here. The bot runtime (Gmail/Telegram/Discord gateways) is enabled per-instance and is not active on this instance yet."* Suppressed where the flag is set (MPA).

**`feature_flags.bot_runtime`** uses the same **local, non-synced** pattern F1.3 used for `mpa_presets` (`feature_flags` is deliberately absent from `sync-allowlist.js`, so it never replicates). Phase (a): preset true on MPA, absent elsewhere — zero process probing. Phase (b) later wires the flag to actually start/stop runtime units.

### 4. Components / interfaces

| Unit | Purpose | Depends on |
|---|---|---|
| `instance-paths.mjs` | Resolve bots DB/tasks DB/workspace per instance | `resolveDataDir` (`servers/db.js`) |
| `init-db.js` (additions) | Canonical DDL for the 3 bot tables (full shape) | `createDbClient` |
| `init-pi-bots.mjs` (kept) | Legacy MPA backfill (`project_id`) + prod-bot guard | better-sqlite3 |
| Panel guard + banner | Never-throw gating + honest runtime indicator | `feature_flags.bot_runtime` |

## Testing & verification

No test framework; `node:test` files in `tests/` + isolated-DB render checks (per `CLAUDE.md`).

1. **`tests/pi-bots-instance-paths.test.js`** (new) — `CROW_DB_PATH` set → returned verbatim; unset + `CROW_DATA_DIR=/tmp/x` → `/tmp/x/crow.db`; `botsWorkspaceRoot()` derives `…/pi-bots`; never returns a `~/.crow-mpa` literal when env points elsewhere.
2. **Schema parity** — run `init-db.js` against a fresh temp DB (`CROW_DATA_DIR=/tmp/f3-fresh`); assert all three tables exist with the full column set (`pi_bot_defs.project_id`, `bot_sessions.model`/`escalated`). Proves moved DDL matches `init-pi-bots.mjs` output.
3. **MPA no-op proof** — `cp ~/.crow-mpa/data/crow.db{,-wal,-shm} /tmp/…`; run the new init-db DDL against the **copy**; assert `pi_bot_defs`/`bot_sessions`/`bot_skill_events` row counts unchanged and no column dropped. Never touches the live file.
4. **Panel render** — import `bot-builder.js` + `bot-board.js` handlers with a mock `res` against (i) fresh inited DB → editor + "runtime not active here" banner; (ii) `feature_flags.bot_runtime=1` → banner suppressed.
5. **Invariants** — `node tests/auth-network.test.js` and `node tests/nest-mesh.test.js` green; no new routes added.

## Build order

1. Move DDL → `init-db.js` (full-shape) + cross-reference comments in `init-pi-bots.mjs`.
2. Add `instance-paths.mjs` + unit test.
3. Swap hardcoded paths across the 7 `scripts/pi-bots/*.mjs` modules (`bridge`, `bridge_tick`, `tracker`, `skill_promote`, `skill_provenance`, `model_resolver`, `mcp_writer`) + the panel (incl. `mcp_writer` minting).
4. Panel gating reframe + `bot_runtime` indicator (both panels).
5. Tests (schema parity, MPA no-op-on-copy, panel render).
6. Write `~/.claude/plans/F3b-bot-runtime-distribution-handoff.md`.

## Deploy (Phase a, attended)

Low-risk (DDL no-op on existing DBs; path resolution byte-identical where `CROW_DB_PATH` already set), but it restarts prod gateways — attended, short window, verify-after, per the global prod-safety rule. **No mass-restart of MPA-side bot services** (see memory `grackle-multi-gateway-crowdb-lock`) — only the gateway units.

1. Merge to `main` via GitHub MCP (`gh` not installed).
2. **crow:** `git pull --ff-only`; run `npm run init-db` for both `~/.crow/data` and `~/.crow-mpa/data` (via `CROW_DATA_DIR`); `sudo systemctl restart crow-gateway crow-mpa-gateway`.
3. **grackle:** `~/bin/grackle "cd ~/crow && git pull --ff-only && npm run init-db && …restart crow-gateway"`.
4. Verify each gateway `is-active` + clean journal; load Bot Builder on a general instance → editor + banner; MPA → 3 bots, no banner.

## Conventions / safety

- Commit with explicit path args (`git commit <paths> -m …`), verify `git show --stat HEAD`. Never add Claude as co-author. `git pull --rebase` before pushing; branch off `main`.
- PRs via GitHub MCP tools; no Claude footer in PR bodies.
- Bot gateways touch the shared `~/.crow-mpa` crow.db — respect the multi-gateway DB-lock memory note before restarting MPA-side services.
- MPA presets/pipelines are live; this work does not touch runtime preset resolution.
