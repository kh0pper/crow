# F3b — Distribute the Bot Builder Runtime to Any Instance

**Date:** 2026-06-08 · **Sub-project:** Crow v1 refoundation → F3 (Bot Builder → core) → **Phase b (runtime distribution)** · **Repo:** `/home/kh0pp/crow` · branch `feat/f3b-bot-runtime-distribution` (off `main`).

**Status:** APPROVED — ready to turn into an implementation plan. Predecessor F3 Phase a is merged + deployed (Bot Builder *definitions* work on every instance; runtime stays MPA-only by deployment). Handoff: `~/.claude/plans/F3b-bot-runtime-distribution-handoff.md`. Master plan: `~/.claude/plans/when-i-click-on-woolly-elephant.md`.

## Goal

Let an opted-in instance actually **run** bots end-to-end (poll Gmail, answer Telegram/Slack/Discord), not just define them — controllable from the dashboard, opt-in per instance, without disturbing the live MPA prod bots. Scope (locked with user): build the mechanism + **cut MPA over** to it + **light up grackle** as a live second host.

## Context: what exists (verified anchors)

- **Runtime = 3 system units, all on the MPA host, all hardcoded `~/.crow-mpa`:**
  - `pibot-gateways.service` → `scripts/pi-bots/gateways/gateway_runner.mjs` (Telegram long-poll + Slack socket; long-lived, `setInterval(()=>{},1<<30)` keep-alive). Repo copy: `scripts/pi-bots/pibot-gateways.service`.
  - `pibot-discord.service` → `scripts/pi-bots/discord_gateway.mjs` (long-lived). Unit only in `/etc/systemd/system` (not in repo).
  - `pibot-bridge.timer` + `pibot-bridge.service` → `scripts/pi-bots/bridge_tick.mjs` (Gmail poll; **one-shot**, `process.exit(0)` per tick; timer-driven). Units in `/etc/systemd/system`; drop-in `pibot-bridge.service.d/timeout.conf`.
  - All three set `Environment=CROW_DB_PATH=/home/kh0pp/.crow-mpa/data/crow.db`, `User=kh0pp`, `WorkingDirectory=/home/kh0pp/crow`, `After=...crow-mpa-gateway.service`.
- **Code is already instance-agnostic** (F3 Phase a): `scripts/pi-bots/instance-paths.mjs` (`botsDbPath()` anchors on `CROW_DB_PATH` → else `resolveDataDir()`; `tasksDbPath()`/`botsWorkspaceRoot()` derive from it). The portable `better-sqlite3` import fix (`3e00a85`) removed the last `/home/kh0pp` coupling. So only the *units* are host-pinned, not the code.
- **The runtime gate / seam:** `servers/gateway/dashboard/panels/bot-runtime-flag.js` → `botRuntimeActive(db)` reads `feature_flags.bot_runtime` (explicit boolean wins, else auto-detect MPA host via `isMpaHost()`). Currently a read-only **indicator** in the Bot Builder/Board panels. `feature_flags` is local-only (absent from `sync-allowlist.js`) — genuinely per-instance.
- **The gateway node process cannot `systemctl`** (system units; only shell scripts use `sudo systemctl`, e.g. `scripts/crow-update.sh`). → A dashboard toggle controls behavior via a **flag the runners honor**, not by managing units.
- **crow.db-lock hazard** (memory `grackle-multi-gateway-crowdb-lock`): multiple consumers leaking MCP children onto ONE shared crow.db crash-loop the dashboard on "database is locked". Mitigations in place: `mcp_writer` forces `CROW_JOURNAL_MODE=DELETE` on crow.db server blocks; `busy_timeout`; the `pi_lifecycle.mjs` concurrency/age/RSS reaper.
- Settings-section pattern: default-export `{ id, group, icon, labelKey, navOrder, getPreview, render, handleAction }` registered in `panels/settings.js`; toggle pattern in `sections/unified-dashboard.js`; `feature_flags` read-merge-write pattern in `sections/remote-invocation.js`.

## Scope decisions (locked with user, 2026-06-08)

- **Control model: self-gating templated units.** Units are installed once per opted-in instance (the one privileged step); the runners always run but honor `feature_flags.bot_runtime` — idle (no polling/connections) when off, active when on. The dashboard toggle just writes the flag; runners react **without a restart or privilege**. "Off" = idle process, not a stopped service.
- **Distribution unit = a per-instance systemd template** (`@%i`) + a per-instance `EnvironmentFile`. No sudoers, no supervisor rewrite.
- **Targets this slice:** cut MPA over; opt-in grackle live. Other instances remain opt-in-off.
- **Opt-in is explicit:** an instance runs bots only if (a) its units are installed+enabled AND (b) `feature_flags.bot_runtime` is true. Flag default off; set explicitly true on MPA + grackle during rollout.

## Non-goals (F3b)

- Cross-instance bot *edit* or running a bot from a *non-owning* instance (that's F4a Layer 3 — F3b only makes the runtime *runnable per instance*).
- A privileged systemctl control path or a supervisor-process rewrite (rejected in favor of self-gating).
- Lighting up instances beyond MPA + grackle (others stay opt-in-off).
- Touching the MPA-pinned test/smoke fixtures (`bridge_gmail_e2e.mjs`, `slicec_*`, `p3_*`, `s0_mcp_probe.mjs`, `s2_setup.sh`, `mcp.json.s0`) — intentionally pinned.

## Design

### 1. Templated units + per-instance EnvironmentFile

New templated units (live in `scripts/pi-bots/systemd/`, installed to `/etc/systemd/system/`):
- `pibot-gateways@.service` → `gateway_runner.mjs`
- `pibot-discord@.service` → `discord_gateway.mjs`
- `pibot-bridge@.service` (one-shot) + `pibot-bridge@.timer` → `bridge_tick.mjs`

Each `@.service` carries `EnvironmentFile=/etc/crow/pibot-%i.env` and `WorkingDirectory=/home/kh0pp/crow`, `Restart=on-failure`/`RestartSec=10` (for the long-lived ones), `After=network-online.target` (drop the `crow-mpa-gateway` dependency). `%i` is the instance key (`crow-mpa`, `grackle`). The env file holds `CROW_HOME`, `CROW_DB_PATH`, `CROW_DATA_DIR`, `PATH` for that instance. Example `pibot-gateways@crow-mpa.service` reads `/etc/crow/pibot-crow-mpa.env`.

### 2. `runtime-gate.mjs` — the self-gating helper

New `scripts/pi-bots/runtime-gate.mjs` exporting `runtimeGate(db, { start, stop, pollMs = 30000, logTag })`:
- Reads `feature_flags.bot_runtime` via a **synchronous better-sqlite3** read (the runners use better-sqlite3, not the panel's async libsql) — mirroring `botRuntimeActive`'s logic (explicit boolean wins, else `isMpaHost()`), the same sync-read pattern L2b's `bridge.readRemoteInvocationEnabled` used. Extract the shared parse/default (`flags.bot_runtime === true ? … : isMpaHost()`) into a small helper used by both the async panel reader and the sync runner reader so they can't drift; `isMpaHost()` is also the deferred `mpa-detect.js` dedup target.
- On startup: if active → call `start()`; else idle.
- Polls every `pollMs`: on off→on transition call `start()`; on on→off call `stop()`.
- Never throws on a malformed flag (defaults to inactive on read error).
- Returns a handle (so the runner can `stop()` on SIGTERM).

The long-lived runners (`gateway_runner.mjs`, `discord_gateway.mjs`) wrap their adapter setup/teardown in `runtimeGate` `start`/`stop` callbacks (connect/disconnect Telegram/Slack/Discord). `bridge_tick.mjs` (one-shot) gets a top-of-script guard: if `!botRuntimeActive(db)` → `process.exit(0)` (the timer keeps firing but no-ops when off).

### 3. `feature_flags.bot_runtime` becomes a control

New Settings section `sections/bot-runtime.js` (Multi-Instance group): a writable toggle that read-merge-writes `feature_flags.bot_runtime` (local scope; mirrors `remote-invocation.js`). The Bot Builder/Board indicator stays (it reads the same flag). Toggling → runners react within `pollMs` (no restart). `getPreview({settings})` shows enabled/disabled. Default off; `botRuntimeActive`'s `isMpaHost()` fallback is preserved for back-compat but explicit flags are set during rollout so behavior is deterministic.

### 4. One-time opt-in installer

`scripts/pi-bots/install-runtime.sh <instance-name>`: (a) writes `/etc/crow/pibot-<name>.env` from the caller's resolved `CROW_HOME`/`CROW_DB_PATH`/`CROW_DATA_DIR`/`PATH`; (b) installs the templated unit files to `/etc/systemd/system/` (idempotent); (c) `systemctl daemon-reload` + `enable --now pibot-gateways@<name> pibot-discord@<name> pibot-bridge@<name>.timer`. Privileged (uses sudo); the only privileged step, run once per host opt-in. Prints next steps (set the flag).

### 5. MPA cutover (no disturbing the 3 prod bots)

The `@crow-mpa` units run the same code against the same `~/.crow-mpa` DB — a stop-old → start-new swap. Sequence (attended, tight window): write `/etc/crow/pibot-crow-mpa.env` + install templated units + set `feature_flags.bot_runtime=true` on the MPA instance → `enable` the `@crow-mpa` units → **in one window:** stop the 3 legacy units (`pibot-gateways`, `pibot-discord`, `pibot-bridge.timer`), `start` the `@crow-mpa` units → verify a bot responds → `disable`+remove the 3 legacy unit files + the `pibot-bridge.service.d` drop-in (re-create the timeout drop-in under the templated name if still needed). Interruption is seconds (adapters reconnect; Gmail resumes next tick).

### 6. grackle bring-up (live 2nd host)

`install-runtime.sh grackle` (env → grackle's `~/.crow`, install units, enable) + set `feature_flags.bot_runtime=true` on grackle. grackle then runs the runtime for any bot defined there. **crow.db-lock handling:** cross-host is isolated (grackle's runtime uses grackle's own `~/.crow/data/crow.db`, separate from crow's — no shared-DB contention). Within-host (grackle gateway + runtime on grackle's crow.db) is the *same proven pattern* MPA already runs; verify the existing guards are active per-instance before flag-on: `CROW_JOURNAL_MODE=DELETE` on minted crow.db blocks, `busy_timeout`, the `pi_lifecycle` reaper. Acceptance bot on grackle is a **test** bot, not a prod one.

### 7. Components

| Unit | Responsibility | Reuses |
|---|---|---|
| `scripts/pi-bots/systemd/pibot-*@.{service,timer}` | per-instance templated units | existing unit shapes |
| `runtime-gate.mjs` | self-gating start/stop on the flag | `botRuntimeActive` reader |
| runner edits (gateway_runner, discord_gateway, bridge_tick) | wrap adapters in the gate | existing adapter setup |
| `sections/bot-runtime.js` | writable runtime toggle | settings-section + `feature_flags` pattern |
| `install-runtime.sh` | one-time per-instance opt-in | systemd, instance-paths |

## Error handling

- Flag read error / malformed → treated as **inactive** (fail-safe: runner idles, doesn't poll). 
- Long-lived runner adapter `start()` failure → log + retry on next poll (don't crash the unit; `Restart=on-failure` is the backstop).
- `bridge_tick` with flag off → immediate clean `exit(0)` (no-op).
- Missing/absent env file → unit fails to start with a clear error; installer is the fix.
- Toggle off while a turn is mid-flight → `stop()` tears down adapters after the current turn's natural boundary; in-flight pi children are SIGTERM'd by the existing close path.

## Testing & verification

No framework; `node:test` + isolated-DB/import checks + stubs (project conventions). All tests use stubs/temp dirs.

1. **`tests/runtime-gate.test.js`** — `runtimeGate` calls `start()` when flag on at boot; off→on calls `start()`, on→off calls `stop()`; malformed/absent flag → inactive, no `start()`; never throws.
2. **`tests/bridge-tick-gate.test.js`** (or extend existing) — `bridge_tick` flag-off path exits without doing work (stub the flag read; assert no Gmail/DB work).
3. **`tests/bot-runtime-toggle.test.js`** — the Settings section round-trips `feature_flags.bot_runtime` at local scope, merge-preserves other flags, `getPreview` reflects state.
4. **Unit/env templating check** — a render/lint of the `@.service` + env-file shape (correct `EnvironmentFile=/etc/crow/pibot-%i.env`, no hardcoded `~/.crow-mpa`, no `crow-mpa-gateway` After).
5. **Regression** — `node tests/pi-bots-no-mpa-coupling.test.js` green; gateway boots clean.
6. **Acceptance (attended, post-deploy; prod-safety: short windows, verify-after, no unattended long holds):** (a) MPA cut over to `@crow-mpa` units — all 3 prod bots still respond (Gmail/Telegram/Discord as applicable); (b) grackle opted-in + flag on — a **test** bot answers one end-to-end turn; (c) toggle off on grackle → runner idles (verify no polling), toggle on → resumes, no restart.

## Build order (for the plan)

1. `runtime-gate.mjs` + test (pure-ish; stub flag reader).
2. Wrap the runners (`bridge_tick` guard; `gateway_runner` + `discord_gateway` adapter lifecycle in `runtimeGate`) + tests.
3. `sections/bot-runtime.js` toggle + register + i18n + test.
4. Templated units (`scripts/pi-bots/systemd/`) + `install-runtime.sh` + templating lint test.
5. Invariant/regression sweep; STOP for the attended deploy (MPA cutover → grackle bring-up → acceptance), one host at a time.

## Conventions / safety

- Commit with explicit path args; verify `git show --stat HEAD`; never add Claude as co-author; `git pull --rebase` before push; branch off `main`.
- **Prod-safety (global rule):** every unit install/cutover/restart is an attended window with verify-after; no unattended long holds; cross-host work one host at a time; an out-of-process wall-clock cap for anything that holds a lock/port.
- **Don't disturb the 3 live MPA prod bots** beyond the tight cutover window; verify they respond after.
- crow.db-lock: keep units off-by-default (opt-in), rely on the existing journal-mode + reaper guards; cross-host DBs are isolated.
- **Deferred debt:** `isMpaHost()` dedup into a shared `mpa-detect.js` (fold in only if cheap while editing `bot-runtime-flag.js`); MPA-pinned fixtures stay pinned.
- **Build-session resource note:** crow froze during prior builds from subagent fan-out on the always-on inference stack; `docker stop` the model stack before heavy multi-agent execution and `docker start` after.
