# 2c follow-up pool (F1–F6) — SDD execution plan

**Date:** 2026-07-15 · **Spec:** `docs/superpowers/specs/2026-07-15-2c-followups-design.md`
(rev 3, 2 adversarial rounds folded) · **Branch:** `fix/2c-followup-pool` · **No schema bump.**

Standing rules apply (arc plan §3): positional-path commits + `git show --stat HEAD`
after every commit; no backticks in `-m`; scratch-env suite only; test harnesses on
real init-db need `mgr.dataDir=mkdtemp` AND `mgr.feedsDisabled=false`; memories.id is
INTEGER (string test-ids fail silently); park-a-DB-call barriers delay result DELIVERY,
not the call.

**Baselines:** suite 1974/2/0 (2 = bundles-validate-install); any 3rd failure is new.
sync_conflicts 219/183/162/0 — growth is red.

Each task: RED test first → implement → mutation check (comment guard out, watch the
NAMED test go red, restore) → focused test run → per-task fresh reviewer subagent.
Tasks run SEQUENTIALLY on the one branch (T1 before T6: both touch tailnet-sync.js).

---

## T1 — F1: SendingOnClosedConnection crash class (3 guards + crash net)

Files: `servers/sharing/resilient-subscribe.js` (C1a guard in doSubscribe),
`scripts/pi-bots/gateways/nostr-client.mjs` (C1a′ guard in raw subscribe()),
NEW `servers/sharing/nostr-crash-guard.js` (C1b per spec — exported handleRejection,
install/uninstall, rate-limited log10 counter), install sites: gateway NostrManager
construction (`servers/sharing/managers.js` or where NostrManager is built — locate,
don't guess) + `nostr-client.mjs` connect path, `servers/sharing/tailnet-sync.js:531-533`
comment fix ("no unhandledRejection handler" → now false).
Tests: NEW `tests/nostr-crash-guard.test.js` — G-F1-1 (async-orphan stub — MUST be an
un-awaited async throw inside subscribe(), NOT a sync throw; test installs/removes its
own capture handler), G-F1-2 (mutation: C1a guard), G-F1-3 (unit-call handleRejection
both legs; install idempotence via listenerCount with uninstall in finally), G-F1-4
(pi-bots raw-subscribe guard + mutation).

## T2 — F2/C2a: sender-level notification timeouts + fan-out bound

Files: `servers/gateway/push/ntfy.js` (AbortController 10_000ms),
`servers/gateway/push/email.js` (same), `servers/gateway/push/web-push.js`
(`timeout: 10_000` in sendNotification options — ms, socket-idle; convert the serial
subscription loop to `Promise.allSettled` PRESERVING the per-endpoint try/catch and
410-prune + last_seen bookkeeping — read the loop body first; db.execute is
synchronous under the hood, parallel sends are DB-safe per R2).
Tests: NEW `tests/notification-timeouts.test.js` — G-F2-1: hung local HTTP server
(accepts, never responds) → ntfy and email senders return ≤ cap; web-push: hung local
endpoint if the lib accepts it, else assert options carry timeout:10000 (record as
accepted deviation). Mutation: remove abort/timeout → red by hang.

## T3 — F2/C2b: cap the three boot drains; providers defer-on-cap + escape hatch

Files: `servers/sharing/instance-sync.js` — route `_backfillContactsOnceGated` (:786),
`backfillGroupsOnce` (:1196), `backfillProvidersForNewPeers` (:1003) pre-drains through
`_drainInboundCapped` (returns boolean already; sole existing caller ignores it).
Contracts: contacts+groups keep unconditional done-flag writes (lamport-preserving
re-emits — capped drain is truthful deferred convergence). Providers: on incomplete
drain → NO emit, flag `deferred:<n>` (UPSERT; non-terminal); on 3rd consecutive
deferral → emit anyway + `done:*` (escape hatch — spec R2-1).
Tests: extend/NEW `tests/backfill-drain-caps.test.js` — G-F2-2 (arm BOTH outFeeds
unflagged peer AND hung inFeed — :977 early-return makes an inFeeds-only test
vacuous; feed-delivery-level barrier, NOT notification-level; assert deferred:1 → no
emissions; unparked rerun → done; 3rd deferral → emits anyway), G-F2-3 (contacts/
groups: capped drain still emits lamport-preserving + writes flags). Mutation checks
per spec.

## T4 — F2/C2c: cap discovery.flushed() in joinContact

Files: `servers/sharing/peer-manager.js` (:78-79) — 10s race on `discovery.flushed()`
only, timer cleared on win; topic registration + announce precede it. Do NOT touch
initContact (rocksdb-lock hazard — spec A2-3).
Tests: G-F2-4 in NEW/extended test file — never-resolving flushed() at the swarm.join
boundary (stub swarm, not stubbed joinContact) → returns ≤ cap, topics map has the
topic. Mutation: remove cap → red by timeout.

## T5 — F3+F4: Restore-button disable + unreachable-guard comment

Files: `servers/sharing/sync-conflict-resolve.js` (export NATURAL_KEY_RESTORE_TABLES
Set; derive refusals coverage from it; F4 comment at the :313 guard),
`servers/gateway/dashboard/settings/sections/sync-conflicts.js` (set-membership
disable, isInsert precedence unchanged), `servers/gateway/dashboard/shared/i18n.js`
(new key `syncConflicts.naturalKeyRestoreDisabled`, en + es).
Tests: NEW `tests/sync-conflicts-restore-ui.test.js` — G-F3-1 per spec (RED first
against current output; mutation check on the render condition).

## T6 — F5: pendingEmitStats + refresh gauge

Files: `servers/sharing/instance-sync.js` (public pendingEmitStats() — fully
synchronous snapshot, no awaits), `servers/sharing/tailnet-sync.js` (gauge call AFTER
the per-peer loop in refresh(), own try/catch — post-C1b an escaped throw crashes).
Tests: G-F5-1 via exported `__refreshForTest` (zero-peer reach verified R2 Q7);
mutation check on the gauge call.

## T7 — F6: capstone ereader working-tree edit (NEVER committed)

File: `bundles/capstone-tracker/src/templates/ereader.html` er-data island — quoted
`|e`/raw string interpolations → `|tojson` (drop surrounding quotes), per spec F6
(JSON-correctness + hardening framing; Jinja2/autoescape verified). Then verify
`git status bundles/capstone-tracker` still shows untracked and NO capstone path in
any commit. Done inline by the orchestrator (no subagent — 6-line mechanical edit in
Kevin's WIP; minimize touch).

## Ship

Whole-branch fresh-Opus review (READY TO MERGE required) → gates (scratch suite,
check-ports exactly-one-line rule, build-registry --check) → PR via GitHub MCP →
merge → deploy-docs watch (this plan + spec are docs/**) → fleet deploy (crow →
grackle bridge-then-gateway → black-swan) → live verify: CDP proof of F3 disabled
buttons on a real conflicts page; F1/F5 log-grep soak; providers/contacts backfill
flags intact ×4 → ledger + arc plan §4 pool update + memory.
