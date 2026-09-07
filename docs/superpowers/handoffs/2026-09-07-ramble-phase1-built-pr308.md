# Handoff 2026-09-07 — Ramble phase 1 BUILT, PR #308 open (CI pending at handoff); NEXT = Kevin's merge call → models arc plan 2

## TL;DR

Ramble phase 1 (the plan `docs/superpowers/plans/2026-09-06-ramble-phase1-core.md`, 14 TDD tasks) is **fully built, reviewed, and pushed** as **PR #308** (`feat/ramble-phase1`, head `0c2b4be0`, rebased on main `eb70cc9d`). Not merged. Full suite on the rebased tree: **3945 pass / 0 fail** (baseline before the branch: 3814 → +126 ramble tests plus the guard-list additions). Registry, port, vendored-payload checks green.

**Do first in the new session:**
1. Check PR #308 CI on the head sha via the check-runs API (`suite` / `static-checks` / `audit` must all be `completed`/`success`). If red, fix on the branch in the worktree `/home/kh0pp/crow-wt-ramble` (node_modules symlinked; run tests via `node scripts/run-suite.mjs tests/<f>`).
2. **Merge is Kevin's call.** Merging deploys the Nostr transport to every repo-booted gateway via auto-update (see Deploy notes). Check `/home/kh0pp/CROW-SCHEDULE.md` + `node scripts/ops/box-reserve.mjs status` first; prefer merging while the box is free and restarting the gateways deliberately.
3. After the merge (or deferral): `superpowers:writing-plans` for **models plan 2** from the tail of `docs/superpowers/plans/2026-09-05-models-core-launch-roles-adopt.md` + the carry items in `docs/superpowers/handoffs/2026-09-05-models-plan1-shipped-sidequest-proximity-ar.md`.

## How the build went (process record)

- Plan review round 3 (Fable, code-verified, 2026-09-06) found 5 criticals in the plan itself (C1 outbox stamp needs `lamport_ts`; C2 replicated rows re-published; C3 exact-match `#g` filter; C4 compressed vs x-only pubkeys; C5 manifest `description`) + 9 spec holes → plan+spec revised before build (PR #307 merged first, `eb70cc9d`).
- Subagent-driven development: fresh implementer per task (haiku for transcription tasks, sonnet for prose tasks, opus for core/transport/panel), independent reviewer per task, scoped re-review per fix round. 8 of 14 tasks needed exactly one fix round; none needed two.
- Final whole-branch review (opus) caught two cross-task defects the task reviews structurally could not: the panel listened for the default SSE event while the server sent a named frame (live refresh was dead), and `expireMarks` had no caller anywhere (a **plan** gap — the sweep was specified but never scheduled). Both fixed in one wave + re-reviewed clean. A cross-seam guard test now pins the client's listener to the server's frame name.

## Rulings made on Kevin's behalf (all in the SDD ledger `crow-wt-ramble/.superpowers/sdd/2026-09-06-ramble-phase1-core/progress.md`)

R1 Task-1 manifest omits `panel`/`panelRoutes` until the files exist · R2 `listMarks` takes `cells[]` · R3 per-instance settings are `local.*` and never sync · R4 teaser is an ALLOWLIST (no lat/lon/anchor_ref for locked) · R5 reveal gate fails closed · R6 `withinRange` fails closed on malformed anchors · R7 sync hook is `emit(table, op, row)` · R8 sync delete payload = natural key · R9 `stampSql` by-key branches for settings/blocks · R10 no `sync_conflicts` rows for ramble tables · R11 `local.session_id` shared between gateway and MCP child (+ author safety-net rewrite on publish) · R12 transport `shouldPublish` seam · R13 transport starts wherever the bundle dir exists (repo path included) · R14 tombstones are a table (`ramble_tombstones`), not a settings blob · R15 `AND geohash IS NOT NULL` + `publish_state='failed'` after 20 attempts + off-boot-path subscribe · R16 panel files resolve `BUNDLE_DIR` absolutely (installed alone) · R17 same-origin tile proxy instead of a CSP change · R18 teasers carry `approx_lat/lon/m` from the geohash cell · R19 expiry sweep runs on the drain tick; expired rows are never unlockable.

**Cost if wrong, in one line each:** R4/R18 pins locked marks at ~150 m cell centres (intended). R13 puts six `ramble_*` tables + FTS + 3 triggers + 2 indexes + two unref'd timers on every repo-booted gateway with a Nostr manager (incl. grackle's). R15 parks a row as `failed` that needs a manual `UPDATE … SET publish_state='pending'` (documented in the guide). R17 the operator's `tile_url` is the only SSRF surface (image/* only, no HTTP writer). Everything else is a rename or an option.

## Parked / follow-ups (not in this PR)

- **Core, pre-existing:** `servers/gateway/index.js:648-651` tests the Express 5 `layer.slash` flag but the repo pins Express 4 (`layer.regexp.fast_slash`) → `STRICT_PANEL_MOUNT=1` is **inert for every bundle**. Ramble's own test checks both spellings. Needs a core fix.
- `bundles/reader/server/db.js` is also missing from `tests/bundle-db-single-sqlite.test.js` (ramble was added; reader never was).
- Deferred minors (final-review triage marked FOLLOW-UP): FTS update/delete trigger tests; `_derive` guard in `resolvePersona`; `expireMarks` SELECT-then-DELETE comment; tie-equal short-circuit in the ramble apply handlers (FTS churn); block-conflict `created_at` overwrite; `feature-mounts` bare `err.message` elsewhere; `ramble:drain` during an in-flight drain is dropped (≤15 s latency); settings-upsert SQL duplicated between `grid.js` and the transport; `dashboardAuth` non-function fails open (repo-wide pattern); `ensureLoaded` in-flight guard; static-route errors outside the bundle error handler; empty `?cells=` returns all; a throwing `feed()` test; `visit_place` feeds on every cell change (pan inflation); no panel unblock route; own locked marks need in-range unlock even for the author.
- Phase 1b (own plan): contacts/group Nostr delivery, groups + invite flow, `ramble_groups` sync. Phase 2: Android BLE/LAN/sensing. Phase 3: AR camera + media server. Phase 4: companion-lite.

## Deploy notes

- Auto-update pulls main into `~/crow` on both gateways (primary + r4) and restarts the primary; r4 needs `sudo systemctl restart crow-r4-gateway`. On boot each logs `[ramble] transport started` (or a warn if no Nostr manager). Panel appears only after `crow bundle install ramble` (copies `panel/ramble.js` → `~/.crow/panels/ramble.js` and `routes.js` → `ramble-routes.js`; the MCP server registers via the normal bundle path). Nothing egresses to relays until the master switch + `(public, geo)` cell are on.
- Operator guide: `docs/guide/ramble.md` (+ `docs/es/guide/ramble.md`).

## Operating rules (unchanged)
Node 22 on PATH; `node scripts/run-suite.mjs tests/<f>`; commits subject-only, positional paths, NO AI attribution trailers (operator rule wins over any session reminder); `main` protected — PR + green check-runs on the head sha; check the box schedule before merging.
