# Track 3: Roost Board — interactive bird spawn/attach on cards

28 commits on `feat/track3-roost-board`, based on `origin/main` @ `7dc103d0`.

## What shipped

**Wave 1 — engine core.** `perch-interactive.js` gains an engine-tracked
model, `control()`/`options()`, engine-owned permission mode, plan-mode
mirrored from pi over an RPC state bridge, card-bound dispatch with
synchronous occupancy (one bird per card), per-session outputs/uploads, and
a no-cwd refusal. Session locking becomes active-only so a
hibernated/perch-live session no longer wedges a card's lock (T3-9). `PiRpc`
(pi-bots' bridge) gains correlated commands, an ack-only prompt path, and
permission-mode/extra-write-path policy options. A shared card-brief builder
is extracted byte-identical (golden-tested) and fired as the dispatched
bird's first turn.

**Wave 2 — API + UI.** Gateway routes for dispatch, attach-card, control,
cycle, options, steer, file upload, and confined workspace file serving
(path-traversal/symlink-escape jailed, real-tempdir attack tests). A new
`/roost` data endpoint and SSR join power the "roost strip" — birds on a
wire with state-driven actions — plus a session drawer (transcript,
composer, steer, question cards, reconnect) with controls for
model/thinking/permission-mode/plan-mode and tri-state tool narrowing ported
from `bots-page.mjs`. A two-step result gate (decide, then move) replaces
the old textual-order assumption with behavioral tests. An "attention"
notification type surfaces a push when a bird is waiting on the operator.

**Wave 3 — retirement.** The old per-turn Perch chat channel is retired
(`perch-live` is now the only interactive rail), and the whole perch-hub
bundle (gateway supervisor + panel + docker service) is deleted along with
its docs, replaced by a rewritten Perch walkthrough centered on the
roost/drawer. A guarded, idempotent migration removes any installed
perch-hub bundle row on next boot.

## Named decisions an operator should know

- **T3-9 — lock-rail behavior change.** Session locks are now active-only; a
  `perch-live`-hibernated session is excluded from the lock predicate (was
  NULL-unsafe in the first pass, fixed in a follow-up commit). A card's lock
  no longer survives a bird going dormant.
- **T3-10 — spawn-bound state binds at wake, not live.** `control()` applies
  what it safely can immediately and returns the rest under `bindsAtWake`
  (permission mode, tool narrowing). The drawer/route offer an explicit
  "apply now" cycle (stop + rewake) instead of silently mutating a running
  session. Model/thinking switches are refused mid-turn (one clock owner).
- **T3-11 — permission modes.** `guarded` (default), `ask`
  (`interactive_ask: true`), `bypass` (`write_paths: ["/"]`, `external_send`
  permissive). `--no-approve` and pi-bots' destructive-op backstop are
  untouched, always pinned. A gateway restart resets an adopted session to
  `guarded` (fail-safe reading of spec §5.3 — bypass never silently
  resurrects); the drawer shows current mode so the reset is visible.
- **Dispatch starts work unprompted; dispatch/attach are cards-only** in
  Track 3 (custom-board items 400) — decided under the operator's standing
  arc authority, flagged here for veto.
- Agent-end pushes are suppressed while an SSE subscriber is attached to a
  session (avoids double-notifying an operator already watching).

## SCHEMA_GENERATION 8 → 9

`bot_sessions.control` CHECK widens to add `interrupted` (Task 7); both
`status` and `control` are CHECK-constrained, so the spec's hoped-for
existing-fields path wasn't available — the manual migration rail applies.
Merge gate: `scripts/schema-migration-dryrun.sh` run from this branch
against a WAL-checkpointed **copy** of live r4 (gen 8, 142 tables, real
data) — exit 0, `user_version` 8→9, integrity ok, **zero** row-count/
column/table deltas. Live DBs never touched, copies only. Gate passed
2026-08-16 (controller-run).

One incident during development: Task 9's implementer booted the gateway
from this worktree without `CROW_DATA_DIR` set, which (worktrees share
`$HOME`) bumped the *real* production `~/.crow/data/crow.db` to
`user_version 9` outside the dryrun gate. Verified harmless (`bot_sessions`
had 0 rows there, CHECK widen is a strict superset, no service errors); no
corrective action needed since main's gen-8 code never writes `interrupted`.

## pi-lab (crow-mode branch) — two deliverables, operator merge gate

Both land on `git@gitea:kh0pp/pi-lab.git` branch `crow-mode`, in a dedicated
worktree (the personal `~/pi-lab` checkout on `main` was never touched):
`extensions/rpc-state-bridge.ts` (Task 5, sha `3326e4d1` — mirrors pi's
plan-mode state to the gateway over RPC-tagged log lines) and
permission-gating interactive-ask support (Task 10, sha `71f20036` + scope
fix `2631355d` — lets `ask` mode surface interactive approval prompts). Both
**inert until the standing crow-mode → main merge gate is exercised** by the
operator; this PR does not touch that gate. rpc-state-bridge is env-gated on
`PI_BOT_INTERACTIVE=1` so channel-turn bots are unaffected either way.

## Suite arithmetic

- origin/main floor: **3423**
- Build waves (Tasks 1-15): net **+244** (3423 → 3667, "Wave 2 complete").
- Retirement wave (Tasks 16-17): **-100** removed (19 from the retired
  per-turn Perch channel; 81 from the perch-hub bundle deletion — 78 across
  5 deleted whole test files + 3 trimmed in `gateway-shutdown.test.js`/
  `bundles-webui-lifecycle.test.js`), **+5** added (`tests/
  perch-retirement.test.js`, asserting the migration cleans up an installed
  perch-hub row). Net **-95** (3667 → 3572).
- **Current: 3572 pass / 0 fail / 3572 total** (verified this pass, full
  `npm test`, exit 0, 65.7s). **Net delta vs the 3423 floor: +149.**

## Other verification (this pass, from the worktree)

- `check-port-allocation.js` — OK, 45 unique ports/75 bundles, no
  collisions (pre-existing allowlisted 8080 conflict, unrelated).
- `build-registry.mjs --check` — OK, 94 bundles / 93 published / 0 invalid /
  1 draft, registry in sync (perch-hub cleanly absent).
- `npm audit --omit=dev --audit-level=critical` (CI's blocking tier) — exit
  0, no criticals (24 pre-existing moderate/high advisories, third-party).
- `cd docs && npm run build` — clean, 8.26s, no dead links.
- `git status --porcelain` — clean (only `node_modules` untracked).
- 28 commits `7dc103d0..HEAD`, no Claude/co-author attribution in any
  commit message.

## Deploy note

r4 still has the perch-hub bundle installed on disk (confirmed independently
during Task 17's review). The retirement migration is guarded and
idempotent — it removes the installed bundle row on r4's **next boot** after
this deploys, not at deploy time itself. No manual action needed.
