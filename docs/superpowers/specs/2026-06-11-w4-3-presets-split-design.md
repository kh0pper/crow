# W4-3 Slice 4 — split servers/orchestrator/presets.js (2,849 LOC)

**Date:** 2026-06-11
**Finding:** W4-3 (UNI), final slice (after panels `be4d307`, sharing `6b57554`, gateway `b6be3cb`). presets.js is a **pure data module**: a 60-line header (`__presetsDir`, `ATS_PLATFORMS_JSON` file read :22, `WRITING_VOICE_RULES` :34) + ONE exported object `presets` (:77-2849) holding **30** preset definitions (incl. the snake_case `memory_ops` :129, `code_team` :510, `vision_team` :547, `deep_synthesis` :578 that a hyphen-only grep misses — review C1) (prompts/pipelines/configs — template strings and plain data, no functions verified by the harness below).
**Branch:** `overhaul/w4-3-presets`. High-volatility dir (parallel sessions) — `git status` on `servers/orchestrator/` re-checked immediately before branching; rebase carefully before merge.

Anchors verified at `b6be3cb`. Verify shape, not offsets.

## Behavior-frozen contract

1. `servers/orchestrator/presets.js` keeps exporting `presets` (same name) — importers: `server.js`, `preset-resolver.js`, `role-shape.js`, `dashboard/settings/sections/llm/roles-tab.js` (5-deep relative path). All import `{ presets }` only. No other export exists today.
2. **The merged object is DEEP-EQUAL byte-for-byte** (key order included — `Object.keys` order is observable; roles-tab and resolvers may iterate). Verifier below.
3. Shared constants move to `presets/shared.js`: `ATS_PLATFORMS_JSON` (single use :1796 — imported by bot-job-search.js ONLY) and `WRITING_VOICE_RULES` (**13 uses — 8 in job-search AND 5 in the trackers group** :2284/:2453/:2711/:2771/:2834 — imported by BOTH bot-job-search.js and bot-trackers.js; review S1). The ats-platforms `readFileSync` re-anchor is EXPLICIT (review S2): original is `join(__presetsDir, "ats_platforms.json")` with ZERO `..` — in shared.js it becomes `join(__sharedDir, "..", "ats_platforms.json")` (adding the FIRST `..`). The read is BARE (no try/catch) and missing-file = boot throw — that is the FROZEN behavior; do NOT add a try/catch.
4. No logic edits, no string edits. Comments move with their presets.

## Module plan (servers/orchestrator/presets/, one commit each)

| # | New module | Presets (anchors at b6be3cb) |
|---|---|---|
| 1 | `presets/shared.js` + scaffold | `__presetsDir`→re-derived, `ATS_PLATFORMS_JSON`, `WRITING_VOICE_RULES`; presets.js gains the merge skeleton with groups inlined progressively (each commit moves one group OUT; merge spread order = original key order) |
| 2 | `presets/core.js` | research :78, **memory_ops :129**, full :161, briefing :220, briefing-bidirectional :253 |
| 3 | `presets/mpa.js` | mpa-gmail :284, mpa-outreach :316, mpa-cfp-monitor :348, mpa-memory-review :376, mpa-reliability :403, mpa-prospectus :429, mpa-triage :480 |
| 3b | `presets/teams.js` | **code_team :510, vision_team :547, deep_synthesis :578** (contiguous :510-:613; the `// -- Phase 5-full new presets --` comment at :508 rides with them) |
| 4 | `presets/bot-job-search.js` | bot-echo :615 (echo rides with this group to keep contiguity), bot-job-search :650 + drafter :747 + notifier :896 + replyreader :989 + refine :1245 + commentapplier :1393 + finalizer :1668 + platform-prep :1768 + ack-complete :1940 |
| 5 | `presets/bot-trackers.js` | bot-pir-tracker-converse :2066, bot-pir-tracker :2308, bot-router-improvise :2473, bot-mpa-tasks-converse :2734, bot-mpa-tasks-work :2796 |
| 6 | final | presets.js = imports + `export const presets = { ...corePresets, ...mpaPresets, ...teamPresets, ...jobSearchPresets, ...trackerPresets };` — five contiguous slices of the original; spread order reproduces the original key order EXACTLY (no duplicate keys across groups — verified) |

Each group file exports ONE object (e.g. `export const corePresets = {...}`) whose keys are in original relative order.

## Verifier (perfect for a data module)

`/tmp/w43-presets-harness/dump.mjs`: imports `presets` from a tree, asserts no functions anywhere (walk: typeof — if a function IS found, FAIL the harness and re-design), emits `JSON.stringify(presets)` (preserves key order) → sha256. Baseline from pinned `b6be3cb` worktree (node_modules symlink), after from branch HEAD worktree. **Hashes must be IDENTICAL at every commit.** Also `Object.keys(presets).join()` diffed explicitly (clearer failure message than the hash).

## Verification per commit

1. Presets hash diff — identical.
2. `node --test tests/` — 497+1 baseline.
3. `bash /tmp/w43-render-diff/boot-check.sh` → BOOT: OK (orchestrator loads via gateway).
4. Positional-path commits; NEVER stage `servers/orchestrator/test-watermark-rescue.mjs` (untracked parallel WIP) or scheduler.js/bundles/data; no Claude attribution.

## Risks & guards

- **Parallel-session volatility:** presets.js was touched 5× recently (mpa-tasks/briefing work). Re-check `git status`/`git log -1 -- servers/orchestrator/presets.js` before branching AND before merging; rebase-before-merge mandatory.
- **Key-order drift:** the hash catches it (JSON.stringify preserves insertion order).
- **Template-string corruption while moving:** the hash catches any character change.
- **Gates:** single combined spec+quality gate (sonnet) at slice end (pure data move + perfect verifier); opus holistic SKIPPED for this slice — rationale: zero logic moved, the byte-hash verifier is stronger than review for data fidelity, and the deploy surface is identical to the prior slices' (pull+restart, no schema). If the gate finds ANYTHING non-mechanical, escalate to opus.

## Review

**Round 1 (Plan subagent, adversarial vs live tree @ b6be3cb) — REVISE → resolved in-place.** C1: 30 presets not 26 — `memory_ops`/`code_team`/`vision_team`/`deep_synthesis` are snake_case and were grep-missed; the plan as written deleted 4 presets (the hash gate would have caught it, but the plan could never pass). C2: groups must be CONTIGUOUS slices for spread-merge order fidelity → memory_ops into core.js, new teams.js (:510-:613). S1: WRITING_VOICE_RULES used 13× (trackers too) → both group files import it. S2: readFileSync re-anchor made explicit (`join(__sharedDir, "..", "ats_platforms.json")` — the original has zero `..`); bare-read no-try/catch frozen. Verified-and-kept: single export, exactly 4 importers ({presets} only), no dynamic imports, pipelines/providers-db/sync_edjobs mention the path only in comments/prompts, pure-data confirmed at code level (all `${`/`function`/`undefined` hits are prose inside string literals — JSON.stringify has no blind spot), no duplicate keys, Object.entries/keys consumers match the verifier exactly, skip-opus rationale holds (nothing watches/text-reads the file), ats_platforms.json tracked. Stale comment :642-649 (references nonexistent bot-mpa-mail-worker) moves verbatim.
